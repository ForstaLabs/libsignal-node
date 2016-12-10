
'use strict';

const curve25519 = require('../src/curve25519_wrapper.js');
const ByteBuffer = require('bytebuffer');


function validatePrivKey(privKey) {
    if (privKey === undefined) {
        throw new Error("Undefined private key");
    }
    if (!(privKey instanceof ArrayBuffer)) {
        throw new Error(`Invalid private key type: ${privKey.constructor.name}`);
    }
    if (privKey.byteLength != 32) {
        console.log(privKey);
        throw new Error(`Incorrect private key length: ${privKey.byteLength}`);
    }
}

function validatePubKeyFormat(pubKey) {
    if (pubKey === undefined || ((pubKey.byteLength != 33 || new Uint8Array(pubKey)[0] != 5) && pubKey.byteLength != 32)) {
        throw new Error("Invalid public key");
    }
    if (pubKey.byteLength == 33) {
        return pubKey.slice(1);
    } else {
        console.error("WARNING: Expected pubkey of length 33, please report the ST and client that generated the pubkey");
        return pubKey;
    }
}

function processKeys(raw_keys) {
    // prepend version byte
    var origPub = new Uint8Array(raw_keys.pubKey);
    var pub = new Uint8Array(33);
    pub.set(origPub, 1);
    pub[0] = 5;

    return { pubKey: pub.buffer, privKey: raw_keys.privKey };
}

function wrapCurve25519(curve) {
    return {
        // Curve 25519 crypto
        createKeyPair: function(privKey) {
            validatePrivKey(privKey);
            var raw_keys = curve.keyPair(privKey);
            if (raw_keys instanceof Promise) {
                return raw_keys.then(processKeys);
            } else {
                return processKeys(raw_keys);
            }
        },
        ECDHE: function(pubKey, privKey) {
            pubKey = validatePubKeyFormat(pubKey);
            validatePrivKey(privKey);

            if (pubKey === undefined || pubKey.byteLength != 32) {
                throw new Error("Invalid public key");
            }

            return curve.sharedSecret(pubKey, privKey);
        },
        Ed25519Sign: function(privKey, message) {
            validatePrivKey(privKey);

            if (message === undefined) {
                throw new Error("Invalid message");
            }

            return curve.sign(privKey, message);
        },
        Ed25519Verify: function(pubKey, msg, sig) {
            pubKey = validatePubKeyFormat(pubKey);

            if (pubKey === undefined || pubKey.byteLength != 32) {
                throw new Error("Invalid public key");
            }

            if (msg === undefined) {
                throw new Error("Invalid message");
            }

            if (sig === undefined || sig.byteLength != 64) {
                throw new Error("Invalid signature");
            }

            return curve.verify(pubKey, msg, sig);
        }
    };
}

const Curve = wrapCurve25519(curve25519);
Curve.async = wrapCurve25519(curve25519.async);

function wrapCurve(curve) {
    return {
        generateKeyPair: function() {
            // XXX check to see if we can move up (circular refs and all)
            var privKey = require('./crypto.js').getRandomBytes(32);
            return curve.createKeyPair(privKey);
        },
        createKeyPair: function(privKey) {
            return curve.createKeyPair(privKey);
        },
        calculateAgreement: function(pubKey, privKey) {
            return curve.ECDHE(pubKey, privKey);
        },
        verifySignature: function(pubKey, msg, sig) {
            return curve.Ed25519Verify(pubKey, msg, sig);
        },
        calculateSignature: function(privKey, message) {
            return curve.Ed25519Sign(privKey, message);
        }
    };
}

module.exports = wrapCurve(Curve);
module.exports.async = wrapCurve(Curve.async);
