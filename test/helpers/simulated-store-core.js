/**
 * The identity core's set-A store methods (freedom-core design 0013,
 * "`vault-meta.json`"; PRF-6) for unit tests, simulated on the reference
 * modules, so a suite's file-text assertions still pin today's format. The
 * real core is tested against main in src/main/identity-manager.integration.test.js.
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
 *     (`endedSafes`), the account's grants forgotten (`forgotten`) and the
 *     record removed. A forget that fails (`options.forget` throws) refuses
 *     the removal and leaves the file as it was, as the core forgets before
 *     it removes (`accounts-remove-forget-first`).
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

function simulatedAccounts({ moved = true, forget = null } = {}) {
  const sim = { moved, forget, calls: [], endedSafes: [], forgotten: [] };
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
          state.onForget = null;
        }
      }),
  };
  return sim;
}

module.exports = { simulatedAccounts, referenceMeta };
