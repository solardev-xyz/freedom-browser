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
 * - Lost replies are reconciled (design 0001, "Reconciliation"): every vault
 *   mutation records `vault.status` first. If the core dies before replying,
 *   this waits for the restarted core and asks `vault.reconcile` whether the
 *   mutation committed. If the core can't come back, the operation stays
 *   pending and no other mutation runs until it has been reconciled.
 */

const { getCoreClient } = require('./core-process');

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

/** One core request, from main itself (caller `shell`). */
async function call(method, params = {}) {
  try {
    return await client().request(method, params, { caller: 'shell' });
  } catch (err) {
    if (err instanceof VaultBackendError) throw err;
    throw new VaultBackendError(err.code || CORE_UNAVAILABLE, err.message, err.data);
  }
}

// ---- lock tracking (for reconciliation's `install`) ----

// Counts locks main requested and `vault.locked` events, across core
// generations. A reconciled mutation installs its secrets only if none
// happened since it started: an acknowledged lock is never undone.
let locks = 0;
let watchedClient = null;

function watchLocks() {
  const core = getCoreClient();
  if (!core || core === watchedClient) return;
  watchedClient = core;
  core.on('event', (name) => {
    if (name === 'vault.locked') locks += 1;
  });
}

// ---- reconciliation ----

/** A mutation whose reply was lost and that couldn't be reconciled yet. */
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

/** Settles an earlier lost mutation before any new one runs. */
async function settlePending() {
  if (!pending) return;
  const record = pending;
  const found = await reconcile(record); // throws while the core is still down
  pending = null;
  if (found && record.onCommitted) await record.onCommitted(found);
}

/**
 * Runs a vault mutation with lost-reply reconciliation.
 * @param {object} record - { op, password, mnemonic?, install, onCommitted? }
 */
async function mutate(method, params, record) {
  watchLocks();
  await settlePending();
  const status = await call('vault.status');
  const full = { ...record, before: status.fingerprint, locksAtStart: locks };
  try {
    return await call(method, params);
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
    // JS order: an existing vault, then the strength, then the password.
    if ((await call('vault.status')).exists) {
      throw new VaultBackendError(
        'vault_exists',
        'Vault already exists. Use importVault to replace.'
      );
    }
    const words = wordsFor(strength);
    const result = await mutate(
      'vault.create',
      { password_b64: b64(password), words, user_knows_password: userKnowsPassword },
      { op: 'create', password, install: true, onCommitted }
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
    watchLocks();
    return call('vault.unlock', { password_b64: b64(password) });
  },

  async lock() {
    watchLocks();
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

  // Temporary raw-key exports for signing (design 0001, Phase 2 removes them).
  compat: {
    async privateKey(account) {
      return (await call('compat.private_key', { account })).private_key_hex;
    },
    async beeWalletKey() {
      return (await call('compat.bee_wallet_key')).private_key_hex;
    },
    async publisherKey(originIndex) {
      return (await call('compat.publisher_key', { origin_index: originIndex })).private_key_hex;
    },
  },

  /**
   * Writes a node identity through the core's journal. `spec` is
   * `{ node: 'bee', data_dir, api_port, p2p_port }` or
   * `{ node: 'radicle', home, alias }`. A lost reply is resolved with
   * `nodes.op_status`.
   */
  async writeNodeIdentity(spec, opId) {
    try {
      return await call('nodes.write_identity', { op_id: opId, ...spec });
    } catch (err) {
      if (err.code !== CORE_UNAVAILABLE) throw err;
      await client().whenReady();
      const { status } = await call('nodes.op_status', { op_id: opId });
      if (status === 'installed') return { status, reconciled: true };
      throw err;
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
    },
    hasPending: () => pending !== null,
  },
};
