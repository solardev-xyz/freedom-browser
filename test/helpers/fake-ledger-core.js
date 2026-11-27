/**
 * A scripted freedom-cored for main's Ledger relay (freedom-core design
 * 0016, LDG-3; `src/main/core/ledger-relay.js`), and a scripted device
 * behind the relay that records every byte it is sent (the transport spy).
 *
 * **The core** answers the hello at protocol 2 and the shutdown, sends the
 * core's `shell.ledger_apdu { for, apdu, deadline_ms }` for the parents main
 * sent, cancels them, and reads main's answers as cored 0.30.0 reads them:
 * `readLedgerReply` is `crates/freedom-cored/src/ledger/reply.rs`'s `read`
 * at b4e0cef4, rule for rule (the result's three forms; `hash_only` only on
 * a `6D00` to the operation's first `E0 1A`; main's two errors, a refusal's
 * `data` exactly `{ rule }` with one of the seven rules; an answer of 2 to
 * 260 bytes), with the serialized bound (`REPLY_BOUND`, 584 bytes) and the
 * lane's own rule that `cancelled` answers only an APDU it cancelled
 * (lane.rs, `Protocol::Uncancelled`). Each reply the core would take as a
 * protocol error is kept in `faults` (its category, as the core logs it),
 * so a suite asserts there are none. Which APDU was the operation's first
 * `E0 1A` the core knows as it sends each, as the lane does.
 *
 * `batch(fn)` writes everything `fn` sends in one chunk, as the core's
 * writer does with frames written back to back (a cancel and the next
 * operation's first APDU). Main's own requests (the parents) stay
 * unanswered until `respond()` or `fail()`; its cancels of them are in
 * `messages`.
 *
 * **The device** (`fakeLedgerDevices()`): `openDevice()` is the relay's
 * seam, one device per operation, with hid-device.js's interface:
 * `exchange(apdu, ms, signal)` and `detach()`, which lets go of an exchange
 * in flight at once (it rejects `{ failure: 'disconnected', detached: true }`,
 * as HidDevice's does). `respond(apdu, { device, index })` scripts each
 * answer: hex or bytes, `{ hold: true }` (the device waits for the user:
 * `release(answer)` answers it later, if anyone still listens), or
 * `{ fail: '<failure>' }`. `events` is the order of opens, exchanges (each
 * APDU's hex: the spy), answers, failures, detaches and dropped late
 * answers, across every device.
 *
 * `startLedgerCore()` runs a real CoreClient against the core, with the
 * relay registered (`registerLedgerRelay`) on the core's backend and the
 * device behind it, both on a test's clock (`fakeClock`) or on timers that
 * never fire; `parentOf()` sends one of main's requests and opens it
 * in the relay from its `onSent`, as LDG-3's senders will.
 */

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const timers = require('timers');
const { CoreClient } = require('../../src/main/core/core-client');
const {
  encodeFrame,
  CORE_KINDS,
  CORE_STREAM_KINDS,
  FrameDecoder,
  KIND_JSON,
} = require('../../src/main/core/frame');
const { registerLedgerRelay } = require('../../src/main/core/ledger-relay');
const { HidDeviceError } = require('../../src/main/wallet/ledger/hid-device');

