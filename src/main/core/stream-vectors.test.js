/**
 * Main's side of design 0007's streams against freedom-core's
 * `vectors/streams.json`: the cases fc-protocol's `stream` module passes,
 * every one written out by hand from the design (its generator is
 * `vectors/generator/streams.js`; the formats are in the file's `formats`).
 *
 * - `frames`: byte strings through `FrameDecoder`, as each side reads them
 *   (main, the service, and a freedom-cored connection), in any chunking;
 * - `encodings`: the stream frame encoders, byte for byte, and their
 *   refusals;
 * - `sender`: the service's side, through `test/helpers/stream-sender.js`,
 *   main's credit going through the codec as main writes it;
 * - `receiver`: main's side, through `StreamReceiver`, the service's frames
 *   through the codec.
 *
 * From freedom-core 0.9.0 the file also has a freedom-cored connection at
 * protocol 2 (design 0009, "Streams in the core"):
 * - `frames` cases read as `core_streams`: through `FrameDecoder` with
 *   `CORE_STREAM_KINDS`, the kinds main's decoder takes once the core's
 *   hello has settled protocol 2;
 * - `duplex`: the core's side of that connection, through frame.js's
 *   `StreamDuplex`, which is main's (see `Core` below for how the core's
 *   side maps onto it).
 *
 * **Which file.** The vectors aren't copied into this repository: the file
 * is read from a freedom-core checkout. 0009's fifth amendment (abort codes
 * by connection and direction, freedom-core #247) came after 0.9.1, so that
 * release's file (`cored-v0.9.1:vectors/streams.json`) predates it: its
 * `abort_codes` are 0007's five, and its duplex cases end main's pieces
 * with 0007's codes, which the amendment refuses. The test tells the two
 * apart by the amendment's `abort_code` category. Against 0.9.1's file it
 * runs every case as before and its `core_streams` frames, and lists its
 * duplex cases as to do; against later ones (from #247 on, cored-v0.12.2's
 * included), it runs every case.
 *
 * Skipped unless the vectors are found: FREEDOM_CORE_STREAM_VECTORS names
 * the file, or it sits beside FREEDOM_CORE_VECTORS, or in the freedom-core
 * checkout FREEDOM_CORED_PATH was built in. CI checks out freedom-core's at
 * a reviewed commit and names it; a file named there that is missing fails
 * the suite rather than skipping it.
 */

const fs = require('fs');
const path = require('path');
const {
  encodeAbort,
  encodeData,
  encodeEnd,
  encodeStreamCredit,
  serviceKinds,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  FrameError,
  StreamDuplex,
  StreamReceiver,
  ABORT_CODES,
  CORE_BODY_ABORT_CODES,
  PIECE_ABORT_CODES,
  SERVICE_ABORT_CODES,
  ID_BYTES,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_JSON,
  KIND_STREAM_CREDIT,
  MAX_ABORT_JSON,
  MAX_DATA,
  MAX_ID,
  MAX_PAYLOAD,
  MAX_PULL,
  WINDOW,
} = require('./frame');
const {
  StreamSender,
  SMALL_FRAME,
  WRITER_DATA_CAP,
} = require('../../../test/helpers/stream-sender');

function vectorsPath() {
  if (process.env.FREEDOM_CORE_STREAM_VECTORS) return process.env.FREEDOM_CORE_STREAM_VECTORS;
  if (process.env.FREEDOM_CORE_VECTORS) {
    return path.join(path.dirname(process.env.FREEDOM_CORE_VECTORS), 'streams.json');
  }
  const binary = process.env.FREEDOM_CORED_PATH;
  if (!binary) return null;
  for (let dir = path.dirname(path.resolve(binary)); ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'vectors', 'streams.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.dirname(dir) === dir) return null;
  }
}

const file = vectorsPath();
const vectors = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
const describeIfVectors = vectors ? describe : describe.skip;
// Named outright (CI does): they must be there.
const required = Boolean(process.env.FREEDOM_CORE_STREAM_VECTORS);

(required ? test : test.skip)('the vectors FREEDOM_CORE_STREAM_VECTORS names are there', () => {
  expect(fs.existsSync(file)).toBe(true);
  expect(vectors?.frames?.length).toBeGreaterThan(0);
});
/** Whether the file has 0009's abort codes by direction (freedom-core #247;
 * see the header). */
const ABORT_CODES_BY_DIRECTION = Boolean(vectors?.categories?.includes('abort_code'));

