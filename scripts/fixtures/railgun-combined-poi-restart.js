/** Setup serializes public service wire and hashes only. Resume rebuilds all
 * wallet, recovery, TXID, staging, POI and signing owners through production. */
const { assert } = require('./railgun-native-assertions');
const data = require('./railgun-combined-poi-restart-data');
const list = require('./railgun-combined-poi-list-replay');
const wallet = '../../src/main/wallet/';
const copy = (v) => JSON.parse(JSON.stringify(v));
async function original(enrollment) {
  const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
  let value;
  await reservations.withSigningRecovery(async (records, context) => {
    context.assertCurrent();
    assert.equal(records.length, 1);
    value = {
      entry: copy(records[0].entry),
      stored: copy(await capsules.readSigned(records[0].receipt)),
    };
    context.assertCurrent();
  });
  assert.equal(value.entry.state, 'signing');
  assert.ok(value.stored.signature && value.stored.provedTransaction);
  return value;
}
function hashes({ entry, stored }, record) {
  return Object.fromEntries(
    Object.entries({
      entry,
      stored,
      capsule: stored.capsule,
      signature: stored.signature,
      provedTransaction: stored.provedTransaction,
      record,
    }).map(([k, v]) => [k, data.digest(v)])
  );
}
async function completed({ enrollment, coordinator, archive }) {
  const publicModule = require(wallet + 'railgun-account-public');
  const destination = publicModule.getRailgunAccountPublicDestination(coordinator, enrollment);
  const acquired = await coordinator.withCompletedPublicSnapshot(
    { destination, signal: enrollment.signal, timeoutMs: 180000 },
    async () => undefined
  );
  const checkpoint = coordinator.assertSnapshot(acquired.evidence);
  publicModule.assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
  assert.equal(
    publicModule.assertRailgunAccountPublic(coordinator, enrollment),
    require(wallet + 'railgun-public-policy').getRailgunPublicPolicy(archive)
  );
  return copy(checkpoint);
}
async function snapshotSetup(h) {
  const { enrollment, publicAccount, store, continuation, chain, signature, inputCreator } = h;
  const privateState = await original(enrollment);
  const records = await h.journal().list();
  assert.equal(records.length, 1);
  const record = records[0];
  assert.deepEqual(record, continuation.ownEvidence.record);
  assert.deepEqual(privateState.stored.capsule, continuation.ownEvidence.capsule);
  const capsuleDigest = require(wallet + 'railgun-private-capsule').digestRailgunPrivateCapsule(
    privateState.stored.capsule
  );
  const retained = await store.get(capsuleDigest);
  assert.equal(retained.state, 'attempted');
  const submission = require(wallet + 'railgun-poi-submit-data').prepareRailgunPoiSubmission({
    requestId: retained.attempt.submission.requestId,
    payload: retained.payload,
  });
  const acceptedBody = chain.exportAcceptedBody();
  assert.equal(acceptedBody, submission.body);
  h.phase('restart-setup-checkpoint');
  const checkpoint = await completed({
    ...h,
    coordinator: publicAccount.coordinator,
  });
  return data.checkWire({
    schema: 'railgun-combined-change-public-wire-v1',
    inputCreator,
    transaction: copy(continuation.ownEvidence.transaction),
    receipt: copy(continuation.ownEvidence.receipt),
    history: chain.inspectHistory(),
    checkpoint,
    publicIdentity: copy(
      require(wallet + 'railgun-account-public').getRailgunAccountPublicIdentity(
        publicAccount.coordinator,
        enrollment
      )
    ),
    privateHashes: hashes(privateState, record),
    retained: {
      capsuleDigest,
      entrySha256: data.digest(retained),
      inspect: await store.inspect(),
    },
    acceptedBodySha256: data.sha(acceptedBody),
    list: list.snapshot({
      acceptance: h.acceptance,
      payload: retained.payload,
      signature,
    }),
  });
}
async function resume(h, mode = 'complete') {
  const { enrollment, publicAccount, wire, archive, signal } = h;
  const coordinator = publicAccount.coordinator;
  let store, mirror, replay;
  const current = () => assert.equal(signal.aborted, false);
  try {
    h.phase('restart-private-records');
    const pair =
      mode === 'recover-stop'
        ? await require('./railgun-combined-poi-second-recovery-data').readUnfinishedPair(
            enrollment,
            h.sealed.records
          )
        : mode === 'cold-submit' || mode === 'cold-submit-lost'
          ? await require('./railgun-combined-poi-second-cold').readPair(
              enrollment,
              h.sealed.records
            )
          : undefined;
    const privateState = pair ? pair.first : await original(enrollment);
    current();
    const records = await h.journal().list();
    assert.equal(records.length, 1);
    assert.deepEqual(hashes(privateState, records[0]), {
      ...wire.privateHashes,
      ...(pair ? { record: h.sealed.records.record } : {}),
    });
    assert.equal(records[0].hash, wire.transaction.hash);
    assert.ok(records[0].resolution);
    const capsuleDigest = require(wallet + 'railgun-private-capsule').digestRailgunPrivateCapsule(
      privateState.stored.capsule
    );
    assert.equal(capsuleDigest, wire.retained.capsuleDigest);
    assert.equal(privateState.stored.capsule.version, 2);
    store = await enrollment.openPoiIntents({ existingOnly: true });
    current();
    const retained = await store.get(capsuleDigest);
    assert.equal(retained.state, 'attempted');
    assert.equal(data.digest(retained), wire.retained.entrySha256);
    assert.deepEqual(await store.inspect(), wire.retained.inspect);
    const submission = require(wallet + 'railgun-poi-submit-data').prepareRailgunPoiSubmission({
      requestId: retained.attempt.submission.requestId,
      payload: retained.payload,
    });
    assert.equal(data.sha(submission.body), wire.acceptedBodySha256);
    assert.equal(retained.payload.txidMerkleroot, wire.history.state.root);
    assert.equal(retained.payload.txidMerklerootIndex, wire.history.state.count - 1);
    replay = list.create(wire.list, retained.payload);
    const chain = require('./railgun-combined-poi-chain').createReplay(
      {
        source: h.source,
        receipt: wire.receipt,
        ...wire.history,
        header: h.header,
        accountIndex: enrollment.descriptor.accountIndex,
      },
      replay
    );
    chain.bindProof(retained.payload);
    h.installChain(chain);
    if (pair) {
      assert.deepEqual(
        require(wallet + 'railgun-account-public').getRailgunAccountPublicIdentity(
          coordinator,
          enrollment
        ),
        wire.publicIdentity
      );
      const ownEvidence = {
        capsule: privateState.stored.capsule,
        record: records[0],
        transaction: wire.transaction,
        receipt: wire.receipt,
        row: wire.history.rows.at(-1),
      };
      assert.equal(
        require(wallet + 'railgun-own-txid').matchRailgunOwnTxid(ownEvidence).output.kind,
        'partial-unshield'
      );
      assert.equal(
        require('./railgun-combined-poi-second-handoff').firstImmutable(records[0]),
        h.sealed.records.immutableRecord
      );
      assert.equal(data.digest(retained), h.sealed.retained.entrySha256);
      assert.equal(data.digest(await store.inspect()), h.sealed.retained.inspectSha256);
      const stores = await enrollment.openPrivateRecoveryStores();
      h.adoptStores(stores.reservations, stores.capsules);
      h.assertBootstrapDrained();
      h.beforeSecond();
      const cold = require('./railgun-combined-poi-second-cold');
      const result = await (
        mode === 'recover-stop'
          ? require('./railgun-combined-poi-second-recovery').run
          : mode === 'cold-submit-lost'
            ? cold.runLost
            : cold.run
      )({
        ...h,
        coordinator,
        pair,
        store,
        replay,
        chain,
        continuation: {
          ownEvidence,
          rows: wire.history.rows,
          state: wire.history.state,
          events: chain.continuation.logs,
        },
      });
      current();
      return { ...result, chain };
    }
    h.phase('restart-completed-source');
    const checkpoint = await completed({ ...h, coordinator });
    current();
    assert.deepEqual(checkpoint, wire.checkpoint);
    assert.deepEqual(
      require(wallet + 'railgun-account-public').getRailgunAccountPublicIdentity(
        coordinator,
        enrollment
      ),
      wire.publicIdentity
    );
    h.phase('restart-reproject-history');
    const { verificationHash: _verificationHash, ...row } = wire.history.rows.at(-1);
    const projected =
      await require('./railgun-combined-poi-terminal-ingest').projectRetainedPartial({
        enrollment,
        archive,
        signal,
        row,
        history: {
          rows: wire.history.rows.slice(0, -1),
          checkpoints: wire.history.checkpoints.slice(0, -1),
        },
      });
    current();
    assert.equal(JSON.stringify(projected.rows), JSON.stringify(wire.history.rows));
    assert.deepEqual(projected.checkpoints, wire.history.checkpoints);
    assert.deepEqual(projected.state, wire.history.state);
    h.phase('restart-capture-first');
    const selector = Object.fromEntries(
      ['tree', 'position', 'nullifier', 'noteHash'].map((k) => [k, privateState.entry.facts[k]])
    );
    const captured = await require(wallet + 'railgun-own-operation').captureRailgunOwnOperation({
      enrollment,
      selector,
      signal,
    });
    assert.equal(captured.status, 'captured');
    current();
    assert.equal(captured.capture.capsuleDigest, capsuleDigest);
    assert.deepEqual(captured.capture.capsule, privateState.stored.capsule);
    assert.deepEqual(captured.capture.record, records[0]);
    assert.equal(captured.capture.provedTransaction.data, wire.transaction.input);
    assert.equal(captured.capture.submitter, wire.transaction.from);
    const ownEvidence = {
      capsule: captured.capture.capsule,
      record: captured.capture.record,
      transaction: wire.transaction,
      receipt: wire.receipt,
      row: projected.rows.at(-1),
    };
    const matched = require(wallet + 'railgun-own-txid').matchRailgunOwnTxid(ownEvidence);
    assert.equal(matched.output.kind, 'partial-unshield');
    h.phase('restart-inspect-mirror');
    mirror = await require(wallet + 'railgun-account-txid').openRailgunAccountTxid({
      enrollment,
      coordinator,
      archive,
      create: false,
      checkpointOnly: true,
      signal,
    });
    current();
    const inspected = await mirror.inspect();
    assert.equal(inspected.pending, null);
    assert.deepEqual(inspected.checkpoint.state, wire.history.state);
    const railgunTxid = retained.payload.railgunTxidIfHasUnshield;
    assert.match(railgunTxid, /^0x[0-9a-f]{64}$/);
    const witnessed = await mirror.witness(railgunTxid.slice(2));
    current();
    assert.deepEqual(witnessed.witness.row, ownEvidence.row);
    await mirror.close();
    mirror = undefined;
    current();
    const continuation = {
      ownEvidence,
      state: projected.state,
      witness: witnessed.witness,
      rows: projected.rows,
      events: chain.continuation.logs,
    };
    h.assertBootstrapDrained();
    h.beforeSecond();
    const secondModule = require('./railgun-combined-poi-second-spend');
    const second = await (
      mode === 'sign-stop'
        ? secondModule.signAndStopRestart
        : mode === 'prove-stop'
          ? secondModule.proveAndStopRestart
          : secondModule.runRestart
    )({
      ...h,
      coordinator,
      continuation,
      store,
      replay,
      terminalMode: true,
    });
    current();
    if (mode === 'prove-stop' || mode === 'sign-stop')
      return { report: second.report, sealed: second.sealed, chain };
    const terminal = await require('./railgun-combined-poi-terminal-ingest').runRestart({
      ...h,
      first: continuation,
      second: second.continuation,
      chain,
      store,
      replay,
    });
    current();
    assert.equal(chain.report().posts, 0);
    return {
      report: {
        setupAcceptanceReissued: false,
        publicKeyOnlyReplay: true,
        genuineColdProfile: true,
        freshSecondSignatureAndProof: true,
        secondColdSubmitQualified: false,
        secondSignedUnfinishedRecoveryQualified: false,
        secondSpend: second.report,
        terminalIngest: terminal,
        originalPrivateRecordsBound: true,
        originalPoiAttemptUnchanged: true,
      },
      chain,
    };
  } finally {
    try {
      if (mirror) await mirror.close();
    } finally {
      try {
        try {
          store?.close();
        } finally {
          if (store) await store.closed;
        }
      } finally {
        replay?.close();
      }
    }
  }
}
module.exports = {
  snapshotSetup,
  resume: (h) => resume(h),
  proveStop: (h) => resume(h, 'prove-stop'),
  coldSubmit: (h) => resume(h, 'cold-submit'),
  coldSubmitLost: (h) => resume(h, 'cold-submit-lost'),
  hashes,
  signStop: (h) => resume(h, 'sign-stop'),
  recoverStop: (h) => resume(h, 'recover-stop'),
};
