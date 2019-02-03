'use strict';

const path = require('path');
const protobuf = require('protobufjs');

const protodir = path.resolve(__dirname, '../protos/');
const p = protobuf.loadSync(path.join(protodir, 'WhisperTextProtocol.proto')).lookup('textsecure');

module.exports = {
    WhisperMessage: p.lookup('WhisperMessage'),
    PreKeyWhisperMessage: p.lookup('PreKeyWhisperMessage')
};
