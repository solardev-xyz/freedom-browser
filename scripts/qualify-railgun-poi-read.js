/** Public-note POI qualification: real signed event, live Tor service reads and
 * actual guarded Electron Poseidon membership verification. Dedicated Arti uses
 * an endpoint shim; no wallet ownership/enrollment or spending is qualified.
 * electron script ARCHIVE NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { openLiveTransport } = require('./qualify-ppv2-live');
async function main() {
  const [archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok([archive, output].every(path.isAbsolute) && !fs.existsSync(output));
  app.setPath('userData', path.join(output, 'electron'));
  app.dock?.hide();
  await app.whenReady();
  const names = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-poi-read.js',
    'scripts/qualify-ppv2-live.js',
    'scripts/fixtures/railgun-poi-signed-event.json',
    ...[
      'poi-source',
      'poi-records',
      'poi-membership',
      'poi-job',
      'engine-runtime',
      'process',
      'process-entry',
      'process-guards',
    ].map((n) => 'src/main/wallet/railgun-' + n + '.js'),
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/networks/privacy-context.js',
    'src/main/networks/wallet-tor-transport.js',
    'src/main/networks/isolated-socks.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      names.map((n) => [
        n,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', n)))
          .digest('hex'),
      ])
    );
  const report = {
    observedAt: new Date().toISOString(),
    sourceSha256: hashes(),
    publicQueriesOnly: true,
    accountsOpened: 0,
    submissions: 0,
    spendingEnabled: false,
    torManager: 'qualification-only-endpoint-shim',
    circuitIsolationQualified: false,
    enrolledPoiQualified: false,
    passed: false,
  };
  const overrides = ['../src/main/tor-manager', '../src/main/settings-store'].map(require.resolve);
  const saved = overrides.map((n) => require.cache[n]);
  let client,
    source,
    stage = 'tor';
  try {
    client = await openLiveTransport(output, console.log, 'sentio');
    report.transport = client.metadata;
    for (const [index, exports] of [
      [0, { getWalletSocksEndpoint: () => client.endpoint }],
      [1, { isWalletTorExperimentAvailable: () => true }],
    ])
      require.cache[overrides[index]] = {
        id: overrides[index],
        filename: overrides[index],
        loaded: true,
        exports,
      };
    const event = require('./fixtures/railgun-poi-signed-event.json')[0].signedPOIEvent;
    const notes = [{ blindedCommitment: event.blindedCommitment, type: event.type }];
    const handle = client.scope.getContext({
      kind: 'private-account',
      principal: 'railgun:0',
      protocol: 'railgun',
      deployment: 'sepolia',
      chainId: 11155111,
      role: 'poi',
      operation: 'poi:' + '7'.repeat(64),
    });
    source = require('../src/main/wallet/railgun-poi-source').createRailgunPoiSource({
      handle,
      notes,
    });
    stage = 'service';
    let started = Date.now();
    const acquired = await source.acquire();
    report.serviceMs = Date.now() - started;
    report.serviceObservation = source.assertResult(acquired.receipt);
    assert.equal(report.serviceObservation.rootsAccepted, true);
    stage = 'membership';
    started = Date.now();
    const {
      verifyRailgunPoiMembership,
      assertRailgunPoiMembership,
    } = require('../src/main/wallet/railgun-poi-membership');
    const checked = await verifyRailgunPoiMembership({
      handle,
      source,
      receipt: acquired.receipt,
      archive,
    });
    report.membershipMs = Date.now() - started;
    assert.equal(assertRailgunPoiMembership(checked.receipt, handle), checked.observation);
    report.membership = checked.observation;
    assert.equal(report.membership.membershipVerified, true);
    assert.throws(() => assertRailgunPoiMembership({}, handle));
    stage = 'negative-membership';
    report.negativeMembership = [];
    for (const kind of ['path', 'position', 'index']) {
      const proofs = JSON.parse(JSON.stringify(report.serviceObservation.proofs));
      if (kind === 'path')
        proofs[0].elements[0] =
          proofs[0].elements[0] === '0'.repeat(64) ? '1'.padStart(64, '0') : '0'.repeat(64);
      else if (kind === 'position')
        proofs[0].indices = (BigInt('0x' + proofs[0].indices) ^ 1n).toString(16).padStart(64, '0');
      else proofs[0].indices = (65536).toString(16).padStart(64, '0');
      let supplied = false,
        task;
      try {
        task = require('../src/main/wallet/railgun-process').startRailgunProcess({
          handle,
          filename: require.resolve('../src/main/wallet/railgun-poi-job'),
          input: JSON.stringify({ archive }),
          startupMs: 120000,
          lifetimeMs: 180000,
          broker: {
            signal: client.scope.signal,
            async dispatch(wire) {
              const message = JSON.parse(wire);
              assert.deepEqual(message, { id: 1, method: 'input' });
              assert.equal(supplied, false);
              supplied = true;
              return JSON.stringify({ id: 1, value: { notes, proofs } });
            },
          },
        });
        await assert.rejects(task.ready);
        assert.equal(supplied, true);
        task.close();
        const ended = await task.closed;
        assert.equal(ended.code, 'RAILGUN_PROCESS_FAILED');
        report.negativeMembership.push({ kind, refused: true });
      } finally {
        task?.close();
        if (task) await task.closed;
      }
    }
    source.close();
    assert.throws(() => assertRailgunPoiMembership(checked.receipt, handle));
    report.closedAndForgedReceiptsRefused = true;
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
  } finally {
    source?.close();
    if (client) await client.close();
    overrides.forEach((n, i) => {
      require.cache[n] = saved[i];
    });
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      failure: report.failure,
      serviceMs: report.serviceMs,
      membershipMs: report.membershipMs,
    })
  );
  return report.passed ? 0 : 1;
}
main().then(
  (code) => app.exit(code),
  () => app.exit(1)
);
