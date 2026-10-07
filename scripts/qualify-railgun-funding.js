/** Bounded transfer from the existing disposable PPv2 EOA to the separately
 * qualified Railgun EOA. Uses the ordinary nonce lease/journal and a narrow
 * qualification-only Tor adapter. Never creates/resets either vault.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron script PP_PROFILE FUNDING_REPORT NEW_OUTPUT check|send|observe|rebroadcast-identical DESTINATION_SHA256 [TRANSFER_PLAN]
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app, safeStorage } = require('electron');
const { Transaction } = require('ethers');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
const { openLiveTransport } = require('./qualify-ppv2-live');
const AMOUNT = 10000000000000000n,
  MAX_FEE = 500000000000000n;
let lock;
async function main() {
  const [directory, destinationFile, output, mode, destinationSha256, planFile] =
    process.argv.slice(2);
  assert.equal(process.argv.length, mode === 'rebroadcast-identical' ? 8 : 7);
  assert.ok(['check', 'send', 'observe', 'rebroadcast-identical'].includes(mode));
  assert.match(destinationSha256, /^[0-9a-f]{64}$/);
  assert.equal(
    createHash('sha256').update(fs.readFileSync(destinationFile)).digest('hex'),
    destinationSha256
  );
  assert.ok(
    !app.isPackaged &&
      process.env.FREEDOM_WALLET_TOR_EXPERIMENT === '1' &&
      !process.env.FREEDOM_IDENTITY_DATA
  );
  assert.ok([directory, destinationFile, output].every(path.isAbsolute));
  assert.equal(fs.realpathSync(directory), directory);
  assert.ok(!fs.existsSync(output));
  const destination = JSON.parse(fs.readFileSync(destinationFile));
  assert.equal(destination.version, 1);
  assert.equal(destination.disposable, true);
  assert.equal(destination.chainId, 11155111);
  assert.equal(destination.walletIndex, 0);
  assert.equal(destination.signer, 'vault-backed');
  assert.equal(destination.signed, false);
  assert.equal(destination.submissions, 0);
  assert.equal(destination.profileDirectory, fs.realpathSync(destination.profileDirectory));
  assert.notEqual(destination.profileDirectory, directory);
  assert.match(destination.address, /^0x[0-9a-f]{40}$/);
  const targetMarker = JSON.parse(
    fs.readFileSync(path.join(destination.profileDirectory, 'railgun-test-profile.json'))
  );
  assert.deepEqual(targetMarker, {
    version: 1,
    chainId: 11155111,
    profileId: destination.profileId,
    disposable: true,
  });
  fs.mkdirSync(output, { mode: 0o700 });
  const profile = require('../src/main/profile-resolver').initializeProfile(app, {
    env: { FREEDOM_TEST_USER_DATA: directory },
  });
  lock = acquireProfileLock(profile, { onCompromised: () => app.exit(1) });
  app.dock?.hide();
  await app.whenReady();
  assert.ok(require('../src/main/networks/direct-testnet-transport').directTestExposure());
  const funding = JSON.parse(fs.readFileSync(path.join(directory, 'funding.json')));
  assert.equal(funding.chainId, 11155111);
  assert.equal(funding.harnessOnly, true);
  assert.equal(
    funding.profileBinding,
    createHash('sha256')
      .update(JSON.stringify([profile.id, directory]))
      .digest('hex')
  );
  assert.ok(safeStorage.isEncryptionAvailable());
  if (process.platform === 'linux')
    assert.notEqual(safeStorage.getSelectedStorageBackend(), 'basic_text');
  const vault = require('../src/main/identity/vault');
  assert.ok(vault.vaultExists(path.join(directory, 'identity')));
  const report = {
    observedAt: new Date().toISOString(),
    mode,
    chainId: 11155111,
    from: funding.address,
    to: destination.address,
    amount: AMOUNT.toString(),
    maxGasFee: MAX_FEE.toString(),
    gasLimit: '21000',
    type: 0,
    destinationSha256,
    transport: 'ordinary wallet send over qualification-only Tor adapter',
    broadcastAttempts: 0,
    passed: false,
  };
  const sourceNames = [
    ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
    'scripts/qualify-railgun-funding.js',
    'scripts/qualify-railgun-funding-account.js',
    'scripts/lib/railgun-funding-plan.js',
    'src/main/networks/network-registry.js',
    'src/main/networks/direct-testnet-transport.js',
    'src/main/profile-resolver.js',
    'scripts/qualify-ppv2-live.js',
    ...[
      'signers',
      'vault-access',
      'transaction-service',
      'transaction-submission-coordinator',
      'ordinary-submission-policy',
      'private-submission-journal',
      'private-submission-reconciler',
      'private-transaction-network',
      'privacy-storage',
      'privacy-profile-guard',
      'privacy-session',
    ].map((n) => 'src/main/wallet/' + n + '.js'),
    'src/main/identity/vault.js',
    'src/main/networks/privacy-context.js',
    'src/main/networks/private-rpc.js',
    'src/main/networks/wallet-tor-transport.js',
  ];
  const hashes = () =>
    Object.fromEntries(
      sourceNames.map((n) => [
        n,
        createHash('sha256')
          .update(fs.readFileSync(path.join(__dirname, '..', n)))
          .digest('hex'),
      ])
    );
  report.sourceSha256 = hashes();
  const torModule = require.resolve('../src/main/tor-manager'),
    savedTor = require.cache[torModule];
  const routerModule = require.resolve('../src/main/networks/chain-data-router'),
    savedRouter = require.cache[routerModule];
  let client,
    rpc,
    stage = 'unlock',
    expectedNonce,
    gasPrice,
    attemptHash;
  try {
    let password = safeStorage.decryptString(
      fs.readFileSync(path.join(directory, 'qualification-password.bin'))
    );
    await vault.unlockVault(path.join(directory, 'identity'), password, 0);
    password = undefined;
    const signer = require('../src/main/wallet/signers').getSigner(0),
      owner = (await signer.getAddress()).toLowerCase();
    assert.equal(owner, funding.address);
    assert.notEqual(owner, destination.address);
    const registry = require('../src/main/networks/network-registry');
    assert.equal(
      registry.addCustomChain(
        {
          chainId: 11155111,
          name: 'Sepolia disposable funding',
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
    rpc = require('../src/main/networks/private-rpc').createPrivateRpc(handle, 'transaction-rpc');
    const quantity = (v) => typeof v === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v);
    const read = async (method, params, validate = quantity) =>
      (await rpc.request(method, params, validate)).result;
    const network =
      require('../src/main/wallet/private-transaction-network').getPrivateTransactionNetwork(
        handle
      );
    const journal =
      require('../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(handle);
    stage = 'history';
    const records = await journal.list(),
      archived = await journal.listArchive();
    const previous = [...records, ...archived].filter(
      (r) => r.route === 'ordinary' && r.ordinary.to === destination.address
    );
    report.previousFundingAttempts = previous.map((r) => r.hash);
    const planExpected = {
      profileBinding: funding.profileBinding,
      destinationSha256,
      from: owner,
      to: destination.address,
      amount: AMOUNT,
      maxGasFee: MAX_FEE,
    };
    const plans = require('./lib/railgun-funding-plan');
    if (mode === 'rebroadcast-identical') {
      stage = 'identical-rebroadcast';
      assert.ok(path.isAbsolute(planFile));
      const plan = JSON.parse(fs.readFileSync(planFile));
      plans.assertFundingPlan(plan, planExpected);
      assert.equal(previous.length, 1);
      const record = records.find((r) => r.hash === plan.hash);
      assert.ok(
        record &&
          record === previous[0] &&
          !record.resolution &&
          record.nonce === plan.transaction.nonce
      );
      assert.equal(records.filter((r) => !r.resolution).length, 1);
      const lease =
        require('../src/main/wallet/transaction-submission-coordinator').acquireSubmissionLease({
          chainId: 11155111,
          from: owner,
          privacyContext: handle,
        });
      try {
        await lease.prepare();
        assert.equal(
          BigInt(await read('eth_getTransactionCount', [owner, 'latest'])),
          BigInt(record.nonce)
        );
        assert.equal(
          await read('eth_getCode', [owner, 'pending'], (v) => typeof v === 'string'),
          '0x'
        );
        const raw = await plans.resignFundingPlan(signer, plan, planExpected);
        lease.assertActive();
        const current = (await journal.list()).find((r) => r.hash === plan.hash);
        assert.ok(current && !current.resolution && current.nonce === record.nonce);
        attemptHash = plan.hash;
        report.broadcastAttempts++;
        const response = await rpc.request('eth_sendRawTransaction', [raw], (v) => v === plan.hash);
        await journal.markSubmitted(plan.hash);
        report.sent = { hash: response.result, nonce: record.nonce };
        report.identicalHashRebroadcast = true;
      } finally {
        lease.release();
      }
      report.passed = true;
    } else if (mode === 'observe') {
      assert.equal(previous.length, 1);
      attemptHash = previous[0].hash;
      report.observation = await network.reconcileSubmission(attemptHash);
      if (['included', 'reverted'].includes(report.observation.observation?.status)) {
        const { result: tx } = await network.request(11155111, 'eth_getTransactionByHash', [
          attemptHash,
        ]);
        assert.ok(
          tx &&
            tx.to?.toLowerCase() === destination.address &&
            tx.from?.toLowerCase() === owner &&
            BigInt(tx.value) === AMOUNT &&
            tx.input === '0x' &&
            BigInt(tx.nonce) === BigInt(previous[0].nonce)
        );
        const final = await read(
          'eth_getBlockByNumber',
          ['finalized', false],
          (v) => v && quantity(v.number) && /^0x[0-9a-f]{64}$/.test(v.hash)
        );
        if (BigInt(final.number) >= BigInt(report.observation.observation.blockNumber))
          report.resolved = await network.resolveSubmission(attemptHash, {
            minimumConfirmations: 12,
            review: async (request) => {
              const fresh = await read(
                'eth_getBlockByNumber',
                ['finalized', false],
                (v) => v && quantity(v.number) && /^0x[0-9a-f]{64}$/.test(v.hash)
              );
              assert.ok(BigInt(fresh.number) >= BigInt(request.observation.blockNumber));
              if (BigInt(fresh.number) === BigInt(request.observation.blockNumber))
                assert.equal(fresh.hash, request.observation.blockHash);
              return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
            },
          });
      }
      report.passed = true;
    } else {
      assert.equal(previous.length, 0, 'Funding has already been attempted; inspect its journal');
      await network.assertCanSubmit();
      stage = 'funding-readiness';
      const latest = await read('eth_getTransactionCount', [owner, 'latest']),
        pending = await read('eth_getTransactionCount', [owner, 'pending']);
      assert.equal(latest, pending);
      expectedNonce = Number(BigInt(pending));
      assert.ok(Number.isSafeInteger(expectedNonce));
      const balance = BigInt(await read('eth_getBalance', [owner, 'pending']));
      const quotedGasPrice = BigInt(await read('eth_gasPrice', []));
      assert.ok(quotedGasPrice > 0n && 21000n * quotedGasPrice <= MAX_FEE);
      gasPrice = quotedGasPrice * 2n;
      if (gasPrice > MAX_FEE / 21000n) gasPrice = MAX_FEE / 21000n;
      report.quotedGasPrice = quotedGasPrice.toString();
      assert.ok(balance >= AMOUNT + 21000n * gasPrice);
      for (const address of [owner, destination.address])
        assert.equal(
          await read(
            'eth_getCode',
            [address, 'pending'],
            (v) => typeof v === 'string' && /^0x(?:[0-9a-f]{2})*$/.test(v)
          ),
          '0x'
        );
      const call = {
        from: owner,
        to: destination.address,
        value: '0x' + AMOUNT.toString(16),
        data: '0x',
      };
      assert.equal(BigInt(await read('eth_estimateGas', [call])), 21000n);
      report.balanceBefore = balance.toString();
      report.nonce = expectedNonce;
      report.gasPrice = gasPrice.toString();
      report.gasCost = (21000n * gasPrice).toString();
      if (mode === 'send') {
        assert.equal(
          require.cache[require.resolve('../src/main/wallet/transaction-service')],
          undefined,
          'Transaction service captured router before qualification adapter'
        );
        const checkTx = (tx) => {
          assert.equal(BigInt(tx.chainId), 11155111n);
          assert.equal(tx.to.toLowerCase(), destination.address);
          assert.equal(BigInt(tx.value), AMOUNT);
          assert.equal(tx.data ?? '0x', '0x');
          assert.equal(BigInt(tx.gasLimit), 21000n);
          assert.equal(BigInt(tx.gasPrice), gasPrice);
          assert.equal(Number(tx.nonce), expectedNonce);
          assert.equal(Number(tx.type), 0);
        };
        require.cache[routerModule] = {
          id: routerModule,
          filename: routerModule,
          loaded: true,
          exports: {
            request: async (chainId, method, params, options = {}) => {
              assert.equal(chainId, 11155111);
              options.signal?.throwIfAborted();
              assert.ok(
                ['eth_getTransactionCount', 'eth_getBalance', 'eth_getCode'].includes(method)
              );
              assert.equal(params[0].toLowerCase(), owner);
              assert.equal(params[1], 'pending');
              return rpc.request(
                method,
                params,
                method === 'eth_getCode' ? (v) => v === '0x' : quantity
              );
            },
            getFeeQuote: () => {
              throw Error('Funding uses only the fixed bounded fee');
            },
            broadcastRawTransaction: async (chainId, raw, { signal, submissionPermit } = {}) => {
              signal?.throwIfAborted();
              assert.equal(chainId, 11155111);
              const tx = Transaction.from(raw);
              checkTx(tx);
              assert.equal(tx.from.toLowerCase(), owner);
              assert.equal(
                require('../src/main/wallet/transaction-submission-coordinator').consumeSubmissionPermit(
                  chainId,
                  raw,
                  submissionPermit
                ),
                true
              );
              assert.ok(
                (await journal.list()).some((r) => r.hash === tx.hash && r.route === 'ordinary')
              );
              attemptHash = tx.hash;
              report.broadcastAttempts++;
              return rpc.request('eth_sendRawTransaction', [raw], (v) => v === tx.hash);
            },
          },
        };
        stage = 'send';
        report.sent =
          await require('../src/main/wallet/transaction-service').signAndSendTransaction(
            {
              chainId: 11155111,
              to: destination.address,
              value: AMOUNT.toString(),
              data: '0x',
              gasLimit: '21000',
              gasPrice: gasPrice.toString(),
            },
            {
              getAddress: () => signer.getAddress(),
              signTransaction: async (tx) => {
                checkTx(tx);
                const raw = await signer.signTransaction(tx);
                const plan = plans.createFundingPlan(raw, planExpected);
                plans.writeFundingPlan(path.join(output, 'transfer-plan.json'), plan);
                report.transferPlan = 'transfer-plan.json';
                report.signedHash = plan.hash;
                return raw;
              },
            }
          );
        assert.equal(report.sent.hash, attemptHash);
      }
      report.passed = true;
    }
    assert.deepEqual(hashes(), report.sourceSha256);
  } catch (error) {
    report.passed = false;
    report.failure = {
      stage,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
      ...(attemptHash ? { transactionHash: attemptHash, reconciliationRequired: true } : {}),
    };
  } finally {
    rpc?.release();
    vault.lockVault();
    if (client) await client.close();
    require.cache[torModule] = savedTor;
    require.cache[routerModule] = savedRouter;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      failure: report.failure,
      broadcastAttempts: report.broadcastAttempts,
      from: report.from,
      to: report.to,
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
    console.error('Railgun funding qualification refused');
    app.exit(1);
  }
);
