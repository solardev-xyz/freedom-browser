const log = require('./logger');
const { ipcMain, app, BrowserWindow } = require('electron');
const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');

const execFileAsync = promisify(execFile);
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { success, failure, validateNonEmptyString } = require('./ipc-contract');
const { loadSettings } = require('./settings-store');
const { getRadicleDataDir } = require('./profile-paths');
const seedStatus = require('./radicle/seed-status');
const {
  getActiveProfile,
  getReservedProfilePorts,
  updateActiveProfileNodeConfig,
} = require('./profile-resolver');
const {
  promptForDefaultExternalCandidateProtocol,
} = require('./profile-external-candidates');

/**
 * Validate a Radicle Repository ID (RID).
 * Valid RIDs start with 'z' followed by 20-60 base58 characters.
 * @param {string} rid - Raw RID (may include rad: or rad:// prefix)
 * @returns {string|null} Cleaned RID with rad: prefix, or null if invalid
 */
function validateAndNormalizeRid(rid) {
  if (!rid || typeof rid !== 'string') return null;

  // Strip rad:// or rad: prefix to get the bare ID
  let bare = rid;
  if (bare.startsWith('rad://')) bare = bare.slice(6);
  else if (bare.startsWith('rad:')) bare = bare.slice(4);

  // Validate: must start with z, followed by base58 chars (no 0, O, I, l)
  if (!/^z[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(bare)) {
    return null;
  }

  return `rad:${bare}`;
}
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');

// Radicle community seed nodes for peer discovery
const PREFERRED_SEEDS = [
  'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.network:8776',
  'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.network:8776',
  // iris/rosa have been observed resetting handshakes network-wide
  // (July 2026); seed.radicle.xyz has been consistently reliable.
  'z6MksmpU5b1dS7oaqF2bHXhQi1DWy2hB7Mh9CuN7y1DN6QSz@seed.radicle.xyz:8776',
];
const LEGACY_SEED_REPLACEMENTS = new Map([
  ['iris.radicle.xyz', 'iris.radicle.network'],
  ['rosa.radicle.xyz', 'rosa.radicle.network'],
]);

// Canonical Freedom Browser repo — bundled nodes auto-seed this
const FREEDOM_BROWSER_RID = 'rad:z3QXuMvMmSeEX3ZgoUidZC1v5MkKE';

// States
const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let radicleNodeProcess = null;
let radicleHttpdProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;
// Set by a startup-timeout before it calls stopRadicle(), so the coordinated
// shutdown keeps running under STOPPING (force-kill backstop intact, close
// handlers taking the clean path) and finalizeStopped() reports the terminal
// state as ERROR with this message instead of a plain STOPPED. Consumed once.
let pendingStopError = null;
// Timestamp (ms since epoch) of the most recent transition into RUNNING. Used by
// getConnections to suppress transient `rad node status` errors while the node
// is still bootstrapping its control socket.
let runningSinceMs = null;
// Grace period during which getConnections treats command failures as a silent
// zero-peer count instead of logging a warning.
const CONNECTIONS_STARTUP_GRACE_MS = 30_000;

// Identity injection flag - when true, skip rad auth and use pre-injected identity
let useInjectedIdentity = false;

// Port configuration
let currentHttpPort = DEFAULTS.radicle.httpPort;
let currentP2pPort = DEFAULTS.radicle.p2pPort;
let currentHttpUrl = `http://127.0.0.1:${DEFAULTS.radicle.httpPort}`;
let currentMode = MODE.NONE;
let activeRadHome = null;
// Bumped by every start attempt and by every stop, so a start that is awaiting
// something (external-candidate prompt, node detection, port probe) can tell it
// has been superseded and must not spawn/commit anything.
let startGeneration = 0;

/**
 * Claim the current start generation. The returned predicate reports whether a
 * stopRadicle() (or a newer startRadicle()) landed while this attempt was
 * awaiting; the caller must then bail out without spawning processes or
 * committing state, otherwise we leak processes the stop path can never kill.
 * @returns {() => boolean}
 */
function beginStartAttempt() {
  startGeneration += 1;
  const generation = startGeneration;
  return () => {
    if (startGeneration === generation) return false;
    log.info('[Radicle] Start attempt superseded by a stop/restart; aborting');
    return true;
  };
}

/**
 * Terminal bookkeeping for a stopped Radicle: report the state, drop the
 * service entry and run any start queued while we were stopping. The managed
 * mode runs two processes and may never get as far as spawning httpd, so both
 * the httpd close handler and stopRadicle() route through here - otherwise a
 * stop that lands before httpd exists strands the state in 'stopping' and
 * leaves pendingStart with nothing to consume it.
 */
function finalizeStopped(error = null) {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  // A startup timeout that routed through stopRadicle() wants the terminal
  // state to read as an error, not a clean stop. Consume the flag here — the
  // one place guaranteed to run once every process has exited.
  if (pendingStopError) {
    const message = pendingStopError;
    pendingStopError = null;
    updateState(STATUS.ERROR, message);
    clearService('radicle');
    if (pendingStart) {
      log.info('[Radicle] Processing queued start request');
      pendingStart = false;
      setTimeout(() => startRadicle(), 100);
    }
    return;
  }
  updateState(STATUS.STOPPED, error);
  clearService('radicle');

  if (pendingStart) {
    log.info('[Radicle] Processing queued start request');
    pendingStart = false;
    setTimeout(() => startRadicle(), 100);
  }
}

function getRadicleBinaryPath(binary) {
  const arch = process.arch;

  // Map Node.js platform names to our folder names
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  // In dev, radicle-bin is at project root (../../ from src/main)
  let basePath = path.join(__dirname, '..', '..', 'radicle-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'radicle-bin');
    const binName = process.platform === 'win32' ? `${binary}.exe` : binary;
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? `${binary}.exe` : binary;
  return path.join(basePath, `${platform}-${arch}`, binName);
}

function getRadicleDataPath() {
  return getRadicleDataDir();
}

function getProfileRadicleConfig() {
  return getActiveProfile()?.metadata?.nodes?.radicle || null;
}

function getPromptWindowForEvent(event) {
  return BrowserWindow.fromWebContents?.(event?.sender)
    || BrowserWindow.getFocusedWindow?.()
    || BrowserWindow.getAllWindows?.()[0]
    || null;
}

function isManagedRadicleConfig(config = getProfileRadicleConfig()) {
  return config?.mode === 'managed';
}

function isExternalRadicleConfig(config = getProfileRadicleConfig()) {
  return config?.mode === 'external';
}

function isDisabledRadicleConfig(config = getProfileRadicleConfig()) {
  return config?.mode === 'disabled';
}

function hasUnknownRadicleMode(config) {
  return (
    Boolean(config?.mode) &&
    !isManagedRadicleConfig(config) &&
    !isExternalRadicleConfig(config) &&
    !isDisabledRadicleConfig(config)
  );
}

function getConfiguredRadicleHttpPort(config = getProfileRadicleConfig()) {
  return Number.isInteger(config?.httpPort) ? config.httpPort : DEFAULTS.radicle.httpPort;
}

function getConfiguredRadicleP2pPort(config = getProfileRadicleConfig()) {
  return Number.isInteger(config?.p2pPort) ? config.p2pPort : DEFAULTS.radicle.p2pPort;
}

function normalizeExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    parsed.hash = '';
    parsed.search = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function getPortFromUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.port) return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return null;
  }
}

function getEndpointLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function getHttpClient(rawUrl) {
  return rawUrl.startsWith('https:') ? https : http;
}

function persistManagedRadiclePorts(httpPort, p2pPort) {
  const result = updateActiveProfileNodeConfig('radicle', { httpPort, p2pPort });
  if (result) {
    log.info('[Radicle] Persisted managed profile ports:', {
      httpPort,
      p2pPort,
    });
  }
}

function getRadicleSocketPath(radHome) {
  return path.join(radHome, 'node', 'control.sock');
}

/**
 * Clean up stale socket from previous unclean shutdown
 */
function cleanupStaleSocket(radHome) {
  const socketPath = getRadicleSocketPath(radHome);
  if (fs.existsSync(socketPath)) {
    log.info('[Radicle] Removing stale control.sock from previous unclean shutdown');
    try {
      fs.unlinkSync(socketPath);
    } catch (err) {
      log.warn('[Radicle] Failed to remove stale socket:', err.message);
    }
  }
}

function normalizeSeedAddress(seed) {
  if (typeof seed !== 'string') return null;

  let normalized = seed;
  for (const [legacyHost, currentHost] of LEGACY_SEED_REPLACEMENTS) {
    normalized = normalized.replace(`@${legacyHost}:`, `@${currentHost}:`);
  }
  return normalized;
}

function normalizePreferredSeeds(seeds) {
  // An explicitly-set list is respected as-is (an empty array is a
  // deliberate isolation choice — e2e fixtures, air-gapped setups);
  // legacy hostnames are still migrated. Defaults apply only when the
  // config has no preferredSeeds key at all.
  if (!Array.isArray(seeds)) return [...PREFERRED_SEEDS];

  const normalized = [...new Set(seeds.map(normalizeSeedAddress).filter(Boolean))];

  // Migration: configs written before seed.radicle.xyz joined the
  // defaults contain exactly the old default pair (the merge code wrote
  // it into every profile) — that's provably not a user choice, so
  // upgrade it. Any other list is user intent and stays untouched.
  const oldDefaults = PREFERRED_SEEDS.slice(0, 2);
  const isOldDefaultSet =
    normalized.length === oldDefaults.length &&
    oldDefaults.every((seed) => normalized.includes(seed));
  return isOldDefaultSet ? [...PREFERRED_SEEDS] : normalized;
}

/**
 * Ensure config.json contains preferredSeeds for peer discovery.
 * Merges seeds into an existing config or creates a new one.
 */
function ensureConfig(radHome, p2pPort = getConfiguredRadicleP2pPort()) {
  const configPath = path.join(radHome, 'config.json');
  let config = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      log.warn('[Radicle] Could not parse config.json, recreating:', err.message);
    }
  }

  config.preferredSeeds = normalizePreferredSeeds(config.preferredSeeds);

  config.node = config.node || {};
  config.node.alias = config.node.alias || 'FreedomBrowser';
  config.node.listen = [`0.0.0.0:${p2pPort}`];

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log.info('[Radicle] Config updated with preferredSeeds and P2P port:', p2pPort);
}

/**
 * Check if Radicle identity exists, create if not
 */
function ensureIdentity(radHome, p2pPort = getConfiguredRadicleP2pPort()) {
  const keysDir = path.join(radHome, 'keys');
  const privateKeyPath = path.join(keysDir, 'radicle');

  if (fs.existsSync(privateKeyPath)) {
    log.info('[Radicle] Identity already exists (injected or created)');
    ensureConfig(radHome, p2pPort);
    return true;
  }

  // Check if we should wait for identity injection
  if (useInjectedIdentity) {
    log.info('[Radicle] Waiting for identity injection (useInjectedIdentity=true)');
    return false;
  }

  const radPath = getRadicleBinaryPath('rad');
  if (!fs.existsSync(radPath)) {
    log.error('[Radicle] rad binary not found for identity creation');
    return false;
  }

  try {
    log.info('[Radicle] Creating identity with rad auth...');
    // Use empty passphrase for non-interactive creation
    // Note: alias cannot contain spaces or control characters
    execFileSync(radPath, ['auth', '--alias', 'FreedomBrowser'], {
      env: {
        ...process.env,
        RAD_HOME: radHome,
        RAD_PASSPHRASE: '',
      },
      stdio: 'pipe',
    });
    log.info('[Radicle] Identity created successfully');
    ensureConfig(radHome, p2pPort);
    return true;
  } catch (err) {
    log.error('[Radicle] Failed to create identity:', err.message);
    return false;
  }
}

function updateState(newState, error = null) {
  log.info(
    '[Radicle] State change:',
    currentState,
    '->',
    newState,
    error ? `(error: ${error})` : ''
  );
  if (newState === STATUS.RUNNING && currentState !== STATUS.RUNNING) {
    runningSinceMs = Date.now();
  } else if (newState !== STATUS.RUNNING) {
    runningSinceMs = null;
  }
  currentState = newState;
  lastError = error;
  // Broadcast to all windows
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.RADICLE_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

/**
 * Check if a port is open (something is listening)
 */
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

/**
 * Wait for Unix socket to exist
 */
function waitForSocket(socketPath, timeout = 30000, shouldAbort = () => false) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      // A stop can land mid-wait; give up straight away instead of holding the
      // start open (and reporting a bogus failure) for the full timeout.
      if (shouldAbort()) {
        reject(new Error('Socket wait aborted'));
        return;
      }

      if (fs.existsSync(socketPath)) {
        resolve(true);
        return;
      }

      if (Date.now() - startTime > timeout) {
        reject(new Error('Socket wait timed out'));
        return;
      }

      setTimeout(check, 200);
    };

    check();
  });
}

