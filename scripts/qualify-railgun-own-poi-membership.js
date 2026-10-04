/** Offline enrolled post-spend Shield membership. Genuine stores and receipts;
 * synthetic chain/root services, fixture-key service-signature trust, structural
 * spend proof/signature. No external transport or owned-note disclosure.
 * Real private RPC and destination/budget identities use simulated registry,
 * Tor endpoint and transport. Chain-ID handshakes are included in wire counts.
 * electron script NEW_DIRECTORY ENGINE_ASAR transfer|unshield [PROVER_ASAR ARTIFACT_DIRECTORY [checks|intents|output-recovery|cold-validation|retained-history|attempts|plans|submission|attempted-output]]
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
const copy = (v) => JSON.parse(JSON.stringify(v));
const CREATOR_BLOCK = 5944700,
  OWN_BLOCK = CREATOR_BLOCK + 1,
  FINALIZED = CREATOR_BLOCK + 20;
const blockHash = (n) => hex(n === -1 ? 0 : n + 1000);
const tag = (n) => '0x' + n.toString(16);
let lock,
  phase = 'setup';
const sources = [
  'src/main/wallet/railgun-own-witness.test.js',
  'src/main/wallet/railgun-poi-source-evidence.js',
  'src/main/wallet/railgun-poi-source-evidence.test.js',
  'src/main/wallet/railgun-poi-source-capture.js',
  'src/main/wallet/railgun-poi-source-capture.test.js',
  'src/main/wallet/railgun-poi-creator.js',
  'src/main/wallet/railgun-poi-creator.test.js',
  'src/main/wallet/railgun-owned-poi-records.js',
  'src/main/wallet/railgun-own-receipt.js',
  'src/main/wallet/railgun-own-txid-verifier.js',
  'src/main/wallet/railgun-own-txid-verifier.test.js',
  'src/main/wallet/railgun-own-txid-job.js',
  'scripts/fixtures/railgun-own-preflight-job.js',
  'src/main/wallet/railgun-own-selector.js',
  'src/main/wallet/railgun-own-selector.test.js',
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
  'src/main/networks/network-registry.js',
  'src/main/settings-store.js',
  'src/main/tor-manager.js',
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
  'src/main/wallet/railgun-own-operation.test.js',
  'scripts/qualify-railgun-poi-preflight.js',
  'scripts/qualify-railgun-own-poi-membership.js',
  'scripts/fixtures/railgun-own-poi-membership-input-job.js',
  'scripts/fixtures/railgun-own-poi-membership-signature.js',
  'src/main/wallet/railgun-own-poi-membership.js',
  'src/main/wallet/railgun-own-poi-membership.test.js',
  'src/main/wallet/railgun-own-poi-binding.js',
  'src/main/wallet/railgun-own-poi-binding.test.js',
  'src/main/wallet/railgun-own-poi-proof-data.js',
  'src/main/wallet/railgun-own-poi-proof-data.test.js',
  'src/main/wallet/railgun-own-transact-poi-proof-data.test.js',
  'src/main/wallet/railgun-own-poi-proof.js',
  'src/main/wallet/railgun-own-poi-proof.test.js',
  'src/main/wallet/railgun-own-poi-checks.js',
  'src/main/wallet/railgun-own-poi-checks.test.js',
  'src/main/wallet/railgun-poi-disclosure-plan.js',
  'src/main/wallet/railgun-poi-disclosure-plan.test.js',
  'src/main/wallet/railgun-poi-submission.test.js',
  'src/main/wallet/railgun-poi-submit-data.js',
  'src/main/wallet/railgun-poi-submit-data.test.js',
  'src/main/wallet/railgun-poi-intent-store.js',
  'src/main/wallet/railgun-poi-intent-store.test.js',
  'scripts/fixtures/railgun-retained-history-job.js',
  'src/main/wallet/railgun-poi-cold-validation.js',
  'src/main/wallet/railgun-poi-cold-validation.test.js',
  'src/main/wallet/railgun-poi-output-recovery.js',
  'src/main/wallet/railgun-poi-output-recovery.test.js',
  'src/main/wallet/railgun-poi-output-recovery-data.js',
  'src/main/wallet/railgun-poi-output-recovery-data.test.js',
  'src/main/wallet/railgun-poi-output-recover-job.js',
  'src/main/wallet/railgun-poi-output-recover-job.test.js',
  'src/main/wallet/railgun-poi-root.js',
  'src/main/wallet/railgun-poi-root.test.js',
  'src/main/wallet/railgun-own-poi-prove-job.js',
  'src/main/wallet/railgun-own-poi-prove-job.test.js',
  'src/main/wallet/railgun-poi-prover.js',
  'src/main/wallet/railgun-poi-payload.js',
  'src/main/wallet/railgun-poi-verifier.js',
  'src/main/wallet/railgun-poi-verify-job.js',
  'src/main/wallet/railgun-process.test.js',
  'src/main/wallet/railgun-account-enrollment.test.js',
  'src/main/wallet/railgun-poi-witness.js',
  'src/main/wallet/railgun-poi-reconstruct.js',
  'src/main/wallet/railgun-poi-witness.test.js',
  'src/main/wallet/railgun-poi-shield-selector.js',
  'src/main/wallet/railgun-poi-shield-selector-data.js',
  'src/main/wallet/railgun-poi-shield-selector-job.js',
  'src/main/wallet/railgun-poi-source.js',
  'src/main/wallet/railgun-poi-source.test.js',
  'src/main/wallet/railgun-poi-membership.test.js',
  'src/main/wallet/railgun-poi-membership.js',
  'src/main/wallet/railgun-poi-records.js',
  'src/main/wallet/railgun-poi-job.js',
  'src/main/networks/wallet-tor-transport.js',
];
const hashes = () =>
  Object.fromEntries(
    [...new Set(sources)].map((file) => [
      file,
      sha(fs.readFileSync(path.join(__dirname, '..', file))),
    ])
  );
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function main() {
  const [directory, archive, kind, proverArchive, artifactDirectory, checksFlag] =
    process.argv.slice(2);
  assert.ok([5, 7, 8].includes(process.argv.length));
  const checksMode = process.argv.length === 8;
  if (checksMode)
    assert.ok(
      [
        'checks',
        'intents',
        'output-recovery',
        'cold-validation',
        'retained-history',
        'attempts',
        'plans',
        'submission',
        'attempted-output',
      ].includes(checksFlag)
    );
  const planMode = checksFlag === 'plans';
  const planRuns = [],
    planResults = [];
  const planWork = { utilities: 0, utilityKeyHandoffs: 0 };
  let planActive = false;
  const attemptedOutputMode = checksFlag === 'attempted-output';
  const attemptedOutputRuns = [];
  let attemptedOutputValidations = 0;
  const attemptMode = checksFlag === 'attempts' || attemptedOutputMode;
  const attemptRuns = [];
  const attemptWork = { utilities: 0, utilityKeyHandoffs: 0 };
  let attemptActive = false;
  const outputRecoveryMode = checksFlag === 'output-recovery';
  const submissionMode = checksFlag === 'submission';
  const submissionRuns = [];
  const submissionWire = { creates: 0, closes: 0, list: 0, txid: 0, post: 0, unexpected: 0 };
  const submissionIsolation = new Set();
  let submissionActive = false,
    submissionPreparedEntry,
    submissionPostDrain,
    submissionOperation,
    submissionReviewStage = 0,
    submissionValidationCount = 0,
    submissionRootReadChain = Promise.resolve(),
    submissionRootReads = 0,
    submissionRootReadPeak = 0;
  const retainedHistoryMode = checksFlag === 'retained-history' || submissionMode;
  const coldValidationMode = checksFlag === 'cold-validation' || retainedHistoryMode;
  let laterMirror,
    mirrorAdvanced = false;
  const mirrorState = () => (mirrorAdvanced ? laterMirror.state : payload.state);
  const intentsMode =
    checksFlag === 'intents' || outputRecoveryMode || coldValidationMode || attemptMode || planMode;
  const coldValidationRuns = [],
    coldValidationVerifierTimings = [],
    coldValidationVerifierJobs = {
      started: 0,
      exited: 0,
      inputChecks: 0,
      inputSubstitutions: 0,
      resultMessages: 0,
      hashChecks: 0,
      resultAdmissions: 0,
    },
    coldValidationGuards = { reports: 0, attempts: 0, canaryChecks: 0, hooks: [] };
  let coldValidationActive = false;
  const intentRuns = [];
  const outputRecoveryRuns = [],
    outputRecoveryReplies = [],
    outputRecoveryTimings = [],
    outputRecoveryJobs = {
      ownSelector: 0,
      ownSelectorExit: 0,
      ownTxid: 0,
      ownTxidExit: 0,
      mirrorInspect: 0,
      mirrorInspectExit: 0,
      mirrorWitness: 0,
      mirrorWitnessExit: 0,
      mirrorHistorical: 0,
      mirrorHistoricalExit: 0,
      historicalSubstitutions: 0,
      publicPlan: 0,
      publicPlanExit: 0,
      viewing: 0,
      viewingExit: 0,
      keyRequests: 0,
      keyReplies: 0,
      resultMessages: 0,
      resultAdmissions: 0,
      resultSubstitutions: 0,
      unexpected: 0,
    },
    outputRecoveryMirrorBroker = {
      attempted: 0,
      admitted: 0,
      input: 0,
      get: 0,
      result: 0,
      forbidden: 0,
    },
    outputRecoveryPublicBroker = {
      attempted: 0,
      admitted: 0,
      sourceNext: 0,
      jobResult: 0,
      forbidden: 0,
    },
    outputRecoveryGuards = { reports: 0, attempts: 0, canaryChecks: 0, hooks: [] };
  let outputRecoveryActive = false,
    outputRecoveryFault = 'healthy',
    outputPublicPlanAdmitted = false,
    outputRecoveryInputDigest,
    outputRecoveryTxid;
  let intentStore;
  const proofMode = process.argv.length >= 7;
  if (proofMode) assert.ok(path.isAbsolute(proverArchive) && path.isAbsolute(artifactDirectory));
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive) && !fs.existsSync(directory));
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
  const signature = require('./fixtures/railgun-own-poi-membership-signature').install();
  const { REQUIRED_LIST } = require('../src/main/wallet/railgun-poi-records');
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const transport = require('../src/main/networks/wallet-tor-transport');
  const registry = require('../src/main/networks/network-registry');
  const originalRegistry = {
    getNetwork: registry.getNetwork,
    getEndpoints: registry.getEndpoints,
    getEndpointSources: registry.getEndpointSources,
  };
  const rpcUrl = 'https://synthetic.invalid/railgun-qualification';
  registry.getNetwork = () => ({ access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } });
  registry.getEndpoints = () => [rpcUrl];
  registry.getEndpointSources = () => [{ keyed: false, coverage: { 11155111: rpcUrl } }];
  const processModule = require('../src/main/wallet/railgun-process');
  const tor = require('../src/main/tor-manager'),
    settings = require('../src/main/settings-store');
  const originals = {
    transport: transport.createWalletTorTransport,
    start: processModule.startRailgunProcess,
    endpoint: tor.getWalletSocksEndpoint,
    available: settings.isWalletTorExperimentAvailable,
  };
  const endpointController = new AbortController();
  const endpoint = { signal: endpointController.signal };
  tor.getWalletSocksEndpoint = () => endpoint;
  settings.isWalletTorExperimentAvailable = () => true;
  const poiMethods = Object.fromEntries(
    [
      'ppoi_pois_per_list',
      'ppoi_merkle_proofs',
      'ppoi_poi_events',
      'ppoi_validate_poi_merkleroots',
    ].map((method) => [method, 0])
  );
  const publicMethods = { latest: 0, validate: 0, page: 0 };
  const pendingCheckpointRuns = [];
  let pendingCheckpointActivity;
  const pendingUtilityNames = [
    'ownSelector',
    'ownTxid',
    'mirrorInspect',
    'mirrorWitness',
    'mirrorHistorical',
    'publicPlan',
    'publicApply',
    'unexpected',
  ];
  const pendingRpcNames = [
    'eth_chainId',
    'eth_getLogs',
    'eth_getTransactionReceipt',
    'eth_getTransactionByHash',
    'eth_getBlockByNumber',
    'eth_blockNumber',
  ];
  const pendingUtilityName = (options) => {
    const file = path.basename(options.filename ?? '');
    if (file === 'railgun-own-selector-job.js') return 'ownSelector';
    if (file === 'railgun-own-txid-job.js') return 'ownTxid';
    if (file === 'railgun-txid-job.js' || file === 'railgun-public-job.js') {
      const mode = JSON.parse(options.input).mode;
      if (file === 'railgun-txid-job.js')
        return (
          {
            inspect: 'mirrorInspect',
            witness: 'mirrorWitness',
            'historical-root': 'mirrorHistorical',
          }[mode] || 'unexpected'
        );
      return { plan: 'publicPlan', apply: 'publicApply' }[mode] || 'unexpected';
    }
    return 'unexpected';
  };
  const rpcMethods = {},
    jobs = { membership: 0, membershipExit: 0, selector: 0, selectorExit: 0 };
  let unexpectedTransport = 0,
    unexpectedRpc = 0,
    forbiddenKeyJobs = 0,
    setupKeyJobs = 0;
  let fixture,
    payload,
    history,
    mode = 'valid',
    hold,
    releaseTransport,
    heldTask,
    onRoot,
    membershipDrain;
  const membershipDrainGates = new Set();
  let identity,
    enrollment,
    journalScope,
    recovery,
    publicAccount,
    txid,
    task,
    restoreClock,
    journal;
  let transportCreates = 0,
    transportCloses = 0;
  let proofFault = 'valid',
    proofActive = false,
    proofCaller;
  const viewingReplies = [],
    proofRuns = [],
    proofExits = [];
  const proofJobs = {
    viewing: 0,
    viewingExit: 0,
    verification: 0,
    verificationExit: 0,
    keyReplies: 0,
    resultMessages: 0,
    resultAdmissions: 0,
    maxWireBytes: 0,
    peakRssBytes: 0,
  };
  let savedProof,
    checksActive = false,
    checksFault = 'valid',
    checksOperation,
    checksHold;
  const checksRuns = [],
    checksResults = new Set(),
    checksReleases = new Set(),
    checksJobs = { ownSelector: 0, ownSelectorExit: 0, ownTxid: 0, ownTxidExit: 0 },
    checksForbiddenJobs = { binaryKey: 0, poiProver: 0, poiVerifier: 0 },
    checksGuards = { reports: 0, attempts: 0, canaryChecks: 0, hooks: [] },
    checksRoots = {
      creates: 0,
      closes: 0,
      attempted: 0,
      validated: 0,
      list: 0,
      txid: 0,
      pending: 0,
    };
  const clients = new Set(),
    results = new Set(),
    pendingOperations = new Set(),
    recoveryReleases = new Set();
  const operationsController = new AbortController();
  // Every consumer must capture the counted fixture transport, including the
  // original factories whose exports are replaced below. Never retain a real
  // transport factory that a future qualification path could call unnoticed.
  for (const file of [
    '../src/main/networks/private-rpc',
    '../src/main/wallet/railgun-public-services',
    '../src/main/wallet/railgun-poi-source',
    '../src/main/wallet/railgun-poi-root',
    '../src/main/wallet/railgun-own-poi-checks',
    '../src/main/wallet/railgun-scan-source',
    '../src/main/wallet/railgun-scan-coordinator',
    '../src/main/wallet/railgun-scan-journal',
    '../src/main/wallet/railgun-source-ledger',
    '../src/main/wallet/railgun-txid-root',
    '../src/main/wallet/private-transaction-network',
    '../src/main/wallet/railgun-own-receipt',
    '../src/main/wallet/railgun-poi-disclosure-plan',
    '../src/main/wallet/railgun-own-witness',
    '../src/main/wallet/railgun-own-poi-membership',
    '../src/main/wallet/railgun-own-poi-proof',
    '../src/main/wallet/railgun-poi-output-recovery',
    '../src/main/wallet/railgun-poi-cold-validation',
    '../src/main/wallet/railgun-account-poi',
    '../src/main/networks/kohaku-network',
  ])
    assert.equal(require.cache[require.resolve(file)], undefined);
  const createFixturePoiTransport = (checking) => {
    if (checking) {
      checksRoots.creates++;
      let closed = false,
        used = false,
        pending = 0;
      const completion = deferred();
      const drain = () => {
        if (closed && pending === 0) completion.resolve();
      };
      const client = {
        closed: completion.promise,
        close() {
          if (!closed) checksRoots.closes++;
          closed = true;
          drain();
        },
        async request(handle, url, options) {
          pending++;
          try {
            return await client.read(handle, url, options);
          } finally {
            pending--;
            drain();
          }
        },
        async read(handle, url, options) {
          const held = checksHold;
          try {
            checksRoots.attempted++;
            assert.equal(checksActive, true);
            assert.equal(closed, false);
            assert.equal(used, false);
            used = true;
            assert.equal(url, 'https://ppoi.fdi.network');
            const context = getPrivacyContext(handle);
            assert.deepEqual(context.subject, {
              kind: 'private-account',
              principal: 'railgun:' + enrollment.descriptor.accountIndex,
              protocol: 'railgun',
              deployment: 'sepolia',
              chainId: 11155111,
              role: 'poi',
              operation: context.subject.operation,
            });
            assert.match(context.subject.operation, /^poi:[0-9a-f]{64}$/);
            checksOperation ??= context.subject.operation;
            assert.equal(context.subject.operation, checksOperation);
            assert.deepEqual(context.requirements, {
              origin: 'tor',
              content: 'public',
              correctness: 'any',
              maxAgeMs: null,
            });
            assert.equal(options.method, 'POST');
            assert.deepEqual(Object.keys(options).sort(), [
              'body',
              'headers',
              'method',
              'signal',
              'timeoutMs',
            ]);
            assert.deepEqual(options.headers, { 'content-type': 'application/json' });
            assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
            assert.ok(
              Number.isSafeInteger(options.timeoutMs) &&
                options.timeoutMs > 0 &&
                options.timeoutMs <= 45000
            );
            const body = JSON.parse(options.body);
            assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
            assert.equal(body.jsonrpc, '2.0');
            assert.ok(typeof body.id === 'string' && body.id.length > 0);
            const rootKind = body.method === 'ppoi_validate_poi_merkleroots' ? 'list' : 'txid';
            assert.equal(
              body.method,
              rootKind === 'list'
                ? 'ppoi_validate_poi_merkleroots'
                : 'ppoi_validate_txid_merkleroot'
            );
            assert.deepEqual(body.params, {
              chainType: '0',
              chainID: '11155111',
              txidVersion: 'V2_PoseidonMerkle',
              ...(rootKind === 'list'
                ? { listKey: REQUIRED_LIST, poiMerkleroots: [savedProof.payload.poiMerkleroots[0]] }
                : {
                    tree: 0,
                    index: savedProof.payload.txidMerklerootIndex,
                    merkleroot: savedProof.payload.txidMerkleroot,
                  }),
            });
            checksRoots.validated++;
            checksRoots[rootKind]++;
            checksRoots.pending++;
            try {
              if (held) {
                assert.equal(held.requests[rootKind], undefined);
                held.requests[rootKind] = {
                  signal: options.signal,
                  isolation: context.isolationToken,
                };
                options.signal.addEventListener(
                  'abort',
                  () => {
                    held.aborted[rootKind] = performance.now();
                    if (Object.keys(held.aborted).length === 2) held.revoked.resolve();
                  },
                  { once: true }
                );
                if (Object.keys(held.requests).length === 2) held.entered.resolve();
              }
              // Both independent root requests deliberately ignore abort. Their
              // separate release gates prove one drained sibling is insufficient.
              if (held) await held.release[rootKind].promise;
              const value = {
                jsonrpc: '2.0',
                id: body.id,
                result: checksFault !== rootKind + '-reject',
              };
              if (checksFault === 'malformed-list' && rootKind === 'list') value.extra = true;
              return { status: 200, body: Buffer.from(JSON.stringify(value)) };
            } finally {
              checksRoots.pending--;
              held?.finished[rootKind].resolve();
            }
          } catch (error) {
            // Do not make the fixture wait for the controller to report this:
            // the controller must first drain any held sibling transport.
            held?.failed.resolve(error);
            throw error;
          }
        },
      };
      clients.add(client);
      return client;
    }
    transportCreates++;
    let closed = false,
      operation,
      cursor = 0,
      pending = 0;
    const completion = deferred(),
      gate = membershipDrain;
    let transportReleased = !gate;
    const drain = () => {
      if (closed && pending === 0 && transportReleased) completion.resolve();
    };
    gate?.release.promise.then(() => {
      transportReleased = true;
      drain();
    });
    const client = {
      closed: completion.promise,
      close() {
        if (!closed) transportCloses++;
        closed = true;
        gate?.closeRequested.resolve();
        drain();
      },
      async request(handle, url, options) {
        pending++;
        try {
          return await client.read(handle, url, options);
        } finally {
          pending--;
          if (closed && pending === 0) gate?.requestSettled.resolve();
          drain();
        }
      },
      async read(handle, url, options) {
        // Count before every assertion, including context and cancellation.
        const body = JSON.parse(options.body);
        if (!Object.hasOwn(poiMethods, body.method) || url !== 'https://ppoi.fdi.network') {
          unexpectedTransport++;
          throw Error('External transport forbidden');
        }
        poiMethods[body.method]++;
        const context = getPrivacyContext(handle);
        assert.equal(closed, false);
        assert.equal(context.subject.kind, 'private-account');
        assert.equal(context.subject.principal, 'railgun:' + enrollment.descriptor.accountIndex);
        assert.equal(context.subject.role, 'poi');
        assert.equal(context.subject.protocol, 'railgun');
        assert.equal(context.subject.deployment, 'sepolia');
        assert.equal(context.subject.chainId, 11155111);
        assert.match(context.subject.operation, /^poi:[0-9a-f]{64}$/);
        operation ??= context.subject.operation;
        assert.equal(context.subject.operation, operation);
        assert.equal(options.method, 'POST');
        assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
        assert.ok(
          Number.isSafeInteger(options.timeoutMs) &&
            options.timeoutMs > 0 &&
            options.timeoutMs <= 45000
        );
        assert.equal(body.jsonrpc, '2.0');
        assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
        assert.equal(typeof body.id, 'string');
        assert.equal(body.method, Object.keys(poiMethods)[cursor++]);
        const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
        const note = { blindedCommitment: payload.blindedCommitment, type: 'Shield' };
        const proof = copy(payload.proof);
        if (mode === 'path')
          proof.elements[0] = hex(BigInt('0x' + proof.elements[0]) + 1n).slice(2);
        if (mode === 'index') proof.indices = hex(BigInt('0x' + proof.indices) ^ 1n).slice(2);
        const index = Number(BigInt('0x' + proof.indices));
        let result;
        if (body.method === 'ppoi_pois_per_list') {
          assert.deepEqual(body.params, {
            ...base,
            listKeys: [REQUIRED_LIST],
            blindedCommitmentDatas: [note],
          });
          result = {
            [note.blindedCommitment]: { [REQUIRED_LIST]: mode === 'status' ? 'Missing' : 'Valid' },
          };
        } else if (body.method === 'ppoi_merkle_proofs') {
          assert.deepEqual(body.params, {
            ...base,
            listKey: REQUIRED_LIST,
            blindedCommitments: [note.blindedCommitment],
          });
          if (mode === 'transport-drain') {
            hold.resolve();
            await releaseTransport.promise; // Deliberately ignore abort until the fixture releases the request.
          }
          result = [proof];
        } else if (body.method === 'ppoi_poi_events') {
          assert.deepEqual(body.params, {
            ...base,
            listKey: REQUIRED_LIST,
            startIndex: index,
            endIndex: index,
          });
          const event = { index, blindedCommitment: note.blindedCommitment, type: 'Shield' };
          const signed = signature.sign(event);
          result = [
            {
              signedPOIEvent: {
                ...event,
                signature:
                  mode === 'signature' ? (signed[0] === '0' ? '1' : '0') + signed.slice(1) : signed,
              },
              validatedMerkleroot: proof.root,
            },
          ];
        } else {
          assert.deepEqual(body.params, {
            ...base,
            listKey: REQUIRED_LIST,
            poiMerkleroots: [proof.root],
          });
          if (onRoot) await onRoot();
          result = mode !== 'root';
        }
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
        };
      },
    };
    clients.add(client);
    return client;
  };
  const createFixtureSubmissionTransport = () => {
    submissionWire.creates++;
    let closed = false,
      used = false,
      postClient = false,
      resolveClosed;
    const client = {
      closed: new Promise((resolve) => (resolveClosed = resolve)),
      close() {
        if (!closed) submissionWire.closes++;
        closed = true;
        if (postClient && submissionPostDrain) {
          submissionPostDrain.reached = true;
          submissionPostDrain.entered.resolve();
          submissionPostDrain.release.promise.then(resolveClosed);
        } else resolveClosed();
      },
      async request(handle, url, options) {
        try {
          assert.equal(submissionActive, true);
          assert.equal(submissionReviewStage, 2);
          assert.equal(closed, false);
          assert.equal(used, false);
          used = true;
          assert.equal(url, 'https://ppoi.fdi.network');
          const context = getPrivacyContext(handle);
          assert.deepEqual(context.subject, {
            kind: 'private-account',
            principal: 'railgun:' + enrollment.descriptor.accountIndex,
            protocol: 'railgun',
            deployment: 'sepolia',
            chainId: 11155111,
            role: 'poi',
            operation: context.subject.operation,
          });
          assert.match(context.subject.operation, /^poi:[0-9a-f]{64}$/);
          submissionOperation ??= context.subject.operation;
          assert.equal(context.subject.operation, submissionOperation);
          assert.equal(submissionIsolation.has(context.isolationToken), false);
          submissionIsolation.add(context.isolationToken);
          assert.equal(context.requirements.origin, 'tor');
          assert.equal(options.method, 'POST');
          assert.deepEqual(options.headers, { 'content-type': 'application/json' });
          assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
          const body = JSON.parse(options.body);
          assert.equal(body.jsonrpc, '2.0');
          assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
          const isPost = body.method === 'ppoi_submit_transact_proof';
          postClient = isPost;
          assert.deepEqual(Object.keys(options).sort(), [
            'body',
            'headers',
            ...(isPost ? ['maxResponseBytes'] : []),
            'method',
            ...(isPost ? ['requireFramedResponse'] : []),
            'signal',
            'timeoutMs',
          ]);
          assert.ok(Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0);
          assert.ok(options.timeoutMs <= (isPost ? 10000 : 15000));
          if (isPost) {
            submissionWire.post++;
            assert.equal(submissionWire.post, 1);
            assert.equal(submissionWire.list, 1);
            assert.equal(submissionWire.txid, 1);
            assert.equal(options.maxResponseBytes, 2048);
            assert.equal(options.requireFramedResponse, true);
            const durable = await intentStore.get(submissionPreparedEntry.capsuleDigest);
            assert.equal(durable.state, 'attempted');
            assert.equal(options.body, durable.attempt.submission.body);
            assert.equal(body.id, durable.attempt.attemptedAt);
            assert.equal(body.id, durable.attempt.submission.requestId);
            assert.equal(sha(options.body), durable.attempt.submission.bodySha256);
            assert.equal(durable.payloadSha256, submissionPreparedEntry.payloadSha256);
            assert.equal(durable.revision, submissionPreparedEntry.revision);
            // Independent wire expectation from the pre-attempt retained payload;
            // do not use the production submission builder as this oracle.
            const payload = submissionPreparedEntry.payload;
            assert.equal(
              options.body,
              JSON.stringify({
                jsonrpc: '2.0',
                method: 'ppoi_submit_transact_proof',
                params: {
                  chainType: '0',
                  chainID: '11155111',
                  txidVersion: 'V2_PoseidonMerkle',
                  listKey: payload.listKey,
                  transactProofData: {
                    snarkProof: payload.proof,
                    poiMerkleroots: payload.poiMerkleroots,
                    txidMerkleroot: payload.txidMerkleroot,
                    txidMerklerootIndex: payload.txidMerklerootIndex,
                    blindedCommitmentsOut: payload.blindedCommitmentsOut,
                    railgunTxidIfHasUnshield: payload.railgunTxidIfHasUnshield,
                  },
                },
                id: durable.attempt.attemptedAt,
              })
            );
          } else {
            // The service calls overlap; fixture-only store inspections must
            // serialize because genuine store reads intentionally exclude each other.
            submissionRootReads++;
            submissionRootReadPeak = Math.max(submissionRootReadPeak, submissionRootReads);
            const read = submissionRootReadChain.then(() =>
              intentStore.get(submissionPreparedEntry.capsuleDigest)
            );
            submissionRootReadChain = read;
            try {
              assert.deepEqual(await read, submissionPreparedEntry);
              assert.equal(submissionPreparedEntry.state, 'prepared');
            } finally {
              submissionRootReads--;
            }
            assert.equal(typeof body.id, 'string');
            const list = body.method === 'ppoi_validate_poi_merkleroots';
            assert.equal(
              body.method,
              list ? 'ppoi_validate_poi_merkleroots' : 'ppoi_validate_txid_merkleroot'
            );
            submissionWire[list ? 'list' : 'txid']++;
            assert.equal(submissionWire[list ? 'list' : 'txid'], 1);
            assert.deepEqual(body.params, {
              chainType: '0',
              chainID: '11155111',
              txidVersion: 'V2_PoseidonMerkle',
              ...(list
                ? {
                    listKey: REQUIRED_LIST,
                    poiMerkleroots: [submissionPreparedEntry.payload.poiMerkleroots[0]],
                  }
                : {
                    tree: 0,
                    index: submissionPreparedEntry.payload.txidMerklerootIndex,
                    merkleroot: submissionPreparedEntry.payload.txidMerkleroot,
                  }),
            });
          }
          return {
            status: 200,
            body: Buffer.from(
              JSON.stringify({ jsonrpc: '2.0', id: body.id, result: isPost ? null : true })
            ),
          };
        } catch (error) {
          submissionWire.unexpected++;
          const match = error?.stack?.match(/qualify-railgun-own-poi-membership\.js:(\d+):\d+/);
          console.error(
            JSON.stringify({ stage: 'submission-fixture', line: match ? Number(match[1]) : null })
          );
          throw error;
        }
      },
    };
    clients.add(client);
    return client;
  };
  // Route at the transport boundary. RPC clients and their destination/budget
  // registries stay genuine; all wire responses are local synthetic fixtures.
  transport.createWalletTorTransport = () => {
    const checking = checksActive,
      submitting = submissionActive;
    let poiTransport,
      closed = false,
      resolveClosed;
    return {
      closed: new Promise((resolve) => (resolveClosed = resolve)),
      release() {},
      close() {
        closed = true;
        poiTransport?.close();
        if (poiTransport) {
          assert.ok(poiTransport.closed instanceof Promise);
          poiTransport.closed.then(resolveClosed);
        } else resolveClosed();
      },
      async request(handle, url, options) {
        assert.equal(closed, false);
        const context = getPrivacyContext(handle);
        if (['protocol-rpc', 'transaction-rpc'].includes(context.subject.role)) {
          if (url !== rpcUrl) {
            unexpectedTransport++;
            throw Error('External RPC transport forbidden');
          }
          assert.equal(options.method, 'POST');
          assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
          const wire = JSON.parse(options.body);
          assert.equal(wire.jsonrpc, '2.0');
          assert.equal(typeof wire.id, 'string');
          const result = fixtureRpcReply(handle, wire.method, wire.params);
          return {
            status: 200,
            body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
          };
        }
        poiTransport ||= submitting
          ? createFixtureSubmissionTransport()
          : createFixturePoiTransport(checking);
        return poiTransport.request(handle, url, options);
      },
    };
  };
  const rpcModule = require('../src/main/networks/private-rpc');
  const serviceModule = require('../src/main/wallet/railgun-public-services');
  originals.rpc = rpcModule.createPrivateRpc;
  let rpcClientCreates = 0;
  originals.services = serviceModule.createRailgunPublicServices;
  processModule.startRailgunProcess = (options) => {
    const pendingActivity = pendingCheckpointActivity;
    const pendingName = pendingActivity ? pendingUtilityName(options) : undefined;
    if (pendingActivity) {
      pendingActivity.utilityStarts[pendingName]++;
      if (options.binaryKey) pendingActivity.binaryJobs++;
      assert.notEqual(pendingName, 'unexpected');
      assert.ok(!options.binaryKey);
    }
    if (planActive) {
      planWork.utilities++;
      if (options.binaryKey) planWork.utilityKeyHandoffs++;
      throw Error('Unexpected disclosure-plan utility');
    }
    if (attemptActive) {
      attemptWork.utilities++;
      if (options.binaryKey) attemptWork.utilityKeyHandoffs++;
      throw Error('Unexpected durable-attempt utility');
    }
    const recoveringOutput =
      options.filename === require.resolve('../src/main/wallet/railgun-poi-output-recover-job');
    const coldVerifying =
      coldValidationActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-poi-verify-job');
    const outputOwnSelector =
      outputRecoveryActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-own-selector-job');
    const outputOwnTxid =
      outputRecoveryActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-own-txid-job');
    const outputMirror =
      outputRecoveryActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-txid-job');
    const outputPublicPlan =
      outputRecoveryActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-public-job');
    const refuseOutputUtility = () => {
      outputRecoveryJobs.unexpected++;
      let mode, operation;
      try {
        mode = JSON.parse(options.input).mode;
      } catch {
        mode = undefined;
      }
      try {
        operation = getPrivacyContext(options.handle).subject.operation;
      } catch {
        operation = undefined;
      }
      const basename = path.basename(options.filename ?? '');
      process.stderr.write(
        JSON.stringify({
          refusedOutputUtility: /^[a-z-]+\.js$/.test(basename) ? basename : 'unrecognized',
          operation: [
            'public-scan',
            'own-txid-selector',
            'own-txid-proof',
            'poi-output-recover',
            'poi-prove',
            ...['inspect', 'witness', 'project', 'apply', 'note-witness', 'coverage'].map(
              (value) => 'txid-' + value
            ),
          ].includes(operation)
            ? operation
            : 'unrecognized',
          mode: [
            'inspect',
            'witness',
            'plan',
            'apply',
            'project',
            'note-witness',
            'coverage',
          ].includes(mode)
            ? mode
            : 'unrecognized',
        }) + '\n'
      );
      throw Error('Unexpected output recovery utility');
    };
    let outputMirrorMode;
    if (outputRecoveryActive && !coldVerifying) {
      if (!(
        outputOwnSelector ||
        outputOwnTxid ||
        outputMirror ||
        outputPublicPlan ||
        recoveringOutput
      ))
        refuseOutputUtility();
      if (outputMirror) {
        const input = JSON.parse(options.input);
        if (
          !['inspect', 'witness', ...(retainedHistoryMode ? ['historical-root'] : [])].includes(
            input.mode
          )
        )
          refuseOutputUtility();
        outputMirrorMode = input.mode;
        outputRecoveryJobs[
          outputMirrorMode === 'inspect'
            ? 'mirrorInspect'
            : outputMirrorMode === 'witness'
              ? 'mirrorWitness'
              : 'mirrorHistorical'
        ]++;
        assert.deepEqual(input, { archive, mode: outputMirrorMode });
        assert.equal(options.archive, archive);
        assert.equal(options.startupMs, 120000);
        assert.equal(options.lifetimeMs, 180000);
      }
      if (outputPublicPlan) {
        const input = JSON.parse(options.input);
        if (input.mode !== 'plan' || outputPublicPlanAdmitted) refuseOutputUtility();
        outputPublicPlanAdmitted = true;
        outputRecoveryJobs.publicPlan++;
        const {
          getRailgunAccountPublicIdentity,
        } = require('../src/main/wallet/railgun-account-public');
        const { publicId } = getRailgunAccountPublicIdentity(
          publicAccount.coordinator,
          enrollment,
          publicAccount.policy
        );
        assert.deepEqual(input, {
          archive,
          mode: 'plan',
          storeId: publicId,
          qualifiedThrough: require('../src/main/wallet/railgun-public-policy').QUALIFIED_THROUGH,
        });
        assert.equal(options.startupMs, 120000);
        assert.equal(options.lifetimeMs, 170000);
      }
      assert.equal(!!options.binaryKey, recoveringOutput);
      const context = getPrivacyContext(options.handle);
      assert.equal(context.subject.kind, 'private-account');
      assert.equal(context.subject.role, 'engine');
      assert.equal(context.subject.principal, 'railgun:' + enrollment.descriptor.accountIndex);
      assert.equal(
        context.subject.operation,
        recoveringOutput
          ? 'poi-output-recover'
          : outputOwnSelector
            ? 'own-txid-selector'
            : outputMirror
              ? 'txid-' + outputMirrorMode
              : outputPublicPlan
                ? 'public-scan'
                : 'own-txid-proof'
      );
      if (outputOwnSelector) outputRecoveryJobs.ownSelector++;
      if (outputOwnTxid) outputRecoveryJobs.ownTxid++;
      if (recoveringOutput) {
        outputRecoveryJobs.viewing++;
        assert.equal(kind, 'transfer');
        assert.equal(options.startupMs, options.lifetimeMs);
        assert.ok(options.lifetimeMs > 0 && options.lifetimeMs <= 30000);
        assert.equal(options.rssMb, 512);
        outputRecoveryInputDigest = sha(options.input);
        const input = JSON.parse(options.input);
        assert.deepEqual(Object.keys(input).sort(), [
          'archive',
          'binding',
          'descriptor',
          'preparation',
        ]);
        assert.equal(input.binding.payloadSha256, savedProof.payloadSha256);
      }
    } else assert.equal(recoveringOutput, false);
    const proving =
      options.filename === require.resolve('../src/main/wallet/railgun-own-poi-prove-job');
    const verifying =
      options.filename === require.resolve('../src/main/wallet/railgun-poi-verify-job');
    if (checksActive) {
      if (options.binaryKey) checksForbiddenJobs.binaryKey++;
      if (proving) checksForbiddenJobs.poiProver++;
      if (verifying) checksForbiddenJobs.poiVerifier++;
      assert.ok(!options.binaryKey && !proving && !verifying);
    }
    if (options.binaryKey) {
      if (phase !== 'enrollment') {
        if (!(proofMode && proofActive && proving) && !(outputRecoveryActive && recoveringOutput)) {
          forbiddenKeyJobs++;
          throw Error('Operation key release forbidden');
        }
        const context = getPrivacyContext(options.handle);
        assert.equal(context.subject.role, 'engine');
        assert.equal(
          context.subject.operation,
          recoveringOutput ? 'poi-output-recover' : 'poi-prove'
        );
      } else {
        setupKeyJobs++;
      }
    }
    if (proving) {
      assert.ok(proofMode && proofActive && options.binaryKey);
      assert.equal(options.startupMs, options.lifetimeMs);
      assert.ok(options.lifetimeMs > 10000 && options.lifetimeMs <= 110000);
      assert.equal(options.rssMb, 768);
      proofJobs.viewing++;
    }
    if (verifying && !coldVerifying) {
      assert.ok(proofMode && proofActive && !options.binaryKey);
      proofJobs.verification++;
    }
    const membership = options.filename === require.resolve('../src/main/wallet/railgun-poi-job');
    const selectorJob =
      options.filename === require.resolve('../src/main/wallet/railgun-poi-shield-selector-job');
    const checksOwnSelector =
      checksActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-own-selector-job');
    const checksOwnTxid =
      checksActive &&
      options.filename === require.resolve('../src/main/wallet/railgun-own-txid-job');
    if (checksOwnSelector || checksOwnTxid) {
      assert.ok(!options.binaryKey);
      const context = getPrivacyContext(options.handle);
      assert.equal(context.subject.kind, 'private-account');
      assert.equal(context.subject.role, 'engine');
      assert.equal(
        context.subject.operation,
        checksOwnSelector ? 'own-txid-selector' : 'own-txid-proof'
      );
      if (checksOwnSelector) checksJobs.ownSelector++;
      if (checksOwnTxid) checksJobs.ownTxid++;
    }
    if (membership) jobs.membership++;
    if (selectorJob) jobs.selector++;
    let real;
    let patched = options;
    let outputKeyRequestedAt, outputKeyRepliedAt, outputResultAt;
    if (outputRecoveryActive && !coldVerifying) {
      const originalBroker = options.broker;
      let guardSeen = false,
        mirrorSequence = 0,
        mirrorReads = 0,
        publicSequence = 0,
        publicEof = false;
      const mirrorKeys =
        outputMirrorMode === 'inspect'
          ? ['txid:state']
          : [
              'txid:state',
              ...(outputMirrorMode === 'historical-root' ? ['txid:row:0'] : []),
              'txid:lookup:' + outputRecoveryTxid,
              'txid:row:0',
              ...(mirrorAdvanced ? ['txid:node:0:1'] : []),
            ];
      patched = {
        ...options,
        broker: {
          signal: originalBroker.signal,
          async dispatch(wire) {
            if (outputMirror) outputRecoveryMirrorBroker.attempted++;
            if (outputPublicPlan) outputRecoveryPublicBroker.attempted++;
            assert.ok(
              typeof wire === 'string' &&
                Buffer.byteLength(wire) <=
                  (outputMirror || outputPublicPlan ? 2 * 1024 * 1024 : 16384)
            );
            const message = JSON.parse(wire);
            if (outputMirror) {
              if (!['input', 'get', 'result'].includes(message.method)) {
                outputRecoveryMirrorBroker.forbidden++;
                throw Error('Unexpected output recovery TXID broker operation');
              }
              outputRecoveryMirrorBroker[message.method]++;
              assert.equal(message.id, ++mirrorSequence);
              assert.equal(guardSeen, false);
              if (message.method === 'input') {
                assert.deepEqual(message, { id: 1, method: 'input' });
                const reply = await originalBroker.dispatch(wire);
                const decoded = JSON.parse(reply);
                assert.deepEqual(Object.keys(decoded).sort(), ['id', 'value']);
                assert.equal(decoded.id, message.id);
                assert.deepEqual(
                  decoded.value,
                  outputMirrorMode === 'inspect'
                    ? {}
                    : outputMirrorMode === 'historical-root'
                      ? { state: mirrorState(), index: 0 }
                      : { state: mirrorState(), txid: outputRecoveryTxid }
                );
                outputRecoveryMirrorBroker.admitted++;
                return reply;
              }
              if (message.method === 'get') {
                assert.ok(mirrorSequence > 1 && mirrorReads < mirrorKeys.length);
                assert.deepEqual(message, {
                  id: mirrorSequence,
                  method: 'get',
                  args: { key: Buffer.from(mirrorKeys[mirrorReads++]).toString('base64') },
                });
                const reply = await originalBroker.dispatch(wire);
                outputRecoveryMirrorBroker.admitted++;
                return reply;
              }
              assert.equal(mirrorReads, mirrorKeys.length);
              assert.equal(message.id, mirrorKeys.length + 2);
              assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
              if (outputMirrorMode === 'inspect') {
                assert.deepEqual(message.value.state, mirrorState());
                assert.equal(message.value.initialized, true);
              } else if (outputMirrorMode === 'historical-root') {
                const h = message.value.historicalRoot;
                assert.equal(h.index, 0);
                assert.equal(h.checkpointIndex, 1);
                assert.equal(h.root, payload.state.root);
                assert.equal(h.root, savedProof.payload.txidMerkleroot);
                assert.equal(h.checkpointRoot, laterMirror.state.root);
                assert.notEqual(h.root, h.checkpointRoot);
                assert.equal(h.transcript, laterMirror.state.transcript);
              } else {
                assert.equal(mirrorState().count, mirrorAdvanced ? 2 : 1);
                assert.equal(message.value.witness.index, 0);
                assert.equal(message.value.witness.railgunTxid, outputRecoveryTxid);
                assert.deepEqual(message.value.witness.row, payload.row);
              }
            } else if (outputPublicPlan) {
              if (!['sourceNext', 'jobResult'].includes(message.method)) {
                outputRecoveryPublicBroker.forbidden++;
                throw Error('Unexpected output recovery public broker operation');
              }
              outputRecoveryPublicBroker[message.method]++;
              assert.equal(message.id, ++publicSequence);
              assert.equal(guardSeen, false);
              if (message.method === 'sourceNext') {
                assert.equal(publicEof, false);
                assert.deepEqual(message, { id: publicSequence, method: 'sourceNext' });
                assert.ok(publicSequence === 1 || publicSequence === 2);
                const reply = await originalBroker.dispatch(wire);
                const decoded = JSON.parse(reply);
                assert.deepEqual(Object.keys(decoded).sort(), ['id', 'value']);
                assert.equal(decoded.id, message.id);
                const expected = history.map((log) => ({
                  address: log.address.toLowerCase(),
                  blockNumber: Number(BigInt(log.blockNumber)),
                  blockHash: log.blockHash,
                  transactionIndex: Number(BigInt(log.transactionIndex)),
                  transactionHash: log.transactionHash,
                  logIndex: Number(BigInt(log.logIndex)),
                  topics: log.topics,
                  data: log.data,
                }));
                assert.deepEqual(decoded.value, publicSequence === 1 ? expected : null);
                publicEof = decoded.value === null;
                outputRecoveryPublicBroker.admitted++;
                return reply;
              }
              assert.equal(publicEof, true);
              assert.equal(message.id, 3);
              assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            } else if (!recoveringOutput) {
              assert.equal(message.id, 1);
              assert.equal(message.method, 'result');
              assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            }
            if (recoveringOutput && message.id === 1) {
              outputRecoveryJobs.keyRequests++;
              outputKeyRequestedAt = performance.now();
              assert.deepEqual(message, {
                id: 1,
                method: 'key',
                purpose: 'poi-output-recover',
                inputSha256: outputRecoveryInputDigest,
              });
              const reply = await originalBroker.dispatch(wire);
              assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
              outputRecoveryJobs.keyReplies++;
              outputKeyRepliedAt = performance.now();
              outputRecoveryReplies.push(reply);
              return reply;
            }
            if (recoveringOutput) {
              outputRecoveryJobs.resultMessages++;
              outputResultAt = performance.now();
              assert.equal(message.id, 2);
              assert.equal(message.method, 'result');
              assert.equal(message.value.recoveryInputSha256, outputRecoveryInputDigest);
              assert.equal(message.value.payloadSha256, savedProof.payloadSha256);
              assert.deepEqual(message.value.output, {
                blindedCommitmentsOut: savedProof.payload.blindedCommitmentsOut,
                railgunTxidIfHasUnshield: savedProof.payload.railgunTxidIfHasUnshield,
              });
              assert.ok(outputRecoveryReplies.every((bytes) => bytes.every((v) => v === 0)));
            }
            assert.equal(guardSeen, false);
            const guards = message.value.guards;
            assert.deepEqual(Object.keys(guards).sort(), ['attempts', 'canaries', 'hooks']);
            assert.equal(guards.attempts, 0);
            assert.ok(
              Array.isArray(guards.hooks) && guards.hooks.length >= 1 && guards.hooks.length <= 256
            );
            assert.ok(
              guards.hooks.every(
                (hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook)
              )
            );
            assert.equal(new Set(guards.hooks).size, guards.hooks.length);
            assert.equal(guards.canaries, guards.hooks.length);
            guardSeen = true;
            outputRecoveryGuards.reports++;
            outputRecoveryGuards.attempts += guards.attempts;
            outputRecoveryGuards.canaryChecks += guards.canaries;
            outputRecoveryGuards.hooks = [
              ...new Set([...outputRecoveryGuards.hooks, ...guards.hooks]),
            ].sort();
            if (recoveringOutput && outputRecoveryFault === 'substituted-output') {
              const previous = message.value.output.blindedCommitmentsOut[0];
              message.value.output.blindedCommitmentsOut[0] = previous === hex(1) ? hex(2) : hex(1);
              assert.notEqual(message.value.output.blindedCommitmentsOut[0], previous);
              outputRecoveryJobs.resultSubstitutions++;
            }
            if (
              outputMirrorMode === 'historical-root' &&
              outputRecoveryFault === 'substituted-history-root'
            ) {
              const h = message.value.historicalRoot;
              h.root = h.root === hex(1).slice(2) ? hex(2).slice(2) : hex(1).slice(2);
              outputRecoveryJobs.historicalSubstitutions++;
            }
            const reply = await originalBroker.dispatch(JSON.stringify(message));
            if (recoveringOutput) outputRecoveryJobs.resultAdmissions++;
            if (outputMirror) outputRecoveryMirrorBroker.admitted++;
            if (outputPublicPlan) outputRecoveryPublicBroker.admitted++;
            if (outputOwnSelector) {
              assert.match(message.value.railgunTxid, /^[0-9a-f]{64}$/);
              outputRecoveryTxid = message.value.railgunTxid;
            }
            return reply;
          },
        },
      };
    }
    if (coldVerifying) {
      coldValidationVerifierJobs.started++;
      assert.equal(outputRecoveryActive, true);
      assert.equal(proofActive, false);
      assert.ok(!options.binaryKey);
      const context = getPrivacyContext(options.handle);
      assert.equal(context.subject.kind, 'private-account');
      assert.equal(context.subject.principal, 'railgun:' + enrollment.descriptor.accountIndex);
      assert.equal(context.subject.protocol, 'railgun');
      assert.equal(context.subject.deployment, 'sepolia');
      assert.equal(context.subject.chainId, 11155111);
      assert.equal(context.subject.role, 'prover');
      assert.equal(context.subject.operation, 'poi-verify');
      assert.ok(options.lifetimeMs > 0 && options.lifetimeMs <= 35000);
      assert.equal(options.startupMs, Math.min(30000, options.lifetimeMs));
      const input = JSON.parse(options.input);
      assert.deepEqual(input, { proverArchive, artifactDirectory, payload: savedProof.payload });
      // The output phase and all its keyless workers must have actually exited
      // before the separately claimed verifier phase starts.
      for (const name of [
        'ownSelector',
        'ownTxid',
        'mirrorInspect',
        'mirrorWitness',
        'publicPlan',
        'viewing',
      ])
        assert.equal(outputRecoveryJobs[name], outputRecoveryJobs[name + 'Exit']);
      assert.equal(
        outputRecoveryJobs.viewing,
        kind === 'transfer'
          ? coldValidationRuns.length + (submissionActive ? submissionValidationCount : 1)
          : 0
      );
      assert.ok(outputRecoveryReplies.every((bytes) => bytes.every((v) => v === 0)));
      coldValidationVerifierJobs.inputChecks++;
      const originalInputDigest = sha(options.input),
        originalBroker = options.broker;
      if (outputRecoveryFault === 'invalid-snark') {
        // On-curve negation changes only A.y; a result would invalidate this
        // control even if the host later refused its substituted input digest.
        const base = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
        const originalY = input.payload.proof.pi_a[1],
          y = BigInt(originalY);
        assert.ok(y > 0n && y < base);
        input.payload.proof.pi_a[1] = String(base - y);
        assert.notEqual(input.payload.proof.pi_a[1], originalY);
        const changed =
          require('../src/main/wallet/railgun-poi-payload').normalizeRailgunPoiPayload(
            input.payload
          );
        assert.notEqual(sha(JSON.stringify(changed)), savedProof.payloadSha256);
        const restored = copy(changed);
        restored.proof.pi_a[1] = originalY;
        assert.deepEqual(restored, savedProof.payload);
        coldValidationVerifierJobs.inputSubstitutions++;
      }
      const wireInput =
        outputRecoveryFault === 'invalid-snark' ? JSON.stringify(input) : options.input;
      let resultSeen = false;
      patched = {
        ...options,
        input: wireInput,
        broker: {
          signal: originalBroker.signal,
          async dispatch(wire) {
            coldValidationVerifierJobs.resultMessages++;
            assert.equal(resultSeen, false);
            resultSeen = true;
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const message = JSON.parse(wire);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            const value = message.value;
            assert.deepEqual(Object.keys(value).sort(), [
              'disclosureEnabled',
              'guards',
              'inputSha256',
              'membershipAuthenticated',
              'payloadSha256',
              'proofVerified',
              'proverSha256',
              'rootAccepted',
              'sourceAuthenticated',
              'spendingEnabled',
            ]);
            assert.equal(value.inputSha256, originalInputDigest);
            assert.equal(value.payloadSha256, savedProof.payloadSha256);
            assert.equal(
              value.proverSha256,
              require('../src/main/wallet/railgun-prover-manifest.json').sha256
            );
            coldValidationVerifierJobs.hashChecks++;
            assert.equal(value.proofVerified, true);
            for (const name of [
              'sourceAuthenticated',
              'membershipAuthenticated',
              'rootAccepted',
              'disclosureEnabled',
              'spendingEnabled',
            ])
              assert.equal(value[name], false);
            const guards = value.guards;
            assert.deepEqual(Object.keys(guards).sort(), ['attempts', 'canaries', 'hooks']);
            assert.equal(guards.attempts, 0);
            assert.ok(
              Array.isArray(guards.hooks) && guards.hooks.length >= 1 && guards.hooks.length <= 256
            );
            assert.ok(
              guards.hooks.every(
                (hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook)
              )
            );
            assert.equal(new Set(guards.hooks).size, guards.hooks.length);
            assert.equal(guards.canaries, guards.hooks.length);
            coldValidationGuards.reports++;
            coldValidationGuards.attempts += guards.attempts;
            coldValidationGuards.canaryChecks += guards.canaries;
            coldValidationGuards.hooks = [
              ...new Set([...coldValidationGuards.hooks, ...guards.hooks]),
            ].sort();
            const reply = await originalBroker.dispatch(wire);
            assert.deepEqual(JSON.parse(reply), { id: 1, value: null });
            coldValidationVerifierJobs.resultAdmissions++;
            return reply;
          },
        },
      };
    }
    if (checksOwnSelector || checksOwnTxid) {
      const originalBroker = options.broker;
      let guardSeen = false;
      patched = {
        ...options,
        broker: {
          signal: originalBroker.signal,
          async dispatch(wire) {
            const reply = await originalBroker.dispatch(wire);
            assert.equal(guardSeen, false);
            assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 16384);
            const guards = JSON.parse(wire).value.guards;
            assert.deepEqual(Object.keys(guards).sort(), ['attempts', 'canaries', 'hooks']);
            assert.equal(guards.attempts, 0);
            assert.ok(
              Array.isArray(guards.hooks) && guards.hooks.length >= 1 && guards.hooks.length <= 256
            );
            assert.ok(
              guards.hooks.every(
                (hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook)
              )
            );
            assert.equal(new Set(guards.hooks).size, guards.hooks.length);
            assert.equal(guards.canaries, guards.hooks.length);
            guardSeen = true;
            checksGuards.reports++;
            checksGuards.attempts += guards.attempts;
            checksGuards.canaryChecks += guards.canaries;
            checksGuards.hooks = [...new Set([...checksGuards.hooks, ...guards.hooks])].sort();
            return reply;
          },
        },
      };
    }
    if (proving) {
      const originalBroker = options.broker;
      patched = {
        ...options,
        broker: {
          signal: originalBroker.signal,
          async dispatch(wire) {
            proofJobs.maxWireBytes = Math.max(proofJobs.maxWireBytes, Buffer.byteLength(wire));
            assert.ok(Buffer.byteLength(wire) <= 32768);
            const message = JSON.parse(wire);
            if (message.id === 1) {
              if (proofFault === 'purpose') message.purpose = 'spending-sign';
              if (proofFault === 'hash') message.inputSha256 = 'f'.repeat(64);
              if (proofFault === 'extra') message.extra = true;
              if (proofFault === 'result-before-key') {
                message.method = 'result';
                message.value = {};
              }
              const reply = await originalBroker.dispatch(JSON.stringify(message));
              assert.ok(reply instanceof Uint8Array && reply.byteLength === 32);
              proofJobs.keyReplies++;
              viewingReplies.push(reply); // Retain only to assert supervisor zeroization.
              if (proofFault === 'close-after-key') setTimeout(() => real.close(), 10);
              if (proofFault === 'cancel') setTimeout(() => proofCaller.abort(), 10);
              return reply;
            }
            proofJobs.resultMessages++;
            if (proofFault === 'double-key')
              return originalBroker.dispatch(
                JSON.stringify({
                  id: 2,
                  method: 'key',
                  purpose: 'poi-prove',
                  inputSha256: 'f'.repeat(64),
                })
              );
            if (proofFault === 'root' || proofFault === 'proof') {
              if (proofFault === 'root') message.value.payload.txidMerkleroot = hex(17).slice(2);
              else {
                // Negation keeps A on the curve; the pairing must reject the proof.
                const base =
                  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
                const y = BigInt(message.value.payload.proof.pi_a[1]);
                assert.ok(y > 0n && y < base);
                message.value.payload.proof.pi_a[1] = String(base - y);
              }
              message.value.payloadSha256 = sha(
                JSON.stringify(
                  require('../src/main/wallet/railgun-poi-payload').normalizeRailgunPoiPayload(
                    message.value.payload
                  )
                )
              );
            }
            const reply = await originalBroker.dispatch(JSON.stringify(message));
            proofJobs.resultAdmissions++;
            return reply;
          },
        },
      };
    }
    if (pendingActivity && patched.broker) {
      const broker = patched.broker;
      patched = {
        ...patched,
        broker: {
          ...broker,
          dispatch(wire) {
            const message = JSON.parse(wire);
            if (message.method === 'key') pendingActivity.keyRequests++;
            assert.notEqual(message.method, 'key');
            return broker.dispatch(wire);
          },
        },
      };
    }
    const jobStarted = performance.now();
    real = originals.start(patched);
    real.closed.then((exit) => {
      if (pendingActivity) pendingActivity.utilityExits[pendingName]++;
      if (coldVerifying) {
        coldValidationVerifierJobs.exited++;
        coldValidationVerifierTimings.push({
          mode: outputRecoveryFault,
          exitCode: exit.code,
          elapsedMs: Math.ceil(performance.now() - jobStarted),
          budgetMs: options.lifetimeMs,
          peakRssBytes: exit.peakRssBytes,
          rssMeasurement: exit.peakRssBytes > 0 ? 'sampled-peak' : 'no-positive-sample-before-exit',
        });
      }
      if (outputOwnSelector) outputRecoveryJobs.ownSelectorExit++;
      if (outputOwnTxid) outputRecoveryJobs.ownTxidExit++;
      if (outputPublicPlan) outputRecoveryJobs.publicPlanExit++;
      if (outputMirror)
        outputRecoveryJobs[
          outputMirrorMode === 'inspect'
            ? 'mirrorInspectExit'
            : outputMirrorMode === 'witness'
              ? 'mirrorWitnessExit'
              : 'mirrorHistoricalExit'
        ]++;
      if (outputRecoveryActive && recoveringOutput) {
        outputRecoveryJobs.viewingExit++;
        outputRecoveryTimings.push({
          mode: outputRecoveryFault,
          exitCode: exit.code,
          elapsedMs: Math.ceil(performance.now() - jobStarted),
          budgetMs: options.lifetimeMs,
          peakRssBytes: exit.peakRssBytes,
          keyRequestAfterMs: Math.ceil(outputKeyRequestedAt - jobStarted),
          keyReplyAfterMs: Math.ceil(outputKeyRepliedAt - jobStarted),
          keyRequestToReplyMs: Math.ceil(outputKeyRepliedAt - outputKeyRequestedAt),
          keyRequestToResultMs: Math.ceil(outputResultAt - outputKeyRequestedAt),
          keyReplyToResultMs: Math.ceil(outputResultAt - outputKeyRepliedAt),
          resultAfterMs: Math.ceil(outputResultAt - jobStarted),
        });
      }
      if (checksOwnSelector) checksJobs.ownSelectorExit++;
      if (checksOwnTxid) checksJobs.ownTxidExit++;
      if (membership) jobs.membershipExit++;
      if (selectorJob) jobs.selectorExit++;
      if (proving) {
        proofJobs.viewingExit++;
        proofJobs.peakRssBytes = Math.max(proofJobs.peakRssBytes, exit.peakRssBytes);
        proofExits.push({
          cause: exit.code,
          elapsedMs: Math.round(performance.now() - jobStarted),
          budgetMs: options.lifetimeMs,
        });
      }
      if (verifying && !coldVerifying) proofJobs.verificationExit++;
    });
    if (proving && proofFault === 'early-timeout') {
      // The actual job completes, but the fixture withholds ready admission.
      // The production early deadline must close/drain it before store expiry.
      const ready = real.ready.then(
        () =>
          new Promise((_resolve, reject) => {
            const abort = () => reject(Error('fixture deferred ready aborted'));
            if (real.signal.aborted) abort();
            else real.signal.addEventListener('abort', abort, { once: true });
          })
      );
      return Object.freeze({ ...real, ready });
    }
    if (membership && mode === 'utility-drain') {
      let deferredClose = false;
      return Object.freeze({
        ...real,
        close() {
          if (!deferredClose) {
            deferredClose = true;
            heldTask = real;
            hold.resolve(); // A result is admitted, but the genuine child has not been closed yet.
          } else real.close();
        },
      });
    }
    return real;
  };
  rpcModule.createPrivateRpc = (...args) => {
    rpcClientCreates++;
    return originals.rpc(...args);
  };
  function fixtureRpcReply(handle, method, params) {
    const context = getPrivacyContext(handle),
      role = context.subject.role;
    assert.ok(['transaction-rpc', 'protocol-rpc'].includes(role));
    if (role === 'transaction-rpc')
      assert.equal(context.subject.principal, fixture.transaction.from);
    if (pendingCheckpointActivity) {
      if (pendingRpcNames.includes(method)) pendingCheckpointActivity.rpcByRole[role][method]++;
      else pendingCheckpointActivity.unexpectedRpc++;
    }
    rpcMethods[method] = (rpcMethods[method] ?? 0) + 1;
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
    let value;
    if (method === 'eth_chainId') {
      assert.deepEqual(params, []);
      value = '0xaa36a7';
    } else if (method === 'eth_getLogs') {
      assert.equal(role, 'protocol-rpc');
      assert.equal(params[0].address, fixture.receipt.to);
      value = history.filter(
        (log) =>
          BigInt(log.blockNumber) >= BigInt(params[0].fromBlock) &&
          BigInt(log.blockNumber) <= BigInt(params[0].toBlock)
      );
    } else if (method === 'eth_blockNumber') {
      assert.deepEqual(params, []);
      value = tag(FINALIZED);
    } else if (method === 'eth_getBlockByNumber') {
      assert.equal(params[1], false);
      const number = params[0] === 'finalized' ? FINALIZED : Number(BigInt(params[0]));
      assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= FINALIZED);
      value = { number: tag(number), hash: blockHash(number), parentHash: blockHash(number - 1) };
    } else {
      assert.deepEqual(params, [fixture.transaction.hash]);
      value = method === 'eth_getTransactionReceipt' ? fixture.receipt : fixture.transaction;
    }
    return copy(value);
  }
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
        publicMethods.latest++;
        active();
        return { index: mirrorState().count - 1, root: mirrorState().root };
      },
      async validateTxidRoot(point) {
        publicMethods.validate++;
        active();
        // During retained validation every observation must target the current
        // checkpoint. The old root is accepted only while setup advances it.
        if (outputRecoveryActive && mirrorAdvanced)
          assert.deepEqual(point, {
            tree: 0,
            index: laterMirror.state.count - 1,
            root: laterMirror.state.root,
          });
        assert.deepEqual(point, {
          tree: 0,
          index: point.index === 0 ? 0 : mirrorState().count - 1,
          root: point.index === 0 ? payload.state.root : mirrorState().root,
        });
        return true;
      },
      async txidPage(after) {
        publicMethods.page++;
        active();
        if (after === '0x00') return { transactions: [payload.row] };
        assert.ok(retainedHistoryMode && mirrorAdvanced);
        assert.equal(after, payload.state.after);
        return { transactions: [laterMirror.row] };
      },
    };
  };
  const sourceMaintenance = { stages: 0, retains: 0, beforeAcquire: 0, applies: 0 };
  let currentScanJournal,
    interruptAfterPrepare = false,
    preparedInterruption;
  let preparedInterruptionFires = 0,
    delegatedApplies = 0;
  // Capture the genuine journal without replacing any method, return value,
  // storage, or outcome. Install before the coordinator captures its factory.
  const scanJournalModule = require('../src/main/wallet/railgun-scan-journal');
  originals.scanJournal = scanJournalModule.createRailgunScanJournal;
  scanJournalModule.createRailgunScanJournal = async (options) => {
    const journal = await originals.scanJournal(options);
    currentScanJournal = journal;
    return journal;
  };
  for (const file of ['./railgun-account-store', './railgun-account-public'])
    assert.equal(require.cache[require.resolve('../src/main/wallet/' + file.slice(2))], undefined);
  const ledgerModule = require('../src/main/wallet/railgun-source-ledger'),
    sourceModule = require('../src/main/wallet/railgun-scan-source'),
    coordinatorModule = require('../src/main/wallet/railgun-scan-coordinator');
  originals.ledger = ledgerModule.createRailgunSourceLedger;
  originals.source = sourceModule.createRailgunScanSource;
  originals.coordinator = coordinatorModule.createRailgunScanCoordinator;
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
      applyRange: async (...args) => {
        sourceMaintenance.applies++;
        if (interruptAfterPrepare) {
          interruptAfterPrepare = false;
          preparedInterruptionFires++;
          preparedInterruption = await currentScanJournal.readState();
          assert.ok(preparedInterruption.pending && preparedInterruption.checkpoint);
          throw Error('Fixture interrupted after real scan preparation');
        }
        delegatedApplies++;
        return options.applyRange(...args);
      },
    });
  // Observe real retained preflight/source durations without replacing source
  // observations or clock authority. The canonical timestamp stays internal.
  const retainedPreflightTimings = [],
    retainedRestorations = [];
  let activeRetainedTiming;
  const retainedCapture = require('../src/main/wallet/railgun-poi-source-capture');
  const originalRetainedCapture = retainedCapture.captureRailgunPoiSourceForRetainedInput;
  retainedCapture.captureRailgunPoiSourceForRetainedInput = async (options) => {
    const entry = activeRetainedTiming;
    assert.ok(entry);
    assert.equal(entry.sourceCalls++, 0);
    const started = performance.now();
    entry.sourceStartMs = Math.round(started - entry.started);
    entry.sourceScopeBudgetMs = options.timeoutMs;
    entry.sourceSnapshotBudgetMs = Math.min(180000, options.timeoutMs - 55000);
    assert.ok(entry.sourceSnapshotBudgetMs > 0 && options.timeoutMs <= 180000);
    try {
      return await originalRetainedCapture(options);
    } finally {
      entry.sourceReturned = performance.now();
      entry.sourceElapsedMs = Math.round(entry.sourceReturned - started);
    }
  };
  retainedRestorations.push(() => {
    retainedCapture.captureRailgunPoiSourceForRetainedInput = originalRetainedCapture;
  });
  const retainedWitness = require('../src/main/wallet/railgun-own-witness');
  for (const name of [
    'preflightRailgunRetainedPoiCompleted',
    'preflightRailgunRetainedPoiForSubmission',
  ]) {
    const original = retainedWitness[name];
    retainedWitness[name] = async (...args) => {
      assert.equal(activeRetainedTiming, undefined);
      const entry = { started: performance.now(), sourceCalls: 0 };
      activeRetainedTiming = entry;
      try {
        return await original(...args);
      } finally {
        const finished = performance.now();
        retainedPreflightTimings.push({
          mode: name === 'preflightRailgunRetainedPoiForSubmission' ? 'submission' : 'completed',
          sourceCalls: entry.sourceCalls,
          ...(entry.sourceReturned === undefined
            ? {}
            : {
                sourceStartMs: entry.sourceStartMs,
                sourceScopeBudgetMs: entry.sourceScopeBudgetMs,
                sourceSnapshotBudgetMs: entry.sourceSnapshotBudgetMs,
                sourceElapsedMs: entry.sourceElapsedMs,
                sourceReturnToCompletionMs: Math.round(finished - entry.sourceReturned),
              }),
          elapsedMs: Math.round(finished - entry.started),
        });
        activeRetainedTiming = undefined;
      }
    };
    retainedRestorations.push(() => {
      retainedWitness[name] = original;
    });
  }
  const vault = require('../src/main/identity/vault');
  const { openRailgunIdentity } = require('../src/main/wallet/railgun-identity');
  const { openRailgunAccountEnrollment } = require('../src/main/wallet/railgun-account-enrollment');
  const { openRailgunAccountPublic } = require('../src/main/wallet/railgun-account-public');
  const { openRailgunAccountTxid } = require('../src/main/wallet/railgun-account-txid');
  const {
    captureRailgunOwnOperation,
    withRailgunOwnOperationRecovery,
  } = require('../src/main/wallet/railgun-own-operation');
  const { getPrivateSubmissionJournal } = require('../src/main/wallet/private-submission-journal');
  const {
    extractRailgunTransactIntent,
    railgunTransactJournalIntent,
  } = require('../src/main/wallet/railgun-transact-intent');
  const { TRANSACT_ABI } = require('../src/main/wallet/railgun-private-policy');
  const { openRailgunTransactRecovery } = require('../src/main/wallet/railgun-transact-recovery');
  const { claimRailgunAccountPhase } = require('../src/main/wallet/railgun-account-phase');
  const {
    openRailgunOwnPoiMembership: open,
    assertRailgunOwnPoiMembership: assertMembership,
  } = require('../src/main/wallet/railgun-own-poi-membership');
  const { proveRailgunOwnPoi } = require('../src/main/wallet/railgun-own-poi-proof');
  const {
    openRailgunOwnPoiChecks,
    assertRailgunOwnPoiChecks,
  } = require('../src/main/wallet/railgun-own-poi-checks');
  const { recoverRailgunPoiOutput } = require('../src/main/wallet/railgun-poi-output-recovery');
  const {
    validateRailgunRetainedPoi,
    validateRailgunRetainedPoiHistory,
  } = require('../src/main/wallet/railgun-poi-cold-validation');
  const runs = [],
    recoveryRuns = [];
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
      }),
      lifetimeMs: 60000,
      broker: {
        signal: enrollment.signal,
        async dispatch(wire) {
          assert.equal(payload, undefined);
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 32768);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          assert.deepEqual(Object.keys(message.value).sort(), [
            'blindedCommitment',
            'creator',
            'descriptor',
            'expectedHash',
            'guards',
            'noteHash',
            'pathElements',
            'proof',
            'row',
            'state',
            'transaction',
          ]);
          assert.equal(message.value.guards.attempts, 0);
          payload = message.value;
          return JSON.stringify({ id: 1, value: null });
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
    assert.deepEqual(
      payload.pathElements,
      require('../src/main/wallet/railgun-public-records')
        .ZERO_NODES.slice(0, 16)
        .map((v) => '0x' + v)
    );
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
      assert.equal(payload.row.utxoBatchStartPositionOut, 1);
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Transact', [0, 1, inner[3], inner[4][6]])
      );
    } else {
      assert.equal(intent.expected.recipient, owner);
      assert.equal(intent.expected.amount, '1000');
      assert.equal(payload.row.utxoTreeOut, 99999);
      assert.equal(payload.row.utxoBatchStartPositionOut, 99999);
      assert.deepEqual(payload.row.unshield, {
        tokenData: payload.creator.preimage.token,
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
    const c = payload.creator;
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
      blockHash: blockHash(CREATOR_BLOCK),
      blockNumber: tag(CREATOR_BLOCK),
      transactionIndex: '0x0',
      logIndex: '0x0',
      removed: false,
    };
    history = [priorShield, ...fixture.receipt.logs];
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
    capsule.selection = { kind: decoded.expected.kind, tree: 0, position: 0, recipient };
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
      tree: 0,
      position: 0,
      nullifier: decoded.expected.nullifier,
      noteHash: payload.noteHash,
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
    const selector = { tree: 0, position: 0, nullifier: facts.nullifier, noteHash: facts.noteHash };
    const capture = () =>
      captureRailgunOwnOperation({ enrollment, selector, signal: enrollment.signal });
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
    journal = openJournal();
    phase = 'resolution';
    await journal.begin(fixture.transaction.hash, 3, fixture.record.intent);
    await journal.markSubmitted(fixture.transaction.hash);
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
    restoreClock = undefined;
    recovery.close();
    recovery = undefined;
    const baseline = await capture();
    assert.equal(baseline.status, 'captured');
    const withRecovery = (use, signal = enrollment.signal) => {
      const work = withRailgunOwnOperationRecovery(
        {
          enrollment,
          selector,
          signal: AbortSignal.any([signal, operationsController.signal]),
        },
        use
      );
      pendingOperations.add(work);
      return work.finally(() => pendingOperations.delete(work));
    };
    const assertWindowClosed = async (window) => {
      assert.equal(window.signal.aborted, true);
      assert.throws(() => window.assertCurrent());
      await assert.rejects(async () => window.reattest());
    };
    phase = 'retained-recovery';
    let retained;
    const value = { diagnostic: 'public-fixture' };
    const used = await withRecovery(async (window) => {
      retained = window;
      assert.deepEqual(Object.keys(window).sort(), [
        'assertCurrent',
        'capture',
        'reattest',
        'signal',
      ]);
      assert.equal(Object.isFrozen(window), true);
      assert.equal(Object.isFrozen(window.capture), true);
      assert.deepEqual(window.capture, baseline.capture);
      window.assertCurrent(1000);
      assert.throws(() => claimRailgunAccountPhase(enrollment, 'recovery'));
      const latest = await window.reattest();
      assert.deepEqual(latest, baseline.capture);
      assert.notEqual(latest, window.capture);
      return value;
    });
    assert.deepEqual(used, { status: 'used', value });
    assert.notEqual(used.value, value);
    assert.equal(Object.isFrozen(used.value), true);
    value.diagnostic = 'changed-after-callback';
    assert.equal(used.value.diagnostic, 'public-fixture');
    await assertWindowClosed(retained);
    recoveryRuns.push({ mode: phase, freshReattestation: true, closedWindowRefused: true });

    phase = 'retained-routine-refresh';
    let updated;
    const recoveryRefreshed = await withRecovery(async (window) => {
      const current = (await journal.list())[0];
      updated = await journal.observe(
        current.hash,
        {
          ...current.observation,
          confirmations: current.observation.confirmations + 1,
          observedAt: current.observation.observedAt + 1,
        },
        current.revision
      );
      assert.ok(updated.resolution);
      const latest = await window.reattest();
      assert.equal(latest.bindingDigest, window.capture.bindingDigest);
      assert.equal(latest.record.revision, current.revision + 1);
      assert.deepEqual(latest.record, updated);
      return { refreshed: true };
    });
    assert.deepEqual(recoveryRefreshed, { status: 'used', value: { refreshed: true } });
    assert.deepEqual((await journal.list())[0], updated);
    recoveryRuns.push({ mode: phase, newJournalRecordRead: true, stableBinding: true });

    for (const fault of ['callback-refusal', 'result-bound']) {
      phase = 'retained-' + fault;
      const beforeJournal = await journal.readSnapshot();
      const refused = await withRecovery(async () => {
        if (fault === 'callback-refusal') throw Error('private-fixture-sentinel');
        return { data: 'x'.repeat(32768) };
      });
      assert.equal(refused.status, 'refused');
      assert.doesNotMatch(JSON.stringify(refused), /private-fixture-sentinel|xxx/);
      assert.equal((await capture()).status, 'captured');
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      recoveryRuns.push({ mode: phase, refused: true, healthyCaptureAfterRefusal: true });
    }

    phase = 'retained-cancellation';
    const recoveryCaller = new AbortController(),
      callbackEntered = deferred(),
      releaseCallback = deferred();
    recoveryReleases.add(releaseCallback);
    let callbackWindow,
      callbackSettled = false;
    const cancelled = withRecovery(async (window) => {
      callbackWindow = window;
      callbackEntered.resolve();
      await releaseCallback.promise;
      return { diagnostic: true };
    }, recoveryCaller.signal).then((result) => {
      callbackSettled = true;
      return result;
    });
    await callbackEntered.promise;
    recoveryCaller.abort();
    await assertWindowClosed(callbackWindow);
    assert.equal(callbackSettled, false);
    assert.throws(() => claimRailgunAccountPhase(enrollment, 'recovery'));
    releaseCallback.resolve();
    recoveryReleases.delete(releaseCallback);
    assert.equal((await cancelled).status, 'refused');
    const freed = claimRailgunAccountPhase(enrollment, 'recovery');
    freed.release();
    assert.equal((await capture()).status, 'captured');
    recoveryRuns.push({
      mode: phase,
      phaseHeldUntilCallbackDrain: true,
      healthyCaptureAfterRefusal: true,
    });

    phase = 'retained-abandoned-reattest';
    let abandonedSettled = false;
    const abandoned = await withRecovery(async (window) => {
      // Deliberately abandon the public promise. The window must observe and
      // drain its store work itself before releasing the recovery phase.
      window.reattest().then(
        () => {
          abandonedSettled = true;
        },
        () => {
          abandonedSettled = true;
        }
      );
      return { diagnostic: true };
    });
    assert.equal(abandoned.status, 'refused');
    assert.equal(abandonedSettled, true);
    assert.equal((await capture()).status, 'captured');
    recoveryRuns.push({ mode: phase, pendingReadDrained: true, healthyCaptureAfterRefusal: true });
    assert.equal(recoveryRuns.length, 6);
    phase = 'public-prefix';
    publicAccount = await openRailgunAccountPublic({ enrollment, archive, create: true });
    let advances = 0;
    for (let from = 0; from <= OWN_BLOCK; from += 100000) {
      await publicAccount.advance({
        to: Math.min(from + 99999, OWN_BLOCK),
        anchor: { number: FINALIZED, hash: blockHash(FINALIZED) },
      });
      advances++;
    }
    assert.equal(advances, 60);
    // Positive control: ordinary setup must exercise every delegating counter
    // before zero deltas can establish completed-reader maintenance exclusion.
    const setupSourceMaintenance = copy(sourceMaintenance);
    for (const count of Object.values(setupSourceMaintenance)) assert.ok(count > 0);
    phase = 'mirror';
    txid = await openRailgunAccountTxid({
      enrollment,
      archive,
      coordinator: publicAccount.coordinator,
      create: true,
    });
    await txid.advance();
    await txid.close();
    txid = undefined;
    const call = (options = {}) => {
      const work = open({
        enrollment,
        coordinator: publicAccount.coordinator,
        archive,
        selector,
        ...options,
        signal: AbortSignal.any([
          enrollment.signal,
          operationsController.signal,
          options.signal ?? enrollment.signal,
        ]),
      }).then((value) => {
        if (value.status === 'verified') {
          assert.ok(value.closed instanceof Promise);
          results.add(value);
        }
        return value;
      });
      pendingOperations.add(work);
      return work.finally(() => pendingOperations.delete(work));
    };
    const counts = () => ({
      poi: Object.values(poiMethods),
      signatures: signature.attempts(),
      ...jobs,
      latest: publicMethods.latest,
      roots: publicMethods.validate,
      pages: publicMethods.page,
    });
    const checkDelta = (a, expected, membershipJobs, signatureChecks = 1) => {
      const b = counts();
      assert.deepEqual(
        b.poi.map((n, i) => n - a.poi[i]),
        expected
      );
      assert.equal(b.signatures - a.signatures, signatureChecks);
      assert.equal(b.membership - a.membership, membershipJobs);
      assert.equal(b.membershipExit - a.membershipExit, membershipJobs);
      assert.equal(b.selector - a.selector, 1);
      assert.equal(b.selectorExit - a.selectorExit, 1);
      assert.equal(b.latest - a.latest, 3);
      assert.equal(b.roots - a.roots, 3);
      assert.equal(b.pages, a.pages);
      assert.equal(unexpectedTransport, 0);
      assert.equal(unexpectedRpc, 0);
      assert.equal(forbiddenKeyJobs, 0);
    };
    const success = async (name) => {
      phase = name;
      mode = 'valid';
      const a = counts(),
        snapshot = await journal.readSnapshot();
      const value = await call();
      assert.equal(value.status, 'verified', 'membership stage ' + value.stage);
      const o = assertMembership(value.receipt, enrollment, publicAccount.coordinator, 1000);
      assert.equal(o, value.observation);
      assert.equal(o.capture.bindingDigest, baseline.capture.bindingDigest);
      assert.deepEqual(o.capture.capsule, capsule);
      assert.deepEqual(o.poiPreparation.creator, payload.creator);
      assert.deepEqual(o.membership.proofs, [payload.proof]);
      assert.equal(o.membership.membershipVerified, true);
      assert.equal(o.membership.rootsAccepted, true);
      assert.equal(o.membership.trust, 'unverified-service');
      assert.equal(o.selector.blindedCommitment, payload.blindedCommitment);
      for (const flag of [
        'accountAuthenticated',
        'sourceAuthenticated',
        'currentFinalityVerified',
        'spendingEnabled',
        'disclosureEnabled',
      ])
        assert.equal(o[flag], false);
      assert.throws(() => assertMembership({}, enrollment, publicAccount.coordinator));
      assert.throws(() => assertMembership(value.receipt, {}, publicAccount.coordinator));
      assert.throws(() => assertMembership(value.receipt, enrollment, {}));
      assert.throws(() =>
        assertMembership(value.receipt, enrollment, publicAccount.coordinator, 60000)
      );
      value.close();
      await value.closed;
      results.delete(value);
      assert.throws(() => assertMembership(value.receipt, enrollment, publicAccount.coordinator));
      assert.deepEqual(await journal.readSnapshot(), snapshot);
      checkDelta(a, [1, 1, 1, 1], 1);
      runs.push({
        mode: name,
        verified: true,
        journalUnchanged: true,
        forgedAndClosedReceiptsRefused: true,
        sourceCalls: [1, 1, 1, 1],
        signatureChecks: 1,
        membershipJobs: 1,
        exitsObserved: true,
      });
      return o;
    };
    for (const [name, options, stage] of [
      ['caller-proof-injection', { listProofs: [payload.proof] }, 'context'],
      ['forged-enrollment', { enrollment: {} }, 'context'],
      ['wrong-selector', { selector: { ...selector, position: 1 } }, 'preflight:capture:selection'],
    ]) {
      phase = name;
      const a = counts(),
        snapshot = await journal.readSnapshot(),
        beforeRpc = copy(rpcMethods);
      assert.deepEqual(await call(options), { status: 'refused', stage });
      assert.deepEqual(counts(), a);
      assert.deepEqual(rpcMethods, beforeRpc);
      assert.deepEqual(await journal.readSnapshot(), snapshot);
      runs.push({ mode: name, refused: true, stage, noPoiOrChainCalls: true });
    }
    await success('active');
    phase = 'idle-transport-drain';
    membershipDrain = {
      release: deferred(),
      closeRequested: deferred(),
      requestSettled: deferred(),
    };
    membershipDrainGates.add(membershipDrain);
    const idleBefore = counts(),
      idleMember = await call();
    assert.equal(idleMember.status, 'verified');
    checkDelta(idleBefore, [1, 1, 1, 1], 1);
    let idleClosed = false;
    assert.ok(idleMember.closed instanceof Promise);
    idleMember.closed.then(() => {
      idleClosed = true;
    });
    idleMember.close();
    await membershipDrain.closeRequested.promise;
    assert.throws(() =>
      assertMembership(idleMember.receipt, enrollment, publicAccount.coordinator)
    );
    const idleBusy = counts();
    assert.deepEqual(await call(), { status: 'refused', stage: 'context' });
    assert.deepEqual(counts(), idleBusy);
    assert.equal(idleClosed, false);
    membershipDrain.release.resolve();
    await idleMember.closed;
    assert.equal(idleClosed, true);
    results.delete(idleMember);
    membershipDrain = undefined;
    const reopenBefore = counts(),
      reopenedMember = await call();
    assert.equal(reopenedMember.status, 'verified');
    checkDelta(reopenBefore, [1, 1, 1, 1], 1);
    reopenedMember.close();
    await reopenedMember.closed;
    results.delete(reopenedMember);
    runs.push({
      mode: 'idle-transport-drain',
      revokedImmediately: true,
      directoryHeldUntilTransport: true,
      reopenedAfterDrain: true,
    });

    phase = 'routine-journal-refresh';
    let refreshed;
    const refreshCounts = counts();
    onRoot = async () => {
      const current = (await journal.list())[0];
      refreshed = await journal.observe(
        current.hash,
        {
          ...current.observation,
          confirmations: current.observation.confirmations + 1,
          observedAt: current.observation.observedAt + 1,
        },
        current.revision
      );
      assert.ok(refreshed.resolution);
      assert.equal(refreshed.revision, current.revision + 1);
    };
    const refreshResult = await call();
    onRoot = undefined;
    assert.equal(refreshResult.status, 'verified', 'refresh stage ' + refreshResult.stage);
    assert.equal(
      assertMembership(refreshResult.receipt, enrollment, publicAccount.coordinator).capture
        .bindingDigest,
      baseline.capture.bindingDigest
    );
    assert.deepEqual((await journal.list())[0], refreshed);
    refreshResult.close();
    await refreshResult.closed;
    results.delete(refreshResult);
    checkDelta(refreshCounts, [1, 1, 1, 1], 1);
    runs.push({
      mode: phase,
      verified: true,
      routineObservationRefreshAccepted: true,
      stableCaptureBinding: true,
    });
    phase = 'archive-transition';
    const record = (await journal.list())[0];
    const archiveCounts = counts();
    onRoot = () =>
      journal.archiveResolved(
        [{ hash: record.hash, revision: record.revision }],
        [{ blockNumber: FINALIZED, blockHash: blockHash(FINALIZED) }]
      );
    assert.deepEqual(await call(), { status: 'refused', stage: 'after-query' });
    onRoot = undefined;
    checkDelta(archiveCounts, [1, 1, 1, 1], 1);
    assert.equal((await journal.readSnapshot()).archive.length, 1);
    runs.push({
      mode: phase,
      refused: true,
      stage: 'after-query',
      membershipCompletedBeforeFinalCapture: true,
    });
    const archived = await success('archived');
    assert.ok(Object.hasOwn(archived.capture.record, 'archivedAt'));
    await publicAccount.close();
    publicAccount = undefined;
    enrollment.close();
    enrollment = await openRailgunAccountEnrollment({ identity });
    journal = openJournal();
    publicAccount = await openRailgunAccountPublic({ enrollment, archive });
    const reopened = await success('enrollment-store-reopen');
    assert.deepEqual(reopened.capture, archived.capture);
    const refusalStages = {
      status: 'membership-status',
      signature: 'acquire',
      root: 'membership-status',
      path: 'membership-verify',
      index: 'membership-verify',
    };
    for (const fault of Object.keys(refusalStages)) {
      phase = fault;
      mode = fault;
      const a = counts(),
        snapshot = await journal.readSnapshot();
      const result = await call();
      assert.deepEqual(result, { status: 'refused', stage: refusalStages[fault] });
      const expected =
        fault === 'status' ? [1, 0, 0, 0] : fault === 'signature' ? [1, 1, 1, 0] : [1, 1, 1, 1];
      checkDelta(
        a,
        expected,
        ['path', 'index'].includes(fault) ? 1 : 0,
        fault === 'status' ? 0 : 1
      );
      assert.deepEqual(await journal.readSnapshot(), snapshot);
      runs.push({
        mode: fault,
        refused: true,
        stage: result.stage,
        sourceCalls: expected,
        membershipJobs: ['path', 'index'].includes(fault) ? 1 : 0,
        journalUnchanged: true,
      });
    }
    for (const [fault, drainOrder] of [
      ['transport-drain', 'request-first'],
      ['transport-drain', 'close-first'],
      ['utility-drain', null],
    ]) {
      phase = fault + (drainOrder ? ':' + drainOrder : '');
      mode = fault;
      membershipDrain = drainOrder
        ? { release: deferred(), closeRequested: deferred(), requestSettled: deferred() }
        : undefined;
      if (membershipDrain) membershipDrainGates.add(membershipDrain);
      hold = deferred();
      releaseTransport = deferred();
      const a = counts(),
        snapshot = await journal.readSnapshot(),
        caller = new AbortController();
      let settled = false;
      const pending = call({ signal: caller.signal }).then((value) => {
        settled = true;
        return value;
      });
      // A missing boundary must fail, not hang the qualifier after an early refusal.
      // Every operation remains tracked and drained by the outer finally.
      await Promise.race([
        hold.promise,
        pending.then(() => {
          throw Error('Drain boundary not reached');
        }),
      ]);
      if (fault === 'utility-drain') {
        assert.equal(jobs.membership - jobs.membershipExit, 1);
        assert.throws(() => claimRailgunAccountPhase(enrollment, 'recovery'));
      }
      caller.abort();
      if (fault === 'utility-drain')
        assert.throws(() => claimRailgunAccountPhase(enrollment, 'recovery'));
      const beforeCompeting = counts();
      assert.deepEqual(await call({ signal: new AbortController().signal }), {
        status: 'refused',
        stage: 'context',
      });
      assert.deepEqual(counts(), beforeCompeting);
      await Promise.resolve();
      assert.equal(settled, false);
      if (membershipDrain) {
        await membershipDrain.closeRequested.promise;
        if (drainOrder === 'request-first') {
          releaseTransport.resolve();
          await membershipDrain.requestSettled.promise;
        } else membershipDrain.release.resolve();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(settled, false);
        const beforeSecondCompeting = counts();
        assert.deepEqual(await call({ signal: new AbortController().signal }), {
          status: 'refused',
          stage: 'context',
        });
        assert.deepEqual(counts(), beforeSecondCompeting);
        membershipDrain.release.resolve();
      }
      releaseTransport.resolve();
      const result = await pending;
      assert.deepEqual(result, {
        status: 'refused',
        stage: fault === 'transport-drain' ? 'acquire' : 'membership-verify',
      });
      checkDelta(
        a,
        fault === 'transport-drain' ? [1, 1, 0, 0] : [1, 1, 1, 1],
        fault === 'utility-drain' ? 1 : 0,
        fault === 'utility-drain' ? 1 : 0
      );
      const free = claimRailgunAccountPhase(enrollment, 'recovery');
      free.release();
      assert.deepEqual(await journal.readSnapshot(), snapshot);
      runs.push({
        mode: phase,
        refused: true,
        pendingUntilDrain: true,
        independentTransportBarrier: !!drainOrder,
        drainOrder,
        phaseHeldUntilExit: fault === 'utility-drain',
        journalUnchanged: true,
      });
      heldTask = undefined;
      membershipDrain = undefined;
    }
    await publicAccount.close();
    publicAccount = undefined;
    enrollment.close();
    enrollment = await openRailgunAccountEnrollment({ identity });
    journal = openJournal();
    publicAccount = await openRailgunAccountPublic({ enrollment, archive });
    await success('healthy-reopen-after-refusals');
    if (proofMode) {
      const proofCall = async (member, fault, extra = {}) => {
        proofFault = fault;
        proofCaller = new AbortController();
        proofActive = true;
        phase = 'proof-' + fault;
        const beforeJournal = await journal.readSnapshot();
        const beforeProof = copy(proofJobs);
        const serviceCounts = () =>
          copy({ rpcMethods, publicMethods, poiMethods, transportCreates, transportCloses });
        const beforeServices = serviceCounts();
        try {
          const work = proveRailgunOwnPoi({
            identity,
            enrollment,
            coordinator: publicAccount.coordinator,
            archive,
            proverArchive,
            artifactDirectory,
            membershipReceipt: member.receipt,
            signal: AbortSignal.any([proofCaller.signal, operationsController.signal]),
            ...extra,
          });
          pendingOperations.add(work);
          let result;
          try {
            result = await work;
          } finally {
            pendingOperations.delete(work);
          }
          assert.deepEqual(await journal.readSnapshot(), beforeJournal);
          assert.equal((await capture()).status, 'captured');
          assert.deepEqual(serviceCounts(), beforeServices);
          assert.ok(viewingReplies.every((value) => value.every((byte) => byte === 0)));
          assert.equal(proofJobs.viewing, proofJobs.viewingExit);
          assert.equal(proofJobs.verification, proofJobs.verificationExit);
          const delta = Object.fromEntries(
            ['viewing', 'viewingExit', 'verification', 'verificationExit', 'keyReplies'].map(
              (key) => [key, proofJobs[key] - beforeProof[key]]
            )
          );
          const entryRefusal = ['forged-receipt', 'consumed-receipt'].includes(fault);
          const preKeyRefusal = ['purpose', 'hash', 'extra', 'result-before-key'].includes(fault);
          assert.deepEqual(delta, {
            viewing: entryRefusal ? 0 : 1,
            viewingExit: entryRefusal ? 0 : 1,
            verification: ['valid', 'proof'].includes(fault) ? 1 : 0,
            verificationExit: ['valid', 'proof'].includes(fault) ? 1 : 0,
            keyReplies: entryRefusal || preKeyRefusal ? 0 : 1,
          });
          if (fault === 'valid') {
            assert.equal(result.status, 'proved', 'proof stage ' + result.stage);
            assert.equal(result.separatelyVerified, true);
            assert.equal(result.utilityExitObserved, true);
            assert.equal(result.payload.blindedCommitmentsOut.length, kind === 'transfer' ? 1 : 0);
            assert.equal(result.disclosureEnabled, false);
            assert.equal(result.spendingEnabled, false);
          } else {
            assert.equal(result.status, 'refused');
            assert.equal(
              result.stage,
              entryRefusal
                ? 'context'
                : fault === 'proof'
                  ? 'verify'
                  : fault === 'cancel'
                    ? 'recovery'
                    : 'recovery:callback'
            );
          }
          const resultAdmissions = proofJobs.resultAdmissions - beforeProof.resultAdmissions;
          assert.equal(
            resultAdmissions,
            ['valid', 'proof', 'early-timeout'].includes(fault) ? 1 : 0
          );
          const viewingExit = entryRefusal ? undefined : proofExits.at(-1);
          if (fault === 'early-timeout') {
            // The hardened host's abort listener explicitly closes the child
            // before the later supervisor broker-revocation listener runs.
            console.log(JSON.stringify({ phase: 'proof-early-timeout-exit', ...viewingExit }));
            assert.equal(viewingExit.cause, 'RAILGUN_PROCESS_CLOSED');
            // The host timer was armed just before start. Permit only scheduling
            // precision, not an unrelated early process closure, as the cause.
            assert.ok(viewingExit.elapsedMs >= viewingExit.budgetMs - 50);
            assert.ok(viewingExit.elapsedMs < viewingExit.budgetMs + 5000);
          }
          proofRuns.push({
            mode: fault,
            status: result.status,
            ...(result.status === 'refused' ? { stage: result.stage } : {}),
            journalUnchanged: true,
            healthyCapture: true,
            exitsObserved: true,
            viewingRepliesWiped: true,
            jobs: delta,
            resultAdmissions,
            noServiceActivity: true,
            ...(viewingExit ? { viewingExit } : {}),
          });
          return result;
        } finally {
          proofActive = false;
          proofCaller.abort();
          proofFault = 'valid';
        }
      };
      const proofMembership = async () => {
        mode = 'valid';
        const before = counts();
        const member = await call();
        assert.equal(member.status, 'verified', 'proof membership ' + member.stage);
        checkDelta(before, [1, 1, 1, 1], 1);
        return member;
      };
      let member = await proofMembership();
      try {
        await proofCall(member, 'forged-receipt', { membershipReceipt: {} });
        for (const fault of ['purpose', 'hash', 'extra', 'result-before-key'])
          await proofCall(member, fault);
        savedProof = await proofCall(member, 'valid');
        const before = proofJobs.viewing;
        await proofCall(member, 'consumed-receipt');
        assert.equal(proofJobs.viewing, before);
      } finally {
        member.close();
        await member.closed;
        results.delete(member);
      }
      for (const fault of [
        'root',
        'proof',
        'double-key',
        'close-after-key',
        'cancel',
        'early-timeout',
      ]) {
        member = await proofMembership();
        try {
          await proofCall(member, fault, fault === 'early-timeout' ? { timeoutMs: 70000 } : {});
        } finally {
          member.close();
          await member.closed;
          results.delete(member);
        }
      }
      assert.equal(proofRuns.length, 13);
      assert.equal(proofJobs.viewing, 11);
      assert.equal(proofJobs.viewingExit, 11);
      assert.equal(proofJobs.keyReplies, 7);
      assert.equal(proofJobs.verification, 2);
      assert.equal(proofJobs.verificationExit, 2);
      assert.ok(proofJobs.peakRssBytes > 0 && proofJobs.peakRssBytes < 768 * 1024 * 1024);
      assert.ok(proofJobs.maxWireBytes > 0 && proofJobs.maxWireBytes <= 32768);
    }
    if (checksMode) {
      assert.equal(savedProof.status, 'proved');
      const snapshots = () =>
        copy({
          checksRoots,
          checksJobs,
          checksForbiddenJobs,
          checksGuards,
          proofJobs,
          poiMethods,
          publicMethods,
          rpcMethods,
          jobs,
          setupKeyJobs,
          forbiddenKeyJobs,
          unexpectedTransport,
          unexpectedRpc,
          transportCreates,
          transportCloses,
          signatureChecks: signature.attempts(),
        });
      const invokeChecks = (extra = {}) => {
        const work = openRailgunOwnPoiChecks({
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          proof: savedProof,
          signal: operationsController.signal,
          ...extra,
        }).then((value) => {
          if (value.status === 'checked') checksResults.add(value);
          return value;
        });
        pendingOperations.add(work);
        work.then(
          () => pendingOperations.delete(work),
          () => pendingOperations.delete(work)
        );
        return work;
      };
      const refuseCompetingOwner = async () => {
        const before = snapshots();
        assert.deepEqual(await invokeChecks({ signal: new AbortController().signal }), {
          status: 'refused',
          stage: 'proof-history',
        });
        assert.deepEqual(snapshots(), before);
      };
      const exercise = async (fault) => {
        phase = 'checks-' + fault;
        checksActive = true;
        checksFault = fault;
        checksOperation = undefined;
        checksHold = undefined;
        const caller = new AbortController(),
          before = snapshots(),
          beforeJournal = await journal.readSnapshot(),
          beforeTimings = retainedPreflightTimings.length,
          started = performance.now();
        let value,
          diagnostics = {};
        try {
          const held = fault === 'cancel-drain';
          if (held) {
            checksHold = {
              entered: deferred(),
              revoked: deferred(),
              failed: deferred(),
              requests: {},
              aborted: {},
              release: { list: deferred(), txid: deferred() },
              finished: { list: deferred(), txid: deferred() },
            };
            for (const gate of Object.values(checksHold.release)) checksReleases.add(gate);
          }
          let settled = false;
          const pending = invokeChecks({
            signal: AbortSignal.any([caller.signal, operationsController.signal]),
            ...(fault === 'forged-proof' ? { proof: { ...savedProof } } : {}),
            ...(fault === 'short-source-budget' ? { timeoutMs: 8000 } : {}),
          }).then((result) => {
            settled = true;
            return result;
          });
          if (held) {
            const premature = pending.then(() => {
              throw Error('Checks settled before fixture drain');
            });
            const transportFailed = checksHold.failed.promise.then((error) => {
              throw error;
            });
            // The original operation remains tracked and must drain in finally;
            // transport assertion failures bypass the controller's sibling drain
            // so finally can release both fixture gates before awaiting it.
            await Promise.race([checksHold.entered.promise, premature, transportFailed]);
            assert.equal(checksRoots.pending - before.checksRoots.pending, 2);
            assert.notEqual(checksHold.requests.list.isolation, checksHold.requests.txid.isolation);
            for (const request of Object.values(checksHold.requests))
              assert.equal(request.signal.aborted, false);
            caller.abort();
            await Promise.race([checksHold.revoked.promise, premature, transportFailed]);
            for (const request of Object.values(checksHold.requests))
              assert.equal(request.signal.aborted, true);
            assert.equal(settled, false);
            assert.equal(checksRoots.pending - before.checksRoots.pending, 2);
            await refuseCompetingOwner();
            checksHold.release.list.resolve();
            await checksHold.finished.list.promise;
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(settled, false);
            assert.equal(checksRoots.pending - before.checksRoots.pending, 1);
            await refuseCompetingOwner();
            checksHold.release.txid.resolve();
            value = await pending;
            assert.deepEqual(value, { status: 'refused', stage: 'list-root-unavailable' });
            diagnostics = {
              ...diagnostics,
              bothTransportsHeld: true,
              ownerHeldUntilBothDrain: true,
            };
          } else {
            value = await pending;
            if (['valid', 'healthy-after-refusals'].includes(fault)) {
              assert.equal(value.status, 'checked', 'checks stage ' + value.stage);
              const observation = assertRailgunOwnPoiChecks(
                value.receipt,
                enrollment,
                publicAccount.coordinator,
                savedProof,
                1000
              );
              assert.equal(observation, value.observation);
              assert.ok(
                Object.isFrozen(value) &&
                  Object.isFrozen(value.receipt) &&
                  Object.isFrozen(observation)
              );
              assert.deepEqual(observation.payload, savedProof.payload);
              assert.equal(observation.payloadSha256, savedProof.payloadSha256);
              assert.equal(observation.capture.bindingDigest, baseline.capture.bindingDigest);
              assert.deepEqual(observation.capture.capsule, capsule);
              assert.equal(observation.preflight.archiveAnchorChecked, true);
              assert.equal(observation.listRoot.root, savedProof.payload.poiMerkleroots[0]);
              assert.equal(observation.listRoot.listKey, REQUIRED_LIST);
              assert.equal(observation.txidRoot.root, savedProof.payload.txidMerkleroot);
              assert.equal(observation.txidRoot.index, savedProof.payload.txidMerklerootIndex);
              assert.equal(observation.txidRoot.tree, 0);
              for (const root of [observation.listRoot, observation.txidRoot]) {
                assert.equal(root.accepted, true);
                assert.equal(root.trust, 'unverified-service');
                assert.equal(root.membershipVerified, false);
              }
              for (const flag of [
                'accountAuthenticated',
                'sourceAuthenticated',
                'currentFinalityVerified',
                'membershipAuthenticated',
                'rootAccepted',
                'noteStatusChecked',
                'disclosureEnabled',
                'spendingEnabled',
              ])
                assert.equal(observation[flag], false);
              assert.throws(() =>
                assertRailgunOwnPoiChecks({}, enrollment, publicAccount.coordinator, savedProof)
              );
              assert.throws(() =>
                assertRailgunOwnPoiChecks(value.receipt, {}, publicAccount.coordinator, savedProof)
              );
              assert.throws(() =>
                assertRailgunOwnPoiChecks(value.receipt, enrollment, {}, savedProof)
              );
              assert.throws(() =>
                assertRailgunOwnPoiChecks(value.receipt, enrollment, publicAccount.coordinator, {
                  ...savedProof,
                })
              );
              await refuseCompetingOwner();
              value.close();
              assert.equal(value.signal.aborted, true);
              assert.throws(() =>
                assertRailgunOwnPoiChecks(
                  value.receipt,
                  enrollment,
                  publicAccount.coordinator,
                  savedProof
                )
              );
              await value.closed;
              checksResults.delete(value);
              diagnostics = { forgedAndClosedReceiptsRefused: true, ownerOverlapRefused: true };
            } else {
              const expectedStage = {
                'forged-proof': 'proof-history',
                'short-source-budget': 'preflight:source',
                'list-reject': 'list-root-rejected',
                'txid-reject': 'txid-root-rejected',
                'malformed-list': 'list-root-unavailable',
              }[fault];
              assert.ok(expectedStage);
              assert.deepEqual(value, { status: 'refused', stage: expectedStage });
              if (fault === 'short-source-budget') {
                // The own selector and archived receipt complete before the
                // source-first route refuses its mandatory 55-second tail.
                // This is admission refusal, not a held-root deadline test.
                assert.equal(retainedPreflightTimings.length, beforeTimings + 1);
                const timing = retainedPreflightTimings.at(-1);
                assert.equal(timing.mode, 'completed');
                assert.equal(timing.sourceCalls, 0);
                diagnostics = {
                  timeoutMs: 8000,
                  elapsedMs: Math.round(performance.now() - started),
                  sourceTailReserveMs: 55000,
                  sourceSnapshotAdmitted: false,
                  deadlineExpiryQualified: false,
                  originalRootDeadlineDrainQualified: false,
                };
              }
            }
          }
          assert.deepEqual(await journal.readSnapshot(), beforeJournal);
          assert.equal((await capture()).status, 'captured');
          const after = snapshots(),
            queried = fault !== 'forged-proof' ? 1 : 0,
            completedPreflight = queried && fault !== 'short-source-budget' ? 1 : 0;
          for (const key of [
            'proofJobs',
            'checksForbiddenJobs',
            'poiMethods',
            'jobs',
            'setupKeyJobs',
            'forbiddenKeyJobs',
            'unexpectedTransport',
            'unexpectedRpc',
            'transportCreates',
            'transportCloses',
            'signatureChecks',
          ])
            assert.deepEqual(after[key], before[key]);
          const delta = (a, b) =>
            Object.fromEntries(Object.keys(a).map((key) => [key, a[key] - b[key]]));
          const rootDelta = delta(after.checksRoots, before.checksRoots),
            jobDelta = delta(after.checksJobs, before.checksJobs);
          assert.deepEqual(rootDelta, {
            creates: 2 * completedPreflight,
            closes: 2 * completedPreflight,
            attempted: 2 * completedPreflight,
            validated: 2 * completedPreflight,
            list: completedPreflight,
            txid: completedPreflight,
            pending: 0,
          });
          assert.deepEqual(jobDelta, {
            ownSelector: queried,
            ownSelectorExit: queried,
            ownTxid: completedPreflight,
            ownTxidExit: completedPreflight,
          });
          const guardReports = after.checksGuards.reports - before.checksGuards.reports;
          const canaryChecks = after.checksGuards.canaryChecks - before.checksGuards.canaryChecks;
          assert.equal(guardReports, queried + completedPreflight);
          assert.equal(after.checksGuards.attempts, 0);
          if (queried)
            assert.ok(canaryChecks >= guardReports && canaryChecks <= 256 * guardReports);
          else assert.deepEqual(after.checksGuards, before.checksGuards);
          const publicDelta = delta(after.publicMethods, before.publicMethods);
          assert.deepEqual(publicDelta, {
            latest: 3 * completedPreflight,
            validate: 3 * completedPreflight,
            page: 0,
          });
          const rpcDelta = delta(after.rpcMethods, before.rpcMethods);
          assert.deepEqual(rpcDelta, {
            eth_chainId: queried,
            eth_getTransactionReceipt: queried,
            eth_getBlockByNumber: 12 * queried + 22 * completedPreflight,
            eth_blockNumber: 2 * queried,
            eth_getTransactionByHash: queried,
            eth_getLogs: completedPreflight,
          });
          checksRuns.push({
            mode: fault,
            status: value.status,
            ...(value.status === 'refused' ? { stage: value.stage } : {}),
            ...diagnostics,
            journalUnchanged: true,
            healthyRecapture: true,
            rootRequests: rootDelta,
            keylessJobs: jobDelta,
            utilityGuardReports: guardReports,
            utilityCanaryChecks: canaryChecks,
            publicPreflightCalls: publicDelta,
            chainPreflightCalls: rpcDelta,
            additionalViewingKeys: 0,
            additionalPoiProofs: 0,
            additionalPoiVerifiers: 0,
            ownedNoteQueries: 0,
            overallAuthorityGranted: false,
          });
        } finally {
          caller.abort();
          for (const result of checksResults) result.close();
          for (const gate of Object.values(checksHold?.release ?? {})) gate.resolve();
          await Promise.allSettled([...pendingOperations]);
          await Promise.all([...checksResults].map((result) => result.closed));
          checksResults.clear();
          checksHold = undefined;
          checksActive = false;
        }
      };
      for (const fault of [
        'forged-proof',
        'valid',
        'list-reject',
        'txid-reject',
        'malformed-list',
        'cancel-drain',
        'short-source-budget',
        'healthy-after-refusals',
      ])
        await exercise(fault);
      assert.equal(checksRuns.length, 8);
      assert.deepEqual(checksRoots, {
        creates: 12,
        closes: 12,
        attempted: 12,
        validated: 12,
        list: 6,
        txid: 6,
        pending: 0,
      });
      assert.deepEqual(checksJobs, {
        ownSelector: 7,
        ownSelectorExit: 7,
        ownTxid: 6,
        ownTxidExit: 6,
      });
      assert.deepEqual(checksForbiddenJobs, { binaryKey: 0, poiProver: 0, poiVerifier: 0 });
      assert.equal(checksGuards.reports, 13);
      assert.equal(checksGuards.attempts, 0);
    }
    let retainedIntent;
    const intentActivity = () =>
      copy({
        checksRoots,
        checksJobs,
        checksForbiddenJobs,
        proofJobs,
        poiMethods,
        publicMethods,
        rpcMethods,
        jobs,
        setupKeyJobs,
        forbiddenKeyJobs,
        unexpectedTransport,
        unexpectedRpc,
        transportCreates,
        transportCloses,
      });
    const exerciseAttemptedOutput = async (fault = 'healthy') => {
      phase = 'attempted-output-' + fault;
      const {
        recoverRailgunAttemptedPoiOutput,
      } = require('../src/main/wallet/railgun-poi-output-recovery');
      const baseline = await intentStore.get(retainedIntent.capsuleDigest);
      const beforeStore = await intentStore.inspect();
      const beforeJournal = await journal.readSnapshot();
      const beforeActivity = intentActivity();
      const beforeJobs = copy(outputRecoveryJobs);
      const beforeMaintenance = copy(sourceMaintenance);
      const beforeVerifier = copy(coldValidationVerifierJobs);
      const beforePost = copy(submissionWire);
      const beforeMirrorBroker = copy(outputRecoveryMirrorBroker);
      const beforePublicBroker = copy(outputRecoveryPublicBroker);
      const beforeGuards = outputRecoveryGuards.reports;
      const delta = (a, b) =>
        Object.fromEntries(Object.keys(a).map((key) => [key, a[key] - b[key]]));
      outputRecoveryFault = fault;
      outputPublicPlanAdmitted = false;
      outputRecoveryInputDigest = undefined;
      outputRecoveryTxid = undefined;
      outputRecoveryActive = true;
      const work = recoverRailgunAttemptedPoiOutput({
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        archive,
        capsuleDigest: retainedIntent.capsuleDigest,
        signal: operationsController.signal,
      });
      pendingOperations.add(work);
      let value;
      try {
        value = await work;
      } finally {
        await work.catch(() => {});
        pendingOperations.delete(work);
        outputRecoveryActive = false;
      }
      const afterActivity = intentActivity();
      assert.deepEqual(await intentStore.get(retainedIntent.capsuleDigest), baseline);
      assert.deepEqual(await intentStore.inspect(), beforeStore);
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      assert.deepEqual(coldValidationVerifierJobs, beforeVerifier);
      assert.deepEqual(submissionWire, beforePost);
      for (const key of Object.keys(beforeActivity))
        if (!['publicMethods', 'rpcMethods'].includes(key))
          assert.deepEqual(afterActivity[key], beforeActivity[key]);
      const maintenance = delta(sourceMaintenance, beforeMaintenance);
      assert.deepEqual(maintenance, { stages: 0, retains: 0, beforeAcquire: 0, applies: 0 });
      const chainCalls = delta(afterActivity.rpcMethods, beforeActivity.rpcMethods);
      const serviceCalls = delta(afterActivity.publicMethods, beforeActivity.publicMethods);
      const jobCalls = delta(outputRecoveryJobs, beforeJobs);
      const mirrorBroker = delta(outputRecoveryMirrorBroker, beforeMirrorBroker);
      const publicBroker = delta(outputRecoveryPublicBroker, beforePublicBroker);
      const guardReports = outputRecoveryGuards.reports - beforeGuards;
      assert.equal(outputRecoveryGuards.attempts, 0);
      const prepared = baseline.state === 'prepared';
      if (prepared) {
        assert.deepEqual(value, { status: 'refused', stage: 'stored' });
        assert.deepEqual(afterActivity, beforeActivity);
        assert.deepEqual(outputRecoveryJobs, beforeJobs);
        assert.deepEqual(outputRecoveryMirrorBroker, beforeMirrorBroker);
        assert.deepEqual(outputRecoveryPublicBroker, beforePublicBroker);
        assert.equal(guardReports, 0);
      } else {
        attemptedOutputValidations++;
        const substituted = fault === 'substituted-output';
        const viewing = Number(kind === 'transfer');
        if (substituted) assert.deepEqual(value, { status: 'refused', stage: 'recovery:callback' });
        else {
          assert.equal(value.status, 'matched');
          assert.equal(value.recordState, 'attempted');
          assert.equal(value.capsuleDigest, baseline.capsuleDigest);
          assert.equal(value.revision, baseline.revision);
          assert.equal(value.payloadSha256, baseline.payloadSha256);
          assert.equal(value.attemptBodySha256, baseline.attempt.submission.bodySha256);
          assert.equal(value.outputMatched, true);
          assert.equal(value.recoveryInputSha256, viewing ? outputRecoveryInputDigest : null);
          assert.equal(value.viewingKeyReleases, viewing);
          assert.equal(value.viewingUtilityExitObserved, !!viewing);
          for (const flag of [
            'proofVerified',
            'originalInputReconstructed',
            'originalRootsAccepted',
            'membershipAuthenticated',
            'sourceAuthenticated',
            'disclosureEnabled',
            'spendingEnabled',
            'submissionAccepted',
            'retryEnabled',
            'eligibilityEstablished',
            'attemptOutcomeKnown',
          ])
            assert.equal(value[flag], false);
        }
        assert.deepEqual(chainCalls, {
          eth_chainId: attemptedOutputValidations === 1 ? 2 : 1,
          eth_getTransactionReceipt: 1,
          eth_getBlockByNumber: 34,
          eth_blockNumber: 2,
          eth_getTransactionByHash: 1,
          eth_getLogs: 1,
        });
        assert.deepEqual(serviceCalls, { latest: 3, validate: 3, page: 0 });
        assert.deepEqual(jobCalls, {
          ownSelector: 1,
          ownSelectorExit: 1,
          ownTxid: 1,
          ownTxidExit: 1,
          mirrorInspect: 2,
          mirrorInspectExit: 2,
          mirrorWitness: 1,
          mirrorWitnessExit: 1,
          mirrorHistorical: 0,
          mirrorHistoricalExit: 0,
          historicalSubstitutions: 0,
          publicPlan: 1,
          publicPlanExit: 1,
          viewing,
          viewingExit: viewing,
          keyRequests: viewing,
          keyReplies: viewing,
          resultMessages: viewing,
          resultAdmissions: substituted ? 0 : viewing,
          resultSubstitutions: Number(substituted),
          unexpected: 0,
        });
        assert.deepEqual(mirrorBroker, {
          attempted: 11 + Number(mirrorAdvanced),
          admitted: 11 + Number(mirrorAdvanced),
          input: 3,
          get: 5 + Number(mirrorAdvanced),
          result: 3,
          forbidden: 0,
        });
        assert.deepEqual(publicBroker, {
          attempted: 3,
          admitted: 3,
          sourceNext: 2,
          jobResult: 1,
          forbidden: 0,
        });
        assert.equal(guardReports, 6 + viewing);
        assert.ok(outputRecoveryReplies.every((bytes) => bytes.every((v) => v === 0)));
      }
      // Prove release even after the final unshield match, without sending a
      // query or relying on another operation accidentally exercising the map.
      const {
        claimRailgunAttemptedPoiOutput,
      } = require('../src/main/wallet/railgun-poi-disclosure-plan');
      const nextClaim = claimRailgunAttemptedPoiOutput({
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        signal: operationsController.signal,
      });
      try {
        nextClaim.assertCurrent();
      } finally {
        nextClaim.release();
      }
      attemptedOutputRuns.push({
        mode: prepared ? 'prepared-refused' : fault,
        status: value.status,
        ...(value.status === 'refused' ? { stage: value.stage } : {}),
        chainCalls,
        serviceCalls,
        jobCalls,
        sourceMaintenance: maintenance,
        recordAndReservesUnchanged: true,
        recordState: baseline.state,
        sharedClaimReleased: true,
        mirrorBroker,
        publicBroker,
        guardReports,
        logicalStoreUnchanged: true,
        journalUnchanged: true,
        submittedProofReverified: false,
        submissionAccepted: false,
        eligibilityEstablished: false,
        attemptOutcomeKnown: false,
        retryEnabled: false,
        liveQueries: 0,
        liveSubmissions: 0,
      });
    };
    if (intentsMode) {
      phase = 'poi-intent-storage';
      const initialActivity = intentActivity();
      const initialJournal = await journal.readSnapshot();
      intentStore = await enrollment.openPoiIntents();
      assert.equal(await enrollment.openPoiIntents(), intentStore);
      assert.deepEqual(await intentStore.list(), []);
      const prepare = (proof) =>
        intentStore.prepare({
          proof,
          coordinator: publicAccount.coordinator,
          signal: enrollment.signal,
        });
      for (const [label, value] of [
        ['forged-proof', {}],
        ['copied-proof', copy(savedProof)],
      ]) {
        assert.equal((await prepare(value)).status, 'refused');
        assert.deepEqual(await intentStore.list(), []);
        intentRuns.push({ mode: label, refused: true, noWrite: true });
      }
      const prepared = await prepare(savedProof);
      assert.equal(prepared.status, 'prepared', 'intent stage ' + prepared.stage);
      assert.equal(prepared.disclosureEnabled, false);
      assert.equal(prepared.spendingEnabled, false);
      assert.equal(prepared.revision, 1);
      retainedIntent = await intentStore.get(prepared.capsuleDigest);
      assert.deepEqual(retainedIntent.payload, savedProof.payload);
      assert.equal(retainedIntent.payloadSha256, savedProof.payloadSha256);
      assert.equal(retainedIntent.state, 'prepared');
      assert.ok(Object.isFrozen(retainedIntent.payload.proof.pi_b[0]));
      intentRuns.push({ mode: 'genuine-proof-prepared', retained: true, revision: 1 });
      assert.deepEqual(await prepare(savedProof), prepared);
      assert.deepEqual(await intentStore.inspect(), {
        records: 1,
        sequence: 1,
        capacity: 32,
        reservedTransitions: 3,
        freeTransitions: 124,
      });
      intentRuns.push({ mode: 'identical-proof-no-write', revision: 1 });
      const { getPrivacyStoragePath } = require('../src/main/wallet/privacy-storage');
      const file = getPrivacyStoragePath(
        enrollment.getContext(
          'storage',
          'railgun-poi-intents-v1:' + enrollment.descriptor.walletId
        ),
        enrollment.directory
      );
      const ciphertext = fs.readFileSync(file, 'utf8');
      assert.equal(JSON.parse(ciphertext).version, 1);
      for (const privateValue of [
        retainedIntent.capsuleDigest,
        retainedIntent.bindingDigest,
        retainedIntent.selector.nullifier,
        retainedIntent.selector.noteHash,
        retainedIntent.payload.proof.pi_a[0],
        retainedIntent.payloadSha256,
      ])
        assert.equal(ciphertext.includes(privateValue), false);
      intentStore.close();
      await intentStore.closed;
      intentStore = await enrollment.openPoiIntents();
      assert.deepEqual(await intentStore.get(prepared.capsuleDigest), retainedIntent);
      assert.equal((await prepare(retainedIntent)).status, 'refused');
      intentRuns.push({
        mode: 'encrypted-store-reopen',
        retained: true,
        restoredDataRefused: true,
      });
      assert.deepEqual(await journal.readSnapshot(), initialJournal);
      assert.deepEqual(intentActivity(), initialActivity);
    }
    const reopenPreparedIntent = async () => {
      const initialActivity = intentActivity();
      intentStore.close();
      await intentStore.closed;
      await publicAccount.close();
      publicAccount = undefined;
      enrollment.close();
      enrollment = await openRailgunAccountEnrollment({ identity });
      journal = openJournal();
      publicAccount = await openRailgunAccountPublic({ enrollment, archive });
      intentStore = await enrollment.openPoiIntents();
      assert.deepEqual(await intentStore.get(retainedIntent.capsuleDigest), retainedIntent);
      for (const proof of [retainedIntent, savedProof])
        assert.equal(
          (
            await intentStore.prepare({
              proof,
              coordinator: publicAccount.coordinator,
              signal: enrollment.signal,
            })
          ).status,
          'refused'
        );
      intentRuns.push({
        mode: 'enrollment-reopen',
        retained: true,
        restoredDataRefused: true,
        oldOwnerProofRefused: true,
      });
      assert.deepEqual(intentActivity(), initialActivity);
      assert.equal(intentRuns.length, 6);
    };
    if (planMode) {
      phase = 'poi-disclosure-plan';
      planActive = true;
      const {
        prepareRailgunPoiDisclosurePlan,
        revalidateRailgunPoiDisclosurePlan,
      } = require('../src/main/wallet/railgun-poi-disclosure-plan');
      const preparedBaseline = copy(retainedIntent);
      const beforeActivity = intentActivity();
      const beforeJournal = await journal.readSnapshot();
      const beforeInventory = await intentStore.inspect();
      const options = () => ({
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        capsuleDigest: preparedBaseline.capsuleDigest,
        signal: enrollment.signal,
      });
      const make = async (changes = {}) => {
        const value = await prepareRailgunPoiDisclosurePlan({ ...options(), ...changes });
        assert.equal(value.status, 'prepared');
        planResults.push(value);
        return value;
      };
      const revalidate = (value, changes = {}) =>
        revalidateRailgunPoiDisclosurePlan({
          plan: value.plan,
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          signal: enrollment.signal,
          ...changes,
        });
      const unchanged = async () => {
        assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), preparedBaseline);
        assert.deepEqual(await intentStore.inspect(), beforeInventory);
        assert.deepEqual(await journal.readSnapshot(), beforeJournal);
        assert.deepEqual(intentActivity(), beforeActivity);
        assert.deepEqual(planWork, { utilities: 0, utilityKeyHandoffs: 0 });
      };
      const first = await make();
      assert.equal(first.summary.accountIndex, enrollment.descriptor.accountIndex);
      assert.equal(first.summary.operation, kind);
      assert.equal(first.summary.outputCount, kind === 'transfer' ? 1 : 0);
      assert.equal(
        first.summary.unshieldIdCategory,
        kind === 'transfer' ? 'absent' : 'railgun-txid'
      );
      assert.equal(first.summary.endpoint, 'https://ppoi.fdi.network');
      assert.equal(first.summary.listKey, REQUIRED_LIST);
      assert.deepEqual(first.summary.requestInventory, [
        { method: 'ppoi_validate_poi_merkleroots', count: 1 },
        { method: 'ppoi_validate_txid_merkleroot', count: 1 },
        { method: 'ppoi_submit_transact_proof', count: 1 },
      ]);
      for (const flag of [
        'consentGranted',
        'transportAuthorized',
        'requestLimitsEnforced',
        'proofVerified',
        'rootsAccepted',
        'spendingEnabled',
      ])
        assert.equal(first.summary[flag], false);
      assert.ok(Object.isFrozen(first.summary.requestInventory[0]));
      assert.doesNotMatch(
        JSON.stringify(first.summary),
        /"(?:walletId|profileId|capsuleDigest|payloadSha256|bindingDigest|proof|root|selector|transaction|noteHash)"\s*:/
      );
      assert.ok(Buffer.byteLength(JSON.stringify(first.summary)) <= 4096);
      await unchanged();
      planRuns.push({
        mode: 'genuine-prepared-review',
        summaryBound: true,
        noIntentTransition: true,
        consentGranted: false,
        transportAuthorized: false,
      });
      const checked = await revalidate(first);
      assert.equal(checked.status, 'current');
      assert.equal(checked.summary, first.summary);
      assert.equal((await revalidate(first, { plan: copy(first.plan) })).status, 'refused');
      assert.equal((await revalidate(first, { plan: first.summary })).status, 'refused');
      assert.equal(first.signal.aborted, false);
      await unchanged();
      planRuns.push({
        mode: 'revalidate-and-forgery',
        sameSummaryObject: true,
        copiedPlanRefused: true,
        summaryIsNotPlan: true,
        genuinePlanUnaffected: true,
      });
      const failedSuccessor = await prepareRailgunPoiDisclosurePlan({
        ...options(),
        capsuleDigest: hex(1).slice(2),
      });
      assert.equal(failedSuccessor.status, 'refused');
      assert.equal(failedSuccessor.stage, 'entry');
      assert.equal(first.signal.aborted, false);
      assert.equal((await revalidate(first)).status, 'current');
      await unchanged();
      planRuns.push({ mode: 'failed-successor', previousPlanPreserved: true });
      const second = await make();
      assert.equal(first.signal.aborted, true);
      await first.closed;
      assert.equal((await revalidate(first)).status, 'refused');
      assert.equal(second.signal.aborted, false);
      assert.equal((await revalidate(second)).status, 'current');
      await unchanged();
      planRuns.push({
        mode: 'successful-successor',
        previousPlanRevoked: true,
        stalePlanCannotRevokeSuccessor: true,
      });
      const cancelled = new AbortController();
      cancelled.abort();
      assert.deepEqual(await revalidate(second, { signal: cancelled.signal }), {
        status: 'refused',
        stage: 'context',
      });
      assert.equal(second.signal.aborted, true);
      await second.closed;
      assert.equal(intentStore.signal.aborted, false);
      await unchanged();
      planRuns.push({
        mode: 'cancelled-revalidation',
        planRevoked: true,
        sharedStoreHealthy: true,
      });
      const beforeReopen = await make();
      await reopenPreparedIntent();
      assert.equal(beforeReopen.signal.aborted, true);
      await beforeReopen.closed;
      assert.equal((await revalidate(beforeReopen)).status, 'refused');
      const cold = await make();
      assert.deepEqual(cold.summary, first.summary);
      assert.equal((await revalidate(cold)).status, 'current');
      await unchanged();
      planRuns.push({
        mode: 'enrollment-reopen',
        oldPlanRefused: true,
        newlyDerivedPlanCurrent: true,
        storedProofRegistryNotRestored: true,
      });
      // Deliberately change only disposable fixture history through the genuine
      // existing attempt method; plan inspection never authorizes this mutation.
      assert.equal(
        (
          await intentStore.beginAttempt({
            capsuleDigest: preparedBaseline.capsuleDigest,
            expectedRevision: preparedBaseline.revision,
            expectedPayloadSha256: preparedBaseline.payloadSha256,
            signal: enrollment.signal,
          })
        ).status,
        'attempted'
      );
      const attempted = await intentStore.get(preparedBaseline.capsuleDigest);
      assert.equal(attempted.state, 'attempted');
      assert.deepEqual(await revalidate(cold), { status: 'refused', stage: 'entry' });
      assert.equal(cold.signal.aborted, true);
      await cold.closed;
      assert.deepEqual(await prepareRailgunPoiDisclosurePlan(options()), {
        status: 'refused',
        stage: 'entry',
      });
      assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      assert.deepEqual(intentActivity(), beforeActivity);
      assert.deepEqual(planWork, { utilities: 0, utilityKeyHandoffs: 0 });
      planRuns.push({
        mode: 'attempt-invalidates-review',
        revalidationRefused: true,
        newPlanRefused: true,
        fixtureAttemptPreserved: true,
        additionalQueries: 0,
        additionalUtilities: 0,
        additionalUtilityKeyHandoffs: 0,
      });
      assert.equal(planRuns.length, 7);
      planActive = false;
    }
    if (attemptMode) {
      if (attemptedOutputMode) await exerciseAttemptedOutput();
      phase = 'poi-durable-attempt';
      attemptActive = true;
      const preparedBaseline = copy(retainedIntent);
      const beforeActivity = intentActivity();
      const beforeJournal = await journal.readSnapshot();
      const beforeGuards = copy({ outputRecoveryJobs, coldValidationVerifierJobs });
      const begin = (changes = {}) =>
        intentStore.beginAttempt({
          capsuleDigest: preparedBaseline.capsuleDigest,
          expectedRevision: preparedBaseline.revision,
          expectedPayloadSha256: preparedBaseline.payloadSha256,
          signal: enrollment.signal,
          ...changes,
        });
      for (const [label, changes] of [
        ['stale-revision', { expectedRevision: preparedBaseline.revision + 1 }],
        ['stale-payload', { expectedPayloadSha256: hex(1).slice(2) }],
      ]) {
        assert.equal((await begin(changes)).status, 'refused');
        assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), preparedBaseline);
        attemptRuns.push({ mode: label, refused: true, noWrite: true });
      }
      const beforeClock = Date.now();
      // Deliberately discard completion. Recovery below reads only durable state.
      await begin();
      const afterClock = Date.now();
      const attempted = await intentStore.get(preparedBaseline.capsuleDigest);
      assert.equal(attempted.state, 'attempted');
      assert.deepEqual(
        { ...attempted, state: 'prepared', attempt: undefined },
        {
          ...preparedBaseline,
          attempt: undefined,
        }
      );
      assert.ok(
        attempted.attempt.attemptedAt >= beforeClock && attempted.attempt.attemptedAt <= afterClock
      );
      const {
        normalizeRailgunPoiSubmission,
      } = require('../src/main/wallet/railgun-poi-submit-data');
      const submission = normalizeRailgunPoiSubmission(attempted.attempt.submission);
      assert.deepEqual(submission, attempted.attempt.submission);
      assert.deepEqual(submission.payload, preparedBaseline.payload);
      assert.equal(submission.payloadSha256, preparedBaseline.payloadSha256);
      assert.equal(submission.requestId, attempted.attempt.attemptedAt);
      assert.ok(Object.isFrozen(attempted.attempt.submission.payload.proof.pi_b[0]));
      assert.deepEqual(await intentStore.inspect(), {
        records: 1,
        sequence: 2,
        capacity: 32,
        reservedTransitions: 2,
        freeTransitions: 124,
      });
      attemptRuns.push({
        mode: 'durable-attempt-completion-discarded',
        canonicalSubmissionRetained: true,
        originalPreparationRevisionRetained: true,
        requestIdAllocatedOnce: true,
        sequence: 2,
        remainingReservedTransitions: 2,
        disclosureEnabled: false,
        spendingEnabled: false,
      });
      const { assertRailgunOwnPoiProof } = require('../src/main/wallet/railgun-own-poi-proof');
      // This must be BEFORE enrollment reopen: a revoked old proof would refuse
      // at the registry boundary and would not exercise the attempted-state guard.
      assertRailgunOwnPoiProof(savedProof, enrollment, publicAccount.coordinator);
      const reprepare = await intentStore.prepare({
        proof: savedProof,
        coordinator: publicAccount.coordinator,
        signal: enrollment.signal,
      });
      assert.equal(reprepare.status, 'refused');
      assert.equal(reprepare.stage, 'persist');
      assertRailgunOwnPoiProof(savedProof, enrollment, publicAccount.coordinator);
      assert.equal((await begin()).status, 'refused');
      assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
      attemptRuns.push({
        mode: 'current-proof-and-duplicate-attempt-refused',
        genuineProofStillCurrent: true,
        noWrite: true,
      });
      const refuseConsumers = async (when) => {
        for (const [label, validate] of [
          ['output', recoverRailgunPoiOutput],
          ['cold-proof', validateRailgunRetainedPoi],
          ['cold-history', validateRailgunRetainedPoiHistory],
        ]) {
          const result = await validate({
            identity,
            enrollment,
            coordinator: publicAccount.coordinator,
            archive,
            capsuleDigest: preparedBaseline.capsuleDigest,
            signal: enrollment.signal,
            ...(label === 'output' ? {} : { proverArchive, artifactDirectory }),
          });
          assert.deepEqual(result, { status: 'refused', stage: 'stored' });
          assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
          assert.deepEqual(intentActivity(), beforeActivity);
          assert.deepEqual({ outputRecoveryJobs, coldValidationVerifierJobs }, beforeGuards);
          attemptRuns.push({
            mode: when + '-' + label,
            refusedAtStoredGate: true,
            additionalQueries: 0,
            additionalUtilities: 0,
            additionalUtilityKeyHandoffs: 0,
          });
        }
      };
      await refuseConsumers('before-reopen');
      // Keep the earlier prepared baseline separate. The generic reopen helper
      // now checks this exact persisted attempted entry, not a reconstructed body.
      retainedIntent = attempted;
      await reopenPreparedIntent();
      assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
      assert.equal((await begin()).status, 'refused');
      await refuseConsumers('after-reopen');
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      assert.deepEqual(intentActivity(), beforeActivity);
      assert.deepEqual({ outputRecoveryJobs, coldValidationVerifierJobs }, beforeGuards);
      attemptRuns.push({
        mode: 'cold-attempt-recovery',
        exactEnvelopeAndTimestampRetained: true,
        preparedRevisionUnchanged: true,
        journalUnchanged: true,
        automaticRetry: false,
        liveQueries: 0,
        submissions: 0,
      });
      assert.equal(attemptRuns.length, 11);
      assert.deepEqual(attemptWork, { utilities: 0, utilityKeyHandoffs: 0 });
      attemptActive = false;
      if (attemptedOutputMode) {
        await exerciseAttemptedOutput();
        if (kind === 'transfer') {
          await exerciseAttemptedOutput('substituted-output');
          await exerciseAttemptedOutput('healthy-after-refusal');
        }
      }
    }
    if (retainedHistoryMode) {
      phase = 'retained-history-later-mirror';
      task = processModule.startRailgunProcess({
        handle: enrollment.getContext('engine'),
        filename: require.resolve('./fixtures/railgun-retained-history-job'),
        input: JSON.stringify({ archive, row: payload.row }),
        lifetimeMs: 60000,
        broker: {
          signal: enrollment.signal,
          async dispatch(wire) {
            assert.equal(laterMirror, undefined);
            const message = JSON.parse(wire);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            assert.deepEqual(message.value.first, payload.state);
            assert.equal(message.value.guards.attempts, 0);
            assert.equal(message.value.state.count, 2);
            assert.notEqual(message.value.state.root, savedProof.payload.txidMerkleroot);
            laterMirror = message.value;
            return JSON.stringify({ id: 1, value: null });
          },
        },
      });
      await task.ready;
      task.close();
      assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
      task = undefined;
      mirrorAdvanced = true;
      txid = await openRailgunAccountTxid({
        enrollment,
        coordinator: publicAccount.coordinator,
        archive,
      });
      await txid.advance();
      assert.deepEqual((await txid.inspect()).checkpoint.state, laterMirror.state);
      await txid.close();
      txid = undefined;
    }
    if (outputRecoveryMode || coldValidationMode) {
      phase = (coldValidationMode ? 'cold-validation' : 'output-recovery') + '-enrollment-reopen';
      await reopenPreparedIntent();
      const delta = (a, b) =>
        Object.fromEntries(Object.keys(a).map((key) => [key, a[key] - b[key]]));
      const exerciseOutputRecovery = async (fault) => {
        phase = (coldValidationMode ? 'cold-validation-' : 'output-recovery-') + fault;
        outputRecoveryFault = fault;
        outputPublicPlanAdmitted = false;
        outputRecoveryInputDigest = undefined;
        outputRecoveryTxid = undefined;
        const coldPublicRestore = Number(
            outputRecoveryRuns.length + coldValidationRuns.length === 0
          ),
          sourcePlanning = 1,
          invalidSnark = coldValidationMode && fault === 'invalid-snark',
          historyFault = fault === 'substituted-history-root',
          historyReached = retainedHistoryMode && !invalidSnark,
          substituted = fault === 'substituted-output',
          beforeActivity = intentActivity(),
          beforeSourceMaintenance = copy(sourceMaintenance),
          beforeJournal = await journal.readSnapshot(),
          beforeSignatures = signature.attempts(),
          beforeJobs = copy(outputRecoveryJobs),
          beforeMirrorBroker = copy(outputRecoveryMirrorBroker),
          beforePublicBroker = copy(outputRecoveryPublicBroker),
          beforeReplies = outputRecoveryReplies.length,
          beforeTimings = outputRecoveryTimings.length,
          beforeGuards = outputRecoveryGuards.reports,
          beforeVerifier = copy(coldValidationVerifierJobs),
          beforeVerifierTimings = coldValidationVerifierTimings.length,
          beforeVerifierGuards = coldValidationGuards.reports;
        outputRecoveryActive = true;
        coldValidationActive = coldValidationMode;
        const work = (
          retainedHistoryMode
            ? validateRailgunRetainedPoiHistory
            : coldValidationMode
              ? validateRailgunRetainedPoi
              : recoverRailgunPoiOutput
        )({
          ...(coldValidationMode ? { proverArchive, artifactDirectory } : {}),
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          capsuleDigest: retainedIntent.capsuleDigest,
          signal: operationsController.signal,
        });
        pendingOperations.add(work);
        let recovered;
        try {
          recovered = await work;
        } finally {
          pendingOperations.delete(work);
          outputRecoveryActive = false;
          coldValidationActive = false;
        }
        const viewing = Number(kind === 'transfer');
        const maintenanceDelta = delta(sourceMaintenance, beforeSourceMaintenance);
        assert.deepEqual(maintenanceDelta, {
          stages: 0,
          retains: 0,
          beforeAcquire: 0,
          applies: 0,
        });
        if (
          (substituted &&
            (recovered.status !== 'refused' || recovered.stage !== 'recovery:callback')) ||
          (!substituted &&
            !invalidSnark &&
            !historyFault &&
            recovered.status !== (coldValidationMode ? 'validated' : 'matched')) ||
          (invalidSnark && (recovered.status !== 'refused' || recovered.stage !== 'verify'))
        )
          process.stderr.write(
            JSON.stringify({
              outputRecoveryMode: fault,
              status: recovered.status,
              stage: recovered.stage,
              jobs: delta(outputRecoveryJobs, beforeJobs),
            }) + '\n'
          );
        if (historyFault) {
          assert.deepEqual(recovered, { status: 'refused', stage: 'txid-history' });
        } else if (invalidSnark) {
          assert.deepEqual(recovered, { status: 'refused', stage: 'verify' });
        } else if (substituted) {
          assert.equal(viewing, 1);
          assert.deepEqual(recovered, { status: 'refused', stage: 'recovery:callback' });
        } else {
          assert.equal(
            recovered.status,
            coldValidationMode ? 'validated' : 'matched',
            'recovery stage ' + recovered.stage
          );
          assert.equal(recovered.capsuleDigest, retainedIntent.capsuleDigest);
          assert.equal(recovered.payloadSha256, retainedIntent.payloadSha256);
          assert.equal(recovered.revision, retainedIntent.revision);
          if (coldValidationMode) {
            assert.equal(recovered.proofVerified, true);
            assert.equal(recovered.independentlyVerified, true);
            assert.equal(recovered.verifierExitObserved, true);
            for (const flag of [
              'rootAccepted',
              'originalTxidRootCanonical',
              'currentNoteEligibility',
            ])
              assert.equal(recovered[flag], false);
          } else
            assert.equal(recovered.recoveryInputSha256, viewing ? outputRecoveryInputDigest : null);
          if (retainedHistoryMode) {
            for (const flag of [
              'historicalRootMatchesLocalMirror',
              'ownTxidIncludedBySavedIndex',
              'localMirrorCheckpointMatched',
            ])
              assert.equal(recovered[flag], true);
            assert.equal(recovered.globalTxidCompleteness, false);
          }
          assert.equal(recovered.outputMatched, true);
          assert.equal(recovered.viewingKeyReleases, viewing);
          assert.equal(recovered.viewingUtilityExitObserved, !!viewing);
          for (const flag of [
            ...(!coldValidationMode ? ['proofVerified'] : []),
            'originalInputReconstructed',
            'originalRootsAccepted',
            'membershipAuthenticated',
            'sourceAuthenticated',
            'disclosureEnabled',
            'spendingEnabled',
          ])
            assert.equal(recovered[flag], false);
        }
        const jobDelta = delta(outputRecoveryJobs, beforeJobs);
        assert.deepEqual(jobDelta, {
          ownSelector: 1 + Number(historyReached),
          ownSelectorExit: 1 + Number(historyReached),
          ownTxid: 1,
          ownTxidExit: 1,
          mirrorInspect: 2 + 3 * Number(historyReached),
          mirrorInspectExit: 2 + 3 * Number(historyReached),
          mirrorWitness: 1 + Number(historyReached),
          mirrorWitnessExit: 1 + Number(historyReached),
          mirrorHistorical: Number(historyReached),
          mirrorHistoricalExit: Number(historyReached),
          historicalSubstitutions: Number(historyFault),
          publicPlan: sourcePlanning,
          publicPlanExit: sourcePlanning,
          viewing,
          viewingExit: viewing,
          keyRequests: viewing,
          keyReplies: viewing,
          resultMessages: viewing,
          resultAdmissions: substituted ? 0 : viewing,
          resultSubstitutions: Number(substituted),
          unexpected: 0,
        });
        const mirrorBrokerDelta = delta(outputRecoveryMirrorBroker, beforeMirrorBroker);
        assert.deepEqual(mirrorBrokerDelta, {
          attempted: 11 + Number(mirrorAdvanced) + 22 * Number(historyReached),
          admitted: 11 + Number(mirrorAdvanced) + 22 * Number(historyReached),
          input: 3 + 5 * Number(historyReached),
          get: 5 + Number(mirrorAdvanced) + 12 * Number(historyReached),
          result: 3 + 5 * Number(historyReached),
          forbidden: 0,
        });
        const publicBrokerDelta = delta(outputRecoveryPublicBroker, beforePublicBroker);
        assert.deepEqual(publicBrokerDelta, {
          attempted: 3 * sourcePlanning,
          admitted: 3 * sourcePlanning,
          sourceNext: 2 * sourcePlanning,
          jobResult: sourcePlanning,
          forbidden: 0,
        });
        assert.equal(outputRecoveryReplies.length - beforeReplies, viewing);
        assert.ok(outputRecoveryReplies.every((bytes) => bytes.every((v) => v === 0)));
        const timings = outputRecoveryTimings.slice(beforeTimings);
        assert.equal(timings.length, viewing);
        for (const timing of timings) {
          assert.equal(timing.mode, fault);
          assert.equal(
            timing.exitCode,
            substituted ? 'RAILGUN_SESSION_REVOKED' : 'RAILGUN_PROCESS_CLOSED'
          );
          assert.ok(timing.peakRssBytes > 0 && timing.peakRssBytes < 512 * 1024 * 1024);
          for (const [key, value] of Object.entries(timing))
            if (key.endsWith('Ms')) assert.ok(Number.isSafeInteger(value) && value >= 0);
          assert.ok(timing.keyRequestAfterMs <= timing.keyReplyAfterMs);
          assert.ok(timing.keyReplyAfterMs <= timing.resultAfterMs);
          assert.ok(timing.resultAfterMs <= timing.elapsedMs);
        }
        assert.equal(
          outputRecoveryGuards.reports - beforeGuards,
          5 + viewing + sourcePlanning + 6 * Number(historyReached)
        );
        assert.equal(outputRecoveryGuards.attempts, 0);
        assert.deepEqual(await intentStore.get(retainedIntent.capsuleDigest), retainedIntent);
        assert.deepEqual(await journal.readSnapshot(), beforeJournal);
        assert.equal((await capture()).status, 'captured');
        assert.equal(signature.attempts(), beforeSignatures);
        const afterActivity = intentActivity();
        for (const key of Object.keys(beforeActivity))
          if (!['publicMethods', 'rpcMethods'].includes(key))
            assert.deepEqual(afterActivity[key], beforeActivity[key]);
        const publicDelta = delta(afterActivity.publicMethods, beforeActivity.publicMethods),
          chainDelta = delta(afterActivity.rpcMethods, beforeActivity.rpcMethods);
        assert.deepEqual(publicDelta, {
          latest: 3 + 3 * Number(historyReached),
          validate: 3 + 3 * Number(historyReached),
          page: 0,
        });
        assert.deepEqual(chainDelta, {
          eth_chainId: 1 + coldPublicRestore,
          eth_getTransactionReceipt: 1,
          eth_getBlockByNumber: 22 + 12 * sourcePlanning,
          eth_blockNumber: 2,
          eth_getTransactionByHash: 1,
          eth_getLogs: sourcePlanning,
        });
        const verifierDelta = delta(coldValidationVerifierJobs, beforeVerifier),
          verifierTimings = coldValidationVerifierTimings.slice(beforeVerifierTimings);
        if (coldValidationMode) {
          assert.deepEqual(verifierDelta, {
            started: 1,
            exited: 1,
            inputChecks: 1,
            inputSubstitutions: Number(invalidSnark),
            resultMessages: Number(!invalidSnark),
            hashChecks: Number(!invalidSnark),
            resultAdmissions: Number(!invalidSnark),
          });
          assert.equal(verifierTimings.length, 1);
          const timing = verifierTimings[0];
          assert.equal(timing.mode, fault);
          assert.equal(
            timing.exitCode,
            invalidSnark ? 'RAILGUN_PROCESS_FAILED' : 'RAILGUN_PROCESS_CLOSED'
          );
          assert.ok(Number.isSafeInteger(timing.elapsedMs) && timing.elapsedMs >= 0);
          assert.ok(
            Number.isSafeInteger(timing.budgetMs) && timing.budgetMs > 0 && timing.budgetMs <= 35000
          );
          // A rejected child can exit before Electron supplies a positive RSS
          // sample. Zero is unavailable measurement, not zero memory consumption.
          assert.ok(Number.isSafeInteger(timing.peakRssBytes) && timing.peakRssBytes >= 0);
          if (!invalidSnark) assert.ok(timing.peakRssBytes > 0);
          assert.equal(coldValidationGuards.reports - beforeVerifierGuards, Number(!invalidSnark));
          assert.equal(coldValidationGuards.attempts, 0);
        } else {
          assert.deepEqual(coldValidationVerifierJobs, beforeVerifier);
          assert.equal(verifierTimings.length, 0);
        }
        (coldValidationMode ? coldValidationRuns : outputRecoveryRuns).push({
          mode: fault,
          status: recovered.status,
          ...(historyFault
            ? { stage: recovered.stage, differentValidHistoricalRootRefused: true }
            : invalidSnark
              ? { stage: recovered.stage, invalidSnarkInputRefusedWithoutResult: true }
              : substituted
                ? { stage: recovered.stage, validFieldSubstitutionRefused: true }
                : {
                    preparedPayloadDigestMatched: true,
                    recoveryInputDigestMatched: !!viewing,
                  }),
          enrollmentReopened: true,
          exactRevisionRetained: true,
          viewingKeyReleases: viewing,
          viewingUtilityExitObserved: !!viewing,
          outputMatched: !substituted && !invalidSnark && !historyFault,
          ...(coldValidationMode ? { outputStageCompletedBeforeVerifier: true } : {}),
          journalUnchanged: true,
          healthyRecapture: true,
          noPreparedRecordMutation: true,
          ...(retainedHistoryMode
            ? {
                historicalRootMatchesLocalMirror: historyReached && !historyFault,
                ownTxidIncludedBySavedIndex: historyReached && !historyFault,
                localMirrorCheckpointMatched: historyReached && !historyFault,
                historicalRootDiffersFromCurrentRoot: true,
                savedIndex: 0,
                currentCheckpointIndex: 1,
                globalTxidCompleteness: false,
                sourceMaintenance: maintenanceDelta,
              }
            : {}),
          activityObservationSeams: [
            'utility process starts and exits',
            'TXID utility input/get/result broker',
            'cold public plan sourceNext/jobResult broker without storage',
            'viewing utility key/result broker',
            ...(coldValidationMode ? ['keyless POI verifier input/result and observed exit'] : []),
            'fixture POI transport and public/chain service factories',
          ],
          ownedNoteQueries: 0,
          additionalPoiProverJobs: 0,
          additionalPoiVerifierJobs: Number(coldValidationMode),
          ...(coldValidationMode
            ? { verifierCounts: verifierDelta, verifierTimings, proofSpecificRootQueries: 0 }
            : {}),
          additionalSpendingKeyDerivations: 0,
          jobCounts: jobDelta,
          readOnlyTxidMirrorBroker: mirrorBrokerDelta,
          publicPlanBroker: publicBrokerDelta,
          timings,
          publicPreflightCalls: publicDelta,
          chainPreflightCalls: chainDelta,
          proofVerified: coldValidationMode && !invalidSnark,
          ...(coldValidationMode
            ? {
                independentlyVerified: !invalidSnark,
                verifierExitObserved: true,
                originalTxidRootCanonical: false,
                currentNoteEligibility: false,
                rootAccepted: false,
              }
            : {}),
          originalInputReconstructed: false,
          originalRootsAccepted: false,
          membershipAuthenticated: false,
          sourceAuthenticated: false,
          disclosureEnabled: false,
          spendingEnabled: false,
        });
      };
      if (retainedHistoryMode) {
        await exerciseOutputRecovery('substituted-history-root');
        await exerciseOutputRecovery('healthy-after-refusal');
        assert.deepEqual(
          coldValidationRuns.map((run) => run.mode),
          ['substituted-history-root', 'healthy-after-refusal']
        );
      } else if (coldValidationMode) {
        await exerciseOutputRecovery('invalid-snark');
        await exerciseOutputRecovery('healthy-after-refusal');
        assert.deepEqual(
          coldValidationRuns.map((run) => run.mode),
          ['invalid-snark', 'healthy-after-refusal']
        );
      } else if (kind === 'transfer') {
        await exerciseOutputRecovery('substituted-output');
        await exerciseOutputRecovery('healthy-after-refusal');
      } else await exerciseOutputRecovery('healthy');
      assert.equal(outputRecoveryRuns.length, coldValidationMode ? 0 : kind === 'transfer' ? 2 : 1);
    }
    if (submissionMode) {
      const {
        prepareRailgunPoiDisclosurePlan,
        submitRailgunRetainedPoi,
      } = require('../src/main/wallet/railgun-poi-disclosure-plan');
      const { claimRailgunAccountPhase } = require('../src/main/wallet/railgun-account-phase');
      const delta = (a, b) =>
        Object.fromEntries(Object.keys(a).map((key) => [key, a[key] - b[key]]));
      const preparedBaseline = copy(retainedIntent);
      submissionPreparedEntry = preparedBaseline;
      const beforeJournal = await journal.readSnapshot();
      const invoke = async (mode) => {
        phase = 'poi-submission-' + mode;
        const beforeActivity = intentActivity();
        const beforeMaintenance = copy(sourceMaintenance);
        const beforeJobs = copy(outputRecoveryJobs);
        const beforeVerifier = copy(coldValidationVerifierJobs);
        const beforeWire = copy(submissionWire);
        const preparedPlan = await prepareRailgunPoiDisclosurePlan({
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          capsuleDigest: preparedBaseline.capsuleDigest,
          signal: operationsController.signal,
        });
        assert.equal(preparedPlan.status, 'prepared');
        planResults.push(preparedPlan);
        assert.deepEqual(intentActivity(), beforeActivity);
        const reviews = [];
        submissionReviewStage = 0;
        submissionPostDrain =
          mode === 'accept' ? { entered: deferred(), release: deferred() } : undefined;
        outputPublicPlanAdmitted = false;
        outputRecoveryFault = 'healthy';
        submissionActive = true;
        outputRecoveryActive = true;
        coldValidationActive = true;
        const options = {
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          proverArchive,
          artifactDirectory,
          plan: preparedPlan.plan,
          signal: operationsController.signal,
          async review(request, { signal }) {
            assert.ok(signal instanceof AbortSignal && !signal.aborted);
            assert.ok(Object.isFrozen(request));
            reviews.push(request.purpose);
            assert.equal(
              request.purpose,
              reviews.length === 1 ? 'validate-retained-poi' : 'submit-retained-poi'
            );
            const submitting = reviews.length === 2;
            assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 8192);
            for (const flag of ['consentGranted', 'transportAuthorized', 'requestLimitsEnforced'])
              assert.equal(request[flag], false);
            assert.deepEqual(
              request.destinations,
              submitting
                ? [{ role: 'poi-service', origin: 'https://ppoi.fdi.network' }]
                : [
                    { role: 'source-rpc', origin: new URL(rpcUrl).origin },
                    { role: 'receipt-rpc', origin: new URL(rpcUrl).origin },
                    { role: 'poi-service', origin: 'https://ppoi.fdi.network' },
                  ]
            );
            assert.deepEqual(
              request.requestInventory,
              submitting
                ? [
                    { method: 'ppoi_validate_poi_merkleroots', maxRequests: 1 },
                    { method: 'ppoi_validate_txid_merkleroot', maxRequests: 1 },
                    { method: 'ppoi_submit_transact_proof', maxRequests: 1 },
                  ]
                : [
                    { method: 'eth_getTransactionByHash', maxRequests: 1 },
                    { method: 'eth_getTransactionReceipt', maxRequests: 1 },
                    { method: 'eth_blockNumber', maxRequests: 2 },
                    { method: 'eth_getBlockByNumber', maxRequests: 544 },
                    { method: 'eth_getLogs', maxRequests: 1 },
                    { method: 'eth_chainId', maxRequests: 2 },
                    { method: 'ppoi_validated_txid', maxRequests: 7 },
                    { method: 'ppoi_validate_txid_merkleroot', maxRequests: 7 },
                  ]
            );
            // A review must never hold the account recovery/TXID phase.
            const lease = claimRailgunAccountPhase(enrollment, 'recovery');
            lease.release();
            assert.deepEqual(
              await intentStore.get(preparedBaseline.capsuleDigest),
              preparedBaseline
            );
            if (reviews.length === 1) {
              assert.deepEqual(intentActivity(), beforeActivity);
              if (mode === 'deny-validation') return false;
              submissionReviewStage = 1;
              submissionValidationCount++;
              return true;
            }
            assert.equal(reviews.length, 2);
            assert.deepEqual(submissionWire, beforeWire);
            for (const name of [
              'ownSelector',
              'ownTxid',
              'mirrorInspect',
              'mirrorWitness',
              'mirrorHistorical',
              'publicPlan',
              'viewing',
            ])
              assert.equal(outputRecoveryJobs[name], outputRecoveryJobs[name + 'Exit']);
            assert.equal(coldValidationVerifierJobs.started, coldValidationVerifierJobs.exited);
            if (mode === 'deny-submission') return false;
            submissionReviewStage = 2;
            return true;
          },
        };
        const work = submitRailgunRetainedPoi(options);
        pendingOperations.add(work);
        let senderSettled = false;
        work.then(
          () => {
            senderSettled = true;
          },
          () => {
            senderSettled = true;
          }
        );
        let result;
        try {
          if (submissionPostDrain) {
            await Promise.race([
              submissionPostDrain.entered.promise,
              work.then((early) => {
                if (submissionPostDrain.reached) return;
                console.error(
                  JSON.stringify({
                    stage: /^[a-z:-]{1,100}$/.test(early.stage) ? early.stage : 'unavailable',
                    status: early.status === 'refused' ? 'refused' : 'recovery-required',
                    wire: submissionWire,
                  })
                );
                throw Error('Sender settled before POST drain');
              }),
            ]);
            // Give unrelated post-check continuations a turn before checking
            // the deliberately held close barrier, not merely its entry tick.
            await new Promise((resolve) => setTimeout(resolve, 200));
            assert.equal(senderSettled, false);
            const beforeAttemptedRecord = await intentStore.get(preparedBaseline.capsuleDigest);
            const beforeAttemptedJournal = await journal.readSnapshot();
            const beforeAttemptedWire = copy(submissionWire);
            const beforeAttemptedVerifier = copy(coldValidationVerifierJobs);
            const beforeAttemptedBusy = intentActivity();
            const beforeAttemptedJobs = copy(outputRecoveryJobs);
            const beforeAttemptedMaintenance = copy(sourceMaintenance);
            const beforeAttemptedClients = rpcClientCreates;
            const {
              recoverRailgunAttemptedPoiOutput,
            } = require('../src/main/wallet/railgun-poi-output-recovery');
            const busyOutput = await recoverRailgunAttemptedPoiOutput({
              identity,
              enrollment,
              coordinator: publicAccount.coordinator,
              archive,
              capsuleDigest: preparedBaseline.capsuleDigest,
              signal: operationsController.signal,
            });
            assert.deepEqual(busyOutput, { status: 'refused', stage: 'busy' });
            assert.deepEqual(intentActivity(), beforeAttemptedBusy);
            assert.deepEqual(
              await intentStore.get(preparedBaseline.capsuleDigest),
              beforeAttemptedRecord
            );
            assert.deepEqual(await journal.readSnapshot(), beforeAttemptedJournal);
            assert.deepEqual(submissionWire, beforeAttemptedWire);
            assert.deepEqual(coldValidationVerifierJobs, beforeAttemptedVerifier);
            assert.deepEqual(outputRecoveryJobs, beforeAttemptedJobs);
            assert.deepEqual(sourceMaintenance, beforeAttemptedMaintenance);
            assert.equal(rpcClientCreates, beforeAttemptedClients);
            assert.equal(senderSettled, false);
            let unexpectedLease;
            try {
              assert.throws(() => {
                unexpectedLease = claimRailgunAccountPhase(enrollment, 'recovery');
              });
            } finally {
              unexpectedLease?.release();
            }
            const overlap = await submitRailgunRetainedPoi(options);
            assert.equal(overlap.status, 'refused');
            assert.equal(overlap.stage, 'busy');
            assert.equal(reviews.length, 2);
            let planClosed = false;
            preparedPlan.closed.then(() => {
              planClosed = true;
            });
            await Promise.resolve();
            assert.equal(planClosed, false);
            submissionPostDrain.release.resolve();
          }
          result = await work;
        } finally {
          submissionPostDrain?.release.resolve();
          await work.catch(() => {});
          pendingOperations.delete(work);
          submissionActive = false;
          outputRecoveryActive = false;
          coldValidationActive = false;
        }
        await preparedPlan.closed;
        assert.equal(
          result.stage,
          mode === 'accept'
            ? 'response'
            : mode === 'deny-validation'
              ? 'review-validation'
              : 'review-submit'
        );
        assert.equal(Object.hasOwn(result, 'sourceOutcome'), false);
        const validated = mode !== 'deny-validation';
        const afterActivity = intentActivity();
        const chainCalls = delta(afterActivity.rpcMethods, beforeActivity.rpcMethods);
        const serviceCalls = delta(afterActivity.publicMethods, beforeActivity.publicMethods);
        const maintenance = delta(sourceMaintenance, beforeMaintenance);
        const jobs = delta(outputRecoveryJobs, beforeJobs);
        const verifier = delta(coldValidationVerifierJobs, beforeVerifier);
        const wire = delta(submissionWire, beforeWire);
        assert.deepEqual(maintenance, { stages: 0, retains: 0, beforeAcquire: 0, applies: 0 });
        assert.deepEqual(serviceCalls, {
          latest: validated ? 6 : 0,
          validate: validated ? 6 : 0,
          page: 0,
        });
        assert.deepEqual(chainCalls, {
          eth_chainId: Number(validated),
          eth_getTransactionReceipt: Number(validated),
          eth_getBlockByNumber: validated ? 34 : 0,
          eth_blockNumber: validated ? 2 : 0,
          eth_getTransactionByHash: Number(validated),
          eth_getLogs: Number(validated),
        });
        assert.equal(jobs.publicPlan, Number(validated));
        assert.equal(jobs.publicPlanExit, Number(validated));
        assert.equal(jobs.unexpected, 0);
        assert.equal(jobs.viewing, Number(validated && kind === 'transfer'));
        assert.equal(jobs.viewingExit, jobs.viewing);
        assert.equal(verifier.started, Number(validated));
        assert.equal(verifier.exited, Number(validated));
        for (const key of Object.keys(beforeActivity))
          if (!['publicMethods', 'rpcMethods'].includes(key))
            assert.deepEqual(afterActivity[key], beforeActivity[key]);
        assert.deepEqual(await journal.readSnapshot(), beforeJournal);
        if (mode === 'accept') {
          assert.equal(result.status, 'recovery-required');
          assert.equal(result.response.classification, 'rpc-result');
          assert.equal(result.response.matchingEnvelope, true);
          for (const flag of [
            'transportAuthenticated',
            'acceptanceVerified',
            'disclosureEnabled',
            'spendingEnabled',
          ])
            assert.equal(result.response[flag], false);
          assert.deepEqual(wire, {
            creates: 3,
            closes: 3,
            list: 1,
            txid: 1,
            post: 1,
            unexpected: 0,
          });
          assert.equal(submissionIsolation.size, 3);
          assert.equal(submissionRootReadPeak, 2);
          assert.equal(submissionRootReads, 0);
          const attempted = await intentStore.get(preparedBaseline.capsuleDigest);
          assert.equal(attempted.state, 'attempted');
          assert.equal((await intentStore.inspect()).reservedTransitions, 2);
          const reused = await submitRailgunRetainedPoi(options);
          assert.equal(reused.status, 'refused');
          assert.equal(reviews.length, 2);
          assert.deepEqual(intentActivity(), afterActivity);
          assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
        } else {
          assert.equal(result.status, 'refused');
          assert.deepEqual(wire, {
            creates: 0,
            closes: 0,
            list: 0,
            txid: 0,
            post: 0,
            unexpected: 0,
          });
          assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), preparedBaseline);
          assert.equal(reviews.length, validated ? 2 : 1);
        }
        submissionRuns.push({
          mode,
          status: result.status,
          stage: result.stage,
          ...(result.response ? { responseClassification: result.response.classification } : {}),
          reviewPurposes: reviews,
          sourceMaintenance: maintenance,
          chainCalls,
          serviceCalls,
          publicPlannerCalls: jobs.publicPlan,
          viewingKeyReleases: jobs.viewing,
          keylessVerifierCalls: verifier.started,
          wire,
          exactDurableBodyBeforePost: mode === 'accept',
          heldPostDrainRetainsPlanExclusion: mode === 'accept',
          attemptedOutputRefusedDuringPostDrain: mode === 'accept',
          separateRootAndPostIsolationCredentials: mode === 'accept',
          overlappingRootRequests: mode === 'accept',
          fixtureRootStoreReadsSerialized: mode === 'accept',
          journalUnchanged: true,
          syntheticReviewAdapter: true,
          humanConsentQualified: false,
          serviceAcceptanceQualified: false,
          safeRetryEstablished: false,
          liveQueries: 0,
        });
      };
      await invoke('deny-validation');
      await invoke('deny-submission');
      await invoke('accept');
      const attempted = await intentStore.get(preparedBaseline.capsuleDigest);
      intentStore.close();
      await intentStore.closed;
      await publicAccount.close();
      publicAccount = undefined;
      enrollment.close();
      enrollment = await openRailgunAccountEnrollment({ identity });
      journal = openJournal();
      publicAccount = await openRailgunAccountPublic({ enrollment, archive });
      intentStore = await enrollment.openPoiIntents();
      assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
      const beforeColdActivity = intentActivity();
      const cold = await prepareRailgunPoiDisclosurePlan({
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        capsuleDigest: preparedBaseline.capsuleDigest,
        signal: operationsController.signal,
      });
      assert.equal(cold.status, 'refused');
      assert.deepEqual(intentActivity(), beforeColdActivity);
      assert.deepEqual(await intentStore.get(preparedBaseline.capsuleDigest), attempted);
      submissionRuns.push({
        mode: 'cold-attempted-reuse',
        status: 'refused',
        durableAttemptRetained: true,
        additionalQueries: 0,
      });
      retainedIntent = attempted;
      await exerciseAttemptedOutput();
    }
    if (outputRecoveryMode || coldValidationMode) {
      const {
        getRailgunAccountPublicDestination,
      } = require('../src/main/wallet/railgun-account-public');
      const generation = publicAccount.generationId;
      const privateBaseline = await journal.readSnapshot();
      const intentBaseline = await intentStore.inspect();
      const retainedBaseline = await intentStore.get(retainedIntent.capsuleDigest);
      const delta = (after, before) =>
        Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]]));
      const zeroMaintenance = { stages: 0, retains: 0, beforeAcquire: 0, applies: 0 };
      const zeroRpc = () => Object.fromEntries(pendingRpcNames.map((name) => [name, 0]));
      const beginPhase = (name) => {
        phase = 'pending-checkpoint-' + name;
        assert.equal(pendingCheckpointActivity, undefined);
        const activity = {
          mode: name,
          rpcByRole: { 'transaction-rpc': zeroRpc(), 'protocol-rpc': zeroRpc() },
          utilityStarts: Object.fromEntries(pendingUtilityNames.map((name) => [name, 0])),
          utilityExits: Object.fromEntries(pendingUtilityNames.map((name) => [name, 0])),
          binaryJobs: 0,
          keyRequests: 0,
          unexpectedRpc: 0,
        };
        const started = performance.now();
        const before = copy({ sourceMaintenance, publicMethods, poiMethods, delegatedApplies });
        pendingCheckpointActivity = activity;
        return (extra = {}) => {
          assert.equal(pendingCheckpointActivity, activity);
          pendingCheckpointActivity = undefined;
          assert.deepEqual(activity.utilityExits, activity.utilityStarts);
          assert.equal(activity.binaryJobs, 0);
          assert.equal(activity.keyRequests, 0);
          assert.equal(activity.unexpectedRpc, 0);
          assert.equal(activity.utilityStarts.unexpected, 0);
          const report = {
            ...activity,
            elapsedMs: Math.round(performance.now() - started),
            sourceMaintenance: delta(sourceMaintenance, before.sourceMaintenance),
            publicServices: delta(publicMethods, before.publicMethods),
            ownedPoiQueries: delta(poiMethods, before.poiMethods),
            delegatedApplies: delegatedApplies - before.delegatedApplies,
            ...extra,
          };
          assert.ok(Object.values(report.ownedPoiQueries).every((count) => count === 0));
          pendingCheckpointRuns.push(report);
          return report;
        };
      };
      const assertUtilities = (actual, expected) => {
        assert.deepEqual(actual, {
          ...Object.fromEntries(pendingUtilityNames.map((name) => [name, 0])),
          ...expected,
        });
      };
      const assertUntouchedPrivateState = async () => {
        assert.deepEqual(await journal.readSnapshot(), privateBaseline);
        assert.deepEqual(await intentStore.inspect(), intentBaseline);
        assert.deepEqual(await intentStore.get(retainedIntent.capsuleDigest), retainedBaseline);
      };
      const originalScan = await currentScanJournal.readState();
      assert.equal(originalScan.pending, null);
      assert.equal(originalScan.checkpoint.to.number, OWN_BLOCK);
      const nextBlock = originalScan.checkpoint.to.number + 1;
      assert.ok(nextBlock < FINALIZED);
      assert.equal(
        history.filter((log) => Number(BigInt(log.blockNumber)) === nextBlock).length,
        0
      );
      let finishPhase = beginPhase('interrupt-after-prepare');
      const beforeDelegated = delegatedApplies;
      interruptAfterPrepare = true;
      await assert.rejects(
        publicAccount.advance({
          to: nextBlock,
          anchor: { number: FINALIZED, hash: blockHash(FINALIZED) },
        })
      );
      assert.equal(publicAccount.coordinator.signal.aborted, true);
      await publicAccount.close();
      publicAccount = undefined;
      assert.equal(preparedInterruptionFires, 1);
      assert.equal(interruptAfterPrepare, false);
      assert.equal(delegatedApplies, beforeDelegated);
      assert.deepEqual(preparedInterruption.checkpoint, originalScan.checkpoint);
      assert.equal(preparedInterruption.pending.from, nextBlock);
      assert.equal(preparedInterruption.pending.to.number, nextBlock);
      assert.equal(preparedInterruption.pending.logs.count, 0);
      const interrupted = finishPhase({
        oneShotFires: preparedInterruptionFires,
        pendingWrittenBeforeApply: true,
        accountClosed: true,
        advancedEmptyBlocks: 1,
      });
      assert.equal(interrupted.sourceMaintenance.applies, 1);
      assert.equal(interrupted.delegatedApplies, 0);
      assert.equal(interrupted.utilityStarts.publicApply, 0);

      finishPhase = beginPhase('reopen-with-pending');
      publicAccount = await openRailgunAccountPublic({ enrollment, archive });
      assert.equal(publicAccount.generationId, generation);
      const pendingState = await currentScanJournal.readState();
      // Opening rotates a journal lease; compare authenticated plans, not raw
      // ciphertext/lease bytes. The refusal below must preserve the entire state.
      assert.deepEqual(pendingState.pending, preparedInterruption.pending);
      assert.deepEqual(pendingState.checkpoint, originalScan.checkpoint);
      const reopened = finishPhase({
        sameGeneration: true,
        pendingPlanUnchangedAcrossReopen: true,
      });
      assert.deepEqual(reopened.sourceMaintenance, zeroMaintenance);
      assert.deepEqual(reopened.rpcByRole, {
        'transaction-rpc': zeroRpc(),
        'protocol-rpc': zeroRpc(),
      });
      assert.deepEqual(reopened.publicServices, { latest: 0, validate: 0, page: 0 });
      assertUtilities(reopened.utilityStarts, {});
      const destination = getRailgunAccountPublicDestination(
        publicAccount.coordinator,
        enrollment,
        publicAccount.policy
      );
      const retainedPreflight = () =>
        retainedWitness.preflightRailgunRetainedPoiCompleted({
          enrollment,
          coordinator: publicAccount.coordinator,
          archive,
          selector,
          sourceDestination: destination,
          signal: operationsController.signal,
        });
      finishPhase = beginPhase('retained-refused');
      const refused = await retainedPreflight();
      assert.deepEqual(refused, {
        status: 'refused',
        stage: 'source:snapshot',
        sourceOutcome: { fatal: false, reason: 'checkpoint-unavailable', rpcFailure: null },
      });
      assert.deepEqual(await currentScanJournal.readState(), pendingState);
      assert.equal(publicAccount.signal.aborted, false);
      assert.equal(publicAccount.coordinator.signal.aborted, false);
      const refusal = finishPhase({
        status: 'refused',
        sourceOutcome: refused.sourceOutcome,
        journalStateUnchangedByRefusal: true,
      });
      assert.deepEqual(refusal.sourceMaintenance, zeroMaintenance);
      assert.deepEqual(refusal.publicServices, { latest: 0, validate: 0, page: 0 });
      assert.deepEqual(refusal.rpcByRole['protocol-rpc'], zeroRpc());
      const transactionCalls = {
        ...zeroRpc(),
        eth_chainId: 1,
        eth_getTransactionReceipt: 1,
        eth_getTransactionByHash: 1,
        eth_getBlockByNumber: 12,
        eth_blockNumber: 2,
      };
      assert.deepEqual(refusal.rpcByRole['transaction-rpc'], transactionCalls);
      assertUtilities(refusal.utilityStarts, { ownSelector: 1 });
      await assertUntouchedPrivateState();

      finishPhase = beginPhase('explicit-recovery');
      await publicAccount.coordinator.recover();
      const completedState = await currentScanJournal.readState();
      assert.equal(completedState.pending, null);
      assert.deepEqual(completedState.checkpoint, pendingState.pending);
      assert.equal(publicAccount.generationId, generation);
      const maintenance = finishPhase({
        pendingCleared: true,
        sameGeneration: true,
        completedExactPendingPlan: true,
      });
      assert.equal(maintenance.delegatedApplies, 1);
      assert.equal(maintenance.sourceMaintenance.applies, 1);
      for (const name of ['stages', 'retains', 'beforeAcquire'])
        assert.ok(maintenance.sourceMaintenance[name] > 0);
      assert.equal(maintenance.utilityStarts.publicApply, 1);
      await assertUntouchedPrivateState();

      finishPhase = beginPhase('retained-healthy-after-recovery');
      const healthy = await retainedPreflight();
      assert.equal(
        healthy.status,
        'captured',
        'Recovered retained preflight stage ' + healthy.stage
      );
      assert.equal(healthy.creatorClassification.type, 'Shield');
      assert.equal(healthy.creatorClassification.legacy, false);
      assert.equal(healthy.creatorProvenance, undefined);
      assert.equal(healthy.capture.bindingDigest, baseline.capture.bindingDigest);
      for (const flag of [
        'accountAuthenticated',
        'sourceAuthenticated',
        'currentFinalityVerified',
        'txidPathVerified',
        'txidRootAccepted',
        'poiVerified',
        'spendingEnabled',
        'disclosureEnabled',
      ])
        assert.equal(healthy[flag], false);
      const finalState = await currentScanJournal.readState();
      assert.equal(finalState.pending, null);
      assert.deepEqual(finalState.checkpoint, completedState.checkpoint);
      const success = finishPhase({
        status: 'captured',
        completedPlanUnchanged: true,
        allAuthorityFlagsFalse: true,
      });
      assert.deepEqual(success.sourceMaintenance, zeroMaintenance);
      assert.deepEqual(success.publicServices, { latest: 3, validate: 3, page: 0 });
      assert.deepEqual(success.rpcByRole['transaction-rpc'], transactionCalls);
      assert.deepEqual(success.rpcByRole['protocol-rpc'], {
        ...zeroRpc(),
        eth_getBlockByNumber: 16,
        eth_getLogs: 1,
      });
      assertUtilities(success.utilityStarts, {
        ownSelector: 1,
        ownTxid: 1,
        mirrorInspect: 2,
        mirrorWitness: 1,
        publicPlan: 1,
      });
      await assertUntouchedPrivateState();
    }
    phase = 'final-journal-drift';
    mode = 'valid';
    onRoot = async () => {
      // Acquisition holds no phase, so a genuine local recovery window can run
      // here. Its callback returns normally after introducing an unresolved
      // journal entry; only the final private reattestation detects that drift.
      let callbackCompleted = false;
      const changedWindow = await withRecovery(async (window) => {
        window.assertCurrent();
        await journal.begin(hex(101), 4);
        callbackCompleted = true;
        return { diagnostic: true };
      });
      assert.equal(callbackCompleted, true);
      assert.deepEqual(changedWindow, { status: 'refused', stage: 'reattest' });
      recoveryRuns.push({
        mode: 'retained-final-journal-drift',
        callbackCompleted: true,
        finalPrivateReattestationRefused: true,
      });
    };
    const a = counts();
    const changed = await call();
    onRoot = undefined;
    assert.deepEqual(changed, { status: 'refused', stage: 'after-query' });
    checkDelta(a, [1, 1, 1, 1], 1);
    runs.push({ mode: phase, refused: true, membershipCompletedBeforeFinalCapture: true });
    assert.equal(recoveryRuns.length, 7);
    assert.deepEqual(
      runs.map((run) => run.mode),
      [
        'caller-proof-injection',
        'forged-enrollment',
        'wrong-selector',
        'active',
        'idle-transport-drain',
        'routine-journal-refresh',
        'archive-transition',
        'archived',
        'enrollment-store-reopen',
        'status',
        'signature',
        'root',
        'path',
        'index',
        'transport-drain:request-first',
        'transport-drain:close-first',
        'utility-drain',
        'healthy-reopen-after-refusals',
        'final-journal-drift',
      ]
    );
    const additionalMemberships = proofMode ? 7 : 0;
    assert.deepEqual(
      Object.values(poiMethods),
      [17, 16, 14, 13].map((v) => v + additionalMemberships)
    );
    assert.equal(signature.attempts(), 14 + additionalMemberships);
    assert.equal(transportCreates, 17 + additionalMemberships);
    assert.equal(jobs.membership, 12 + additionalMemberships);
    assert.equal(jobs.selector, 17 + additionalMemberships);
    assert.equal(transportCreates, transportCloses);
    assert.equal(jobs.membership, jobs.membershipExit);
    assert.equal(jobs.selector, jobs.selectorExit);
    if (intentsMode && !outputRecoveryMode && !coldValidationMode && !attemptMode && !planMode)
      await reopenPreparedIntent();
    assert.deepEqual(
      attemptedOutputRuns.map((run) => run.mode),
      attemptedOutputMode
        ? [
            'prepared-refused',
            'healthy',
            ...(kind === 'transfer' ? ['substituted-output', 'healthy-after-refusal'] : []),
          ]
        : submissionMode
          ? ['healthy']
          : []
    );
    assert.deepEqual(hashes(), before);
    const report = {
      fixture: 'synthetic-enrolled-own-poi-membership',
      kind,
      elapsedMs: Math.round(performance.now() - started),
      sourceSha256: before,
      runs,
      recoveryRuns,
      proofRuns,
      proofJobs,
      checksMode,
      retainedPreflightTimings,
      pendingCheckpointRuns,
      intentsMode,
      intentRuns,
      outputRecoveryMode,
      coldValidationMode,
      retainedHistoryMode,
      submissionMode,
      submissionRuns,
      submissionWire,
      planMode,
      planRuns,
      planWork,
      attemptMode,
      attemptedOutputMode,
      attemptedOutputRuns,
      attemptRuns,
      attemptWork,
      coldValidationRuns,
      coldValidationVerifierJobs,
      coldValidationVerifierTimings,
      outputRecoveryRuns,
      outputRecoveryJobs,
      outputRecoveryMirrorBroker,
      outputRecoveryPublicBroker,
      outputRecoveryTimings,
      checksRuns,
      checksRoots,
      checksJobs,
      checksForbiddenJobs,
      guards: {
        checksPreflightUtilities: checksGuards,
        outputRecoveryUtilities: outputRecoveryGuards,
        coldValidationVerifierUtilities: coldValidationGuards,
      },
      publicPrefixAdvances: advances,
      setupSourceMaintenance,
      poiMethods,
      publicMethods,
      rpcMethods,
      jobs,
      signatureChecks: signature.attempts(),
      transportCreates,
      transportCloses,
      genuineEnrollmentAndEncryptedStores: true,
      genuineSourceAndMembershipReceipts: true,
      genuineResolutionPermit: true,
      realShieldHashAndLocalMembership: true,
      fixtureDescriptorMatched: true,
      realPositionNullifier: true,
      realOutputEncryption: kind === 'transfer',
      realUnshieldCommitment: kind === 'unshield',
      realBoundParams: true,
      fixtureViewingReconstructionChecked: true,
      fixtureViewingKeyDerivedFromPublicMnemonic: true,
      fixtureInputSetupViewingDerivations: 1,
      fixtureSpendingPrivateKeyDerived: false,
      syntheticInputTree: 0,
      syntheticInputPosition: 0,
      selfTransferOnly: kind === 'transfer',
      productionViewingKeyHandoffQualified: proofMode,
      chainAndRootServicesSimulated: true,
      rpcDestinationBindingSimulated: false,
      rpcDestinationBindingQualified: true,
      rpcChainIdHandshakeExercised: true,
      realPrivateRpcWithSimulatedTransport: true,
      rpcClientCreates,
      serviceSignatureTrust: 'fixture-ed25519-key-substitution',
      realRequiredListKeyRejectsFixtureSignatures: true,
      requiredListAuthenticationQualified: false,
      structuralSpendProofAndSignature: true,
      setupKeyJobs,
      forbiddenKeyJobs,
      unexpectedTransport,
      unexpectedRpc,
      liveQueries: 0,
      submissions: 0,
      syntheticPosts: submissionWire.post,
      liveSubmissions: 0,
      overallAuthorityGranted: false,
      ...(submissionMode
        ? {
            syntheticSubmissionQualified: true,
            humanConsentQualified: false,
            liveSubmissionQualified: false,
            serviceAcceptanceQualified: false,
            physicalSocketDrainQualified: false,
          }
        : {}),
    };
    assert.doesNotMatch(
      JSON.stringify(report),
      /"(?:blindedCommitment|bindingDigest|inputSha256|payloadSha256|payload|poiMerkleroots|txidMerkleroot|merkleroot|root|leaf|capsule|creator|proof|signature|noteHash|descriptor|transaction|pathElements|expectedHash|viewingKey|nullifyingKey|randomsIn|npksOut|valuesOut)"\s*:/
    );
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        scenarios: runs.length,
        sourceFiles: Object.keys(before).length,
        liveQueries: 0,
      })
    );
  } finally {
    // Stop work, drain actual resources, then unconditionally restore fixture seams.
    operationsController.abort();
    submissionPostDrain?.release.resolve();
    for (const value of planResults) value.close();
    intentStore?.close();
    for (const release of checksReleases) release.resolve();
    for (const value of checksResults) value.close();
    for (const release of recoveryReleases) release.resolve();
    releaseTransport?.resolve();
    for (const gate of membershipDrainGates) gate.release.resolve();
    heldTask?.close();
    task?.close();
    for (const value of results) value.close();
    endpointController.abort();
    try {
      const operations = await Promise.allSettled([...pendingOperations]);
      const drained = await Promise.allSettled([
        ...[...results].map((value) => value.closed),
        ...planResults.map((value) => value.closed),
        ...[...checksResults].map((value) => value.closed),
        ...(intentStore ? [intentStore.closed] : []),
        ...(task ? [task.closed] : []),
        ...(heldTask ? [heldTask.closed] : []),
        ...(txid ? [txid.close()] : []),
        ...(publicAccount ? [publicAccount.close()] : []),
      ]);
      assert.ok([...operations, ...drained].every((result) => result.status === 'fulfilled'));
    } finally {
      try {
        restoreClock?.();
        recovery?.close();
        journalScope?.close();
        enrollment?.close();
        identity?.close();
        vault.lockVault();
        for (const client of clients) client.close();
      } finally {
        transport.createWalletTorTransport = originals.transport;
        rpcModule.createPrivateRpc = originals.rpc;
        ledgerModule.createRailgunSourceLedger = originals.ledger;
        sourceModule.createRailgunScanSource = originals.source;
        coordinatorModule.createRailgunScanCoordinator = originals.coordinator;
        scanJournalModule.createRailgunScanJournal = originals.scanJournal;
        for (const restore of retainedRestorations.reverse()) restore();
        Object.assign(registry, originalRegistry);
        serviceModule.createRailgunPublicServices = originals.services;
        processModule.startRailgunProcess = originals.start;
        tor.getWalletSocksEndpoint = originals.endpoint;
        settings.isWalletTorExperimentAvailable = originals.available;
        signature.close();
      }
    }
  }
}
main().then(
  () => {
    releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    // Report only a numeric location in this fixed fixture, never an assertion
    // message, stack, root, proof, or account payload.
    const match =
      typeof error?.stack === 'string'
        ? error.stack.match(/[/\\]qualify-railgun-own-poi-membership\.js:(\d+):\d+/)
        : undefined;
    const line = match ? Number(match[1]) : undefined;
    console.error(
      JSON.stringify({
        phase,
        code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'QUALIFICATION_REFUSED',
        ...(Number.isSafeInteger(line) && line > 0 && line < 100000 ? { line } : {}),
      })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
