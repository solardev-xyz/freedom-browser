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
let loadingStatus;
let loadingText;
let scanStatus;
let scanWarning;
let scanWarningText;
let buyMoreBtn;
let depositWarning;
let depositTopUpBtn;

let isOpen = false;
let setupState = null;
// Batches in the list last rendered; null until this visit has a list to
// show (the cached one, or its own getStamps).
let batchCount = null;
let loadedKey = null;
let loadRequestId = 0;
// True while this visit's getStamps is in flight: the spinner line shows.
let refreshing = false;
// What the rendered cards were built from, so a refresh that brings the same
// list leaves them (and any open extension form) alone.
let renderedSignature = null;
// The last non-empty list getStamps returned, and for which node wallet. A
// return visit shows it at once while the fresh list loads (#595). Profiles
// run in their own processes, so this never crosses one.
let cachedBatches = null;
// The node wallet the last state with an account named.
let knownWallet = null;

export function initStampManager() {
  stampManagerScreen = document.getElementById('sidebar-stamp-manager');
  stampManagerBackBtn = document.getElementById('stamp-manager-back');
  batchListContainer = document.getElementById('stamp-batch-list');
  emptyText = document.getElementById('stamp-list-empty');
  loadingStatus = document.getElementById('stamp-list-loading');
  loadingText = document.getElementById('stamp-list-loading-text');
  scanStatus = document.getElementById('stamp-scan-status');
  scanWarning = document.getElementById('stamp-scan-warning');
  scanWarningText = document.getElementById('stamp-scan-warning-text');
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
    const walletChanged = adoptState(state);
    if (!isOpen) return;
    // Another wallet's cards must not stay up while its own list loads.
    if (walletChanged) clearBatchList();
    renderDepositWarning();
    renderScanStatus();
    if (walletChanged || stampsKey(state) !== loadedKey) loadBatchList();
  });
}

export async function openStampManager() {
  if (refuseSubscreenWhileInFlight('Stamp manager screen')) return;

  walletState.identityView?.classList.add('hidden');
  stampManagerScreen?.classList.remove('hidden');
  isOpen = true;
  loadedKey = null;
  clearBatchList();
  const cached = cachedStampsForWallet();
  if (cached) renderBatchList(cached);
  void window.publishSetup?.watch('storage', true);

  renderDepositWarning();
  renderScanStatus();
  loadBatchList();
  let walletChanged = false;
  try {
    walletChanged = adoptState((await window.publishSetup?.getState()) || setupState);
  } catch {
    // The push subscription fills it in.
  }
  if (isOpen) {
    if (walletChanged) {
      clearBatchList();
      loadBatchList();
    }
    renderDepositWarning();
    renderScanStatus();
  }
}

export function closeStampManager() {
  if (isOpen) void window.publishSetup?.watch('storage', false);
  isOpen = false;
  clearBatchList();
  stampManagerScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

function walletKey() {
  return setupState?.account?.walletAddress || null;
}

// Takes a publish-setup state; true when it names a different node wallet
// than the last one, which drops the cached list. A state with no account
// says nothing about which wallet it is.
function adoptState(state) {
  setupState = state;
  const wallet = walletKey();
  if (wallet === null) return false;
  const changed = knownWallet !== null && wallet !== knownWallet;
  knownWallet = wallet;
  if (changed) cachedBatches = null;
  // A list that landed before any state named the wallet is this one's.
  else if (cachedBatches?.wallet === null) cachedBatches.wallet = wallet;
  return changed;
}

function cachedStampsForWallet() {
  const wallet = walletKey();
  return wallet && cachedBatches?.wallet === wallet ? cachedBatches.stamps : null;
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

// Ant's search for storage this wallet bought before (#510,
// /health.walletScan). While publish setup holds on it, the list may be
// missing batches the wallet owns, so the screen shows the search and its
// progress instead of "You have no storage yet". Readiness carries the
// message (publish-setup-service.js); this screen shows its `scanMessage`
// when set, since the setup screen's wording promises storage plans that
// never appear here.
function scanHold() {
  const readiness = setupState?.readiness;
  if (readiness?.key !== 'checking') return null;
  return readiness.rediscovery === 'running' || readiness.rediscovery === 'retrying'
    ? readiness
    : null;
}

function renderScanStatus() {
  const hold = scanHold();
  if (scanStatus) {
    scanStatus.textContent = hold?.scanMessage || hold?.message || '';
    scanStatus.classList.toggle('hidden', !hold);
  }
  // The search gave up (30 minutes without progress): the hold is released,
  // so the empty state is back, under the same warning setup shows.
  const readiness = setupState?.readiness;
  const stalled = !hold && readiness?.scanStalled === true;
  scanWarning?.classList.toggle('hidden', !stalled);
  if (scanWarningText) scanWarningText.textContent = stalled ? readiness.message : '';
  renderEmptyText();
}

function renderEmptyText() {
  // Until the list lands nothing says "no storage": a wallet with batches
  // would read that, beside the buy button, for as long as /stamps takes.
  emptyText?.classList.toggle(
    'hidden',
    batchCount === null || batchCount > 0 || scanHold() !== null
  );
}

// The cards, the count and the buy button's wording go together, so they are
// only ever set as one snapshot: this wallet's cached list, or this visit's
// getStamps. Clearing drops all three, so the empty text stays hidden until a
// visit knows the list is empty. The button stays (with the neutral "Buy
// Storage") so a slow or stuck /stamps never leaves the screen without a way
// to buy.
function clearBatchList() {
  if (batchListContainer) batchListContainer.innerHTML = '';
  batchCount = null;
  renderedSignature = null;
  refreshing = false;
  renderLoadingStatus();
  if (buyMoreBtn) buyMoreBtn.textContent = 'Buy Storage';
}

// The spinner line while /stamps loads: in place of the list on a first
// visit, over the cached cards on a return one.
function renderLoadingStatus() {
  const show = isOpen && refreshing;
  loadingStatus?.classList.toggle('hidden', !show);
  if (loadingText) {
    loadingText.textContent = !show
      ? ''
      : batchCount > 0
        ? 'Checking for changes…'
        : 'Loading your storage…';
  }
}

async function loadBatchList() {
  const requestId = ++loadRequestId;
  loadedKey = stampsKey(setupState);
  refreshing = true;
  renderLoadingStatus();
  let stamps;
  try {
    const result = await window.swarmNode?.getStamps();
    if (!isOpen || requestId !== loadRequestId) return;
    if (result?.success) {
      stamps = result.stamps || [];
      // A wallet change starts a new request, so this list is the current
      // wallet's (or, before any state named one, the first wallet's).
      cachedBatches = stamps.length > 0 ? { wallet: knownWallet, stamps } : null;
    }
  } catch {
    if (!isOpen || requestId !== loadRequestId) return;
  }
  // A failed refresh keeps this wallet's cached list rather than claiming
  // it has no storage.
  refreshing = false;
  renderBatchList(stamps ?? cachedStampsForWallet() ?? []);
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

  const signature = JSON.stringify([stamps, setupState?.canBuy, setupState?.plans]);
  batchCount = stamps.length;
  renderLoadingStatus();
  renderEmptyText();
  // Nothing changed since the cards were drawn: keep them, and with them any
  // extension form the user opened during the refresh.
  if (signature === renderedSignature) return;
  renderedSignature = signature;

  batchListContainer.innerHTML = '';
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
