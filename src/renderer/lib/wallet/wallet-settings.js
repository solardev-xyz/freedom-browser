/**
 * Wallet Settings Module
 *
 * Settings screen, delete wallet, export private key, and the phone check
 * for a phone account its phone hasn't shown it holds (#1078).
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { selectWallet, loadDerivedWallets } from './wallet-selector.js';

// DOM references
let walletSettingsScreen;
let walletSettingsBackBtn;
let walletSettingsName;
let walletSettingsAddress;
let walletSettingsDeleteBtn;

// Phone check DOM references
let phoneCheckSection;
let phoneCheckText;
let phoneCheckBtn;
let phoneCheckError;

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

  phoneCheckSection = document.getElementById('wallet-settings-phone-check');
  phoneCheckText = document.getElementById('wallet-settings-phone-check-text');
  phoneCheckBtn = document.getElementById('wallet-settings-phone-check-btn');
  phoneCheckError = document.getElementById('wallet-settings-phone-check-error');

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

  phoneCheckBtn?.addEventListener('click', handlePhoneCheck);

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
  if (refuseSubscreenWhileInFlight('Wallet settings screen')) return;

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

  renderPhoneCheck(activeWallet);
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

  // Deleting a Safe discards its half-signed state with it — say so.
  let pendingNote = '';
  if (activeWallet.type === 'safe') {
    const pending = await window.wallet.safeState(activeWallet.index).catch(() => null);
    if (pending?.state) {
      pendingNote = '\n\nIts waiting transaction and all collected signatures will be discarded.';
    }
  }

  if (!confirm(`Delete "${activeWallet.name}"?\n\nThe wallet can be recovered from your mnemonic phrase, but any custom name will be lost.${pendingNote}`)) {
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
// Phone check (#1078)
// ============================================

/**
 * What the phone check says about a wallet: null for anything but a phone
 * account its phone hasn't shown it holds. Such an account can't own a
 * Safe until it has been checked.
 */
export function phoneCheckStatus(wallet) {
  if (wallet?.type !== 'remote' || !wallet.addressCheck || wallet.addressCheck === 'matched') {
    return null;
  }
  return wallet.addressCheck === 'mismatched'
    ? "Your phone last answered from a different account. Select this account on your phone and check it again. Until then it can't own a Safe."
    : "Your phone hasn't yet shown that it holds this account, so it can't own a Safe. Check it once on your phone.";
}

function renderPhoneCheck(wallet) {
  const status = phoneCheckStatus(wallet);
  phoneCheckSection?.classList.toggle('hidden', !status);
  if (phoneCheckText) phoneCheckText.textContent = status || '';
  if (phoneCheckBtn) {
    phoneCheckBtn.disabled = false;
    phoneCheckBtn.textContent = 'Check on Phone';
    phoneCheckBtn.classList.remove('hidden');
  }
  phoneCheckError?.classList.add('hidden');
  if (phoneCheckError) phoneCheckError.textContent = '';
}

/** Main has the phone sign a check as the account; the QR panel takes it from there. */
async function handlePhoneCheck() {
  const activeWallet = walletState.derivedWallets.find(w => w.index === walletState.activeWalletIndex);
  if (!phoneCheckStatus(activeWallet)) return;

  if (phoneCheckBtn) {
    phoneCheckBtn.disabled = true;
    phoneCheckBtn.textContent = 'Checking…';
  }
  phoneCheckError?.classList.add('hidden');

  try {
    const result = await window.remoteSigner.checkAccount(activeWallet.index);
    if (!result.success) {
      throw new Error(result.error);
    }
    activeWallet.addressCheck = result.wallet.addressCheck;
    // The wallet list's badge and the Safe screen's owners read the state.
    await loadDerivedWallets();
    if (result.wallet.addressCheck === 'matched') {
      phoneCheckSection?.classList.remove('hidden');
      if (phoneCheckText) phoneCheckText.textContent = 'Checked: your phone holds this account.';
      phoneCheckBtn?.classList.add('hidden');
    } else {
      renderPhoneCheck(activeWallet);
    }
  } catch (err) {
    console.error('[WalletUI] Phone check failed:', err);
    if (phoneCheckBtn) {
      phoneCheckBtn.disabled = false;
      phoneCheckBtn.textContent = 'Check on Phone';
    }
    if (phoneCheckError) {
      phoneCheckError.textContent = err.message || 'The phone check failed. Try again.';
      phoneCheckError.classList.remove('hidden');
    }
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
    // Main runs Touch ID, unlocks the vault and exports the key itself —
    // the stored vault password never reaches this renderer (audit O-8).
    const result = await window.quickUnlock.exportPrivateKey(walletState.activeWalletIndex);
    if (!result.success) {
      throw new Error(result.error || 'Touch ID cancelled');
    }

    showPrivateKeyResult(result);
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
  showPrivateKeyResult(
    await window.identity.exportPrivateKey(walletState.activeWalletIndex, password)
  );
}

function showPrivateKeyResult(result) {
  try {
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
