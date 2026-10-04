/** Genuine encrypted enrolled Transact-creator preflight with synthetic chain
 * and service transport. Actual current-format self/foreign input encryption;
 * structural spend proof/signature only. No owned-note query or live request.
 * electron script NEW_DIRECTORY ENGINE_ASAR transfer|unshield self|foreign
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
const SHIELD_BLOCK = 5944700,
  CREATOR_BLOCK = SHIELD_BLOCK + 1,
  OWN_BLOCK = SHIELD_BLOCK + 2,
  FINALIZED = SHIELD_BLOCK + 20;
const blockHash = (n) => hex(n === -1 ? 0 : n + 1000);
const tag = (n) => '0x' + n.toString(16);
let lock,
  phase = 'setup';
const sources = [
  'scripts/fixtures/railgun-own-poi-membership-input-job.js',
  'src/main/wallet/railgun-poi-source-capture.js',
  'src/main/wallet/railgun-poi-source-evidence.js',
  'src/main/wallet/railgun-poi-creator.js',
  'src/main/wallet/railgun-note-provenance.js',
  'src/main/wallet/railgun-note-provenance-job.js',
  'src/main/wallet/railgun-poi-reconstruct.js',
  'src/main/wallet/railgun-poi-witness.js',
  'src/main/wallet/railgun-poi-shield-selector-data.js',
  'src/main/wallet/railgun-own-witness.test.js',
  'src/main/wallet/railgun-poi-creator.test.js',
  'src/main/wallet/railgun-poi-source-evidence.test.js',
  'src/main/wallet/railgun-poi-source-capture.test.js',
  'src/main/wallet/railgun-private-creator.test.js',

  'src/main/wallet/railgun-own-receipt.js',
  'src/main/wallet/railgun-own-txid-verifier.js',
  'src/main/wallet/railgun-own-txid-job.js',
  'scripts/fixtures/railgun-own-preflight-job.js',
  'src/main/wallet/railgun-own-selector.js',
  'src/main/wallet/railgun-own-selector-job.js',
  'src/main/wallet/railgun-own-witness.js',
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
  'scripts/qualify-railgun-own-transact-creator.js',
  'src/main/wallet/railgun-poi-records.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
async function main() {
  const [directory, archive, kind, senderKind] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive));
  assert.ok(['transfer', 'unshield'].includes(kind));
  assert.ok(['self', 'foreign'].includes(senderKind));
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
    payload,
    rejectRoot = false,
    rejectValidation = null,
    finalizedOverride = null,
    history;
  const serviceMethods = { latest: 0, validate: 0, page: 0 };
  const methods = {};
  const roleMethods = { 'transaction-rpc': {}, 'protocol-rpc': {} };
  for (const name of [
    '../src/main/networks/private-rpc',
    '../src/main/wallet/private-transaction-network',
    '../src/main/wallet/railgun-own-receipt',
    '../src/main/wallet/railgun-own-witness',
    '../src/main/wallet/railgun-scan-source',
  ])
    assert.equal(require.cache[require.resolve(name)], undefined);
  transport.createWalletTorTransport = () => {
    externalAttempts++;
    throw Error('External transport forbidden');
  };
  const registry = require('../src/main/networks/network-registry');
  const originalRegistry = {
    getNetwork: registry.getNetwork,
    getEndpoints: registry.getEndpoints,
    getEndpointSources: registry.getEndpointSources,
  };
  const rpcUrl = 'https://synthetic.invalid/railgun-creator';
  registry.getNetwork = () => ({ access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } });
  registry.getEndpoints = () => [rpcUrl];
  registry.getEndpointSources = () => [{ keyed: false, coverage: { 11155111: rpcUrl } }];
  const tor = require('../src/main/tor-manager'),
    settings = require('../src/main/settings-store');
  const originalEndpoint = tor.getWalletSocksEndpoint;
  const originalAvailable = settings.isWalletTorExperimentAvailable;
  const endpointController = new AbortController();
  const endpoint = { signal: endpointController.signal };
  tor.getWalletSocksEndpoint = () => endpoint;
  settings.isWalletTorExperimentAvailable = () => true;
  transport.createWalletTorTransport = () => {
    let closed = false;
    return {
      closed: Promise.resolve(),
      release() {},
      close() {
        closed = true;
      },
      async request(handle, url, options) {
        try {
          assert.equal(closed, false);
          const context = getPrivacyContext(handle),
            role = context.subject.role;
          if (url !== rpcUrl || !['transaction-rpc', 'protocol-rpc'].includes(role)) {
            externalAttempts++;
            throw Error('External transport forbidden');
          }
          assert.equal(options.method, 'POST');
          assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
          const wire = JSON.parse(options.body);
          assert.equal(wire.jsonrpc, '2.0');
          assert.equal(typeof wire.id, 'string');
          const { method, params } = wire;
          methods[method] = (methods[method] ?? 0) + 1;
          roleMethods[role][method] = (roleMethods[role][method] ?? 0) + 1;
          if (
            ![
              'eth_chainId',
              'eth_getLogs',
              'eth_getTransactionReceipt',
              'eth_getTransactionByHash',
              'eth_getBlockByNumber',
              'eth_blockNumber',
            ].includes(method)
          ) {
            unexpectedRpc++;
            throw Error('Unexpected RPC');
          }
          let result;
          if (method === 'eth_chainId') {
            assert.deepEqual(params, []);
            result = tag(11155111);
          } else if (method === 'eth_getLogs') {
            assert.equal(role, 'protocol-rpc');
            const filter = params[0];
            result = history.filter(
              (log) =>
                BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
                BigInt(log.blockNumber) <= BigInt(filter.toBlock)
            );
          } else if (method === 'eth_blockNumber') {
            assert.deepEqual(params, []);
            result = tag(FINALIZED);
          } else if (method === 'eth_getBlockByNumber') {
            assert.equal(params[1], false);
            const number =
              params[0] === 'finalized'
                ? role === 'transaction-rpc'
                  ? (finalizedOverride ?? FINALIZED)
                  : FINALIZED
                : Number(BigInt(params[0]));
            assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= FINALIZED);
            result = {
              number: '0x' + number.toString(16),
              hash: blockHash(number),
              parentHash: number === 0 ? hex(0) : blockHash(number - 1),
            };
          } else {
            assert.deepEqual(params, [fixture.transaction.hash]);
            result = method === 'eth_getTransactionReceipt' ? fixture.receipt : fixture.transaction;
          }
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
          };
        } catch (error) {
          const line = error?.stack?.match(/qualify-railgun-own-transact-creator\.js:(\d+):\d+/);
          console.error(
            JSON.stringify({ phase: 'fixture-rpc-admission', line: line ? Number(line[1]) : null })
          );
          throw error;
        }
      },
    };
  };
  const serviceModule = require('../src/main/wallet/railgun-public-services');
  const originalServices = serviceModule.createRailgunPublicServices;
  serviceModule.createRailgunPublicServices = (handle) => {
    const context = getPrivacyContext(handle);
    assert.equal(context.subject.kind, 'service');
    assert.equal(context.subject.principal, 'railgun-public-sync');
    assert.equal(context.subject.role, 'public-services');
    let closed = false;
    const active = () => {
      getPrivacyContext(handle);
      assert.equal(closed, false);
    };
    return {
      signal: context.signal,
      close() {
        closed = true;
      },
      async latestTxid() {
        serviceMethods.latest++;
        active();
        return { index: payload.state.count - 1, root: payload.state.root };
      },
      async validateTxidRoot(point) {
        serviceMethods.validate++;
        active();
        assert.deepEqual(point, {
          tree: 0,
          index: payload.state.count - 1,
          root: payload.state.root,
        });
        return !rejectRoot && serviceMethods.validate !== rejectValidation;
      },
      async txidPage(after) {
        serviceMethods.page++;
        active();
        assert.equal(after, '0x00');
        return { transactions: [payload.creatorRow, payload.row] };
      },
    };
  };
  const processModule = require('../src/main/wallet/railgun-process');
  const originalStart = processModule.startRailgunProcess;
  const jobs = {};
  let jobFault = 'healthy';
  processModule.startRailgunProcess = (options) => {
    const name = path.basename(options.filename);
    const counts = (jobs[name] ||= {
      starts: 0,
      exits: 0,
      keyHandoffs: 0,
      brokerCalls: 0,
      results: 0,
      guardReports: 0,
      elapsedMs: 0,
    });
    counts.starts++;
    counts.keyHandoffs += Number(!!options.binaryKey);
    const corrupt =
      (jobFault === 'creator-path' && name === 'railgun-note-provenance-job.js') ||
      (jobFault === 'own-path' && name === 'railgun-own-txid-job.js');
    if (corrupt) {
      const input = JSON.parse(options.input);
      const witness = jobFault === 'creator-path' ? input.noteWitness.witness : input.witness;
      const original = witness.elements[0];
      witness.elements[0] = (original === '0'.repeat(64) ? '1' : '0').repeat(64);
      options = { ...options, input: JSON.stringify(input) };
    }
    const jobStarted = performance.now();
    const task = originalStart({
      ...options,
      broker: {
        ...options.broker,
        dispatch(wire) {
          counts.brokerCalls++;
          const message = JSON.parse(wire);
          if (message.method === 'result' || message.method === 'job-result') {
            counts.results++;
            const guards = message.value?.guards;
            if (guards) {
              assert.equal(guards.attempts, 0);
              counts.guardReports++;
            }
          }
          return options.broker.dispatch(wire);
        },
      },
    });
    task.closed.then(() => {
      counts.exits++;
      counts.elapsedMs += Math.round(performance.now() - jobStarted);
    });
    return task;
  };
  const sourceMaintenance = { stages: 0, retains: 0, beforeAcquire: 0, applies: 0 };
  const ledgerModule = require('../src/main/wallet/railgun-source-ledger');
  const sourceModule = require('../src/main/wallet/railgun-scan-source');
  const coordinatorModule = require('../src/main/wallet/railgun-scan-coordinator');
  const originals = {
    ledger: ledgerModule.createRailgunSourceLedger,
    source: sourceModule.createRailgunScanSource,
    coordinator: coordinatorModule.createRailgunScanCoordinator,
  };
  ledgerModule.createRailgunSourceLedger = async (options) => {
    const ledger = await originals.ledger(options);
    return Object.freeze({
      ...ledger,
      stage(...args) {
        sourceMaintenance.stages++;
        return ledger.stage(...args);
      },
      retain(...args) {
        sourceMaintenance.retains++;
        return ledger.retain(...args);
      },
    });
  };
  sourceModule.createRailgunScanSource = (options) =>
    originals.source({
      ...options,
      beforeAcquire: async (...args) => {
        sourceMaintenance.beforeAcquire++;
        return options.beforeAcquire?.(...args);
      },
    });
  coordinatorModule.createRailgunScanCoordinator = (options) =>
    originals.coordinator({
      ...options,
      applyRange: (...args) => {
        sourceMaintenance.applies++;
        return options.applyRange(...args);
      },
    });
  let preflightActive = false;
  let sourceReturnedAt;
  const phaseTimings = [];
  const captureEvidence = [];
  const timedRestorations = [];
  const timeCall = (module, name, label) => {
    const original = module[name];
    assert.equal(typeof original, 'function');
    module[name] = async (...args) => {
      if (!preflightActive) return original(...args);
      const started = performance.now();
      let completed = false;
      try {
        const value = await original(...args);
        completed = true;
        if (label === 'source') sourceReturnedAt = performance.now();
        return value;
      } finally {
        phaseTimings.push({
          name: label,
          elapsedMs: Math.round(performance.now() - started),
          completed,
        });
      }
    };
    timedRestorations.push(() => {
      module[name] = original;
    });
  };
  timeCall(
    require('../src/main/wallet/railgun-poi-source-capture'),
    'captureRailgunPoiSourceForTransactMembership',
    'source'
  );
  timeCall(
    require('../src/main/wallet/railgun-account-txid'),
    'openRailgunAccountTxid',
    'mirror-open'
  );
  timeCall(
    require('../src/main/wallet/railgun-own-txid-verifier'),
    'verifyRailgunOwnTxid',
    'own-verifier'
  );
  timeCall(
    require('../src/main/wallet/railgun-note-provenance'),
    'verifyRailgunNoteProvenance',
    'creator-verifier'
  );
  timeCall(
    require('../src/main/wallet/railgun-own-operation'),
    'captureRailgunOwnOperation',
    'recapture'
  );
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
  let identity,
    foreignIdentity,
    enrollment,
    journalScope,
    recovery,
    restoreClock,
    publicAccount,
    txid,
    task;
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
    for (const value of [fixture.transaction, fixture.receipt, ...fixture.receipt.logs]) {
      value.blockNumber = tag(OWN_BLOCK);
      value.blockHash = blockHash(OWN_BLOCK);
    }
    fixture.row.blockNumber = OWN_BLOCK;
    fixture.row.graphID = hex(OWN_BLOCK) + hex(4).slice(2) + hex(0).slice(2);
    const txAbi = new Interface([TRANSACT_ABI]),
      eventAbi = new Interface(PRIVATE_EVENTS);
    const structuralProof = txAbi
      .decodeFunctionData('transact', fixture.transaction.input)[0][0]
      .proof.toArray(true);
    assert.deepEqual(identity.descriptor, enrollment.descriptor);
    const recipient = kind === 'unshield' ? owner : enrollment.descriptor.instanceId;
    if (senderKind === 'foreign')
      foreignIdentity = await openRailgunIdentity({ archive, accountIndex: 1 });
    const creatorRow = {
      version: 'V2',
      blockNumber: CREATOR_BLOCK,
      graphID: hex(CREATOR_BLOCK) + hex(2).slice(2) + hex(0).slice(2),
      txid: hex(706).slice(2),
      timestamp: CREATOR_BLOCK,
    };
    phase = 'fixture-crypto';
    task = processModule.startRailgunProcess({
      handle: enrollment.getContext('engine'),
      filename: require.resolve('./fixtures/railgun-own-poi-membership-input-job'),
      input: JSON.stringify({
        archive,
        row: fixture.row,
        descriptor: enrollment.descriptor,
        kind,
        recipient,
        creatorKind: 'Transact',
        senderKind,
        creatorRow,
        ...(foreignIdentity ? { senderDescriptor: foreignIdentity.descriptor } : {}),
      }),
      lifetimeMs: 60000,
      broker: {
        signal: enrollment.signal,
        async dispatch(wire) {
          try {
            assert.equal(payload, undefined);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
            const message = JSON.parse(wire);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            assert.deepEqual(Object.keys(message.value).sort(), [
              'blindedCommitment',
              'creator',
              'creatorRow',
              'creatorTransaction',
              'descriptor',
              'expectedHash',
              'guards',
              'noteHash',
              'pathElements',
              'priorShield',
              'proof',
              'row',
              'state',
              'transaction',
            ]);
            assert.equal(message.value.guards.attempts, 0);
            payload = message.value;
            return JSON.stringify({ id: 1, value: null });
          } catch (error) {
            const line = error?.stack?.match(/qualify-railgun-own-transact-creator\.js:(\d+):\d+/);
            console.error(
              JSON.stringify({
                phase: 'fixture-result-admission',
                line: line ? Number(line[1]) : null,
              })
            );
            throw error;
          }
        },
      },
    });
    await task.ready;
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    task = undefined;
    assert.deepEqual(payload.descriptor, identity.descriptor);
    assert.deepEqual(payload.descriptor, enrollment.descriptor);
    assert.deepEqual(Object.keys(payload.transaction).sort(), ['chainId', 'data', 'to', 'value']);
    const intent = extractRailgunTransactIntent(payload.transaction);
    assert.deepEqual(intent.intent, payload.transaction);
    assert.equal(
      intent.expected.kind,
      kind === 'unshield' ? 'railgun-token-unshield' : 'railgun-private-transfer'
    );
    assert.equal(intent.expected.tree, 0);
    assert.deepEqual(payload.row.nullifiers, [intent.expected.nullifier]);
    assert.deepEqual(payload.row.commitments, [intent.expected.commitment]);
    assert.equal(payload.row.boundParamsHash, intent.expected.boundParamsHash);
    assert.equal(payload.row.blockNumber, OWN_BLOCK);
    assert.equal(payload.row.graphID, fixture.row.graphID);
    assert.equal(payload.row.txid, fixture.transaction.hash.slice(2));
    assert.equal(payload.pathElements.length, 16);
    assert.deepEqual(payload.pathElements, [
      payload.pathElements[0],
      ...require('../src/main/wallet/railgun-public-records')
        .ZERO_NODES.slice(1, 16)
        .map((v) => '0x' + v),
    ]);
    assert.match(payload.expectedHash, /^0x[0-9a-f]{64}$/);
    const inner = txAbi
      .decodeFunctionData('transact', payload.transaction.data)[0][0]
      .toArray(true);
    // Preserve only the old structural proof, never its nullifier/ciphertext/bindings.
    inner[0] = structuralProof;
    fixture.row = payload.row;
    Object.assign(fixture.receipt.logs[0], eventAbi.encodeEventLog('Nullified', [0, inner[2]]));
    if (kind === 'transfer') {
      assert.equal(payload.row.utxoTreeOut, 0);
      assert.equal(payload.row.utxoBatchStartPositionOut, 2);
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Transact', [0, 2, inner[3], inner[4][6]])
      );
    } else {
      assert.equal(intent.expected.recipient, owner);
      assert.equal(intent.expected.amount, '1000');
      assert.equal(payload.row.utxoTreeOut, 99999);
      assert.equal(payload.row.utxoBatchStartPositionOut, 99999);
      assert.deepEqual(payload.row.unshield, {
        tokenData: payload.priorShield.preimage.token,
        toAddress: owner,
        value: '1000',
      });
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Unshield', [
          owner,
          [0, require('../src/main/wallet/railgun-shield-pins.json').wrappedNative, 0],
          998,
          2,
        ])
      );
    }
    const shieldAbi = new Interface([
      require('../src/main/wallet/railgun-shield-receipt').SHIELD_EVENT,
    ]);
    const c = payload.priorShield;
    const priorShield = {
      ...shieldAbi.encodeEventLog('Shield', [
        0,
        0,
        [[c.preimage.npk, [0, c.preimage.token.tokenAddress, 0], c.preimage.value]],
        [[c.ciphertext.encryptedBundle, c.ciphertext.shieldKey]],
        [0],
      ]),
      address: fixture.receipt.to,
      transactionHash: hex(705),
      blockHash: blockHash(SHIELD_BLOCK),
      blockNumber: tag(SHIELD_BLOCK),
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    };
    const creatorInner = txAbi
      .decodeFunctionData('transact', payload.creatorTransaction.data)[0][0]
      .toArray(true);
    const creatorMetadata = {
      address: fixture.receipt.to,
      transactionHash: '0x' + payload.creatorRow.txid,
      blockHash: blockHash(CREATOR_BLOCK),
      blockNumber: tag(CREATOR_BLOCK),
      transactionIndex: tag(2),
      removed: false,
    };
    const creatorLogs = [
      {
        ...creatorMetadata,
        ...eventAbi.encodeEventLog('Nullified', [0, creatorInner[2]]),
        logIndex: tag(0),
      },
      {
        ...creatorMetadata,
        ...eventAbi.encodeEventLog('Transact', [0, 1, creatorInner[3], creatorInner[4][6]]),
        logIndex: tag(1),
      },
    ];
    history = [priorShield, ...creatorLogs, ...fixture.receipt.logs];
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
    assert.deepEqual(decoded.intent, payload.transaction);
    assert.deepEqual(decoded.expected, intent.expected);
    fixture.record.intent = railgunTransactJournalIntent(proved);
    assert.equal(
      inspectRailgunTransactReceipt(fixture.record, fixture.transaction, fixture.receipt).status,
      'matched'
    );
    const capsule = fixture.capsule;
    capsule.selection = { kind: decoded.expected.kind, tree: 0, position: 1, recipient };
    capsule.engineSha256 = require('../src/main/wallet/railgun-engine-manifest.json').sha256;
    capsule.pathElements = payload.pathElements;
    capsule.preparation.expectedHash = payload.expectedHash;
    capsule.preparation.recipient = recipient;
    capsule.preparation.amount = '1000';
    capsule.noteHash = payload.noteHash;
    capsule.walletId = enrollment.descriptor.walletId;
    capsule.preparation.transaction = decoded.intent;
    capsule.preparation.expected = decoded.expected;
    assert.deepEqual(
      require('../src/main/wallet/railgun-private-capsule').normalizeRailgunPrivateCapsule(capsule),
      capsule
    );
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
    finalizedOverride = OWN_BLOCK + 5;
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
    finalizedOverride = null;
    recovery.close();
    recovery = null;
    phase = 'baseline-capture';
    const baseline = await capture();
    assert.equal(baseline.status, 'captured');
    const { openRailgunAccountPublic } = require('../src/main/wallet/railgun-account-public');
    const { openRailgunAccountTxid } = require('../src/main/wallet/railgun-account-txid');
    const {
      preflightRailgunOwnTransactPoiMembership,
    } = require('../src/main/wallet/railgun-own-witness');
    phase = 'public-open';
    publicAccount = await openRailgunAccountPublic({ enrollment, archive, create: true });
    phase = 'public-advance';
    // Synthetic source prefix contains the earlier Shield and exact selected receipt logs.
    let publicPrefixAdvances = 0;
    for (let from = 0; from <= OWN_BLOCK + 5; from += 100000) {
      await publicAccount.advance({
        to: Math.min(from + 99999, OWN_BLOCK + 5),
        anchor: { number: FINALIZED, hash: blockHash(FINALIZED) },
      });
      publicPrefixAdvances++;
    }
    assert.equal(publicPrefixAdvances, 60);
    for (const count of Object.values(sourceMaintenance)) assert.ok(count > 0);
    phase = 'mirror-seed';
    txid = await openRailgunAccountTxid({
      enrollment,
      archive,
      coordinator: publicAccount.coordinator,
      create: true,
    });
    await txid.advance();
    await txid.close();
    txid = null;
    const witnessCapture = async (selected = selector) => {
      assert.equal(preflightActive, false);
      preflightActive = true;
      sourceReturnedAt = undefined;
      const started = performance.now();
      try {
        return await preflightRailgunOwnTransactPoiMembership({
          enrollment,
          archive,
          coordinator: publicAccount.coordinator,
          selector: selected,
          signal: enrollment.signal,
        });
      } finally {
        if (sourceReturnedAt !== undefined)
          phaseTimings.push({
            name: 'source-return-to-completion',
            elapsedMs: Math.round(performance.now() - sourceReturnedAt),
          });
        phaseTimings.push({
          name: 'preflight',
          elapsedMs: Math.round(performance.now() - started),
        });
        preflightActive = false;
      }
    };
    const rpcSnapshot = () => JSON.parse(JSON.stringify(roleMethods));
    const assertCaptureRpc = (before, archived, handshake = false) => {
      const delta = {};
      for (const [role, counts] of Object.entries(roleMethods)) {
        delta[role] = {};
        for (const method of new Set([...Object.keys(counts), ...Object.keys(before[role])])) {
          const count = (counts[method] || 0) - (before[role][method] || 0);
          if (count) delta[role][method] = count;
        }
      }
      assert.deepEqual(delta, {
        'transaction-rpc': {
          eth_chainId: 1,
          eth_getTransactionByHash: 1,
          eth_getTransactionReceipt: 1,
          eth_getBlockByNumber: archived ? 12 : 11,
          eth_blockNumber: 2,
        },
        'protocol-rpc': {
          ...(handshake ? { eth_chainId: 1 } : {}),
          // Four canonical passes: finalized + anchor/from/to/previous; three event blocks.
          eth_getBlockByNumber: 23,
          eth_getLogs: 1,
        },
      });
      return delta;
    };
    const checkedCapture = async () => {
      const beforeServices = { ...serviceMethods },
        beforeRpc = rpcSnapshot(),
        timingStart = phaseTimings.length;
      const beforeJournal = await journal.readSnapshot();
      const beforeMaintenance = { ...sourceMaintenance };
      const beforeJobs = JSON.parse(JSON.stringify(jobs));
      const result = await witnessCapture();
      assert.deepEqual(sourceMaintenance, beforeMaintenance);
      for (const [name, counts] of Object.entries(jobs)) {
        const prior = beforeJobs[name] || { keyHandoffs: 0 };
        assert.equal(counts.keyHandoffs, prior.keyHandoffs);
        assert.equal(counts.starts, counts.exits);
      }
      if (result.status !== 'captured')
        console.error(JSON.stringify({ phase: 'preflight-refusal', stage: result.stage }));
      assert.equal(result.status, 'captured', 'preflight stage ' + result.stage);
      assert.equal(result.capture.bindingDigest, baseline.capture.bindingDigest);
      assert.deepEqual(result.state, payload.state);
      assert.equal(result.witness.row.txid, fixture.transaction.hash.slice(2));
      for (const flag of [
        'accountAuthenticated',
        'sourceAuthenticated',
        'currentFinalityVerified',
        'txidPathVerified',
        'txidRootAccepted',
        'poiVerified',
        'spendingEnabled',
      ])
        assert.equal(result[flag], false);
      assert.equal(result.observations.source.sourceAuthenticated, true);
      assert.equal(result.observations.source.own.logs.length, 2);
      const creator = result.creatorProvenance;
      assert.equal(creator.note.type, 'Transact');
      assert.equal(creator.note.tree, 0);
      assert.equal(creator.note.position, 1);
      assert.equal(creator.note.hash, payload.noteHash);
      assert.equal(creator.note.txid, '0x' + payload.creatorRow.txid);
      assert.equal(creator.note.blockNumber, CREATOR_BLOCK);
      assert.deepEqual(creator.noteWitness.witness.row, payload.creatorRow);
      assert.equal(creator.noteWitness.witness.index, 0);
      assert.equal(result.witness.index, 1);
      assert.equal(creator.verification.pathVerified, true);
      assert.equal(creator.verification.suppliedCreatorEventsMatched, true);
      assert.equal(creator.verification.utilityExitObserved, true);
      assert.equal(creator.origin.transactionIndex, 2);
      for (const flag of [
        'boundParamsChecked',
        'globalTxidCompleteness',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        assert.equal(creator[flag], false);
      assert.equal(result.observations.verification.pathVerified, true);
      assert.equal(result.observations.verification.utilityExitObserved, true);
      assert.equal(
        result.observations.verification.unshieldCommitmentVerified,
        kind === 'unshield'
      );
      assert.equal(result.observations.root.accepted, true);
      assert.equal(result.observations.archiveAnchorChecked, true);
      assert.equal(serviceMethods.latest - beforeServices.latest, 4);
      assert.equal(serviceMethods.validate - beforeServices.validate, 4);
      assert.equal(serviceMethods.page, beforeServices.page);
      const rpc = assertCaptureRpc(beforeRpc, phase !== 'active-witness', phase === 'reopen');
      const timings = phaseTimings.slice(timingStart);
      assert.deepEqual(
        timings.map((entry) => entry.name),
        [
          'source',
          'mirror-open',
          'own-verifier',
          'creator-verifier',
          'recapture',
          'source-return-to-completion',
          'preflight',
        ]
      );
      for (const entry of timings.slice(0, 5)) assert.equal(entry.completed, true);
      for (const entry of timings)
        assert.ok(Number.isSafeInteger(entry.elapsedMs) && entry.elapsedMs >= 0);
      assert.ok(timings[5].elapsedMs < 55000);
      captureEvidence.push({ phase, rpc, publicTxidPairs: 4, timings });
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      return result;
    };
    phase = 'active-witness';
    const activeCapture = await checkedCapture();
    runs.push({
      mode: phase,
      publicLatestRequests: 4,
      publicTipRootValidations: 4,
      recaptured: true,
      authority: false,
    });
    phase = 'archive';
    const ready = (await journal.list())[0];
    await journal.archiveResolved(
      [{ hash: ready.hash, revision: ready.revision }],
      [{ blockNumber: FINALIZED, blockHash: blockHash(FINALIZED) }]
    );
    const archived = await checkedCapture();
    assert.equal(typeof archived.capture.record.archivedAt, 'number');
    assert.deepEqual(archived.witness, activeCapture.witness);
    runs.push({ mode: 'archived-witness', stableBinding: true, identicalWitness: true });
    phase = 'reopen';
    await publicAccount.close();
    publicAccount = null;
    enrollment.close();
    enrollment = await openRailgunAccountEnrollment({ identity });
    journal = openJournal();
    publicAccount = await openRailgunAccountPublic({ enrollment, archive });
    const reopened = await checkedCapture();
    assert.deepEqual(reopened.capture, archived.capture);
    assert.deepEqual(reopened.witness, archived.witness);
    runs.push({ mode: 'enrollment-and-mirror-reopen', identicalDetachedAccountAndWitness: true });
    const refusedCapture = async (selected, expectedStage, rootReads = 0, receiptReads = null) => {
      const beforeServices = { ...serviceMethods },
        beforeRpc = JSON.stringify(methods),
        beforeOwner = { ...roleMethods['transaction-rpc'] },
        beforeJournal = await journal.readSnapshot();
      assert.deepEqual(await witnessCapture(selected), { status: 'refused', stage: expectedStage });
      assert.equal(serviceMethods.latest - beforeServices.latest, rootReads);
      assert.equal(serviceMethods.validate - beforeServices.validate, rootReads);
      assert.equal(serviceMethods.page, beforeServices.page);
      if (receiptReads) {
        const { headers, head } = receiptReads;
        assert.equal(
          roleMethods['transaction-rpc'].eth_getTransactionByHash -
            beforeOwner.eth_getTransactionByHash,
          1
        );
        assert.equal(
          roleMethods['transaction-rpc'].eth_getTransactionReceipt -
            beforeOwner.eth_getTransactionReceipt,
          1
        );
        assert.equal(
          roleMethods['transaction-rpc'].eth_getBlockByNumber - beforeOwner.eth_getBlockByNumber,
          headers
        );
        assert.equal(
          roleMethods['transaction-rpc'].eth_blockNumber - beforeOwner.eth_blockNumber,
          head
        );
      } else assert.equal(JSON.stringify(methods), beforeRpc);
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
    };
    phase = 'wrong-selector';
    await refusedCapture({ ...selector, position: selector.position + 1 }, 'capture:selection');
    await checkedCapture();
    runs.push({ mode: phase, refused: true, followingCaptureSucceeded: true });
    for (const fault of ['creator-path', 'own-path']) {
      phase = fault;
      jobFault = fault;
      const beforeJobs = JSON.parse(JSON.stringify(jobs));
      const beforeJournal = await journal.readSnapshot();
      const refused = await witnessCapture();
      assert.equal(refused.status, 'refused');
      assert.equal(refused.stage, fault === 'creator-path' ? 'creator-verify' : 'txid-verify');
      const name =
        fault === 'creator-path' ? 'railgun-note-provenance-job.js' : 'railgun-own-txid-job.js';
      assert.equal(jobs[name].starts - beforeJobs[name].starts, 1);
      assert.equal(jobs[name].results - beforeJobs[name].results, 0);
      assert.equal(jobs[name].starts, jobs[name].exits);
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      jobFault = 'healthy';
      await checkedCapture();
      runs.push({
        mode: fault,
        refused: true,
        corruptedUtilityStarted: true,
        resultNotProduced: true,
        followingCaptureSucceeded: true,
      });
    }
    phase = 'root-refusal';
    rejectRoot = true;
    const rootBeforeRpc = rpcSnapshot(),
      rootBeforeServices = { ...serviceMethods };
    const rootRefusal = await witnessCapture();
    assert.equal(rootRefusal.status, 'refused');
    assert.equal(rootRefusal.stage, 'txid');
    assertCaptureRpc(rootBeforeRpc, true);
    assert.deepEqual(serviceMethods, {
      latest: rootBeforeServices.latest + 1,
      validate: rootBeforeServices.validate + 1,
      page: rootBeforeServices.page,
    });
    rejectRoot = false;
    await checkedCapture();
    runs.push({ mode: phase, refused: true, followingCaptureSucceeded: true });
    phase = 'final-root-refusal';
    rejectValidation = serviceMethods.validate + 4;
    const lateBeforeRpc = rpcSnapshot(),
      lateBeforeServices = { ...serviceMethods };
    const lateRoot = await witnessCapture();
    assert.equal(lateRoot.status, 'refused');
    assert.equal(lateRoot.stage, 'root');
    assertCaptureRpc(lateBeforeRpc, true);
    assert.deepEqual(serviceMethods, {
      latest: lateBeforeServices.latest + 4,
      validate: lateBeforeServices.validate + 4,
      page: lateBeforeServices.page,
    });
    rejectValidation = null;
    await checkedCapture();
    runs.push({ mode: phase, refused: true, followingCaptureSucceeded: true });
    phase = 'unresolved-sibling';
    await journal.begin(hex(101), 4);
    await refusedCapture(selector, 'capture:journal');
    runs.push({ mode: phase, refused: true });
    assert.equal(externalAttempts, 0);
    assert.equal(unexpectedRpc, 0);
    assert.deepEqual(
      runs.map((run) => run.mode),
      [
        'missing-journal',
        'unresolved-journal',
        'active-witness',
        'archived-witness',
        'enrollment-and-mirror-reopen',
        'wrong-selector',
        'creator-path',
        'own-path',
        'root-refusal',
        'final-root-refusal',
        'unresolved-sibling',
      ]
    );
    assert.deepEqual(hashes(), before);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          elapsedMs: Math.round(performance.now() - started),
          kind,
          senderKind,
          sourceSha256: before,
          runs,
          rpcMethods: methods,
          jobs,
          phaseTimings,
          captureEvidence,
          membershipAdmitted: false,
          viewingKeyReleases: 0,
          creatorProvenanceInternalOnly: true,
          publicTxidPairsPerSuccessfulCapture: 4,
          foreignSenderUsesDifferentAccountOfSamePublicMnemonic: senderKind === 'foreign',
          sourceMaintenance,
          publicPrefixAdvances,
          externalAttempts,
          unexpectedRpc,
          genuineEnrollmentAndEncryptedStores: true,
          genuineResolutionPermit: true,
          chainObservationsSimulated: true,
          rpcDestinationBindingSimulated: false,
          rpcDestinationBindingQualified: true,
          rpcChainIdHandshakeExercised: true,
          structuralProofAndSignature: true,
          serviceMethods,
          roleMethods,
          syntheticSelectedSourceCompared: true,
          detachedPathVerified: true,
          overallAuthorityGranted: false,
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
    try {
      restoreClock?.();
      task?.close();
      if (task) await task.closed;
      if (txid) await txid.close();
      if (publicAccount) await publicAccount.close();
      recovery?.close();
      journalScope?.close();
      enrollment?.close();
      foreignIdentity?.close();
      identity?.close();
      vault.lockVault();
    } finally {
      for (const restore of timedRestorations) restore();
      processModule.startRailgunProcess = originalStart;
      ledgerModule.createRailgunSourceLedger = originals.ledger;
      sourceModule.createRailgunScanSource = originals.source;
      coordinatorModule.createRailgunScanCoordinator = originals.coordinator;
      serviceModule.createRailgunPublicServices = originalServices;
      Object.assign(registry, originalRegistry);
      tor.getWalletSocksEndpoint = originalEndpoint;
      settings.isWalletTorExperimentAvailable = originalAvailable;
      endpointController.abort();
      transport.createWalletTorTransport = originalTransport;
    }
  }
}
main().then(
  () => {
    releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    const location = error?.stack?.match(/qualify-railgun-own-transact-creator\.js:(\d+):\d+/);
    console.error(
      JSON.stringify({ phase, code: error?.code, line: location ? Number(location[1]) : null })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
