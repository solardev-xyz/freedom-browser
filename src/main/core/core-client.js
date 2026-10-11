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
 * - no restart for the exit codes that mean "don't retry".
 *
 * Every pending request is bound to the child generation that received it.
 * A child that exits rejects its own pending requests and nothing else, and
 * a late reply from a retired child is ignored.
 */

const { EventEmitter } = require('events');
const { encodeFrame, FrameDecoder } = require('./frame');

const PROTOCOL_VERSION = 1;
const MAX_ID = Number.MAX_SAFE_INTEGER; // 2^53 - 1: exact in JS
const HELLO_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;
const RESTART_DELAYS_MS = [500, 2_000, 10_000];
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASHES_IN_WINDOW = 3;
// sysexits codes after which the core must not be restarted: usage (64),
// storage or refused filesystem (74), lock held by another process (75),
// protocol or handshake failure (76).
const NO_RESTART_EXIT_CODES = new Set([64, 74, 75, 76]);
// The only environment variables the core gets (design 0001).
const ENV_ALLOWLIST = ['PATH', 'HOME', 'USERPROFILE', 'LANG', 'RUST_LOG', 'SystemRoot'];

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

function scrubbedEnv(env = process.env) {
  const out = {};
  for (const key of ENV_ALLOWLIST) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
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

    this.state = 'stopped'; // stopped | starting | ready | stopping | failed
    this.generation = 0;
    this.exitedGeneration = 0;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.crashTimes = [];
    this.restartTimer = null;
    this.helloTimer = null;
    this.readyWaiters = [];
    this.stopWaiters = [];
  }

  /** Spawns the core and completes the handshake. */
  start() {
    if (this.state === 'stopped' || this.state === 'failed') {
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
    if (this.state !== 'ready') await this.whenReady();
    return this.send(method, params, context);
  }

  /** Graceful shutdown: core.shutdown, close stdin, kill after 3 s. */
  stop() {
    if (this.restartTimer) {
      this.clearTimer(this.restartTimer);
      this.restartTimer = null;
    }
    if (!this.child) {
      this.state = 'stopped';
      return Promise.resolve();
    }
    this.state = 'stopping';
    const stopped = new Promise((resolve) => this.stopWaiters.push(resolve));
    const child = this.child;
    this.send('core.shutdown', {}, { caller: 'shell' }).catch(() => {});
    try {
      child.stdin.end();
    } catch {
      // Already closed.
    }
    const killTimer = this.setTimer(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, SHUTDOWN_GRACE_MS);
    return stopped.finally(() => this.clearTimer(killTimer));
  }

  whenReady() {
    if (this.state === 'ready') return Promise.resolve();
    if (this.state !== 'starting') {
      return Promise.reject(new CoreError('core_unavailable', 'The core is not running'));
    }
    return new Promise((resolve, reject) => this.readyWaiters.push({ resolve, reject }));
  }

  spawnGeneration() {
    this.generation += 1;
    const generation = this.generation;
    this.state = 'starting';
    this.nextId = 1;
    let child;
    try {
      child = this.spawnFn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: scrubbedEnv(),
        windowsHide: true,
      });
    } catch (err) {
      this.log.error('[Core] spawn failed:', err.message);
      this.onExit(generation, null, null, err);
      return;
    }
    this.child = child;

    const decoder = new FrameDecoder();
    child.stdout.on('data', (chunk) => {
      if (generation !== this.generation) return;
      let messages;
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        this.protocolError(generation, err.message);
        return;
      }
      for (const message of messages) this.onMessage(generation, message);
    });
    let stderrBuffered = '';
    child.stderr.on('data', (chunk) => {
      stderrBuffered += chunk.toString('utf8');
      let newline;
      while ((newline = stderrBuffered.indexOf('\n')) !== -1) {
        this.forwardLog(stderrBuffered.slice(0, newline));
        stderrBuffered = stderrBuffered.slice(newline + 1);
      }
    });
    child.on('error', (err) => this.onExit(generation, null, null, err));
    child.on('exit', (code, signal) => this.onExit(generation, code, signal, null));

    this.helloTimer = this.setTimer(() => {
      if (generation === this.generation && this.state === 'starting') {
        this.log.error('[Core] no core.hello reply within 10 s');
        this.kill(child);
      }
    }, HELLO_TIMEOUT_MS);
    this.send(
      'core.hello',
      {
        protocol: PROTOCOL_VERSION,
        shell_version: this.shellVersion,
        auto_lock_ms: this.autoLockMs,
      },
      { caller: 'shell' },
      { duringHandshake: true }
    ).then(
      (result) => {
        if (generation !== this.generation) return;
        this.clearTimer(this.helloTimer);
        if (result.protocol !== PROTOCOL_VERSION) {
          this.log.error('[Core] protocol mismatch:', result.protocol);
          this.kill(child);
          return;
        }
        this.state = 'ready';
        this.emit('ready', result);
        for (const waiter of this.readyWaiters.splice(0)) waiter.resolve(result);
      },
      (err) => {
        if (generation !== this.generation) return;
        this.log.error('[Core] handshake failed:', err.message);
        this.kill(child);
      }
    );
  }

  send(method, params, context, { duringHandshake = false } = {}) {
    const child = this.child;
    if (!child || (!duringHandshake && this.state !== 'ready' && this.state !== 'stopping')) {
      return Promise.reject(new CoreError('core_unavailable', 'The core is not running'));
    }
    if (this.nextId > MAX_ID) {
      this.protocolError(this.generation, 'request IDs exhausted');
      return Promise.reject(new CoreError('core_unavailable', 'The core is not running'));
    }
    const id = this.nextId++;
    const generation = this.generation;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, generation, method });
      try {
        child.stdin.write(encodeFrame({ type: 'request', id, method, params, context }));
      } catch (err) {
        this.pending.delete(id);
        reject(new CoreError('core_unavailable', err.message));
      }
    });
  }

  onMessage(generation, message) {
    if (message.type === 'response') {
      const entry = this.pending.get(message.id);
      if (!entry || entry.generation !== generation) {
        this.protocolError(generation, `unsolicited response ${message.id}`);
        return;
      }
      const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
      const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
      if (hasResult === hasError) {
        this.protocolError(generation, 'a response needs exactly one of result and error');
        return;
      }
      this.pending.delete(message.id);
      if (hasResult) {
        entry.resolve(message.result);
      } else {
        const { code, message: text, data } = message.error || {};
        entry.reject(new CoreError(code, text, data));
      }
    } else if (message.type === 'event') {
      this.emit('event', message.event, message.data);
    } else {
      this.protocolError(generation, `unexpected message type ${message.type}`);
    }
  }

  protocolError(generation, reason) {
    if (generation !== this.generation || !this.child) return;
    this.log.error('[Core] protocol error:', reason);
    this.kill(this.child);
  }

  kill(child) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }

  onExit(generation, code, signal, err) {
    // 'error' and 'exit' can both fire for one child: handle the first only.
    if (generation !== this.generation || this.exitedGeneration === generation) return;
    this.exitedGeneration = generation;
    this.child = null;
    this.clearTimer(this.helloTimer);
    for (const [id, entry] of this.pending) {
      if (entry.generation === generation) {
        this.pending.delete(id);
        entry.reject(new CoreError('core_unavailable', 'The core exited'));
      }
    }
    this.emit('exit', { code, signal, error: err ? err.message : undefined });

    if (this.state === 'stopping') {
      this.state = 'stopped';
      for (const resolve of this.stopWaiters.splice(0)) resolve();
      return;
    }
    if (code !== null && NO_RESTART_EXIT_CODES.has(code)) {
      this.fail(`the core exited with code ${code}`);
      return;
    }
    const now = this.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS).concat(now);
    if (this.crashTimes.length >= MAX_CRASHES_IN_WINDOW) {
      this.fail('the core crashed three times within a minute');
      return;
    }
    const delay =
      RESTART_DELAYS_MS[Math.min(this.crashTimes.length - 1, RESTART_DELAYS_MS.length - 1)];
    this.log.warn(`[Core] exited (code ${code}, signal ${signal}); restarting in ${delay} ms`);
    this.state = 'starting';
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = null;
      this.spawnGeneration();
    }, delay);
  }

  fail(reason) {
    this.log.error('[Core] giving up:', reason);
    this.state = 'failed';
    this.emit('failed', reason);
    for (const waiter of this.readyWaiters.splice(0)) {
      waiter.reject(new CoreError('core_unavailable', reason));
    }
  }

  forwardLog(line) {
    if (!line) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      this.log.info('[Core]', line);
      return;
    }
    const { level, msg, ...fields } = entry;
    const logger = this.log[level] || this.log.info;
    logger.call(this.log, `[Core] ${msg}`, Object.keys(fields).length ? fields : '');
  }
}

module.exports = {
  CoreClient,
  CoreError,
  scrubbedEnv,
  PROTOCOL_VERSION,
  NO_RESTART_EXIT_CODES,
  RESTART_DELAYS_MS,
};
