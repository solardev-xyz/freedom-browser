const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROFILE_IPFS_DATA_DIR = '/tmp/freedom-user-data/ipfs-data';
const NATIVE_IPFS_DATA_DIR = path.join(PROFILE_IPFS_DATA_DIR, 'freedom-ipfs');
const loadedContexts = [];

function createWindowMock() {
  return {
    webContents: {
      send: jest.fn(),
    },
  };
}

function loadIpfsManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app =
    options.app ||
    createAppMock({
      isPackaged: options.isPackaged ?? false,
      userDataDir: options.userDataDir || '/tmp/freedom-user-data',
    });
  const windows = options.windows || [];
  const BrowserWindow = {
    getAllWindows: jest.fn(() => windows),
  };
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const clearService = jest.fn();
  const fsMock = {
    mkdirSync: jest.fn(),
  };

  const nativeInstances = [];
  class MockFreedomIpfsNativeNode {
    constructor(config) {
      this.config = config;
      this.start = jest.fn(() => options.startOk !== false);
      this.stop = jest.fn(async () => {});
      this.request = jest.fn(async () => new Response('native-body', { status: 200 }));
      this.isHealthy = jest.fn(() => options.isHealthy !== false);
      this.version = options.nativeVersion || '0.4.1';
      this.buildInfoJson = jest.fn(
        () =>
          options.nativeBuildInfoJson ||
          JSON.stringify({
            name: 'freedom-ipfs',
            version: this.version,
            release_tag: `v${this.version}`,
          })
      );
      this.progressSnapshotJson = jest.fn(() => '{"active":[],"events":[]}');
      this.nativeGatewayStatsJson = jest.fn(() => {
        if (options.statsThrows) throw new Error('stats unavailable');
        return '{"active_native_handles":0}';
      });
      nativeInstances.push(this);
    }

    static isAvailable() {
      return options.nativeAvailable !== false;
    }
  }

  const { mod } = loadMainModule(require.resolve('./ipfs-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      fs: () => fsMock,
      [require.resolve('./logger')]: () => log,
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          BUNDLED: 'bundled',
          EXTERNAL: 'external',
          DISABLED: 'disabled',
          NONE: 'none',
        },
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
      }),
      [require.resolve('./ipfs/freedom-ipfs-native-node')]: () => ({
        FreedomIpfsNativeNode: MockFreedomIpfsNativeNode,
      }),
      [require.resolve('./profile-paths')]: () => ({
        getIpfsDataDir: jest.fn(() => options.ipfsDataDir || PROFILE_IPFS_DATA_DIR),
      }),
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => options.activeProfile || null),
      }),
    },
  });

  const context = {
    app,
    BrowserWindow,
    clearService,
    fsMock,
    ipcMain,
    log,
    mod,
    nativeInstances,
    setStatusMessage,
    setErrorState,
    clearErrorState,
    updateService,
    windows,
  };
  loadedContexts.push(context);
  return context;
}

