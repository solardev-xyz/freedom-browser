/** Three fixed phases. All ownership and credit come from genuine main APIs. */
const { assert } = require('./railgun-native-assertions');
const data = require('./railgun-public-cold-data');
const handoff = require('./railgun-public-cold-handoff');
const { preview } = require('./railgun-public-cold-session');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
function anchor(chain) {
  return { number: chain.latest, hash: chain.headers[chain.latest].hash };
}
function walletFiles(state, archive) {
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const generation = state.enrollment.catalog.activeFor(
    wallet.getRailgunAccountWalletPolicy({ archive, ...state.owners })
  );
  assert.ok(generation);
  return data.inventory(generation.directory);
}
async function openWallet(state, archive, mode) {
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const account =
    mode === 'completed'
      ? await wallet.openRailgunCompletedAccountWallet({
          ...state.owners,
          archive,
          destination:
            require('../../src/main/wallet/railgun-account-public').getRailgunAccountPublicDestination(
              state.owners.coordinator,
              state.enrollment
            ),
          signal: state.signal.signal,
          timeoutMs: 180000,
        })
      : await wallet.openRailgunAccountWallet({ ...state.owners, archive, mode });
  state.accounts.push(account);
  return account;
}
function owned(account, state) {
  return require('../../src/main/wallet/railgun-account-wallet').readRailgunAccountOwnedNotes(
    account,
    state.owners
  );
}
async function readCredit(account, state, chain, baseline) {
  const value = owned(account, state);
  data.assertCredit(value, chain, baseline);
  const before = data.digest(value),
    asset = { __type: 'erc20', contract: pins.wrappedNative };
  assert.equal(await account.view.instanceId(), state.identity.descriptor.instanceId);
  const balances = await account.view.balance([asset]);
  assert.equal(balances.length, 1);
  assert.equal(balances[0].tag, 'unverified');
  assert.equal(balances[0].amount, data.wethAmount(value));
  assert.deepEqual(await account.view.notes(undefined, true), value.read.received);
  const status = await account.view.status();
  assert.equal(status.poi, 'unverified');
  assert.equal(status.spendableGranted, false);
  assert.equal(data.digest(owned(account, state)), before);
  return before;
}
async function setup({ state, archive, chain, transport, observer, mode }) {
  await state.publicAccount.advance({ to: chain.baselineTo, anchor: anchor(chain) });
  const snapshot = await state.owners.coordinator.withPublicSnapshot(({ checkpoint }) =>
    structuredClone(checkpoint)
  );
  const checkpoint = state.owners.coordinator.assertSnapshot(snapshot.evidence);
  assert.deepEqual(snapshot.value, checkpoint);
  let account = await openWallet(state, archive, 'new');
  const initial = owned(account, state);
  const baseline = {
    notesSha256: data.receivedDigest(initial),
    balanceSha256: data.digest(data.wethAmount(initial).toString()),
    checkpoint: snapshot.value,
  };
  const facade = require('../../src/main/wallet/railgun-kohaku-plugin');
  const amount = { asset: { __type: 'native' }, amount: 1000000000000n };
  let reviews = 0,
    commitment,
    record;
  function review(summary, context) {
    assert.equal(context.signal.aborted, false);
    reviews++;
    assert.equal(summary.purpose, 'railgun-public-shield-preparation');
    assert.equal(summary.operation, 'railgun-native-shield');
    assert.equal(summary.amount, amount.amount.toString());
    assert.equal(summary.recipient, state.identity.descriptor.instanceId);
    assert.equal(summary.funding.address, state.owner);
    assert.deepEqual(summary.destinations, {
      protocolRpc: transport.url,
      transactionRpc: transport.url,
    });
    assert.equal(summary.poiQueries, false);
    assert.equal(summary.sourceQueries, false);
    assert.equal(summary.permitsSigning, false);
    assert.equal(summary.permitsSimulation, true);
    for (const exposure of [
      'public-funding-address',
      'native-amount',
      'relay-adapt-shield-calldata',
      'encrypted-note',
      'eth_estimateGas',
      'eth_call',
    ])
      assert.ok(summary.exposures.transactionRpc.includes(exposure));
    assert.deepEqual(transport.snapshot().attempted.transaction, {});
    assert.deepEqual(transport.snapshot().attempted.deployment, {});
    assert.equal(state.signs, 0);
    assert.equal(state.addresses, 0);
  }
  function plugin(allowed) {
    const reviewedTraffic = transport.snapshot().attempted;
    const reviewedJobs = observer.snapshot().jobs;
    const result = facade.createRailgunKohakuPlugin({
      account,
      owners: state.owners,
      archive,
      mode: 'public',
      signal: state.signal.signal,
      gasLimit: 500000n,
      maxGasFee: 1000000000000000n,
      reviewPreparation: (summary, context) => {
        assert.deepEqual(transport.snapshot().attempted, reviewedTraffic);
        assert.deepEqual(observer.snapshot().jobs, reviewedJobs);
        review(summary, context);
        return allowed;
      },
      reviewTransaction: (summary, context) => {
        assert.equal(context.signal.aborted, false);
        assert.equal(summary.from.toLowerCase(), state.owner);
        assert.equal(summary.operation, 'railgun-native-shield');
        assert.equal(summary.amount, amount.amount);
        assert.equal(summary.recipient, state.identity.descriptor.instanceId);
        assert.equal(summary.chainStateVerified, false);
        assert.equal(state.signs, 0);
        assert.equal(transport.snapshot().attempted.transaction.eth_estimateGas, 1);
        assert.equal(transport.snapshot().attempted.transaction.eth_call, 1);
        commitment = summary.noteCommitment;
        state.reviewed = true;
        return true;
      },
    });
    state.plugins.push(result);
    return result;
  }
  const denied = plugin(false),
    before = transport.snapshot(),
    jobs = observer.snapshot();
  await assert.rejects(denied.prepareShield(amount, state.identity.descriptor.instanceId), {
    code: 'RAILGUN_KOHAKU_REFUSED',
  });
  await denied.closed;
  assert.deepEqual(transport.snapshot(), before);
  assert.deepEqual(observer.snapshot().jobs, jobs.jobs);
  assert.equal(account.signal.aborted, true);
  account = await openWallet(state, archive, 'active');
  const active = plugin(true);
  const submitter =
    require('../../src/main/wallet/railgun-kohaku-public-submitter').createRailgunKohakuPublicSubmitter(
      active
    );
  assert.throws(() =>
    require('../../src/main/wallet/railgun-kohaku-broadcaster').createRailgunKohakuBroadcaster(
      active
    )
  );
  const token = await active.prepareShield(amount, state.identity.descriptor.instanceId);
  assert.deepEqual(token, { __type: 'publicOperation' });
  assert.equal(Object.isFrozen(token), true);
  const activity = transport.snapshot();
  await assert.rejects(submitter.submit({ ...token }));
  assert.deepEqual(transport.snapshot(), activity);
  transport.onSend(async (handle, tx) => {
    const journal =
      require('../../src/main/wallet/private-submission-journal').getPrivateSubmissionJournal(
        handle
      );
    const records = await journal.list();
    assert.equal(records.length, 1);
    record = records[0];
    data.acceptSigned(chain, tx, record, checkpoint, commitment);
  });
  if (mode === 'acknowledged') {
    const result = await submitter.submit(token);
    assert.equal(result.hash, chain.transaction.hash);
    assert.equal(result.from.toLowerCase(), state.owner);
  } else
    await assert.rejects(submitter.submit(token), (error) => {
      assert.equal(error.code, 'PRIVATE_BROADCAST_UNCERTAIN');
      assert.equal(error.transactionHash, chain.transaction.hash);
      return true;
    });
  const after = transport.snapshot();
  await assert.rejects(submitter.submit(token));
  assert.deepEqual(transport.snapshot(), after);
  active.close();
  await active.closed;
  const recovery =
    require('../../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
      state.owner,
      { signal: state.signal.signal, destinationConstraint: preview(state) }
    );
  state.recovery = recovery;
  const records = await recovery.list();
  assert.equal(records.length, 1);
  assert.deepEqual(handoff.recordBinding(records[0]), handoff.recordBinding(record));
  assert.equal(records[0].state, mode === 'acknowledged' ? 'submitted' : 'attempted');
  assert.equal(records[0].resolution, undefined);
  recovery.close();
  await recovery.closed;
  assert.equal(reviews, 2);
  assert.equal(state.signs, 1);
  return {
    baseline,
    record: handoff.recordBinding(record),
    creditSha256: null,
    checks: {
      firstReviewDenied: true,
      copiedTokenRefused: true,
      replayedTokenRefused: true,

      journalBeforeActualSend: true,
    },
  };
}
// Local diagnostic measurements start after genuine wallet/public opening work.
async function diagnoseOrigin({
  account,
  state,
  chain,
  previous,
  observer,
  transport,
  captured,
  archive,
  profileDirectory,
}) {
  const { checkpointHash } = require('../../src/main/wallet/railgun-wallet-coverage');
  const { diagnoseRailgunShieldOrigin } = require('../../src/main/wallet/railgun-shield-origin');
  const initial = owned(account, state),
    checkpoint = captured.checkpoint,
    view = account.view;
  assert.equal(checkpointHash(checkpoint), initial.checkpointHash);
  assert.notEqual(checkpointHash(checkpoint), checkpointHash(previous.baseline.checkpoint));
  assert.deepEqual(checkpoint.state.trees, initial.trees);
  const before = {
    transport: transport.snapshot(),
    resources: observer.snapshot(),
    profile: handoff.profileFiles(profileDirectory),
    wallet: walletFiles(state, archive),
    owned: data.digest(initial),
    signs: state.signs,
    addresses: state.addresses,
  };
  const input = {
    account,
    owners: state.owners,
    noteId: `${chain.expected.tree}:${chain.expected.position}`,
    signal: state.signal.signal,
    transaction: chain.transaction,
    receipt: chain.receipt,
    checkpoint,
  };
  const result = (status) => ({
    status,
    trust: 'supplied-data',
    ownershipAuthenticated: false,
    canonicalityVerified: false,
    spendingEnabled: false,
    poiBypassEnabled: false,
    localJournalAuthenticated: status === 'matched',
    localAccountSnapshotSourceAuthenticated: status === 'matched',
  });
  let calls = 0,
    matches = 0,
    refusals = 0;
  const check = async (options, status) => {
    calls++;
    const value = await diagnoseRailgunShieldOrigin(options);
    assert.equal(Object.isFrozen(value), true);
    assert.deepEqual(value, result(status));
    if (status === 'matched') matches++;
    else refusals++;
    return value;
  };
  await check(input, 'matched');
  await check({ ...input, checkpoint: previous.baseline.checkpoint }, 'refused');
  const copiedAccount = Object.freeze({ ...account });
  assert.notEqual(copiedAccount, account);
  assert.deepEqual(Object.keys(copiedAccount).sort(), ['close', 'generationId', 'signal', 'view']);
  assert.deepEqual(Object.keys(copiedAccount).sort(), Object.keys(account).sort());
  for (const key of Object.keys(copiedAccount)) assert.equal(copiedAccount[key], account[key]);
  await check({ ...input, account: copiedAccount }, 'refused');
  const transaction = structuredClone(chain.transaction);
  transaction.from = '0x' + (BigInt(chain.transaction.from) ^ 1n).toString(16).padStart(40, '0');
  await check({ ...input, transaction }, 'refused');
  const cancelled = new AbortController();
  cancelled.abort();
  await check({ ...input, signal: cancelled.signal }, 'refused');
  const matched = await check(input, 'matched');
  assert.equal(calls, 6);
  assert.equal(matches, 2);
  assert.equal(refusals, 4);
  assert.equal(account.view, view);
  assert.equal(data.digest(owned(account, state)), before.owned);
  assert.deepEqual(transport.snapshot(), before.transport);
  assert.deepEqual(observer.snapshot(), before.resources);
  assert.deepEqual(handoff.profileFiles(profileDirectory), before.profile);
  assert.deepEqual(walletFiles(state, archive), before.wallet);
  assert.equal(state.signs, before.signs);
  assert.equal(state.addresses, before.addresses);
  assert.equal(state.signal.signal.aborted, false);
  return {
    result: matched,
    calls,
    matches,
    refusals,
    currentCheckpointCaptured: true,
    staleCheckpointRefused: true,
    copiedAccountRefused: true,
    changedSenderRefused: true,
    preAbortedRefused: true,
    noAddedRpcJobsWorkersOrRailgunKeys: true,
    measuredEncryptedProfileBytesUnchanged: true,
    diagnosticWalletFilesUnchanged: true,
    borrowedOwnersRemainUsable: true,
  };
}
async function resume({
  state,
  archive,
  chain,
  transport,
  observer,
  phase,
  previous,
  profileDirectory,
}) {
  assert.equal(state.owner, previous.owner);
  const before = walletFiles(state, archive);
  const recovery =
    require('../../src/main/wallet/railgun-shield-recovery').openRailgunShieldRecovery(
      state.owner,
      { signal: state.signal.signal, destinationConstraint: preview(state) }
    );
  state.recovery = recovery;
  const records = await recovery.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, previous.mode === 'acknowledged' ? 'submitted' : 'attempted');
  assert.deepEqual(handoff.recordBinding(records[0]), previous.record);
  const hash = records[0].hash;
  let resolved = records[0];
  if (phase === 'resolve') {
    assert.equal(records[0].resolution, undefined);
    transport.receiptVisibility(false);
    const unavailable = await recovery.observe(hash);
    assert.equal(unavailable.shield, null);
    assert.equal(unavailable.record.resolution, undefined);
    assert.equal(unavailable.record.observation.status, 'pending');
    transport.receiptVisibility(true);
    transport.corruptReceipt(true);
    await assert.rejects(
      recovery.resolve(hash, {
        minimumConfirmations: 3,
        review: () => {
          assert.fail('Corrupt receipt reached resolution review');
        },
      })
    );
    transport.corruptReceipt(false);
    const observed = await recovery.observe(hash);
    assert.equal(observed.shield.status, 'matched');
    assert.equal(observed.record.resolution, undefined);
    resolved = await recovery.resolve(hash, {
      minimumConfirmations: 3,
      review: (summary) => {
        assert.equal(summary.shield.status, 'matched');
        assert.equal(summary.shield.npk, chain.expected.npk);
        assert.equal(summary.shield.noteValue, chain.expected.noteValue);
        assert.equal(summary.shield.position, chain.expected.position);
        assert.equal(summary.shield.trust, 'unverified-rpc');
        return { allowNextTransaction: true, acceptedEvidence: 'unverified-rpc' };
      },
    });
  }
  assert.deepEqual(handoff.recordBinding(resolved), previous.record);
  assert.equal(resolved.resolution.railgun.outcome, 'matched');
  assert.equal(resolved.resolution.railgun.shield.position, chain.expected.position);
  assert.equal(resolved.resolution.railgun.shield.noteValue, chain.expected.noteValue);
  recovery.close();
  await recovery.closed;
  assert.equal(transport.activeRecoveryGroups(), 0);
  assert.deepEqual(
    walletFiles(state, archive),
    before,
    'Receipt recovery must not write wallet generation'
  );
  if (phase === 'resolve')
    await state.publicAccount.advance({ to: chain.baselineTo + 1, anchor: anchor(chain) });
  const checkpointSequence = observer.walletCheckpoint().sequence;
  const account = await openWallet(state, archive, phase === 'resolve' ? 'advance' : 'completed');
  const captured = observer.walletCheckpoint();
  assert.equal(captured.sequence, checkpointSequence + 1);
  assert.equal(captured.settled, true);
  const traffic = transport.snapshot();
  const creditSha256 = await readCredit(account, state, chain, previous.baseline);
  assert.equal(await readCredit(account, state, chain, previous.baseline), creditSha256);
  assert.deepEqual(transport.snapshot(), traffic);
  if (phase === 'restore') {
    assert.equal(creditSha256, previous.creditSha256);
    assert.deepEqual(
      walletFiles(state, archive),
      before,
      'Completed restore is byte-preserving for wallet generation'
    );
  }
  const originDiagnostic = await diagnoseOrigin({
    account,
    state,
    chain,
    previous,
    observer,
    transport,
    captured,
    archive,
    profileDirectory,
  });
  return {
    originDiagnostic,
    baseline: previous.baseline,
    record: previous.record,
    creditSha256,
    checks: {
      independentOwner: true,
      resolvedBeforeExplicitAdvance: phase === 'resolve',
      receiptResolutionUnverified: true,
      exactSingleCredit: true,
      unrelatedNotesPreserved: true,
      noDuplicateCredit: true,
      completedOnly: phase === 'restore',
    },
  };
}
module.exports = { setup, resume, readCredit, walletFiles };
