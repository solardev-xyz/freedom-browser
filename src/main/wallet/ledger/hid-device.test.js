/**
 * Main's Ledger HID device (freedom-core design 0016, LDG-3 PR 5) against
 * a fake node-hid (test/helpers/fake-node-hid.js): opened per operation and
 * closed at its end; a cancel closes it mid-read; a deadline gives
 * `unresponsive` (15 s) or `timeout` (5 minutes); an unplug gives
 * `disconnected`; a second open waits for no close (R5: close before open).
 * Every test also checks that nothing broke hidapi's contract: no read or
 * write on a closed handle, no blocking or threadpool read (R1).
 */

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../../logger');
const { HidDevice, HidDeviceError, DEADLINE_MS, LEDGER_VENDOR_ID } = require('./hid-device');
const { createFakeNodeHid, APP_ANSWER } = require('../../../../test/helpers/fake-node-hid');

const B001 = Buffer.from('b001000000', 'hex');
// E0 02 00 00, 44'/60'/0'/0/0: the address check.
const ADDRESS = Buffer.from('e002000015058000002c8000003c800000000000000000000000', 'hex');
const ADDRESS_ANSWER = Buffer.concat([
  Buffer.from([65]),
  Buffer.alloc(65, 4),
  Buffer.from([40]),
  Buffer.from('ab'.repeat(20)),
  Buffer.from('9000', 'hex'),
]);

let fake;

function device(options = {}) {
  return new HidDevice({ hid: fake, platform: 'linux', ...options });
}

function failureOf(promise) {
  return promise.then(
    () => {
      throw new Error('resolved');
    },
    (err) => err
  );
}

// Reports queued on every open handle, framed as the device would.
function frame(channel, sequence, payload) {
  const report = Buffer.alloc(64);
  report.writeUInt16BE(channel, 0);
  report[2] = 0x05;
  report.writeUInt16BE(sequence, 3);
  Buffer.from(payload).copy(report, 5);
  return report;
}

beforeEach(() => {
  jest.useFakeTimers();
  fake = createFakeNodeHid();
  log.warn.mockClear();
});

