/** Actual guarded engine/worker coverage against separately captured public
 * events. Synthetic store keys/source identity: this is not enrolled coverage,
 * a live root observation, account POI or permission to spend.
 * electron script txid-capture logs-capture archive new-output
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const sha = (v) => createHash('sha256').update(v).digest('hex');
async function main() {
  const [txidsDirectory, logsDirectory, archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 6);
  assert.ok(
    [txidsDirectory, logsDirectory, archive, output].every(path.isAbsolute) &&
      !fs.existsSync(output)
  );
  fs.mkdirSync(output, { mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const txidBytes = fs.readFileSync(path.join(txidsDirectory, 'report.json')),
    txids = JSON.parse(txidBytes);
  assert.equal(txids.passed, true);
  assert.equal(txids.publicQueriesOnly, true);
  const capture = require('./railgun-log-capture-data').readRailgunLogCapture(logsDirectory);
  const names = [
    ...new Set([
      'scripts/qualify-railgun-txid-coverage.js',
      'scripts/railgun-log-capture-data.js',
      ...Object.keys(
        require('../docs/qualification/railgun-account-txid-live-2026-10-03.json').sourceSha256
      ),
      ...require('../src/main/wallet/railgun-txid-policy').SOURCES.map(
        (name) => 'src/main/wallet/' + name + '.js'
      ),
    ]),
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    );
  const sourceSha256 = hashes();
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'coverage-fixture',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  const policy = '9'.repeat(64),
    binding = '8'.repeat(64),
    filename = path.join(output, 'txid-' + policy + '.sqlite');
  let worker, runner, storeId;
  const close = async () => {
    runner?.close();
    worker?.close();
    if (worker) await worker.closed;
  };
  async function open(create) {
    worker = require('../src/main/wallet/railgun-session-worker').startRailgunSessionWorker({
      handle,
      storage: { format: 'paged-v2', filename, key: Buffer.alloc(32, 87), binding, create },
      createProvider: ({ signal }) => ({
        signal,
        request: async () => {
          throw Error('No RPC');
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
      binding,
      policy,
    });
  }
  try {
    await open(true);
    let state = (await runner.run('inspect', {})).value.state;
    for (const page of txids.pages) {
      if (state.count > txids.checkpoint.index) break;
      assert.match(page.filename, /^\d{5}\.json$/);
      const bytes = fs.readFileSync(path.join(txidsDirectory, page.filename));
      assert.equal(sha(bytes), page.sha256);
      const rows = JSON.parse(bytes).transactions.slice(
        0,
        txids.checkpoint.index + 1 - state.count
      );
      const projected = await runner.run('project', { base: state, rows });
      state = (await runner.run('apply', { base: state, rows, expected: projected.value.state }))
        .value.state;
      console.log(JSON.stringify({ count: state.count }));
    }
    assert.equal(state.count, txids.checkpoint.index + 1);
    assert.equal(state.root, txids.checkpoint.root);
    const before = await worker.inspectWalletState();
    worker.assertFresh(before);
    const plan = {
      to: capture.report.anchor,
      source: { ledgerId: 'a'.repeat(64), ledgerSha256: capture.logSetSha256 },
    };
    const source = (mode = 'normal') => ({
      signal: scope.signal,
      visit: async (visitor) => {
        for (const log of capture.logs()) {
          if (
            mode === 'missing-known-event' &&
            log.transactionHash ===
              '0x4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932' &&
            log.logIndex === 98
          )
            continue;
          await visitor(log);
        }
        if (mode === 'late-integrity-failure') throw Error('Controlled source integrity failure');
      },
    });
    const payload = { state, plan },
      started = performance.now();
    const baseline = await runner.run('coverage', payload, source());
    const elapsedMs = performance.now() - started;
    assert.deepEqual(runner.assertResult(baseline.receipt, 'coverage', payload), baseline.value);
    assert.throws(() => runner.assertResult({}, 'coverage', payload));
    assert.equal(baseline.value.coverage.checkedCount, 4214);
    assert.equal(baseline.value.coverage.omissions.length, 1);
    assert.equal(baseline.value.coverage.discrepancy, null);
    assert.equal(baseline.value.guards.attempts, 0);
    assert.deepEqual(await worker.inspectWalletState(), before);
    const missing = await runner.run('coverage', payload, source('missing-known-event'));
    assert.equal(missing.value.coverage.checkedCount, 4188);
    assert.notEqual(missing.value.coverage.discrepancy, null);
    assert.equal(
      missing.value.coverage.discrepancy.txid,
      '4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932'
    );
    assert.throws(() => runner.assertResult(baseline.receipt, 'coverage', payload));
    assert.deepEqual(await worker.inspectWalletState(), before);
    await assert.rejects(() => runner.run('coverage', payload, source('late-integrity-failure')));
    await close();
    await open(false);
    assert.deepEqual(await worker.inspectWalletState(), before);
    const cold = await runner.run('coverage', payload, source());
    assert.deepEqual(cold.value.coverage, baseline.value.coverage);
    await assert.rejects(() =>
      runner.run(
        'coverage',
        { ...payload, state: { ...state, transcript: '0'.repeat(64) } },
        source()
      )
    );
    await close();
    await open(false);
    assert.deepEqual(await worker.inspectWalletState(), before);
    assert.deepEqual(hashes(), sourceSha256);
    const report = {
      observedAt: new Date().toISOString(),
      sourceSha256,
      txidCaptureSha256: sha(txidBytes),
      logSetSha256: capture.logSetSha256,
      anchor: capture.report.anchor,
      engineInventory: baseline.value.inventory,
      guards: baseline.value.guards,
      elapsedMs,
      coverage: baseline.value.coverage,
      missingKnownEvent: missing.value.coverage,
      store: before,
      coldRestore: true,
      unchangedStore: true,
      staleAndForgedReceiptsRefused: true,
      lateSourceFailureRefused: true,
      changedTranscriptRefused: true,
      enrolledCoverageQualified: false,
      liveRootQualified: false,
      globalTxidCompleteness: false,
      submissions: 0,
      passed: true,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ passed: true, checkedCount: report.coverage.checkedCount, elapsedMs })
    );
  } finally {
    await close();
    scope.close();
  }
}
main().then(
  () => app.exit(0),
  (error) => {
    console.error(error.stack);
    app.exit(1);
  }
);
