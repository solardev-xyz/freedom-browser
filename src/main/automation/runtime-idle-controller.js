'use strict';

const DEFAULT_RUNTIME_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_BUSY_POLL_INTERVAL_MS = 1000;

function createRuntimeIdleController(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_RUNTIME_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new TypeError('Runtime idle timeout must be a non-negative integer');
  }
  if (typeof options.onIdle !== 'function') {
    throw new TypeError('Runtime idle controller requires onIdle()');
  }
  const busyPollIntervalMs = options.busyPollIntervalMs ?? DEFAULT_BUSY_POLL_INTERVAL_MS;
  if (!Number.isInteger(busyPollIntervalMs) || busyPollIntervalMs < 1) {
    throw new TypeError('Runtime busy poll interval must be a positive integer');
  }

  const now = options.now || Date.now;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  const logger = options.logger || console;
  const blockers = new Map();
  const probes = new Map();
  let timer = null;
  let started = false;
  let idleTriggered = false;
  let lastActivityAtMs = null;
  let lastActivityReason = null;
  let idleDeadlineAtMs = null;
  let busyProbeNames = [];

  const enabled = timeoutMs > 0;
  const blockerCount = () => [...blockers.values()].reduce((total, count) => total + count, 0);

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
    idleDeadlineAtMs = null;
  }

  function scheduleCheck(delayMs) {
    clearTimer();
    if (!started || !enabled || blockerCount() > 0 || idleTriggered) return;
    idleDeadlineAtMs = now() + delayMs;
    timer = schedule(checkIdle, delayMs);
    timer?.unref?.();
  }

  function touch(reason = 'activity') {
    if (!started || idleTriggered) return false;
    lastActivityAtMs = now();
    lastActivityReason = reason;
    busyProbeNames = [];
    if (enabled && blockerCount() === 0) scheduleCheck(timeoutMs);
    else clearTimer();
    return true;
  }

  function probeBusySources() {
    const busy = [];
    for (const [name, probe] of probes) {
      try {
        if (probe() === true) busy.push(name);
      } catch (error) {
        busy.push(name);
        logger.warn?.(`[automation-runtime] Idle probe failed closed (${name}):`, error);
      }
    }
    return busy;
  }

  function checkIdle() {
    timer = null;
    idleDeadlineAtMs = null;
    if (!started || !enabled || idleTriggered || blockerCount() > 0) return;
    const busy = probeBusySources();
    if (busy.length > 0) {
      busyProbeNames = busy;
      scheduleCheck(busyPollIntervalMs);
      return;
    }
    if (busyProbeNames.length > 0) {
      touch('tracked-work-finished');
      return;
    }
    idleTriggered = true;
    try {
      options.onIdle();
    } catch (error) {
      logger.error?.('[automation-runtime] Idle shutdown callback failed:', error);
    }
  }

  function acquire(source = 'activity') {
    blockers.set(source, (blockers.get(source) || 0) + 1);
    if (started && !idleTriggered) {
      lastActivityAtMs = now();
      lastActivityReason = `${source}:acquired`;
      clearTimer();
    }
    let released = false;
    return () => {
      if (released) return false;
      released = true;
      const remaining = (blockers.get(source) || 1) - 1;
      if (remaining > 0) blockers.set(source, remaining);
      else blockers.delete(source);
      if (started && !idleTriggered && blockerCount() === 0) {
        touch(`${source}:released`);
      }
      return true;
    };
  }

  function registerProbe(name, probe) {
    if (typeof name !== 'string' || !name || typeof probe !== 'function') {
      throw new TypeError('Runtime idle probes require a name and function');
    }
    probes.set(name, probe);
    return () => probes.delete(name);
  }

  function start() {
    if (started) return false;
    started = true;
    idleTriggered = false;
    lastActivityAtMs = now();
    lastActivityReason = 'runtime-ready';
    if (enabled && blockerCount() === 0) scheduleCheck(timeoutMs);
    return true;
  }

  function stop() {
    if (!started) return false;
    started = false;
    clearTimer();
    return true;
  }

  function status() {
    const activeBlockers = [...blockers.entries()].map(([source, count]) => ({ source, count }));
    let state = 'stopped';
    if (started && !enabled) state = 'disabled';
    else if (idleTriggered) state = 'idle';
    else if (started && activeBlockers.length > 0) state = 'blocked';
    else if (started && busyProbeNames.length > 0) state = 'busy';
    else if (started) state = 'countdown';
    return {
      enabled,
      state,
      timeoutMs,
      lastActivityAt: lastActivityAtMs === null ? null : new Date(lastActivityAtMs).toISOString(),
      lastActivityReason,
      idleDeadlineAt: idleDeadlineAtMs === null ? null : new Date(idleDeadlineAtMs).toISOString(),
      blockers: activeBlockers,
      busyProbes: [...busyProbeNames],
    };
  }

  return {
    acquire,
    registerProbe,
    start,
    status,
    stop,
    touch,
  };
}

module.exports = {
  DEFAULT_BUSY_POLL_INTERVAL_MS,
  DEFAULT_RUNTIME_IDLE_TIMEOUT_MS,
  createRuntimeIdleController,
};
