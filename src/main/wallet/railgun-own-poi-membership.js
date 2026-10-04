/** Main-only post-spend Shield membership composition. The invoking controller
 * owns authorization for this query: it discloses the derived blinded input.
 * No production/renderer caller is installed here. Returned receipts authorize
 * neither viewing-key release nor subsequent POI payload disclosure or spending.
 */
const assert = require('assert/strict');
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { preflightRailgunOwnPoi } = require('./railgun-own-witness');
const { captureRailgunOwnOperation } = require('./railgun-own-operation');
const { deriveRailgunPoiShieldSelector } = require('./railgun-poi-shield-selector');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const { createRailgunPoiSource, MAX_AGE_MS } = require('./railgun-poi-source');
const {
  verifyRailgunPoiMembership,
  assertRailgunPoiMembership,
} = require('./railgun-poi-membership');
const { REQUIRED_LIST, normalizePoiProofs } = require('./railgun-poi-records');
const { POI_LAUNCH_BLOCK } = require('./railgun-owned-poi-records');
const owners = new Map(),
  receipts = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun own POI membership unavailable'), {
    code: 'RAILGUN_OWN_POI_MEMBERSHIP_REFUSED',
  });
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const compareCapture = (current, baseline) => {
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
  ])
    assert.deepEqual(current[key], baseline[key]);
  // Routine confirmation/revision refreshes do not change the operation.
  // A new archive representation or anchor requires its own finality check.
  const anchor = (record) =>
    Object.hasOwn(record, 'archivedAt')
      ? { archived: true, finalized: record.finalized }
      : { archived: false };
  assert.deepEqual(anchor(current.record), anchor(baseline.record));
};
async function openRailgunOwnPoiMembership(options = {}) {
  let stage = 'context',
    scope,
    source,
    phase,
    timer,
    ownerDirectory,
    parent,
    closed = false,
    drained = false,
    success = false;
  const owner = {},
    controller = new AbortController();
  const releaseOwner = () => {
    if (owners.get(ownerDirectory) === owner) owners.delete(ownerDirectory);
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    controller.abort();
    source?.close();
    scope?.close();
    // Abort revokes admission; it never releases an in-flight phase/owner.
    if (drained) releaseOwner();
  };
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options)
        .filter((k) => k !== 'timeoutMs')
        .sort(),
      ['archive', 'coordinator', 'enrollment', 'selector', 'signal']
    );
    const { enrollment, coordinator, signal, timeoutMs = 480000 } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 480000);
    const selectorText = JSON.stringify(options.selector);
    assert.ok(typeof selectorText === 'string' && Buffer.byteLength(selectorText) <= 1024);
    const selector = JSON.parse(selectorText);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const policy = getRailgunPublicPolicy(archive);
    const publicIdentity = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
    parent = enrollment.getContext('engine');
    const context = getPrivacyContext(parent),
      started = performance.now(),
      deadline = started + timeoutMs;
    ownerDirectory = enrollment.directory;
    assert.ok(!owners.has(ownerDirectory));
    owners.set(ownerDirectory, owner);
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([signal, enrollment.signal, coordinator.signal, controller.signal]),
      isCurrent: () => {
        getPrivacyContext(parent);
        return true;
      },
    });
    scope.signal.addEventListener('abort', close, { once: true });
    const current = () => {
      assert.ok(!closed && !scope.signal.aborted && owners.get(ownerDirectory) === owner);
      assert.ok(!source?.signal.aborted);
      assert.ok(performance.now() >= started && performance.now() < deadline);
      getPrivacyContext(parent);
      phase?.assertCurrent();
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
    };
    const remaining = (max) => {
      current();
      const left = Math.min(max, Math.floor(deadline - performance.now()));
      assert.ok(left > 0);
      return left;
    };
    timer = setTimeout(close, timeoutMs);
    timer.unref?.();
    stage = 'preflight';
    const preflight = await preflightRailgunOwnPoi({
      enrollment,
      coordinator,
      archive,
      selector,
      signal: scope.signal,
      timeoutMs: remaining(300000),
    });
    current();
    if (preflight.status !== 'captured') {
      stage = 'preflight:' + preflight.stage;
      throw fail();
    }
    assert.deepEqual(preflight.publicIdentity, publicIdentity);
    stage = 'archive-anchor';
    assert.equal(preflight.observations.archiveAnchorChecked, true);
    stage = 'creator';
    assert.equal(preflight.creatorClassification.type, 'Shield');
    assert.equal(preflight.creatorClassification.legacy, false);
    assert.ok(preflight.creatorClassification.blockNumber >= POI_LAUNCH_BLOCK);
    assert.equal(preflight.poiPreparation.creator.type, 'Shield');
    assert.deepEqual(preflight.poiPreparation.ownEvidence.capsule, preflight.capture.capsule);
    stage = 'selector';
    let derived;
    try {
      phase = claimRailgunAccountPhase(enrollment, 'recovery');
      derived = await deriveRailgunPoiShieldSelector({
        handle: enrollment.getContext('engine', 'poi-shield-selector'),
        archive,
        capsule: preflight.poiPreparation.ownEvidence.capsule,
        creator: preflight.poiPreparation.creator,
        signal: scope.signal,
        timeoutMs: remaining(30000),
      });
      current();
      assert.equal(derived.utilityExitObserved, true);
      assert.equal(derived.selectorDerived, true);
    } finally {
      phase?.release();
      phase = undefined;
    }
    const recapture = async (name) => {
      stage = name;
      const fresh = await captureRailgunOwnOperation({
        enrollment,
        selector,
        signal: scope.signal,
        timeoutMs: remaining(45000),
      });
      current();
      assert.equal(fresh.status, 'captured');
      compareCapture(fresh.capture, preflight.capture);
    };
    // Genuine recovery is rechecked immediately before the owned disclosure.
    // This is not a journal writer lock or renewed source/finality receipt.
    await recapture('before-query');
    stage = 'source';
    const operation = createHash('sha256')
      .update(
        JSON.stringify([
          'freedom:railgun:own-poi-membership-v1',
          randomUUID(),
          enrollment.binding,
          preflight.capture.bindingDigest,
          derived.bindingDigest,
          derived.inputSha256,
        ])
      )
      .digest('hex');
    const handle = scope.getContext({
      ...context.subject,
      role: 'poi',
      operation: 'poi:' + operation,
    });
    const notes = Object.freeze([
      Object.freeze({ blindedCommitment: derived.blindedCommitment, type: 'Shield' }),
    ]);
    current();
    source = createRailgunPoiSource({ handle, notes });
    source.signal.addEventListener('abort', close, { once: true });
    current();
    const acquisitionStarted = performance.now();
    const acquisitionRemaining = (max) => {
      current();
      const now = performance.now();
      assert.ok(now >= acquisitionStarted);
      const left = Math.min(remaining(max), Math.floor(MAX_AGE_MS - (now - acquisitionStarted)));
      assert.ok(left > 0);
      return left;
    };
    stage = 'acquire';
    const acquired = await source.acquire({ timeoutMs: acquisitionRemaining(45000) });
    current();
    stage = 'membership-status';
    const observed = source.assertResult(acquired.receipt);
    assert.equal(observed, acquired.observation);
    assert.equal(observed.listKey, REQUIRED_LIST);
    assert.deepEqual(observed.statuses, [{ ...notes[0], status: 'Valid' }]);
    assert.equal(observed.rootsAccepted, true);
    assert.deepEqual(normalizePoiProofs(observed.proofs, notes), observed.proofs);
    assert.equal(observed.proofs.length, 1);
    assert.ok(Array.isArray(observed.events) && observed.events.length === 1);
    const event = observed.events[0].signedPOIEvent;
    assert.equal(event.index, Number(BigInt('0x' + observed.proofs[0].indices)));
    assert.equal(event.type, 'Shield');
    assert.equal('0x' + event.blindedCommitment.replace(/^0x/, ''), derived.blindedCommitment);
    stage = 'membership-verify';
    let membership;
    try {
      const budget = acquisitionRemaining(30000);
      phase = claimRailgunAccountPhase(enrollment, 'recovery');
      membership = await verifyRailgunPoiMembership({
        handle,
        source,
        receipt: acquired.receipt,
        archive,
        timeoutMs: budget,
      });
      current();
      assert.equal(membership.observation.membershipVerified, true);
      assert.deepEqual(membership.observation.proofs, observed.proofs);
    } finally {
      phase?.release();
      phase = undefined;
    }
    await recapture('after-query');
    stage = 'receipts';
    assert.equal(source.assertResult(acquired.receipt), observed);
    assert.equal(assertRailgunPoiMembership(membership.receipt, handle), membership.observation);
    const observation = freeze({
      capture: preflight.capture,
      poiPreparation: preflight.poiPreparation,
      selector: {
        blindedCommitment: derived.blindedCommitment,
        bindingDigest: derived.bindingDigest,
        inputSha256: derived.inputSha256,
      },
      membership: membership.observation,
      accountAuthenticated: false,
      sourceAuthenticated: false,
      currentFinalityVerified: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    const receipt = Object.freeze({});
    const assertCurrent = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < MAX_AGE_MS);
      current();
      assert.ok(performance.now() + margin < deadline);
      assert.equal(source.assertResult(acquired.receipt, margin), observed);
      assert.equal(
        assertRailgunPoiMembership(membership.receipt, handle, margin),
        membership.observation
      );
      return observation;
    };
    assertCurrent();
    receipts.set(receipt, { enrollment, coordinator, assertCurrent });
    clearTimeout(timer);
    timer = setTimeout(close, acquisitionRemaining(MAX_AGE_MS));
    timer.unref?.();
    success = true;
    return Object.freeze({ status: 'verified', receipt, observation, close, signal: scope.signal });
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    phase?.release();
    phase = undefined;
    drained = true;
    if (!success) close();
    if (closed) releaseOwner();
  }
}
function assertRailgunOwnPoiMembership(receipt, enrollment, coordinator, minimumRemainingMs = 0) {
  try {
    const entry = receipts.get(receipt);
    assert.ok(entry && entry.enrollment === enrollment && entry.coordinator === coordinator);
    return entry.assertCurrent(minimumRemainingMs);
  } catch {
    throw fail();
  }
}
module.exports = { openRailgunOwnPoiMembership, assertRailgunOwnPoiMembership };
