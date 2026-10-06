/** Offline public Shield composition. Disposable public-vector profiles only.
 * The facade, Shield hosts/preflight, constraints, vault signer and journal are
 * genuine. RPC replies (including balances) are synthetic; no Tor/live evidence.
 */
const nativeAssertions = require('./railgun-native-assertions');
const { assert } = nativeAssertions;
const fs = require('fs');
const path = require('path');
const { Transaction } = require('ethers');
const {
  createPrivacyScope,
  getPrivacyContext,
} = require('../../src/main/networks/privacy-context');
const contracts = require('./railgun-kohaku-contract-conformance');
const contractOracle = require('./railgun-kohaku-contract-oracle');
const { installSettlementObserver } = require('./railgun-kohaku-contract-observer');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { createOfflineShieldDeployment } = require('./railgun-shield-offline-deployment');
let installed = false;
const gate = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
async function bounded(promise, label, milliseconds = 150000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error('Offline public Shield timeout: ' + label)),
          milliseconds
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function qualifyPublicAdapterReads({ adapter, account, owners, measure }) {
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
  const clone = (value) =>
    Array.isArray(value)
      ? value.map(clone)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
        : value;
  const expected = clone(baseline);
  assert.equal(expected.read.instanceId, owners.identity.descriptor.instanceId);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(
    Object.keys(adapter).sort(),
    [
      'balance',
      'close',
      'closed',
      'instanceId',
      'notes',
      'prepareShield',
      'provenance',
      'signal',
    ].sort()
  );
  assert.equal(adapter.provenance, 'host-supplied');
  const before = measure();
  const calls = [
    ['instanceId', []],
    ['balance', []],
    ['notes', []],
    ['notes', [undefined, true]],
    ['balance', [[]]],
    ['notes', [[], true]],
    ['balance', [[{ __type: 'native' }]]],
  ];
  assert.ok(expected.read.received.length >= 3, 'Fixed genuine fixture has three read examples');
  for (const asset of expected.read.received.slice(0, 3).map((note) => note.asset)) {
    const filter = {
      ...asset,
      ...(asset.contract ? { contract: '0x' + asset.contract.slice(2).toUpperCase() } : {}),
    };
    calls.push(['balance', [[filter]]], ['notes', [[filter], true]]);
  }
  for (const [method, args] of calls) {
    const pending = adapter[method](...args),
      value = await pending;
    contractOracle.assertReadProjection(expected.read, {
      method,
      args,
      value,
      promiseReturned: pending instanceof Promise,
    });
    if (Array.isArray(value)) {
      assert.equal(Object.isFrozen(value), false);
      for (const item of value) {
        const amount = item.amount + 1n;
        item.amount = amount;
        assert.equal(item.amount, amount);
        item.asset.__type = 'fixture-mutated';
        assert.equal(item.asset.__type, 'fixture-mutated');
      }
      value.length = 0;
      assert.equal(value.length, 0);
    }
    assert.deepEqual(wallet.readRailgunAccountOwnedNotes(account, owners), expected);
    assert.deepEqual(baseline, expected);
    assert.equal(owners.identity.descriptor.instanceId, expected.read.instanceId);
    assert.deepEqual(measure(), before, 'Public adapter reads added measured work');
  }
  return Object.freeze({
    calls: 13,
    genuineOwnedSnapshotCompared: true,
    detachedMutationIsolation: true,
    noAdditionalMeasuredWork: true,
    eligibilityGranted: false,
    genericHostQualified: false,
  });
}
async function assertPublicAdapterReadRefusals(adapter, measure) {
  const before = measure();
  for (const method of ['instanceId', 'balance', 'notes'])
    await assert.rejects(adapter[method](), { code: 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_REFUSED' });
  assert.deepEqual(measure(), before, 'Public adapter refused reads added work');
  return Object.freeze({ calls: 3, noAdditionalMeasuredWork: true });
}
exports.qualifyPublicAdapterReads = qualifyPublicAdapterReads;
exports.assertPublicAdapterReadRefusals = assertPublicAdapterReadRefusals;
exports.install = function install(bytecodesAbsolutePath, mode, options = {}) {
  assert.deepEqual(
    Object.keys(options),
    Object.hasOwn(options, 'publicAdapter') ? ['publicAdapter'] : []
  );
  const publicAdapter = options.publicAdapter === true;
  assert.ok(options.publicAdapter === undefined || typeof options.publicAdapter === 'boolean');
  assert.equal(installed, false);
  installed = true;
  assert.ok(['acknowledged', 'lost-response', 'review-cancelled'].includes(mode));
  const deployment = createOfflineShieldDeployment(bytecodesAbsolutePath);
  assert.equal(require.cache[require.resolve('../../src/main/networks/private-rpc')], undefined);
  for (const name of ['railgun-public-services', 'railgun-poi-source', 'railgun-poi-root'])
    assert.equal(
      require.cache[require.resolve('../../src/main/wallet/' + name)],
      undefined,
      'Public-service transport already captured before fixture override'
    );
  const transport = require('../../src/main/networks/wallet-tor-transport');
  const registry = require('../../src/main/networks/network-registry');
  const settings = require('../../src/main/settings-store');
  const tor = require('../../src/main/tor-manager');
  const saved = {
    transport: transport.createWalletTorTransport,
    network: registry.getNetwork,
    endpoints: registry.getEndpoints,
    sources: registry.getEndpointSources,
    available: settings.isWalletTorExperimentAvailable,
    endpoint: tor.getWalletSocksEndpoint,
  };
  const endpointController = new AbortController();
  const endpoint = Object.freeze({ signal: endpointController.signal });
  const rpcUrl = 'https://synthetic.invalid/railgun-kohaku-public';
  const controlledLoss = Symbol('offline-public-shield-response-loss');
  const attempts = {
    transportEntries: 0,
    getAddressEntries: 0,
    signTransactionEntries: 0,
    viewingCredentialEntries: 0,
    shieldUtilityEntries: 0,
    publicServiceTransportEntries: 0,
  };
  const counters = {
    archivedRequests: 0,
    deploymentRequests: 0,
    transactionRequests: 0,
    sends: 0,
    controlledLostResponses: 0,
    unexpectedTransportFailures: 0,
  };
  const transactionMethods = Object.create(null);
  let active = true,
    archiveFactory,
    sendObserver,
    fundingOwner,
    expectedAmount,
    simulatedTransaction,
    sentHash;
  const activeFixture = () => assert.ok(active, 'Offline fixture already closed');
  registry.getNetwork = () => ({ access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } });
  registry.getEndpoints = () => [rpcUrl];
  registry.getEndpointSources = () => [{ keyed: false, coverage: { 11155111: rpcUrl } }];
  settings.isWalletTorExperimentAvailable = () => true;
  tor.getWalletSocksEndpoint = () => endpoint;
  transport.createWalletTorTransport = () => ({
    close() {},
    release() {},
    async request(handle, url, options) {
      attempts.transportEntries++;
      try {
        activeFixture();
        assert.equal(options.signal.aborted, false);
        const { subject } = getPrivacyContext(handle);
        if (!['protocol-rpc', 'transaction-rpc'].includes(subject.role))
          attempts.publicServiceTransportEntries++;
        assert.equal(url, rpcUrl);
        assert.equal(options.method, 'POST');
        const wire = JSON.parse(options.body);
        assert.equal(wire.jsonrpc, '2.0');
        assert.ok(Array.isArray(wire.params));
        let result;
        if (subject.role === 'protocol-rpc') {
          assert.equal(subject.kind, 'private-account');
          assert.equal(subject.protocol, 'railgun');
          assert.equal(subject.chainId, pins.chainId);
          if (subject.operation === 'shield-preflight') {
            counters.deploymentRequests++;
            result = deployment.request(wire);
          } else {
            counters.archivedRequests++;
            assert.equal(subject.operation, null);
            if (wire.method === 'eth_chainId') {
              assert.deepEqual(wire.params, []);
              result = '0xaa36a7';
            } else {
              assert.ok(archiveFactory);
              result = (
                await archiveFactory(handle, 'protocol-rpc', { signal: options.signal }).request(
                  wire.method,
                  wire.params,
                  () => true
                )
              ).result;
            }
          }
        } else {
          assert.equal(subject.role, 'transaction-rpc');
          assert.equal(subject.kind, 'public-address');
          assert.equal(subject.principal, fundingOwner);
          assert.equal(subject.chainId, pins.chainId);
          assert.equal(subject.operation, null);
          counters.transactionRequests++;
          transactionMethods[wire.method] = (transactionMethods[wire.method] ?? 0) + 1;
          if (wire.method === 'eth_chainId' || wire.method === 'eth_gasPrice') {
            assert.deepEqual(wire.params, []);
            result = wire.method === 'eth_chainId' ? '0xaa36a7' : '0x64';
          } else if (
            ['eth_getCode', 'eth_getBalance', 'eth_getTransactionCount'].includes(wire.method)
          ) {
            assert.equal(wire.params.length, 2);
            assert.equal(wire.params[0].toLowerCase(), fundingOwner);
            assert.ok(['latest', 'pending'].includes(wire.params[1]));
            result =
              wire.method === 'eth_getCode'
                ? '0x'
                : wire.method === 'eth_getBalance'
                  ? '0xde0b6b3a7640000'
                  : '0x0';
          } else if (wire.method === 'eth_estimateGas' || wire.method === 'eth_call') {
            assert.equal(wire.params.length, wire.method === 'eth_call' ? 2 : 1);
            if (wire.method === 'eth_call') assert.equal(wire.params[1], 'latest');
            const tx = wire.params[0];
            assert.deepEqual(Object.keys(tx).sort(), ['data', 'from', 'to', 'value']);
            assert.equal(tx.from, fundingOwner);
            assert.equal(tx.to, pins.relayAdapt);
            assert.equal(BigInt(tx.value), expectedAmount);
            require('../../src/main/wallet/railgun-shield-intent').shieldIntentBinding({
              ...tx,
              chainId: pins.chainId,
            });
            if (wire.method === 'eth_estimateGas') {
              assert.equal(simulatedTransaction, undefined);
              simulatedTransaction = structuredClone(tx);
              result = '0x493e0';
            } else {
              assert.deepEqual(tx, simulatedTransaction);
              result = '0x';
            }
          } else {
            assert.equal(wire.method, 'eth_sendRawTransaction');
            assert.equal(wire.params.length, 1);
            counters.sends++;
            assert.equal(counters.sends, 1);
            assert.equal(typeof sendObserver, 'function');
            const tx = Transaction.from(wire.params[0]);
            sentHash = tx.hash.toLowerCase();
            await sendObserver(handle, tx, wire.params[0]);
            if (mode === 'lost-response') {
              const error = Error('Controlled offline public Shield response loss');
              error[controlledLoss] = true;
              throw error;
            }
            result = sentHash;
          }
        }
        activeFixture();
        assert.equal(options.signal.aborted, false);
        return {
          status: 200,
          body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
        };
      } catch (error) {
        if (error?.[controlledLoss]) counters.controlledLostResponses++;
        else counters.unexpectedTransportFailures++;
        throw error;
      }
    },
  });
  const close = () => {
    if (!active) return;
    active = false;
    endpointController.abort();
    transport.createWalletTorTransport = saved.transport;
    registry.getNetwork = saved.network;
    registry.getEndpoints = saved.endpoints;
    registry.getEndpointSources = saved.sources;
    settings.isWalletTorExperimentAvailable = saved.available;
    tor.getWalletSocksEndpoint = saved.endpoint;
  };
  return Object.freeze({
    inputType: 'Shield',
    measureActivity: () => ({
      counters: { ...counters },
      attempts: { ...attempts },
      transactionMethods: { ...transactionMethods },
    }),
    configureArchive(factory) {
      assert.equal(archiveFactory, undefined);
      assert.equal(typeof factory, 'function');
      archiveFactory = factory;
    },
    close,
    async qualify({
      account: initialAccount,
      owners,
      archive,
      outputDirectory,
      observeKeys,
      readKeyCounts,
      measureResources,
    }) {
      activeFixture();
      const started = performance.now();
      assert.ok(path.isAbsolute(outputDirectory));
      const root = fs.realpathSync(outputDirectory);
      const identityDirectory = fs.realpathSync(
        require('../../src/main/profile-paths').getIdentityDataDir()
      );
      const relative = path.relative(root, identityDirectory);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
      const metadata = path.join(identityDirectory, 'vault-meta.json');
      assert.equal(fs.existsSync(metadata), false);
      const signerModule = require('../../src/main/wallet/signers');
      const genuineSigner = signerModule.getSigner;
      // Deliberately outside admission measurement; metadata contains only this
      // public vector address. getWalletRecord remains the production function.
      fundingOwner = (
        await bounded(genuineSigner(0).getAddress(), 'baseline public address')
      ).toLowerCase();
      assert.match(fundingOwner, /^0x[0-9a-f]{40}$/);
      fs.writeFileSync(
        metadata,
        JSON.stringify({
          userKnowsPassword: true,
          addresses: { userWallet: fundingOwner },
          derivedWallets: [
            { index: 0, name: 'Offline public vector', type: 'mnemonic', address: fundingOwner },
          ],
        }) + '\n',
        { flag: 'wx', mode: 0o600 }
      );
      const manager = require('../../src/main/identity-manager');
      assert.equal(manager.getWalletRecord(0).address, fundingOwner);
      for (const name of [
        'railgun-kohaku-plugin',
        'railgun-shield-operation',
        'railgun-shield-prepare',
        'railgun-shield-receive',
      ])
        assert.equal(require.cache[require.resolve('../../src/main/wallet/' + name)], undefined);
      const identities = require('../../src/main/wallet/railgun-identity');
      const processHost = require('../../src/main/wallet/railgun-process');
      const originalViewing = identities.withRailgunViewingCredential;
      const originalStart = processHost.startRailgunProcess;
      const { identity, enrollment } = owners;
      const wallet = require('../../src/main/wallet/railgun-account-wallet');
      const phase = require('../../src/main/wallet/railgun-account-phase');
      const { transactionIntent } = require('../../src/main/wallet/private-transaction-intent');
      const signalController = new AbortController();
      const counts = {
        preparationReviews: 0,
        transactionReviews: 0,
        eoaSignatures: 0,
        privateSpendingKeys: 0,
        viewingCallbacks: 0,
        shieldUtilityDrains: 0,
      };
      const plugins = [],
        accounts = [initialAccount],
        gates = [],
        tasks = [],
        borrowed = [];
      let contractRead;
      const adapterHosts = [];
      let adapterRead, preparedReads, closedReads, originalSettlement;
      let mainAccount,
        plugin,
        expectedIntent,
        reviewedTransaction,
        journalBeforeSend = false;
      expectedAmount = 1000000000000n;
      const amount = Object.freeze({
        asset: Object.freeze({ __type: 'native' }),
        amount: expectedAmount,
      });
      const fixtureCurrent = () => {
        activeFixture();
        assert.equal(signalController.signal.aborted, false);
      };
      const snapshot = () => ({
        attempts: { ...attempts },
        counters: { ...counters },
        transactionMethods: { ...transactionMethods },
        counts: { ...counts },
        keys: readKeyCounts(),
      });
      const measureReads = () => ({ ...snapshot(), resources: measureResources() });
      const refused = (promise) =>
        assert.rejects(bounded(promise, 'refused capability', 15000), {
          code: publicAdapter ? 'RAILGUN_KOHAKU_PUBLIC_ADAPTER_REFUSED' : 'RAILGUN_KOHAKU_REFUSED',
        });
      const compareTransaction = (transaction) => {
        assert.ok(reviewedTransaction && expectedIntent && simulatedTransaction);
        assert.equal(transaction.to.toLowerCase(), pins.relayAdapt);
        assert.equal(BigInt(transaction.value), expectedAmount);
        assert.equal(BigInt(transaction.chainId), BigInt(pins.chainId));
        assert.equal(transaction.data.toLowerCase(), simulatedTransaction.data);
        assert.equal(BigInt(transaction.gasLimit), 500000n);
        assert.equal(BigInt(transaction.gasPrice), 100n);
        assert.equal(BigInt(transaction.nonce), 0n);
        assert.deepEqual(
          transactionIntent('railgun-native-shield', {
            to: transaction.to,
            chainId: transaction.chainId,
            value: transaction.value,
            data: transaction.data,
            from: fundingOwner,
          }),
          expectedIntent
        );
      };
      signerModule.getSigner = (index) => {
        assert.equal(index, 0);
        const signer = genuineSigner(index);
        return Object.freeze({
          async getAddress() {
            attempts.getAddressEntries++;
            fixtureCurrent();
            return signer.getAddress();
          },
          async signTransaction(transaction) {
            attempts.signTransactionEntries++;
            fixtureCurrent();
            compareTransaction(transaction);
            const signed = await signer.signTransaction(transaction);
            counts.eoaSignatures++;
            assert.equal(counts.eoaSignatures, 1);
            assert.equal(Transaction.from(signed).from.toLowerCase(), fundingOwner);
            return signed;
          },
        });
      };
      identities.withRailgunViewingCredential = (actualIdentity, use) => {
        attempts.viewingCredentialEntries++;
        fixtureCurrent();
        assert.equal(actualIdentity, identity);
        return originalViewing(actualIdentity, (credential) => {
          counts.viewingCallbacks++;
          borrowed.push(credential.viewingKey);
          return use(credential);
        });
      };
      processHost.startRailgunProcess = (options) => {
        const isShield = ['railgun-shield-job', 'railgun-shield-receive-job'].some(
          (name) => options.filename === require.resolve('../../src/main/wallet/' + name)
        );
        if (isShield) {
          attempts.shieldUtilityEntries++;
          fixtureCurrent();
          assert.ok(mainAccount && mainAccount.signal.aborted);
          // The genuine host must already own recovery. Never leave behind an
          // unexpected successful claim if this assertion detects a regression.
          let acquired, refused;
          try {
            acquired = phase.claimRailgunAccountPhase(enrollment, 'recovery');
          } catch (error) {
            refused = error;
          } finally {
            acquired?.release();
          }
          assert.equal(acquired, undefined);
          assert.equal(refused?.code, 'RAILGUN_ACCOUNT_PHASE_BUSY');
        }
        const task = originalStart(options);
        if (isShield) {
          const drained = task.closed.then((result) => {
            assert.equal(result.code, 'RAILGUN_PROCESS_CLOSED');
            counts.shieldUtilityDrains++;
          });
          drained.catch(() => {});
          tasks.push(drained);
        }
        return task;
      };
      observeKeys(() => {
        counts.privateSpendingKeys++;
        throw Error('Private spending key forbidden in public Shield fixture');
      });
      const facade = require('../../src/main/wallet/railgun-kohaku-plugin');
      const settlements = installSettlementObserver('public');
      let createPublicHost, createPublicAdapter, createAdapterSubmitter;
      if (publicAdapter) {
        assert.equal(
          require.cache[require.resolve('../../src/main/wallet/railgun-kohaku-public-host')],
          undefined
        );
        ({
          createRailgunKohakuPublicHost: createPublicHost,
        } = require('../../src/main/wallet/railgun-kohaku-public-host'));
        ({
          createRailgunKohakuPublicAdapter: createPublicAdapter,
          createRailgunKohakuPublicAdapterSubmitter: createAdapterSubmitter,
        } = require('../../src/main/wallet/railgun-kohaku-public-adapter'));
      }

      const {
        createRailgunKohakuPublicSubmitter,
      } = require('../../src/main/wallet/railgun-kohaku-public-submitter');
      const {
        createRailgunKohakuBroadcaster,
      } = require('../../src/main/wallet/railgun-kohaku-broadcaster');
      const preparationReview = (summary, context) => {
        fixtureCurrent();
        counts.preparationReviews++;
        assert.equal(attempts.viewingCredentialEntries, 0);
        assert.equal(attempts.shieldUtilityEntries, 0);
        assert.equal(attempts.getAddressEntries, 0);
        assert.equal(attempts.signTransactionEntries, 0);
        assert.equal(counters.deploymentRequests, 0);
        assert.equal(counters.transactionRequests, 0);
        assert.equal(context.signal.aborted, false);
        assert.equal(summary.purpose, 'railgun-public-shield-preparation');
        assert.equal(summary.operation, 'railgun-native-shield');
        assert.equal(summary.chainId, pins.chainId);
        assert.equal(summary.amount, expectedAmount.toString());
        assert.equal(summary.recipient, identity.descriptor.instanceId);
        assert.equal(summary.funding.address, fundingOwner);
        assert.equal(summary.wrappedAsset, pins.wrappedNative);
        assert.equal(summary.shieldFeeBps, pins.shieldFeeBps);
        const fee = (expectedAmount * BigInt(pins.shieldFeeBps)) / 10000n;
        assert.equal(summary.protocolFee, fee.toString());
        assert.equal(summary.noteValue, (expectedAmount - fee).toString());
        assert.deepEqual(summary.destinations, { protocolRpc: rpcUrl, transactionRpc: rpcUrl });
        for (const exposure of [
          'public-funding-address',
          'native-amount',
          'relay-adapt-shield-calldata',
          'encrypted-note',
          'eth_estimateGas',
          'eth_call',
        ])
          assert.ok(summary.exposures.transactionRpc.includes(exposure));
        assert.equal(summary.permitsSimulation, true);
        assert.equal(summary.permitsSigning, false);
        assert.equal(summary.privateSpendSigning, false);
        assert.equal(summary.poiQueries, false);
        assert.equal(summary.sourceQueries, false);
        assert.equal(summary.broadcastsTransaction, false);
        assert.equal(summary.broadcastSimulationBeforeTransactionReview, true);
        assert.equal(summary.rpcAdmissionDestinationPinned, true);
        assert.equal(summary.chainStateVerified, false);
      };
      const options = (account, overrides = {}) => ({
        account,
        owners,
        archive,
        mode: 'public',
        signal: signalController.signal,
        gasLimit: 500000n,
        maxGasFee: 1000000000000000n,
        reviewPreparation: async (summary, context) => {
          preparationReview(summary, context);
          return true;
        },
        reviewTransaction: async () => {
          throw Error('Unexpected transaction review');
        },
        ...overrides,
      });
      const adopt = (account, overrides) => {
        if (publicAdapter) {
          const actual = options(account, overrides);
          const { mode: ignoredMode, ...hostOptions } = actual;
          assert.equal(ignoredMode, 'public');
          const host = createPublicHost(hostOptions);
          adapterHosts.push(host);
          const instance = createPublicAdapter({ host, signal: actual.signal });
          plugins.push(instance);
          return instance;
        }
        const instance = facade.createRailgunKohakuPlugin(options(account, overrides));
        plugins.push(instance);
        return instance;
      };
      const reopen = async () => {
        const account = await bounded(
          wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'active' }),
          'wallet reopen'
        );
        accounts.push(account);
        return account;
      };
      const freshJournal = async (use) => {
        const scope = createPrivacyScope({
          profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
          signal: enrollment.signal,
        });
        try {
          const handle = scope.getContext({
            kind: 'public-address',
            principal: fundingOwner,
            chainId: pins.chainId,
            role: 'transaction-rpc',
          });
          const journal =
            require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
              handle
            );
          return await bounded(use(journal), 'fresh journal');
        } finally {
          scope.close();
        }
      };
      try {
        const denied = adopt(initialAccount, {
          reviewPreparation: async (summary, context) => {
            preparationReview(summary, context);
            return false;
          },
        });
        const beforeDenied = snapshot();
        await assert.rejects(bounded(denied.prepareShield(amount), 'denied preparation'), {
          code: 'RAILGUN_KOHAKU_REFUSED',
        });
        await bounded(denied.closed, 'denied instance drain');
        const expectedDenied = structuredClone(beforeDenied);
        expectedDenied.counts.preparationReviews++;
        assert.deepEqual(snapshot(), expectedDenied);
        assert.equal(initialAccount.signal.aborted, true);

        // Retain the actual wallet handoff after its workers drain while the
        // original first review is still held; directory-local flags are not enough.
        const cancelAccount = await reopen(),
          cancellation = new AbortController();
        const heldPreparation = { entered: gate(), release: gate() };
        gates.push(heldPreparation);
        const cancelled = adopt(cancelAccount, {
          signal: cancellation.signal,
          reviewPreparation: async (summary, context) => {
            preparationReview(summary, context);
            heldPreparation.entered.resolve();
            await bounded(heldPreparation.release.promise, 'held preparation callback', 25000);
            return true;
          },
        });
        const beforeCancel = snapshot();
        const cancelling = cancelled.prepareShield(amount).then(
          () => {
            throw Error('Cancelled preparation succeeded');
          },
          (error) => {
            assert.equal(error.code, 'RAILGUN_KOHAKU_REFUSED');
          }
        );
        await bounded(heldPreparation.entered.promise, 'preparation review entry', 25000);
        cancellation.abort();
        let cancelledDrained = false;
        cancelled.closed.then(() => {
          cancelledDrained = true;
        });
        await bounded(cancelAccount.close(), 'cancelled adopted account drain');
        assert.equal(cancelledDrained, false);
        let claim, refusal;
        try {
          claim = phase.claimRailgunAccountPhase(enrollment, 'recovery');
        } catch (error) {
          refusal = error;
        } finally {
          claim?.release();
        }
        assert.equal(claim, undefined);
        assert.equal(refusal?.code, 'RAILGUN_ACCOUNT_PHASE_BUSY');
        if (publicAdapter) await bounded(cancelling, 'early cancelled preparation outward');
        heldPreparation.release.resolve();
        await bounded(cancelling, 'cancelled preparation outward');
        await bounded(cancelled.closed, 'cancelled preparation drain');
        const expectedCancel = structuredClone(beforeCancel);
        expectedCancel.counts.preparationReviews++;
        assert.deepEqual(snapshot(), expectedCancel);
        assert.equal(cancelledDrained, true);

        mainAccount = await reopen();
        const heldTransaction = { entered: gate(), release: gate() };
        gates.push(heldTransaction);
        plugin = adopt(mainAccount, {
          reviewTransaction: async (summary, context) => {
            fixtureCurrent();
            counts.transactionReviews++;
            assert.equal(context.signal.aborted, false);
            assert.equal(summary.from.toLowerCase(), fundingOwner);
            assert.equal(summary.operation, 'railgun-native-shield');
            assert.equal(summary.recipient, identity.descriptor.instanceId);
            assert.equal(summary.amount, expectedAmount);
            assert.equal(summary.fundingAddressPublic, true);
            assert.equal(summary.chainStateVerified, false);
            assert.equal(attempts.signTransactionEntries, 0);
            assert.equal(counters.sends, 0);
            assert.equal(transactionMethods.eth_estimateGas, 1);
            assert.equal(transactionMethods.eth_call, 1);
            reviewedTransaction = summary.transaction;
            expectedIntent = summary.intent;
            compareTransaction(reviewedTransaction);
            assert.equal(attempts.shieldUtilityEntries, 2);
            assert.equal(counts.shieldUtilityDrains, 2);
            assert.equal(attempts.viewingCredentialEntries, 1);
            if (mode === 'review-cancelled') {
              heldTransaction.entered.resolve();
              await bounded(heldTransaction.release.promise, 'held transaction callback', 25000);
            }
            return true;
          },
        });
        if (publicAdapter)
          adapterRead = await qualifyPublicAdapterReads({
            adapter: plugin,
            account: mainAccount,
            owners,
            measure: measureReads,
          });
        else
          contractRead = await contracts.qualifyOperationInstance({
            instance: plugin,
            account: mainAccount,
            owners,
            mode: 'public',
            measure: measureReads,
          });
        const submitter = publicAdapter
          ? createAdapterSubmitter(plugin)
          : createRailgunKohakuPublicSubmitter(plugin);
        assert.throws(() => createRailgunKohakuBroadcaster(plugin), {
          code: 'RAILGUN_KOHAKU_REFUSED',
        });
        const beforeForged = snapshot();
        await refused(submitter.submit(Object.freeze({ __type: 'publicOperation' })));
        await refused(submitter.submit(Object.freeze({ __type: 'privateOperation' })));
        assert.deepEqual(snapshot(), beforeForged);
        const archivedBeforePublicOperation = counters.archivedRequests;
        const token = await bounded(
          plugin.prepareShield(amount, identity.descriptor.instanceId),
          'genuine public preparation'
        );
        contractOracle.assertOpaqueOperationShape(token, 'public');
        assert.deepEqual(token, { __type: 'publicOperation' });
        assert.equal(Object.isFrozen(token), true);
        assert.equal(counters.archivedRequests, archivedBeforePublicOperation);
        assert.equal(mainAccount.signal.aborted, true);
        if (publicAdapter)
          preparedReads = await assertPublicAdapterReadRefusals(plugin, measureReads);
        else
          assert.equal(
            await bounded(plugin.instanceId(), 'prepared instance identity'),
            identity.descriptor.instanceId
          );
        const beforeCopies = snapshot();
        for (const copy of [{ ...token }, JSON.parse(JSON.stringify(token))])
          await refused(submitter.submit(copy));
        if (publicAdapter)
          await assert.rejects(facade.broadcastRailgunKohakuOperation(plugin, token), {
            code: 'RAILGUN_KOHAKU_REFUSED',
          });
        else await refused(facade.broadcastRailgunKohakuOperation(plugin, token));
        await refused(plugin.notes());
        assert.deepEqual(snapshot(), beforeCopies);
        sendObserver = async (handle, transaction, raw) => {
          compareTransaction(transaction);
          assert.equal(transaction.from.toLowerCase(), fundingOwner);
          const journal =
            require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
              handle
            );
          const records = await bounded(journal.list(), 'journal before send');
          assert.equal(records.length, 1);
          assert.equal(records[0].hash, transaction.hash.toLowerCase());
          assert.equal(records[0].state, 'attempted');
          assert.deepEqual(records[0].intent, expectedIntent);
          assert.equal(JSON.stringify(records).includes(raw), false);
          journalBeforeSend = true;
        };
        const forwarded = publicAdapter
          ? settlements.beginHiddenPublic(token, () => submitter.submit(token))
          : settlements.begin(plugin, token, () => submitter.submit(token));
        const submitting = forwarded.promise.then(
          (result) => ({ result }),
          (error) => ({ error })
        );
        let outcome;
        if (mode === 'review-cancelled') {
          await bounded(heldTransaction.entered.promise, 'transaction review entry', 25000);
          let drained = false;
          plugin.closed.then(() => {
            drained = true;
          });
          const heldAttempts = { ...attempts };
          signalController.abort();
          outcome = await bounded(submitting, 'cancelled submit outcome', 25000);
          assert.equal(outcome.error?.code, 'RAILGUN_KOHAKU_REFUSED');
          if (publicAdapter) originalSettlement = await forwarded.assert({ outcome: 'refused' });
          assert.equal(drained, false);
          assert.deepEqual(attempts, heldAttempts);
          assert.equal(counters.sends, 0);
          assert.equal(counts.eoaSignatures, 0);
          assert.equal(counters.archivedRequests, archivedBeforePublicOperation);
          // Public Shield releases the host recovery phase before review. A
          // genuine replacement wallet may open; facade adoption must still fail.
          const contender = await reopen();
          assert.throws(
            () =>
              facade.createRailgunKohakuPlugin(options(contender, { signal: enrollment.signal })),
            { code: 'RAILGUN_KOHAKU_REFUSED' }
          );
          await bounded(contender.close(), 'contender account drain');
          const afterContender = { ...attempts };
          heldTransaction.release.resolve();
          await bounded(plugin.closed, 'original transaction review drain');
          assert.equal(drained, true);
          assert.deepEqual(attempts, afterContender);
          assert.equal(counters.sends, 0);
          assert.equal(counts.eoaSignatures, 0);
          await freshJournal(async (journal) => assert.deepEqual(await journal.list(), []));
        } else {
          outcome = await bounded(submitting, 'public submit outcome');
          await bounded(plugin.closed, 'public submit drain');
          if (mode === 'lost-response') {
            assert.equal(outcome.error?.code, 'PRIVATE_BROADCAST_UNCERTAIN');
            assert.equal(outcome.error.transactionHash, sentHash);
            assert.equal(outcome.error.submissionStatus, 'unknown');
          } else {
            assert.equal(outcome.error, undefined);
            assert.equal(outcome.result.hash.toLowerCase(), sentHash);
          }
          assert.equal(counters.sends, 1);
          assert.equal(counters.archivedRequests, archivedBeforePublicOperation);
          assert.equal(counts.eoaSignatures, 1);
          assert.equal(journalBeforeSend, true);
          await freshJournal(async (journal) => {
            const records = await journal.list();
            assert.equal(records.length, 1);
            assert.equal(records[0].hash, sentHash);
            assert.deepEqual(records[0].intent, expectedIntent);
            assert.equal(records[0].state, mode === 'lost-response' ? 'attempted' : 'submitted');
            await assert.rejects(journal.assertCanSubmit(), {
              code: 'PRIVATE_SUBMISSION_UNRESOLVED',
            });
          });
        }
        const observedSettlement =
          publicAdapter && mode === 'review-cancelled'
            ? originalSettlement
            : await forwarded.assert({
                outcome:
                  mode === 'review-cancelled'
                    ? 'refused'
                    : mode === 'lost-response'
                      ? 'uncertain'
                      : 'acknowledged',
                ...(mode === 'review-cancelled' ? {} : { hash: sentHash }),
                ...(publicAdapter && mode === 'acknowledged'
                  ? { requestedAmount: expectedAmount.toString() }
                  : {}),
              });
        if (publicAdapter) {
          originalSettlement = observedSettlement;
          closedReads = await assertPublicAdapterReadRefusals(plugin, measureReads);
        }
        const beforeReplay = snapshot();
        await refused(submitter.submit(token));
        assert.deepEqual(snapshot(), beforeReplay);
        // Genuine previously issued token under a different, fresh facade.
        const finalAccount = await reopen();
        const finalPlugin = adopt(finalAccount, { signal: enrollment.signal });
        const beforeForeign = snapshot();
        if (publicAdapter) await refused(createAdapterSubmitter(finalPlugin).submit(token));
        else await refused(createRailgunKohakuPublicSubmitter(finalPlugin).submit(token));
        assert.deepEqual(snapshot(), beforeForeign);
        finalPlugin.close();
        await bounded(finalPlugin.closed, 'fresh facade drain');
        await bounded(Promise.all(tasks), 'Shield utility drains');
        assert.equal(counts.privateSpendingKeys, 0);
        assert.equal(attempts.publicServiceTransportEntries, 0);
        assert.equal(counters.unexpectedTransportFailures, 0);
        assert.equal(counters.controlledLostResponses, mode === 'lost-response' ? 1 : 0);
        assert.equal(counts.transactionReviews, 1);
        assert.equal(counts.preparationReviews, 3);
        assert.equal(attempts.getAddressEntries, 1);
        assert.equal(attempts.signTransactionEntries, mode === 'review-cancelled' ? 0 : 1);
        assert.equal(attempts.shieldUtilityEntries, 2);
        assert.equal(counts.shieldUtilityDrains, 2);
        assert.equal(counts.viewingCallbacks, 1);
        assert.ok(borrowed.every((key) => key.every((byte) => byte === 0)));
        return {
          mode,
          contract: {
            reads: publicAdapter ? [] : [contractRead],
            forwarding: settlements.report(),
          },
          ...(publicAdapter
            ? {
                publicAdapterQualification: {
                  readyReads: adapterRead,
                  preparedReads,
                  closedReads,
                  originalSettlement,
                  genuineAdoptingHost: true,
                  readyOnlyReads: true,
                  originalPublicErrorsRemainRejected: true,
                  privateOutcomeUnionUsed: false,
                  facadeInternalsExposed: false,
                  heldOutwardBeforeCallbackRelease: mode === 'review-cancelled',
                  sourceDerivedNoAdditionalRpcKeysJobs: true,
                },
              }
            : {}),
          inputType: 'Shield',
          elapsedMs: Math.round(performance.now() - started),
          productionFacadeAndPublicSubmitter: true,
          productionShieldHostsAndPreflight: true,
          productionRpcDestinationConstraints: true,
          publicMetadataWrittenInDisposableProfile: true,
          baselineAddressResolvedBeforeAdmissionMeasurement: true,
          noPrivateProverConfiguration: true,
          syntheticRpcReplies: true,
          liveDeploymentQualified: false,
          physicalTorTransportQualified: false,
          deniedPreparationNoNewKeysRpcOrSigner: true,
          heldPreparationRetainsSharedPhaseAfterWalletDrain: true,
          genuineHostPhaseOwnedAtUtilityLaunch: true,
          adoptedWalletClosedBeforeShieldUtilities: true,
          exactlyOneEstimateAndCallBeforeTransactionReview: true,
          exactSimulatedReviewedAndSignedIntent: mode !== 'review-cancelled',
          realVaultEoaSigning: mode !== 'review-cancelled',
          journalBeforeSimulatedSend: journalBeforeSend,
          originalTransactionCallbackDrained: mode === 'review-cancelled',
          heldTransactionReviewRetainsFacadeExclusion: mode === 'review-cancelled',
          lateApprovalNoAdditionalObservedWrapperEntries: mode === 'review-cancelled',
          attemptedEntryScope: [
            'transport.request',
            'signer.getAddress',
            'signer.signTransaction',
            'identity.withRailgunViewingCredential',
            'Shield process launch',
          ],
          lowerRejectedControllerAttemptsQualified: false,
          copiedForgedPrivateAndRepeatedTokensRefused: true,
          consumedForeignTokenRefused: true,
          unconsumedForeignTokenNativeQualified: false,
          freshJournalContextReopened: true,
          coldResolutionOrNoteIngestionQualified: false,
          addedPoiTraffic: 0,
          addedRetainedSourceQueriesForPublicOperation: 0,
          viewingKeyBuffersWiped: true,
          counts: { ...counts },
          attempts: { ...attempts },
          rpc: { ...counters, transactionMethods: { ...transactionMethods } },
          deployment: deployment.report(),
          liveQueries: 0,
          liveSubmissions: 0,
        };
      } finally {
        const cleanup = async (label, run) => {
          try {
            await run();
          } catch (error) {
            nativeAssertions.record(error, 'kohaku-public.' + label);
          }
        };
        for (const [index, held] of gates.entries())
          await cleanup('review.' + index, () => held.release.resolve());
        await cleanup('abort', () => signalController.abort());
        for (const [index, instance] of plugins.entries())
          await cleanup('plugin.' + index + '.close', () => instance.close());
        await cleanup('final facade cleanup', () =>
          bounded(
            Promise.all(
              plugins.map((instance, index) =>
                cleanup('plugin.' + index + '.closed', () => instance.closed)
              )
            ),
            'final facade cleanup'
          )
        );
        for (const [index, host] of adapterHosts.entries()) {
          await cleanup('adapter-host.' + index + '.close', () => host.close());
          await cleanup('adapter-host.' + index + '.closed', () =>
            bounded(host.closed, 'adopted public host drain')
          );
        }
        for (const [index, account] of accounts.entries())
          await cleanup('account.' + index, () =>
            bounded(account.close(), 'final account cleanup')
          );
        await cleanup('final utility cleanup', () =>
          bounded(
            Promise.all(tasks.map((task, index) => cleanup('utility.' + index, () => task))),
            'final utility cleanup'
          )
        );
        await cleanup('keys.restore', () => observeKeys(null));
        sendObserver = undefined;
        await cleanup('signer.restore', () => {
          signerModule.getSigner = genuineSigner;
        });
        await cleanup('viewing.restore', () => {
          identities.withRailgunViewingCredential = originalViewing;
        });
        await cleanup('process.restore', () => {
          processHost.startRailgunProcess = originalStart;
        });
        await cleanup('settlements.close', () => settlements.close());
        nativeAssertions.assertEmpty();
      }
    },
  });
};
