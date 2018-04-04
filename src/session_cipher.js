/*
 * vim: ts=4:sw=4
 */

const ChainType = require('./chain_type.js');
const SessionBuilder = require('./session_builder.js');
const SessionLock = require('./session_lock.js');
const SessionRecord = require('./session_record.js');
const crypto = require('./crypto.js');
const protobufs = require('./protobufs.js');

const VERSION = 3;

function assert_buffer(value) {
    if (!(value instanceof Buffer)) {
        throw TypeError(`Expected Buffer instead of: ${value.constructor.name}`);
    }
    return value;
}


class SessionCipher {

    constructor(storage, remoteAddress) {
        this.remoteAddress = remoteAddress;
        this.storage = storage;
    }

    async getRecord(encodedNumber) {
        return await this.storage.loadSession(encodedNumber);
    }

    _encodeTupleByte(number1, number2) {
        if (number1 > 15 || number2 > 15) {
            throw TypeError("Numbers must be 4 bits or less");
        }
        return (number1 << 4) | number2;
    }

    _decodeTupleByte(byte) {
        return [byte >> 4, byte & 0xf];
    }

    async encrypt(buffer) {
        assert_buffer(buffer);
        return await SessionLock.queueJob(this.remoteAddress.toString(), async () => {
            const address = this.remoteAddress.toString();
            const msg = protobufs.WhisperMessage.create();
            const myRegistrationId = await this.storage.getOurRegistrationId();
            const record = await this.getRecord(address);
            if (!record) {
                throw new Error("No record for " + address);
            }
            const session = record.getOpenSession();
            if (!session) {
                throw new Error("No session to encrypt message for " + address);
            }
            msg.ephemeralKey = session.currentRatchet.ephemeralKeyPair.pubKey;
            const chain = session.getChain(msg.ephemeralKey);
            if (chain.chainType === ChainType.RECEIVING) {
                throw new Error("Tried to encrypt on a receiving chain");
            }
            this.fillMessageKeys(chain, chain.chainKey.counter + 1);
            const keys = crypto.HKDF(chain.messageKeys[chain.chainKey.counter],
                                     Buffer.alloc(32), Buffer.from("WhisperMessageKeys"));
            delete chain.messageKeys[chain.chainKey.counter];
            msg.counter = chain.chainKey.counter;
            msg.previousCounter = session.currentRatchet.previousCounter;
            const ciphertext = crypto.encrypt(keys[0], buffer, keys[2].slice(0, 16));
            msg.ciphertext = ciphertext;
            const msgBuf = protobufs.WhisperMessage.encode(msg).finish();
            const macInput = new Buffer(msgBuf.byteLength + 33 * 2 + 1);
            const ourIdentityKey = await this.storage.getOurIdentity();
            macInput.set(ourIdentityKey.pubKey);
            macInput.set(session.indexInfo.remoteIdentityKey, 33);
            macInput[33*2] = this._encodeTupleByte(VERSION, VERSION);
            macInput.set(msgBuf, 33 * 2 + 1);
            const mac = crypto.sign(keys[1], macInput);
            const message = new Buffer(msgBuf.byteLength + 9);
            message[0] = this._encodeTupleByte(VERSION, VERSION);
            message.set(msgBuf, 1);
            message.set(mac.slice(0, 8), msgBuf.byteLength + 1);
            if (!await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                                                      session.indexInfo.remoteIdentityKey)) {
                throw new Error('Identity key changed');
            }
            await this.storage.saveIdentity(this.remoteAddress.toString(),
                                            session.indexInfo.remoteIdentityKey);
            record.updateSessionState(session);
            await this.storage.storeSession(address, record);
            if (session.pendingPreKey !== undefined) {
                const preKeyMsg = protobufs.PreKeyWhisperMessage.create({
                    identityKey: ourIdentityKey.pubKey,
                    registrationId: myRegistrationId,
                    baseKey: session.pendingPreKey.baseKey,
                    signedPreKeyId: session.pendingPreKey.signedKeyId,
                    message
                });
                if (session.pendingPreKey.preKeyId) {
                    preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
                }
                const pkBundleMsg = Buffer.concat([
                    Buffer.from([this._encodeTupleByte(VERSION, VERSION)]),
                    protobufs.PreKeyWhisperMessage.encode(preKeyMsg).finish()
                ]);
                return {
                    type: 3, // prekey bundle
                    body: pkBundleMsg,
                    registrationId: session.registrationId
                };
            } else {
                return {
                    type: 1, // ciphertext
                    body: message,
                    registrationId: session.registrationId
                };
            }
        });
    }

    async decryptWithSessionList(buffer, sessionList, errors) {
        // Iterate recursively through the list, attempting to decrypt
        // using each one at a time. Stop and return the result if we get
        // a valid result
        if (sessionList.length === 0) {
            if (errors.length) {
                if (errors.length > 1) {
                    console.warn("Ignoring subsequent session decrypt errors:",
                                 errors.slice(1));
                }
                throw errors[0];
            } else {
                throw new Error("Session list empty");
            }
        }
        const session = sessionList.pop();
        try {
            return {
                session,
                plaintext: await this.doDecryptWhisperMessage(buffer, session)
            };
        } catch(e) {
            if (e.name === 'MessageCounterError') {
                throw e;
            }
            errors.push(e);
            return await this.decryptWithSessionList(buffer, sessionList, errors);
        }
    }

    async decryptWhisperMessage(buffer) {
        assert_buffer(buffer);
        return await SessionLock.queueJob(this.remoteAddress.toString(), async () => {
            const address = this.remoteAddress.toString();
            let record = await this.getRecord(address);
            if (!record) {
                throw new Error("No record for device " + address);
            }
            const errors = [];
            const result = await this.decryptWithSessionList(buffer, record.getSessions(), errors);
            record = await this.getRecord(address);
            if (result.session.indexInfo.baseKey !== record.getOpenSession().indexInfo.baseKey) {
                record.archiveCurrentState();
                record.promoteState(result.session);
            }
            if (!await this.storage.isTrustedIdentity(this.remoteAddress.getName(),
                                                      result.session.indexInfo.remoteIdentityKey)) {
                throw new Error('Identity key changed');
            }
            await this.storage.saveIdentity(this.remoteAddress.toString(),
                                            result.session.indexInfo.remoteIdentityKey);
            record.updateSessionState(result.session);
            await this.storage.storeSession(address, record);
            return result.plaintext;
        });
    }

    async decryptPreKeyWhisperMessage(buffer) {
        assert_buffer(buffer);
        const versions = this._decodeTupleByte(buffer[0]);
        buffer = buffer.slice(1);
        if (versions[1] > 3 || versions[0] < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on PreKeyWhisperMessage");
        }
        const address = this.remoteAddress.toString();
        return await SessionLock.queueJob(address, async () => {
            let record = await this.getRecord(address) || new SessionRecord();
            const preKeyProto = protobufs.PreKeyWhisperMessage.decode(buffer);
            const preKey = protobufs.PreKeyWhisperMessage.toObject(preKeyProto);
            const builder = new SessionBuilder(this.storage, this.remoteAddress);
            const preKeyId = await builder.processV3(record, preKey);
            const session = record.getSessionByBaseKey(preKey.baseKey);
            const plaintext = await this.doDecryptWhisperMessage(preKey.message, session);
            record.updateSessionState(session);
            await this.storage.storeSession(address, record);
            if (preKeyId !== undefined && preKeyId !== null) {
                await this.storage.removePreKey(preKeyId);
            }
            return plaintext;
        });
    }

    async doDecryptWhisperMessage(messageBytes, session) {
        assert_buffer(messageBytes);
        if (session === undefined) {
            throw new Error(`No session found for: ${this.remoteAddress.toString()}`);
        }
        const versions = this._decodeTupleByte(messageBytes[0]);
        if (versions[1] > 3 || versions[0] < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on WhisperMessage");
        }
        const messageBuffer = messageBytes.slice(1, messageBytes.byteLength - 8);
        const mac = messageBytes.slice(messageBytes.byteLength - 8, messageBytes.byteLength);
        const messageProto = protobufs.WhisperMessage.decode(messageBuffer);
        const message = protobufs.WhisperMessage.toObject(messageProto);
        if (session.indexInfo.closed != -1) {
           console.log('decrypting message for closed session');
        }
        this.maybeStepRatchet(session, message.ephemeralKey, message.previousCounter);
        const chain = session.getChain(message.ephemeralKey);
        if (chain.chainType === ChainType.SENDING) {
            throw new Error("Tried to decrypt on a sending chain");
        }
        this.fillMessageKeys(chain, message.counter);
        const messageKey = chain.messageKeys[message.counter];
        if (messageKey === undefined) {
            console.log("No message key found for counter:", message);
            const e = new Error(`Message key not found: ${message.counter}`);
            e.name = 'MessageCounterError';
            throw e;
        }
        delete chain.messageKeys[message.counter];
        const keys = crypto.HKDF(messageKey, Buffer.alloc(32),
                                 Buffer.from("WhisperMessageKeys"));
        const macInput = new Buffer(messageBuffer.byteLength + (33 * 2) + 1);
        macInput.set(session.indexInfo.remoteIdentityKey);
        const ourIdentityKey = await this.storage.getOurIdentity();
        macInput.set(ourIdentityKey.pubKey, 33);
        macInput[33*2] = this._encodeTupleByte(VERSION, VERSION);
        macInput.set(messageBuffer, 33*2 + 1);
        crypto.verifyMAC(macInput, keys[1], mac, 8);
        const plaintext = crypto.decrypt(keys[0], message.ciphertext, keys[2].slice(0, 16));
        delete session.pendingPreKey;
        return plaintext;
    }

    fillMessageKeys(chain, counter) {
        if (Object.keys(chain.messageKeys).length >= 1000) {
            console.log("Too many message keys for chain");
            return; // Stalker, much?
        }
        if (chain.chainKey.counter >= counter) {
            return;
        }
        if (chain.chainKey.key === undefined) {
            throw new Error("Got invalid request to extend chain after it was already closed");
        }
        const key = chain.chainKey.key;
        chain.messageKeys[chain.chainKey.counter + 1] = crypto.sign(key, Buffer.from([1]));
        chain.chainKey.key = crypto.sign(key, Buffer.from([2]));
        chain.chainKey.counter += 1;
        return this.fillMessageKeys(chain, counter);
    }

    maybeStepRatchet(session, remoteKey, previousCounter) {
        if (session.getChain(remoteKey) !== undefined) {
            return;
        }
        console.log('New remote ephemeral key');
        const ratchet = session.currentRatchet;
        let previousRatchet = session.getChain(ratchet.lastRemoteEphemeralKey);
        if (previousRatchet !== undefined) {
            this.fillMessageKeys(previousRatchet, previousCounter);
            delete previousRatchet.chainKey.key;
            session.oldRatchetList[session.oldRatchetList.length] = {
                added: Date.now(),
                ephemeralKey: ratchet.lastRemoteEphemeralKey
            };
        }
        this.calculateRatchet(session, remoteKey, false);
        // Now swap the ephemeral key and calculate the new sending chain
        const prevCounter = session.getChain(ratchet.ephemeralKeyPair.pubKey);
        if (prevCounter !== undefined) {
            ratchet.previousCounter = prevCounter.chainKey.counter;
            session.deleteChain(ratchet.ephemeralKeyPair.pubKey);
        }
        ratchet.ephemeralKeyPair = crypto.createKeyPair();
        this.calculateRatchet(session, remoteKey, true);
        ratchet.lastRemoteEphemeralKey = remoteKey;
    }

    calculateRatchet(session, remoteKey, sending) {
        let ratchet = session.currentRatchet;
        const sharedSecret = crypto.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey);
        const masterKey = crypto.HKDF(sharedSecret, ratchet.rootKey, Buffer.from("WhisperRatchet"));
        let ephemeralPublicKey;
        if (sending) {
            ephemeralPublicKey = ratchet.ephemeralKeyPair.pubKey;
        } else {
            ephemeralPublicKey = remoteKey;
        }
        session.addChain(ephemeralPublicKey, {
            messageKeys: {},
            chainKey: {
                counter: -1,
                key: masterKey[1]
            },
            chainType: sending ? ChainType.SENDING : ChainType.RECEIVING
        });
        ratchet.rootKey = masterKey[0];
    }

    async getRemoteRegistrationId() {
        return await SessionLock.queueJob(this.remoteAddress.toString(), async () => {
            const record = await this.getRecord(this.remoteAddress.toString());
            if (record === undefined) {
                return undefined;
            }
            var openSession = record.getOpenSession();
            if (openSession === undefined) {
                return null;
            }
            return openSession.registrationId;
        });
    }

    async hasOpenSession() {
        return await SessionLock.queueJob(this.remoteAddress.toString(), async () => {
            const record = await this.getRecord(this.remoteAddress.toString());
            if (record === undefined) {
                return false;
            }
            return record.haveOpenSession();
        });
    }

    async closeOpenSessionForDevice() {
        const address = this.remoteAddress.toString();
        return await SessionLock.queueJob(address, async () => {
            const record = await this.getRecord(address);
            if (record === undefined || record.getOpenSession() === undefined) {
                return;
            }
            record.archiveCurrentState();
            await this.storage.storeSession(address, record);
        });
    }

    async deleteAllSessionsForDevice() {
        // Used in session reset scenarios, where we really need to delete
        const address = this.remoteAddress.toString();
        return await  SessionLock.queueJob(address, async () => {
            const record = await this.getRecord(address);
            if (record === undefined) {
                return;
            }
            record.deleteAllSessions();
            await this.storage.storeSession(address, record);
        });
    }
}

module.exports = SessionCipher;
