/** Live public-only root-receipt qualification. Dedicated bundled Arti and a
 * qualification-only endpoint shim; no Electron-manager/account qualification.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { openLiveTransport } = require('./qualify-ppv2-live');
const sha = (v) => createHash('sha256').update(v).digest('hex');
async function main() {
  const [treeFilename, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok([treeFilename, output].every(path.isAbsolute) && !fs.existsSync(output));
  const bytes = fs.readFileSync(treeFilename),
    tree = JSON.parse(bytes);
  assert.equal(tree.passed, true);
  assert.equal(tree.result.matches, true);
  const point = { index: tree.result.count - 1, root: tree.result.root };
  const names = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-txid-root.js',
    'scripts/qualify-ppv2-live.js',
    'src/main/wallet/railgun-txid-root.js',
    'src/main/wallet/railgun-public-services.js',
    'src/main/networks/wallet-tor-transport.js',
    'src/main/networks/isolated-socks.js',
    'src/main/networks/privacy-context.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((name) => [name, sha(fs.readFileSync(path.join(__dirname, '..', name)))])
    );
  const report = {
    observedAt: new Date().toISOString(),
    sourceSha256: hashes(),
    projectionReportSha256: sha(bytes),
    point,
    publicQueriesOnly: true,
    accountsOpened: 0,
    submissions: 0,
    globalTxidCompleteness: false,
    passed: false,
    torManager: 'qualification-only-endpoint-shim',
    trust: 'unverified-service',
  };
  let client,
    source,
    stage = 'tor';
  const overrides = ['../src/main/tor-manager', '../src/main/settings-store'].map(require.resolve);
  const saved = overrides.map((name) => require.cache[name]);
  try {
    client = await openLiveTransport(output, console.log, 'sentio');
    report.transport = client.metadata;
    require.cache[overrides[0]] = {
      id: overrides[0],
      filename: overrides[0],
      loaded: true,
      exports: { getWalletSocksEndpoint: () => client.endpoint },
    };
    require.cache[overrides[1]] = {
      id: overrides[1],
      filename: overrides[1],
      loaded: true,
      exports: { isWalletTorExperimentAvailable: () => true },
    };
    source = require('../src/main/wallet/railgun-txid-root').createRailgunTxidRootSource(
      client.scope.getContext({
        kind: 'service',
        principal: 'railgun-public-sync',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'public-services',
      })
    );
    stage = 'root-acceptance';
    const receipt = await source.acquire(point);
    report.acceptance = source.assertRoot(receipt, point);
    const knownBreak = tree.result.verificationBreaks[0];
    assert.ok(knownBreak);
    const historicalPoint = { index: knownBreak.index - 1, root: knownBreak.precedingRoot };
    stage = 'historical-root-acceptance';
    const historicalReceipt = await source.acquire(historicalPoint);
    report.historicalAcceptance = source.assertRoot(historicalReceipt, historicalPoint);
    assert.throws(() => source.assertRoot({}, point));
    assert.throws(() => source.assertRoot(receipt, { ...point, index: point.index - 1 }));
    stage = 'changed-root-rejection';
    await assert.rejects(
      // Use an older index so refusal comes from validateTxidRoot, rather
      // than only comparing with the latest checkpoint's advertised root.
      () => source.acquire({ index: historicalPoint.index, root: '0'.repeat(64) }),
      (error) => error.code === 'RAILGUN_TXID_ROOT_REJECTED'
    );
    assert.throws(() => source.assertRoot(receipt, point));
    report.changedRootRejected = true;
    report.rejectedPoint = { index: historicalPoint.index, root: '0'.repeat(64) };
    report.forgedAndWrongPointRefused = true;
    report.closedSourceRevokesReceipt = true;
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
  } finally {
    source?.close();
    await client?.close();
    overrides.forEach((name, n) => {
      if (saved[n]) require.cache[name] = saved[n];
      else delete require.cache[name];
    });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure }));
  return report.passed ? 0 : 1;
}
main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    console.error('Railgun root qualification refused');
    process.exitCode = 1;
  }
);
