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

const DURATION_PRESETS = [
  { label: '+7 days', days: 7 },
  { label: '+30 days', days: 30 },
  { label: '+90 days', days: 90 },
];

/**
 * Generate size extension presets that are strictly larger than the
 * current batch size. bee-js treats size as ABSOLUTE (new total).
 */
function getSizePresetsForBatch(currentSizeBytes) {
  const currentGB = currentSizeBytes / (1000 * 1000 * 1000); // bee-js uses 1000-based units
  const candidates = [1, 2, 5, 10, 20, 50, 100];
  const presets = [];
  for (const gb of candidates) {
    if (gb > currentGB && presets.length < 3) {
      presets.push({ label: `${gb} GB`, gb });
    }
  }
  // Fallback if batch is already very large
  if (presets.length === 0) {
    const next = Math.ceil(currentGB / 10) * 10 + 10;
    presets.push({ label: `${next} GB`, gb: next });
  }
  return presets;
}

const TTL_WARN_SECONDS = 7 * 86400; // 7 days
const TTL_CRITICAL_SECONDS = 86400; // 1 day

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
    const sizeRow = createRow('Size', batch.sizeBytes > 0 ? formatBytes(batch.sizeBytes) : '--');
    card.appendChild(sizeRow);

    // Usage
    card.appendChild(createRow('Used', `${batch.usagePercent}%`));

    // TTL with expiry warning
    const ttlText = formatDuration(batch.ttlSeconds);
    const ttlRow = createRow('Time remaining', ttlText);
    const ttlValueEl = ttlRow.querySelector('.stamp-batch-value');
    if (ttlValueEl && batch.ttlSeconds > 0) {
      if (batch.ttlSeconds < TTL_CRITICAL_SECONDS) {
        ttlValueEl.classList.add('ttl-critical');
      } else if (batch.ttlSeconds < TTL_WARN_SECONDS) {
        ttlValueEl.classList.add('ttl-warn');
      }
    }
    card.appendChild(ttlRow);

    // Batch ID
    const idRow = document.createElement('div');
    idRow.className = 'stamp-batch-id';
    idRow.textContent = batch.batchId
      ? `${batch.batchId.slice(0, 8)}\u2026${batch.batchId.slice(-8)}`
      : '--';
    idRow.title = batch.batchId || '';
    card.appendChild(idRow);

    // Action buttons (only for usable batches)
    if (batch.usable && batch.batchId) {
      const actions = document.createElement('div');
      actions.className = 'stamp-batch-actions';

      const extDurBtn = document.createElement('button');
      extDurBtn.type = 'button';
      extDurBtn.className = 'stamp-batch-action-btn';
      extDurBtn.textContent = 'Extend Duration';
      extDurBtn.addEventListener('click', () => showExtensionForm(card, batch, 'duration'));
      actions.appendChild(extDurBtn);

      const extSizeBtn = document.createElement('button');
      extSizeBtn.type = 'button';
      extSizeBtn.className = 'stamp-batch-action-btn';
      extSizeBtn.textContent = 'Extend Size';
      extSizeBtn.addEventListener('click', () => showExtensionForm(card, batch, 'size'));
      actions.appendChild(extSizeBtn);

      card.appendChild(actions);
    }

    batchListContainer.appendChild(card);
  });
}

function createRow(label, value) {
  const row = document.createElement('div');
  row.className = 'stamp-batch-row';
  const labelEl = document.createElement('span');
  labelEl.className = 'stamp-batch-label';
  labelEl.textContent = label;
  const valueEl = document.createElement('span');
  valueEl.className = 'stamp-batch-value';
  valueEl.textContent = value;
  row.appendChild(labelEl);
  row.appendChild(valueEl);
  return row;
}

// ============================================
// Extension form (inline within batch card)
// ============================================

