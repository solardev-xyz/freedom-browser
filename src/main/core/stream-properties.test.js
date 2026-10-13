/**
 * Property tests for main's side of design 0007's streams, in the style of
 * fc-protocol's `tests/stream_properties.rs`.
 *
 * **The pipe:** an honest service (`test/helpers/stream-sender.js`) and an
 * honest main (`StreamReceiver`, with `StreamOutbox` writing its credit and
 * cancels) joined by two byte pipes through the real codecs, under random
 * interleavings of producers, the service's writer, main's reader and
 * writer, consumers, local cancels, credit, and how the pipes cut the bytes.
 * Whatever the interleaving:
 * - no protocol error arises on either side;
 * - every request gets exactly one reply, and every stream at most one
 *   terminal, after its head;
 * - every byte a consumer pulls is the body's next byte, and a body that
 *   ends without a cancel or an abort is delivered whole;
 * - the bounds hold at every step: one ring of the window per stream in
 *   main, at most one credit and one cancel waiting per stream in main's
 *   outbox, the service's cap and storage, and every data frame either
 *   64 KiB or all that was queued;
 * - once everything runs freely, it settles, and both sides hold nothing.
 *
 * **The decoder:** random stream frames decode the same in any chunking, a
 * cut inside the last frame is a truncation, and random bytes only ever
 * fail it with a FrameError, which sticks.
 */

const assert = require('node:assert/strict');
const {
  encodeAbort,
  encodeData,
  encodeEnd,
  encodeFrame,
  serviceKinds,
  FrameDecoder,
  FrameError,
  StreamOutbox,
  StreamReceiver,
  KIND_JSON,
  KIND_STREAM_CREDIT,
  MAX_DATA,
  WINDOW,
} = require('./frame');
const { StreamSender, SMALL_FRAME } = require('../../../test/helpers/stream-sender');

/** mulberry32: the same pseudo-random cases on every run. */
class Rng {
  constructor(seed) {
    this.state = (seed * 0x9e3779b9) >>> 0 || 1;
  }

  next() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  below(n) {
    return this.next() % n;
  }

  chance(percent) {
    return this.below(100) < percent;
  }

  pick(list) {
    return list[this.below(list.length)];
  }
}

/** Byte `k` of stream `id`'s body. */
function body(id, offset, length) {
  const out = Buffer.allocUnsafe(length);
  const base = (id % 251) + (offset % 251);
  for (let i = 0; i < length; i++) out[i] = (base + i) % 251;
  return out;
}

/** A byte pipe: chunks in, any number of bytes out. */
class BytePipe {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }

  write(bytes) {
    if (!bytes.length) return;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  read(max) {
    const take = Math.min(max, this.length);
    const parts = [];
    let left = take;
    while (left > 0) {
      const chunk = this.chunks[0];
      if (chunk.length <= left) {
        parts.push(this.chunks.shift());
        left -= chunk.length;
      } else {
        parts.push(chunk.subarray(0, left));
        this.chunks[0] = chunk.subarray(left);
        left = 0;
      }
    }
    this.length -= take;
    return Buffer.concat(parts);
  }
}

const head = (id, hasBody) =>
  Buffer.from(
    `{"type":"response","id":${id},"result":{"status":200,"headers":[],"body":${hasBody}}}`
  );
const errorReply = (id) =>
  Buffer.from(`{"type":"response","id":${id},"error":{"code":"busy","message":"b"}}`);

class Pipe {
  constructor(seed) {
    const rng = new Rng(seed);
    this.rng = rng;
    this.dataCap = rng.pick([WINDOW, 3 * WINDOW, 16 * 1024 * 1024]);
    const count = 1 + rng.below(12);
    this.reqs = Array.from({ length: count }, (_, i) => {
      let answer;
      const roll = rng.below(10);
      if (roll === 0) answer = { kind: 'no_body' };
      else if (roll === 1) answer = { kind: 'error' };
      else {
        const length = [
          rng.below(10),
          rng.below(5000),
          rng.below(3 * WINDOW),
          rng.below(3 * WINDOW),
        ][rng.below(4)];
        answer = { kind: 'body', length, abortAt: rng.chance(15) ? rng.below(length + 1) : null };
      }
      return {
        // IDs increase, with gaps: main's other requests.
        id: 10 + 3 * i,
        answer,
        admitted: false,
        answered: false,
        pushed: 0,
        stopped: false,
        replies: 0,
        retired: false,
        pulled: 0,
        outcome: null,
      };
    });
    this.nextRequest = 0;
    this.sender = new StreamSender({ dataCap: this.dataCap });
    this.receiver = new StreamReceiver();
    this.outbox = new StreamOutbox();
    this.toService = new BytePipe();
    this.toMain = new BytePipe();
    this.serviceDecoder = new FrameDecoder({ kinds: serviceKinds('sender') });
    this.mainDecoder = new FrameDecoder({ kinds: serviceKinds('receiver') });
    this.cancels = true;
  }

