/**
 * dApp Connect Module
 *
 * Connection approval, permission management, connection banner.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { isSignatureInFlight, signatureInFlightError } from './signature-flight.js';
import { escapeHtml, isSafeAccount, isSafeDeployed } from './wallet-utils.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import {
  getActiveWebview,
  getActiveDisplayUrl,
  emitAccountsChanged,
  getPermissionKey,
  getNavigationGeneration,
} from '../dapp-provider.js';
import { registerDappPrompt, isDappPromptShowing, requestPendingError } from './dapp-prompt-guard.js';
import { showDappPermissions } from './permission-manage.js';
import { parseOnchainAppUrl } from '../url-utils.js';

// DOM references
let dappConnectScreen;
let dappConnectBackBtn;
let dappConnectSite;
let dappConnectIcon;
let dappConnectFavicon;
let dappConnectWalletBtn;
let dappConnectWalletName;
let dappConnectWalletAddress;
let dappConnectWalletDropdown;
let dappConnectWalletList;
let dappConnectRejectBtn;
let dappConnectApproveBtn;

// Connection banner DOM references
let dappConnectionBanner;
let dappConnectionSite;
let dappConnectionWallet;
let dappConnectionDisconnect;
let dappAutoApproveBadge;
let dappConnectionManage;

// Local state
let dappConnectPending = null;
let dappConnectSelectedWalletIndex = 0;
let currentBannerPermissionKey = null;

export function initDappConnect() {
  // dApp connect screen elements
  dappConnectScreen = document.getElementById('sidebar-dapp-connect');
  dappConnectBackBtn = document.getElementById('dapp-connect-back');
  dappConnectSite = document.getElementById('dapp-connect-site');
  dappConnectIcon = document.getElementById('dapp-connect-icon');
  dappConnectFavicon = document.getElementById('dapp-connect-favicon');
  dappConnectWalletBtn = document.getElementById('dapp-connect-wallet-btn');
  dappConnectWalletName = document.getElementById('dapp-connect-wallet-name');
  dappConnectWalletAddress = document.getElementById('dapp-connect-wallet-address');
  dappConnectWalletDropdown = document.getElementById('dapp-connect-wallet-dropdown');
  dappConnectWalletList = document.getElementById('dapp-connect-wallet-list');
  dappConnectRejectBtn = document.getElementById('dapp-connect-reject');
  dappConnectApproveBtn = document.getElementById('dapp-connect-approve');

  // Connection banner elements
  dappConnectionBanner = document.getElementById('dapp-connection-banner');
  dappConnectionSite = document.getElementById('dapp-connection-site');
  dappConnectionWallet = document.getElementById('dapp-connection-wallet');
  dappConnectionDisconnect = document.getElementById('dapp-connection-disconnect');
  dappAutoApproveBadge = document.getElementById('dapp-auto-approve-badge');
  dappConnectionManage = document.getElementById('dapp-connection-manage');

  // Register screen hider
  registerScreenHider(() => dappConnectScreen?.classList.add('hidden'));
  // Showing an undecided connection: newcomers wait (dapp-prompt-guard.js).
  registerDappPrompt(
    () => dappConnectPending !== null && Boolean(dappConnectScreen) && !dappConnectScreen.classList.contains('hidden')
  );

  setupDappConnectScreen();
}

function setupDappConnectScreen() {
  if (dappConnectBackBtn) {
    dappConnectBackBtn.addEventListener('click', () => {
      // Not while the grant is being written: it is decided.
      if (dappConnectPending?.deciding) return;
      rejectDappConnect();
      closeDappConnect();
    });
  }

  if (dappConnectWalletBtn) {
    dappConnectWalletBtn.addEventListener('click', toggleDappConnectWalletDropdown);
  }

  document.addEventListener('click', (e) => {
    const selector = document.getElementById('dapp-connect-wallet-selector');
    if (selector && !selector.contains(e.target)) {
      closeDappConnectWalletDropdown();
    }
  });

  if (dappConnectRejectBtn) {
    dappConnectRejectBtn.addEventListener('click', () => {
      if (dappConnectPending?.deciding) return;
      rejectDappConnect();
      closeDappConnect();
    });
  }

  if (dappConnectApproveBtn) {
    dappConnectApproveBtn.addEventListener('click', approveDappConnect);
  }

  if (dappConnectionDisconnect) {
    dappConnectionDisconnect.addEventListener('click', () => disconnectDapp());
  }

  if (dappConnectionManage) {
    dappConnectionManage.addEventListener('click', () => {
      if (currentBannerPermissionKey) {
        showDappPermissions(currentBannerPermissionKey);
      }
    });
  }

  document.addEventListener('sidebar-opened', () => {
    updateConnectionBanner();
  });

  document.addEventListener('navigation-completed', () => {
    if (isSidebarVisible()) {
      updateConnectionBanner();
    }
  });
}

function toggleDappConnectWalletDropdown() {
  const selector = document.getElementById('dapp-connect-wallet-selector');
  if (!selector) return;

  const isOpen = selector.classList.contains('open');
  if (isOpen) {
    closeDappConnectWalletDropdown();
  } else {
    openDappConnectWalletDropdown();
  }
}

function openDappConnectWalletDropdown() {
  const selector = document.getElementById('dapp-connect-wallet-selector');
  if (!selector) return;

  selector.classList.add('open');
  dappConnectWalletDropdown?.classList.remove('hidden');
  renderDappConnectWalletList();
}

function closeDappConnectWalletDropdown() {
  const selector = document.getElementById('dapp-connect-wallet-selector');
  if (!selector) return;

  selector.classList.remove('open');
  dappConnectWalletDropdown?.classList.add('hidden');
}

function renderDappConnectWalletList() {
  if (!dappConnectWalletList) return;

  dappConnectWalletList.innerHTML = '';

  for (const wallet of walletState.derivedWallets) {
    // Safe accounts sign via EIP-1271, which needs the contract on
    // chain — receive-only (undeployed) safes stay out of the list.
    if (safeNotConnectable(wallet)) continue;
    const item = document.createElement('div');
    item.className = 'dapp-connect-wallet-item';
    if (wallet.index === dappConnectSelectedWalletIndex) {
      item.classList.add('selected');
    }

    const truncatedAddress = wallet.address
      ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
      : '--';

    item.innerHTML = `
      <div class="dapp-connect-wallet-item-info">
        <span class="dapp-connect-wallet-item-name">${escapeHtml(wallet.name)}</span>
        <code class="dapp-connect-wallet-item-address">${truncatedAddress}</code>
      </div>
      ${wallet.index === dappConnectSelectedWalletIndex ? `
        <svg class="dapp-connect-wallet-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    item.addEventListener('click', () => selectDappConnectWallet(wallet.index));
    dappConnectWalletList.appendChild(item);
  }
}

/** Undeployed safes can neither send nor answer EIP-1271 — not connectable. */
function safeNotConnectable(wallet) {
  return isSafeAccount(wallet.index) && !isSafeDeployed(wallet);
}

