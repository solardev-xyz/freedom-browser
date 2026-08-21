/**
 * Swarm Connect Module
 *
 * Connection approval UI for Swarm publishing access, plus
 * the Swarm connection banner in the sidebar.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { isSignatureInFlight, signatureInFlightError } from './signature-flight.js';
import { formatBytes } from './wallet-utils.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { getPermissionKey, getActiveWebview } from '../dapp-provider.js';
import { showSwarmPermissions } from './permission-manage.js';
import { createPromptQueue, setButtonsDisabled } from './prompt-queue.js';
import {
  BEE_WALLET_IDENTITY_ID,
  getActivePublisherIdentity,
  renderPublisherIdentitySelector,
} from './publisher-identity-selector.js';

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

// DOM references — messaging approval screen
let swarmMessagingScreen;
let swarmMessagingBackBtn;
let swarmMessagingTitle;
let swarmMessagingSite;
let swarmMessagingWants;
let swarmMessagingTopicRow;
let swarmMessagingTopic;
let swarmMessagingSizeRow;
let swarmMessagingSize;
let swarmMessagingWarning;
let swarmMessagingAutoApproveLabel;
let swarmMessagingAutoApproveCheckbox;
let swarmMessagingRejectBtn;
let swarmMessagingConfirmBtn;

// DOM references — feed approval screen
let swarmFeedScreen;
let swarmFeedBackBtn;
let swarmFeedTitle;
let swarmFeedSite;
let swarmFeedWants;
let swarmFeedDetailLabel;
let swarmFeedName;
let swarmFeedIdentityChoice;
let swarmFeedIdentitySelector;
let swarmFeedRejectBtn;
let swarmFeedApproveBtn;

let swarmFeedAutoApproveCheckbox;
let swarmFeedAutoApproveLabel;
let swarmFeedWarning;

// DOM references — feed unlock section
let swarmFeedUnlock;
let swarmFeedTouchIdBtn;
let swarmFeedPasswordLink;
let swarmFeedPasswordSection;
let swarmFeedPasswordInput;
let swarmFeedPasswordSubmit;
let swarmFeedUnlockError;

// Local state
const swarmConnectQueue = createPromptQueue(presentSwarmConnect, (armed) => {
  setButtonsDisabled([swarmConnectApproveBtn, swarmConnectRejectBtn], !armed);
});
const swarmPublishQueue = createPromptQueue(presentSwarmPublishApproval, (armed) => {
  setButtonsDisabled([swarmPublishConfirmBtn, swarmPublishRejectBtn], !armed);
});
const swarmMessagingQueue = createPromptQueue(presentSwarmMessagingApproval, (armed) => {
  setButtonsDisabled([swarmMessagingConfirmBtn, swarmMessagingRejectBtn], !armed);
});
const swarmFeedQueue = createPromptQueue(presentSwarmFeedApproval, (armed) => {
  setButtonsDisabled([swarmFeedRejectBtn], !armed);
  // Approve is additionally gated on the vault being unlocked.
  syncFeedApproveButton();
});
let swarmFeedIdentityState = null;
// Feed approval needs vault access; the button is enabled only once the
// vault is confirmed unlocked *and* the prompt is past its arm window.
let swarmFeedVaultUnlocked = false;
let currentBannerPermissionKey = null;

function syncFeedApproveButton() {
  if (swarmFeedApproveBtn) {
    swarmFeedApproveBtn.disabled = !(swarmFeedVaultUnlocked && swarmFeedQueue.armed);
  }
}

function rejectDismissed(queue) {
  for (const pending of queue.drain()) {
    pending.reject({ code: 4001, message: 'User dismissed prompt' });
  }
}

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
    // `presenting` means this queue is showing its own next request — the
    // hideAllSubscreens() inside present() is our transition, not a dismissal
    // (queued requests behind it must survive it).
    if (swarmConnectQueue.presenting) return;
    const wasVisible = swarmConnectScreen && !swarmConnectScreen.classList.contains('hidden');
    swarmConnectScreen?.classList.add('hidden');
    // Dismissing the screen drops queued requests too — the user never sees
    // them, so leaving them pending would hang the page.
    if (wasVisible) rejectDismissed(swarmConnectQueue);
  });
  registerScreenHider(() => {
    if (swarmPublishQueue.presenting) return;
    const wasVisible = swarmPublishScreen && !swarmPublishScreen.classList.contains('hidden');
    swarmPublishScreen?.classList.add('hidden');
    if (wasVisible) rejectDismissed(swarmPublishQueue);
  });

  swarmMessagingScreen = document.getElementById('sidebar-swarm-messaging-approve');
  swarmMessagingBackBtn = document.getElementById('swarm-messaging-back');
  swarmMessagingTitle = document.getElementById('swarm-messaging-title');
  swarmMessagingSite = document.getElementById('swarm-messaging-site');
  swarmMessagingWants = document.getElementById('swarm-messaging-wants');
  swarmMessagingTopicRow = document.getElementById('swarm-messaging-topic-row');
  swarmMessagingTopic = document.getElementById('swarm-messaging-topic');
  swarmMessagingSizeRow = document.getElementById('swarm-messaging-size-row');
  swarmMessagingSize = document.getElementById('swarm-messaging-size');
  swarmMessagingWarning = document.getElementById('swarm-messaging-warning');
  swarmMessagingAutoApproveLabel = document.getElementById('swarm-messaging-auto-approve-label');
  swarmMessagingAutoApproveCheckbox = document.getElementById('swarm-messaging-auto-approve');
  swarmMessagingRejectBtn = document.getElementById('swarm-messaging-reject');
  swarmMessagingConfirmBtn = document.getElementById('swarm-messaging-confirm');

  registerScreenHider(() => {
    if (swarmMessagingQueue.presenting) return;
    const wasVisible = swarmMessagingScreen && !swarmMessagingScreen.classList.contains('hidden');
    swarmMessagingScreen?.classList.add('hidden');
    if (wasVisible) rejectDismissed(swarmMessagingQueue);
  });

  swarmFeedScreen = document.getElementById('sidebar-swarm-feed-approve');
  swarmFeedBackBtn = document.getElementById('swarm-feed-back');
  swarmFeedTitle = document.getElementById('swarm-feed-title');
  swarmFeedSite = document.getElementById('swarm-feed-site');
  swarmFeedWants = document.getElementById('swarm-feed-wants');
  swarmFeedDetailLabel = document.getElementById('swarm-feed-detail-label');
  swarmFeedName = document.getElementById('swarm-feed-name');
  swarmFeedIdentityChoice = document.getElementById('swarm-feed-identity-choice');
  swarmFeedIdentitySelector = document.getElementById('swarm-feed-identity-selector');
  swarmFeedRejectBtn = document.getElementById('swarm-feed-reject');
  swarmFeedApproveBtn = document.getElementById('swarm-feed-approve');

  swarmFeedAutoApproveCheckbox = document.getElementById('swarm-feed-auto-approve');
  swarmFeedAutoApproveLabel = document.getElementById('swarm-feed-auto-approve-label');
  swarmFeedWarning = document.getElementById('swarm-feed-warning');
  swarmFeedUnlock = document.getElementById('swarm-feed-unlock');
  swarmFeedTouchIdBtn = document.getElementById('swarm-feed-touchid-btn');
  swarmFeedPasswordLink = document.getElementById('swarm-feed-password-link');
  swarmFeedPasswordSection = document.getElementById('swarm-feed-password-section');
  swarmFeedPasswordInput = document.getElementById('swarm-feed-password-input');
  swarmFeedPasswordSubmit = document.getElementById('swarm-feed-password-submit');
  swarmFeedUnlockError = document.getElementById('swarm-feed-unlock-error');

  registerScreenHider(() => {
    if (swarmFeedQueue.presenting) return;
    const wasVisible = swarmFeedScreen && !swarmFeedScreen.classList.contains('hidden');
    swarmFeedScreen?.classList.add('hidden');
    if (wasVisible) rejectDismissed(swarmFeedQueue);
  });

  setupSwarmConnectScreen();
  setupSwarmPublishScreen();
  setupSwarmMessagingScreen();
  setupSwarmFeedScreen();
}

function setupSwarmConnectScreen() {
  // Every settling path claims the on-screen request first: claim() hands it
  // out once, so a repeated click can neither settle it twice nor act on the
  // queued request that takes its place.
  if (swarmConnectBackBtn) {
    swarmConnectBackBtn.addEventListener('click', () => {
      const pending = swarmConnectQueue.claim();
      if (!pending) return;
      rejectSwarmConnect(pending);
      closeSwarmConnect();
    });
  }

  if (swarmConnectRejectBtn) {
    swarmConnectRejectBtn.addEventListener('click', () => {
      const pending = swarmConnectQueue.claim();
      if (!pending) return;
      rejectSwarmConnect(pending);
      closeSwarmConnect();
    });
  }

  if (swarmConnectApproveBtn) {
    swarmConnectApproveBtn.addEventListener('click', () => {
      const pending = swarmConnectQueue.claim();
      if (!pending) return;
      approveSwarmConnect(pending);
    });
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
 * Show the Swarm connect approval screen (queued behind any prompt already
 * on screen).
 */
