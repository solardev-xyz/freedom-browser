const { isRailgunWalletJob } = require('./railgun-job-observer');
/** Optional genuine live-account probe. Public synthetic setup; no relay authority. */
const nativeAssertions = require('./railgun-native-assertions');
const { assert } = nativeAssertions;
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const refused = { code: 'RAILGUN_RELAY_REVIEW_REFUSED' };
const sha = (value) => createHash('sha256').update(value).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Error('Local review fixture timeout: ' + label);
          nativeAssertions.record(error, label);
          reject(error);
        }, 60000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function install() {
  for (const name of ['railgun-relay-review', 'railgun-relay-quote-verify'])
    assert.equal(
      !!require.cache[require.resolve(wallet + name)],
      false,
      'Local review observer installed late'
    );
  const base = require('./railgun-kohaku-snapshot-native').install();
  const runtime = require(wallet + 'railgun-process');
  const original = runtime.startRailgunProcess;
  const records = [];
  let restored = false;
  const observed = function (...args) {
    const options = args[0];
    if (!isRailgunWalletJob(options, 'railgun-relay-quote-job.js'))
      return Reflect.apply(original, this, args);
    assert.equal(options.binaryKey, false);
    const input = JSON.parse(options.input);
    assert.deepEqual(Object.keys(input).sort(), ['archive', 'gas', 'quote']);
    const row = { inputSha256: sha(options.input), resultMessages: 0, closedObserved: false };
    records.push(row);
    const broker = options.broker;
    const dispatch = function (...values) {
      const result = Reflect.apply(broker.dispatch, this, values);
      Promise.prototype.then.call(
        result,
        () => {
          try {
            const message = JSON.parse(values[0]);
            assert.equal(message.id, 1);
            assert.equal(message.method, 'result');
            row.resultMessages++;
            assert.equal(row.resultMessages, 1);
            row.result = structuredClone(message.value);
          } catch (error) {
            nativeAssertions.record(error, 'local-review.broker');
          }
        },
        (error) => nativeAssertions.record(error, 'local-review.broker.rejected')
      );
      return result;
    };
    const task = Reflect.apply(original, this, [
      { ...options, broker: { ...broker, dispatch } },
      ...args.slice(1),
    ]);
    nativeAssertions.observeClosed(
      task.closed,
      (value) => {
        row.closedObserved = true;
        row.closed = structuredClone(value);
      },
      'local-review.original-quote.closed'
    );
    return task;
  };
  runtime.startRailgunProcess = observed;
  return Object.freeze({
    ...base,
    jobs: () => structuredClone(records),
    resources: Object.freeze({
      ...base.resources,
      async close() {
        try {
          if (!restored) {
            restored = true;
            assert.equal(runtime.startRailgunProcess, observed);
            runtime.startRailgunProcess = original;
          }
        } finally {
          await base.resources.close();
        }
      },
    }),
  });
}
async function qualify({
  account,
  owners,
  archive,
  signal,
  profile,
  walletDirectory,
  measure,
  jobs,
}) {
  const { readRailgunAccountOwnedNotes, getRailgunAccountWalletPolicy } = require(
    wallet + 'railgun-account-wallet'
  );
  const { getRailgunAccountPublicIdentity } = require(wallet + 'railgun-account-public');
  const { normalizeRailgunRelayQuote, EXPECTED_GUARDS } = require(
    wallet + 'railgun-relay-quote-data'
  );
  const { buildVectors, PUBLIC_KEY, MASTER } = require('./railgun-relay-quote-native-vectors');
  const { encryptedFiles } = require('./railgun-kohaku-snapshot-native');
  const { assertReadProjection } = require('./railgun-kohaku-contract-oracle');
  const pins = require(wallet + 'railgun-shield-pins.json');
  const baseline = readRailgunAccountOwnedNotes(account, owners);
  const selected = baseline.read.received.filter(
    (note) =>
      note.spentTxid === false && note.amount === 700n && note.asset.contract === pins.wrappedNative
  );
  assert.equal(selected.length, 1);
  const note = selected[0];
  assert.equal(baseline.read.received.length, 3);
  assert.equal(baseline.read.received.filter((row) => row.spentTxid === false).length, 2);
  assert.equal(baseline.ownedPoi.filter((row) => row.id === note.id).length, 1);
  const publicIdentity = getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment);
  const policy = getRailgunAccountWalletPolicy({
    archive,
    coordinator: owners.coordinator,
    enrollment: owners.enrollment,
  });
  const view = account.view,
    generation = account.generationId;
  const signals = [signal, account.signal, ...Object.values(owners).map((owner) => owner.signal)];
  const bytes = encryptedFiles(profile, walletDirectory),
    before = measure();
  assert.equal(before.signerFactories, 0);
  assert.deepEqual(jobs(), []);
  assert.equal(
    !!require.cache[require.resolve(wallet + 'railgun-relay-review')],
    false,
    'Review controller imported before handoff observer'
  );
  const accountModule = require(wallet + 'railgun-account-wallet');
  const originalReserve = accountModule.reserveRailgunAccountWalletHandoff;
  const handoffs = { calls: 0, grants: 0, refusals: 0 };
  const reserveRailgunAccountWalletHandoff = function (...args) {
    handoffs.calls++;
    try {
      const value = Reflect.apply(originalReserve, this, args);
      handoffs.grants++;
      return value;
    } catch (error) {
      handoffs.refusals++;
      throw error;
    }
  };
  accountModule.reserveRailgunAccountWalletHandoff = reserveRailgunAccountWalletHandoff;
  const controllers = [],
    pending = [];
  let releaseHeld = () => {};
  const deltas = (count) =>
    Object.fromEntries(
      Object.keys(before).map((key) => [
        key,
        ['utilityStarts', 'utilitySettlements', 'brokerMessages'].includes(key) ? count : 0,
      ])
    );
  const check = (count) => {
    const now = measure();
    assert.deepEqual(
      Object.fromEntries(Object.keys(now).map((key) => [key, now[key] - before[key]])),
      deltas(count)
    );
    assert.deepEqual(encryptedFiles(profile, walletDirectory), bytes);
    assert.deepEqual(readRailgunAccountOwnedNotes(account, owners), baseline);
    assert.deepEqual(
      getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment),
      publicIdentity
    );
    assert.equal(
      getRailgunAccountWalletPolicy({
        archive,
        coordinator: owners.coordinator,
        enrollment: owners.enrollment,
      }),
      policy
    );
    assert.equal(account.view, view);
    assert.equal(account.generationId, generation);
    assert.ok(signals.every((item) => !item.aborted));
    const values = jobs();
    assert.equal(values.length, count);
    for (const row of values) {
      assert.equal(row.closedObserved, true);
      assert.equal(row.resultMessages, 1);
      assert.equal(row.result.inputSha256, row.inputSha256);
      assert.equal(row.result.signatureVerified, true);
      assert.equal(row.result.viewingPublicKey, PUBLIC_KEY);
      assert.equal(row.result.masterPublicKey, MASTER);
      assert.deepEqual(row.result.guards, EXPECTED_GUARDS);
      assert.equal(row.closed.code, 'RAILGUN_PROCESS_CLOSED');
      assert.equal(row.closed.exitCode, 15);
      assert.equal(row.closed.escalated, false);
      assert.equal(row.closed.peerDisconnected, false);
    }
  };
  const usable = async (count) => {
    const handoff = reserveRailgunAccountWalletHandoff(account, owners);
    try {
      handoff.assertCurrent();
    } finally {
      handoff.release();
    }
    for (const [method, args] of [
      ['balance', []],
      ['notes', [undefined, true]],
    ]) {
      const value = view[method](...args);
      assertReadProjection(baseline.read, {
        method,
        args,
        value: await value,
        promiseReturned: value instanceof Promise,
      });
    }
    check(count);
  };
  const create = (review) => {
    const { createRailgunRelayReview } = require(wallet + 'railgun-relay-review');
    const instance = createRailgunRelayReview({ account, owners, archive, signal, review });
    controllers.push(instance);
    return instance;
  };
  const admit = (instance, request) => {
    const work = instance.reviewLocal(request);
    work.catch(() => {});
    pending.push(work);
    return work;
  };
  try {
    // Public seed signing/address encoding in fixture main, not a guarded job.
    const vectors = buildVectors(archive, Date.now());
    const quote = vectors.cases[0].quote;
    const binding = normalizeRailgunRelayQuote(quote, vectors.gas);
    const request = { noteId: note.id, quote, gas: vectors.gas, maxFee: '100' };
    check(0);
    const expectedSummary = {
      purpose: 'railgun-local-relay-review-v1',
      localReviewOnly: true,
      chainId: pins.chainId,
      proxy: pins.proxy,
      token: pins.wrappedNative,
      recipient: baseline.read.instanceId,
      inputAmount: '700',
      feeAmount: '100',
      maximumFee: '100',
      netAmount: '600',
      gas: binding.gas,
      gasLimitMultiplierBps: 12000,
      feeRateAtomicPerNativeUnit: '1000000000000000000',
      gasLimit: '100',
      maximumGasWei: '100',
      gasEstimateVerified: false,
      signedQuote: binding.quote,
      quoteSha256: binding.quoteSha256,
      signedBytesSha256: binding.signedBytesSha256,
      expiresAt: binding.fields.feeExpiration,
      peerAddress: binding.fields.railgunAddress,
      viewingPublicKey: PUBLIC_KEY,
      masterPublicKey: MASTER,
      signatureVerified: true,
      operatorTrusted: false,
      requiredPOIListKeys: binding.fields.requiredPOIListKeys,
      selection: {
        noteId: note.id,
        tree: note.tree,
        position: note.position,
        checkpointHash: baseline.checkpointHash,
        walletGenerationId: generation,
        publicGenerationId: publicIdentity.generationId,
      },
      futureRelayExposures: [
        'proved-transaction',
        'pre-transaction-poi',
        'fee',
        'exchange-public-key',
      ],
      permitsSigning: false,
      permitsPoiQueries: false,
      permitsRelaySend: false,
    };
    const summaryCheck = (summary, context, count) => {
      assert.deepEqual(summary, expectedSummary);
      assert.ok(
        Object.isFrozen(summary) &&
          Object.isFrozen(summary.selection) &&
          Object.isFrozen(summary.signedQuote)
      );
      assert.ok(context.signal instanceof AbortSignal && !context.signal.aborted);
      check(count);
    };
    const margins = [];
    const margin = (label) => {
      const milliseconds = binding.fields.feeExpiration - Date.now();
      assert.ok(Number.isSafeInteger(milliseconds) && milliseconds >= 60000);
      margins.push({ label, milliseconds });
    };
    margin('accepted');
    let acceptedCalls = 0;
    const accepted = create((summary, context) => {
      acceptedCalls++;
      summaryCheck(summary, context, 1);
      return true;
    });
    const acceptedWork = admit(accepted, request);
    const acceptedAt = Date.now();
    const approved = await bounded(acceptedWork, 'accept');
    assert.equal(acceptedCalls, 1);
    assert.deepEqual(approved.summary, expectedSummary);
    assert.equal(approved.receipt.signal, accepted.signal);
    assert.ok(
      !approved.receipt.signal.aborted &&
        approved.receipt.expiresAt > Date.now() &&
        approved.receipt.expiresAt <= acceptedAt + 45000 &&
        approved.receipt.expiresAt <= binding.fields.feeExpiration
    );
    // Success must release the genuine reservation before explicit close.
    const acceptedHandoff = reserveRailgunAccountWalletHandoff(account, owners);
    try {
      acceptedHandoff.assertCurrent();
    } finally {
      acceptedHandoff.release();
    }
    assert.equal(approved.receipt.signal.aborted, false);
    accepted.close();
    await bounded(accepted.closed, 'accepted.closed');
    assert.equal(approved.receipt.signal.aborted, true);
    await assert.rejects(admit(accepted, request), refused);
    await usable(1);

    margin('review-refused');
    let refusedCalls = 0;
    const denied = create((summary, context) => {
      refusedCalls++;
      summaryCheck(summary, context, 2);
      return false;
    });
    await assert.rejects(bounded(admit(denied, request), 'refused'), refused);
    await bounded(denied.closed, 'refused.closed');
    assert.equal(refusedCalls, 1);
    await usable(2);

    margin('held-review-close');
    const gate = deferred(),
      reached = deferred();
    releaseHeld = () => gate.resolve(true);
    let heldCalls = 0,
      callbackSettled = false,
      outwardSettled = false,
      closedSettled = false;
    // Observe the original callback promise before returning it to the controller.
    gate.promise.then(() => {
      callbackSettled = true;
    });
    const held = create((summary, context) => {
      heldCalls++;
      summaryCheck(summary, context, 3);
      reached.resolve();
      return gate.promise;
    });
    const started = performance.now();
    const work = admit(held, request);
    work.then(
      () => {
        outwardSettled = true;
      },
      () => {
        outwardSettled = true;
      }
    );
    held.closed.then(
      () => {
        closedSettled = true;
      },
      () => {
        closedSettled = true;
      }
    );
    // Tagged losing branches never leave a delayed sticky assertion behind.
    const winner = await bounded(
      Promise.race([
        reached.promise.then(() => 'review'),
        work.then(
          () => 'settled',
          () => 'settled'
        ),
      ]),
      'held.reached'
    );
    assert.equal(winner, 'review');
    const heldAt = performance.now();
    assert.equal(heldCalls, 1);
    assert.throws(() => reserveRailgunAccountWalletHandoff(account, owners), {
      code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
    });
    let competingCalls = 0;
    const competing = create(() => {
      competingCalls++;
      return true;
    });
    await assert.rejects(admit(competing, request), refused);
    await bounded(competing.closed, 'competing.closed');
    assert.equal(competingCalls, 0);
    check(3);
    held.close();
    assert.equal(held.signal.aborted, true);
    await assert.rejects(admit(held, request), refused);
    await tick();
    assert.equal(callbackSettled, false);
    assert.equal(outwardSettled, false);
    assert.equal(closedSettled, false);
    assert.throws(() => reserveRailgunAccountWalletHandoff(account, owners), {
      code: 'RAILGUN_ACCOUNT_PHASE_BUSY',
    });
    check(3);
    assert.ok(performance.now() - heldAt < 5000 && performance.now() - started < 20000);
    margin('held-release');
    releaseHeld();
    await assert.rejects(bounded(work, 'held.work'), refused);
    await bounded(held.closed, 'held.closed');
    assert.ok(callbackSettled && outwardSettled && closedSettled);
    await usable(3);
    assert.deepEqual(handoffs, { calls: 10, grants: 7, refusals: 3 });
    nativeAssertions.assertEmpty();
    return Object.freeze({
      schema: 'railgun-local-relay-review-native-v1',
      scenario: 'enrolled-stage30-restore',
      cases: ['accepted', 'review-refused', 'held-review-close'],
      admittedQuoteJobs: 3,
      reviewCallbacks: 3,
      competingReviewRefusals: 1,
      handoffRefusalsWhileHeld: 3,
      handoffReacquisitions: 4,
      borrowedReadChecks: 6,
      handoffs: { ...handoffs },
      quoteMargins: margins,
      successHandoffReleasedBeforeClose: true,
      originalCallbackHeld: true,
      closeWaitedOriginalCallback: true,
      heldReleaseWithinBounds: true,
      liveChildCancellationQualified: false,
      genuineLiveAccountAndOwners: true,
      exactOwnedSelectionCompared: true,
      accountPolicyUnchanged: true,
      borrowedAccountRemainsUsable: true,
      durableEncryptedFilesAndNamesUnchanged: true,
      wholeBrowserProfileByteIdentity: false,
      quoteConstructionGuarded: false,
      syntheticSignedQuote: true,
      quoteSha256: binding.quoteSha256,
      gasEstimateVerified: false,
      operatorTrusted: false,
      permitsSigning: false,
      permitsPoiQueries: false,
      permitsRelaySend: false,
      liveRelayQualified: false,
      deltas: deltas(3),
      originalQuoteJobs: jobs().map((row) => ({
        resultMessages: row.resultMessages,
        closedObserved: row.closedObserved,
        guards: row.result.guards,
        closed: row.closed,
      })),
    });
  } finally {
    try {
      releaseHeld();
      for (const controller of controllers) {
        try {
          controller.close();
        } catch (error) {
          nativeAssertions.record(error, 'local-review.controller.close');
        }
      }
      await bounded(Promise.allSettled(pending), 'original-work.cleanup');
      const closed = await bounded(
        Promise.allSettled(controllers.map((controller) => controller.closed)),
        'controllers.cleanup'
      );
      for (const value of closed) assert.equal(value.status, 'fulfilled');
    } finally {
      assert.equal(
        accountModule.reserveRailgunAccountWalletHandoff,
        reserveRailgunAccountWalletHandoff
      );
      accountModule.reserveRailgunAccountWalletHandoff = originalReserve;
    }
  }
}
module.exports = { install, qualify };
