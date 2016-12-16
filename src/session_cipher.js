
const ChainType = require('./chain_type.js');
const SessionBuilder = require('./session_builder.js');
const SessionLock = require('./session_lock.js');
const SessionRecord = require('./session_record.js');
const crypto = require('./crypto.js');
const helpers = require('./helpers.js');
const protobufs = require('./protobufs.js');


function assert_buffer(value) {
    if (!(value instanceof Buffer)) {
        throw TypeError(`Expected Buffer instead of: ${value.constructor.name}`);
    }
    return value;
}


function SessionCipher(storage, remoteAddress) {
  this.remoteAddress = remoteAddress;
  this.storage = storage;
}

SessionCipher.prototype = {

  getRecord: function(encodedNumber) {
      return this.storage.loadSession(encodedNumber).then(function(serialized) {
          if (serialized === undefined) {
              return undefined;
          }
          return SessionRecord.deserialize(serialized);
      });
  },

  encrypt: function(buffer, encoding) {
    assert_buffer(buffer);
    if (encoding !== undefined) {
      throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
    }
    return SessionLock.queueJobForNumber(this.remoteAddress.toString(), function() {
      var address = this.remoteAddress.toString();
      var ourIdentityKey, myRegistrationId, record, session, chain;

      var msg = new protobufs.WhisperMessage();

      return Promise.all([
          this.storage.getIdentityKeyPair(),
          this.storage.getLocalRegistrationId(),
          this.getRecord(address)
      ]).then(function(results) {
          ourIdentityKey   = results[0];
          myRegistrationId = results[1];
          record           = results[2];
          if (!record) {
              throw new Error("No record for " + address);
          }
          session = record.getOpenSession();
          if (!session) {
              throw new Error("No session to encrypt message for " + address);
          }

          msg.ephemeralKey = session.currentRatchet.ephemeralKeyPair.pubKey;
          chain = session[msg.ephemeralKey.toString('base64')];
          if (chain.chainType === ChainType.RECEIVING) {
              throw new Error("Tried to encrypt on a receiving chain");
          }

          return this.fillMessageKeys(chain, chain.chainKey.counter + 1);
      }.bind(this)).then(function() {
          // XXX inspect the user of empty ArrayBuffer here
          return crypto.HKDF(chain.messageKeys[chain.chainKey.counter],
              new ArrayBuffer(32), "WhisperMessageKeys");
      }).then(function(keys) {
          delete chain.messageKeys[chain.chainKey.counter];
          msg.counter = chain.chainKey.counter;
          msg.previousCounter = session.currentRatchet.previousCounter;

          return crypto.encrypt(keys[0], buffer, keys[2].slice(0, 16)
          ).then(function(ciphertext) {
              msg.ciphertext = ciphertext;
              var encodedMsg = msg;

              var macInput = new Uint8Array(encodedMsg.byteLength + 33*2 + 1);
              macInput.set(ourIdentityKey.pubKey);
              macInput.set(session.indexInfo.remoteIdentityKey, 33);
              macInput[33*2] = (3 << 4) | 3;
              macInput.set(encodedMsg, 33*2 + 1);

              return crypto.sign(keys[1], macInput).then(function(mac) {
                  var result = new Uint8Array(encodedMsg.byteLength + 9);
                  result[0] = (3 << 4) | 3;
                  result.set(encodedMsg, 1);
                  result.set(mac.slice(0, 8), encodedMsg.byteLength + 1);
                  record.updateSessionState(session);
                  return this.storage.storeSession(address, record.serialize()).then(function() {
                      return result;
                  });
              }.bind(this));
          }.bind(this));
      }.bind(this)).then(function(message) {
          if (session.pendingPreKey !== undefined) {
              var preKeyMsg = new protobufs.PreKeyWhisperMessage();
              preKeyMsg.identityKey = ourIdentityKey.pubKey;
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
    }.bind(this));
  },

  decryptWithSessionList: function(buffer, sessionList, errors) {
    // Iterate recursively through the list, attempting to decrypt
    // using each one at a time. Stop and return the result if we get
    // a valid result
    if (sessionList.length === 0) {
        return Promise.reject(errors[0]);
    }

    var session = sessionList.pop();
    return this.doDecryptWhisperMessage(buffer, session).then(function(plaintext) {
        return { plaintext: plaintext, session: session };
    }).catch(function(e) {
        errors.push(e);
        return this.decryptWithSessionList(buffer, sessionList, errors);
    }.bind(this));
  },

  decryptWhisperMessage: function(buffer, encoding) {
    if (encoding !== undefined) {
      throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
    }
    assert_buffer(buffer);
    return SessionLock.queueJobForNumber(this.remoteAddress.toString(), function() {
      var address = this.remoteAddress.toString();
      return this.getRecord(address).then(function(record) {
        if (!record) {
          throw new Error("No record for device " + address);
        }
        var errors = [];
        return this.decryptWithSessionList(buffer, record.getSessions(), errors).then(function(result) {
          return this.getRecord(address).then(function(record) {
            record.updateSessionState(result.session);
            return this.storage.storeSession(address, record.serialize()).then(function() {
              return result.plaintext;
            });
          }.bind(this));
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  decryptPreKeyWhisperMessage: function(buffer, encoding) {
    if (encoding !== undefined) {
       throw new Error("DEPRECATED: encoding not valid anymore, only pass Buffer type!");
    }
    assert_buffer(buffer);
    var version = buffer[0];
    if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
      throw new Error("Incompatible version number on PreKeyWhisperMessage");
    }
    return SessionLock.queueJobForNumber(this.remoteAddress.toString(), function() {
      var address = this.remoteAddress.toString();
      return this.getRecord(address).then(function(record) {
        var preKeyProto = protobufs.PreKeyWhisperMessage.decode(buffer);
        if (!record) {
          if (preKeyProto.registrationId === undefined) {
            throw new Error("No registrationId");
          }
          record = new SessionRecord(
            preKeyProto.identityKey.toString('binary'),
            preKeyProto.registrationId
          );
        }
        var builder = new SessionBuilder(this.storage, this.remoteAddress);
        return builder.processV3(record, preKeyProto).then(function(preKeyId) {
          var session = record.getSessionByBaseKey(preKeyProto.baseKey);
          return this.doDecryptWhisperMessage(preKeyProto.message, session).then(function(plaintext) {
            record.updateSessionState(session);
            return this.storage.storeSession(address, record.serialize()).then(function() {
              if (preKeyId !== undefined) {
                return this.storage.removePreKey(preKeyId);
              }
            }.bind(this)).then(function() {
              return plaintext;
            });
          }.bind(this));
        }.bind(this));
      }.bind(this));
    }.bind(this));
  },

  doDecryptWhisperMessage: function(messageBytes, session) {
    assert_buffer(messageBytes);
    var version = messageBytes[0];
    if ((version & 0xF) > 3 || (version >> 4) < 3) {  // min version > 3 or max version < 3
        throw new Error("Incompatible version number on WhisperMessage");
    }
    var messageProto = messageBytes.slice(1, messageBytes.byteLength - 8);
    var mac = messageBytes.slice(messageBytes.byteLength - 8, messageBytes.byteLength);

    var message = protobufs.WhisperMessage.decode(messageProto);
    var remoteEphemeralKey = message.ephemeralKey;

    if (session === undefined) {
        return Promise.reject(new Error("No session found to decrypt message from " + this.remoteAddress.toString()));
    }
    if (session.indexInfo.closed != -1) {
        console.log('decrypting message for closed session');
    }

    return this.maybeStepRatchet(session, remoteEphemeralKey, message.previousCounter).then(function() {
        assert_buffer(message.ephemeralKey);
        var chain = session[message.ephemeralKey.toString('base64')];
        if (chain.chainType === ChainType.SENDING) {
            throw new Error("Tried to decrypt on a sending chain");
        }

        return this.fillMessageKeys(chain, message.counter).then(function() {
            var messageKey = chain.messageKeys[message.counter];
            if (messageKey === undefined) {
                var e = new Error("Message key not found. The counter was repeated or the key was not filled.");
                e.name = 'MessageCounterError';
                throw e;
            }
            delete chain.messageKeys[message.counter];
            return crypto.HKDF(messageKey, Buffer.alloc(32), "WhisperMessageKeys");
        });
    }.bind(this)).then(function(keys) {
        return this.storage.getIdentityKeyPair().then(function(ourIdentityKey) {
            var macInput = new Uint8Array(messageProto.byteLength + 33*2 + 1);
            macInput.set(session.indexInfo.remoteIdentityKey);
            macInput.set(ourIdentityKey.pubKey, 33);
            macInput[33*2] = (3 << 4) | 3;
            macInput.set(messageProto, 33*2 + 1);
            return crypto.verifyMAC(macInput, keys[1], mac, 8);
        }.bind(this)).then(function() {
            return crypto.decrypt(keys[0], message.ciphertext, keys[2].slice(0, 16));
        });
    }.bind(this)).then(function(plaintext) {
        delete session.pendingPreKey;
        return plaintext;
    });
  },

  fillMessageKeys: function(chain, counter) {
      if (Object.keys(chain.messageKeys).length >= 1000) {
          console.log("Too many message keys for chain");
          return Promise.resolve(); // Stalker, much?
      }

      if (chain.chainKey.counter >= counter) {
          return Promise.resolve(); // Already calculated
      }

      if (chain.chainKey.key === undefined) {
          throw new Error("Got invalid request to extend chain after it was already closed");
      }

      var key = chain.chainKey.key;
      return crypto.sign(key, Buffer.from([1])).then(function(mac) {
          return crypto.sign(key, Buffer.from([2])).then(function(key) {
              chain.messageKeys[chain.chainKey.counter + 1] = mac;
              chain.chainKey.key = key;
              chain.chainKey.counter += 1;
              return this.fillMessageKeys(chain, counter);
          }.bind(this));
      }.bind(this));
  },

  maybeStepRatchet: function(session, remoteKey, previousCounter) {
      if (session[remoteKey.toString('base64')] !== undefined) {
          return Promise.resolve();
      }

      console.log('New remote ephemeral key');
      var ratchet = session.currentRatchet;

      return Promise.resolve().then(function() {
          var previousRatchet = session[ratchet.lastRemoteEphemeralKey.toString('base64')];
          if (previousRatchet !== undefined) {
              return this.fillMessageKeys(previousRatchet, previousCounter).then(function() {
                  delete previousRatchet.chainKey.key;
                  session.oldRatchetList[session.oldRatchetList.length] = {
                      added        : Date.now(),
                      ephemeralKey : ratchet.lastRemoteEphemeralKey
                  };
              });
          }
      }.bind(this)).then(function() {
          return this.calculateRatchet(session, remoteKey, false).then(function() {
              // Now swap the ephemeral key and calculate the new sending chain
              var previousRatchet = ratchet.ephemeralKeyPair.pubKey.toString('base64');
              if (session[previousRatchet] !== undefined) {
                  ratchet.previousCounter = session[previousRatchet].chainKey.counter;
                  delete session[previousRatchet];
              }

              return crypto.createKeyPair().then(function(keyPair) {
                  ratchet.ephemeralKeyPair = keyPair;
                  return this.calculateRatchet(session, remoteKey, true).then(function() {
                      ratchet.lastRemoteEphemeralKey = remoteKey;
                  }.bind(this));
              }.bind(this));
          }.bind(this));
      }.bind(this));
  },

  calculateRatchet: function(session, remoteKey, sending) {
      var ratchet = session.currentRatchet;

      return crypto.calculateAgreement(remoteKey, ratchet.ephemeralKeyPair.privKey).then(function(sharedSecret) {
          return crypto.HKDF(sharedSecret, ratchet.rootKey, "WhisperRatchet").then(function(masterKey) {
              var ephemeralPublicKey;
              if (sending) {
                  ephemeralPublicKey = ratchet.ephemeralKeyPair.pubKey;
              }
              else {
                  ephemeralPublicKey = remoteKey;
              }
              session[ephemeralPublicKey.toString('base64')] = {
                  messageKeys: {},
                  chainKey: { counter: -1, key: masterKey[1] },
                  chainType: sending ? ChainType.SENDING : ChainType.RECEIVING
              };
              ratchet.rootKey = masterKey[0];
          });
      });
  },

  getRemoteRegistrationId: function() {
    return SessionLock.queueJobForNumber(this.remoteAddress.toString(), function() {
      return this.getRecord(this.remoteAddress.toString()).then(function(record) {
          if (record === undefined) {
              return undefined;
          }
          return record.registrationId;
      });
    }.bind(this));
  },

  hasOpenSession: function() {
    return SessionLock.queueJobForNumber(this.remoteAddress.toString(), function() {
      return this.getRecord(this.remoteAddress.toString()).then(function(record) {
          if (record === undefined) {
              return false;
          }
          return record.haveOpenSession();
      });
    }.bind(this));
  },

  closeOpenSessionForDevice: function() {
    var address = this.remoteAddress.toString();
    return SessionLock.queueJobForNumber(address, function() {
      return this.getRecord(address).then(function(record) {
        if (record === undefined || record.getOpenSession() === undefined) {
            return;
        }

        record.archiveCurrentState();
        return this.storage.storeSession(address, record.serialize());
      }.bind(this));
    }.bind(this));
  }
};

module.exports = function(storage, remoteAddress) {
    var cipher = new SessionCipher(storage, remoteAddress);

    // returns a Promise that resolves to a ciphertext object
    this.encrypt = cipher.encrypt.bind(cipher);

    // returns a Promise that inits a session if necessary and resolves
    // to a decrypted plaintext array buffer
    this.decryptPreKeyWhisperMessage = cipher.decryptPreKeyWhisperMessage.bind(cipher);

    // returns a Promise that resolves to decrypted plaintext array buffer
    this.decryptWhisperMessage = cipher.decryptWhisperMessage.bind(cipher);

    this.getRemoteRegistrationId = cipher.getRemoteRegistrationId.bind(cipher);
    this.hasOpenSession = cipher.hasOpenSession.bind(cipher);
    this.closeOpenSessionForDevice = cipher.closeOpenSessionForDevice.bind(cipher);
};
