/** Actual encrypted account/journal capture with simulated chain observations.
 * Transaction proof/signature fixtures are structural, not valid spend crypto.
 */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { Interface } = require('ethers');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const {
  PRIVATE_EVENTS,
  inspectRailgunTransactReceipt,
} = require('../src/main/wallet/railgun-transact-receipt');
const { sample } = require('./fixtures/railgun-own-txid-data');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const blockHash = (n) => hex(n === -1 ? 0 : n === 291 ? 200 : n + 1000);
let lock,
  phase = 'setup';
const sources = [
  'src/main/wallet/railgun-own-receipt.js',
  'src/main/wallet/railgun-own-selector.js',
  'src/main/wallet/railgun-own-selector-job.js',
  'src/main/wallet/railgun-account-public.js',
  'src/main/wallet/railgun-public-catalog.js',
  'src/main/wallet/railgun-store-owners.js',
  'src/main/wallet/railgun-public-job.js',
  'src/main/wallet/railgun-public-run.js',
  'src/main/wallet/railgun-public-policy.js',
  'scripts/qualify-railgun-wallet-journal.js',
  'src/main/wallet/railgun-account-wallet.js',
  'src/main/wallet/railgun-private-creator.js',
  'src/main/wallet/railgun-wallet-policy.js',
  'src/main/wallet/railgun-account-store.js',
  'src/main/wallet/railgun-account-enrollment.js',
  'src/main/wallet/railgun-account-phase.js',
  'src/main/wallet/railgun-private-reservations.js',
  'src/main/wallet/railgun-private-witness.js',
  'scripts/fixtures/railgun-enrolled-operation.js',
  'scripts/fixtures/railgun-enrolled-signing.js',
  'scripts/fixtures/railgun-enrolled-submission.js',
  'src/main/wallet/railgun-private-submission.js',
  'src/main/wallet/private-transaction-intent.js',
  'src/main/wallet/private-submission-journal.js',
  'src/main/wallet/private-submission-reconciler.js',
  'src/main/wallet/privacy-journal-retention.js',
  'src/main/wallet/railgun-transact-intent.js',
  'src/main/wallet/railgun-transact-receipt.js',
  'src/main/wallet/railgun-transact-resolution.js',
  'src/main/wallet/railgun-transact-recovery.js',
  'src/main/wallet/railgun-recovery-finality.js',
  'src/main/wallet/transaction-service.js',
  'src/main/wallet/transaction-submission-coordinator.js',
  'src/main/wallet/ordinary-submission-policy.js',
  'src/main/networks/private-rpc.js',
  'src/main/wallet/railgun-private-operation.js',
  'src/main/wallet/railgun-account-poi.js',
  'src/main/wallet/railgun-private-preflight.js',
  'src/main/wallet/private-transaction-network.js',
  'src/main/wallet/signers.js',
  'src/main/wallet/vault-access.js',
  'scripts/fixtures/railgun-capsule-data.js',
  'src/main/wallet/railgun-private-capsule-store.js',
  'src/main/wallet/railgun-private-capsule.js',
  'src/main/wallet/railgun-private-reconstruct.js',
  'src/main/wallet/railgun-private-operate-job.js',
  'src/main/wallet/railgun-private-prover.js',
  'src/main/wallet/railgun-prover-runtime.js',
  'src/main/wallet/railgun-prover-manifest.json',
  'src/main/wallet/railgun-artifacts.js',
  'src/main/wallet/privacy-artifacts.js',
  'src/main/wallet/railgun-spend-sign-job.js',
  'src/main/wallet/railgun-private-verify-job.js',
  'src/main/wallet/railgun-private-proof.js',
  'src/main/wallet/railgun-private-prepare-job.js',
  'src/main/wallet/railgun-private-preparation.js',
  'src/main/wallet/railgun-private-intent.js',
  'src/main/wallet/railgun-private-policy.js',
  'src/main/wallet/railgun-private-receive.js',
  'src/main/wallet/railgun-private-receive-job.js',
  'src/main/wallet/railgun-private-results.js',
  'src/main/wallet/railgun-private-signature.js',
  'src/main/wallet/railgun-shield-pins.json',
  'src/main/wallet/privacy-profile-guard.js',
  'src/main/wallet/railgun-identity.js',
  'src/main/wallet/railgun-identity-job.js',
  'src/main/wallet/railgun-wallet-job.js',
  'src/main/wallet/railgun-wallet-run.js',
  'src/main/wallet/railgun-engine-runtime.js',
  'src/main/wallet/railgun-engine-manifest.json',
  'src/main/identity/privacy-keys.js',
  'src/main/identity/railgun-key-derivation.js',
  'src/main/wallet/privacy-session.js',
  'src/main/wallet/railgun-wallet-catalog.js',
  'src/main/wallet/railgun-wallet-coverage.js',
  'src/main/wallet/railgun-wallet-coverage-store.js',
  'src/main/wallet/railgun-wallet-journal.js',
  'src/main/wallet/railgun-wallet-runner.js',
  'src/main/wallet/railgun-wallet-read.js',
  'src/main/wallet/railgun-kohaku-read.js',
  'src/main/wallet/railgun-wallet-state.js',
  'scripts/fixtures/railgun-wallet-source.js',
  'scripts/railgun-wallet-snapshot-electron.js',
  'scripts/fixtures/railgun-wallet-snapshot-job.js',
  'src/main/wallet/railgun-wallet-storage.js',
  'src/main/wallet/railgun-wallet-scan.js',
  'src/main/wallet/railgun-wallet-records.js',
  'src/main/wallet/railgun-owned-poi-records.js',
  'scripts/railgun-coordinated-electron.js',
  'scripts/fixtures/railgun-coordinated-electron-job.js',
  'src/main/wallet/railgun-event-projector.js',
  'src/main/wallet/railgun-scan-coordinator.js',
  'src/main/wallet/railgun-scan-source.js',
  'src/main/wallet/railgun-source-ledger.js',
  'src/main/wallet/railgun-scan-journal.js',
  'src/main/wallet/railgun-session-worker.js',
  'src/main/wallet/railgun-public-records.js',
  'scripts/railgun-log-capture-data.js',
  'scripts/verify-railgun-sepolia-history.js',
  'scripts/railgun-fixture-integrity.js',
  'scripts/fixtures/railgun-engine/runtime-integrity.json',
  'src/main/wallet/railgun-session.js',
  'src/main/wallet/railgun-session-worker-entry.js',
  'src/main/wallet/railgun-paged-store.js',
  'src/main/wallet/railgun-frontier.js',
  'src/main/wallet/railgun-remote.js',
  'src/main/wallet/railgun-tree-transactions.js',
  'src/main/wallet/privacy-storage.js',
  'src/main/networks/privacy-context.js',
  'src/main/wallet/railgun-process-guards.js',
  'src/main/wallet/railgun-process.js',
  'src/main/wallet/railgun-process-entry.js',
  'docs/qualification/railgun-sepolia-history-2026-10-02.json',
  'scripts/fixtures/railgun-transact-staging-source.js',
  'scripts/fixtures/railgun-transact-staging-row.js',
  'scripts/fixtures/railgun-enrolled-transact-staging.js',
  'src/main/wallet/railgun-transact-staging.js',
  'src/main/wallet/railgun-transact-provenance.js',
  'src/main/wallet/railgun-account-txid.js',
  'src/main/wallet/railgun-note-provenance.js',
  'src/main/wallet/railgun-note-provenance-job.js',
  'src/main/wallet/railgun-txid-policy.js',
  'src/main/wallet/railgun-txid-projection.js',
  'src/main/wallet/railgun-txid-note-witness.js',
  'src/main/wallet/railgun-txid-omissions.js',
  'src/main/wallet/railgun-txid-events.js',
  'src/main/wallet/railgun-txid-coverage.js',
  'src/main/wallet/railgun-source-feed.js',
  'src/main/wallet/railgun-txid-job.js',
  'src/main/wallet/railgun-txid-runner.js',
  'src/main/wallet/railgun-txid-journal.js',
  'src/main/wallet/railgun-txid-root.js',
  'src/main/wallet/railgun-public-services.js',
  'scripts/qualify-railgun-own-source.js',
  'scripts/fixtures/railgun-own-txid-data.js',
  'scripts/fixtures/railgun-transact-data.js',
  'src/main/wallet/railgun-own-source.js',
  'src/main/wallet/railgun-own-source-capture.js',
  'src/main/wallet/railgun-shield-receipt.js',
  'src/main/wallet/railgun-own-txid.js',
  'src/main/wallet/railgun-own-operation.js',
  'scripts/qualify-railgun-own-receipt.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
async function main() {
  const [directory, archive, kind] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive));
  assert.ok(['transfer', 'unshield'].includes(kind));
  fs.mkdirSync(directory, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const before = hashes(),
    started = performance.now();
  const vault = require('../src/main/identity/vault');
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const transport = require('../src/main/networks/wallet-tor-transport');
  const originalTransport = transport.createWalletTorTransport;
  let externalAttempts = 0,
    unexpectedRpc = 0,
    fixture,
    finalizedHeight = 300,
    wrongHeader = null;
  const methods = {};
  transport.createWalletTorTransport = () => {
    externalAttempts++;
    throw Error('External transport forbidden');
  };
  const rpcModule = require('../src/main/networks/private-rpc'),
    originalRpc = rpcModule.createPrivateRpc;
  rpcModule.createPrivateRpc = (handle, role) => {
    const context = getPrivacyContext(handle);
    assert.equal(role, 'transaction-rpc');
    assert.equal(context.subject.principal, fixture.transaction.from);
    const active = () => getPrivacyContext(handle);
    return {
      signal: context.signal,
      assertActive: active,
      release() {},
      request: async (method, params, validate) => {
        methods[method] = (methods[method] ?? 0) + 1;
        if (
          ![
            'eth_getTransactionReceipt',
            'eth_getTransactionByHash',
            'eth_getBlockByNumber',
            'eth_blockNumber',
          ].includes(method)
        ) {
          unexpectedRpc++;
          throw Error('Unexpected RPC');
        }
        active();
        let result;
        if (method === 'eth_blockNumber') {
          assert.deepEqual(params, []);
          result = '0x136';
        } else if (method === 'eth_getBlockByNumber') {
          assert.equal(params[1], false);
          const number = params[0] === 'finalized' ? finalizedHeight : Number(BigInt(params[0]));
          assert.ok([291, 300, 310].includes(number));
          result = {
            number: '0x' + number.toString(16),
            hash: number === wrongHeader ? hex(999) : blockHash(number),
          };
        } else {
          assert.deepEqual(params, [fixture.transaction.hash]);
          result = method === 'eth_getTransactionReceipt' ? fixture.receipt : fixture.transaction;
        }
        assert.ok(validate(result));
        return { result: JSON.parse(JSON.stringify(result)) };
      },
    };
  };
  const { openRailgunIdentity } = require('../src/main/wallet/railgun-identity');
  const { openRailgunAccountEnrollment } = require('../src/main/wallet/railgun-account-enrollment');
  const { captureRailgunOwnOperation } = require('../src/main/wallet/railgun-own-operation');
  const { getPrivateSubmissionJournal } = require('../src/main/wallet/private-submission-journal');
  const {
    extractRailgunTransactIntent,
    railgunTransactJournalIntent,
  } = require('../src/main/wallet/railgun-transact-intent');
  const { TRANSACT_ABI } = require('../src/main/wallet/railgun-private-policy');
  const { openRailgunTransactRecovery } = require('../src/main/wallet/railgun-transact-recovery');
  let identity, enrollment, journalScope, recovery, restoreClock;
  const runs = [];
  try {
    phase = 'enrollment';
    const vaultDirectory = path.join(profile.userDataDir, 'identity');
    const password = 'public-fixture-password-not-a-user-credential';
    await vault.importVault(
      vaultDirectory,
      password,
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, password, 0);
    identity = await openRailgunIdentity({ archive });
    enrollment = await openRailgunAccountEnrollment({ identity, create: true });
    const owner = (
      await require('../src/main/wallet/signers').getSigner(0).getAddress()
    ).toLowerCase();
    fixture = sample(kind === 'unshield');
    const txAbi = new Interface([TRANSACT_ABI]),
      eventAbi = new Interface(PRIVATE_EVENTS);
    const inner = txAbi
      .decodeFunctionData('transact', fixture.transaction.input)[0][0]
      .toArray(true);
    if (kind === 'unshield') {
      inner[5][0] = hex(BigInt(owner));
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Unshield', [
          owner,
          [0, require('../src/main/wallet/railgun-shield-pins.json').wrappedNative, 0],
          998,
          2,
        ])
      );
      fixture.capsule.selection.recipient = fixture.capsule.preparation.recipient = owner;
    }
    fixture.transaction.from = fixture.receipt.from = owner;
    fixture.transaction.input = txAbi.encodeFunctionData('transact', [[inner]]);
    fixture.receipt.gasUsed = '0x10000';
    const proved = {
      chainId: 11155111,
      from: owner,
      to: fixture.transaction.to,
      value: '0',
      data: fixture.transaction.input,
    };
    const decoded = extractRailgunTransactIntent(proved);
    fixture.record.intent = railgunTransactJournalIntent(proved);
    assert.equal(
      inspectRailgunTransactReceipt(fixture.record, fixture.transaction, fixture.receipt).status,
      'matched'
    );
    const capsule = fixture.capsule;
    capsule.walletId = enrollment.descriptor.walletId;
    capsule.preparation.transaction = decoded.intent;
    capsule.preparation.expected = decoded.expected;
    const reservations = await enrollment.openReservations(),
      capsules = await enrollment.openPrivateCapsules();
    const facts = {
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      nullifier: decoded.expected.nullifier,
      noteHash: capsule.noteHash,
      kind: capsule.selection.kind,
      intentDigest: decoded.intentDigest,
      checkpointHash: 'a'.repeat(64),
      poiDigest: 'b'.repeat(64),
    };
    const held = await reservations.reserve(facts);
    await capsules.put(held, capsule, 'c'.repeat(64));
    const signed = await capsules.markSigning(held, {
      submitter: owner,
      operationId: 'd'.repeat(64),
      gatesDigest: 'c'.repeat(64),
    });
    await capsules.saveSignature(signed, { R8: [hex(1), hex(2)], S: hex(3) });
    const provedTransaction = { ...proved };
    delete provedTransaction.from;
    await capsules.saveProvedTransaction(signed, provedTransaction);
    const { tree, position, nullifier, noteHash } = facts;
    const selector = { tree, position, nullifier, noteHash };
    const capture = (selected = selector) =>
      captureRailgunOwnOperation({ enrollment, selector: selected, signal: enrollment.signal });
    const openJournal = () => {
      journalScope?.close();
      journalScope = createPrivacyScope({
        profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
        signal: enrollment.signal,
      });
      return getPrivateSubmissionJournal(
        journalScope.getContext({
          kind: 'public-address',
          principal: owner,
          chainId: 11155111,
          role: 'transaction-rpc',
        })
      );
    };
    let journal = openJournal();
    phase = 'missing-journal';
    assert.deepEqual(await capture(), { status: 'refused', stage: 'journal' });
    assert.equal(reservations.signal.aborted, false);
    assert.equal(capsules.signal.aborted, false);
    runs.push({ mode: 'missing-journal', refused: true, privateStoresSurvived: true });
    await journal.begin(fixture.transaction.hash, 3, fixture.record.intent);
    await journal.markSubmitted(fixture.transaction.hash);
    assert.deepEqual(await capture(), { status: 'refused', stage: 'journal' });
    runs.push({ mode: 'unresolved-journal', refused: true });
    phase = 'genuine-resolution';
    recovery = openRailgunTransactRecovery(owner);
    const now = Date.now;
    restoreClock = () => {
      Date.now = now;
    };
    Date.now = () => now() - 2 * 86400000;
    await recovery.resolve(fixture.transaction.hash, {
      minimumConfirmations: 3,
      review: async (request) => {
        assert.equal(request.transact.status, 'matched');
        return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
      },
    });
    restoreClock();
    restoreClock = null;
    recovery.close();
    recovery = null;
    const { observeRailgunOwnReceipt } = require('../src/main/wallet/railgun-own-receipt');
    const observe = async (captured) =>
      observeRailgunOwnReceipt({ enrollment, capture: captured, signal: enrollment.signal });
    const checkedObservation = async (archived) => {
      const beforeJournal = await journal.readSnapshot();
      const beforeCapture = await capture();
      assert.equal(beforeCapture.status, 'captured');
      const beforeMethods = { ...methods };
      const result = await observe(beforeCapture.capture);
      assert.equal(result.status, 'observed');
      const observation = result.observation;
      assert.equal(observation.captureBindingDigest, beforeCapture.capture.bindingDigest);
      assert.equal(observation.capturedRepresentation, archived ? 'archived' : 'active');
      assert.equal(observation.receiptMatched, true);
      assert.equal(observation.rpcConsistencyObserved, true);
      assert.deepEqual(observation.transaction, fixture.transaction);
      assert.deepEqual(observation.receipt, fixture.receipt);
      assert.equal(methods.eth_getTransactionByHash - beforeMethods.eth_getTransactionByHash, 1);
      assert.equal(methods.eth_getTransactionReceipt - beforeMethods.eth_getTransactionReceipt, 1);
      assert.equal(
        methods.eth_getBlockByNumber - beforeMethods.eth_getBlockByNumber,
        archived ? 12 : 11
      );
      assert.equal(methods.eth_blockNumber - beforeMethods.eth_blockNumber, 2);
      for (const flag of [
        'accountAuthenticated',
        'sourceAuthenticated',
        'currentCanonicalityVerified',
        'finalityVerified',
        'txidPathVerified',
        'txidRootAccepted',
        'poiVerified',
        'spendingEnabled',
      ])
        assert.equal(observation[flag], false);
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      const afterCapture = await capture();
      assert.equal(afterCapture.status, 'captured');
      assert.deepEqual(afterCapture.capture, beforeCapture.capture);
      return { capture: afterCapture.capture, observation };
    };
    phase = 'active-observation';
    const active = await checkedObservation(false);
    runs.push({
      mode: phase,
      receiptMatched: true,
      rpcConsistencyObserved: true,
      requests: 15,
      journalUnchanged: true,
      recaptureEqual: true,
      authority: false,
    });
    phase = 'archive';
    const ready = (await journal.list())[0];
    await journal.archiveResolved(
      [{ hash: ready.hash, revision: ready.revision }],
      [{ blockNumber: 310, blockHash: blockHash(310) }]
    );
    finalizedHeight = 310;
    const archived = await checkedObservation(true);
    assert.equal(archived.capture.bindingDigest, active.capture.bindingDigest);
    assert.deepEqual(
      archived.observation.anchorsActuallyChecked.map((a) => a.kind),
      ['inclusion', 'resolution', 'archive', 'inclusion-repeat']
    );
    runs.push({
      mode: 'archived-observation',
      bothStoredAnchorsChecked: true,
      requests: 16,
      journalUnchanged: true,
      recaptureEqual: true,
    });
    phase = 'reopen';
    enrollment.close();
    enrollment = await openRailgunAccountEnrollment({ identity });
    journal = openJournal();
    const restored = await checkedObservation(true);
    assert.deepEqual(restored.capture, archived.capture);
    runs.push({ mode: 'enrollment-reopen', identicalCapture: true, freshObservation: true });
    for (const [mode, number, expectedStage] of [
      ['inclusion-reorg', 291, 'inclusion'],
      ['resolution-anchor-reorg', 300, 'finality-before'],
      ['archive-anchor-reorg', 310, 'archive-anchor'],
    ]) {
      phase = mode;
      const beforeJournal = await journal.readSnapshot();
      wrongHeader = number;
      const result = await observe(restored.capture);
      wrongHeader = null;
      assert.equal(result.status, 'refused');
      assert.equal(result.stage, expectedStage);
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      await checkedObservation(true);
      runs.push({
        mode,
        refused: true,
        journalUnchanged: true,
        followingObservationSucceeded: true,
      });
    }
    phase = 'unresolved-sibling';
    await journal.begin(hex(101), 4);
    assert.deepEqual(await capture(), { status: 'refused', stage: 'journal' });
    runs.push({ mode: phase, captureRefused: true });
    assert.equal(externalAttempts, 0);
    assert.equal(unexpectedRpc, 0);
    assert.deepEqual(hashes(), before);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          kind,
          sourceSha256: before,
          runs,
          rpcMethods: methods,
          externalAttempts,
          unexpectedRpc,
          genuineEnrollmentAndEncryptedStores: true,
          genuineResolutionPermit: true,
          chainObservationsSimulated: true,
          structuralProofAndSignature: true,
          sourceAuthenticated: false,
          finalityVerified: false,
          poiVerified: false,
          liveQueries: 0,
          submissions: 0,
          spendingEnabled: false,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(JSON.stringify({ report: path.join(directory, 'report.json') }));
  } finally {
    restoreClock?.();
    recovery?.close();
    journalScope?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    rpcModule.createPrivateRpc = originalRpc;
    transport.createWalletTorTransport = originalTransport;
  }
}
main().then(
  () => {
    releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    console.error(JSON.stringify({ phase, code: error?.code }));
    releaseProfileLock(lock);
    app.exit(1);
  }
);
