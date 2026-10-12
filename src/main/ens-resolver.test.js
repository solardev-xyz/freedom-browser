// Mock electron ipcMain before requiring ens-resolver
jest.mock('electron', () => ({
  ipcMain: { handle: jest.fn() },
}));

// The persistent-log guard asserts on what reaches the logger, so the
// logger is a mock rather than electron-log's test-mode no-op.
const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('./logger', () => mockLog);

// The naming core's driver: none unless a test installs one.
let mockCoreDriver = null;
const mockNamingSettingsChanged = jest.fn();
const mockNamingCachesCleared = jest.fn();
jest.mock('./core/naming', () => ({
  namingDriver: () => mockCoreDriver,
  namingSettingsChanged: (...args) => mockNamingSettingsChanged(...args),
  namingCachesCleared: (...args) => mockNamingCachesCleared(...args),
}));

// Private-ness is decided from the IPC sender; the registry itself needs a
// real BrowserWindow, so stub the one predicate ens-resolver uses.
jest.mock('./private/private-windows', () => ({
  isPrivateWebContents: (webContents) => webContents?.isPrivate === true,
}));

// The network registry, as the configuration sources read it.
const mockRegistry = {
  getEndpoints: jest.fn(() => []),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
  invalidate: jest.fn(),
};
jest.mock('./networks/network-registry', () => mockRegistry);

// Contract calls answer from these mocks; the pure helpers are ethers' own,
// so the call encodings are really exercised.
const mockUrResolve = jest.fn();
const mockUrReverse = jest.fn();
const mockNameNftContenthash = jest.fn();
const mockNameNftAddr = jest.fn();
const mockNameNftReverseResolve = jest.fn();
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers').ethers;
  return {
    ethers: {
      Contract: jest.fn().mockImplementation((address) => ({
        resolve: (...args) => mockUrResolve(...args),
        reverse: (...args) => mockUrReverse(...args),
        contenthash: (...args) => mockNameNftContenthash(address, ...args),
        addr: (...args) => mockNameNftAddr(address, ...args),
        reverseResolve: (...args) => mockNameNftReverseResolve(address, ...args),
      })),
      dnsEncode: actual.dnsEncode,
      namehash: actual.namehash,
      AbiCoder: actual.AbiCoder,
      getBytes: actual.getBytes,
      ZeroAddress: actual.ZeroAddress,
      Interface: actual.Interface,
    },
  };
});

const { ethers } = require('ethers');
const {
  registerEnsIpc,
  getEffectiveRpcEndpoints,
  getDirectRpcCandidate,
  resolutionPolicy,
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  invalidateCachedProvider,
  invalidateEnsContent,
  clearEnsResolutionCaches,
  universalResolverCall,
  universalResolverReverse,
  fastNormalize,
  nameNftResolverCall,
  nameNftReverseResolverCall,
  isResolverNotFoundError,
  hostOf,
} = require('./ens-resolver');
const { UNAVAILABLE } = require('./core/naming-driver');
const { isPrivateLogContext } = require('./private/private-log-context');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');

const actualEthers = jest.requireActual('ethers').ethers;
const abi = actualEthers.AbiCoder.defaultAbiCoder();
const UR_ADDRESS = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const WNS_ADDRESS = '0x0000000000696760E15f265e828DB644A0c242EB';
const GNS_ADDRESS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const FAKE_RESOLVER = '0x0000000000000000000000000000000000001234';
const ADDRESS = '0x' + 'ab'.repeat(20);
const CONTENTHASH_SELECTOR = '0xbc1c58d1';
const ADDR_SELECTOR = '0x3b3b57de';

function coreDriver() {
  return {
    resolveContent: jest.fn(async () => ({ type: 'ok', from: 'core' })),
    resolveAddress: jest.fn(async () => ({ success: true, from: 'core' })),
    resolveReverse: jest.fn(async () => ({ success: true, from: 'core' })),
    invalidateContent: jest.fn(async () => true),
  };
}

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
  jest.clearAllMocks();
  mockCoreDriver = null;
  ipcMain.handle.mockClear();
  registerEnsIpc();
});

