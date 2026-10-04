/** Actual encrypted account/journal capture with simulated chain observations.
 * Transaction proof/signature fixtures are structural, not valid spend crypto.
 * RPC destination identity is fixture-simulated; this does not qualify real
 * retained-destination binding or the private-RPC chain-ID handshake.
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
  'scripts/qualify-railgun-poi-preflight.js',
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
  const rpcModule = require('../src/main/networks/private-rpc'),
    originalRpc = rpcModule.createPrivateRpc,
    originalDestinationGet = rpcModule.getPrivateRpcDestination,
    originalDestinationAssert = rpcModule.assertPrivateRpcDestination;
  // Only this fixture's exact clients/handles/tokens qualify here. The real
  // detail accessor is untouched and refuses these synthetic observations.
  const rpcDestinations = new WeakMap();
  const fixtureDestination = (client, handle) => {
    const entry = rpcDestinations.get(client);
    assert.ok(entry && entry.handle === handle);
    assert.equal(getPrivacyContext(handle), entry.context);
    assert.equal(client.signal, entry.context.signal);
    assert.ok(client.signal instanceof AbortSignal);
    assert.equal(client.signal.aborted, false);
    return entry.observation;
  };
  rpcModule.getPrivateRpcDestination = fixtureDestination;
  rpcModule.assertPrivateRpcDestination = (client, handle, observation) => {
    const actual = fixtureDestination(client, handle);
    assert.equal(observation, actual);
    return actual;
  };
  rpcModule.createPrivateRpc = (handle, role) => {
    const context = getPrivacyContext(handle);
    assert.ok(['transaction-rpc', 'protocol-rpc'].includes(role));
    if (role === 'transaction-rpc')
      assert.equal(context.subject.principal, fixture.transaction.from);
    const active = () => getPrivacyContext(handle);
    const client = {
      signal: context.signal,
      trust: { queried: ['synthetic.invalid'] },
      assertActive: active,
      release() {},
      request: async (method, params, validate) => {
        methods[method] = (methods[method] ?? 0) + 1;
        roleMethods[role][method] = (roleMethods[role][method] ?? 0) + 1;
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
        active();
        let result;
        if (method === 'eth_getLogs') {
          assert.equal(role, 'protocol-rpc');
          const filter = params[0];
          result = history.filter(
            (log) =>
              BigInt(log.blockNumber) >= BigInt(filter.fromBlock) &&
              BigInt(log.blockNumber) <= BigInt(filter.toBlock)
          );
        } else if (method === 'eth_blockNumber') {
          assert.deepEqual(params, []);
          result = '0x136';
        } else if (method === 'eth_getBlockByNumber') {
          assert.equal(params[1], false);
          const number =
            params[0] === 'finalized'
              ? role === 'transaction-rpc'
                ? (finalizedOverride ?? 310)
                : 310
              : Number(BigInt(params[0]));
          assert.ok(Number.isSafeInteger(number) && number >= 0 && number <= 310);
          result = {
            number: '0x' + number.toString(16),
            hash: blockHash(number),
            parentHash: number === 0 ? hex(0) : blockHash(number - 1),
          };
        } else {
          assert.deepEqual(params, [fixture.transaction.hash]);
          result = method === 'eth_getTransactionReceipt' ? fixture.receipt : fixture.transaction;
        }
        assert.ok(validate(result));
        return { result: JSON.parse(JSON.stringify(result)) };
      },
    };
    rpcDestinations.set(client, { handle, context, observation: Object.freeze({}) });
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
        return { transactions: [payload.row] };
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
  let identity, enrollment, journalScope, recovery, restoreClock, publicAccount, txid, task;
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
    if (kind === 'unshield') fixture.row.unshield.toAddress = owner;
    else {
      fixture.row.utxoTreeOut = 0;
      fixture.row.utxoBatchStartPositionOut = 1;
    }
    const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
    phase = 'fixture-projection';
    task = startRailgunProcess({
      handle: enrollment.getContext('engine'),
      filename: require.resolve('./fixtures/railgun-own-preflight-job'),
      input: JSON.stringify({ archive, row: fixture.row }),
      lifetimeMs: 60000,
      broker: {
        signal: enrollment.signal,
        async dispatch(wire) {
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 65536);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          assert.equal(payload, undefined);
          assert.deepEqual(Object.keys(message.value).sort(), ['guards', 'row', 'state']);
          assert.equal(message.value.guards.attempts, 0);
          payload = message.value;
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    await task.ready;
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    task = null;
    fixture.row = payload.row;
    inner[3] = payload.row.commitments;
    if (kind === 'transfer')
      Object.assign(
        fixture.receipt.logs[1],
        eventAbi.encodeEventLog('Transact', [0, 1, inner[3], inner[4][6]])
      );
    const { SHIELD_EVENT } = require('../src/main/wallet/railgun-shield-receipt');
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
    capsule.selection.position = 0; // The historical Shield creator is position zero.
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
    finalizedOverride = 300;
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
    const { preflightRailgunOwnPoi } = require('../src/main/wallet/railgun-own-witness');
    phase = 'public-open';
    publicAccount = await openRailgunAccountPublic({ enrollment, archive, create: true });
    // Synthetic source prefix contains the earlier Shield and exact selected receipt logs.
    await publicAccount.advance({ to: 300, anchor: { number: 310, hash: blockHash(310) } });
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
    const witnessCapture = (selected = selector) =>
      preflightRailgunOwnPoi({
        enrollment,
        archive,
        coordinator: publicAccount.coordinator,
        selector: selected,
        signal: enrollment.signal,
      });
    const checkedCapture = async () => {
      const beforeServices = { ...serviceMethods },
        beforeRpc = { ...roleMethods['transaction-rpc'] };
      const beforeJournal = await journal.readSnapshot();
      const result = await witnessCapture();
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
      assert.equal(result.observations.source.creator.sourceAuthenticated, true);
      assert.equal(result.creatorClassification.type, 'Shield');
      assert.equal(result.creatorClassification.legacy, true);
      assert.equal(result.creatorClassification.blockNumber, 290);
      assert.equal(result.disclosureEnabled, false);
      assert.deepEqual(result.poiPreparation, {
        creator: result.observations.source.creator.creator,
        ownEvidence: {
          capsule: result.capture.capsule,
          record: result.capture.record,
          transaction: result.observations.chain.transaction,
          receipt: result.observations.chain.receipt,
          row: result.witness.row,
        },
        state: result.state,
        witness: result.witness,
      });
      assert.equal(result.poiPreparation.creator.position, 0);
      assert.equal(result.poiPreparation.creator.preimage.npk, hex(700));
      assert.equal(result.poiPreparation.creator.preimage.value, '1000');
      assert.equal(result.observations.source.own.logs.length, 2);
      assert.equal(result.observations.verification.pathVerified, true);
      assert.equal(result.observations.verification.utilityExitObserved, true);
      assert.equal(
        result.observations.verification.unshieldCommitmentVerified,
        kind === 'unshield'
      );
      assert.equal(result.observations.root.accepted, true);
      assert.equal(result.observations.archiveAnchorChecked, true);
      assert.equal(serviceMethods.latest - beforeServices.latest, 3);
      assert.equal(serviceMethods.validate - beforeServices.validate, 3);
      assert.equal(serviceMethods.page, beforeServices.page);
      assert.equal(
        roleMethods['transaction-rpc'].eth_getTransactionByHash -
          beforeRpc.eth_getTransactionByHash,
        1
      );
      assert.equal(
        roleMethods['transaction-rpc'].eth_getTransactionReceipt -
          beforeRpc.eth_getTransactionReceipt,
        1
      );
      assert.deepEqual(await journal.readSnapshot(), beforeJournal);
      return result;
    };
    phase = 'active-witness';
    const activeCapture = await checkedCapture();
    runs.push({
      mode: phase,
      publicLatestRequests: 3,
      publicTipRootValidations: 3,
      recaptured: true,
      authority: false,
    });
    phase = 'archive';
    const ready = (await journal.list())[0];
    await journal.archiveResolved(
      [{ hash: ready.hash, revision: ready.revision }],
      [{ blockNumber: 310, blockHash: blockHash(310) }]
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
    phase = 'root-refusal';
    rejectRoot = true;
    await refusedCapture(selector, 'txid', 1, { headers: 12, head: 2 });
    rejectRoot = false;
    await checkedCapture();
    runs.push({ mode: phase, refused: true, followingCaptureSucceeded: true });
    phase = 'final-root-refusal';
    rejectValidation = serviceMethods.validate + 3;
    await refusedCapture(selector, 'root', 3, { headers: 12, head: 2 });
    rejectValidation = null;
    await checkedCapture();
    runs.push({
      mode: phase,
      refused: true,
      sourceAndVerifierCompleted: true,
      followingCaptureSucceeded: true,
    });
    phase = 'archive-finality-lag';
    finalizedOverride = 300;
    await refusedCapture(selector, 'receipt:archive-anchor', 0, { headers: 6, head: 1 });
    finalizedOverride = null;
    await checkedCapture();
    runs.push({ mode: phase, refused: true, followingCaptureSucceeded: true });
    phase = 'unresolved-sibling';
    await journal.begin(hex(101), 4);
    await refusedCapture(selector, 'capture:journal');
    runs.push({ mode: phase, refused: true });
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
          rpcDestinationBindingSimulated: true,
          rpcDestinationBindingQualified: false,
          rpcChainIdHandshakeExercised: false,
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
      identity?.close();
      vault.lockVault();
    } finally {
      serviceModule.createRailgunPublicServices = originalServices;
      rpcModule.createPrivateRpc = originalRpc;
      rpcModule.getPrivateRpcDestination = originalDestinationGet;
      rpcModule.assertPrivateRpcDestination = originalDestinationAssert;
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
    console.error(JSON.stringify({ phase, code: error?.code }));
    releaseProfileLock(lock);
    app.exit(1);
  }
);
