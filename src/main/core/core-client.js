/**
 * Client for the freedom-cored child process (freedom-core design 0001,
 * "Process model" and "Messages").
 *
 * One CoreClient supervises one profile's core:
 * - spawn with a scrubbed environment and stdio pipes;
 * - `core.hello` within 10 s;
 * - JSON requests framed over stdin/stdout;
 * - events from the core;
 * - restarts after 0.5 s, 2 s, then 10 s, until three crashes within 60 s;
 * - no restart after a protocol mismatch, a requested stop, or the exit
 *   codes that mean "don't retry" (64 usage, 74 storage, 75 lock held).
 *
 * **Generations.** Each child is one `Generation` record: its pending
 * requests, its writer budget, its decoder, stderr and timers. Its lifecycle
 * is live → exited (the process is gone; stdout may still hold final
 * replies, which are delivered) → retired (stdio closed; remaining requests
 * are rejected). Nothing from an exited or retired generation can emit
 * events or make the client ready, and callbacks of a retired generation do
 * nothing.
 *
 * **Stopping is sticky.** Once `stop()` is called, no handshake, timer or
 * exit can make the client ready or restart it, until `start()` is called
 * again after the stop completed.
 *
 * **Fragmented responses** (design 0005, Frames): main's hello offers
 * them, so a response of the core's over one frame, up to 32 MiB, comes as a
 * begin, fragments and a last fragment. Its bytes are reserved at the begin,
 * which must name a pending request while the core holds main's bulk credit.
 * Main returns the credit (`0x13`) once the request's caller has the
 * response. Every malformed sequence is a protocol fault. The other way, a
 * reply to one of the core's requests over one frame goes fragmented, if the
 * core offered `fragments`: begun only while main holds the core's credit,
 * then written to its end, with whole frames going first and between its
 * fragments.
 *
 * **Main's cancels** (0001): a request sent with a `signal` is cancelled
 * when it aborts. Its caller gets `cancelled` at once, and the core a
 * `cancel`; the core's one response still comes, and is consumed and
 * dropped.
 *
 * **Main's chain I/O pool** (design 0005, Main's pool): 192 MiB for what
 * main holds for the core until it is written. Handlers charge the bodies
 * they read and the results they hold; a reply of 64 KiB or more is charged
 * from serialization until written or dropped. Past it, a reply is `busy`.
 * Control frames (credit, cancels, shutdown) and smaller replies are never
 * held back by it.
 *
 * **Logs** carry fixed categories and validated public fields only: never
 * request or response bodies, peer-supplied IDs, types or error text.
 */

const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const {
  encodeBegin,
  encodeCredit,
  encodeFrame,
  encodeJsonFrame,
  frameHeader,
  FrameDecoder,
  FrameError,
  KIND_FRAGMENT,
  KIND_LAST,
  MAX_MESSAGE,
  MAX_PAYLOAD,
  Reassembler,
} = require('./frame');

const PROTOCOL_VERSION = 1;
const MAX_ID = Number.MAX_SAFE_INTEGER; // 2^53 - 1: exact in JS
const HELLO_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;
// After the process exits, how long its stdout may take to close.
const DRAIN_MS = 2_000;
const RESTART_DELAYS_MS = [500, 2_000, 10_000];
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
// sysexits codes after which the core must not be restarted: usage (64),
// storage or refused filesystem (74), lock held by another process (75).
// 76 (protocol) is restarted under the crash policy, unless the handshake
// reported a protocol mismatch.
const NO_RESTART_EXIT_CODES = new Set([64, 74, 75]);
// Admission limits per generation. Control frames (hello, shutdown) don't
// count, so they always get through.
const MAX_PENDING = 256;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
// A failed SIGKILL is retried this often, this many times in all.
const KILL_RETRY_MS = 1_000;
const MAX_KILL_ATTEMPTS = 3;
// The longest stderr line kept; longer lines are truncated.
const MAX_STDERR_LINE = 16 * 1024;
const MAX_FORWARDED_TEXT = 1024;
const LOG_LEVELS = { error: 'error', warn: 'warn', info: 'info', debug: 'info' };
const EVENT_NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
// The core's requests to main (`shell.*`, design 0004): at most this many
// are outstanding, as the core bounds them.
const METHOD_NAME = EVENT_NAME;
const MAX_INCOMING = 256;
// Main's chain I/O pool (design 0005, Main's pool): what main holds for the
// core until it is written. Handlers charge the bodies they read and the
// verifier results they hold, until their reply is serialized; a reply of
// POOL_EXEMPT_BYTES or more is charged from serialization until it is
// written or dropped, a fragmented one whole for as long as its buffer is
// referenced. Past the pool, an exchange or a reply is `busy`. Smaller
// replies are exempt: main's limit of 256 outstanding requests bounds them
// at 16 MiB.
const POOL_BYTES = 192 * 1024 * 1024;
const POOL_EXEMPT_BYTES = 64 * 1024;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;
// fc-protocol's ErrorCode (crates/fc-protocol/src/error.rs). Only these are
// ever logged; callers still get any well-formed code.
const KNOWN_ERROR_CODES = new Set([
  'vault_locked',
  'incorrect_password',
  'throttled',
  'no_vault',
  'vault_exists',
  'unsupported_vault_version',
  'corrupt_vault',
  'invalid_mnemonic',
  'invalid_argument',
  'weak_password',
  'storage',
  'node_identity_corrupt',
  'forbidden',
  'busy',
  'cancelled',
  'deadline',
  'protocol_mismatch',
  'unknown_method',
  'internal',
]);
const CORE_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
// The only environment variables the core gets (design 0001).
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'RUST_LOG', 'SystemRoot'];

const STATE = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  READY: 'ready',
  STOPPING: 'stopping',
  FAILED: 'failed',
};

class CoreError extends Error {
  /**
   * @param {string} code - fc-protocol error code, or `core_unavailable`
   * @param {string} message
   * @param {object} [data]
   */
  constructor(code, message, data) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
    this.data = data;
  }
}

/**
 * The terminal errors main sends for the core's requests, each with its
 * fixed message (design 0004, Transport errors): none carries a URL or a
 * server's text.
 */
