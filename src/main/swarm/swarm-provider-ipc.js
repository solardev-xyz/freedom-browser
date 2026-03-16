/**
 * Swarm Provider IPC — Main-Process Enforcement Layer
 *
 * The authority for all page-facing Swarm provider requests.
 * The renderer shows prompts and provides fast UX feedback, but this
 * module re-validates everything before executing.
 *
 * Single IPC handler: swarm:provider-execute
 *   Receives { method, params, origin } from renderer.
 *   Checks permissions, validates params, runs pre-flight, dispatches.
 *
 * Trust model for origin:
 *   The main process trusts the origin string from the renderer because:
 *   (a) The renderer is Freedom's own code, not arbitrary web content.
 *   (b) The renderer derives origin from the per-webview display URL
 *       (via getDisplayUrlForWebview), not from the page's window.location
 *       which is http://127.0.0.1:port for all dweb pages.
 *   (c) webContents.getURL() cannot be used because dweb pages resolve
 *       through the request-rewriter — the internal URL doesn't carry
 *       the dweb protocol identity (bzz://, ens://, ipfs://).
 *   The renderer is the only process that can map webview → tab → display URL.
 */

const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { getPermission } = require('./swarm-permissions');
const { getBeeApiUrl } = require('../service-registry');
const log = require('electron-log');

const LIMITS = {
  maxDataBytes: 10 * 1024 * 1024,    // 10 MB
  maxFilesBytes: 50 * 1024 * 1024,   // 50 MB
  maxFileCount: 100,
};

const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Origin not authorized' },
  UNSUPPORTED_METHOD: { code: 4200, message: 'Method not supported' },
  NODE_UNAVAILABLE: { code: 4900, message: 'Swarm node is not available' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid parameters' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

const KNOWN_METHODS = [
  'swarm_requestAccess',
  'swarm_getCapabilities',
  'swarm_publishData',
  'swarm_publishFiles',
  'swarm_getUploadStatus',
];

// Methods that will be implemented in WP3-C/D
const STUBBED_METHODS = [
  'swarm_publishData',
  'swarm_publishFiles',
  'swarm_getUploadStatus',
];

/**
 * Execute a Swarm provider method.
 * @param {string} method
 * @param {*} params
 * @param {string} origin - Normalized origin from renderer
 * @returns {{ result?, error? }}
 */
async function executeSwarmMethod(method, params, origin) {
  try {
    if (!method || typeof method !== 'string') {
      return { error: { ...ERRORS.INVALID_PARAMS, message: 'Method is required' } };
    }

    if (!KNOWN_METHODS.includes(method)) {
      return { error: { ...ERRORS.UNSUPPORTED_METHOD, message: `Unknown method: ${method}` } };
    }

    const normalizedOrigin = normalizeOrigin(origin);

    // swarm_requestAccess: verify the renderer already granted permission
    if (method === 'swarm_requestAccess') {
      return handleRequestAccess(normalizedOrigin);
    }

    // swarm_getCapabilities: no permission required (returns coarse info)
    if (method === 'swarm_getCapabilities') {
      return handleGetCapabilities(normalizedOrigin);
    }

    // All other methods require permission
    const permission = getPermission(normalizedOrigin);
    if (!permission) {
      return { error: { ...ERRORS.UNAUTHORIZED, message: 'Origin not authorized. Call swarm_requestAccess first.' } };
    }

    // Stubbed methods — not yet implemented
    if (STUBBED_METHODS.includes(method)) {
      return {
        error: {
          ...ERRORS.UNSUPPORTED_METHOD,
          message: `${method} is not yet implemented. Coming in a future update.`,
        },
      };
    }

    return { error: ERRORS.INTERNAL_ERROR };
  } catch (err) {
    log.error('[SwarmProvider] executeSwarmMethod failed:', err.message);
    return { error: { ...ERRORS.INTERNAL_ERROR, message: err.message } };
  }
}

function handleRequestAccess(origin) {
  const permission = getPermission(origin);
  if (!permission) {
    return { error: { ...ERRORS.UNAUTHORIZED, message: 'Permission not granted. Renderer should show prompt first.' } };
  }
  return { result: { connected: true, origin, capabilities: ['publish'] } };
}

async function handleGetCapabilities(origin) {
  const permission = getPermission(origin);
  const isConnected = !!permission;

  const preFlight = await checkSwarmPreFlight();

  return {
    result: {
      canPublish: isConnected && preFlight.ok,
      reason: !isConnected ? 'not-connected' : (preFlight.ok ? null : preFlight.reason),
      limits: {
        maxDataBytes: LIMITS.maxDataBytes,
        maxFilesBytes: LIMITS.maxFilesBytes,
        maxFileCount: LIMITS.maxFileCount,
      },
    },
  };
}

/**
 * Pre-flight check: is Bee running, in light mode, with usable stamps?
 * @returns {{ ok: boolean, reason?: string }}
 */
async function checkSwarmPreFlight() {
  try {
    const beeUrl = getBeeApiUrl();
    if (!beeUrl) {
      return { ok: false, reason: 'node-stopped' };
    }

    // Check node mode
    const nodeRes = await fetch(`${beeUrl}/node`);
    if (!nodeRes.ok) {
      return { ok: false, reason: 'node-stopped' };
    }
    const nodeData = await nodeRes.json();
    const beeMode = nodeData.beeMode || '';
    if (beeMode === 'ultra-light' || beeMode === 'ultralight') {
      return { ok: false, reason: 'ultra-light-mode' };
    }

    // Check readiness
    const readinessRes = await fetch(`${beeUrl}/readiness`);
    if (!readinessRes.ok) {
      return { ok: false, reason: 'node-not-ready' };
    }

    // Check for usable stamps
    const stampsRes = await fetch(`${beeUrl}/stamps`);
    if (!stampsRes.ok) {
      return { ok: false, reason: 'no-usable-stamps' };
    }
    const stampsData = await stampsRes.json();
    const stamps = Array.isArray(stampsData.stamps) ? stampsData.stamps : [];
    const usable = stamps.filter((s) => s.usable === true);
    if (usable.length === 0) {
      return { ok: false, reason: 'no-usable-stamps' };
    }

    return { ok: true };
  } catch (err) {
    log.error('[SwarmProvider] Pre-flight check failed:', err.message);
    return { ok: false, reason: 'node-stopped' };
  }
}

/**
 * Register the swarm:provider-execute IPC handler.
 */
function registerSwarmProviderIpc() {
  ipcMain.handle(IPC.SWARM_PROVIDER_EXECUTE, async (_event, args) => {
    const { method, params, origin } = args || {};
    return executeSwarmMethod(method, params, origin);
  });

  log.info('[SwarmProvider] IPC handler registered');
}

module.exports = {
  registerSwarmProviderIpc,
  executeSwarmMethod,
  checkSwarmPreFlight,
  LIMITS,
};
