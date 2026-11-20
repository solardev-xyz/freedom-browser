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
 *   is used. A change to the copy drops the providers built with the old
 *   keys and tells `onKeysChanged`'s listeners. Each read takes a new
 *   generation, and an answer to any but the latest started is dropped.
 * - **A set or a remove the core has taken** is applied to main's copy at
 *   once, before the keys are read back: a key the user removed or
 *   replaced is never used again, even when that read fails. A failed read
 *   back keeps the applied copy and is retried with a bounded backoff, and
 *   again at the core's next start.
 * - **The committed-change fence:** each set or remove the core took leaves
 *   a fence on its provider: "no key" after a remove, exactly the new key
 *   after a set. A read that contradicts a provider's fence (a read back
 *   that still has the removed key, or a core that rolled the change back
 *   at a restart) never changes that provider's entry in main's copy; the
 *   other providers apply as usual. The fence clears only when a read
 *   confirms it. A change the core answered `durable: false` is confirmed
 *   only by a read from a later start of the core, since a restart may
 *   lose it. On a contradicting read, main sends the change again once in
 *   that start of the core (a remove as a remove, a set with the key main
 *   holds) and reads back. If that fails too, main logs it and keeps
 *   failing closed until a later start sends it again: a key the user
 *   removed or replaced is never used again because a core read has it.
 * - **Keys taken out of the copy** stay known to the registry's redaction
 *   (`retiredApiKeys`) for the rest of the process, never used for a
 *   request: one already in flight may be answered with an error quoting
 *   its key.
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
// The latest generation of main's copy: each read, and each set or remove
// applied, takes the next. A read's answer applies only while its
// generation is still the latest.
let generation = 0;
// The core's starts main has seen (`ready`), counted.
let coreStart = 0;
const listeners = new Set();

// Every key a change took out of main's copy in this process: for redaction
// only (network-registry.js withoutApiKeys), never for a request. Never
// evicted, and kept when the key becomes current again: a request built
// with it may be answered at any later time, since no request has a
// deadline. One entry per distinct key: each retirement follows a
// committed core write (a set or remove from the settings page) or a core
// read that changed the copy, so the set grows only with those.
const retired = new Set();

// The committed-change fences, provider id -> { expect, durable, start,
// caller, resent }: `expect` is the key the provider must have (null: no
// key); `durable` whether the core said the change was durable; `start` the
// core start that answered it; `resent` the core start main last sent it
// again in.
const fences = new Map();

// The read back's retries after a failure while a fence stands (ms): then
// the core's next start reads again.
const RETRY_DELAYS_MS = Object.freeze([1000, 2000, 4000, 8000, 16000]);
let retries = 0;
let retryTimer = null;

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

/** Main's copy replaced by `next`; whether it changed. */
function replaceKeys(next) {
  if (sameKeys(apiKeys, next)) return false;
  const kept = new Set(next.values());
  for (const key of apiKeys.values()) {
    if (!kept.has(key)) retired.add(key);
  }
  apiKeys = next;
  keysChanged();
  return true;
}

