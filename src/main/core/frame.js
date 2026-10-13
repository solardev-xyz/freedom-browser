/**
 * Frames for the freedom-cored protocol (freedom-core design 0001, and
 * design 0005's Frames): a u32 big-endian length of everything after it, a
 * u8 kind, then a payload of at most 1 MiB.
 * - 0x01: one whole JSON message;
 * - 0x12 begin (`{ id, bytes }`), 0x10 fragment and 0x11 last: a response
 *   over one frame, of at most 32 MiB in all;
 * - 0x13: bulk credit, empty: the receiver returns the sender's right to
 *   begin another fragmented response.
 * Kinds 0x02–0x0F are reserved for streams (protocol v2), and refused like
 * any other kind.
 */

const KIND_JSON = 0x01;
const KIND_FRAGMENT = 0x10;
const KIND_LAST = 0x11;
const KIND_BEGIN = 0x12;
const KIND_CREDIT = 0x13;
const KINDS = new Set([KIND_JSON, KIND_FRAGMENT, KIND_LAST, KIND_BEGIN, KIND_CREDIT]);
const MAX_PAYLOAD = 1024 * 1024;
// The largest serialized message, fragmented or not (design 0005, Frames).
const MAX_MESSAGE = 32 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A framing failure. `category` is a fixed string, never input text, so it
 * is safe to log: bad_length, unknown_kind, invalid_utf8, invalid_json or
 * too_large, and for fragmented responses the categories fc-protocol logs
 * (begin_header, begin_without_credit, begin_size, begin_unknown_id,
 * empty_fragment, fragment_without_begin, fragment_length, credit_payload,
 * duplicate_response).
 */
