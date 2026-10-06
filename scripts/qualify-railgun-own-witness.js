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
  'scripts/fixtures/railgun-own-witness-job.js',
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
  'src/main/wallet/railgun-kohaku-read-data.js',
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
  'scripts/qualify-railgun-own-witness.js',
];
const hashes = () =>
  Object.fromEntries(
    sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
  );
async function main() {
  const [directory, archive, kind, mode] = process.argv.slice(2);
  assert.ok(process.argv.length <= 6 && (mode === undefined || mode === 'cancellation'));
  const cancellationMode = mode === 'cancellation';
  const cancellationRuns = [];
  const watchdog = setTimeout(() => {
    console.error(JSON.stringify({ phase, code: 'QUALIFICATION_TIMEOUT' }));
    app.exit(1);
  }, 120000);
  watchdog.unref();
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
    rejectRoot = false;
  const serviceMethods = { latest: 0, validate: 0, page: 0 };
  let serviceGate;
  for (const name of ['railgun-account-store', 'railgun-txid-runner', 'railgun-own-witness'])
    assert.equal(require.cache[require.resolve('../src/main/wallet/' + name)], undefined);
  const workerModule = require('../src/main/wallet/railgun-session-worker'),
    originalWorker = workerModule.startRailgunSessionWorker;
  const processModule = require('../src/main/wallet/railgun-process'),
    originalProcess = processModule.startRailgunProcess;
  const resources = { workers: 0, workerExits: 0, jobs: 0, jobExits: 0 };
  workerModule.startRailgunSessionWorker = (...args) => {
    const worker = originalWorker(...args);
    resources.workers++;
    worker.closed.then(() => resources.workerExits++);
    return worker;
  };
  processModule.startRailgunProcess = (...args) => {
    const job = originalProcess(...args);
    resources.jobs++;
    job.closed.then(() => resources.jobExits++);
    return job;
  };
  const methods = {};
  transport.createWalletTorTransport = () => {
    externalAttempts++;
    throw Error('External transport forbidden');
  };
  const rpcModule = require('../src/main/networks/private-rpc'),
    originalRpc = rpcModule.createPrivateRpc;
  rpcModule.createPrivateRpc = (handle, role) => {
    const context = getPrivacyContext(handle);
    assert.ok(['transaction-rpc', 'protocol-rpc'].includes(role));
    if (role === 'transaction-rpc')
      assert.equal(context.subject.principal, fixture.transaction.from);
    const active = () => getPrivacyContext(handle);
    return {
      signal: context.signal,
      trust: { queried: ['synthetic.invalid'] },
      assertActive: active,
      release() {},
      request: async (method, params, validate) => {
        methods[method] = (methods[method] ?? 0) + 1;
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
          result = [];
        } else if (method === 'eth_blockNumber') {
          assert.deepEqual(params, []);
          result = '0x136';
        } else if (method === 'eth_getBlockByNumber') {
          assert.equal(params[1], false);
          const number =
            params[0] === 'finalized'
              ? role === 'protocol-rpc'
                ? 310
                : 300
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
        if (serviceGate?.method === 'latest') {
          serviceGate.entered();
          // Intentionally ignore revocation after admission. The real root
          // reader, not this fixture, must refuse the subsequent validate.
          await serviceGate.promise;
        }
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
        if (serviceGate?.method === 'validate') {
          serviceGate.entered();
          await serviceGate.promise;
        }
        return !rejectRoot;
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
    phase = 'baseline-capture';
    const baseline = await capture();
    assert.equal(baseline.status, 'captured');
    if (kind === 'unshield') fixture.row.unshield.toAddress = owner;
    const { startRailgunProcess } = require('../src/main/wallet/railgun-process');
    phase = 'fixture-projection';
    task = startRailgunProcess({
      handle: enrollment.getContext('engine'),
      filename: require.resolve('./fixtures/railgun-own-witness-job'),
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
    const { openRailgunAccountPublic } = require('../src/main/wallet/railgun-account-public');
    const { openRailgunAccountTxid } = require('../src/main/wallet/railgun-account-txid');
    const { captureRailgunOwnWitness } = require('../src/main/wallet/railgun-own-witness');
    phase = 'public-open';
    publicAccount = await openRailgunAccountPublic({ enrollment, archive, create: true });
    // Empty source history is intentional: this qualifies TXID/storage composition,
    // not public event coverage of the selected transaction.
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
      captureRailgunOwnWitness({
        enrollment,
        archive,
        coordinator: publicAccount.coordinator,
        selector: selected,
        signal: enrollment.signal,
      });
    const checkedCapture = async () => {
      const beforeServices = { ...serviceMethods },
        beforeRpc = JSON.stringify(methods);
      const result = await witnessCapture();
      assert.equal(result.status, 'captured');
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
      assert.equal(serviceMethods.latest - beforeServices.latest, 2);
      assert.equal(serviceMethods.validate - beforeServices.validate, 2);
      assert.equal(serviceMethods.page, beforeServices.page);
      assert.equal(JSON.stringify(methods), beforeRpc);
      return result;
    };
    if (cancellationMode) {
      const { claimRailgunAccountPhase } = require('../src/main/wallet/railgun-account-phase');
      const options = () => ({
        enrollment,
        archive,
        coordinator: publicAccount.coordinator,
        checkpointOnly: true,
      });
      const checkpoint = async () => {
        txid = await openRailgunAccountTxid(options());
        const current = await txid.inspect();
        assert.equal(current.pending, null);
        const saved = JSON.parse(JSON.stringify(current.checkpoint));
        await txid.close();
        txid = null;
        return saved;
      };
      const beforeBaseline = { ...resources };
      const saved = await checkpoint();
      assert.equal(resources.workers - beforeBaseline.workers, 1);
      assert.equal(resources.workerExits - beforeBaseline.workerExits, 1);
      assert.ok(resources.jobs - beforeBaseline.jobs >= 1);
      assert.equal(
        resources.jobExits - beforeBaseline.jobExits,
        resources.jobs - beforeBaseline.jobs
      );
      const busy = () =>
        assert.throws(
          () => {
            const unexpected = claimRailgunAccountPhase(enrollment, 'recovery');
            unexpected.release();
          },
          { code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }
        );
      const healthy = async () => {
        assert.equal(enrollment.signal.aborted, false);
        assert.equal(publicAccount.coordinator.signal.aborted, false);
        assert.deepEqual(await checkpoint(), saved);
        assert.equal((await publicAccount.coordinator.withPublicSnapshot(() => true)).value, true);
      };
      phase = 'cancel-before-admission';
      const revoked = new AbortController();
      revoked.abort();
      const beforeInvalid = { ...resources },
        beforeInvalidServices = { ...serviceMethods };
      for (const signal of [null, false, {}, revoked.signal])
        await assert.rejects(openRailgunAccountTxid({ ...options(), signal }), {
          code: 'RAILGUN_ACCOUNT_TXID_REFUSED',
        });
      assert.deepEqual(resources, beforeInvalid);
      assert.deepEqual(serviceMethods, beforeInvalidServices);
      cancellationRuns.push({
        mode: phase,
        refusals: 4,
        newWorkers: 0,
        newJobs: 0,
        serviceCalls: 0,
      });
      const exercise = async (method, caller) => {
        phase = `cancel-${caller}-pending-${method}`;
        const controller = new AbortController();
        let release, entered;
        const admitted = new Promise((resolve) => {
          entered = resolve;
        });
        const held = new Promise((resolve) => {
          release = resolve;
        });
        serviceGate = { method, promise: held, entered };
        const beforeWork = { ...resources },
          beforeServices = { ...serviceMethods };
        let settled = false;
        const pending = (
          caller === 'account'
            ? openRailgunAccountTxid({ ...options(), signal: controller.signal })
            : captureRailgunOwnWitness({
                enrollment,
                archive,
                coordinator: publicAccount.coordinator,
                selector,
                signal: controller.signal,
              })
        ).then(
          (value) => {
            settled = true;
            return { value };
          },
          () => {
            settled = true;
            return { refused: true };
          }
        );
        try {
          await admitted;
          busy();
          controller.abort();
          await new Promise((resolve) => setImmediate(resolve));
          assert.equal(settled, false);
          busy();
          assert.equal(serviceMethods.latest - beforeServices.latest, 1);
          assert.equal(
            serviceMethods.validate - beforeServices.validate,
            Number(method === 'validate')
          );
          release();
          const result = await pending;
          if (caller === 'account') assert.deepEqual(result, { refused: true });
          else assert.equal(result.value?.status, 'refused');
          assert.equal(serviceMethods.latest - beforeServices.latest, 1);
          assert.equal(
            serviceMethods.validate - beforeServices.validate,
            Number(method === 'validate')
          );
          assert.equal(serviceMethods.page, beforeServices.page);
          const workers = resources.workers - beforeWork.workers;
          const jobs = resources.jobs - beforeWork.jobs;
          assert.equal(workers, 1);
          assert.equal(resources.workerExits - beforeWork.workerExits, workers);
          assert.equal(resources.jobExits - beforeWork.jobExits, jobs);
          if (caller === 'account') assert.equal(jobs, 0);
          serviceGate = undefined;
          const available = claimRailgunAccountPhase(enrollment, 'recovery');
          available.release();
          await healthy();
          cancellationRuns.push({
            mode: phase,
            latest: 1,
            validate: Number(method === 'validate'),
            pages: 0,
            workers,
            workerExits: workers,
            jobs,
            jobExits: jobs,
            heldPhaseUntilBorrowedWorkSettled: true,
            authenticatedCheckpointUnchanged: true,
            sharedCoordinatorHealthy: true,
            socketsObservedClosed: false,
          });
        } finally {
          release();
          await pending;
          serviceGate = undefined;
        }
      };
      await exercise('latest', 'account');
      await exercise('validate', 'account');
      await exercise('latest', 'witness');
      phase = 'cancel-returned-account';
      const controller = new AbortController();
      const beforeReturned = { ...resources };
      txid = await openRailgunAccountTxid({ ...options(), signal: controller.signal });
      controller.abort();
      busy();
      assert.equal(txid.signal.aborted, true);
      await assert.rejects(txid.inspect());
      await txid.close();
      await txid.close();
      txid = null;
      assert.equal(resources.workers - beforeReturned.workers, 1);
      assert.equal(resources.workerExits - beforeReturned.workerExits, 1);
      const available = claimRailgunAccountPhase(enrollment, 'recovery');
      available.release();
      await healthy();
      cancellationRuns.push({
        mode: phase,
        workerExits: 1,
        lifetimeRevoked: true,
        repeatedCloseSafe: true,
        authenticatedCheckpointUnchanged: true,
        sharedCoordinatorHealthy: true,
      });
      assert.equal(cancellationRuns.length, 5);
    }
    phase = 'active-witness';
    const beforeWitness = { ...resources };
    const activeCapture = await checkedCapture();
    assert.ok(resources.jobs - beforeWitness.jobs >= 1);
    assert.equal(resources.jobExits - beforeWitness.jobExits, resources.jobs - beforeWitness.jobs);
    runs.push({
      mode: phase,
      publicLatestRequests: 2,
      publicTipRootValidations: 2,
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
    assert.deepEqual(reopened, archived);
    runs.push({ mode: 'enrollment-and-mirror-reopen', identicalCapture: true });
    const refusedCapture = async (selected, expectedStage, rootReads = 0) => {
      const beforeServices = { ...serviceMethods },
        beforeRpc = JSON.stringify(methods);
      assert.deepEqual(await witnessCapture(selected), { status: 'refused', stage: expectedStage });
      assert.equal(serviceMethods.latest - beforeServices.latest, rootReads);
      assert.equal(serviceMethods.validate - beforeServices.validate, rootReads);
      assert.equal(serviceMethods.page, beforeServices.page);
      assert.equal(JSON.stringify(methods), beforeRpc);
    };
    phase = 'wrong-selector';
    await refusedCapture({ ...selector, position: selector.position + 1 }, 'capture:selection');
    await checkedCapture();
    runs.push({ mode: phase, refused: true, followingCaptureSucceeded: true });
    phase = 'root-refusal';
    rejectRoot = true;
    await refusedCapture(selector, 'txid', 1);
    rejectRoot = false;
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
          cancellationMode,
          cancellationRuns,
          resources,
          rpcMethods: methods,
          externalAttempts,
          unexpectedRpc,
          genuineEnrollmentAndEncryptedStores: true,
          genuineResolutionPermit: true,
          chainObservationsSimulated: true,
          structuralProofAndSignature: true,
          serviceMethods,
          transactionSourceCoverageVerified: false,
          captureRpcRequests: 0,
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
    task?.close();
    if (task) await task.closed;
    if (txid) await txid.close();
    if (publicAccount) await publicAccount.close();
    recovery?.close();
    journalScope?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    serviceModule.createRailgunPublicServices = originalServices;
    workerModule.startRailgunSessionWorker = originalWorker;
    processModule.startRailgunProcess = originalProcess;
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
