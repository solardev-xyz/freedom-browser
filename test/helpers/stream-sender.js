/**
 * The service's side of design 0007's streams, for main's tests: frame.js's
 * `StreamSender`, a model of fc-protocol's `stream::Sender`, with a
 * service's abort codes (0007's five). It is what a scripted fake service
 * writes, and the sender the receiver's property test runs against.
 * `vectors/streams.json`'s `sender` cases hold it to the design, as they
 * hold the Rust one. The same class holds the bodies main sends the core at
 * protocol 2 (design 0009), with a piece's codes (`StreamDuplex`).
 */

const { StreamSender, SMALL_FRAME, WRITER_DATA_CAP } = require('../../src/main/core/frame');

module.exports = { StreamSender, SMALL_FRAME, WRITER_DATA_CAP };
