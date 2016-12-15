/*
 * vim: ts=4:sw=4
 */

'use strict';

const ByteBuffer = require('bytebuffer');
const curve = require('./curve.js');
const helpers = require('./helpers.js');
const node_crypto = require('crypto');
const subtle = require('subtle');

function encrypt(key, data, iv) {
    return subtle.importKey('raw', key, {name: 'AES-CBC'}, false,
                            ['encrypt']).then(function(key) {
        return subtle.encrypt({name: 'AES-CBC', iv: new Uint8Array(iv)}, key, data);
    });
}

async function decrypt(key, data, iv) {
    const decipher = node_crypto.createDecipheriv('aes-256-cbc',
                                                  Buffer.from(key),
                                                  Buffer.from(iv));
    return Buffer.concat([
        decipher.update(Buffer.from(data)),
        decipher.final()
    ]);
    //return subtle.importKey('raw', key, {name: 'AES-CBC'}, false,
     //                       ['decrypt']).then(function(key) {
      //  return subtle.decrypt({name: 'AES-CBC', iv: new Uint8Array(iv)}, key, data);
    //});
}

async function sign(key, data) {
    const hmac = node_crypto.createHmac('sha256', Buffer.from(key));
    hmac.update(Buffer.from(data));
    return hmac.digest();
}

function hash(data) {
    const h = subtle.digest({name: 'SHA-512'}, data);
    console.log(h);
    throw new Error('hash check');
}

// HKDF for TextSecure has a bit of additional handling.
// Salts always end up being 32 bytes
async function HKDF(input, salt, plaininfo) {
    // Specific implementation of RFC 5869 that only returns the first 3 32-byte chunks
    // TODO: We dont always need the third chunk, we might skip it
    if (salt.byteLength != 32) {
        throw new Error("Got salt of incorrect length");
    }
    const info = helpers.toArrayBuffer(plaininfo);
    const PRK = await sign(salt, input);
    const infoBuffer = new ArrayBuffer(info.byteLength + 1 + 32);
    const infoArray = new Uint8Array(infoBuffer);
    infoArray.set(new Uint8Array(info), 32);
    infoArray[infoArray.length - 1] = 1;
    const T1 = await sign(PRK, infoBuffer.slice(32));
    infoArray.set(new Uint8Array(T1));
    infoArray[infoArray.length - 1] = 2;
    const T2 = await sign(PRK, infoBuffer);
    infoArray.set(new Uint8Array(T2));
    infoArray[infoArray.length - 1] = 3;
    const T3 = await sign(PRK, infoBuffer);
    return [T1, T2, T3];
}

async function verifyMAC(data, key, mac, length) {
    const calculated_mac = await sign(key, data);
    if (mac.byteLength != length  || calculated_mac.byteLength < length) {
        throw new Error("Bad MAC length");
    }
    var a = new Uint8Array(calculated_mac.slice(0, length));
    var b = new Uint8Array(mac);
    var result = 0;
    /* TODO: Optimize this.  This is a pointless exercise in bit manipulation.
     * Just throw the error if the intersection is not equal. */
    for (var i=0; i < mac.byteLength; ++i) {
        result = result | (a[i] ^ b[i]);
    }
    if (result !== 0) {
        console.log('Our MAC  ', a);
        console.log('Their MAC', b);
        throw new Error("Bad MAC");
    }
}

function getRandomBytes(len) {
    //return ByteBuffer.wrap(node_crypto.randomBytes(len));
    return node_crypto.randomBytes(len).buffer;
}

function createKeyPair(privKey) {
    if (privKey === undefined) {
        privKey = getRandomBytes(32);
    }
    return curve.async.createKeyPair(privKey);
}

function calculateAgreement(pubKey, privKey) {
    return curve.async.calculateAgreement(pubKey, privKey);
}

function calculateSignature(privKey, message) {
    return curve.async.calculateSignature(privKey, message);
}

function generateKeyPair(privKey, message) {
    return curve.async.generateKeyPair(privKey, message);
}

module.exports = {
    HKDF,
    calculateAgreement,
    calculateSignature,
    createKeyPair,
    decrypt,
    encrypt,
    generateKeyPair,
    getRandomBytes,
    hash,
    sign,
    verifyMAC,
};


