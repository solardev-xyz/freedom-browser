/**
 * Tor (Arti) node manager.
 *
 * Spawns the bundled `arti` binary as a local SOCKS5 proxy and wires the
 * default Electron session to route `.onion` traffic through it. Mirrors the
 * lifecycle/state-machine shape of `radicle-manager.js` (STATUS states,
 * service-registry broadcasts, IPC handlers gated by an Experimental setting).
 *
 * Arti is the Tor Project's pure-Rust Tor client. We run it in SOCKS-proxy
 * mode (`arti proxy -c <config.toml>`); see README and `scripts/fetch-arti.js`.
 */

const log = require('./logger');
const { ipcMain, app, session, BrowserWindow } = require('electron');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const execFileAsync = promisify(execFile);
const fs = require('fs');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { normalizeSocksEndpoint, parseSocksEndpoint } = require('../shared/socks-endpoint');
const { success, failure } = require('./ipc-contract');
const { loadSettings } = require('./settings-store');
const { getTorDataDir } = require('./profile-paths');
const {
  getActiveProfile,
  getReservedProfilePorts,
  updateActiveProfileNodeConfig,
} = require('./profile-resolver');
const {
  promptForDefaultExternalCandidateProtocol,
} = require('./profile-external-candidates');
const { probeSocks5Endpoint, probeTcpEndpoint } = require('./socks-probe');
const { applyOnionProxy, clearOnionProxy } = require('./tor-proxy');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');

// States (mirrors radicle-manager.js)
const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let artiProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;
// Set by a startup-timeout before it calls stopTor(), so the exit handler
// reports this error rather than the raw "arti exited with code N" that the
// SIGTERM/SIGKILL produces. Consumed once. (Arti is single-process, so unlike
// radicle there is no leaked-backstop hazard — this is message fidelity.)
let pendingStopError = null;
let currentSocksPort = DEFAULTS.tor.socksPort;
let currentSocksEndpoint = `127.0.0.1:${DEFAULTS.tor.socksPort}`;
// Every session that must follow the `.onion` routing policy, keyed by a
// stable id: DEFAULT_SESSION_KEY for the default session plus one entry per
// live private-window partition. A PAC applies to exactly one session, so a
// private partition that is not in here resolves `*.onion` DIRECT and leaks
// the hostname to the system resolver — hence the private-window sessions are
// registered by src/main/index.js's private-session configurator.
const DEFAULT_SESSION_KEY = 'default';
const proxySessions = new Map();
// SOCKS endpoint currently pinned into every tracked session's PAC, or null
// when `.onion` is routed DIRECT. A session registered later adopts it, so a
// private window opened while Tor is already running inherits the same policy.
let appliedSocksEndpoint = null;
let artiBootstrapped = false;
let artiOutputBuffer = '';
// Bumped by every start attempt and by every stop, so a start that is awaiting
// something (external-candidate prompt, port probe, SOCKS probe) can tell that
// it has been superseded and must not spawn/commit anything.
let startGeneration = 0;

/**
 * Resolve the bundled arti binary path. Dev layout mirrors radicle:
 *   dev:      <root>/arti-bin/<platform>-<arch>/arti
 *   packaged: <resources>/arti-bin/arti
 */
function getArtiBinaryPath() {
  const platformMap = { darwin: 'mac', linux: 'linux', win32: 'win' };
  const platform = platformMap[process.platform] || process.platform;
  const binName = process.platform === 'win32' ? 'arti.exe' : 'arti';

  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'arti-bin', binName);
  }
  return path.join(__dirname, '..', '..', 'arti-bin', `${platform}-${process.arch}`, binName);
}

/**
 * State/cache directory for Arti. Honors FREEDOM_TOR_DATA (tests / advanced
 * users), mirroring the Ant/IPFS/Radicle data-dir overrides. Created with
 * 0700 perms so Arti's filesystem-permission checks pass.
 */
function getTorDataPath() {
  const dir = getTorDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // chmod unconditionally: mkdirSync's mode is subject to the process umask,
  // and a pre-existing dir may have looser perms. Arti refuses to start if its
  // data dir is group/world-accessible.
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Non-fatal: on Windows chmod is a no-op and Arti's perm checks differ.
  }
  return dir;
}