describe('lookups go to the naming core', () => {
  test('with the inputs it takes', async () => {
    mockCoreDriver = coreDriver();
    expect(await resolveEnsContent('vitalik.eth')).toEqual({ type: 'ok', from: 'core' });
    await resolveEnsContent(undefined);
    await resolveEnsAddress('nick.eth', 10);
    await resolveEnsAddress('nick.eth');
    await resolveEnsAddress(null, 0);
    await resolveEnsReverse(ADDRESS);
    await resolveEnsReverse('0xnot-an-address', 8453);
    expect(mockCoreDriver.resolveContent.mock.calls).toEqual([['vitalik.eth'], ['']]);
    expect(mockCoreDriver.resolveAddress.mock.calls).toEqual([
      ['nick.eth', 10],
      ['nick.eth', 1],
      ['', 0],
    ]);
    expect(mockCoreDriver.resolveReverse.mock.calls).toEqual([
      [ADDRESS, 1],
      ['0xnot-an-address', 8453],
    ]);
  });

  test('a result or a failure comes back as the driver gives it', async () => {
    const failure = new Error('No enabled name-resolution method could resolve x.eth');
    mockCoreDriver = {
      ...coreDriver(),
      resolveContent: jest.fn(async () => {
        throw failure;
      }),
    };
    await expect(resolveEnsContent('x.eth')).rejects.toBe(failure);
    expect(await resolveEnsAddress('nick.eth')).toEqual({ success: true, from: 'core' });
  });

  test('inputs the core does not take are refused before any network, with or without a core', async () => {
    for (const driver of [coreDriver(), null]) {
      mockCoreDriver = driver;
      await expect(resolveEnsContent(5)).rejects.toThrow(TypeError);
      await expect(resolveEnsContent(false)).rejects.toThrow('ENS name is empty');
      await expect(resolveEnsAddress('nick.eth', 'mainnet')).rejects.toThrow(
        'Invalid ENS destination chain ID'
      );
      await expect(resolveEnsAddress('nick.eth', Infinity)).rejects.toThrow(
        'Invalid ENS destination chain ID'
      );
      // A chain ID refused first, as before.
      await expect(resolveEnsAddress(5, 0)).rejects.toThrow('Invalid ENS destination chain ID');
      await expect(resolveEnsAddress(5, 1)).rejects.toThrow(TypeError);
      expect(await resolveEnsReverse(42)).toEqual({
        success: false,
        address: 42,
        reason: 'INVALID_ADDRESS',
        error: 'Invalid address: 42',
      });
      expect(await resolveEnsReverse('0x1234', NaN)).toMatchObject({ reason: 'INVALID_ADDRESS' });
      await expect(resolveEnsReverse(ADDRESS, NaN)).rejects.toThrow(
        'Invalid ENS destination chain ID'
      );
    }
    const driver = coreDriver();
    mockCoreDriver = driver;
    await resolveEnsContent({}).catch(() => {});
    expect(driver.resolveContent).not.toHaveBeenCalled();
    expect(driver.resolveAddress).not.toHaveBeenCalled();
    expect(driver.resolveReverse).not.toHaveBeenCalled();
  });

  test('without a core, a lookup fails as the driver does when no core serves it', async () => {
    await expect(resolveEnsContent('vitalik.eth')).rejects.toThrow(UNAVAILABLE);
    await expect(resolveEnsContent('')).rejects.toThrow(UNAVAILABLE);
    await expect(resolveEnsAddress('vitalik.eth', 10)).rejects.toThrow(UNAVAILABLE);
    await expect(resolveEnsReverse(ADDRESS)).rejects.toThrow(UNAVAILABLE);
    expect(mockUrResolve).not.toHaveBeenCalled();
    expect(mockUrReverse).not.toHaveBeenCalled();
  });

  test('without a core, the IPC handlers answer in their error shapes', async () => {
    expect(await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: ' Vitalik.ETH ' })).toEqual({
      type: 'error',
      name: 'vitalik.eth',
      reason: 'RESOLUTION_ERROR',
      error: UNAVAILABLE,
    });
    expect(
      await handlerFor(IPC.ENS_RESOLVE_ADDRESS)(normalEvent, { name: 'Nick.eth', chainId: 10 })
    ).toEqual({
      success: false,
      name: 'nick.eth',
      reason: 'RESOLUTION_ERROR',
      error: UNAVAILABLE,
    });
    expect(
      await handlerFor(IPC.ENS_RESOLVE_REVERSE)(normalEvent, { address: ADDRESS.toUpperCase() })
    ).toEqual({
      success: false,
      address: ADDRESS.toUpperCase().toLowerCase(),
      reason: 'RESOLUTION_ERROR',
      error: UNAVAILABLE,
    });
    expect(await handlerFor(IPC.ENS_INVALIDATE_CONTENT)(normalEvent, { name: 'x.eth' })).toBe(
      false
    );
  });
});

