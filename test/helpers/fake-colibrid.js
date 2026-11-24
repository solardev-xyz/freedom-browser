/**
 * An in-process freedom-colibrid for main's tests (freedom-core design
 * 0014): a fake child process (stdio streams, `pid`, `kill()`, `exit` and
 * `close`) that speaks the service's frames on a two-way connection (COL-3):
 * main's requests and the service's own, with streams both ways through
 * frame.js's `StreamDuplex`, made as freedom-core's `service_duplex` vectors
 * model this side: a service's abort codes out, a piece's in, and every
 * frame read as `serviceKinds('both')` (no fragments).
 *
 * `fakeColibrid(script)` returns a `spawn` and the children it spawned.
 * Each child answers main's requests by what the script says, by method
 * without its `colibri.` prefix (`hello`, `request`, `checkpoint`,
 * `forget`, `stats`, `shutdown`, `cancel`), and the default otherwise:
 * - `hello`: fc-service's checks of main's params first (protocol 1, and
 *   `frames` naming `stream`), whose refusal is `protocol_mismatch` and an
 *   exit 76; then the service's result (`helloFor`: the chain `--chain`
 *   names);
 * - `request`: one step (`colibri.step`, then `colibri.stepped`), then
 *   `{ status: "success", result: null }`;
 * - `checkpoint`: one step, then `{ status: "error", stage: "decode", … }`;
 * - `forget`: `{}`; `stats`: `statsResult()`; `shutdown`: `{}`, then exit 0.
 *
 * A handler gets the message and the child, and answers through it:
 * - `child.result(id, result)`, `child.error(id, code, message, data)`
 *   (`data` as fc-protocol's ErrorBody carries it: the recycling
 *   refusal's `{ recycling: true }`);
 * - `child.step(request)`, `child.stepped(request)`: the step marker's
 *   events (design 0014, The step marker), and `child.serve(message,
 *   { steps, result, reply })`: that many steps, then the reply;
 * - `child.fetch(request, fields, options)`: `shell.colibri_fetch` to main
 *   (below);
 * - `child.head(id, result)`, then `child.body(id, bytes, { abort })`: a
 *   body to main, as 0007's (freedom-colibrid sends none; for the codes a
 *   service's bodies end with);
 * - `child.event(name, data)`, `child.writeRaw(bytes)`, `child.exit(code,
 *   signal)`; nothing, to hang.
 *
 * A handler runs inside main's write of the request, and what it writes
 * reaches main at once, before main's write returns: before the request's
 * `onSent`, which a real pipe never comes ahead of. A handler that writes a
 * step marker for the request it answers runs later (`setImmediate`), as
 * colibrid-client.test.js's do.
 *
 * **Main's cancel** of one of its requests: before the request's first
 * marker, which claims its commit point, the connection answers
 * `cancelled` itself (fc-service's `commit`); after it, the script's
 * `cancel` handler, if any, else `cancelled` at once, as a step that
 * returns does.
 *
 * **A fetch** (`child.fetch`) is the service's request to main, as
 * freedom-colibrid's `request.rs` makes it: its own ID (from 1), params
 * `{ request, type, method, path, payload?, accept, exclude_mask,
 * max_age? }`, and `ask_reserving`'s rules for main's answer. It returns a
 * `FakeFetch`, whose `done` resolves to `{ bytes, node }` or `{ error }`
 * with the service's texts (`FETCH_TEXTS`):
 * - a head that opens a body (`body: true`) is reserved before any of the
 *   body is taken: its `bytes`, at most `maxBody` (16 MiB), and `reserve`
 *   (true, false, or a function of the head) agreeing. Otherwise the
 *   fetch is cancelled at once and fails `Colibri fetch busy`;
 * - the head's `error`, main's error reply's message, a head that opens
 *   no body (`Colibri fetch has no body`);
 * - the body, taken as it comes, its credit returned as it is taken: a
 *   `paused` fetch takes nothing, so main's window fills, until
 *   `resume()`. More bytes than the head said, or fewer at its end, fail
 *   `Colibri body length mismatch` (past the length with a cancel); main's
 *   abort fails `Colibri fetch body aborted`;
 * - `deadlineMs` bounds main's reply, as the request's deadline does:
 *   past it, the fetch is cancelled and fails `Colibri fetch deadline
 *   passed`; `cancel()` lets go of it (a cancel to main);
 * - the child's exit fails what is open with `Colibri service closing`.
 *
 * **Exits.** `child.exit(code, signal)` emits `exit` at once, then ends
 * stdout and emits `close`. After `child.holdOutput()`, what the child
 * writes stays in its pipe until it exits, and is read after the `exit`
 * and before the `close`: a marker written just before a death, which a
 * real pipe still holds when main sees the exit. After `child.holdExit()`,
 * neither `colibri.shutdown` nor stdin's EOF ends the child: it exits when
 * the test says, or main kills it. `child.kill()` exits with the signal,
 * as a killed process does.
 *
 * Each child records `requests` (main's, in order), `cancels` (main's),
 * `fetches` (its own), `events`, `terminals` (how main's bodies ended), the
 * `credited` bytes main returned for its bodies, and `protocolError`: the
 * category, if main broke the protocol, after which it exits 76 as
 * fc-service does. A handler that throws is a panic: `failures` holds it,
 * and the child exits 70.
 *
 * `testService(extra)` is main's side for a test's ServiceClient: the
 * service configuration it speaks to a fake child with, two-way
 * (`SERVICE_DUPLEX`), with `extra` over it. colibrid-client.js's is the
 * real one.
 *
 * `checkpointCheck(message, child, { decode, verify })` runs one
 * `colibri.checkpoint` as freedom-colibrid's `checkpoint.rs` does, for a
 * script's `checkpoint` handler (below).
 */

