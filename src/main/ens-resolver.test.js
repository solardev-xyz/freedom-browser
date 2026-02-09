// Mock electron ipcMain before requiring ens-resolver
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
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

const { resolveEnsContent } = require('./ens-resolver');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: provider connects successfully
  mockGetBlockNumber.mockResolvedValue(12345678);
  // Default: resolver returns null (no resolver found)
  mockGetResolver.mockResolvedValue(null);
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
});
