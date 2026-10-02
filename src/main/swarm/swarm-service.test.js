var mockGetPostageBatches = jest.fn();

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation((url) => ({
    _testUrl: url,
    stamp: {
      getAll: mockGetPostageBatches,
    },
  })),
}));

jest.mock('../service-registry', () => ({
  getAntApiUrl: jest.fn(),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// The node's raw /stamps, which carries the `propagating` flag bee-js drops.
const mockRawStamps = jest.fn();
jest.mock('./ant-storage-api', () => ({
  getStamps: (...args) => mockRawStamps(...args),
}));

const {
  getBee,
  resetBeeClient,
  selectBestBatch,
  isPendingStamp,
  isPropagatingStamp,
  isFullImmutableStamp,
  batchIdKey,
} = require('./swarm-service');
const { getAntApiUrl } = require('../service-registry');

describe('swarm-service', () => {
  beforeEach(() => {
    resetBeeClient();
  });

  test('creates a Bee client from the service registry URL', () => {
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee = getBee();
    expect(bee._testUrl).toBe('http://127.0.0.1:1633');
  });

  test('throws when the Swarm endpoint is not hydrated', () => {
    getAntApiUrl.mockReturnValue(null);
    expect(() => getBee()).toThrow('Swarm node is not ready');
  });

  test('returns the same client on subsequent calls with the same URL', () => {
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee1 = getBee();
    const bee2 = getBee();
    expect(bee1).toBe(bee2);
  });

  test('recreates the client when the URL changes', () => {
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee1 = getBee();

    getAntApiUrl.mockReturnValue('http://127.0.0.1:1634');
    const bee2 = getBee();

    expect(bee1).not.toBe(bee2);
    expect(bee2._testUrl).toBe('http://127.0.0.1:1634');
  });

  test('resetBeeClient forces a new client on next call', () => {
    getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    const bee1 = getBee();

    resetBeeClient();
    const bee2 = getBee();

    expect(bee1).not.toBe(bee2);
  });

  describe('selectBestBatch', () => {
    const SPACIOUS = 'aa'.repeat(32);
    const FULL_MUTABLE = 'bb'.repeat(32);
    const FULL_IMMUTABLE = 'cc'.repeat(32);

    function makeBatch({ id, usable = true, remainingBytes = 0, ttlSeconds = 0, immutable = false }) {
      return {
        batchID: { toHex: () => id },
        usable,
        immutableFlag: immutable,
        remainingSize: { toBytes: () => remainingBytes },
        duration: { toSeconds: () => ttlSeconds },
      };
    }

    beforeEach(() => {
      mockGetPostageBatches.mockReset();
      mockRawStamps.mockReset();
      mockRawStamps.mockResolvedValue({ ok: true, data: { stamps: [] } });
      getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
    });

    const FRESH = 'ff'.repeat(32);
    const rawStamps = (...stamps) => ({ ok: true, data: { stamps } });

    test('takes a propagating batch with room when no usable batch has room', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: SPACIOUS, remainingBytes: 100, ttlSeconds: 900 }),
        makeBatch({ id: FRESH, usable: false, remainingBytes: 1_000_000, ttlSeconds: 500 }),
      ]);
      mockRawStamps.mockResolvedValue(
        rawStamps({ batchID: FRESH.toUpperCase(), usable: false, propagating: true })
      );

      expect(await selectBestBatch(4096)).toBe(FRESH);
    });

    test('matches a raw listing that writes batch IDs with a 0x prefix', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FRESH, usable: false, remainingBytes: 1_000_000, ttlSeconds: 500 }),
      ]);
      mockRawStamps.mockResolvedValue(
        rawStamps({ batchID: `0x${FRESH.toUpperCase()}`, usable: false, propagating: true })
      );

      expect(await selectBestBatch(4096)).toBe(FRESH);
    });

    test('a usable batch with room wins without reading the raw listing', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: SPACIOUS, remainingBytes: 1_000_000, ttlSeconds: 100 }),
        makeBatch({ id: FRESH, usable: false, remainingBytes: 1_000_000, ttlSeconds: 900 }),
      ]);

      expect(await selectBestBatch(4096)).toBe(SPACIOUS);
      expect(mockRawStamps).not.toHaveBeenCalled();
    });

    test('never takes a not-usable batch the node does not call propagating', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FRESH, usable: false, remainingBytes: 1_000_000, ttlSeconds: 900 }),
      ]);
      mockRawStamps.mockResolvedValue(
        rawStamps({ batchID: FRESH, usable: false, propagating: false })
      );
      expect(await selectBestBatch(4096)).toBeNull();

      // A node without the flag (older Ant, bee) refuses such uploads.
      mockRawStamps.mockResolvedValue(
        rawStamps({ batchID: FRESH, usable: false, exists: true, batchTTL: 900 })
      );
      expect(await selectBestBatch(4096)).toBeNull();

      // Raw listing unreadable: as before the flag existed.
      mockRawStamps.mockResolvedValue({ ok: false, status: 0, data: null, timedOut: true });
      expect(await selectBestBatch(4096)).toBeNull();
    });

    test('a propagating batch without room is not taken', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FRESH, usable: false, remainingBytes: 100, ttlSeconds: 900 }),
      ]);
      mockRawStamps.mockResolvedValue(
        rawStamps({ batchID: FRESH, usable: false, propagating: true })
      );

      expect(await selectBestBatch(4096)).toBeNull();
    });

    test('allowFullMutable prefers a propagating batch with room over overwriting a full one', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FULL_MUTABLE, remainingBytes: 0, ttlSeconds: 900 }),
        makeBatch({ id: FRESH, usable: false, remainingBytes: 1_000_000, ttlSeconds: 100 }),
      ]);
      mockRawStamps.mockResolvedValue(
        rawStamps({ batchID: FRESH, usable: false, propagating: true })
      );

      expect(await selectBestBatch(4096, { allowFullMutable: true })).toBe(FRESH);
    });

    test('prefers the usable batch with room and the longest TTL', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: 'dd'.repeat(32), remainingBytes: 1_000_000, ttlSeconds: 100 }),
        makeBatch({ id: SPACIOUS, remainingBytes: 1_000_000, ttlSeconds: 900 }),
        makeBatch({ id: 'ee'.repeat(32), usable: false, remainingBytes: 1_000_000, ttlSeconds: 9999 }),
      ]);

      expect(await selectBestBatch(4096)).toBe(SPACIOUS);
    });

    test('rejects batches without room for the payload plus safety margin', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: SPACIOUS, remainingBytes: 4096, ttlSeconds: 900 }), // < 4096 * 1.5
      ]);

      expect(await selectBestBatch(4096)).toBeNull();
    });

    test('by default never selects a full mutable batch', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FULL_MUTABLE, remainingBytes: 0, ttlSeconds: 900 }),
      ]);

      expect(await selectBestBatch(4096)).toBeNull();
    });

    test('allowFullMutable falls back to a full mutable batch only when nothing has room', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FULL_MUTABLE, remainingBytes: 0, ttlSeconds: 900 }),
        makeBatch({ id: SPACIOUS, remainingBytes: 1_000_000, ttlSeconds: 100 }),
      ]);
      expect(await selectBestBatch(4096, { allowFullMutable: true })).toBe(SPACIOUS);

      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FULL_MUTABLE, remainingBytes: 0, ttlSeconds: 900 }),
      ]);
      expect(await selectBestBatch(4096, { allowFullMutable: true })).toBe(FULL_MUTABLE);
    });

    test('allowFullMutable never selects a full immutable batch', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ id: FULL_IMMUTABLE, remainingBytes: 0, ttlSeconds: 900, immutable: true }),
      ]);

      expect(await selectBestBatch(4096, { allowFullMutable: true })).toBeNull();
    });
  });

  // Raw /stamps JSON, the node's own shape.
  describe('isFullImmutableStamp and batchIdKey', () => {
    const batch = { usable: true, immutableFlag: true, depth: 20, bucketDepth: 16 };
    test.each([
      ['an immutable batch at its bucket limit', { ...batch, utilization: 16 }, true],
      ['an immutable batch one chunk short', { ...batch, utilization: 15 }, false],
      ['a full mutable batch, which overwrites', { ...batch, immutableFlag: false, utilization: 16 }, false],
      ['a batch without utilization', batch, false],
      ['nothing', null, false],
    ])('%s: full %s', (_, input, full) => {
      expect(isFullImmutableStamp(input)).toBe(full);
    });

    test('compares IDs as bare lower-case hex', () => {
      expect(batchIdKey('0xABcd')).toBe('abcd');
      expect(batchIdKey(' abCD ')).toBe('abcd');
      expect(batchIdKey({ toHex: () => 'EF01' })).toBe('ef01');
      expect(batchIdKey(undefined)).toBe('');
    });
  });

  describe('isPendingStamp and isPropagatingStamp', () => {
    test.each([
      ['usable', { usable: true, propagating: false, exists: true, batchTTL: 900 }, false, false],
      [
        'propagating',
        { usable: false, propagating: true, exists: true, batchTTL: 900 },
        true,
        true,
      ],
      [
        'rejected by peers',
        { usable: false, propagating: false, exists: true, batchTTL: 900 },
        false,
        false,
      ],
      ['expired', { usable: false, propagating: false, exists: true, batchTTL: 0 }, false, false],
      [
        'not on chain',
        { usable: false, propagating: false, exists: false, batchTTL: -1 },
        false,
        false,
      ],
      [
        'no flag, awaiting confirmations',
        { usable: false, exists: true, batchTTL: 900 },
        true,
        false,
      ],
      ['no flag, expired', { usable: false, exists: true, batchTTL: 0 }, false, false],
      ['no flag, not on chain', { usable: false, exists: false, batchTTL: -1 }, false, false],
      ['missing', null, false, false],
    ])('%s: pending %s, propagating %s', (_, batch, pending, propagating) => {
      expect(isPendingStamp(batch)).toBe(pending);
      expect(isPropagatingStamp(batch)).toBe(propagating);
    });
  });
});