const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const {
  encodeFrame,
  FrameDecoder,
  FrameError,
  StreamDuplex,
  serviceKinds,
  JSON_KINDS,
  KIND_ABORT,
  KIND_END,
  KIND_JSON,
  KIND_STREAM_CREDIT,
  MAX_PULL,
  PIECE_ABORT_CODES,
  SERVICE_ABORT_CODES,
} = require('../../src/main/core/frame');
const { SERVICE_DUPLEX } = require('../../src/main/core/service-client');

const json = (value) => Buffer.from(JSON.stringify(value));
const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The service's texts for a fetch that failed (`request.rs`). */
const FETCH_TEXTS = Object.freeze({
  busy: 'Colibri fetch busy',
  mismatch: 'Colibri body length mismatch',
  noBody: 'Colibri fetch has no body',
  aborted: 'Colibri fetch body aborted',
  closing: 'Colibri service closing',
  deadline: 'Colibri fetch deadline passed',
  head: "Colibri fetch head doesn't parse",
});

/** The largest body a fetch takes (`request.rs`'s `MAX_BODY`). */
const MAX_BODY = 16 * 1024 * 1024;

/** The confinement a fake process reports (freedom-core design 0010): no
 * network at all, so nothing to resolve. */
const CONFINEMENT = Object.freeze({
  mechanism: 'landlock-4+seccomp',
  files: 'enforced',
  exec: 'enforced',
  ipc: 'partial',
  network: 'enforced',
  gaps: ['signals'],
  reasons: {},
  resolution: null,
});

/** freedom-colibrid's hello (`service.rs`), as colibrid-v0.1.1 answers it:
 * its own release first (`service_version`), then the C core's. */
const HELLO = Object.freeze({
  protocol: 1,
  service_version: '0.1.1',
  colibri_version: '3.0.3',
  client_version: 196611,
  chain_id: 1,
  build: Object.freeze({ op: false, zk: true, prover: false, verify_flags: 2 }),
  network: 'offline',
  confinement: CONFINEMENT,
});

/** The chain `--chain` names in `args`, or null. */
function chainOf(args = []) {
  const at = args.indexOf('--chain');
  const chain = at < 0 ? NaN : Number(args[at + 1]);
  return Number.isSafeInteger(chain) && chain > 0 ? chain : null;
}

