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
const mockGetStorageCost = jest.fn();
const mockBuyStorage = jest.fn();
const mockGetWalletBalance = jest.fn();
const mockGetDurationExtensionCost = jest.fn();
const mockGetSizeExtensionCost = jest.fn();
const mockExtendStorageDuration = jest.fn();
const mockExtendStorageSize = jest.fn();
const mockGetChequebookBalance = jest.fn();
const mockDepositTokens = jest.fn();

jest.mock('@ethersphere/bee-js', () => ({
  Bee: jest.fn().mockImplementation(() => ({
    getPostageBatches: mockGetPostageBatches,
    getStorageCost: mockGetStorageCost,
    buyStorage: mockBuyStorage,
    getWalletBalance: mockGetWalletBalance,
    getDurationExtensionCost: mockGetDurationExtensionCost,
    getSizeExtensionCost: mockGetSizeExtensionCost,
    extendStorageDuration: mockExtendStorageDuration,
    extendStorageSize: mockExtendStorageSize,
    getChequebookBalance: mockGetChequebookBalance,
    depositTokens: mockDepositTokens,
  })),
  Size: {
    fromGigabytes: jest.fn((gb) => ({ gb })),
  },
  Duration: {
    fromDays: jest.fn((days) => ({ days })),
  },
}));

jest.mock('../service-registry', () => ({
  getBeeApiUrl: jest.fn().mockReturnValue('http://127.0.0.1:1633'),
}));

