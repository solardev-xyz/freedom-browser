// Mock electron ipcMain before requiring ens-resolver
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

// The persistent-log guard asserts on what reaches the logger, so the
// logger is a mock rather than electron-log's test-mode no-op.
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => mockLog);

// Private-ness is decided from the IPC sender; the registry itself needs a
// real BrowserWindow, so stub the one predicate ens-resolver uses.
jest.mock('./private/private-windows', () => ({
  isPrivateWebContents: (webContents) => webContents?.isPrivate === true,
}));

// Mock ens-prefetch so tests can assert when it fires and when it aborts,
// without spinning up a real net.request. Default impl returns a fresh
// abort-recording handle each call.
const mockPrefetchGatewayUrl = jest.fn();
jest.mock('./ens-prefetch', () => ({
  prefetchGatewayUrl: (...args) => mockPrefetchGatewayUrl(...args),
  PREFETCH_TIMEOUT_MS: 10_000,
}));

// Mock the network registry. Tests still pump a legacy-shaped settings
// object via mockLoadSettings; the registry mock translates it into the
// { getNetwork, getEndpoints } shape ens-resolver now reads, so existing
// test bodies keep working unchanged. Test provider list is small (3 URLs)
// so the quorum wave is bounded regardless of test input.
const TEST_PROVIDERS = [
  'https://test-a.example.com',
  'https://test-b.example.com',
  'https://test-c.example.com',
];
const mockLoadSettings = jest.fn(() => ({
  enableEnsCustomRpc: false,
  ensRpcUrl: '',
  ensResolutionMethod: 'quorum',
  ensColibriProverUrl: '',
  ensColibriZkProof: true,
  ensQuorumK: 3,
  ensQuorumM: 2,
  ensQuorumTimeoutMs: 5000,
  ensBlockAnchor: 'latest',
  ensBlockAnchorTtlMs: 30000,
  ensPublicRpcProviders: TEST_PROVIDERS,
}));
jest.mock('./networks/network-registry', () => {
  // Stand-in builtin RPC pool — what the registry yields when no list was
  // customized (mirrors the old DEFAULT_ENS_PUBLIC_RPC_PROVIDERS fallback).
  const DEFAULT_RPC = [
    'https://default-a.example.com',
    'https://default-b.example.com',
    'https://default-c.example.com',
  ];
  // The verification strategy the migration would derive from legacy keys.
  const legacyPrimary = (s) => {
    if (s.enableEnsCustomRpc === true || s.ensResolutionMethod === 'custom-rpc') return 'direct';
    return s.ensResolutionMethod || 'quorum';
  };
  const endpointSourceList = () => {
    const s = mockLoadSettings() || {};
    const list = [];
    if (s.enableEnsCustomRpc === true && (s.ensRpcUrl || '').trim()) {
      list.push({
        id: 'user-eth-custom', role: 'rpc', keyed: false,
        builtin: false, removed: false, coverage: { '1': s.ensRpcUrl.trim() },
      });
    }
    const pool = Array.isArray(s.ensPublicRpcProviders) && s.ensPublicRpcProviders.length > 0
      ? s.ensPublicRpcProviders
      : DEFAULT_RPC;
    pool.forEach((url, i) => list.push({
      id: 'eth-builtin-' + i, role: 'rpc', keyed: false,
      builtin: true, removed: false, coverage: { '1': url },
    }));
    return list;
  };
  return {
    getNetwork: () => {
      const s = mockLoadSettings() || {};
      const primary = legacyPrimary(s);
      return {
        chainId: 1,
        name: 'Ethereum',
        verification: {
          primary,
          ...(Array.isArray(s.ensResolutionOrder) ? { order: s.ensResolutionOrder } : {}),
          ...(typeof s.ensPreferVerified === 'boolean'
            ? { preferVerified: s.ensPreferVerified }
            : {}),
        },
        quorum: {
          k: s.ensQuorumK ?? 3,
          m: s.ensQuorumM ?? 2,
          timeoutMs: s.ensQuorumTimeoutMs ?? 5000,
          anchor: s.ensBlockAnchor ?? 'latest',
          anchorTtlMs: s.ensBlockAnchorTtlMs ?? 30000,
        },
        zkProof: s.ensColibriZkProof !== false,
      };
    },
    getEndpoints: (_chainId, role) => {
      const s = mockLoadSettings() || {};
      if (role === 'prover') {
        // Empty setting → the builtin prover (stand-in for colibri-corpus).
        return [(s.ensColibriProverUrl || 'https://test-prover.example').trim()];
      }
      const pool = Array.isArray(s.ensPublicRpcProviders) && s.ensPublicRpcProviders.length > 0
        ? s.ensPublicRpcProviders
        : DEFAULT_RPC;
      const custom = s.enableEnsCustomRpc === true && (s.ensRpcUrl || '').trim();
      return custom ? [custom, ...pool] : [...pool];
    },
    getEndpointSources: (chainId, role) => {
      const cid = String(chainId);
      return endpointSourceList()
        .filter((src) => src.role === role && !src.removed && src.coverage?.[cid])
        .map(({ builtin: _builtin, removed: _removed, ...src }) => src);
    },
    // The config view: a user-added rpc source when a custom RPC is set,
    // plus the builtin pool. Drives the `direct` user-configured-vs-builtin
    // trust decision in consensusResolve.
    getEndpointSourceList: endpointSourceList,
    invalidate: () => {},
  };
});

// Mocked Colibri resolver. The orchestrator branch in consensusResolve
// lazy-requires this; the lazy require sees the mocked module. Tests
// flip behavior per case via mockResolveViaColibri.
const mockResolveViaColibri = jest.fn();
const mockResolveReverseViaColibri = jest.fn();
jest.mock('./ens/colibri-resolver', () => ({
  resolveCallViaColibri: (...args) => mockResolveViaColibri(...args),
  resolveViaColibri: (...args) => mockResolveViaColibri(...args),
  resolveReverseViaColibri: (...args) => mockResolveReverseViaColibri(...args),
}));

