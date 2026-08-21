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
  const settingsStore = {
    loadSettings: jest.fn(() => ({ theme: 'system', antNodeMode: 'ultraLight' })),
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
      [require.resolve('./chain-catalog')]: () => ({
        searchChains: jest.fn(),
        getCatalogChain: jest.fn(),
      }),
      [require.resolve('../token-registry')]: () => tokenRegistry,
      [require.resolve('../wallet/rpc-manager')]: () => rpcManager,
      [require.resolve('../wallet/provider-manager')]: () => providerManager,
      [require.resolve('../ens-resolver')]: () => ensResolver,
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
    expect(ctx.send).not.toHaveBeenCalled();
  });

  test('reset-source-coverage refreshes downstream consumers', async () => {
    const ctx = loadNetworkIpc();

    await expect(
      ctx.ipcMain.invoke('networks:reset-source-coverage', 'colibri-corpus', 1)
    ).resolves.toEqual({ success: true });

    expect(ctx.registry.resetEndpointSourceCoverage).toHaveBeenCalledWith('colibri-corpus', 1);
    expect(ctx.providerManager.clearProviderCache).toHaveBeenCalled();
    expect(ctx.ensResolver.invalidateCachedProvider).toHaveBeenCalled();
  });
});
