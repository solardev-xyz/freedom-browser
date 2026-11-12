/**
 * Safe signing board — the "collect signatures" subscreen.
 *
 * Collecting owner signatures is a task the user completes at their own
 * pace, possibly across days and app restarts: each owner row carries
 * its own action ("Sign with Ledger", "Show QR code") that the user
 * taps when the device is actually in hand. A failed or rejected
 * attempt is a ROW state; the transaction itself just keeps waiting.
 * Closing the board parks it (persisted main-side); the account status
 * card is the way back in.
 *
 * Free signatures stay free: unsigned mnemonic owners are collected
 * silently when the board opens (vault unlocked). The moment the
 * threshold is met the board executes automatically — the user already
 * approved the send on the review screen.
 *
 * The board serves two kinds of pending item behind one UX:
 *  - 'send'    — a SafeTx (persisted main-side, finalized by on-chain
 *                execution, leaveable/resumable);
 *  - 'message' — a page's EIP-1271 signing session (in-memory, finalized
 *                when the threshold is met and main returns the combined
 *                signature to the page; closing the board cancels the
 *                request, because a page's request can't be parked).
 *
 * From freedom-core design 0011 PRQ-5a a page's Safe message is main's: main
 * opens the session on the user's approval or the site's rule and, when a
 * device owner must sign, shows the board as its prompt (`eth.safe_message`,
 * through page-prompts.js). The board collects the signatures with the
 * session's token as before; once the threshold is met it answers the
 * handle, and main completes the session and answers the page. Closing the
 * board rejects the request. Main hiding the prompt (another tab in front)
 * takes the board down with the session kept, and shows it again later.
 *
 * From PRQ-5b a page's Safe send is main's too: main starts the SafeTx on
 * the user's approval and shows its board as a prompt (`eth.safe_send`).
 * The board signs and executes as before; main hears the SafeTx's outcome
 * itself and answers the page with the execution's hash, or a rejection
 * when it is discarded. Leaving the board parks the SafeTx, as before: it
 * answers the handle, and main keeps the page waiting for the outcome.
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { escapeHtml, truncateAddress, formatRawTokenBalance, walletRecord, timeAgo } from './wallet-utils.js';
import { refreshBalances } from './balance-display.js';
import { showVaultUnlock } from './vault-unlock.js';
import { bindExplorerLink } from './explorer-link.js';
import { registerPagePromptRenderer, pagePromptDisplaced } from '../page-prompt-renderers.js';
import {
  FEE_CHECK,
  FEE_CHECK_ASK_AGAIN,
  FEE_CHECK_NEEDS_CONFIRMATION,
  confirmOfferedFee,
  describeFeeCheck,
} from './fee-check.js';

// DOM references
let screen;
let backBtn;
let titleEl;
let content;

// Board state
let boardSafeIndex = null;
let boardKind = 'send'; // 'send' | 'message'
let messageResolver = null; // {resolve, reject}: the answer to main's prompt
let messageToken = null; // the session's capability token (from start's state)
let state = null; // SafeSendState / SafeMessageState from main
let phase = 'board'; // 'board' | 'executing' | 'success' | 'superseded'
let executed = null; // {hash, explorerUrl} (send mode)
let executeError = null; // {message, needsFunds}
// The executor's fee the fee check stopped for (design 0005, A):
// {feeCheck, offer, busy}. Until the user confirms it, nothing is signed.
let feeAsk = null;
let signingIndex = null; // owner row with a live ceremony
// Main's prompt the board shows (`eth.safe_message` or `eth.safe_send`):
// `{ handle, kind: 'message' | 'send' }`, or null.
let pageBoard = null;
// While the board paints a page prompt, or opens its own vault unlock, the
// hider that runs is its own.
let presentingPagePrompt = false;
let rowNotes = new Map(); // ownerIndex → {kind: 'error'|'info', text}
let ledgerDetected = false;
let ledgerPollTimer = null;

/**
 * Board sessions share the module globals above, but IPC continuations
 * can outlive their session: if a board is abandoned mid-await and a
 * successor opens, the resumed code would settle the successor's promise
 * or write into its state. Every open/abandon bumps the epoch; async
 * paths capture it before awaiting and bail once it has moved on. Only
 * the continuation is fenced — the IPC calls themselves already went out
 * against the right session.
 */
