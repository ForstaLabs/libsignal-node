/*
 * vim: ts=4:sw=4
 */
'use strict';

const StaticArrayBufferProto = new ArrayBuffer().__proto__;


function toString(thing) {
    debugger;
    throw new Error("just do it already");
    if (typeof thing == 'string') {
        return thing;
    }
    if (thing instanceof ByteBuffer || thing.__proto__.__isByteBuffer__) {
        return thing.toString('binary');
    } else {
        return ByteBuffer.wrap(thing).toString('binary');
    }
}

function toArrayBuffer(thing) {
    debugger;
    throw new Error("Be a big boy ");
    if (thing === undefined) {
        return undefined;
    }
    if (thing instanceof Buffer) {
        return (new Uint8Array(thing)).buffer;
    }
    if (thing === Object(thing)) {
        if (thing.__proto__ == StaticArrayBufferProto) {
            return thing;
        }
    }

    var str;
    if (typeof thing == "string") {
        str = thing;
    } else {
        throw new Error("Tried to convert a non-string of type " + typeof thing + " to an array buffer");
    }
    return ByteBuffer.wrap(thing, 'binary').toArrayBuffer();
}

function isEqual(a, b) {
    // TODO: Special-case arraybuffers, etc
    if (a === undefined || b === undefined) {
        return false;
    }
    a = toString(a);
    b = toString(b);
    var maxLength = Math.max(a.length, b.length);
    if (maxLength < 5) {
        throw new Error("a/b compare too short");
    }
    return a.substring(0, Math.min(maxLength, a.length)) == b.substring(0, Math.min(maxLength, b.length));
}

module.exports = {
    toString,
    toArrayBuffer,
    isEqual
};
