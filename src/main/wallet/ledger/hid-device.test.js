/**
 * Main's Ledger HID device (freedom-core design 0016, LDG-3 PR 5), with its
 * hosts served in this process on a fake node-hid
 * (test/helpers/fake-node-hid.js): opened per operation and closed at its
 * end; a cancel lets go mid-read by killing the host; a deadline gives
 * `unresponsive` (15 s) or `timeout` (5 minutes); an unplug gives
 * `disconnected`, and so does the host's exit; the next operation's host is
 * forked only once the old one has exited (R5: close before open); a kill
 * lands even before the host has spawned, and the wait for its exit is
 * bounded; a channel let go of mid-flight is never drawn again, and none
 * left refuses the operation; the host's replies are bounded frames, one
 * per exchange; and the host gets an allowlisted environment. Every test
 * also checks that nothing broke hidapi's contract, a close while a read
 * may be in flight included (R1).
 */

jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const log = require('../../logger');
const {
  HidDevice,
  HidDeviceError,
  HidHost,
  DEADLINE_MS,
  hostEnv,
  launchHost,
} = require('./hid-device');
const { encodeReply } = require('./hid-host');
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

function setUp({ exclusive = false, idleMs = null, channels } = {}) {
  fake = createFakeNodeHid({ exclusive });
  launch = inProcessHosts(fake);
  host = new HidHost({ launch, idleMs, channels });
}

// A launch whose processes the test drives: `spawn()`, `exit()`,
// `data(bytes)` (its stdout) and `stray(message)` (its message channel).
// `launch.options`: what kill() and forceKill() return once it has spawned
// (before, false), and whether a kill that went out ends it a tick later.
const scriptedProcs = [];
function scripted(options = {}) {
  const procs = [];
  const scriptedLaunch = () => {
    const on = {};
    const proc = {
      spawned: false,
      alive: true,
      reading: true,
      posted: [],
      kills: 0,
      forceKills: 0,
      post: (message) => proc.posted.push(message),
      kill: () => {
        proc.kills++;
        return end(scriptedLaunch.options.kill);
      },
      forceKill: () => {
        proc.forceKills++;
        return end(scriptedLaunch.options.forceKill);
      },
      stopReading: () => {
        proc.reading = false;
      },
      pid: () => undefined,
      onSpawn: (fn) => (on.spawn = fn),
      onData: (fn) => (on.data = fn),
      onStray: (fn) => (on.stray = fn),
      onExit: (fn) => (on.exit = fn),
      spawn() {
        proc.spawned = true;
        on.spawn();
      },
      exit() {
        if (!proc.alive) return;
        proc.alive = false;
        on.exit(0);
      },
      data: (bytes) => on.data(bytes),
      stray: (message) => on.stray(message),
    };
    function end(wentOut) {
      if (!proc.spawned || !wentOut) return false;
      if (scriptedLaunch.options.exitOnKill) setTimeout(() => proc.exit(), 0);
      return true;
    }
    procs.push(proc);
    scriptedProcs.push(proc);
    return proc;
  };
  scriptedLaunch.options = { kill: true, forceKill: true, exitOnKill: true, ...options };
  scriptedLaunch.procs = procs;
  return scriptedLaunch;
}

const answerFrame = (id, answer = '9000') =>
  encodeReply({ op: 'answer', id, answer: Buffer.from(answer, 'hex'), dropped: 0 });

beforeEach(() => {
  jest.useFakeTimers();
  setUp();
  log.warn.mockClear();
});

