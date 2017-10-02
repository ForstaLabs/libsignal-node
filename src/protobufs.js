'use strict';

const protobuf = require('protobufjs');

const p = protobuf.loadSync('./protos/WhisperTextProtocol.proto').lookup('textsecure');

module.exports = {
    WhisperMessage: p.lookup('WhisperMessage'),
    PreKeyWhisperMessage: p.lookup('PreKeyWhisperMessage')
};
