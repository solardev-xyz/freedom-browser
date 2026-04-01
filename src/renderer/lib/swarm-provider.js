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
import { getDisplayUrlForWebview } from './tabs.js';
import { showSwarmConnect, updateSwarmConnectionBanner, showSwarmPublishApproval, showSwarmFeedApproval, showVaultUnlock } from './wallet-ui.js';

const ERRORS = {
  USER_REJECTED: { code: 4001, message: 'User rejected the request' },
  UNAUTHORIZED: { code: 4100, message: 'Origin not authorized' },
  DISCONNECTED: { code: 4900, message: 'Swarm provider is not available' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
};

// Feature flag state (same pattern as dapp-provider.js)
let identityWalletEnabled = false;

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

    if (method === 'swarm_requestAccess') {
      result = await handleRequestAccess(webview, displayUrl, permissionKey);
    } else if (method === 'swarm_getCapabilities') {
      // No prompt needed — forward directly to main
      const response = await window.swarmProvider.execute(method, params, permissionKey);
      if (response.error) throw response.error;
      result = response.result;
    } else if (method === 'swarm_publishData' || method === 'swarm_publishFiles') {
      const permission = await requirePermissionAndReturn(permissionKey);

      if (!permission?.autoApprove?.publish) {
        await new Promise((resolve, reject) => {
          showSwarmPublishApproval(permissionKey, params, resolve, reject);
        });
      }

      result = await executeWithPermission(method, params, permissionKey);
    } else if (method === 'swarm_createFeed' || method === 'swarm_updateFeed') {
      await requirePermission(permissionKey);

      const [hasFeedAccess, vaultStatus] = await Promise.all([
        window.swarmFeedStore?.hasFeedGrant?.(permissionKey),
        window.identity?.getStatus?.(),
      ]);
      const vaultLocked = !vaultStatus?.isUnlocked;

      if (!hasFeedAccess) {
        // First time or reconnect: full approval (identity choice + unlock)
        await new Promise((resolve, reject) => {
          showSwarmFeedApproval(permissionKey, params, resolve, reject);
        });
      } else if (vaultLocked) {
        // Has access but vault locked: minimal unlock prompt
        await showVaultUnlock(permissionKey);
      } else {
        // Has access + vault unlocked: check auto-approve
        const feedAutoApproved = await window.swarmPermissions.getAutoApprove(permissionKey, 'feeds');
        if (!feedAutoApproved) {
          await new Promise((resolve, reject) => {
            showSwarmFeedApproval(permissionKey, params, resolve, reject);
          });
        }
      }

      result = await executeWithPermission(method, params, permissionKey);
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
 */
async function executeWithPermission(method, params, permissionKey) {
  await requirePermission(permissionKey);
  await window.swarmPermissions.updateLastUsed(permissionKey);
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
