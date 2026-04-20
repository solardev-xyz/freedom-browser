/**
 * RPC Manager
 *
 * Manages user-configured RPC provider API keys and builds RPC URLs.
 * Providers are defined in src/shared/rpc-providers.json.
 * User API keys are stored in ~/.freedom-browser/rpc-api-keys.json.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Lazy-loaded to avoid circular dependencies
let providerManager = null;
function getProviderManager() {
  if (!providerManager) {
    providerManager = require('./provider-manager');
  }
  return providerManager;
}

// File paths
const API_KEYS_FILE = 'rpc-api-keys.json';
const CUSTOM_URLS_FILE = 'rpc-custom-urls.json';

// Cache
let apiKeysCache = null;
let providersCache = null;
let customUrlsCache = null;

/**
 * Get path to user's API keys file
 */
function getApiKeysPath() {
  return path.join(app.getPath('userData'), API_KEYS_FILE);
}

/**
 * Get path to builtin providers file
 */
function getProvidersPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'src', 'shared', 'rpc-providers.json');
  }
  return path.join(__dirname, '..', '..', 'shared', 'rpc-providers.json');
}

/**
 * Load builtin RPC providers
 */
function loadProviders() {
  if (providersCache) {
    return providersCache;
  }

  try {
    const filePath = getProvidersPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      providersCache = JSON.parse(data);
    } else {
      console.error('[RpcManager] Providers file not found:', filePath);
      providersCache = {};
    }
  } catch (err) {
    console.error('[RpcManager] Failed to load providers:', err);
    providersCache = {};
  }

  return providersCache;
}

/**
 * Load user's API keys from disk
 */
function loadApiKeys() {
  if (apiKeysCache !== null) {
    return apiKeysCache;
  }

  try {
    const filePath = getApiKeysPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      apiKeysCache = JSON.parse(data);
    } else {
      apiKeysCache = {};
    }
  } catch (err) {
    console.error('[RpcManager] Failed to load API keys:', err);
    apiKeysCache = {};
  }

  return apiKeysCache;
}

/**
 * Save API keys to disk
 */
