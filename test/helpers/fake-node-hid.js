/**
 * A fake node-hid with a scripted Ledger behind it, for main's HID device
 * (src/main/wallet/ledger/hid-device.js; freedom-core design 0016, LDG-3
 * PR 5). It has node-hid 2.1.2's surface as main uses it: `devices(vendor,
 * product)`, `new HID(path)`, and a handle's `write(array)`,
 * `readTimeout(ms)` (an array of numbers, empty when nothing came) and
 * `close()`.
 *
 * It keeps hidapi's contract and records each breach in `violations`
 * instead of crashing as node-hid would: a read or write on a closed handle
 * (freed memory, or a NULL `hid_device`, in node-hid), a blocking read on
 * the main thread (`readTimeout` with a timeout above 0), and any use of
 * node-hid's threadpool `read(cb)`, which close can't safely interrupt (the
 * LDG-3 plan's R1).
 *
 * The Ledger reassembles each APDU from its frames with noevents' HID
 * framing and asks `ledger.respond(apdu, { channel })`, which returns
 * `{ answer, afterMs }` (an answer, in hex or bytes, framed on the APDU's
 * channel after `afterMs`, 2 by default) or `{ hold: true }`: the device
 * waits for the user, and `ledger.release(answer)` sends the answer later,
 * on the held APDU's channel (`ledger.answerOn(channel, answer)` on any
 * other, as a closed handle's late answer comes). As a real device does, it sends every report
 * to every open handle (Linux's hidraw, Windows); `exclusive` makes a second
 * open fail while one is open, as macOS's seized device does. `unplug()`
 * makes each open handle's read and write fail and lists no device.
 *
 * `events` is the order of opens, writes (one per APDU), answers and closes.
 */

const createHIDframing = require('@ledgerhq/hw-transport-node-hid-noevents/hid-framing').default;

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
    respond: defaultRespond,
    held: null,
    apdus: [],
    release(answer) {
      const held = ledger.held;
      if (!held) throw new Error('No APDU is held');
      ledger.held = null;
      deliver(held.channel, bytes(answer));
    },
    // An answer on a channel of the test's choosing: an older APDU's, late.
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

  /** Queue one raw report (64 bytes, no report ID) on every open handle. */
  function inject(report) {
    for (const handle of open()) handle.queue.push(Buffer.from(report));
  }

  class FakeHID {
    constructor(path) {
      if (!ledger.plugged || path !== APDU_PATH || ledger.heldElsewhere) {
        throw new TypeError(`cannot open device with path ${path}`);
      }
      if (exclusive && open().length > 0) {
        throw new TypeError(`cannot open device with path ${path}`);
      }
      this.id = nextId++;
      this.closed = false;
      this.queue = [];
      this.reads = 0;
      this.frames = [];
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
      if (!ledger.plugged) throw new TypeError('Cannot write to hid device');
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
      if (!ledger.plugged) throw new TypeError('could not read data from device');
      const report = this.queue.shift();
      return report ? Array.from(report) : [];
    }

    read() {
      violations.push({ op: 'read', handle: this.id, reason: 'threadpool' });
      throw new Error("node-hid's threadpool read: close can't interrupt it safely (R1)");
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.queue.length = 0;
      events.push({ type: 'close', handle: this.id });
    }
  }

  return {
    HID: FakeHID,
    devices(vendorId, productId) {
      if (!ledger.plugged || vendorId !== VENDOR_ID || productId !== 0) return [];
      // The FIDO interface first, so a filter that takes the first entry fails.
      return [
        { vendorId, productId: PRODUCT_ID, path: FIDO_PATH, interface: 1, usagePage: 0xf1d0 },
        { vendorId, productId: PRODUCT_ID, path: APDU_PATH, interface: 0, usagePage: 0xffa0 },
      ];
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

module.exports = { createFakeNodeHid, APP_ANSWER, APDU_PATH };
