/**
 * Main-process event-loop watchdog (#498).
 *
 * A blocked main thread freezes every window — the chrome stops painting and
 * ignores input — and leaves nothing in the logs. #495's ~30 s startup freeze
 * (Colibri's WASM verifier running Ant's `eth_getLogs` synchronously) was only
 * noticed as a spinner. This turns such a stall into one log line:
 *
 *   [main] event loop blocked 21034 ms (chain-data: 100 eth_getLogs via colibri, 21040 ms)
 *
 * How: one unref'd interval timer. Each tick measures how late it fired; a
 * timer cannot fire while the loop is blocked, so the lateness *is* the
 * blocked time (to within one interval). The line is written when the loop
 * comes back, which is the only time JavaScript can write anything — so the
 * "what was running" part comes from `describeActivity({ since })`, asked
 * about everything in flight or settled since the last on-time tick (a
 * synchronous stall usually ends exactly when its culprit settles, before the
 * timer phase gets to run).
 *
 * Cost: a 500 ms timer doing a subtraction and a comparison — no histogram,
 * no allocation on a healthy tick. `unref()` so it never keeps the process
 * alive on quit.
 *
 * Log volume: the first stall is logged at once; further stalls within
 * `minReportGapMs` are folded into one summary line (count, worst, total,
 * and the worst one's activity) written once that window has passed, or on
 * `stop()` (quit). A host that stalls every second for an hour writes ~120
 * lines, not ~3600.
 *
 * System sleep: `suspend()` (powerMonitor 'suspend') opens a window, closed by
 * `reset()` (resume), in which a late tick may be the machine asleep rather
 * than the loop blocked. Whether it is depends on the platform's monotonic
 * clock, and the watchdog tells the two apart with the wall clock instead of
 * assuming:
 *
 *   - Linux/macOS: `performance.now()` stops while asleep, so the tick that
 *     spans the sleep shows the wall clock running ahead of it. That tick's
 *     monotonic lateness is awake time only — a real stall, reported as usual
 *     — and the window closes there.
 *   - Windows: QPC keeps counting through sleep, so a late tick can't be split
 *     into sleep and stall. Such ticks are held, not reported, until the
 *     window closes; if the wall clock then shows the monotonic clock paused
 *     after all, they were real stalls and are reported, otherwise they are
 *     written as one `info` line ("not reported as a stall") — never as an
 *     hours-long warn, and never silently.
 *
 * On Linux/macOS a window that closes without any tick showing the monotonic
 * clock paused means no sleep happened inside it (inhibited, aborted,
 * vetoed): the clock would have shown it. Held ticks there can only be awake
 * time, so they are reported as stalls too — the `info` line is Windows-only,
 * where a sleep can't be seen that way.
 *
 * A window with no resume (a vetoed sleep, a lost event) closes on its own
 * after `suspendGraceMs`, the same way as a resume.
 */

const { performance } = require('perf_hooks');

const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_THRESHOLD_MS = 1000;
const DEFAULT_MIN_REPORT_GAP_MS = 30_000;
// How long a `suspend()` window stays open when neither `reset()` (resume)
// nor a tick spanning a paused monotonic clock arrives to close it — e.g. a
// sleep that was vetoed, or a missed resume event. Bounds how long a lost
// power event can hold late ticks back from the warn log.
const DEFAULT_SUSPEND_GRACE_MS = 5 * 60_000;

function formatLine(blockedMs, activity) {
  return (
    `[main] event loop blocked ${Math.round(blockedMs)} ms` + (activity ? ` (${activity})` : '')
  );
}

