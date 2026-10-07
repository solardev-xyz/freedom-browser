/** Read-only recovery of the first finalized live shield and its owned-note POI.
 * Only aggregate results leave this process. Never report private note keys,
 * blinded commitments, proofs or membership events.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron script ARCHIVE PROFILE SCAN_REPORT SCAN_SHA256 NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app, safeStorage } = require('electron');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const { openLiveTransport } = require('./qualify-ppv2-live');
let lock;
async function main() {
  const [archive, directory, scanFile, scanSha, output] = process.argv.slice(2);
  assert.equal(process.argv.length, 7);
  assert.ok([archive, directory, scanFile, output].every(path.isAbsolute));
  assert.match(scanSha, /^[0-9a-f]{64}$/);
  const scanBytes = fs.readFileSync(scanFile);
  assert.equal(createHash('sha256').update(scanBytes).digest('hex'), scanSha);
  const scan = JSON.parse(scanBytes);
  assert.equal(scan.passed, true);
  assert.equal(scan.completed, true);
  assert.equal(scan.chainId, 11155111);
  assert.equal(scan.txid?.independentEventCoverage, true);
  for (const [name, expected] of Object.entries(scan.sourceSha256)) {
    assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'));
    assert.equal(
      createHash('sha256')
        .update(fs.readFileSync(path.join(__dirname, '..', name)))
        .digest('hex'),
      expected
    );
  }
  assert.ok(
    !app.isPackaged &&
      process.env.FREEDOM_WALLET_TOR_EXPERIMENT === '1' &&
      !process.env.FREEDOM_IDENTITY_DATA
  );
  assert.equal(fs.realpathSync(directory), directory);
  assert.ok(!fs.existsSync(output));
  assert.ok(
    !fs.existsSync(
      path.join(directory, require('../src/main/networks/direct-testnet-transport').MARKER)
    )
  );
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: directory },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'railgun-test-profile.json'))), {
    version: 1,
    chainId: 11155111,
    profileId: profile.id,
    disposable: true,
  });
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux')
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const vault = require('../src/main/identity/vault');
  assert.ok(vault.vaultExists(path.join(directory, 'identity')));
  fs.mkdirSync(output, { mode: 0o700 });
  const names = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    ...new Set([
      ...Object.keys(scan.sourceSha256),
      ...Object.keys(
        require('../docs/qualification/railgun-live-event-coverage-2026-10-03.json').sourceSha256
      ),
      ...Object.keys(
        require('../docs/qualification/railgun-shield-submission-2026-10-03.json').sourceSha256
      ),
      'scripts/qualify-railgun-owned-poi-live.js',
      'scripts/qualify-ppv2-live.js',
      ...[
        'account-poi',
        'owned-poi-records',
        'poi-source',
        'poi-records',
        'poi-membership',
        'poi-job',
      ].map((n) => 'src/main/wallet/railgun-' + n + '.js'),
      'src/main/wallet/signers.js',
      'src/main/wallet/vault-access.js',
    ]),
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
    chainId: 11155111,
    sourceSha256: hashes(),
    scanReportSha256: scanSha,
    transport: 'qualification-only Tor endpoint shim',
    circuitIsolationQualified: false,
    submissions: 0,
    spendingEnabled: false,
    passed: false,
  };
  const torModule = require.resolve('../src/main/tor-manager'),
    savedTor = require.cache[torModule];
  let client,
    identity,
    enrollment,
    publicAccount,
    wallet,
    operation,
    recovery,
    stage = 'unlock';
  try {
    let password = safeStorage.decryptString(
      fs.readFileSync(path.join(directory, 'qualification-password.bin'))
    );
    await vault.unlockVault(path.join(directory, 'identity'), password, 0);
    password = undefined;
    const owner = (
      await require('../src/main/wallet/signers').getSigner(0).getAddress()
    ).toLowerCase();
    const registry = require('../src/main/networks/network-registry');
    assert.equal(
      registry.addCustomChain(
        {
          chainId: 11155111,
          name: 'Sepolia owned POI qualification',
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
    report.tor = client.metadata;
    require.cache[torModule] = {
      id: torModule,
      filename: torModule,
      loaded: true,
      exports: { getWalletSocksEndpoint: () => client.endpoint },
    };
    stage = 'shield-recovery';
    recovery = require('../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
      owner
    );
    const records = await recovery.list();
    assert.equal(records.length, 1);
    const observed = await recovery.observe(records[0].hash);
    assert.equal(observed.shield?.status, 'matched');
    const resolved = (await recovery.list()).find((r) => r.hash === records[0].hash);
    assert.equal(resolved?.resolution?.railgun?.outcome, 'matched');
    assert.deepEqual(resolved.resolution.railgun.shield, observed.shield);
    const shield = observed.shield;
    report.shieldTransactionHash = records[0].hash;
    report.finalizedShieldMatched = true;
    recovery.close();
    recovery = undefined;
    stage = 'enroll';
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive,
    });
    enrollment =
      await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment({
        identity,
        create: false,
      });
    publicAccount =
      await require('../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
        enrollment,
        archive,
        mode: 'active',
      });
    assert.equal(publicAccount.generationId, scan.generationId);
    assert.equal(publicAccount.policy, scan.publicPolicy);
    const status = await publicAccount.coordinator.recover();
    assert.deepEqual(status.to, scan.anchor);
    assert.deepEqual(scan.wallet.to, status.to);
    assert.equal(scan.wallet.assetCount, 1);
    const snapshot = await publicAccount.coordinator.withPublicSnapshot(() => undefined);
    const checked = publicAccount.coordinator.assertSnapshot(snapshot.evidence);
    assert.equal(checked.state.storeId, scan.publicState.storeId);
    assert.deepEqual(checked.state.trees, scan.publicState.trees);
    assert.ok(status.to.number >= Number(BigInt(shield.blockNumber)));
    report.publicThrough = status.to;
    stage = 'wallet-restore';
    wallet = await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
      identity,
      enrollment,
      archive,
      coordinator: publicAccount.coordinator,
      mode: 'active',
    });
    const owners = { identity, enrollment, coordinator: publicAccount.coordinator };
    const owned = require('../src/main/wallet/railgun-account-wallet').readRailgunAccountOwnedNotes(
      wallet,
      owners
    );
    assert.deepEqual(owned.read.readiness.to, status.to);
    report.walletThrough = owned.read.readiness.to;
    const id = `${shield.tree}:${shield.position}`;
    const note = owned.read.received.find((v) => v.id === id);
    const projected = owned.ownedPoi.find((v) => v.id === id);
    assert.ok(note && projected);
    assert.equal(note.spentTxid, false);
    assert.equal(note.amount, BigInt(shield.noteValue));
    assert.equal(note.asset.__type, 'erc20');
    assert.equal(note.asset.contract, shield.token);
    assert.equal(projected.npk, shield.npk);
    assert.equal(projected.type, 'Shield');
    assert.equal(projected.txid, shield.transactionHash);
    assert.equal(projected.blockNumber, Number(BigInt(shield.blockNumber)));
    report.walletRecoveredExpectedShield = true;
    stage = 'poi';
    operation = require('../src/main/wallet/railgun-account-poi').openRailgunAccountPoi({
      wallet,
      ...owners,
      archive,
      noteIds: [id],
    });
    const start = performance.now(),
      acquired = await operation.acquire();
    const value = require('../src/main/wallet/railgun-account-poi').assertRailgunAccountPoi(
      operation,
      acquired.receipt,
      wallet,
      owners
    );
    report.poi = {
      allValid:
        value.statuses.every((v) => v.status === 'Valid') &&
        value.rootsAccepted === true &&
        value.membershipVerified === true,
      selectedCount: 1,
      listKey: value.listKey,
      statuses: value.statuses.map((v) => v.status),
      rootsAccepted: value.rootsAccepted,
      membershipVerified: value.membershipVerified,
      ownershipAtSnapshot: value.ownershipAtSnapshot,
      txidProvenanceVerified: value.txidProvenanceVerified,
      reservationsChecked: value.reservationsChecked,
      spendingEnabled: value.spendingEnabled,
      elapsedMs: performance.now() - start,
    };
    await wallet.close();
    wallet = undefined;
    assert.throws(() => operation.assertResult(acquired.receipt));
    report.closedWalletPoiRefused = true;
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
  } finally {
    operation?.close();
    if (operation) await operation.closed;
    recovery?.close();
    await wallet?.close();
    await publicAccount?.close();
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
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure, poi: report.poi }));
  return report.passed ? 0 : 1;
}
main().then(
  (code) => {
    if (lock) releaseProfileLock(lock);
    app.exit(code);
  },
  () => {
    if (lock) releaseProfileLock(lock);
    console.error('Railgun owned POI qualification refused');
    app.exit(1);
  }
);