describe('IPC handlers', () => {
  test("keep their shapes and privacy around the core's lookups", async () => {
    mockCoreDriver = {
      ...coreDriver(),
      resolveContent: jest.fn(async () => {
        throw new Error('No enabled name-resolution method could resolve x.eth');
      }),
      resolveAddress: jest.fn(async () => ({ private: isPrivateLogContext() })),
      resolveReverse: jest.fn(async () => ({ private: isPrivateLogContext() })),
    };
    expect(await handlerFor(IPC.ENS_RESOLVE)({ sender: {} }, { name: ' X.eth ' })).toEqual({
      type: 'error',
      name: 'x.eth',
      reason: 'RESOLUTION_ERROR',
      error: 'No enabled name-resolution method could resolve x.eth',
    });
    expect(await handlerFor(IPC.ENS_RESOLVE_ADDRESS)(privateEvent, { name: 'a.eth' })).toEqual({
      private: true,
    });
    expect(await handlerFor(IPC.ENS_RESOLVE_ADDRESS)(normalEvent, { name: 'a.eth' })).toEqual({
      private: false,
    });
    expect(await handlerFor(IPC.ENS_RESOLVE_REVERSE)(privateEvent, { address: ADDRESS })).toEqual({
      private: true,
    });
    expect(mockCoreDriver.resolveAddress.mock.calls).toEqual([
      ['a.eth', 1],
      ['a.eth', 1],
    ]);
  });

  test('the content handler passes a result through unchanged', async () => {
    const result = {
      type: 'ok',
      name: 'vitalik.eth',
      system: 'ens',
      protocol: 'ipfs',
      uri: 'ipfs://QmW81r84Aihiqqi2Jw6nM1LnpeMfRCenRxtjwHNkXVkZYa',
      trust: { level: 'verified' },
    };
    mockCoreDriver = { ...coreDriver(), resolveContent: jest.fn(async () => result) };
    expect(await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: 'vitalik.eth' })).toBe(result);
  });

  // PRIVATE MODE GUARD (name logging): the core's error text routinely names
  // what it was asked to resolve.
  test('a private failure logs neither the name nor its message', async () => {
    const SECRET = 'whistleblower-site.eth';
    mockCoreDriver = {
      ...coreDriver(),
      resolveContent: jest.fn(async () => {
        throw new Error(`Myotis availability changed repeatedly while resolving ${SECRET}`);
      }),
      resolveAddress: jest.fn(async () => {
        throw new Error(`No address for ${SECRET}`);
      }),
      resolveReverse: jest.fn(async () => {
        throw new Error(`No primary name for ${ADDRESS}`);
      }),
    };

    const result = await handlerFor(IPC.ENS_RESOLVE)(privateEvent, { name: SECRET });
    await handlerFor(IPC.ENS_RESOLVE_ADDRESS)(privateEvent, { name: SECRET });
    await handlerFor(IPC.ENS_RESOLVE_REVERSE)(privateEvent, { address: ADDRESS });

    // The page still gets the whole message.
    expect(result.error).toContain(SECRET);
    expect(mockLog.error).toHaveBeenCalledTimes(3);
    expect(loggedText()).not.toContain(SECRET);
    expect(loggedText()).not.toContain(ADDRESS);
  });

  test('a normal failure keeps the full diagnostic line', async () => {
    mockCoreDriver = {
      ...coreDriver(),
      resolveContent: jest.fn(async () => {
        throw new Error('All 3 RPC providers failed for public-site.eth');
      }),
    };
    await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: 'public-site.eth' });
    expect(loggedText()).toContain('public-site.eth');
  });

  test('a private lookup does not mark a later normal one', async () => {
    mockCoreDriver = {
      ...coreDriver(),
      resolveContent: jest.fn(async () => ({ private: isPrivateLogContext() })),
    };
    expect(await handlerFor(IPC.ENS_RESOLVE)(privateEvent, { name: 'a.eth' })).toEqual({
      private: true,
    });
    expect(await handlerFor(IPC.ENS_RESOLVE)(normalEvent, { name: 'a.eth' })).toEqual({
      private: false,
    });
  });
});

