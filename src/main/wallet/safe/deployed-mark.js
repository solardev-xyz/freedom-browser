/**
 * A Safe's deployed mark, as vault-meta stores it per chain (#1066).
 *
 * Only a verified check writes it: a verified eth_getCode read, or the
 * verified receipt of the deployment Freedom sent (safe-service). It is
 * stored as `{ verified: true }`.
 *
 * A release before #1066 stored a bare `true`, which one RPC endpoint's
 * eth_getCode answer was enough to write. That mark stays on disk, but the
 * record seams (identity-manager) read it as not deployed: the Safe is
 * pending until a verified check marks it again. Status and activation
 * run that check (safe-service's isDeployedOnChain); Send and SafeMessages
 * refuse the Safe until then.
 */

/** The mark a verified check stores, for one chain. */
function verifiedDeployedMark() {
  return { verified: true };
}

/**
 * The chains a stored `deployed` map has a verified mark on, as the record
 * seams expose them: `{ [chainId]: true }`. A mark of a release before
 * #1066 is left out.
 *
 * @param {Object|undefined} stored - The record's `deployed` in vault-meta
 * @returns {Object<string, true>}
 */
function verifiedDeployments(stored) {
  const deployed = {};
  for (const [chainId, mark] of Object.entries(stored || {})) {
    if (mark?.verified === true) {
      deployed[chainId] = true;
    }
  }
  return deployed;
}

module.exports = { verifiedDeployedMark, verifiedDeployments };
