const fs = require('fs');
const os = require('os');
const path = require('path');
const IPC = require('../shared/ipc-channels');
const { createIpcMainMock, loadMainModule } = require('../../test/helpers/main-process-test-utils');

const PROJECT_ROOT = path.join(__dirname, '..', '..');

function flushMicrotasks() {
  return Promise.resolve().then(() => Promise.resolve());
}

function createArtiProcessMock() {
  const handlers = new Map();
  const onceHandlers = new Map();
  const add = (store, event, handler) => {
    if (!store.has(event)) store.set(event, []);
    store.get(event).push(handler);
  };

  const proc = {
    kills: [],
    stdout: { on: jest.fn() },
    stderr: { on: jest.fn() },
    on: jest.fn((event, handler) => add(handlers, event, handler)),
    once: jest.fn((event, handler) => add(onceHandlers, event, handler)),
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args);
      const once = onceHandlers.get(event) || [];
      onceHandlers.delete(event);
      once.forEach((handler) => handler(...args));
    },
    kill: jest.fn((signal) => {
      proc.kills.push(signal);
      proc.emit('close', 0);
      return true;
    }),
  };

  return proc;
}

function loadTorManager(options = {}) {
  const ipcMain = options.ipcMain || createIpcMainMock();
  const enableTorIntegration = options.enableTorIntegration === true;
  const updateActiveProfileNodeConfig = options.updateActiveProfileNodeConfig || jest.fn();
  const promptForDefaultExternalCandidateProtocol =
    options.promptForDefaultExternalCandidateProtocol || jest.fn().mockResolvedValue([]);
  const defaultSession = options.defaultSession || {
    setProxy: jest.fn().mockResolvedValue(undefined),
  };
  const result = loadMainModule(require.resolve('./tor-manager'), {
    ipcMain,
    userDataDir: options.userDataDir,
    electronOverrides: {
      session: { defaultSession },
    },
    extraMocks: {
      [require.resolve('./logger')]: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
      [require.resolve('./settings-store')]: () => ({
        loadSettings: () => ({ enableTorIntegration }),
      }),
      [require.resolve('./profile-resolver')]: () => ({
        getActiveProfile: jest.fn(() => options.activeProfile || null),
        getReservedProfilePorts: jest.fn(() => options.reservedPorts || new Set()),
        updateActiveProfileNodeConfig,
      }),
      [require.resolve('./socks-probe')]: () => ({
        probeSocks5Endpoint: jest.fn().mockResolvedValue(options.socksProbeResult === true),
        probeTcpEndpoint: jest.fn().mockResolvedValue(options.tcpProbeResult ?? true),
      }),
      [require.resolve('./profile-external-candidates')]: () => ({
        promptForDefaultExternalCandidateProtocol,
      }),
      ...(options.extraMocks || {}),
    },
  });
  return {
    ...result,
    defaultSession,
  };
}