  req(id) {
    return this.reqs.find((r) => r.id === id);
  }

  // ---- main ----

  /** Main sends its next request. */
  sendRequest() {
    const req = this.reqs[this.nextRequest];
    if (!req) return false;
    this.nextRequest += 1;
    this.receiver.request(req.id);
    this.toService.write(
      encodeFrame({
        type: 'request',
        id: req.id,
        method: 'ipfs.request',
        params: {},
        context: { caller: 'shell' },
      })
    );
    return true;
  }

  /** Main reads up to `max` bytes the service wrote. */
  mainReads(max) {
    const input = this.toMain.read(max);
    if (!input.length) return false;
    for (const frame of this.mainDecoder.push(input)) this.mainTakes(frame);
    return true;
  }

  mainTakes(frame) {
    if (frame.kind === KIND_JSON) {
      const { message } = frame;
      assert.equal(message.type, 'response');
      const opens = message.result?.body === true;
      const cancelled = message.error?.code === 'cancelled';
      const replied = this.receiver.reply(message.id, opens);
      const req = this.req(message.id);
      req.replies += 1;
      assert.equal(req.replies, 1);
      assert.equal(replied === 'retired', req.retired);
      // Only main's cancel makes a `cancelled` reply.
      assert.ok(!cancelled || req.retired);
      if (!opens) req.outcome = req.retired ? 'retired' : 'delivered';
      return;
    }
    const delivery = this.receiver.receive(frame);
    const req = this.req(delivery.id);
    if (delivery.type === 'end') {
      if (delivery.drained) this.complete(delivery.id);
    } else if (delivery.type === 'abort') {
      assert.ok(!req.retired);
      req.outcome = `aborted:${delivery.code}`;
    } else if (delivery.type === 'dropped') {
      assert.ok(req.retired);
      if (this.receiver.info(delivery.id) === null) req.outcome = 'retired';
    }
  }

  complete(id) {
    const req = this.req(id);
    assert.equal(req.answer.kind, 'body');
    assert.equal(req.pulled, req.answer.length);
    req.outcome = 'complete';
  }

  /** A consumer pulls from a random open stream; its credit goes to the
   * outbox. */
  consume(max) {
    const open = this.reqs
      .filter((r) => r.outcome === null && !r.retired)
      .filter((r) => (this.receiver.info(r.id)?.buffered ?? 0) > 0);
    if (!open.length) return false;
    const req = this.rng.pick(open);
    // Before end every byte pulled is credited back; after it, none is.
    const beforeEnd = this.receiver.info(req.id).state === 'open';
    const pulled = this.receiver.pull(req.id, max);
    assert.equal(pulled.credit, beforeEnd && pulled.chunk.length > 0 ? pulled.chunk.length : null);
    assert.ok(pulled.chunk.equals(body(req.id, req.pulled, pulled.chunk.length)));
    req.pulled += pulled.chunk.length;
    if (pulled.credit !== null) {
      assert.equal(pulled.credit, pulled.chunk.length);
      this.outbox.credit(req.id, pulled.credit);
    }
    if (pulled.eof) this.complete(req.id);
    return true;
  }

  /** Main cancels a random request it holds. */
  cancel() {
    const held = this.reqs.filter((r) => this.receiver.info(r.id) !== null && !r.retired);
    if (!held.length) return false;
    const req = this.rng.pick(held);
    const retire = this.receiver.cancel(req.id);
    if (retire === 'send_cancel') {
      req.retired = true;
      this.outbox.cancel(req.id);
    } else {
      assert.equal(retire, 'freed');
      req.retired = true;
      req.outcome = 'retired';
    }
    return true;
  }

  /** Main writes up to `frames` of its outbox. */
  mainWrites(frames) {
    let wrote = false;
    for (let i = 0; i < frames; i++) {
      const frame = this.outbox.next();
      if (!frame) break;
      this.toService.write(frame);
      wrote = true;
    }
    return wrote;
  }

  // ---- the service ----

  /** The service reads up to `max` bytes main wrote. */
  serviceReads(max) {
    const input = this.toService.read(max);
    if (!input.length) return false;
    for (const frame of this.serviceDecoder.push(input)) this.serviceTakes(frame);
    return true;
  }

  serviceTakes(frame) {
    if (frame.kind === KIND_STREAM_CREDIT) {
      assert.match(this.sender.receive(frame), /^(taken|late)$/);
      return;
    }
    const { message } = frame;
    if (message.type === 'request') {
      this.sender.request(message.id);
      this.req(message.id).admitted = true;
    } else {
      assert.equal(message.type, 'cancel');
      if (this.sender.cancel(message.id) === 'cancelled') this.req(message.id).stopped = true;
    }
  }