function showExtensionForm(card, batch, type) {
  // Remove any existing extension form in this card
  const existing = card.querySelector('.stamp-extend-form');
  if (existing) existing.remove();

  const form = document.createElement('div');
  form.className = 'stamp-extend-form';

  const presets = type === 'duration' ? DURATION_PRESETS : getSizePresetsForBatch(batch.sizeBytes);
  const title = type === 'duration' ? 'Extend Duration' : 'Extend Size';

  const heading = document.createElement('div');
  heading.className = 'stamp-extend-heading';
  heading.textContent = title;
  form.appendChild(heading);

  const presetRow = document.createElement('div');
  presetRow.className = 'stamp-extend-presets';

  let selectedValue = null;
  let extEstimationId = 0;

  presets.forEach((preset, i) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stamp-extend-preset-btn';
    btn.textContent = preset.label;
    btn.addEventListener('click', () => {
      presetRow.querySelectorAll('.stamp-extend-preset-btn').forEach((b, j) => {
        b.classList.toggle('selected', j === i);
      });
      selectedValue = type === 'duration' ? preset.days : preset.gb;
      extEstimationId++;
      estimateExtensionCost(form, batch.batchId, type, selectedValue, extEstimationId, () => extEstimationId);
    });
    presetRow.appendChild(btn);
  });
  form.appendChild(presetRow);

  const costRow = document.createElement('div');
  costRow.className = 'stamp-extend-cost hidden';
  costRow.dataset.role = 'cost';
  form.appendChild(costRow);

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'stamp-extend-confirm-btn';
  confirmBtn.textContent = 'Confirm';
  confirmBtn.disabled = true;
  confirmBtn.dataset.role = 'confirm';
  confirmBtn.addEventListener('click', () => {
    if (selectedValue) {
      executeExtension(form, batch.batchId, type, selectedValue);
    }
  });
  form.appendChild(confirmBtn);

  const statusEl = document.createElement('div');
  statusEl.className = 'stamp-extend-status hidden';
  statusEl.dataset.role = 'status';
  form.appendChild(statusEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'stamp-extend-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());
  form.appendChild(cancelBtn);

  card.appendChild(form);
}

async function estimateExtensionCost(form, batchId, type, value, thisId, getCurrentId) {
  const costEl = form.querySelector('[data-role="cost"]');
  const confirmBtn = form.querySelector('[data-role="confirm"]');

  if (costEl) {
    costEl.textContent = 'Estimating cost\u2026';
    costEl.classList.remove('hidden');
  }
  if (confirmBtn) confirmBtn.disabled = true;

  try {
    const result = type === 'duration'
      ? await window.swarmNode?.getDurationExtensionCost(batchId, value)
      : await window.swarmNode?.getSizeExtensionCost(batchId, value);

    if (!isOpen || thisId !== getCurrentId()) return;

    if (result?.success) {
      if (costEl) costEl.textContent = `Cost: ${result.bzz} xBZZ`;
      if (confirmBtn) confirmBtn.disabled = false;
    } else {
      if (costEl) costEl.textContent = result?.error || 'Failed to estimate cost.';
    }
  } catch (err) {
    if (!isOpen || thisId !== getCurrentId()) return;
    if (costEl) costEl.textContent = err.message || 'Failed to estimate cost.';
  }
}

async function executeExtension(form, batchId, type, value) {
  const confirmBtn = form.querySelector('[data-role="confirm"]');
  const statusEl = form.querySelector('[data-role="status"]');

  if (confirmBtn) confirmBtn.disabled = true;
  if (statusEl) {
    statusEl.textContent = type === 'duration'
      ? 'Extending duration\u2026'
      : 'Extending size\u2026';
    statusEl.classList.remove('hidden', 'success', 'error');
  }

  try {
    const result = type === 'duration'
      ? await window.swarmNode?.extendStorageDuration(batchId, value)
      : await window.swarmNode?.extendStorageSize(batchId, value);

    if (!isOpen) return;

    if (result?.success) {
      if (statusEl) {
        statusEl.textContent = 'Extension successful.';
        statusEl.classList.add('success');
      }
      // Refresh the batch list after a short delay
      setTimeout(() => { if (isOpen) loadBatchList(); }, 2000);
    } else {
      if (statusEl) {
        statusEl.textContent = result?.error || 'Extension failed.';
        statusEl.classList.add('error');
      }
      if (confirmBtn) confirmBtn.disabled = false;
    }
  } catch (err) {
    if (!isOpen) return;
    if (statusEl) {
      statusEl.textContent = err.message || 'Extension failed.';
      statusEl.classList.add('error');
    }
    if (confirmBtn) confirmBtn.disabled = false;
  }
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
