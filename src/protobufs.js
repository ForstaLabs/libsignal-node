'use strict';

const ByteBuffer = require('bytebuffer');
const ProtoBuf = require('protobufjs');

function loadProtoBufs(filename) {
    const b = ProtoBuf.loadProtoFile('./protos/' + filename);
    return b.build('textsecure');
}

const p = loadProtoBufs('WhisperTextProtocol.proto');

module.exports = {
    WhisperMessage: p.WhisperMessage,
    PreKeyWhisperMessage: p.PreKeyWhisperMessage
};
