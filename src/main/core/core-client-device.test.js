/**
 * The client's device watchdog (freedom-core design 0016, "The device
 * lane" and "Deadlines, cancel and unplugging"; LDG-3), against a
 * scripted core on a fake clock. A request goes as LDG-3's `ledgerCall`
 * sends it, under the watchdog core-deadlines.js picks from its params:
 * - a vault key's `sign.*` keeps 0001's immediate 15 s, and a Ledger key's
 *   gets the lane's 5 minutes and 15 s until a `shell.ledger_apdu` first
 *   names it, so one queued 5 minutes isn't killed and one silent at 5:15
 *   is;
 * - from each `shell.ledger_apdu` on, its `deadline_ms` + 15 s, set again,
 *   earlier or later, by the APDU and by main's answer to it
 *   (`watchdogReset`, from a stand-in for the relay);
 * - nothing fires once the request has ended, a cancelled one's at the
 *   core's answer to it, and nothing holds it;
 * - the device watchdog goes alone, and never for an idle method.
 * The classifier's own values, the `safe.*` methods' included, are
 * core-deadlines.test.js's.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const { CoreClient, RESTART_DELAYS_MS } = require('./core-client');
const { encodeFrame, CORE_KINDS, CORE_STREAM_KINDS, FrameDecoder, KIND_JSON } = require('./frame');
const { apduWatchdogMs, deviceWatchdogMs, drivesDevice } = require('./core-deadlines');

const tick = () => new Promise(setImmediate);
const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};

/**
 * A scripted freedom-cored: `handler(message, core)` answers main's JSON
 * messages. Its own requests to main go out with `ask`, and main's replies
 * to them are kept (`replies()`).
 */
class FakeCore extends EventEmitter {
  constructor(handler) {
    super();
    this.pid = 4242;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = null;
    this.nextAsk = 1;
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
          if (frame.kind !== KIND_JSON) continue;
          this.messages.push(frame.message);
          handler(frame.message, this);
        }
        callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0));
      },
    });
  }

  send(message) {
    this.stdout.write(encodeFrame(message));
    if (message.type === 'response' && message.result?.protocol === 2) {
      this.decoder.setKinds(CORE_STREAM_KINDS);
    }
  }

  /** The core's `shell.ledger_apdu` for main's request `id`. */
  ask(id, deadlineMs) {
    const ask = this.nextAsk++;
    this.send({
      type: 'request',
      id: ask,
      method: 'shell.ledger_apdu',
      params: { for: id, apdu: 'e0040000050102030405', deadline_ms: deadlineMs },
    });
    return ask;
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

  /** Main's requests of `method`. */
  requestsOf(method) {
    return this.messages.filter((m) => m?.type === 'request' && m.method === method);
  }
}

/** Answers the hello at protocol 2 and shutdown, and hands everything else
 * to `extra`. */
