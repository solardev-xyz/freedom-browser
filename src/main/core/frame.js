/**
 * Frames for the freedom-cored protocol (freedom-core design 0001):
 * a u32 big-endian length of everything after it, a u8 kind, the payload.
 * Kind 0x01 is one JSON message, at most 1 MiB. Kinds 0x02–0x0F are
 * reserved for streams (protocol v2).
 */

const KIND_JSON = 0x01;
const MAX_PAYLOAD = 1024 * 1024;

/**
 * A framing failure. `category` is a fixed string (bad_length,
 * unknown_kind, invalid_utf8, invalid_json): never input text, so it is
 * safe to log.
 */
class FrameError extends Error {
  constructor(category) {
    super(`frame error: ${category}`);
    this.name = 'FrameError';
    this.category = category;
  }
}

/**
 * @param {object} message - JSON-serializable message
 * @returns {Buffer} one framed JSON message
 */
function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  if (payload.length > MAX_PAYLOAD) {
    throw new FrameError('too_large');
  }
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length + 1, 0);
  header[4] = KIND_JSON;
  return Buffer.concat([header, payload]);
}

/**
 * Turns a byte stream into JSON values. After the first error it stays
 * failed: a corrupted stream can't be resynchronized. Payloads must be
 * valid UTF-8, as the Rust decoder requires; nothing is replaced.
 */
class FrameDecoder {
  constructor() {
    this.buffered = Buffer.alloc(0);
    this.failed = null;
    this.utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  }

  /**
   * @param {Buffer} chunk
   * @returns {unknown[]} the complete JSON values in this chunk
   */
  push(chunk) {
    if (this.failed) throw this.failed;
    this.buffered = this.buffered.length ? Buffer.concat([this.buffered, chunk]) : chunk;
    const messages = [];
    while (this.buffered.length >= 5) {
      const length = this.buffered.readUInt32BE(0);
      const kind = this.buffered[4];
      if (length === 0 || length - 1 > MAX_PAYLOAD) return this.fail('bad_length');
      if (kind !== KIND_JSON) return this.fail('unknown_kind');
      if (this.buffered.length < 4 + length) break;
      const payload = this.buffered.subarray(5, 4 + length);
      this.buffered = this.buffered.subarray(4 + length);
      let text;
      try {
        text = this.utf8.decode(payload);
      } catch {
        return this.fail('invalid_utf8');
      }
      try {
        messages.push(JSON.parse(text));
      } catch {
        return this.fail('invalid_json');
      }
    }
    return messages;
  }

  /** True between frames; false if EOF now would cut a frame short. */
  isAtBoundary() {
    return this.buffered.length === 0;
  }

  fail(category) {
    this.failed = new FrameError(category);
    this.buffered = Buffer.alloc(0);
    throw this.failed;
  }
}

module.exports = { encodeFrame, FrameDecoder, FrameError, KIND_JSON, MAX_PAYLOAD };