/** `[{ hex } | { fill: [byte, count] }, …]`, concatenated. */
function bytesOf(parts) {
  return Buffer.concat(
    parts.map((part) =>
      part.hex !== undefined
        ? Buffer.from(part.hex, 'hex')
        : Buffer.alloc(part.fill[1], part.fill[0])
    )
  );
}

/** Byte `k` of stream `id`'s body (`formats.body_bytes`). */
function body(id, offset, length) {
  const out = Buffer.allocUnsafe(length);
  const base = (id % 251) + (offset % 251);
  for (let i = 0; i < length; i++) out[i] = (base + i) % 251;
  return out;
}

const KINDS = {
  receiver: serviceKinds('receiver'),
  sender: serviceKinds('sender'),
  core: CORE_KINDS,
  core_streams: CORE_STREAM_KINDS,
};

/** A decoded frame as the vectors write it. */
function frameJson(frame) {
  switch (frame.kind) {
    case KIND_JSON:
      return ['json', JSON.stringify(frame.message)];
    case KIND_DATA:
      return ['data', frame.id, { hex: frame.bytes.toString('hex') }];
    case KIND_END:
      return ['end', frame.id];
    case KIND_ABORT:
      return ['abort', frame.id, frame.code, frame.message];
    case KIND_STREAM_CREDIT:
      return ['credit', frame.id, frame.credit];
    default:
      return ['kind', frame.kind];
  }
}

/** An expected frame with its parts as one hex part, and JSON text as
 * JSON.stringify writes it. */
function normalized(expected) {
  if (expected[0] === 'data') {
    return ['data', expected[1], { hex: bytesOf([expected[2]]).toString('hex') }];
  }
  if (expected[0] === 'json') return ['json', JSON.stringify(JSON.parse(expected[1]))];
  return expected;
}

/** Decodes `input` in `chunk`-sized pieces: the frames, then the first
 * error, or whether EOF would cut a frame. */
function decode(input, kinds, chunk) {
  const decoder = new FrameDecoder({ kinds });
  const frames = [];
  for (let at = 0; at < input.length; at += chunk) {
    try {
      for (const frame of decoder.push(input.subarray(at, at + chunk)))
        frames.push(frameJson(frame));
    } catch (err) {
      if (!(err instanceof FrameError)) throw err;
      return { frames, error: err.category, truncated: false };
    }
  }
  return { frames, error: null, truncated: !decoder.isAtBoundary() };
}

/** Runs `fn`; a FrameError becomes `{ error: category }`. */
function protocol(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof FrameError) return { error: err.category };
    throw err;
  }
}

/** One frame through a decoder for `side`. */
function decodeOne(bytes, side) {
  const decoder = new FrameDecoder({ kinds: KINDS[side] });
  const frames = decoder.push(bytes);
  expect(frames).toHaveLength(1);
  expect(decoder.isAtBoundary()).toBe(true);
  return frames[0];
}

const headJson = (id, hasBody) =>
  Buffer.from(
    `{"type":"response","id":${id},"result":{"status":200,"headers":[],"body":${hasBody}}}`
  );
const replyJson = (id) =>
  Buffer.from(`{"type":"response","id":${id},"error":{"code":"busy","message":"busy"}}`);

/** The service, played against a StreamSender: its producers offer the
 * body bytes of `formats.body_bytes`, and every frame it writes is decoded
 * as main decodes it. `link` is what main's requests, cancels and credit
 * go through (the sender itself, or the StreamDuplex it is part of), and
 * `side` the decoder the other side reads with. */
class Service {
  constructor({ dataCap = WRITER_DATA_CAP, sender = null, link = null, side = 'receiver' } = {}) {
    this.sender = sender ?? new StreamSender({ dataCap });
    this.link = link ?? this.sender;
    this.side = side;
    this.offered = new Map();
    this.written = new Map();
    this.heads = new Map();
    this.replies = new Map();
  }

  /** Main's credit frame, through the codec as main sends it, and the
   * decoder of the side that takes it. */
  credit(id, n) {
    const frame = decodeOne(
      encodeStreamCredit(id, n),
      this.side === 'receiver' ? 'sender' : this.side
    );
    if (this.link === this.sender) return this.sender.receive(frame);
    return this.link.receive(frame).result;
  }