/** The hello a process spawned with `args` answers: its chain. */
function helloFor(args = []) {
  return { ...HELLO, chain_id: chainOf(args) ?? HELLO.chain_id };
}

/** Why fc-service refuses main's hello params, or null. */
function helloRefusal(params) {
  if (!isObject(params) || params.protocol !== HELLO.protocol) {
    return `protocol ${params?.protocol} is not this service's ${HELLO.protocol}`;
  }
  if (!Array.isArray(params.frames) || !params.frames.includes('stream')) {
    return 'main must take stream frames';
  }
  return null;
}

/**
 * Main's side for a test's ServiceClient (see the header): `colibri.hello`
 * at protocol 1 offering `stream`, a hello that answers protocol 1 offline
 * (its public part `{ protocol, chain_id }`), `colibri.shutdown`, no
 * fragments, and streams both ways with a service's kinds and codes.
 * `extra` goes over it (`{ duplex: undefined, streams: () => true }` for a
 * one-way connection).
 */
function testService(extra = {}) {
  return Object.freeze({
    label: '[Colibri]',
    noun: 'colibri service',
    unavailableCode: 'colibri_unavailable',
    protocol: 1,
    helloMethod: 'colibri.hello',
    helloParams: (client) => ({
      protocol: 1,
      shell_version: client.shellVersion,
      frames: ['stream'],
    }),
    validHello: (result) =>
      result?.protocol === 1 && result.network === 'offline'
        ? { protocol: 1, chain_id: result.chain_id }
        : null,
    shutdownMethod: 'colibri.shutdown',
    fragments: () => false,
    initialKinds: JSON_KINDS,
    maxPending: 512,
    duplex: () => true,
    ...SERVICE_DUPLEX,
    ...extra,
  });
}

/** A stats reply as the service writes it (`shared.rs`), with overrides. */
function statsResult(overrides = {}) {
  return {
    open_requests: 0,
    steps: 0,
    calls: 0,
    resident_bytes: 0,
    store_bytes: 0,
    store_keys: 0,
    recycling: false,
    ...overrides,
  };
}

