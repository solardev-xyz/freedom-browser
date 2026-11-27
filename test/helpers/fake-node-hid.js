/**
 * A fake node-hid with a scripted Ledger behind it, and an in-process HID
 * host on it, for main's HID device (src/main/wallet/ledger/hid-device.js,
 * hid-host.js; freedom-core design 0016, LDG-3 PR 5).
 *
 * The fake has node-hid 2.1.2's surface as the host uses it: `devices(vendor,
 * product)`, `new HID(path)`, and a handle's `write(array)`,
 * `readTimeout(ms)` (an array of numbers, empty when nothing came) and
 * `close()`. It keeps hidapi's contract and records each breach in
 * `violations` instead of crashing as node-hid would: a read or write on a
 * closed handle, a blocking read (`readTimeout` above 0), any use of
 * node-hid's threadpool `read(cb)`, and a `close()` while the handle's I/O
 * may be pending (the last `readTimeout` returned nothing, or a `write`
 * failed: on Windows an overlapped read or write is pending then, the
 * LDG-3 plan's R1).
 *
 * The Ledger reassembles each APDU from its frames with noevents' HID
 * framing and asks `ledger.respond(apdu, { channel })`, which returns
 * `{ answer, afterMs }` (an answer, in hex or bytes, framed on the APDU's
 * channel after `afterMs`, 2 by default) or `{ hold: true }`: the device
 * waits for the user, and `ledger.release(answer)` sends the answer later,
 * on the held APDU's channel; `ledger.answerOn(channel, answer)` sends one
 * on any channel, as a late answer comes. As a real device does, it sends
 * every report to every open handle (Linux's hidraw, Windows); `exclusive`
 * makes a second open fail while one is open, as macOS's seized device
 * does. `unplug()` makes each open handle's read and write fail and lists no
 * device; `ledger.vanishOnOpen` unplugs it inside the next open, which
 * fails.
 *
 * `events` is the order of opens, writes (one per APDU), answers, closes
 * and `exit-close`s: the OS closing a handle as its process ends.
 *
 * `inProcessHosts(fake)` forks hosts (hid-host.js's `serve`) in this
 * process, for HidHost's `launch`: messages go through JSON both ways, a
 * tick later, as over a process's channel; `kill()` and `crash()` end one at
 * once, its handles closed by the OS and its late messages lost.
 */

const createHIDframing = require('@ledgerhq/hw-transport-node-hid-noevents/hid-framing').default;
const { serve } = require('../../src/main/wallet/ledger/hid-host');

const VENDOR_ID = 0x2c97;
const PRODUCT_ID = 0x5011; // a Nano S Plus
const APDU_PATH = 'fake-ledger-apdu';
const FIDO_PATH = 'fake-ledger-fido';

function bytes(value) {
  return typeof value === 'string' ? Buffer.from(value, 'hex') : Buffer.from(value);
}

// The answer to B0 01 from the Ethereum app: format 1, "Ethereum", "1.13.0".
const APP_ANSWER = '0108457468657265756d06312e31332e30' + '9000';

function defaultRespond(apdu) {
  if (apdu[0] === 0xb0 && apdu[1] === 0x01) return { answer: APP_ANSWER };
  return { answer: '9000' };
}