describe('ipfs-manager', () => {
  afterEach(async () => {
    for (const ctx of loadedContexts.splice(0)) {
      await ctx.mod.stopIpfs();
    }
    jest.clearAllMocks();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports native availability plus initial status', async () => {
    const ctx = loadIpfsManagerModule({
      nativeAvailable: false,
    });

    ctx.mod.registerIpfsIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual(
      [IPC.IPFS_START, IPC.IPFS_STOP, IPC.IPFS_GET_STATUS, IPC.IPFS_CHECK_BINARY].sort()
    );

    await expect(ctx.ipcMain.invoke(IPC.IPFS_GET_STATUS)).resolves.toEqual({
      status: 'stopped',
      error: null,
      diagnostics: {
        progress: '{"active":[],"events":[]}',
        nativeGatewayStats: '{}',
        nativeVersion: null,
        nativeBuildInfo: null,
      },
    });
    await expect(ctx.ipcMain.invoke(IPC.IPFS_CHECK_BINARY)).resolves.toEqual({
      available: false,
    });
  });

  test('starts the bundled freedom-ipfs native node', async () => {
    const window = createWindowMock();
    const ctx = loadIpfsManagerModule({ windows: [window] });

    await ctx.mod.startIpfs();

    expect(ctx.fsMock.mkdirSync).toHaveBeenCalledWith(NATIVE_IPFS_DATA_DIR, { recursive: true });
    expect(ctx.nativeInstances).toHaveLength(1);
    expect(ctx.nativeInstances[0].config).toEqual({
      dataDir: NATIVE_IPFS_DATA_DIR,
      onFailure: expect.any(Function),
    });
    expect(ctx.nativeInstances[0].start).toHaveBeenCalled();
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: null,
      gateway: null,
      mode: 'bundled',
      backend: 'freedom-ipfs',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node: freedom-ipfs 0.4.1');
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'starting',
      error: null,
    });
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'running',
      error: null,
    });
  });

  test('does not start native IPFS when the active profile disables it', async () => {
    const ctx = loadIpfsManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            ipfs: { mode: 'disabled', backend: 'freedom-ipfs' },
          },
        },
      },
    });

    await ctx.mod.startIpfs();

    expect(ctx.nativeInstances).toHaveLength(0);
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
    expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
      api: null,
      gateway: null,
      mode: 'disabled',
      backend: 'freedom-ipfs',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node disabled for this profile');
  });

  test('serves native gateway requests only while running', async () => {
    const ctx = loadIpfsManagerModule();

    const stoppedResponse = await ctx.mod.serveNativeGatewayRequest({
      path: '/ipfs/bafy',
      method: 'GET',
      headers: new Headers(),
    });
    expect(stoppedResponse.status).toBe(503);

    await ctx.mod.startIpfs();
    const response = await ctx.mod.serveNativeGatewayRequest({
      path: '/ipfs/bafy',
      method: 'GET',
      headers: new Headers(),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('native-body');
    expect(ctx.nativeInstances[0].request).toHaveBeenCalledWith({
      method: 'GET',
      path: '/ipfs/bafy',
      headers: expect.any(Headers),
      signal: undefined,
    });
  });

  test('reports native version and build metadata in diagnostics', async () => {
    const ctx = loadIpfsManagerModule({
      nativeVersion: '0.4.1',
      nativeBuildInfoJson: JSON.stringify({
        name: 'freedom-ipfs',
        version: '0.4.1',
        release_tag: 'v0.4.1',
        target: 'linux-x64',
      }),
    });

    await ctx.mod.startIpfs();

    expect(ctx.mod.getNativeDiagnostics()).toEqual({
      progress: '{"active":[],"events":[]}',
      nativeGatewayStats: '{"active_native_handles":0}',
      nativeVersion: '0.4.1',
      nativeBuildInfo: JSON.stringify({
        name: 'freedom-ipfs',
        version: '0.4.1',
        release_tag: 'v0.4.1',
        target: 'linux-x64',
      }),
    });
  });

  test('stops the native node and clears registry state', async () => {
    const ctx = loadIpfsManagerModule();

    await ctx.mod.startIpfs();
    await ctx.mod.stopIpfs();

    expect(ctx.nativeInstances[0].stop).toHaveBeenCalled();
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
    expect(ctx.clearErrorState).toHaveBeenCalledWith('ipfs');
  });

  test('a start requested mid-stop queues behind the stop and resolves once running', async () => {
    const flush = () => new Promise((resolve) => setImmediate(resolve));
    const ctx = loadIpfsManagerModule();
    ctx.mod.registerIpfsIpc();

    // Bring the node up.
    await ctx.ipcMain.invoke(IPC.IPFS_START);
    expect(ctx.nativeInstances).toHaveLength(1);

    // Make the stop hang so a start can be requested while the node is STOPPING.
    let releaseStop;
    ctx.nativeInstances[0].stop.mockImplementation(
      () => new Promise((resolve) => {
        releaseStop = resolve;
      })
    );

    const stopResult = ctx.ipcMain.invoke(IPC.IPFS_STOP);
    await flush();

    // Mid-stop the user flips back on. The start must queue behind the in-flight
    // stop rather than be dropped or run concurrently.
    const startResult = ctx.ipcMain.invoke(IPC.IPFS_START);
    await flush();

    // Still stopping: the queued start hasn't spun up a new node yet, and the
    // reported status is the live transitional state.
    expect(ctx.nativeInstances).toHaveLength(1);
    await expect(ctx.ipcMain.invoke(IPC.IPFS_GET_STATUS)).resolves.toMatchObject({
      status: 'stopping',
    });

    // Let the stop finish; the queued start then runs to completion.
    releaseStop();

    // The stop IPC settles to 'stopped', and crucially the start IPC resolves
    // only once the node is actually back up — not with the transient 'stopping'.
    expect((await stopResult).status).toBe('stopped');
    expect((await startResult).status).toBe('running');
    expect(ctx.nativeInstances).toHaveLength(2);
  });

  test('moves to error and cleans up when the native node reports failure', async () => {
    const window = createWindowMock();
    const ctx = loadIpfsManagerModule({ windows: [window] });

    await ctx.mod.startIpfs();
    ctx.nativeInstances[0].config.onFailure('dispatcher died', ctx.nativeInstances[0]);
    await Promise.resolve();

    expect(ctx.nativeInstances[0].stop).toHaveBeenCalled();
    expect(ctx.clearService).toHaveBeenCalledWith('ipfs');
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Node unavailable');
    expect(ctx.setErrorState).toHaveBeenCalledWith(
      'ipfs',
      'Node unavailable. Restart IPFS from the nodes menu.'
    );
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.IPFS_STATUS_UPDATE, {
      status: 'error',
      error: 'dispatcher died',
    });

    const response = await ctx.mod.serveNativeGatewayRequest({
      path: '/ipfs/bafy',
      method: 'GET',
      headers: new Headers(),
    });
    expect(response.status).toBe(503);
  });

  test('health check reflects native liveness and diagnostics availability', async () => {
    const unhealthy = loadIpfsManagerModule({ isHealthy: false });
    await unhealthy.mod.startIpfs();
    expect(unhealthy.mod.checkHealth()).toBe(false);

    const throwingStats = loadIpfsManagerModule({ statsThrows: true });
    await throwingStats.mod.startIpfs();
    expect(throwingStats.mod.checkHealth()).toBe(false);
    expect(throwingStats.log.warn).toHaveBeenCalledWith(
      '[IPFS] Native health check failed:',
      'stats unavailable'
    );
  });

  test('fails startup when the native addon is unavailable', async () => {
    const ctx = loadIpfsManagerModule({
      nativeAvailable: false,
    });

    await ctx.mod.startIpfs();

    expect(ctx.nativeInstances).toHaveLength(0);
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'Native node unavailable');
    await expect(
      ctx.mod.serveNativeGatewayRequest({
        path: '/ipfs/bafy',
        method: 'GET',
        headers: new Headers(),
      })
    ).resolves.toMatchObject({ status: 503 });
  });

  test('starts in external mode and proxies gateway requests even when the native addon is absent', async () => {
    const window = createWindowMock();
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response('external-body', { status: 200 }));
    try {
      const ctx = loadIpfsManagerModule({
        windows: [window],
        // The native addon cannot load external mode must work regardless.
        nativeAvailable: false,
        activeProfile: {
          metadata: {
            nodes: {
              ipfs: { mode: 'external', externalGateway: 'http://127.0.0.1:8080' },
            },
          },
        },
      });

      await ctx.mod.startIpfs();

      expect(ctx.nativeInstances).toHaveLength(0);
      expect(ctx.updateService).toHaveBeenCalledWith('ipfs', {
        api: null,
        gateway: 'http://127.0.0.1:8080',
        mode: 'external',
        backend: 'external-gateway',
      });
      expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'External node: 127.0.0.1:8080');
      expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.IPFS_STATUS_UPDATE, {
        status: 'running',
        error: null,
      });

      const response = await ctx.mod.serveNativeGatewayRequest({
        path: '/ipfs/bafy',
        method: 'GET',
        headers: new Headers(),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('external-body');
      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:8080/ipfs/bafy',
        expect.objectContaining({ method: 'GET', redirect: 'follow' })
      );
    } finally {
      global.fetch = realFetch;
    }
  });

  test('external mode reports the gateway unreachable when the probe fails', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response('bad gateway', { status: 502 }));
    try {
      const ctx = loadIpfsManagerModule({
        activeProfile: {
          metadata: {
            nodes: {
              ipfs: { mode: 'external', externalGateway: 'http://127.0.0.1:8080' },
            },
          },
        },
      });
      ctx.mod.registerIpfsIpc();

      await ctx.mod.startIpfs();

      expect(ctx.nativeInstances).toHaveLength(0);
      expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'External node unreachable');
      await expect(ctx.ipcMain.invoke(IPC.IPFS_GET_STATUS)).resolves.toMatchObject({
        status: 'error',
      });
    } finally {
      global.fetch = realFetch;
    }
  });

  test('stopping an external node keeps external mode in the registry so it can be re-enabled', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response('external-body', { status: 200 }));
    try {
      const ctx = loadIpfsManagerModule({
        // Native addon absent: the only way back on is that the registry still
        // advertises external mode after a stop.
        nativeAvailable: false,
        activeProfile: {
          metadata: {
            nodes: {
              ipfs: { mode: 'external', externalGateway: 'http://127.0.0.1:8080' },
            },
          },
        },
      });

      await ctx.mod.startIpfs();
      ctx.updateService.mockClear();
      ctx.clearService.mockClear();
      await ctx.mod.stopIpfs();

      // On stop the registry is NOT cleared to 'none'. It keeps external mode +
      // endpoint so the renderer can offer to switch it back on.
      expect(ctx.clearService).not.toHaveBeenCalled();
      expect(ctx.updateService).toHaveBeenLastCalledWith('ipfs', {
        api: null,
        gateway: 'http://127.0.0.1:8080',
        mode: 'external',
        backend: 'external-gateway',
      });
      expect(ctx.setStatusMessage).toHaveBeenLastCalledWith('ipfs', 'External node stopped');
    } finally {
      global.fetch = realFetch;
    }
  });

  test('external mode without a gateway URL is reported as not configured', async () => {
    const ctx = loadIpfsManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            ipfs: { mode: 'external' },
          },
        },
      },
    });

    await ctx.mod.startIpfs();

    expect(ctx.nativeInstances).toHaveLength(0);
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ipfs', 'External node not configured');
  });

  test('external mode reports gateway telemetry (bytes streamed + active handles) via diagnostics', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async () => new Response('external-body', { status: 200 }));
    try {
      const ctx = loadIpfsManagerModule({
        nativeAvailable: false,
        activeProfile: {
          metadata: {
            nodes: {
              ipfs: { mode: 'external', externalGateway: 'http://127.0.0.1:8080' },
            },
          },
        },
      });
      await ctx.mod.startIpfs();

      // External-shaped stats, zeroed before any request is served.
      expect(JSON.parse(ctx.mod.getNativeDiagnostics().nativeGatewayStats)).toEqual({
        active_native_handles: 0,
        bytes_read: 0,
      });

      const res = await ctx.mod.serveNativeGatewayRequest({
        path: '/ipfs/bafy',
        method: 'GET',
        headers: new Headers(),
      });
      // Draining the response is what advances the byte tally (counted as bytes
      // stream through, like the native drain loop) and releases the handle.
      expect(await res.text()).toBe('external-body');

      const stats = JSON.parse(ctx.mod.getNativeDiagnostics().nativeGatewayStats);
      expect(stats.bytes_read).toBe(Buffer.byteLength('external-body'));
      expect(stats.active_native_handles).toBe(0);
    } finally {
      global.fetch = realFetch;
    }
  });

  test('external mode detects the Kubo version from the RPC API and reports it as identity', async () => {
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (url) => {
      if (String(url).includes('/api/v0/version')) {
        return new Response(JSON.stringify({ Version: '0.30.0' }), { status: 200 });
      }
      return new Response('external-body', { status: 200 });
    });
    try {
      const ctx = loadIpfsManagerModule({
        nativeAvailable: false,
        activeProfile: {
          metadata: {
            nodes: {
              ipfs: { mode: 'external', externalGateway: 'http://127.0.0.1:8080' },
            },
          },
        },
      });
      await ctx.mod.startIpfs();
      // The version detection is fire-and-forget; let its microtasks settle.
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }

      const diag = ctx.mod.getNativeDiagnostics();
      expect(diag.externalGateway).toBe('http://127.0.0.1:8080');
      expect(diag.externalVersion).toBe('Kubo 0.30.0');
      // The version probe targets the RPC API port (:5001)
      expect(global.fetch).toHaveBeenCalledWith(
        'http://127.0.0.1:5001/api/v0/version',
        expect.objectContaining({ method: 'POST' })
      );
    } finally {
      global.fetch = realFetch;
    }
  });

  test('normalizeExternalGatewayUrl canonicalizes hosts and rejects unusable values', () => {
    const ctx = loadIpfsManagerModule();
    expect(ctx.mod.normalizeExternalGatewayUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(ctx.mod.normalizeExternalGatewayUrl('http://localhost:8080/')).toBe(
      'http://localhost:8080'
    );
    expect(ctx.mod.normalizeExternalGatewayUrl('   ')).toBeNull();
    expect(ctx.mod.normalizeExternalGatewayUrl('ftp://example.test')).toBeNull();
    expect(ctx.mod.normalizeExternalGatewayUrl(null)).toBeNull();
  });
});