/** One of the service's `shell.colibri_fetch` requests and main's answer. */
class FakeFetch {
  constructor(child, id, params, { reserve = true, maxBody = MAX_BODY, paused = false } = {}) {
    this.child = child;
    this.id = id;
    this.params = params;
    this.reserve = reserve;
    this.maxBody = maxBody;
    this.paused = paused;
    // Main's head, and the length it was reserved for (a body's only).
    this.head = null;
    this.declared = null;
    // Body bytes main sent, and those the service took.
    this.arrived = 0;
    this.received = 0;
    this.chunks = [];
    this.ended = false;
    this.outcome = null;
    this.timer = null;
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  /** Main's reply: its head, or its error. */
  onAnswer(message, opens) {
    if (!Object.hasOwn(message, 'result')) {
      this.settle({ error: String(message.error?.message) });
      return;
    }
    const head = message.result;
    this.head = head;
    if (opens) {
      // `ask_reserving`'s hook, before any of the body is taken.
      const { bytes } = head;
      const fits = Number.isSafeInteger(bytes) && bytes >= 0 && bytes <= this.maxBody;
      const reserved =
        fits && (typeof this.reserve === 'function' ? this.reserve(head) : this.reserve);
      if (!reserved) {
        this.child.duplex.withdraw(this.id);
        this.settle({ error: FETCH_TEXTS.busy });
        return;
      }
      this.declared = bytes;
    }
    // As freedom-colibrid's `Head`: `node` (a u16) defaults when absent,
    // and a present null doesn't parse; `error` (an Option) takes null.
    const node = isObject(head) && Object.hasOwn(head, 'node') ? head.node : 0;
    const error = head?.error ?? null;
    const parses =
      isObject(head) &&
      Number.isInteger(node) &&
      node >= 0 &&
      node <= 0xffff &&
      (error === null || typeof error === 'string');
    const failed = !parses ? FETCH_TEXTS.head : (error ?? (opens ? null : FETCH_TEXTS.noBody));
    if (failed !== null) {
      // Its body, if any, is let go of.
      if (opens) this.child.duplex.withdraw(this.id);
      this.settle({ error: failed });
      return;
    }
    this.node = node;
  }

  /** A frame of the body, as the duplex delivered it. */
  onStream(delivery) {
    if (this.outcome) return;
    if (delivery.type === 'data') {
      this.arrived += delivery.length;
      if (this.declared !== null && this.arrived > this.declared) {
        this.child.duplex.withdraw(this.id);
        this.settle({ error: FETCH_TEXTS.mismatch });
        return;
      }
      this.drain();
    } else if (delivery.type === 'end') {
      this.ended = true;
      if (delivery.drained) this.finish();
      else this.drain();
    } else if (delivery.type === 'abort') {
      this.settle({
        error: FETCH_TEXTS.aborted,
        abort: { code: delivery.code, message: delivery.message },
      });
    }
  }

  /** Takes what has come, returning its credit, unless paused. */
  drain() {
    while (!this.paused && !this.outcome) {
      const pulled = this.child.duplex.pull(this.id, MAX_PULL);
      if (!pulled) {
        if (this.ended) this.finish();
        return;
      }
      if (pulled.chunk.length) {
        this.chunks.push(Buffer.from(pulled.chunk));
        this.received += pulled.chunk.length;
      }
      if (pulled.eof) {
        this.finish();
        return;
      }
      if (!pulled.chunk.length) return;
    }
  }

  finish() {
    if (this.declared !== null && this.received !== this.declared) {
      this.settle({ error: FETCH_TEXTS.mismatch });
      return;
    }
    this.settle({ bytes: Buffer.concat(this.chunks), node: this.node });
  }

  /** Stops taking the body: main's window fills. */
  pause() {
    this.paused = true;
  }

  /** Takes the body again, and returns its credit. */
  resume() {
    this.paused = false;
    this.drain();
    this.child.pump();
  }

  /** The service lets go of the fetch: a cancel to main, unless its body
   * has ended. */
  cancel() {
    if (this.outcome) return;
    this.child.duplex.withdraw(this.id);
    this.settle({ cancelled: true, received: this.received });
    this.child.pump();
  }

  /** Main's reply must come within `ms`, or the fetch is cancelled. */
  armDeadline(ms) {
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.outcome || this.head) return;
      this.child.duplex.withdraw(this.id);
      this.settle({ error: FETCH_TEXTS.deadline });
      this.child.pump();
    }, ms);
  }

  settle(outcome) {
    if (this.outcome) return;
    this.outcome = outcome;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.child.asks.delete(this.id);
    this.resolve(outcome);
  }
}

