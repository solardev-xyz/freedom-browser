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
const { normalizeTokenKey } = require('../token-registry');

// Cache file path
const CACHE_FILE = path.join(app.getPath('userData'), 'balance-cache.json');

// Current cache version: 2 for the "<chainId>:<asset>" token keys, 3 once
// every key is normalized the way the token registry emits them (#104).
const CACHE_VERSION = 3;

// Version 2 predates token-key normalization (400dd6f): its token keys can
// still carry EIP-55 checksum casing. Fresh fetches only ever wrote the
// normalized key, so where both are present the normalized entry is the
// newer one; a legacy key on its own is renamed, keeping its balance.
const KEY_NORMALIZED_FROM_VERSION = 2;

function normalizeEntryKeys(entry) {
  const normalized = {};
  const legacy = [];
  for (const [key, value] of Object.entries(entry || {})) {
    const normalizedKey = key === 'updatedAt' ? key : normalizeTokenKey(key);
    if (normalizedKey === key) normalized[key] = value;
    else legacy.push([normalizedKey, value]);
  }
  for (const [key, value] of legacy) {
    if (!Object.hasOwn(normalized, key)) normalized[key] = value;
  }
  return normalized;
}

function migrateFromVersion2(parsed) {
  const balances = {};
  for (const [address, entry] of Object.entries(parsed.balances || {})) {
    balances[address] = normalizeEntryKeys(entry);
  }
  return { version: CACHE_VERSION, balances };
}

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
  let migrated = false;

  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = fs.readFileSync(CACHE_FILE, 'utf8');
      const parsed = JSON.parse(data);

      // Version check: migrate a version-2 cache, discard older formats
      if (parsed.version === CACHE_VERSION) {
        cache = parsed;
      } else if (parsed.version === KEY_NORMALIZED_FROM_VERSION) {
        cache = migrateFromVersion2(parsed);
        migrated = true;
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
  if (migrated) saveCache();
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

    cached[normalizeTokenKey(tokenKey)] = {
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
