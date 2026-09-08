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

  test('keeps static native IPFS and Radicle routes available before registry updates', async () => {
    const defaults = await loadModule();
    expect(defaults.state.bzzRoutePrefix).toBeNull();
    expect(defaults.state.ipfsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipfs/');
    expect(defaults.state.ipnsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipns/');
    expect(defaults.state.radicleApiPrefix).toBe('radapi://local/api/v1/repos/');

    const custom = await loadModule({
      antApi: 'http://127.0.0.1:1733/',
    });
    expect(custom.state.bzzRoutePrefix).toBe('http://127.0.0.1:1733/bzz/');
    expect(custom.state.ipfsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipfs/');
    expect(custom.state.ipnsRoutePrefix).toBe('http://freedom-ipfs.localhost/ipns/');
  });

  test('builds service urls from registry values and static native routes', async () => {
    const mod = await loadModule();

    expect(() => mod.buildAntUrl('/health')).toThrow('Ant endpoint is not ready');
    expect(() => mod.buildIpfsApiUrl('/api/v0/id')).toThrow(
      'IPFS API endpoint is not ready'
    );
    expect(mod.buildRadicleUrl('/api/v1')).toBe('radapi://local/api/v1');

    mod.updateRegistry({
      ant: { api: 'http://127.0.0.1:1999', gateway: 'http://127.0.0.1:1999' },
      ipfs: { api: 'http://127.0.0.1:5999', gateway: 'http://127.0.0.1:8999' },
      radicle: { api: 'radapi://local', gateway: 'radapi://local' },
    });

    expect(mod.buildAntUrl('/health')).toBe('http://127.0.0.1:1999/health');
    expect(mod.buildIpfsApiUrl('/api/v0/id')).toBe('http://127.0.0.1:5999/api/v0/id');
    expect(mod.buildRadicleUrl('/api/v1')).toBe('radapi://local/api/v1');
    expect(mod.state.antBase).toBe('http://127.0.0.1:1999');
    expect(mod.state.ipfsBase).toBe('http://127.0.0.1:8999');
    expect(mod.state.ipfsApiBase).toBe('http://127.0.0.1:5999');
    expect(mod.state.radicleBase).toBe('radapi://local');
  });

  test('returns service display messages', async () => {
    const mod = await loadModule();

    mod.updateRegistry({
      ...mod.state.registry,
      ant: {
        api: null,
        gateway: null,
        mode: 'none',
        statusMessage: 'Ready',
        tempMessage: 'Starting',
      },
    });

    expect(mod.getDisplayMessage('ant')).toBe('Starting');
    expect(mod.getDisplayMessage('missing')).toBeNull();
  });
});
