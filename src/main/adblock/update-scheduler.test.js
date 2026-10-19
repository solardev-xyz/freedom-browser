jest.mock('../settings-store', () => ({ loadSettings: jest.fn() }));
jest.mock('./feed-config', () => ({ isTrustAnchorConfigured: jest.fn() }));
jest.mock('./update-manager', () => ({ runUpdateOnce: jest.fn() }));

const { loadSettings } = require('../settings-store');
const { isTrustAnchorConfigured } = require('./feed-config');
const { runUpdateOnce } = require('./update-manager');
const {
  installAdblockUpdater,
  INITIAL_DELAY_MS,
  PERIOD_MS,
  RETRY_DELAY_MS,
  _tick,
  _updatesEnabled,
  _clearTimers,
} = require('./update-scheduler');

beforeEach(() => {
  isTrustAnchorConfigured.mockReturnValue(true);
  loadSettings.mockReturnValue({ adblockEnabled: true, adblockAutoUpdate: true });
  runUpdateOnce.mockReset().mockResolvedValue({ status: 'applied', version: 2 });
});

describe('updatesEnabled gating', () => {
  test('requires anchor + adblockEnabled + adblockAutoUpdate', () => {
    expect(_updatesEnabled()).toBe(true);

    isTrustAnchorConfigured.mockReturnValue(false);
    expect(_updatesEnabled()).toBe(false);
    isTrustAnchorConfigured.mockReturnValue(true);

    loadSettings.mockReturnValue({ adblockEnabled: false, adblockAutoUpdate: true });
    expect(_updatesEnabled()).toBe(false);

    loadSettings.mockReturnValue({ adblockEnabled: true, adblockAutoUpdate: false });
    expect(_updatesEnabled()).toBe(false);
  });

  test('treats missing adblockAutoUpdate as enabled (on by default)', () => {
    loadSettings.mockReturnValue({ adblockEnabled: true });
    expect(_updatesEnabled()).toBe(true);
  });
});

describe('tick', () => {
  test('runs an update cycle when enabled', async () => {
    await _tick();
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);
  });

  test('does nothing when disabled', async () => {
    loadSettings.mockReturnValue({ adblockEnabled: false });
    const result = await _tick();
    expect(runUpdateOnce).not.toHaveBeenCalled();
    expect(result).toBe(null);
  });

  test('swallows a failing cycle', async () => {
    runUpdateOnce.mockRejectedValue(new Error('boom'));
    const result = await _tick();
    expect(result).toEqual({ status: 'error', reason: 'boom' });
  });
});

describe('scheduling', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    _clearTimers();
    jest.useRealTimers();
  });

  // A check that hangs until the test settles it with finish(result).
  function holdNextCheck() {
    const held = {};
    runUpdateOnce.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          held.finish = resolve;
        })
    );
    return held;
  }

  test('checks once after the warm-up delay, then once per period', async () => {
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1);
    expect(runUpdateOnce).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(PERIOD_MS - 1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
  });

  test.each([
    [
      'the feed was unreachable',
      () => runUpdateOnce.mockResolvedValueOnce({ status: 'feed_unavailable' }),
    ],
    [
      'a list download failed',
      () => runUpdateOnce.mockResolvedValueOnce({ status: 'download_failed', reason: 'ads' }),
    ],
    ['the cycle threw', () => runUpdateOnce.mockRejectedValueOnce(new Error('boom'))],
  ])('retries well before the period when %s', async (_label, failOnce) => {
    failOnce();
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(RETRY_DELAY_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
    // The retry landed: back to the regular period.
    await jest.advanceTimersByTimeAsync(PERIOD_MS - 1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(3);
  });

  test('a rejected manifest waits for the regular period', async () => {
    runUpdateOnce.mockResolvedValue({ status: 'rejected', reason: 'not_newer' });
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS + RETRY_DELAY_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(PERIOD_MS - RETRY_DELAY_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
  });

  test('never starts a check while one is still running', async () => {
    const held = holdNextCheck();
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS + 3 * PERIOD_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);

    held.finish({ status: 'applied', version: 3 });
    await jest.advanceTimersByTimeAsync(PERIOD_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
  });

  test('stops for good when cleared while a check is running', async () => {
    const held = holdNextCheck();
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    _clearTimers(); // will-quit
    held.finish({ status: 'feed_unavailable' });
    await jest.advanceTimersByTimeAsync(2 * PERIOD_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);
  });

  test('a reinstall while a check is running leaves a single chain of checks', async () => {
    const held = holdNextCheck();
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    installAdblockUpdater();
    held.finish({ status: 'applied', version: 3 });

    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
    // The first chain's next check would land PERIOD_MS after its own, which
    // is before the second chain's.
    await jest.advanceTimersByTimeAsync(PERIOD_MS - 1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(3);
  });

  test('a reinstall mid-check waits for the old check before running its first', async () => {
    const held = holdNextCheck();
    installAdblockUpdater();
    await jest.advanceTimersByTimeAsync(INITIAL_DELAY_MS);
    installAdblockUpdater();
    // The new chain comes due while the old check is still running.
    await jest.advanceTimersByTimeAsync(2 * INITIAL_DELAY_MS);
    expect(runUpdateOnce).toHaveBeenCalledTimes(1);

    held.finish({ status: 'applied', version: 3 });
    await jest.advanceTimersByTimeAsync(0);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
    // Still one chain: the next check is a full period after that one.
    await jest.advanceTimersByTimeAsync(PERIOD_MS - 1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(runUpdateOnce).toHaveBeenCalledTimes(3);
  });
});
