/**
 * Payments waiting: the held payments (the wallet's intent records,
 * freedom-core design 0005 "Retrying an intent") that no receipt has
 * confirmed yet, across all accounts, each naming its account, as the
 * unfinished Safe transactions are (safe-pending-list.js).
 *
 * A row above "Recent payments" counts them (hidden when none) and opens a
 * list where each can be:
 * - sent again: the same signed bytes, at their one nonce, so it can only
 *   be paid once. A payment the user started is sent at the press; one a
 *   dApp requested first asks once more, naming the site and when, since
 *   the site's request may have moved on;
 * - replaced at its nonce with a higher fee, when that is the fix (a
 *   refusal over fees) or as a speed-up for one that may be stuck;
 * - closed by hand, once it is shown as Couldn't confirm (its label
 *   couldn't be read on chain for a day, design 0005 "State history") and
 *   the network shows its place in the queue used: none of its
 *   transactions can go through then, so it is offered neither of the
 *   above. Such a payment lists its hashes, each with an explorer link,
 *   and closing it asks once more, saying that closing proves nothing
 *   about whether it paid.
 *
 * Each is authorized in main by a confirmation of the held payment itself
 * ('intent-resend', 'intent-replace', 'intent-close'), minted at the
 * user's press.
 *
 * `waitingPaymentBehind(chainId, sender)` serves the send review's warning
 * (D11).
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import {
  escapeHtml,
  timeAgo,
  truncateAddress,
  accountType,
  signingButtonLabel,
  walletRecord,
} from './wallet-utils.js';
import { confirmSigning } from './signing-confirmation.js';
import { resendHeldPayment } from './intent-resend.js';
import {
  beginSignatureFlight,
  endSignatureFlight,
  isSignatureInFlight,
} from './signature-flight.js';
import { bindExplorerLink } from './explorer-link.js';
import {
  attentionText,
  outcomeText,
  ACTIONS,
  COULDNT_CONFIRM,
  HELD,
  REPLACE,
} from './intent-texts.js';

const ERC20_TRANSFER = '0xa9059cbb';
// Where a held payment leaves a gap later sends wait behind (D11).
const GAP_ATTENTION = new Set(['refused', 'not-sent', 'absent', 'pending']);

let row;
let rowLabel;
let countBadge;
let screen;
let messageEl;
let listEl;
// The waiting payments, as last listed.
let waiting = [];
// The one payment with a step open: { intentId, step: 'resend'|'replace'|
// 'close', fees?, busy?, note?: { kind, text } }.
let active = null;

export function initHeldPayments() {
  row = document.getElementById('held-payments-row');
  rowLabel = document.getElementById('held-payments-row-label');
  countBadge = document.getElementById('held-payments-count');
  screen = document.getElementById('sidebar-held-payments');
  messageEl = document.getElementById('held-payments-message');
  listEl = document.getElementById('held-payments-list');

  if (rowLabel) rowLabel.textContent = HELD.rowLabel;
  if (messageEl) messageEl.textContent = HELD.message;

  registerScreenHider(() => {
    // Another screen takes the sidebar: an opening still waiting for its
    // list is called off too.
    openRequest += 1;
    screen?.classList.add('hidden');
  });
  row?.addEventListener('click', openHeldPayments);
  document.getElementById('held-payments-back')?.addEventListener('click', closeHeldPayments);
  listEl?.addEventListener('click', onListClick);

  window.wallet.onIntentsChanged?.(() => refreshHeldPayments());
  window.addEventListener('wallet:send-closed', () => refreshHeldPayments());
  window.addEventListener('payments:tx-recorded', () => refreshHeldPayments());

  refreshHeldPayments();
}

/**
 * The held payments no receipt has confirmed yet, by chain and account,
 * oldest nonce first: the order the network takes them in.
 */
export async function listWaitingPayments() {
  let result;
  try {
    result = await window.wallet.intentsList?.();
  } catch {
    return [];
  }
  if (!result?.success) return [];
  return result.intents
    .filter((intent) => !intent.receipt)
    .sort((a, b) => a.chainId - b.chainId || a.sender.localeCompare(b.sender) || a.nonce - b.nonce);
}

/**
 * The earliest waiting payment of `sender` on `chainId` that leaves a gap
 * a new send would wait behind (refused, never sent, or recovered with its
 * fate unknown), or null. Not one whose place in the queue the network
 * shows used (a closable Couldn't confirm): nothing waits behind it.
 */
export async function waitingPaymentBehind(chainId, sender) {
  const account = String(sender || '').toLowerCase();
  const payments = await listWaitingPayments();
  return (
    payments.find(
      (payment) =>
        payment.chainId === Number(chainId) &&
        payment.sender === account &&
        GAP_ATTENTION.has(payment.attention) &&
        !payment.couldntConfirm?.closable
    ) ?? null
  );
}

