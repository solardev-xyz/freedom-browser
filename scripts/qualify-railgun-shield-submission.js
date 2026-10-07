/** Actual Electron/vault/engine/signing/journal exercise with simulated funding
 * RPC. Only deployment reads go over Tor. No signed bytes reach a live network.
 * FREEDOM_WALLET_TOR_EXPERIMENT=1 electron script ARCHIVE NEW_OUTPUT
 * Offline: additionally set FREEDOM_RAILGUN_SHIELD_OFFLINE=1 and pass a third
 * absolute public-bytecode fixture path. Both RPC roles are then intercepted.
 */
const fs = require('fs'),
  path = require('path'),
  assert = require('assert/strict');
const { createHash } = require('crypto');
const { app } = require('electron');
const { Wallet, Transaction, Interface } = require('ethers');
const { acquireProfileLock, releaseProfileLock } = require('../src/main/profile-lock');
let lock;
async function within(work, timeoutMs = 5000, code = 'QUALIFICATION_DEADLINE_EXCEEDED') {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(Error('Qualification deadline exceeded'), { code })),
          timeoutMs
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function main() {
  const [archive, output, bytecodes] = process.argv.slice(2);
  const offline = process.env.FREEDOM_RAILGUN_SHIELD_OFFLINE === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_SHIELD_OFFLINE));
  assert.equal(process.argv.length, offline ? 5 : 4);
  const deployment = offline
    ? require('./fixtures/railgun-shield-offline-deployment').createOfflineShieldDeployment(
        bytecodes
      )
    : null;
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
      ...require('./fixtures/railgun-kohaku-adapter-sources').SOURCES,
      ...Object.keys(
        require('../docs/qualification/railgun-shield-account-2026-10-03.json').sourceSha256
      ),
      'scripts/qualify-railgun-shield-submission.js',
      ...(offline ? ['scripts/fixtures/railgun-shield-offline-deployment.js'] : []),
      ...[
        'identity/privacy-keys.js',
        'identity/railgun-key-derivation.js',
        'identity/derivation.js',
        'profile-resolver.js',
        'profile-catalog.js',
        'profile-lock.js',
        'updater-owner-lock.js',
        'networks/migration.js',
      ].map((name) => 'src/main/' + name),
      'src/shared/chains.json',
      'src/shared/endpoint-sources.json',
      ...[
        'railgun-account-phase',
        'railgun-recovery-finality',
        'railgun-wallet-catalog',
        'vault-errors',
        'chains',
        'ppv2-ragequit-policy',
        'ppv2-deposit-policy',
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
    torManager: offline ? 'synthetic-endpoint-no-tor-process' : 'qualification-only-endpoint-shim',
    fundingRpc: 'simulated-in-process',
    deploymentRpc: offline ? 'offline-pinned-bytecode-synthetic-state' : 'live-tor',
    liveSubmissionRoute: 'none',
    simulatedAttempts: 0,
    simulatedSubmissions: 0,
    unexpectedTransportFailures: 0,
    callbacks: { getAddress: 0, signTransaction: 0, transactionReview: 0 },
    circuitIsolationQualified: false,
    overriddenModules: ['src/main/tor-manager.js', 'src/main/networks/wallet-tor-transport.js'],
    inventoryIsExecutionCoverage: false,
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
    getAddress: async () => {
      report.callbacks.getAddress++;
      return signerWallet.address;
    },
    signTransaction: (tx) => {
      report.callbacks.signTransaction++;
      return signerWallet.signTransaction(tx);
    },
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
  const controlledFailure = Symbol('controlled simulated transport failure');
  const loseAcknowledgement = () => {
    const error = Error('Controlled simulated transport failure');
    error[controlledFailure] = true;
    return error;
  };
  let nonce = 0,
    loseResponse = false,
    dropBeforeAcceptance = false,
    lastHash,
    client,
    identity,
    enrollment,
    operation,
    recovery,
    destinationOwner,
    stage = 'vault';
  const rpcUrl = offline
    ? 'https://synthetic.invalid/railgun-shield'
    : 'https://sepolia.rpc.sentio.xyz';
  // Each operation/reopen gets fresh genuine observations. Tokens never enter
  // the journal or survive this owner's closure.
  function reviewedDestinations(accountEnrollment) {
    assert.ok(offline);
    const { createPrivacyScope } = require('../src/main/networks/privacy-context');
    const rpc = require('../src/main/networks/private-rpc');
    const parent =
      accountEnrollment ?? require('../src/main/wallet/privacy-session').openPrivacySession();
    const subject = {
      kind: 'public-address',
      principal: owner,
      chainId: pins.chainId,
      role: 'transaction-rpc',
    };
    const parentHandle = accountEnrollment
      ? accountEnrollment.getContext('engine', 'shield-prepare')
      : parent.getContext(subject);
    const scope = createPrivacyScope({
      profileId: getPrivacyContext(parentHandle).profileId,
      signal: parent.signal,
    });
    const constraints = [];
    const result = { signal: scope.signal };
    try {
      for (const role of accountEnrollment ? ['protocol', 'transaction'] : ['transaction']) {
        const roleSubject =
          role === 'protocol'
            ? getPrivacyContext(accountEnrollment.getContext('protocol-rpc', 'shield-preflight'))
                .subject
            : subject;
        const handle = scope.getContext(roleSubject);
        const client = rpc.createPrivateRpc(handle, roleSubject.role);
        const observation = rpc.getPrivateRpcDestination(client, handle);
        assert.equal(rpc.getPrivateRpcDestinationDetails(observation).url, rpcUrl);
        const restriction = rpc.createPrivateRpcDestinationConstraint({
          observation,
          signal: scope.signal,
          deadline: performance.now() + 240000,
        });
        constraints.push(restriction);
        result[role] = restriction.constraint;
      }
      return Object.freeze({
        ...result,
        close() {
          constraints.forEach((constraint) => constraint.close());
          scope.close();
        },
      });
    } catch (error) {
      constraints.forEach((constraint) => constraint.close());
      scope.close();
      throw error;
    }
  }
  async function openOperation() {
    destinationOwner?.close();
    destinationOwner = offline ? reviewedDestinations(enrollment) : null;
    return require('../src/main/wallet/railgun-shield-operation').openRailgunShieldOperation({
      identity,
      enrollment,
      archive,
      owner,
      amount: '100000000000000',
      ...(destinationOwner
        ? {
            signal: destinationOwner.signal,
            destinationConstraints: {
              protocol: destinationOwner.protocol,
              transaction: destinationOwner.transaction,
            },
          }
        : {}),
    });
  }
  function openRecovery() {
    destinationOwner?.close();
    destinationOwner = offline ? reviewedDestinations() : null;
    return require('../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
      owner,
      destinationOwner
        ? {
            signal: destinationOwner.signal,
            destinationConstraint: destinationOwner.transaction,
          }
        : {}
    );
  }
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
        [rpcUrl]
      ).success,
      true
    );
    registry.updateNetwork(11155111, {
      access: { readOrder: ['direct'], allowDirect: true },
      quorum: { timeoutMs: 45000 },
    });
    stage = 'tor';
    if (offline) {
      const controller = new AbortController();
      client = {
        endpoint: Object.freeze({ signal: controller.signal }),
        metadata: { offline: true, physicalTorTransportQualified: false },
        close: async () => controller.abort(),
      };
    } else
      client = await require('./qualify-ppv2-live').openLiveTransport(
        path.join(output, 'transport'),
        console.log,
        'sentio'
      );
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
      '../src/main/wallet/railgun-public-services',
      '../src/main/wallet/railgun-poi-source',
      '../src/main/wallet/railgun-poi-root',
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
          // Offline mode never constructs a real transport, even for an
          // unexpected role or rejected request.
          const actual = offline
            ? { release() {}, close() {} }
            : originalTransport.createWalletTorTransport();
          return {
            ...actual,
            request: async (handle, url, options) => {
              try {
                const context = getPrivacyContext(handle);
                if (offline) {
                  assert.equal(url, rpcUrl);
                  assert.equal(options.method, 'POST');
                  assert.equal(options.signal.aborted, false);
                }
                if (context.subject.kind === 'private-account') {
                  if (!offline) return actual.request(handle, url, options);
                  assert.equal(context.subject.role, 'protocol-rpc');
                  const call = JSON.parse(options.body);
                  return {
                    status: 200,
                    body: Buffer.from(
                      JSON.stringify({
                        jsonrpc: '2.0',
                        id: call.id,
                        result: deployment.request(call),
                      })
                    ),
                  };
                }
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
                    assert.equal(tx.to.toLowerCase(), pins.relayAdapt);
                    assert.equal(tx.value, 100000000000000n);
                    assert.equal(tx.data, operation.prepared.data);
                    assert.equal(tx.gasLimit, 500000n);
                    const signedIntent =
                      require('../src/main/wallet/private-transaction-intent').transactionIntent(
                        'railgun-native-shield',
                        { ...tx.toJSON(), from: owner }
                      );
                    assert.equal(signedIntent.digest, operation.intent.digest);
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
                    assert.equal(record.intent.digest, signedIntent.digest);
                    lastHash = tx.hash;
                    report.simulatedAttempts++;
                    if (dropBeforeAcceptance) throw loseAcknowledgement();
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
                      to: tx.to.toLowerCase(),
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
                      to: tx.to.toLowerCase(),
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
                    if (loseResponse) throw loseAcknowledgement();
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
              } catch (error) {
                if (offline && error[controlledFailure] !== true)
                  report.unexpectedTransportFailures++;
                throw error;
              }
            },
          };
        },
      },
    };
    for (const mode of [
      'acknowledged',
      'lost-response',
      ...(offline ? ['review-cancelled'] : []),
      'dropped',
    ]) {
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
      operation = await within(openOperation(), 150000, 'QUALIFICATION_OPEN_PENDING');
      const preparedMs = performance.now() - started;
      stage = 'submit';
      if (mode === 'review-cancelled') {
        const before = { ...report.callbacks, attempts: report.simulatedAttempts };
        let entered, releaseReview;
        const entry = new Promise((resolve) => (entered = resolve));
        const held = new Promise((resolve) => (releaseReview = resolve));
        const submitted = operation
          .submit({
            signer,
            gasLimit: 500000n,
            maxGasFee: 1000000000000000n,
            review: async () => {
              report.callbacks.transactionReview++;
              entered();
              await held;
              return true;
            },
          })
          .then(
            (value) => ({ value }),
            (error) => ({ error })
          );
        try {
          await within(entry);
          let drained = false;
          operation.closed.then(
            () => {
              drained = true;
            },
            () => {
              drained = true;
            }
          );
          operation.close();
          const outcome = await within(submitted);
          assert.equal(outcome.error?.code, 'RAILGUN_SHIELD_HANDOFF_REFUSED');
          await new Promise(setImmediate);
          assert.equal(drained, false, 'Original review must retain logical ownership');
          assert.equal(report.callbacks.signTransaction, before.signTransaction);
          assert.equal(report.simulatedAttempts, before.attempts);
          releaseReview();
          await within(operation.closed);
          assert.equal(report.callbacks.signTransaction, before.signTransaction);
          assert.equal(report.simulatedAttempts, before.attempts);
          assert.equal(report.callbacks.transactionReview, before.transactionReview + 1);
          report.runs.push({
            mode,
            preparedMs,
            totalMs: performance.now() - started,
            outwardCancellationBeforeOriginalReviewDrained: true,
            closureRetainedThroughLateApproval: true,
            signingAttempts: 0,
            rawSendAttempts: 0,
          });
        } finally {
          releaseReview();
          operation.close();
          await within(operation.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
        }
        destinationOwner?.close();
        enrollment.close();
        identity.close();
        vault.lockVault();
        continue;
      }
      loseResponse = mode === 'lost-response';
      dropBeforeAcceptance = mode === 'dropped';
      try {
        const sent = await operation.submit({
          signer,
          gasLimit: 500000n,
          maxGasFee: 1000000000000000n,
          review: async (request) => {
            report.callbacks.transactionReview++;
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
      await within(operation.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
      destinationOwner?.close();
      enrollment.close();
      identity.close();
      vault.lockVault();
      stage = 'cold-recovery';
      await vault.unlockVault(directory, password, 0);
      recovery = openRecovery();
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
        recovery.close();
        await within(recovery.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
        operation = await within(openOperation(), 150000, 'QUALIFICATION_OPEN_PENDING');
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
        await within(operation.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
        enrollment.close();
        identity.close();
        recovery.close();
        await within(recovery.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
        destinationOwner?.close();
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
      await within(recovery.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
      destinationOwner?.close();
      vault.lockVault();
      await vault.unlockVault(directory, password, 0);
      recovery = openRecovery();
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
      await within(recovery.closed, 30000, 'QUALIFICATION_CLEANUP_PENDING');
      destinationOwner?.close();
      vault.lockVault();
    }
    assert.equal(report.simulatedSubmissions, 2);
    assert.equal(report.simulatedAttempts, 3);
    assert.equal(report.callbacks.signTransaction, 3);
    assert.equal(report.callbacks.transactionReview, offline ? 4 : 3);
    assert.equal(report.unexpectedTransportFailures, 0);
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
    const cleanup = await Promise.allSettled(
      [operation?.closed, recovery?.closed].map((barrier) =>
        within(barrier, 30000, 'QUALIFICATION_CLEANUP_PENDING')
      )
    );
    if (cleanup.some((result) => result.status === 'rejected')) {
      report.passed = false;
      report.failure ??= { stage: 'cleanup', code: 'QUALIFICATION_CLEANUP_PENDING' };
    }
    destinationOwner?.close();
    enrollment?.close();
    identity?.close();
    vault.lockVault();
    if (client) await client.close();
    if (offline) report.offlineDeployment = deployment.report();
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