/**
 * Probe Radicle httpd health endpoint
 * Note: radicle-httpd 0.23+ uses / as the root endpoint (not /api/v1/)
 */
function probeRadicleApiUrl(apiUrl) {
  return new Promise((resolve) => {
    const req = getHttpClient(apiUrl).get(`${apiUrl}/`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ valid: true, data: parsed });
          } catch {
            // httpd may return non-JSON, but 200 means it's running
            resolve({ valid: true, data: {} });
          }
        });
      } else {
        resolve({ valid: false });
        res.resume();
      }
    });

    req.on('error', () => resolve({ valid: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ valid: false });
    });
    req.end();
  });
}

function probeRadicleApi(port) {
  return probeRadicleApiUrl(`http://127.0.0.1:${port}`);
}

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(
  defaultPort,
  maxAttempts = DEFAULTS.radicle.fallbackRange,
  options = {}
) {
  const reservedPorts = options.reservedPorts || new Set();
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    if (reservedPorts.has(port)) {
      log.info(`[Radicle] Port ${port} is reserved by another profile, trying next...`);
      continue;
    }
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[Radicle] Port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Detect if an existing Radicle httpd is running and reusable
 */
async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.radicle.httpPort;

  // Check if anything is on the default HTTP port
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) {
    return { found: false };
  }

  // Probe to see if it's actually Radicle httpd
  const probe = await probeRadicleApi(defaultPort);
  if (probe.valid) {
    log.info('[Radicle] Found existing httpd on port', defaultPort);
    return {
      found: true,
      port: defaultPort,
      version: probe.data?.version,
    };
  }

  // Port is open but not Radicle - conflict
  log.info('[Radicle] Port', defaultPort, 'is busy (not Radicle httpd)');
  return { found: false, conflict: true, port: defaultPort };
}

/**
 * Detect if a system-wide radicle-node is already running (~/.radicle).
 * The control socket is the definitive indicator — the node may not bind
 * the P2P port (e.g. when started with --force or custom config).
 */
function detectSystemNode() {
  const systemRadHome = path.join(os.homedir(), '.radicle');
  const socketPath = getRadicleSocketPath(systemRadHome);

  if (!fs.existsSync(socketPath)) {
    return { found: false };
  }

  log.info('[Radicle] Detected system radicle-node at', systemRadHome);
  return { found: true, radHome: systemRadHome, socketPath };
}

/**
 * Return the active RAD_HOME.
 *
 * NOTE: For catalog-managed profiles this may be the short app-owned Radicle
 * home from profile-paths (`R/<slot>`), not `<profile>/radicle-data`. This is
 * deliberate: radicle-node creates `$RAD_HOME/node/control.sock`, and macOS /
 * Linux reject long Unix socket paths before the node can finish booting.
 */
function getActiveRadHome() {
  return activeRadHome || getRadicleDataPath();
}

