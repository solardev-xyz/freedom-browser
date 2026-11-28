/**
 * The client's Swarm plumbing (freedom-core design 0015, SWM-5's second
 * step), against a scripted core on a fake clock:
 * - the idle methods' watchdog (D13): a core silent past its bound on
 *   `swarm.body` is hung, killed and restarted; progress moves the
 *   deadline on, to the latest bound and never back; the response, or a
 *   body's terminal (not its head), ends it; nothing holds it; and an idle
 *   method without its idle form is refused in main, never sent;
 * - main's Swarm I/O pool: a handler registered with `{ pool }` charges
 *   that pool, held to its reply's last byte (a stream's terminal), never
 *   the chain I/O pool; and `{ pool }` on main's own request charges its
 *   fragmented response, twice as it arrives, dropping one that doesn't
 *   fit;
 * - the answers the core takes from a Swarm handler: `invalid_argument`
 *   with `data: { rule }`, `cancelled` at once for a cancel it races, and
 *   `{ failed: "error" }` for anything else, never `internal`.
 * Each case ends with the Swarm pool back at 0, and reads its high-water
 * mark.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const { REFUSAL_RULES } = require('./service-client');
const {
  CoreClient,
  JsonText,
  ShellError,
  StreamedReply,
  POOL_EXEMPT_BYTES,
  RESTART_DELAYS_MS,
} = require('./core-client');
const {
  encodeAbort,
  encodeBegin,
  encodeCredit,
  encodeData,
  encodeEnd,
  encodeFrame,
  encodeStreamCredit,
  frameHeader,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  Reassembler,
  KIND_ABORT,
  KIND_DATA,
  KIND_END,
  KIND_FRAGMENT,
  KIND_LAST,
  KIND_STREAM_CREDIT,
  SWARM_PART_ABORT_CODES,
  WINDOW,
} = require('./frame');
const { idleWatchdogMs, watchdogMs } = require('./core-deadlines');
const { SwarmIoPool } = require('./swarm-io-pool');

const tick = () => new Promise(setImmediate);
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};
const KIB = 1024;
const MIB = 1024 * KIB;
const STREAM_KINDS = new Set([KIND_DATA, KIND_END, KIND_ABORT, KIND_STREAM_CREDIT]);

/**
 * A scripted freedom-cored: `handler(message, core)` answers main's JSON
 * messages, main's fragmented replies once reassembled (its bulk credit
 * goes back after each). From its protocol-2 hello on it reads main's
 * stream frames too, into `streams`. `stuck` holds main's writes
 * unfinished until `release()`.
 */
class FakeCore extends EventEmitter {
  constructor(handler) {
    super();
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.streams = [];
    this.credits = 0; // the core's bulk credit, returned by main
    this.killed = null;
    this.stuck = false;
    this.held = [];
    this.outstanding = new Set(); // the core's own requests to main
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.reassembler = new Reassembler();
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
          if (STREAM_KINDS.has(frame.kind)) {
            this.streams.push(frame);
            continue;
          }
          const delivery = this.reassembler.push(frame, (id) => this.outstanding.has(id));
          if (delivery?.type === 'credit') this.credits += 1;
          if (delivery?.type !== 'message' && delivery?.type !== 'response') continue;
          const { message } = delivery;
          if (message?.type === 'response') this.outstanding.delete(message.id);
          this.messages.push(message);
          if (delivery.type === 'response') {
            this.reassembler.grant();
            this.stdout.write(encodeCredit());
          }
          handler(message, this);
        }
        if (this.stuck) this.held.push(callback);
        else callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0));
      },
    });
  }

  send(message) {
    if (message.type === 'request') this.outstanding.add(message.id);
    this.stdout.write(encodeFrame(message));
    if (message.type === 'response' && message.result?.protocol === 2) {
      this.decoder.setKinds(CORE_STREAM_KINDS);
    }
  }

  write(bytes) {
    this.stdout.write(bytes);
  }

  /** Completes every write `stuck` held back, and those after. */
  release() {
    this.stuck = false;
    for (const callback of this.held.splice(0)) callback();
  }

  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
    setImmediate(() => {
      this.stdout.end();
      this.emit('close', code, signal);
    });
  }

  kill(signal) {
    this.killed = signal;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  /** Main's replies to the core's requests. */
  replies() {
    return this.messages.filter((m) => m?.type === 'response');
  }

  /** Main's stream frames of `kind` for `id`. */
  framesOf(kind, id) {
    return this.streams.filter((frame) => frame.kind === kind && frame.id === id);
  }

  /** The bytes main sent in its data frames for `id`. */
  dataOf(id) {
    return Buffer.concat(this.framesOf(KIND_DATA, id).map((frame) => Buffer.from(frame.bytes)));
  }
}

/** Answers the hello at protocol 2 (fragments and streams) and shutdown,
 * and hands everything else to `extra`. */
function coreWith(extra = () => {}) {
  return (message, core) => {
    if (message.method === 'core.hello') {
      core.send({
        type: 'response',
        id: message.id,
        result: {
          protocol: 2,
          core_version: '0.32.0',
          capabilities: ['vault.status', 'fragments', 'streams'],
        },
      });
    } else if (message.method === 'core.shutdown') {
      core.send({ type: 'response', id: message.id, result: {} });
    } else {
      extra(message, core);
    }
  };
}

let children;
let client;
let log;
let clock;
let timers;

