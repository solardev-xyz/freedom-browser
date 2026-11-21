/* global jest */
/**
 * The identity core's set-A store methods (freedom-core design 0013,
 * "`vault-meta.json`" and "Pending Safe transactions"; PRF-6) for unit
 * tests, simulated on the reference modules, so a suite's file-text
 * assertions still pin today's format. The real core is tested against
 * main in src/main/identity-manager.integration.test.js and
 * src/main/wallet/safe/pending-store.integration.test.js.
 *
 * `simulatedAccounts(options)` is `vaultBackend.accounts` as main sees it
 * (core/vault-backend.js, after its error mapping), each method run by the
 * reference identity-manager.js (reference-vault-meta.js) on the
 * vault-meta.json of the suite's identity directory, in the module registry
 * the suite loaded main's module in (so the reference derives addresses and
 * reads the lock state from the suite's vault-backend mock):
 *   - `list`, `meta`, `active` are `getDerivedWallets` (its first-list
 *     default written), `getVaultMeta` (`referenceMeta`, which the
 *     reference doesn't export) and `getActiveWalletIndex`;
 *   - `addMnemonic`, `addLedger`, `addRemote`, `recordAddressCheck`,
 *     `addSafe`, `markSafeDeployed`, `setActive`, `rename` are the
 *     reference's own changes, a device or phone record being the one main
 *     checked;
 *   - `remove(index, swarmReferences)` is `deleteDerivedWallet` with main's
 *     references: its refusals, then a Safe's approvals ended
 *     (`endedSafes`), its pending SafeTx cleared by `options.pending` (a
 *     `simulatedSafePending`) once that store is moved, the account's
 *     grants forgotten (`forgotten`) and the record removed. A forget that
 *     fails (`options.forget` throws) refuses the removal and leaves the
 *     file as it was, as the core forgets before it removes
 *     (`accounts-remove-forget-first`); the pending entry stays cleared, as
 *     the core clears it before the forget.
 * A refusal keeps the reference's message and code; one without a code is
 * `invalid_argument`, as the core answers it. With `moved: false` (a core
 * that didn't take `vault_meta`) every method fails `requirement_unmet`,
 * and nothing is written. `calls` records `[method, caller]`, the caller
 * `'chrome'` or `'shell'`.
 */

const fs = require('fs');
const path = require('path');

function coded(code, message) {
  return Object.assign(new Error(message), { code });
}

/** The identity directory's vault-meta.json. */
function metaFile() {
  return path.join(require('../../src/main/profile-paths').getIdentityDataDir(), 'vault-meta.json');
}

/**
 * The reference's `getVaultMeta()` (`identity:get-vault-meta`'s answer),
 * which it doesn't export: the file parsed, or null for none or one that
 * doesn't parse.
 */
