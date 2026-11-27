/**
 * The Ledger HID host (freedom-core design 0016, LDG-3; the LDG-3 plan's
 * PR 5): the process main's HID device (hid-device.js) runs node-hid in, an
 * Electron utility process, so that nothing native HID code does can take
 * main down. Main forks it at an operation's first APDU and speaks to it in
 * messages; this module is its entry point (`require.main === module`) and,
 * for tests, its parts.
 *
 * **Messages.** Main sends `{ op: 'exchange', id, channel, apdu }` (the APDU
 * in hex, on the operation's HID channel; the first opens the device) and
 * `{ op: 'close' }` (the operation ended with no exchange in flight). The
 * host answers each exchange once: `{ op: 'answer', id, answer, dropped }`
 * (hex, the status word last) or `{ op: 'failed', id, failure, dropped }`,
 * `failure` one of `not_found`, `busy`, `disconnected`; `dropped` counts the
 * reports it dropped. Anything else ends the host.
 *
 * **Main kills it, never asks it to close mid-read.** A cancel or a deadline
 * reaches main while the host may be waiting on the device, and main then
 * kills this process: the OS closes the device handle and finishes the
 * pending read itself, so no user-mode close ever races a read (the plan's
 * R1, below). The host closes the handle itself only on `close`, sent once
 * the last exchange was answered: that read completed, and nothing is
 * pending. On its own failure (a write or read that failed, a broken
 * report) it answers `failed` and leaves the handle as it is, since a
 * failed Windows write can still be pending (hidapi 0.10.1's `hid_write`
 * gives up after 1 s and leaves it, windows/hid.c:694–702); main kills it
 * then too.
 *
 * **Why (R1).** node-hid 2.1.2's `close()` frees the hidapi device without
 * waiting for a read in flight (HID.cc:123–129, 328–334, against the
 * threadpool read at 146–157). Even with every call on one thread, which is
 * how this host polls (`readTimeout(0)`, hidapi's non-blocking read), the
 * Windows read leaves an overlapped `ReadFile` pending when no report is
 * ready (node-hid's hidapi 0.10.1, windows/hid.c:757–763), and `hid_close`
 * calls `CancelIo` and frees the event, the `OVERLAPPED` and the buffer at
 * once (921–927, 175–183), without waiting for the cancel to complete.
 * node-hid 3.4.0 doesn't fix it: its `close()` stops and waits for its read
 * thread before `hid_close` (src/HIDAsync.cc:72–88, src/read.cc:128–169),
 * but that thread's last read leaves the same pending `ReadFile`
 * (hidapi 0.15.0, windows/hid.c:1191–1198), and `hid_close` is unchanged
 * (1408–1415), now on another thread, whose `CancelIo` doesn't even cancel
 * it. Killing the process is the one close the OS makes safe: it finishes
 * every pending read before it frees the process's memory.
 */

const LEDGER_VENDOR_ID = 0x2c97;
// The APDU interface: by usage page where hidapi reports one, by interface
// number on Linux (noevents' `getDevices` filter).
const LEDGER_USAGE_PAGE = 0xffa0;
// The Ledger's HID packet: every report it sends is exactly this long.
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

/** The host's own failures (main adds `unresponsive` and `timeout`). */
const HOST_FAILURES = Object.freeze({
  NOT_FOUND: 'not_found',
  BUSY: 'busy',
  DISCONNECTED: 'disconnected',
});

// How often an exchange polls: every millisecond while an answer that needs
// no confirmation is likely, then less often while the device waits for the
// user. Up to FRAMES_PER_POLL reports are read per poll (an answer of 260
// bytes is 5), so a flood from another channel can't hold the host. PR 13's
// recordings measure the time per APDU (R3).
const POLL_STEPS = Object.freeze([
  Object.freeze({ untilMs: 100, everyMs: 1 }),
  Object.freeze({ untilMs: 1_000, everyMs: 5 }),
  Object.freeze({ untilMs: Infinity, everyMs: 20 }),
]);
const FRAMES_PER_POLL = 8;

class HostFailure extends Error {
  constructor(failure, cause) {
    super(`Ledger HID: ${failure}`, cause === undefined ? undefined : { cause });
    this.name = 'HostFailure';
    this.failure = failure;
  }
}

let hidFraming = null;
function framingFor(channel) {
  if (!hidFraming) {
    hidFraming = require('@ledgerhq/hw-transport-node-hid-noevents/hid-framing').default;
  }
  return hidFraming(channel, PACKET_SIZE);
}

