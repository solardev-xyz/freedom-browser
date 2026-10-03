/** Actual disposable enrollment, encrypted source/public stores and coordinator.
 * All RPC and transaction history are synthetic; no owned live note is queried.
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
const { SHIELD_EVENT } = require('../src/main/wallet/railgun-shield-receipt');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const blockHash = (n) => hex(n === -1 ? 0 : n === 291 ? 200 : n + 1000);
let lock,
  phase = 'setup';
const sources = [
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
  const fixture = sample(kind === 'unshield');
  if (kind === 'transfer') {
    const abi = new Interface(PRIVATE_EVENTS);
    const args = abi.decodeEventLog(
      'Transact',
      fixture.receipt.logs[1].data,
      fixture.receipt.logs[1].topics
    );
    Object.assign(
      fixture.receipt.logs[1],
      abi.encodeEventLog('Transact', [0, 1, [...args.hash], args.ciphertext])
    );
    fixture.record.resolution.railgun.transact = inspectRailgunTransactReceipt(
      fixture.record,
      fixture.transaction,
      fixture.receipt
    );
  }
  assert.equal(
    inspectRailgunTransactReceipt(fixture.record, fixture.transaction, fixture.receipt).status,
    'matched'
  );
  // Establish the spent tree with an earlier, separate public commitment.
  // These event bytes are structural fixtures, not decryptable wallet notes.
  const shieldAbi = new Interface([SHIELD_EVENT]);
  const priorShield = {
    ...shieldAbi.encodeEventLog('Shield', [
      0,
      0,
      [[hex(700), [0, require('../src/main/wallet/railgun-shield-pins.json').wrappedNative, 0], 1000]],
      [[[hex(701), hex(702), hex(703)], hex(704)]],
      [0],
    ]),
    address: fixture.receipt.to,
    transactionHash: hex(705),
    blockHash: blockHash(290),
    blockNumber: '0x122',
    transactionIndex: '0x0',
    logIndex: '0x0',
    removed: false,
  };
  const history = [priorShield, ...fixture.receipt.logs];
  const { getPrivacyContext } = require('../src/main/networks/privacy-context');
  const transport = require('../src/main/networks/wallet-tor-transport');
  const originalTransport = transport.createWalletTorTransport;
  let externalAttempts = 0,
    unexpectedRpc = 0,
    visited = 0,
    failAfterVisit = false,
    injected = 0,
    cancelDuringVisit = null,
    cancelledVisits = 0;
  const methods = {};
  transport.createWalletTorTransport = () => {
    externalAttempts++;
    throw Error('External transport forbidden');
  };
  const rpcModule = require('../src/main/networks/private-rpc'),
    originalRpc = rpcModule.createPrivateRpc;
  rpcModule.createPrivateRpc = (handle, role, { signal }) => {
    const context = getPrivacyContext(handle);
    assert.equal(role, 'protocol-rpc');
    assert.equal(context.subject.chainId, 11155111);
    const lifetime = AbortSignal.any([signal, context.signal]);
    const active = () => {
      getPrivacyContext(handle);
      assert.equal(lifetime.aborted, false);
    };
    return {
      signal: lifetime,
      trust: { queried: ['synthetic-source.invalid'] },
      release() {},
      assertActive: active,
      request: async (method, params, validate) => {
        methods[method] = (methods[method] ?? 0) + 1;
        if (!['eth_getLogs', 'eth_getBlockByNumber'].includes(method)) {
          unexpectedRpc++;
          throw Error('Forbidden RPC');
        }
        active();
        let result;
        if (method === 'eth_getLogs') {
          const filter = params[0];
          assert.equal(filter.address, fixture.receipt.to);
          result = history.filter(
            (log) =>
              BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
              BigInt(log.blockNumber) <= BigInt(filter.toBlock)
          );
        } else {
          assert.equal(params[1], false);
          const n = params[0] === 'finalized' ? 310 : Number(BigInt(params[0]));
          assert.ok(Number.isSafeInteger(n) && n >= 0 && n <= 310);
          result = {
            number: '0x' + n.toString(16),
            hash: blockHash(n),
            parentHash: blockHash(n - 1),
          };
        }
        assert.equal(validate(result), true);
        return { result };
      },
    };
  };
  const ledgerModule = require('../src/main/wallet/railgun-source-ledger'),
    originalLedger = ledgerModule.createRailgunSourceLedger;
  ledgerModule.createRailgunSourceLedger = async (options) => {
    const ledger = await originalLedger(options);
    return Object.freeze({
      ...ledger,
      async visitThrough(digest, visitor) {
        const result = await ledger.visitThrough(digest, async (log) => {
          if (cancelDuringVisit) {
            cancelDuringVisit.abort();
            cancelDuringVisit = null;
            cancelledVisits++;
          }
          await visitor(log);
        });
        visited++;
        if (failAfterVisit) {
          failAfterVisit = false;
          injected++;
          throw Error('Injected failure after authentic source visit');
        }
        return result;
      },
    });
  };
  const vault = require('../src/main/identity/vault');
  let identity, enrollment, publicAccount, captured;
  const { openRailgunIdentity } = require('../src/main/wallet/railgun-identity');
  const { openRailgunAccountEnrollment } = require('../src/main/wallet/railgun-account-enrollment');
  const { openRailgunAccountPublic } = require('../src/main/wallet/railgun-account-public');
  const {
    captureRailgunOwnSource,
    assertRailgunOwnSource,
  } = require('../src/main/wallet/railgun-own-source-capture');
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
    phase = 'public-advance';
    publicAccount = await openRailgunAccountPublic({ enrollment, archive, create: true });
    await publicAccount.advance({ to: 300, anchor: { number: 310, hash: blockHash(310) } });
    const capture = (overrides = {}) =>
      captureRailgunOwnSource({
        enrollment,
        coordinator: publicAccount.coordinator,
        record: fixture.record,
        transaction: fixture.transaction,
        receipt: fixture.receipt,
        signal: enrollment.signal,
        ...overrides,
      });
    phase = 'capture';
    captured = await capture();
    const observation = assertRailgunOwnSource(
      captured.receipt,
      enrollment,
      publicAccount.coordinator
    );
    assert.equal(observation.sourceAuthenticated, true);
    assert.equal(observation.receiptStatusAuthenticated, false);
    assert.equal(observation.accountAuthenticated, false);
    assert.equal(observation.currentFinalityVerified, false);
    assert.equal(observation.spendingEnabled, false);
    assert.equal(observation.logs.length, 2);
    assert.equal(observation.transactionHash, fixture.record.hash);
    runs.push({
      mode: 'actual-enrolled-capture',
      sourceAuthenticated: true,
      receiptStatusAuthenticated: false,
      accountAuthenticated: false,
      currentFinalityVerified: false,
      spendingEnabled: false,
      checkpointHash: observation.checkpointHash,
      logsSha256: observation.logsSha256,
    });
    assert.throws(() => assertRailgunOwnSource({}, enrollment, publicAccount.coordinator));
    await publicAccount.coordinator.withPublicSnapshot(() => undefined);
    assert.throws(() =>
      assertRailgunOwnSource(captured.receipt, enrollment, publicAccount.coordinator)
    );
    captured.close();
    captured = null;
    runs.push({ mode: 'later-snapshot', oldReceiptRefused: true });
    phase = 'semantic-refusal';
    const changed = structuredClone(fixture);
    changed.transaction.transactionIndex = changed.receipt.transactionIndex = '0x5';
    changed.receipt.logs.forEach((log) => {
      log.transactionIndex = '0x5';
    });
    const beforeMismatch = visited;
    await assert.rejects(capture({ transaction: changed.transaction, receipt: changed.receipt }), {
      code: 'RAILGUN_OWN_SOURCE_CAPTURE_REFUSED',
    });
    assert.equal(visited, beforeMismatch + 1);
    assert.equal(publicAccount.coordinator.signal.aborted, false);
    captured = await capture();
    assert.equal(
      assertRailgunOwnSource(captured.receipt, enrollment, publicAccount.coordinator)
        .sourceAuthenticated,
      true
    );
    captured.close();
    captured = null;
    runs.push({
      mode: 'semantic-refusal',
      authenticatedVisitCompleted: true,
      coordinatorSurvived: true,
      followingCaptureSucceeded: true,
    });
    phase = 'capture-cancellation';
    const cancellation = new AbortController();
    const beforeCancellation = visited;
    cancelDuringVisit = cancellation;
    await assert.rejects(capture({ signal: cancellation.signal }), {
      code: 'RAILGUN_OWN_SOURCE_CAPTURE_REFUSED',
    });
    assert.equal(cancelledVisits, 1);
    assert.equal(visited, beforeCancellation + 1);
    assert.equal(publicAccount.coordinator.signal.aborted, false);
    captured = await capture();
    assert.equal(
      assertRailgunOwnSource(captured.receipt, enrollment, publicAccount.coordinator)
        .sourceAuthenticated,
      true
    );
    captured.close();
    captured = null;
    runs.push({
      mode: 'capture-cancellation',
      authenticatedVisitCompleted: true,
      coordinatorSurvived: true,
      followingCaptureSucceeded: true,
    });
    phase = 'late-failure';
    const oldVisited = visited;
    failAfterVisit = true;
    await assert.rejects(capture(), { code: 'RAILGUN_OWN_SOURCE_CAPTURE_REFUSED' });
    assert.equal(injected, 1);
    assert.equal(visited, oldVisited + 1);
    assert.equal(publicAccount.coordinator.signal.aborted, true);
    runs.push({
      mode: 'post-visit-failure',
      authenticatedVisitCompleted: true,
      captureRefused: true,
      coordinatorClosed: true,
    });
    await publicAccount.close();
    publicAccount = null;
    phase = 'cold-reopen';
    publicAccount = await openRailgunAccountPublic({ enrollment, archive });
    captured = await capture();
    const restored = assertRailgunOwnSource(
      captured.receipt,
      enrollment,
      publicAccount.coordinator
    );
    assert.equal(restored.checkpointHash, observation.checkpointHash);
    assert.equal(restored.logsSha256, observation.logsSha256);
    assert.equal(restored.sourceAuthenticated, true);
    assert.equal(restored.receiptStatusAuthenticated, false);
    assert.equal(restored.accountAuthenticated, false);
    assert.equal(restored.currentFinalityVerified, false);
    assert.equal(restored.spendingEnabled, false);
    runs.push({ mode: 'public-store-reopen', exactCheckpointAndGroup: true });
    captured.close();
    captured = null;
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
          sourceVisits: visited,
          injectedPostVisitFailures: injected,
          cancelledVisits,
          externalAttempts,
          unexpectedRpc,
          actualEnrolledCoordinator: true,
          encryptedStores: true,
          publicHistoryAndRpcSimulated: true,
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
    captured?.close();
    await publicAccount?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    rpcModule.createPrivateRpc = originalRpc;
    transport.createWalletTorTransport = originalTransport;
    ledgerModule.createRailgunSourceLedger = originalLedger;
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
