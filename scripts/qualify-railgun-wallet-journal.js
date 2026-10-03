/** Durable wallet checkpoint and interrupted recovery over synthetic public history. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
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
            const message = JSON.parse(wire),
              reply = await original.dispatch(wire);
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
    { logs } = JSON.parse(sourceBytes);
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
  async function open(create) {
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
    if (create) generation = await catalog.begin(policy);
    else if ((await catalog.inspect()).pending) generation = await catalog.resume();
    else generation = null;
    walletDirectory = generation?.directory ?? catalog.activeFor(policy).directory;
  }
  async function close() {
    await publicAccount?.close();
    catalog?.close();
    coordinator?.close();
    source?.close();
    ledger?.close();
    session?.close();
    scope?.close();
    await Promise.all([ledger?.closed, session?.closed]);
  }
  const sources = [
    'src/main/wallet/railgun-account-public.js',
    'src/main/wallet/railgun-public-job.js',
    'src/main/wallet/railgun-public-run.js',
    'src/main/wallet/railgun-public-policy.js',
    'scripts/qualify-railgun-wallet-journal.js',
    'src/main/wallet/railgun-account-wallet.js',
    'src/main/wallet/railgun-wallet-policy.js',
    'src/main/wallet/railgun-account-store.js',
    'src/main/wallet/railgun-account-enrollment.js',
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
  const policy = enrollment
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
  try {
    await open(true);
    let previousEvidence;
    for (const stage of [10, 20, 30]) {
      if (enrollment && stage === 30) {
        failPublicCommit = true;
        await assert.rejects(coordinator.advance({ to: stage, anchor: capture.report.anchor }));
        assert.equal(failPublicCommit, false);
        assert.equal(applications.at(-1).interrupted, true);
        await close();
        enrollment.close();
        enrollment =
          await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
            { identity: accountIdentity }
          );
        await open(false);
        const recovered = await coordinator.recover();
        assert.equal(recovered.to.number, stage);
        runs.push({
          attempt: 'interrupted-public-apply',
          acknowledgedCommitInterrupted: true,
          recoveredThrough: recovered.to.number,
        });
      } else if (stage !== 20 || accountIdentity)
        await coordinator.advance({ to: stage, anchor: capture.report.anchor });
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
            runs.push({
              stage,
              attempt,
              mode,
              elapsedMs: performance.now() - started,
              observedAmount: amount.toString(),
              unspentNotes: notes.length,
              instanceMatches: true,
              spendableGranted: false,
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
        const checked = await running;
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
        const evidence = {
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
          await coordinator.advance({ to: 20, anchor: capture.report.anchor });
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
        const view = require('../src/main/wallet/railgun-kohaku-read').createRailgunKohakuRead({
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
          ...result.value,
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
      await coordinator.advance({ to: 40, anchor: capture.report.anchor });
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
    }
    assert.equal(applications.length, enrollment ? 5 : 3);
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
