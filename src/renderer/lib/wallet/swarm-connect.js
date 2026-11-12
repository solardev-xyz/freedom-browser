/**
 * Swarm Connect Module
 *
 * The screens of main's Swarm prompts for a page's requests (connect,
 * publish, messaging, feeds and signing; freedom-core design 0011), plus
 * the Swarm connection banner in the sidebar.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { formatBytes } from './wallet-utils.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { getPermissionKey } from '../origin-utils.js';
import { getActivePageUrl } from '../dapp-provider.js';
import { showSwarmPermissions } from './permission-manage.js';
import { createPromptQueue, setButtonsDisabled } from './prompt-queue.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from '../page-prompt-renderers.js';
import {
  getActivePublisherIdentity,
  identityLabel,
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
// Main unlocks the vault before it shows a feed prompt: the screen's own
// unlock section stays hidden.
let swarmFeedUnlock;

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
  // Approve is additionally gated on the identity (SW-1).
  syncFeedApproveButton();
});
let swarmFeedIdentityState = null;
let currentBannerPermissionKey = null;

function syncFeedApproveButton() {
  if (swarmFeedApproveBtn) {
    swarmFeedApproveBtn.disabled = !swarmFeedQueue.armed || sharedIdentityBlocksFeedRequest();
  }
}

const SIGNING_WARNING =
  'Publisher signing can create Single Owner Chunks and reveal the active publisher owner for this site.';

// SW-1: a raw Single Owner Chunk needs a publisher identity only this site
// uses; main refuses one under a shared identity (`shared_identity`), so
// the prompt says so and keeps Allow off until the user picks another.
function sharedIdentityBlocksFeedRequest() {
  if (swarmFeedQueue.current?.method !== 'swarm_writeSingleOwnerChunk') return false;
  return getActivePublisherIdentity(swarmFeedIdentityState)?.shared === true;
}

function syncFeedSharedIdentityNotice() {
  const current = swarmFeedQueue.current;
  if (!current || current.autoApproveType !== 'signing' || !swarmFeedWarning) return;
  const active = getActivePublisherIdentity(swarmFeedIdentityState);
  if (active?.shared !== true) {
    swarmFeedWarning.textContent = SIGNING_WARNING;
  } else if (current.method === 'swarm_writeSingleOwnerChunk') {
    swarmFeedWarning.textContent =
      `${identityLabel(active)} is also used by other sites, so it cannot write ` +
      'Single Owner Chunks for this one. Choose or create an app-scoped identity for this site.';
  } else {
    swarmFeedWarning.textContent =
      `${identityLabel(active)} is also used by other sites: they sign as the same owner address.`;
  }
  syncFeedApproveButton();
}

// A screen another one hid: main's prompts on it (page requests through
// main, freedom-core design 0011) are told they were displaced, so they show
// again once the sidebar is free.
function reportDismissed(queue) {
  for (const pending of queue.drain()) pagePromptDisplaced(pending.handle);
}

async function decidePagePrompt(handle, approve, choices = {}) {
  try {
    return await window.pagePrompts?.decide?.(handle, approve, choices);
  } catch (err) {
    console.error('[SwarmConnect] The decision did not reach main:', err);
    return null;
  }
}

/**
 * A screen's renderer for main's prompts of one kind (`page:prompt`, design
 * 0011, PRQ-7b): main's prompt goes through the screen's own queue, with
 * its input-protection window, and is answered for its handle alone.
 */
function pagePromptRenderer(queue, screen, toEntry, close) {
  return {
    show: (prompt) => {
      if (queue.current?.handle === prompt.handle) return;
      queue.show(toEntry(prompt));
    },
    close: (handle) => {
      if (queue.withdraw((entry) => entry.handle === handle)) close();
    },
    isShowing: () =>
      queue.current?.handle && screen() && !screen().classList.contains('hidden') ? queue.current.handle : null,
  };
}

