'use strict';

const ByteBuffer = require('bytebuffer');
const ProtoBuf = require('protobufjs');

function loadProtoBufs(filename) {
    const b = ProtoBuf.loadProtoFile('./protos/' + filename);
    return b.build('textsecure');
}

var protocolMessages = loadProtoBufs('WhisperTextProtocol.proto');

module.exports = {
    WhisperMessage: protocolMessages.WhisperMessage,
    PreKeyWhisperMessage: protocolMessages.PreKeyWhisperMessage
};