let boardEpoch = 0;

/** Whether a captured epoch belongs to a superseded board session. */
const isStale = (epoch) => epoch !== boardEpoch;

// The IPC surface per board kind — everything else is shared.
const KIND_API = {
  send: {
    state: (safeIndex) => window.wallet.safeState(safeIndex),
    sign: (safeIndex, ownerIndex) => window.wallet.safeSign(safeIndex, ownerIndex),
    cancel: (safeIndex) => window.wallet.safeCancelPending(safeIndex),
  },
  message: {
    state: (safeIndex) => window.wallet.safeMessageState(safeIndex, messageToken),
    sign: (safeIndex, ownerIndex) => window.wallet.safeMessageSign(safeIndex, ownerIndex, messageToken),
    cancel: (safeIndex) => window.wallet.safeMessageCancel(safeIndex, messageToken),
  },
};
const api = () => KIND_API[boardKind];

export function initSafeSigning() {
  screen = document.getElementById('sidebar-safe-signing');
  backBtn = document.getElementById('safe-signing-back');
  titleEl = document.getElementById('safe-signing-title');
  content = document.getElementById('safe-signing-content');

  registerScreenHider(() => {
    const wasVisible = isSafeSigningBoardOpen();
    hideScreen();
    // A page prompt another screen hides stays main's shown prompt: it is
    // told, so it can show again once that screen is done.
    if (wasVisible && !presentingPagePrompt && pageBoard) {
      const { handle } = pageBoard;
      leavePageBoard();
      pagePromptDisplaced(handle);
    }
  });
  backBtn?.addEventListener('click', closeSafeSigning);
  registerPagePromptRenderer('eth.safe_message', {
    show: showPageSafeBoard,
    close: closePageSafeBoard,
    isShowing: shownPageSafeBoard,
  });
  registerPagePromptRenderer('eth.safe_send', {
    show: showPageSafeSendBoard,
    close: closePageSafeBoard,
    isShowing: shownPageSafeBoard,
  });
}

/**
 * Render main's board prompt for a page's Safe send (`page:prompt`, kind
 * `eth.safe_send`): the SafeTx main started, by its Safe, read fresh from
 * main. The caller shows it only while nothing else holds the sidebar
 * (`page-prompts.js`).
 */
export function showPageSafeSendBoard(prompt) {
  const handle = prompt?.handle;
  const safeIndex = prompt?.view?.safeIndex;
  if (typeof handle !== 'string') return;
  if (!Number.isInteger(safeIndex)) {
    decidePageBoard(handle, false);
    return;
  }
  abandonMessageSession();
  boardKind = 'send';
  pageBoard = { handle, kind: 'send' };
  presentingPagePrompt = true;
  try {
    // From main's state: the board may have been shown before.
    openBoard(safeIndex, null);
  } finally {
    presentingPagePrompt = false;
  }
}

/**
 * Render main's board prompt (`page:prompt`, kind `eth.safe_message`): the
 * session main opened for a page's Safe message, by its token. The caller
 * shows it only while nothing else holds the sidebar (`page-prompts.js`).
 */
export function showPageSafeBoard(prompt) {
  const handle = prompt?.handle;
  const safeIndex = prompt?.view?.safeIndex;
  const token = prompt?.view?.state?.token;
  if (typeof handle !== 'string') return;
  if (!Number.isInteger(safeIndex) || typeof token !== 'string') {
    decidePageBoard(handle, false);
    return;
  }
  // A message board already open gives way.
  abandonMessageSession();
  boardKind = 'message';
  pageBoard = { handle, kind: 'message' };
  messageResolver = {
    resolve: () => decidePageBoard(handle, true),
    reject: () => decidePageBoard(handle, false),
  };
  messageToken = token;
  presentingPagePrompt = true;
  try {
    // From main's state, fresh: the board may have been shown before.
    openBoard(safeIndex, null);
  } finally {
    presentingPagePrompt = false;
  }
}

