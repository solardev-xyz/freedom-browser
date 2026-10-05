/** Native fixture continuation only. Every account/staging/completion/hold is
 * issued by production. Inputs come from the genuine scan and actual first
 * transaction. This does not turn the disposable list into live acceptance. */
const fs = require('fs');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const walletPath = '../../src/main/wallet/';
const copy = (value) => JSON.parse(JSON.stringify(value));
const delta = (after, before) =>
  Object.fromEntries(
    [...new Set([...Object.keys(after), ...Object.keys(before)])]
      .map((key) => [key, (after[key] || 0) - (before[key] || 0)])
      .filter(([, value]) => value)
  );
// Pure fixture check only; the caller obtains `owned` from the genuine registry.
function selectChange(owned, continuation) {
  const capsule = continuation.ownEvidence.capsule;
  assert.equal(capsule.version, 2);
  const txid = '0x' + continuation.ownEvidence.row.txid;
  const notes = owned.read.received.filter((note) => note.txid === txid);
  const records = owned.ownedPoi.filter((note) => note.txid === txid);
  assert.equal(notes.length, 1);
  assert.equal(records.length, 1);
  const note = notes[0],
    record = records[0];
  assert.equal(note.id, record.id);
  assert.equal(record.type, 'Transact');
  assert.equal(record.hash, capsule.preparation.expected.changeCommitment);
  assert.equal(note.hash, record.hash);
  assert.equal(note.spentTxid, false);
  assert.equal(note.amount.toString(), capsule.preparation.changeAmount);
  assert.equal(
    note.amount + BigInt(capsule.preparation.unshieldAmount),
    BigInt(capsule.preparation.inputAmount)
  );
  assert.notEqual(record.nullifier, capsule.preparation.expected.nullifier);
  const trees = owned.trees.filter((tree) => tree.tree === note.tree);
  assert.equal(trees.length, 1);
  assert.ok(note.position < trees[0].length);
  assert.notEqual(trees[0].root, capsule.preparation.expected.merkleRoot);
  return { note, record, merkleRoot: trees[0].root };
}
exports.selectChange = selectChange;
async function run(h, restart, proveStop = false, signStop = false, facadeMode = false) {
  assert.equal(facadeMode && (restart || proveStop || signStop), false);
  assert.equal(proveStop && signStop, false);
  const {
    identity,
    enrollment,
    coordinator,
    archive,
    proverArchive,
    artifactDirectory,
    continuation,
    store,
    acceptance,
    signal,
  } = h;
  if (restart) require('./railgun-combined-poi-list-replay').assertProvider(h.replay);
  else {
    assert.equal(acceptance.report().accepted, true);
    assert.equal(acceptance.report().verifierExits, 1);
    assert.equal(acceptance.report().bindingExits, 1);
  }
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  const wallet = require(walletPath + 'railgun-account-wallet');
  const staging = require(walletPath + 'railgun-transact-staging');
  const owners = Object.freeze({ identity, enrollment, coordinator });
  const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
  h.adoptStores(reservations, capsules);
  const capsuleDigest = continuation.ownEvidence.record.resolution.railgun
    ? require(walletPath + 'railgun-private-capsule').digestRailgunPrivateCapsule(
        continuation.ownEvidence.capsule
      )
    : assert.fail('First own record unresolved');
  const retainedBefore = await store.get(capsuleDigest);
  assert.equal(retainedBefore.state, 'attempted');
  const retainedInspect = await store.inspect();
  assert.equal(retainedInspect.reservedTransitions, 2);
  const retainedFile = require(walletPath + 'privacy-storage').getPrivacyStoragePath(
    enrollment.getContext('storage', 'railgun-poi-intents-v1:' + enrollment.descriptor.walletId),
    enrollment.directory
  );
  const retainedBytes = fs.readFileSync(retainedFile);
  let originalPrivate;
  await reservations.withSigningRecovery(async (records, context) => {
    context.assertCurrent();
    assert.equal(records.length, 1);
    originalPrivate = {
      entry: copy(records[0].entry),
      stored: copy(await capsules.readSigned(records[0].receipt)),
    };
    context.assertCurrent();
  });
  const beforeJournal = await h.journal().list();
  assert.equal(beforeJournal.length, 1);
  const firstRecord = beforeJournal[0];
  assert.equal(firstRecord.hash, continuation.ownEvidence.record.hash);
  assert.ok(firstRecord.resolution);
  const recipient = originalPrivate.entry.signing.submitter;
  assert.equal(recipient, continuation.ownEvidence.capsule.selection.recipient);
  const before = h.activity();
  let account, staged, completion, recovery, scope, secondChain;
  const constraints = [];
  let secondStored, secondEntry, secondCapture, terminalBaseline;
  try {
    const facadeBeforeOpen = facadeMode ? h.facadeMeasure() : undefined;
    h.phase('second-open-wallet');
    account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'active' });
    assert.equal(signal.aborted, false);
    if (facadeMode)
      require('./railgun-kohaku-partial-native').assertCounts(
        facadeBeforeOpen,
        h.facadeMeasure(),
        require('./railgun-kohaku-second-instance').accountOpenCounts()
      );
    const owned = wallet.readRailgunAccountOwnedNotes(account, owners);
    const { note, record, merkleRoot } = selectChange(owned, continuation);
    if (restart) h.replay.assertChange(record);
    if (h.terminalMode)
      terminalBaseline = require('./railgun-combined-poi-terminal-data').beforeSecond(
        owned,
        continuation,
        note
      );
    assert.equal(record.blindedCommitment, retainedBefore.payload.blindedCommitmentsOut[0]);
    const request = Object.freeze({
      kind: 'railgun-token-unshield',
      noteId: record.id,
      recipient,
    });
    secondChain = require('./railgun-combined-poi-second-chain').create({
      bytecodes: h.bytecodes,
      artifactDirectory,
      accountIndex: enrollment.descriptor.accountIndex,
      selected: record,
      tree: note.tree,
      merkleRoot,
      amount: note.amount,
      recipient,
      firstRecord,
      firstNullifier: continuation.ownEvidence.capsule.preparation.expected.nullifier,
      firstRoot: continuation.ownEvidence.capsule.preparation.expected.merkleRoot,
      firstReceipt: continuation.ownEvidence.receipt,
    });
    h.installTransport(secondChain);
    let proved, facadeResult;
    if (facadeMode) {
      h.phase('second-facade');
      facadeResult = await h.facade.second({
        identity,
        enrollment,
        coordinator,
        account,
        capsules,
        archive,
        proverArchive,
        artifactDirectory,
        note,
        record,
        recipient,
        amount: note.amount,
        measure: h.facadeMeasure,
        recordReview: h.recordReview,
        onStored(value) {
          secondStored = value;
          secondChain.bindProved(value);
        },
      });
      account = undefined;
      proved = { holdId: secondStored.holdId };
    } else {
      const {
        createPrivacyScope,
        getPrivacyContext,
      } = require('../../src/main/networks/privacy-context');
      const rpc = require('../../src/main/networks/private-rpc');
      const parent = getPrivacyContext(enrollment.getContext('engine'));
      scope = createPrivacyScope({ profileId: parent.profileId, signal });
      const subject = { ...parent.subject, role: 'protocol-rpc' };
      delete subject.operation;
      for (const descriptor of [
        subject,
        {
          kind: 'public-address',
          principal: recipient,
          chainId: 11155111,
          role: 'transaction-rpc',
        },
      ]) {
        const handle = scope.getContext(descriptor);
        const client = rpc.createPrivateRpc(handle, descriptor.role);
        const observation = rpc.getPrivateRpcDestination(client, handle);
        assert.equal(
          rpc.getPrivateRpcDestinationDetails(observation).url,
          'https://synthetic.invalid/railgun-partial-controller'
        );
        constraints.push(
          rpc.createPrivateRpcDestinationConstraint({
            observation,
            signal,
            deadline: performance.now() + 660000,
          })
        );
      }
      const destinationConstraints = Object.freeze({
        protocol: constraints[0].constraint,
        transaction: constraints[1].constraint,
      });
      h.phase('second-transact-staging');
      staged = await staging.stageRailgunTransactInput({
        account,
        owners,
        request,
        archive,
        signal,
      });
      assert.equal(staged.status, 'staged');
      account = staged.account;
      const facts = staging.assertRailgunTransactStaging(staged.receipt, account, owners, request);
      assert.deepEqual(facts.state, continuation.state);
      assert.deepEqual(facts.noteWitness.witness.row, continuation.ownEvidence.row);
      assert.equal(facts.noteWitness.outputIndex, 0);
      assert.equal(facts.noteWitness.witness.row.commitments.length, 2);
      assert.equal(
        facts.noteWitness.witness.row.commitments[1],
        continuation.ownEvidence.capsule.preparation.expected.unshieldCommitment
      );
      assert.deepEqual(facts.baseline.owned, record);
      assert.deepEqual(facts.baseline.received, note);
      h.phase('second-prove');
      proved = await require(
        walletPath + 'railgun-private-operation'
      ).proveRailgunAccountPrivateOperation({
        account,
        owners,
        archive,
        proverArchive,
        artifactDirectory,
        request,
        destinationConstraints,
        stagingReceipt: staged.receipt,
      });
      if (signStop) {
        assert.equal(proved.status, 'signed-unfinished');
        assert.match(proved.holdId, /^[a-f0-9]{64}$/);
        await account.close();
        account = undefined;
        staged.close();
        staged = undefined;
        let second;
        await reservations.withSigningRecovery(async (records, context) => {
          context.assertCurrent();
          assert.equal(records.length, 2);
          const old = records.find((v) => v.entry.id === originalPrivate.entry.id);
          assert.deepEqual(old.entry, originalPrivate.entry);
          assert.deepEqual(await capsules.readSigned(old.receipt), originalPrivate.stored);
          const item = records.find((v) => v.entry.id === proved.holdId);
          assert.ok(item);
          assert.equal(item.entry.facts.nullifier, record.nullifier);
          second = {
            entry: copy(item.entry),
            stored: copy(await capsules.readSignedUnfinished(item.receipt)),
          };
          context.assertCurrent();
        });
        assert.equal(signal.aborted, false);
        h.signatureStop.assertStopped(second.stored);
        const firstNow = (await h.journal().list())[0];
        secondChain.assertFirstRecord(firstNow);
        assert.equal(secondChain.report().firstCanonicalRefreshReads, 1);
        assert.equal(secondChain.report().sends, 0);
        assert.equal(secondChain.report().signatures, 0);
        assert.deepEqual(await store.get(capsuleDigest), retainedBefore);
        assert.deepEqual(await store.inspect(), retainedInspect);
        assert.deepEqual(fs.readFileSync(retainedFile), retainedBytes);
        require('./railgun-combined-poi-second-sign-counts').assertSignStop(
          before,
          h.activity(),
          secondChain.report(),
          h.wire
        );
        assert.equal(h.pendingChildren(), 0);
        assert.equal(h.unwipedLoans(), 0);
        sticky.assertEmpty();
        return {
          report: {
            genuineSignedUnfinishedSecond: true,
            originalSignatureCommittedBeforeInterruption: true,
            secondColdSubmitQualified: false,
            secondSignedUnfinishedRecoveryQualified: false,
            interruption: h.signatureStop.report(),
            traffic: secondChain.report(),
          },
          sealed: {
            records: require('./railgun-combined-poi-second-recovery-data').signedHashes(
              originalPrivate,
              second,
              firstNow
            ),
            retained: {
              entrySha256: require('./railgun-combined-poi-restart-data').digest(retainedBefore),
              inspectSha256: require('./railgun-combined-poi-restart-data').digest(retainedInspect),
            },
          },
        };
      }
      assert.equal(proved.status, 'proved');
      completion = proved.completion;
      secondStored = await capsules.get(proved.holdId);
      assert.ok(secondStored.signature && secondStored.provedTransaction);
      secondChain.bindProved(secondStored);
      await account.close();
      account = undefined;
      staged.close();
      staged = undefined;
    }
    await reservations.withSigningRecovery(async (records, context) => {
      context.assertCurrent();
      assert.equal(records.length, 2);
      const first = records.find((value) => value.entry.id === originalPrivate.entry.id);
      assert.deepEqual(first.entry, originalPrivate.entry);
      assert.deepEqual(await capsules.readSigned(first.receipt), originalPrivate.stored);
      const next = records.find((value) => value.entry.id === proved.holdId);
      assert.ok(next);
      secondEntry = copy(next.entry);
      assert.equal(next.entry.state, 'signing');
      assert.equal(next.entry.facts.nullifier, record.nullifier);
      assert.deepEqual(await capsules.readSigned(next.receipt), secondStored);
      context.assertCurrent();
    });
    if (proveStop) {
      assert.equal(signal.aborted, false);
      completion.close();
      completion = undefined;
      const firstNow = (await h.journal().list())[0];
      secondChain.assertFirstRecord(firstNow);
      assert.equal(secondChain.report().firstCanonicalRefreshReads, 1);
      assert.equal(secondChain.report().sends, 0);
      assert.equal(secondChain.report().signatures, 0);
      assert.deepEqual(await store.get(capsuleDigest), retainedBefore);
      assert.deepEqual(await store.inspect(), retainedInspect);
      assert.deepEqual(fs.readFileSync(retainedFile), retainedBytes);
      const after = h.activity();
      const expected = require('./railgun-combined-poi-second-cold-counts').assertProveStop(
        before,
        after,
        secondChain.report(),
        h.wire
      );
      assert.equal(h.pendingChildren(), 0);
      assert.equal(h.unwipedLoans(), 0);
      sticky.assertEmpty();
      return {
        report: {
          genuineSecondProofStored: true,
          completionDiscarded: true,
          secondColdSubmitQualified: false,
          counts: expected,
          traffic: secondChain.report(),
        },
        sealed: {
          records: require('./railgun-combined-poi-second-handoff').pairHashes(
            originalPrivate,
            { entry: secondEntry, stored: secondStored },
            firstNow
          ),
          retained: {
            entrySha256: require('./railgun-combined-poi-restart-data').digest(retainedBefore),
            inspectSha256: require('./railgun-combined-poi-restart-data').digest(retainedInspect),
          },
        },
      };
    }
    let reviewCalls = facadeMode ? facadeResult.report.transactionReviews : 0;
    if (facadeMode) {
      assert.equal(
        facadeResult.submitted.hash.toLowerCase(),
        secondChain.evidence().transaction.hash
      );
      assert.equal(Object.hasOwn(facadeResult.submitted, 'status'), false);
    } else {
      const submit = require(
        walletPath + 'railgun-private-submission'
      ).submitRailgunPrivateTransaction;
      h.phase('second-submit');

      const submitted = await submit({
        identity,
        enrollment,
        completion: completion.receipt,
        proverArchive,
        artifactDirectory,
        gasLimit: 1500000n,
        maxGasFee: 2000000000000000n,
        review: async (request) => {
          reviewCalls++;
          h.recordReview();
          assert.equal(reviewCalls, 1);
          assert.equal(request.operation, 'railgun-token-unshield');
          assert.equal(request.transaction.data, secondStored.provedTransaction.data);
          assert.equal(request.from.toLowerCase(), recipient);
          assert.equal(request.fundingAddressPublic, true);
          assert.equal(secondChain.report().sends, 0);
          assert.equal(secondChain.report().signatures, 0);
          return true;
        },
      });
      assert.equal(submitted.hash.toLowerCase(), secondChain.evidence().transaction.hash);
      assert.equal(Object.hasOwn(submitted, 'submissionState'), false);
      assert.equal(Object.hasOwn(submitted, 'status'), false);
      assert.equal(reviewCalls, 1);
      const afterSend = secondChain.report();
      assert.deepEqual(
        await submit({
          identity,
          enrollment,
          completion: completion.receipt,
          proverArchive,
          artifactDirectory,
          gasLimit: 1500000n,
          maxGasFee: 2000000000000000n,
          review: async () => assert.fail('Replayed review'),
        }),
        { status: 'recovery-required', stage: 'completion' }
      );
      assert.deepEqual(secondChain.report(), afterSend);
      completion.close();
      completion = undefined;
    }
    const { transaction, receipt } = secondChain.evidence();
    assert.notEqual(transaction.hash, firstRecord.hash);
    const nextRecords = await h.journal().list();
    assert.equal(nextRecords.length, 2);
    secondChain.assertFirstRecord(nextRecords.find((value) => value.hash === firstRecord.hash));
    const next = nextRecords.find((value) => value.hash === transaction.hash);
    assert.equal(next.state, 'submitted');
    assert.equal(next.intent.operation, 'railgun-token-unshield');
    assert.equal(next.intent.nullifier, record.nullifier);
    const facadeBeforeResolutionAndCapture = facadeMode ? h.facadeMeasure() : undefined;
    h.phase('second-resolution');
    recovery = require(walletPath + 'railgun-transact-recovery').openRailgunTransactRecovery(
      recipient
    );
    const observed = await recovery.observe(transaction.hash);
    assert.equal(observed.transact.status, 'matched');
    assert.equal(observed.transact.output.kind, 'unshield');
    assert.equal(observed.transact.output.amount, note.amount.toString());
    await recovery.resolve(transaction.hash, {
      minimumConfirmations: 3,
      review: async (request) => {
        assert.equal(request.transact.status, 'matched');
        assert.equal(request.transact.output.kind, 'unshield');
        return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
      },
    });
    recovery.close();
    recovery = undefined;
    h.phase('second-capture');
    const selector = Object.fromEntries(
      ['tree', 'position', 'nullifier', 'noteHash'].map((key) => [key, secondEntry.facts[key]])
    );
    const capture = await require(walletPath + 'railgun-own-operation').captureRailgunOwnOperation({
      enrollment,
      selector,
      signal,
    });
    assert.equal(capture.status, 'captured');
    secondCapture = capture.capture;
    assert.equal(secondCapture.capsule.version, 1);
    assert.equal(secondCapture.capsule.selection.kind, 'railgun-token-unshield');
    assert.deepEqual(secondCapture.capsule, secondStored.capsule);
    assert.equal(secondCapture.record.hash, transaction.hash);
    assert.equal(secondCapture.projection.railgun.transact.output.kind, 'unshield');
    assert.deepEqual(await store.get(capsuleDigest), retainedBefore);
    assert.deepEqual(await store.inspect(), retainedInspect);
    assert.deepEqual(fs.readFileSync(retainedFile), retainedBytes);
    secondChain.assertFirstRecord(
      (await h.journal().list()).find((value) => value.hash === firstRecord.hash)
    );
    if (facadeMode)
      require('./railgun-kohaku-partial-native').assertCounts(
        facadeBeforeResolutionAndCapture,
        h.facadeMeasure(),
        require('./railgun-kohaku-second-instance').resolutionAndCaptureCounts()
      );
    const after = h.activity();
    const jobs = delta(after.audit.starts, before.audit.starts);
    assert.deepEqual(jobs, {
      'railgun-wallet-job.js': 2,
      'railgun-txid-job.js': 3,
      'railgun-private-operate-job.js': 1,
      'railgun-note-provenance-job.js': 1,
      'railgun-poi-job.js': 1,
      'railgun-spend-sign-job.js': 1,
      'railgun-private-verify-job.js': 2,
    });
    assert.deepEqual(delta(after.audit.exits, before.audit.exits), jobs);
    assert.deepEqual(delta(after.audit.attemptedResults, before.audit.attemptedResults), jobs);
    assert.deepEqual(delta(after.audit.admittedResults, before.audit.admittedResults), jobs);
    assert.deepEqual(delta(after.audit.modes, before.audit.modes), {
      inspect: 2,
      'note-witness': 1,
    });
    assert.deepEqual(delta(after.audit.keyRequests, before.audit.keyRequests), {
      'railgun-wallet-job.js': 2,
      'railgun-private-operate-job.js': 1,
      'railgun-spend-sign-job.js': 1,
    });
    assert.deepEqual(
      delta(after.audit.keyReplies, before.audit.keyReplies),
      delta(after.audit.keyRequests, before.audit.keyRequests)
    );
    assert.equal(after.storageWorkers.starts - before.storageWorkers.starts, 3);
    assert.equal(after.storageWorkers.exits - before.storageWorkers.exits, 3);
    assert.equal(after.storageWorkers.pending, before.storageWorkers.pending);
    assert.deepEqual(after.services.poiMethods, before.services.poiMethods);
    assert.equal(after.services.signatureChecks - before.services.signatureChecks, 1);
    const chainRequests = delta(after.chain.attempted, before.chain.attempted);
    assert.deepEqual(delta(after.chain.validated, before.chain.validated), chainRequests);
    for (const method of [
      'ppoi_pois_per_list',
      'ppoi_merkle_proofs',
      'ppoi_poi_events',
      'ppoi_validate_poi_merkleroots',
    ])
      assert.equal(chainRequests['private-account:poi:' + method], 1);
    assert.equal(chainRequests['service:poi:ppoi_validated_txid'], 3);
    assert.equal(chainRequests['service:poi:ppoi_validate_txid_merkleroot'], 3);
    assert.equal(chainRequests['service:indexer:page'] ?? 0, 0);
    assert.equal(chainRequests['private-account:poi:ppoi_submit_transact_proof'] ?? 0, 0);
    assert.deepEqual(after.audit.starts, after.audit.exits);
    assert.equal(h.pendingChildren(), 0);
    assert.equal(h.unwipedLoans(), 0);
    const traffic = secondChain.report();
    assert.deepEqual(traffic.attempted, traffic.validated);
    assert.deepEqual(traffic.privateCalls, {
      rootHistory: 2,
      unshieldFee: 2,
      getVerificationKey: 2,
      nullifiers: 2,
    });
    assert.equal(traffic.sends, 1);
    assert.equal(traffic.signatures, 1);
    assert.equal(traffic.journalBeforeSend, 1);
    assert.equal(traffic.firstCanonicalRefreshReads, 4);
    sticky.assertEmpty();
    return Object.freeze({
      report: Object.freeze({
        genuineScannedTransactChange: true,
        ...(facadeMode ? { secondFacade: facadeResult.report } : {}),
        existingFullMirrorPreserved: true,
        originalPartialCreatorFinalUnshieldHashVerified: true,
        freshWindowPoiAndRoot: true,
        circuit: '01x01',
        transactionReviewCalls: reviewCalls,
        genuineReservationSignatureProofAndIndependentVerification: true,
        secondEoaAttemptRecordedBeforeSend: true,
        originalAttemptIdentityAndResolutionPreserved: true,
        originalObservationRefreshVerified: true,
        retainedEntryUnchanged: true,
        retainedPoiCiphertextUnchanged: true,
        simulatedReceiptResolvedAndCaptured: true,
        secondColdSubmitQualified: false,
        secondSpendIngestedIntoWallet: false,
        liveEligibilityOrSubmissionQualified: false,
        jobs,
        traffic,
      }),
      continuation: {
        capture: secondCapture,
        receipt,
        transaction,
        ...(h.terminalMode ? { terminalBaseline } : {}),
      },
    });
  } finally {
    try {
      recovery?.close();
    } finally {
      try {
        completion?.close();
      } finally {
        try {
          staged?.close();
        } finally {
          try {
            if (account) await account.close();
          } finally {
            for (const constraint of constraints) constraint.close();
            scope?.close();
            secondChain?.close();
            h.installTransport(undefined);
          }
        }
      }
    }
  }
}
exports.run = (h) => run(h, false);
exports.runRestart = (h) => run(h, true);

exports.runFacade = (h) => run(h, false, false, false, true);
exports.proveAndStopRestart = (h) => run(h, true, true);

exports.signAndStopRestart = (h) => run(h, true, false, true);
