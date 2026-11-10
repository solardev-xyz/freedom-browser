/**
 * Rate limit for Radicle COB writes a site's "always allow writes" rule
 * answers without a prompt (R-6).
 *
 * Per origin: a burst of BURST writes, then one more per REFILL_MS, and at
 * most DAILY_MAX in any rolling DAY_MS. A write the limit refuses is not
 * lost: the provider falls back to the per-write prompt, and a write the
 * user approves there is not counted. An admitted write refused for
 * invalid params (nothing signed) gives its token and daily slot back
 * through the refund admit() returns; every other failure, an unknown repo
 * included, keeps its charge, so a site can't retry one forever for free.
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
   * Count one automatic write for `origin` if the limit allows it. The
   * charge is taken now, before the write runs, so concurrent writes can't
   * all pass on the same unspent budget.
   * @param {string} origin - normalized origin
   * @returns {Function|null} null when the write needs a prompt; otherwise
   *   a refund() that returns the token and daily slot (once) — for a write
   *   that failed without signing anything.
   */
  function admit(origin) {
    const time = now();
    const state = stateFor(origin, time);
    if (state.tokens < 1 || state.recent.length >= limits.DAILY_MAX) return null;
    state.tokens -= 1;
    state.recent.push(time);
    let refunded = false;
    return function refund() {
      if (refunded) return;
      refunded = true;
      // forget() (a disconnect) since admit: the slate is already clean.
      if (origins.get(origin) !== state) return;
      const index = state.recent.indexOf(time);
      if (index !== -1) state.recent.splice(index, 1);
      state.tokens = Math.min(limits.BURST, state.tokens + 1);
    };
  }

  return {
    admit,
    forget: (origin) => origins.delete(origin),
    reset: () => origins.clear(),
  };
}

module.exports = { createAutoWriteLimiter, LIMITS };
