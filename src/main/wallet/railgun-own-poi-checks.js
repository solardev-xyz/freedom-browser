/** Fresh diagnostic checks for a genuine local POI proof. No owned-note lookup,
 * proof submission or production caller. Historical root queries still reveal
 * proof-related timing; a future invoking controller owns that authorization.
 */
const assert = require('assert/strict');
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { assertRailgunOwnPoiProof } = require('./railgun-own-poi-proof');
const { preflightRailgunRetainedPoiCompleted } = require('./railgun-own-witness');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const {
  getRailgunAccountPublicDestination,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const { assertRailgunPoiCreatorVerification } = require('./railgun-poi-creator-data');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const {
  createRailgunPoiRootSource,
  createRailgunPoiTxidRootSource,
} = require('./railgun-poi-root');
const { bindRailgunOwnPoiPayload } = require('./railgun-own-poi-proof-data');
const owners = new Map(),
  receipts = new WeakMap();
const MAX_AGE_MS = 60000,
  MAX_TOTAL_MS = 240000,
  MAX_PREFLIGHT_MS = 180000,
  MARGIN_MS = 1000;
const fail = () =>
  Object.assign(new Error('Railgun own POI checks unavailable'), {
    code: 'RAILGUN_OWN_POI_CHECKS_REFUSED',
  });
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function compareHistory(current, history) {
  assert.equal(current.observations.archiveAnchorChecked, true);
  const before = history.capture,
    after = current.capture;
  if (!Object.hasOwn(before.record, 'archivedAt') && Object.hasOwn(after.record, 'archivedAt')) {
    // Fresh preflight checked this new archive anchor. Only the historical
    // representation comparison is rebased; every stable proof input still
    // passes the same strict comparator. Inside this run no transition is allowed.
    assertRailgunOwnPoiCapture(after, { ...before, record: after.record });
  } else assertRailgunOwnPoiCapture(after, before);
  assert.deepEqual(current.publicIdentity, history.publicIdentity);
  assert.ok(['Shield', 'Transact'].includes(current.creatorClassification.type));
  assert.equal(current.creatorClassification.type, history.preparation.creator.type);
  assert.equal(current.creatorClassification.legacy, false);
  assert.deepEqual(current.poiPreparation.creator, history.preparation.creator);
  assert.deepEqual(current.poiPreparation.ownEvidence.capsule, after.capsule);
  if (current.creatorClassification.type === 'Transact') {
    const creator = current.poiPreparation.creator,
      provenance = current.creatorProvenance;
    for (const key of ['type', 'tree', 'position', 'hash'])
      assert.equal(provenance.note[key], creator[key]);
    assert.deepEqual(provenance.publicIdentity, current.publicIdentity);
    assert.equal(provenance.txidPolicy, current.txidPolicy);
    assert.equal(provenance.checkpointHash, current.observations.source.checkpointHash);
    assert.deepEqual(provenance.origin, current.observations.source.creator.origin);
    const creating = assertRailgunPoiCreatorVerification({
      state: current.poiPreparation.state,
      note: provenance.note,
      noteWitness: provenance.noteWitness,
      verification: provenance.verification,
    });
    assert.ok(creating.witness.index < current.witness.index);
  } else assert.equal(current.creatorProvenance, undefined);
  assert.deepEqual(current.poiPreparation.ownEvidence.row, history.preparation.ownEvidence.row);
  for (const key of ['railgunTxid', 'leaf', 'index', 'rowSha256'])
    assert.deepEqual(current.witness[key], history.preparation.witness[key]);
  // Checkpoint/root/path may advance, but the original row and its leaf position
  // cannot move or disappear. The old root's acceptance is checked separately.
  assert.ok(current.witness.checkpointIndex >= history.expected.txidMerklerootIndex);
}
async function openRailgunOwnPoiChecks(options = {}) {
  let stage = 'context',
    scope,
    list,
    txid,
    timer,
    ownerDirectory,
    isClosed = false,
    drained = false,
    closing = false,
    success = false,
    resolveClosed;
  const owner = {},
    controller = new AbortController(),
    closed = new Promise((resolve) => (resolveClosed = resolve));
  const finishClose = () => {
    if (!isClosed || !drained || closing) return;
    closing = true;
    Promise.allSettled([list?.closed, txid?.closed]).then(() => {
      if (owners.get(ownerDirectory) === owner) owners.delete(ownerDirectory);
      resolveClosed();
    });
  };
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    clearTimeout(timer);
    controller.abort();
    list?.close();
    txid?.close();
    scope?.close();
    finishClose();
  };
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options).sort(),
      [
        'archive',
        'coordinator',
        'enrollment',
        'proof',
        'signal',
        ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []),
      ].sort()
    );
    const { enrollment, coordinator, proof, signal, timeoutMs = MAX_TOTAL_MS } = options;
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= MAX_TOTAL_MS);
    const archive = verifyRailgunEngineRuntime(options.archive);
    stage = 'proof-history';
    const history = assertRailgunOwnPoiProof(proof, enrollment, coordinator);
    assert.equal(history.archive, archive);
    assert.equal(history.txidTree, 0);
    const policy = getRailgunPublicPolicy(archive);
    const sourceDestination = getRailgunAccountPublicDestination(coordinator, enrollment, policy);
    const payload = bindRailgunOwnPoiPayload(history.payload, history.expected);
    const payloadSha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    assert.equal(payloadSha256, history.payloadSha256);
    const parent = enrollment.getContext('engine'),
      context = getPrivacyContext(parent),
      started = performance.now(),
      deadline = started + timeoutMs;
    let freshnessDeadline = deadline;
    ownerDirectory = enrollment.directory;
    assert.ok(!owners.has(ownerDirectory));
    owners.set(ownerDirectory, owner);
    scope = createPrivacyScope({
      profileId: context.profileId,
      signal: AbortSignal.any([signal, enrollment.signal, coordinator.signal, controller.signal]),
      isCurrent: () => {
        try {
          getPrivacyContext(parent);
          assertRailgunAccountPublicDestination(coordinator, enrollment, sourceDestination, policy);
          return true;
        } catch {
          return false;
        }
      },
    });
    scope.signal.addEventListener('abort', close, { once: true });
    const current = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < MAX_AGE_MS);
      assert.ok(!isClosed && !scope.signal.aborted && owners.get(ownerDirectory) === owner);
      const now = performance.now();
      assert.ok(now >= started && now + margin < freshnessDeadline);
      assert.equal(assertRailgunOwnPoiProof(proof, enrollment, coordinator), history);
      getPrivacyContext(parent);
      assertRailgunAccountPublicDestination(coordinator, enrollment, sourceDestination, policy);
    };
    const remaining = (max) => {
      current();
      const left = Math.min(max, Math.floor(freshnessDeadline - performance.now()));
      assert.ok(left > 0);
      return left;
    };
    timer = setTimeout(close, timeoutMs);
    timer.unref?.();
    stage = 'preflight';
    const fresh = await preflightRailgunRetainedPoiCompleted({
      enrollment,
      coordinator,
      archive,
      selector: history.capture.selector,
      sourceDestination,
      signal: scope.signal,
      timeoutMs: remaining(MAX_PREFLIGHT_MS),
    });
    if (fresh.status !== 'captured') {
      stage = 'preflight:' + fresh.stage;
      throw fail();
    }
    current(MARGIN_MS);
    // Preflight ends with a fresh private recapture and checks its source/root
    // receipts before returning. Its latency is not a renewable root receipt:
    // the next window starts once, remains capped by the original total budget,
    // and each root reader also enforces its own acquisition-based age.
    const preflightDurationMs = Math.ceil(performance.now() - started);
    freshnessDeadline = Math.min(deadline, performance.now() + MAX_AGE_MS);
    clearTimeout(timer);
    timer = setTimeout(close, Math.max(0, freshnessDeadline - performance.now()));
    timer.unref?.();
    stage = 'history-binding';
    compareHistory(fresh, history);
    const operation =
      'poi:' +
      createHash('sha256')
        .update(JSON.stringify(['freedom:railgun:own-poi-checks-v1', randomUUID(), payloadSha256]))
        .digest('hex');
    const handle = scope.getContext({ ...context.subject, role: 'poi', operation });
    stage = 'root-contexts';
    list = createRailgunPoiRootSource({ handle, root: payload.poiMerkleroots[0] });
    txid = createRailgunPoiTxidRootSource({
      handle,
      root: payload.txidMerkleroot,
      index: payload.txidMerklerootIndex,
    });
    stage = 'roots';
    let failure;
    const acquire = async (kind, source) => {
      try {
        return await source.acquire({ timeoutMs: remaining(45000) });
      } catch (error) {
        failure ??= { kind, rejected: error?.code === 'RAILGUN_POI_ROOT_REJECTED' };
        close();
        throw fail();
      }
    };
    // Observe every pending transport. A rejected sibling revokes both readers
    // immediately, but neither cleanup nor account ownership skips its drain.
    const acquired = await Promise.allSettled([acquire('list', list), acquire('txid', txid)]);
    if (failure) {
      stage = failure.kind + (failure.rejected ? '-root-rejected' : '-root-unavailable');
      throw fail();
    }
    current(MARGIN_MS);
    assert.ok(acquired.every((result) => result.status === 'fulfilled'));
    const [listResult, txidResult] = acquired.map((result) => result.value);
    const assertRoots = (margin) => {
      current(margin);
      assert.equal(list.assertResult(listResult.receipt, margin), listResult.observation);
      assert.equal(txid.assertResult(txidResult.receipt, margin), txidResult.observation);
    };
    assertRoots(MARGIN_MS);
    list.signal.addEventListener('abort', close, { once: true });
    txid.signal.addEventListener('abort', close, { once: true });
    stage = 'final-account';
    const recovered = await withRailgunOwnOperationRecovery(
      {
        enrollment,
        selector: history.capture.selector,
        signal: scope.signal,
        timeoutMs: remaining(15000),
      },
      async (window) => {
        window.assertCurrent(MARGIN_MS);
        assertRailgunOwnPoiCapture(window.capture, fresh.capture);
        assertRailgunOwnPoiCapture(await window.reattest(), fresh.capture);
        window.assertCurrent(MARGIN_MS);
        assertRoots(MARGIN_MS);
        return { checked: true };
      }
    );
    assertRoots(MARGIN_MS);
    if (recovered.status !== 'used') {
      stage = 'final-account:' + recovered.stage;
      throw fail();
    }
    assert.deepEqual(recovered.value, { checked: true });
    const observation = freeze({
      payload,
      payloadSha256,
      capture: fresh.capture,
      preflight: {
        durationMs: preflightDurationMs,
        publicIdentity: fresh.publicIdentity,
        finalRepresentation: fresh.observations.finalRepresentation,
        finalArchiveAnchor: fresh.observations.finalArchiveAnchor,
        archiveAnchorChecked: true,
      },
      listRoot: listResult.observation,
      txidRoot: txidResult.observation,
      observedAt: new Date().toISOString(),
      accountAuthenticated: false,
      sourceAuthenticated: false,
      currentFinalityVerified: false,
      membershipAuthenticated: false,
      rootAccepted: false,
      noteStatusChecked: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
    const receipt = Object.freeze({});
    receipts.set(receipt, {
      enrollment,
      coordinator,
      proof,
      assertCurrent(margin) {
        assertRoots(margin);
        return observation;
      },
    });
    success = true;
    return Object.freeze({
      status: 'checked',
      receipt,
      observation,
      close,
      closed,
      signal: scope.signal,
    });
  } catch {
    return Object.freeze({ status: 'refused', stage });
  } finally {
    drained = true;
    if (!success) close();
    finishClose();
    if (!success) await closed;
  }
}
function assertRailgunOwnPoiChecks(receipt, enrollment, coordinator, proof, margin = 0) {
  try {
    const entry = receipts.get(receipt);
    assert.ok(
      entry &&
        entry.enrollment === enrollment &&
        entry.coordinator === coordinator &&
        entry.proof === proof
    );
    return entry.assertCurrent(margin);
  } catch {
    throw fail();
  }
}
module.exports = { openRailgunOwnPoiChecks, assertRailgunOwnPoiChecks };
