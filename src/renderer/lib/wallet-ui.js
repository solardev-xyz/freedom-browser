/**
 * Wallet UI Coordinator
 *
 * Thin coordinator that initializes all wallet submodules,
 * owns view switching / tab switching, and re-exports the public API.
 */

import { showOnboarding } from './onboarding.js';
import { open as openSidebarPanel, isFeatureEnabled as isSidebarFeatureEnabled } from './sidebar.js';
import { walletState } from './wallet/wallet-state.js';
import { isSignatureInFlight, onSignatureFlightChange } from './wallet/signature-flight.js';
import { truncateAddress, timeAgo } from './wallet/wallet-utils.js';

// Submodule imports
import { initBalanceDisplay, loadChainRegistry, refreshBalances, renderAssetList, loadCachedBalances, startBalanceRefresh } from './wallet/balance-display.js';
import { initNodeStatus } from './wallet/node-status.js';
import { initRpcSettings } from './wallet/rpc-settings.js';
import { initDappConnect, showDappConnect, updateConnectionBanner } from './wallet/dapp-connect.js';
import { initDappTx, showDappTxApproval } from './wallet/dapp-tx.js';
import { initDappSign, showDappSignApproval } from './wallet/dapp-sign.js';
import { initDappX402, updateX402ConnectionBanner } from './wallet/dapp-x402.js';
import { initRecentPayments, refreshRecentPayments } from './wallet/recent-payments.js';
import { initSend, openSend, closeSend } from './wallet/send.js';
import { initExportMnemonic, closeExportMnemonic } from './wallet/export-mnemonic.js';
import { initWalletSelector, loadDerivedWallets } from './wallet/wallet-selector.js';
import { initChainSwitcher, updateChainSwitcherDisplay, getSelectedChainId, setSelectedChainId } from './wallet/chain-switcher.js';
import { initReceive, closeReceive } from './wallet/receive.js';
import { initWalletSettings, closeWalletSettings } from './wallet/wallet-settings.js';
import { initCreateWallet, openCreateWallet, closeCreateWallet } from './wallet/create-wallet.js';
import { initConnectLedger, openConnectLedger, closeConnectLedger } from './wallet/connect-ledger.js';
import { initConnectPhone, openConnectPhone, closeConnectPhone } from './wallet/connect-phone.js';
import { initRemoteSession } from './wallet/remote-session.js';
import { initRemoteSigningPanel } from './wallet/remote-signing-panel.js';
import { initPublishSetup, openPublishSetup, closePublishSetup } from './wallet/publish-setup.js';
import { initStampManager, closeStampManager } from './wallet/stamp-manager.js';
import { initChequebookDeposit, closeChequebookDeposit } from './wallet/chequebook-deposit.js';
import { initSwarmConnect, showSwarmConnect, updateSwarmConnectionBanner, showSwarmPublishApproval, showSwarmFeedApproval, showSwarmMessagingApproval } from './wallet/swarm-connect.js';
import { initVaultUnlock, showVaultUnlock } from './wallet/vault-unlock.js';
import { initPermissionManage, showDappPermissions, showSwarmPermissions, showX402Permissions, closeDappPerms, closeSwarmPerms, closeX402Perms } from './wallet/permission-manage.js';
import { initPublisherIdentities, closePublisherIdentities } from './wallet/publisher-identities.js';
import { initPublisherIdentityCreate, closePublisherIdentityCreate } from './wallet/publisher-identity-create.js';
import { initPermissionManifest, showPermissionManifest } from './wallet/permission-manifest.js';

// Re-export public API consumed by dapp-provider.js, swarm-provider.js, and index.js
export { showDappConnect, updateConnectionBanner, showDappTxApproval, showDappSignApproval };
export { showSwarmConnect, updateSwarmConnectionBanner, showSwarmPublishApproval, showSwarmFeedApproval, showSwarmMessagingApproval, showVaultUnlock };
export { showPermissionManifest };
export { updateX402ConnectionBanner };
export { showDappPermissions, showSwarmPermissions, showX402Permissions };
export { getSelectedChainId, setSelectedChainId };

