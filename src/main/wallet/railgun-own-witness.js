/** Recovery with keyless selector -> existing TXID checkpoint -> recovery.
 * Each phase drains before the next; detached data is compared across phases.
 * No writer exclusion, source/root acceptance or ongoing authority is returned.
 */
const assert = require('assert/strict');
const { getRailgunOwnPoiShape } = require('./railgun-own-poi-shape-data');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const {
  isRailgunAccountEnrollment,
  quarantineRailgunAccountEnrollmentCredentials,
} = require('./railgun-account-enrollment');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
const { getRailgunPublicPolicy } = require('./railgun-public-policy');
const { getRailgunTxidPolicy } = require('./railgun-txid-policy');
const {
  getRailgunAccountPublicIdentity,
  getRailgunAccountPublicDestination,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const {
  captureRailgunOwnOperation,
  captureRailgunOwnOperationSelector,
} = require('./railgun-own-operation');
const { openRailgunAccountTxid } = require('./railgun-account-txid');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const {
  assertRailgunPoiCreatorEvents,
  normalizeRailgunPoiCreatorWitness,
  assertRailgunPoiCreatorVerification,
} = require('./railgun-poi-creator-data');
const { verifyRailgunNoteProvenance } = require('./railgun-note-provenance');
const { observeRailgunOwnReceipt } = require('./railgun-own-receipt');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { captureRailgunOwnSource, assertRailgunOwnSource } = require('./railgun-own-source-capture');
const { verifyRailgunOwnTxid } = require('./railgun-own-txid-verifier');
const {
  captureRailgunPoiSource,
  captureRailgunPoiSourceCompleted,
  captureRailgunPoiSourceForTransactMembership,
  captureRailgunPoiSourceForRetainedInput,
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
  submission,
  transactMembership = false,
  retainedInput = false
) {
  const sourceFirst = transactMembership || retainedInput;
  let creatorRequired = transactMembership,
    creatorHasUnshield;
  let stage = 'context',
    timer,
    tailTimer,
    tailDeadline = Infinity,
    stageDeadline = Infinity,
    txid,
    source,
    roots,
    sourceOutcome,
    rootScope,
    verificationPhase,
    verificationExitUnknown = false;
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
    if (transactMembership)
      sourceDestination = getRailgunAccountPublicDestination(coordinator, enrollment, publicPolicy);
    const lifetime = AbortSignal.any([
      signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const current = () => {
      getPrivacyContext(parent);
      assert.ok(
        !lifetime.aborted &&
          performance.now() >= started &&
          performance.now() < Math.min(deadline, tailDeadline, stageDeadline)
      );
      // The real canonical timestamp, not time since snapshot return, decides
      // whether the retained source remains current throughout the tail.
      if (sourceFirst && source) assertRailgunPoiSource(source.receipt, enrollment, coordinator);
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
    const tailStage = async (cap, reserve, use) => {
      current();
      const budget = Math.min(
        cap,
        Math.floor(Math.min(deadline, tailDeadline) - performance.now()) - reserve
      );
      assert.ok(budget > 0);
      stageDeadline = performance.now() + budget;
      const stageTimer = setTimeout(() => controller.abort(), budget);
      stageTimer.unref?.();
      try {
        const value = await use(budget);
        current();
        return value;
      } finally {
        clearTimeout(stageTimer);
        stageDeadline = Infinity;
      }
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
      // Shape comes from the genuine capture, not a caller mode or payload.
      // Capsule normalization also binds private V = U + C for partial spends.
      const ownShape = getRailgunOwnPoiShape(first.capture.capsule);
      const derived = first.derived;
      let chain,
        sourceObservation,
        verified,
        rootReceipt,
        rootObservation,
        creatorNoteWitness,
        creatorVerification;
      if (submission) {
        assertRailgunOwnPoiCapture(first.capture, submission.capture);
        chain = submission.observation;
        assert.equal(chain.captureBindingDigest, first.capture.bindingDigest);
        assert.equal(chain.transaction.hash, first.capture.projection.hash);
        assert.equal(chain.receipt.transactionHash, first.capture.projection.hash);
      }
      const captureSource = retainedInput
        ? captureRailgunPoiSourceForRetainedInput
        : transactMembership
          ? captureRailgunPoiSourceForTransactMembership
          : completed
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
      const readSource = async () => {
        stage = 'source';
        let sourceBudget = remaining(180000);
        if (sourceFirst) {
          sourceBudget = Math.min(180000, Math.floor(deadline - performance.now()) - 55000);
          assert.ok(sourceBudget > 0);
          sourceBudget += 55000; // Scope includes the tail; snapshot reserves it.
        }
        const capturedSource = await captureSource({
          enrollment,
          coordinator,
          record: first.capture.record,
          ...(poi ? { capsule: first.capture.capsule } : {}),
          transaction: chain.transaction,
          receipt: chain.receipt,
          signal: lifetime,
          timeoutMs: sourceBudget,
          ...(completed ? { destination: sourceDestination } : {}),
        });
        if (completed && capturedSource.status !== 'captured') {
          stage = 'source:' + capturedSource.stage;
          sourceOutcome = capturedSource.sourceOutcome;
          throw Error('source refused');
        }
        source = capturedSource;
        if (sourceFirst) {
          tailDeadline = Math.min(deadline, performance.now() + 55000);
          tailTimer = setTimeout(
            () => controller.abort(),
            Math.max(1, Math.floor(tailDeadline - performance.now()))
          );
          tailTimer.unref?.();
        }
        current();
        sourceObservation = assertSource(source.receipt, enrollment, coordinator);
        assert.deepEqual(
          (poi ? sourceObservation.own : sourceObservation).suppliedOutcome,
          first.capture.projection.railgun.transact
        );
      };
      if (sourceFirst) {
        await readSource();
        stage = 'creator-source';
        const captured = sourceObservation.creator;
        if (retainedInput) {
          assert.ok(['Shield', 'Transact'].includes(captured.creator.type));
          // Classify only after the genuine snapshot and full source suffix
          // authentication; retained records do not carry a creator type.
          creatorRequired = captured.creator.type === 'Transact';
        } else assert.equal(captured.creator.type, 'Transact');
        assert.ok(captured.origin.blockNumber >= POI_LAUNCH_BLOCK);
        if (creatorRequired) {
          assert.deepEqual(captured.transaction.note, {
            type: 'Transact',
            txid: captured.origin.transactionHash,
            hash: first.capture.capsule.noteHash,
            tree: first.capture.capsule.selection.tree,
            position: first.capture.capsule.selection.position,
            blockNumber: captured.origin.blockNumber,
          });
          creatorHasUnshield = assertRailgunPoiCreatorEvents({
            note: captured.transaction.note,
            events: captured.transaction.events,
          }).hasUnshield;
        }
        current();
      }
      const readMirror = async () => {
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
        const inspected = await txid.inspect();
        const before = sourceFirst ? freeze(JSON.parse(JSON.stringify(inspected))) : inspected;
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
        if (creatorRequired) {
          stage = 'creator-txid-witness';
          const captured = sourceObservation.creator;
          const foundCreator = await txid.witnessNote(captured.transaction.note);
          current();
          const creating = normalizeRailgunPoiCreatorWitness({
            state,
            note: captured.transaction.note,
            noteWitness: foundCreator.noteWitness,
          });
          assert.equal(creating.hasUnshield, creatorHasUnshield);
          creatorNoteWitness = creating.noteWitness;
          const creatorWitness = creatorNoteWitness.witness;
          const creatorRow = creatorWitness.row;
          assert.equal(creatorRow.commitments[0], captured.creator.hash);
          assert.equal(creatorRow.utxoTreeOut, captured.creator.tree);
          assert.equal(creatorRow.utxoBatchStartPositionOut, captured.creator.position);
          assert.equal(creatorRow.blockNumber, captured.origin.blockNumber);
          assert.equal('0x' + creatorRow.txid, captured.origin.transactionHash);
          assert.match(creatorRow.graphID, /^0x[0-9a-f]{192}$/);
          assert.equal(
            BigInt('0x' + creatorRow.graphID.slice(66, 130)),
            BigInt(captured.origin.transactionIndex)
          );
          assert.ok(creatorWitness.index < witness.index);
        }
        const after = await txid.inspect();
        current();
        assert.equal(after.pending, null);
        assert.deepEqual(after.checkpoint, before.checkpoint);
        stage = 'txid-close';
        await txid.close();
        txid = undefined;
        current();
        return { state, witness };
      };
      const { state, witness } = sourceFirst
        ? await tailStage(20000, 14000, readMirror)
        : await readMirror();
      if (preflight) {
        const verifyOwn = async (budget) => {
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
            timeoutMs: budget,
          });
          current();
          verificationPhase.assertCurrent();
          verificationPhase.release();
          verificationPhase = undefined;
        };
        if (sourceFirst) await tailStage(10000, 13000, verifyOwn);
        else await verifyOwn(remaining(30000));
      }
      if (creatorRequired) {
        stage = 'creator-verify';
        await tailStage(10000, 12000, async (budget) => {
          verificationPhase = claimRailgunAccountPhase(enrollment, 'recovery');
          creatorVerification = await verifyRailgunNoteProvenance({
            handle: enrollment.getContext('engine', 'note-provenance'),
            archive,
            state,
            note: sourceObservation.creator.transaction.note,
            noteWitness: creatorNoteWitness,
            events: sourceObservation.creator.transaction.events,
            signal: lifetime,
            timeoutMs: budget,
          });
          current();
          verificationPhase.assertCurrent();
          assert.deepEqual(
            assertRailgunPoiCreatorVerification({
              state,
              note: sourceObservation.creator.transaction.note,
              noteWitness: creatorNoteWitness,
              verification: creatorVerification,
            }),
            creatorNoteWitness
          );
          assert.equal(creatorVerification.coverage.boundParamsChecked, false);
          assert.equal(creatorVerification.coverage.globalTxidCompleteness, false);
          verificationPhase.release();
          verificationPhase = undefined;
        });
      }
      if (preflight) {
        if (!sourceFirst) await readSource();
        const acquireRoot = async () => {
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
        };
        if (sourceFirst) await tailStage(10000, 7000, acquireRoot);
        else await acquireRoot();
      }
      stage = 'recapture';
      const recapture = (budget) =>
        captureRailgunOwnOperation({
          enrollment,
          selector: selected,
          signal: lifetime,
          timeoutMs: budget,
        });
      const latest = sourceFirst
        ? await tailStage(10000, 2000, recapture)
        : await recapture(remaining(45000));
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
      if (sourceFirst) assertRailgunOwnPoiCapture(latest.capture, first.capture);
      stage = 'row';
      const { row } = witness,
        { projection, intent } = latest.capture;
      assert.equal(row.txid, projection.hash.slice(2));
      assert.equal(row.blockNumber, projection.blockNumber);
      assert.equal(row.utxoTreeIn, intent.tree);
      assert.deepEqual(row.nullifiers, [intent.nullifier]);
      const partial = ownShape.kind === 'railgun-partial-unshield';
      assert.equal(intent.operation, ownShape.kind);
      assert.deepEqual(
        row.commitments,
        partial ? [intent.changeCommitment, intent.unshieldCommitment] : [intent.commitment]
      );
      assert.equal(row.boundParamsHash, intent.boundParamsHash);
      if (ownShape.hasPrivateOutput) {
        const output = projection.railgun.transact.output;
        const change = partial ? output.change : output;
        assert.equal(row.utxoTreeOut, change.tree);
        assert.equal(row.utxoBatchStartPositionOut, change.position);
      } else {
        assert.equal(row.utxoTreeOut, 99999);
        assert.equal(row.utxoBatchStartPositionOut, 99999);
      }
      if (ownShape.hasUnshield) {
        assert.deepEqual(row.unshield, {
          toAddress: intent.recipient,
          value: partial ? intent.unshieldAmount : intent.amount,
          tokenData: {
            tokenType: 0,
            tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
            tokenSubID: '0x' + '0'.repeat(64),
          },
        });
      } else assert.equal(row.unshield, undefined);
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
        if (sourceFirst) assert.equal(archiveAnchorChecked, true);
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
        ...(creatorRequired
          ? {
              creatorProvenance: {
                note: sourceObservation.creator.transaction.note,
                noteWitness: creatorNoteWitness,
                verification: creatorVerification,
                origin: sourceObservation.creator.origin,
                logsSha256: sourceObservation.creator.transaction.logsSha256,
                checkpointHash: sourceObservation.checkpointHash,
                txidPolicy,
                publicIdentity,
                boundParamsChecked: false,
                globalTxidCompleteness: false,
                disclosureEnabled: false,
                spendingEnabled: false,
              },
            }
          : {}),
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
  } catch (error) {
    if (error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED') {
      verificationExitUnknown = true;
      try {
        quarantineRailgunAccountEnrollmentCredentials(enrollment);
      } catch {
        // Credential cleanup cannot turn an unknown original exit into release.
      }
      throw error;
    }
    return Object.freeze({ status: 'refused', stage, ...(sourceOutcome ? { sourceOutcome } : {}) });
  } finally {
    clearTimeout(timer);
    clearTimeout(tailTimer);
    let cleanupError;
    for (const close of [
      () => controller.abort(),
      () => source?.close(),
      () => roots?.close(),
      () => rootScope?.close(),
    ]) {
      try {
        close();
      } catch (error) {
        cleanupError ||= error;
      }
    }
    try {
      if (txid) await txid.close();
    } catch (error) {
      cleanupError ||= error;
    }
    if (!verificationExitUnknown) verificationPhase?.release();
    assert.ok(verificationExitUnknown || !cleanupError, cleanupError);
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

// Fixed internal consumer path for future Transact input membership. No source
// destination or observed data is accepted from its caller; legacy exports never
// enable the creator branch.
module.exports.preflightRailgunOwnTransactPoiMembership = async (options) => {
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options)
        .filter((key) => key !== 'timeoutMs')
        .sort(),
      ['archive', 'coordinator', 'enrollment', 'selector', 'signal']
    );
    return await captureRailgunOwnWitness(options, true, true, true, undefined, true);
  } catch (error) {
    if (error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED') throw error;
    return Object.freeze({ status: 'refused', stage: 'context' });
  }
};

// Sole internal consumer: the Transact selector host. Direct completed data,
// never an adoptable diagnostic or a live source/root/consent receipt.
module.exports.captureRailgunOwnTransactPoiMembershipInput = async (options) => {
  let stage = 'context';
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options)
        .filter((key) => key !== 'timeoutMs')
        .sort(),
      ['archive', 'coordinator', 'enrollment', 'selector', 'signal']
    );
    const { enrollment, coordinator, signal, timeoutMs = 300000 } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const publicPolicy = getRailgunPublicPolicy(archive);
    const txidPolicy = getRailgunTxidPolicy(archive);
    const identity = freeze(
      JSON.parse(
        JSON.stringify(getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy))
      )
    );
    const destination = getRailgunAccountPublicDestination(coordinator, enrollment, publicPolicy);
    const parent = enrollment.getContext('engine');
    const started = performance.now(),
      deadline = started + timeoutMs;
    const current = () => {
      getPrivacyContext(parent);
      assert.ok(!signal.aborted && !enrollment.signal.aborted && !coordinator.signal.aborted);
      assert.ok(performance.now() >= started && performance.now() < deadline);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
        identity
      );
      assertRailgunAccountPublicDestination(coordinator, enrollment, destination, publicPolicy);
    };
    current();
    stage = 'preflight';
    const result = await captureRailgunOwnWitness(
      { enrollment, coordinator, archive, selector: options.selector, signal, timeoutMs },
      true,
      true,
      true,
      undefined,
      true
    );
    // Preserve genuine bounded source failure before a later local-currency check.
    if (result.status !== 'captured') return result;
    stage = 'completion';
    // The core's cleanup has settled. Its own scope is intentionally closed;
    // use the outer owners/deadline, not a renewed canonical-source claim.
    current();
    assert.equal(result.publicPolicy, publicPolicy);
    assert.equal(result.txidPolicy, txidPolicy);
    assert.deepEqual(result.publicIdentity, identity);
    assert.deepEqual(result.creatorProvenance.publicIdentity, identity);
    assert.equal(result.creatorProvenance.txidPolicy, txidPolicy);
    assert.equal(result.observations.archiveAnchorChecked, true);
    return freeze(result);
  } catch (error) {
    if (error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED') throw error;
    return Object.freeze({ status: 'refused', stage });
  }
};

