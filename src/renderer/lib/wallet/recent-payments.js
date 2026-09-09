/**
 * Recent-payments mini-section in the wallet sidebar. Renders the N
 * most-recent rows; "View all →" opens freedom://payments.
 */

import { openOrFocusInternalPage } from '../tabs.js';
import { walletState } from './wallet-state.js';
import { escapeHtml, truncateAddress, formatRawTokenBalance, timeAgo } from './wallet-utils.js';

// Set to 0 to render only the section header + "View all →" link with no
// rows — the cleaner-looking default while we live with how busy the
// section feels. Bump back to 5 (or any small N) to re-enable the list.
const LIMIT = 0;
const EMPTY_HTML = '<div class="recent-payments-empty">No payments yet</div>';

// Status values we have CSS classes for (sidebar.css). Anything else
// falls back to the muted 'no-receipt' style so a new backend status
// doesn't render an unstyled pill.
const STATUS_CLASSES = new Set(['settled', 'confirmed', 'pending', 'failed', 'no-receipt']);

let listEl;
let viewAllLink;

export function initRecentPayments() {
  listEl = document.getElementById('recent-payments-list');
  viewAllLink = document.getElementById('recent-payments-view-all');

  viewAllLink.addEventListener('click', (e) => {
    e.preventDefault();
    // Singleton, like every other chrome path to an internal page: an already
    // open Payments tab is focused rather than duplicated. `createTab` here
    // always made a second one (#325).
    openOrFocusInternalPage('payments');
  });

  // Canonical "table changed" signal — fires on every main-side row
  // mutation, including the previously-silent x402 settlements and
  // pending→confirmed/failed transitions.
  window.addEventListener('payments:tx-recorded', () => {
    refreshRecentPayments().catch((err) => {
      console.error('[recent-payments] refresh after tx-recorded failed:', err);
    });
  });

  // Initial paint. The wallet tab is the default on startup, so this
  // populates the section before the user has clicked anything.
  refreshRecentPayments().catch((err) => {
    console.error('[recent-payments] initial refresh failed:', err);
  });
}

export async function refreshRecentPayments() {
  if (!listEl) return;
  // LIMIT=0 means "header + link only, no rows". Skip the IPC entirely
  // so the section is purely the deep-link to freedom://payments.
  if (LIMIT <= 0) {
    listEl.innerHTML = '';
    return;
  }
  const result = await window.payments?.getRecent({ limit: LIMIT });
  const payments = result?.success ? (result.payments || []) : [];
  if (payments.length === 0) {
    listEl.innerHTML = EMPTY_HTML;
    return;
  }
  listEl.innerHTML = payments.map(renderRow).join('');
}

function renderRow(p) {
  // walletState.registeredTokens is hydrated at boot (balance-display.js
  // → loadChainRegistry); same key shape as the payment row's chainId+asset.
  const tokenKey = `${p.chainId}:${p.asset || 'native'}`;
  const token = walletState.registeredTokens?.[tokenKey];
  const symbol = token?.symbol || (p.asset ? 'token' : 'native');
  const amount = token?.decimals !== undefined
    ? formatRawTokenBalance(p.amount, token.decimals)
    : '--';
  const counterparty = p.origin || (p.toAddress ? truncateAddress(p.toAddress) : '—');
  const statusClass = STATUS_CLASSES.has(p.status) ? p.status : 'no-receipt';

  return `
    <div class="recent-payment-row">
      <div class="recent-payment-left">
        <span class="recent-payment-amount">${escapeHtml(amount)} ${escapeHtml(symbol)}</span>
        <span class="recent-payment-counterparty" title="${escapeHtml(counterparty)}">${escapeHtml(counterparty)}</span>
      </div>
      <div class="recent-payment-right">
        <span class="recent-payment-when">${escapeHtml(timeAgo(new Date(p.createdAt)))}</span>
        <span class="recent-payment-status ${statusClass}">${escapeHtml(p.status)}</span>
      </div>
    </div>
  `;
}
