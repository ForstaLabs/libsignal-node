
'use strict';

const curve25519 = require('../src/curve25519_wrapper.js');
const node_crypto = require('crypto');


function validatePrivKey(privKey) {
    if (privKey === undefined) {
        throw new Error("Undefined private key");
    }
    if (!(privKey instanceof Buffer)) {
        throw new Error(`Invalid private key type: ${privKey.constructor.name}`);
    }
    if (privKey.byteLength != 32) {
        throw new Error(`Incorrect private key length: ${privKey.byteLength}`);
    }
}

function validatePubKeyFormat(pubKey) {
    if (!(pubKey instanceof Buffer)) {
        throw new Error(`Invalid public key type: ${pubKey.constructor.name}`);
    }
    if (pubKey === undefined || ((pubKey.byteLength != 33 || pubKey[0] != 5) && pubKey.byteLength != 32)) {
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
    return {
        pubKey: Buffer.from(pub),
        privKey: Buffer.from(raw_keys.privKey)
    };
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
            const secret = curve.sharedSecret(pubKey, privKey);
            if (secret instanceof Promise) {
                return secret.then(Buffer.from);
            } else {
                return Buffer.from(secret);
            }
        },
        Ed25519Sign: function(privKey, message) {
            validatePrivKey(privKey);
            if (message === undefined) {
                throw new Error("Invalid message");
            }
            const raw_sig = curve.sign(privKey, message);
            if (raw_sig instanceof Promise) {
                return raw_sig.then(Buffer.from);
            } else {
                return Buffer.from(raw_keys);
            }
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
            var privKey = node_crypto.randomBytes(32);
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
            const s = curve.Ed25519Sign(privKey, message);
            debugger;
            return s
        }
    };
}

module.exports = wrapCurve(Curve);
module.exports.async = wrapCurve(Curve.async);
