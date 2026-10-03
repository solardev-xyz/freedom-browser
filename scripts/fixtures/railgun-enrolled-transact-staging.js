/** Actual enrolled staging/provenance, optionally synthetic controller signing. */
const assert = require('assert/strict');
const { getPrivacyContext } = require('../../src/main/networks/privacy-context');
exports.qualify = async ({
  account,
  owners,
  archive,
  proverArchive,
  artifactDirectory,
  row,
  controllerKind,
  observeKeys,
}) => {
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const servicesModule = require('../../src/main/wallet/railgun-public-services');
  const originalFactory = servicesModule.createRailgunPublicServices;
  const consumers = [
    'railgun-txid-root',
    'railgun-account-txid',
    'railgun-transact-staging',
    'railgun-transact-provenance',
  ].map((name) => require.resolve('../../src/main/wallet/' + name));
  consumers.forEach((file) => assert.equal(require.cache[file], undefined));
  const { enrollment } = owners;
  const context = getPrivacyContext(enrollment.getContext('engine'));
  const instances = [];
  const counts = { latest: 0, page: 0, root: 0, callbacks: 0, creators: 0, verifications: 0 };
  let fixtureActive = true,
    task,
    txid,
    reopened,
    staged,
    payload,
    window,
    provenance,
    provenanceReceipt;
  const started = performance.now();
  try {
    const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
    // Establish that the added unrelated nullifier did not consume any owned note.
    assert.ok(baseline.ownedPoi.every((note) => note.nullifier !== row.nullifiers[0]));
    const selected = baseline.ownedPoi.filter((note) => note.type === 'Transact');
    assert.equal(selected.length, 1);
    assert.equal(selected[0].id, '0:2');
    assert.equal(selected[0].hash, row.commitments[0]);
    const request = {
      kind: controllerKind || 'railgun-private-transfer',
      noteId: selected[0].id,
      recipient:
        controllerKind === 'railgun-token-unshield'
          ? (await require('../../src/main/wallet/signers').getSigner(0).getAddress()).toLowerCase()
          : owners.identity.descriptor.instanceId,
    };
    const policy = wallet.getRailgunAccountWalletPolicy({ archive, ...owners });
    await account.close();
    assert.equal(account.signal.aborted, true);
    task = require('../../src/main/wallet/railgun-process').startRailgunProcess({
      handle: enrollment.getContext('engine', 'note-provenance'),
      filename: require.resolve('./railgun-transact-staging-row'),
      input: JSON.stringify({ archive, row }),
      lifetimeMs: 60000,
      broker: {
        signal: enrollment.signal,
        async dispatch(wire) {
          assert.ok(typeof wire === 'string' && Buffer.byteLength(wire) <= 65536);
          const message = JSON.parse(wire);
          assert.deepEqual(Object.keys(message).sort(), ['id', 'method', 'value']);
          assert.equal(message.id, 1);
          assert.equal(message.method, 'result');
          assert.equal(payload, undefined);
          assert.deepEqual(Object.keys(message.value).sort(), ['guards', 'row', 'state']);
          assert.equal(message.value.guards.attempts, 0);
          payload = message.value;
          return JSON.stringify({ id: 1, value: null });
        },
      },
    });
    await task.ready;
    task.close();
    assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
    assert.ok(payload && payload.state.count === 1);
    servicesModule.createRailgunPublicServices = (handle) => {
      const owner = getPrivacyContext(handle);
      assert.equal(owner.profileId, context.profileId);
      assert.deepEqual(owner.subject, {
        kind: 'service',
        principal: 'railgun-public-sync',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role: 'public-services',
        operation: null,
      });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, owner.signal]);
      const active = () => {
        assert.ok(fixtureActive && !signal.aborted);
        getPrivacyContext(handle);
      };
      const service = Object.freeze({
        signal,
        close: () => controller.abort(),
        async latestTxid(...args) {
          active();
          assert.equal(args.length, 0);
          counts.latest++;
          return { index: 0, root: payload.state.root };
        },
        async txidPage(...args) {
          active();
          assert.deepEqual(args, ['0x00']);
          counts.page++;
          return { transactions: [structuredClone(payload.row)] };
        },
        async validateTxidRoot(...args) {
          active();
          assert.deepEqual(args, [{ tree: 0, index: 0, root: payload.state.root }]);
          counts.root++;
          return true;
        },
      });
      instances.push(service);
      return service;
    };
    const { openRailgunAccountTxid } = require('../../src/main/wallet/railgun-account-txid');
    const {
      stageRailgunTransactInput,
      assertRailgunTransactStaging,
    } = require('../../src/main/wallet/railgun-transact-staging');
    const {
      openRailgunTransactProvenance,
      assertRailgunTransactProvenance,
    } = require('../../src/main/wallet/railgun-transact-provenance');
    servicesModule.createRailgunPublicServices = originalFactory;
    txid = await openRailgunAccountTxid({
      enrollment,
      coordinator: owners.coordinator,
      archive,
      create: true,
    });
    await txid.advance();
    assert.deepEqual((await txid.inspect()).checkpoint.state, payload.state);
    await txid.close();
    txid = undefined;
    reopened = await wallet.openRailgunAccountWallet({
      ...owners,
      archive,
      policy,
      mode: 'active',
    });
    staged = await stageRailgunTransactInput({
      account: reopened,
      owners,
      request,
      archive,
      signal: enrollment.signal,
    });
    assert.equal(staged.status, 'staged');
    assert.equal(reopened.signal.aborted, true);
    assert.notEqual(staged.account, reopened);
    const evidence = assertRailgunTransactStaging(staged.receipt, staged.account, owners, request);
    assert.deepEqual(evidence.state, payload.state);
    assert.equal(counts.page, 1);
    if (controllerKind) {
      assert.ok(['railgun-private-transfer', 'railgun-token-unshield'].includes(controllerKind));
      const controller = await require('./railgun-enrolled-signing').qualify({
        account: staged.account,
        owners,
        archive,
        proverArchive,
        artifactDirectory,
        kind: controllerKind,
        stagingReceipt: staged.receipt,
        observeKeys,
      });
      assert.equal(controller.status, 'proved');
      assert.equal(controller.inputType, 'Transact');
      assert.equal(instances.length, 5);
      assert.equal(counts.page, 1);
      assert.equal(counts.root, 5);
      assert.ok(instances.every((service) => service.signal.aborted));
      return {
        elapsedMs: Math.round(performance.now() - started),
        controller,
        serviceQueries: { latest: counts.latest, page: counts.page, root: counts.root },
        serviceInstances: instances.length,
        simulatedPublicServices: true,
        actualEnrolledPhaseHandoff: true,
        existingCheckpointRestored: true,
        syntheticVaultSigning: true,
        liveSpending: false,
        boundParamsChecked: false,
        globalTxidCompleteness: false,
      };
    }
    const result = await wallet.operateRailgunAccountPrivateIntent(
      staged.account,
      owners,
      request,
      {
        proverArchive,
        artifactDirectory,
        async onIntent(offer, signal, currentWindow) {
          counts.callbacks++;
          assert.equal(counts.callbacks, 1);
          window = currentWindow;
          assert.deepEqual(
            assertRailgunTransactStaging(staged.receipt, staged.account, owners, request, window),
            evidence
          );
          try {
            provenance = await openRailgunTransactProvenance({
              stagingReceipt: staged.receipt,
              account: staged.account,
              owners,
              request,
              window,
              signal,
            });
            const acquired = await provenance.acquireRoot();
            provenanceReceipt = acquired.receipt;
            const verified = assertRailgunTransactProvenance(
              provenance,
              provenanceReceipt,
              staged.account,
              owners,
              window,
              20000
            );
            assert.equal(verified.transactionDigest, offer.transactionDigest);
            assert.equal(verified.creatorTransactionIndex, 0);
            assert.equal(verified.creatorBlockHash, '0x' + (31).toString(16).padStart(64, '0'));
            assert.equal(verified.pathVerified, true);
            assert.equal(verified.creatorSourceAuthenticated, true);
            assert.equal(verified.boundParamsChecked, false);
            assert.equal(verified.spendingEnabled, false);
            assert.equal(verified.root.root, payload.state.root);
            assert.equal(verified.root.index, 0);
            assert.throws(() =>
              require('../../src/main/wallet/railgun-transact-staging').claimRailgunTransactStaging(
                staged.receipt,
                staged.account,
                owners,
                request,
                window
              )
            );
            assert.throws(() => provenance.acquireRoot());
            counts.creators++;
            counts.verifications++;
          } finally {
            await provenance?.close();
          }
          return { status: 'refused' };
        },
      }
    );
    assert.deepEqual(result.operation, { status: 'refused' });
    assert.equal(counts.callbacks, 1);
    assert.equal(counts.creators, 1);
    assert.equal(counts.verifications, 1);
    assert.throws(() =>
      assertRailgunTransactProvenance(provenance, provenanceReceipt, staged.account, owners, window)
    );
    assert.throws(() =>
      assertRailgunTransactStaging(staged.receipt, staged.account, owners, request, window)
    );
    await staged.account.close();
    staged.close();
    assert.equal(instances.length, 5);
    assert.ok(instances.every((service) => service.signal.aborted));
    return {
      elapsedMs: Math.round(performance.now() - started),
      counts,
      serviceInstances: instances.length,
      simulatedPublicServices: true,
      actualEnrolledPhaseHandoff: true,
      existingCheckpointRestored: true,
      sameOwnedNoteAfterHandoff: true,
      creatorPrefixAuthenticated: true,
      detachedPathVerifiedInWindow: true,
      detachedUtilityExitObserved: true,
      windowReceiptsRevoked: true,
      composedOperationReceipt: true,
      stagingReuseRefused: true,
      rootReacquisitionRefused: true,
      signingMarginCheckedMs: 20000,
      boundParamsChecked: false,
      globalTxidCompleteness: false,
      spendingEnabled: false,
    };
  } finally {
    try {
      const closed = await Promise.allSettled([
        Promise.resolve().then(() => provenance?.close()),
        Promise.resolve().then(async () => {
          task?.close();
          if (task) await task.closed;
        }),
        Promise.resolve().then(async () => {
          staged?.close();
          await staged?.account?.close();
        }),
        Promise.resolve().then(() => reopened?.close()),
        Promise.resolve().then(() => txid?.close()),
      ]);
      assert.ok(closed.every((result) => result.status === 'fulfilled'));
    } finally {
      fixtureActive = false;
      instances.forEach((service) => service.close());
      servicesModule.createRailgunPublicServices = originalFactory;
      consumers.forEach((file) => {
        delete require.cache[file];
      });
    }
  }
};