function createFakeNodeHid({ exclusive = false } = {}) {
  const events = [];
  const violations = [];
  const handles = [];
  let nextId = 1;

  const ledger = {
    plugged: true,
    // Another app holds the device: an open fails, as hidapi's does then.
    heldElsewhere: false,
    vanishOnOpen: false,
    respond: defaultRespond,
    held: null,
    apdus: [],
    release(answer) {
      const held = ledger.held;
      if (!held) throw new Error('No APDU is held');
      ledger.held = null;
      deliver(held.channel, bytes(answer));
    },
    answerOn(channel, answer) {
      deliver(channel, bytes(answer));
    },
  };

  function open() {
    return handles.filter((h) => !h.closed);
  }

  // Frame an answer on its channel and queue it on every open handle.
  function deliver(channel, answer) {
    if (!ledger.plugged) return;
    events.push({ type: 'answer', channel });
    for (const block of createHIDframing(channel, 64).makeBlocks(answer)) {
      inject(Buffer.from(block));
    }
  }

  /** Queue one raw report (no report ID) on every open handle. */
  function inject(report) {
    for (const handle of open()) handle.queue.push(Buffer.from(report));
  }

  function devices(vendorId, productId) {
    if (!ledger.plugged || vendorId !== VENDOR_ID || productId !== 0) return [];
    // The FIDO interface first, so a filter that takes the first entry fails.
    return [
      { vendorId, productId: PRODUCT_ID, path: FIDO_PATH, interface: 1, usagePage: 0xf1d0 },
      { vendorId, productId: PRODUCT_ID, path: APDU_PATH, interface: 0, usagePage: 0xffa0 },
    ];
  }

  class FakeHID {
    constructor(path, process = 0) {
      if (ledger.vanishOnOpen) {
        ledger.vanishOnOpen = false;
        ledger.plugged = false;
      }
      if (!ledger.plugged || path !== APDU_PATH || ledger.heldElsewhere) {
        throw new TypeError(`cannot open device with path ${path}`);
      }
      if (exclusive && open().length > 0) {
        throw new TypeError(`cannot open device with path ${path}`);
      }
      this.id = nextId++;
      this.process = process;
      this.closed = false;
      this.queue = [];
      this.reads = 0;
      // The last read returned nothing, or a write failed: I/O may be
      // pending (Windows).
      this.ioPending = false;
      this.acc = null;
      this.framing = null;
      handles.push(this);
      events.push({ type: 'open', handle: this.id });
    }

    write(data) {
      if (this.closed) {
        violations.push({ op: 'write', handle: this.id, reason: 'closed' });
        throw new TypeError('Cannot write to closed device');
      }
      if (!ledger.plugged) {
        this.ioPending = true;
        throw new TypeError('Cannot write to hid device');
      }
      const report = Buffer.from(data);
      if (report.length !== 65 || report[0] !== 0) {
        violations.push({ op: 'write', handle: this.id, reason: 'report' });
      }
      const frame = report.subarray(1);
      const channel = frame.readUInt16BE(0);
      if (!this.framing) this.framing = createHIDframing(channel, 64);
      this.acc = this.framing.reduceResponse(this.acc, frame);
      const apdu = this.framing.getReducedResult(this.acc);
      if (!apdu) return report.length;
      this.acc = null;
      this.framing = null;
      events.push({ type: 'write', handle: this.id, channel });
      ledger.apdus.push(Buffer.from(apdu));
      const reply = ledger.respond(Buffer.from(apdu), { channel, handle: this.id });
      if (reply.hold) {
        ledger.held = { channel, handle: this.id };
      } else {
        setTimeout(() => deliver(channel, bytes(reply.answer)), reply.afterMs ?? 2);
      }
      return report.length;
    }

    readTimeout(ms) {
      this.reads++;
      if (this.closed) {
        violations.push({ op: 'readTimeout', handle: this.id, reason: 'closed' });
        throw new Error('readTimeout on a closed handle');
      }
      if (ms !== 0) violations.push({ op: 'readTimeout', handle: this.id, reason: 'blocking' });
      if (!ledger.plugged) {
        this.ioPending = false;
        throw new TypeError('could not read data from device');
      }
      const report = this.queue.shift();
      this.ioPending = !report;
      return report ? Array.from(report) : [];
    }

    read() {
      violations.push({ op: 'read', handle: this.id, reason: 'threadpool' });
      throw new Error("node-hid's threadpool read: close can't interrupt it safely (R1)");
    }

    close() {
      if (this.closed) return;
      if (this.ioPending) {
        violations.push({ op: 'close', handle: this.id, reason: 'I/O pending' });
      }
      this.closed = true;
      this.queue.length = 0;
      events.push({ type: 'close', handle: this.id });
    }
  }

  return {
    HID: FakeHID,
    devices,
    /** node-hid as one process sees it: its handles end with it. */
    forProcess(process) {
      return {
        devices,
        HID: class extends FakeHID {
          constructor(path) {
            super(path, process);
          }
        },
      };
    },
    /** The OS closes a process's handles as it ends: no read can race it. */
    exitProcess(process) {
      for (const handle of open()) {
        if (handle.process !== process) continue;
        handle.closed = true;
        handle.queue.length = 0;
        events.push({ type: 'exit-close', handle: handle.id });
      }
    },
    ledger,
    events,
    violations,
    handles,
    inject,
    unplug() {
      ledger.plugged = false;
      ledger.held = null;
    },
    plug() {
      ledger.plugged = true;
    },
  };
}

const clone = (message) => JSON.parse(JSON.stringify(message));

/**
 * A HidHost `launch` that serves each host in this process, on `fake`.
 * `launch.hosts` lists them: `{ pid, killed, crashed, terminated, toHost,
 * toMain }`, the last two every message each way.
 */
function inProcessHosts(fake, { platform = 'linux' } = {}) {
  let nextPid = 1;
  const hosts = [];
  function launch() {
    const pid = nextPid++;
    let toMainFn = null;
    let exitFn = null;
    let fromMainFn = null;
    const host = {
      pid,
      alive: true,
      killed: false,
      crashed: false,
      terminated: false,
      toHost: [],
      toMain: [],
    };
    function end() {
      if (!host.alive) return;
      host.alive = false;
      served.abandon();
      fake.exitProcess(pid);
      setTimeout(() => exitFn?.(0), 0);
    }
    const served = serve(
      {
        post(message) {
          host.toMain.push(clone(message));
          setTimeout(() => host.alive && toMainFn?.(clone(message)), 0);
        },
        onMessage(fn) {
          fromMainFn = fn;
        },
      },
      {
        hid: () => fake.forProcess(pid),
        platform,
        terminate: () => {
          host.terminated = true;
          end();
        },
      }
    );
    host.crash = () => {
      host.crashed = true;
      end();
    };
    hosts.push(host);
    return {
      post(message) {
        host.toHost.push(clone(message));
        setTimeout(() => host.alive && fromMainFn(clone(message)), 0);
      },
      kill() {
        host.killed = true;
        end();
      },
      onMessage(fn) {
        toMainFn = fn;
      },
      onExit(fn) {
        exitFn = fn;
      },
    };
  }
  launch.hosts = hosts;
  return launch;
}

module.exports = { createFakeNodeHid, inProcessHosts, APP_ANSWER, APDU_PATH };
