/**
 * Swarm Connect Module
 *
 * Connection approval UI for Swarm publishing access, plus
 * the Swarm connection banner in the sidebar.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { getPermissionKey } from '../dapp-provider.js';

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

// Local state
let swarmConnectPending = null;
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

  registerScreenHider(() => swarmConnectScreen?.classList.add('hidden'));

  setupSwarmConnectScreen();
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

    swarmConnectionBanner?.classList.add('hidden');
    currentBannerPermissionKey = null;
  } catch (err) {
    console.error('[SwarmConnect] Failed to disconnect:', err);
  }
}
