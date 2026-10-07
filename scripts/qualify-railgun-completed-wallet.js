/** Offline completed-only wallet restoration over a genuinely enrolled scan.
 * electron script SOURCE NEW_DIRECTORY ENGINE ARTIFACTS BYTECODES
 * Public vector, simulated wire/Tor endpoints; no funded profile or live RPC.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const { isDeepStrictEqual } = require('util');
const { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const OFFSET = 5944700;
let lock,
  phase = 'setup';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function bounded(work, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Fixture wait exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function tree(directory) {
  return fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const filename = path.join(directory, name),
        stat = fs.lstatSync(filename);
      assert.equal(stat.isSymbolicLink(), false);
      return [name, stat.isDirectory() ? tree(filename) : fs.readFileSync(filename)];
    });
}
function sourceInventory() {
  const root = path.join(__dirname, '..');
  const files = [
    __filename,
    ...[
      'profile-lock.js',
      'profile-resolver.js',
      'settings-store.js',
      'swarm/ant-cache.js',
      'tor-manager.js',
    ].map((name) => path.join(root, 'src/main', name)),
    ...['scripts/fixtures', 'src/main/wallet', 'src/main/networks', 'src/main/identity'].flatMap(
      (relative) => {
        const directory = path.join(root, relative);
        return fs
          .readdirSync(directory)
          .filter((name) => /\.(js|json)$/.test(name))
          .map((name) => path.join(directory, name));
      }
    ),
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES.map((name) =>
      path.join(root, name)
    ),
  ];
  return Object.fromEntries(
    [...new Set(files)]
      .sort()
      .map((file) => [path.relative(root, file), sha(fs.readFileSync(file))])
  );
}
async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 5);
  assert.ok(args.every((value) => path.isAbsolute(value)));
  const [sourceFilename, directory, archive, artifactDirectory, bytecodes] = args;
  assert.equal(fs.existsSync(directory), false);
  const sourceBytes = fs.readFileSync(sourceFilename);
  assert.equal(
    sha(sourceBytes),
    'bfa8684f50b2bb838b026f2c4972653bfc4503d9fd15182c6c5b219ce1bc1e41'
  );
  const source = JSON.parse(sourceBytes);
  assert.equal(source.publicVaultVector, true);
  for (const log of source.logs) {
    log.blockNumber += OFFSET;
    log.blockHash = hex(log.blockNumber + 1000);
  }
  const anchor = { number: OFFSET + 100, hash: hex(OFFSET + 1100) };
  fs.mkdirSync(directory, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const sourceHashes = sourceInventory();
  const runtime = require('../src/main/wallet/railgun-process');
  const sessions = require('../src/main/wallet/railgun-session-worker');
  const coverage = require('../src/main/wallet/railgun-wallet-coverage-store');
  const originalStart = runtime.startRailgunProcess,
    originalSession = sessions.startRailgunSessionWorker,
    originalReadOnlySession = sessions.startRailgunReadOnlySessionWorker,
    originalCoverage = coverage.createRailgunCompletedWalletCoverageStore;
  const children = new Set(),
    workers = new Set(),
    loans = [],
    childResults = [];
  const counters = {
    childStarts: 0,
    childExits: 0,
    storageStarts: 0,
    readOnlyStorageStarts: 0,
    completedCoverageStarts: 0,
    storageExits: 0,
    viewingKeys: 0,
    forbiddenKeys: 0,
    forbiddenJobs: 0,
    forbiddenRpc: 0,
    interruptedWalletStarts: 0,
  };
  const rpcMethods = {},
    jobs = {};
  let qualification = false,
    interruptWallet = false,
    wireGate = null;
  coverage.createRailgunCompletedWalletCoverageStore = (options) => {
    const result = originalCoverage(options);
    counters.completedCoverageStarts++;
    for (const name of ['beginEngine', 'finishEngine', 'write'])
      assert.equal(Object.hasOwn(result, name), false);
    return result;
  };
  runtime.startRailgunProcess = (options) => {
    const job = path.basename(options.filename);
    if (qualification && !['railgun-public-job.js', 'railgun-wallet-job.js'].includes(job)) {
      counters.forbiddenJobs++;
      throw Error('Unexpected completed-wallet utility');
    }
    if (interruptWallet && job === 'railgun-wallet-job.js') {
      interruptWallet = false;
      counters.interruptedWalletStarts++;
      // Ordinary advance has already awaited the genuine journal.prepare.
      // Refuse before launching the wallet utility; no synthetic journal write.
      throw Error('Fixture interruption after durable wallet prepare');
    }
    const broker = options.broker;
    counters.childStarts++;
    jobs[job] = (jobs[job] || 0) + 1;
    const task = originalStart({
      ...options,
      ...(broker
        ? {
            broker: {
              ...broker,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                if (qualification && message.method === 'key') {
                  if (message.purpose !== 'wallet-viewing') {
                    counters.forbiddenKeys++;
                    throw Error('Unexpected completed-wallet key purpose');
                  }
                }
                const reply = await broker.dispatch(wire);
                if (message.method === 'key' && message.purpose === 'wallet-viewing') {
                  counters.viewingKeys++;
                  assert.ok(Buffer.isBuffer(reply));
                  loans.push(reply);
                }
                return reply;
              },
            },
          }
        : {}),
    });
    children.add(task);
    task.closed.then((value) => {
      children.delete(task);
      counters.childExits++;
      childResults.push({ job, ...value });
    });
    return task;
  };
  const trackedSession =
    (start, readOnly = false) =>
    (options) => {
      counters.storageStarts++;
      if (readOnly) counters.readOnlyStorageStarts++;
      const worker = start(options);
      workers.add(worker);
      worker.closed.then(() => {
        workers.delete(worker);
        counters.storageExits++;
      });
      return worker;
    };
  sessions.startRailgunSessionWorker = trackedSession(originalSession);
  sessions.startRailgunReadOnlySessionWorker = trackedSession(originalReadOnlySession, true);
  const services = require('./fixtures/railgun-partial-controller-services').install({
    bytecodes,
    artifactDirectory,
    source,
    anchor,
  });
  const transport = require('../src/main/networks/wallet-tor-transport');
  const serviceTransport = transport.createWalletTorTransport;
  const { getPrivacyContext } = require('../src/main/networks/privacy-context');
  transport.createWalletTorTransport = (...options) => {
    const client = serviceTransport(...options);
    return {
      ...client,
      async request(handle, url, request) {
        const { subject } = getPrivacyContext(handle),
          wire = JSON.parse(request.body);
        const method = subject.role + ':' + wire.method;
        rpcMethods[method] = (rpcMethods[method] || 0) + 1;
        if (qualification) {
          if (
            subject.role !== 'protocol-rpc' ||
            subject.operation !== null ||
            !['eth_chainId', 'eth_getBlockByNumber', 'eth_getLogs'].includes(wire.method)
          ) {
            counters.forbiddenRpc++;
            throw Error('Unexpected completed-wallet RPC');
          }
        }
        const result = await client.request(handle, url, request);
        if (wireGate && subject.role === 'protocol-rpc' && wire.method === 'eth_getBlockByNumber') {
          const gate = wireGate;
          wireGate = null;
          gate.entered.resolve();
          await gate.release.promise;
        }
        return result;
      },
    };
  };
  const vault = require('../src/main/identity/vault');
  let identity, enrollment, publicAccount, account;
  const scenarios = [],
    started = performance.now();
  try {
    phase = 'enroll';
    const vaultDirectory = path.join(directory, 'profile', 'identity');
    await vault.importVault(
      vaultDirectory,
      'public-fixture-password-not-a-user-credential',
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    await vault.unlockVault(vaultDirectory, 'public-fixture-password-not-a-user-credential', 0);
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive,
    });
    enrollment =
      await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment({
        identity,
        create: true,
      });
    const publicApi = require('../src/main/wallet/railgun-account-public');
    publicAccount = await publicApi.openRailgunAccountPublic({ enrollment, archive, create: true });
    phase = 'public-scan';
    const initialTo = anchor.number - 1;
    for (let from = 0; from <= initialTo; from += 100000)
      await publicAccount.advance({ to: Math.min(from + 99999, initialTo), anchor });
    const wallet = require('../src/main/wallet/railgun-account-wallet');
    const owners = { identity, enrollment, coordinator: publicAccount.coordinator };
    const destination = publicApi.getRailgunAccountPublicDestination(
      owners.coordinator,
      enrollment
    );
    const marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
    const snapshot = () => ({
      account: tree(enrollment.directory),
      inventory: fs.readFileSync(marker),
    });
    const activity = () => ({ ...counters, rpc: { ...rpcMethods } });
    const countRpc = (value) => Object.values(value).reduce((sum, count) => sum + count, 0);
    const completedOptions = { ...owners, archive, destination };
    async function measured(name, use, { queries = 'zero', viewing = 0, storage } = {}) {
      phase = name;
      const before = snapshot(),
        beforeActivity = activity(),
        liveWorkers = workers.size,
        liveChildren = children.size;
      const begin = performance.now();
      await use();
      assert.ok(isDeepStrictEqual(snapshot(), before), 'Account bytes or inventory changed');
      assert.equal(workers.size, liveWorkers);
      assert.equal(children.size, liveChildren);
      assert.ok(loans.every((key) => key.every((byte) => byte === 0)));
      const after = activity();
      const delta = Object.fromEntries(
        Object.keys(counters).map((key) => [key, after[key] - beforeActivity[key]])
      );
      delta.rpc = countRpc(after.rpc) - countRpc(beforeActivity.rpc);
      delta.rpcMethods = Object.fromEntries(
        Object.entries(after.rpc)
          .map(([method, count]) => [method, count - (beforeActivity.rpc[method] ?? 0)])
          .filter(([, count]) => count > 0)
      );
      assert.equal(delta.viewingKeys, viewing);
      assert.equal(delta.forbiddenKeys, 0);
      assert.equal(delta.forbiddenJobs, 0);
      assert.equal(delta.forbiddenRpc, 0);
      assert.equal(delta.childStarts, delta.childExits);
      assert.equal(delta.readOnlyStorageStarts, delta.storageStarts);
      assert.equal(delta.storageStarts, delta.storageExits);
      if (storage !== undefined) assert.equal(delta.storageStarts, storage);
      if (queries === 'zero') assert.equal(delta.rpc, 0);
      else assert.ok(delta.rpc > 0);
      scenarios.push({
        name,
        ...delta,
        bytesAndInventoryUnchanged: true,
        observedChildrenAndWorkersDrained: true,
        elapsedMs: Math.round(performance.now() - begin),
      });
    }
    const refuse = (options) => assert.rejects(wallet.openRailgunCompletedAccountWallet(options));
    qualification = true;
    await measured('missing-active-wallet', () => refuse(completedOptions), { storage: 0 });
    qualification = false;
    const beforeWalletInventory = fs.readFileSync(marker);
    phase = 'ordinary-wallet-scan';
    account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'new' });
    const expected = wallet.readRailgunAccountOwnedNotes(account, owners);
    assert.ok(expected.read.received.length > 0);
    assert.ok(expected.ownedPoi.some((record) => record.type === 'Shield'));
    const generation = enrollment.catalog.activeFor(
      wallet.getRailgunAccountWalletPolicy({ archive, enrollment, coordinator: owners.coordinator })
    );
    const walletFile = path.join(generation.directory, 'wallet.sqlite');
    await account.close();
    account = null;
    qualification = true;
    const controller = new AbortController();
    controller.abort();
    await measured(
      'pre-aborted',
      () => refuse({ ...completedOptions, signal: controller.signal }),
      { storage: 0 }
    );
    await measured('expired-startup-budget', () => refuse({ ...completedOptions, timeoutMs: 1 }));
    await measured(
      'copied-destination',
      () => refuse({ ...completedOptions, destination: { ...destination } }),
      { storage: 0 }
    );
    await measured('wrong-policy', () => refuse({ ...completedOptions, policy: 'f'.repeat(64) }), {
      storage: 0,
    });
    fs.renameSync(walletFile, walletFile + '.preserved');
    try {
      await measured('missing-registered-wallet', () => refuse(completedOptions), { storage: 0 });
    } finally {
      fs.renameSync(walletFile + '.preserved', walletFile);
    }
    const registeredInventory = fs.readFileSync(marker);
    fs.writeFileSync(marker, beforeWalletInventory);
    try {
      await measured('existing-unregistered-wallet', () => refuse(completedOptions), {
        storage: 0,
      });
    } finally {
      fs.writeFileSync(marker, registeredInventory);
    }
    await measured(
      'completed-open-and-two-restores',
      async () => {
        account = await wallet.openRailgunCompletedAccountWallet(completedOptions);
        assert.ok(
          isDeepStrictEqual(wallet.readRailgunAccountOwnedNotes(account, owners), expected),
          'Owned read changed'
        );
        for (let n = 0; n < 2; n++) {
          await wallet.restoreRailgunAccountWallet(account, owners);
          assert.ok(
            isDeepStrictEqual(wallet.readRailgunAccountOwnedNotes(account, owners), expected),
            'Owned read changed'
          );
        }
        await account.close();
        account = null;
      },
      { queries: 'positive', viewing: 3, storage: 1 }
    );
    await measured(
      'cancel-held-completed-response',
      async () => {
        const caller = new AbortController(),
          gate = { entered: deferred(), release: deferred() };
        wireGate = gate;
        let settled = false;
        const opening = wallet
          .openRailgunCompletedAccountWallet({ ...completedOptions, signal: caller.signal })
          .then(
            (value) => {
              account = value;
              settled = true;
              return { value };
            },
            (error) => {
              settled = true;
              return { error };
            }
          );
        let controlError;
        try {
          await bounded(gate.entered.promise);
          caller.abort();
          for (let n = 0; n < 20; n++) await new Promise((resolve) => setImmediate(resolve));
          assert.equal(settled, false);
          const { claimRailgunAccountPhase } = require('../src/main/wallet/railgun-account-phase');
          let unexpectedPhase;
          try {
            assert.throws(() => {
              unexpectedPhase = claimRailgunAccountPhase(enrollment, 'recovery');
            });
          } finally {
            unexpectedPhase?.release();
          }
        } catch (error) {
          controlError = error;
        } finally {
          caller.abort();
          gate.release.resolve();
          wireGate = null;
        }
        const outcome = await bounded(opening);
        if (controlError) throw controlError;
        assert.ok(outcome.error);
        assert.equal(account, null);
        assert.equal(owners.coordinator.signal.aborted, false);
      },
      { queries: 'positive', storage: 1 }
    );
    await measured(
      'healthy-reuse-after-cancel',
      async () => {
        account = await wallet.openRailgunCompletedAccountWallet(completedOptions);
        assert.ok(
          isDeepStrictEqual(wallet.readRailgunAccountOwnedNotes(account, owners), expected),
          'Owned read changed'
        );
        await account.close();
        account = null;
      },
      { queries: 'positive', viewing: 1, storage: 1 }
    );
    phase = 'explicit-public-advance';
    await publicAccount.advance({ to: anchor.number, anchor });
    await measured('stale-wallet-checkpoint', () => refuse(completedOptions), {
      queries: 'positive',
      storage: 1,
    });
    phase = 'interrupt-ordinary-wallet-advance';
    interruptWallet = true;
    const interruptedBefore = counters.interruptedWalletStarts;
    await assert.rejects(wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'advance' }));
    assert.equal(counters.interruptedWalletStarts - interruptedBefore, 1);
    assert.equal(interruptWallet, false);
    // Ordinary snapshot failure closes its coordinator. Reopen the genuine
    // same public generation before testing the wallet journal boundary.
    await publicAccount.close();
    publicAccount = await publicApi.openRailgunAccountPublic({ enrollment, archive });
    owners.coordinator = publicAccount.coordinator;
    completedOptions.coordinator = owners.coordinator;
    completedOptions.destination = publicApi.getRailgunAccountPublicDestination(
      owners.coordinator,
      enrollment
    );
    assert.equal(owners.coordinator.signal.aborted, false);
    // Authenticate the actual journal left by ordinary prepare, using the
    // enrollment's borrowed key. Do not modify it or issue a recovery receipt.
    const journalHandle = enrollment.getContext(
      'storage',
      'railgun-wallet-v1:' + enrollment.descriptor.walletId
    );
    const journalState = await enrollment.withGenerationKeys(generation.id, async (keys) => {
      const storage = require('../src/main/wallet/privacy-storage').createPrivacyStorage({
        handle: journalHandle,
        directory: generation.directory,
        key: keys['wallet-journal'],
        profileGuard: {
          assert: (file) => enrollment.profileGuard.assertRegistered(file),
          remember: (file) => enrollment.profileGuard.assertRegistered(file),
        },
      });
      return JSON.parse(await storage.get('railgun-wallet-journal-v1'));
    });
    assert.ok(journalState.pending && journalState.checkpoint);
    await measured('genuine-pending-wallet-journal', () => refuse(completedOptions), {
      storage: 1,
    });
    assert.equal(counters.forbiddenKeys, 0);
    assert.equal(counters.forbiddenJobs, 0);
    assert.equal(counters.forbiddenRpc, 0);
    const forbidden = services.report();
    for (const key of [
      'poiRequests',
      'selectedNullifierQueries',
      'deploymentRequests',
      'eoaRequests',
      'publicServiceRequests',
    ])
      assert.equal(forbidden[key], 0);
    assert.deepEqual(forbidden.privatePreflightMethods, {
      rootHistory: 0,
      unshieldFee: 0,
      getVerificationKey: 0,
      nullifiers: 0,
    });
    await publicAccount.close();
    publicAccount = null;
    enrollment.close();
    enrollment = null;
    identity.close();
    identity = null;
    vault.lockVault();
    assert.equal(children.size, 0);
    assert.equal(workers.size, 0);
    assert.ok(loans.every((key) => key.every((byte) => byte === 0)));
    await services.close();
    assert.equal(services.report().pendingRequests, 0);
    assert.equal(services.report().unexpectedTransportFailures, 0);
    assert.equal(services.report().transportCreates, services.report().transportCloses);
    assert.deepEqual(sourceInventory(), sourceHashes);
    const report = {
      schema: 'railgun-completed-wallet-offline-v1',
      sourceSha256: sha(sourceBytes),
      sourceHashes,
      enrolledPublicVector: true,
      actualPublicScanAndWalletGeneration: true,
      syntheticWireAndTorEndpoint: true,
      liveServicesQualified: false,
      spendingQualified: false,
      completedOnlyRestoration: true,
      fixedReadOnlyStorageFactoryObserved: true,
      fixedCompletedCoverageFactoryObserved: true,
      osReadOnlyClaim: false,
      snapshotScope: 'entire-account-directory-and-profile-inventory-bytes-and-filenames',
      inventoryReplayControl: 'genuine-pre-wallet-marker-replay-not-rollback-protection',
      pendingControl:
        'ordinary-journal-prepare-then-wallet-launch-refusal-and-genuine-public-owner-reopen',
      cancellationControl: 'held-simulated-RPC-response-logical-drain-not-physical-socket',
      newProcessRestartQualified: false,
      viewingLoansWiped: true,
      counters,
      rpcMethods,
      jobs,
      childResults,
      scenarios,
      services: services.report(),
      elapsedMs: Math.round(performance.now() - started),
    };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        status: 'qualified',
        scenarios: scenarios.length,
        elapsedMs: report.elapsedMs,
      })
    );
  } finally {
    wireGate?.release.resolve();
    await account?.close();
    await publicAccount?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    for (const child of children) child.close();
    for (const worker of workers) worker.close();
    await Promise.all([...children, ...workers].map((resource) => resource.closed));
    await services.close();
    runtime.startRailgunProcess = originalStart;
    sessions.startRailgunSessionWorker = originalSession;
    sessions.startRailgunReadOnlySessionWorker = originalReadOnlySession;
    coverage.createRailgunCompletedWalletCoverageStore = originalCoverage;
    if (!fs.existsSync(path.join(directory, 'report.json')))
      fs.writeFileSync(
        path.join(directory, 'diagnostic.json'),
        JSON.stringify(
          {
            phase,
            counters,
            rpcMethods,
            jobs,
            childResults,
            scenarios,
            services: services.report(),
          },
          null,
          2
        ) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
  }
}
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ phase, code: 'QUALIFIER_WATCHDOG' }));
  releaseProfileLock(lock);
  app.exit(1);
}, 240000);
main().then(
  () => {
    clearTimeout(watchdog);
    releaseProfileLock(lock);
    app.exit(0);
  },
  (error) => {
    clearTimeout(watchdog);
    console.error(
      JSON.stringify({ phase, code: error.code, message: error.message, stack: error.stack })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
