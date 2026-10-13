/**
 * Frames for the freedom-cored protocol (freedom-core design 0001, and
 * design 0005's Frames): a u32 big-endian length of everything after it, a
 * u8 kind, then a payload of at most 1 MiB.
 * - 0x01: one whole JSON message;
 * - 0x12 begin (`{ id, bytes }`), 0x10 fragment and 0x11 last: a response
 *   over one frame, of at most 32 MiB in all;
 * - 0x13: bulk credit, empty: the receiver returns the sender's right to
 *   begin another fragmented response.
 *
 * **Which kinds a connection takes** is what its handshake granted
 * (`CORE_KINDS`, `serviceKinds(side)`). A freedom-cored connection takes
 * JSON and the fragment kinds, and refuses 0x02–0x0F. A service connection
 * whose handshake granted `stream` (design 0007, Frames) takes JSON and the
 * stream frames the other side sends, and no fragments:
 * - 0x02 data: an 8-byte big-endian stream ID, then 1 to 65 536 body bytes;
 * - 0x03 end: the ID alone;
 * - 0x04 abort: the ID, then JSON `{ code, message }` of at most 1 KiB;
 * - 0x05 credit: the ID, then a u32 above zero (main to the service).
 * A stream frame's payload length is checked against its kind at the
 * header, before anything else, its direction included: no payload byte is
 * read for a frame that is refused. Kinds 0x06–0x0F stay reserved.
 *
 * Main's side of the streams is `StreamReceiver` (the ring per stream,
 * pulls and credit, retirement) and `StreamOutbox` (the credit and cancels
 * it writes). fc-protocol's `stream` module is the reference, and
 * freedom-core's `vectors/streams.json` holds the cases both pass.
 */

const KIND_JSON = 0x01;
const KIND_DATA = 0x02;
const KIND_END = 0x03;
const KIND_ABORT = 0x04;
const KIND_STREAM_CREDIT = 0x05;
const KIND_FRAGMENT = 0x10;
const KIND_LAST = 0x11;
const KIND_BEGIN = 0x12;
const KIND_CREDIT = 0x13;
const FRAGMENT_KINDS = new Set([KIND_FRAGMENT, KIND_LAST, KIND_BEGIN, KIND_CREDIT]);
const STREAM_KINDS = new Set([KIND_DATA, KIND_END, KIND_ABORT, KIND_STREAM_CREDIT]);
const MAX_PAYLOAD = 1024 * 1024;
// Design 0007's streams.
const ID_BYTES = 8;
const WINDOW = 128 * 1024;
const MAX_DATA = 64 * 1024;
const MAX_ABORT_JSON = 1024;
const MAX_PULL = 64 * 1024;
const MAX_U32 = 0xffffffff;
// A message ID: 1 to 2^53 - 1, exact in JS.
const MAX_ID = Number.MAX_SAFE_INTEGER;
const ABORT_CODES = new Set(['cancelled', 'internal', 'body_stream_error', 'stopped', 'busy']);
// The largest serialized message, fragmented or not (design 0005, Frames).
const MAX_MESSAGE = 32 * 1024 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * A framing failure. `category` is a fixed string, never input text, so it
 * is safe to log: bad_length, unknown_kind, invalid_utf8, invalid_json or
 * too_large, and for fragmented responses the categories fc-protocol logs
 * (begin_header, begin_without_credit, begin_size, begin_unknown_id,
 * empty_fragment, fragment_without_begin, fragment_length, credit_payload,
 * duplicate_response). The streams' are fc-protocol's too: stream_length,
 * data_empty, stream_direction, stream_id, abort_payload, credit_zero,
 * request_order, stream_unknown, stream_not_open, credit_overgrant,
 * window_overrun and unsolicited_response.
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

// ---- the kinds a connection takes -----------------------------------------

/** A freedom-cored connection: JSON and the fragment kinds. It never grants
 * streams, so 0x02–0x0F are refused. */
const CORE_KINDS = Object.freeze({ fragments: true, streams: null });

/** A service connection before its handshake has granted anything: whole
 * JSON messages only. */
const JSON_KINDS = Object.freeze({ fragments: false, streams: null });

