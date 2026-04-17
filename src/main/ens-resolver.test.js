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
const mockResolveName = jest.fn();
const mockUrResolve = jest.fn();
const mockUrResolveMulticall = jest.fn();
const mockUrReverse = jest.fn();

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers').ethers;
  return {
    ethers: {
      JsonRpcProvider: jest.fn().mockImplementation(() => ({
        getBlockNumber: mockGetBlockNumber,
        getResolver: mockGetResolver,
        resolveName: mockResolveName,
        destroy: mockDestroy,
      })),
      Contract: jest.fn().mockImplementation(() => ({
        resolve: mockUrResolve,
        resolveMulticall: mockUrResolveMulticall,
        reverse: mockUrReverse,
      })),
      // Pure helpers — use the real implementations so the UR helper's
      // encoding and the inline contenthash decoder are actually exercised.
      dnsEncode: actual.dnsEncode,
      namehash: actual.namehash,
      AbiCoder: actual.AbiCoder,
      encodeBase58: actual.encodeBase58,
      decodeBase58: actual.decodeBase58,
      getBytes: actual.getBytes,
      ZeroAddress: actual.ZeroAddress,
    },
  };
});

const { ethers } = require('ethers');
const {
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  testRpcUrl,
  invalidateCachedProvider,
  universalResolverCall,
  universalResolverMulticall,
  isResolverNotFoundError,
} = require('./ens-resolver');

beforeEach(() => {
  jest.clearAllMocks();
  invalidateCachedProvider();
  // Default: provider connects successfully
  mockGetBlockNumber.mockResolvedValue(12345678);
  // Default: resolver returns null (no resolver found)
  mockGetResolver.mockResolvedValue(null);
  // Default: resolveName returns null (no addr record)
  mockResolveName.mockResolvedValue(null);
  // Default: no custom RPC
  mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: false, ensRpcUrl: '' });
});

// Helpers for building mocked UR responses.
const actualEthers = jest.requireActual('ethers').ethers;
const FAKE_RESOLVER = '0x0000000000000000000000000000000000001234';

// Wrap raw contenthash hex bytes as the UR's ABI-encoded (bytes) return.
function urReturnsBytes(innerHex) {
  const wrapped = actualEthers.AbiCoder.defaultAbiCoder().encode(['bytes'], [innerHex]);
  return [wrapped, FAKE_RESOLVER];
}

// Build real ENS contenthash bytes for each codec we support. These are the
// exact byte patterns a resolver's contenthash(bytes32) would return on
// mainnet — we feed them through the UR mock so the real regex decoder runs.
// decodeBase58 returns a BigInt; for CIDv0 "Qm…" it always has a leading
// 0x12, so .toString(16) yields the full 68-char multihash (no leading-zero
// loss). padStart is a defensive lower bound.
function ipfsContenthashFor(base58Hash) {
  const multihashHex = actualEthers.decodeBase58(base58Hash).toString(16).padStart(68, '0');
  return '0xe3010170' + multihashHex;
}
function ipnsContenthashFor(base58Hash) {
  const multihashHex = actualEthers.decodeBase58(base58Hash).toString(16).padStart(68, '0');
  return '0xe5010172' + multihashHex;
}
function swarmContenthashFor(hash64Hex) {
  return '0xe40101fa011b20' + hash64Hex;
}

// Wrap an address as the UR's return where `bytes` is the ABI-encoded
// `address` output of the resolver's addr(bytes32).
function urReturnsAddress(address) {
  const inner = actualEthers.AbiCoder.defaultAbiCoder().encode(['address'], [address]);
  return urReturnsBytes(inner);
}

