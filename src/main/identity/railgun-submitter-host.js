/** Fixed main-only public wallet metadata port for the extracted Railgun owner.
 * No vault key, signer, account selector or original record crosses this port.
 * This prerequisite is inactive until the complete owner composition is wired.
 */
const assert = require('assert');
const { isMainThread } = require('worker_threads');
const fail = () =>
  Object.assign(new Error('Railgun submitter host unavailable'), {
    code: 'RAILGUN_SUBMITTER_HOST_REFUSED',
  });
function createRailgunSubmitterHost(...args) {
  if (args.length || !isMainThread || (process.type !== undefined && process.type !== 'browser'))
    throw fail();
  return Object.freeze({
    readMetadata(...args) {
      if (args.length) throw fail();
      // Keep this fresh and lazy, exactly as the original recovered-submission
      // reader: no identity-manager load merely from an ordinary EOA operation.
      const { getWalletRecord, WALLET_TYPES } = require('../identity-manager');
      const record = getWalletRecord(0);
      assert.ok(record && record.index === 0 && record.type === WALLET_TYPES.MNEMONIC);
      const address = require('ethers').getAddress(record.address).toLowerCase();
      assert.ok(BigInt(address) > 0n);
      return Object.freeze({ index: 0, type: record.type, address });
    },
  });
}
module.exports = { createRailgunSubmitterHost };