/**
 * A service connection whose handshake granted `stream`, as `side` reads
 * it: JSON and the stream frames the other side sends. `receiver` (main)
 * takes data, end and abort; `sender` (the service) takes credit.
 */
function serviceKinds(side) {
  if (side !== 'receiver' && side !== 'sender') throw new TypeError(`unknown stream side ${side}`);
  return Object.freeze({ fragments: false, streams: side });
}

/** Whether `side` takes stream frames of `kind`. */
function takes(side, kind) {
  return side === 'receiver' ? kind !== KIND_STREAM_CREDIT : kind === KIND_STREAM_CREDIT;
}

/** A stream frame's payload length against its kind: the ID, then 1 to
 * 64 KiB of data, nothing, 1 to 1 KiB of abort JSON, or a u32. */
function checkStreamLength(kind, length) {
  if (length < ID_BYTES) throw new FrameError('stream_length');
  const after = length - ID_BYTES;
  if (kind === KIND_DATA) {
    if (after === 0) throw new FrameError('data_empty');
    if (after <= MAX_DATA) return;
  } else if (kind === KIND_END) {
    if (after === 0) return;
  } else if (kind === KIND_ABORT) {
    if (after >= 1 && after <= MAX_ABORT_JSON) return;
  } else if (kind === KIND_STREAM_CREDIT) {
    if (after === 4) return;
  }
  throw new FrameError('stream_length');
}

/** A header against what the connection takes: the kind; then, for a stream
 * frame, its length before its direction. */
function checkKind(kinds, kind, length) {
  if (kind === KIND_JSON) return;
  if (FRAGMENT_KINDS.has(kind) && kinds.fragments) return;
  if (STREAM_KINDS.has(kind) && kinds.streams) {
    checkStreamLength(kind, length);
    if (!takes(kinds.streams, kind)) throw new FrameError('stream_direction');
    return;
  }
  throw new FrameError('unknown_kind');
}

/** Whether `id` is a message ID: an integer from 1 to 2^53 - 1. */
function validId(id) {
  return Number.isSafeInteger(id) && id >= 1;
}

/** The 8-byte big-endian stream ID that starts `payload`, if it is a
 * message ID. */
function readStreamId(payload) {
  const high = payload.readUInt32BE(0);
  const id = high * 2 ** 32 + payload.readUInt32BE(4);
  // Above 2^53 - 1 the high word alone tells: 2^21 or more.
  if (high >= 2 ** 21 || id < 1) throw new FrameError('stream_id');
  return id;
}

// An abort's JSON, read as fc-protocol's serde reads it: an object with
// exactly `code`, one of the abort codes, and `message`, each a JSON string,
// once; JSON's whitespace between tokens and nothing after. JSON.parse would
// take a duplicate member (keeping the last), an extra one, or a lone
// surrogate's escape, which serde refuses.
const JSON_WS = new Set([' ', '\t', '\n', '\r']);
const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

function parseAbortJson(bytes) {
  const refuse = () => {
    throw new FrameError('abort_payload');
  };
  let text;
  try {
    text = UTF8.decode(bytes);
  } catch {
    return refuse();
  }
  let at = 0;
  const space = () => {
    while (at < text.length && JSON_WS.has(text[at])) at += 1;
  };
  const hex4 = () => {
    const digits = text.slice(at, at + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(digits)) refuse();
    at += 4;
    return parseInt(digits, 16);
  };
  const string = () => {
    if (text[at] !== '"') refuse();
    at += 1;
    let out = '';
    for (;;) {
      if (at >= text.length) refuse();
      const c = text[at];
      if (c === '"') {
        at += 1;
        return out;
      }
      if (c < ' ') refuse();
      if (c !== '\\') {
        out += c;
        at += 1;
        continue;
      }
      const e = text[at + 1];
      at += 2;
      if (e === 'u') {
        const unit = hex4();
        if (unit >= 0xdc00 && unit <= 0xdfff) refuse();
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (text[at] !== '\\' || text[at + 1] !== 'u') refuse();
          at += 2;
          const low = hex4();
          if (low < 0xdc00 || low > 0xdfff) refuse();
          out += String.fromCharCode(unit, low);
        } else {
          out += String.fromCharCode(unit);
        }
      } else if (Object.hasOwn(ESCAPES, e)) {
        out += ESCAPES[e];
      } else {
        refuse();
      }
    }
  };
  const members = new Map();
  space();
  if (text[at] !== '{') refuse();
  at += 1;
  for (;;) {
    space();
    const name = string();
    space();
    if (text[at] !== ':') refuse();
    at += 1;
    space();
    if ((name !== 'code' && name !== 'message') || members.has(name)) refuse();
    members.set(name, string());
    space();
    if (text[at] === ',') {
      at += 1;
      continue;
    }
    if (text[at] !== '}') refuse();
    at += 1;
    break;
  }
  space();
  if (at !== text.length || members.size !== 2 || !ABORT_CODES.has(members.get('code'))) {
    refuse();
  }
  return { code: members.get('code'), message: members.get('message') };
}

