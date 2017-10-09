/*
 * vim: ts=4:sw=4
 */

const ChainType = require('./chain_type.js');
const SessionBuilder = require('./session_builder.js');
const SessionRecord = require('./session_record.js');
const crypto = require('./crypto.js');
const protobufs = require('./protobufs.js');


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

    async encrypt(buffer, encoding) {
        assert_buffer(buffer);
        if (encoding !== undefined) {
          throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
        }
        const address = this.remoteAddress.toString();
        const msg = protobufs.WhisperMessage.create();
        const myRegistrationId = await this.storage.getLocalRegistrationId();
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
        const ourIdentityKey = await this.storage.getLocalIdentityKeyPair();
        macInput.set(ourIdentityKey.pubKey);
        macInput.set(session.indexInfo.remoteIdentityKey, 33);
        macInput[33*2] = (3 << 4) | 3;
        macInput.set(msgBuf, 33 * 2 + 1);
        const mac = crypto.sign(keys[1], macInput);
        const message = new Buffer(msgBuf.byteLength + 9);
        message[0] = (3 << 4) | 3;
        message.set(msgBuf, 1);
        message.set(mac.slice(0, 8), msgBuf.byteLength + 1);
        record.updateSessionState(session);
        await this.storage.storeSession(address, record);
        if (session.pendingPreKey !== undefined) {
            const preKeyMsg = protobufs.PreKeyWhisperMessage.create({
                identityKey: ourIdentityKey.pubKey,
                registrationId: myRegistrationId,
                baseKey: session.pendingPreKey.baseKey,
                preKeyId: session.pendingPreKey.preKeyId,
                signedPreKeyId: session.pendingPreKey.signedKeyId,
                message
            });
            const pkBundleMsg = String.fromCharCode((3 << 4) | 3) +
                protobufs.PreKeyWhisperMessage.encode(preKeyMsg).finish().toString('binary');
            return {
                type: 3, // prekey bundle
                body: pkBundleMsg,
                registrationId: record.registrationId
            };
        } else {
            return {
                type: 1, // ciphertext
                body: message,
                registrationId: record.registrationId
            };
        }
    }

    decryptWithSessionList(buffer, sessionList, errors) {
        // Iterate recursively through the list, attempting to decrypt
        // using each one at a time. Stop and return the result if we get
        // a valid result
        if (sessionList.length === 0) {
            return Promise.reject(errors[0]);
        }
        var session = sessionList.pop();
        return this.doDecryptWhisperMessage(buffer, session).then(function(plaintext) {
            return {
                plaintext: plaintext,
                session: session
            };
        }).catch(function(e) {
            errors.push(e);
            return this.decryptWithSessionList(buffer, sessionList, errors);
        }.bind(this));
    }

    async decryptWhisperMessage(buffer) {
        assert_buffer(buffer);
        const address = this.remoteAddress.toString();
        const record = await this.getRecord(address);
        if (!record) {
            throw new Error("No record for device " + address);
        }
        const errors = [];
        const result = await this.decryptWithSessionList(buffer, record.getSessions(), errors);
        const record2 = await this.getRecord(address); // XXX Why!?
        record2.updateSessionState(result.session);
        await this.storage.storeSession(address, record2);
        return result.plaintext;
    }

    async decryptPreKeyWhisperMessage(buffer) {
        assert_buffer(buffer);
        const version = buffer[0];
        buffer = buffer.slice(1);
        if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on PreKeyWhisperMessage");
        }
        const address = this.remoteAddress.toString();
        let record = await this.getRecord(address);
        const preKeyProto = protobufs.PreKeyWhisperMessage.decode(buffer);
        if (!record) {
            if (preKeyProto.registrationId === undefined) {
                throw new Error("No registrationId");
            }
            console.log(`Creating new session record for: ${address}`);
            record = new SessionRecord(preKeyProto.identityKey,
                                       preKeyProto.registrationId);
        }
        const builder = new SessionBuilder(this.storage, this.remoteAddress);
        const preKeyId = await builder.processV3(record, preKeyProto);
        const session = record.getSessionByBaseKey(preKeyProto.baseKey);
        const plaintext = await this.doDecryptWhisperMessage(preKeyProto.message,
                                                             session);
        record.updateSessionState(session);
        await this.storage.storeSession(address, record);
        if (preKeyId !== undefined) {
            await this.storage.removePreKey(preKeyId);
        }
        return plaintext;
    }

    async doDecryptWhisperMessage(messageBytes, session) {
        assert_buffer(messageBytes);
        if (session === undefined) {
            throw new Error(`No session found for: ${this.remoteAddress.toString()}`);
        }
        var version = messageBytes[0];
        if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on WhisperMessage");
        }
        var messageProto = messageBytes.slice(1, messageBytes.byteLength - 8);
        var mac = messageBytes.slice(messageBytes.byteLength - 8, messageBytes.byteLength);
        var message = protobufs.WhisperMessage.decode(messageProto);
        if (session.indexInfo.closed != -1) {
           console.log('decrypting message for closed session');
        }
        this.maybeStepRatchet(session, message.ephemeralKey, message.previousCounter);
        var chain = session.getChain(message.ephemeralKey);
        if (chain.chainType === ChainType.SENDING) {
            throw new Error("Tried to decrypt on a sending chain");
        }
        this.fillMessageKeys(chain, message.counter);
        const messageKey = chain.messageKeys[message.counter];
        if (messageKey === undefined) {
            console.log("No message key found for counter:", message);
            var e = new Error(`Message key not found: ${message.counter}`);
            e.name = 'MessageCounterError';
            throw e;
        }
        delete chain.messageKeys[message.counter];
        const keys = crypto.HKDF(messageKey, Buffer.alloc(32),
                                 Buffer.from("WhisperMessageKeys"));
        var macInput = new Buffer(messageProto.byteLength + (33 * 2) + 1);
        macInput.set(session.indexInfo.remoteIdentityKey);
        const ourIdentityKey = await this.storage.getLocalIdentityKeyPair();
        macInput.set(ourIdentityKey.pubKey, 33);
        macInput[33*2] = (3 << 4) | 3;
        macInput.set(messageProto, 33*2 + 1);
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
        var key = chain.chainKey.key;
        const mac = crypto.sign(key, Buffer.from([1]));
        const key2 = crypto.sign(key, Buffer.from([2]));
        chain.messageKeys[chain.chainKey.counter + 1] = mac;
        chain.chainKey.key = key2;
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

    async hasOpenSession() {
        const record = await this.getRecord(this.remoteAddress.toString());
        if (record === undefined) {
            return false;
        }
        return record.haveOpenSession();
    }

    async closeOpenSessionForDevice() {
        var address = this.remoteAddress.toString();
        const record = await this.getRecord(address);
        if (record === undefined || record.getOpenSession() === undefined) {
            return;
        }
        record.archiveCurrentState();
        await this.storage.storeSession(address, record);
    }
}

module.exports = SessionCipher;