function makeClient(handler) {
  children = [];
  timers = [];
  clock = 0;
  log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  client = new CoreClient({
    spawn: jest.fn(() => {
      const child = new FakeCore(handler);
      children.push(child);
      return child;
    }),
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    shellVersion: 'test',
    grantRoot: os.tmpdir(),
    now: () => clock,
    setTimer: (fn, ms) => {
      const timer = { fn, at: clock + ms, cleared: false, fired: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
  });
  return client;
}

const core = () => children[children.length - 1];
const live = () => timers.filter((t) => !t.cleared && !t.fired);

/** Moves the clock on by `ms`, firing each timer due by then in turn. */
async function advance(ms) {
  const until = clock + ms;
  for (;;) {
    const [due] = live()
      .filter((t) => t.at <= until)
      .sort((a, b) => a.at - b.at);
    if (!due) break;
    clock = due.at;
    due.fired = true;
    due.fn();
    await settle();
  }
  clock = until;
  await settle();
}

afterEach(async () => {
  if (client && client.state !== 'stopped' && client.state !== 'failed') await client.stop();
  client = null;
});

/** `bytes` of body for stream `id`, in reads of at most 64 KiB, as a
 * stream that counts what was read and whether it was cancelled. */
function source(bytes) {
  const state = { read: 0, cancelled: false };
  state.stream = new ReadableStream(
    {
      pull(controller) {
        if (state.read >= bytes) {
          controller.close();
          return;
        }
        const n = Math.min(64 * KIB, bytes - state.read);
        controller.enqueue(new Uint8Array(n).fill(0x61));
        state.read += n;
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 }
  );
  return state;
}

/** Sends main's own request with `onSent` noted: `{ pending, sent }`. */
function sendOwn(send) {
  const out = { sent: null };
  out.pending = send((id, generation) => {
    out.sent = { id, generation };
  });
  return out;
}

const FAILED = () => ({ failed: 'error' });

describe("the idle Swarm methods' watchdog (design 0015, D13)", () => {
  test('a core silent for 75 s on swarm.body is hung: it is killed and restarted', async () => {
    makeClient(coreWith());
    await client.start();
    const body = client
      .callStream(
        'swarm.body',
        { for: 1 },
        { caller: 'shell' },
        { idleWatchdogMs: idleWatchdogMs('swarm.body') }
      )
      .catch((e) => e);
    await settle();
    expect(core().messages.map((m) => m.method)).toEqual(['core.hello', 'swarm.body']);
    await advance(74_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect(log.error).toHaveBeenCalledWith('[Core] request hung; restarting the core', {
      method: 'swarm.body',
    });
    expect((await body).code).toBe('core_unavailable');
    await advance(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
  });

  test("swarm.body: the core's head, data and main's credit are its progress, as is main's word for the part; its terminal ends it, not its head", async () => {
    makeClient(coreWith());
    await client.start();
    const call = sendOwn((onSent) =>
      client.callStream(
        'swarm.body',
        { for: 1 },
        { caller: 'shell' },
        { idleWatchdogMs: 75_000, onSent }
      )
    );
    await settle();
    const { id, generation } = call.sent;
    // The head at 60 s: due at 135 s.
    await advance(60_000);
    core().send({ type: 'response', id, result: { bytes: 6, body: true } });
    const { result, body } = await call.pending;
    expect(result).toEqual({ bytes: 6, body: true });
    await advance(74_999);
    expect(core().killed).toBeNull();
    // Its data at 134.999 s: due at 209.999 s.
    core().write(encodeData(id, Buffer.from('abc')));
    await advance(74_999);
    expect(core().killed).toBeNull();
    // Main reads it at 209.998 s, and its credit goes: due at 284.998 s.
    const reader = body.getReader();
    expect(Buffer.from((await reader.read()).value).toString()).toBe('abc');
    await settle();
    expect(
      core()
        .framesOf(KIND_STREAM_CREDIT, id)
        .map((f) => f.credit)
    ).toEqual([3]);
    await advance(74_999);
    expect(core().killed).toBeNull();
    // Progress the client can't see (the upload's part): due at 359.997 s.
    expect(client.watchdogProgress(generation, id, idleWatchdogMs('swarm.body'))).toBe(true);
    await advance(74_999);
    expect(core().killed).toBeNull();
    // The terminal ends it: nothing more moves or fires.
    core().write(encodeData(id, Buffer.from('def')));
    core().write(encodeEnd(id));
    await settle();
    expect(client.watchdogProgress(generation, id, 75_000)).toBe(false);
    expect(Buffer.from((await reader.read()).value).toString()).toBe('def');
    expect((await reader.read()).done).toBe(true);
    await advance(3_600_000);
    expect(core().killed).toBeNull();
    expect(client.current.idleWatchdogs.size).toBe(0);
  });

  test('swarm.body: an abort is its terminal too, and a body main withdrew runs on until it', async () => {
    makeClient(coreWith());
    await client.start();
    const first = sendOwn((onSent) =>
      client.callStream(
        'swarm.body',
        { for: 1 },
        { caller: 'shell' },
        { idleWatchdogMs: 75_000, onSent }
      )
    );
    const withdraw = new AbortController();
    const second = sendOwn((onSent) =>
      client
        .callStream(
          'swarm.body',
          { for: 2 },
          { caller: 'shell' },
          { idleWatchdogMs: 75_000, onSent, signal: withdraw.signal }
        )
        .catch((e) => e)
    );
    await settle();
    core().send({ type: 'response', id: first.sent.id, result: { bytes: 1, body: true } });
    core().send({ type: 'response', id: second.sent.id, result: { bytes: 1, body: true } });
    const { body } = await first.pending;
    const { body: withdrawn } = await second.pending;
    // Main withdraws the second: its body errors at once, main's cancel
    // goes, and the core still owes the terminal.
    withdraw.abort();
    await expect(withdrawn.getReader().read()).rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(core().messages.at(-1)).toEqual({ type: 'cancel', id: second.sent.id });
    // The core ends the first (its own cancel of the upload).
    core().write(encodeAbort(first.sent.id, 'cancelled', 'Cancelled'));
    await settle();
    await expect(body.getReader().read()).rejects.toMatchObject({ code: 'cancelled' });
    expect(client.current.idleWatchdogs.has(first.sent.id)).toBe(false);
    // The withdrawn one's frames still count, and its terminal ends it.
    await advance(70_000);
    core().write(encodeData(second.sent.id, Buffer.from('z')));
    await advance(70_000);
    expect(core().killed).toBeNull();
    core().write(encodeAbort(second.sent.id, 'cancelled', 'Cancelled'));
    await advance(3_600_000);
    expect(core().killed).toBeNull();
    expect(client.current.idleWatchdogs.size).toBe(0);
  });

  test('swarm.publish: progress moves its deadline to the latest bound, never back, and nothing holds it; its response ends it', async () => {
    makeClient(coreWith());
    await client.start();
    const publish = sendOwn((onSent) =>
      client.request(
        'swarm.publish',
        { kind: 'data', parts: [] },
        { caller: 'shell' },
        { idleWatchdogMs: idleWatchdogMs('swarm.publish'), onSent }
      )
    );
    await settle();
    const { id, generation } = publish.sent;
    // A whole `shell.swarm_api` call asked at 10 s: due at 325 s.
    await advance(10_000);
    const wholeCall = idleWatchdogMs('swarm.publish', 'whole_call');
    expect(client.watchdogProgress(generation, id, wholeCall)).toBe(true);
    // An ask at 20 s gives 95 s, which doesn't bring it back.
    await advance(10_000);
    client.watchdogProgress(generation, id, idleWatchdogMs('swarm.publish'));
    // Another process's number, or another ID, moves nothing.
    expect(client.watchdogProgress(generation + 1, id, wholeCall)).toBe(false);
    expect(client.watchdogProgress(generation, id + 1, wholeCall)).toBe(false);
    for (const odd of [0, -1, 1.5, NaN, '75000', null]) {
      expect(() => client.watchdogProgress(generation, id, odd)).toThrow(TypeError);
    }
    await advance(304_999);
    expect(core().killed).toBeNull();
    core().send({ type: 'response', id, result: { reference: 'ab' } });
    await expect(publish.pending).resolves.toEqual({ reference: 'ab' });
    expect(client.watchdogProgress(generation, id, wholeCall)).toBe(false);
    await advance(3_600_000);
    expect(core().killed).toBeNull();

    // Another: progress at 50 s, nothing after, and a hold that does
    // nothing. Hung at 125 s from its ask.
    const hung = sendOwn((onSent) =>
      client
        .request(
          'swarm.publish',
          { kind: 'file', parts: [] },
          { caller: 'shell' },
          { idleWatchdogMs: 75_000, onSent }
        )
        .catch((e) => e)
    );
    await settle();
    const hold = client.holdWatchdog(hung.sent.generation, hung.sent.id);
    await advance(50_000);
    client.watchdogProgress(hung.sent.generation, hung.sent.id, 75_000);
    await advance(74_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect((await hung.pending).code).toBe('core_unavailable');
    hold();
  });

  test("a cancelled swarm.publish's watchdog runs on until the core answers", async () => {
    makeClient(coreWith());
    await client.start();
    const cancel = new AbortController();
    const publish = sendOwn((onSent) =>
      client
        .request(
          'swarm.publish',
          { kind: 'data', parts: [] },
          { caller: 'shell' },
          { idleWatchdogMs: 75_000, onSent, signal: cancel.signal }
        )
        .catch((e) => e)
    );
    await settle();
    cancel.abort();
    expect((await publish.pending).code).toBe('cancelled');
    await settle();
    expect(core().messages.at(-1)).toEqual({ type: 'cancel', id: publish.sent.id });
    await advance(75_000);
    expect(core().killed).toBe('SIGKILL');
  });

  test("main's cancel is progress: a late one gives the core its bound to answer, as D13's 60 s for a cancel allows", async () => {
    makeClient(coreWith());
    await client.start();
    const shell = { caller: 'shell' };
    const cancels = [new AbortController(), new AbortController(), new AbortController()];
    const publishes = cancels.map((cancel) =>
      sendOwn((onSent) =>
        client
          .request('swarm.publish', { kind: 'data', parts: [] }, shell, {
            idleWatchdogMs: 75_000,
            onSent,
            signal: cancel.signal,
          })
          .catch((e) => e)
      )
    );
    const withdraw = new AbortController();
    const upload = sendOwn((onSent) =>
      client.callStream('swarm.body', { for: 1 }, shell, {
        idleWatchdogMs: 75_000,
        onSent,
        signal: withdraw.signal,
      })
    );
    await settle();
    // The body's head at 10 s: due at 85 s.
    await advance(10_000);
    core().send({ type: 'response', id: upload.sent.id, result: { bytes: 1, body: true } });
    const { body } = await upload.pending;
    // Main cancels every publish at 74 s: due at 149 s, not 75 s.
    await advance(64_000);
    for (const cancel of cancels) cancel.abort();
    await settle();
    const cancelled = core()
      .messages.filter((m) => m.type === 'cancel')
      .map((m) => m.id);
    expect(cancelled).toEqual(publishes.map((p) => p.sent.id));
    await advance(1_000);
    expect(core().killed).toBeNull();
    // The core answers one 10 s after the cancel, and another 59 s after.
    const answer = (id) =>
      core().send({ type: 'response', id, error: { code: 'cancelled', message: 'Cancelled' } });
    await advance(9_000);
    answer(publishes[0].sent.id);
    // Main withdraws the body at 84 s: due at 159 s, not 85 s.
    withdraw.abort();
    await expect(body.getReader().read()).rejects.toMatchObject({ code: 'cancelled' });
    await settle();
    expect(core().messages.at(-1)).toEqual({ type: 'cancel', id: upload.sent.id });
    await advance(49_000);
    answer(publishes[1].sent.id);
    await settle();
    for (const publish of publishes.slice(0, 2)) {
      expect((await publish.pending).code).toBe('cancelled');
    }
    // The body's terminal at 140 s, past its own 85 s.
    await advance(7_000);
    core().write(encodeAbort(upload.sent.id, 'cancelled', 'Cancelled'));
    await settle();
    expect(core().killed).toBeNull();
    expect([...client.current.idleWatchdogs.keys()]).toEqual([publishes[2].sent.id]);
    // The third is never answered: the core is hung 75 s after its cancel.
    await advance(8_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
  });

  test('an idle method without its idle watchdog, or with a total one, is refused in main and never sent; no other method takes one', async () => {
    makeClient(coreWith());
    await client.start();
    const shell = { caller: 'shell' };
    const refused = [
      client.request('swarm.publish', {}, shell),
      client.request('swarm.publish', {}, shell, { watchdogMs: 315_000 }),
      client.request('swarm.publish', {}, shell, { watchdogMs: 315_000, idleWatchdogMs: 75_000 }),
      ...[0, -1, 1.5, NaN, '75000', null].map((odd) =>
        client.request('swarm.publish', {}, shell, { idleWatchdogMs: odd })
      ),
      client.requestTo(client.current, 'swarm.publish', {}, shell),
      client.callStream('swarm.body', { for: 1 }),
      client.callStream('swarm.body', { for: 1 }, shell, { watchdogMs: 75_000 }),
      client.requestStreamTo(client.current, 'swarm.body', { for: 1 }, shell),
      // Only an idle method takes one.
      client.request('swarm.stamps', {}, shell, { idleWatchdogMs: 75_000 }),
      client.request('swarm.request', {}, shell, { idleWatchdogMs: 75_000 }),
      client.request('vault.status', {}, shell, { idleWatchdogMs: 75_000 }),
    ];
    for (const request of refused) {
      await expect(request).rejects.toMatchObject({ code: 'invalid_argument' });
    }
    await settle();
    expect(core().messages.map((m) => m.method)).toEqual(['core.hello']);
    // Nor can a caller ask for a total watchdog to send one with.
    expect(() => watchdogMs('swarm.body')).toThrow(/idle method/);
    expect(() => watchdogMs('swarm.publish')).toThrow(/idle method/);
    // The forms that go.
    client.request('swarm.publish', {}, shell, { idleWatchdogMs: 75_000 }).catch(() => {});
    client
      .request('swarm.stamps', {}, shell, { watchdogMs: watchdogMs('swarm.stamps') })
      .catch(() => {});
    await settle();
    expect(core().messages.map((m) => m.method)).toEqual([
      'core.hello',
      'swarm.publish',
      'swarm.stamps',
    ]);
  });
});

describe("main's Swarm I/O pool (design 0015)", () => {
  test("a Swarm handler's charges go to its pool, held to its reply's last byte; the chain pool is never charged", async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    const chainTake = jest.spyOn(client.pool, 'take');
    // A whole call of 2 MiB: m + 2 × b64(m) + 16 KiB reserved before its
    // dial, shrunk to the same sum over the 1.5 MiB it read.
    const charge = (m) => m + 2 * 4 * Math.ceil(m / 3) + 16 * KIB;
    const read = Buffer.alloc(1.5 * MIB, 0x62);
    const seen = [];
    client.handle(
      'shell.swarm_api',
      async (_params, { charge: take, shrink }) => {
        seen.push(take(charge(2 * MIB)), pool.held);
        shrink(charge(read.length));
        seen.push(pool.held);
        const base64 = read.toString('base64');
        return new JsonText([
          '{"status":200,"status_text":"OK","headers":[],"body_base64":"',
          base64,
          '"}',
        ]);
      },
      { pool, failure: FAILED, race: true }
    );
    await client.start();
    core().stuck = true;
    core().send({ type: 'request', id: 1, method: 'shell.swarm_api', params: {} });
    await settle();
    expect(seen).toEqual([true, charge(2 * MIB), charge(read.length)]);
    // Serialized, its fragments waiting on the pipe: still the handler's
    // charge, which counted the reply, and nothing more.
    expect(pool.held).toBe(charge(read.length));
    expect(client.pool.held).toBe(0);
    core().release();
    await settle();
    expect(core().replies()).toEqual([
      {
        type: 'response',
        id: 1,
        result: {
          status: 200,
          status_text: 'OK',
          headers: [],
          body_base64: read.toString('base64'),
        },
      },
    ]);
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(charge(2 * MIB));
    expect(client.pool.held).toBe(0);
    expect(chainTake).not.toHaveBeenCalled();
  });

  test("a reply past what its handler charged is charged to its pool for the rest, and past the pool is the handler's failure", async () => {
    const pool = new SwarmIoPool(256 * KIB);
    makeClient(coreWith());
    const chainTake = jest.spyOn(client.pool, 'take');
    const reply = (bytes) => ({ status: 200, body_base64: 'x'.repeat(bytes) });
    const size = (id, bytes) =>
      Buffer.byteLength(JSON.stringify({ type: 'response', id, result: reply(bytes) }));
    client.handle(
      'shell.swarm_api',
      async (params, { charge }) => {
        if (params.charge) charge(params.charge);
        return reply(params.bytes);
      },
      { pool, failure: (code) => ({ failed: code === 'busy' ? 'busy' : 'error' }), race: true }
    );
    await client.start();
    core().stuck = true;
    // Under 64 KiB and uncharged: exempt.
    core().send({ type: 'request', id: 1, method: 'shell.swarm_api', params: { bytes: 1000 } });
    await settle();
    expect(pool.held).toBe(0);
    // 100 KiB, uncharged: charged whole until written.
    core().send({
      type: 'request',
      id: 2,
      method: 'shell.swarm_api',
      params: { bytes: 100 * KIB },
    });
    await settle();
    expect(pool.held).toBe(size(2, 100 * KIB));
    // 100 KiB, with 64 KiB charged: the rest.
    core().send({
      type: 'request',
      id: 3,
      method: 'shell.swarm_api',
      params: { bytes: 100 * KIB, charge: 64 * KIB },
    });
    await settle();
    expect(pool.held).toBe(2 * size(2, 100 * KIB));
    // 100 KiB more doesn't fit: `{ failed: "busy" }`, never the error.
    core().send({
      type: 'request',
      id: 4,
      method: 'shell.swarm_api',
      params: { bytes: 100 * KIB },
    });
    await settle();
    expect(pool.held).toBe(2 * size(2, 100 * KIB));
    core().release();
    await settle();
    expect(
      core()
        .replies()
        .map((r) => [r.id, r.result.failed ?? r.result.body_base64.length])
    ).toEqual([
      [1, 1000],
      [2, 100 * KIB],
      [3, 100 * KIB],
      [4, 'busy'],
    ]);
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(2 * size(2, 100 * KIB));
    expect(chainTake).not.toHaveBeenCalled();
  });

  test("a streamed reply's charge is held to its terminal: its end, or the abort a cancel writes", async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    const chainTake = jest.spyOn(client.pool, 'take');
    const bodies = [];
    client.handle(
      'shell.swarm_part',
      (_params, { charge }) => {
        charge(256 * KIB);
        const body = source(WINDOW + 72 * KIB);
        bodies.push(body);
        return new StreamedReply({ bytes: WINDOW + 72 * KIB }, body.stream);
      },
      { streams: true, pool, failure: FAILED, race: true }
    );
    await client.start();
    core().send({ type: 'request', id: 1, method: 'shell.swarm_part', params: {} });
    core().send({ type: 'request', id: 2, method: 'shell.swarm_part', params: {} });
    await settle();
    // Both heads and a window each went; the rest waits for credit, and
    // each stream's 256 KiB with it.
    expect(core().replies()).toEqual([
      { type: 'response', id: 1, result: { bytes: WINDOW + 72 * KIB, body: true } },
      { type: 'response', id: 2, result: { bytes: WINDOW + 72 * KIB, body: true } },
    ]);
    expect([core().dataOf(1).length, core().dataOf(2).length]).toEqual([WINDOW, WINDOW]);
    expect(pool.held).toBe(512 * KIB);
    // Credit for the first: the rest, then its end, and its charge goes.
    core().write(encodeStreamCredit(1, WINDOW));
    await settle();
    expect(core().dataOf(1).length).toBe(WINDOW + 72 * KIB);
    expect(core().framesOf(KIND_END, 1)).toHaveLength(1);
    expect(pool.held).toBe(256 * KIB);
    // The core cancels the second mid-body: `cancelled` ends it, and its
    // charge goes once that is written.
    core().send({ type: 'cancel', id: 2 });
    await settle();
    expect(
      core()
        .framesOf(KIND_ABORT, 2)
        .map((f) => f.code)
    ).toEqual(['cancelled']);
    expect(bodies[1].cancelled).toBe(true);
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(512 * KIB);
    expect(client.pool.held).toBe(0);
    expect(chainTake).not.toHaveBeenCalled();
  });

  test('a byte stream is read through one buffer, reused read after read, however small its chunks (Codex round 2 on #1340)', async () => {
    makeClient(coreWith());
    const reused = [];
    const total = 3000;
    let sent = 0;
    const body = new ReadableStream({
      type: 'bytes',
      pull(controller) {
        const { view } = controller.byobRequest;
        // A mark at the buffer's last byte survives only in a buffer
        // handed back: a fresh one is zeroed.
        const all = new Uint8Array(view.buffer);
        reused.push(all[all.length - 1] === 0x99);
        all[all.length - 1] = 0x99;
        if (sent >= total) {
          controller.close();
          controller.byobRequest?.respond(0);
          return;
        }
        view[0] = sent % 251;
        sent += 1;
        controller.byobRequest.respond(1);
      },
    });
    client.handle('shell.swarm_api', () => new StreamedReply({ status: 200 }, body), {
      streams: true,
      failure: FAILED,
      race: true,
    });
    await client.start();
    core().send({ type: 'request', id: 1, method: 'shell.swarm_api', params: {} });
    for (let i = 0; i < 200 && core().framesOf(KIND_END, 1).length === 0; i++) await settle();
    expect(core().framesOf(KIND_END, 1)).toHaveLength(1);
    expect(core().dataOf(1)).toEqual(Buffer.from(Array.from({ length: total }, (_, i) => i % 251)));
    // Every read after the first is into the buffer the last handed back.
    expect(reused.length).toBeGreaterThan(total);
    expect(reused.slice(1).every(Boolean)).toBe(true);
  });

  test("a Swarm head sent with bodyFlag: false carries no body member, which the core's strict readers refuse; the stream opens all the same", async () => {
    makeClient(coreWith());
    client.handle(
      'shell.swarm_api',
      () =>
        new StreamedReply({ status: 200, status_text: 'OK', headers: [] }, source(10).stream, {
          bodyFlag: false,
        }),
      { streams: true, failure: FAILED, race: true }
    );
    await client.start();
    core().send({ type: 'request', id: 1, method: 'shell.swarm_api', params: {} });
    await settle();
    expect(core().replies()).toEqual([
      { type: 'response', id: 1, result: { status: 200, status_text: 'OK', headers: [] } },
    ]);
    expect(core().dataOf(1).length).toBe(10);
    expect(core().framesOf(KIND_END, 1)).toHaveLength(1);
  });

  test("a handler's id is the core's, and its onRelease runs once what it charged is released: a whole reply's at its write, a stream's at its terminal, a dropped one's at once", async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    const seen = [];
    const released = [];
    client.handle(
      'shell.swarm_api',
      (_params, { id, charge, onRelease }) => {
        seen.push(id);
        charge(64 * KIB);
        onRelease(() => released.push([id, pool.held]));
        return { status: 200 };
      },
      { pool, failure: FAILED, race: true }
    );
    client.handle(
      'shell.swarm_part',
      (_params, { id, charge, onRelease }) => {
        seen.push(id);
        charge(256 * KIB);
        onRelease(() => released.push([id, pool.held]));
        return new StreamedReply({ bytes: WINDOW + 1 }, source(WINDOW + 1).stream, {
          bodyFlag: false,
        });
      },
      { streams: true, pool, race: true }
    );
    await client.start();
    core().send({ type: 'request', id: 7, method: 'shell.swarm_api', params: {} });
    core().send({ type: 'request', id: 8, method: 'shell.swarm_part', params: {} });
    await settle();
    expect(seen).toEqual([7, 8]);
    // The whole reply is written; the stream waits for credit.
    expect(released).toEqual([[7, 256 * KIB]]);
    core().write(encodeStreamCredit(8, 64 * KIB));
    await settle();
    expect(core().framesOf(KIND_END, 8)).toHaveLength(1);
    expect(released).toEqual([
      [7, 256 * KIB],
      [8, 0],
    ]);
    // A reply the core's end drops: released with the generation.
    core().stuck = true;
    core().send({ type: 'request', id: 9, method: 'shell.swarm_api', params: {} });
    await settle();
    core().exit(1);
    await settle();
    expect(released.at(-1)).toEqual([9, 0]);
    expect(pool.held).toBe(0);
  });

  test("a streamed reply's onProgress sees each of main's frames as it is written and each of the core's credits, to its terminal", async () => {
    makeClient(coreWith());
    const progress = [];
    client.handle(
      'shell.swarm_part',
      () =>
        new StreamedReply({ bytes: WINDOW + 10 }, source(WINDOW + 10).stream, {
          bodyFlag: false,
          onProgress: () => progress.push(core().streams.length + core().replies().length),
        }),
      { streams: true, race: true }
    );
    await client.start();
    core().send({ type: 'request', id: 1, method: 'shell.swarm_part', params: {} });
    await settle();
    // The head, and the window's two data frames.
    expect(core().dataOf(1).length).toBe(WINDOW);
    expect(progress).toHaveLength(3);
    // The core's credit, then the last bytes and the end.
    core().write(encodeStreamCredit(1, 64 * KIB));
    await settle();
    expect(core().framesOf(KIND_END, 1)).toHaveLength(1);
    expect(progress).toHaveLength(6);
    // Nothing after its terminal.
    core().write(encodeStreamCredit(1, 10));
    await settle();
    expect(progress).toHaveLength(6);
  });

  test("onAnswer runs as main hands a whole reply to the pipe; abortStream then purges the data and end a stream's sender still holds, so only its abort follows the answer", async () => {
    let streamsAtReply = null;
    makeClient(
      coreWith((message, core) => {
        if (message.type === 'response' && message.id === 2) streamsAtReply = core.streams.length;
      })
    );
    const part = source(10 * KIB);
    let abortPart = null;
    client.handle(
      'shell.swarm_part',
      (_params, { abortStream }) => {
        abortPart = abortStream;
        return new StreamedReply({ bytes: 10 * KIB }, part.stream, { bodyFlag: false });
      },
      { streams: true, race: true }
    );
    let answer;
    const ready = new Promise((resolve) => {
      answer = resolve;
    });
    const hooks = [];
    client.handle(
      'shell.swarm_api',
      async (_params, { onAnswer }) => {
        onAnswer(() => {
          hooks.push(client.current.answers.has(2));
          abortPart(new Error('its call is over'));
        });
        await ready;
        return { status: 201 };
      },
      { failure: FAILED, race: true }
    );
    await client.start();
    // The core stops reading: the part's head is in flight, and its bytes,
    // read to their end, and its end wait in the sender.
    core().stuck = true;
    core().send({ type: 'request', id: 1, method: 'shell.swarm_part', params: {} });
    core().send({ type: 'request', id: 2, method: 'shell.swarm_api', params: {} });
    for (let i = 0; i < 100 && client.streamStats()?.held !== 10 * KIB; i++) await settle();
    expect(part.read).toBe(10 * KIB);
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 10 * KIB });
    answer();
    for (let i = 0; i < 100 && hooks.length === 0; i++) await settle();
    // The hook ran once, as the reply went into the pipe.
    expect(hooks).toEqual([false]);
    core().release();
    for (let i = 0; i < 100 && core().framesOf(KIND_ABORT, 1).length === 0; i++) await settle();
    expect(
      core()
        .replies()
        .map((r) => r.id)
    ).toEqual([1, 2]);
    expect(
      core()
        .streams.slice(streamsAtReply)
        .map((f) => [f.kind, f.id])
    ).toEqual([[KIND_ABORT, 1]]);
    expect(core().framesOf(KIND_ABORT, 1)[0].code).toBe('body_stream_error');
    expect(core().dataOf(1).length + core().framesOf(KIND_END, 1).length).toBe(0);
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, sending: 0 });
    // Once its terminal is written, abortStream does nothing.
    abortPart(new Error('late'));
    await settle();
    expect(core().framesOf(KIND_ABORT, 1)).toHaveLength(1);
  });

  test("onAnswer for a streams handler's reply runs as the sender hands it to a write, before another frame is taken: another stream's queued data and end are purged, and its abort follows the reply in the same write", async () => {
    let streamsAtReply = null;
    makeClient(
      coreWith((message, core) => {
        if (message.type === 'response' && message.id === 2) streamsAtReply = core.streams.length;
      })
    );
    const part = source(10 * KIB);
    let abortPart = null;
    client.handle(
      'shell.swarm_part',
      (_params, { abortStream }) => {
        abortPart = abortStream;
        return new StreamedReply({ bytes: 10 * KIB }, part.stream, { bodyFlag: false });
      },
      { streams: true, race: true }
    );
    let answer;
    const ready = new Promise((resolve) => {
      answer = resolve;
    });
    let runs = 0;
    // A streams handler: its reply goes through the duplex's sender.
    client.handle(
      'shell.swarm_api',
      async (_params, { onAnswer }) => {
        onAnswer(() => {
          runs += 1;
          abortPart(new Error('its call is over'));
        });
        await ready;
        return { status: 201 };
      },
      { streams: true, failure: FAILED, race: true }
    );
    await client.start();
    // The core stops reading: the part's head is in flight; its bytes and
    // its end wait in the sender, and the reply queues beside them.
    core().stuck = true;
    core().send({ type: 'request', id: 1, method: 'shell.swarm_part', params: {} });
    core().send({ type: 'request', id: 2, method: 'shell.swarm_api', params: {} });
    for (let i = 0; i < 100 && client.streamStats()?.held !== 10 * KIB; i++) await settle();
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 10 * KIB });
    answer();
    await settle();
    // Queued, not yet taken: the hook waits for the hand-off.
    expect(runs).toBe(0);
    core().release();
    for (let i = 0; i < 100 && core().framesOf(KIND_ABORT, 1).length === 0; i++) await settle();
    expect(runs).toBe(1);
    expect(
      core()
        .replies()
        .map((r) => r.id)
    ).toEqual([1, 2]);
    expect(
      core()
        .streams.slice(streamsAtReply)
        .map((f) => [f.kind, f.id])
    ).toEqual([[KIND_ABORT, 1]]);
    expect(core().dataOf(1).length + core().framesOf(KIND_END, 1).length).toBe(0);
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, sending: 0 });
    expect(client.current.answers.size).toBe(0);
  });

  test('abortStream lets go of a body still being read: its source cancelled, its abort sent', async () => {
    makeClient(coreWith());
    const part = source(WINDOW + 10);
    let abortPart = null;
    client.handle(
      'shell.swarm_part',
      (_params, { abortStream }) => {
        abortPart = abortStream;
        return new StreamedReply({ bytes: WINDOW + 10 }, part.stream, { bodyFlag: false });
      },
      { streams: true, sends: SWARM_PART_ABORT_CODES, race: true }
    );
    await client.start();
    core().send({ type: 'request', id: 1, method: 'shell.swarm_part', params: {} });
    for (let i = 0; i < 100 && core().dataOf(1).length < WINDOW; i++) await settle();
    // The window sent; the rest waits for credit.
    expect(core().dataOf(1).length).toBe(WINDOW);
    abortPart(Object.assign(new Error('unreadable'), { errorCode: 'EIO' }));
    for (let i = 0; i < 100 && core().framesOf(KIND_ABORT, 1).length === 0; i++) await settle();
    expect(part.cancelled).toBe(true);
    const [abort] = core().framesOf(KIND_ABORT, 1);
    expect(abort.code).toBe('body_stream_error');
    expect(abort.errorCode).toBe('EIO');
    expect(client.streamStats()).toMatchObject({ pieces: 0, held: 0, sending: 0 });
  });

  test("swarm.body's head { bytes } opens its body with no body flag; another stream request's head still needs one", async () => {
    makeClient(coreWith());
    await client.start();
    const shell = { caller: 'shell' };
    const upload = sendOwn((onSent) =>
      client.callStream('swarm.body', { for: 1 }, shell, { idleWatchdogMs: 75_000, onSent })
    );
    const verify = sendOwn((onSent) => client.callStream('dweb.verify', {}, shell, { onSent }));
    await settle();
    core().send({ type: 'response', id: upload.sent.id, result: { bytes: 3 } });
    core().send({ type: 'response', id: verify.sent.id, result: { bytes: 3 } });
    const { result, body } = await upload.pending;
    expect(result).toEqual({ bytes: 3 });
    expect((await verify.pending).body).toBeNull();
    core().write(encodeData(upload.sent.id, Buffer.from('abc')));
    core().write(encodeEnd(upload.sent.id));
    const reader = body.getReader();
    expect(Buffer.from((await reader.read()).value).toString()).toBe('abc');
    expect((await reader.read()).done).toBe(true);
    await settle();
    expect(client.current.idleWatchdogs.size).toBe(0);
    expect(core().killed).toBeNull();
  });

  test("a reply dropped unwritten, or its core's end, releases its handler's charge", async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    let finish;
    client.handle(
      'shell.swarm_api',
      (_params, { charge }) => {
        charge(MIB);
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      { pool, failure: FAILED, race: true }
    );
    client.handle(
      'shell.swarm_ready',
      async (_params, { charge }) => {
        charge(64 * KIB);
        return { ok: true, pad: 'x'.repeat(100 * KIB) };
      },
      { pool, failure: FAILED, race: true }
    );
    await client.start();
    // One serialized and waiting on the pipe, one still working.
    core().stuck = true;
    core().send({ type: 'request', id: 1, method: 'shell.swarm_ready', params: {} });
    core().send({ type: 'request', id: 2, method: 'shell.swarm_api', params: {} });
    await settle();
    expect(pool.held).toBeGreaterThan(MIB + 100 * KIB);
    core().exit(1);
    await settle();
    finish({ status: 200 });
    await settle();
    expect(pool.held).toBe(0);
  });
});

