/**
 * Radicle connection banner and permissions screen.
 *
 * The chrome's place to see and change what a site may do with
 * window.radicle, the Radicle sibling of the Wallet and Swarm banners and
 * their permissions screens (permission-manage.js):
 *
 *  - the banner shows while the visible tab's site is connected, with an
 *    "auto" badge while one of its rules is on, and an × that disconnects it;
 *  - clicking it opens Radicle Permissions, where the "always allow writes"
 *    rule (autoApprove.signing, R-6) can be switched off at any time, not
 *    only from a fallback prompt after the rate limit refuses a write.
 *
 * Radicle needs no wallet, so unlike its siblings the banner sits outside
 * #sidebar-identity and also shows in the set-up view (sidebar.css hides it
 * where the identity view's banners would be out of sight).
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { isSignatureInFlight } from './signature-flight.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { getPermissionKey, getActivePageUrl } from '../dapp-provider.js';
import { disconnectRadicleSite } from '../radicle-provider.js';

const WRITES_ON_NOTE =
  'On: this site publishes issues, comments and state changes as you without asking, ' +
  'until it reaches the limit.';
const WRITES_OFF_NOTE =
  'Off: every issue, comment or state change this site publishes as you asks first.';

let banner;
let bannerSite;
let bannerBadge;
let bannerManage;
let bannerDisconnect;
let currentBannerKey = null;

let permsScreen;
let permsBack;
let permsSite;
let permsWritesToggle;
let permsWritesNote;
let permsDisconnect;
let permsKey = null;

export function initRadicleConnection() {
  banner = document.getElementById('radicle-connection-banner');
  bannerSite = document.getElementById('radicle-connection-site');
  bannerBadge = document.getElementById('radicle-auto-approve-badge');
  bannerManage = document.getElementById('radicle-connection-manage');
  bannerDisconnect = document.getElementById('radicle-connection-disconnect');

  permsScreen = document.getElementById('sidebar-radicle-permissions');
  permsBack = document.getElementById('radicle-perms-back');
  permsSite = document.getElementById('radicle-perms-site');
  permsWritesToggle = document.getElementById('radicle-perms-writes-toggle');
  permsWritesNote = document.getElementById('radicle-perms-writes-note');
  permsDisconnect = document.getElementById('radicle-perms-disconnect');

  bannerManage?.addEventListener('click', () => {
    if (currentBannerKey) return showRadiclePermissions(currentBannerKey);
  });
  bannerDisconnect?.addEventListener('click', () => disconnect(currentBannerKey));

  permsBack?.addEventListener('click', closeRadiclePerms);
  permsDisconnect?.addEventListener('click', async () => {
    const key = permsKey;
    await disconnect(key);
    if (permsKey === key) closeRadiclePerms();
  });
  permsWritesToggle?.addEventListener('change', () => setWritesRule(permsWritesToggle.checked));
  registerScreenHider(() => closeRadiclePerms());

  document.addEventListener('sidebar-opened', () => {
    updateRadicleConnectionBanner();
  });
  document.addEventListener('navigation-completed', () => {
    if (isSidebarVisible()) updateRadicleConnectionBanner();
  });
  // radicle-provider.js: a prompt connected the site or changed its rule,
  // or the site disconnected itself.
  document.addEventListener('radicle-permissions-changed', (event) => {
    const origin = event?.detail?.origin ?? null;
    updateRadicleConnectionBanner(origin);
    if (permsKey && (!origin || origin === permsKey)) refreshPermsScreen(permsKey);
  });
}

async function readWritesRule(key) {
  return Boolean(await window.radiclePermissions.getAutoApprove(key, 'signing'));
}

/**
 * Update the banner for the visible tab's committed page. A caller's
 * `permissionKey` names the site whose state changed and is only a refresh
 * hint, ignored unless it is the visible tab's own key (as in
 * updateSwarmConnectionBanner).
 */