/**
 * A stream frame's payload, decoded: `{ kind, id }`, with `bytes` (a view)
 * for data, `code` and `message` for an abort, and `credit` for credit.
 * The length was checked at the header.
 */
function decodeStreamFrame(kind, payload) {
  checkStreamLength(kind, payload.length);
  const id = readStreamId(payload);
  const rest = payload.subarray(ID_BYTES);
  switch (kind) {
    case KIND_DATA:
      return { kind, id, bytes: rest };
    case KIND_END:
      return { kind, id };
    case KIND_ABORT:
      return { kind, id, ...parseAbortJson(rest) };
    default: {
      const credit = rest.readUInt32BE(0);
      if (credit === 0) throw new FrameError('credit_zero');
      return { kind, id, credit };
    }
  }
}

// ---- stream frame encoders --------------------------------------------------

/** A stream frame's 13-byte start: the length of what follows it, the kind
 * and the ID. */
function streamHeader(kind, id, after) {
  if (!validId(id)) throw new FrameError('stream_id');
  const header = Buffer.alloc(5 + ID_BYTES);
  header.writeUInt32BE(1 + ID_BYTES + after, 0);
  header[4] = kind;
  header.writeUInt32BE(Math.floor(id / 2 ** 32), 5);
  header.writeUInt32BE(id % 2 ** 32, 9);
  return header;
}

/** A data frame: `bytes`, 1 to 64 KiB of stream `id`'s body. */
function encodeData(id, bytes) {
  const header = streamHeader(KIND_DATA, id, bytes.length);
  checkStreamLength(KIND_DATA, ID_BYTES + bytes.length);
  return Buffer.concat([header, bytes]);
}

/** Stream `id`'s end frame. */
function encodeEnd(id) {
  return streamHeader(KIND_END, id, 0);
}

/**
 * Stream `id`'s abort frame: `{"code":…,"message":…}`, at most 1 KiB. The
 * message must be well-formed UTF-16: JSON.stringify writes a lone
 * surrogate as its escape, which serde and this decoder refuse, so such a
 * message is refused here, before anything is written.
 */
function encodeAbort(id, code, message) {
  if (!ABORT_CODES.has(code) || typeof message !== 'string' || !message.isWellFormed()) {
    throw new FrameError('abort_payload');
  }
  const json = Buffer.from(JSON.stringify({ code, message }), 'utf8');
  const header = streamHeader(KIND_ABORT, id, json.length);
  checkStreamLength(KIND_ABORT, ID_BYTES + json.length);
  return Buffer.concat([header, json]);
}

/** A credit frame returning `bytes` (1 to 2^32 - 1) of stream `id`'s
 * window. */
function encodeStreamCredit(id, bytes) {
  const header = streamHeader(KIND_STREAM_CREDIT, id, 4);
  if (bytes === 0) throw new FrameError('credit_zero');
  if (!Number.isInteger(bytes) || bytes < 0 || bytes > MAX_U32) {
    throw new RangeError('a credit is a u32');
  }
  const frame = Buffer.alloc(header.length + 4);
  header.copy(frame);
  frame.writeUInt32BE(bytes, header.length);
  return frame;
}

