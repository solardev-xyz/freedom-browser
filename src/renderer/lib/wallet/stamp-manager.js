/**
 * Stamp Manager Module
 *
 * The sidebar "Storage" screen: the node's postage batches, each with extend
 * and grow options priced in xDAI, and a warning when the chequebook deposit
 * has run dry. Every purchase goes through the publish setup's pay step
 * (publish-setup.js), which the main-process setup service drives.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { formatBytes } from './wallet-utils.js';
import { openPublishSetup } from './publish-setup.js';
import { formatDays, formatStorageSize } from './swarm-readiness.js';

const TTL_WARN_SECONDS = 7 * 86400; // 7 days
const TTL_CRITICAL_SECONDS = 86400; // 1 day

// DOM references
let stampManagerScreen;
let stampManagerBackBtn;
let batchListContainer;
let emptyText;
let buyMoreBtn;
let depositWarning;
let depositTopUpBtn;

let isOpen = false;
let setupState = null;
let loadedKey = null;
let loadRequestId = 0;

export function initStampManager() {
  stampManagerScreen = document.getElementById('sidebar-stamp-manager');
  stampManagerBackBtn = document.getElementById('stamp-manager-back');
  batchListContainer = document.getElementById('stamp-batch-list');
  emptyText = document.getElementById('stamp-list-empty');
  buyMoreBtn = document.getElementById('stamp-buy-another-btn');
  depositWarning = document.getElementById('stamp-deposit-warning');
  depositTopUpBtn = document.getElementById('stamp-deposit-topup');

  registerScreenHider(() => closeStampManager());

  stampManagerBackBtn?.addEventListener('click', () => closeStampManager());
  buyMoreBtn?.addEventListener('click', () => {
    closeStampManager();
    openPublishSetup();
  });
  depositTopUpBtn?.addEventListener('click', () => startOperation({ kind: 'deposit' }));

  window.publishSetup?.onState((state) => {
    setupState = state;
    if (!isOpen) return;
    renderDepositWarning();
    if (stampsKey(state) !== loadedKey) loadBatchList();
  });
}

export async function openStampManager() {
  if (refuseSubscreenWhileInFlight('Stamp manager screen')) return;

  walletState.identityView?.classList.add('hidden');
  stampManagerScreen?.classList.remove('hidden');
  isOpen = true;
  loadedKey = null;
  void window.publishSetup?.watch('storage', true);

  renderDepositWarning();
  loadBatchList();
  try {
    setupState = (await window.publishSetup?.getState()) || setupState;
  } catch {
    // The push subscription fills it in.
  }
  if (isOpen) renderDepositWarning();
}

export function closeStampManager() {
  if (isOpen) void window.publishSetup?.watch('storage', false);
  isOpen = false;
  stampManagerScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

// A finished purchase or a change in the node's batches reloads the list.
function stampsKey(state) {
  const op = state?.operation;
  return `${state?.stamps?.usable}/${state?.stamps?.total}/${op?.id}:${op?.phase}`;
}

function renderDepositWarning() {
  const chequebook = setupState?.account?.chequebook;
  const dry = Boolean(chequebook?.needsTopUp) && chequebook.managed !== false;
  depositWarning?.classList.toggle('hidden', !dry);
  depositTopUpBtn?.classList.toggle('hidden', !dry || !setupState?.canBuy);
}

async function loadBatchList() {
  const requestId = ++loadRequestId;
  loadedKey = stampsKey(setupState);
  try {
    const result = await window.swarmNode?.getStamps();
    if (!isOpen || requestId !== loadRequestId) return;
    const stamps = result?.success ? result.stamps : [];
    renderBatchList(stamps);
  } catch {
    if (!isOpen || requestId !== loadRequestId) return;
    renderBatchList([]);
  }
}

async function startOperation(request) {
  const result = await window.publishSetup?.arm(request);
  // A refusal (another purchase still running, say) is shown on the setup
  // screen, over the operation that is in the way.
  const error = result && !result.ok ? result.error || 'Could not start.' : null;
  closeStampManager();
  openPublishSetup({ error });
}

// ============================================
// Batch list rendering
// ============================================

function renderBatchList(stamps) {
  if (!batchListContainer) return;

  batchListContainer.innerHTML = '';
  emptyText?.classList.toggle('hidden', stamps.length > 0);
  if (buyMoreBtn) buyMoreBtn.textContent = stamps.length > 0 ? 'Buy More Storage' : 'Buy Storage';
  buyMoreBtn?.classList.toggle('hidden', setupState?.canBuy === false);

  stamps.forEach((batch) => {
    const card = document.createElement('div');
    card.className = 'stamp-batch-card';
    const status = batch.usable ? 'usable' : batch.pending ? 'pending' : 'unusable';
    if (status === 'unusable') card.classList.add('unusable');

    const statusBadge = document.createElement('div');
    statusBadge.className = 'stamp-batch-status';
    statusBadge.dataset.status = status;
    statusBadge.textContent = { usable: 'Usable', pending: 'Confirming', unusable: 'Not usable' }[
      status
    ];
    card.appendChild(statusBadge);

    card.appendChild(createRow('Size', batch.sizeBytes > 0 ? formatBytes(batch.sizeBytes) : '--'));
    card.appendChild(createRow('Used', `${batch.usagePercent}%`));

    const ttlRow = createRow('Time remaining', formatDuration(batch.ttlSeconds));
    const ttlValueEl = ttlRow.querySelector('.stamp-batch-value');
    if (ttlValueEl && batch.ttlSeconds > 0) {
      if (batch.ttlSeconds < TTL_CRITICAL_SECONDS) {
        ttlValueEl.classList.add('ttl-critical');
      } else if (batch.ttlSeconds < TTL_WARN_SECONDS) {
        ttlValueEl.classList.add('ttl-warn');
      }
    }
    card.appendChild(ttlRow);

    const idRow = document.createElement('div');
    idRow.className = 'stamp-batch-id';
    idRow.textContent = batch.batchId
      ? `${batch.batchId.slice(0, 8)}…${batch.batchId.slice(-8)}`
      : '--';
    idRow.title = batch.batchId || '';
    card.appendChild(idRow);

    if (batch.usable && batch.batchId && setupState?.canBuy !== false) {
      const actions = document.createElement('div');
      actions.className = 'stamp-batch-actions';

      const extendBtn = document.createElement('button');
      extendBtn.type = 'button';
      extendBtn.className = 'stamp-batch-action-btn';
      extendBtn.textContent = 'Keep Longer';
      extendBtn.addEventListener('click', () => showExtensionForm(card, batch, 'duration'));
      actions.appendChild(extendBtn);

      if (largerSizes(batch).length > 0) {
        const growBtn = document.createElement('button');
        growBtn.type = 'button';
        growBtn.className = 'stamp-batch-action-btn';
        growBtn.textContent = 'Make Bigger';
        growBtn.addEventListener('click', () => showExtensionForm(card, batch, 'size'));
        actions.appendChild(growBtn);
      }

      card.appendChild(actions);
    }

    batchListContainer.appendChild(card);
  });
}

// The plan sizes above this batch's depth: growing keeps its expiry date.
function largerSizes(batch) {
  if (!Number.isInteger(batch.depth)) return [];
  return (setupState?.plans || []).filter((plan) => plan.depth > batch.depth);
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
  card.querySelector('.stamp-extend-form')?.remove();

  const form = document.createElement('div');
  form.className = 'stamp-extend-form';

  const heading = document.createElement('div');
  heading.className = 'stamp-extend-heading';
  heading.textContent =
    type === 'duration' ? 'Keep your storage longer' : 'Make it bigger, same expiry date';
  form.appendChild(heading);

  const presetRow = document.createElement('div');
  presetRow.className = 'stamp-extend-presets';
  form.appendChild(presetRow);

  const statusEl = document.createElement('div');
  statusEl.className = 'stamp-extend-cost';
  statusEl.textContent = 'Getting prices…';
  form.appendChild(statusEl);

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'stamp-extend-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => form.remove());
  form.appendChild(cancelBtn);

  card.appendChild(form);
  void loadExtensionOptions(form, presetRow, statusEl, batch, type);
}

async function loadExtensionOptions(form, presetRow, statusEl, batch, type) {
  let options;
  try {
    options = await window.publishSetup?.getExtendOptions(batch.batchId, batch.depth);
  } catch (err) {
    options = { error: err.message };
  }
  if (!isOpen || !form.isConnected) return;

  const entries =
    type === 'duration'
      ? (options?.durations || []).map((option) => ({
          label: `+${formatDays(option.days)}`,
          option,
          request: { kind: 'extend', batchId: batch.batchId, days: option.days },
        }))
      : (options?.sizes || []).map((option) => ({
          label: `Up to ${formatStorageSize(option.safeLimitBytes)}`,
          option,
          request: { kind: 'extend', batchId: batch.batchId, days: 0, depth: option.depth },
        }));

  entries.forEach(({ label, option, request }) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stamp-extend-preset-btn';
    btn.textContent = option.quote ? `${label} · ${option.quote.price.display} xDAI` : label;
    btn.disabled = !option.quote;
    btn.addEventListener('click', () => startOperation(request));
    presetRow.appendChild(btn);
  });

  const error = options?.error || entries.find((e) => e.option.error)?.option.error;
  statusEl.textContent = error || 'You pay in xDAI, the same way as for a new plan.';
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
