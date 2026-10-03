/** Offline guarded recomputation of a captured public TXID tree/checkpoint. */
const { app } = require('electron');
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const sha = (value) => createHash('sha256').update(value).digest('hex');
async function main() {
  const [capture, archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 5);
  assert.ok([capture, archive, output].every(path.isAbsolute));
  assert.ok(!fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  app.setPath('userData', path.join(output, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const bytes = fs.readFileSync(path.join(capture, 'report.json')),
    source = JSON.parse(bytes);
  assert.equal(source.passed, true);
  assert.equal(source.publicQueriesOnly, true);
  const names = [
    'scripts/qualify-railgun-txid-tree.js',
    'scripts/fixtures/railgun-txid-tree-job.js',
    'src/main/wallet/railgun-process.js',
    'src/main/wallet/railgun-process-entry.js',
    'src/main/wallet/railgun-process-guards.js',
    'src/main/wallet/railgun-engine-runtime.js',
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/wallet/railgun-public-records.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    );
  const sourceSha256 = hashes();
  const { createPrivacyScope } = require('../src/main/networks/privacy-context');
  const scope = createPrivacyScope({
    profileId: 'railgun-public-txid-tree',
    signal: new AbortController().signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'public-chain-fixture',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    role: 'engine',
  });
  let task,
    result,
    nextPage = 0,
    lastId = 0;
  try {
    task = require('../src/main/wallet/railgun-process').startRailgunProcess({
      handle,
      startupMs: 120000,
      lifetimeMs: 180000,
      heapMb: 256,
      rssMb: 768,
      filename: require.resolve('./fixtures/railgun-txid-tree-job'),
      input: JSON.stringify({ archive, checkpoint: source.checkpoint, pages: source.pages.length }),
      broker: {
        signal: scope.signal,
        dispatch: async (wire) => {
          const message = JSON.parse(wire);
          assert.equal(message.id, ++lastId);
          if (message.method === 'page') {
            assert.equal(message.page, nextPage++);
            assert.equal(result, undefined);
            const entry = source.pages[message.page];
            assert.ok(entry && /^\d{5}\.json$/.test(entry.filename));
            const page = fs.readFileSync(path.join(capture, entry.filename));
            assert.equal(sha(page), entry.sha256);
            return JSON.stringify({ id: message.id, value: JSON.parse(page) });
          }
          assert.equal(message.method, 'result');
          assert.equal(result, undefined);
          result = message.value;
          return JSON.stringify({ id: message.id, value: null });
        },
      },
    });
    await task.ready;
    task.close();
    const closed = await task.closed;
    assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
    assert.ok(result && result.guards.attempts === 0);
    assert.deepEqual(hashes(), sourceSha256);
    const report = {
      observedAt: new Date().toISOString(),
      sourceSha256,
      captureSha256: sha(bytes),
      result,
      closed,
      trust: 'indexer-poi-consistency-only',
      passed: result.matches && result.verificationHashChain,
      globalTxidCompleteness: false,
      accountsOpened: 0,
      submissions: 0,
    };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ count: result.count, matches: result.matches, root: result.root })
    );
    return result.matches && result.verificationHashChain ? 0 : 1;
  } finally {
    task?.close();
    if (task) await task.closed;
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
