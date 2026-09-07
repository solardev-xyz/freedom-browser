/**
 * Connect Ledger Module
 *
 * "Connect hardware wallet" subscreen: waits for a Ledger with the
 * Ethereum app open, lists device accounts per derivation scheme, and
 * adds the chosen one to the wallet list. No vault unlock involved —
 * the key never leaves the device.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { loadDerivedWallets, activateAddedWallet } from './wallet-selector.js';
import { refreshBalances } from './balance-display.js';
import { showInlineError, hideInlineError } from './wallet-utils.js';
import { renderDeviceAccountList, existingWalletAddresses } from './device-account-list.js';

const ACCOUNTS_PER_PAGE = 5;
const DETECT_POLL_MS = 1500;
const DETECT_STATUS = 'Looking for your Ledger…';

// DOM references
let screen;
let backBtn;
let detectView;
let statusEl;
let statusSpinner;
let statusText;
let accountsView;
let schemeSelect;
let accountList;
let loadMoreBtn;
let nameInput;
let submitBtn;
let errorEl;
let successView;
let resultName;
let resultAddress;
let doneBtn;

// Flow state
let detectTimer = null;
let discoveredAccounts = [];
let selectedAccount = null;
let accountAdded = false;

export function initConnectLedger() {
  screen = document.getElementById('sidebar-connect-ledger');
  backBtn = document.getElementById('connect-ledger-back');
  detectView = document.getElementById('connect-ledger-detect');
  statusEl = document.getElementById('connect-ledger-status');
  statusSpinner = document.getElementById('connect-ledger-status-spinner');
  statusText = document.getElementById('connect-ledger-status-text');
  accountsView = document.getElementById('connect-ledger-accounts-step');
  schemeSelect = document.getElementById('connect-ledger-scheme');
  accountList = document.getElementById('connect-ledger-account-list');
  loadMoreBtn = document.getElementById('connect-ledger-load-more');
  nameInput = document.getElementById('connect-ledger-name-input');
  submitBtn = document.getElementById('connect-ledger-submit');
  errorEl = document.getElementById('connect-ledger-error');
  successView = document.getElementById('connect-ledger-success');
  resultName = document.getElementById('connect-ledger-result-name');
  resultAddress = document.getElementById('connect-ledger-result-address');
  doneBtn = document.getElementById('connect-ledger-done');

  registerScreenHider(() => {
    stopDetectLoop();
    screen?.classList.add('hidden');
  });

  backBtn?.addEventListener('click', closeConnectLedger);
  doneBtn?.addEventListener('click', closeConnectLedger);
  schemeSelect?.addEventListener('change', () => reloadAccounts());
  loadMoreBtn?.addEventListener('click', () => loadAccountsPage(false));
  submitBtn?.addEventListener('click', handleAddAccount);
}

export async function openConnectLedger() {
  if (refuseSubscreenWhileInFlight('Connect Ledger screen')) return;

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');

  resetFlowState();
  showStep('detect');
  detectTick();
}

export async function closeConnectLedger() {
  if (!screen || screen.classList.contains('hidden')) return;

  stopDetectLoop();
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
  discoveredAccounts = [];
  selectedAccount = null;
  accountAdded = false;
  if (nameInput) nameInput.value = '';
  if (accountList) accountList.innerHTML = '';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Add Account';
  }
  hideError();
  setStatus(DETECT_STATUS);
}

function showStep(step) {
  detectView?.classList.toggle('hidden', step !== 'detect');
  accountsView?.classList.toggle('hidden', step !== 'accounts');
  successView?.classList.toggle('hidden', step !== 'success');
}

// --- Step 1: detection loop -------------------------------------------

function stopDetectLoop() {
  if (detectTimer) {
    clearTimeout(detectTimer);
    detectTimer = null;
  }
}

async function detectTick() {
  // The screen may have been closed while an IPC call was in flight.
  if (!screen || screen.classList.contains('hidden')) return;

  const loaded = await loadAccountsPage(true, setStatusError);
  if (loaded) {
    showStep('accounts');
  } else {
    detectTimer = setTimeout(detectTick, DETECT_POLL_MS);
  }
}

/**
 * Render the detect-step status line.
 *
 * The spinner is this screen's only claim that detection is still under way,
 * so an error status has to take it down: "Ledger error. Reconnect the device
 * and try again." next to a live spinner reads as failed and still working at
 * the same time (#241). Same treatment connect-phone's failDiscovery() gives
 * its (shared-class) spinner.
 *
 * The poll loop keeps running underneath, so the retry affordance is the
 * screen itself: the next tick that finds the device moves on to the account
 * list without the user touching anything.
 */
function setStatus(message, { error = false } = {}) {
  if (statusText) statusText.textContent = message;
  statusSpinner?.classList.toggle('hidden', error);
  statusEl?.classList.toggle('connect-ledger-status-failed', error);
}

const setStatusError = (message) => setStatus(message, { error: true });

// --- Step 2: account selection ----------------------------------------

async function reloadAccounts() {
  discoveredAccounts = [];
  selectedAccount = null;
  if (submitBtn) submitBtn.disabled = true;
  if (accountList) accountList.innerHTML = '<div class="connect-ledger-loading">Reading accounts…</div>';
  hideError();

  const loaded = await loadAccountsPage(true, showError);
  if (!loaded) {
    // The device may have been unplugged mid-flow — fall back to detection.
    // Re-arm the waiting status so the step does not reopen on a stale error
    // line (and with its spinner still hidden) from an earlier attempt.
    setStatus(DETECT_STATUS);
    showStep('detect');
    detectTick();
  }
}

/**
 * Fetch one page of device accounts.
 *
 * @param {boolean} replace - true replaces the list (first page), false appends
 * @param {(message: string) => void} [onFailure] - where a failure message goes
 *   (detect step: status line; accounts step: error box)
 * @returns {Promise<boolean>} whether the page loaded
 */
async function loadAccountsPage(replace, onFailure = showError) {
  if (loadMoreBtn) loadMoreBtn.disabled = true;
  try {
    const result = await window.ledger.getAccounts({
      scheme: schemeSelect?.value || 'live',
      start: replace ? 0 : discoveredAccounts.length,
      count: ACCOUNTS_PER_PAGE,
    });
    if (!result.success) {
      onFailure(result.error || 'Failed to read accounts from the device');
      return false;
    }
    discoveredAccounts = replace ? result.accounts : [...discoveredAccounts, ...result.accounts];
    renderAccountList();
    return true;
  } catch (err) {
    console.error('[ConnectLedger] Account load failed:', err);
    onFailure(err.message);
    return false;
  } finally {
    if (loadMoreBtn) loadMoreBtn.disabled = false;
  }
}

function renderAccountList() {
  renderDeviceAccountList(
    accountList,
    discoveredAccounts.map((account) => ({ ...account, subLabel: `m/${account.path}` })),
    {
      selectedAddress: selectedAccount?.address || null,
      existingAddresses: existingWalletAddresses(walletState.derivedWallets),
      onSelect: (account) => {
        selectedAccount = account;
        if (submitBtn) submitBtn.disabled = false;
        renderAccountList();
      },
    }
  );
}

async function handleAddAccount() {
  if (!selectedAccount) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
  }
  hideError();

  try {
    const result = await window.ledger.addAccount(
      nameInput?.value?.trim() || '',
      selectedAccount.address,
      selectedAccount.path
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
    console.error('[ConnectLedger] Failed to add account:', err);
    showError(err.message || 'Failed to add the Ledger account');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Account';
    }
  }
}

const showError = (message) => showInlineError(errorEl, message);
const hideError = () => hideInlineError(errorEl);
