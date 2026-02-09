/**
 * Wallet UI Module
 *
 * Manages the identity & wallet display in the sidebar.
 * Handles state updates, copy functionality, and QR codes.
 */

import { showOnboarding } from './onboarding.js';
import { buildBeeUrl } from './state.js';
import { open as openSidebarPanel, isVisible as isSidebarVisible } from './sidebar.js';
import { getActiveWebview, emitAccountsChanged, emitChainChanged } from './dapp-provider.js';
import { createTab } from './tabs.js';

// Cached identity data
let identityData = null;

// Balance state
let balanceRefreshInterval = null;
const BALANCE_REFRESH_MS = 30000; // 30 seconds

// Multi-wallet state
let derivedWallets = [];
let activeWalletIndex = 0;

// DOM references
let setupCta;
let lockedView;
let identityView;
let swarmIdEl;

// Wallet selector DOM references
let walletSelectorBtn;
let walletSelectorName;
let walletSelectorAddress;
let walletSelectorDropdown;
let walletSelectorList;
let walletCreateBtn;
let ipfsIdEl;

// Create wallet sub-screen DOM references
let createWalletScreen;
let createWalletBackBtn;
let createWalletUnlockView;
let createWalletTouchIdBtn;
let createWalletPasswordSection;
let createWalletPasswordInput;
let createWalletPasswordSubmit;
let createWalletUnlockError;
let createWalletNameView;
let createWalletNameInput;
let createWalletSubmitBtn;
let createWalletNameError;
let createWalletSuccessView;
let createWalletResultName;
let createWalletResultAddress;
let createWalletDoneBtn;
let radicleIdEl;
let passwordValueEl;
let touchIdValueEl;
let createdValueEl;
let qrContainer;
let qrCanvas;

// Export mnemonic sub-screen references
let exportMnemonicScreen;
let exportUnlockRequired;
let exportMnemonicDisplay;
let exportTouchIdBtn;
let exportPasswordSection;

// Balance DOM references (dynamically populated)
let assetListEl;
let balanceErrorEl;

// Registry data
let registeredTokens = {};
let registeredChains = {};

// Current balances (for filtering display)
let currentBalances = {};

// Chain switcher state (default to Gnosis Chain)
let selectedChainId = 100;

// dApp connect sub-screen DOM references
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

// dApp connect state
let dappConnectPending = null; // { permissionKey, resolve, reject, webview }

// dApp connection banner DOM references
let dappConnectionBanner;
let dappConnectionSite;
let dappConnectionWallet;
let dappConnectionDisconnect;

// dApp transaction approval sub-screen DOM references
let dappTxScreen;
let dappTxBackBtn;
let dappTxSite;
let dappTxTo;
let dappTxValue;
let dappTxValueRow;
let dappTxData;
let dappTxDataRow;
let dappTxNetwork;
let dappTxFee;
let dappTxWarning;
let dappTxWarningText;
let dappTxUnlock;
let dappTxTouchIdBtn;
let dappTxPasswordLink;
let dappTxPasswordSection;
let dappTxPasswordInput;
let dappTxPasswordSubmit;
let dappTxUnlockError;
let dappTxError;
let dappTxRejectBtn;
let dappTxApproveBtn;

// dApp transaction state
let dappTxPending = null; // { permissionKey, walletIndex, txParams, resolve, reject, webview }

// dApp signing sub-screen DOM references
let dappSignScreen;
let dappSignBackBtn;
let dappSignSite;
let dappSignMessage;
let dappSignTypedDataSection;
let dappSignTypedData;
let dappSignUnlock;
let dappSignTouchIdBtn;
let dappSignPasswordLink;
let dappSignPasswordSection;
let dappSignPasswordInput;
let dappSignPasswordSubmit;
let dappSignUnlockError;
let dappSignError;
let dappSignRejectBtn;
let dappSignApproveBtn;

// dApp signing state
let dappSignPending = null; // { permissionKey, walletIndex, method, params, resolve, reject, webview }

// Chain switcher DOM references
let chainSwitcherBtn;
let chainSwitcherName;
let chainSwitcherLogo;
let chainSwitcherDropdown;
let chainSwitcherList;

// Receive screen DOM references
let receiveScreen;
let receiveBackBtn;
let receiveQrImage;
let receiveAddress;
let receiveCopyBtn;

// Wallet settings screen DOM references
let walletSettingsScreen;
let walletSettingsBackBtn;
let walletSettingsName;
let walletSettingsAddress;
let walletSettingsDeleteBtn;
let walletHeadlineName;

// Export private key DOM references
let exportPkButtonView;
let exportPkUnlockView;
let exportPkDisplayView;
let exportPkTouchIdBtn;
let exportPkPasswordSection;
let exportPkPasswordInput;
let exportPkPasswordSubmit;
let exportPkError;
let exportPkValue;
let exportPkCopyBtn;

// Send screen DOM references
let sendScreen;
let sendBackBtn;
let sendInputView;
let sendReviewView;
let sendPendingView;
let sendSuccessView;
let sendErrorView;
let sendRecipientInput;
let sendResolvedAddress;
let sendRecipientError;
// Send chain selector
let sendChainSelector;
let sendChainBtn;
let sendChainLogo;
let sendChainName;
let sendChainDropdown;
let sendChainList;
// Send asset selector
let sendAssetSelector;
let sendAssetBtn;
let sendAssetLogo;
let sendAssetName;
let sendAssetDropdown;
let sendAssetList;
let sendAmountInput;
let sendMaxBtn;
let sendBalanceHint;
let sendAmountError;
let sendContinueBtn;
let sendGeneralError;
let sendReviewTo;
let sendReviewAmount;
let sendReviewNetwork;
let sendReviewFee;
let sendReviewTotal;
let sendEditBtn;
let sendConfirmBtn;
let sendUnlockSection;
let sendTouchIdBtn;
let sendPasswordLink;
let sendPasswordSection;
let sendPasswordInput;
let sendPasswordSubmit;
let sendUnlockError;
let sendReviewError;
let sendSuccessText;
let sendExplorerLink;
let sendDoneBtn;
let sendErrorText;
let sendRetryBtn;

// Send transaction state
let sendTxState = {
  selectedToken: null,
  recipient: '',
  amount: '',
  gasLimit: null,
  maxFeePerGas: null,
  maxPriorityFeePerGas: null,
  gasPrice: null,
  estimatedFee: null,
  chainId: null,
};

// Node card DOM references
let swarmBalanceXdaiEl;
let swarmBalanceXbzzEl;
let swarmModeBadge;
let swarmStatusBadge;
let swarmStampsCount;
let swarmStampsSummary;

// Notification DOM references
let walletNotification;
let walletNotificationText;
let walletNotificationAction;

// Node status tracking
let nodeStatusUnsubscribers = [];

// Full addresses for copy
let fullAddresses = {
  wallet: '',
  swarm: '',
  ipfs: '',
  radicle: '',
};

/**
 * Initialize the wallet UI module
 */
export function initWalletUi() {
  // Cache DOM references
  setupCta = document.getElementById('sidebar-setup-cta');
  lockedView = document.getElementById('sidebar-locked');
  identityView = document.getElementById('sidebar-identity');
  swarmIdEl = document.getElementById('sidebar-swarm-id');
  ipfsIdEl = document.getElementById('sidebar-ipfs-id');
  radicleIdEl = document.getElementById('sidebar-radicle-id');
  passwordValueEl = document.getElementById('sidebar-password-value');
  touchIdValueEl = document.getElementById('sidebar-touchid-value');
  createdValueEl = document.getElementById('sidebar-created-value');

  // Wallet selector elements
  walletSelectorBtn = document.getElementById('wallet-selector-btn');
  walletSelectorName = document.getElementById('wallet-selector-name');
  walletSelectorAddress = document.getElementById('wallet-selector-address');
  walletSelectorDropdown = document.getElementById('wallet-selector-dropdown');
  walletSelectorList = document.getElementById('wallet-selector-list');
  walletCreateBtn = document.getElementById('wallet-create-btn');

  // Create wallet sub-screen elements
  createWalletScreen = document.getElementById('sidebar-create-wallet');
  createWalletBackBtn = document.getElementById('create-wallet-back');
  createWalletUnlockView = document.getElementById('create-wallet-unlock');
  createWalletTouchIdBtn = document.getElementById('create-wallet-touchid-btn');
  createWalletPasswordSection = document.getElementById('create-wallet-password-section');
  createWalletPasswordInput = document.getElementById('create-wallet-password');
  createWalletPasswordSubmit = document.getElementById('create-wallet-password-submit');
  createWalletUnlockError = document.getElementById('create-wallet-unlock-error');
  createWalletNameView = document.getElementById('create-wallet-name-step');
  createWalletNameInput = document.getElementById('create-wallet-name-input');
  createWalletSubmitBtn = document.getElementById('create-wallet-submit');
  createWalletNameError = document.getElementById('create-wallet-name-error');
  createWalletSuccessView = document.getElementById('create-wallet-success');
  createWalletResultName = document.getElementById('create-wallet-result-name');
  createWalletResultAddress = document.getElementById('create-wallet-result-address');
  createWalletDoneBtn = document.getElementById('create-wallet-done');

  // Export mnemonic sub-screen
  exportMnemonicScreen = document.getElementById('sidebar-export-mnemonic');
  exportUnlockRequired = document.getElementById('export-unlock-required');
  exportMnemonicDisplay = document.getElementById('export-mnemonic-display');
  exportTouchIdBtn = document.getElementById('export-touchid-btn');
  exportPasswordSection = document.getElementById('export-password-section');

  // Balance elements
  assetListEl = document.getElementById('asset-list');
  balanceErrorEl = document.getElementById('balance-error');

  // Chain switcher elements
  chainSwitcherBtn = document.getElementById('chain-switcher-btn');
  chainSwitcherName = document.getElementById('chain-switcher-name');
  chainSwitcherLogo = document.getElementById('chain-switcher-logo');
  chainSwitcherDropdown = document.getElementById('chain-switcher-dropdown');
  chainSwitcherList = document.getElementById('chain-switcher-list');

  // Receive screen elements
  receiveScreen = document.getElementById('sidebar-receive');
  receiveBackBtn = document.getElementById('receive-back');
  receiveQrImage = document.getElementById('receive-qr-image');
  receiveAddress = document.getElementById('receive-address');
  receiveCopyBtn = document.getElementById('receive-copy-btn');

  // Wallet settings screen elements
  walletSettingsScreen = document.getElementById('sidebar-wallet-settings');
  walletSettingsBackBtn = document.getElementById('wallet-settings-back');
  walletSettingsName = document.getElementById('wallet-settings-name');
  walletSettingsAddress = document.getElementById('wallet-settings-address');
  walletSettingsDeleteBtn = document.getElementById('wallet-settings-delete');
  walletHeadlineName = document.getElementById('wallet-headline-name');

  // Export private key elements
  exportPkButtonView = document.getElementById('export-pk-button-view');
  exportPkUnlockView = document.getElementById('export-pk-unlock-view');
  exportPkDisplayView = document.getElementById('export-pk-display-view');
  exportPkTouchIdBtn = document.getElementById('export-pk-touchid-btn');
  exportPkPasswordSection = document.getElementById('export-pk-password-section');
  exportPkPasswordInput = document.getElementById('export-pk-password-input');
  exportPkPasswordSubmit = document.getElementById('export-pk-password-submit');
  exportPkError = document.getElementById('export-pk-error');
  exportPkValue = document.getElementById('export-pk-value');
  exportPkCopyBtn = document.getElementById('export-pk-copy-btn');

  // Send screen elements
  sendScreen = document.getElementById('sidebar-send');
  sendBackBtn = document.getElementById('send-back');
  sendInputView = document.getElementById('send-input-view');
  sendReviewView = document.getElementById('send-review-view');
  sendPendingView = document.getElementById('send-pending-view');
  sendSuccessView = document.getElementById('send-success-view');
  sendErrorView = document.getElementById('send-error-view');
  sendRecipientInput = document.getElementById('send-recipient');
  sendResolvedAddress = document.getElementById('send-resolved-address');
  sendRecipientError = document.getElementById('send-recipient-error');
  // Send chain selector elements
  sendChainSelector = document.getElementById('send-chain-selector');
  sendChainBtn = document.getElementById('send-chain-btn');
  sendChainLogo = document.getElementById('send-chain-logo');
  sendChainName = document.getElementById('send-chain-name');
  sendChainDropdown = document.getElementById('send-chain-dropdown');
  sendChainList = document.getElementById('send-chain-list');
  // Send asset selector elements
  sendAssetSelector = document.getElementById('send-asset-selector');
  sendAssetBtn = document.getElementById('send-asset-btn');
  sendAssetLogo = document.getElementById('send-asset-logo');
  sendAssetName = document.getElementById('send-asset-name');
  sendAssetDropdown = document.getElementById('send-asset-dropdown');
  sendAssetList = document.getElementById('send-asset-list');
  sendAmountInput = document.getElementById('send-amount');
  sendMaxBtn = document.getElementById('send-max-btn');
  sendBalanceHint = document.getElementById('send-balance-hint');
  sendAmountError = document.getElementById('send-amount-error');
  sendContinueBtn = document.getElementById('send-continue-btn');
  sendGeneralError = document.getElementById('send-general-error');
  sendReviewTo = document.getElementById('send-review-to');
  sendReviewAmount = document.getElementById('send-review-amount');
  sendReviewNetwork = document.getElementById('send-review-network');
  sendReviewFee = document.getElementById('send-review-fee-value');
  sendReviewTotal = document.getElementById('send-review-total');
  sendEditBtn = document.getElementById('send-edit-btn');
  sendConfirmBtn = document.getElementById('send-confirm-btn');
  sendUnlockSection = document.getElementById('send-unlock-section');
  sendTouchIdBtn = document.getElementById('send-touchid-btn');
  sendPasswordLink = document.getElementById('send-password-link');
  sendPasswordSection = document.getElementById('send-password-section');
  sendPasswordInput = document.getElementById('send-password-input');
  sendPasswordSubmit = document.getElementById('send-password-submit');
  sendUnlockError = document.getElementById('send-unlock-error');
  sendReviewError = document.getElementById('send-review-error');
  sendSuccessText = document.getElementById('send-success-text');
  sendExplorerLink = document.getElementById('send-explorer-link');
  sendDoneBtn = document.getElementById('send-done-btn');
  sendErrorText = document.getElementById('send-error-text');
  sendRetryBtn = document.getElementById('send-retry-btn');

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

  // dApp connection banner elements
  dappConnectionBanner = document.getElementById('dapp-connection-banner');
  dappConnectionSite = document.getElementById('dapp-connection-site');
  dappConnectionWallet = document.getElementById('dapp-connection-wallet');
  dappConnectionDisconnect = document.getElementById('dapp-connection-disconnect');

  // dApp transaction approval elements
  dappTxScreen = document.getElementById('sidebar-dapp-tx');
  dappTxBackBtn = document.getElementById('dapp-tx-back');
  dappTxSite = document.getElementById('dapp-tx-site');
  dappTxTo = document.getElementById('dapp-tx-to');
  dappTxValue = document.getElementById('dapp-tx-value');
  dappTxValueRow = document.getElementById('dapp-tx-value-row');
  dappTxData = document.getElementById('dapp-tx-data');
  dappTxDataRow = document.getElementById('dapp-tx-data-row');
  dappTxNetwork = document.getElementById('dapp-tx-network');
  dappTxFee = document.getElementById('dapp-tx-fee');
  dappTxWarning = document.getElementById('dapp-tx-warning');
  dappTxWarningText = document.getElementById('dapp-tx-warning-text');
  dappTxUnlock = document.getElementById('dapp-tx-unlock');
  dappTxTouchIdBtn = document.getElementById('dapp-tx-touchid-btn');
  dappTxPasswordLink = document.getElementById('dapp-tx-password-link');
  dappTxPasswordSection = document.getElementById('dapp-tx-password-section');
  dappTxPasswordInput = document.getElementById('dapp-tx-password-input');
  dappTxPasswordSubmit = document.getElementById('dapp-tx-password-submit');
  dappTxUnlockError = document.getElementById('dapp-tx-unlock-error');
  dappTxError = document.getElementById('dapp-tx-error');
  dappTxRejectBtn = document.getElementById('dapp-tx-reject');
  dappTxApproveBtn = document.getElementById('dapp-tx-approve');

  // dApp signing elements
  dappSignScreen = document.getElementById('sidebar-dapp-sign');
  dappSignBackBtn = document.getElementById('dapp-sign-back');
  dappSignSite = document.getElementById('dapp-sign-site');
  dappSignMessage = document.getElementById('dapp-sign-message');
  dappSignTypedDataSection = document.getElementById('dapp-sign-typed-data-section');
  dappSignTypedData = document.getElementById('dapp-sign-typed-data');
  dappSignUnlock = document.getElementById('dapp-sign-unlock');
  dappSignTouchIdBtn = document.getElementById('dapp-sign-touchid-btn');
  dappSignPasswordLink = document.getElementById('dapp-sign-password-link');
  dappSignPasswordSection = document.getElementById('dapp-sign-password-section');
  dappSignPasswordInput = document.getElementById('dapp-sign-password-input');
  dappSignPasswordSubmit = document.getElementById('dapp-sign-password-submit');
  dappSignUnlockError = document.getElementById('dapp-sign-unlock-error');
  dappSignError = document.getElementById('dapp-sign-error');
  dappSignRejectBtn = document.getElementById('dapp-sign-reject');
  dappSignApproveBtn = document.getElementById('dapp-sign-approve');

  // Load chain registry and render asset list
  loadChainRegistry();

  // Node card elements
  swarmBalanceXdaiEl = document.getElementById('swarm-balance-xdai');
  swarmBalanceXbzzEl = document.getElementById('swarm-balance-xbzz');
  swarmModeBadge = document.getElementById('swarm-mode-badge');
  swarmStatusBadge = document.getElementById('swarm-status-badge');
  swarmStampsCount = document.getElementById('swarm-stamps-count');
  swarmStampsSummary = document.getElementById('swarm-stamps-summary');

  // Notification elements
  walletNotification = document.getElementById('wallet-notification');
  walletNotificationText = document.getElementById('wallet-notification-text');
  walletNotificationAction = document.getElementById('wallet-notification-action');

  // Setup event listeners
  setupEventListeners();

  // Setup wallet selector
  setupWalletSelector();

  // Setup chain switcher
  setupChainSwitcher();

  // Setup receive sub-screen
  setupReceiveScreen();

  // Setup send sub-screen
  setupSendScreen();

  // Setup wallet settings sub-screen
  setupWalletSettingsScreen();

  // Setup create wallet sub-screen
  setupCreateWalletSubscreen();

  // Setup dApp connect sub-screen
  setupDappConnectScreen();

  // Setup dApp transaction approval sub-screen
  setupDappTxScreen();

  // Setup dApp signing sub-screen
  setupDappSignScreen();

  // Setup node card collapse/expand
  setupNodeCards();

  // Subscribe to node status updates
  subscribeToNodeStatus();

  // Listen for identity changes (e.g., after onboarding)
  document.addEventListener('identity-ready', () => {
    console.log('[WalletUI] Identity ready event received');
    updateIdentityState();
  });

  // Listen for sidebar close to clean up sub-screens
  document.addEventListener('sidebar-closed', () => {
    if (exportMnemonicScreen && !exportMnemonicScreen.classList.contains('hidden')) {
      closeExportMnemonic();
    }
    if (createWalletScreen && !createWalletScreen.classList.contains('hidden')) {
      closeCreateWallet();
    }
    if (receiveScreen && !receiveScreen.classList.contains('hidden')) {
      closeReceive();
    }
    if (walletSettingsScreen && !walletSettingsScreen.classList.contains('hidden')) {
      closeWalletSettings();
    }
    if (sendScreen && !sendScreen.classList.contains('hidden')) {
      closeSend();
    }
  });

  // Initial state check
  updateIdentityState();

  console.log('[WalletUI] Initialized');
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
  // Setup button - open onboarding
  const setupBtn = document.getElementById('sidebar-setup-btn');
  if (setupBtn) {
    setupBtn.addEventListener('click', () => {
      showOnboarding();
    });
  }

  // Unlock button
  const unlockBtn = document.getElementById('sidebar-unlock-btn');
  if (unlockBtn) {
    unlockBtn.addEventListener('click', handleUnlock);
  }

  // Lock button
  const lockBtn = document.getElementById('sidebar-lock-btn');
  if (lockBtn) {
    lockBtn.addEventListener('click', handleLock);
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
      // Refresh balances when switching to wallet or nodes tab
      if ((tabName === 'wallet' || tabName === 'nodes') && (fullAddresses.wallet || fullAddresses.swarm)) {
        refreshBalances();
      }
    });
  });

  // Export mnemonic navigation
  const exportMnemonicBtn = document.getElementById('sidebar-export-mnemonic-btn');
  if (exportMnemonicBtn) {
    exportMnemonicBtn.addEventListener('click', openExportMnemonic);
  }

  const exportBackBtn = document.getElementById('export-mnemonic-back');
  if (exportBackBtn) {
    exportBackBtn.addEventListener('click', async () => {
      await closeExportMnemonic();
      switchTab('settings');
    });
  }

  // Export mnemonic unlock
  if (exportTouchIdBtn) {
    exportTouchIdBtn.addEventListener('click', handleExportTouchIdUnlock);
  }

  const exportPasswordSubmit = document.getElementById('export-password-submit');
  if (exportPasswordSubmit) {
    exportPasswordSubmit.addEventListener('click', handleExportPasswordUnlock);
  }

  const exportPasswordInput = document.getElementById('export-password-input');
  if (exportPasswordInput) {
    exportPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleExportPasswordUnlock();
    });
  }

  // Copy mnemonic
  const copyMnemonicBtn = document.getElementById('copy-mnemonic-btn');
  if (copyMnemonicBtn) {
    copyMnemonicBtn.addEventListener('click', copyMnemonicToClipboard);
  }

  // RPC API key subscreen
  setupRpcApiKeyListeners();

  // Initial render of RPC providers
  renderRpcProviders();
}

