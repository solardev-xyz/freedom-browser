/**
 * Safe account status card — the blocking states of a Safe account as
 * first-class UI (research doc Part B, decision 2), shown under the
 * Send/Receive actions when the active account is a Safe:
 *   - ready:        activation fee quote + who pays + Activate button
 *   - needs-funds:  blocking "fund <executor> with ≥ X xDAI" card
 *   - no-executor:  none of the owners is a browser account that can pay
 *   - error:        the status check failed (no verified answer, RPC down…),
 *                   with a Try again button that runs it again
 * (Pending SafeTxs live in the wallet-wide "unfinished transactions"
 * row — see safe-pending-list.js.) A deployed Safe shows no card. The Send button's
 * availability is owned by send.js; this module just triggers the
 * re-evaluation whenever the active account changes.
 *
 * On the core's Safe backend (freedom-core design 0016, SAFE-3), main's
 * status carries `setup`, what the core's reads show of the Safe. Only a
 * deployed Safe whose setup is unchanged, every read verified, is taken as
 * active (marked in the snapshot, no card). Any other setup (changed, or a
 * read unverified, the code's included) leaves it unmarked, and the card
 * says why, with Try again. The core judges the activation's fee itself:
 * the approvals document asks it, or, with the document off, main's answer
 * carries the ID of the ask main holds (`feeAskId`), which the card's
 * confirmation returns, with no token; a fee above the threshold is
 * pressed twice (`feeAskAgain`).
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
import {
  FEE_CHECK,
  FEE_CHECK_ASK_AGAIN,
  FEE_CHECK_NEEDS_CONFIRMATION,
  confirmOfferedFee,
  describeFeeCheck,
} from './fee-check.js';

/** The core's activation check that no verified source confirmed (design
 * 0016, Chain reads: `isDeployedOnChain`'s text). */
const ACTIVATION_UNVERIFIED =
  "Freedom couldn't verify on Gnosis whether this account is activated. " +
  'Try again, or add an RPC provider in Settings.';

/** The core's `safe_unverified` and `safe_changed` texts (design 0016). */
const SETUP_UNVERIFIED =
  "Freedom couldn't verify this account on Gnosis, so it won't sign. " +
  'Try again, or add an RPC provider in Settings.';
const SETUP_CHANGED = "This account was changed outside Freedom, so Freedom can't sign for it.";

/**
 * Why a Safe the core reports deployed isn't taken as active (design 0016,
 * API, `setup`): only an unchanged setup, every read verified, is. Null for
 * that, and for main's own status (the JS backend's, with no `setup`),
 * which says deployed only on a verified read.
 */
function unsettledSetup(status) {
  if (status?.deployed !== true || status.setup === undefined) return null;
  const setup = status.setup;
  if (setup?.state === 'unchanged') return null;
  if (setup?.state === 'changed') return SETUP_CHANGED;
  if (setup?.state === 'unverified' && setup.read === 'code') return ACTIVATION_UNVERIFIED;
  return SETUP_UNVERIFIED;
}

let card;
let refreshToken = 0;
// The status check in flight, if any: Try again starts no second one.
let statusCheck = null;

/**
 * Re-evaluate the card for the active account. Called whenever the
 * active account changes (wallet-selector) and after activation.
 */
export async function refreshSafeStatusCard() {
  await checkSafeStatus(() =>
    render(`<div class="safe-status-text">Checking account status…</div>`)
  );
}

/**
 * The status check behind refreshSafeStatusCard and Try again.
 * `showChecking` paints the card while getSafeStatus runs.
 */
async function checkSafeStatus(showChecking) {
  card = document.getElementById('safe-status-card');
  if (!card) return;

  // Before any early return: a check still in flight for the account
  // shown before must not paint over this one's card.
  const token = ++refreshToken;
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

  showChecking();

  const check = window.wallet.getSafeStatus(wallet.index);
  statusCheck = check;
  let statusResult;
  try {
    statusResult = await check;
  } finally {
    if (statusCheck === check) statusCheck = null;
  }
  if (token !== refreshToken) return; // superseded by an account switch
  if (!statusResult.success) {
    renderStatusError(statusResult.error);
    return;
  }
  const unsettled = unsettledSetup(statusResult.status);
  if (unsettled) {
    renderStatusError(unsettled);
    return;
  }

  // Main owns deployment truth (it self-heals the stored record from
  // chain state) — sync the renderer's record snapshot so capability
  // gates like the Send button don't act on a stale copy.
  if (statusResult.status.deployed && !wallet.deployed?.[statusResult.status.chainId]) {
    wallet.deployed = { ...wallet.deployed, [statusResult.status.chainId]: true };
    updateSendAvailability();
  }

  renderStatus(statusResult.status);
}

/**
 * A failed status check (#1112): its error, and Try again. Main's copy
 * for an unverified answer tells the user to try again.
 */
