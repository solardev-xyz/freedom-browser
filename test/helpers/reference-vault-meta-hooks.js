/**
 * What the reference identity-manager.js (reference-vault-meta.js) reaches
 * outside vault-meta.json, answered as the identity core answers it
 * (freedom-core design 0013, "`vault-meta.json`"), for the simulated core
 * of the unit suites (simulated-store-core.js), which sets `state` before
 * each call:
 *   - a device read answers the address main already checked
 *     (`accounts.add_ledger` and `accounts.add_remote` take main's record);
 *   - the Swarm references are those main passed (`swarm_references`);
 *   - a deleted Safe's approvals are ended, its pending entry cleared once
 *     `safe_pending` is moved, and the account's dApp grants forgotten, by
 *     the core (`state.onEndSafe`, `state.onClearPending`,
 *     `state.onForget`), and its exclusion and message session stay main's,
 *     so they do nothing here.
 * The reference requires each of its modules by name, so one module serves
 * them all.
 */

const state = {
  device: null,
  references: [],
  onEndSafe: null,
  onClearPending: null,
  onForget: null,
};

module.exports = {
  state,
  // ./wallet/ledger/transport
  readAddresses: async (paths) => paths.map(() => state.device),
  // ./wallet/remote/account-proof
  proveRemoteAccount: async () => true,
  // ./swarm/feed-store
  getEthereumWalletIdentityReferences: () => state.references,
  // ./wallet/safe/safe-approvals
  beginDeletion: () => ({ release() {} }),
  endSafe: async (index) => state.onEndSafe?.(index),
  // ./wallet/safe/message-sessions
  discardSession: () => {},
  // ./wallet/safe/pending-store
  clearPending: (index) => state.onClearPending?.(index),
  // ./wallet/dapp-permissions
  revokePermissionsForWalletIndex: async (index) => state.onForget?.(index),
};
