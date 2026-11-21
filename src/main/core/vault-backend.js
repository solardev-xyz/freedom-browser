/**
 * The single module every vault and key consumer imports (freedom-core
 * design 0001, "Migration in freedom-browser"). It talks to freedom-cored
 * through the CoreClient; no key material is kept here.
 *
 * - Secret fields travel as base64 of their UTF-8 bytes (`Buffer.from(s,
 *   'utf8')`, as passworder does), and come back the same way (`mnemonic_b64`)
 *   or as `private_key_hex`.
 * - Core errors become `Error`s with the JS message (the core sends the
 *   parity strings) and a `code`. The key store's and the secrets file's
 *   errors (design 0013) get main's own message, a cause and a way forward
 *   (key-store-messages.js), with the core's `code` and `data` kept.
 * - Vault mutations run one at a time (design 0001, "Reconciliation"), so
 *   the `vault.status` recorded before each belongs to exactly that
 *   operation. If the core dies before replying, this waits for the
 *   restarted core and asks `vault.reconcile` whether the mutation committed.
 *   If the core can't come back, the operation stays pending: it is settled,
 *   with its continuation, as soon as the core is ready again, and no other
 *   mutation runs before that.
 * - Every request runs under its method's hang watchdog (core-deadlines.js):
 *   15 s for an immediate method, 45 s on the vault queue. A core that hangs
 *   past it is killed and restarted, which fails the request
 *   `core_unavailable`, so a mutation reconciles as after a crash.
 */

const log = require('../logger');
const { getCoreClient } = require('./core-process');
const { watchdogMs } = require('./core-deadlines');
const { keyStoreMessage } = require('./key-store-messages');
const { requiresStore } = require('./core-client');

const CORE_UNAVAILABLE = 'core_unavailable';
// `vault-meta.json` is the core's (design 0013, PRF-6(a)): its requests,
// and `vault.create`'s and `vault.import`'s, which write it with the vault,
// go only to a core whose hello echoed `vault_meta`.
const VAULT_META = requiresStore('vault_meta');
// The mutations that write vault-meta.json with the vault, and so their
// reconcile too.
const META_OPS = new Set(['create', 'import']);
// @scure/bip39 strengths (bits) and their word counts.
const WORDS_BY_STRENGTH = { 128: 12, 160: 15, 192: 18, 224: 21, 256: 24 };

class VaultBackendError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'VaultBackendError';
    this.code = code;
    this.data = data;
  }
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function client() {
  const core = getCoreClient();
  if (!core) throw new VaultBackendError(CORE_UNAVAILABLE, 'The identity core is not running');
  return core;
}

/**
 * Whether `page` is a PageContext the core can decode (fc-protocol's
 * `PageContext`): `origin` and `top_origin` strings, `frame` and
 * `navigation` unsigned integers, `agent` a boolean or absent, and
 * `transport_key` (cored 0.21.0, for a DNS name over IPNS) a string or
 * absent. The core reads any other as a protocol error and exits, failing
 * every request in flight. A keyless document has no key to send: from cored 0.18.0 the core
 * answers an empty `origin` `invalid_argument` on every page method but
 * `eip1193.request`, and main sends no page method for one (the page
 * providers refuse it first).
 */
function decodablePage(page) {
  return (
    typeof page === 'object' &&
    typeof page.origin === 'string' &&
    typeof page.top_origin === 'string' &&
    Number.isSafeInteger(page.frame) &&
    page.frame >= 0 &&
    Number.isSafeInteger(page.navigation) &&
    page.navigation >= 0 &&
    (page.agent == null || typeof page.agent === 'boolean') &&
    (page.transport_key == null || typeof page.transport_key === 'string')
  );
}

/**
 * One core request under its watchdog: from main itself (caller `shell`), or
 * for a page's request under `page` with its PageContext (freedom-core
 * designs 0011 and 0012, "PageContext"): `{ origin, top_origin, frame,
 * navigation, agent, transport_key? }`. `'chrome'` relays the chrome's own request (a
 * grant's narrowing from its settings: design 0012, "The model"). A
 * PageContext the core couldn't decode (a null `origin`, say) is refused
 * here, `invalid_argument`, and never sent: it would end the core.
 *
 * `requires` is the shared client's (service-client.js): a set-A store's
 * requests (design 0013, "One writer per store") pass
 * `requiresStore(name)` (core-client.js), so a core whose hello didn't
 * echo the store fails them `requirement_unmet` in main, unsent. Null
 * (the default) for every other request.
 */