const SHELL_ERRORS = Object.freeze({
  timeout: 'Timed out',
  network: 'Network error',
  refused: 'Refused',
  too_large: 'Too large',
  cancelled: 'Cancelled',
  stale_generation: 'Stale generation',
  // Main has no room to hold the reply (design 0005, Main's pool).
  busy: 'Busy',
  unknown_method: 'Unknown method',
  internal: 'Internal error',
});

/** A handler's terminal error for one of the core's requests: one of
 * SHELL_ERRORS' codes (anything else is sent as internal). */
class ShellError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ShellError';
    this.code = code;
  }
}

/** Main's chain I/O pool: bytes held, within a limit. */
class IoPool {
  constructor(limit) {
    this.limit = limit;
    this.held = 0;
  }

  /** Charges `bytes`: false, and nothing charged, when they don't fit. */
  take(bytes) {
    if (bytes > this.limit - this.held) return false;
    this.held += bytes;
    return true;
  }

  release(bytes) {
    this.held -= bytes;
  }

  /**
   * An account for one of the core's requests: `charge(bytes)` charges
   * what its handler holds (false past the pool), and `close()` releases it
   * all. A closed account charges nothing more.
   */
  lease() {
    let held = 0;
    let open = true;
    return {
      charge: (bytes) => {
        if (!open || !Number.isSafeInteger(bytes) || bytes < 0 || !this.take(bytes)) return false;
        held += bytes;
        return true;
      },
      close: () => {
        if (!open) return;
        open = false;
        this.release(held);
        held = 0;
      },
    };
  }
}

function unavailable(message = 'The core is not running') {
  return new CoreError('core_unavailable', message);
}

/** A request main cancelled: its caller's answer. */
function cancelled() {
  return new CoreError('cancelled', 'Cancelled');
}

/** A handler's failure as a reply's error: a ShellError's code, cancelled
 * once the signal aborted, and otherwise `internal`, never its text. */
function shellErrorBody(err, signal) {
  if (err instanceof ShellError) return shellError(err.code);
  if (signal.aborted) return shellError('cancelled');
  return shellError('internal');
}

/** `code`'s error body, with its fixed message; an unknown code is internal. */
function shellError(code) {
  return typeof code === 'string' && Object.hasOwn(SHELL_ERRORS, code)
    ? { code, message: SHELL_ERRORS[code] }
    : { code: 'internal', message: SHELL_ERRORS.internal };
}

function clip(text) {
  return text.length > MAX_FORWARDED_TEXT
    ? `${text.slice(0, MAX_FORWARDED_TEXT)} …(truncated)`
    : text;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function scrubbedEnv(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}

/** The public part of a valid hello result, or null. */
function validHello(result) {
  if (!isObject(result) || result.protocol !== PROTOCOL_VERSION) return null;
  if (typeof result.core_version !== 'string' || !CORE_VERSION.test(result.core_version)) {
    return null;
  }
  const { capabilities } = result;
  if (
    !Array.isArray(capabilities) ||
    capabilities.length > 256 ||
    !capabilities.every((c) => typeof c === 'string' && c.length <= 64)
  ) {
    return null;
  }
  const nodeRecovery = validNodeRecovery(result.node_recovery);
  if (nodeRecovery === undefined) return null;
  return {
    protocol: PROTOCOL_VERSION,
    core_version: result.core_version,
    capabilities,
    node_recovery: nodeRecovery,
  };
}

const NODE_RECOVERY_STATUS = new Set(['pending_recovery', 'corrupt']);
const OP_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * hello's `node_recovery`: a node identity write startup recovery couldn't
 * finish. `null` (or absent, from older cores) when there is none; undefined
 * for a malformed value.
 */
function validNodeRecovery(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value) || !NODE_RECOVERY_STATUS.has(value.status)) return undefined;
  const out = { status: value.status };
  if (value.op_id !== undefined) {
    if (typeof value.op_id !== 'string' || !OP_ID.test(value.op_id)) return undefined;
    out.op_id = value.op_id;
  }
  if (value.node !== undefined) {
    if (value.node !== 'bee' && value.node !== 'radicle') return undefined;
    out.node = value.node;
  }
  return out;
}

/** One child process and everything bound to it. */
class Generation {
  constructor(number) {
    this.number = number;
    this.child = null;
    this.pending = new Map(); // id -> { settle(outcome) }
    // The core's requests, by id, from arrival until their reply is written:
    // MAX_INCOMING bounds them and their pending replies together.
    this.incoming = new Map(); // id -> AbortController
    this.lastIncomingId = 0;
    // Bytes of replies to the core still being written: their own account,
    // apart from requests' admission.
    this.replyBytes = 0;
    this.nextId = 1;
    this.writeBytes = 0;
    this.decoder = new FrameDecoder();
    // The core's fragmented responses: one at a time, while it holds main's
    // bulk credit.
    this.reassembler = new Reassembler();
    // Main's fragmented replies: only if the core offered them, one at a
    // time while main holds the core's credit. Those waiting to begin, and
    // the one being written.
    this.fragments = false;
    this.credit = false;
    this.bulk = [];
    this.sending = null; // { id, controller, payload, release, offset, writing }
    // The pool charges of its replies until written or dropped, each a
    // release that runs once; retirement releases what is left.
    this.charges = new Set();
    this.stderrText = new StringDecoder('utf8');
    this.stderrLine = '';
    this.stderrDropping = false;
    this.timers = new Set();
    this.helloTimer = null;
    this.ready = false; // a valid handshake completed while live
    this.exited = false; // the process is gone (stdout may still drain)
    this.retired = false; // stdio closed; nothing more is accepted
    this.ending = false; // we killed it or asked it to stop
    this.stopping = false; // stop() closed stdin and armed the grace kill
    this.killing = false; // inside child.kill (it can emit 'error' synchronously)
    this.killAttempts = 0;
    this.distrusted = false; // a protocol fault: its output is ignored
    this.stdinEnded = false;
    this.cause = null; // shutdown | mismatch | protocol | transport | handshake_timeout | spawn
    this.exitCode = null;
    this.exitSignal = null;
  }
}

class CoreClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {Function} options.spawn - child_process.spawn (injectable)
   * @param {string} options.command - path to the freedom-cored binary
   * @param {string[]} options.args - e.g. ['serve', '--data-dir', …]
   * @param {object} [options.log] - { info, warn, error }
   * @param {string} [options.shellVersion]
   * @param {number} [options.autoLockMs]
   * @param {Function} [options.now]
   * @param {Function} [options.setTimer]
   * @param {Function} [options.clearTimer]
   * @param {number} [options.poolBytes] - main's chain I/O pool (a test seam)
   */
  constructor(options) {
    super();
    this.spawnFn = options.spawn;
    this.command = options.command;
    this.args = options.args;
    this.log = options.log || console;
    this.shellVersion = options.shellVersion || 'unknown';
    this.autoLockMs = options.autoLockMs ?? 15 * 60 * 1000;
    this.now = options.now || Date.now;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;
    // One pool for every core process this client runs: what a retired
    // one held is released with it.
    this.pool = new IoPool(options.poolBytes ?? POOL_BYTES);

    this.state = STATE.STOPPED;
    this.generations = 0;
    this.current = null; // the live or draining Generation, if any
    this.hello = null;
    this.stopRequested = false;
    this.crashTimes = [];
    this.restartTimer = null;
    this.readyWaiters = [];
    this.stopWaiters = [];
    // Requests waiting for readiness, and their serialized parameter bytes.
    this.waitingRequests = 0;
    this.waitingBytes = 0;
    // Handlers for the core's requests, by method; and those that take only
    // the requests whose params they accept, tried first.
    this.handlers = new Map();
    this.shapedHandlers = new Map();
  }

  /**
   * Registers the handler for the core's requests named `method`. It is
   * called with (params, { signal, charge }) and returns the result (or a
   * promise of it); a ShellError is the terminal error reply. `signal`
   * aborts when the core cancels the request or its generation ends; the
   * handler still settles, and exactly one reply goes back. `charge(bytes)`
   * charges what the handler holds for its reply to main's pool, until the
   * reply is serialized: false, and nothing charged, past the pool.
   *
   * The core's naming and chain threads share method names (`shell.rpc`,
   * `shell.verified`), and tell their requests apart by their params. A
   * handler registered with `when(params)` takes the requests it accepts,
   * before the one registered without, which takes the rest.
   */
  handle(method, handler, { when = null } = {}) {
    if (!when) {
      this.handlers.set(method, handler);
      return;
    }
    const shaped = this.shapedHandlers.get(method) || [];
    shaped.push({ when, handler });
    this.shapedHandlers.set(method, shaped);
  }

  /** The handler for one of the core's requests, or undefined. */
  handlerFor(method, params) {
    const shaped = this.shapedHandlers.get(method)?.find((route) => route.when(params));
    return shaped ? shaped.handler : this.handlers.get(method);
  }

  /** Spawns the core and completes the handshake. */
  start() {
    if (this.state === STATE.STOPPING) {
      return Promise.reject(unavailable('The core is stopping'));
    }
    if (this.state === STATE.STOPPED || this.state === STATE.FAILED) {
      this.stopRequested = false;
      this.crashTimes = [];
      this.spawnGeneration();
    }
    return this.whenReady();
  }

  /**
   * Sends a request and resolves with its result.
   * @param {string} method
   * @param {object} [params]
   * @param {object} [context] - { caller: 'chrome' | 'shell', page? }
   */
  async request(method, params = {}, context = { caller: 'chrome' }) {
    if (this.state !== STATE.READY) {
      // Requests waiting for readiness are bounded like those in flight:
      // by count, and by the size of the whole request as it will be framed
      // (method, params and context, with the largest possible ID).
      let size;
      try {
        const request = { type: 'request', id: MAX_ID, method, params, context };
        size = Buffer.byteLength(JSON.stringify(request), 'utf8');
      } catch {
        throw new CoreError('invalid_argument', 'Request is not serializable');
      }
      if (size > MAX_PAYLOAD) throw new CoreError('invalid_argument', 'Request too large');
      if (this.waitingRequests >= MAX_PENDING || this.waitingBytes + size > MAX_WRITE_BYTES) {
        throw new CoreError('busy', 'Too many requests waiting for the core');
      }
      this.waitingRequests += 1;
      this.waitingBytes += size;
      try {
        await this.whenReady();
      } finally {
        this.waitingRequests -= 1;
        this.waitingBytes -= size;
      }
    }
    return this.send(this.current, method, params, context, null);
  }

  /**
   * Sends a request to one core process, the ready one `gen` names (the
   * client's `current` when it emitted 'ready'), without waiting: once that
   * process has ended it fails `unavailable`, so it never reaches another.
   * `watchdogMs` is the request's hang watchdog: the core's deadline for it
   * plus 15 s.
   *
   * `signal` cancels it (0001's `cancel`): the caller gets `cancelled` at
   * once and the core is told, unless its response came first. A signal
   * already aborted sends nothing.
   */
  requestTo(
    gen,
    method,
    params = {},
    context = { caller: 'chrome' },
    { watchdogMs = null, signal = null } = {}
  ) {
    if (!this.serves(gen)) return Promise.reject(unavailable());
    return this.send(gen, method, params, context, { watchdogMs, signal });
  }

  /** Whether `gen` is the process requests go to now: the current one,
   * past its handshake, and neither exited, ending nor retired. */
  serves(gen) {
    return Boolean(
      gen?.ready &&
      gen === this.current &&
      !gen.exited &&
      !gen.retired &&
      !gen.ending &&
      !gen.stdinEnded
    );
  }

  /**
   * Graceful shutdown: core.shutdown (if the handshake completed), close
   * stdin, SIGKILL after 3 s. Resolves once the child is gone.
   */
  stop() {
    this.stopRequested = true;
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    this.rejectReadyWaiters('The core is stopping');
    const gen = this.current;
    if (!gen) {
      this.state = STATE.STOPPED;
      return Promise.resolve();
    }
    this.state = STATE.STOPPING;
    const stopped = new Promise((resolve) => this.stopWaiters.push(resolve));
    // Also for a generation already ending after a fault: stdin is closed
    // once and the grace kill is armed.
    this.fence(gen);
    if (!gen.exited && !gen.stopping) {
      gen.stopping = true;
      gen.cause = gen.cause || 'shutdown';
      const shutdown = gen.ready && !gen.ending;
      gen.ending = true;
      if (shutdown) {
        this.send(
          gen,
          'core.shutdown',
          {},
          { caller: 'shell' },
          { control: true, onReply: () => {} }
        );
      }
      this.endStdin(gen);
      this.timer(gen, () => this.kill(gen), SHUTDOWN_GRACE_MS);
    }
    return stopped;
  }

  whenReady() {
    if (this.state === STATE.READY) return Promise.resolve(this.hello);
    if (this.state !== STATE.STARTING) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  // ---- generations ----

  spawnGeneration() {
    this.generations += 1;
    const gen = new Generation(this.generations);
    this.current = gen;
    this.state = STATE.STARTING;
    let child;
    try {
      child = this.spawnFn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: scrubbedEnv(),
        windowsHide: true,
      });
    } catch {
      this.log.error('[Core] spawn failed');
      gen.cause = 'spawn';
      gen.exited = true;
      this.retire(gen);
      return;
    }
    gen.child = child;

    child.stdout.on('data', (chunk) => this.onStdout(gen, chunk));
    child.stdout.on('end', () => this.onStdoutEnd(gen));
    child.stderr.on('data', (chunk) => {
      try {
        this.onStderr(gen, chunk);
      } catch {
        // Malformed log input never escapes the data handler.
      }
    });
    for (const name of ['stdin', 'stdout', 'stderr']) {
      child[name].on('error', () => this.connectionFailed(gen, `${name}_error`));
    }
    child.on('error', () => this.onChildError(gen));
    child.on('exit', (code, signal) => this.onChildExit(gen, code, signal));
    child.on('close', () => this.retire(gen));

    gen.helloTimer = this.timer(
      gen,
      () => {
        if (gen.ready || gen.exited) return;
        this.log.error('[Core] no core.hello reply within 10 s');
        this.end(gen, 'handshake_timeout');
      },
      HELLO_TIMEOUT_MS
    );
    this.send(
      gen,
      'core.hello',
      {
        protocol: PROTOCOL_VERSION,
        shell_version: this.shellVersion,
        auto_lock_ms: this.autoLockMs,
        // Main takes fragmented responses: the handshake grants the core
        // main's bulk credit.
        frames: ['fragment'],
      },
      { caller: 'shell' },
      { control: true, onReply: (outcome) => this.onHelloReply(gen, outcome) }
    );
  }

  onHelloReply(gen, outcome) {
    if (gen.exited || gen.retired || gen.ending) return;
    if (outcome.error) {
      if (outcome.error.code === 'protocol_mismatch') {
        this.log.error('[Core] protocol mismatch');
        this.end(gen, 'mismatch');
      } else {
        const { code } = outcome.error;
        this.log.error('[Core] handshake refused', {
          code: KNOWN_ERROR_CODES.has(code) ? code : 'unknown',
        });
        this.end(gen, 'protocol');
      }
      return;
    }
    const hello = validHello(outcome.result);
    if (!hello) {
      const result = outcome.result;
      const mismatch =
        isObject(result) &&
        Number.isInteger(result.protocol) &&
        result.protocol !== PROTOCOL_VERSION;
      this.log.error(mismatch ? '[Core] protocol mismatch' : '[Core] invalid core.hello result');
      this.end(gen, mismatch ? 'mismatch' : 'protocol');
      return;
    }
    this.cancelTimer(gen, gen.helloTimer);
    // A core that offers fragments takes main's fragmented replies, and the
    // handshake grants main its credit.
    gen.fragments = hello.capabilities.includes('fragments');
    gen.credit = gen.fragments;
    if (this.stopRequested || gen !== this.current) return;
    gen.ready = true;
    this.hello = hello;
    this.state = STATE.READY;
    this.emit('ready', hello);
    for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(hello);
  }

  /** The process exited. Its stdout may still hold final replies. */
  onChildExit(gen, code, signal) {
    if (gen.exited || gen.retired) return;
    gen.exited = true;
    this.fence(gen);
    gen.exitCode = code;
    gen.exitSignal = signal;
    this.cancelTimer(gen, gen.helloTimer);
    if (this.state === STATE.READY && gen === this.current) this.state = STATE.STARTING;
    // Normally 'close' follows once stdio is closed; don't wait forever.
    this.timer(gen, () => this.retire(gen), DRAIN_MS);
  }

  /**
   * A ChildProcess 'error': the spawn failed (no pid; the process never
   * existed), or a signal couldn't be delivered (the process may live on, so
   * nothing is released until it actually exits).
   */
  onChildError(gen) {
    if (gen.retired) return;
    if (gen.child && gen.child.pid === undefined) {
      this.log.error('[Core] spawn failed');
      gen.cause = gen.cause || 'spawn';
      gen.exited = true;
      this.retire(gen);
      return;
    }
    if (gen.exited) return;
    this.log.error('[Core] child process error');
    if (gen.killing) {
      // The SIGKILL itself failed (emitted synchronously from child.kill):
      // retry on a timer, a bounded number of times, never recursively.
      if (gen.killAttempts < MAX_KILL_ATTEMPTS) {
        this.timer(gen, () => this.kill(gen), KILL_RETRY_MS);
      }
      return;
    }
    this.end(gen, 'transport');
  }

  /**
   * Final: stdio is closed (or the drain timed out). Rejects what is still
   * pending, then decides between stopped, failed and a restart.
   */
  retire(gen) {
    if (gen.retired) return;
    gen.retired = true;
    gen.exited = true;
    for (const timer of gen.timers) this.clearTimer(timer);
    gen.timers.clear();
    this.teardown(gen);
    // A response cut short by EOF is discarded with its reservation.
    gen.reassembler.discard();
    // The core's requests die with it: their handlers stop, and their
    // replies have nowhere to go.
    this.fence(gen);
    // Writes its stdio held may never report back: what they held goes now.
    for (const release of [...gen.charges]) release();
    const pending = [...gen.pending.values()];
    gen.pending.clear();
    for (const entry of pending) entry.settle({ error: unavailable('The core exited') });
    if (gen !== this.current) return;
    this.current = null;
    this.hello = null;
    const code = gen.exitCode;
    this.emit('exit', { code, signal: gen.exitSignal, cause: gen.cause });

    if (this.stopRequested) {
      this.state = STATE.STOPPED;
      for (const resolve of this.stopWaiters.splice(0)) resolve();
      return;
    }
    if (gen.cause === 'mismatch') {
      this.fail('protocol mismatch');
      return;
    }
    if (code !== null && NO_RESTART_EXIT_CODES.has(code)) {
      this.fail(`exit code ${code}`);
      return;
    }
    const now = this.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (this.crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
      this.fail('three crashes within a minute');
      return;
    }
    const delay =
      RESTART_DELAYS_MS[Math.min(this.crashTimes.length - 1, RESTART_DELAYS_MS.length - 1)];
    this.log.warn('[Core] exited; restarting', {
      code,
      signal: gen.exitSignal,
      cause: gen.cause,
      delay_ms: delay,
    });
    this.state = STATE.STARTING;
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      if (!this.stopRequested) this.spawnGeneration();
    }, delay);
  }

  fail(reason) {
    this.log.error('[Core] giving up', { reason });
    this.state = STATE.FAILED;
    this.emit('failed', reason);
    this.rejectReadyWaiters(reason);
  }

  rejectReadyWaiters(reason) {
    for (const waiter of this.readyWaiters.splice(0)) waiter.reject(unavailable(reason));
  }

  /** Ends a generation we no longer trust: records why, then kills it. */
  end(gen, cause) {
    if (gen.retired) return;
    gen.cause = gen.cause || cause;
    gen.ending = true;
    this.fence(gen);
    this.kill(gen);
  }

  kill(gen) {
    if (gen.exited || !gen.child || gen.killing) return;
    gen.killing = true;
    gen.killAttempts += 1;
    try {
      gen.child.kill('SIGKILL');
    } catch {
      // Reported through 'error' if it matters.
    } finally {
      gen.killing = false;
    }
  }

  /**
   * Releases a retired generation: destroys its stdio (a pipe held open by
   * someone else would otherwise stay alive) and detaches its listeners,
   * keeping error sinks so teardown can't raise unhandled errors.
   */
  teardown(gen) {
    const { child } = gen;
    if (!child) return;
    const sink = () => {};
    for (const name of ['stdin', 'stdout', 'stderr']) {
      const stream = child[name];
      if (!stream) continue;
      stream.removeAllListeners();
      stream.on('error', sink);
      stream.destroy();
    }
    child.removeAllListeners();
    child.on('error', sink);
  }

  endStdin(gen) {
    if (gen.stdinEnded || !gen.child) return;
    gen.stdinEnded = true;
    try {
      gen.child.stdin.end();
    } catch {
      // Already closed.
    }
  }

  connectionFailed(gen, category) {
    if (gen.retired || gen.exited) return;
    this.log.error('[Core] connection failed', { category });
    this.end(gen, 'transport');
  }

  protocolFault(gen, category) {
    if (gen.retired || gen.distrusted) return;
    gen.distrusted = true;
    this.fence(gen);
    this.log.error('[Core] protocol error', { category });
    this.end(gen, 'protocol');
  }

  timer(gen, fn, ms) {
    const timer = this.setTimer(() => {
      gen.timers.delete(timer);
      fn();
    }, ms);
    gen.timers.add(timer);
    return timer;
  }

  cancelTimer(gen, timer) {
    if (!timer || !gen.timers.has(timer)) return;
    gen.timers.delete(timer);
    this.clearTimer(timer);
  }

  // ---- writing ----

  /**
   * Writes one request. `control` frames (hello, shutdown) skip the
   * admission limits; `onReply` receives the outcome synchronously instead
   * of a promise; `signal` cancels it.
   */
  send(gen, method, params, context, options) {
    const { control = false, onReply = null, watchdogMs = null, signal = null } = options || {};
    // Callback-style callers get every outcome through the callback.
    const refuse = (error) => {
      if (!onReply) return Promise.reject(error);
      onReply({ error });
      return null;
    };
    if (!gen || gen.retired || gen.exited || gen.stdinEnded || (gen.ending && !control)) {
      return refuse(unavailable());
    }
    if (signal?.aborted) return refuse(cancelled());
    if (!control && gen.pending.size >= MAX_PENDING) {
      return refuse(new CoreError('busy', 'Too many requests in flight'));
    }
    if (gen.nextId > MAX_ID) {
      this.protocolFault(gen, 'ids_exhausted');
      return refuse(unavailable());
    }
    const id = gen.nextId;
    let frame;
    try {
      frame = encodeFrame({ type: 'request', id, method, params, context });
    } catch (err) {
      if (err instanceof FrameError) {
        return refuse(new CoreError('invalid_argument', 'Request too large'));
      }
      return refuse(new CoreError('invalid_argument', 'Request is not serializable'));
    }
    // Serializing ran the params' own code (a getter, a toJSON), which may
    // have aborted the signal: an abort's event isn't replayed to a listener
    // added later, so it is checked again. Cancelled before it is written,
    // the request is never sent.
    if (signal?.aborted) return refuse(cancelled());
    if (!control && gen.writeBytes + frame.length > MAX_WRITE_BYTES) {
      return refuse(new CoreError('busy', 'Too much data in flight'));
    }
    gen.nextId += 1;

    let promise = null;
    let entry;
    if (onReply) {
      entry = { settle: onReply };
    } else {
      promise = new Promise((resolve, reject) => {
        entry = {
          settle: (outcome) => (outcome.error ? reject(outcome.error) : resolve(outcome.result)),
        };
      });
    }
    if (signal) this.cancellable(gen, id, entry, signal);
    if (watchdogMs !== null) {
      // The hang watchdog (design 0001): the core enforces the request's
      // deadline and always replies, so no reply by deadline + 15 s means
      // it is hung. It is killed, which fails what it holds, and restarted.
      const settle = entry.settle;
      const watchdog = this.timer(
        gen,
        () => {
          if (gen.pending.get(id) !== entry) return;
          this.log.error('[Core] request hung; restarting the core', { method });
          this.end(gen, 'hang');
        },
        watchdogMs
      );
      entry.settle = (outcome) => {
        this.cancelTimer(gen, watchdog);
        settle(outcome);
      };
    }
    gen.pending.set(id, entry);
    gen.writeBytes += frame.length;
    const written = (err) => {
      gen.writeBytes -= frame.length;
      if (err) this.connectionFailed(gen, 'stdin_error');
    };
    try {
      gen.child.stdin.write(frame, written);
    } catch {
      gen.pending.delete(id);
      gen.writeBytes -= frame.length;
      this.connectionFailed(gen, 'stdin_error');
      entry.settle({ error: unavailable() });
    }
    return promise;
  }

  /**
   * Main's cancel (0001), once `signal` aborts: the caller gets `cancelled`
   * at once, and the core a `cancel`. The request stays pending until the
   * core's one response, which is consumed and dropped; a fragmented one
   * still returns its credit, as a delivered one does (design 0005, Main's
   * pool). A response that came first answers the caller, and nothing is
   * cancelled.
   */
  cancellable(gen, id, entry, signal) {
    const settle = entry.settle;
    let answered = false;
    const onAbort = () => {
      if (answered || gen.pending.get(id) !== entry) return;
      answered = true;
      this.writeCancel(gen, id);
      settle({ error: cancelled() });
    };
    entry.settle = (outcome) => {
      signal.removeEventListener('abort', onAbort);
      if (answered) return;
      answered = true;
      settle(outcome);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }

  /**
   * Writes main's `cancel` for its request `id`: a control frame, one per
   * outstanding request, so it skips the requests' admission and is never
   * held back by them or by main's pool.
   */
  writeCancel(gen, id) {
    if (gen.retired || gen.exited || gen.stdinEnded || !gen.child) return;
    try {
      gen.child.stdin.write(encodeFrame({ type: 'cancel', id }), (err) => {
        if (err) this.connectionFailed(gen, 'stdin_error');
      });
    } catch {
      this.connectionFailed(gen, 'stdin_error');
    }
  }

  // ---- reading ----

  onStdout(gen, chunk) {
    // After a protocol fault nothing more from this child is trusted.
    if (gen.retired || gen.distrusted) return;
    let frames;
    try {
      frames = gen.decoder.push(chunk);
    } catch (err) {
      this.protocolFault(gen, err instanceof FrameError ? err.category : 'decode');
      return;
    }
    for (const frame of frames) {
      if (gen.retired || gen.distrusted) return;
      let delivery;
      try {
        // A begin must name a request still waiting for its response.
        delivery = gen.reassembler.push(frame, (id) => gen.pending.has(id));
      } catch (err) {
        this.protocolFault(gen, err instanceof FrameError ? err.category : 'decode');
        return;
      }
      if (!delivery) continue;
      try {
        if (delivery.type === 'message') {
          this.onMessage(gen, delivery.message);
        } else if (delivery.type === 'response') {
          this.onFragmentedResponse(gen, delivery.id, delivery.message);
        } else {
          this.onCredit(gen);
        }
      } catch {
        this.protocolFault(gen, 'handler');
      }
    }
  }

  onStdoutEnd(gen) {
    if (gen.retired) return;
    if (!gen.decoder.isAtBoundary()) this.log.warn('[Core] stdout closed in the middle of a frame');
    if (gen.reassembler.inProgress()) {
      this.log.warn('[Core] stdout closed in the middle of a fragmented response');
    }
    // A live child that closes stdout can't answer any more.
    if (!gen.exited) this.connectionFailed(gen, 'stdout_closed');
  }

  onMessage(gen, message) {
    if (!isObject(message)) return this.protocolFault(gen, 'not_object');
    if (message.type === 'response') return this.onResponse(gen, message);
    if (message.type === 'event') return this.onEvent(gen, message);
    if (message.type === 'request') return this.onCoreRequest(gen, message);
    if (message.type === 'cancel') return this.onCoreCancel(gen, message);
    return this.protocolFault(gen, 'unknown_type');
  }

  /**
   * One of the core's requests (design 0004, Requests the core makes): its
   * IDs only increase, at most MAX_INCOMING are outstanding, and each gets
   * exactly one reply.
   */
  onCoreRequest(gen, message) {
    const { id, method, params } = message;
    if (!Number.isSafeInteger(id) || id < 1) return this.protocolFault(gen, 'bad_id');
    if (id <= gen.lastIncomingId) return this.protocolFault(gen, 'reused_id');
    if (typeof method !== 'string' || !METHOD_NAME.test(method)) {
      return this.protocolFault(gen, 'bad_method');
    }
    if (params !== undefined && !isObject(params)) return this.protocolFault(gen, 'bad_params');
    if (gen.incoming.size >= MAX_INCOMING) return this.protocolFault(gen, 'too_many_requests');
    gen.lastIncomingId = id;
    // A generation on its way out serves nothing more.
    if (!this.serving(gen)) return undefined;
    const controller = new AbortController();
    gen.incoming.set(id, controller);
    const handler = this.handlerFor(method, params ?? {});
    if (!handler) {
      this.respond(gen, id, controller, { error: shellError('unknown_method') });
      return undefined;
    }
    // What the handler holds for its reply, in main's pool until the reply
    // is serialized (or dropped).
    const lease = this.pool.lease();
    Promise.resolve()
      .then(() => {
        // Fenced before it started (its generation ended), or cancelled in
        // the same read as it arrived: the handler never runs.
        // Checked and started in the same job: nothing can fence or
        // cancel it in between.
        if (gen.incoming.get(id) !== controller) return null;
        if (controller.signal.aborted) return { error: shellError('cancelled') };
        let pending;
        try {
          pending = handler(params ?? {}, { signal: controller.signal, charge: lease.charge });
        } catch (err) {
          return { error: shellErrorBody(err, controller.signal) };
        }
        return Promise.resolve(pending).then(
          (result) => ({ result: result ?? {} }),
          (err) => ({ error: shellErrorBody(err, controller.signal) })
        );
      })
      .then((outcome) => {
        try {
          if (outcome) this.respond(gen, id, controller, outcome, lease);
        } finally {
          lease.close();
        }
      });
    return undefined;
  }

  /** Whether `gen` still serves the core's requests. */
  serving(gen) {
    return gen === this.current && !gen.ending && !gen.exited && !gen.retired && !gen.distrusted;
  }

  /** The generation stops serving the core's requests: their handlers
   * abort, and no reply goes for them, nor more of one being written. */
  fence(gen) {
    const incoming = [...gen.incoming.values()];
    gen.incoming.clear();
    this.dropBulk(gen);
    for (const controller of incoming) controller.abort();
  }

  /** The core stopped waiting: the handler's signal aborts, and its one
   * reply still goes. A cancel for a request already answered is ignored. */
  onCoreCancel(gen, message) {
    const { id } = message;
    if (!Number.isSafeInteger(id) || id < 1) return this.protocolFault(gen, 'bad_id');
    gen.incoming.get(id)?.abort();
    return undefined;
  }

  /** Whether a reply is still owed and can be written: its entry is the
   * current one and its generation's stdin is open. One that can't is
   * dropped. */
  owes(gen, id, controller) {
    if (gen.incoming.get(id) !== controller) return false;
    if (gen.retired || gen.exited || gen.stdinEnded || !gen.child) {
      gen.incoming.delete(id);
      return false;
    }
    return true;
  }

  /**
   * Writes the reply to one of the core's requests, unless its generation
   * fenced it. Its entry is held until the write completes, so the core's
   * MAX_INCOMING bounds pending replies too; their bytes are their own
   * account, so they never take the room requests (vault.lock, shutdown)
   * need.
   *
   * A reply over one frame goes fragmented, to a core that offered
   * fragments and within the message cap; otherwise it is `too_large`.
   *
   * Main's pool (design 0005): once the reply is serialized, what its
   * handler held for it (`lease`) is released, and a reply of
   * POOL_EXEMPT_BYTES or more is charged in its place until it is written or
   * dropped. Past the pool, it is `busy`.
   */
  respond(gen, id, controller, outcome, lease = null) {
    if (!this.owes(gen, id, controller)) return;
    // Serialized once, so a result's toJSON runs once and what is checked
    // is what is sent: a result JSON can't represent (a function, a symbol,
    // a toJSON returning nothing) leaves the bare envelope, and is internal
    // instead. The text is compared, so a large reply isn't parsed back.
    let json;
    try {
      json = JSON.stringify({ type: 'response', id, ...outcome });
      if (json === JSON.stringify({ type: 'response', id })) json = null;
    } catch {
      json = null;
    }
    lease?.close();
    // Serializing ran the result's own code, which may have fenced it.
    if (!this.owes(gen, id, controller)) return;
    let code = 'internal';
    if (json !== null) {
      const size = Buffer.byteLength(json, 'utf8');
      const whole = size <= MAX_PAYLOAD;
      if (whole || (gen.fragments && size <= MAX_MESSAGE)) {
        const release = this.hold(gen, size >= POOL_EXEMPT_BYTES ? size : 0);
        if (release && whole) {
          this.writeReply(gen, id, controller, encodeJsonFrame(json), release);
          return;
        }
        if (release) {
          this.queueBulk(gen, { id, controller, payload: Buffer.from(json, 'utf8'), release });
          return;
        }
        code = 'busy';
      } else {
        code = 'too_large';
      }
    }
    const error = shellError(code);
    this.writeReply(gen, id, controller, encodeFrame({ type: 'response', id, error }));
  }

  /**
   * Charges `bytes` of `gen`'s to main's pool: a release that runs once, or
   * null past the pool. Its retirement releases whatever is still held.
   */
  hold(gen, bytes) {
    if (bytes === 0) return () => {};
    if (!this.pool.take(bytes)) return null;
    const release = () => {
      if (!gen.charges.delete(release)) return;
      this.pool.release(bytes);
    };
    gen.charges.add(release);
    return release;
  }

  /** Writes a reply in one frame; `release` returns its pool charge once
   * it is written. */
  writeReply(gen, id, controller, frame, release = null) {
    gen.replyBytes += frame.length;
    const written = (err) => {
      gen.replyBytes -= frame.length;
      release?.();
      if (gen.incoming.get(id) === controller) gen.incoming.delete(id);
      if (err) this.connectionFailed(gen, 'stdin_error');
    };
    try {
      gen.child.stdin.write(frame, written);
    } catch {
      written(true);
    }
  }

  /** A reply over one frame waits for the core's credit, in order. */
  queueBulk(gen, reply) {
    gen.bulk.push(reply);
    this.pumpBulk(gen);
  }

  /**
   * Begins the next waiting reply while main holds the core's credit and
   * none is being written. Beginning spends the credit, before the begin is
   * written, so the core's `0x13` can't come first.
   */
  pumpBulk(gen) {
    while (!gen.sending && gen.credit && gen.bulk.length) {
      const reply = gen.bulk.shift();
      if (!this.owes(gen, reply.id, reply.controller)) {
        reply.release();
        continue;
      }
      gen.credit = false;
      gen.sending = { ...reply, offset: 0, writing: false };
      try {
        gen.child.stdin.write(encodeBegin(reply.id, reply.payload.length));
      } catch {
        this.connectionFailed(gen, 'stdin_error');
        return;
      }
      this.writeFragment(gen);
    }
  }

  /**
   * Writes the next fragment of the reply being sent. The one after goes
   * once this one is written, so the whole frames written meanwhile go
   * between them. Once begun, a reply is written to its end; its entry goes
   * with its last fragment.
   *
   * Each fragment is a view of the reply's buffer, so the buffer stays
   * charged whole until the last write that holds it completes: its last
   * fragment's, or the one in flight when the rest was dropped.
   */
  writeFragment(gen) {
    const sending = gen.sending;
    const { payload, offset } = sending;
    const end = Math.min(payload.length, offset + MAX_PAYLOAD);
    const last = end === payload.length;
    sending.offset = end;
    sending.writing = true;
    const written = (err) => {
      sending.writing = false;
      // Its generation ended meanwhile, and the rest was dropped; or the
      // write failed; or this was the last fragment.
      const done = err || gen.sending !== sending || last;
      if (!done) {
        this.writeFragment(gen);
        return;
      }
      sending.release();
      if (gen.sending !== sending) return;
      gen.sending = null;
      if (err) {
        this.connectionFailed(gen, 'stdin_error');
        return;
      }
      if (gen.incoming.get(sending.id) === sending.controller) gen.incoming.delete(sending.id);
      this.pumpBulk(gen);
    };
    try {
      gen.child.stdin.write(frameHeader(last ? KIND_LAST : KIND_FRAGMENT, end - offset));
      gen.child.stdin.write(payload.subarray(offset, end), written);
    } catch {
      written(true);
    }
  }

  /** Drops the replies waiting to begin, and the rest of the one being
   * written: the core reads no more of this generation's. A fragment still
   * being written holds its reply's buffer: its write releases the charge. */
  dropBulk(gen) {
    if (gen.sending && !gen.sending.writing) gen.sending.release();
    gen.sending = null;
    for (const reply of gen.bulk) reply.release();
    gen.bulk = [];
  }

  onResponse(gen, message) {
    const { id } = message;
    if (!Number.isSafeInteger(id) || id < 1) return this.protocolFault(gen, 'bad_id');
    const entry = gen.pending.get(id);
    if (!entry) return this.protocolFault(gen, 'unsolicited_response');
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (hasResult === hasError) return this.protocolFault(gen, 'result_and_error');
    let outcome;
    if (hasError) {
      const { error } = message;
      if (
        !isObject(error) ||
        typeof error.code !== 'string' ||
        !ERROR_CODE.test(error.code) ||
        typeof error.message !== 'string'
      ) {
        return this.protocolFault(gen, 'bad_error');
      }
      outcome = { error: new CoreError(error.code, error.message, error.data) };
    } else {
      outcome = { result: message.result };
    }
    gen.pending.delete(id);
    entry.settle(outcome);
    return undefined;
  }

  /**
   * A fragmented response, reassembled: it must be the response its begin
   * named. Once its caller has it, the core's credit goes back, so it may
   * begin another.
   */
  onFragmentedResponse(gen, id, message) {
    if (!isObject(message) || message.type !== 'response' || message.id !== id) {
      return this.protocolFault(gen, 'fragmented_not_its_response');
    }
    this.onResponse(gen, message);
    if (!gen.distrusted) this.returnCredit(gen);
    return undefined;
  }

  /**
   * Returns the core's bulk credit (`0x13`), a control frame written at
   * once. A generation that can no longer take it is going away, and the
   * credit with it.
   */
  returnCredit(gen) {
    if (gen.retired || gen.exited || gen.ending || gen.stdinEnded || !gen.child) return;
    gen.reassembler.grant();
    try {
      gen.child.stdin.write(encodeCredit(), (err) => {
        if (err) this.connectionFailed(gen, 'stdin_error');
      });
    } catch {
      this.connectionFailed(gen, 'stdin_error');
    }
  }

  /** The core returned main's credit: a waiting reply may begin. One main
   * wasn't owed (the core didn't offer fragments, or main holds its credit)
   * is a protocol fault. */
  onCredit(gen) {
    if (!gen.fragments || gen.credit) return this.protocolFault(gen, 'unsolicited_credit');
    gen.credit = true;
    this.pumpBulk(gen);
    return undefined;
  }

  onEvent(gen, message) {
    if (typeof message.event !== 'string' || !EVENT_NAME.test(message.event)) {
      return this.protocolFault(gen, 'bad_event');
    }
    const hasData = Object.prototype.hasOwnProperty.call(message, 'data');
    if (hasData && !isObject(message.data)) return this.protocolFault(gen, 'bad_event');
    // Only a live, ready, current generation speaks for the core.
    if (gen.exited || !gen.ready || gen !== this.current) return undefined;
    this.emit('event', message.event, hasData ? message.data : {});
    return undefined;
  }

  // ---- stderr ----

  onStderr(gen, chunk) {
    if (gen.retired) return;
    let text = gen.stderrText.write(chunk);
    while (text.length) {
      const newline = text.indexOf('\n');
      const part = newline === -1 ? text : text.slice(0, newline);
      text = newline === -1 ? '' : text.slice(newline + 1);
      if (!gen.stderrDropping) {
        gen.stderrLine += part;
        if (gen.stderrLine.length > MAX_STDERR_LINE) {
          this.forwardLog(gen.stderrLine);
          gen.stderrLine = '';
          gen.stderrDropping = newline === -1;
          continue;
        }
      }
      if (newline !== -1) {
        if (!gen.stderrDropping) this.forwardLog(gen.stderrLine);
        gen.stderrLine = '';
        gen.stderrDropping = false;
      }
    }
  }

  /** Forwards one core log line (JSON from the core's logger, or plain text). */
  forwardLog(line) {
    if (!line) return;
    let entry = null;
    try {
      entry = JSON.parse(line);
    } catch {
      // Plain text, e.g. a panic message.
    }
    if (!isObject(entry) || typeof entry.msg !== 'string') {
      this.log.info('[Core]', clip(line));
      return;
    }
    const { level, msg, ...fields } = entry;
    const name =
      typeof level === 'string' && Object.hasOwn(LOG_LEVELS, level) ? LOG_LEVELS[level] : 'info';
    const logger = typeof this.log[name] === 'function' ? this.log[name] : this.log.info;
    logger.call(this.log, `[Core] ${clip(msg)}`, Object.keys(fields).length ? fields : '');
  }
}

module.exports = {
  CoreClient,
  CoreError,
  ShellError,
  SHELL_ERRORS,
  MAX_INCOMING,
  scrubbedEnv,
  PROTOCOL_VERSION,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
  MAX_PENDING,
  MAX_WRITE_BYTES,
  POOL_BYTES,
  POOL_EXEMPT_BYTES,
};