const tick = () => new Promise((resolve) => timers.setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// The core's reader (reply.rs at b4e0cef4)

/** fc-ledger's answer bounds. */
const MIN_ANSWER = 2;
const MAX_ANSWER = 260;
/** reply.rs's ENVELOPE + LARGEST_RESULT: the largest reply main may write. */
const REPLY_BOUND =
  '{"type":"response","id":,"result":}'.length + 16 + '{"answer":""}'.length + 2 * MAX_ANSWER;
const FAILED = new Set(['not_found', 'busy', 'disconnected', 'unresponsive', 'timeout']);
const RULES = new Set(['parent', 'order', 'header', 'count', 'path', 'payload', 'ended']);
const ASKED = Object.freeze({ FIRST_DEFINITION: 'first-definition', OTHER: 'other' });

class ReplyFault extends Error {
  constructor(category) {
    super(category);
    this.category = category;
  }
}

const fault = (category) => {
  throw new ReplyFault(category);
};
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** reply.rs's `unhex`: hex digit pairs, either case, no prefix. */
function unhex(text) {
  if (text.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(text)) return null;
  return Buffer.from(text, 'hex');
}

function readResult(result, asked) {
  if (!isObject(result)) fault('ledger_reply_form');
  const names = Object.keys(result);
  if (names.some((name) => name !== 'answer' && name !== 'hash_only' && name !== 'failed')) {
    fault('ledger_reply_form');
  }
  const has = (name) => Object.hasOwn(result, name);
  if (has('failed') && !has('answer') && !has('hash_only')) {
    if (typeof result.failed !== 'string' || !FAILED.has(result.failed)) fault('ledger_reply_type');
    return { failed: result.failed };
  }
  if (has('answer') && !has('failed')) {
    if (typeof result.answer !== 'string') fault('ledger_reply_type');
    const answer = unhex(result.answer);
    if (answer === null) fault('ledger_reply_type');
    let shown = false;
    if (has('hash_only')) {
      if (result.hash_only !== 'shown') fault('ledger_reply_type');
      shown = true;
    }
    if (answer.length < MIN_ANSWER || answer.length > MAX_ANSWER) fault('ledger_answer_bounds');
    if (shown && (asked !== ASKED.FIRST_DEFINITION || answer.toString('hex') !== '6d00')) {
      fault('ledger_hash_only');
    }
    return { answer, hashOnlyShown: shown };
  }
  return fault('ledger_reply_form');
}

function readError(error) {
  if (!isObject(error)) fault('ledger_reply_error');
  const names = Object.keys(error);
  if (names.some((name) => name !== 'code' && name !== 'message' && name !== 'data')) {
    fault('ledger_reply_error');
  }
  if (typeof error.code !== 'string' || typeof error.message !== 'string') {
    fault('ledger_reply_error');
  }
  const data = error.data ?? null;
  if (error.code === 'cancelled' && data === null) return { cancelled: true };
  if (error.code === 'invalid_argument' && data !== null) {
    if (!isObject(data)) fault('ledger_reply_error');
    const members = Object.keys(data);
    if (members.length !== 1 || members[0] !== 'rule' || typeof data.rule !== 'string') {
      fault('ledger_reply_error');
    }
    if (!RULES.has(data.rule)) fault('ledger_reply_error');
    return { refused: data.rule };
  }
  return fault('ledger_reply_error');
}

/**
 * Main's response to one `shell.ledger_apdu`, read as the core reads it
 * (reply.rs `read`, and the transport's bound before it): `{ answer,
 * hashOnlyShown }`, `{ failed }`, `{ refused: rule }` or `{ cancelled }`.
 * Throws a ReplyFault, whose `category` is the core's, for anything else.
 * `asked` is ASKED.FIRST_DEFINITION for the operation's first `E0 1A`.
 * Main writes each response with one `JSON.stringify`, so the text is the
 * parsed message's, stringified again.
 */
function readLedgerReply(response, asked = ASKED.OTHER) {
  if (Buffer.byteLength(JSON.stringify(response), 'utf8') > REPLY_BOUND) {
    fault('ledger_reply_bound');
  }
  const hasResult = Object.hasOwn(response, 'result');
  const hasError = Object.hasOwn(response, 'error');
  if (hasResult === hasError) fault('ledger_reply_form');
  return hasResult ? readResult(response.result, asked) : readError(response.error);
}

// ---------------------------------------------------------------------------
// The core

class FakeLedgerCore extends EventEmitter {
  constructor() {
    super();
    this.pid = 4516;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.messages = [];
    this.killed = null;
    this.nextId = 1;
    // Its own asks, by ID: `{ params, asked, cancelled, reply, read }`.
    this.asks = new Map();
    // The parents whose first E0 1A has gone (lane.rs `defined`).
    this.defined = new Set();
    // Replies the core would take as a protocol error, by category.
    this.faults = [];
    this.batched = null;
    // Main's frames of any other kind than JSON (none are expected).
    this.frames = [];
    this.decoder = new FrameDecoder({ kinds: CORE_KINDS });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        for (const frame of this.decoder.push(chunk)) {
          // Main's replies to the lane are at most 584 bytes: never
          // fragmented, and no stream is opened for them.
          if (frame.kind !== KIND_JSON) {
            this.frames.push(frame);
            continue;
          }
          this.onMessage(frame.message);
        }
        callback();
      },
      final: (callback) => {
        callback();
        setImmediate(() => this.exit(0));
      },
    });
  }

  onMessage(message) {
    this.messages.push(message);
    if (message?.type === 'response' && this.asks.has(message.id)) {
      this.read(message);
      return;
    }
    if (message?.method === 'core.hello') {
      this.send({
        type: 'response',
        id: message.id,
        result: {
          protocol: 2,
          core_version: '0.30.0',
          capabilities: ['vault.status', 'fragments', 'streams', 'ledger.accounts', 'ledger.add'],
        },
      });
      this.decoder.setKinds(CORE_STREAM_KINDS);
    } else if (message?.method === 'core.shutdown') {
      this.send({ type: 'response', id: message.id, result: {} });
    }
  }

  /** Main's response to one of its asks, read as the core reads it. */
  read(message) {
    const ask = this.asks.get(message.id);
    if (ask.reply) {
      this.faults.push({ id: message.id, category: 'ledger_reply_twice' });
      return;
    }
    ask.reply = message;
    try {
      ask.read = readLedgerReply(message, ask.asked);
      if (ask.read.cancelled && !ask.cancelled) {
        this.faults.push({ id: message.id, category: 'ledger_uncancelled' });
      }
    } catch (err) {
      if (!(err instanceof ReplyFault)) throw err;
      this.faults.push({ id: message.id, category: err.category });
    }
  }

  send(message) {
    const frame = encodeFrame(message);
    if (this.batched) this.batched.push(frame);
    else this.stdout.write(frame);
  }

  /** Everything `fn` sends goes in one chunk. */
  batch(fn) {
    this.batched = [];
    try {
      fn();
    } finally {
      const frames = this.batched;
      this.batched = null;
      this.stdout.write(Buffer.concat(frames));
    }
  }

  /** A request of the core's with any params: its ID. */
  ask(method, params) {
    const id = this.nextId++;
    this.asks.set(id, { params, asked: ASKED.OTHER, cancelled: false, reply: null, read: null });
    this.send({ type: 'request', id, method, params });
    return id;
  }

  /** `shell.ledger_apdu { for, apdu, deadline_ms }`: its ID. */
  apdu(forId, apdu, deadlineMs = 15_000) {
    const hex = Buffer.isBuffer(apdu) ? apdu.toString('hex') : apdu;
    const definition = hex.slice(0, 4) === 'e01a';
    const first = definition && !this.defined.has(forId);
    if (definition) this.defined.add(forId);
    const id = this.ask('shell.ledger_apdu', { for: forId, apdu: hex, deadline_ms: deadlineMs });
    if (first) this.asks.get(id).asked = ASKED.FIRST_DEFINITION;
    return id;
  }

  /** The core's cancel of its ask `id`. */
  cancel(id) {
    const ask = this.asks.get(id);
    if (ask) ask.cancelled = true;
    this.send({ type: 'cancel', id });
  }

  /** Main's response to the core's ask `id` as the core read it, once it has come. */
  reply(id) {
    return this.asks.get(id)?.read ?? null;
  }

  /** Main's raw response to the core's ask `id`. */
  raw(id) {
    return this.asks.get(id)?.reply ?? null;
  }

  /** Answers main's own request `id`. */
  respond(id, result = {}) {
    this.send({ type: 'response', id, result });
  }

  /** Fails main's own request `id`. */
  fail(id, error = { code: 'cancelled', message: 'Cancelled' }) {
    this.send({ type: 'response', id, error });
  }

  /** Main's requests named `method`. */
  requests(method) {
    return this.messages.filter((m) => m?.type === 'request' && m.method === method);
  }

  /** Main's cancels of its own requests. */
  cancels() {
    return this.messages.filter((m) => m?.type === 'cancel').map((m) => m.id);
  }

  /** Where main's message `predicate` picks is in the order main wrote them. */
  indexOf(predicate) {
    return this.messages.findIndex(predicate);
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
}

