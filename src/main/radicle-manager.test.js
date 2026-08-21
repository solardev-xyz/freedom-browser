const path = require('path');
const IPC = require('../shared/ipc-channels');
const { failure, success } = require('./ipc-contract');
const {
  createAppMock,
  createIpcMainMock,
  loadMainModule,
} = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_USER_DATA_DIR = '/tmp/freedom-user-data';
const PROFILE_RADICLE_DATA_DIR = path.join(DEFAULT_USER_DATA_DIR, 'radicle-data');
const DEFAULT_HOME_DIR = '/home/test';

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createProcessMock(binary, options = {}) {
  const handlers = new Map();
  const onceHandlers = new Map();
  const stdoutHandlers = new Map();
  const stderrHandlers = new Map();

  const emitHandlers = (store, event, args) => {
    for (const handler of store.get(event) || []) {
      handler(...args);
    }
  };

  const proc = {
    binary,
    kills: [],
    stdout: {
      on: jest.fn((event, handler) => {
        if (!stdoutHandlers.has(event)) {
          stdoutHandlers.set(event, []);
        }
        stdoutHandlers.get(event).push(handler);
      }),
    },
    stderr: {
      on: jest.fn((event, handler) => {
        if (!stderrHandlers.has(event)) {
          stderrHandlers.set(event, []);
        }
        stderrHandlers.get(event).push(handler);
      }),
    },
    on: jest.fn((event, handler) => {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event).push(handler);
    }),
    once: jest.fn((event, handler) => {
      if (!onceHandlers.has(event)) {
        onceHandlers.set(event, []);
      }
      onceHandlers.get(event).push(handler);
    }),
    emit(event, ...args) {
      emitHandlers(handlers, event, args);
      const oneTimeHandlers = onceHandlers.get(event) || [];
      onceHandlers.delete(event);
      oneTimeHandlers.forEach((handler) => handler(...args));
    },
    emitStdout(data) {
      emitHandlers(stdoutHandlers, 'data', [data]);
    },
    emitStderr(data) {
      emitHandlers(stderrHandlers, 'data', [data]);
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
      const result =
        typeof portResolver === 'function'
          ? portResolver(port, host)
          : queue && queue.length > 0
            ? queue.shift()
            : false;

      process.nextTick(() => {
        if (result === true) {
          this.handlers.connect?.();
          return;
        }

        if (result === 'timeout') {
          this.handlers.timeout?.();
          return;
        }

        this.handlers.error?.(new Error('closed'));
      });
    }
  };
}

