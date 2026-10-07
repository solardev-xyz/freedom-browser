/** Actual disposable enrollment, encrypted source/public stores and coordinator.
 * Real private RPC uses simulated transport/registry/Tor and synthetic history.
 * No owned live note is queried; destination binding is not consent.
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
  'src/main/wallet/railgun-account-fence.js',
  'src/main/wallet/railgun-account-phase.js',
  'src/main/wallet/railgun-private-reservations.js',
  'src/main/wallet/railgun-private-witness.js',
  'scripts/fixtures/railgun-enrolled-operation.js',
  'scripts/fixtures/railgun-enrolled-signing.js',
  'scripts/fixtures/railgun-enrolled-submission.js',
  'src/main/wallet/railgun-private-submission.js',
  'src/main/wallet/railgun-recovered-review-budget.json',
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
  'src/main/wallet/railgun-private-destination.js',
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
  'src/main/wallet/railgun-kohaku-read-data.js',
  ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
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
  'src/main/networks/wallet-tor-transport.js',
  'src/main/networks/network-registry.js',
  'src/main/settings-store.js',
  'src/main/swarm/ant-cache.js',
  'src/main/tor-manager.js',
  'src/main/wallet/railgun-shield-receipt.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
async function main() {
  const [directory, archive, kind] = process.argv.slice(2);
  // Keep the watchdog referenced so a lost drain promise fails qualification.
  setTimeout(() => {
    console.error(JSON.stringify({ phase, code: 'QUALIFICATION_TIMEOUT' }));
    app.exit(1);
  }, 90000);
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
      [
        [
          hex(700),
          [0, require('../src/main/wallet/railgun-shield-pins.json').wrappedNative, 0],
          1000,
        ],
      ],
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
    cancelledVisits = 0,
    visitedLogs = 0;
  const methods = {};
  const registry = require('../src/main/networks/network-registry');
  const settings = require('../src/main/settings-store');
  const tor = require('../src/main/tor-manager');
  const originalRegistry = {
    getNetwork: registry.getNetwork,
    getEndpoints: registry.getEndpoints,
    getEndpointSources: registry.getEndpointSources,
  };
  const originalAvailable = settings.isWalletTorExperimentAvailable;
  const originalEndpoint = tor.getWalletSocksEndpoint;
  const endpoints = [new AbortController(), new AbortController()];
  let endpoint = { signal: endpoints[0].signal };
  const destinations = ['https://rpc.example.test/source-a', 'https://rpc.example.test/source-b'];
  let selectedDestination = destinations[0],
    expectedDestination = destinations[0],
    factoryCalls = 0;
  const destinationCalls = [0, 0];
  settings.isWalletTorExperimentAvailable = () => true;
  tor.getWalletSocksEndpoint = () => endpoint;
  registry.getNetwork = (chain) => {
    assert.equal(chain, 11155111);
    return { access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } };
  };
  registry.getEndpoints = (chain, role) => {
    assert.equal(chain, 11155111);
    assert.equal(role, 'rpc');
    return [selectedDestination];
  };
  registry.getEndpointSources = () => [
    { keyed: false, coverage: { 11155111: selectedDestination } },
  ];
  for (const name of [
    '../src/main/networks/private-rpc',
    '../src/main/wallet/railgun-scan-source',
    '../src/main/wallet/railgun-scan-journal',
    '../src/main/wallet/railgun-scan-coordinator',
    '../src/main/wallet/railgun-account-public',
  ])
    assert.equal(require.cache[require.resolve(name)], undefined);
  transport.createWalletTorTransport = () => ({
    release() {},
    close() {},
    async request(handle, url, options) {
      const context = getPrivacyContext(handle);
      assert.equal(context.subject.role, 'protocol-rpc');
      assert.equal(context.subject.chainId, 11155111);
      const index = destinations.indexOf(url);
      if (index < 0) {
        externalAttempts++;
        throw Error('External transport forbidden');
      }
      assert.equal(url, expectedDestination);
      destinationCalls[index]++;
      const { id, method, params } = JSON.parse(options.body);
      methods[method] = (methods[method] ?? 0) + 1;
      if (!['eth_chainId', 'eth_getLogs', 'eth_getBlockByNumber'].includes(method)) {
        unexpectedRpc++;
        throw Error('Forbidden RPC');
      }
      let result;
      if (method === 'eth_chainId') {
        assert.deepEqual(params, []);
        result = '0xaa36a7';
      } else if (method === 'eth_getLogs') {
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
      return { status: 200, body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result })) };
    },
  });
  const rpcModule = require('../src/main/networks/private-rpc'),
    originalRpc = rpcModule.createPrivateRpc;
  rpcModule.createPrivateRpc = (...args) => {
    factoryCalls++;
    return originalRpc(...args);
  };
  const ledgerModule = require('../src/main/wallet/railgun-source-ledger'),
    originalLedger = ledgerModule.createRailgunSourceLedger;
  const completedWork = {
    stages: 0,
    retains: 0,
    beforeAcquire: 0,
    applies: 0,
    planners: 0,
    plannerSettlements: 0,
    prefixChecks: 0,
  };
  const sourceModule = require('../src/main/wallet/railgun-scan-source'),
    originalSource = sourceModule.createRailgunScanSource;
  let retainedSource, retainedSourceHandle;
  sourceModule.createRailgunScanSource = (options) => {
    retainedSourceHandle = options.handle;
    retainedSource = originalSource({
      ...options,
      projectRange: async (...args) => {
        completedWork.planners++;
        try {
          return await options.projectRange(...args);
        } finally {
          completedWork.plannerSettlements++;
        }
      },
      beforeAcquire: async (...args) => {
        completedWork.beforeAcquire++;
        return options.beforeAcquire?.(...args);
      },
    });
    return retainedSource;
  };
  const journalModule = require('../src/main/wallet/railgun-scan-journal'),
    originalJournal = journalModule.createRailgunScanJournal;
  let retainedJournal;
  journalModule.createRailgunScanJournal = async (options) => {
    retainedJournal = await originalJournal(options);
    return retainedJournal;
  };
  const coordinatorModule = require('../src/main/wallet/railgun-scan-coordinator'),
    originalCoordinator = coordinatorModule.createRailgunScanCoordinator;
  coordinatorModule.createRailgunScanCoordinator = (options) =>
    originalCoordinator({
      ...options,
      applyRange: (...args) => {
        completedWork.applies++;
        return options.applyRange(...args);
      },
    });
  ledgerModule.createRailgunSourceLedger = async (options) => {
    const ledger = await originalLedger(options);
    return Object.freeze({
      ...ledger,
      stage(...args) {
        completedWork.stages++;
        return ledger.stage(...args);
      },
      retain(...args) {
        completedWork.retains++;
        return ledger.retain(...args);
      },
      hasPrefix(...args) {
        completedWork.prefixChecks++;
        return ledger.hasPrefix(...args);
      },
      async visitThrough(digest, visitor) {
        const result = await ledger.visitThrough(digest, async (log) => {
          visitedLogs++;
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
  const {
    openRailgunAccountPublic,
    getRailgunAccountPublicDestination,
    assertRailgunAccountPublicDestination,
  } = require('../src/main/wallet/railgun-account-public');
  const {
    captureRailgunOwnSource,
    assertRailgunOwnSource,
  } = require('../src/main/wallet/railgun-own-source-capture');
  const runs = [],
    destinationRuns = [],
    completedRuns = [];
  const totalRequests = () => Object.values(methods).reduce((a, b) => a + b, 0);
  const preview = () => {
    const beforeRequests = totalRequests(),
      beforeFactories = factoryCalls,
      beforeVisits = visited;
    const observation = getRailgunAccountPublicDestination(publicAccount.coordinator, enrollment);
    assert.equal(
      assertRailgunAccountPublicDestination(publicAccount.coordinator, enrollment, observation),
      observation
    );
    assert.equal(rpcModule.getPrivateRpcDestinationDetails(observation).url, expectedDestination);
    assert.equal(JSON.stringify(observation), '{}');
    assert.throws(() =>
      assertRailgunAccountPublicDestination(publicAccount.coordinator, enrollment, {
        ...observation,
      })
    );
    assert.throws(() =>
      getRailgunAccountPublicDestination(publicAccount.coordinator, { ...enrollment })
    );
    assert.throws(() =>
      getRailgunAccountPublicDestination({ ...publicAccount.coordinator }, enrollment)
    );
    assert.throws(() =>
      getRailgunAccountPublicDestination(publicAccount.coordinator, enrollment, '0'.repeat(64))
    );
    assert.equal(totalRequests(), beforeRequests);
    assert.equal(factoryCalls, beforeFactories);
    assert.equal(visited, beforeVisits);
    assert.equal(publicAccount.coordinator.signal.aborted, false);
    return observation;
  };
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
    const beforeCandidate = totalRequests();
    assert.throws(() => getRailgunAccountPublicDestination(publicAccount.coordinator, enrollment));
    assert.equal(totalRequests(), beforeCandidate);
    phase = 'completed-empty-checkpoint';
    const beforeEmpty = { ...completedWork },
      beforeEmptyJournal = await retainedJournal.readState();
    let emptyOutcome;
    await assert.rejects(
      publicAccount.coordinator.withCompletedPublicSnapshot(
        {
          destination: sourceModule.getRailgunScanSourceDestination(
            retainedSource,
            retainedSourceHandle
          ),
          signal: new AbortController().signal,
          timeoutMs: 30000,
        },
        () => assert.fail('Empty checkpoint admitted callback')
      ),
      (error) => {
        emptyOutcome = coordinatorModule.getRailgunCompletedSnapshotOutcome(
          publicAccount.coordinator,
          error
        );
        return true;
      }
    );
    assert.deepEqual(emptyOutcome, {
      fatal: false,
      reason: 'checkpoint-unavailable',
      rpcFailure: null,
    });
    assert.deepEqual(completedWork, beforeEmpty);
    assert.deepEqual(await retainedJournal.readState(), beforeEmptyJournal);
    assert.equal(totalRequests(), beforeCandidate);
    assert.equal(publicAccount.coordinator.signal.aborted, false);
    completedRuns.push({
      mode: phase,
      outcome: emptyOutcome,
      requests: 0,
      sourceAndApplyWork: 0,
      journalUnchanged: true,
      coordinatorSurvived: true,
    });
    phase = 'public-advance';
    await publicAccount.advance({ to: 300, anchor: { number: 310, hash: blockHash(310) } });
    const retainedDestination = preview();
    selectedDestination = destinations[1];
    assert.equal(preview(), retainedDestination);
    destinationRuns.push({
      mode: 'active-retained-destination',
      preparationRequests: 0,
      copiedOwnerAndObservationRefused: true,
      changedPolicyRefused: true,
      registryNotSubstituted: true,
    });
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
    assert.throws(() => rpcModule.getPrivateRpcDestinationDetails(retainedDestination));
    phase = 'cold-reopen';
    selectedDestination = expectedDestination = destinations[1];
    const beforeReopenRequests = totalRequests();
    publicAccount = await openRailgunAccountPublic({ enrollment, archive });
    const coldDestination = preview();
    assert.notEqual(coldDestination, retainedDestination);
    assert.equal(totalRequests(), beforeReopenRequests);
    assert.throws(() =>
      assertRailgunAccountPublicDestination(
        publicAccount.coordinator,
        enrollment,
        retainedDestination
      )
    );
    destinationRuns.push({
      mode: 'cold-before-recovery',
      preparationRequests: 0,
      previousDestinationRefused: true,
      distinctClient: true,
    });
    const completed = (caller, run) =>
      publicAccount.coordinator.withCompletedPublicSnapshot(
        {
          destination: coldDestination,
          signal: caller.signal,
          timeoutMs: 30000,
        },
        run
      );
    const refused = async (promise, reason, fatal = false) => {
      let rejection;
      await assert.rejects(promise, (error) => {
        rejection = error;
        return true;
      });
      const owner = publicAccount.coordinator;
      const outcome = coordinatorModule.getRailgunCompletedSnapshotOutcome(owner, rejection);
      assert.deepEqual(outcome, { fatal, reason, rpcFailure: null });
      assert.equal(Object.isFrozen(outcome), true);
      for (const error of [{ ...rejection }, Error('Unknown'), { code: rejection.code }])
        assert.throws(() => coordinatorModule.getRailgunCompletedSnapshotOutcome(owner, error));
      assert.throws(() =>
        coordinatorModule.getRailgunCompletedSnapshotOutcome({ ...owner }, rejection)
      );
      return { rejection, outcome };
    };
    const workSnapshot = () => ({
      ...completedWork,
      methods: { ...methods },
      visited,
      visitedLogs,
    });
    const workDelta = (beforeWork) => {
      const delta = Object.fromEntries(
        Object.keys(completedWork).map((key) => [key, completedWork[key] - beforeWork[key]])
      );
      for (const key of ['stages', 'retains', 'beforeAcquire', 'applies'])
        assert.equal(delta[key], 0);
      return {
        ...delta,
        visits: visited - beforeWork.visited,
        logsVisited: visitedLogs - beforeWork.visitedLogs,
        rpcMethods: Object.fromEntries(
          Object.keys(methods).map((key) => [key, methods[key] - (beforeWork.methods[key] || 0)])
        ),
      };
    };
    let canonicalCount;
    const eventBlocks = new Set(history.map((log) => log.blockNumber)).size;
    const completedSuccess = async (visit, first = false) => {
      const beforeWork = workSnapshot();
      const beforeJournal = await retainedJournal.readState();
      let delivered = 0;
      const result = await completed(new AbortController(), async (window) => {
        canonicalCount =
          1 +
          new Set([
            window.checkpoint.anchor.number,
            window.checkpoint.from,
            window.checkpoint.to.number,
            ...(window.checkpoint.from ? [window.checkpoint.from - 1] : []),
          ]).size;
        if (visit)
          await window.visitSource(async () => {
            delivered++;
          });
        return delivered;
      });
      const checkpoint = publicAccount.coordinator.assertSnapshot(result.evidence);
      assert.deepEqual(await retainedJournal.readState(), beforeJournal);
      assert.deepEqual(checkpoint, beforeJournal.checkpoint);
      assert.equal(
        require('../src/main/wallet/railgun-wallet-coverage').checkpointHash(checkpoint),
        observation.checkpointHash
      );
      assert.equal(result.value, visit ? history.length : 0);
      const work = workDelta(beforeWork);
      assert.equal(work.planners, 1);
      assert.equal(work.plannerSettlements, 1);
      assert.equal(work.prefixChecks, 1);
      assert.equal(work.visits, visit ? 2 : 1);
      assert.equal(work.logsVisited, history.length * (visit ? 2 : 1));
      assert.equal(work.rpcMethods.eth_chainId, first ? 1 : 0);
      assert.equal(work.rpcMethods.eth_getBlockByNumber, canonicalCount * 4 + eventBlocks);
      assert.equal(work.rpcMethods.eth_getLogs, 1);
      completedRuns.push({
        mode: first ? 'completed-cold' : visit ? 'completed-reuse' : 'completed-no-visit',
        work,
        callbackLogs: delivered,
        snapshotAccepted: true,
        journalAndProviderProvenanceUnchanged: true,
      });
      return result;
    };
    phase = 'completed-cold';
    await completedSuccess(true, true);
    phase = 'completed-no-visit';
    await completedSuccess(false);
    phase = 'completed-preabort';
    {
      const caller = new AbortController(),
        beforeWork = workSnapshot();
      caller.abort();
      const { outcome } = await refused(
        completed(caller, () => assert.fail('Preaborted callback ran')),
        'cancelled'
      );
      const work = workDelta(beforeWork);
      assert.equal(work.planners, 0);
      assert.ok(Object.values(work.rpcMethods).every((count) => count === 0));
      assert.equal(publicAccount.coordinator.signal.aborted, false);
      completedRuns.push({ mode: phase, work, outcome, coordinatorSurvived: true });
    }
    phase = 'completed-copied-destination';
    {
      const beforeWork = workSnapshot();
      const { outcome } = await refused(
        publicAccount.coordinator.withCompletedPublicSnapshot(
          {
            destination: { ...coldDestination },
            signal: new AbortController().signal,
            timeoutMs: 30000,
          },
          () => assert.fail('Copied destination admitted callback')
        ),
        'destination-mismatch'
      );
      const work = workDelta(beforeWork);
      assert.equal(work.planners, 0);
      assert.ok(Object.values(work.rpcMethods).every((count) => count === 0));
      assert.equal(publicAccount.coordinator.signal.aborted, false);
      completedRuns.push({
        mode: 'completed-copied-destination',
        work,
        outcome,
        coordinatorSurvived: true,
      });
    }
    phase = 'completed-planner-cancellation';
    {
      const caller = new AbortController(),
        beforeWork = workSnapshot();
      cancelDuringVisit = caller;
      const { outcome } = await refused(
        completed(caller, () => assert.fail('Cancelled planner admitted callback')),
        'cancelled'
      );
      const work = workDelta(beforeWork);
      assert.equal(work.planners, 1);
      assert.equal(work.plannerSettlements, 1);
      assert.equal(work.visits, 1);
      assert.equal(work.logsVisited, history.length);
      assert.equal(publicAccount.coordinator.signal.aborted, false);
      completedRuns.push({
        mode: phase,
        work,
        fullPlannerPrefixDelivered: true,
        outcome,
        coordinatorSurvived: true,
      });
    }
    phase = 'completed-callback-cancellation';
    {
      const caller = new AbortController(),
        beforeWork = workSnapshot();
      let entered, release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const firstLog = new Promise((resolve) => {
        entered = resolve;
      });
      let delivered = 0,
        settled = false,
        outcome;
      const rejected = refused(
        completed(caller, async (window) => {
          await window.visitSource(async () => {
            delivered++;
            caller.abort();
            entered();
            await gate;
          });
        }),
        'cancelled'
      ).then((result) => {
        outcome = result.outcome;
        settled = true;
      });
      try {
        await firstLog;
        await new Promise(setImmediate);
        assert.equal(settled, false);
        const beforeBusy = totalRequests();
        await refused(
          completed(new AbortController(), () => undefined),
          'busy'
        );
        assert.equal(totalRequests(), beforeBusy);
        assert.equal(publicAccount.coordinator.signal.aborted, false);
      } finally {
        release();
      }
      await rejected;
      const work = workDelta(beforeWork);
      assert.equal(delivered, 1);
      assert.equal(work.visits, 2);
      assert.equal(work.logsVisited, history.length * 2);
      assert.equal(publicAccount.coordinator.signal.aborted, false);
      completedRuns.push({
        mode: phase,
        work,
        callbackLogs: delivered,
        exclusionHeldThroughVisitor: true,
        fullPrefixAuthenticated: true,
        outcome,
        coordinatorSurvived: true,
      });
    }
    phase = 'completed-following-success';
    await completedSuccess(true);
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
    phase = 'completed-caught-broker-failure';
    {
      const beforeWork = workSnapshot();
      let caught = false;
      const { rejection, outcome } = await refused(
        completed(new AbortController(), async (window) => {
          await assert.rejects(
            window.dispatch(JSON.stringify({ id: 999, method: 'get', args: [] }))
          );
          caught = true;
          return 'consumer caught broker failure';
        }),
        'fatal',
        true
      );
      assert.equal(caught, true);
      assert.equal(publicAccount.coordinator.signal.aborted, true);
      completedRuns.push({
        mode: phase,
        work: workDelta(beforeWork),
        caughtFailureStayedFatal: true,
        outcome,
        coordinatorClosed: true,
      });
      await publicAccount.close();
      publicAccount = null;
      const beforeRequests = totalRequests();
      selectedDestination = expectedDestination = 'https://different-rpc.example.test/source-c';
      publicAccount = await openRailgunAccountPublic({ enrollment, archive });
      assert.equal(totalRequests(), beforeRequests);
      assert.throws(() =>
        coordinatorModule.getRailgunCompletedSnapshotOutcome(publicAccount.coordinator, rejection)
      );
    }
    phase = 'completed-provider-mismatch';
    {
      const destination = preview(),
        beforeWork = workSnapshot(),
        beforeJournal = await retainedJournal.readState();
      const { outcome } = await refused(
        publicAccount.coordinator.withCompletedPublicSnapshot(
          { destination, signal: new AbortController().signal, timeoutMs: 30000 },
          () => assert.fail('Changed provider admitted callback')
        ),
        'provider-mismatch'
      );
      const work = workDelta(beforeWork);
      assert.equal(work.planners, 0);
      assert.equal(work.prefixChecks, 0);
      assert.ok(Object.values(work.rpcMethods).every((count) => count === 0));
      assert.equal(publicAccount.coordinator.signal.aborted, false);
      assert.deepEqual(await retainedJournal.readState(), beforeJournal);
      completedRuns.push({
        mode: phase,
        work,
        outcome,
        journalAndProviderProvenanceUnchanged: true,
        coordinatorSurvived: true,
      });
      await publicAccount.close();
      publicAccount = null;
      selectedDestination = expectedDestination = destinations[1];
      const beforeRequests = totalRequests();
      publicAccount = await openRailgunAccountPublic({ enrollment, archive });
      assert.equal(totalRequests(), beforeRequests);
    }
    const torDestination = preview();
    phase = 'destination-tor-generation';
    const beforeTor = totalRequests(),
      beforeTorFactories = factoryCalls;
    endpoint = { signal: endpoints[1].signal };
    assert.throws(() => getRailgunAccountPublicDestination(publicAccount.coordinator, enrollment));
    assert.throws(() => rpcModule.getPrivateRpcDestinationDetails(torDestination));
    assert.equal(totalRequests(), beforeTor);
    assert.equal(factoryCalls, beforeTorFactories);
    destinationRuns.push({ mode: phase, requests: 0, replacementFactories: 0 });
    assert.equal(methods.eth_chainId, 2);
    assert.ok(destinationCalls.every((n) => n > 0));
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
          destinationRuns,
          completedRuns,
          completedWork,
          factoryCalls,
          destinationCalls,
          realPrivateRpcWithSimulatedTransport: true,
          sourceVisits: visited,
          sourceLogsVisited: visitedLogs,
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
    sourceModule.createRailgunScanSource = originalSource;
    coordinatorModule.createRailgunScanCoordinator = originalCoordinator;
    journalModule.createRailgunScanJournal = originalJournal;
    Object.assign(registry, originalRegistry);
    settings.isWalletTorExperimentAvailable = originalAvailable;
    tor.getWalletSocksEndpoint = originalEndpoint;
    for (const controller of endpoints) controller.abort();
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