async function call(method, params = {}, page = null, { requires = null } = {}) {
  let context;
  if (page === 'chrome') context = { caller: 'chrome' };
  else if (!page) context = { caller: 'shell' };
  else if (decodablePage(page)) context = { caller: 'page', page };
  else throw new VaultBackendError('invalid_argument', 'A page request needs its page’s context');
  try {
    return await client().request(method, params, context, {
      watchdogMs: watchdogMs(method),
      requires,
    });
  } catch (err) {
    if (err instanceof VaultBackendError) throw err;
    const code = err.code || CORE_UNAVAILABLE;
    throw new VaultBackendError(code, keyStoreMessage(code, err.data) ?? err.message, err.data);
  }
}

/**
 * A `vault-meta.json` request (`accounts.*`, design 0013, "`vault-meta.json`"),
 * from main itself (`caller` null: `shell`) or relayed for the chrome
 * (`'chrome'`). It goes with `requires: VAULT_META`, so a core that didn't
 * take the store fails it `requirement_unmet` in main, unsent. A refusal is
 * `invalid_argument` with the reference's message, and its `err.code` as
 * `data.code` where it set one: that code becomes the error's, so callers
 * keep branching on today's codes (`LEDGER_ACCOUNT_UNCHECKED`,
 * `SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE`, …).
 */
async function accountsCall(method, params, caller = null) {
  try {
    return await call(method, params, caller, { requires: VAULT_META });
  } catch (err) {
    if (err.code === 'invalid_argument' && typeof err.data?.code === 'string') {
      throw new VaultBackendError(err.data.code, err.message, err.data);
    }
    throw err;
  }
}

/** `params` with `name` when one is given: absent means the core's default. */
function named(params, name) {
  return name === undefined ? params : { ...params, name };
}

/**
 * `sign.*`'s caller and `authorization` (freedom-core design 0012, API):
 * `{ token, handle? }`, or `{ token, intent: { id } }` for an
 * intent-replace, or `{ standing: { paused? } }` for a request a site's
 * standing rule answers, checked by the core before any key is derived; a
 * page's under `page` with its PageContext. None, from main itself, as
 * before.
 */
function signed(params, { authorization = null } = {}) {
  return authorization ? { ...params, authorization } : params;
}

// ---- lock tracking (for reconciliation's `install`) ----

// Counts locks main requested and `vault.locked` events, across core
// generations. A reconciled mutation installs its secrets only if none
// happened since it started: an acknowledged lock is never undone.
let locks = 0;
let watchedClient = null;

function watchCore() {
  const core = getCoreClient();
  if (!core || core === watchedClient) return;
  watchedClient = core;
  core.on('event', (name) => {
    if (name === 'vault.locked') locks += 1;
  });
  // A lost mutation is settled as soon as the core is back.
  core.on('ready', () => {
    if (pending) drain();
  });
}

// ---- mutations: one at a time, with reconciliation ----

// Everything from settling an earlier lost mutation, through the status
// snapshot and the call, to reconciliation and its continuation, runs in
// this queue. Locks, unlocks and reads stay outside it.
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/**
 * A mutation whose reply was lost and that isn't settled yet:
 * `{ op, password, mnemonic?, install, before, locksAtStart, onCommitted? }`.
 * `found` is set once reconciliation has established the commit; the record
 * stays until its continuation has succeeded too.
 */
let pending = null;

/** A mutation's `requires`: `VAULT_META` for a create or an import. */
function requiresFor(op) {
  return META_OPS.has(op) ? VAULT_META : null;
}

/**
 * Whether the lost mutation committed: its committed result, or null. A
 * create's or an import's carries `meta` (design 0013, "The vault and its
 * metadata, one write"): `"written"`, or `"pending"` while the core's
 * journal waits for its recovery to install the metadata. Main writes
 * nothing for either.
 */
async function reconcile(record) {
  const result = await call(
    'vault.reconcile',
    {
      op: record.op,
      fingerprint_before: record.before,
      password_b64: b64(record.password),
      ...(record.mnemonic ? { mnemonic_b64: b64(record.mnemonic) } : {}),
      install: record.install && locks === record.locksAtStart,
    },
    null,
    { requires: requiresFor(record.op) }
  );
  if (result.status !== 'committed') return null;
  if (result.meta === 'pending') {
    log.warn("[VaultBackend] A lost vault operation committed; the core's recovery installs its metadata");
  }
  return result;
}

/**
 * Settles the pending mutation, if any: reconciles it (throws while the core
 * is still down), then runs its continuation (a failure keeps it pending, to
 * be retried). Returns `{ record, found }` when it had committed.
 */
