// vim: ts=4:sw=4:expandtab

// Remove the dubious emscripten callback that invokes process.exit(1) on any
// unhandledRejection event.
let _exitCallback;
const captureExitCallback = (ev, callback) => {
    if (ev === 'unhandledRejection') {
        _exitCallback = callback;  // Must remove outside emit context.
        process.removeListener(ev, callback);
    }
};
process.addListener('newListener', captureExitCallback);
const curve25519 = require('../build/curve25519');
process.removeListener('newListener', captureExitCallback);
process.removeListener('unhandledRejection', _exitCallback);

// Insert some bytes into the emscripten memory and return a pointer
function _allocate(bytes) {
    const address = curve25519._malloc(bytes.length);
    curve25519.HEAPU8.set(bytes, address);

    return address;
}

function _readBytes(address, length, array) {
    array.set(curve25519.HEAPU8.subarray(address, address + length));
}

const basepoint = new Uint8Array(32);
basepoint[0] = 9;

exports.keyPair = function(privKey) {
    const priv = new Uint8Array(privKey);
    priv[0]  &= 248;
    priv[31] &= 127;
    priv[31] |= 64;

    // Where to store the result
    const publicKey_ptr = curve25519._malloc(32);

    // Get a pointer to the private key
    const privateKey_ptr = _allocate(priv);

    // The basepoint for generating public keys
    const basepoint_ptr = _allocate(basepoint);

    // The return value is just 0, the operation is done in place
    curve25519._curve25519_donna(publicKey_ptr, privateKey_ptr, basepoint_ptr);

    const res = new Uint8Array(32);
    _readBytes(publicKey_ptr, 32, res);

    curve25519._free(publicKey_ptr);
    curve25519._free(privateKey_ptr);
    curve25519._free(basepoint_ptr);

    return {
        pubKey: res.buffer,
        privKey: priv.buffer
    };
};

exports.sharedSecret = function(pubKey, privKey) {
    // Where to store the result
    const sharedKey_ptr = curve25519._malloc(32);

    // Get a pointer to our private key
    const privateKey_ptr = _allocate(new Uint8Array(privKey));

    // Get a pointer to their public key, the basepoint when you're
    // generating a shared secret
    const basepoint_ptr = _allocate(new Uint8Array(pubKey));

    // Return value is 0 here too of course
    curve25519._curve25519_donna(sharedKey_ptr, privateKey_ptr, basepoint_ptr);

    const res = new Uint8Array(32);
    _readBytes(sharedKey_ptr, 32, res);

    curve25519._free(sharedKey_ptr);
    curve25519._free(privateKey_ptr);
    curve25519._free(basepoint_ptr);

    return res.buffer;
};

exports.sign = function(privKey, message) {
    // Where to store the result
    const signature_ptr = curve25519._malloc(64);

    // Get a pointer to our private key
    const privateKey_ptr = _allocate(new Uint8Array(privKey));

    // Get a pointer to the message
    const message_ptr = _allocate(new Uint8Array(message));

    curve25519._curve25519_sign(signature_ptr, privateKey_ptr, message_ptr,
                                message.byteLength);

    const res = new Uint8Array(64);
    _readBytes(signature_ptr, 64, res);

    curve25519._free(signature_ptr);
    curve25519._free(privateKey_ptr);
    curve25519._free(message_ptr);

    return res.buffer;
};

exports.verify = function(pubKey, message, sig) {
    // Get a pointer to their public key
    const publicKey_ptr = _allocate(new Uint8Array(pubKey));

    // Get a pointer to the signature
    const signature_ptr = _allocate(new Uint8Array(sig));

    // Get a pointer to the message
    const message_ptr = _allocate(new Uint8Array(message));

    const res = curve25519._curve25519_verify(signature_ptr, publicKey_ptr, message_ptr,
                                              message.byteLength);

    curve25519._free(publicKey_ptr);
    curve25519._free(signature_ptr);
    curve25519._free(message_ptr);

    if (res !== 0) {
        throw new Error("Invalid signature");
    }
};