// Fixed retained preflight. Its caller supplies an already pinned genuine
// destination, never a creator type, and owns any disclosure authorization.
// These wrappers return completed private data, not a reusable authority token.
async function preflightRetained(options, input, submissionMode = false) {
  let stage = 'context';
  try {
    assert.ok(options && typeof options === 'object' && !Array.isArray(options));
    assert.deepEqual(
      Object.keys(options).sort(),
      [
        'enrollment',
        'coordinator',
        'archive',
        'selector',
        'sourceDestination',
        'signal',
        ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : []),
      ].sort()
    );
    const {
      enrollment,
      coordinator,
      selector,
      sourceDestination,
      signal,
      timeoutMs = 180000,
    } = options;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 180000);
    const archive = verifyRailgunEngineRuntime(options.archive);
    const publicPolicy = getRailgunPublicPolicy(archive);
    const txidPolicy = getRailgunTxidPolicy(archive);
    const identity = freeze(
      JSON.parse(
        JSON.stringify(getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy))
      )
    );
    const parent = enrollment.getContext('engine');
    const started = performance.now(),
      deadline = started + timeoutMs;
    const current = () => {
      getPrivacyContext(parent);
      assert.ok(!signal.aborted && !enrollment.signal.aborted && !coordinator.signal.aborted);
      assert.ok(performance.now() >= started && performance.now() < deadline);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
        identity
      );
      assertRailgunAccountPublicDestination(
        coordinator,
        enrollment,
        sourceDestination,
        publicPolicy
      );
    };
    current();
    stage = 'preflight';
    const budget = Math.floor(deadline - performance.now());
    assert.ok(budget > 0);
    const result = await captureRailgunOwnWitness(
      { enrollment, coordinator, archive, selector, signal, timeoutMs: budget, sourceDestination },
      true,
      true,
      true,
      submissionMode ? input || {} : undefined,
      false,
      true
    );
    // Do not erase genuine source failure provenance with a later currency check.
    if (result.status !== 'captured') return result;
    stage = 'completion';
    // The private core has closed its scopes and drained admitted work. This is
    // an owner/deadline check, not a renewal of source or service-root freshness.
    current();
    assert.equal(result.publicPolicy, publicPolicy);
    assert.equal(result.txidPolicy, txidPolicy);
    assert.deepEqual(result.publicIdentity, identity);
    assert.equal(result.observations.archiveAnchorChecked, true);
    assert.ok(['Shield', 'Transact'].includes(result.creatorClassification.type));
    assert.equal(result.creatorClassification.legacy, false);
    if (result.creatorClassification.type === 'Transact') {
      assert.deepEqual(result.creatorProvenance.publicIdentity, identity);
      assert.equal(result.creatorProvenance.txidPolicy, txidPolicy);
    } else assert.equal(result.creatorProvenance, undefined);
    return freeze(result);
  } catch (error) {
    if (error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED') throw error;
    return Object.freeze({ status: 'refused', stage });
  }
}
module.exports.preflightRailgunRetainedPoiCompleted = (options) => preflightRetained(options);
// Future sole consumer: output recovery's fixed submission branch, downstream
// of the validator's genuine prepared-reader consumption. No observed-result
// options field or fallback to a new receipt query is introduced.
module.exports.preflightRailgunRetainedPoiForSubmission = (options, input) =>
  preflightRetained(options, input, true);