class FakeColibridChild extends EventEmitter {
  constructor(script, args, pid) {
    super();
    this.script = script;
    this.args = args;
    this.chain = chainOf(args);
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.requests = [];
    this.cancels = [];
    this.fetches = [];
    this.events = [];
    // The ends of main's bodies, as they came: `{ id, type: 'end' }` or
    // `{ id, type: 'abort', code }`, a fetch let go of included.
    this.terminals = [];
    this.failures = [];
    this.credited = 0;
    this.protocolError = null;
    this.exited = false;
    this.stdinClosed = false;
    // Output kept in the pipe until the exit (`holdOutput`), or null.
    this.held = null;
    // Set by `holdExit`: main's shutdown doesn't end the child.
    this.exitHeld = false;
    // Main's requests past their commit point: a marker was written.
    this.committed = new Set();
    // The service's own requests, by its ID, until they settle.
    this.asks = new Map();
    this.nextAsk = 1;
    this.producers = new Map(); // id -> { bytes, offered, abortAt, code }
    this.duplex = new StreamDuplex({ sends: SERVICE_ABORT_CODES, takes: PIECE_ABORT_CODES });
    const decoder = new FrameDecoder({ kinds: serviceKinds('both') });
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (!this.exited) {
          try {
            for (const frame of decoder.push(chunk)) {
              if (this.exited) break;
              this.onFrame(frame);
            }
            this.pump();
          } catch (err) {
            if (err instanceof FrameError) this.broke(err.category);
            else this.panic(err);
          }
        }
        callback();
      },
      final: (callback) => {
        this.stdinClosed = true;
        // fc-service: stdin's EOF ends the connection, and the process
        // exits 0.
        if (!this.exitHeld) setImmediate(() => this.exit(0));
        callback();
      },
    });
  }

  onFrame(frame) {
    if (frame.kind !== KIND_JSON) {
      const delivery = this.duplex.receive(frame);
      if (frame.kind === KIND_STREAM_CREDIT) {
        this.credited += frame.credit;
        return;
      }
      if (frame.kind === KIND_END) this.terminals.push({ id: frame.id, type: 'end' });
      if (frame.kind === KIND_ABORT) {
        this.terminals.push({ id: frame.id, type: 'abort', code: frame.code });
      }
      this.asks.get(delivery.id)?.onStream(delivery);
      return;
    }
    const { message } = frame;
    if (message.type === 'response') {
      this.onAnswer(message);
    } else if (message.type === 'cancel') {
      this.onCancel(message);
    } else if (message.type === 'request') {
      this.requests.push(message);
      this.duplex.request(message.id);
      this.answer(message);
    } else {
      throw new FrameError('unknown_type');
    }
  }

  /** Main's reply to one of the service's requests. */
  onAnswer(message) {
    const { id } = message;
    const opens =
      Object.hasOwn(message, 'result') && isObject(message.result) && message.result.body === true;
    // A reply to no request of the service's is a protocol error.
    const replied = this.duplex.answered(id, opens);
    const ask = this.asks.get(id);
    // Let go of before it came: dropped, and its body with it.
    if (replied !== 'deliver' || !ask) return;
    ask.onAnswer(message, opens);
  }

  /** Main's cancel of one of its requests. */
  onCancel(message) {
    this.cancels.push(message.id);
    if (!this.committed.has(message.id)) {
      // Before the commit point the connection answers it.
      this.duplex.cancel(message.id);
      return;
    }
    const handler = this.script.cancel;
    if (handler) {
      handler(message, this);
      return;
    }
    this.error(message.id, 'cancelled', 'cancelled');
  }

  /** Answers one of main's requests: the script's handler for its method,
   * or the default. */
  answer(message) {
    const method = message.method.replace(/^colibri\./, '');
    if (method === 'hello') {
      const refusal = helloRefusal(message.params);
      if (refusal) {
        this.error(message.id, 'protocol_mismatch', refusal);
        setImmediate(() => this.exit(76));
        return;
      }
    }
    const handler = this.script[method];
    if (handler) {
      handler(message, this);
      return;
    }
    switch (method) {
      case 'hello':
        this.result(message.id, helloFor(this.args));
        break;
      case 'request':
        this.serve(message);
        break;
      case 'checkpoint':
        this.serve(message, {
          reply: { status: 'error', stage: 'decode', error: 'no checkpoint scripted' },
        });
        break;
      case 'forget':
        this.result(message.id, {});
        break;
      case 'stats':
        this.result(message.id, statsResult());
        break;
      case 'shutdown':
        this.result(message.id, {});
        if (!this.exitHeld) setImmediate(() => this.exit(0));
        break;
      default:
        this.error(message.id, 'unknown_method', 'unknown method');
    }
  }

  result(id, result) {
    const queued = this.duplex.sender.reply(id, json({ type: 'response', id, result }));
    this.pump();
    return queued;
  }

  error(id, code, message = code, data = undefined) {
    const error = data === undefined ? { code, message } : { code, message, data };
    const queued = this.duplex.sender.reply(id, json({ type: 'response', id, error }));
    this.pump();
    return queued;
  }

  /** The marker before a call into the C core for main's request
   * `request`: it claims the request's commit point. */
  step(request) {
    this.committed.add(request);
    this.event('colibri.step', { request });
  }

  /** The marker's clearing event, as the call returns. */
  stepped(request) {
    this.event('colibri.stepped', { request });
  }

  /** `steps` steps for main's request, then its reply: `reply`, or a
   * success with `result`. */
  serve(message, { steps = 1, result = null, reply = null } = {}) {
    for (let i = 0; i < steps; i++) {
      this.step(message.id);
      this.stepped(message.id);
    }
    return this.result(message.id, reply ?? { status: 'success', result });
  }

  /**
   * `shell.colibri_fetch` to main, for main's request `request`: `fields`
   * over the defaults (a `get` of the prover's root, as JSON). Options:
   * `reserve`, `maxBody`, `paused`, `deadlineMs` (see the header).
   * @returns {FakeFetch}
   */
  fetch(request, fields = {}, options = {}) {
    const id = this.nextAsk;
    this.nextAsk += 1;
    const params = {
      request,
      type: 'prover',
      method: 'get',
      path: '',
      accept: 'json',
      exclude_mask: 0,
      ...fields,
    };
    const ask = new FakeFetch(this, id, params, options);
    this.fetches.push(ask);
    if (this.exited) {
      ask.settle({ error: FETCH_TEXTS.closing });
      return ask;
    }
    this.asks.set(id, ask);
    this.duplex.ask(id);
    this.write(encodeFrame({ type: 'request', id, method: 'shell.colibri_fetch', params }));
    if (Number.isFinite(options.deadlineMs)) ask.armDeadline(options.deadlineMs);
    return ask;
  }

  /** A head for main's request `id`; one whose result says `body: true`
   * opens its stream once written. */
  head(id, result) {
    const queued = this.duplex.sender.head(
      id,
      json({ type: 'response', id, result }),
      result?.body === true
    );
    this.pump();
    return queued;
  }

  /** The body's bytes, as main's window allows; then its end, or with
   * `abort: { at, code }`, an abort once that many are queued. */
  body(id, bytes, { abort = null } = {}) {
    this.producers.set(id, {
      bytes,
      offered: 0,
      abortAt: abort ? abort.at : null,
      code: abort?.code,
    });
    this.pump();
  }

  event(event, data) {
    this.events.push({ event, data });
    this.write(encodeFrame({ type: 'event', event, data }));
  }

  /** Bytes written to main as they are: a frame main may refuse. */
  writeRaw(bytes) {
    this.write(bytes);
  }

  /** From now on, what the child writes stays in its pipe until it exits. */
  holdOutput() {
    this.held ??= [];
  }

  /** From now on, main's shutdown (`colibri.shutdown`, stdin's EOF) doesn't
   * end the child: `exit`, or main's kill, does. */
  holdExit() {
    this.exitHeld = true;
  }

  write(bytes) {
    if (this.exited) return;
    if (this.held) this.held.push(bytes);
    else this.stdout.write(bytes);
  }

  produce() {
    const sender = this.duplex.sender;
    for (const [id, p] of this.producers) {
      for (;;) {
        if (p.abortAt !== null && p.offered >= p.abortAt) {
          // The bytes before it go first: an abort purges what is queued.
          if (sender.queued(id)) break;
          sender.abort(id, p.code, 'scripted');
          this.producers.delete(id);
          break;
        }
        if (p.offered >= p.bytes.length) {
          sender.finish(id);
          this.producers.delete(id);
          break;
        }
        const limit = p.abortAt === null ? p.bytes.length : Math.min(p.bytes.length, p.abortAt);
        const pushed = sender.push(id, p.bytes.subarray(p.offered, limit));
        if (pushed.refused) {
          this.producers.delete(id);
          break;
        }
        p.offered += pushed.taken;
        if (pushed.taken === 0) break;
      }
    }
  }

  /** Writes what the duplex has: credit for main's bodies, the service's
   * cancels, its replies and heads, its bodies' frames. */
  pump() {
    if (this.exited) return;
    for (;;) {
      this.produce();
      const next = this.duplex.nextFrame();
      if (!next) return;
      this.write(next.bytes);
    }
  }

  /** Main broke the protocol: fc-service ends the connection, exit 76. */
  broke(category) {
    this.protocolError ??= category;
    this.stderr.write(`${JSON.stringify({ level: 'error', msg: 'protocol error', category })}\n`);
    this.exit(76);
  }

  /** A handler threw: a panic, exit 70. */
  panic(err) {
    this.failures.push(err);
    this.exit(70);
  }

  /** The process exits with `code` (null and `signal` for a kill). What its
   * pipe still holds (`holdOutput`) is read after the exit, then it closes. */
  exit(code, signal = null) {
    if (this.exited) return;
    this.exited = true;
    this.exitCode = code;
    this.exitSignal = signal;
    for (const ask of [...this.asks.values()]) ask.settle({ error: FETCH_TEXTS.closing });
    this.emit('exit', code, signal);
    setImmediate(() => {
      for (const bytes of this.held ?? []) this.stdout.write(bytes);
      this.held = null;
      this.stdout.end();
      this.stderr.end();
      setImmediate(() => this.emit('close', code, signal));
    });
  }

  kill(signal = 'SIGTERM') {
    this.killedWith = signal;
    setImmediate(() => this.exit(null, signal));
    return true;
  }

  /** Main's requests of `method`, in order. */
  sent(method) {
    return this.requests.filter((message) => message.method === method);
  }
}

