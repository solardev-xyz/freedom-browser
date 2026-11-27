/**
 * Main's Ledger HID device (freedom-core design 0016, LDG-3; the LDG-3
 * plan's PR 5).
 *
 * Once the core drives the Ledger, the core builds every APDU and main only
 * carries each one to the device, one `shell.ledger_apdu` at a time (LDG-3's
 * relay, PR 6, calls this; nothing does yet). One HidDevice serves one
 * operation, the core request that holds the device lane:
 *
 * - **It opens at the operation's first APDU,** not before, and is closed
 *   at the operation's end (`detach()`), so Ledger Live can use the device
 *   in between, as today.
 * - **`exchange(apdu, ms, signal)`** sends one APDU and reads its answer
 *   under the APDU's `deadline_ms`: 15 s for one the user doesn't confirm,
 *   5 minutes for the one they do (0016, *Deadlines, cancel and
 *   unplugging*).
 * - **It lets go at once,** without waiting for the exchange in flight: on
 *   `detach()` (the parent ended, main's own cancel, a refused APDU), on the
 *   exchange's signal (the core cancelled the APDU), and on any failure.
 * - **It fails only as `{ failed }` names them:** `not_found`, `busy`,
 *   `disconnected`, `unresponsive` and `timeout` (HidDeviceError's
 *   `failure`).
 *
 * **node-hid runs in a utility process** (hid-host.js says why: node-hid
 * 2.1.2's and 3.4.0's close can free memory a Windows read still owns, the
 * plan's R1). Main never loads node-hid. HidHost forks the host at an
 * operation's first APDU and keeps it for the next; one operation's handle
 * is open in it at a time.
 *
 * - **Letting go with an exchange in flight kills the host:** the OS closes
 *   the handle and ends the read, and the late answer has no reader. The
 *   next operation's host is forked only once the old one has exited, so
 *   the old handle is closed before the new one opens (R5).
 * - **A kill always lands, and the wait for the exit is bounded.** Main
 *   posts nothing to a host before it has spawned, and Electron can't kill
 *   one before then, so a host killed that early is ended as it spawns,
 *   having got nothing. A killed host still running 2 s on gets SIGKILL
 *   (POSIX; Windows' kill already terminates it). One that still hasn't
 *   exited 5 s after the kill is given up on, and the next operation forks
 *   a fresh host: it was never sent anything, or was sent a kill it can't
 *   catch, so it can't use the device again (only the OS still has to
 *   close its handle). A host that was sent an exchange and that no kill
 *   reached is never given up on: no host is forked beside it, and each
 *   operation fails at once, trying the kill again, until one goes out.
 * - **With none in flight, the host closes the handle** (no read is pending
 *   then) and stays for the next operation, until a minute idle.
 * - **The host's `disconnected` kills it too** (it leaves its handle
 *   unclosed then), and **its exit** fails the exchange in flight
 *   `disconnected`, and the operation with it; the next operation forks a
 *   fresh host.
 * - **Replies are bounded before anything is decoded:** the host writes
 *   them as frames on its stdout (hid-host.js), main reads them with its
 *   own reader and builds each reply itself, and takes one per exchange in
 *   flight. Anything else (a frame out of bounds or of another shape, a
 *   reply main doesn't expect, any message on the host's message channel)
 *   kills the host, and main reads nothing more from it.
 * - **The host's environment is an allowlist** (hostEnv()), not main's.
 * - **Channels:** each operation's HID channel is drawn by main, and one
 *   whose exchange was let go of mid-flight is never drawn again while main
 *   runs, since the device may answer on it at any time later (a prompt
 *   rejected minutes on); the host drops every report on another channel.
 *   Once every channel has been let go of so, each new operation is
 *   refused.
 */

const crypto = require('crypto');
const path = require('path');
const log = require('../../logger');
const { HOST_FAILURES, LEDGER_VENDOR_ID, ReplyReader } = require('./hid-host');

const HOST_ENTRY = path.join(__dirname, 'hid-host.js');

