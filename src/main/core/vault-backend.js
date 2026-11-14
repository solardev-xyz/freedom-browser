/**
 * The single module every vault and key consumer imports (freedom-core
 * design 0001, "Migration in freedom-browser"). It talks to freedom-cored
 * through the CoreClient; no key material is kept here.
 *
 * - Secret fields travel as base64 of their UTF-8 bytes (`Buffer.from(s,
 *   'utf8')`, as passworder does), and come back the same way (`mnemonic_b64`)
 *   or as `private_key_hex`.
 * - Core errors become `Error`s with the JS message (the core sends the
 *   parity strings) and a `code`.
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

const CORE_UNAVAILABLE = 'core_unavailable';
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
 * One core request under its watchdog: from main itself (caller `shell`), or
 * for a page's request under `page` with its PageContext (freedom-core
 * designs 0011 and 0012, "PageContext"): `{ origin, top_origin, frame,
 * navigation, agent }`.
 */
async function call(method, params = {}, page = null) {
  try {
    return await client().request(
      method,
      params,
      page ? { caller: 'page', page } : { caller: 'shell' },
      { watchdogMs: watchdogMs(method) }
    );
  } catch (err) {
    if (err instanceof VaultBackendError) throw err;
    throw new VaultBackendError(err.code || CORE_UNAVAILABLE, err.message, err.data);
  }
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

async function reconcile(record) {
  const result = await call('vault.reconcile', {
    op: record.op,
    fingerprint_before: record.before,
    password_b64: b64(record.password),
    ...(record.mnemonic ? { mnemonic_b64: b64(record.mnemonic) } : {}),
    install: record.install && locks === record.locksAtStart,
  });
  return result.status === 'committed' ? result : null;
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
      return await call(method, request);
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
   * @returns {{ mnemonic: string, addresses: { user_wallet, bee_wallet } }}
   * @param {Function} [onCommitted] - continuation if the reply was lost and
   *   the core only came back later (e.g. writing vault-meta.json)
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

  async importVault(password, mnemonic, { overwrite = false, onCommitted } = {}) {
    if (typeof mnemonic !== 'string' || !mnemonic.isWellFormed()) {
      throw new VaultBackendError('invalid_mnemonic', 'Invalid mnemonic');
    }
    const result = await mutate(
      'vault.import',
      { password_b64: b64(password), mnemonic_b64: b64(mnemonic), overwrite },
      { op: 'import', password, mnemonic, install: true, onCommitted }
    );
    return { addresses: result.addresses };
  },

  /** @returns {{ addresses: { user_wallet, bee_wallet } }} */
  unlock(password) {
    watchCore();
    return call('vault.unlock', { password_b64: b64(password) });
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
     * @param {{ identifier: Uint8Array, payload: Uint8Array, span?: bigint }} chunk
     * @returns {{ signature, owner, chunk_address, soc_address, span }}
     */
    soc(key, { identifier, payload, span }) {
      return call('swarm.sign_soc', {
        key,
        identifier: '0x' + Buffer.from(identifier).toString('hex'),
        payload: '0x' + Buffer.from(payload).toString('hex'),
        ...(span !== undefined && span !== null ? { span: String(span) } : {}),
      });
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
    /** `{ token, kind, account?, payload, handle? }` → `{ bound, safe? }` */
    spend(params, page = null) {
      return call('approval.spend', params, page);
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