function saveApiKeys() {
  try {
    const filePath = getApiKeysPath();
    fs.writeFileSync(filePath, JSON.stringify(apiKeysCache, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[RpcManager] Failed to save API keys:', err);
    return false;
  }
}

/**
 * Get path to user's custom RPC URLs file
 */
function getCustomUrlsPath() {
  return path.join(app.getPath('userData'), CUSTOM_URLS_FILE);
}

/**
 * Load user's custom RPC URLs from disk.
 * Shape: { entries: [{ id, chainId, url, label, addedAt }] }
 */
function loadCustomUrls() {
  if (customUrlsCache !== null) {
    return customUrlsCache;
  }

  try {
    const filePath = getCustomUrlsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      customUrlsCache = {
        entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
      };
    } else {
      customUrlsCache = { entries: [] };
    }
  } catch (err) {
    console.error('[RpcManager] Failed to load custom URLs:', err);
    customUrlsCache = { entries: [] };
  }

  return customUrlsCache;
}

/**
 * Save custom RPC URLs to disk
 */
function saveCustomUrls() {
  try {
    const filePath = getCustomUrlsPath();
    fs.writeFileSync(filePath, JSON.stringify(customUrlsCache, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[RpcManager] Failed to save custom URLs:', err);
    return false;
  }
}

/**
 * Validate a custom URL (http/https only, parseable).
 */
function isValidRpcUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Coerce a chainId input to a positive integer.
 */
function normalizeChainId(chainId) {
  const n = Number(chainId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/**
 * List custom RPC URLs, optionally filtered by chain.
 */
function listCustomUrls(chainId) {
  const { entries } = loadCustomUrls();
  if (chainId === undefined || chainId === null) return entries.slice();
  const n = normalizeChainId(chainId);
  if (n === null) return [];
  return entries.filter((e) => e.chainId === n);
}

/**
 * Add a custom RPC URL entry.
 */
function addCustomUrl({ chainId, url, label }) {
  const n = normalizeChainId(chainId);
  if (n === null) {
    return { success: false, error: 'Invalid chainId' };
  }
  if (!isValidRpcUrl(url)) {
    return { success: false, error: 'URL must be a valid http(s) endpoint' };
  }

  const store = loadCustomUrls();
  const trimmedUrl = url.trim();
  if (store.entries.some((e) => e.chainId === n && e.url === trimmedUrl)) {
    return { success: false, error: 'This URL is already configured for this chain' };
  }

  const entry = {
    id: `cust_${crypto.randomBytes(8).toString('hex')}`,
    chainId: n,
    url: trimmedUrl,
    label: typeof label === 'string' ? label.trim() : '',
    addedAt: Date.now(),
  };
  store.entries.push(entry);
  customUrlsCache = store;

  if (!saveCustomUrls()) {
    return { success: false, error: 'Failed to save custom URL' };
  }

  getProviderManager().onApiKeysChanged();
  console.log(`[RpcManager] Custom URL added: ${entry.id} chain=${n}`);
  return { success: true, entry };
}

/**
 * Update a custom RPC URL entry. Only url, label, and chainId are updatable.
 */
function updateCustomUrl(id, patch) {
  if (typeof id !== 'string' || !id) {
    return { success: false, error: 'Invalid entry id' };
  }
  const store = loadCustomUrls();
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    return { success: false, error: 'Entry not found' };
  }

  const updated = { ...store.entries[idx] };
  if (patch.chainId !== undefined) {
    const n = normalizeChainId(patch.chainId);
    if (n === null) return { success: false, error: 'Invalid chainId' };
    updated.chainId = n;
  }
  if (patch.url !== undefined) {
    if (!isValidRpcUrl(patch.url)) {
      return { success: false, error: 'URL must be a valid http(s) endpoint' };
    }
    updated.url = patch.url.trim();
  }
  if (patch.label !== undefined) {
    updated.label = typeof patch.label === 'string' ? patch.label.trim() : '';
  }

  // Reject a rename that collides with another entry
  if (store.entries.some((e, i) => i !== idx && e.chainId === updated.chainId && e.url === updated.url)) {
    return { success: false, error: 'Another entry already uses this URL for this chain' };
  }

  store.entries[idx] = updated;
  customUrlsCache = store;

  if (!saveCustomUrls()) {
    return { success: false, error: 'Failed to save custom URL' };
  }

  getProviderManager().onApiKeysChanged();
  return { success: true, entry: updated };
}

/**
 * Remove a custom RPC URL entry by id.
 */
function removeCustomUrl(id) {
  const store = loadCustomUrls();
  const idx = store.entries.findIndex((e) => e.id === id);
  if (idx === -1) {
    return { success: false, error: 'Entry not found' };
  }
  store.entries.splice(idx, 1);
  customUrlsCache = store;

  if (!saveCustomUrls()) {
    return { success: false, error: 'Failed to save custom URL' };
  }

  getProviderManager().onApiKeysChanged();
  console.log(`[RpcManager] Custom URL removed: ${id}`);
  return { success: true };
}

/**
 * Test a custom URL by calling eth_chainId. If expectedChainId is provided,
 * verify the endpoint responds with that chain id.
 */
async function testCustomUrl(url, expectedChainId) {
  if (!isValidRpcUrl(url)) {
    return { success: false, error: 'URL must be a valid http(s) endpoint' };
  }

  try {
    const response = await fetch(url.trim(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error.message || 'RPC error' };
    }

    if (!data.result) {
      return { success: false, error: 'Invalid response from RPC' };
    }

    const returnedChainId = parseInt(data.result, 16);
    const expected = expectedChainId === undefined || expectedChainId === null
      ? null
      : normalizeChainId(expectedChainId);

    if (expected !== null && returnedChainId !== expected) {
      return {
        success: false,
        error: `URL reports chainId ${returnedChainId}, but expected ${expected}`,
        chainId: returnedChainId,
      };
    }

    return { success: true, chainId: returnedChainId };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get all available providers (from builtin config)
 */
function getProviders() {
  return loadProviders();
}

/**
 * Get a specific provider by ID
 */
function getProvider(providerId) {
  const providers = loadProviders();
  return providers[providerId] || null;
}

/**
 * Get API key for a provider
 */
function getApiKey(providerId) {
  const apiKeys = loadApiKeys();
  return apiKeys[providerId]?.apiKey || null;
}

/**
 * Set API key for a provider
 */
function setApiKey(providerId, apiKey) {
  const providers = loadProviders();
  if (!providers[providerId]) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }

  const apiKeys = loadApiKeys();
  apiKeys[providerId] = {
    apiKey,
    enabled: true,
    addedAt: Date.now(),
  };
  apiKeysCache = apiKeys;

  if (!saveApiKeys()) {
    return { success: false, error: 'Failed to save API key' };
  }

  // Notify provider manager to clear cached providers
  getProviderManager().onApiKeysChanged();

  console.log(`[RpcManager] API key set for provider: ${providerId}`);
  return { success: true };
}

/**
 * Remove API key for a provider
 */
function removeApiKey(providerId) {
  const apiKeys = loadApiKeys();

  if (!apiKeys[providerId]) {
    return { success: false, error: `No API key found for provider: ${providerId}` };
  }

  delete apiKeys[providerId];
  apiKeysCache = apiKeys;

  if (!saveApiKeys()) {
    return { success: false, error: 'Failed to save changes' };
  }

  // Notify provider manager to clear cached providers
  getProviderManager().onApiKeysChanged();

  console.log(`[RpcManager] API key removed for provider: ${providerId}`);
  return { success: true };
}

/**
 * Get list of providers that have API keys configured
 */
function getConfiguredProviders() {
  const apiKeys = loadApiKeys();
  return Object.keys(apiKeys).filter((id) => apiKeys[id]?.apiKey && apiKeys[id]?.enabled);
}

/**
 * Check if a provider has an API key configured
 */
function hasApiKey(providerId) {
  const apiKeys = loadApiKeys();
  return !!(apiKeys[providerId]?.apiKey && apiKeys[providerId]?.enabled);
}

/**
 * Build RPC URL for a provider and chain
 * @param {string} providerId - Provider ID (e.g., 'alchemy')
 * @param {number|string} chainId - Chain ID
 * @returns {string|null} - Full RPC URL with API key substituted, or null if not available
 */
function getRpcUrl(providerId, chainId) {
  const provider = getProvider(providerId);
  if (!provider) return null;

  const template = provider.chains[String(chainId)];
  if (!template) return null;

  const apiKey = getApiKey(providerId);
  if (!apiKey) return null;

  return template.replace('{API_KEY}', apiKey);
}

/**
 * Get all effective RPC URLs for a chain.
 * Priority: user-configured custom URLs first, then configured providers.
 * @param {number|string} chainId - Chain ID
 * @returns {string[]} - Array of RPC URLs (deduped)
 */
function getEffectiveRpcUrls(chainId) {
  const chainIdStr = String(chainId);
  const normalized = normalizeChainId(chainId);
  const urls = [];
  const seen = new Set();

  // Custom URLs for this chain come first — user opted in explicitly
  if (normalized !== null) {
    for (const entry of listCustomUrls(normalized)) {
      if (!seen.has(entry.url)) {
        urls.push(entry.url);
        seen.add(entry.url);
      }
    }
  }

  // Configured providers that support this chain
  const configuredProviders = getConfiguredProviders();
  const providers = loadProviders();

  for (const providerId of configuredProviders) {
    const provider = providers[providerId];
    if (provider?.chains[chainIdStr]) {
      const url = getRpcUrl(providerId, chainId);
      if (url && !seen.has(url)) {
        urls.push(url);
        seen.add(url);
      }
    }
  }

  return urls;
}

/**
 * Get chains supported by configured providers
 * @returns {string[]} - Array of chain IDs (as strings)
 */
function getProviderSupportedChains() {
  const configuredProviders = getConfiguredProviders();
  const providers = loadProviders();
  const chainIds = new Set();

  for (const providerId of configuredProviders) {
    const provider = providers[providerId];
    if (provider?.chains) {
      Object.keys(provider.chains).forEach((chainId) => chainIds.add(chainId));
    }
  }

  // Custom URLs also contribute supported chains
  for (const entry of listCustomUrls()) {
    chainIds.add(String(entry.chainId));
  }

  return Array.from(chainIds);
}

/**
 * Test an API key by making a simple RPC call
 * @param {string} providerId - Provider ID
 * @param {string} apiKey - API key to test
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testApiKey(providerId, apiKey) {
  const provider = getProvider(providerId);
  if (!provider) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }

  // Find a chain to test with (prefer Ethereum mainnet, fall back to first available)
  const chainIds = Object.keys(provider.chains);
  const testChainId = chainIds.includes('1') ? '1' : chainIds[0];

  if (!testChainId) {
    return { success: false, error: 'Provider has no chains configured' };
  }

  const template = provider.chains[testChainId];
  const url = template.replace('{API_KEY}', apiKey);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_chainId',
        params: [],
      }),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();

    if (data.error) {
      return { success: false, error: data.error.message || 'RPC error' };
    }

    if (data.result) {
      return { success: true, chainId: data.result };
    }

    return { success: false, error: 'Invalid response from RPC' };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Clear caches (useful when providers file changes)
 */
function clearCaches() {
  apiKeysCache = null;
  providersCache = null;
  customUrlsCache = null;
}

/**
 * Register IPC handlers for RPC management
 */
function registerRpcManagerIpc() {
  // Get all available providers (from builtin config)
  ipcMain.handle('rpc:get-providers', () => {
    const providers = getProviders();
    // Return provider info without exposing internal details
    const result = {};
    for (const [id, provider] of Object.entries(providers)) {
      result[id] = {
        id,
        name: provider.name,
        website: provider.website,
        docsUrl: provider.docsUrl,
        supportedChains: Object.keys(provider.chains),
      };
    }
    return { success: true, providers: result };
  });

  // Get list of providers that have API keys configured (returns IDs only, not keys)
  ipcMain.handle('rpc:get-configured-providers', () => {
    return { success: true, providers: getConfiguredProviders() };
  });

  // Check if a specific provider has an API key
  ipcMain.handle('rpc:has-api-key', (_event, providerId) => {
    return { success: true, hasKey: hasApiKey(providerId) };
  });

  // Set API key for a provider
  ipcMain.handle('rpc:set-api-key', (_event, providerId, apiKey) => {
    return setApiKey(providerId, apiKey);
  });

  // Remove API key for a provider
  ipcMain.handle('rpc:remove-api-key', (_event, providerId) => {
    return removeApiKey(providerId);
  });

  // Test an API key before saving
  ipcMain.handle('rpc:test-api-key', async (_event, providerId, apiKey) => {
    return testApiKey(providerId, apiKey);
  });

  // Get chains that are supported by configured providers
  ipcMain.handle('rpc:get-provider-supported-chains', () => {
    return { success: true, chains: getProviderSupportedChains() };
  });

  // List all custom RPC URLs (optionally filtered by chain)
  ipcMain.handle('rpc:list-custom-urls', (_event, chainId) => {
    try {
      return { success: true, entries: listCustomUrls(chainId) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // Add a custom RPC URL
  ipcMain.handle('rpc:add-custom-url', (_event, params) => {
    return addCustomUrl(params || {});
  });

  // Update a custom RPC URL
  ipcMain.handle('rpc:update-custom-url', (_event, id, patch) => {
    return updateCustomUrl(id, patch || {});
  });

  // Remove a custom RPC URL
  ipcMain.handle('rpc:remove-custom-url', (_event, id) => {
    return removeCustomUrl(id);
  });

  // Test a custom RPC URL (optionally verifying the returned chainId)
  ipcMain.handle('rpc:test-custom-url', async (_event, url, expectedChainId) => {
    return testCustomUrl(url, expectedChainId);
  });

  // Get effective RPC URLs for a chain: user-configured endpoints first
  // (custom URLs, then provider templates), then built-in public RPCs.
  ipcMain.handle('rpc:get-effective-urls', (_event, chainId) => {
    const { getChain } = require('./chains');
    const chain = getChain(chainId);
    const urls = getEffectiveRpcUrls(chainId);
    const seen = new Set(urls);

    for (const url of chain?.rpcUrls || []) {
      if (!seen.has(url)) {
        urls.push(url);
        seen.add(url);
      }
    }
    return { success: true, urls };
  });

  console.log('[RpcManager] IPC handlers registered');
}

module.exports = {
  loadProviders,
  getProviders,
  getProvider,
  loadApiKeys,
  getApiKey,
  setApiKey,
  removeApiKey,
  getConfiguredProviders,
  hasApiKey,
  getRpcUrl,
  getEffectiveRpcUrls,
  getProviderSupportedChains,
  testApiKey,
  listCustomUrls,
  addCustomUrl,
  updateCustomUrl,
  removeCustomUrl,
  testCustomUrl,
  clearCaches,
  registerRpcManagerIpc,
};