  act([action, id, arg]) {
    const s = this.sender;
    switch (action) {
      case 'request':
        return protocol(() => this.link.request(id));
      case 'cancel':
        return protocol(() => this.link.cancel(id));
      case 'credit':
        return protocol(() => this.credit(id, arg));
      case 'head': {
        const json = headJson(id, arg);
        const result = s.head(id, json, arg);
        if (result === 'ok') this.heads.set(id, json);
        return result;
      }
      case 'reply': {
        const json = replyJson(id);
        const result = s.reply(id, json);
        if (result === 'ok') this.replies.set(id, json);
        return result;
      }
      case 'push': {
        const offered = this.offered.get(id) ?? 0;
        const result = s.push(id, body(id, offered, arg));
        if (result.taken !== undefined) this.offered.set(id, offered + result.taken);
        return result;
      }
      case 'finish':
        return s.finish(id);
      case 'abort':
        return s.abort(id, arg, 'aborted');
      default:
        throw new Error(`action ${action}`);
    }
  }

  write(expected, at) {
    const next = this.sender.nextFrame();
    if (!next) throw new Error(`${at}: nothing written, expected ${JSON.stringify(expected)}`);
    this.wrote(next, expected, at);
  }

  /** One frame the sender wrote (`{ written, bytes }`), against `expected`. */
  wrote(next, expected, at) {
    const frame = decodeOne(next.bytes, this.side);
    const [type, id, a, b] = expected;
    expect([at, next.written.type, next.written.id]).toEqual([at, type, id]);
    switch (type) {
      case 'head':
        expect(Buffer.from(JSON.stringify(frame.message))).toEqual(this.heads.get(id));
        break;
      case 'reply':
        expect(Buffer.from(JSON.stringify(frame.message))).toEqual(this.replies.get(id));
        break;
      case 'cancelled':
        expect(frame.message).toMatchObject({ type: 'response', id, error: { code: 'cancelled' } });
        break;
      case 'data': {
        expect([at, next.written.length]).toEqual([at, b]);
        expect([at, this.written.get(id) ?? 0]).toEqual([at, a]);
        this.written.set(id, a + b);
        expect(frame.kind).toBe(KIND_DATA);
        expect(frame.bytes.equals(body(id, a, b))).toBe(true);
        break;
      }
      case 'end':
        expect(frame).toEqual({ kind: KIND_END, id });
        expect([at, this.written.get(id) ?? 0]).toEqual([at, this.offered.get(id) ?? 0]);
        break;
      case 'abort':
        expect([at, next.written.code, frame.code, frame.id]).toEqual([at, a, a, id]);
        break;
      default:
        throw new Error(`${at}: written ${type}`);
    }
  }

  check(check, at) {
    const s = this.sender;
    if (check.held !== undefined) expect([at, s.held]).toEqual([at, check.held]);
    for (const [key, want] of Object.entries(check.streams ?? {})) {
      const id = Number(key);
      const got = { live: s.isLive(id), room: s.room(id), queued: s.queued(id) };
      expect([at, id, got]).toEqual([at, id, want]);
    }
    // The storage follows the queued bytes: at most two blocks more each.
    expect(s.heldCapacity()).toBeLessThanOrEqual(s.held + s.live() * 8 * 1024);
  }
}

/** Main, played against a StreamReceiver: the service's frames go through
 * the codec, and the consumer checks every byte it pulls. */
class Main {
  constructor() {
    this.receiver = new StreamReceiver();
    this.sent = new Map();
    this.pulled = new Map();
  }

  feed(bytes) {
    return this.receiver.receive(decodeOne(bytes, 'receiver'));
  }

  delivered(delivery, id) {
    switch (delivery.type) {
      case 'data':
        return { data: delivery.length };
      case 'end':
        return delivery.drained ? 'end_drained' : 'end';
      case 'abort':
        return { abort: delivery.code };
      default:
        expect(delivery).toEqual({ type: 'dropped', id });
        return 'dropped';
    }
  }

