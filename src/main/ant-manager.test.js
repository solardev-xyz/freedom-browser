const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_USER_DATA_DIR = '/tmp/freedom-user-data';

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
        if (!stdoutListeners.has(event)) {
          stdoutListeners.set(event, []);
        }
        stdoutListeners.get(event).push(handler);
      }),
    },
    stderr: {
      on: jest.fn((event, handler) => {
        if (!stderrListeners.has(event)) {
          stderrListeners.set(event, []);
        }
        stderrListeners.get(event).push(handler);
      }),
    },
    on: jest.fn((event, handler) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceListeners.has(event)) {
        onceListeners.set(event, []);
      }
      onceListeners.get(event).push(handler);
    }),
    emit(event, ...args) {
      emitAll(listeners, event, args);
      const oneTimeHandlers = onceListeners.get(event) || [];
      onceListeners.delete(event);
      oneTimeHandlers.forEach((handler) => handler(...args));
    },
    kill: jest.fn((signal) => {
      proc.kills.push(signal);
      if (options.autoCloseOnKill !== false) {
        setTimeout(() => {
          proc.emit('close', options.closeCode ?? 0);
        }, 0);
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

    connect(port, host) {
      const result =
        typeof portResolver === 'function'
          ? portResolver(port, host)
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

function createHttpGetMock(responseResolver) {
  const resolveResponse = responseResolver || (() => ({ statusCode: 500, body: '' }));

  return jest.fn((url, options, callback) => {
    let handler = callback;
    if (typeof options === 'function') {
      handler = options;
    }

    const requestHandlers = new Map();
    const request = {
      on: jest.fn((event, fn) => {
        requestHandlers.set(event, fn);
        return request;
      }),
      destroy: jest.fn(),
      end: jest.fn(),
    };

    const responseConfig = resolveResponse(url);

    if (responseConfig?.error) {
      requestHandlers.get('error')?.(responseConfig.error);
      return request;
    }

    if (responseConfig?.timeout) {
      requestHandlers.get('timeout')?.();
      return request;
    }

    const responseHandlers = new Map();
    const response = {
      statusCode: responseConfig?.statusCode ?? 200,
      resume: jest.fn(),
      on: jest.fn((event, fn) => {
        if (!responseHandlers.has(event)) {
          responseHandlers.set(event, []);
        }
        responseHandlers.get(event).push(fn);
      }),
    };

    handler(response);

    const chunks = (() => {
      if (responseConfig?.body === undefined || responseConfig?.body === null) {
        return [];
      }
      if (typeof responseConfig.body === 'string') {
        return [responseConfig.body];
      }
      return [JSON.stringify(responseConfig.body)];
    })();

    chunks.forEach((chunk) => {
      for (const fn of responseHandlers.get('data') || []) {
        fn(chunk);
      }
    });
    for (const fn of responseHandlers.get('end') || []) {
      fn();
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

function loadAntManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = options.app || createAppMock({
    isPackaged: options.isPackaged ?? false,
    userDataDir: options.userDataDir || DEFAULT_USER_DATA_DIR,
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
  const updateActiveProfileNodeConfig = options.updateActiveProfileNodeConfig || jest.fn();
  const spawnedProcesses = [];
  const bridge = { url: 'http://127.0.0.1:43210/ant-chain/test-capability',
    close: jest.fn().mockResolvedValue(), pipeLog: jest.fn() };
  const startBridge = options.startBridge || jest.fn().mockResolvedValue(bridge);
  const execSync = options.execSync || jest.fn();
  const spawn = jest.fn((binary, args = [], spawnOptions = {}) => {
    const proc = (options.createProcess || createProcessMock)(binary, options.processOptions || {});
    proc.args = args;
    proc.spawnOptions = spawnOptions;
    spawnedProcesses.push(proc);
    return proc;
  });
  const gnosisRpcUrls = options.rpcUrls || ['https://rpc.gnosischain.com'];
  const ethereumRpcUrls = options.ethereumRpcUrls || ['https://ethereum.publicnode.com'];
  const registry = options.registry || {
    getEndpointSources: jest.fn((chainId) => {
      const urls = Number(chainId) === 1 ? ethereumRpcUrls : gnosisRpcUrls;
      return options.endpointSources || urls.map((url, index) => ({
        id: `${Number(chainId) === 1 ? 'eth' : 'gno'}-test-${index + 1}`,
        role: 'rpc',
        keyed: false,
        coverage: { [chainId]: url },
      }));
    }),
    getEndpoints: jest.fn((chainId) => (Number(chainId) === 1 ? ethereumRpcUrls : gnosisRpcUrls)),
  };

  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binaryName = process.platform === 'win32' ? 'antd.exe' : 'antd';
  const antBinPath = path.join(PROJECT_ROOT, 'ant-bin', `${platform}-${process.arch}`, binaryName);
  const dataDir = path.join(options.userDataDir || DEFAULT_USER_DATA_DIR, 'ant-data');
  const configPath = path.join(dataDir, 'config.yaml');
  const keysPath = path.join(dataDir, 'keys');

  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') {
        return options.existsSync(target);
      }

      if (target === antBinPath) return options.binExists !== false;
      if (target === dataDir) return options.dataDirExists === true;
      if (target === configPath) return options.configExists === true;
      if (target === keysPath) return options.keysExist === true;
      return false;
    }),
    mkdirSync: jest.fn(),
    readFileSync: jest.fn(() => options.configContents || ''),
    writeFileSync: jest.fn(),
  };
  const httpGet = createHttpGetMock(options.httpResponse);
  const noteAntApiUrl = jest.fn();
  const Socket = createSocketClass(options.portSequence || options.portResolver || false);
  const randomBytes = options.randomBytes || jest.fn(() => Buffer.from('ab'.repeat(32), 'hex'));

  const { mod } = loadMainModule(require.resolve('./ant-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      [require.resolve('./swarm/ant-chain-bridge')]: () => ({ startAntChainBridge: startBridge }),
      child_process: () => ({
        spawn,
        execSync,
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings: jest.fn(() => options.settings || {}),
      }),
      crypto: () => ({
        randomBytes,
      }),
      fs: () => fsMock,
      http: () => ({
        get: httpGet,
      }),
      net: () => ({
        Socket,
      }),
      [require.resolve('./logger')]: () => log,
      [require.resolve('./swarm/ant-api-guard')]: () => ({ noteAntApiUrl }),
      [require.resolve('./migrate-user-data')]: () => ({
        isBeeDataMigrationPending: options.isBeeDataMigrationPending || jest.fn(() => false),
      }),
      [require.resolve('./networks/network-registry')]: () => registry,
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => options.activeProfile || null),
        getReservedProfilePorts: jest.fn(() => new Set(options.reservedPorts || [])),
        updateActiveProfileNodeConfig,
        updateActiveProfileNodeConfigWhenIdle: jest.fn(async (...args) =>
          updateActiveProfileNodeConfig(...args)),
      }),
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          BUNDLED: 'bundled',
          REUSED: 'reused',
          EXTERNAL: 'external',
          DISABLED: 'disabled',
          NONE: 'none',
        },
        DEFAULTS: {
          ant: {
            apiPort: 1633,
            p2pPort: 1634,
            fallbackRange: 10,
          },
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
    antBinPath,
    bridge,
    startBridge,
    BrowserWindow,
    clearErrorState,
    clearService,
    configPath,
    dataDir,
    execSync,
    fsMock,
    registry,
    httpGet,
    ipcMain,
    keysPath,
    log,
    mod,
    noteAntApiUrl,
    randomBytes,
    setErrorState,
    setStatusMessage,
    spawn,
    spawnedProcesses,
    updateService,
    updateActiveProfileNodeConfig,
    windows,
  };
}

describe('ant-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports binary availability plus initial status', async () => {
    const ctx = loadAntManagerModule({
      binExists: false,
    });

    ctx.mod.registerAntIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual(
      [IPC.ANT_START, IPC.ANT_STOP, IPC.ANT_GET_STATUS, IPC.ANT_CHECK_BINARY, IPC.ANT_API_GET].sort()
    );

    await expect(ctx.ipcMain.invoke(IPC.ANT_GET_STATUS)).resolves.toEqual({
      status: 'stopped',
      error: null,
    });
    await expect(ctx.ipcMain.invoke(IPC.ANT_CHECK_BINARY)).resolves.toEqual({
      available: false,
    });
  });

  test('refuses to spawn the bundled node while the bee-data migration is pending', async () => {
    const isBeeDataMigrationPending = jest.fn(() => true);
    const ctx = loadAntManagerModule({
      isBeeDataMigrationPending,
      portSequence: [false],
    });

    await ctx.mod.startAnt();

    expect(isBeeDataMigrationPending).toHaveBeenCalled();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.mod.getStatus()).toEqual({
      status: 'error',
      error: expect.stringContaining('identity migration has not completed'),
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith(
      'ant',
      'Node start deferred (identity migration pending)'
    );
  });

  test('defers the bundled node start in injected-identity mode until a key is injected', async () => {
    const ctx = loadAntManagerModule({
      portSequence: [false],
    });

    ctx.mod.setUseInjectedIdentity(true);
    await ctx.mod.startAnt();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(ctx.mod.getStatus()).toEqual({
      status: 'error',
      error: expect.stringContaining('no node key injected'),
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith(
      'ant',
      'Node start deferred (waiting for identity injection)'
    );
  });

  test('starts the bundled node in injected-identity mode once keys/swarm.key exists', async () => {
    jest.useFakeTimers();

    // Injection always writes keys/swarm.key and config.yaml (with the
    // keystore password) together, so the realistic injected state has both;
    // a keystore without a readable password is the loud-failure case tested
    // separately below.
    const dataDir = path.join(DEFAULT_USER_DATA_DIR, 'ant-data');
    const swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');
    const configPath = path.join(dataDir, 'config.yaml');
    const platformMap = {
      darwin: 'mac',
      linux: 'linux',
      win32: 'win',
    };
    const platform = platformMap[process.platform] || process.platform;
    const binaryName = process.platform === 'win32' ? 'antd.exe' : 'antd';
    const antBinPath = path.join(PROJECT_ROOT, 'ant-bin', `${platform}-${process.arch}`, binaryName);
    const ctx = loadAntManagerModule({
      existsSync: (target) =>
        target === antBinPath || target === swarmKeyPath || target === configPath,
      configContents: 'api-addr: 127.0.0.1:1633\npassword: injected-keystore-password\n',
      portSequence: [false],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:1633/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return { statusCode: 500, body: '' };
      },
    });

    ctx.mod.setUseInjectedIdentity(true);
    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toBe(ctx.antBinPath);
    expect(ctx.mod.getStatus()).toEqual({ status: 'running', error: null });

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await stopPromise;
    expect(jest.getTimerCount()).toBe(0);
  });

  test('reuses an existing daemon and clears the health-check interval on stop', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(123);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const window = createWindowMock();
    const ctx = loadAntManagerModule({
      windows: [window],
      portSequence: [true],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:1633/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }

        return { statusCode: 500, body: '' };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(1633);
    expect(ctx.updateService).toHaveBeenCalledWith('ant', {
      api: 'http://127.0.0.1:1633',
      gateway: 'http://127.0.0.1:1633',
      mode: 'reused',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ant', 'Node: localhost:1633');
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.ANT_STATUS_UPDATE, {
      status: 'starting',
      error: null,
    });
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.ANT_STATUS_UPDATE, {
      status: 'running',
      error: null,
    });

    await ctx.mod.stopAnt();

    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
    expect(ctx.clearService).toHaveBeenCalledWith('ant');
  });

  test('starts a managed profile daemon on the profile port without reusing defaults', async () => {
    jest.useFakeTimers();
    const checkedPorts = [];
    const ctx = loadAntManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            bee: { mode: 'managed', apiPort: 11633, p2pPort: 12633 },
          },
        },
      },
      portResolver: (port) => {
        checkedPorts.push(port);
        return false;
      },
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:11633/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(checkedPorts).toContain(11633);
    expect(checkedPorts).toContain(12633);
    expect(checkedPorts).not.toContain(1633);
    expect(checkedPorts).not.toContain(1634);
    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.mod.getActivePort()).toBe(11633);
    expect(ctx.updateService).toHaveBeenCalledWith('ant', {
      api: 'http://127.0.0.1:11633',
      gateway: 'http://127.0.0.1:11633',
      mode: 'bundled',
    });

    const configContent = ctx.fsMock.writeFileSync.mock.calls[0][1];
    expect(configContent).toContain('api-addr: 127.0.0.1:11633');
    expect(configContent).toContain('p2p-addr: :12633');
    // No browser origin may read the node's API — not even `null` (the
    // chrome's `file:` origin, shared with every data:/sandboxed frame).
    // The chrome reads it over IPC instead (security audit O-1, #428).
    expect(configContent).not.toMatch(/cors-allowed-origins/);
    // The web-content guard learns the port before the node is healthy
    // (the registry only learns it after), so it is never live unguarded.
    expect(ctx.noteAntApiUrl).toHaveBeenCalledWith('http://127.0.0.1:11633');
    expect(ctx.noteAntApiUrl.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.spawn.mock.invocationCallOrder[0]
    );

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
  });

  test('persists a reassigned managed profile port before launching Bee', async () => {
    jest.useFakeTimers();
    const ctx = loadAntManagerModule({
      activeProfile: {
        source: 'catalog',
        metadata: {
          nodes: {
            bee: { mode: 'managed', apiPort: 11633, p2pPort: 12633 },
          },
        },
      },
      portResolver: (port) => port === 11633,
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:11634/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('bee', {
      apiPort: 11634,
      p2pPort: 12633,
    });
    expect(ctx.mod.getActivePort()).toBe(11634);
    expect(ctx.updateService).toHaveBeenCalledWith('ant', {
      api: 'http://127.0.0.1:11634',
      gateway: 'http://127.0.0.1:11634',
      mode: 'bundled',
    });

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
  });

  test('skips reserved sibling profile ports when reassigning Ant ports', async () => {
    jest.useFakeTimers();
    const ctx = loadAntManagerModule({
      activeProfile: {
        source: 'catalog',
        metadata: {
          nodes: {
            bee: { mode: 'managed', apiPort: 11633, p2pPort: 12633 },
          },
        },
      },
      reservedPorts: [11634],
      portResolver: (port) => port === 11633,
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:11635/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('bee', {
      apiPort: 11635,
      p2pPort: 12633,
    });
    expect(ctx.mod.getActivePort()).toBe(11635);

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
  });

  test('connects to a configured external profile API without probing default ports', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(456);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const checkedPorts = [];
    const ctx = loadAntManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            bee: {
              mode: 'external',
              externalApi: ' http://127.0.0.1:22633/ ',
            },
          },
        },
      },
      portResolver: (port) => {
        checkedPorts.push(port);
        return true;
      },
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:22633/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(checkedPorts).toEqual([]);
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(22633);
    expect(ctx.updateService).toHaveBeenCalledWith('ant', {
      api: 'http://127.0.0.1:22633',
      gateway: 'http://127.0.0.1:22633',
      mode: 'external',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ant', 'External node: 127.0.0.1:22633');
    expect(setIntervalSpy).toHaveBeenCalled();

    await ctx.mod.stopAnt();

    expect(clearIntervalSpy).toHaveBeenCalledWith(456);
    expect(ctx.clearService).toHaveBeenCalledWith('ant');
  });

  test('marks a disabled profile Swarm node without probing or spawning', async () => {
    const checkedPorts = [];
    const ctx = loadAntManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            bee: { mode: 'disabled' },
          },
        },
      },
      portResolver: (port) => {
        checkedPorts.push(port);
        return true;
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(checkedPorts).toEqual([]);
    expect(ctx.httpGet).not.toHaveBeenCalled();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBeNull();
    expect(ctx.updateService).toHaveBeenCalledWith('ant', {
      api: null,
      gateway: null,
      mode: 'disabled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ant', 'Node disabled for this profile');
  });

  test('starts the bundled daemon on a fallback port with its write-capable chain transport', async () => {
    jest.useFakeTimers();

    const platformMap = {
      darwin: 'mac',
      linux: 'linux',
      win32: 'win',
    };
    const platform = platformMap[process.platform] || process.platform;
    const binaryName = process.platform === 'win32' ? 'antd.exe' : 'antd';
    const antBinPath = path.join(PROJECT_ROOT, 'ant-bin', `${platform}-${process.arch}`, binaryName);
    const dataDir = path.join(DEFAULT_USER_DATA_DIR, 'ant-data');
    const configPath = path.join(dataDir, 'config.yaml');
    const keysPath = path.join(dataDir, 'keys');
    const ctx = loadAntManagerModule({
      existsSync: (target) => {
        if (target === antBinPath) return true;
        if (target === dataDir) return false;
        if (target === configPath) return false;
        if (target === keysPath) return false;
        return false;
      },
      portSequence: [true, false],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:1633/health') {
          return {
            statusCode: 500,
            body: '',
          };
        }
        if (url === 'http://127.0.0.1:1634/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(ctx.fsMock.mkdirSync).toHaveBeenCalledWith(ctx.dataDir, { recursive: true });
    expect(ctx.randomBytes).toHaveBeenCalledWith(32);
    // antd self-initializes its identity; Freedom no longer runs an init step.
    expect(ctx.execSync).not.toHaveBeenCalled();
    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toBe(ctx.antBinPath);
    // One mode: the node can always publish, so it always gets the bridge
    // as its write RPC, and the bridge always forwards its transactions.
    expect(ctx.startBridge).toHaveBeenCalledWith({ allowBroadcast: true });
    expect(ctx.spawnedProcesses[0].args).toEqual([
      `--config=${ctx.configPath}`,
      '--no-control-socket',
      `--gnosis-logs-rpc-url=${ctx.bridge.url}`,
      `--gnosis-rpc-url=${ctx.bridge.url}`,
    ]);
    expect(ctx.mod.getActivePort()).toBe(1634);
    expect(ctx.updateService).toHaveBeenCalledWith('ant', {
      api: 'http://127.0.0.1:1634',
      gateway: 'http://127.0.0.1:1634',
      mode: 'bundled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ant', 'Fallback Port: 1634');

    const configContent = ctx.fsMock.writeFileSync.mock.calls[0][1];
    expect(configContent).toContain('api-addr: 127.0.0.1:1634');
    expect(configContent).toContain('p2p-addr: :1634');
    // swap-enable follows the antSwapEnable setting, on by default as in
    // bee (#488); the chain RPC reaches the node only as the bridge flag,
    // never as a URL on disk.
    expect(configContent).toMatch(/^swap-enable: true$/m);
    expect(configContent).not.toContain('blockchain-rpc-endpoint');
    expect(configContent).toContain('resolver-options: "https://ethereum.publicnode.com"');
    expect(configContent).toContain(`data-dir: ${ctx.dataDir}`);
    expect(configContent).toContain(`password: ${'ab'.repeat(32)}`);

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    await stopPromise;

    expect(ctx.bridge.close).toHaveBeenCalled();
    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('ant');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('keeps every RPC URL out of the config and resolves ENS over a keyless Ethereum RPC', async () => {
    jest.useFakeTimers();

    const ctx = loadAntManagerModule({
      rpcUrls: ['https://rpc.gnosischain.com', 'https://backup.gnosis.example'],
      ethereumRpcUrls: ['https://eth.user.example', 'https://ethereum.publicnode.com'],
      portSequence: [false],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:1633/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const configContent = ctx.fsMock.writeFileSync.mock.calls[0][1];
    expect(ctx.startBridge).toHaveBeenCalledWith({ allowBroadcast: true });
    expect(ctx.spawnedProcesses[0].args).toContain(`--gnosis-rpc-url=${ctx.bridge.url}`);
    expect(configContent).not.toContain(ctx.bridge.url);
    expect(configContent).not.toContain('rpc.gnosischain.com');
    expect(configContent).toContain('resolver-options: "https://eth.user.example"');

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
  });

  test('prefers a keyless Ethereum RPC for ENS resolution over keyed commercial providers', () => {
    const ctx = loadAntManagerModule({
      registry: {
        getEndpointSources: jest.fn(() => [
          {
            id: 'alchemy',
            role: 'rpc',
            keyed: true,
            coverage: { 1: 'https://eth-mainnet.g.alchemy.com/v2/{API_KEY}' },
          },
          {
            id: 'eth-publicnode',
            role: 'rpc',
            keyed: false,
            coverage: { 1: 'https://ethereum.publicnode.com' },
          },
        ]),
        getEndpoints: jest.fn(() => [
          'https://eth-mainnet.g.alchemy.com/v2/redacted',
          'https://ethereum.publicnode.com',
        ]),
      },
    });

    expect(ctx.mod.getPrimaryEthereumRpcUrl()).toBe('https://ethereum.publicnode.com');
    expect(ctx.registry.getEndpointSources).toHaveBeenCalledWith(1, 'rpc');
    expect(ctx.registry.getEndpoints).not.toHaveBeenCalled();
  });

  test('tells main-process listeners about every status change', async () => {
    const ctx = loadAntManagerModule({ binExists: false });
    const listener = jest.fn();
    const unsubscribe = ctx.mod.onStatusChange(listener);

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(listener.mock.calls.map(([update]) => update.status)).toEqual(['starting', 'error']);
    expect(listener).toHaveBeenLastCalledWith({
      status: 'error',
      error: expect.stringContaining('Ant binary not found'),
    });

    unsubscribe();
    listener.mockClear();
    await ctx.mod.stopAnt();
    expect(listener).not.toHaveBeenCalled();
  });

  test('preserves an existing Bee password when rewriting config', async () => {
    jest.useFakeTimers();

    const ctx = loadAntManagerModule({
      configExists: true,
      keysExist: true,
      configContents: 'api-addr: 127.0.0.1:1633\npassword: keep-me\n',
      portSequence: [false],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:1633/health') {
          return {
            statusCode: 200,
            body: { version: '2.1.0' },
          };
        }
        return {
          statusCode: 500,
          body: '',
        };
      },
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const configContent = ctx.fsMock.writeFileSync.mock.calls[0][1];
    expect(configContent).toContain('password: keep-me');
    expect(ctx.execSync).not.toHaveBeenCalled();

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
  });

  // A keystore whose config password can't be recovered must fail the start
  // loudly: silently minting a fresh password would leave keys/swarm.key
  // (e.g. a migrated bee-era identity) permanently undecryptable.
  test('refuses to mint a new password while a keystore exists with an unreadable config password', async () => {
    const platformMap = {
      darwin: 'mac',
      linux: 'linux',
      win32: 'win',
    };
    const platform = platformMap[process.platform] || process.platform;
    const binaryName = process.platform === 'win32' ? 'antd.exe' : 'antd';
    const antBinPath = path.join(PROJECT_ROOT, 'ant-bin', `${platform}-${process.arch}`, binaryName);
    const dataDir = path.join(DEFAULT_USER_DATA_DIR, 'ant-data');
    const configPath = path.join(dataDir, 'config.yaml');
    const swarmKeyPath = path.join(dataDir, 'keys', 'swarm.key');

    const ctx = loadAntManagerModule({
      configContents: 'api-addr: 127.0.0.1:1633\n',
      existsSync: (target) =>
        target === antBinPath ||
        target === dataDir ||
        target === configPath ||
        target === swarmKeyPath,
      portSequence: [false],
      httpResponse: () => ({
        statusCode: 500,
        body: '',
      }),
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.fsMock.writeFileSync).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ant', 'Node failed to start');
    expect(ctx.log.error).toHaveBeenCalledWith(
      '[Ant] Failed to prepare config:',
      expect.stringContaining('refusing to generate a new password')
    );
  });

  // Browsing must not depend on a Gnosis RPC: without one the bridge still
  // starts (its chain reads fail), and the setup screen reports a node that
  // cannot reach Gnosis Chain rather than a node that will not start.
  test('starts without a configured Gnosis RPC', async () => {
    jest.useFakeTimers();

    const ctx = loadAntManagerModule({
      rpcUrls: [],
      portSequence: [false],
      httpResponse: () => ({
        statusCode: 500,
        body: '',
      }),
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(ctx.startBridge).toHaveBeenCalledWith({ allowBroadcast: true });
    expect(ctx.spawn).toHaveBeenCalledTimes(1);
    expect(ctx.log.error).not.toHaveBeenCalledWith(
      '[Ant] Failed to prepare config:',
      expect.anything()
    );

    const stopPromise = ctx.mod.stopAnt();
    await jest.advanceTimersByTimeAsync(0);
    await stopPromise;
  });

  test('fails startup when the Bee binary is missing', async () => {
    const ctx = loadAntManagerModule({
      binExists: false,
      portSequence: [false],
      httpResponse: () => ({
        statusCode: 500,
        body: '',
      }),
    });

    await ctx.mod.startAnt();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.startBridge).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('ant', 'Node failed to start');
  });

  // #488: bee's swap-enable, written from the antSwapEnable setting.
  describe('swap-enable', () => {
    test('writes swap-enable: false when the user switched paying peers off', () => {
      const ctx = loadAntManagerModule({ settings: { antSwapEnable: false } });
      const content = ctx.mod.buildAntConfigContent({
        dataDir: '/d',
        apiPort: 1633,
        p2pPort: 1634,
        password: 'pw',
        resolverRpcEndpoint: 'https://eth.example',
        swapEnable: false,
      });
      expect(content).toMatch(/^swap-enable: false$/m);
      expect(content).not.toMatch(/^swap-enable: true$/m);
    });

    test('startAnt writes the setting into config.yaml', async () => {
      const ctx = loadAntManagerModule({
        settings: { antSwapEnable: false },
        portSequence: [false, false],
        httpResponse: () => ({ statusCode: 200, body: { status: 'ok', version: '0.5.55' } }),
      });
      await ctx.mod.startAnt();
      await flushMicrotasks();
      const config = ctx.fsMock.writeFileSync.mock.calls.find(([file]) => file === ctx.configPath);
      expect(config[1]).toMatch(/^swap-enable: false$/m);
      await ctx.mod.stopAnt();
    });

    // Whether the running antd has the switch is read from the node itself
    // (`GET /node`'s `settlement`, browsing-credit-service.js), not from
    // `antd --help`: ant-manager only says whether Freedom runs the node.
    test('a bundled node is managed; an external or disabled profile node is not', () => {
      expect(loadAntManagerModule().mod.isManagedAntNode()).toBe(true);
      for (const mode of ['external', 'disabled']) {
        const ctx = loadAntManagerModule({
          activeProfile: { metadata: { nodes: { bee: { mode, url: 'http://127.0.0.1:1633' } } } },
        });
        expect(ctx.mod.isManagedAntNode()).toBe(false);
      }
    });
  });

  // Regression guard for issue #90: identity injection must stop a Bee node that
  // already holds the statestore LevelDB lock before the directory is wiped. A
  // node that is STARTING (spawned, lock held, health not yet passing) must be
  // treated as active too, otherwise the wipe hits EPERM on Windows.
  describe('createAntLifecycle (issue #90 startup race)', () => {
    // Without a live process, every state that may still hold the statestore
    // lock must stop (RUNNING/STARTING/STOPPING/ERROR); only a truly idle
    // STOPPED node is skipped.
    test.each([
      ['running', true],
      ['starting', true],
      ['stopping', true],
      ['error', true],
      ['stopped', false],
    ])('stop() with status %s (no live process) stops the node: %s', async (status, expectedActive) => {
      const ctx = loadAntManagerModule({ binExists: false });
      const stopAnt = jest.fn().mockResolvedValue(undefined);
      const lifecycle = ctx.mod.createAntLifecycle({
        getStatus: () => ({ status, error: null }),
        hasLiveProcess: () => false,
        stopAnt,
        startAnt: jest.fn(),
        setUseInjectedIdentity: jest.fn(),
      });

      const wasActive = await lifecycle.stop();

      expect(wasActive).toBe(expectedActive);
      expect(stopAnt).toHaveBeenCalledTimes(expectedActive ? 1 : 0);
    });

    // A live managed process holds the lock regardless of reported status, so a
    // STOPPED status with a process still alive must be stopped before a wipe.
    test('stop() stops when a live process exists even if status is STOPPED', async () => {
      const ctx = loadAntManagerModule({ binExists: false });
      const stopAnt = jest.fn().mockResolvedValue(undefined);
      const lifecycle = ctx.mod.createAntLifecycle({
        getStatus: () => ({ status: 'stopped', error: null }),
        hasLiveProcess: () => true,
        stopAnt,
        startAnt: jest.fn(),
        setUseInjectedIdentity: jest.fn(),
      });

      const wasActive = await lifecycle.stop();

      expect(wasActive).toBe(true);
      expect(stopAnt).toHaveBeenCalledTimes(1);
    });

    test('start() flags injected identity then starts the node', async () => {
      const ctx = loadAntManagerModule({ binExists: false });
      const calls = [];
      const lifecycle = ctx.mod.createAntLifecycle({
        getStatus: () => ({ status: 'stopped', error: null }),
        stopAnt: jest.fn(),
        startAnt: jest.fn(() => calls.push('start')),
        setUseInjectedIdentity: jest.fn(() => calls.push('flag')),
      });

      await lifecycle.start();

      expect(calls).toEqual(['flag', 'start']);
    });

    test('stops a real spawned-but-not-yet-running (STARTING) node', async () => {
      jest.useFakeTimers();

      const ctx = loadAntManagerModule({
        portSequence: [false],
        // Health never passes, so the node stays in STARTING with its process
        // (and statestore lock) alive — the exact startup-race window.
        httpResponse: () => ({ statusCode: 500, body: '' }),
      });

      await ctx.mod.startAnt();
      await flushMicrotasks();

      expect(ctx.mod.getStatus().status).toBe('starting');
      expect(ctx.spawnedProcesses).toHaveLength(1);

      const lifecycle = ctx.mod.createAntLifecycle();
      const stopPromise = lifecycle.stop();
      await jest.advanceTimersByTimeAsync(0);
      await flushMicrotasks();
      const wasActive = await stopPromise;

      expect(wasActive).toBe(true);
      expect(ctx.bridge.close).toHaveBeenCalled();
      expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
      expect(ctx.mod.getStatus().status).toBe('stopped');
    });
  });
});


describe('Ant private chain transport lifecycle', () => {
  afterEach(() => { jest.useRealTimers(); });

  test('a bridge bind failure fails startup without spawning an RPC-only daemon', async () => {
    const ctx = loadAntManagerModule({
      startBridge: jest.fn().mockRejectedValue(new Error('bind failed')),
    });
    await ctx.mod.startAnt();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getStatus().status).toBe('error');
  });

  test('stop during bridge startup closes the late bridge without spawning', async () => {
    let ready, entered;
    const began = new Promise((resolve) => { entered = resolve; });
    const startBridge = jest.fn(() => {
      entered();
      return new Promise((resolve) => { ready = resolve; });
    });
    const ctx = loadAntManagerModule({ startBridge });
    const starting = ctx.mod.startAnt();
    await began;
    await ctx.mod.stopAnt();
    ready(ctx.bridge);
    await starting;
    expect(ctx.bridge.close).toHaveBeenCalled();
    expect(ctx.spawn).not.toHaveBeenCalled();
  });

  test('unexpected exit and spawn error revoke their bridge; URLs stay out of logs', async () => {
    jest.useFakeTimers();
    const ctx = loadAntManagerModule();
    await ctx.mod.startAnt();
    const child = ctx.spawnedProcesses[0];
    child.emit('error', new Error('could not spawn'));
    expect(ctx.bridge.close).toHaveBeenCalled();
    child.emit('close', 1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(ctx.log.info.mock.calls)).not.toContain(ctx.bridge.url);
    expect(ctx.mod.getStatus().status).toBe('stopped');
  });
});
