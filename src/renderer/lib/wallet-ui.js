/**
 * Wallet UI Coordinator
 *
 * Thin coordinator that initializes all wallet submodules,
 * owns view switching / tab switching, and re-exports the public API.
 */

import { showOnboarding } from './onboarding.js';
import { walletState } from './wallet/wallet-state.js';
import { truncateAddress, timeAgo } from './wallet/wallet-utils.js';

// Submodule imports
import { initBalanceDisplay, loadChainRegistry, refreshBalances, renderAssetList, loadCachedBalances, startBalanceRefresh } from './wallet/balance-display.js';
import { initNodeStatus } from './wallet/node-status.js';
import { initRpcSettings, closeRpcApiKeyScreen } from './wallet/rpc-settings.js';
import { initDappConnect, showDappConnect, updateConnectionBanner } from './wallet/dapp-connect.js';
import { initDappTx, showDappTxApproval } from './wallet/dapp-tx.js';
import { initDappSign, showDappSignApproval } from './wallet/dapp-sign.js';
import { initSend, closeSend } from './wallet/send.js';
import { initExportMnemonic, closeExportMnemonic } from './wallet/export-mnemonic.js';
import { initWalletSelector, loadDerivedWallets } from './wallet/wallet-selector.js';
import { initChainSwitcher, updateChainSwitcherDisplay, getSelectedChainId, setSelectedChainId } from './wallet/chain-switcher.js';
import { initReceive, closeReceive } from './wallet/receive.js';
import { initWalletSettings, closeWalletSettings } from './wallet/wallet-settings.js';
import { initCreateWallet, openCreateWallet, closeCreateWallet } from './wallet/create-wallet.js';

// Re-export public API consumed by dapp-provider.js and index.js
export { showDappConnect, updateConnectionBanner, showDappTxApproval, showDappSignApproval };
export { getSelectedChainId, setSelectedChainId };

// DOM references owned by the coordinator
let setupCta;
let swarmIdEl;
let ipfsIdEl;
let radicleIdEl;
let passwordValueEl;
let touchIdValueEl;
let createdValueEl;

/**
 * Initialize the wallet UI module
 */
export function initWalletUi() {
  // Cache coordinator DOM references
  setupCta = document.getElementById('sidebar-setup-cta');
  walletState.identityView = document.getElementById('sidebar-identity');
  swarmIdEl = document.getElementById('sidebar-swarm-id');
  ipfsIdEl = document.getElementById('sidebar-ipfs-id');
  radicleIdEl = document.getElementById('sidebar-radicle-id');
  passwordValueEl = document.getElementById('sidebar-password-value');
  touchIdValueEl = document.getElementById('sidebar-touchid-value');
  createdValueEl = document.getElementById('sidebar-created-value');

  // Initialize all submodules
  initBalanceDisplay();
  initNodeStatus();
  initRpcSettings();
  initDappConnect();
  initDappTx();
  initDappSign();
  initSend();
  initExportMnemonic(switchTab);
  initWalletSelector(openCreateWallet);
  initChainSwitcher();
  initReceive();
  initWalletSettings(switchTab);
  initCreateWallet();

  // Load chain registry (updates registeredTokens/registeredChains, then render)
  loadChainRegistry().then(() => {
    updateChainSwitcherDisplay();
    renderAssetList();
  });

  // Setup coordinator event listeners
  setupCoordinatorListeners();

  // Listen for identity changes
  document.addEventListener('identity-ready', () => {
    console.log('[WalletUI] Identity ready event received');
    updateIdentityState();
  });

  // Listen for sidebar close to clean up sub-screens
  document.addEventListener('sidebar-closed', () => {
    closeAllSubscreens();
  });

  // Initial state check
  updateIdentityState();

  console.log('[WalletUI] Initialized');
}

/**
 * Setup coordinator-level event listeners
 */
function setupCoordinatorListeners() {
  // Setup button - open onboarding
  const setupBtn = document.getElementById('sidebar-setup-btn');
  if (setupBtn) {
    setupBtn.addEventListener('click', () => {
      showOnboarding();
    });
  }

  // Copy node identities
  document.querySelectorAll('.node-copy-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.copy;
      if (type) {
        copyToClipboard(type, btn);
      }
    });
  });

  // Tab switching
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      switchTab(tabName);
      if ((tabName === 'wallet' || tabName === 'nodes') && (walletState.fullAddresses.wallet || walletState.fullAddresses.swarm)) {
        refreshBalances();
      }
    });
  });
}

/**
 * Update identity state - called on init and after state changes
 */
