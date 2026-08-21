/**
 * Publisher Identities Module
 *
 * Sidebar sub-screen listing origins and managing each origin's active Swarm
 * publisher identity.
 */

import { walletState, registerScreenHider } from './wallet-state.js';
import { refuseSubscreenWhileInFlight } from './signature-flight.js';
import { escapeHtml } from './wallet-utils.js';
import { showVaultUnlock } from './vault-unlock.js';
import { showPublisherIdentityCreate } from './publisher-identity-create.js';
import {
  BEE_WALLET_IDENTITY_ID,
  getActivePublisherIdentity,
  identityLabel,
  renderPublisherIdentitySelector,
} from './publisher-identity-selector.js';

let screen;
let backBtn;
let filterInput;
let listContainer;
let emptyMessage;
let listView;
let detailView;
let detailOrigin;
let detailSelector;
let detailNote;

let cachedEntries = [];
let activeDetailOrigin = null;
let activeDetailState = null;

export function initPublisherIdentities() {
  screen = document.getElementById('sidebar-publisher-identities');
  backBtn = document.getElementById('publisher-identities-back');
  filterInput = document.getElementById('publisher-identity-filter');
  listContainer = document.getElementById('publisher-identity-list');
  emptyMessage = document.getElementById('publisher-identity-empty');
  listView = document.getElementById('publisher-identity-list-view');
  detailView = document.getElementById('publisher-identity-detail');
  detailOrigin = document.getElementById('publisher-identity-detail-origin');
  detailSelector = document.getElementById('publisher-identity-selector');
  detailNote = document.getElementById('publisher-identity-detail-note');

  registerScreenHider(() => closePublisherIdentities());

  backBtn?.addEventListener('click', () => {
    if (activeDetailOrigin) {
      showPublisherIdentityList();
    } else {
      closePublisherIdentities();
    }
  });

  filterInput?.addEventListener('input', () => {
    const query = filterInput.value.toLowerCase().trim();
    renderList(cachedEntries, query);
  });
}

export async function openPublisherIdentities() {
  if (refuseSubscreenWhileInFlight('Publisher identities screen')) return;

  await reloadEntries();
  if (filterInput) filterInput.value = '';
  showPublisherIdentityList();

  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
}

export function closePublisherIdentities() {
  screen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
  resetDetailState();
}

function renderList(entries, query) {
  if (!listContainer) return;

  const filtered = query
    ? entries.filter((entry) => entry.origin.toLowerCase().includes(query))
    : entries;

  listContainer.innerHTML = '';

  if (filtered.length === 0) {
    emptyMessage?.classList.remove('hidden');
    if (emptyMessage) {
      emptyMessage.textContent = query ? 'No matching identities.' : 'No publisher identities yet.';
    }
    return;
  }

  emptyMessage?.classList.add('hidden');

  for (const entry of filtered) {
    const modeBadge = getModeBadge(entry.identityMode);

    const grantDot = entry.feedGranted
      ? '<span class="publisher-identity-grant-dot" title="Feed access active"></span>'
      : '';

    const feedLabel = entry.feedCount === 1 ? '1 feed' : `${entry.feedCount} feeds`;
    const identityCount = entry.identityCount || 1;
    const identityCountLabel = identityCount === 1 ? '1 identity' : `${identityCount} identities`;

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'publisher-identity-item';
    item.title = entry.origin;
    item.innerHTML = `<div class="publisher-identity-header">
      <span class="publisher-identity-origin">${escapeHtml(truncateOrigin(entry.origin))}</span>
      ${grantDot}
    </div>
    <div class="publisher-identity-meta">
      ${modeBadge}
      <span class="publisher-identity-feeds">${feedLabel}</span>
      <span class="publisher-identity-feeds">${identityCountLabel}</span>
    </div>`;
    item.addEventListener('click', () => openOriginIdentityDetail(entry.origin));
    listContainer.appendChild(item);
  }
}

function getModeBadge(identityMode) {
  if (identityMode === 'app-scoped') {
    return '<span class="publisher-identity-badge badge-app-scoped">App-scoped</span>';
  }
  if (identityMode === 'ethereum-wallet') {
    return '<span class="publisher-identity-badge badge-ethereum-wallet">Ethereum wallet</span>';
  }
  return '<span class="publisher-identity-badge badge-bee-wallet">Ant wallet</span>';
}