describe('invalidation reaches the core', () => {
  test("a name's cached content: whether the core evicted it", async () => {
    mockCoreDriver = coreDriver();
    await expect(invalidateEnsContent('vitalik.eth')).resolves.toBe(true);
    await expect(invalidateEnsContent(undefined)).resolves.toBe(true);
    mockCoreDriver.invalidateContent.mockResolvedValue(false);
    expect(
      await handlerFor(IPC.ENS_INVALIDATE_CONTENT)(privateEvent, { name: 'Vitalik.eth' })
    ).toBe(false);
    expect(mockCoreDriver.invalidateContent.mock.calls).toEqual([
      ['vitalik.eth'],
      [''],
      ['Vitalik.eth'],
    ]);
  });

  test('nothing is cached without a core, nor for a name that is not a string', () => {
    expect(invalidateEnsContent('vitalik.eth')).toBe(false);
    mockCoreDriver = coreDriver();
    expect(invalidateEnsContent(42)).toBe(false);
    expect(invalidateEnsContent({})).toBe(false);
    expect(mockCoreDriver.invalidateContent).not.toHaveBeenCalled();
  });

  test('a settings change re-reads the registry, then reconfigures the core', () => {
    const order = [];
    mockRegistry.invalidate.mockImplementation(() => order.push('registry'));
    mockNamingSettingsChanged.mockImplementation(() => order.push('core'));
    invalidateCachedProvider();
    expect(order).toEqual(['registry', 'core']);
    expect(mockNamingCachesCleared).not.toHaveBeenCalled();
  });

  test('clearing the resolution caches clears the core', () => {
    clearEnsResolutionCaches();
    expect(mockNamingCachesCleared).toHaveBeenCalledTimes(1);
    expect(mockNamingSettingsChanged).not.toHaveBeenCalled();
    expect(mockRegistry.invalidate).not.toHaveBeenCalled();
  });
});

describe('configuration sources', () => {
  const saved = process.env.ETH_RPC;
  afterEach(() => {
    if (saved === undefined) delete process.env.ETH_RPC;
    else process.env.ETH_RPC = saved;
  });

  test('the effective RPC pool: ETH_RPC first, deduplicated without case, no empties', () => {
    delete process.env.ETH_RPC;
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://A.example',
      '  ',
      null,
      'https://b.example',
    ]);
    expect(getEffectiveRpcEndpoints()).toEqual(['https://a.example', 'https://b.example']);
    expect(mockRegistry.getEndpoints).toHaveBeenCalledWith(1, 'rpc');

    process.env.ETH_RPC = ' https://B.example ';
    expect(getEffectiveRpcEndpoints()).toEqual(['https://B.example', 'https://a.example']);
  });

  describe('the direct candidate', () => {
    const sources = (id) => [
      { id, role: 'rpc', keyed: false, coverage: { 1: 'https://x.example' } },
    ];

    test('none without an endpoint', () => {
      mockRegistry.getEndpoints.mockReturnValue([]);
      expect(getDirectRpcCandidate(1)).toEqual({ url: null, userConfigured: false });
    });

    test('user-configured when the first endpoint is a user-added source', () => {
      mockRegistry.getEndpoints.mockReturnValue(['https://x.example', 'https://y.example']);
      mockRegistry.getEndpointSources.mockReturnValue(sources('user-eth'));
      mockRegistry.getEndpointSourceList.mockReturnValue([
        { id: 'user-eth', builtin: false, removed: false, keyed: false },
      ]);
      expect(getDirectRpcCandidate(1)).toEqual({ url: 'https://x.example', userConfigured: true });
      expect(mockRegistry.getEndpointSources).toHaveBeenCalledWith(1, 'rpc');
    });

    test('a builtin or keyed source is not user-configured', () => {
      mockRegistry.getEndpoints.mockReturnValue(['https://x.example']);
      mockRegistry.getEndpointSources.mockReturnValue(sources('eth-builtin'));
      mockRegistry.getEndpointSourceList.mockReturnValue([
        { id: 'eth-builtin', builtin: true, removed: false, keyed: false },
      ]);
      expect(getDirectRpcCandidate(1).userConfigured).toBe(false);

      mockRegistry.getEndpointSources.mockReturnValue([
        { id: 'user-keyed', keyed: true, coverage: { 1: 'https://x.example' } },
      ]);
      mockRegistry.getEndpointSourceList.mockReturnValue([
        { id: 'user-keyed', builtin: false, removed: false, keyed: true },
      ]);
      expect(getDirectRpcCandidate(1)).toEqual({ url: 'https://x.example', userConfigured: false });
    });
  });

  describe('the resolution policy', () => {
    test('a configured order: known methods once each, preferVerified only when true', () => {
      expect(
        resolutionPolicy({
          verification: {
            order: ['colibri', 'bogus', 'quorum', 'colibri', 'direct'],
            preferVerified: 'yes',
          },
        })
      ).toEqual({ order: ['colibri', 'quorum', 'direct'], preferVerified: false });
      expect(
        resolutionPolicy({ verification: { order: ['myotis'], preferVerified: true } })
      ).toEqual({ order: ['myotis'], preferVerified: true });
    });

    test("a legacy configuration's primary, with Myotis first and quorum as fallback", () => {
      expect(resolutionPolicy(undefined)).toEqual({
        order: ['myotis', 'colibri', 'quorum'],
        preferVerified: false,
      });
      expect(resolutionPolicy({ verification: { primary: 'quorum', order: [] } })).toEqual({
        order: ['myotis', 'quorum'],
        preferVerified: false,
      });
      expect(resolutionPolicy({ verification: { primary: 'direct' } })).toEqual({
        order: ['myotis', 'direct', 'quorum'],
        preferVerified: false,
      });
      expect(
        resolutionPolicy({ verification: { primary: 'custom-rpc', preferVerified: true } })
      ).toEqual({ order: ['myotis', 'colibri', 'quorum'], preferVerified: false });
    });
  });
});