/**
 * Turns a byte stream into frames: `{ kind: KIND_JSON, message }` for a whole
 * message, parsed, `{ kind, payload }` for the fragment kinds, and a stream
 * frame decoded (`decodeStreamFrame`). It takes the kinds its connection
 * granted (`CORE_KINDS` by default), checked at each header. After the
 * first error it stays failed: a corrupted stream can't be resynchronized.
 *
 * Input is kept as the list of chunks it came in, never joined as a whole: a
 * frame within one chunk is a view of it, and one across chunks is copied
 * once. So each byte is copied at most once, however the stream is cut.
 */
class FrameDecoder {
  /** @param {object} [options] - `kinds`: what the connection takes */
  constructor({ kinds = CORE_KINDS } = {}) {
    this.kinds = kinds;
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
        try {
          // Before any of the payload is read.
          checkKind(this.kinds, kind, length - 1);
        } catch (err) {
          return this.fail(err.category);
        }
        this.frame = { kind, length: length - 1 };
      }
      if (this.buffered < this.frame.length) break;
      const { kind, length } = this.frame;
      this.frame = null;
      const payload = this.take(length);
      try {
        if (kind === KIND_JSON) frames.push({ kind, message: decodeJson(payload) });
        else if (STREAM_KINDS.has(kind)) frames.push(decodeStreamFrame(kind, payload));
        else frames.push({ kind, payload });
      } catch (err) {
        return this.fail(err.category);
      }
    }
    return frames;
  }

  /**
   * Takes the kinds a handshake granted, from the next frame on. The
   * frames already decoded were checked against the kinds before.
   */
  setKinds(kinds) {
    this.kinds = kinds;
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

// ---- main's side of the streams ---------------------------------------------

/** A stream's bytes in main: one buffer of exactly the window. */
class Ring {
  constructor() {
    this.buffer = Buffer.alloc(WINDOW);
    this.start = 0;
    this.length = 0;
  }

  /** Copies `bytes` in, if they fit. */
  push(bytes) {
    const cap = this.buffer.length;
    if (bytes.length > cap - this.length) return false;
    const tail = (this.start + this.length) % cap;
    const first = Math.min(bytes.length, cap - tail);
    bytes.copy(this.buffer, tail, 0, first);
    bytes.copy(this.buffer, 0, first);
    this.length += bytes.length;
    return true;
  }

  /** Copies up to `n` bytes out, into a chunk of exactly their size. */
  pull(n) {
    const cap = this.buffer.length;
    const count = Math.min(n, this.length);
    // Memory of its own, not a slice of a shared pool: the consumer may
    // keep it.
    const chunk = Buffer.allocUnsafeSlow(count);
    const first = Math.min(count, cap - this.start);
    this.buffer.copy(chunk, 0, this.start, this.start + first);
    this.buffer.copy(chunk, first, 0, count - first);
    this.start = (this.start + count) % cap;
    this.length -= count;
    return chunk;
  }
}

/**
 * Main's side of every stream on one service connection, for one
 * generation (design 0007, Frames and Main's side), as fc-protocol's
 * `stream::Receiver`.
 *
 * **What it holds, per request** main has sent and not yet seen end:
 * pending, until its reply (a head with a body opens its stream; any other
 * reply ends it); an open stream, with its account (`received`,
 * `returned`), whether `end` arrived, and its ring; after a local cancel, a
 * retirement record until the terminal frame or the reply, data for it
 * dropped as it is read.
 *
 * **The ring:** one buffer of exactly the window (128 KiB) per stream,
 * allocated at its first data. Every data frame is copied into it, so what
 * main holds never depends on frame sizes. `end` only records EOF: the ring
 * goes once the consumer has drained it, and at once on `abort` or a local
 * cancel. A pull copies up to 64 KiB into a chunk the consumer owns, and
 * credits those bytes, unless `end` has arrived.
 *
 * **Checks**, each a protocol error (a FrameError; the connection is to be
 * closed, and every later call reports it): data beyond the window
 * (`received - returned > 128 KiB`), a frame for a stream that isn't open,
 * a frame for an ID above the highest request sent, credit from the
 * service, a reply that isn't pending. Main's own request IDs must
 * increase (`request_order`).
 */
class StreamReceiver {
  constructor() {
    this.highest = 0;
    this.entries = new Map(); // id -> { state, ring, received, returned, eof }
    this.failed = null;
  }

  /** Main sent request `id`. */
  request(id) {
    this.alive();
    if (!validId(id)) throw new FrameError('stream_id');
    if (id <= this.highest) throw new FrameError('request_order');
    this.highest = id;
    this.entries.set(id, { state: 'pending' });
  }

  /**
   * The reply to request `id` arrived; `opens` if it is a head that says
   * `body: true`. Returns `deliver` (hand it to the caller; with a body,
   * the stream is open) or `retired` (drop it; with a body, the stream
   * retires until its terminal).
   */
  reply(id, opens) {
    this.alive();
    const entry = this.entries.get(id);
    if (entry?.state === 'pending') {
      if (opens) {
        this.entries.set(id, { state: 'open', ring: null, received: 0, returned: 0, eof: false });
      } else {
        this.entries.delete(id);
      }
      return 'deliver';
    }
    if (entry?.state === 'retired_pending') {
      if (opens) this.entries.set(id, { state: 'retiring' });
      else this.entries.delete(id);
      return 'retired';
    }
    return this.fail('unsolicited_response');
  }

  /**
   * A stream frame from the service, as `FrameDecoder` decodes it. Returns
   * `{ type: 'data', id, length }`, `{ type: 'end', id, drained }` (drained:
   * nothing is left to pull, and its record is gone), `{ type: 'abort', id,
   * code, message }` (error the body; its record is gone) or `{ type:
   * 'dropped', id }` for a retiring stream.
   */
  receive(frame) {
    this.alive();
    const { kind, id } = frame;
    if (kind === KIND_STREAM_CREDIT) return this.fail('stream_direction');
    if (kind === KIND_DATA) {
      try {
        checkStreamLength(KIND_DATA, ID_BYTES + frame.bytes.length);
      } catch (err) {
        return this.fail(err.category);
      }
    }
    if (id > this.highest) return this.fail('stream_unknown');
    const entry = this.entries.get(id);
    if (entry?.state === 'retiring') {
      if (kind !== KIND_DATA) this.entries.delete(id);
      return { type: 'dropped', id };
    }
    if (entry?.state !== 'open' || entry.eof) return this.fail('stream_not_open');
    if (kind === KIND_DATA) {
      const received = entry.received + frame.bytes.length;
      if (received - entry.returned > WINDOW) return this.fail('window_overrun');
      entry.ring ??= new Ring();
      if (!entry.ring.push(frame.bytes)) return this.fail('window_overrun');
      entry.received = received;
      return { type: 'data', id, length: frame.bytes.length };
    }
    if (kind === KIND_END) {
      entry.eof = true;
      const drained = (entry.ring?.length ?? 0) === 0;
      if (drained) this.entries.delete(id);
      return { type: 'end', id, drained };
    }
    this.entries.delete(id);
    return { type: 'abort', id, code: frame.code, message: frame.message };
  }

  /**
   * The consumer of stream `id` pulls up to `max` bytes (at most 64 KiB):
   * `{ chunk, credit, eof }`, where `credit` is the bytes to return to the
   * service (null once `end` has arrived) and `eof` says the chunk is the
   * body's last, its record gone. Null if the stream has no record.
   */
  pull(id, max) {
    const entry = this.entries.get(id);
    if (entry?.state !== 'open') return null;
    const count = Math.min(max, MAX_PULL, entry.ring?.length ?? 0);
    const chunk = entry.ring ? entry.ring.pull(count) : Buffer.alloc(0);
    let credit = null;
    if (count > 0 && !entry.eof) {
      entry.returned += count;
      credit = count;
    }
    const eof = entry.eof && (entry.ring?.length ?? 0) === 0;
    if (eof) this.entries.delete(id);
    return { chunk, credit, eof };
  }

  /**
   * A local cancel of request `id`: `send_cancel` (send `cancel`, and no
   * more credit: it retires), `freed` (its end had arrived: its bytes are
   * dropped and nothing is sent) or `nothing`.
   */
  cancel(id) {
    const entry = this.entries.get(id);
    if (entry?.state === 'pending') {
      this.entries.set(id, { state: 'retired_pending' });
      return 'send_cancel';
    }
    if (entry?.state === 'open') {
      if (entry.eof) {
        this.entries.delete(id);
        return 'freed';
      }
      this.entries.set(id, { state: 'retiring' });
      return 'send_cancel';
    }
    return 'nothing';
  }

  /** Request `id`'s record, or null: `{ state, ring, buffered, received,
   * returned }`, state one of pending, retired_pending, open, eof,
   * retiring. */
  info(id) {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.state !== 'open') {
      return { state: entry.state, ring: false, buffered: 0, received: 0, returned: 0 };
    }
    return {
      state: entry.eof ? 'eof' : 'open',
      ring: entry.ring !== null,
      buffered: entry.ring?.length ?? 0,
      received: entry.received,
      returned: entry.returned,
    };
  }

  /** Requests with a record, retiring ones included: they count against
   * main's outstanding requests. */
  outstanding() {
    return this.entries.size;
  }

  /** The bytes main's rings take, in all. */
  ringBytes() {
    let bytes = 0;
    for (const entry of this.entries.values()) bytes += entry.ring?.buffer.length ?? 0;
    return bytes;
  }

  alive() {
    if (this.failed) throw this.failed;
  }

  /** Fails the connection: every record and ring goes. */
  fail(category) {
    this.failed = new FrameError(category);
    this.entries.clear();
    throw this.failed;
  }
}