function showPublisherIdentityList() {
  resetDetailState();
  detailView?.classList.add('hidden');
  listView?.classList.remove('hidden');
  const query = filterInput?.value.toLowerCase().trim() || '';
  renderList(cachedEntries, query);
}

async function openOriginIdentityDetail(origin, note = '') {
  const unlocked = await ensurePublisherIdentityUnlocked(origin);
  if (!unlocked) return;

  activeDetailOrigin = origin;
  listView?.classList.add('hidden');
  detailView?.classList.remove('hidden');
  walletState.identityView?.classList.add('hidden');
  screen?.classList.remove('hidden');
  if (detailOrigin) detailOrigin.textContent = origin;

  await refreshDetail(note);
}

async function refreshDetail(note = '') {
  if (!activeDetailOrigin) return;
  activeDetailState = await loadOrCreateIdentityState(activeDetailOrigin);
  renderIdentityDetail(note);
}

async function loadOrCreateIdentityState(origin) {
  let state = await window.swarmFeedStore.getOriginIdentities(origin);
  if (!state?.activeIdentityId) {
    state = await window.swarmFeedStore.createAppScopedIdentity(origin);
    await reloadEntries();
  }
  return state;
}

function renderIdentityDetail(note) {
  renderPublisherIdentitySelector(detailSelector, activeDetailState, {
    onSelect: (identity) => activateIdentityForDetail(identity),
    onCreateAppScoped: () => createAppScopedIdentityForDetail(),
  });

  if (detailNote) {
    detailNote.textContent = note;
    detailNote.classList.toggle('hidden', !note);
  }
}

async function ensurePublisherIdentityUnlocked(origin) {
  try {
    const status = await window.identity.getStatus();
    if (status.isUnlocked) return true;
    await showVaultUnlock(origin);
    return true;
  } catch {
    return false;
  }
}

async function activateIdentityForDetail(identity) {
  if (!activeDetailOrigin || !identity) return;
  if (identity.id === activeDetailState?.activeIdentityId) return;

  if (identity.id === BEE_WALLET_IDENTITY_ID) {
    activeDetailState = await window.swarmFeedStore.ensureAntWalletIdentity(activeDetailOrigin, { activate: true });
  } else if (identity.mode === 'ethereum-wallet') {
    activeDetailState = await window.swarmFeedStore.ensureEthereumWalletIdentity(
      activeDetailOrigin,
      identity.walletIndex,
      { activate: true }
    );
  } else {
    activeDetailState = await window.swarmFeedStore.activateFeedIdentity(activeDetailOrigin, identity.id);
  }

  await disableFeedAutoApprove(activeDetailOrigin);
  await reloadEntries();
  renderIdentityDetail(`${identityLabel(getActivePublisherIdentity(activeDetailState))} is now active. Feed auto-approve was turned off.`);
}

async function createAppScopedIdentityForDetail() {
  if (!activeDetailOrigin) return;
  screen?.classList.add('hidden');
  try {
    const state = await showPublisherIdentityCreate(activeDetailOrigin);
    screen?.classList.remove('hidden');
    detailView?.classList.remove('hidden');
    listView?.classList.add('hidden');

    if (state) {
      activeDetailState = state;
      await disableFeedAutoApprove(activeDetailOrigin);
      await reloadEntries();
      renderIdentityDetail(`${identityLabel(getActivePublisherIdentity(state))} was created and selected. Feed auto-approve was turned off.`);
    } else {
      await refreshDetail();
    }
  } catch (err) {
    console.error('[PublisherIdentities] Publisher identity creation dismissed:', err);
    closePublisherIdentities();
  }
}

async function disableFeedAutoApprove(origin) {
  await window.swarmPermissions?.setAutoApprove?.(origin, 'feeds', false);
}

async function reloadEntries() {
  try {
    cachedEntries = await window.swarmFeedStore?.getAllOrigins?.() || [];
  } catch {
    cachedEntries = [];
  }
}

function resetDetailState() {
  activeDetailOrigin = null;
  activeDetailState = null;
  if (detailSelector) detailSelector.innerHTML = '';
  if (detailNote) {
    detailNote.textContent = '';
    detailNote.classList.add('hidden');
  }
}

function truncateOrigin(origin) {
  if (origin.length <= 40) return origin;
  return `${origin.slice(0, 20)}...${origin.slice(-17)}`;
}
