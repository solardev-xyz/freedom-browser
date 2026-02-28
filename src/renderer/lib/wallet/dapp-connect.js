/**
 * dApp Connect Module
 *
 * Connection approval, permission management, connection banner.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from '../sidebar.js';
import { getActiveWebview, emitAccountsChanged } from '../dapp-provider.js';

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

  // Register screen hider
  registerScreenHider(() => dappConnectScreen?.classList.add('hidden'));

  setupDappConnectScreen();
}

function setupDappConnectScreen() {
  if (dappConnectBackBtn) {
    dappConnectBackBtn.addEventListener('click', () => {
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
      rejectDappConnect();
      closeDappConnect();
    });
  }

  if (dappConnectApproveBtn) {
    dappConnectApproveBtn.addEventListener('click', approveDappConnect);
  }

  if (dappConnectionDisconnect) {
    dappConnectionDisconnect.addEventListener('click', disconnectCurrentDapp);
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
    const item = document.createElement('div');
    item.className = 'dapp-connect-wallet-item';
    if (wallet.index === dappConnectSelectedWalletIndex) {
      item.classList.add('selected');
    }

    const truncatedAddress = wallet.address
      ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
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

function selectDappConnectWallet(index) {
  dappConnectSelectedWalletIndex = index;
  const wallet = walletState.derivedWallets.find(w => w.index === index);

  if (wallet) {
    if (dappConnectWalletName) {
      dappConnectWalletName.textContent = wallet.name;
    }
    if (dappConnectWalletAddress) {
      const truncated = wallet.address
        ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
        : '--';
      dappConnectWalletAddress.textContent = truncated;
    }
  }

  closeDappConnectWalletDropdown();
}

/**
 * Show dApp connect screen
 */
export function showDappConnect(displayUrl, permissionKey, resolve, reject, webview) {
  dappConnectPending = { permissionKey, resolve, reject, webview };

  if (dappConnectSite) {
    dappConnectSite.textContent = permissionKey || displayUrl || 'Unknown';
  }

  if (dappConnectIcon && dappConnectFavicon) {
    dappConnectIcon.classList.remove('has-favicon', 'hidden');
    dappConnectFavicon.src = '';

    if (displayUrl && window.electronAPI?.getCachedFavicon) {
      window.electronAPI.getCachedFavicon(displayUrl).then((favicon) => {
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
        dappConnectIcon.classList.add('hidden');
      });
    } else {
      dappConnectIcon.classList.add('hidden');
    }
  }

  dappConnectSelectedWalletIndex = walletState.activeWalletIndex;
  selectDappConnectWallet(walletState.activeWalletIndex);

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
  if (!dappConnectPending) return;

  const { permissionKey, resolve, webview } = dappConnectPending;
  const wallet = walletState.derivedWallets.find(w => w.index === dappConnectSelectedWalletIndex);

  if (!wallet) {
    console.error('[WalletUI] No wallet selected for dApp connect');
    return;
  }

  try {
    await window.dappPermissions.grantPermission(
      permissionKey,
      dappConnectSelectedWalletIndex,
      walletState.selectedChainId
    );

    const accounts = [wallet.address];
    resolve(accounts);

    if (webview && webview.send) {
      webview.send('dapp:provider-event', {
        event: 'accountsChanged',
        data: accounts,
      });
      webview.send('dapp:provider-event', {
        event: 'connect',
        data: { chainId: '0x' + walletState.selectedChainId.toString(16) },
      });
    }

    console.log('[WalletUI] dApp connected:', permissionKey, '→', wallet.address);

    updateConnectionBanner(permissionKey);
  } catch (err) {
    console.error('[WalletUI] Failed to grant permission:', err);
  }

  closeDappConnect();
}

function rejectDappConnect() {
  if (!dappConnectPending) return;

  const { reject } = dappConnectPending;
  reject({ code: 4001, message: 'User rejected the request' });
  console.log('[WalletUI] dApp connection rejected');
}

/**
 * Update the connection banner for the current tab
 */
export async function updateConnectionBanner(permissionKey = null) {
  if (!dappConnectionBanner) return;

  if (!permissionKey) {
    const addressInput = document.getElementById('address-input');
    const displayUrl = addressInput?.value || '';
    permissionKey = getPermissionKeyFromUrl(displayUrl);
  }

  if (!permissionKey) {
    dappConnectionBanner.classList.add('hidden');
    currentBannerPermissionKey = null;
    return;
  }

  try {
    const permission = await window.dappPermissions.getPermission(permissionKey);

    if (permission) {
      const walletsResult = await window.wallet.getDerivedWallets();
      const wallets = walletsResult.success ? walletsResult.wallets : [];
      const wallet = wallets.find(w => w.index === permission.walletIndex);
      const walletName = wallet?.name || 'Unknown Wallet';

      if (dappConnectionSite) {
        dappConnectionSite.textContent = permissionKey;
      }
      if (dappConnectionWallet) {
        dappConnectionWallet.textContent = walletName;
      }

      currentBannerPermissionKey = permissionKey;
      dappConnectionBanner.classList.remove('hidden');
    } else {
      dappConnectionBanner.classList.add('hidden');
      currentBannerPermissionKey = null;
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check connection:', err);
    dappConnectionBanner.classList.add('hidden');
    currentBannerPermissionKey = null;
  }
}

async function disconnectCurrentDapp() {
  if (!currentBannerPermissionKey) return;

  try {
    await window.dappPermissions.revokePermission(currentBannerPermissionKey);
    console.log('[WalletUI] Disconnected dApp:', currentBannerPermissionKey);

    dappConnectionBanner?.classList.add('hidden');
    currentBannerPermissionKey = null;

    const webview = getActiveWebview();
    if (webview) {
      emitAccountsChanged(webview, []);
      console.log('[WalletUI] Emitted accountsChanged with empty array to webview');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to disconnect:', err);
  }
}

function getPermissionKeyFromUrl(displayUrl) {
  if (!displayUrl) return null;
  const trimmed = displayUrl.trim();

  // ENS name without protocol
  if (/^[a-z0-9-]+\.(eth|box)/i.test(trimmed)) {
    return trimmed.split('/')[0].toLowerCase();
  }

  // ens:// protocol
  const ensMatch = trimmed.match(/^ens:\/\/([^/#]+)/i);
  if (ensMatch) return ensMatch[1].toLowerCase();

  // dweb protocols
  const dwebMatch = trimmed.match(/^(ipfs|bzz|ipns):\/\/([^/]+)/i);
  if (dwebMatch) return `${dwebMatch[1].toLowerCase()}://${dwebMatch[2]}`;

  // rad:// protocol
  const radMatch = trimmed.match(/^rad:\/\/([^/]+)/i);
  if (radMatch) return `rad://${radMatch[1]}`;

  // Regular URL
  try {
    const url = new URL(trimmed);
    if (url.origin === 'null') return trimmed;
    return url.origin;
  } catch {
    return trimmed;
  }
}
