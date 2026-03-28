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
import { showSwarmPermissions } from './permission-manage.js';

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
let swarmAutoApproveBadge;
let swarmConnectionManage;

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
let swarmPublishAutoApproveCheckbox;

// DOM references — feed approval screen
let swarmFeedScreen;
let swarmFeedBackBtn;
let swarmFeedSite;
let swarmFeedName;
let swarmFeedRejectBtn;
let swarmFeedApproveBtn;

let swarmFeedAutoApproveCheckbox;

// DOM references — feed unlock section
let swarmFeedUnlock;
let swarmFeedTouchIdBtn;
let swarmFeedPasswordLink;
let swarmFeedPasswordSection;
let swarmFeedPasswordInput;
let swarmFeedPasswordSubmit;
let swarmFeedUnlockError;

// Local state
let swarmConnectPending = null;
let swarmPublishPending = null;
let swarmFeedPending = null;
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
  swarmAutoApproveBadge = document.getElementById('swarm-auto-approve-badge');
  swarmConnectionManage = document.getElementById('swarm-connection-manage');

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
  swarmPublishAutoApproveCheckbox = document.getElementById('swarm-publish-auto-approve');

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

  swarmFeedScreen = document.getElementById('sidebar-swarm-feed-approve');
  swarmFeedBackBtn = document.getElementById('swarm-feed-back');
  swarmFeedSite = document.getElementById('swarm-feed-site');
  swarmFeedName = document.getElementById('swarm-feed-name');
  swarmFeedRejectBtn = document.getElementById('swarm-feed-reject');
  swarmFeedApproveBtn = document.getElementById('swarm-feed-approve');

  swarmFeedAutoApproveCheckbox = document.getElementById('swarm-feed-auto-approve');
  swarmFeedUnlock = document.getElementById('swarm-feed-unlock');
  swarmFeedTouchIdBtn = document.getElementById('swarm-feed-touchid-btn');
  swarmFeedPasswordLink = document.getElementById('swarm-feed-password-link');
  swarmFeedPasswordSection = document.getElementById('swarm-feed-password-section');
  swarmFeedPasswordInput = document.getElementById('swarm-feed-password-input');
  swarmFeedPasswordSubmit = document.getElementById('swarm-feed-password-submit');
  swarmFeedUnlockError = document.getElementById('swarm-feed-unlock-error');

  registerScreenHider(() => {
    const wasVisible = swarmFeedScreen && !swarmFeedScreen.classList.contains('hidden');
    swarmFeedScreen?.classList.add('hidden');
    if (wasVisible && swarmFeedPending) {
      swarmFeedPending.reject({ code: 4001, message: 'User dismissed prompt' });
      swarmFeedPending = null;
    }
  });

  setupSwarmConnectScreen();
  setupSwarmPublishScreen();
  setupSwarmFeedScreen();
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
    swarmConnectionDisconnect.addEventListener('click', () => disconnectSwarmApp());
  }

  if (swarmConnectionManage) {
    swarmConnectionManage.addEventListener('click', () => {
      if (currentBannerPermissionKey) {
        showSwarmPermissions(currentBannerPermissionKey);
      }
    });
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
      const hasAutoApprove = permission.autoApprove?.publish || permission.autoApprove?.feeds;
      swarmAutoApproveBadge?.classList.toggle('hidden', !hasAutoApprove);

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

export async function disconnectSwarmApp(permissionKey = null) {
  const key = permissionKey || currentBannerPermissionKey;
  if (!key) return;

  try {
    await window.swarmPermissions.revokePermission(key);
    await window.swarmFeedStore?.revokeFeedAccess?.(key);
    console.log('[SwarmConnect] Disconnected:', key);

    const webview = getActiveWebview();
    if (webview && webview.send) {
      webview.send('swarm:provider-event', {
        event: 'disconnect',
        data: { origin: key },
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
  swarmPublishPending = { permissionKey, resolve, reject };
  if (swarmPublishAutoApproveCheckbox) swarmPublishAutoApproveCheckbox.checked = false;

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

async function approveSwarmPublish() {
  if (!swarmPublishPending) return;
  const { permissionKey, resolve } = swarmPublishPending;

  if (swarmPublishAutoApproveCheckbox?.checked && permissionKey) {
    await window.swarmPermissions.setAutoApprove(permissionKey, 'publish', true);
    console.log('[SwarmConnect] Auto-approve publish enabled for:', permissionKey);
  }

  resolve();
  console.log('[SwarmConnect] Publish approved');
}

function rejectSwarmPublish() {
  if (!swarmPublishPending) return;
  const { reject } = swarmPublishPending;
  reject({ code: 4001, message: 'User rejected publish' });
  console.log('[SwarmConnect] Publish rejected');
}

// ============================================
// Feed approval prompt
// ============================================

function setupSwarmFeedScreen() {
  if (swarmFeedBackBtn) {
    swarmFeedBackBtn.addEventListener('click', () => {
      rejectSwarmFeed();
      closeSwarmFeedApproval();
    });
  }

  if (swarmFeedRejectBtn) {
    swarmFeedRejectBtn.addEventListener('click', () => {
      rejectSwarmFeed();
      closeSwarmFeedApproval();
    });
  }

  if (swarmFeedApproveBtn) {
    swarmFeedApproveBtn.addEventListener('click', () => {
      approveSwarmFeed();
      closeSwarmFeedApproval();
    });
  }

  if (swarmFeedTouchIdBtn) {
    swarmFeedTouchIdBtn.addEventListener('click', handleFeedTouchIdUnlock);
  }

  if (swarmFeedPasswordSubmit) {
    swarmFeedPasswordSubmit.addEventListener('click', handleFeedPasswordUnlock);
  }

  if (swarmFeedPasswordInput) {
    swarmFeedPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleFeedPasswordUnlock();
    });
  }

  if (swarmFeedPasswordLink) {
    swarmFeedPasswordLink.addEventListener('click', () => {
      swarmFeedPasswordSection?.classList.remove('hidden');
      swarmFeedPasswordLink?.classList.add('hidden');
      swarmFeedPasswordInput?.focus();
    });
  }
}

/**
 * Show the feed access approval prompt.
 * On approval, stores the chosen identity mode and grants feed access.
 */
export async function showSwarmFeedApproval(permissionKey, params, resolve, reject) {
  swarmFeedPending = { permissionKey, resolve, reject };
  if (swarmFeedAutoApproveCheckbox) swarmFeedAutoApproveCheckbox.checked = false;

  if (swarmFeedSite) {
    swarmFeedSite.textContent = permissionKey || 'Unknown';
  }

  if (swarmFeedName) {
    swarmFeedName.textContent = params?.name || params?.feedId || 'unnamed';
  }

  // Pre-select the stored identity mode when re-granting, default to app-scoped for new origins
  let defaultMode = 'app-scoped';
  try {
    const storedMode = await window.swarmFeedStore?.getIdentityMode?.(permissionKey);
    if (storedMode) defaultMode = storedMode;
  } catch {
    // Non-critical
  }
  const defaultRadio = document.querySelector(`input[name="swarm-feed-identity"][value="${defaultMode}"]`);
  if (defaultRadio) defaultRadio.checked = true;

  // Disable Allow until vault status is confirmed
  if (swarmFeedApproveBtn) swarmFeedApproveBtn.disabled = true;

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmFeedScreen?.classList.remove('hidden');

  openSidebarPanel();

  // Check vault unlock status (feed signing requires vault access)
  checkFeedUnlockStatus();
}

async function checkFeedUnlockStatus() {
  try {
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      swarmFeedUnlock?.classList.add('hidden');
      if (swarmFeedApproveBtn) swarmFeedApproveBtn.disabled = false;
      return;
    }

    swarmFeedUnlock?.classList.remove('hidden');
    if (swarmFeedApproveBtn) swarmFeedApproveBtn.disabled = true;

    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (swarmFeedTouchIdBtn) {
      swarmFeedTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    if (hasTouchId && userKnowsPassword) {
      swarmFeedPasswordLink?.classList.remove('hidden');
      swarmFeedPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      swarmFeedPasswordLink?.classList.add('hidden');
      swarmFeedPasswordSection?.classList.remove('hidden');
    } else {
      swarmFeedPasswordLink?.classList.add('hidden');
      swarmFeedPasswordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[SwarmConnect] Failed to check vault status:', err);
    swarmFeedUnlock?.classList.remove('hidden');
    swarmFeedTouchIdBtn?.classList.add('hidden');
    swarmFeedPasswordLink?.classList.add('hidden');
    swarmFeedPasswordSection?.classList.remove('hidden');
  }
}

async function handleFeedTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    swarmFeedUnlock?.classList.add('hidden');
    if (swarmFeedApproveBtn) swarmFeedApproveBtn.disabled = false;
    hideFeedUnlockError();
  } catch (err) {
    console.error('[SwarmConnect] Feed Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showFeedUnlockError(err.message || 'Touch ID failed');
    }
  }
}

async function handleFeedPasswordUnlock() {
  const password = swarmFeedPasswordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    swarmFeedUnlock?.classList.add('hidden');
    if (swarmFeedApproveBtn) swarmFeedApproveBtn.disabled = false;
    if (swarmFeedPasswordInput) swarmFeedPasswordInput.value = '';
    hideFeedUnlockError();
  } catch (err) {
    console.error('[SwarmConnect] Feed password unlock failed:', err);
    showFeedUnlockError(err.message || 'Failed to unlock');
  }
}

function showFeedUnlockError(msg) {
  if (swarmFeedUnlockError) {
    swarmFeedUnlockError.textContent = msg;
    swarmFeedUnlockError.classList.remove('hidden');
  }
}

function hideFeedUnlockError() {
  if (swarmFeedUnlockError) {
    swarmFeedUnlockError.textContent = '';
    swarmFeedUnlockError.classList.add('hidden');
  }
}

function closeSwarmFeedApproval() {
  swarmFeedScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmFeedPending = null;
  // Reset unlock state
  if (swarmFeedPasswordInput) swarmFeedPasswordInput.value = '';
  hideFeedUnlockError();
}

async function approveSwarmFeed() {
  if (!swarmFeedPending) return;

  const { permissionKey, resolve, reject } = swarmFeedPending;

  const selectedRadio = document.querySelector('input[name="swarm-feed-identity"]:checked');
  const identityMode = selectedRadio?.value || 'app-scoped';

  try {
    await window.swarmFeedStore.setFeedIdentity(permissionKey, identityMode);

    if (swarmFeedAutoApproveCheckbox?.checked && permissionKey) {
      await window.swarmPermissions.setAutoApprove(permissionKey, 'feeds', true);
      console.log('[SwarmConnect] Auto-approve feeds enabled for:', permissionKey);
    }

    resolve();
    console.log('[SwarmConnect] Feed access approved:', permissionKey, 'mode:', identityMode);
  } catch (err) {
    console.error('[SwarmConnect] Failed to set feed identity:', err);
    reject({ code: -32603, message: err.message || 'Failed to set feed identity' });
  }
}

function rejectSwarmFeed() {
  if (!swarmFeedPending) return;
  const { reject } = swarmFeedPending;
  reject({ code: 4001, message: 'User rejected feed access' });
  console.log('[SwarmConnect] Feed access rejected');
}
