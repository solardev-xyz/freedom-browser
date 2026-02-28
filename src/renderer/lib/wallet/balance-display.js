/**
 * Balance Display Module
 *
 * Balance fetching, caching, asset list rendering, auto-refresh, and chain registry.
 */

import { walletState } from './wallet-state.js';
import { escapeHtml, formatBalance } from './wallet-utils.js';

// DOM references
let assetListEl;
let balanceErrorEl;
let swarmBalanceXdaiEl;
let swarmBalanceXbzzEl;

export function initBalanceDisplay() {
  assetListEl = document.getElementById('asset-list');
  balanceErrorEl = document.getElementById('balance-error');
  swarmBalanceXdaiEl = document.getElementById('swarm-balance-xdai');
  swarmBalanceXbzzEl = document.getElementById('swarm-balance-xbzz');
}

/**
 * Refresh wallet balances for both user wallet and Swarm node wallet
 * Runs silently in background - no loading indicators shown to user
 */
export async function refreshBalances(forceRefresh = false) {
  const userAddress = walletState.fullAddresses.wallet;
  const swarmAddress = walletState.fullAddresses.swarm;

  if (!userAddress && !swarmAddress) return;

  hideBalanceError();

  try {
    // Clear cache if force refresh
    if (forceRefresh) {
      if (userAddress) await window.wallet.clearBalanceCache(userAddress);
      if (swarmAddress) await window.wallet.clearBalanceCache(swarmAddress);
    }

    // Fetch both wallets in parallel
    const [userResult, swarmResult] = await Promise.all([
      userAddress ? window.wallet.getBalances(userAddress) : Promise.resolve(null),
      swarmAddress ? window.wallet.getBalances(swarmAddress) : Promise.resolve(null),
    ]);

    // Display user wallet balances
    if (userResult?.success) {
      displayUserBalances(userResult.balances);
    } else if (userResult) {
      console.error('[WalletUI] Failed to fetch user balances:', userResult.error);
    }

    // Display Swarm node wallet balances
    if (swarmResult?.success) {
      displaySwarmBalances(swarmResult.balances);
    } else if (swarmResult) {
      console.error('[WalletUI] Failed to fetch Swarm balances:', swarmResult.error);
    }

  } catch (err) {
    console.error('[WalletUI] Failed to refresh balances:', err);
  }
}

/**
 * Load chain registry data
 */
export async function loadChainRegistry() {
  try {
    const [chainsResult, tokensResult] = await Promise.all([
      window.chainRegistry.getChains(),
      window.chainRegistry.getTokens(),
    ]);

    if (chainsResult.success) {
      walletState.registeredChains = chainsResult.chains;
    }

    if (tokensResult.success) {
      walletState.registeredTokens = tokensResult.tokens;
    }
  } catch (err) {
    console.error('[WalletUI] Failed to load chain registry:', err);
  }
}

// ============================================
// Token/Chain Filter Helpers (reusable)
// ============================================

/**
 * Get tokens filtered by chain and with non-zero balance
 * @param {number|null} chainId - Filter by chain ID, or null for all chains
 * @returns {Array} Array of {key, ...tokenInfo} objects
 */
export function getTokensWithBalance(chainId = null) {
  return Object.entries(walletState.registeredTokens)
    .filter(([key, token]) => {
      if (chainId !== null && token.chainId !== chainId) return false;
      const balance = walletState.currentBalances[key];
      return balance && parseFloat(balance.formatted || '0') > 0;
    })
    .map(([key, token]) => ({ key, ...token }));
}

/**
 * Get chains that have tokens with non-zero balance
 * @returns {Array} Array of chain objects with chainId
 */
export function getChainsWithBalance() {
  const chainIds = new Set();
  for (const [key, token] of Object.entries(walletState.registeredTokens)) {
    const balance = walletState.currentBalances[key];
    if (balance && parseFloat(balance.formatted || '0') > 0) {
      chainIds.add(token.chainId);
    }
  }
  return [...chainIds]
    .map(id => ({ chainId: id, ...walletState.registeredChains[id] }))
    .sort((a, b) => a.chainId - b.chainId);
}

/**
 * Sort tokens: native first, then by chainId, then alphabetically
 */
