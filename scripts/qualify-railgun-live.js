/** Read-only enrolled Railgun acquisition through managed Tor. Uses an existing
 * disposable qualification vault; never creates/replaces a vault or submits a tx.
 * electron script archive profile anchor-report new-output mode [range-limit] [txid-page-limit]
 * mode: enroll (first account), new (rebuild), pending (resume), active (continue).
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app, safeStorage } = require('electron');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
let lock,
  cancelLive = () => app.exit(1);
process.on('unhandledRejection', () => {
  console.error('Railgun qualification background failure');
  cancelLive();
});
async function main() {
  const [archive, profileDirectory, anchorFilename, output, mode, limitText, txidText] =
    process.argv.slice(2);
  assert.ok(
    process.argv.length <= 9 &&
      [archive, profileDirectory, anchorFilename, output].every(
        (v) => typeof v === 'string' && path.isAbsolute(v)
      )
  );
  assert.ok(['enroll', 'new', 'pending', 'active'].includes(mode));
  const limit = limitText === undefined ? 1000 : Number(limitText);
  assert.ok(Number.isSafeInteger(limit) && limit >= 1 && limit <= 2000);
  const txidLimit = txidText === undefined ? 0 : Number(txidText);
  assert.ok(Number.isSafeInteger(txidLimit) && txidLimit >= 0 && txidLimit <= 100);
  assert.ok(!app.isPackaged && process.env.FREEDOM_WALLET_TOR_EXPERIMENT === '1');
  assert.ok(
    !process.env.FREEDOM_IDENTITY_DATA && fs.realpathSync(profileDirectory) === profileDirectory
  );
  assert.ok(
    !fs.existsSync(
      path.join(profileDirectory, require('../src/main/networks/direct-testnet-transport').MARKER)
    )
  );
  assert.ok(!fs.existsSync(output));
  fs.mkdirSync(output, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: profileDirectory },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => cancelLive() });
  app.dock?.hide();
  await app.whenReady();
  const marker = JSON.parse(
    fs.readFileSync(path.join(profileDirectory, 'railgun-test-profile.json'))
  );
  assert.ok(
    marker.version === 1 &&
      marker.disposable === true &&
      marker.chainId === 11155111 &&
      marker.profileId === profile.id
  );
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux')
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const baseline = JSON.parse(fs.readFileSync(anchorFilename));
  assert.equal(baseline.chainId, 11155111);
  const anchor = baseline.anchor;
  assert.ok(
    Number.isSafeInteger(anchor.number) &&
      anchor.number >= 5784866 &&
      /^0x[0-9a-f]{64}$/.test(anchor.hash)
  );
  const vault = require('../src/main/identity/vault'),
    tor = require('../src/main/tor-manager');
  const vaultDirectory = path.join(profileDirectory, 'identity');
  assert.ok(vault.vaultExists(vaultDirectory));
  const report = {
    observedAt: new Date().toISOString(),
    harnessSha256: createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    chainId: 11155111,
    anchor,
    mode,
    liveAcquisition: true,
    trust: 'unverified-rpc',
    transport: null,
    rpcProviderCount: 1,
    circuitIsolationQualified: false,
    signingEnabled: false,
    submissions: 0,
    completed: false,
    ranges: [],
  };
  let identity,
    enrollment,
    publicAccount,
    wallet,
    txid,
    rpc,
    stage = 'unlock',
    failed = false;
  const qualifiedSources = Object.keys(
    require('../docs/qualification/railgun-public-generations-2026-10-03.json').sourceSha256
  );
  const sources = [
    ...new Set([
      ...qualifiedSources,
      'scripts/qualify-railgun-live.js',
      'src/main/networks/private-rpc.js',
      'src/main/networks/wallet-tor-transport.js',
      'src/main/tor-manager.js',
      ...(txidLimit
        ? [
            'src/main/wallet/railgun-account-txid.js',
            'src/main/wallet/railgun-account-phase.js',
            ...require('../src/main/wallet/railgun-txid-policy').SOURCES.map(
              (name) => 'src/main/wallet/' + name + '.js'
            ),
          ]
        : []),
    ]),
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
  report.sourceSha256 = hashes();
  const save = () =>
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
  cancelLive = () => {
    failed = true;
    publicAccount?.close().catch(() => {});
    enrollment?.close();
    vault.lockVault();
    tor.stopTor();
    setTimeout(() => app.exit(1), 3000).unref();
  };
  try {
    let password = safeStorage.decryptString(
      fs.readFileSync(path.join(profileDirectory, 'qualification-password.bin'))
    );
    await vault.unlockVault(vaultDirectory, password, 0);
    password = undefined;
    stage = 'identity';
    identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
      archive,
    });
    enrollment =
      await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment({
        identity,
        create: mode === 'enroll',
      });
    const registry = require('../src/main/networks/network-registry');
    assert.ok(
      registry.addCustomChain(
        {
          chainId: 11155111,
          name: 'Sepolia disposable privacy test',
          nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
        },
        ['https://sepolia.rpc.sentio.xyz']
      ).success
    );
    registry.updateNetwork(11155111, {
      access: { readOrder: ['direct'], allowDirect: true },
      quorum: { timeoutMs: 45000 },
    });
    stage = 'tor';
    await tor.startTor();
    const started = Date.now();
    while (!tor.getWalletSocksEndpoint()) {
      assert.ok(!failed && Date.now() - started < 180000);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    report.torBootstrapMs = Date.now() - started;
    stage = 'anchor';
    rpc = require('../src/main/networks/private-rpc').createPrivateRpc(
      enrollment.getContext('protocol-rpc'),
      'protocol-rpc'
    );
    const read = async (method, params) => (await rpc.request(method, params, () => true)).result;
    const finalized = await read('eth_getBlockByNumber', ['finalized', false]);
    assert.ok(Number(BigInt(finalized.number)) >= anchor.number);
    const selected = await read('eth_getBlockByNumber', ['0x' + anchor.number.toString(16), false]);
    assert.equal(selected.hash, anchor.hash);
    report.rpcHosts = rpc.trust.queried;
    report.transport = rpc.privacy;
    stage = 'public-open';
    publicAccount =
      await require('../src/main/wallet/railgun-account-public').openRailgunAccountPublic({
        enrollment,
        archive,
        create: ['enroll', 'new'].includes(mode),
        mode: mode === 'enroll' ? 'new' : mode,
      });
    report.publicPolicy = publicAccount.policy;
    report.generationId = publicAccount.generationId;
    let status = await publicAccount.coordinator.recover();
    report.initialThrough = status.to?.number ?? -1;
    stage = 'scan';
    for (let n = 0; n < limit && (status.to?.number ?? -1) < anchor.number; n++) {
      const from = (status.to?.number ?? -1) + 1;
      const to = Math.min(anchor.number, from + (from < 5700000 ? 100000 : 20000) - 1);
      const rangeStarted = Date.now();
      // Qualification-only last resort: preserve a failed observation if an
      // underlying drain ever stops settling. Never turn a timeout into success
      // or reuse a capability whose work has not drained.
      const watchdog = setTimeout(() => {
        report.passed = false;
        report.failure = { stage, code: 'QUALIFICATION_SCAN_STALLED', from, to };
        save();
        cancelLive();
      }, 600000);
      try {
        status = await publicAccount.advance({ to, anchor });
        assert.ok(!failed);
      } finally {
        clearTimeout(watchdog);
      }
      const range = { from, to, elapsedMs: Date.now() - rangeStarted };
      report.ranges.push(range);
      report.scannedThrough = to;
      save();
      console.log(JSON.stringify(range));
    }
    if (status.to?.number === anchor.number) {
      stage = 'public-root';
      const snapshot = await publicAccount.coordinator.withPublicSnapshot(() => undefined);
      const plan = publicAccount.coordinator.assertSnapshot(snapshot.evidence);
      const { Interface } = require('ethers');
      const abi = new Interface(['function merkleRoot() view returns (bytes32)']);
      const result = await read('eth_call', [
        { to: baseline.code.proxy.address, data: abi.encodeFunctionData('merkleRoot') },
        { blockHash: anchor.hash, requireCanonical: true },
      ]);
      assert.equal(abi.decodeFunctionResult('merkleRoot', result)[0], plan.state.trees.at(-1).root);
      report.publicState = plan.state;
      if (txidLimit) {
        stage = 'txid';
        const openTxid = (create) =>
          require('../src/main/wallet/railgun-account-txid').openRailgunAccountTxid({
            enrollment,
            archive,
            coordinator: publicAccount.coordinator,
            create,
          });
        const bounded = async (run) => {
          const watchdog = setTimeout(() => {
            report.passed = false;
            report.failure = { stage, code: 'QUALIFICATION_TXID_STALLED' };
            save();
            cancelLive();
          }, 600000);
          try {
            return await run();
          } finally {
            clearTimeout(watchdog);
          }
        };
        txid = await bounded(() => openTxid(true));
        const initial = await txid.inspect();
        report.txid = {
          policy: txid.policy,
          publicIdentity: txid.publicIdentity,
          initialCount: initial.checkpoint?.state.count ?? 0,
          pages: [],
          coldReopens: 0,
          independentEventCoverage: false,
          globalTxidCompleteness: false,
          spendingEnabled: false,
        };
        for (let n = 0; n < txidLimit; n++) {
          const pageStarted = Date.now();
          const value = await bounded(() => txid.advance());
          assert.ok(value.checkpoint && !value.pending);
          const page = {
            count: value.checkpoint.state.count,
            root: value.checkpoint.state.root,
            transcript: value.checkpoint.state.transcript,
            serviceLatestIndex: value.serviceLatestIndex,
            capacityReached: value.capacityReached,
            elapsedMs: Date.now() - pageStarted,
          };
          report.txid.pages.push(page);
          save();
          console.log(JSON.stringify({ txid: page }));
          if (n === 0 || n === 1) {
            await bounded(() => txid.close());
            txid = await bounded(() => openTxid(false));
            const cold = await txid.inspect();
            assert.deepEqual(cold.checkpoint, value.checkpoint);
            report.txid.coldReopens++;
          }
          if (page.capacityReached || page.count === page.serviceLatestIndex + 1) break;
        }
        const final = await txid.inspect();
        report.txid.checkpoint = final.checkpoint;
        await bounded(() => txid.close());
        txid = await bounded(() => openTxid(false));
        assert.deepEqual((await txid.inspect()).checkpoint, final.checkpoint);
        report.txid.coldReopens++;
        await bounded(() => txid.close());
        txid = null;
        report.txid.completed = true;
        save();
      }
      stage = 'wallet';
      const walletPolicy =
        require('../src/main/wallet/railgun-account-wallet').getRailgunAccountWalletPolicy({
          archive,
          enrollment,
          coordinator: publicAccount.coordinator,
        });
      const walletCatalog = await enrollment.catalog.inspect();
      const walletMode =
        walletCatalog.pending?.policy === walletPolicy
          ? 'pending'
          : mode === 'active' && enrollment.catalog.activeFor(walletPolicy)
            ? 'advance'
            : 'new';
      wallet = await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
        identity,
        enrollment,
        archive,
        coordinator: publicAccount.coordinator,
        mode: walletMode,
      });
      const walletStatus = await wallet.view.status();
      report.wallet = {
        status: walletStatus.status,
        to: walletStatus.to,
        poi: walletStatus.poi,
        spendableGranted: false,
        assetCount: (await wallet.view.balance()).length,
      };
      report.completed = true;
    }
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = !failed;
  } catch (error) {
    report.passed = false;
    report.failure ??= {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
    console.error(JSON.stringify(report.failure));
  } finally {
    await wallet?.close();
    await txid?.close();
    await publicAccount?.close();
    rpc?.release();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    tor.stopTor();
    save();
  }
  return report.passed ? 0 : 1;
}
main().then(
  (code) => {
    if (lock) releaseProfileLock(lock);
    app.exit(code);
  },
  () => {
    cancelLive();
    if (lock) releaseProfileLock(lock);
    app.exit(1);
  }
);
