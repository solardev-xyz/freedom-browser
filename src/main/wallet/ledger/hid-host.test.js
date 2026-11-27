/**
 * The Ledger HID host's parts (freedom-core design 0016, LDG-3 PR 5)
 * against a fake node-hid (test/helpers/fake-node-hid.js): HidSession's
 * framing, its checks on each report and its open failures, and `serve`'s
 * messages. Every test also checks that nothing broke hidapi's contract: no
 * read or write on a closed handle, no blocking or threadpool read, and no
 * close while a read may be in flight (the LDG-3 plan's R1).
 */

const { HidSession, HostFailure, PACKET_SIZE, serve } = require('./hid-host');
const { createFakeNodeHid, APP_ANSWER } = require('../../../../test/helpers/fake-node-hid');

const B001 = Buffer.from('b001000000', 'hex');
const CHANNEL = 0x1234;

let fake;

function session(options = {}) {
  return new HidSession({ hid: fake, platform: 'linux', channel: CHANNEL, ...options });
}

function failureOf(promise) {
  return promise.then(
    () => {
      throw new Error('resolved');
    },
    (err) => err
  );
}

// One report on `channel`: tag, sequence, then the payload, padded to `size`.
function frame(channel, sequence, payload, { size = PACKET_SIZE, tag = 0x05 } = {}) {
  const report = Buffer.alloc(size);
  report.writeUInt16BE(channel, 0);
  report[2] = tag;
  report.writeUInt16BE(sequence, 3);
  Buffer.from(payload).copy(report, 5);
  return report;
}

beforeEach(() => {
  jest.useFakeTimers();
  fake = createFakeNodeHid();
});

afterEach(() => {
  expect(fake.violations).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

describe('HidSession: one handle, on its channel', () => {
  test('frames an APDU of 260 bytes and reads an answer of 260, then closes', async () => {
    const apdu = Buffer.concat([Buffer.from('e0040000ff', 'hex'), Buffer.alloc(255, 0x11)]);
    const answer = Buffer.concat([Buffer.alloc(258, 0x22), Buffer.from('9000', 'hex')]);
    fake.ledger.respond = (_apdu, { channel }) => {
      expect(channel).toBe(CHANNEL);
      return { answer };
    };
    const s = session();
    s.open();
    const exchanged = s.exchange(apdu);
    await jest.advanceTimersByTimeAsync(5);
    await expect(exchanged).resolves.toEqual(answer);
    expect(fake.ledger.apdus).toEqual([apdu]);
    s.close();
    expect(fake.events.map((e) => e.type)).toEqual(['open', 'write', 'answer', 'close']);
  });

  test('opens the APDU interface: by interface number on Linux, by usage page on macOS and Windows', () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const s = session({ platform });
      s.open();
      s.close();
    }
    expect(fake.handles).toHaveLength(3);
    expect(require('./hid-host').LEDGER_VENDOR_ID).toBe(
      require('@ledgerhq/devices').ledgerUSBVendorId
    );
  });

  test('polls every millisecond at first, then backs off while the user decides', async () => {
    fake.ledger.respond = () => ({ hold: true });
    const s = session();
    s.open();
    const exchanged = s.exchange(B001);
    await jest.advanceTimersByTimeAsync(100);
    expect(fake.handles[0].reads).toBeGreaterThanOrEqual(90);
    await jest.advanceTimersByTimeAsync(60_000);
    // 1 ms for 100 ms, 5 ms to 1 s, then 20 ms: about 3,200 in the first minute.
    expect(fake.handles[0].reads).toBeLessThan(3_300);
    fake.ledger.release('9000');
    await jest.advanceTimersByTimeAsync(25);
    await expect(exchanged).resolves.toEqual(Buffer.from('9000', 'hex'));
    s.close();
  });

  test('refuses to close with an exchange in flight (the host is killed instead)', async () => {
    fake.ledger.respond = () => ({ hold: true });
    const s = session();
    s.open();
    const exchanged = s.exchange(B001);
    await jest.advanceTimersByTimeAsync(5);
    expect(() => s.close()).toThrow('killed instead');
    fake.ledger.release('9000');
    await jest.advanceTimersByTimeAsync(5);
    await exchanged;
    s.close();
  });
});