/**
 * What main writes for its streams (design 0007, Main's side): credit and
 * cancels. Credit not yet written merges per stream, and a local cancel
 * drops its stream's, so the queue holds at most one credit and one cancel
 * per live stream. Entries come out in the order they were made.
 */
class StreamOutbox {
  constructor() {
    this.entries = new Map(); // `credit:<id>` -> { id, credit } | `cancel:<id>` -> { id }
  }

  /** Returns `bytes` of stream `id`'s window, merged with any not yet
   * written. */
  credit(id, bytes) {
    if (!validId(id)) throw new FrameError('stream_id');
    if (!Number.isSafeInteger(bytes) || bytes < 1) throw new FrameError('credit_zero');
    const entry = this.entries.get(`credit:${id}`);
    if (entry) entry.credit += bytes;
    else this.entries.set(`credit:${id}`, { id, credit: bytes });
  }

  /** Main's cancel of request `id`: its unwritten credit goes. */
  cancel(id) {
    if (!validId(id)) throw new FrameError('stream_id');
    this.entries.delete(`credit:${id}`);
    if (!this.entries.has(`cancel:${id}`)) this.entries.set(`cancel:${id}`, { id });
  }

  /** The next frame to write, or null. */
  next() {
    const first = this.entries.entries().next();
    if (first.done) return null;
    const [key, entry] = first.value;
    if (key.startsWith('cancel:')) {
      this.entries.delete(key);
      return encodeFrame({ type: 'cancel', id: entry.id });
    }
    // A merged credit past a u32 goes in several frames.
    const bytes = Math.min(entry.credit, MAX_U32);
    entry.credit -= bytes;
    if (entry.credit === 0) this.entries.delete(key);
    return encodeStreamCredit(entry.id, bytes);
  }

  /** Entries waiting. */
  get size() {
    return this.entries.size;
  }
}

module.exports = {
  encodeAbort,
  encodeBegin,
  encodeCredit,
  encodeData,
  encodeEnd,
  encodeFrame,
  encodeJsonFrame,
  encodeStreamCredit,
  frameHeader,
  serviceKinds,
  CORE_KINDS,
  JSON_KINDS,
  FrameDecoder,
  FrameError,
  Reassembler,
  StreamOutbox,
  StreamReceiver,
  ABORT_CODES,
  ID_BYTES,
  KIND_ABORT,
  KIND_BEGIN,
  KIND_CREDIT,
  KIND_DATA,
  KIND_END,
  KIND_FRAGMENT,
  KIND_JSON,
  KIND_LAST,
  KIND_STREAM_CREDIT,
  MAX_ABORT_JSON,
  MAX_DATA,
  MAX_ID,
  MAX_MESSAGE,
  MAX_PAYLOAD,
  MAX_PULL,
  WINDOW,
};
