const log = require('./logger');
const { ipcMain, app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const net = require('net');
const EventEmitter = require('events');
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
const { RELEASE_TAG } = require('../shared/ton-version');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

const events = new EventEmitter();
// Lifecycle signals only; unhandled 'error' would crash the process.
events.on('error', () => {});

let currentState = STATUS.STOPPED;
let lastError = null;
let tonProcess = null;
let healthCheckInterval = null;
let pendingStart = false;
let forceKillTimeout = null;

let currentProxyPort = DEFAULTS.ton.proxyPort;
let currentMode = MODE.NONE;
// Cached at module load for the hot status-payload path; refreshed on explicit checkBinary() IPC call.
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
      headers: { Host: 'health.ton' },
      timeout: 5000,
    };

    const req = http.request(options, (res) => {
      // Any response (even 502) means the proxy is alive
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
    win.webContents.send(IPC.TON_STATUS_UPDATE, buildStatusPayload());
  }
}

function buildStatusPayload() {
  const running = currentState === STATUS.RUNNING;
  return {
    status: currentState,
    mode: currentMode === MODE.NONE ? 'none' : currentMode,
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

  healthCheckInterval = setInterval(async () => {
    const alive = await probeTonProxy(currentProxyPort);

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
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[TON] Ignoring start request, current state: ${currentState}`);
    return;
  }

  if (currentState === STATUS.STOPPING) {
    log.info('[TON] Currently stopping, queuing start for after stop completes');
    pendingStart = true;
    return;
  }

  pendingStart = false;
  updateState(STATUS.STARTING);

  const defaultPort = DEFAULTS.ton.proxyPort;
  const portOpen = await isPortOpen(defaultPort);
  let proxyPort = defaultPort;

  if (portOpen) {
    log.info(`[TON] Port ${defaultPort} is busy, trying next...`);
    const fallback = await findAvailablePort(defaultPort + 1);
    if (!fallback) {
      updateState(STATUS.ERROR, 'No available ports for TON proxy');
      setStatusMessage('ton', 'Proxy failed to start');
      return;
    }
    proxyPort = fallback;
  }

  currentProxyPort = proxyPort;
  currentMode = MODE.BUNDLED;

  const binPath = getTonBinaryPath();
  if (!fs.existsSync(binPath)) {
    updateState(STATUS.ERROR, `Binary not found at ${binPath}`);
    setStatusMessage('ton', 'Proxy failed to start');
    return;
  }

  const args = ['-addr', `127.0.0.1:${proxyPort}`, '-verbosity', '1'];

  const configPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ton-bin', 'mainnet.json')
    : path.join(__dirname, '..', '..', 'ton-bin', 'mainnet.json');

  if (fs.existsSync(configPath)) {
    args.push('-global-config', configPath);
  }

  log.info(`[TON] Starting: ${binPath} ${args.join(' ')}`);

  try {
    tonProcess = spawn(binPath, args);

    tonProcess.stdout.on('data', (data) => {
      log.info(`[TON stdout]: ${data}`);
    });

    tonProcess.stderr.on('data', (data) => {
      log.error(`[TON stderr]: ${data}`);
    });

    tonProcess.on('close', (code) => {
      log.info(`[TON] Process exited with code ${code}`);
      tonProcess = null;

      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }

      const wasRunning = currentState === STATUS.RUNNING || currentState === STATUS.STOPPING;

      if (currentState !== STATUS.STOPPING) {
        updateState(STATUS.STOPPED, code !== 0 ? `Exited with code ${code}` : null);
      } else {
        updateState(STATUS.STOPPED);
      }

      clearService('ton');
      currentMode = MODE.NONE;

      if (wasRunning) {
        events.emit('stopped');
      }

      if (pendingStart) {
        log.info('[TON] Processing queued start request');
        pendingStart = false;
        setTimeout(() => startTon(), 100);
      }
    });

    tonProcess.on('error', (err) => {
      log.error('[TON] Failed to start process:', err);
      updateState(STATUS.ERROR, err.message);
      setStatusMessage('ton', 'Proxy failed to start');
      events.emit('error', err);
    });

    let attempts = 0;
    const maxAttempts = 60;
    const usingFallback = proxyPort !== defaultPort;

    const pollInterval = setInterval(async () => {
      if (
        currentState === STATUS.STOPPED ||
        currentState === STATUS.STOPPING ||
        currentState === STATUS.ERROR
      ) {
        clearInterval(pollInterval);
        return;
      }

      const alive = await probeTonProxy(currentProxyPort);
      if (alive) {
        clearInterval(pollInterval);

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
        events.emit('started', { proxyPort: currentProxyPort });
      } else {
        attempts++;
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          stopTon();
          updateState(STATUS.ERROR, 'Startup timed out');
          setStatusMessage('ton', 'Proxy failed to start');
          events.emit('error', new Error('Startup timed out'));
        }
      }
    }, 3000);
  } catch (err) {
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ton', 'Proxy failed to start');
    events.emit('error', err);
  }
}

function stopTon() {
  return new Promise((resolve) => {
    pendingStart = false;

    if (!tonProcess) {
      if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
      }
      updateState(STATUS.STOPPED);
      clearService('ton');
      currentMode = MODE.NONE;
      resolve();
      return;
    }

    const onExit = () => {
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
      resolve();
    };

    tonProcess.once('close', onExit);

    updateState(STATUS.STOPPING);

    if (healthCheckInterval) {
      clearInterval(healthCheckInterval);
      healthCheckInterval = null;
    }

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
  registerTonIpc,
  startTon,
  stopTon,
  checkBinary,
  STATUS,
  events,
};