/** 0016's APDU bounds (`shell.ledger_apdu`); the host's frames bound answers. */
const APDU_MIN = 5;
const APDU_MAX = 260;

/** The two `deadline_ms` values 0016 names. */
const DEADLINE_MS = Object.freeze({ DEVICE: 15_000, USER: 300_000 });

/** `{ failed }`'s values (0016, `shell.ledger_apdu`). */
const HID_FAILURES = Object.freeze({
  ...HOST_FAILURES,
  UNRESPONSIVE: 'unresponsive',
  TIMEOUT: 'timeout',
});

// An idle host (no operation holds the device) exits after this.
const IDLE_MS = 60_000;
// A killed host that hasn't exited by then gets SIGKILL (POSIX; Windows'
// kill already terminates it).
const KILL_GRACE_MS = 2_000;
// One that still hasn't exited this long after the kill is given up on.
const EXIT_WAIT_MS = 5_000;
// HID channels, 16 bits. Each one let go of mid-flight stays unused while
// main runs (a cancel, a deadline or a lost host each), so all of them
// being used up is never reached in practice; it refuses operations then.
const CHANNELS = 0x10000;

// The host's environment, by OS: what node-hid and a utility process need,
// and nothing else of main's (a credential among it). Linux's hidraw and
// macOS's IOKit read no variable; Windows' system libraries need its
// system directory.
const HOST_ENV = Object.freeze({
  win32: Object.freeze(['SystemRoot', 'SystemDrive', 'windir']),
});
// Always set, so the environment is never empty: given an empty `env`,
// Electron gives the utility process all of main's.
const HOST_MARKER = 'FREEDOM_LEDGER_HID_HOST';

/**
 * An exchange that failed. `failure` is one of HID_FAILURES. `detached`:
 * main let go of it (`detach()` or the exchange's signal), with `failure`
 * `disconnected`; the relay answers it `{ failed }` (the plan's point 5:
 * the core has ended the operation and drops it as late), and for an APDU
 * the core cancelled its race has answered `cancelled` first. Holds no APDU
 * or answer byte.
 */
class HidDeviceError extends Error {
  constructor(failure, { detached = false, reason = null, cause } = {}) {
    super(
      `Ledger HID: ${failure}${detached ? ' (closed by main)' : ''}${reason ? ` (${reason})` : ''}`,
      cause === undefined ? undefined : { cause }
    );
    this.name = 'HidDeviceError';
    this.failure = failure;
    this.detached = detached;
  }
}

/**
 * The host's whole environment: HOST_ENV's variables for `platform` that
 * `env` has, and the marker. `runAsNode`: a Node child on Electron's binary
 * (the device probe), which runs as Node only so.
 */
function hostEnv({ platform = process.platform, env = process.env, runAsNode = false } = {}) {
  const result = { [HOST_MARKER]: '1' };
  for (const name of HOST_ENV[platform] ?? []) {
    if (typeof env[name] === 'string') result[name] = env[name];
  }
  if (runAsNode) result.ELECTRON_RUN_AS_NODE = '1';
  return result;
}

/**
 * Fork the host, with hostEnv() as its environment and its stdout piped to
 * main: an Electron utility process in main, a Node child on the same
 * runtime elsewhere (the device probe, under ELECTRON_RUN_AS_NODE). Returns
 * HidHost's launcher: `post(message)` (once spawned); `kill()`, false when
 * it didn't go out (before the spawn, Electron's can't); `forceKill()`,
 * SIGKILL on POSIX and a terminate on Windows, true once a kill the process
 * can't catch went out or it is gone; `stopReading()`; `pid()`; and
 * `onSpawn`, `onData` (stdout's bytes), `onStray` (anything the host
 * posted on its message channel) and `onExit`.
 */