class FrameError extends Error {
  constructor(category) {
    super(`frame error: ${category}`);
    this.name = 'FrameError';
    this.category = category;
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {number} kind
 * @param {number} length - the payload's bytes, at most MAX_PAYLOAD
 * @returns {Buffer} the five bytes that start the frame
 */
function frameHeader(kind, length) {
  if (length > MAX_PAYLOAD) throw new FrameError('too_large');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(length + 1, 0);
  header[4] = kind;
  return header;
}

/**
 * @param {object} message - JSON-serializable message
 * @returns {Buffer} one framed JSON message
 */
function encodeFrame(message) {
  return encodeJsonFrame(JSON.stringify(message));
}

/**
 * @param {string} json - one message, already serialized
 * @returns {Buffer} it, framed
 */
function encodeJsonFrame(json) {
  const payload = Buffer.from(json, 'utf8');
  return Buffer.concat([frameHeader(KIND_JSON, payload.length), payload]);
}

/**
 * @param {number} id - the request the response answers
 * @param {number} bytes - the response's serialized size
 * @returns {Buffer} its begin frame
 */
function encodeBegin(id, bytes) {
  const payload = Buffer.from(JSON.stringify({ id, bytes }), 'utf8');
  return Buffer.concat([frameHeader(KIND_BEGIN, payload.length), payload]);
}

/** @returns {Buffer} the credit frame: the kind alone. */
function encodeCredit() {
  return frameHeader(KIND_CREDIT, 0);
}

/** A JSON payload, decoded as the Rust side decodes it: valid UTF-8, with
 * nothing replaced. */
function decodeJson(payload) {
  let text;
  try {
    text = UTF8.decode(payload);
  } catch {
    throw new FrameError('invalid_utf8');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new FrameError('invalid_json');
  }
}

// A begin header as fc-protocol's serde reads it: an object of two members,
// each a JSON string name and a `u64` in serde_json's grammar (digits only:
// no sign, fraction, exponent or leading zero), with JSON's whitespace
// between tokens. JSON.parse would take `3.0`, `7e0` or `-0` as integers.
const WS = String.raw`[ \t\n\r]*`;
const MEMBER = String.raw`("(?:[^"\\]|\\.)*")${WS}:${WS}(0|[1-9][0-9]*)`;
const BEGIN_HEADER = new RegExp(
  String.raw`^${WS}\{${WS}${MEMBER}${WS},${WS}${MEMBER}${WS}\}${WS}$`
);
const MAX_U64 = 2n ** 64n - 1n;

/** A begin frame's header: an object with exactly `id`, a valid message ID,
 * and `bytes`, a `u64` the reassembler checks against the cap. Each is named
 * once: where JSON.parse keeps a duplicate's last value, serde refuses it. */
function decodeBegin(payload) {
  let text;
  try {
    text = UTF8.decode(payload);
  } catch {
    throw new FrameError('begin_header');
  }
  const match = BEGIN_HEADER.exec(text);
  if (!match) throw new FrameError('begin_header');
  const members = new Map();
  for (const [name, digits] of [match.slice(1, 3), match.slice(3, 5)]) {
    let key;
    try {
      // Names may be escaped, as serde unescapes them.
      key = JSON.parse(name);
    } catch {
      throw new FrameError('begin_header');
    }
    // Past 20 digits it is over u64 without converting it.
    if (digits.length > 20 || BigInt(digits) > MAX_U64) throw new FrameError('begin_header');
    members.set(key, BigInt(digits));
  }
  const id = members.get('id');
  const bytes = members.get('bytes');
  if (members.size !== 2 || id === undefined || bytes === undefined) {
    throw new FrameError('begin_header');
  }
  if (id < 1n || id > BigInt(Number.MAX_SAFE_INTEGER)) throw new FrameError('begin_header');
  return { id: Number(id), bytes: Number(bytes) };
}

/**
 * Turns a byte stream into frames: `{ kind: KIND_JSON, message }` for a whole
 * message, parsed, and `{ kind, payload }` for the fragment kinds. After the
 * first error it stays failed: a corrupted stream can't be resynchronized.
 *
 * Input is kept as the list of chunks it came in, never joined as a whole: a
 * frame within one chunk is a view of it, and one across chunks is copied
 * once. So each byte is copied at most once, however the stream is cut.
 */
class FrameDecoder {
  constructor() {
    this.chunks = []; // unread input, from `head` on
    this.head = 0;
    this.offset = 0; // the read position in chunks[head]
    this.buffered = 0; // unread bytes
    this.frame = null; // { kind, length } once a header is read
    this.failed = null;
  }

  /**
   * @param {Buffer} chunk
   * @returns {object[]} the complete frames so far
   */
  push(chunk) {
    if (this.failed) throw this.failed;
    if (chunk.length) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames = [];
    for (;;) {
      if (!this.frame) {
        if (this.buffered < 5) break;
        const header = this.take(5);
        const length = header.readUInt32BE(0);
        const kind = header[4];
        if (length === 0 || length - 1 > MAX_PAYLOAD) return this.fail('bad_length');
        if (!KINDS.has(kind)) return this.fail('unknown_kind');
        this.frame = { kind, length: length - 1 };
      }
      if (this.buffered < this.frame.length) break;
      const { kind, length } = this.frame;
      this.frame = null;
      const payload = this.take(length);
      if (kind !== KIND_JSON) {
        frames.push({ kind, payload });
        continue;
      }
      try {
        frames.push({ kind, message: decodeJson(payload) });
      } catch (err) {
        return this.fail(err.category);
      }
    }
    return frames;
  }

  /** True between frames; false if EOF now would cut a frame short. */
  isAtBoundary() {
    return this.buffered === 0 && !this.frame;
  }

  /** The next `n` unread bytes: a view of one chunk, or the parts copied. */
  take(n) {
    if (n === 0) return Buffer.alloc(0);
    this.buffered -= n;
    const first = this.chunks[this.head];
    if (first.length - this.offset >= n) {
      const view = first.subarray(this.offset, this.offset + n);
      this.advance(n);
      return view;
    }
    const out = Buffer.allocUnsafe(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[this.head];
      const count = Math.min(chunk.length - this.offset, n - filled);
      chunk.copy(out, filled, this.offset, this.offset + count);
      filled += count;
      this.advance(count);
    }
    return out;
  }

  /** Moves past `count` bytes of the current chunk, and past the chunk once
   * it is read. Read chunks are released, and the list compacted once they
   * are most of it. */
  advance(count) {
    this.offset += count;
    if (this.offset < this.chunks[this.head].length) return;
    this.chunks[this.head] = null;
    this.head += 1;
    this.offset = 0;
    if (this.head === this.chunks.length) {
      this.chunks = [];
      this.head = 0;
    } else if (this.head >= 64 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  fail(category) {
    this.failed = new FrameError(category);
    this.chunks = [];
    this.head = 0;
    this.offset = 0;
    this.buffered = 0;
    this.frame = null;
    throw this.failed;
  }
}

/**
 * The receiving side of fragmented responses (design 0005, Frames), as
 * fc-protocol's Reassembler: turns a decoder's frames into whole messages,
 * completed responses and credit returns.
 * - **At a begin** it checks the sender's credit, the size against the
 *   message cap and the ID against the receiver's pending requests, then
 *   reserves exactly the declared bytes. The credit allows one response in
 *   reassembly, so nothing else is ever reserved.
 * - **Whole messages** pass, also between fragments. A whole response for
 *   the request in reassembly is its second response (0001: one each).
 * - **Fragments** append; the last completes the response, which must be
 *   exactly the declared size, and is decoded as a whole message is.
 * - **After an error** it stays failed, and the partial response is dropped.
 */
class Reassembler {
  constructor() {
    // The handshake grants the peer this side's credit: main always offers
    // fragments.
    this.peerCredit = true;
    this.current = null; // { id, buffer, filled }: the response in reassembly
    this.failed = null;
  }

  /**
   * @param {object} frame - one of FrameDecoder's
   * @param {Function} pending - whether an ID is a pending request of the
   *   receiver's; asked only at a begin, once every other check has passed
   * @returns {object|null} `{ type: 'message', message }` for a whole message,
   *   `{ type: 'response', id, message }` for a completed fragmented response
   *   to request `id`, `{ type: 'credit' }` when the peer returned this side's
   *   credit, or null for a begin or fragment taken in
   */
  push(frame, pending) {
    if (this.failed) throw this.failed;
    try {
      return this.take(frame, pending);
    } catch (err) {
      this.failed = err instanceof FrameError ? err : new FrameError('decode');
      this.current = null;
      throw this.failed;
    }
  }

  take(frame, pending) {
    const { kind, payload } = frame;
    if (kind === KIND_JSON) {
      const { message } = frame;
      if (this.current && isObject(message) && message.type === 'response') {
        if (message.id === this.current.id) throw new FrameError('duplicate_response');
      }
      return { type: 'message', message };
    }
    if (kind === KIND_CREDIT) {
      if (payload.length) throw new FrameError('credit_payload');
      return { type: 'credit' };
    }
    if (kind === KIND_BEGIN) {
      const { id, bytes } = decodeBegin(payload);
      // One in reassembly, or one completed whose credit hasn't come back.
      if (!this.peerCredit) throw new FrameError('begin_without_credit');
      if (bytes < 1 || bytes > MAX_MESSAGE) throw new FrameError('begin_size');
      if (!pending(id)) throw new FrameError('begin_unknown_id');
      this.peerCredit = false;
      this.current = { id, buffer: Buffer.alloc(bytes), filled: 0 };
      return null;
    }
    if (kind === KIND_FRAGMENT || kind === KIND_LAST) {
      const current = this.current;
      if (!current) throw new FrameError('fragment_without_begin');
      if (!payload.length) throw new FrameError('empty_fragment');
      const got = current.filled + payload.length;
      if (got > current.buffer.length || (kind === KIND_LAST && got !== current.buffer.length)) {
        throw new FrameError('fragment_length');
      }
      payload.copy(current.buffer, current.filled);
      current.filled = got;
      if (kind === KIND_FRAGMENT) return null;
      this.current = null;
      return { type: 'response', id: current.id, message: decodeJson(current.buffer) };
    }
    throw new FrameError('unknown_kind');
  }

  /** This side returned the peer's credit (it sent 0x13): the peer may
   * begin again. */
  grant() {
    this.peerCredit = true;
  }

  /** Whether a response is in reassembly: EOF now cuts it short. */
  inProgress() {
    return this.current !== null;
  }

  /** Drops the response in reassembly, with its reservation. */
  discard() {
    this.current = null;
  }
}

module.exports = {
  encodeBegin,
  encodeCredit,
  encodeFrame,
  encodeJsonFrame,
  frameHeader,
  FrameDecoder,
  FrameError,
  Reassembler,
  KIND_BEGIN,
  KIND_CREDIT,
  KIND_FRAGMENT,
  KIND_JSON,
  KIND_LAST,
  MAX_MESSAGE,
  MAX_PAYLOAD,
};