  act([action, id, arg]) {
    const r = this.receiver;
    switch (action) {
      case 'request':
        return protocol(() => {
          r.request(id);
          return 'ok';
        });
      case 'reply':
        return protocol(() => r.reply(id, arg));
      case 'data': {
        const sent = this.sent.get(id) ?? 0;
        const bytes = body(id, sent, arg);
        this.sent.set(id, sent + arg);
        const got = protocol(() => this.delivered(this.feed(encodeData(id, bytes)), id));
        return got?.data === arg ? 'data' : got;
      }
      case 'end':
        return protocol(() => this.delivered(this.feed(encodeEnd(id)), id));
      case 'abort': {
        const got = protocol(() => this.delivered(this.feed(encodeAbort(id, arg, 'aborted')), id));
        return got?.abort === arg ? 'abort' : got;
      }
      case 'pull': {
        const pulled = r.pull(id, arg);
        if (!pulled) return null;
        const offset = this.pulled.get(id) ?? 0;
        expect(pulled.chunk.equals(body(id, offset, pulled.chunk.length))).toBe(true);
        // A chunk of its own: nothing else shares its memory.
        expect(pulled.chunk.buffer.byteLength).toBe(pulled.chunk.length);
        this.pulled.set(id, offset + pulled.chunk.length);
        if (pulled.credit !== null) {
          expect(pulled.credit).toBe(pulled.chunk.length);
          encodeStreamCredit(id, pulled.credit);
        }
        return { chunk: [offset, pulled.chunk.length], credit: pulled.credit, eof: pulled.eof };
      }
      case 'cancel':
        return r.cancel(id);
      default:
        throw new Error(`action ${action}`);
    }
  }

  check(check, at) {
    for (const [key, want] of Object.entries(check.streams)) {
      const id = Number(key);
      const info = this.receiver.info(id);
      if (want === null) {
        expect([at, id, info]).toEqual([at, id, null]);
        continue;
      }
      expect([at, id, info === null]).toEqual([at, id, false]);
      for (const [field, value] of Object.entries(want)) {
        expect([at, id, field, info[field]]).toEqual([at, id, field, value]);
      }
    }
    if (check.outstanding !== undefined) {
      expect([at, this.receiver.outstanding()]).toEqual([at, check.outstanding]);
    }
    expect(this.receiver.ringBytes() % WINDOW).toBe(0);
  }
}

/**
 * The core's side of its protocol-2 connection, as the `duplex` cases
 * write it, played against main's `StreamDuplex`. The connection is
 * symmetric (0009: a stream is the body of a response, sent by whichever
 * side answers the request), so the core's two sets of streams are main's
 * two with the roles named from the other end:
 * - the bodies the core sends, for main's requests (`request`, `cancel`,
 *   `credit`, and the producers' `head`, `reply`, `push`, `finish`,
 *   `abort`): main's StreamSender, through the duplex;
 * - the bodies the core receives, for its own requests (`ask`,
 *   `answered`, `data`, `end`, `aborted`, `release`, `drop`): main's
 *   StreamReceiver and outbox, through the duplex.
 *
 * The abort codes are the core's: the duplex is made with `sends:
 * CORE_BODY_ABORT_CODES` and `takes: PIECE_ABORT_CODES`. Main's own
 * connection has the two the other way round (core-client-streams.test.js).
 *
 * Where main differs from the core by design:
 * - **`release n`:** the core's consumer lets go of bytes it was handed;
 *   main's consumer pulls them from the stream's ring (0007's, which 0009
 *   keeps for main), and their credit is owed. A pull takes at most what
 *   the ring holds, so main can't let go of more than it holds: a release
 *   past the ring's bytes is the core's `overcredit` refusal, checked
 *   against the ring, and nothing is pulled.
 * - **`end`:** main's receiver says whether the ring was drained
 *   (`end_drained`) or still holds bytes to pull (`end`): both are the
 *   core's `end`.
 * - **`drop`:** main's cancel of its own request is a JSON `cancel` written
 *   through the same outbox, where the core writes its own elsewhere. A
 *   `write` step lists none, so the replay takes each in turn and checks it
 *   against the drops.
 */
class Core {
  constructor() {
    this.duplex = new StreamDuplex({ sends: CORE_BODY_ABORT_CODES, takes: PIECE_ABORT_CODES });
    this.service = new Service({
      sender: this.duplex.sender,
      link: this.duplex,
      side: 'core_streams',
    });
    this.sent = new Map(); // what the other side sent of the core's streams
    this.pulled = new Map();
    this.cancels = []; // drops whose cancel is still to be written
  }

  feed(bytes) {
    return this.duplex.receive(decodeOne(bytes, 'core_streams'));
  }

  arrived(delivery, id) {
    switch (delivery.type) {
      case 'data':
        return { data: delivery.length };
      case 'end':
        return 'end';
      case 'abort':
        return { abort: delivery.code };
      default:
        expect(delivery).toEqual({ type: 'dropped', id });
        return 'dropped';
    }
  }