function getProfileTorConfig() {
  return getActiveProfile()?.metadata?.nodes?.tor || null;
}

function getPromptWindowForEvent(event) {
  return BrowserWindow.fromWebContents?.(event?.sender)
    || BrowserWindow.getFocusedWindow?.()
    || BrowserWindow.getAllWindows?.()[0]
    || null;
}

function isManagedTorConfig(config = getProfileTorConfig()) {
  return config?.mode === 'managed';
}

function isExternalTorConfig(config = getProfileTorConfig()) {
  return config?.mode === 'external';
}

function isDisabledTorConfig(config = getProfileTorConfig()) {
  return config?.mode === 'disabled';
}

function hasUnknownTorMode(config) {
  return Boolean(config?.mode) && !isManagedTorConfig(config)
    && !isExternalTorConfig(config)
    && !isDisabledTorConfig(config);
}

function getConfiguredTorSocksPort(config = getProfileTorConfig()) {
  return Number.isInteger(config?.socksPort) ? config.socksPort : DEFAULTS.tor.socksPort;
}

function persistManagedTorPort(socksPort) {
  const result = updateActiveProfileNodeConfig('tor', { socksPort });
  if (result) {
    log.info('[Tor] Persisted managed profile SOCKS port:', socksPort);
  }
}

function setCurrentSocksEndpoint(endpoint) {
  currentSocksEndpoint = endpoint;
  currentSocksPort = parseSocksEndpoint(endpoint)?.port || null;
}

/**
 * Write an arti.toml that pins the SOCKS port and redirects state/cache into
 * our data dir, then return its path.
 */
function writeArtiConfig(dataDir, socksPort) {
  const stateDir = path.join(dataDir, 'state');
  const cacheDir = path.join(dataDir, 'cache');
  for (const d of [stateDir, cacheDir]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    // chmod unconditionally — same umask/pre-existing-dir rationale as the
    // parent data dir; Arti rejects group/world-accessible state/cache dirs.
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      // Non-fatal on Windows.
    }
  }
  // TOML strings need forward slashes even on Windows; JSON.stringify escapes safely.
  const toml = [
    '[proxy]',
    `socks_listen = ${socksPort}`,
    '',
    '[storage]',
    `cache_dir = ${JSON.stringify(cacheDir)}`,
    `state_dir = ${JSON.stringify(stateDir)}`,
    '',
    '[logging]',
    'console = "info"',
    '',
  ].join('\n');
  const configPath = path.join(dataDir, 'arti.toml');
  fs.writeFileSync(configPath, toml, 'utf-8');
  return configPath;
}

/**
 * Claim the current start generation. The returned predicate reports whether a
 * stopTor() (or a newer startTor()) landed while this attempt was awaiting; the
 * caller must then bail out without spawning arti or touching shared state,
 * otherwise we leak an untracked process the stop path can never kill.
 * @returns {() => boolean}
 */
function beginStartAttempt() {
  startGeneration += 1;
  const generation = startGeneration;
  return () => {
    if (startGeneration === generation) return false;
    log.info('[Tor] Start attempt superseded by a stop/restart; aborting');
    return true;
  };
}

function updateState(newState, error = null) {
  log.info('[Tor] State change:', currentState, '->', newState, error ? `(error: ${error})` : '');
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    try {
      win.webContents.send(IPC.TOR_STATUS_UPDATE, { status: currentState, error: lastError });
    } catch {
      // Window might be closing
    }
  }
}

/** Check if a port is open (something is listening). */
function isPortOpen(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(1000);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

/** Find an available port starting from the default. */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.tor.fallbackRange, options = {}) {
  const reservedPorts = options.reservedPorts || new Set();
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    if (reservedPorts.has(port)) {
      log.info(`[Tor] Port ${port} is reserved by another profile, trying next...`);
      continue;
    }
    const open = await isPortOpen(port);
    if (!open) return port;
    log.info(`[Tor] Port ${port} is busy, trying next...`);
  }
  return null;
}

/** External liveness: the configured endpoint accepts a TCP connection. */
async function checkHealth() {
  return probeTcpEndpoint(currentSocksEndpoint);
}

