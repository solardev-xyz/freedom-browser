const IPC = require('../../shared/ipc-channels');
const {
  createIpcMainMock,
  loadMainModule,
} = require('../../../test/helpers/main-process-test-utils');

function loadNetworkIpc(options = {}) {
  const ipcMain = createIpcMainMock();
  const send = jest.fn();
  const registry = {
    getEndpointSourceList: jest.fn(() => []),
    getAllNetworks: jest.fn(() => ({})),
    getNetwork: jest.fn(() => null),
    getAvailableChains: jest.fn(() => ({})),
    isChainAvailable: jest.fn(() => false),
    updateNetwork: jest.fn(),
    upsertEndpointSource: jest.fn(() => ({ success: true })),
    removeEndpointSource: jest.fn(),
    restoreEndpointSource: jest.fn(),
    resetEndpointSourceCoverage: jest.fn(() => ({ success: true })),
    addCustomChain: jest.fn(() => ({ success: true, chainId: '777' })),
    removeCustomChain: jest.fn(() => ({ success: true })),
    validateRpcUrl: jest.fn((url) =>
      typeof url === 'string' && url.startsWith('https://') ? null : 'RPC URL must use https://'
    ),
    ...(options.registry || {}),
  };
  const tokenRegistry = {
    addCustomToken: jest.fn(() => ({ success: true })),
    removeCustomToken: jest.fn(() => ({ success: true })),
    getTokenKey: jest.fn((chainId, address) => address ? `${chainId}:${address}` : `${chainId}:native`),
    ...(options.tokenRegistry || {}),
  };
  const providerManager = { clearProviderCache: jest.fn() };
  const ensResolver = { invalidateCachedProvider: jest.fn() };
  // Each endpoint answers the chain it is saved for, unless a test says.
  const chain = {
    chainSettingsChanged: jest.fn(),
    checkEndpointChain: jest.fn(async (chainId) => chainId),
    ...(options.chain || {}),
  };
  const settingsStore = {
    loadSettings: jest.fn(() => ({ theme: 'system' })),
  };
  const rpcManager = {
    hasApiKey: jest.fn(() => false),
    setApiKey: jest.fn(() => ({ success: true })),
    removeApiKey: jest.fn(() => ({ success: true })),
    testApiKey: jest.fn(() => ({ success: true })),
  };

  const loaded = loadMainModule(require.resolve('./network-ipc'), {
    ipcMain,
    webContents: { getAllWebContents: jest.fn(() => [{ send }]) },
    extraMocks: {
      [require.resolve('./network-registry')]: () => registry,
      [require.resolve('./chain-catalog-host')]: () => ({
        searchChains: jest.fn(),
        getCatalogChain: jest.fn(),
      }),
      [require.resolve('../token-registry')]: () => tokenRegistry,
      [require.resolve('../wallet/rpc-manager')]: () => rpcManager,
      [require.resolve('../wallet/provider-manager')]: () => providerManager,
      [require.resolve('../ens-resolver')]: () => ensResolver,
      [require.resolve('../core/chain')]: () => chain,
      [require.resolve('../settings-store')]: () => settingsStore,
    },
  });

  loaded.mod.registerNetworkConfigIpc();
  return {
    ...loaded,
    send,
    registry,
    tokenRegistry,
    providerManager,
    ensResolver,
    chain,
    settingsStore,
    rpcManager,
  };
}

