/**
 * Safe account status card — the blocking states of a Safe account as
 * first-class UI (research doc Part B, decision 2), shown under the
 * Send/Receive actions when the active account is a Safe:
 *   - ready:        activation fee quote + who pays + Activate button
 *   - needs-funds:  blocking "fund <executor> with ≥ X xDAI" card
 *   - no-executor:  none of the owners is a browser account that can pay
 * (Pending SafeTxs live in the wallet-wide "unfinished transactions"
 * row — see safe-pending-list.js.) A deployed Safe shows no card. The Send button's
 * availability is owned by send.js; this module just triggers the
 * re-evaluation whenever the active account changes.
 */

import { walletState } from './wallet-state.js';
import {
  escapeHtml,
  truncateAddress,
  formatRawTokenBalance,
  walletRecord,
  isSafeDeployed,
  showInlineError,
} from './wallet-utils.js';
import { updateSendAvailability } from './send.js';
import { showVaultUnlock } from './vault-unlock.js';

let card;
let refreshToken = 0;

// Safes (by wallet index) whose activation was sent this session but that
// no verified source has confirmed yet (activateSafe's SAFE_UNVERIFIED
// carrying the deployment's hash). Until a status check reports the Safe
// deployed, its card offers a re-check, never Activate: an unverified
// "not deployed" read here is likely a lagging endpoint, and a second
// deployment would revert and cost gas. Renderer-session only.
const sentUnverified = new Map(); // index -> message

const SAFE_UNVERIFIED = 'SAFE_UNVERIFIED';

/**
 * Re-evaluate the card for the active account. Called whenever the
 * active account changes (wallet-selector) and after activation.
 */
export async function refreshSafeStatusCard() {
  card = document.getElementById('safe-status-card');
  if (!card) return;

  updateSendAvailability();

  const wallet = walletRecord();
  if (wallet?.type !== 'safe') {
    card.classList.add('hidden');
    return;
  }

  // Deployed safes need no activation card — and the record snapshot is
  // trustworthy once it says deployed (deployment is permanent).
  if (isSafeDeployed(wallet)) {
    card.classList.add('hidden');
    return;
  }

  const token = ++refreshToken;
  render(`<div class="safe-status-text">Checking account status…</div>`);

  const statusResult = await window.wallet.getSafeStatus(wallet.index);
  if (token !== refreshToken) return; // superseded by an account switch
  if (!statusResult.success) {
    if (statusResult.code === SAFE_UNVERIFIED && sentUnverified.has(wallet.index)) {
      renderSentUnverified(wallet.index);
      return;
    }
    renderStatusError(statusResult.error);
    return;
  }

  // Main owns deployment truth (it self-heals the stored record from
  // chain state) — sync the renderer's record snapshot so capability
  // gates like the Send button don't act on a stale copy.
  if (statusResult.status.deployed && !wallet.deployed?.[statusResult.status.chainId]) {
    wallet.deployed = { ...wallet.deployed, [statusResult.status.chainId]: true };
    updateSendAvailability();
  }

  renderStatus(statusResult.status, wallet.index);
}

/**
 * A status check that failed (no verified answer, RPC down …): say why,
 * and offer the retry the message asks for.
 */
function renderStatusError(message) {
  render(`
    <div class="safe-status-text">${escapeHtml(message)}</div>
    <button type="button" class="safe-status-btn" id="safe-status-retry">Try again</button>
    <div class="unlock-error hidden" id="safe-status-error"></div>
  `);
  document.getElementById('safe-status-retry')?.addEventListener('click', refreshSafeStatusCard);
}

/** Activation sent, not yet verified: a re-check, and no Activate. */
function renderSentUnverified(index) {
  render(`
    <div class="safe-status-text">${escapeHtml(sentUnverified.get(index))}</div>
    <button type="button" class="safe-status-btn" id="safe-status-retry">Check again</button>
    <div class="unlock-error hidden" id="safe-status-error"></div>
  `);
  document.getElementById('safe-status-retry')?.addEventListener('click', refreshSafeStatusCard);
}