  ready() {
    return this.reqs.filter((r) => r.admitted && !r.stopped);
  }

  produce(max) {
    const ready = this.ready();
    if (!ready.length) return false;
    return this.produceOne(this.rng.pick(ready), max);
  }

  produceAll(max) {
    let moved = false;
    for (const req of this.ready()) moved = this.produceOne(req, max) || moved;
    return moved;
  }

  /** Request `req`'s producer does its next piece of work, if it can. */
  produceOne(req, max) {
    const { id, answer } = req;
    let result;
    if (!req.answered) {
      if (answer.kind === 'body') result = this.sender.head(id, head(id, true), true);
      else if (answer.kind === 'no_body') result = this.sender.head(id, head(id, false), false);
      else result = this.sender.reply(id, errorReply(id));
      if (result === 'ok') {
        req.answered = true;
        if (answer.kind !== 'body') req.stopped = true;
      }
    } else if (answer.abortAt !== null && req.pushed >= answer.abortAt) {
      result = this.sender.abort(id, 'internal', 'panic');
      if (result === 'ok') req.stopped = true;
    } else if (req.pushed < answer.length) {
      const end = Math.min(answer.length, req.pushed + 1 + this.rng.below(max));
      const bytes = body(id, req.pushed, end - req.pushed);
      const before = this.sender.room(id);
      result = this.sender.push(id, bytes);
      if (result.taken !== undefined) {
        // As much as the room allows, unless the writer's cap would cut it
        // below 4 KiB.
        const room = Math.min(before, bytes.length);
        const taken = result.taken;
        assert.equal(
          taken === room || (taken === 0 && room < SMALL_FRAME && room < bytes.length),
          true
        );
        req.pushed += taken;
        if (taken === 0) return false;
        result = 'ok';
      }
    } else {
      result = this.sender.finish(id);
      if (result === 'ok') req.stopped = true;
    }
    if (result === 'ok') return true;
    // A cancel settled it first.
    assert.deepEqual(result, { refused: 'gone' });
    req.stopped = true;
    return true;
  }

  /** The service writes up to `frames` frames. */
  write(frames) {
    let wrote = false;
    for (let i = 0; i < frames; i++) {
      const next = this.sender.nextFrame();
      if (!next) break;
      wrote = true;
      if (next.written.type === 'data') {
        // Coalescing: as large as the queue and 64 KiB allow.
        const { length } = next.written;
        assert.ok(length >= 1 && length <= MAX_DATA);
        assert.ok(length === MAX_DATA || this.sender.queued(next.written.id) === 0);
      }
      this.toMain.write(next.bytes);
    }
    return wrote;
  }

  // ---- both ----

  checkBounds() {
    const s = this.sender;
    assert.ok(s.held <= this.dataCap);
    assert.ok(s.heldCapacity() <= s.held + s.live() * 8 * 1024);
    assert.ok(s.controlEntries() <= 3 * s.live());
    assert.ok(s.rotationEntries() <= s.live());
    assert.ok(this.receiver.ringBytes() <= this.receiver.outstanding() * WINDOW);
    // At most one credit and one cancel waiting per request main sent.
    assert.ok(this.outbox.size <= 2 * this.nextRequest);
    for (const req of this.reqs) {
      const info = this.receiver.info(req.id);
      if (info) {
        assert.ok(info.buffered <= WINDOW);
        assert.ok(info.received - info.returned <= WINDOW);
      }
      const room = s.room(req.id);
      if (room !== null) assert.ok(room <= WINDOW);
    }
  }

  step() {
    const max = this.rng.pick([1, 100, 5000, 70_000, 1 << 20]);
    const roll = this.rng.below(18);
    if (roll === 0) this.sendRequest();
    else if (roll <= 3) this.produce(max);
    else if (roll <= 5) this.write(this.rng.below(6));
    else if (roll <= 8) this.mainReads(max);
    else if (roll <= 11) this.consume(max);
    else if (roll <= 14) this.serviceReads(max);
    else if (roll <= 16) this.mainWrites(this.rng.below(4));
    else if (this.cancels && this.rng.chance(20)) this.cancel();
    this.checkBounds();
  }

