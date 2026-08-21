const log = require('./logger');
const { ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../shared/ipc-channels');
const { getIpfsDataDir } = require('./profile-paths');
const { getActiveProfile } = require('./profile-resolver');
const {
  MODE,
  updateService,
  setStatusMessage,
  setErrorState,
  clearErrorState,
  clearService,
} = require('./service-registry');
const { FreedomIpfsNativeNode } = require('./ipfs/freedom-ipfs-native-node');

const STATUS = {
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
};

let currentState = STATUS.STOPPED;
let lastError = null;
let activeNode = null;
let healthCheckInterval = null;

// Serializes start/stop transitions. The renderer's optimistic toggle awaits
// start()/stop() and treats the resolved status as the *settled* backend state
// (see reconcileIpfsToggle in renderer/lib/ipfs-ui.js). To honor that contract
// even when the user flips the switch mid-transition, every transition runs to
// completion before the next begins — a start requested during a stop waits for
// the stop, then runs, and only then does its promise resolve.
let opChain = Promise.resolve();

function enqueueOp(op) {
  const result = opChain.then(op, op);
  // A failing op must not poison the chain for the next transition.
  opChain = result.catch(() => {});
  return result;
}

function defaultNativeDiagnostics() {
  return {
    progress: '{"active":[],"events":[]}',
    nativeGatewayStats: '{}',
    nativeVersion: null,
    nativeBuildInfo: null,
  };
}

function readNativeVersion(node) {
  try {
    const version = node?.version;
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch (err) {
    log.warn('[IPFS] Failed to read native version:', err.message);
    return null;
  }
}

function readNativeBuildInfoJson(node) {
  if (!node || typeof node.buildInfoJson !== 'function') return null;
  try {
    const buildInfo = node.buildInfoJson();
    return typeof buildInfo === 'string' && buildInfo.length > 0 ? buildInfo : null;
  } catch (err) {
    log.warn('[IPFS] Failed to read native build info:', err.message);
    return null;
  }
}

function nativeNodeLabel(node) {
  const version = readNativeVersion(node);
  return version ? `freedom-ipfs ${version}` : 'freedom-ipfs';
}

function getIpfsDataPath() {
  const dataDir = path.join(getIpfsDataDir(), 'freedom-ipfs');
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

function getProfileIpfsConfig() {
  return getActiveProfile()?.metadata?.nodes?.ipfs || null;
}

function isDisabledIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'disabled';
}

function updateState(newState, error = null) {
  currentState = newState;
  lastError = error;
  const windows = require('electron').BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC.IPFS_STATUS_UPDATE, { status: currentState, error: lastError });
  }
}

function checkHealth() {
  if (!activeNode || currentState !== STATUS.RUNNING) return false;
  if (typeof activeNode.isHealthy === 'function' && !activeNode.isHealthy()) return false;
  try {
    activeNode.nativeGatewayStatsJson();
    return true;
  } catch (err) {
    log.warn('[IPFS] Native health check failed:', err.message);
    return false;
  }
}

function getStatus() {
  return { status: currentState, error: lastError };
}

function stopHealthCheck() {
  if (!healthCheckInterval) return;
  clearInterval(healthCheckInterval);
  healthCheckInterval = null;
}

function handleNativeNodeFailure(reason, node = activeNode) {
  if (node && activeNode && node !== activeNode) return;
  if (![STATUS.STARTING, STATUS.RUNNING].includes(currentState)) return;

  const message = reason || 'Native node unavailable';
  const failedNode = activeNode;
  activeNode = null;
  stopHealthCheck();
  clearService('ipfs');
  setStatusMessage('ipfs', 'Node unavailable');
  setErrorState('ipfs', 'Node unavailable. Restart IPFS from the nodes menu.');
  updateState(STATUS.ERROR, message);

  if (failedNode) {
    failedNode.stop().catch((err) => {
      log.warn('[IPFS] Error while cleaning up failed freedom-ipfs native node:', err.message);
    });
  }
}

function startHealthCheck() {
  if (healthCheckInterval) clearInterval(healthCheckInterval);
  healthCheckInterval = setInterval(() => {
    const isHealthy = checkHealth();
    if (!isHealthy && currentState === STATUS.RUNNING) {
      handleNativeNodeFailure('Native node unavailable');
    }
  }, 5000);
  healthCheckInterval.unref?.();
}

function checkBinary() {
  return FreedomIpfsNativeNode.isAvailable();
}

function startDisabledIpfs() {
  clearService('ipfs');
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.DISABLED,
    backend: 'freedom-ipfs',
  });
  setStatusMessage('ipfs', 'Node disabled for this profile');
  updateState(STATUS.STOPPED);
  log.info('[IPFS] Disabled for active profile');
}