function cancelRetry() {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

/** After the latest read failed: read again later while a fence stands. */
function scheduleRetry() {
  if (fences.size === 0 || retryTimer) return;
  if (retries >= RETRY_DELAYS_MS.length) {
    console.error(
      "[RpcManager] The RPC API keys couldn't be read back after a change; " +
        "main keeps its copy until the core's next start"
    );
    return;
  }
  retryTimer = setTimeout(() => {
    retryTimer = null;
    refreshQuietly();
  }, RETRY_DELAYS_MS[retries++]);
  retryTimer.unref?.();
}

/**
 * A set (`expect`, the key) or remove (`expect` null) of `providerId` the
 * core has taken, applied to main's copy at once, before the read back: no
 * read started earlier applies. It leaves the provider's fence.
 */
function applyCommitted(providerId, expect, { durable, caller }) {
  generation += 1;
  retries = 0;
  cancelRetry();
  fences.set(providerId, { expect, durable, start: coreStart, caller, resent: null });
  const next = new Map(apiKeys);
  if (expect === null) next.delete(providerId);
  else next.set(providerId, expect);
  replaceKeys(next);
}

/** Whether `keys` (a core read) has `providerId` as its fence expects. */
const meets = (keys, providerId, { expect }) =>
  expect === null ? !keys.has(providerId) : keys.get(providerId) === expect;

/**
 * A fenced change sent again, as it was (a remove as a remove, a set with
 * the key main holds): whether the core took it. A failure is logged, and
 * the fence stays.
 */
async function resend(providerId, fence) {
  fence.resent = coreStart;
  const params = fence.expect === null ? { id: providerId } : { id: providerId, api_key: fence.expect };
  try {
    const answer =
      fence.expect === null
        ? await vault().secrets.removeRpcApiKey(params, fence.caller)
        : await vault().secrets.setRpcApiKey(params, fence.caller);
    if (fences.get(providerId) === fence) {
      fence.durable = answer?.durable !== false;
      fence.start = fence.resent;
    }
    return true;
  } catch (err) {
    console.error(
      `[RpcManager] Sending the API key change for ${providerId} again failed ` +
        `(${err?.code || 'error'}); main keeps it in force`
    );
    return false;
  }
}

/**
 * The core's keys (`keys`, read in core start `start`) with each fence
 * applied: a provider whose read meets its fence clears it (a change the
 * core called not durable only from a later start); one whose read
 * contradicts it keeps main's entry. The contradicted fences.
 */
function fenced(keys, start) {
  const next = new Map(keys);
  const contradicted = [];
  for (const [providerId, fence] of fences) {
    if (meets(keys, providerId, fence)) {
      if (fence.durable || start > fence.start) fences.delete(providerId);
      continue;
    }
    if (fence.expect === null) next.delete(providerId);
    else next.set(providerId, fence.expect);
    contradicted.push([providerId, fence]);
  }
  return { next, contradicted };
}

/**
 * Main's copy read again from the core. Whether it changed; an answer to
 * a read that is no longer the latest started is dropped. A failure is
 * thrown, and retried while a fence stands if it is the latest's. A read
 * that contradicts a fence sends that change again, once in each start of
 * the core, and reads back.
 */
async function refreshKeys() {
  const read = ++generation;
  const start = coreStart;
  let answer;
  try {
    answer = await vault().secrets.rpcApiKeys();
  } catch (err) {
    if (read === generation) scheduleRetry();
    throw err;
  }
  if (read !== generation) return false;
  cancelRetry();
  const { next, contradicted } = fenced(keysOf(answer), start);
  const changed = replaceKeys(next);
  const again = contradicted.filter(([, fence]) => fence.resent !== coreStart);
  if (again.length > 0) {
    let taken = false;
    for (const [providerId, fence] of again) {
      if (await resend(providerId, fence)) taken = true;
    }
    if (taken) return (await refreshQuietly()) || changed;
  }
  return changed;
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
    coreStart += 1;
    retries = 0;
    cancelRetry();
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

/** The keys taken out of main's copy: for redaction only, never a request. */
function retiredApiKeys() {
  return [...retired];
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
  let durable;
  try {
    const answer = await vault().secrets.setRpcApiKey({ id: providerId, api_key: apiKey }, caller);
    durable = answer?.durable !== false;
    if (!durable) {
      console.warn(`[RpcManager] API key for ${providerId} set, but not yet durable`);
    }
  } catch (err) {
    return { success: false, error: keyErrorMessage(err, SAVE) };
  }
  applyCommitted(providerId, typeof apiKey === 'string' && apiKey ? apiKey : null, { durable, caller });
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
  let durable;
  try {
    const answer = await vault().secrets.removeRpcApiKey({ id: providerId }, caller);
    durable = answer?.durable !== false;
    if (!durable) {
      console.warn(`[RpcManager] API key for ${providerId} removed, but not yet durably`);
    }
  } catch (err) {
    return { success: false, error: keyErrorMessage(err, REMOVE) };
  }
  applyCommitted(providerId, null, { durable, caller });
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
  retiredApiKeys,
  setApiKey,
  removeApiKey,
  hasApiKey,
  providersWithKeys,
  getEffectiveRpcUrls,
  getKeylessRpcUrls,
  testApiKey,
};
