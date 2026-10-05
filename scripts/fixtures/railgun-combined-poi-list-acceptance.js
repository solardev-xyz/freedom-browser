/** Qualification-only disposable list acceptance. No production import/capability.
 * Snapshot genuine scanned change BEFORE closing its wallet; acceptance later
 * runs independent keyless crypto while the fixed sender owns its account phase.
 * The existing disposable service-signature seam must be installed before wallet
 * imports; its sign method is passed explicitly and confers no production trust.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const copy = (v) => JSON.parse(JSON.stringify(v));
const shape = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
const freeze = (v) => {
  if (v && typeof v === 'object') {
    Object.values(v).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};
const base = { chainType: '0', chainID: '11155111', txidVersion: 'V2_PoseidonMerkle' };
function createCombinedPoiListAcceptance(options) {
  shape(options, [
    'account',
    'owners',
    'changeId',
    'proof',
    'archive',
    'proverArchive',
    'artifactDirectory',
    'signature',
    'signal',
  ]);
  const {
    account,
    owners,
    changeId,
    archive,
    proverArchive,
    artifactDirectory,
    signature,
    signal,
  } = options;
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  assert.equal(typeof signature.sign, 'function');
  const history = require(wallet + 'railgun-own-poi-proof').assertRailgunOwnPoiProof(
    options.proof,
    owners.enrollment,
    owners.coordinator
  );
  // These are data read from the real registered account, not a supplied owned
  // note/receipt callback. This snapshot is not live account authority afterward.
  const owned = require(wallet + 'railgun-account-wallet').readRailgunAccountOwnedNotes(
    account,
    owners
  );
  const evidence = copy(history.preparation.ownEvidence);
  const capsule = require(wallet + 'railgun-private-capsule').normalizeRailgunPrivateCapsule(
    evidence.capsule
  );
  assert.equal(capsule.version, 2);
  assert.equal(capsule.selection.kind, 'railgun-partial-unshield');
  assert.equal(capsule.walletId, owners.enrollment.descriptor.walletId);
  assert.equal(owned.read.instanceId, owners.enrollment.descriptor.instanceId);
  const matched = require(wallet + 'railgun-own-txid').matchRailgunOwnTxid(evidence);
  assert.equal(matched.output.kind, 'partial-unshield');
  assert.deepEqual(capsule, history.capture.capsule);
  assert.equal(matched.capsuleDigest, history.capture.capsuleDigest);
  assert.match(history.capture.bindingDigest, /^[0-9a-f]{64}$/);
  // This digest binds private hold/signing facts unavailable to the fixture. Its
  // authenticity comes ONLY from the registry above; never recompute a substitute.
  const captureBinding = freeze({
    capsuleDigest: history.capture.capsuleDigest,
    bindingDigest: history.capture.bindingDigest,
  });
  const { extractRailgunTransactIntent, railgunTransactJournalIntent } = require(
    wallet + 'railgun-transact-intent'
  );
  const proved = extractRailgunTransactIntent(history.capture.provedTransaction);
  assert.deepEqual(
    proved.transaction,
    extractRailgunTransactIntent({ ...evidence.transaction, data: evidence.transaction.input })
      .transaction
  );
  assert.deepEqual(
    history.capture.intent,
    railgunTransactJournalIntent({
      ...history.capture.provedTransaction,
      from: history.capture.submitter,
    })
  );
  assert.deepEqual(
    history.capture.projection,
    require(wallet + 'railgun-own-txid').projectRailgunOwnRecord(evidence.record)
  );
  const records = owned.ownedPoi.filter((v) => v.id === changeId);
  const notes = owned.read.received.filter((v) => v.id === changeId);
  assert.equal(records.length, 1);
  assert.equal(notes.length, 1);
  const record = records[0],
    note = notes[0];
  assert.equal(record.type, 'Transact');
  assert.equal(record.hash, capsule.preparation.expected.changeCommitment);
  assert.equal(note.hash, record.hash);
  assert.equal(note.txid, record.txid);
  assert.equal(record.txid, '0x' + matched.row.txid);
  assert.equal(record.blockNumber, matched.row.blockNumber);
  assert.equal(note.tree, matched.output.change.tree);
  assert.equal(note.position, matched.output.change.position);
  assert.equal(changeId, `${note.tree}:${note.position}`);
  assert.equal(note.spentTxid, false);
  assert.equal(typeof note.amount, 'bigint');
  assert.equal(note.amount.toString(), capsule.preparation.changeAmount);
  const pins = require(wallet + 'railgun-shield-pins.json');
  assert.deepEqual(note.asset, { __type: 'erc20', contract: pins.wrappedNative });
  const change = freeze({
    hash: record.hash,
    npk: record.npk,
    blindedCommitment: record.blindedCommitment,
    tree: note.tree,
    position: note.position,
    value: note.amount.toString(),
    tokenHash: note.tokenHash,
    txid: record.txid,
    blockNumber: record.blockNumber,
  });
  const state = freeze(copy(history.preparation.state));
  const witness = require(wallet + 'railgun-txid-note-witness').normalizeRailgunTxidWitness(
    copy(history.preparation.witness),
    state
  );
  assert.deepEqual(witness.row, matched.row);
  const authenticatedPayload = require(
    wallet + 'railgun-own-poi-proof-data'
  ).bindRailgunOwnPoiPayload(history.payload, history.expected);
  assert.equal(history.expected.outputCount, 1);
  assert.equal(history.expected.railgunTxidIfHasUnshield, '0x' + witness.railgunTxid);
  assert.equal(history.expected.txidMerkleroot, witness.root);
  assert.equal(history.expected.txidMerklerootIndex, witness.checkpointIndex);
  assert.deepEqual(authenticatedPayload.blindedCommitmentsOut, [change.blindedCommitment]);
  assert.equal(history.payloadSha256, sha(JSON.stringify(authenticatedPayload)));
  assert.equal(authenticatedPayload.poiMerkleroots.length, 1);
  const acceptedInputRoot = authenticatedPayload.poiMerkleroots[0];
  assert.match(acceptedInputRoot, /^[0-9a-f]{64}$/);
  const { REQUIRED_LIST, normalizePoiProofs, verifyPoiEvent } = require(
    wallet + 'railgun-poi-records'
  );
  const { createPrivacyScope } = require('../../src/main/networks/privacy-context');
  // These contexts authorize only the existing diagnostic verifier / keyless
  // fixture job. They are not enrolled-account or signature capabilities.
  const scope = createPrivacyScope({ profileId: 'disposable-combined-poi-list', signal });
  const subject = {
    kind: 'private-account',
    principal: 'disposable-list',
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
  };
  const verifierHandle = scope.getContext({ ...subject, role: 'prover', operation: 'poi-verify' });
  const bindingHandle = scope.getContext({
    ...subject,
    role: 'engine',
    operation: 'fixture-list-binding',
  });
  let task,
    issued,
    claimed = false,
    pending = false,
    stopped = false,
    resolveClosed;
  const counters = { postCalls: 0, verifierExits: 0, bindingExits: 0, signedEvents: 0 };
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const drain = () => {
    if (stopped && !pending) resolveClosed();
  };
  const close = () => {
    if (stopped) return;
    stopped = true;
    try {
      scope.close();
    } finally {
      try {
        task?.close();
      } finally {
        drain();
      }
    }
  };
  scope.signal.addEventListener('abort', close, { once: true });
  function current(requestSignal) {
    assert.ok(!stopped && !scope.signal.aborted && !requestSignal?.aborted);
  }
  async function acceptPost(body, requestOptions) {
    shape(requestOptions, ['signal', 'timeoutMs']);
    const requestSignal = requestOptions.signal;
    current(requestSignal);
    assert.ok(requestSignal instanceof AbortSignal);
    assert.ok(
      Number.isSafeInteger(requestOptions.timeoutMs) &&
        requestOptions.timeoutMs >= 1 &&
        requestOptions.timeoutMs <= 10000
    );
    assert.equal(claimed, false);
    claimed = true;
    pending = true;
    counters.postCalls++;
    const deadline = performance.now() + requestOptions.timeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), requestOptions.timeoutMs);
    timer.unref?.();
    const lifetime = AbortSignal.any([scope.signal, requestSignal, timeout.signal]);
    const check = () => {
      current(lifetime);
      assert.ok(performance.now() < deadline);
    };
    const remaining = () => {
      check();
      return Math.max(1, Math.floor(deadline - performance.now()));
    };
    try {
      assert.ok(typeof body === 'string' && Buffer.byteLength(body) <= 18432);
      const wire = JSON.parse(body);
      shape(wire, ['jsonrpc', 'method', 'params', 'id']);
      shape(wire.params, ['chainType', 'chainID', 'txidVersion', 'listKey', 'transactProofData']);
      const data = wire.params.transactProofData;
      shape(data, [
        'snarkProof',
        'poiMerkleroots',
        'txidMerkleroot',
        'txidMerklerootIndex',
        'blindedCommitmentsOut',
        'railgunTxidIfHasUnshield',
      ]);
      const payload = require(wallet + 'railgun-poi-payload').normalizeRailgunPoiPayload({
        listKey: wire.params.listKey,
        proof: data.snarkProof,
        poiMerkleroots: data.poiMerkleroots,
        txidMerkleroot: data.txidMerkleroot,
        txidMerklerootIndex: data.txidMerklerootIndex,
        blindedCommitmentsOut: data.blindedCommitmentsOut,
        railgunTxidIfHasUnshield: data.railgunTxidIfHasUnshield,
      });
      assert.deepEqual(payload, authenticatedPayload);
      assert.equal(captureBinding.capsuleDigest, matched.capsuleDigest);
      const submission = require(wallet + 'railgun-poi-submit-data').prepareRailgunPoiSubmission({
        payload,
        requestId: wire.id,
      });
      assert.equal(body, submission.body); // Includes exact method/chain/ID and rejects duplicate-key aliases.
      assert.deepEqual(payload.poiMerkleroots, [acceptedInputRoot]);
      assert.deepEqual(payload.blindedCommitmentsOut, [change.blindedCommitment]);
      assert.equal(payload.railgunTxidIfHasUnshield, '0x' + witness.railgunTxid);
      assert.equal(payload.txidMerkleroot, witness.root);
      assert.equal(payload.txidMerklerootIndex, witness.checkpointIndex);
      const verified = await require(wallet + 'railgun-poi-verifier').verifyRailgunPoiPayload({
        handle: verifierHandle,
        proverArchive,
        artifactDirectory,
        payload,
        signal: lifetime,
        timeoutMs: remaining(),
      });
      check();
      assert.equal(verified.payloadSha256, submission.payloadSha256);
      for (const key of ['proofVerified', 'independentlyVerified', 'utilityExitObserved'])
        assert.equal(verified[key], true);
      for (const key of [
        'sourceAuthenticated',
        'membershipAuthenticated',
        'rootAccepted',
        'metadataAuthenticated',
        'ownershipAuthenticated',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        assert.equal(verified[key], false);
      counters.verifierExits++;
      const input = JSON.stringify({
        archive,
        change,
        ownEvidence: evidence,
        state,
        witness,
        payload,
      });
      assert.ok(Buffer.byteLength(input) <= 65536);
      let result;
      const jobMs = remaining();
      task = require(wallet + 'railgun-process').startRailgunProcess({
        handle: bindingHandle,
        filename: require.resolve('./railgun-combined-poi-list-job'),
        input,
        startupMs: jobMs,
        lifetimeMs: jobMs,
        heapMb: 256,
        rssMb: 512,
        broker: {
          signal: lifetime,
          async dispatch(text) {
            try {
              check();
              assert.equal(result, undefined);
              assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 16384);
              const message = JSON.parse(text);
              shape(message, ['id', 'method', 'value']);
              assert.equal(message.id, 1);
              assert.equal(message.method, 'result');
              const value = message.value;
              shape(value, [
                'inputSha256',
                'payloadSha256',
                'proof',
                'note',
                'chainAuthenticated',
                'ownershipAuthenticated',
                'spendingEnabled',
                'inventory',
                'guards',
              ]);
              assert.equal(value.inputSha256, sha(input));
              assert.equal(value.payloadSha256, submission.payloadSha256);
              assert.equal(
                value.inventory,
                require(wallet + 'railgun-engine-manifest.json').inventory.sha256
              );
              for (const key of ['chainAuthenticated', 'ownershipAuthenticated', 'spendingEnabled'])
                assert.equal(value[key], false);
              assert.equal(value.guards.attempts, 0);
              assert.ok(Array.isArray(value.guards.hooks) && value.guards.hooks.length > 0);
              assert.equal(value.guards.canaries, value.guards.hooks.length);
              assert.equal(new Set(value.guards.hooks).size, value.guards.hooks.length);
              assert.deepEqual(value.note, {
                blindedCommitment: change.blindedCommitment,
                type: 'Transact',
              });
              const [proof] = normalizePoiProofs([value.proof], [value.note]);
              assert.equal(BigInt('0x' + proof.indices), 0n);
              result = freeze({ proof, note: value.note });
              return JSON.stringify({ id: 1, value: null });
            } catch (error) {
              close();
              throw error;
            }
          },
        },
      });
      await task.ready;
      check();
      assert.ok(result);
      task.close();
      assert.equal((await task.closed).code, 'RAILGUN_PROCESS_CLOSED');
      check();
      counters.bindingExits++;
      const event = { index: 0, blindedCommitment: change.blindedCommitment, type: 'Transact' };
      const signatureText = signature.sign(event);
      check();
      const signed = verifyPoiEvent(
        [
          {
            signedPOIEvent: { ...event, signature: signatureText },
            validatedMerkleroot: result.proof.root,
          },
        ],
        result.note,
        result.proof
      );
      check();
      issued = freeze({ ...result, event: signed });
      counters.signedEvents++;
      return Object.freeze({
        status: 200,
        body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: wire.id, result: true })),
      });
    } catch (error) {
      close();
      throw error;
    } finally {
      clearTimeout(timer);
      try {
        task?.close();
      } finally {
        try {
          if (task) await task.closed;
        } finally {
          task = undefined;
          pending = false;
          drain();
        }
      }
    }
  }
  function answer(method, params) {
    current();
    const note = { blindedCommitment: change.blindedCommitment, type: 'Transact' };
    if (method === 'ppoi_pois_per_list') {
      assert.deepEqual(params, {
        ...base,
        listKeys: [REQUIRED_LIST],
        blindedCommitmentDatas: [note],
      });
      return { [note.blindedCommitment]: { [REQUIRED_LIST]: issued ? 'Valid' : 'Missing' } };
    }
    if (method === 'ppoi_validate_poi_merkleroots') {
      assert.deepEqual(params, {
        ...base,
        listKey: REQUIRED_LIST,
        poiMerkleroots: issued ? [issued.proof.root] : [],
      });
      return Boolean(issued);
    }
    assert.ok(issued);
    if (method === 'ppoi_merkle_proofs') {
      assert.deepEqual(params, {
        ...base,
        listKey: REQUIRED_LIST,
        blindedCommitments: [note.blindedCommitment],
      });
      return copy([issued.proof]);
    }
    assert.equal(method, 'ppoi_poi_events');
    assert.deepEqual(params, { ...base, listKey: REQUIRED_LIST, startIndex: 0, endIndex: 0 });
    return copy([issued.event]);
  }
  return Object.freeze({
    acceptPost,
    answer,
    close,
    closed,
    report: () =>
      Object.freeze({
        ...counters,
        accepted: Boolean(issued),
        disposableTrust: true,
        singleLeafDisposableList: true,
        historyAuthenticatedAtConstruction: true,
        listStateRealistic: false,
        chainAuthenticated: false,
        productionAuthority: false,
      }),
  });
}
module.exports = { createCombinedPoiListAcceptance };
