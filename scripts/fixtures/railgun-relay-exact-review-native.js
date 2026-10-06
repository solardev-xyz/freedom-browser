/** Default-off disposable account probe; original utility tasks remain authoritative. */
const native = require('./railgun-native-assertions');
const { assert } = native;
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const roles = ['quote', 'construct', 'reconstruct'];
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Error('Unsigned relay fixture timeout: ' + label);
          native.record(error, label);
          reject(error);
        }, 100000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function install() {
  for (const name of ['railgun-account-wallet', 'railgun-session-worker'])
    assert.equal(
      !!require.cache[require.resolve(wallet + name)],
      false,
      'Install exact review observer early'
    );
  const base = require('./railgun-relay-preparation-native').install();
  const fs = require('fs');
  const { Worker } = require('worker_threads');
  const post = Worker.prototype.postMessage,
    read = fs.readFileSync;
  let active = false,
    reviewing = false,
    restored = false,
    filename,
    worker;
  const pending = new Set(),
    completed = new Set(),
    listeners = new Map();
  const counts = { walletStateRequests: 0, walletStateReplies: 0, journalReads: 0 };
  const observedPost = function (...args) {
    try {
      if (active && args[0]?.type === 'inspect' && args[0].wire === '{"method":"walletState"}') {
        assert.equal(restored, false);
        if (worker) assert.equal(this, worker, 'Same original wallet worker required');
        else worker = this;
        if (reviewing) {
          const id = args[0].id;
          assert.ok(Number.isSafeInteger(id) && id > 0 && !pending.has(id));
          pending.add(id);
          counts.walletStateRequests++;
          if (!listeners.has(this)) {
            const listener = (message) => {
              if (!active || !reviewing || message?.type !== 'reply') return;
              if (completed.has(message.id)) {
                native.record(Error('Duplicate original inspect reply'), 'exact-review.storage');
                return;
              }
              if (!pending.has(message.id)) return;
              pending.delete(message.id);
              completed.add(message.id);
              counts.walletStateReplies++;
            };
            this.on('message', listener);
            listeners.set(this, listener);
          }
        }
      }
    } catch (error) {
      native.record(error, 'exact-review.storage.post');
    }
    return Reflect.apply(post, this, args);
  };
  const observedRead = function (...args) {
    if (active && reviewing && args[0] === filename) counts.journalReads++;
    return Reflect.apply(read, this, args);
  };
  Worker.prototype.postMessage = observedPost;
  fs.readFileSync = observedRead;
  const storage = Object.freeze({
    begin(journalFile) {
      assert.equal(active, false);
      assert.equal(restored, false);
      assert.ok(require('path').isAbsolute(journalFile));
      filename = journalFile;
      active = true;
    },
    afterCallback() {
      assert.ok(active && !reviewing && worker);
      reviewing = true;
    },
    snapshot() {
      return { ...counts };
    },
    stop() {
      active = false;
      for (const [original, listener] of listeners) original.removeListener('message', listener);
      listeners.clear();
      assert.equal(pending.size, 0, 'Original inspect reply remains pending');
    },
  });
  return Object.freeze({
    ...base,
    storage,
    resources: Object.freeze({
      ...base.resources,
      async close() {
        let failure;
        const attempt = (run) => {
          try {
            run();
          } catch (error) {
            failure ??= error;
            native.record(error, 'exact-review.restore');
          }
        };
        attempt(() => storage.stop());
        if (!restored) {
          restored = true;
          attempt(() => {
            assert.equal(Worker.prototype.postMessage, observedPost);
            Worker.prototype.postMessage = post;
          });
          attempt(() => {
            assert.equal(fs.readFileSync, observedRead);
            fs.readFileSync = read;
          });
        }
        try {
          await base.resources.close();
        } catch (error) {
          failure ??= error;
        }
        if (failure) throw failure;
      },
    }),
  });
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function assertSummary(
  summary,
  digest,
  draft,
  reconstruction,
  baseline,
  generation,
  publicIdentity
) {
  const context = draft.data.intent.context;
  const quote = require(wallet + 'railgun-relay-quote-data').normalizeRailgunRelayQuote(
    context.quote,
    context.gas
  );
  const intent = require(wallet + 'railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(
    draft.data.intent
  );
  const expected = {
    purpose: 'railgun-relay-unsigned-review-v1',
    chainId: quote.chainId,
    proxy: quote.proxy,
    token: quote.token,
    walletId: draft.data.walletId,
    self: { ...context.self },
    peer: { ...context.peer },
    amounts: {
      input: context.inputAmount,
      fee: context.feeAmount,
      self: context.selfAmount,
      cap: context.feeCap,
    },
    gas: {
      ...context.gas,
      gasLimitMultiplierBps: 12000,
      multiplierDenominator: 10000,
      rate: BigInt(quote.fields.fees[quote.token]).toString(),
      rateDenominator: '1000000000000000000',
      gasLimit: quote.gasLimit,
      maximumGasWei: quote.maximumGasWei,
    },
    quote: {
      quoteSha256: quote.quoteSha256,
      signedBytesSha256: quote.signedBytesSha256,
      expiresAt: quote.fields.feeExpiration,
      requiredPOIListKeys: [...quote.fields.requiredPOIListKeys],
    },
    selection: {
      noteId: `${draft.data.selection.tree}:${draft.data.selection.position}`,
      ...draft.data.selection,
      noteHash: draft.data.noteHash,
    },
    state: {
      checkpointHash: baseline.checkpointHash,
      walletGenerationId: generation,
      publicIdentity: { ...publicIdentity },
    },
    bindings: {
      intentDigest: intent.digest,
      draftDigest: draft.digest,
      calldataSha256: sha(Buffer.from(intent.data.transaction.data.slice(2), 'hex')),
      reconstructedExpectedHash: reconstruction.expectedHash,
    },
    gasEstimateVerified: false,
    operatorTrusted: false,
    reservationsChecked: false,
    capsulePersisted: false,
    signingEnabled: false,
    proofAuthority: false,
    poiQueriesPermitted: false,
    relaySendPermitted: false,
  };
  assert.deepEqual(summary, expected);
  assert.equal(digest, sha('freedom:railgun:relay-review-summary-v1\0' + JSON.stringify(expected)));
  const frozen = (value) => {
    if (value && typeof value === 'object') {
      assert.ok(Object.isFrozen(value));
      Object.values(value).forEach(frozen);
    }
  };
  frozen(summary);
}
async function qualify({
  scenario,
  storage,
  account,
  owners,
  archive,
  profile,
  walletDirectory,
  measure,
  jobs,
  rpc,
}) {
  assert.ok(['accept', 'held-close'].includes(scenario));
  const accepted = scenario === 'accept';
  const accountModule = require(wallet + 'railgun-account-wallet');
  const {
    readRailgunAccountOwnedNotes: read,
    reviewRailgunAccountRelayIntent: review,
    restoreRailgunAccountWallet: restore,
    reserveRailgunAccountWalletHandoff: reserve,
  } = accountModule;
  const { getRailgunAccountPublicIdentity } = require(wallet + 'railgun-account-public');
  const { normalizeRailgunRelayQuote, EXPECTED_GUARDS } = require(
    wallet + 'railgun-relay-quote-data'
  );
  const { normalizeRailgunRelayDraftCapsule } = require(wallet + 'railgun-relay-capsule');
  const { encryptedFiles } = require('./railgun-kohaku-snapshot-native');
  const { assertReadProjection } = require('./railgun-kohaku-contract-oracle');
  const { buildVectors, PUBLIC_KEY, MASTER } = require('./railgun-relay-quote-native-vectors');
  const pins = require(wallet + 'railgun-shield-pins.json');
  const baseline = read(account, owners);
  assert.equal(baseline.read.received.length, 3);
  const unspent = baseline.read.received.filter((note) => note.spentTxid === false);
  assert.equal(unspent.length, 2);
  assert.equal(
    unspent.reduce((sum, note) => sum + note.amount, 0n),
    2700n
  );
  const selected = unspent.filter(
    (note) => note.amount === 700n && note.asset.contract === pins.wrappedNative
  );
  assert.equal(selected.length, 1);
  const note = selected[0];
  assert.equal(baseline.ownedPoi.filter((row) => row.id === note.id).length, 1);
  const view = account.view,
    generation = account.generationId;
  const publicIdentity = getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment);
  const policy = accountModule.getRailgunAccountWalletPolicy({
    archive,
    coordinator: owners.coordinator,
    enrollment: owners.enrollment,
  });
  const files = encryptedFiles(profile, walletDirectory),
    before = measure(),
    rpcBefore = rpc().length;
  assert.equal(before.signerFactories, 0);
  assert.deepEqual(jobs(), []);
  // Deliberately public fixture signing/address coding in main; not guarded-job work.
  const vectors = buildVectors(archive, Date.now());
  const quote = vectors.cases[0].quote,
    binding = normalizeRailgunRelayQuote(quote, vectors.gas);
  const controller = new AbortController();
  const request = {
    noteId: note.id,
    quote,
    gas: vectors.gas,
    maxFee: '100',
    signal: controller.signal,
  };
  const pending = [],
    entered = deferred(),
    callback = deferred();
  let summary,
    callbackSignal,
    callbackSettled = false,
    operationSettled = false,
    closeSettled = false;
  let holdStarted, heldMs, result, originalClose;
  const phase = () =>
    require(wallet + 'railgun-account-phase').claimRailgunAccountPhase(
      owners.enrollment,
      'recovery'
    );
  const journalFile = require(wallet + 'privacy-storage').getPrivacyStoragePath(
    owners.enrollment.getContext(
      'storage',
      'railgun-wallet-v1:' + owners.identity.descriptor.walletId
    ),
    walletDirectory
  );
  storage.begin(journalFile);
  const margin = (minimum = 60000) => {
    const remaining = binding.fields.feeExpiration - Date.now();
    assert.ok(Number.isSafeInteger(remaining) && remaining >= minimum && remaining <= 300000);
    return remaining;
  };
  const margins = [margin(120000)];
  const unchanged = () => {
    assert.deepEqual(measure(), before);
    assert.deepEqual(jobs(), []);
    assert.equal(rpc().length, rpcBefore);
    assert.deepEqual(read(account, owners), baseline);
    assert.equal(account.view, view);
    assert.deepEqual(encryptedFiles(profile, walletDirectory), files);
  };
  const rejected = async (callback) => {
    await assert.rejects(async () => callback());
    unchanged();
  };
  try {
    unchanged();
    await rejected(() => review(account, { ...owners, identity: {} }, request, () => true));
    await rejected(() => review(account, owners, { ...request, verified: true }, () => true));
    const aborted = new AbortController();
    aborted.abort();
    await rejected(() =>
      review(account, owners, { ...request, signal: aborted.signal }, () => true)
    );
    margins.push(margin(120000));
    const work = review(account, owners, request, (value, options) => {
      summary = value;
      assert.deepEqual(Object.keys(options), ['signal']);
      assert.ok(Object.isFrozen(options));
      callbackSignal = options.signal;
      assert.equal(callbackSignal.aborted, false);
      assert.equal(jobs().length, 3);
      for (const row of jobs())
        assert.equal(row.closedObserved, true, 'All originals close before review');
      holdStarted = performance.now();
      margins.push(margin());
      Promise.prototype.then.call(callback.promise, (value) => {
        try {
          assert.equal(value, true);
          callbackSettled = true;
          storage.afterCallback();
        } catch (error) {
          native.record(error, 'exact-review.callback');
        }
      });
      entered.resolve();
      return callback.promise;
    });
    const outward = Promise.prototype.then.call(
      work,
      (value) => {
        operationSettled = true;
        storage.stop();
        return { status: 'fulfilled', value };
      },
      (error) => {
        operationSettled = true;
        storage.stop();
        return { status: 'rejected', error };
      }
    );
    pending.push(work, outward);
    work.catch(() => {});
    assert.equal(
      await bounded(
        Promise.race([entered.promise.then(() => true), outward.then(() => false)]),
        'callback-entry'
      ),
      true,
      'Original operation settled before callback'
    );
    const atCallback = measure();
    assert.throws(() => read(account, owners), { code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
    for (const admission of [
      () => restore(account, owners),
      () => review(account, owners, request, () => true),
    ])
      await assert.rejects(async () => admission(), { code: 'RAILGUN_ACCOUNT_WALLET_REFUSED' });
    assert.throws(() => reserve(account, owners));
    assert.deepEqual(measure(), atCallback, 'Competing callback admissions add no measured work');
    if (!accepted) {
      assert.throws(phase, { code: 'RAILGUN_ACCOUNT_PHASE_BUSY' });
      originalClose = account.close();
      const observedClose = Promise.prototype.then.call(originalClose, () => {
        assert.equal(callbackSettled, true, 'Original close cannot finish before callback');
        closeSettled = true;
      });
      pending.push(originalClose, observedClose);
      observedClose.catch(() => {});
      assert.equal(account.signal.aborted, true);
      assert.equal(callbackSignal.aborted, true);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(callbackSettled, false);
      assert.equal(operationSettled, false);
      assert.equal(closeSettled, false);
      assert.throws(phase, { code: 'RAILGUN_ACCOUNT_PHASE_BUSY' });
    }
    heldMs = performance.now() - holdStarted;
    assert.ok(heldMs >= 0 && heldMs <= 5000);
    margins.push(margin());
    callback.resolve(true);
    const settlement = await bounded(outward, 'composite');
    assert.equal(callbackSettled, true);
    if (accepted) {
      assert.equal(settlement.status, 'fulfilled');
      result = settlement.value;
      assert.equal(result.status, 'accepted');
      assert.equal(result.reviewedPreparation, true);
      assert.equal(result.review.summary, summary);
    } else {
      assert.equal(settlement.status, 'rejected');
      assert.equal(settlement.error.code, 'RAILGUN_ACCOUNT_WALLET_REFUSED');
      await bounded(originalClose, 'original-close');
      assert.equal(closeSettled, true);
      assert.equal(account.view, view);
      const claim = phase();
      claim.assertCurrent();
      claim.release();
      assert.equal(account.close(), originalClose);
    }
    assert.deepEqual(storage.snapshot(), {
      walletStateRequests: accepted ? 1 : 0,
      walletStateReplies: accepted ? 1 : 0,
      journalReads: accepted ? 1 : 0,
    });
    margins.push(margin());
    const rows = jobs();
    assert.deepEqual(
      rows.map((row) => row.role),
      roles
    );
    for (const row of rows) {
      assert.equal(row.closedObserved, true);
      assert.equal(row.resultMessages, 1);
      assert.deepEqual(row.result.guards, EXPECTED_GUARDS);
      assert.equal(row.closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(row.closed.exitCode, 15);
      assert.equal(row.closed.escalated, false);
      assert.equal(row.closed.peerDisconnected, false);
      assert.equal(
        row.messages,
        Object.values(row.methods).reduce((a, b) => a + b, 0)
      );
      assert.equal(row.methods.result, 1);
    }
    assert.deepEqual(rows[0].methods, { result: 1 });
    assert.equal(rows[0].keyReplies, 0);
    assert.equal(rows[0].result.inputSha256, rows[0].inputSha256);
    assert.equal(rows[0].result.quoteSha256, binding.quoteSha256);
    assert.equal(rows[0].result.signatureVerified, true);
    assert.equal(rows[0].result.viewingPublicKey, PUBLIC_KEY);
    assert.equal(rows[0].result.masterPublicKey, MASTER);
    for (const [index, purpose] of [
      [1, 'relay-prepare'],
      [2, 'relay-reconstruct'],
    ]) {
      assert.equal(rows[index].methods['key:' + purpose], 1);
      assert.equal(rows[index].keyReplies, 1);
      assert.equal(rows[index].result.poiCalls, 0);
      assert.equal(
        rows[index].result.inventory,
        require(wallet + 'railgun-engine-manifest.json').inventory.sha256
      );
      assert.ok(Object.keys(rows[index].methods).some((key) => key.startsWith('public.')));
      assert.ok(Object.keys(rows[index].methods).some((key) => key.startsWith('wallet.')));
    }
    const draft = normalizeRailgunRelayDraftCapsule(rows[1].result.relayDraft);
    assert.equal(rows[2].input.relayDraftText, JSON.stringify(draft.data));
    assert.deepEqual(rows[1].input.relayRequest.context, draft.data.intent.context);
    assert.deepEqual(draft.data.selection, { tree: note.tree, position: note.position });
    const reconstruction = {
      draftDigest: draft.digest,
      expectedHash: draft.data.intent.expectedHash,
      recoveredOutputs: 2,
    };
    assert.deepEqual(rows[2].result.relayReconstruction, reconstruction);
    const summaryDigest = sha(
      'freedom:railgun:relay-review-summary-v1\0' + JSON.stringify(summary)
    );
    assertSummary(
      summary,
      summaryDigest,
      draft,
      reconstruction,
      baseline,
      generation,
      publicIdentity
    );
    const falseGrants = [
      'reservationsChecked',
      'capsulePersisted',
      'signingEnabled',
      'proofAuthority',
      'poiQueriesPermitted',
      'relaySendPermitted',
    ];
    for (const [key, value] of Object.entries(draft))
      if (!['data', 'digest'].includes(key)) assert.equal(value, false);
    if (accepted) {
      assert.deepEqual(
        Object.keys(result).sort(),
        [
          'status',
          'review',
          'view',
          'preparation',
          'reconstruction',
          'reviewedPreparation',
          ...falseGrants,
        ].sort()
      );
      assert.deepEqual(result.preparation, draft);
      assert.deepEqual(result.reconstruction, reconstruction);
      assert.equal(result.review.summaryDigest, summaryDigest);
      for (const key of falseGrants) assert.equal(result[key], false);
      assert.notEqual(account.view, view);
      assert.equal(result.view, account.view);
      await assert.rejects(view.balance());
      assert.deepEqual(read(account, owners), baseline);
      const handoff = reserve(account, owners);
      try {
        handoff.assertCurrent();
      } finally {
        handoff.release();
      }
      for (const [method, args] of [
        ['balance', []],
        ['notes', [undefined, true]],
      ]) {
        const value = account.view[method](...args);
        assertReadProjection(baseline.read, {
          method,
          args,
          value: await value,
          promiseReturned: value instanceof Promise,
        });
      }
      assert.deepEqual(encryptedFiles(profile, walletDirectory), files);
      assert.equal(account.signal.aborted, false);
    } else {
      await assert.rejects(view.balance());
      assert.throws(() => read(account, owners));
    }
    assert.equal(account.generationId, generation);
    assert.deepEqual(
      getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment),
      publicIdentity
    );
    owners.enrollment.getContext('engine');
    assert.ok(Object.values(owners).every((owner) => !owner.signal.aborted));
    assert.equal(
      accountModule.getRailgunAccountWalletPolicy({
        archive,
        coordinator: owners.coordinator,
        enrollment: owners.enrollment,
      }),
      policy
    );
    // withPublicSnapshot refreshes canonical boundaries before/after its callback.
    // Derive the exact synthetic header requests from the captured checkpoint;
    // source canonicalNumbers de-duplicates anchor/from/to/(from-1).
    const checkpoint = rows[1].input.checkpoint;
    // Stage 20 precedes the recovered stage-30 plan; advance starts at previous + 1.
    assert.equal(checkpoint.anchor.number, 100);
    assert.equal(checkpoint.from, 21);
    assert.equal(checkpoint.to.number, 30);
    assert.deepEqual(rows[2].input.checkpoint, checkpoint);
    const numbers = [
      ...new Set([
        checkpoint.anchor.number,
        checkpoint.from,
        checkpoint.to.number,
        ...(checkpoint.from ? [checkpoint.from - 1] : []),
      ]),
    ];
    assert.ok(numbers.every((n) => Number.isSafeInteger(n) && n >= 0));
    const expectedRpc = Object.fromEntries(
      ['finalized', ...numbers.map((n) => '0x' + n.toString(16))].map((tag) => [tag, 2])
    );
    const rpcMap = {};
    for (const request of rpc().slice(rpcBefore)) {
      assert.equal(request.method, 'eth_getBlockByNumber');
      assert.ok(
        Array.isArray(request.params) && request.params.length === 2 && request.params[1] === false
      );
      const tag = request.params[0];
      rpcMap[tag] = (rpcMap[tag] ?? 0) + 1;
    }
    assert.deepEqual(rpcMap, expectedRpc);
    const after = measure();
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
    const deltas = Object.fromEntries(
      Object.keys(before).map((key) => [key, after[key] - before[key]])
    );
    const expected = Object.fromEntries(Object.keys(before).map((key) => [key, 0]));
    Object.assign(expected, {
      rpcRequests: Object.values(expectedRpc).reduce((a, b) => a + b, 0),
      utilityStarts: 3,
      utilitySettlements: 3,
      workerSettlements: accepted ? 0 : 1,
      railgunKeyRequests: 2,
      railgunKeyReplies: 2,
      brokerMessages: rows.reduce((sum, row) => sum + row.messages, 0),
    });
    assert.deepEqual(deltas, expected);
    native.assertEmpty();
    return Object.freeze({
      schema: 'railgun-exact-relay-review-native-v1',
      scenario,
      hook: 'enrolled-stage30-restore',
      outcome: accepted ? 'accepted' : 'closed-late-approval-refused',
      summaryDigest,
      callbackSettled: true,
      originalCallbackPromiseRetained: true,
      originalJobsClosedBeforeReview: true,
      closeWaitedForCallback: !accepted,
      lateApprovalRefused: !accepted,
      phaseReusableAfterOriginalClose: !accepted,
      heldMs,
      postReviewStorage: storage.snapshot(),
      originalJobs: rows.map((row) => ({
        role: row.role,
        inputSha256: row.inputSha256,
        messages: row.messages,
        methods: row.methods,
        keyReplies: row.keyReplies,
        resultMessages: row.resultMessages,
        closedObserved: row.closedObserved,
        closed: row.closed,
        guards: row.result.guards,
      })),
      quoteMargins: margins,
      quoteSha256: binding.quoteSha256,
      draftDigest: draft.digest,
      syntheticCanonicalHeaderRequests: rpcMap,
      canonicalRefreshes: 2,
      liveRpcQualified: false,
      relayRestores: 2,
      recoveredOutputs: 2,
      preAdmissionRefusals: 3,
      competingAdmissionRefusals: 4,
      freshOriginalTaskIdentities: true,
      originalTasksClosedInOrder: true,
      exactSerializedDraftJoined: true,
      genuineAccountAndOwners: true,
      originalViewInvalidated: true,
      viewReplacedAfterReview: accepted,
      ownedProjectionAndGenerationsUnchanged: accepted,
      sourceEnforcedReadOnlyGrants: true,
      durableEncryptedFilesComparedBeforeClose: accepted,
      handoffImmediatelyReusable: accepted,
      borrowedAccountRemainsUsable: accepted,
      quoteConstructionGuarded: false,
      syntheticSignedQuote: true,
      wholeBrowserProfileByteIdentity: false,
      liveChildCancellationQualified: false,
      reviewedPreparation: accepted,
      reservationsChecked: false,
      capsulePersisted: false,
      signingEnabled: false,
      proofAuthority: false,
      poiQueriesPermitted: false,
      relaySendPermitted: false,
      liveRelayQualified: false,
      gasEstimateVerified: false,
      operatorTrusted: false,
      deltas,
    });
  } finally {
    callback.resolve(true);
    controller.abort();
    await bounded(Promise.allSettled(pending), 'original-work.cleanup');
    storage.stop();
  }
}
module.exports = { install, qualify };
