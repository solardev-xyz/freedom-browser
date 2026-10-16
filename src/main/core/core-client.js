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
 * **Logs** carry fixed categories and validated public fields only: never
 * request or response bodies, peer-supplied IDs, types or error text.
 */

const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');
const { encodeFrame, encodeJsonFrame, FrameDecoder, FrameError, MAX_PAYLOAD } = require('./frame');

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
// Spawn errors no restart can fix: the binary is missing or can't be run.
const NO_RESTART_SPAWN_ERRORS = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOEXEC']);
const ERRNO_CODE = /^E[A-Z0-9]{1,31}$/;
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

function unavailable(message = 'The core is not running') {
  return new CoreError('core_unavailable', message);
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
  return { protocol: PROTOCOL_VERSION, core_version: result.core_version, capabilities };
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
    this.spawnError = null; // the errno code when the process never started
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
    // Handlers for the core's requests, by method.
    this.handlers = new Map();
  }

  /**
   * Registers the handler for the core's requests named `method`. It is
   * called with (params, { signal }) and returns the result (or a promise
   * of it); a ShellError is the terminal error reply. `signal` aborts when
   * the core cancels the request or its generation ends; the handler still
   * settles, and exactly one reply goes back.
   */
  handle(method, handler) {
    this.handlers.set(method, handler);
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
    } catch (err) {
      this.spawnFailed(gen, err);
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
    child.on('error', (err) => this.onChildError(gen, err));
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
  onChildError(gen, err) {
    if (gen.retired) return;
    if (gen.child && gen.child.pid === undefined) {
      this.spawnFailed(gen, err);
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
   * The process never started. Logs the errno code and the binary path, so
   * a missing binary reads as that rather than as a crash; `retire` gives up
   * at once on the codes no restart can fix.
   */
  spawnFailed(gen, err) {
    const code =
      err && typeof err.code === 'string' && ERRNO_CODE.test(err.code) ? err.code : 'unknown';
    this.log.error('[Core] spawn failed', { code, path: this.command });
    gen.cause = gen.cause || 'spawn';
    gen.spawnError = code;
    gen.exited = true;
    this.retire(gen);
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
    // The core's requests die with it: their handlers stop, and their
    // replies have nowhere to go.
    this.fence(gen);
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
    if (gen.spawnError && NO_RESTART_SPAWN_ERRORS.has(gen.spawnError)) {
      this.fail(`spawn ${gen.spawnError}: ${this.command}`);
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
   * of a promise.
   */
  send(gen, method, params, context, options) {
    const { control = false, onReply = null } = options || {};
    // Callback-style callers get every outcome through the callback.
    const refuse = (error) => {
      if (!onReply) return Promise.reject(error);
      onReply({ error });
      return null;
    };
    if (!gen || gen.retired || gen.exited || gen.stdinEnded || (gen.ending && !control)) {
      return refuse(unavailable());
    }
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

  // ---- reading ----

  onStdout(gen, chunk) {
    // After a protocol fault nothing more from this child is trusted.
    if (gen.retired || gen.distrusted) return;
    let messages;
    try {
      messages = gen.decoder.push(chunk);
    } catch (err) {
      this.protocolFault(gen, err instanceof FrameError ? err.category : 'decode');
      return;
    }
    for (const message of messages) {
      if (gen.retired || gen.distrusted) return;
      try {
        this.onMessage(gen, message);
      } catch {
        this.protocolFault(gen, 'handler');
      }
    }
  }

  onStdoutEnd(gen) {
    if (gen.retired) return;
    if (!gen.decoder.isAtBoundary()) this.log.warn('[Core] stdout closed in the middle of a frame');
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
    const handler = this.handlers.get(method);
    if (!handler) {
      this.respond(gen, id, controller, { error: shellError('unknown_method') });
      return undefined;
    }
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
          pending = handler(params ?? {}, { signal: controller.signal });
        } catch (err) {
          return { error: shellErrorBody(err, controller.signal) };
        }
        return Promise.resolve(pending).then(
          (result) => ({ result: result ?? {} }),
          (err) => ({ error: shellErrorBody(err, controller.signal) })
        );
      })
      .then((outcome) => {
        if (outcome) this.respond(gen, id, controller, outcome);
      });
    return undefined;
  }

  /** Whether `gen` still serves the core's requests. */
  serving(gen) {
    return gen === this.current && !gen.ending && !gen.exited && !gen.retired && !gen.distrusted;
  }

  /** The generation stops serving the core's requests: their handlers
   * abort, and no reply goes for them. */
  fence(gen) {
    const incoming = [...gen.incoming.values()];
    gen.incoming.clear();
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

  /**
   * Writes the reply to one of the core's requests, unless its generation
   * fenced it. Its entry is held until the write completes, so the core's
   * MAX_INCOMING bounds pending replies too; their bytes are their own
   * account, so they never take the room requests (vault.lock, shutdown)
   * need.
   */
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

  respond(gen, id, controller, outcome) {
    if (!this.owes(gen, id, controller)) return;
    let frame;
    try {
      // Serialized once, so a result's toJSON runs once and what is checked
      // is what is sent: a result JSON can't represent (a function, a
      // symbol, a toJSON returning nothing) leaves no outcome, and is
      // internal instead.
      const json = JSON.stringify({ type: 'response', id, ...outcome });
      const sent = JSON.parse(json);
      if (!Object.hasOwn(sent, 'result') && !Object.hasOwn(sent, 'error')) {
        throw new TypeError('unrepresentable result');
      }
      frame = encodeJsonFrame(json);
    } catch (err) {
      const error = shellError(err instanceof FrameError ? 'too_large' : 'internal');
      frame = encodeFrame({ type: 'response', id, error });
    }
    // Serializing ran the result's own code, which may have fenced it.
    if (!this.owes(gen, id, controller)) return;
    gen.replyBytes += frame.length;
    const written = (err) => {
      gen.replyBytes -= frame.length;
      if (gen.incoming.get(id) === controller) gen.incoming.delete(id);
      if (err) this.connectionFailed(gen, 'stdin_error');
    };
    try {
      gen.child.stdin.write(frame, written);
    } catch {
      written(true);
    }
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
};
