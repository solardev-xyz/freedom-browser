/** Main-only authority around a reviewed guarded utility runner. runJob must
 * return only after router drain and observed process exit; no child-provided
 * boolean or deserialized receipt can grant scan completion.
 */
const assert = require('assert/strict');
const {
  kinds,
  checkpointHash,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
} = require('./railgun-wallet-coverage');
function createRailgunWalletRunner({ runJob, inventory, policy }) {
  assert.equal(typeof runJob, 'function');
  for (const value of [inventory, policy]) assert.match(value, /^[0-9a-f]{64}$/);
  const receipts = new WeakMap();
  function assertScan(receipt, expected) {
    const saved = receipts.get(receipt);
    assert.ok(saved && !saved.session.signal.aborted);
    assert.equal(saved.session, expected.session);
    assert.equal(saved.walletId, expected.walletId);
    assert.equal(expected.policy, policy);
    if (expected.checkpoint) assert.equal(saved.checkpoint, checkpointHash(expected.checkpoint));
    if (expected.summary) assert.deepEqual(saved.summary, expected.summary);
    if (expected.mode) assert.equal(saved.mode, expected.mode);
    if (expected.state && saved.mode === 'restore') assert.deepEqual(saved.state, expected.state);
  }
  async function run({ snapshot, walletSession, coverageStore, walletId, restore, ...options }) {
    assert.equal(typeof restore, 'boolean');
    assert.equal(coverageStore.session, walletSession);
    const before = await walletSession.inspectWalletState();
    walletSession.assertFresh(before);
    const grant = coverageStore.beginEngine();
    try {
      const result = await runJob({
        ...options,
        snapshot,
        walletSession,
        walletGrant: grant,
        walletId,
        restore,
      });
      assert.equal(result.closed?.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(result.inventory, inventory);
      assert.equal(result.spendableGranted, false);
      assert.equal(result.poiCalls, 0);
      const guards = result.guards;
      assert.equal(guards?.attempts, 0);
      assert.ok(Array.isArray(guards.hooks) && guards.hooks.length > 0);
      assert.equal(new Set(guards.hooks).size, guards.hooks.length);
      assert.equal(guards.canaries, guards.hooks.length);
      const coverage = normalizeRailgunWalletCoverage(
        snapshot.checkpoint,
        Object.fromEntries(['scannedLeaves', ...kinds].map((name) => [name, result[name]]))
      );
      const state = await walletSession.inspectWalletState();
      walletSession.assertFresh(state);
      if (restore) assert.deepEqual(state, before);
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        session: walletSession,
        walletId,
        checkpoint: checkpointHash(snapshot.checkpoint),
        summary: summarizeRailgunWalletCoverage(coverage),
        mode: restore ? 'restore' : 'scan',
        state,
      });
      coverageStore.finishEngine(receipt);
      return { result, receipt, coverage };
    } catch (error) {
      coverageStore.close();
      throw error;
    }
  }
  return Object.freeze({ run, assertScan });
}
module.exports = { createRailgunWalletRunner };
