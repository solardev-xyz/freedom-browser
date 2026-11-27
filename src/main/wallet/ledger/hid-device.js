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
 * - **It closes the handle at once,** without waiting for the exchange in
 *   flight: on `detach()` (the parent ended, main's own cancel, a refused
 *   APDU), on the exchange's signal (the core cancelled the APDU), and on
 *   any failure. A late answer then has no reader.
 * - **It fails only as `{ failed }` names them:** `not_found`, `busy`,
 *   `disconnected`, `unresponsive` and `timeout` (HidDeviceError's
 *   `failure`).
 *
 * **Not TransportNodeHid:** its `close()` awaits the exchange in flight
 * (`await this.exchangeBusyPromise`), so it can't cancel. Main frames the
 * APDU with `@ledgerhq/hw-transport-node-hid-noevents`' HID framing and
 * drives node-hid itself (the plan's point 15).
 *
 * **Why it polls (the plan's R1).** node-hid 2.1.2's `read(cb)` runs
 * hidapi's `hid_read_timeout` on a libuv threadpool thread (`ReadWorker`,
 * HID.cc:146–157) while `close()` frees the `hid_device` on the main thread
 * (HID.cc:123–129, 328–334), with no lock between them; hidapi 0.10.1 is
 * not thread-safe per device, and each OS's read touches what `hid_close`
 * frees (in node-hid's hidapi/: Linux: the device's error string and its fd, linux/hid.c:961–997
 * against 1055–1068; macOS: the mutex and condition the read waits on,
 * mac/hid.c:1021–1093 against 1123–1175; Windows: an overlapped read issued
 * on the worker thread, which the main thread's `CancelIo` doesn't cancel,
 * written into freed memory, windows/hid.c:724–799 against 921–927). So
 * node-hid's close is not safe while its `read(cb)` is in flight, and this
 * layer never calls `read(cb)`: it polls `readTimeout(0)`, hidapi's
 * non-blocking read, from a timer on the main thread, so `close()` always
 * runs between two polls, on the thread that issued them. An abandoned
 * `read(cb)` would also hold one of libuv's four threadpool threads until a
 * report arrived (possibly never); a poll holds none. LDG-3's device probe
 * (`hid-device.probe.test.js`, docs/development.md) checks it on each OS.
 */

const crypto = require('crypto');
const log = require('../../logger');

// @ledgerhq/devices' ledgerUSBVendorId (hid-device.test.js checks it).
const LEDGER_VENDOR_ID = 0x2c97;
// The APDU interface: by usage page where hidapi reports one, by interface
// number on Linux (noevents' `getDevices` filter).
const LEDGER_USAGE_PAGE = 0xffa0;
const PACKET_SIZE = 64;
const TAG_APDU = 0x05;
// Each write starts with the report ID: 0, since the device numbers no
// reports (hidapi strips it).
const REPORT_ID = 0x00;

/** 0016's APDU and answer bounds (`shell.ledger_apdu`). */
const APDU_MIN = 5;
const APDU_MAX = 260;
const ANSWER_MIN = 2;
const ANSWER_MAX = 260;

/** The two `deadline_ms` values 0016 names. */
const DEADLINE_MS = Object.freeze({ DEVICE: 15_000, USER: 300_000 });

/** `{ failed }`'s values (0016, `shell.ledger_apdu`). */
const HID_FAILURES = Object.freeze({
  NOT_FOUND: 'not_found',
  BUSY: 'busy',
  DISCONNECTED: 'disconnected',
  UNRESPONSIVE: 'unresponsive',
  TIMEOUT: 'timeout',
});

// How often a waiting exchange polls: every millisecond while an answer
// that needs no confirmation is likely, then less often while the device
// waits for the user. Up to FRAMES_PER_POLL reports are read per poll (an
// answer of 260 bytes is 5), so a flood from another channel can't hold the
// main thread. PR 13's recordings measure the time per APDU (R3).
const POLL_STEPS = Object.freeze([
  Object.freeze({ untilMs: 100, everyMs: 1 }),
  Object.freeze({ untilMs: 1_000, everyMs: 5 }),
  Object.freeze({ untilMs: Infinity, everyMs: 20 }),
]);
const FRAMES_PER_POLL = 8;
// A new handle's channel is none of the last few, so a closed handle's late
// answer, which carries its channel, is never read as the new one's.
const RECENT_CHANNELS = 16;

/**
 * An exchange that failed. `failure` is one of HID_FAILURES. `detached`:
 * main closed the handle under it (`detach()` or the exchange's signal),
 * with `failure` `disconnected`; the relay answers it `{ failed }` (the
 * plan's point 5: the core has ended the operation and drops it as late),
 * and for an APDU the core cancelled its race has answered `cancelled`
 * first. Holds no APDU or answer byte.
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

// Lazy-required, as transport.js does: node-hid's native module loads at the
// first APDU, never at startup.
let nodeHid = null;
function loadNodeHid() {
  if (!nodeHid) nodeHid = require('node-hid');
  return nodeHid;
}
let hidFraming = null;
function framingFor(channel) {
  if (!hidFraming) {
    hidFraming = require('@ledgerhq/hw-transport-node-hid-noevents/hid-framing').default;
  }
  return hidFraming(channel, PACKET_SIZE);
}

// Per node-hid module: the device holding its open handle, and the recent
// channels. One handle at a time (R5: close before open).
const ports = new WeakMap();
function portOf(hid) {
  let port = ports.get(hid);
  if (!port) {
    port = { holder: null, channels: [] };
    ports.set(hid, port);
  }
  return port;
}

function isApduInterface(platform) {
  return platform === 'win32' || platform === 'darwin'
    ? (info) => info.usagePage === LEDGER_USAGE_PAGE
    : (info) => info.interface === 0;
}

class HidDevice {
  /**
   * @param {object} [options]
   * @param {object} [options.hid] - node-hid's API (`devices`, `HID`); node-hid
   *   itself, loaded at the first APDU, unless a test passes a fake
   * @param {string} [options.platform] - process.platform
   * @param {(max: number) => number} [options.randomInt] - crypto.randomInt
   */
  constructor({ hid = null, platform = process.platform, randomInt = crypto.randomInt } = {}) {
    this._hid = hid;
    this._platform = platform;
    this._randomInt = randomInt;
    this._handle = null;
    this._channel = null;
    this._pending = null;
    this._ended = false;
    this._droppedFrames = 0;
  }

  /** Whether the node-hid handle is open. */
  get isOpen() {
    return this._handle !== null;
  }

  /** Reports read and dropped: another channel's or another tag's. */
  get droppedFrames() {
    return this._droppedFrames;
  }

  /**
   * Send one APDU and read its answer. Opens the handle at the first.
   *
   * @param {Uint8Array} apdu - 5 to 260 bytes, admitted by the relay
   * @param {number} ms - its `deadline_ms`: DEADLINE_MS.DEVICE (no answer
   *   in it is `unresponsive`) or DEADLINE_MS.USER (`timeout`), counted
   *   from this call
   * @param {AbortSignal} [signal] - the core's cancel of the APDU: closes
   *   the handle, as `detach()` does
   * @returns {Promise<Buffer>} the answer, 2 to 260 bytes, its status word
   *   last. Rejects with a HidDeviceError; or, for a call the relay must
   *   never make (bounds, a second exchange in flight, after the end), with
   *   a TypeError or an Error, before any byte is written.
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

      const pending = {
        resolve,
        reject,
        ms,
        signal,
        onAbort: null,
        deadline: null,
        poll: null,
        framing: null,
        acc: null,
        writtenAt: 0,
      };
      this._pending = pending;
      if (signal) {
        if (signal.aborted) {
          this.detach();
          return;
        }
        pending.onAbort = () => this.detach();
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      pending.deadline = setTimeout(
        () =>
          this._fail(ms === DEADLINE_MS.USER ? HID_FAILURES.TIMEOUT : HID_FAILURES.UNRESPONSIVE),
        ms
      );
      if (!this._handle && !this._open()) return;
      if (!this._write(pending, apdu)) return;
      this._schedulePoll(pending);
    });
  }

  /**
   * End the operation: close the handle now, whatever is in flight. The
   * exchange in flight rejects (`detached`); its answer has no reader. Safe
   * to call again, and before any APDU (nothing was opened).
   */
  detach() {
    const pending = this._pending;
    this._close();
    if (pending) {
      this._settle(pending);
      pending.reject(new HidDeviceError(HID_FAILURES.DISCONNECTED, { detached: true }));
    }
  }

  _open() {
    let hid;
    let info;
    try {
      hid = this._hid ?? loadNodeHid();
      this._hid = hid;
      const port = portOf(hid);
      if (port.holder && port.holder !== this) {
        // The relay closes before it opens; this is the backstop, as on
        // macOS, which seizes the device, the open would fail.
        log.warn('[Ledger] Closed a device handle an ended operation left open');
        port.holder.detach();
      }
      info = hid.devices(LEDGER_VENDOR_ID, 0).find(isApduInterface(this._platform));
    } catch (err) {
      this._fail(HID_FAILURES.NOT_FOUND, err);
      return false;
    }
    if (!info || typeof info.path !== 'string') {
      this._fail(HID_FAILURES.NOT_FOUND);
      return false;
    }
    let handle;
    try {
      handle = new hid.HID(info.path);
    } catch (err) {
      // Listed but not opened. On macOS (hidapi seizes the device) and
      // Windows, another app holds it, Ledger Live most often (R8). Linux's
      // hidraw takes any number of handles, so there it's the device node's
      // permissions (Ledger's udev rules) or the device going away.
      this._fail(this._platform === 'linux' ? HID_FAILURES.NOT_FOUND : HID_FAILURES.BUSY, err);
      return false;
    }
    const port = portOf(hid);
    this._handle = handle;
    this._channel = this._pickChannel(port);
    port.holder = this;
    return true;
  }

  _pickChannel(port) {
    let channel;
    do {
      channel = this._randomInt(0x10000);
    } while (port.channels.includes(channel));
    port.channels.push(channel);
    if (port.channels.length > RECENT_CHANNELS) port.channels.shift();
    return channel;
  }

  // node-hid's write is synchronous on the main thread, as noevents'
  // writeHID is under today's transport.
  _write(pending, apdu) {
    pending.framing = framingFor(this._channel);
    const blocks = pending.framing.makeBlocks(Buffer.from(apdu));
    try {
      for (const block of blocks) this._handle.write([REPORT_ID, ...block]);
    } catch (err) {
      this._fail(HID_FAILURES.DISCONNECTED, err);
      return false;
    }
    pending.writtenAt = Date.now();
    return true;
  }

  _schedulePoll(pending) {
    const waited = Date.now() - pending.writtenAt;
    const { everyMs } = POLL_STEPS.find((step) => waited < step.untilMs);
    pending.poll = setTimeout(() => this._poll(pending), everyMs);
  }

  _poll(pending) {
    // Settled, detached or failed since it was scheduled: the handle may be
    // closed, and readTimeout on a closed node-hid handle reads freed memory.
    if (this._pending !== pending) return;
    pending.poll = null;
    for (let i = 0; i < FRAMES_PER_POLL; i++) {
      let report;
      try {
        report = this._handle.readTimeout(0);
      } catch (err) {
        // hidapi's read failed: the device went away (0016: unplugged).
        this._fail(HID_FAILURES.DISCONNECTED, err);
        return;
      }
      if (!report || report.length === 0) break;
      this._take(pending, Buffer.from(report));
      // The answer is whole, or the stream broke: read nothing more, so no
      // read is left pending on the handle (Windows' overlapped read).
      if (this._pending !== pending) return;
    }
    this._schedulePoll(pending);
  }

  _take(pending, frame) {
    if (frame.length < 5 || frame.readUInt16BE(0) !== this._channel || frame[2] !== TAG_APDU) {
      // Another channel's (a closed handle's late answer, or another app's
      // on Linux and Windows, which deliver every report to every handle).
      this._droppedFrames++;
      return;
    }
    const first = !pending.acc;
    const sequence = frame.readUInt16BE(3);
    if (sequence !== (first ? 0 : pending.acc.sequence)) {
      this._fail(HID_FAILURES.DISCONNECTED);
      return;
    }
    if (first) {
      const length = frame.length >= 7 ? frame.readUInt16BE(5) : -1;
      if (length < ANSWER_MIN || length > ANSWER_MAX) {
        this._fail(HID_FAILURES.DISCONNECTED);
        return;
      }
    }
    try {
      pending.acc = pending.framing.reduceResponse(pending.acc, frame);
    } catch (err) {
      this._fail(HID_FAILURES.DISCONNECTED, err);
      return;
    }
    const answer = pending.framing.getReducedResult(pending.acc);
    if (!answer) return;
    this._settle(pending);
    pending.resolve(Buffer.from(answer));
  }

  /** Close the handle (failing the exchange in flight) and end the operation. */
  _fail(failure, cause) {
    const pending = this._pending;
    this._close();
    if (pending) {
      this._settle(pending);
      pending.reject(new HidDeviceError(failure, { cause }));
    }
  }

  _settle(pending) {
    clearTimeout(pending.deadline);
    clearTimeout(pending.poll);
    if (pending.onAbort) pending.signal.removeEventListener('abort', pending.onAbort);
    if (this._pending === pending) this._pending = null;
  }

  _close() {
    this._ended = true;
    const handle = this._handle;
    if (!handle) return;
    this._handle = null;
    const port = portOf(this._hid);
    if (port.holder === this) port.holder = null;
    try {
      handle.close();
    } catch {
      // node-hid's close doesn't throw; a handle that did is gone either way.
    }
  }
}

module.exports = {
  HidDevice,
  HidDeviceError,
  HID_FAILURES,
  DEADLINE_MS,
  LEDGER_VENDOR_ID,
  POLL_STEPS,
};
