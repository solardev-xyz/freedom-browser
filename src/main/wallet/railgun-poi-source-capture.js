/** Main-owned combined creator/own-source attestation after a genuine snapshot fully completes.
 * It authenticates retained source bytes, not the supplied capsule,
 * account ownership of the transaction, chain finality, POI or spending authority.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  assertRailgunAccountPublic,
  getRailgunAccountPublicIdentity,
} = require('./railgun-account-public');
const { collectRailgunPoiSourceEvidence } = require('./railgun-poi-source-evidence');
const { checkpointHash } = require('./railgun-wallet-coverage');
const receipts = new WeakMap();
const captures = new WeakSet();
const fail = () =>
  Object.assign(new Error('Railgun POI source capture unavailable'), {
    code: 'RAILGUN_POI_SOURCE_CAPTURE_REFUSED',
  });
async function capture({
  enrollment,
  coordinator,
  capsule,
  record,
  transaction,
  receipt,
  signal,
  timeoutMs = 45000,
}) {
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000);
  const policy = assertRailgunAccountPublic(coordinator, enrollment);
  const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
  assert.ok(!captures.has(coordinator));
  const text = JSON.stringify({ capsule, record, transaction, receipt });
  assert.ok(Buffer.byteLength(text) <= 192 * 1024);
  const supplied = JSON.parse(text);
  const parent = enrollment.getContext('engine');
  const started = performance.now(),
    deadline = started + timeoutMs;
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([signal, enrollment.signal, coordinator.signal]),
  });
  let evidence,
    captured,
    closed = false;
  const current = () => {
    assert.ok(
      !closed &&
        !scope.signal.aborted &&
        performance.now() >= started &&
        performance.now() < deadline
    );
    getPrivacyContext(parent);
    assertRailgunAccountPublic(coordinator, enrollment, policy);
    assert.deepEqual(
      getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
      publicIdentity
    );
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    scope.close();
  };
  const timer = setTimeout(close, timeoutMs);
  timer.unref?.();
  scope.signal.addEventListener('abort', close, { once: true });
  captures.add(coordinator);
  try {
    current();
    // Await the coordinator itself, including its final authentication/refresh.
    // Cancellation revokes admission; it never races away from in-flight work.
    const snapshot = await coordinator.withPublicSnapshot(async (window) => {
      try {
        current();
        const assertCurrent = () => {
          current();
          assert.ok(!window.signal.aborted);
        };
        const value = await collectRailgunPoiSourceEvidence({
          ...supplied,
          checkpoint: window.checkpoint,
          visit: window.visitSource,
          assertCurrent,
        });
        assertCurrent();
        return value;
      } catch {
        // Ordinary mismatches and capture-local cancellation are not ledger
        // corruption. The coordinator independently tracks visitor failures.
        return null;
      }
    });
    current();
    assert.ok(snapshot.value);
    captured = coordinator.assertSnapshot(snapshot.evidence);
    assert.equal(captured.source.ledgerId, publicIdentity.sourceId);
    assert.equal(checkpointHash(captured), snapshot.value.checkpointHash);
    evidence = snapshot.evidence;
    const observation = Object.freeze({
      ...snapshot.value,
      creator: Object.freeze({ ...snapshot.value.creator, sourceAuthenticated: true }),
      own: Object.freeze({ ...snapshot.value.own, sourceAuthenticated: true }),
      publicIdentity,
      sourceAuthenticated: true,
    });
    const token = Object.freeze({});
    const assertCurrent = () => {
      current();
      assert.equal(
        checkpointHash(coordinator.assertSnapshot(evidence)),
        observation.checkpointHash
      );
      return observation;
    };
    assertCurrent();
    receipts.set(token, { enrollment, coordinator, assertCurrent });
    return Object.freeze({ receipt: token, observation, close, signal: scope.signal });
  } catch {
    close();
    throw fail();
  } finally {
    captures.delete(coordinator);
  }
}
exports.captureRailgunPoiSource = async (options) => {
  try {
    return await capture(options);
  } catch {
    throw fail();
  }
};
exports.assertRailgunPoiSource = (receipt, enrollment, coordinator) => {
  try {
    const entry = receipts.get(receipt);
    assert.ok(entry && entry.enrollment === enrollment && entry.coordinator === coordinator);
    return entry.assertCurrent();
  } catch {
    throw fail();
  }
};
