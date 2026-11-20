/**
 * RPC Manager
 *
 * The user's RPC provider API keys, which the identity core keeps
 * (freedom-core design 0013, "RPC API keys"; PRF-6(e)): the hello names
 * `rpc_api_keys` in `store_moved` (core-client.js), so the core is their one
 * writer. It puts each key in the profile's secrets file where it has a key
 * store (macOS), and writes rpc-api-keys.json in today's format where it
 * has none (Linux and Windows until PRF-7). Main opens neither. The
 * provider catalog and resolved RPC URLs come from the network registry.
 *
 * - **Main's copy of the keys,** for the requests main runs itself (the
 *   registry substitutes them into keyed providers' URLs): read from
 *   `secrets.rpc_api_keys` (`shell`) at each start of the core
 *   (`attachCore`) and after each set or remove. Until the first read
 *   answers, the keyed providers are left out and only the keyless pool
 *   is used. A read that changes the keys drops the providers built with
 *   the old ones and tells `onKeysChanged`'s listeners.
 * - **A set or a remove** goes as its caller's (`chrome` when the settings
 *   page's, relayed by network-ipc.js), after main checks the provider in
 *   its registry, as before. The core refuses a provider id outside its
 *   entry form and, where it has a key store, a 17th key.
 * - **Presence** for the settings page comes from
 *   `secrets.rpc_api_key_status` (`providersWithKeys`), which opens no key.
 * - Every request goes with `requires` (vault-backend.js): on a core that
 *   didn't take the store (0.22.0) it fails `requirement_unmet` in main,
 *   and main's copy stays as it was (empty from the start).
 */

const registry = require('../networks/network-registry');

// Lazy-loaded to avoid circular dependencies
let providerManager = null;
function getProviderManager() {
  if (!providerManager) {
    providerManager = require('./provider-manager');
  }
  return providerManager;
}

function vault() {
  return require('../core/vault-backend').vaultBackend;
}

/** Main's copy: provider id -> key. Replaced whole, never changed. */
let apiKeys = new Map();
let attachedCore = null;
// Reads of the core's keys started, and the latest whose answer is applied.
let readsStarted = 0;
let readApplied = 0;
const listeners = new Set();

// The keyed-provider catalog (Alchemy/Infura/DRPC) from the network
// registry, keyed by id. Each entry: { id, role, keyed, name, website,
// docsUrl, coverage } where coverage maps chainId -> URL template.
function loadProviders() {
  return registry.getKeyedSources('rpc');
}

function getProvider(providerId) {
  return loadProviders()[providerId] || null;
}

function inRegistry(providerId) {
  return typeof providerId === 'string' && Object.hasOwn(loadProviders(), providerId);
}

function sameKeys(a, b) {
  if (a.size !== b.size) return false;
  for (const [id, key] of a) {
    if (b.get(id) !== key) return false;
  }
  return true;
}

/** The core's `{ keys: [{ id, api_key }] }` as id -> key, each a non-empty string. */
function keysOf(answer) {
  const out = new Map();
  for (const entry of Array.isArray(answer?.keys) ? answer.keys : []) {
    if (typeof entry?.id === 'string' && typeof entry.api_key === 'string' && entry.api_key) {
      out.set(entry.id, entry.api_key);
    }
  }
  return out;
}

function keysChanged() {
  getProviderManager().onApiKeysChanged();
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.error('[RpcManager] A key-change listener failed:', err?.message || err);
    }
  }
}

/**
 * Main's copy read again from the core. Whether it changed; an answer
 * that arrives after a later read's is dropped.
 */
async function refreshKeys() {
  const read = ++readsStarted;
  const next = keysOf(await vault().secrets.rpcApiKeys());
  if (read < readApplied) return false;
  readApplied = read;
  if (sameKeys(apiKeys, next)) return false;
  apiKeys = next;
  keysChanged();
  return true;
}

function refreshQuietly() {
  return refreshKeys().catch((err) => {
    console.error('[RpcManager] Failed to read the RPC API keys from the core:', err?.message || err);
    return false;
  });
}

/**
 * core-process.js: main's copy follows `client`, the core client, read at
 * each of its starts. One client at a time; the same one again is a no-op.
 */
function attachCore(client) {
  if (!client || typeof client.on !== 'function' || client === attachedCore) return;
  attachedCore = client;
  client.on('ready', () => {
    refreshQuietly();
  });
}

/** `listener()` after each change to main's copy of the keys. */
function onKeysChanged(listener) {
  if (typeof listener === 'function') listeners.add(listener);
}

