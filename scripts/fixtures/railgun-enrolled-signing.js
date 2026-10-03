/** Offline only: production controller, vault signer, capsule store and A/B/C;
 * external EOA/POI/preflight observations are explicitly simulated. Never load
 * this fixture in an application or point it at a real profile.
 */
const assert = require('assert/strict');
let used = false;
exports.qualify = async function qualify({
  account,
  owners,
  archive,
  proverArchive,
  artifactDirectory,
  kind,
  observeKeys,
}) {
  assert.equal(used, false);
  used = true;
  let active = true;
  const current = () => assert.equal(active, true);
  assert.ok(['railgun-private-transfer', 'railgun-token-unshield'].includes(kind));
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const { identity, enrollment } = owners;
  const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
  const selected = baseline.ownedPoi.find(
    (v) =>
      v.type === 'Shield' &&
      baseline.read.received.some((n) => n.id === v.id && n.spentTxid === false)
  );
  assert.ok(selected);
  const owner = (
    await require('../../src/main/wallet/signers').getSigner(0).getAddress()
  ).toLowerCase();
  const poiModule = require('../../src/main/wallet/railgun-account-poi');
  const preflightModule = require('../../src/main/wallet/railgun-private-preflight');
  const networkModule = require('../../src/main/wallet/private-transaction-network');
  assert.equal(
    require.cache[require.resolve('../../src/main/wallet/railgun-private-operation')],
    undefined
  );
  const original = { ...poiModule, ...preflightModule, ...networkModule };
  let negative = true,
    poiCalls = 0,
    preflightCalls = 0,
    keyReplies = 0,
    checkedBeforeKey = false;
  const borrowed = [];
  const reservations = await enrollment.openReservations();
  const capsules = await enrollment.openPrivateCapsules();
  const initialReservations = await reservations.inspect(),
    initialCapsules = await capsules.inspect();
  const poiSources = new WeakMap(),
    preflights = new WeakMap();
  poiModule.openRailgunPrivateWindowPoi = ({ window }) => {
    current();
    const data = wallet.assertRailgunAccountPrivateWindow(window, account, owners);
    const source = {
      close() {},
      acquire: async () => {
        current();
        poiCalls++;
        const receipt = {};
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
        poiSources.set(source, { receipt, observation, window });
        return { status: negative ? 'refused' : 'verified', receipt, observation };
      },
    };
    return source;
  };
  poiModule.assertRailgunPrivateWindowPoi = (
    source,
    receipt,
    actualAccount,
    actualOwners,
    window,
    margin
  ) => {
    const stored = poiSources.get(source);
    assert.equal(actualAccount, account);
    assert.equal(actualOwners.identity, identity);
    assert.equal(stored.receipt, receipt);
    assert.equal(stored.window, window);
    wallet.assertRailgunAccountPrivateWindow(window, account, owners, margin);
    return stored.observation;
  };
  preflightModule.createRailgunPrivatePreflight = ({ input }) => {
    current();
    const source = {
      close() {},
      acquire: async () => {
        current();
        preflightCalls++;
        const receipt = {},
          observation = Object.freeze({
            input,
            inputUnspent: true,
            rootAccepted: true,
            deploymentMatched: true,
            verifierMatched: true,
            unshieldFeeBps: 25,
            trust: 'simulated',
          });
        preflights.set(source, { receipt, observation });
        return { receipt, observation };
      },
    };
    return source;
  };
  preflightModule.assertRailgunPrivatePreflight = (source, receipt, actual) => {
    assert.equal(actual, enrollment);
    const stored = preflights.get(source);
    assert.equal(stored.receipt, receipt);
    return stored.observation;
  };
  networkModule.getPrivateTransactionNetwork = () => ({
    assertCanSubmit: async () => {},
    request: async (_chain, method) => {
      assert.ok(['eth_getCode', 'eth_getBalance'].includes(method));
      return { result: method === 'eth_getCode' ? '0x' : '0x100000000000000' };
    },
  });
  observeKeys(async (key) => {
    keyReplies++;
    borrowed.push(key);
    const stored = await capsules.inspect(),
      held = await reservations.inspect();
    assert.equal(stored.records, initialCapsules.records + 1);
    assert.equal(stored.signatures, initialCapsules.signatures);
    assert.equal(held.signing, initialReservations.signing + 1);
    checkedBeforeKey = true;
  });
  try {
    const {
      proveRailgunAccountPrivateOperation: prove,
    } = require('../../src/main/wallet/railgun-private-operation');
    const options = {
      account,
      owners,
      archive,
      proverArchive,
      artifactDirectory,
      request: {
        kind,
        noteId: selected.id,
        recipient: kind === 'railgun-private-transfer' ? identity.descriptor.instanceId : owner,
      },
    };
    const started = performance.now();
    const refused = await prove(options);
    assert.deepEqual(refused, { status: 'refused', stage: 'poi' });
    assert.equal(keyReplies, 0);
    assert.equal(preflightCalls, 0);
    assert.deepEqual(await capsules.inspect(), initialCapsules);
    assert.deepEqual(await reservations.inspect(), initialReservations);
    negative = false;
    const result = await prove(options);
    assert.equal(result.status, 'proved', result.stage);
    assert.equal(result.submissionEnabled, false);
    assert.equal(keyReplies, 1);
    assert.equal(checkedBeforeKey, true);
    assert.ok(borrowed.every((key) => key.every((v) => v === 0)));
    const stored = await capsules.get(result.holdId);
    assert.ok(stored.signature && stored.provedTransaction);
    assert.equal(stored.capsule.preparation.recipient, options.request.recipient);
    assert.equal(stored.capsule.selection.kind, kind);
    require('../../src/main/wallet/railgun-private-intent').matchRailgunPrivateProvedTransaction(
      stored.capsule.preparation.transaction,
      stored.provedTransaction,
      stored.capsule.preparation.expected
    );
    const before = { poiCalls, preflightCalls, keyReplies };
    const duplicate = await prove(options);
    assert.deepEqual(duplicate, { status: 'refused', stage: 'local' });
    assert.deepEqual({ poiCalls, preflightCalls, keyReplies }, before);
    const transact = baseline.ownedPoi.find(
      (v) =>
        v.type === 'Transact' &&
        baseline.read.received.some((n) => n.id === v.id && n.spentTxid === false)
    );
    assert.ok(transact);
    assert.deepEqual(
      await prove({ ...options, request: { ...options.request, noteId: transact.id } }),
      { status: 'refused', stage: 'input-provenance' }
    );
    assert.deepEqual({ poiCalls, preflightCalls, keyReplies }, before);
    return Object.freeze({
      kind,
      status: 'proved',
      elapsedMs: Math.round(performance.now() - started),
      syntheticVault: true,
      productionController: true,
      externalObservationsSimulated: true,
      simulatedPoiCalls: poiCalls,
      simulatedPreflightCalls: preflightCalls,
      syntheticVaultSpendingKeyReplies: keyReplies,
      keyBuffersWiped: true,
      durableCapsuleAndSigningCheckedBeforeKey: checkedBeforeKey,
      signatureAndProofPersisted: true,
      independentProofVerified: true,
      negativePoiNoReservationOrKey: true,
      duplicateNoNetworkOrKey: true,
      transactRefusedBeforeSideEffects: true,
      livePoiCalls: 0,
      submissions: 0,
    });
  } finally {
    active = false;
    observeKeys(null);
    delete require.cache[require.resolve('../../src/main/wallet/railgun-private-operation')];
    Object.assign(poiModule, {
      openRailgunPrivateWindowPoi: original.openRailgunPrivateWindowPoi,
      assertRailgunPrivateWindowPoi: original.assertRailgunPrivateWindowPoi,
    });
    Object.assign(preflightModule, {
      createRailgunPrivatePreflight: original.createRailgunPrivatePreflight,
      assertRailgunPrivatePreflight: original.assertRailgunPrivatePreflight,
    });
    networkModule.getPrivateTransactionNetwork = original.getPrivateTransactionNetwork;
  }
};
