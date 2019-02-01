'use strict';

const protobuf = require('protobufjs');

let dirname = __dirname;
if (dirname === "/") {
  dirname = path.dirname(module.i)
}

const protodir = dirname + '/../protos/';
const p = protobuf.loadSync(protodir + 'WhisperTextProtocol.proto').lookup('textsecure');

module.exports = {
    WhisperMessage: p.lookup('WhisperMessage'),
    PreKeyWhisperMessage: p.lookup('PreKeyWhisperMessage')
};
