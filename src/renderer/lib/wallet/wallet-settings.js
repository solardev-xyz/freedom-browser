/**
 * Wallet Settings Module
 *
 * Settings screen, delete wallet, export private key.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { selectWallet } from './wallet-selector.js';

// DOM references
let walletSettingsScreen;
let walletSettingsBackBtn;
let walletSettingsName;
let walletSettingsAddress;
let walletSettingsDeleteBtn;

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

// Callback for switching tabs (set by coordinator)
let switchTabFn = null;

export function initWalletSettings(switchTab) {
  walletSettingsScreen = document.getElementById('sidebar-wallet-settings');
  walletSettingsBackBtn = document.getElementById('wallet-settings-back');
  walletSettingsName = document.getElementById('wallet-settings-name');
  walletSettingsAddress = document.getElementById('wallet-settings-address');
  walletSettingsDeleteBtn = document.getElementById('wallet-settings-delete');

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

  switchTabFn = switchTab;

  // Register screen hider
  registerScreenHider(() => walletSettingsScreen?.classList.add('hidden'));

  setupWalletSettingsScreen();
}

function setupWalletSettingsScreen() {
  const settingsBtn = document.getElementById('wallet-settings-btn');
  if (settingsBtn) {
    settingsBtn.addEventListener('click', openWalletSettings);
  }

  if (walletSettingsBackBtn) {
    walletSettingsBackBtn.addEventListener('click', () => {
      closeWalletSettings();
      if (switchTabFn) switchTabFn('wallet');
    });
  }

  if (walletSettingsDeleteBtn) {
    walletSettingsDeleteBtn.addEventListener('click', handleWalletSettingsDelete);
  }

  const exportPkBtn = document.getElementById('wallet-settings-export-pk');
  if (exportPkBtn) {
    exportPkBtn.addEventListener('click', handleExportPrivateKeyClick);
  }

  if (exportPkTouchIdBtn) {
    exportPkTouchIdBtn.addEventListener('click', handleExportPkTouchIdUnlock);
  }

  if (exportPkPasswordSubmit) {
    exportPkPasswordSubmit.addEventListener('click', handleExportPkPasswordUnlock);
  }

  if (exportPkPasswordInput) {
    exportPkPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleExportPkPasswordUnlock();
    });
  }

  if (exportPkCopyBtn) {
    exportPkCopyBtn.addEventListener('click', handleExportPkCopy);
  }
}

function openWalletSettings() {
  const activeWallet = walletState.derivedWallets.find(w => w.index === walletState.activeWalletIndex);
  if (!activeWallet) {
    console.error('[WalletUI] No active wallet found');
    return;
  }

  walletState.identityView?.classList.add('hidden');
  walletSettingsScreen?.classList.remove('hidden');

  if (walletSettingsName) {
    walletSettingsName.textContent = activeWallet.name;
  }
  if (walletSettingsAddress) {
    walletSettingsAddress.textContent = activeWallet.address || '--';
  }

  if (walletSettingsDeleteBtn) {
    if (activeWallet.index === 0) {
      walletSettingsDeleteBtn.disabled = true;
      walletSettingsDeleteBtn.title = 'Main wallet cannot be deleted';
    } else {
      walletSettingsDeleteBtn.disabled = false;
      walletSettingsDeleteBtn.title = '';
    }
  }

  resetExportPkView();
}

export function closeWalletSettings() {
  resetExportPkView();

  walletSettingsScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

async function handleWalletSettingsDelete() {
  const activeWallet = walletState.derivedWallets.find(w => w.index === walletState.activeWalletIndex);
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

    walletState.derivedWallets = walletState.derivedWallets.filter(w => w.index !== activeWallet.index);

    await selectWallet(0);

    closeWalletSettings();
    if (switchTabFn) switchTabFn('wallet');
  } catch (err) {
    console.error('[WalletUI] Failed to delete wallet:', err);
    alert(`Failed to delete wallet: ${err.message}`);
  }
}

// ============================================
// Export Private Key
// ============================================

function resetExportPkView() {
  exportPkButtonView?.classList.remove('hidden');
  exportPkUnlockView?.classList.add('hidden');
  exportPkDisplayView?.classList.add('hidden');

  if (exportPkPasswordInput) {
    exportPkPasswordInput.value = '';
  }

  if (exportPkError) {
    exportPkError.classList.add('hidden');
    exportPkError.textContent = '';
  }

  if (exportPkValue) {
    exportPkValue.textContent = '';
  }

  if (exportPkCopyBtn) {
    exportPkCopyBtn.classList.remove('copied');
    const span = exportPkCopyBtn.querySelector('span');
    if (span) span.textContent = 'Copy';
  }
}

async function handleExportPrivateKeyClick() {
  await configureExportPkUnlockUI();
  showExportPkView('unlock');
}

async function configureExportPkUnlockUI() {
  try {
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (exportPkTouchIdBtn) {
      exportPkTouchIdBtn.classList.toggle('hidden', !(canUseTouchId && touchIdEnabled));
    }

    if (exportPkPasswordSection) {
      exportPkPasswordSection.classList.toggle('hidden', !userKnowsPassword);
    }

    if (canUseTouchId && touchIdEnabled) {
      setTimeout(() => handleExportPkTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure export PK unlock UI:', err);
  }
}

function showExportPkView(view) {
  exportPkButtonView?.classList.toggle('hidden', view !== 'button');
  exportPkUnlockView?.classList.toggle('hidden', view !== 'unlock');
  exportPkDisplayView?.classList.toggle('hidden', view !== 'display');
}

async function handleExportPkTouchIdUnlock() {
  try {
    const result = await window.quickUnlock.unlock();
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    const password = result.password;
    const unlockResult = await window.identity.unlock(password);
    if (!unlockResult.success) {
      throw new Error(unlockResult.error || 'Failed to unlock vault');
    }

    await showPrivateKey(password);
  } catch (err) {
    console.error('[WalletUI] Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showExportPkError(err.message || 'Touch ID failed');
    }
  }
}

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

    await showPrivateKey(password);
  } catch (err) {
    console.error('[WalletUI] Password unlock failed:', err);
    showExportPkError(err.message || 'Failed to unlock');
  }
}

function showExportPkError(message) {
  if (exportPkError) {
    exportPkError.textContent = message;
    exportPkError.classList.remove('hidden');
  }
}

async function showPrivateKey(password) {
  try {
    const result = await window.identity.exportPrivateKey(walletState.activeWalletIndex, password);
    if (!result.success) {
      throw new Error(result.error || 'Failed to export private key');
    }

    if (exportPkValue) {
      exportPkValue.textContent = result.privateKey;
    }

    showExportPkView('display');
  } catch (err) {
    console.error('[WalletUI] Failed to export private key:', err);
    showExportPkError(err.message || 'Failed to export');
  }
}

async function handleExportPkCopy() {
  const privateKey = exportPkValue?.textContent;
  if (!privateKey) return;

  try {
    await window.electronAPI.copyText(privateKey);

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
