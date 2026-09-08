// Budget resolution and beacon-sync stall detection for the live Myotis E2E
// spec. Kept in its own module rather than inline in `myotis-ens.spec.js` so
// the pure logic is unit-testable: playwright only loads `*.spec.js` and jest
// only loads `*.test.js`, so the two harnesses never trip over each other.
'use strict';

// Budgets, in minutes.
//
// INVARIANT: the stall window must stay strictly BELOW the readiness window.
// The stall guard can only fire from inside a readiness wait, so a stall
// budget >= the readiness budget makes the guard unreachable: a wedged client
// burns the whole readiness budget and then fails with the generic "never
// served a verified read" message, losing the wedge diagnostics and the
// issue #200 pointer that are the entire point of the guard. This held for
// the original defaults (6 min stall vs. a 5 min ready default), which is why
// the stall default is now 3. `resolveTimeoutBudgets()` reports a warning when
// an explicit MYOTIS_E2E_* pair inverts the relationship, and
// `myotis-sync-guard.test.js` asserts it for the defaults.
//
// 3 min is measured, not guessed: the one successful cold sync applied nine
// beacon periods in 15 s, and a forced wedge repro fired this guard cleanly at
// a 2 min window with no false trigger across the SYNCING -> CATCHING_UP
// transition. CI raises only the readiness side (MYOTIS_E2E_READY_TIMEOUT_MIN
// 25) and leaves the stall default in place.
const DEFAULT_READY_TIMEOUT_MINUTES = 5;
const DEFAULT_STALL_TIMEOUT_MINUTES = 3;

// `set X=0 && npm ci` on Windows captures the trailing space into the value,
// so compare the trimmed string — an untrimmed `raw !== '0'` reads '0 ' as on.
function envFlagEnabled(name, env = process.env) {
  const raw = env[name];
  if (typeof raw !== 'string') return false;
  const value = raw.trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

function positiveMinutes(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveTimeoutBudgets(env = process.env) {
  const readyTimeoutMinutes = positiveMinutes(
    env.MYOTIS_E2E_READY_TIMEOUT_MIN,
    DEFAULT_READY_TIMEOUT_MINUTES
  );
  const stallTimeoutMinutes = positiveMinutes(
    env.MYOTIS_E2E_STALL_TIMEOUT_MIN,
    DEFAULT_STALL_TIMEOUT_MINUTES
  );
  const warning =
    stallTimeoutMinutes >= readyTimeoutMinutes
      ? `[myotis-e2e] MYOTIS_E2E_STALL_TIMEOUT_MIN (${stallTimeoutMinutes} min) is not below ` +
        `MYOTIS_E2E_READY_TIMEOUT_MIN (${readyTimeoutMinutes} min): the beacon stall guard ` +
        'cannot fire, so a wedged sync will burn the full readiness budget instead of ' +
        'aborting with sync diagnostics.'
      : null;
  return { readyTimeoutMinutes, stallTimeoutMinutes, warning };
}

// beaconState values the addon reports, ordered by how far the light client
// has come. Only movement *toward* SYNCED counts as progress; an unknown state
// ranks 0 so a future addon's novel state can never be mistaken for progress.
const BEACON_STATE_RANK = { SYNCING: 1, CATCHING_UP: 2, SYNCED: 3 };
const SYNCED_STATE = 'SYNCED';

function beaconStateRank(state) {
  return Object.prototype.hasOwnProperty.call(BEACON_STATE_RANK, state)
    ? BEACON_STATE_RANK[state]
    : 0;
}

// Identity of the light client's catch-up position, or null when the stall
// guard does not apply. Once the beacon is SYNCED the period legitimately
// stops moving for many minutes while the execution layer hunts a snap peer
// (17 of the 18 min in the one successful cold run), so the guard deliberately
// watches only the pre-SYNCED phase.
//
// beaconState is deliberately NOT part of this key. It used to be, which meant
// a wedge oscillating between two pre-SYNCED states (CATCHING_UP <-> a backoff
// SYNCING, say) with frozen currentPeriod/finalizedSlot reset the stall timer
// on every flip and evaded the guard, degrading to the full readiness budget.
// The observed v0.1.7 wedge holds CATCHING_UP steadily so that was only a
// theoretical degradation mode, but making the key robust is cheap: position
// alone identifies progress, and `createStallTracker()` credits a beaconState
// change as progress only when it advances toward SYNCED.
function syncProgressKey(status) {
  if (!status || status.beaconState === SYNCED_STATE) return null;
  return `${status.currentPeriod}:${status.finalizedSlot}`;
}

// Tracks how long the beacon light client has been frozen. Progress is either
// the catch-up position moving or beaconState advancing toward SYNCED; a
// backslide to an earlier state is not progress and leaves the clock running.
function createStallTracker(startedAt) {
  let key = null;
  let bestRank = -1;
  let progressAt = startedAt;
  return {
    // Returns ms since the last observed progress, or null when the guard does
    // not apply (no status yet, or the beacon is already SYNCED).
    update(status, at) {
      const nextKey = syncProgressKey(status);
      const advanced = beaconStateRank(status && status.beaconState) > bestRank;
      if (advanced) bestRank = beaconStateRank(status && status.beaconState);
      if (nextKey === null) {
        key = null;
        progressAt = at;
        return null;
      }
      if (nextKey !== key || advanced) {
        key = nextKey;
        progressAt = at;
      }
      return at - progressAt;
    },
  };
}

module.exports = {
  DEFAULT_READY_TIMEOUT_MINUTES,
  DEFAULT_STALL_TIMEOUT_MINUTES,
  BEACON_STATE_RANK,
  envFlagEnabled,
  resolveTimeoutBudgets,
  syncProgressKey,
  createStallTracker,
};
