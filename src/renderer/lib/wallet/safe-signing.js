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
 *  - 'message' — a dApp EIP-1271 signing session (in-memory, finalized
 *                by returning the combined signature to the waiting
 *                dApp; closing the board cancels the request, because a
 *                dApp promise can't be parked).
 */

import { walletState, registerScreenHider, hideAllSubscreens } from './wallet-state.js';
import { escapeHtml, truncateAddress, formatRawTokenBalance, walletRecord, timeAgo } from './wallet-utils.js';
import { refreshBalances } from './balance-display.js';
import { showVaultUnlock } from './vault-unlock.js';

// DOM references
let screen;
let backBtn;
let titleEl;
let content;

// Board state
let boardSafeIndex = null;
let boardKind = 'send'; // 'send' | 'message'
let messageResolver = null; // {resolve, reject} of the waiting dApp request
let messageToken = null; // the session's capability token (from start's state)
let messageOwner = null; // opaque token for the requesting document (its webview)
let state = null; // SafeSendState / SafeMessageState from main
let phase = 'board'; // 'board' | 'executing' | 'success' | 'superseded'
let executed = null; // {hash, explorerUrl} (send mode)
let executeError = null; // {message, needsFunds}
let signingIndex = null; // owner row with a live ceremony
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

  registerScreenHider(() => hideScreen());
  backBtn?.addEventListener('click', closeSafeSigning);
}

/** Whether the board subscreen is currently up (any kind). */
export function isSafeSigningBoardOpen() {
  return Boolean(screen) && !screen.classList.contains('hidden');
}

/**
 * The board is a single slot: opening it over a live message session
 * would silently drop the waiting dApp promise — settle it first.
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

/**
 * Open the board for a dApp SafeMessage session (already started
 * main-side; pass its state as `initialState`). Resolves with the
 * combined EIP-1271 signature when the threshold is met, rejects with
 * an EIP-1193 user-rejection when the user closes or cancels the
 * board — a waiting dApp can't be parked. `owner` identifies the
 * requesting document (its webview), so the board can be withdrawn when
 * that document goes away (see abandonSafeMessageBoard).
 */
export function openSafeMessageBoard(safeIndex, initialState = null, owner = null) {
  return new Promise((resolve, reject) => {
    abandonMessageSession();
    boardKind = 'message';
    messageResolver = { resolve, reject };
    messageToken = initialState?.token ?? null;
    messageOwner = owner;
    openBoard(safeIndex, initialState);
  });
}

/**
 * Withdraw the message board when the document that requested the
 * signature navigates away or its webview dies — called by the dApp
 * provider from the same invalidation seam that suppresses the in-flight
 * response (mirrors radicle-consent's owner-scoped dismissal). Main has
 * already discarded the session and the provider drops the rejection, so
 * this is chrome cleanup: settle the promise, stop the Ledger probing,
 * take the screen down. The busy guard in closeSafeSigning doesn't apply
 * — nothing on the board can succeed once its session is gone. Owner-
 * scoped: a board opened by a successor document (or another tab) is
 * left alone.
 */
export function abandonSafeMessageBoard(owner) {
  if (boardKind !== 'message' || !messageResolver || !owner || messageOwner !== owner) return;
  boardEpoch += 1; // fence the session's in-flight continuations
  api().cancel(boardSafeIndex); // best effort — main usually dropped it already
  settleMessage('reject', { code: 4001, message: 'User rejected the request' });
  if (!screen || screen.classList.contains('hidden')) return;
  signingIndex = null;
  hideScreen();
  walletState.identityView?.classList.remove('hidden');
  window.dispatchEvent(new CustomEvent('wallet:safe-signing-closed'));
}

async function openBoard(safeIndex, initialState) {
  const epoch = ++boardEpoch; // a new session — fence the previous one's continuations
  boardSafeIndex = safeIndex;
  phase = 'board';
  executed = null;
  executeError = null;
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

/** Answer the waiting dApp exactly once. */
function settleMessage(outcome, value) {
  if (!messageResolver) return;
  const { resolve, reject } = messageResolver;
  messageResolver = null;
  messageToken = null;
  messageOwner = null;
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
    await showVaultUnlock('Your multi-owner transaction');
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
  if (state && phase === 'board' && !executeError && state.collected >= state.threshold) {
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
 * Message finalization: hand the combined signature to the waiting dApp
 * and close the board — the dApp reacting IS the success feedback.
 * Purely local (no broadcast), so failures are rare — but they get the
 * same banner-with-retry treatment as execution failures.
 */
async function completeNow() {
  const epoch = boardEpoch;
  const result = await window.wallet.safeMessageComplete(boardSafeIndex, messageToken);
  if (isStale(epoch)) return;
  if (result.success) {
    phase = 'success'; // past the busy guard in closeSafeSigning
    settleMessage('resolve', result.signature);
    closeSafeSigning();
    return;
  }
  executeError = { message: result.error || 'Signing failed', needsFunds: false };
  await refreshState();
  if (isStale(epoch)) return;
  render();
}

async function executeNow() {
  const epoch = boardEpoch;
  phase = 'executing';
  executeError = null;
  render();

  const result = await window.wallet.safeExecute(boardSafeIndex);
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
    ?.addEventListener('click', boardKind === 'message' ? completeNow : executeNow);
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
         class="recent-payments-link">View on explorer →</a>
    ` : ''}
    <button type="button" class="create-wallet-done-btn" id="safe-signing-done">Done</button>
  `;
  document.getElementById('safe-signing-done')?.addEventListener('click', closeSafeSigning);
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