afterEach(async () => {
  // The hosts this test left running end, as main's quit ends them.
  host.kill();
  for (const proc of scriptedProcs.splice(0)) proc.exit();
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

    // A second exchange in the same operation, with nothing dropped before
    // it: the count stays the operation's total (the host sends a running
    // total, which main keeps rather than adds).
    const again = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(10);
    fake.ledger.release(APP_ANSWER);
    await jest.advanceTimersByTimeAsync(10);
    await expect(again).resolves.toEqual(APP);
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

describe('a kill always lands, and the wait for the exit is bounded', () => {
  test.each(['detach', 'signal'])(
    'a cancel (%s) before the first host spawns: it gets nothing, is ended as it spawns, and the next operation forks a fresh one',
    async (how) => {
      const op = device();
      const controller = new AbortController();
      const exchanged = failureOf(op.exchange(ADDRESS, DEADLINE_MS.USER, controller.signal));
      if (how === 'detach') op.detach();
      else controller.abort();
      expect(await exchanged).toMatchObject({ failure: 'disconnected', detached: true });
      // Electron's kill can't reach it yet.
      expect(launch.hosts[0]).toMatchObject({ spawned: false, alive: true });

      await jest.advanceTimersByTimeAsync(1);
      expect(launch.hosts[0]).toMatchObject({ spawned: true, alive: false, forced: true });
      expect(launch.hosts[0].toHost).toEqual([]);
      expect(fake.events).toEqual([]);

      const next = device();
      const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
      await jest.advanceTimersByTimeAsync(5);
      await expect(answer).resolves.toEqual(APP);
      expect(launch.hosts).toHaveLength(2);
      next.detach();
    }
  );

  test('a killed host still running 2 s on gets SIGKILL; the next operation forks once it exits', async () => {
    const scriptedLaunch = scripted({ exitOnKill: false });
    host = new HidHost({ launch: scriptedLaunch, idleMs: null });
    const old = device();
    const exchanged = failureOf(old.exchange(B001, DEADLINE_MS.DEVICE));
    const proc = scriptedLaunch.procs[0];
    expect(proc.posted).toEqual([]);
    proc.spawn();
    expect(proc.posted).toHaveLength(1);
    old.detach();
    await exchanged;
    expect(proc).toMatchObject({ kills: 1, forceKills: 0, reading: false });

    const next = device();
    const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(proc.forceKills).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(proc.forceKills).toBe(1);
    expect(scriptedLaunch.procs).toHaveLength(1);
    proc.exit();
    await jest.advanceTimersByTimeAsync(0);
    expect(scriptedLaunch.procs).toHaveLength(2);
    const fresh = scriptedLaunch.procs[1];
    fresh.spawn();
    fresh.data(answerFrame(fresh.posted[0].id));
    await expect(answer).resolves.toEqual(OK);
    next.detach();
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('a killed host that never exits is given up on 5 s after the kill, and the next operation forks a fresh one', async () => {
    const scriptedLaunch = scripted({ exitOnKill: false });
    host = new HidHost({ launch: scriptedLaunch, idleMs: null });
    const old = device();
    const exchanged = failureOf(old.exchange(B001, DEADLINE_MS.DEVICE));
    const proc = scriptedLaunch.procs[0];
    proc.spawn();
    old.detach();
    await exchanged;

    const next = device();
    const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
    await jest.advanceTimersByTimeAsync(4_999);
    expect(scriptedLaunch.procs).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(1);
    // It was sent SIGKILL: it can't use the device again.
    expect(proc.forceKills).toBeGreaterThan(0);
    expect(scriptedLaunch.procs).toHaveLength(2);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('going on without it'));

    // Its late bytes and its exit reach nothing.
    proc.data(answerFrame(scriptedLaunch.procs[0].posted[0].id, '6985'));
    proc.exit();
    const fresh = scriptedLaunch.procs[1];
    fresh.spawn();
    fresh.data(answerFrame(fresh.posted[0].id));
    await expect(answer).resolves.toEqual(OK);
    expect(log.warn).toHaveBeenCalledTimes(1);
    next.detach();
  });

  test('a host killed before it spawns that never spawns is given up on; spawning later, it is ended and gets nothing', async () => {
    const scriptedLaunch = scripted();
    host = new HidHost({ launch: scriptedLaunch, idleMs: null });
    const old = device();
    const exchanged = failureOf(old.exchange(B001, DEADLINE_MS.DEVICE));
    old.detach();
    await exchanged;
    const proc = scriptedLaunch.procs[0];
    expect(proc.kills).toBe(0);

    await jest.advanceTimersByTimeAsync(5_000);
    const next = device();
    const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
    expect(scriptedLaunch.procs).toHaveLength(2);
    proc.spawn();
    expect(proc.forceKills).toBe(1);
    expect(proc.posted).toEqual([]);
    await jest.advanceTimersByTimeAsync(0);
    const fresh = scriptedLaunch.procs[1];
    fresh.spawn();
    fresh.data(answerFrame(fresh.posted[0].id));
    await expect(answer).resolves.toEqual(OK);
    next.detach();
  });

  test('a host sent an exchange that no kill reaches is never given up on: operations fail at once until a kill goes out', async () => {
    const scriptedLaunch = scripted({ kill: false, forceKill: false });
    host = new HidHost({ launch: scriptedLaunch, idleMs: null });
    const old = device();
    const exchanged = failureOf(old.exchange(B001, DEADLINE_MS.DEVICE));
    const proc = scriptedLaunch.procs[0];
    proc.spawn();
    old.detach();
    await exchanged;
    // Its kill didn't go out: SIGKILL at once.
    expect(proc).toMatchObject({ kills: 1, forceKills: 1 });

    await jest.advanceTimersByTimeAsync(5_000);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be ended'));
    const refused = await failureOf(device().exchange(B001, DEADLINE_MS.DEVICE));
    expect(refused).toMatchObject({ failure: 'disconnected' });
    expect(scriptedLaunch.procs).toHaveLength(1);
    const tries = proc.forceKills;

    scriptedLaunch.options.forceKill = true;
    const next = device();
    const answer = next.exchange(B001, DEADLINE_MS.DEVICE);
    expect(proc.forceKills).toBe(tries + 1);
    expect(scriptedLaunch.procs).toHaveLength(2);
    const fresh = scriptedLaunch.procs[1];
    fresh.spawn();
    fresh.data(answerFrame(fresh.posted[0].id));
    await expect(answer).resolves.toEqual(OK);
    next.detach();
  });
});

describe("the host's replies: bounded frames, one per exchange, rebuilt by main", () => {
  let scriptedLaunch;
  beforeEach(() => {
    scriptedLaunch = scripted();
    host = new HidHost({ launch: scriptedLaunch, idleMs: null });
  });

  function inFlight() {
    const op = device();
    const exchanged = op.exchange(B001, DEADLINE_MS.DEVICE);
    const proc = scriptedLaunch.procs[0];
    proc.spawn();
    return { op, exchanged, proc, id: proc.posted[0].id };
  }

  test('an answer split byte by byte is read whole', async () => {
    const { op, exchanged, proc, id } = inFlight();
    for (const byte of answerFrame(id, APP_ANSWER)) proc.data(Buffer.from([byte]));
    await expect(exchanged).resolves.toEqual(APP);
    op.detach();
    expect(log.warn).not.toHaveBeenCalled();
  });

  const reply = (id, kind, rest) => {
    const body = Buffer.alloc(11);
    body[0] = kind;
    body.writeUIntBE(id, 1, 6);
    const payload = Buffer.concat([body, rest]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(payload.length & 0xffff);
    return Buffer.concat([length, payload]);
  };
  test.each([
    ['an answer with a member more (261 bytes)', (id) => reply(id, 1, Buffer.alloc(261))],
    ['a failure with a member more', (id) => reply(id, 2, Buffer.from([3, 0xff]))],
    ['a reply of another kind', (id) => reply(id, 9, Buffer.from('9000', 'hex'))],
    [
      'an oversized frame (64 KiB)',
      () => Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.alloc(0xffff, 0x41)]),
    ],
  ])('%s ends the host; its exchange is disconnected', async (_name, bad) => {
    const { exchanged, proc, id } = inFlight();
    const failed = failureOf(exchanged);
    proc.data(bad(id));
    expect(proc).toMatchObject({ kills: 1, reading: false });
    await jest.advanceTimersByTimeAsync(0);
    expect(await failed).toMatchObject({ failure: 'disconnected' });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('a flood: the expected answer is taken, the next frame ends the host, nothing after it is read', async () => {
    const { op, exchanged, proc, id } = inFlight();
    const flood = Buffer.concat(Array.from({ length: 1_000 }, () => answerFrame(id, '6985')));
    proc.data(Buffer.concat([answerFrame(id), flood]));
    await expect(exchanged).resolves.toEqual(OK);
    expect(proc).toMatchObject({ kills: 1, reading: false });
    expect(log.warn).toHaveBeenCalledTimes(1);
    // More bytes, more frames: nothing reads them.
    proc.data(flood);
    expect(log.warn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(await failureOf(op.exchange(B001, DEADLINE_MS.DEVICE))).toMatchObject({
      failure: 'disconnected',
    });
  });

  test('a reply with no exchange in flight ends the host', async () => {
    const { op, exchanged, proc, id } = inFlight();
    proc.data(answerFrame(id));
    await exchanged;
    proc.data(answerFrame(id + 1));
    expect(proc.kills).toBe(1);
    op.detach();
  });

  test('anything posted on the message channel ends the host, however much comes', async () => {
    const { exchanged, proc, id } = inFlight();
    const failed = failureOf(exchanged);
    const padding = new ArrayBuffer(1 << 20);
    for (let i = 0; i < 100; i++)
      proc.stray({ op: 'answer', id, answer: '9000', dropped: 0, padding });
    expect(proc).toMatchObject({ kills: 1, reading: false });
    expect(log.warn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(0);
    expect(await failed).toMatchObject({ failure: 'disconnected' });
  });

  test("a killed host's bytes are not read", async () => {
    const { op, exchanged, proc, id } = inFlight();
    op.detach();
    await failureOf(exchanged);
    proc.data(answerFrame(id));
    proc.data(Buffer.from([0xff, 0xff]));
    proc.stray({});
    expect(log.warn).not.toHaveBeenCalled();
    expect(proc.kills).toBe(1);
  });
});

describe('channels: one let go of mid-flight stays unused while main runs', () => {
  test('every one stays unavailable; once none is left, each new operation is refused', async () => {
    setUp({ channels: 4 });
    fake.ledger.respond = () => ({ hold: true });
    const draws = [2, 2, 0, 2, 0, 1, 3];
    const randomInt = (max) => {
      expect(max).toBe(4);
      return draws.shift();
    };
    const used = [];
    for (let i = 0; i < 4; i++) {
      const op = device({ randomInt });
      const exchanged = failureOf(op.exchange(B001, DEADLINE_MS.DEVICE));
      await jest.advanceTimersByTimeAsync(5);
      used.push(fake.events.filter((e) => e.type === 'write').at(-1).channel);
      op.detach();
      await exchanged;
    }
    expect(used).toEqual([2, 0, 1, 3]);
    expect(draws).toEqual([]);

    const writes = fake.events.filter((e) => e.type === 'write').length;
    for (let i = 0; i < 2; i++) {
      const refused = device({ randomInt });
      const err = await failureOf(refused.exchange(B001, DEADLINE_MS.DEVICE));
      expect(err).toBeInstanceOf(HidDeviceError);
      expect(err).toMatchObject({ failure: 'disconnected' });
      expect(err.message).toMatch(/no HID channel left/);
      expect(refused.isOpen).toBe(false);
    }
    await jest.advanceTimersByTimeAsync(5);
    expect(fake.events.filter((e) => e.type === 'write')).toHaveLength(writes);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('No HID channel is left'));
  });
});

describe("the host's environment: an allowlist, never main's", () => {
  const SENTINEL = 'LEDGER_HID_TEST_SENTINEL';
  const main = {
    [SENTINEL]: 'main only',
    PATH: '/usr/bin',
    HOME: '/home/user',
    SystemRoot: 'C:\\Windows',
    SystemDrive: 'C:',
    windir: 'C:\\Windows',
  };

  test('only what the OS needs, and the marker that keeps it from being empty', () => {
    for (const platform of ['linux', 'darwin']) {
      expect(hostEnv({ platform, env: main })).toEqual({ FREEDOM_LEDGER_HID_HOST: '1' });
    }
    expect(hostEnv({ platform: 'win32', env: main })).toEqual({
      FREEDOM_LEDGER_HID_HOST: '1',
      SystemRoot: 'C:\\Windows',
      SystemDrive: 'C:',
      windir: 'C:\\Windows',
    });
    expect(hostEnv({ platform: 'linux', env: main, runAsNode: true })).toEqual({
      FREEDOM_LEDGER_HID_HOST: '1',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });

  function forked(type) {
    const forks = [];
    const EventEmitter = require('events');
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      postMessage: jest.fn(),
      send: jest.fn(),
      kill: jest.fn(() => true),
      pid: undefined,
    });
    const fork = (...args) => {
      forks.push(args);
      return child;
    };
    const saved = Object.getOwnPropertyDescriptor(process, 'type');
    const savedSentinel = process.env[SENTINEL];
    process.env[SENTINEL] = 'main only';
    Object.defineProperty(process, 'type', { value: type, configurable: true });
    let proc;
    try {
      jest.isolateModules(() => {
        jest.doMock('electron', () => ({ utilityProcess: { fork } }));
        jest.doMock('child_process', () => ({ fork }));
        proc = require('./hid-device').launchHost();
        proc.post({ op: 'close' });
      });
    } finally {
      if (saved) Object.defineProperty(process, 'type', saved);
      else delete process.type;
      if (savedSentinel === undefined) delete process.env[SENTINEL];
      else process.env[SENTINEL] = savedSentinel;
      jest.dontMock('electron');
      jest.dontMock('child_process');
    }
    return { forks, child, proc };
  }

  function onPlatform(platform, fn) {
    const saved = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, 'platform', saved);
    }
  }

  test("the launcher's kills: SIGKILL by pid on POSIX once spawned; on Windows, a terminate that went out", () => {
    const { child, proc } = forked('browser');
    const signal = jest.spyOn(process, 'kill').mockImplementation(() => true);
    try {
      onPlatform('linux', () => {
        expect(proc.forceKill()).toBe(false);
        child.pid = 4242;
        expect(proc.forceKill()).toBe(true);
        expect(signal).toHaveBeenCalledWith(4242, 'SIGKILL');
        signal.mockImplementation(() => {
          throw Object.assign(new Error('gone'), { code: 'ESRCH' });
        });
        expect(proc.forceKill()).toBe(true);
        signal.mockImplementation(() => {
          throw Object.assign(new Error('not ours'), { code: 'EPERM' });
        });
        expect(proc.forceKill()).toBe(false);
      });
      onPlatform('win32', () => {
        child.kill.mockReturnValue(false);
        expect(proc.forceKill()).toBe(false);
        child.kill.mockReturnValue(true);
        expect(proc.kill()).toBe(true);
        child.kill.mockReturnValue(false);
        expect(proc.forceKill()).toBe(true);
      });
    } finally {
      signal.mockRestore();
    }
  });

  test("main's utility process gets the allowlist and pipes its stdout; nothing of main's sentinel", () => {
    const { forks, child } = forked('browser');
    expect(forks).toHaveLength(1);
    const [, , options] = forks[0];
    expect(options.env).toEqual(hostEnv());
    expect(options.env[SENTINEL]).toBeUndefined();
    expect(options.stdio).toEqual(['ignore', 'pipe', 'inherit']);
    expect(child.postMessage).toHaveBeenCalledWith({ op: 'close' });
  });

  test("the probe's Node child gets the allowlist too", () => {
    const { forks, child } = forked(undefined);
    const [, , options] = forks[0];
    expect(options.env[SENTINEL]).toBeUndefined();
    expect(options.env.FREEDOM_LEDGER_HID_HOST).toBe('1');
    expect(options.stdio).toEqual(['ignore', 'pipe', 'inherit', 'ipc']);
    expect(child.send).toHaveBeenCalledWith({ op: 'close' });
    expect(typeof launchHost).toBe('function');
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
