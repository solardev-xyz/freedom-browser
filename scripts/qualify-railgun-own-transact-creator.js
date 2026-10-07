/** Genuine encrypted enrolled Transact-creator preflight with synthetic chain
 * and service transport. Actual current-format self/foreign input encryption;
 * structural spend proof/signature only. Optional intercepted typed membership
 * and actual local POI proving. OUTPUT=1 additionally exercises genuine prepare,
 * retained validation, one simulated POST and cold attempted-output recovery.
 * No live request, funded action or actual service acceptance is qualified.
 * electron script NEW_DIRECTORY ENGINE_ASAR transfer|unshield self|foreign [PROVER_ASAR ARTIFACT_DIRECTORY]
 * FREEDOM_RAILGUN_TRANSACT_OUTPUT=1 implies proof+membership; selector is exclusive.
 * FREEDOM_RAILGUN_PARTIAL_CREATOR=1 uses a mixed creator with a 500-unit unshield
 * and a 1000-unit ordinary output; the own second operation remains legacy.
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
  'scripts/fixtures/railgun-own-poi-membership-signature.js',
  'src/main/wallet/railgun-own-poi-membership.js',
  'src/main/wallet/railgun-own-poi-membership.test.js',
  'src/main/wallet/railgun-own-transact-poi-membership.test.js',
  'src/main/wallet/railgun-own-transact-poi-admission.test.js',
  'src/main/wallet/railgun-poi-source.js',
  'src/main/wallet/railgun-poi-source.test.js',
  'src/main/wallet/railgun-poi-membership.js',
  'src/main/wallet/railgun-poi-membership.test.js',
  'src/main/wallet/railgun-poi-job.js',
  'src/main/wallet/railgun-own-poi-proof.js',
  'src/main/wallet/railgun-own-poi-proof-data.js',
  'src/main/wallet/railgun-own-poi-proof-data.test.js',
  'src/main/wallet/railgun-own-transact-poi-proof-data.test.js',
  'src/main/wallet/railgun-own-poi-proof.test.js',
  'src/main/wallet/railgun-own-poi-prove-job.js',
  'src/main/wallet/railgun-own-poi-prove-job.test.js',
  'src/main/wallet/railgun-poi-prover.js',
  'src/main/wallet/railgun-poi-verifier.js',
  'src/main/wallet/railgun-poi-verify-job.js',
  'src/main/wallet/railgun-poi-intent-store.js',
  'src/main/wallet/railgun-poi-intent-store.test.js',
  'src/main/wallet/railgun-prover-manifest.json',
  'scripts/fixtures/railgun-own-poi-membership-input-job.js',
  'src/main/wallet/railgun-poi-transact-selector.js',
  'src/main/wallet/railgun-poi-transact-selector-data.js',
  'src/main/wallet/railgun-poi-transact-selector-job.js',
  'src/main/wallet/railgun-poi-transact-selector.test.js',
  'src/main/wallet/railgun-poi-transact-selector-data.test.js',
  'src/main/wallet/railgun-poi-transact-selector-job.test.js',
  'src/main/wallet/railgun-process.test.js',
  'src/main/wallet/railgun-poi-source-capture.js',
  'src/main/wallet/railgun-poi-source-evidence.js',
  'src/main/wallet/railgun-poi-creator.js',
  'src/main/wallet/railgun-poi-creator-data.js',
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
  'src/main/wallet/railgun-own-txid-verifier.test.js',
  'src/main/wallet/railgun-own-selector.test.js',
  'src/main/networks/network-registry.js',
  'src/main/settings-store.js',
  'src/main/swarm/ant-cache.js',
  'src/main/tor-manager.js',
  'src/main/wallet/railgun-own-operation.test.js',
  'scripts/qualify-railgun-poi-preflight.js',
  'scripts/qualify-railgun-own-poi-membership.js',
  'src/main/wallet/railgun-own-poi-binding.js',
  'src/main/wallet/railgun-own-poi-binding.test.js',
  'src/main/wallet/railgun-own-poi-checks.js',
  'src/main/wallet/railgun-own-poi-checks.test.js',
  'src/main/wallet/railgun-poi-disclosure-plan.js',
  'src/main/wallet/railgun-poi-disclosure-plan.test.js',
  'src/main/wallet/railgun-poi-submission.test.js',
  'src/main/wallet/railgun-poi-submit-data.js',
  'src/main/wallet/railgun-poi-submit-data.test.js',
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
  'src/main/wallet/railgun-poi-payload.js',
  'src/main/wallet/railgun-account-enrollment.test.js',
  'src/main/wallet/railgun-poi-witness.test.js',
  'src/main/wallet/railgun-poi-shield-selector.js',
  'src/main/wallet/railgun-poi-shield-selector-job.js',
  'src/main/networks/wallet-tor-transport.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
async function main() {
  const [directory, archive, kind, senderKind, proverArchive, artifactDirectory] =
    process.argv.slice(2);
  assert.ok(path.isAbsolute(directory) && path.isAbsolute(archive));
  assert.ok(['transfer', 'unshield'].includes(kind));
  assert.ok(['self', 'foreign'].includes(senderKind));
  const partialCreator = process.env.FREEDOM_RAILGUN_PARTIAL_CREATOR === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_PARTIAL_CREATOR));
  const selectorQualification = process.env.FREEDOM_RAILGUN_TRANSACT_SELECTOR === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_TRANSACT_SELECTOR));
  const outputQualification = process.env.FREEDOM_RAILGUN_TRANSACT_OUTPUT === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_TRANSACT_OUTPUT));
  const proofQualification =
    outputQualification || process.env.FREEDOM_RAILGUN_TRANSACT_PROOF === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_TRANSACT_PROOF));
  const membershipQualification =
    proofQualification || process.env.FREEDOM_RAILGUN_TRANSACT_MEMBERSHIP === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_TRANSACT_MEMBERSHIP));
  assert.ok(!(selectorQualification && membershipQualification));
  if (membershipQualification)
    assert.ok(path.isAbsolute(proverArchive) && path.isAbsolute(artifactDirectory));
  assert.equal(require.cache[require.resolve('../src/main/wallet/railgun-poi-records')], undefined);
  const signature = membershipQualification
    ? require('./fixtures/railgun-own-poi-membership-signature').install()
    : null;
  const { REQUIRED_LIST } = require('../src/main/wallet/railgun-poi-records');
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
  let membershipActive = false,
    membershipFault = 'healthy',
    rootStartedAt;
  const membershipOperations = new Set(),
    poiClients = new Set();
  const proofRuns = [],
    connectedRuns = [];
  let savedProof,
    connectedActive = false,
    connectedFault = 'healthy',
    postHold,
    connectedPrepared,
    intentStore;
  const connected = {
    transportCalls: 0,
    attempted: 0,
    validated: 0,
    list: 0,
    txid: 0,
    post: 0,
    outputKeys: 0,
    outputResults: 0,
    outputAdmissions: 0,
    substitutions: 0,
    unexpected: 0,
    assertionFailures: 0,
    guards: 0,
    canaries: 0,
  };
  const connectedJobs = {},
    connectedKeyBuffers = [],
    connectedPending = new Set();
  const connectedReleases = new Set(),
    connectedClients = new Set();
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => (resolve = done));
    return { promise, resolve };
  };
  const membershipRuns = [],
    rootAdmissionAges = [],
    postAcquisitionVerifierEntryAges = [],
    rootAcquisitions = [];
  const poiMethods = {
    ppoi_pois_per_list: 0,
    ppoi_merkle_proofs: 0,
    ppoi_poi_events: 0,
    ppoi_validate_poi_merkleroots: 0,
  };
  const serviceMethods = { latest: 0, validate: 0, page: 0 };
  const methods = {};
  const roleMethods = { 'transaction-rpc': {}, 'protocol-rpc': {} };
  for (const name of [
    '../src/main/networks/private-rpc',
    '../src/main/wallet/private-transaction-network',
    '../src/main/wallet/railgun-own-receipt',
    '../src/main/wallet/railgun-own-witness',
    '../src/main/wallet/railgun-scan-source',
    '../src/main/wallet/railgun-own-poi-membership',
    '../src/main/wallet/railgun-poi-transact-selector',
    '../src/main/wallet/railgun-poi-membership',
    '../src/main/wallet/railgun-txid-root',
    '../src/main/wallet/railgun-account-txid',
    '../src/main/wallet/railgun-own-poi-proof',
    '../src/main/wallet/railgun-own-poi-checks',
    '../src/main/wallet/railgun-poi-output-recovery',
    '../src/main/wallet/railgun-poi-cold-validation',
    '../src/main/wallet/railgun-poi-disclosure-plan',
    '../src/main/wallet/railgun-poi-root',
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
    let closed = false,
      poiCursor = 0,
      poiOperation,
      resolveClosed,
      heldClose;
    const drained = new Promise((resolve) => (resolveClosed = resolve));
    const client = {
      closed: drained,
      release() {},
      close() {
        closed = true;
        if (heldClose) heldClose.promise.then(resolveClosed);
        else resolveClosed();
      },
      async request(handle, url, options) {
        if (connectedActive) connected.transportCalls++;
        try {
          assert.equal(closed, false);
          const context = getPrivacyContext(handle),
            role = context.subject.role;
          if (connectedActive && url === 'https://ppoi.fdi.network') {
            connected.attempted++;
            connectedClients.add(client);
            assert.equal(role, 'poi');
            assert.equal(context.subject.kind, 'private-account');
            assert.equal(
              context.subject.principal,
              'railgun:' + enrollment.descriptor.accountIndex
            );
            assert.equal(context.subject.protocol, 'railgun');
            assert.equal(context.subject.deployment, 'sepolia');
            assert.equal(context.subject.chainId, 11155111);
            assert.match(context.subject.operation, /^poi:[0-9a-f]{64}$/);
            assert.equal(options.method, 'POST');
            assert.ok(options.signal instanceof AbortSignal && !options.signal.aborted);
            assert.equal(options.headers['content-type'], 'application/json');
            const wire = JSON.parse(options.body);
            assert.deepEqual(Object.keys(wire).sort(), ['id', 'jsonrpc', 'method', 'params']);
            assert.equal(wire.jsonrpc, '2.0');
            const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
            let result = true;
            if (wire.method === 'ppoi_validate_poi_merkleroots') {
              connected.list++;
              assert.equal(typeof wire.id, 'string');
              assert.deepEqual(wire.params, {
                ...base,
                listKey: REQUIRED_LIST,
                poiMerkleroots: savedProof.payload.poiMerkleroots,
              });
              result = connectedFault !== 'list-reject';
            } else if (wire.method === 'ppoi_validate_txid_merkleroot') {
              connected.txid++;
              assert.equal(typeof wire.id, 'string');
              assert.deepEqual(wire.params, {
                ...base,
                tree: 0,
                index: savedProof.payload.txidMerklerootIndex,
                merkleroot: savedProof.payload.txidMerkleroot,
              });
            } else {
              connected.post++;
              assert.equal(wire.method, 'ppoi_submit_transact_proof');
              assert.equal(connected.post, 1);
              assert.ok(postHold && intentStore);
              const durable = await intentStore.get(connectedPrepared.capsuleDigest);
              assert.equal(durable.state, 'attempted');
              assert.deepEqual(durable, {
                ...connectedPrepared,
                state: 'attempted',
                attempt: durable.attempt,
              });
              const canonical =
                require('../src/main/wallet/railgun-poi-submit-data').prepareRailgunPoiSubmission({
                  payload: savedProof.payload,
                  requestId: durable.attempt.attemptedAt,
                });
              assert.deepEqual(durable.attempt.submission, canonical);
              assert.equal(url, canonical.endpoint);
              assert.equal(options.body, canonical.body);
              assert.equal(options.timeoutMs, 10000);
              assert.equal(options.maxResponseBytes, 2048);
              assert.equal(options.requireFramedResponse, true);
              assert.equal((await intentStore.inspect()).reservedTransitions, 2);
              heldClose = postHold.release;
              // The response returns, but the dedicated transport's actual close
              // barrier remains withheld. This is not a sleeping request mock.
              postHold.entered.resolve();
              result = null;
            }
            assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 45000);
            connected.validated++;
            return {
              status: 200,
              body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
            };
          }
          if (membershipActive && url === 'https://ppoi.fdi.network' && role === 'poi') {
            poiClients.add(client);
            assert.equal(context.subject.kind, 'private-account');
            assert.equal(
              context.subject.principal,
              'railgun:' + enrollment.descriptor.accountIndex
            );
            assert.equal(context.subject.protocol, 'railgun');
            assert.equal(context.subject.deployment, 'sepolia');
            assert.equal(context.subject.chainId, 11155111);
            assert.match(context.subject.operation, /^poi:[0-9a-f]{64}$/);
            poiOperation ??= context.subject.operation;
            assert.equal(context.subject.operation, poiOperation);
            assert.equal(options.method, 'POST');
            assert.ok(!options.signal.aborted);
            assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 30000);
            const body = JSON.parse(options.body);
            assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
            assert.equal(body.jsonrpc, '2.0');
            assert.equal(typeof body.id, 'string');
            assert.equal(body.method, Object.keys(poiMethods)[poiCursor++]);
            const age = Math.ceil(performance.now() - rootStartedAt);
            assert.ok(age >= 0 && age < 55000);
            rootAdmissionAges.push(age);
            poiMethods[body.method]++;
            const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
            const note = { blindedCommitment: payload.blindedCommitment, type: 'Transact' };
            const proof = JSON.parse(JSON.stringify(payload.proof));
            if (membershipFault === 'path')
              proof.elements[0] = hex(BigInt('0x' + proof.elements[0]) + 1n).slice(2);
            const index = Number(BigInt('0x' + proof.indices));
            let result;
            if (body.method === 'ppoi_pois_per_list') {
              assert.deepEqual(body.params, {
                ...base,
                listKeys: [REQUIRED_LIST],
                blindedCommitmentDatas: [note],
              });
              result = { [note.blindedCommitment]: { [REQUIRED_LIST]: 'Valid' } };
            } else if (body.method === 'ppoi_merkle_proofs') {
              assert.deepEqual(body.params, {
                ...base,
                listKey: REQUIRED_LIST,
                blindedCommitments: [note.blindedCommitment],
              });
              result = [proof];
            } else if (body.method === 'ppoi_poi_events') {
              assert.deepEqual(body.params, {
                ...base,
                listKey: REQUIRED_LIST,
                startIndex: index,
                endIndex: index,
              });
              const event = {
                index,
                blindedCommitment: note.blindedCommitment,
                type: membershipFault === 'type' ? 'Shield' : 'Transact',
              };
              let signed = signature.sign(event);
              if (membershipFault === 'signature')
                signed = (signed[0] === '0' ? '1' : '0') + signed.slice(1);
              result = [
                {
                  signedPOIEvent: { ...event, signature: signed },
                  validatedMerkleroot: proof.root,
                },
              ];
            } else {
              assert.deepEqual(body.params, {
                ...base,
                listKey: REQUIRED_LIST,
                poiMerkleroots: [proof.root],
              });
              result = membershipFault !== 'list-root';
            }
            return {
              status: 200,
              body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: body.id, result })),
            };
          }
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
          if (connectedActive) connected.assertionFailures++;
          const line = error?.stack?.match(/qualify-railgun-own-transact-creator\.js:(\d+):\d+/);
          console.error(
            JSON.stringify({ phase: 'fixture-rpc-admission', line: line ? Number(line[1]) : null })
          );
          throw error;
        }
      },
    };
    return client;
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
  const rootsModule = require('../src/main/wallet/railgun-txid-root');
  const originalRoots = rootsModule.createRailgunTxidRootSource;
  rootsModule.createRailgunTxidRootSource = (...args) => {
    const roots = originalRoots(...args);
    return Object.freeze({
      ...roots,
      acquire(point) {
        if (membershipActive) {
          rootStartedAt = performance.now();
          rootAcquisitions.push(serviceMethods.latest);
          assert.deepEqual(point, { index: payload.state.count - 1, root: payload.state.root });
        }
        return roots.acquire(point);
      },
    });
  };
  const processModule = require('../src/main/wallet/railgun-process');
  const originalStart = processModule.startRailgunProcess;
  const jobs = {};
  let jobFault = 'healthy',
    corruptSelectorKey = false,
    selectorKeyReplies = 0,
    selectorResults = 0,
    selectorTimingStart,
    proofKeyReplies = 0,
    proofResults = 0;
  const proofKeyBuffers = [];
  const selectorKeyBuffers = [],
    selectorKeyTimings = [];
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
    let connectedJob, connectedMode, originalOutputDigest;
    if (connectedActive) {
      const input = JSON.parse(options.input),
        context = getPrivacyContext(options.handle);
      assert.equal(context.subject.kind, 'private-account');
      assert.equal(context.subject.principal, 'railgun:' + enrollment.descriptor.accountIndex);
      assert.equal(context.subject.protocol, 'railgun');
      assert.equal(context.subject.deployment, 'sepolia');
      assert.equal(context.subject.chainId, 11155111);
      const operations = {
        'railgun-own-selector-job.js': 'own-txid-selector',
        'railgun-own-txid-job.js': 'own-txid-proof',
        'railgun-note-provenance-job.js': 'note-provenance',
        'railgun-poi-output-recover-job.js': 'poi-output-recover',
        'railgun-poi-verify-job.js': 'poi-verify',
        'railgun-public-job.js': 'public-scan',
      };
      if (name === 'railgun-txid-job.js') {
        assert.ok(['inspect', 'witness', 'note-witness', 'historical-root'].includes(input.mode));
        assert.deepEqual(input, { archive, mode: input.mode });
        connectedMode = input.mode;
      } else assert.ok(Object.hasOwn(operations, name));
      assert.equal(
        context.subject.operation,
        connectedMode ? 'txid-' + connectedMode : operations[name]
      );
      assert.equal(
        context.subject.role,
        name === 'railgun-poi-verify-job.js' ? 'prover' : 'engine'
      );
      assert.equal(!!options.binaryKey, name === 'railgun-poi-output-recover-job.js');
      if (name === 'railgun-public-job.js') {
        assert.equal(input.mode, 'plan');
        assert.equal(input.archive, archive);
        assert.equal(
          input.storeId,
          require('../src/main/wallet/railgun-account-public').getRailgunAccountPublicIdentity(
            publicAccount.coordinator,
            enrollment
          ).publicId
        );
      }
      const label = connectedMode || name;
      connectedJob = connectedJobs[label] ||= {
        starts: 0,
        exits: 0,
        results: 0,
        admittedResults: 0,
        keys: 0,
        guards: 0,
        methods: {},
        closedCodes: {},
      };
      connectedJob.starts++;
      if (name === 'railgun-poi-output-recover-job.js') {
        assert.equal(kind, 'transfer');
        assert.ok(options.lifetimeMs > 0 && options.lifetimeMs <= 30000);
        assert.equal(options.startupMs, options.lifetimeMs);
        assert.equal(input.preparation.creator.type, 'Transact');
        assert.deepEqual(input.binding, {
          capsuleDigest: connectedPrepared.capsuleDigest,
          bindingDigest: connectedPrepared.bindingDigest,
          payloadSha256: connectedPrepared.payloadSha256,
          revision: connectedPrepared.revision,
        });
        assert.deepEqual(input.preparation.ownEvidence.capsule, fixture.capsule);
        assert.equal(Object.hasOwn(input, 'output'), false);
        assert.equal(Object.hasOwn(input.preparation, 'blindedCommitmentsOut'), false);
        originalOutputDigest = sha(options.input);
      }
      if (name === 'railgun-poi-verify-job.js') {
        assert.deepEqual(input, { proverArchive, artifactDirectory, payload: savedProof.payload });
        if (connectedFault === 'invalid-snark') {
          const base =
            21888242871839275222246405745257275088696311157297823662689037894645226208583n;
          const y = BigInt(input.payload.proof.pi_a[1]);
          assert.ok(y > 0n && y < base);
          input.payload.proof.pi_a[1] = String(base - y);
          require('../src/main/wallet/railgun-poi-payload').normalizeRailgunPoiPayload(
            input.payload
          );
          options = { ...options, input: JSON.stringify(input) };
          connected.substitutions++;
        }
      }
    }
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
          if (connectedJob) {
            connectedJob.methods[message.method] = (connectedJob.methods[message.method] || 0) + 1;
            const result = ['result', 'jobResult'].includes(message.method);
            if (connectedMode) assert.ok(['input', 'get', 'result'].includes(message.method));
            else if (name === 'railgun-public-job.js')
              assert.ok(['sourceNext', 'jobResult'].includes(message.method));
            else
              assert.ok(
                result || (name === 'railgun-poi-output-recover-job.js' && message.method === 'key')
              );
            if (message.method === 'key') {
              connectedJob.keys++;
              assert.deepEqual(message, {
                id: 1,
                method: 'key',
                purpose: 'poi-output-recover',
                inputSha256: originalOutputDigest,
              });
              return Promise.resolve(options.broker.dispatch(wire)).then((bytes) => {
                assert.ok(bytes instanceof Uint8Array && bytes.byteLength === 32);
                connected.outputKeys++;
                connectedKeyBuffers.push(bytes);
                return bytes;
              });
            }
            if (result) {
              counts.results++;
              counts.guardReports++;
              connectedJob.results++;
              const guards = message.value.guards;
              assert.deepEqual(Object.keys(guards).sort(), ['attempts', 'canaries', 'hooks']);
              assert.equal(guards.attempts, 0);
              assert.ok(
                Array.isArray(guards.hooks) && guards.hooks.length > 0 && guards.hooks.length <= 256
              );
              assert.equal(guards.canaries, guards.hooks.length);
              connected.guards++;
              connected.canaries += guards.canaries;
              connectedJob.guards++;
              if (name === 'railgun-poi-output-recover-job.js') {
                connected.outputResults++;
                assert.equal(message.value.recoveryInputSha256, originalOutputDigest);
                assert.equal(message.value.payloadSha256, savedProof.payloadSha256);
                assert.deepEqual(message.value.output, {
                  blindedCommitmentsOut: savedProof.payload.blindedCommitmentsOut,
                  railgunTxidIfHasUnshield: savedProof.payload.railgunTxidIfHasUnshield,
                });
                assert.ok(connectedKeyBuffers.every((bytes) => bytes.every((v) => v === 0)));
                if (connectedFault === 'substituted-output') {
                  const old = message.value.output.blindedCommitmentsOut[0];
                  message.value.output.blindedCommitmentsOut[0] = old === hex(1) ? hex(2) : hex(1);
                  connected.substitutions++;
                }
              }
              if (
                connectedMode === 'historical-root' &&
                connectedFault === 'substituted-history-root'
              ) {
                const h = message.value.historicalRoot;
                assert.equal(h.root, savedProof.payload.txidMerkleroot);
                h.root = h.root === hex(1).slice(2) ? hex(2).slice(2) : hex(1).slice(2);
                connected.substitutions++;
              }
              return Promise.resolve(options.broker.dispatch(JSON.stringify(message))).then(
                (reply) => {
                  connectedJob.admittedResults++;
                  if (name === 'railgun-poi-output-recover-job.js') connected.outputAdmissions++;
                  return reply;
                }
              );
            }
            return options.broker.dispatch(wire);
          }
          if (message.method === 'result' || message.method === 'job-result') {
            counts.results++;
            const guards = message.value?.guards;
            if (guards) {
              assert.equal(guards.attempts, 0);
              counts.guardReports++;
            }
          }
          if (name === 'railgun-own-poi-prove-job.js' && message.method === 'result') {
            assert.ok(proofQualification);
            proofResults++;
          }
          if (name === 'railgun-poi-verify-job.js') assert.equal(options.binaryKey, undefined);
          if (name === 'railgun-own-poi-prove-job.js' && message.method === 'key') {
            assert.ok(proofQualification);
            assert.deepEqual(message, {
              id: 1,
              method: 'key',
              purpose: 'poi-prove',
              inputSha256: sha(options.input),
            });
            return Promise.resolve(options.broker.dispatch(wire)).then((bytes) => {
              assert.ok(bytes instanceof Uint8Array && bytes.byteLength === 32);
              proofKeyReplies++;
              proofKeyBuffers.push(bytes);
              return bytes;
            });
          }
          if (name === 'railgun-poi-transact-selector-job.js' && message.method === 'result') {
            assert.equal(message.value.type, 'Transact');
            assert.equal(message.value.blindedCommitment, payload.blindedCommitment);
            selectorResults++;
          }
          if (name === 'railgun-poi-transact-selector-job.js' && message.method === 'key') {
            assert.deepEqual(Object.keys(message).sort(), [
              'id',
              'inputSha256',
              'method',
              'purpose',
            ]);
            assert.equal(message.id, 1);
            assert.equal(message.purpose, 'poi-transact-selector');
            assert.deepEqual(
              phaseTimings.slice(selectorTimingStart).map((entry) => entry.name),
              ['source', 'mirror-open', 'own-verifier', 'creator-verifier', 'recapture']
            );
            assert.ok(phaseTimings.slice(selectorTimingStart).every((entry) => entry.completed));
            const requestedAt = performance.now();
            const reply = options.broker.dispatch(wire);
            return Promise.resolve(reply).then((bytes) => {
              assert.ok(bytes instanceof Uint8Array && bytes.byteLength === 32);
              selectorKeyReplies++;
              selectorKeyBuffers.push(bytes);
              selectorKeyTimings.push({
                spawnCallToRequestMs: Math.round(requestedAt - jobStarted),
                requestToReplyMs: Math.round(performance.now() - requestedAt),
                configuredJobLifetimeMs: options.lifetimeMs,
              });
              // Disposable fixture only: unchanged bound input reaches actual
              // reconstruction with a deliberately incorrect viewing key.
              if (corruptSelectorKey) bytes.fill(0);
              return bytes;
            });
          }
          return options.broker.dispatch(wire);
        },
      },
    });
    task.closed.then((exit) => {
      counts.exits++;
      if (connectedJob) {
        connectedJob.exits++;
        const code = [
          'RAILGUN_PROCESS_CLOSED',
          'RAILGUN_PROCESS_FAILED',
          'RAILGUN_SESSION_REVOKED',
        ].includes(exit.code)
          ? exit.code
          : 'unexpected';
        connectedJob.closedCodes[code] = (connectedJob.closedCodes[code] || 0) + 1;
        // No rejection callback asserts: the outer scenario checks these bounded
        // measurements after the actual closed promise has settled.
      }
      counts.elapsedMs += Math.round(performance.now() - jobStarted);
    });
    return task;
  };
  const membershipModule = require('../src/main/wallet/railgun-poi-membership');
  const originalMembershipVerify = membershipModule.verifyRailgunPoiMembership;
  membershipModule.verifyRailgunPoiMembership = (options) => {
    if (membershipActive) {
      const age = Math.ceil(performance.now() - rootStartedAt);
      assert.ok(age >= 0 && age < 55000);
      postAcquisitionVerifierEntryAges.push(age);
    }
    return originalMembershipVerify(options);
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
        if (label === 'source' || label === 'retained-source') sourceReturnedAt = performance.now();
        return value;
      } finally {
        phaseTimings.push({
          name: label,
          elapsedMs: Math.round(performance.now() - started),
          ...(label === 'retained-preflight' && sourceReturnedAt !== undefined
            ? {
                sourceReturnToPreflightCompletionMs: Math.round(
                  performance.now() - sourceReturnedAt
                ),
              }
            : {}),
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
  if (outputQualification)
    timeCall(
      require('../src/main/wallet/railgun-poi-source-capture'),
      'captureRailgunPoiSourceForRetainedInput',
      'retained-source'
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
  if (outputQualification) {
    const witnessModule = require('../src/main/wallet/railgun-own-witness');
    for (const name of [
      'preflightRailgunRetainedPoiCompleted',
      'preflightRailgunRetainedPoiForSubmission',
    ])
      timeCall(witnessModule, name, 'retained-preflight');
  }
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
        ...(partialCreator ? { creatorMode: 'partial' } : {}),
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
    assert.equal(payload.priorShield.preimage.value, partialCreator ? '1500' : '1000');
    assert.equal(creatorInner[3].length, partialCreator ? 2 : 1);
    assert.equal(creatorInner[4][6].length, 1);
    if (partialCreator) {
      assert.deepEqual(payload.creatorRow.unshield, {
        tokenData: payload.priorShield.preimage.token,
        toAddress: '0x' + '12'.repeat(20),
        value: '500',
      });
      assert.equal(creatorInner[3][0], payload.noteHash);
    }
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
      ...(partialCreator
        ? [
            {
              ...creatorMetadata,
              ...eventAbi.encodeEventLog('Unshield', [
                '0x' + '12'.repeat(20),
                [0, require('../src/main/wallet/railgun-shield-pins.json').wrappedNative, 0],
                499,
                1,
              ]),
              logIndex: tag(1),
            },
          ]
        : []),
      {
        ...creatorMetadata,
        ...eventAbi.encodeEventLog('Transact', [
          0,
          1,
          partialCreator ? creatorInner[3].slice(0, 1) : creatorInner[3],
          creatorInner[4][6],
        ]),
        logIndex: tag(partialCreator ? 2 : 1),
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
    // Retained in fixture memory only; later local store reopen uses no recovery
    // window merely to compare the same signed capsule's logical record.
    const setupHoldId = (await reservations.assertReceipt(signed)).id;
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
      assert.equal(creator.noteWitness.witness.root, result.witness.root);
      assert.equal(Boolean(creator.noteWitness.witness.row.unshield), partialCreator);
      assert.equal(creator.verification.pathVerified, true);
      assert.equal(creator.verification.suppliedCreatorEventsMatched, true);
      assert.equal(creator.verification.utilityExitObserved, true);
      if (partialCreator) assert.equal(creator.verification.unshieldCommitmentVerified, true);
      else assert.equal(Object.hasOwn(creator.verification, 'unshieldCommitmentVerified'), false);
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
      captureEvidence.push({
        phase,
        rpc,
        publicTxidPairs: 4,
        timings,
        ...(partialCreator
          ? {
              creatorRowHasUnshield: Boolean(creator.noteWitness.witness.row.unshield),
              creatorUnshieldCommitmentVerified:
                creator.verification.unshieldCommitmentVerified === true,
              creatorBeforeOwn: creator.noteWitness.witness.index < result.witness.index,
              sameCheckpoint: creator.noteWitness.witness.root === result.witness.root,
            }
          : {}),
      });
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
    const selectorRuns = [];
    if (selectorQualification) {
      const {
        deriveRailgunOwnTransactPoiSelector,
      } = require('../src/main/wallet/railgun-poi-transact-selector');
      if (!foreignIdentity)
        foreignIdentity = await openRailgunIdentity({ archive, accountIndex: 1 });
      const durableSnapshot = async () => {
        const currentReservations = await enrollment.openReservations();
        const currentCapsules = await enrollment.openPrivateCapsules();
        const entries = [];
        await currentReservations.withSigningRecovery(async (records, context) => {
          for (const { entry, receipt } of records) {
            context.assertCurrent();
            entries.push({ entry, stored: await currentCapsules.readSigned(receipt) });
          }
          context.assertCurrent();
        });
        return { entries, journal: await journal.readSnapshot() };
      };
      const checkedSelector = async (
        mode,
        { wrongIdentity = false, badKey = false, badRoot = false } = {}
      ) => {
        phase = mode;
        const beforeDurable = await durableSnapshot(),
          beforeServices = { ...serviceMethods },
          beforeKeys = selectorKeyReplies,
          beforeResults = selectorResults,
          beforeJobs = JSON.parse(JSON.stringify(jobs)),
          beforeMaintenance = { ...sourceMaintenance },
          beforeRpc = rpcSnapshot(),
          timingStart = phaseTimings.length;
        assert.equal(preflightActive, false);
        preflightActive = true;
        selectorTimingStart = timingStart;
        corruptSelectorKey = badKey;
        rejectRoot = badRoot;
        const began = performance.now();
        let result;
        try {
          result = await deriveRailgunOwnTransactPoiSelector({
            identity: wrongIdentity ? foreignIdentity : identity,
            enrollment,
            coordinator: publicAccount.coordinator,
            archive,
            selector,
            signal: enrollment.signal,
          });
        } finally {
          preflightActive = false;
          corruptSelectorKey = false;
          rejectRoot = false;
        }
        const refused = wrongIdentity || badKey || badRoot;
        assert.equal(result.status, refused ? 'refused' : 'derived');
        if (refused)
          assert.equal(
            result.stage,
            wrongIdentity ? 'context' : badRoot ? 'preflight:txid' : 'recovery:callback'
          );
        for (const [name, value] of Object.entries(result)) {
          assert.ok(['status', 'stage'].includes(name) || typeof value === 'boolean');
          assert.ok(
            !['blindedCommitment', 'bindingDigest', 'inputSha256', 'capture', 'selector'].includes(
              name
            )
          );
        }
        if (!refused) {
          for (const name of ['selectorDerived', 'receiverMatched', 'utilityExitObserved'])
            assert.equal(result[name], true);
          for (const name of [
            'sourceAuthenticated',
            'currentFinalityVerified',
            'txidRootAccepted',
            'membershipAuthenticated',
            'disclosureEnabled',
            'spendingEnabled',
          ])
            assert.equal(result[name], false);
        }
        const expectedKeys = wrongIdentity || badRoot ? 0 : 1;
        assert.equal(selectorKeyReplies - beforeKeys, expectedKeys);
        assert.equal(selectorResults - beforeResults, refused ? 0 : 1);
        assert.ok(
          selectorKeyBuffers.every(
            (key) => key.byteLength === 32 && key.every((byte) => byte === 0)
          )
        );
        const rootPairs = wrongIdentity ? 0 : badRoot ? 1 : 4;
        assert.deepEqual(serviceMethods, {
          latest: beforeServices.latest + rootPairs,
          validate: beforeServices.validate + rootPairs,
          page: beforeServices.page,
        });
        if (!wrongIdentity) assertCaptureRpc(beforeRpc, true);
        else if (wrongIdentity) assert.deepEqual(rpcSnapshot(), beforeRpc);
        assert.deepEqual(sourceMaintenance, beforeMaintenance);
        assert.deepEqual(await durableSnapshot(), beforeDurable);
        for (const [name, counts] of Object.entries(jobs)) {
          assert.equal(counts.starts, counts.exits);
          const prior = beforeJobs[name] || { keyHandoffs: 0, starts: 0 };
          if (name === 'railgun-poi-transact-selector-job.js') {
            assert.equal(counts.starts - prior.starts, expectedKeys);
            assert.equal(counts.keyHandoffs - prior.keyHandoffs, expectedKeys);
          } else assert.equal(counts.keyHandoffs, prior.keyHandoffs);
        }
        selectorRuns.push({
          mode,
          refused,
          elapsedMs: Math.round(performance.now() - began),
          viewingKeyReplies: expectedKeys,
          selectorMatchedInBroker: !refused,
          wrongKeyRejectedAtDerivedIdentityCheck: badKey,
          allChildrenExited: true,
          keyBuffersWiped: true,
          durableStateUnchanged: true,
          rootPairs,
          phaseTimings: phaseTimings.slice(timingStart),
          ownedListCalls: 0,
        });
      };
      await checkedSelector('selector-healthy');
      await checkedSelector('selector-wrong-identity', { wrongIdentity: true });
      await checkedSelector('selector-corrupt-viewing-key', { badKey: true });
      await checkedSelector('selector-after-corrupt-key');
      await checkedSelector('selector-root-refusal', { badRoot: true });
      await checkedSelector('selector-after-root-refusal');
      assert.equal(selectorKeyReplies, 4);
      assert.equal(selectorResults, 3);
      assert.deepEqual(
        selectorRuns.map((run) => run.mode),
        [
          'selector-healthy',
          'selector-wrong-identity',
          'selector-corrupt-viewing-key',
          'selector-after-corrupt-key',
          'selector-root-refusal',
          'selector-after-root-refusal',
        ]
      );
    }
    if (membershipQualification) {
      const {
        openRailgunOwnTransactPoiMembership: openTransact,
        openRailgunOwnPoiMembership: openShield,
        assertRailgunOwnPoiMembership: assertMembership,
      } = require('../src/main/wallet/railgun-own-poi-membership');
      const {
        deriveRailgunOwnTransactPoiSelector: diagnostic,
      } = require('../src/main/wallet/railgun-poi-transact-selector');
      const {
        proveRailgunOwnPoi,
        assertRailgunOwnPoiProof,
      } = require('../src/main/wallet/railgun-own-poi-proof');
      const {
        normalizeRailgunOwnPoiProofInput,
        expectedRailgunOwnPoiFields,
        bindRailgunOwnPoiPayload,
      } = require('../src/main/wallet/railgun-own-poi-proof-data');
      const options = {
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        archive,
        selector,
        signal: enrollment.signal,
      };
      const durableSnapshot = async () => {
        const reservations = await enrollment.openReservations(),
          capsules = await enrollment.openPrivateCapsules(),
          entries = [];
        await reservations.withSigningRecovery(async (records, context) => {
          for (const { entry, receipt } of records) {
            context.assertCurrent();
            entries.push({ entry, stored: await capsules.readSigned(receipt) });
          }
          context.assertCurrent();
        });
        return { entries, journal: await journal.readSnapshot() };
      };
      const runMembership = async (name, fault = 'healthy') => {
        phase = name;
        const beforeDurable = await durableSnapshot(),
          beforeServices = { ...serviceMethods },
          beforePoi = Object.values(poiMethods),
          beforeRpc = rpcSnapshot(),
          beforeKeys = selectorKeyReplies,
          beforeResults = selectorResults,
          beforeJobs = JSON.parse(JSON.stringify(jobs)),
          beforeMaintenance = { ...sourceMaintenance },
          beforeAcquisitions = rootAcquisitions.length,
          beforeAges = rootAdmissionAges.length,
          beforeCompletions = postAcquisitionVerifierEntryAges.length;
        selectorTimingStart = phaseTimings.length;
        preflightActive = membershipActive = true;
        membershipFault = fault;
        rejectValidation = fault === 'fifth-root' ? serviceMethods.validate + 5 : null;
        const began = performance.now();
        let value;
        try {
          value = await openTransact(options);
          const healthy = fault === 'healthy';
          assert.equal(
            value.status,
            healthy ? 'verified' : 'refused',
            'membership stage ' + value.stage
          );
          if (!healthy)
            assert.equal(
              value.stage,
              fault === 'fifth-root'
                ? 'root'
                : ['type', 'signature'].includes(fault)
                  ? 'acquire'
                  : fault === 'path'
                    ? 'membership-verify'
                    : 'membership-status'
            );
          if (healthy) {
            membershipOperations.add(value);
            const observed = assertMembership(
              value.receipt,
              enrollment,
              publicAccount.coordinator,
              1000
            );
            assert.equal(observed, value.observation);
            assert.equal(observed.inputType, 'Transact');
            assert.equal(observed.poiPreparation.creator.type, 'Transact');
            if (partialCreator)
              assert.equal(
                observed.creatorProvenance.verification.unshieldCommitmentVerified,
                true
              );
            else
              assert.equal(
                Object.hasOwn(
                  observed.creatorProvenance.verification,
                  'unshieldCommitmentVerified'
                ),
                false
              );
            assert.deepEqual(observed.membership.proofs, [payload.proof]);
            assert.equal(observed.membership.membershipVerified, true);
            assert.equal(observed.selector.blindedCommitment, payload.blindedCommitment);
            for (const flag of [
              'accountAuthenticated',
              'sourceAuthenticated',
              'currentFinalityVerified',
              'disclosureEnabled',
              'spendingEnabled',
            ])
              assert.equal(observed[flag], false);
            assert.throws(() => assertMembership({}, enrollment, publicAccount.coordinator));
            assert.throws(() =>
              assertMembership({ ...value.receipt }, enrollment, publicAccount.coordinator)
            );
            assert.throws(() => assertMembership(value.receipt, {}, publicAccount.coordinator));
            const heldJobs = JSON.stringify(jobs),
              heldKeys = selectorKeyReplies,
              heldTraffic = JSON.stringify({ serviceMethods, poiMethods, methods });
            for (const call of [
              () => diagnostic(options),
              () => openTransact(options),
              () => {
                const { identity: _identity, ...shieldOptions } = options;
                return openShield(shieldOptions);
              },
            ]) {
              const blocked = await call();
              assert.equal(blocked.status, 'refused');
              assert.ok(['context', 'busy'].includes(blocked.stage));
            }
            assert.equal(JSON.stringify(jobs), heldJobs);
            assert.equal(selectorKeyReplies, heldKeys);
            assert.equal(JSON.stringify({ serviceMethods, poiMethods, methods }), heldTraffic);
            if (proofQualification && name === 'membership-healthy') {
              const normalized = normalizeRailgunOwnPoiProofInput({
                archive,
                proverArchive,
                artifactDirectory,
                descriptor: enrollment.descriptor,
                preparation: observed.poiPreparation,
                listProofs: observed.membership.proofs,
              });
              const expected = expectedRailgunOwnPoiFields(normalized);
              const traffic = () =>
                JSON.stringify({ serviceMethods, poiMethods, methods, roleMethods });
              const proofTraffic = traffic(),
                proofStarted = performance.now();
              const proofOptions = {
                identity,
                enrollment,
                coordinator: publicAccount.coordinator,
                archive,
                proverArchive,
                artifactDirectory,
                membershipReceipt: value.receipt,
                signal: enrollment.signal,
              };
              const proof = await proveRailgunOwnPoi(proofOptions);
              assert.equal(proof.status, 'proved', 'proof stage ' + proof.stage);
              assert.equal(proof.separatelyVerified, true);
              assert.equal(proof.utilityExitObserved, true);
              const history = assertRailgunOwnPoiProof(
                proof,
                enrollment,
                publicAccount.coordinator
              );
              assert.deepEqual(history.preparation.creator, normalized.preparation.creator);
              assert.equal(Object.hasOwn(history, 'creatorProvenance'), false);
              assert.deepEqual(bindRailgunOwnPoiPayload(proof.payload, expected), proof.payload);
              assert.equal(proof.payloadSha256, sha(JSON.stringify(proof.payload)));
              assert.equal(proof.inputSha256, sha(JSON.stringify(normalized)));
              for (const flag of [
                'accountAuthenticated',
                'sourceAuthenticated',
                'currentFinalityVerified',
                'membershipAuthenticated',
                'rootAccepted',
                'disclosureEnabled',
                'spendingEnabled',
              ])
                assert.equal(proof[flag], false);
              assert.equal(traffic(), proofTraffic);
              assert.equal(proofKeyReplies, 1);
              assert.equal(proofResults, 1);
              for (const job of ['railgun-own-poi-prove-job.js', 'railgun-poi-verify-job.js']) {
                assert.equal(jobs[job].starts, 1);
                assert.equal(jobs[job].exits, 1);
              }
              assert.equal(jobs['railgun-poi-verify-job.js'].keyHandoffs, 0);
              const jobsAfter = JSON.stringify(jobs);
              assert.deepEqual(await proveRailgunOwnPoi(proofOptions), {
                status: 'refused',
                stage: 'context',
              });
              assert.equal(JSON.stringify(jobs), jobsAfter);
              assert.equal(proofKeyReplies, 1);
              assert.equal(traffic(), proofTraffic);
              assert.ok(
                proofKeyBuffers.every(
                  (key) => key.byteLength === 32 && key.every((byte) => byte === 0)
                )
              );
              savedProof = proof;
              let prepareOutcome = 'deferred-until-membership-closed';
              if (!outputQualification) {
                // After the connected milestone's reviewed type guard widening,
                // proof-only mode must also genuinely prepare. Earlier reports of
                // a context-stage guard refusal remain historical evidence only.
                let store = await enrollment.openPoiIntents();
                try {
                  const { getPrivacyStoragePath } = require('../src/main/wallet/privacy-storage');
                  const intentFile = getPrivacyStoragePath(
                    enrollment.getContext(
                      'storage',
                      'railgun-poi-intents-v1:' + enrollment.descriptor.walletId
                    ),
                    enrollment.directory
                  );
                  const manifestFile = path.join(
                    path.dirname(enrollment.directory),
                    path.basename(enrollment.directory).replace(/^account-/, '') + '.json'
                  );
                  assert.ok(fs.existsSync(manifestFile));
                  const snapshot = async () => ({
                    inspect: await store.inspect(),
                    list: await store.list(),
                    intent: fs.existsSync(intentFile) ? sha(fs.readFileSync(intentFile)) : null,
                    manifest: sha(fs.readFileSync(manifestFile)),
                  });
                  const prior = await snapshot();
                  assert.deepEqual(prior.list, []);
                  const operation = require('../src/main/wallet/railgun-own-operation');
                  const originalRecovery = operation.withRailgunOwnOperationRecovery;
                  let recoveries = 0;
                  operation.withRailgunOwnOperationRecovery = (...args) => {
                    recoveries++;
                    return originalRecovery(...args);
                  };
                  try {
                    const prepared = await store.prepare({
                      proof,
                      coordinator: publicAccount.coordinator,
                      signal: enrollment.signal,
                    });
                    assert.equal(prepared.status, 'prepared');
                    assert.equal(recoveries, 1);
                    const entry = await store.get(prepared.capsuleDigest);
                    assert.equal(entry.state, 'prepared');
                    assert.deepEqual(entry.payload, proof.payload);
                    assert.equal(entry.payloadSha256, proof.payloadSha256);
                    prepareOutcome = 'genuine-prepared';
                  } finally {
                    operation.withRailgunOwnOperationRecovery = originalRecovery;
                  }
                  const logical = { inspect: await store.inspect(), list: await store.list() };
                  store.close();
                  await store.closed;
                  store = await enrollment.openPoiIntents();
                  // Reopen deliberately rotates the encrypted store lease and
                  // rewrites its manifest floor; only logical state is invariant.
                  assert.deepEqual(await store.inspect(), logical.inspect);
                  assert.deepEqual(await store.list(), logical.list);
                  assert.equal(JSON.stringify(jobs), jobsAfter);
                  assert.equal(traffic(), proofTraffic);
                } finally {
                  store.close();
                  await store.closed;
                }
              }
              proofRuns.push({
                mode: 'genuine-transact-proof',
                elapsedMs: Math.round(performance.now() - proofStarted),
                viewingKeyReplies: 1,
                proofResults: 1,
                independentKeylessVerifiers: 1,
                registeredProof: true,
                payloadMetadataComparedPrivately: true,
                noExtraServiceTraffic: true,
                reusedMembershipRefused: true,
                prepareOutcome,
                reopenLogicalStateUnchanged: !outputQualification,
                keyBuffersWiped: true,
                allChildrenExited: true,
              });
            }
            assert.equal(
              assertMembership(value.receipt, enrollment, publicAccount.coordinator),
              observed
            );
          }
          const expectedList =
            fault === 'fifth-root'
              ? [0, 0, 0, 0]
              : ['signature', 'type'].includes(fault)
                ? [1, 1, 1, 0]
                : [1, 1, 1, 1];
          assert.deepEqual(
            Object.values(poiMethods).map((n, i) => n - beforePoi[i]),
            expectedList
          );
          assert.deepEqual(serviceMethods, {
            latest: beforeServices.latest + 5,
            validate: beforeServices.validate + 5,
            page: beforeServices.page,
          });
          assert.deepEqual(
            rootAcquisitions.slice(beforeAcquisitions),
            Array.from({ length: 5 }, (_, i) => beforeServices.latest + i)
          );
          assertCaptureRpc(beforeRpc, true);
          assert.deepEqual(sourceMaintenance, beforeMaintenance);
          assert.equal(selectorKeyReplies - beforeKeys, 1);
          assert.equal(selectorResults - beforeResults, 1);
          const expectedMembership = ['healthy', 'path'].includes(fault) ? 1 : 0;
          const memberJob = jobs['railgun-poi-job.js'] || { starts: 0, exits: 0 };
          assert.equal(
            memberJob.starts - (beforeJobs['railgun-poi-job.js']?.starts ?? 0),
            expectedMembership
          );
          assert.equal(
            memberJob.exits - (beforeJobs['railgun-poi-job.js']?.exits ?? 0),
            expectedMembership
          );
          assert.equal(
            rootAdmissionAges.length - beforeAges,
            expectedList.reduce((a, b) => a + b, 0)
          );
          assert.equal(
            postAcquisitionVerifierEntryAges.length - beforeCompletions,
            ['healthy', 'path'].includes(fault) ? 1 : 0
          );
          membershipRuns.push({
            mode: name,
            fault,
            verified: healthy,
            elapsedMs: Math.round(performance.now() - began),
            viewingKeyReplies: 1,
            selectorResults: 1,
            rootPairs: 5,
            sourceCalls: expectedList,
            membershipJobs: expectedMembership,
            genuineRegistryAndTypedMembership: healthy,
            ...(partialCreator && healthy
              ? { creatorHashDiagnosticSurvivedRegistry: true, copiedReceiptRefused: true }
              : {}),
            localProofQualified: healthy && proofQualification && name === 'membership-healthy',
            sharedOwnerExclusion: healthy,
            capsuleAndEoaJournalUnchanged: true,
            poiIntentPrepared:
              healthy &&
              proofQualification &&
              !outputQualification &&
              name === 'membership-healthy',
            allChildrenExited: true,
            keyBuffersWiped: true,
          });
        } finally {
          if (value?.status === 'verified') {
            value.close();
            await value.closed;
            membershipOperations.delete(value);
            assert.throws(() =>
              assertMembership(value.receipt, enrollment, publicAccount.coordinator)
            );
          }
          // A refused public open already awaits its admitted-work/source drain.
          preflightActive = membershipActive = false;
          membershipFault = 'healthy';
          rejectValidation = null;
        }
        for (const counts of Object.values(jobs)) assert.equal(counts.starts, counts.exits);
        assert.ok(
          selectorKeyBuffers.every(
            (key) => key.byteLength === 32 && key.every((byte) => byte === 0)
          )
        );
        assert.deepEqual(await durableSnapshot(), beforeDurable);
        for (const client of poiClients) await client.closed;
        assert.equal(externalAttempts, 0);
        assert.equal(unexpectedRpc, 0);
      };
      await runMembership('membership-healthy');
      for (const fault of ['fifth-root', 'type', 'signature', 'path', 'list-root']) {
        await runMembership('membership-' + fault, fault);
        await runMembership('membership-after-' + fault);
      }
      assert.equal(membershipRuns.length, 11);
      assert.equal(proofRuns.length, proofQualification ? 1 : 0);
    }

    if (outputQualification) {
      assert.ok(savedProof);
      assert.equal(membershipOperations.size, 0);
      assert.equal(membershipActive, false);
      assert.equal(preflightActive, false);
      for (const client of poiClients) await client.closed;
      const {
        openRailgunOwnPoiChecks,
        assertRailgunOwnPoiChecks,
      } = require('../src/main/wallet/railgun-own-poi-checks');
      const {
        recoverRailgunPoiOutput,
        recoverRailgunAttemptedPoiOutput,
      } = require('../src/main/wallet/railgun-poi-output-recovery');
      const {
        validateRailgunRetainedPoi,
        validateRailgunRetainedPoiHistory,
      } = require('../src/main/wallet/railgun-poi-cold-validation');
      const {
        prepareRailgunPoiDisclosurePlan,
        submitRailgunRetainedPoi,
      } = require('../src/main/wallet/railgun-poi-disclosure-plan');
      const { getPrivacyStoragePath } = require('../src/main/wallet/privacy-storage');
      const { claimRailgunAccountPhase } = require('../src/main/wallet/railgun-account-phase');
      const common = () => ({
        identity,
        enrollment,
        coordinator: publicAccount.coordinator,
        archive,
        signal: enrollment.signal,
        capsuleDigest: connectedPrepared.capsuleDigest,
      });
      const coldOptions = () => ({ ...common(), proverArchive, artifactDirectory });
      const counters = () =>
        copy({
          connected,
          connectedJobs,
          methods,
          roleMethods,
          serviceMethods,
          poiMethods,
          jobs,
          selectorKeyReplies,
          selectorResults,
          proofKeyReplies,
          proofResults,
          sourceMaintenance,
          externalAttempts,
          unexpectedRpc,
        });
      const delta = (after, before) =>
        Object.fromEntries(
          [...new Set([...Object.keys(after), ...Object.keys(before)])].map((key) => [
            key,
            (after[key] || 0) - (before[key] || 0),
          ])
        );
      const privateDurable = async () => {
        const reservations = await enrollment.openReservations(),
          capsules = await enrollment.openPrivateCapsules();
        return copy({
          reservations: await reservations.inspect(),
          capsules: await capsules.inspect(),
          stored: await capsules.get(setupHoldId),
        });
      };
      const assertDurable = (actual, expected) => {
        const { isDeepStrictEqual } = require('util');
        const fields = [
          'entry',
          'inspect',
          'journal',
          'encrypted',
          'manifest',
          'privateRecords',
          'privateEncrypted',
        ];
        const changed = Object.fromEntries(
          fields.map((name) => [name, !isDeepStrictEqual(actual[name], expected[name])])
        );
        if (Object.values(changed).some(Boolean))
          console.error(JSON.stringify({ phase: 'connected-durable-difference', changed }));
        // Print no values, hashes, record identifiers, filenames or dynamic keys.
        // Every logical and byte-level invariant remains mandatory.
        assert.deepEqual(actual, expected);
      };
      const durable = async () => {
        const filename = getPrivacyStoragePath(
          enrollment.getContext(
            'storage',
            'railgun-poi-intents-v1:' + enrollment.descriptor.walletId
          ),
          enrollment.directory
        );
        const manifest = path.join(
          path.dirname(enrollment.directory),
          path.basename(enrollment.directory).replace(/^account-/, '') + '.json'
        );
        const privateRecords = await privateDurable();
        const privateEncrypted = {};
        for (const name of ['reservations', 'capsules']) {
          const target = getPrivacyStoragePath(
            enrollment.getContext(
              'storage',
              'railgun-private-' + name + '-v1:' + enrollment.descriptor.walletId
            ),
            enrollment.directory
          );
          privateEncrypted[name] = sha(fs.readFileSync(target));
        }
        return {
          privateRecords,
          privateEncrypted,
          entry: copy(await intentStore.get(connectedPrepared.capsuleDigest)),
          inspect: await intentStore.inspect(),
          journal: await journal.readSnapshot(),
          encrypted: sha(fs.readFileSync(filename)),
          manifest: sha(fs.readFileSync(manifest)),
        };
      };
      const jobDelta = (before) =>
        Object.fromEntries(
          Object.entries(connectedJobs).map(([name, now]) => {
            const prior = before.connectedJobs[name] || {};
            return [
              name,
              {
                ...delta(
                  {
                    starts: now.starts,
                    exits: now.exits,
                    results: now.results,
                    admittedResults: now.admittedResults,
                    keys: now.keys,
                    guards: now.guards,
                  },
                  {
                    starts: prior.starts || 0,
                    exits: prior.exits || 0,
                    results: prior.results || 0,
                    admittedResults: prior.admittedResults || 0,
                    keys: prior.keys || 0,
                    guards: prior.guards || 0,
                  }
                ),
                methods: delta(now.methods, prior.methods || {}),
                closedCodes: delta(now.closedCodes, prior.closedCodes || {}),
              },
            ];
          })
        );
      // Exact closed two-row mirror work. Every restore performs one inspect;
      // the creator witness is an additional read/restore, never another open.
      const verifyActivity = (
        before,
        {
          queried = true,
          history = false,
          verify = false,
          viewing = kind === 'transfer',
          roots = 0,
          posts = 0,
          handshake = false,
          fault = 'healthy',
        } = {}
      ) => {
        const after = counters(),
          q = Number(queried),
          h = Number(history),
          v = Number(queried && viewing),
          snark = Number(queried && verify);
        assert.deepEqual(delta(serviceMethods, before.serviceMethods), {
          latest: q * (4 + 3 * h),
          validate: q * (4 + 3 * h),
          page: 0,
        });
        if (queried) assertCaptureRpc(before.roleMethods, true, handshake);
        else assert.deepEqual(roleMethods, before.roleMethods);
        assert.deepEqual(poiMethods, before.poiMethods);
        assert.deepEqual(sourceMaintenance, before.sourceMaintenance);
        for (const key of [
          'selectorKeyReplies',
          'selectorResults',
          'proofKeyReplies',
          'proofResults',
          'externalAttempts',
          'unexpectedRpc',
        ])
          assert.equal(after[key], before[key]);
        const expected = {
          'railgun-public-job.js': q,
          'railgun-own-selector-job.js': q * (1 + h),
          'railgun-own-txid-job.js': q,
          'railgun-note-provenance-job.js': q,
          inspect: q * (3 + 3 * h),
          witness: q * (1 + h),
          'note-witness': q,
          'historical-root': q * h,
          'railgun-poi-output-recover-job.js': v,
          'railgun-poi-verify-job.js': snark,
        };
        const deltas = jobDelta(before);
        for (const name of new Set([...Object.keys(deltas), ...Object.keys(expected)])) {
          const count = expected[name] || 0,
            d = deltas[name];
          if (!d) {
            assert.equal(count, 0);
            continue;
          }
          const invalid = name === 'railgun-poi-verify-job.js' && fault === 'invalid-snark';
          const refusedOutput =
            name === 'railgun-poi-output-recover-job.js' && fault === 'substituted-output';
          assert.equal(d.starts, count, name + ':starts');
          assert.equal(d.exits, count, name + ':exits');
          assert.equal(d.results, invalid ? 0 : count, name + ':results');
          assert.equal(
            d.admittedResults,
            invalid || refusedOutput ? 0 : count,
            name + ':admissions'
          );
          assert.equal(d.guards, invalid ? 0 : count);
          assert.equal(d.keys, name === 'railgun-poi-output-recover-job.js' ? count : 0);
          const exitCodes = Object.fromEntries(Object.entries(d.closedCodes).filter(([, n]) => n));
          assert.deepEqual(
            exitCodes,
            !count
              ? {}
              : {
                  [invalid
                    ? 'RAILGUN_PROCESS_FAILED'
                    : refusedOutput
                      ? 'RAILGUN_SESSION_REVOKED'
                      : 'RAILGUN_PROCESS_CLOSED']: count,
                },
            name + ':closed'
          );
          const present = Object.fromEntries(Object.entries(d.methods).filter(([, n]) => n));
          const gets = { inspect: 1, witness: 4, 'note-witness': 6, 'historical-root': 5 };
          const methods = !count
            ? {}
            : Object.hasOwn(gets, name)
              ? { input: count, get: gets[name] * count, result: count }
              : name === 'railgun-public-job.js'
                ? { sourceNext: 2 * count, jobResult: count }
                : name === 'railgun-poi-output-recover-job.js'
                  ? { key: count, result: count }
                  : invalid
                    ? {}
                    : { result: count };
          assert.deepEqual(present, methods, name + ':broker');
        }
        // The general process observer catches unknown jobs even if they never
        // reach a connected broker; no new identity/prover/key-bearing role.
        const starts = Object.fromEntries(
          Object.entries(jobs)
            .map(([name, n]) => [name, n.starts - (before.jobs[name]?.starts || 0)])
            .filter(([, n]) => n)
        );
        const expectedStarts = Object.fromEntries(
          Object.entries(expected).filter(
            ([name, n]) =>
              n && !['inspect', 'witness', 'note-witness', 'historical-root'].includes(name)
          )
        );
        const mirror = q * (5 + 5 * h);
        if (mirror) expectedStarts['railgun-txid-job.js'] = mirror;
        assert.deepEqual(starts, expectedStarts);
        const d = delta(connected, before.connected);
        const rpcCount = Object.values(delta(methods, before.methods)).reduce((a, b) => a + b, 0);
        assert.equal(d.transportCalls, rpcCount + roots * 2 + posts);
        assert.equal(d.attempted, roots * 2 + posts);
        assert.equal(d.validated, d.attempted);
        assert.equal(d.list, roots);
        assert.equal(d.txid, roots);
        assert.equal(d.post, posts);
        assert.equal(d.outputKeys, v);
        assert.equal(d.outputResults, v);
        assert.equal(d.outputAdmissions, fault === 'substituted-output' ? 0 : v);
        assert.equal(
          d.substitutions,
          ['substituted-output', 'invalid-snark', 'substituted-history-root'].includes(fault)
            ? 1
            : 0
        );
        assert.equal(d.unexpected, 0);
        assert.equal(d.assertionFailures, 0);
        assert.equal(
          d.guards,
          Object.values(expected).reduce((a, b) => a + b, 0) - Number(fault === 'invalid-snark')
        );
        assert.ok(
          connectedKeyBuffers.every(
            (bytes) => bytes.byteLength === 32 && bytes.every((v) => v === 0)
          )
        );
        for (const value of Object.values(jobs)) assert.equal(value.starts, value.exits);
        return {
          serviceCalls: delta(serviceMethods, before.serviceMethods),
          rpcCallsByRole: Object.fromEntries(
            Object.keys(roleMethods).map((role) => [
              role,
              delta(roleMethods[role], before.roleMethods[role]),
            ])
          ),
          jobs: deltas,
          wireAndCredentialCounts: d,
        };
      };
      const optionsForOutput = (attempted) =>
        attempted ? recoverRailgunAttemptedPoiOutput(common()) : recoverRailgunPoiOutput(common());
      const runConnected = async (name, use, expectedStatus, expectedStage, specification = {}) => {
        phase = 'connected-' + name;
        const initial = await durable(),
          before = counters(),
          timingStart = phaseTimings.length,
          started = performance.now();
        connectedActive = preflightActive = true;
        connectedFault = specification.fault || 'healthy';
        let value;
        try {
          value = await use();
          assert.equal(value.status, expectedStatus, name + ':' + value.stage);
          if (expectedStage) assert.equal(value.stage, expectedStage);
          if (value.status === 'matched') {
            assert.equal(value.capsuleDigest, connectedPrepared.capsuleDigest);
            assert.equal(value.payloadSha256, savedProof.payloadSha256);
            assert.equal(value.outputMatched, true);
            assert.equal(value.viewingKeyReleases, Number(kind === 'transfer'));
            if (value.recordState === 'attempted') {
              assert.equal(value.attemptBodySha256, initial.entry.attempt.submission.bodySha256);
              for (const key of [
                'attemptOutcomeKnown',
                'eligibilityEstablished',
                'submissionAccepted',
                'retryEnabled',
              ])
                assert.equal(value[key], false);
            }
          }
          if (value.status === 'validated') {
            for (const key of [
              'outputMatched',
              'proofVerified',
              'independentlyVerified',
              'verifierExitObserved',
            ])
              assert.equal(value[key], true);
            if (specification.history)
              for (const key of [
                'historicalRootMatchesLocalMirror',
                'ownTxidIncludedBySavedIndex',
                'localMirrorCheckpointMatched',
              ])
                assert.equal(value[key], true);
          }
          if (['matched', 'validated'].includes(value.status))
            for (const key of [
              'originalRootsAccepted',
              'membershipAuthenticated',
              'sourceAuthenticated',
              'disclosureEnabled',
              'spendingEnabled',
            ])
              assert.equal(value[key], false);
        } finally {
          value?.close?.();
          if (value?.closed) await value.closed;
          connectedActive = preflightActive = false;
          connectedFault = 'healthy';
        }
        const activity = verifyActivity(before, specification);
        assertDurable(await durable(), initial);
        const timings = phaseTimings.slice(timingStart);
        if (specification.queried !== false) {
          assert.equal(timings.filter((v) => v.name === 'retained-source').length, 1);
          assert.equal(timings.filter((v) => v.name === 'retained-preflight').length, 1);
          assert.ok(timings.every((v) => v.completed && v.elapsedMs >= 0));
          const tail = timings.find(
            (v) => v.name === 'retained-preflight'
          ).sourceReturnToPreflightCompletionMs;
          assert.ok(Number.isSafeInteger(tail) && tail >= 0 && tail < 55000);
        } else assert.deepEqual(timings, []);
        connectedRuns.push({
          mode: name,
          status: value.status,
          ...(expectedStage ? { stage: value.stage } : {}),
          elapsedMs: Math.round(performance.now() - started),
          ...activity,
          timings,
          journalAndIntentBytesUnchanged: true,
          ownedQueries: 0,
          addedPoiProvers: 0,
          keyBuffersWiped: true,
          allChildrenExited: true,
          overallAuthorityGranted: false,
        });
        return value;
      };
      phase = 'connected-genuine-prepare';
      intentStore = await enrollment.openPoiIntents();
      const empty = await intentStore.inspect(),
        prepBefore = counters();
      assert.equal(empty.records, 0);
      const prepared = await intentStore.prepare({
        proof: savedProof,
        coordinator: publicAccount.coordinator,
        signal: enrollment.signal,
      });
      // Requires the reviewed Shield/Transact type guard. Never seed intent
      // ciphertext or spoof the genuine proof registry.
      assert.equal(prepared.status, 'prepared', 'connected prepare requires reviewed type guard');
      connectedPrepared = copy(await intentStore.get(prepared.capsuleDigest));
      assert.equal(connectedPrepared.state, 'prepared');
      assert.deepEqual(connectedPrepared.payload, savedProof.payload);
      assert.equal(connectedPrepared.payloadSha256, savedProof.payloadSha256);
      assert.equal(connectedPrepared.inputSha256, savedProof.inputSha256);
      assert.equal(connectedPrepared.revision, 1);
      assert.equal((await intentStore.inspect()).reservedTransitions, 3);
      assert.deepEqual(counters(), prepBefore);
      connectedRuns.push({
        mode: 'genuine-prepare-after-membership-close',
        status: 'prepared',
        realProofRegistry: true,
        encryptedIntentCreated: true,
        noAdditionalQueriesOrUtilities: true,
      });
      await runConnected(
        'prepared-attempted-route-refused',
        () => optionsForOutput(true),
        'refused',
        'stored',
        { queried: false, viewing: false }
      );
      const check = async (forged = false) => {
        const result = await openRailgunOwnPoiChecks({
          archive,
          enrollment,
          coordinator: publicAccount.coordinator,
          proof: forged ? { ...savedProof } : savedProof,
          signal: enrollment.signal,
        });
        if (result.status === 'checked') {
          const observed = assertRailgunOwnPoiChecks(
            result.receipt,
            enrollment,
            publicAccount.coordinator,
            savedProof,
            1000
          );
          assert.deepEqual(observed.payload, savedProof.payload);
          assert.equal(observed.listRoot.accepted, true);
          assert.equal(observed.txidRoot.accepted, true);
          for (const key of [
            'rootAccepted',
            'noteStatusChecked',
            'disclosureEnabled',
            'spendingEnabled',
          ])
            assert.equal(observed[key], false);
        }
        return result;
      };
      await runConnected('forged-proof-checks', () => check(true), 'refused', 'proof-history', {
        queried: false,
        viewing: false,
      });
      await runConnected(
        'original-list-root-refused',
        () => check(),
        'refused',
        'list-root-rejected',
        { viewing: false, roots: 1, fault: 'list-reject' }
      );
      await runConnected('proof-history-checks', () => check(), 'checked', null, {
        viewing: false,
        roots: 1,
      });
      const reopen = async () => {
        const prior = await durable();
        intentStore.close();
        await intentStore.closed;
        await publicAccount.close();
        publicAccount = null;
        enrollment.close();
        enrollment = await openRailgunAccountEnrollment({ identity });
        journal = openJournal();
        publicAccount = await openRailgunAccountPublic({ enrollment, archive });
        intentStore = await enrollment.openPoiIntents({ existingOnly: true });
        // Finish local storage reopening BEFORE the operation's durable baseline.
        // Reservations/capsules rotate their own leases and persist manifest floors
        // even at unchanged logical sequence. No source snapshot, mirror or utility
        // or recovery phase is warmed; the next operation incurs the cold RPC path.
        const beforePrivateOpen = counters();
        const privateRecords = await privateDurable();
        assert.deepEqual(privateRecords, prior.privateRecords);
        assert.deepEqual(counters(), beforePrivateOpen);
        const after = await durable();
        for (const key of ['entry', 'inspect', 'journal', 'privateRecords'])
          assert.deepEqual(after[key], prior[key]);
        // New enrollment revokes proof registry ownership. Cold paths must not
        // adopt that old proof object, while retaining its encrypted payload.
        assert.throws(() =>
          require('../src/main/wallet/railgun-own-poi-proof').assertRailgunOwnPoiProof(
            savedProof,
            enrollment,
            publicAccount.coordinator
          )
        );
      };
      await reopen();
      let firstCold = true;
      if (kind === 'transfer') {
        await runConnected(
          'wrong-output',
          () => optionsForOutput(false),
          'refused',
          'recovery:callback',
          { fault: 'substituted-output', handshake: true }
        );
        firstCold = false;
      }
      await runConnected('cold-prepared-output', () => optionsForOutput(false), 'matched', null, {
        handshake: firstCold,
      });
      await runConnected(
        'invalid-snark',
        () => validateRailgunRetainedPoi(coldOptions()),
        'refused',
        'verify',
        { verify: true, fault: 'invalid-snark' }
      );
      await runConnected(
        'cold-stage-a',
        () => validateRailgunRetainedPoi(coldOptions()),
        'validated',
        null,
        { verify: true }
      );
      await runConnected(
        'wrong-historical-root',
        () => validateRailgunRetainedPoiHistory(coldOptions()),
        'refused',
        'txid-history',
        { history: true, verify: true, fault: 'substituted-history-root' }
      );
      await runConnected(
        'retained-history',
        () => validateRailgunRetainedPoiHistory(coldOptions()),
        'validated',
        null,
        { history: true, verify: true }
      );
      const send = async (mode) => {
        phase = 'connected-sender-' + mode;
        const prior = await durable(),
          before = counters(),
          timingStart = phaseTimings.length,
          started = performance.now();
        const plan = await prepareRailgunPoiDisclosurePlan({
          identity,
          enrollment,
          coordinator: publicAccount.coordinator,
          capsuleDigest: connectedPrepared.capsuleDigest,
          signal: enrollment.signal,
        });
        assert.equal(plan.status, 'prepared');
        assert.deepEqual(counters(), before);
        const purposes = [];
        connectedActive = preflightActive = true;
        postHold = mode === 'accept' ? { entered: deferred(), release: deferred() } : undefined;
        if (postHold) connectedReleases.add(postHold.release);
        let settled = false,
          timer;
        const options = {
          ...coldOptions(),
          plan: plan.plan,
          review: async (request, { signal }) => {
            assert.ok(!signal.aborted && Object.isFrozen(request));
            assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 8192);
            purposes.push(request.purpose);
            const submit = purposes.length === 2;
            assert.equal(request.purpose, submit ? 'submit-retained-poi' : 'validate-retained-poi');
            assert.equal(request.operation, kind);
            assert.equal(request.outputCount, kind === 'transfer' ? 1 : 0);
            assert.deepEqual(
              request.destinations,
              submit
                ? [{ role: 'poi-service', origin: 'https://ppoi.fdi.network' }]
                : [
                    { role: 'source-rpc', origin: new URL(rpcUrl).origin },
                    { role: 'receipt-rpc', origin: new URL(rpcUrl).origin },
                    { role: 'poi-service', origin: 'https://ppoi.fdi.network' },
                  ]
            );
            assert.deepEqual(
              request.requestInventory,
              submit
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
            for (const flag of ['consentGranted', 'transportAuthorized', 'requestLimitsEnforced'])
              assert.equal(request[flag], false);
            const lease = claimRailgunAccountPhase(enrollment, 'recovery');
            lease.release();
            assert.deepEqual(
              await intentStore.get(connectedPrepared.capsuleDigest),
              connectedPrepared
            );
            if (!submit) {
              assert.deepEqual(counters(), before);
              return mode !== 'deny-validation';
            }
            assert.equal(connected.attempted, before.connected.attempted);
            for (const job of Object.values(connectedJobs)) assert.equal(job.starts, job.exits);
            return mode !== 'deny-submission';
          },
        };
        delete options.capsuleDigest;
        const work = submitRailgunRetainedPoi(options);
        connectedPending.add(work);
        work.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          }
        );
        let result;
        try {
          if (postHold) {
            const timeout = new Promise((_, reject) => {
              timer = setTimeout(() => reject(Error('Fixture POST entry timeout')), 120000);
            });
            await Promise.race([
              postHold.entered.promise,
              timeout,
              work.then(() => {
                throw Error('Sender settled before POST barrier');
              }),
            ]);
            await new Promise((resolve) => setImmediate(resolve));
            assert.equal(settled, false);
            const held = counters(),
              heldRecord = await intentStore.get(connectedPrepared.capsuleDigest);
            assert.equal(heldRecord.state, 'attempted');
            assert.deepEqual(await recoverRailgunAttemptedPoiOutput(common()), {
              status: 'refused',
              stage: 'busy',
            });
            assert.deepEqual(counters(), held);
            assert.deepEqual(await intentStore.get(connectedPrepared.capsuleDigest), heldRecord);
            let closed = false;
            plan.closed.then(() => {
              closed = true;
            });
            await Promise.resolve();
            assert.equal(closed, false);
            postHold.release.resolve();
          }
          result = await work;
        } finally {
          clearTimeout(timer);
          postHold?.release.resolve();
          // A fixture watchdog must revoke admission before waiting for drain;
          // otherwise an early failure can leave the sender's 840s timer running.
          plan.close();
          await work.catch(() => {});
          connectedPending.delete(work);
          await plan.closed;
          connectedActive = preflightActive = false;
        }
        const queried = mode !== 'deny-validation',
          accepted = mode === 'accept';
        assert.equal(result.status, accepted ? 'recovery-required' : 'refused');
        assert.equal(
          result.stage,
          accepted ? 'response' : queried ? 'review-submit' : 'review-validation'
        );
        const activity = verifyActivity(before, {
          queried,
          history: queried,
          verify: queried,
          roots: Number(accepted),
          posts: Number(accepted),
        });
        assert.deepEqual(
          purposes,
          queried ? ['validate-retained-poi', 'submit-retained-poi'] : ['validate-retained-poi']
        );
        const timings = phaseTimings.slice(timingStart);
        if (queried) {
          assert.equal(timings.filter((v) => v.name === 'retained-source').length, 1);
          assert.equal(timings.filter((v) => v.name === 'retained-preflight').length, 1);
          assert.ok(timings.every((v) => v.completed && v.elapsedMs >= 0));
          const tail = timings.find(
            (v) => v.name === 'retained-preflight'
          ).sourceReturnToPreflightCompletionMs;
          assert.ok(Number.isSafeInteger(tail) && tail >= 0 && tail < 55000);
        } else assert.deepEqual(timings, []);
        const after = await durable();
        assert.deepEqual(after.journal, prior.journal);
        if (accepted) {
          assert.equal(result.response.classification, 'rpc-result');
          assert.equal(result.response.matchingEnvelope, true);
          assert.equal(result.response.acceptanceVerified, false);
          assert.equal(after.entry.state, 'attempted');
          assert.equal(after.inspect.sequence, prior.inspect.sequence + 1);
          assert.equal(after.inspect.reservedTransitions, 2);
          const held = counters();
          assert.equal((await submitRailgunRetainedPoi(options)).status, 'refused');
          assert.deepEqual(counters(), held);
          assertDurable(await durable(), after);
        } else assertDurable(after, prior);
        connectedRuns.push({
          mode: 'sender-' + mode,
          status: result.status,
          stage: result.stage,
          elapsedMs: Math.round(performance.now() - started),
          ...activity,
          timings,
          reviewPurposes: purposes,
          originalReceiptQueries: Number(queried),
          simulatedPost: accepted,
          durableBeforePost: accepted,
          heldPostCloseRetainsOwner: accepted,
          busyAttemptedOutputZeroWork: accepted,
          oneUsePlan: true,
          humanConsentQualified: false,
          serviceAcceptanceQualified: false,
          safeRetryEstablished: false,
        });
      };
      await send('deny-validation');
      await send('deny-submission');
      await send('accept');
      await reopen();
      await runConnected(
        'attempted-prepared-route-refused',
        () => optionsForOutput(false),
        'refused',
        'stored',
        { queried: false, viewing: false }
      );
      await runConnected(
        'attempted-stage-a-refused',
        () => validateRailgunRetainedPoi(coldOptions()),
        'refused',
        'stored',
        { queried: false, viewing: false }
      );
      await runConnected(
        'attempted-history-refused',
        () => validateRailgunRetainedPoiHistory(coldOptions()),
        'refused',
        'stored',
        { queried: false, viewing: false }
      );
      firstCold = true;
      if (kind === 'transfer') {
        await runConnected(
          'attempted-wrong-output',
          () => optionsForOutput(true),
          'refused',
          'recovery:callback',
          { fault: 'substituted-output', handshake: true }
        );
        firstCold = false;
      }
      await runConnected('cold-attempted-output', () => optionsForOutput(true), 'matched', null, {
        handshake: firstCold,
      });
      assert.equal(connected.post, 1);
      assert.equal(connected.attempted, connected.validated);
      assert.equal(connected.assertionFailures, 0);
      assert.equal((await intentStore.inspect()).reservedTransitions, 2);
      assert.deepEqual(
        connectedRuns.map((run) => run.mode),
        [
          'genuine-prepare-after-membership-close',
          'prepared-attempted-route-refused',
          'forged-proof-checks',
          'original-list-root-refused',
          'proof-history-checks',
          ...(kind === 'transfer' ? ['wrong-output'] : []),
          'cold-prepared-output',
          'invalid-snark',
          'cold-stage-a',
          'wrong-historical-root',
          'retained-history',
          'sender-deny-validation',
          'sender-deny-submission',
          'sender-accept',
          'attempted-prepared-route-refused',
          'attempted-stage-a-refused',
          'attempted-history-refused',
          ...(kind === 'transfer' ? ['attempted-wrong-output'] : []),
          'cold-attempted-output',
        ]
      );
    }

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
          ...(partialCreator
            ? {
                creatorMode: 'partial',
                creatorInputAmount: '1500',
                creatorUnshieldAmount: '500',
                recoveredOutputAmount: '1000',
                creatorOutputKind: senderKind === 'self' ? 'change' : 'received-transfer',
                mainPartialAdmissionEnabled: false,
                creatorSpendProofValidityVerified: false,
              }
            : {}),
          sourceSha256: before,
          runs,
          rpcMethods: methods,
          jobs,
          phaseTimings,
          captureEvidence,
          typedMembershipVerified: membershipQualification,
          membershipQualification,
          membershipRuns,
          proofQualification,
          proofRuns,
          outputQualification,
          connectedRuns,
          connectedJobs,
          connectedCounters: connected,
          privateStoreHousekeepingBeforeColdOperationBaseline: outputQualification,
          coldPublicSourceAndMirrorPreserved: outputQualification,
          outputViewingKeys: connected.outputKeys,
          simulatedPoiPosts: connected.post,
          trustedReviewAdapterSimulated: outputQualification,
          serviceAcceptanceQualified: false,
          humanConsentQualified: false,
          connectedKeyBuffersWiped: connectedKeyBuffers.every((bytes) =>
            bytes.every((v) => v === 0)
          ),
          proofKeyReplies,
          proofResults,
          poiMethods,
          rootAdmissionAges,
          postAcquisitionVerifierEntryAges,
          serviceSignatureTrust: membershipQualification ? 'disposable-fixture-key' : null,
          viewingKeyReleases: selectorKeyReplies + proofKeyReplies + connected.outputKeys,
          selectorQualification,
          selectorRuns,
          selectorKeyTimings,
          selectorDiagnosticOmitsLinkableValues: selectorQualification,
          selectorExpectedValueComparedPrivately: selectorQualification,
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
          liveSubmissions: 0,
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
      for (const gate of connectedReleases) gate.resolve();
      await Promise.allSettled([...connectedPending]);
      for (const client of connectedClients) client.close();
      await Promise.all([...connectedClients].map((client) => client.closed));
      intentStore?.close();
      if (intentStore) await intentStore.closed;
      for (const operation of membershipOperations) operation.close();
      await Promise.all([...membershipOperations].map((operation) => operation.closed));
      for (const client of poiClients) client.close();
      await Promise.all([...poiClients].map((client) => client.closed));
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
      rootsModule.createRailgunTxidRootSource = originalRoots;
      membershipModule.verifyRailgunPoiMembership = originalMembershipVerify;
      signature?.close();
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