export function showSwarmConnect(displayUrl, permissionKey, resolve, reject, webview) {
  // A live device confirmation owns the sidebar (see signature-flight.js).
  if (isSignatureInFlight()) {
    reject(signatureInFlightError());
    return;
  }

  swarmConnectQueue.show({ displayUrl, permissionKey, resolve, reject, webview });
}

function presentSwarmConnect({ displayUrl, permissionKey }) {
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
  swarmConnectQueue.settle();
}

async function approveSwarmConnect(pending) {
  const { permissionKey, resolve, webview } = pending;

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

function rejectSwarmConnect(pending) {
  const { reject } = pending;
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
      const hasAutoApprove = permission.autoApprove?.publish || permission.autoApprove?.feeds || permission.autoApprove?.signing;
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
    if (window.swarmManifest?.disconnect) await window.swarmManifest.disconnect(key);
    else {
      await window.swarmPermissions.revokePermission(key);
      await window.swarmFeedStore?.revokeFeedAccess?.(key);
    }
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

// Byte size of a prompt payload — Blob handles strings (UTF-8),
// ArrayBuffers, and TypedArrays alike.
function payloadByteSize(data) {
  try {
    return new Blob([data]).size;
  } catch {
    return data?.length || 0;
  }
}

// ============================================
// Per-publish approval prompt
// ============================================

function setupSwarmPublishScreen() {
  if (swarmPublishBackBtn) {
    swarmPublishBackBtn.addEventListener('click', () => {
      const pending = swarmPublishQueue.claim();
      if (!pending) return;
      rejectSwarmPublish(pending);
      closeSwarmPublishApproval();
    });
  }

  if (swarmPublishRejectBtn) {
    swarmPublishRejectBtn.addEventListener('click', () => {
      const pending = swarmPublishQueue.claim();
      if (!pending) return;
      rejectSwarmPublish(pending);
      closeSwarmPublishApproval();
    });
  }

  if (swarmPublishConfirmBtn) {
    swarmPublishConfirmBtn.addEventListener('click', () => {
      const pending = swarmPublishQueue.claim();
      if (!pending) return;
      approveSwarmPublish(pending);
      closeSwarmPublishApproval();
    });
  }
}

/**
 * Show the per-publish approval prompt (queued behind any prompt already on
 * screen). Resolves on "Publish", rejects (code 4001) on "Cancel".
 */
export function showSwarmPublishApproval(permissionKey, params, resolve, reject, method) {
  // A live device confirmation owns the sidebar (see signature-flight.js).
  if (isSignatureInFlight()) {
    reject(signatureInFlightError());
    return;
  }

  swarmPublishQueue.show({ permissionKey, params, resolve, reject, method });
}

function presentSwarmPublishApproval({ permissionKey, params, method }) {
  if (swarmPublishAutoApproveCheckbox) swarmPublishAutoApproveCheckbox.checked = false;

  if (swarmPublishSite) {
    swarmPublishSite.textContent = permissionKey || 'Unknown';
  }

  const isFileMode = Array.isArray(params?.files);
  const isChunkMode = method === 'swarm_publishChunk';

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
      swarmPublishType.textContent = isChunkMode ? 'Swarm chunk' : (params?.contentType || 'unknown');
    }
    if (swarmPublishSize) {
      swarmPublishSize.textContent = formatBytes(payloadByteSize(params?.data));
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
  swarmPublishQueue.settle();
}

async function approveSwarmPublish(pending) {
  const { permissionKey, resolve } = pending;
  // Read the shared checkbox before the first await: closing this prompt
  // presents any queued one, which resets it.
  const alwaysAllow = !!swarmPublishAutoApproveCheckbox?.checked;

  if (alwaysAllow && permissionKey) {
    await window.swarmPermissions.setAutoApprove(permissionKey, 'publish', true);
    console.log('[SwarmConnect] Auto-approve publish enabled for:', permissionKey);
  }

  resolve();
  console.log('[SwarmConnect] Publish approved');
}

function rejectSwarmPublish(pending) {
  const { reject } = pending;
  reject({ code: 4001, message: 'User rejected publish' });
  console.log('[SwarmConnect] Publish rejected');
}

// ============================================
// Messaging approval prompt (PSS/GSOC)
// ============================================

function setupSwarmMessagingScreen() {
  if (swarmMessagingBackBtn) {
    swarmMessagingBackBtn.addEventListener('click', () => {
      const pending = swarmMessagingQueue.claim();
      if (!pending) return;
      rejectSwarmMessaging(pending);
      closeSwarmMessagingApproval();
    });
  }

  if (swarmMessagingRejectBtn) {
    swarmMessagingRejectBtn.addEventListener('click', () => {
      const pending = swarmMessagingQueue.claim();
      if (!pending) return;
      rejectSwarmMessaging(pending);
      closeSwarmMessagingApproval();
    });
  }

  if (swarmMessagingConfirmBtn) {
    swarmMessagingConfirmBtn.addEventListener('click', () => {
      const pending = swarmMessagingQueue.claim();
      if (!pending) return;
      approveSwarmMessaging(pending);
      closeSwarmMessagingApproval();
    });
  }
}

function messagingRequestLabel(method) {
  switch (method) {
    case 'swarm_sendPss':
      return 'wants to send a private message (PSS)';
    case 'swarm_sendGsoc':
      return 'wants to broadcast a message (GSOC)';
    case 'swarm_subscribe':
      return 'wants to receive real-time messages';
    default:
      return 'wants to send and receive real-time messages';
  }
}

/**
 * Show the messaging approval prompt (queued behind any prompt already on
 * screen — a page can fire several messaging calls at once).
 *
 * Grant mode (first messaging call for the origin) asks for the
 * messaging tier as a whole; send mode asks per message and offers the
 * messaging auto-approve. Resolves on approve, rejects (4001) on cancel.
 */
export function showSwarmMessagingApproval(permissionKey, params, resolve, reject, options = {}) {
  // A live device confirmation owns the sidebar (see signature-flight.js).
  if (isSignatureInFlight()) {
    reject(signatureInFlightError());
    return;
  }

  swarmMessagingQueue.show({ permissionKey, params, resolve, reject, options });
}

function presentSwarmMessagingApproval({ permissionKey, params, options }) {
  const { method, grantMode } = options || {};

  if (swarmMessagingSite) swarmMessagingSite.textContent = permissionKey || 'Unknown';
  if (swarmMessagingTitle) {
    swarmMessagingTitle.textContent = grantMode ? 'Messaging Access' : 'Confirm Message';
  }
  if (swarmMessagingWants) {
    // The grant prompt uses messagingRequestLabel's default (tier-wide) copy.
    swarmMessagingWants.textContent = messagingRequestLabel(grantMode ? undefined : method);
  }

  const isSend = method === 'swarm_sendPss' || method === 'swarm_sendGsoc';

  if (swarmMessagingTopicRow && swarmMessagingTopic) {
    if (typeof params?.topic === 'string') {
      swarmMessagingTopic.textContent = params.topic;
      swarmMessagingTopicRow.classList.remove('hidden');
    } else {
      swarmMessagingTopicRow.classList.add('hidden');
    }
  }

  if (swarmMessagingSizeRow && swarmMessagingSize) {
    if (isSend && params?.data !== undefined && params?.data !== null) {
      swarmMessagingSize.textContent = formatBytes(payloadByteSize(params.data));
      swarmMessagingSizeRow.classList.remove('hidden');
    } else {
      swarmMessagingSizeRow.classList.add('hidden');
    }
  }

  if (swarmMessagingWarning) {
    swarmMessagingWarning.textContent = grantMode
      ? 'Messaging discloses a stable identity key to this site. Sending uses your stamps; open subscriptions use bandwidth while the page is loaded. A subscription can also read any PSS traffic your node decrypts for the topic it joins, not only this site’s own messages.'
      : 'Sending this message uses your stamps and is visible to the Swarm network.';
  }

  // Auto-approve only applies to per-send prompts (the grant is one-off).
  if (swarmMessagingAutoApproveLabel) {
    swarmMessagingAutoApproveLabel.classList.toggle('hidden', !!grantMode || !isSend);
  }
  if (swarmMessagingAutoApproveCheckbox) swarmMessagingAutoApproveCheckbox.checked = false;

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmMessagingScreen?.classList.remove('hidden');

  openSidebarPanel();
}

function closeSwarmMessagingApproval() {
  swarmMessagingScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmMessagingQueue.settle();
}

async function approveSwarmMessaging(pending) {
  const { permissionKey, resolve } = pending;
  // Read the shared checkbox before the first await (see approveSwarmPublish).
  const alwaysAllow = !!swarmMessagingAutoApproveCheckbox?.checked;

  if (alwaysAllow && permissionKey) {
    await window.swarmPermissions.setAutoApprove(permissionKey, 'messaging', true);
    console.log('[SwarmConnect] Auto-approve messaging enabled for:', permissionKey);
  }

  resolve();
  console.log('[SwarmConnect] Messaging approved');
}

function rejectSwarmMessaging(pending) {
  const { reject } = pending;
  reject({ code: 4001, message: 'User rejected the request' });
  console.log('[SwarmConnect] Messaging rejected');
}

// ============================================
// Feed approval prompt
// ============================================

function setupSwarmFeedScreen() {
  if (swarmFeedBackBtn) {
    swarmFeedBackBtn.addEventListener('click', () => {
      const pending = swarmFeedQueue.claim();
      if (!pending) return;
      rejectSwarmFeed(pending);
      closeSwarmFeedApproval();
    });
  }

  if (swarmFeedRejectBtn) {
    swarmFeedRejectBtn.addEventListener('click', () => {
      const pending = swarmFeedQueue.claim();
      if (!pending) return;
      rejectSwarmFeed(pending);
      closeSwarmFeedApproval();
    });
  }

  if (swarmFeedApproveBtn) {
    swarmFeedApproveBtn.addEventListener('click', () => {
      const pending = swarmFeedQueue.claim();
      if (!pending) return;
      approveSwarmFeed(pending);
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
 * Show the feed access approval prompt (queued behind any prompt already on
 * screen). On approval, establishes or re-grants feed access for the origin.
 */
export function showSwarmFeedApproval(permissionKey, params, resolve, reject, options = {}) {
  // A live device confirmation owns the sidebar (see signature-flight.js).
  if (isSignatureInFlight()) {
    reject(signatureInFlightError());
    return;
  }

  const autoApproveType = options.autoApproveType === 'signing' ? 'signing' : 'feeds';
  swarmFeedQueue.show({ permissionKey, params, resolve, reject, autoApproveType, method: options.method });
}

function presentSwarmFeedApproval({ permissionKey, params, autoApproveType, method }) {
  swarmFeedIdentityState = null;
  if (swarmFeedAutoApproveCheckbox) swarmFeedAutoApproveCheckbox.checked = false;

  applyFeedPromptCopy(method, params, autoApproveType);

  if (swarmFeedSite) {
    swarmFeedSite.textContent = permissionKey || 'Unknown';
  }

  renderFeedIdentitySelector();

  // Disable Allow until vault status is confirmed (and until the prompt's
  // input-protection window has elapsed — see syncFeedApproveButton).
  swarmFeedVaultUnlocked = false;
  syncFeedApproveButton();

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmFeedScreen?.classList.remove('hidden');

  openSidebarPanel();

  // Check vault unlock status (feed signing requires vault access)
  checkFeedUnlockStatus();
}

function applyFeedPromptCopy(method, params, autoApproveType) {
  const signing = autoApproveType === 'signing';

  if (swarmFeedTitle) {
    swarmFeedTitle.textContent = signing ? 'Publisher Signing' : 'Feed Access';
  }
  if (swarmFeedWants) {
    swarmFeedWants.textContent = signing
      ? 'wants to use your publisher identity'
      : 'wants to create and manage feeds';
  }
  if (swarmFeedDetailLabel) {
    swarmFeedDetailLabel.textContent = signing ? 'Request' : 'Feed name';
  }
  if (swarmFeedName) {
    swarmFeedName.textContent = signing
      ? signingRequestLabel(method, params)
      : (params?.name || params?.feedId || params?.identifier || 'Feed operation');
  }
  if (swarmFeedWarning) {
    swarmFeedWarning.textContent = signing
      ? 'Publisher signing can create Single Owner Chunks and reveal the active publisher owner for this site.'
      : 'Feeds provide stable URLs that this app can update over time. Uses your stamps and bandwidth.';
  }
  if (swarmFeedAutoApproveLabel) {
    swarmFeedAutoApproveLabel.textContent = signing
      ? 'Always allow this site to use this publisher identity without asking'
      : 'Always allow this site to manage feeds without asking';
  }
}

function signingRequestLabel(method, params) {
  if (method === 'swarm_writeSingleOwnerChunk') {
    return params?.identifier ? `Single Owner Chunk ${params.identifier}` : 'Single Owner Chunk';
  }
  if (method === 'swarm_getSigningIdentity') {
    return 'Signing identity';
  }
  return 'Publisher signing';
}

function renderFeedIdentitySelector() {
  swarmFeedIdentityChoice?.classList.remove('hidden');
  renderPublisherIdentitySelector(swarmFeedIdentitySelector, swarmFeedIdentityState, {
    onSelect: (identity) => activateFeedPromptIdentity(identity),
    onCreateAppScoped: () => createFeedPromptIdentity(),
  });
}

async function refreshFeedIdentitySelector() {
  if (!swarmFeedQueue.current?.permissionKey) return;
  try {
    swarmFeedIdentityState = await loadFeedIdentityState(swarmFeedQueue.current.permissionKey);
    renderFeedIdentitySelector();
  } catch (err) {
    console.error('[SwarmConnect] Failed to load publisher identities:', err);
    showFeedUnlockError(err.message || 'Failed to load publisher identities');
  }
}

async function loadFeedIdentityState(permissionKey) {
  let state = await window.swarmFeedStore.getOriginIdentities(permissionKey);
  if (!state?.activeIdentityId) {
    const preview = await window.swarmFeedStore.previewAppScopedIdentity(permissionKey);
    state = addOrReplaceIdentity(state, preview);
    state.activeIdentityId = preview.id;
  }
  return state;
}

async function activateFeedPromptIdentity(identity) {
  if (!swarmFeedQueue.current?.permissionKey || !identity) return;
  if (identity.id === swarmFeedIdentityState?.activeIdentityId) return;

  swarmFeedIdentityState = {
    ...swarmFeedIdentityState,
    activeIdentityId: identity.id,
    identities: addOrReplaceIdentity(swarmFeedIdentityState, identity).identities,
  };
  renderFeedIdentitySelector();
}

async function createFeedPromptIdentity() {
  if (!swarmFeedQueue.current?.permissionKey) return;
  const { permissionKey } = swarmFeedQueue.current;
  try {
    const preview = await window.swarmFeedStore.previewAppScopedIdentity(permissionKey);
    swarmFeedIdentityState = addOrReplaceIdentity(swarmFeedIdentityState, preview);
    swarmFeedIdentityState.activeIdentityId = preview.id;
    renderFeedIdentitySelector();
  } catch (err) {
    console.error('[SwarmConnect] Failed to preview publisher identity:', err);
    showFeedUnlockError(err.message || 'Failed to preview publisher identity');
  }
}

function addOrReplaceIdentity(state, identity) {
  const identities = (state?.identities || []).filter((candidate) => candidate.id !== identity.id);
  identities.push(identity);
  return {
    ...(state || {}),
    identities,
  };
}

async function checkFeedUnlockStatus() {
  try {
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      swarmFeedUnlock?.classList.add('hidden');
      swarmFeedVaultUnlocked = true;
      syncFeedApproveButton();
      await refreshFeedIdentitySelector();
      return;
    }

    swarmFeedUnlock?.classList.remove('hidden');
    swarmFeedVaultUnlocked = false;
    syncFeedApproveButton();

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
    swarmFeedVaultUnlocked = true;
    syncFeedApproveButton();
    hideFeedUnlockError();
    await refreshFeedIdentitySelector();
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
    swarmFeedVaultUnlocked = true;
    syncFeedApproveButton();
    if (swarmFeedPasswordInput) swarmFeedPasswordInput.value = '';
    hideFeedUnlockError();
    await refreshFeedIdentitySelector();
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
  swarmFeedIdentityState = null;
  swarmFeedVaultUnlocked = false;
  if (swarmFeedIdentitySelector) swarmFeedIdentitySelector.innerHTML = '';
  // Reset unlock state
  if (swarmFeedPasswordInput) swarmFeedPasswordInput.value = '';
  hideFeedUnlockError();
  swarmFeedQueue.settle();
}

async function approveSwarmFeed(pending) {
  const { permissionKey, resolve, reject, autoApproveType } = pending;
  // Snapshot the shared prompt state before the first await: closing this
  // prompt (and showing any queued one) resets both the identity state and
  // the Always-allow checkbox while this approval is still in flight.
  let identityState = swarmFeedIdentityState;
  const alwaysAllow = !!swarmFeedAutoApproveCheckbox?.checked;

  try {
    if (!identityState?.activeIdentityId) {
      identityState = await loadFeedIdentityState(permissionKey);
    }
    const activeIdentity = getActivePublisherIdentity(identityState);
    const entry = await persistFeedPromptIdentity(permissionKey, activeIdentity);
    const effectiveMode = entry?.identityMode || activeIdentity?.mode || 'app-scoped';

    if (alwaysAllow && permissionKey) {
      await window.swarmPermissions.setAutoApprove(permissionKey, autoApproveType, true);
      console.log(`[SwarmConnect] Auto-approve ${autoApproveType} enabled for:`, permissionKey);
    }

    resolve();
    console.log('[SwarmConnect] Feed access approved:', permissionKey, 'mode:', effectiveMode);
  } catch (err) {
    console.error('[SwarmConnect] Failed to set feed identity:', err);
    reject({ code: -32603, message: err.message || 'Failed to set feed identity' });
  }
}

async function persistFeedPromptIdentity(permissionKey, identity) {
  if (!identity) {
    throw new Error('No publisher identity selected');
  }

  if (identity.id === BEE_WALLET_IDENTITY_ID) {
    await window.swarmFeedStore.ensureAntWalletIdentity(permissionKey, { activate: true });
  } else if (identity.mode === 'ethereum-wallet') {
    await window.swarmFeedStore.ensureEthereumWalletIdentity(
      permissionKey,
      identity.walletIndex,
      { activate: true }
    );
  } else if (identity.mode === 'app-scoped' && identity.stored === false) {
    await window.swarmFeedStore.createAppScopedIdentity(permissionKey, {
      activate: true,
      label: identity.label,
    });
  } else {
    await window.swarmFeedStore.activateFeedIdentity(permissionKey, identity.id);
  }

  return window.swarmFeedStore.setFeedIdentity(permissionKey, identity.mode);
}

function rejectSwarmFeed(pending) {
  const { reject } = pending;
  reject({ code: 4001, message: 'User rejected feed access' });
  console.log('[SwarmConnect] Feed access rejected');
}