describe('ens-resolver', () => {
  describe('resolveEnsContent', () => {
    // Real IPFS v0 hash (34 bytes: 0x12 0x20 + 32-byte digest). Using a known
    // valid CID here so encodeBase58 round-trips cleanly.
    const IPFS_V0 = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';

    test('decodes ipfs contenthash and returns CIDv0 base58 URI', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('vitalik.eth');

      expect(result).toEqual({
        type: 'ok',
        name: 'vitalik.eth',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${IPFS_V0}`,
        decoded: IPFS_V0,
      });
    });

    test('decodes swarm contenthash', async () => {
      const swarmHash = 'a'.repeat(64);
      mockUrResolve.mockResolvedValue(urReturnsBytes(swarmContenthashFor(swarmHash)));

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

    test('decodes ipns contenthash', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipnsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('dynamic.box');

      expect(result.type).toBe('ok');
      expect(result.protocol).toBe('ipns');
      expect(result.uri).toBe(`ipns://${IPFS_V0}`);
      expect(result.codec).toBe('ipns-ns');
    });

    test('maps UR ResolverNotFound revert to NO_RESOLVER', async () => {
      mockUrResolve.mockRejectedValue(new Error('execution reverted: ResolverNotFound("unreg.box")'));

      const result = await resolveEnsContent('unreg.box');

      expect(result).toEqual({
        type: 'not_found',
        reason: 'NO_RESOLVER',
        name: 'unreg.box',
      });
    });

    test('maps generic UR revert to NO_CONTENTHASH', async () => {
      mockUrResolve.mockRejectedValue(
        new Error('response not found during CCIP fetch: 3dnsService:: CCIP_001')
      );

      const result = await resolveEnsContent('nocontent.box');

      expect(result.type).toBe('not_found');
      expect(result.reason).toBe('NO_CONTENTHASH');
      expect(result.error).toContain('CCIP');
    });

    test('returns EMPTY_CONTENTHASH for empty 0x return', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes('0x'));

      const result = await resolveEnsContent('empty.box');

      expect(result).toEqual({
        type: 'not_found',
        reason: 'EMPTY_CONTENTHASH',
        name: 'empty.box',
      });
    });

    test('returns UNSUPPORTED_CONTENTHASH_FORMAT for unknown bytes', async () => {
      // Arweave codec (0xb29910 varint) — valid contenthash but not supported.
      mockUrResolve.mockResolvedValue(urReturnsBytes('0xb29910' + 'cd'.repeat(30)));

      const result = await resolveEnsContent('arweave.box');

      expect(result.type).toBe('unsupported');
      expect(result.reason).toBe('UNSUPPORTED_CONTENTHASH_FORMAT');
      expect(result.name).toBe('arweave.box');
    });

    test('normalizes mixed-case input to lowercase', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('Vitalik.ETH');

      expect(result.name).toBe('vitalik.eth');
      expect(result.type).toBe('ok');
    });

    test('throws on empty name', async () => {
      await expect(resolveEnsContent('')).rejects.toThrow('ENS name is empty');
      await expect(resolveEnsContent('   ')).rejects.toThrow('ENS name is empty');
    });

    test('retries on provider error then succeeds', async () => {
      const providerError = new Error('server error');
      providerError.code = 'SERVER_ERROR';

      mockUrResolve
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('retry.box');

      expect(result.type).toBe('ok');
      expect(result.uri).toBe(`ipfs://${IPFS_V0}`);
      expect(mockUrResolve).toHaveBeenCalledTimes(2);
    });

    test('caches successful resolutions', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const first = await resolveEnsContent('cached.box');
      const second = await resolveEnsContent('cached.box');

      expect(first.type).toBe('ok');
      expect(second.uri).toBe(`ipfs://${IPFS_V0}`);
      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });

    test('makes exactly one UR call per cold resolution (perf regression guard)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      await resolveEnsContent('oneshot.eth');

      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('custom RPC URL', () => {
    test('uses custom RPC URL from settings when set', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: true,
        ensRpcUrl: 'http://localhost:8545',
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes('0xe30101701220' + 'ab'.repeat(32)));

      await resolveEnsContent('custom.eth');

      const calls = ethers.JsonRpcProvider.mock.calls;
      expect(calls[0][0]).toBe('http://localhost:8545');
    });

    test('falls back to public RPCs when custom RPC fails', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: true,
        ensRpcUrl: 'http://localhost:8545',
      });

      let callCount = 0;
      mockGetBlockNumber.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('ECONNREFUSED'));
        return Promise.resolve(12345678);
      });

      mockUrResolve.mockResolvedValue(urReturnsBytes('0xe30101701220' + 'ab'.repeat(32)));

      await resolveEnsContent('fallback.eth');

      expect(ethers.JsonRpcProvider).toHaveBeenCalledTimes(2);
      expect(ethers.JsonRpcProvider.mock.calls[0][0]).toBe('http://localhost:8545');
    });

    test('clearing custom RPC reverts to default behavior', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: true,
        ensRpcUrl: 'http://localhost:8545',
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes('0xe30101701220' + 'ab'.repeat(32)));

      await resolveEnsContent('first.eth');
      expect(ethers.JsonRpcProvider.mock.calls[0][0]).toBe('http://localhost:8545');

      jest.clearAllMocks();
      mockGetBlockNumber.mockResolvedValue(12345678);
      mockLoadSettings.mockReturnValue({ enableEnsCustomRpc: false, ensRpcUrl: '' });
      invalidateCachedProvider();
      mockUrResolve.mockResolvedValue(urReturnsBytes('0xe301017012' + 'cd'.repeat(34)));

      await resolveEnsContent('second.eth');

      expect(ethers.JsonRpcProvider.mock.calls[0][0]).not.toBe('http://localhost:8545');
    });
  });

  describe('resolveEnsAddress', () => {
    test('resolves ENS name to its addr record', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
      );

      const result = await resolveEnsAddress('vitalik.eth');

      expect(result).toEqual({
        success: true,
        name: 'vitalik.eth',
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });
    });

    test('normalizes mixed-case input to lowercase', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
      );

      const result = await resolveEnsAddress('Mixed.ETH');

      expect(result.success).toBe(true);
      expect(result.name).toBe('mixed.eth');
    });

    test('returns NO_ADDRESS for zero-address return (resolver says no addr set)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsAddress('0x0000000000000000000000000000000000000000'));

      const result = await resolveEnsAddress('no-addr.eth');

      expect(result).toEqual({
        success: false,
        name: 'no-addr.eth',
        reason: 'NO_ADDRESS',
        error: 'No address record set for no-addr.eth',
      });
    });

    test('returns NO_ADDRESS for empty bytes return', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes('0x'));

      const result = await resolveEnsAddress('empty-bytes.eth');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_ADDRESS');
    });

    test('maps UR ResolverNotFound revert to NO_ADDRESS', async () => {
      mockUrResolve.mockRejectedValue(
        new Error('execution reverted: ResolverNotFound("unreg.eth")')
      );

      const result = await resolveEnsAddress('unreg.eth');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_ADDRESS');
    });

    test('maps generic UR revert to RESOLUTION_ERROR', async () => {
      mockUrResolve.mockRejectedValue(new Error('some other revert reason'));

      const result = await resolveEnsAddress('broken.eth');

      expect(result.success).toBe(false);
      expect(result.reason).toBe('RESOLUTION_ERROR');
      expect(result.error).toContain('some other revert');
    });

    test('throws on empty name', async () => {
      await expect(resolveEnsAddress('')).rejects.toThrow('ENS name is empty');
      await expect(resolveEnsAddress('   ')).rejects.toThrow('ENS name is empty');
    });

    test('retries on provider error then succeeds', async () => {
      const providerError = new Error('server error');
      providerError.code = 'SERVER_ERROR';

      mockUrResolve
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce(urReturnsAddress('0x0000000000000000000000000000000000000001'));

      const result = await resolveEnsAddress('retry.eth');

      expect(result.success).toBe(true);
      expect(result.address).toBe('0x0000000000000000000000000000000000000001');
      expect(mockUrResolve).toHaveBeenCalledTimes(2);
    });

    test('caches successful resolutions', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0x1111111111111111111111111111111111111111')
      );

      const first = await resolveEnsAddress('cached-addr.eth');
      const second = await resolveEnsAddress('cached-addr.eth');

      expect(first.address).toBe('0x1111111111111111111111111111111111111111');
      expect(second.address).toBe('0x1111111111111111111111111111111111111111');
      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });

    test('caches negative results too (NO_ADDRESS misses)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsAddress('0x0000000000000000000000000000000000000000'));

      const first = await resolveEnsAddress('no-addr-cached.eth');
      const second = await resolveEnsAddress('no-addr-cached.eth');

      expect(first.reason).toBe('NO_ADDRESS');
      expect(second.reason).toBe('NO_ADDRESS');
      // Second call hit the cache, no second RPC round-trip.
      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });

    test('makes exactly one UR call per cold resolution (perf regression guard)', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
      );

      await resolveEnsAddress('oneshot-addr.eth');

      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('resolveEnsReverse', () => {
    const RESOLVER = '0x0000000000000000000000000000000000001234';
    // Address pool — each test uses a unique one to avoid ensReverseCache
    // pollution across tests (same pattern as the name-keyed tests above).
    const addr = (n) => '0x' + String(n).padStart(40, '0');

    test('returns verified name when forward-verify passes', async () => {
      const input = addr('1001');
      mockUrReverse.mockResolvedValue(['verified1.eth', RESOLVER, RESOLVER]);
      mockUrResolve.mockResolvedValue(urReturnsAddress(input));

      const result = await resolveEnsReverse(input);

      expect(result).toEqual({
        success: true,
        address: input.toLowerCase(),
        name: 'verified1.eth',
      });
    });

    test('UNVERIFIED when reverse name resolves to a different address', async () => {
      const input = addr('1002');
      mockUrReverse.mockResolvedValue(['spoof.eth', RESOLVER, RESOLVER]);
      mockUrResolve.mockResolvedValue(urReturnsAddress(addr('9999')));

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('UNVERIFIED');
      expect(result.claimedUnverifiedName).toBe('spoof.eth');
    });

    test('UNVERIFIED when the reverse-claimed name has no forward addr record', async () => {
      const input = addr('1003');
      mockUrReverse.mockResolvedValue(['orphan.eth', RESOLVER, RESOLVER]);
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0x0000000000000000000000000000000000000000')
      );

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('UNVERIFIED');
    });

    test('NO_REVERSE when UR returns empty name', async () => {
      const input = addr('1004');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_REVERSE');
    });

    test('NO_REVERSE when UR reverts with ResolverNotFound', async () => {
      const input = addr('1005');
      mockUrReverse.mockRejectedValue(
        new Error('execution reverted: ResolverNotFound')
      );

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_REVERSE');
    });

    test('RESOLUTION_ERROR on generic UR revert', async () => {
      const input = addr('1006');
      mockUrReverse.mockRejectedValue(new Error('some other revert'));

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('RESOLUTION_ERROR');
    });

    test('INVALID_ADDRESS for malformed input', async () => {
      expect((await resolveEnsReverse('not-an-address')).reason).toBe('INVALID_ADDRESS');
      expect((await resolveEnsReverse('')).reason).toBe('INVALID_ADDRESS');
      expect((await resolveEnsReverse(null)).reason).toBe('INVALID_ADDRESS');
      expect((await resolveEnsReverse('0x1234')).reason).toBe('INVALID_ADDRESS');
      expect(mockUrReverse).not.toHaveBeenCalled();
    });

    test('retries on provider error then succeeds', async () => {
      const input = addr('1007');
      const providerError = new Error('server error');
      providerError.code = 'SERVER_ERROR';

      mockUrReverse
        .mockRejectedValueOnce(providerError)
        .mockResolvedValueOnce(['retry-reverse.eth', RESOLVER, RESOLVER]);
      mockUrResolve.mockResolvedValue(urReturnsAddress(input));

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(true);
      expect(result.name).toBe('retry-reverse.eth');
      expect(mockUrReverse).toHaveBeenCalledTimes(2);
    });

    test('caches successful verified results', async () => {
      const input = addr('1008');
      mockUrReverse.mockResolvedValue(['cached.eth', RESOLVER, RESOLVER]);
      mockUrResolve.mockResolvedValue(urReturnsAddress(input));

      await resolveEnsReverse(input);
      await resolveEnsReverse(input);

      expect(mockUrReverse).toHaveBeenCalledTimes(1);
    });

    test('caches NO_REVERSE negative results too', async () => {
      const input = addr('1009');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);

      await resolveEnsReverse(input);
      await resolveEnsReverse(input);

      expect(mockUrReverse).toHaveBeenCalledTimes(1);
    });

    test('normalizes input address to lowercase for caching', async () => {
      const input = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa10101010';
      mockUrReverse.mockResolvedValue(['mixed.eth', RESOLVER, RESOLVER]);
      mockUrResolve.mockResolvedValue(urReturnsAddress(input.toLowerCase()));

      await resolveEnsReverse(input);
      await resolveEnsReverse(input.toLowerCase());

      // Second call hits the cache keyed on lowercase form.
      expect(mockUrReverse).toHaveBeenCalledTimes(1);
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

  describe('universalResolverCall', () => {
    const actualEthers = jest.requireActual('ethers').ethers;
    const FAKE_RESOLVER = '0x0000000000000000000000000000000000001234';

    // Helper: wrap raw hex bytes as the UR's ABI-encoded `(bytes)` return value.
    const wrapAsUrBytes = (innerHex) => {
      const coder = actualEthers.AbiCoder.defaultAbiCoder();
      return coder.encode(['bytes'], [innerHex]);
    };

    test('encodes name, opts into CCIP-Read, and unwraps inner bytes', async () => {
      const inner = '0xdeadbeef';
      mockUrResolve.mockResolvedValue([wrapAsUrBytes(inner), FAKE_RESOLVER]);

      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      const callData = '0xbc1c4a73' + actualEthers.namehash('vitalik.eth').slice(2);
      const result = await universalResolverCall(provider, 'vitalik.eth', callData);

      expect(result.bytes.toLowerCase()).toBe(inner);
      expect(result.resolverAddress).toBe(FAKE_RESOLVER);

      // Verify the call shape the UR actually received
      expect(mockUrResolve).toHaveBeenCalledTimes(1);
      const [encodedName, passedCallData, overrides] = mockUrResolve.mock.calls[0];
      expect(encodedName).toBe(actualEthers.dnsEncode('vitalik.eth', 255));
      expect(passedCallData).toBe(callData);
      expect(overrides).toEqual({ enableCcipRead: true });
    });

    test('constructs Contract with UR address and minimal ABI', async () => {
      mockUrResolve.mockResolvedValue([wrapAsUrBytes('0x'), FAKE_RESOLVER]);
      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      await universalResolverCall(provider, 'vitalik.eth', '0xbc1c4a73');

      expect(ethers.Contract).toHaveBeenCalledWith(
        '0x5a9236e72a66d3e08b83dcf489b4d850792b6009',
        expect.arrayContaining([expect.stringContaining('function resolve')]),
        provider
      );
    });

    test('propagates UR reverts to the caller', async () => {
      const err = new Error('execution reverted: ResolverNotFound');
      mockUrResolve.mockRejectedValue(err);
      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      await expect(
        universalResolverCall(provider, 'unregistered.eth', '0xbc1c4a73')
      ).rejects.toThrow('ResolverNotFound');
    });
  });

  describe('universalResolverMulticall', () => {
    test('encodes name, opts into CCIP-Read, and unwraps per-call inner bytes', async () => {
      const coder = actualEthers.AbiCoder.defaultAbiCoder();
      // Simulate three resolver responses (e.g. addr + text + contenthash).
      const inner1 = '0xdeadbeef';
      const inner2 = '0xfeedface';
      const inner3 = '0x';
      mockUrResolveMulticall.mockResolvedValue([
        coder.encode(['bytes'], [inner1]),
        coder.encode(['bytes'], [inner2]),
        coder.encode(['bytes'], [inner3]),
      ]);

      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      const calls = ['0x3b3b57de', '0xbc1c4a73', '0x59d1d43c'];
      const results = await universalResolverMulticall(provider, 'vitalik.eth', calls);

      expect(results.map((r) => r.toLowerCase())).toEqual([inner1, inner2, inner3]);

      expect(mockUrResolveMulticall).toHaveBeenCalledTimes(1);
      const [encodedName, passedCalls, overrides] = mockUrResolveMulticall.mock.calls[0];
      expect(encodedName).toBe(actualEthers.dnsEncode('vitalik.eth', 255));
      expect(passedCalls).toEqual(calls);
      expect(overrides).toEqual({ enableCcipRead: true });
    });

    test('handles empty calls array', async () => {
      mockUrResolveMulticall.mockResolvedValue([]);

      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      const results = await universalResolverMulticall(provider, 'vitalik.eth', []);

      expect(results).toEqual([]);
    });

    test('propagates reverts to the caller', async () => {
      mockUrResolveMulticall.mockRejectedValue(new Error('execution reverted: ResolverNotFound'));

      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      await expect(
        universalResolverMulticall(provider, 'unreg.eth', ['0x3b3b57de'])
      ).rejects.toThrow('ResolverNotFound');
    });
  });

  describe('isResolverNotFoundError', () => {
    test('matches ResolverNotFound error message', () => {
      expect(
        isResolverNotFoundError(new Error('execution reverted: ResolverNotFound("foo.eth")'))
      ).toBe(true);
    });

    test('matches ResolverNotContract error message', () => {
      expect(
        isResolverNotFoundError(new Error('execution reverted: ResolverNotContract'))
      ).toBe(true);
    });

    test('matches ResolverNotFound selector in error data', () => {
      const err = new Error('call exception');
      err.info = { error: { data: '0x7199966d00000000000000000000000000000000' } };
      expect(isResolverNotFoundError(err)).toBe(true);
    });

    test('rejects unrelated errors', () => {
      expect(isResolverNotFoundError(new Error('network timeout'))).toBe(false);
      expect(isResolverNotFoundError(new Error('ECONNREFUSED'))).toBe(false);
      expect(isResolverNotFoundError(null)).toBe(false);
      expect(isResolverNotFoundError(undefined)).toBe(false);
      expect(isResolverNotFoundError({})).toBe(false);
    });
  });
});
