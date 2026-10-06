const { startEventLoopWatchdog } = require('./event-loop-watchdog');

function harness(opts = {}) {
  let t = 0; // monotonic clock (performance.now())
  let w = 1_700_000_000_000; // wall clock (Date.now())
  const log = { warn: jest.fn(), info: jest.fn() };
  let handle = null;
  const timer = { unref: jest.fn() };
  const watchdog = startEventLoopWatchdog({
    log,
    intervalMs: 500,
    thresholdMs: 1000,
    minReportGapMs: 30_000,
    now: () => t,
    wallNow: () => w,
    setIntervalFn: (fn) => {
      handle = fn;
      return timer;
    },
    clearIntervalFn: jest.fn(),
    ...opts,
  });
  // Advance the clock by `ms` and fire the (late) timer once.
  const fireAfter = (ms) => {
    t += ms;
    w += ms;
    handle();
  };
  // The machine sleeps for `ms`. The wall clock always counts it; the
  // monotonic clock does on Windows (QPC) but not on Linux/macOS.
  const sleep = (ms, { monotonicCounts }) => {
    w += ms;
    if (monotonicCounts) t += ms;
  };
  const advance = (ms) => {
    t += ms;
    w += ms;
  };
  return { log, watchdog, fireAfter, timer, advance, sleep };
}