describe('fastNormalize', () => {
  test('lowercases a pure-ASCII name', () => {
    expect(fastNormalize('Vitalik.ETH')).toBe('vitalik.eth');
  });

  test('normalizes a unicode name via ENSIP-15', () => {
    expect(fastNormalize('ÖBB.eth')).toBe('öbb.eth');
  });

  test('throws on an invalid label', () => {
    expect(() => fastNormalize('invalid_label.eth')).toThrow();
  });
});

describe('universalResolverCall', () => {
  test('encodes name, opts into CCIP-Read, returns raw resolvedData', async () => {
    const rawResponse = abi.encode(['bytes'], ['0xdeadbeef']);
    mockUrResolve.mockResolvedValue([rawResponse, FAKE_RESOLVER]);

    const provider = { id: 'provider' };
    const callData = CONTENTHASH_SELECTOR + actualEthers.namehash('vitalik.eth').slice(2);
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
    const provider = { id: 'provider' };
    await universalResolverCall(provider, 'vitalik.eth', CONTENTHASH_SELECTOR);

    expect(ethers.Contract).toHaveBeenCalledWith(
      UR_ADDRESS,
      expect.arrayContaining([expect.stringContaining('function resolve')]),
      provider
    );
  });

  test("merges a caller's overrides into the call", async () => {
    mockUrResolve.mockResolvedValue(['0x', FAKE_RESOLVER]);
    await universalResolverCall({}, 'vitalik.eth', CONTENTHASH_SELECTOR, { blockTag: 'latest' });
    expect(mockUrResolve.mock.calls[0][2]).toEqual({ enableCcipRead: true, blockTag: 'latest' });
  });

  test('propagates UR reverts to the caller', async () => {
    const err = new Error('execution reverted: ResolverNotFound');
    mockUrResolve.mockRejectedValue(err);
    await expect(
      universalResolverCall({}, 'unregistered.eth', CONTENTHASH_SELECTOR)
    ).rejects.toThrow('ResolverNotFound');
  });
});

describe('universalResolverReverse', () => {
  test("asks for Ethereum's coin type unless told otherwise, and returns the name", async () => {
    mockUrReverse.mockResolvedValue(['vitalik.eth', FAKE_RESOLVER, FAKE_RESOLVER]);
    const bytes = actualEthers.getBytes(ADDRESS);
    expect(await universalResolverReverse({}, bytes)).toEqual({ name: 'vitalik.eth' });
    expect(mockUrReverse).toHaveBeenLastCalledWith(bytes, 60n, { enableCcipRead: true });

    await universalResolverReverse({}, bytes, {}, 2147492101n);
    expect(mockUrReverse).toHaveBeenLastCalledWith(bytes, 2147492101n, { enableCcipRead: true });
  });

  test('propagates a reverse mismatch to the caller', async () => {
    const err = new Error('execution reverted');
    err.data = '0xef9c03ce00';
    mockUrReverse.mockRejectedValue(err);
    await expect(universalResolverReverse({}, actualEthers.getBytes(ADDRESS))).rejects.toBe(err);
  });
});