function referenceMeta() {
  const file = metaFile();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

function simulatedAccounts({ moved = true, forget = null, pending = null } = {}) {
  const sim = { moved, forget, pending, calls: [], endedSafes: [], forgotten: [] };
  const reference = () => require('./reference-vault-meta');
  const hooks = () => require('./reference-vault-meta-hooks').state;

  async function run(method, caller, change) {
    sim.calls.push([method, caller === 'chrome' ? 'chrome' : 'shell']);
    if (!sim.moved) throw coded('requirement_unmet', "The core can't take this request");
    try {
      return await change(reference(), hooks());
    } catch (err) {
      if (!err.code) err.code = 'invalid_argument';
      throw err;
    }
  }

  sim.accounts = {
    list: (caller = null) => run('accounts.list', caller, (ref) => ref.getDerivedWallets()),
    meta: (caller = null) => run('accounts.meta', caller, () => referenceMeta()),
    active: (caller = null) => run('accounts.active', caller, (ref) => ref.getActiveWalletIndex()),
    addMnemonic: (name, caller = null) =>
      run('accounts.add_mnemonic', caller, (ref) => ref.createDerivedWallet(name)),
    addLedger: ({ name, address, path }) =>
      run('accounts.add_ledger', null, (ref, state) => {
        state.device = address;
        return ref.addLedgerWallet(name, address, path);
      }),
    addRemote: ({ name, address }) =>
      run('accounts.add_remote', null, (ref) => ref.addRemoteWallet(name, address)),
    recordAddressCheck: (type, index, matched) =>
      run('accounts.record_address_check', null, (ref) => {
        if (typeof matched !== 'boolean') throw new Error('Invalid parameters');
        if (type === 'ledger') return ref.recordLedgerAddressCheck(index, matched);
        if (type === 'remote') return ref.recordRemoteAddressCheck(index, matched);
        throw new Error('Invalid parameters');
      }),
    addSafe: ({ name, address, owners, threshold, saltNonce }) =>
      run('accounts.add_safe', null, (ref) =>
        ref.addSafeWallet(name, { address, owners, threshold, saltNonce })
      ),
    markSafeDeployed: (index, chainId) =>
      run('accounts.mark_safe_deployed', null, (ref) => ref.markSafeDeployed(index, chainId)),
    setActive: (index, caller = null) =>
      run('accounts.set_active', caller, (ref) => ref.setActiveWalletIndex(index)),
    rename: (index, name, caller = null) =>
      run('accounts.rename', caller, (ref) => ref.renameDerivedWallet(index, name)),
    remove: (index, swarmReferences = [], caller = null) =>
      run('accounts.remove', caller, async (ref, state) => {
        const file = metaFile();
        const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
        let forgetFailed = false;
        state.references = swarmReferences;
        state.onEndSafe = (safe) => sim.endedSafes.push(safe);
        state.onClearPending = (safe) => sim.pending?.clearForRemoval(safe);
        state.onForget = async (account) => {
          try {
            if (sim.forget) await sim.forget(account);
          } catch (err) {
            forgetFailed = true;
            throw err;
          }
          sim.forgotten.push(account);
          return [];
        };
        try {
          await ref.deleteDerivedWallet(index);
        } catch (err) {
          if (forgetFailed && before) fs.writeFileSync(file, before);
          throw err;
        } finally {
          state.references = [];
          state.onEndSafe = null;
          state.onClearPending = null;
          state.onForget = null;
        }
      }),
  };
  return sim;
}

/** The suite's Freedom root's safe-pending.json. */
function pendingFile() {
  return require('../../src/main/freedom-root').getFreedomDataPath('safe-pending.json');
}

/**
 * `simulatedSafePending(options)` is `vaultBackend.safePending` as main sees
 * it (core/vault-backend.js), each method run by the reference
 * pending-store.js (reference-pending-store.js), loaded afresh for each
 * request as the core reads the file for each, on the safe-pending.json of
 * the suite's Freedom root: `get` (the entry as JSON gives it back, a new
 * object each time, or null), `list`, `set` (`{ durable: true }`) and
 * `clear` (`{ cleared, durable: true }`, `cleared` when the index had an
 * entry). With `moved: false` (a core that didn't take `safe_pending`)
 * every method fails `requirement_unmet`, and nothing is written. `fail`,
 * when set, is called with `(method, params)` before each request and
 * fails it by throwing, the file unchanged (`storage` unless it sets a
 * code). `loseReply`, when set, is called with `(method, params)` after
 * each request has been applied, and a truthy answer loses its reply: the
 * request fails `core_unavailable` though the file has changed, as when the
 * core wrote and then exited before answering. `calls` records
 * `[method, params]`. `clearForRemoval(index)` is
 * the clear `accounts.remove` makes for a Safe, the core's own: nothing
 * until the store is moved. `text()` is the file's text, or null.
 */
function simulatedSafePending({ moved = true, fail = null, loseReply = null } = {}) {
  const sim = { moved, fail, loseReply, calls: [] };
  const fresh = () => {
    let reference;
    jest.isolateModules(() => {
      reference = require('./reference-pending-store');
    });
    return reference;
  };
  const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

  async function run(method, params, answer) {
    sim.calls.push([method, copy(params)]);
    if (!sim.moved) throw coded('requirement_unmet', "The core can't take this request");
    if (sim.fail) {
      try {
        await sim.fail(method, params);
      } catch (err) {
        if (!err.code) err.code = 'storage';
        throw err;
      }
    }
    const result = answer(fresh());
    if (sim.loseReply?.(method, params)) {
      throw coded('core_unavailable', 'The identity core stopped before it answered');
    }
    return result;
  }

  const clearIn = (reference, index) => {
    const cleared = reference.listPendingIndexes().includes(index);
    reference.clearPending(index);
    return cleared;
  };

  sim.safePending = {
    get: (index) => run('safe_pending.get', { index }, (ref) => copy(ref.getPending(index))),
    list: () => run('safe_pending.list', {}, (ref) => ref.listPendingIndexes()),
    set: (index, entry) =>
      run('safe_pending.set', { index, entry }, (ref) => {
        ref.setPending(index, copy(entry));
        return { durable: true };
      }),
    clear: (index) =>
      run('safe_pending.clear', { index }, (ref) => ({
        cleared: clearIn(ref, index),
        durable: true,
      })),
  };
  sim.clearForRemoval = (index) => {
    if (sim.moved) clearIn(fresh(), index);
  };
  sim.text = () => {
    const file = pendingFile();
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null;
  };
  return sim;
}

module.exports = { simulatedAccounts, simulatedSafePending, referenceMeta };
