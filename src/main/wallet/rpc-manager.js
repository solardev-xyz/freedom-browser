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

// Cache
let apiKeysCache = null;
let providersCache = null;

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
 * Get all effective RPC URLs for a chain
 * Priority: configured providers (in order of configuration)
 * @param {number|string} chainId - Chain ID
 * @returns {string[]} - Array of RPC URLs
 */
function getEffectiveRpcUrls(chainId) {
  const chainIdStr = String(chainId);
  const urls = [];

  // Get URLs from all configured providers that support this chain
  const configuredProviders = getConfiguredProviders();
  const providers = loadProviders();

  for (const providerId of configuredProviders) {
    const provider = providers[providerId];
    if (provider?.chains[chainIdStr]) {
      const url = getRpcUrl(providerId, chainId);
      if (url) {
        urls.push(url);
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

  // Get effective RPC URLs for a chain (built-in public RPCs first, then provider URLs)
  ipcMain.handle('rpc:get-effective-urls', (_event, chainId) => {
    const { getChain } = require('./chains');
    const chain = getChain(chainId);
    const builtinUrls = chain?.rpcUrls || [];
    const providerUrls = getEffectiveRpcUrls(chainId);
    // Deduplicate: built-in public RPCs first, then provider URLs
    const seen = new Set(builtinUrls);
    const urls = [...builtinUrls];
    for (const url of providerUrls) {
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
  clearCaches,
  registerRpcManagerIpc,
};
