/** Durable wallet checkpoint and interrupted recovery over synthetic public history. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const { getPrivacyStoragePath } = require('../src/main/wallet/privacy-storage');
let qualificationLock;
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [sourceFilename, directory, accountArchive, composition] = process.argv.slice(2);
  assert.ok(composition === undefined || (composition === 'enrolled' && accountArchive));
  assert.ok(accountArchive === undefined || path.isAbsolute(accountArchive));
  assert.ok(
    path.isAbsolute(sourceFilename) && path.isAbsolute(directory) && !fs.existsSync(directory)
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  if (accountArchive) {
    const profile = require('../src/main/profile-resolver').initializeProfile(app, {
      env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
    });
    qualificationLock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  } else app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  let accountIdentity, accountParent, accountProfileId, enrollment;
  const vault = accountArchive ? require('../src/main/identity/vault') : null;
  let lockOnViewingKey = false,
    privateViewingKeys = 0,
    privateReceiveKeys = 0,
    corruptPrivateReceiveKey = false,
    failReadOnlyRestore = false,
    failWalletBatch = false,
    failPublicCommit = false,
    failPublication = false,
    cancelledViewingKey,
    cancelledViewingClosed,
    cancelledViewingMessages = 0,
    cancelledViewingProcessClosed = false,
    cancelledViewingProcess = null;
  const walletRestores = [],
    applications = [];
  if (composition) {
    const catalogModule = require('../src/main/wallet/railgun-wallet-catalog'),
      original = catalogModule.createRailgunWalletCatalog;
    catalogModule.createRailgunWalletCatalog = async (options) => {
      const catalog = await original(options);
      return Object.freeze({
        ...catalog,
        async publish(...args) {
          if (failPublication) {
            failPublication = false;
            throw Error('Injected publication interruption');
          }
          return catalog.publish(...args);
        },
      });
    };
  }
  if (accountArchive) {
    const runtime = require('../src/main/wallet/railgun-process'),
      originalStart = runtime.startRailgunProcess;
    runtime.startRailgunProcess = (options) => {
      if (options.filename === require.resolve('../src/main/wallet/railgun-wallet-job'))
        walletRestores.push(JSON.parse(options.input).restore);
      if (!options.broker) return originalStart(options);
      const original = options.broker;
      let cancelledThisTask = false,
        messages = 0;
      const task = originalStart({
        ...options,
        broker: {
          ...original,
          async dispatch(wire) {
            messages++;
            const message = JSON.parse(wire);
            if (message.method === 'key' && message.purpose === 'private-prepare')
              privateViewingKeys++;
            if (message.method === 'key' && message.purpose === 'private-receive')
              privateReceiveKeys++;
            if (
              failReadOnlyRestore &&
              options.filename === require.resolve('../src/main/wallet/railgun-wallet-job') &&
              JSON.parse(options.input).restore === true &&
              message.method === 'key'
            ) {
              failReadOnlyRestore = false;
              throw Error('Injected read-only restore interruption');
            }
            const reply = await original.dispatch(wire);
            if (
              corruptPrivateReceiveKey &&
              message.method === 'key' &&
              message.purpose === 'private-receive'
            ) {
              corruptPrivateReceiveKey = false;
              reply[0] ^= 1;
            }
            if (
              lockOnViewingKey &&
              message.method === 'key' &&
              message.purpose === 'wallet-viewing'
            ) {
              lockOnViewingKey = false;
              cancelledViewingKey = reply;
              cancelledThisTask = true;
              cancelledViewingClosed = task.closed;
              vault.lockVault();
            }
            if (
              failPublicCommit &&
              options.filename === require.resolve('../src/main/wallet/railgun-public-job') &&
              message.method === 'txCommit'
            ) {
              failPublicCommit = false;
              throw Error('Injected acknowledged public commit interruption');
            }
            if (
              failWalletBatch &&
              message.channel === 'wallet' &&
              JSON.parse(message.wire).method === 'batch'
            ) {
              failWalletBatch = false;
              throw Error('Injected wallet write interruption');
            }
            return reply;
          },
        },
      });
      task.closed.then((result) => {
        if (cancelledThisTask) {
          cancelledViewingMessages = messages;
          cancelledViewingProcess = result;
          cancelledViewingProcessClosed = [
            'PRIVACY_CONTEXT_REVOKED',
            'RAILGUN_SESSION_REVOKED',
          ].includes(result.code);
        }
      });
      return task;
    };
  }
  if (composition) {
    const publicModule = require('../src/main/wallet/railgun-public-run'),
      originalJobs = publicModule.createRailgunPublicJobs;
    publicModule.createRailgunPublicJobs = (options) => {
      const jobs = originalJobs(options);
      return Object.freeze({
        ...jobs,
        async apply(input, capability) {
          try {
            const result = await jobs.apply(input, capability);
            applications.push({ to: input.plan.to.number, ...result });
            return result;
          } catch (error) {
            applications.push({
              to: input.plan.to.number,
              interrupted: true,
              closed: error.closed,
            });
            throw error;
          }
        },
      });
    };
  }
  if (accountArchive) {
    const vaultDirectory = path.join(directory, 'profile', 'identity');
    await vault.importVault(
      vaultDirectory,
      'public-fixture-password-not-a-user-credential',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    accountIdentity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive: accountArchive,
    });
    if (composition)
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity: accountIdentity, create: true }
        );
    accountParent = require('../src/main/wallet/privacy-session').openPrivacySession();
  }
  const sourceBytes = fs.readFileSync(sourceFilename),
    { logs, foreignTransfers } = JSON.parse(sourceBytes);
  const hash = (n) => '0x' + n.toString(16).padStart(64, '0');
  const capture = {
    logSetSha256: sha(sourceBytes),
    report: {
      proxy: '0xecfcf3b4ec647c4ca6d49108b311b7a7c9543fea',
      anchor: { number: 100, hash: hash(101) },
    },
  };
  const headers = new Map(
    Array.from({ length: 101 }, (_, n) => [
      n,
      { number: n, hash: hash(n + 1), parentHash: hash(n) },
    ])
  );
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const privateRpc = require('../src/main/networks/private-rpc');
  let requests = 0,
    provider = 'archived-source-a.invalid';
  privateRpc.createPrivateRpc = (handle, _role, { signal }) => {
    const lifetime = AbortSignal.any([getPrivacyContext(handle).signal, signal]);
    const active = () => {
      getPrivacyContext(handle);
      assert.equal(lifetime.aborted, false);
    };
    return {
      signal: lifetime,
      trust: { queried: [provider] },
      release: () => {},
      assertActive: active,
      request: async (method, params, validate) => {
        if (process.env.RAILGUN_REPLAY_DIAGNOSTIC)
          console.log('archived-rpc', method, JSON.stringify(params));
        active();
        requests++;
        let result;
        if (method === 'eth_getLogs') {
          const [filter] = params;
          assert.equal(filter.address, capture.report.proxy);
          result = logs
            .filter(
              (log) =>
                log.blockNumber >= Number(BigInt(filter.fromBlock)) &&
                log.blockNumber <= Number(BigInt(filter.toBlock))
            )
            .map((log) => ({
              ...log,
              removed: false,
              blockNumber: '0x' + log.blockNumber.toString(16),
              transactionIndex: '0x' + log.transactionIndex.toString(16),
              logIndex: '0x' + log.logIndex.toString(16),
            }));
        } else {
          assert.equal(method, 'eth_getBlockByNumber');
          assert.equal(params[1], false);
          const number =
            params[0] === 'finalized' ? capture.report.anchor.number : Number(BigInt(params[0]));
          const found = headers.get(number);
          assert.ok(found, 'Missing archived header ' + number);
          result = { ...found, number: '0x' + number.toString(16) };
        }
        assert.equal(validate(result), true);
        return { result };
      },
    };
  };
  const { createRailgunSourceLedger } = require('../src/main/wallet/railgun-source-ledger');
  const { createRailgunScanSource } = require('../src/main/wallet/railgun-scan-source');
  const { startRailgunSessionWorker } = require('../src/main/wallet/railgun-session-worker');
  const { createRailgunScanCoordinator } = require('../src/main/wallet/railgun-scan-coordinator');
  const qualifiedThrough = 0;
  let jobs;
  const subject = {
    kind: 'private-account',
    principal: accountArchive ? 'railgun:0' : 'fixture',
    chainId: 11155111,
    protocol: 'railgun',
    deployment: accountArchive ? 'sepolia' : 'archived-sepolia',
  };
  if (accountArchive)
    accountProfileId = getPrivacyContext(
      accountParent.getContext({ ...subject, role: 'engine' })
    ).profileId;
  let scope,
    ledger,
    source,
    session,
    coordinator,
    publicAccount,
    crashPhase = null;
  const advancePublic = (range) =>
    publicAccount ? publicAccount.advance(range) : coordinator.advance(range);
  async function open(create, mode) {
    scope = createPrivacyScope({
      profileId: accountProfileId ?? 'coordinated-public-history',
      signal: accountParent?.signal ?? new AbortController().signal,
    });
    const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }),
      engineHandle = scope.getContext({ ...subject, role: 'engine' });
    if (enrollment) {
      publicAccount =
        await require('../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
          enrollment,
          archive: accountArchive,
          create,
          ...(mode ? { mode } : {}),
        });
      coordinator = publicAccount.coordinator;
    } else {
      jobs = require('./railgun-coordinated-electron').createJobs(engineHandle, qualifiedThrough);
      ledger = await createRailgunSourceLedger({
        handle: rpcHandle,
        filename: path.join(directory, 'source.sqlite'),
        key: Buffer.alloc(32, 61),
        binding: 'a'.repeat(64),
        create,
      });
      source = createRailgunScanSource({
        handle: rpcHandle,
        ledger,
        projectRange: async (...args) => {
          try {
            return await jobs.project(...args);
          } catch (error) {
            console.error('public planner diagnostic', error.stack);
            throw error;
          }
        },
      });
      session = startRailgunSessionWorker({
        handle: engineHandle,
        storage: {
          format: 'paged-v2',
          filename: path.join(directory, 'engine.sqlite'),
          key: Buffer.alloc(32, 62),
          binding: 'b'.repeat(64),
          create,
        },
        createProvider: ({ signal }) => ({
          signal,
          request: async () => {
            throw Error('Engine RPC forbidden');
          },
        }),
        onClose: () => {},
      });
      await session.ready;
      coordinator = await createRailgunScanCoordinator({
        handle: engineHandle,
        storeSession: session,
        source,
        journalStorage: { directory, key: Buffer.alloc(32, 63), binding: 'c'.repeat(64) },
        applyRange: async (input, capability) => {
          try {
            applications.push({
              to: input.plan.to.number,
              ...(await jobs.apply({ ...input, crashPhase }, capability)),
            });
          } catch (error) {
            console.error('public apply diagnostic', error.stack);
            applications.push({
              to: input.plan.to.number,
              interrupted: true,
              phase: error.phase,
              exitSignal: error.exitSignal,
            });
            throw error;
          }
        },
      });
    }
    catalog =
      enrollment?.catalog ??
      (await createRailgunWalletCatalog({
        handle: scope.getContext({
          ...subject,
          role: 'storage',
          operation: 'railgun-wallet-catalog-v1:' + walletId,
        }),
        directory,
        key: Buffer.alloc(32, 66),
        binding: 'f'.repeat(64),
        walletId,
        create,
      }));
    if (enrollment) return;
    if (create) generation = await catalog.begin(policy);
    else if ((await catalog.inspect()).pending) generation = await catalog.resume();
    else generation = null;
    walletDirectory = generation?.directory ?? catalog.activeFor(policy).directory;
  }
  async function close() {
    await publicAccount?.close();
    if (!enrollment) catalog?.close();
    coordinator?.close();
    source?.close();
    ledger?.close();
    session?.close();
    scope?.close();
    await Promise.all([ledger?.closed, session?.closed]);
  }
  const sources = [
    'src/main/wallet/railgun-account-public.js',
    'src/main/wallet/railgun-public-catalog.js',
    'src/main/wallet/railgun-store-owners.js',
    'src/main/wallet/railgun-public-job.js',
    'src/main/wallet/railgun-public-run.js',
    'src/main/wallet/railgun-public-policy.js',
    'scripts/qualify-railgun-wallet-journal.js',
    'src/main/wallet/railgun-account-wallet.js',
    'src/main/wallet/railgun-wallet-policy.js',
    'src/main/wallet/railgun-account-store.js',
    'src/main/wallet/railgun-account-enrollment.js',
    'src/main/wallet/railgun-account-phase.js',
    'src/main/wallet/railgun-private-reservations.js',
    'src/main/wallet/railgun-private-witness.js',
    'src/main/wallet/railgun-private-prepare-job.js',
    'src/main/wallet/railgun-private-preparation.js',
    'src/main/wallet/railgun-private-intent.js',
    'src/main/wallet/railgun-private-policy.js',
    'src/main/wallet/railgun-private-receive.js',
    'src/main/wallet/railgun-private-receive-job.js',
    'src/main/wallet/railgun-private-results.js',
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
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((file) => [file, sha(fs.readFileSync(path.join(__dirname, '..', file)))])
    );
  const sourceSha256 = hashes(),
    runs = [];
  const walletId =
    accountIdentity?.descriptor.walletId ??
    sha(Buffer.from(require('./fixtures/railgun-wallet-snapshot-job').shared, 'hex'));
  if (accountIdentity) {
    const vector = JSON.parse(sourceBytes);
    assert.equal(vector.publicVaultVector, true);
    assert.equal(vector.walletId, walletId);
    assert.equal(vector.instanceId, accountIdentity.descriptor.instanceId);
  }
  const { createRailgunWalletRunner } = require('../src/main/wallet/railgun-wallet-runner');
  const {
    createRailgunWalletCoverageStore,
  } = require('../src/main/wallet/railgun-wallet-coverage-store');
  const { createRailgunWalletJournal } = require('../src/main/wallet/railgun-wallet-journal');
  let policy = enrollment
    ? require('../src/main/wallet/railgun-wallet-policy').getRailgunWalletPolicy(accountArchive)
    : sha('wallet-policy-fixture-v1\0' + JSON.stringify(sourceSha256));
  const runner = accountIdentity
    ? require('../src/main/wallet/railgun-wallet-runner').createRailgunAccountRunner({
        identity: accountIdentity,
        archive: accountArchive,
        policy,
      })
    : createRailgunWalletRunner({
        runJob: require('./railgun-wallet-snapshot-electron').runWalletSnapshot,
        inventory: require('./fixtures/railgun-engine/runtime-integrity.json').inventory.sha256,
        policy,
      });
  const { createRailgunWalletCatalog } = require('../src/main/wallet/railgun-wallet-catalog');
  let walletSession, walletJournal, catalog, generation, walletDirectory;
  const retainedDirectories = [];
  const legacyHashes = new Map();
  const reservationInput = Object.freeze({
    tree: 0,
    position: 1,
    nullifier: '0x' + '1'.repeat(64),
    noteHash: '0x' + '2'.repeat(64),
    kind: 'railgun-private-transfer',
    intentDigest: '0x' + '3'.repeat(64),
    checkpointHash: '4'.repeat(64),
    poiDigest: '5'.repeat(64),
  });
  let initialReservationStore, initialReservationReceipt;
  try {
    if (enrollment) {
      const { openRailgunAccountStore } = require('../src/main/wallet/railgun-account-store');
      const sourceStore = await openRailgunAccountStore({
        enrollment,
        kind: 'source',
        create: true,
      });
      let legacyPublic, legacySource, legacyCoordinator;
      try {
        legacyPublic = await openRailgunAccountStore({ enrollment, kind: 'public', create: true });
        const engineHandle = enrollment.getContext('engine');
        const legacyJobs = require('../src/main/wallet/railgun-public-run').createRailgunPublicJobs(
          {
            handle: engineHandle,
            archive: accountArchive,
          }
        );
        legacySource = createRailgunScanSource({
          handle: enrollment.getContext('protocol-rpc'),
          ledger: sourceStore.ledger,
          projectRange: legacyJobs.project,
        });
        legacyCoordinator = await enrollment.withPublicKeys((keys) =>
          createRailgunScanCoordinator({
            handle: engineHandle,
            storeSession: legacyPublic.session,
            source: legacySource,
            journalStorage: {
              directory: enrollment.directory,
              key: keys['scan-journal'],
              binding: enrollment.binding,
              policy: 'e'.repeat(64),
              create: true,
              profileGuard: enrollment.profileGuard,
            },
            applyRange: legacyJobs.apply,
          })
        );
        await legacyCoordinator.advance({ to: 10, anchor: capture.report.anchor });
      } finally {
        legacyCoordinator?.close();
        legacySource?.close();
        sourceStore.ledger.close();
        legacyPublic?.session.close();
        await Promise.all([sourceStore.session.closed, legacyPublic?.session.closed]);
      }
      for (const name of fs
        .readdirSync(enrollment.directory)
        .filter((name) => name.endsWith('.sqlite') || name.endsWith('.json')))
        legacyHashes.set(name, sha(fs.readFileSync(path.join(enrollment.directory, name))));
      const marker = path.join(directory, 'profile', 'wallet-privacy-inventory.json');
      const markerBefore = fs.readFileSync(marker);
      const height = await enrollment.withPublicKeys((keys) =>
        require('../src/main/wallet/railgun-scan-journal').readRailgunScanUpgradeHeight({
          handle: enrollment.getContext('storage', 'railgun-scan-v1'),
          directory: enrollment.directory,
          key: keys['scan-journal'],
          binding: enrollment.binding,
          profileGuard: enrollment.profileGuard,
        })
      );
      assert.equal(height, 10);
      assert.deepEqual(fs.readFileSync(marker), markerBefore);
    }
    await open(true);
    if (enrollment) {
      initialReservationStore = await enrollment.openReservations();
      initialReservationReceipt = await initialReservationStore.reserve(reservationInput);
      assert.deepEqual(
        (await initialReservationStore.assertReceipt(initialReservationReceipt)).facts,
        reservationInput
      );
    }
    let previousEvidence;
    for (const stage of [10, 20, 30]) {
      if (enrollment && stage === 30) {
        failPublicCommit = true;
        await assert.rejects(advancePublic({ to: stage, anchor: capture.report.anchor }));
        assert.equal(failPublicCommit, false);
        assert.equal(applications.at(-1).interrupted, true);
        await close();
        enrollment.close();
        enrollment =
          await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
            { identity: accountIdentity }
          );
        await assert.rejects(initialReservationStore.assertReceipt(initialReservationReceipt));
        const reservations = await enrollment.openReservations();
        assert.deepEqual(await reservations.inspect(), {
          held: 1,
          signing: 0,
          abandoned: 0,
          legacy: 0,
        });
        await assert.rejects(reservations.reserve(reservationInput), {
          code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
        });
        await open(false);
        const recovered = await coordinator.recover();
        assert.equal(recovered.to.number, stage);
        runs.push({
          attempt: 'interrupted-public-apply',
          acknowledgedCommitInterrupted: true,
          recoveredThrough: recovered.to.number,
        });
      } else if (stage !== 20 || accountIdentity)
        await advancePublic({ to: stage, anchor: capture.report.anchor });
      if (enrollment) {
        policy = require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy(
          { archive: accountArchive, enrollment, coordinator }
        );
        if (stage === 10) await catalog.begin(policy);
      }
      if (previousEvidence) assert.throws(() => coordinator.assertSnapshot(previousEvidence));
      for (const attempt of accountIdentity
        ? stage === 30
          ? ['scan', 'restore', 'rebuild', 'rebuild-restore']
          : ['scan', 'restore']
        : stage === 10
          ? [
              'interrupt',
              'incomplete-restore',
              'coverage-crash',
              'restore-pending',
              'restore',
              'stale-public',
            ]
          : stage === 20
            ? ['scan', 'host-first', 'restore']
            : ['scan', 'restore', 'rebuild', 'rebuild-restore']) {
        const restore = [
          'restore',
          'incomplete-restore',
          'restore-pending',
          'host-first',
          'rebuild-restore',
        ].includes(attempt);
        if (enrollment) {
          if (attempt === 'rebuild') retainedDirectories.push(walletDirectory);
          const mode = restore
            ? 'active'
            : attempt === 'rebuild'
              ? 'new'
              : stage === 10
                ? 'pending'
                : 'advance';
          const started = performance.now();
          const opened =
            await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
              identity: accountIdentity,
              enrollment,
              archive: accountArchive,
              coordinator,
              policy,
              mode,
            });
          try {
            const balances = await opened.view.balance(),
              notes = await opened.view.notes(),
              status = await opened.view.status();
            const amount = balances.reduce((sum, item) => sum + item.amount, 0n);
            assert.equal(amount, stage === 10 ? 3000n : stage === 20 ? 2000n : 2700n);
            assert.equal(notes.length, stage === 10 ? 2 : stage === 20 ? 1 : 2);
            assert.equal((await opened.view.notes(undefined, true)).length, stage === 30 ? 3 : 2);
            assert.equal(await opened.view.instanceId(), accountIdentity.descriptor.instanceId);
            assert.equal(status.status, 'wallet-scanned-unverified');
            assert.equal(status.spendableGranted, false);
            assert.ok(balances.every((b) => b.tag === 'unverified'));
            assert.equal(opened.view.prepareTransfer, undefined);
            walletDirectory = catalog.activeFor(policy).directory;
            assert.ok(
              retainedDirectories.every((dir) => fs.existsSync(path.join(dir, 'wallet.sqlite')))
            );
            const accountWindows = [];
            const privatePreparations = [];
            if (attempt === 'restore') {
              const {
                readRailgunAccountOwnedNotes,
                restoreRailgunAccountWallet,
              } = require('../src/main/wallet/railgun-account-wallet');
              const owners = { identity: accountIdentity, enrollment, coordinator };
              for (let i = 0; i < 2; i++) {
                const previousView = opened.view;
                const before = readRailgunAccountOwnedNotes(opened, owners);
                const restoring = restoreRailgunAccountWallet(opened, owners);
                assert.throws(() => readRailgunAccountOwnedNotes(opened, owners));
                const nextView = await restoring;
                assert.equal(nextView, opened.view);
                assert.notEqual(nextView, previousView);
                await assert.rejects(previousView.balance());
                const after = readRailgunAccountOwnedNotes(opened, owners);
                assert.equal(after.checkpointHash, before.checkpointHash);
                assert.notEqual(after.read.received[0], before.read.received[0]);
                assert.deepEqual(after.ownedPoi, before.ownedPoi);
                assert.equal(
                  (await nextView.balance()).reduce((sum, b) => sum + b.amount, 0n),
                  amount
                );
                accountWindows.push({
                  currentViewReplaced: true,
                  busyOwnedReadRefused: true,
                  oldViewRefused: true,
                  checkpointUnchanged: true,
                  ownedProjectionUnchanged: true,
                  freshOwnedNoteObjects: true,
                  balanceUnchanged: true,
                });
              }
              const beforePreparation = readRailgunAccountOwnedNotes(opened, owners);
              const selected = beforePreparation.read.received
                .filter((v) => v.spentTxid === false)
                .at(-1);
              if (
                selected.asset.contract ===
                require('../src/main/wallet/railgun-shield-pins.json').wrappedNative
              ) {
                for (const kind of ['railgun-private-transfer', 'railgun-token-unshield']) {
                  const previousView = opened.view,
                    keysBefore = privateViewingKeys,
                    started = performance.now();
                  const prepared =
                    await require('../src/main/wallet/railgun-account-wallet').prepareRailgunAccountPrivateIntent(
                      opened,
                      owners,
                      {
                        kind,
                        noteId: selected.id,
                        recipient:
                          kind === 'railgun-private-transfer'
                            ? accountIdentity.descriptor.instanceId
                            : '0x' + '12'.repeat(20),
                      }
                    );
                  assert.equal(prepared.view, opened.view);
                  await assert.rejects(previousView.balance());
                  assert.equal(prepared.preparation.spendingEnabled, false);
                  assert.equal(prepared.preparation.witnessRetained, false);
                  assert.deepEqual(prepared.readOnly, { readOnly: true, writeAttempts: 0 });
                  assert.equal(prepared.preparation.amount, selected.amount.toString());
                  assert.equal(privateViewingKeys - keysBefore, 1);
                  assert.deepEqual(
                    readRailgunAccountOwnedNotes(opened, owners).ownedPoi,
                    beforePreparation.ownedPoi
                  );
                  let receiver;
                  if (kind === 'railgun-private-transfer') {
                    const p = prepared.preparation,
                      keyCount = privateReceiveKeys;
                    const verify =
                      require('../src/main/wallet/railgun-private-receive').verifyRailgunPrivateReceiver;
                    const args = {
                      identity: accountIdentity,
                      enrollment,
                      archive: accountArchive,
                      transaction: p.transaction,
                      expected: p.expected,
                      recipient: p.recipient,
                      amount: p.amount,
                    };
                    const checked = await verify(args);
                    assert.equal(checked.recipientVerified, true);
                    assert.equal(checked.transactionDigest, p.transactionDigest);
                    assert.equal(checked.spendingEnabled, false);
                    assert.equal(checked.inputOwnershipVerified, false);
                    await assert.rejects(
                      verify({ ...args, amount: (BigInt(p.amount) + 1n).toString() }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    const { Interface, AbiCoder, keccak256 } = require('ethers');
                    const {
                      TRANSACT_ABI,
                      BOUND_PARAMS,
                    } = require('../src/main/wallet/railgun-private-policy');
                    const abi = new Interface([TRANSACT_ABI]);
                    const bad = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    bad[4][6][0][0][1] =
                      '0x' + (BigInt(bad[4][6][0][0][1]) ^ 1n).toString(16).padStart(64, '0');
                    const boundHash =
                      BigInt(
                        keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bad[4]]))
                      ) %
                      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[bad]]),
                        },
                        expected: {
                          ...p.expected,
                          boundParamsHash: '0x' + boundHash.toString(16).padStart(64, '0'),
                        },
                      }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    const changedCommitment = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    changedCommitment[3][0] =
                      '0x' + (BigInt(changedCommitment[3][0]) ^ 1n).toString(16).padStart(64, '0');
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[changedCommitment]]),
                        },
                        expected: { ...p.expected, commitment: changedCommitment[3][0] },
                      }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    corruptPrivateReceiveKey = true;
                    await assert.rejects(verify(args), {
                      code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED',
                    });
                    assert.equal(corruptPrivateReceiveKey, false);
                    const foreign = foreignTransfers?.find((v) => v.amount === p.amount);
                    assert.ok(foreign);
                    const foreignTx = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    foreignTx[3][0] = foreign.commitment;
                    foreignTx[4][6] = [foreign.ciphertext];
                    const foreignHash =
                      BigInt(
                        keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [foreignTx[4]]))
                      ) %
                      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[foreignTx]]),
                        },
                        expected: {
                          ...p.expected,
                          commitment: foreign.commitment,
                          boundParamsHash: '0x' + foreignHash.toString(16).padStart(64, '0'),
                        },
                      }),
                      { code: 'RAILGUN_PRIVATE_RECEIVER_REFUSED' }
                    );
                    assert.equal(privateReceiveKeys - keyCount, 6);
                    const keyCountBeforePolicyRefusal = privateReceiveKeys;
                    const nonzero = abi
                      .decodeFunctionData('transact', p.transaction.data)[0][0]
                      .toArray(true);
                    nonzero[0][0][0] = 1n;
                    await assert.rejects(
                      verify({
                        ...args,
                        transaction: {
                          ...p.transaction,
                          data: abi.encodeFunctionData('transact', [[nonzero]]),
                        },
                      })
                    );
                    await assert.rejects(
                      verify({
                        ...args,
                        expected: { ...p.expected, kind: 'railgun-token-unshield' },
                      })
                    );
                    assert.equal(privateReceiveKeys, keyCountBeforePolicyRefusal);
                    receiver = {
                      recipientVerified: true,
                      wrongAmountRefused: true,
                      changedCiphertextRefused: true,
                      changedCommitmentRefused: true,
                      wrongViewingKeyRefused: true,
                      foreignRecipientRefused: true,
                      nonzeroProofRefusedBeforeKey: true,
                      wrongKindRefusedBeforeKey: true,
                      viewingKeyTransfersIncludingNegatives: 6,
                      inputOwnershipVerified: false,
                      spendingEnabled: false,
                    };
                  } else {
                    const p = prepared.preparation,
                      keyCount = privateReceiveKeys;
                    await assert.rejects(
                      require('../src/main/wallet/railgun-private-receive').verifyRailgunPrivateReceiver(
                        {
                          identity: accountIdentity,
                          enrollment,
                          archive: accountArchive,
                          transaction: p.transaction,
                          expected: p.expected,
                          recipient: accountIdentity.descriptor.instanceId,
                          amount: p.amount,
                        }
                      )
                    );
                    assert.equal(privateReceiveKeys, keyCount);
                    receiver = { validUnshieldRefusedBeforeKey: true, viewingKeyTransfers: 0 };
                  }
                  privatePreparations.push({
                    kind,
                    elapsedMs: Math.round(performance.now() - started),
                    currentViewReplaced: true,
                    oldViewRefused: true,
                    ownedProjectionUnchanged: true,
                    fullInputAmount: true,
                    viewingKeyTransfers: 1,
                    spendingEnabled: false,
                    witnessRetained: false,
                    writeAttempts: 0,
                    ...(receiver ? { receiver } : {}),
                  });
                }
              }
            }
            runs.push({
              stage,
              attempt,
              mode,
              elapsedMs: performance.now() - started,
              observedAmount: amount.toString(),
              unspentNotes: notes.length,
              instanceMatches: true,
              spendableGranted: false,
              accountWindows,
              privatePreparations,
            });
          } finally {
            await opened.close();
          }
          await assert.rejects(opened.view.balance());
          await assert.rejects(opened.view.notes());
          await assert.rejects(opened.view.instanceId());
          runs.at(-1).closedReadsRefused = true;
          console.log(JSON.stringify(runs.at(-1)));
          continue;
        }
        if (attempt === 'rebuild') {
          retainedDirectories.push(walletDirectory);
          generation = await catalog.begin(policy);
          walletDirectory = generation.directory;
        }
        const handle = scope.getContext({ ...subject, role: 'engine' });
        walletSession = startRailgunSessionWorker({
          handle,
          storage: {
            format: 'paged-v2',
            filename: path.join(walletDirectory, 'wallet.sqlite'),
            key: Buffer.alloc(32, 64),
            binding: 'd'.repeat(64),
            create:
              (stage === 10 && attempt === (accountIdentity ? 'scan' : 'interrupt')) ||
              attempt === 'rebuild',
          },
          createProvider: ({ signal }) => ({
            signal,
            request: async () => {
              throw Error('No wallet RPC');
            },
          }),
          onClose: () => {},
        });
        await walletSession.ready;
        if (!generation) {
          const identity = await walletSession.inspectStoreIdentity();
          walletSession.assertFresh(identity);
          assert.equal(identity.instanceId, catalog.activeFor(policy).storeId);
        }
        const coverageStore = createRailgunWalletCoverageStore({
          session: walletSession,
          walletId,
          policy,
          assertScan: runner.assertScan,
        });
        walletJournal = await createRailgunWalletJournal({
          handle: scope.getContext({
            ...subject,
            role: 'storage',
            operation: 'railgun-wallet-v1:' + walletId,
          }),
          directory: walletDirectory,
          key: Buffer.alloc(32, 65),
          binding: 'e'.repeat(64),
          walletId,
          policy,
          storeSession: walletSession,
          coverageStore,
          coordinator,
          assertScan: runner.assertScan,
          create:
            (stage === 10 && attempt === (accountIdentity ? 'scan' : 'interrupt')) ||
            attempt === 'rebuild',
        });
        const started = performance.now(),
          beforeRequests = requests;
        let failure, pending;
        const running = coordinator.withPublicSnapshot(async (snapshot) => {
          if (!restore || attempt === 'restore-pending')
            pending = await walletJournal.prepare(snapshot.checkpoint);
          return runner
            .run({
              handle,
              snapshot,
              walletSession,
              coverageStore,
              walletId,
              restore,
              interruptAfterWalletBatches: attempt === 'interrupt' ? 1 : 0,
            })
            .catch((error) => {
              failure = { closed: error.closed, walletBatches: error.walletBatches };
              throw error;
            });
        });
        if (attempt === 'interrupt' || attempt === 'incomplete-restore') {
          await assert.rejects(running);
          assert.ok(failure?.closed);
          if (attempt === 'interrupt') assert.equal(failure.walletBatches, 1);
          assert.throws(() => coordinator.inspect());
          runs.push({ stage, attempt, refused: true, ...failure });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          await close();
          await open(false);
          assert.equal((await coordinator.recover()).to.number, stage);
          continue;
        }
        let checked = await running;
        if (attempt === 'host-first') {
          await coverageStore.read();
          await assert.rejects(coverageStore.read(checked.value.receipt));
          assert.throws(() => walletJournal.assertReady());
          runs.push({ stage, attempt, refused: true });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          continue;
        }
        const coverage = restore
          ? await coverageStore.read(checked.value.receipt)
          : await coverageStore.write(
              coordinator.assertSnapshot(checked.evidence),
              checked.value.coverage,
              checked.value.receipt
            );
        const state = await walletSession.inspectWalletState();
        let evidence = {
          snapshot: checked.evidence,
          coverage,
          state,
          receipt: checked.value.receipt,
        };
        if (attempt === 'coverage-crash') {
          assert.ok((await walletJournal.readState()).pending);
          assert.throws(() => walletJournal.assertReady());
          runs.push({ stage, attempt, closedBeforeJournalCommit: true });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          continue;
        }
        if (attempt === 'stale-public') {
          await advancePublic({ to: 20, anchor: capture.report.anchor });
          await assert.rejects(walletJournal.complete(pending, evidence));
          assert.throws(() => walletJournal.assertReady());
          runs.push({ stage, attempt, refused: true, publicAdvancedTo: 20 });
          walletJournal.close();
          walletSession.close();
          await walletSession.closed;
          continue;
        }
        if (stage === 20 && !restore) {
          const renewed = await coordinator.withPublicSnapshot(async () => null);
          assert.throws(() => coordinator.assertSnapshot(checked.evidence));
          evidence.snapshot = renewed.evidence;
        }
        if (restore && attempt !== 'restore-pending') await walletJournal.revalidate(evidence);
        else await walletJournal.complete(pending, evidence);
        assert.equal(walletJournal.assertReady().status, 'wallet-scanned-unverified');
        assert.equal(walletJournal.assertReady().spendableGranted, false);
        if (generation) {
          await catalog.publish(generation, walletJournal);
          generation = null;
          assert.equal(catalog.activeFor(policy).directory, walletDirectory);
        }
        assert.ok(
          retainedDirectories.every((dir) => fs.existsSync(path.join(dir, 'wallet.sqlite')))
        );
        let view = require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
          runner,
          journal: walletJournal,
          receipt: checked.value.receipt,
        });
        assert.throws(() =>
          require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
            runner,
            journal: walletJournal,
            receipt: {},
          })
        );
        const originalValue = checked.value.result.received[0].value;
        checked.value.result.received[0].value = '999999999';
        const balances = await view.balance(),
          notes = await view.notes();
        assert.equal(
          balances.reduce((sum, item) => sum + item.amount, 0n),
          stage === 10 ? 3000n : stage === 20 ? 2000n : 2700n
        );
        checked.value.result.received[0].value = originalValue;
        assert.ok(
          balances.every((item) => item.tag === 'unverified' && item.asset.__type === 'erc20')
        );
        assert.equal(notes.length, stage === 10 ? 2 : stage === 20 ? 1 : 2);
        assert.equal((await view.notes(undefined, true)).length, stage === 30 ? 3 : 2);
        assert.equal((await view.balance([{ __type: 'native' }])).length, 0);
        assert.equal(await view.instanceId(), checked.value.result.instanceId);
        assert.equal((await view.status()).spendableGranted, false);
        assert.equal(view.prepareTransfer, undefined);
        const kohakuReads = {
          unspentNotes: notes.length,
          observedAmount: balances.reduce((sum, item) => sum + item.amount, 0n).toString(),
          tag: 'unverified',
          spendableGranted: false,
        };
        // The non-enrolled vault composition keeps the actual coverage store
        // visible so this qualifier can exercise two additional read-only
        // windows and journal re-attestation without adding a product API.
        if (accountIdentity && attempt === 'restore') {
          const readOnlyWindows = [];
          const beforeReadOnly = await walletSession.inspectWalletState();
          for (let windowIndex = 0; windowIndex < 2; windowIndex++) {
            const previousView = view,
              previousReceipt = checked.value.receipt;
            const renewed = await coordinator.withPublicSnapshot(async (snapshot) => {
              await assert.rejects(previousView.balance());
              return runner.restoreReadOnly({
                handle,
                snapshot,
                walletSession,
                coverageStore,
                walletId,
              });
            });
            const renewedCoverage = await coverageStore.read(renewed.value.receipt);
            const renewedState = await walletSession.inspectWalletState();
            assert.deepEqual(renewedState, beforeReadOnly);
            evidence = {
              snapshot: renewed.evidence,
              coverage: renewedCoverage,
              state: renewedState,
              receipt: renewed.value.receipt,
            };
            await walletJournal.revalidate(evidence);
            assert.throws(() => walletJournal.assertReceipt(previousReceipt));
            await assert.rejects(previousView.balance());
            checked = renewed;
            view = require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
              runner,
              journal: walletJournal,
              receipt: checked.value.receipt,
            });
            assert.equal(
              (await view.balance()).reduce((sum, item) => sum + item.amount, 0n).toString(),
              kohakuReads.observedAmount
            );
            assert.deepEqual(checked.value.readOnly, { readOnly: true, writeAttempts: 0 });
            readOnlyWindows.push({
              ...checked.value.readOnly,
              previousReceiptRefused: true,
              previousViewRefused: true,
              walletBytesUnchanged: true,
              journalRevalidated: true,
            });
          }
          kohakuReads.readOnlyWindows = readOnlyWindows;
        }
        await assert.rejects(coverageStore.read(checked.value.receipt));
        assert.throws(() => walletJournal.assertReady());
        await assert.rejects(view.balance());
        await assert.rejects(view.notes());
        await assert.rejects(view.instanceId());
        kohakuReads.staleReadsRefused = true;
        const result = { evidence: evidence.snapshot, value: checked.value.result };
        assert.equal(coordinator.assertSnapshot(result.evidence).to.number, stage);
        previousEvidence = result.evidence;
        assert.equal(result.value.scannedLeaves, stage === 30 ? 3 : 2);
        assert.equal(result.value.received.length, stage === 30 ? 3 : 2);
        assert.equal(
          result.value.received.filter((note) => note.spentTxid !== false).length,
          stage >= 20 ? 1 : 0
        );
        assert.equal(
          result.value.received
            .filter((note) => note.spentTxid === false)
            .reduce((total, note) => total + BigInt(note.value), 0n)
            .toString(),
          stage === 10 ? '3000' : stage === 20 ? '2000' : '2700'
        );
        assert.equal(result.value.sent.length, stage === 30 ? 1 : 0);
        assert.equal(result.value.spendableGranted, false);
        runs.push({
          stage,
          attempt,
          restore,
          kohakuReads,
          renewedSameCheckpoint: stage === 20 && !restore,
          elapsedMs: Math.round(performance.now() - started),
          sourceHeaderRequests: requests - beforeRequests,
          // The scan now carries an internal owned-note projection. Keep that
          // projection out of reports, even for this public synthetic fixture.
          // An allowlist also excludes future private fields added by the SDK.
          ...Object.fromEntries(
            [
              'instanceId',
              'scannedLeaves',
              'expectedReceived',
              'expectedSent',
              'quarantine',
              'unrecoverableSent',
              'received',
              'sent',
              'spendableGranted',
              'inventory',
              'guards',
              'poiCalls',
              'electron',
              'closed',
            ].map((key) => [key, result.value[key]])
          ),
          ownedProjection: {
            count: result.value.ownedPoi.length,
            types: [...new Set(result.value.ownedPoi.map((note) => note.type))].sort(),
            fieldChecksPassed: true,
          },
        });
        console.log(
          JSON.stringify({
            restore,
            elapsedMs: runs.at(-1).elapsedMs,
            scannedLeaves: result.value.scannedLeaves,
          })
        );
        walletJournal.close();
        walletSession.close();
        await walletSession.closed;
      }
    }
    if (enrollment) {
      const openWallet = (mode) =>
        require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
          identity: accountIdentity,
          enrollment,
          archive: accountArchive,
          coordinator,
          policy,
          mode,
        });
      const interruptedRestore = await openWallet('active');
      failReadOnlyRestore = true;
      await assert.rejects(
        require('../src/main/wallet/railgun-account-wallet').restoreRailgunAccountWallet(
          interruptedRestore,
          { identity: accountIdentity, enrollment, coordinator }
        )
      );
      assert.equal(failReadOnlyRestore, false);
      assert.equal(interruptedRestore.signal.aborted, true);
      assert.equal(coordinator.signal.aborted, true);
      await assert.rejects(interruptedRestore.view.balance());
      await interruptedRestore.close();
      await close();
      await open(false);
      assert.equal((await coordinator.recover()).to.number, 30);
      const restoredAfterInterruption = await openWallet('active');
      try {
        assert.equal((await restoredAfterInterruption.view.balance())[0].amount, 2700n);
      } finally {
        await restoredAfterInterruption.close();
      }
      runs.push({
        attempt: 'read-only-window-interruption',
        accountClosed: true,
        publicCoordinatorClosed: true,
        coldRecovery: true,
        observedAmount: '2700',
      });
      failPublication = true;
      await assert.rejects(openWallet('new'), /Injected publication interruption/);
      assert.equal(failPublication, false);
      const pending = (await catalog.inspect()).pending;
      assert.ok(pending);
      const before = walletRestores.length;
      await assert.rejects(openWallet('new'));
      assert.equal((await catalog.inspect()).pending.id, pending.id);
      assert.equal(walletRestores.length, before);
      const recovered = await openWallet('pending');
      try {
        assert.equal(walletRestores.at(-1), true);
        assert.equal((await recovered.view.balance())[0].amount, 2700n);
      } finally {
        await recovered.close();
      }
      runs.push({
        attempt: 'journal-complete-before-publication',
        pendingPreserved: true,
        restored: true,
        observedAmount: '2700',
      });
      await advancePublic({ to: 40, anchor: capture.report.anchor });
      failWalletBatch = true;
      await assert.rejects(openWallet('advance'));
      assert.equal(failWalletBatch, false);
      await close();
      enrollment.close();
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity: accountIdentity }
        );
      await open(false);
      await coordinator.recover();
      const beforeActive = walletRestores.length;
      await assert.rejects(openWallet('active'));
      assert.equal(walletRestores.length, beforeActive);
      const advanced = await openWallet('advance');
      let recoveredThrough;
      try {
        assert.equal((await advanced.view.balance())[0].amount, 2700n);
        recoveredThrough = (await advanced.view.status()).to.number;
        assert.equal(recoveredThrough, 40);
        assert.equal(walletRestores.at(-1), false);
      } finally {
        await advanced.close();
      }
      runs.push({
        attempt: 'interrupted-advance',
        activeRefusedPending: true,
        recoveredThrough,
        observedAmount: '2700',
      });
      const obsolete = await catalog.begin('f'.repeat(64));
      await assert.rejects(openWallet('pending'));
      const replacement = await openWallet('new');
      try {
        assert.notEqual(replacement.generationId, obsolete.id);
        assert.ok(fs.statSync(obsolete.directory).isDirectory());
        assert.equal((await replacement.view.balance())[0].amount, 2700n);
      } finally {
        await replacement.close();
      }
      runs.push({
        attempt: 'obsolete-policy-candidate',
        oldDirectoryRetained: true,
        pendingRefused: true,
        newGenerationPublished: true,
        observedAmount: '2700',
      });
      for (let n = 0; n < 12; n++) {
        const rebuilt = await openWallet('new');
        try {
          assert.equal((await rebuilt.view.balance())[0].amount, 2700n);
          assert.equal((await rebuilt.view.status()).to.number, 40);
        } finally {
          await rebuilt.close();
        }
      }
      const retention = await catalog.inspectRetention();
      assert.ok(retention.retired.length >= 8 && retention.listed <= 8);
      for (const id of retention.retired)
        assert.ok(
          fs.statSync(path.join(enrollment.directory, 'railgun-cache-' + id)).isDirectory()
        );
      enrollment.profileGuard.assert(path.join(enrollment.directory, 'source.sqlite'));
      runs.push({
        attempt: 'successive-cache-rebuilds',
        rebuilds: 12,
        retiredGenerations: retention.retired.length,
        listedGenerations: retention.listed,
        retiredDirectoriesRetained: true,
        observedAmount: '2700',
      });
      failPublication = true;
      await assert.rejects(openWallet('new'), /Injected publication interruption/);
      assert.equal(failPublication, false);
      const stranded = (await catalog.inspect()).pending;
      const strandedDirectory = path.join(enrollment.directory, 'railgun-cache-' + stranded.id);
      const strandedHashes = Object.fromEntries(
        fs
          .readdirSync(strandedDirectory)
          .filter((name) => name.endsWith('.json') || name === 'wallet.sqlite')
          .map((name) => [name, sha(fs.readFileSync(path.join(strandedDirectory, name)))])
      );
      const previousWalletPolicy = policy;
      const previousPublicId = publicAccount.generationId;
      const previousPublicDirectory = path.join(
        enrollment.directory,
        'railgun-public-' + previousPublicId
      );
      const retainedFiles = fs
        .readdirSync(previousPublicDirectory)
        .filter(
          (name) => name.endsWith('.json') || name === 'source.sqlite' || name === 'public.sqlite'
        );
      await close();
      const retainedHashes = Object.fromEntries(
        retainedFiles.map((name) => [
          name,
          createHash('sha256')
            .update(fs.readFileSync(path.join(previousPublicDirectory, name)))
            .digest('hex'),
        ])
      );
      await open(false, 'new');
      const candidatePublicId = publicAccount.generationId;
      assert.notEqual(candidatePublicId, previousPublicId);
      await advancePublic({ to: 10, anchor: capture.report.anchor });
      await assert.rejects(openWallet('new')); // Candidate below the durable floor has no wallet authority.
      await close();
      await open(false, 'pending');
      assert.equal(publicAccount.generationId, candidatePublicId);
      await coordinator.recover();
      assert.equal(coordinator.inspect().to.number, 10);
      await advancePublic({ to: 20, anchor: capture.report.anchor });
      await advancePublic({ to: 30, anchor: capture.report.anchor });
      // Finish the journal but intentionally omit catalog publication, then cold resume.
      await coordinator.advance({ to: 40, anchor: capture.report.anchor });
      await close();
      await open(false, 'pending');
      await publicAccount.publish();
      assert.equal(coordinator.inspect().to.number, 40);
      policy = require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy({
        archive: accountArchive,
        enrollment,
        coordinator,
      });
      assert.notEqual(policy, previousWalletPolicy);
      await assert.rejects(openWallet('active'));
      await assert.rejects(openWallet('pending'));
      const rebuiltPublicWallet = await openWallet('new');
      try {
        assert.equal((await rebuiltPublicWallet.view.balance())[0].amount, 2700n);
        assert.equal((await rebuiltPublicWallet.view.status()).to.number, 40);
      } finally {
        await rebuiltPublicWallet.close();
      }
      for (const [name, hash] of Object.entries(strandedHashes))
        assert.equal(sha(fs.readFileSync(path.join(strandedDirectory, name))), hash);
      for (const [name, hash] of Object.entries(retainedHashes))
        assert.equal(
          createHash('sha256')
            .update(fs.readFileSync(path.join(previousPublicDirectory, name)))
            .digest('hex'),
          hash
        );
      enrollment.profileGuard.assert(path.join(previousPublicDirectory, 'source.sqlite'));
      runs.push({
        attempt: 'interrupted-public-generation-rebuild',
        belowFloorWalletRefused: true,
        pendingResumedThrough: 10,
        completeBeforePublicationRecovered: true,
        oldWalletRefusedAfterCutover: true,
        strandedPendingRefusedAfterCutover: true,
        strandedPendingFilesUnchanged: true,
        effectiveWalletPolicyChanged: true,
        oldPublicFilesUnchanged: true,
        observedAmount: '2700',
        recoveredThrough: 40,
      });
      await close();
      await open(false);
      await coordinator.recover();
      assert.equal(
        require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy({
          archive: accountArchive,
          enrollment,
          coordinator,
        }),
        policy
      );
      const restoredPublicWallet = await openWallet('active');
      try {
        assert.equal((await restoredPublicWallet.view.balance())[0].amount, 2700n);
      } finally {
        await restoredPublicWallet.close();
      }
      runs.push({
        attempt: 'public-generation-cold-restore',
        observedAmount: '2700',
        recoveredThrough: 40,
      });
    }
    if (enrollment) {
      const walletCatalogFile = getPrivacyStoragePath(
        enrollment.getContext('storage', 'railgun-wallet-catalog-v1:' + walletId),
        enrollment.directory
      );
      for (const [name, hash] of legacyHashes) {
        // The existing wallet catalog legitimately changes during wallet rebuilds.
        if (path.join(enrollment.directory, name) === walletCatalogFile) continue;
        assert.equal(sha(fs.readFileSync(path.join(enrollment.directory, name))), hash);
      }
      runs.push({
        attempt: 'legacy-public-policy-upgrade',
        oldPolicy: 'e'.repeat(64),
        authenticatedHeight: 10,
        readOnlyInspectionPreservedInventory: true,
        legacySourcePublicJournalUnchanged: true,
      });
      const reservations = await enrollment.openReservations();
      assert.deepEqual(await reservations.inspect(), {
        held: 1,
        signing: 0,
        abandoned: 0,
        legacy: 0,
      });
      await assert.rejects(reservations.reserve(reservationInput), {
        code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
      });
      runs.push({
        attempt: 'account-reservations',
        syntheticInputFacts: true,
        held: 1,
        enrollmentReopenPreserved: true,
        cacheRebuildPreserved: true,
        duplicateRefused: true,
        oldReceiptRefused: true,
        signingEnabled: false,
      });
      const recoveryInput = Object.freeze({
        tree: reservationInput.tree,
        position: reservationInput.position,
        nullifier: reservationInput.nullifier,
        noteHash: reservationInput.noteHash,
      });
      const recoveryWallet =
        await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
          identity: accountIdentity,
          enrollment,
          archive: accountArchive,
          coordinator,
          mode: 'active',
        });
      try {
        await assert.rejects(reservations.abandonRecovered(recoveryInput), {
          code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
        });
        assert.deepEqual(await reservations.inspect(), {
          held: 1,
          signing: 0,
          abandoned: 0,
          legacy: 0,
        });
      } finally {
        await recoveryWallet.close();
      }
      await reservations.abandonRecovered(recoveryInput);
      assert.deepEqual(await reservations.inspect(), {
        held: 0,
        signing: 0,
        abandoned: 1,
        legacy: 0,
      });
      const replacement = await reservations.reserve(reservationInput);
      const signingEvidence = Object.freeze({
        submitter: '0x' + '7'.repeat(40),
        operationId: '8'.repeat(64),
        gatesDigest: '9'.repeat(64),
      });
      const signingReceipt = await reservations.markSigning(replacement, signingEvidence);
      assert.equal((await reservations.assertReceipt(signingReceipt)).state, 'signing');
      assert.deepEqual((await reservations.assertReceipt(signingReceipt)).signing, signingEvidence);
      await assert.rejects(reservations.assertReceipt(replacement));
      await assert.rejects(reservations.abandon(signingReceipt));
      await close();
      enrollment.close();
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          {
            identity: accountIdentity,
          }
        );
      const recoveredReservations = await enrollment.openReservations();
      await assert.rejects(recoveredReservations.assertReceipt(signingReceipt));
      await assert.rejects(recoveredReservations.abandonRecovered(recoveryInput), {
        code: 'RAILGUN_RESERVATION_NOT_RECOVERABLE',
      });
      await assert.rejects(recoveredReservations.reserve(reservationInput), {
        code: 'RAILGUN_PRIVATE_INPUT_RESERVED',
      });
      assert.deepEqual(await recoveredReservations.inspect(), {
        held: 0,
        signing: 1,
        abandoned: 1,
        legacy: 0,
      });
      await open(false);
      runs.push({
        attempt: 'reservation-lifecycle',
        syntheticInputFacts: true,
        syntheticSigningEvidence: true,
        liveWalletBlockedRecovery: true,
        drainedWalletAllowedHeldRecovery: true,
        abandonedInputReservedAgain: true,
        oldHeldReceiptRefused: true,
        signingReceiptRequiresCurrentStore: true,
        signingStatePreservedOnReopen: true,
        signingStateCannotBeAbandoned: true,
        signingKeyReleased: false,
      });
    }
    assert.equal(applications.length, enrollment ? 10 : 3);
    if (accountIdentity) {
      const handle = scope.getContext({ ...subject, role: 'engine' });
      walletSession = startRailgunSessionWorker({
        handle,
        storage: {
          format: 'paged-v2',
          filename: path.join(directory, 'cancel-wallet.sqlite'),
          key: Buffer.alloc(32, 64),
          binding: 'd'.repeat(64),
          create: true,
        },
        createProvider: ({ signal }) => ({
          signal,
          request: async () => {
            throw Error('No wallet RPC');
          },
        }),
        onClose: () => {},
      });
      await walletSession.ready;
      const cancelledCoverage = createRailgunWalletCoverageStore({
        session: walletSession,
        walletId,
        policy,
        assertScan: runner.assertScan,
      });
      lockOnViewingKey = true;
      await assert.rejects(
        coordinator.withPublicSnapshot((snapshot) =>
          runner.run({
            handle,
            snapshot,
            walletSession,
            coverageStore: cancelledCoverage,
            walletId,
            restore: false,
          })
        ),
        { code: 'RAILGUN_SCAN_COORDINATOR_REFUSED' }
      );
      assert.ok(cancelledViewingClosed);
      await cancelledViewingClosed;
      assert.equal(vault.isUnlocked(), false);
      assert.equal(accountIdentity.signal.aborted, true);
      assert.equal(cancelledViewingMessages, 1);
      assert.equal(
        cancelledViewingProcessClosed,
        true,
        JSON.stringify({
          closed: cancelledViewingProcess,
          keyProduced: !!cancelledViewingKey,
          vaultUnlocked: vault.isUnlocked(),
        })
      );
      assert.ok(
        cancelledViewingKey instanceof Uint8Array && cancelledViewingKey.every((v) => v === 0)
      );
      walletSession.close();
      await walletSession.closed;
    }
    assert.deepEqual(hashes(), sourceSha256);
    assert.doesNotMatch(JSON.stringify(runs), /"(?:ownedPoi|npk|nullifier|blindedCommitment)"\s*:/);
    fs.writeFileSync(
      path.join(directory, 'report.json'),
      JSON.stringify(
        {
          observedAt: new Date().toISOString(),
          sourceSha256,
          syntheticPublicHistory: true,
          liveAcquisition: false,
          publicViewingVector: true,
          vaultBoundAccount: !!accountIdentity,
          enrolledWalletComposition: !!enrollment,
          authenticatedPublicJobs: !!enrollment,
          enrolledPublicComposition: !!enrollment,
          cancelledViewingProcess,
          cancelledViewingMessages: accountIdentity ? cancelledViewingMessages : null,
          viewingKeyTransferCancelled: accountIdentity ? cancelledViewingProcessClosed : null,
          cancelledViewingKeyWiped: accountIdentity
            ? cancelledViewingKey.every((v) => v === 0)
            : null,
          independentEngineIdentityMatches: !!accountIdentity,
          walletCoverageGranted: true,
          receiptReplayRefused: enrollment ? null : true,
          durableJournal: true,
          generationSwap: true,
          explicitlyCheckedRebuildDirectories: retainedDirectories.length,
          spendableGranted: false,
          submissions: 0,
          anchor: capture.report.anchor,
          logSetSha256: capture.logSetSha256,
          requests,
          applications,
          publicPolicy: enrollment ? publicAccount.policy : null,
          runs,
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
  } finally {
    walletJournal?.close();
    walletSession?.close();
    if (walletSession) await walletSession.closed;
    await close();
    enrollment?.close();
    accountIdentity?.close();
    vault?.lockVault();
  }
}
main().then(
  () => {
    if (qualificationLock) releaseProfileLock(qualificationLock);
    app.exit(0);
  },
  (error) => {
    console.error(error.stack);
    if (qualificationLock) releaseProfileLock(qualificationLock);
    app.exit(1);
  }
);
