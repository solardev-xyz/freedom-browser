/** Offline historical-prefix qualification using the pinned public capture.
 * Real encrypted worker, runner and guarded engine; public fixture key 89 only.
 * No enrollment, host TXID journal, live service acceptance or account authority.
 * electron script CAPTURE_DIRECTORY ENGINE_ASAR NEW_OUTPUT_DIRECTORY
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const sha = (value) => createHash('sha256').update(value).digest('hex');
const CAPTURE_SHA = '11d37888b487780c69bb237e33486a569e00e5732818871ac2c7c74ca35f610b';
const INDICES = Object.freeze([
  0, 1, 2, 3, 15, 16, 63, 64, 99, 100, 127, 128, 255, 256, 1023, 1024, 4095, 4096, 4187, 4188, 4229,
]);
const SOURCES = [
  'scripts/qualify-railgun-txid-historical.js',
  'scripts/qualify-railgun-txid-storage.js',
  ...[
    'txid-runner',
    'txid-job',
    'txid-projection',
    'txid-policy',
    'txid-journal',
    'txid-root',
    'txid-note-witness',
    'txid-omissions',
    'txid-events',
    'txid-coverage',
    'account-txid',
    'public-services',
    'public-policy',
    'public-run',
    'public-job',
    'event-projector',
    'tree-transactions',
    'scan-journal',
    'scan-coordinator',
    'scan-source',
    'source-ledger',
    'source-feed',
    'engine-runtime',
    'process',
    'process-entry',
    'process-guards',
    'session-worker',
    'session-worker-entry',
    'session',
    'store',
    'store-cursor',
    'paged-store',
    'remote',
    'wallet-state',
    'public-records',
    'frontier',
  ].map((name) => 'src/main/wallet/railgun-' + name + '.js'),
  ...['txid-projection', 'txid-job', 'txid-runner', 'account-txid', 'txid-policy', 'process'].map(
    (name) => 'src/main/wallet/railgun-' + name + '.test.js'
  ),
  'src/main/wallet/railgun-engine-manifest.json',
  'src/main/networks/privacy-context.js',
];
let phase = 'setup';
async function main() {
  const [capture, archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  assert.ok([capture, archive, output].every((value) => path.isAbsolute(value)));
  assert.equal(fs.existsSync(output), false);
  fs.mkdirSync(output, { mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const started = performance.now();
  const captureBytes = fs.readFileSync(path.join(capture, 'report.json'));
  assert.equal(sha(captureBytes), CAPTURE_SHA);
  const source = JSON.parse(captureBytes);
  assert.equal(source.passed, true);
  assert.equal(source.publicQueriesOnly, true);
  assert.equal(source.checkpoint.index, 4229);
  assert.equal(source.pages.length, 43);
  const rows = [];
  for (let n = 0; n < source.pages.length; n++) {
    const page = source.pages[n];
    assert.equal(page.filename, String(n).padStart(5, '0') + '.json');
    const bytes = fs.readFileSync(path.join(capture, page.filename));
    assert.ok(bytes.length <= 1024 * 1024);
    assert.equal(sha(bytes), page.sha256);
    const input = JSON.parse(bytes);
    assert.ok(Array.isArray(input.transactions));
    assert.equal(input.transactions.length, page.count);
    assert.ok(page.count > 0 && page.count <= 100);
    rows.push(...input.transactions);
  }
  assert.equal(rows.length, 4230);
  assert.equal(new Set(SOURCES).size, SOURCES.length);
  const hashes = () =>
    Object.fromEntries(
      SOURCES.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    );
  const sourceSha256 = hashes();
  const { createPrivacyScope, getPrivacyContext } = require('../src/main/networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'public-txid-historical-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-txid-fixture',
    chainId: 11155111,
    protocol: 'railgun',
    deployment: 'sepolia',
    role: 'engine',
  });
  const policy = require('../src/main/wallet/railgun-txid-policy').getRailgunTxidPolicy(archive);
  const filename = path.join(output, 'txid-' + policy + '.sqlite');
  // Install before importing the runner, which captures this factory.
  assert.equal(require.cache[require.resolve('../src/main/wallet/railgun-txid-runner')], undefined);
  const processModule = require('../src/main/wallet/railgun-process');
  const originalStart = processModule.startRailgunProcess;
  const jobs = { inspect: 0, project: 0, apply: 0, historical: 0, exited: 0, unexpected: 0 };
  const guards = { reports: 0, attempts: 0, canaryChecks: 0, hooks: [] };
  const tasks = new Set(),
    recordCache = new Map(),
    savedRoots = new Map();
  let worker,
    runner,
    storeId,
    current,
    scenario,
    pendingRun,
    rpcAttempts = 0;
  const field = (value) =>
    typeof value === 'string' &&
    /^[0-9a-f]{64}$/.test(value) &&
    BigInt('0x' + value) <
      21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const changedField = (value) =>
    value === '0'.repeat(64) ? '0'.repeat(63) + '1' : '0'.repeat(64);
  const observeGuards = (value) => {
    assert.deepEqual(Object.keys(value).sort(), ['attempts', 'canaries', 'hooks']);
    assert.equal(value.attempts, 0);
    assert.ok(Array.isArray(value.hooks) && value.hooks.length > 0 && value.hooks.length <= 256);
    assert.ok(
      value.hooks.every((hook) => typeof hook === 'string' && /^[a-zA-Z0-9_.]{1,128}$/.test(hook))
    );
    assert.equal(new Set(value.hooks).size, value.hooks.length);
    assert.equal(value.canaries, value.hooks.length);
    guards.reports++;
    guards.attempts += value.attempts;
    guards.canaryChecks += value.canaries;
    guards.hooks = [...new Set([...guards.hooks, ...value.hooks])].sort();
  };
  const pathKeys = (index) => {
    const keys = [];
    let cursor = index;
    for (let level = 0; level < 16; level++) {
      const sibling = cursor ^ 1;
      if (sibling * 2 ** level < current.count) keys.push(`txid:node:${level}:${sibling}`);
      cursor = Math.floor(cursor / 2);
    }
    return keys;
  };
  const checkHistorical = (value, index) => {
    assert.deepEqual(
      Object.keys(value).sort(),
      [
        'version',
        'tree',
        'index',
        'root',
        'checkpointIndex',
        'checkpointRoot',
        'transcript',
        'localPrefixComputed',
        'globalTxidCompleteness',
        'ownershipVerified',
        'eventCoverageVerified',
        'rootAccepted',
        'spendingEnabled',
      ].sort()
    );
    assert.equal(value.version, 1);
    assert.equal(value.tree, 0);
    assert.equal(value.index, index);
    assert.ok(field(value.root));
    assert.equal(value.root, savedRoots.get(index));
    assert.equal(value.checkpointIndex, current.count - 1);
    assert.equal(value.checkpointRoot, current.root);
    assert.equal(value.transcript, current.transcript);
    assert.equal(value.localPrefixComputed, true);
    for (const key of [
      'globalTxidCompleteness',
      'ownershipVerified',
      'eventCoverageVerified',
      'rootAccepted',
      'spendingEnabled',
    ])
      assert.equal(value[key], false);
  };
  processModule.startRailgunProcess = (options) => {
    const input = JSON.parse(options.input);
    const historical = input.mode === 'historical-root';
    if (!['inspect', 'project', 'apply', 'historical-root'].includes(input.mode)) {
      jobs.unexpected++;
      throw Error('Unexpected fixture utility');
    }
    jobs[historical ? 'historical' : input.mode]++;
    assert.equal(options.filename, require.resolve('../src/main/wallet/railgun-txid-job'));
    assert.deepEqual(input, { archive, mode: input.mode });
    assert.equal(options.archive, archive);
    assert.ok(!options.binaryKey);
    const context = getPrivacyContext(options.handle);
    assert.equal(context.subject.kind, 'private-account');
    assert.equal(context.subject.principal, 'public-txid-fixture');
    assert.equal(context.subject.chainId, 11155111);
    assert.equal(context.subject.protocol, 'railgun');
    assert.equal(context.subject.deployment, 'sepolia');
    assert.equal(context.subject.role, 'engine');
    assert.equal(context.subject.operation, 'txid-' + input.mode);
    assert.equal(options.startupMs, 120000);
    assert.equal(options.lifetimeMs, 180000);
    const run = historical ? scenario : undefined;
    if (historical) assert.ok(run);
    const originalBroker = options.broker;
    let resultSeen = false,
      sequence = 0;
    const keys = historical ? ['txid:state', 'txid:row:' + run.index] : [];
    const jobStart = performance.now();
    const task = originalStart({
      ...options,
      broker: {
        signal: originalBroker.signal,
        async dispatch(wire) {
          if (historical) run.attempted++;
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 2 * 1024 * 1024);
          const message = JSON.parse(wire);
          if (historical) {
            assert.equal(message.id, ++sequence);
            assert.equal(resultSeen, false);
            if (!['input', 'get', 'result'].includes(message.method)) {
              run.forbidden++;
              throw Error('Unexpected historical broker method');
            }
            run[message.method]++;
            if (message.method === 'input') {
              assert.deepEqual(message, { id: 1, method: 'input' });
              const reply = JSON.parse(await originalBroker.dispatch(wire));
              assert.deepEqual(reply, { id: 1, value: { state: current, index: run.index } });
              if (run.fault === 'wrong-checkpoint') {
                reply.value.state.root = changedField(reply.value.state.root);
                run.injections++;
              }
              run.admitted++;
              return JSON.stringify(reply);
            }
            if (message.method === 'get') {
              assert.ok(run.get <= keys.length);
              const key = keys[run.get - 1];
              assert.deepEqual(message, {
                id: sequence,
                method: 'get',
                args: { key: Buffer.from(key).toString('base64') },
              });
              const reply = JSON.parse(await originalBroker.dispatch(wire));
              assert.deepEqual(Object.keys(reply).sort(), ['id', 'value']);
              assert.equal(reply.id, sequence);
              assert.equal(typeof reply.value, 'string');
              const decoded = Buffer.from(reply.value, 'base64').toString('utf8');
              if (run.get === 1) assert.deepEqual(JSON.parse(decoded), current);
              if (run.get === 2) {
                const record = JSON.parse(decoded);
                assert.deepEqual(record.row, rows[run.index]);
                assert.equal(record.rowSha256, sha(JSON.stringify(record.row)));
                assert.ok(field(record.leaf) && field(record.railgunTxid));
                recordCache.set(run.index, decoded);
                const effectiveIndex = run.fault === 'wrong-index' ? 2 : run.index;
                let effective = record;
                if (run.fault === 'wrong-index') {
                  assert.equal(run.index, 1);
                  assert.ok(recordCache.has(2));
                  const other = recordCache.get(2);
                  effective = JSON.parse(other);
                  assert.notEqual(effective.railgunTxid, record.railgunTxid);
                  reply.value = Buffer.from(other).toString('base64');
                  run.injections++;
                } else if (run.fault === 'modified-row') {
                  record.leaf = changedField(record.leaf);
                  reply.value = Buffer.from(JSON.stringify(record)).toString('base64');
                  run.injections++;
                }
                keys.push(
                  'txid:lookup:' + effective.railgunTxid,
                  'txid:row:' + effectiveIndex,
                  ...pathKeys(effectiveIndex)
                );
              } else if (run.get === 3) {
                assert.equal(decoded, String(run.fault === 'wrong-index' ? 2 : run.index));
              } else if (run.get === 4) {
                assert.equal(decoded, recordCache.get(run.fault === 'wrong-index' ? 2 : run.index));
              } else if (run.get > 4) {
                assert.ok(field(decoded));
              }
              const target =
                run.fault === 'modified-right-sibling'
                  ? 'txid:node:0:1'
                  : run.fault === 'modified-left-sibling'
                    ? 'txid:node:0:0'
                    : null;
              if (key === target) {
                reply.value = Buffer.from(changedField(decoded)).toString('base64');
                run.injections++;
              }
              run.admitted++;
              return JSON.stringify(reply);
            }
            assert.equal(run.get, keys.length);
            assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
            assert.deepEqual(Object.keys(message.value).sort(), [
              'guards',
              'historicalRoot',
              'inventory',
            ]);
            checkHistorical(message.value.historicalRoot, run.index);
          }
          if (message.method === 'result') {
            assert.equal(resultSeen, false);
            resultSeen = true;
            assert.equal(
              message.value.inventory,
              require('../src/main/wallet/railgun-engine-manifest.json').inventory.sha256
            );
            observeGuards(message.value.guards);
          }
          const reply = await originalBroker.dispatch(wire);
          if (historical) {
            assert.deepEqual(JSON.parse(reply), { id: message.id, value: null });
            run.admitted++;
            run.resultAdmissions++;
          }
          return reply;
        },
      },
    });
    tasks.add(task);
    task.closed.then((exit) => {
      jobs.exited++;
      tasks.delete(task);
      if (historical) {
        run.exits++;
        run.exitCode = exit.code;
        run.elapsedMs = Math.ceil(performance.now() - jobStart);
        run.peakRssBytes = exit.peakRssBytes;
        run.rssMeasurement =
          exit.peakRssBytes > 0 ? 'sampled-peak' : 'no-positive-sample-before-exit';
      }
    });
    return task;
  };
  const close = async () => {
    runner?.close();
    worker?.close();
    await Promise.allSettled(
      [...tasks].map((task) => {
        task.close();
        return task.closed;
      })
    );
    if (pendingRun) await pendingRun.catch(() => {});
    if (worker) await worker.closed;
  };
  const open = async (create) => {
    worker = require('../src/main/wallet/railgun-session-worker').startRailgunSessionWorker({
      handle,
      storage: {
        filename,
        format: 'paged-v2',
        key: Buffer.alloc(32, 89),
        binding: '8'.repeat(64),
        create,
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          rpcAttempts++;
          throw Error('Offline fixture forbids RPC');
        },
      }),
      onClose: () => {},
    });
    await worker.ready;
    const identity = await worker.inspectStoreIdentity();
    worker.assertFresh(identity);
    if (storeId) assert.equal(identity.instanceId, storeId);
    storeId = identity.instanceId;
    runner = require('../src/main/wallet/railgun-txid-runner').createRailgunTxidRunner({
      handle,
      archive,
      session: worker,
      filename,
      binding: '8'.repeat(64),
      policy,
    });
  };
  const execute = async (mode, payload) => {
    assert.equal(pendingRun, undefined);
    const ownedRunner = runner;
    pendingRun = ownedRunner.run(mode, payload);
    try {
      const result = await pendingRun;
      assert.deepEqual(ownedRunner.assertResult(result.receipt, mode, payload), result.value);
      return result;
    } finally {
      pendingRun = undefined;
    }
  };
  const positive = [],
    negatives = [],
    recoveries = [],
    batches = [];
  let baselineObservation, baselineBytes;
  const unchanged = async () => {
    const inspected = await execute('inspect', {});
    assert.deepEqual(inspected.value.state, current);
    const observed = await worker.inspectWalletState();
    worker.assertFresh(observed);
    assert.deepEqual(observed, baselineObservation);
  };
  const historical = async (index, fault = 'healthy') => {
    assert.equal(scenario, undefined);
    const run = {
      index,
      fault,
      attempted: 0,
      admitted: 0,
      input: 0,
      get: 0,
      result: 0,
      resultAdmissions: 0,
      forbidden: 0,
      injections: 0,
      exits: 0,
    };
    scenario = run;
    const beforeGuards = guards.reports;
    let outcome, error;
    try {
      outcome = await execute('historical-root', { state: current, index });
    } catch (caught) {
      error = caught;
    } finally {
      scenario = undefined;
    }
    assert.equal(run.exits, 1);
    assert.equal(run.forbidden, 0);
    assert.equal(run.input, 1);
    assert.equal(run.attempted, run.input + run.get + run.result);
    assert.equal(run.admitted, run.attempted);
    assert.ok(Number.isSafeInteger(run.elapsedMs) && run.elapsedMs >= 0);
    assert.ok(Number.isSafeInteger(run.peakRssBytes) && run.peakRssBytes >= 0);
    const effectiveIndex = fault === 'wrong-index' ? 2 : index;
    const expectedGets =
      fault === 'wrong-checkpoint'
        ? 1
        : fault === 'modified-row'
          ? 2
          : 4 + pathKeys(effectiveIndex).length;
    assert.equal(run.get, expectedGets);
    if (fault === 'healthy') {
      assert.equal(error, undefined);
      checkHistorical(outcome.value.historicalRoot, index);
      assert.equal(run.exitCode, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(run.result, 1);
      assert.equal(run.resultAdmissions, 1);
      assert.equal(run.injections, 0);
      assert.equal(guards.reports - beforeGuards, 1);
      assert.ok(run.peakRssBytes > 0);
      return { ...run, matchedSavedAppendCheckpoint: true, actualExitObserved: true };
    }
    assert.equal(outcome, undefined);
    assert.equal(error?.code, 'RAILGUN_TXID_JOB_REFUSED');
    assert.equal(run.exitCode, 'RAILGUN_PROCESS_FAILED');
    assert.equal(run.result, 0);
    assert.equal(run.resultAdmissions, 0);
    assert.equal(run.injections, 1);
    assert.equal(guards.reports - beforeGuards, 0);
    return { ...run, refused: true, actualExitObserved: true, guardReportAvailable: false };
  };
  try {
    phase = 'build';
    await open(true);
    current = (await execute('inspect', {})).value.state;
    assert.equal(current.count, 0);
    for (const index of INDICES) {
      while (current.count <= index) {
        const end = Math.min(current.count + 100, index + 1);
        const page = rows.slice(current.count, end),
          base = current;
        assert.ok(page.length > 0 && page.length <= 100);
        const projected = await execute('project', { base, rows: page });
        const applied = await execute('apply', {
          base,
          rows: page,
          expected: projected.value.state,
        });
        assert.deepEqual(applied.value.state, projected.value.state);
        current = applied.value.state;
        batches.push({ count: page.length, throughIndex: current.count - 1 });
      }
      // This root comes from append/project/apply, before historicalRoot is ever invoked.
      assert.equal(current.count, index + 1);
      savedRoots.set(index, current.root);
    }
    assert.equal(current.count, 4230);
    assert.equal(current.root, source.checkpoint.root);
    assert.equal(current.breaks.length, 1);
    assert.equal(current.breaks[0].index, 4188);
    assert.equal(savedRoots.get(4187), current.breaks[0].precedingRoot);
    assert.equal(new Set(savedRoots.values()).size, INDICES.length);
    assert.equal(
      batches.reduce((sum, batch) => sum + batch.count, 0),
      4230
    );
    baselineObservation = await worker.inspectWalletState();
    worker.assertFresh(baselineObservation);
    await close();
    baselineBytes = sha(fs.readFileSync(filename));
    phase = 'cold-reopen';
    await open(false);
    await unchanged();
    for (const index of INDICES) {
      phase = 'historical-' + index;
      const result = await historical(index);
      assert.equal(savedRoots.get(index) === current.root, index === 4229);
      positive.push({ ...result, historicalRootDiffersFromCurrent: index !== 4229 });
    }
    await unchanged();
    await close();
    assert.equal(sha(fs.readFileSync(filename)), baselineBytes);
    for (const [fault, index] of [
      ['wrong-checkpoint', 0],
      ['modified-right-sibling', 0],
      ['modified-left-sibling', 1],
      ['modified-row', 1],
      ['wrong-index', 1],
    ]) {
      phase = fault;
      await open(false);
      await unchanged();
      const result = await historical(index, fault);
      await close();
      assert.equal(sha(fs.readFileSync(filename)), baselineBytes);
      phase = 'recover-' + fault;
      await open(false);
      await unchanged();
      const recovered = await historical(index);
      await unchanged();
      await close();
      assert.equal(sha(fs.readFileSync(filename)), baselineBytes);
      negatives.push({ ...result, encryptedBytesUnchanged: true, healthyReopen: true });
      recoveries.push({ ...recovered, afterFault: fault, encryptedBytesUnchanged: true });
    }
    phase = 'report';
    assert.equal(positive.length, 21);
    assert.equal(negatives.length, 5);
    assert.equal(recoveries.length, 5);
    assert.equal(jobs.historical, 31);
    assert.equal(jobs.project, batches.length);
    assert.equal(jobs.apply, batches.length);
    assert.equal(jobs.exited, jobs.inspect + jobs.project + jobs.apply + jobs.historical);
    assert.equal(jobs.unexpected, 0);
    assert.equal(tasks.size, 0);
    assert.equal(rpcAttempts, 0);
    assert.equal(guards.attempts, 0);
    assert.equal(guards.reports, jobs.exited - negatives.length);
    assert.equal(fs.readFileSync(filename).includes(Buffer.from(rows[0].graphID)), false);
    assert.deepEqual(hashes(), sourceSha256);
    const report = {
      fixture: 'offline-public-txid-historical-prefix',
      passed: true,
      elapsedMs: Math.round(performance.now() - started),
      sourceSha256,
      captureSha256: CAPTURE_SHA,
      capturedRows: 4230,
      savedCheckpointIndices: INDICES,
      buildBatches: batches,
      positive,
      negatives,
      recoveries,
      jobs,
      guards,
      rpcAttempts,
      realPinnedEngine: true,
      realEncryptedWorkerAndRunner: true,
      publicFixtureStorageKeyByte: 89,
      checkpointsSavedBeforeHistoricalComputation: true,
      coldWorkerReopen: true,
      knownServiceOmissionIndex: 4188,
      knownBreakPreserved: true,
      encryptedBytesUnchangedAfterReads: true,
      noFaultWrites: true,
      hostJournalQualified: false,
      enrolledAccountStorageQualified: false,
      accountPhaseWrapperQualified: false,
      liveRootAcceptanceQualified: false,
      historicalPublicationAuthenticated: false,
      globalTxidCompleteness: false,
      sourceCoverageVerified: false,
      ownershipVerified: false,
      rootAccepted: false,
      spendingEnabled: false,
      disclosureEnabled: false,
      liveQueries: 0,
      accountsOpened: 0,
      submissions: 0,
      guardScope: 'utility guards and counted denied fixture RPC; not OS egress tracing',
      failedUtilitiesHaveNoGuardReport: true,
    };
    assert.doesNotMatch(
      JSON.stringify(report),
      /"(?:root|checkpointRoot|transcript|row|railgunTxid|leaf|key|storeId)"\s*:/
    );
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        passed: true,
        historicalJobs: 31,
        sourceFiles: SOURCES.length,
        liveQueries: 0,
      })
    );
  } finally {
    try {
      await close();
    } finally {
      processModule.startRailgunProcess = originalStart;
      scope.close();
    }
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    const match = String(error?.stack ?? '').match(/qualify-railgun-txid-historical\.js:(\d+):\d+/);
    console.error(
      JSON.stringify({
        phase,
        code: /^[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'REFUSED',
        ...(match ? { line: Number(match[1]) } : {}),
      })
    );
    app.exit(1);
  }
);