describe("a Swarm handler's answers (design 0015: the core takes no other error)", () => {
  test("a refusal carries its rule; any other failure is the handler's failure result, never internal", async () => {
    makeClient(coreWith());
    const swarm = { failure: FAILED, race: true };
    // Data set after construction, as a handler could.
    const odd = (data) => Object.assign(new ShellError('invalid_argument'), { data });
    const throws = {
      rule: () => new ShellError('invalid_argument', { rule: 'order' }),
      bare: () => new ShellError('invalid_argument'),
      timeout: () => new ShellError('timeout'),
      cancelled: () => new ShellError('cancelled'),
      type: () => new TypeError('boom'),
      // Shapes the core's `wire.rs` doesn't take, which would end its
      // connection: a rule it doesn't know, an extra member, a rule that
      // isn't a string, another member, none, an inherited one, and data
      // that isn't an object.
      bogus: () => new ShellError('invalid_argument', { rule: 'bogus' }),
      extra: () => new ShellError('invalid_argument', { rule: 'order', extra: true }),
      number: () => new ShellError('invalid_argument', { rule: 7 }),
      named: () => new ShellError('invalid_argument', { name: 'order' }),
      empty: () => new ShellError('invalid_argument', {}),
      inherited: () => new ShellError('invalid_argument', Object.create({ rule: 'order' })),
      string: () => odd('order'),
      array: () => odd(['order']),
      nulled: () => odd(null),
    };
    client.handle(
      'shell.swarm_api',
      async (params) => {
        throw throws[params.case]();
      },
      swarm
    );
    // Through the duplex's sender, and thrown before any promise.
    client.handle(
      'shell.swarm_part',
      () => {
        throw new ShellError('invalid_argument', { rule: 'value' });
      },
      { streams: true, ...swarm }
    );
    client.handle(
      'shell.swarm_ready',
      () => {
        throw new Error('sync');
      },
      swarm
    );
    // Not a Swarm handler: a throw is internal, as before, and a ShellError
    // with data still carries it.
    client.handle('shell.rpc', async () => {
      throw new TypeError('boom');
    });
    client.handle('shell.gateway', async () => {
      throw new ShellError('invalid_argument', { rule: 'query' });
    });
    await client.start();
    const cases = Object.keys(throws);
    cases.forEach((name, i) =>
      core().send({ type: 'request', id: i + 1, method: 'shell.swarm_api', params: { case: name } })
    );
    for (const [i, method] of [
      'shell.swarm_part',
      'shell.swarm_ready',
      'shell.rpc',
      'shell.gateway',
    ].entries()) {
      core().send({ type: 'request', id: cases.length + i + 1, method, params: {} });
    }
    await settle();
    const rule = (name) => ({
      code: 'invalid_argument',
      message: 'Invalid argument',
      data: { rule: name },
    });
    const failed = { failed: 'error' };
    const n = cases.length;
    expect(
      core()
        .replies()
        .sort((a, b) => a.id - b.id)
    ).toEqual([
      { type: 'response', id: 1, error: rule('order') },
      ...cases.slice(1).map((_, i) => ({ type: 'response', id: i + 2, result: failed })),
      { type: 'response', id: n + 1, error: rule('value') },
      { type: 'response', id: n + 2, result: failed },
      { type: 'response', id: n + 3, error: { code: 'internal', message: 'Internal error' } },
      { type: 'response', id: n + 4, error: rule('query') },
    ]);
    // Every rule the core knows goes as it is.
    expect([...REFUSAL_RULES]).toEqual([
      'form',
      'order',
      'count',
      'value',
      'header',
      'query',
      'body',
      'ended',
    ]);
    expect(core().killed).toBeNull();
    // A shell error's data is an object.
    for (const odd of ['order', ['order'], null, 7]) {
      expect(() => new ShellError('invalid_argument', odd)).toThrow(TypeError);
    }
    expect(new ShellError('busy')).not.toHaveProperty('data');
  });

  test("a Swarm handler races its signal: the core's cancel is answered at once, and its charges go only when it settles", async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    const finish = [];
    // Neither looks at its signal, as getPublishReadiness() takes none.
    const stuck =
      (bytes) =>
      (_params, { charge }) => {
        charge(bytes);
        return new Promise((resolve) => finish.push(resolve));
      };
    client.handle('shell.swarm_ready', stuck(4 * KIB), { pool, failure: FAILED, race: true });
    client.handle('shell.swarm_api', stuck(MIB), {
      streams: true,
      pool,
      failure: FAILED,
      race: true,
    });
    // Without `race`, a cancel waits for the handler, as before.
    client.handle('shell.rpc', stuck(0));
    await client.start();
    for (const [id, method] of [
      [1, 'shell.swarm_ready'],
      [2, 'shell.swarm_api'],
      [3, 'shell.rpc'],
    ]) {
      core().send({ type: 'request', id, method, params: {} });
    }
    await settle();
    expect(pool.held).toBe(4 * KIB + MIB);
    for (const id of [1, 2, 3]) core().send({ type: 'cancel', id });
    await settle();
    const cancelled = { code: 'cancelled', message: 'Cancelled' };
    expect(core().replies()).toEqual([
      { type: 'response', id: 1, error: cancelled },
      { type: 'response', id: 2, error: cancelled },
    ]);
    // What they hold is still held: a dial or a read may be in flight.
    expect(pool.held).toBe(4 * KIB + MIB);
    for (const resolve of finish) resolve({ ok: true });
    await settle();
    expect(core().replies()).toEqual([
      { type: 'response', id: 1, error: cancelled },
      { type: 'response', id: 2, error: cancelled },
      { type: 'response', id: 3, result: { ok: true } },
    ]);
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(4 * KIB + MIB);
    expect(core().killed).toBeNull();
  });
});