async function settlePending() {
  if (!pending) return null;
  const record = pending;
  if (!record.found) {
    const found = await reconcile(record);
    if (!found) {
      pending = null;
      return null;
    }
    record.found = found;
  }
  if (record.onCommitted) await record.onCommitted(record.found);
  pending = null;
  return { record, found: record.found };
}

// What an automatic settlement found, kept briefly for a caller that retries
// the same request (see mutate). Consumed by the next mutation.
let lastSettled = null;
let lastSettledTimer = null;
const SETTLED_KEEP_MS = 5 * 60_000;

function keepSettled(settled) {
  clearTimeout(lastSettledTimer);
  lastSettled = settled;
  if (!settled) return;
  lastSettledTimer = setTimeout(() => {
    lastSettled = null;
  }, SETTLED_KEEP_MS);
  lastSettledTimer.unref?.();
}

function drain() {
  serialized(async () => keepSettled(await settlePending())).catch((err) => {
    log.warn('[VaultBackend] A lost vault operation is still unsettled', { code: err.code });
  });
}

function sameRequest(a, b) {
  return (
    a.op === b.op && a.password === b.password && (a.mnemonic || null) === (b.mnemonic || null)
  );
}

/**
 * Runs a vault mutation with lost-reply reconciliation.
 * @param {string} method
 * @param {object|Function} params - or a function returning them, called
 *   after `precheck`
 * @param {object} record - { op, password, mnemonic?, install, onCommitted? }
 * @param {Function} [precheck] - runs once earlier work is settled
 */
function mutate(method, params, record, precheck) {
  watchCore();
  return serialized(async () => {
    const settled = (await settlePending()) || lastSettled;
    keepSettled(null);
    // The same request again (a retry after `core_unavailable`) gets the
    // result its first attempt committed.
    if (settled && sameRequest(settled.record, record)) {
      return { ...settled.found, reconciled: true };
    }
    if (precheck) await precheck();
    const request = typeof params === 'function' ? params() : params;
    const status = await call('vault.status');
    const full = { ...record, before: status.fingerprint, locksAtStart: locks };
    try {
      return await call(method, request, null, { requires: requiresFor(record.op) });
    } catch (err) {
      // Error replies always mean "not committed"; only a missing reply needs
      // reconciliation.
      if (err.code !== CORE_UNAVAILABLE) throw err;
      let found;
      try {
        await client().whenReady();
        found = await reconcile(full);
      } catch {
        pending = full;
        throw err;
      }
      if (!found) throw err;
      return { ...found, reconciled: true };
    }
  });
}

// ---- local checks main keeps (parity with the JS it replaces) ----

/** `createMnemonic(strength = 256)` → @scure/bip39's argument errors. */
function wordsFor(strength = 256) {
  if (typeof strength !== 'number') {
    throw new TypeError(`expected number, got ${typeof strength}`);
  }
  if (!Number.isInteger(strength) || strength < 0) {
    throw new RangeError(`expected integer >= 0, got ${strength}`);
  }
  if (strength % 32 !== 0 || strength > 256) throw new RangeError('Invalid entropy');
  const words = WORDS_BY_STRENGTH[strength];
  if (!words) throw new RangeError('invalid entropy length');
  return words;
}

// ---- the API ----