describe('network-ipc', () => {
  test('add-chain registers the native token with catalog decimals', async () => {
    const ctx = loadNetworkIpc();
    const chain = {
      chainId: 777,
      name: 'Odd Chain',
      nativeCurrency: { name: 'Odd Gas', symbol: 'ODD', decimals: 6 },
    };

    const result = await ctx.ipcMain.invoke('networks:add-chain', chain, ['https://rpc.odd.example']);

    expect(result).toEqual({ success: true, chainId: '777' });
    expect(ctx.registry.addCustomChain).toHaveBeenCalledWith(
      { ...chain, nativeSymbol: 'ODD' },
      ['https://rpc.odd.example']
    );
    expect(ctx.tokenRegistry.addCustomToken).toHaveBeenCalledWith({
      chainId: 777,
      address: null,
      symbol: 'ODD',
      name: 'Odd Gas',
      decimals: 6,
    });
    expect(ctx.providerManager.clearProviderCache).toHaveBeenCalled();
    expect(ctx.ensResolver.invalidateCachedProvider).toHaveBeenCalled();
    // The core takes every chain's new snapshot.
    expect(ctx.chain.chainSettingsChanged).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledWith(
      IPC.SETTINGS_UPDATED,
      expect.objectContaining({ networkConfigUpdated: true })
    );
  });

  test('remove-chain drops the matching native token', async () => {
    const ctx = loadNetworkIpc();

    const result = await ctx.ipcMain.invoke('networks:remove-chain', 777);

    expect(result).toEqual({ success: true });
    expect(ctx.tokenRegistry.getTokenKey).toHaveBeenCalledWith(777, null);
    expect(ctx.tokenRegistry.removeCustomToken).toHaveBeenCalledWith('777:native');
    expect(ctx.providerManager.clearProviderCache).toHaveBeenCalled();
    expect(ctx.ensResolver.invalidateCachedProvider).toHaveBeenCalled();
  });

  test('upsert-source returns validation failures without refreshing downstream caches', async () => {
    const ctx = loadNetworkIpc({
      registry: {
        upsertEndpointSource: jest.fn(() => ({ success: false, error: 'RPC URL must use https://' })),
      },
    });

    const result = await ctx.ipcMain.invoke('networks:upsert-source', 'bad', {
      role: 'rpc',
      keyed: false,
      coverage: { 1: 'http://rpc.example' },
    });

    expect(result).toEqual({ success: false, error: 'RPC URL must use https://' });
    expect(ctx.providerManager.clearProviderCache).not.toHaveBeenCalled();
    expect(ctx.ensResolver.invalidateCachedProvider).not.toHaveBeenCalled();
    expect(ctx.chain.chainSettingsChanged).not.toHaveBeenCalled();
    expect(ctx.send).not.toHaveBeenCalled();
  });

  // Design 0005, "Endpoints serve their chain" (#93): a user's RPC source
  // is asked eth_chainId before it is saved.
  describe("upsert-source checks the endpoint's chain", () => {
    const source = (coverage) => ({ role: 'rpc', keyed: false, coverage });

    test('an endpoint that answers another chain refuses the save, saying so', async () => {
      const ctx = loadNetworkIpc({
        registry: {
          getNetwork: jest.fn((cid) => (String(cid) === '1' ? { name: 'Ethereum' } : null)),
        },
        chain: { checkEndpointChain: jest.fn(async () => 100) },
      });
      const result = await ctx.ipcMain.invoke(
        'networks:upsert-source',
        'user-1',
        source({ 1: 'https://gnosis.example' })
      );
      expect(result).toEqual({
        success: false,
        error: 'This endpoint serves another chain (chain ID 100), not Ethereum. Check the URL.',
      });
      expect(ctx.chain.checkEndpointChain).toHaveBeenCalledWith(1, 'https://gnosis.example');
      expect(ctx.registry.upsertEndpointSource).not.toHaveBeenCalled();
      expect(ctx.chain.chainSettingsChanged).not.toHaveBeenCalled();
    });

    test('a check that merely fails saves it: it stays out until a retry succeeds', async () => {
      const ctx = loadNetworkIpc({ chain: { checkEndpointChain: jest.fn(async () => null) } });
      await expect(
        ctx.ipcMain.invoke(
          'networks:upsert-source',
          'user-1',
          source({ 1: 'https://down.example' })
        )
      ).resolves.toEqual({ success: true });
      expect(ctx.registry.upsertEndpointSource).toHaveBeenCalled();
      expect(ctx.chain.chainSettingsChanged).toHaveBeenCalled();
    });

    test('an endpoint that answers its chain saves', async () => {
      const ctx = loadNetworkIpc();
      await expect(
        ctx.ipcMain.invoke('networks:upsert-source', 'user-1', source({ 100: 'https://g.example' }))
      ).resolves.toEqual({ success: true });
      expect(ctx.chain.checkEndpointChain).toHaveBeenCalledWith(100, 'https://g.example');
    });

    test('every chain a source covers is checked; one mismatch refuses it', async () => {
      const ctx = loadNetworkIpc({
        chain: { checkEndpointChain: jest.fn(async (chainId) => (chainId === 8453 ? 1 : chainId)) },
      });
      const result = await ctx.ipcMain.invoke(
        'networks:upsert-source',
        'user-1',
        source({ 1: 'https://a.example', 8453: 'https://b.example' })
      );
      expect(result).toMatchObject({
        success: false,
        error: expect.stringContaining('chain ID 1'),
      });
      expect(ctx.chain.checkEndpointChain).toHaveBeenCalledTimes(2);
    });

    test("a prover, or a URL that won't validate, isn't asked", async () => {
      const ctx = loadNetworkIpc();
      await ctx.ipcMain.invoke('networks:upsert-source', 'p', {
        role: 'prover',
        keyed: false,
        coverage: { 1: 'https://prover.example' },
      });
      await ctx.ipcMain.invoke(
        'networks:upsert-source',
        'bad',
        source({ 1: 'http://rpc.example' })
      );
      expect(ctx.chain.checkEndpointChain).not.toHaveBeenCalled();
    });
  });

  test('reset-source-coverage refreshes downstream consumers', async () => {
    const ctx = loadNetworkIpc();

    await expect(
      ctx.ipcMain.invoke('networks:reset-source-coverage', 'colibri-corpus', 1)
    ).resolves.toEqual({ success: true });

    expect(ctx.registry.resetEndpointSourceCoverage).toHaveBeenCalledWith('colibri-corpus', 1);
    expect(ctx.providerManager.clearProviderCache).toHaveBeenCalled();
    expect(ctx.ensResolver.invalidateCachedProvider).toHaveBeenCalled();
    expect(ctx.chain.chainSettingsChanged).toHaveBeenCalled();
  });
});