function coreWith(extra = () => {}) {
  return (message, core) => {
    if (message.method === 'core.hello') {
      core.send({
        type: 'response',
        id: message.id,
        result: {
          protocol: 2,
          core_version: '0.33.0',
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

const SHELL = { caller: 'shell' };
const LEDGER = { kind: 'ledger', index: 3 };
const VAULT_KEY = { kind: 'account', index: 0 };
const TX = { to: '0x' + '11'.repeat(20), value: '0x0', chain_id: 1 };
const HUNG = ['[Core] request hung; restarting the core'];

/**
 * Sends main's request as LDG-3's `ledgerCall` does (vault-backend.js):
 * under the client's device watchdog for a request that drives the device,
 * and its plain one for any other, as core-deadlines.js picks them.
 * `{ pending, sent }`: its outcome, and what `onSent` reported.
 */
function sendDevice(method, params, { ledgerOwner = false, signal = null } = {}) {
  const ms = deviceWatchdogMs(method, params, { ledgerOwner });
  const watchdog = drivesDevice(method, params, { ledgerOwner })
    ? { deviceWatchdogMs: ms }
    : { watchdogMs: ms };
  const out = { sent: null };
  out.pending = client
    .request(method, params, SHELL, {
      ...watchdog,
      signal,
      onSent: (id, generation) => {
        out.sent = { id, generation };
      },
    })
    .catch((e) => e);
  return out;
}

/**
 * A stand-in for LDG-3's relay (PR 6), as far as the watchdog goes: each
 * `shell.ledger_apdu` sets its parent's watchdog to the APDU's
 * `deadline_ms` + 15 s as it arrives, and again as main's answer goes to
 * the pipe. Each answer waits for the test: `apdus[n].answer(result)`.
 */
function relay() {
  const apdus = [];
  client.handle('shell.ledger_apdu', (params, { generation, onAnswer }) => {
    const ms = apduWatchdogMs(params.deadline_ms);
    const reset = () => client.watchdogReset(generation, params.for, ms);
    const apdu = { params, reset: reset() };
    onAnswer(() => {
      apdu.answerReset = reset();
    });
    apdus.push(apdu);
    return new Promise((resolve) => {
      apdu.answer = resolve;
    });
  });
  return apdus;
}

/** The core's answer to main's request `id`. */
function respond(id, result = { raw: '0x02', hash: '0x' + '22'.repeat(32) }) {
  core().send({ type: 'response', id, result });
}

describe("a device request's watchdog (design 0016, The device lane)", () => {
  test("a vault key's sign.* is caught at 15 s, and a Ledger key's isn't", async () => {
    makeClient(coreWith());
    await client.start();
    // A Ledger key's: 15 s and a minute pass, and its answer still comes.
    const ledger = sendDevice('sign.transaction', { key: LEDGER, tx: TX });
    await settle();
    expect(core().requestsOf('sign.transaction')).toHaveLength(1);
    await advance(15_000);
    expect(core().killed).toBeNull();
    await advance(60_000);
    expect(core().killed).toBeNull();
    respond(ledger.sent.id);
    await expect(ledger.pending).resolves.toMatchObject({ raw: '0x02' });
    // A vault key's: hung at 15 s.
    const vault = sendDevice('sign.transaction', { key: VAULT_KEY, tx: TX });
    await settle();
    await advance(14_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect(log.error).toHaveBeenCalledWith(...HUNG, { method: 'sign.transaction' });
    expect((await vault.pending).code).toBe('core_unavailable');
    await advance(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(children).toHaveLength(2);
  });

  test("a request queued 5 minutes isn't killed, and one silent at 5:15 is", async () => {
    makeClient(coreWith());
    await client.start();
    const apdus = relay();
    const queued = sendDevice('sign.message', { key: LEDGER, message: '0x68690a' });
    const silent = sendDevice('sign.message', { key: LEDGER, message: '0x6869' });
    await settle();
    // The first's first APDU just inside the lane's 5 minutes, its answer,
    // and the core's at 5:01.
    await advance(299_999);
    core().ask(queued.sent.id, 15_000);
    await settle();
    expect(apdus.map((a) => a.reset)).toEqual([true]);
    await advance(500);
    apdus[0].answer({ answer: '9000' });
    await settle();
    expect(core().replies()).toEqual([{ type: 'response', id: 1, result: { answer: '9000' } }]);
    await advance(501);
    respond(queued.sent.id, { signature: '0x' + '33'.repeat(65) });
    await expect(queued.pending).resolves.toEqual({ signature: '0x' + '33'.repeat(65) });
    // The second, named by no APDU: alive at 5:14.999, hung at 5:15.
    await advance(13_999);
    expect(clock).toBe(314_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect(log.error).toHaveBeenCalledWith(...HUNG, { method: 'sign.message' });
    expect((await silent.pending).code).toBe('core_unavailable');
  });

  test("every request that drives the device gets the lane's 5 minutes and 15 s until an APDU names it", async () => {
    const requests = [
      ['sign.transaction', { key: LEDGER, tx: TX }],
      ['sign.message', { key: LEDGER, message: '0x00' }],
      ['sign.typed_data', { key: LEDGER, typed_data: {}, expected_hash: '0x' + '00'.repeat(32) }],
      ['ledger.accounts', { scheme: 'bip44', start: 0, count: 5 }],
      ['ledger.add', { scheme: 'bip44', index: 2 }],
      ['x402.settle', { reservation: 'r1', typed_data: {} }],
    ];
    for (const [method, params] of requests) {
      makeClient(coreWith());
      await client.start();
      const request = sendDevice(method, params);
      await settle();
      expect(core().requestsOf(method)).toHaveLength(1);
      await advance(314_999);
      expect(core().killed).toBeNull();
      await advance(1);
      expect(core().killed).toBe('SIGKILL');
      expect((await request.pending).code).toBe('core_unavailable');
      await client.stop();
    }
  });

  test("each shell.ledger_apdu gives its deadline_ms + 15 s, set again by the APDU and by main's answer, earlier or later", async () => {
    makeClient(coreWith());
    await client.start();
    const apdus = relay();
    const sign = sendDevice('sign.typed_data', {
      key: LEDGER,
      typed_data: {},
      expected_hash: '0x' + '44'.repeat(32),
    });
    await settle();
    const { id } = sign.sent;
    // An APDU at 60 s that doesn't wait for the user: 30 s from it, earlier
    // than the lane's 5:15.
    await advance(60_000);
    core().ask(id, 15_000);
    await settle();
    expect(apdus[0].params).toMatchObject({ for: id, deadline_ms: 15_000 });
    // Main answers at 89 s: 30 s from the answer.
    await advance(29_000);
    expect(core().killed).toBeNull();
    apdus[0].answer({ answer: '9000' });
    await settle();
    expect(apdus[0].answerReset).toBe(true);
    await advance(29_999);
    expect(core().killed).toBeNull();
    // The APDU that waits for the user, at 118.999 s: 5:15 from it.
    core().ask(id, 300_000);
    await settle();
    await advance(314_999);
    expect(clock).toBe(433_998);
    expect(core().killed).toBeNull();
    // The user confirms just inside the 5 minutes, and main answers at
    // 433.998 s: 5:15 from the answer.
    apdus[1].answer({ answer: '1b' + '55'.repeat(64) + '9000' });
    await settle();
    expect(apdus[1].answerReset).toBe(true);
    await advance(314_999);
    expect(core().killed).toBeNull();
    // A third APDU brings it back to 30 s.
    core().ask(id, 15_000);
    await settle();
    await advance(29_999);
    expect(core().killed).toBeNull();
    // Nothing more from main or the core: hung 30 s after the APDU.
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect(log.error).toHaveBeenCalledWith(...HUNG, { method: 'sign.typed_data' });
    expect((await sign.pending).code).toBe('core_unavailable');
  });

  test("a core silent after main's answer to an APDU is hung 30 s later, long before the lane's 5:15", async () => {
    makeClient(coreWith());
    await client.start();
    const apdus = relay();
    const add = sendDevice('ledger.add', { scheme: 'bip44', index: 0 });
    await settle();
    await advance(1_000);
    core().ask(add.sent.id, 15_000);
    await settle();
    // Main's exchange ends at the APDU's 15 s (`unresponsive`).
    await advance(15_000);
    apdus[0].answer({ failed: 'unresponsive' });
    await settle();
    expect(
      core()
        .replies()
        .map((r) => r.result)
    ).toEqual([{ failed: 'unresponsive' }]);
    await advance(29_999);
    expect(clock).toBe(45_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect((await add.pending).code).toBe('core_unavailable');
  });

  test('watchdogReset sets only a pending device request of that process, by a positive ms', async () => {
    makeClient(coreWith());
    await client.start();
    const device = sendDevice('ledger.accounts', { scheme: 'bip44', start: 0, count: 1 });
    const plain = sendDevice('sign.message', { key: VAULT_KEY, message: '0x00' });
    await settle();
    const { id, generation } = device.sent;
    // Another process's number, or another ID, sets nothing.
    expect(client.watchdogReset(generation + 1, id, 30_000)).toBe(false);
    expect(client.watchdogReset(generation, id + 100, 30_000)).toBe(false);
    for (const odd of [0, -1, 1.5, NaN, Infinity, '30000', null, undefined]) {
      expect(() => client.watchdogReset(generation, id, odd)).toThrow(TypeError);
    }
    // A plain watchdog isn't reset: the vault key's still fires at 15 s.
    expect(client.watchdogReset(plain.sent.generation, plain.sent.id, 300_000)).toBe(false);
    // An idle request's isn't either (design 0015's `watchdogProgress`).
    const publish = { sent: null };
    publish.pending = client
      .request('swarm.publish', { kind: 'data', parts: [] }, SHELL, {
        idleWatchdogMs: 75_000,
        onSent: (sentId, sentGeneration) => {
          publish.sent = { id: sentId, generation: sentGeneration };
        },
      })
      .catch((e) => e);
    await settle();
    expect(client.watchdogReset(publish.sent.generation, publish.sent.id, 300_000)).toBe(false);
    expect(client.watchdogProgress(generation, id, 300_000)).toBe(false);
    await advance(14_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect(log.error).toHaveBeenCalledWith(...HUNG, { method: 'sign.message' });
    expect((await device.pending).code).toBe('core_unavailable');
    // The process is gone: its number sets nothing on the next.
    await advance(RESTART_DELAYS_MS[0]);
    await client.whenReady();
    expect(client.watchdogReset(generation, id, 30_000)).toBe(false);
  });
});

describe('nothing fires after a device request ends', () => {
  test('its response ends it: a reset or a late APDU after that sets nothing, and no timer is left', async () => {
    makeClient(coreWith());
    await client.start();
    const apdus = relay();
    const sign = sendDevice('sign.transaction', { key: LEDGER, tx: TX });
    await settle();
    const { id, generation } = sign.sent;
    await advance(10_000);
    core().ask(id, 300_000);
    await settle();
    await advance(10_000);
    apdus[0].answer({ answer: '9000' });
    await settle();
    respond(id);
    await expect(sign.pending).resolves.toMatchObject({ raw: '0x02' });
    expect(live()).toEqual([]);
    expect(client.watchdogReset(generation, id, 30_000)).toBe(false);
    // A late APDU naming it (the relay refuses it in LDG-3): nothing armed.
    core().ask(id, 15_000);
    await settle();
    expect(apdus[1].reset).toBe(false);
    apdus[1].answer({ answer: '6985' });
    await settle();
    expect(apdus[1].answerReset).toBe(false);
    expect(live()).toEqual([]);
    await advance(3_600_000);
    expect(core().killed).toBeNull();
  });

  test("a cancelled device request's watchdog runs on until the core answers it, and ends there", async () => {
    makeClient(coreWith());
    await client.start();
    const apdus = relay();
    // One the core answers 5 s after main's cancel.
    const cancel = new AbortController();
    const answered = sendDevice(
      'sign.message',
      { key: LEDGER, message: '0x01' },
      { signal: cancel.signal }
    );
    await settle();
    core().ask(answered.sent.id, 300_000);
    await settle();
    await advance(20_000);
    cancel.abort();
    expect((await answered.pending).code).toBe('cancelled');
    await settle();
    expect(core().messages.at(-1)).toEqual({ type: 'cancel', id: answered.sent.id });
    // Main's answer to the APDU after the cancel still sets it.
    apdus[0].answer({ answer: '6985' });
    await settle();
    expect(apdus[0].answerReset).toBe(true);
    await advance(5_000);
    core().send({
      type: 'response',
      id: answered.sent.id,
      error: { code: 'cancelled', message: 'Cancelled' },
    });
    await settle();
    expect(client.watchdogReset(answered.sent.generation, answered.sent.id, 30_000)).toBe(false);
    expect(live()).toEqual([]);
    await advance(3_600_000);
    expect(core().killed).toBeNull();

    // One the core never answers: hung at the deadline it last had.
    const never = new AbortController();
    const unanswered = sendDevice(
      'ledger.accounts',
      { scheme: 'bip44', start: 0, count: 1 },
      { signal: never.signal }
    );
    await settle();
    await advance(1_000);
    core().ask(unanswered.sent.id, 15_000);
    await settle();
    never.abort();
    expect((await unanswered.pending).code).toBe('cancelled');
    await advance(29_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect(log.error).toHaveBeenCalledWith(...HUNG, { method: 'ledger.accounts' });
  });

  test('nothing holds it', async () => {
    makeClient(coreWith());
    await client.start();
    const sign = sendDevice('sign.transaction', { key: LEDGER, tx: TX });
    await settle();
    const release = client.holdWatchdog(sign.sent.generation, sign.sent.id);
    await advance(314_999);
    expect(core().killed).toBeNull();
    await advance(1);
    expect(core().killed).toBe('SIGKILL');
    expect((await sign.pending).code).toBe('core_unavailable');
    release();
  });
});

describe("the device watchdog's form", () => {
  test('it goes alone, as a positive number of ms, and never for an idle method: refused in main, never sent', async () => {
    makeClient(coreWith());
    await client.start();
    const params = { key: LEDGER, tx: TX };
    const refused = [
      client.request('sign.transaction', params, SHELL, {
        deviceWatchdogMs: 315_000,
        watchdogMs: 15_000,
      }),
      ...[0, -1, 1.5, NaN, Infinity, '315000', false, {}].map((odd) =>
        client.request('sign.transaction', params, SHELL, { deviceWatchdogMs: odd })
      ),
      client.requestTo(client.current, 'sign.transaction', params, SHELL, {
        deviceWatchdogMs: 315_000,
        watchdogMs: 315_000,
      }),
      // Not for an idle method, alone or beside its idle watchdog.
      client.request('swarm.publish', {}, SHELL, { deviceWatchdogMs: 315_000 }),
      client.request('swarm.publish', {}, SHELL, {
        deviceWatchdogMs: 315_000,
        idleWatchdogMs: 75_000,
      }),
      // Nor an idle watchdog for a device request.
      client.request('ledger.add', {}, SHELL, { deviceWatchdogMs: 315_000, idleWatchdogMs: 1 }),
    ];
    for (const request of refused) {
      await expect(request).rejects.toMatchObject({ code: 'invalid_argument' });
    }
    await settle();
    expect(core().messages.map((m) => m.method)).toEqual(['core.hello']);
    expect(live()).toEqual([]);
    // The forms that go: requestTo takes it as request does.
    client
      .requestTo(client.current, 'ledger.add', {}, SHELL, { deviceWatchdogMs: 315_000 })
      .catch(() => {});
    client.request('ledger.accounts', {}, SHELL, { deviceWatchdogMs: 315_000 }).catch(() => {});
    await settle();
    expect(core().messages.map((m) => m.method)).toEqual([
      'core.hello',
      'ledger.add',
      'ledger.accounts',
    ]);
  });
});
