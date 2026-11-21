/**
 * The identity core's RPC-key methods (freedom-core design 0013, "RPC API
 * keys"; cored 0.23.0) for unit tests, simulated in JS over the reference
 * key store (test/helpers/reference-rpc-keys-store.js), so the file's text
 * is the reference's. The real core is tested against main in
 * src/main/wallet/rpc-manager.integration.test.js; this keeps the rules
 * main's wiring relies on:
 *   - every method answers `not_moved` (`data.store: 'rpc_api_keys'`) until
 *     `moved`, and opens no file;
 *   - `secrets.rpc_api_keys` goes as `shell`, as vault-backend.js sends it
 *     (the real core refuses `chrome`): `{ keys: [{ id, api_key }] }`, each
 *     key the reference counts (a non-empty string `apiKey`, `enabled`
 *     truthy);
 *   - status, set and remove answer `{ providers: [{ id, present }] }`,
 *     sorted, each provider with a key `present: true`, and a removed one
 *     `present: false`;
 *   - a set's id is 1 to 52 bytes of `[a-z0-9._-]` (`rpc-key-provider-id`)
 *     and its key a string of 1 to 1,024 bytes (`rpc-key-size`), refused
 *     `invalid_argument` with `data.rule`; a key that isn't a string is
 *     `invalid_argument` with no rule;
 *   - with no key store (the default, as on Linux and Windows) a set or a
 *     remove writes rpc-api-keys.json, `{ apiKey, enabled: true, addedAt }`,
 *     through the reference; with `keyStore`, keys are held in memory as
 *     secrets-file entries, at most 16 (`rpc-keys-bound`, a replace taken);
 *   - `failNext(method, { code, data })` makes that method's next call fail.
 *
 * Each call goes as vault-backend.js's `secrets.*` does: `(params, caller)`,
 * caller `'chrome'` or null (`shell`). `calls` records each, without keys.
 */

const ENTRY_ID = /^[a-z0-9._-]{1,52}$/;
const MAX_KEYS = 16;
const MAX_KEY_BYTES = 1024;

class SimulatedCoreError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

function simulatedRpcKeysCore({ moved = true, keyStore = false } = {}) {
  const store = require('./reference-rpc-keys-store');
  const entries = new Map();
  const failures = new Map();
  const calls = [];

  const counted = (entry) =>
    !!(entry && typeof entry.apiKey === 'string' && entry.apiKey && entry.enabled);
  const fileKeys = () => store.readRpcApiKeys();

  function admit(method, params, caller) {
    calls.push({
      method,
      caller: caller === 'chrome' ? 'chrome' : 'shell',
      id: params?.id,
    });
    const failure = failures.get(method);
    if (failure) {
      failures.delete(method);
      throw new SimulatedCoreError(failure.code, failure.message || failure.code, failure.data);
    }
    if (!moved) {
      throw new SimulatedCoreError(
        'not_moved',
        "main still writes the RPC API keys (rpc_api_keys isn't in store_moved)",
        { store: 'rpc_api_keys' }
      );
    }
  }

  function present() {
    const ids = new Set(entries.keys());
    for (const [id, entry] of Object.entries(fileKeys())) if (counted(entry)) ids.add(id);
    return [...ids].sort();
  }

  function status(touched = null) {
    const ids = present();
    const providers = ids.map((id) => ({ id, present: true }));
    if (touched && !ids.includes(touched)) providers.push({ id: touched, present: false });
    return { providers };
  }

  const invalid = (rule) =>
    new SimulatedCoreError('invalid_argument', 'Invalid parameters', rule ? { rule } : undefined);

  const secrets = {
    async rpcApiKeys() {
      admit('secrets.rpc_api_keys', {}, null);
      const keys = new Map(entries);
      for (const [id, entry] of Object.entries(fileKeys())) {
        if (counted(entry)) keys.set(id, entry.apiKey);
      }
      return {
        keys: [...keys]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([id, api_key]) => ({ id, api_key })),
      };
    },
    async rpcApiKeyStatus(caller = null) {
      admit('secrets.rpc_api_key_status', {}, caller);
      return status();
    },
    async setRpcApiKey(params, caller = null) {
      admit('secrets.set_rpc_api_key', params, caller);
      const { id, api_key: key } = params || {};
      if (typeof id !== 'string' || typeof key !== 'string') throw invalid(null);
      if (!ENTRY_ID.test(id)) throw invalid('rpc-key-provider-id');
      const bytes = Buffer.byteLength(key, 'utf8');
      if (bytes < 1 || bytes > MAX_KEY_BYTES) throw invalid('rpc-key-size');
      if (keyStore) {
        if (!entries.has(id) && entries.size >= MAX_KEYS) throw invalid('rpc-keys-bound');
        entries.set(id, key);
        const file = fileKeys();
        if (Object.hasOwn(file, id)) {
          delete file[id];
          store.writeRpcApiKeys(file);
        }
      } else {
        const file = fileKeys();
        file[id] = { apiKey: key, enabled: true, addedAt: Date.now() };
        store.writeRpcApiKeys(file);
      }
      return status(id);
    },
    async removeRpcApiKey(params, caller = null) {
      admit('secrets.remove_rpc_api_key', params, caller);
      const { id } = params || {};
      if (typeof id !== 'string' || !id) throw invalid(null);
      entries.delete(id);
      const file = fileKeys();
      if (Object.hasOwn(file, id)) {
        delete file[id];
        store.writeRpcApiKeys(file);
      }
      return status(id);
    },
  };

  return {
    secrets,
    calls,
    entries,
    failNext(method, failure) {
      failures.set(method, failure);
    },
  };
}

module.exports = { simulatedRpcKeysCore, SimulatedCoreError };
