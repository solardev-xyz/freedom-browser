/** Actual encrypted-worker/guarded-engine TXID storage qualification. Public
 * captured data and a fixture key only. No enrolled account, host TXID journal,
 * live service validation, account POI or transaction submission is exercised.
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
  const captureBytes = fs.readFileSync(path.join(capture, 'report.json')),
    source = JSON.parse(captureBytes);
  assert.equal(source.passed, true);
  assert.equal(source.publicQueriesOnly, true);
  const names = [
    'scripts/qualify-railgun-txid-storage.js',
    ...[
      'txid-runner',
      'txid-job',
      'txid-projection',
      'txid-omissions',
      'engine-runtime',
      'process',
      'process-entry',
      'process-guards',
      'session-worker',
      'session-worker-entry',
      'session',
      'paged-store',
      'remote',
      'wallet-state',
      'public-records',
    ].map((name) => 'src/main/wallet/railgun-' + name + '.js'),
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    );
  const sourceSha256 = hashes();
  const scope = require('../src/main/networks/privacy-context').createPrivacyScope({
    profileId: 'public-txid-storage-fixture',
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
  const filename = path.join(output, 'txid.sqlite');
  let worker,
    runner,
    storeId,
    replayed = false,
    oldReceipt,
    oldPayload,
    lastRows,
    lastBase;
  const close = async () => {
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
        key: Buffer.alloc(32, 89),
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
      handle,
      archive,
      session: worker,
      filename,
      binding: '8'.repeat(64),
    });
  }
  try {
    await open(true);
    let state = (await runner.run('inspect', {})).value.state;
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
      const projectPayload = { base: state, rows };
      const projected = await runner.run('project', projectPayload);
      assert.deepEqual(
        runner.assertResult(projected.receipt, 'project', projectPayload),
        projected.value
      );
      const payload = { base: state, rows, expected: projected.value.state };
      if (page === 0) {
        const before = await worker.inspectWalletState();
        await assert.rejects(() =>
          runner.run('apply', {
            ...payload,
            expected: { ...payload.expected, root: '0'.repeat(64) },
          })
        );
        await close();
        await open(false);
        assert.deepEqual(await worker.inspectWalletState(), before);
      }
      const applied = await runner.run('apply', payload);
      assert.deepEqual(applied.value.state, projected.value.state);
      assert.throws(() => runner.assertResult(projected.receipt, 'project', projectPayload));
      state = applied.value.state;
      oldReceipt = applied.receipt;
      oldPayload = payload;
      if (page === 1) {
        await close();
        await open(false);
        assert.throws(() => runner.assertResult(oldReceipt, 'apply', oldPayload));
        const before = await worker.inspectWalletState();
        await assert.rejects(() =>
          runner.run('apply', {
            ...payload,
            base: { ...payload.base, transcript: '0'.repeat(64) },
          })
        );
        await close();
        await open(false);
        assert.deepEqual(await worker.inspectWalletState(), before);
        const replay = await runner.run('apply', payload);
        assert.equal(replay.value.replayed, true);
        assert.deepEqual(replay.value.state, state);
        replayed = true;
      }
      lastRows = rows;
      lastBase = payload.base;
      console.log(JSON.stringify({ page, count: state.count }));
    }
    assert.equal(state.count, source.checkpoint.index + 1);
    assert.equal(state.root, source.checkpoint.root);
    const beforeClose = await worker.inspectWalletState();
    worker.assertFresh(beforeClose);
    await close();
    await open(false);
    const restored = await runner.run('inspect', {});
    assert.deepEqual(restored.value.state, state);
    const afterClose = await worker.inspectWalletState();
    assert.deepEqual(afterClose, beforeClose);
    const finalReplay = await runner.run('apply', {
      base: lastBase,
      rows: lastRows,
      expected: state,
    });
    assert.equal(finalReplay.value.replayed, true);
    // Byte-for-byte encrypted records survive worker/process recreation. Their
    // plaintext TXID row must not occur verbatim in the SQLite file.
    await close();
    assert.equal(fs.readFileSync(filename).includes(Buffer.from(lastRows[0].graphID)), false);
    assert.deepEqual(hashes(), sourceSha256);
    const report = {
      observedAt: new Date().toISOString(),
      sourceSha256,
      captureSha256: sha(captureBytes),
      checkpoint: source.checkpoint,
      state,
      store: beforeClose,
      replayed,
      coldRestore: true,
      staleReceiptRefused: true,
      encryptedRows: true,
      mismatchedRootRefusedBeforeMutation: true,
      alteredReplayBaseRefused: true,
      hostJournalQualified: false,
      enrolledAccountStorageQualified: false,
      globalTxidCompleteness: false,
      submissions: 0,
      passed: true,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return 0;
  } finally {
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
