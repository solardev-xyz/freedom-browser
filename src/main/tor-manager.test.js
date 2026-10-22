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
        updateActiveProfileNodeConfigWhenIdle: jest.fn(async (...args) =>
          updateActiveProfileNodeConfig(...args)),
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

  test('writeArtiConfig avoids the config keys Arti 2.0 removed', () => {
    // Arti 2.0.0 deleted the long-deprecated `proxy.socks_port` / `proxy.dns_port`
    // options; a config that still used them would abort the bundled client at
    // startup, which surfaces to the user only as "Tor failed to start".
    const { mod } = loadTorManager();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-cfg-legacy-'));
    try {
      const toml = fs.readFileSync(mod.writeArtiConfig(dataDir, 9155), 'utf-8');
      expect(toml).not.toMatch(/^\s*socks_port\s*=/m);
      expect(toml).not.toMatch(/^\s*dns_port\s*=/m);
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

  // #517 R2-M1: a failure saving the decision must settle Tor's state, not
  // leave it in STARTING behind an un-awaited rejected start.
  test('a failed external-candidate save puts Tor in ERROR instead of wedging STARTING', async () => {
    const ipcMain = createIpcMainMock();
    const activeProfile = {
      id: 'default',
      source: 'catalog',
      metadata: { nodes: { tor: { mode: 'managed', socksPort: 19150 } } },
    };
    const promptForDefaultExternalCandidateProtocol = jest.fn(async () => {
      throw new Error('profile catalog is busy');
    });
    const { mod } = loadTorManager({
      ipcMain,
      enableTorIntegration: true,
      activeProfile,
      promptForDefaultExternalCandidateProtocol,
    });
    mod.registerTorIpc();

    await ipcMain.invoke(IPC.TOR_START);
    await flushMicrotasks();
    await flushMicrotasks();

    expect(promptForDefaultExternalCandidateProtocol).toHaveBeenCalled();
    const res = await ipcMain.invoke(IPC.TOR_GET_STATUS);
    expect(res.status).toBe('error');
    expect(res.error).toMatch(/Tor node choice/);
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

      // Pin the whole CLI invocation, not just the subcommand: `arti proxy -c
      // <file>` is the contract this manager drives, and it is what has to be
      // re-checked against the pin in scripts/fetch-arti.js on every bump.
      expect(spawn).toHaveBeenCalledWith(
        expect.stringContaining('arti'),
        ['proxy', '-c', path.join(mod.getTorDataPath(), 'arti.toml')],
        expect.any(Object)
      );

      await mod.stopTor();
      expect(artiProcess.kills).toContain('SIGTERM');
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test('getArtiVersion parses the Arti 2.x multi-line --version output', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
      return realExistsSync(target);
    });
    // `arti --version` prints clap's long version: the version line followed by
    // the runtime and optional-feature lines. Only the version belongs in the UI.
    const execFile = jest.fn((file, args, options, callback) => {
      callback(null, {
        stdout: 'Arti 2.6.0\nusing runtime: TokioNativeTlsRuntime { .. }\noptional features: <none>\n',
        stderr: '',
      });
    });
    execFile[require('util').promisify.custom] = () =>
      Promise.resolve({
        stdout: 'Arti 2.6.0\nusing runtime: TokioNativeTlsRuntime { .. }\noptional features: <none>\n',
        stderr: '',
      });

    const { mod } = loadTorManager({
      enableTorIntegration: true,
      extraMocks: {
        child_process: () => ({ spawn: jest.fn(), execFile }),
      },
    });

    const res = await mod.getArtiVersion();
    expect(res.success).toBe(true);
    expect(res.name).toBe('Arti');
    expect(res.version).toBe('2.6.0');
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

describe('tor-manager profile mode sync (#377)', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const torEntry = () => require('./service-registry').getRegistry().tor;

  test('switching a refused Tor-disabled profile back clears the notice and the mode', async () => {
    const activeProfile = { metadata: { nodes: { tor: { mode: 'disabled' } } } };
    const { mod } = loadTorManager({ activeProfile, enableTorIntegration: true });

    await mod.startTor();
    expect(torEntry().mode).toBe('disabled');
    expect(torEntry().statusMessage).toBe('Tor disabled for this profile');

    activeProfile.metadata.nodes.tor = { mode: 'managed' };
    mod.syncProfileMode();

    expect(torEntry().mode).not.toBe('disabled');
    expect(torEntry().statusMessage).toBeNull();
  });

  test('a stopped Tor switched to disabled publishes the mode without a notice', () => {
    const activeProfile = { metadata: { nodes: { tor: { mode: 'managed' } } } };
    const { mod } = loadTorManager({ activeProfile, enableTorIntegration: true });

    activeProfile.metadata.nodes.tor = { mode: 'disabled' };
    mod.syncProfileMode();

    expect(torEntry().mode).toBe('disabled');
    expect(torEntry().statusMessage).toBeNull();
  });

  test('a running Tor switched to disabled publishes the mode once it stops', async () => {
    const activeProfile = {
      metadata: {
        nodes: { tor: { mode: 'external', externalSocks: 'socks5://127.0.0.1:9150/' } },
      },
    };
    const { mod } = loadTorManager({
      activeProfile,
      enableTorIntegration: true,
      socksProbeResult: true,
    });

    await mod.startTor();
    expect(torEntry().mode).toBe('external');

    // Saved while running: syncProfileMode() leaves the live entry alone.
    activeProfile.metadata.nodes.tor = { mode: 'disabled' };
    mod.syncProfileMode();
    expect(torEntry().mode).toBe('external');

    await mod.stopTor();
    expect(torEntry().mode).toBe('disabled');
    expect(torEntry().statusMessage).toBeNull();
  });

  test('stopping a Tor whose profile is not disabled leaves no mode behind', async () => {
    const activeProfile = {
      metadata: {
        nodes: { tor: { mode: 'external', externalSocks: 'socks5://127.0.0.1:9150/' } },
      },
    };
    const { mod } = loadTorManager({
      activeProfile,
      enableTorIntegration: true,
      socksProbeResult: true,
    });

    await mod.startTor();
    await mod.stopTor();
    expect(torEntry().mode).not.toBe('disabled');
  });

  test('IPC registration publishes a profile that launches with Tor disabled', () => {
    const activeProfile = { metadata: { nodes: { tor: { mode: 'disabled' } } } };
    const { mod } = loadTorManager({ activeProfile, enableTorIntegration: true });

    mod.registerTorIpc();

    expect(torEntry().mode).toBe('disabled');
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

describe('tor-manager SOCKS endpoint for IPFS (design 0007, B2)', () => {
  const externalAt = (externalSocks, extra = {}) =>
    loadTorManager({
      enableTorIntegration: true,
      socksProbeResult: true,
      activeProfile: { metadata: { nodes: { tor: { mode: 'external', externalSocks } } } },
      ...extra,
    });
  const createSessionMock = () => ({ setProxy: jest.fn().mockResolvedValue(undefined) });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('a running Tor offers its endpoint as an IP and a port, and a stop withdraws it', async () => {
    const { mod } = externalAt('socks5://127.0.0.1:9150/');
    const changes = [];
    mod.onIpfsSocksEndpointChange((change) => changes.push(change));
    expect(mod.getIpfsSocksEndpoint()).toEqual({ endpoint: null, refused: null });

    await mod.startTor({ targetSession: createSessionMock() });
    expect(mod.getIpfsSocksEndpoint()).toEqual({
      endpoint: { ip: '127.0.0.1', port: 9150 },
      refused: null,
    });

    await mod.stopTor();
    expect(mod.getIpfsSocksEndpoint()).toEqual({ endpoint: null, refused: null });
    expect(changes).toEqual([
      { endpoint: { ip: '127.0.0.1', port: 9150 }, refused: null },
      { endpoint: null, refused: null },
    ]);
  });

  test('localhost is 127.0.0.1, and an IPv6 literal is offered unbracketed', async () => {
    for (const [externalSocks, ip, port] of [
      ['socks5://localhost:9150', '127.0.0.1', 9150],
      ['socks5://LocalHost:9150', '127.0.0.1', 9150],
      ['socks5h://[::1]:9150', '::1', 9150],
      ['10.0.0.2:9050', '10.0.0.2', 9050],
    ]) {
      const { mod } = externalAt(externalSocks);
      await mod.startTor({ targetSession: createSessionMock() });
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual({ ip, port });
      await mod.stopTor();
    }
  });

  test('an external endpoint at a host name is refused for IPFS, and still routes .onion', async () => {
    for (const externalSocks of [
      'socks5://tor.lan:9050',
      'socks5://2130706433:9050',
      'socks5://127.1:9050',
    ]) {
      const targetSession = createSessionMock();
      const { mod } = externalAt(externalSocks);
      const changes = [];
      mod.onIpfsSocksEndpointChange((change) => changes.push(change));

      await mod.startTor({ targetSession });
      const offered = mod.getIpfsSocksEndpoint();
      expect(offered.endpoint).toBeNull();
      expect(offered.refused).toContain('is a host name');
      expect(changes).toEqual([offered]);
      // Tor itself runs: .onion still goes through it.
      expect(targetSession.setProxy).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'pac_script' })
      );

      await mod.stopTor();
      expect(mod.getIpfsSocksEndpoint()).toEqual({ endpoint: null, refused: null });
    }
  });

  test('the health check withdraws the endpoint while the proxy is unreachable, and offers it again', async () => {
    jest.useFakeTimers();
    let reachable = true;
    const { mod } = externalAt('socks5://127.0.0.1:9150/', {
      extraMocks: {
        [require.resolve('./socks-probe')]: () => ({
          probeSocks5Endpoint: jest.fn().mockResolvedValue(true),
          probeTcpEndpoint: jest.fn(async () => reachable),
        }),
      },
    });
    const changes = [];
    mod.onIpfsSocksEndpointChange((change) => changes.push(change.endpoint));

    await mod.startTor({ targetSession: createSessionMock() });
    await jest.advanceTimersByTimeAsync(5000);
    // Still healthy: no change.
    expect(changes).toEqual([{ ip: '127.0.0.1', port: 9150 }]);

    reachable = false;
    await jest.advanceTimersByTimeAsync(5000);
    expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();

    reachable = true;
    await jest.advanceTimersByTimeAsync(5000);
    expect(changes).toEqual([
      { ip: '127.0.0.1', port: 9150 },
      null,
      { ip: '127.0.0.1', port: 9150 },
    ]);

    await mod.stopTor();
  });

  test('a listener that throws neither fails the start nor keeps the others from hearing it', async () => {
    const { mod } = externalAt('socks5://127.0.0.1:9150/');
    mod.onIpfsSocksEndpointChange(() => {
      throw new Error('a failing IPFS listener');
    });
    const other = jest.fn();
    mod.onIpfsSocksEndpointChange(other);

    await expect(mod.startTor({ targetSession: createSessionMock() })).resolves.toBeUndefined();
    expect(other).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledWith({
      endpoint: { ip: '127.0.0.1', port: 9150 },
      refused: null,
    });
    expect(mod.getIpfsSocksEndpoint().endpoint).toEqual({ ip: '127.0.0.1', port: 9150 });

    await expect(mod.stopTor()).resolves.toBeUndefined();
    expect(other).toHaveBeenCalledTimes(2);
  });

  test("a listener that throws on withdrawal doesn't keep managed Arti from being stopped", async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
      return realExistsSync(target);
    });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-ipfs-stop-'));
    const artiProcess = createArtiProcessMock();
    try {
      const { mod } = loadTorManager({
        userDataDir,
        enableTorIntegration: true,
        activeProfile: {
          source: 'catalog',
          metadata: { nodes: { tor: { mode: 'managed', socksPort: 19152 } } },
        },
        extraMocks: {
          child_process: () => ({ spawn: jest.fn(() => artiProcess), execFile: jest.fn() }),
        },
      });
      await mod.startTor({ targetSession: createSessionMock() });
      artiProcess.stdout.on.mock.calls[0][1]('Sufficiently bootstrapped\n');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual({ ip: '127.0.0.1', port: 19152 });

      mod.onIpfsSocksEndpointChange(() => {
        throw new Error('a failing IPFS listener');
      });
      await expect(mod.stopTor()).resolves.toBeUndefined();
      expect(artiProcess.kills).toEqual(['SIGTERM']);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 15_000);

  describe('managed Arti: readiness and handlers belong to the live child', () => {
    // A port probe that always finds the port free, so a start never
    // waits on a real socket under fake timers.
    class FreePort {
      constructor() {
        this.handlers = {};
      }
      on(event, handler) {
        this.handlers[event] = handler;
        return this;
      }
      setTimeout() {
        return this;
      }
      connect() {
        this.handlers.error(new Error('nothing listens here'));
        return this;
      }
      destroy() {}
    }
    let userDataDir;
    afterEach(() => {
      if (userDataDir) fs.rmSync(userDataDir, { recursive: true, force: true });
      userDataDir = null;
    });
    // Managed Arti whose spawns return `children` in turn.
    const managedWith = (...children) => {
      jest.useFakeTimers();
      const realExistsSync = fs.existsSync;
      jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
        if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
        return realExistsSync(target);
      });
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-ipfs-child-'));
      const spawn = jest.fn();
      for (const child of children) spawn.mockReturnValueOnce(child);
      const { mod } = loadTorManager({
        userDataDir,
        enableTorIntegration: true,
        activeProfile: {
          source: 'catalog',
          metadata: { nodes: { tor: { mode: 'managed', socksPort: 19153 } } },
        },
        extraMocks: {
          child_process: () => ({ spawn, execFile: jest.fn() }),
          net: () => ({ ...jest.requireActual('net'), Socket: FreePort }),
        },
      });
      return mod;
    };
    const bootstrap = (child) => child.stdout.on.mock.calls[0][1]('Sufficiently bootstrapped\n');
    const failingSession = () => ({
      setProxy: jest.fn().mockRejectedValue(new Error('the session closed')),
    });
    const endpoint = { ip: '127.0.0.1', port: 19153 };

    test('an exit while the proxy is applied leaves nothing offered, and .onion fail-closed', async () => {
      const child = createArtiProcessMock();
      const mod = managedWith(child);
      let applied;
      const targetSession = {
        setProxy: jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (applied = resolve)))
          .mockResolvedValue(undefined),
      };
      await mod.startTor({ targetSession });
      bootstrap(child);
      await jest.advanceTimersByTimeAsync(1000);
      expect(applied).toBeDefined();

      child.emit('close', 1);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      applied();
      await jest.advanceTimersByTimeAsync(0);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      // Its exit stands: an error, not RUNNING, and the PAC kept.
      expect(targetSession.setProxy.mock.calls.filter(([arg]) => arg?.mode === 'direct')).toEqual(
        []
      );
      await mod.stopTor();
    });

    test("a retired child's output can't bootstrap its replacement", async () => {
      const [a, b] = [createArtiProcessMock(), createArtiProcessMock()];
      const mod = managedWith(a, b);
      // A bootstraps, but its proxy fails: an error, A left running.
      await mod.startTor({ targetSession: failingSession() });
      bootstrap(a);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();

      // B replaces it, and A is stopped.
      await mod.startTor({ targetSession: createSessionMock() });
      expect(a.kills).toEqual(['SIGTERM']);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      // A's marker is A's: B hasn't bootstrapped.
      bootstrap(a);
      await jest.advanceTimersByTimeAsync(2000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      // B's own marker does.
      bootstrap(b);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);
      await mod.stopTor();
    });

    test("a late apply after a crash and a restart leaves the restart's routing in force", async () => {
      const [a, b] = [createArtiProcessMock(), createArtiProcessMock()];
      const mod = managedWith(a, b);
      let appliedA;
      const targetSession = {
        setProxy: jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (appliedA = resolve)))
          .mockResolvedValue(undefined),
      };
      await mod.startTor({ targetSession });
      bootstrap(a);
      await jest.advanceTimersByTimeAsync(1000);
      expect(appliedA).toBeDefined();
      a.emit('close', 1);
      await mod.startTor({ targetSession });
      bootstrap(b);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);

      appliedA();
      await jest.advanceTimersByTimeAsync(0);
      const modes = targetSession.setProxy.mock.calls.map(([arg]) => arg?.mode);
      expect(modes).not.toContain('direct');
      expect(modes[modes.length - 1]).toBe('pac_script');
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);
      await mod.stopTor();
      expect(targetSession.setProxy.mock.calls.at(-1)[0].mode).toBe('direct');
    });

    test('a late apply after a deliberate stop leaves DIRECT in force', async () => {
      const child = createArtiProcessMock();
      const mod = managedWith(child);
      let applied;
      const targetSession = {
        setProxy: jest
          .fn()
          .mockImplementationOnce(() => new Promise((resolve) => (applied = resolve)))
          .mockResolvedValue(undefined),
      };
      await mod.startTor({ targetSession });
      bootstrap(child);
      await jest.advanceTimersByTimeAsync(1000);
      await mod.stopTor();
      const calls = targetSession.setProxy.mock.calls.length;
      expect(targetSession.setProxy.mock.calls.at(-1)[0].mode).toBe('direct');
      applied();
      await jest.advanceTimersByTimeAsync(0);
      // The late completion puts DIRECT last again, whatever order its own
      // call lands in.
      expect(targetSession.setProxy.mock.calls.length).toBe(calls + 1);
      expect(targetSession.setProxy.mock.calls.at(-1)[0].mode).toBe('direct');
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      // The closed child's backstop is gone with it.
      await jest.advanceTimersByTimeAsync(11000);
      expect(child.kills).toEqual(['SIGTERM']);
    });

    test("a stop whose signal failed can't signal a later start's child", async () => {
      const [a, b] = [createArtiProcessMock(), createArtiProcessMock()];
      // A's SIGTERM fails with an error and no exit; its SIGKILL ends it.
      a.kill = jest.fn((signal) => {
        a.kills.push(signal);
        if (signal === 'SIGTERM') {
          a.emit('error', new Error('the signal failed'));
          return false;
        }
        a.emit('close', 0);
        return true;
      });
      const mod = managedWith(a, b);
      await mod.startTor({ targetSession: createSessionMock() });
      bootstrap(a);
      await jest.advanceTimersByTimeAsync(1000);
      let stopped = false;
      const stopping = mod.stopTor().then(() => {
        stopped = true;
      });
      // The error made it ERROR: a start is allowed, and runs B.
      const sessionB = createSessionMock();
      await mod.startTor({ targetSession: sessionB });
      bootstrap(b);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);

      // A's backstop, ten seconds after its stop: A's alone.
      await jest.advanceTimersByTimeAsync(9000);
      expect(a.kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(b.kills).toEqual([]);
      await stopping;
      expect(stopped).toBe(true);
      // A's stop ended without touching B: its offer, and its routing.
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);
      expect(sessionB.setProxy.mock.calls.map(([arg]) => arg?.mode)).not.toContain('direct');
      await mod.stopTor();
      expect(b.kills).toEqual(['SIGTERM']);
    });

    test('a retired child that ignores SIGTERM is killed by its own backstop', async () => {
      const [a, b] = [createArtiProcessMock(), createArtiProcessMock()];
      a.kill = jest.fn((signal) => {
        a.kills.push(signal);
        return true;
      });
      const mod = managedWith(a, b);
      await mod.startTor({ targetSession: failingSession() });
      bootstrap(a);
      await jest.advanceTimersByTimeAsync(1000);
      await mod.startTor({ targetSession: createSessionMock() });
      bootstrap(b);
      await jest.advanceTimersByTimeAsync(1000);
      expect(a.kills).toEqual(['SIGTERM']);

      await jest.advanceTimersByTimeAsync(9000);
      expect(a.kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(b.kills).toEqual([]);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);
      await mod.stopTor();
      expect(b.kills).toEqual(['SIGTERM']);
    });

    test('a child that never bootstraps is stopped, and reports its startup timeout', async () => {
      const child = createArtiProcessMock();
      const mod = managedWith(child);
      mod.registerTorIpc();
      const targetSession = createSessionMock();
      await mod.startTor({ targetSession });
      await jest.advanceTimersByTimeAsync(120000);
      expect(child.kills).toEqual(['SIGTERM']);
      expect(await jest.requireMock('electron').ipcMain.invoke(IPC.TOR_GET_STATUS)).toEqual({
        status: 'error',
        error: 'Startup timed out',
      });
      // A failed start keeps .onion fail-closed.
      expect(targetSession.setProxy.mock.calls.map(([arg]) => arg?.mode)).not.toContain('direct');
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
    });

    test("a retired child's startup timeout isn't its replacement's", async () => {
      const [a, b] = [createArtiProcessMock(), createArtiProcessMock()];
      // A never bootstraps; its timeout's SIGTERM fails with an error and
      // no exit; its SIGKILL ends it.
      a.kill = jest.fn((signal) => {
        a.kills.push(signal);
        if (signal === 'SIGTERM') {
          a.emit('error', new Error('the signal failed'));
          return false;
        }
        a.emit('close', 0);
        return true;
      });
      const mod = managedWith(a, b);
      mod.registerTorIpc();
      await mod.startTor({ targetSession: createSessionMock() });
      await jest.advanceTimersByTimeAsync(120000);
      expect(a.kills).toEqual(['SIGTERM']);

      // B replaces it, runs, and is stopped cleanly.
      await mod.startTor({ targetSession: createSessionMock() });
      bootstrap(b);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);
      await mod.stopTor();
      const handler = jest.requireMock('electron').ipcMain;
      const status = await handler.invoke(IPC.TOR_GET_STATUS);
      expect(status).toEqual({ status: 'stopped', error: null });
      // A's exit, late, reports nothing either.
      await jest.advanceTimersByTimeAsync(10000);
      expect(a.kills).toEqual(['SIGTERM', 'SIGKILL']);
      expect(await handler.invoke(IPC.TOR_GET_STATUS)).toEqual({ status: 'stopped', error: null });
    });

    test("a retired child's exit or error doesn't touch its running replacement", async () => {
      const [a, b] = [createArtiProcessMock(), createArtiProcessMock()];
      a.kill = jest.fn((signal) => {
        a.kills.push(signal);
        return true;
      });
      const mod = managedWith(a, b);
      await mod.startTor({ targetSession: failingSession() });
      bootstrap(a);
      await jest.advanceTimersByTimeAsync(1000);

      await mod.startTor({ targetSession: createSessionMock() });
      bootstrap(b);
      await jest.advanceTimersByTimeAsync(1000);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);

      // A exits late, after its SIGTERM, and reports an error first.
      a.emit('error', new Error('a late error'));
      a.emit('close', 1);
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual(endpoint);

      // B is still the one a stop ends.
      await mod.stopTor();
      expect(b.kills).toEqual(['SIGTERM']);
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
    });
  });

  describe('a health result from an earlier run', () => {
    // External Tor at `endpoint` (mutable), whose SOCKS check answers
    // `socks.healthy`, and whose health checks wait until a test settles
    // them, oldest first.
    const heldHealthChecks = (profile, socks) => {
      const held = [];
      const { mod } = loadTorManager({
        enableTorIntegration: true,
        activeProfile: profile,
        extraMocks: {
          [require.resolve('./socks-probe')]: () => ({
            probeSocks5Endpoint: jest.fn(async () => socks.healthy),
            probeTcpEndpoint: jest.fn(
              (endpoint) => new Promise((settle) => held.push({ endpoint, settle }))
            ),
          }),
        },
      });
      return { mod, held };
    };
    const externalProfile = (externalSocks) => ({
      metadata: { nodes: { tor: { mode: 'external', externalSocks } } },
    });

    test("a stale success doesn't offer a restart whose SOCKS check failed", async () => {
      jest.useFakeTimers();
      const profile = externalProfile('127.0.0.1:9150');
      const socks = { healthy: true };
      const { mod, held } = heldHealthChecks(profile, socks);
      const changes = [];
      mod.onIpfsSocksEndpointChange((change) => changes.push(change.endpoint));

      await mod.startTor({ targetSession: createSessionMock() });
      await jest.advanceTimersByTimeAsync(5000);
      expect(held.map((check) => check.endpoint)).toEqual(['127.0.0.1:9150']);
      await mod.stopTor();

      profile.metadata.nodes.tor.externalSocks = '127.0.0.1:9151';
      socks.healthy = false;
      await mod.startTor({ targetSession: createSessionMock() });
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();

      held[0].settle(true);
      await flushMicrotasks();
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      expect(changes).toEqual([{ ip: '127.0.0.1', port: 9150 }, null]);
      await mod.stopTor();
    });

    test("a stale failure doesn't withdraw a restart that runs", async () => {
      jest.useFakeTimers();
      const profile = externalProfile('127.0.0.1:9150');
      const socks = { healthy: true };
      const { mod, held } = heldHealthChecks(profile, socks);

      await mod.startTor({ targetSession: createSessionMock() });
      await jest.advanceTimersByTimeAsync(5000);
      await mod.stopTor();

      profile.metadata.nodes.tor.externalSocks = '127.0.0.1:9151';
      await mod.startTor({ targetSession: createSessionMock() });
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual({ ip: '127.0.0.1', port: 9151 });

      held[0].settle(false);
      await flushMicrotasks();
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual({ ip: '127.0.0.1', port: 9151 });

      // The restart's own check still counts: it is of 9151, and a failure
      // withdraws the endpoint.
      await jest.advanceTimersByTimeAsync(5000);
      expect(held[1].endpoint).toBe('127.0.0.1:9151');
      held[1].settle(false);
      await flushMicrotasks();
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      await mod.stopTor();
    });

    test('a check that settles after its run was stopped changes nothing', async () => {
      jest.useFakeTimers();
      const { mod, held } = heldHealthChecks(externalProfile('127.0.0.1:9150'), {
        healthy: true,
      });
      const changes = [];
      mod.onIpfsSocksEndpointChange((change) => changes.push(change.endpoint));

      await mod.startTor({ targetSession: createSessionMock() });
      await jest.advanceTimersByTimeAsync(5000);
      await mod.stopTor();
      held[0].settle(false);
      await flushMicrotasks();
      held.length = 0;
      expect(changes).toEqual([{ ip: '127.0.0.1', port: 9150 }, null]);
    });
  });

  test('a stopped listener hears nothing more', async () => {
    const { mod } = externalAt('socks5://127.0.0.1:9150/');
    const listener = jest.fn();
    const stop = mod.onIpfsSocksEndpointChange(listener);
    stop();
    await mod.startTor({ targetSession: createSessionMock() });
    await mod.stopTor();
    expect(listener).not.toHaveBeenCalled();
  });

  test('managed Arti offers its endpoint once bootstrapped, and withdraws it when it exits', async () => {
    const realExistsSync = fs.existsSync;
    jest.spyOn(fs, 'existsSync').mockImplementation((target) => {
      if (String(target).includes(`${path.sep}arti-bin${path.sep}`)) return true;
      return realExistsSync(target);
    });
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tor-ipfs-endpoint-'));
    const artiProcess = createArtiProcessMock();
    try {
      const { mod } = loadTorManager({
        userDataDir,
        enableTorIntegration: true,
        activeProfile: {
          source: 'catalog',
          metadata: { nodes: { tor: { mode: 'managed', socksPort: 19151 } } },
        },
        extraMocks: {
          child_process: () => ({ spawn: jest.fn(() => artiProcess), execFile: jest.fn() }),
        },
      });
      const changes = [];
      mod.onIpfsSocksEndpointChange((change) => changes.push(change.endpoint));

      await mod.startTor({ targetSession: createSessionMock() });
      // Spawned, not yet bootstrapped: nothing offered.
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();

      const onStdout = artiProcess.stdout.on.mock.calls[0][1];
      onStdout('Sufficiently bootstrapped\n');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(mod.getIpfsSocksEndpoint().endpoint).toEqual({ ip: '127.0.0.1', port: 19151 });

      artiProcess.emit('close', 1);
      await flushMicrotasks();
      expect(mod.getIpfsSocksEndpoint().endpoint).toBeNull();
      expect(changes).toEqual([{ ip: '127.0.0.1', port: 19151 }, null]);
      await mod.stopTor();
    } finally {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  }, 15_000);
});