async function doStartIpfs() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[IPFS] Ignoring start request, current state: ${currentState}`);
    return;
  }

  updateState(STATUS.STARTING);

  if (isDisabledIpfsConfig()) {
    startDisabledIpfs();
    return;
  }

  if (!checkBinary()) {
    updateState(STATUS.ERROR, 'freedom-ipfs native addon not built');
    setStatusMessage('ipfs', 'Native node unavailable');
    return;
  }

  const dataDir = getIpfsDataPath();
  const node = new FreedomIpfsNativeNode({
    dataDir,
    onFailure: (reason, failedNode) => handleNativeNodeFailure(reason, failedNode),
  });

  try {
    if (!node.start()) {
      updateState(STATUS.ERROR, 'Failed to start freedom-ipfs native node');
      setStatusMessage('ipfs', 'Node failed to start');
      return;
    }
  } catch (err) {
    log.error('[IPFS] Failed to start freedom-ipfs native node:', err);
    updateState(STATUS.ERROR, err.message);
    setStatusMessage('ipfs', 'Node failed to start');
    return;
  }

  activeNode = node;
  const nodeLabel = nativeNodeLabel(node);
  updateService('ipfs', {
    api: null,
    gateway: null,
    mode: MODE.BUNDLED,
    backend: 'freedom-ipfs',
  });
  setStatusMessage('ipfs', `Node: ${nodeLabel}`);
  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info(`[IPFS] ${nodeLabel} native node started at ${dataDir}`);
}

async function doStopIpfs() {
  if (currentState === STATUS.STOPPED && !activeNode) {
    clearService('ipfs');
    return;
  }
  updateState(STATUS.STOPPING);
  stopHealthCheck();

  const node = activeNode;
  activeNode = null;
  if (node) {
    try {
      await node.stop();
    } catch (err) {
      log.warn('[IPFS] Error while stopping freedom-ipfs native node:', err.message);
    }
  }

  updateState(STATUS.STOPPED);
  clearErrorState('ipfs');
  clearService('ipfs');
}

// Public entry points. Each returns a promise that resolves once the transition
// has fully settled, so awaiting start()/stop() yields the final node status.
function startIpfs() {
  return enqueueOp(doStartIpfs);
}

function stopIpfs() {
  return enqueueOp(doStopIpfs);
}

async function serveNativeGatewayRequest({ path: gatewayPath, method, headers, signal }) {
  if (!activeNode || currentState !== STATUS.RUNNING || !checkHealth()) {
    return new Response(
      JSON.stringify({ code: 503, message: 'freedom-ipfs node is not running' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }
  return activeNode.request({ method, path: gatewayPath, headers, signal });
}

function getNativeDiagnostics() {
  const diagnostics = defaultNativeDiagnostics();
  if (!activeNode) return diagnostics;

  try {
    diagnostics.progress = activeNode.progressSnapshotJson();
  } catch (err) {
    log.warn('[IPFS] Failed to collect native progress diagnostics:', err.message);
  }

  try {
    diagnostics.nativeGatewayStats = activeNode.nativeGatewayStatsJson();
  } catch (err) {
    log.warn('[IPFS] Failed to collect native gateway diagnostics:', err.message);
  }

  diagnostics.nativeVersion = readNativeVersion(activeNode);
  diagnostics.nativeBuildInfo = readNativeBuildInfoJson(activeNode);
  return diagnostics;
}

function setUseInjectedIdentity(enabled) {
  log.info(`[IPFS] Ignoring injected identity mode for freedom-ipfs native node: ${enabled}`);
}

function hasInjectedIdentity() {
  return false;
}

function getActivePort() {
  return null;
}

function getActiveGatewayPort() {
  return null;
}

function registerIpfsIpc() {
  ipcMain.handle(IPC.IPFS_START, async () => {
    await startIpfs();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.IPFS_STOP, async () => {
    await stopIpfs();
    return { status: currentState, error: lastError };
  });

  ipcMain.handle(IPC.IPFS_GET_STATUS, () => {
    return { status: currentState, error: lastError, diagnostics: getNativeDiagnostics() };
  });

  ipcMain.handle(IPC.IPFS_CHECK_BINARY, () => {
    return { available: checkBinary() };
  });
}

module.exports = {
  registerIpfsIpc,
  startIpfs,
  stopIpfs,
  getActivePort,
  getActiveGatewayPort,
  getIpfsDataPath,
  setUseInjectedIdentity,
  hasInjectedIdentity,
  serveNativeGatewayRequest,
  getNativeDiagnostics,
  getStatus,
  checkHealth,
  STATUS,
};
