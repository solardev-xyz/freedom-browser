const log = require('./logger');
const { ipcMain, app } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');

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
let beeProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;

const CONFIG_FILE = 'config.yaml';

// Port configuration (resolved at startup)
// Note: Newer Bee versions serve debug endpoints on the main API port
let currentApiPort = DEFAULTS.bee.apiPort;
let currentMode = MODE.NONE;

function getBeeBinaryPath() {
  const arch = process.arch;

  // Map Node.js platform names to our folder names
  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;

  // In dev, bee-bin is at project root (../../ from src/main)
  let basePath = path.join(__dirname, '..', '..', 'bee-bin');

  if (app.isPackaged) {
    basePath = path.join(process.resourcesPath, 'bee-bin');
    const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
    return path.join(basePath, binName);
  }

  const binName = process.platform === 'win32' ? 'bee.exe' : 'bee';
  return path.join(basePath, `${platform}-${arch}`, binName);
}

function getBeeDataPath() {
  if (!app.isPackaged) {
    // In dev, bee-data is at project root (../../ from src/main)
    const devDataDir = path.join(__dirname, '..', '..', 'bee-data');
    if (!fs.existsSync(devDataDir)) {
      fs.mkdirSync(devDataDir, { recursive: true });
    }
    return devDataDir;
  }

  const userData = app.getPath('userData');
  const dataDir = path.join(userData, 'bee-data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  return dataDir;
}

function ensureConfig(dataDir, apiPort) {
  const configPath = path.join(dataDir, CONFIG_FILE);
  const crypto = require('crypto');

  // Check if config exists and read current password if so
  let password;
  if (fs.existsSync(configPath)) {
    try {
      const existingConfig = fs.readFileSync(configPath, 'utf-8');
      const passwordMatch = existingConfig.match(/^password:\s*(.+)$/m);
      if (passwordMatch) {
        password = passwordMatch[1].trim();
      }
    } catch {
      log.warn('[Bee] Could not read existing password, generating new one');
    }
  }

  // Generate new password if we couldn't read one
  if (!password) {
    password = crypto.randomBytes(32).toString('hex');
  }

  // Always write config with current port
  // Note: Newer Bee versions don't have separate debug-api-addr, debug endpoints are on main API
  const configContent = `# Bee Configuration
api-addr: 127.0.0.1:${apiPort}
swap-enable: false
mainnet: true
full-node: false
cors-allowed-origins: "null"
use-postage-snapshot: false
skip-postage-snapshot: true
resolver-options: https://cloudflare-eth.com
storage-incentives-enable: false
data-dir: ${dataDir}
password: ${password}
`;

  fs.writeFileSync(configPath, configContent);
  log.info(`[Bee] Config written at ${configPath} with API:${apiPort}`);

  // Initialize keys if this is a fresh config
  if (!fs.existsSync(path.join(dataDir, 'keys'))) {
    const binPath = getBeeBinaryPath();
    try {
      const { execSync } = require('child_process');
      log.info('[Bee] Running init to generate keys...');
      execSync(`"${binPath}" init --config="${configPath}"`);
    } catch (e) {
      log.error('[Bee] Init failed:', e.message);
    }
  }

  return configPath;
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  // Broadcast to all windows
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.BEE_STATUS_UPDATE, { status: currentState, error: lastError });
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
 * Probe Bee health endpoint
 */
function probeBeeApi(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/health`, { timeout: 2000 }, (res) => {
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
            resolve({ valid: false });
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
async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.bee.fallbackRange) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[Bee] Port ${port} is busy, trying next...`);
  }
  return null;
}

/**
 * Detect if an existing Bee daemon is running and reusable
 * Always checks default port first to detect conflicts properly
 */
async function detectExistingDaemon() {
  const defaultPort = DEFAULTS.bee.apiPort;

  // First check if anything is on the default API port
  const portOpen = await isPortOpen(defaultPort);
  if (!portOpen) {
    return { found: false };
  }

  // Probe to see if it's actually Bee
  const probe = await probeBeeApi(defaultPort);
  if (probe.valid) {
    log.info('[Bee] Found existing daemon on port', defaultPort);
    return {
      found: true,
      port: defaultPort,
      version: probe.data?.version,
    };
  }

  // Port is open but not Bee - conflict
  log.info('[Bee] Port', defaultPort, 'is busy (not a Bee daemon)');
  return { found: false, conflict: true, port: defaultPort };
}

