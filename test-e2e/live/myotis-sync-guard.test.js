// Unit coverage for the live Myotis spec's stall guard. The spec itself needs
// a real addon and a live network; this pins the pure decision logic — budget
// coherence and what counts as beacon sync progress — so a regression shows up
// in the fast unit suite instead of in a 25-minute live job.
const {
  DEFAULT_READY_TIMEOUT_MINUTES,
  DEFAULT_STALL_TIMEOUT_MINUTES,
  envFlagEnabled,
  resolveTimeoutBudgets,
  syncProgressKey,
  createStallTracker,
} = require('./myotis-sync-guard');

const MIN = 60 * 1000;

describe('myotis stall guard budgets', () => {
  test('the defaults leave the stall guard reachable (stall < ready)', () => {
    expect(DEFAULT_STALL_TIMEOUT_MINUTES).toBeLessThan(DEFAULT_READY_TIMEOUT_MINUTES);
    const budgets = resolveTimeoutBudgets({});
    expect(budgets).toEqual({
      readyTimeoutMinutes: DEFAULT_READY_TIMEOUT_MINUTES,
      stallTimeoutMinutes: DEFAULT_STALL_TIMEOUT_MINUTES,
      warning: null,
    });
    expect(budgets.stallTimeoutMinutes).toBeLessThan(budgets.readyTimeoutMinutes);
  });

  test("CI's readiness override keeps the invariant", () => {
    const budgets = resolveTimeoutBudgets({ MYOTIS_E2E_READY_TIMEOUT_MIN: '25' });
    expect(budgets.readyTimeoutMinutes).toBe(25);
    expect(budgets.stallTimeoutMinutes).toBe(DEFAULT_STALL_TIMEOUT_MINUTES);
    expect(budgets.warning).toBeNull();
  });

  test('explicit overrides are honoured', () => {
    expect(
      resolveTimeoutBudgets({
        MYOTIS_E2E_READY_TIMEOUT_MIN: '25',
        MYOTIS_E2E_STALL_TIMEOUT_MIN: '2',
      })
    ).toEqual({ readyTimeoutMinutes: 25, stallTimeoutMinutes: 2, warning: null });
  });

  test.each([
    ['', ''],
    ['0', '0'],
    ['-1', 'nonsense'],
  ])('unusable values (%p/%p) fall back to the defaults', (ready, stall) => {
    const budgets = resolveTimeoutBudgets({
      MYOTIS_E2E_READY_TIMEOUT_MIN: ready,
      MYOTIS_E2E_STALL_TIMEOUT_MIN: stall,
    });
    expect(budgets.readyTimeoutMinutes).toBe(DEFAULT_READY_TIMEOUT_MINUTES);
    expect(budgets.stallTimeoutMinutes).toBe(DEFAULT_STALL_TIMEOUT_MINUTES);
    expect(budgets.warning).toBeNull();
  });

  test('an inverted explicit pair warns that the guard is unreachable', () => {
    const budgets = resolveTimeoutBudgets({
      MYOTIS_E2E_READY_TIMEOUT_MIN: '5',
      MYOTIS_E2E_STALL_TIMEOUT_MIN: '6',
    });
    expect(budgets.warning).toMatch(/stall guard cannot fire/);
  });

  test('equal budgets warn too — the guard never gets a chance to fire', () => {
    expect(
      resolveTimeoutBudgets({
        MYOTIS_E2E_READY_TIMEOUT_MIN: '5',
        MYOTIS_E2E_STALL_TIMEOUT_MIN: '5',
      }).warning
    ).toMatch(/stall guard cannot fire/);
  });
});

describe('envFlagEnabled', () => {
  test.each(['1', 'true', 'yes', ' 1 '])('%p enables', (raw) => {
    expect(envFlagEnabled('FLAG', { FLAG: raw })).toBe(true);
  });

  // `set FLAG=0 && npm ci` on Windows captures the trailing space.
  test.each([undefined, '', '  ', '0', '0 ', 'false', 'FALSE', ' false '])(
    '%p does not enable',
    (raw) => {
      expect(envFlagEnabled('FLAG', { FLAG: raw })).toBe(false);
    }
  );
});