function isApduInterface(platform) {
  return platform === 'win32' || platform === 'darwin'
    ? (info) => info.usagePage === LEDGER_USAGE_PAGE
    : (info) => info.interface === 0;
}

/**
 * One operation's node-hid handle, on its channel. Polls; never calls
 * node-hid's threadpool `read(cb)`, and never `close()`s with a read in
 * flight (the host is killed instead).
 */
class HidSession {
  constructor({ hid, platform = process.platform, channel }) {
    this._hid = hid;
    this._platform = platform;
    this._channel = channel;
    this._handle = null;
    this._pending = null;
    this.dropped = 0;
  }

  get channel() {
    return this._channel;
  }

  get isOpen() {
    return this._handle !== null;
  }

  get inFlight() {
    return this._pending !== null;
  }

  /** Open the APDU interface; throws a HostFailure. */
  open() {
    const info = this._listed();
    if (!info) throw new HostFailure(HOST_FAILURES.NOT_FOUND);
    try {
      this._handle = new this._hid.HID(info.path);
    } catch (err) {
      // Listed but not opened. Gone since (unplugged between the two):
      // not_found. Still listed: on macOS (hidapi seizes the device) and
      // Windows another app holds it, Ledger Live most often (R8); Linux's
      // hidraw takes any number of handles, so there it's the device
      // node's permissions (Ledger's udev rules): not_found too.
      const still = this._platform !== 'linux' && this._listed(info.path);
      throw new HostFailure(still ? HOST_FAILURES.BUSY : HOST_FAILURES.NOT_FOUND, err);
    }
  }

  _listed(path = null) {
    let list;
    try {
      list = this._hid.devices(LEDGER_VENDOR_ID, 0);
    } catch (err) {
      if (path) return null;
      throw new HostFailure(HOST_FAILURES.NOT_FOUND, err);
    }
    const info = list.find(isApduInterface(this._platform));
    if (!info || typeof info.path !== 'string') return null;
    return path === null || info.path === path ? info : null;
  }

  /**
   * Send one APDU and read its answer. A failure leaves the handle unclosed
   * (main kills the host) and rejects with a HostFailure.
   *
   * @param {Buffer} apdu
   * @returns {Promise<Buffer>}
   */
  exchange(apdu) {
    return new Promise((resolve, reject) => {
      if (!this._handle) throw new Error('The session is not open');
      if (this._pending) throw new Error('One exchange at a time');
      const pending = { resolve, reject, framing: framingFor(this._channel), acc: null, at: 0 };
      this._pending = pending;
      try {
        for (const block of pending.framing.makeBlocks(apdu)) {
          this._handle.write([REPORT_ID, ...block]);
        }
      } catch (err) {
        this._fail(HOST_FAILURES.DISCONNECTED, err);
        return;
      }
      pending.at = Date.now();
      this._schedule(pending);
    });
  }

  /** Close the handle. Only with no exchange in flight (main kills instead). */
  close() {
    if (this._pending) throw new Error('An exchange is in flight: the host is killed instead');
    const handle = this._handle;
    this._handle = null;
    if (handle) handle.close();
  }

  /** Stop polling without touching the handle: the process is ending. */
  abandon() {
    if (this._pending) clearTimeout(this._pending.poll);
    this._pending = null;
    this._handle = null;
  }

  _schedule(pending) {
    const waited = Date.now() - pending.at;
    const { everyMs } = POLL_STEPS.find((step) => waited < step.untilMs);
    pending.poll = setTimeout(() => this._poll(pending), everyMs);
  }

  _poll(pending) {
    // Settled or abandoned since: the handle may be closed, and readTimeout
    // on a closed node-hid handle reads freed memory.
    if (this._pending !== pending) return;
    for (let i = 0; i < FRAMES_PER_POLL; i++) {
      let report;
      try {
        report = this._handle.readTimeout(0);
      } catch (err) {
        // hidapi's read failed, and finished: the device went away.
        this._fail(HOST_FAILURES.DISCONNECTED, err);
        return;
      }
      if (!report || report.length === 0) break;
      this._take(pending, Buffer.from(report));
      // The answer is whole, or the stream broke: read nothing more, so no
      // read is left pending on the handle (Windows' overlapped read).
      if (this._pending !== pending) return;
    }
    this._schedule(pending);
  }