function launchHost() {
  const inMain = process.type === 'browser';
  const child = inMain
    ? require('electron').utilityProcess.fork(HOST_ENTRY, [], {
        serviceName: 'Freedom Ledger HID',
        env: hostEnv(),
        // stdout carries the replies; a utility process's stdin can only be
        // ignored.
        stdio: ['ignore', 'pipe', 'inherit'],
      })
    : require('child_process').fork(HOST_ENTRY, [], {
        env: hostEnv({ runAsNode: Boolean(process.versions.electron) }),
        stdio: ['ignore', 'pipe', 'inherit', 'ipc'],
      });
  // Its exit follows; an 'error' with no listener would throw in main.
  child.on('error', () => log.warn('[Ledger] The HID host failed'));
  let reader = null;
  // On Windows a kill that went out has terminated the process already.
  let terminated = false;
  const terminate = () => {
    const wentOut = child.kill();
    if (wentOut && process.platform === 'win32') terminated = true;
    return wentOut;
  };
  return {
    post: (message) => (inMain ? child.postMessage(message) : child.send(message)),
    kill: terminate,
    forceKill: () => {
      if (process.platform === 'win32') return terminate() || terminated;
      const pid = child.pid;
      if (!pid) return false;
      try {
        process.kill(pid, 'SIGKILL');
      } catch (err) {
        return err.code === 'ESRCH';
      }
      return true;
    },
    stopReading: () => {
      if (reader) child.stdout?.off('data', reader);
      child.stdout?.pause();
    },
    pid: () => child.pid,
    onSpawn: (fn) => child.once('spawn', fn),
    onData: (fn) => {
      reader = fn;
      child.stdout.on('data', fn);
    },
    onStray: (fn) => child.on('message', fn),
    onExit: (fn) => child.once('exit', fn),
  };
}

/**
 * The host process, one at a time, and what outlives an operation: the
 * operation holding the device, and the channels let go of mid-flight.
 */
class HidHost {
  /**
   * @param {object} [options]
   * @param {() => object} [options.launch] - forks a host (launchHost)
   * @param {number|null} [options.idleMs] - an idle host exits after it;
   *   null keeps it
   * @param {number} [options.channels] - the channels to draw from, 0 to
   *   this less one (the tests' smaller space)
   */
  constructor({ launch = launchHost, idleMs = IDLE_MS, channels = CHANNELS } = {}) {
    this._launch = launch;
    this._idleMs = idleMs;
    this._channels = channels;
    this._child = null;
    // The killed host being waited for: { child, promise, done }.
    this._exiting = null;
    // A killed host that was sent an exchange and that no kill reached.
    this._stuck = null;
    this._generation = 0;
    this._nextId = 1;
    this._waiters = new Map();
    this._abandoned = new Set();
    this._idle = null;
    /** The HidDevice whose operation holds the device. */
    this.holder = null;
  }

  /** The live host's number, or null. */
  get generation() {
    return this._child ? this._child.generation : null;
  }

  /** False while a killed host is still exiting: wait before forking. */
  get ready() {
    return this._exiting === null;
  }

  /** Resolves once the killed host has exited or been given up on. */
  whenReady() {
    return this._exiting?.promise ?? Promise.resolve();
  }

  nextId() {
    return this._nextId++;
  }

  /** A channel no exchange let go of mid-flight has used; null if none is left. */
  drawChannel(randomInt) {
    if (this._abandoned.size >= this._channels) return null;
    let channel;
    do {
      channel = randomInt(this._channels);
    } while (this._abandoned.has(channel));
    return channel;
  }

  /** The device may still answer on `channel`: never draw it again. */
  abandon(channel) {
    if (channel !== null) this._abandoned.add(channel);
  }

  /**
   * Post a message, forking a host if none runs (only once `ready`).
   * `onReply` gets the host's answer to it, or `{ op: 'exit' }`. Returns
   * the host's generation. Throws if no host can be forked.
   */
  send(message, onReply = null) {
    if (this._exiting) throw new Error('A killed host is still exiting');
    if (this._stuck) this._killStuck();
    clearTimeout(this._idle);
    this._idle = null;
    const child = this._child ?? this._fork();
    if (onReply) this._waiters.set(message.id, { generation: child.generation, onReply });
    this._post(child, message);
    return child.generation;
  }

