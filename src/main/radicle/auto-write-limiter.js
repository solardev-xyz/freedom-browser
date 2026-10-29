/**
 * Rate limit for Radicle COB writes a site's "always allow writes" rule
 * answers without a prompt (R-6).
 *
 * Per origin: a burst of BURST writes, then one more per REFILL_MS, and at
 * most DAILY_MAX in any rolling DAY_MS. A write the limit refuses is not
 * lost: the provider falls back to the per-write prompt, and a write the
 * user approves there is not counted.
 *
 * In memory: the counts start again when the browser restarts.
 */

const LIMITS = Object.freeze({
  BURST: 5,
  REFILL_MS: 30 * 1000,
  DAILY_MAX: 50,
  DAY_MS: 24 * 60 * 60 * 1000,
});

function createAutoWriteLimiter({ now = () => Date.now(), limits = LIMITS } = {}) {
  // origin -> { tokens, at, recent: timestamps of admitted writes }
  const origins = new Map();

  function stateFor(origin, time) {
    let state = origins.get(origin);
    if (!state) {
      state = { tokens: limits.BURST, at: time, recent: [] };
      origins.set(origin, state);
    }
    state.tokens = Math.min(
      limits.BURST,
      state.tokens + Math.max(0, time - state.at) / limits.REFILL_MS
    );
    state.at = time;
    while (state.recent.length && time - state.recent[0] >= limits.DAY_MS) {
      state.recent.shift();
    }
    return state;
  }

  /**
   * Count one automatic write for `origin` if the limit allows it.
   * @param {string} origin - normalized origin
   * @returns {boolean} whether the write may go ahead without a prompt
   */
  function admit(origin) {
    const time = now();
    const state = stateFor(origin, time);
    if (state.tokens < 1 || state.recent.length >= limits.DAILY_MAX) return false;
    state.tokens -= 1;
    state.recent.push(time);
    return true;
  }

  return {
    admit,
    forget: (origin) => origins.delete(origin),
    reset: () => origins.clear(),
  };
}

module.exports = { createAutoWriteLimiter, LIMITS };