export async function refreshHeldPayments() {
  waiting = await listWaitingPayments();
  if (active && !waiting.some((payment) => payment.intentId === active.intentId)) active = null;
  row?.classList.toggle('hidden', waiting.length === 0);
  if (countBadge) countBadge.textContent = String(waiting.length);
  if (screen && !screen.classList.contains('hidden')) render();
}

// Which request to open the list is current: a late list reply for an
// earlier one, or for one another screen overtook, opens nothing.
let openRequest = 0;

/**
 * Open the list from the identity view. Not while a device prompt owns
 * the sidebar (signature-flight.js), and, since the list is fetched first,
 * only if nothing else took the sidebar meanwhile: the request is still
 * the current one, no signature began, and the identity view is still the
 * screen showing.
 */
export async function openHeldPayments() {
  if (isSignatureInFlight()) return;
  openRequest += 1;
  const request = openRequest;
  await refreshHeldPayments();
  if (request !== openRequest || isSignatureInFlight()) return;
  if (walletState.identityView?.classList.contains('hidden')) return;
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  render();
}

export function closeHeldPayments() {
  openRequest += 1;
  if (!screen || screen.classList.contains('hidden')) return;
  // A device prompt we can't recall owns the sidebar (signature-flight.js);
  // a resend under way just finishes in main, and the list refreshes.
  if (isSignatureInFlight()) return;
  active = null;
  screen.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

// An amount in whole units, exact: what a payment pays is never rounded.
function formatUnits(value, decimals) {
  const amount = BigInt(value ?? 0);
  const base = 10n ** BigInt(decimals);
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${amount / base}.${fraction}` : String(amount / base);
}

// A maximum fee in whole units of 18 decimals, rounded up at 9 decimals (a
// gwei): "up to" never understates it.
function formatMaxFee(wei) {
  const gwei = 10n ** 9n;
  return formatUnits(((BigInt(wei) + gwei - 1n) / gwei) * gwei, 18);
}

function chainOf(chainId) {
  return walletState.registeredChains?.[chainId] ?? {};
}

/** What a held payment pays, in words. */
export function describePayment(payment) {
  const fields = payment.fields ?? {};
  const data = String(fields.data ?? '0x').toLowerCase();
  if (data.startsWith(ERC20_TRANSFER) && /^0x[0-9a-f]{136}/.test(data)) {
    const token = Object.values(walletState.registeredTokens ?? {}).find(
      (candidate) =>
        candidate.chainId === payment.chainId &&
        String(candidate.address).toLowerCase() === String(fields.to).toLowerCase()
    );
    const recipient = truncateAddress(`0x${data.slice(34, 74)}`);
    if (token) {
      const amount = formatUnits(BigInt(`0x${data.slice(74, 138)}`), token.decimals);
      return HELD.payment(amount, token.symbol, recipient);
    }
    return HELD.contractCall(truncateAddress(fields.to));
  }
  if (data !== '0x') return HELD.contractCall(truncateAddress(fields.to));
  const symbol = chainOf(payment.chainId).nativeSymbol || 'ETH';
  return HELD.payment(formatUnits(fields.value, 18), symbol, truncateAddress(fields.to));
}

function maxFeeOf(payment, fees) {
  const fee = fees.maxFeePerGas ?? fees.gasPrice;
  return formatMaxFee(BigInt(fee) * BigInt(payment.fields?.gasLimit ?? 0));
}

// Explorer links open in a tab (explorer-link.js); loaded on use, as the
// Safe board's are.
const openTab = (url, options) =>
  import('../tabs.js').then(({ createTab }) => createTab(url, options));

// A hash's explorer link, if main gave one that is a web address.
function explorerUrlOf(payment, index) {
  const url = payment?.couldntConfirm?.hashes?.[index]?.explorerUrl;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

function render() {
  if (!listEl) return;
  listEl.innerHTML = waiting.map(renderPayment).join('');
  // Each explorer link gets its address as a property, never as markup.
  for (const link of listEl.querySelectorAll?.('a[data-explorer]') ?? []) {
    const intentId = link.closest('[data-intent]')?.dataset.intent;
    const payment = waiting.find((candidate) => candidate.intentId === intentId);
    const url = explorerUrlOf(payment, Number(link.dataset.explorer));
    if (url) link.href = url;
    bindExplorerLink(link, () => url, openTab);
  }
}

// A Couldn't confirm payment's hashes, each with its explorer link.
function renderHashes(payment) {
  const rows = payment.couldntConfirm.hashes.map(({ hash }, index) => {
    const link = explorerUrlOf(payment, index)
      ? ` <a href="#" class="recent-payments-link" data-explorer="${index}">${escapeHtml(COULDNT_CONFIRM.explorer)}</a>`
      : '';
    return `<span class="held-payment-hash"><code title="${escapeHtml(hash)}">${escapeHtml(truncateAddress(hash, 10, 8))}</code>${link}</span>`;
  });
  return `
    <span class="safe-signing-row-note info">${escapeHtml(COULDNT_CONFIRM.note)}</span>
    <div class="held-payment-hashes">${rows.join('')}</div>
  `;
}

function renderPayment(payment) {
  const step = active?.intentId === payment.intentId ? active : null;
  const busy = Boolean(step?.busy);
  const chain = chainOf(payment.chainId);
  const account = walletRecord(payment.walletIndex)?.name || truncateAddress(payment.sender);
  const meta = [account, chain.name || `Chain ${payment.chainId}`, HELD.nonce(payment.nonce)];
  if (payment.createdAt) meta.push(timeAgo(new Date(payment.createdAt)).toLowerCase());
  const replaceLabel = payment.replacement === 'replace' ? REPLACE.replace : REPLACE.speedUp;
  const disabled = busy || payment.attention === 'sending' ? 'disabled' : '';
  const unconfirmed = payment.couldntConfirm ?? null;

  let stepHtml = '';
  if (step?.step === 'close') {
    stepHtml = renderStep(
      COULDNT_CONFIRM.confirmClose,
      busy ? COULDNT_CONFIRM.closing : COULDNT_CONFIRM.close,
      'confirm-close',
      busy
    );
  } else if (step?.step === 'resend') {
    stepHtml = renderStep(
      HELD.confirmDappResend(payment.origin, timeAgo(new Date(payment.createdAt)).toLowerCase()),
      busy ? ACTIONS.sendingAgain : ACTIONS.sendAgain,
      'confirm-resend',
      busy
    );
  } else if (step?.step === 'replace' && step.fees) {
    const symbol = chain.nativeSymbol || 'ETH';
    const text = `${REPLACE.newFee(maxFeeOf(payment, step.fees), symbol)}. ${REPLACE.note}`;
    const confirmLabel = busy ? replacingLabel(payment) : HELD.confirm;
    stepHtml = renderStep(text, confirmLabel, 'confirm-replace', busy);
  }

  const note = step?.note ?? {
    kind:
      unconfirmed || payment.attention === 'refused' || payment.attention === 'not-sent'
        ? 'error'
        : 'info',
    text: attentionText(payment),
  };

  // Once its place in the queue is seen used, it can only be closed.
  const buttons = unconfirmed?.closable
    ? `<button type="button" class="safe-status-btn" data-action="close" ${disabled}>${escapeHtml(COULDNT_CONFIRM.close)}</button>`
    : `<button type="button" class="safe-status-btn" data-action="resend" ${disabled}>${escapeHtml(ACTIONS.sendAgain)}</button>
          ${payment.replacement ? `<button type="button" class="safe-status-btn" data-action="replace" ${disabled}>${escapeHtml(replaceLabel)}</button>` : ''}`;

  return `
    <div class="safe-signing-row held-payment-row" data-intent="${escapeHtml(payment.intentId)}">
      <div class="safe-signing-row-info">
        <span class="safe-signing-row-name">${escapeHtml(describePayment(payment))}</span>
        <span class="safe-signing-row-type">${escapeHtml(meta.join(' · '))}</span>
        ${payment.origin ? `<span class="safe-signing-row-type">${escapeHtml(HELD.requestedBy(payment.origin))}</span>` : ''}
        <span class="safe-signing-row-note ${note.kind}">${escapeHtml(note.text)}</span>
        ${unconfirmed ? renderHashes(payment) : ''}
      </div>
      ${stepHtml || `<div class="safe-status-btn-row">${buttons}</div>`}
    </div>
  `;
}

function renderStep(text, confirmLabel, confirmAction, busy) {
  const disabled = busy ? 'disabled' : '';
  return `
    <div class="held-payment-step">
      <span class="safe-signing-row-note info">${escapeHtml(text)}</span>
      <div class="safe-status-btn-row">
        <button type="button" class="safe-status-btn primary" data-action="${confirmAction}" ${disabled}>${escapeHtml(confirmLabel)}</button>
        <button type="button" class="safe-status-btn" data-action="cancel" ${disabled}>${escapeHtml(HELD.cancel)}</button>
      </div>
    </div>
  `;
}

function replacingLabel(payment) {
  const type = accountType(payment.walletIndex);
  return type === 'ledger' || type === 'remote'
    ? signingButtonLabel(payment.walletIndex)
    : REPLACE.replacing;
}

function onListClick(event) {
  const button = event.target?.closest?.('button[data-action]');
  const rowEl = button?.closest?.('[data-intent]');
  if (!button || !rowEl || button.disabled) return;
  const payment = waiting.find((candidate) => candidate.intentId === rowEl.dataset.intent);
  if (!payment) return;
  handleAction(button.dataset.action, payment);
}

/** One action on a waiting payment (exported for tests). */
export async function handleAction(action, payment) {
  if (active?.busy) return;
  if (action === 'cancel') {
    active = null;
  } else if (action === 'resend') {
    // A dApp's payment asks once more, naming the site; the user's own
    // payment goes at the press (D5).
    if (payment.kind === 'dapp-send' && payment.origin) {
      active = { intentId: payment.intentId, step: 'resend' };
    } else {
      await sendAgain(payment);
      return;
    }
  } else if (action === 'confirm-resend') {
    await sendAgain(payment);
    return;
  } else if (action === 'replace') {
    await offerReplacement(payment);
    return;
  } else if (action === 'confirm-replace') {
    await replace(payment);
    return;
  } else if (action === 'close') {
    if (!payment.couldntConfirm?.closable) return;
    active = { intentId: payment.intentId, step: 'close' };
  } else if (action === 'confirm-close') {
    await closePayment(payment);
    return;
  }
  render();
}

// Close a Couldn't confirm payment by hand: authorized by a confirmation of
// the payment and every hash the list showed (the revision the user saw).
// Closed, it leaves the list.
async function closePayment(payment) {
  const unconfirmed = payment.couldntConfirm;
  if (!unconfirmed?.closable) return;
  active = { intentId: payment.intentId, step: 'close', busy: true };
  render();
  let note = null;
  try {
    const result = await window.wallet.intentClose(
      payment.intentId,
      await confirmSigning('intent-close', null, {
        intentId: payment.intentId,
        chainId: payment.chainId,
        sender: payment.sender,
        nonce: payment.nonce,
        hashes: unconfirmed.hashes.map(({ hash }) => hash),
      })
    );
    if (!result.success) note = { kind: 'error', text: result.error };
  } catch (err) {
    note = { kind: 'error', text: err.message };
  }
  active = note ? { intentId: payment.intentId, note } : null;
  await refreshHeldPayments();
}

async function sendAgain(payment) {
  active = { intentId: payment.intentId, step: active?.step, busy: true };
  render();
  let note;
  try {
    // The one resend path (intent-resend.js): a stale confirmation is
    // minted again against main's current hash; nothing here can sign
    // the payment afresh.
    const { result } = await resendHeldPayment(payment);
    note = result.success
      ? { kind: 'info', text: outcomeText(result.outcome) ?? attentionText({ attention: 'sent' }) }
      : {
          kind: 'error',
          text: outcomeText(result.outcome, result.reasonClass) || result.error,
        };
  } catch (err) {
    note = { kind: 'error', text: err.message };
  }
  active = { intentId: payment.intentId, note };
  await refreshHeldPayments();
}

async function offerReplacement(payment) {
  active = { intentId: payment.intentId, step: 'replace', busy: true };
  render();
  const result = await window.wallet.intentReplacementFees(payment.intentId);
  active = result.success
    ? { intentId: payment.intentId, step: 'replace', fees: result.fees }
    : { intentId: payment.intentId, note: { kind: 'error', text: result.error } };
  render();
}

async function replace(payment) {
  const { fees } = active ?? {};
  if (!fees) return;
  if (isSignatureInFlight()) return;
  const flight = { intentId: payment.intentId };
  active = { intentId: payment.intentId, step: 'replace', fees, busy: true };
  render();
  beginSignatureFlight(flight);
  let note;
  try {
    const result = await window.wallet.intentReplace(
      payment.intentId,
      fees,
      await confirmSigning('intent-replace', null, {
        intentId: payment.intentId,
        chainId: payment.chainId,
        sender: payment.sender,
        nonce: payment.nonce,
        to: payment.fields.to,
        value: payment.fields.value,
        data: payment.fields.data,
        gasLimit: payment.fields.gasLimit,
        ...fees,
      })
    );
    note = result.success
      ? { kind: 'info', text: REPLACE.replaced }
      : { kind: 'error', text: outcomeText(result.outcome, result.reasonClass) || result.error };
  } catch (err) {
    note = { kind: 'error', text: err.message };
  } finally {
    endSignatureFlight(flight);
  }
  active = { intentId: payment.intentId, note };
  await refreshHeldPayments();
}