afterEach(() => {
  expect(fake.violations).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

describe('opened per operation, closed at its end', () => {
  test('opens at the first APDU, keeps one handle for the operation, closes on detach', async () => {
    const op = device();
    expect(op.isOpen).toBe(false);
    expect(fake.handles).toHaveLength(0);

    fake.ledger.respond = (apdu) => ({
      answer: apdu[1] === 0x02 ? ADDRESS_ANSWER : APP_ANSWER,
    });
    const first = op.exchange(ADDRESS, DEADLINE_MS.DEVICE);
    expect(op.isOpen).toBe(true);
    await jest.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toEqual(ADDRESS_ANSWER);
    const second = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(second).resolves.toEqual(Buffer.from(APP_ANSWER, 'hex'));
    expect(fake.handles).toHaveLength(1);

    op.detach();
    expect(op.isOpen).toBe(false);
    expect(fake.events.map((e) => e.type)).toEqual([
      'open',
      'write',
      'answer',
      'write',
      'answer',
      'close',
    ]);
    // Detached again, or exchanged after its end: nothing reopens.
    op.detach();
    await expect(op.exchange(B001, DEADLINE_MS.DEVICE)).rejects.toThrow('has ended');
    expect(fake.handles).toHaveLength(1);
  });

  test('the next operation opens a new handle on a new channel', async () => {
    const seen = [];
    fake.ledger.respond = (_apdu, { channel }) => {
      seen.push(channel);
      return { answer: '9000' };
    };
    for (let i = 0; i < 3; i++) {
      const op = device();
      const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
      await jest.advanceTimersByTimeAsync(5);
      await expect(answer).resolves.toEqual(Buffer.from('9000', 'hex'));
      op.detach();
    }
    expect(fake.handles.map((h) => h.closed)).toEqual([true, true, true]);
    expect(new Set(seen).size).toBe(3);
  });

  test("a new handle's channel is none of the recent ones", async () => {
    // The random source repeats the first channel before giving another.
    const draws = [7, 7, 7, 9];
    const randomInt = jest.fn(() => draws.shift());
    const seen = [];
    fake.ledger.respond = (_apdu, { channel }) => {
      seen.push(channel);
      return { answer: '9000' };
    };
    for (let i = 0; i < 2; i++) {
      const op = device({ randomInt });
      const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
      await jest.advanceTimersByTimeAsync(5);
      await answer;
      op.detach();
    }
    expect(seen).toEqual([7, 9]);
    expect(randomInt).toHaveBeenCalledWith(0x10000);
  });

  test('frames an APDU of 260 bytes and reads an answer of 260, on its own channel', async () => {
    const apdu = Buffer.concat([Buffer.from('e00400' + '00ff', 'hex'), Buffer.alloc(255, 0x11)]);
    const answer = Buffer.concat([Buffer.alloc(258, 0x22), Buffer.from('9000', 'hex')]);
    fake.ledger.respond = () => ({ answer });
    const op = device();
    const exchanged = op.exchange(apdu, DEADLINE_MS.USER);
    await jest.advanceTimersByTimeAsync(5);
    await expect(exchanged).resolves.toEqual(answer);
    expect(fake.ledger.apdus).toEqual([apdu]);
    op.detach();
  });

  test('opens the APDU interface: by interface number on Linux, by usage page on macOS and Windows', async () => {
    for (const platform of ['linux', 'darwin', 'win32']) {
      const op = device({ platform });
      const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
      await jest.advanceTimersByTimeAsync(5);
      await answer;
      op.detach();
    }
    expect(fake.handles).toHaveLength(3);
    expect(LEDGER_VENDOR_ID).toBe(require('@ledgerhq/devices').ledgerUSBVendorId);
  });
});

describe('a cancel closes the handle mid-read', () => {
  test("the core's cancel (the signal) closes it at once, without waiting for the answer", async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const controller = new AbortController();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER, controller.signal));
    await jest.advanceTimersByTimeAsync(2_000);
    const handle = fake.handles[0];
    expect(handle.reads).toBeGreaterThan(0);

    controller.abort();
    // Closed in the abort itself, before anything awaits.
    expect(handle.closed).toBe(true);
    expect(op.isOpen).toBe(false);
    const err = await exchanged;
    expect(err).toBeInstanceOf(HidDeviceError);
    expect(err).toMatchObject({ failure: 'disconnected', detached: true });

    // The user answers the old prompt: no handle reads it, nothing breaks.
    const reads = handle.reads;
    fake.ledger.release('6985');
    await jest.advanceTimersByTimeAsync(100);
    expect(handle.reads).toBe(reads);
  });

  test("main's own cancel (detach) closes it the same way", async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(50);
    op.detach();
    expect(fake.handles[0].closed).toBe(true);
    expect(await exchanged).toMatchObject({ failure: 'disconnected', detached: true });
  });

  test('a signal already aborted opens nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const op = device();
    const err = await failureOf(op.exchange(B001, DEADLINE_MS.DEVICE, controller.signal));
    expect(err).toMatchObject({ failure: 'disconnected', detached: true });
    expect(fake.handles).toHaveLength(0);
  });

  test('an answered exchange lets go of its signal', async () => {
    const controller = new AbortController();
    const op = device();
    const answer = op.exchange(B001, DEADLINE_MS.DEVICE, controller.signal);
    await jest.advanceTimersByTimeAsync(5);
    await answer;
    controller.abort();
    expect(op.isOpen).toBe(true);
    op.detach();
  });
});