function createHttpGetMock(responseResolver) {
  const resolveResponse = responseResolver || (() => ({ statusCode: 200, body: '{}' }));

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
      end: jest.fn(),
      destroy: jest.fn(),
    };

    process.nextTick(() => {
      const responseConfig = resolveResponse(url);

      if (responseConfig?.error) {
        requestHandlers.get('error')?.(responseConfig.error);
        return;
      }

      if (responseConfig?.timeout) {
        requestHandlers.get('timeout')?.();
        return;
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

      process.nextTick(() => {
        const chunks = (() => {
          if (responseConfig?.body === undefined || responseConfig?.body === null) {
            return [];
          }
          if (typeof responseConfig.body === 'string') {
            return [responseConfig.body];
          }
          return [JSON.stringify(responseConfig.body)];
        })();

        for (const chunk of chunks) {
          for (const fn of responseHandlers.get('data') || []) {
            fn(chunk);
          }
        }
        for (const fn of responseHandlers.get('end') || []) {
          fn();
        }
      });
    });

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

function loadRadicleManagerModule(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const app =
    options.app ||
    createAppMock({
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
  const promptForDefaultExternalCandidateProtocol =
    options.promptForDefaultExternalCandidateProtocol || jest.fn().mockResolvedValue([]);
  const updateService = jest.fn();
  const setStatusMessage = jest.fn();
  const setErrorState = jest.fn();
  const clearErrorState = jest.fn();
  const clearService = jest.fn();
  const updateActiveProfileNodeConfig = options.updateActiveProfileNodeConfig || jest.fn();
  const execFileSync = options.execFileSync || jest.fn();
  const execFileAsync =
    options.execFileAsync || jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
  const spawnedProcesses = [];
  const spawn = jest.fn((binary, args = [], spawnOptions = {}) => {
    const proc = (options.createProcess || createProcessMock)(binary, options.processOptions || {});
    proc.args = args;
    proc.spawnOptions = spawnOptions;
    spawnedProcesses.push(proc);
    return proc;
  });
  const fsMock = {
    existsSync: jest.fn((target) => {
      if (typeof options.existsSync === 'function') {
        return options.existsSync(target);
      }

      const systemSocketPath = path.join(
        options.homeDir || DEFAULT_HOME_DIR,
        '.radicle',
        'node',
        'control.sock'
      );
      if (target === systemSocketPath) {
        return options.systemSocketExists === true;
      }

      if (target.endsWith(`${path.sep}node${path.sep}control.sock`)) {
        return options.socketExists !== false;
      }

      if (target.endsWith(`${path.sep}config.json`)) {
        return options.configExists === true;
      }

      if (target.endsWith(`${path.sep}keys`)) {
        return options.keysDirExists !== false;
      }

      if (target.endsWith(`${path.sep}rad`) || target.endsWith(`${path.sep}rad.exe`)) {
        return options.radBinaryExists !== false;
      }

      if (
        target.endsWith(`${path.sep}radicle-node`) ||
        target.endsWith(`${path.sep}radicle-node.exe`)
      ) {
        return options.nodeBinaryExists !== false;
      }

      if (
        target.endsWith(`${path.sep}radicle-httpd`) ||
        target.endsWith(`${path.sep}radicle-httpd.exe`)
      ) {
        return options.httpdBinaryExists !== false;
      }

      if (target === PROFILE_RADICLE_DATA_DIR) {
        return options.radicleDataDirExists === true;
      }

      return false;
    }),
    mkdirSync: jest.fn(),
    unlinkSync: jest.fn(),
    readdirSync: jest.fn(() => options.keyFiles || ['key']),
    readFileSync: jest.fn(() => options.configContents || '{}'),
    writeFileSync: jest.fn(),
  };
  const loadSettings = jest.fn(() => options.settings || { enableRadicleIntegration: true });
  const httpGet = createHttpGetMock(options.httpResponse);
  const Socket = createSocketClass(options.portSequence || options.portResolver || false);

  const { mod } = loadMainModule(require.resolve('./radicle-manager'), {
    app,
    ipcMain,
    BrowserWindow,
    extraMocks: {
      child_process: () => ({
        spawn,
        execFileSync,
        execFile: jest.fn(),
      }),
      fs: () => fsMock,
      http: () => ({
        get: httpGet,
      }),
      net: () => ({
        Socket,
      }),
      os: () => ({
        ...jest.requireActual('os'),
        homedir: jest.fn(() => options.homeDir || DEFAULT_HOME_DIR),
      }),
      util: () => ({
        ...jest.requireActual('util'),
        promisify: jest.fn(() => execFileAsync),
      }),
      [require.resolve('./logger')]: () => log,
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => options.activeProfile || null),
        getReservedProfilePorts: jest.fn(() => new Set(options.reservedPorts || [])),
        updateActiveProfileNodeConfig,
      }),
      [require.resolve('./profile-external-candidates')]: () => ({
        promptForDefaultExternalCandidateProtocol,
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
          radicle: {
            httpPort: 8780,
            p2pPort: 8776,
            fallbackRange: 10,
          },
        },
        updateService,
        setStatusMessage,
        setErrorState,
        clearErrorState,
        clearService,
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings,
      }),
    },
  });

  return {
    app,
    BrowserWindow,
    clearErrorState,
    clearService,
    execFileAsync,
    execFileSync,
    fsMock,
    httpGet,
    ipcMain,
    loadSettings,
    log,
    mod,
    promptForDefaultExternalCandidateProtocol,
    setErrorState,
    setStatusMessage,
    spawn,
    spawnedProcesses,
    updateService,
    updateActiveProfileNodeConfig,
    windows,
  };
}