describe("main's own fragmented responses, charged to a pool ({ pool })", () => {
  /** `message` as a fragmented response: its begin, then `pieces` frames. */
  function fragments(message, pieces) {
    const payload = Buffer.from(JSON.stringify(message));
    const size = Math.ceil(payload.length / pieces);
    const frames = [];
    for (let offset = 0; offset < payload.length; offset += size) {
      const end = Math.min(payload.length, offset + size);
      const kind = end === payload.length ? KIND_LAST : KIND_FRAGMENT;
      frames.push(Buffer.concat([frameHeader(kind, end - offset), payload.subarray(offset, end)]));
    }
    return { begin: encodeBegin(message.id, payload.length), frames, payload };
  }

  /** Buffer.alloc watched: the pool's holding at each allocation of a
   * MiB or more, the reassembler's buffer among them. */
  function watchAllocations(pool) {
    const alloc = Buffer.alloc.bind(Buffer);
    const seen = [];
    const spy = jest.spyOn(Buffer, 'alloc').mockImplementation((size, ...rest) => {
      if (size >= MIB) seen.push({ size, held: pool.held });
      return alloc(size, ...rest);
    });
    return { seen, restore: () => spy.mockRestore() };
  }

  test('twice the size its begin declares, charged before its buffer is made, until the caller has it', async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    const chainTake = jest.spyOn(client.pool, 'take');
    await client.start();
    const read = sendOwn((onSent) =>
      client.request(
        'swarm.request',
        { method: 'readData' },
        { caller: 'shell' },
        { pool, watchdogMs: watchdogMs('swarm.request'), onSent }
      )
    );
    await settle();
    const message = {
      type: 'response',
      id: read.sent.id,
      result: { result_typed: 'y'.repeat(2 * MIB) },
    };
    const { begin, frames, payload } = fragments(message, 3);
    const allocations = watchAllocations(pool);
    try {
      core().write(begin);
      await settle();
      // Charged whole at the begin, and only then is the buffer made.
      expect(allocations.seen).toEqual([{ size: payload.length, held: 2 * payload.length }]);
      for (const frame of frames.slice(0, -1)) {
        core().write(frame);
        await settle();
        expect(pool.held).toBe(2 * payload.length);
      }
      core().write(frames.at(-1));
      await expect(read.pending).resolves.toEqual(message.result);
    } finally {
      allocations.restore();
    }
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(2 * payload.length);
    expect(core().credits).toBe(1);
    expect(chainTake).not.toHaveBeenCalled();
  });

  test('with the pool full, a response is never held: busy at its begin, no buffer made, read to its end with none and let go of', async () => {
    const pool = new SwarmIoPool();
    makeClient(coreWith());
    await client.start();
    // Other Swarm leases hold the whole 64 MiB.
    const others = pool.reserve(pool.limit);
    const read = sendOwn((onSent) =>
      client
        .request(
          'swarm.request',
          { method: 'readData' },
          { caller: 'shell' },
          { pool, watchdogMs: watchdogMs('swarm.request'), onSent }
        )
        .catch((e) => e)
    );
    await settle();
    const message = { type: 'response', id: read.sent.id, result: { data: 'z'.repeat(2 * MIB) } };
    const { begin, frames, payload } = fragments(message, 4);
    const allocations = watchAllocations(pool);
    try {
      core().write(begin);
      // The caller hears `busy` at the begin, before any fragment.
      expect((await read.pending).code).toBe('busy');
      const { reassembler } = client.current;
      expect(reassembler.current).toMatchObject({ size: payload.length, buffer: null });
      for (const frame of frames.slice(0, -1)) {
        core().write(frame);
        await settle();
        expect(reassembler.current).toMatchObject({ buffer: null });
      }
      core().write(frames.at(-1));
      await settle();
      // Nothing of it was ever allocated, nor charged.
      expect(allocations.seen).toEqual([]);
      expect(reassembler.inProgress()).toBe(false);
    } finally {
      allocations.restore();
    }
    expect(pool.held).toBe(pool.limit);
    expect(pool.highWater).toBe(pool.limit);
    // Read to its end and let go of: the core's credit is back, the
    // request and its watchdog with it, and the connection serves on.
    expect(core().credits).toBe(1);
    expect(client.current.pending.has(read.sent.id)).toBe(false);
    expect(live().filter((t) => t.at === 315_000)).toEqual([]);
    others.close();
    expect(pool.held).toBe(0);
    const next = sendOwn((onSent) =>
      client.request('vault.status', {}, { caller: 'chrome' }, { onSent })
    );
    await settle();
    core().send({ type: 'response', id: next.sent.id, result: { exists: true } });
    await expect(next.pending).resolves.toEqual({ exists: true });
    expect(core().killed).toBeNull();
    expect(log.error).not.toHaveBeenCalled();
  });

  test('one larger than an empty pool is refused at its begin too, and a dropped response still checks its fragments', async () => {
    const pool = new SwarmIoPool(1.5 * MIB);
    makeClient(coreWith());
    await client.start();
    const read = sendOwn((onSent) =>
      client.request('swarm.request', {}, { caller: 'shell' }, { pool, onSent }).catch((e) => e)
    );
    await settle();
    const message = { type: 'response', id: read.sent.id, result: { data: 'q'.repeat(MIB) } };
    const { begin, frames } = fragments(message, 2);
    core().write(begin);
    expect((await read.pending).code).toBe('busy');
    expect(pool.held).toBe(0);
    // A fragment past its declared size breaks the protocol, held or not.
    core().write(frames[0]);
    core().write(frames[0]);
    await settle();
    expect(log.error).toHaveBeenCalledWith('[Core] protocol error', {
      category: 'fragment_length',
    });
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(0);
  });

  test('a response under one frame, or one to a request without a pool, is charged nothing', async () => {
    const pool = new SwarmIoPool(64 * KIB);
    makeClient(coreWith());
    await client.start();
    const whole = sendOwn((onSent) =>
      client.request('swarm.request', {}, { caller: 'shell' }, { pool, onSent })
    );
    const unpooled = sendOwn((onSent) =>
      client.request('swarm.request', {}, { caller: 'shell' }, { onSent })
    );
    await settle();
    core().send({ type: 'response', id: whole.sent.id, result: { data: 'w'.repeat(512 * KIB) } });
    const big = { type: 'response', id: unpooled.sent.id, result: { data: 'v'.repeat(2 * MIB) } };
    const { begin, frames } = fragments(big, 3);
    core().write(begin);
    for (const frame of frames) core().write(frame);
    await expect(whole.pending).resolves.toEqual({ data: 'w'.repeat(512 * KIB) });
    await expect(unpooled.pending).resolves.toEqual(big.result);
    expect(pool.held).toBe(0);
    expect(pool.highWater).toBe(0);
    expect(POOL_EXEMPT_BYTES).toBe(64 * KIB);
  });
});