  /** Ask the live host to close the handle (no exchange is in flight). */
  close() {
    if (this._child) this._post(this._child, { op: 'close' });
  }

  /**
   * Kill the live host and read nothing more from it; the next fork waits
   * for its exit, or for it to be given up on (the header's second point).
   */
  kill() {
    const child = this._child;
    if (!child) return;
    this._child = null;
    child.killed = true;
    child.held = [];
    child.reader.stop();
    child.proc.stopReading();
    let done;
    const promise = new Promise((resolve) => (done = resolve));
    this._exiting = { child, promise, done };
    // Not spawned yet: _onSpawn ends it.
    if (child.spawned && !child.proc.kill()) this._forceKill(child);
    child.timer = setTimeout(() => {
      this._forceKill(child);
      child.timer = setTimeout(() => this._giveUp(child), EXIT_WAIT_MS - KILL_GRACE_MS);
      child.timer.unref?.();
    }, KILL_GRACE_MS);
    child.timer.unref?.();
  }

  /** The operation holding the device ended. */
  release(device) {
    if (this.holder !== device) return;
    this.holder = null;
    if (this._idleMs === null || !this._child) return;
    clearTimeout(this._idle);
    this._idle = setTimeout(() => {
      this._idle = null;
      if (!this.holder) this.kill();
    }, this._idleMs);
    this._idle.unref?.();
  }

  _fork() {
    const generation = ++this._generation;
    const proc = this._launch();
    const child = {
      proc,
      generation,
      spawned: false,
      // Whether it was ever sent a message, and sent a kill it can't catch.
      posted: false,
      forced: false,
      killed: false,
      gone: false,
      held: [],
      timer: null,
      reader: null,
    };
    child.reader = new ReplyReader((reply) => this._onReply(child, reply));
    proc.onSpawn(() => this._onSpawn(child));
    proc.onData((chunk) => this._onData(child, chunk));
    proc.onStray(() => this._broke(child));
    proc.onExit(() => this._retire(child));
    this._child = child;
    return child;
  }

  // Nothing goes to a host before it has spawned: a host killed before then
  // must not get what Electron would deliver to it as it spawns.
  _post(child, message) {
    if (!child.spawned) {
      child.held.push(message);
      return;
    }
    child.posted = true;
    child.proc.post(message);
  }

  _onSpawn(child) {
    child.spawned = true;
    if (child.killed) {
      // Killed before it spawned, or given up on: it got nothing. End it.
      this._forceKill(child);
      return;
    }
    const held = child.held;
    child.held = [];
    for (const message of held) this._post(child, message);
  }

  _forceKill(child) {
    if (child.spawned && child.proc.forceKill()) child.forced = true;
  }

  // Still running EXIT_WAIT_MS after the kill.
  _giveUp(child) {
    child.timer = null;
    this._forceKill(child);
    if (child.posted && !child.forced) {
      log.warn('[Ledger] A killed HID host could not be ended: no other is started beside it');
      this._stuck = child;
      this._endExiting(child);
      return;
    }
    log.warn('[Ledger] A killed HID host has not exited: going on without it');
    this._retire(child);
  }

  // An operation while a host is stuck: try the kill again, or fail.
  _killStuck() {
    const stuck = this._stuck;
    this._forceKill(stuck);
    if (!stuck.forced) throw new Error('A killed host could not be ended');
    this._retire(stuck);
  }

  _endExiting(child) {
    if (this._exiting?.child !== child) return;
    const { done } = this._exiting;
    this._exiting = null;
    done();
  }

  // The host exited, or was given up on: its exchanges fail.
  _retire(child) {
    if (child.gone) return;
    child.gone = true;
    clearTimeout(child.timer);
    child.reader.stop();
    if (this._child === child) this._child = null;
    if (this._stuck === child) this._stuck = null;
    this._endExiting(child);
    for (const [id, waiter] of this._waiters) {
      if (waiter.generation !== child.generation) continue;
      this._waiters.delete(id);
      waiter.onReply({ op: 'exit' });
    }
  }

