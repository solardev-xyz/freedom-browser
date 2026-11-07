/**
 * Create Wallet Module
 *
 * Create wallet subscreen with unlock.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { loadDerivedWallets, updateWalletSelectorDisplay } from './wallet-selector.js';
import { refreshBalances } from './balance-display.js';
import { presetWalletPath } from './wallet-path-presets.js';

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
let createWalletPath;
let createWalletPathScheme;
let createWalletPathIndexRow;
let createWalletPathIndex;
let createWalletPathInput;
let createWalletPathPreview;
let createWalletPathPreviewPath;
let createWalletPathPreviewAddress;
let createWalletPathError;
let createWalletPathNote;
let createWalletSuccessView;
let createWalletResultName;
let createWalletResultAddress;
let createWalletResultPath;
let createWalletDoneBtn;

// A slower preview answer must not overwrite the one for the latest input.
let latestPathPreview = 0;
// Two separate reasons the button can be off: main hasn't accepted the form's
// path, or a request is in flight. Neither may clear the other.
let walletPathAccepted = true;
let creatingWallet = false;

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
  createWalletPath = document.getElementById('create-wallet-path');
  createWalletPathScheme = document.getElementById('create-wallet-path-scheme');
  createWalletPathIndexRow = document.getElementById('create-wallet-path-index-row');
  createWalletPathIndex = document.getElementById('create-wallet-path-index');
  createWalletPathInput = document.getElementById('create-wallet-path-input');
  createWalletPathPreview = document.getElementById('create-wallet-path-preview');
  createWalletPathPreviewPath = document.getElementById('create-wallet-path-preview-path');
  createWalletPathPreviewAddress = document.getElementById('create-wallet-path-preview-address');
  createWalletPathError = document.getElementById('create-wallet-path-error');
  createWalletPathNote = document.getElementById('create-wallet-path-note');
  createWalletSuccessView = document.getElementById('create-wallet-success');
  createWalletResultName = document.getElementById('create-wallet-result-name');
  createWalletResultAddress = document.getElementById('create-wallet-result-address');
  createWalletResultPath = document.getElementById('create-wallet-result-path');
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

  createWalletPathScheme?.addEventListener('change', updateWalletPathPreview);
  createWalletPathIndex?.addEventListener('input', updateWalletPathPreview);
  createWalletPathInput?.addEventListener('input', updateWalletPathPreview);

  createWalletDoneBtn?.addEventListener('click', closeCreateWallet);
}

/**
 * The path the form asks for: null for the default next account, '' while a
 * path is being asked for but isn't complete yet.
 */
function selectedWalletPath() {
  const scheme = createWalletPathScheme?.value ?? 'next';
  if (scheme === 'next') return null;
  if (scheme === 'custom') return createWalletPathInput?.value.trim() ?? '';
  return presetWalletPath(scheme, createWalletPathIndex?.value ?? '');
}

function syncCreateWalletSubmit() {
  if (createWalletSubmitBtn) {
    createWalletSubmitBtn.disabled = creatingWallet || !walletPathAccepted;
  }
}

function showWalletPathError(message) {
  createWalletPathPreview?.classList.add('hidden');
  if (createWalletPathError) {
    createWalletPathError.textContent = message;
    createWalletPathError.classList.toggle('hidden', !message);
  }
}

async function updateWalletPathPreview() {
  const request = ++latestPathPreview;
  const scheme = createWalletPathScheme?.value ?? 'next';
  const path = selectedWalletPath();

  createWalletPathIndexRow?.classList.toggle('hidden', scheme === 'next' || scheme === 'custom');
  createWalletPathInput?.classList.toggle('hidden', scheme !== 'custom');
  createWalletPathNote?.classList.toggle('hidden', path === null);
  showWalletPathError('');

  // Nothing can be created from a path until main has checked it.
  walletPathAccepted = path === null;
  syncCreateWalletSubmit();
  if (!path) return;

  let result;
  try {
    result = await window.wallet.previewWalletAtPath(path);
  } catch (err) {
    result = { success: false, error: err.message };
  }
  if (request !== latestPathPreview) return;

  if (!result.success) {
    showWalletPathError(result.error);
  } else if (result.existingName) {
    showWalletPathError(`This account is already in your wallet list as "${result.existingName}"`);
  } else {
    if (createWalletPathPreviewPath) createWalletPathPreviewPath.textContent = result.path;
    if (createWalletPathPreviewAddress) createWalletPathPreviewAddress.textContent = result.address;
    createWalletPathPreview?.classList.remove('hidden');
    walletPathAccepted = true;
    syncCreateWalletSubmit();
  }
}

function resetWalletPathForm() {
  latestPathPreview += 1;
  walletPathAccepted = true;
  if (createWalletPath) createWalletPath.open = false;
  if (createWalletPathScheme) createWalletPathScheme.value = 'next';
  if (createWalletPathIndex) createWalletPathIndex.value = '0';
  if (createWalletPathInput) createWalletPathInput.value = '';
  createWalletPathIndexRow?.classList.add('hidden');
  createWalletPathInput?.classList.add('hidden');
  createWalletPathNote?.classList.add('hidden');
  createWalletResultPath?.classList.add('hidden');
  showWalletPathError('');
}

export async function openCreateWallet() {
  if (refuseSubscreenWhileInFlight('Create wallet screen')) return;

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

  resetWalletPathForm();
  creatingWallet = false;
  syncCreateWalletSubmit();
  if (createWalletSubmitBtn) createWalletSubmitBtn.textContent = 'Create Wallet';
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
  // Enter in the name field reaches here even while the button is disabled:
  // a request in flight, or a path main hasn't accepted.
  if (createWalletSubmitBtn?.disabled) return;

  const name = createWalletNameInput?.value?.trim();
  if (!name) {
    showCreateWalletNameError('Please enter a wallet name');
    return;
  }

  creatingWallet = true;
  syncCreateWalletSubmit();
  if (createWalletSubmitBtn) createWalletSubmitBtn.textContent = 'Creating…';

  try {
    // Only null means the default account: '' is a path that isn't finished.
    const path = selectedWalletPath();
    const result =
      path === null
        ? await window.wallet.createDerivedWallet(name)
        : await window.wallet.addWalletAtPath(name, path);
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
    if (createWalletResultPath) {
      createWalletResultPath.textContent = result.wallet.path || '';
      createWalletResultPath.classList.toggle('hidden', !result.wallet.path);
    }

    walletState.activeWalletIndex = result.wallet.index;
    updateWalletSelectorDisplay(result.wallet);
    walletState.fullAddresses.wallet = result.wallet.address || '';

    showCreateWalletStep('success');
  } catch (err) {
    console.error('[WalletUI] Failed to create wallet:', err);
    showCreateWalletNameError(err.message || 'Failed to create wallet');
    creatingWallet = false;
    syncCreateWalletSubmit();
    if (createWalletSubmitBtn) createWalletSubmitBtn.textContent = 'Create Wallet';
  }
}