  act(step) {
    const [action, id, arg] = step;
    const d = this.duplex;
    switch (action) {
      case 'ask':
        return protocol(() => {
          d.ask(id);
          return 'ok';
        });
      case 'answered':
        return protocol(() => d.answered(id, arg));
      case 'data': {
        const sent = this.sent.get(id) ?? 0;
        this.sent.set(id, sent + arg);
        const bytes = encodeData(id, body(id, sent, arg));
        const got = protocol(() => this.arrived(this.feed(bytes), id));
        return got?.data === arg ? 'data' : got;
      }
      case 'end':
        return protocol(() => this.arrived(this.feed(encodeEnd(id)), id));
      case 'aborted': {
        const got = protocol(() => this.arrived(this.feed(encodeAbort(id, arg, 'aborted')), id));
        return got?.abort === arg ? 'abort' : got;
      }
      case 'release':
        return this.release(id, arg);
      case 'drop': {
        const retire = d.withdraw(id);
        if (retire === 'send_cancel') this.cancels.push(id);
        return retire;
      }
      default:
        return this.service.act(step);
    }
  }

  /** The consumer of stream `id` lets go of `n` bytes: pulls them. */
  release(id, n) {
    const info = this.duplex.failed ? null : this.duplex.receiver.info(id);
    if (info?.state !== 'open' && info?.state !== 'eof') {
      // Failed, or no open stream: nothing to let go of, and nothing owed.
      expect(this.duplex.pull(id, n)).toBeNull();
      return 'ok';
    }
    if (n > info.buffered) return { refused: 'overcredit' };
    for (let taken = 0; taken < n;) {
      const pulled = this.duplex.pull(id, n - taken);
      const offset = this.pulled.get(id) ?? 0;
      expect(pulled.chunk.equals(body(id, offset, pulled.chunk.length))).toBe(true);
      this.pulled.set(id, offset + pulled.chunk.length);
      taken += pulled.chunk.length;
    }
    return 'ok';
  }

  /** The duplex's next frame but main's cancels, each checked against the
   * drop that made it. */
  next(at) {
    for (;;) {
      const next = this.duplex.nextFrame();
      if (next?.wrote.type !== 'cancel') return next;
      expect([at, next.wrote.id]).toEqual([at, this.cancels.shift()]);
      const { message } = decodeOne(next.bytes, 'core_streams');
      expect([at, message]).toEqual([at, { type: 'cancel', id: next.wrote.id }]);
    }
  }

  write(step, at) {
    for (const expected of step.write || step.write_some) {
      const next = this.next(at);
      if (!next) throw new Error(`${at}: nothing written, expected ${JSON.stringify(expected)}`);
      if (expected[0] !== 'credit') {
        this.service.wrote({ written: next.wrote, bytes: next.bytes }, expected, at);
        continue;
      }
      const [, id, credit] = expected;
      expect([at, next.wrote]).toEqual([at, { type: 'credit', id, credit }]);
      expect(decodeOne(next.bytes, 'core_streams')).toEqual({
        kind: KIND_STREAM_CREDIT,
        id,
        credit,
      });
    }
    if (step.write) expect([at, this.next(at)]).toEqual([at, null]);
  }

  check(check, at) {
    this.service.check(check, at);
    for (const [key, want] of Object.entries(check.inbound ?? {})) {
      const id = Number(key);
      const info = this.duplex.receiver.info(id);
      const got = info && { state: info.state, received: info.received, returned: info.returned };
      expect([at, id, got]).toEqual([at, id, want]);
    }
    if (check.owed !== undefined) expect([at, this.duplex.owed()]).toEqual([at, check.owed]);
  }
}

