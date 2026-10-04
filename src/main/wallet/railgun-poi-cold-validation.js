/** Completed-attempt retained POI diagnostic. No additional proof-specific root
 * queries, sender, receipt, registry restoration or current note eligibility.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const path = require('path');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const {
  getRailgunAccountPublicIdentity,
  getRailgunAccountPublicDestination,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const {
  recoverRailgunPoiOutput,
  recoverRailgunPoiOutputCompleted,
} = require('./railgun-poi-output-recovery');
const { verifyRailgunPoiPayload } = require('./railgun-poi-verifier');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const {
  withRailgunOwnOperationRecovery,
  captureRailgunOwnOperationSelector,
} = require('./railgun-own-operation');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const owners = new Map();
const TOTAL_MS = 300000,
  HISTORY_MS = 540000,
  SELECTOR_MS = 45000,
  MIRROR_MS = 180000,
  OUTPUT_MS = 240000,
  VERIFY_MS = 35000,
  FINAL_MS = 15000;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = (value) => freeze(JSON.parse(JSON.stringify(value)));
async function validate(options, history) {
  const maximum = history ? HISTORY_MS : TOTAL_MS;
  const historyReserve = history ? SELECTOR_MS + MIRROR_MS : 0;
  let stage = 'context',
    store,
    timer,
    directory,
    phase,
    txid,
    txidClosing,
    mirrorTimer,
    sourceOutcome,
    lifetime;
  const owner = {},
    controller = new AbortController();
  // Observe close immediately, but keep its exact promise for the drain. An
  // abort during open cannot close a handle which has not returned yet.
  const closeTxid = () => {
    if (txid && !txidClosing) {
      try {
        txidClosing = Promise.resolve(txid.close());
      } catch (error) {
        txidClosing = Promise.reject(error);
      }
      txidClosing.catch(() => {});
    }
    return txidClosing;
  };
  const stop = () => controller.abort();
  const stopMirror = () => {
    closeTxid();
  };
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
      timeoutMs = maximum,
    } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= maximum);
    assert.match(capsuleDigest, /^[0-9a-f]{64}$/);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const proverArchive = verifyRailgunProverRuntime(options.proverArchive);
    assert.ok(typeof artifactDirectory === 'string' && path.isAbsolute(artifactDirectory));
    assert.ok(Buffer.byteLength(artifactDirectory) <= 4096);
    const handle = enrollment.getContext('engine');
    const descriptorValue = assertRailgunIdentity(identity, handle);
    const descriptor = history ? snapshot(descriptorValue) : descriptorValue;
    assert.deepEqual(descriptor, enrollment.descriptor);
    const policy = getRailgunPublicPolicy(archive);
    const publicValue = getRailgunAccountPublicIdentity(coordinator, enrollment, policy);
    const publicIdentity = history ? snapshot(publicValue) : publicValue;
    const sourceDestination = history
      ? getRailgunAccountPublicDestination(coordinator, enrollment, policy)
      : undefined;
    // Load only for the fixed history export; Stage A keeps its old dependency
    // and phase behavior. Policy changes select another mirror, never a rebuild.
    const getTxidPolicy = history
      ? require('./railgun-txid-policy').getRailgunTxidPolicy
      : undefined;
    const txidPolicy = getTxidPolicy?.(archive);
    directory = enrollment.directory;
    assert.ok(!owners.has(directory));
    owners.set(directory, owner);
    const started = performance.now(),
      deadline = started + timeoutMs;
    lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const current = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0 && margin < maximum);
      assert.ok(
        !lifetime.aborted &&
          !store?.signal.aborted &&
          performance.now() >= started &&
          performance.now() + margin < deadline
      );
      assert.equal(owners.get(directory), owner);
      if (history) assert.equal(getTxidPolicy(archive), txidPolicy);
      assert.deepEqual(assertRailgunIdentity(identity, handle), descriptor);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, policy),
        publicIdentity
      );
      if (history)
        assertRailgunAccountPublicDestination(coordinator, enrollment, sourceDestination, policy);
    };
    const remaining = (limit, reserve = 0) => {
      current(reserve);
      const left = Math.min(limit, Math.floor(deadline - performance.now()) - reserve);
      assert.ok(left > 0);
      return left;
    };
    if (history) lifetime.addEventListener('abort', stopMirror, { once: true });
    timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    stage = 'stored';
    store = await enrollment.openPoiIntents({ existingOnly: true });
    current();
    store.signal.addEventListener('abort', stop, { once: true });
    const loaded = await store.get(capsuleDigest);
    current();
    const entry = history ? snapshot(loaded) : loaded;
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
    const recoverOutput = history ? recoverRailgunPoiOutputCompleted : recoverRailgunPoiOutput;
    const output = await recoverOutput({
      identity,
      enrollment,
      coordinator,
      archive,
      capsuleDigest,
      signal: lifetime,
      timeoutMs: remaining(OUTPUT_MS, VERIFY_MS + historyReserve + FINAL_MS),
      ...(history ? { sourceDestination } : {}),
    });
    if (history && output.status !== 'matched') {
      stage = 'output:' + output.stage;
      sourceOutcome = output.sourceOutcome;
      throw Error('refused');
    }
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
        timeoutMs: remaining(VERIFY_MS, historyReserve + FINAL_MS),
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
    const bind = (capture) => {
      assert.equal(capture.capsuleDigest, capsuleDigest);
      assert.equal(capture.bindingDigest, entry.bindingDigest);
      assert.deepEqual(capture.selector, entry.selector);
    };
    let first;
    if (history) {
      stage = 'selector';
      const captured = await captureRailgunOwnOperationSelector({
        enrollment,
        archive,
        selector: entry.selector,
        signal: lifetime,
        timeoutMs: remaining(SELECTOR_MS, MIRROR_MS + FINAL_MS),
      });
      current();
      if (captured.status !== 'captured') {
        stage = 'selector:' + captured.stage;
        throw Error('refused');
      }
      first = snapshot(captured);
      bind(first.capture);
      const derived = first.derived;
      assert.equal(derived.selectorDerived, true);
      assert.equal(derived.utilityExitObserved, true);
      for (const name of [
        'accountAuthenticated',
        'pathVerified',
        'sourceAuthenticated',
        'rootAccepted',
        'currentCanonicalityVerified',
        'finalityVerified',
        'rowMetadataAuthenticated',
        'poiVerified',
        'globalTxidCompleteness',
        'spendingEnabled',
      ])
        assert.equal(derived[name], false);
      for (const name of ['inputSha256', 'bindingDigest', 'railgunTxid'])
        assert.match(derived[name], /^[0-9a-f]{64}$/);
      const { extractRailgunTransactIntent } = require('./railgun-transact-intent');
      const { transaction } = extractRailgunTransactIntent(first.capture.provedTransaction);
      assert.equal(
        derived.bindingDigest,
        sha('freedom:railgun:own-selector-v1\0' + JSON.stringify(transaction))
      );
      if (payload.railgunTxidIfHasUnshield !== '0x00')
        assert.equal(payload.railgunTxidIfHasUnshield, '0x' + derived.railgunTxid);
      await readCurrent();

      stage = 'txid';
      const mirrorStarted = performance.now();
      const mirrorBudget = remaining(MIRROR_MS, FINAL_MS);
      const mirrorDeadline = mirrorStarted + mirrorBudget;
      const mirrorController = new AbortController();
      const mirrorSignal = AbortSignal.any([lifetime, mirrorController.signal]);
      let mirrorExpired = false;
      const mirrorCurrent = () => {
        current(FINAL_MS);
        assert.ok(!mirrorSignal.aborted && !mirrorExpired && performance.now() < mirrorDeadline);
        assert.ok(!txid?.signal.aborted);
      };
      mirrorTimer = setTimeout(() => {
        mirrorExpired = true;
        mirrorController.abort();
        closeTxid();
      }, mirrorBudget);
      mirrorTimer.unref?.();
      try {
        const { openRailgunAccountTxid } = require('./railgun-account-txid');
        mirrorCurrent();
        // The signal revokes pending startup. Still retain any late handle
        // before checking cancellation, then close/drain before releasing ownership.
        txid = await openRailgunAccountTxid({
          enrollment,
          coordinator,
          archive,
          create: false,
          checkpointOnly: true,
          signal: mirrorSignal,
        });
        mirrorCurrent();
        assert.equal(txid.policy, txidPolicy);
        assert.deepEqual(txid.publicIdentity, publicIdentity);
        stage = 'txid-checkpoint';
        mirrorCurrent();
        const inspected = await txid.inspect();
        mirrorCurrent();
        assert.ok(inspected.checkpoint && inspected.pending === null);
        // inspect() freezes only its outer object. Detach the ENTIRE checkpoint
        // before another await; otherwise mutation could move both baselines.
        const checkpoint = snapshot(inspected.checkpoint);
        const state = checkpoint.state;
        assert.ok(Number.isSafeInteger(state.count) && state.count > 0 && state.count <= 8000);
        const index = payload.txidMerklerootIndex;
        assert.ok(index < state.count);
        stage = 'txid-witness';
        mirrorCurrent();
        const found = await txid.witness(derived.railgunTxid);
        mirrorCurrent();
        for (const name of [
          'ownershipVerified',
          'eventCoverageVerified',
          'rootAccepted',
          'spendingEnabled',
        ])
          assert.equal(found[name], false);
        const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
        const witness = normalizeRailgunTxidWitness(found.witness, state, derived.railgunTxid);
        assert.ok(witness.index <= index);
        stage = 'txid-history';
        mirrorCurrent();
        const prefix = await txid.historicalRoot(index);
        mirrorCurrent();
        // Account API already normalizes this exact diagnostic; independently
        // bind every field to this attempt's retained payload/checkpoint.
        assert.deepEqual(prefix, {
          version: 1,
          tree: 0,
          index,
          root: payload.txidMerkleroot,
          checkpointIndex: state.count - 1,
          checkpointRoot: state.root,
          transcript: state.transcript,
          localPrefixComputed: true,
          globalTxidCompleteness: false,
          ownershipVerified: false,
          eventCoverageVerified: false,
          rootAccepted: false,
          spendingEnabled: false,
        });
        stage = 'txid-checkpoint';
        mirrorCurrent();
        const after = await txid.inspect();
        mirrorCurrent();
        assert.equal(after.pending, null);
        assert.deepEqual(after.checkpoint, checkpoint);
        assert.equal(txid.policy, txidPolicy);
        assert.deepEqual(txid.publicIdentity, publicIdentity);
        stage = 'txid-close';
        mirrorCurrent();
      } finally {
        // Timer/listener remain armed throughout ignored work and close drain.
        try {
          await closeTxid();
        } finally {
          clearTimeout(mirrorTimer);
          mirrorController.abort();
        }
      }
      current(FINAL_MS);
      assert.ok(!mirrorExpired && performance.now() < mirrorDeadline);
      await readCurrent();
    }
    stage = 'final-account';
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
        if (history) {
          // Interstage archival/confirmation refresh is allowed when the stable
          // own-operation join is unchanged. The stricter anchor check below
          // applies only to the two explicit captures in this final window.
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
            assert.deepEqual(window.capture[key], first.capture[key]);
        }
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
      ...(history
        ? {
            historicalRootMatchesLocalMirror: true,
            ownTxidIncludedBySavedIndex: true,
            localMirrorCheckpointMatched: true,
            globalTxidCompleteness: false,
          }
        : {}),
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
    return Object.freeze({ status: 'refused', stage, ...(sourceOutcome ? { sourceOutcome } : {}) });
  } finally {
    clearTimeout(timer);
    controller.abort();
    // Includes late-open cleanup on every refusal. A pending close retains the
    // directory owner; never race it against cancellation or the admission timer.
    if (history) await closeTxid()?.catch(() => {});
    clearTimeout(mirrorTimer);
    lifetime?.removeEventListener('abort', stopMirror);
    phase?.release();
    store?.signal.removeEventListener('abort', stop);
    if (owners.get(directory) === owner) owners.delete(directory);
  }
}
module.exports = {
  validateRailgunRetainedPoi: (options = {}) => validate(options, false),
  validateRailgunRetainedPoiHistory: (options = {}) => validate(options, true),
};
