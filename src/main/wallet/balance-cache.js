/**
 * Balance Cache
 *
 * Persistent cache for wallet balances across addresses and chains.
 * Allows showing last-known balances immediately on app startup.
 * Stores balances using dynamic token keys (e.g., "1:native", "100:0xdBF3...").
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// Cache file path
const CACHE_FILE = path.join(app.getPath('userData'), 'balance-cache.json');

// Current cache version (bumped to 2 for new token key format)
const CACHE_VERSION = 2;

// In-memory cache
let cache = {
  version: CACHE_VERSION,
  balances: {},
};

// Whether cache has been loaded
let cacheLoaded = false;

/**
 * Load cache from disk
 */
function loadCache() {
  if (cacheLoaded) return;

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);

      // Version check - discard old format caches
      if (parsed.version === CACHE_VERSION) {
        cache = parsed;
      } else {
        console.log('[BalanceCache] Cache version mismatch, starting fresh');
        cache = { version: CACHE_VERSION, balances: {} };
      }
    }
  } catch (err) {
    console.error('[BalanceCache] Failed to load cache:', err.message);
    cache = { version: CACHE_VERSION, balances: {} };
  }

  cacheLoaded = true;
  console.log('[BalanceCache] Loaded cache with', Object.keys(cache.balances).length, 'addresses');
}

/**
 * Save cache to disk
 */
function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('[BalanceCache] Failed to save cache:', err.message);
  }
}

/**
 * Get cached balances for an address
 * @param {string} address - Wallet address
 * @returns {object|null} Cached balance data or null if not cached
 */
function getCachedBalances(address) {
  loadCache();
  const normalizedAddress = address.toLowerCase();
  return cache.balances[normalizedAddress] || null;
}

/**
 * Set cached balances for an address
 * Stores balances using dynamic token keys from the chain registry.
 * Merges with existing cached values to preserve data for tokens that errored.
 * @param {string} address - Wallet address
 * @param {object} balances - Balance data from getAllBalances()
 */
function setCachedBalances(address, balances) {
  loadCache();
  const normalizedAddress = address.toLowerCase();

  // Get existing cached data to preserve values for tokens that errored
  const existing = cache.balances[normalizedAddress] || {};

  // Start with existing cached values, then update with new successful fetches
  const cached = {
    ...existing,
    updatedAt: Date.now(),
  };

  // Update with new successful balances (errors are skipped, preserving old values)
  for (const [tokenKey, balance] of Object.entries(balances)) {
    // Skip metadata fields and error entries
    if (tokenKey === 'lastUpdated' || tokenKey === 'fromCache') continue;
    if (balance?.error) continue;

    cached[tokenKey] = {
      formatted: balance.formatted,
      symbol: balance.symbol,
      raw: balance.raw,
      decimals: balance.decimals,
    };
  }

  cache.balances[normalizedAddress] = cached;
  saveCache();
}

/**
 * Get cached balances in getAllBalances() format
 * @param {string} address - Wallet address
 * @returns {object|null} Balance data or null if not cached
 */
function getBalancesFromCache(address) {
  const cached = getCachedBalances(address);
  if (!cached) return null;

  // Convert cached format back to getAllBalances() format
  const balances = {
    lastUpdated: new Date(cached.updatedAt).toISOString(),
    fromCache: true,
  };

  // Copy all token balances
  for (const [key, value] of Object.entries(cached)) {
    if (key === 'updatedAt') continue;
    balances[key] = { ...value };
  }

  return balances;
}

/**
 * Clear cache for a specific address
 * @param {string} address - Wallet address (optional, clears all if not provided)
 */
function clearCache(address) {
  loadCache();

  if (address) {
    const normalizedAddress = address.toLowerCase();
    delete cache.balances[normalizedAddress];
  } else {
    cache.balances = {};
  }

  saveCache();
}

/**
 * Get cache age in milliseconds
 * @param {string} address - Wallet address
 * @returns {number|null} Age in ms or null if not cached
 */
function getCacheAge(address) {
  const cached = getCachedBalances(address);
  if (!cached || !cached.updatedAt) return null;
  return Date.now() - cached.updatedAt;
}

module.exports = {
  loadCache,
  getCachedBalances,
  setCachedBalances,
  getBalancesFromCache,
  clearCache,
  getCacheAge,
};
