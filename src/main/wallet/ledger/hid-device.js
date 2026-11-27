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
 * - **With none in flight, the host closes the handle** (no read is pending
 *   then) and stays for the next operation, until a minute idle.
 * - **The host's `disconnected` kills it too** (it leaves its handle
 *   unclosed then), and **its exit** fails the exchange in flight
 *   `disconnected`, and the operation with it; the next operation forks a
 *   fresh host.
 * - **Channels:** each operation's HID channel is drawn by main, and one
 *   whose exchange was let go of mid-flight is never drawn again while main
 *   runs, since the device may answer on it at any time later (a prompt
 *   rejected minutes on); the host drops every report on another channel.
 */

const crypto = require('crypto');
const path = require('path');
const log = require('../../logger');
const { HOST_FAILURES, LEDGER_VENDOR_ID } = require('./hid-host');

const HOST_ENTRY = path.join(__dirname, 'hid-host.js');

/** 0016's APDU and answer bounds (`shell.ledger_apdu`). */
const APDU_MIN = 5;
const APDU_MAX = 260;
const ANSWER_MIN = 2;
const ANSWER_MAX = 260;

/** The two `deadline_ms` values 0016 names. */
const DEADLINE_MS = Object.freeze({ DEVICE: 15_000, USER: 300_000 });

/** `{ failed }`'s values (0016, `shell.ledger_apdu`). */
const HID_FAILURES = Object.freeze({
  ...HOST_FAILURES,
  UNRESPONSIVE: 'unresponsive',
  TIMEOUT: 'timeout',
});
const HOST_FAILURE_VALUES = new Set(Object.values(HOST_FAILURES));

// An idle host (no operation holds the device) exits after this.
const IDLE_MS = 60_000;
// A killed utility process that hasn't exited by then gets SIGKILL (POSIX;
// Windows' kill already terminates it).
const KILL_GRACE_MS = 2_000;
// Channels let go of mid-flight, kept unused. Each is a cancel, a deadline
// or a lost host, so this is never reached in practice; past it the oldest
// is drawn again.
const ABANDONED_MAX = 32_768;

/**
 * An exchange that failed. `failure` is one of HID_FAILURES. `detached`:
 * main let go of it (`detach()` or the exchange's signal), with `failure`
 * `disconnected`; the relay answers it `{ failed }` (the plan's point 5:
 * the core has ended the operation and drops it as late), and for an APDU
 * the core cancelled its race has answered `cancelled` first. Holds no APDU
 * or answer byte.
 */
class HidDeviceError extends Error {
  constructor(failure, { detached = false, cause } = {}) {
    super(
      `Ledger HID: ${failure}${detached ? ' (closed by main)' : ''}`,
      cause === undefined ? undefined : { cause }
    );
    this.name = 'HidDeviceError';
    this.failure = failure;
    this.detached = detached;
  }
}

function isHex(text, minBytes, maxBytes) {
  return (
    typeof text === 'string' &&
    text.length % 2 === 0 &&
    text.length >= minBytes * 2 &&
    text.length <= maxBytes * 2 &&
    /^[0-9a-f]*$/.test(text)
  );
}

const isCount = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * Fork the host: an Electron utility process in main, a Node child on the
 * same runtime elsewhere (the device probe, under ELECTRON_RUN_AS_NODE).
 * Returns `{ post, kill, onMessage, onExit }`.
 */
function launchHost() {
  if (process.type === 'browser') {
    const { utilityProcess } = require('electron');
    const child = utilityProcess.fork(HOST_ENTRY, [], { serviceName: 'Freedom Ledger HID' });
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    return {
      post: (message) => child.postMessage(message),
      kill: () => {
        const pid = child.pid;
        child.kill();
        if (process.platform === 'win32' || !pid) return;
        const timer = setTimeout(() => {
          if (exited) return;
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Gone already.
          }
        }, KILL_GRACE_MS);
        timer.unref?.();
        child.once('exit', () => clearTimeout(timer));
      },
      onMessage: (fn) => child.on('message', fn),
      onExit: (fn) => child.once('exit', fn),
    };
  }
  const { fork } = require('child_process');
  const child = fork(HOST_ENTRY, [], { stdio: 'inherit' });
  return {
    post: (message) => child.send(message),
    kill: () => child.kill('SIGKILL'),
    onMessage: (fn) => child.on('message', fn),
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
   */
  constructor({ launch = launchHost, idleMs = IDLE_MS } = {}) {
    this._launch = launch;
    this._idleMs = idleMs;
    this._child = null;
    this._exiting = null;
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

  whenReady() {
    return this._exiting ?? Promise.resolve();
  }

  nextId() {
    return this._nextId++;
  }

  /** A channel no exchange let go of mid-flight has used. */
  drawChannel(randomInt) {
    let channel;
    do {
      channel = randomInt(0x10000);
    } while (this._abandoned.has(channel));
    return channel;
  }

  /** The device may still answer on `channel`: never draw it again. */
  abandon(channel) {
    if (channel === null) return;
    this._abandoned.delete(channel);
    this._abandoned.add(channel);
    if (this._abandoned.size > ABANDONED_MAX) {
      this._abandoned.delete(this._abandoned.values().next().value);
    }
  }

  /**
   * Post a message, forking a host if none runs (only once `ready`).
   * `onReply` gets the host's answer to it, or `{ op: 'exit' }`. Returns
   * the host's generation.
   */
  send(message, onReply = null) {
    if (this._exiting) throw new Error('A killed host is still exiting');
    clearTimeout(this._idle);
    this._idle = null;
    const child = this._child ?? this._fork();
    if (onReply) this._waiters.set(message.id, { generation: child.generation, onReply });
    child.proc.post(message);
    return child.generation;
  }

  /** Ask the live host to close the handle (no exchange is in flight). */
  close() {
    this._child?.proc.post({ op: 'close' });
  }

  /** Kill the live host; the next fork waits for its exit. */
  kill() {
    const child = this._child;
    if (!child) return;
    this._child = null;
    const exiting = child.exited.then(() => {
      if (this._exiting === exiting) this._exiting = null;
    });
    this._exiting = exiting;
    child.proc.kill();
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
    let exited;
    const child = { proc, generation, exited: new Promise((resolve) => (exited = resolve)) };
    proc.onMessage((message) => this._onMessage(child, message));
    proc.onExit(() => {
      if (this._child === child) this._child = null;
      exited();
      for (const [id, waiter] of this._waiters) {
        if (waiter.generation !== generation) continue;
        this._waiters.delete(id);
        waiter.onReply({ op: 'exit' });
      }
    });
    this._child = child;
    return child;
  }

  _onMessage(child, message) {
    if (this._child !== child) return;
    const { op, id, answer, failure, dropped } = message ?? {};
    const waiter = this._waiters.get(id);
    const valid =
      waiter?.generation === child.generation &&
      isCount(dropped) &&
      ((op === 'answer' && isHex(answer, ANSWER_MIN, ANSWER_MAX)) ||
        (op === 'failed' && HOST_FAILURE_VALUES.has(failure)));
    if (!valid) {
      // The host broke the protocol: it ends, and its exchanges with it.
      log.warn('[Ledger] The HID host sent a message outside its protocol; ending it');
      this.kill();
      return;
    }
    this._waiters.delete(id);
    waiter.onReply(message);
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
      if (this._channel === null) this._channel = host.drawChannel(this._randomInt);
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
    this._dropped += reply.dropped ?? 0;
    if (reply.op === 'answer') {
      this._settle(pending, null, Buffer.from(reply.answer, 'hex'));
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
};
