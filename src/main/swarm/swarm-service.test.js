var mockGetPostageBatches = jest.fn();

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation((url) => ({
    _testUrl: url,
    getPostageBatches: mockGetPostageBatches,
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

const { getBee, resetBeeClient, selectBestBatch } = require('./swarm-service');
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
      getAntApiUrl.mockReturnValue('http://127.0.0.1:1633');
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
});
