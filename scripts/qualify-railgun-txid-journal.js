/** Offline actual-engine/worker host-journal qualification. Public captured
 * rows, synthetic keys/identities and controlled root-receipt assertions only.
 * Live root acceptance is qualified separately; no enrolled-account authority.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const sha = (v) => createHash('sha256').update(v).digest('hex');
async function main() {
  const [capture, archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  assert.ok([capture, archive, output].every(path.isAbsolute) && !fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const sourceBytes = fs.readFileSync(path.join(capture, 'report.json')),
    source = JSON.parse(sourceBytes);
  assert.equal(source.passed, true);
  assert.equal(source.publicQueriesOnly, true);
  const names = [
    ...new Set([
      'scripts/qualify-railgun-txid-journal.js',
      ...Object.keys(
        require('../docs/qualification/railgun-txid-storage-2026-10-03.json').sourceSha256
      ),
      'src/main/wallet/railgun-txid-journal.js',
      'src/main/wallet/railgun-txid-runner.test.js',
      'src/main/wallet/railgun-txid-job.test.js',
      'src/main/wallet/privacy-storage.js',
    ]),
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    );
  const sourceSha256 = hashes();
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'txid-journal-fixture',
    signal: new AbortController().signal,
  });
  const subject = {
    kind: 'private-account',
    principal: 'public-fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  };
  const handle = scope.getContext(subject),
    filename = path.join(output, 'txid-' + '9'.repeat(64) + '.sqlite');
  let worker, runner, journal, storeId;
  const rootReceipts = new WeakMap();
  const issueRoot = (state) => {
    const receipt = {};
    rootReceipts.set(receipt, { index: state.count - 1, root: state.root, at: performance.now() });
    return receipt;
  };
  const assertRoot = (receipt, point) => {
    const observed = rootReceipts.get(receipt);
    assert.ok(
      observed &&
        observed.index === point.index &&
        observed.root === point.root &&
        performance.now() - observed.at < 60000
    );
    return {
      ...point,
      service: 'sepolia-ppoi-fdi',
      accepted: true,
      observedAt: new Date().toISOString(),
      latestIndex: source.checkpoint.index,
    };
  };
  const close = async () => {
    journal?.close();
    runner?.close();
    worker?.close();
    if (worker) await worker.closed;
  };
  async function open(create) {
    worker = require('../src/main/wallet/railgun-session-worker').startRailgunSessionWorker({
      handle,
      storage: {
        filename,
        format: 'paged-v2',
        key: Buffer.alloc(32, 83),
        binding: '8'.repeat(64),
        create,
      },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw new Error('No RPC');
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
      policy: '9'.repeat(64),
      handle,
      archive,
      session: worker,
      filename,
      binding: '8'.repeat(64),
    });
    journal = await require('../src/main/wallet/railgun-txid-journal').createRailgunTxidJournal({
      handle: scope.getContext({
        ...subject,
        role: 'storage',
        operation: 'railgun-txid-v1:' + '9'.repeat(64),
      }),
      directory: output,
      key: Buffer.alloc(32, 84),
      binding: '8'.repeat(64),
      policy: '9'.repeat(64),
      publicIdentity: {
        generationId: 'a'.repeat(64),
        sourceId: 'b'.repeat(64),
        publicId: 'c'.repeat(64),
      },
      session: worker,
      assertResult: runner.assertResult,
      assertRoot,
      create,
    });
  }
  const processes = require('../src/main/wallet/railgun-process'),
    originalStart = processes.startRailgunProcess;
  assert.equal(require.cache[require.resolve('../src/main/wallet/railgun-txid-runner')], undefined);
  let fault;
  const faultRecoveries = [];
  processes.startRailgunProcess = (options) => {
    const selected = fault;
    if (!selected) return originalStart(options);
    assert.equal(JSON.parse(options.input).mode, 'apply');
    assert.ok(!options.binaryKey);
    const broker = options.broker;
    const task = originalStart({
      ...options,
      broker: {
        signal: broker.signal,
        async dispatch(wire) {
          const message = JSON.parse(wire);
          if (message.method === 'result') selected.results++;
          const reply = await broker.dispatch(wire);
          if (message.method === selected.method && !selected.injected) {
            selected.injected = true;
            // The real storage operation has completed. Reject a broker message
            // before acknowledging it to the child, simulating this exact gap.
            const rejected = broker.dispatch(
              JSON.stringify({ id: message.id + 1, method: 'forbidden', args: {} })
            );
            selected.immediateAbort = broker.signal.aborted;
            await assert.rejects(rejected);
            assert.equal(selected.immediateAbort, true);
          }
          return reply;
        },
      },
    });
    task.closed.then((exit) => {
      selected.exit = exit.code;
    });
    return task;
  };
  try {
    await open(true);
    let inspected = await runner.run('inspect', {}),
      state = inspected.value.state;
    assert.equal(await journal.revalidate(inspected.receipt), null);
    const recoveries = [];
    for (
      let page = 0;
      page < source.pages.length && state.count <= source.checkpoint.index;
      page++
    ) {
      const entry = source.pages[page];
      assert.ok(/^\d{5}\.json$/.test(entry.filename));
      const bytes = fs.readFileSync(path.join(capture, entry.filename));
      assert.equal(sha(bytes), entry.sha256);
      const rows = JSON.parse(bytes).transactions.slice(
        0,
        source.checkpoint.index + 1 - state.count
      );
      const projected = await runner.run('project', { base: state, rows });
      const payload = { base: state, rows, expected: projected.value.state };
      let token = await journal.prepare(payload, projected.receipt, issueRoot(payload.expected));
      if (page === 1) {
        await close();
        await open(false);
        assert.deepEqual((await journal.readState()).pending.work, payload);
        inspected = await runner.run('inspect', {});
        token = await journal.resume(inspected.receipt, issueRoot(payload.expected));
        recoveries.push('after-prepare-before-apply');
      }
      let applied;
      if (page === 3 || page === 4) {
        const beforeStore = await worker.inspectWalletState();
        fault = {
          method: page === 3 ? 'txStage' : 'txCommit',
          injected: false,
          results: 0,
        };
        const attempted = fault;
        await assert.rejects(runner.run('apply', payload));
        fault = undefined;
        assert.equal(attempted.injected, true);
        assert.equal(attempted.immediateAbort, true);
        assert.equal(attempted.results, 0);
        assert.ok(attempted.exit && attempted.exit !== 'RAILGUN_PROCESS_CLOSED');
        await close();
        await open(false);
        const pending = await journal.readState();
        assert.deepEqual(pending.pending.work, payload);
        assert.deepEqual(pending.checkpoint.state, payload.base);
        inspected = await runner.run('inspect', {});
        assert.deepEqual(inspected.value.state, page === 3 ? payload.base : payload.expected);
        const recoveredStore = await worker.inspectWalletState();
        if (page === 3) assert.deepEqual(recoveredStore, beforeStore);
        token = await journal.resume(inspected.receipt, issueRoot(payload.expected));
        applied = await runner.run('apply', payload);
        assert.equal(applied.value.replayed, page === 4);
        assert.deepEqual(applied.value.state, payload.expected);
        if (page === 4) assert.deepEqual(await worker.inspectWalletState(), recoveredStore);
        faultRecoveries.push({
          point: page === 3 ? 'staged-before-commit' : 'committed-before-reply',
          immediateRefusal: true,
          childExit: attempted.exit,
          resultMessages: attempted.results,
          pendingJournalRetained: true,
          oldCheckpointRetainedBeforeRecovery: true,
          storeBeforeRecovery: page === 3 ? 'unchanged-base' : 'complete-new-state',
          recoveredWithoutDuplication: true,
          ...(page === 4 ? { replayStoreUnchanged: true } : {}),
          replayed: applied.value.replayed,
        });
      } else applied = await runner.run('apply', payload);
      if (page === 2) {
        await close();
        await open(false);
        assert.deepEqual((await journal.readState()).pending.work, payload);
        inspected = await runner.run('inspect', {});
        token = await journal.resume(inspected.receipt, issueRoot(payload.expected));
        applied = await runner.run('apply', payload);
        assert.equal(applied.value.replayed, true);
        recoveries.push('after-apply-before-complete');
      }
      await journal.complete(token, applied.receipt, issueRoot(payload.expected));
      state = applied.value.state;
      assert.deepEqual((await journal.readState()).checkpoint.state, state);
      console.log(JSON.stringify({ page, count: state.count }));
    }
    assert.equal(state.root, source.checkpoint.root);
    assert.equal(state.count, source.checkpoint.index + 1);
    assert.equal(faultRecoveries.length, 2);
    const before = await journal.readState();
    await close();
    await open(false);
    inspected = await runner.run('inspect', {});
    const restored = await journal.revalidate(inspected.receipt, issueRoot(state));
    assert.deepEqual(restored, before.checkpoint);
    assert.deepEqual(hashes(), sourceSha256);
    const report = {
      observedAt: new Date().toISOString(),
      sourceSha256,
      captureSha256: sha(sourceBytes),
      checkpoint: restored,
      recoveries,
      faultRecoveries,
      coldRestore: true,
      rootValidation: 'controlled-fixture-receipts',
      enrolledAccountQualified: false,
      independentEventCoverage: false,
      globalTxidCompleteness: false,
      accountsOpened: 0,
      submissions: 0,
      passed: true,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return 0;
  } finally {
    processes.startRailgunProcess = originalStart;
    await close();
    scope.close();
  }
}
main().then(
  (code) => app.exit(code),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
