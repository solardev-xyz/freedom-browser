/**
 * RPC Manager
 *
 * Manages user-configured RPC provider API keys. The provider catalog and
 * resolved RPC URLs come from the network registry; user API keys are
 * stored in <userData>/rpc-api-keys.json.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const registry = require('../networks/network-registry');

// Lazy-loaded to avoid circular dependencies
let providerManager = null;
function getProviderManager() {
  if (!providerManager) {
    providerManager = require('./provider-manager');
  }
  return providerManager;
}

const API_KEYS_FILE = 'rpc-api-keys.json';

let apiKeysCache = null;

function getApiKeysPath() {
  return path.join(app.getPath('userData'), API_KEYS_FILE);
}

// The keyed-provider catalog (Alchemy/Infura/DRPC) from the network
// registry, keyed by id. Each entry: { id, role, keyed, name, website,
// docsUrl, coverage } where coverage maps chainId -> URL template.
function loadProviders() {
  return registry.getKeyedSources('rpc');
}

function getProvider(providerId) {
  return loadProviders()[providerId] || null;
}

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

function saveApiKeys() {
  try {
    fs.writeFileSync(getApiKeysPath(), JSON.stringify(apiKeysCache, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[RpcManager] Failed to save API keys:', err);
    return false;
  }
}

/**
 * Set the API key for a keyed provider.
 */
function setApiKey(providerId, apiKey) {
  if (!loadProviders()[providerId]) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }

  const apiKeys = loadApiKeys();
  apiKeys[providerId] = { apiKey, enabled: true, addedAt: Date.now() };
  apiKeysCache = apiKeys;

  if (!saveApiKeys()) {
    return { success: false, error: 'Failed to save API key' };
  }

  getProviderManager().onApiKeysChanged();
  console.log(`[RpcManager] API key set for provider: ${providerId}`);
  return { success: true };
}

/**
 * Remove the API key for a keyed provider.
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

  getProviderManager().onApiKeysChanged();
  console.log(`[RpcManager] API key removed for provider: ${providerId}`);
  return { success: true };
}

/**
 * Whether a keyed provider has an API key configured and enabled.
 */
function hasApiKey(providerId) {
  const entry = loadApiKeys()[providerId];
  return !!(entry?.apiKey && entry?.enabled);
}

/**
 * All resolved RPC URLs for a chain — the registry's rpc-role endpoint
 * pool: keyless builtin RPCs plus keyed providers with a configured key.
 * @param {number|string} chainId - Chain ID
 * @returns {string[]} - Array of RPC URLs
 */
function getEffectiveRpcUrls(chainId) {
  return registry.getEndpoints(chainId, 'rpc');
}

/**
 * The chain's RPC pool without the keyed providers, in the same order:
 * the URLs that may leave main. A keyed provider's resolved URL carries
 * the user's API key (#1040).
 * @param {number|string} chainId - Chain ID
 * @returns {string[]} - Array of RPC URLs
 */
function getKeylessRpcUrls(chainId) {
  const cid = String(chainId);
  return registry
    .getEndpointSources(cid, 'rpc')
    .filter((src) => !src.keyed)
    .map((src) => src.coverage[cid])
    .filter((url) => typeof url === 'string');
}

/**
 * Test a candidate API key by making a simple eth_chainId call.
 * @param {string} providerId - Provider ID
 * @param {string} apiKey - API key to test
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function testApiKey(providerId, apiKey) {
  const provider = getProvider(providerId);
  if (!provider) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }

  // Prefer Ethereum mainnet, fall back to the first covered chain.
  const chainIds = Object.keys(provider.coverage);
  const testChainId = chainIds.includes('1') ? '1' : chainIds[0];
  if (!testChainId) {
    return { success: false, error: 'Provider has no chains configured' };
  }

  const url = provider.coverage[testChainId].replace('{API_KEY}', apiKey);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
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

module.exports = {
  setApiKey,
  removeApiKey,
  hasApiKey,
  getEffectiveRpcUrls,
  getKeylessRpcUrls,
  testApiKey,
};
