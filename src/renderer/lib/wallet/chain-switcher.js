/**
 * Chain Switcher Module
 *
 * Chain dropdown, selection, dApp chain events.
 */

import { walletState } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';
import { renderAssetList, loadChainRegistry } from './balance-display.js';
import { syncPagesToSelectedChain } from '../dapp-provider.js';

// DOM references
let chainSwitcherBtn;
let chainSwitcherName;
let chainSwitcherLogo;
let chainSwitcherLogoPlaceholder;
let chainSwitcherDropdown;
let chainSwitcherList;

export function initChainSwitcher() {
  chainSwitcherBtn = document.getElementById('chain-switcher-btn');
  chainSwitcherName = document.getElementById('chain-switcher-name');
  chainSwitcherLogo = document.getElementById('chain-switcher-logo');
  chainSwitcherLogoPlaceholder = document.getElementById('chain-switcher-logo-placeholder');
  chainSwitcherDropdown = document.getElementById('chain-switcher-dropdown');
  chainSwitcherList = document.getElementById('chain-switcher-list');

  setupChainSwitcher();
}

function setupChainSwitcher() {
  if (chainSwitcherBtn) {
    chainSwitcherBtn.addEventListener('click', toggleChainDropdown);
  }

  document.addEventListener('click', (e) => {
    const switcher = document.getElementById('chain-switcher');
    if (switcher && !switcher.contains(e.target)) {
      closeChainDropdown();
    }
  });
}

function toggleChainDropdown() {
  const switcher = document.getElementById('chain-switcher');
  if (!switcher || !chainSwitcherDropdown) return;

  const isOpen = switcher.classList.contains('open');

  if (isOpen) {
    closeChainDropdown();
  } else {
    switcher.classList.add('open');
    chainSwitcherDropdown.classList.remove('hidden');
    renderChainList();
  }
}

function closeChainDropdown() {
  const switcher = document.getElementById('chain-switcher');
  if (switcher) {
    switcher.classList.remove('open');
  }
  if (chainSwitcherDropdown) {
    chainSwitcherDropdown.classList.add('hidden');
  }
}

async function renderChainList() {
  if (!chainSwitcherList) return;

  chainSwitcherList.innerHTML = '';

  // Refresh the chain set first — a chain may have been added or removed
  // on the settings page since the wallet loaded.
  const [, availableResult] = await Promise.all([
    loadChainRegistry(),
    window.networks.getAvailableChains(),
  ]);

  // If the selected chain was removed, fall back to "All Chains" so the
  // header and asset list don't keep filtering on a chain that's gone.
  const selected = walletState.selectedChainId;
  if (selected !== null && !walletState.registeredChains[selected]) {
    walletState.selectedChainId = null;
    updateChainSwitcherDisplay();
    renderAssetList();
    // Pages now see Gnosis ("All Chains"): tell them, as for any switch
    syncPagesToSelectedChain();
  }

  const availableChains = availableResult.success ? availableResult.chains : {};
  const availableChainIds = new Set(Object.keys(availableChains));
  const availableCount = availableChainIds.size;

  // Only show "All Chains" if more than one chain is available
  if (availableCount > 1) {
    const allItem = document.createElement('button');
    allItem.type = 'button';
    allItem.className = 'chain-switcher-item';
    if (walletState.selectedChainId === null) {
      allItem.classList.add('active');
    }

    allItem.innerHTML = `
      <div class="chain-switcher-item-info">
        <span class="chain-switcher-item-name">All Chains</span>
      </div>
      ${walletState.selectedChainId === null ? `
        <svg class="chain-switcher-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    allItem.addEventListener('click', () => selectChain(null));
    chainSwitcherList.appendChild(allItem);
  }

  for (const [chainIdStr, chain] of Object.entries(walletState.registeredChains)) {
    const chainId = parseInt(chainIdStr);
    const isAvailable = availableChainIds.has(chainIdStr);

    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chain-switcher-item';

    if (chainId === walletState.selectedChainId) {
      item.classList.add('active');
    }

    if (!isAvailable) {
      item.classList.add('disabled');
    }

    // Custom chains have no logo asset — show an initial-letter circle so
    // the row stays aligned with chains that do have an icon.
    const initial = (chain.name || '').trim().charAt(0) || '?';
    const logoHtml = chain.logo
      ? `<img class="chain-switcher-item-logo" src="assets/chains/${chain.logo}" alt="${chain.name}">`
      : `<span class="chain-switcher-logo-fallback">${escapeHtml(initial)}</span>`;

    const unavailableHtml = !isAvailable
      ? '<span class="chain-switcher-item-unavailable">No RPC</span>'
      : '';

    item.innerHTML = `
      <div class="chain-switcher-item-info">
        ${logoHtml}
        <span class="chain-switcher-item-name">${escapeHtml(chain.name)}</span>
      </div>
      ${unavailableHtml}
      ${chainId === walletState.selectedChainId && isAvailable ? `
        <svg class="chain-switcher-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      ` : ''}
    `;

    if (isAvailable) {
      item.addEventListener('click', () => selectChain(chainId));
    }

    chainSwitcherList.appendChild(item);
  }
}

function selectChain(chainId) {
  closeChainDropdown();

  const previousChainId = walletState.selectedChainId;
  walletState.selectedChainId = chainId;

  updateChainSwitcherDisplay();
  renderAssetList();

  // Tell every page, not just the active tab's, when the chain it sees
  // changed. "All Chains" counts: pages then see Gnosis. A page sends and
  // signs on the chain it was last told (dapp-provider.js, pageChainId), so
  // a page left untold would keep its old chain while its reads moved.
  if (previousChainId !== chainId) syncPagesToSelectedChain();
}

/**
 * Update chain switcher button display
 */
export function updateChainSwitcherDisplay() {
  const chain = walletState.selectedChainId === null
    ? null
    : walletState.registeredChains[walletState.selectedChainId];

  if (chainSwitcherName) {
    chainSwitcherName.textContent =
      walletState.selectedChainId === null ? 'All Chains' : (chain?.name || '');
  }

  // The chain's icon, an initial-letter placeholder, or neither ("All
  // Chains"). The <img>'s empty-src CSS rule hides it when src is unset.
  const hasLogo = !!chain?.logo;
  if (chainSwitcherLogo) {
    chainSwitcherLogo.src = hasLogo ? `assets/chains/${chain.logo}` : '';
  }
  if (chainSwitcherLogoPlaceholder) {
    if (chain && !hasLogo) {
      chainSwitcherLogoPlaceholder.textContent = (chain.name || '').trim().charAt(0) || '?';
      chainSwitcherLogoPlaceholder.style.display = 'flex';
    } else {
      chainSwitcherLogoPlaceholder.style.display = 'none';
    }
  }
}

/**
 * Get the current selected chain ID (for dApp provider)
 */
export function getSelectedChainId() {
  return walletState.selectedChainId;
}

/**
 * Set the selected chain ID (called by dApp provider on wallet_switchEthereumChain)
 */
export function setSelectedChainId(chainId) {
  if (walletState.selectedChainId === chainId) return;

  walletState.selectedChainId = chainId;
  updateChainSwitcherDisplay();
  renderAssetList();
  console.log('[WalletUI] Chain switched to:', chainId);
  syncPagesToSelectedChain();
}