// DOM references owned by the coordinator
let setupCta;
let swarmIdEl;
let ipfsIdEl;
let ipfsCopyBtn;
let radicleIdEl;
let passwordValueEl;
let touchIdValueEl;
let createdValueEl;

const IPFS_EPHEMERAL_LABEL = 'Ephemeral';
const IPFS_EPHEMERAL_TITLE =
  'freedom-ipfs uses ephemeral peer identities for read-only retrieval in this release.';

/**
 * Initialize the wallet UI module
 */
export function initWalletUi() {
  // Cache coordinator DOM references
  setupCta = document.getElementById('sidebar-setup-cta');
  walletState.identityView = document.getElementById('sidebar-identity');
  swarmIdEl = document.getElementById('sidebar-swarm-id');
  ipfsIdEl = document.getElementById('sidebar-ipfs-id');
  ipfsCopyBtn = document.querySelector('.node-copy-btn[data-copy="ipfs"]');
  radicleIdEl = document.getElementById('sidebar-radicle-id');
  passwordValueEl = document.getElementById('sidebar-password-value');
  touchIdValueEl = document.getElementById('sidebar-touchid-value');
  createdValueEl = document.getElementById('sidebar-created-value');

  // Initialize all submodules
  initBalanceDisplay();
  initNodeStatus();
  initRpcSettings();
  initDappConnect();
  initSwarmConnect();
  initPermissionManifest();
  initVaultUnlock();
  initPermissionManage();
  initDappTx();
  initDappX402();
  initRecentPayments();
  initDappSign();
  initSend();
  initExportMnemonic(switchTab);
  initWalletSelector(openCreateWallet, openConnectLedger, openConnectPhone);
  initChainSwitcher();
  initReceive();
  initWalletSettings(switchTab);
  initCreateWallet();
  initConnectLedger();
  initConnectPhone();
  initRemoteSession();
  initRemoteSigningPanel(); // after initRemoteSession — subscribes to its broker
  initPublishSetup();
  initStampManager();
  initChequebookDeposit();
  initPublisherIdentities();
  initPublisherIdentityCreate();

  // Load chain registry (updates registeredTokens/registeredChains, then
  // render everything that depends on those — the asset list AND the
  // recent-payments mini-section which reads symbols/decimals from
  // walletState.registeredTokens to format amounts).
  loadChainRegistry().then(() => {
    updateChainSwitcherDisplay();
    renderAssetList();
    refreshRecentPayments().catch((err) => console.error('[wallet-ui] recent payments upgrade-after-registry failed:', err));
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
  document.querySelectorAll('.node-copy-btn, .node-copy-btn-inline[data-copy]').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.copy;
      if (type) {
        copyToClipboard(type, btn);
      }
    });
  });

  // The tab bar lives in the always-visible sidebar header, above whatever
  // approval screen is up, so it gets the same treatment as the close
  // button: visibly dead while a device confirmation owns the sidebar.
  const tabs = Array.from(document.querySelectorAll('.sidebar-tab'));
  onSignatureFlightChange((inFlight) => {
    tabs.forEach(tab => {
      tab.disabled = inFlight;
      tab.title = inFlight ? 'Finish the confirmation on your device first' : '';
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
      if (tabName === 'wallet') {
        refreshRecentPayments().catch((err) => console.error('[wallet-ui] recent payments refresh failed:', err));
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

    // Display IPFS identity mode / Peer ID
    if (status.addresses?.ipfsPeerId) {
      const peerId = status.addresses.ipfsPeerId;
      walletState.fullAddresses.ipfs = peerId;
      ipfsIdEl.textContent = truncateAddress(peerId, 8, 6);
      ipfsIdEl.title = peerId;
      if (ipfsCopyBtn) {
        ipfsCopyBtn.hidden = false;
        ipfsCopyBtn.disabled = false;
        ipfsCopyBtn.title = 'Copy';
      }
    } else if (status.ipfsIdentityMode === 'ephemeral') {
      delete walletState.fullAddresses.ipfs;
      ipfsIdEl.textContent = IPFS_EPHEMERAL_LABEL;
      ipfsIdEl.title = IPFS_EPHEMERAL_TITLE;
      if (ipfsCopyBtn) {
        ipfsCopyBtn.hidden = true;
        ipfsCopyBtn.disabled = true;
        ipfsCopyBtn.title = 'No stable IPFS Peer ID to copy';
      }
    } else {
      delete walletState.fullAddresses.ipfs;
      ipfsIdEl.textContent = '--';
      ipfsIdEl.title = '';
      if (ipfsCopyBtn) {
        ipfsCopyBtn.hidden = false;
        ipfsCopyBtn.disabled = true;
        ipfsCopyBtn.title = 'No IPFS Peer ID to copy';
      }
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
 * Open the sidebar, switch to the Nodes tab, and surface the publish-setup
 * checklist. Single entry point used by the freedom://settings deep-link.
 *
 * Bails out when:
 *  - the Identity & Wallet feature is disabled (sidebar.open() would no-op
 *    silently while openPublishSetup() would still start its 5s polling
 *    interval against a hidden screen)
 *  - the user is in onboarding (switchTab no-ops in setup mode and we don't
 *    want publish-setup floating on top of the wizard)
 */
export function openPublishSetupFlow() {
  if (!isSidebarFeatureEnabled()) return;
  if (walletState.viewMode === 'setup') return;
  openSidebarPanel();
  switchTab('nodes');
  openPublishSetup();
}

// Open the wallet sidebar's Send screen with pre-filled recipient / chain /
// amount. Used by the ethereum: URI scheme handler (EIP-681) so static web
// pages can offer "Tip" links that route straight into the send flow.
//
// Same bail conditions as openPublishSetupFlow.
export function openSendFlow({ recipient, chainId, amount } = {}) {
  if (!isSidebarFeatureEnabled()) return false;
  if (walletState.viewMode === 'setup') return false;
  openSidebarPanel();
  switchTab('wallet');
  openSend({ recipient, chainId, amount });
  return true;
}

/**
 * Switch between Wallet and Identity tabs
 */
function switchTab(tabName) {
  if (walletState.viewMode === 'setup') return;
  // Swapping panels puts the identity view back on screen alongside a live
  // device confirmation the renderer cannot recall — and the cascade below
  // would tear that confirmation's neighbours down. The approval screen owns
  // the sidebar until the device answers (see signature-flight.js).
  if (isSignatureInFlight()) {
    console.warn('[WalletUI] Tab not switched: a signature is in flight');
    return;
  }

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
 *
 * Refuses while a signature is in flight. Only closeSend() carries its own
 * ownership check; every other close* here un-hides the identity view
 * unconditionally, so running the cascade over a live confirmation would
 * stack an interactive identity view (with its own unguarded Receive /
 * Settings / Ledger openers) on top of the device prompt — see
 * wallet/signature-flight.js.
 */
function closeAllSubscreens() {
  if (walletState.viewMode === 'setup') return;
  if (isSignatureInFlight()) {
    console.warn('[WalletUI] Sub-screens not closed: a signature is in flight');
    return;
  }

  closeExportMnemonic();
  closeCreateWallet();
  closeConnectLedger();
  closeConnectPhone();
  closeReceive();
  closeWalletSettings();
  closeSend();
  closePublishSetup();
  closeStampManager();
  closeChequebookDeposit();
  closeDappPerms();
  closeSwarmPerms();
  closeX402Perms();
  closePublisherIdentities();
  closePublisherIdentityCreate({ reject: true });
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