  _onData(child, chunk) {
    if (child.killed || child.gone) return;
    try {
      child.reader.push(chunk);
    } catch {
      this._broke(child);
    }
  }

  // One reply per exchange in flight, from the host it was sent to.
  _onReply(child, reply) {
    const waiter = this._waiters.get(reply.id);
    if (waiter?.generation !== child.generation) {
      this._broke(child);
      return;
    }
    this._waiters.delete(reply.id);
    waiter.onReply(reply);
  }

  // The host broke the protocol: it ends, and its exchanges with it.
  _broke(child) {
    if (child !== this._child) return;
    log.warn('[Ledger] The HID host sent something outside its protocol; ending it');
    this.kill();
  }
}

let sharedHost = null;
function defaultHost() {
  if (!sharedHost) sharedHost = new HidHost();
  return sharedHost;
}

class HidDevice {
  /**
   * @param {object} [options]
   * @param {HidHost} [options.host] - the process's shared host
   * @param {(max: number) => number} [options.randomInt] - crypto.randomInt
   */
  constructor({ host = defaultHost(), randomInt = crypto.randomInt } = {}) {
    this._host = host;
    this._randomInt = randomInt;
    this._channel = null;
    this._generation = null;
    this._pending = null;
    this._sent = false;
    this._ended = false;
    this._dropped = 0;
  }

  /** Whether this operation holds an open handle (or is opening one). */
  get isOpen() {
    return (
      this._sent &&
      !this._ended &&
      (this._generation === null || this._host.generation === this._generation)
    );
  }

  /** Reports the host read and dropped: another channel's or another tag's. */
  get droppedFrames() {
    return this._dropped;
  }

