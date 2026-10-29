/**
 * The vault's authority epoch (K-1).
 *
 * A key read from the unlocked vault is only good for the epoch it was read
 * in. Every lock (the inactivity auto-lock, an explicit lock, a lock straight
 * through the vault module), every vault delete or replacement and app quit
 * moves the epoch on, synchronously, before anything else. Work that holds a
 * key across an await, or queues a signing step for later, records the epoch
 * when it took the key and checks it again right before the key is used or
 * written anywhere: a changed epoch means the vault was locked meanwhile, and
 * the work must stop.
 *
 * No dependencies, so the signing services can import it without pulling in
 * identity-manager.
 */

const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');

let epoch = 0;

/** The current epoch. */
function currentVaultEpoch() {
  return epoch;
}

/** Move the epoch on; called by identity-manager on every revocation. */
function advanceVaultEpoch() {
  epoch += 1;
  return epoch;
}

/**
 * Throw the vault-locked error unless `taken` is still the current epoch.
 * @param {number} taken - the epoch the key was read in
 */
function assertVaultEpoch(taken) {
  if (taken !== epoch) {
    throw new Error(VAULT_LOCKED_MESSAGE);
  }
}

module.exports = { currentVaultEpoch, advanceVaultEpoch, assertVaultEpoch };
