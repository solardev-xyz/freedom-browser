// Mock electron ipcMain before requiring ens-resolver
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

// Mock settings-store
const mockLoadSettings = jest.fn(() => ({ enableEnsCustomRpc: false, ensRpcUrl: '' }));
jest.mock('./settings-store', () => ({
  loadSettings: (...args) => mockLoadSettings(...args),
}));

// Mock ethers with controllable provider and resolver behavior
const mockGetBlockNumber = jest.fn();
const mockDestroy = jest.fn();
const mockGetResolver = jest.fn();

jest.mock('ethers', () => ({
  ethers: {
    JsonRpcProvider: jest.fn().mockImplementation(() => ({
      getBlockNumber: mockGetBlockNumber,
      getResolver: mockGetResolver,
      destroy: mockDestroy,
    })),
  },
}));

const { ethers } = require('ethers');
const { resolveEnsContent, testRpcUrl, invalidateCachedProvider } = require('./ens-resolver');

beforeEach(() => {
  jest.clearAllMocks();
  invalidateCachedProvider();
  // Default: provider connects successfully
  mockGetBlockNumber.mockResolvedValue(12345678);
  // Default: resolver returns null (no resolver found)
  mockGetResolver.mockResolvedValue(null);
  // Default: no custom RPC
  mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: false, ensRpcUrl: '' });
});

