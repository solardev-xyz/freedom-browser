/** Main-only authority around a reviewed guarded utility runner. runJob must
 * return only after router drain and observed process exit; no child-provided
 * boolean or deserialized receipt can grant scan completion.
 */
const assert = require('assert/strict');
const { normalizeRailgunWalletRead } = require('./railgun-wallet-read');
const { normalizeRailgunOwnedPoiRecords } = require('./railgun-owned-poi-records');
const { isRailgunWalletJournal } = require('./railgun-wallet-journal');
const instances = new WeakSet();
const {
  kinds,
  checkpointHash,
  normalizeRailgunWalletCoverage,
  summarizeRailgunWalletCoverage,
} = require('./railgun-wallet-coverage');
function createRailgunWalletRunner({ runJob, inventory, policy, identity, enrollment }) {
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
  async function run(
    { snapshot, walletSession, coverageStore, walletId, restore, ...options },
    readOnly = false,
    recoveryMode = false,
    relayMode
  ) {
    const relayData = relayMode === undefined ? undefined : require('./railgun-relay-wallet-data');
    let relayRequest, relayDraft, relayProof, relayPrePoi;
    assert.equal(options.relayEnrollment, undefined);
    if (relayMode !== undefined) {
      assert.ok(readOnly && restore && !recoveryMode);
      for (const name of ['privateIntent', 'privateOperation', 'privateRecovery'])
        assert.equal(options[name], undefined);
      relayData.assertRailgunRelaySignal(options.relaySignal);
      if (relayMode === 'pre-poi') {
        require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
        const owner = require('./railgun-identity').assertRailgunIdentity(
          identity,
          enrollment.getContext('engine')
        );
        assert.equal(owner.walletId, walletId);
        for (const name of ['relayRequest', 'relayDraftText', 'relayProof'])
          assert.equal(options[name], undefined);
        relayPrePoi = relayData.normalizeRailgunRelayPrePoiInput(options.relayPrePoi, walletId);
        relayDraft = relayData.parseRailgunRelayDraft(relayPrePoi.draftText, walletId);
        options.relayPrePoi = relayPrePoi;
        options.relayEnrollment = enrollment;
      } else if (relayMode === 'prove-local') {
        require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
        const owner = require('./railgun-identity').assertRailgunIdentity(
          identity,
          enrollment.getContext('engine')
        );
        assert.equal(owner.walletId, walletId);
        assert.equal(options.relayRequest, undefined);
        assert.equal(options.relayDraftText, undefined);
        relayProof = require('./railgun-relay-proof-results').normalizeRailgunRelayProofInput(
          options.relayProof,
          walletId
        );
        assert.equal(
          require('./railgun-relay-recovery-data').decodeRailgunRelayLocalRecord(
            relayProof.recordText
          ).binding,
          enrollment.binding
        );
        options.relayProof = relayProof;
        options.relayEnrollment = enrollment;
      } else if (relayMode === 'construct') {
        assert.equal(options.relayDraftText, undefined);
        relayRequest = relayData.normalizeRailgunRelayRequest(options.relayRequest, walletId);
        options.relayRequest = relayRequest;
      } else {
        assert.equal(relayMode, 'reconstruct');
        assert.equal(options.relayRequest, undefined);
        relayDraft = relayData.parseRailgunRelayDraft(options.relayDraftText, walletId);
      }
    } else {
      for (const name of [
        'relayRequest',
        'relayDraftText',
        'relaySignal',
        'relayProof',
        'relayPrePoi',
      ])
        assert.equal(options[name], undefined);
    }
    if (relayMode !== 'prove-local') assert.equal(options.relayProof, undefined);
    if (relayMode !== 'pre-poi') assert.equal(options.relayPrePoi, undefined);
    const relayCurrent = () => {
      if (relayMode === 'prove-local' || relayMode === 'pre-poi') {
        require('./railgun-account-enrollment').assertRailgunFencedAccountEnrollment(enrollment);
        require('./railgun-identity').assertRailgunIdentity(
          identity,
          enrollment.getContext('engine')
        );
      }
      if (relayMode !== undefined) {
        relayData.assertRailgunRelaySignal(options.relaySignal);
        assert.ok(!snapshot.signal.aborted && !walletSession.signal.aborted);
      }
    };
    if (recoveryMode) {
      assert.ok(readOnly && options.privateRecovery);
      assert.equal(options.privateIntent, undefined);
      assert.equal(options.privateOperation, undefined);
      options.privateRecovery =
        require('./railgun-private-recovery-data').normalizeRailgunPrivateRecoveryInput(
          options.privateRecovery,
          { walletId }
        );
    } else assert.equal(options.privateRecovery, undefined);
    const descriptor = currentIdentity();
    if (descriptor) assert.equal(walletId, descriptor.walletId);
    assert.equal(typeof restore, 'boolean');
    assert.ok(!readOnly || restore);
    assert.equal(coverageStore.session, walletSession);
    const before = await walletSession.inspectWalletState();
    relayCurrent();
    walletSession.assertFresh(before);
    const grant = readOnly
      ? coverageStore.beginRestore(
          relayMode === undefined
            ? snapshot.signal
            : AbortSignal.any([snapshot.signal, options.relaySignal])
        )
      : coverageStore.beginEngine();
    try {
      const result = await runJob({
        ...options,
        snapshot,
        walletSession,
        walletGrant: grant,
        walletId,
        restore,
      });
      relayCurrent();
      assert.equal(result.closed?.code, 'RAILGUN_PROCESS_CLOSED');
      if (relayMode !== undefined) {
        assert.equal(result.closed.exitCode, 15);
        assert.equal(result.closed.escalated, false);
        assert.equal(result.closed.peerDisconnected, false);
      }
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
      const ownedPoi = normalizeRailgunOwnedPoiRecords(result.ownedPoi, read, snapshot.checkpoint);
      const relayOwned =
        relayMode === undefined
          ? undefined
          : Object.freeze({
              read,
              ownedPoi,
              trees: Object.freeze(
                snapshot.checkpoint.state.trees.map((tree) => Object.freeze({ ...tree }))
              ),
              checkpointHash: checkpointHash(snapshot.checkpoint),
            });
      let preparedRelay, reconstructedRelay, producedRelay, prePoiBinding;
      if (relayMode === 'pre-poi') {
        assert.equal(result.relayDraft, undefined);
        assert.equal(result.relayReconstruction, undefined);
        relayData.bindRailgunRelayDraft(
          relayDraft.data,
          { selection: relayDraft.data.selection, context: relayDraft.data.intent.context },
          { walletId, ...relayOwned }
        );
        const id = `${relayDraft.data.selection.tree}:${relayDraft.data.selection.position}`;
        const note = ownedPoi.find((value) => value.id === id);
        assert.ok(note);
        assert.equal(note.blindedCommitment, relayPrePoi.history.note.blindedCommitment);
        assert.equal(note.type, relayPrePoi.history.note.type);
        prePoiBinding = relayData.normalizeRailgunRelayPrePoiResult(
          result.relayPrePoiBinding,
          relayPrePoi,
          walletId
        );
      } else if (relayMode === 'prove-local') {
        assert.equal(result.relayDraft, undefined);
        assert.equal(result.relayReconstruction, undefined);
        const proofData = require('./railgun-relay-proof-results');
        proofData.bindRailgunRelayLocalOwned(relayProof.recordText, { walletId, ...relayOwned });
        producedRelay = proofData.normalizeRailgunRelayProducedProof(
          result.relayProof,
          relayProof.recordText
        );
      } else if (relayMode === 'construct') {
        assert.equal(result.relayReconstruction, undefined);
        preparedRelay = relayData.bindRailgunRelayDraft(result.relayDraft, relayRequest, {
          walletId,
          ...relayOwned,
        });
      } else if (relayMode === 'reconstruct') {
        assert.equal(result.relayDraft, undefined);
        relayData.bindRailgunRelayDraft(
          relayDraft.data,
          {
            selection: relayDraft.data.selection,
            context: relayDraft.data.intent.context,
          },
          { walletId, ...relayOwned }
        );
        reconstructedRelay = relayData.normalizeRailgunRelayReconstruction(
          result.relayReconstruction,
          relayDraft
        );
      } else {
        assert.equal(result.relayDraft, undefined);
        assert.equal(result.relayReconstruction, undefined);
      }
      if (relayMode !== 'prove-local') assert.equal(result.relayProof, undefined);
      if (relayMode !== 'pre-poi') assert.equal(result.relayPrePoiBinding, undefined);
      const preparation =
        options.privateIntent === undefined
          ? undefined
          : require('./railgun-private-preparation').normalizeRailgunPrivatePreparation(
              result.privatePreparation,
              {
                selection: options.privateIntent,
                read,
                ownedPoi,
                trees: snapshot.checkpoint.state.trees,
              }
            );
      if (options.privateIntent === undefined) assert.equal(result.privatePreparation, undefined);
      const operation =
        options.privateOperation === undefined
          ? undefined
          : require('./railgun-private-preparation').normalizeRailgunPrivateOperation(
              result.privateOperation,
              preparation
            );
      if (options.privateOperation === undefined) assert.equal(result.privateOperation, undefined);
      const recovery = recoveryMode
        ? require('./railgun-private-recovery-data').normalizeRailgunPrivateRecoveryResult(
            result.privateRecovery,
            {
              capsule: options.privateRecovery.capsule,
              walletId,
              read,
              ownedPoi,
              trees: snapshot.checkpoint.state.trees,
            }
          )
        : undefined;
      if (!recoveryMode) assert.equal(result.privateRecovery, undefined);
      if (descriptor) {
        assert.equal(read.instanceId, descriptor.instanceId);
        currentIdentity();
      }
      const state = await walletSession.inspectWalletState();
      relayCurrent();
      if (relayMode !== undefined) currentIdentity();
      walletSession.assertFresh(state);
      if (restore) assert.deepEqual(state, before);
      const readOnlyStatus = readOnly ? grant.getStatus() : null;
      if (readOnly) assert.deepEqual(readOnlyStatus, { readOnly: true, writeAttempts: 0 });
      const receipt = Object.freeze({});
      receipts.set(receipt, {
        read,
        ownedPoi,
        session: walletSession,
        walletId,
        checkpoint: checkpointHash(snapshot.checkpoint),
        trees: Object.freeze(
          snapshot.checkpoint.state.trees.map((tree) => Object.freeze({ ...tree }))
        ),
        summary: summarizeRailgunWalletCoverage(coverage),
        mode: restore ? 'restore' : 'scan',
        state,
      });
      if (readOnly) coverageStore.finishRestore(receipt);
      else coverageStore.finishEngine(receipt);
      return {
        result,
        receipt,
        coverage,
        ...(readOnly ? { readOnly: readOnlyStatus } : {}),
        ...(preparation ? { preparation } : {}),
        ...(operation ? { operation } : {}),
        ...(recovery ? { recovery } : {}),
        ...(relayOwned ? { relayOwned } : {}),
        ...(preparedRelay ? { relayDraft: preparedRelay } : {}),
        ...(producedRelay ? { relayProof: producedRelay } : {}),
        ...(prePoiBinding ? { relayPrePoiBinding: prePoiBinding } : {}),
        ...(reconstructedRelay ? { relayReconstruction: reconstructedRelay } : {}),
      };
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
  function readOwned(receipt, journal) {
    const observed = read(receipt, journal);
    const saved = receipts.get(receipt);
    return Object.freeze({
      read: observed,
      ownedPoi: saved.ownedPoi,
      checkpointHash: saved.checkpoint,
      trees: saved.trees,
    });
  }
  const instance = Object.freeze({
    run: (options) => run(options),
    restoreReadOnly: (options) => run({ ...options, restore: true }, true),
    prepareReadOnly: (options) => {
      assert.ok(options.privateIntent);
      return run({ ...options, restore: true }, true);
    },
    operateReadOnly: (options) => {
      assert.ok(options.privateIntent && options.privateOperation);
      return run({ ...options, restore: true }, true);
    },
    recoverReadOnly: (options) => run({ ...options, restore: true }, true, true),
    prepareRelayReadOnly: (options) => run({ ...options, restore: true }, true, false, 'construct'),
    reconstructRelayReadOnly: (options) =>
      run({ ...options, restore: true }, true, false, 'reconstruct'),
    prepareRelayPrePoiReadOnly: (options) =>
      run({ ...options, restore: true }, true, false, 'pre-poi'),
    proveRelayReadOnly: (options) => run({ ...options, restore: true }, true, false, 'prove-local'),
    assertScan,
    read,
    readOwned,
  });
  instances.add(instance);
  return instance;
}
function createRailgunAccountRunner({ identity, archive, policy, enrollment }) {
  require('./railgun-identity').assertRailgunIdentity(identity);
  archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  return createRailgunWalletRunner({
    identity,
    enrollment,
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
