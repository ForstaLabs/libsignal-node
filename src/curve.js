
'use strict';

const curve25519 = require('../src/curve25519_wrapper');
const nodeCrypto = require('crypto');


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

function scrubPubKeyFormat(pubKey) {
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

exports.createKeyPair = function(privKey) {
    validatePrivKey(privKey);
    const keys = curve25519.keyPair(privKey);
    // prepend version byte
    var origPub = new Uint8Array(keys.pubKey);
    var pub = new Uint8Array(33);
    pub.set(origPub, 1);
    pub[0] = 5;
    return {
        pubKey: Buffer.from(pub),
        privKey: Buffer.from(keys.privKey)
    };
};

exports.calculateAgreement = function(pubKey, privKey) {
    pubKey = scrubPubKeyFormat(pubKey);
    validatePrivKey(privKey);
    if (!pubKey || pubKey.byteLength != 32) {
        throw new Error("Invalid public key");
    }
    return Buffer.from(curve25519.sharedSecret(pubKey, privKey));
};

exports.calculateSignature = function(privKey, message) {
    validatePrivKey(privKey);
    if (!message) {
        throw new Error("Invalid message");
    }
    return Buffer.from(curve25519.sign(privKey, message));
};

exports.verifySignature = function(pubKey, msg, sig) {
    pubKey = scrubPubKeyFormat(pubKey);
    if (!pubKey || pubKey.byteLength != 32) {
        throw new Error("Invalid public key");
    }
    if (!msg) {
        throw new Error("Invalid message");
    }
    if (!sig || sig.byteLength != 64) {
        throw new Error("Invalid signature");
    }
    return curve25519.verify(pubKey, msg, sig);
};

exports.generateKeyPair = function() {
    const privKey = nodeCrypto.randomBytes(32);
    return exports.createKeyPair(privKey);
};