const vaultBackend = {
  /** `{ exists, unlocked, epoch, fingerprint }` */
  status() {
    return call('vault.status');
  },

  async generateMnemonic(strength) {
    const words = wordsFor(strength);
    const result = await call('keys.generate_mnemonic', { words });
    return unb64(result.mnemonic_b64);
  },

  async validateMnemonic(mnemonic) {
    if (!mnemonic || typeof mnemonic !== 'string' || !mnemonic.isWellFormed()) return false;
    const result = await call('keys.validate_mnemonic', { mnemonic_b64: b64(mnemonic) });
    return result.valid === true;
  },

  /**
   * The vault and its `vault-meta.json`, written by the core as one
   * operation (design 0013, PRF-6(a)), and only on a core that took
   * `vault_meta` (`requirement_unmet` on any other, nothing written).
   * @returns {{ mnemonic: string, addresses: { user_wallet, bee_wallet } }}
   * @param {boolean} [userKnowsPassword] - the metadata's
   *   `userKnowsPassword` (false for Quick Setup), required by the core
   * @param {Function} [onCommitted] - continuation if the reply was lost and
   *   the core only came back later
   */
  async createVault(password, strength = 256, { userKnowsPassword = true, onCommitted } = {}) {
    let words;
    const result = await mutate(
      'vault.create',
      () => ({ password_b64: b64(password), words, user_knows_password: userKnowsPassword }),
      { op: 'create', password, install: true, onCommitted },
      // JS order: an existing vault, then the strength, then the password.
      async () => {
        if ((await call('vault.status')).exists) {
          throw new VaultBackendError(
            'vault_exists',
            'Vault already exists. Use importVault to replace.'
          );
        }
        words = wordsFor(strength);
      }
    );
    return { mnemonic: unb64(result.mnemonic_b64), addresses: result.addresses };
  },

  /**
   * The vault and its `vault-meta.json`, as `createVault` writes them.
   * @param {boolean} [userKnowsPassword] - as `createVault`'s
   * @param {boolean} [quickUnlock] - Quick Setup (design 0013, "The re-wrap's
   *   two entries"): the core writes quick unlock's credential for the new
   *   vault before the vault commits, so the vault never exists without it
   */
  async importVault(
    password,
    mnemonic,
    { overwrite = false, quickUnlock = false, userKnowsPassword = true, onCommitted } = {}
  ) {
    if (typeof mnemonic !== 'string' || !mnemonic.isWellFormed()) {
      throw new VaultBackendError('invalid_mnemonic', 'Invalid mnemonic');
    }
    const result = await mutate(
      'vault.import',
      {
        password_b64: b64(password),
        mnemonic_b64: b64(mnemonic),
        overwrite,
        user_knows_password: userKnowsPassword,
        ...(quickUnlock ? { quick_unlock: true } : {}),
      },
      { op: 'import', password, mnemonic, install: true, onCommitted }
    );
    return { addresses: result.addresses };
  },

  /** @returns {{ addresses: { user_wallet, bee_wallet } }} */
  unlock(password) {
    watchCore();
    return call('vault.unlock', { password_b64: b64(password) });
  },

  /**
   * Runs `task` on the mutation queue: no create, import, password change
   * or delete starts until it settles, and it starts only after those
   * already queued (0013 PRF-2b, PRF-2d: quick-unlock.dat is checked
   * against the vault, used and removed under it). Unlocks, reads and quick_unlock.* stay outside
   * the queue, so `task` may call them. Never call it from inside a
   * mutation's own continuation (`onCommitted`): it would wait on itself.
   */
  whileVaultHeld(task) {
    return serialized(task);
  },

  async lock() {
    watchCore();
    locks += 1;
    await call('vault.lock');
  },

  /** Restarts the auto-lock timer if unlocked. Fire and forget. */
  touch() {
    call('vault.touch').catch(() => {});
  },

  async verifyPassword(password) {
    await call('vault.verify_password', { password_b64: b64(password) });
  },

  /** Error order as JS: no vault → … → incorrect password → weak new one. */
  async changePassword(current, next) {
    await mutate(
      'vault.change_password',
      { password_b64: b64(current), new_password_b64: b64(next) },
      { op: 'change_password', password: next, install: false }
    );
  },

  async deleteVault(password) {
    await mutate(
      'vault.delete',
      { password_b64: b64(password) },
      { op: 'delete', password, install: false }
    );
  },

  /** Verifies the password, then needs the vault unlocked. */
  async exportMnemonic(password) {
    const result = await call('vault.export_mnemonic', { password_b64: b64(password) });
    return unb64(result.mnemonic_b64);
  },

  /** @returns {string} 0x private key */
  async exportPrivateKey(password, account) {
    const result = await call('vault.export_private_key', {
      password_b64: b64(password),
      account,
    });
    return result.private_key_hex;
  },

  // ---- quick unlock (design 0013, "The re-wrap"; cored 0.17.0) ----
  //
  // The vault password in the core's key store. `enroll` is main's own
  // (`shell`), with a password main has: one it unsealed from
  // quick-unlock.dat, or one the user typed. The rest are the chrome's
  // (`chrome`), each after main's Touch ID prompt; the password never comes
  // back to main.

  /** `{ enabled, policy, available }`, from the core's view of the file. */
  quickUnlockStatus() {
    return call('quick_unlock.status', {}, 'chrome');
  },

  /** Writes the credential for this vault; the password is checked first. */
  async quickUnlockEnroll(password) {
    await call('quick_unlock.enroll', { password_b64: b64(password) });
  },

  /** Unlocks with the credential, as `unlock` answers: `{ addresses }`. */
  quickUnlock() {
    watchCore();
    return call('quick_unlock.unlock', {}, 'chrome');
  },

  /** Unlocks with the credential, then exports, with no password. */
  async quickExportMnemonic() {
    watchCore();
    const result = await call('quick_unlock.export_mnemonic', {}, 'chrome');
    return unb64(result.mnemonic_b64);
  },

  /** @returns {string} 0x private key */
  async quickExportPrivateKey(account) {
    watchCore();
    const result = await call('quick_unlock.export_private_key', { account }, 'chrome');
    return result.private_key_hex;
  },

  /** Removes the credential (both names); its key is forgotten after. */
  async quickUnlockDisable() {
    await call('quick_unlock.disable', {}, 'chrome');
  },

  /**
   * `vault-meta.json`'s methods (design 0013, "`vault-meta.json`";
   * cored 0.23.0), one per change identity-manager.js made to it before
   * PRF-6(a). The core writes the file alone, in today's text; main reads it
   * only for its synchronous lookups. `caller` is `'chrome'` for a request
   * the chrome made over IPC and null (`shell`) for main's own; the device,
   * phone and Safe methods are main's only. A write may answer `durable:
   * false` (written, not yet flushed).
   */
  accounts: {
    /** `getDerivedWallets()`: the list, its first-list default written once. */
    async list(caller = null) {
      return (await accountsCall('accounts.list', {}, caller)).wallets;
    },
    /** The whole file (`identity:get-vault-meta`), or null without one. */
    async meta(caller = null) {
      return (await accountsCall('accounts.meta', {}, caller)).meta;
    },
    /** `getActiveWalletIndex()`. */
    async active(caller = null) {
      return (await accountsCall('accounts.active', {}, caller)).index;
    },
    /** A mnemonic account at the core's next index, needing the vault unlocked: `{ index, name, address }`. */
    async addMnemonic(name, caller = null) {
      return (await accountsCall('accounts.add_mnemonic', named({}, name), caller)).wallet;
    },
    /** A Ledger record main read back from the device at `path`, `matched`. */
    async addLedger({ name, address, path }) {
      return (await accountsCall('accounts.add_ledger', named({ address, path }, name))).wallet;
    },
    /** A phone record whose account the phone proved, `matched`. */
    async addRemote({ name, address }) {
      return (await accountsCall('accounts.add_remote', named({ address }, name))).wallet;
    },
    /**
     * What a device's answer showed about a `'ledger'` or `'remote'`
     * record: its check state after it (a matched record stays matched),
     * or null for no such record.
     */
    async recordAddressCheck(type, index, matched) {
      return (await accountsCall('accounts.record_address_check', { type, index, matched }))
        .address_check;
    },
    /** A Safe record over existing owners, under the reference's checks. */
    async addSafe({ name, address, owners, threshold, saltNonce }) {
      const params = named({ address, owners, threshold, salt_nonce: saltNonce }, name);
      return (await accountsCall('accounts.add_safe', params)).wallet;
    },
    /** A Safe's verified deployment on `chainId`: `{ verified: true }`. */
    async markSafeDeployed(index, chainId) {
      await accountsCall('accounts.mark_safe_deployed', { index, chain_id: chainId });
    },
    async setActive(index, caller = null) {
      await accountsCall('accounts.set_active', { index }, caller);
    },
    /** The name as given. */
    async rename(index, name, caller = null) {
      await accountsCall('accounts.rename', named({ index }, name), caller);
    },
    /**
     * Removes an account, in one request: the refusals (the main wallet, a
     * Safe's owner, and an account the Swarm feeds in `swarmReferences`
     * still name, `[{ origin, … }]` as main's feed store found them); for a
     * Safe, its open Safe approvals ended; the account's dApp grants
     * forgotten (a forget that fails refuses the removal); then the
     * record. The Swarm refusal gets back the references main passed
     * (`err.references`), as before.
     */
    async remove(index, swarmReferences = [], caller = null) {
      try {
        await accountsCall('accounts.remove', { index, swarm_references: swarmReferences }, caller);
      } catch (err) {
        if (err.code === 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE') err.references = swarmReferences;
        throw err;
      }
    },
  },

  /** Public data only; needs the vault unlocked. */
  addresses({ accounts = [], publishers = [] } = {}) {
    return call('keys.addresses', { accounts, publishers });
  },

  /** @param {Uint8Array|Buffer} publicKey - 32-byte Ed25519 key; works while locked */
  async radicleDid(publicKey) {
    const result = await call('keys.radicle_did', {
      public_key: Buffer.from(publicKey).toString('hex'),
    });
    return result.did;
  },

  /**
   * Signing in the core (freedom-core design 0002). `key` is a reference:
   * `{ kind: 'account', index }` here; Swarm adds `bee_wallet` and
   * `publisher`. Inputs are already in the core's wire form.
   */
  sign: {
    /**
     * `options`: `{ authorization, page }`, the confirmation the core checks
     * and the PageContext of a page's request (`signed`).
     * @returns {{ raw: string, hash: string, rule?: object }} `rule`: what
     *   became of a flagged `dapp-send`'s "Always allow" (design 0012)
     */
    transaction(key, tx, options = {}) {
      return call('sign.transaction', signed({ key, tx }, options), options.page);
    },
    /** @param {Uint8Array} bytes @returns {string} 65-byte signature, v 27/28 */
    async message(key, bytes, options = {}) {
      const message = '0x' + Buffer.from(bytes).toString('hex');
      return (await call('sign.message', signed({ key, message }, options), options.page)).signature;
    },
    /**
     * Signs only if the data's digest is `expectedHash`, the hash the user
     * confirmed (or, for main's own typed data, the one main just hashed);
     * any other is refused before a key is touched (freedom-core #88).
     * `options.primaryType` and `options.chainId` are what the core was told
     * beside the data when its token was minted (`typedDataView`): the view
     * the token binds is built again from them.
     * @param {{domain, types, message}} typedData
     * @param {string} expectedHash - 0x and 64 hex digits
     */
    async typedData(key, typedData, expectedHash, options = {}) {
      const params = { key, typed_data: typedData, expected_hash: expectedHash };
      if (options.primaryType !== undefined) params.primary_type = options.primaryType;
      if (options.chainId !== undefined) params.chain_id = options.chainId;
      return (await call('sign.typed_data', signed(params, options), options.page)).signature;
    },
    /**
     * A Swarm single-owner chunk; the core computes the chunk address from
     * the payload. `span` defaults to the payload length (as does 0).
     * A page's SOC (design 0012, "A page's SOC") goes under `page` with its
     * PageContext and `authorization: { swarm, soc }`, which the core checks
     * against the page's Swarm grant before any key is derived; main's own,
     * with neither, as `shell`.
     * @param {{ identifier: Uint8Array, payload: Uint8Array, span?: bigint }} chunk
     * @param {{ page?: object, authorization?: { swarm: 'user'|'auto', soc: 'feed'|'raw' } }} [options]
     * @returns {{ signature, owner, chunk_address, soc_address, span }}
     */
    soc(key, { identifier, payload, span }, options = {}) {
      const params = {
        key,
        identifier: '0x' + Buffer.from(identifier).toString('hex'),
        payload: '0x' + Buffer.from(payload).toString('hex'),
        ...(span !== undefined && span !== null ? { span: String(span) } : {}),
      };
      return call('swarm.sign_soc', signed(params, options), options.page || null);
    },
  },

  /**
   * Design 0012's approval tokens (cored 0.14.0, APR-3), which main mints
   * and spends through the core instead of in JS: a wallet kind from main
   * itself (`shell`), a page kind under `page` with the request's
   * PageContext. The token is a bearer secret: never logged.
   */
  approval: {
    /** `{ kind, account?, payload, handle?, fee_ack?, phone? }` → `{ token, expires_in_ms, hash?, view?, fee_check? }` */
    issue(params, page = null) {
      return call('approval.issue', params, page);
    },
    /**
     * `{ token, kind, account?, payload, handle? }` → `{ bound, safe?, receipt? }`.
     * `receipt`: a flagged `dapp-send` spent under `page` for a device (cored
     * 0.16.0, design 0012 "A device send's rule"), which `remember` presents.
     */
    spend(params, page = null) {
      return call('approval.spend', params, page);
    },
    /**
     * A device send's "Always allow" (cored 0.16.0, design 0012 "A device
     * send's rule"): `spend`'s receipt, presented once, always under `page`
     * with the PageContext the token was spent under, after the device
     * signed and main recorded the send. `{ receipt }` → `{ rule: { added,
     * reason?, durable? } }`. The receipt is a bearer secret: never logged.
     */
    remember(params, page) {
      return call('approval.remember', params, page);
    },
    /** Burns a token whatever it was: `{}` for one spent or unknown too. */
    discard(token) {
      return call('approval.discard', { token });
    },
    /** Ends a Safe approval: `{}` whatever it was. */
    end(safe, page = null) {
      return call('approval.end', { safe }, page);
    },
    /**
     * Whether a site's standing rule would answer a page's request (always
     * under `page`): `{ request, chain_id?, paused? }` → `{ covered, reason? }`.
     * Advice: `sign.*` decides again under `{ standing }`.
     */
    check(params, page) {
      return call('approval.check', params, page);
    },
    /**
     * The permission files' write methods (design 0012, API), for a file in
     * the hello's `grant_moved`: `dapp` from APB-2 (wallet/dapp-permissions.js),
     * `swarm` and `radicle` from APB-3, and `x402`'s revokes from X402-2
     * (core/grants.js). `caller` is a page's PageContext (its own key),
     * `'chrome'` (a narrowing from the chrome's settings) or null (`shell`,
     * main's own: an account deleted, a manifest's projection).
     */
    /** `{ store, change }` → `{ grant, durable? }` */
    grant(params, caller = null) {
      return call('approval.grant', params, caller);
    },
    /** `{ store, key, what }` → `{ revoked, durable? }` */
    revoke(params, caller = null) {
      return call('approval.revoke', params, caller);
    },
    /** A page's last use: `{ store, chain_id? }` → `{ durable? }`, always under `page` */
    touch(params, page) {
      return call('approval.touch', params, page);
    },
    /**
     * A page's Radicle COB write its "always allow writes" rule would answer
     * (cored 0.16.0, design 0012 "A page's Radicle write"), always under
     * `page`, for its own key: `{ key }` → `{ covered, reason? }`. A decision,
     * not advice: a covered write is counted in R-6, and main forwards it.
     */
    radicleWrite(params, page) {
      return call('approval.radicle_write', params, page);
    },
    /** `{ wallet_index }` → `{ keys, durable? }`, main's own */
    forgetAccount(walletIndex) {
      return call('approval.forget_account', { wallet_index: walletIndex });
    },
    /** `{ store, key? }` → `{ records }`, the store as the core holds it */
    grants(params) {
      return call('approval.grants', params);
    },
  },

  /**
   * x402's payments (cored 0.18.0, design 0012 "x402"; X402-2), main's own
   * (`shell`): the core checks the `x402-payment` token or a cap, charges the
   * cap before it signs, builds the payment byte for byte as `@x402/evm`
   * builds it and signs it with the account's vault key, or, for a Ledger or
   * phone account (`device`, cored 0.19.0), gives the typed data its device
   * signs and checks that signature at `settle`.
   */
  x402: {
    /**
     * `{ account, device?: { kind, address }, detection: { tab, id, url },
     * requirements, authorization: { token } | { cap: { agent, attributable } },
     * accept_index?, grant? }` → `{ payload, reservation, accept_index,
     * charged, grant?, durable? }`, or with `device` `{ device: { typed_data,
     * hash }, reservation, accept_index, charged, durable? }`.
     * The payload is a signed authorization: never logged.
     */
    authorize(params) {
      return call('x402.authorize', params);
    },
    /**
     * `{ reservation, outcome: 'withheld' | 'sent' }` → `{ refunded, durable? }`;
     * `{ reservation, signature }` (a device's, cored 0.19.0) →
     * `{ payload, charged, grant?, durable? }`, the payload JSON text with
     * the device's signature in it (never logged).
     */
    settle(params) {
      return call('x402.settle', params);
    },
    /**
     * A cap's narrowing (cored 0.19.0), the chrome's or main's own:
     * `{ key, cap: { chain_id, asset }, cap_amount?, window_seconds? }` →
     * `{ cap, durable? }`. Anything not strictly narrower is `forbidden`.
     */
    update(params, caller = 'chrome') {
      return call('x402.update', params, caller);
    },
  },

  /**
   * Phone jobs (freedom-core design 0012, PHN-1; cored 0.18.0), which main's
   * bridge relays to the chrome's openlv session (wallet/remote/bridge.js).
   * The core makes each job from a checked authorization, for the
   * webContents main names as `target`, and checks the phone's answer.
   */
  phone: {
    /**
     * `{ account, address, method, payload, target, authorization? }` →
     * `{ job, expires_in_ms, request: { method, params } }`, under `page`
     * with the request's PageContext, or as main's own (`shell`).
     */
    job(params, page = null) {
      return call('phone.job', params, page);
    },
    /** `{ job, sender }` → `{}`: the job marked possibly sent. `sender` is the IPC sender's id, never the message's. */
    sent(params) {
      return call('phone.sent', params, 'chrome');
    },
    /**
     * `{ job, sender, result | error }` → the core's outcome. The chrome's
     * answer goes as `chrome`; main's own timeout as `shell` (`caller` null).
     */
    result(params, caller = 'chrome') {
      return call('phone.result', params, caller);
    },
  },

  /**
   * The core process answering main's requests now, as an opaque mark, or
   * null while none does. What a process keeps only in its memory (design
   * 0012's Safe approvals) ends with it: the next process doesn't know it,
   * and a request still on its way to it fails once it has exited.
   */
  coreProcess() {
    const core = getCoreClient();
    const gen = core?.current ?? null;
    return core && gen && core.serves(gen) ? Object.freeze({ core, gen }) : null;
  },

  /**
   * Whether the process `mark` names (`coreProcess()`) has ended since: it
   * exited, or main stopped its client. Null (none answered then) counts as
   * ended, and anything else that isn't a mark doesn't.
   */
  coreProcessEnded(mark) {
    if (mark === null) return true;
    if (!mark?.core || !mark.gen) return false;
    return mark.gen.exited === true || getCoreClient() !== mark.core;
  },

  /**
   * EIP-712 digest with the core's strict rules, and the core's view of
   * exactly what it signs (freedom-core design 0002, #88): ethers'
   * getPayload, with `ignored`, `named_type` and `chain` reports. Public,
   * works while locked. A view too large for one reply is refused.
   *
   * @param {{domain, types, message}} typedData
   * @param {{primaryType?: *, chainId?: number}} [options] - `primaryType`
   *   as the dApp sent it, whatever its JSON type, only when it sent one;
   *   `chainId`, the dApp's active chain. Neither changes what is signed.
   * @returns {Promise<{hash: string, view: object}>}
   */
  typedDataView(typedData, options = {}) {
    const params = { typed_data: typedData };
    // `null` is a value (it reads `mismatch`); only an absent one is unknown.
    if (options.primaryType !== undefined) {
      params.primary_type = options.primaryType;
    }
    if (Number.isSafeInteger(options.chainId) && options.chainId >= 0) {
      params.chain_id = String(options.chainId);
    }
    return call('typed_data.hash', params);
  },

  /** EIP-712 digest with the core's strict rules; public, works while locked. */
  async typedDataHash(typedData) {
    return (await vaultBackend.typedDataView(typedData)).hash;
  },

  /**
   * The Radicle node key, sealed by the core to the freedom-radicled
   * process's `recipient` (its X25519 public key for this start, base64, as
   * `rad.hello` gave it; freedom-core design 0008, "The sealed release"):
   * `{ enc, ciphertext }`, base64, which main passes on in `rad.identity`
   * and never opens. Main never sees the key. Errors keep the core's codes:
   * `no_vault` (the only answer that leads to a throwaway key), and
   * `vault_locked` while locked, or when a lock came before the reply was
   * handed to the core's writer (the start's boundary).
   */
  async sealRadicleKey(recipient) {
    const { enc, ciphertext } = await call('nodes.seal_radicle_key', { recipient });
    return { enc, ciphertext };
  },

  /**
   * Calls `listener(name, data)` on the core's `vault.unlocked` and
   * `vault.locked` events; returns its unsubscribe. With no core client,
   * nothing is subscribed: `status()` then fails `core_unavailable`.
   */
  onVaultEvent(listener) {
    const core = getCoreClient();
    if (!core) return () => {};
    const onEvent = (name, data) => {
      if (name === 'vault.unlocked' || name === 'vault.locked') listener(name, data);
    };
    core.on('event', onEvent);
    return () => core.removeListener('event', onEvent);
  },

  /**
   * Writes a node identity through the core's journal. `spec` is
   * `{ node: 'bee', data_dir, api_port, p2p_port }`,
   * `{ node: 'radicle', home, alias }` (the key file, for the add-on), or
   * `{ node: 'radicle', home, alias, custody: 'sealed', wipe? }` (no key
   * file; any is removed: freedom-core design 0008, "The switch" and
   * "Identity changes"). A lost reply is resolved with `nodes.op_status`.
   */
  async writeNodeIdentity(spec, opId) {
    try {
      return await call('nodes.write_identity', { op_id: opId, ...spec });
    } catch (err) {
      if (err.code !== CORE_UNAVAILABLE) throw err;
      let status;
      try {
        await client().whenReady();
        ({ status } = await call('nodes.op_status', { op_id: opId }));
      } catch {
        throw err; // outcome unknown
      }
      // Never committed: the caller's node may already be wiped.
      if (status === 'not_committed') throw err;
      // installed, pending_recovery or corrupt; only the status is known.
      return { status, reconciled: true };
    }
  },
};

module.exports = {
  vaultBackend,
  VaultBackendError,
  // For tests.
  _internal: {
    call,
    wordsFor,
    reset() {
      locks = 0;
      watchedClient = null;
      pending = null;
      queue = Promise.resolve();
      keepSettled(null);
    },
    hasPending: () => pending !== null,
  },
};