describe('tor-manager paths and config', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('getArtiBinaryPath points at the dev arti-bin layout', () => {
    const { mod } = loadTorManager();
    const expected = path.join(
      PROJECT_ROOT,
      'arti-bin',
      `${{ darwin: 'mac', linux: 'linux', win32: 'win' }[process.platform] || process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'arti.exe' : 'arti'
    );
    expect(mod.getArtiBinaryPath()).toBe(expected);
  });

  test('getTorDataPath honors FREEDOM_TOR_DATA override', () => {
    const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-data-'));
    const prev = process.env.FREEDOM_TOR_DATA;
    process.env.FREEDOM_TOR_DATA = overrideDir;
    try {
      const { mod } = loadTorManager();
      expect(mod.getTorDataPath()).toBe(overrideDir);
    } finally {
      if (prev === undefined) delete process.env.FREEDOM_TOR_DATA;
      else process.env.FREEDOM_TOR_DATA = prev;
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  });

  test('getTorDataPath uses the active profile userData directory by default', () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-profile-data-'));
    try {
      const { mod } = loadTorManager({ userDataDir });
      expect(mod.getTorDataPath()).toBe(path.join(userDataDir, 'tor-data'));
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('writeArtiConfig pins the SOCKS port and storage dirs', () => {
    const { mod } = loadTorManager();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-cfg-'));
    try {
      const configPath = mod.writeArtiConfig(dataDir, 9155);
      const toml = fs.readFileSync(configPath, 'utf-8');
      expect(toml).toContain('socks_listen = 9155');
      expect(toml).toContain('[storage]');
      expect(toml).toContain(JSON.stringify(path.join(dataDir, 'state')));
      expect(toml).toContain(JSON.stringify(path.join(dataDir, 'cache')));
      expect(fs.existsSync(path.join(dataDir, 'state'))).toBe(true);
      expect(fs.existsSync(path.join(dataDir, 'cache'))).toBe(true);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('checkBinary returns false when the arti binary is absent', () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return false;
      return realExistsSync(target);
    });
    const { mod } = loadTorManager();
    expect(mod.checkBinary()).toBe(false);
  });
});

describe('tor-manager IPC', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('TOR_GET_STATUS returns disabled response when integration is off', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain, enableTorIntegration: false });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_GET_STATUS);
    expect(res.status).toBe('stopped');
    expect(res.error).toMatch(/disabled/i);
  });

  test('TOR_START is blocked when integration is off', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain, enableTorIntegration: false });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_START);
    expect(res.status).toBe('stopped');
    expect(res.error).toMatch(/disabled/i);
  });

  test('TOR_CHECK_BINARY reports availability', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return false;
      return realExistsSync(target);
    });
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_CHECK_BINARY);
    expect(res).toEqual({ available: false });
  });

  test('TOR_GET_VERSION is blocked when integration is off', async () => {
    const ipcMain = createIpcMainMock();
    const { mod } = loadTorManager({ ipcMain, enableTorIntegration: false });
    mod.registerTorIpc();

    const res = await ipcMain.invoke(IPC.TOR_GET_VERSION);
    expect(res.success).toBe(false);
    expect(res.error?.message || res.error).toMatch(/disabled/i);
  });

  test('TOR_START prompts for a default external SOCKS endpoint before managed start', async () => {
    const ipcMain = createIpcMainMock();
    const activeProfile = {
      source: 'catalog',
      metadata: {
        nodes: {
          tor: {
            mode: 'managed',
            socksPort: 19150,
          },
        },
      },
    };
    const promptForDefaultExternalCandidateProtocol = jest.fn(async () => {
      activeProfile.metadata.nodes.tor = {
        mode: 'external',
        externalSocks: '127.0.0.1:9150',
      };
      return [
        {
          protocol: 'tor',
          choice: 'external',
          endpoints: ['SOCKS5 127.0.0.1:9150'],
        },
      ];
    });
    const { mod, defaultSession } = loadTorManager({
      ipcMain,
      enableTorIntegration: true,
      activeProfile,
      socksProbeResult: true,
      promptForDefaultExternalCandidateProtocol,
    });
    mod.registerTorIpc();

    await ipcMain.invoke(IPC.TOR_START);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(promptForDefaultExternalCandidateProtocol).toHaveBeenCalledWith(
      activeProfile,
      'tor',
      expect.objectContaining({ window: null })
    );
    expect(defaultSession.setProxy).toHaveBeenCalled();
    expect(mod.getActivePort()).toBe(9150);
    await mod.stopTor();
    await flushMicrotasks();
  });

  test('a stop during the external-candidate prompt cancels the pending start', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      // Pretend the bundled arti binary is present so the start would otherwise
      // reach spawn().
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
      return realExistsSync(target);
    });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-stop-race-'));
    const spawn = jest.fn();
    let releasePrompt;
    const promptForDefaultExternalCandidateProtocol = jest.fn(
      () => new Promise((resolve) => {
        releasePrompt = () => resolve([]);
      })
    );
    const updateActiveProfileNodeConfig = jest.fn();

    try {
      const { mod } = loadTorManager({
        userDataDir,
        enableTorIntegration: true,
        updateActiveProfileNodeConfig,
        promptForDefaultExternalCandidateProtocol,
        activeProfile: {
          source: 'catalog',
          metadata: { nodes: { tor: { mode: 'managed', socksPort: 19150 } } },
        },
        extraMocks: {
          child_process: () => ({ spawn, execFile: jest.fn() }),
        },
      });

      const starting = mod.startTor({ checkDefaultExternalCandidate: true });
      await flushMicrotasks();
      expect(promptForDefaultExternalCandidateProtocol).toHaveBeenCalled();

      // User toggles Tor off while the prompt is still open.
      await mod.stopTor();

      releasePrompt();
      await starting;
      await flushMicrotasks();

      // The superseded start must not spawn an arti the stop path can't kill,
      // nor churn the persisted SOCKS port.
      expect(spawn).not.toHaveBeenCalled();
      expect(updateActiveProfileNodeConfig).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('a managed start that is not interrupted still spawns arti', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
      return realExistsSync(target);
    });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-start-ok-'));
    const artiProcess = createArtiProcessMock();
    const spawn = jest.fn(() => artiProcess);

    try {
      const { mod } = loadTorManager({
        userDataDir,
        enableTorIntegration: true,
        activeProfile: {
          source: 'catalog',
          metadata: { nodes: { tor: { mode: 'managed', socksPort: 19150 } } },
        },
        extraMocks: {
          child_process: () => ({ spawn, execFile: jest.fn() }),
        },
      });

      await mod.startTor({ checkDefaultExternalCandidate: true });
      await flushMicrotasks();

      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining('arti'),
        expect.arrayContaining(['proxy']),
        expect.any(Object)
      );

      await mod.stopTor();
      expect(artiProcess.kills).toContain('SIGTERM');
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('getArtiVersion fails when the binary is absent', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return false;
      return realExistsSync(target);
    });
    const { mod } = loadTorManager({ enableTorIntegration: true });
    const res = await mod.getArtiVersion();
    expect(res.success).toBe(false);
  });

  test('starts external Tor profile through a SOCKS endpoint without requiring arti', async () => {
    const targetSession = { setProxy: jest.fn().mockResolvedValue(undefined) };
    const { mod } = loadTorManager({
      enableTorIntegration: true,
      socksProbeResult: true,
      activeProfile: {
        metadata: {
          nodes: {
            tor: {
              mode: 'external',
              externalSocks: 'socks5://127.0.0.1:9150/',
            },
          },
        },
      },
    });

    await mod.startTor({ targetSession });

    expect(targetSession.setProxy).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'pac_script' })
    );
    expect(mod.getActivePort()).toBe(9150);
    await mod.stopTor();
  });
});

describe('tor-manager .onion routing across sessions', () => {
  const createSessionMock = () => ({ setProxy: jest.fn().mockResolvedValue(undefined) });

  const loadExternalTorManager = () => loadTorManager({
    enableTorIntegration: true,
    socksProbeResult: true,
    activeProfile: {
      metadata: {
        nodes: {
          tor: { mode: 'external', externalSocks: 'socks5://127.0.0.1:9150/' },
        },
      },
    },
  });

  const pacCalls = (targetSession) => targetSession.setProxy.mock.calls
    .filter(([arg]) => arg?.mode === 'pac_script');

  const directCalls = (targetSession) => targetSession.setProxy.mock.calls
    .filter(([arg]) => arg?.mode === 'direct');

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('a private-window session registered before start is proxied too', async () => {
    const targetSession = createSessionMock();
    const privateSession = createSessionMock();
    const { mod } = loadExternalTorManager();

    mod.registerOnionRoutingSession('private-abc', privateSession);
    await mod.startTor({ targetSession });

    // Without this, a private window resolves *.onion DIRECT and leaks the
    // onion hostname to the system resolver.
    expect(pacCalls(privateSession)).toHaveLength(1);
    expect(pacCalls(targetSession)).toHaveLength(1);

    await mod.stopTor();
    expect(directCalls(privateSession)).toHaveLength(1);
  });

  test('a private window opened while Tor runs adopts the .onion PAC immediately', async () => {
    const targetSession = createSessionMock();
    const privateSession = createSessionMock();
    const { mod } = loadExternalTorManager();

    await mod.startTor({ targetSession });
    expect(pacCalls(privateSession)).toHaveLength(0);

    mod.registerOnionRoutingSession('private-late', privateSession);
    await flushMicrotasks();

    expect(pacCalls(privateSession)).toHaveLength(1);
    await mod.stopTor();
  });

  test('a closed private window stops receiving proxy updates', async () => {
    const targetSession = createSessionMock();
    const privateSession = createSessionMock();
    const { mod } = loadExternalTorManager();

    mod.registerOnionRoutingSession('private-gone', privateSession);
    await mod.startTor({ targetSession });
    mod.unregisterOnionRoutingSession('private-gone');

    await mod.stopTor();
    expect(directCalls(privateSession)).toHaveLength(0);
    expect(directCalls(targetSession)).toHaveLength(1);
  });

  test('an unexpected arti exit keeps .onion fail-closed instead of reverting to DIRECT', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
      return realExistsSync(target);
    });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-crash-'));
    const artiProcess = createArtiProcessMock();
    const targetSession = createSessionMock();
    const privateSession = createSessionMock();

    try {
      const { mod } = loadTorManager({
        userDataDir,
        enableTorIntegration: true,
        activeProfile: {
          source: 'catalog',
          metadata: { nodes: { tor: { mode: 'managed', socksPort: 19150 } } },
        },
        extraMocks: {
          child_process: () => ({ spawn: jest.fn(() => artiProcess), execFile: jest.fn() }),
        },
      });

      await mod.startTor({ targetSession });
      mod.registerOnionRoutingSession('private-crash', privateSession);

      // Arti announces bootstrap, the 1s poller then applies the PAC.
      const onStdout = artiProcess.stdout.on.mock.calls[0][1];
      onStdout('Sufficiently bootstrapped\n');
      await new Promise((resolve) => setTimeout(resolve, 1500));

      expect(pacCalls(targetSession)).toHaveLength(1);
      expect(pacCalls(privateSession)).toHaveLength(1);

      // Arti crashes. Clearing the PAC here would turn .onion into a DIRECT
      // (DNS-leaking) lookup with no user action — fail open.
      artiProcess.emit('close', 1);
      await flushMicrotasks();

      expect(directCalls(targetSession)).toHaveLength(0);
      expect(directCalls(privateSession)).toHaveLength(0);

      // A deliberate stop is still what restores DIRECT.
      await mod.stopTor();
      expect(directCalls(targetSession)).toHaveLength(1);
      expect(directCalls(privateSession)).toHaveLength(1);
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
