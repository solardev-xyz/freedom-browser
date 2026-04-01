/**
 * Chequebook Deposit Module
 *
 * Sidebar sub-screen for depositing xBZZ from the Bee wallet into
 * the chequebook contract for bandwidth payments.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { formatRawTokenBalance } from './wallet-utils.js';
import { fetchBeeJson } from './bee-api.js';

const DEPOSIT_PRESETS = [
  { label: '0.1 xBZZ', amount: 0.1 },
  { label: '0.5 xBZZ', amount: 0.5 },
  { label: '1.0 xBZZ', amount: 1.0 },
];

let depositScreen;
let depositBackBtn;
let walletBzzEl;
let currentBzzEl;
let presetContainer;
let depositBtn;
let depositStatus;
let depositError;

let selectedAmount = null;

export function initChequebookDeposit() {
  depositScreen = document.getElementById('sidebar-chequebook-deposit');
  depositBackBtn = document.getElementById('chequebook-deposit-back');
  walletBzzEl = document.getElementById('chequebook-wallet-bzz');
  currentBzzEl = document.getElementById('chequebook-current-bzz');
  presetContainer = document.getElementById('chequebook-deposit-presets');
  depositBtn = document.getElementById('chequebook-deposit-btn');
  depositStatus = document.getElementById('chequebook-deposit-status');
  depositError = document.getElementById('chequebook-deposit-error');

  registerScreenHider(() => closeChequebookDeposit());

  depositBackBtn?.addEventListener('click', () => closeChequebookDeposit());
  depositBtn?.addEventListener('click', () => handleDeposit());

  buildPresets();
}

export function openChequebookDeposit() {
  walletState.identityView?.classList.add('hidden');
  depositScreen?.classList.remove('hidden');

  selectedAmount = null;
  if (depositBtn) depositBtn.disabled = true;
  if (depositStatus) depositStatus.classList.add('hidden');
  if (depositError) depositError.classList.add('hidden');

  presetContainer?.querySelectorAll('.stamp-preset-btn').forEach((btn) => {
    btn.classList.remove('selected');
  });

  refreshBalances();
}

export function closeChequebookDeposit() {
  depositScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

function buildPresets() {
  if (!presetContainer) return;

  presetContainer.innerHTML = '';
  DEPOSIT_PRESETS.forEach((preset) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stamp-preset-btn';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'stamp-preset-label';
    labelSpan.textContent = preset.label;
    btn.appendChild(labelSpan);

    btn.addEventListener('click', () => {
      presetContainer.querySelectorAll('.stamp-preset-btn').forEach((b) => {
        b.classList.remove('selected');
      });
      btn.classList.add('selected');
      selectedAmount = preset.amount;
      if (depositBtn) depositBtn.disabled = false;
      if (depositError) depositError.classList.add('hidden');
    });

    presetContainer.appendChild(btn);
  });
}

async function refreshBalances() {
  try {
    const [walletResult, balResult] = await Promise.all([
      fetchBeeJson('/wallet'),
      fetchBeeJson('/chequebook/balance'),
    ]);

    if (walletResult.ok && walletResult.data?.bzzBalance) {
      if (walletBzzEl) {
        walletBzzEl.textContent = `${formatRawTokenBalance(walletResult.data.bzzBalance, 16)} xBZZ`;
      }
    }

    if (balResult.ok && balResult.data) {
      if (currentBzzEl) {
        const available = balResult.data.availableBalance;
        currentBzzEl.textContent = `${formatRawTokenBalance(typeof available === 'string' ? available : String(available || '0'), 16)} xBZZ`;
      }
    }
  } catch {
    // Non-critical
  }
}

async function handleDeposit() {
  if (!selectedAmount || !window.swarmNode?.depositChequebook) return;

  if (depositBtn) depositBtn.disabled = true;
  if (depositStatus) {
    depositStatus.textContent = 'Depositing\u2026';
    depositStatus.classList.remove('hidden');
  }
  if (depositError) depositError.classList.add('hidden');

  try {
    const result = await window.swarmNode.depositChequebook(selectedAmount);

    if (!result?.success) {
      showError(result?.error || 'Deposit failed.');
      return;
    }

    if (depositStatus) {
      depositStatus.textContent = 'Deposit successful.';
    }

    // Refresh balances to show updated amounts
    setTimeout(() => refreshBalances(), 2000);
  } catch (err) {
    showError(err.message || 'Deposit failed.');
  }
}

function showError(message) {
  if (depositError) {
    depositError.textContent = message;
    depositError.classList.remove('hidden');
  }
  if (depositBtn) depositBtn.disabled = false;
  if (depositStatus) depositStatus.classList.add('hidden');
}
