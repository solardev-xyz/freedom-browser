/**
 * Connect Phone Module
 *
 * "Connect Phone / Other Device" subscreen: hosts an openlv session,
 * shows its QR code, and asks the phone for its accounts
 * (eth_requestAccounts) so the user can pick one to add to the wallet
 * list. No vault unlock involved — the key never leaves the phone.
 *
 * The QR encodes the dual-purpose URL: openlv-native wallets (freedom
 * mobile) claim it directly; any other phone opens the bridge page,
 * which speaks openlv on one side and the phone wallet's window.ethereum
 * on the other. The session secret lives in the URL fragment and never
 * reaches the bridge server.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { loadDerivedWallets, activateAddedWallet } from './wallet-selector.js';
import { refreshBalances } from './balance-display.js';
import { showInlineError, hideInlineError, generateScannableQr } from './wallet-utils.js';
import { renderDeviceAccountList, existingWalletAddresses } from './device-account-list.js';
import { getRemoteSessionBroker, PHASE_STATUS_TEXT } from './remote-session.js';

// DOM references
let screen;
let backBtn;
let qrStep;
let qrImage;
let statusSpinner;
let statusText;
let retryBtn;
let qrErrorEl;
let accountsStep;
let accountList;
let nameInput;
let submitBtn;
let errorEl;
let successView;
let resultName;
let resultAddress;
let doneBtn;

// Flow state
let currentJobId = null;
let disposeJobEvents = null;
let discoveredAccounts = [];
let selectedAccount = null;
let accountAdded = false;

export function initConnectPhone() {
  screen = document.getElementById('sidebar-connect-phone');
  backBtn = document.getElementById('connect-phone-back');
  qrStep = document.getElementById('connect-phone-qr-step');
  qrImage = document.getElementById('connect-phone-qr-image');
  statusSpinner = document.getElementById('connect-phone-status-spinner');
  statusText = document.getElementById('connect-phone-status-text');
  retryBtn = document.getElementById('connect-phone-retry');
  qrErrorEl = document.getElementById('connect-phone-qr-error');
  accountsStep = document.getElementById('connect-phone-accounts-step');
  accountList = document.getElementById('connect-phone-account-list');
  nameInput = document.getElementById('connect-phone-name-input');
  submitBtn = document.getElementById('connect-phone-submit');
  errorEl = document.getElementById('connect-phone-error');
  successView = document.getElementById('connect-phone-success');
  resultName = document.getElementById('connect-phone-result-name');
  resultAddress = document.getElementById('connect-phone-result-address');
  doneBtn = document.getElementById('connect-phone-done');

  registerScreenHider(() => {
    abandonDiscovery();
    screen?.classList.add('hidden');
  });

  backBtn?.addEventListener('click', closeConnectPhone);
  doneBtn?.addEventListener('click', closeConnectPhone);
  retryBtn?.addEventListener('click', startDiscovery);
  submitBtn?.addEventListener('click', handleAddAccount);
}

export async function openConnectPhone() {
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');

  resetFlowState();
  showStep('qr');
  startDiscovery();
}

export async function closeConnectPhone() {
  if (!screen || screen.classList.contains('hidden')) return;

  abandonDiscovery();
  screen.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');

  if (accountAdded) {
    await loadDerivedWallets();
    if (walletState.fullAddresses.wallet) {
      refreshBalances();
    }
  }
}

function abandonDiscovery() {
  disposeJobEvents?.();
  disposeJobEvents = null;
  if (currentJobId) {
    getRemoteSessionBroker()?.cancelJob(currentJobId);
    currentJobId = null;
  }
}

function resetFlowState() {
  discoveredAccounts = [];
  selectedAccount = null;
  accountAdded = false;
  if (nameInput) nameInput.value = '';
  if (accountList) accountList.innerHTML = '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Add Account';
  }
  hideInlineError(errorEl);
}

function showStep(step) {
  qrStep?.classList.toggle('hidden', step !== 'qr');
  accountsStep?.classList.toggle('hidden', step !== 'accounts');
  successView?.classList.toggle('hidden', step !== 'success');
}

// --- Step 1: QR / discovery --------------------------------------------

function startDiscovery() {
  abandonDiscovery();
  hideInlineError(qrErrorEl);
  retryBtn?.classList.add('hidden');
  statusSpinner?.classList.remove('hidden');
  if (qrImage) qrImage.src = '';
  if (screen) delete screen.dataset.bridgeUrl; // no stale session URL between attempts
  setStatus('Preparing connection…');

  const broker = getRemoteSessionBroker();
  if (!broker) {
    failDiscovery('Wallet is still starting up. Try again in a moment.');
    return;
  }

  const { jobId, accounts } = broker.connectPhone();
  currentJobId = jobId;
  disposeJobEvents = broker.onJobEvent((event) => {
    if (event.jobId !== currentJobId) return;
    if (event.phase === 'qr') {
      // Machine-readable copy of what the QR encodes (for E2E tests).
      if (screen) screen.dataset.bridgeUrl = event.bridgeUrl;
      renderQr(event.bridgeUrl);
    } else if (PHASE_STATUS_TEXT[event.phase]) {
      setStatus(PHASE_STATUS_TEXT[event.phase]);
    }
  });

  accounts
    .then((addresses) => {
      if (jobId !== currentJobId) return; // superseded by a retry / close
      discoveredAccounts = addresses;
      selectedAccount = addresses.length === 1 ? addresses[0] : null;
      if (submitBtn) submitBtn.disabled = !selectedAccount;
      renderAccountList();
      showStep('accounts');
    })
    .catch((err) => {
      if (jobId !== currentJobId) return;
      failDiscovery(err.message || 'Connection failed');
    });
}

async function renderQr(bridgeUrl) {
  const result = await generateScannableQr(bridgeUrl);
  if (!result.success) {
    failDiscovery(result.error || 'Failed to render the QR code');
    return;
  }
  if (qrImage) {
    qrImage.src = result.dataUrl;
    setStatus('Waiting for your phone…');
  }
}

function failDiscovery(message) {
  statusSpinner?.classList.add('hidden');
  setStatus('Connection failed.');
  showInlineError(qrErrorEl, message);
  retryBtn?.classList.remove('hidden');
}

function setStatus(message) {
  if (statusText) statusText.textContent = message;
}

// --- Step 2: account selection ------------------------------------------

function renderAccountList() {
  const existingAddresses = existingWalletAddresses(walletState.derivedWallets);

  renderDeviceAccountList(accountList, discoveredAccounts.map((address) => ({ address })), {
    selectedAddress: selectedAccount,
    existingAddresses,
    onSelect: ({ address }) => {
      selectedAccount = address;
      if (submitBtn) submitBtn.disabled = false;
      renderAccountList();
    },
  });

  if (discoveredAccounts.every((address) => existingAddresses.has(address.toLowerCase()))) {
    showInlineError(errorEl, 'All accounts your phone shared are already in your wallet list.');
  }
}

async function handleAddAccount() {
  if (!selectedAccount) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
  }
  hideInlineError(errorEl);

  try {
    const result = await window.remoteSigner.addAccount(
      nameInput?.value?.trim() || '',
      selectedAccount
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
    console.error('[ConnectPhone] Failed to add account:', err);
    showInlineError(errorEl, err.message || 'Failed to add the phone account');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Account';
    }
  }
}
