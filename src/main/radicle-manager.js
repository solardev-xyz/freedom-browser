const log = require('./logger');
const { ipcMain, app } = require('electron');
const { spawn, execFileSync, execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const os = require('os');

const execFileAsync = promisify(execFile);
const fs = require('fs');
const http = require('http');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { success, failure, validateNonEmptyString } = require('./ipc-contract');
const { loadSettings } = require('./settings-store');

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
  'z6MkrLMMsiPWUcNPHcRajuMi9mDfYckSoJyPwwnknocNYPm7@iris.radicle.xyz:8776',
  'z6Mkmqogy2qEM2ummccUthFEaaHvyYmYBYh3dbe9W4ebScxo@rosa.radicle.xyz:8776',
];

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

// Identity injection flag - when true, skip rad auth and use pre-injected identity
let useInjectedIdentity = false;


// Port configuration
let currentHttpPort = DEFAULTS.radicle.httpPort;
let currentMode = MODE.NONE;
let activeRadHome = null;

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
  if (!app.isPackaged) {
    // In dev, radicle-data is at project root (../../ from src/main)
    const devDataDir = path.join(__dirname, '..', '..', 'radicle-data');
    if (!fs.existsSync(devDataDir)) {
      fs.mkdirSync(devDataDir, { recursive: true });
    }
    return devDataDir;
  }

  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'radicle-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
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

/**
 * Ensure config.json contains preferredSeeds for peer discovery.
 * Merges seeds into an existing config or creates a new one.
 */
function ensureConfig(radHome) {
  const configPath = path.join(radHome, 'config.json');
  let config = {};

  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (err) {
      log.warn('[Radicle] Could not parse config.json, recreating:', err.message);
    }
  }

  if (config.preferredSeeds && config.preferredSeeds.length > 0) {
    return; // already has seeds
  }

  config.preferredSeeds = PREFERRED_SEEDS;
  config.node = config.node || {};
  config.node.alias = config.node.alias || 'FreedomBrowser';

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  log.info('[Radicle] Config updated with preferredSeeds');
}

/**
 * Check if Radicle identity exists, create if not
 */
function ensureIdentity(radHome) {
  const keysDir = path.join(radHome, 'keys');
  const privateKeyPath = path.join(keysDir, 'radicle');

  if (fs.existsSync(privateKeyPath)) {
    log.info('[Radicle] Identity already exists (injected or created)');
    ensureConfig(radHome);
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
    ensureConfig(radHome);
    return true;
  } catch (err) {
    log.error('[Radicle] Failed to create identity:', err.message);
    return false;
  }
}

