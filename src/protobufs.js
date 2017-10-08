'use strict';

const protobuf = require('protobufjs');

const protodir = __dirname + '/../protos/';
const p = protobuf.loadSync(protodir + 'WhisperTextProtocol.proto').lookup('textsecure');

module.exports = {
    WhisperMessage: p.lookup('WhisperMessage'),
    PreKeyWhisperMessage: p.lookup('PreKeyWhisperMessage')
};
