/**
 * Create Wallet Module
 *
 * Create wallet subscreen with unlock.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { loadDerivedWallets, updateWalletSelectorDisplay } from './wallet-selector.js';
import { refreshBalances } from './balance-display.js';

// DOM references
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

export function initCreateWallet() {
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

  // Register screen hider
  registerScreenHider(() => createWalletScreen?.classList.add('hidden'));

  setupCreateWalletSubscreen();
}

function setupCreateWalletSubscreen() {
  createWalletBackBtn?.addEventListener('click', closeCreateWallet);

  createWalletTouchIdBtn?.addEventListener('click', handleCreateWalletTouchIdUnlock);

  createWalletPasswordSubmit?.addEventListener('click', handleCreateWalletPasswordUnlock);
  createWalletPasswordInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCreateWalletPasswordUnlock();
  });

  createWalletSubmitBtn?.addEventListener('click', handleCreateWalletSubmit);
  createWalletNameInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleCreateWalletSubmit();
  });

  createWalletDoneBtn?.addEventListener('click', closeCreateWallet);
}

export async function openCreateWallet() {
  walletState.identityView?.classList.add('hidden');
  createWalletScreen?.classList.remove('hidden');

  resetCreateWalletState();

  const status = await window.identity.getStatus();

  if (status.isUnlocked) {
    showCreateWalletStep('name');
  } else {
    await configureCreateWalletUnlockUI();
    showCreateWalletStep('unlock');
  }
}

export async function closeCreateWallet() {
  // Guard: skip network requests if screen is already hidden
  if (!createWalletScreen || createWalletScreen.classList.contains('hidden')) return;

  resetCreateWalletState();

  createWalletScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');

  await loadDerivedWallets();

  if (walletState.fullAddresses.wallet) {
    refreshBalances();
  }
}

function resetCreateWalletState() {
  if (createWalletPasswordInput) createWalletPasswordInput.value = '';
  if (createWalletNameInput) createWalletNameInput.value = '';

  if (createWalletUnlockError) {
    createWalletUnlockError.classList.add('hidden');
    createWalletUnlockError.textContent = '';
  }
  if (createWalletNameError) {
    createWalletNameError.classList.add('hidden');
    createWalletNameError.textContent = '';
  }

  if (createWalletSubmitBtn) {
    createWalletSubmitBtn.disabled = false;
    createWalletSubmitBtn.textContent = 'Create Wallet';
  }
}

function showCreateWalletStep(step) {
  createWalletUnlockView?.classList.toggle('hidden', step !== 'unlock');
  createWalletNameView?.classList.toggle('hidden', step !== 'name');
  createWalletSuccessView?.classList.toggle('hidden', step !== 'success');

  if (step === 'name') {
    setTimeout(() => createWalletNameInput?.focus(), 100);
  }
}

async function configureCreateWalletUnlockUI() {
  try {
    const canUseTouchId = await window.quickUnlock.canUseTouchId();
    const touchIdEnabled = await window.quickUnlock.isEnabled();

    const vaultMeta = await window.identity.getVaultMeta();
    const userKnowsPassword = vaultMeta?.userKnowsPassword ?? true;

    if (createWalletTouchIdBtn) {
      createWalletTouchIdBtn.classList.toggle('hidden', !(canUseTouchId && touchIdEnabled));
    }

    if (createWalletPasswordSection) {
      createWalletPasswordSection.classList.toggle('hidden', !userKnowsPassword);
    }

    if (canUseTouchId && touchIdEnabled) {
      setTimeout(() => handleCreateWalletTouchIdUnlock(), 100);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to configure create wallet unlock UI:', err);
  }
}

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

    showCreateWalletStep('name');
  } catch (err) {
    console.error('[WalletUI] Touch ID unlock failed:', err);
    if (err.message !== 'Touch ID cancelled') {
      showCreateWalletUnlockError(err.message);
    }
  }
}

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

    showCreateWalletStep('name');
  } catch (err) {
    console.error('[WalletUI] Password unlock failed:', err);
    showCreateWalletUnlockError(err.message);
  }
}

function showCreateWalletUnlockError(message) {
  if (createWalletUnlockError) {
    createWalletUnlockError.textContent = message;
    createWalletUnlockError.classList.remove('hidden');
  }
}

function showCreateWalletNameError(message) {
  if (createWalletNameError) {
    createWalletNameError.textContent = message;
    createWalletNameError.classList.remove('hidden');
  }
}

async function handleCreateWalletSubmit() {
  const name = createWalletNameInput?.value?.trim();
  if (!name) {
    showCreateWalletNameError('Please enter a wallet name');
    return;
  }

  if (createWalletSubmitBtn) {
    createWalletSubmitBtn.disabled = true;
    createWalletSubmitBtn.textContent = 'Creating...';
  }

  try {
    const result = await window.wallet.createDerivedWallet(name);
    if (!result.success) {
      throw new Error(result.error);
    }

    walletState.derivedWallets.push(result.wallet);

    if (createWalletResultName) {
      createWalletResultName.textContent = result.wallet.name;
    }
    if (createWalletResultAddress) {
      createWalletResultAddress.textContent = result.wallet.address;
    }

    walletState.activeWalletIndex = result.wallet.index;
    updateWalletSelectorDisplay(result.wallet);
    walletState.fullAddresses.wallet = result.wallet.address || '';

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