describe('HidSession: reports', () => {
  async function held() {
    fake.ledger.respond = () => ({ hold: true });
    const s = session();
    s.open();
    const exchanged = failureOf(s.exchange(B001));
    await jest.advanceTimersByTimeAsync(5);
    return { s, exchanged };
  }

  test("another channel's reports are dropped, whatever their size", async () => {
    fake.ledger.respond = () => ({ hold: true });
    const s = session();
    s.open();
    const exchanged = s.exchange(B001);
    await jest.advanceTimersByTimeAsync(5);
    fake.inject(frame(0x4321, 0, [0x00, 0x02, 0x90, 0x00]));
    fake.inject(frame(0x4321, 0, [0x00, 0x02, 0x90, 0x00], { size: 267 }));
    fake.inject(Buffer.from([0x12]));
    fake.inject(frame(CHANNEL, 0, [0x00, 0x02, 0x90, 0x00], { tag: 0x02 }));
    await jest.advanceTimersByTimeAsync(5);
    fake.ledger.release('9000');
    await jest.advanceTimersByTimeAsync(5);
    await expect(exchanged).resolves.toEqual(Buffer.from('9000', 'hex'));
    expect(s.dropped).toBe(4);
    s.close();
  });

  test.each([
    ['63 bytes', 63],
    ['65 bytes', 65],
    ['267 bytes declaring 2', 267],
  ])('a report of %s on its own channel is disconnected, not an answer', async (_name, size) => {
    const { s, exchanged } = await held();
    fake.inject(frame(CHANNEL, 0, [0x00, 0x02, 0x90, 0x00, 0xde, 0xad], { size }));
    await jest.advanceTimersByTimeAsync(5);
    const err = await exchanged;
    expect(err).toBeInstanceOf(HostFailure);
    expect(err.failure).toBe('disconnected');
    // Left unclosed for main to kill the host.
    expect(s.isOpen).toBe(false);
    expect(fake.handles[0].closed).toBe(false);
  });

  test('a report out of sequence on its own channel is disconnected', async () => {
    const { exchanged } = await held();
    fake.inject(frame(CHANNEL, 1, [0x90, 0x00]));
    await jest.advanceTimersByTimeAsync(5);
    expect((await exchanged).failure).toBe('disconnected');
  });

  test.each([1, 261])('an answer announced as %i bytes is disconnected', async (length) => {
    const { exchanged } = await held();
    fake.inject(frame(CHANNEL, 0, [length >> 8, length & 0xff, 0x90, 0x00]));
    await jest.advanceTimersByTimeAsync(5);
    expect((await exchanged).failure).toBe('disconnected');
  });

  test('unplugged mid-read is disconnected, the handle left unclosed for main to kill the host', async () => {
    const { s, exchanged } = await held();
    fake.unplug();
    await jest.advanceTimersByTimeAsync(25);
    expect((await exchanged).failure).toBe('disconnected');
    expect(s.isOpen).toBe(false);
    expect(fake.handles[0].closed).toBe(false);
    expect(fake.events.map((e) => e.type)).not.toContain('close');
  });

  test('unplugged before the write: the write fails, disconnected, the handle left unclosed', async () => {
    const s = session();
    s.open();
    fake.unplug();
    expect((await failureOf(s.exchange(B001))).failure).toBe('disconnected');
    // A failed Windows write can still be pending: closing would break R1.
    expect(fake.handles[0].closed).toBe(false);
    expect(fake.handles[0].ioPending).toBe(true);
  });
});

describe('HidSession: an open that fails', () => {
  test('no Ledger listed is not_found', () => {
    fake.unplug();
    expect(() => session().open()).toThrow(expect.objectContaining({ failure: 'not_found' }));
  });

  test('listed and held by another app: busy on macOS and Windows, not_found on Linux', () => {
    fake.ledger.heldElsewhere = true;
    for (const [platform, failure] of [
      ['darwin', 'busy'],
      ['win32', 'busy'],
      ['linux', 'not_found'],
    ]) {
      let err;
      try {
        session({ platform }).open();
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ failure });
      expect(err.cause.message).toMatch(/cannot open device/);
    }
  });

  test.each(['darwin', 'win32'])(
    'unplugged between the listing and the open is not_found on %s, not busy',
    (platform) => {
      fake.ledger.vanishOnOpen = true;
      expect(() => session({ platform }).open()).toThrow(
        expect.objectContaining({ failure: 'not_found' })
      );
    }
  );

  test('a listing that throws is not_found', () => {
    const hid = {
      devices() {
        throw new Error('hid_init failed');
      },
    };
    expect(() => session({ hid }).open()).toThrow(
      expect.objectContaining({ failure: 'not_found' })
    );
  });
});

