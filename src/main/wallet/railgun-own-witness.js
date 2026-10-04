/** Recovery with keyless selector -> existing TXID checkpoint -> recovery.
 * Each phase drains before the next; detached data is compared across phases.
 * No writer exclusion, source/root acceptance or ongoing authority is returned.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunTxidPolicy } = require('./railgun-txid-policy');
const {
  getRailgunAccountPublicIdentity,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const {
  captureRailgunOwnOperation,
  captureRailgunOwnOperationSelector,
} = require('./railgun-own-operation');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const { observeRailgunOwnReceipt } = require('./railgun-own-receipt');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { captureRailgunOwnSource, assertRailgunOwnSource } = require('./railgun-own-source-capture');
const { verifyRailgunOwnTxid } = require('./railgun-own-txid-verifier');
const {
  captureRailgunPoiSource,
  captureRailgunPoiSourceCompleted,
  assertRailgunPoiSource,
} = require('./railgun-poi-source-capture');
const { POI_LAUNCH_BLOCK } = require('./railgun-owned-poi-records');
const { createRailgunTxidRootSource } = require('./railgun-txid-root');
const { claimRailgunAccountPhase } = require('./railgun-account-phase');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
async function captureRailgunOwnWitness(
  { enrollment, coordinator, archive, selector, signal, timeoutMs, sourceDestination } = {},
  preflight = false,
  poi = false,
  completed = false,
  submission
) {
  let stage = 'context',
    timer,
    txid,
    source,
    roots,
    sourceOutcome,
    rootScope,
    verificationPhase;
  const controller = new AbortController();
  try {
    if (submission) {
      assert.deepEqual(Object.keys(submission).sort(), ['capture', 'entry', 'observation']);
      const text = JSON.stringify(submission);
      assert.ok(Buffer.byteLength(text) <= 384 * 1024);
      submission = freeze(JSON.parse(text));
      assert.deepEqual(selector, submission.entry.selector);
      assert.equal(submission.capture.capsuleDigest, submission.entry.capsuleDigest);
      assert.equal(submission.capture.bindingDigest, submission.entry.bindingDigest);
    }
    if (timeoutMs === undefined) timeoutMs = preflight ? 300000 : 180000;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(
      Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= (preflight ? 300000 : 180000)
    );
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
      if (completed)
        assertRailgunAccountPublicDestination(
          coordinator,
          enrollment,
          sourceDestination,
          publicPolicy
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
      let chain, sourceObservation, verified, rootReceipt, rootObservation;
      if (submission) {
        assertRailgunOwnPoiCapture(first.capture, submission.capture);
        chain = submission.observation;
        assert.equal(chain.captureBindingDigest, first.capture.bindingDigest);
        assert.equal(chain.transaction.hash, first.capture.projection.hash);
        assert.equal(chain.receipt.transactionHash, first.capture.projection.hash);
      }
      const captureSource = completed
        ? captureRailgunPoiSourceCompleted
        : poi
          ? captureRailgunPoiSource
          : captureRailgunOwnSource;
      const assertSource = poi ? assertRailgunPoiSource : assertRailgunOwnSource;
      if (preflight && !submission) {
        stage = 'receipt';
        const observed = await observeRailgunOwnReceipt({
          enrollment,
          capture: first.capture,
          signal: lifetime,
          timeoutMs: remaining(60000),
        });
        current();
        if (observed.status !== 'observed') {
          stage = 'receipt:' + observed.stage;
          throw Error('receipt refused');
        }
        chain = observed.observation;
      }
      stage = 'txid';
      // Retain even a late-opened session and drain it in finally. Cancellation
      // never races away from storage/worker completion or releases its phase.
      txid = await openRailgunAccountTxid({
        enrollment,
        coordinator,
        archive,
        create: false,
        checkpointOnly: true,
        signal: lifetime,
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
      if (preflight) {
        stage = 'txid-verify';
        // A separate phase lease survives cancellation until this verifier
        // actually exits. The TXID session cannot drain an external utility.
        verificationPhase = claimRailgunAccountPhase(enrollment, 'recovery');
        verified = await verifyRailgunOwnTxid({
          handle: enrollment.getContext('engine', 'own-txid-proof'),
          archive,
          state,
          witness,
          evidence: {
            capsule: first.capture.capsule,
            record: first.capture.record,
            transaction: chain.transaction,
            receipt: chain.receipt,
            row: witness.row,
          },
          signal: lifetime,
          timeoutMs: remaining(30000),
        });
        current();
        verificationPhase.assertCurrent();
        verificationPhase.release();
        verificationPhase = undefined;
      }
      if (preflight) {
        stage = 'source';
        const capturedSource = await captureSource({
          enrollment,
          coordinator,
          record: first.capture.record,
          ...(poi ? { capsule: first.capture.capsule } : {}),
          transaction: chain.transaction,
          receipt: chain.receipt,
          signal: lifetime,
          timeoutMs: remaining(180000),
          ...(completed ? { destination: sourceDestination } : {}),
        });
        if (completed && capturedSource.status !== 'captured') {
          stage = 'source:' + capturedSource.stage;
          sourceOutcome = capturedSource.sourceOutcome;
          throw Error('source refused');
        }
        source = capturedSource;
        current();
        sourceObservation = assertSource(source.receipt, enrollment, coordinator);
        assert.deepEqual(
          (poi ? sourceObservation.own : sourceObservation).suppliedOutcome,
          first.capture.projection.railgun.transact
        );
        stage = 'root';
        rootScope = createPrivacyScope({
          profileId: getPrivacyContext(parent).profileId,
          signal: lifetime,
          isCurrent: () => {
            current();
            return true;
          },
        });
        roots = createRailgunTxidRootSource(
          rootScope.getContext({
            kind: 'service',
            principal: 'railgun-public-sync',
            protocol: 'railgun',
            deployment: 'sepolia',
            chainId: 11155111,
            role: 'public-services',
          })
        );
        rootReceipt = await roots.acquire({ index: state.count - 1, root: state.root });
        current();
        rootObservation = roots.assertRoot(rootReceipt, {
          index: state.count - 1,
          root: state.root,
        });
      }
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
      let observations;
      if (preflight) {
        stage = 'observations';
        assert.deepEqual(assertSource(source.receipt, enrollment, coordinator), sourceObservation);
        assert.deepEqual(
          roots.assertRoot(rootReceipt, { index: state.count - 1, root: state.root }),
          rootObservation
        );
        assert.equal(chain.captureBindingDigest, latest.capture.bindingDigest);
        const finalArchive = Object.hasOwn(latest.capture.record, 'archivedAt')
          ? {
              number: latest.capture.record.finalized.blockNumber,
              hash: latest.capture.record.finalized.blockHash,
            }
          : null;
        const archiveAnchorChecked =
          finalArchive === null ||
          chain.anchorsActuallyChecked.some(
            (anchor) =>
              anchor.kind === 'archive' &&
              anchor.number === finalArchive.number &&
              anchor.hash === finalArchive.hash
          );
        observations = {
          chain,
          source: sourceObservation,
          verification: verified,
          root: rootObservation,
          finalRepresentation: finalArchive ? 'archived' : 'active',
          finalArchiveAnchor: finalArchive,
          archiveAnchorChecked,
        };
        current();
      }
      return freeze({
        status: 'captured',
        ...(observations ? { observations } : {}),
        ...(poi
          ? {
              poiPreparation: {
                creator: sourceObservation.creator.creator,
                ownEvidence: {
                  capsule: latest.capture.capsule,
                  record: latest.capture.record,
                  transaction: chain.transaction,
                  receipt: chain.receipt,
                  row: witness.row,
                },
                state,
                witness,
              },
              creatorClassification: {
                type: sourceObservation.creator.creator.type,
                blockNumber: sourceObservation.creator.origin.blockNumber,
                legacy: sourceObservation.creator.origin.blockNumber < POI_LAUNCH_BLOCK,
              },
              disclosureEnabled: false,
            }
          : {}),
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
    return Object.freeze({ status: 'refused', stage, ...(sourceOutcome ? { sourceOutcome } : {}) });
  } finally {
    clearTimeout(timer);
    controller.abort();
    verificationPhase?.release();
    source?.close();
    roots?.close();
    rootScope?.close();
    if (txid) await txid.close();
  }
}
module.exports = {
  captureRailgunOwnWitness: (options) => captureRailgunOwnWitness(options),
  preflightRailgunOwnTransaction: (options) => captureRailgunOwnWitness(options, true),
  preflightRailgunOwnPoi: (options) => captureRailgunOwnWitness(options, true, true),
  preflightRailgunOwnPoiCompleted: (options) => captureRailgunOwnWitness(options, true, true, true),
  // Only output recovery's fixed submission branch supplies this private data.
  preflightRailgunOwnPoiForSubmission: (options, input) =>
    captureRailgunOwnWitness(options, true, true, true, input || {}),
};
