/**
 * Frames for the freedom-cored protocol (freedom-core design 0001):
 * a u32 big-endian length of everything after it, a u8 kind, the payload.
 * Kind 0x01 is one JSON message, at most 1 MiB. Kinds 0x02–0x0F are
 * reserved for streams (protocol v2).
 */

const KIND_JSON = 0x01;
const MAX_PAYLOAD = 1024 * 1024;

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

/**
 * @param {object} message - JSON-serializable message
 * @returns {Buffer} one framed JSON message
 */
function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError(`frame payload of ${payload.length} bytes exceeds the limit`);
  }
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length + 1, 0);
  header[4] = KIND_JSON;
  return Buffer.concat([header, payload]);
}

/**
 * Turns a byte stream into JSON messages. After the first error it stays
 * failed: a corrupted stream can't be resynchronized.
 */
class FrameDecoder {
  constructor() {
    this.buffered = Buffer.alloc(0);
    this.failed = null;
  }

  /**
   * @param {Buffer} chunk
   * @returns {object[]} the complete messages in this chunk
   */
  push(chunk) {
    if (this.failed) throw this.failed;
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const messages = [];
    while (this.buffered.length >= 5) {
      const length = this.buffered.readUInt32BE(0);
      const kind = this.buffered[4];
      if (length === 0 || length - 1 > MAX_PAYLOAD) {
        return this.fail(`bad frame length ${length}`);
      }
      if (kind !== KIND_JSON) {
        return this.fail(`unknown frame kind 0x${kind.toString(16)}`);
      }
      if (this.buffered.length < 4 + length) break;
      const payload = this.buffered.subarray(5, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      try {
        messages.push(JSON.parse(payload.toString('utf8')));
      } catch (err) {
        return this.fail(`invalid JSON in frame: ${err.message}`);
      }
    }
    return messages;
  }

  /** True between frames; false if EOF now would cut a frame short. */
  isAtBoundary() {
    return this.buffered.length === 0;
  }

  fail(message) {
    this.failed = new FrameError(message);
    throw this.failed;
  }
}

module.exports = { encodeFrame, FrameDecoder, FrameError, KIND_JSON, MAX_PAYLOAD };
