const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createProcessMock(binary, options = {}) {
  const listeners = new Map();
  const onceListeners = new Map();
  const stdoutListeners = new Map();
  const stderrListeners = new Map();

  const emitAll = (store, event, args) => {
    for (const handler of store.get(event) || []) {
      handler(...args);
    }
  };

  const proc = {
    binary,
    kills: [],
    stdout: {
      on: jest.fn((event, handler) => {
        if (!stdoutListeners.has(event)) stdoutListeners.set(event, []);
        stdoutListeners.get(event).push(handler);
      }),
    },
    stderr: {
      on: jest.fn((event, handler) => {
        if (!stderrListeners.has(event)) stderrListeners.set(event, []);
        stderrListeners.get(event).push(handler);
      }),
    },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceListeners.has(event)) onceListeners.set(event, []);
      onceListeners.get(event).push(handler);
    }),
    emit(event, ...args) {
      emitAll(listeners, event, args);
      const oneTimeHandlers = onceListeners.get(event) || [];
      onceListeners.delete(event);
      oneTimeHandlers.forEach((h) => h(...args));
    },
    kill: jest.fn((signal) => {
      proc.kills.push(signal);
      if (options.autoCloseOnKill !== false) {
        setTimeout(() => proc.emit('close', options.closeCode ?? 0), 0);
      }
      return true;
    }),
  };

  return proc;
}

function createSocketClass(portResolver) {
  const queue = Array.isArray(portResolver) ? [...portResolver] : null;

  return class MockSocket {
    constructor() {
      this.handlers = {};
    }

    setTimeout() {}

    on(event, handler) {
      this.handlers[event] = handler;
    }

    destroy() {}

    connect(port) {
      const result =
        typeof portResolver === 'function'
          ? portResolver(port)
          : queue && queue.length > 0
            ? queue.shift()
            : false;

      if (result === true) {
        this.handlers.connect?.();
        return;
      }

      if (result === 'timeout') {
        this.handlers.timeout?.();
        return;
      }

      this.handlers.error?.(new Error('closed'));
    }
  };
}

function createHttpRequestMock(responseResolver) {
  const resolveResponse = responseResolver || (() => ({ statusCode: 200 }));

  return jest.fn((options, callback) => {
    const requestHandlers = new Map();
    const request = {
      on: jest.fn((event, fn) => {
        requestHandlers.set(event, fn);
        return request;
      }),
      destroy: jest.fn(),
      end: jest.fn(),
    };

    const responseConfig = resolveResponse(options);

    if (responseConfig?.error) {
      setTimeout(() => requestHandlers.get('error')?.(responseConfig.error), 0);
      return request;
    }

    if (responseConfig?.timeout) {
      setTimeout(() => requestHandlers.get('timeout')?.(), 0);
      return request;
    }

    const response = {
      statusCode: responseConfig?.statusCode ?? 200,
      resume: jest.fn(),
    };

    if (typeof callback === 'function') {
      callback(response);
    }

    return request;
  });
}

function createWindowMock() {
  return {
    webContents: {
      send: jest.fn(),
    },
  };
}