/** Take down main's prompt `handle` (hidden, closed, or refused): the session stays main's. */
export function closePageSafeBoard(handle) {
  if (!pageBoard || pageBoard.handle !== handle) return false;
  // A send executing, or executed: main answered the page from the SafeTx's
  // outcome. The board finishes, and shows its summary.
  if (pageBoard.kind === 'send' && (phase === 'executing' || phase === 'success')) {
    pageBoard = null;
    return true;
  }
  const wasVisible = isSafeSigningBoardOpen();
  leavePageBoard();
  if (wasVisible) {
    hideScreen();
    walletState.identityView?.classList.remove('hidden');
    window.dispatchEvent(new CustomEvent('wallet:safe-signing-closed'));
  }
  return true;
}

/** The page prompt the board shows, or null. */
export function shownPageSafeBoard() {
  return pageBoard && isSafeSigningBoardOpen() ? pageBoard.handle : null;
}

// The board leaves main's prompt without answering it: its continuations
// are fenced, and nothing of the session is cancelled here.
function leavePageBoard() {
  boardEpoch += 1;
  pageBoard = null;
  messageResolver = null;
  messageToken = null;
  signingIndex = null;
}

async function decidePageBoard(handle, approve) {
  if (pageBoard?.handle === handle) pageBoard = null;
  try {
    await window.pagePrompts?.decide?.(handle, approve, {});
  } catch (err) {
    console.error('[SafeSigning] The decision did not reach main:', err);
  }
}

/** Whether the board subscreen is currently up (any kind). */
export function isSafeSigningBoardOpen() {
  return Boolean(screen) && !screen.classList.contains('hidden');
}

/**
 * The board is a single slot: opening it over a live message session
 * would leave main's prompt unanswered — settle it first.
 */
function abandonMessageSession() {
  if (boardKind !== 'message' || !messageResolver) return;
  KIND_API.message.cancel(boardSafeIndex);
  settleMessage('reject', { code: 4001, message: 'User rejected the request' });
}

/**
 * Open (or re-open) the board for a safe's pending transaction.
 * `initialState` seeds the board when the caller just created the
 * pending item (its start call already swept the free signatures).
 */
export async function openSafeSigningBoard(safeIndex, initialState = null) {
  abandonMessageSession();
  boardKind = 'send';
  await openBoard(safeIndex, initialState);
}

async function openBoard(safeIndex, initialState) {
  const epoch = ++boardEpoch; // a new session — fence the previous one's continuations
  boardSafeIndex = safeIndex;
  phase = 'board';
  executed = null;
  executeError = null;
  feeAsk = null;
  signingIndex = null;
  rowNotes = new Map();

  // The board may be entered from another subscreen (dApp approval,
  // pending list) — it replaces whatever was up.
  hideAllSubscreens();
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');

  if (initialState) {
    // Fresh from the caller's start call — the opening refresh and
    // free-signature sweep would be IPC no-ops.
    state = initialState;
    if (state.status === 'superseded') phase = 'superseded';
  } else {
    await refreshState();
    if (isStale(epoch)) return;
  }
  if (!state) {
    // nothing pending (e.g. discarded elsewhere) — nothing to show
    closeSafeSigning();
    return;
  }
  render();
  startLedgerDetection();
  await (initialState ? maybeFinalize() : progressAutomatics());
}

export function closeSafeSigning() {
  if (!screen || screen.classList.contains('hidden')) return;
  if (signingIndex !== null || phase === 'executing') return; // busy — see render() note
  if (pageBoard?.kind === 'send') {
    // Leaving a page's send board parks the SafeTx: main keeps the page
    // waiting for its outcome.
    const { handle } = pageBoard;
    pageBoard = null;
    decidePageBoard(handle, false);
  }
  if (boardKind === 'message' && messageResolver) {
    // Closing a message board abandons the dApp's request: drop the
    // session and answer the dApp with a rejection.
    api().cancel(boardSafeIndex);
    settleMessage('reject', { code: 4001, message: 'User rejected the request' });
  }
  hideScreen();
  walletState.identityView?.classList.remove('hidden');
  window.dispatchEvent(new CustomEvent('wallet:safe-signing-closed'));
  if (executed) {
    setTimeout(() => refreshBalances(), 3000);
  }
}