/**
 * One `colibri.checkpoint`, as freedom-colibrid's `checkpoint.rs` runs it,
 * for a script's `checkpoint` handler: the proof asked of main once
 * (`checkpoint_proof`, a POST with no path, 4 MiB at most); `decode(bytes)`
 * inside a step (a throw, or nothing, is a proof that doesn't decode); then
 * `verify(lookup, bytes)`, whose `lookup(path)` is one checkpointz fetch
 * (64 KiB at most) giving its body parsed, and main's error as a throw. The
 * reply is `{ decoded, result }` (`verify`'s value), or `{ status: "error",
 * stage, error }` with the stage that failed (`decode` or `verify`, a throw's
 * message the error); then the process exits 0 (`exit: false` keeps it).
 * It starts once main's write has returned, as a real pipe's would.
 */
function checkpointCheck(message, child, { decode, verify, exit = true } = {}) {
  const id = message.id;
  const failed = (stage, error) => ({ status: 'error', stage, error });
  const run = async () => {
    const proof = await child.fetch(
      id,
      { type: 'checkpoint_proof', method: 'post', path: '', accept: 'ssz' },
      { maxBody: 4 * 1024 * 1024 }
    ).done;
    if (proof.error !== undefined) return failed('decode', proof.error);
    let decoded;
    child.step(id);
    try {
      decoded = await decode(proof.bytes);
    } catch {
      decoded = undefined;
    }
    child.stepped(id);
    if (decoded === undefined) return failed('decode', 'Unknown proof format');
    const lookup = async (path) => {
      const answer = await child.fetch(
        id,
        { type: 'checkpointz', method: 'get', path, accept: 'json' },
        { maxBody: 64 * 1024 }
      ).done;
      if (answer.error !== undefined) throw new Error(answer.error);
      return JSON.parse(answer.bytes.toString('utf8'));
    };
    try {
      const result = await verify(lookup, proof.bytes);
      return { decoded, result: result ?? null };
    } catch (err) {
      return failed('verify', String(err?.message ?? err));
    }
  };
  setImmediate(() => {
    run().then(
      (reply) => {
        if (child.exited) return;
        child.result(id, reply);
        if (exit) setImmediate(() => child.exit(0));
      },
      (err) => child.panic(err)
    );
  });
}

/**
 * A `spawn` that starts fake freedom-colibrid children: `script` answers,
 * by method, for every child; `children` lists them, with the command,
 * args and options each was spawned with (`spawned`).
 */
function fakeColibrid(script = {}) {
  const children = [];
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new FakeColibridChild(script, args, 7000 + children.length);
    children.push(child);
    spawned.push({ command, args, options });
    return child;
  };
  return { spawn, children, spawned, script };
}

module.exports = {
  checkpointCheck,
  fakeColibrid,
  FakeColibridChild,
  FakeFetch,
  helloFor,
  helloRefusal,
  statsResult,
  testService,
  CONFINEMENT,
  FETCH_TEXTS,
  HELLO,
  MAX_BODY,
};
