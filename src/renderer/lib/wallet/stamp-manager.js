/**
 * Stamp Manager Module
 *
 * Sidebar sub-screen for purchasing and managing Swarm postage batches.
 * Shows existing batches when available, or the purchase form when empty.
 * Purchase state machine: idle → estimating → ready_to_buy →
 * purchasing → waiting_for_usable → usable.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { formatRawTokenBalance, formatBytes } from './wallet-utils.js';
import { fetchBeeJson } from './bee-api.js';

const PRESETS = [
  { label: 'Try it out', sizeGB: 1, durationDays: 7, description: '1 GB for 7 days' },
  { label: 'Small project', sizeGB: 1, durationDays: 30, description: '1 GB for 30 days' },
  { label: 'Standard', sizeGB: 5, durationDays: 30, description: '5 GB for 30 days' },
];
const DEFAULT_PRESET_INDEX = 1;
const USABLE_POLL_MS = 5000;
const USABLE_TIMEOUT_MS = 120000;

const STATE = {
  IDLE: 'idle',
  ESTIMATING: 'estimating',
  READY_TO_BUY: 'ready_to_buy',
  PURCHASING: 'purchasing',
  WAITING_FOR_USABLE: 'waiting_for_usable',
  USABLE: 'usable',
  FAILED: 'failed',
};

// DOM references
let stampManagerScreen;
let stampManagerBackBtn;
let listView;
let batchListContainer;
let buyAnotherBtn;
let purchaseView;
let presetContainer;
let costDisplay;
let costValue;
let costSpinner;
let balanceDisplay;
let purchaseBtn;
let purchaseStatus;
let purchaseError;
let retryBtn;

let currentState = STATE.IDLE;
let selectedPreset = null;
let usablePollTimeout = null;
let pendingBatchId = null;
let usablePollStart = 0;
let isOpen = false;
let estimationId = 0;

export function initStampManager() {
  stampManagerScreen = document.getElementById('sidebar-stamp-manager');
  stampManagerBackBtn = document.getElementById('stamp-manager-back');
  listView = document.getElementById('stamp-list-view');
  batchListContainer = document.getElementById('stamp-batch-list');
  buyAnotherBtn = document.getElementById('stamp-buy-another-btn');
  purchaseView = document.getElementById('stamp-purchase-view');
  presetContainer = document.getElementById('stamp-presets');
  costDisplay = document.getElementById('stamp-cost-display');
  costValue = document.getElementById('stamp-cost-value');
  costSpinner = document.getElementById('stamp-cost-spinner');
  balanceDisplay = document.getElementById('stamp-balance');
  purchaseBtn = document.getElementById('stamp-purchase-btn');
  purchaseStatus = document.getElementById('stamp-purchase-status');
  purchaseError = document.getElementById('stamp-purchase-error');
  retryBtn = document.getElementById('stamp-retry-btn');

  registerScreenHider(() => closeStampManager());

  stampManagerBackBtn?.addEventListener('click', () => closeStampManager());
  purchaseBtn?.addEventListener('click', () => handlePurchase());
  retryBtn?.addEventListener('click', () => transitionTo(STATE.IDLE));
  buyAnotherBtn?.addEventListener('click', () => showPurchaseView());

  buildPresetButtons();
}

export function openStampManager() {
  walletState.identityView?.classList.add('hidden');
  stampManagerScreen?.classList.remove('hidden');
  isOpen = true;
  pendingBatchId = null;

  loadBatchList();
}

export function closeStampManager() {
  isOpen = false;
  stopUsablePoll();
  stampManagerScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

// ============================================
// View switching
// ============================================

function showListView() {
  listView?.classList.remove('hidden');
  purchaseView?.classList.add('hidden');
}

function showPurchaseView() {
  listView?.classList.add('hidden');
  purchaseView?.classList.remove('hidden');

  transitionTo(STATE.IDLE);
  selectPreset(DEFAULT_PRESET_INDEX);
  refreshBalance();
}

async function loadBatchList() {
  try {
    const result = await window.swarmNode?.getStamps();
    if (!isOpen) return;

    if (result?.success && result.stamps.length > 0) {
      renderBatchList(result.stamps);
      showListView();
    } else {
      showPurchaseView();
    }
  } catch {
    showPurchaseView();
  }
}

// ============================================
// Batch list rendering
// ============================================

function renderBatchList(stamps) {
  if (!batchListContainer) return;

  batchListContainer.innerHTML = '';

  stamps.forEach((batch) => {
    const card = document.createElement('div');
    card.className = 'stamp-batch-card';
    if (!batch.usable) card.classList.add('unusable');

    // Status badge
    const statusBadge = document.createElement('div');
    statusBadge.className = 'stamp-batch-status';
    statusBadge.dataset.status = batch.usable ? 'usable' : 'unusable';
    statusBadge.textContent = batch.usable ? 'Usable' : 'Not usable';
    card.appendChild(statusBadge);

    // Size info
    const sizeRow = document.createElement('div');
    sizeRow.className = 'stamp-batch-row';
    const sizeLabel = document.createElement('span');
    sizeLabel.className = 'stamp-batch-label';
    sizeLabel.textContent = 'Size';
    const sizeValue = document.createElement('span');
    sizeValue.className = 'stamp-batch-value';
    sizeValue.textContent = batch.sizeBytes > 0 ? formatBytes(batch.sizeBytes) : '--';
    sizeRow.appendChild(sizeLabel);
    sizeRow.appendChild(sizeValue);
    card.appendChild(sizeRow);

    // Usage
    const usageRow = document.createElement('div');
    usageRow.className = 'stamp-batch-row';
    const usageLabel = document.createElement('span');
    usageLabel.className = 'stamp-batch-label';
    usageLabel.textContent = 'Used';
    const usageValue = document.createElement('span');
    usageValue.className = 'stamp-batch-value';
    usageValue.textContent = `${batch.usagePercent}%`;
    usageRow.appendChild(usageLabel);
    usageRow.appendChild(usageValue);
    card.appendChild(usageRow);

    // TTL
    const ttlRow = document.createElement('div');
    ttlRow.className = 'stamp-batch-row';
    const ttlLabel = document.createElement('span');
    ttlLabel.className = 'stamp-batch-label';
    ttlLabel.textContent = 'Time remaining';
    const ttlValue = document.createElement('span');
    ttlValue.className = 'stamp-batch-value';
    ttlValue.textContent = formatDuration(batch.ttlSeconds);
    ttlRow.appendChild(ttlLabel);
    ttlRow.appendChild(ttlValue);
    card.appendChild(ttlRow);

    // Batch ID
    const idRow = document.createElement('div');
    idRow.className = 'stamp-batch-id';
    idRow.textContent = batch.batchId
      ? `${batch.batchId.slice(0, 8)}\u2026${batch.batchId.slice(-8)}`
      : '--';
    idRow.title = batch.batchId || '';
    card.appendChild(idRow);

    batchListContainer.appendChild(card);
  });
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '--';
  const days = Math.floor(seconds / 86400);
  if (days > 0) return `${days} day${days === 1 ? '' : 's'}`;
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const mins = Math.floor(seconds / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

// ============================================
// Purchase form
// ============================================

function buildPresetButtons() {
  if (!presetContainer) return;

  presetContainer.innerHTML = '';
  PRESETS.forEach((preset, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stamp-preset-btn';
    btn.dataset.index = index;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'stamp-preset-label';
    labelSpan.textContent = preset.label;

    const descSpan = document.createElement('span');
    descSpan.className = 'stamp-preset-desc';
    descSpan.textContent = preset.description;

    btn.appendChild(labelSpan);
    btn.appendChild(descSpan);
    btn.addEventListener('click', () => selectPreset(index));
    presetContainer.appendChild(btn);
  });
}

function selectPreset(index) {
  selectedPreset = PRESETS[index];
  if (!selectedPreset) return;

  presetContainer?.querySelectorAll('.stamp-preset-btn').forEach((btn, i) => {
    btn.classList.toggle('selected', i === index);
  });

  transitionTo(STATE.ESTIMATING);
  estimateCost();
}

async function estimateCost() {
  if (!selectedPreset || !window.swarmNode?.getStorageCost) {
    transitionTo(STATE.FAILED, 'Swarm node API not available.');
    return;
  }

  const thisEstimation = ++estimationId;

  try {
    const result = await window.swarmNode.getStorageCost(
      selectedPreset.sizeGB,
      selectedPreset.durationDays
    );

    if (thisEstimation !== estimationId || !isOpen) return;

    if (!result?.success) {
      transitionTo(STATE.FAILED, result?.error || 'Failed to estimate cost.');
      return;
    }

    if (costValue) {
      costValue.textContent = `${result.bzz} xBZZ`;
    }

    transitionTo(STATE.READY_TO_BUY);
  } catch (err) {
    if (thisEstimation !== estimationId || !isOpen) return;
    transitionTo(STATE.FAILED, err.message || 'Failed to estimate cost.');
  }
}

async function refreshBalance() {
  if (!balanceDisplay) return;

  try {
    const walletResult = await fetchBeeJson('/wallet');
    if (walletResult.ok && walletResult.data?.bzzBalance) {
      balanceDisplay.textContent = `Balance: ${formatRawTokenBalance(walletResult.data.bzzBalance, 16)} xBZZ`;
    } else {
      balanceDisplay.textContent = 'Balance: --';
    }
  } catch {
    balanceDisplay.textContent = 'Balance: --';
  }
}

async function handlePurchase() {
  if (!selectedPreset || currentState !== STATE.READY_TO_BUY) return;

  transitionTo(STATE.PURCHASING);

  try {
    const result = await window.swarmNode.buyStorage(
      selectedPreset.sizeGB,
      selectedPreset.durationDays
    );

    if (!isOpen) return;

    if (!result?.success) {
      transitionTo(STATE.FAILED, result?.error || 'Purchase failed.');
      return;
    }

    pendingBatchId = result.batchId;
    transitionTo(STATE.WAITING_FOR_USABLE);
    startUsablePoll();
  } catch (err) {
    if (!isOpen) return;
    transitionTo(STATE.FAILED, err.message || 'Purchase failed.');
  }
}

// ============================================
// Usability polling
// ============================================

function startUsablePoll() {
  stopUsablePoll();
  usablePollStart = Date.now();
  pollForUsable();
}

function stopUsablePoll() {
  if (usablePollTimeout) {
    clearTimeout(usablePollTimeout);
    usablePollTimeout = null;
  }
}

async function pollForUsable() {
  if (!isOpen) return;

  if (Date.now() - usablePollStart > USABLE_TIMEOUT_MS) {
    transitionTo(STATE.FAILED, 'Timed out waiting for batch to become usable.');
    return;
  }

  try {
    const result = await window.swarmNode?.getStamps();
    if (!isOpen) return;
    if (!result?.success) {
      scheduleNextPoll();
      return;
    }

    const usable = result.stamps.some(
      (s) => s.usable && (!pendingBatchId || s.batchId === pendingBatchId)
    );

    if (usable) {
      transitionTo(STATE.USABLE);
      // Show the batch list with the data we already have
      const stamps = result.stamps;
      setTimeout(() => {
        if (isOpen) {
          renderBatchList(stamps);
          showListView();
        }
      }, 2000);
      return;
    }
  } catch {
    // Keep polling
  }

  scheduleNextPoll();
}

function scheduleNextPoll() {
  if (isOpen && currentState === STATE.WAITING_FOR_USABLE) {
    usablePollTimeout = setTimeout(() => pollForUsable(), USABLE_POLL_MS);
  }
}

// ============================================
// State machine
// ============================================

function transitionTo(newState, errorMessage) {
  currentState = newState;
  renderState(errorMessage);
}

function renderState(errorMessage) {
  const isIdle = currentState === STATE.IDLE;
  const isEstimating = currentState === STATE.ESTIMATING;
  const isReady = currentState === STATE.READY_TO_BUY;
  const isPurchasing = currentState === STATE.PURCHASING;
  const isWaiting = currentState === STATE.WAITING_FOR_USABLE;
  const isUsable = currentState === STATE.USABLE;
  const isFailed = currentState === STATE.FAILED;

  const presetsEnabled = isIdle || isEstimating || isReady || isFailed;
  presetContainer?.querySelectorAll('.stamp-preset-btn').forEach((btn) => {
    btn.disabled = !presetsEnabled;
  });

  if (costDisplay) {
    costDisplay.classList.toggle('hidden', isIdle);
  }
  if (costSpinner) {
    costSpinner.classList.toggle('hidden', !isEstimating);
  }
  if (costValue) {
    costValue.classList.toggle('hidden', isEstimating || isIdle);
  }

  if (purchaseBtn) {
    purchaseBtn.disabled = !isReady;
    purchaseBtn.classList.toggle('hidden', isPurchasing || isWaiting || isUsable);
  }

  if (purchaseStatus) {
    if (isPurchasing) {
      purchaseStatus.textContent = 'Purchasing storage\u2026';
      purchaseStatus.classList.remove('hidden');
    } else if (isWaiting) {
      purchaseStatus.textContent = 'Batch purchased, waiting for network confirmation\u2026';
      purchaseStatus.classList.remove('hidden');
    } else if (isUsable) {
      purchaseStatus.textContent = 'Storage batch is ready.';
      purchaseStatus.classList.remove('hidden');
    } else {
      purchaseStatus.classList.add('hidden');
    }
  }

  if (purchaseError) {
    if (isFailed && errorMessage) {
      purchaseError.textContent = errorMessage;
      purchaseError.classList.remove('hidden');
    } else {
      purchaseError.classList.add('hidden');
    }
  }

  if (retryBtn) {
    retryBtn.classList.toggle('hidden', !isFailed);
  }
}