async function checkHealth() {
  return new Promise((resolve) => {
    // Note: radicle-httpd 0.23+ uses / as the root endpoint (not /api/v1/)
    const req = getHttpClient(currentHttpUrl).get(
      `${currentHttpUrl}/`,
      { timeout: 2000 },
      (res) => {
        if (res.statusCode === 200) {
          resolve(true);
        } else {
          resolve(false);
        }
        res.resume();
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(async () => {
    const isHealthy = await checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'Health check failed');
      setErrorState('radicle', 'Node unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      // Recovered - clear error state
      clearErrorState('radicle');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startExternalRadicle(config, superseded = () => false) {
  const httpUrl = normalizeExternalUrl(config?.externalHttp);
  if (!httpUrl) {
    updateState(STATUS.ERROR, 'External Radicle HTTP endpoint is not configured');
    setStatusMessage('radicle', 'External node not configured');
    return;
  }

  const probe = await probeRadicleApiUrl(httpUrl);
  if (superseded()) return;
  if (!probe.valid) {
    updateState(STATUS.ERROR, 'External Radicle HTTP endpoint is unreachable');
    setStatusMessage('radicle', 'External node unreachable');
    return;
  }

  activeRadHome = null;
  currentHttpUrl = httpUrl;
  currentHttpPort = getPortFromUrl(httpUrl);
  currentMode = MODE.EXTERNAL;

  updateService('radicle', {
    api: currentHttpUrl,
    gateway: currentHttpUrl,
    mode: MODE.EXTERNAL,
  });
  setStatusMessage('radicle', `External node: ${getEndpointLabel(currentHttpUrl)}`);

  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info('[Radicle] Connected to external httpd at', currentHttpUrl);
}

function startDisabledRadicle() {
  activeRadHome = null;
  currentHttpPort = null;
  currentHttpUrl = null;
  currentMode = MODE.DISABLED;
  updateService('radicle', {
    api: null,
    gateway: null,
    mode: MODE.DISABLED,
  });
  setStatusMessage('radicle', 'Node disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[Radicle] Disabled for active profile');
}

/**
 * Auto-seed default repositories on the bundled node.
 * Runs in the background after the node is healthy — failures are non-fatal.
 */
async function autoSeedDefaults() {
  const radBinPath = getRadicleBinaryPath('rad');
  const dataDir = getActiveRadHome();

  try {
    await execFileAsync(radBinPath, ['seed', FREEDOM_BROWSER_RID], {
      env: {
        ...process.env,
        RAD_HOME: dataDir,
        RAD_PASSPHRASE: '',
      },
      timeout: 120000,
    });
    log.info(`[Radicle] Auto-seeded ${FREEDOM_BROWSER_RID}`);
  } catch (err) {
    // "already tracking" is expected on subsequent starts
    const stderr = err.stderr?.toString() || '';
    if (stderr.includes('already tracking')) {
      log.info(`[Radicle] Already seeding ${FREEDOM_BROWSER_RID}`);
    } else {
      log.warn(`[Radicle] Auto-seed failed for ${FREEDOM_BROWSER_RID}:`, err.message);
    }
  }
}

async function startRadicle(opts = {}) {
  log.info('[Radicle] startRadicle() called, currentState:', currentState);

  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Radicle] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[Radicle] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  const superseded = beginStartAttempt();
  updateState(STATUS.STARTING);

  let profileConfig = getProfileRadicleConfig();
  let managedProfileNode = isManagedRadicleConfig(profileConfig);

  if (hasUnknownRadicleMode(profileConfig)) {
    updateState(STATUS.ERROR, `Unsupported Radicle node mode: ${profileConfig.mode}`);
    setStatusMessage('radicle', 'Node failed to start');
    return;
  }

  if (managedProfileNode && opts.checkDefaultExternalCandidate === true) {
    await promptForDefaultExternalCandidateProtocol(getActiveProfile(), 'radicle', {
      window: opts.promptWindow,
      logger: log,
    });
    if (superseded()) return;
    profileConfig = getProfileRadicleConfig();
    managedProfileNode = isManagedRadicleConfig(profileConfig);
  }

  if (isDisabledRadicleConfig(profileConfig)) {
    startDisabledRadicle();
    return;
  }

  if (isExternalRadicleConfig(profileConfig)) {
    await startExternalRadicle(profileConfig, superseded);
    return;
  }

  // Step 0: Detect system-wide radicle-node (~/.radicle)
  const systemNode = managedProfileNode ? { found: false } : await detectSystemNode();
  if (superseded()) return;

  if (systemNode.found) {
    activeRadHome = systemNode.radHome;

    // Start only radicle-httpd against the system node
    const httpdBinPath = getRadicleBinaryPath('radicle-httpd');
    if (!fs.existsSync(httpdBinPath)) {
      updateState(STATUS.ERROR, `radicle-httpd binary not found at ${httpdBinPath}`);
      setStatusMessage('radicle', 'Node failed to start');
      return;
    }

    // Find an available HTTP port
    let httpPort = DEFAULTS.radicle.httpPort;
    const portBusy = await isPortOpen(httpPort);
    if (superseded()) return;
    if (portBusy) {
      // Check if it's already a working httpd we can reuse
      const probe = await probeRadicleApi(httpPort);
      if (superseded()) return;
      if (probe.valid) {
        currentHttpPort = httpPort;
        currentHttpUrl = `http://127.0.0.1:${currentHttpPort}`;
        currentMode = MODE.REUSED;
        updateService('radicle', {
          api: currentHttpUrl,
          gateway: currentHttpUrl,
          mode: MODE.REUSED,
        });
        setStatusMessage('radicle', `System node: localhost:${currentHttpPort}`);
        updateState(STATUS.RUNNING);
        startHealthCheck();
        log.info('[Radicle] Reusing system node + existing httpd on port', currentHttpPort);
        return;
      }
      // Port busy but not httpd — find another
      const newPort = await findAvailablePort(httpPort + 1);
      if (superseded()) return;
      if (!newPort) {
        updateState(STATUS.ERROR, 'No available ports for Radicle httpd');
        setStatusMessage('radicle', 'Node failed to start');
        return;
      }
      httpPort = newPort;
    }

    currentHttpPort = httpPort;
    currentHttpUrl = `http://127.0.0.1:${currentHttpPort}`;
    currentMode = MODE.REUSED;

    log.info(`[Radicle] Starting httpd against system node: ${httpdBinPath} on port ${httpPort}`);
    radicleHttpdProcess = spawn(httpdBinPath, ['--listen', `127.0.0.1:${httpPort}`], {
      env: {
        ...process.env,
        RAD_HOME: activeRadHome,
        RAD_PASSPHRASE: '',
      },
    });

    radicleHttpdProcess.stdout.on('data', (data) => {
      log.info(`[Radicle-httpd stdout]: ${data}`);
    });

    radicleHttpdProcess.stderr.on('data', (data) => {
      log.error(`[Radicle-httpd stderr]: ${data}`);
    });

    radicleHttpdProcess.on('close', (code) => {
      log.info(`[Radicle-httpd] Process exited with code ${code}`);
      radicleHttpdProcess = null;

      if (currentState === STATUS.STOPPING) {
        // stopRadicle() is coordinating this shutdown and the node may still be
        // exiting: leave its force-kill timer armed and let it finalize once
        // every process is gone.
        return;
      }

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      finalizeStopped(code !== 0 ? `httpd exited with code ${code}` : null);
    });

    radicleHttpdProcess.on('error', (err) => {
      log.error('[Radicle-httpd] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('radicle', 'Node failed to start');
    });

    // Poll for httpd health
    let attempts = 0;
    const maxAttempts = 60;
    const pollInterval = setInterval(async () => {
      if (superseded() || currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }

      const isHealthy = await checkHealth();
      if (isHealthy) {
        clearInterval(pollInterval);
        updateService('radicle', {
          api: currentHttpUrl,
          gateway: currentHttpUrl,
          mode: MODE.REUSED,
        });
        setStatusMessage('radicle', `System node: localhost:${currentHttpPort}`);
        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          // Flag the terminal state BEFORE stopRadicle(): the coordinated
          // shutdown must run under STOPPING (backstop intact so a
          // SIGTERM-ignoring node is still SIGKILLed; a concurrent start is
          // queued, not run) and finalizeStopped() surfaces this as the error.
          pendingStopError = 'Startup timed out';
          setStatusMessage('radicle', 'Node failed to start');
          stopRadicle();
        }
      }
    }, 1000);

    return;
  }

  const radicleDataPath = getRadicleDataPath();

  // Step 1: Legacy/profile-dir launches may still opt into a system httpd.
  const existing = managedProfileNode ? { found: false } : await detectExistingDaemon();
  if (superseded()) return;

  if (existing.found) {
    // Reuse existing daemon
    currentHttpPort = existing.port;
    currentHttpUrl = `http://127.0.0.1:${currentHttpPort}`;
    currentMode = MODE.REUSED;

    updateService('radicle', {
      api: currentHttpUrl,
      gateway: currentHttpUrl,
      mode: MODE.REUSED,
    });
    setStatusMessage('radicle', `Node: localhost:${currentHttpPort}`);

    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[Radicle] Reusing existing httpd on port', currentHttpPort);
    return;
  }

  // Step 2: Check binaries exist
  const nodeBinPath = getRadicleBinaryPath('radicle-node');
  const httpdBinPath = getRadicleBinaryPath('radicle-httpd');

  if (!fs.existsSync(nodeBinPath)) {
    updateState(STATUS.ERROR, `radicle-node binary not found at ${nodeBinPath}`);
    setStatusMessage('radicle', 'Node failed to start');
    return;
  }

  if (!fs.existsSync(httpdBinPath)) {
    updateState(STATUS.ERROR, `radicle-httpd binary not found at ${httpdBinPath}`);
    setStatusMessage('radicle', 'Node failed to start');
    return;
  }

  // Step 3: Resolve ports (handle conflicts)
  let httpPort = getConfiguredRadicleHttpPort(profileConfig);
  let p2pPort = getConfiguredRadicleP2pPort(profileConfig);
  const configuredHttpPort = httpPort;
  const configuredP2pPort = p2pPort;
  let usingFallbackPort = false;
  const reservedProfilePorts = managedProfileNode ? getReservedProfilePorts() : new Set();

  const managedHttpPortBusy = managedProfileNode ? await isPortOpen(httpPort) : false;
  if (existing.conflict || managedHttpPortBusy) {
    const newHttpPort = await findAvailablePort(httpPort + 1, DEFAULTS.radicle.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!newHttpPort) {
      updateState(STATUS.ERROR, 'No available ports for Radicle httpd');
      setStatusMessage('radicle', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    httpPort = newHttpPort;
  }

  const managedP2pPortBusy = managedProfileNode ? await isPortOpen(p2pPort) : false;
  if (managedP2pPortBusy) {
    const newP2pPort = await findAvailablePort(p2pPort + 1, DEFAULTS.radicle.fallbackRange, {
      reservedPorts: reservedProfilePorts,
    });
    if (!newP2pPort) {
      updateState(STATUS.ERROR, 'No available ports for Radicle P2P');
      setStatusMessage('radicle', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    p2pPort = newP2pPort;
  }

  // Port probing above is async: bail before persisting ports or spawning if a
  // stop landed in the meantime.
  if (superseded()) return;

  if (
    managedProfileNode
    && (httpPort !== configuredHttpPort || p2pPort !== configuredP2pPort)
  ) {
    try {
      persistManagedRadiclePorts(httpPort, p2pPort);
    } catch (err) {
      log.error('[Radicle] Failed to persist managed profile ports:', err.message);
      updateState(STATUS.ERROR, 'Failed to save Radicle port assignment');
      setStatusMessage('radicle', 'Node failed to start');
      return;
    }
  }

  currentHttpPort = httpPort;
  currentP2pPort = p2pPort;
  currentHttpUrl = `http://127.0.0.1:${currentHttpPort}`;
  currentMode = MODE.BUNDLED;

  const radHome = radicleDataPath;
  activeRadHome = radHome;

  // Step 4: Ensure identity exists and config has the selected P2P port
  if (!ensureIdentity(radHome, p2pPort)) {
    updateState(STATUS.ERROR, 'Failed to create Radicle identity');
    setStatusMessage('radicle', 'Node failed to start');
    return;
  }

  const socketPath = getRadicleSocketPath(radHome);

  // Step 5: Clean up any stale socket from previous unclean shutdown
  cleanupStaleSocket(radHome);

  // Step 6: Start radicle-node
  log.info(`[Radicle] Starting node: ${nodeBinPath} with P2P port ${currentP2pPort}`);

  try {
    radicleNodeProcess = spawn(nodeBinPath, [], {
      env: {
        ...process.env,
        RAD_HOME: radHome,
        RAD_PASSPHRASE: '',
      },
    });

    radicleNodeProcess.stdout.on('data', (data) => {
      log.info(`[Radicle-node stdout]: ${data}`);
      seedStatus.noteNodeOutput(String(data));
    });

    radicleNodeProcess.stderr.on('data', (data) => {
      log.error(`[Radicle-node stderr]: ${data}`);
      seedStatus.noteNodeOutput(String(data));
    });

    radicleNodeProcess.on('close', (code) => {
      log.info(`[Radicle-node] Process exited with code ${code}`);
      radicleNodeProcess = null;

      // If httpd is still running, stop it too
      if (radicleHttpdProcess) {
        radicleHttpdProcess.kill('SIGTERM');
      }
    });

    radicleNodeProcess.on('error', (err) => {
      log.error('[Radicle-node] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('radicle', 'Node failed to start');
    });

    // Step 7: Wait for socket to appear
    log.info('[Radicle] Waiting for node socket...');
    try {
      await waitForSocket(socketPath, 30000, superseded);
      log.info('[Radicle] Node socket ready');
    } catch (err) {
      if (superseded()) {
        // Stopped while waiting for the socket: the stop path owns the shutdown
        // (and its terminal state), so bail without reporting a failure.
        if (radicleNodeProcess) radicleNodeProcess.kill('SIGTERM');
        return;
      }
      log.error('[Radicle] Socket wait failed:', err.message);
      if (radicleNodeProcess) {
        radicleNodeProcess.kill('SIGTERM');
      }
      updateState(STATUS.ERROR, 'Node socket never appeared');
      setStatusMessage('radicle', 'Node failed to start');
      return;
    }

    if (superseded()) {
      // Stopped while waiting for the socket: don't add an httpd on top of a
      // node the stop path may already have killed.
      if (radicleNodeProcess) radicleNodeProcess.kill('SIGTERM');
      return;
    }

    // Step 8: Start radicle-httpd
    log.info(`[Radicle] Starting httpd: ${httpdBinPath} on port ${httpPort}`);

    radicleHttpdProcess = spawn(httpdBinPath, ['--listen', `127.0.0.1:${httpPort}`], {
      env: {
        ...process.env,
        RAD_HOME: radHome,
        RAD_PASSPHRASE: '',
      },
    });

    radicleHttpdProcess.stdout.on('data', (data) => {
      log.info(`[Radicle-httpd stdout]: ${data}`);
    });

    radicleHttpdProcess.stderr.on('data', (data) => {
      log.error(`[Radicle-httpd stderr]: ${data}`);
    });

    radicleHttpdProcess.on('close', (code) => {
      log.info(`[Radicle-httpd] Process exited with code ${code}`);
      radicleHttpdProcess = null;

      if (currentState === STATUS.STOPPING) {
        // stopRadicle() is coordinating this shutdown and the node may still be
        // exiting: leave its force-kill timer armed and let it finalize once
        // every process is gone.
        return;
      }

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      finalizeStopped(code !== 0 ? `httpd exited with code ${code}` : null);
    });

    radicleHttpdProcess.on('error', (err) => {
      log.error('[Radicle-httpd] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('radicle', 'Node failed to start');
    });

    // Step 9: Poll for health until running
    let attempts = 0;
    const maxAttempts = 60;
    const pollInterval = setInterval(async () => {
      if (superseded() || currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }

      const isHealthy = await checkHealth();
      if (isHealthy) {
        clearInterval(pollInterval);

        updateService('radicle', {
          api: currentHttpUrl,
          gateway: currentHttpUrl,
          mode: MODE.BUNDLED,
        });

        if (usingFallbackPort) {
          setStatusMessage('radicle', `Fallback Port: ${currentHttpPort}`);
        } else {
          setStatusMessage('radicle', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
        autoSeedDefaults();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          // Flag the terminal state BEFORE stopRadicle(): the coordinated
          // shutdown must run under STOPPING (backstop intact so a
          // SIGTERM-ignoring node is still SIGKILLed; a concurrent start is
          // queued, not run) and finalizeStopped() surfaces this as the error.
          pendingStopError = 'Startup timed out';
          setStatusMessage('radicle', 'Node failed to start');
          stopRadicle();
        }
      }
    }, 1000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('radicle', 'Node failed to start');
  }
}

// Stop Radicle and return a Promise that resolves when processes exit
function stopRadicle() {
  return new Promise((resolve) => {
    pendingStart = false;
    // Cancel any startRadicle() still sitting on an await, so it can't spawn
    // processes after we've reported the service as stopped.
    startGeneration += 1;
    const stopGeneration = startGeneration;
    // A start queued during this stop (pendingStart) begins its own attempt and
    // bumps the generation; don't let our late process exits clobber its state.
    const supersededByNewStart = () => startGeneration !== stopGeneration;

    // If we reused a node, stop only the httpd process this app started.
    if (currentMode === MODE.REUSED) {
      if (radicleHttpdProcess) {
        // We spawned httpd against the system node — kill it
        radicleHttpdProcess.once('close', () => {
          if (forceKillTimeout) {
            clearTimeout(forceKillTimeout);
            forceKillTimeout = null;
          }
          currentMode = MODE.NONE;
          activeRadHome = null;
          if (!supersededByNewStart()) finalizeStopped();
          resolve();
        });
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        forceKillTimeout = setTimeout(() => {
          if (radicleHttpdProcess) {
            log.warn('[Radicle] Force killing reused-mode httpd...');
            radicleHttpdProcess.kill('SIGKILL');
          }
          forceKillTimeout = null;
        }, 5000);
        radicleHttpdProcess.kill('SIGTERM');
        return;
      }
      // No httpd process (fully reused) — just clear state.
      currentMode = MODE.NONE;
      activeRadHome = null;
      finalizeStopped();
      resolve();
      return;
    }

    if (currentMode === MODE.EXTERNAL || currentMode === MODE.DISABLED) {
      currentMode = MODE.NONE;
      activeRadHome = null;
      finalizeStopped();
      resolve();
      return;
    }

    if (!radicleHttpdProcess && !radicleNodeProcess) {
      finalizeStopped();
      resolve();
      return;
    }

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    let processesExited = 0;
    const totalProcesses = (radicleHttpdProcess ? 1 : 0) + (radicleNodeProcess ? 1 : 0);

    const checkDone = () => {
      processesExited++;
      if (processesExited >= totalProcesses) {
        if (forceKillTimeout) {
          clearTimeout(forceKillTimeout);
          forceKillTimeout = null;
        }
        activeRadHome = null;
        // Every process this stop was waiting for is gone. httpd may never have
        // been spawned (a stop landing during the node's socket wait), so this
        // is the only place guaranteed to run: report the terminal state here.
        if (!supersededByNewStart()) finalizeStopped();
        resolve();
      }
    };

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (radicleHttpdProcess) {
        log.warn('[Radicle] Force killing httpd...');
        radicleHttpdProcess.kill('SIGKILL');
      }
      if (radicleNodeProcess) {
        log.warn('[Radicle] Force killing node...');
        radicleNodeProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 10000);

    // Stop httpd first
    if (radicleHttpdProcess) {
      radicleHttpdProcess.once('close', checkDone);
      radicleHttpdProcess.kill('SIGTERM');
    }

    // Stop node after a brief delay
    if (radicleNodeProcess) {
      setTimeout(() => {
        if (radicleNodeProcess) {
          radicleNodeProcess.once('close', checkDone);
          radicleNodeProcess.kill('SIGTERM');
        } else {
          checkDone();
        }
      }, 500);
    }
  });
}

function checkBinary() {
  const nodeBinPath = getRadicleBinaryPath('radicle-node');
  const httpdBinPath = getRadicleBinaryPath('radicle-httpd');
  return fs.existsSync(nodeBinPath) && fs.existsSync(httpdBinPath);
}

/**
 * Enable injected identity mode - skip rad auth and expect pre-injected identity
 * Call this before starting Radicle when using the unified identity system
 */
function setUseInjectedIdentity(enabled) {
  useInjectedIdentity = enabled;
  log.info(`[Radicle] Injected identity mode: ${enabled}`);
}

/**
 * Check if identity has been injected
 */
function hasInjectedIdentity() {
  const dataDir = getRadicleDataPath();
  const privateKeyPath = path.join(dataDir, 'keys', 'radicle');
  return fs.existsSync(privateKeyPath);
}

function getActivePort() {
  return currentHttpPort;
}

/**
 * Seed a repository from the Radicle network
 * @param {string} rid - Repository ID (with or without rad: prefix)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function seedRepository(rid) {
  if (currentState !== STATUS.RUNNING) {
    return failure('RADICLE_NOT_RUNNING', 'Radicle node is not running');
  }

  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) {
    return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  }

  log.info(`[Radicle] Seeding repository: ${fullRid}`);

  // Two-phase: `rad seed` alone reports success once the *policy* is
  // written — its network fetch is best-effort and its exit code does not
  // reflect fetch outcome. Write the policy synchronously, then hand the
  // fetch to the seed-status tracker, which retries, parses results, and
  // exposes honest progress via getSeedFetchStatus().
  try {
    await runRad(['seed', fullRid, '--no-fetch']);
  } catch (err) {
    log.error(`[Radicle] Seed policy failed for ${fullRid}:`, err.message);
    return failure('SEED_FAILED', err.stderr?.toString() || err.message, { rid: fullRid });
  }

  log.info(`[Radicle] Seeding policy set, fetch started: ${fullRid}`);
  return startTrackedFetch(fullRid);
}

/** Start (or reuse) the tracked background fetch and report its status. */
function startTrackedFetch(fullRid) {
  const dataDir = getActiveRadHome();
  seedStatus.startFetch(fullRid, { radBin: getRadicleBinaryPath('rad'), radHome: dataDir });
  return success({ status: seedStatus.getStatus(fullRid, dataDir) });
}

/**
 * Honest replication status for a repository (policy is not enough —
 * see seedRepository). Safe to poll.
 */
function getSeedFetchStatus(rid) {
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) {
    return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  }
  return success({ status: seedStatus.getStatus(fullRid, getActiveRadHome()) });
}

/**
 * Re-run the network fetch for an already-seeded repository (the retry
 * path after a failed fetch). Non-blocking; poll getSeedFetchStatus.
 */
function refetchRepository(rid) {
  if (currentState !== STATUS.RUNNING) {
    return failure('RADICLE_NOT_RUNNING', 'Radicle node is not running');
  }
  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) {
    return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  }
  return startTrackedFetch(fullRid);
}

/**
 * Get repository payload via rad CLI (workaround for radicle-httpd bug)
 * @param {string} rid - Repository ID (with or without rad: prefix)
 * @returns {Promise<{success: boolean, payload?: object, error?: string}>}
 */
async function getRepoPayload(rid) {
  if (currentState !== STATUS.RUNNING) {
    return failure('RADICLE_NOT_RUNNING', 'Radicle node is not running');
  }

  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) {
    return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  }

  const radBinPath = getRadicleBinaryPath('rad');
  const dataDir = getActiveRadHome();

  try {
    const { stdout } = await execFileAsync(radBinPath, ['inspect', '--payload', fullRid], {
      env: {
        ...process.env,
        RAD_HOME: dataDir,
        RAD_PASSPHRASE: '',
      },
      timeout: 10000,
    });

    const payload = JSON.parse(stdout);
    return success({ payload });
  } catch (err) {
    log.error(`[Radicle] Failed to get payload for ${fullRid}:`, err.message);
    return failure('GET_PAYLOAD_FAILED', err.message, { rid: fullRid });
  }
}

/**
 * Get connected peers by parsing rad node status output
 * @returns {Promise<{success: boolean, count?: number, error?: string}>}
 */
async function getConnections() {
  if (currentState !== STATUS.RUNNING) {
    return failure('RADICLE_NOT_RUNNING', 'Node not running', undefined, { count: 0 });
  }

  const radBinPath = getRadicleBinaryPath('rad');
  const dataDir = getActiveRadHome();

  try {
    const { stdout } = await execFileAsync(radBinPath, ['node', 'status'], {
      env: {
        ...process.env,
        RAD_HOME: dataDir,
        RAD_PASSPHRASE: '',
      },
      timeout: 5000,
    });

    // Parse the text output - count lines with ✓ (connected peers)
    // The output shows: ✓ for connected, ✗ for disconnected, ! for attempted
    // Peer lines look like: │ z6MkgNR...   rad.araxia.net:8776   ✓   ↗   1.75 minute(s) │
    const lines = stdout.split('\n');
    let connectedCount = 0;
    for (const line of lines) {
      // Look for peer lines (start with z6Mk Node ID) that have ✓ (connected)
      if (line.includes('z6Mk') && line.includes('✓') && !line.includes('Node is running')) {
        connectedCount++;
      }
    }

    return success({ count: connectedCount });
  } catch (err) {
    // During the first few seconds after the node process starts, `rad node
    // status` can exit non-zero because the control socket is not yet
    // listening. Polling UIs call this every ~2s, which would otherwise flood
    // the log with transient failures. Treat it as zero peers silently until
    // the grace period elapses.
    const withinStartupGrace =
      runningSinceMs !== null && Date.now() - runningSinceMs < CONNECTIONS_STARTUP_GRACE_MS;
    if (withinStartupGrace) {
      return success({ count: 0 });
    }
    log.error('[Radicle] Failed to get connections:', err.message);
    return failure('GET_CONNECTIONS_FAILED', err.message, undefined, { count: 0 });
  }
}

/**
 * Current lifecycle state, for in-process consumers (the provider API).
 * @returns {{status: string, error: string|null}}
 */
function getCurrentStatus() {
  return { status: currentState, error: lastError };
}

/**
 * Stop seeding a repository (removes the seeding policy).
 * @param {string} rid - Repository ID (with or without rad: prefix)
 */
async function unseedRepository(rid) {
  if (currentState !== STATUS.RUNNING) {
    return failure('RADICLE_NOT_RUNNING', 'Radicle node is not running');
  }

  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) {
    return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  }

  log.info(`[Radicle] Unseeding repository: ${fullRid}`);
  seedStatus.cancelFetch(fullRid);
  try {
    await runRad(['unseed', fullRid]);
    return success();
  } catch (err) {
    log.error(`[Radicle] Unseed failed for ${fullRid}:`, err.message);
    return failure('UNSEED_FAILED', err.stderr?.toString() || err.message, { rid: fullRid });
  }
}

/**
 * Run the bundled `rad` CLI against the active RAD_HOME. Args are passed as
 * discrete argv entries (never through a shell). Rejects on non-zero exit.
 * Used by the provider's COB write service.
 * @param {string[]} args
 * @param {{timeout?: number}} [opts]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runRad(args, { timeout = 30000 } = {}) {
  return execFileAsync(getRadicleBinaryPath('rad'), args, {
    env: { ...process.env, RAD_HOME: getActiveRadHome(), RAD_PASSPHRASE: '' },
    timeout,
  });
}

/**
 * The node's current alias, read from the active RAD_HOME's config.
 * @returns {string|null}
 */
function getNodeAlias() {
  try {
    const configPath = path.join(getActiveRadHome(), 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config?.node?.alias ?? null;
  } catch (err) {
    log.warn(`[Radicle] Could not read node alias: ${err.message}`);
    return null;
  }
}

// Mirrors radicle's own alias rules (heartwood: ≤32 bytes, no whitespace
// or control characters, non-empty). `rad config set` is deprecated, so
// the config is edited directly and validated here.
function isValidAlias(alias) {
  return (
    typeof alias === 'string' &&
    alias.length > 0 &&
    Buffer.byteLength(alias, 'utf8') <= 32 &&
    // eslint-disable-next-line no-control-regex
    !/[\s\u0000-\u001f\u007f]/.test(alias)
  );
}

/**
 * Set the node alias. The alias is gossiped in the node's announcement, so
 * a running managed node is restarted to re-announce under the new name.
 * @param {string} alias
 * @returns {Promise<{success: boolean, alias?: string, restarted?: boolean, error?: object}>}
 */
async function setNodeAlias(alias) {
  if (!isValidAlias(alias)) {
    return failure(
      'INVALID_ALIAS',
      'Alias must be 1–32 bytes with no whitespace or control characters'
    );
  }

  const configPath = path.join(getActiveRadHome(), 'config.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config.node = config.node || {};
    config.node.alias = alias;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  } catch (err) {
    log.error(`[Radicle] Failed to write alias: ${err.message}`);
    return failure('ALIAS_WRITE_FAILED', err.message);
  }
  log.info(`[Radicle] Node alias set to: ${alias}`);

  // Only a node we manage can be bounced; external/system nodes pick the
  // new alias up on their own next restart.
  let restarted = false;
  if (currentState === STATUS.RUNNING && radicleNodeProcess) {
    log.info('[Radicle] Restarting node to announce new alias');
    stopRadicle();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await startRadicle();
    restarted = true;
  }

  return success({ alias, restarted });
}

function registerRadicleIpc() {
  log.info('[Radicle] Registering IPC handlers');
  const radicleDisabledResponse = {
    status: STATUS.STOPPED,
    error: 'Radicle integration is disabled. Enable it in Settings > Experimental',
  };
  const isRadicleIntegrationEnabled = () => {
    return loadSettings().enableRadicleIntegration === true;
  };

  ipcMain.handle(IPC.RADICLE_START, (event) => {
    if (!isRadicleIntegrationEnabled()) {
      log.info('[Radicle] IPC: start blocked, integration disabled');
      return radicleDisabledResponse;
    }
    log.info('[Radicle] IPC: start requested');
    startRadicle({
      checkDefaultExternalCandidate: true,
      promptWindow: getPromptWindowForEvent(event),
    });
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.RADICLE_STOP, () => {
    log.info('[Radicle] IPC: stop requested');
    stopRadicle();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.RADICLE_GET_STATUS, () => {
    if (!isRadicleIntegrationEnabled()) {
      return radicleDisabledResponse;
    }
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.RADICLE_CHECK_BINARY, () => {
    const available = checkBinary();
    log.info('[Radicle] IPC: checkBinary requested, available:', available);
    return { available };
  });

  ipcMain.handle(IPC.RADICLE_SEED, async (_event, rid) => {
    if (!isRadicleIntegrationEnabled()) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      );
    }
    if (!validateNonEmptyString(rid)) {
      return failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' });
    }
    const normalizedRid = validateAndNormalizeRid(rid);
    if (!normalizedRid) {
      return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
    }
    log.info('[Radicle] IPC: seed requested for', rid);
    return await seedRepository(normalizedRid);
  });

  ipcMain.handle(IPC.RADICLE_GET_CONNECTIONS, async () => {
    if (!isRadicleIntegrationEnabled()) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental',
        undefined,
        { count: 0 }
      );
    }
    return await getConnections();
  });

  ipcMain.handle(IPC.RADICLE_GET_REPO_PAYLOAD, async (_event, rid) => {
    if (!isRadicleIntegrationEnabled()) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      );
    }
    if (!validateNonEmptyString(rid)) {
      return failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' });
    }
    const normalizedRid = validateAndNormalizeRid(rid);
    if (!normalizedRid) {
      return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
    }
    log.info('[Radicle] IPC: getRepoPayload requested for', rid);
    return await getRepoPayload(normalizedRid);
  });

  // Non-blocking: (re)starts the tracked background fetch. Poll
  // RADICLE_GET_SEED_STATUS for the outcome.
  ipcMain.handle(IPC.RADICLE_SYNC_REPO, async (_event, rid) => {
    if (!isRadicleIntegrationEnabled()) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      );
    }
    if (!validateNonEmptyString(rid)) {
      return failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' });
    }
    const normalizedRid = validateAndNormalizeRid(rid);
    if (!normalizedRid) {
      return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
    }
    log.info('[Radicle] IPC: syncRepo requested for', rid);
    return refetchRepository(normalizedRid);
  });

  ipcMain.handle(IPC.RADICLE_GET_SEED_STATUS, (_event, rid) => {
    if (!isRadicleIntegrationEnabled()) {
      return failure(
        'RADICLE_DISABLED',
        'Radicle integration is disabled. Enable it in Settings > Experimental'
      );
    }
    if (!validateNonEmptyString(rid)) {
      return failure('INVALID_RID', 'Missing Radicle Repository ID', { field: 'rid' });
    }
    return getSeedFetchStatus(rid);
  });
}

module.exports = {
  registerRadicleIpc,
  startRadicle,
  stopRadicle,
  getActivePort,
  getRadicleBinaryPath,
  getRadicleDataPath,
  setUseInjectedIdentity,
  hasInjectedIdentity,
  getActiveRadHome,
  getCurrentStatus,
  getConnections,
  seedRepository,
  unseedRepository,
  getSeedFetchStatus,
  refetchRepository,
  validateAndNormalizeRid,
  getNodeAlias,
  setNodeAlias,
  runRad,
  STATUS,
};
