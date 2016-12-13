'use strict';

const crypto = require('./crypto.js');

function isNonNegativeInteger(n) {
    return (typeof n === 'number' && (n % 1) === 0  && n >= 0);
}

var KeyHelper = {
    generateIdentityKeyPair: function() {
        return crypto.createKeyPair();
    },

    generateRegistrationId: function() {
        var registrationId = new Uint16Array(crypto.getRandomBytes(2))[0];
        return registrationId & 0x3fff;
    },

    generateSignedPreKey: async function (identityKeyPair, signedKeyId) {
        if (!(identityKeyPair.privKey instanceof ArrayBuffer) ||
            identityKeyPair.privKey.byteLength != 32 ||
            !(identityKeyPair.pubKey instanceof ArrayBuffer) ||
            identityKeyPair.pubKey.byteLength != 33) {
            console.log('XXXX', typeof identityKeyPair);
            console.log('XXXX', identityKeyPair.privKey);
            console.log("xxxxx", identityKeyPair);
            throw new TypeError('Invalid argument for identityKeyPair');
        }
        if (!isNonNegativeInteger(signedKeyId)) {
            throw new TypeError(
                'Invalid argument for signedKeyId: ' + signedKeyId
            );
        }

        const keyPair = await crypto.createKeyPair();
        const sig = await crypto.calculateSignature(identityKeyPair.privKey,
                                                    keyPair.pubKey);
        return {
            keyId: signedKeyId,
            keyPair: keyPair,
            signature: sig
        };
    },

    generatePreKey: async function(keyId) {
        if (!isNonNegativeInteger(keyId)) {
            throw new TypeError('Invalid argument for keyId: ' + keyId);
        }
        const keyPair = await crypto.createKeyPair();
        return { keyId: keyId, keyPair: keyPair };
    }
};

module.exports = KeyHelper;