function updateState(newState, error = null) {
  log.info('[Radicle] State change:', currentState, '->', newState, error ? `(error: ${error})` : '');
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
function waitForSocket(socketPath, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
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
function probeRadicleApi(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => { data += chunk; });
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

/**
 * Find an available port starting from the default
 */
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.radicle.fallbackRange) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
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
 * Return the active RAD_HOME — the system ~/.radicle when reusing
 * a system node, otherwise the bundled radicle-data directory.
 */
function getActiveRadHome() {
  return activeRadHome || getRadicleDataPath();
}

async function checkHealth() {
  return new Promise((resolve) => {
    // Note: radicle-httpd 0.23+ uses / as the root endpoint (not /api/v1/)
    const req = http.get(`http://127.0.0.1:${currentHttpPort}/`, { timeout: 2000 }, (res) => {
      if (res.statusCode === 200) {
        resolve(true);
      } else {
        resolve(false);
      }
      res.resume();
    });
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

async function startRadicle() {
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
  updateState(STATUS.STARTING);

  // Step 0: Detect system-wide radicle-node (~/.radicle)
  const systemNode = await detectSystemNode();

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
    if (portBusy) {
      // Check if it's already a working httpd we can reuse
      const probe = await probeRadicleApi(httpPort);
      if (probe.valid) {
        currentHttpPort = httpPort;
        currentMode = MODE.REUSED;
        updateService('radicle', {
          api: `http://127.0.0.1:${currentHttpPort}`,
          gateway: `http://127.0.0.1:${currentHttpPort}`,
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
      if (!newPort) {
        updateState(STATUS.ERROR, 'No available ports for Radicle httpd');
        setStatusMessage('radicle', 'Node failed to start');
        return;
      }
      httpPort = newPort;
    }

    currentHttpPort = httpPort;
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

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `httpd exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      clearService('radicle');

      if (pendingStart) {
        log.info('[Radicle] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startRadicle(), 100);
      }
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
      if (currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }

      const isHealthy = await checkHealth();
      if (isHealthy) {
        clearInterval(pollInterval);
        updateService('radicle', {
          api: `http://127.0.0.1:${currentHttpPort}`,
          gateway: `http://127.0.0.1:${currentHttpPort}`,
          mode: MODE.REUSED,
        });
        setStatusMessage('radicle', `System node: localhost:${currentHttpPort}`);
        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopRadicle();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('radicle', 'Node failed to start');
        }
      }
    }, 1000);

    return;
  }

  // No system node — use bundled flow
  activeRadHome = getRadicleDataPath();

  // Step 1: Detect existing daemon (httpd already running)
  const existing = await detectExistingDaemon();

  if (existing.found) {
    // Reuse existing daemon
    currentHttpPort = existing.port;
    currentMode = MODE.REUSED;

    updateService('radicle', {
      api: `http://127.0.0.1:${currentHttpPort}`,
      gateway: `http://127.0.0.1:${currentHttpPort}`,
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

  const radHome = activeRadHome;

  // Step 3: Ensure identity exists
  if (!ensureIdentity(radHome)) {
    updateState(STATUS.ERROR, 'Failed to create Radicle identity');
    setStatusMessage('radicle', 'Node failed to start');
    return;
  }

  // Step 4: Resolve ports (handle conflicts)
  let httpPort = DEFAULTS.radicle.httpPort;
  let usingFallbackPort = false;

  if (existing.conflict) {
    const newHttpPort = await findAvailablePort(httpPort + 1);
    if (!newHttpPort) {
      updateState(STATUS.ERROR, 'No available ports for Radicle httpd');
      setStatusMessage('radicle', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    httpPort = newHttpPort;
  }

  currentHttpPort = httpPort;
  currentMode = MODE.BUNDLED;

  const socketPath = getRadicleSocketPath(radHome);

  // Step 5: Clean up any stale socket from previous unclean shutdown
  cleanupStaleSocket(radHome);

  // Step 6: Start radicle-node
  log.info(`[Radicle] Starting node: ${nodeBinPath}`);

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
    });

    radicleNodeProcess.stderr.on('data', (data) => {
      log.error(`[Radicle-node stderr]: ${data}`);
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
      await waitForSocket(socketPath, 30000);
      log.info('[Radicle] Node socket ready');
    } catch (err) {
      log.error('[Radicle] Socket wait failed:', err.message);
      if (radicleNodeProcess) {
        radicleNodeProcess.kill('SIGTERM');
      }
      updateState(STATUS.ERROR, 'Node socket never appeared');
      setStatusMessage('radicle', 'Node failed to start');
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

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `httpd exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      clearService('radicle');

      if (pendingStart) {
        log.info('[Radicle] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startRadicle(), 100);
      }
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
      if (currentState === STATUS.STOPPED || currentState === STATUS.ERROR) {
        clearInterval(pollInterval);
        return;
      }

      const isHealthy = await checkHealth();
      if (isHealthy) {
        clearInterval(pollInterval);

        updateService('radicle', {
          api: `http://127.0.0.1:${currentHttpPort}`,
          gateway: `http://127.0.0.1:${currentHttpPort}`,
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
          stopRadicle();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('radicle', 'Node failed to start');
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

    // If we reused an external daemon, stop our httpd but not the system node
    if (currentMode === MODE.REUSED) {
      if (radicleHttpdProcess) {
        // We spawned httpd against the system node — kill it
        radicleHttpdProcess.once('close', () => {
          updateState(STATUS.STOPPED);
          clearService('radicle');
          currentMode = MODE.NONE;
          activeRadHome = null;
          resolve();
        });
        radicleHttpdProcess.kill('SIGTERM');

        // Force kill if httpd doesn't exit within 5 seconds
        setTimeout(() => {
          if (radicleHttpdProcess) {
            log.warn('[Radicle] Force killing reused-mode httpd...');
            radicleHttpdProcess.kill('SIGKILL');
          }
        }, 5000);
        return;
      }
      // No httpd process (fully external) — just clear state
      updateState(STATUS.STOPPED);
      clearService('radicle');
      currentMode = MODE.NONE;
      activeRadHome = null;
      resolve();
      return;
    }

    if (!radicleHttpdProcess && !radicleNodeProcess) {
      updateState(STATUS.STOPPED);
      clearService('radicle');
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
        resolve();
      }
    };

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

    // Force kill if processes don't exit within 10 seconds
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

  const radBinPath = getRadicleBinaryPath('rad');
  const dataDir = getActiveRadHome();

  log.info(`[Radicle] Seeding repository: ${fullRid}`);

  try {
    // Use async execFile to avoid blocking the main process
    await execFileAsync(radBinPath, ['seed', fullRid], {
      env: {
        ...process.env,
        RAD_HOME: dataDir,
        RAD_PASSPHRASE: '',
      },
      timeout: 120000, // 120 second timeout for large repos
    });
    log.info(`[Radicle] Repository seeded: ${fullRid}`);
    return success();
  } catch (err) {
    log.error(`[Radicle] Seed failed for ${fullRid}:`, err.message);
    // Try to extract meaningful error from stderr
    const stderrStr = err.stderr?.toString() || '';
    const errorMsg = stderrStr.includes('not found')
      ? 'Repository not found on the network'
      : stderrStr.includes('already tracking')
        ? 'Repository is already seeded'
        : err.message;
    return failure('SEED_FAILED', errorMsg, { rid: fullRid });
  }
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
 * Sync a repository from the network
 * @param {string} rid - Repository ID (with or without rad: prefix)
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function syncRepository(rid) {
  if (currentState !== STATUS.RUNNING) {
    return failure('RADICLE_NOT_RUNNING', 'Radicle node is not running');
  }

  const fullRid = validateAndNormalizeRid(rid);
  if (!fullRid) {
    return failure('INVALID_RID', 'Invalid Radicle Repository ID', { rid });
  }

  const radBinPath = getRadicleBinaryPath('rad');
  const dataDir = getActiveRadHome();

  log.info(`[Radicle] Syncing repository: ${fullRid}`);

  try {
    const { stdout, stderr } = await execFileAsync(radBinPath, ['sync', fullRid], {
      env: {
        ...process.env,
        RAD_HOME: dataDir,
        RAD_PASSPHRASE: '',
      },
      timeout: 60000, // 60 second timeout
    });
    log.info(`[Radicle] Repository synced: ${fullRid}`);
    return success({ output: stdout || stderr });
  } catch (err) {
    log.error(`[Radicle] Sync failed for ${fullRid}:`, err.message);
    const stderrStr = err.stderr?.toString() || '';
    return failure('SYNC_FAILED', stderrStr || err.message, { rid: fullRid });
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
    log.error('[Radicle] Failed to get connections:', err.message);
    return failure('GET_CONNECTIONS_FAILED', err.message, undefined, { count: 0 });
  }
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

  ipcMain.handle(IPC.RADICLE_START, () => {
    if (!isRadicleIntegrationEnabled()) {
      log.info('[Radicle] IPC: start blocked, integration disabled');
      return radicleDisabledResponse;
    }
    log.info('[Radicle] IPC: start requested');
    startRadicle();
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
    return await syncRepository(normalizedRid);
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
  STATUS
};
