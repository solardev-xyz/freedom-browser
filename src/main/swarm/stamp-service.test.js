// Capture IPC handlers registered by the stamp service
const ipcHandlers = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
    removeHandler: () => {},
  },
}));

// Mock bee-js
const mockGetPostageBatches = jest.fn();

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({
    stamp: {
      getAll: mockGetPostageBatches,
    },
  })),
}));

jest.mock('../service-registry', () => ({
  getAntApiUrl: jest.fn().mockReturnValue('http://127.0.0.1:1633'),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

// The node's raw /stamps, which carries what bee-js drops.
const mockRawStamps = jest.fn();
jest.mock('./ant-storage-api', () => ({
  getStamps: (...args) => mockRawStamps(...args),
}));

const { normalizeBatch, registerSwarmIpc } = require('./stamp-service');

// Register handlers once
registerSwarmIpc();

async function invokeIpc(channel, ...args) {
  const handler = ipcHandlers[channel];
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler({}, ...args);
}

// Helper to create batch objects that mimic bee-js class instances
function makeBatchId(hex) {
  return { toHex: () => hex, toString: () => hex };
}

function makeBatch(overrides = {}) {
  return {
    batchID: makeBatchId('abc123'),
    depth: 22,
    usable: true,
    immutableFlag: true,
    size: { toBytes: () => 5368709120 },
    remainingSize: { toBytes: () => 4000000000 },
    usage: 0.255,
    duration: { toSeconds: () => 2592000, toEndDate: () => new Date('2026-04-14T00:00:00Z') },
    ...overrides,
  };
}

describe('stamp-service', () => {
  describe('normalizeBatch', () => {
    test('normalizes a bee-js batch using public class methods', () => {
      const batch = makeBatch({ immutableFlag: false });

      expect(normalizeBatch(batch)).toEqual({
        batchId: 'abc123',
        depth: 22,
        usable: true,
        pending: false,
        isMutable: true,
        sizeBytes: 5368709120,
        remainingBytes: 4000000000,
        usagePercent: 26,
        ttlSeconds: 2592000,
        expiresApprox: '2026-04-14T00:00:00.000Z',
      });
    });

    test('treats immutableFlag: true as not mutable', () => {
      const batch = makeBatch({ immutableFlag: true });
      expect(normalizeBatch(batch).isMutable).toBe(false);
    });

    test('falls back to plain numbers when class methods are absent', () => {
      const batch = {
        batchID: 'def456',
        usable: false,
        immutableFlag: true,
        size: 1000,
        remainingSize: 500,
        usage: 0.5,
        duration: 86400,
      };

      expect(normalizeBatch(batch)).toEqual({
        batchId: 'def456',
        depth: null,
        usable: false,
        pending: false,
        isMutable: false,
        sizeBytes: 1000,
        remainingBytes: 500,
        usagePercent: 50,
        ttlSeconds: 86400,
        expiresApprox: null,
      });
    });

    // bee-js drops `exists` and `propagating` and clamps an expired batchTTL
    // to 1, so these batches look alike to it; the node's raw entry decides.
    test.each([
      [
        'propagating (Ant v0.5.52+)',
        { usable: false, propagating: true, exists: true, batchTTL: 2592000 },
        true,
      ],
      [
        'rejected by peers',
        { usable: false, propagating: false, exists: true, batchTTL: 2592000 },
        false,
      ],
      ['expired', { usable: false, propagating: false, exists: true, batchTTL: 0 }, false],
      ['not on chain', { usable: false, propagating: false, exists: false, batchTTL: -1 }, false],
      [
        'awaiting confirmations (no flag)',
        { usable: false, exists: true, batchTTL: 2592000 },
        true,
      ],
      ['expired (no flag)', { usable: false, exists: true, batchTTL: 0 }, false],
      ['not on chain (no flag)', { usable: false, exists: false, batchTTL: -1 }, false],
    ])('a not-usable batch the node reports as %s: pending is %s', (_, raw, pending) => {
      const beeJs = makeBatch({ usable: false, duration: { toSeconds: () => 1 } });
      expect(normalizeBatch(beeJs, raw).pending).toBe(pending);
    });

    test('a not-usable batch without a raw entry is not pending', () => {
      expect(normalizeBatch(makeBatch({ usable: false })).pending).toBe(false);
    });

    test('a usable batch is never pending', () => {
      expect(normalizeBatch(makeBatch(), { usable: true, propagating: true }).pending).toBe(false);
    });

    test('handles empty/undefined fields gracefully', () => {
      const result = normalizeBatch({});
      expect(result.batchId).toBe('');
      expect(result.depth).toBeNull();
      expect(result.usable).toBe(false);
      expect(result.isMutable).toBe(false);
      expect(result.sizeBytes).toBe(0);
      expect(result.remainingBytes).toBe(0);
      expect(result.usagePercent).toBe(0);
      expect(result.ttlSeconds).toBe(0);
      expect(result.expiresApprox).toBeNull();
    });
  });

  describe('IPC handlers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
      mockRawStamps.mockResolvedValue({ ok: true, data: { stamps: [] } });
    });

    test('swarm:get-stamps returns normalized batches', async () => {
      mockGetPostageBatches.mockResolvedValue([makeBatch()]);

      const result = await invokeIpc('swarm:get-stamps');
      expect(result.success).toBe(true);
      expect(result.stamps).toHaveLength(1);
      expect(result.stamps[0]).toEqual({
        batchId: 'abc123',
        depth: 22,
        usable: true,
        pending: false,
        isMutable: false,
        sizeBytes: 5368709120,
        remainingBytes: 4000000000,
        usagePercent: 26,
        ttlSeconds: 2592000,
        expiresApprox: '2026-04-14T00:00:00.000Z',
      });
    });

    test('swarm:get-stamps reads pending from the raw /stamps entry with the same ID', async () => {
      mockGetPostageBatches.mockResolvedValue([
        makeBatch({ batchID: makeBatchId('aa11'), usable: false }),
        makeBatch({ batchID: makeBatchId('bb22'), usable: false }),
      ]);
      mockRawStamps.mockResolvedValue({
        ok: true,
        data: {
          stamps: [
            { batchID: 'AA11', usable: false, propagating: true },
            { batchID: 'bb22', usable: false, propagating: false },
          ],
        },
      });

      const result = await invokeIpc('swarm:get-stamps');
      expect(result.stamps.map((b) => [b.batchId, b.pending])).toEqual([
        ['aa11', true],
        ['bb22', false],
      ]);
    });

    test('swarm:get-stamps still lists batches when the raw /stamps read fails', async () => {
      mockGetPostageBatches.mockResolvedValue([makeBatch({ usable: false })]);
      mockRawStamps.mockResolvedValue({ ok: false, status: 0, data: null, timedOut: true });

      const result = await invokeIpc('swarm:get-stamps');
      expect(result.success).toBe(true);
      expect(result.stamps[0]).toMatchObject({ batchId: 'abc123', usable: false, pending: false });
    });

    test('swarm:get-stamps handles errors', async () => {
      mockGetPostageBatches.mockRejectedValue(new Error('Bee not reachable'));

      const result = await invokeIpc('swarm:get-stamps');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Bee not reachable');
    });

    // Buying, extending and the chequebook deposit moved to the node's xDAI
    // storage routes (publish-setup-service.js); the bee-js paths are gone.
    test.each([
      'swarm:get-storage-cost',
      'swarm:buy-storage',
      'swarm:get-duration-extension-cost',
      'swarm:get-size-extension-cost',
      'swarm:extend-storage-duration',
      'swarm:extend-storage-size',
      'swarm:get-chequebook-balance',
      'swarm:deposit-chequebook',
    ])('registers no %s handler', (channel) => {
      expect(ipcHandlers[channel]).toBeUndefined();
    });
  });
});
