describe('renderer state', () => {
  const originalWindow = global.window;

  const loadModule = async (nodeConfig = {}) => {
    jest.resetModules();
    global.window = { nodeConfig };
    return import('./state.js');
  };

  afterEach(() => {
    global.window = originalWindow;
  });

  test('builds route prefixes from defaults or window config', async () => {
    const defaults = await loadModule();
    expect(defaults.state.bzzRoutePrefix).toBe('http://127.0.0.1:1633/bzz/');
    expect(defaults.state.ipfsRoutePrefix).toBe('http://127.0.0.1:8080/ipfs/');
    expect(defaults.state.ipnsRoutePrefix).toBe('http://127.0.0.1:8080/ipns/');
    expect(defaults.state.radicleApiPrefix).toBe('http://127.0.0.1:8780/api/v1/repos/');

    const custom = await loadModule({
      beeApi: 'http://127.0.0.1:1733/',
      ipfsGateway: 'http://127.0.0.1:8181/',
    });
    expect(custom.state.bzzRoutePrefix).toBe('http://127.0.0.1:1733/bzz/');
    expect(custom.state.ipfsRoutePrefix).toBe('http://127.0.0.1:8181/ipfs/');
    expect(custom.state.ipnsRoutePrefix).toBe('http://127.0.0.1:8181/ipns/');
  });

  test('builds service urls from registry values or fallbacks', async () => {
    const mod = await loadModule();

    expect(mod.buildBeeUrl('/health')).toBe('http://127.0.0.1:1633/health');
    expect(mod.buildIpfsApiUrl('/api/v0/id')).toBe('http://127.0.0.1:5001/api/v0/id');
    expect(mod.buildRadicleUrl('/api/v1')).toBe('http://127.0.0.1:8780/api/v1');

    mod.updateRegistry({
      bee: { api: 'http://127.0.0.1:1999', gateway: 'http://127.0.0.1:1999' },
      ipfs: { api: 'http://127.0.0.1:5999', gateway: 'http://127.0.0.1:8999' },
      radicle: { api: 'http://127.0.0.1:8781', gateway: 'http://127.0.0.1:8781' },
    });

    expect(mod.buildBeeUrl('/health')).toBe('http://127.0.0.1:1999/health');
    expect(mod.buildIpfsApiUrl('/api/v0/id')).toBe('http://127.0.0.1:5999/api/v0/id');
    expect(mod.buildRadicleUrl('/api/v1')).toBe('http://127.0.0.1:8781/api/v1');
    expect(mod.state.beeBase).toBe('http://127.0.0.1:1999');
    expect(mod.state.ipfsBase).toBe('http://127.0.0.1:8999');
    expect(mod.state.ipfsApiBase).toBe('http://127.0.0.1:5999');
    expect(mod.state.radicleBase).toBe('http://127.0.0.1:8781');
  });

  test('normalizes the radicle feature flag and service display messages', async () => {
    const mod = await loadModule();

    mod.setRadicleIntegrationEnabled(true);
    expect(mod.state.enableRadicleIntegration).toBe(true);

    mod.setRadicleIntegrationEnabled('yes');
    expect(mod.state.enableRadicleIntegration).toBe(false);

    mod.updateRegistry({
      ...mod.state.registry,
      bee: {
        api: null,
        gateway: null,
        mode: 'none',
        statusMessage: 'Ready',
        tempMessage: 'Starting',
      },
    });

    expect(mod.getDisplayMessage('bee')).toBe('Starting');
    expect(mod.getDisplayMessage('missing')).toBeNull();
  });
});