describe("a deadline: 15 s is unresponsive, 5 minutes is timeout (0016's two deadline_ms)", () => {
  beforeEach(() => {
    fake.ledger.respond = () => ({ hold: true });
  });

  test('15000: no answer in 15 s is unresponsive (LEDGER_UNRESPONSIVE), and closes the handle', async () => {
    const op = device();
    const exchanged = failureOf(op.exchange(B001, DEADLINE_MS.DEVICE));
    await jest.advanceTimersByTimeAsync(DEADLINE_MS.DEVICE - 1);
    expect(fake.handles[0].closed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(fake.handles[0].closed).toBe(true);
    expect(await exchanged).toMatchObject({ failure: 'unresponsive', detached: false });
  });

  test('300000: no answer in 5 minutes is timeout (LEDGER_TIMEOUT), and closes the handle', async () => {
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(DEADLINE_MS.USER - 1);
    expect(fake.handles[0].closed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(fake.handles[0].closed).toBe(true);
    expect(await exchanged).toMatchObject({ failure: 'timeout', detached: false });
  });

  test('an answer inside the deadline is the answer', async () => {
    const op = device();
    const exchanged = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(DEADLINE_MS.DEVICE - 100);
    fake.ledger.release('6985');
    await jest.advanceTimersByTimeAsync(50);
    await expect(exchanged).resolves.toEqual(Buffer.from('6985', 'hex'));
    op.detach();
  });

  test('the deadline counts from the call and polls back off while the user decides', async () => {
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(100);
    const fast = fake.handles[0].reads;
    expect(fast).toBeGreaterThanOrEqual(90);
    await jest.advanceTimersByTimeAsync(60_000);
    // 1 ms for 100 ms, 5 ms to 1 s, then 20 ms: about 3,200 in the first minute.
    expect(fake.handles[0].reads).toBeLessThan(3_300);
    op.detach();
    await exchanged;
  });
});

describe('an unplug is disconnected', () => {
  test('unplugged while it reads', async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(500);
    fake.unplug();
    await jest.advanceTimersByTimeAsync(20);
    expect(fake.handles[0].closed).toBe(true);
    expect(await exchanged).toMatchObject({ failure: 'disconnected', detached: false });
  });

  test('unplugged before the write: the write fails', async () => {
    const op = device();
    const first = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await first;
    fake.unplug();
    const err = await failureOf(op.exchange(B001, DEADLINE_MS.DEVICE));
    expect(err).toMatchObject({ failure: 'disconnected', detached: false });
    expect(fake.handles[0].closed).toBe(true);
  });

  test('replugged, the next operation opens again', async () => {
    fake.unplug();
    const gone = device();
    expect(await failureOf(gone.exchange(B001, DEADLINE_MS.DEVICE))).toMatchObject({
      failure: 'not_found',
    });
    fake.plug();
    const op = device();
    const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(answer).resolves.toEqual(Buffer.from(APP_ANSWER, 'hex'));
    op.detach();
  });
});

describe('an open that fails', () => {
  test('no Ledger listed is not_found', async () => {
    fake.unplug();
    const err = await failureOf(device().exchange(B001, DEADLINE_MS.DEVICE));
    expect(err).toMatchObject({ failure: 'not_found', detached: false });
  });

  test('listed but held by another app is busy on macOS and Windows, not_found on Linux', async () => {
    fake.ledger.heldElsewhere = true;
    for (const [platform, failure] of [
      ['darwin', 'busy'],
      ['win32', 'busy'],
      ['linux', 'not_found'],
    ]) {
      const err = await failureOf(device({ platform }).exchange(B001, DEADLINE_MS.DEVICE));
      expect(err).toMatchObject({ failure, detached: false });
      expect(err.cause.message).toMatch(/cannot open device/);
    }
  });

  test("node-hid that won't load is not_found", async () => {
    const hid = {
      devices() {
        throw new Error('hid_init failed');
      },
    };
    const err = await failureOf(new HidDevice({ hid }).exchange(B001, DEADLINE_MS.DEVICE));
    expect(err).toMatchObject({ failure: 'not_found' });
  });
});

describe('frames from the device', () => {
  test("another channel's frames are dropped; the answer on its own is read", async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device({ randomInt: () => 0x1234 });
    const exchanged = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(10);
    fake.inject(frame(0x4321, 0, [0x00, 0x02, 0x90, 0x00]));
    fake.inject(Buffer.from([0x12])); // too short to carry a channel
    await jest.advanceTimersByTimeAsync(10);
    fake.ledger.release('9000');
    await jest.advanceTimersByTimeAsync(10);
    await expect(exchanged).resolves.toEqual(Buffer.from('9000', 'hex'));
    expect(op.droppedFrames).toBe(2);
    op.detach();
  });

  test('a frame out of sequence on its own channel is disconnected', async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device({ randomInt: () => 0x1234 });
    const exchanged = failureOf(op.exchange(B001, DEADLINE_MS.DEVICE));
    await jest.advanceTimersByTimeAsync(10);
    fake.inject(frame(0x1234, 1, [0x90, 0x00]));
    await jest.advanceTimersByTimeAsync(10);
    expect(await exchanged).toMatchObject({ failure: 'disconnected' });
    expect(fake.handles[0].closed).toBe(true);
  });

  test('an answer announced outside 2 to 260 bytes is disconnected', async () => {
    for (const length of [1, 261]) {
      fake.ledger.respond = () => ({ hold: true });
      const op = device({ randomInt: () => 0x1234 + length });
      const exchanged = failureOf(op.exchange(B001, DEADLINE_MS.DEVICE));
      await jest.advanceTimersByTimeAsync(10);
      fake.inject(frame(0x1234 + length, 0, [length >> 8, length & 0xff, 0x90, 0x00]));
      await jest.advanceTimersByTimeAsync(10);
      expect(await exchanged).toMatchObject({ failure: 'disconnected' });
    }
  });
});

