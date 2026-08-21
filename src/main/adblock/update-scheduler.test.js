jest.mock('../settings-store', () => ({ loadSettings: jest.fn() }));
jest.mock('./feed-config', () => ({ isTrustAnchorConfigured: jest.fn() }));
jest.mock('./update-manager', () => ({ runUpdateOnce: jest.fn() }));

const { loadSettings } = require('../settings-store');
const { isTrustAnchorConfigured } = require('./feed-config');
const { runUpdateOnce } = require('./update-manager');
const { _tick, _updatesEnabled } = require('./update-scheduler');

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
