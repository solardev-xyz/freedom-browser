/** Completed-attempt retained POI diagnostic. No additional proof-specific root
 * queries, sender, receipt, registry restoration or current note eligibility.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const path = require('path');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { recoverRailgunPoiOutput } = require('./railgun-poi-output-recovery');
const { verifyRailgunPoiPayload } = require('./railgun-poi-verifier');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const owners = new Map();
const TOTAL_MS = 300000,
  OUTPUT_MS = 240000,
  VERIFY_MS = 35000,
  FINAL_MS = 15000;
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function validateRailgunRetainedPoi(options = {}) {
  let stage = 'context',
    store,
    timer,
    directory,
    phase;
  const owner = {},
    controller = new AbortController();
  const stop = () => controller.abort();
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options).sort(),
      [
        'identity',
        'enrollment',
        'coordinator',
        'archive',
        'proverArchive',
        'artifactDirectory',
        'capsuleDigest',
        'signal',
        ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []),
      ].sort()
    );
    const {
      identity,
      enrollment,
      coordinator,
      capsuleDigest,
      signal,
      artifactDirectory,
      timeoutMs = TOTAL_MS,
    } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= TOTAL_MS);
    assert.match(capsuleDigest, /^[0-9a-f]{64}$/);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const proverArchive = verifyRailgunProverRuntime(options.proverArchive);
    assert.ok(typeof artifactDirectory === 'string' && path.isAbsolute(artifactDirectory));
    assert.ok(Buffer.byteLength(artifactDirectory) <= 4096);
    const handle = enrollment.getContext('engine');
    const descriptor = assertRailgunIdentity(identity, handle);
    assert.deepEqual(descriptor, enrollment.descriptor);
    const policy = getRailgunPublicPolicy(archive);
    const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
    directory = enrollment.directory;
    assert.ok(!owners.has(directory));
    owners.set(directory, owner);
    const started = performance.now(),
      deadline = started + timeoutMs;
    const lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const current = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < TOTAL_MS);
      assert.ok(
        !lifetime.aborted &&
          !store?.signal.aborted &&
          performance.now() >= started &&
          performance.now() + margin < deadline
      );
      assert.equal(owners.get(directory), owner);
      assert.deepEqual(assertRailgunIdentity(identity, handle), descriptor);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
    };
    const remaining = (limit, reserve = 0) => {
      current(reserve);
      const left = Math.min(limit, Math.floor(deadline - performance.now()) - reserve);
      assert.ok(left > 0);
      return left;
    };
    timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    stage = 'stored';
    store = await enrollment.openPoiIntents();
    current();
    store.signal.addEventListener('abort', stop, { once: true });
    const entry = await store.get(capsuleDigest);
    current();
    assert.ok(entry && entry.state === 'prepared');
    assert.equal(entry.capsuleDigest, capsuleDigest);
    const payload = normalizeRailgunPoiPayload(entry.payload);
    assert.equal(sha(JSON.stringify(payload)), entry.payloadSha256);
    const stored = JSON.stringify(entry);
    const readCurrent = async () => {
      current();
      const latest = await store.get(capsuleDigest);
      current();
      assert.equal(JSON.stringify(latest), stored);
    };
    stage = 'output';
    const output = await recoverRailgunPoiOutput({
      identity,
      enrollment,
      coordinator,
      archive,
      capsuleDigest,
      signal: lifetime,
      timeoutMs: remaining(OUTPUT_MS, VERIFY_MS + FINAL_MS),
    });
    current();
    if (output.status !== 'matched') {
      stage = 'output:' + output.stage;
      throw Error('refused');
    }
    assert.equal(output.capsuleDigest, capsuleDigest);
    assert.equal(output.revision, entry.revision);
    assert.equal(output.payloadSha256, entry.payloadSha256);
    assert.equal(output.outputMatched, true);
    for (const name of [
      'proofVerified',
      'originalInputReconstructed',
      'originalRootsAccepted',
      'membershipAuthenticated',
      'sourceAuthenticated',
      'disclosureEnabled',
      'spendingEnabled',
    ])
      assert.equal(output[name], false);
    await readCurrent();
    stage = 'verify';
    phase = claimRailgunAccountPhase(enrollment, 'recovery');
    try {
      const verified = await verifyRailgunPoiPayload({
        handle: enrollment.getContext('prover', 'poi-verify'),
        proverArchive,
        artifactDirectory,
        payload,
        signal: lifetime,
        timeoutMs: remaining(VERIFY_MS, FINAL_MS),
      });
      current();
      phase.assertCurrent();
      assert.equal(verified.payloadSha256, entry.payloadSha256);
      assert.equal(verified.proofVerified, true);
      assert.equal(verified.independentlyVerified, true);
      assert.equal(verified.utilityExitObserved, true);
      for (const name of [
        'sourceAuthenticated',
        'membershipAuthenticated',
        'rootAccepted',
        'metadataAuthenticated',
        'ownershipAuthenticated',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        assert.equal(verified[name], false);
    } finally {
      phase.release();
      phase = undefined;
    }
    await readCurrent();
    stage = 'final-account';
    const bind = (capture) => {
      assert.equal(capture.capsuleDigest, capsuleDigest);
      assert.equal(capture.bindingDigest, entry.bindingDigest);
      assert.deepEqual(capture.selector, entry.selector);
    };
    const final = await withRailgunOwnOperationRecovery(
      {
        enrollment,
        selector: entry.selector,
        signal: lifetime,
        timeoutMs: remaining(FINAL_MS),
      },
      async (window) => {
        current(1000);
        window.assertCurrent(1000);
        bind(window.capture);
        const capture = await window.reattest();
        current(1000);
        window.assertCurrent(1000);
        bind(capture);
        assertRailgunOwnPoiCapture(capture, window.capture);
        await readCurrent();
        current(1000);
        window.assertCurrent(1000);
        return { checked: true };
      }
    );
    current();
    if (final.status !== 'used') {
      stage = 'final-account:' + final.stage;
      throw Error('refused');
    }
    assert.deepEqual(final.value, { checked: true });
    await readCurrent();
    current();
    return Object.freeze({
      status: 'validated',
      capsuleDigest,
      revision: entry.revision,
      payloadSha256: entry.payloadSha256,
      outputMatched: true,
      proofVerified: true,
      independentlyVerified: true,
      verifierExitObserved: true,
      viewingKeyReleases: output.viewingKeyReleases,
      viewingUtilityExitObserved: output.viewingUtilityExitObserved,
      originalInputReconstructed: false,
      originalRootsAccepted: false,
      rootAccepted: false,
      originalTxidRootCanonical: false,
      currentNoteEligibility: false,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    clearTimeout(timer);
    controller.abort();
    phase?.release();
    store?.signal.removeEventListener('abort', stop);
    if (owners.get(directory) === owner) owners.delete(directory);
  }
}
module.exports = { validateRailgunRetainedPoi };