describeIfVectors("design 0007's stream vectors through main's frame.js", () => {
  test("the constants are the design's and frame.js's", () => {
    const c = vectors.constants;
    expect(c.kinds).toEqual({ json: 1, data: 2, end: 3, abort: 4, credit: 5 });
    expect([KIND_JSON, KIND_DATA, KIND_END, KIND_ABORT, KIND_STREAM_CREDIT]).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(c.id_bytes).toBe(ID_BYTES);
    expect(c.window).toBe(WINDOW);
    expect(c.max_data).toBe(MAX_DATA);
    expect(c.max_abort_json).toBe(MAX_ABORT_JSON);
    expect(c.max_pull).toBe(MAX_PULL);
    expect(c.small_frame).toBe(SMALL_FRAME);
    expect(c.writer_data_cap).toBe(WRITER_DATA_CAP);
    expect(c.max_payload).toBe(MAX_PAYLOAD);
    expect(c.max_id).toBe(MAX_ID);
    // Before #247 the file named 0007's five, the only ones then.
    const codes = ABORT_CODES_BY_DIRECTION ? ABORT_CODES : SERVICE_ABORT_CODES;
    expect([...codes]).toEqual(c.abort_codes);
    expect(c.cancelled_message).toBe('Cancelled');
  });

  describe('frames', () => {
    for (const entry of vectors?.frames || []) {
      test(`${entry.id} (${entry.side})`, () => {
        const input = bytesOf(entry.input);
        for (const chunk of [1, 2, 5, 9, 13, 4096, Math.max(1, input.length)]) {
          const got = decode(input, KINDS[entry.side], chunk);
          if (entry.expect.error !== undefined) {
            expect([chunk, got.error]).toEqual([chunk, entry.expect.error]);
            continue;
          }
          expect([chunk, got.error]).toEqual([chunk, null]);
          expect([chunk, got.frames]).toEqual([chunk, entry.expect.frames.map(normalized)]);
          expect([chunk, got.truncated]).toEqual([chunk, entry.expect.truncated ?? false]);
        }
      });
    }
  });

  describe('encodings', () => {
    for (const entry of vectors?.encodings || []) {
      test(entry.id, () => {
        const [kind, id, a, b] = entry.frame;
        const encode = {
          data: () => encodeData(id, bytesOf([a])),
          end: () => encodeEnd(id),
          abort: () => encodeAbort(id, a, b),
          credit: () => encodeStreamCredit(id, a),
        }[kind];
        const got = protocol(() => ({ hex: encode().toString('hex') }));
        expect(got).toEqual(
          entry.error !== undefined ? { error: entry.error } : { hex: entry.hex }
        );
      });
    }
  });

  describe("the service's side", () => {
    for (const entry of vectors?.sender || []) {
      test(entry.id, () => {
        const service = new Service({ dataCap: entry.config?.data_cap ?? WRITER_DATA_CAP });
        entry.steps.forEach((step, i) => {
          const at = `${entry.id} step ${i}`;
          if (step.write || step.write_some) {
            for (const frame of step.write || step.write_some) service.write(frame, at);
            if (step.write) expect([at, service.sender.nextFrame()]).toEqual([at, null]);
          } else if (step.check) {
            service.check(step.check, at);
          } else {
            for (let n = 0; n < (step.repeat ?? 1); n++) {
              expect([at, service.act(step.do)]).toEqual([at, step.expect]);
            }
          }
          const s = service.sender;
          expect(s.controlEntries()).toBeLessThanOrEqual(3 * s.live());
          expect(s.rotationEntries()).toBeLessThanOrEqual(s.live());
        });
      });
    }
  });

  describe("main's side", () => {
    for (const entry of vectors?.receiver || []) {
      test(entry.id, () => {
        const main = new Main();
        entry.steps.forEach((step, i) => {
          const at = `${entry.id} step ${i}`;
          if (step.check) {
            main.check(step.check, at);
            return;
          }
          for (let n = 0; n < (step.repeat ?? 1); n++) {
            expect([at, main.act(step.do)]).toEqual([at, step.expect]);
          }
          expect(main.receiver.ringBytes()).toBeLessThanOrEqual(
            main.receiver.outstanding() * WINDOW
          );
        });
      });
    }
  });

  describe("freedom-cored's connection at protocol 2 (duplex)", () => {
    for (const entry of vectors?.duplex || []) {
      if (!ABORT_CODES_BY_DIRECTION) {
        // See the header: these predate 0009's abort codes by direction.
        test.todo(`${entry.id} (before freedom-core #247)`);
        continue;
      }
      test(entry.id, () => {
        const core = new Core();
        entry.steps.forEach((step, i) => {
          const at = `${entry.id} step ${i}`;
          if (step.write || step.write_some) {
            core.write(step, at);
          } else if (step.check) {
            core.check(step.check, at);
          } else {
            for (let n = 0; n < (step.repeat ?? 1); n++) {
              expect([at, core.act(step.do)]).toEqual([at, step.expect]);
            }
          }
          const s = core.duplex.sender;
          expect(s.controlEntries()).toBeLessThanOrEqual(3 * s.live());
          expect(s.rotationEntries()).toBeLessThanOrEqual(s.live());
          expect(core.duplex.owed()).toBeLessThanOrEqual(core.duplex.receiver.outstanding());
        });
      });
    }
  });

  test('every category and refusal the file lists has a case', () => {
    const text = JSON.stringify(vectors);
    for (const category of vectors.categories) expect(text).toContain(`"error":"${category}"`);
    for (const refusal of vectors.refusals) {
      if (refusal !== 'too_large') expect(text).toContain(`"refused":"${refusal}"`);
    }
  });
});