export async function updateRadicleConnectionBanner(permissionKey = null) {
  if (!banner) return;

  const activeKey = getPermissionKey(getActivePageUrl());
  if (permissionKey && permissionKey !== activeKey) return;

  const hide = () => {
    banner.classList.add('hidden');
    currentBannerKey = null;
  };
  if (!activeKey || !window.radiclePermissions) {
    hide();
    return;
  }

  let permission = null;
  try {
    permission = await window.radiclePermissions.getPermission(activeKey);
  } catch (err) {
    console.error('[RadicleConnection] Failed to check connection:', err);
  }
  // The visible tab may have changed while main answered.
  if (getPermissionKey(getActivePageUrl()) !== activeKey) return;

  if (!permission) {
    hide();
    return;
  }
  if (bannerSite) bannerSite.textContent = activeKey;
  const autoOn = permission.autoApprove?.signing === true || permission.autoApprove?.node === true;
  bannerBadge?.classList.toggle('hidden', !autoOn);
  currentBannerKey = activeKey;
  banner.classList.remove('hidden');
}

export async function showRadiclePermissions(permissionKey) {
  // A live device confirmation owns the sidebar (see signature-flight.js).
  if (isSignatureInFlight()) {
    console.warn('[RadicleConnection] Permissions not opened: a signature is already in flight');
    return;
  }

  const permission = await window.radiclePermissions.getPermission(permissionKey);
  if (!permission) return;
  if (isSignatureInFlight()) return;

  hideAllSubscreens();
  permsKey = permissionKey;
  if (permsSite) permsSite.textContent = permissionKey;
  renderWritesRule(permission.autoApprove?.signing === true);

  walletState.identityView?.classList.add('hidden');
  document.getElementById('sidebar-setup-cta')?.classList.add('hidden');
  permsScreen?.classList.remove('hidden');
  openSidebarPanel();
}

export function closeRadiclePerms() {
  if (!permsScreen || permsScreen.classList.contains('hidden')) {
    permsKey = null;
    return;
  }
  permsScreen.classList.add('hidden');
  permsKey = null;
  // Back to whichever view the sidebar was showing: this screen is also
  // reachable from the set-up view, where there is no identity view.
  walletState.identityView?.classList.toggle('hidden', walletState.viewMode !== 'identity');
  document
    .getElementById('sidebar-setup-cta')
    ?.classList.toggle('hidden', walletState.viewMode !== 'setup');
}

function renderWritesRule(on) {
  if (permsWritesToggle) permsWritesToggle.checked = on;
  if (permsWritesNote) permsWritesNote.textContent = on ? WRITES_ON_NOTE : WRITES_OFF_NOTE;
}

async function refreshPermsScreen(key) {
  let permission;
  try {
    permission = await window.radiclePermissions.getPermission(key);
  } catch (err) {
    console.error('[RadicleConnection] Failed to refresh permissions:', err);
    return;
  }
  if (permsKey !== key) return;
  if (!permission) {
    closeRadiclePerms();
    return;
  }
  renderWritesRule(permission.autoApprove?.signing === true);
}

/**
 * Switch the site's "always allow writes" rule. The toggle then shows what
 * main stored, not what was clicked: a refused or failed save must never
 * paint "off" over a rule that is still on.
 */
async function setWritesRule(enabled) {
  const key = permsKey;
  if (!key) return;
  if (permsWritesToggle) permsWritesToggle.disabled = true;
  let stored = !enabled;
  try {
    await window.radiclePermissions.setAutoApprove(key, 'signing', enabled);
  } catch (err) {
    console.error(`[RadicleConnection] Could not switch "always allow writes" for ${key}:`, err);
  }
  try {
    stored = await readWritesRule(key);
  } catch (err) {
    console.error(`[RadicleConnection] Could not read "always allow writes" for ${key}:`, err);
  }
  if (permsKey === key) {
    renderWritesRule(stored);
    if (permsWritesToggle) permsWritesToggle.disabled = false;
  }
  updateRadicleConnectionBanner(key);
}

async function disconnect(key) {
  if (!key) return;
  try {
    await disconnectRadicleSite(key);
  } catch (err) {
    console.error(`[RadicleConnection] Failed to disconnect ${key}:`, err);
  }
  updateRadicleConnectionBanner(key);
}
