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

// Which backend is currently serving `ipfs://` / `ipns://`. BUNDLED is the
// in-process freedom-ipfs native node; EXTERNAL routes gateway requests to a
// user-provided HTTP gateway (e.g. a local Kubo / IPFS Desktop on :8080). The
// external path is the escape hatch when the native addon cannot load
let currentMode = MODE.BUNDLED;
let externalGatewayUrl = null;

// `active_native_handles` is the count of in-flight requests (registered at start,
// released when the response stream ends/cancels/errors) and `bytes_read` is the
// running total of bytes actually streamed through, counted as they pass, not from
// Content-Length
let externalActiveRequests = 0;
let externalBytesServed = 0;

// Detected from the node's RPC API when reachable.
// Null until detected / when the gateway exposes no recognizable RPC.
let externalGatewayVersion = null;

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

function isExternalIpfsConfig(config = getProfileIpfsConfig()) {
  return config?.mode === 'external';
}

// Accept a bare host:port or a full URL and return a canonical http(s) origin
// with no trailing slash, or null when the value is unusable. Mirrors the
// externalApi normalization Ant uses so both nodes accept the same shapes.
function normalizeExternalGatewayUrl(rawUrl) {
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

function getEndpointLabel(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

// The user configures only the gateway (e.g. :8080), but Kubo's RPC API answers
// POST /api/v0/version with the running version. We derive the host from the
// configured gateway URL and try the RPC there. Any failure just yields null and the
// UI falls back to showing the gateway endpoint, so this only ever adds information.
function kuboVersionUrl(gatewayUrl) {
  try {
    const parsed = new URL(gatewayUrl);
    // ASSUMPTION: the RPC API is on port 5001 on the same host as the gateway.
    // This is Kubo's conventional default and it is NOT user-configured.
    // If a deployment moves the RPC port, version detection simply fails.
    return `${parsed.protocol}//${parsed.hostname}:5001/api/v0/version`;
  } catch {
    return null;
  }
}

async function detectExternalGatewayVersion(gatewayUrl, { timeoutMs = 2000 } = {}) {
  const url = kuboVersionUrl(gatewayUrl);
  if (!url) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    const version = typeof data?.Version === 'string' ? data.Version.trim() : '';
    return version ? `Kubo ${version}` : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Probe an external IPFS gateway by requesting the empty-file CID `bafkqaaa`,
// which every gateway resolves locally.
// A 2xx/3xx answer means a real gateway is listening and anything else is treated
// as unreachable. Uses the same fetch stack that serves real gateway requests,
// so the health probe can't disagree with a working request path.
async function probeExternalGateway(gatewayUrl, { timeoutMs = 2000 } = {}) {
  if (!gatewayUrl) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${gatewayUrl}/ipfs/bafkqaaa`, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
    });
    // Drain the body so the socket is released promptly.
    res.body?.cancel?.().catch(() => {});
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
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
  healthCheckInterval = setInterval(async () => {
    if (currentMode === MODE.EXTERNAL) {
      // Soft health: an external gateway (e.g. Kubo) may briefly stop answering
      // while busy, so surface the outage without tearing down external mode and
      // recover automatically when it responds again.
      const isHealthy = await probeExternalGateway(externalGatewayUrl);
      if (!isHealthy && currentState === STATUS.RUNNING) {
        updateState(STATUS.ERROR, 'External IPFS gateway is unreachable');
        setErrorState('ipfs', 'External node unreachable. Retrying…');
      } else if (isHealthy && currentState === STATUS.ERROR) {
        clearErrorState('ipfs');
        updateState(STATUS.RUNNING);
      }
      return;
    }

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
  currentMode = MODE.DISABLED;
  externalGatewayUrl = null;
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

// Route `ipfs://` / `ipns://` gateway requests to a user-provided external HTTP
// gateway instead of the in-process native node. This is what lets IPFS work on
// hosts where the native addon cannot load
async function startExternalIpfs(config) {
  const url = normalizeExternalGatewayUrl(config?.externalGateway);
  if (!url) {
    updateState(STATUS.ERROR, 'External IPFS gateway is not configured');
    setStatusMessage('ipfs', 'External node not configured');
    return;
  }

  const reachable = await probeExternalGateway(url);
  if (!reachable) {
    updateState(STATUS.ERROR, 'External IPFS gateway is unreachable');
    setStatusMessage('ipfs', 'External node unreachable');
    return;
  }

  externalGatewayUrl = url;
  currentMode = MODE.EXTERNAL;
  externalActiveRequests = 0;
  externalBytesServed = 0;
  externalGatewayVersion = null;
  clearService('ipfs');
  updateService('ipfs', {
    api: null,
    gateway: url,
    mode: MODE.EXTERNAL,
    backend: 'external-gateway',
  });
  setStatusMessage('ipfs', `External node: ${getEndpointLabel(url)}`);
  updateState(STATUS.RUNNING);
  startHealthCheck();
  log.info('[IPFS] Connected to external gateway at', url);

  // Identify the gateway in the background. The nodes menu picks
  // it up on its next stats poll. Ignored if the mode/endpoint changed meanwhile.
  detectExternalGatewayVersion(url)
    .then((version) => {
      if (version && currentMode === MODE.EXTERNAL && externalGatewayUrl === url) {
        externalGatewayVersion = version;
        log.info('[IPFS] External gateway identified as', version);
      }
    })
    .catch(() => {});
}

async function doStartIpfs() {
  if (currentState === STATUS.RUNNING || currentState === STATUS.STARTING) {
    log.info(`[IPFS] Ignoring start request, current state: ${currentState}`);
    return;
  }

  updateState(STATUS.STARTING);

  const profileConfig = getProfileIpfsConfig();

  if (isDisabledIpfsConfig(profileConfig)) {
    startDisabledIpfs();
    return;
  }

  if (isExternalIpfsConfig(profileConfig)) {
    await startExternalIpfs(profileConfig);
    return;
  }

  // Native (bundled) path from here on.
  currentMode = MODE.BUNDLED;
  externalGatewayUrl = null;

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

// After a stop, keep the registry reflecting the profile's configured mode so
// the renderer can still tell an external-capable node (togglable back on) from
// a native one it can't control. Without this the nodes toggle could never be
// switched back on once the external node was stopped.
function publishStoppedIpfsMode() {
  const config = getProfileIpfsConfig();
  if (isExternalIpfsConfig(config)) {
    updateService('ipfs', {
      api: null,
      gateway: normalizeExternalGatewayUrl(config.externalGateway),
      mode: MODE.EXTERNAL,
      backend: 'external-gateway',
    });
    setStatusMessage('ipfs', 'External node stopped');
    return;
  }
  clearService('ipfs');
}

async function doStopIpfs() {
  if (currentState === STATUS.STOPPED && !activeNode) {
    publishStoppedIpfsMode();
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

  currentMode = MODE.BUNDLED;
  externalGatewayUrl = null;
  externalGatewayVersion = null;
  clearErrorState('ipfs');
  // Publish the profile mode to the registry BEFORE the status update
  publishStoppedIpfsMode();
  updateState(STATUS.STOPPED);
}

// Public entry points. Each returns a promise that resolves once the transition
// has fully settled, so awaiting start()/stop() yields the final node status.
function startIpfs() {
  return enqueueOp(doStartIpfs);
}

function stopIpfs() {
  return enqueueOp(doStopIpfs);
}

// Proxy a gateway request to the configured external HTTP gateway. The protocol
// handler already canonicalizes the path to the `/ipfs/<cid>...` / `/ipns/<name>...`
// contract every gateway understands, so we just forward it verbatim.
// Wrap an upstream body so bytes are tallied as they stream to the caller and
// the in-flight counter is released exactly once when the stream ends, is
// cancelled, or errors.
function countingGatewayStream(upstreamBody, release) {
  const reader = upstreamBody.getReader();
  let released = false;
  const finish = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          finish();
          return;
        }
        externalBytesServed += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        finish();
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
      finish();
    },
  });
}

async function serveExternalGatewayRequest({ path: gatewayPath, method, headers, signal }) {
  if (currentState !== STATUS.RUNNING || !externalGatewayUrl) {
    return new Response(
      JSON.stringify({ code: 503, message: 'external IPFS gateway is not running' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  externalActiveRequests += 1;
  let handled = false;
  const releaseHandle = () => {
    if (handled) return;
    handled = true;
    externalActiveRequests = Math.max(0, externalActiveRequests - 1);
  };

  try {
    const upstream = await fetch(`${externalGatewayUrl}${gatewayPath}`, {
      method: method || 'GET',
      headers,
      signal,
      redirect: 'follow',
    });

    // No body to stream (HEAD, 204/304, etc.): the request is already complete.
    if (!upstream.body) {
      releaseHandle();
      return upstream;
    }

    return new Response(countingGatewayStream(upstream.body, releaseHandle), {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  } catch (err) {
    releaseHandle();
    if (err?.name === 'AbortError') throw err;
    log.warn(`[IPFS] External gateway request failed for ${gatewayPath}: ${err?.message || err}`);
    return new Response(
      JSON.stringify({ code: 502, message: 'external IPFS gateway request failed' }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }
}

async function serveNativeGatewayRequest({ path: gatewayPath, method, headers, signal }) {
  if (currentMode === MODE.EXTERNAL) {
    return serveExternalGatewayRequest({ path: gatewayPath, method, headers, signal });
  }

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
  if (currentMode === MODE.EXTERNAL) {
    return {
      progress: '{"active":[],"events":[]}',
      nativeGatewayStats: JSON.stringify({
        active_native_handles: externalActiveRequests,
        bytes_read: externalBytesServed,
      }),
      nativeVersion: null,
      nativeBuildInfo: null,
      externalGateway: externalGatewayUrl,
      externalVersion: externalGatewayVersion,
    };
  }

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
  checkHealth,
  isExternalIpfsConfig,
  normalizeExternalGatewayUrl,
  probeExternalGateway,
  STATUS,
};