// Myotis manager (experimental P2P light-client tier). Defaults to disabled
// so every pre-existing test sees the resolver exactly as before; the
// myotis-path suite flips these per test.
const mockMyotisIsEnabled = jest.fn(() => false);
const mockMyotisIsReady = jest.fn(() => false);
const mockMyotisResolveEnsRecord = jest.fn();
const mockMyotisEthCall = jest.fn();
const mockMyotisGetStatus = jest.fn(() => ({ optimisticBlockNumber: 23456800 }));
const mockMyotisGetAvailabilityEpoch = jest.fn(() => 0);
// Captures the resolver's module-load registration so tests can fire either
// availability direction and exercise cache/in-flight lifecycle behavior.
const mockMyotisAvailabilityListeners = [];
jest.mock('./myotis/myotis-manager', () => ({
  isEnabled: (...args) => mockMyotisIsEnabled(...args),
  isReady: (...args) => mockMyotisIsReady(...args),
  resolveEnsRecord: (...args) => mockMyotisResolveEnsRecord(...args),
  ethCall: (...args) => mockMyotisEthCall(...args),
  getStatus: (...args) => mockMyotisGetStatus(...args),
  getAvailabilityEpoch: (...args) => mockMyotisGetAvailabilityEpoch(...args),
  onAvailabilityTransition: (cb) => mockMyotisAvailabilityListeners.push(cb),
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
const mockWnsContenthash = jest.fn();
const mockWnsAddr = jest.fn();
const mockWnsReverseResolve = jest.fn();
const mockGnsContenthash = jest.fn();
const mockGnsAddr = jest.fn();
const mockGnsReverseResolve = jest.fn();

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

const WNS_ADDRESS = '0x0000000000696760e15f265e828db644a0c242eb';
const GNS_ADDRESS = '0x9d51d507bc7264d4fe8ad1cf7fe191933a0a81d6';
const ADDR_SELECTOR = '0x3b3b57de';

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
      Contract: jest.fn().mockImplementation((addr, _abi, provider) => ({
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
        contenthash: (...args) => {
          const lower = String(addr || '').toLowerCase();
          if (lower === GNS_ADDRESS) return mockGnsContenthash(...args);
          if (lower === WNS_ADDRESS) return mockWnsContenthash(...args);
          return mockWnsContenthash(...args);
        },
        addr: (...args) => {
          const lower = String(addr || '').toLowerCase();
          if (lower === GNS_ADDRESS) return mockGnsAddr(...args);
          if (lower === WNS_ADDRESS) return mockWnsAddr(...args);
          return mockWnsAddr(...args);
        },
        reverseResolve: (...args) => {
          const lower = String(addr || '').toLowerCase();
          if (lower === GNS_ADDRESS) return mockGnsReverseResolve(...args);
          if (lower === WNS_ADDRESS) return mockWnsReverseResolve(...args);
          return mockWnsReverseResolve(...args);
        },
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
      Interface: actual.Interface,
    },
  };
});

const { ethers } = require('ethers');
const {
  registerEnsIpc,
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  invalidateCachedProvider,
  clearEnsResolutionCaches,
  universalResolverCall,
  isResolverNotFoundError,
} = require('./ens-resolver');
const resolverLog = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');

// Fake block anchor — stable hash so consensus legs querying the same
// block get deterministic agreement.
const FAKE_BLOCK = { number: 12345678, hash: '0xabcdef0000000000000000000000000000000000000000000000000000000000' };

beforeEach(() => {
  jest.clearAllMocks();
  mockMyotisGetAvailabilityEpoch.mockImplementation(() => 0);
  invalidateCachedProvider();
  lastProviderUrl = null;
  mockProviderRouteMap = null;
  mockProviderAnchorMap = null;
  mockPrefetchGatewayUrl.mockImplementation(() => ({ abort: jest.fn() }));
  mockGetBlockNumber.mockResolvedValue(FAKE_BLOCK.number);
  mockGetBlock.mockResolvedValue(FAKE_BLOCK);
  mockGetResolver.mockResolvedValue(null);
  mockResolveName.mockResolvedValue(null);
  mockWnsContenthash.mockResolvedValue('0x');
  mockWnsAddr.mockResolvedValue('0x0000000000000000000000000000000000000000');
  mockWnsReverseResolve.mockResolvedValue('');
  mockGnsContenthash.mockResolvedValue('0x');
  mockGnsAddr.mockResolvedValue('0x0000000000000000000000000000000000000000');
  mockGnsReverseResolve.mockResolvedValue('');
  mockResolveViaColibri.mockResolvedValue({
    resolvedData: actualEthers.AbiCoder.defaultAbiCoder().encode(['string'], ['']),
    resolverAddress: WNS_ADDRESS,
  });
  mockLoadSettings.mockReturnValue({
    enableEnsCustomRpc: false,
    ensRpcUrl: '',
    ensResolutionMethod: 'quorum',
    ensColibriProverUrl: '',
    ensColibriZkProof: true,
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
    const WNS_WEI_RAW_CONTENTHASH =
      '0xe30101551220178009fb926120f294c60ebc3ae54de9dccaace22db785445f6f54a807b322fd';
    const WNS_WEI_CIDV1 = 'bafkreiaxqae7xetbedzjjrqoxq5oktpj3tfkzyrnw6cuix3pksuapmzc7u';

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

    test('resolves .wei contenthash through the WNS contract', async () => {
      mockWnsContenthash.mockResolvedValue(ipfsContenthashFor(IPFS_V0));

      const result = await resolveEnsContent('alice.wei');

      expect(result).toMatchObject({
        type: 'ok',
        name: 'alice.wei',
        system: 'wns',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${IPFS_V0}`,
        decoded: IPFS_V0,
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'wns' });
      expect(mockWnsContenthash).toHaveBeenCalledTimes(3);
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('decodes .wei CIDv1 raw contenthash through the WNS contract', async () => {
      mockWnsContenthash.mockResolvedValue(WNS_WEI_RAW_CONTENTHASH);

      const result = await resolveEnsContent('wns.wei');

      expect(result).toMatchObject({
        type: 'ok',
        name: 'wns.wei',
        system: 'wns',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${WNS_WEI_CIDV1}`,
        decoded: WNS_WEI_CIDV1,
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'wns' });
      expect(mockWnsContenthash).toHaveBeenCalledTimes(3);
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('resolves .gwei contenthash through the GNS contract', async () => {
      mockGnsContenthash.mockResolvedValue(ipfsContenthashFor(IPFS_V0));

      const result = await resolveEnsContent('apoorv.gwei');

      expect(result).toMatchObject({
        type: 'ok',
        name: 'apoorv.gwei',
        system: 'gns',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${IPFS_V0}`,
        decoded: IPFS_V0,
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'gns' });
      expect(mockGnsContenthash).toHaveBeenCalledTimes(3);
      expect(mockWnsContenthash).not.toHaveBeenCalled();
      expect(mockUrResolve).not.toHaveBeenCalled();
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

    test('returns EMPTY_CONTENTHASH for .wei names with no WNS contenthash', async () => {
      mockWnsContenthash.mockResolvedValue('0x');

      const result = await resolveEnsContent('empty.wei');

      expect(result).toMatchObject({
        type: 'not_found',
        reason: 'EMPTY_CONTENTHASH',
        name: 'empty.wei',
        system: 'wns',
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'wns' });
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

    test('does not cache transient NO_CONTENTHASH errors', async () => {
      mockUrResolve.mockRejectedValue(
        new Error('response not found during CCIP fetch: 3dnsService:: CCIP_001')
      );

      const first = await resolveEnsContent('transient-negative.box');
      const callsAfterFailure = mockUrResolve.mock.calls.length;

      expect(first.type).toBe('not_found');
      expect(first.reason).toBe('NO_CONTENTHASH');
      expect(first.error).toContain('CCIP');

      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const second = await resolveEnsContent('transient-negative.box');

      expect(second.type).toBe('ok');
      expect(second.uri).toBe(`ipfs://${IPFS_V0}`);
      expect(mockUrResolve.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    });

    test('makes K UR calls per cold resolution (one per quorum leg)', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      await resolveEnsContent('oneshot.eth');

      // Default test settings: K=3, matching TEST_PROVIDERS.length.
      expect(mockUrResolve).toHaveBeenCalledTimes(3);
    });

    test('pins every short-lived RPC provider to Ethereum Mainnet', async () => {
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      await resolveEnsContent('static-network.eth');

      expect(ethers.JsonRpcProvider).toHaveBeenCalled();
      for (const call of ethers.JsonRpcProvider.mock.calls) {
        expect(call).toEqual([
          expect.any(String),
          1,
          { staticNetwork: true },
        ]);
      }
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

    test('resolves .wei name to its WNS addr record', async () => {
      mockWnsAddr.mockResolvedValue('0x1111111111111111111111111111111111111111');

      const result = await resolveEnsAddress('alice.wei');

      expect(result).toMatchObject({
        success: true,
        name: 'alice.wei',
        system: 'wns',
        address: '0x1111111111111111111111111111111111111111',
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'wns' });
      expect(mockWnsAddr).toHaveBeenCalledTimes(3);
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('resolves .gwei name to its GNS addr record', async () => {
      mockGnsAddr.mockResolvedValue('0x2222222222222222222222222222222222222222');

      const result = await resolveEnsAddress('apoorv.gwei');

      expect(result).toMatchObject({
        success: true,
        name: 'apoorv.gwei',
        system: 'gns',
        address: '0x2222222222222222222222222222222222222222',
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'gns' });
      expect(mockGnsAddr).toHaveBeenCalledTimes(3);
      expect(mockWnsAddr).not.toHaveBeenCalled();
      expect(mockUrResolve).not.toHaveBeenCalled();
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

      expect(result).toMatchObject({
        success: true,
        address: input.toLowerCase(),
        name: 'verified1.eth',
        system: 'ens',
        trust: {
          level: 'verified',
          system: 'ens',
          quorum: { k: 3, m: 2, achieved: true },
        },
      });
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('surfaces conflicting reverse names when the RPC quorum disagrees', async () => {
      const input = addr('1014');
      mockUrReverse
        .mockResolvedValueOnce(['alice.eth', RESOLVER, RESOLVER])
        .mockResolvedValueOnce(['bob.eth', RESOLVER, RESOLVER])
        .mockResolvedValueOnce(['carol.eth', RESOLVER, RESOLVER]);

      const result = await resolveEnsReverse(input);

      expect(result).toMatchObject({
        success: false,
        address: input.toLowerCase(),
        system: 'ens',
        reason: 'CONFLICT',
        trust: {
          level: 'conflict',
          quorum: { k: 3, m: 2, achieved: false },
        },
      });
      expect(result.groups).toHaveLength(3);
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('falls back to WNS reverse when ENS has no primary name', async () => {
      const input = addr('1003');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);
      mockWnsReverseResolve.mockResolvedValue('alice.wei');
      mockWnsAddr.mockResolvedValue(input);

      const result = await resolveEnsReverse(input);

      expect(result).toMatchObject({
        success: true,
        address: input.toLowerCase(),
        name: 'alice.wei',
        system: 'wns',
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'wns' });
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
      expect(mockWnsReverseResolve).toHaveBeenCalledTimes(3);
      expect(mockWnsAddr).toHaveBeenCalledTimes(3);
    });

    test('falls back to GNS reverse after empty WNS reverse', async () => {
      const input = addr('1004');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);
      mockWnsReverseResolve.mockResolvedValue('');
      mockGnsReverseResolve.mockResolvedValue('apoorv.gwei');
      mockGnsAddr.mockResolvedValue(input);

      const result = await resolveEnsReverse(input);

      expect(result).toMatchObject({
        success: true,
        address: input.toLowerCase(),
        name: 'apoorv.gwei',
        system: 'gns',
      });
      expect(result.trust).toMatchObject({ level: 'verified', system: 'gns' });
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
      expect(mockWnsReverseResolve).toHaveBeenCalledTimes(3);
      expect(mockGnsReverseResolve).toHaveBeenCalledTimes(3);
      expect(mockGnsAddr).toHaveBeenCalledTimes(3);
    });

    test('returns UNVERIFIED when WNS reverse does not forward-resolve to the address', async () => {
      const input = addr('1010');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);
      mockWnsReverseResolve.mockResolvedValue('spoof.wei');
      mockWnsAddr.mockResolvedValue(addr('9999'));

      const result = await resolveEnsReverse(input);

      expect(result).toMatchObject({
        success: false,
        address: input.toLowerCase(),
        system: 'wns',
        reason: 'UNVERIFIED',
        claimedName: 'spoof.wei',
      });
      expect(result.name).toBeUndefined();
      expect(result.trust).toMatchObject({ level: 'verified', system: 'wns' });
      expect(mockWnsReverseResolve).toHaveBeenCalledTimes(3);
      expect(mockWnsAddr).toHaveBeenCalledTimes(3);
    });

    test('returns UNVERIFIED when GNS reverse does not forward-resolve to the address', async () => {
      const input = addr('1011');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);
      mockWnsReverseResolve.mockResolvedValue('');
      mockGnsReverseResolve.mockResolvedValue('spoof.gwei');
      mockGnsAddr.mockResolvedValue(addr('9998'));

      const result = await resolveEnsReverse(input);

      expect(result).toMatchObject({
        success: false,
        address: input.toLowerCase(),
        system: 'gns',
        reason: 'UNVERIFIED',
        claimedName: 'spoof.gwei',
      });
      expect(result.name).toBeUndefined();
      expect(result.trust).toMatchObject({ level: 'verified', system: 'gns' });
      expect(mockGnsReverseResolve).toHaveBeenCalledTimes(3);
      expect(mockGnsAddr).toHaveBeenCalledTimes(3);
    });

    test('short-caches unverified contract-backed reverse claims', async () => {
      const input = addr('1012');
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValue(1_000_000);
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);
      mockWnsReverseResolve.mockResolvedValue('stale.wei');
      mockWnsAddr.mockResolvedValue(addr('9997'));

      try {
        await resolveEnsReverse(input);
        await resolveEnsReverse(input);
        expect(mockWnsReverseResolve).toHaveBeenCalledTimes(3);

        now.mockReturnValue(1_061_000);
        await resolveEnsReverse(input);

        expect(mockWnsReverseResolve).toHaveBeenCalledTimes(6);
      } finally {
        now.mockRestore();
      }
    });

    test('UNVERIFIED when UR reverts with ReverseAddressMismatch', async () => {
      const input = addr('1002');
      const err = new Error('execution reverted: ReverseAddressMismatch');
      err.data = '0xef9c03ce00000000000000000000000000000000';
      mockUrReverse.mockRejectedValue(err);

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('UNVERIFIED');
      expect(result.claimedName).toBeNull();
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
        .mockResolvedValue(['retry-reverse.eth', RESOLVER, RESOLVER]);

      const result = await resolveEnsReverse(input);

      expect(result.success).toBe(true);
      expect(result.name).toBe('retry-reverse.eth');
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('caches successful verified results', async () => {
      const input = addr('1008');
      mockUrReverse.mockResolvedValue(['cached.eth', RESOLVER, RESOLVER]);

      await resolveEnsReverse(input);
      await resolveEnsReverse(input);

      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('caches NO_REVERSE negative results too', async () => {
      const input = addr('1009');
      mockUrReverse.mockResolvedValue(['', RESOLVER, RESOLVER]);

      await resolveEnsReverse(input);
      await resolveEnsReverse(input);

      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('normalizes input address to lowercase for caching', async () => {
      const input = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa10101010';
      mockUrReverse.mockResolvedValue(['mixed.eth', RESOLVER, RESOLVER]);

      await resolveEnsReverse(input);
      await resolveEnsReverse(input.toLowerCase());

      // Second call hits the cache keyed on lowercase form.
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('direct reverse resolution only queries the selected custom RPC', async () => {
      const input = addr('1013');
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        enableEnsCustomRpc: true,
        ensRpcUrl: 'https://user-rpc.example.com',
        ensResolutionOrder: ['direct'],
      });
      mockUrReverse.mockResolvedValue(['direct.eth', RESOLVER, RESOLVER]);

      const result = await resolveEnsReverse(input);

      expect(result).toMatchObject({
        success: true,
        name: 'direct.eth',
        trust: { level: 'user-configured' },
      });
      expect(mockUrReverse).toHaveBeenCalledTimes(1);
      expect(mockGetBlockNumber).toHaveBeenCalledTimes(1);
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
  describe('experimental myotis path', () => {
    const IPFS_V0 = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';

    const myotisUp = () => {
      mockMyotisIsEnabled.mockImplementation(() => true);
      mockMyotisIsReady.mockImplementation(() => true);
    };

    afterEach(() => {
      mockMyotisIsEnabled.mockImplementation(() => false);
      mockMyotisIsReady.mockImplementation(() => false);
    });

    test('serves verified contenthash from the local P2P node without touching RPC or colibri', async () => {
      myotisUp();
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: true,
        blockNumber: 23456789,
        dataHex: ipfsContenthashFor(IPFS_V0),
      });

      const result = await resolveEnsContent('myotis-ok.eth');

      expect(result).toMatchObject({
        type: 'ok',
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${IPFS_V0}`,
      });
      expect(result.trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
        block: 23456789,
      });
      expect(mockMyotisResolveEnsRecord).toHaveBeenCalledWith({
        method: 'contenthash',
        name: 'myotis-ok.eth',
        root: 'auto',
      });
      expect(mockUrResolve).not.toHaveBeenCalled();
      expect(mockResolveViaColibri).not.toHaveBeenCalled();
    });

    test('serves verified ENS addr records through the same Myotis tier', async () => {
      myotisUp();
      const address = '0x1111111111111111111111111111111111111111';
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: true,
        blockNumber: 23456789,
        addressHex: address,
      });

      const result = await resolveEnsAddress('myotis-addr.eth');

      expect(result).toMatchObject({
        success: true,
        name: 'myotis-addr.eth',
        address,
        trust: { level: 'verified', method: 'myotis', block: 23456789 },
      });
      expect(mockMyotisResolveEnsRecord).toHaveBeenCalledWith({
        method: 'addr',
        name: 'myotis-addr.eth',
        root: 'auto',
      });
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('serves forward-verified ENS reverse records through Myotis', async () => {
      myotisUp();
      const address = '0x0000000000000000000000000000000000001201';
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: true,
        blockNumber: 23456789,
        name: 'reverse-myotis.eth',
      });

      const result = await resolveEnsReverse(address);

      expect(result).toMatchObject({
        success: true,
        address,
        name: 'reverse-myotis.eth',
        system: 'ens',
        trust: { level: 'verified', method: 'myotis' },
      });
      expect(mockMyotisResolveEnsRecord).toHaveBeenCalledWith({
        method: 'reverse',
        addressHex: address,
        root: 'auto',
      });
      expect(mockUrReverse).not.toHaveBeenCalled();
    });

    test('accepts an optimistic beacon-verified reverse answer without duplicate fallback', async () => {
      myotisUp();
      const address = '0x0000000000000000000000000000000000001210';
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        ensResolutionMethod: 'colibri',
        ensResolutionOrder: ['myotis', 'colibri', 'quorum'],
        ensPreferVerified: true,
      });
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: false,
        blockNumber: 23456790,
        name: 'optimistic.eth',
      });
      mockResolveReverseViaColibri.mockResolvedValue({ name: 'verified.eth' });

      const result = await resolveEnsReverse(address);

      expect(result).toMatchObject({
        success: true,
        name: 'optimistic.eth',
        trust: { level: 'verified', method: 'myotis', finality: 'optimistic' },
      });
      expect(mockResolveReverseViaColibri).not.toHaveBeenCalled();
      expect(mockUrReverse).not.toHaveBeenCalled();
    });

    test('accepts a complete optimistic Myotis reverse miss without repeating ENS remotely', async () => {
      myotisUp();
      const address = '0x0000000000000000000000000000000000001211';
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        ensResolutionMethod: 'colibri',
        ensResolutionOrder: ['myotis', 'colibri', 'quorum'],
        ensPreferVerified: true,
      });
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'noRecord',
        verified: false,
        blockNumber: 23456791,
      });
      mockMyotisEthCall.mockResolvedValue({
        status: 'ok',
        resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(['string'], ['']),
      });

      const result = await resolveEnsReverse(address);

      expect(result).toMatchObject({
        success: false,
        reason: 'NO_REVERSE',
        trust: { level: 'verified', method: 'myotis', finality: 'optimistic' },
      });
      expect(mockMyotisResolveEnsRecord).toHaveBeenCalledTimes(1);
      expect(mockMyotisEthCall).toHaveBeenCalledTimes(2);
      expect(mockResolveReverseViaColibri).not.toHaveBeenCalled();
      expect(mockResolveViaColibri).not.toHaveBeenCalled();
      expect(mockUrReverse).not.toHaveBeenCalled();
    });

    test('optimistic answers are verified while remaining explicitly non-finalized', async () => {
      myotisUp();
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: false,
        blockNumber: 23456790,
        dataHex: ipfsContenthashFor(IPFS_V0),
      });

      const result = await resolveEnsContent('myotis-peerhead.eth');

      expect(result.type).toBe('ok');
      expect(result.trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
      });
    });

    test('does not repeat an optimistic Myotis answer through Colibri', async () => {
      myotisUp();
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        ensResolutionMethod: 'colibri',
        ensResolutionOrder: ['myotis', 'colibri', 'quorum'],
        ensPreferVerified: true,
      });
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: false,
        blockNumber: 23456790,
        dataHex: ipfsContenthashFor(IPFS_V0),
      });
      const result = await resolveEnsContent('prefer-verified.eth');

      expect(mockMyotisResolveEnsRecord).toHaveBeenCalled();
      expect(mockResolveViaColibri).not.toHaveBeenCalled();
      expect(result.trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
      });
    });

    test('honors custom method order and does not invoke lower-priority methods after success', async () => {
      myotisUp();
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        ensResolutionMethod: 'colibri',
        ensResolutionOrder: ['colibri', 'myotis', 'quorum'],
        ensPreferVerified: true,
      });
      const [resolvedData, resolverAddress] = urReturnsBytes(ipfsContenthashFor(IPFS_V0));
      mockResolveViaColibri.mockResolvedValue({ resolvedData, resolverAddress });

      const result = await resolveEnsContent('colibri-first.eth');

      expect(result.trust).toMatchObject({ level: 'verified', method: 'colibri' });
      expect(mockMyotisResolveEnsRecord).not.toHaveBeenCalled();
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('does not consult a later method after an optimistic verified answer', async () => {
      myotisUp();
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        ensResolutionMethod: 'colibri',
        ensResolutionOrder: ['myotis', 'colibri'],
        ensPreferVerified: true,
      });
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: false,
        blockNumber: 23456790,
        dataHex: ipfsContenthashFor(IPFS_V0),
      });
      const result = await resolveEnsContent('provisional-fallback.eth');

      expect(result.type).toBe('ok');
      expect(result.trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
      });
      expect(mockResolveViaColibri).not.toHaveBeenCalled();
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('excludes disabled methods from resolution entirely', async () => {
      myotisUp();
      mockLoadSettings.mockReturnValue({
        ...mockLoadSettings(),
        ensResolutionOrder: ['quorum'],
        ensPreferVerified: true,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('quorum-only.eth');

      expect(result.type).toBe('ok');
      expect(mockMyotisResolveEnsRecord).not.toHaveBeenCalled();
      expect(mockResolveViaColibri).not.toHaveBeenCalled();
      expect(mockUrResolve).toHaveBeenCalled();
    });

    test('verified absence maps to EMPTY_CONTENTHASH', async () => {
      myotisUp();
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'noRecord',
        verified: true,
        blockNumber: 23456791,
      });

      const result = await resolveEnsContent('myotis-norecord.eth');

      expect(result).toMatchObject({ type: 'not_found', reason: 'EMPTY_CONTENTHASH' });
      expect(result.trust).toMatchObject({ level: 'verified', method: 'myotis' });
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('node not synced yet: silent fall-through to the quorum path', async () => {
      mockMyotisIsEnabled.mockImplementation(() => true);
      mockMyotisIsReady.mockImplementation(() => false);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));
      const infoSpy = jest.spyOn(resolverLog, 'info').mockImplementation(() => {});

      const result = await resolveEnsContent('myotis-notready.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.method).not.toBe('myotis');
      expect(mockMyotisResolveEnsRecord).not.toHaveBeenCalled();
      expect(mockUrResolve).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        '[ens] policy name=myotis-notready.eth kind=content ' +
        'order=[myotis,quorum] preferVerified=false'
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[ens\] method=myotis name=myotis-notready\.eth kind=content outcome=SKIP trust=none action=continue reason=not-ready durationMs=\d+$/
        )
      );
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[ens\] method=quorum name=myotis-notready\.eth kind=content outcome=DATA trust=verified action=accept reason=none durationMs=\d+$/
        )
      );
      infoSpy.mockRestore();
    });

    test('discards a Myotis read interrupted by shutdown and resolves once through Colibri', async () => {
      let ready = true;
      let epoch = 1;
      let finishMyotis;
      mockMyotisIsEnabled.mockImplementation(() => true);
      mockMyotisIsReady.mockImplementation(() => ready);
      mockMyotisGetAvailabilityEpoch.mockImplementation(() => epoch);
      mockMyotisResolveEnsRecord.mockImplementation(() => new Promise((resolve) => {
        finishMyotis = resolve;
      }));
      withColibri({
        ensResolutionOrder: ['myotis', 'colibri'],
        ensPreferVerified: true,
      });
      const [resolvedData, resolverAddress] = urReturnsBytes(ipfsContenthashFor(IPFS_V0));
      mockResolveViaColibri.mockResolvedValue({ resolvedData, resolverAddress });

      const pending = resolveEnsContent('shutdown-race.eth');
      await Promise.resolve();
      expect(mockMyotisResolveEnsRecord).toHaveBeenCalledTimes(1);

      ready = false;
      epoch = 2;
      for (const cb of mockMyotisAvailabilityListeners) {
        cb({ chainId: 1, ready: false, reason: 'stopping', epoch });
      }
      finishMyotis({
        status: 'ok',
        verified: true,
        blockNumber: 23456801,
        dataHex: ipfsContenthashFor(IPFS_V0),
      });

      const result = await pending;

      expect(result).toMatchObject({
        type: 'ok',
        uri: `ipfs://${IPFS_V0}`,
        trust: { level: 'verified', method: 'colibri' },
      });
      expect(mockResolveViaColibri).toHaveBeenCalledTimes(1);
    });

    test('unavailable transition evicts a cached Myotis answer before the next lookup', async () => {
      let ready = true;
      let epoch = 1;
      mockMyotisIsEnabled.mockImplementation(() => true);
      mockMyotisIsReady.mockImplementation(() => ready);
      mockMyotisGetAvailabilityEpoch.mockImplementation(() => epoch);
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'ok',
        verified: true,
        blockNumber: 23456802,
        dataHex: ipfsContenthashFor(IPFS_V0),
      });

      const first = await resolveEnsContent('shutdown-cache.eth');
      expect(first.trust.method).toBe('myotis');

      ready = false;
      epoch = 2;
      for (const cb of mockMyotisAvailabilityListeners) {
        cb({ chainId: 1, ready: false, reason: 'stopping', epoch });
      }
      withColibri({
        ensResolutionOrder: ['myotis', 'colibri'],
        ensPreferVerified: true,
      });
      const [resolvedData, resolverAddress] = urReturnsBytes(ipfsContenthashFor(IPFS_V0));
      mockResolveViaColibri.mockResolvedValue({ resolvedData, resolverAddress });

      const second = await resolveEnsContent('shutdown-cache.eth');

      expect(second.trust.method).toBe('colibri');
      expect(mockResolveViaColibri).toHaveBeenCalledTimes(1);
    });

    test('engine failure falls through to the quorum path', async () => {
      myotisUp();
      mockMyotisResolveEnsRecord.mockRejectedValue(new Error('no snap peer'));
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('myotis-enginefail.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.method).not.toBe('myotis');
      expect(mockUrResolve).toHaveBeenCalled();
    });

    test('malformed CCIP offchain envelopes fall back to the configured resolver', async () => {
      myotisUp();
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'offchain',
        verified: true,
        blockNumber: 23456792,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('myotis-offchain.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.method).not.toBe('myotis');
      expect(mockUrResolve).toHaveBeenCalled();
    });

    test('completes a CCIP-Read gateway round and verifies the callback in Myotis', async () => {
      myotisUp();
      const originalFetch = global.fetch;
      const gatewayData = '0xabcdef';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        text: jest.fn().mockResolvedValue(JSON.stringify({ data: gatewayData })),
      });
      mockMyotisResolveEnsRecord
        .mockResolvedValueOnce({
          status: 'offchain',
          verified: true,
          blockNumber: 23456792,
          senderHex: '0x1111111111111111111111111111111111111111',
          urls: ['https://ccip.example/{sender}/{data}.json'],
          callDataHex: '0x1234',
          callbackFunctionHex: '0xaabbccdd',
          extraDataHex: '0x5678',
          wrapped: true,
        })
        .mockResolvedValueOnce({
          status: 'ok',
          verified: true,
          blockNumber: 23456792,
          dataHex: ipfsContenthashFor(IPFS_V0),
        });

      try {
        const result = await resolveEnsContent('myotis-ccip.box');

        expect(result).toMatchObject({
          type: 'ok',
          uri: `ipfs://${IPFS_V0}`,
          trust: { level: 'verified', method: 'myotis' },
        });
        expect(global.fetch).toHaveBeenCalledWith(
          'https://ccip.example/0x1111111111111111111111111111111111111111/0x1234.json',
          expect.objectContaining({ method: 'GET' })
        );
        expect(mockMyotisResolveEnsRecord).toHaveBeenNthCalledWith(2, {
          method: 'ccipCallback',
          name: 'myotis-ccip.box',
          root: 'auto',
          queryMethod: 'contenthash',
          senderHex: '0x1111111111111111111111111111111111111111',
          callbackFunctionHex: '0xaabbccdd',
          responseHex: gatewayData,
          extraDataHex: '0x5678',
          wrapped: true,
          finalized: true,
        });
        expect(mockUrResolve).not.toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('uses POST CCIP gateways and tries the next URL after a bad response', async () => {
      myotisUp();
      const originalFetch = global.fetch;
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          text: jest.fn().mockResolvedValue('{"notData":"0x"}'),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: { get: jest.fn(() => null) },
          text: jest.fn().mockResolvedValue('{"data":"0xcafe"}'),
        });
      mockMyotisResolveEnsRecord
        .mockResolvedValueOnce({
          status: 'offchain',
          verified: false,
          blockNumber: 23456793,
          senderHex: '0x2222222222222222222222222222222222222222',
          urls: ['https://bad.example/query', 'https://good.example/query'],
          callDataHex: '0xbeef',
          callbackFunctionHex: '0x01020304',
          extraDataHex: '0x',
          wrapped: false,
        })
        .mockResolvedValueOnce({
          status: 'noRecord',
          verified: false,
          blockNumber: 23456793,
        });

      try {
        const result = await resolveEnsContent('myotis-ccip-post.box');

        expect(result).toMatchObject({
          type: 'not_found',
          reason: 'EMPTY_CONTENTHASH',
          trust: { level: 'verified', method: 'myotis', finality: 'optimistic' },
        });
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[1][1]).toMatchObject({
          method: 'POST',
          body: JSON.stringify({
            sender: '0x2222222222222222222222222222222222222222',
            data: '0xbeef',
          }),
        });
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('reads the top-level CCIP data field instead of matching JSON string contents', async () => {
      myotisUp();
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        text: jest.fn().mockResolvedValue(
          JSON.stringify({ message: 'ignore "data": "0x00"', data: '0xcafe' })
        ),
      });
      mockMyotisResolveEnsRecord
        .mockResolvedValueOnce({
          status: 'offchain',
          verified: true,
          blockNumber: 23456793,
          senderHex: '0x2222222222222222222222222222222222222222',
          urls: ['https://ccip.example/query'],
          callDataHex: '0xbeef',
          callbackFunctionHex: '0x01020304',
          extraDataHex: '0x',
          wrapped: false,
        })
        .mockResolvedValueOnce({
          status: 'noRecord',
          verified: true,
          blockNumber: 23456793,
        });

      try {
        await resolveEnsContent('myotis-ccip-json.box');
        expect(mockMyotisResolveEnsRecord).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({ responseHex: '0xcafe' })
        );
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('caps recursive CCIP-Read at one gateway round and falls back safely', async () => {
      myotisUp();
      const originalFetch = global.fetch;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: jest.fn(() => null) },
        text: jest.fn().mockResolvedValue('{"data":"0xcafe"}'),
      });
      const offchain = {
        status: 'offchain',
        verified: true,
        blockNumber: 23456793,
        senderHex: '0x2222222222222222222222222222222222222222',
        urls: ['https://recursive.example/{data}'],
        callDataHex: '0xbeef',
        callbackFunctionHex: '0x01020304',
        extraDataHex: '0x',
        wrapped: false,
      };
      mockMyotisResolveEnsRecord.mockResolvedValue(offchain);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      try {
        const result = await resolveEnsContent('myotis-recursive.box');

        expect(result.type).toBe('ok');
        expect(result.trust.method).not.toBe('myotis');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(mockMyotisResolveEnsRecord).toHaveBeenCalledTimes(2);
        expect(mockUrResolve).toHaveBeenCalled();
      } finally {
        global.fetch = originalFetch;
      }
    });

    test('ready transition sweeps cached content, address, and reverse fallback answers', async () => {
      // 1. Node syncing: RPC paths serve and cache every lookup kind.
      mockMyotisIsEnabled.mockImplementation(() => true);
      mockMyotisIsReady.mockImplementation(() => false);
      const address = '0x0000000000000000000000000000000000001203';
      mockUrResolve.mockImplementation((_name, callData) =>
        String(callData).startsWith(ADDR_SELECTOR)
          ? urReturnsAddress(address)
          : urReturnsBytes(ipfsContenthashFor(IPFS_V0))
      );
      mockUrReverse.mockResolvedValue(['myotis-overtake-reverse.eth']);
      const firstContent = await resolveEnsContent('myotis-overtake.eth');
      const firstAddress = await resolveEnsAddress('myotis-overtake-addr.eth');
      const firstReverse = await resolveEnsReverse(address);
      expect(firstContent.trust.method).not.toBe('myotis');
      expect(firstAddress.trust.method).not.toBe('myotis');
      expect(firstReverse.trust).toMatchObject({
        level: 'verified',
        quorum: { k: 3, m: 2, achieved: true },
      });

      // 2. Node becomes ready — but the cached fallback answers still win…
      mockMyotisIsReady.mockImplementation(() => true);
      mockMyotisResolveEnsRecord.mockImplementation(async (params) => {
        if (params.method === 'contenthash') {
          return {
            status: 'ok',
            verified: true,
            blockNumber: 23456799,
            dataHex: ipfsContenthashFor(IPFS_V0),
          };
        }
        if (params.method === 'addr') {
          return { status: 'ok', verified: true, blockNumber: 23456799, addressHex: address };
        }
        return {
          status: 'ok',
          verified: true,
          blockNumber: 23456799,
          name: 'myotis-overtake-reverse.eth',
        };
      });
      expect((await resolveEnsContent('myotis-overtake.eth')).trust.method).not.toBe('myotis');
      expect((await resolveEnsAddress('myotis-overtake-addr.eth')).trust.method).not.toBe('myotis');
      expect((await resolveEnsReverse(address)).trust.method).not.toBe('myotis');

      // 3. …until the ready transition sweeps all three caches.
      expect(mockMyotisAvailabilityListeners.length).toBeGreaterThan(0);
      for (const cb of mockMyotisAvailabilityListeners) {
        cb({ chainId: 1, ready: true, reason: 'ready', epoch: 1 });
      }
      expect((await resolveEnsContent('myotis-overtake.eth')).trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
      });
      expect((await resolveEnsAddress('myotis-overtake-addr.eth')).trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
      });
      expect((await resolveEnsReverse(address)).trust).toMatchObject({
        level: 'verified',
        method: 'myotis',
      });
    });

    test('resolves WNS content through Myotis generic verified eth_call', async () => {
      myotisUp();
      mockMyotisEthCall.mockResolvedValue({
        status: 'ok',
        resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(
          ['bytes'],
          [ipfsContenthashFor(IPFS_V0)]
        ),
      });

      const result = await resolveEnsContent('myotis-wns.wei');

      expect(result).toMatchObject({
        type: 'ok',
        system: 'wns',
        uri: `ipfs://${IPFS_V0}`,
        trust: {
          level: 'verified',
          method: 'myotis',
          system: 'wns',
          finality: 'optimistic',
        },
      });
      expect(mockMyotisEthCall.mock.calls[0][0].to.toLowerCase()).toBe(WNS_ADDRESS);
      expect(mockMyotisEthCall.mock.calls[0][0].block).toBe('latest');
      expect(mockWnsContenthash).not.toHaveBeenCalled();
    });

    test('resolves GNS addr records through Myotis generic verified eth_call', async () => {
      myotisUp();
      const address = '0x3333333333333333333333333333333333333333';
      mockMyotisEthCall.mockResolvedValue({
        status: 'ok',
        resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(['address'], [address]),
      });

      const result = await resolveEnsAddress('myotis-gns.gwei');

      expect(result).toMatchObject({
        success: true,
        system: 'gns',
        address,
        trust: {
          level: 'verified',
          method: 'myotis',
          system: 'gns',
          finality: 'optimistic',
        },
      });
      expect(mockMyotisEthCall.mock.calls[0][0].to.toLowerCase()).toBe(GNS_ADDRESS);
      expect(mockMyotisEthCall.mock.calls[0][0].block).toBe('latest');
      expect(mockGnsAddr).not.toHaveBeenCalled();
    });

    test('forward-verifies WNS reverse claims through Myotis contract calls', async () => {
      myotisUp();
      const address = '0x0000000000000000000000000000000000001202';
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'noRecord',
        verified: true,
        blockNumber: 23456794,
      });
      mockMyotisEthCall
        .mockResolvedValueOnce({
          status: 'ok',
          resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(['string'], ['alice.wei']),
        })
        .mockResolvedValueOnce({
          status: 'ok',
          resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(['address'], [address]),
        });

      const result = await resolveEnsReverse(address);

      expect(result).toMatchObject({
        success: true,
        name: 'alice.wei',
        system: 'wns',
        trust: {
          level: 'verified',
          method: 'myotis',
          system: 'wns',
          finality: 'optimistic',
        },
      });
      expect(mockMyotisEthCall).toHaveBeenCalledTimes(2);
      expect(mockUrReverse).not.toHaveBeenCalled();
      expect(mockWnsReverseResolve).not.toHaveBeenCalled();
    });

    test('rejects a WNS reverse claim that does not forward-resolve through Myotis', async () => {
      myotisUp();
      const address = '0x0000000000000000000000000000000000001204';
      mockMyotisResolveEnsRecord.mockResolvedValue({
        status: 'noRecord',
        verified: true,
        blockNumber: 23456795,
      });
      mockMyotisEthCall
        .mockResolvedValueOnce({
          status: 'ok',
          resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(['string'], ['spoof.wei']),
        })
        .mockResolvedValueOnce({
          status: 'ok',
          resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(
            ['address'],
            ['0x9999999999999999999999999999999999999999']
          ),
        })
        .mockResolvedValueOnce({
          status: 'ok',
          resultHex: actualEthers.AbiCoder.defaultAbiCoder().encode(['string'], ['']),
        });

      const result = await resolveEnsReverse(address);

      expect(result).toMatchObject({
        success: false,
        reason: 'UNVERIFIED',
        claimedName: 'spoof.wei',
        system: 'wns',
        trust: { level: 'verified', method: 'myotis', finality: 'optimistic' },
      });
      expect(mockUrReverse).not.toHaveBeenCalled();
    });
  });

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

    test('direct method with no custom RPC resolves unverified, not user-configured', async () => {
      // `direct` strategy but no user-added endpoint — it falls to a builtin
      // public RPC, which is an unverified single source, not something the
      // user configured.
      mockLoadSettings.mockReturnValue({
        ensResolutionMethod: 'custom-rpc',
        enableEnsCustomRpc: false,
        ensRpcUrl: '',
        ensPublicRpcProviders: TEST_PROVIDERS,
      });
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_HASH)));

      const result = await resolveEnsContent('no-custom.eth');

      expect(result.type).toBe('ok');
      expect(result.trust.level).toBe('unverified');
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

  describe('second-wave escalation on unverified', () => {
    const IPFS_HASH = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';
    const ALT_HASH = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';

    function fivePoolWithDeterministicOrder(extraSettings = {}) {
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
        ...extraSettings,
      });
      // Disable shuffle so firstSelection is the first 3 providers and
      // remaining is the last 2 — deterministic for test assertions.
      const origRandom = Math.random;
      Math.random = () => 0.999;
      invalidateCachedProvider();
      return { fiveProviders, restore: () => { Math.random = origRandom; } };
    }

    test('1 data + 2 errors → escalates and reaches verified via fresh providers', async () => {
      const { restore } = fivePoolWithDeterministicOrder();
      try {
        const flakyErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
        const goodPayload = urReturnsBytes(ipfsContenthashFor(IPFS_HASH));
        routeByProvider(new Map([
          [TEST_PROVIDERS[0], { kind: 'data', payload: goodPayload }],
          [TEST_PROVIDERS[1], { kind: 'reject', payload: flakyErr }],
          [TEST_PROVIDERS[2], { kind: 'reject', payload: flakyErr }],
          ['https://test-d.example.com', { kind: 'data', payload: goodPayload }],
          ['https://test-e.example.com', { kind: 'data', payload: goodPayload }],
        ]));

        const result = await resolveEnsContent('flaky-network-upgrade.eth');

        expect(result.type).toBe('ok');
        expect(result.trust.level).toBe('verified');
        // Trust metadata reflects the second wave that actually agreed.
        expect(result.trust.queried).toEqual([
          'test-d.example.com',
          'test-e.example.com',
        ]);
      } finally {
        restore();
      }
    });

    test('1 data + 2 errors with too few fresh providers → no escalation, stays unverified', async () => {
      // 4-provider pool: first wave runs against 3, leaving only 1
      // fresh provider — below effectiveM=2, so escalation must not run.
      const fourProviders = [
        ...TEST_PROVIDERS,
        'https://test-d.example.com',
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
        ensPublicRpcProviders: fourProviders,
      });
      const origRandom = Math.random;
      Math.random = () => 0.999;
      try {
        invalidateCachedProvider();
        const flakyErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
        const goodPayload = urReturnsBytes(ipfsContenthashFor(IPFS_HASH));
        routeByProvider(new Map([
          [TEST_PROVIDERS[0], { kind: 'data', payload: goodPayload }],
          [TEST_PROVIDERS[1], { kind: 'reject', payload: flakyErr }],
          [TEST_PROVIDERS[2], { kind: 'reject', payload: flakyErr }],
          // Even though this provider would have agreed, the guard
          // prevents a second wave from running against it alone.
          ['https://test-d.example.com', { kind: 'data', payload: goodPayload }],
        ]));

        const result = await resolveEnsContent('insufficient-remaining.eth');

        expect(result.type).toBe('ok');
        expect(result.trust.level).toBe('unverified');
      } finally {
        Math.random = origRandom;
      }
    });

    test('second wave also unverified → keep first-wave evidence (no downgrade)', async () => {
      const { restore } = fivePoolWithDeterministicOrder();
      try {
        const flakyErr = Object.assign(new Error('ECONNREFUSED'), { code: 'NETWORK_ERROR' });
        const firstPayload = urReturnsBytes(ipfsContenthashFor(IPFS_HASH));
        const altPayload = urReturnsBytes(ipfsContenthashFor(ALT_HASH));
        routeByProvider(new Map([
          // First wave: 1 data + 2 errors → unverified_data with IPFS_HASH.
          [TEST_PROVIDERS[0], { kind: 'data', payload: firstPayload }],
          [TEST_PROVIDERS[1], { kind: 'reject', payload: flakyErr }],
          [TEST_PROVIDERS[2], { kind: 'reject', payload: flakyErr }],
          // Second wave: 1 data (different hash) + 1 error → unverified
          // again. Replacing first wave with this would downgrade the
          // single piece of evidence we already had.
          ['https://test-d.example.com', { kind: 'data', payload: altPayload }],
          ['https://test-e.example.com', { kind: 'reject', payload: flakyErr }],
        ]));

        const result = await resolveEnsContent('second-wave-no-quorum.eth');

        expect(result.type).toBe('ok');
        expect(result.trust.level).toBe('unverified');
        // First-wave provider's bytes are preserved.
        expect(result.trust.queried).toEqual([
          'test-a.example.com',
          'test-b.example.com',
          'test-c.example.com',
        ]);
      } finally {
        restore();
      }
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

  // Flip the mocked settings into Colibri-primary mode for the orchestrator
  // tests below. Used by both the forward and reverse branch describes.
  function withColibri(overrides = {}) {
    mockLoadSettings.mockReturnValue({
      ...mockLoadSettings(),
      ensResolutionMethod: 'colibri',
      ...overrides,
    });
  }

  // Switches consensusResolve to the Colibri-backed verifier when
  // ensResolutionMethod === 'colibri'. The colibri-resolver itself is
  // unit-tested separately; here we cover the wiring: method routing,
  // trust-shape, error → fallback handoff.
  describe('colibri orchestrator branch', () => {
    const IPFS_V0 = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';

    // resolveViaColibri returns { resolvedData, resolverAddress } (object),
    // not the [bytes, address] tuple the contract mock returns. Adapt.
    function colibriOk(innerHex) {
      const [resolvedData, resolverAddress] = urReturnsBytes(innerHex);
      return { resolvedData, resolverAddress };
    }

    test('routes through Colibri and returns verified trust with method=colibri', async () => {
      withColibri();
      mockResolveViaColibri.mockResolvedValue(colibriOk(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('vitalik.eth');

      expect(mockResolveViaColibri).toHaveBeenCalledTimes(1);
      expect(result.type).toBe('ok');
      expect(result.uri).toBe(`ipfs://${IPFS_V0}`);
      expect(result.trust).toMatchObject({
        level: 'verified',
        method: 'colibri',
        prover: 'test-prover.example',
        proof: 'ZK sync-committee proof',
        quorum: { k: 1, m: 1, achieved: true },
      });
      // No public-RPC quorum legs fired.
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('uses the user-configured prover URL when set in settings', async () => {
      withColibri({ ensColibriProverUrl: 'https://my.prover.example/abc' });
      mockResolveViaColibri.mockResolvedValue(colibriOk(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('a.eth');
      expect(result.trust.prover).toBe('my.prover.example');
    });

    test('ResolverNotFound surfaces as a verified NO_RESOLVER (name not registered)', async () => {
      withColibri();
      const err = Object.assign(new Error('ResolverNotFound(bytes)'), {
        data: '0x77209fe8000000',
      });
      mockResolveViaColibri.mockRejectedValue(err);

      const result = await resolveEnsContent('not-registered.eth');

      expect(result.type).toBe('not_found');
      expect(result.reason).toBe('NO_RESOLVER');
      expect(result.trust.method).toBe('colibri');
      expect(mockUrResolve).not.toHaveBeenCalled();
    });

    test('CALL_EXCEPTION (verified revert, unknown selector) buckets as NO_CONTENTHASH', async () => {
      withColibri();
      const err = Object.assign(new Error('reverted: custom resolver error'), {
        code: 'CALL_EXCEPTION',
        data: '0xdeadbeef',
      });
      mockResolveViaColibri.mockRejectedValue(err);

      const result = await resolveEnsContent('empty-record.eth');

      expect(result.type).toBe('not_found');
      expect(result.trust.method).toBe('colibri');
    });

    test('CALL_EXCEPTION without revert data falls through to public RPC quorum', async () => {
      withColibri();
      const err = Object.assign(new Error(
        'missing revert data transaction={ data: "0x' + 'ab'.repeat(200) + '" }'
      ), {
        code: 'CALL_EXCEPTION',
        shortMessage: 'missing revert data',
        info: { error: { code: -32603, message: 'no response from prover' } },
      });
      mockResolveViaColibri.mockRejectedValue(err);
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));
      const warnSpy = jest.spyOn(resolverLog, 'warn').mockImplementation(() => {});

      const result = await resolveEnsContent('prover-down.eth');

      expect(result.type).toBe('ok');
      expect(result.uri).toBe(`ipfs://${IPFS_V0}`);
      expect(mockUrResolve).toHaveBeenCalled();
      expect(result.trust.method).not.toBe('colibri');
      expect(result.trust.quorum).toEqual({ k: 3, m: 2, achieved: true });
      expect(warnSpy).toHaveBeenCalledWith(
        '[ens] colibri-fallback name=prover-down.eth kind=content ' +
        'error="missing revert data" code=CALL_EXCEPTION rpcCode=-32603 ' +
        'rpcMessage="no response from prover" revert=none'
      );
      expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('abababababababab');
      warnSpy.mockRestore();
    });

    test('non-revert error falls through to the quorum path by default', async () => {
      withColibri();
      mockResolveViaColibri.mockRejectedValue(new Error('proof verification failed'));
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      const result = await resolveEnsContent('proof-failure.eth');

      expect(result.type).toBe('ok');
      expect(result.uri).toBe(`ipfs://${IPFS_V0}`);
      // Fell through to the public-RPC quorum — three legs queried.
      expect(mockUrResolve).toHaveBeenCalled();
      expect(result.trust.method).not.toBe('colibri');
      expect(result.trust.quorum).toEqual({ k: 3, m: 2, achieved: true });
    });

    test('default ensResolutionMethod=quorum bypasses Colibri (regression)', async () => {
      // Don't call withColibri — defaults to 'quorum'.
      mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));

      await resolveEnsContent('legacy.eth');

      expect(mockResolveViaColibri).not.toHaveBeenCalled();
      expect(mockUrResolve).toHaveBeenCalled();
    });
  });

  // Same Colibri orchestrator branch, reverse direction. resolveEnsReverse
  // goes through tryColibriReverse rather than consensusResolve.
  describe('colibri orchestrator branch — reverse', () => {
    const ADDR = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';

    test('routes through Colibri and returns name + verified-via-colibri trust', async () => {
      withColibri();
      mockResolveReverseViaColibri.mockResolvedValue({ name: 'vitalik.eth' });

      const result = await resolveEnsReverse(ADDR);

      expect(mockResolveReverseViaColibri).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        success: true,
        address: ADDR,
        name: 'vitalik.eth',
        trust: { level: 'verified', method: 'colibri', prover: 'test-prover.example' },
      });
      expect(mockUrReverse).not.toHaveBeenCalled();
    });

    test('no primary set surfaces as NO_REVERSE with trust attached', async () => {
      withColibri({ ensResolutionOrder: ['colibri'] });
      mockResolveReverseViaColibri.mockResolvedValue({ name: '' });

      const result = await resolveEnsReverse(ADDR);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_REVERSE');
      expect(result.trust.method).toBe('colibri');
      expect(mockResolveViaColibri).toHaveBeenCalledTimes(2);
      expect(mockResolveViaColibri.mock.calls.map(([name]) => name)).toEqual([
        'reverse.wei',
        'reverse.gwei',
      ]);
      expect(mockGetBlockNumber).not.toHaveBeenCalled();
      expect(mockUrReverse).not.toHaveBeenCalled();
      expect(mockWnsReverseResolve).not.toHaveBeenCalled();
      expect(mockGnsReverseResolve).not.toHaveBeenCalled();
    });

    test('resolves and forward-verifies WNS through Colibri without public RPC', async () => {
      withColibri();
      mockResolveReverseViaColibri.mockResolvedValue({ name: '' });
      mockResolveViaColibri.mockImplementation(async (name) => {
        const resolvedData = name === 'reverse.wei'
          ? actualEthers.AbiCoder.defaultAbiCoder().encode(['string'], ['alice.wei'])
          : actualEthers.AbiCoder.defaultAbiCoder().encode(['address'], [ADDR]);
        return { resolvedData, resolverAddress: WNS_ADDRESS };
      });

      const result = await resolveEnsReverse(ADDR);

      expect(result).toMatchObject({
        success: true,
        address: ADDR,
        name: 'alice.wei',
        system: 'wns',
        trust: { level: 'verified', method: 'colibri', system: 'wns' },
      });
      expect(mockResolveViaColibri).toHaveBeenCalledTimes(2);
      expect(mockGetBlockNumber).not.toHaveBeenCalled();
      expect(mockUrReverse).not.toHaveBeenCalled();
      expect(mockWnsReverseResolve).not.toHaveBeenCalled();
      expect(mockWnsAddr).not.toHaveBeenCalled();
    });

    test('ResolverNotFound surfaces as NO_REVERSE (no record at all)', async () => {
      withColibri();
      const err = Object.assign(new Error('ResolverNotFound(bytes)'), {
        data: '0x77209fe8',
      });
      mockResolveReverseViaColibri.mockRejectedValue(err);

      const result = await resolveEnsReverse(ADDR);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('NO_REVERSE');
      expect(result.trust.method).toBe('colibri');
    });

    test('ReverseAddressMismatch surfaces as UNVERIFIED (spoofed/stale record)', async () => {
      withColibri();
      const err = Object.assign(new Error('ReverseAddressMismatch'), {
        data: '0xef9c03ce',
      });
      mockResolveReverseViaColibri.mockRejectedValue(err);

      const result = await resolveEnsReverse(ADDR);

      expect(result.success).toBe(false);
      expect(result.reason).toBe('UNVERIFIED');
      expect(result.trust.method).toBe('colibri');
      // Critical: the trust object's level is still 'verified' — the proof
      // was valid, the contract reverted. The 'reason' carries the spoofed-
      // record signal, not the trust level.
      expect(result.trust.level).toBe('verified');
    });

    test('logs why an unverified Colibri reverse result continues to quorum', async () => {
      withColibri({
        ensResolutionOrder: ['myotis', 'colibri', 'quorum'],
        ensPreferVerified: true,
      });
      const infoSpy = jest.spyOn(resolverLog, 'info').mockImplementation(() => {});
      const err = Object.assign(new Error('ReverseAddressMismatch'), {
        data: '0xef9c03ce',
      });
      mockResolveReverseViaColibri.mockRejectedValue(err);
      mockUrReverse.mockResolvedValue(['']);

      try {
        const result = await resolveEnsReverse(ADDR);

        expect(result).toMatchObject({ success: false, reason: 'NO_REVERSE' });
        expect(infoSpy).toHaveBeenCalledWith(
          `[ens] reverse policy address=${ADDR} order=[myotis,colibri,quorum] ` +
          'preferVerified=true'
        );
        expect(infoSpy).toHaveBeenCalledWith(
          `[ens] reverse method=myotis address=${ADDR} outcome=UNAVAILABLE ` +
          'system=none trust=none action=continue reason=disabled'
        );
        expect(infoSpy).toHaveBeenCalledWith(
          `[ens] reverse method=colibri address=${ADDR} outcome=UNVERIFIED ` +
          'system=ens trust=verified action=continue reason=prefer-verified'
        );
        expect(infoSpy).toHaveBeenCalledWith(
          `[ens] reverse method=quorum address=${ADDR} outcome=NO_REVERSE ` +
          'system=ens,wns,gns trust=verified action=accept'
        );
      } finally {
        infoSpy.mockRestore();
      }
    });

    test('UNVERIFIED carries the decoded claimedName from revert data', async () => {
      withColibri();
      // ReverseAddressMismatch(string,bytes) — claimed name + address bytes.
      // Building a real revert payload here so the decoder is exercised end-to-end.
      const args = actualEthers.AbiCoder.defaultAbiCoder().encode(
        ['string', 'bytes'],
        ['spoofed.eth', '0xabcd'],
      );
      const err = Object.assign(new Error('ReverseAddressMismatch'), {
        data: '0xef9c03ce' + args.slice(2),
      });
      mockResolveReverseViaColibri.mockRejectedValue(err);

      const result = await resolveEnsReverse(ADDR);

      expect(result.reason).toBe('UNVERIFIED');
      expect(result.claimedName).toBe('spoofed.eth');
    });

    test('UNVERIFIED with no decodable revert data has claimedName=null', async () => {
      withColibri();
      const err = Object.assign(new Error('ReverseAddressMismatch'), {
        data: '0xef9c03ce', // selector only, no args
      });
      mockResolveReverseViaColibri.mockRejectedValue(err);

      const result = await resolveEnsReverse(ADDR);
      expect(result.reason).toBe('UNVERIFIED');
      expect(result.claimedName).toBeNull();
    });

    test('non-revert error falls through to the configured quorum path', async () => {
      withColibri();
      mockResolveReverseViaColibri.mockRejectedValue(new Error('prover unreachable'));
      mockUrReverse.mockResolvedValue(['legacy.eth']);

      const result = await resolveEnsReverse(ADDR);

      expect(result.success).toBe(true);
      expect(result.name).toBe('legacy.eth');
      expect(result.trust).toMatchObject({
        level: 'verified',
        quorum: { k: 3, m: 2, achieved: true },
      });
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
    });

    test('default ensResolutionMethod=quorum queries the configured provider quorum', async () => {
      // Don't call withColibri — defaults to 'quorum'.
      mockUrReverse.mockResolvedValue(['legacy.eth']);

      const result = await resolveEnsReverse(ADDR);

      expect(mockResolveReverseViaColibri).not.toHaveBeenCalled();
      expect(mockUrReverse).toHaveBeenCalledTimes(3);
      expect(result.name).toBe('legacy.eth');
      expect(result.trust).toMatchObject({
        level: 'verified',
        quorum: { k: 3, m: 2, achieved: true },
      });
    });

    test('invalid address rejects before either path is hit', async () => {
      withColibri();
      const result = await resolveEnsReverse('0xnotanaddress');
      expect(result.success).toBe(false);
      expect(result.reason).toBe('INVALID_ADDRESS');
      expect(mockResolveReverseViaColibri).not.toHaveBeenCalled();
      expect(mockUrReverse).not.toHaveBeenCalled();
    });
  });
});

// PRIVATE MODE GUARD (name logging). log.info/warn/error land in the
// persistent <userData>/logs/main.log, which outlives the private window
// and the app — so a name resolved for a private tab (and the target it
// resolved to) must never appear there, while normal browsing keeps the
// full diagnostic line.
describe('ens-resolver private-window logging', () => {
  const IPFS_V0 = 'QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa';
  const SECRET = 'whistleblower-site.eth';
  const RESOLVER_ADDR = '0x0000000000000000000000000000000000001234';

  function handlerFor(channel) {
    const entry = ipcMain.handle.mock.calls.find(([name]) => name === channel);
    if (!entry) throw new Error(`no handler registered for ${channel}`);
    return entry[1];
  }

  // Every string the resolver logged, across all levels.
  function loggedText() {
    return [mockLog.info, mockLog.warn, mockLog.error]
      .flatMap((fn) => fn.mock.calls)
      .map((call) => call.map((arg) => String(arg?.message || arg)).join(' '))
      .join('\n');
  }

  const privateEvent = { sender: { isPrivate: true } };
  const normalEvent = { sender: { isPrivate: false } };

  beforeEach(() => {
    clearEnsResolutionCaches();
    ipcMain.handle.mockClear();
    registerEnsIpc();
    mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));
  });

  test('a private ENS_RESOLVE logs neither the name nor the resolved target', async () => {
    const result = await handlerFor(IPC.ENS_RESOLVE)(privateEvent, { name: SECRET });

    // The resolution itself is unchanged — only the logging is redacted.
    expect(result).toMatchObject({ type: 'ok', name: SECRET, uri: `ipfs://${IPFS_V0}` });
    const text = loggedText();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(IPFS_V0);
    // The line is still emitted, so the log still shows a resolve happened.
    expect(text).toContain('[ens] Resolved: <private>');
  });

  test('a normal ENS_RESOLVE keeps the full diagnostic line', async () => {
    await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: 'public-site.eth' });

    const text = loggedText();
    expect(text).toContain('public-site.eth');
    expect(text).toContain(IPFS_V0);
  });

  test('the redaction covers the consensus wave, not just the final line', async () => {
    await handlerFor(IPC.ENS_RESOLVE)(privateEvent, { name: SECRET });
    const consensusLines = mockLog.info.mock.calls
      .map((call) => call.join(' '))
      .filter((line) => line.includes('[ens] consensus kind='));
    expect(consensusLines.length).toBeGreaterThan(0);
    for (const line of consensusLines) {
      expect(line).toContain('name=<private>');
      expect(line).not.toContain(SECRET);
    }
  });

  test('a private address lookup and cache invalidation stay out of the log', async () => {
    mockUrResolve.mockResolvedValue(
      urReturnsAddress('0x1111111111111111111111111111111111111111')
    );
    await handlerFor(IPC.ENS_RESOLVE_ADDRESS)(privateEvent, { name: SECRET });
    expect(loggedText()).not.toContain(SECRET);

    // Populate the content cache from a normal window, then invalidate it
    // from the private one: the eviction line must not name it either.
    mockUrResolve.mockResolvedValue(urReturnsBytes(ipfsContenthashFor(IPFS_V0)));
    await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: SECRET });
    mockLog.info.mockClear();
    await handlerFor(IPC.ENS_INVALIDATE_CONTENT)(privateEvent, { name: SECRET });
    const text = loggedText();
    expect(text).toContain('content cache invalidated for <private>');
    expect(text).not.toContain(SECRET);
  });

  test('a resolution that throws logs no name either', async () => {
    // An invalid label throws out of ens_normalize, whose message quotes
    // the offending name — the catch-all log line must not pass it through.
    const result = await handlerFor(IPC.ENS_RESOLVE)(privateEvent, {
      name: 'invalid_label.eth',
    });

    expect(result.reason).toBe('RESOLUTION_ERROR');
    expect(mockLog.error).toHaveBeenCalled();
    expect(loggedText()).not.toContain('invalid_label');
  });

  // The policy loop and the reverse dispatcher log the name/address on every
  // method hop, not just at the final line. Those sites are newer than the
  // redaction guard, so they get their own assertions — a regression there
  // would leak a private lookup into main.log while every other test passed.
  test('a private reverse lookup keeps the address out of every policy line', async () => {
    const SECRET_ADDR = '0x00000000000000000000000000000000000019a1';
    mockUrReverse.mockResolvedValue([SECRET, RESOLVER_ADDR, RESOLVER_ADDR]);

    const result = await handlerFor(IPC.ENS_RESOLVE_REVERSE)(privateEvent, {
      address: SECRET_ADDR,
    });

    expect(result).toMatchObject({ success: true, name: SECRET });
    const text = loggedText();
    expect(text).not.toContain(SECRET_ADDR);
    expect(text).not.toContain(SECRET);
    // The per-method reverse lines are still emitted, just redacted.
    const reverseLines = mockLog.info.mock.calls
      .map((call) => call.join(' '))
      .filter((line) => line.includes('[ens] reverse '));
    expect(reverseLines.length).toBeGreaterThan(0);
    for (const line of reverseLines) {
      expect(line).toContain('address=<private>');
    }
  });

  test('a private myotis-served resolve redacts the per-method policy lines', async () => {
    mockMyotisIsEnabled.mockImplementation(() => true);
    mockMyotisIsReady.mockImplementation(() => true);
    mockMyotisResolveEnsRecord.mockResolvedValue({
      status: 'ok',
      verified: true,
      blockNumber: 23456789,
      dataHex: ipfsContenthashFor(IPFS_V0),
    });

    try {
      const result = await handlerFor(IPC.ENS_RESOLVE)(privateEvent, { name: SECRET });

      expect(result).toMatchObject({
        type: 'ok',
        trust: { level: 'verified', method: 'myotis' },
      });
      const text = loggedText();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(IPFS_V0);
      // The myotis hop is still accounted for in the log, name redacted.
      expect(text).toContain('[ens] policy name=<private>');
      expect(text).toContain('[ens] method=myotis name=<private>');
    } finally {
      mockMyotisIsEnabled.mockImplementation(() => false);
      mockMyotisIsReady.mockImplementation(() => false);
    }
  });

  test('a private resolve does not redact a later normal resolve', async () => {
    await handlerFor(IPC.ENS_RESOLVE)(privateEvent, { name: SECRET });
    clearEnsResolutionCaches();
    mockLog.info.mockClear();

    await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: 'public-site.eth' });
    expect(loggedText()).toContain('[ens] Resolved: public-site.eth');
  });
});
