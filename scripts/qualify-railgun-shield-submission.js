/** Actual Electron/vault/engine/signing/journal exercise with simulated funding
 * RPC. Only deployment reads go over Tor. No signed bytes reach a live network.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron script ARCHIVE NEW_OUTPUT
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { Wallet, Transaction, Interface } = require('ethers');
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
  const names = [
    ...new Set([
      ...Object.keys(
        require('../docs/qualification/railgun-shield-account-2026-10-03.json').sourceSha256
      ),
      'scripts/qualify-railgun-shield-submission.js',
      ...[
        'railgun-shield-operation',
        'railgun-shield-intent',
        'railgun-shield-receipt',
        'railgun-shield-recovery',
        'railgun-shield-resolution',
        'private-transaction-intent',
        'private-transaction-network',
        'private-submission-journal',
        'private-submission-reconciler',
        'privacy-journal-retention',
        'privacy-journal-archiver',
        'transaction-service',
        'transaction-submission-coordinator',
        'ordinary-submission-policy',
        'privacy-profile-guard',
        'privacy-storage',
        'privacy-session',
      ].map((n) => 'src/main/wallet/' + n + '.js'),
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
    sourceSha256: hashes(),
    recipientPublicVector: true,
    torManager: 'qualification-only-endpoint-shim',
    fundingRpc: 'simulated-in-process',
    deploymentRpc: 'live-tor',
    liveSubmissionRoute: 'none',
    simulatedAttempts: 0,
    simulatedSubmissions: 0,
    circuitIsolationQualified: false,
    runs: [],
    passed: false,
  };
  const vault = require('../src/main/identity/vault'),
    directory = path.join(profile.userDataDir, 'identity');
  const password = 'public-fixture-password-not-a-user-credential';
  const phrase =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const signerWallet = Wallet.createRandom(); // Ephemeral synthetic signer; never funded by this harness.
  const owner = signerWallet.address.toLowerCase();
  report.syntheticFundingAddress = owner;
  const signer = {
    getAddress: async () => signerWallet.address,
    signTransaction: (tx) => signerWallet.signTransaction(tx),
  };
  const torModule = require.resolve('../src/main/tor-manager'),
    savedTor = require.cache[torModule];
  const transportModule = require.resolve('../src/main/networks/wallet-tor-transport');
  const originalTransport = require(transportModule),
    savedTransport = require.cache[transportModule];
  const { getPrivacyContext } = require('../src/main/networks/privacy-context');
  const pins = require('../src/main/wallet/railgun-shield-pins.json');
  const abi = new Interface([
    ...require('../src/main/wallet/railgun-shield-policy').SHIELD_ABI,
    require('../src/main/wallet/railgun-shield-receipt').SHIELD_EVENT,
  ]);
  const transactions = new Map(),
    receipts = new Map();
  let nonce = 0,
    loseResponse = false,
    dropBeforeAcceptance = false,
    lastHash,
    client,
    identity,
    enrollment,
    operation,
    recovery,
    stage = 'vault';
  try {
    await vault.importVault(directory, password, phrase);
    const registry = require('../src/main/networks/network-registry');
    assert.equal(
      registry.addCustomChain(
        {
          chainId: 11155111,
          name: 'Sepolia shield submission fixture',
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
    for (const name of [
      '../src/main/networks/private-rpc',
      '../src/main/wallet/private-transaction-network',
      '../src/main/wallet/transaction-service',
    ])
      assert.equal(
        require.cache[require.resolve(name)],
        undefined,
        'Funding transport already captured before fixture override'
      );
    report.transportOverrideLoadGuard = true;
    require.cache[transportModule] = {
      id: transportModule,
      filename: transportModule,
      loaded: true,
      exports: {
        ...originalTransport,
        createWalletTorTransport: () => {
          const actual = originalTransport.createWalletTorTransport();
          return {
            ...actual,
            request: async (handle, url, options) => {
              const context = getPrivacyContext(handle);
              if (context.subject.kind === 'private-account')
                return actual.request(handle, url, options);
              // A strict branch ensures public signing/broadcast never touches actual.
              assert.equal(context.subject.kind, 'public-address');
              assert.equal(context.subject.principal, owner);
              assert.equal(context.subject.role, 'transaction-rpc');
              const call = JSON.parse(options.body);
              const blockHash = '0x' + 'b'.repeat(64),
                blockNumber = '0x10';
              let result;
              switch (call.method) {
                case 'eth_chainId':
                  result = '0xaa36a7';
                  break;
                case 'eth_gasPrice':
                  result = '0x64';
                  break;
                case 'eth_getCode':
                  result = '0x';
                  break;
                case 'eth_estimateGas':
                  result = '0x493e0';
                  break;
                case 'eth_call':
                  result = '0x';
                  break;
                case 'eth_getBalance':
                  result = '0xde0b6b3a7640000';
                  break;
                case 'eth_getTransactionCount':
                  result = '0x' + nonce.toString(16);
                  break;
                case 'eth_blockNumber':
                  result = '0x12';
                  break;
                case 'eth_getBlockByNumber':
                  result = {
                    number: blockNumber,
                    hash: blockHash,
                    transactions: [...transactions.keys()],
                  };
                  break;
                case 'eth_getTransactionByHash':
                  result = transactions.get(call.params[0]) ?? null;
                  break;
                case 'eth_getTransactionReceipt':
                  result = receipts.get(call.params[0]) ?? null;
                  break;
                case 'eth_sendRawTransaction': {
                  const tx = Transaction.from(call.params[0]);
                  assert.equal(tx.from.toLowerCase(), owner);
                  assert.equal(tx.nonce, nonce);
                  assert.equal(tx.chainId, 11155111n);
                  const journal =
                    require('../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                      handle
                    );
                  const records = await journal.list(),
                    record = records.find((r) => r.hash === tx.hash);
                  assert.ok(
                    record &&
                      record.state === 'attempted' &&
                      record.intent.kind === 'railgun-native-shield'
                  );
                  assert.ok(!JSON.stringify(records).includes(call.params[0]));
                  lastHash = tx.hash;
                  report.simulatedAttempts++;
                  if (dropBeforeAcceptance)
                    throw Error('Controlled drop before simulated acceptance');
                  const [, calls] = abi.decodeFunctionData('multicall', tx.data),
                    [notes] = abi.decodeFunctionData('shield', calls[1].data);
                  const note = notes[0],
                    net = BigInt(record.intent.noteValue);
                  const event = abi.encodeEventLog('Shield', [
                    0,
                    nonce,
                    [[note.preimage.npk, note.preimage.token, net]],
                    [note.ciphertext],
                    [tx.value - net],
                  ]);
                  transactions.set(tx.hash, {
                    hash: tx.hash,
                    from: owner,
                    to: pins.relayAdapt,
                    chainId: '0xaa36a7',
                    nonce: '0x' + nonce.toString(16),
                    value: '0x' + tx.value.toString(16),
                    input: tx.data,
                    blockHash,
                    blockNumber,
                  });
                  receipts.set(tx.hash, {
                    transactionHash: tx.hash,
                    from: owner,
                    to: pins.relayAdapt,
                    status: '0x1',
                    blockHash,
                    blockNumber,
                    gasUsed: '0x493e0',
                    logs: [
                      {
                        ...event,
                        address: pins.proxy,
                        transactionHash: tx.hash,
                        blockHash,
                        blockNumber,
                        logIndex: '0x4',
                        removed: false,
                      },
                    ],
                  });
                  nonce++;
                  lastHash = tx.hash;
                  report.simulatedSubmissions++;
                  if (loseResponse) throw Error('Controlled lost broadcast response');
                  result = tx.hash;
                  break;
                }
                default:
                  throw Error('Unexpected simulated funding method');
              }
              return {
                status: 200,
                body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: call.id, result })),
              };
            },
          };
        },
      },
    };
    for (const mode of ['acknowledged', 'lost-response', 'dropped']) {
      stage = 'enroll';
      await vault.unlockVault(directory, password, 0);
      identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
        archive,
      });
      enrollment =
        await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
          { identity, create: mode === 'acknowledged' }
        );
      stage = 'prepare';
      const started = performance.now();
      operation =
        await require('../src/main/wallet/railgun-shield-operation').openRailgunShieldOperation({
          identity,
          enrollment,
          archive,
          owner,
          amount: '100000000000000',
        });
      const preparedMs = performance.now() - started;
      stage = 'submit';
      loseResponse = mode === 'lost-response';
      dropBeforeAcceptance = mode === 'dropped';
      try {
        const sent = await operation.submit({
          signer,
          gasLimit: 500000n,
          maxGasFee: 1000000000000000n,
          review: async (request) => {
            assert.equal(request.fundingAddressPublic, true);
            return true;
          },
        });
        assert.equal(mode, 'acknowledged');
        assert.equal(sent.hash, lastHash);
      } catch (error) {
        assert.ok(['lost-response', 'dropped'].includes(mode));
        assert.equal(error.code, 'PRIVATE_BROADCAST_UNCERTAIN');
        assert.equal(error.transactionHash, lastHash);
      }
      operation.close();
      enrollment.close();
      identity.close();
      vault.lockVault();
      stage = 'cold-recovery';
      await vault.unlockVault(directory, password, 0);
      recovery = require('../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
        owner
      );
      const observed = await recovery.observe(lastHash);
      if (mode === 'dropped') {
        assert.equal(observed.record.observation.status, 'unknown');
        assert.equal(observed.shield, null);
        await assert.rejects(
          recovery.resolve(lastHash, {
            minimumConfirmations: 3,
            review: async () => ({
              allowNextTransaction: true,
              acceptedEvidence: 'unverified-rpc',
            }),
          })
        );
        identity = await require('../src/main/wallet/railgun-identity').openRailgunIdentity({
          archive,
        });
        enrollment =
          await require('../src/main/wallet/railgun-account-enrollment').openRailgunAccountEnrollment(
            { identity, create: false }
          );
        operation =
          await require('../src/main/wallet/railgun-shield-operation').openRailgunShieldOperation({
            identity,
            enrollment,
            archive,
            owner,
            amount: '100000000000000',
          });
        await assert.rejects(
          operation.submit({
            signer,
            gasLimit: 500000n,
            maxGasFee: 1000000000000000n,
            review: async () => true,
          }),
          { code: 'PRIVATE_SUBMISSION_UNRESOLVED' }
        );
        assert.equal(report.simulatedAttempts, 3);
        report.runs.push({
          mode,
          hash: lastHash,
          preparedMs,
          totalMs: performance.now() - started,
          journalObservedBeforeTransport: true,
          unresolvedAfterColdReopen: true,
          resolutionRefused: true,
          nextSubmissionRefused: true,
        });
        operation.close();
        enrollment.close();
        identity.close();
        recovery.close();
        vault.lockVault();
        continue;
      }
      assert.equal(observed.shield.status, 'matched');
      const resolved = await recovery.resolve(lastHash, {
        minimumConfirmations: 3,
        review: async (request) => {
          assert.equal(request.shield.status, 'matched');
          return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
        },
      });
      assert.equal(resolved.resolution.railgun.outcome, 'matched');
      const snapshot = resolved.resolution.railgun;
      recovery.close();
      vault.lockVault();
      await vault.unlockVault(directory, password, 0);
      recovery = require('../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
        owner
      );
      assert.deepEqual(
        (await recovery.list()).find((r) => r.hash === lastHash).resolution.railgun,
        snapshot
      );
      report.runs.push({
        mode,
        hash: lastHash,
        preparedMs,
        totalMs: performance.now() - started,
        journalObservedBeforeTransport: true,
        matchedAfterColdReopen: true,
        durableOutcome: true,
      });
      recovery.close();
      vault.lockVault();
    }
    assert.equal(report.simulatedSubmissions, 2);
    assert.equal(report.simulatedAttempts, 3);
    assert.deepEqual(hashes(), report.sourceSha256);
    report.passed = true;
  } catch (error) {
    report.failure = {
      stage,
      reason: ['rpc', 'mismatch', 'stale', 'inactive', 'refused'].includes(error.reason)
        ? error.reason
        : undefined,
      step: /^[a-zA-Z-]+$/.test(error.step ?? '') ? error.step : undefined,
      causeCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.causeCode ?? '') ? error.causeCode : undefined,
      code: /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : error.name,
    };
  } finally {
    operation?.close();
    recovery?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    if (client) await client.close();
    require.cache[torModule] = savedTor;
    require.cache[transportModule] = savedTransport;
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(
    JSON.stringify({
      passed: report.passed,
      failure: report.failure,
      runs: report.runs.length,
      simulatedSubmissions: report.simulatedSubmissions,
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