function loadTonManagerModule(options = {}) {
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
  const requestSession = options.requestSession || {};
  const registerTonProtocol = jest.fn();
  const settings = { enableTonIntegration: options.enabled !== false };
  const onSettingsChanged = jest.fn();
  const activeProfile = {
    metadata: { nodes: { ton: { mode: options.profileMode || 'managed' } } },
  };
  const webContents = {
    fromId: jest.fn((id) => {
      if (!Number.isInteger(id)) throw new TypeError('webContentsId must be an integer');
      return id === 42 ? { session: requestSession } : null;
    }),
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
  const registerWebRequestHandler = jest.fn();
  const spawnedProcesses = [];
  const spawn = jest.fn((binary, args = [], spawnOptions = {}) => {
    const proc = (options.createProcess || createProcessMock)(binary, options.processOptions || {});
    proc.args = args;
    proc.spawnOptions = spawnOptions;
    spawnedProcesses.push(proc);
    return proc;
  });

  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName =
    process.platform === 'win32' ? 'tonutils-freedom-cli.exe' : 'tonutils-freedom-cli';
  const tonBinPath = path.join(PROJECT_ROOT, 'ton-bin', `${platform}-${process.arch}`, binName);

  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') return options.existsSync(target);
      if (target === tonBinPath) return options.binExists !== false;
      return false;
    }),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn(() => ''),
    writeFileSync: jest.fn(),
    createReadStream: jest.fn(),
  };

  const httpRequest = options.httpRequest || createHttpRequestMock(options.httpResponse);
  const Socket = createSocketClass(options.portSequence || options.portResolver || false);

  const { mod } = loadMainModule(require.resolve('./ton-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    webContents,
    extraMocks: {
      child_process: () => ({ spawn }),
      fs: () => fsMock,
      http: () => ({ request: httpRequest }),
      net: () => ({ Socket }),
      [require.resolve('./logger')]: () => log,
      [require.resolve('./ton-protocol')]: () => ({ registerTonProtocol }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings: () => settings,
        onSettingsChanged,
      }),
      [require.resolve('./profile-resolver')]: () => ({ getActiveProfile: () => activeProfile }),
      [require.resolve('./profile-paths')]: () => ({
        getTonDataDir: jest.fn(() => '/tmp/freedom-user-data/ton-data'),
      }),
      [require.resolve('./webrequest-dispatcher')]: () => ({ registerWebRequestHandler }),
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          BUNDLED: 'bundled',
          REUSED: 'reused',
          EXTERNAL: 'external',
          DISABLED: 'disabled',
          NONE: 'none',
        },
        DEFAULTS: {
          ton: { proxyPort: 18085, fallbackRange: 10 },
        },
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
      }),
    },
  });

  return {
    registerTonProtocol,
    activeProfile,
    settings,
    onSettingsChanged,
    BrowserWindow,
    clearErrorState,
    clearService,
    fsMock,
    httpRequest,
    ipcMain,
    log,
    mod,
    registerWebRequestHandler,
    requestSession,
    setErrorState,
    setStatusMessage,
    spawn,
    spawnedProcesses,
    tonBinPath,
    updateService,
    webContents,
    windows,
  };
}