/** Answer main's prompt exactly once. */
function settleMessage(outcome, value) {
  if (!messageResolver) return;
  const { resolve, reject } = messageResolver;
  messageResolver = null;
  messageToken = null;
  (outcome === 'resolve' ? resolve : reject)(value);
}

function hideScreen() {
  stopLedgerDetection();
  screen?.classList.add('hidden');
}

async function refreshState() {
  const epoch = boardEpoch;
  const result = await api().state(boardSafeIndex);
  if (isStale(epoch)) return;
  state = result.success ? result.state : null;
  if (state?.status === 'superseded') phase = 'superseded';
}

/**
 * Walk the user through the standard vault unlock (a locked vault is a
 * step, not an error). The unlock screen replaces the board; bring the
 * board back either way.
 * @returns {Promise<boolean>} whether the vault is now unlocked
 */
async function requestVaultUnlock() {
  const epoch = boardEpoch;
  let unlocked = true;
  try {
    // The board's own step: its hider isn't another screen taking over.
    let unlock;
    presentingPagePrompt = true;
    try {
      unlock = showVaultUnlock('Your multi-owner transaction');
    } finally {
      presentingPagePrompt = false;
    }
    await unlock;
  } catch {
    unlocked = false; // user cancelled
  }
  if (isStale(epoch)) return false;
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  render();
  return unlocked;
}

/** Silent free signatures (main owns the policy) + finalize if ready. */
async function progressAutomatics() {
  if (!state || phase !== 'board') return;
  const epoch = boardEpoch;
  if (state.collected < state.threshold) {
    const result = await api().sign(boardSafeIndex); // free-signature sweep
    if (isStale(epoch)) return;
    if (result.success) {
      state = result.state;
      render();
    }
  }
  await maybeFinalize();
}

/**
 * The single decision site for finalization (executing a send /
 * completing a message): threshold met, board idle, and no unresolved
 * finalization error (its banner owns the retry).
 */
async function maybeFinalize() {
  if (
    state &&
    phase === 'board' &&
    !executeError &&
    !feeAsk &&
    state.collected >= state.threshold
  ) {
    await (boardKind === 'message' ? completeNow() : executeNow());
  }
}

// --- signing ---------------------------------------------------------------

async function signOwner(ownerIndex) {
  if (signingIndex !== null || phase !== 'board') return;
  const epoch = boardEpoch;
  signingIndex = ownerIndex;
  rowNotes.delete(ownerIndex);
  render();

  const result = await api().sign(boardSafeIndex, ownerIndex);
  if (isStale(epoch)) return;
  signingIndex = null;

  if (result.success) {
    state = result.state;
    render();
    await maybeFinalize();
    return;
  }

  if (result.code === 'VAULT_LOCKED') {
    const unlocked = await requestVaultUnlock();
    if (isStale(epoch)) return;
    if (unlocked) {
      return signOwner(ownerIndex);
    }
    rowNotes.set(ownerIndex, { kind: 'info', text: 'Unlock your wallet to sign' });
    render();
    return;
  }

  const note = describeRowFailure(result);
  if (note) rowNotes.set(ownerIndex, note);
  await refreshState();
  if (isStale(epoch)) return;
  render();
  // A failed Ledger attempt may mean it was unplugged again — re-probe.
  if (walletRecord(ownerIndex)?.type === 'ledger') {
    startLedgerDetection();
  }
}

/**
 * A rejection is a decision, not an error — the row returns to waiting
 * with a quiet note (or none for a closed QR). Everything else keeps
 * main's curated error message with error styling.
 */