  /** Everything runs freely until nothing moves. */
  settle() {
    this.cancels = false;
    for (let round = 0; ; round++) {
      assert.ok(round < 100_000);
      let moved = this.sendRequest();
      moved = this.mainWrites(Infinity) || moved;
      moved = this.serviceReads(Infinity) || moved;
      moved = this.produceAll(1 << 20) || moved;
      moved = this.write(Infinity) || moved;
      moved = this.mainReads(Infinity) || moved;
      moved = this.consume(Infinity) || moved;
      this.checkBounds();
      if (!moved) break;
    }
    assert.ok(this.reqs.every((r) => r.stopped));
    assert.equal(this.sender.live(), 0);
    assert.equal(this.sender.held, 0);
    assert.equal(this.receiver.outstanding(), 0);
    assert.equal(this.outbox.size, 0);
    assert.equal(this.toMain.length + this.toService.length, 0);
    assert.ok(this.mainDecoder.isAtBoundary() && this.serviceDecoder.isAtBoundary());
    for (const req of this.reqs) {
      assert.deepEqual([req.id, req.replies], [req.id, 1]);
      assert.notEqual(req.outcome, null);
      if (req.retired) continue;
      const { kind, abortAt } = req.answer;
      if (kind === 'body' && abortAt === null) assert.equal(req.outcome, 'complete');
      else if (kind === 'body') assert.equal(req.outcome, 'aborted:internal');
      else assert.equal(req.outcome, 'delivered');
    }
  }
}

describe("design 0007's streams through main's receiver, against a service model", () => {
  test('honest peers through the pipe, with cancels', () => {
    for (let seed = 1; seed <= 64; seed++) {
      const pipe = new Pipe(seed);
      const steps = 200 + pipe.rng.below(2500);
      for (let i = 0; i < steps; i++) pipe.step();
      pipe.settle();
    }
  }, 120_000);

  test('honest peers without cancels deliver every body whole', () => {
    for (let seed = 1000; seed < 1024; seed++) {
      const pipe = new Pipe(seed);
      pipe.cancels = false;
      for (let i = 0; i < 1500; i++) pipe.step();
      pipe.settle();
      for (const req of pipe.reqs) expect(req.retired).toBe(false);
    }
  }, 120_000);
});

describe("main's stream decoder", () => {
  /** A random frame from the service. */
  function randomFrame(rng) {
    const id = 1 + rng.below(1 << 20);
    switch (rng.below(4)) {
      case 0: {
        const length = Math.min(rng.pick([1, 2, 4095, 4096, MAX_DATA]), 1 + rng.below(MAX_DATA));
        return encodeData(id, body(id, 0, length));
      }
      case 1:
        return encodeEnd(id);
      case 2:
        return encodeAbort(id, 'body_stream_error', 'x'.repeat(rng.below(900)));
      default:
        return encodeFrame({ type: 'response', id: 1, result: {} });
    }
  }

  /** Every frame, as kind and comparable fields, in random chunks. */
  function decodeAll(input, rng) {
    const decoder = new FrameDecoder({ kinds: serviceKinds('receiver') });
    const frames = [];
    for (let at = 0; at < input.length;) {
      const piece = input.subarray(at, at + 1 + rng.below(70_000));
      at += piece.length;
      for (const frame of decoder.push(piece)) {
        frames.push(JSON.stringify(frame, (key, value) => (key === 'bytes' ? undefined : value)));
        if (frame.bytes) frames.push(frame.bytes.toString('hex'));
      }
    }
    return decoder.isAtBoundary() ? frames : 'truncated';
  }

  test('any chunking decodes the same, and a cut inside the last frame is a truncation', () => {
    const rng = new Rng(7);
    for (let n = 0; n < 48; n++) {
      const stream = Buffer.concat(
        Array.from({ length: 1 + rng.below(30) }, () => randomFrame(rng))
      );
      const whole = decodeAll(stream, new Rng(1));
      expect(whole).not.toBe('truncated');
      for (let seed = 0; seed < 4; seed++) {
        expect(decodeAll(stream, new Rng(rng.next() ^ seed))).toEqual(whole);
      }
      const cut = stream.length - 1 - rng.below(4);
      expect(decodeAll(stream.subarray(0, cut), rng)).toBe('truncated');
    }
  });

  test('random bytes fail it only with a FrameError, and the first error sticks', () => {
    const rng = new Rng(11);
    for (let n = 0; n < 2000; n++) {
      const side = rng.pick(['receiver', 'sender']);
      const decoder = new FrameDecoder({ kinds: serviceKinds(side) });
      const length = rng.below(64);
      const input = Buffer.from(Array.from({ length }, () => rng.below(256)));
      // Mostly plausible headers: small lengths and stream kinds.
      if (length >= 5 && rng.chance(80)) {
        input.writeUInt32BE(rng.below(40), 0);
        input[4] = 2 + rng.below(4);
      }
      let failed = null;
      for (let at = 0; at < input.length;) {
        const piece = input.subarray(at, at + 1 + rng.below(8));
        at += piece.length;
        try {
          decoder.push(piece);
        } catch (err) {
          expect(err).toBeInstanceOf(FrameError);
          if (failed) expect(err).toBe(failed);
          failed = err;
        }
      }
      if (failed) expect(() => decoder.push(Buffer.from([0]))).toThrow(failed);
    }
  });
});