  _take(pending, frame) {
    if (frame.length < 2 || frame.readUInt16BE(0) !== this._channel) {
      // Another channel's: a killed host's late answer, or another app's on
      // Linux and Windows, which deliver every report to every handle.
      this.dropped++;
      return;
    }
    if (frame.length !== PACKET_SIZE) {
      this._fail(HOST_FAILURES.DISCONNECTED);
      return;
    }
    if (frame[2] !== TAG_APDU) {
      this.dropped++;
      return;
    }
    const first = !pending.acc;
    if (frame.readUInt16BE(3) !== (first ? 0 : pending.acc.sequence)) {
      this._fail(HOST_FAILURES.DISCONNECTED);
      return;
    }
    if (first) {
      const length = frame.readUInt16BE(5);
      if (length < ANSWER_MIN || length > ANSWER_MAX) {
        this._fail(HOST_FAILURES.DISCONNECTED);
        return;
      }
    }
    try {
      pending.acc = pending.framing.reduceResponse(pending.acc, frame);
    } catch (err) {
      this._fail(HOST_FAILURES.DISCONNECTED, err);
      return;
    }
    const answer = pending.framing.getReducedResult(pending.acc);
    if (!answer) return;
    this._pending = null;
    pending.resolve(Buffer.from(answer));
  }

  // Not closed: a failed write can still be pending in the OS. The handle
  // stays referenced, so no finalizer closes it either, until main kills
  // the host.
  _fail(failure, cause) {
    const pending = this._pending;
    this._pending = null;
    if (pending) clearTimeout(pending.poll);
    this.retired = this._handle;
    this._handle = null;
    if (pending) pending.reject(new HostFailure(failure, cause));
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

/**
 * Serve main's messages from `port` (`{ post(message), onMessage(fn) }`).
 * `terminate` ends the process (a message that breaks the protocol).
 * Returns `{ abandon() }`, for the in-process host of the tests.
 */
function serve(port, { hid, platform = process.platform, terminate }) {
  let session = null;
  // Failed sessions, kept until the process ends: their handles are never
  // closed, nor finalized.
  const retired = [];

  function failed(id, failure) {
    port.post({ op: 'failed', id, failure, dropped: session?.dropped ?? 0 });
  }

  async function exchange({ id, channel, apdu }) {
    if (session && session.channel !== channel) {
      // A new operation without the old one's close: close it first, as
      // main never does (close before open).
      session.close();
      session = null;
    }
    if (!session) {
      try {
        // node-hid that won't load is not_found too.
        const opened = new HidSession({ hid: hid(), platform, channel });
        opened.open();
        session = opened;
      } catch (err) {
        failed(id, err.failure ?? HOST_FAILURES.NOT_FOUND);
        return;
      }
    }
    const current = session;
    try {
      const answer = await current.exchange(Buffer.from(apdu, 'hex'));
      port.post({ op: 'answer', id, answer: answer.toString('hex'), dropped: current.dropped });
    } catch (err) {
      if (!(err instanceof HostFailure)) throw err;
      port.post({ op: 'failed', id, failure: err.failure, dropped: current.dropped });
      retired.push(current);
      if (session === current) session = null;
    }
  }

  port.onMessage((message) => {
    const { op, id, channel, apdu } = message ?? {};
    if (
      op === 'exchange' &&
      Number.isSafeInteger(id) &&
      Number.isInteger(channel) &&
      channel >= 0 &&
      channel <= 0xffff &&
      isHex(apdu, APDU_MIN, APDU_MAX) &&
      !session?.inFlight
    ) {
      exchange(message).catch(() => terminate());
      return;
    }
    if (op === 'close' && !session?.inFlight) {
      session?.close();
      session = null;
      return;
    }
    terminate();
  });

  return {
    abandon() {
      session?.abandon();
      session = null;
    },
  };
}

function processPort() {
  if (process.parentPort) {
    return {
      post: (message) => process.parentPort.postMessage(message),
      onMessage: (fn) => process.parentPort.on('message', (event) => fn(event.data)),
    };
  }
  // A Node child (the device probe, under ELECTRON_RUN_AS_NODE).
  return {
    post: (message) => process.send(message),
    onMessage: (fn) => process.on('message', fn),
  };
}

if (require.main === module) {
  let nodeHid = null;
  serve(processPort(), {
    hid: () => {
      if (!nodeHid) nodeHid = require('node-hid');
      return nodeHid;
    },
    terminate: () => process.kill(process.pid, 'SIGKILL'),
  });
}

module.exports = {
  HidSession,
  HostFailure,
  HOST_FAILURES,
  LEDGER_VENDOR_ID,
  PACKET_SIZE,
  POLL_STEPS,
  serve,
};