export function sortTokens(tokens) {
  return [...tokens].sort((a, b) => {
    // Native tokens first
    if (a.address === null && b.address !== null) return -1;
    if (a.address !== null && b.address === null) return 1;
    // Then by chain ID
    if (a.chainId !== b.chainId) return a.chainId - b.chainId;
    // Then by symbol
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * Render the asset list from registered tokens
 * Filters by selected chain and non-zero balance
 */
export function renderAssetList() {
  if (!assetListEl) return;

  assetListEl.innerHTML = '';

  // Use helper to get filtered tokens
  const filteredTokens = getTokensWithBalance(walletState.selectedChainId);
  const sortedTokens = sortTokens(filteredTokens);

  for (const token of sortedTokens) {
    const chain = walletState.registeredChains[token.chainId];
    const chainName = chain?.name || `Chain ${token.chainId}`;

    const row = document.createElement('div');
    row.className = 'asset-row';
    row.dataset.tokenKey = token.key;

    // Logo or placeholder
    const logoHtml = token.logo && token.builtin
      ? `<img class="asset-logo" src="assets/tokens/${token.logo}" alt="${token.symbol}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      : '';

    const placeholderHtml = `<div class="asset-logo-placeholder" style="${token.logo && token.builtin ? 'display:none' : ''}">${token.symbol.charAt(0)}</div>`;

    // Only show chain name when "All Chains" is selected
    const chainNameHtml = walletState.selectedChainId === null
      ? `<span class="asset-chain">${escapeHtml(chainName)}</span>`
      : '';

    row.innerHTML = `
      <div class="asset-info-wrapper">
        ${logoHtml}
        ${placeholderHtml}
        <div class="asset-info">
          <span class="asset-symbol">${escapeHtml(token.symbol)}</span>
          ${chainNameHtml}
        </div>
      </div>
      <span class="asset-value" id="balance-${token.key.replace(':', '-')}">--</span>
    `;

    assetListEl.appendChild(row);
  }

  // Show appropriate state message
  if (sortedTokens.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'asset-list-empty';

    if (Object.keys(walletState.currentBalances).length === 0) {
      // Balances not loaded yet
      emptyEl.textContent = 'Loading balances...';
    } else {
      // Balances loaded but all are zero
      emptyEl.textContent = 'No assets with balance';
    }

    assetListEl.appendChild(emptyEl);
  }

  // Update balance values for rendered elements
  for (const [tokenKey, balance] of Object.entries(walletState.currentBalances)) {
    const elementId = `balance-${tokenKey.replace(':', '-')}`;
    const balanceEl = document.getElementById(elementId);

    if (balanceEl && balance?.formatted) {
      balanceEl.textContent = formatBalance(balance.formatted);
    }
  }
}

/**
 * Display user wallet balances in the Wallet tab
 */
function displayUserBalances(balances) {
  if (!balances) return;

  // Store balances and re-render to show only non-zero assets
  walletState.currentBalances = balances;
  renderAssetList();
}

/**
 * Display Swarm node wallet balances in the Nodes tab
 */
function displaySwarmBalances(balances) {
  if (!balances) return;

  // xDAI balance (Gnosis native token)
  const xdaiKey = '100:native';
  const xdaiBalance = balances[xdaiKey];
  if (swarmBalanceXdaiEl) {
    if (xdaiBalance?.error) {
      swarmBalanceXdaiEl.textContent = 'Error';
      swarmBalanceXdaiEl.classList.add('error');
    } else if (xdaiBalance?.formatted) {
      swarmBalanceXdaiEl.textContent = formatBalance(xdaiBalance.formatted);
      swarmBalanceXdaiEl.classList.remove('error');
    } else {
      swarmBalanceXdaiEl.textContent = '--';
    }
  }

  // xBZZ balance (find the xBZZ token key)
  const xbzzKey = Object.keys(walletState.registeredTokens).find(key =>
    walletState.registeredTokens[key].symbol === 'xBZZ' && walletState.registeredTokens[key].chainId === 100
  );
  const xbzzBalance = xbzzKey ? balances[xbzzKey] : null;
  if (swarmBalanceXbzzEl) {
    if (xbzzBalance?.error) {
      swarmBalanceXbzzEl.textContent = 'Error';
      swarmBalanceXbzzEl.classList.add('error');
    } else if (xbzzBalance?.formatted) {
      swarmBalanceXbzzEl.textContent = formatBalance(xbzzBalance.formatted);
      swarmBalanceXbzzEl.classList.remove('error');
    } else {
      swarmBalanceXbzzEl.textContent = '--';
    }
  }
}

/**
 * Load cached balances for instant display on startup
 */
export async function loadCachedBalances() {
  const userAddress = walletState.fullAddresses.wallet;
  const swarmAddress = walletState.fullAddresses.swarm;

  if (!userAddress && !swarmAddress) return;

  try {
    const [userResult, swarmResult] = await Promise.all([
      userAddress ? window.wallet.getBalancesCached(userAddress) : Promise.resolve(null),
      swarmAddress ? window.wallet.getBalancesCached(swarmAddress) : Promise.resolve(null),
    ]);

    if (userResult?.success && userResult.balances) {
      displayUserBalances(userResult.balances);
    }

    if (swarmResult?.success && swarmResult.balances) {
      displaySwarmBalances(swarmResult.balances);
    }
  } catch (err) {
    console.error('[WalletUI] Failed to load cached balances:', err);
  }
}

/**
 * Start automatic balance refresh
 */
export function startBalanceRefresh() {
  stopBalanceRefresh();
  walletState.balanceRefreshInterval = setInterval(() => {
    // Only refresh if wallet tab is visible
    const walletTab = document.getElementById('tab-wallet');
    if (walletTab && !walletTab.classList.contains('hidden') && walletState.fullAddresses.wallet) {
      refreshBalances();
    }
  }, walletState.BALANCE_REFRESH_MS);
}

/**
 * Stop automatic balance refresh
 */
function stopBalanceRefresh() {
  if (walletState.balanceRefreshInterval) {
    clearInterval(walletState.balanceRefreshInterval);
    walletState.balanceRefreshInterval = null;
  }
}

function showBalanceError(message) {
  if (balanceErrorEl) {
    const textEl = document.getElementById('balance-error-text');
    if (textEl) {
      textEl.textContent = message;
    }
    balanceErrorEl.classList.remove('hidden');
  }
}

function hideBalanceError() {
  if (balanceErrorEl) {
    balanceErrorEl.classList.add('hidden');
  }
}
