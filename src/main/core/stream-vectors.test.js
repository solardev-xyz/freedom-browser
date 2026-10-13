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
 * Skipped unless the vectors are found: FREEDOM_CORE_STREAM_VECTORS names
 * the file, or it sits beside FREEDOM_CORE_VECTORS, or in the freedom-core
 * checkout FREEDOM_CORED_PATH was built in.
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
  FrameDecoder,
  FrameError,
  StreamReceiver,
  ABORT_CODES,
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
  const decoder = new FrameDecoder({ kinds: serviceKinds(side) });
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
 * as main decodes it. */
class Service {
  constructor(dataCap) {
    this.sender = new StreamSender({ dataCap });
    this.offered = new Map();
    this.written = new Map();
    this.heads = new Map();
    this.replies = new Map();
  }

  act([action, id, arg]) {
    const s = this.sender;
    switch (action) {
      case 'request':
        return protocol(() => s.request(id));
      case 'cancel':
        return protocol(() => s.cancel(id));
      case 'credit':
        // Through the codec, as main sends it.
        return protocol(() => s.receive(decodeOne(encodeStreamCredit(id, arg), 'sender')));
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
    const frame = decodeOne(next.bytes, 'receiver');
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
    for (const [key, want] of Object.entries(check.streams)) {
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
    expect([...ABORT_CODES]).toEqual(c.abort_codes);
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
        const service = new Service(entry.config?.data_cap ?? WRITER_DATA_CAP);
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

  test('every category and refusal the file lists has a case', () => {
    const text = JSON.stringify(vectors);
    for (const category of vectors.categories) expect(text).toContain(`"error":"${category}"`);
    for (const refusal of vectors.refusals) {
      if (refusal !== 'too_large') expect(text).toContain(`"refused":"${refusal}"`);
    }
  });
});
