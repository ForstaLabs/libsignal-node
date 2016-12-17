'use strict';

const protobuf = require('protobufjs');

function loadProtoBufs(filename) {
    const b = protobuf.loadSync('./protos/' + filename);
    return b.build('textsecure');
}

const p = protobuf.loadSync('./protos/WhisperTextProtocol.proto').lookup('textsecure');

module.exports = {
    WhisperMessage: p.lookup('WhisperMessage'),
    PreKeyWhisperMessage: p.lookup('PreKeyWhisperMessage'),
};
