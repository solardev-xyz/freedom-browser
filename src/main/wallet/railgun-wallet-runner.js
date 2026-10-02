/** Main-only authority around a reviewed guarded utility runner. runJob must
 * return only after router drain and observed process exit; no child-provided
 * boolean or deserialized receipt can grant scan completion.
 */
const assert = require('assert/strict');
const { normalizeRailgunWalletRead } = require('./railgun-wallet-read');
const { isRailgunWalletJournal } = require('./railgun-wallet-journal');
const instances = new WeakSet();
const {
  kinds,
  checkpointHash,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
} = require('./railgun-wallet-coverage');
function createRailgunWalletRunner({ runJob, inventory, policy, identity }) {
  assert.equal(typeof runJob, 'function');
  for (const value of [inventory, policy]) assert.match(value, /^[0-9a-f]{64}$/);
  const currentIdentity = () =>
    identity === undefined ? null : require('./railgun-identity').assertRailgunIdentity(identity);
  currentIdentity();
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
    const descriptor = currentIdentity();
    if (descriptor) assert.equal(walletId, descriptor.walletId);
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
      const read = normalizeRailgunWalletRead(result, coverage);
      if (descriptor) {
        assert.equal(read.instanceId, descriptor.instanceId);
        currentIdentity();
      }
      const state = await walletSession.inspectWalletState();
      walletSession.assertFresh(state);
      if (restore) assert.deepEqual(state, before);
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        read,
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
  function read(receipt, journal) {
    currentIdentity();
    assert.ok(isRailgunWalletJournal(journal));
    const saved = receipts.get(receipt);
    assert.ok(saved && !saved.session.signal.aborted);
    assert.equal(journal.identity.walletId, saved.walletId);
    assert.equal(journal.identity.policy, policy);
    assert.equal(journal.identity.storeId, saved.state.storeId);
    const readiness = journal.assertReceipt(receipt);
    return Object.freeze({ ...saved.read, readiness });
  }
  const instance = Object.freeze({ run, assertScan, read });
  instances.add(instance);
  return instance;
}
function createRailgunAccountRunner({ identity, archive, policy }) {
  require('./railgun-identity').assertRailgunIdentity(identity);
  archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  return createRailgunWalletRunner({
    identity,
    policy,
    inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    runJob: (options) =>
      require('./railgun-wallet-run').runRailgunWalletSnapshot({ ...options, identity, archive }),
  });
}
module.exports = {
  createRailgunWalletRunner,
  createRailgunAccountRunner,
  isRailgunWalletRunner: (v) => instances.has(v),
};