async function checkHealth() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${currentApiPort}/health`, { timeout: 2000 }, (res) => {
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
      setErrorState('bee', 'Node unreachable. Retrying…');
    } else if (isHealthy && currentState === STATUS.ERROR) {
      // Recovered - clear error state (reveals original statusMessage)
      clearErrorState('bee');
      updateState(STATUS.RUNNING);
    }
  }, 5000);
}

async function startBee() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[Bee] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[Bee] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  // Step 1: Detect existing daemon
  const existing = await detectExistingDaemon();

  if (existing.found) {
    // Reuse existing daemon
    currentApiPort = existing.port;
    currentMode = MODE.REUSED;

    updateService('bee', {
      api: `http://127.0.0.1:${currentApiPort}`,
      gateway: `http://127.0.0.1:${currentApiPort}`,
      mode: MODE.REUSED,
    });
    setStatusMessage('bee', `Node: localhost:${currentApiPort}`);

    updateState(STATUS.RUNNING);
    startHealthCheck();
    log.info('[Bee] Reusing existing daemon on port', currentApiPort);
    return;
  }

  // Step 2: Start bundled node
  const binPath = getBeeBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Bee binary not found at ${binPath}`);
    setStatusMessage('bee', 'Node failed to start');
    return;
  }

  const dataDir = getBeeDataPath();

  // Step 3: Resolve ports (handle conflicts)
  // Always try default port first
  let apiPort = DEFAULTS.bee.apiPort;
  let usingFallbackPort = false;

  // Check if default API port is available
  if (existing.conflict) {
    const newApiPort = await findAvailablePort(apiPort + 1);
    if (!newApiPort) {
      updateState(STATUS.ERROR, 'No available ports for Bee API');
      setStatusMessage('bee', 'Node failed to start');
      return;
    }
    usingFallbackPort = true;
    apiPort = newApiPort;
  }

  currentApiPort = apiPort;
  currentMode = MODE.BUNDLED;

  const configPath = ensureConfig(dataDir, apiPort);

  const args = ['start', `--config=${configPath}`];

  log.info(`[Bee] Starting: ${binPath} ${args.join(' ')}`);

  try {
    beeProcess = spawn(binPath, args);

    beeProcess.stdout.on('data', (data) => {
      log.info(`[Bee stdout]: ${data}`);
    });

    beeProcess.stderr.on('data', (data) => {
      log.error(`[Bee stderr]: ${data}`);
    });

    beeProcess.on('close', (code) => {
      log.info(`[Bee] Process exited with code ${code}`);
      beeProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `Exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }
      if (healthCheckInterval) clearInterval(healthCheckInterval);
      clearService('bee');

      if (pendingStart) {
        log.info('[Bee] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startBee(), 100);
      }
    });

    beeProcess.on('error', (err) => {
      log.error('[Bee] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('bee', 'Node failed to start');
    });

    // Poll for health until running
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

        // Update registry (API and gateway are same port in newer Bee)
        updateService('bee', {
          api: `http://127.0.0.1:${currentApiPort}`,
          gateway: `http://127.0.0.1:${currentApiPort}`,
          mode: MODE.BUNDLED,
        });

        // Only show status line if using fallback port
        if (usingFallbackPort) {
          setStatusMessage('bee', `Fallback Port: ${currentApiPort}`);
        } else {
          // Clear any previous status for normal healthy state
          setStatusMessage('bee', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopBee();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('bee', 'Node failed to start');
        }
      }
    }, 1000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('bee', 'Node failed to start');
  }
}

// Stop Bee and return a Promise that resolves when the process exits
function stopBee() {
  return new Promise((resolve) => {
    pendingStart = false;

    // If we reused an external daemon, just clear state (don't stop it)
    if (currentMode === MODE.REUSED) {
      updateState(STATUS.STOPPED);
      clearService('bee');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    if (!beeProcess) {
      updateState(STATUS.STOPPED);
      clearService('bee');
      resolve();
      return;
    }

    // Listen for the process to exit
    const onExit = () => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      resolve();
    };

    beeProcess.once('close', onExit);

    updateState(STATUS.STOPPING);
    if (healthCheckInterval) clearInterval(healthCheckInterval);

    // Try graceful shutdown via SIGTERM
    beeProcess.kill('SIGTERM');

    // Force kill if it doesn't exit within 5 seconds
    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (beeProcess) {
        log.warn('[Bee] Force killing process...');
        beeProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);
  });
}

function checkBinary() {
  const binPath = getBeeBinaryPath();
  return fs.existsSync(binPath);
}

function getActivePort() {
  return currentApiPort;
}

function registerBeeIpc() {
  ipcMain.handle(IPC.BEE_START, () => {
    startBee();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.BEE_STOP, () => {
    stopBee();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.BEE_GET_STATUS, () => {
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.BEE_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

module.exports = {
  registerBeeIpc,
  startBee,
  stopBee,
  getActivePort,
  STATUS,
};
