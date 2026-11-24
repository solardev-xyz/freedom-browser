/**
 * Unfinished Safe transactions — the wallet-wide entry point.
 *
 * A row above "Recent payments" shows how many SafeTxs are waiting for
 * signatures across ALL Safe accounts (hidden when none); it opens an
 * overview subscreen listing them, and each entry opens that
 * transaction's signing board.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { escapeHtml, walletRecord, timeAgo } from './wallet-utils.js';
import { openSafeSigningBoard, summaryLine } from './safe-signing.js';

let row;
let countBadge;
let storeNotice;
let storeNoticeText;
let screen;
let backBtn;
let listEl;

export function initSafePendingList() {
  row = document.getElementById('safe-pending-row');
  countBadge = document.getElementById('safe-pending-count');
  storeNotice = document.getElementById('safe-pending-store-notice');
  storeNoticeText = document.getElementById('safe-pending-store-notice-text');
  screen = document.getElementById('sidebar-safe-pending');
  backBtn = document.getElementById('safe-pending-back');
  listEl = document.getElementById('safe-pending-list');

  registerScreenHider(() => screen?.classList.add('hidden'));
  row?.addEventListener('click', openSafePendingList);
  backBtn?.addEventListener('click', closeSafePendingList);

  // Pendings change when a send flow or a signing board closes.
  window.addEventListener('wallet:send-closed', () => refreshSafePendingRow());
  window.addEventListener('wallet:safe-signing-closed', () => refreshSafePendingRow());

  refreshSafePendingRow();
}

/** Update the row's visibility and count badge. */
export async function refreshSafePendingRow() {
  if (!row) return;
  const result = await window.wallet.safePendingList();
  const count = result.success ? result.states.length : 0;
  row.classList.toggle('hidden', count === 0);
  if (countBadge) countBadge.textContent = String(count);
  showStoreNotice(storeNoticeMessage(result));
}

/**
 * What the user must hear about the pending-transactions file itself: it
 * could not be read (nothing changed, retried on the next refresh), or a
 * damaged copy was set aside. Null when there is nothing to say.
 */
export function storeNoticeMessage(result) {
  if (!result) return null;
  if (!result.success) {
    return result.code === 'SAFE_PENDING_UNREADABLE' ? result.error : null;
  }
  return result.storeNotice?.message || null;
}

function showStoreNotice(message) {
  if (!storeNotice) return;
  storeNotice.classList.toggle('hidden', !message);
  if (storeNoticeText) storeNoticeText.textContent = message || '';
}

export async function openSafePendingList() {
  const result = await window.wallet.safePendingList();
  if (!result.success) return;

  // A single pending transaction needs no overview — go straight to it.
  if (result.states.length === 1) {
    openSafeSigningBoard(result.states[0].safeIndex);
    return;
  }

  renderList(result.states);
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
}

export function closeSafePendingList() {
  if (!screen || screen.classList.contains('hidden')) return;
  screen.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  refreshSafePendingRow();
}

function renderList(states) {
  if (!listEl) return;
  listEl.innerHTML = '';

  for (const state of states) {
    const what = summaryLine(state.display);
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'connect-ledger-account safe-pending-item';
    item.innerHTML = `
      <div class="connect-ledger-account-info">
        <code class="connect-ledger-account-address">${escapeHtml(capitalize(what))}</code>
        <span class="connect-ledger-account-path">
          ${escapeHtml(walletRecord(state.safeIndex)?.name || 'Safe account')} ·
          ${state.collected} of ${state.threshold} signatures ·
          started ${escapeHtml(timeAgo(new Date(state.createdAt)).toLowerCase())}
        </span>
      </div>
      <span class="safe-pending-item-chevron">›</span>
    `;
    item.addEventListener('click', () => {
      screen?.classList.add('hidden');
      openSafeSigningBoard(state.safeIndex);
    });
    listEl.appendChild(item);
  }
}

function capitalize(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