export async function updateIdentityState() {
  try {
    const status = await window.identity.getStatus();

    if (!status.hasVault) {
      showView('setup');
      return;
    }

    if (status.addresses && status.addresses.userWallet) {
      showView('identity');
      await loadIdentityData();
      return;
    }

    showView('setup');

  } catch (err) {
    console.error('[WalletUI] Failed to update identity state:', err);
    showView('setup');
  }
}

/**
 * Show a specific view
 */
function showView(view) {
  walletState.viewMode = view;
  setupCta?.classList.toggle('hidden', view !== 'setup');
  walletState.identityView?.classList.toggle('hidden', view !== 'identity');

  const tabBar = document.querySelector('.sidebar-tabs');
  tabBar?.classList.toggle('hidden', view === 'setup');
}

/**
 * Load and display identity data
 */
async function loadIdentityData() {
  try {
    const status = await window.identity.getStatus();
    walletState.identityData = status;

    // Load derived wallets (multi-wallet support)
    await loadDerivedWallets();

    // Display Swarm/Bee address
    if (status.addresses?.beeWallet) {
      const addr = status.addresses.beeWallet;
      walletState.fullAddresses.swarm = addr;
      swarmIdEl.textContent = truncateAddress(addr);
      swarmIdEl.title = addr;
    }

    // Display IPFS Peer ID
    if (status.addresses?.ipfsPeerId) {
      const peerId = status.addresses.ipfsPeerId;
      walletState.fullAddresses.ipfs = peerId;
      ipfsIdEl.textContent = truncateAddress(peerId, 8, 6);
      ipfsIdEl.title = peerId;
    } else {
      ipfsIdEl.textContent = '--';
      ipfsIdEl.title = '';
    }

    // Display Radicle DID
    if (status.addresses?.radicleDid) {
      const did = status.addresses.radicleDid;
      walletState.fullAddresses.radicle = did;
      const displayId = did.replace('did:key:', '');
      radicleIdEl.textContent = truncateAddress(displayId, 8, 6);
      radicleIdEl.title = did;
    } else {
      radicleIdEl.textContent = '--';
      radicleIdEl.title = '';
    }

    // Update security status
    await updateSecurityStatus();

    // Load cached balances first (instant display), then refresh in background
    if (walletState.fullAddresses.wallet || walletState.fullAddresses.swarm) {
      await loadCachedBalances();
      startBalanceRefresh();
    }

  } catch (err) {
    console.error('[WalletUI] Failed to load identity data:', err);
  }
}

/**
 * Update security status display
 */
async function updateSecurityStatus() {
  try {
    const vaultMeta = await window.identity.getVaultMeta();

    if (passwordValueEl) {
      if (vaultMeta?.userKnowsPassword === false) {
        passwordValueEl.textContent = 'Touch ID only';
        passwordValueEl.classList.add('warning');
        passwordValueEl.classList.remove('success');
      } else {
        passwordValueEl.textContent = 'User-defined';
        passwordValueEl.classList.remove('warning');
        passwordValueEl.classList.remove('success');
      }
    }

    if (createdValueEl && vaultMeta?.createdAt) {
      createdValueEl.textContent = timeAgo(new Date(vaultMeta.createdAt));
    }
  } catch (err) {
    console.error('[WalletUI] Failed to load vault meta:', err);
  }

  try {
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const isEnabled = await window.quickUnlock.isEnabled();

    if (!canUseTouchId) {
      touchIdValueEl.textContent = 'Not available';
    } else if (isEnabled) {
      touchIdValueEl.textContent = 'Enabled';
      touchIdValueEl.classList.add('success');
      touchIdValueEl.classList.remove('warning');
    } else {
      touchIdValueEl.textContent = 'Disabled';
    }
  } catch {
    touchIdValueEl.textContent = '--';
  }
}

// ============================================
// Tab Switching
// ============================================

/**
 * Switch between Wallet and Identity tabs
 */
function switchTab(tabName) {
  if (walletState.viewMode === 'setup') return;

  closeAllSubscreens();

  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  document.querySelectorAll('.tab-panel').forEach(panel => {
    if (panel.id === `tab-${tabName}`) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  });
}

/**
 * Close all open sub-screens (proper cleanup)
 */
function closeAllSubscreens() {
  if (walletState.viewMode === 'setup') return;

  closeExportMnemonic();
  closeCreateWallet();
  closeReceive();
  closeWalletSettings();
  closeSend();
  closeRpcApiKeyScreen();
}

/**
 * Copy address to clipboard
 */
async function copyToClipboard(type, buttonEl) {
  const address = walletState.fullAddresses[type];
  if (!address) return;

  try {
    await window.electronAPI.copyText(address);

    buttonEl.classList.add('copied');
    setTimeout(() => {
      buttonEl.classList.remove('copied');
    }, 1500);
  } catch (err) {
    console.error('[WalletUI] Copy failed:', err);
  }
}