/** Main's copy of the keys, provider id -> key: for main's own requests only. */
function cachedApiKeys() {
  return apiKeys;
}

const SAVE = Object.freeze({
  fallback: 'Failed to save API key',
  keychain:
    "Freedom couldn't use the system keychain, so the API key wasn't saved. " +
    'Try again, and allow Freedom to use the keychain if macOS asks.',
  storage: "Freedom couldn't save the API key. Try again, and contact support if it keeps failing.",
});
const REMOVE = Object.freeze({
  fallback: 'Failed to save changes',
  keychain:
    "Freedom couldn't use the system keychain, so the API key wasn't removed. " +
    'Try again, and allow Freedom to use the keychain if macOS asks.',
  storage:
    "Freedom couldn't remove the API key. Try again, and contact support if it keeps failing.",
});

/** What the settings page shows for the core's refusal of a set or a remove. */
function keyErrorMessage(err, texts = SAVE) {
  switch (err?.code) {
    case 'invalid_argument':
      switch (err.data?.rule) {
        case 'rpc-key-provider-id':
          return (
            "Freedom can't keep an API key for this provider: its ID must be 1 to 52 " +
            'lowercase letters, digits, dots, dashes or underscores.'
          );
        case 'rpc-keys-bound':
          return 'Freedom keeps at most 16 RPC API keys. Remove one, then try again.';
        case 'rpc-key-size':
          return 'An API key must be 1 to 1,024 bytes long.';
        case 'rpc-keys-file-size':
          return 'The saved API keys would take more than 1 MiB. Remove one, then try again.';
        default:
          return 'Invalid API key';
      }
    case 'key_store_unavailable':
    case 'key_store_cancelled':
      return texts.keychain;
    case 'storage':
      if (err.data?.kind === 'not_durable') {
        return (
          "Freedom couldn't finish saving the API key, so the provider's previous key " +
          'stays in use. Try again.'
        );
      }
      return texts.storage;
    default:
      return err?.message || texts.fallback;
  }
}

/**
 * Set the API key for a keyed provider, as `caller` (`'chrome'` when the
 * settings page's; null, main's own, by default).
 */
async function setApiKey(providerId, apiKey, { caller = null } = {}) {
  if (!inRegistry(providerId)) {
    return { success: false, error: `Unknown provider: ${providerId}` };
  }
  try {
    const answer = await vault().secrets.setRpcApiKey({ id: providerId, api_key: apiKey }, caller);
    if (answer?.durable === false) {
      console.warn(`[RpcManager] API key for ${providerId} set, but not yet durable`);
    }
  } catch (err) {
    return { success: false, error: keyErrorMessage(err, SAVE) };
  }
  await refreshQuietly();
  console.log(`[RpcManager] API key set for provider: ${providerId}`);
  return { success: true };
}

/**
 * Remove the API key for a keyed provider, as `caller`. A key main's copy
 * has for a provider no longer in the registry stays removable.
 */
async function removeApiKey(providerId, { caller = null } = {}) {
  if (typeof providerId !== 'string' || !(apiKeys.has(providerId) || inRegistry(providerId))) {
    return { success: false, error: `No API key found for provider: ${providerId}` };
  }
  try {
    const answer = await vault().secrets.removeRpcApiKey({ id: providerId }, caller);
    if (answer?.durable === false) {
      console.warn(`[RpcManager] API key for ${providerId} removed, but not yet durably`);
    }
  } catch (err) {
    return { success: false, error: keyErrorMessage(err, REMOVE) };
  }
  await refreshQuietly();
  console.log(`[RpcManager] API key removed for provider: ${providerId}`);
  return { success: true };
}

/**
 * Whether a keyed provider has an API key, in main's copy.
 */
function hasApiKey(providerId) {
  return typeof providerId === 'string' && apiKeys.has(providerId);
}

/**
 * The providers with a key, as the core answers `secrets.rpc_api_key_status`
 * to `caller` (`'chrome'` for the settings page): a Set of ids. It opens no
 * key. Throws the core's refusal.
 */
async function providersWithKeys({ caller = null } = {}) {
  const { providers } = await vault().secrets.rpcApiKeyStatus(caller);
  return new Set(
    (Array.isArray(providers) ? providers : [])
      .filter((provider) => provider?.present === true && typeof provider.id === 'string')
      .map((provider) => provider.id)
  );
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
  attachCore,
  refreshKeys,
  onKeysChanged,
  cachedApiKeys,
  setApiKey,
  removeApiKey,
  hasApiKey,
  providersWithKeys,
  getEffectiveRpcUrls,
  getKeylessRpcUrls,
  testApiKey,
};