function selectDappConnectWallet(index) {
  dappConnectSelectedWalletIndex = index;
  const wallet = walletState.derivedWallets.find(w => w.index === index);

  if (wallet) {
    if (dappConnectWalletName) {
      dappConnectWalletName.textContent = wallet.name;
    }
    if (dappConnectWalletAddress) {
      const truncated = wallet.address
        ? `${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`
        : '--';
      dappConnectWalletAddress.textContent = truncated;
    }
  }

  // Be upfront that a multi-owner account signs as a smart contract.
  document
    .getElementById('dapp-connect-safe-note')
    ?.classList.toggle('hidden', !isSafeAccount(index));

  closeDappConnectWalletDropdown();
}

/**
 * Show dApp connect screen
 *
 * A permissionless request like eth_requestAccounts must not paint over a
 * live device confirmation with a fresh Connect/Reject pair — see
 * signature-flight.js. Refuse the newcomer; the dApp can retry once the
 * device is done.
 */
export function showDappConnect(displayUrl, permissionKey, resolve, reject, webview) {
  if (isSignatureInFlight()) {
    reject(signatureInFlightError());
    return;
  }
  // Never take the screen from a request the user is looking at.
  if (isDappPromptShowing()) {
    reject(requestPendingError());
    return;
  }

  // Pin the chain at prompt time from the app's own origin. The global chain
  // can still move while the prompt is up (another tab's
  // wallet_switchEthereumChain, or the user flipping the switcher), and a
  // contract-hosted app's chain is not the user's to change anyway.
  const pinnedChainId = parseOnchainAppUrl(displayUrl)?.chainId || null;
  // The document that asked: the grant's events go to it only if it is
  // still there when the grant completes.
  const generation = webview ? getNavigationGeneration(webview) : null;
  dappConnectPending = { permissionKey, resolve, reject, webview, pinnedChainId, generation };

  if (dappConnectSite) {
    dappConnectSite.textContent = permissionKey || displayUrl || 'Unknown';
  }

  if (dappConnectIcon && dappConnectFavicon) {
    dappConnectIcon.classList.remove('has-favicon', 'hidden');
    dappConnectFavicon.src = '';

    if (displayUrl && window.electronAPI?.getCachedFavicon) {
      // Only for the request that asked: a later one owns the icon.
      const request = dappConnectPending;
      window.electronAPI.getCachedFavicon(displayUrl).then((favicon) => {
        if (dappConnectPending !== request) return;
        if (favicon) {
          dappConnectFavicon.src = favicon;
          dappConnectIcon.classList.add('has-favicon');
          dappConnectFavicon.onerror = () => {
            dappConnectIcon.classList.add('hidden');
          };
        } else {
          dappConnectIcon.classList.add('hidden');
        }
      }).catch(() => {
        if (dappConnectPending === request) dappConnectIcon.classList.add('hidden');
      });
    } else {
      dappConnectIcon.classList.add('hidden');
    }
  }

  // Default to the active account; a receive-only (undeployed) safe
  // can't serve a dApp, so fall back to the first connectable account.
  let defaultIndex = walletState.activeWalletIndex;
  const activeRecord = walletState.derivedWallets.find((w) => w.index === defaultIndex);
  if (activeRecord && safeNotConnectable(activeRecord)) {
    defaultIndex =
      walletState.derivedWallets.find((w) => !safeNotConnectable(w))?.index ?? 0;
  }
  dappConnectSelectedWalletIndex = defaultIndex;
  selectDappConnectWallet(defaultIndex);

  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  dappConnectScreen?.classList.remove('hidden');

  openSidebarPanel();
}

