/** Read-only public Sepolia service qualification under Node. Dedicated bundled
 * Arti supplies the managed endpoint through a qualification-only module shim;
 * this does not qualify Electron's Tor manager or any wallet account lifetime.
 * node script NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { openLiveTransport } = require('./qualify-ppv2-live');
async function main() {
  const [output, treeReport] = process.argv.slice(2);
  assert.ok(process.argv.length === 3 || process.argv.length === 4);
  if (treeReport) assert.ok(path.isAbsolute(treeReport));
  assert.ok(path.isAbsolute(output) && !fs.existsSync(output));
  const sources = [
    'scripts/qualify-railgun-public-services.js',
    'scripts/qualify-ppv2-live.js',
    'src/main/wallet/railgun-public-services.js',
    'src/main/networks/wallet-tor-transport.js',
    'src/main/networks/privacy-context.js',
    'src/main/networks/isolated-socks.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      sources.map((name) => [
        name,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', name)))
          .digest('hex'),
      ])
    );
  const report = {
    observedAt: new Date().toISOString(),
    sourceSha256: hashes(),
    publicQueriesOnly: true,
    accountsOpened: 0,
    submissions: 0,
    passed: false,
    torManager: 'qualification-only-endpoint-shim',
    trust: 'unverified-service',
    pages: [],
  };
  let client,
    service,
    stage = 'tor';
  const overrides = ['../src/main/tor-manager', '../src/main/settings-store'].map((name) =>
    require.resolve(name)
  );
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
    service = require('../src/main/wallet/railgun-public-services').createRailgunPublicServices(
      client.scope.getContext({
        kind: 'service',
        principal: 'railgun-public-sync',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'public-services',
      })
    );
    stage = 'checkpoint';
    report.checkpoint = await service.latestTxid();
    assert.ok(report.checkpoint.index < 20000);
    let after = '0x00',
      count = 0;
    stage = 'indexer';
    for (let n = 0; n < 200 && count <= report.checkpoint.index; n++) {
      const started = Date.now(),
        page = await service.txidPage(after);
      assert.ok(page.transactions.length > 0);
      const filename = String(n).padStart(5, '0') + '.json';
      const bytes = JSON.stringify(page) + '\n';
      fs.writeFileSync(path.join(output, filename), bytes, { flag: 'wx', mode: 0o600 });
      report.pages.push({
        filename,
        count: page.transactions.length,
        elapsedMs: Date.now() - started,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      count += page.transactions.length;
      after = page.after;
      console.log(JSON.stringify({ page: n, count, elapsedMs: Date.now() - started }));
    }
    assert.ok(count > report.checkpoint.index);
    report.transactions = count;
    stage = 'checkpoint-recheck';
    assert.deepEqual(await service.latestTxid(), report.checkpoint);
    if (treeReport) {
      stage = 'historical-root-validation';
      const treeBytes = fs.readFileSync(treeReport),
        tree = JSON.parse(treeBytes);
      report.treeReportSha256 = createHash('sha256').update(treeBytes).digest('hex');
      assert.equal(tree.result.matches, true);
      assert.equal(tree.result.root, report.checkpoint.root);
      assert.equal(tree.result.count, report.checkpoint.index + 1);
      report.rootChecks = [];
      for (const point of [
        ...tree.result.verificationBreaks.map((value) => ({
          index: value.index - 1,
          root: value.precedingRoot,
        })),
        report.checkpoint,
      ]) {
        const checked = {
          tree: Math.floor(point.index / 65536),
          index: point.index % 65536,
          root: point.root,
        };
        const accepted = await service.validateTxidRoot(checked);
        report.rootChecks.push({ ...checked, accepted });
        assert.equal(accepted, true);
      }
    }
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
    console.error(JSON.stringify(report.failure));
  } finally {
    service?.close();
    await client?.close();
    overrides.forEach((name, i) => {
      if (saved[i]) require.cache[name] = saved[i];
      else delete require.cache[name];
    });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  return report.passed;
}
main().then(
  (passed) => {
    process.exitCode = passed ? 0 : 1;
  },
  () => {
    console.error('Railgun service qualification refused');
    process.exitCode = 1;
  }
);