jest.mock('electron-log', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

const { normalizeBatch, registerSwarmIpc } = require('./stamp-service');
const { Size, Duration } = require('@ethersphere/bee-js');

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
        usable: true,
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
        usable: false,
        isMutable: false,
        sizeBytes: 1000,
        remainingBytes: 500,
        usagePercent: 50,
        ttlSeconds: 86400,
        expiresApprox: null,
      });
    });

    test('handles empty/undefined fields gracefully', () => {
      const result = normalizeBatch({});
      expect(result.batchId).toBe('');
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
    });

    test('swarm:get-stamps returns normalized batches', async () => {
      mockGetPostageBatches.mockResolvedValue([makeBatch()]);

      const result = await invokeIpc('swarm:get-stamps');
      expect(result.success).toBe(true);
      expect(result.stamps).toHaveLength(1);
      expect(result.stamps[0]).toEqual({
        batchId: 'abc123',
        usable: true,
        isMutable: false,
        sizeBytes: 5368709120,
        remainingBytes: 4000000000,
        usagePercent: 26,
        ttlSeconds: 2592000,
        expiresApprox: '2026-04-14T00:00:00.000Z',
      });
    });

    test('swarm:get-stamps handles errors', async () => {
      mockGetPostageBatches.mockRejectedValue(new Error('Bee not reachable'));

      const result = await invokeIpc('swarm:get-stamps');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Bee not reachable');
    });

    test('swarm:get-storage-cost returns formatted xBZZ', async () => {
      mockGetStorageCost.mockResolvedValue({
        toSignificantDigits: jest.fn().mockReturnValue('0.1234'),
      });

      const result = await invokeIpc('swarm:get-storage-cost', 1, 30);
      expect(result.success).toBe(true);
      expect(result.bzz).toBe('0.1234');
      expect(Size.fromGigabytes).toHaveBeenCalledWith(1);
      expect(Duration.fromDays).toHaveBeenCalledWith(30);
    });

    test('swarm:get-storage-cost rejects zero values', async () => {
      const result = await invokeIpc('swarm:get-storage-cost', 0, 30);
      expect(result.success).toBe(false);
    });

    test('swarm:get-storage-cost rejects string values', async () => {
      const result = await invokeIpc('swarm:get-storage-cost', '1', 30);
      expect(result.success).toBe(false);
    });

    test('swarm:get-storage-cost rejects NaN', async () => {
      const result = await invokeIpc('swarm:get-storage-cost', NaN, 30);
      expect(result.success).toBe(false);
    });

    test('swarm:buy-storage returns batch ID hex string on success', async () => {
      mockBuyStorage.mockResolvedValue({ toHex: () => 'abcdef1234567890' });
      mockGetStorageCost.mockResolvedValue({
        toPLURBigInt: () => 1000n,
        toSignificantDigits: () => '0.001',
      });
      mockGetWalletBalance.mockResolvedValue({
        bzzBalance: { toPLURBigInt: () => 99999999n },
      });

      const result = await invokeIpc('swarm:buy-storage', 1, 30);
      expect(result.success).toBe(true);
      expect(result.batchId).toBe('abcdef1234567890');
      expect(typeof result.batchId).toBe('string');
    });

    test('swarm:buy-storage passes waitForUsable:false and timeout', async () => {
      mockBuyStorage.mockResolvedValue({ toHex: () => 'abc' });
      mockGetStorageCost.mockResolvedValue({
        toPLURBigInt: () => 1000n,
        toSignificantDigits: () => '0.001',
      });
      mockGetWalletBalance.mockResolvedValue({
        bzzBalance: { toPLURBigInt: () => 99999999n },
      });

      await invokeIpc('swarm:buy-storage', 1, 30);
      expect(mockBuyStorage).toHaveBeenCalledWith(
        expect.anything(), // Size
        expect.anything(), // Duration
        expect.objectContaining({ waitForUsable: false }), // PostageBatchOptions
        expect.objectContaining({ timeout: 300000 }) // BeeRequestOptions
      );
    });

    test('swarm:buy-storage rejects when xBZZ balance is insufficient', async () => {
      mockGetStorageCost.mockResolvedValue({
        toPLURBigInt: () => 50000000000000000n, // 0.5 BZZ in PLUR
        toSignificantDigits: () => '0.5',
      });
      mockGetWalletBalance.mockResolvedValue({
        bzzBalance: { toPLURBigInt: () => 10000000000000000n }, // 0.1 BZZ
      });

      const result = await invokeIpc('swarm:buy-storage', 1, 30);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient xBZZ');
    });

    test('swarm:buy-storage proceeds when pre-check cannot determine balance', async () => {
      mockBuyStorage.mockResolvedValue({ toHex: () => 'def' });
      mockGetStorageCost.mockResolvedValue({
        toPLURBigInt: () => 1000n,
        toSignificantDigits: () => '0.001',
      });
      mockGetWalletBalance.mockRejectedValue(new Error('network error'));

      const result = await invokeIpc('swarm:buy-storage', 1, 30);
      expect(result.success).toBe(true);
      expect(result.batchId).toBe('def');
    });

    test('swarm:buy-storage handles purchase failure', async () => {
      mockGetStorageCost.mockResolvedValue({
        toPLURBigInt: () => 1000n,
        toSignificantDigits: () => '0.001',
      });
      mockGetWalletBalance.mockResolvedValue({
        bzzBalance: { toPLURBigInt: () => 99999999n },
      });
      mockBuyStorage.mockRejectedValue(new Error('tx reverted'));

      const result = await invokeIpc('swarm:buy-storage', 1, 30);
      expect(result.success).toBe(false);
      expect(result.error).toBe('tx reverted');
    });

    test('swarm:buy-storage rejects invalid inputs', async () => {
      const result = await invokeIpc('swarm:buy-storage', -1, 30);
      expect(result.success).toBe(false);
    });
  });

  describe('extension IPC handlers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('swarm:get-duration-extension-cost returns formatted xBZZ', async () => {
      mockGetDurationExtensionCost.mockResolvedValue({
        toSignificantDigits: () => '0.05',
      });

      const result = await invokeIpc('swarm:get-duration-extension-cost', 'abc123', 30);
      expect(result.success).toBe(true);
      expect(result.bzz).toBe('0.05');
    });

    test('swarm:get-duration-extension-cost rejects missing batch ID', async () => {
      const result = await invokeIpc('swarm:get-duration-extension-cost', '', 30);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Batch ID');
    });

    test('swarm:get-size-extension-cost returns formatted xBZZ', async () => {
      mockGetSizeExtensionCost.mockResolvedValue({
        toSignificantDigits: () => '0.12',
      });

      const result = await invokeIpc('swarm:get-size-extension-cost', 'abc123', 5);
      expect(result.success).toBe(true);
      expect(result.bzz).toBe('0.12');
    });

    test('swarm:extend-storage-duration returns batch ID', async () => {
      mockExtendStorageDuration.mockResolvedValue({ toHex: () => 'abc123' });

      const result = await invokeIpc('swarm:extend-storage-duration', 'abc123', 30);
      expect(result.success).toBe(true);
      expect(result.batchId).toBe('abc123');
    });

    test('swarm:extend-storage-duration handles errors', async () => {
      mockExtendStorageDuration.mockRejectedValue(new Error('insufficient funds'));

      const result = await invokeIpc('swarm:extend-storage-duration', 'abc123', 30);
      expect(result.success).toBe(false);
      expect(result.error).toBe('insufficient funds');
    });

    test('swarm:extend-storage-size returns batch ID', async () => {
      mockExtendStorageSize.mockResolvedValue({ toHex: () => 'abc123' });

      const result = await invokeIpc('swarm:extend-storage-size', 'abc123', 10);
      expect(result.success).toBe(true);
      expect(result.batchId).toBe('abc123');
    });

    test('swarm:extend-storage-size rejects invalid inputs', async () => {
      const result = await invokeIpc('swarm:extend-storage-size', 'abc123', -5);
      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });
  });

  describe('chequebook deposit IPC handlers', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    test('swarm:deposit-chequebook succeeds when wallet has enough', async () => {
      mockGetWalletBalance.mockResolvedValue({
        bzzBalance: { toPLURBigInt: () => 5000000000000000n }, // 0.5 BZZ
      });
      mockDepositTokens.mockResolvedValue({ toHex: () => 'tx123' });

      const result = await invokeIpc('swarm:deposit-chequebook', 0.1);
      expect(result.success).toBe(true);
      expect(result.transactionId).toBe('tx123');
    });

    test('swarm:deposit-chequebook rejects when wallet balance is insufficient', async () => {
      mockGetWalletBalance.mockResolvedValue({
        bzzBalance: { toPLURBigInt: () => 500000000000000n }, // 0.05 BZZ
      });

      const result = await invokeIpc('swarm:deposit-chequebook', 0.1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Insufficient');
    });

    test('swarm:deposit-chequebook rejects invalid amount', async () => {
      const result = await invokeIpc('swarm:deposit-chequebook', -1);
      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });
  });
});
