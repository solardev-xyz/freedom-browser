/**
 * Publisher Identities Module
 *
 * Sidebar sub-screen listing all origins that have Swarm feed publisher
 * identities. Shows identity mode, feed count, and grant status.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';

let screen;
let backBtn;
let filterInput;
let listContainer;
let emptyMessage;

let cachedEntries = [];

export function initPublisherIdentities() {
  screen = document.getElementById('sidebar-publisher-identities');
  backBtn = document.getElementById('publisher-identities-back');
  filterInput = document.getElementById('publisher-identity-filter');
  listContainer = document.getElementById('publisher-identity-list');
  emptyMessage = document.getElementById('publisher-identity-empty');

  registerScreenHider(() => closePublisherIdentities());

  if (backBtn) {
    backBtn.addEventListener('click', () => closePublisherIdentities());
  }

  if (filterInput) {
    filterInput.addEventListener('input', () => {
      const query = filterInput.value.toLowerCase().trim();
      renderList(cachedEntries, query);
    });
  }
}

export async function openPublisherIdentities() {
  try {
    cachedEntries = await window.swarmFeedStore?.getAllOrigins?.() || [];
  } catch {
    cachedEntries = [];
  }

  if (filterInput) filterInput.value = '';
  renderList(cachedEntries, '');

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
}

export function closePublisherIdentities() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

function renderList(entries, query) {
  if (!listContainer) return;

  const filtered = query
    ? entries.filter((e) => e.origin.toLowerCase().includes(query))
    : entries;

  if (filtered.length === 0) {
    listContainer.innerHTML = '';
    emptyMessage?.classList.remove('hidden');
    if (emptyMessage) {
      emptyMessage.textContent = query ? 'No matching identities.' : 'No publisher identities yet.';
    }
    return;
  }

  emptyMessage?.classList.add('hidden');

  listContainer.innerHTML = filtered.map((entry) => {
    const modeBadge = entry.identityMode === 'app-scoped'
      ? '<span class="publisher-identity-badge badge-app-scoped">App-scoped</span>'
      : '<span class="publisher-identity-badge badge-bee-wallet">Bee wallet</span>';

    const grantDot = entry.feedGranted
      ? '<span class="publisher-identity-grant-dot" title="Feed access active"></span>'
      : '';

    const feedLabel = entry.feedCount === 1 ? '1 feed' : `${entry.feedCount} feeds`;

    return `<div class="publisher-identity-item" title="${escapeHtml(entry.origin)}">
      <div class="publisher-identity-header">
        <span class="publisher-identity-origin">${escapeHtml(truncateOrigin(entry.origin))}</span>
        ${grantDot}
      </div>
      <div class="publisher-identity-meta">
        ${modeBadge}
        <span class="publisher-identity-feeds">${feedLabel}</span>
      </div>
    </div>`;
  }).join('');
}

function truncateOrigin(origin) {
  if (origin.length <= 40) return origin;
  return origin.slice(0, 20) + '\u2026' + origin.slice(-17);
}

