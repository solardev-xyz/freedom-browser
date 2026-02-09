/**
 * Balance Service
 *
 * Fetches and caches wallet balances across chains.
 * Uses both in-memory cache (for speed) and persistent cache (for startup).
 * Dynamically fetches balances for all tokens registered in the chain registry.
 */

const { formatEther, formatUnits, Contract } = require('ethers');
const { getProvider, withRetry } = require('./provider-manager');
const { getTokens, isChainAvailable } = require('../chain-registry');
const persistentCache = require('./balance-cache');

// ERC-20 ABI (minimal for balance checking)
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];

// In-memory balance cache (for fast repeated lookups within session)
const balanceCache = new Map();
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Get native token balance for an address on a chain
 */
async function getNativeBalance(address, chainId, tokenInfo) {
  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    const balance = await withRetry(() => provider.getBalance(address));

    return {
      raw: balance.toString(),
      formatted: formatEther(balance),
      symbol: tokenInfo.symbol,
      decimals: tokenInfo.decimals,
    };
  } catch (err) {
    console.error(`[BalanceService] Failed to get native balance for ${address} on chain ${chainId}:`, err.message);
    throw err;
  }
}

/**
 * Get ERC-20 token balance for an address
 */
async function getTokenBalance(address, tokenAddress, chainId, tokenInfo) {
  const provider = getProvider(chainId);
  if (!provider) {
    throw new Error(`No provider available for chain ${chainId}`);
  }

  try {
    const contract = new Contract(tokenAddress, ERC20_ABI, provider);
    // Use token info from registry, but verify decimals from chain
    const [balance, decimals] = await withRetry(() =>
      Promise.all([contract.balanceOf(address), contract.decimals()])
    );

    return {
      raw: balance.toString(),
      formatted: formatUnits(balance, decimals),
      symbol: tokenInfo.symbol,
      decimals: Number(decimals),
      tokenAddress,
    };
  } catch (err) {
    console.error(`[BalanceService] Failed to get token balance for ${address} (${tokenAddress}) on chain ${chainId}:`, err.message);
    throw err;
  }
}

/**
 * Get all balances for an address (native + known tokens)
 * Returns balances keyed by token key (e.g., "1:native", "100:0xdBF3...")
 * On fetch errors, preserves previous cached values instead of showing errors.
 */
async function getAllBalances(address) {
  const cacheKey = `all:${address}`;
  const cached = balanceCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  // Get previous cached data to preserve values for tokens that error
  const previousData = cached?.data || persistentCache.getBalancesFromCache(address) || {};

  // Get all registered tokens from the chain registry
  const registeredTokens = getTokens();

  const balances = {
    lastUpdated: new Date().toISOString(),
  };

  // Fetch balances in parallel for all registered tokens
  const fetchPromises = [];

  for (const [tokenKey, tokenInfo] of Object.entries(registeredTokens)) {
    const chainId = tokenInfo.chainId;

    // Skip tokens on unavailable chains (no RPC configured)
    if (!isChainAvailable(chainId)) {
      // Preserve previous cached value if available
      if (previousData[tokenKey] && !previousData[tokenKey].error) {
        balances[tokenKey] = previousData[tokenKey];
      }
      continue;
    }

    if (tokenInfo.address === null) {
      // Native token
      fetchPromises.push(
        getNativeBalance(address, chainId, tokenInfo)
          .then((b) => {
            balances[tokenKey] = b;
          })
          .catch((err) => {
            console.error(`[BalanceService] ${tokenInfo.symbol} balance error:`, err.message);
            // Preserve previous cached value on error, don't show error to UI
            if (previousData[tokenKey] && !previousData[tokenKey].error) {
              balances[tokenKey] = previousData[tokenKey];
            }
            // If no previous value, token simply won't appear in balances
          })
      );
    } else {
      // ERC-20 token
      fetchPromises.push(
        getTokenBalance(address, tokenInfo.address, chainId, tokenInfo)
          .then((b) => {
            balances[tokenKey] = b;
          })
          .catch((err) => {
            console.error(`[BalanceService] ${tokenInfo.symbol} balance error:`, err.message);
            // Preserve previous cached value on error, don't show error to UI
            if (previousData[tokenKey] && !previousData[tokenKey].error) {
              balances[tokenKey] = previousData[tokenKey];
            }
            // If no previous value, token simply won't appear in balances
          })
      );
    }
  }

  await Promise.all(fetchPromises);

  // Cache the result (in-memory)
  balanceCache.set(cacheKey, {
    data: balances,
    timestamp: Date.now(),
  });

  // Also save to persistent cache (will merge with existing, preserving old values for errors)
  persistentCache.setCachedBalances(address, balances);

  return balances;
}

/**
 * Get balances with cache-first strategy
 * Returns cached data immediately if available, with flag indicating source.
 * Optionally fetches fresh data in background.
 *
 * @param {string} address - Wallet address
 * @param {boolean} fetchFresh - Whether to fetch fresh data (default: true)
 * @returns {Promise<{balances: object, fromCache: boolean}>}
 */
async function getBalancesWithCache(address, fetchFresh = true) {
  // Check in-memory cache first
  const cacheKey = `all:${address}`;
  const memoryCached = balanceCache.get(cacheKey);

  if (memoryCached && Date.now() - memoryCached.timestamp < CACHE_TTL_MS) {
    return { balances: memoryCached.data, fromCache: false }; // Fresh enough
  }

  // Check persistent cache
  const persistentCached = persistentCache.getBalancesFromCache(address);

  if (persistentCached) {
    // Return cached data immediately
    if (fetchFresh) {
      // Fetch fresh data in background (don't await)
      getAllBalances(address).catch((err) => {
        console.error('[BalanceService] Background refresh failed:', err.message);
      });
    }
    return { balances: persistentCached, fromCache: true };
  }

  // No cache available, must fetch
  if (fetchFresh) {
    const balances = await getAllBalances(address);
    return { balances, fromCache: false };
  }

  return { balances: null, fromCache: false };
}

/**
 * Clear balance cache for an address (both in-memory and persistent)
 */
function clearBalanceCache(address) {
  if (address) {
    balanceCache.delete(`all:${address}`);
    // Note: We don't clear persistent cache on normal refresh,
    // only in-memory cache. Persistent cache is for startup display.
  } else {
    balanceCache.clear();
  }
}

/**
 * Clear all caches including persistent
 */
function clearAllCaches(address) {
  clearBalanceCache(address);
  persistentCache.clearCache(address);
}

/**
 * Format balance for display (with max decimals)
 */
function formatBalanceForDisplay(formatted, maxDecimals = 4) {
  const num = parseFloat(formatted);
  if (isNaN(num)) return '0';

  if (num === 0) return '0';
  if (num < 0.0001) return '<0.0001';

  // Format with appropriate decimals
  return num.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

module.exports = {
  getNativeBalance,
  getTokenBalance,
  getAllBalances,
  getBalancesWithCache,
  clearBalanceCache,
  clearAllCaches,
  formatBalanceForDisplay,
};