describe('radicle-manager', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('returns the dev binary path and creates the dev data directory on demand', () => {
    const ctx = loadRadicleManagerModule({
      radicleDataDirExists: false,
    });
    const platformMap = {
      darwin: 'mac',
      linux: 'linux',
      win32: 'win',
    };
    const platform = platformMap[process.platform] || process.platform;
    const binaryName = process.platform === 'win32' ? 'radicle-node.exe' : 'radicle-node';

    expect(ctx.mod.getRadicleBinaryPath('radicle-node')).toBe(
      path.join(PROJECT_ROOT, 'radicle-bin', `${platform}-${process.arch}`, binaryName)
    );
    expect(ctx.mod.getRadicleDataPath()).toBe(PROFILE_RADICLE_DATA_DIR);
    expect(ctx.fsMock.mkdirSync).toHaveBeenCalledWith(PROFILE_RADICLE_DATA_DIR, {
      recursive: true,
    });
    expect(ctx.mod.getActiveRadHome()).toBe(PROFILE_RADICLE_DATA_DIR);
  });

  test('registers IPC handlers, blocks disabled integration, and validates missing RIDs', async () => {
    const ctx = loadRadicleManagerModule({
      settings: { enableRadicleIntegration: false },
    });

    ctx.mod.registerRadicleIpc();

    expect([...ctx.ipcMain.handlers.keys()].sort()).toEqual(
      [
        IPC.RADICLE_START,
        IPC.RADICLE_STOP,
        IPC.RADICLE_GET_STATUS,
        IPC.RADICLE_CHECK_BINARY,
        IPC.RADICLE_SEED,
        IPC.RADICLE_GET_CONNECTIONS,
        IPC.RADICLE_GET_REPO_PAYLOAD,
        IPC.RADICLE_SYNC_REPO,
        IPC.RADICLE_GET_SEED_STATUS,
      ].sort()
    );

    await expect(ctx.ipcMain.invoke(IPC.RADICLE_START)).resolves.toEqual({
      status: 'stopped',
      error: 'Radicle integration is disabled. Enable it in Settings > Experimental',
    });
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_STATUS)).resolves.toEqual({
      status: 'stopped',
      error: 'Radicle integration is disabled. Enable it in Settings > Experimental',
    });
    await expect(
      ctx.ipcMain.invoke(IPC.RADICLE_SEED, 'z3QXuMvMmSeEX3ZgoUidZC1v5MkKE')
    ).resolves.toEqual(
      failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      )
    );
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_CONNECTIONS)).resolves.toEqual(
      failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental',
        undefined,
        { count: 0 }
      )
    );
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_REPO_PAYLOAD, '')).resolves.toEqual(
      failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      )
    );
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_SYNC_REPO, '')).resolves.toEqual(
      failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      )
    );
  });

  test('reports binary availability and validates missing repository IDs when enabled', async () => {
    const ctx = loadRadicleManagerModule({
      nodeBinaryExists: false,
    });

    ctx.mod.registerRadicleIpc();

    await expect(ctx.ipcMain.invoke(IPC.RADICLE_CHECK_BINARY)).resolves.toEqual({
      available: false,
    });
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_SEED, '')).resolves.toEqual(
      failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' })
    );
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_REPO_PAYLOAD, '')).resolves.toEqual(
      failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' })
    );
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_SYNC_REPO, '')).resolves.toEqual(
      failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' })
    );
  });

  test('reuses an existing local httpd and serves seed, payload, sync, and connection IPC requests', async () => {
    jest.spyOn(global, 'setInterval').mockReturnValue(1);
    jest.spyOn(global, 'clearInterval').mockImplementation(() => {});

    const window = createWindowMock();
    const execFileAsync = jest.fn((binary, args) => {
      if (args[0] === 'seed') {
        return Promise.resolve({ stdout: '', stderr: '' });
      }
      if (args[0] === 'inspect') {
        return Promise.resolve({ stdout: JSON.stringify({ name: 'project' }), stderr: '' });
      }
      if (args[0] === 'sync') {
        return Promise.resolve({ stdout: 'synced\n', stderr: '' });
      }
      if (args[0] === 'node' && args[1] === 'status') {
        return Promise.resolve({
          stdout: [
            'Node is running',
            '│ z6MkgNR111   iris.radicle.xyz:8776   ✓   ↗   1.75 minute(s) │',
            '│ z6MkgNR222   rosa.radicle.xyz:8776   ✓   ↗   2.10 minute(s) │',
            '│ z6MkgNR333   local.radicle.xyz:8776   ✗   ↗   0.10 minute(s) │',
          ].join('\n'),
          stderr: '',
        });
      }
      throw new Error(`Unexpected execFileAsync call: ${binary} ${args.join(' ')}`);
    });
    const ctx = loadRadicleManagerModule({
      execFileAsync,
      windows: [window],
      portSequence: [true],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:8780/') {
          return { statusCode: 200, body: { version: '0.1.0' } };
        }
        return { statusCode: 404, body: '' };
      },
    });

    ctx.mod.registerRadicleIpc();

    await ctx.mod.startRadicle();
    await flushMicrotasks();

    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_STATUS)).resolves.toEqual({
      status: 'running',
      error: null,
    });
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:8780',
      gateway: 'http://127.0.0.1:8780',
      mode: 'reused',
    });
    expect(window.webContents.send).toHaveBeenCalledWith(IPC.RADICLE_STATUS_UPDATE, {
      status: 'starting',
      error: null,
    });
    expect(window.webContents.send).toHaveBeenLastCalledWith(IPC.RADICLE_STATUS_UPDATE, {
      status: 'running',
      error: null,
    });

    // Seeding writes the policy and reports the background fetch status.
    await expect(
      ctx.ipcMain.invoke(IPC.RADICLE_SEED, 'z3QXuMvMmSeEX3ZgoUidZC1v5MkKE')
    ).resolves.toEqual(
      success({
        status: expect.objectContaining({
          rid: 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE',
          state: 'fetching',
          inStorage: false,
        }),
      })
    );
    require('./radicle/seed-status').cancelFetch('rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE');
    await expect(
      ctx.ipcMain.invoke(IPC.RADICLE_GET_REPO_PAYLOAD, 'rad://z3QXuMvMmSeEX3ZgoUidZC1v5MkKE')
    ).resolves.toEqual(success({ payload: { name: 'project' } }));
    // sync is non-blocking now: it (re)starts the tracked fetch.
    await expect(
      ctx.ipcMain.invoke(IPC.RADICLE_SYNC_REPO, 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE')
    ).resolves.toEqual(
      success({
        status: expect.objectContaining({ rid: 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE' }),
      })
    );
    await expect(
      ctx.ipcMain.invoke(IPC.RADICLE_GET_SEED_STATUS, 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE')
    ).resolves.toEqual(
      success({
        status: expect.objectContaining({ rid: 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE' }),
      })
    );
    require('./radicle/seed-status').cancelFetch('rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE');
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_CONNECTIONS)).resolves.toEqual(
      success({ count: 2 })
    );

    await expect(ctx.ipcMain.invoke(IPC.RADICLE_SEED, 'not-a-rid')).resolves.toEqual(
      failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid: 'not-a-rid' })
    );

    await ctx.mod.stopRadicle();
  });

  test('getConnections silently reports zero peers while the node is still within the startup grace period', async () => {
    jest.spyOn(global, 'setInterval').mockReturnValue(1);
    jest.spyOn(global, 'clearInterval').mockImplementation(() => {});

    let nodeStatusCalls = 0;
    const execFileAsync = jest.fn((binary, args) => {
      if (args[0] === 'node' && args[1] === 'status') {
        nodeStatusCalls += 1;
        const err = new Error(`Command failed: ${binary} node status`);
        err.code = 1;
        return Promise.reject(err);
      }
      return Promise.resolve({ stdout: '', stderr: '' });
    });

    const baseTime = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseTime);

    const ctx = loadRadicleManagerModule({
      execFileAsync,
      portSequence: [true],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:8780/') {
          return { statusCode: 200, body: { version: '0.1.0' } };
        }
        return { statusCode: 404, body: '' };
      },
    });

    ctx.mod.registerRadicleIpc();

    await ctx.mod.startRadicle();
    await flushMicrotasks();

    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_STATUS)).resolves.toEqual({
      status: 'running',
      error: null,
    });

    // Well within the 30s startup grace — the transient failure should be
    // swallowed and reported as zero peers with no error log.
    nowSpy.mockReturnValue(baseTime + 5_000);
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_CONNECTIONS)).resolves.toEqual(
      success({ count: 0 })
    );
    expect(nodeStatusCalls).toBe(1);
    expect(ctx.log.error).not.toHaveBeenCalledWith(
      '[Radicle] Failed to get connections:',
      expect.any(String)
    );

    // After the grace period the failure should surface as an error.
    nowSpy.mockReturnValue(baseTime + 45_000);
    await expect(ctx.ipcMain.invoke(IPC.RADICLE_GET_CONNECTIONS)).resolves.toEqual(
      failure('GET_CONNECTIONS_FAILED', expect.any(String), undefined, { count: 0 })
    );
    expect(ctx.log.error).toHaveBeenCalledWith(
      '[Radicle] Failed to get connections:',
      expect.any(String)
    );

    nowSpy.mockRestore();
    await ctx.mod.stopRadicle();
  });

  test('starts a bundled node on a fallback port after a conflict and stops both processes cleanly', async () => {
    const execFileAsync = jest.fn().mockResolvedValue({ stdout: '', stderr: '' });
    const ctx = loadRadicleManagerModule({
      execFileAsync,
      configExists: false,
      keyFiles: [],
      portSequence: [true, false],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:8780/') {
          return { statusCode: 503, body: '' };
        }
        if (url === 'http://127.0.0.1:8781/') {
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushMicrotasks();

    expect(ctx.execFileSync).toHaveBeenCalledWith(
      expect.stringContaining(`${path.sep}rad`),
      ['auth', '--alias', 'FreedomBrowser'],
      expect.objectContaining({
        env: expect.objectContaining({
          RAD_HOME: PROFILE_RADICLE_DATA_DIR,
          RAD_PASSPHRASE: '',
        }),
        stdio: 'pipe',
      })
    );
    expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
      path.join(PROFILE_RADICLE_DATA_DIR, 'config.json'),
      JSON.stringify(
        {
          preferredSeeds: [
            'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.network:8776',
            'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.network:8776',
            'z6MksmpU5b1dS7oaqF2bHXhQi1DWy2hB7Mh9CuN7y1DN6QSz@seed.radicle.xyz:8776',
          ],
          node: {
            alias: 'FreedomBrowser',
            listen: ['0.0.0.0:8776'],
          },
        },
        null,
        2
      )
    );
    expect(ctx.spawnedProcesses).toHaveLength(2);
    expect(ctx.spawnedProcesses[0].binary).toContain('radicle-node');
    expect(ctx.spawnedProcesses[1].binary).toContain('radicle-httpd');
    expect(ctx.spawnedProcesses[0].spawnOptions.env.RAD_HOME).toBe(PROFILE_RADICLE_DATA_DIR);
    expect(ctx.spawnedProcesses[1].spawnOptions.env.RAD_HOME).toBe(PROFILE_RADICLE_DATA_DIR);
    expect(ctx.spawnedProcesses[1].args).toEqual(['--listen', '127.0.0.1:8781']);
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:8781',
      gateway: 'http://127.0.0.1:8781',
      mode: 'bundled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('radicle', 'Fallback Port: 8781');
    expect(ctx.mod.getActivePort()).toBe(8781);

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await flushMicrotasks();
    await stopPromise;

    expect(ctx.spawnedProcesses[1].kills).toContain('SIGTERM');
    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('radicle');
  });

  test('upgrades the old two-seed default set to the current defaults', async () => {
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: true,
      // Exactly what the pre-seed.radicle.xyz merge code wrote into every
      // profile (legacy hostnames on top) — provably not a user choice.
      configContents: JSON.stringify({
        preferredSeeds: [
          'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.xyz:8776',
          'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.xyz:8776',
        ],
        node: { alias: 'CustomAlias', listen: [] },
      }),
      portResolver: (port) => port === 18780 || port === 18776,
      httpResponse: (url) =>
        url === 'http://127.0.0.1:18781/'
          ? { statusCode: 200, body: {} }
          : { statusCode: 404, body: '' },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();

    const configWrite = ctx.fsMock.writeFileSync.mock.calls.find(
      ([target]) => target === path.join(PROFILE_RADICLE_DATA_DIR, 'config.json')
    );
    const nextConfig = JSON.parse(configWrite[1]);
    expect(nextConfig.preferredSeeds).toEqual([
      'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.network:8776',
      'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.network:8776',
      'z6MksmpU5b1dS7oaqF2bHXhQi1DWy2hB7Mh9CuN7y1DN6QSz@seed.radicle.xyz:8776',
    ]);

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopPromise;
  });

  test('migrates legacy Radicle seed hostnames in existing config', async () => {
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: true,
      configContents: JSON.stringify({
        preferredSeeds: [
          'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.xyz:8776',
          'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.xyz:8776',
          'z6Mcustom@local.example:8776',
        ],
        node: {
          alias: 'CustomAlias',
          listen: ['0.0.0.0:9999'],
        },
      }),
      portResolver: (port) => port === 18780 || port === 18776,
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:18781/') {
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();

    const configWrite = ctx.fsMock.writeFileSync.mock.calls.find(
      ([target]) => target === path.join(PROFILE_RADICLE_DATA_DIR, 'config.json')
    );
    const nextConfig = JSON.parse(configWrite[1]);

    expect(nextConfig.preferredSeeds).toEqual([
      'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.network:8776',
      'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.network:8776',
      'z6Mcustom@local.example:8776',
    ]);
    expect(nextConfig.node).toEqual({
      alias: 'CustomAlias',
      listen: ['0.0.0.0:18777'],
    });

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopPromise;
  });

  test('starts a managed profile node on profile ports without reusing defaults', async () => {
    const checkedPorts = [];
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: false,
      keyFiles: [],
      portResolver: (port) => {
        checkedPorts.push(port);
        return false;
      },
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:18780/') {
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushMicrotasks();

    expect(checkedPorts).toContain(18780);
    expect(checkedPorts).toContain(18776);
    expect(checkedPorts).not.toContain(8780);
    expect(ctx.spawnedProcesses).toHaveLength(2);
    expect(ctx.spawnedProcesses[0].binary).toContain('radicle-node');
    expect(ctx.spawnedProcesses[1].binary).toContain('radicle-httpd');
    expect(ctx.spawnedProcesses[1].args).toEqual(['--listen', '127.0.0.1:18780']);
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:18780',
      gateway: 'http://127.0.0.1:18780',
      mode: 'bundled',
    });
    expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
      path.join(PROFILE_RADICLE_DATA_DIR, 'config.json'),
      expect.stringContaining('"0.0.0.0:18776"')
    );

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopPromise;
  });

  test('persists reassigned managed profile ports before launching Radicle', async () => {
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        source: 'catalog',
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: false,
      keyFiles: [],
      portResolver: (port) => port === 18780 || port === 18776,
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:18781/') {
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushMicrotasks();

    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('radicle', {
      httpPort: 18781,
      p2pPort: 18777,
    });
    expect(ctx.spawnedProcesses).toHaveLength(2);
    expect(ctx.spawnedProcesses[1].args).toEqual(['--listen', '127.0.0.1:18781']);
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:18781',
      gateway: 'http://127.0.0.1:18781',
      mode: 'bundled',
    });
    expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
      path.join(PROFILE_RADICLE_DATA_DIR, 'config.json'),
      expect.stringContaining('"0.0.0.0:18777"')
    );

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopPromise;
  });

  test('skips reserved sibling profile ports when reassigning Radicle ports', async () => {
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        source: 'catalog',
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: false,
      keyFiles: [],
      reservedPorts: [18781, 18777],
      portResolver: (port) => port === 18780 || port === 18776,
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:18782/') {
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushMicrotasks();

    expect(ctx.updateActiveProfileNodeConfig).toHaveBeenCalledWith('radicle', {
      httpPort: 18782,
      p2pPort: 18778,
    });
    expect(ctx.spawnedProcesses).toHaveLength(2);
    expect(ctx.spawnedProcesses[1].args).toEqual(['--listen', '127.0.0.1:18782']);
    expect(ctx.fsMock.writeFileSync).toHaveBeenCalledWith(
      path.join(PROFILE_RADICLE_DATA_DIR, 'config.json'),
      expect.stringContaining('"0.0.0.0:18778"')
    );

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopPromise;
  });

  test('connects to a configured external profile httpd without probing defaults or system node', async () => {
    jest.spyOn(global, 'setInterval').mockReturnValue(987);
    const clearIntervalSpy = jest.spyOn(global, 'clearInterval').mockImplementation(() => {});
    const checkedPorts = [];
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: {
              mode: 'external',
              externalHttp: ' http://127.0.0.1:28780/ ',
            },
          },
        },
      },
      systemSocketExists: true,
      portResolver: (port) => {
        checkedPorts.push(port);
        return true;
      },
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:28780/') {
          return { statusCode: 200, body: { version: '0.1.0' } };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(checkedPorts).toEqual([]);
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(28780);
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:28780',
      gateway: 'http://127.0.0.1:28780',
      mode: 'external',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('radicle', 'External node: 127.0.0.1:28780');

    await ctx.mod.stopRadicle();

    expect(clearIntervalSpy).toHaveBeenCalledWith(987);
    expect(ctx.clearService).toHaveBeenCalledWith('radicle');
  });

  test('manual IPC start prompts for a default external Radicle node before managed start', async () => {
    const activeProfile = {
      source: 'catalog',
      metadata: {
        nodes: {
          radicle: {
            mode: 'managed',
            httpPort: 18780,
            p2pPort: 18776,
          },
        },
      },
    };
    const promptForDefaultExternalCandidateProtocol = jest.fn(async () => {
      activeProfile.metadata.nodes.radicle = {
        mode: 'external',
        externalHttp: 'http://127.0.0.1:8780',
      };
      return [
        {
          protocol: 'radicle',
          choice: 'external',
          endpoints: ['http://127.0.0.1:8780'],
        },
      ];
    });
    const ctx = loadRadicleManagerModule({
      activeProfile,
      promptForDefaultExternalCandidateProtocol,
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:8780/') {
          return { statusCode: 200, body: { version: '0.1.0' } };
        }
        return { statusCode: 404, body: '' };
      },
    });

    ctx.mod.registerRadicleIpc();
    await ctx.ipcMain.invoke(IPC.RADICLE_START);
    await new Promise((resolve) => setImmediate(resolve));
    await flushMicrotasks();
    await flushMicrotasks();

    expect(promptForDefaultExternalCandidateProtocol).toHaveBeenCalledWith(
      activeProfile,
      'radicle',
      expect.objectContaining({ logger: ctx.log, window: null })
    );
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBe(8780);
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:8780',
      gateway: 'http://127.0.0.1:8780',
      mode: 'external',
    });

    await ctx.mod.stopRadicle();
  });

  test('a stop during the external-candidate prompt cancels the pending start', async () => {
    const activeProfile = {
      source: 'catalog',
      metadata: {
        nodes: {
          radicle: {
            mode: 'managed',
            httpPort: 18780,
            p2pPort: 18776,
          },
        },
      },
    };
    let releasePrompt;
    const promptForDefaultExternalCandidateProtocol = jest.fn(
      () => new Promise((resolve) => {
        releasePrompt = () => resolve([]);
      })
    );
    const ctx = loadRadicleManagerModule({
      activeProfile,
      promptForDefaultExternalCandidateProtocol,
    });

    ctx.mod.registerRadicleIpc();
    const starting = ctx.mod.startRadicle({ checkDefaultExternalCandidate: true });
    await flushMicrotasks();
    expect(promptForDefaultExternalCandidateProtocol).toHaveBeenCalled();

    // User toggles the node off while the prompt is still open.
    await ctx.mod.stopRadicle();
    expect((await ctx.ipcMain.invoke(IPC.RADICLE_GET_STATUS)).status).toBe('stopped');

    releasePrompt();
    await starting;
    await new Promise((resolve) => setImmediate(resolve));
    await flushMicrotasks();

    // The superseded start must not spawn processes the stop path can't kill.
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.updateActiveProfileNodeConfig).not.toHaveBeenCalled();
    expect((await ctx.ipcMain.invoke(IPC.RADICLE_GET_STATUS)).status).toBe('stopped');
  });

  test('a stop during the node socket wait leaves Radicle stopped and restartable', async () => {
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: false,
      keyFiles: [],
      // Node socket never shows up, so the start sits in waitForSocket().
      socketExists: false,
      portResolver: () => false,
    });

    ctx.mod.registerRadicleIpc();
    const starting = ctx.mod.startRadicle();
    await new Promise((resolve) => setImmediate(resolve));
    await flushMicrotasks();

    // Only radicle-node is up: httpd waits for the socket.
    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toContain('radicle-node');

    // User toggles the node back off while the socket wait is still pending.
    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await stopPromise;
    await flushMicrotasks();

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('radicle');
    expect((await ctx.ipcMain.invoke(IPC.RADICLE_GET_STATUS)).status).toBe('stopped');
    // The abandoned socket wait must not report a startup failure.
    expect(ctx.log.error).not.toHaveBeenCalledWith(
      '[Radicle] Socket wait failed:',
      expect.anything()
    );

    // ...and the node must be startable again, not wedged for the session.
    ctx.mod.startRadicle();
    await new Promise((resolve) => setImmediate(resolve));
    await flushMicrotasks();

    expect(ctx.spawnedProcesses).toHaveLength(2);
    expect(ctx.spawnedProcesses[1].binary).toContain('radicle-node');

    // The abandoned socket wait must give up rather than hold the start open.
    await starting;

    await ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  test('a start queued while stopping runs once the last process exits', async () => {
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: { mode: 'managed', httpPort: 18780, p2pPort: 18776 },
          },
        },
      },
      configExists: false,
      keyFiles: [],
      socketExists: false,
      portResolver: () => false,
    });

    const starting = ctx.mod.startRadicle();
    await new Promise((resolve) => setImmediate(resolve));
    await flushMicrotasks();
    expect(ctx.spawnedProcesses).toHaveLength(1);

    const stopPromise = ctx.mod.stopRadicle();
    // Toggled straight back on while the stop is still in flight.
    await ctx.mod.startRadicle();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await stopPromise;
    // The queued start is scheduled 100ms after the stop finalizes.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await flushMicrotasks();

    expect(ctx.spawnedProcesses).toHaveLength(2);
    expect(ctx.spawnedProcesses[1].binary).toContain('radicle-node');

    await starting;
    await ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 600));
  });

  test('marks a disabled profile Radicle node without probing or spawning', async () => {
    const checkedPorts = [];
    const ctx = loadRadicleManagerModule({
      activeProfile: {
        metadata: {
          nodes: {
            radicle: { mode: 'disabled' },
          },
        },
      },
      systemSocketExists: true,
      portResolver: (port) => {
        checkedPorts.push(port);
        return true;
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();

    expect(checkedPorts).toEqual([]);
    expect(ctx.httpGet).not.toHaveBeenCalled();
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.mod.getActivePort()).toBeNull();
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: null,
      gateway: null,
      mode: 'disabled',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('radicle', 'Node disabled for this profile');
  });

  test('starts httpd against a detected system node and stops only that spawned process', async () => {
    const ctx = loadRadicleManagerModule({
      systemSocketExists: true,
      portSequence: [true, false],
      httpResponse: (url) => {
        if (url === 'http://127.0.0.1:8780/') {
          return { statusCode: 503, body: '' };
        }
        if (url === 'http://127.0.0.1:8781/') {
          return { statusCode: 200, body: {} };
        }
        return { statusCode: 404, body: '' };
      },
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await flushMicrotasks();

    expect(ctx.spawnedProcesses).toHaveLength(1);
    expect(ctx.spawnedProcesses[0].binary).toContain('radicle-httpd');
    expect(ctx.spawnedProcesses[0].args).toEqual(['--listen', '127.0.0.1:8781']);
    expect(ctx.updateService).toHaveBeenCalledWith('radicle', {
      api: 'http://127.0.0.1:8781',
      gateway: 'http://127.0.0.1:8781',
      mode: 'reused',
    });
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('radicle', 'System node: localhost:8781');
    expect(ctx.mod.getActiveRadHome()).toBe(path.join(DEFAULT_HOME_DIR, '.radicle'));

    const stopPromise = ctx.mod.stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await stopPromise;

    expect(ctx.spawnedProcesses[0].kills).toContain('SIGTERM');
    expect(ctx.clearService).toHaveBeenCalledWith('radicle');
  });

  test('fails startup when identity creation cannot complete', async () => {
    const ctx = loadRadicleManagerModule({
      keyFiles: [],
      radBinaryExists: false,
      portSequence: [false],
      httpResponse: () => ({ statusCode: 404, body: '' }),
    });

    await ctx.mod.startRadicle();
    await flushMicrotasks();

    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.setStatusMessage).toHaveBeenCalledWith('radicle', 'Node failed to start');
    expect(ctx.log.error).toHaveBeenCalledWith(
      '[Radicle] rad binary not found for identity creation'
    );
  });
});
