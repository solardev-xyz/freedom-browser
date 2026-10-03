/** Public-data Node/worker recovery qualification. No wallet keys or transactions. */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { readRailgunLogCapture } = require('./railgun-log-capture-data');
const { createPrivacyScope } = require('../src/main/networks/privacy-context');
const { startRailgunSessionWorker } = require('../src/main/wallet/railgun-session-worker');
let expectedPublicStates;
async function planHistory(input) {
  const { fork } = require('child_process');
  const child = fork(__filename, ['--plan'], {
    env: {},
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--max-old-space-size=256'],
  });
  let result,
    diagnostic = '',
    timer;
  try {
    const closed = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.stderr.on('data', (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-2000);
      });
      child.on('message', (message) => {
        if (
          message?.type !== 'plan' ||
          result ||
          Buffer.byteLength(JSON.stringify(message)) > 256 * 1024
        ) {
          child.kill('SIGKILL');
          return;
        }
        result = message.value;
        child.kill('SIGTERM');
      });
      child.once('close', (code, signal) => resolve({ code, signal }));
      timer = setTimeout(() => child.kill('SIGKILL'), 60000);
      child.send(input);
    });
    await closed;
    assert.ok(result, diagnostic || 'Public planner did not finish');
    assert.equal(result.logSetSha256, input.logSetSha256);
    assert.equal(result.guards.attempts, 0);
    return result;
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
  }
}
async function plannerMain(input) {
  const guards = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
    onRefusal: () => process.exit(2),
  });
  const { preparePublicHistory } = require('./prepare-railgun-public-history');
  const { capture, expectedStates, inventory } = await preparePublicHistory(input, true);
  const report = {
    logSetSha256: capture.logSetSha256,
    captureReportSha256: capture.reportSha256,
    expectedStates,
    inventory: inventory.sha256,
    guards: guards.report(),
    computedBeforeStoreCreation: true,
  };
  assert.equal(report.guards.attempts, 0);
  process.send({ type: 'plan', value: report });
}
async function childMain(input) {
  const guards = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
    onRefusal: () => process.exit(2),
  });
  const pending = new Map();
  process.on('message', (message) => {
    if (message.type !== 'reply') return;
    const id = JSON.parse(message.wire).id,
      resolve = pending.get(id);
    assert.ok(resolve);
    pending.delete(id);
    resolve(message.wire);
  });
  const { run } = require('./fixtures/railgun-history-job');
  const result = await run(JSON.stringify(input), {
    signal: new AbortController().signal,
    guardReport: guards.report,
    request: (wire) =>
      new Promise((resolve) => {
        pending.set(JSON.parse(wire).id, resolve);
        process.send({ type: 'command', wire });
      }),
    progress: (value) =>
      new Promise((resolve, reject) =>
        process.send({ type: 'progress', value }, (error) => (error ? reject(error) : resolve()))
      ),
  });
  process.send({ type: 'result', result });
}
async function run(directory, name, input, create = false) {
  const { fork } = require('child_process');
  const scope = createPrivacyScope({
    profileId: 'public-history-replay',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'offline-public-history',
    chainId: 11155111,
    role: 'engine',
  });
  let child,
    stopping = false,
    result,
    failure,
    lastProgress,
    timer,
    escalation;
  const started = performance.now();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    session.close();
    child?.kill('SIGTERM');
    escalation = setTimeout(() => child?.kill('SIGKILL'), 1000);
  };
  const session = startRailgunSessionWorker({
    handle,
    storage: {
      format: 'paged-v2',
      filename: path.join(directory, 'state.sqlite'),
      key: Buffer.alloc(32, 63),
      binding: 'c'.repeat(64),
      create,
    },
    createProvider: ({ signal }) => ({
      signal,
      request: async () => {
        throw new Error('No RPC in offline replay');
      },
    }),
    onClose: () => {
      if (child && !stopping) stop();
    },
  });
  try {
    await session.ready;
    const exited = await new Promise((resolve, reject) => {
      child = fork(__filename, ['--child'], {
        env: {},
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        execArgv: ['--max-old-space-size=256'],
      });
      let diagnostic = '';
      child.stderr.on('data', (bytes) => {
        diagnostic = (diagnostic + bytes).slice(-4000);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, diagnostic }));
      child.on('message', (message) => {
        if (stopping) return;
        if (message.type === 'progress') {
          lastProgress = message.value;
          return;
        }
        if (message.type === 'failure') {
          failure = message.error;
          stop();
          return;
        }
        if (message.type === 'result') {
          result = message.result;
          child.kill('SIGTERM');
          return;
        }
        if (message.type !== 'command') {
          failure = 'Invalid child envelope';
          stop();
          return;
        }
        session.dispatch(message.wire).then(
          (wire) => {
            if (!stopping && child.connected) child.send({ type: 'reply', wire });
          },
          () => {
            failure = 'Storage session revoked';
            stop();
          }
        );
      });
      child.send(input);
      timer = setTimeout(() => {
        failure = 'Replay deadline';
        stop();
      }, 10 * 60000);
    });
    assert.equal(failure, undefined, failure);
    if (input.crashPhase) {
      assert.equal(exited.signal, 'SIGKILL', exited.diagnostic);
      assert.equal(result, undefined);
      assert.equal(lastProgress.chunk, input.crashChunk);
      assert.equal(lastProgress.phase, input.crashPhase);
    } else assert.ok(result, exited.diagnostic || 'No replay result');
    const frontier = await session.inspectFrontier();
    // Even an exact reproduced public root is not a host-issued coverage grant.
    assert.equal(frontier.status, 'persisted-unverified');
    if (result)
      assert.equal(frontier.lastSyncedBlock, result.chunks[result.completedChunks - 1].toBlock);
    const expected = result ? result.chunks[result.completedChunks - 1] : input.expectedChunk;
    assert.deepEqual(frontier.trees, [
      { tree: 0, length: expected.length, root: '0x' + expected.root, invalidRoot: false },
    ]);
    const inspectionStarted = performance.now();
    const publicState = input.inspectPublicState ? await session.inspectPublicState() : null;
    const publicInspectionMs = publicState ? performance.now() - inspectionStarted : null;
    if (publicState && result) {
      for (const [kind, name] of [
        ['commitments', 'leaves'],
        ['nullifiers', 'nullifiers'],
        ['unshields', 'unshields'],
      ])
        assert.equal(publicState[kind].count, result.checks[name]);
      assert.deepEqual(
        publicState.trees,
        frontier.trees.map(({ tree, length, root }) => ({ tree, length, root }))
      );
    }
    if (publicState) {
      const identity = await session.inspectStoreIdentity();
      assert.equal(publicState.storeId, identity.instanceId);
      session.assertFresh(publicState);
      const index = result ? result.completedChunks - 1 : input.crashChunk;
      const expected = { ...expectedPublicStates[index], storeId: identity.instanceId };
      if (!result) {
        if (input.crashPhase === 'commitments')
          expected.nullifiers = expectedPublicStates[index - 1].nullifiers;
        if (['commitments', 'nullifiers'].includes(input.crashPhase))
          expected.unshields = expectedPublicStates[index - 1].unshields;
      }
      assert.deepEqual(
        publicState,
        expected,
        'Host public state must match precomputed source, including partial crash phase'
      );
    }
    const observation = {
      publicInspectionMs,
      publicState,
      name,
      passed: true,
      result: result ?? null,
      interruptedAt: input.crashPhase ? lastProgress : null,
      frontier,
      elapsedMs: Math.round(performance.now() - started),
      exitSignal: exited.signal,
      databaseBytes: fs.statSync(path.join(directory, 'state.sqlite')).size,
    };
    fs.writeFileSync(
      path.join(directory, name + '.json'),
      JSON.stringify(observation, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 }
    );
    console.log(
      JSON.stringify({
        name,
        passed: true,
        elapsedMs: observation.elapsedMs,
        checks: result?.checks,
        cursor: result?.cursor,
        initialCursor: result?.initialCursor,
      })
    );
    return observation;
  } finally {
    stop();
    await session.closed;
    clearTimeout(timer);
    clearTimeout(escalation);
    scope.close();
  }
}
async function main() {
  const [captureDirectory, directory] = process.argv.slice(2);
  assert.ok(path.isAbsolute(directory));
  const capture = readRailgunLogCapture(captureDirectory);
  fs.mkdirSync(directory, { mode: 0o700 });
  const sources = [
    'scripts/qualify-railgun-history-replay.js',
    'scripts/prepare-railgun-public-history.js',
    'scripts/fixtures/railgun-history-job.js',
    'scripts/railgun-log-capture-data.js',
    'scripts/capture-railgun-sepolia-logs.js',
    'scripts/railgun-fixture-integrity.js',
    'src/main/wallet/railgun-remote.js',
    'src/main/wallet/railgun-tree-transactions.js',
    'src/main/wallet/railgun-session.js',
    'src/main/wallet/railgun-session-worker.js',
    'src/main/wallet/railgun-session-worker-entry.js',
    'src/main/wallet/railgun-paged-store.js',
    'src/main/wallet/railgun-store-cursor.js',
    'src/main/wallet/railgun-frontier.js',
    'src/main/wallet/railgun-public-records.js',
    'src/main/wallet/railgun-process-guards.js',
  ];
  const sourceSha256 = Object.fromEntries(
    sources.map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', file)))
        .digest('hex'),
    ])
  );
  const input = {
    captureDirectory,
    logSetSha256: capture.logSetSha256,
    inspectPublicState: process.argv[4] === '--inspect-public-state',
  };
  const sourcePlan = input.inspectPublicState ? await planHistory(input) : null;
  expectedPublicStates = sourcePlan?.expectedStates;
  const baseline = path.join(directory, 'baseline');
  fs.mkdirSync(baseline);
  const runs = [await run(baseline, 'baseline-two-chunks', { ...input, limit: 2 }, true)];
  const selected = runs[0].result.chunks[2];
  assert.ok(
    selected.length > selected.start && selected.nullifiers > 0 && selected.unshields > 0,
    'Crash chunk must contain all three event categories'
  );
  const baselineSnapshot = path.join(directory, 'two-chunks.sqlite');
  fs.copyFileSync(
    path.join(baseline, 'state.sqlite'),
    baselineSnapshot,
    fs.constants.COPYFILE_EXCL
  );
  const reference = await run(baseline, 'uninterrupted-three-chunks', { ...input, limit: 3 });
  runs.push(reference);
  // Keep the original two-chunk snapshot for each independent crash case.
  for (const phase of ['commitments', 'nullifiers', 'unshields', 'engine-cursor', 'checkpoint']) {
    const target = path.join(directory, phase);
    fs.mkdirSync(target);
    fs.copyFileSync(
      baselineSnapshot,
      path.join(target, 'state.sqlite'),
      fs.constants.COPYFILE_EXCL
    );
    runs.push(
      await run(target, 'crash-' + phase, {
        ...input,
        crashChunk: 2,
        crashPhase: phase,
        expectedChunk: selected,
      })
    );
    const restored = await run(target, 'restore-' + phase, { ...input, limit: 3 });
    assert.equal(restored.result.initialCursor, phase === 'checkpoint' ? 2 : 1);
    assert.equal(restored.result.initialLength, selected.length);
    assert.deepEqual(restored.result.checks, reference.result.checks);
    assert.deepEqual(restored.result.digests, reference.result.digests);
    assert.deepEqual(restored.frontier, reference.frontier);
    assert.deepEqual(restored.publicState, reference.publicState);
    runs.push(restored);
    const cold = await run(target, 'cold-' + phase, { ...input, limit: 3 });
    assert.equal(cold.result.validations, 0);
    assert.deepEqual(cold.result.digests, restored.result.digests);
    assert.deepEqual(cold.result.checks, restored.result.checks);
    assert.deepEqual(cold.publicState, restored.publicState);
    runs.push(cold);
  }
  const complete = await run(baseline, 'complete-public-history', input);
  assert.deepEqual(complete.result.checks, { leaves: 10194, nullifiers: 5614, unshields: 2546 });
  runs.push(complete);
  const cold = await run(baseline, 'cold-complete-public-history', input);
  assert.deepEqual(cold.result.digests, complete.result.digests);
  assert.deepEqual(cold.frontier, complete.frontier);
  assert.deepEqual(cold.publicState, complete.publicState);
  assert.equal(cold.result.validations, 0);
  runs.push(cold);
  const report = {
    observedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    captureReportSha256: capture.reportSha256,
    logSetSha256: capture.logSetSha256,
    publicCapturedHistory: true,
    runtime: 'node-child-with-trusted-storage-worker',
    upstreamScannerSchedulingQualified: false,
    crashesAtAcknowledgedPhaseBoundaries: true,
    liveRpcDuringReplay: false,
    wholeChunkAtomic: false,
    hostPublicStateCompared: input.inspectPublicState,
    sourcePlan,
    hostCoverageGranted: false,
    walletScanned: false,
    signingEnabled: false,
    submissions: 0,
    runs,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
if (process.argv[2] === '--plan') {
  process.on('disconnect', () => process.exit(1));
  process.once('message', (input) =>
    plannerMain(input).catch((error) => {
      console.error(error.stack);
      process.exit(1);
    })
  );
} else if (process.argv[2] === '--child') {
  process.on('disconnect', () => process.exit(1));
  process.once('message', (input) =>
    childMain(input).catch((error) => process.send({ type: 'failure', error: String(error.stack) }))
  );
} else
  main().catch((error) => {
    console.error(error.stack);
    process.exitCode = 1;
  });
