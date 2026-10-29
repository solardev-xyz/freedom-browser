/**
 * RPC Manager
 *
 * Manages user-configured RPC provider API keys. The provider catalog and
 * resolved RPC URLs come from the network registry; user API keys are
 * stored in <userData>/rpc-api-keys.json.
 *
 * The file holds the user's provider API keys in plain JSON, so it is
 * owner-only (0600) on POSIX and replaced atomically (K-5). Encrypting it
 * belongs to the Rust core's profile secrets store (#644).
 */

const { app, ipcMain } = require('electron');
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
const API_KEYS_MODE = 0o600;

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
      restrictApiKeysMode(filePath);
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

// A file an older build wrote with the umask's mode (usually 0644).
function restrictApiKeysMode(filePath) {
  if (process.platform === 'win32') return;
  try {
    if ((fs.statSync(filePath).mode & 0o077) !== 0) fs.chmodSync(filePath, API_KEYS_MODE);
  } catch (err) {
    console.warn('[RpcManager] Could not restrict the API key file:', err.message);
  }
}

// Temp file (owner-only, created exclusively) → fsync → rename, so a crash
// or a full disk never leaves a truncated key file.
function saveApiKeys() {
  const filePath = getApiKeysPath();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = fs.openSync(tempPath, 'wx', API_KEYS_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify(apiKeysCache, null, 2), 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    fs.rmSync(tempPath, { force: true });
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

function registerRpcManagerIpc() {
  // The injected dApp provider resolves a chain's RPC pool through this.
  ipcMain.handle('rpc:get-effective-urls', (_event, chainId) => {
    return { success: true, urls: getEffectiveRpcUrls(chainId) };
  });

  console.log('[RpcManager] IPC handlers registered');
}

module.exports = {
  setApiKey,
  removeApiKey,
  hasApiKey,
  getEffectiveRpcUrls,
  testApiKey,
  registerRpcManagerIpc,
};
