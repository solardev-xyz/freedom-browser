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
  const keyListeners = [];
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const rpcManager = {
    providersWithKeys: jest.fn(async () => new Set()),
    setApiKey: jest.fn(async () => ({ success: true })),
    removeApiKey: jest.fn(async () => ({ success: true })),
    testApiKey: jest.fn(() => ({ success: true })),
    onKeysChanged: jest.fn((listener) => keyListeners.push(listener)),
    ...(options.rpcManager || {}),
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
      [require.resolve('../logger')]: () => log,
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
    keyListeners,
    log,
  };
}

describe('network-ipc', () => {
  // freedom-core design 0013, "RPC API keys" (PRF-6(e)): the keys are the
  // identity core's; the settings page sees presence, as the chrome.
  test("get-config tags keyed sources with the core's presence, asked as the chrome", async () => {
    const ctx = loadNetworkIpc({
      registry: {
        getEndpointSourceList: jest.fn(() => [
          { id: 'alchemy', role: 'rpc', keyed: true },
          { id: 'infura', role: 'rpc', keyed: true },
          { id: 'public', role: 'rpc', keyed: false },
        ]),
      },
      rpcManager: { providersWithKeys: jest.fn(async () => new Set(['alchemy'])) },
    });

    const answer = await ctx.ipcMain.invoke('networks:get-config');

    expect(ctx.rpcManager.providersWithKeys).toHaveBeenCalledWith({ caller: 'chrome' });
    expect(answer).toEqual({
      success: true,
      networks: {},
      sources: [
        { id: 'alchemy', role: 'rpc', keyed: true, hasKey: true },
        { id: 'infura', role: 'rpc', keyed: true, hasKey: false },
        { id: 'public', role: 'rpc', keyed: false },
      ],
    });
  });

  // Coordinator decision G30: a core that can't answer the key status
  // (down, `requirement_unmet`, `storage`) doesn't blank the Chains page
  // or the ENS lens. The configuration is main's; only presence is unknown.
  test.each([
    ['requirement_unmet', "The core can't take this request"],
    ['storage', 'The secrets file could not be read'],
    [undefined, 'The identity core is not running'],
  ])("get-config answers the configuration with hasKey null when the core can't (%s)", async (code, message) => {
    const refusal = Object.assign(new Error(message), code ? { code } : {});
    const ctx = loadNetworkIpc({
      registry: {
        getAllNetworks: jest.fn(() => ({ 1: { name: 'Ethereum' } })),
        getEndpointSourceList: jest.fn(() => [
          { id: 'alchemy', role: 'rpc', keyed: true },
          { id: 'public', role: 'rpc', keyed: false },
        ]),
      },
      rpcManager: { providersWithKeys: jest.fn(async () => Promise.reject(refusal)) },
    });

    await expect(ctx.ipcMain.invoke('networks:get-config')).resolves.toEqual({
      success: true,
      networks: { 1: { name: 'Ethereum' } },
      sources: [
        { id: 'alchemy', role: 'rpc', keyed: true, hasKey: null },
        { id: 'public', role: 'rpc', keyed: false },
      ],
    });
    expect(ctx.log.warn).toHaveBeenCalledTimes(1);
    expect(ctx.log.warn.mock.calls[0][0]).toContain(message);
    expect(ctx.log.warn.mock.calls[0][0]).toContain(code || 'error');
  });

  test('set-api-key and remove-api-key go as the chrome, and answer rpc-manager', async () => {
    const ctx = loadNetworkIpc({
      rpcManager: {
        setApiKey: jest.fn(async () => ({ success: false, error: 'Invalid API key' })),
      },
    });

    await expect(ctx.ipcMain.invoke('networks:set-api-key', 'alchemy', 'k')).resolves.toEqual({
      success: false,
      error: 'Invalid API key',
    });
    expect(ctx.rpcManager.setApiKey).toHaveBeenCalledWith('alchemy', 'k', { caller: 'chrome' });
    await expect(ctx.ipcMain.invoke('networks:remove-api-key', 'alchemy')).resolves.toEqual({
      success: true,
    });
    expect(ctx.rpcManager.removeApiKey).toHaveBeenCalledWith('alchemy', { caller: 'chrome' });
    // The downstream caches follow a change to main's copy of the keys,
    // not the IPC answer.
    expect(ctx.providerManager.clearProviderCache).not.toHaveBeenCalled();
  });

  test("a change to main's copy of the keys refreshes everything downstream", () => {
    const ctx = loadNetworkIpc();
    expect(ctx.keyListeners).toHaveLength(1);

    ctx.keyListeners[0]();

    expect(ctx.providerManager.clearProviderCache).toHaveBeenCalledTimes(1);
    expect(ctx.ensResolver.invalidateCachedProvider).toHaveBeenCalledTimes(1);
    expect(ctx.chain.chainSettingsChanged).toHaveBeenCalledTimes(1);
    expect(ctx.send).toHaveBeenCalledWith(
      IPC.SETTINGS_UPDATED,
      expect.objectContaining({ networkConfigUpdated: true })
    );
  });

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

    // #791 review, finding 3: through the real checks.
    test('an edited endpoint that answered another chain before, whose check now fails, saves', async () => {
      const { EndpointChecks } = require('../core/endpoint-checks');
      let served = 100;
      const checks = new EndpointChecks({ ask: async () => served, log: { warn() {} } });
      checks.sync([{ chainId: 1, url: 'https://old.example' }]);
      await checks.settled([{ chainId: 1, url: 'https://old.example' }], 100);
      expect(checks.answer(1, 'https://old.example')).toBe(100);
      served = null;
      const ctx = loadNetworkIpc({
        chain: { checkEndpointChain: (chainId, url) => checks.check(chainId, url) },
      });
      await expect(
        ctx.ipcMain.invoke('networks:upsert-source', 'old', source({ 1: 'https://old.example' }))
      ).resolves.toEqual({ success: true });
      expect(ctx.registry.upsertEndpointSource).toHaveBeenCalled();
      checks.reset();
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

  // #791 review, finding 6: a chain added by hand has its typed RPC URL
  // checked before it is saved; one picked from the catalog keeps a
  // catalog's handling.
  describe('add-chain: a typed RPC URL serves its chain', () => {
    const MANUAL = {
      chainId: 777,
      name: 'Private Ethereum',
      nativeSymbol: 'ETH',
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      blockExplorer: '',
    };

    test('one that answers another chain refuses the save, naming the chain typed', async () => {
      const ctx = loadNetworkIpc({ chain: { checkEndpointChain: jest.fn(async () => 100) } });
      await expect(
        ctx.ipcMain.invoke('networks:add-chain', MANUAL, ['https://gnosis.example'], {
          entered: true,
        })
      ).resolves.toEqual({
        success: false,
        error:
          'This endpoint serves another chain (chain ID 100), not Private Ethereum. Check the URL.',
      });
      expect(ctx.chain.checkEndpointChain).toHaveBeenCalledWith(777, 'https://gnosis.example');
      expect(ctx.registry.addCustomChain).not.toHaveBeenCalled();
      expect(ctx.tokenRegistry.addCustomToken).not.toHaveBeenCalled();
      expect(ctx.chain.chainSettingsChanged).not.toHaveBeenCalled();
    });

    test('one that answers it, or whose check merely fails, saves', async () => {
      for (const answer of [777, null]) {
        const ctx = loadNetworkIpc({ chain: { checkEndpointChain: jest.fn(async () => answer) } });
        await expect(
          ctx.ipcMain.invoke('networks:add-chain', MANUAL, [' https://rpc.example '], {
            entered: true,
          })
        ).resolves.toMatchObject({ success: true });
        expect(ctx.chain.checkEndpointChain).toHaveBeenCalledWith(777, 'https://rpc.example');
        expect(ctx.registry.addCustomChain).toHaveBeenCalled();
      }
    });

    test("a catalog pick isn't asked: an endpoint of it that serves another chain is left out, not refused", async () => {
      const ctx = loadNetworkIpc({ chain: { checkEndpointChain: jest.fn(async () => 100) } });
      await expect(
        ctx.ipcMain.invoke('networks:add-chain', MANUAL, ['https://a.example', 'https://b.example'])
      ).resolves.toMatchObject({ success: true });
      expect(ctx.chain.checkEndpointChain).not.toHaveBeenCalled();
    });

    test('the manual form says its URL was typed; a catalog pick does not', () => {
      const settings = require('fs').readFileSync(
        require('path').join(__dirname, '../../renderer/pages/scripts/settings.js'),
        'utf8'
      );
      expect(settings).toMatch(/\[rpc\],\s*failManual,\s*\{ entered: true \}/);
      expect(settings).toMatch(/c\.rpcUrls \|\| \[\],\s*failConfirm\s*\)/);
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