function closeDappConnect() {
  dappConnectScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  dappConnectPending = null;
  closeDappConnectWalletDropdown();
}

async function approveDappConnect() {
  if (!dappConnectPending || dappConnectPending.deciding) return;

  const request = dappConnectPending;
  const { permissionKey, resolve, reject, webview, pinnedChainId, generation } = request;
  const wallet = walletState.derivedWallets.find(w => w.index === dappConnectSelectedWalletIndex);

  if (!wallet) {
    console.error('[WalletUI] No wallet selected for dApp connect');
    return;
  }
  // Decided: the way out is closed until the grant is written.
  request.deciding = true;

  const grantedChainId = pinnedChainId || walletState.selectedChainId;

  try {
    await window.dappPermissions.grantPermission(
      permissionKey,
      dappConnectSelectedWalletIndex,
      grantedChainId
    );

    const accounts = [wallet.address];
    resolve(accounts);

    if (webview && webview.send && getNavigationGeneration(webview) === generation) {
      webview.send('dapp:provider-event', {
        event: 'accountsChanged',
        data: accounts,
      });
      webview.send('dapp:provider-event', {
        event: 'connect',
        data: { chainId: '0x' + grantedChainId.toString(16) },
      });
    }

    console.log('[WalletUI] dApp connected:', permissionKey, '→', wallet.address);

    updateConnectionBanner(permissionKey);
  } catch (err) {
    console.error('[WalletUI] Failed to grant permission:', err);
    reject({ code: -32603, message: 'Failed to save the connection' });
  }

  // Only this request's screen: another may have opened since.
  if (dappConnectPending === request) closeDappConnect();
}

