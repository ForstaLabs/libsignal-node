'use strict';

const crypto = require('./crypto.js');
const node_crypto = require('crypto');

function isNonNegativeInteger(n) {
    return (typeof n === 'number' && (n % 1) === 0  && n >= 0);
}

var KeyHelper = {
    generateIdentityKeyPair: function() {
        return crypto.createKeyPair();
    },

    generateRegistrationId: function() {
        var registrationId = Uint16Array.from(node_crypto.randomBytes(2))[0];
        return registrationId & 0x3fff;
    },

    generateSignedPreKey: function (identityKeyPair, signedKeyId) {
        if (!(identityKeyPair.privKey instanceof Buffer) ||
            identityKeyPair.privKey.byteLength != 32 ||
            !(identityKeyPair.pubKey instanceof Buffer) ||
            identityKeyPair.pubKey.byteLength != 33) {
            throw new TypeError('Invalid argument for identityKeyPair');
        }
        if (!isNonNegativeInteger(signedKeyId)) {
            throw new TypeError('Invalid argument for signedKeyId: ' + signedKeyId);
        }
        const keyPair = crypto.createKeyPair();
        const sig = crypto.calculateSignature(identityKeyPair.privKey,
                                              keyPair.pubKey);
        return {
            keyId: signedKeyId,
            keyPair: keyPair,
            signature: sig
        };
    },

    generatePreKey: function(keyId) {
        if (!isNonNegativeInteger(keyId)) {
            throw new TypeError('Invalid argument for keyId: ' + keyId);
        }
        const keyPair = crypto.createKeyPair();
        return {
            keyId,
            keyPair
        };
    }
};

module.exports = KeyHelper;
