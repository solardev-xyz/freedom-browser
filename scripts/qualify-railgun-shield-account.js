/** Actual disposable public-vector vault/enrollment shield preparation and live
 * Tor deployment checks. No funds or submission; dedicated Arti endpoint shim.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron script ARCHIVE NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const { openLiveTransport } = require('./qualify-ppv2-live');
let lock;
async function main() {
  const [archive, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 4);
  assert.ok([archive, output].every(path.isAbsolute) && !fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: path.join(output, 'profile') },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  const vault = require('../src/main/identity/vault');
  const names = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-shield-account.js',
    'scripts/qualify-ppv2-live.js',
    'src/main/wallet/railgun-shield-pins.json',
    ...[
      'shield-prepare',
      'shield-receive',
      'shield-receive-job',
      'shield-job',
      'shield-policy',
      'shield-preflight',
      'identity',
      'identity-job',
      'account-enrollment',
      'engine-runtime',
      'process',
      'process-entry',
      'process-guards',
    ].map((n) => 'src/main/wallet/railgun-' + n + '.js'),
    'src/main/wallet/railgun-engine-manifest.json',
    'src/main/networks/privacy-context.js',
    'src/main/networks/network-registry.js',
    'src/main/identity/vault.js',
    'src/main/settings-store.js',
    'src/main/networks/private-rpc.js',
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
    publicVector: true,
    submissions: 0,
    signingEnabled: false,
    receivePreflightQualified: false,
    torManager: 'qualification-only-endpoint-shim',
    circuitIsolationQualified: false,
    prepared: [],
    deployments: [],
    timings: [],
    passed: false,
  };
  const directory = path.join(profile.userDataDir, 'identity');
  const password = 'public-fixture-password-not-a-user-credential';
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const torModule = require.resolve('../src/main/tor-manager'),
    savedTor = require.cache[torModule];
  let client,
    identity,
    enrollment,
    preflight,
    stage = 'vault';
  try {
    await vault.importVault(directory, password, phrase);
    const registry = require('../src/main/networks/network-registry');
    assert.equal(
      registry.addCustomChain(
        {
          chainId: 11155111,
          name: 'Sepolia public shield qualification',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        },
        ['https://sepolia.rpc.sentio.xyz']
      ).success,
      true
    );
    registry.updateNetwork(11155111, {
      access: { readOrder: ['direct'], allowDirect: true },
      quorum: { timeoutMs: 45000 },
    });
    stage = 'tor';
    client = await openLiveTransport(path.join(output, 'transport'), console.log, 'sentio');
    report.transport = client.metadata;
    require.cache[torModule] = {
      id: torModule,
      filename: torModule,
      loaded: true,
      exports: { getWalletSocksEndpoint: () => client.endpoint },
    };
    const {
      prepareRailgunNativeShield,
      assertRailgunShieldPreparation,
    } = require('../src/main/wallet/railgun-shield-prepare');
    const {
      verifyRailgunShieldReceiver,
      assertRailgunShieldReceiver,
    } = require('../src/main/wallet/railgun-shield-receive');
    const {
      createRailgunShieldPreflight,
      assertRailgunShieldPreflight,
    } = require('../src/main/wallet/railgun-shield-preflight');
    for (let n = 0; n < 2; n++) {
      stage = 'enroll';
      await vault.unlockVault(directory, password, 0);
      identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
        archive,
      });
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity, create: n === 0 }
        );
      stage = 'prepare';
      const started = performance.now();
      const preparation = await prepareRailgunNativeShield({
        identity,
        enrollment,
        archive,
        amount: '100000000000000',
      });
      assert.equal(
        assertRailgunShieldPreparation(preparation.receipt, identity, enrollment),
        preparation.prepared
      );
      report.prepared.push(preparation.prepared);
      const preparedAt = performance.now();
      stage = 'receiver';
      const receiver = await verifyRailgunShieldReceiver({
        identity,
        enrollment,
        preparation: preparation.receipt,
        archive,
      });
      assert.equal(
        assertRailgunShieldReceiver(receiver, identity, enrollment, preparation.receipt),
        preparation.prepared
      );
      const receivedAt = performance.now();
      stage = 'deployment';
      preflight = createRailgunShieldPreflight(enrollment);
      const acquired = await preflight.acquire();
      report.deployments.push(
        assertRailgunShieldPreflight(preflight, acquired.receipt, enrollment)
      );
      const deploymentAt = performance.now();
      report.timings.push({
        prepareMs: preparedAt - started,
        receiveMs: receivedAt - preparedAt,
        deploymentMs: deploymentAt - receivedAt,
        totalMs: deploymentAt - started,
        preparationLifetimeMs: 120000,
      });
      stage = 'lock';
      vault.lockVault();
      assert.throws(() =>
        assertRailgunShieldPreparation(preparation.receipt, identity, enrollment)
      );
      assert.throws(() => assertRailgunShieldPreflight(preflight, acquired.receipt, enrollment));
      assert.throws(() =>
        assertRailgunShieldReceiver(receiver, identity, enrollment, preparation.receipt)
      );
      preflight.close();
      enrollment.close();
      identity.close();
    }
    assert.equal(report.prepared[0].recipient, report.prepared[1].recipient);
    assert.notEqual(report.prepared[0].npk, report.prepared[1].npk);
    assert.deepEqual(hashes(), report.sourceSha256);
    report.coldReopenAndLockRefusal = true;
    report.receivePreflightQualified = true;
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      causeCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.causeCode ?? '') ? error.causeCode : undefined,
      reason: ['rpc', 'mismatch', 'stale', 'inactive', 'refused'].includes(error.reason)
        ? error.reason
        : undefined,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
      step: /^[a-zA-Z-]+$/.test(error.step ?? '') ? error.step : undefined,
    };
  } finally {
    preflight?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    if (client) await client.close();
    require.cache[torModule] = savedTor;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      failure: report.failure,
      prepared: report.prepared.length,
      deployments: report.deployments.length,
    })
  );
  return report.passed ? 0 : 1;
}
main().then(
  (code) => {
    if (lock) releaseProfileLock(lock);
    app.exit(code);
  },
  () => {
    if (lock) releaseProfileLock(lock);
    app.exit(1);
  }
);
