const path = require('path');
const IPC = require('../shared/ipc-channels');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEV_BEE_DATA_DIR = path.join(PROJECT_ROOT, 'bee-data');

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
        proc.emit('close', options.closeCode ?? 0);
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
      const result = typeof portResolver === 'function'
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

function loadBeeManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app = options.app || createAppMock({
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
  const spawnedProcesses = [];
  const execSync = options.execSync || jest.fn();
  const spawn = jest.fn((binary, args = [], spawnOptions = {}) => {
    const proc = (options.createProcess || createProcessMock)(binary, options.processOptions || {});
    proc.args = args;
    proc.spawnOptions = spawnOptions;
    spawnedProcesses.push(proc);
    return proc;
  });

  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const binaryName = process.platform === 'win32' ? 'bee.exe' : 'bee';
  const beeBinPath = path.join(PROJECT_ROOT, 'bee-bin', `${platform}-${process.arch}`, binaryName);
  const dataDir = options.isPackaged
    ? path.join(options.userDataDir || '/tmp/freedom-user-data', 'bee-data')
    : DEV_BEE_DATA_DIR;
  const configPath = path.join(dataDir, 'config.yaml');
  const keysPath = path.join(dataDir, 'keys');

  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') {
        return options.existsSync(target);
      }

      if (target === beeBinPath) return options.binExists !== false;
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
  const Socket = createSocketClass(options.portSequence || options.portResolver || false);
  const randomBytes = options.randomBytes || jest.fn(() => Buffer.from('ab'.repeat(32), 'hex'));

  const { mod } = loadMainModule(require.resolve('./bee-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      child_process: () => ({
        spawn,
        execSync,
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
      [require.resolve('./service-registry')]: () => ({
        MODE: {
          BUNDLED: 'bundled',
          REUSED: 'reused',
          NONE: 'none',
        },
        DEFAULTS: {
          bee: {
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
    beeBinPath,
    BrowserWindow,
    clearErrorState,
    clearService,
    configPath,
    dataDir,
    execSync,
    fsMock,
    httpGet,
    ipcMain,
    keysPath,
    log,
    mod,
    randomBytes,
    setErrorState,
    setStatusMessage,
    spawn,
    spawnedProcesses,
    updateService,
    windows,
  };
}

describe('bee-manager', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('registers IPC handlers and reports binary availability plus initial status', async () => {
    const ctx = loadBeeManagerModule({
      binExists: false,
    });

    ctx.mod.registerBeeIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual([
      IPC.BEE_START,
      IPC.BEE_STOP,
      IPC.BEE_GET_STATUS,
      IPC.BEE_CHECK_BINARY,
    ].sort());

    await expect(ctx.ipcMain.invoke(IPC.BEE_GET_STATUS)).resolves.toEqual({
      status: 'stopped',
      error: null,
    });
    await expect(ctx.ipcMain.invoke(IPC.BEE_CHECK_BINARY)).resolves.toEqual({
      available: false,
    });
  });

  test('reuses an existing daemon and clears the health-check interval on stop', async () => {
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(123);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const window = createWindowMock();
    const ctx = loadBeeManagerModule({
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

    await ctx.mod.startBee();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(1633);
    expect(ctx.updateService).toHaveBeenCalledWith('bee', {
      api: 'http://127.0.0.1:1633',
      gateway: 'http://127.0.0.1:1633',
      mode: 'reused',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('bee', 'Node: localhost:1633');
    expect(setIntervalSpy).toHaveBeenCalled();
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.BEE_STATUS_UPDATE, {
      status: 'starting',
      error: null,
    });
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.BEE_STATUS_UPDATE, {
      status: 'running',
      error: null,
    });

    await ctx.mod.stopBee();

    expect(clearIntervalSpy).toHaveBeenCalledWith(123);
    expect(ctx.clearService).toHaveBeenCalledWith('bee');
  });

  test('starts a bundled daemon on a fallback port, writes config, and leaves no shutdown timers behind', async () => {
    jest.useFakeTimers();

    const platformMap = {
      darwin: 'mac',
      linux: 'linux',
      win32: 'win',
    };
    const platform = platformMap[process.platform] || process.platform;
    const binaryName = process.platform === 'win32' ? 'bee.exe' : 'bee';
    const beeBinPath = path.join(PROJECT_ROOT, 'bee-bin', `${platform}-${process.arch}`, binaryName);
    const dataDir = DEV_BEE_DATA_DIR;
    const configPath = path.join(dataDir, 'config.yaml');
    const keysPath = path.join(dataDir, 'keys');
    const ctx = loadBeeManagerModule({
      existsSync: (target) => {
        if (target === beeBinPath) return true;
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

    await ctx.mod.startBee();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(ctx.fsMock.mkdirSync).toHaveBeenCalledWith(ctx.dataDir, { recursive: true });
    expect(ctx.randomBytes).toHaveBeenCalledWith(32);
    expect(ctx.execSync).toHaveBeenCalledWith(`"${ctx.beeBinPath}" init --config="${ctx.configPath}"`);
    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toBe(ctx.beeBinPath);
    expect(ctx.spawnedProcesses[0].args).toEqual(['start', `--config=${ctx.configPath}`]);
    expect(ctx.mod.getActivePort()).toBe(1634);
    expect(ctx.updateService).toHaveBeenCalledWith('bee', {
      api: 'http://127.0.0.1:1634',
      gateway: 'http://127.0.0.1:1634',
      mode: 'bundled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('bee', 'Fallback Port: 1634');

    const configContent = ctx.fsMock.writeFileSync.mock.calls[0][1];
    expect(configContent).toContain('api-addr: 127.0.0.1:1634');
    expect(configContent).toContain(`data-dir: ${ctx.dataDir}`);
    expect(configContent).toContain(`password: ${'ab'.repeat(32)}`);

    const stopPromise = ctx.mod.stopBee();
    await flushMicrotasks();
    await stopPromise;

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('bee');
    expect(jest.getTimerCount()).toBe(0);
  });

  test('preserves an existing Bee password when rewriting config', async () => {
    jest.useFakeTimers();

    const ctx = loadBeeManagerModule({
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

    await ctx.mod.startBee();
    await flushMicrotasks();
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    const configContent = ctx.fsMock.writeFileSync.mock.calls[0][1];
    expect(configContent).toContain('password: keep-me');
    expect(ctx.execSync).not.toHaveBeenCalled();

    await ctx.mod.stopBee();
  });

  test('fails startup when the Bee binary is missing', async () => {
    const ctx = loadBeeManagerModule({
      binExists: false,
      portSequence: [false],
      httpResponse: () => ({
        statusCode: 500,
        body: '',
      }),
    });

    await ctx.mod.startBee();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('bee', 'Node failed to start');
  });
});