describe('event-loop watchdog', () => {
  test('stays silent while ticks arrive roughly on time', () => {
    const { log, fireAfter, timer } = harness();
    for (let i = 0; i < 100; i += 1) fireAfter(500 + (i % 3) * 200);
    expect(log.warn).not.toHaveBeenCalled();
    expect(timer.unref).toHaveBeenCalled();
  });

  test('logs the blocked time once a tick is late by the threshold', () => {
    const { log, fireAfter } = harness();
    fireAfter(500 + 999);
    expect(log.warn).not.toHaveBeenCalled();
    fireAfter(500 + 21034);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 21034 ms');
  });

  test('names what was running, asked about the stalled window', () => {
    const describeActivity = jest.fn(() => 'chain-data: 100 eth_getLogs via colibri, 21040 ms');
    const { log, fireAfter } = harness({ describeActivity });
    fireAfter(500); // last on-time tick at t=500
    fireAfter(500 + 2000);
    expect(describeActivity).toHaveBeenCalledWith({ since: 500 });
    expect(log.warn).toHaveBeenCalledWith(
      '[main] event loop blocked 2000 ms (chain-data: 100 eth_getLogs via colibri, 21040 ms)'
    );
  });

  test('a throwing activity source never breaks the watchdog', () => {
    const { log, fireAfter } = harness({
      describeActivity: () => {
        throw new Error('boom');
      },
    });
    fireAfter(3000);
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 2500 ms');
  });

  test('folds repeated stalls into one summary line instead of spamming', () => {
    const activities = ['a', 'worst-one', 'c'];
    let i = 0;
    const { log, fireAfter } = harness({ describeActivity: () => activities[i++] || '' });
    fireAfter(500 + 1500); // reported immediately
    expect(log.warn).toHaveBeenCalledTimes(1);
    fireAfter(500 + 4000); // folded (worst)
    fireAfter(500 + 1200); // folded
    for (let k = 0; k < 10; k += 1) fireAfter(500); // healthy, still inside the gap
    expect(log.warn).toHaveBeenCalledTimes(1);
    for (let k = 0; k < 60; k += 1) fireAfter(500); // gap passes → summary
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toMatch(
      /^\[main\] event loop blocked 2 more times >= 1000 ms in the last \d+ s \(worst 4000 ms, total 5200 ms; worst during worst-one\)$/
    );
    for (let k = 0; k < 200; k += 1) fireAfter(500);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  test('a stall after the gap flushes the summary first, then gets its own line', () => {
    const { log, fireAfter } = harness();
    fireAfter(2000);
    fireAfter(2000); // folded
    fireAfter(500 + 40_000); // past the gap
    expect(log.warn.mock.calls.map((c) => c[0])).toEqual([
      '[main] event loop blocked 1500 ms',
      expect.stringMatching(/^\[main\] event loop blocked 1 more time >= 1000 ms/),
      '[main] event loop blocked 40000 ms',
    ]);
  });

  test('reset() drops the gap, e.g. across system sleep', () => {
    const { log, fireAfter, watchdog, advance } = harness();
    advance(60_000);
    watchdog.reset();
    fireAfter(500);
    expect(log.warn).not.toHaveBeenCalled();
  });

  const HOURS_3 = 3 * 3600_000;
  const WINDOWS = { monotonicCountsSleep: true };
  const POSIX = { monotonicCountsSleep: false };

  test('suspend() on Windows: the sleep gap is not reported even when the overdue tick beats resume', () => {
    const { log, fireAfter, watchdog, sleep } = harness(WINDOWS);
    fireAfter(500);
    watchdog.suspend();
    fireAfter(500); // on time, before the machine actually sleeps
    sleep(HOURS_3, { monotonicCounts: true });
    fireAfter(500); // QPC counted the sleep; resume not yet seen
    watchdog.reset(); // 'resume' lands afterwards
    fireAfter(500);
    expect(log.warn).not.toHaveBeenCalled();
    // ...but it isn't silent either: one info line names what was set aside.
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatch(
      /^\[main\] event loop: 1 late tick \(\d+ ms\) during a system-sleep window \(likely the sleep itself\), not reported as a stall$/
    );
  });

  test('suspend() on Windows: a real stall before the sleep does not end the window early', () => {
    const { log, fireAfter, watchdog, sleep } = harness(WINDOWS);
    watchdog.suspend();
    fireAfter(500 + 2000); // a stall between 'suspend' and the actual sleep
    sleep(HOURS_3, { monotonicCounts: true });
    fireAfter(500); // the sleep gap, before 'resume'
    watchdog.reset();
    fireAfter(500);
    // Never an hours-long stall line.
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info.mock.calls[0][0]).toMatch(/^\[main\] event loop: 2 late ticks/);
  });

  test('suspend() on Linux/macOS: a stall during wake-up, before resume, is reported', () => {
    const { log, fireAfter, watchdog, sleep } = harness(POSIX);
    fireAfter(500);
    watchdog.suspend();
    fireAfter(500);
    sleep(HOURS_3, { monotonicCounts: false }); // CLOCK_MONOTONIC stops
    fireAfter(500 + 4000); // wake-up work blocks 4 s; 'resume' not yet dispatched
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 4000 ms');
    watchdog.reset();
    fireAfter(500 + 2000); // the window is closed: later stalls count as usual
    expect(log.warn).toHaveBeenCalledTimes(1); // folded into the summary
    watchdog.stop();
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.info).not.toHaveBeenCalled();
  });

  test('suspend() on Linux/macOS: a wake-up stall is reported even when resume beats the tick', () => {
    const { log, fireAfter, watchdog, sleep, advance } = harness(POSIX);
    fireAfter(500);
    watchdog.suspend();
    sleep(HOURS_3, { monotonicCounts: false });
    advance(3000); // blocked 3 s after wake; 'resume' is dispatched first
    watchdog.reset();
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 2500 ms');
    fireAfter(500);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('suspend() on Linux/macOS: a stall before the sleep is reported once the sleep shows', () => {
    const { log, fireAfter, watchdog, sleep } = harness(POSIX);
    watchdog.suspend();
    fireAfter(500 + 2000); // ambiguous on its own: held
    expect(log.warn).not.toHaveBeenCalled();
    sleep(HOURS_3, { monotonicCounts: false });
    fireAfter(500); // spans the sleep; the monotonic clock paused → held tick was a stall
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 2000 ms');
    expect(log.info).not.toHaveBeenCalled();
  });

  test('reset() on Windows with no late tick yet absorbs the sleep gap', () => {
    const { log, fireAfter, watchdog, sleep } = harness(WINDOWS);
    fireAfter(500);
    watchdog.suspend();
    sleep(HOURS_3, { monotonicCounts: true });
    watchdog.reset(); // 'resume' beats the overdue tick
    fireAfter(500);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test('suspend() on Linux/macOS: a stall in a window where no sleep happens is reported, not called sleep', () => {
    // logind PrepareForSleep(true) → suspend(); the sleep is then inhibited
    // or aborted and PrepareForSleep(false) → reset(). No tick ever shows the
    // monotonic clock paused, so the late tick can only be awake time.
    const { log, fireAfter, watchdog } = harness(POSIX);
    fireAfter(500);
    watchdog.suspend();
    fireAfter(500 + 3000);
    expect(log.warn).not.toHaveBeenCalled(); // held while it might still be the sleep
    watchdog.reset();
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 3000 ms');
    expect(log.info).not.toHaveBeenCalled();
  });

  test('suspend() on Windows: the same no-sleep window stays an info line', () => {
    // QPC can't tell this stall from a sleep gap, so it is held, not warned.
    const { log, fireAfter, watchdog } = harness(WINDOWS);
    fireAfter(500);
    watchdog.suspend();
    fireAfter(500 + 3000);
    watchdog.reset();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  test('suspend() on Linux/macOS: held stalls are reported when the grace period expires', () => {
    const { log, fireAfter, watchdog } = harness({ ...POSIX, suspendGraceMs: 10_000 });
    watchdog.suspend();
    fireAfter(500 + 2000); // held
    for (let k = 0; k < 20; k += 1) fireAfter(500); // no sleep, no resume
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 2000 ms');
    expect(log.info).not.toHaveBeenCalled();
  });

  test('suspend() with no sleep and no resume expires after the grace period', () => {
    const { log, fireAfter, watchdog } = harness({ suspendGraceMs: 10_000 });
    watchdog.suspend();
    for (let k = 0; k < 20; k += 1) fireAfter(500); // vetoed sleep: ticks stay on time
    fireAfter(500 + 2000);
    expect(log.warn).toHaveBeenCalledWith('[main] event loop blocked 2000 ms');
  });

  test('stop() flushes stalls still folded into the pending summary', () => {
    const { log, fireAfter, watchdog } = harness({ describeActivity: () => 'x' });
    fireAfter(500 + 1500); // t=0 stall, logged
    fireAfter(500 + 10_000); // folded
    expect(log.warn).toHaveBeenCalledTimes(1);
    watchdog.stop(); // quit inside the 30 s window
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn.mock.calls[1][0]).toMatch(
      /^\[main\] event loop blocked 1 more time >= 1000 ms .*\(worst 10000 ms, total 10000 ms; worst during x\)$/
    );
    watchdog.stop();
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  test('stop() with nothing folded writes nothing', () => {
    const { log, fireAfter, watchdog } = harness();
    fireAfter(500 + 1500);
    watchdog.stop();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  test('stop() clears the interval', () => {
    const clearIntervalFn = jest.fn();
    const { watchdog, timer } = harness({ clearIntervalFn });
    watchdog.stop();
    expect(clearIntervalFn).toHaveBeenCalledWith(timer);
  });

  test('real timers: a synchronous busy loop is reported', async () => {
    const log = { warn: jest.fn() };
    const watchdog = startEventLoopWatchdog({ log, intervalMs: 20, thresholdMs: 150 });
    await new Promise((r) => setTimeout(r, 60));
    const end = Date.now() + 400;
    while (Date.now() < end) {
      // block the loop
    }
    await new Promise((r) => setTimeout(r, 60));
    watchdog.stop();
    expect(log.warn).toHaveBeenCalledTimes(1);
    const ms = Number(log.warn.mock.calls[0][0].match(/blocked (\d+) ms/)[1]);
    expect(ms).toBeGreaterThanOrEqual(150);
  });
});
