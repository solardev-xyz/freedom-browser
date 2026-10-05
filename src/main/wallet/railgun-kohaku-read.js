/** Current Kohaku instanceId/balance/notes surface over main-owned read evidence.
 * This is a viewing-only instance: no transaction preparation is advertised.
 */
const assert = require('assert/strict');
const { isRailgunWalletRunner } = require('./railgun-wallet-runner');
const {
  normalizeRailgunKohakuReadFilter,
  projectRailgunKohakuBalance,
  projectRailgunKohakuNotes,
} = require('./railgun-kohaku-read-data');
function createRailgunKohakuRead({ runner, journal, receipt }) {
  assert.ok(isRailgunWalletRunner(runner));
  const current = () => runner.read(receipt, journal);
  current();
  return Object.freeze({
    async instanceId() {
      return current().instanceId;
    },
    async balance(assets) {
      const filter = normalizeRailgunKohakuReadFilter(assets);
      return projectRailgunKohakuBalance(current().received, filter);
    },
    async notes(assets, includeSpent = false) {
      assert.equal(typeof includeSpent, 'boolean');
      const filter = normalizeRailgunKohakuReadFilter(assets);
      return projectRailgunKohakuNotes(current().received, filter, includeSpent);
    },
    async status() {
      const read = current();
      return Object.freeze({ ...read.readiness, poi: 'unverified', spendableGranted: false });
    },
  });
}
module.exports = { createRailgunKohakuRead };
