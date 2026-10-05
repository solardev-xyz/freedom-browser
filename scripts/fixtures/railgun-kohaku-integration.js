/** Offline native Kohaku composition. Never use with a funded/live profile.
 * Actual facade, staging, controllers, stores, provers and vault signers; archived
 * RPC/public-service replies and account-POI/private-preflight trust are synthetic.
 */
const nativeAssertions = require('./railgun-native-assertions');
const { assert } = nativeAssertions;
const fs = require('fs');
const { createHash } = require('crypto');
const { Transaction } = require('ethers');
const {
  createPrivacyScope,
  getPrivacyContext,
} = require('../../src/main/networks/privacy-context');
const contracts = require('./railgun-kohaku-contract-conformance');
const contractOracle = require('./railgun-kohaku-contract-oracle');
const { installSettlementObserver } = require('./railgun-kohaku-contract-observer');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
let installed = false;
const gate = () => {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
};
exports.install = function install(mode) {
  assert.equal(installed, false);
  installed = true;
  assert.ok(
    ['shield-transfer', 'shield-unshield', 'transact-transfer', 'transact-unshield'].includes(mode)
  );
  const inputType = mode.startsWith('transact-') ? 'Transact' : 'Shield';
  const kind = mode.endsWith('-transfer') ? 'railgun-private-transfer' : 'railgun-token-unshield';
  const privateAdapterMode = process.env.FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER === '1';
  const privateAdapterDenied = process.env.FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER_DENY === '1';
  for (const name of [
    'FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER',
    'FREEDOM_RAILGUN_KOHAKU_PRIVATE_ADAPTER_DENY',
  ])
    assert.ok([undefined, '1'].includes(process.env[name]));
  if (privateAdapterMode) {
    assert.ok(['shield-transfer', 'transact-unshield'].includes(mode));
    assert.equal(process.env.FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW, undefined);
    assert.equal(
      process.env.FREEDOM_RAILGUN_KOHAKU_LOST_ACK,
      mode === 'transact-unshield' ? '1' : undefined
    );
    if (privateAdapterDenied) assert.equal(mode, 'shield-transfer');
  } else assert.equal(privateAdapterDenied, false);
  const uncertain = process.env.FREEDOM_RAILGUN_KOHAKU_LOST_ACK === '1';
  assert.ok([undefined, '1'].includes(process.env.FREEDOM_RAILGUN_KOHAKU_LOST_ACK));
  const cancelTransactionReview =
    process.env.FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW === '1';
  assert.ok(
    [undefined, '1'].includes(process.env.FREEDOM_RAILGUN_KOHAKU_CANCEL_TRANSACTION_REVIEW)
  );
  if (cancelTransactionReview) {
    assert.equal(mode, 'shield-transfer');
    assert.equal(uncertain, false);
  }
  const transport = require('../../src/main/networks/wallet-tor-transport');
  assert.equal(require.cache[require.resolve('../../src/main/networks/private-rpc')], undefined);
  const registry = require('../../src/main/networks/network-registry');
  const settings = require('../../src/main/settings-store');
  const tor = require('../../src/main/tor-manager');
  const originals = {
    transport: transport.createWalletTorTransport,
    network: registry.getNetwork,
    endpoints: registry.getEndpoints,
    sources: registry.getEndpointSources,
    available: settings.isWalletTorExperimentAvailable,
    endpoint: tor.getWalletSocksEndpoint,
  };
  const rpcUrl = 'https://synthetic.invalid/railgun-kohaku';
  const endpointController = new AbortController();
  const endpoint = Object.freeze({ signal: endpointController.signal });
  let archiveFactory,
    sendObserver,
    active = true,
    txHandle,
    sentHash;
  const counters = { transportCalls: 0, sends: 0, unknownMethods: 0 };
  // Count entry before fixture currency checks so late calls cannot disappear
  // merely because the synthetic environment itself rejects them after abort.
  const attempts = {
    transportEntries: 0,
    eoaSignerEntries: 0,
    poiAcquireEntries: 0,
    preflightAcquireEntries: 0,
  };
  const methods = {};
  registry.getNetwork = () => ({ access: { readOrder: ['direct'] }, quorum: { timeoutMs: 30000 } });
  registry.getEndpoints = () => [rpcUrl];
  registry.getEndpointSources = () => [{ keyed: false, coverage: { 11155111: rpcUrl } }];
  settings.isWalletTorExperimentAvailable = () => true;
  tor.getWalletSocksEndpoint = () => endpoint;
  transport.createWalletTorTransport = () => ({
    release() {},
    close() {},
    async request(handle, url, options) {
      attempts.transportEntries++;
      assert.ok(active && !options.signal.aborted);
      const context = getPrivacyContext(handle);
      assert.equal(url, rpcUrl);
      assert.equal(options.method, 'POST');
      const wire = JSON.parse(options.body);
      assert.equal(wire.jsonrpc, '2.0');
      counters.transportCalls++;
      methods[wire.method] = (methods[wire.method] ?? 0) + 1;
      let result;
      if (wire.method === 'eth_chainId') result = '0xaa36a7';
      else if (context.subject.role === 'protocol-rpc') {
        assert.ok(archiveFactory);
        result = (
          await archiveFactory(handle, 'protocol-rpc', { signal: options.signal }).request(
            wire.method,
            wire.params,
            () => true
          )
        ).result;
      } else {
        assert.equal(context.subject.role, 'transaction-rpc');
        txHandle = handle;
        const responses = {
          eth_getCode: '0x',
          eth_getBalance: '0x100000000000000',
          eth_getTransactionCount: '0x0',
          eth_gasPrice: '0x64',
          eth_estimateGas: '0x100000',
          eth_call: '0x',
        };
        if (wire.method === 'eth_sendRawTransaction') {
          counters.sends++;
          assert.equal(counters.sends, 1);
          assert.equal(typeof sendObserver, 'function');
          const tx = Transaction.from(wire.params[0]);
          sentHash = tx.hash.toLowerCase();
          await sendObserver(handle, tx);
          if (uncertain) throw Error('Synthetic lost acknowledgment');
          result = sentHash;
        } else {
          if (!Object.hasOwn(responses, wire.method)) counters.unknownMethods++;
          assert.ok(Object.hasOwn(responses, wire.method), wire.method);
          result = responses[wire.method];
        }
      }
      assert.ok(active && !options.signal.aborted);
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result })),
      };
    },
  });
  function close() {
    active = false;
    endpointController.abort();
    transport.createWalletTorTransport = originals.transport;
    registry.getNetwork = originals.network;
    registry.getEndpoints = originals.endpoints;
    registry.getEndpointSources = originals.sources;
    settings.isWalletTorExperimentAvailable = originals.available;
    tor.getWalletSocksEndpoint = originals.endpoint;
  }
  return {
    inputType,
    measureActivity: () => ({
      counters: { ...counters },
      attempts: { ...attempts },
      methods: { ...methods },
    }),
    configureArchive(factory) {
      assert.equal(archiveFactory, undefined);
      archiveFactory = factory;
    },
    close,
    async qualify({
      account: initialAccount,
      owners,
      archive,
      proverArchive,
      artifactDirectory,
      row,
      observeKeys,
      readKeyCounts,
      measureResources,
    }) {
      const started = performance.now();
      const wallet = require('../../src/main/wallet/railgun-account-wallet');
      for (const name of [
        'railgun-kohaku-plugin',
        'railgun-private-operation',
        'railgun-private-submission',
      ])
        assert.equal(require.cache[require.resolve('../../src/main/wallet/' + name)], undefined);
      const poi = require('../../src/main/wallet/railgun-account-poi');
      const preflight = require('../../src/main/wallet/railgun-private-preflight');
      const services = require('../../src/main/wallet/railgun-public-services');
      const signerModule = require('../../src/main/wallet/signers');
      const saved = {
        poi: { ...poi },
        preflight: { ...preflight },
        service: services.createRailgunPublicServices,
        signer: signerModule.getSigner,
      };
      const { identity, enrollment, coordinator } = owners;
      const rpc = require('../../src/main/networks/private-rpc');
      const serviceInstances = [],
        preflightSources = [],
        borrowedKeys = [],
        plugins = [],
        reviewGates = [];
      const counts = {
        preparationReviews: 0,
        transactionReviews: 0,
        spendingKeys: 0,
        eoaSignatures: 0,
        poiAcquisitions: 0,
        preflightAcquisitions: 0,
        constrainedPreflightClients: 0,
        latest: 0,
        page: 0,
        root: 0,
      };
      const contractReads = [];
      let settlements;
      let account = initialAccount,
        plugin,
        seedTask,
        txid,
        protocolConstraint,
        reviewMode = 'deny',
        heldReview,
        transactionReview,
        preparingAccount,
        expectedDigest,
        journalBeforeSend = false;
      const signalController = new AbortController();
      const fixtureCurrent = () => assert.ok(active && !signalController.signal.aborted);
      const snapshot = () => ({
        ...counters,
        ...counts,
        methods: { ...methods },
        attempts: { ...attempts },
        keys: readKeyCounts(),
      });
      const measureReads = () => ({ ...snapshot(), resources: measureResources() });
      const reservations = await enrollment.openReservations();
      const capsules = await enrollment.openPrivateCapsules();
      const initialReservations = await reservations.inspect();
      const initialCapsules = await capsules.inspect();
      const privateBytes = () =>
        ['railgun-private-reservations-v1', 'railgun-private-capsules-v1'].map((record) => {
          const handle = enrollment.getContext(
            'storage',
            record + ':' + identity.descriptor.walletId
          );
          const filename = require('../../src/main/wallet/privacy-storage').getPrivacyStoragePath(
            handle,
            enrollment.directory
          );
          return createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
        });
      const poiSources = new WeakMap(),
        flights = new WeakMap();
      const owner = (await saved.signer(0).getAddress()).toLowerCase();
      signerModule.getSigner = (index) => {
        assert.equal(index, 0);
        const signer = saved.signer(index);
        return Object.freeze({
          getAddress: () => signer.getAddress(),
          async signTransaction(transaction) {
            attempts.eoaSignerEntries++;
            fixtureCurrent();
            counts.eoaSignatures++;
            assert.equal(counts.eoaSignatures, 1);
            return signer.signTransaction(transaction);
          },
        });
      };
      // Synthetic external list authority only. The real controller creates and
      // authenticates the operation window; we never fabricate its receipt.
      poi.openRailgunPrivateWindowPoi = ({ wallet: currentAccount, window }) => {
        fixtureCurrent();
        const data = wallet.assertRailgunAccountPrivateWindow(window, currentAccount, owners);
        preparingAccount = currentAccount;
        const drained = gate();
        let closed = false;
        const source = {
          closed: drained.promise,
          close() {
            closed = true;
            drained.resolve();
          },
          async acquire() {
            attempts.poiAcquireEntries++;
            fixtureCurrent();
            assert.equal(closed, false);
            counts.poiAcquisitions++;
            const receipt = Object.freeze({});
            const observation = Object.freeze({
              input: Object.freeze({
                id: selected.id,
                tree: data.selection.tree,
                position: data.selection.position,
                noteHash: selected.hash,
                nullifier: selected.nullifier,
                checkpointHash: baseline.checkpointHash,
                blindedCommitment: selected.blindedCommitment,
                type: selected.type,
              }),
              statuses: Object.freeze([{ status: 'Valid' }]),
              membershipVerified: true,
              rootsAccepted: true,
              publicThrough: baseline.read.readiness.to,
            });
            poiSources.set(source, {
              receipt,
              observation,
              window,
              account: currentAccount,
              current: () => assert.equal(closed, false),
            });
            return { status: 'verified', receipt, observation };
          },
        };
        return source;
      };
      poi.assertRailgunPrivateWindowPoi = (
        source,
        receipt,
        actualAccount,
        actualOwners,
        window,
        margin
      ) => {
        fixtureCurrent();
        const entry = poiSources.get(source);
        entry.current();
        assert.equal(entry.receipt, receipt);
        assert.equal(entry.window, window);
        assert.equal(entry.account, actualAccount);
        assert.equal(actualOwners.identity, identity);
        wallet.assertRailgunAccountPrivateWindow(window, actualAccount, owners, margin);
        return entry.observation;
      };
      // Trust is simulated, but the constraint must be real and usable against
      // the genuine private-RPC destination registry. No preflight RPC is issued.
      preflight.createRailgunPrivatePreflight = ({
        enrollment: actual,
        input,
        destinationConstraint,
      }) => {
        fixtureCurrent();
        assert.equal(actual, enrollment);
        assert.ok(destinationConstraint);
        if (protocolConstraint) assert.equal(destinationConstraint, protocolConstraint);
        else protocolConstraint = destinationConstraint;
        const lifetime = createPrivacyScope({
          profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
          signal: enrollment.signal,
        });
        const parent = getPrivacyContext(
          enrollment.getContext('protocol-rpc', 'private-preflight')
        );
        const handle = lifetime.getContext(parent.subject);
        const client = rpc.createPrivateRpc(handle, 'protocol-rpc', { destinationConstraint });
        const destination = rpc.getPrivateRpcDestination(client, handle);
        assert.equal(rpc.getPrivateRpcDestinationDetails(destination).url, rpcUrl);
        counts.constrainedPreflightClients++;
        const current = () => {
          fixtureCurrent();
          client.assertActive();
        };
        const source = {
          signal: client.signal,
          close() {
            lifetime.close();
            client.release();
          },
          async acquire() {
            attempts.preflightAcquireEntries++;
            current();
            counts.preflightAcquisitions++;
            const receipt = Object.freeze({});
            const observation = Object.freeze({
              input,
              inputUnspent: true,
              rootAccepted: true,
              deploymentMatched: true,
              verifierMatched: true,
              unshieldFeeBps: 25,
              trust: 'simulated',
            });
            flights.set(source, { receipt, observation, current });
            return { receipt, observation };
          },
        };
        preflightSources.push(source);
        return source;
      };
      preflight.assertRailgunPrivatePreflight = (source, receipt, actual) => {
        assert.equal(actual, enrollment);
        const entry = flights.get(source);
        entry.current();
        assert.equal(entry.receipt, receipt);
        return entry.observation;
      };
      let baseline, selected, note;
      try {
        // Seed one real completed TXID checkpoint. Its row/root service replies
        // are synthetic; pinned utility hashing/path checks and storage are real.
        if (inputType === 'Transact') {
          assert.ok(row);
          assert.equal(
            require.cache[require.resolve('../../src/main/wallet/railgun-account-txid')],
            undefined
          );
          await account.close();
          let payload;
          seedTask = require('../../src/main/wallet/railgun-process').startRailgunProcess({
            handle: enrollment.getContext('engine', 'note-provenance'),
            filename: require.resolve('./railgun-transact-staging-row'),
            input: JSON.stringify({ archive, row }),
            lifetimeMs: 60000,
            broker: {
              signal: enrollment.signal,
              async dispatch(wire) {
                const message = JSON.parse(wire);
                assert.equal(message.id, 1);
                assert.equal(message.method, 'result');
                assert.equal(payload, undefined);
                assert.equal(message.value.guards.attempts, 0);
                payload = message.value;
                return JSON.stringify({ id: 1, value: null });
              },
            },
          });
          await seedTask.ready;
          seedTask.close();
          assert.equal((await seedTask.closed).code, 'RAILGUN_PROCESS_CLOSED');
          seedTask = undefined;
          assert.equal(payload.state.count, 1);
          services.createRailgunPublicServices = (handle) => {
            const context = getPrivacyContext(handle),
              controller = new AbortController();
            assert.equal(context.subject.role, 'public-services');
            const signal = AbortSignal.any([context.signal, controller.signal]);
            const current = () => {
              fixtureCurrent();
              assert.equal(signal.aborted, false);
              getPrivacyContext(handle);
            };
            const service = {
              signal,
              close: () => controller.abort(),
              async latestTxid() {
                current();
                counts.latest++;
                return { index: 0, root: payload.state.root };
              },
              async txidPage(cursor) {
                current();
                assert.equal(cursor, '0x00');
                counts.page++;
                return { transactions: [structuredClone(payload.row)] };
              },
              async validateTxidRoot(value) {
                current();
                assert.deepEqual(value, { tree: 0, index: 0, root: payload.state.root });
                counts.root++;
                return true;
              },
            };
            serviceInstances.push(service);
            return service;
          };
          txid = await require('../../src/main/wallet/railgun-account-txid').openRailgunAccountTxid(
            { enrollment, coordinator, archive, create: true }
          );
          await txid.advance();
          assert.deepEqual((await txid.inspect()).checkpoint.state, payload.state);
          await txid.close();
          txid = undefined;
          account = await wallet.openRailgunAccountWallet({ ...owners, archive, mode: 'active' });
        }
        baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
        selected = baseline.ownedPoi.find(
          (record) =>
            record.type === inputType &&
            baseline.read.received.some((n) => n.id === record.id && n.spentTxid === false)
        );
        assert.ok(selected);
        note = baseline.read.received.find((n) => n.id === selected.id);
        const recipient =
          kind === 'railgun-private-transfer' ? identity.descriptor.instanceId : owner;
        const amount = {
          asset: { __type: 'erc20', contract: pins.wrappedNative },
          amount: note.amount,
          noteId: note.id,
        };
        let approvedSummary;
        const pluginOptions = {
          account,
          owners,
          signal: signalController.signal,
          mode: 'private',
          archive,
          proverArchive,
          artifactDirectory,
          gasLimit: 1500000n,
          maxGasFee: 2000000000000000n,
          async reviewPreparation(summary, context) {
            fixtureCurrent();
            counts.preparationReviews++;
            assert.equal(context.signal.aborted, false);
            assert.equal(summary.inputType, inputType);
            assert.equal(summary.fullNote, true);
            assert.equal(summary.amount, note.amount.toString());
            assert.equal(summary.recipient, recipient);
            assert.equal(summary.selectedInputs, 1);
            assert.equal(summary.broadcastsTransaction, false);
            assert.equal(summary.rpcAdmissionDestinationPinned, true);
            assert.deepEqual(summary.destinations, {
              retainedSource: rpcUrl,
              protocolRpc: rpcUrl,
              transactionRpc: rpcUrl,
              poi: 'https://ppoi.fdi.network',
              txid: inputType === 'Transact' ? 'https://ppoi.fdi.network' : null,
            });
            approvedSummary = summary;
            if (reviewMode === 'hold') {
              heldReview.started.resolve();
              await heldReview.release.promise;
            }
            return reviewMode !== 'deny';
          },
          async reviewTransaction(summary, context) {
            fixtureCurrent();
            counts.transactionReviews++;
            assert.equal(context.signal.aborted, false);
            assert.equal(summary.from.toLowerCase(), owner);
            assert.equal(expectedDigest, undefined);
            expectedDigest = summary.intent.intentDigest;
            assert.match(expectedDigest, /^0x[0-9a-f]{64}$/);
            assert.equal(counts.eoaSignatures, 0);
            assert.equal(counters.sends, 0);
            assert.equal(methods.eth_estimateGas, 1);
            assert.equal(methods.eth_call, 1);
            if (cancelTransactionReview) {
              transactionReview.started.resolve();
              await transactionReview.release.promise;
            }
            return true;
          },
        };
        if (privateAdapterMode) {
          const adapterTools = require('./railgun-kohaku-private-native');
          settlements = adapterTools.installPrivateAdapterSettlementObserver();
          const {
            createRailgunKohakuPrivateHost,
          } = require('../../src/main/wallet/railgun-kohaku-private-host');
          const {
            createRailgunKohakuPrivateAdapter,
            createRailgunKohakuPrivateAdapterBroadcaster,
          } = require('../../src/main/wallet/railgun-kohaku-private-adapter');
          const { mode: ignoredMode, ...hostOptions } = pluginOptions;
          assert.equal(ignoredMode, 'private');
          plugin = createRailgunKohakuPrivateAdapter({
            host: createRailgunKohakuPrivateHost(hostOptions),
            signal: signalController.signal,
          });
          plugins.push(plugin);
          const adapterReads = await adapterTools.qualifyPrivateAdapterReads({
            adapter: plugin,
            account,
            owners,
            measure: measureReads,
          });
          const broadcast = createRailgunKohakuPrivateAdapterBroadcaster(plugin).broadcast;
          const prepare = () =>
            kind === 'railgun-private-transfer'
              ? plugin.prepareTransfer(amount, recipient)
              : plugin.prepareUnshield(amount, recipient);
          const branchBefore = snapshot();
          const durableBefore = privateBytes();
          const assertAdapterRpc = (denied) => {
            const expectedMethods = {
              eth_chainId: denied ? 10 : 12,
              eth_getBlockByNumber: denied ? 710 : inputType === 'Transact' ? 740 : 720,
              eth_getLogs: 16,
              ...(denied
                ? {}
                : {
                    eth_getCode: 2,
                    eth_getBalance: 2,
                    eth_estimateGas: 1,
                    eth_call: 1,
                    eth_gasPrice: 1,
                    eth_getTransactionCount: 3,
                    eth_sendRawTransaction: 1,
                  }),
            };
            assert.deepEqual(methods, expectedMethods, 'Source-derived complete adapter RPC map');
            assert.equal(
              counters.transportCalls,
              Object.values(expectedMethods).reduce((n, v) => n + v, 0)
            );
            assert.equal(counters.unknownMethods, 0);
          };

          reviewMode = privateAdapterDenied ? 'deny' : 'allow';
          if (privateAdapterDenied) {
            await assert.rejects(prepare(), { code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED' });
            await plugin.closed;
            assert.equal(account.signal.aborted, true);
            assert.deepEqual(snapshot(), {
              ...branchBefore,
              preparationReviews: branchBefore.preparationReviews + 1,
            });
            assert.deepEqual(await reservations.inspect(), initialReservations);
            assert.deepEqual(await capsules.inspect(), initialCapsules);
            assert.deepEqual(privateBytes(), durableBefore);
            assertAdapterRpc(true);
            const refusedReads = await adapterTools.assertPrivateAdapterReadRefusals(
              plugin,
              measureReads
            );
            assert.deepEqual(settlements.report(), {
              delegateCalls: 0,
              delegateSettlements: 0,
              checkedCalls: 0,
              acknowledged: 0,
              uncertain: 0,
              refused: 0,
            });
            return {
              mode,
              variant: 'private-adapter-denied',
              inputType,
              kind,
              elapsedMs: Math.round(performance.now() - started),
              privateAdapter: {
                reads: adapterReads,
                closedReadRefusals: refusedReads,
                forwarding: settlements.report(),
                adoptingAccountClosed: true,
                deniedPreparationNoQueriesKeysOrDurableChanges: true,
                realProofQualified: false,
                realSubmissionQualified: false,
              },
              productionFacade: true,
              productionRestrictedPrivateHost: true,
              productionRestrictedPrivateAdapter: true,
              genericHostQualified: false,
              counts,
              attempts: { ...attempts },
              rpc: { ...counters, methods: { ...methods } },
              liveQueries: 0,
              liveSubmissions: 0,
            };
          }
          observeKeys(async (key) => {
            counts.spendingKeys++;
            borrowedKeys.push(key);
            assert.equal(counts.spendingKeys, 1);
            const held = await reservations.inspect(),
              stored = await capsules.inspect();
            assert.equal(held.signing, initialReservations.signing + 1);
            assert.equal(stored.records, initialCapsules.records + 1);
            assert.equal(stored.signatures, initialCapsules.signatures);
          });
          const operation = await prepare();
          contractOracle.assertOpaqueOperationShape(operation, 'private');
          const preparedReads = await adapterTools.assertPrivateAdapterReadRefusals(
            plugin,
            measureReads
          );
          assert.equal(counts.spendingKeys, 1);
          assert.equal(counts.poiAcquisitions, 1);
          assert.ok(borrowedKeys.every((key) => key.every((value) => value === 0)));
          assert.ok(preparingAccount);
          if (inputType === 'Transact') {
            assert.notEqual(preparingAccount, account);
            assert.equal(account.signal.aborted, true);
          }
          const capsuleState = await capsules.inspect();
          assert.equal(capsuleState.signatures, initialCapsules.signatures + 1);
          assert.equal(capsuleState.proofs, initialCapsules.proofs + 1);
          const privateBefore = privateBytes();
          const beforeCopies = snapshot();
          await assert.rejects(broadcast({ ...operation }), {
            code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED',
          });
          await assert.rejects(broadcast(JSON.parse(JSON.stringify(operation))), {
            code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED',
          });
          assert.deepEqual(snapshot(), beforeCopies);
          sendObserver = async (handle, tx) => {
            assert.equal(tx.from.toLowerCase(), owner);
            assert.equal(tx.chainId, 11155111n);
            const journal =
              require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                handle
              );
            const records = await journal.list();
            assert.equal(records.length, 1);
            assert.equal(records[0].hash, tx.hash.toLowerCase());
            assert.equal(records[0].state, 'attempted');
            assert.equal(records[0].intent.intentDigest, expectedDigest);
            assert.deepEqual(
              records[0].intent,
              require('../../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
                tx
              )
            );
            journalBeforeSend = true;
          };
          const forwarded = settlements.begin(() => broadcast(operation));
          const result = await forwarded.promise;
          const outcomeSchema = await forwarded.assert({
            outcome: uncertain ? 'uncertain' : 'acknowledged',
            hash: sentHash,
          });
          await plugin.closed;
          assert.equal(preparingAccount.signal.aborted, true);
          assert.deepEqual(privateBytes(), privateBefore);
          assert.ok(approvedSummary);
          assert.equal(counts.preparationReviews, 1);
          assert.equal(counts.transactionReviews, 1);
          assert.equal(counts.eoaSignatures, 1);
          assert.equal(counts.preflightAcquisitions, 2);
          assert.equal(counts.constrainedPreflightClients, 2);
          assert.equal(counters.sends, 1);
          assert.equal(counters.unknownMethods, 0);
          assert.equal(journalBeforeSend, true);
          assert.ok(txHandle && sentHash);
          if (uncertain) {
            assert.equal(result.submissionStatus, 'unknown');
            assert.equal(result.transactionHash, sentHash);
          } else assert.equal(result.hash.toLowerCase(), sentHash);
          assertAdapterRpc(false);
          assert.deepEqual(
            { latest: counts.latest, page: counts.page, root: counts.root },
            inputType === 'Transact'
              ? { latest: 6, page: 1, root: 5 }
              : { latest: 0, page: 0, root: 0 }
          );
          // Existing broker counters increment before dispatch, for these purposes
          // only. private-operate is deliberately not measured by privateViewingKeys.
          const keyCounts = readKeyCounts();
          const keyRequestDeltas = {
            privatePrepare: keyCounts.privateViewingKeys - branchBefore.keys.privateViewingKeys,
            privateReceive: keyCounts.privateReceiveKeys - branchBefore.keys.privateReceiveKeys,
          };
          assert.deepEqual(keyRequestDeltas, {
            privatePrepare: 0,
            privateReceive: inputType === 'Transact' ? 0 : 1,
          });
          const closedReads = await adapterTools.assertPrivateAdapterReadRefusals(
            plugin,
            measureReads
          );
          const noRetry = snapshot();
          await assert.rejects(broadcast(operation), {
            code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED',
          });
          assert.deepEqual(snapshot(), noRetry);
          const reopenedScope = createPrivacyScope({
            profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
            signal: enrollment.signal,
          });
          try {
            const handle = reopenedScope.getContext({
              kind: 'public-address',
              principal: owner,
              chainId: pins.chainId,
              role: 'transaction-rpc',
            });
            const journal =
              require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                handle
              );
            const records = await journal.list();
            assert.equal(records.length, 1);
            assert.equal(records[0].hash, sentHash);
            assert.equal(records[0].intent.intentDigest, expectedDigest);
            assert.equal(records[0].state, uncertain ? 'attempted' : 'submitted');
            await assert.rejects(journal.assertCanSubmit());
            let matched = 0;
            await reservations.withSigningRecovery(async (records, context) => {
              context.assertCurrent();
              const entry = records.find((v) => v.entry.facts.noteHash === selected.hash)?.entry;
              assert.ok(entry);
              const stored = await capsules.get(entry.id);
              assert.ok(stored.signature && stored.provedTransaction);
              assert.equal(entry.facts.intentDigest, expectedDigest);
              require('../../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
                stored.capsule.preparation.transaction,
                stored.provedTransaction,
                stored.capsule.preparation.expected
              );
              matched++;
            });
            assert.equal(matched, 1);
            assert.deepEqual(privateBytes(), privateBefore);
          } finally {
            reopenedScope.close();
          }
          assert.ok(serviceInstances.every((service) => service.signal.aborted));
          assert.ok(preflightSources.every((source) => source.signal.aborted));
          return {
            mode,
            variant: 'private-adapter',
            inputType,
            kind,
            elapsedMs: Math.round(performance.now() - started),
            privateAdapter: {
              reads: adapterReads,
              preparedReadRefusals: preparedReads,
              closedReadRefusals: closedReads,
              forwarding: settlements.report(),
              outcomeSchema,
              adoptingAccountClosed: true,
              copiedAndRepeatedOperationRefused: true,
              originalSettlementValuePreserved: true,
              keyRequestDeltas,
              operateRequestsMeasured: false,
            },
            productionFacade: true,
            productionRestrictedPrivateHost: true,
            productionRestrictedPrivateAdapter: true,
            genericHostQualified: false,
            productionStaging: inputType === 'Transact',
            productionOperationAndSubmissionControllers: true,
            genuineCompletionOnly: true,
            productionRpcDestinationConstraints: true,
            privatePreflightConstraintPassedAndValidated: true,
            realPreflightClientsNativeQualified: false,
            syntheticAccountPoiAuthority: true,
            syntheticPrivatePreflightAuthority: true,
            privatePreflightChainGuardsNativeQualified: false,
            syntheticPublicServices: inputType === 'Transact',
            actualPinnedProofAndIndependentVerifier: true,
            realVaultPrivateAndEoaSigning: true,
            durableCapsuleBeforeSpendingKey: true,
            journalBeforeSimulatedSend: true,
            transactionSimulationBeforeReview: true,
            lostAcknowledgment: uncertain,
            freshJournalContextReopened: true,
            unresolvedSubmissionBlocksAnotherSend: true,
            privateSigningStateUnchanged: true,
            facadeClosesWalletBeforeSubmission: true,
            keyBuffersWiped: true,
            physicalTorTransportQualified: false,
            counts,
            attempts: { ...attempts },
            rpc: { ...counters, methods: { ...methods } },
            liveQueries: 0,
            liveSubmissions: 0,
          };
        }
        const facade = require('../../src/main/wallet/railgun-kohaku-plugin');
        settlements = installSettlementObserver('private');
        const {
          createRailgunKohakuBroadcaster,
        } = require('../../src/main/wallet/railgun-kohaku-broadcaster');
        plugin = facade.createRailgunKohakuPlugin(pluginOptions);
        plugins.push(plugin);
        contractReads.push(
          await contracts.qualifyOperationInstance({
            instance: plugin,
            account,
            owners,
            mode: 'private',
            measure: measureReads,
          })
        );
        const broadcast = createRailgunKohakuBroadcaster(plugin).broadcast;
        const prepare = () =>
          kind === 'railgun-private-transfer'
            ? plugin.prepareTransfer(amount, recipient)
            : plugin.prepareUnshield(amount, recipient);
        assert.equal(await plugin.instanceId(), identity.descriptor.instanceId);
        assert.ok((await plugin.notes()).some((n) => n.id === selected.id));
        assert.throws(() => facade.createRailgunKohakuPlugin(pluginOptions));
        const deniedBefore = snapshot();
        await assert.rejects(prepare(), { code: 'RAILGUN_KOHAKU_REFUSED' });
        const deniedAfter = snapshot();
        assert.deepEqual(deniedAfter, {
          ...deniedBefore,
          preparationReviews: deniedBefore.preparationReviews + 1,
        });
        assert.deepEqual(await reservations.inspect(), initialReservations);
        assert.deepEqual(await capsules.inspect(), initialCapsules);
        assert.equal(plugin.status().state, 'ready');
        observeKeys(async (key) => {
          counts.spendingKeys++;
          borrowedKeys.push(key);
          assert.equal(counts.spendingKeys, 1);
          const held = await reservations.inspect(),
            savedCapsules = await capsules.inspect();
          assert.equal(held.signing, initialReservations.signing + 1);
          assert.equal(savedCapsules.records, initialCapsules.records + 1);
          assert.equal(savedCapsules.signatures, initialCapsules.signatures);
          if (inputType === 'Transact') {
            assert.equal(counts.page, 1);
            assert.ok(counts.root >= 2);
          }
        });
        reviewMode = 'hold';
        heldReview = { started: gate(), release: gate() };
        reviewGates.push(heldReview);
        const pending = prepare();
        await Promise.race([
          heldReview.started.promise,
          pending.then(() => {
            throw Error('Preparation settled before the held review');
          }),
        ]);
        try {
          const before = snapshot();
          await assert.rejects(plugin.notes());
          await assert.rejects(prepare());
          await assert.rejects(broadcast({ __type: 'privateOperation' }));
          assert.deepEqual(snapshot(), before);
        } finally {
          heldReview.release.resolve();
        }
        const operation = await pending;
        contractOracle.assertOpaqueOperationShape(operation, 'private');
        assert.deepEqual(operation, { __type: 'privateOperation' });
        assert.equal(plugin.status().state, 'prepared');
        assert.equal(counts.spendingKeys, 1);
        assert.equal(counts.poiAcquisitions, 1);
        assert.ok(borrowedKeys.every((key) => key.every((value) => value === 0)));
        assert.ok(preparingAccount);
        if (inputType === 'Transact') {
          assert.notEqual(preparingAccount, account);
          assert.equal(account.signal.aborted, true);
        }
        assert.ok((await plugin.notes()).some((n) => n.id === selected.id));
        const capsuleState = await capsules.inspect();
        assert.equal(capsuleState.signatures, initialCapsules.signatures + 1);
        assert.equal(capsuleState.proofs, initialCapsules.proofs + 1);
        // Read bytes only: let the facade perform the real account-close handoff
        // into exclusive recovery; the fixture never closes its prepared wallet.
        const privateBefore = privateBytes();
        const beforeCopies = snapshot();
        await assert.rejects(broadcast({ ...operation }));
        await assert.rejects(broadcast(JSON.parse(JSON.stringify(operation))));
        assert.deepEqual(snapshot(), beforeCopies);
        sendObserver = async (handle, tx) => {
          assert.equal(tx.from.toLowerCase(), owner);
          assert.equal(tx.chainId, 11155111n);
          const journal =
            require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
              handle
            );
          const records = await journal.list();
          assert.equal(records.length, 1);
          assert.equal(records[0].hash, tx.hash.toLowerCase());
          assert.equal(records[0].state, 'attempted');
          assert.equal(records[0].intent.intentDigest, expectedDigest);
          assert.deepEqual(
            records[0].intent,
            require('../../src/main/wallet/railgun-transact-intent').railgunTransactJournalIntent(
              tx
            )
          );
          journalBeforeSend = true;
        };
        if (cancelTransactionReview) {
          transactionReview = { started: gate(), release: gate() };
          reviewGates.push(transactionReview);
        }
        const forwarded = settlements.begin(plugin, operation, () => broadcast(operation));
        const broadcasting = forwarded.promise;
        if (cancelTransactionReview) {
          await Promise.race([
            transactionReview.started.promise,
            broadcasting.then(() => {
              throw Error('Broadcast settled before transaction review');
            }),
          ]);
          assert.equal(preparingAccount.signal.aborted, true);
          let physicallyDrained = false;
          plugin.closed.then(() => {
            physicallyDrained = true;
          });
          const heldAttempts = { ...attempts };
          signalController.abort();
          assert.deepEqual(await broadcasting, {
            status: 'recovery-required',
            stage: 'review-draining',
          });
          assert.equal(physicallyDrained, false);
          let competingRecoveries = 0;
          await assert.rejects(
            reservations.withSigningRecovery(async () => {
              competingRecoveries++;
            }),
            { code: 'RAILGUN_ACCOUNT_PHASE_BUSY' }
          );
          assert.equal(competingRecoveries, 0);
          assert.equal(counts.eoaSignatures, 0);
          assert.equal(counters.sends, 0);
          assert.deepEqual(attempts, heldAttempts);
          assert.deepEqual(privateBytes(), privateBefore);
          transactionReview.release.resolve();
          await plugin.closed;
          assert.equal(physicallyDrained, true);
          assert.equal(counts.eoaSignatures, 0);
          assert.equal(counters.sends, 0);
          assert.deepEqual(attempts, heldAttempts);
          assert.equal(counters.unknownMethods, 0);
          assert.equal(counts.transactionReviews, 1);
          assert.equal(counts.preflightAcquisitions, 2);
          assert.equal(counts.constrainedPreflightClients, 2);
          const reopened = createPrivacyScope({
            profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
            signal: enrollment.signal,
          });
          try {
            const handle = reopened.getContext({
              kind: 'public-address',
              principal: owner,
              chainId: pins.chainId,
              role: 'transaction-rpc',
            });
            const journal =
              require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
                handle
              );
            assert.deepEqual(await journal.list(), []);
            let recovered = 0;
            await reservations.withSigningRecovery(async (records, context) => {
              context.assertCurrent();
              const entry = records.find((v) => v.entry.facts.noteHash === selected.hash)?.entry;
              assert.ok(entry);
              assert.equal(entry.state, 'signing');
              assert.equal(entry.facts.intentDigest, expectedDigest);
              const stored = await capsules.get(entry.id);
              assert.ok(stored.signature && stored.provedTransaction);
              require('../../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
                stored.capsule.preparation.transaction,
                stored.provedTransaction,
                stored.capsule.preparation.expected
              );
              recovered++;
            });
            assert.equal(recovered, 1);
            assert.deepEqual(privateBytes(), privateBefore);
          } finally {
            reopened.close();
          }
          await forwarded.assert({ outcome: 'refused' });
          const noRetry = snapshot();
          await assert.rejects(broadcast(operation));
          assert.deepEqual(snapshot(), noRetry);
          assert.ok(serviceInstances.every((service) => service.signal.aborted));
          assert.ok(preflightSources.every((source) => source.signal.aborted));
          return {
            mode,
            variant: 'transaction-review-cancel',
            contract: { reads: contractReads, forwarding: settlements.report() },
            inputType,
            kind,
            elapsedMs: Math.round(performance.now() - started),
            productionFacade: true,
            productionOperationAndSubmissionControllers: true,
            genuineCompletionOnly: true,
            productionRpcDestinationConstraints: true,
            privatePreflightConstraintPassedAndValidated: true,
            realPreflightClientsNativeQualified: false,
            syntheticAccountPoiAuthority: true,
            syntheticPrivatePreflightAuthority: true,
            privatePreflightChainGuardsNativeQualified: false,
            actualPinnedProofAndIndependentVerifier: true,
            realVaultPrivateSigning: true,
            deniedPreparationNoQueriesKeysOrDurableChanges: true,
            busyCallsNoSideEffects: true,
            copiedAndRepeatedOperationRefused: true,
            durableCapsuleBeforeSpendingKey: true,
            transactionSimulationBeforeReview: true,
            outwardRecoveryRequiredBeforeCallbackDrain: true,
            sharedSigningRecoveryExcludedUntilCallbackDrain: true,
            lateReviewApprovalNoEoaSignatureOrSend: true,
            cancellationNoAdditionalObservedWrapperEntries: true,
            attemptedEntryScope: [
              'transport.request',
              'vault-signer.signTransaction',
              'synthetic-account-poi.acquire',
              'synthetic-private-preflight.acquire',
            ],
            controllerSendAttemptAbsenceQualified: false,
            emptyEoaJournalAfterCancellation: true,
            signedPrivateHoldAndCapsuleRecoveredAfterDrain: true,
            privateSigningStateUnchanged: true,
            facadeClosesWalletBeforeSubmission: true,
            keyBuffersWiped: true,
            physicalTorTransportQualified: false,
            counts,
            attempts: { ...attempts },
            rpc: { ...counters, methods: { ...methods } },
            liveQueries: 0,
            liveSubmissions: 0,
          };
        }
        const result = await broadcasting;
        await forwarded.assert({
          outcome: uncertain ? 'uncertain' : 'acknowledged',
          hash: sentHash,
        });
        await plugin.closed;
        assert.equal(preparingAccount.signal.aborted, true);
        assert.deepEqual(privateBytes(), privateBefore);
        assert.ok(approvedSummary);
        assert.equal(counters.sends, 1);
        assert.equal(counters.unknownMethods, 0);
        assert.equal(counts.eoaSignatures, 1);
        assert.equal(counts.transactionReviews, 1);
        assert.equal(counts.preflightAcquisitions, 2);
        assert.equal(counts.constrainedPreflightClients, 2);
        assert.equal(journalBeforeSend, true);
        assert.ok(txHandle && sentHash);
        if (uncertain) {
          assert.equal(result.submissionStatus, 'unknown');
          assert.equal(result.transactionHash, sentHash);
        } else assert.equal(result.hash?.toLowerCase(), sentHash);
        const after = snapshot();
        await assert.rejects(broadcast(operation));
        await assert.rejects(plugin.notes());
        assert.deepEqual(snapshot(), after);
        const reopenedScope = createPrivacyScope({
          profileId: getPrivacyContext(enrollment.getContext('engine')).profileId,
          signal: enrollment.signal,
        });
        try {
          const handle = reopenedScope.getContext({
            kind: 'public-address',
            principal: owner,
            chainId: pins.chainId,
            role: 'transaction-rpc',
          });
          const journal =
            require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
              handle
            );
          const records = await journal.list();
          assert.equal(records.length, 1);
          assert.equal(records[0].hash, sentHash);
          assert.equal(records[0].intent.intentDigest, expectedDigest);
          assert.equal(records[0].state, uncertain ? 'attempted' : 'submitted');
          await assert.rejects(journal.assertCanSubmit());
          await reservations.withSigningRecovery(async (records, context) => {
            context.assertCurrent();
            const entry = records.find((v) => v.entry.facts.noteHash === selected.hash)?.entry;
            assert.ok(entry);
            const stored = await capsules.get(entry.id);
            assert.ok(stored.signature && stored.provedTransaction);
            assert.equal(entry.facts.intentDigest, expectedDigest);
            require('../../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
              stored.capsule.preparation.transaction,
              stored.provedTransaction,
              stored.capsule.preparation.expected
            );
          });
          assert.deepEqual(privateBytes(), privateBefore);
        } finally {
          reopenedScope.close();
        }
        // Cancellation during a held review must drain before a new owner can
        // adopt the account. This uses no proving or submission authority.
        const cancelAccount = await wallet.openRailgunAccountWallet({
          ...owners,
          archive,
          mode: 'active',
        });
        const cancellation = new AbortController(),
          review = { started: gate(), release: gate() };
        reviewGates.push(review);
        const cancelled = facade.createRailgunKohakuPlugin({
          ...pluginOptions,
          account: cancelAccount,
          signal: cancellation.signal,
          reviewPreparation: async () => {
            review.started.resolve();
            await review.release.promise;
            return true;
          },
        });
        plugins.push(cancelled);
        const beforeCancel = snapshot();
        const cancelWork = (
          kind === 'railgun-private-transfer'
            ? cancelled.prepareTransfer(amount, recipient)
            : cancelled.prepareUnshield(amount, recipient)
        ).then(
          () => {
            throw Error('Cancelled preparation succeeded');
          },
          () => null
        );
        await Promise.race([
          review.started.promise,
          cancelWork.then(() => {
            throw Error('Cancellation case settled before the held review');
          }),
        ]);
        cancellation.abort();
        let drained = false;
        cancelled.closed.then(() => {
          drained = true;
        });
        // Wait for the genuine wallet workers/stores to drain, not merely an
        // abort signal. Shared exclusion must outlive them while review runs.
        await cancelAccount.close();
        assert.equal(cancelAccount.signal.aborted, true);
        assert.equal(drained, false);
        let competingPhase, competingError;
        try {
          competingPhase =
            require('../../src/main/wallet/railgun-account-phase').claimRailgunAccountPhase(
              enrollment,
              'recovery'
            );
        } catch (error) {
          competingError = error;
        } finally {
          // A regression must not leave this unexpected claim behind and mask
          // the failure by preventing the fixture's remaining cleanup.
          competingPhase?.release();
        }
        assert.equal(competingPhase, undefined);
        assert.equal(competingError?.code, 'RAILGUN_ACCOUNT_PHASE_BUSY');
        review.release.resolve();
        await cancelWork;
        await cancelled.closed;
        assert.equal(drained, true);
        assert.deepEqual(snapshot(), beforeCancel);
        const lastAccount = await wallet.openRailgunAccountWallet({
          ...owners,
          archive,
          mode: 'active',
        });
        try {
          contractReads.push(
            await contracts.qualifyReadInstance({
              account: lastAccount,
              owners,
              signal: enrollment.signal,
              measure: measureReads,
            })
          );
        } finally {
          await lastAccount.close();
        }
        assert.ok(serviceInstances.every((service) => service.signal.aborted));
        assert.ok(preflightSources.every((source) => source.signal.aborted));
        return {
          mode,
          contract: { reads: contractReads, forwarding: settlements.report() },
          inputType,
          kind,
          elapsedMs: Math.round(performance.now() - started),
          productionFacade: true,
          productionStaging: inputType === 'Transact',
          productionOperationAndSubmissionControllers: true,
          genuineCompletionOnly: true,
          productionRpcDestinationConstraints: true,
          privatePreflightConstraintPassedAndValidated: true,
          realPreflightClientsNativeQualified: false,
          syntheticAccountPoiAuthority: true,
          syntheticPrivatePreflightAuthority: true,
          privatePreflightChainGuardsNativeQualified: false,
          syntheticPublicServices: inputType === 'Transact',
          actualPinnedProofAndIndependentVerifier: true,
          realVaultPrivateAndEoaSigning: true,
          deniedPreparationNoQueriesKeysOrDurableChanges: true,
          busyCallsNoSideEffects: true,
          currentReadAfterWalletReplacement: true,
          copiedAndRepeatedOperationRefused: true,
          durableCapsuleBeforeSpendingKey: true,
          journalBeforeSimulatedSend: true,
          transactionSimulationBeforeReview: true,
          lostAcknowledgment: uncertain,
          freshJournalContextReopened: true,
          unresolvedSubmissionBlocksAnotherSend: true,
          privateSigningStateUnchanged: true,
          facadeClosesWalletBeforeSubmission: true,
          reviewCancellationDrainedBeforeReopen: true,
          heldReviewRetainsSharedPhaseAfterWalletDrain: true,
          keyBuffersWiped: true,
          physicalTorTransportQualified: false,
          counts,
          attempts: { ...attempts },
          rpc: { ...counters, methods: { ...methods } },
          liveQueries: 0,
          liveSubmissions: 0,
        };
      } finally {
        const cleanup = async (label, run) => {
          try {
            await run();
          } catch (error) {
            nativeAssertions.record(error, 'kohaku-private.' + label);
          }
        };
        for (const [index, review] of reviewGates.entries())
          await cleanup('review.' + index, () => review.release.resolve());
        await cleanup('abort', () => signalController.abort());
        for (const [index, instance] of plugins.entries())
          await cleanup('plugin.' + index + '.close', () => instance.close());
        await Promise.all(
          plugins.map((instance, index) =>
            cleanup('plugin.' + index + '.closed', () => instance.closed)
          )
        );
        await cleanup('seed.close', () => seedTask?.close());
        await cleanup('seed.closed', () => seedTask?.closed);
        await cleanup('txid.close', () => txid?.close());
        for (const [index, source] of preflightSources.entries())
          await cleanup('preflight.' + index, () => source.close());
        for (const [index, service] of serviceInstances.entries())
          await cleanup('service.' + index, () => service.close());
        await cleanup('preparingAccount.close', () => preparingAccount?.close());
        await cleanup('account.close', () => account?.close());
        await cleanup('keys.restore', () => observeKeys(null));
        sendObserver = undefined;
        await cleanup('poi.restore', () => Object.assign(poi, saved.poi));
        await cleanup('preflight.restore', () => Object.assign(preflight, saved.preflight));
        await cleanup('services.restore', () => {
          services.createRailgunPublicServices = saved.service;
        });
        await cleanup('signer.restore', () => {
          signerModule.getSigner = saved.signer;
        });
        await cleanup('settlements.close', () => settlements?.close());
        nativeAssertions.assertEmpty();
      }
    },
  };
};
