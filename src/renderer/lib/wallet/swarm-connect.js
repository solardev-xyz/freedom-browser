/**
 * Swarm Connect Module
 *
 * Connection approval UI for Swarm publishing access, plus
 * the Swarm connection banner in the sidebar.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { formatBytes } from './wallet-utils.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { getPermissionKey, getActiveWebview } from '../dapp-provider.js';

// DOM references — connect screen
let swarmConnectScreen;
let swarmConnectBackBtn;
let swarmConnectSite;
let swarmConnectRejectBtn;
let swarmConnectApproveBtn;

// DOM references — connection banner
let swarmConnectionBanner;
let swarmConnectionSite;
let swarmConnectionDisconnect;

// DOM references — publish approval screen
let swarmPublishScreen;
let swarmPublishBackBtn;
let swarmPublishSite;
let swarmPublishType;
let swarmPublishSize;
let swarmPublishNameRow;
let swarmPublishName;
let swarmPublishPathsRow;
let swarmPublishPaths;
let swarmPublishRejectBtn;
let swarmPublishConfirmBtn;

// Local state
let swarmConnectPending = null;
let swarmPublishPending = null;
let currentBannerPermissionKey = null;

export function initSwarmConnect() {
  swarmConnectScreen = document.getElementById('sidebar-swarm-connect');
  swarmConnectBackBtn = document.getElementById('swarm-connect-back');
  swarmConnectSite = document.getElementById('swarm-connect-site');
  swarmConnectRejectBtn = document.getElementById('swarm-connect-reject');
  swarmConnectApproveBtn = document.getElementById('swarm-connect-approve');

  swarmConnectionBanner = document.getElementById('swarm-connection-banner');
  swarmConnectionSite = document.getElementById('swarm-connection-site');
  swarmConnectionDisconnect = document.getElementById('swarm-connection-disconnect');

  swarmPublishScreen = document.getElementById('sidebar-swarm-publish-approve');
  swarmPublishBackBtn = document.getElementById('swarm-publish-back');
  swarmPublishSite = document.getElementById('swarm-publish-site');
  swarmPublishType = document.getElementById('swarm-publish-type');
  swarmPublishSize = document.getElementById('swarm-publish-size');
  swarmPublishNameRow = document.getElementById('swarm-publish-name-row');
  swarmPublishName = document.getElementById('swarm-publish-name');
  swarmPublishPathsRow = document.getElementById('swarm-publish-paths-row');
  swarmPublishPaths = document.getElementById('swarm-publish-paths');
  swarmPublishRejectBtn = document.getElementById('swarm-publish-reject');
  swarmPublishConfirmBtn = document.getElementById('swarm-publish-confirm');

  registerScreenHider(() => {
    // Only reject if the screen was actually visible (not already hidden).
    // hideAllSubscreens() fires all hiders — including this one — when
    // showing a new screen, so we must not reject during that transition.
    const wasVisible = swarmConnectScreen && !swarmConnectScreen.classList.contains('hidden');
    swarmConnectScreen?.classList.add('hidden');
    if (wasVisible && swarmConnectPending) {
      swarmConnectPending.reject({ code: 4001, message: 'User dismissed prompt' });
      swarmConnectPending = null;
    }
  });
  registerScreenHider(() => {
    const wasVisible = swarmPublishScreen && !swarmPublishScreen.classList.contains('hidden');
    swarmPublishScreen?.classList.add('hidden');
    if (wasVisible && swarmPublishPending) {
      swarmPublishPending.reject({ code: 4001, message: 'User dismissed prompt' });
      swarmPublishPending = null;
    }
  });

  setupSwarmConnectScreen();
  setupSwarmPublishScreen();
}

function setupSwarmConnectScreen() {
  if (swarmConnectBackBtn) {
    swarmConnectBackBtn.addEventListener('click', () => {
      rejectSwarmConnect();
      closeSwarmConnect();
    });
  }

  if (swarmConnectRejectBtn) {
    swarmConnectRejectBtn.addEventListener('click', () => {
      rejectSwarmConnect();
      closeSwarmConnect();
    });
  }

  if (swarmConnectApproveBtn) {
    swarmConnectApproveBtn.addEventListener('click', approveSwarmConnect);
  }

  if (swarmConnectionDisconnect) {
    swarmConnectionDisconnect.addEventListener('click', disconnectCurrentSwarmApp);
  }

  document.addEventListener('sidebar-opened', () => {
    updateSwarmConnectionBanner();
  });

  document.addEventListener('navigation-completed', () => {
    if (isSidebarVisible()) {
      updateSwarmConnectionBanner();
    }
  });
}

/**
 * Show the Swarm connect approval screen.
 */