  /**
   * Send one APDU and read its answer. Opens the handle at the first.
   *
   * @param {Uint8Array} apdu - 5 to 260 bytes, admitted by the relay
   * @param {number} ms - its `deadline_ms`: DEADLINE_MS.DEVICE (no answer
   *   in it is `unresponsive`) or DEADLINE_MS.USER (`timeout`), counted
   *   from this call
   * @param {AbortSignal} [signal] - the core's cancel of the APDU: lets go,
   *   as `detach()` does
   * @returns {Promise<Buffer>} the answer, 2 to 260 bytes, its status word
   *   last. Rejects with a HidDeviceError; or, for a call the relay must
   *   never make (bounds, a second exchange in flight, after the end), with
   *   a TypeError or an Error, before anything is sent.
   */
  exchange(apdu, ms, signal = null) {
    return new Promise((resolve, reject) => {
      if (!(apdu instanceof Uint8Array) || apdu.length < APDU_MIN || apdu.length > APDU_MAX) {
        throw new TypeError(`An APDU is ${APDU_MIN} to ${APDU_MAX} bytes`);
      }
      if (ms !== DEADLINE_MS.DEVICE && ms !== DEADLINE_MS.USER) {
        throw new TypeError(`deadline_ms is ${DEADLINE_MS.DEVICE} or ${DEADLINE_MS.USER}`);
      }
      if (this._ended) throw new Error('This operation has ended: the next opens a new device');
      if (this._pending) throw new Error('One exchange at a time');

      const host = this._host;
      if (this._channel === null) {
        const channel = host.drawChannel(this._randomInt);
        if (channel === null) {
          // Every channel may still carry a late answer: refuse rather than reuse.
          log.warn('[Ledger] No HID channel is left: restart Freedom to use the Ledger');
          this._end();
          reject(new HidDeviceError(HID_FAILURES.DISCONNECTED, { reason: 'no HID channel left' }));
          return;
        }
        this._channel = channel;
      }
      const pending = { resolve, reject, signal, onAbort: null, deadline: null, sent: false };
      this._pending = pending;
      if (this._generation !== null && host.generation !== this._generation) {
        // The host this operation opened in has exited: so has its handle.
        this._end();
        this._settle(pending, new HidDeviceError(HID_FAILURES.DISCONNECTED));
        return;
      }
      if (signal) {
        if (signal.aborted) {
          this.detach();
          return;
        }
        pending.onAbort = () => this.detach();
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      if (host.holder && host.holder !== this) {
        // The relay ends an operation before it starts the next; this is
        // the backstop (close before open).
        log.warn('[Ledger] Let go of a device an ended operation still held');
        host.holder.detach();
      }
      host.holder = this;
      pending.deadline = setTimeout(
        () =>
          this._abandon(ms === DEADLINE_MS.USER ? HID_FAILURES.TIMEOUT : HID_FAILURES.UNRESPONSIVE),
        ms
      );
      this._sent = true;
      const message = {
        op: 'exchange',
        id: host.nextId(),
        channel: this._channel,
        apdu: Buffer.from(apdu).toString('hex'),
      };
      const send = () => {
        if (this._pending !== pending) return;
        let generation;
        try {
          generation = host.send(message, (reply) => this._onReply(pending, reply));
        } catch (err) {
          this._end();
          this._settle(pending, new HidDeviceError(HID_FAILURES.DISCONNECTED, { cause: err }));
          return;
        }
        pending.sent = true;
        if (this._generation === null) this._generation = generation;
      };
      // A killed host is exiting: fork the next only once it has.
      const whenReady = () => (host.ready ? send() : host.whenReady().then(whenReady));
      whenReady();
    });
  }

  /**
   * End the operation now, whatever is in flight: an exchange in flight
   * rejects (`detached`) and its host is killed; otherwise the host closes
   * the handle. Safe to call again, and before any APDU.
   */
  detach() {
    const pending = this._pending;
    if (!this._ended) this._letGo(pending);
    if (pending) {
      this._settle(pending, new HidDeviceError(HID_FAILURES.DISCONNECTED, { detached: true }));
    }
  }

  // An exchange the host has: kill it, since its read may be in flight, and
  // never draw the channel again. Otherwise no read is in flight, and the
  // host closes the handle.
  _letGo(pending) {
    if (pending?.sent) {
      this._host.abandon(this._channel);
      this._host.kill();
    } else if (this.isOpen && this._generation !== null) {
      this._host.close();
    }
    this._end();
  }

  _onReply(pending, reply) {
    if (this._pending !== pending) return;
    // The host sends its session's running total: keep it, don't add it.
    this._dropped = Math.max(this._dropped, reply.dropped ?? 0);
    if (reply.op === 'answer') {
      this._settle(pending, null, reply.answer);
      return;
    }
    if (reply.op !== 'failed' || reply.failure === HID_FAILURES.DISCONNECTED) {
      // The device went away or broke its stream, or the host exited. A
      // host that failed keeps its handle unclosed (a failed write can still
      // be pending): it's killed, as for a cancel.
      this._host.abandon(this._channel);
      if (reply.op === 'failed') this._host.kill();
    }
    // not_found and busy: nothing was opened.
    this._end();
    this._settle(
      pending,
      new HidDeviceError(reply.op === 'failed' ? reply.failure : HID_FAILURES.DISCONNECTED)
    );
  }

  /** A deadline: let go mid-flight, as detach() does, with `failure`. */
  _abandon(failure) {
    const pending = this._pending;
    if (!pending) return;
    this._letGo(pending);
    this._settle(pending, new HidDeviceError(failure));
  }

  _end() {
    this._ended = true;
    this._host.release(this);
  }

  _settle(pending, err, answer) {
    clearTimeout(pending.deadline);
    if (pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    if (this._pending === pending) this._pending = null;
    if (err) pending.reject(err);
    else pending.resolve(answer);
  }
}

module.exports = {
  HidDevice,
  HidDeviceError,
  HidHost,
  HID_FAILURES,
  DEADLINE_MS,
  LEDGER_VENDOR_ID,
  hostEnv,
  launchHost,
};
