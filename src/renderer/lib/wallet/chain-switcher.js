/**
 * Chain Switcher Module
 *
 * Chain dropdown and selection. The selection is main's to tell pages
 * (freedom-core design 0011, PRQ-6): main hears every change here
 * (`wallet:select-chain`) and sends `chainChanged` to every page of this
 * window whose chain follows it. The chrome sends no page an event.
 */

import { walletState } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';
import { renderAssetList, loadChainRegistry } from './balance-display.js';

// DOM references
let chainSwitcherBtn;
let chainSwitcherName;
let chainSwitcherLogo;
let chainSwitcherLogoPlaceholder;
let chainSwitcherDropdown;
let chainSwitcherList;

// The number of main's latest page selection this switcher has shown
// (freedom-core design 0011, PRQ-6). Reported with every pick, so main can
// refuse one made before the switcher showed it.
let seenSequence = 0;

/**
 * Write the selected chain, and tell main: main answers pages' Ethereum
 * reads (`eth_chainId`, `net_version`, the RPC reads) with this window's
 * selection (freedom-core design 0011, PRQ-3), and tells the window's pages
 * of the change itself (PRQ-6), after it has recorded it, so a page that
 * asks on its `chainChanged` reads the new chain.
 */
function writeSelectedChain(chainId) {
  walletState.selectedChainId = chainId;
  try {
    window.wallet?.selectChain?.(chainId, seenSequence);
  } catch (err) {
    console.error('[WalletUI] Failed to report the selected chain:', err);
  }
}

/**
 * Show a selection main made, `{ chainId, sequence }`, unless this switcher
 * has shown a newer one. Main has it already, so nothing goes back.
 */
function showMainSelection(selection) {
  const sequence = selection?.sequence;
  const chainId = selection?.chainId;
  if (!Number.isSafeInteger(sequence) || sequence <= seenSequence) return;
  if (chainId !== null && !(Number.isSafeInteger(chainId) && chainId > 0)) return;
  seenSequence = sequence;
  if (walletState.selectedChainId === chainId) return;
  walletState.selectedChainId = chainId;
  updateChainSwitcherDisplay();
  renderAssetList();
}

export function initChainSwitcher() {
  // Main starts every window on the switcher's default; report this one's
  // (a reloaded chrome starts again from it).
  writeSelectedChain(walletState.selectedChainId);

  chainSwitcherBtn = document.getElementById('chain-switcher-btn');
  chainSwitcherName = document.getElementById('chain-switcher-name');
  chainSwitcherLogo = document.getElementById('chain-switcher-logo');
  chainSwitcherLogoPlaceholder = document.getElementById('chain-switcher-logo-placeholder');
  chainSwitcherDropdown = document.getElementById('chain-switcher-dropdown');
  chainSwitcherList = document.getElementById('chain-switcher-list');

  setupChainSwitcher();

  // A page's wallet_switchEthereumChain runs in main now (freedom-core
  // design 0011, PRQ-4), which selected the chain for this window and told
  // its pages: the switcher shows it, and reports nothing back. Main
  // numbers its selections, and refuses a pick made before the switcher
  // showed its latest, which it then shows again (PRQ-6).
  window.wallet?.onPageSelectedChain?.(showMainSelection);
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
    writeSelectedChain(null);
    updateChainSwitcherDisplay();
    renderAssetList();
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

  // Main tells the window's pages (freedom-core design 0011, PRQ-6).
  writeSelectedChain(chainId);

  updateChainSwitcherDisplay();
  renderAssetList();
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

  writeSelectedChain(chainId);
  updateChainSwitcherDisplay();
  renderAssetList();
  console.log('[WalletUI] Chain switched to:', chainId);
}