function renderStatus(status, index) {
  if (status.deployed) {
    sentUnverified.delete(index);
    card.classList.add('hidden');
    return;
  }

  // An activation already sent outranks every "not deployed" state below:
  // a lagging read can quote a redeploy the executor (having just paid
  // gas) can no longer cover, and asking for funds then would be wrong.
  if (sentUnverified.has(index)) {
    renderSentUnverified(index);
    return;
  }

  if (status.executorIndex === null) {
    render(`
      <div class="safe-status-text">
        This account can receive funds, but none of its owners is a
        browser account that could pay the activation fee.
      </div>
    `);
    return;
  }

  const executorName =
    walletState.derivedWallets.find((wallet) => wallet.index === status.executorIndex)?.name ||
    'an owner account';

  if (status.needsFunds) {
    render(`
      <div class="safe-status-text">
        <strong>Receive-only.</strong> To activate on Gnosis, fund
        <code>${escapeHtml(truncateAddress(status.executorAddress))}</code>
        (${escapeHtml(executorName)}) with at least
        <strong>${formatRawTokenBalance(status.estimatedCost)} xDAI</strong>.
      </div>
      <button type="button" class="safe-status-btn" id="safe-status-refresh">I've added funds</button>
    `);
    document
      .getElementById('safe-status-refresh')
      ?.addEventListener('click', refreshSafeStatusCard);
    return;
  }

  render(`
    <div class="safe-status-text">
      <strong>Receive-only until activated.</strong> One-time activation
      on Gnosis costs ≈ ${formatRawTokenBalance(status.estimatedCost)} xDAI,
      paid by ${escapeHtml(executorName)}.
    </div>
    <button type="button" class="safe-status-btn primary" id="safe-status-activate">Activate</button>
    <div class="unlock-error hidden" id="safe-status-error"></div>
  `);
  document.getElementById('safe-status-activate')?.addEventListener('click', handleActivate);
}

async function handleActivate() {
  const wallet = walletRecord();
  if (!wallet) return;

  const button = document.getElementById('safe-status-activate');
  if (button) {
    button.disabled = true;
    button.textContent = 'Activating…';
  }

  const index = wallet.index;
  const result = await window.wallet.activateSafe(index);

  // Deployment is signed by the executor's vault key: a locked vault is
  // a step in the flow, not a failure — walk the user through the
  // standard unlock and retry.
  if (!result.success && result.code === 'VAULT_LOCKED') {
    try {
      await showVaultUnlock('Activate your multi-owner account');
      return handleActivate();
    } catch {
      // user cancelled — fall through to the re-rendered card
    }
  }

  // Sent but unverified: remember it, so neither this card nor a later
  // refresh offers Activate again, and show the activation's own message
  // rather than whatever the next status read says.
  if (!result.success && result.code === SAFE_UNVERIFIED && result.hash) {
    console.error('[SafeStatus] Activation unverified:', result.error);
    sentUnverified.set(index, result.error);
    if (walletRecord()?.index === index) {
      refreshToken++; // drop any in-flight status read for this card
      card = document.getElementById('safe-status-card');
      if (card) renderSentUnverified(index);
    }
    return;
  }

  await refreshSafeStatusCard(); // re-render first, then surface errors on it
  // Every card state has the error slot. An account switch meanwhile
  // shows another account's card: this error is not about it.
  if (!result.success && result.code !== 'VAULT_LOCKED' && walletRecord()?.index === index) {
    // NEEDS_FUNDS re-renders as its own blocking state; anything else
    // (RPC down …) must be said out loud, not just reset.
    console.error('[SafeStatus] Activation failed:', result.error);
    showInlineError(document.getElementById('safe-status-error'), result.error);
  }
}

function render(html) {
  card.innerHTML = html;
  card.classList.remove('hidden');
}
