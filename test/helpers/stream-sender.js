/**
 * The service's side of design 0007's streams, in JS: a model of
 * fc-protocol's `stream::Sender`, for main's tests. It is what a scripted
 * fake service writes, and the sender the receiver's property test runs
 * against. `vectors/streams.json`'s `sender` cases hold it to the design,
 * as they hold the Rust one.
 *
 * - **Order.** The writer takes the control queue first (heads, replies,
 *   aborts and the replies to `cancel`), then the open streams
 *   round-robin, one frame each. Data only after its head; `end` only after
 *   its last byte; an abort purges and follows an unwritten head; nothing of
 *   a stream after its terminal.
 * - **Credit.** `sent` counts the body bytes queued, `credited` what main
 *   returned. A push queues at most `128 KiB - (sent - credited)`, and
 *   credit beyond `sent` is a protocol error. Nothing is refunded.
 * - **Coalescing.** A stream's queued bytes are one FIFO, cut into frames
 *   as large as the queue and 64 KiB allow. A push the writer's cap would
 *   cut below 4 KiB takes nothing.
 * - **Cancel.** Against a request still working, or whose head is unwritten,
 *   the head and body go and `cancelled` is the one reply; against an open
 *   stream, it purges and writes `abort { code: "cancelled" }`; otherwise it
 *   is late.
 * - **Bounds.** The writer holds at most its data cap (16 MiB by default)
 *   of queued bytes, in 4 KiB blocks freed as they are written.
 *
 * Producer refusals (`gone`, `unknown`, `answered`, `not_open`, `ended`,
 * `too_large`, `closed`) are returned as `{ refused }`; protocol errors are
 * thrown as FrameErrors, after which the sender stays failed.
 */

const {
  encodeAbort,
  encodeData,
  encodeEnd,
  frameHeader,
  FrameError,
  KIND_JSON,
  MAX_DATA,
  MAX_PAYLOAD,
  WINDOW,
} = require('../../src/main/core/frame');

const SMALL_FRAME = 4 * 1024;
const WRITER_DATA_CAP = 16 * 1024 * 1024;
const BLOCK = 4 * 1024;
const CANCELLED_MESSAGE = 'Cancelled';

/** A stream's queued bytes, in blocks of 4 KiB, each freed once read. */
class Fifo {
  constructor() {
    this.blocks = [];
    this.start = 0;
    this.length = 0;
  }

  /** The storage it takes. */
  capacity() {
    return this.blocks.length * BLOCK;
  }

  push(bytes) {
    let at = 0;
    while (at < bytes.length) {
      let last = this.blocks[this.blocks.length - 1];
      if (!last || last.used === BLOCK) {
        last = { buffer: Buffer.alloc(BLOCK), used: 0 };
        this.blocks.push(last);
      }
      const count = Math.min(bytes.length - at, BLOCK - last.used);
      bytes.copy(last.buffer, last.used, at, at + count);
      last.used += count;
      this.length += count;
      at += count;
    }
  }

  /** Takes up to `n` bytes from the front. */
  take(n) {
    const count = Math.min(n, this.length);
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    while (filled < count) {
      const block = this.blocks[0];
      const part = Math.min(count - filled, block.used - this.start);
      block.buffer.copy(out, filled, this.start, this.start + part);
      filled += part;
      this.start += part;
      this.length -= part;
      if (this.start === block.used && (block.used === BLOCK || this.length === 0)) {
        this.blocks.shift();
        this.start = 0;
      }
    }
    if (this.length === 0) {
      this.blocks = [];
      this.start = 0;
    }
    return out;
  }
}

function newBody() {
  return { queue: new Fifo(), sent: 0, credited: 0, end: false, abort: null, scheduled: false };
}

const room = (body) => Math.max(0, WINDOW - (body.sent - body.credited));
const writable = (body) => body.abort === null && (body.queue.length > 0 || body.end);

function purge(body) {
  const purged = body.queue.length;
  body.queue = new Fifo();
  body.end = false;
  return purged;
}

function jsonFrame(json) {
  return Buffer.concat([frameHeader(KIND_JSON, json.length), json]);
}

function cancelledReply(id) {
  return Buffer.from(
    `{"type":"response","id":${id},"error":{"code":"cancelled","message":"${CANCELLED_MESSAGE}"}}`
  );
}

const refused = (name) => ({ refused: name });