describe('syncProgressKey', () => {
  test('is inert with no status and once the beacon is SYNCED', () => {
    expect(syncProgressKey(null)).toBeNull();
    expect(syncProgressKey(undefined)).toBeNull();
    // The post-sync EL peer hunt legitimately freezes the period for minutes.
    expect(
      syncProgressKey({ beaconState: 'SYNCED', currentPeriod: 1845, finalizedSlot: 15065024 })
    ).toBeNull();
  });

  test('keys on catch-up position only, not on beaconState', () => {
    const catching = { beaconState: 'CATCHING_UP', currentPeriod: 1840, finalizedSlot: 15065024 };
    const syncing = { beaconState: 'SYNCING', currentPeriod: 1840, finalizedSlot: 15065024 };
    expect(syncProgressKey(catching)).toBe(syncProgressKey(syncing));
    expect(syncProgressKey({ ...catching, currentPeriod: 1841 })).not.toBe(
      syncProgressKey(catching)
    );
    expect(syncProgressKey({ ...catching, finalizedSlot: 15065025 })).not.toBe(
      syncProgressKey(catching)
    );
  });
});

describe('createStallTracker', () => {
  const wedged = { beaconState: 'CATCHING_UP', currentPeriod: 1840, finalizedSlot: 15065024 };

  test('accumulates stall time while the catch-up position is frozen', () => {
    const tracker = createStallTracker(0);
    expect(tracker.update(wedged, 0)).toBe(0);
    expect(tracker.update(wedged, 2 * MIN)).toBe(2 * MIN);
    expect(tracker.update(wedged, 4 * MIN)).toBe(4 * MIN);
  });

  test('advancing the period resets the clock', () => {
    const tracker = createStallTracker(0);
    tracker.update(wedged, 0);
    expect(tracker.update(wedged, 2 * MIN)).toBe(2 * MIN);
    expect(tracker.update({ ...wedged, currentPeriod: 1841 }, 2 * MIN)).toBe(0);
  });

  test('moving toward SYNCED counts as progress', () => {
    const tracker = createStallTracker(0);
    const syncing = { ...wedged, beaconState: 'SYNCING' };
    expect(tracker.update(syncing, 0)).toBe(0);
    expect(tracker.update(syncing, 2 * MIN)).toBe(2 * MIN);
    // SYNCING -> CATCHING_UP is real forward movement even with a frozen period.
    expect(tracker.update(wedged, 2 * MIN)).toBe(0);
  });

  // The regression this guard's key rewrite exists for: a wedge that flips
  // between two pre-SYNCED states with a frozen position must not keep
  // resetting the timer.
  test('oscillating between pre-SYNCED states does not reset the clock', () => {
    const tracker = createStallTracker(0);
    tracker.update(wedged, 0);
    tracker.update({ ...wedged, beaconState: 'SYNCING' }, 1 * MIN);
    expect(tracker.update(wedged, 2 * MIN)).toBe(2 * MIN);
    expect(tracker.update({ ...wedged, beaconState: 'SYNCING' }, 3 * MIN)).toBe(3 * MIN);
    expect(tracker.update(wedged, 4 * MIN)).toBe(4 * MIN);
  });

  test('an unknown beaconState never counts as progress on its own', () => {
    const tracker = createStallTracker(0);
    tracker.update(wedged, 0);
    expect(tracker.update({ ...wedged, beaconState: 'BACKOFF' }, 3 * MIN)).toBe(3 * MIN);
  });

  test('goes inert once SYNCED, and restarts cleanly if the beacon falls back', () => {
    const tracker = createStallTracker(0);
    tracker.update(wedged, 0);
    expect(tracker.update({ ...wedged, beaconState: 'SYNCED' }, 2 * MIN)).toBeNull();
    // A long EL peer hunt at SYNCED must never accrue stall time.
    expect(tracker.update({ ...wedged, beaconState: 'SYNCED' }, 20 * MIN)).toBeNull();
    expect(tracker.update(wedged, 20 * MIN)).toBe(0);
  });

  test('no status at all (manager not started yet) is inert', () => {
    const tracker = createStallTracker(0);
    expect(tracker.update(null, 5 * MIN)).toBeNull();
    expect(tracker.update(wedged, 5 * MIN)).toBe(0);
  });
});
