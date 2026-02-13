/**
 * Chain Switcher Module
 *
 * Chain dropdown, selection, dApp chain events.
 */

import { walletState } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';
import { renderAssetList } from './balance-display.js';
import { getActiveWebview, emitChainChanged } from '../dapp-provider.js';

// DOM references
let chainSwitcherBtn;
let chainSwitcherName;
let chainSwitcherLogo;
let chainSwitcherDropdown;
let chainSwitcherList;

export function initChainSwitcher() {
  chainSwitcherBtn = document.getElementById('chain-switcher-btn');
  chainSwitcherName = document.getElementById('chain-switcher-name');
  chainSwitcherLogo = document.getElementById('chain-switcher-logo');
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

  const availableResult = await window.chainRegistry.getAvailableChains();
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

    const logoHtml = chain.logo
      ? `<img class="chain-switcher-item-logo" src="assets/chains/${chain.logo}" alt="${chain.name}">`
      : '';

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

  // Emit chainChanged event to active webview if chain actually changed
  if (previousChainId !== chainId && chainId !== null) {
    const webview = getActiveWebview();
    if (webview) {
      const chainIdHex = '0x' + chainId.toString(16);
      emitChainChanged(webview, chainIdHex);
      console.log('[WalletUI] Emitted chainChanged to dApp:', chainIdHex);
    }
  }
}

/**
 * Update chain switcher button display
 */
export function updateChainSwitcherDisplay() {
  if (walletState.selectedChainId === null) {
    if (chainSwitcherName) chainSwitcherName.textContent = 'All Chains';
    if (chainSwitcherLogo) chainSwitcherLogo.src = '';
  } else {
    const chain = walletState.registeredChains[walletState.selectedChainId];
    if (chain) {
      if (chainSwitcherName) chainSwitcherName.textContent = chain.name;
      if (chainSwitcherLogo && chain.logo) {
        chainSwitcherLogo.src = `assets/chains/${chain.logo}`;
      } else if (chainSwitcherLogo) {
        chainSwitcherLogo.src = '';
      }
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
}