// The site main attested, as main labels it.
const siteOf = (prompt) => prompt?.site?.label || prompt?.site?.key || 'Unknown';

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
    // Only report a dismissal if the screen was actually visible (not
    // already hidden). hideAllSubscreens() fires all hiders — including this
    // one — when showing a new screen.
    // `presenting` means this queue is showing its own next request — the
    // hideAllSubscreens() inside present() is our transition, not a dismissal
    // (queued requests behind it must survive it).
    if (swarmConnectQueue.presenting) return;
    const wasVisible = swarmConnectScreen && !swarmConnectScreen.classList.contains('hidden');
    swarmConnectScreen?.classList.add('hidden');
    // Dismissing the screen drops queued prompts too — the user never sees
    // them here, so main shows them again.
    if (wasVisible) reportDismissed(swarmConnectQueue);
  });
  registerScreenHider(() => {
    if (swarmPublishQueue.presenting) return;
    const wasVisible = swarmPublishScreen && !swarmPublishScreen.classList.contains('hidden');
    swarmPublishScreen?.classList.add('hidden');
    if (wasVisible) reportDismissed(swarmPublishQueue);
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
    if (wasVisible) reportDismissed(swarmMessagingQueue);
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

  registerScreenHider(() => {
    if (swarmFeedQueue.presenting) return;
    const wasVisible = swarmFeedScreen && !swarmFeedScreen.classList.contains('hidden');
    swarmFeedScreen?.classList.add('hidden');
    if (wasVisible) reportDismissed(swarmFeedQueue);
  });

  setupSwarmConnectScreen();
  setupSwarmPublishScreen();
  setupSwarmMessagingScreen();
  setupSwarmFeedScreen();

  // Main's own prompts for a page's requests: connecting, and messaging
  // access and sends (PRQ-7b), and publishing (PRQ-7c).
  registerPagePromptRenderer(
    'swarm.connect',
    pagePromptRenderer(
      swarmConnectQueue,
      () => swarmConnectScreen,
      (prompt) => ({ handle: prompt.handle, permissionKey: siteOf(prompt) }),
      closeSwarmConnect
    )
  );
  registerPagePromptRenderer(
    'swarm.messaging',
    pagePromptRenderer(
      swarmMessagingQueue,
      () => swarmMessagingScreen,
      (prompt) => {
        const view = prompt.view || {};
        return {
          handle: prompt.handle,
          permissionKey: siteOf(prompt),
          params: typeof view.topic === 'string' ? { topic: view.topic } : {},
          size: Number.isSafeInteger(view.size) ? view.size : null,
          options: { method: view.method, grantMode: view.grantMode === true },
        };
      },
      closeSwarmMessagingApproval
    )
  );
  registerPagePromptRenderer(
    'swarm.publish',
    pagePromptRenderer(
      swarmPublishQueue,
      () => swarmPublishScreen,
      (prompt) => ({
        handle: prompt.handle,
        permissionKey: siteOf(prompt),
        view: prompt.view || {},
      }),
      closeSwarmPublishApproval
    )
  );
  // Feeds and signing (PRQ-7d): main unlocks the vault first, on its own
  // prompt, so its view carries the site's identities and their owners.
  registerPagePromptRenderer(
    'swarm.feed',
    pagePromptRenderer(
      swarmFeedQueue,
      () => swarmFeedScreen,
      (prompt) => {
        const view = prompt.view || {};
        return {
          handle: prompt.handle,
          permissionKey: siteOf(prompt),
          view,
          method: view.method,
          autoApproveType: view.mode === 'signing' ? 'signing' : 'feeds',
          params: {
            ...(typeof view.name === 'string' ? { name: view.name } : {}),
            ...(typeof view.identifier === 'string' ? { identifier: view.identifier } : {}),
          },
        };
      },
      closeSwarmFeedApproval
    )
  );
}

function setupSwarmConnectScreen() {
  // Every settling path claims the on-screen request first: claim() hands it
  // out once, so a repeated click can neither settle it twice nor act on the
  // queued request that takes its place.
  if (swarmConnectBackBtn) {
    swarmConnectBackBtn.addEventListener('click', () => {
      const pending = swarmConnectQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
      closeSwarmConnect();
    });
  }

  if (swarmConnectRejectBtn) {
    swarmConnectRejectBtn.addEventListener('click', () => {
      const pending = swarmConnectQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
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

function presentSwarmConnect({ permissionKey }) {
  if (swarmConnectSite) {
    swarmConnectSite.textContent = permissionKey || 'Unknown';
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
  // Main writes the grant, for the site it attested, and answers the
  // page; the banner reads the grant once it has.
  closeSwarmConnect();
  await decidePagePrompt(pending.handle, true);
  updateSwarmConnectionBanner();
}

/**
 * Update the Swarm connection banner for the current tab. *
 * The banner always describes the visible tab's committed page, never the
 * address bar (a draft) and never a site named by the caller that is not
 * on screen: a caller's `permissionKey` names the site whose state just
 * changed — a grant made for a background tab's request, say (#764) — and
 * is only a refresh hint, ignored unless it is the visible tab's own key.
 */
export async function updateSwarmConnectionBanner(permissionKey = null) {
  if (!swarmConnectionBanner) return;

  const activeKey = getPermissionKey(getActivePageUrl());
  if (permissionKey && permissionKey !== activeKey) return;
  permissionKey = activeKey;

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
    // Main tells every open page of the site (freedom-core design 0011,
    // "Events"; PRQ-7b).

    // Only the banner of the site that was revoked: a key from the
    // permissions list can name a site in another tab.
    if (key === currentBannerPermissionKey) {
      swarmConnectionBanner?.classList.add('hidden');
      currentBannerPermissionKey = null;
    }
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
      const pending = swarmPublishQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
      closeSwarmPublishApproval();
    });
  }

  if (swarmPublishRejectBtn) {
    swarmPublishRejectBtn.addEventListener('click', () => {
      const pending = swarmPublishQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
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

// Main's view of a page's upload (PRQ-7c): what it measured, and the
// page's own text only as far as main bounded it.
function presentPageUploadView(view) {
  const count = Number.isSafeInteger(view.count) ? view.count : 0;
  const size = Number.isSafeInteger(view.size) ? view.size : 0;
  if (view.kind === 'files') {
    if (swarmPublishType) swarmPublishType.textContent = `${count} file${count !== 1 ? 's' : ''}`;
    if (swarmPublishSize) swarmPublishSize.textContent = formatBytes(size);
    if (swarmPublishPathsRow && swarmPublishPaths) {
      const paths = Array.isArray(view.paths) ? view.paths.filter((p) => typeof p === 'string') : [];
      const more = count > paths.length ? ` \u2026and ${count - paths.length} more` : '';
      swarmPublishPaths.textContent = paths.join(', ') + more;
      swarmPublishPathsRow.classList.remove('hidden');
    }
    swarmPublishNameRow?.classList.add('hidden');
    return;
  }
  if (swarmPublishType) {
    swarmPublishType.textContent =
      view.kind === 'chunk' ? 'Swarm chunk' : (typeof view.contentType === 'string' ? view.contentType : 'unknown');
  }
  if (swarmPublishSize) swarmPublishSize.textContent = formatBytes(size);
  if (swarmPublishNameRow && swarmPublishName) {
    if (view.kind === 'data' && typeof view.name === 'string') {
      swarmPublishName.textContent = view.name;
      swarmPublishNameRow.classList.remove('hidden');
    } else {
      swarmPublishNameRow.classList.add('hidden');
    }
  }
  swarmPublishPathsRow?.classList.add('hidden');
}

function presentSwarmPublishApproval({ permissionKey, view }) {
  if (swarmPublishAutoApproveCheckbox) swarmPublishAutoApproveCheckbox.checked = false;

  if (swarmPublishSite) {
    swarmPublishSite.textContent = permissionKey || 'Unknown';
  }

  presentPageUploadView(view || {});
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
  // Read the shared checkbox before the first await: closing this prompt
  // presents any queued one, which resets it.
  const alwaysAllow = !!swarmPublishAutoApproveCheckbox?.checked;
  // Main sets the rule, for the site it attested, and publishes.
  await decidePagePrompt(pending.handle, true, { alwaysAllow });
}

// ============================================
// Messaging approval prompt (PSS/GSOC)
// ============================================

function setupSwarmMessagingScreen() {
  if (swarmMessagingBackBtn) {
    swarmMessagingBackBtn.addEventListener('click', () => {
      const pending = swarmMessagingQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
      closeSwarmMessagingApproval();
    });
  }

  if (swarmMessagingRejectBtn) {
    swarmMessagingRejectBtn.addEventListener('click', () => {
      const pending = swarmMessagingQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
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
 * Grant mode (first messaging call for the origin) asks for the
 * messaging tier as a whole; send mode asks per message and offers the
 * messaging auto-approve.
 */
function presentSwarmMessagingApproval({ permissionKey, params, options, size }) {
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
    // Main's prompt carries the size it measured, or null.
    if (isSend && size !== null) {
      swarmMessagingSize.textContent = formatBytes(size);
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
  // Read the shared checkbox before the first await (see approveSwarmPublish).
  const alwaysAllow = !!swarmMessagingAutoApproveCheckbox?.checked;
  // Main writes the grant or the rule, for the site it attested; "always
  // allow" only where the prompt offered it (a send).
  const offered = !pending.options?.grantMode && ['swarm_sendPss', 'swarm_sendGsoc'].includes(pending.options?.method);
  await decidePagePrompt(pending.handle, true, offered ? { alwaysAllow } : {});
}

// ============================================
// Feed approval prompt
// ============================================

function setupSwarmFeedScreen() {
  if (swarmFeedBackBtn) {
    swarmFeedBackBtn.addEventListener('click', () => {
      const pending = swarmFeedQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
      closeSwarmFeedApproval();
    });
  }

  if (swarmFeedRejectBtn) {
    swarmFeedRejectBtn.addEventListener('click', () => {
      const pending = swarmFeedQueue.claim();
      if (!pending) return;
      decidePagePrompt(pending.handle, false);
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
}

// The identities main's view offers (PRQ-7d): the site's, and the new
// app-scoped one, which joins the list when the user asks for it.
const viewIdentities = (view) => (Array.isArray(view?.identities) ? view.identities.filter((i) => i && typeof i.id === 'string') : []);

function presentSwarmFeedApproval({ permissionKey, params, autoApproveType, method, view }) {
  swarmFeedIdentityState = null;
  if (swarmFeedAutoApproveCheckbox) swarmFeedAutoApproveCheckbox.checked = false;

  applyFeedPromptCopy(method, params, autoApproveType);

  if (swarmFeedSite) {
    swarmFeedSite.textContent = permissionKey || 'Unknown';
  }

  // The vault is unlocked already, and the identities and their owners are
  // main's.
  const identities = viewIdentities(view);
  const fresh = view?.newIdentity && typeof view.newIdentity.id === 'string' ? view.newIdentity : null;
  if (fresh && view.activeIdentityId === fresh.id) identities.push(fresh);
  swarmFeedIdentityState = { activeIdentityId: view?.activeIdentityId ?? null, identities };
  renderFeedIdentitySelector();
  swarmFeedUnlock?.classList.add('hidden');
  syncFeedApproveButton();
  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  swarmFeedScreen?.classList.remove('hidden');
  openSidebarPanel();
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
      : (params?.name || params?.identifier || 'Feed operation');
  }
  if (swarmFeedWarning) {
    swarmFeedWarning.textContent = signing
      ? SIGNING_WARNING
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
  syncFeedSharedIdentityNotice();
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

function createFeedPromptIdentity() {
  // Main's prompt offers one new identity, made only if the user approves.
  const fresh = swarmFeedQueue.current?.view?.newIdentity;
  if (!fresh || typeof fresh.id !== 'string') return;
  swarmFeedIdentityState = addOrReplaceIdentity(swarmFeedIdentityState, fresh);
  swarmFeedIdentityState.activeIdentityId = fresh.id;
  renderFeedIdentitySelector();
}

function addOrReplaceIdentity(state, identity) {
  const identities = (state?.identities || []).filter((candidate) => candidate.id !== identity.id);
  identities.push(identity);
  return {
    ...(state || {}),
    identities,
  };
}

function closeSwarmFeedApproval() {
  swarmFeedScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  swarmFeedIdentityState = null;
  if (swarmFeedIdentitySelector) swarmFeedIdentitySelector.innerHTML = '';
  swarmFeedQueue.settle();
}

async function approveSwarmFeed(pending) {
  // Snapshot the shared prompt state before the first await: closing this
  // prompt (and showing any queued one) resets both the identity state and
  // the Always-allow checkbox while this approval is still in flight.
  const identity = swarmFeedIdentityState?.activeIdentityId;
  const alwaysAllow = !!swarmFeedAutoApproveCheckbox?.checked;
  // Main makes the identity the site's, grants feed access and sets the
  // rule, for the site it attested.
  await decidePagePrompt(pending.handle, true, { identity, alwaysAllow });
}
