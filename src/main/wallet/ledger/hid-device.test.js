/**
 * Main's Ledger HID device (freedom-core design 0016, LDG-3 PR 5), with its
 * hosts served in this process on a fake node-hid
 * (test/helpers/fake-node-hid.js): opened per operation and closed at its
 * end; a cancel lets go mid-read by killing the host; a deadline gives
 * `unresponsive` (15 s) or `timeout` (5 minutes); an unplug gives
 * `disconnected`, and so does the host's exit; the next operation's host is
 * forked only once the old one has exited (R5: close before open); a
 * channel let go of mid-flight is never drawn again. Every test also checks
 * that nothing broke hidapi's contract, a close while a read may be in
 * flight included (R1).
 */

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../../logger');
const { HidDevice, HidDeviceError, HidHost, DEADLINE_MS } = require('./hid-device');
const {
  createFakeNodeHid,
  inProcessHosts,
  APP_ANSWER,
} = require('../../../../test/helpers/fake-node-hid');

const B001 = Buffer.from('b001000000', 'hex');
// E0 02 00 00, 44'/60'/0'/0/0: the address check.
const ADDRESS = Buffer.from('e002000015058000002c8000003c800000000000000000000000', 'hex');
const APP = Buffer.from(APP_ANSWER, 'hex');
const OK = Buffer.from('9000', 'hex');

let fake;
let launch;
let host;

function device(options = {}) {
  return new HidDevice({ host, ...options });
}

function failureOf(promise) {
  return promise.then(
    () => {
      throw new Error('resolved');
    },
    (err) => err
  );
}

const types = () => fake.events.map((e) => `${e.type}:${e.handle ?? ''}`);

function setUp({ exclusive = false, idleMs = null } = {}) {
  fake = createFakeNodeHid({ exclusive });
  launch = inProcessHosts(fake);
  host = new HidHost({ launch, idleMs });
}

beforeEach(() => {
  jest.useFakeTimers();
  setUp();
  log.warn.mockClear();
});

afterEach(async () => {
  // The hosts this test left running end, as main's quit ends them.
  host.kill();
  await jest.advanceTimersByTimeAsync(1);
  expect(fake.violations).toEqual([]);
  expect(jest.getTimerCount()).toBe(0);
  jest.useRealTimers();
});

describe('opened per operation, closed at its end', () => {
  test('forks the host and opens at the first APDU; one handle for the operation; closed at its end', async () => {
    fake.ledger.respond = (apdu) => ({ answer: apdu[1] === 0x02 ? '9000' : APP_ANSWER });
    const op = device();
    expect(op.isOpen).toBe(false);
    expect(launch.hosts).toHaveLength(0);

    const first = op.exchange(ADDRESS, DEADLINE_MS.DEVICE);
    expect(op.isOpen).toBe(true);
    await jest.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toEqual(OK);
    const second = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(second).resolves.toEqual(APP);

    op.detach();
    expect(op.isOpen).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(types()).toEqual(['open:1', 'write:1', 'answer:', 'write:1', 'answer:', 'close:1']);
    expect(launch.hosts).toHaveLength(1);
    expect(launch.hosts[0].killed).toBe(false);
    // Detached again, or exchanged after its end: nothing reopens.
    op.detach();
    await expect(op.exchange(B001, DEADLINE_MS.DEVICE)).rejects.toThrow('has ended');
  });

  test('the next operation opens a new handle on a new channel, in the same host', async () => {
    const channels = [];
    fake.ledger.respond = (_apdu, { channel }) => {
      channels.push(channel);
      return { answer: '9000' };
    };
    for (let i = 0; i < 3; i++) {
      const op = device();
      const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
      await jest.advanceTimersByTimeAsync(5);
      await expect(answer).resolves.toEqual(OK);
      op.detach();
    }
    await jest.advanceTimersByTimeAsync(1);
    expect(fake.handles.map((h) => h.closed)).toEqual([true, true, true]);
    expect(new Set(channels).size).toBe(3);
    expect(launch.hosts).toHaveLength(1);
  });

  test('an idle host exits a minute after the last operation, and the next forks a new one', async () => {
    setUp({ idleMs: 60_000 });
    const op = device();
    const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await answer;
    op.detach();
    await jest.advanceTimersByTimeAsync(59_000);
    expect(launch.hosts[0].alive).toBe(true);
    await jest.advanceTimersByTimeAsync(1_001);
    expect(launch.hosts[0].alive).toBe(false);

    const next = device();
    const again = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(again).resolves.toEqual(APP);
    expect(launch.hosts).toHaveLength(2);
    next.detach();
    await jest.advanceTimersByTimeAsync(60_001);
  });
});