describe('ton-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports binary availability plus initial status', async () => {
    const ctx = loadTonManagerModule({ binExists: false });
    ctx.mod.registerTonIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual(
      [IPC.TON_START, IPC.TON_STOP, IPC.TON_GET_STATUS, IPC.TON_CHECK_BINARY].sort()
    );

    const status = await ctx.ipcMain.invoke(IPC.TON_GET_STATUS);
    expect(status.status).toBe('stopped');
    expect(status.error).toBeNull();

    const binary = await ctx.ipcMain.invoke(IPC.TON_CHECK_BINARY);
    expect(binary.available).toBe(false);
  });

  test('registers a fail-closed request guard for TON HTTP traffic', () => {
    const ctx = loadTonManagerModule();
    ctx.mod.registerTonRequestGuard();
    ctx.mod.registerTonRequestGuard();

    expect(ctx.registerWebRequestHandler).toHaveBeenCalledTimes(1);
    expect(ctx.registerWebRequestHandler).toHaveBeenCalledWith(
      'onBeforeRequest',
      'ton-routing-guard',
      ctx.mod.guardTonRequest,
      { failClosed: true }
    );
    expect(ctx.mod.guardTonRequest({ url: 'http://foundation.ton/', webContentsId: 42 })).toEqual({
      cancel: true,
    });
    expect(ctx.mod.guardTonRequest({ url: 'http://foundation.ton./', webContentsId: 42 })).toEqual({
      cancel: true,
    });
    expect(ctx.mod.guardTonRequest({ url: 'https://name.t.me/', webContentsId: 42 })).toBeNull();
    expect(
      ctx.mod.guardTonRequest({ url: 'wss://socket.foundation.ton/', webContentsId: 42 })
    ).toEqual({
      cancel: true,
    });
    expect(ctx.mod.guardTonRequest({ url: 'https://t.me/freedom', webContentsId: 42 })).toBeNull();
    expect(ctx.mod.guardTonRequest({ url: 'https://example.com/', webContentsId: 42 })).toBeNull();
    expect(ctx.mod.guardTonRequest({ url: 'http://foundation.ton/' })).toEqual({ cancel: true });
    expect(ctx.webContents.fromId).not.toHaveBeenCalledWith(undefined);
  });

  test('fails startup when binary is missing', async () => {
    const ctx = loadTonManagerModule({
      binExists: false,
      portSequence: [false],
    });

    await ctx.mod.startTon();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ton', 'Proxy failed to start');
  });

  test('transitions STOPPED → STARTING → RUNNING on first successful health check', async () => {
    jest.useFakeTimers();

    const window = createWindowMock();
    const ctx = loadTonManagerModule({
      windows: [window],
      portSequence: [false],
      httpResponse: () => ({ statusCode: 200 }),
    });

    const startPromise = ctx.mod.startTon();
    await flushMicrotasks();

    expect(window.webContents.send).toHaveBeenCalledWith(
      IPC.TON_STATUS_UPDATE,
      expect.objectContaining({ status: 'starting' })
    );

    await jest.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();
    await startPromise;

    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toBe(ctx.tonBinPath);
    expect(ctx.spawnedProcesses[0].args).toContain('-addr');
    expect(ctx.spawnedProcesses[0].args).toContain('127.0.0.1:18085');
    expect(ctx.spawnedProcesses[0].args).toContain('-no-http');
    expect(ctx.spawnedProcesses[0].spawnOptions).toEqual({
      cwd: '/tmp/freedom-user-data/ton-data',
      stdio: 'ignore',
    });
    expect(ctx.httpRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: { Host: 'freedom-proxy-check.invalid' },
      }),
      expect.any(Function)
    );

    expect(ctx.updateService).toHaveBeenCalledWith(
      'ton',
      expect.objectContaining({ proxy: 'http://127.0.0.1:18085', mode: 'bundled' })
    );

    expect(window.webContents.send).toHaveBeenLastCalledWith(
      IPC.TON_STATUS_UPDATE,
      expect.objectContaining({ status: 'running' })
    );

    const stopPromise = ctx.mod.stopTon();
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await stopPromise;
  });

  test('walks to next port when default is busy', async () => {
    jest.useFakeTimers();

    const ctx = loadTonManagerModule({
      portSequence: [true, false],
      httpResponse: () => ({ statusCode: 200 }),
    });

    await ctx.mod.startTon();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();

    expect(ctx.log.info).toHaveBeenCalledWith(
      expect.stringContaining('Port 18085 is busy, trying next...')
    );
    expect(ctx.spawnedProcesses[0].args).toContain('127.0.0.1:18086');

    const stopPromise = ctx.mod.stopTon();
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await stopPromise;
  });

  test('transitions RUNNING → STOPPING → STOPPED on graceful stop', async () => {
    jest.useFakeTimers();

    const window = createWindowMock();
    const ctx = loadTonManagerModule({
      windows: [window],
      portSequence: [false],
      httpResponse: () => ({ statusCode: 200 }),
    });

    await ctx.mod.startTon();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();

    const stopPromise = ctx.mod.stopTon();
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await stopPromise;

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('ton');

    const statusCalls = window.webContents.send.mock.calls.map((c) => c[1].status);
    expect(statusCalls).toContain('stopping');
    expect(statusCalls[statusCalls.length - 1]).toBe('stopped');
  });

  test('registers independent handlers for normal and private sessions and never changes PAC', async () => {
    jest.useFakeTimers();
    const ctx = loadTonManagerModule();
    const privateSession = { setProxy: jest.fn() };
    ctx.mod.registerTonRoutingSession('default', ctx.requestSession);
    ctx.mod.registerTonRoutingSession('private', privateSession);
    expect(ctx.registerTonProtocol).toHaveBeenCalledTimes(2);
    await ctx.mod.startTon();
    await jest.advanceTimersByTimeAsync(3000);
    expect(
      ctx.mod.guardTonRequest({ url: 'https://foundation.ton/docs', webContentsId: 42 })
    ).toEqual({ redirectURL: 'tonsite://foundation.ton/docs' });
    expect(ctx.mod.guardTonRequest({ url: 'http://name.t.me/', webContentsId: 42 })).toBeNull();
    expect(privateSession.setProxy).not.toHaveBeenCalled();
    expect(ctx.mod.getProxyUrl()).toBe('http://127.0.0.1:18085');
    ctx.spawnedProcesses[0].emit('close', 1);
    expect(ctx.mod.getProxyUrl()).toBeNull();
    expect(ctx.mod.guardTonRequest({ url: 'http://foundation.ton/', webContentsId: 42 })).toEqual({
      cancel: true,
    });
  });

  test('disabling the integration closes routing immediately and stops the process', async () => {
    jest.useFakeTimers();
    const ctx = loadTonManagerModule();
    ctx.mod.registerTonIpc();
    ctx.mod.registerTonRoutingSession('default', ctx.requestSession);
    await ctx.mod.startTon();
    await jest.advanceTimersByTimeAsync(3000);
    ctx.settings.enableTonIntegration = false;
    ctx.onSettingsChanged.mock.calls[0][0](ctx.settings);
    expect(ctx.mod.getProxyUrl()).toBeNull();
    expect(ctx.spawnedProcesses[0].kill).toHaveBeenCalledWith('SIGTERM');
    await jest.advanceTimersByTimeAsync(0);
  });

  test('a profile disabled in Nodes cannot start or route TON traffic', async () => {
    const ctx = loadTonManagerModule({ profileMode: 'disabled' });
    await ctx.mod.syncProfileMode();
    await ctx.mod.startTon();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getProxyUrl()).toBeNull();
    expect(ctx.updateService).toHaveBeenCalledWith('ton', { proxy: null, mode: 'disabled' });
  });

  test('disabling a running profile stops it and re-enabling allows a later manual start', async () => {
    jest.useFakeTimers();
    const ctx = loadTonManagerModule();
    await ctx.mod.startTon();
    await jest.advanceTimersByTimeAsync(3000);
    ctx.activeProfile.metadata.nodes.ton.mode = 'disabled';
    const stopped = ctx.mod.syncProfileMode();
    expect(ctx.mod.getProxyUrl()).toBeNull();
    await jest.advanceTimersByTimeAsync(0);
    await stopped;
    expect(ctx.spawnedProcesses[0].kill).toHaveBeenCalledWith('SIGTERM');
    expect(ctx.updateService).toHaveBeenLastCalledWith('ton', { proxy: null, mode: 'disabled' });
    ctx.activeProfile.metadata.nodes.ton.mode = 'managed';
    await ctx.mod.syncProfileMode();
    await ctx.mod.startTon();
    expect(ctx.spawn).toHaveBeenCalledTimes(2);
  });

  test('disabled integration cannot spawn a proxy', async () => {
    const ctx = loadTonManagerModule({ enabled: false });
    await ctx.mod.startTon();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getProxyUrl()).toBeNull();
  });

  test('transitions STARTING → ERROR when spawn emits error', async () => {
    jest.useFakeTimers();

    const ctx = loadTonManagerModule({
      portSequence: [false],
      httpResponse: () => ({ error: new Error('network down') }),
      createProcess: (binary, opts) => {
        const proc = createProcessMock(binary, opts);
        proc.on = jest.fn((event, handler) => {
          if (!proc._listeners) proc._listeners = new Map();
          if (!proc._listeners.has(event)) proc._listeners.set(event, []);
          proc._listeners.get(event).push(handler);
          if (event === 'error') {
            setTimeout(() => handler(new Error('spawn ENOENT')), 10);
          }
        });
        proc.once = jest.fn((event, handler) => {
          if (!proc._onceListeners) proc._onceListeners = new Map();
          if (!proc._onceListeners.has(event)) proc._onceListeners.set(event, []);
          proc._onceListeners.get(event).push(handler);
        });
        proc.kill = jest.fn();
        return proc;
      },
    });

    await ctx.mod.startTon();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(50);
    await flushMicrotasks();

    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ton', 'Proxy failed to start');
  });

  test('broadcasts TON_STATUS_UPDATE on every state transition', async () => {
    jest.useFakeTimers();

    const window = createWindowMock();
    const ctx = loadTonManagerModule({
      windows: [window],
      portSequence: [false],
      httpResponse: () => ({ statusCode: 200 }),
    });

    await ctx.mod.startTon();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();

    const sentChannels = window.webContents.send.mock.calls.map((c) => c[0]);
    const tonUpdates = sentChannels.filter((ch) => ch === IPC.TON_STATUS_UPDATE);
    expect(tonUpdates.length).toBeGreaterThanOrEqual(2);

    const stopPromise = ctx.mod.stopTon();
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await stopPromise;
  });

  test('stopTon resolves immediately when already stopped', async () => {
    const ctx = loadTonManagerModule();

    await expect(ctx.mod.stopTon()).resolves.toBeUndefined();
    expect(ctx.clearService).toHaveBeenCalledWith('ton');
  });

  test('transitions to ERROR when all fallback ports are busy', async () => {
    const ctx = loadTonManagerModule({
      portSequence: Array(11).fill(true),
    });
    ctx.mod.registerTonIpc();

    await ctx.mod.startTon();
    await flushMicrotasks();

    const s = await ctx.ipcMain.invoke(IPC.TON_GET_STATUS);
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/No available ports/);
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ton', 'Proxy failed to start');
  });

  test('transitions to ERROR when startup times out after 60 attempts', async () => {
    jest.useFakeTimers();

    const window = createWindowMock();
    const syncErrorHttpRequest = jest.fn((_options, _callback) => {
      const requestHandlers = new Map();
      const request = {
        on: jest.fn((event, fn) => {
          requestHandlers.set(event, fn);
          return request;
        }),
        destroy: jest.fn(),
        end: jest.fn(() => {
          requestHandlers.get('error')?.(new Error('ECONNREFUSED'));
        }),
      };
      return request;
    });

    const ctx = loadTonManagerModule({
      windows: [window],
      portSequence: [false],
      httpRequest: syncErrorHttpRequest,
    });
    ctx.mod.registerTonIpc();

    ctx.mod.startTon();
    await flushMicrotasks();

    for (let i = 0; i < 60; i++) {
      await jest.advanceTimersByTimeAsync(3000);
      await flushMicrotasks();
    }

    const s = await ctx.ipcMain.invoke(IPC.TON_GET_STATUS);
    expect(s.status).toBe('error');
    expect(s.error).toMatch(/Startup timed out/);
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ton', 'Proxy failed to start');
  });

  test('escalates to SIGKILL when SIGTERM does not close process within 5 s', async () => {
    jest.useFakeTimers();

    const ctx = loadTonManagerModule({
      portSequence: [false],
      httpResponse: () => ({ statusCode: 200 }),
      processOptions: { autoCloseOnKill: false },
    });

    await ctx.mod.startTon();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(3000);
    await flushMicrotasks();

    ctx.mod.stopTon();
    await flushMicrotasks();

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');

    await jest.advanceTimersByTimeAsync(5000);
    await flushMicrotasks();

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGKILL');
  });
});