describe("serve: the host's messages", () => {
  function host({ hid = () => fake } = {}) {
    const sent = [];
    let onMessage = null;
    const terminate = jest.fn();
    serve(
      { post: (message) => sent.push(message), onMessage: (fn) => (onMessage = fn) },
      { hid, platform: 'linux', terminate }
    );
    return { sent, send: (message) => onMessage(message), terminate };
  }

  test('opens at the first exchange, answers each, and closes on close', async () => {
    const h = host();
    h.send({ op: 'exchange', id: 1, channel: CHANNEL, apdu: 'b001000000' });
    await jest.advanceTimersByTimeAsync(5);
    h.send({ op: 'exchange', id: 2, channel: CHANNEL, apdu: 'e006000000' });
    await jest.advanceTimersByTimeAsync(5);
    expect(h.sent).toEqual([
      { op: 'answer', id: 1, answer: APP_ANSWER, dropped: 0 },
      { op: 'answer', id: 2, answer: '9000', dropped: 0 },
    ]);
    expect(fake.handles).toHaveLength(1);
    h.send({ op: 'close' });
    expect(fake.handles[0].closed).toBe(true);
    expect(h.terminate).not.toHaveBeenCalled();
  });

  test('a failure is answered failed, and the next exchange opens again', async () => {
    const h = host();
    fake.unplug();
    h.send({ op: 'exchange', id: 1, channel: CHANNEL, apdu: 'b001000000' });
    fake.plug();
    h.send({ op: 'exchange', id: 2, channel: CHANNEL, apdu: 'b001000000' });
    await jest.advanceTimersByTimeAsync(5);
    expect(h.sent).toEqual([
      { op: 'failed', id: 1, failure: 'not_found', dropped: 0 },
      { op: 'answer', id: 2, answer: APP_ANSWER, dropped: 0 },
    ]);
    h.send({ op: 'close' });
  });

  test("node-hid that won't load is not_found", () => {
    const h = host({
      hid: () => {
        throw new Error('not built for this runtime');
      },
    });
    h.send({ op: 'exchange', id: 1, channel: CHANNEL, apdu: 'b001000000' });
    expect(h.sent).toEqual([{ op: 'failed', id: 1, failure: 'not_found', dropped: 0 }]);
  });

  test('a new channel without a close closes the old handle first', async () => {
    const h = host();
    h.send({ op: 'exchange', id: 1, channel: CHANNEL, apdu: 'b001000000' });
    await jest.advanceTimersByTimeAsync(5);
    h.send({ op: 'exchange', id: 2, channel: CHANNEL + 1, apdu: 'b001000000' });
    await jest.advanceTimersByTimeAsync(5);
    expect(fake.events.map((e) => `${e.type}:${e.handle ?? ''}`)).toEqual([
      'open:1',
      'write:1',
      'answer:',
      'close:1',
      'open:2',
      'write:2',
      'answer:',
    ]);
    h.send({ op: 'close' });
  });

  test.each([
    [
      'an exchange while one is in flight',
      { op: 'exchange', id: 2, channel: CHANNEL, apdu: 'b001000000' },
    ],
    ['a close while an exchange is in flight', { op: 'close' }],
    ['an APDU of 4 bytes', { op: 'exchange', id: 2, channel: CHANNEL, apdu: 'b0010000' }],
    ['upper-case hex', { op: 'exchange', id: 2, channel: CHANNEL, apdu: 'B001000000' }],
    ['a channel out of range', { op: 'exchange', id: 2, channel: 0x10000, apdu: 'b001000000' }],
    ['an unknown message', { op: 'reset' }],
  ])('%s ends the host', async (_name, message) => {
    fake.ledger.respond = () => ({ hold: true });
    const h = host();
    h.send({ op: 'exchange', id: 1, channel: CHANNEL, apdu: 'b001000000' });
    await jest.advanceTimersByTimeAsync(5);
    h.send(message);
    expect(h.terminate).toHaveBeenCalled();
    // The test's own teardown: the device answers, the session closes.
    fake.ledger.release('9000');
    await jest.advanceTimersByTimeAsync(5);
    h.send({ op: 'close' });
  });
});
