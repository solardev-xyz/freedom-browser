/** Recovery with keyless selector -> existing TXID checkpoint -> recovery.
 * Each phase drains before the next; detached data is compared across phases.
 * No writer exclusion, source/root acceptance or ongoing authority is returned.
 */
const assert = require('assert/strict');
const { getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunTxidPolicy } = require('./railgun-txid-policy');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const {
  captureRailgunOwnOperation,
  captureRailgunOwnOperationSelector,
} = require('./railgun-own-operation');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
async function captureRailgunOwnWitness({
  enrollment,
  coordinator,
  archive,
  selector,
  signal,
  timeoutMs = 180000,
} = {}) {
  let stage = 'context',
    timer,
    txid;
  const controller = new AbortController();
  try {
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000);
    const text = JSON.stringify(selector);
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 1024);
    const selected = JSON.parse(text);
    archive = verifyRailgunEngineRuntime(archive);
    const publicPolicy = getRailgunPublicPolicy(archive),
      txidPolicy = getRailgunTxidPolicy(archive),
      publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
      parent = enrollment.getContext('engine'),
      started = performance.now(),
      deadline = started + timeoutMs;
    const lifetime = AbortSignal.any([
      signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const current = () => {
      getPrivacyContext(parent);
      assert.ok(!lifetime.aborted && performance.now() >= started && performance.now() < deadline);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
        publicIdentity
      );
    };
    const remaining = (max) => {
      current();
      return Math.max(1, Math.min(max, Math.floor(deadline - performance.now())));
    };
    const stop = () => {
      txid?.close().catch(() => {});
    };
    lifetime.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      stage = 'capture';
      const first = await captureRailgunOwnOperationSelector({
        enrollment,
        archive,
        selector: selected,
        signal: lifetime,
        timeoutMs: remaining(45000),
      });
      current();
      if (first.status !== 'captured') {
        stage = 'capture:' + first.stage;
        throw Error('capture refused');
      }
      const derived = first.derived;
      stage = 'txid';
      // Retain even a late-opened session and drain it in finally. Cancellation
      // never races away from storage/worker completion or releases its phase.
      txid = await openRailgunAccountTxid({
        enrollment,
        coordinator,
        archive,
        create: false,
        checkpointOnly: true,
      });
      current();
      assert.equal(txid.policy, txidPolicy);
      assert.deepEqual(txid.publicIdentity, publicIdentity);
      const before = await txid.inspect();
      current();
      assert.ok(before.checkpoint && !before.pending);
      stage = before.capacityReached ? 'txid-capacity' : 'txid-behind';
      assert.match(before.checkpoint.state.after, /^0x[0-9a-f]{192}$/);
      assert.ok(
        BigInt('0x' + before.checkpoint.state.after.slice(2, 66)) >=
          BigInt(first.capture.projection.blockNumber)
      );
      stage = 'txid-witness';
      const state = freeze(JSON.parse(JSON.stringify(before.checkpoint.state)));
      const found = await txid.witness(derived.railgunTxid);
      current();
      const witness = normalizeRailgunTxidWitness(found.witness, state, derived.railgunTxid);
      const after = await txid.inspect();
      current();
      assert.equal(after.pending, null);
      assert.deepEqual(after.checkpoint, before.checkpoint);
      stage = 'txid-close';
      await txid.close();
      txid = undefined;
      current();
      stage = 'recapture';
      const latest = await captureRailgunOwnOperation({
        enrollment,
        selector: selected,
        signal: lifetime,
        timeoutMs: remaining(45000),
      });
      current();
      if (latest.status !== 'captured') {
        stage = 'recapture:' + latest.stage;
        throw Error('recapture refused');
      }
      for (const key of [
        'bindingDigest',
        'selector',
        'facts',
        'submitter',
        'capsule',
        'capsuleDigest',
        'provedTransaction',
        'intent',
        'projection',
      ]) {
        assert.deepEqual(latest.capture[key], first.capture[key]);
      }
      stage = 'row';
      const { row } = witness,
        { projection, intent } = latest.capture;
      assert.equal(row.txid, projection.hash.slice(2));
      assert.equal(row.blockNumber, projection.blockNumber);
      assert.equal(row.utxoTreeIn, intent.tree);
      assert.deepEqual(row.nullifiers, [intent.nullifier]);
      assert.deepEqual(row.commitments, [intent.commitment]);
      assert.equal(row.boundParamsHash, intent.boundParamsHash);
      if (intent.operation === 'railgun-private-transfer') {
        assert.equal(row.unshield, undefined);
        assert.equal(row.utxoTreeOut, projection.railgun.transact.output.tree);
        assert.equal(row.utxoBatchStartPositionOut, projection.railgun.transact.output.position);
      } else {
        assert.equal(intent.operation, 'railgun-token-unshield');
        assert.equal(row.utxoTreeOut, 99999);
        assert.equal(row.utxoBatchStartPositionOut, 99999);
        assert.deepEqual(row.unshield, {
          toAddress: intent.recipient,
          value: intent.amount,
          tokenData: {
            tokenType: 0,
            tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
            tokenSubID: '0x' + '0'.repeat(64),
          },
        });
      }
      return freeze({
        status: 'captured',
        capture: latest.capture,
        state,
        witness,
        publicIdentity,
        publicPolicy,
        txidPolicy,
        accountAuthenticated: false,
        sourceAuthenticated: false,
        currentFinalityVerified: false,
        txidPathVerified: false,
        txidRootAccepted: false,
        poiVerified: false,
        spendingEnabled: false,
      });
    } finally {
      lifetime.removeEventListener('abort', stop);
    }
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (txid) await txid.close();
  }
}
module.exports = { captureRailgunOwnWitness };