class StreamSender {
  /** @param {object} [options] - `dataCap`: the writer's cap (16 MiB) */
  constructor({ dataCap = WRITER_DATA_CAP } = {}) {
    this.dataCap = Math.max(dataCap, SMALL_FRAME);
    this.highest = 0;
    // id -> { state: working | head | open | reply, json?, body?, cancelled? }
    this.requests = new Map();
    this.control = []; // [entry, id]: head, reply or abort
    this.rotation = []; // ids
    this.held = 0;
    this.failed = null;
  }

  // ---- main's frames ----

  request(id) {
    this.alive();
    if (!Number.isSafeInteger(id) || id < 1) return this.fail('stream_id');
    if (id <= this.highest) return this.fail('request_order');
    this.highest = id;
    this.requests.set(id, { state: 'working' });
    return 'ok';
  }

  /** Main's cancel: `cancelled` or `late`. */
  cancel(id) {
    this.alive();
    const request = this.requests.get(id);
    if (!request) return 'late';
    if (request.state === 'working' || request.state === 'head') {
      if (request.state === 'head' && request.body) this.held -= purge(request.body);
      this.requests.set(id, { state: 'reply', json: cancelledReply(id), cancelled: true });
      this.control.push(['reply', id]);
      return 'cancelled';
    }
    if (request.state === 'open' && request.body.abort === null) {
      this.held -= purge(request.body);
      this.unschedule(request.body, id);
      request.body.abort = { code: 'cancelled', message: CANCELLED_MESSAGE };
      this.control.push(['abort', id]);
      return 'cancelled';
    }
    return 'late';
  }

  /** A stream frame from main, as `FrameDecoder` decodes it: `taken` or
   * `late`. */
  receive(frame) {
    this.alive();
    if (frame.credit === undefined) return this.fail('stream_direction');
    const { id, credit } = frame;
    if (credit === 0) return this.fail('credit_zero');
    if (id > this.highest) return this.fail('stream_unknown');
    const request = this.requests.get(id);
    if (!request) return 'late';
    const body = request.state === 'head' || request.state === 'open' ? request.body : null;
    if (!body || body.credited + credit > body.sent) return this.fail('credit_overgrant');
    body.credited += credit;
    return 'taken';
  }

  // ---- the producers ----

  head(id, json, hasBody) {
    if (this.failed) return refused('closed');
    if (json.length > MAX_PAYLOAD) return refused('too_large');
    return this.answer(id, { state: 'head', json, body: hasBody ? newBody() : null }, 'head');
  }

  reply(id, json) {
    if (this.failed) return refused('closed');
    if (json.length > MAX_PAYLOAD) return refused('too_large');
    return this.answer(id, { state: 'reply', json, cancelled: false }, 'reply');
  }

  answer(id, next, entry) {
    const request = this.requests.get(id);
    if (request?.state === 'working') {
      this.requests.set(id, next);
      this.control.push([entry, id]);
      return 'ok';
    }
    if (request?.state === 'reply' && request.cancelled) return refused('gone');
    if (request) return refused('answered');
    return refused(this.absent(id));
  }

  /** Queues as much of `bytes` as the window and the writer's cap allow:
   * `{ taken }`. */
  push(id, bytes) {
    if (this.failed) return refused('closed');
    const found = this.bodyOf(id);
    if (found.refused) return found;
    const { body, open } = found;
    const capRoom = Math.max(0, this.dataCap - this.held);
    const wanted = Math.min(bytes.length, room(body));
    let n = Math.min(wanted, capRoom);
    if (n < wanted && n < SMALL_FRAME) n = 0;
    if (n === 0) return { taken: 0 };
    body.queue.push(bytes.subarray(0, n));
    body.sent += n;
    this.held += n;
    if (open && !body.scheduled) {
      body.scheduled = true;
      this.rotation.push(id);
    }
    return { taken: n };
  }

  finish(id) {
    if (this.failed) return refused('closed');
    const found = this.bodyOf(id);
    if (found.refused) return found;
    const { body, open } = found;
    body.end = true;
    if (open && !body.scheduled) {
      body.scheduled = true;
      this.rotation.push(id);
    }
    return 'ok';
  }

  abort(id, code, message = 'aborted') {
    if (this.failed) return refused('closed');
    const request = this.requests.get(id);
    if (!request) return refused(this.absent(id));
    if (request.state === 'reply' && request.cancelled) return refused('gone');
    if ((request.state !== 'head' && request.state !== 'open') || !request.body) {
      return refused('not_open');
    }
    const { body } = request;
    if (body.abort !== null) return refused('gone');
    this.held -= purge(body);
    this.unschedule(body, id);
    body.abort = { code, message };
    this.control.push(['abort', id]);
    return 'ok';
  }