describe('nameNftResolverCall', () => {
  const callFor = (selector, name) => selector + actualEthers.namehash(name).slice(2);

  test("reads a .wei contenthash from the WNS contract in the UR's raw shape", async () => {
    mockNameNftContenthash.mockResolvedValue('0xe301017012');
    const callData = callFor(CONTENTHASH_SELECTOR, 'meinhard.wei');
    const result = await nameNftResolverCall({}, 'meinhard.wei', callData);
    expect(result).toEqual({
      resolvedData: abi.encode(['bytes'], ['0xe301017012']),
      resolverAddress: WNS_ADDRESS,
    });
    expect(mockNameNftContenthash).toHaveBeenCalledWith(
      WNS_ADDRESS,
      actualEthers.namehash('meinhard.wei'),
      {}
    );
  });

  test('reads a .gwei address from the GNS contract; none is the zero address', async () => {
    mockNameNftAddr.mockResolvedValue(ADDRESS);
    const callData = callFor(ADDR_SELECTOR, 'apoorv.gwei');
    expect(await nameNftResolverCall({}, 'apoorv.gwei', callData)).toEqual({
      resolvedData: abi.encode(['address'], [ADDRESS]),
      resolverAddress: GNS_ADDRESS,
    });
    mockNameNftAddr.mockResolvedValue(null);
    expect((await nameNftResolverCall({}, 'apoorv.gwei', callData)).resolvedData).toBe(
      abi.encode(['address'], [actualEthers.ZeroAddress])
    );
    expect(mockNameNftAddr.mock.calls[0][0]).toBe(GNS_ADDRESS);
  });

  test('refuses an ENS name, malformed call data and other selectors', async () => {
    await expect(
      nameNftResolverCall({}, 'vitalik.eth', callFor(CONTENTHASH_SELECTOR, 'vitalik.eth'))
    ).rejects.toThrow('No NameNFT contract configured for ENS');
    await expect(nameNftResolverCall({}, 'a.wei', '0xbc1c58d1')).rejects.toThrow(
      'Invalid resolver call data'
    );
    await expect(nameNftResolverCall({}, 'a.wei', callFor('0xf1cb7e06', 'a.wei'))).rejects.toThrow(
      'Unsupported WNS resolver selector: 0xf1cb7e06'
    );
  });
});

describe('nameNftReverseResolverCall', () => {
  const iface = new actualEthers.Interface([
    'function reverseResolve(address addr) view returns (string)',
  ]);

  test("reads the reverse claim from the contract the synthetic name's suffix selects", async () => {
    mockNameNftReverseResolve.mockResolvedValue('meinhard.wei');
    const callData = iface.encodeFunctionData('reverseResolve', [ADDRESS]);
    expect(await nameNftReverseResolverCall({}, 'reverse.wei', callData)).toEqual({
      resolvedData: abi.encode(['string'], ['meinhard.wei']),
      resolverAddress: WNS_ADDRESS,
    });
    expect(mockNameNftReverseResolve.mock.calls[0][0]).toBe(WNS_ADDRESS);
    expect(mockNameNftReverseResolve.mock.calls[0][1].toLowerCase()).toBe(ADDRESS);

    mockNameNftReverseResolve.mockResolvedValue(null);
    expect(await nameNftReverseResolverCall({}, 'reverse.gwei', callData)).toEqual({
      resolvedData: abi.encode(['string'], ['']),
      resolverAddress: GNS_ADDRESS,
    });
  });

  test('refuses a name without a NameNFT contract', async () => {
    const callData = iface.encodeFunctionData('reverseResolve', [ADDRESS]);
    await expect(nameNftReverseResolverCall({}, 'reverse.eth', callData)).rejects.toThrow(
      'No NameNFT contract configured for ENS'
    );
  });
});

describe('isResolverNotFoundError', () => {
  test('matches ResolverNotFound in error message', () => {
    expect(
      isResolverNotFoundError(new Error('execution reverted: ResolverNotFound("foo.eth")'))
    ).toBe(true);
  });

  test('matches ResolverNotContract in error message', () => {
    expect(isResolverNotFoundError(new Error('execution reverted: ResolverNotContract'))).toBe(
      true
    );
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

describe('hostOf', () => {
  test("a URL's host, or the input when it does not parse", () => {
    expect(hostOf('https://mainnet1.colibri-proof.tech/path?q=1')).toBe(
      'mainnet1.colibri-proof.tech'
    );
    expect(hostOf('http://127.0.0.1:8545')).toBe('127.0.0.1:8545');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