// ---------------------------------------------------------------------------
// The device

const OK = '9000';

/**
 * Scripted devices behind the relay: `openDevice` for its seam,
 * `respond(apdu, { device, index })` for each answer (default `9000`),
 * `events` the spy.
 */
function fakeLedgerDevices({ respond = () => OK } = {}) {
  const devices = [];
  const events = [];
  const held = [];
  const state = { respond };

  class FakeLedgerDevice {
    constructor(number) {
      this.number = number;
      this.detached = false;
      this.pending = null;
      this.exchanges = 0;
    }

    exchange(apdu, ms, signal = null) {
      return new Promise((resolve, reject) => {
        if (!(apdu instanceof Uint8Array) || apdu.length < 5 || apdu.length > 260) {
          throw new TypeError('An APDU is 5 to 260 bytes');
        }
        if (ms !== 15_000 && ms !== 300_000) throw new TypeError('deadline_ms is 15000 or 300000');
        if (this.detached) throw new Error('This operation has ended: the next opens a new device');
        if (this.pending) throw new Error('One exchange at a time');
        const pending = { resolve, reject, signal, onAbort: null };
        this.pending = pending;
        if (signal) {
          if (signal.aborted) {
            this.detach();
            return;
          }
          pending.onAbort = () => this.detach();
          signal.addEventListener('abort', pending.onAbort, { once: true });
        }
        const index = this.exchanges++;
        const bytes = Buffer.from(apdu);
        events.push({ type: 'exchange', device: this.number, apdu: bytes.toString('hex'), ms });
        let script;
        try {
          script = state.respond(bytes, { device: this.number, index });
        } catch (err) {
          this.settle(pending, err);
          return;
        }
        if (script && typeof script === 'object' && !Buffer.isBuffer(script)) {
          if (script.hold) {
            held.push({ device: this, pending });
            return;
          }
          if (script.fail) {
            events.push({ type: 'failed', device: this.number, failure: script.fail });
            this.settle(pending, new HidDeviceError(script.fail));
            return;
          }
          if (script.throw) {
            this.settle(pending, script.throw);
            return;
          }
        }
        const answer = Buffer.isBuffer(script) ? script : Buffer.from(script, 'hex');
        // A device answers a moment later, as a host's frame does.
        timers.setImmediate(() => this.answer(pending, answer));
      });
    }

    answer(pending, answer) {
      if (this.pending !== pending) {
        events.push({ type: 'late', device: this.number, answer: answer.toString('hex') });
        return;
      }
      events.push({ type: 'answer', device: this.number, answer: answer.toString('hex') });
      this.settle(pending, null, answer);
    }

    detach() {
      if (!this.detached) {
        this.detached = true;
        events.push({ type: 'detach', device: this.number, inFlight: Boolean(this.pending) });
      }
      const { pending } = this;
      if (pending) {
        this.settle(pending, new HidDeviceError('disconnected', { detached: true }));
      }
    }

    settle(pending, err, answer) {
      if (pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
      if (this.pending === pending) this.pending = null;
      if (err) pending.reject(err);
      else pending.resolve(answer);
    }
  }

  return {
    devices,
    events,
    held,
    set respond(fn) {
      state.respond = fn;
    },
    openDevice() {
      const device = new FakeLedgerDevice(devices.length + 1);
      devices.push(device);
      events.push({ type: 'open', device: device.number });
      return device;
    },
    /** Answers the oldest held exchange, whoever still listens. */
    release(answer = OK) {
      const next = held.shift();
      if (!next) throw new Error('no held exchange');
      next.device.answer(next.pending, Buffer.from(answer, 'hex'));
    },
    /** Every APDU that reached a device, in hex, in order. */
    bytes() {
      return events.filter((e) => e.type === 'exchange').map((e) => e.apdu);
    },
    of(type) {
      return events.filter((e) => e.type === type);
    },
  };
}

// ---------------------------------------------------------------------------
// The client and the parents

/**
 * A CoreClient against a FakeLedgerCore, with the relay registered on the
 * core's backend and `devices` behind it (`deps` are its other seams), and
 * started: `{ client, relay, devices, core() }`, `core()` the current
 * process.
 */
async function startLedgerCore({
  log,
  devices = fakeLedgerDevices(),
  deps = {},
  clock = null,
} = {}) {
  const children = [];
  // A clock of the test's own (`fakeClock`), or timers that never fire.
  const timing = clock ?? {
    now: () => 0,
    setTimer: (fn, ms) => ({ fn, ms }),
    clearTimer: () => {},
  };
  const client = new CoreClient({
    spawn: () => {
      const child = new FakeLedgerCore();
      children.push(child);
      return child;
    },
    command: '/bin/freedom-cored',
    args: ['serve'],
    log,
    shellVersion: 'test',
    grantRoot: os.tmpdir(),
    ...(clock ?? { setTimer: timing.setTimer, clearTimer: timing.clearTimer }),
  });
  const relay = registerLedgerRelay(client, {
    log,
    backendKind: () => 'core',
    openDevice: () => devices.openDevice(),
    now: timing.now,
    setTimer: timing.setTimer,
    clearTimer: timing.clearTimer,
    ...deps,
  });
  await client.start();
  return { client, relay, devices, core: () => children[children.length - 1] };
}

/**
 * Sends one of main's requests, `method` with `params` (the scripted core
 * reads none of them), under a controller of its own, and opens it in the
 * relay from its `onSent` with `capture` (`prepared`, or what to prepare,
 * and `beforeSign`, `hashOnlySurface`): `{ id, generation, handle,
 * controller, error, outcome }`, `outcome` main's request's settlement.
 */
function parentOf(client, relay, { method, params, capture = {} }) {
  const controller = capture.controller ?? new AbortController();
  const out = { id: null, generation: null, handle: null, error: null, controller, outcome: null };
  out.answered = client
    .request(
      method,
      params,
      { caller: 'shell' },
      {
        signal: controller.signal,
        onSent: (id, generation) => {
          out.id = id;
          out.generation = generation;
          try {
            out.handle = relay.open({ id, generation }, { method, params, ...capture, controller });
          } catch (err) {
            out.error = err;
          }
        },
      }
    )
    .then(
      (result) => {
        out.outcome = { result };
      },
      (error) => {
        out.outcome = { error };
      }
    )
    .finally(() => out.handle?.close());
  return out;
}

/** Waits for `predicate`, up to about `ms` of real time, in real turns. */
async function until(predicate, what, ms = 4000) {
  for (let waited = 0; waited <= ms; waited += 1) {
    for (let i = 0; i < 20; i++) {
      if (predicate()) return;
      await tick();
    }
    await sleep(1);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A few real turns of the event loop. */
async function settle(turns = 30) {
  for (let i = 0; i < turns; i++) await tick();
}

/**
 * A clock for the client and the relay (`now`, `setTimer`, `clearTimer`),
 * moved on only by `advance(ms)`, which fires each timer due by then in
 * turn, with real turns of the event loop after each.
 */
function fakeClock() {
  let now = 0;
  const timersDue = [];
  const live = () => timersDue.filter((t) => !t.cleared && !t.fired);
  return {
    now: () => now,
    setTimer: (fn, ms) => {
      const timer = { fn, at: now + ms, cleared: false, fired: false };
      timersDue.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    pending: () => live().length,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const [due] = live()
          .filter((t) => t.at <= end)
          .sort((a, b) => a.at - b.at);
        if (!due) break;
        now = due.at;
        due.fired = true;
        due.fn();
        await settle(20);
      }
      now = end;
      await settle(20);
    },
  };
}

module.exports = {
  ASKED,
  FakeLedgerCore,
  REPLY_BOUND,
  ReplyFault,
  fakeClock,
  fakeLedgerDevices,
  parentOf,
  readLedgerReply,
  settle,
  sleep,
  startLedgerCore,
  tick,
  until,
};