function rejectDappConnect() {
  if (!dappConnectPending) return;

  const { reject } = dappConnectPending;
  reject({ code: 4001, message: 'User rejected the request' });
  console.log('[WalletUI] dApp connection rejected');
}

// Counts banner updates: only the latest one paints.
let bannerUpdate = 0;

/**
 * Update the connection banner for the current tab *
 * The banner always describes the visible tab's committed page, never the
 * address bar (a draft) and never a site named by the caller that is not
 * on screen: a caller's `permissionKey` names the site whose state just
 * changed — a grant made for a background tab's request, say (#764) — and
 * is only a refresh hint, ignored unless it is the visible tab's own key.
 */
export async function updateConnectionBanner(permissionKey = null) {
  if (!dappConnectionBanner) return;

  const activeKey = getPermissionKey(getActiveDisplayUrl());
  if (permissionKey && permissionKey !== activeKey) return;
  permissionKey = activeKey;
  // Only the latest update paints, and only while the same site is visible,
  // whatever order the awaits finish in.
  const update = ++bannerUpdate;
  const current = () =>
    update === bannerUpdate && getPermissionKey(getActiveDisplayUrl()) === permissionKey;

  if (!permissionKey) {
    dappConnectionBanner.classList.add('hidden');
    currentBannerPermissionKey = null;
    return;
  }

  try {
    const permission = await window.dappPermissions.getPermission(permissionKey);
    if (!current()) return;

    if (permission) {
      const walletsResult = await window.wallet.getDerivedWallets();
      if (!current()) return;
      const wallets = walletsResult.success ? walletsResult.wallets : [];
      const wallet = wallets.find(w => w.index === permission.walletIndex);
      const walletName = wallet?.name || 'Unknown Wallet';

      if (dappConnectionSite) {
        dappConnectionSite.textContent = permissionKey;
      }
      if (dappConnectionWallet) {
        dappConnectionWallet.textContent = walletName;
      }

      const hasAutoApprove = permission.autoApprove?.signing
        || (permission.autoApprove?.transactions?.length > 0);
      dappAutoApproveBadge?.classList.toggle('hidden', !hasAutoApprove);

      currentBannerPermissionKey = permissionKey;
      dappConnectionBanner.classList.remove('hidden');
    } else {
      dappConnectionBanner.classList.add('hidden');
      currentBannerPermissionKey = null;
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check connection:', err);
    if (!current()) return;
    dappConnectionBanner.classList.add('hidden');
    currentBannerPermissionKey = null;
  }
}

export async function disconnectDapp(permissionKey = null) {
  const key = permissionKey || currentBannerPermissionKey;
  if (!key) return;

  try {
    await window.dappPermissions.revokePermission(key);
    console.log('[WalletUI] Disconnected dApp:', key);

    // The banner shows the visible tab's site; a key from the permissions
    // list can name a site in another tab, whose revocation must leave the
    // visible site's banner alone.
    if (key === currentBannerPermissionKey) {
      dappConnectionBanner?.classList.add('hidden');
      currentBannerPermissionKey = null;
    }

    // Only the visible page can be told — and only when it is the site
    // that was disconnected (a key from the permissions list can name a
    // site in another tab).
    const webview = getActiveWebview();
    if (webview && getPermissionKey(getActiveDisplayUrl()) === key) {
      emitAccountsChanged(webview, []);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to disconnect:', err);
  }
}