function describeRowFailure(result) {
  if (result.code === 'LEDGER_USER_REJECTED' || result.code === 'REMOTE_USER_REJECTED') {
    return { kind: 'info', text: 'Declined on the device' };
  }
  if (result.code === 'REMOTE_USER_CANCELLED') {
    return null; // QR closed — plain return to waiting
  }
  return { kind: 'error', text: result.error || 'Signing failed — try again' };
}

// --- finalizing ------------------------------------------------------------

/**
 * Message finalization: the threshold is met, so the board answers main's
 * prompt and closes — main completes the session and hands the combined
 * signature to the page, and the page reacting IS the success feedback.
 */
function completeNow() {
  phase = 'success'; // past the busy guard in closeSafeSigning
  settleMessage('resolve', null);
  closeSafeSigning();
}

/**
 * `feeConfirmation`: the user's confirmation of the executor's fee that
 * the fee check stopped for (confirmFee). Without it, main judges a new
 * quote, and a fee that needs the user stops the execution here, with
 * nothing signed and the transaction kept.
 */
async function executeNow(feeConfirmation) {
  const epoch = boardEpoch;
  phase = 'executing';
  executeError = null;
  feeAsk = null;
  render();

  const result = await (feeConfirmation
    ? window.wallet.safeExecute(boardSafeIndex, { feeConfirmation })
    : window.wallet.safeExecute(boardSafeIndex));
  if (isStale(epoch)) return;
  if (result.success && result.state?.status === 'executed') {
    state = result.state; // pre-clear snapshot — display survives for the summary
    executed = result.state.executed;
    phase = 'success';
    // dApp-initiated sends await this to hand the tx hash back.
    window.dispatchEvent(
      new CustomEvent('wallet:safe-executed', {
        detail: { safeIndex: boardSafeIndex, safeTxHash: state.safeTxHash, hash: executed.hash },
      })
    );
  } else if (result.success && result.state?.status === 'superseded') {
    state = result.state;
    phase = 'superseded';
  } else if (result.code === 'VAULT_LOCKED') {
    // The executor signs with the vault key — unlocking is a step in
    // the flow, not a failure.
    phase = 'board';
    await refreshState();
    if (isStale(epoch)) return;
    const unlocked = await requestVaultUnlock();
    if (isStale(epoch)) return;
    if (unlocked) {
      return executeNow();
    }
    executeError = {
      message: 'Your wallet is locked — unlock it to execute the transaction',
      needsFunds: false,
    };
  } else if (result.code === FEE_CHECK_NEEDS_CONFIRMATION && result.offer) {
    // The executor's fee needs the user: shown, and signed only once they
    // confirm it.
    feeAsk = { feeCheck: result.feeCheck, offer: result.offer, busy: false };
    phase = 'board';
    await refreshState();
    if (isStale(epoch)) return;
  } else {
    executeError = {
      message: result.error || 'Execution failed',
      needsFunds: result.code === 'SAFE_NEEDS_FUNDS',
    };
    phase = 'board';
    await refreshState();
    if (isStale(epoch)) return;
  }
  render();
}

/** The user confirms the executor's fee: it is signed with exactly that fee. */
async function confirmFee() {
  if (!feeAsk || feeAsk.busy || phase !== 'board') return;
  const epoch = boardEpoch;
  const ask = feeAsk;
  ask.busy = true;
  render();
  let feeConfirmation;
  try {
    feeConfirmation = await confirmOfferedFee(ask.offer, ask.feeCheck);
  } catch (err) {
    if (isStale(epoch)) return;
    ask.busy = false;
    if (err?.code === FEE_CHECK_ASK_AGAIN && err.feeCheck) {
      // Newly above the threshold at the press: shown, and asked again.
      ask.feeCheck = err.feeCheck;
    } else {
      feeAsk = null;
      executeError = { message: err?.message || 'Execution failed', needsFunds: false };
    }
    render();
    return;
  }
  if (isStale(epoch)) return;
  await executeNow(feeConfirmation);
}