function renderStatusError(message) {
  render(`
    <div class="safe-status-text">${escapeHtml(message)}</div>
    <button type="button" class="safe-status-btn" id="safe-status-retry">Try again</button>
  `);
  document.getElementById('safe-status-retry')?.addEventListener('click', retryStatusCheck);
}

function retryStatusCheck() {
  if (statusCheck) return; // a check is already running
  return checkSafeStatus(() => {
    const button = document.getElementById('safe-status-retry');
    if (button) {
      button.disabled = true;
      button.textContent = 'Checking…';
    }
  });
}

function renderStatus(status) {
  if (status.deployed) {
    card.classList.add('hidden');
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
  document
    .getElementById('safe-status-activate')
    ?.addEventListener('click', () => handleActivate());
}

/**
 * The executor's activation fee, stopped by the fee check (design 0005,
 * A): shown, and signed only once the user confirms it.
 */
function renderFeeAsk(walletIndex, ask) {
  const lines = describeFeeCheck(ask.feeCheck, 'xDAI');
  // The core's fee above the threshold, pressed once: asked again.
  if (ask.askAgain) lines.push(FEE_CHECK.askAgain.replace(/\.$/, ''));
  const confirm = ask.askAgain ? FEE_CHECK.sendAnyway : FEE_CHECK.confirmActivate;
  render(`
    <div class="safe-status-text">
      <strong>${escapeHtml(FEE_CHECK.confirmFee)}.</strong>
      ${lines.map((line) => `${escapeHtml(line)}.`).join(' ')}
    </div>
    <button type="button" class="safe-status-btn primary" id="safe-status-confirm-fee">${escapeHtml(confirm)}</button>
    <button type="button" class="safe-status-btn" id="safe-status-cancel-fee">Cancel</button>
    <div class="unlock-error hidden" id="safe-status-error"></div>
  `);
  document
    .getElementById('safe-status-confirm-fee')
    ?.addEventListener('click', () => confirmActivationFee(walletIndex, ask));
  document
    .getElementById('safe-status-cancel-fee')
    ?.addEventListener('click', () => refreshSafeStatusCard());
}

async function confirmActivationFee(walletIndex, ask) {
  // Another account since the fee was shown: its card is shown instead.
  if (walletRecord()?.index !== walletIndex) return refreshSafeStatusCard();
  const button = document.getElementById('safe-status-confirm-fee');
  if (button) {
    button.disabled = true;
    button.textContent = 'Activating…';
  }
  // The core's fee: the ID of the ask main holds goes back, and main checks
  // it before the core sends the transaction it offered.
  if (typeof ask.feeAskId === 'string') return handleActivate({ feeAskId: ask.feeAskId });
  let feeConfirmation;
  try {
    feeConfirmation = await confirmOfferedFee(ask.offer, ask.feeCheck);
  } catch (err) {
    if (err?.code === FEE_CHECK_ASK_AGAIN && err.feeCheck) {
      // Newly above the threshold at the press: shown, and asked again.
      renderFeeAsk(walletIndex, { ...ask, feeCheck: err.feeCheck });
      return;
    }
    await refreshSafeStatusCard();
    showInlineError(document.getElementById('safe-status-error'), err?.message);
    return;
  }
  return handleActivate({ feeConfirmation });
}

/**
 * `options`: `{ feeConfirmation }`, the user's confirmation of the
 * executor's fee that the fee check stopped for, or, on the core's Safe
 * backend, `{ feeAskId }`, the ask whose fee the card confirmed
 * (confirmActivationFee).
 */
async function handleActivate(options) {
  const wallet = walletRecord();
  if (!wallet) return;

  const button = document.getElementById('safe-status-activate');
  if (button) {
    button.disabled = true;
    button.textContent = 'Activating…';
  }

  const result = await (options
    ? window.wallet.activateSafe(wallet.index, options)
    : window.wallet.activateSafe(wallet.index));

  // The executor's fee needs the user: nothing was signed.
  if (!result.success && result.code === FEE_CHECK_NEEDS_CONFIRMATION && result.offer) {
    renderFeeAsk(wallet.index, { feeCheck: result.feeCheck, offer: result.offer });
    return;
  }
  // The core's fee, with the approvals document off: the card confirms it.
  if (
    !result.success &&
    result.code === FEE_CHECK_NEEDS_CONFIRMATION &&
    typeof result.feeAskId === 'string'
  ) {
    renderFeeAsk(wallet.index, {
      feeCheck: result.feeCheck,
      feeAskId: result.feeAskId,
      askAgain: result.feeAskAgain === true,
    });
    return;
  }

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

  await refreshSafeStatusCard(); // re-render first, then surface errors on it
  if (!result.success && result.code !== 'VAULT_LOCKED') {
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
