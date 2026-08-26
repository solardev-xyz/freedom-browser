/**
 * Connect Vaughan Module
 *
 * "Connect Vaughan wallet" subscreen: polls the local Vaughan EIP-1193
 * provider for unlocked accounts, lets the user pick one, and adds it to
 * Freedom's wallet list. Keys stay in Vaughan — Freedom only stores the
 * address + type=vaughan record (mirrors the Ledger external-signer path).
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { loadDerivedWallets, activateAddedWallet } from './wallet-selector.js';
import { refreshBalances } from './balance-display.js';
import { escapeHtml, truncateAddress } from './wallet-utils.js';

const DETECT_POLL_MS = 1500;

// DOM references
let screen;
let backBtn;
let detectView;
let statusText;
let accountsView;
let accountList;
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

export function initConnectVaughan() {
  screen = document.getElementById('sidebar-connect-vaughan');
  backBtn = document.getElementById('connect-vaughan-back');
  detectView = document.getElementById('connect-vaughan-detect');
  statusText = document.getElementById('connect-vaughan-status-text');
  accountsView = document.getElementById('connect-vaughan-accounts-step');
  accountList = document.getElementById('connect-vaughan-account-list');
  nameInput = document.getElementById('connect-vaughan-name-input');
  submitBtn = document.getElementById('connect-vaughan-submit');
  errorEl = document.getElementById('connect-vaughan-error');
  successView = document.getElementById('connect-vaughan-success');
  resultName = document.getElementById('connect-vaughan-result-name');
  resultAddress = document.getElementById('connect-vaughan-result-address');
  doneBtn = document.getElementById('connect-vaughan-done');

  registerScreenHider(() => {
    stopDetectLoop();
    screen?.classList.add('hidden');
  });

  backBtn?.addEventListener('click', closeConnectVaughan);
  doneBtn?.addEventListener('click', closeConnectVaughan);
  submitBtn?.addEventListener('click', handleAddAccount);
}

export async function openConnectVaughan() {
  if (refuseSubscreenWhileInFlight('Connect Vaughan screen')) return;

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');

  resetFlowState();
  showStep('detect');
  detectTick();
}

export async function closeConnectVaughan() {
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
  setStatus('Looking for Vaughan…');
}

function showStep(step) {
  detectView?.classList.toggle('hidden', step !== 'detect');
  accountsView?.classList.toggle('hidden', step !== 'accounts');
  successView?.classList.toggle('hidden', step !== 'success');
}

function stopDetectLoop() {
  if (detectTimer) {
    clearTimeout(detectTimer);
    detectTimer = null;
  }
}

async function detectTick() {
  if (!screen || screen.classList.contains('hidden')) return;

  const loaded = await loadAccounts(setStatus);
  if (loaded) {
    showStep('accounts');
  } else {
    detectTimer = setTimeout(detectTick, DETECT_POLL_MS);
  }
}

function setStatus(message) {
  if (statusText) statusText.textContent = message;
}

/**
 * Fetch accounts from the local Vaughan provider.
 *
 * @param {(message: string) => void} [onFailure]
 * @returns {Promise<boolean>}
 */
async function loadAccounts(onFailure = showError) {
  try {
    if (!window.vaughan?.getAccounts) {
      onFailure('Vaughan bridge is unavailable in this build.');
      return false;
    }
    const result = await window.vaughan.getAccounts();
    if (!result.success) {
      onFailure(result.error || 'Cannot reach Vaughan. Start and unlock the wallet.');
      return false;
    }
    const accounts = Array.isArray(result.accounts) ? result.accounts : [];
    if (accounts.length === 0) {
      onFailure('Vaughan is connected but returned no accounts. Unlock the wallet and try again.');
      return false;
    }
    discoveredAccounts = accounts.map((address) => ({ address }));
    selectedAccount = null;
    if (submitBtn) submitBtn.disabled = true;
    renderAccountList();
    return true;
  } catch (err) {
    console.error('[ConnectVaughan] Account load failed:', err);
    onFailure(err.message || 'Cannot reach Vaughan.');
    return false;
  }
}

function renderAccountList() {
  if (!accountList) return;
  accountList.innerHTML = '';

  const existingAddresses = new Set(
    walletState.derivedWallets
      .filter((wallet) => wallet.address)
      .map((wallet) => wallet.address.toLowerCase())
  );

  discoveredAccounts.forEach((account) => {
    const alreadyAdded = existingAddresses.has(account.address.toLowerCase());
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'connect-ledger-account';
    if (alreadyAdded) item.classList.add('added');
    if (selectedAccount?.address === account.address) item.classList.add('selected');
    item.disabled = alreadyAdded;

    item.innerHTML = `
      <div class="connect-ledger-account-info">
        <code class="connect-ledger-account-address">${escapeHtml(truncateAddress(account.address))}</code>
        <span class="connect-ledger-account-path">Vaughan</span>
      </div>
      ${alreadyAdded ? '<span class="connect-ledger-account-added">Added</span>' : ''}
    `;

    if (!alreadyAdded) {
      item.addEventListener('click', () => {
        selectedAccount = account;
        if (submitBtn) submitBtn.disabled = false;
        renderAccountList();
      });
    }

    accountList.appendChild(item);
  });
}

async function handleAddAccount() {
  if (!selectedAccount) return;

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Adding…';
  }
  hideError();

  try {
    const result = await window.vaughan.addAccount(
      nameInput?.value?.trim() || '',
      selectedAccount.address
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
    console.error('[ConnectVaughan] Failed to add account:', err);
    showError(err.message || 'Failed to add the Vaughan account');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Add Account';
    }
  }
}

function showError(message) {
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }
}

function hideError() {
  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }
}