async function handleDiscard() {
  if (signingIndex !== null || phase === 'executing') return;
  if (boardKind === 'send') {
    // Parked sends survive for days — discarding one deserves a pause.
    const what = summaryLine();
    if (!confirm(`Discard ${what}?\n\nThe collected signatures will be deleted — devices that already signed would need to sign again.`)) {
      return;
    }
    const epoch = boardEpoch;
    const result = await window.wallet.safeCancelPending(boardSafeIndex);
    if (isStale(epoch) || !result.success) return;
    // A page's send: main heard the discard itself, and answers the page.
    if (pageBoard?.kind === 'send') pageBoard = null;
    window.dispatchEvent(
      new CustomEvent('wallet:safe-discarded', {
        detail: { safeIndex: boardSafeIndex, safeTxHash: state?.safeTxHash },
      })
    );
    state = null;
    closeSafeSigning();
    return;
  }
  // Message sessions die with their request anyway — no confirm; the
  // close path cancels the session and rejects the dApp.
  state = null;
  closeSafeSigning();
}

// --- warm Ledger detection ---------------------------------------------------

function hasUnsignedLedgerRow() {
  return Boolean(state?.owners.some((owner) => owner.type === 'ledger' && !owner.signed));
}

function startLedgerDetection() {
  stopLedgerDetection();
  const epoch = boardEpoch;
  const tick = async () => {
    ledgerPollTimer = null;
    if (isStale(epoch) || phase !== 'board' || !hasUnsignedLedgerRow()) return;
    if (signingIndex === null) {
      const result = await window.ledger.getAccounts({ scheme: 'live', start: 0, count: 1 });
      if (isStale(epoch)) return;
      if (result.success) {
        // Detected — highlight the row and stop probing (the transport
        // shouldn't be poked more than needed; a failed Ledger signing
        // attempt restarts detection).
        ledgerDetected = true;
        render();
        return;
      }
    }
    ledgerPollTimer = setTimeout(tick, 2000);
  };
  if (hasUnsignedLedgerRow()) ledgerPollTimer = setTimeout(tick, 0);
}

function stopLedgerDetection() {
  if (ledgerPollTimer) {
    clearTimeout(ledgerPollTimer);
    ledgerPollTimer = null;
  }
  ledgerDetected = false;
}

// --- rendering ---------------------------------------------------------------

function ownerName(index) {
  return walletRecord(index)?.name || `Account ${index}`;
}

export function summaryLine(display = state?.display) {
  const d = display || {};
  if (d.kind === 'message') {
    const what = d.method === 'personal_sign' ? 'a message' : 'a signing request';
    return `signing ${what} for ${d.site || 'a connected app'}`;
  }
  // dApp-initiated transactions name the requesting site.
  const suffix = d.site ? ` — requested by ${d.site}` : '';
  if (d.label) {
    // Arbitrary calldata has no amount/recipient to format — the dApp
    // flow pre-composes the line instead.
    return d.label + suffix;
  }
  // Entries persisted before presentation fields existed carry only the
  // atomic amount — format it instead of showing raw wei.
  const amount =
    d.formattedAmount ||
    (d.amount ? formatRawTokenBalance(d.amount, d.decimals ?? 18) : '');
  const symbol = d.symbol || (d.asset ? '' : 'xDAI');
  const to = d.recipientName || truncateAddress(d.toAddress || '');
  return `sending ${amount} ${symbol} to ${to}${suffix}`.replace(/\s+/g, ' ').trim();
}

