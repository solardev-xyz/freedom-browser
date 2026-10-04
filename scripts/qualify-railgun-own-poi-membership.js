/** Offline enrolled post-spend Shield membership. Genuine stores and receipts;
 * synthetic chain/root services, fixture-key service-signature trust, structural
 * spend proof/signature. No external transport or owned-note disclosure.
 * electron script NEW_DIRECTORY ENGINE_ASAR transfer|unshield
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
  'src/main/wallet/railgun-poi-witness.js',
  'src/main/wallet/railgun-poi-witness.test.js',
  'src/main/wallet/railgun-poi-shield-selector.js',
  'src/main/wallet/railgun-poi-shield-selector-data.js',
  'src/main/wallet/railgun-poi-shield-selector-job.js',
  'src/main/wallet/railgun-poi-source.js',
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
  const [directory, archive, kind] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
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
    onRoot;
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
    '../src/main/wallet/railgun-scan-source',
    '../src/main/wallet/railgun-txid-root',
    '../src/main/wallet/private-transaction-network',
    '../src/main/wallet/railgun-account-poi',
    '../src/main/networks/kohaku-network',
  ])
    assert.equal(require.cache[require.resolve(file)], undefined);
  transport.createWalletTorTransport = () => {
    transportCreates++;
    let closed = false,
      operation,
      cursor = 0;
    const client = {
      close() {
        if (!closed) transportCloses++;
        closed = true;
      },
      async request(handle, url, options) {
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
  const rpcModule = require('../src/main/networks/private-rpc');
  const serviceModule = require('../src/main/wallet/railgun-public-services');
  originals.rpc = rpcModule.createPrivateRpc;
  originals.services = serviceModule.createRailgunPublicServices;
  processModule.startRailgunProcess = (options) => {
    if (options.binaryKey) {
      if (phase !== 'enrollment') {
        forbiddenKeyJobs++;
        throw Error('Operation key release forbidden');
      }
      setupKeyJobs++;
    }
    const membership = options.filename === require.resolve('../src/main/wallet/railgun-poi-job');
    const selectorJob =
      options.filename === require.resolve('../src/main/wallet/railgun-poi-shield-selector-job');
    if (membership) jobs.membership++;
    if (selectorJob) jobs.selector++;
    const real = originals.start(options);
    real.closed.then(() => {
      if (membership) jobs.membershipExit++;
      if (selectorJob) jobs.selectorExit++;
    });
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
  rpcModule.createPrivateRpc = (handle, role) => {
    const context = getPrivacyContext(handle);
    assert.ok(['transaction-rpc', 'protocol-rpc'].includes(role));
    if (role === 'transaction-rpc')
      assert.equal(context.subject.principal, fixture.transaction.from);
    return {
      signal: context.signal,
      trust: { queried: ['synthetic.invalid'] },
      release() {},
      assertActive: () => getPrivacyContext(handle),
      async request(method, params, validate) {
        rpcMethods[method] = (rpcMethods[method] ?? 0) + 1;
        if (
          ![
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
        getPrivacyContext(handle);
        let value;
        if (method === 'eth_getLogs') {
          assert.equal(role, 'protocol-rpc');
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
          value = {
            number: tag(number),
            hash: blockHash(number),
            parentHash: blockHash(number - 1),
          };
        } else {
          assert.deepEqual(params, [fixture.transaction.hash]);
          value = method === 'eth_getTransactionReceipt' ? fixture.receipt : fixture.transaction;
        }
        assert.ok(validate(value));
        return { result: copy(value) };
      },
    };
  };
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
        return { index: payload.state.count - 1, root: payload.state.root };
      },
      async validateTxidRoot(point) {
        publicMethods.validate++;
        active();
        assert.deepEqual(point, {
          tree: 0,
          index: payload.state.count - 1,
          root: payload.state.root,
        });
        return true;
      },
      async txidPage(after) {
        publicMethods.page++;
        active();
        assert.equal(after, '0x00');
        return { transactions: [payload.row] };
      },
    };
  };
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
    const inner = txAbi
      .decodeFunctionData('transact', fixture.transaction.input)[0][0]
      .toArray(true);
    if (kind === 'unshield') {
      inner[5][0] = hex(BigInt(owner));
      fixture.row.unshield.toAddress = owner;
      fixture.capsule.selection.recipient = fixture.capsule.preparation.recipient = owner;
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Unshield', [
          owner,
          [0, require('../src/main/wallet/railgun-shield-pins.json').wrappedNative, 0],
          998,
          2,
        ])
      );
    } else {
      fixture.row.utxoTreeOut = 0;
      fixture.row.utxoBatchStartPositionOut = 1;
    }
    phase = 'fixture-crypto';
    task = processModule.startRailgunProcess({
      handle: enrollment.getContext('engine'),
      filename: require.resolve('./fixtures/railgun-own-poi-membership-input-job'),
      input: JSON.stringify({
        archive,
        row: fixture.row,
        masterPublicKey: identity.descriptor.masterPublicKey,
        viewingPublicKey: identity.descriptor.viewingPublicKey,
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
            'guards',
            'noteHash',
            'proof',
            'row',
            'state',
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
    inner[3] = payload.row.commitments;
    if (kind === 'transfer')
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Transact', [0, 1, inner[3], inner[4][6]])
      );
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
    fixture.record.intent = railgunTransactJournalIntent(proved);
    assert.equal(
      inspectRailgunTransactReceipt(fixture.record, fixture.transaction, fixture.receipt).status,
      'matched'
    );
    const capsule = fixture.capsule;
    capsule.selection.position = 0;
    capsule.noteHash = payload.noteHash;
    capsule.walletId = enrollment.descriptor.walletId;
    capsule.preparation.transaction = decoded.intent;
    capsule.preparation.expected = decoded.expected;
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
        if (value.status === 'verified') results.add(value);
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
    for (const fault of ['transport-drain', 'utility-drain']) {
      phase = fault;
      mode = fault;
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
        mode: fault,
        refused: true,
        pendingUntilDrain: true,
        phaseHeldUntilExit: fault === 'utility-drain',
        journalUnchanged: true,
      });
      heldTask = undefined;
    }
    await publicAccount.close();
    publicAccount = undefined;
    enrollment.close();
    enrollment = await openRailgunAccountEnrollment({ identity });
    journal = openJournal();
    publicAccount = await openRailgunAccountPublic({ enrollment, archive });
    await success('healthy-reopen-after-refusals');
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
        'routine-journal-refresh',
        'archive-transition',
        'archived',
        'enrollment-store-reopen',
        'status',
        'signature',
        'root',
        'path',
        'index',
        'transport-drain',
        'utility-drain',
        'healthy-reopen-after-refusals',
        'final-journal-drift',
      ]
    );
    assert.deepEqual(Object.values(poiMethods), [14, 13, 12, 11]);
    assert.equal(signature.attempts(), 12);
    assert.equal(transportCreates, 14);
    assert.equal(jobs.membership, 10);
    assert.equal(jobs.selector, 14);
    assert.equal(transportCreates, transportCloses);
    assert.equal(jobs.membership, jobs.membershipExit);
    assert.equal(jobs.selector, jobs.selectorExit);
    assert.deepEqual(hashes(), before);
    const report = {
      fixture: 'synthetic-enrolled-own-poi-membership',
      kind,
      elapsedMs: Math.round(performance.now() - started),
      sourceSha256: before,
      runs,
      recoveryRuns,
      publicPrefixAdvances: advances,
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
      chainAndRootServicesSimulated: true,
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
      overallAuthorityGranted: false,
    };
    assert.doesNotMatch(
      JSON.stringify(report),
      /"(?:blindedCommitment|bindingDigest|inputSha256|leaf|capsule|creator|proof|signature|noteHash)"\s*:/
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
    for (const release of recoveryReleases) release.resolve();
    releaseTransport?.resolve();
    heldTask?.close();
    task?.close();
    for (const value of results) value.close();
    endpointController.abort();
    try {
      const operations = await Promise.allSettled([...pendingOperations]);
      const drained = await Promise.allSettled([
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
    console.error(
      JSON.stringify({
        phase,
        code: /^[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : 'QUALIFICATION_REFUSED',
      })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
