/*
 * vim: ts=4:sw=4
 */

'use strict';


const curve = require('./curve.js');
const node_crypto = require('crypto');


function assert_buffer(value) {
    if (!(value instanceof Buffer)) {
        throw TypeError(`Expected Buffer instead of: ${value.constructor.name}`);
    }
    return value;
}


function encrypt(key, data, iv) {
    assert_buffer(key);
    assert_buffer(data);
    assert_buffer(iv);
    const cipher = node_crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([cipher.update(data), cipher.final()]);
}


function decrypt(key, data, iv) {
    assert_buffer(key);
    assert_buffer(data);
    assert_buffer(iv);
    const decipher = node_crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}


function sign(key, data) {
    assert_buffer(key);
    assert_buffer(data);
    const hmac = node_crypto.createHmac('sha256', key);
    hmac.update(data);
    return Buffer.from(hmac.digest());
}


function hash(data) {
    assert_buffer(data);
    const sha512 = node_crypto.createHash('sha512');
    sha512.update(data);
    return sha512.digest();
}

// HKDF for TextSecure has a bit of additional handling.
// Salts always end up being 32 bytes
function HKDF(input, salt, info) {
    // Specific implementation of RFC 5869 that only returns the first 3 32-byte chunks
    // TODO: We dont always need the third chunk, we might skip it
    assert_buffer(input);
    assert_buffer(salt);
    assert_buffer(info);
    if (salt.byteLength != 32) {
        throw new Error("Got salt of incorrect length");
    }
    const PRK = sign(salt, input);
    const infoArray = new Uint8Array(info.byteLength + 1 + 32);
    infoArray.set(info, 32);
    infoArray[infoArray.length - 1] = 1;
    const T1 = sign(PRK, Buffer.from(infoArray.slice(32)));
    infoArray.set(T1);
    infoArray[infoArray.length - 1] = 2;
    const T2 = sign(PRK, Buffer.from(infoArray));
    infoArray.set(T2);
    infoArray[infoArray.length - 1] = 3;
    const T3 = sign(PRK, Buffer.from(infoArray));
    return [T1, T2, T3];
}

function verifyMAC(data, key, mac, length) {
    const calculated_mac = sign(key, data).slice(0, length);
    if (mac.length !== length || calculated_mac.length !== length) {
        throw new Error("Bad MAC length");
    }
    if (!mac.equals(calculated_mac)) {
        console.error(`Bad MAC: expected ${calculated_mac.toString('hex')} ` +
                      `got ${mac.toString('hex')}`);
        throw new Error("Bad MAC");
    }
}

function createKeyPair(privKey) {
    if (privKey === undefined) {
        privKey = node_crypto.randomBytes(32);
    }
    return curve.createKeyPair(privKey);
}

function calculateAgreement(pubKey, privKey) {
    return curve.calculateAgreement(pubKey, privKey);
}

function calculateSignature(privKey, message) {
    return curve.calculateSignature(privKey, message);
}

function verifySignature(pubKey, message, sig) {
    return curve.verifySignature(pubKey, message, sig);
}

function generateKeyPair(privKey, message) {
    return curve.generateKeyPair(privKey, message);
}

module.exports = {
    HKDF,
    calculateAgreement,
    calculateSignature,
    verifySignature,
    createKeyPair,
    decrypt,
    encrypt,
    generateKeyPair,
    hash,
    sign,
    verifyMAC
};


