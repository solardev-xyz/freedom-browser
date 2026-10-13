const log = require('./logger');
const { ipcMain, app, BrowserWindow, webContents: electronWebContents } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const IPC = require('../shared/ipc-channels');
const { registerTonProtocol } = require('./ton-protocol');
const { loadSettings, onSettingsChanged } = require('./settings-store');
const { getTonDataDir } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');
const { isTonHost } = require('../shared/ton-suffixes');
const {
  MODE,
  DEFAULTS,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const { RELEASE_TAG } = require('../shared/ton-version');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let tonProcess = null;
let healthCheckInterval = null;
let healthCheckGeneration = 0;
let startupPollInterval = null;
let healthCheckInFlight = false;
let startupProbeInFlight = false;
let pendingStart = false;
let forceKillTimeout = null;
let pendingStopError = null;
let startGeneration = 0;
const proxySessions = new Map();
const routedSessions = new WeakSet();
let routingCleanupPromise = Promise.resolve();
let requestGuardRegistered = false;

let currentProxyPort = DEFAULTS.ton.proxyPort;
let currentMode = MODE.NONE;
let _binaryExists = null;

function getTonBinaryPath() {
  if (app.isPackaged) {
    const binName =
      process.platform === 'win32' ? 'tonutils-freedom-cli.exe' : 'tonutils-freedom-cli';
    return path.join(process.resourcesPath, 'ton-bin', binName);
  }

  const platformMap = {
    darwin: 'mac',
    linux: 'linux',
    win32: 'win',
  };
  const platform = platformMap[process.platform] || process.platform;
  const arch = process.arch;
  const binName =
    process.platform === 'win32' ? 'tonutils-freedom-cli.exe' : 'tonutils-freedom-cli';
  return path.join(__dirname, '..', '..', 'ton-bin', `${platform}-${arch}`, binName);
}

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

async function findAvailablePort(defaultPort, maxAttempts = DEFAULTS.ton.fallbackRange) {
  for (let i = 0; i < maxAttempts; i++) {
    const port = defaultPort + i;
    const open = await isPortOpen(port);
    if (!open) {
      return port;
    }
    log.info(`[TON] Port ${port} is busy, trying next...`);
  }
  return null;
}

function probeTonProxy(port) {
  return new Promise((resolve) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'HEAD',
      headers: { Host: 'freedom-proxy-check.invalid' },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      res.resume();
      resolve(true);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.end();
  });
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;

  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    try {
      win.webContents.send(IPC.TON_STATUS_UPDATE, buildStatusPayload());
    } catch {
      continue;
    }
  }
}

function registerTonRoutingSession(key, targetSession) {
  if (!key || !targetSession) return;
  proxySessions.set(key, targetSession);
  routedSessions.add(targetSession);
  registerTonProtocol(targetSession, { getProxyUrl });
}

function unregisterTonRoutingSession(key) {
  const targetSession = proxySessions.get(key);
  if (targetSession) routedSessions.delete(targetSession);
  proxySessions.delete(key);
}

function isDisabledForProfile() {
  return getActiveProfile()?.metadata?.nodes?.ton?.mode === 'disabled';
}

function clearTonServiceEntry() {
  if (isDisabledForProfile()) {
    currentMode = MODE.DISABLED;
    updateService('ton', { proxy: null, mode: MODE.DISABLED });
    setStatusMessage('ton', 'Disabled for this profile');
  } else {
    currentMode = MODE.NONE;
    clearService('ton');
  }
}

async function syncProfileMode() {
  if (isDisabledForProfile()) await stopTon();
  if (currentState === STATUS.STOPPED) {
    clearTonServiceEntry();
    updateState(STATUS.STOPPED);
  }
  return buildStatusPayload();
}

function getProxyUrl() {
  return loadSettings().enableTonIntegration === true &&
    !isDisabledForProfile() &&
    currentState === STATUS.RUNNING
    ? `http://127.0.0.1:${currentProxyPort}`
    : null;
}

function guardTonRequest(details = {}) {
  let parsed;
  try {
    parsed = new URL(details.url);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol) ||
    !isTonHost(parsed.hostname)
  ) {
    return null;
  }

  if (!Number.isInteger(details.webContentsId) || details.webContentsId <= 0) {
    return { cancel: true };
  }

  let requestContents;
  try {
    requestContents = electronWebContents?.fromId?.(details.webContentsId);
  } catch {
    return { cancel: true };
  }
  if (!requestContents?.session || !routedSessions.has(requestContents.session) || !getProxyUrl()) {
    return { cancel: true };
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    return { redirectURL: `tonsite://${parsed.host}${parsed.pathname}${parsed.search}` };
  }
  return { cancel: true };
}