export function showSwarmConnect(displayUrl, permissionKey, resolve, reject, webview) {
  swarmConnectPending = { permissionKey, resolve, reject, webview };

  if (swarmConnectSite) {
    swarmConnectSite.textContent = permissionKey || displayUrl || 'Unknown';
  }

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmConnectScreen?.classList.remove('hidden');

  openSidebarPanel();
}

function closeSwarmConnect() {
  swarmConnectScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmConnectPending = null;
}

async function approveSwarmConnect() {
  if (!swarmConnectPending) return;

  const { permissionKey, resolve, webview } = swarmConnectPending;

  try {
    await window.swarmPermissions.grantPermission(permissionKey);

    // Round-trip through main process (the authority) to confirm
    const response = await window.swarmProvider.execute('swarm_requestAccess', {}, permissionKey);
    if (response.error) {
      throw response.error;
    }

    resolve(response.result);

    if (webview && webview.send) {
      webview.send('swarm:provider-event', {
        event: 'connect',
        data: { origin: permissionKey },
      });
    }

    console.log('[SwarmConnect] Approved:', permissionKey);
    updateSwarmConnectionBanner(permissionKey);
  } catch (err) {
    console.error('[SwarmConnect] Failed to grant permission:', err);
  }

  closeSwarmConnect();
}

function rejectSwarmConnect() {
  if (!swarmConnectPending) return;

  const { reject } = swarmConnectPending;
  reject({ code: 4001, message: 'User rejected Swarm access' });
  console.log('[SwarmConnect] Rejected');
}

/**
 * Update the Swarm connection banner for the current tab.
 */
export async function updateSwarmConnectionBanner(permissionKey = null) {
  if (!swarmConnectionBanner) return;

  if (!permissionKey) {
    const addressInput = document.getElementById('address-input');
    const displayUrl = addressInput?.value || '';
    permissionKey = getPermissionKey(displayUrl);
  }

  if (!permissionKey) {
    swarmConnectionBanner.classList.add('hidden');
    currentBannerPermissionKey = null;
    return;
  }

  try {
    const permission = await window.swarmPermissions.getPermission(permissionKey);

    if (permission) {
      if (swarmConnectionSite) {
        swarmConnectionSite.textContent = permissionKey;
      }
      currentBannerPermissionKey = permissionKey;
      swarmConnectionBanner.classList.remove('hidden');
    } else {
      swarmConnectionBanner.classList.add('hidden');
      currentBannerPermissionKey = null;
    }
  } catch (err) {
    console.error('[SwarmConnect] Failed to check connection:', err);
    swarmConnectionBanner.classList.add('hidden');
    currentBannerPermissionKey = null;
  }
}

async function disconnectCurrentSwarmApp() {
  if (!currentBannerPermissionKey) return;

  try {
    await window.swarmPermissions.revokePermission(currentBannerPermissionKey);
    console.log('[SwarmConnect] Disconnected:', currentBannerPermissionKey);

    // Emit disconnect event to the active webview
    const webview = getActiveWebview();
    if (webview && webview.send) {
      webview.send('swarm:provider-event', {
        event: 'disconnect',
        data: { origin: currentBannerPermissionKey },
      });
    }

    swarmConnectionBanner?.classList.add('hidden');
    currentBannerPermissionKey = null;
  } catch (err) {
    console.error('[SwarmConnect] Failed to disconnect:', err);
  }
}

