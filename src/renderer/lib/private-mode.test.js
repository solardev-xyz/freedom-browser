/**
 * PRIVATE MODE GUARD coverage (renderer): the private-mode module is the
 * single source of truth the browsing code keys its write guards off —
 * history recording, favicon caching, and autocomplete learning.
 */

describe('private-mode', () => {
  let privateMode;

  beforeAll(async () => {
    global.window = global.window || {};
    privateMode = await import('./private-mode.js');
  });

  afterEach(() => {
    // Reset to a normal window between tests.
    privateMode.initPrivateMode('');
  });

  describe('parsePrivatePartition', () => {
    test('extracts a well-formed private partition', () => {
      expect(
        privateMode.parsePrivatePartition('?privatePartition=private-123e4567-e89b-12d3-a456-1')
      ).toBe('private-123e4567-e89b-12d3-a456-1');
    });

    test('coexists with other query parameters (initialUrl)', () => {
      expect(
        privateMode.parsePrivatePartition(
          '?initialUrl=https%3A%2F%2Fexample.com&privatePartition=private-abc'
        )
      ).toBe('private-abc');
    });

    test('rejects values without the private- prefix', () => {
      expect(privateMode.parsePrivatePartition('?privatePartition=persist:main')).toBe(null);
      expect(privateMode.parsePrivatePartition('?privatePartition=whatever')).toBe(null);
    });

    test('returns null for normal windows', () => {
      expect(privateMode.parsePrivatePartition('')).toBe(null);
      expect(privateMode.parsePrivatePartition('?initialUrl=x')).toBe(null);
      expect(privateMode.parsePrivatePartition(undefined)).toBe(null);
    });
  });

  describe('guards in a normal window', () => {
    test('everything is allowed', () => {
      privateMode.initPrivateMode('');
      expect(privateMode.isPrivateWindow()).toBe(false);
      expect(privateMode.getPrivatePartition()).toBe(null);
      expect(privateMode.shouldRecordHistory()).toBe(true);
      expect(privateMode.shouldCacheFavicons()).toBe(true);
      expect(privateMode.shouldLearnAutocomplete()).toBe(true);
    });
  });

  describe('guards in a private window', () => {
    beforeEach(() => {
      privateMode.initPrivateMode('?privatePartition=private-test');
    });

    test('window identifies as private with its partition', () => {
      expect(privateMode.isPrivateWindow()).toBe(true);
      expect(privateMode.getPrivatePartition()).toBe('private-test');
    });

    test('history recording is blocked', () => {
      expect(privateMode.shouldRecordHistory()).toBe(false);
    });

    test('favicon caching is blocked', () => {
      expect(privateMode.shouldCacheFavicons()).toBe(false);
    });

    test('autocomplete learning is blocked', () => {
      expect(privateMode.shouldLearnAutocomplete()).toBe(false);
    });
  });
});
