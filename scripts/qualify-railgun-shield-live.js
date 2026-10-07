/** One bounded live shield from the already-funded disposable Railgun profile.
 * Requires a completed, source-matched public/TXID/wallet scan qualification.
 * Recovery works separately after preparation expires. No automatic send retry.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron script ARCHIVE PROFILE FUNDING_REPORT SCAN_REPORT NEW_OUTPUT check|shield|observe SCAN_SHA256 FUNDING_OBSERVATION FUNDING_SHA256
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app, safeStorage } = require('electron');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const { openLiveTransport } = require('./qualify-ppv2-live');
const AMOUNT = '1000000000000000',
  MAX_GAS_FEE = 2000000000000000n,
  GAS_LIMIT = 1100000n;
let lock;
async function main() {
  const [
    archive,
    directory,
    fundingFile,
    scanFile,
    output,
    mode,
    scanSha,
    fundingObservationFile,
    fundingSha,
  ] = process.argv.slice(2);
  assert.equal(process.argv.length, 11);
  assert.ok(['check', 'shield', 'observe'].includes(mode));
  assert.ok(
    !app.isPackaged &&
      process.env.FREEDOM_WALLET_TOR_EXPERIMENT === '1' &&
      !process.env.FREEDOM_IDENTITY_DATA
  );
  assert.ok(
    [archive, directory, fundingFile, scanFile, output, fundingObservationFile].every(
      path.isAbsolute
    )
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
  const marker = JSON.parse(fs.readFileSync(path.join(directory, 'railgun-test-profile.json')));
  assert.deepEqual(marker, {
    version: 1,
    chainId: 11155111,
    profileId: profile.id,
    disposable: true,
  });
  const funding = JSON.parse(fs.readFileSync(fundingFile));
  assert.equal(funding.profileDirectory, directory);
  assert.equal(funding.profileId, profile.id);
  assert.equal(funding.disposable, true);
  assert.equal(funding.chainId, 11155111);
  assert.equal(funding.walletIndex, 0);
  assert.equal(funding.signer, 'vault-backed');
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux')
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const vault = require('../src/main/identity/vault');
  assert.ok(vault.vaultExists(path.join(directory, 'identity')));
  const pinnedReport = (filename, expected) => {
    assert.match(expected, /^[0-9a-f]{64}$/);
    const bytes = fs.readFileSync(filename);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    return JSON.parse(bytes);
  };
  const scan = pinnedReport(scanFile, scanSha);
  const fundingObservation = pinnedReport(fundingObservationFile, fundingSha);
  assert.equal(fundingObservation.passed, true);
  assert.equal(fundingObservation.mode, 'observe');
  assert.equal(fundingObservation.chainId, 11155111);
  assert.equal(fundingObservation.to, funding.address);
  assert.equal(
    fundingObservation.destinationSha256,
    createHash('sha256').update(fs.readFileSync(fundingFile)).digest('hex')
  );
  assert.equal(fundingObservation.amount, '10000000000000000');
  assert.equal(fundingObservation.resolved?.hash, fundingObservation.observation?.hash);
  assert.match(fundingObservation.resolved?.hash, /^0x[0-9a-f]{64}$/);
  assert.equal(fundingObservation.resolved.observation.status, 'included');
  assert.ok(fundingObservation.resolved.observation.confirmations >= 12);
  assert.ok(fundingObservation.resolved.resolution);
  assert.equal(fundingObservation.resolved.ordinary.to, funding.address);
  const base = path.join(__dirname, '..');
  const sha = (n) => {
    assert.ok(typeof n === 'string' && !path.isAbsolute(n) && !n.split('/').includes('..'));
    return createHash('sha256')
      .update(fs.readFileSync(path.join(base, n)))
      .digest('hex');
  };
  if (mode !== 'observe') {
    assert.equal(scan.passed, true);
    assert.equal(scan.completed, true);
    assert.equal(scan.chainId, 11155111);
    assert.equal(scan.txid?.independentEventCoverage, true);
    assert.equal(scan.wallet?.status, 'wallet-scanned-unverified');
    assert.equal(scan.wallet.assetCount, 0);
    for (const [name, hash] of Object.entries(scan.sourceSha256)) {
      assert.ok(!path.isAbsolute(name) && !name.split('/').includes('..'));
      assert.equal(sha(name), hash);
    }
  }
  const sources = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    ...new Set([
      ...Object.keys(
        require('../docs/qualification/railgun-shield-submission-2026-10-03.json').sourceSha256
      ),
      ...Object.keys(scan.sourceSha256),
      'scripts/qualify-railgun-shield-live.js',
      'src/main/wallet/signers.js',
      'src/main/wallet/vault-access.js',
    ]),
  ];
  const hashes = () => Object.fromEntries(sources.map((name) => [name, sha(name)]));
  fs.mkdirSync(output, { mode: 0o700 });
  const report = {
    observedAt: new Date().toISOString(),
    mode,
    chainId: 11155111,
    from: funding.address,
    amount: AMOUNT,
    maxGasFee: MAX_GAS_FEE.toString(),
    sourceSha256: hashes(),
    scanReportSha256: scanSha,
    fundingObservationSha256: fundingSha,
    fundingTransactionHash: fundingObservation.resolved.hash,
    transport: 'qualification-only Tor endpoint shim',
    circuitIsolationQualified: false,
    broadcastAcknowledged: false,
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
    const signer = require('../src/main/wallet/signers').getSigner(0),
      owner = (await signer.getAddress()).toLowerCase();
    assert.equal(owner, funding.address);
    const registry = require('../src/main/networks/network-registry');
    assert.equal(
      registry.addCustomChain(
        {
          chainId: 11155111,
          name: 'Sepolia bounded Railgun shield',
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
    const scope = require('../src/main/wallet/privacy-session').openPrivacySession();
    const handle = scope.getContext({
      kind: 'public-address',
      principal: owner,
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const network =
      require('../src/main/wallet/private-transaction-network').getPrivateTransactionNetwork(
        handle
      );
    const journal =
      require('../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(handle);
    const records = [...(await journal.list()), ...(await journal.listArchive())].filter(
      (r) => r.intent?.kind === 'railgun-native-shield'
    );
    if (mode === 'observe') {
      stage = 'observe';
      assert.equal(records.length, 1);
      recovery = require('../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
        owner
      );
      report.observation = await recovery.observe(records[0].hash);
      const obs = report.observation.record.observation;
      if (
        (report.observation.shield?.status === 'matched' || obs?.status === 'reverted') &&
        obs.confirmations >= 12
      ) {
        const { result: final } = await network.request(11155111, 'eth_getBlockByNumber', [
          'finalized',
          false,
        ]);
        if (BigInt(final.number) >= BigInt(obs.blockNumber))
          report.resolved = await recovery.resolve(records[0].hash, {
            minimumConfirmations: 12,
            review: async () => ({
              allowNextTransaction: true,
              acceptedEvidence: 'unverified-rpc',
            }),
          });
      }
    } else {
      assert.equal(
        records.length,
        0,
        'One shield attempt maximum; inspect recovery before any further work'
      );
      stage = 'enroll';
      identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
        archive,
      });
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity, create: false }
        );
      stage = 'restore-public';
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
      const snapshot = await publicAccount.coordinator.withPublicSnapshot(() => undefined),
        checked = publicAccount.coordinator.assertSnapshot(snapshot.evidence);
      assert.equal(checked.state.storeId, scan.publicState.storeId);
      assert.deepEqual(checked.state.trees, scan.publicState.trees);
      stage = 'restore-wallet';
      wallet = await require('../src/main/wallet/railgun-account-wallet').openRailgunAccountWallet({
        identity,
        enrollment,
        archive,
        coordinator: publicAccount.coordinator,
        mode: 'active',
      });
      assert.equal((await wallet.view.balance()).length, 0);
      report.walletRestored = true;
      await wallet.close();
      wallet = undefined;
      await publicAccount.close();
      publicAccount = undefined;
      stage = 'prepare';
      const started = performance.now();
      operation =
        await require('../src/main/wallet/railgun-shield-operation').openRailgunShieldOperation({
          identity,
          enrollment,
          archive,
          amount: AMOUNT,
          owner,
        });
      const tx = operation.prepared;
      report.preparation = {
        amount: AMOUNT,
        noteValue: tx.noteValue,
        protocolFee: (BigInt(AMOUNT) - BigInt(tx.noteValue)).toString(),
        gasLimit: GAS_LIMIT.toString(),
        elapsedMs: performance.now() - started,
      };
      if (mode === 'check') {
        stage = 'funded-simulation';
        const rpcTx = {
          from: owner,
          to: tx.to,
          value: '0x' + BigInt(tx.value).toString(16),
          data: tx.data,
        };
        const { result: estimate } = await network.request(11155111, 'eth_estimateGas', [rpcTx]);
        report.preparation.estimate = BigInt(estimate).toString();
        stage = 'simulation-gas';
        assert.ok(BigInt(estimate) > 0n && BigInt(estimate) <= GAS_LIMIT);
        stage = 'simulation-call';
        await network.request(11155111, 'eth_call', [rpcTx, 'latest']);
        const { result: balance } = await network.request(11155111, 'eth_getBalance', [
          owner,
          'pending',
        ]);
        const quote = await network.getFeeQuote(11155111);
        report.preparation.balance = BigInt(balance).toString();
        report.preparation.gasPrice = quote.gasPrice;
        stage = 'simulation-balance';
        assert.ok(BigInt(balance) >= BigInt(AMOUNT) + GAS_LIMIT * BigInt(quote.gasPrice));
        stage = 'simulation-fee';
        assert.ok(GAS_LIMIT * BigInt(quote.gasPrice) <= MAX_GAS_FEE);
        report.preparation.estimate = BigInt(estimate).toString();
        report.preparation.balance = BigInt(balance).toString();
        report.preparation.simulationElapsedMs =
          performance.now() - started - report.preparation.elapsedMs;
      }
      if (mode === 'shield') {
        stage = 'shield';
        const submissionStarted = performance.now();
        report.sent = await operation.submit({
          signer,
          gasLimit: GAS_LIMIT,
          maxGasFee: MAX_GAS_FEE,
          review: async (request) => {
            assert.equal(request.amount, BigInt(AMOUNT));
            assert.equal(request.maxGasFee, MAX_GAS_FEE);
            assert.equal(request.fundingAddressPublic, true);
            return true;
          },
        });
        report.submissionElapsedMs = performance.now() - submissionStarted;
        report.broadcastAcknowledged = true;
      }
    }
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
      reason: ['rpc', 'mismatch', 'stale', 'inactive', 'refused'].includes(error.reason)
        ? error.reason
        : undefined,
      step: /^[a-zA-Z-]+$/.test(error.step ?? '') ? error.step : undefined,
      ...(error.transactionHash
        ? { transactionHash: error.transactionHash, reconciliationRequired: true }
        : {}),
    };
  } finally {
    operation?.close();
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
  console.log(
    JSON.stringify({
      passed: report.passed,
      failure: report.failure,
      broadcastAcknowledged: report.broadcastAcknowledged,
      hash: report.sent?.hash,
      observation: report.observation?.record?.observation?.status,
      resolved: !!report.resolved,
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
    console.error('Railgun shield live qualification refused');
    app.exit(1);
  }
);
