/**
 * Publisher identity dropdown.
 *
 * Shared by Swarm feed prompts and publisher identity management screens.
 */

import { escapeHtml } from './wallet-utils.js';

export const BEE_WALLET_IDENTITY_ID = 'bee-wallet';
export const ETHEREUM_WALLET_ID_PREFIX = 'ethereum-wallet:';

let outsideClickAttached = false;

export function getActivePublisherIdentity(state) {
  return state?.identities?.find((identity) => identity.id === state.activeIdentityId) || null;
}

export function renderPublisherIdentitySelector(container, state, handlers = {}) {
  if (!container) return;
  attachOutsideClickHandler();

  const active = getActivePublisherIdentity(state);
  const identities = orderIdentities(state);
  const activeLabel = active ? identityLabel(active) : 'Choose publisher identity';
  const activeOwner = active?.owner ? truncateAddress(active.owner) : 'Unlock to reveal owner';

  container.innerHTML = `
    <div class="wallet-selector publisher-identity-selector">
      <button type="button" class="wallet-selector-btn publisher-identity-selector-btn">
        <div class="wallet-selector-info">
          <span class="wallet-selector-name">${escapeHtml(activeLabel)}</span>
          <code class="wallet-selector-address">${escapeHtml(activeOwner)}</code>
        </div>
        <svg class="wallet-selector-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="m6 9 6 6 6-6"/>
        </svg>
      </button>
      <div class="wallet-selector-dropdown hidden">
        <div class="wallet-selector-list"></div>
        <div class="wallet-selector-divider"></div>
        <button type="button" class="wallet-selector-action publisher-identity-create-action">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 5v14M5 12h14"/>
          </svg>
          <span>Create new app-scoped identity</span>
        </button>
      </div>
    </div>
  `;

  const selector = container.querySelector('.publisher-identity-selector');
  const button = container.querySelector('.publisher-identity-selector-btn');
  const dropdown = container.querySelector('.wallet-selector-dropdown');
  const list = container.querySelector('.wallet-selector-list');
  const createButton = container.querySelector('.publisher-identity-create-action');

  button?.addEventListener('click', (event) => {
    event.stopPropagation();
    const isOpen = selector?.classList.contains('open');
    closePublisherIdentityDropdowns(selector);
    selector?.classList.toggle('open', !isOpen);
    dropdown?.classList.toggle('hidden', isOpen);
  });

  createButton?.addEventListener('click', (event) => {
    event.stopPropagation();
    closePublisherIdentityDropdowns();
    handlers.onCreateAppScoped?.();
  });

  if (!list) return;

  list.innerHTML = '';
  for (const identity of identities) {
    list.appendChild(buildIdentityItem(identity, identity.id === state?.activeIdentityId, handlers));
  }
}

export function identityLabel(identity) {
  if (!identity) return 'Publisher identity';
  if (identity.label) return identity.label;
  if (identity.mode === 'bee-wallet') return 'Ant wallet identity';
  if (identity.mode === 'ethereum-wallet') return 'Ethereum wallet';
  return 'App-scoped identity';
}

export function identityModeLabel(identity) {
  if (identity?.mode === 'bee-wallet') return 'Ant wallet';
  if (identity?.mode === 'app-scoped') return 'App-scoped';
  if (identity?.mode === 'ethereum-wallet') return 'Ethereum wallet';
  return 'Publisher';
}

export function truncateAddress(address) {
  if (!address || address.length <= 18) return address || '--';
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

function orderIdentities(state) {
  const identities = [...(state?.identities || [])];
  const beeWallet = identities.find((identity) => identity.id === BEE_WALLET_IDENTITY_ID) || {
    id: BEE_WALLET_IDENTITY_ID,
    mode: 'bee-wallet',
    label: 'Ant wallet identity',
    owner: null,
    stored: false,
  };
  const appScoped = identities
    .filter((identity) => identity.mode === 'app-scoped')
    .sort(compareAppScopedIdentities);
  const ethereumWallets = identities
    .filter((identity) => identity.mode === 'ethereum-wallet')
    .sort(compareEthereumWalletIdentities);

  return [
    ...appScoped,
    ...ethereumWallets,
    beeWallet,
  ];
}

function compareAppScopedIdentities(a, b) {
  if (typeof a.publisherKeyIndex === 'number' && typeof b.publisherKeyIndex === 'number') {
    return a.publisherKeyIndex - b.publisherKeyIndex;
  }
  if (typeof a.publisherKeyIndex === 'number') return -1;
  if (typeof b.publisherKeyIndex === 'number') return 1;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

function compareEthereumWalletIdentities(a, b) {
  if (typeof a.walletIndex === 'number' && typeof b.walletIndex === 'number') {
    return a.walletIndex - b.walletIndex;
  }
  if (typeof a.walletIndex === 'number') return -1;
  if (typeof b.walletIndex === 'number') return 1;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

function buildIdentityItem(identity, isActive, handlers) {
  const item = document.createElement('button');
  item.type = 'button';
  item.className = 'wallet-selector-item publisher-identity-selector-item';
  if (isActive) item.classList.add('active');
  // Main flags identities whose backing account can't sign feeds (deleted
  // wallet, hardware account). Selecting one would only fail later, so the
  // row is shown greyed out and inert instead of silently breaking feeds.
  if (identity.unavailable) {
    item.classList.add('unavailable');
    item.disabled = true;
  }

  item.innerHTML = `
    <div class="wallet-selector-item-info">
      <span class="wallet-selector-item-name">${escapeHtml(identityLabel(identity))}</span>
      <div class="wallet-selector-item-address-row">
        <span class="publisher-identity-mode">${escapeHtml(identityModeLabel(identity))}</span>
        <code class="wallet-selector-item-address" title="${escapeHtml(identity.owner || '')}">${escapeHtml(truncateAddress(identity.owner))}</code>
        ${identity.unavailable ? '<span class="publisher-identity-unavailable">Can’t sign feeds</span>' : ''}
      </div>
    </div>
    <div class="wallet-selector-item-actions">
      ${isActive ? `
        <svg class="wallet-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    </div>
  `;

  item.addEventListener('click', () => {
    if (identity.unavailable) return;
    closePublisherIdentityDropdowns();
    handlers.onSelect?.(identity);
  });

  return item;
}

function attachOutsideClickHandler() {
  if (outsideClickAttached) return;
  outsideClickAttached = true;
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.publisher-identity-selector')) {
      closePublisherIdentityDropdowns();
    }
  });
}

function closePublisherIdentityDropdowns(except = null) {
  document.querySelectorAll('.publisher-identity-selector.open').forEach((selector) => {
    if (selector === except) return;
    selector.classList.remove('open');
    selector.querySelector('.wallet-selector-dropdown')?.classList.add('hidden');
  });
}
