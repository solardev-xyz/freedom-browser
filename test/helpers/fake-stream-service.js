/**
 * A scripted stream service, run as a real child process on stdio frames,
 * for ServiceClient's stream tests: the service side of design 0007's
 * streams is `stream-sender.js` (a model of fc-protocol's Sender), and this
 * script feeds it main's frames and writes what it writes, with stdout's
 * backpressure.
 *
 * Its handshake is `fake.hello` (protocol 1, `frames: ["stream"]`); its
 * shutdown `fake.shutdown`. Its methods:
 * - `fake.body { length, abort_at?, code? }`: a head with `body: true`, then
 *   the body (byte k of stream id is ((id mod 251) + (k mod 251)) mod 251),
 *   pushed as the window allows; with `abort_at`, aborted with `code` once
 *   that many bytes are queued;
 * - `fake.no_body`: a head with `body: false`;
 * - `fake.error`: the error reply `busy`;
 * - `fake.hang`: no answer, until main's cancel;
 * - `fake.stats`: what the service holds: its live requests, held bytes,
 *   each stream's sent and credited bytes, and the cancels it got;
 * - `fake.bad_frame`: writes data for a stream above every request, a
 *   protocol error for main;
 * - `fake.exit { code }`: exits at once.
 */

const {
  encodeData,
  serviceKinds,
  FrameDecoder,
  KIND_STREAM_CREDIT,
} = require('../../src/main/core/frame');
const { StreamSender } = require('./stream-sender');

const sender = new StreamSender();
const decoder = new FrameDecoder({ kinds: serviceKinds('sender') });
const producers = new Map(); // id -> { length, offered, abortAt, code }
const cancels = [];
let blocked = false;

const json = (value) => Buffer.from(JSON.stringify(value));
const result = (id, value) => json({ type: 'response', id, result: value });

function body(id, offset, length) {
  const out = Buffer.allocUnsafe(length);
  const base = (id % 251) + (offset % 251);
  for (let i = 0; i < length; i++) out[i] = (base + i) % 251;
  return out;
}

function fail(category) {
  process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'protocol error', category })}\n`);
  process.exit(70);
}

/** Each producer does what the window and the writer allow. */
function produce() {
  for (const [id, p] of producers) {
    for (;;) {
      if (p.abortAt !== null && p.offered >= p.abortAt) {
        sender.abort(id, p.code, 'scripted');
        producers.delete(id);
        break;
      }
      if (p.offered >= p.length) {
        sender.finish(id);
        producers.delete(id);
        break;
      }
      const limit = p.abortAt === null ? p.length : Math.min(p.length, p.abortAt);
      const want = Math.min(limit - p.offered, 64 * 1024);
      const pushed = sender.push(id, body(id, p.offered, want));
      if (pushed.refused) {
        // A cancel settled it.
        producers.delete(id);
        break;
      }
      p.offered += pushed.taken;
      if (pushed.taken < want) break;
    }
  }
}

/** Writes what the sender has, until stdout pushes back. */
function pump() {
  for (;;) {
    produce();
    if (blocked) return;
    const next = sender.nextFrame();
    if (!next) return;
    if (!process.stdout.write(next.bytes)) {
      blocked = true;
      process.stdout.once('drain', () => {
        blocked = false;
        pump();
      });
      return;
    }
  }
}

function onRequest({ id, method, params = {} }) {
  sender.request(id);
  switch (method) {
    case 'fake.hello':
      sender.reply(id, result(id, { protocol: 1, service_version: '0.0.0' }));
      break;
    case 'fake.shutdown':
      sender.reply(id, result(id, {}));
      break;
    case 'fake.body':
      sender.head(id, result(id, { status: 200, body: true }), true);
      producers.set(id, {
        length: params.length,
        offered: 0,
        abortAt: params.abort_at ?? null,
        code: params.code ?? 'internal',
      });
      break;
    case 'fake.no_body':
      sender.head(id, result(id, { status: 204, body: false }), false);
      break;
    case 'fake.error':
      sender.reply(id, json({ type: 'response', id, error: { code: 'busy', message: 'Busy' } }));
      break;
    case 'fake.hang':
      break;
    case 'fake.stats': {
      const streams = {};
      for (const [streamId, request] of sender.requests) {
        if (request.body) {
          streams[streamId] = { sent: request.body.sent, credited: request.body.credited };
        }
      }
      sender.reply(
        id,
        result(id, { live: sender.live() - 1, held: sender.held, streams, cancels })
      );
      break;
    }
    case 'fake.bad_frame':
      sender.reply(id, result(id, {}));
      pump();
      process.stdout.write(encodeData(id + 1000, Buffer.from([1, 2, 3])));
      return;
    case 'fake.exit':
      process.exit(params.code ?? 1);
      break;
    default:
      sender.reply(
        id,
        json({ type: 'response', id, error: { code: 'unknown_method', message: 'Unknown method' } })
      );
  }
}

process.stdin.on('data', (chunk) => {
  let frames;
  try {
    frames = decoder.push(chunk);
  } catch (err) {
    fail(err.category);
  }
  for (const frame of frames) {
    try {
      if (frame.kind === KIND_STREAM_CREDIT) {
        sender.receive(frame);
      } else if (frame.message.type === 'request') {
        onRequest(frame.message);
      } else if (frame.message.type === 'cancel') {
        cancels.push(frame.message.id);
        sender.cancel(frame.message.id);
      }
    } catch (err) {
      fail(err.category ?? 'script');
    }
  }
  pump();
});
process.stdin.on('end', () => process.exit(0));
