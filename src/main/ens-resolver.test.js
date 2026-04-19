// Mock electron ipcMain before requiring ens-resolver
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

// Mock ens-prefetch so tests can assert when it fires and when it aborts,
// without spinning up a real net.request. Default impl returns a fresh
// abort-recording handle each call.
const mockPrefetchGatewayUrl = jest.fn();
jest.mock('./ens-prefetch', () => ({
  prefetchGatewayUrl: (...args) => mockPrefetchGatewayUrl(...args),
  PREFETCH_TIMEOUT_MS: 10_000,
}));

// Mock settings-store. Test provider list is small (3 URLs) so the quorum
// wave is bounded regardless of test input. Individual tests override
// mockLoadSettings when they need different values.
const TEST_PROVIDERS = [
  'https://test-a.example.com',
  'https://test-b.example.com',
  'https://test-c.example.com',
];
const mockLoadSettings = jest.fn(() => ({
  enableEnsCustomRpc: false,
  ensRpcUrl: '',
  enableEnsQuorum: true,
  ensQuorumK: 3,
  ensQuorumM: 2,
  ensQuorumTimeoutMs: 5000,
  ensBlockAnchor: 'latest',
  ensBlockAnchorTtlMs: 30000,
  ensPublicRpcProviders: TEST_PROVIDERS,
}));
jest.mock('./settings-store', () => ({
  loadSettings: (...args) => mockLoadSettings(...args),
  DEFAULT_ENS_PUBLIC_RPC_PROVIDERS: [
    'https://default-a.example.com',
    'https://default-b.example.com',
    'https://default-c.example.com',
  ],
}));

// Mock ethers with controllable provider and resolver behavior.
// `mockUrResolve` is shared across all Contract instances — this is fine
// for tests that use `mockResolvedValue(X)` (every quorum leg returns X
// and consensus reaches agreement). Tests that need per-provider behavior
// use `setProviderResolveMap(url → result)` to differentiate.
const mockGetBlockNumber = jest.fn();
const mockGetBlock = jest.fn();
const mockDestroy = jest.fn();
const mockGetResolver = jest.fn();
const mockResolveName = jest.fn();
const mockUrResolve = jest.fn();
const mockUrReverse = jest.fn();

// Last URL passed to JsonRpcProvider — lets per-provider test helpers know
// which URL they're being called on during the current ur.resolve invocation.
let lastProviderUrl = null;

// Per-URL response routing for quorum tests. When set, the Contract mock's
// resolve function consults this map based on the underlying provider's URL
// and returns the mapped response instead of delegating to mockUrResolve.
// Leave null for tests that don't need per-provider differentiation — those
// use mockUrResolve.mockResolvedValue() directly.
let mockProviderRouteMap = null;

// Per-URL anchor routing. Values: { headNumber, getBlock(tagOrNumber) }.
// headNumber can be a number or an Error (rejects). getBlock is a function
// the provider.getBlock proxy delegates to — typically returns {number, hash}.
let mockProviderAnchorMap = null;

jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers').ethers;
  return {
    ethers: {
      JsonRpcProvider: jest.fn().mockImplementation((url) => {
        lastProviderUrl = url;
        return {
          url,
          // getBlockNumber and getBlock consult mockProviderAnchorMap first
          // for anchor-corroboration regression tests; otherwise delegate
          // to the shared mocks that cover the common case.
          getBlockNumber: () => {
            if (mockProviderAnchorMap) {
              const entry = mockProviderAnchorMap.get(url);
              if (entry && 'headNumber' in entry) {
                if (entry.headNumber instanceof Error) return Promise.reject(entry.headNumber);
                return Promise.resolve(entry.headNumber);
              }
            }
            return mockGetBlockNumber();
          },
          getBlock: (blockTagOrNumber) => {
            if (mockProviderAnchorMap) {
              const entry = mockProviderAnchorMap.get(url);
              if (entry?.getBlock) return entry.getBlock(blockTagOrNumber);
            }
            return mockGetBlock(blockTagOrNumber);
          },
          getResolver: mockGetResolver,
          resolveName: mockResolveName,
          destroy: mockDestroy,
        };
      }),
      Contract: jest.fn().mockImplementation((_addr, _abi, provider) => ({
        resolve: (...args) => {
          // Per-URL routing takes precedence; otherwise the shared mock.
          if (mockProviderRouteMap) {
            const entry = mockProviderRouteMap.get(provider?.url);
            if (entry) {
              if (entry.kind === 'reject') return Promise.reject(entry.payload);
              return Promise.resolve(entry.payload);
            }
          }
          return mockUrResolve(...args);
        },
        reverse: (...args) => mockUrReverse(...args),
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
  isResolverNotFoundError,
  clearEnsCachesForTest,
} = require('./ens-resolver');

// Fake block anchor — stable hash so consensus legs querying the same
// block get deterministic agreement.
const FAKE_BLOCK = { number: 12345678, hash: '0xabcdef0000000000000000000000000000000000000000000000000000000000' };

beforeEach(() => {
  jest.clearAllMocks();
  invalidateCachedProvider();
  clearEnsCachesForTest();
  lastProviderUrl = null;
  mockProviderRouteMap = null;
  mockProviderAnchorMap = null;
  mockPrefetchGatewayUrl.mockImplementation(() => ({ abort: jest.fn() }));
  mockGetBlockNumber.mockResolvedValue(FAKE_BLOCK.number);
  mockGetBlock.mockResolvedValue(FAKE_BLOCK);
  mockGetResolver.mockResolvedValue(null);
  mockResolveName.mockResolvedValue(null);
  mockLoadSettings.mockReturnValue({
    enableEnsCustomRpc: false,
    ensRpcUrl: '',
    enableEnsQuorum: true,
    ensQuorumK: 3,
    ensQuorumM: 2,
    ensQuorumTimeoutMs: 5000,
    ensBlockAnchor: 'latest',
    ensBlockAnchorTtlMs: 30000,
    ensPublicRpcProviders: TEST_PROVIDERS,
  });
});

// Set up per-URL response routing for quorum tests. Map values:
//   { kind: 'data',   payload: [resolvedData, resolverAddress] }
//   { kind: 'reject', payload: Error }
function routeByProvider(map) {
  mockProviderRouteMap = map;
}

// Helpers for building mocked UR responses. The UR returns
// [resolvedData, resolverAddress] where resolvedData is the RAW
// ABI-encoded response of the resolver function — its shape depends
// on that function's return type. For `contenthash() returns (bytes)`
// it's ABI-encoded `(bytes)`; for `addr() returns (address)` it's the
// 32-byte address directly. Each helper mirrors one of those shapes.
const actualEthers = jest.requireActual('ethers').ethers;
const FAKE_RESOLVER = '0x0000000000000000000000000000000000001234';

// For contenthash-like (dynamic `bytes` return): wrap inner hex as ABI (bytes).
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

// For addr-like (static `address` return): the UR's resolvedData is just
// the 32-byte ABI-encoded address. No bytes-wrapper.
function urReturnsAddress(address) {
  const encoded = actualEthers.AbiCoder.defaultAbiCoder().encode(['address'], [address]);
  return [encoded, FAKE_RESOLVER];
}

describe('ens-resolver', () => {
  describe('resolveEnsContent', () => {
    // Real IPFS v0 hash (34 bytes: 0x12 0x20 + 32-byte digest). Using a known
    // valid CID here so encodeBase58 round-trips cleanly.
    const IPFS_V0 = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';

    test('decodes ipfs contenthash and returns CIDv0 base58 URI', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('vitalik.eth');

      expect(result).toMatchObject({
        type: 'ok',
        name: 'vitalik.eth',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${IPFS_V0}`,
        decoded: IPFS_V0,
      });
      expect(result.trust.level).toBe('verified');
      expect(result.trust.quorum).toEqual({ k: 3, m: 2, achieved: true });
    });

    test('decodes swarm contenthash', async () => {
      const swarmHash = 'a'.repeat(64);
      mockUrResolve.mockResolvedValue(urReturnsBytes(swarmContenthashFor(swarmHash)));

      const result = await resolveEnsContent('mysite.box');

      expect(result).toMatchObject({
        type: 'ok',
        name: 'mysite.box',
        codec: 'swarm-ns',
        protocol: 'bzz',
        uri: `bzz://${swarmHash}`,
        decoded: swarmHash,
      });
      expect(result.trust.level).toBe('verified');
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

      expect(result).toMatchObject({
        type: 'not_found',
        reason: 'NO_RESOLVER',
        name: 'unreg.box',
      });
      expect(result.trust.level).toBe('verified');
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

      expect(result).toMatchObject({
        type: 'not_found',
        reason: 'EMPTY_CONTENTHASH',
        name: 'empty.box',
      });
      expect(result.trust.level).toBe('verified');
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

    // Unicode names need full UTS-46 / ENSIP-15 normalization, not bare
    // lowercase — otherwise namehash is computed against an unnormalized
    // form and the resolver lookup silently misses.
    test('normalizes unicode names via ENSIP-15', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('nic🦊.eth');

      expect(result.type).toBe('ok');
      expect(result.name).toBe('nic🦊.eth');
    });

    test('throws on invalid ENS label (e.g. mid-label underscore)', async () => {
      await expect(resolveEnsContent('invalid_label.eth')).rejects.toThrow(/underscore/i);
    });

    test('throws on empty name', async () => {
      await expect(resolveEnsContent('')).rejects.toThrow('ENS name is empty');
      await expect(resolveEnsContent('   ')).rejects.toThrow('ENS name is empty');
    });

    test('verified outcome survives one provider erroring (others still reach M)', async () => {
      // K=3 legs, M=2. Route one provider to error and two to return valid
      // bytes — quorum should still reach agreement on the valid bytes.
      const providerError = new Error('server error');
      providerError.code = 'SERVER_ERROR';
      const goodBytes = urReturnsBytes(ipfsContenthashFor(IPFS_V0));

      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'reject', payload: providerError }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: goodBytes }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: goodBytes }],
      ]));

      const result = await resolveEnsContent('retry.box');

      expect(result.type).toBe('ok');
      expect(result.uri).toBe(`ipfs://${IPFS_V0}`);
      expect(result.trust.level).toBe('verified');
      expect(result.trust.agreed.length).toBeGreaterThanOrEqual(2);
    });

    test('caches successful resolutions (warm resolution skips RPC entirely)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const first = await resolveEnsContent('cached.box');
      const callsAfterCold = mockUrResolve.mock.calls.length;
      const second = await resolveEnsContent('cached.box');

      expect(first.type).toBe('ok');
      expect(second.uri).toBe(`ipfs://${IPFS_V0}`);
      // Cold path hits K=3 legs; warm path hits 0 (cache).
      expect(mockUrResolve.mock.calls.length).toBe(callsAfterCold);
    });

    test('makes K UR calls per cold resolution (one per quorum leg)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      await resolveEnsContent('oneshot.eth');

      // Default test settings: K=3, matching TEST_PROVIDERS.length.
      expect(mockUrResolve).toHaveBeenCalledTimes(3);
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
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: TEST_PROVIDERS,
      });

      // Custom RPC returns ECONNREFUSED for every head fetch → fast-path
      // returns null → falls through to public quorum.
      mockGetBlockNumber.mockImplementation(() => {
        if (lastProviderUrl === 'http://localhost:8545') {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve(12345678);
      });

      mockUrResolve.mockResolvedValue(urReturnsBytes('0xe30101701220' + 'ab'.repeat(32)));

      const result = await resolveEnsContent('fallback-to-public-legacy.eth');

      // First provider constructed is the custom RPC (fast-path attempt).
      expect(ethers.JsonRpcProvider.mock.calls[0][0]).toBe('http://localhost:8545');
      // Resolution reached a public-quorum verified outcome.
      expect(result.trust.level).toBe('verified');
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

      expect(result).toMatchObject({
        success: true,
        name: 'vitalik.eth',
        address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });
      expect(result.trust.level).toBe('verified');
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

      expect(result).toMatchObject({
        success: false,
        name: 'no-addr.eth',
        reason: 'NO_ADDRESS',
        error: 'No address record set for no-addr.eth',
      });
      expect(result.trust.level).toBe('verified');
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

    test('verified addr outcome survives one provider erroring (others still reach M)', async () => {
      const providerError = new Error('server error');
      providerError.code = 'SERVER_ERROR';
      const good = urReturnsAddress('0x0000000000000000000000000000000000000001');

      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'reject', payload: providerError }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: good }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: good }],
      ]));

      const result = await resolveEnsAddress('retry.eth');

      expect(result.success).toBe(true);
      expect(result.address).toBe('0x0000000000000000000000000000000000000001');
      expect(result.trust.level).toBe('verified');
    });

    test('caches successful resolutions (warm lookup skips RPC)', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0x1111111111111111111111111111111111111111')
      );

      const first = await resolveEnsAddress('cached-addr.eth');
      const callsAfterCold = mockUrResolve.mock.calls.length;
      const second = await resolveEnsAddress('cached-addr.eth');

      expect(first.address).toBe('0x1111111111111111111111111111111111111111');
      expect(second.address).toBe('0x1111111111111111111111111111111111111111');
      expect(mockUrResolve.mock.calls.length).toBe(callsAfterCold);
    });

    test('caches negative results too (NO_ADDRESS misses)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsAddress('0x0000000000000000000000000000000000000000'));

      const first = await resolveEnsAddress('no-addr-cached.eth');
      const callsAfterCold = mockUrResolve.mock.calls.length;
      const second = await resolveEnsAddress('no-addr-cached.eth');

      expect(first.reason).toBe('NO_ADDRESS');
      expect(second.reason).toBe('NO_ADDRESS');
      expect(mockUrResolve.mock.calls.length).toBe(callsAfterCold);
    });

    test('makes K UR calls per cold resolution (one per quorum leg)', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
      );

      await resolveEnsAddress('oneshot-addr.eth');

      expect(mockUrResolve).toHaveBeenCalledTimes(3);
    });
  });

  describe('resolveEnsReverse', () => {
    const RESOLVER = '0x0000000000000000000000000000000000001234';
    // Unique per-test addresses avoid ensReverseCache pollution across tests.
    const addr = (n) => '0x' + String(n).padStart(40, '0');

    test('returns verified name when UR resolves successfully', async () => {
      // UR verifies forward-resolution internally before returning a name —
      // a successful return is already a trusted match, no external check.
      const input = addr('1001');
      mockUrReverse.mockResolvedValue(['verified1.eth', RESOLVER, RESOLVER]);

      const result = await resolveEnsReverse(input);

      expect(result).toEqual({
        success: true,
        address: input.toLowerCase(),
        name: 'verified1.eth',
      });
    });

    test('UNVERIFIED when UR reverts with ReverseAddressMismatch', async () => {
      const input = addr('1002');
      const err = new Error('execution reverted: ReverseAddressMismatch');
      err.data = '0xef9c03ce00000000000000000000000000000000';
      mockUrReverse.mockRejectedValue(err);

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('UNVERIFIED');
      // No claimed-name field — keeps spoofed names out of the return shape
      // entirely so no caller can accidentally surface them.
      expect(result.claimedUnverifiedName).toBeUndefined();
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
      const err = new Error('execution reverted: ResolverNotFound');
      err.data = '0x77209fe800000000';
      mockUrReverse.mockRejectedValue(err);

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

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(true);
      expect(result.name).toBe('retry-reverse.eth');
      expect(mockUrReverse).toHaveBeenCalledTimes(2);
    });

    test('caches successful verified results', async () => {
      const input = addr('1008');
      mockUrReverse.mockResolvedValue(['cached.eth', RESOLVER, RESOLVER]);

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
    test('encodes name, opts into CCIP-Read, returns raw resolvedData', async () => {
      const rawResponse = actualEthers.AbiCoder.defaultAbiCoder().encode(
        ['bytes'],
        ['0xdeadbeef']
      );
      mockUrResolve.mockResolvedValue([rawResponse, FAKE_RESOLVER]);

      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      const callData = '0xbc1c58d1' + actualEthers.namehash('vitalik.eth').slice(2);
      const result = await universalResolverCall(provider, 'vitalik.eth', callData);

      // Returns raw ABI-encoded response — caller decodes per return type.
      expect(result.resolvedData).toBe(rawResponse);
      expect(result.resolverAddress).toBe(FAKE_RESOLVER);

      expect(mockUrResolve).toHaveBeenCalledTimes(1);
      const [encodedName, passedCallData, overrides] = mockUrResolve.mock.calls[0];
      expect(encodedName).toBe(actualEthers.dnsEncode('vitalik.eth', 255));
      expect(passedCallData).toBe(callData);
      expect(overrides).toEqual({ enableCcipRead: true });
    });

    test('constructs Contract with UR address and minimal ABI', async () => {
      mockUrResolve.mockResolvedValue(['0x', FAKE_RESOLVER]);
      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      await universalResolverCall(provider, 'vitalik.eth', '0xbc1c58d1');

      expect(ethers.Contract).toHaveBeenCalledWith(
        '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
        expect.arrayContaining([expect.stringContaining('function resolve')]),
        provider
      );
    });

    test('propagates UR reverts to the caller', async () => {
      const err = new Error('execution reverted: ResolverNotFound');
      mockUrResolve.mockRejectedValue(err);
      const provider = new ethers.JsonRpcProvider('http://localhost:8545');
      await expect(
        universalResolverCall(provider, 'unregistered.eth', '0xbc1c58d1')
      ).rejects.toThrow('ResolverNotFound');
    });
  });

  describe('isResolverNotFoundError', () => {
    test('matches ResolverNotFound in error message', () => {
      expect(
        isResolverNotFoundError(new Error('execution reverted: ResolverNotFound("foo.eth")'))
      ).toBe(true);
    });

    test('matches ResolverNotContract in error message', () => {
      expect(
        isResolverNotFoundError(new Error('execution reverted: ResolverNotContract'))
      ).toBe(true);
    });

    // ethers v6 surfaces revert selectors on err.data directly — this is
    // the shape we see on real CALL_EXCEPTION errors from a live RPC.
    test('matches ResolverNotFound selector on err.data (ethers v6)', () => {
      const err = new Error('execution reverted (unknown custom error)');
      err.data = '0x77209fe800000000000000000000000000000000000000000000000000000000';
      expect(isResolverNotFoundError(err)).toBe(true);
    });

    test('matches ResolverNotContract selector on err.data', () => {
      const err = new Error('execution reverted');
      err.data = '0x1e9535f2000000000000000000';
      expect(isResolverNotFoundError(err)).toBe(true);
    });

    // Some JSON-RPC wrappers nest the revert data one level deeper.
    test('matches selector nested under err.info.error.data', () => {
      const err = new Error('call exception');
      err.info = { error: { data: '0x77209fe80000' } };
      expect(isResolverNotFoundError(err)).toBe(true);
    });

    test('selector match is case-insensitive', () => {
      const err = new Error('x');
      err.data = '0x77209FE80000';
      expect(isResolverNotFoundError(err)).toBe(true);
    });

    test('rejects unrelated errors', () => {
      expect(isResolverNotFoundError(new Error('network timeout'))).toBe(false);
      expect(isResolverNotFoundError(new Error('ECONNREFUSED'))).toBe(false);
      const unrelated = new Error('x');
      unrelated.data = '0xdeadbeef00000000';
      expect(isResolverNotFoundError(unrelated)).toBe(false);
      expect(isResolverNotFoundError(null)).toBe(false);
      expect(isResolverNotFoundError(undefined)).toBe(false);
      expect(isResolverNotFoundError({})).toBe(false);
    });

    test('does NOT match ReverseAddressMismatch (separate concept)', () => {
      const err = new Error('execution reverted: ReverseAddressMismatch');
      err.data = '0xef9c03ce00000000';
      expect(isResolverNotFoundError(err)).toBe(false);
    });
  });

  // --------------------------------------------------------------------
  // Quorum-path tests (Phase 1). Covers consensus outcomes that don't
  // exist in the legacy single-provider flow: conflict, degraded K=1
  // unverified, user-configured fast-path labelling, block pinning.
  // --------------------------------------------------------------------
  describe('consensus quorum', () => {
    const IPFS_HASH = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';

    test('conflict: ≥2 providers return different bytes → type=conflict with groups', async () => {
      const hashA = 'a'.repeat(64);
      const hashB = 'b'.repeat(64);
      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashA)) }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashB)) }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashA + '').slice(0, 4) + 'cc'.repeat(40)) }],
      ]));

      const result = await resolveEnsContent('conflict.box');

      expect(result.type).toBe('conflict');
      expect(result.trust.level).toBe('conflict');
      expect(result.trust.quorum.achieved).toBe(false);
      expect(result.groups.length).toBeGreaterThanOrEqual(2);
      // Groups each reference at least one test provider hostname.
      const allUrls = result.groups.flatMap((g) => g.urls);
      expect(allUrls.length).toBe(3);
    });

    test('conflict: honest vs lying provider → type=conflict', async () => {
      const honest = urReturnsBytes(ipfsContenthashFor(IPFS_HASH));
      const liar = urReturnsBytes(swarmContenthashFor('f'.repeat(64)));
      // Two providers return different data, third errors — no M-group on data.
      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'data', payload: honest }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: liar }],
        [TEST_PROVIDERS[2], { kind: 'reject', payload: Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' }) }],
      ]));

      const result = await resolveEnsContent('liar.eth');

      expect(result.type).toBe('conflict');
      expect(result.groups.length).toBe(2);
    });

    test('conflict is NOT positively cached (re-resolves on next call)', async () => {
      // All three providers respond but disagree → conflict, no
      // quarantine. The re-resolve then has all 3 still available.
      const hashA = 'a'.repeat(64);
      const hashB = 'b'.repeat(64);
      const hashC = 'c'.repeat(64);
      const bytesB = urReturnsBytes(swarmContenthashFor(hashB));

      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashA)) }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: bytesB }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashC)) }],
      ]));

      const first = await resolveEnsContent('conflict-cache.box');
      expect(first.type).toBe('conflict');

      // Conflict cache is negative-only for 10s — advance past that window.
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 11_000;
        routeByProvider(new Map([
          [TEST_PROVIDERS[0], { kind: 'data', payload: bytesB }],
          [TEST_PROVIDERS[1], { kind: 'data', payload: bytesB }],
          [TEST_PROVIDERS[2], { kind: 'data', payload: bytesB }],
        ]));

        const second = await resolveEnsContent('conflict-cache.box');
        expect(second.type).toBe('ok');
        expect(second.trust.level).toBe('verified');
      } finally {
        Date.now = realNow;
      }
    });

    test('verified cache is honored on warm lookup (15m TTL)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const first = await resolveEnsContent('ttl-verified.eth');
      expect(first.trust.level).toBe('verified');

      // Simulate 10min elapsed — well under 15min verified TTL.
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 10 * 60 * 1000;
        jest.clearAllMocks();
        const second = await resolveEnsContent('ttl-verified.eth');
        expect(second.type).toBe('ok');
        expect(mockUrResolve).not.toHaveBeenCalled(); // cache hit
      } finally {
        Date.now = realNow;
      }
    });

    test('unverified cache expires after 60s (re-resolves on next call)', async () => {
      // Force unverified by giving only 1 non-quarantined provider.
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: [TEST_PROVIDERS[0]], // just one
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const first = await resolveEnsContent('ttl-unverified.eth');
      expect(first.trust.level).toBe('unverified');

      const realNow = Date.now;
      try {
        // 90s elapsed — past the 60s unverified TTL.
        Date.now = () => realNow() + 90_000;
        const coldCallsBefore = mockUrResolve.mock.calls.length;
        const second = await resolveEnsContent('ttl-unverified.eth');
        expect(second.type).toBe('ok');
        expect(mockUrResolve.mock.calls.length).toBeGreaterThan(coldCallsBefore);
      } finally {
        Date.now = realNow;
      }
    });

    test('degraded: only 1 non-quarantined provider → outcome=unverified', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: [TEST_PROVIDERS[0]],
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('single-source.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('unverified');
      expect(result.trust.queried.length).toBe(1);
    });

    test('quorum disabled: outcome=unverified even with K providers available', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: false, // explicit opt-out
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: TEST_PROVIDERS,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('no-quorum.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('unverified');
      // Only one leg fired despite 3 available providers.
      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });

    test('custom RPC fast-path: trust=user-configured, skips public quorum', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: true,
        ensRpcUrl: 'http://my-node.local:8545',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: TEST_PROVIDERS,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('my-node.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('user-configured');
      expect(result.trust.queried).toEqual(['my-node.local:8545']);
      // Only one leg fired against the custom RPC; public quorum untouched.
      expect(mockUrResolve).toHaveBeenCalledTimes(1);
    });

    test('custom RPC failure falls back to public quorum', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: true,
        ensRpcUrl: 'http://my-node.local:8545',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: TEST_PROVIDERS,
      });
      const bytes = urReturnsBytes(ipfsContenthashFor(IPFS_HASH));
      const networkErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
      routeByProvider(new Map([
        ['http://my-node.local:8545', { kind: 'reject', payload: networkErr }],
        [TEST_PROVIDERS[0], { kind: 'data', payload: bytes }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: bytes }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: bytes }],
      ]));

      const result = await resolveEnsContent('fallback-to-public.eth');

      expect(result.type).toBe('ok');
      // Fell back to public quorum — trust level reflects that, not user-configured.
      expect(result.trust.level).toBe('verified');
    });

    test('all providers error → throws (no positive result)', async () => {
      const err = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'reject', payload: err }],
        [TEST_PROVIDERS[1], { kind: 'reject', payload: err }],
        [TEST_PROVIDERS[2], { kind: 'reject', payload: err }],
      ]));

      await expect(resolveEnsContent('all-down.eth')).rejects.toThrow(/providers failed/i);
    });

    test('block pinning is cached within TTL (next resolve skips block fetch)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      await resolveEnsContent('block-cache-a.eth');
      const callsAfterFirst = mockGetBlock.mock.calls.length;

      // Different name → bypasses result cache but block anchor is still cached.
      await resolveEnsContent('block-cache-b.eth');

      // Anchor wave fetches from up to 2 providers in parallel on miss;
      // on cache hit it fetches 0. First resolve = N, second = N (no extra fetches).
      expect(mockGetBlock.mock.calls.length).toBe(callsAfterFirst);
    });

    test('in-flight dedup: concurrent resolves of same name share one quorum wave', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const [a, b, c] = await Promise.all([
        resolveEnsContent('concurrent.eth'),
        resolveEnsContent('concurrent.eth'),
        resolveEnsContent('concurrent.eth'),
      ]);

      expect(a.type).toBe('ok');
      expect(b).toBe(a); // same promise result
      expect(c).toBe(a);
      // Only K legs fired (not 3 × K), proving dedup.
      expect(mockUrResolve).toHaveBeenCalledTimes(3);
    });

    test('dedup key separates content from addr lookups for same name', async () => {
      mockUrResolve.mockImplementation((encodedName, callData) => {
        // Dispatch by call selector: 0xbc1c58d1 = contenthash, 0x3b3b57de = addr.
        if (callData.startsWith('0xbc1c58d1')) {
          return Promise.resolve(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));
        }
        return Promise.resolve(urReturnsAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'));
      });

      const [contentResult, addrResult] = await Promise.all([
        resolveEnsContent('dual.eth'),
        resolveEnsAddress('dual.eth'),
      ]);

      expect(contentResult.type).toBe('ok');
      expect(addrResult.success).toBe(true);
      // Both paths fired their own K legs; 6 total, proving the kind prefix
      // differentiates in-flight keys.
      expect(mockUrResolve).toHaveBeenCalledTimes(6);
    });
  });

  describe('security regressions', () => {
    const IPFS_HASH = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';
    const HONEST_HEAD = 20_000_000;
    const CURRENT_HASH = '0x' + 'c'.repeat(64);
    const STALE_HASH = '0x' + 's'.repeat(64);

    // A malicious RPC returning a valid-but-old block number must not be
    // able to pin stale ENS state: corroborated selection uses median +
    // M-quorum on the hash, so a single lying provider cannot force an
    // old anchor.
    test('single malicious RPC returning an old head cannot pin stale state', async () => {
      // 2 honest providers at current head + 1 attacker claiming head 1M
      // blocks ago. Median = honest head. At target = head - 8 the honest
      // providers return the current hash; attacker returns a stale hash
      // → hash quorum is M=2 of honest → verified at current state.
      mockProviderAnchorMap = new Map([
        [TEST_PROVIDERS[0], {
          headNumber: HONEST_HEAD - 1_000_000,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 1_000_008, hash: STALE_HASH }),
        }],
        [TEST_PROVIDERS[1], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: CURRENT_HASH }),
        }],
        [TEST_PROVIDERS[2], {
          headNumber: HONEST_HEAD + 1,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 7, hash: CURRENT_HASH }),
        }],
      ]);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('anti-stale.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('verified');
      expect(result.trust.block.hash).toBe(CURRENT_HASH);
    });

    // Same attack, but now the attacker colludes with itself by also
    // returning the stale hash at the honest target. With only one liar,
    // hash quorum still requires M=2 honest, so verification succeeds and
    // the result reflects the honest block, not the attacker's.
    test('lone malicious RPC cannot forge anchor hash quorum', async () => {
      mockProviderAnchorMap = new Map([
        [TEST_PROVIDERS[0], {
          headNumber: HONEST_HEAD - 500_000,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 500_008, hash: STALE_HASH }),
        }],
        [TEST_PROVIDERS[1], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: CURRENT_HASH }),
        }],
        [TEST_PROVIDERS[2], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: CURRENT_HASH }),
        }],
      ]);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('anti-stale-2.eth');

      expect(result.trust.level).toBe('verified');
      expect(result.trust.block.hash).toBe(CURRENT_HASH);
    });

    // If all providers disagree on the anchor hash, we refuse rather than
    // silently picking one.
    test('no hash quorum at anchor → resolution throws', async () => {
      mockProviderAnchorMap = new Map([
        [TEST_PROVIDERS[0], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: '0x' + 'a'.repeat(64) }),
        }],
        [TEST_PROVIDERS[1], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: '0x' + 'b'.repeat(64) }),
        }],
        [TEST_PROVIDERS[2], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: '0x' + 'c'.repeat(64) }),
        }],
      ]);

      await expect(resolveEnsContent('anchor-conflict.eth')).rejects.toThrow(/hash quorum/);
    });

    // Negative responses bucket by exact reason: M agreeing NO_RESOLVER
    // responses reach quorum even if a third provider returned a different
    // negative reason (here CCIP failure classed as NO_CONTENTHASH). The
    // odd-one-out does not block the verified outcome.
    test('2 NO_RESOLVER + 1 NO_CONTENTHASH → verified NO_RESOLVER (quorum still reached)', async () => {
      const resolverNotFoundErr = new Error('execution reverted: ResolverNotFound("foo.box")');
      const ccipErr = new Error('response not found during CCIP fetch: 3dns CCIP_001');
      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'reject', payload: resolverNotFoundErr }],
        [TEST_PROVIDERS[1], { kind: 'reject', payload: resolverNotFoundErr }],
        [TEST_PROVIDERS[2], { kind: 'reject', payload: ccipErr }],
      ]));

      const result = await resolveEnsContent('mixed-negative.eth');

      expect(result.type).toBe('not_found');
      expect(result.reason).toBe('NO_RESOLVER');
      expect(result.trust.level).toBe('verified');
    });

    // Three distinct responses — no bucket reaches M. Each surfaces as
    // its own conflict group; the renderer can show what each provider
    // claimed without silently collapsing mixed failures into a single
    // fake "verified" negative.
    test('1 NO_RESOLVER + 1 NO_CONTENTHASH + 1 data bytes → conflict (three distinct groups)', async () => {
      const resolverNotFoundErr = new Error('execution reverted: ResolverNotFound("foo.eth")');
      const ccipErr = new Error('response not found during CCIP fetch');
      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'reject', payload: resolverNotFoundErr }],
        [TEST_PROVIDERS[1], { kind: 'reject', payload: ccipErr }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: urReturnsBytes(ipfsContenthashFor(IPFS_HASH)) }],
      ]));

      const result = await resolveEnsContent('three-way-split.eth');

      expect(result.type).toBe('conflict');
      // Three distinct groups: data bytes, NO_RESOLVER, NO_CONTENTHASH.
      expect(result.groups.length).toBe(3);
      const reasons = result.groups.filter((g) => g.reason).map((g) => g.reason).sort();
      expect(reasons).toEqual(['NO_CONTENTHASH', 'NO_RESOLVER']);
    });

    // K=2 cannot safely produce a `verified` outcome: a single lying
    // provider within the drift window can shift the anchor into the
    // past, after which the honest provider faithfully returns the
    // historical hash, forming a fake agreement. The fix is structural —
    // K<3 falls through to the single-source unverified path.
    test('K=2 agreeing providers do not produce a verified outcome', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: [TEST_PROVIDERS[0], TEST_PROVIDERS[1]], // K=2
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('k2-unverified.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('unverified');
      expect(result.trust.queried.length).toBe(1);
      expect(result.trust.quorum.achieved).toBe(false);
    });

    // Even when K=2 providers would naturally agree on current-head
    // state, an attacker claiming a head within the safety-depth window
    // should not force a "verified" stale answer. Structural downgrade
    // to unverified makes this scenario safe by construction — the
    // trust shield reflects the genuine uncertainty.
    test('K=2 attacker-lowered head cannot produce verified stale state', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: [TEST_PROVIDERS[0], TEST_PROVIDERS[1]],
      });
      mockProviderAnchorMap = new Map([
        [TEST_PROVIDERS[0], {
          // Attacker claims 10 blocks in the past (within a hypothetical
          // drift tolerance that the OLD K=2 logic allowed).
          headNumber: HONEST_HEAD - 10,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 18, hash: STALE_HASH }),
        }],
        [TEST_PROVIDERS[1], {
          headNumber: HONEST_HEAD,
          getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: CURRENT_HASH }),
        }],
      ]);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('k2-attacker-lower.eth');

      expect(result.trust.level).toBe('unverified');
      expect(result.trust.quorum.achieved).toBe(false);
    });

    // Reliability regression: a single flaky provider in the initial
    // selection used to cascade into a hard-fail because the anchor step
    // only probed effectiveK URLs. The fix probes the whole available
    // pool, so healthy providers in the remainder still corroborate.
    test('one flaky provider in anchor pool does not fail resolution', async () => {
      const fiveProviders = [
        ...TEST_PROVIDERS,
        'https://test-d.example.com',
        'https://test-e.example.com',
      ];
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: fiveProviders,
      });
      // First provider in the pool errors on getBlockNumber; the other
      // four all respond cleanly. Resolution should still succeed.
      const flakyErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
      mockProviderAnchorMap = new Map([
        [TEST_PROVIDERS[0], { headNumber: flakyErr }],
      ]);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('one-flaky.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('verified');
    });

    // Runtime reliability: with exactly MIN_QUORUM_PROVIDERS in the pool,
    // a single flake during head collection used to throw because only 2
    // heads came back. Since the failed provider gets quarantined and a
    // retry would have degraded anyway, we downgrade on the first call
    // rather than surfacing a spurious error.
    test('3-provider pool with one flake downgrades to unverified (no throw)', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: TEST_PROVIDERS, // exactly 3
      });
      const flakyErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
      mockProviderAnchorMap = new Map([
        [TEST_PROVIDERS[0], { headNumber: flakyErr }], // one provider flakes
      ]);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('3-pool-one-flake.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('unverified');
    });

    // With the full-pool anchor probe, a "first bucket with ≥M" check
    // would let two colluding attackers anywhere in the pool pin a stale
    // hash if their bucket landed first in Map iteration order. The fix
    // picks the LARGEST bucket subject to a majority-of-respondents
    // threshold, so small collusions lose to the honest majority.
    test('2 colluders in 9-provider pool cannot poison anchor (plurality wins)', async () => {
      const nineProviders = [
        ...TEST_PROVIDERS,
        'https://test-d.example.com',
        'https://test-e.example.com',
        'https://test-f.example.com',
        'https://test-g.example.com',
        'https://test-h.example.com',
        'https://test-i.example.com',
      ];
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: nineProviders,
      });
      // 7 honest providers: head = HONEST_HEAD, canonical hash at target.
      // 2 colluding attackers: head = HONEST_HEAD, STALE hash at target.
      const honestAnchor = {
        headNumber: HONEST_HEAD,
        getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: CURRENT_HASH }),
      };
      const attackerAnchor = {
        headNumber: HONEST_HEAD,
        getBlock: () => Promise.resolve({ number: HONEST_HEAD - 8, hash: STALE_HASH }),
      };
      mockProviderAnchorMap = new Map([
        // Attackers at the front of the pool — matches worst-case Map
        // iteration order the old code was vulnerable to.
        [TEST_PROVIDERS[0], attackerAnchor],
        [TEST_PROVIDERS[1], attackerAnchor],
        [TEST_PROVIDERS[2], honestAnchor],
        ['https://test-d.example.com', honestAnchor],
        ['https://test-e.example.com', honestAnchor],
        ['https://test-f.example.com', honestAnchor],
        ['https://test-g.example.com', honestAnchor],
        ['https://test-h.example.com', honestAnchor],
        ['https://test-i.example.com', honestAnchor],
      ]);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('anchor-plurality.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('verified');
      expect(result.trust.block.hash).toBe(CURRENT_HASH);
    });

    // The anchor step can quarantine flaky providers during its head
    // probe. If the wave then uses the pre-anchor snapshot of `available`,
    // it immediately retries those bad providers and may land on
    // unverified_data from a single (potentially malicious) responder
    // while healthy providers sit idle in the later positions. The fix
    // refreshes `available` after getPinnedBlock so the wave selects from
    // the post-anchor, actually-healthy set.
    test('anchor-quarantined providers are excluded from the wave selection', async () => {
      const fiveProviders = [
        ...TEST_PROVIDERS, // p0, p1, p2
        'https://test-d.example.com',
        'https://test-e.example.com',
      ];
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: fiveProviders,
      });
      // Disable the provider-pool shuffle so the pre-anchor snapshot
      // deterministically has the flaky providers at positions 0 and 1,
      // which is exactly the case the pre-fix code mishandled.
      const origRandom = Math.random;
      Math.random = () => 0.999;
      try {
        invalidateCachedProvider(); // force re-shuffle with new Math.random
        const flakyErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
        mockProviderAnchorMap = new Map([
          // Flake on head probe → quarantined by the anchor step.
          [TEST_PROVIDERS[0], { headNumber: flakyErr }],
          [TEST_PROVIDERS[1], { headNumber: flakyErr }],
        ]);
        // Same providers also fail the Contract.resolve call, mirroring
        // real flaky nodes (they don't become healthy between anchor and
        // wave). Without the fix the wave would include p0 and p1 here
        // and land on unverified_data from the single healthy leg; with
        // the fix they're filtered out and three healthy providers reach
        // a verified quorum.
        routeByProvider(new Map([
          [TEST_PROVIDERS[0], { kind: 'reject', payload: flakyErr }],
          [TEST_PROVIDERS[1], { kind: 'reject', payload: flakyErr }],
          [TEST_PROVIDERS[2], { kind: 'data', payload: urReturnsBytes(ipfsContenthashFor(IPFS_HASH)) }],
          ['https://test-d.example.com', { kind: 'data', payload: urReturnsBytes(ipfsContenthashFor(IPFS_HASH)) }],
          ['https://test-e.example.com', { kind: 'data', payload: urReturnsBytes(ipfsContenthashFor(IPFS_HASH)) }],
        ]));

        const result = await resolveEnsContent('anchor-quarantine.eth');

        expect(result.type).toBe('ok');
        expect(result.trust.level).toBe('verified');
        expect(result.trust.queried.length).toBe(3);
      } finally {
        Math.random = origRandom;
      }
    });

    // Config regression: user-set ensQuorumK=2 no longer hard-fails at
    // the anchor step. Degrades to single-source unverified instead.
    test('ensQuorumK=2 with ample providers degrades to unverified, not error', async () => {
      const fiveProviders = [
        ...TEST_PROVIDERS,
        'https://test-d.example.com',
        'https://test-e.example.com',
      ];
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 2, // below the structural minimum of 3
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: fiveProviders,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('k2-configured.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('unverified');
      expect(result.trust.queried.length).toBe(1);
    });
  });

  describe('speculative gateway prefetch', () => {
    const IPFS_HASH = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';

    test('verified content resolution kicks off prefetch once, does not abort', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('prefetch-happy.eth');

      expect(result.type).toBe('ok');
      expect(mockPrefetchGatewayUrl).toHaveBeenCalledTimes(1);
      expect(mockPrefetchGatewayUrl).toHaveBeenCalledWith(`ipfs://${IPFS_HASH}`);
      // On verified, we let prefetch complete naturally — no abort.
      const handle = mockPrefetchGatewayUrl.mock.results[0].value;
      expect(handle.abort).not.toHaveBeenCalled();
    });

    test('conflict outcome aborts the in-flight prefetch', async () => {
      const hashA = 'a'.repeat(64);
      const hashB = 'b'.repeat(64);
      const hashC = 'c'.repeat(64);
      routeByProvider(new Map([
        [TEST_PROVIDERS[0], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashA)) }],
        [TEST_PROVIDERS[1], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashB)) }],
        [TEST_PROVIDERS[2], { kind: 'data', payload: urReturnsBytes(swarmContenthashFor(hashC)) }],
      ]));

      const result = await resolveEnsContent('prefetch-conflict.box');

      expect(result.type).toBe('conflict');
      expect(mockPrefetchGatewayUrl).toHaveBeenCalledTimes(1);
      const handle = mockPrefetchGatewayUrl.mock.results[0].value;
      expect(handle.abort).toHaveBeenCalledTimes(1);
    });

    test('addr-path resolution never prefetches (only content lookups do)', async () => {
      mockUrResolve.mockResolvedValue(
        urReturnsAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
      );

      await resolveEnsAddress('prefetch-addr.eth');

      expect(mockPrefetchGatewayUrl).not.toHaveBeenCalled();
    });

    test('custom-RPC fast path does not prefetch (single source is already fast)', async () => {
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: true,
        ensRpcUrl: 'http://my-node.local:8545',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: TEST_PROVIDERS,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('prefetch-custom.eth');

      expect(result.trust.level).toBe('user-configured');
      expect(mockPrefetchGatewayUrl).not.toHaveBeenCalled();
    });

    test('cache hit does not re-prefetch', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      await resolveEnsContent('prefetch-cached.eth');
      expect(mockPrefetchGatewayUrl).toHaveBeenCalledTimes(1);

      await resolveEnsContent('prefetch-cached.eth');
      // Second call is served from cache — consensusResolve isn't reached,
      // so prefetch isn't fired either.
      expect(mockPrefetchGatewayUrl).toHaveBeenCalledTimes(1);
    });

    test('unverified (single-source degraded) aborts prefetch', async () => {
      // One provider only → degraded single-source path. In this path we
      // DO call consensusResolve's inner leg directly, but the onFirstData
      // hook is only wired for the wave path — so prefetch should not
      // fire at all. (The degraded single-source path was chosen as NOT
      // prefetch-worthy: the user will see an interstitial either way.)
      mockLoadSettings.mockReturnValue({
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        enableEnsQuorum: true,
        ensQuorumK: 3,
        ensQuorumM: 2,
        ensQuorumTimeoutMs: 5000,
        ensBlockAnchor: 'latest',
        ensBlockAnchorTtlMs: 30000,
        ensPublicRpcProviders: [TEST_PROVIDERS[0]],
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('prefetch-degraded.eth');

      expect(result.trust.level).toBe('unverified');
      expect(mockPrefetchGatewayUrl).not.toHaveBeenCalled();
    });

    test('onFirstData errors do not break resolution (never affect quorum)', async () => {
      // Simulate a pathological prefetch that throws. The wave must still
      // complete normally and the result must still be `ok`.
      mockPrefetchGatewayUrl.mockImplementation(() => {
        throw new Error('prefetch internal error');
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('prefetch-throws.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('verified');
    });
  });
});