describe('ens-resolver', () => {
  describe('.box domain resolution', () => {
    test('resolves .box domain with IPFS content hash', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest
          .fn()
          .mockResolvedValue('ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG'),
        address: '0xF97aAc6C8dbaEBCB54ff166d79706E3AF7a813c8',
      });

      const result = await resolveEnsContent('fleek.box');
      expect(result).toEqual({
        type: 'ok',
        name: 'fleek.box',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: 'ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
        decoded: 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG',
      });
    });

    test('resolves .box domain with Swarm content hash', async () => {
      const swarmHash = 'a'.repeat(64);
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue(`bzz://${swarmHash}`),
        address: '0xF97aAc6C8dbaEBCB54ff166d79706E3AF7a813c8',
      });

      const result = await resolveEnsContent('mysite.box');
      expect(result).toEqual({
        type: 'ok',
        name: 'mysite.box',
        codec: 'swarm-ns',
        protocol: 'bzz',
        uri: `bzz://${swarmHash}`,
        decoded: swarmHash,
      });
    });

    test('resolves .box domain with IPNS content hash', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest
          .fn()
          .mockResolvedValue(
            'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3lg7ekjjnof1ock2yxz7p8q1qf2v9o'
          ),
        address: '0xF97aAc6C8dbaEBCB54ff166d79706E3AF7a813c8',
      });

      const result = await resolveEnsContent('dynamic.box');
      expect(result).toEqual({
        type: 'ok',
        name: 'dynamic.box',
        codec: 'ipns-ns',
        protocol: 'ipns',
        uri: 'ipns://k51qzi5uqu5dlvj2baxnqndepeb86cbk3lg7ekjjnof1ock2yxz7p8q1qf2v9o',
        decoded: 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3lg7ekjjnof1ock2yxz7p8q1qf2v9o',
      });
    });

    test('returns not_found when .box domain has no resolver', async () => {
      mockGetResolver.mockResolvedValue(null);

      const result = await resolveEnsContent('unregistered.box');
      expect(result.type).toBe('not_found');
      expect(result.reason).toBe('NO_RESOLVER');
      expect(result.name).toBe('unregistered.box');
    });

    test('returns not_found when .box domain has no content hash (CCIP 404)', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest
          .fn()
          .mockRejectedValue(
            new Error(
              'response not found during CCIP fetch: 3dnsService:: InvalidParameters: CCIP_001'
            )
          ),
        address: '0xF97aAc6C8dbaEBCB54ff166d79706E3AF7a813c8',
      });

      const result = await resolveEnsContent('nocontent.box');
      expect(result.type).toBe('not_found');
      expect(result.reason).toBe('NO_CONTENTHASH');
      expect(result.name).toBe('nocontent.box');
      expect(result.error).toContain('CCIP');
    });

    test('returns not_found when .box domain has empty content hash', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue(null),
        address: '0xF97aAc6C8dbaEBCB54ff166d79706E3AF7a813c8',
      });

      const result = await resolveEnsContent('empty.box');
      expect(result.type).toBe('not_found');
      expect(result.reason).toBe('EMPTY_CONTENTHASH');
      expect(result.name).toBe('empty.box');
    });

    test('normalizes .box domain to lowercase', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('ipfs://QmTest123'),
        address: '0xF97aAc6C8dbaEBCB54ff166d79706E3AF7a813c8',
      });

      const result = await resolveEnsContent('MyDomain.BOX');
      expect(result.name).toBe('mydomain.box');
      expect(result.type).toBe('ok');
    });
  });

  describe('.eth domain resolution', () => {
    test('resolves .eth domain with IPFS content hash', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest
          .fn()
          .mockResolvedValue('ipfs://QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa'),
        address: '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41',
      });

      const result = await resolveEnsContent('vitalik.eth');
      expect(result).toEqual({
        type: 'ok',
        name: 'vitalik.eth',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: 'ipfs://QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa',
        decoded: 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa',
      });
    });
  });

  describe('error handling', () => {
    test('throws on empty name', async () => {
      await expect(resolveEnsContent('')).rejects.toThrow('ENS name is empty');
    });

    test('throws on whitespace-only name', async () => {
      await expect(resolveEnsContent('   ')).rejects.toThrow('ENS name is empty');
    });

    test('retries on provider error', async () => {
      const providerError = new Error('server error');
      providerError.code = 'SERVER_ERROR';

      // First attempt fails with provider error, second succeeds
      const mockContentHash = jest
        .fn()
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce('ipfs://QmRetried');

      mockGetResolver.mockResolvedValue({
        getContentHash: mockContentHash,
        address: '0xTest',
      });

      const result = await resolveEnsContent('retry.box');
      expect(result.type).toBe('ok');
      expect(result.uri).toBe('ipfs://QmRetried');
    });

    test('returns unsupported for unknown protocol', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('arweave://abc123'),
        address: '0xTest',
      });

      const result = await resolveEnsContent('arweave.box');
      expect(result.type).toBe('unsupported');
      expect(result.reason).toContain('UNSUPPORTED_PROTOCOL');
    });

    test('returns unsupported for malformed content hash', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('not-a-valid-uri'),
        address: '0xTest',
      });

      const result = await resolveEnsContent('malformed.box');
      expect(result.type).toBe('unsupported');
      expect(result.reason).toBe('UNSUPPORTED_CONTENTHASH_FORMAT');
    });
  });

  describe('caching', () => {
    test('returns cached result on second call', async () => {
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('ipfs://QmCached'),
        address: '0xTest',
      });

      const result1 = await resolveEnsContent('cached.box');
      expect(result1.type).toBe('ok');

      // Second call should use cache (resolver should only be called once)
      const result2 = await resolveEnsContent('cached.box');
      expect(result2.type).toBe('ok');
      expect(result2.uri).toBe('ipfs://QmCached');

      // getResolver called only once (second call used cache)
      expect(mockGetResolver).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom RPC URL', () => {
    test('uses custom RPC URL from settings when set', async () => {
      mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' });
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('ipfs://QmCustomRpc'),
        address: '0xTest',
      });

      const result = await resolveEnsContent('custom.eth');
      expect(result.type).toBe('ok');

      // JsonRpcProvider should have been called with custom URL first
      const calls = ethers.JsonRpcProvider.mock.calls;
      expect(calls[0][0]).toBe('http://localhost:8545');
    });

    test('falls back to public RPCs when custom RPC fails', async () => {
      mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' });

      // First call (custom RPC) fails, second call (public) succeeds
      let callCount = 0;
      mockGetBlockNumber.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve(12345678);
      });

      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('ipfs://QmFallback'),
        address: '0xTest',
      });

      const result = await resolveEnsContent('fallback.eth');
      expect(result.type).toBe('ok');
      expect(result.uri).toBe('ipfs://QmFallback');

      // Should have tried custom URL first, then a public one
      expect(ethers.JsonRpcProvider).toHaveBeenCalledTimes(2);
      expect(ethers.JsonRpcProvider.mock.calls[0][0]).toBe('http://localhost:8545');
    });

    test('clearing custom RPC reverts to default behavior', async () => {
      // Start with custom RPC
      mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: true, ensRpcUrl: 'http://localhost:8545' });
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('ipfs://QmFirst'),
        address: '0xTest',
      });

      await resolveEnsContent('first.eth');
      const firstUrl = ethers.JsonRpcProvider.mock.calls[0][0];
      expect(firstUrl).toBe('http://localhost:8545');

      // Disable custom RPC — cached provider URL won't match the new first provider,
      // so getWorkingProvider will invalidate and re-connect
      jest.clearAllMocks();
      mockGetBlockNumber.mockResolvedValue(12345678);
      mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: false, ensRpcUrl: '' });
      invalidateCachedProvider();
      mockGetResolver.mockResolvedValue({
        getContentHash: jest.fn().mockResolvedValue('ipfs://QmSecond'),
        address: '0xTest',
      });

      await resolveEnsContent('second.eth');

      // Should use the first public provider, not localhost
      const secondUrl = ethers.JsonRpcProvider.mock.calls[0][0];
      expect(secondUrl).not.toBe('http://localhost:8545');
    });
  });

  describe('testRpcUrl', () => {
    test('returns success for working RPC endpoint', async () => {
      const result = await testRpcUrl('http://localhost:8545');
      expect(result.success).toBe(true);
      expect(result.blockNumber).toBe(12345678);
    });

    test('returns failure for empty URL', async () => {
      const result = await testRpcUrl('');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_URL');
    });

    test('returns failure for invalid URL format', async () => {
      const result = await testRpcUrl('not-a-url');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_URL');
    });

    test('returns failure for non-http URL', async () => {
      const result = await testRpcUrl('ftp://localhost:8545');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INVALID_URL');
      expect(result.error.message).toContain('http');
    });

    test('returns failure when connection fails', async () => {
      mockGetBlockNumber.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await testRpcUrl('http://localhost:9999');
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('CONNECTION_FAILED');
    });

    test('destroys provider after test', async () => {
      await testRpcUrl('http://localhost:8545');
      expect(mockDestroy).toHaveBeenCalled();
    });

    test('destroys provider even on failure', async () => {
      mockGetBlockNumber.mockRejectedValue(new Error('fail'));
      await testRpcUrl('http://localhost:8545');
      expect(mockDestroy).toHaveBeenCalled();
    });
  });
});
