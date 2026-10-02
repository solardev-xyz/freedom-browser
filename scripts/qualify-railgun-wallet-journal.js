/** Durable wallet checkpoint and interrupted recovery over synthetic public history. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict'),
  { createHash } = require('crypto');
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [sourceFilename, directory] = process.argv.slice(2);
  assert.ok(
    path.isAbsolute(sourceFilename) && path.isAbsolute(directory) && !fs.existsSync(directory)
  );
  fs.mkdirSync(directory, { mode: 0o700 });
  app.setPath('userData', path.join(directory, 'electron'));
  app.dock?.hide();
  await app.whenReady();
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
    principal: 'fixture',
    chainId: 11155111,
    protocol: 'railgun',
    deployment: 'archived-sepolia',
  };
  let scope,
    ledger,
    source,
    session,
    coordinator,
    crashPhase = null;
  const applications = [];
  async function open(create) {
    scope = createPrivacyScope({
      profileId: 'coordinated-public-history',
      signal: new AbortController().signal,
    });
    const rpcHandle = scope.getContext({ ...subject, role: 'protocol-rpc' }),
      engineHandle = scope.getContext({ ...subject, role: 'engine' });
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
    catalog = await createRailgunWalletCatalog({
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
    });
    if (create) generation = await catalog.begin(policy);
    else if ((await catalog.inspect()).pending) generation = await catalog.resume();
    else generation = null;
    walletDirectory = generation?.directory ?? catalog.activeFor(policy).directory;
  }
  async function close() {
    catalog?.close();
    coordinator?.close();
    source?.close();
    ledger?.close();
    session?.close();
    scope?.close();
    await Promise.all([ledger?.closed, session?.closed]);
  }
  const sources = [
    'scripts/qualify-railgun-wallet-journal.js',
    'src/main/wallet/railgun-wallet-catalog.js',
    'src/main/wallet/railgun-wallet-coverage.js',
    'src/main/wallet/railgun-wallet-coverage-store.js',
    'src/main/wallet/railgun-wallet-journal.js',
    'src/main/wallet/railgun-wallet-runner.js',
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
  const walletId = sha(
    Buffer.from(require('./fixtures/railgun-wallet-snapshot-job').shared, 'hex')
  );
  const { createRailgunWalletRunner } = require('../src/main/wallet/railgun-wallet-runner');
  const {
    createRailgunWalletCoverageStore,
  } = require('../src/main/wallet/railgun-wallet-coverage-store');
  const { createRailgunWalletJournal } = require('../src/main/wallet/railgun-wallet-journal');
  const policy = sha('wallet-policy-fixture-v1\0' + JSON.stringify(sourceSha256));
  const runner = createRailgunWalletRunner({
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
      if (stage !== 20) await coordinator.advance({ to: stage, anchor: capture.report.anchor });
      if (previousEvidence) assert.throws(() => coordinator.assertSnapshot(previousEvidence));
      for (const attempt of stage === 10
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
            create: (stage === 10 && attempt === 'interrupt') || attempt === 'rebuild',
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
          create: (stage === 10 && attempt === 'interrupt') || attempt === 'rebuild',
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
        await assert.rejects(coverageStore.read(checked.value.receipt));
        assert.throws(() => walletJournal.assertReady());
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
    assert.equal(applications.length, 3);
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
          walletCoverageGranted: true,
          receiptReplayRefused: true,
          durableJournal: true,
          generationSwap: true,
          retainedGenerations: retainedDirectories.length,
          spendableGranted: false,
          submissions: 0,
          anchor: capture.report.anchor,
          logSetSha256: capture.logSetSha256,
          requests,
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
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
