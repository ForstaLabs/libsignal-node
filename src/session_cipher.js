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
        this.ourIdentityKey = this.storage.getLocalIdentityKeyPair();
    }

    getRecord(encodedNumber) {
        return this.storage.loadSession(encodedNumber);
    }

    encrypt(buffer, encoding) {
        throw new Error("unported");
        assert_buffer(buffer);
        if (encoding !== undefined) {
          throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
        }
        var address = this.remoteAddress.toString();
        var myRegistrationId, record, session, chain;

        var msg = new protobufs.WhisperMessage();

        return Promise.all([
            this.storage.getLocalRegistrationId(),
            this.getRecord(address) // XXX is not async anymore
        ]).then(function(results) {
            myRegistrationId = results[0];
            record           = results[1];
            if (!record) {
                throw new Error("No record for " + address);
            }
            session = record.getOpenSession();
            if (!session) {
                throw new Error("No session to encrypt message for " + address);
            }

            msg.ephemeralKey = session.currentRatchet.ephemeralKeyPair.pubKey;
            chain = session.getChain(msg.ephemeralKey);
            if (chain.chainType === ChainType.RECEIVING) {
                throw new Error("Tried to encrypt on a receiving chain");
            }

            this.fillMessageKeys(chain, chain.chainKey.counter + 1);
        }.bind(this)).then(function() {
            return crypto.HKDF(chain.messageKeys[chain.chainKey.counter],
                               Buffer.alloc(32), "WhisperMessageKeys");
        }).then(function(keys) {
            delete chain.messageKeys[chain.chainKey.counter];
            msg.counter = chain.chainKey.counter;
            msg.previousCounter = session.currentRatchet.previousCounter;

            return crypto.encrypt(keys[0], buffer, keys[2].slice(0, 16)).then(function(ciphertext) {
                msg.ciphertext = ciphertext;
                var encodedMsg = msg;

                var macInput = new Uint8Array(encodedMsg.byteLength + 33*2 + 1);
                macInput.set(this.ourIdentityKey.pubKey);
                macInput.set(session.indexInfo.remoteIdentityKey, 33);
                macInput[33*2] = (3 << 4) | 3;
                macInput.set(encodedMsg, 33*2 + 1);

                const mac = crypto.sign(keys[1], macInput);
                var result = new Uint8Array(encodedMsg.byteLength + 9);
                result[0] = (3 << 4) | 3;
                result.set(encodedMsg, 1);
                result.set(mac.slice(0, 8), encodedMsg.byteLength + 1);
                record.updateSessionState(session);
                this.storage.storeSession(address, record);
                return result;
            }.bind(this));
        }.bind(this)).then(function(message) {
            if (session.pendingPreKey !== undefined) {
                var preKeyMsg = new protobufs.PreKeyWhisperMessage();
                preKeyMsg.identityKey = this.ourIdentityKey.pubKey;
                preKeyMsg.registrationId = myRegistrationId;

                preKeyMsg.baseKey = session.pendingPreKey.baseKey;
                preKeyMsg.preKeyId = session.pendingPreKey.preKeyId;
                preKeyMsg.signedPreKeyId = session.pendingPreKey.signedKeyId;

                preKeyMsg.message = message;
                var result = String.fromCharCode((3 << 4) | 3) + preKeyMsg.toString('binary');
                return {
                    type           : 3,
                    body           : result,
                    registrationId : record.registrationId
                };

            } else {
                return {
                    type: 1,
                    body: message,
                    registrationId: record.registrationId
                };
            }
        });
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

    async decryptWhisperMessage(buffer, encoding) {
        if (encoding !== undefined) {
            throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
        }
        assert_buffer(buffer);
        const address = this.remoteAddress.toString();
        const record = this.getRecord(address);
        if (!record) {
            throw new Error("No record for device " + address);
        }
        const errors = [];
        const result = await this.decryptWithSessionList(buffer, record.getSessions(), errors);
        const record2 = this.getRecord(address); // XXX Why!?
        record2.updateSessionState(result.session);
        this.storage.storeSession(address, record2);
        return result.plaintext;
    }

    async decryptPreKeyWhisperMessage(buffer, encoding) {
        if (encoding !== undefined) {
            throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
        }
        assert_buffer(buffer);
        const version = buffer[0];
        buffer = buffer.slice(1);
        if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
            throw new Error("Incompatible version number on PreKeyWhisperMessage");
        }
        const address = this.remoteAddress.toString();
        let record = this.getRecord(address);
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
        this.storage.storeSession(address, record);
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
             var e = new Error("Message key not found. The counter was repeated or the key was not filled.");
             e.name = 'MessageCounterError';
             throw e;
         }
         delete chain.messageKeys[message.counter];
         const keys = crypto.HKDF(messageKey, Buffer.alloc(32),
                                  Buffer.from("WhisperMessageKeys"));
         var macInput = new Uint8Array(messageProto.byteLength + (33 * 2) + 1);
         macInput.set(session.indexInfo.remoteIdentityKey);
         macInput.set(this.ourIdentityKey.pubKey, 33);
         macInput[33*2] = (3 << 4) | 3;
         macInput.set(messageProto, 33*2 + 1);
         crypto.verifyMAC(Buffer.from(macInput), keys[1], mac, 8);
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

    getRemoteRegistrationId() {
        const record = this.getRecord(this.remoteAddress.toString());
        if (record === undefined) {
            return undefined;
        }
        return record.registrationId;
    }

    hasOpenSession() {
        const record = this.getRecord(this.remoteAddress.toString());
        if (record === undefined) {
            return false;
        }
        return record.haveOpenSession();
    }

    closeOpenSessionForDevice() {
        var address = this.remoteAddress.toString();
        const record = this.getRecord(address);
        if (record === undefined || record.getOpenSession() === undefined) {
            return;
        }
        record.archiveCurrentState();
        this.storage.storeSession(address, record);
    }
}

module.exports = SessionCipher;
