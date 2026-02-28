/**
 * Wallet Selector Module
 *
 * Multi-wallet dropdown, switching, loadDerivedWallets.
 */

import { walletState } from './wallet-state.js';
import { escapeHtml } from './wallet-utils.js';
import { refreshBalances } from './balance-display.js';

// DOM references
let walletSelectorBtn;
let walletSelectorName;
let walletSelectorAddress;
let walletSelectorDropdown;
let walletSelectorList;
let walletCreateBtn;
let walletHeadlineName;

// Callback for opening create wallet screen (set by coordinator)
let openCreateWalletFn = null;

export function initWalletSelector(openCreateWallet) {
  walletSelectorBtn = document.getElementById('wallet-selector-btn');
  walletSelectorName = document.getElementById('wallet-selector-name');
  walletSelectorAddress = document.getElementById('wallet-selector-address');
  walletSelectorDropdown = document.getElementById('wallet-selector-dropdown');
  walletSelectorList = document.getElementById('wallet-selector-list');
  walletCreateBtn = document.getElementById('wallet-create-btn');
  walletHeadlineName = document.getElementById('wallet-headline-name');

  openCreateWalletFn = openCreateWallet;

  setupWalletSelector();
}

function setupWalletSelector() {
  if (walletSelectorBtn) {
    walletSelectorBtn.addEventListener('click', toggleWalletDropdown);
  }

  document.addEventListener('click', (e) => {
    const selector = document.getElementById('wallet-selector');
    if (selector && !selector.contains(e.target)) {
      closeWalletDropdown();
    }
  });

  if (walletCreateBtn) {
    walletCreateBtn.addEventListener('click', () => {
      closeWalletDropdown();
      if (openCreateWalletFn) openCreateWalletFn();
    });
  }
}

function toggleWalletDropdown() {
  const selector = document.getElementById('wallet-selector');
  if (!selector || !walletSelectorDropdown) return;

  const isOpen = selector.classList.contains('open');

  if (isOpen) {
    closeWalletDropdown();
  } else {
    selector.classList.add('open');
    walletSelectorDropdown.classList.remove('hidden');
    renderWalletList();
  }
}

function closeWalletDropdown() {
  const selector = document.getElementById('wallet-selector');
  if (selector) {
    selector.classList.remove('open');
  }
  if (walletSelectorDropdown) {
    walletSelectorDropdown.classList.add('hidden');
  }
}

function renderWalletList() {
  if (!walletSelectorList) return;

  walletSelectorList.innerHTML = '';

  walletState.derivedWallets.forEach(wallet => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'wallet-selector-item';
    if (wallet.index === walletState.activeWalletIndex) {
      item.classList.add('active');
    }

    const truncatedAddress = wallet.address
      ? `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`
      : '--';

    item.innerHTML = `
      <div class="wallet-selector-item-info">
        <span class="wallet-selector-item-name">${escapeHtml(wallet.name)}</span>
        <div class="wallet-selector-item-address-row">
          <code class="wallet-selector-item-address">${truncatedAddress}</code>
          ${wallet.address ? `
            <button type="button" class="wallet-selector-item-btn copy" data-address="${wallet.address}" title="Copy address">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
            </button>
          ` : ''}
        </div>
      </div>
      <div class="wallet-selector-item-actions">
        ${wallet.index === walletState.activeWalletIndex ? `
          <svg class="wallet-selector-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        ` : ''}
      </div>
    `;

    item.addEventListener('click', (e) => {
      if (e.target.closest('.wallet-selector-item-btn')) return;
      selectWallet(wallet.index);
    });

    const copyBtn = item.querySelector('.wallet-selector-item-btn.copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const address = copyBtn.dataset.address;
        if (address) {
          await handleCopyWalletAddress(address, copyBtn);
        }
      });
    }

    walletSelectorList.appendChild(item);
  });
}

async function handleCopyWalletAddress(address, buttonEl) {
  try {
    await window.electronAPI.copyText(address);

    buttonEl.classList.add('copied');
    buttonEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    `;

    setTimeout(() => {
      buttonEl.classList.remove('copied');
      buttonEl.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      `;
    }, 1500);
  } catch (err) {
    console.error('[WalletUI] Copy address failed:', err);
  }
}

/**
 * Select a wallet
 */
export async function selectWallet(index) {
  closeWalletDropdown();

  try {
    const result = await window.wallet.setActiveWallet(index);
    if (!result.success) {
      throw new Error(result.error);
    }

    walletState.activeWalletIndex = index;
    const selectedWallet = walletState.derivedWallets.find(w => w.index === index);

    if (selectedWallet) {
      updateWalletSelectorDisplay(selectedWallet);
      walletState.fullAddresses.wallet = selectedWallet.address || '';

      refreshBalances();
    }
  } catch (err) {
    console.error('[WalletUI] Failed to select wallet:', err);
  }
}

/**
 * Update wallet selector display
 */
export function updateWalletSelectorDisplay(wallet) {
  if (walletSelectorName) {
    walletSelectorName.textContent = wallet.name;
  }
  if (walletSelectorAddress && wallet.address) {
    walletSelectorAddress.textContent = wallet.address;
  }
  if (walletHeadlineName) {
    walletHeadlineName.textContent = wallet.name.toUpperCase();
  }
}

/**
 * Load derived wallets list
 */
export async function loadDerivedWallets() {
  try {
    const [walletsResult, activeResult] = await Promise.all([
      window.wallet.getDerivedWallets(),
      window.wallet.getActiveIndex(),
    ]);

    if (walletsResult.success) {
      walletState.derivedWallets = walletsResult.wallets;
    }

    if (activeResult.success) {
      walletState.activeWalletIndex = activeResult.index;
    }

    const activeWallet = walletState.derivedWallets.find(w => w.index === walletState.activeWalletIndex);
    if (activeWallet) {
      updateWalletSelectorDisplay(activeWallet);
      walletState.fullAddresses.wallet = activeWallet.address || '';
    }

    return activeWallet;
  } catch (err) {
    console.error('[WalletUI] Failed to load derived wallets:', err);
    return null;
  }
}