describe('R5: a second handle while the old one is open (close before open)', () => {
  test('after a cancel the relay closes the old handle, opens a fresh one, and the old answer reaches no parent', async () => {
    // macOS seizes the device: a second open fails while one is open.
    fake = createFakeNodeHid({ exclusive: true });
    fake.ledger.respond = () => ({ hold: true });
    const old = device({ platform: 'darwin' });
    const controller = new AbortController();
    const oldExchange = failureOf(old.exchange(ADDRESS, DEADLINE_MS.USER, controller.signal));
    await jest.advanceTimersByTimeAsync(200);

    controller.abort();
    const next = device({ platform: 'darwin' });
    const nextExchange = next.exchange(B001, DEADLINE_MS.DEVICE);
    expect(fake.events.map((e) => `${e.type}:${e.handle ?? ''}`)).toEqual([
      'open:1',
      'write:1',
      'close:1',
      'open:2',
      'write:2',
    ]);
    expect(await oldExchange).toMatchObject({ detached: true });

    // The old prompt's late answer comes on the old channel, to the new
    // handle: dropped. Then the new APDU's own answer.
    fake.ledger.answerOn(fake.events[1].channel, '6985');
    await jest.advanceTimersByTimeAsync(10);
    fake.ledger.release(APP_ANSWER);
    await jest.advanceTimersByTimeAsync(10);
    await expect(nextExchange).resolves.toEqual(Buffer.from(APP_ANSWER, 'hex'));
    expect(next.droppedFrames).toBe(1);
    next.detach();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('the backstop: an open closes a handle another operation left open first', async () => {
    fake = createFakeNodeHid({ exclusive: true });
    fake.ledger.respond = () => ({ hold: true });
    const old = device({ platform: 'darwin' });
    const oldExchange = failureOf(old.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(200);

    fake.ledger.respond = () => ({ answer: '9000' });
    const next = device({ platform: 'darwin' });
    const nextExchange = next.exchange(B001, DEADLINE_MS.DEVICE);
    expect(fake.events.map((e) => `${e.type}:${e.handle ?? ''}`)).toEqual([
      'open:1',
      'write:1',
      'close:1',
      'open:2',
      'write:2',
    ]);
    expect(await oldExchange).toMatchObject({ failure: 'disconnected', detached: true });
    await jest.advanceTimersByTimeAsync(5);
    await expect(nextExchange).resolves.toEqual(Buffer.from('9000', 'hex'));
    expect(log.warn).toHaveBeenCalledTimes(1);
    next.detach();
  });
});

describe('calls the relay must never make', () => {
  test.each([
    ['an APDU of 4 bytes', Buffer.alloc(4), DEADLINE_MS.DEVICE, TypeError],
    ['an APDU of 261 bytes', Buffer.alloc(261), DEADLINE_MS.DEVICE, TypeError],
    ['hex instead of bytes', 'b001000000', DEADLINE_MS.DEVICE, TypeError],
    ['another deadline', B001, 10_000, TypeError],
  ])('%s is refused before anything opens', async (_name, apdu, ms, type) => {
    await expect(device().exchange(apdu, ms)).rejects.toBeInstanceOf(type);
    expect(fake.handles).toHaveLength(0);
  });

  test('a second exchange in flight is refused, and the first goes on', async () => {
    const op = device();
    const first = op.exchange(B001, DEADLINE_MS.DEVICE);
    await expect(op.exchange(B001, DEADLINE_MS.DEVICE)).rejects.toThrow('One exchange at a time');
    await jest.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toEqual(Buffer.from(APP_ANSWER, 'hex'));
    expect(fake.ledger.apdus).toHaveLength(1);
    op.detach();
  });
});
