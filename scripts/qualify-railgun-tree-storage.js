/** Offline persisted-tree boundary probe. Uses only synthetic public leaves.
 * The parent owns SQLite and RPC authority. This is a Node qualification harness,
 * not the Electron supervisor, a chain scan, wallet scan or production validator.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const root = path.join(__dirname, 'fixtures/railgun-engine');
const paged = process.argv[3] === '--paged';
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');

async function childMain(input) {
  const { createRequire } = require('module');
  const { assertRailgunFixture } = require('./railgun-fixture-integrity');
  const inventory = assertRailgunFixture(path.join(root, 'node_modules'));
  const guards = require('../src/main/wallet/railgun-process-guards').installRailgunProcessGuards({
    onRefusal: () => process.exit(2),
  });
  const r = createRequire(path.join(root, 'package.json'));
  const enginePath = path.dirname(r.resolve('@railgun-community/engine'));
  const { Database } = require(path.join(enginePath, 'database/database'));
  const { UTXOMerkletree } = require(path.join(enginePath, 'merkletree/utxo-merkletree'));
  const { MERKLE_ZERO_VALUE } = require(path.join(enginePath, 'models/merkletree-types'));
  const { poseidonHex, initPoseidonPromise } = require(path.join(enginePath, 'utils/poseidon'));
  await initPoseidonPromise;
  const version = 'V2_PoseidonMerkle';
  const chain = { type: 0, id: 11155111 };
  // Independent tree reduction, sharing the pinned hash primitive only. This
  // knows all synthetic leaves; it neither trusts a supplied root nor skips validation.
  function reference(count) {
    let nodes = Array.from({ length: count }, (_, i) => hex(i + 1));
    let zero = MERKLE_ZERO_VALUE;
    for (let level = 0; level < 16; level++) {
      const next = [];
      for (let i = 0; i < nodes.length; i += 2)
        next.push(poseidonHex([nodes[i], nodes[i + 1] ?? zero]));
      zero = poseidonHex([zero, zero]);
      nodes = next;
    }
    return nodes[0] ?? zero;
  }
  const pending = new Map();
  const controller = new AbortController();
  process.on('message', (message) => {
    if (message.type !== 'reply') return;
    const id = JSON.parse(message.wire).id;
    const task = pending.get(id);
    assert.ok(task);
    pending.delete(id);
    task(message.wire);
  });
  const remote = require('../src/main/wallet/railgun-remote').createRailgunRemote({
    ...r('abstract-leveldown'),
    signal: controller.signal,
    send: (wire) =>
      new Promise((resolve) => {
        pending.set(JSON.parse(wire).id, resolve);
        process.send({ type: 'command', wire });
      }).then(async (reply) => {
        if (input.poll && JSON.parse(wire).method === 'txStage')
          assert.equal(
            await remote.provider.request({ method: 'eth_chainId', params: [] }),
            '0xaa36a7'
          );
        return reply;
      }),
  });
  const db = new Database(remote.leveldown);
  if (input.atomic) {
    const { Merkletree } = require(path.join(enginePath, 'merkletree/merkletree'));
    require('../src/main/wallet/railgun-tree-transactions').installRailgunTreeTransactions({
      Merkletree,
      remote,
    });
  }
  const validations = [];
  const tree = await UTXOMerkletree.create(db, chain, version, async (v, c, t, last, value) => {
    assert.equal(v, version);
    assert.deepEqual(c, chain);
    assert.equal(t, 0);
    assert.equal(last + 1, input.target);
    assert.equal(value, reference(input.target));
    validations.push(last + 1);
    return true;
  });
  const vectors = require('../docs/qualification/railgun-frontier-vectors-2026-10-02.json');
  const { RailgunEngine } = require(path.join(enginePath, 'railgun-engine'));
  assert.equal(inventory.sha256, vectors.inventory);
  const actualPaths = {
    metadata: tree.getMerkletreeDBPrefix(),
    root0: tree.getNodeHashDBPath(0, 16, 0),
    leaf31: tree.getNodeHashDBPath(0, 0, 31),
    data31: tree.getDataDBPath(0, 31),
    history: RailgunEngine.getUTXOMerkletreeHistoryVersionDBPrefix(chain),
    synced: RailgunEngine.getLastSyncedBlockDBPrefix(version, chain),
  };
  for (const [name, parts] of Object.entries(actualPaths))
    assert.equal(Database.pathToKey(parts), vectors.keys[name]);
  for (const vector of vectors.metadata)
    assert.equal(r('msgpack-lite').encode(vector.value).toString('hex'), vector.hex);
  if (input.write) {
    assert.equal(await tree.getTreeLength(0), input.start);
    await tree.insertLeaves(
      0,
      input.start,
      Array.from({ length: input.target - input.start }, (_, i) => ({
        hash: hex(input.start + i + 1),
        blockNumber: 1,
      }))
    );
  }
  const length = await tree.getTreeLength(0);
  const rows = await tree.getTreeLengthFromDBCount(0);
  const proof = await tree.getMerkleProof(0, input.target - 1);
  assert.equal(remote.signal.aborted, false);
  assert.equal(proof.root, reference(input.rootCount));
  assert.equal(proof.leaf, hex(input.target));
  let computed = proof.leaf;
  for (let level = 0; level < 16; level++) {
    computed =
      ((input.target - 1) >> level) & 1
        ? poseidonHex([proof.elements[level], computed])
        : poseidonHex([computed, proof.elements[level]]);
  }
  assert.equal(computed, proof.root);
  assert.equal(length, input.length);
  assert.equal(rows, input.rows);
  const commitment = await tree.getCommitmentSafe(0, input.target - 1);
  assert.equal(Boolean(commitment), input.commitment);
  if (commitment) assert.equal(commitment.hash, hex(input.target));
  if (input.coverage) {
    // Exercise upstream key/encoding functions. These are synthetic ENGINE
    // cursor claims, not a host-observed chain anchor or completeness evidence.
    await RailgunEngine.prototype.setUTXOMerkletreeHistoryVersion.call({ db }, chain, 13);
    await RailgunEngine.prototype.setLastSyncedBlock.call({ db }, version, chain, 9000000);
  }
  const report = guards.report();
  assert.equal(report.attempts, 0);
  assert.ok(
    !Object.keys(require.cache).some(
      (f) => f.includes('better-sqlite3') || f.endsWith('/railgun-store.js')
    )
  );
  process.send({
    type: 'result',
    result: {
      length,
      rows,
      proofValid: true,
      root: proof.root,
      commitmentPresent: Boolean(commitment),
      validations,
      inventory: inventory.sha256,
      guards: report.hooks.length,
      canaries: report.canaries,
    },
  });
}

async function run(
  directory,
  name,
  input,
  {
    create = false,
    failBatch = 0,
    reject = false,
    failStage = 0,
    failInsert = 0,
    failStatement,
    killBeforeCommit = false,
    killAfterCommit = false,
  } = {}
) {
  const { fork } = require('child_process');
  const Database = require('better-sqlite3');
  const { createPrivacyScope } = require('../src/main/networks/privacy-context');
  const { createRailgunSession } = require('../src/main/wallet/railgun-session');
  const scope = createPrivacyScope({
    profileId: 'public-tree-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'fixture',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'engine',
  });
  let child,
    session,
    timer,
    escalation,
    stopping = false,
    result,
    failure,
    batches = 0,
    injected = false,
    armFault = false,
    rpcCalls = 0;
  let inserts = 0,
    failedCommand,
    interrupted = null,
    childFailure = false;
  let hostFrontier,
    requestedPositionAllowed = false,
    hostBusyChecks = 0;
  const calls = {},
    batchSizes = [],
    batchBytes = [];
  const originalPrepare = Database.prototype.prepare;
  Database.prototype.prepare = function (sql) {
    const statement = originalPrepare.call(this, sql);
    if (sql === 'INSERT INTO records VALUES (?, ?)' || sql === failStatement) {
      const originalRun = statement.run.bind(statement);
      statement.run = (...args) => {
        if (sql === failStatement || armFault || (failInsert && ++inserts === failInsert)) {
          armFault = false;
          injected = true;
          throw new Error('Synthetic SQLite write fault');
        }
        return originalRun(...args);
      };
    }
    return statement;
  };
  function stop() {
    if (stopping) return;
    stopping = true;
    session?.close();
    child?.kill('SIGTERM');
    escalation = setTimeout(() => child?.kill('SIGKILL'), 250);
  }
  const started = performance.now();
  try {
    session = createRailgunSession({
      handle,
      storage: {
        format: paged ? 'paged-v2' : undefined,
        filename: path.join(directory, 'state.sqlite'),
        key: Buffer.alloc(32, 31),
        binding: 'e'.repeat(64),
        create,
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async ({ method, params }) => {
          rpcCalls++;
          if (input.poll && method === 'eth_chainId' && params.length === 0) return '0xaa36a7';
          throw new Error('No fixture RPC allowed');
        },
      }),
      onClose: stop,
    });
    const exit = new Promise((resolve, rejectExit) => {
      child = fork(__filename, ['--child'], {
        env: {},
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        execArgv: ['--max-old-space-size=256'],
      });
      let diagnostics = '';
      child.stderr.on('data', (chunk) => {
        diagnostics = (diagnostics + chunk).slice(-2000);
      });
      child.once('error', rejectExit);
      child.once('exit', (code, signal) => resolve({ code, signal, diagnostics }));
      child.on('message', (message) => {
        if (stopping) return;
        if (message?.type === 'result') {
          result = message.result;
          hostFrontier = session.inspectFrontier();
          assert.equal(
            hostFrontier.status,
            (input.coverage || input.coveragePresent) && input.target <= input.length
              ? 'persisted-unverified'
              : 'incomplete'
          );
          if (input.target > input.length)
            assert.ok(hostFrontier.reasons.includes('records-beyond-length'));
          assert.equal(hostFrontier.trees[0].length, input.length);
          assert.equal(hostFrontier.trees[0].root, '0x' + result.root.replace(/^0x/, ''));
          if ((input.coverage || input.coveragePresent) && input.target <= input.length) {
            const position = session.inspectPosition(hostFrontier, {
              tree: 0,
              index: input.target - 1,
            });
            assert.equal(position.status, 'persisted-unverified');
            assert.equal(position.root, hostFrontier.trees[0].root);
            session.assertFresh(position);
            requestedPositionAllowed = true;
          } else
            assert.throws(() =>
              session.inspectPosition(hostFrontier, { tree: 0, index: input.target - 1 })
            );
          stop();
          return;
        }
        if (message?.type === 'failure') {
          childFailure = true;
          failure = message.error;
          stop();
          return;
        }
        if (message?.type !== 'command') {
          failure = 'Unexpected fixture envelope';
          stop();
          return;
        }
        const command = JSON.parse(message.wire);
        calls[command.method] = (calls[command.method] ?? 0) + 1;
        if (['batch', 'txStage'].includes(command.method)) {
          batches++;
          batchSizes.push(command.args.operations.length);
          batchBytes.push(Buffer.byteLength(message.wire));
          if (batches === failBatch) armFault = true;
        }
        if (
          (command.method === 'txStage' && batches === failStage) ||
          (command.method === 'txCommit' && killBeforeCommit)
        ) {
          failedCommand = {
            method: command.method,
            batch: batches,
            operations: command.args.operations?.length ?? 0,
          };
          interrupted = killBeforeCommit ? 'before-commit' : 'stage';
          if (killBeforeCommit) child.kill('SIGKILL');
          stop();
          return;
        }
        session.dispatch(message.wire).then(
          (wire) => {
            if (command.method === 'txStage') {
              assert.throws(() => session.inspectFrontier(), { code: 'RAILGUN_FRONTIER_BUSY' });
              hostBusyChecks++;
            }
            if (command.method === 'txCommit' && killAfterCommit) {
              failedCommand = { method: command.method, batch: batches, operations: 0 };
              interrupted = 'after-commit';
              child.kill('SIGKILL');
              stop();
              return;
            }
            if (!stopping && child.connected) child.send({ type: 'reply', wire });
          },
          () => {
            failedCommand ||= {
              method: command.method,
              batch: batches,
              operations: command.args.operations?.length ?? 0,
            };
            failure ||= 'RAILGUN_SESSION_REVOKED';
            stop();
          }
        );
      });
      child.send(input);
      timer = setTimeout(() => {
        failure = 'DEADLINE';
        stop();
      }, 60000);
    });
    const exited = await exit;
    if (killBeforeCommit || killAfterCommit) assert.equal(exited.signal, 'SIGKILL');
    if (input.poll) assert.ok(rpcCalls > 0);
    else assert.equal(rpcCalls, 0);
    assert.equal(session.signal.aborted, true);
    assert.equal(injected, Boolean(failBatch || failInsert || failStatement));
    if (reject) {
      assert.equal(childFailure, false);
      assert.equal(result, undefined);
      if (interrupted) assert.equal(failure, undefined);
      else assert.equal(failure, 'RAILGUN_SESSION_REVOKED');
      assert.ok(failedCommand);
      if (failBatch) assert.equal(failedCommand.batch, failBatch);
      else if (failStage) {
        assert.equal(failedCommand.method, 'txStage');
        assert.equal(failedCommand.batch, failStage);
      } else if (failInsert || failStatement || killBeforeCommit || killAfterCommit)
        assert.equal(failedCommand.method, 'txCommit');
      else {
        assert.equal(failedCommand.method, 'batch');
        assert.ok(failedCommand.operations > 1024);
      }
    } else assert.ok(result, failure || exited.diagnostics || 'Child exited without result');
    return {
      name,
      passed: true,
      result: result ?? null,
      expectedRefusal: reject && !interrupted,
      interrupted,
      failure: failure ?? null,
      failedCommand: failedCommand ?? null,
      injected,
      rpcCalls,
      hostFrontier: hostFrontier ?? null,
      requestedPositionAllowed,
      hostBusyChecks,
      calls,
      batchSizes,
      batchBytes,
      elapsedMs: Math.round(performance.now() - started),
      databaseBytes: fs.statSync(path.join(directory, 'state.sqlite')).size,
      exitCode: exited.code,
      exitSignal: exited.signal,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    session?.close();
    scope.close();
    Database.prototype.prepare = originalPrepare;
  }
}

async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory));
  fs.mkdirSync(directory, { mode: 0o700 });
  const runs = [];
  const normal = (n) => ({
    write: false,
    start: 0,
    target: n,
    rootCount: n,
    length: n,
    rows: n,
    commitment: true,
  });
  for (const n of [32, 256]) {
    const dir = path.join(directory, String(n));
    fs.mkdirSync(dir);
    runs.push(await run(dir, `create-${n}`, { ...normal(n), write: true }, { create: true }));
    runs.push(await run(dir, `cold-${n}`, normal(n)));
  }
  const capacity = path.join(directory, 'capacity');
  fs.mkdirSync(capacity);
  const refused = await run(
    capacity,
    'batch-cap-512',
    { ...normal(512), write: true },
    { create: true, reject: true }
  );
  assert.ok(refused.batchSizes.some((n) => n > 1024));
  runs.push(refused);
  for (const failBatch of [2, 3]) {
    const dir = path.join(directory, `fault-${failBatch}`);
    fs.mkdirSync(dir);
    runs.push(
      await run(dir, `baseline-${failBatch}`, { ...normal(32), write: true }, { create: true })
    );
    runs.push(
      await run(
        dir,
        `fault-${failBatch}`,
        { ...normal(64), start: 32, write: true },
        { failBatch, reject: true }
      )
    );
    runs.push(
      await run(dir, `cold-after-fault-${failBatch}`, {
        ...normal(64),
        coverage: true,
        length: 32,
        rows: failBatch === 2 ? 32 : 64,
        commitment: failBatch !== 2,
      })
    );
  }
  const atomic = path.join(directory, 'atomic');
  fs.mkdirSync(atomic);
  runs.push(
    await run(
      atomic,
      'atomic-create-512',
      { ...normal(512), write: true, atomic: true, poll: true },
      { create: true }
    )
  );
  runs.push(await run(atomic, 'atomic-cold-512', { ...normal(512), atomic: true }));
  for (const [name, fault] of [
    ['stage-1', { failStage: 1 }],
    ['stage-2', { failStage: 2 }],
    ['stage-3', { failStage: 3 }],
    [paged ? 'commit-page' : 'commit-node', { failInsert: 1 }],
    paged
      ? ['commit-directory', { failStatement: 'UPDATE records SET ciphertext = ? WHERE id = ?' }]
      : ['commit-data', { failInsert: 82 }],
    paged
      ? ['commit-collection', { failStatement: 'DELETE FROM records WHERE id = ?' }]
      : ['commit-metadata', { failInsert: 114 }],
    ['killed-before-commit', { killBeforeCommit: true }],
    ['killed-after-commit', { killAfterCommit: true }],
  ]) {
    const dir = path.join(directory, name);
    fs.mkdirSync(dir);
    runs.push(
      await run(
        dir,
        `atomic-baseline-${name}`,
        { ...normal(32), write: true, atomic: true, coverage: true },
        { create: true }
      )
    );
    runs.push(
      await run(
        dir,
        `atomic-fault-${name}`,
        { ...normal(64), start: 32, write: true, atomic: true },
        { ...fault, reject: true }
      )
    );
    runs.push(
      await run(dir, `atomic-cold-${name}`, {
        ...normal(fault.killAfterCommit ? 64 : 32),
        atomic: true,
        coveragePresent: true,
      })
    );
    runs.push(
      await run(dir, `atomic-replay-${name}`, {
        ...normal(fault.killAfterCommit ? 96 : 64),
        start: fault.killAfterCommit ? 64 : 32,
        write: true,
        atomic: true,
        coveragePresent: true,
      })
    );
    runs.push(
      await run(dir, `atomic-replayed-cold-${name}`, {
        ...normal(fault.killAfterCommit ? 96 : 64),
        atomic: true,
        coveragePresent: true,
      })
    );
  }
  const inspected = path.join(directory, 'frontier');
  fs.mkdirSync(inspected);
  runs.push(
    await run(
      inspected,
      'frontier-create',
      { ...normal(32), write: true, atomic: true, coverage: true },
      { create: true }
    )
  );
  runs.push(
    await run(inspected, 'frontier-cold', { ...normal(32), atomic: true, coveragePresent: true })
  );
  const sources = [
    'scripts/qualify-railgun-tree-storage.js',
    'scripts/railgun-fixture-integrity.js',
    'src/main/wallet/railgun-session.js',
    'src/main/wallet/railgun-remote.js',
    'src/main/wallet/railgun-store.js',
    'src/main/wallet/railgun-paged-store.js',
    'src/main/wallet/railgun-store-cursor.js',
    'src/main/wallet/railgun-frontier.js',
    'src/main/wallet/railgun-tree-transactions.js',
    'src/main/wallet/railgun-process-guards.js',
    'scripts/fixtures/railgun-engine/runtime-integrity.json',
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
  const report = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    sourceSha256,
    storageFormat: paged ? 'paged-v2' : 'legacy-v1',
    syntheticLeaves: true,
    liveHistory: false,
    runs,
  };
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[2] === '--child') {
  process.on('disconnect', () => process.exit(1));
  process.once('message', (input) =>
    childMain(input).catch((error) => {
      process.send({ type: 'failure', error: String(error.stack) });
    })
  );
} else
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
