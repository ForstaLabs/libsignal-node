/* vim: ts=4:sw=4 */

'use strict';

const fs = require('fs');
const ByteBuffer = require('bytebuffer');
const ProtoBuf = require('node-protobuf')

function loadProtoBufs(filename) {
    return new ProtoBuf.loadProto(fs.readFileSync('../protos/' + filename));
}

var protocolMessages = loadProtoBufs('WhisperTextProtocol.proto');

module.exports = {
    WhisperMessage: protocolMessages.WhisperMessage,
    PreKeyWhisperMessage: protocolMessages.PreKeyWhisperMessage
};