async function checkSocksProtocolHealth() {
  return probeSocks5Endpoint(currentSocksEndpoint);
}

function startHealthCheck(mode) {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  if (mode === MODE.BUNDLED) {
    // Managed Arti reports readiness through its bootstrap log, and process
    // exit is handled separately. Repeated synthetic SOCKS connections make
    // Arti log warnings, so avoid polling the managed listener.
    healthCheckInterval = null;
    return;
  }
  healthCheckInterval = setInterval(async () => {
    const healthy = await checkHealth();
    if (!healthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'SOCKS port unreachable');
      setErrorState('tor', 'Tor unreachable. Retrying…');
    } else if (healthy && currentState === STATUS.ERROR) {
      clearErrorState('tor');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

/**
 * Route `.onion` through `endpoint` on every tracked session. The endpoint is
 * recorded before the first apply so a session registered mid-flight adopts
 * the same policy (fail closed: an unreachable SOCKS port errors the request
 * instead of leaking the onion hostname to the system resolver).
 */
async function applyOnionRouting(endpoint) {
  appliedSocksEndpoint = endpoint;
  await Promise.all(
    [...proxySessions.values()].map((targetSession) => applyOnionProxy(targetSession, endpoint))
  );
}

/** Restore DIRECT `.onion` connections on every tracked session. */
async function clearOnionRouting() {
  appliedSocksEndpoint = null;
  await Promise.all(
    [...proxySessions.values()].map((targetSession) =>
      clearOnionProxy(targetSession).catch(() => {})
    )
  );
}

/**
 * Track a session that must follow the `.onion` routing policy — the default
 * session at start, and every private-window partition session for as long as
 * its window lives. Applies the current policy immediately, so a private
 * window opened while Tor runs never resolves `.onion` DIRECT.
 *
 * @param {string} key - DEFAULT_SESSION_KEY or a private partition name
 * @param {import('electron').Session} targetSession
 */
function registerOnionRoutingSession(key, targetSession) {
  if (!key || !targetSession) return;
  proxySessions.set(key, targetSession);
  if (!appliedSocksEndpoint) return;
  applyOnionProxy(targetSession, appliedSocksEndpoint).catch((err) => {
    log.error(`[Tor] Failed to apply .onion routing to session ${key}:`, err.message);
  });
}

/** Stop tracking a session (private window closed; its session is gone). */
function unregisterOnionRoutingSession(key) {
  proxySessions.delete(key);
}

async function applyTorProxy(mode, statusMessage, superseded = () => false) {
  try {
    await applyOnionRouting(currentSocksEndpoint);
  } catch (err) {
    if (superseded()) return false;
    log.error('[Tor] Failed to apply proxy:', err.message);
    updateState(STATUS.ERROR, 'Failed to apply Tor proxy');
    setStatusMessage('tor', 'Tor failed to start');
    return false;
  }

  if (superseded()) {
    // Stopped while the proxy was being applied: undo it instead of reporting
    // RUNNING for a service the user just turned off.
    clearOnionRouting().catch(() => {});
    return false;
  }

  updateService('tor', {
    socks: currentSocksEndpoint,
    mode,
  });
  setStatusMessage('tor', statusMessage);
  updateState(STATUS.RUNNING);
  startHealthCheck(mode);
  return true;
}

async function startExternalTor(config, superseded = () => false) {
  const endpoint = normalizeSocksEndpoint(config?.externalSocks);
  if (!endpoint) {
    updateState(STATUS.ERROR, 'External Tor SOCKS endpoint is not configured');
    setStatusMessage('tor', 'External Tor not configured');
    return;
  }

  setCurrentSocksEndpoint(endpoint);
  setStatusMessage('tor', 'Checking external SOCKS…');

  const healthy = await checkSocksProtocolHealth();
  if (superseded()) return;
  if (!healthy) {
    updateState(STATUS.ERROR, 'External Tor SOCKS endpoint is unreachable');
    setStatusMessage('tor', 'External Tor unreachable');
    return;
  }

  if (await applyTorProxy(MODE.EXTERNAL, `External SOCKS: ${currentSocksEndpoint}`, superseded)) {
    log.info('[Tor] Connected to external SOCKS at', currentSocksEndpoint);
  }
}

function startDisabledTor() {
  setCurrentSocksEndpoint(`127.0.0.1:${DEFAULTS.tor.socksPort}`);
  clearService('tor');
  updateService('tor', {
    socks: null,
    mode: MODE.DISABLED,
  });
  setStatusMessage('tor', 'Tor disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[Tor] Disabled for active profile');
}

function checkBinary() {
  return fs.existsSync(getArtiBinaryPath());
}

let cachedVersion = null;

/**
 * Read the bundled arti binary's version (`arti --version`). Cached after the
 * first successful read since the binary doesn't change at runtime.
 * @returns {Promise<{success: boolean, name?: string, version?: string}>}
 */
async function getArtiVersion() {
  if (cachedVersion) {
    return success({ name: 'Arti', version: cachedVersion });
  }
  const artiPath = getArtiBinaryPath();
  if (!fs.existsSync(artiPath)) {
    return failure('TOR_BINARY_NOT_FOUND', 'arti binary not found');
  }
  try {
    const { stdout, stderr } = await execFileAsync(artiPath, ['--version'], { timeout: 5000 });
    const out = `${stdout || ''}${stderr || ''}`.trim();
    // `arti --version` prints e.g. "arti 1.4.4"; fall back to raw output.
    const match = out.match(/(\d+\.\d+\.\d+[^\s]*)/);
    cachedVersion = match ? match[1] : out;
    return success({ name: 'Arti', version: cachedVersion });
  } catch (err) {
    log.warn('[Tor] version lookup failed:', err.message);
    return failure('TOR_VERSION_FAILED', err.message);
  }
}

function handleArtiLogLine(line) {
  if (/Sufficiently bootstrapped/i.test(line)) {
    artiBootstrapped = true;
    setStatusMessage('tor', 'Tor bootstrapped; opening SOCKS…');
  }
}

function handleArtiOutput(streamName, data) {
  const text = String(data || '');
  log.info(`[arti ${streamName}]: ${text}`);
  artiOutputBuffer += text;
  const lines = artiOutputBuffer.split(/\r?\n/);
  artiOutputBuffer = lines.pop() || '';
  for (const line of lines) {
    handleArtiLogLine(line);
  }

  // If a platform flushes without a trailing newline, still catch the readiness
  // marker. Keep the buffer so a split marker can complete on the next chunk.
  handleArtiLogLine(artiOutputBuffer);
}

/**
 * Start Arti as a SOCKS proxy and route `.onion` through it.
 * @param {object} [opts]
 * @param {import('electron').Session} [opts.targetSession] session to proxy
 */
async function startTor(opts = {}) {
  log.info('[Tor] startTor() called, currentState:', currentState);

  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Tor] Ignoring start request, current state: ${currentState}`);
    return;
  }
  if (currentState === STATUS.STOPPING) {
    log.info('[Tor] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  registerOnionRoutingSession(DEFAULT_SESSION_KEY, opts.targetSession || session.defaultSession);

  pendingStart = false;
  const superseded = beginStartAttempt();
  updateState(STATUS.STARTING);
  setStatusMessage('tor', 'Bootstrapping…');

  let profileConfig = getProfileTorConfig();
  let managedProfileNode = isManagedTorConfig(profileConfig);

  if (hasUnknownTorMode(profileConfig)) {
    updateState(STATUS.ERROR, `Unsupported Tor node mode: ${profileConfig.mode}`);
    setStatusMessage('tor', 'Tor failed to start');
    return;
  }

  if (managedProfileNode && opts.checkDefaultExternalCandidate === true) {
    await promptForDefaultExternalCandidateProtocol(getActiveProfile(), 'tor', {
      window: opts.promptWindow,
      logger: log,
    });
    if (superseded()) return;
    profileConfig = getProfileTorConfig();
    managedProfileNode = isManagedTorConfig(profileConfig);
  }

  if (isDisabledTorConfig(profileConfig)) {
    startDisabledTor();
    return;
  }

  if (isExternalTorConfig(profileConfig)) {
    await startExternalTor(profileConfig, superseded);
    return;
  }

  const artiPath = getArtiBinaryPath();
  if (!fs.existsSync(artiPath)) {
    updateState(STATUS.ERROR, `arti binary not found at ${artiPath}`);
    setStatusMessage('tor', 'Tor binary not found');
    return;
  }

  // Resolve a free SOCKS port (profile default, fall back if busy/reserved).
  let socksPort = getConfiguredTorSocksPort(profileConfig);
  const configuredSocksPort = socksPort;
  const reservedProfilePorts = managedProfileNode ? getReservedProfilePorts() : new Set();
  const configuredPortUnavailable =
    reservedProfilePorts.has(socksPort) || (await isPortOpen(socksPort));

  if (configuredPortUnavailable) {
    const next = await findAvailablePort(socksPort + 1, DEFAULTS.tor.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!next) {
      updateState(STATUS.ERROR, 'No available ports for Tor SOCKS proxy');
      setStatusMessage('tor', 'Tor failed to start');
      return;
    }
    socksPort = next;
  }

  // Port probing above is async: bail before persisting a port or spawning if a
  // stop landed in the meantime.
  if (superseded()) return;

  if (managedProfileNode && socksPort !== configuredSocksPort) {
    try {
      persistManagedTorPort(socksPort);
    } catch (err) {
      log.error('[Tor] Failed to persist managed profile SOCKS port:', err.message);
      updateState(STATUS.ERROR, 'Failed to save Tor port assignment');
      setStatusMessage('tor', 'Tor failed to start');
      return;
    }
  }

  setCurrentSocksEndpoint(`127.0.0.1:${socksPort}`);
  artiBootstrapped = false;
  artiOutputBuffer = '';

  let configPath;
  try {
    configPath = writeArtiConfig(getTorDataPath(), socksPort);
  } catch (err) {
    updateState(STATUS.ERROR, `Failed to write arti config: ${err.message}`);
    setStatusMessage('tor', 'Tor failed to start');
    return;
  }

  log.info(`[Tor] Starting arti: ${artiPath} proxy -c ${configPath} (SOCKS ${socksPort})`);
  try {
    artiProcess = spawn(artiPath, ['proxy', '-c', configPath], {
      env: { ...process.env },
    });
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('tor', 'Tor failed to start');
    return;
  }

  artiProcess.stdout.on('data', (data) => handleArtiOutput('stdout', data));
  artiProcess.stderr.on('data', (data) => handleArtiOutput('stderr', data));

  artiProcess.on('error', (err) => {
    log.error('[Tor] Failed to start process:', err);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('tor', 'Tor failed to start');
  });

  artiProcess.on('close', (code) => {
    log.info(`[Tor] arti process exited with code ${code}`);
    artiProcess = null;
    artiBootstrapped = false;
    artiOutputBuffer = '';
    if (forceKillTimeout) {
      clearTimeout(forceKillTimeout);
      forceKillTimeout = null;
    }
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    // The PAC is deliberately left in place here. Clearnet is DIRECT inside
    // the PAC, so a dead SOCKS port only affects `.onion` — and there the
    // fail-closed behaviour is the point: onion requests fail with a proxy
    // error instead of silently falling back to DIRECT, which would hand the
    // onion hostname to the system resolver. A deliberate stop (stopTor
    // without preserveOnionRouting) is the only path that restores DIRECT.
    if (pendingStopError) {
      // A startup timeout initiated this stop: report its message instead of
      // the raw arti exit code from the SIGTERM/SIGKILL that carried it out.
      const message = pendingStopError;
      pendingStopError = null;
      updateState(STATUS.ERROR, message);
      setErrorState('tor', 'Tor failed to start');
    } else if (currentState !== STATUS.STOPPING && code !== 0) {
      // Unexpected exit (crash / killed): surface it as an error and keep the
      // service entry so the menu shows a failure indication, rather than a
      // silent stop that looks identical to a clean shutdown.
      updateState(STATUS.ERROR, `arti exited with code ${code}`);
      setErrorState('tor', `Tor exited unexpectedly (code ${code})`);
    } else {
      updateState(STATUS.STOPPED);
      clearService('tor');
    }

    if (pendingStart) {
      pendingStart = false;
      setTimeout(() => startTor({ targetSession: proxySessions.get(DEFAULT_SESSION_KEY) }), 100);
    }
  });

  // Poll for the SOCKS endpoint to come up, then wait for Arti's bootstrap
  // marker before routing Chromium traffic through it.
  let attempts = 0;
  const maxAttempts = 120; // up to ~120s for first bootstrap
  const pollInterval = setInterval(async () => {
    if (
      superseded()
      || currentState === STATUS.STOPPED
      || currentState === STATUS.ERROR
      || !artiProcess
    ) {
      clearInterval(pollInterval);
      return;
    }
    if (artiBootstrapped) {
      clearInterval(pollInterval);
      await applyTorProxy(MODE.BUNDLED, `SOCKS: ${currentSocksEndpoint}`, superseded);
    } else {
      attempts++;
      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        // Flag the terminal error before stopTor() so the exit handler reports
        // it instead of the raw arti exit code from the kill it performs.
        pendingStopError = 'Startup timed out';
        setStatusMessage('tor', 'Tor failed to start');
        // Fail closed: a failed start must not hand `.onion` back to DIRECT
        // (a previous session may already be routing through the PAC).
        stopTor({ preserveOnionRouting: true });
      }
    }
  }, 1000);
}

/**
 * Stop Arti and restore direct connections. Resolves when the process exits.
 *
 * @param {object} [options]
 * @param {boolean} [options.preserveOnionRouting] keep the `.onion` PAC in
 *   place instead of restoring DIRECT. Failure paths (startup timeout) pass
 *   this: only a deliberate stop should make `.onion` resolvable without Tor.
 */
function stopTor(options = {}) {
  const preserveOnionRouting = options?.preserveOnionRouting === true;
  return new Promise((resolve) => {
    pendingStart = false;
    // Cancel any startTor() still sitting on an await, so it can't spawn arti
    // after we've reported the service as stopped.
    startGeneration += 1;

    const finish = () => {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (!preserveOnionRouting) clearOnionRouting().catch(() => {});
      clearService('tor');
      artiBootstrapped = false;
      artiOutputBuffer = '';
      resolve();
    };

    if (!artiProcess) {
      updateState(STATUS.STOPPED);
      finish();
      return;
    }

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    artiProcess.once('close', finish);

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (artiProcess) {
        log.warn('[Tor] Force killing arti...');
        artiProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 10000);

    artiProcess.kill('SIGTERM');
  });
}

function getActivePort() {
  return currentSocksPort;
}

function registerTorIpc() {
  log.info('[Tor] Registering IPC handlers');
  const torDisabledResponse = {
    status: STATUS.STOPPED,
    error: 'Tor integration is disabled. Enable it in Settings > Experimental',
  };
  const isTorEnabled = () => loadSettings().enableTorIntegration === true;

  ipcMain.handle(IPC.TOR_START, (event) => {
    if (!isTorEnabled()) {
      log.info('[Tor] IPC: start blocked, integration disabled');
      return torDisabledResponse;
    }
    log.info('[Tor] IPC: start requested');
    startTor({
      checkDefaultExternalCandidate: true,
      promptWindow: getPromptWindowForEvent(event),
    });
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.TOR_STOP, () => {
    log.info('[Tor] IPC: stop requested');
    stopTor();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.TOR_GET_STATUS, () => {
    if (!isTorEnabled()) return torDisabledResponse;
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.TOR_CHECK_BINARY, () => {
    const available = checkBinary();
    log.info('[Tor] IPC: checkBinary requested, available:', available);
    return { available };
  });

  ipcMain.handle(IPC.TOR_GET_VERSION, async () => {
    if (!isTorEnabled()) {
      return failure(
        'TOR_DISABLED',
        'Tor integration is disabled. Enable it in Settings > Experimental'
      );
    }
    return getArtiVersion();
  });
}

module.exports = {
  registerTorIpc,
  startTor,
  stopTor,
  registerOnionRoutingSession,
  unregisterOnionRoutingSession,
  getActivePort,
  getArtiVersion,
  getArtiBinaryPath,
  getTorDataPath,
  writeArtiConfig,
  checkBinary,
  STATUS,
};