describe('a cancel lets go mid-read: the host is killed, never asked to close', () => {
  test("the core's cancel (the signal) rejects at once and kills the host", async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const controller = new AbortController();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER, controller.signal));
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fake.handles[0].reads).toBeGreaterThan(0);

    controller.abort();
    // Killed in the abort itself, before anything awaits.
    expect(launch.hosts[0].killed).toBe(true);
    expect(op.isOpen).toBe(false);
    const err = await exchanged;
    expect(err).toBeInstanceOf(HidDeviceError);
    expect(err).toMatchObject({ failure: 'disconnected', detached: true });
    // The OS closed the handle as the host ended: no user-mode close.
    expect(types()).toEqual(['open:1', 'write:1', 'exit-close:1']);

    // The user answers the old prompt: nothing reads it.
    fake.ledger.release('6985');
    await jest.advanceTimersByTimeAsync(100);
    expect(launch.hosts[0].toMain).toEqual([]);
  });

  test("main's own cancel (detach) does the same", async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(50);
    op.detach();
    expect(launch.hosts[0].killed).toBe(true);
    expect(await exchanged).toMatchObject({ failure: 'disconnected', detached: true });
  });

  test('a signal already aborted sends nothing and kills nothing', async () => {
    const warm = device();
    const answer = warm.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await answer;
    warm.detach();

    const controller = new AbortController();
    controller.abort();
    const op = device();
    const err = await failureOf(op.exchange(B001, DEADLINE_MS.DEVICE, controller.signal));
    expect(err).toMatchObject({ failure: 'disconnected', detached: true });
    await jest.advanceTimersByTimeAsync(5);
    expect(launch.hosts[0].toHost.filter((m) => m.op === 'exchange')).toHaveLength(1);
    expect(launch.hosts[0].killed).toBe(false);
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

  test('15000: no answer in 15 s is unresponsive (LEDGER_UNRESPONSIVE); the host is killed', async () => {
    const op = device();
    const exchanged = failureOf(op.exchange(B001, DEADLINE_MS.DEVICE));
    await jest.advanceTimersByTimeAsync(DEADLINE_MS.DEVICE - 1);
    expect(launch.hosts[0].killed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(launch.hosts[0].killed).toBe(true);
    expect(await exchanged).toMatchObject({ failure: 'unresponsive', detached: false });
  });

  test('300000: no answer in 5 minutes is timeout (LEDGER_TIMEOUT); the host is killed', async () => {
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(DEADLINE_MS.USER - 1);
    expect(launch.hosts[0].killed).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    expect(launch.hosts[0].killed).toBe(true);
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
});

describe('disconnected: an unplug, or the host gone', () => {
  test('unplugged mid-read: the host fails it, and main kills the host (its handle left unclosed)', async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(500);
    fake.unplug();
    await jest.advanceTimersByTimeAsync(25);
    expect(await exchanged).toMatchObject({ failure: 'disconnected', detached: false });
    expect(launch.hosts[0].killed).toBe(true);
    expect(types()).toEqual(['open:1', 'write:1', 'exit-close:1']);
    expect(op.isOpen).toBe(false);

    // Plugged back in, the next operation forks a fresh host.
    fake.plug();
    fake.ledger.respond = () => ({ answer: '9000' });
    const next = device();
    const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(answer).resolves.toEqual(OK);
    expect(launch.hosts).toHaveLength(2);
    next.detach();
  });

  test('the host crashing mid-exchange is disconnected; the next operation forks a fresh host', async () => {
    fake.ledger.respond = () => ({ hold: true });
    const op = device();
    const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(500);
    launch.hosts[0].crash();
    await jest.advanceTimersByTimeAsync(1);
    expect(await exchanged).toMatchObject({ failure: 'disconnected', detached: false });

    fake.ledger.respond = () => ({ answer: '9000' });
    const next = device();
    const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(answer).resolves.toEqual(OK);
    expect(launch.hosts).toHaveLength(2);
    next.detach();
  });

  test('the host gone between two exchanges: the next one is disconnected, nothing sent', async () => {
    const op = device();
    const first = op.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await first;
    launch.hosts[0].crash();
    await jest.advanceTimersByTimeAsync(1);
    expect(op.isOpen).toBe(false);
    expect(await failureOf(op.exchange(B001, DEADLINE_MS.DEVICE))).toMatchObject({
      failure: 'disconnected',
    });
    expect(launch.hosts).toHaveLength(1);
  });

  test('a host that breaks the protocol is ended, and its exchange is disconnected', async () => {
    // A host answering 261 bytes.
    const killed = [];
    host = new HidHost({
      idleMs: null,
      launch: () => {
        let toMain = null;
        let onExit = null;
        return {
          post: (message) =>
            setTimeout(() =>
              toMain({ op: 'answer', id: message.id, answer: '00'.repeat(261), dropped: 0 })
            ),
          kill: () => {
            killed.push(true);
            setTimeout(() => onExit(0));
          },
          onMessage: (fn) => (toMain = fn),
          onExit: (fn) => (onExit = fn),
        };
      },
    });
    const exchanged = failureOf(device().exchange(B001, DEADLINE_MS.DEVICE));
    await jest.advanceTimersByTimeAsync(5);
    expect(await exchanged).toMatchObject({ failure: 'disconnected' });
    expect(killed).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('a host that fails to start is disconnected', async () => {
    host = new HidHost({
      launch: () => {
        throw new Error('no utility process');
      },
      idleMs: null,
    });
    expect(await failureOf(device().exchange(B001, DEADLINE_MS.DEVICE))).toMatchObject({
      failure: 'disconnected',
    });
  });

  test('no Ledger is not_found, and one held by another app on macOS is busy', async () => {
    fake.unplug();
    const missing = failureOf(device().exchange(B001, DEADLINE_MS.DEVICE));
    await jest.advanceTimersByTimeAsync(5);
    expect(await missing).toMatchObject({ failure: 'not_found' });

    fake.plug();
    fake.ledger.heldElsewhere = true;
    host.kill();
    launch = inProcessHosts(fake, { platform: 'darwin' });
    host = new HidHost({ launch, idleMs: null });
    const held = failureOf(device().exchange(B001, DEADLINE_MS.DEVICE));
    await jest.advanceTimersByTimeAsync(5);
    expect(await held).toMatchObject({ failure: 'busy' });
  });
});

describe('R5 and late answers across operations', () => {
  test('after a cancel the next host forks only once the old one has exited; the old answer reaches no one', async () => {
    // macOS seizes the device: a second open fails while one is open.
    setUp({ exclusive: true });
    fake.ledger.respond = () => ({ hold: true });
    const old = device();
    const controller = new AbortController();
    const oldExchange = failureOf(old.exchange(ADDRESS, DEADLINE_MS.USER, controller.signal));
    await jest.advanceTimersByTimeAsync(200);

    controller.abort();
    const next = device();
    const nextExchange = next.exchange(B001, DEADLINE_MS.DEVICE);
    // Not forked while the killed host is exiting.
    expect(launch.hosts).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(5);
    expect(launch.hosts).toHaveLength(2);
    expect(types()).toEqual(['open:1', 'write:1', 'exit-close:1', 'open:2', 'write:2']);
    expect(await oldExchange).toMatchObject({ detached: true });

    // The old prompt's late answer, on the old channel, reaches the new
    // handle: dropped. Then the new APDU's own answer.
    fake.ledger.answerOn(fake.events[1].channel, '6985');
    await jest.advanceTimersByTimeAsync(10);
    fake.ledger.release(APP_ANSWER);
    await jest.advanceTimersByTimeAsync(10);
    await expect(nextExchange).resolves.toEqual(APP);
    expect(next.droppedFrames).toBe(1);
    next.detach();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('a channel let go of mid-flight is never drawn again, however many operations follow', async () => {
    // Operation A draws 7 and is cancelled mid-read; sixteen operations draw
    // 1-6 and 8-17; operation B's draws give 7 twice, then 18.
    const draws = [7, 1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 7, 7, 18];
    const randomInt = () => draws.shift();
    fake.ledger.respond = () => ({ hold: true });
    const a = device({ randomInt });
    const aExchange = failureOf(a.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(50);
    a.detach();
    await aExchange;

    fake.ledger.respond = () => ({ answer: '9000' });
    for (let i = 0; i < 16; i++) {
      const op = device({ randomInt });
      const answer = op.exchange(B001, DEADLINE_MS.DEVICE);
      await jest.advanceTimersByTimeAsync(5);
      await answer;
      op.detach();
    }

    fake.ledger.respond = () => ({ hold: true });
    const b = device({ randomInt });
    const bExchange = b.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    expect(fake.events.filter((e) => e.type === 'write').at(-1).channel).toBe(18);
    // A's late answer, on 7, during B: dropped, never B's answer.
    fake.ledger.answerOn(7, '6985');
    await jest.advanceTimersByTimeAsync(5);
    fake.ledger.release('9000');
    await jest.advanceTimersByTimeAsync(5);
    await expect(bExchange).resolves.toEqual(OK);
    expect(b.droppedFrames).toBe(1);
    expect(draws).toEqual([]);
    b.detach();
  });

  test('the backstop: an operation left holding the device is let go of before the next opens', async () => {
    setUp({ exclusive: true });
    fake.ledger.respond = () => ({ hold: true });
    const old = device();
    const oldExchange = failureOf(old.exchange(ADDRESS, DEADLINE_MS.USER));
    await jest.advanceTimersByTimeAsync(200);

    fake.ledger.respond = () => ({ answer: '9000' });
    const next = device();
    const nextExchange = next.exchange(B001, DEADLINE_MS.DEVICE);
    expect(await oldExchange).toMatchObject({ failure: 'disconnected', detached: true });
    await jest.advanceTimersByTimeAsync(5);
    expect(types()).toEqual(['open:1', 'write:1', 'exit-close:1', 'open:2', 'write:2', 'answer:']);
    await expect(nextExchange).resolves.toEqual(OK);
    expect(log.warn).toHaveBeenCalledTimes(1);
    next.detach();
  });

  test('the backstop with nothing in flight: the host closes the old handle first', async () => {
    const old = device();
    const answer = old.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await answer;

    const next = device();
    const nextExchange = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(5);
    await expect(nextExchange).resolves.toEqual(APP);
    expect(types()).toEqual([
      'open:1',
      'write:1',
      'answer:',
      'close:1',
      'open:2',
      'write:2',
      'answer:',
    ]);
    expect(launch.hosts).toHaveLength(1);
    next.detach();
  });
});

describe('calls the relay must never make', () => {
  test.each([
    ['an APDU of 4 bytes', Buffer.alloc(4), DEADLINE_MS.DEVICE],
    ['an APDU of 261 bytes', Buffer.alloc(261), DEADLINE_MS.DEVICE],
    ['hex instead of bytes', 'b001000000', DEADLINE_MS.DEVICE],
    ['another deadline', B001, 10_000],
  ])('%s is refused before anything is sent', async (_name, apdu, ms) => {
    await expect(device().exchange(apdu, ms)).rejects.toBeInstanceOf(TypeError);
    expect(launch.hosts).toHaveLength(0);
  });

  test('a second exchange in flight is refused, and the first goes on', async () => {
    const op = device();
    const first = op.exchange(B001, DEADLINE_MS.DEVICE);
    await expect(op.exchange(B001, DEADLINE_MS.DEVICE)).rejects.toThrow('One exchange at a time');
    await jest.advanceTimersByTimeAsync(5);
    await expect(first).resolves.toEqual(APP);
    expect(fake.ledger.apdus).toHaveLength(1);
    op.detach();
  });
});