// ============================================
// Per-publish approval prompt
// ============================================

function setupSwarmPublishScreen() {
  if (swarmPublishBackBtn) {
    swarmPublishBackBtn.addEventListener('click', () => {
      rejectSwarmPublish();
      closeSwarmPublishApproval();
    });
  }

  if (swarmPublishRejectBtn) {
    swarmPublishRejectBtn.addEventListener('click', () => {
      rejectSwarmPublish();
      closeSwarmPublishApproval();
    });
  }

  if (swarmPublishConfirmBtn) {
    swarmPublishConfirmBtn.addEventListener('click', () => {
      approveSwarmPublish();
      closeSwarmPublishApproval();
    });
  }
}

/**
 * Show the per-publish approval prompt.
 * Resolves on "Publish", rejects (code 4001) on "Cancel".
 */
export function showSwarmPublishApproval(permissionKey, params, resolve, reject) {
  swarmPublishPending = { resolve, reject };

  if (swarmPublishSite) {
    swarmPublishSite.textContent = permissionKey || 'Unknown';
  }

  const isFileMode = Array.isArray(params?.files);

  if (isFileMode) {
    // File mode: show file count, total size, path preview
    const fileCount = params.files.length;
    if (swarmPublishType) {
      swarmPublishType.textContent = `${fileCount} file${fileCount !== 1 ? 's' : ''}`;
    }
    if (swarmPublishSize) {
      const totalSize = params.files.reduce((sum, f) => {
        const b = f.bytes;
        return sum + (b?.length || b?.byteLength || b?.data?.length || 0);
      }, 0);
      swarmPublishSize.textContent = formatBytes(totalSize);
    }
    // Path preview: first 3 paths + "...and N more"
    if (swarmPublishPathsRow && swarmPublishPaths) {
      const paths = params.files.map((f) => f.path);
      const preview = paths.slice(0, 3).join(', ');
      const more = paths.length > 3 ? ` \u2026and ${paths.length - 3} more` : '';
      swarmPublishPaths.textContent = preview + more;
      swarmPublishPathsRow.classList.remove('hidden');
    }
    swarmPublishNameRow?.classList.add('hidden');
  } else {
    // Data mode: show content type, size, optional name
    if (swarmPublishType) {
      swarmPublishType.textContent = params?.contentType || 'unknown';
    }
    if (swarmPublishSize) {
      const data = params?.data;
      let size = 0;
      if (typeof data === 'string') {
        size = new Blob([data]).size;
      } else if (data instanceof ArrayBuffer) {
        size = data.byteLength;
      } else if (data?.length !== undefined) {
        size = data.length;
      }
      swarmPublishSize.textContent = formatBytes(size);
    }
    if (swarmPublishNameRow && swarmPublishName) {
      if (params?.name) {
        swarmPublishName.textContent = params.name;
        swarmPublishNameRow.classList.remove('hidden');
      } else {
        swarmPublishNameRow.classList.add('hidden');
      }
    }
    swarmPublishPathsRow?.classList.add('hidden');
  }

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmPublishScreen?.classList.remove('hidden');

  openSidebarPanel();
}

function closeSwarmPublishApproval() {
  swarmPublishScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmPublishPending = null;
}

function approveSwarmPublish() {
  if (!swarmPublishPending) return;
  const { resolve } = swarmPublishPending;
  resolve();
  console.log('[SwarmConnect] Publish approved');
}

function rejectSwarmPublish() {
  if (!swarmPublishPending) return;
  const { reject } = swarmPublishPending;
  reject({ code: 4001, message: 'User rejected publish' });
  console.log('[SwarmConnect] Publish rejected');
}
