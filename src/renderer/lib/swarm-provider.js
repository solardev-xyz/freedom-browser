/**
 * Swarm Provider Handler (Renderer Side)
 *
 * Handles Swarm provider requests from webviews:
 * - Routes swarm_requestAccess through connection approval UI
 * - Forwards validated requests to main process (the authority)
 * - Fast-fail checks for feature gate and basic validation
 *
 * Communication flow:
 * webview (window.swarm) → renderer (this) → main (swarm-provider-ipc.js)
 */

import { getPermissionKey } from './dapp-provider.js';
import { getDisplayUrlForWebview, getNavigationKeyForWebview } from './tabs.js';
import { showSwarmConnect, updateSwarmConnectionBanner, showSwarmPublishApproval, showSwarmFeedApproval, showSwarmMessagingApproval, showVaultUnlock, showPermissionManifest } from './wallet-ui.js';

const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Origin not authorized' },
  DISCONNECTED: { code: 4900, message: 'Swarm provider is not available' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

// Feature flag state (same pattern as dapp-provider.js)
let identityWalletEnabled = false;
const manifestChecks = new WeakMap();
const PUBLIC_METHODS = new Set([
  'swarm_getCapabilities',
  'swarm_readFeedEntry',
  'swarm_readChunk',
  'swarm_readSingleOwnerChunk',
  'swarm_listFeeds',
  'swarm_unsubscribe',
]);

window.electronAPI?.getSettings?.().then((settings) => {
  identityWalletEnabled = settings?.enableIdentityWallet === true;
}).catch(() => {});
window.addEventListener('settings:updated', (event) => {
  identityWalletEnabled = event.detail?.enableIdentityWallet === true;
});

/**
 * Setup Swarm provider request listener for a webview.
 * Called from tabs.js when creating a webview.
 */
export function setupSwarmProvider(webview) {
  if (!webview) return;

  webview.addEventListener('ipc-message', (event) => {
    if (event.channel === 'swarm:provider-request') {
      const request = event.args[0];
      handleSwarmRequest(webview, request);
    }
  });
}

/**
 * Handle a Swarm provider request from a webview.
 */
async function handleSwarmRequest(webview, request) {
  const { id, method, params } = request;

  // Gate: reject if feature disabled
  if (!identityWalletEnabled) {
    sendSwarmResponse(webview, id, null, ERRORS.DISCONNECTED);
    return;
  }

  const displayUrl = getDisplayUrlForWebview(webview);
  const permissionKey = getPermissionKey(displayUrl);

  try {
    let result;

    if (!PUBLIC_METHODS.has(method)) {
      await ensureManifestFresh(webview, displayUrl, permissionKey, method === 'swarm_requestAccess');
    }

    if (method === 'swarm_requestAccess') {
      result = await handleRequestAccess(webview, displayUrl, permissionKey);
    } else if (method === 'swarm_getCapabilities') {
      // No prompt needed — coarse capability info, safe for any origin
      result = await forwardToMain(method, params, permissionKey);
    } else if (method === 'swarm_publishData' || method === 'swarm_publishFiles' || method === 'swarm_publishChunk') {
      const permission = await requirePermissionAndReturn(permissionKey);

      if (!permission?.autoApprove?.publish) {
        await new Promise((resolve, reject) => {
          showSwarmPublishApproval(permissionKey, params, resolve, reject, method);
        });
      }

      result = await executeWithPermission(method, params, permissionKey);
    } else if (
      method === 'swarm_readFeedEntry' ||
      method === 'swarm_readChunk' ||
      method === 'swarm_readSingleOwnerChunk'
    ) {
      // No permission required — feeds/chunks are public Swarm data
      result = await forwardToMain(method, params, permissionKey);
    } else if (method === 'swarm_listFeeds') {
      // No permission required — origin-scoped introspection of own feed metadata
      result = await forwardToMain(method, params, permissionKey);
    } else if (
      method === 'swarm_createFeed' ||
      method === 'swarm_updateFeed' ||
      method === 'swarm_writeFeedEntry'
    ) {
      result = await handleFeedSigningRequest(method, params, permissionKey, 'feeds');
    } else if (
      method === 'swarm_writeSingleOwnerChunk' ||
      method === 'swarm_getSigningIdentity'
    ) {
      result = await handleFeedSigningRequest(method, params, permissionKey, 'signing');
    } else if (
      method === 'swarm_getMessagingIdentity' ||
      method === 'swarm_subscribe' ||
      method === 'swarm_unsubscribe' ||
      method === 'swarm_sendPss' ||
      method === 'swarm_sendGsoc'
    ) {
      result = await handleMessagingRequest(method, params, permissionKey, webview);
    } else {
      // All other methods: check permission, forward to main
      result = await executeWithPermission(method, params, permissionKey);
    }

    sendSwarmResponse(webview, id, result, null);
  } catch (error) {
    sendSwarmResponse(webview, id, null, {
      code: error.code || ERRORS.INTERNAL_ERROR.code,
      message: error.message || ERRORS.INTERNAL_ERROR.message,
      data: error.data,
    });
  }
}

async function ensureManifestFresh(webview, committedUrl, permissionKey, eager) {
  if (!window.swarmManifest?.check || !permissionKey) return;
  const navigationKey = getNavigationKeyForWebview(webview);
  let navigationCache = manifestChecks.get(webview);
  if (!navigationCache || navigationCache.key !== navigationKey) {
    navigationCache = { key: navigationKey, origins: new Map() };
    manifestChecks.set(webview, navigationCache);
  }
  let cached = navigationCache.origins.get(permissionKey);
  if (!cached || (eager && !cached.eager)) {
    cached = {
      eager,
      promise: performManifestRefresh({ permissionKey, committedUrl, navigationKey, eager }),
    };
    navigationCache.origins.set(permissionKey, cached);
  }

  try {
    await cached.promise;
  } catch (err) {
    if (err?.code !== ERRORS.USER_REJECTED.code && navigationCache.origins.get(permissionKey) === cached) {
      navigationCache.origins.delete(permissionKey);
    }
    throw err;
  }
}

async function performManifestRefresh({ permissionKey, committedUrl, navigationKey, eager }) {
  const result = await window.swarmManifest.check({
    origin: permissionKey,
    committedUrl,
    navigationKey,
    eager,
  });
  if (result.kind === 'unresolved') {
    throw { ...ERRORS.DISCONNECTED, message: 'Could not refresh this app’s permission manifest' };
  }
  if (result.kind !== 'consent') return;

  const outcome = await showPermissionManifest(result.model, result.token);
  const decision = await window.swarmManifest.decide(result.token, outcome);
  if (!decision.allowed) throw ERRORS.USER_REJECTED;
}

/**
 * Messaging methods (PSS/GSOC). The messaging tier is granted once per
 * origin via the messaging prompt; sends additionally require per-send
 * approval unless the origin has messaging auto-approve. Unsubscribe is
 * teardown and never prompts.
 */
async function handleMessagingRequest(method, params, permissionKey, webview) {
  await requirePermission(permissionKey);

  const isSend = method === 'swarm_sendPss' || method === 'swarm_sendGsoc';

  if (method !== 'swarm_unsubscribe') {
    const [hasGrant, autoApproved] = await Promise.all([
      window.swarmPermissions.hasMessagingGrant(permissionKey),
      isSend ? window.swarmPermissions.getAutoApprove(permissionKey, 'messaging') : false,
    ]);
    if (!hasGrant) {
      await new Promise((resolve, reject) => {
        showSwarmMessagingApproval(permissionKey, params, resolve, reject, { method, grantMode: true });
      });
      await window.swarmPermissions.grantMessaging(permissionKey);
    } else if (isSend && !autoApproved) {
      await new Promise((resolve, reject) => {
        showSwarmMessagingApproval(permissionKey, params, resolve, reject, { method, grantMode: false });
      });
    }
  }

  // Subscriptions push messages back to the page: main needs to know
  // which webview to deliver to, and only the renderer can map the
  // request to its webContents.
  const meta = method === 'swarm_subscribe'
    ? { webContentsId: webview.getWebContentsId() }
    : undefined;

  return executeWithPermission(method, params, permissionKey, meta);
}

async function handleFeedSigningRequest(method, params, permissionKey, autoApproveType) {
  await requirePermission(permissionKey);

  const [hasFeedAccess, vaultStatus] = await Promise.all([
    window.swarmFeedStore?.hasFeedGrant?.(permissionKey),
    window.identity?.getStatus?.(),
  ]);
  const vaultLocked = !vaultStatus?.isUnlocked;

  if (!hasFeedAccess) {
    await new Promise((resolve, reject) => {
      showSwarmFeedApproval(permissionKey, params, resolve, reject, { method, autoApproveType });
    });
  } else if (vaultLocked) {
    await showVaultUnlock(permissionKey);
  } else {
    const autoApproved = await window.swarmPermissions.getAutoApprove(permissionKey, autoApproveType);
    if (!autoApproved) {
      await new Promise((resolve, reject) => {
        showSwarmFeedApproval(permissionKey, params, resolve, reject, { method, autoApproveType });
      });
    }
  }

  return executeWithPermission(method, params, permissionKey);
}

/**
 * Check that the origin has Swarm permission. Throws UNAUTHORIZED if not.
 */
async function requirePermission(permissionKey) {
  const permission = await window.swarmPermissions.getPermission(permissionKey);
  if (!permission) {
    throw { ...ERRORS.UNAUTHORIZED, message: 'Origin not authorized. Call swarm_requestAccess first.' };
  }
}

/**
 * Same as requirePermission but returns the permission object for callers
 * that need to inspect it (e.g., checking autoApprove) without a second IPC.
 */
async function requirePermissionAndReturn(permissionKey) {
  const permission = await window.swarmPermissions.getPermission(permissionKey);
  if (!permission) {
    throw { ...ERRORS.UNAUTHORIZED, message: 'Origin not authorized. Call swarm_requestAccess first.' };
  }
  return permission;
}

/**
 * Check permission, update lastUsed, forward to main, unwrap result.
 * @param {Object} [meta] - Renderer-only routing info passed to main
 *   (e.g. the subscribing webview's webContentsId).
 */
async function executeWithPermission(method, params, permissionKey, meta) {
  await requirePermission(permissionKey);
  await window.swarmPermissions.updateLastUsed(permissionKey);
  const response = await window.swarmProvider.execute(method, params, permissionKey, meta);
  if (response.error) throw response.error;
  return response.result;
}

/**
 * Forward to main without any permission check — used for public-data
 * methods like swarm_getCapabilities and swarm_readFeedEntry where the
 * origin doesn't need to have called requestAccess.
 */
async function forwardToMain(method, params, permissionKey) {
  const response = await window.swarmProvider.execute(method, params, permissionKey);
  if (response.error) throw response.error;
  return response.result;
}

/**
 * Handle swarm_requestAccess: check existing permission or show prompt.
 */
async function handleRequestAccess(webview, displayUrl, permissionKey) {
  // Check if already connected
  const existing = await window.swarmPermissions.getPermission(permissionKey);
  if (existing) {
    await window.swarmPermissions.updateLastUsed(permissionKey);
    // Verify with main process
    const response = await window.swarmProvider.execute('swarm_requestAccess', {}, permissionKey);
    if (response.error) throw response.error;
    updateSwarmConnectionBanner(permissionKey);
    return response.result;
  }

  // Show connection approval UI (returns promise that resolves on approve or rejects on cancel)
  const connectResult = await new Promise((resolve, reject) => {
    showSwarmConnect(displayUrl, permissionKey, resolve, reject, webview);
  });

  return connectResult;
}

/**
 * Send a response back to the webview.
 */
function sendSwarmResponse(webview, id, result, error) {
  if (webview && webview.send) {
    webview.send('swarm:provider-response', { id, result, error });
  }
}

/**
 * Send an event to a webview.
 */
export function sendSwarmEvent(webview, event, data) {
  if (webview && webview.send) {
    webview.send('swarm:provider-event', { event, data });
  }
}
