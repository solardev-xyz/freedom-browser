/**
 * Create Safe (multi-owner account) subscreen.
 *
 * One configure step: pick a preset (backup 1-of-2 · resilient 2-of-3 —
 * 2-of-2 is deliberately not offered), pick that many owner accounts
 * from the existing wallet list, name it. Creation is free and instant:
 * main predicts the counterfactual address and stores the record; the
 * account can receive immediately and shows an activation card
 * (safe-status.js) until its contract is deployed.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { loadDerivedWallets, activateAddedWallet } from './wallet-selector.js';
import { refreshBalances } from './balance-display.js';
import { truncateAddress, isSafeAccount, showInlineError, hideInlineError } from './wallet-utils.js';
import { renderDeviceAccountList } from './device-account-list.js';

// DOM references
let screen;
let backBtn;
let configureStep;
let presetButtons;
let ownerHint;
let ownerList;
let nameInput;
let submitBtn;
let errorEl;
let successView;
let resultName;
let resultAddress;
let doneBtn;

// Flow state
let threshold = 1;
let ownersNeeded = 2;
let selectedOwners = [];
let accountAdded = false;

export function initCreateSafe() {
  screen = document.getElementById('sidebar-create-safe');
  backBtn = document.getElementById('create-safe-back');
  configureStep = document.getElementById('create-safe-configure-step');
  presetButtons = Array.from(document.querySelectorAll('.safe-preset'));
  ownerHint = document.getElementById('create-safe-owner-hint');
  ownerList = document.getElementById('create-safe-owner-list');
  nameInput = document.getElementById('create-safe-name-input');
  submitBtn = document.getElementById('create-safe-submit');
  errorEl = document.getElementById('create-safe-error');
  successView = document.getElementById('create-safe-success');
  resultName = document.getElementById('create-safe-result-name');
  resultAddress = document.getElementById('create-safe-result-address');
  doneBtn = document.getElementById('create-safe-done');

  registerScreenHider(() => screen?.classList.add('hidden'));

  backBtn?.addEventListener('click', closeCreateSafe);
  doneBtn?.addEventListener('click', closeCreateSafe);
  submitBtn?.addEventListener('click', handleCreate);
  presetButtons.forEach((btn) => btn.addEventListener('click', () => selectPreset(btn)));
}

export function openCreateSafe() {
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');

  resetFlowState();
  showStep('configure');
}

export async function closeCreateSafe() {
  if (!screen || screen.classList.contains('hidden')) return;

  screen.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');

  if (accountAdded) {
    await loadDerivedWallets();
    if (walletState.fullAddresses.wallet) {
      refreshBalances();
    }
  }
}

function resetFlowState() {
  selectedOwners = [];
  accountAdded = false;
  if (nameInput) nameInput.value = '';
  hideInlineError(errorEl);
  selectPreset(presetButtons[0]);
}

function showStep(step) {
  configureStep?.classList.toggle('hidden', step !== 'configure');
  successView?.classList.toggle('hidden', step !== 'success');
}

function selectPreset(button) {
  if (!button) return;
  threshold = Number(button.dataset.threshold);
  ownersNeeded = Number(button.dataset.owners);
  presetButtons.forEach((btn) => btn.classList.toggle('selected', btn === button));
  if (ownerHint) ownerHint.textContent = `Choose ${ownersNeeded} owner accounts.`;
  selectedOwners = selectedOwners.slice(0, ownersNeeded);
  renderOwnerList();
}

/** Accounts that can own a Safe: anything with an address, except Safes. */
function eligibleOwners() {
  return walletState.derivedWallets.filter(
    (wallet) => !isSafeAccount(wallet.index) && wallet.address
  );
}

function renderOwnerList() {
  const owners = eligibleOwners();
  const selectedAddresses = new Set(
    owners
      .filter((wallet) => selectedOwners.includes(wallet.index))
      .map((wallet) => wallet.address.toLowerCase())
  );

  renderDeviceAccountList(
    ownerList,
    owners.map((wallet) => ({
      address: wallet.address,
      label: wallet.name,
      subLabel: truncateAddress(wallet.address),
      index: wallet.index,
    })),
    {
      selectedAddresses,
      selectedBadge: 'Owner',
      existingAddresses: new Set(),
      onSelect: ({ index }) => toggleOwner(index),
    }
  );

  updateSubmitState();
}

function toggleOwner(index) {
  if (selectedOwners.includes(index)) {
    selectedOwners = selectedOwners.filter((owner) => owner !== index);
  } else if (selectedOwners.length < ownersNeeded) {
    selectedOwners = [...selectedOwners, index];
  }
  renderOwnerList();
}

function updateSubmitState() {
  if (submitBtn) submitBtn.disabled = selectedOwners.length !== ownersNeeded;
}

async function handleCreate() {
  if (selectedOwners.length !== ownersNeeded) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating…';
  }
  hideInlineError(errorEl);

  try {
    const result = await window.wallet.createSafe(
      nameInput?.value?.trim() || '',
      selectedOwners,
      threshold
    );
    if (!result.success) {
      throw new Error(result.error);
    }

    accountAdded = true;
    if (resultName) resultName.textContent = result.wallet.name;
    if (resultAddress) resultAddress.textContent = result.wallet.address;

    await activateAddedWallet(result.wallet);
    showStep('success');
  } catch (err) {
    console.error('[CreateSafe] Failed to create account:', err);
    showInlineError(errorEl, err.message || 'Failed to create the account');
  } finally {
    if (submitBtn) {
      submitBtn.textContent = 'Create Account';
      updateSubmitState();
    }
  }
}