function registerTonRequestGuard() {
  if (requestGuardRegistered) return;
  requestGuardRegistered = true;
  registerWebRequestHandler('onBeforeRequest', 'ton-routing-guard', guardTonRequest, {
    failClosed: true,
  });
}

function buildStatusPayload() {
  const running = currentState === STATUS.RUNNING;
  return {
    enabled: loadSettings().enableTonIntegration === true,
    status: currentState,
    mode: isDisabledForProfile() ? MODE.DISABLED : currentMode,
    proxyUrl: running ? `http://127.0.0.1:${currentProxyPort}` : null,
    proxyPort: running ? currentProxyPort : null,
    version: running ? RELEASE_TAG : null,
    statusMessage: null,
    error: lastError,
    binaryAvailable: checkBinaryInternal(),
  };
}

function checkBinaryInternal() {
  if (_binaryExists === null) {
    _binaryExists = fs.existsSync(getTonBinaryPath());
  }
  return _binaryExists;
}

function startHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
  }
  healthCheckGeneration += 1;
  const generation = healthCheckGeneration;

  healthCheckInterval = setInterval(async () => {
    if (healthCheckInFlight) return;
    healthCheckInFlight = true;
    const alive = await probeTonProxy(currentProxyPort);
    healthCheckInFlight = false;
    if (generation !== healthCheckGeneration) return;

    if (!alive && currentState === STATUS.RUNNING) {
      updateState(STATUS.ERROR, 'Health check failed');
      setErrorState('ton', 'Proxy unreachable. Retrying…');
    } else if (alive && currentState === STATUS.ERROR) {
      clearErrorState('ton');
      updateState(STATUS.RUNNING);
    }
  }, 3000);
}

async function startTon() {
  if (loadSettings().enableTonIntegration !== true || isDisabledForProfile()) return;
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[TON] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[TON] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  if (currentState === STATUS.ERROR && tonProcess) {
    log.info('[TON] Restarting the existing errored proxy process');
    await stopTon();
    return startTon();
  }

  pendingStart = false;
  pendingStopError = null;
  startGeneration += 1;
  const generation = startGeneration;
  const superseded = () => generation !== startGeneration;
  updateState(STATUS.STARTING);

  const defaultPort = DEFAULTS.ton.proxyPort;
  const portOpen = await isPortOpen(defaultPort);
  if (superseded()) return;
  let proxyPort = defaultPort;

  if (portOpen) {
    log.info(`[TON] Port ${defaultPort} is busy, trying next...`);
    const fallback = await findAvailablePort(defaultPort + 1);
    if (superseded()) return;
    if (!fallback) {
      updateState(STATUS.ERROR, 'No available ports for TON proxy');
      setStatusMessage('ton', 'Proxy failed to start');
      return;
    }
    proxyPort = fallback;
  }

  currentProxyPort = proxyPort;

  const binPath = getTonBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Binary not found at ${binPath}`);
    setStatusMessage('ton', 'Proxy failed to start');
    return;
  }
  currentMode = MODE.BUNDLED;

  const args = ['-addr', `127.0.0.1:${proxyPort}`, '-verbosity', '1', '-no-http'];

  const configPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ton-bin', 'mainnet.json')
    : path.join(__dirname, '..', '..', 'ton-bin', 'mainnet.json');

  if (fs.existsSync(configPath)) {
    args.push('-global-config', configPath);
  }

  log.info(`[TON] Starting: ${binPath} ${args.join(' ')}`);

  try {
    const child = spawn(binPath, args, { cwd: getTonDataDir(), stdio: 'ignore' });
    tonProcess = child;

    child.on('close', (code) => {
      log.info(`[TON] Process exited with code ${code}`);
      if (tonProcess === child) tonProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      healthCheckGeneration += 1;
      healthCheckInFlight = false;
      if (startupPollInterval) {
        clearInterval(startupPollInterval);
        startupPollInterval = null;
      }
      startupProbeInFlight = false;

      const terminalError = pendingStopError;
      pendingStopError = null;
      const deliberateStop = currentState === STATUS.STOPPING && !terminalError;

      if (deliberateStop) {
        routingCleanupPromise = Promise.resolve();
        clearTonServiceEntry();
        updateState(STATUS.STOPPED);
      } else {
        routingCleanupPromise = Promise.resolve();
        clearTonServiceEntry();
        const errorMessage = terminalError || `TON proxy exited with code ${code}`;
        setErrorState('ton', 'TON proxy unavailable');
        updateState(STATUS.ERROR, errorMessage);
      }

      if (pendingStart) {
        log.info('[TON] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startTon(), 100);
      }
    });

    child.on('error', (err) => {
      log.error('[TON] Failed to start process:', err);
      if (tonProcess === child) tonProcess = null;
      if (startupPollInterval) {
        clearInterval(startupPollInterval);
        startupPollInterval = null;
      }
      startupProbeInFlight = false;
      currentMode = MODE.NONE;
      clearTonServiceEntry();
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('ton', 'Proxy failed to start');
    });

    let attempts = 0;
    const maxAttempts = 60;
    const usingFallback = proxyPort !== defaultPort;

    startupPollInterval = setInterval(async () => {
      if (
        currentState === STATUS.STOPPED ||
        currentState === STATUS.STOPPING ||
        currentState === STATUS.ERROR
      ) {
        clearInterval(startupPollInterval);
        startupPollInterval = null;
        return;
      }

      if (startupProbeInFlight) return;
      startupProbeInFlight = true;

      const alive = await probeTonProxy(currentProxyPort);
      startupProbeInFlight = false;
      if (superseded() || tonProcess !== child) {
        clearInterval(startupPollInterval);
        startupPollInterval = null;
        return;
      }
      if (alive) {
        clearInterval(startupPollInterval);
        startupPollInterval = null;

        updateService('ton', {
          proxy: `http://127.0.0.1:${currentProxyPort}`,
          mode: MODE.BUNDLED,
        });

        if (usingFallback) {
          setStatusMessage('ton', `Fallback Port: ${currentProxyPort}`);
        } else {
          setStatusMessage('ton', null);
        }

        updateState(STATUS.RUNNING);
        startHealthCheck();
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(startupPollInterval);
          startupPollInterval = null;
          pendingStopError = 'Startup timed out';
          setStatusMessage('ton', 'Proxy failed to start');
          updateState(STATUS.ERROR, pendingStopError);
          void stopTon({ preserveError: true });
        }
      }
    }, 3000);
  } catch (err) {
    currentMode = MODE.NONE;
    clearTonServiceEntry();
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ton', 'Proxy failed to start');
  }
}