function render() {
  if (!content) return;

  if (phase === 'success') {
    renderSuccess();
    return;
  }
  if (phase === 'superseded') {
    renderSuperseded();
    return;
  }
  if (!state) return;

  const executorName = state.executorIndex !== null ? ownerName(state.executorIndex) : null;
  const total = state.owners.length;
  const thresholdNote =
    total > state.threshold
      ? `any ${state.threshold} of the ${total} owners can sign`
      : `all ${state.threshold} owners must sign`;
  const busy = phase === 'executing';

  if (titleEl) titleEl.textContent = busy ? 'Executing transaction' : 'Collect signatures';
  if (backBtn) backBtn.classList.toggle('hidden', busy || signingIndex !== null);

  content.innerHTML = `
    <div class="safe-signing-summary">
      <div class="safe-signing-what">${escapeHtml(capitalize(summaryLine()))}</div>
      <div class="safe-signing-meta">
        from ${escapeHtml(walletRecord(boardSafeIndex)?.name || 'Safe account')} ·
        started ${escapeHtml(timeAgo(new Date(state.createdAt)).toLowerCase())}
      </div>
    </div>

    <div class="safe-signing-counter">
      <strong>${state.collected} of ${state.threshold} signatures</strong> — ${escapeHtml(thresholdNote)}.
    </div>

    <div class="safe-signing-rows">${state.owners.map(renderRow).join('')}</div>

    ${busy ? `
      <div class="safe-signing-executing">
        <span class="connect-ledger-status-spinner"></span>
        Executing — broadcast by ${escapeHtml(executorName || 'an owner account')}…
      </div>
    ` : `
      ${executeError ? renderExecuteError() : ''}
      ${feeAsk ? renderFeeAsk() : ''}
      ${boardKind === 'message' ? `
        <div class="safe-signing-note">
          No transaction is sent — once enough owners have signed, the
          combined signature goes back to the app.
        </div>
      ` : `
        <div class="safe-signing-note">
          Network fee is paid by ${escapeHtml(executorName || 'an owner account')} when the
          transaction executes${state.collected >= state.threshold ? '' : ' — it executes automatically after the last signature'}.
        </div>
        <div class="safe-signing-note">
          You can leave this screen: the transaction keeps waiting and can be
          continued from the account card anytime.
        </div>
      `}
      <button type="button" class="safe-status-btn safe-signing-discard" id="safe-signing-discard"
        ${signingIndex !== null ? 'disabled' : ''}>${boardKind === 'message' ? 'Cancel request' : 'Discard transaction'}</button>
    `}
  `;

  content.querySelectorAll('[data-sign-owner]').forEach((button) => {
    button.addEventListener('click', () => signOwner(Number(button.dataset.signOwner)));
  });
  document.getElementById('safe-signing-discard')?.addEventListener('click', handleDiscard);
  document
    .getElementById('safe-signing-retry-execute')
    ?.addEventListener('click', boardKind === 'message' ? completeNow : () => executeNow());
  document.getElementById('safe-signing-confirm-fee')?.addEventListener('click', confirmFee);
}

function renderRow(owner) {
  const name = escapeHtml(ownerName(owner.index));
  const note = rowNotes.get(owner.index);
  const thresholdMet = state.collected >= state.threshold;
  const isSigning = signingIndex === owner.index;

  let stateHtml;
  if (owner.signed) {
    stateHtml = '<span class="safe-signing-row-state signed">✓ Signed</span>';
  } else if (isSigning) {
    stateHtml = '<span class="safe-signing-row-state"><span class="connect-ledger-status-spinner"></span> Waiting…</span>';
  } else if (thresholdMet) {
    stateHtml = '<span class="safe-signing-row-state muted">Not needed</span>';
  } else {
    stateHtml = renderRowAction(owner);
  }

  const typeLabel = { ledger: 'Ledger', remote: 'Phone', mnemonic: 'This browser' }[owner.type] || '';
  return `
    <div class="safe-signing-row ${owner.signed ? 'signed' : ''} ${isSigning ? 'signing' : ''}">
      <div class="safe-signing-row-info">
        <span class="safe-signing-row-name">${name}</span>
        <span class="safe-signing-row-type">${typeLabel}</span>
        ${note?.text ? `<span class="safe-signing-row-note ${note.kind}">${escapeHtml(note.text)}</span>` : ''}
      </div>
      ${stateHtml}
    </div>
  `;
}

function renderRowAction(owner) {
  const disabled = signingIndex !== null ? 'disabled' : '';
  if (owner.type === 'ledger') {
    const label = ledgerDetected ? 'Ledger detected — sign now' : 'Sign with Ledger';
    return `<button type="button" class="safe-status-btn ${ledgerDetected ? 'primary' : ''}"
      data-sign-owner="${owner.index}" ${disabled}>${label}</button>`;
  }
  if (owner.type === 'remote') {
    return `<button type="button" class="safe-status-btn" data-sign-owner="${owner.index}" ${disabled}>Show QR code</button>`;
  }
  return `<button type="button" class="safe-status-btn" data-sign-owner="${owner.index}" ${disabled}>Sign</button>`;
}