function startEventLoopWatchdog({
  log,
  describeActivity = () => '',
  intervalMs = DEFAULT_INTERVAL_MS,
  thresholdMs = DEFAULT_THRESHOLD_MS,
  minReportGapMs = DEFAULT_MIN_REPORT_GAP_MS,
  suspendGraceMs = DEFAULT_SUSPEND_GRACE_MS,
  // Whether `now` keeps counting through system sleep: true for Windows' QPC,
  // false for CLOCK_MONOTONIC (Linux) and mach_absolute_time (macOS). Where it
  // doesn't, a sleep always shows up as the wall clock running ahead, so a
  // window that closes without that signal held only real stalls.
  monotonicCountsSleep = process.platform === 'win32',
  now = () => performance.now(),
  // Wall clock: runs through system sleep on every platform, unlike `now`
  // on Linux/macOS; comparing the two shows whether `now` paused.
  wallNow = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (!log || typeof log.warn !== 'function') throw new Error('startEventLoopWatchdog needs a log');

  let lastTick = now();
  let lastTickWall = wallNow();
  let lastReportAt = -Infinity;
  let suppressed = null; // { count, worstMs, totalMs, worstActivity }
  // Set by suspend(): { at, wallAt, held: [{ blockedMs, activity }] }.
  let suspended = null;

  // True when, over [mono, wall] .. now, the wall clock ran ahead of the
  // monotonic one by at least a threshold — i.e. `now` stopped during a sleep
  // in that span, so monotonic time measured across it is awake time only.
  // (A forward wall-clock step of that size, e.g. an NTP correction, reads
  // the same; it can at worst turn a held Windows sleep gap into a warn.)
  function monotonicPaused(mono, wall, t, wt) {
    return wt - wall - (t - mono) >= thresholdMs;
  }

  function safeDescribe(since) {
    try {
      return describeActivity({ since }) || '';
    } catch {
      return '';
    }
  }

  function flushSuppressed(t) {
    if (!suppressed) return;
    const { count, worstMs, totalMs, worstActivity } = suppressed;
    log.warn(
      `[main] event loop blocked ${count} more time${count === 1 ? '' : 's'} ` +
        `>= ${thresholdMs} ms in the last ${Math.round((t - lastReportAt) / 1000)} s ` +
        `(worst ${Math.round(worstMs)} ms, total ${Math.round(totalMs)} ms` +
        (worstActivity ? `; worst during ${worstActivity}` : '') +
        ')'
    );
    suppressed = null;
    lastReportAt = t;
  }

  function report(blockedMs, activity, t) {
    if (t - lastReportAt >= minReportGapMs) {
      // Anything folded since the last line goes out first, so lines stay in
      // order; then this stall gets its own line.
      if (suppressed) flushSuppressed(t);
      log.warn(formatLine(blockedMs, activity));
      lastReportAt = t;
      return;
    }
    if (!suppressed) suppressed = { count: 0, worstMs: 0, totalMs: 0, worstActivity: '' };
    suppressed.count += 1;
    suppressed.totalMs += blockedMs;
    if (blockedMs > suppressed.worstMs) {
      suppressed.worstMs = blockedMs;
      suppressed.worstActivity = activity;
    }
  }

  // Close the suspend() window. `stalls`: whether the held late ticks are
  // known to be awake time (the monotonic clock paused through the sleep, so
  // none of them can contain it). Where the monotonic clock doesn't count
  // sleep, a close without that signal means no sleep happened in the window
  // at all, so the held ticks are stalls either way.
  function endSuspension(stalls, t) {
    const { held } = suspended;
    suspended = null;
    if (!held.length) return;
    if (stalls || !monotonicCountsSleep) {
      for (const h of held) report(h.blockedMs, h.activity, t);
      return;
    }
    const total = held.reduce((sum, h) => sum + h.blockedMs, 0);
    (typeof log.info === 'function' ? log.info : log.warn).call(
      log,
      `[main] event loop: ${held.length} late tick${held.length === 1 ? '' : 's'} ` +
        `(${Math.round(total)} ms) during a system-sleep window (likely the sleep itself), ` +
        'not reported as a stall'
    );
  }

  function tick() {
    const t = now();
    const wt = wallNow();
    const since = lastTick;
    const sinceWall = lastTickWall;
    const blockedMs = t - since - intervalMs;
    lastTick = t;
    lastTickWall = wt;

    if (suspended) {
      if (monotonicPaused(since, sinceWall, t, wt)) {
        // This tick spans the sleep, and the monotonic clock skipped it: the
        // lateness is awake time (e.g. wake-up work before 'resume' is
        // dispatched). Ticks held earlier in the window can't contain the
        // sleep either. Close the window and report as usual.
        endSuspension(true, t);
      } else {
        // Ambiguous: a late tick here is either a stall or (where the clock
        // counts through sleep) the sleep itself. Hold it; a stall before the
        // machine actually sleeps doesn't close the window, so the sleep gap
        // after it is still recognised.
        if (blockedMs >= thresholdMs) {
          suspended.held.push({ blockedMs, activity: safeDescribe(since) });
        }
        if (t - suspended.at >= suspendGraceMs) {
          endSuspension(monotonicPaused(suspended.at, suspended.wallAt, t, wt), t);
        }
        return;
      }
    }

    if (blockedMs < thresholdMs) {
      if (suppressed && t - lastReportAt >= minReportGapMs) flushSuppressed(t);
      return;
    }
    report(blockedMs, safeDescribe(since), t);
  }

  const timer = setIntervalFn(tick, intervalMs);
  timer?.unref?.();

  return {
    // The system is about to sleep (powerMonitor 'suspend'): open the window
    // in which a late tick may be the sleep rather than a stall.
    suspend() {
      if (suspended) return; // a repeated 'suspend' keeps the first window and its held ticks
      suspended = { at: now(), wallAt: wallNow(), held: [] };
    },
    // Resume from system sleep: measure what the loop did since the last tick
    // (if the monotonic clock paused through the sleep, that is awake time
    // and a stall in it is reported), close the window, then start a fresh
    // interval so the sleep itself never counts.
    reset() {
      if (suspended) {
        tick();
        if (suspended) endSuspension(false, now());
      }
      lastTick = now();
      lastTickWall = wallNow();
    },
    // Stop ticking, writing out any stalls still folded into the pending
    // summary — on quit they would otherwise never reach the log.
    stop() {
      clearIntervalFn(timer);
      flushSuppressed(now());
    },
    // Exposed for tests.
    tick,
  };
}

module.exports = {
  startEventLoopWatchdog,
  formatLine,
  DEFAULT_INTERVAL_MS,
  DEFAULT_THRESHOLD_MS,
  DEFAULT_MIN_REPORT_GAP_MS,
  DEFAULT_SUSPEND_GRACE_MS,
};
