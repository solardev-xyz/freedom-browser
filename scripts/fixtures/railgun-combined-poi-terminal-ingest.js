/** Terminal disposable-fixture ingestion. All store, mirror and wallet handles
 * below come from production. No acceptance response or ownership is invented. */
const fs = require('fs');
const sticky = require('./railgun-native-assertions');
const { assert } = sticky;
const data = require('./railgun-combined-poi-terminal-data');
const wallet = '../../src/main/wallet/';
const copy = (v) => JSON.parse(JSON.stringify(v));
const delta = (after, before) =>
  Object.fromEntries(
    [...new Set([...Object.keys(after), ...Object.keys(before)])]
      .map((k) => [k, (after[k] || 0) - (before[k] || 0)])
      .filter(([, v]) => v)
  );
async function project({ enrollment, archive, signal, row, history }) {
  const {
    createPrivacyScope,
    getPrivacyContext,
  } = require('../../src/main/networks/privacy-context');
  const parent = getPrivacyContext(enrollment.getContext('engine'));
  const scope = createPrivacyScope({
    profileId: parent.profileId,
    signal: AbortSignal.any([parent.signal, signal]),
  });
  let task,
    result,
    failed = false,
    accepting = true;
  try {
    task = require(wallet + 'railgun-process').startRailgunProcess({
      handle: scope.getContext({ ...parent.subject, operation: 'combined-poi-row-fixture' }),
      filename: require.resolve('./railgun-combined-poi-row-job'),
      input: JSON.stringify({
        archive,
        priorRows: history.rows,
        row,
        kind: 'terminal-full-unshield',
      }),
      startupMs: 30000,
      lifetimeMs: 60000,
      broker: {
        signal: scope.signal,
        dispatch: async (text) => {
          try {
            assert.ok(accepting && !failed && !scope.signal.aborted);
            assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
            assert.equal(result, undefined);
            const m = JSON.parse(text);
            assert.deepEqual(Object.keys(m).sort(), ['id', 'method', 'value']);
            assert.equal(m.id, 1);
            assert.equal(m.method, 'result');
            assert.deepEqual(Object.keys(m.value).sort(), [
              'checkpoints',
              'guards',
              'rows',
              'state',
            ]);
            const value = m.value;
            assert.equal(value.rows.length, history.rows.length + 1);
            assert.equal(JSON.stringify(value.rows.slice(0, -1)), JSON.stringify(history.rows));
            assert.equal(
              JSON.stringify(value.checkpoints.slice(0, -1)),
              JSON.stringify(history.checkpoints)
            );
            assert.equal(value.checkpoints.length, value.rows.length);
            assert.deepEqual(value.checkpoints.at(-1), value.state);
            const { verificationHash, ...actual } = value.rows.at(-1);
            assert.match(verificationHash, /^0x[0-9a-f]{64}$/);
            assert.deepEqual(actual, row);
            assert.equal(value.guards.attempts, 0);
            assert.ok(value.guards.canaries > 0);
            assert.equal(value.guards.canaries, value.guards.hooks.length);
            result = value;
            return JSON.stringify({ id: 1, value: null });
          } catch (error) {
            failed = true;
            scope.close();
            throw error;
          }
        },
      },
    });
    await task.ready;
    assert.ok(result && !failed && !scope.signal.aborted);
  } finally {
    accepting = false;
    try {
      task?.close();
    } finally {
      try {
        if (task) {
          const closed = await task.closed;
          assert.equal(closed.code, 'RAILGUN_PROCESS_CLOSED');
          assert.ok(Number.isInteger(closed.exitCode));
          assert.equal(closed.escalated, false);
          assert.equal(closed.peerDisconnected, false);
        }
      } finally {
        scope.close();
      }
    }
  }
  assert.equal(signal.aborted, false);
  assert.equal(failed, false);
  sticky.assertEmpty();
  return result;
}
exports.project = project; // Fixture-only test boundary, never a production issuer.
exports.run = async (h) => {
  const {
    identity,
    enrollment,
    publicAccount,
    archive,
    first,
    second,
    chain,
    store,
    signal,
    header,
  } = h;
  const coordinator = publicAccount.coordinator;
  const owners = { identity, enrollment, coordinator };
  const current = () => assert.equal(signal.aborted, false);
  current();
  const { row, finalized } = data.rowFromSecond(second, first, header);
  const history = chain.inspectHistory();
  assert.equal(JSON.stringify(history.rows), JSON.stringify(first.rows));
  assert.deepEqual(history.state, first.state);
  assert.deepEqual(coordinator.inspect().to, {
    number: history.finalized,
    hash: header(history.finalized).hash,
  });
  const generation = publicAccount.generationId;
  const acceptanceBefore = copy(h.acceptance.report());
  assert.equal(acceptanceBefore.accepted, true);
  const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
  h.adoptStores(reservations, capsules);
  const privateRecords = async () => {
    let result;
    await reservations.withSigningRecovery(async (records, context) => {
      context.assertCurrent();
      assert.equal(records.length, 2);
      result = [];
      for (const record of records)
        result.push({
          entry: copy(record.entry),
          stored: copy(await capsules.readSigned(record.receipt)),
        });
      context.assertCurrent();
    });
    return result;
  };
  const privateBefore = await privateRecords();
  const eoaBefore = copy(await h.journal().list());
  assert.equal(eoaBefore.length, 2);
  for (const capture of [first.ownEvidence, second.capture])
    assert.ok(eoaBefore.some((r) => r.hash === capture.record.hash && r.resolution));
  const digest = require(wallet + 'railgun-private-capsule').digestRailgunPrivateCapsule(
    first.ownEvidence.capsule
  );
  const entry = await store.get(digest),
    inspect = await store.inspect();
  assert.equal(entry.state, 'attempted');
  assert.equal(inspect.reservedTransitions, 2);
  const filename = require(wallet + 'privacy-storage').getPrivacyStoragePath(
    enrollment.getContext('storage', 'railgun-poi-intents-v1:' + enrollment.descriptor.walletId),
    enrollment.directory
  );
  const bytes = fs.readFileSync(filename);
  const before = h.activity();
  h.phase('terminal-project-row');
  const projected = await project({ enrollment, archive, signal, row, history });
  const matched = require(wallet + 'railgun-own-txid').matchRailgunOwnTxid({
    capsule: second.capture.capsule,
    record: second.capture.record,
    transaction: second.transaction,
    receipt: second.receipt,
    row: projected.rows.at(-1),
  });
  assert.equal(matched.output.kind, 'unshield');
  assert.equal(matched.output.amount, first.ownEvidence.capsule.preparation.changeAmount);
  current();
  chain.appendFinalizedUnshield({
    receipt: second.receipt,
    rows: projected.rows,
    state: projected.state,
    checkpoints: projected.checkpoints,
    finalized,
  });
  // Public/TXID maintenance legitimately writes their own stores/catalog/floors.
  h.phase('terminal-public-advance');
  await publicAccount.advance({
    to: finalized,
    anchor: { number: finalized, hash: header(finalized).hash },
  });
  current();
  assert.equal(publicAccount.generationId, generation);
  assert.deepEqual(coordinator.inspect().to, { number: finalized, hash: header(finalized).hash });
  let mirror, account;
  try {
    h.phase('terminal-txid-advance');
    mirror = await require(wallet + 'railgun-account-txid').openRailgunAccountTxid({
      enrollment,
      coordinator,
      archive,
      create: false,
      signal,
    });
    current();
    const old = await mirror.inspect();
    assert.equal(old.pending, null);
    assert.deepEqual(old.checkpoint.state, history.state);
    await mirror.advance();
    current();
    const next = await mirror.inspect();
    assert.equal(next.pending, null);
    assert.deepEqual(next.checkpoint.state, projected.state);
    assert.equal(next.checkpoint.state.count, history.state.count + 1);
  } finally {
    if (mirror) await mirror.close();
  }
  current();
  const files = require('./railgun-combined-poi-change-inventory').observeWalletInventory({
    enrollment,
    coordinator,
    archive,
  });
  h.phase('terminal-wallet-advance');
  try {
    const walletModule = require(wallet + 'railgun-account-wallet');
    account = await walletModule.openRailgunAccountWallet({ ...owners, archive, mode: 'advance' });
    current();
    const owned = walletModule.readRailgunAccountOwnedNotes(account, owners);
    data.assertScanned(second.terminalBaseline, owned, first, second);
  } finally {
    if (account) await account.close();
  }
  current();
  const changed = files.assertAfter();
  assert.deepEqual(changed, ['walletAndCoverage', 'walletJournal']);
  assert.deepEqual(await privateRecords(), privateBefore);
  assert.deepEqual(await h.journal().list(), eoaBefore);
  assert.deepEqual(await store.get(digest), entry);
  assert.deepEqual(await store.inspect(), inspect);
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.deepEqual(h.acceptance.report(), acceptanceBefore);
  const after = h.activity();
  assert.deepEqual(after.eoa, before.eoa);
  assert.deepEqual(after.methods, before.methods);
  const jobs = {
    'railgun-combined-poi-row-job.js': 1,
    'railgun-public-job.js': 2,
    'railgun-txid-job.js': 6,
    'railgun-wallet-job.js': 1,
  };
  for (const key of ['starts', 'exits', 'attemptedResults', 'admittedResults', 'guards'])
    assert.deepEqual(delta(after.audit[key], before.audit[key]), jobs);
  for (const key of ['keyRequests', 'keyReplies'])
    assert.deepEqual(delta(after.audit[key], before.audit[key]), { 'railgun-wallet-job.js': 1 });
  assert.deepEqual(delta(after.audit.modes, before.audit.modes), {
    inspect: 2,
    project: 2,
    apply: 2,
  });
  const methods = {
    // Old four-header refresh + new 2*4 canonical / 1 event header + post-apply4;
    // wallet snapshot contributes 2*4 more. Existing retained RPC is chain-ready.
    'private-account:protocol-rpc:eth_getBlockByNumber': 25,
    'private-account:protocol-rpc:eth_getLogs': 1,
    // Restore pair, standalone latest, projected-root pair, final applied pair.
    'service:poi:ppoi_validated_txid': 4,
    'service:poi:ppoi_validate_txid_merkleroot': 3,
    'service:indexer:page': 1,
  };
  assert.deepEqual(delta(after.roleMethods, before.roleMethods), methods);
  assert.deepEqual(delta(after.chain.attempted, before.chain.attempted), methods);
  assert.deepEqual(delta(after.chain.validated, before.chain.validated), methods);
  assert.deepEqual(after.services.poiMethods, before.services.poiMethods);
  assert.equal(after.services.signatureChecks, before.services.signatureChecks);
  assert.equal(after.chain.posts, before.chain.posts);
  assert.equal(after.storageWorkers.starts - before.storageWorkers.starts, 2);
  assert.equal(after.storageWorkers.exits - before.storageWorkers.exits, 2);
  assert.equal(after.storageWorkers.pending, before.storageWorkers.pending);
  assert.equal(h.pendingChildren(), 0);
  assert.equal(h.unwipedLoans(), 0);
  sticky.assertEmpty();
  return Object.freeze({
    secondSpendIngestedIntoWallet: true,
    normalWalletScanObservedSpentChange: true,
    originalInputStillSpentByFirstTransaction: true,
    selectedChangeUnspentAmount: '0',
    unrelatedNotesAndBalancesPreserved: true,
    unspentWethDecreasedByExactChange: true,
    noNewUtxoLeafAndRootUnchanged: true,
    existingTxidHistoryPreserved: true,
    appendedRows: 1,
    sourceProxyLogs: 2,
    privateRecordsAndRetainedPoiUnchanged: true,
    bothResolvedEoaRecordsUnchanged: true,
    disposableAcceptedListStateUnchanged: true,
    walletChangedClasses: changed,
    jobs,
    methods,
    storageWorkers: 2,
    viewingLoans: 1,
    secondColdSubmitQualified: false,
    newProcessRestartQualified: false,
    liveEligibilityOrSubmissionQualified: false,
  });
};