function renderExecuteError() {
  const hint = executeError.needsFunds
    ? 'Add xDAI to that account, then try again — the signatures are kept.'
    : 'The signatures are kept — you can try again.';
  return `
    <div class="safe-signing-banner">
      <div>${escapeHtml(executeError.message)}</div>
      <div class="safe-signing-banner-hint">${escapeHtml(hint)}</div>
      <button type="button" class="safe-status-btn primary" id="safe-signing-retry-execute">
        ${executeError.needsFunds ? "I've added funds — try again" : 'Try again'}
      </button>
    </div>
  `;
}

/** The executor's fee, waiting for the user's confirmation (design 0005, A). */
function renderFeeAsk() {
  const lines = describeFeeCheck(feeAsk.feeCheck, 'xDAI');
  const warning = feeAsk.feeCheck?.above ? ' warning' : '';
  return `
    <div class="safe-signing-banner safe-signing-fee${warning}">
      <div><strong>${escapeHtml(FEE_CHECK.confirmFee)}</strong></div>
      ${lines.map((line) => `<div class="safe-signing-banner-hint">${escapeHtml(line)}</div>`).join('')}
      <button type="button" class="safe-status-btn primary" id="safe-signing-confirm-fee"
        ${feeAsk.busy ? 'disabled' : ''}>${escapeHtml(FEE_CHECK.confirmExecute)}</button>
    </div>
  `;
}

function renderSuccess() {
  if (titleEl) titleEl.textContent = 'Transaction sent';
  if (backBtn) backBtn.classList.remove('hidden');
  content.innerHTML = `
    <div class="create-wallet-success-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="8 12 11 15 16 9"/>
      </svg>
    </div>
    <h4 class="create-wallet-success-title">Sent!</h4>
    <p class="create-wallet-message">${escapeHtml(capitalize(summaryLine()))}.</p>
    ${executed?.explorerUrl ? `
      <a href="${escapeHtml(executed.explorerUrl)}" target="_blank" rel="noreferrer"
         class="recent-payments-link" id="safe-signing-explorer-link">View on explorer →</a>
    ` : ''}
    <button type="button" class="create-wallet-done-btn" id="safe-signing-done">Done</button>
  `;
  document.getElementById('safe-signing-done')?.addEventListener('click', closeSafeSigning);
  // Open in a tab, like the Send screen's explorer link: the chrome window
  // denies every popup of its own (docs/security-audit-electron.md, E-2), so
  // a bare target="_blank" here would do nothing — for a click or a
  // middle-click alike (see explorer-link.js).
  bindExplorerLink(
    document.getElementById('safe-signing-explorer-link'),
    () => executed?.explorerUrl,
    // Loaded on use: a static import would pull the whole tab strip into
    // this module (and its tests) for one link.
    (url, options) => import('../tabs.js').then(({ createTab }) => createTab(url, options))
  );
}

function renderSuperseded() {
  if (titleEl) titleEl.textContent = 'Transaction outdated';
  if (backBtn) backBtn.classList.remove('hidden');
  content.innerHTML = `
    <div class="safe-signing-summary">
      <div class="safe-signing-what">${escapeHtml(capitalize(summaryLine()))}</div>
    </div>
    <div class="safe-signing-banner">
      <div>
        This transaction can no longer be executed — the account has
        processed another transaction since it was created (possibly this
        one, from an earlier attempt).
      </div>
      <div class="safe-signing-banner-hint">
        Check your payment history; if the send isn't there, discard this
        and start again.
      </div>
      <button type="button" class="safe-status-btn" id="safe-signing-discard">Discard transaction</button>
    </div>
  `;
  document.getElementById('safe-signing-discard')?.addEventListener('click', handleDiscard);
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
