/** Offline third-process original-proof submission with synthetic external services. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('./fixtures/railgun-native-assertions').assert;
const fixtureChecks = require('./fixtures/railgun-native-assertions');
const { createHash } = require('crypto');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const canonicalHash = (value) => sha(JSON.stringify(value));
let lock,
  phase = 'preflight';
async function bounded(work, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('Fixture drain timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function readJson(filename, max = 4 * 1024 * 1024) {
  const stat = fs.lstatSync(filename);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && stat.size <= max);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function snapshot(directory) {
  const out = {};
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name),
        stat = fs.lstatSync(file),
        relative = path.relative(directory, file);
      assert.equal(stat.isSymbolicLink(), false);
      if (stat.isDirectory()) {
        out[relative + '/'] = 'directory';
        visit(file);
      } else {
        assert.ok(stat.isFile());
        out[relative] = sha(fs.readFileSync(file));
      }
    }
  };
  visit(directory);
  return out;
}
async function main() {
  const args = process.argv.slice(2);
  assert.equal(args.length, 9);
  const [
    sourceFilename,
    directory,
    archive,
    proverArchive,
    artifactDirectory,
    bytecodes,
    inputCreator,
    kind,
    testCase,
  ] = args;
  assert.ok(args.slice(0, 6).every(path.isAbsolute));
  assert.ok(['Shield', 'Transact'].includes(inputCreator));
  assert.ok(['transfer', 'unshield', 'partial'].includes(kind));
  assert.ok(['acknowledged', 'lost-response'].includes(testCase));
  assert.equal(fs.realpathSync(directory), directory);
  assert.equal(fs.lstatSync(directory).isSymbolicLink(), false);
  const handoff = readJson(path.join(directory, 'cold-submission-handoff.json'));
  assert.deepEqual(
    Object.keys(handoff).sort(),
    [
      'schema',
      'runID',
      'setupPID',
      'recoveryPID',
      'inputCreator',
      'kind',
      'historyMode',
      'sourceSha256',
      'sourceHashes',
      'runtimeHashes',
      'publicIdentity',
      'checkpoint',
      'originalCheckpoint',
      'rootTransition',
      'submissionBackend',
      'recordHashes',
      'transactionDigest',
      'accountFiles',
      'inventoryHash',
      'recoveryReportSha256',
      'metadataSha256',
      'cleanlyDrainedAndProfileReleased',
    ].sort()
  );
  assert.deepEqual(Object.keys(handoff.submissionBackend).sort(), [
    'originalRoot',
    'record',
    'submitter',
  ]);
  assert.deepEqual(
    Object.keys(handoff.recordHashes).sort(),
    ['entry', 'stored', 'capsule', 'signature', 'provedTransaction'].sort()
  );
  assert.match(
    handoff.runID,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  for (const digest of Object.values(handoff.recordHashes)) assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(handoff.schema, 'railgun-cold-submission-handoff-v1');
  assert.equal(handoff.inputCreator, inputCreator);
  assert.equal(handoff.kind, kind);
  assert.equal(handoff.cleanlyDrainedAndProfileReleased, true);
  for (const pid of [handoff.setupPID, handoff.recoveryPID]) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
    assert.throws(
      () => process.kill(pid, 0),
      (error) => error.code === 'ESRCH'
    );
  }
  assert.notEqual(handoff.setupPID, handoff.recoveryPID);
  assert.equal(
    sha(fs.readFileSync(path.join(directory, 'resume-report.json'))),
    handoff.recoveryReportSha256
  );
  const priorReport = readJson(path.join(directory, 'resume-report.json'));
  assert.equal(priorReport.runID, handoff.runID);
  assert.equal(priorReport.resumePID, handoff.recoveryPID);
  assert.equal(priorReport.recovery.status, 'proof-stored');
  const root = path.join(__dirname, '..');
  const verifyPriorSources = () => {
    for (const [relative, digest] of Object.entries(handoff.sourceHashes)) {
      assert.ok(!path.isAbsolute(relative) && !relative.split(path.sep).includes('..'));
      assert.equal(sha(fs.readFileSync(path.join(root, relative))), digest, relative);
    }
  };
  verifyPriorSources();
  const originalFs = require('original-fs');
  // Runtime inventory format is frozen by the existing proof-recovery qualifier.
  const runtimeHashes = {
    engine: sha(originalFs.readFileSync(archive)),
    prover: sha(originalFs.readFileSync(proverArchive)),
  };
  assert.equal(sha(fs.readFileSync(bytecodes)), handoff.runtimeHashes.bytecodes);
  for (const [name, digest] of Object.entries(handoff.runtimeHashes.artifacts)) {
    assert.match(name, /^01x0[12]\.(wasm|zkey|vkey)$/);
    assert.equal(sha(fs.readFileSync(path.join(artifactDirectory, name))), digest);
  }
  assert.equal(runtimeHashes.engine, handoff.runtimeHashes.engine);
  assert.equal(runtimeHashes.prover, handoff.runtimeHashes.prover);
  const sourceBytes = fs.readFileSync(sourceFilename);
  assert.equal(sha(sourceBytes), handoff.sourceSha256);
  const { source, anchor } = require('./fixtures/railgun-cold-submission-source').derive(
    sourceBytes,
    inputCreator,
    handoff.historyMode
  );
  const reportFile = path.join(directory, 'cold-submission-' + testCase + '-report.json');
  assert.equal(fs.existsSync(reportFile), false);
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(directory, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const runtime = require('../src/main/wallet/railgun-process'),
    originalStart = runtime.startRailgunProcess;
  const sessions = require('../src/main/wallet/railgun-session-worker'),
    originalSession = sessions.startRailgunSessionWorker,
    originalReadonly = sessions.startRailgunReadOnlySessionWorker;
  const storage = require('../src/main/wallet/privacy-storage'),
    originalStorage = storage.createPrivacyStorage;
  const COLD_RECORDS = [
    'railgun-wallet-catalog-v1',
    'railgun-public-catalog-v1',
    'freedom-railgun-host-scan-v1',
    'railgun-private-reservations-v1',
    'railgun-private-capsules-v1',
    'railgun-private-reservations-floor-v1',
    'railgun-private-capsules-floor-v1',
  ];
  const storageWrites = [];
  let authenticatedPublicCheckpoint, journalFilename, txidJournalFilename, authenticatedJournal;
  storage.createPrivacyStorage = (options) => {
    const genuine = originalStorage(options),
      filename = storage.getPrivacyStoragePath(options.handle, options.directory);
    const observe = (name, previous, next) => {
      if (phase === 'cold-bootstrap') {
        assert.ok(COLD_RECORDS.includes(name), 'Unexpected cold record');
        assert.equal(
          storageWrites.filter((write) => write.record === name).length,
          0,
          'Repeated cold record'
        );
        assert.notEqual(previous, null);
        const old = JSON.parse(previous),
          value = JSON.parse(next);
        const mutable = ['railgun-wallet-catalog-v1', 'railgun-public-catalog-v1'].includes(name)
          ? ['lease', 'sequence']
          : name === 'freedom-railgun-host-scan-v1'
            ? ['lease', 'sequence', 'generation']
            : ['railgun-private-reservations-v1', 'railgun-private-capsules-v1'].includes(name)
              ? ['lease']
              : [];
        const strip = (record) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.includes(key)));
        assert.deepEqual(strip(value), strip(old));
        if (mutable.includes('lease')) assert.notEqual(value.lease, old.lease);
        if (mutable.includes('sequence')) assert.equal(value.sequence, old.sequence + 1);
        if (mutable.includes('generation')) assert.equal(value.generation, old.generation + 1);
        if (name === 'freedom-railgun-host-scan-v1') {
          assert.equal(value.pending, null);
          assert.deepEqual(value.checkpoint, handoff.checkpoint);
          authenticatedPublicCheckpoint = structuredClone(value.checkpoint);
        }
        return { phase, filename, record: name, mutableFields: mutable };
      }
      if (name === 'freedom-railgun-txid-v1') {
        assert.equal(inputCreator, 'Transact');
        assert.notEqual(previous, null);
        assert.equal(
          storageWrites.filter((write) => write.record === name && write.phase === phase).length,
          0,
          'One TXID constructor per host invocation'
        );
        txidJournalFilename ??= filename;
        assert.equal(filename, txidJournalFilename);
        assert.ok(fs.existsSync(filename));
        assert.ok(
          path
            .relative(path.join(profile.userDataDir, 'wallet-railgun-accounts'), filename)
            .match(/^account-[0-9a-f]{64}\/railgun-public-[0-9a-f]{64}\/[0-9a-f]{64}\.json$/)
        );
        const old = JSON.parse(previous),
          value = JSON.parse(next),
          mutable = ['lease', 'sequence', 'generation'];
        const strip = (record) =>
          Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.includes(key)));
        assert.deepEqual(strip(value), strip(old));
        assert.equal(value.pending, null);
        assert.ok(value.checkpoint);
        assert.notEqual(value.lease, old.lease);
        assert.equal(value.sequence, old.sequence + 1);
        assert.equal(value.generation, old.generation + 1);
        return {
          phase,
          filename,
          record: name,
          mutableFields: mutable,
          beforeSequence: old.sequence,
          afterSequence: value.sequence,
          beforeGeneration: old.generation,
          afterGeneration: value.generation,
          checkpointAndOtherFieldsUnchanged: true,
        };
      }
      assert.equal(name, 'submissions-v1', 'Host may only write EOA journal');
      assert.equal(
        path.dirname(filename),
        path.join(profile.userDataDir, 'wallet-private-submissions')
      );
      journalFilename ??= filename;
      assert.equal(filename, journalFilename);
      assert.equal(phase, 'cold-submit');
      assert.notEqual(previous, null);
      const old = JSON.parse(previous),
        value = JSON.parse(next);
      assert.deepEqual(old, authenticatedJournal);
      assert.deepEqual(Object.keys(value).sort(), ['archive', 'records', 'version']);
      assert.equal(value.version, 4);
      assert.deepEqual(value.archive, []);
      assert.equal(value.records.length, 1);
      const writes = storageWrites.filter((write) => write.record === name);
      if (writes.length === 0) {
        assert.deepEqual(old, { version: 4, records: [], archive: [] });
        assert.deepEqual(Object.keys(value.records[0]).sort(), [
          'attemptedAt',
          'hash',
          'intent',
          'nonce',
          'state',
        ]);
        assert.equal(value.records[0].state, 'attempted');
        assert.equal(value.records[0].nonce, 0);
        assert.ok(Number.isSafeInteger(value.records[0].attemptedAt));
      } else {
        assert.equal(testCase, 'acknowledged');
        assert.equal(writes.length, 1);
        assert.deepEqual(value, {
          ...old,
          records: [{ ...old.records[0], state: 'submitted' }],
        });
      }
      authenticatedJournal = structuredClone(value);
      return {
        phase,
        filename,
        record: name,
        previousPresent: previous !== null,
        recordCount: value.records.length,
      };
    };
    return Object.freeze({
      ...genuine,
      async get(name) {
        const value = await genuine.get(name);
        if (name === 'submissions-v1') {
          assert.equal(filename, journalFilename);
          assert.notEqual(value, null);
          const parsed = JSON.parse(value);
          if (authenticatedJournal === undefined) {
            assert.equal(phase, 'journal-baseline');
            assert.deepEqual(parsed, { version: 4, records: [], archive: [] });
            authenticatedJournal = structuredClone(parsed);
          } else assert.deepEqual(parsed, authenticatedJournal);
        }
        return value;
      },
      async update(name, change) {
        let observation;
        await genuine.update(name, (previous) => {
          const next = change(previous);
          observation = observe(name, previous, next);
          return next;
        });
        storageWrites.push(observation);
      },
      async set(name, value) {
        assert.fail('Unobserved direct set outside expected journal/update path');
        return genuine.set(name, value);
      },
    });
  };
  let finalRootFaultArmed = false,
    privateIntentAttempts = 0;
  const jobs = {},
    keys = {},
    events = [],
    children = new Set(),
    workers = new Set(),
    childResults = [],
    workerResults = [],
    loans = [];
  const trackWorker = (start, readOnly) => (options) => {
    const launched = phase;
    events.push({ type: 'worker-start', phase: launched, readOnly, at: performance.now() });
    const worker = start(options);
    workers.add(worker);
    fixtureChecks.observeClosed(
      worker.closed,
      (result) => {
        workers.delete(worker);
        workerResults.push({ phase: launched, readOnly, ...result });
        events.push({ type: 'worker-exit', phase: launched, readOnly, at: performance.now() });
      },
      'worker.closed'
    );
    return worker;
  };
  sessions.startRailgunSessionWorker = trackWorker(originalSession, false);
  sessions.startRailgunReadOnlySessionWorker = trackWorker(originalReadonly, true);
  runtime.startRailgunProcess = (options) => {
    const job = path.basename(options.filename),
      launched = phase,
      broker = options.broker;
    jobs[job] = (jobs[job] || 0) + 1;
    assert.ok(
      ![
        'railgun-spend-sign-job.js',
        'railgun-private-operate-job.js',
        'railgun-private-recover-job.js',
      ].includes(job),
      'No new private signing or proof regeneration in submission process'
    );
    if (job === 'railgun-wallet-job.js') {
      const input = JSON.parse(options.input);
      assert.deepEqual(input.checkpoint, handoff.checkpoint);
      assert.ok(input.restore);
      assert.equal(input.privateIntent, undefined);
      assert.equal(input.privateOperation, undefined);
      assert.equal(input.privateRecovery, undefined);
    }
    if (job === 'railgun-private-verify-job.js') {
      assert.ok(immutableOriginal);
      const input = JSON.parse(options.input);
      assert.deepEqual(input.intent, immutableOriginal.stored.capsule.preparation.transaction);
      assert.deepEqual(input.transaction, immutableOriginal.stored.provedTransaction);
      assert.deepEqual(input.expected, immutableOriginal.stored.capsule.preparation.expected);
    }
    events.push({ type: 'child-start', job, phase: launched, at: performance.now() });
    const task = originalStart({
      ...options,
      ...(broker
        ? {
            broker: {
              ...broker,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                if (message.method === 'private-intent') privateIntentAttempts++;
                assert.notEqual(message.method, 'private-intent');
                if (message.method === 'key') {
                  keys[message.purpose] = (keys[message.purpose] || 0) + 1;
                  assert.notEqual(message.purpose, 'spending-sign');
                }
                const reply = await broker.dispatch(wire);
                if (message.method === 'key') {
                  assert.ok(reply instanceof Uint8Array && reply.length === 32);
                  loans.push(reply);
                }
                if (message.method === 'result' && message.value?.guards) {
                  const guard = message.value.guards;
                  assert.equal(guard.attempts, 0);
                  assert.ok(guard.hooks.length > 0);
                  assert.equal(guard.canaries, guard.hooks.length);
                }
                return reply;
              },
            },
          }
        : {}),
    });
    children.add(task);
    fixtureChecks.observeClosed(
      task.closed,
      (result) => {
        children.delete(task);
        childResults.push({ phase: launched, job, ...result });
        if (finalRootFaultArmed && job === 'railgun-poi-job.js') {
          assert.equal(result.code, 'RAILGUN_PROCESS_CLOSED');
          finalRootFaultArmed = false;
          services.setMode('bad-txid-root');
        }
        events.push({ type: 'child-exit', phase: launched, job, at: performance.now() });
      },
      'child.closed'
    );
    return task;
  };
  const services = require('./fixtures/railgun-partial-controller-services').install({
    bytecodes,
    artifactDirectory,
    source,
    anchor,
    perHandlePoi: true,
  });
  const eoa = require('./fixtures/railgun-cold-submission-eoa').install({
    testCase,
    endpoint: 'https://synthetic.invalid/railgun-partial-controller',
  });
  const vault = require('../src/main/identity/vault');
  let identity, enrollment, publicAccount, reservations, capsules, immutableOriginal;
  const metrics = () => ({
    jobs: { ...jobs },
    keys: { ...keys },
    services: services.report(),
    privateIntentAttempts,
    fixtureViolations: fixtureChecks.report(),
    eoa: eoa.report(),
  });
  const started = performance.now();
  try {
    phase = 'cold-bootstrap';
    const accountBase = path.join(profile.userDataDir, 'wallet-railgun-accounts'),
      marker = path.join(profile.userDataDir, 'wallet-privacy-inventory.json');
    assert.deepEqual(snapshot(accountBase), handoff.accountFiles);
    assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
    await vault.unlockVault(
      path.join(profile.userDataDir, 'identity'),
      'public-fixture-password-not-a-user-credential',
      0
    );
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive,
    });
    enrollment =
      await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment({
        identity,
        create: false,
      });
    const publicApi = require('../src/main/wallet/railgun-account-public');
    publicAccount = await publicApi.openRailgunAccountPublic({
      enrollment,
      archive,
      create: false,
    });
    assert.deepEqual(
      publicApi.getRailgunAccountPublicIdentity(publicAccount.coordinator, enrollment),
      handoff.publicIdentity
    );
    const destination = publicApi.getRailgunAccountPublicDestination(
      publicAccount.coordinator,
      enrollment
    );
    ({ reservations, capsules } = await enrollment.openPrivateRecoveryStores());
    const inspect = () =>
      reservations.withSigningRecovery(async (records, context) => {
        context.assertCurrent();
        assert.equal(records.length, 1);
        assert.equal(records[0].entry.state, 'signing');
        const stored = await capsules.readSigned(records[0].receipt);
        context.assertCurrent();
        return { entry: records[0].entry, stored };
      });
    const original = await inspect();
    immutableOriginal = original;
    for (const [name, value] of Object.entries({
      entry: original.entry,
      stored: original.stored,
      capsule: original.stored.capsule,
      signature: original.stored.signature,
      provedTransaction: original.stored.provedTransaction,
    }))
      assert.equal(canonicalHash(value), handoff.recordHashes[name], name);
    const matched =
      require('../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
        original.stored.capsule.preparation.transaction,
        original.stored.provedTransaction,
        original.stored.capsule.preparation.expected
      );
    assert.equal(matched.digest, handoff.transactionDigest);
    assert.equal(
      original.stored.capsule.preparation.expected.merkleRoot,
      handoff.submissionBackend.originalRoot
    );
    if (handoff.historyMode === 'advanced-root') {
      const tree = Number(handoff.submissionBackend.record.id.split(':')[0]);
      assert.notEqual(
        handoff.checkpoint.state.trees.find((value) => value.tree === tree).root,
        handoff.submissionBackend.originalRoot
      );
    }
    fixtureChecks.assertEmpty();
    assert.deepEqual(authenticatedPublicCheckpoint, handoff.checkpoint);
    const coldFiles = snapshot(accountBase);
    assert.deepEqual(Object.keys(coldFiles), Object.keys(handoff.accountFiles));
    const coldChanged = Object.keys(coldFiles).filter(
      (name) => coldFiles[name] !== handoff.accountFiles[name]
    );
    assert.deepEqual(storageWrites.map((write) => write.record).sort(), [...COLD_RECORDS].sort());
    const coldObserved = [
      ...new Set(storageWrites.map((write) => path.relative(accountBase, write.filename))),
    ].sort();
    assert.equal(coldObserved.length, 6);
    assert.deepEqual(coldChanged.sort(), coldObserved);
    assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
    const metadata = path.join(profile.userDataDir, 'identity', 'vault-meta.json');
    assert.equal(sha(fs.readFileSync(metadata)), handoff.metadataSha256);
    const markerBefore = readJson(marker),
      eoaDirectory = path.join(profile.userDataDir, 'wallet-private-submissions');
    const journalBaseline = snapshot(eoaDirectory);
    const journalNames = Object.keys(journalBaseline);
    assert.equal(journalNames.length, 1);
    assert.match(journalNames[0], /^[0-9a-f]{64}\.json$/);
    journalFilename = path.join(eoaDirectory, journalNames[0]);
    assert.ok(
      markerBefore.state.files.includes(path.relative(profile.userDataDir, journalFilename))
    );
    const afterBootstrapWriteOffset = storageWrites.length;
    phase = 'journal-baseline';
    const {
      createPrivacyScope,
      getPrivacyContext,
    } = require('../src/main/networks/privacy-context');
    const journalScope = createPrivacyScope({
      profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
      signal: vault.getSessionSignal(),
    });
    try {
      const handle = journalScope.getContext({
        kind: 'public-address',
        principal: handoff.submissionBackend.submitter,
        chainId: 11155111,
        role: 'transaction-rpc',
      });
      const history = await require('../src/main/wallet/private-submission-journal')
        .getPrivateSubmissionJournal(handle)
        .readSnapshot();
      assert.deepEqual(history, { records: [], archive: [] });
      assert.deepEqual(authenticatedJournal, { version: 4, records: [], archive: [] });
    } finally {
      journalScope.close();
    }
    const assertOriginalJournalBytes = () => {
      assert.deepEqual(snapshot(eoaDirectory), journalBaseline);
      assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
      assert.equal(storageWrites.filter((write) => write.record === 'submissions-v1').length, 0);
    };
    assertOriginalJournalBytes();
    phase = 'backend-fixture';
    const backendBefore = metrics();
    if (inputCreator === 'Transact') await services.initializeTxid({ archive, enrollment });
    await services.setSelected({
      archive,
      enrollment,
      record: handoff.submissionBackend.record,
      merkleRoot: handoff.submissionBackend.originalRoot,
      submitter: handoff.submissionBackend.submitter,
    });
    assert.deepEqual(keys, backendBefore.keys);
    eoa.configure({
      owner: handoff.submissionBackend.submitter,
      transaction: original.stored.provedTransaction,
    });
    const topLevelEntries = () =>
      fs
        .readdirSync(profile.userDataDir)
        .sort()
        .map((name) => {
          const stat = fs.lstatSync(path.join(profile.userDataDir, name));
          return {
            name,
            kind: stat.isDirectory()
              ? 'directory'
              : stat.isFile()
                ? 'file'
                : stat.isSymbolicLink()
                  ? 'symlink'
                  : 'other',
          };
        });
    // Both snapshots are after Electron/profile/identity/bootstrap and before lock release.
    // Only top-level names/types are covered outside the separately byte-checked stores.
    const topLevelBefore = topLevelEntries();
    assert.ok(
      topLevelBefore.some(
        (entry) => entry.name === 'wallet-private-submissions' && entry.kind === 'directory'
      )
    );
    const bootstrap = metrics();
    const host =
      require('../src/main/wallet/railgun-private-submission').submitRailgunRecoveredPrivateTransaction;
    assert.equal(typeof host, 'function');
    const invoke = async (options) => {
      try {
        return await host(options);
      } finally {
        fixtureChecks.assertEmpty();
      }
    };
    const common = {
      identity,
      enrollment,
      coordinator: publicAccount.coordinator,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      holdId: original.entry.id,
      gasLimit: 1500000n,
      maxGasFee: 2000000000000000n,
      signal: enrollment.signal,
    };
    const checkDisclosure = (summary, lifetime) => {
      assert.ok(lifetime instanceof AbortSignal && !lifetime.aborted);
      assert.equal(summary.purpose, 'railgun-recovered-private-submission');
      assert.equal(summary.operation, original.stored.capsule.selection.kind);
      assert.equal(summary.submitter, handoff.submissionBackend.submitter);
      assert.equal(summary.originalSpendingSignatureReused, true);
      assert.equal(summary.newSpendingSignature, false);
      assert.equal(summary.automaticRetry, false);
      assert.equal(summary.simulationBeforeTransactionReview, true);
      assert.deepEqual(summary.destinations, {
        retainedSource: 'https://synthetic.invalid/railgun-partial-controller',
        protocolRpc: 'https://synthetic.invalid/railgun-partial-controller',
        transactionRpc: 'https://synthetic.invalid/railgun-partial-controller',
        poi: 'https://ppoi.fdi.network',
        txid: 'https://ppoi.fdi.network',
      });
    };
    const reviewTimings = [];
    const observeFinalReview = (before, mode) => {
      const reviewAt = performance.now();
      const cExit = events
        .filter(
          (event) =>
            event.phase === phase &&
            event.type === 'child-exit' &&
            event.job === 'railgun-private-verify-job.js'
        )
        .at(-1);
      const poiStartWire = services
        .report()
        .requestOrder.slice(before.services.requestOrder.length)
        .find((event) => event.method === 'ppoi_pois_per_list');
      assert.ok(cExit && poiStartWire);
      assert.ok(cExit.at <= poiStartWire.at && poiStartWire.at <= reviewAt);
      const timing = {
        mode,
        cUtilityObservedExitToFinalReviewMs: reviewAt - cExit.at,
        poiAcquisitionToFinalReviewLowerBoundMs: reviewAt - poiStartWire.at,
        poiAcquisitionToFinalReviewUpperBoundMs: reviewAt - cExit.at,
        poiBoundsFromObservedCExitAndFirstWire: true,
        productionReceiptTimestampsReadOrChanged: false,
        reviewOrSigningDeadlineExtendedByFixture: false,
      };
      reviewTimings.push(timing);
      return timing;
    };
    phase = 'denied-disclosure';
    const beforeDenial = metrics();
    let denialReviews = 0;
    const denied = await invoke({
      ...common,
      reviewDisclosures: async (summary, lifetime) => {
        checkDisclosure(summary, lifetime);
        denialReviews++;
        return false;
      },
      reviewTransaction: async () => {
        throw Error('Denied disclosure reached EOA review');
      },
    });
    assert.equal(denialReviews, 1);
    assert.deepEqual(denied, { status: 'recovery-required', stage: 'disclosure-review' });
    const afterDenial = metrics();
    assert.deepEqual(afterDenial.jobs, beforeDenial.jobs);
    assert.deepEqual(afterDenial.keys, beforeDenial.keys);
    assert.equal(afterDenial.eoa.entries, beforeDenial.eoa.entries);
    assert.equal(afterDenial.services.transportEntries, beforeDenial.services.transportEntries);
    assert.equal(afterDenial.eoa.addressAttempts, beforeDenial.eoa.addressAttempts);
    assert.equal(afterDenial.eoa.signatureAttempts, 0);
    assert.equal(afterDenial.eoa.sends, 0);
    assert.deepEqual(await inspect(), original);
    assertOriginalJournalBytes();
    const delta = (after, before) =>
      Object.fromEntries(
        Object.entries(after)
          .map(([key, value]) => [key, value - (before[key] || 0)])
          .filter(([, value]) => value !== 0)
      );
    const assertPipeline = (after, before, mode) => {
      const expectedJobs = {
        'railgun-public-job.js': 2,
        'railgun-wallet-job.js': 1,
        'railgun-private-verify-job.js': 1,
        ...(inputCreator === 'Transact'
          ? { 'railgun-txid-job.js': 3, 'railgun-note-provenance-job.js': 1 }
          : {}),
        ...(mode === 'not-valid-poi' ? {} : { 'railgun-poi-job.js': 1 }),
      };
      assert.deepEqual(delta(after.jobs, before.jobs), expectedJobs);
      assert.deepEqual(delta(after.keys, before.keys), { 'wallet-viewing': 1 });
      assert.equal(after.privateIntentAttempts, before.privateIntentAttempts);
      assert.equal(
        storageWrites.filter(
          (write) => write.phase === phase && write.record === 'freedom-railgun-txid-v1'
        ).length,
        inputCreator === 'Transact' ? 1 : 0
      );
    };
    const negatives = [];
    if (
      testCase === 'acknowledged' &&
      handoff.historyMode === 'advanced-root' &&
      ((inputCreator === 'Shield' && kind === 'transfer') ||
        (inputCreator === 'Transact' && kind === 'partial'))
    ) {
      for (const [mode, expectedStage] of [
        ['not-valid-poi', 'membership'],
        ['bad-membership', 'membership'],
        ['wrong-verifier', 'preflight'],
        ['spent-nullifier', 'preflight'],
        ['synthetic-missing-root', 'preflight'],
        ...(inputCreator === 'Transact' ? [['bad-final-txid-root', 'root']] : []),
      ]) {
        phase = 'negative-' + mode;
        finalRootFaultArmed = mode === 'bad-final-txid-root';
        services.setMode(finalRootFaultArmed ? 'healthy' : mode);
        const beforeNegative = metrics();
        let reviews = 0;
        let refused;
        try {
          refused = await invoke({
            ...common,
            reviewDisclosures: async (summary, lifetime) => {
              checkDisclosure(summary, lifetime);
              return true;
            },
            reviewTransaction: async () => {
              reviews++;
              throw Error('Negative gate reached EOA review');
            },
          });
        } finally {
          services.setMode('healthy');
        }
        assert.equal(
          finalRootFaultArmed,
          false,
          'Final root fault must follow actual membership utility exit'
        );
        assert.deepEqual(refused, { status: 'recovery-required', stage: expectedStage });
        assert.equal(reviews, 0);
        const afterNegative = metrics();
        assertPipeline(afterNegative, beforeNegative, mode);
        assert.equal(afterNegative.eoa.signatures, 0);
        assert.equal(afterNegative.eoa.sends, 0);
        assert.deepEqual(await inspect(), original);
        assertOriginalJournalBytes();
        if (mode === 'wrong-verifier')
          assert.equal(
            afterNegative.services.selectedNullifierQueries,
            beforeNegative.services.selectedNullifierQueries
          );
        negatives.push({
          mode,
          refused,
          before: beforeNegative,
          after: afterNegative,
          syntheticFalseOrUnknownHistoryOnly: mode === 'synthetic-missing-root',
        });
      }
    }
    if (
      inputCreator === 'Transact' &&
      kind === 'partial' &&
      testCase === 'acknowledged' &&
      handoff.historyMode === 'advanced-root'
    ) {
      phase = 'held-expired-review';
      let releaseReview,
        enterReview,
        settled = false;
      const entered = new Promise((resolve) => {
        enterReview = resolve;
      });
      const released = new Promise((resolve) => {
        releaseReview = resolve;
      });
      const prior = metrics();
      let heldResult;
      const held = invoke({
        ...common,
        reviewDisclosures: async (summary, lifetime) => {
          checkDisclosure(summary, lifetime);
          return true;
        },
        reviewTransaction: async () => {
          observeFinalReview(prior, 'held-expired-review');
          enterReview(performance.now());
          await released;
          return true;
        },
      });
      held.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      try {
        const enteredAt = await bounded(entered, 200000);
        assert.equal(eoa.report().signatures, 0);
        assert.equal(eoa.report().sends, 0);
        let competingInvocations = 0;
        const competing = () =>
          reservations.withSigningRecovery(async () => {
            competingInvocations++;
          });
        await assert.rejects(competing());
        assert.equal(competingInvocations, 0);
        await new Promise((resolve) => setTimeout(resolve, 32000));
        assert.equal(settled, false, 'Original callback must retain host recovery until released');
        await assert.rejects(competing());
        assert.equal(competingInvocations, 0);
        await new Promise((resolve) => setTimeout(resolve, 30000));
        assert.ok(performance.now() - enteredAt >= 61000);
        assert.equal(eoa.report().signatures, 0);
        assert.equal(eoa.report().sends, 0);
      } finally {
        releaseReview();
        heldResult = await bounded(held);
      }
      const refused = heldResult;
      assertPipeline(metrics(), prior, 'held-review');
      assert.deepEqual(refused, { status: 'recovery-required', stage: 'submission' });
      assert.deepEqual(await inspect(), original);
      assertOriginalJournalBytes();
      negatives.push({
        mode: 'held-review-past-review-and-source-lifetimes',
        refused,
        before: prior,
        after: metrics(),
        realElapsedOver61Seconds: true,
        lateTrueRefused: true,
        actualRecoveryExcludedUntilCallbackDrained: true,
        sourceExpiryIndependentlyIsolated: false,
      });
    }
    phase = 'cold-submit';
    const before = metrics();
    let disclosureReviews = 0,
      transactionReviews = 0,
      reviewTiming;
    const result = await invoke({
      ...common,
      reviewDisclosures: async (summary, lifetime) => {
        checkDisclosure(summary, lifetime);
        disclosureReviews++;
        return true;
      },
      reviewTransaction: async (request) => {
        transactionReviews++;
        reviewTiming = observeFinalReview(before, 'healthy');
        const observed = eoa.report();
        assert.equal(
          observed.methods.eth_estimateGas,
          (before.eoa.methods.eth_estimateGas || 0) + 1
        );
        assert.equal(observed.methods.eth_call, (before.eoa.methods.eth_call || 0) + 1);
        assert.equal(observed.signatureAttempts, 0);
        assert.equal(observed.sends, 0);
        assert.equal(request.transaction.data, original.stored.provedTransaction.data);
        return true;
      },
    });
    const after = metrics();
    assertPipeline(after, before, 'healthy');
    assert.equal(disclosureReviews, 1);
    assert.equal(transactionReviews, 1);
    assert.equal(after.eoa.signatures, 1);
    assert.equal(after.eoa.sends, 1);
    assert.equal(after.eoa.journalBeforeSend, 1);
    assert.equal(after.eoa.unexpectedFailures, 0);
    assert.equal(after.eoa.controlledLostReplies, testCase === 'lost-response' ? 1 : 0);
    if (testCase === 'lost-response') {
      assert.equal(result.submissionStatus, 'unknown');
      assert.equal(result.transactionHash, after.eoa.transactionHash);
    } else assert.equal(result.hash, after.eoa.transactionHash);
    assert.deepEqual(await inspect(), original);
    assert.equal(
      (after.jobs['railgun-wallet-job.js'] || 0) - (before.jobs['railgun-wallet-job.js'] || 0),
      1
    );
    assert.equal(
      (after.jobs['railgun-private-verify-job.js'] || 0) -
        (before.jobs['railgun-private-verify-job.js'] || 0),
      1
    );
    assert.equal(
      (after.jobs['railgun-poi-job.js'] || 0) - (before.jobs['railgun-poi-job.js'] || 0),
      1
    );
    assert.equal(
      (after.jobs['railgun-note-provenance-job.js'] || 0) -
        (before.jobs['railgun-note-provenance-job.js'] || 0),
      inputCreator === 'Transact' ? 1 : 0
    );
    assert.equal((after.keys['wallet-viewing'] || 0) - (before.keys['wallet-viewing'] || 0), 1);
    if (inputCreator === 'Shield')
      assert.equal(
        (after.jobs['railgun-txid-job.js'] || 0) - (before.jobs['railgun-txid-job.js'] || 0),
        0
      );
    const hostEvents = events.filter((event) => event.phase === 'cold-submit');
    const position = (type, job) =>
      hostEvents.findIndex((event) => event.type === type && event.job === job);
    assert.ok(position('child-exit', 'railgun-wallet-job.js') >= 0);
    assert.ok(
      position('child-start', 'railgun-private-verify-job.js') >
        position('child-exit', 'railgun-wallet-job.js')
    );
    assert.ok(
      position('child-start', 'railgun-poi-job.js') >
        position('child-exit', 'railgun-private-verify-job.js')
    );
    if (inputCreator === 'Transact') {
      assert.ok(
        position('child-start', 'railgun-note-provenance-job.js') >
          position('child-exit', 'railgun-txid-job.js')
      );
      const poiExit = hostEvents.find(
        (event) => event.type === 'child-exit' && event.job === 'railgun-poi-job.js'
      ).at;
      const finalRoot = after.services.requestOrder
        .slice(before.services.requestOrder.length)
        .filter((event) => event.method === 'ppoi_validate_txid_merkleroot')
        .at(-1);
      assert.ok(finalRoot && finalRoot.at >= poiExit);
    }
    assert.ok(after.services.poiRequests > before.services.poiRequests);
    assert.ok(after.services.signatureChecks > before.services.signatureChecks);
    assert.equal(
      after.services.selectedNullifierQueries - before.services.selectedNullifierQueries,
      1
    );
    assert.deepEqual(
      after.services.verificationKeyVariants.slice(before.services.verificationKeyVariants.length),
      [kind === 'partial' ? '01x02' : '01x01']
    );
    const journalAfterSend = snapshot(eoaDirectory);
    const journalWriteCountAfterSend = storageWrites.filter(
      (write) => write.record === 'submissions-v1'
    ).length;
    phase = 'no-retry';
    const beforeRetry = metrics();
    const duplicate = await invoke({
      ...common,
      reviewDisclosures: async () => {
        throw Error('Duplicate reached disclosure');
      },
      reviewTransaction: async () => {
        throw Error('Duplicate reached EOA review');
      },
    });
    assert.deepEqual(duplicate, { status: 'recovery-required', stage: 'prior-attempt' });
    const afterRetry = metrics();
    assert.deepEqual(afterRetry.jobs, beforeRetry.jobs);
    assert.deepEqual(afterRetry.keys, beforeRetry.keys);
    assert.equal(afterRetry.eoa.entries, beforeRetry.eoa.entries);
    assert.equal(afterRetry.services.transportEntries, beforeRetry.services.transportEntries);
    assert.equal(afterRetry.eoa.signatures, beforeRetry.eoa.signatures);
    assert.equal(afterRetry.eoa.sends, beforeRetry.eoa.sends);
    assert.deepEqual(snapshot(eoaDirectory), journalAfterSend);
    assert.equal(
      storageWrites.filter((write) => write.record === 'submissions-v1').length,
      journalWriteCountAfterSend
    );
    assert.deepEqual(await inspect(), original);
    const assertFinalAccountBytes = () => {
      const currentFiles = snapshot(accountBase);
      assert.deepEqual(Object.keys(currentFiles), Object.keys(coldFiles));
      const changed = Object.keys(coldFiles)
        .filter((name) => currentFiles[name] !== coldFiles[name])
        .sort();
      const allowed =
        inputCreator === 'Transact' ? [path.relative(accountBase, txidJournalFilename)] : [];
      assert.deepEqual(changed, allowed);
      if (inputCreator === 'Transact') assert.ok(!coldObserved.includes(allowed[0]));
      return changed;
    };
    const postBootstrapAccountChanges = assertFinalAccountBytes();
    assert.ok(journalFilename);
    const journalRelative = path.relative(profile.userDataDir, journalFilename);
    const journalFiles = snapshot(eoaDirectory);
    assert.deepEqual(Object.keys(journalFiles), [path.basename(journalFilename)]);
    assert.notEqual(
      journalFiles[path.basename(journalFilename)],
      journalBaseline[path.basename(journalFilename)]
    );
    assert.deepEqual(readJson(marker), markerBefore);
    assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
    const journalWrites = storageWrites.filter((write) => write.record === 'submissions-v1');
    assert.equal(journalWrites.length, testCase === 'acknowledged' ? 2 : 1);
    assert.equal(authenticatedJournal.records[0].hash, after.eoa.transactionHash);
    assert.equal(
      authenticatedJournal.records[0].state,
      testCase === 'acknowledged' ? 'submitted' : 'attempted'
    );
    assert.ok(
      storageWrites
        .slice(afterBootstrapWriteOffset)
        .every(
          (write) =>
            (write.filename === journalFilename && write.record === 'submissions-v1') ||
            (inputCreator === 'Transact' &&
              write.filename === txidJournalFilename &&
              write.record === 'freedom-railgun-txid-v1')
        )
    );
    const diskEvidence = {
      coldRecordUpdates: storageWrites.slice(0, afterBootstrapWriteOffset),
      coldChangedFiles: coldObserved,
      postBootstrapAccountChanges,
      allOtherAccountBytesAndNamesUnchanged: true,
      txidCheckpointOnlyPermitsConstructorLeaseWrites: inputCreator === 'Transact',
      eoaJournalRelativePath: journalRelative,
      existingJournalAuthenticatedEmptyBeforeAdmission: true,
      existingJournalChangedOnlyByBeginAndAcknowledgement: true,
      profileInventoryBytesUnchanged: true,
      eoaJournalBaselineSha256: journalBaseline[path.basename(journalFilename)],
      eoaJournalFinalSha256: journalFiles[path.basename(journalFilename)],
      additionalEoaFloorOrManifest: false,
      hostWrites: storageWrites.slice(afterBootstrapWriteOffset),
    };
    phase = 'close';
    await publicAccount.close();
    publicAccount = null;
    enrollment.close();
    identity.close();
    vault.lockVault();
    await bounded(Promise.all([...children].map((child) => child.closed)));
    await bounded(Promise.all([...workers].map((worker) => worker.closed)));
    assert.equal(children.size, 0);
    assert.equal(workers.size, 0);
    assert.ok(workerResults.every((result) => result.exitCode === 0));
    const expectedUtilityFailures = negatives.some((negative) => negative.mode === 'bad-membership')
      ? [
          {
            phase: 'negative-bad-membership',
            job: 'railgun-poi-job.js',
            code: 'RAILGUN_PROCESS_FAILED',
            exitCode: 1,
            escalated: false,
            peerDisconnected: false,
          },
        ]
      : [];
    assert.deepEqual(
      childResults
        .filter((result) => result.code !== 'RAILGUN_PROCESS_CLOSED')
        .map(({ phase, job, code, exitCode, escalated, peerDisconnected }) => ({
          phase,
          job,
          code,
          exitCode,
          escalated,
          peerDisconnected,
        })),
      expectedUtilityFailures
    );
    assert.ok(
      childResults.every((result) => Number.isInteger(result.exitCode)),
      JSON.stringify(childResults)
    );
    assert.ok(loans.every((key) => key.every((byte) => byte === 0)));
    await eoa.close();
    await services.close();
    assert.equal(services.report().unexpectedTransportFailures, 0);
    verifyPriorSources();
    assertFinalAccountBytes();
    const topLevelAfter = topLevelEntries();
    assert.deepEqual(topLevelAfter, topLevelBefore);
    assert.deepEqual(snapshot(eoaDirectory), journalAfterSend);
    assert.equal(sha(fs.readFileSync(marker)), handoff.inventoryHash);
    assert.equal(sha(fs.readFileSync(metadata)), handoff.metadataSha256);
    fixtureChecks.assertEmpty();
    assert.equal(privateIntentAttempts, 0);
    const report = {
      schema: 'railgun-cold-submission-native-v1',
      runID: handoff.runID,
      setupPID: handoff.setupPID,
      recoveryPID: handoff.recoveryPID,
      submissionPID: process.pid,
      inputCreator,
      kind,
      testCase,
      historyMode: handoff.historyMode,
      rootTransition: handoff.rootTransition,
      bootstrap,
      diskEvidence,
      beforeDenial,
      afterDenial,
      negatives,
      before,
      after,
      beforeRetry,
      afterRetry,
      result,
      duplicate,
      events,
      childResults,
      expectedUtilityFailures,
      workerResults,
      reviewTiming,
      reviewTimings,
      userDataTopLevelEntries: {
        before: topLevelBefore,
        after: topLevelAfter,
        measurement:
          'after Electron/profile/identity/backend bootstrap, before profile-lock release; names and types only',
      },
      submitterMetadataFixtureWritten: true,
      productionMetadataOnboardingQualified: false,
      notNativeQualified: [
        'different-submitter',
        'checkpoint-drift-during-admission',
        'signed-but-no-proof',
        'endpoint-revocation',
        'missing-or-pending-txid-mirror',
        'creator-with-unshield',
      ],
      originalRecordUnchanged: true,
      originalSignatureAndProvedCalldata: true,
      freshLiveServiceAuthorities: true,
      actualWalletJobCheckpointMatchedAuthenticatedHandoff: true,
      fixtureViolations: fixtureChecks.report(),
      privateIntentAttempts,
      publicVectorMetadataHash: handoff.metadataSha256,
      handoffBackendDataCommittedOnlyAsHash: sha(
        fs.readFileSync(path.join(directory, 'cold-submission-handoff.json'))
      ),
      syntheticChainServiceAndBroadcast: true,
      cleanRestartNotPowerLoss: true,
      liveTorOrFundedSubmission: false,
      sourceHashes: handoff.sourceHashes,
      elapsedMs: Math.round(performance.now() - started),
    };
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(JSON.stringify({ status: 'qualified', elapsedMs: report.elapsedMs }));
  } finally {
    try {
      await publicAccount?.close();
    } finally {
      enrollment?.close();
      identity?.close();
      vault.lockVault();
      for (const task of children) task.close();
      for (const worker of workers) worker.close();
      await bounded(Promise.all([...children].map((task) => task.closed)));
      await bounded(Promise.all([...workers].map((worker) => worker.closed)));
      await eoa.close();
      await services.close();
      storage.createPrivacyStorage = originalStorage;
      runtime.startRailgunProcess = originalStart;
      sessions.startRailgunSessionWorker = originalSession;
      sessions.startRailgunReadOnlySessionWorker = originalReadonly;
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
        code: error.code,
        message: error.message,
        stack: error.stack,
        fixtureViolations: fixtureChecks.report(),
      })
    );
    releaseProfileLock(lock);
    app.exit(1);
  }
);
