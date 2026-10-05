/** Fixed B final process. Saved hashes select encrypted data, never an issued
 * completion/ownership object. Production reacquires every submission gate. */
const fs = require('fs');
const { assert } = require('./railgun-native-assertions');
const sticky = require('./railgun-native-assertions');
const data = require('./railgun-combined-poi-restart-data');
const handoff = require('./railgun-combined-poi-second-handoff');
const counts = require('./railgun-combined-poi-second-cold-counts');
const wallet = '../../src/main/wallet/';
const copy = (value) => JSON.parse(JSON.stringify(value));
function assertRetryIdle(h, before) {
  const after = h.activity();
  // The recovered host releases its two destination-preview handles even on
  // prior-attempt refusal. private-rpc shares the transport already opened by
  // the successful submit; these are logical releases, with no new requests.
  const expected = {
    ...before,
    services: { ...before.services, transportReleases: before.services.transportReleases + 2 },
  };
  // Only fixed counter-category names may reach diagnostics, never values or
  // private recovery records. Keep the complete equality assertion below.
  for (const category of [
    'keys',
    'jobs',
    'methods',
    'eoa',
    'transportEntries',
    'wrapperEntries',
    'services',
    'storageWorkers',
    'roleMethods',
    'chain',
    'audit',
  ])
    if (!require('util').isDeepStrictEqual(after[category], expected[category]))
      h.recordColdRetryDifference?.(category);
  assert.deepEqual(after, expected);
}
async function readPair(enrollment, expected) {
  const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
  let first, second;
  await reservations.withSigningRecovery(async (records, context) => {
    context.assertCurrent();
    assert.equal(records.length, 2);
    for (const name of ['first', 'second']) {
      const matches = records.filter(
        ({ entry }) => data.digest(entry.id) === expected[name].holdId
      );
      assert.equal(matches.length, 1);
      const selected = matches[0];
      const value = {
        entry: copy(selected.entry),
        stored: copy(await capsules.readSigned(selected.receipt)),
      };
      context.assertCurrent();
      for (const [key, subject] of Object.entries({
        entry: value.entry,
        stored: value.stored,
        capsule: value.stored.capsule,
        signature: value.stored.signature,
        provedTransaction: value.stored.provedTransaction,
      }))
        assert.equal(data.digest(subject), expected[name][key]);
      if (name === 'first') first = value;
      else second = value;
    }
    context.assertCurrent();
  });
  return { first, second };
}
async function run(h, lost = false) {
  const {
    enrollment,
    identity,
    publicAccount,
    archive,
    proverArchive,
    artifactDirectory,
    signal,
    continuation: first,
    store,
    replay,
    chain,
    pair,
    sealed,
  } = h;
  const coordinator = publicAccount.coordinator;
  const owners = { identity, enrollment, coordinator };
  const current = () => assert.equal(signal.aborted, false);
  const { second } = pair;
  const capsule = second.stored.capsule;
  const stored = second.stored;
  const firstRecord = (await h.journal().list())[0];
  assert.equal(data.digest(firstRecord), sealed.records.record);
  assert.equal(handoff.firstImmutable(firstRecord), sealed.records.immutableRecord);
  assert.deepEqual(handoff.pairHashes(pair.first, second, firstRecord), sealed.records);
  // Response-fixture binding from authentic encrypted data only. This record is
  // never handed to the controller as ownership; its completed wallet reads it.
  const selected = {
    type: 'Transact',
    id: `${capsule.selection.tree}:${capsule.selection.position}`,
    hash: capsule.noteHash,
    txid: firstRecord.hash,
    nullifier: capsule.preparation.expected.nullifier,
    blindedCommitment: (await store.get(h.wire.retained.capsuleDigest)).payload
      .blindedCommitmentsOut[0],
  };
  replay.assertChange(selected);
  const recipient = second.entry.signing.submitter;
  const transport = require('./railgun-combined-poi-second-chain');
  const secondChain = (lost ? transport.createColdLost : transport.createCold)({
    bytecodes: h.bytecodes,
    artifactDirectory,
    accountIndex: enrollment.descriptor.accountIndex,
    selected,
    tree: capsule.selection.tree,
    merkleRoot: capsule.preparation.expected.merkleRoot,
    amount: BigInt(capsule.preparation.expected.amount),
    recipient,
    firstRecord,
    firstNullifier: pair.first.stored.capsule.preparation.expected.nullifier,
    firstRoot: pair.first.stored.capsule.preparation.expected.merkleRoot,
    firstReceipt: first.ownEvidence.receipt,
  });
  let account, recovery;
  try {
    secondChain.bindProved(stored);
    h.installTransport(secondChain);
    const poiBefore = await store.get(h.wire.retained.capsuleDigest);
    const inspectBefore = await store.inspect();
    const poiFilename = require(wallet + 'privacy-storage').getPrivacyStoragePath(
      enrollment.getContext('storage', 'railgun-poi-intents-v1:' + enrollment.descriptor.walletId),
      enrollment.directory
    );
    const poiBytes = fs.readFileSync(poiFilename);
    const destination = require(
      wallet + 'railgun-account-public'
    ).getRailgunAccountPublicDestination(coordinator, enrollment);
    const submit = require(
      wallet + 'railgun-private-submission'
    ).submitRailgunRecoveredPrivateTransaction;
    const common = {
      identity,
      enrollment,
      coordinator,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      holdId: second.entry.id,
      signal,
      timeoutMs: 600000,
      gasLimit: 1500000n,
      maxGasFee: 2000000000000000n,
    };
    h.phase('second-cold-submit');
    const before = h.activity();
    const beforeTraffic = secondChain.report();
    let disclosures = 0,
      reviews = 0;
    const submitted = await submit({
      ...common,
      reviewDisclosures: async (summary, lifetime) => {
        disclosures++;
        assert.equal(disclosures, 1);
        assert.equal(lifetime.aborted, false);
        assert.equal(summary.purpose, 'railgun-recovered-private-submission');
        assert.equal(summary.operation, 'railgun-token-unshield');
        assert.equal(summary.selection.noteId, selected.id);
        assert.equal(summary.originalSpendingSignatureReused, true);
        assert.equal(summary.newSpendingSignature, false);
        assert.equal(summary.simulationBeforeTransactionReview, true);
        assert.equal(summary.submitter, recipient);
        const rpc = require('../../src/main/networks/private-rpc');
        assert.equal(
          summary.destinations.retainedSource,
          rpc.getPrivateRpcDestinationDetails(destination).url
        );
        for (const role of ['protocolRpc', 'transactionRpc'])
          assert.equal(
            summary.destinations[role],
            'https://synthetic.invalid/railgun-partial-controller'
          );
        for (const role of ['poi', 'txid'])
          assert.equal(
            summary.destinations[role],
            require(wallet + 'railgun-public-services').POI_URL
          );
        assert.ok(summary.exposures.transactionRpc.includes('eth_call'));
        assert.ok(summary.exposures.transactionRpc.includes('eth_estimateGas'));
        assert.deepEqual(h.activity().audit, before.audit);
        assert.deepEqual(h.activity().chain, before.chain);
        assert.deepEqual(h.activity().roleMethods, before.roleMethods);
        assert.deepEqual(secondChain.report(), beforeTraffic);
        return true;
      },
      reviewTransaction: async (request) => {
        reviews++;
        h.recordReview();
        assert.equal(reviews, 1);
        assert.equal(disclosures, 1);
        assert.equal(request.operation, 'railgun-token-unshield');
        assert.equal(request.transaction.data, stored.provedTransaction.data);
        assert.equal(request.from.toLowerCase(), recipient);
        assert.ok(Date.now() < request.expiresAt);
        assert.equal(secondChain.report().signatures, 0);
        assert.equal(secondChain.report().sends, 0);
        return true;
      },
    });
    if (submitted?.status === 'recovery-required') h.recordColdRefusalStage?.(submitted.stage);
    sticky.assertEmpty();
    current();
    assert.equal(disclosures, 1);
    assert.equal(reviews, 1);
    const evidence = secondChain.evidence();
    if (lost) {
      assert.equal(submitted.submissionStatus, 'unknown');
      assert.equal(submitted.transactionHash, evidence.transaction.hash);
      assert.equal(secondChain.report().controlledLostReplies, 1);
    } else {
      assert.equal(submitted.hash.toLowerCase(), evidence.transaction.hash);
      assert.equal(Object.hasOwn(submitted, 'status'), false);
      assert.equal(secondChain.report().controlledLostReplies || 0, 0);
    }
    const hostCounts = counts.assertColdHost(
      before,
      h.activity(),
      secondChain.report(),
      h.wire,
      h.source
    );
    assert.deepEqual(await readPair(enrollment, sealed.records), pair);
    const retryBefore = h.activity(),
      retryTraffic = secondChain.report();
    const retry = await submit({
      ...common,
      reviewDisclosures: async () => assert.fail('Repeated disclosure'),
      reviewTransaction: async () => assert.fail('Repeated EOA review'),
    });
    assert.deepEqual(retry, { status: 'recovery-required', stage: 'prior-attempt' });
    assertRetryIdle(h, retryBefore);
    assert.deepEqual(secondChain.report(), retryTraffic);
    // Obtain the terminal comparison baseline from a genuine completed wallet
    // while public source still excludes the second receipt; never save notes.
    h.phase('second-cold-terminal-baseline');
    const baselineBefore = h.activity();
    const walletModule = require(wallet + 'railgun-account-wallet');
    account = await walletModule.openRailgunCompletedAccountWallet({
      ...owners,
      archive,
      destination,
      signal,
      timeoutMs: 180000,
    });
    current();
    const owned = walletModule.readRailgunAccountOwnedNotes(account, owners);
    const change = require('./railgun-combined-poi-second-spend').selectChange(owned, first);
    for (const key of Object.keys(selected)) assert.equal(change.record[key], selected[key]);
    assert.equal(change.note.amount.toString(), capsule.preparation.expected.amount);
    const terminalBaseline = require('./railgun-combined-poi-terminal-data').beforeSecond(
      owned,
      first,
      change.note
    );
    await account.close();
    account = undefined;
    current();
    counts.jobs(
      baselineBefore,
      h.activity(),
      { 'railgun-public-job.js': 1, 'railgun-wallet-job.js': 1 },
      { 'railgun-wallet-job.js': 1 },
      1
    );
    h.phase('second-cold-resolution');
    recovery = require(wallet + 'railgun-transact-recovery').openRailgunTransactRecovery(recipient);
    const observed = await recovery.observe(evidence.transaction.hash);
    assert.equal(observed.transact.status, 'matched');
    assert.equal(observed.transact.output.kind, 'unshield');
    assert.equal(observed.transact.output.amount, capsule.preparation.expected.amount);
    await recovery.resolve(evidence.transaction.hash, {
      minimumConfirmations: 3,
      review: async (request) => {
        assert.equal(request.transact.status, 'matched');
        return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
      },
    });
    recovery.close();
    recovery = undefined;
    secondChain.assertFirstRecord(
      (await h.journal().list()).find((v) => v.hash === firstRecord.hash)
    );
    const secondSelector = Object.fromEntries(
      ['tree', 'position', 'nullifier', 'noteHash'].map((k) => [k, second.entry.facts[k]])
    );
    const captured = await require(wallet + 'railgun-own-operation').captureRailgunOwnOperation({
      enrollment,
      selector: secondSelector,
      signal,
    });
    assert.equal(captured.status, 'captured');
    assert.deepEqual(captured.capture.capsule, capsule);
    assert.equal(captured.capture.record.hash, evidence.transaction.hash);
    assert.equal(captured.capture.projection.railgun.transact.output.kind, 'unshield');
    const afterResolve = h.activity(),
      trafficAfterResolve = secondChain.report();
    assert.deepEqual(
      await submit({
        ...common,
        reviewDisclosures: async () => assert.fail('Resolved retry disclosure'),
        reviewTransaction: async () => assert.fail('Resolved retry review'),
      }),
      { status: 'recovery-required', stage: 'prior-attempt' }
    );
    assertRetryIdle(h, afterResolve);
    assert.deepEqual(secondChain.report(), trafficAfterResolve);
    assert.deepEqual(await store.get(h.wire.retained.capsuleDigest), poiBefore);
    assert.deepEqual(await store.inspect(), inspectBefore);
    assert.deepEqual(fs.readFileSync(poiFilename), poiBytes);
    assert.deepEqual(await readPair(enrollment, sealed.records), pair);
    // Refresh first record through genuine journal rather than reuse P0's older
    // observation revision. Its immutable projection remains exactly joined.
    const firstNow = (await h.journal().list()).find((v) => v.hash === firstRecord.hash);
    assert.equal(handoff.firstImmutable(firstNow), sealed.records.immutableRecord);
    const refreshedFirst = { ...first, ownEvidence: { ...first.ownEvidence, record: firstNow } };
    const terminal = await require('./railgun-combined-poi-terminal-ingest').runRestart({
      ...h,
      first: refreshedFirst,
      second: { capture: captured.capture, ...evidence, terminalBaseline },
      chain,
      replay,
      store,
    });
    current();
    assert.equal(chain.report().posts, 0);
    assert.equal(h.pendingChildren(), 0);
    assert.equal(h.unwipedLoans(), 0);
    sticky.assertEmpty();
    return {
      report: {
        genuineColdSecondSubmission: true,
        actualSubmitOutcome: lost ? 'unknown' : 'acknowledged',
        secondColdSubmitQualified: true,
        secondSignedUnfinishedRecoveryQualified: false,
        originalSecondSignatureAndProofPreserved: true,
        firstCanonicalRefreshReads: 3,
        noAutomaticRetry: true,
        hostCounts,
        terminalIngest: terminal,
        traffic: secondChain.report(),
      },
    };
  } finally {
    try {
      recovery?.close();
    } finally {
      try {
        if (account) await account.close();
      } finally {
        secondChain.close();
        h.installTransport(undefined);
      }
    }
  }
}
module.exports = { readPair, run: (h) => run(h), runLost: (h) => run(h, true) };