/**
 * Update identity state - called on init and after state changes
 */
export async function updateIdentityState() {
  try {
    const status = await window.identity.getStatus();

    if (!status.hasVault) {
      // No vault - show setup CTA
      showView('setup');
      return;
    }

    // Vault exists - show identity if we have addresses
    // Addresses are readable without unlock (stored in metadata + node config files)
    if (status.addresses && status.addresses.userWallet) {
      showView('identity');
      await loadIdentityData();
      return;
    }

    // Fallback: vault exists but no addresses available (shouldn't happen with new vaults)
    // This could happen with old vaults created before we stored addresses in metadata
    if (!status.isUnlocked) {
      showView('locked');
      return;
    }

    // Vault unlocked - show identity
    showView('identity');
    await loadIdentityData();

  } catch (err) {
    console.error('[WalletUI] Failed to update identity state:', err);
    showView('setup'); // Fallback to setup
  }
}

/**
 * Show a specific view
 */
function showView(view) {
  setupCta?.classList.toggle('hidden', view !== 'setup');
  lockedView?.classList.toggle('hidden', view !== 'locked');
  identityView?.classList.toggle('hidden', view !== 'identity');
}

/**
 * Load and display identity data
 */
async function loadIdentityData() {
  try {
    const status = await window.identity.getStatus();
    identityData = status;

    // Load derived wallets (multi-wallet support)
    await loadDerivedWallets();

    // Display Swarm/Bee address
    if (status.addresses?.beeWallet) {
      const addr = status.addresses.beeWallet;
      fullAddresses.swarm = addr;
      swarmIdEl.textContent = truncateAddress(addr);
      swarmIdEl.title = addr;
    }

    // Display IPFS Peer ID
    if (status.addresses?.ipfsPeerId) {
      const peerId = status.addresses.ipfsPeerId;
      fullAddresses.ipfs = peerId;
      ipfsIdEl.textContent = truncateAddress(peerId, 8, 6);
      ipfsIdEl.title = peerId;
    } else {
      ipfsIdEl.textContent = '--';
      ipfsIdEl.title = '';
    }

    // Display Radicle DID
    if (status.addresses?.radicleDid) {
      const did = status.addresses.radicleDid;
      fullAddresses.radicle = did;
      const displayId = did.replace('did:key:', '');
      radicleIdEl.textContent = truncateAddress(displayId, 8, 6);
      radicleIdEl.title = did;
    } else {
      radicleIdEl.textContent = '--';
      radicleIdEl.title = '';
    }

    // Hide lock button - it serves no purpose currently since identity info
    // is visible regardless of lock state. Re-enable when we add transaction
    // signing which requires vault unlock.
    const lockBtn = document.getElementById('sidebar-lock-btn');
    if (lockBtn) {
      lockBtn.classList.add('hidden');
    }

    // Update security status
    await updateSecurityStatus();

    // Load cached balances first (instant display), then refresh in background
    if (fullAddresses.wallet || fullAddresses.swarm) {
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

    // Password status
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

    // Created timestamp
    if (createdValueEl && vaultMeta?.createdAt) {
      createdValueEl.textContent = timeAgo(new Date(vaultMeta.createdAt));
    }
  } catch (err) {
    console.error('[WalletUI] Failed to load vault meta:', err);
  }

  // Touch ID status
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
// Balance Display
// ============================================

/**
 * Refresh wallet balances for both user wallet and Swarm node wallet
 * Runs silently in background - no loading indicators shown to user
 */
async function refreshBalances(forceRefresh = false) {
  const userAddress = fullAddresses.wallet;
  const swarmAddress = fullAddresses.swarm;

  if (!userAddress && !swarmAddress) return;

  hideBalanceError();

  try {
    // Clear cache if force refresh
    if (forceRefresh) {
      if (userAddress) await window.wallet.clearBalanceCache(userAddress);
      if (swarmAddress) await window.wallet.clearBalanceCache(swarmAddress);
    }

    // Fetch both wallets in parallel
    const [userResult, swarmResult] = await Promise.all([
      userAddress ? window.wallet.getBalances(userAddress) : Promise.resolve(null),
      swarmAddress ? window.wallet.getBalances(swarmAddress) : Promise.resolve(null),
    ]);

    // Display user wallet balances
    if (userResult?.success) {
      displayUserBalances(userResult.balances);
    } else if (userResult) {
      console.error('[WalletUI] Failed to fetch user balances:', userResult.error);
    }

    // Display Swarm node wallet balances
    if (swarmResult?.success) {
      displaySwarmBalances(swarmResult.balances);
    } else if (swarmResult) {
      console.error('[WalletUI] Failed to fetch Swarm balances:', swarmResult.error);
    }

  } catch (err) {
    console.error('[WalletUI] Failed to refresh balances:', err);
  }
}

/**
 * Load chain registry data and render the asset list
 */
async function loadChainRegistry() {
  try {
    const [chainsResult, tokensResult] = await Promise.all([
      window.chainRegistry.getChains(),
      window.chainRegistry.getTokens(),
    ]);

    if (chainsResult.success) {
      registeredChains = chainsResult.chains;
    }

    if (tokensResult.success) {
      registeredTokens = tokensResult.tokens;
      // Update chain switcher display (default: Gnosis Chain)
      updateChainSwitcherDisplay();
      renderAssetList();
    }
  } catch (err) {
    console.error('[WalletUI] Failed to load chain registry:', err);
  }
}

// ============================================
// Token/Chain Filter Helpers (reusable)
// ============================================

/**
 * Get tokens filtered by chain and with non-zero balance
 * Reusable for both asset list and send asset selector
 * @param {number|null} chainId - Filter by chain ID, or null for all chains
 * @returns {Array} Array of {key, ...tokenInfo} objects
 */
function getTokensWithBalance(chainId = null) {
  return Object.entries(registeredTokens)
    .filter(([key, token]) => {
      // Filter by chain (if specified)
      if (chainId !== null && token.chainId !== chainId) return false;
      // Filter by non-zero balance
      const balance = currentBalances[key];
      return balance && parseFloat(balance.formatted || '0') > 0;
    })
    .map(([key, token]) => ({ key, ...token }));
}

/**
 * Get chains that have tokens with non-zero balance
 * For send screen - only show chains where user can actually send
 * @returns {Array} Array of chain objects with chainId
 */
function getChainsWithBalance() {
  const chainIds = new Set();
  for (const [key, token] of Object.entries(registeredTokens)) {
    const balance = currentBalances[key];
    if (balance && parseFloat(balance.formatted || '0') > 0) {
      chainIds.add(token.chainId);
    }
  }
  return [...chainIds]
    .map(id => ({ chainId: id, ...registeredChains[id] }))
    .sort((a, b) => a.chainId - b.chainId);
}

/**
 * Sort tokens: native first, then by chainId, then alphabetically
 */
function sortTokens(tokens) {
  return [...tokens].sort((a, b) => {
    // Native tokens first
    if (a.address === null && b.address !== null) return -1;
    if (a.address !== null && b.address === null) return 1;
    // Then by chain ID
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    // Then by symbol
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * Render the asset list from registered tokens
 * Filters by selected chain and non-zero balance
 */
function renderAssetList() {
  if (!assetListEl) return;

  assetListEl.innerHTML = '';

  // Use helper to get filtered tokens
  const filteredTokens = getTokensWithBalance(selectedChainId);
  const sortedTokens = sortTokens(filteredTokens);

  for (const token of sortedTokens) {
    const chain = registeredChains[token.chainId];
    const chainName = chain?.name || `Chain ${token.chainId}`;

    const row = document.createElement('div');
    row.className = 'asset-row';
    row.dataset.tokenKey = token.key;

    // Logo or placeholder
    const logoHtml = token.logo && token.builtin
      ? `<img class="asset-logo" src="assets/tokens/${token.logo}" alt="${token.symbol}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';

    const placeholderHtml = `<div class="asset-logo-placeholder" style="${token.logo && token.builtin ? 'display:none' : ''}">${token.symbol.charAt(0)}</div>`;

    // Only show chain name when "All Chains" is selected
    const chainNameHtml = selectedChainId === null
      ? `<span class="asset-chain">${escapeHtml(chainName)}</span>`
      : '';

    row.innerHTML = `
      <div class="asset-info-wrapper">
        ${logoHtml}
        ${placeholderHtml}
        <div class="asset-info">
          <span class="asset-symbol">${escapeHtml(token.symbol)}</span>
          ${chainNameHtml}
        </div>
      </div>
      <span class="asset-value" id="balance-${token.key.replace(':', '-')}">--</span>
    `;

    assetListEl.appendChild(row);
  }

  // Show appropriate state message
  if (sortedTokens.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'asset-list-empty';

    if (Object.keys(currentBalances).length === 0) {
      // Balances not loaded yet
      emptyEl.textContent = 'Loading balances...';
    } else {
      // Balances loaded but all are zero
      emptyEl.textContent = 'No assets with balance';
    }

    assetListEl.appendChild(emptyEl);
  }

  // Update balance values for rendered elements
  for (const [tokenKey, balance] of Object.entries(currentBalances)) {
    const elementId = `balance-${tokenKey.replace(':', '-')}`;
    const balanceEl = document.getElementById(elementId);

    if (balanceEl && balance?.formatted) {
      balanceEl.textContent = formatBalance(balance.formatted);
    }
  }
}

/**
 * Display user wallet balances in the Wallet tab
 * Balances are keyed by token key (e.g., "1:native", "100:0xdBF3...")
 */
function displayUserBalances(balances) {
  if (!balances) return;

  // Store balances and re-render to show only non-zero assets
  currentBalances = balances;
  renderAssetList();
}

/**
 * Display Swarm node wallet balances in the Nodes tab
 * Swarm node only uses Gnosis chain tokens (xDAI and xBZZ)
 */
function displaySwarmBalances(balances) {
  if (!balances) return;

  // xDAI balance (Gnosis native token)
  const xdaiKey = '100:native';
  const xdaiBalance = balances[xdaiKey];
  if (swarmBalanceXdaiEl) {
    if (xdaiBalance?.error) {
      swarmBalanceXdaiEl.textContent = 'Error';
      swarmBalanceXdaiEl.classList.add('error');
    } else if (xdaiBalance?.formatted) {
      swarmBalanceXdaiEl.textContent = formatBalance(xdaiBalance.formatted);
      swarmBalanceXdaiEl.classList.remove('error');
    } else {
      swarmBalanceXdaiEl.textContent = '--';
    }
  }

  // xBZZ balance (find the xBZZ token key)
  const xbzzKey = Object.keys(registeredTokens).find(key =>
    registeredTokens[key].symbol === 'xBZZ' && registeredTokens[key].chainId === 100
  );
  const xbzzBalance = xbzzKey ? balances[xbzzKey] : null;
  if (swarmBalanceXbzzEl) {
    if (xbzzBalance?.error) {
      swarmBalanceXbzzEl.textContent = 'Error';
      swarmBalanceXbzzEl.classList.add('error');
    } else if (xbzzBalance?.formatted) {
      swarmBalanceXbzzEl.textContent = formatBalance(xbzzBalance.formatted);
      swarmBalanceXbzzEl.classList.remove('error');
    } else {
      swarmBalanceXbzzEl.textContent = '--';
    }
  }
}

/**
 * Load cached balances for instant display on startup
 * Uses persistent cache so balances appear immediately instead of "--"
 * Note: getBalancesCached already triggers a background refresh when returning
 * cached data, so we don't need to manually trigger another refresh here.
 */
async function loadCachedBalances() {
  const userAddress = fullAddresses.wallet;
  const swarmAddress = fullAddresses.swarm;

  if (!userAddress && !swarmAddress) return;

  try {
    // Fetch cached balances for both wallets in parallel
    // The backend will return cached data immediately and refresh in background
    const [userResult, swarmResult] = await Promise.all([
      userAddress ? window.wallet.getBalancesCached(userAddress) : Promise.resolve(null),
      swarmAddress ? window.wallet.getBalancesCached(swarmAddress) : Promise.resolve(null),
    ]);

    // Display user wallet cached balances
    if (userResult?.success && userResult.balances) {
      displayUserBalances(userResult.balances);
    }

    // Display Swarm wallet cached balances
    if (swarmResult?.success && swarmResult.balances) {
      displaySwarmBalances(swarmResult.balances);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to load cached balances:', err);
  }
}

/**
 * Format balance for display
 */
function formatBalance(formatted, maxDecimals = 4) {
  const num = parseFloat(formatted);
  if (isNaN(num)) return '0';
  if (num === 0) return '0';
  if (num < 0.0001) return '<0.0001';

  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

/**
 * Show balance error
 */
function showBalanceError(message) {
  if (balanceErrorEl) {
    const textEl = document.getElementById('balance-error-text');
    if (textEl) {
      textEl.textContent = message;
    }
    balanceErrorEl.classList.remove('hidden');
  }
}

/**
 * Hide balance error
 */
function hideBalanceError() {
  if (balanceErrorEl) {
    balanceErrorEl.classList.add('hidden');
  }
}

/**
 * Start automatic balance refresh
 */
function startBalanceRefresh() {
  stopBalanceRefresh();
  balanceRefreshInterval = setInterval(() => {
    // Only refresh if wallet tab is visible
    const walletTab = document.getElementById('tab-wallet');
    if (walletTab && !walletTab.classList.contains('hidden') && fullAddresses.wallet) {
      refreshBalances();
    }
  }, BALANCE_REFRESH_MS);
}

/**
 * Stop automatic balance refresh
 */
function stopBalanceRefresh() {
  if (balanceRefreshInterval) {
    clearInterval(balanceRefreshInterval);
    balanceRefreshInterval = null;
  }
}

/**
 * Format a date as "time ago" string
 */
function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count > 1 ? 's' : ''} ago`;
    }
  }

  return 'Just now';
}

/**
 * Handle unlock button click
 */
async function handleUnlock() {
  try {
    // Try Touch ID first if available
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    if (touchIdEnabled) {
      const result = await window.quickUnlock.unlock();
      if (result.success) {
        // Unlock vault with the password from Touch ID
        await window.identity.unlock(result.password);
        updateIdentityState();
        return;
      }
    }

    // Fall back to password prompt
    // TODO: Implement password prompt modal
    // For now, just log
    console.log('[WalletUI] Password prompt not implemented yet');
    alert('Password unlock coming soon. Use Touch ID if available.');

  } catch (err) {
    console.error('[WalletUI] Unlock failed:', err);
  }
}

/**
 * Handle lock button click
 */
async function handleLock() {
  try {
    await window.identity.lock();
    updateIdentityState();
  } catch (err) {
    console.error('[WalletUI] Lock failed:', err);
  }
}

// ============================================
// Tab Switching
// ============================================

/**
 * Switch between Wallet and Identity tabs
 */
function switchTab(tabName) {
  // Close any open sub-screens first
  closeAllSubscreens();

  // Update tab buttons
  document.querySelectorAll('.sidebar-tab').forEach(tab => {
    if (tab.dataset.tab === tabName) {
      tab.classList.add('active');
    } else {
      tab.classList.remove('active');
    }
  });

  // Update tab panels
  document.querySelectorAll('.tab-panel').forEach(panel => {
    if (panel.id === `tab-${tabName}`) {
      panel.classList.remove('hidden');
    } else {
      panel.classList.add('hidden');
    }
  });
}

/**
 * Close all open sub-screens
 * Called when switching tabs to ensure main view is visible
 */
function closeAllSubscreens() {
  // Only close sub-screens that are actually open to avoid unnecessary cleanup
  if (exportMnemonicScreen && !exportMnemonicScreen.classList.contains('hidden')) {
    closeExportMnemonic();
  }
  if (createWalletScreen && !createWalletScreen.classList.contains('hidden')) {
    closeCreateWallet();
  }
  if (receiveScreen && !receiveScreen.classList.contains('hidden')) {
    closeReceive();
  }
  if (walletSettingsScreen && !walletSettingsScreen.classList.contains('hidden')) {
    closeWalletSettings();
  }
  if (sendScreen && !sendScreen.classList.contains('hidden')) {
    closeSend();
  }
  // RPC API key subscreen
  const rpcApiKeyScreen = document.getElementById('sidebar-rpc-apikey');
  if (rpcApiKeyScreen && !rpcApiKeyScreen.classList.contains('hidden')) {
    closeRpcApiKeyScreen();
  }
}

/**
 * Copy address to clipboard
 */
async function copyToClipboard(type, buttonEl) {
  const address = fullAddresses[type];
  if (!address) return;

  try {
    await window.electronAPI.copyText(address);

    // Visual feedback
    buttonEl.classList.add('copied');
    setTimeout(() => {
      buttonEl.classList.remove('copied');
    }, 1500);
  } catch (err) {
    console.error('[WalletUI] Copy failed:', err);
  }
}

/**
 * Toggle QR code display
 */
function toggleQrCode() {
  if (!qrContainer || !qrCanvas) return;

  const isHidden = qrContainer.classList.contains('hidden');

  if (isHidden && fullAddresses.wallet) {
    // Generate and show QR code
    generateQrCode(fullAddresses.wallet);
    qrContainer.classList.remove('hidden');
  } else {
    qrContainer.classList.add('hidden');
  }
}

/**
 * Generate QR code on canvas
 */
function generateQrCode(text) {
  // Simple QR code using a library would be better
  // For now, just show the address text as placeholder
  // TODO: Add qrcode library or use a simple implementation

  const ctx = qrCanvas.getContext('2d');
  const size = 150;
  qrCanvas.width = size;
  qrCanvas.height = size;

  // Placeholder - draw a simple pattern
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  ctx.font = '10px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('QR Code', size/2, size/2 - 10);
  ctx.fillText('Coming Soon', size/2, size/2 + 10);
}

/**
 * Truncate address for display
 */
function truncateAddress(address, startChars = 6, endChars = 4) {
  if (!address || address.length <= startChars + endChars + 3) {
    return address;
  }
  return `${address.slice(0, startChars)}...${address.slice(-endChars)}`;
}

// ============================================
// Export Mnemonic Sub-screen
// ============================================

/**
 * Open the export mnemonic sub-screen
 */
async function openExportMnemonic() {
  // Hide main identity view, show sub-screen
  identityView?.classList.add('hidden');
  exportMnemonicScreen?.classList.remove('hidden');

  // Check vault status
  const status = await window.identity.getStatus();

  if (status.isUnlocked) {
    // Already unlocked - show mnemonic directly
    await showMnemonicWords();
  } else {
    // Need to unlock - configure unlock UI
    await configureUnlockUI();
    showExportView('unlock');
  }
}

/**
 * Close the export mnemonic sub-screen
 */
async function closeExportMnemonic() {
  // Clear mnemonic for security
  const wordsContainer = document.getElementById('mnemonic-words');
  if (wordsContainer) {
    wordsContainer.innerHTML = '';
  }

  // Clear password input
  const passwordInput = document.getElementById('export-password-input');
  if (passwordInput) {
    passwordInput.value = '';
  }

  // Clear error
  const errorEl = document.getElementById('export-unlock-error');
  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  // Reset copy button
  const copyBtn = document.getElementById('copy-mnemonic-btn');
  if (copyBtn) {
    copyBtn.classList.remove('copied');
  }

  // Lock the vault for security
  try {
    await window.identity.lock();
    console.log('[WalletUI] Vault locked after export');
  } catch (err) {
    console.error('[WalletUI] Failed to lock vault:', err);
  }

  // Hide sub-screen, show main identity view
  exportMnemonicScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');
}

/**
 * Configure unlock UI based on available methods
 */
async function configureUnlockUI() {
  try {
    // Check if Touch ID is available and enabled
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    // Check if user knows their password
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    // Show/hide Touch ID button
    if (exportTouchIdBtn) {
      if (canUseTouchId && touchIdEnabled) {
        exportTouchIdBtn.classList.remove('hidden');
      } else {
        exportTouchIdBtn.classList.add('hidden');
      }
    }

    // Show/hide password section (only if user knows password)
    if (exportPasswordSection) {
      if (userKnowsPassword) {
        exportPasswordSection.classList.remove('hidden');
      } else {
        exportPasswordSection.classList.add('hidden');
      }
    }

    // If Touch ID is available and enabled, try it automatically
    if (canUseTouchId && touchIdEnabled) {
      // Small delay to let the UI render first
      setTimeout(() => handleExportTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure unlock UI:', err);
  }
}

/**
 * Show either unlock or mnemonic view
 */
function showExportView(view) {
  if (view === 'unlock') {
    exportUnlockRequired?.classList.remove('hidden');
    exportMnemonicDisplay?.classList.add('hidden');
  } else {
    exportUnlockRequired?.classList.add('hidden');
    exportMnemonicDisplay?.classList.remove('hidden');
  }
}

/**
 * Handle Touch ID unlock for export
 */
async function handleExportTouchIdUnlock() {
  const errorEl = document.getElementById('export-unlock-error');

  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    // Unlock the vault with the password from Touch ID
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    // Show mnemonic
    await showMnemonicWords();
  } catch (err) {
    console.error('[WalletUI] Touch ID unlock failed:', err);
    if (errorEl && err.message !== 'Touch ID cancelled') {
      errorEl.textContent = err.message || 'Touch ID failed';
      errorEl.classList.remove('hidden');
    }
  }
}

/**
 * Handle password unlock for export
 */
async function handleExportPasswordUnlock() {
  const passwordInput = document.getElementById('export-password-input');
  const errorEl = document.getElementById('export-unlock-error');
  const password = passwordInput?.value;

  if (!password) {
    if (errorEl) {
      errorEl.textContent = 'Please enter your password';
      errorEl.classList.remove('hidden');
    }
    return;
  }

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    // Show mnemonic
    await showMnemonicWords();
  } catch (err) {
    console.error('[WalletUI] Password unlock failed:', err);
    if (errorEl) {
      errorEl.textContent = err.message || 'Failed to unlock';
      errorEl.classList.remove('hidden');
    }
  }
}

/**
 * Display mnemonic words
 */
async function showMnemonicWords() {
  try {
    const result = await window.identity.exportMnemonic();
    if (!result.success) {
      throw new Error(result.error || 'Failed to export mnemonic');
    }

    const words = result.mnemonic.split(' ');
    const container = document.getElementById('mnemonic-words');
    if (!container) return;

    // Clear and populate with words
    container.innerHTML = '';
    words.forEach((word, index) => {
      const wordEl = document.createElement('div');
      wordEl.className = 'mnemonic-word';
      wordEl.innerHTML = `
        <span class="mnemonic-word-num">${index + 1}</span>
        <span class="mnemonic-word-text">${word}</span>
      `;
      container.appendChild(wordEl);
    });

    // Show mnemonic view
    showExportView('mnemonic');
  } catch (err) {
    console.error('[WalletUI] Failed to show mnemonic:', err);
    const errorEl = document.getElementById('export-unlock-error');
    if (errorEl) {
      errorEl.textContent = err.message || 'Failed to export';
      errorEl.classList.remove('hidden');
    }
  }
}

/**
 * Copy mnemonic to clipboard
 */
async function copyMnemonicToClipboard() {
  try {
    const result = await window.identity.exportMnemonic();
    if (!result.success) {
      throw new Error(result.error);
    }

    await window.electronAPI.copyText(result.mnemonic);

    // Visual feedback
    const btn = document.getElementById('copy-mnemonic-btn');
    if (btn) {
      btn.classList.add('copied');
      const span = btn.querySelector('span');
      const originalText = span?.textContent;
      if (span) span.textContent = 'Copied!';

      setTimeout(() => {
        btn.classList.remove('copied');
        if (span && originalText) span.textContent = originalText;
      }, 2000);
    }
  } catch (err) {
    console.error('[WalletUI] Copy mnemonic failed:', err);
  }
}

// ============================================
// Wallet Selector (Multi-Wallet)
// ============================================

/**
 * Setup wallet selector dropdown
 */
function setupWalletSelector() {
  // Toggle dropdown
  if (walletSelectorBtn) {
    walletSelectorBtn.addEventListener('click', toggleWalletDropdown);
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const selector = document.getElementById('wallet-selector');
    if (selector && !selector.contains(e.target)) {
      closeWalletDropdown();
    }
  });

  // Create wallet button - opens sub-screen
  if (walletCreateBtn) {
    walletCreateBtn.addEventListener('click', () => {
      closeWalletDropdown();
      openCreateWallet();
    });
  }
}

/**
 * Toggle wallet dropdown
 */
function toggleWalletDropdown() {
  const selector = document.getElementById('wallet-selector');
  if (!selector || !walletSelectorDropdown) return;

  const isOpen = selector.classList.contains('open');

  if (isOpen) {
    closeWalletDropdown();
  } else {
    selector.classList.add('open');
    walletSelectorDropdown.classList.remove('hidden');
    renderWalletList();
  }
}

/**
 * Close wallet dropdown
 */
function closeWalletDropdown() {
  const selector = document.getElementById('wallet-selector');
  if (selector) {
    selector.classList.remove('open');
  }
  if (walletSelectorDropdown) {
    walletSelectorDropdown.classList.add('hidden');
  }
}

/**
 * Render wallet list in dropdown
 */
function renderWalletList() {
  if (!walletSelectorList) return;

  walletSelectorList.innerHTML = '';

  derivedWallets.forEach(wallet => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'wallet-selector-item';
    if (wallet.index === activeWalletIndex) {
      item.classList.add('active');
    }

    const truncatedAddress = wallet.address
      ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
      : '--';

    item.innerHTML = `
      <div class="wallet-selector-item-info">
        <span class="wallet-selector-item-name">${escapeHtml(wallet.name)}</span>
        <div class="wallet-selector-item-address-row">
          <code class="wallet-selector-item-address">${truncatedAddress}</code>
          ${wallet.address ? `
            <button type="button" class="wallet-selector-item-btn copy" data-address="${wallet.address}" title="Copy address">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
      <div class="wallet-selector-item-actions">
        ${wallet.index === activeWalletIndex ? `
          <svg class="wallet-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ` : ''}
      </div>
    `;

    // Click to select wallet
    item.addEventListener('click', (e) => {
      // Don't select if clicking copy button
      if (e.target.closest('.wallet-selector-item-btn')) return;
      selectWallet(wallet.index);
    });

    // Copy button handler
    const copyBtn = item.querySelector('.wallet-selector-item-btn.copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const address = copyBtn.dataset.address;
        if (address) {
          await handleCopyWalletAddress(address, copyBtn);
        }
      });
    }

    walletSelectorList.appendChild(item);
  });
}

/**
 * Handle copying wallet address from dropdown
 */
async function handleCopyWalletAddress(address, buttonEl) {
  try {
    await window.electronAPI.copyText(address);

    // Visual feedback - change icon to checkmark
    buttonEl.classList.add('copied');
    buttonEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    `;

    setTimeout(() => {
      buttonEl.classList.remove('copied');
      buttonEl.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      `;
    }, 1500);
  } catch (err) {
    console.error('[WalletUI] Copy address failed:', err);
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// Chain Switcher
// ============================================

/**
 * Setup chain switcher dropdown
 */
function setupChainSwitcher() {
  // Toggle dropdown
  if (chainSwitcherBtn) {
    chainSwitcherBtn.addEventListener('click', toggleChainDropdown);
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const switcher = document.getElementById('chain-switcher');
    if (switcher && !switcher.contains(e.target)) {
      closeChainDropdown();
    }
  });
}

/**
 * Toggle chain dropdown
 */
async function toggleChainDropdown() {
  const switcher = document.getElementById('chain-switcher');
  if (!switcher || !chainSwitcherDropdown) return;

  const isOpen = switcher.classList.contains('open');

  if (isOpen) {
    closeChainDropdown();
  } else {
    switcher.classList.add('open');
    chainSwitcherDropdown.classList.remove('hidden');
    await renderChainList();
  }
}

/**
 * Close chain dropdown
 */
function closeChainDropdown() {
  const switcher = document.getElementById('chain-switcher');
  if (switcher) {
    switcher.classList.remove('open');
  }
  if (chainSwitcherDropdown) {
    chainSwitcherDropdown.classList.add('hidden');
  }
}

/**
 * Render chain list in dropdown
 */
async function renderChainList() {
  if (!chainSwitcherList) return;

  chainSwitcherList.innerHTML = '';

  // Fetch available chains
  const availableResult = await window.chainRegistry.getAvailableChains();
  const availableChains = availableResult.success ? availableResult.chains : {};
  const availableChainIds = new Set(Object.keys(availableChains));
  const availableCount = availableChainIds.size;

  // Only show "All Chains" if more than one chain is available
  if (availableCount > 1) {
    const allItem = document.createElement('button');
    allItem.type = 'button';
    allItem.className = 'chain-switcher-item';
    if (selectedChainId === null) {
      allItem.classList.add('active');
    }

    allItem.innerHTML = `
      <div class="chain-switcher-item-info">
        <span class="chain-switcher-item-name">All Chains</span>
      </div>
      ${selectedChainId === null ? `
        <svg class="chain-switcher-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    allItem.addEventListener('click', () => selectChain(null));
    chainSwitcherList.appendChild(allItem);
  }

  // Add each chain
  for (const [chainIdStr, chain] of Object.entries(registeredChains)) {
    const chainId = parseInt(chainIdStr);
    const isAvailable = availableChainIds.has(chainIdStr);

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chain-switcher-item';

    if (chainId === selectedChainId) {
      item.classList.add('active');
    }

    if (!isAvailable) {
      item.classList.add('disabled');
    }

    const logoHtml = chain.logo
      ? `<img class="chain-switcher-item-logo" src="assets/chains/${chain.logo}" alt="${chain.name}">`
      : '';

    const unavailableHtml = !isAvailable
      ? '<span class="chain-switcher-item-unavailable">No RPC</span>'
      : '';

    item.innerHTML = `
      <div class="chain-switcher-item-info">
        ${logoHtml}
        <span class="chain-switcher-item-name">${escapeHtml(chain.name)}</span>
      </div>
      ${unavailableHtml}
      ${chainId === selectedChainId && isAvailable ? `
        <svg class="chain-switcher-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    // Only add click handler if chain is available
    if (isAvailable) {
      item.addEventListener('click', () => selectChain(chainId));
    }

    chainSwitcherList.appendChild(item);
  }
}

/**
 * Select a chain
 */
function selectChain(chainId) {
  closeChainDropdown();

  const previousChainId = selectedChainId;
  selectedChainId = chainId;

  // Update button display
  updateChainSwitcherDisplay();

  // Re-render asset list filtered by chain
  renderAssetList();

  // Emit chainChanged event to active webview if chain actually changed
  if (previousChainId !== chainId && chainId !== null) {
    const webview = getActiveWebview();
    if (webview) {
      const chainIdHex = '0x' + chainId.toString(16);
      emitChainChanged(webview, chainIdHex);
      console.log('[WalletUI] Emitted chainChanged to dApp:', chainIdHex);
    }
  }
}

/**
 * Update chain switcher button display
 */
function updateChainSwitcherDisplay() {
  if (selectedChainId === null) {
    if (chainSwitcherName) chainSwitcherName.textContent = 'All Chains';
    if (chainSwitcherLogo) chainSwitcherLogo.src = '';
  } else {
    const chain = registeredChains[selectedChainId];
    if (chain) {
      if (chainSwitcherName) chainSwitcherName.textContent = chain.name;
      if (chainSwitcherLogo && chain.logo) {
        chainSwitcherLogo.src = `assets/chains/${chain.logo}`;
      } else if (chainSwitcherLogo) {
        chainSwitcherLogo.src = '';
      }
    }
  }
}

// ============================================
// Receive Screen
// ============================================

/**
 * Setup receive screen event handlers
 */
function setupReceiveScreen() {
  // Back button
  if (receiveBackBtn) {
    receiveBackBtn.addEventListener('click', closeReceive);
  }

  // Copy button
  if (receiveCopyBtn) {
    receiveCopyBtn.addEventListener('click', handleReceiveCopyAddress);
  }

  // Receive button in wallet actions
  const receiveBtn = document.getElementById('wallet-receive-btn');
  if (receiveBtn) {
    receiveBtn.addEventListener('click', openReceive);
  }
}

/**
 * Open the receive sub-screen
 */
async function openReceive() {
  if (!fullAddresses.wallet) {
    console.error('[WalletUI] No wallet address available');
    return;
  }

  // Hide main identity view, show receive screen
  identityView?.classList.add('hidden');
  receiveScreen?.classList.remove('hidden');

  // Display the address
  if (receiveAddress) {
    receiveAddress.textContent = fullAddresses.wallet;
  }

  // Detect theme - light mode has data-theme="light", dark mode has no attribute
  const isLightMode = document.documentElement.getAttribute('data-theme') === 'light';

  // Get the toolbar color from CSS variable for dark mode background
  const toolbarColor = getComputedStyle(document.documentElement)
    .getPropertyValue('--toolbar').trim() || '#3c3c3c';

  // Generate QR code with theme-appropriate colors
  // Dark mode: light QR pixels on toolbar background
  // Light mode: dark QR pixels on white background
  const qrColors = isLightMode
    ? { dark: '#000000', light: '#ffffff' }
    : { dark: '#ffffff', light: toolbarColor };

  try {
    const result = await window.wallet.generateQR(fullAddresses.wallet, {
      width: 200,
      margin: 2,
      dark: qrColors.dark,
      light: qrColors.light,
      errorCorrectionLevel: 'M',
    });

    if (result.success && receiveQrImage) {
      receiveQrImage.src = result.dataUrl;
      receiveQrImage.alt = `QR Code for ${fullAddresses.wallet}`;
    } else {
      console.error('[WalletUI] Failed to generate QR code:', result.error);
    }
  } catch (err) {
    console.error('[WalletUI] QR generation error:', err);
  }
}

/**
 * Close the receive sub-screen
 */
function closeReceive() {
  // Hide receive screen, show main identity view
  receiveScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');

  // Reset copy button state
  if (receiveCopyBtn) {
    receiveCopyBtn.classList.remove('copied');
    const span = receiveCopyBtn.querySelector('span');
    if (span) span.textContent = 'Copy Address';
  }
}

/**
 * Handle copy address button click in receive screen
 */
async function handleReceiveCopyAddress() {
  if (!fullAddresses.wallet) return;

  try {
    await window.electronAPI.copyText(fullAddresses.wallet);

    // Visual feedback
    if (receiveCopyBtn) {
      receiveCopyBtn.classList.add('copied');
      const span = receiveCopyBtn.querySelector('span');
      if (span) span.textContent = 'Copied!';

      setTimeout(() => {
        receiveCopyBtn.classList.remove('copied');
        if (span) span.textContent = 'Copy Address';
      }, 2000);
    }
  } catch (err) {
    console.error('[WalletUI] Copy address failed:', err);
  }
}

// ============================================
// Wallet Settings Screen
// ============================================

/**
 * Setup wallet settings screen event handlers
 */
function setupWalletSettingsScreen() {
  // Settings button in headline
  const settingsBtn = document.getElementById('wallet-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', openWalletSettings);
  }

  // Back button
  if (walletSettingsBackBtn) {
    walletSettingsBackBtn.addEventListener('click', () => {
      closeWalletSettings();
      switchTab('wallet');
    });
  }

  // Delete button
  if (walletSettingsDeleteBtn) {
    walletSettingsDeleteBtn.addEventListener('click', handleWalletSettingsDelete);
  }

  // Export private key button
  const exportPkBtn = document.getElementById('wallet-settings-export-pk');
  if (exportPkBtn) {
    exportPkBtn.addEventListener('click', handleExportPrivateKeyClick);
  }

  // Export PK Touch ID button
  if (exportPkTouchIdBtn) {
    exportPkTouchIdBtn.addEventListener('click', handleExportPkTouchIdUnlock);
  }

  // Export PK password submit
  if (exportPkPasswordSubmit) {
    exportPkPasswordSubmit.addEventListener('click', handleExportPkPasswordUnlock);
  }

  // Export PK password input enter key
  if (exportPkPasswordInput) {
    exportPkPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleExportPkPasswordUnlock();
    });
  }

  // Export PK copy button
  if (exportPkCopyBtn) {
    exportPkCopyBtn.addEventListener('click', handleExportPkCopy);
  }
}

/**
 * Open the wallet settings sub-screen
 */
function openWalletSettings() {
  const activeWallet = derivedWallets.find(w => w.index === activeWalletIndex);
  if (!activeWallet) {
    console.error('[WalletUI] No active wallet found');
    return;
  }

  // Hide main identity view, show wallet settings screen
  identityView?.classList.add('hidden');
  walletSettingsScreen?.classList.remove('hidden');

  // Populate wallet info
  if (walletSettingsName) {
    walletSettingsName.textContent = activeWallet.name;
  }
  if (walletSettingsAddress) {
    walletSettingsAddress.textContent = activeWallet.address || '--';
  }

  // Disable delete for main wallet (index 0)
  if (walletSettingsDeleteBtn) {
    if (activeWallet.index === 0) {
      walletSettingsDeleteBtn.disabled = true;
      walletSettingsDeleteBtn.title = 'Main wallet cannot be deleted';
    } else {
      walletSettingsDeleteBtn.disabled = false;
      walletSettingsDeleteBtn.title = '';
    }
  }

  // Reset export private key view to initial state
  resetExportPkView();
}

/**
 * Close the wallet settings sub-screen
 */
function closeWalletSettings() {
  // Clear sensitive data
  resetExportPkView();

  // Hide wallet settings screen, show main identity view
  walletSettingsScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');
}

/**
 * Handle delete wallet from settings screen
 */
async function handleWalletSettingsDelete() {
  const activeWallet = derivedWallets.find(w => w.index === activeWalletIndex);
  if (!activeWallet || activeWallet.index === 0) {
    return;
  }

  if (!confirm(`Delete "${activeWallet.name}"?\n\nThe wallet can be recovered from your mnemonic phrase, but any custom name will be lost.`)) {
    return;
  }

  try {
    const result = await window.wallet.deleteWallet(activeWallet.index);
    if (!result.success) {
      throw new Error(result.error);
    }

    // Remove from local list
    derivedWallets = derivedWallets.filter(w => w.index !== activeWallet.index);

    // Switch to main wallet
    await selectWallet(0);

    // Close settings screen
    closeWalletSettings();
    switchTab('wallet');
  } catch (err) {
    console.error('[WalletUI] Failed to delete wallet:', err);
    alert(`Failed to delete wallet: ${err.message}`);
  }
}

// ============================================
// Export Private Key
// ============================================

/**
 * Reset export private key view to initial state
 */
function resetExportPkView() {
  // Show button view, hide others
  exportPkButtonView?.classList.remove('hidden');
  exportPkUnlockView?.classList.add('hidden');
  exportPkDisplayView?.classList.add('hidden');

  // Clear password input
  if (exportPkPasswordInput) {
    exportPkPasswordInput.value = '';
  }

  // Clear error
  if (exportPkError) {
    exportPkError.classList.add('hidden');
    exportPkError.textContent = '';
  }

  // Clear private key value
  if (exportPkValue) {
    exportPkValue.textContent = '';
  }

  // Reset copy button
  if (exportPkCopyBtn) {
    exportPkCopyBtn.classList.remove('copied');
    const span = exportPkCopyBtn.querySelector('span');
    if (span) span.textContent = 'Copy';
  }
}

/**
 * Handle export private key button click
 */
async function handleExportPrivateKeyClick() {
  // Check if vault is already unlocked
  const status = await window.identity.getStatus();

  if (status.isUnlocked) {
    // Already unlocked - show private key directly
    await showPrivateKey();
  } else {
    // Need to unlock - show unlock view
    await configureExportPkUnlockUI();
    showExportPkView('unlock');
  }
}

/**
 * Configure unlock UI for export private key
 */
async function configureExportPkUnlockUI() {
  try {
    // Check Touch ID availability
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    // Check if user knows password
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    // Show/hide Touch ID button
    if (exportPkTouchIdBtn) {
      exportPkTouchIdBtn.classList.toggle('hidden', !(canUseTouchId && touchIdEnabled));
    }

    // Show/hide password section
    if (exportPkPasswordSection) {
      exportPkPasswordSection.classList.toggle('hidden', !userKnowsPassword);
    }

    // Auto-trigger Touch ID if available
    if (canUseTouchId && touchIdEnabled) {
      setTimeout(() => handleExportPkTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure export PK unlock UI:', err);
  }
}

/**
 * Show a specific export private key view
 */
function showExportPkView(view) {
  exportPkButtonView?.classList.toggle('hidden', view !== 'button');
  exportPkUnlockView?.classList.toggle('hidden', view !== 'unlock');
  exportPkDisplayView?.classList.toggle('hidden', view !== 'display');
}

/**
 * Handle Touch ID unlock for export private key
 */
async function handleExportPkTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    // Unlock the vault with the password from Touch ID
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    // Show private key
    await showPrivateKey();
  } catch (err) {
    console.error('[WalletUI] Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showExportPkError(err.message || 'Touch ID failed');
    }
  }
}

/**
 * Handle password unlock for export private key
 */
async function handleExportPkPasswordUnlock() {
  const password = exportPkPasswordInput?.value;
  if (!password) {
    showExportPkError('Please enter your password');
    return;
  }

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    // Show private key
    await showPrivateKey();
  } catch (err) {
    console.error('[WalletUI] Password unlock failed:', err);
    showExportPkError(err.message || 'Failed to unlock');
  }
}

/**
 * Show export private key error
 */
function showExportPkError(message) {
  if (exportPkError) {
    exportPkError.textContent = message;
    exportPkError.classList.remove('hidden');
  }
}

/**
 * Show the private key
 */
async function showPrivateKey() {
  try {
    const result = await window.identity.exportPrivateKey(activeWalletIndex);
    if (!result.success) {
      throw new Error(result.error || 'Failed to export private key');
    }

    // Display the private key
    if (exportPkValue) {
      exportPkValue.textContent = result.privateKey;
    }

    // Show display view
    showExportPkView('display');
  } catch (err) {
    console.error('[WalletUI] Failed to export private key:', err);
    showExportPkError(err.message || 'Failed to export');
  }
}

/**
 * Handle copy private key
 */
async function handleExportPkCopy() {
  const privateKey = exportPkValue?.textContent;
  if (!privateKey) return;

  try {
    await window.electronAPI.copyText(privateKey);

    // Visual feedback
    if (exportPkCopyBtn) {
      exportPkCopyBtn.classList.add('copied');
      const span = exportPkCopyBtn.querySelector('span');
      if (span) span.textContent = 'Copied!';

      setTimeout(() => {
        exportPkCopyBtn.classList.remove('copied');
        if (span) span.textContent = 'Copy';
      }, 2000);
    }
  } catch (err) {
    console.error('[WalletUI] Copy private key failed:', err);
  }
}

/**
 * Select a wallet
 */
async function selectWallet(index) {
  closeWalletDropdown();

  try {
    const result = await window.wallet.setActiveWallet(index);
    if (!result.success) {
      throw new Error(result.error);
    }

    activeWalletIndex = index;
    const selectedWallet = derivedWallets.find(w => w.index === index);

    if (selectedWallet) {
      updateWalletSelectorDisplay(selectedWallet);
      fullAddresses.wallet = selectedWallet.address || '';

      // Refresh balances for the new wallet
      refreshBalances();
    }
  } catch (err) {
    console.error('[WalletUI] Failed to select wallet:', err);
  }
}

/**
 * Update wallet selector display
 */
function updateWalletSelectorDisplay(wallet) {
  if (walletSelectorName) {
    walletSelectorName.textContent = wallet.name;
  }
  if (walletSelectorAddress && wallet.address) {
    walletSelectorAddress.textContent = wallet.address;
  }
  // Update headline name (all caps)
  if (walletHeadlineName) {
    walletHeadlineName.textContent = wallet.name.toUpperCase();
  }
}

// ============================================
// Send Screen
// ============================================

/**
 * Setup send screen event handlers
 */
function setupSendScreen() {
  // Send button in wallet actions
  const sendBtn = document.getElementById('wallet-send-btn');
  if (sendBtn) {
    sendBtn.addEventListener('click', openSend);
  }

  // Back button
  if (sendBackBtn) {
    sendBackBtn.addEventListener('click', () => {
      closeSend();
    });
  }

  // Chain selector toggle
  if (sendChainBtn) {
    sendChainBtn.addEventListener('click', toggleSendChainDropdown);
  }

  // Asset selector toggle
  if (sendAssetBtn) {
    sendAssetBtn.addEventListener('click', toggleSendAssetDropdown);
  }

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (sendChainSelector && !sendChainSelector.contains(e.target)) {
      closeSendChainDropdown();
    }
    if (sendAssetSelector && !sendAssetSelector.contains(e.target)) {
      closeSendAssetDropdown();
    }
  });

  // Recipient input - clear errors on input (validation on Continue click)
  if (sendRecipientInput) {
    sendRecipientInput.addEventListener('input', () => {
      clearSendError('recipient');
    });
  }

  // Amount input - clear errors on input (validation on Continue click)
  if (sendAmountInput) {
    sendAmountInput.addEventListener('input', () => {
      clearSendError('amount');
    });
  }

  // MAX button
  if (sendMaxBtn) {
    sendMaxBtn.addEventListener('click', handleSendMax);
  }

  // Continue button
  if (sendContinueBtn) {
    sendContinueBtn.addEventListener('click', handleSendContinue);
  }

  // Edit button (back to input)
  if (sendEditBtn) {
    sendEditBtn.addEventListener('click', showSendInputView);
  }

  // Confirm button
  if (sendConfirmBtn) {
    sendConfirmBtn.addEventListener('click', handleSendConfirm);
  }

  // Unlock buttons
  if (sendTouchIdBtn) {
    sendTouchIdBtn.addEventListener('click', handleSendTouchIdUnlock);
  }
  if (sendPasswordSubmit) {
    sendPasswordSubmit.addEventListener('click', handleSendPasswordUnlock);
  }
  if (sendPasswordInput) {
    sendPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSendPasswordUnlock();
    });
  }

  // Password link - show password section when clicked
  if (sendPasswordLink) {
    sendPasswordLink.addEventListener('click', () => {
      sendPasswordLink.classList.add('hidden');
      sendPasswordSection?.classList.remove('hidden');
      sendPasswordInput?.focus();
    });
  }

  // Done button (success)
  if (sendDoneBtn) {
    sendDoneBtn.addEventListener('click', closeSend);
  }

  // Explorer link - open in new browser tab instead of popup
  if (sendExplorerLink) {
    sendExplorerLink.addEventListener('click', (e) => {
      e.preventDefault();
      const url = sendExplorerLink.href;
      if (url && url !== '#') {
        createTab(url);
      }
    });
  }

  // Retry button (error)
  if (sendRetryBtn) {
    sendRetryBtn.addEventListener('click', showSendInputView);
  }
}

/**
 * Open the send sub-screen
 */
function openSend() {
  if (!fullAddresses.wallet) {
    console.error('[WalletUI] No wallet address available');
    return;
  }

  // Reset state
  resetSendState();

  // Populate chain selector with chains that have balance
  populateSendChainSelector();

  // Hide main identity view, show send screen
  identityView?.classList.add('hidden');
  sendScreen?.classList.remove('hidden');

  // Show input view
  showSendInputView();

  // Focus recipient input
  setTimeout(() => sendRecipientInput?.focus(), 100);
}

/**
 * Close the send sub-screen
 */
function closeSend() {
  sendScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');

  // Reset state
  resetSendState();
}

/**
 * Reset send state
 */
function resetSendState() {
  sendTxState = {
    selectedToken: null,
    recipient: '',
    amount: '',
    gasLimit: null,
    maxFeePerGas: null,
    maxPriorityFeePerGas: null,
    gasPrice: null,
    estimatedFee: null,
    chainId: null,
  };

  // Reset form
  if (sendRecipientInput) sendRecipientInput.value = '';
  if (sendAmountInput) sendAmountInput.value = '';
  if (sendPasswordInput) sendPasswordInput.value = '';

  // Close dropdowns
  closeSendChainDropdown();
  closeSendAssetDropdown();

  // Reset selector displays
  if (sendChainName) sendChainName.textContent = 'Select';
  if (sendChainLogo) sendChainLogo.src = '';
  if (sendAssetName) sendAssetName.textContent = 'Select';
  if (sendAssetLogo) sendAssetLogo.src = '';

  // Clear errors
  clearSendError('recipient');
  clearSendError('amount');
  clearSendError('general');
  clearSendError('review');
  clearSendError('unlock');

  // Hide resolved address
  sendResolvedAddress?.classList.add('hidden');

  // Ensure continue button is enabled and has default text
  if (sendContinueBtn) {
    sendContinueBtn.disabled = false;
    sendContinueBtn.textContent = 'Continue';
  }
}

/**
 * Show the send input view
 */
function showSendInputView() {
  sendInputView?.classList.remove('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.add('hidden');
}

/**
 * Show the send review view
 */
function showSendReviewView() {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.remove('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.add('hidden');
}

/**
 * Show the send pending view
 */
function showSendPendingView() {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.remove('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.add('hidden');
}

/**
 * Show the send success view
 */
function showSendSuccessView(explorerUrl) {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.remove('hidden');
  sendErrorView?.classList.add('hidden');

  if (sendExplorerLink) {
    sendExplorerLink.href = explorerUrl || '#';
    sendExplorerLink.classList.toggle('hidden', !explorerUrl);
  }
}

/**
 * Show the send error view
 */
function showSendErrorView(message) {
  sendInputView?.classList.add('hidden');
  sendReviewView?.classList.add('hidden');
  sendPendingView?.classList.add('hidden');
  sendSuccessView?.classList.add('hidden');
  sendErrorView?.classList.remove('hidden');

  if (sendErrorText) {
    sendErrorText.textContent = message || 'An error occurred';
  }
}

// ============================================
// Send Chain Selector
// ============================================

/**
 * Toggle send chain dropdown
 */
function toggleSendChainDropdown() {
  if (!sendChainSelector || !sendChainDropdown) return;

  const isOpen = sendChainSelector.classList.contains('open');

  // Close asset dropdown first
  closeSendAssetDropdown();

  if (isOpen) {
    closeSendChainDropdown();
  } else {
    sendChainSelector.classList.add('open');
    sendChainDropdown.classList.remove('hidden');
    renderSendChainList();
  }
}

/**
 * Close send chain dropdown
 */
function closeSendChainDropdown() {
  if (sendChainSelector) {
    sendChainSelector.classList.remove('open');
  }
  if (sendChainDropdown) {
    sendChainDropdown.classList.add('hidden');
  }
}

/**
 * Populate send chain selector with chains that have balance
 */
function populateSendChainSelector() {
  const chainsWithBalance = getChainsWithBalance();

  if (chainsWithBalance.length > 0) {
    // Auto-select first chain
    selectSendChain(chainsWithBalance[0].chainId);
  } else {
    // No chains with balance
    if (sendChainName) sendChainName.textContent = 'No funds';
    if (sendAssetName) sendAssetName.textContent = 'No assets';
  }
}

/**
 * Render chain list in send dropdown
 */
function renderSendChainList() {
  if (!sendChainList) return;

  sendChainList.innerHTML = '';

  const chainsWithBalance = getChainsWithBalance();

  if (chainsWithBalance.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'send-selector-empty';
    emptyEl.textContent = 'No chains with balance';
    sendChainList.appendChild(emptyEl);
    return;
  }

  for (const chain of chainsWithBalance) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'send-selector-item';
    if (chain.chainId === sendTxState.chainId) {
      item.classList.add('active');
    }

    const logoHtml = chain.logo
      ? `<img class="send-selector-item-logo" src="assets/chains/${chain.logo}" alt="${chain.name}">`
      : '';

    item.innerHTML = `
      <div class="send-selector-item-info">
        ${logoHtml}
        <span class="send-selector-item-name">${escapeHtml(chain.name)}</span>
      </div>
      ${chain.chainId === sendTxState.chainId ? `
        <svg class="send-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    item.addEventListener('click', () => selectSendChain(chain.chainId));
    sendChainList.appendChild(item);
  }
}

/**
 * Select a chain for send
 */
function selectSendChain(chainId) {
  closeSendChainDropdown();

  sendTxState.chainId = chainId;

  // Update chain display
  const chain = registeredChains[chainId];
  if (chain) {
    if (sendChainName) sendChainName.textContent = chain.name;
    if (sendChainLogo && chain.logo) {
      sendChainLogo.src = `assets/chains/${chain.logo}`;
    } else if (sendChainLogo) {
      sendChainLogo.src = '';
    }
  }

  // Populate assets for this chain and auto-select first
  populateSendAssetSelector(chainId);

  updateSendContinueButton();
}

// ============================================
// Send Asset Selector
// ============================================

/**
 * Toggle send asset dropdown
 */
function toggleSendAssetDropdown() {
  if (!sendAssetSelector || !sendAssetDropdown) return;

  const isOpen = sendAssetSelector.classList.contains('open');

  // Close chain dropdown first
  closeSendChainDropdown();

  if (isOpen) {
    closeSendAssetDropdown();
  } else {
    sendAssetSelector.classList.add('open');
    sendAssetDropdown.classList.remove('hidden');
    renderSendAssetList();
  }
}

/**
 * Close send asset dropdown
 */
function closeSendAssetDropdown() {
  if (sendAssetSelector) {
    sendAssetSelector.classList.remove('open');
  }
  if (sendAssetDropdown) {
    sendAssetDropdown.classList.add('hidden');
  }
}

/**
 * Populate asset selector with tokens on selected chain that have balance
 */
function populateSendAssetSelector(chainId) {
  const tokensWithBalance = sortTokens(getTokensWithBalance(chainId));

  if (tokensWithBalance.length > 0) {
    // Auto-select first token
    selectSendAsset(tokensWithBalance[0]);
  } else {
    // No tokens with balance on this chain
    sendTxState.selectedToken = null;
    if (sendAssetName) sendAssetName.textContent = 'No assets';
    if (sendAssetLogo) sendAssetLogo.src = '';
    updateSendBalanceHint();
  }
}

/**
 * Render asset list in send dropdown
 */
function renderSendAssetList() {
  if (!sendAssetList) return;

  sendAssetList.innerHTML = '';

  const tokensWithBalance = sortTokens(getTokensWithBalance(sendTxState.chainId));

  if (tokensWithBalance.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'send-selector-empty';
    emptyEl.textContent = 'No assets with balance';
    sendAssetList.appendChild(emptyEl);
    return;
  }

  for (const token of tokensWithBalance) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'send-selector-item';
    if (sendTxState.selectedToken?.key === token.key) {
      item.classList.add('active');
    }

    const logoHtml = token.logo && token.builtin
      ? `<img class="send-selector-item-logo" src="assets/tokens/${token.logo}" alt="${token.symbol}">`
      : '';

    // Show balance next to symbol
    const balance = currentBalances[token.key];
    const balanceText = balance ? formatBalanceDisplay(balance.formatted) : '--';

    item.innerHTML = `
      <div class="send-selector-item-info">
        ${logoHtml}
        <span class="send-selector-item-name">${escapeHtml(token.symbol)}</span>
      </div>
      <span class="send-selector-item-balance">${balanceText}</span>
      ${sendTxState.selectedToken?.key === token.key ? `
        <svg class="send-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    item.addEventListener('click', () => selectSendAsset(token));
    sendAssetList.appendChild(item);
  }
}

/**
 * Select an asset for send
 */
function selectSendAsset(token) {
  closeSendAssetDropdown();

  sendTxState.selectedToken = token;

  // Update asset display
  if (sendAssetName) sendAssetName.textContent = token.symbol;
  if (sendAssetLogo && token.logo && token.builtin) {
    sendAssetLogo.src = `assets/tokens/${token.logo}`;
  } else if (sendAssetLogo) {
    sendAssetLogo.src = '';
  }

  updateSendBalanceHint();
  updateSendContinueButton();
}

/**
 * Update the balance hint for the selected token
 */
function updateSendBalanceHint() {
  if (!sendBalanceHint || !sendTxState.selectedToken) return;

  const tokenKey = sendTxState.selectedToken.key;
  const balance = currentBalances[tokenKey];

  if (balance && balance.formatted) {
    const displayBalance = formatBalanceDisplay(balance.formatted);
    sendBalanceHint.textContent = `Available: ${displayBalance} ${sendTxState.selectedToken.symbol}`;
  } else {
    sendBalanceHint.textContent = `Available: -- ${sendTxState.selectedToken.symbol}`;
  }
}

/**
 * Format balance for display (max 6 decimals)
 */
function formatBalanceDisplay(formatted) {
  const num = parseFloat(formatted);
  if (isNaN(num)) return '0';
  if (num === 0) return '0';
  if (num < 0.000001) return '<0.000001';
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 6,
  });
}

/**
 * Handle MAX button click
 * For native tokens, dynamically calculates gas cost to maximize sendable amount
 */
async function handleSendMax() {
  if (!sendAmountInput || !sendTxState.selectedToken) return;

  const tokenKey = sendTxState.selectedToken.key;
  const balance = currentBalances[tokenKey];

  if (balance && balance.formatted) {
    // For ERC-20 tokens, use full balance (gas paid in native token)
    if (sendTxState.selectedToken.address !== null) {
      sendAmountInput.value = balance.formatted;
      clearSendError('amount');
      updateSendContinueButton();
      return;
    }

    // For native tokens, estimate actual gas cost
    const chainId = sendTxState.selectedToken.chainId;
    const balanceWei = BigInt(balance.raw || '0');

    try {
      // Show loading state on MAX button
      if (sendMaxBtn) {
        sendMaxBtn.textContent = '...';
        sendMaxBtn.disabled = true;
      }

      // Fetch current gas prices
      const gasPrices = await window.wallet.getGasPrice(chainId);

      // Native transfer is always 21000 gas
      const gasLimit = 21000n;

      // Use maxFeePerGas for safety (covers potential base fee increases)
      const gasPrice = BigInt(gasPrices.maxFeePerGas || gasPrices.gasPrice || '0');

      // Calculate gas cost with 10% buffer for safety
      const gasCost = (gasLimit * gasPrice * 110n) / 100n;

      // Calculate max sendable amount
      const maxWei = balanceWei > gasCost ? balanceWei - gasCost : 0n;

      // Convert to decimal string
      const decimals = sendTxState.selectedToken.decimals || 18;
      const maxAmount = formatWeiToDecimal(maxWei, decimals);

      sendAmountInput.value = maxAmount;
    } catch (err) {
      console.error('[WalletUI] Failed to estimate gas for MAX:', err);
      // Fallback: use balance minus small fixed amount
      const fallbackMax = Math.max(0, parseFloat(balance.formatted) - 0.0001);
      sendAmountInput.value = fallbackMax.toString();
    } finally {
      // Restore MAX button
      if (sendMaxBtn) {
        sendMaxBtn.textContent = 'MAX';
        sendMaxBtn.disabled = false;
      }
    }

    clearSendError('amount');
    updateSendContinueButton();
  }
}

/**
 * Convert wei (BigInt) to decimal string for display
 */
function formatWeiToDecimal(wei, decimals = 18) {
  if (wei === 0n) return '0';

  const weiStr = wei.toString().padStart(decimals + 1, '0');
  const integerPart = weiStr.slice(0, -decimals) || '0';
  const fractionalPart = weiStr.slice(-decimals);

  // Trim trailing zeros but keep at least some precision
  const trimmed = fractionalPart.replace(/0+$/, '');

  if (trimmed === '') {
    return integerPart;
  }

  return `${integerPart}.${trimmed}`;
}

/**
 * Validate recipient address
 */
function validateRecipient() {
  const recipient = sendRecipientInput?.value?.trim() || '';

  if (!recipient) {
    showSendError('recipient', 'Recipient address is required');
    return false;
  }

  // Check if it's a valid Ethereum address
  if (!isValidEthereumAddress(recipient)) {
    // Check if it might be an ENS name (ends with .eth)
    if (recipient.endsWith('.eth')) {
      // ENS resolution not implemented yet
      showSendError('recipient', 'ENS names not supported yet. Please enter an address.');
      return false;
    }
    showSendError('recipient', 'Invalid Ethereum address');
    return false;
  }

  sendTxState.recipient = recipient;
  return true;
}

/**
 * Check if a string is a valid Ethereum address
 */
function isValidEthereumAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Validate amount
 */
function validateAmount() {
  const amount = sendAmountInput?.value?.trim() || '';

  if (!amount) {
    showSendError('amount', 'Amount is required');
    return false;
  }

  const numAmount = parseFloat(amount);
  if (isNaN(numAmount) || numAmount <= 0) {
    showSendError('amount', 'Please enter a valid amount');
    return false;
  }

  // Check if amount exceeds balance
  if (sendTxState.selectedToken) {
    const tokenKey = sendTxState.selectedToken.key;
    const balance = currentBalances[tokenKey];
    if (balance && parseFloat(balance.formatted) < numAmount) {
      showSendError('amount', 'Insufficient balance');
      return false;
    }
  }

  sendTxState.amount = amount;
  return true;
}

/**
 * Update continue button state
 * Note: Button is always enabled - validation happens on click
 */
function updateSendContinueButton() {
  // No-op: validation happens when Continue is clicked
  // Keeping function for compatibility with any remaining calls
}

/**
 * Show send error
 */
function showSendError(field, message) {
  if (field === 'recipient' && sendRecipientError) {
    sendRecipientError.textContent = message;
    sendRecipientError.classList.remove('hidden');
    sendRecipientInput?.classList.add('error');
  } else if (field === 'amount' && sendAmountError) {
    sendAmountError.textContent = message;
    sendAmountError.classList.remove('hidden');
    sendAmountInput?.classList.add('error');
  } else if (field === 'general' && sendGeneralError) {
    sendGeneralError.textContent = message;
    sendGeneralError.classList.remove('hidden');
  } else if (field === 'review' && sendReviewError) {
    sendReviewError.textContent = message;
    sendReviewError.classList.remove('hidden');
  } else if (field === 'unlock' && sendUnlockError) {
    sendUnlockError.textContent = message;
    sendUnlockError.classList.remove('hidden');
  }
}

/**
 * Clear send error
 */
function clearSendError(field) {
  if (field === 'recipient') {
    sendRecipientError?.classList.add('hidden');
    sendRecipientInput?.classList.remove('error');
  } else if (field === 'amount') {
    sendAmountError?.classList.add('hidden');
    sendAmountInput?.classList.remove('error');
  } else if (field === 'general') {
    sendGeneralError?.classList.add('hidden');
  } else if (field === 'review') {
    sendReviewError?.classList.add('hidden');
  } else if (field === 'unlock') {
    sendUnlockError?.classList.add('hidden');
  }
}

/**
 * Handle continue button click - validate and show review
 */
async function handleSendContinue() {
  // Validate inputs
  if (!validateRecipient() || !validateAmount()) {
    return;
  }

  // Disable button while loading
  if (sendContinueBtn) {
    sendContinueBtn.disabled = true;
    sendContinueBtn.textContent = 'Loading...';
  }

  try {
    // Get gas estimate
    await estimateTransactionGas();

    // Populate review screen
    populateSendReview();

    // Configure unlock UI
    await configureSendUnlockUI();

    // Show review view
    showSendReviewView();
  } catch (err) {
    console.error('[WalletUI] Failed to prepare transaction:', err);
    showSendError('general', err.message || 'Failed to estimate gas');
  } finally {
    if (sendContinueBtn) {
      sendContinueBtn.disabled = false;
      sendContinueBtn.textContent = 'Continue';
    }
  }
}

/**
 * Estimate gas for the transaction
 */
async function estimateTransactionGas() {
  const token = sendTxState.selectedToken;
  if (!token) throw new Error('No token selected');

  const from = fullAddresses.wallet;
  const to = sendTxState.recipient;
  const chainId = sendTxState.chainId;

  // Parse amount to smallest unit
  const amountResult = await window.wallet.parseAmount(sendTxState.amount, token.decimals);
  if (!amountResult.success) {
    throw new Error(amountResult.error || 'Failed to parse amount');
  }
  const amountWei = amountResult.value;

  // Build transaction params
  let estimateParams = { from, chainId };

  if (token.address === null) {
    // Native token transfer
    estimateParams.to = to;
    estimateParams.value = amountWei;
  } else {
    // ERC-20 token transfer
    const dataResult = await window.wallet.buildErc20Data(to, amountWei);
    if (!dataResult.success) {
      throw new Error(dataResult.error || 'Failed to build transfer data');
    }
    estimateParams.to = token.address;
    estimateParams.value = '0';
    estimateParams.data = dataResult.data;
  }

  // Estimate gas
  const gasResult = await window.wallet.estimateGas(estimateParams);
  if (!gasResult.success) {
    throw new Error(gasResult.error || 'Gas estimation failed');
  }
  sendTxState.gasLimit = gasResult.gasLimit;

  // Get gas prices
  const priceResult = await window.wallet.getGasPrice(chainId);
  if (!priceResult.success) {
    throw new Error(priceResult.error || 'Failed to get gas price');
  }

  if (priceResult.type === 'eip1559') {
    sendTxState.maxFeePerGas = priceResult.maxFeePerGas;
    sendTxState.maxPriorityFeePerGas = priceResult.maxPriorityFeePerGas;
    sendTxState.gasPrice = null;
  } else {
    sendTxState.gasPrice = priceResult.gasPrice;
    sendTxState.maxFeePerGas = null;
    sendTxState.maxPriorityFeePerGas = null;
  }

  // Calculate estimated fee
  const effectiveGasPrice = BigInt(priceResult.effectiveGasPrice || priceResult.gasPrice || '0');
  const gasLimit = BigInt(sendTxState.gasLimit);
  const estimatedFeeWei = effectiveGasPrice * gasLimit;
  sendTxState.estimatedFee = estimatedFeeWei.toString();
}

/**
 * Populate the review screen
 */
function populateSendReview() {
  const token = sendTxState.selectedToken;
  const chain = registeredChains[sendTxState.chainId];

  // Recipient
  if (sendReviewTo) {
    sendReviewTo.textContent = sendTxState.recipient;
  }

  // Amount
  if (sendReviewAmount) {
    sendReviewAmount.textContent = `${sendTxState.amount} ${token?.symbol || ''}`;
  }

  // Network
  if (sendReviewNetwork) {
    sendReviewNetwork.textContent = chain?.name || `Chain ${sendTxState.chainId}`;
  }

  // Fee (convert from wei to native token)
  if (sendReviewFee && sendTxState.estimatedFee) {
    const feeInNative = parseFloat(sendTxState.estimatedFee) / 1e18;
    const nativeSymbol = chain?.nativeSymbol || 'ETH';
    sendReviewFee.textContent = `~${feeInNative.toFixed(6)} ${nativeSymbol}`;
  }

  // Total (amount + fee if same token, otherwise just amount)
  if (sendReviewTotal) {
    if (token?.address === null) {
      // Native token - add fee to amount
      const amount = parseFloat(sendTxState.amount);
      const fee = parseFloat(sendTxState.estimatedFee) / 1e18;
      sendReviewTotal.textContent = `${(amount + fee).toFixed(6)} ${token?.symbol || ''}`;
    } else {
      // ERC-20 token - show amount only (fee is separate in native token)
      sendReviewTotal.textContent = `${sendTxState.amount} ${token?.symbol || ''}`;
    }
  }
}

/**
 * Configure unlock UI for send
 */
async function configureSendUnlockUI() {
  try {
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      // Already unlocked - hide unlock section, enable confirm button
      sendUnlockSection?.classList.add('hidden');
      if (sendConfirmBtn) sendConfirmBtn.disabled = false;
      return;
    }

    // Show unlock section
    sendUnlockSection?.classList.remove('hidden');
    if (sendConfirmBtn) sendConfirmBtn.disabled = true;

    // Check Touch ID availability
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    // Check if user knows password
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    const hasTouchId = canUseTouchId && touchIdEnabled;

    // Show/hide Touch ID button
    if (sendTouchIdBtn) {
      sendTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    // Show/hide password link and section based on TouchID availability
    if (hasTouchId && userKnowsPassword) {
      // Show "or enter your password" link, hide password section initially
      sendPasswordLink?.classList.remove('hidden');
      sendPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      // No TouchID, show password section directly
      sendPasswordLink?.classList.add('hidden');
      sendPasswordSection?.classList.remove('hidden');
    } else {
      // User doesn't know password, hide both
      sendPasswordLink?.classList.add('hidden');
      sendPasswordSection?.classList.add('hidden');
    }

    // Auto-trigger Touch ID if available
    if (hasTouchId) {
      setTimeout(() => handleSendTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure send unlock UI:', err);
    // Fallback - show password section
    sendTouchIdBtn?.classList.add('hidden');
    sendPasswordLink?.classList.add('hidden');
    sendPasswordSection?.classList.remove('hidden');
  }
}

/**
 * Handle Touch ID unlock for send
 */
async function handleSendTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    // Unlock the vault
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    // Hide unlock section, enable confirm button
    sendUnlockSection?.classList.add('hidden');
    if (sendConfirmBtn) sendConfirmBtn.disabled = false;
  } catch (err) {
    console.error('[WalletUI] Send Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showSendError('unlock', err.message || 'Touch ID failed');
    }
  }
}

/**
 * Handle password unlock for send
 */
async function handleSendPasswordUnlock() {
  const password = sendPasswordInput?.value;
  if (!password) {
    showSendError('unlock', 'Please enter your password');
    return;
  }

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    // Hide unlock section, enable confirm button
    sendUnlockSection?.classList.add('hidden');
    if (sendConfirmBtn) sendConfirmBtn.disabled = false;
    clearSendError('unlock');
  } catch (err) {
    console.error('[WalletUI] Send password unlock failed:', err);
    showSendError('unlock', err.message || 'Failed to unlock');
  }
}

/**
 * Handle confirm button click - send the transaction
 */
async function handleSendConfirm() {
  // Disable confirm button
  if (sendConfirmBtn) sendConfirmBtn.disabled = true;

  // Show pending view
  showSendPendingView();

  try {
    // Build and send transaction
    const token = sendTxState.selectedToken;

    // Parse amount
    const amountResult = await window.wallet.parseAmount(sendTxState.amount, token.decimals);
    if (!amountResult.success) {
      throw new Error(amountResult.error || 'Failed to parse amount');
    }

    let txParams = {
      chainId: sendTxState.chainId,
      gasLimit: sendTxState.gasLimit,
    };

    // Add gas pricing
    if (sendTxState.maxFeePerGas) {
      txParams.maxFeePerGas = sendTxState.maxFeePerGas;
      txParams.maxPriorityFeePerGas = sendTxState.maxPriorityFeePerGas;
    } else {
      txParams.gasPrice = sendTxState.gasPrice;
    }

    if (token.address === null) {
      // Native token transfer
      txParams.to = sendTxState.recipient;
      txParams.value = amountResult.value;
    } else {
      // ERC-20 token transfer
      const dataResult = await window.wallet.buildErc20Data(sendTxState.recipient, amountResult.value);
      if (!dataResult.success) {
        throw new Error(dataResult.error || 'Failed to build transfer data');
      }
      txParams.to = token.address;
      txParams.value = '0';
      txParams.data = dataResult.data;
    }

    // Send transaction
    const result = await window.wallet.sendTransaction(txParams);

    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }

    console.log('[WalletUI] Transaction sent:', result.hash);

    // Show success
    showSendSuccessView(result.explorerUrl);

    // Refresh balances after a short delay
    setTimeout(() => refreshBalances(), 3000);
  } catch (err) {
    console.error('[WalletUI] Transaction failed:', err);
    showSendErrorView(err.message || 'Transaction failed');
  }
}

// ============================================
// Create Wallet Sub-screen
// ============================================

/**
 * Setup create wallet sub-screen event handlers
 */
function setupCreateWalletSubscreen() {
  // Back button
  createWalletBackBtn?.addEventListener('click', closeCreateWallet);

  // Touch ID unlock
  createWalletTouchIdBtn?.addEventListener('click', handleCreateWalletTouchIdUnlock);

  // Password unlock
  createWalletPasswordSubmit?.addEventListener('click', handleCreateWalletPasswordUnlock);
  createWalletPasswordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCreateWalletPasswordUnlock();
  });

  // Create wallet submit
  createWalletSubmitBtn?.addEventListener('click', handleCreateWalletSubmit);
  createWalletNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCreateWalletSubmit();
  });

  // Done button
  createWalletDoneBtn?.addEventListener('click', closeCreateWallet);
}

/**
 * Open create wallet sub-screen
 */
async function openCreateWallet() {
  // Hide main identity view, show sub-screen
  identityView?.classList.add('hidden');
  createWalletScreen?.classList.remove('hidden');

  // Reset state
  resetCreateWalletState();

  // Check vault status
  const status = await window.identity.getStatus();

  if (status.isUnlocked) {
    // Already unlocked - go directly to name step
    showCreateWalletStep('name');
  } else {
    // Need to unlock first
    await configureCreateWalletUnlockUI();
    showCreateWalletStep('unlock');
  }
}

/**
 * Close create wallet sub-screen
 */
async function closeCreateWallet() {
  // Clear inputs
  resetCreateWalletState();

  // Hide sub-screen, show main identity view
  createWalletScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');

  // Refresh wallet list to show any new wallets
  await loadDerivedWallets();

  // Refresh balances if we have a wallet
  if (fullAddresses.wallet) {
    refreshBalances();
  }
}

/**
 * Reset create wallet state
 */
function resetCreateWalletState() {
  // Clear inputs
  if (createWalletPasswordInput) createWalletPasswordInput.value = '';
  if (createWalletNameInput) createWalletNameInput.value = '';

  // Clear errors
  if (createWalletUnlockError) {
    createWalletUnlockError.classList.add('hidden');
    createWalletUnlockError.textContent = '';
  }
  if (createWalletNameError) {
    createWalletNameError.classList.add('hidden');
    createWalletNameError.textContent = '';
  }

  // Reset button states
  if (createWalletSubmitBtn) {
    createWalletSubmitBtn.disabled = false;
    createWalletSubmitBtn.textContent = 'Create Wallet';
  }
}

/**
 * Show a specific step in create wallet flow
 */
function showCreateWalletStep(step) {
  createWalletUnlockView?.classList.toggle('hidden', step !== 'unlock');
  createWalletNameView?.classList.toggle('hidden', step !== 'name');
  createWalletSuccessView?.classList.toggle('hidden', step !== 'success');

  // Focus appropriate input
  if (step === 'name') {
    setTimeout(() => createWalletNameInput?.focus(), 100);
  }
}

/**
 * Configure unlock UI for create wallet
 */
async function configureCreateWalletUnlockUI() {
  try {
    // Check Touch ID availability
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    // Check if user knows password
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    // Show/hide Touch ID button
    if (createWalletTouchIdBtn) {
      createWalletTouchIdBtn.classList.toggle('hidden', !(canUseTouchId && touchIdEnabled));
    }

    // Show/hide password section
    if (createWalletPasswordSection) {
      createWalletPasswordSection.classList.toggle('hidden', !userKnowsPassword);
    }

    // Auto-trigger Touch ID if available
    if (canUseTouchId && touchIdEnabled) {
      setTimeout(() => handleCreateWalletTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure create wallet unlock UI:', err);
  }
}

/**
 * Handle Touch ID unlock for create wallet
 */
async function handleCreateWalletTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    // Move to name step
    showCreateWalletStep('name');
  } catch (err) {
    console.error('[WalletUI] Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showCreateWalletUnlockError(err.message);
    }
  }
}

/**
 * Handle password unlock for create wallet
 */
async function handleCreateWalletPasswordUnlock() {
  const password = createWalletPasswordInput?.value;
  if (!password) {
    showCreateWalletUnlockError('Please enter your password');
    return;
  }

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    // Move to name step
    showCreateWalletStep('name');
  } catch (err) {
    console.error('[WalletUI] Password unlock failed:', err);
    showCreateWalletUnlockError(err.message);
  }
}

/**
 * Show unlock error in create wallet sub-screen
 */
function showCreateWalletUnlockError(message) {
  if (createWalletUnlockError) {
    createWalletUnlockError.textContent = message;
    createWalletUnlockError.classList.remove('hidden');
  }
}

/**
 * Show name error in create wallet sub-screen
 */
function showCreateWalletNameError(message) {
  if (createWalletNameError) {
    createWalletNameError.textContent = message;
    createWalletNameError.classList.remove('hidden');
  }
}

/**
 * Handle wallet creation submission
 */
async function handleCreateWalletSubmit() {
  const name = createWalletNameInput?.value?.trim();
  if (!name) {
    showCreateWalletNameError('Please enter a wallet name');
    return;
  }

  // Show loading state
  if (createWalletSubmitBtn) {
    createWalletSubmitBtn.disabled = true;
    createWalletSubmitBtn.textContent = 'Creating...';
  }

  try {
    const result = await window.wallet.createDerivedWallet(name);
    if (!result.success) {
      throw new Error(result.error);
    }

    // Add to local list
    derivedWallets.push(result.wallet);

    // Show success with wallet details
    if (createWalletResultName) {
      createWalletResultName.textContent = result.wallet.name;
    }
    if (createWalletResultAddress) {
      createWalletResultAddress.textContent = result.wallet.address;
    }

    // Update active wallet to the new one
    activeWalletIndex = result.wallet.index;
    updateWalletSelectorDisplay(result.wallet);
    fullAddresses.wallet = result.wallet.address || '';

    showCreateWalletStep('success');
  } catch (err) {
    console.error('[WalletUI] Failed to create wallet:', err);
    showCreateWalletNameError(err.message || 'Failed to create wallet');
    if (createWalletSubmitBtn) {
      createWalletSubmitBtn.disabled = false;
      createWalletSubmitBtn.textContent = 'Create Wallet';
    }
  }
}

/**
 * Load derived wallets list
 */
async function loadDerivedWallets() {
  try {
    const [walletsResult, activeResult] = await Promise.all([
      window.wallet.getDerivedWallets(),
      window.wallet.getActiveIndex(),
    ]);

    if (walletsResult.success) {
      derivedWallets = walletsResult.wallets;
    }

    if (activeResult.success) {
      activeWalletIndex = activeResult.index;
    }

    // Update display with active wallet
    const activeWallet = derivedWallets.find(w => w.index === activeWalletIndex);
    if (activeWallet) {
      updateWalletSelectorDisplay(activeWallet);
      fullAddresses.wallet = activeWallet.address || '';
    }

    return activeWallet;
  } catch (err) {
    console.error('[WalletUI] Failed to load derived wallets:', err);
    return null;
  }
}

// ============================================
// Node Cards (Collapsible)
// ============================================

/**
 * Setup node card collapse/expand functionality
 */
function setupNodeCards() {
  // Add click listeners to all node card headers
  document.querySelectorAll('.node-card-header').forEach(header => {
    header.addEventListener('click', () => {
      const nodeName = header.dataset.node;
      toggleNodeCard(nodeName);
    });
  });

  // Upgrade node button
  const upgradeBtn = document.getElementById('swarm-upgrade-btn');
  if (upgradeBtn) {
    upgradeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleUpgradeNode();
    });
  }
}

/**
 * Handle send to node (placeholder for future implementation)
 */
function handleSendToNode(token) {
  // TODO: Implement send flow
  console.log(`[WalletUI] Send ${token} to node - not yet implemented`);
}

/**
 * Toggle a node card's expanded/collapsed state
 */
function toggleNodeCard(nodeName) {
  const card = document.getElementById(`node-card-${nodeName}`);
  const content = document.getElementById(`${nodeName}-card-content`);

  if (!card || !content) return;

  const isExpanded = card.classList.contains('expanded');

  if (isExpanded) {
    // Collapse
    card.classList.remove('expanded');
    content.classList.add('hidden');
  } else {
    // Expand
    card.classList.add('expanded');
    content.classList.remove('hidden');
  }
}

/**
 * Handle upgrade node button click
 */
function handleUpgradeNode() {
  // TODO: Implement upgrade flow
  console.log('[WalletUI] Upgrade to light node - coming soon');
  alert('Upgrade to Light Node - coming soon');
}

// ============================================
// Node Status Subscriptions
// ============================================

/**
 * Subscribe to node status updates
 */
function subscribeToNodeStatus() {
  // Clean up any existing subscriptions
  nodeStatusUnsubscribers.forEach(unsub => unsub?.());
  nodeStatusUnsubscribers = [];

  // Subscribe to Swarm/Bee status
  // API returns { status: string, error?: string }
  if (window.bee?.onStatusUpdate) {
    const unsubBee = window.bee.onStatusUpdate(({ status, error }) => {
      updateSwarmStatus(status, error);
    });
    if (unsubBee) nodeStatusUnsubscribers.push(unsubBee);
  }

  // Subscribe to IPFS status
  if (window.ipfs?.onStatusUpdate) {
    const unsubIpfs = window.ipfs.onStatusUpdate(({ status, error }) => {
      updateIpfsStatus(status, error);
    });
    if (unsubIpfs) nodeStatusUnsubscribers.push(unsubIpfs);
  }

  // Subscribe to Radicle status
  if (window.radicle?.onStatusUpdate) {
    const unsubRadicle = window.radicle.onStatusUpdate(({ status, error }) => {
      updateRadicleStatus(status, error);
    });
    if (unsubRadicle) nodeStatusUnsubscribers.push(unsubRadicle);
  }

  // Get initial status
  fetchInitialNodeStatus();
}

/**
 * Fetch initial node status
 */
async function fetchInitialNodeStatus() {
  try {
    // Swarm/Bee - returns { status: string, error?: string }
    if (window.bee?.getStatus) {
      const { status, error } = await window.bee.getStatus();
      updateSwarmStatus(status, error);
    }

    // IPFS
    if (window.ipfs?.getStatus) {
      const { status, error } = await window.ipfs.getStatus();
      updateIpfsStatus(status, error);
    }

    // Radicle
    if (window.radicle?.getStatus) {
      const { status, error } = await window.radicle.getStatus();
      updateRadicleStatus(status, error);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch initial node status:', err);
  }
}

/**
 * Update Swarm node status in the UI
 * @param {string} status - Status string: 'running', 'starting', 'stopping', 'stopped', 'error'
 * @param {string} [error] - Optional error message
 */
function updateSwarmStatus(status, error) {
  // Update status badge
  if (swarmStatusBadge) {
    let statusText = 'Stopped';
    let statusValue = 'stopped';

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting'; // Use starting style for stopping
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    swarmStatusBadge.textContent = statusText;
    swarmStatusBadge.dataset.status = statusValue;
  }

  // Fetch and update mode badge when node is running
  if (status === 'running') {
    fetchSwarmMode();
    // TODO: Fetch Swarm wallet balances and stamps when we have the API
    // For now, hide notifications since we don't have the data
    hideNotification();
  } else if (swarmModeBadge) {
    // Reset mode badge when not running
    swarmModeBadge.textContent = '--';
  }
}

/**
 * Fetch Swarm node mode from the API
 */
async function fetchSwarmMode() {
  if (!swarmModeBadge) return;

  try {
    const response = await fetch(buildBeeUrl('/status'));
    if (response.ok) {
      const data = await response.json();
      if (data.beeMode) {
        // Format mode for display (e.g., "ultra-light" -> "Ultra-light")
        const mode = data.beeMode.charAt(0).toUpperCase() + data.beeMode.slice(1);
        swarmModeBadge.textContent = mode;
      }
    }
  } catch (err) {
    console.error('[WalletUI] Failed to fetch Swarm mode:', err);
    swarmModeBadge.textContent = '--';
  }
}

/**
 * Update IPFS node status in the UI
 * @param {string} status - Status string: 'running', 'starting', 'stopping', 'stopped', 'error'
 * @param {string} [error] - Optional error message
 */
function updateIpfsStatus(status, error) {
  const badge = document.getElementById('ipfs-status-badge');
  if (badge) {
    let statusText = 'Stopped';
    let statusValue = 'stopped';

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    badge.textContent = statusText;
    badge.dataset.status = statusValue;
  }
}

/**
 * Update Radicle node status in the UI
 * @param {string} status - Status string: 'running', 'starting', 'stopping', 'stopped', 'error'
 * @param {string} [error] - Optional error message
 */
function updateRadicleStatus(status, error) {
  const badge = document.getElementById('radicle-status-badge');
  if (badge) {
    let statusText = 'Stopped';
    let statusValue = 'stopped';

    switch (status) {
      case 'running':
        statusText = 'Running';
        statusValue = 'running';
        break;
      case 'starting':
        statusText = 'Starting';
        statusValue = 'starting';
        break;
      case 'stopping':
        statusText = 'Stopping';
        statusValue = 'starting';
        break;
      case 'error':
        statusText = 'Error';
        statusValue = 'error';
        break;
      case 'stopped':
      default:
        statusText = 'Stopped';
        statusValue = 'stopped';
        break;
    }

    badge.textContent = statusText;
    badge.dataset.status = statusValue;
  }
}

/**
 * Update Swarm wallet balances (node wallet, not user wallet)
 */
function updateSwarmWalletBalances(walletInfo) {
  // xDAI balance
  if (swarmBalanceXdaiEl && walletInfo?.xdai !== undefined) {
    swarmBalanceXdaiEl.textContent = formatBalance(walletInfo.xdai);
  }

  // xBZZ balance
  if (swarmBalanceXbzzEl && walletInfo?.xbzz !== undefined) {
    swarmBalanceXbzzEl.textContent = formatBalance(walletInfo.xbzz);
  }
}

/**
 * Update Swarm stamps display
 */
function updateSwarmStamps(stamps) {
  if (swarmStampsCount) {
    const count = Array.isArray(stamps) ? stamps.length : 0;
    swarmStampsCount.textContent = count.toString();
  }

  if (swarmStampsSummary) {
    if (!stamps || (Array.isArray(stamps) && stamps.length === 0)) {
      swarmStampsSummary.innerHTML = '<span class="node-stamps-empty">No stamps available</span>';
    } else if (Array.isArray(stamps)) {
      // Show summary of stamps (total capacity, etc.)
      const totalCapacity = stamps.reduce((sum, s) => sum + (s.amount || 0), 0);
      swarmStampsSummary.innerHTML = `<span>Total capacity: ${formatBytes(totalCapacity)}</span>`;
    }
  }
}

/**
 * Format bytes to human readable
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ============================================
// Wallet Notifications
// ============================================

/**
 * Check if we need to show notifications based on Swarm node state
 */
function checkSwarmNotifications(status) {
  if (!walletNotification || !walletNotificationText || !walletNotificationAction) {
    return;
  }

  // Hide notification by default
  walletNotification.classList.add('hidden');

  // Only show notifications if node is running
  if (!status?.running) return;

  // Check for low xDAI balance (needed for gas)
  if (status.wallet?.xdai !== undefined) {
    const xdaiBalance = parseFloat(status.wallet.xdai);
    if (xdaiBalance < 0.01) {
      showNotification(
        'Swarm node needs xDAI for gas fees',
        'Send xDAI',
        () => handleSendToNode('xdai')
      );
      return;
    }
  }

  // Check for low xBZZ balance (needed for postage stamps)
  if (status.wallet?.xbzz !== undefined) {
    const xbzzBalance = parseFloat(status.wallet.xbzz);
    if (xbzzBalance < 0.1) {
      showNotification(
        'Swarm node needs xBZZ for postage stamps',
        'Send xBZZ',
        () => handleSendToNode('xbzz')
      );
      return;
    }
  }

  // Check for no stamps (only if node has funds)
  if (status.stamps !== undefined) {
    const stampCount = Array.isArray(status.stamps) ? status.stamps.length : 0;
    if (stampCount === 0 && status.wallet?.xbzz && parseFloat(status.wallet.xbzz) > 0) {
      showNotification(
        'No postage stamps available for uploads',
        'Buy Stamps',
        () => handleBuyStamps()
      );
      return;
    }
  }
}

/**
 * Show a notification in the wallet tab
 */
function showNotification(message, actionLabel, actionHandler) {
  if (!walletNotification || !walletNotificationText || !walletNotificationAction) {
    return;
  }

  walletNotificationText.textContent = message;
  walletNotificationAction.textContent = actionLabel;

  // Remove old listener and add new one
  const newActionBtn = walletNotificationAction.cloneNode(true);
  walletNotificationAction.parentNode.replaceChild(newActionBtn, walletNotificationAction);
  walletNotificationAction = newActionBtn;
  walletNotificationAction.addEventListener('click', actionHandler);

  walletNotification.classList.remove('hidden');
}

/**
 * Hide the notification
 */
function hideNotification() {
  if (walletNotification) {
    walletNotification.classList.add('hidden');
  }
}

/**
 * Handle buy stamps action
 */
function handleBuyStamps() {
  // TODO: Implement buy stamps flow
  console.log('[WalletUI] Buy stamps - coming soon');
  alert('Buy Postage Stamps - coming soon');
}

// ============================================
// dApp Connect Sub-Screen
// ============================================

// Currently selected wallet index for dApp connection
let dappConnectSelectedWalletIndex = 0;

/**
 * Setup dApp connect sub-screen event handlers
 */
function setupDappConnectScreen() {
  // Back button
  if (dappConnectBackBtn) {
    dappConnectBackBtn.addEventListener('click', () => {
      rejectDappConnect();
      closeDappConnect();
    });
  }

  // Wallet selector toggle
  if (dappConnectWalletBtn) {
    dappConnectWalletBtn.addEventListener('click', toggleDappConnectWalletDropdown);
  }

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    const selector = document.getElementById('dapp-connect-wallet-selector');
    if (selector && !selector.contains(e.target)) {
      closeDappConnectWalletDropdown();
    }
  });

  // Reject button
  if (dappConnectRejectBtn) {
    dappConnectRejectBtn.addEventListener('click', () => {
      rejectDappConnect();
      closeDappConnect();
    });
  }

  // Approve button
  if (dappConnectApproveBtn) {
    dappConnectApproveBtn.addEventListener('click', approveDappConnect);
  }

  // Connection banner disconnect button
  if (dappConnectionDisconnect) {
    dappConnectionDisconnect.addEventListener('click', disconnectCurrentDapp);
  }

  // Update connection banner when sidebar opens
  document.addEventListener('sidebar-opened', () => {
    updateConnectionBanner();
  });

  // Update connection banner when navigation completes (if sidebar is open)
  document.addEventListener('navigation-completed', () => {
    if (isSidebarVisible()) {
      updateConnectionBanner();
    }
  });
}

/**
 * Toggle wallet dropdown
 */
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

/**
 * Open wallet dropdown
 */
function openDappConnectWalletDropdown() {
  const selector = document.getElementById('dapp-connect-wallet-selector');
  if (!selector) return;

  selector.classList.add('open');
  dappConnectWalletDropdown?.classList.remove('hidden');
  renderDappConnectWalletList();
}

/**
 * Close wallet dropdown
 */
function closeDappConnectWalletDropdown() {
  const selector = document.getElementById('dapp-connect-wallet-selector');
  if (!selector) return;

  selector.classList.remove('open');
  dappConnectWalletDropdown?.classList.add('hidden');
}

/**
 * Render wallet list for dApp connect
 */
function renderDappConnectWalletList() {
  if (!dappConnectWalletList) return;

  dappConnectWalletList.innerHTML = '';

  for (const wallet of derivedWallets) {
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

/**
 * Select a wallet for dApp connection
 */
function selectDappConnectWallet(index) {
  dappConnectSelectedWalletIndex = index;
  const wallet = derivedWallets.find(w => w.index === index);

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
 * @param {string} displayUrl - The display URL from address bar (e.g., ipfs://QmXxx, vitalik.eth)
 * @param {string} permissionKey - The permission key (root of displayUrl)
 * @param {function} resolve - Promise resolve callback
 * @param {function} reject - Promise reject callback
 * @param {object} webview - The webview element
 */
export function showDappConnect(displayUrl, permissionKey, resolve, reject, webview) {
  // Store pending request with permissionKey for storage
  dappConnectPending = { permissionKey, resolve, reject, webview };

  // Set the site name from display URL
  if (dappConnectSite) {
    dappConnectSite.textContent = permissionKey || displayUrl || 'Unknown';
  }

  // Try to load favicon, hide icon if none available
  if (dappConnectIcon && dappConnectFavicon) {
    // Reset state
    dappConnectIcon.classList.remove('has-favicon', 'hidden');
    dappConnectFavicon.src = '';

    // Try to get cached favicon using the display URL
    if (displayUrl && window.electronAPI?.getCachedFavicon) {
      window.electronAPI.getCachedFavicon(displayUrl).then((favicon) => {
        if (favicon) {
          dappConnectFavicon.src = favicon;
          dappConnectIcon.classList.add('has-favicon');
          dappConnectFavicon.onerror = () => {
            dappConnectIcon.classList.add('hidden');
          };
        } else {
          // No favicon, hide the icon container
          dappConnectIcon.classList.add('hidden');
        }
      }).catch(() => {
        dappConnectIcon.classList.add('hidden');
      });
    } else {
      // No API available, hide the icon
      dappConnectIcon.classList.add('hidden');
    }
  }

  // Default to active wallet
  dappConnectSelectedWalletIndex = activeWalletIndex;
  selectDappConnectWallet(activeWalletIndex);

  // Hide main identity view and other sub-screens, show dApp connect screen
  hideAllSubscreens();
  identityView?.classList.add('hidden');
  dappConnectScreen?.classList.remove('hidden');

  // Open sidebar if needed
  openSidebarPanel();
}

/**
 * Close dApp connect screen
 */
function closeDappConnect() {
  dappConnectScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');
  dappConnectPending = null;
  closeDappConnectWalletDropdown();
}

/**
 * Approve dApp connection
 */
async function approveDappConnect() {
  if (!dappConnectPending) return;

  const { permissionKey, resolve, webview } = dappConnectPending;
  const wallet = derivedWallets.find(w => w.index === dappConnectSelectedWalletIndex);

  if (!wallet) {
    console.error('[WalletUI] No wallet selected for dApp connect');
    return;
  }

  try {
    // Grant permission using the permission key (display URL root)
    await window.dappPermissions.grantPermission(
      permissionKey,
      dappConnectSelectedWalletIndex,
      selectedChainId
    );

    // Resolve with accounts array
    const accounts = [wallet.address];
    resolve(accounts);

    // Emit accountsChanged event to the webview
    if (webview && webview.send) {
      webview.send('dapp:provider-event', {
        event: 'accountsChanged',
        data: accounts,
      });
      webview.send('dapp:provider-event', {
        event: 'connect',
        data: { chainId: '0x' + selectedChainId.toString(16) },
      });
    }

    console.log('[WalletUI] dApp connected:', permissionKey, '→', wallet.address);

    // Update connection banner immediately
    updateConnectionBanner(permissionKey);
  } catch (err) {
    console.error('[WalletUI] Failed to grant permission:', err);
  }

  closeDappConnect();
}

/**
 * Reject dApp connection
 */
function rejectDappConnect() {
  if (!dappConnectPending) return;

  const { reject } = dappConnectPending;
  reject({ code: 4001, message: 'User rejected the request' });
  console.log('[WalletUI] dApp connection rejected');
}

// Track current permission key for the connection banner
let currentBannerPermissionKey = null;

/**
 * Update the connection banner for the current tab
 * Called when tab switches or after connecting/disconnecting
 * @param {string|null} permissionKey - The permission key to check, or null to check current address bar
 */
export async function updateConnectionBanner(permissionKey = null) {
  if (!dappConnectionBanner) return;

  // If no permissionKey provided, derive from address bar
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
      // Get wallet name
      const walletsResult = await window.wallet.getDerivedWallets();
      const wallets = walletsResult.success ? walletsResult.wallets : [];
      const wallet = wallets.find(w => w.index === permission.walletIndex);
      const walletName = wallet?.name || 'Unknown Wallet';

      // Update banner content
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

/**
 * Disconnect the current dApp (revoke permission)
 */
async function disconnectCurrentDapp() {
  if (!currentBannerPermissionKey) return;

  try {
    await window.dappPermissions.revokePermission(currentBannerPermissionKey);
    console.log('[WalletUI] Disconnected dApp:', currentBannerPermissionKey);

    // Hide the banner
    dappConnectionBanner?.classList.add('hidden');
    currentBannerPermissionKey = null;

    // Notify the dApp that accounts changed (now empty) per EIP-1193
    const webview = getActiveWebview();
    if (webview) {
      emitAccountsChanged(webview, []);
      console.log('[WalletUI] Emitted accountsChanged with empty array to webview');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to disconnect:', err);
  }
}

/**
 * Extract permission key from a display URL (simplified version)
 */
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

/**
 * Hide all wallet sub-screens
 */
function hideAllSubscreens() {
  receiveScreen?.classList.add('hidden');
  walletSettingsScreen?.classList.add('hidden');
  sendScreen?.classList.add('hidden');
  createWalletScreen?.classList.add('hidden');
  exportMnemonicScreen?.classList.add('hidden');
  dappConnectScreen?.classList.add('hidden');
  dappTxScreen?.classList.add('hidden');
  dappSignScreen?.classList.add('hidden');
}

/**
 * Get the current selected chain ID (for dApp provider)
 */
export function getSelectedChainId() {
  return selectedChainId;
}

/**
 * Set the selected chain ID (called by dApp provider on wallet_switchEthereumChain)
 * Updates the UI to match the requested chain
 */
export function setSelectedChainId(chainId) {
  if (selectedChainId === chainId) return;

  selectedChainId = chainId;
  updateChainSwitcherDisplay();
  renderAssetList();
  console.log('[WalletUI] Chain switched to:', chainId);
}

/* ============================================
   dApp Transaction Approval Screen
   ============================================ */

/**
 * Setup dApp transaction approval screen
 */
function setupDappTxScreen() {
  // Back button
  if (dappTxBackBtn) {
    dappTxBackBtn.addEventListener('click', () => {
      rejectDappTx();
      closeDappTx();
    });
  }

  // Reject button
  if (dappTxRejectBtn) {
    dappTxRejectBtn.addEventListener('click', () => {
      rejectDappTx();
      closeDappTx();
    });
  }

  // Approve button
  if (dappTxApproveBtn) {
    dappTxApproveBtn.addEventListener('click', approveDappTx);
  }

  // Touch ID button
  if (dappTxTouchIdBtn) {
    dappTxTouchIdBtn.addEventListener('click', handleDappTxTouchIdUnlock);
  }

  // Password submit
  if (dappTxPasswordSubmit) {
    dappTxPasswordSubmit.addEventListener('click', handleDappTxPasswordUnlock);
  }

  // Password input enter key
  if (dappTxPasswordInput) {
    dappTxPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleDappTxPasswordUnlock();
    });
  }

  // Password link - show password section when clicked
  if (dappTxPasswordLink) {
    dappTxPasswordLink.addEventListener('click', () => {
      dappTxPasswordLink.classList.add('hidden');
      dappTxPasswordSection?.classList.remove('hidden');
      dappTxPasswordInput?.focus();
    });
  }
}

/**
 * Show dApp transaction approval screen
 */
export async function showDappTxApproval(webview, permissionKey, txParams) {
  return new Promise(async (resolve, reject) => {
    // Get permission to find wallet index
    const permission = await window.dappPermissions.getPermission(permissionKey);
    if (!permission) {
      reject({ code: 4100, message: 'Unauthorized - not connected' });
      return;
    }

    // Store pending request
    dappTxPending = { permissionKey, walletIndex: permission.walletIndex, txParams, resolve, reject, webview };

    // Set site name
    if (dappTxSite) {
      dappTxSite.textContent = permissionKey;
    }

    // Format and display transaction details
    await populateDappTxDetails(txParams, permission.chainId || selectedChainId);

    // Check vault unlock status
    await checkDappTxUnlockStatus();

    // Hide main identity view and other sub-screens, show tx screen
    hideAllSubscreens();
    identityView?.classList.add('hidden');
    dappTxScreen?.classList.remove('hidden');

    // Open sidebar if needed
    openSidebarPanel();
  });
}

/**
 * Populate transaction details in the UI
 */
async function populateDappTxDetails(txParams, chainId) {
  // Get chain info
  const chainsResult = await window.chainRegistry.getChains();
  const chains = chainsResult.success ? chainsResult.chains : {};
  const chain = chains[chainId];

  // To address (truncate)
  if (dappTxTo) {
    const to = txParams.to || '';
    dappTxTo.textContent = to ? `${to.slice(0, 10)}...${to.slice(-8)}` : 'Contract Creation';
    dappTxTo.title = to;
  }

  // Value
  if (dappTxValue) {
    const value = txParams.value ? BigInt(txParams.value) : 0n;
    const ethValue = Number(value) / 1e18;
    const symbol = chain?.nativeSymbol || 'ETH';
    dappTxValue.textContent = `${ethValue.toFixed(6)} ${symbol}`;
  }

  // Data
  if (dappTxData) {
    const data = txParams.data || '';
    if (data && data !== '0x') {
      dappTxData.textContent = `${data.slice(0, 20)}...`;
      dappTxData.title = data;
      dappTxDataRow?.classList.remove('hidden');
      // Show warning for contract interactions
      dappTxWarning?.classList.remove('hidden');
    } else {
      dappTxData.textContent = 'No data';
      dappTxDataRow?.classList.remove('hidden');
      dappTxWarning?.classList.add('hidden');
    }
  }

  // Network
  if (dappTxNetwork) {
    dappTxNetwork.textContent = chain?.name || `Chain ${chainId}`;
  }

  // Estimate gas fee
  if (dappTxFee) {
    try {
      const walletsResult = await window.wallet.getDerivedWallets();
      const wallets = walletsResult.success ? walletsResult.wallets : [];
      const wallet = wallets.find(w => w.index === dappTxPending?.walletIndex);

      if (wallet) {
        // Get gas estimate
        const gasResult = await window.wallet.estimateGas({
          from: wallet.address,
          to: txParams.to,
          value: txParams.value || '0',
          data: txParams.data,
          chainId,
        });

        // Get gas price
        const priceResult = await window.wallet.getGasPrice(chainId);

        if (gasResult.success && priceResult.success) {
          const gasLimit = BigInt(gasResult.gasLimit);
          const gasPrice = BigInt(priceResult.effectiveGasPrice);
          const fee = gasLimit * gasPrice;
          const feeEth = Number(fee) / 1e18;
          const symbol = chain?.nativeSymbol || 'ETH';
          dappTxFee.textContent = `~${feeEth.toFixed(6)} ${symbol}`;

          // Store gas params for later
          if (dappTxPending) {
            dappTxPending.gasLimit = gasResult.gasLimit;
            dappTxPending.gasPrice = priceResult;
            dappTxPending.chainId = chainId;
          }
        } else {
          dappTxFee.textContent = 'Unable to estimate';
        }
      }
    } catch (err) {
      console.error('[WalletUI] Gas estimation failed:', err);
      dappTxFee.textContent = 'Unable to estimate';
    }
  }
}

/**
 * Check vault unlock status for transaction screen
 */
async function checkDappTxUnlockStatus() {
  try {
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      dappTxUnlock?.classList.add('hidden');
      if (dappTxApproveBtn) dappTxApproveBtn.disabled = false;
      return;
    }

    // Show unlock section
    dappTxUnlock?.classList.remove('hidden');
    if (dappTxApproveBtn) dappTxApproveBtn.disabled = true;

    // Check Touch ID availability
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    // Check if user knows password
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    // Show/hide Touch ID button
    if (dappTxTouchIdBtn) {
      dappTxTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    // If TouchID available and user knows password, show link; otherwise show password section directly
    if (hasTouchId && userKnowsPassword) {
      // Show "or enter your password" link, hide password section initially
      dappTxPasswordLink?.classList.remove('hidden');
      dappTxPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      // No TouchID, show password section directly
      dappTxPasswordLink?.classList.add('hidden');
      dappTxPasswordSection?.classList.remove('hidden');
    } else {
      // User doesn't know password, hide both
      dappTxPasswordLink?.classList.add('hidden');
      dappTxPasswordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check vault status:', err);
    dappTxUnlock?.classList.remove('hidden');
    dappTxTouchIdBtn?.classList.add('hidden');
    dappTxPasswordLink?.classList.add('hidden');
    dappTxPasswordSection?.classList.remove('hidden');
  }
}

/**
 * Handle Touch ID unlock for transaction
 */
async function handleDappTxTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    // Unlock the vault with the password from Touch ID
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    dappTxUnlock?.classList.add('hidden');
    if (dappTxApproveBtn) dappTxApproveBtn.disabled = false;
    hideDappTxError();
  } catch (err) {
    console.error('[WalletUI] dApp tx Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showDappTxError(err.message || 'Touch ID failed');
    }
  }
}

/**
 * Handle password unlock for transaction
 */
async function handleDappTxPasswordUnlock() {
  const password = dappTxPasswordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    dappTxUnlock?.classList.add('hidden');
    if (dappTxApproveBtn) dappTxApproveBtn.disabled = false;
    if (dappTxPasswordInput) dappTxPasswordInput.value = '';
    hideDappTxError();
  } catch (err) {
    console.error('[WalletUI] dApp tx password unlock failed:', err);
    showDappTxError(err.message || 'Failed to unlock');
  }
}

/**
 * Approve dApp transaction
 */
async function approveDappTx() {
  if (!dappTxPending) return;

  const { walletIndex, txParams, resolve, gasLimit, gasPrice, chainId } = dappTxPending;

  try {
    // Disable button while processing
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = true;
      dappTxApproveBtn.textContent = 'Signing...';
    }

    // Build transaction params
    const tx = {
      to: txParams.to,
      value: txParams.value || '0',
      data: txParams.data,
      gasLimit: gasLimit || txParams.gas,
      chainId,
    };

    // Add gas price params
    if (gasPrice) {
      if (gasPrice.type === 'eip1559') {
        tx.maxFeePerGas = gasPrice.maxFeePerGas;
        tx.maxPriorityFeePerGas = gasPrice.maxPriorityFeePerGas;
      } else {
        tx.gasPrice = gasPrice.gasPrice;
      }
    }

    // Send transaction using the connected wallet
    const result = await window.wallet.dappSendTransaction(tx, walletIndex);

    if (!result.success) {
      throw new Error(result.error || 'Transaction failed');
    }

    console.log('[WalletUI] dApp transaction sent:', result.hash);
    resolve(result.hash);
    closeDappTx();
  } catch (err) {
    console.error('[WalletUI] dApp transaction failed:', err);
    showDappTxError(err.message || 'Transaction failed');
    if (dappTxApproveBtn) {
      dappTxApproveBtn.disabled = false;
      dappTxApproveBtn.textContent = 'Confirm';
    }
  }
}

/**
 * Reject dApp transaction
 */
function rejectDappTx() {
  if (dappTxPending?.reject) {
    dappTxPending.reject({ code: 4001, message: 'User rejected the request' });
  }
}

/**
 * Close dApp transaction screen
 */
function closeDappTx() {
  dappTxScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');
  dappTxPending = null;
  hideDappTxError();
  if (dappTxPasswordInput) dappTxPasswordInput.value = '';
  if (dappTxApproveBtn) {
    dappTxApproveBtn.disabled = false;
    dappTxApproveBtn.textContent = 'Confirm';
  }
}

/**
 * Show error on transaction screen
 */
function showDappTxError(message) {
  if (dappTxError) {
    dappTxError.textContent = message;
    dappTxError.classList.remove('hidden');
  }
}

/**
 * Hide error on transaction screen
 */
function hideDappTxError() {
  dappTxError?.classList.add('hidden');
}

/* ============================================
   dApp Message Signing Screen
   ============================================ */

/**
 * Setup dApp signing screen
 */
function setupDappSignScreen() {
  // Back button
  if (dappSignBackBtn) {
    dappSignBackBtn.addEventListener('click', () => {
      rejectDappSign();
      closeDappSign();
    });
  }

  // Reject button
  if (dappSignRejectBtn) {
    dappSignRejectBtn.addEventListener('click', () => {
      rejectDappSign();
      closeDappSign();
    });
  }

  // Approve button
  if (dappSignApproveBtn) {
    dappSignApproveBtn.addEventListener('click', approveDappSign);
  }

  // Touch ID button
  if (dappSignTouchIdBtn) {
    dappSignTouchIdBtn.addEventListener('click', handleDappSignTouchIdUnlock);
  }

  // Password submit
  if (dappSignPasswordSubmit) {
    dappSignPasswordSubmit.addEventListener('click', handleDappSignPasswordUnlock);
  }

  // Password input enter key
  if (dappSignPasswordInput) {
    dappSignPasswordInput.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') handleDappSignPasswordUnlock();
    });
  }

  // Password link - show password section when clicked
  if (dappSignPasswordLink) {
    dappSignPasswordLink.addEventListener('click', () => {
      dappSignPasswordLink.classList.add('hidden');
      dappSignPasswordSection?.classList.remove('hidden');
      dappSignPasswordInput?.focus();
    });
  }
}

/**
 * Show dApp signing screen
 */
export async function showDappSignApproval(webview, permissionKey, method, params) {
  return new Promise(async (resolve, reject) => {
    // Get permission to find wallet index
    const permission = await window.dappPermissions.getPermission(permissionKey);
    if (!permission) {
      reject({ code: 4100, message: 'Unauthorized - not connected' });
      return;
    }

    // Store pending request
    dappSignPending = { permissionKey, walletIndex: permission.walletIndex, method, params, resolve, reject, webview };

    // Set site name
    if (dappSignSite) {
      dappSignSite.textContent = permissionKey;
    }

    // Display message based on method
    if (method === 'personal_sign') {
      displayPersonalSignMessage(params);
    } else if (method === 'eth_signTypedData_v4') {
      displayTypedDataMessage(params);
    }

    // Check vault unlock status
    await checkDappSignUnlockStatus();

    // Hide main identity view and other sub-screens, show sign screen
    hideAllSubscreens();
    identityView?.classList.add('hidden');
    dappSignScreen?.classList.remove('hidden');

    // Open sidebar if needed
    openSidebarPanel();
  });
}

/**
 * Display personal_sign message
 */
function displayPersonalSignMessage(params) {
  // personal_sign: params[0] = message, params[1] = address
  const message = params[0];

  // Show message section, hide typed data section
  if (dappSignMessage) {
    dappSignMessage.parentElement?.classList.remove('hidden');
  }
  dappSignTypedDataSection?.classList.add('hidden');

  if (dappSignMessage) {
    // Try to decode hex message to UTF-8
    let displayMessage = message;
    if (message.startsWith('0x')) {
      try {
        displayMessage = hexToUtf8(message.slice(2));
      } catch {
        displayMessage = message;
      }
    }
    dappSignMessage.textContent = displayMessage;
  }
}

/**
 * Convert hex string to UTF-8 (browser-compatible)
 */
function hexToUtf8(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Display eth_signTypedData_v4 message
 */
function displayTypedDataMessage(params) {
  // signTypedData_v4: params[0] = address, params[1] = typedData (JSON string)
  const typedDataStr = params[1];

  // Hide message section, show typed data section
  if (dappSignMessage) {
    dappSignMessage.parentElement?.classList.add('hidden');
  }
  dappSignTypedDataSection?.classList.remove('hidden');

  if (dappSignTypedData) {
    try {
      const typedData = typeof typedDataStr === 'string' ? JSON.parse(typedDataStr) : typedDataStr;

      // Format for display
      const formatted = formatTypedDataForDisplay(typedData);
      dappSignTypedData.textContent = formatted;
    } catch (err) {
      dappSignTypedData.textContent = typedDataStr;
    }
  }
}

/**
 * Format typed data for readable display
 */
function formatTypedDataForDisplay(typedData) {
  const lines = [];

  // Domain info
  if (typedData.domain) {
    lines.push('Domain:');
    if (typedData.domain.name) lines.push(`  Name: ${typedData.domain.name}`);
    if (typedData.domain.version) lines.push(`  Version: ${typedData.domain.version}`);
    if (typedData.domain.chainId) lines.push(`  Chain ID: ${typedData.domain.chainId}`);
    if (typedData.domain.verifyingContract) {
      lines.push(`  Contract: ${typedData.domain.verifyingContract.slice(0, 10)}...`);
    }
    lines.push('');
  }

  // Message content
  if (typedData.message) {
    lines.push('Message:');
    for (const [key, value] of Object.entries(typedData.message)) {
      const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      const truncated = displayValue.length > 50 ? displayValue.slice(0, 50) + '...' : displayValue;
      lines.push(`  ${key}: ${truncated}`);
    }
  }

  return lines.join('\n');
}

/**
 * Check vault unlock status for signing screen
 */
async function checkDappSignUnlockStatus() {
  try {
    const status = await window.identity.getStatus();

    if (status.isUnlocked) {
      dappSignUnlock?.classList.add('hidden');
      if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
      return;
    }

    // Show unlock section
    dappSignUnlock?.classList.remove('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = true;

    // Check Touch ID availability
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();
    const hasTouchId = canUseTouchId && touchIdEnabled;

    // Check if user knows password
    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    // Show/hide Touch ID button
    if (dappSignTouchIdBtn) {
      dappSignTouchIdBtn.classList.toggle('hidden', !hasTouchId);
    }

    // If TouchID available and user knows password, show link; otherwise show password section directly
    if (hasTouchId && userKnowsPassword) {
      // Show "or enter your password" link, hide password section initially
      dappSignPasswordLink?.classList.remove('hidden');
      dappSignPasswordSection?.classList.add('hidden');
    } else if (userKnowsPassword) {
      // No TouchID, show password section directly
      dappSignPasswordLink?.classList.add('hidden');
      dappSignPasswordSection?.classList.remove('hidden');
    } else {
      // User doesn't know password, hide both
      dappSignPasswordLink?.classList.add('hidden');
      dappSignPasswordSection?.classList.add('hidden');
    }
  } catch (err) {
    console.error('[WalletUI] Failed to check vault status:', err);
    dappSignUnlock?.classList.remove('hidden');
    dappSignTouchIdBtn?.classList.add('hidden');
    dappSignPasswordLink?.classList.add('hidden');
    dappSignPasswordSection?.classList.remove('hidden');
  }
}

/**
 * Handle Touch ID unlock for signing
 */
async function handleDappSignTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID failed');
    }

    // Unlock the vault with the password from Touch ID
    const unlockResult = await window.identity.unlock(result.password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    dappSignUnlock?.classList.add('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
    hideDappSignError();
  } catch (err) {
    console.error('[WalletUI] dApp sign Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showDappSignError(err.message || 'Touch ID failed');
    }
  }
}

/**
 * Handle password unlock for signing
 */
async function handleDappSignPasswordUnlock() {
  const password = dappSignPasswordInput?.value;
  if (!password) return;

  try {
    const result = await window.identity.unlock(password);
    if (!result.success) {
      throw new Error(result.error || 'Incorrect password');
    }

    dappSignUnlock?.classList.add('hidden');
    if (dappSignApproveBtn) dappSignApproveBtn.disabled = false;
    if (dappSignPasswordInput) dappSignPasswordInput.value = '';
    hideDappSignError();
  } catch (err) {
    console.error('[WalletUI] dApp sign password unlock failed:', err);
    showDappSignError(err.message || 'Failed to unlock');
  }
}

/**
 * Approve dApp signing
 */
async function approveDappSign() {
  if (!dappSignPending) return;

  const { walletIndex, method, params, resolve } = dappSignPending;

  try {
    // Disable button while processing
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = true;
      dappSignApproveBtn.textContent = 'Signing...';
    }

    let signature;

    if (method === 'personal_sign') {
      // personal_sign: params[0] = message, params[1] = address
      const result = await window.wallet.signMessage(params[0], walletIndex);
      if (!result.success) {
        throw new Error(result.error || 'Signing failed');
      }
      signature = result.signature;
    } else if (method === 'eth_signTypedData_v4') {
      // signTypedData_v4: params[0] = address, params[1] = typedData
      const result = await window.wallet.signTypedData(params[1], walletIndex);
      if (!result.success) {
        throw new Error(result.error || 'Signing failed');
      }
      signature = result.signature;
    } else {
      throw new Error(`Unsupported signing method: ${method}`);
    }

    console.log('[WalletUI] dApp message signed');
    resolve(signature);
    closeDappSign();
  } catch (err) {
    console.error('[WalletUI] dApp signing failed:', err);
    showDappSignError(err.message || 'Signing failed');
    if (dappSignApproveBtn) {
      dappSignApproveBtn.disabled = false;
      dappSignApproveBtn.textContent = 'Sign';
    }
  }
}

/**
 * Reject dApp signing
 */
function rejectDappSign() {
  if (dappSignPending?.reject) {
    dappSignPending.reject({ code: 4001, message: 'User rejected the request' });
  }
}

/**
 * Close dApp signing screen
 */
function closeDappSign() {
  dappSignScreen?.classList.add('hidden');
  identityView?.classList.remove('hidden');
  dappSignPending = null;
  hideDappSignError();
  if (dappSignPasswordInput) dappSignPasswordInput.value = '';
  if (dappSignApproveBtn) {
    dappSignApproveBtn.disabled = false;
    dappSignApproveBtn.textContent = 'Sign';
  }
}

/**
 * Show error on signing screen
 */
function showDappSignError(message) {
  if (dappSignError) {
    dappSignError.textContent = message;
    dappSignError.classList.remove('hidden');
  }
}

/**
 * Hide error on signing screen
 */
function hideDappSignError() {
  dappSignError?.classList.add('hidden');
}

// ============================================
// RPC Providers Settings
// ============================================

/**
 * Render the RPC providers list in settings
 */
async function renderRpcProviders() {
  const container = document.getElementById('rpc-providers-list');
  if (!container) return;

  try {
    // Get all available providers and which ones are configured
    const providersResult = await window.rpcManager.getProviders();
    const configuredResult = await window.rpcManager.getConfiguredProviders();

    if (!providersResult.success) {
      container.innerHTML = '<div class="rpc-provider-error">Failed to load providers</div>';
      return;
    }

    const providers = providersResult.providers;
    const configuredIds = new Set(configuredResult.success ? configuredResult.providers : []);

    // Build the list
    let html = '';
    for (const [providerId, provider] of Object.entries(providers)) {
      const isConfigured = configuredIds.has(providerId);
      const statusClass = isConfigured ? 'configured' : '';
      const statusText = isConfigured ? 'Configured' : 'Not configured';

      html += `
        <div class="rpc-provider-item" data-provider="${providerId}">
          <div class="rpc-provider-info">
            <span class="rpc-provider-name">${provider.name}</span>
            <span class="rpc-provider-status ${statusClass}">${statusText}</span>
          </div>
          <div class="rpc-provider-actions">
            ${isConfigured
              ? `<button type="button" class="rpc-provider-btn" data-action="edit" data-provider="${providerId}">Edit</button>
                 <button type="button" class="rpc-provider-btn remove" data-action="remove" data-provider="${providerId}">Remove</button>`
              : `<button type="button" class="rpc-provider-btn" data-action="add" data-provider="${providerId}">Add Key</button>`
            }
          </div>
        </div>
      `;
    }

    container.innerHTML = html;

    // Add click handlers
    container.querySelectorAll('.rpc-provider-btn').forEach(btn => {
      btn.addEventListener('click', handleRpcProviderAction);
    });
  } catch (err) {
    console.error('[WalletUI] Failed to render RPC providers:', err);
    container.innerHTML = '<div class="rpc-provider-error">Failed to load providers</div>';
  }
}

/**
 * Handle RPC provider button actions (add/edit/remove)
 */
async function handleRpcProviderAction(event) {
  const btn = event.currentTarget;
  const action = btn.dataset.action;
  const providerId = btn.dataset.provider;

  console.log('[WalletUI] RPC provider action:', action, providerId);

  if (action === 'remove') {
    if (confirm(`Remove API key for ${providerId}?`)) {
      try {
        await window.rpcManager.removeApiKey(providerId);
        renderRpcProviders();
      } catch (err) {
        console.error('[WalletUI] Failed to remove API key:', err);
        alert(`Failed to remove API key: ${err.message}`);
      }
    }
  } else if (action === 'add' || action === 'edit') {
    openRpcApiKeyScreen(providerId, action === 'edit');
  }
}

// ============================================
// RPC API Key Subscreen
// ============================================

let currentRpcProviderId = null;

/**
 * Open the RPC API key subscreen
 */
async function openRpcApiKeyScreen(providerId, isEdit = false) {
  currentRpcProviderId = providerId;

  // Get provider info
  const providersResult = await window.rpcManager.getProviders();
  if (!providersResult.success) {
    alert('Failed to load provider info');
    return;
  }

  const provider = providersResult.providers[providerId];
  if (!provider) {
    alert('Provider not found');
    return;
  }

  // Update subscreen UI
  const titleEl = document.getElementById('rpc-apikey-title');
  const linkEl = document.getElementById('rpc-apikey-website-link');
  const inputEl = document.getElementById('rpc-apikey-input');
  const statusEl = document.getElementById('rpc-apikey-test-status');

  if (titleEl) titleEl.textContent = provider.name;
  if (linkEl) {
    linkEl.href = provider.website || '#';
    linkEl.textContent = `Get an API key from ${provider.name}`;
  }
  if (inputEl) {
    inputEl.value = '';
    inputEl.type = 'password';
  }
  if (statusEl) {
    statusEl.classList.add('hidden');
    statusEl.classList.remove('success', 'error', 'testing');
  }

  // If editing, try to show existing key (masked or actual)
  if (isEdit) {
    // We don't expose the actual key for security, just show placeholder
    if (inputEl) inputEl.placeholder = 'Enter new API key (leave blank to keep current)';
  } else {
    if (inputEl) inputEl.placeholder = 'Enter API key';
  }

  // Show subscreen
  const subscreen = document.getElementById('sidebar-rpc-apikey');
  const identityView = document.getElementById('sidebar-identity');

  if (identityView) identityView.classList.add('hidden');
  if (subscreen) subscreen.classList.remove('hidden');
}

/**
 * Close the RPC API key subscreen
 */
function closeRpcApiKeyScreen() {
  const subscreen = document.getElementById('sidebar-rpc-apikey');
  const identityView = document.getElementById('sidebar-identity');

  if (subscreen) subscreen.classList.add('hidden');
  if (identityView) identityView.classList.remove('hidden');

  currentRpcProviderId = null;
}

/**
 * Toggle API key visibility
 */
function toggleRpcApiKeyVisibility() {
  const inputEl = document.getElementById('rpc-apikey-input');
  if (inputEl) {
    inputEl.type = inputEl.type === 'password' ? 'text' : 'password';
  }
}

/**
 * Test the API key
 */
async function testRpcApiKey() {
  const inputEl = document.getElementById('rpc-apikey-input');
  const statusEl = document.getElementById('rpc-apikey-test-status');

  if (!inputEl || !statusEl || !currentRpcProviderId) return;

  const apiKey = inputEl.value.trim();
  if (!apiKey) {
    statusEl.textContent = 'Please enter an API key';
    statusEl.classList.remove('hidden', 'success', 'testing');
    statusEl.classList.add('error');
    return;
  }

  // Show testing state
  statusEl.textContent = 'Testing connection...';
  statusEl.classList.remove('hidden', 'success', 'error');
  statusEl.classList.add('testing');

  try {
    const result = await window.rpcManager.testApiKey(currentRpcProviderId, apiKey);

    if (result.success) {
      statusEl.textContent = 'Connection successful!';
      statusEl.classList.remove('testing', 'error');
      statusEl.classList.add('success');
    } else {
      statusEl.textContent = result.error || 'Connection failed';
      statusEl.classList.remove('testing', 'success');
      statusEl.classList.add('error');
    }
  } catch (err) {
    statusEl.textContent = err.message || 'Connection failed';
    statusEl.classList.remove('testing', 'success');
    statusEl.classList.add('error');
  }
}

/**
 * Save the API key
 */
async function saveRpcApiKey() {
  const inputEl = document.getElementById('rpc-apikey-input');

  if (!inputEl || !currentRpcProviderId) return;

  const apiKey = inputEl.value.trim();
  if (!apiKey) {
    alert('Please enter an API key');
    return;
  }

  try {
    const result = await window.rpcManager.setApiKey(currentRpcProviderId, apiKey);

    if (result.success) {
      closeRpcApiKeyScreen();
      renderRpcProviders();
    } else {
      alert(result.error || 'Failed to save API key');
    }
  } catch (err) {
    alert(`Failed to save API key: ${err.message}`);
  }
}

// Setup RPC API key subscreen event listeners
function setupRpcApiKeyListeners() {
  const backBtn = document.getElementById('rpc-apikey-back');
  const cancelBtn = document.getElementById('rpc-apikey-cancel');
  const saveBtn = document.getElementById('rpc-apikey-save');
  const testBtn = document.getElementById('rpc-apikey-test');
  const toggleBtn = document.getElementById('rpc-apikey-toggle');
  const websiteLink = document.getElementById('rpc-apikey-website-link');

  if (backBtn) backBtn.addEventListener('click', closeRpcApiKeyScreen);
  if (cancelBtn) cancelBtn.addEventListener('click', closeRpcApiKeyScreen);
  if (saveBtn) saveBtn.addEventListener('click', saveRpcApiKey);
  if (testBtn) testBtn.addEventListener('click', testRpcApiKey);
  if (toggleBtn) toggleBtn.addEventListener('click', toggleRpcApiKeyVisibility);

  // Open website link in a new browser tab (not popup)
  if (websiteLink) {
    websiteLink.addEventListener('click', (e) => {
      e.preventDefault();
      const url = websiteLink.href;
      if (url && url !== '#') {
        createTab(url);
      }
    });
  }
}