function stopTon(options = {}) {
  const preserveError = options?.preserveError === true;
  return new Promise((resolve) => {
    pendingStart = false;
    startGeneration += 1;
    if (startupPollInterval) {
      clearInterval(startupPollInterval);
      startupPollInterval = null;
    }
    startupProbeInFlight = false;

    if (!tonProcess) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      healthCheckGeneration += 1;
      healthCheckInFlight = false;
      routingCleanupPromise = Promise.resolve();
      if (!preserveError) updateState(STATUS.STOPPED);
      clearTonServiceEntry();
      routingCleanupPromise.finally(resolve);
      return;
    }

    const onExit = () => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      routingCleanupPromise.finally(resolve);
    };

    tonProcess.once('close', onExit);

    if (!preserveError) updateState(STATUS.STOPPING);

    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }
    healthCheckGeneration += 1;

    tonProcess.kill('SIGTERM');

    if (forceKillTimeout) clearTimeout(forceKillTimeout);
    forceKillTimeout = setTimeout(() => {
      if (tonProcess) {
        log.warn('[TON] Force killing process...');
        tonProcess.kill('SIGKILL');
      }
      forceKillTimeout = null;
    }, 5000);
  });
}

function checkBinary() {
  const binPath = getTonBinaryPath();
  _binaryExists = fs.existsSync(binPath);
  return {
    available: _binaryExists,
    path: _binaryExists ? binPath : null,
    version: null,
  };
}

function registerTonIpc() {
  void syncProfileMode();
  onSettingsChanged((settings) => {
    if (settings.enableTonIntegration !== true) void stopTon();
  });
  ipcMain.handle(IPC.TON_START, async () => {
    await startTon();
    return buildStatusPayload();
  });

  ipcMain.handle(IPC.TON_STOP, async () => {
    await stopTon();
    return buildStatusPayload();
  });

  ipcMain.handle(IPC.TON_GET_STATUS, () => {
    return buildStatusPayload();
  });

  ipcMain.handle(IPC.TON_CHECK_BINARY, () => {
    return checkBinary();
  });
}

module.exports = {
  syncProfileMode,
  getProxyUrl,
  registerTonIpc,
  startTon,
  stopTon,
  checkBinary,
  registerTonRoutingSession,
  unregisterTonRoutingSession,
  guardTonRequest,
  registerTonRequestGuard,
  STATUS,
};