  bodyOf(id) {
    const request = this.requests.get(id);
    let body;
    let open;
    if (request?.state === 'head' && request.body) {
      body = request.body;
      open = false;
    } else if (request?.state === 'open') {
      body = request.body;
      open = true;
    } else if (request?.state === 'reply' && request.cancelled) {
      return refused('gone');
    } else if (request) {
      return refused('not_open');
    } else {
      return refused(this.absent(id));
    }
    if (body.abort !== null) return refused('gone');
    if (body.end) return refused('ended');
    return { body, open };
  }

  // ---- the writer ----

  /**
   * The next frame to write, or null: `{ written, bytes }`, where
   * `written` is `{ type: head | reply | cancelled | data | end | abort,
   * id, length?, code? }`.
   */
  nextFrame() {
    if (this.failed) return null;
    while (this.control.length) {
      const [entry, id] = this.control.shift();
      const frame = this.writeControl(entry, id);
      if (frame) return frame;
    }
    while (this.rotation.length) {
      const frame = this.writeStream(this.rotation.shift());
      if (frame) return frame;
    }
    return null;
  }

  writeControl(entry, id) {
    const request = this.requests.get(id);
    if (!request) return null;
    if (entry === 'head' && request.state === 'head') {
      this.requests.delete(id);
      if (request.body) {
        if (writable(request.body)) {
          request.body.scheduled = true;
          this.rotation.push(id);
        }
        this.requests.set(id, { state: 'open', body: request.body });
      }
      return { written: { type: 'head', id }, bytes: jsonFrame(request.json) };
    }
    if (entry === 'reply' && request.state === 'reply') {
      this.requests.delete(id);
      return {
        written: { type: request.cancelled ? 'cancelled' : 'reply', id },
        bytes: jsonFrame(request.json),
      };
    }
    if (entry === 'abort' && request.state === 'open' && request.body.abort) {
      this.requests.delete(id);
      const { code, message } = request.body.abort;
      return { written: { type: 'abort', id, code }, bytes: encodeAbort(id, code, message) };
    }
    return null;
  }

  writeStream(id) {
    const request = this.requests.get(id);
    if (request?.state !== 'open') return null;
    const { body } = request;
    body.scheduled = false;
    if (body.abort !== null) return null;
    if (body.queue.length > 0) {
      const length = Math.min(body.queue.length, MAX_DATA);
      const bytes = encodeData(id, body.queue.take(length));
      this.held -= length;
      if (writable(body)) {
        body.scheduled = true;
        this.rotation.push(id);
      }
      return { written: { type: 'data', id, length }, bytes };
    }
    if (body.end) {
      this.requests.delete(id);
      return { written: { type: 'end', id }, bytes: encodeEnd(id) };
    }
    return null;
  }

  // ---- what it holds ----

  /** How much stream `id`'s producer may push now, or null without a body
   * that takes bytes. */
  room(id) {
    const request = this.requests.get(id);
    const body =
      (request?.state === 'head' || request?.state === 'open') && request.body
        ? request.body
        : null;
    if (!body || body.end || body.abort !== null) return null;
    return Math.min(room(body), Math.max(0, this.dataCap - this.held));
  }

  queued(id) {
    const request = this.requests.get(id);
    const body =
      (request?.state === 'head' || request?.state === 'open') && request.body
        ? request.body
        : null;
    return body ? body.queue.length : null;
  }

  isLive(id) {
    return this.requests.has(id);
  }

  live() {
    return this.requests.size;
  }

  heldCapacity() {
    let bytes = 0;
    for (const request of this.requests.values()) bytes += request.body?.queue.capacity() ?? 0;
    return bytes;
  }

  rotationEntries() {
    return this.rotation.length;
  }

  controlEntries() {
    return this.control.length;
  }

  unschedule(body, id) {
    if (!body.scheduled) return;
    this.rotation = this.rotation.filter((scheduled) => scheduled !== id);
    body.scheduled = false;
  }

  absent(id) {
    return id <= this.highest ? 'gone' : 'unknown';
  }

  alive() {
    if (this.failed) throw this.failed;
  }

  fail(category) {
    this.failed = new FrameError(category);
    this.requests.clear();
    this.control = [];
    this.rotation = [];
    this.held = 0;
    throw this.failed;
  }
}

module.exports = { StreamSender, SMALL_FRAME, WRITER_DATA_CAP };
