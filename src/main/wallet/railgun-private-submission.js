/** Exact completed private operation -> one EOA attempt under account exclusion.
 * No caller-supplied proof, completion snapshot or generic review grants authority.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { claimRailgunPrivateCompletion } = require('./railgun-private-operation');
const { verifyRailgunPrivateProof, assertRailgunPrivateProof } = require('./railgun-private-proof');
const {
  createRailgunPrivatePreflight,
  assertRailgunPrivatePreflight,
  MAX_AGE_MS: PREFLIGHT_MAX_AGE_MS,
} = require('./railgun-private-preflight');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const pins = require('./railgun-shield-pins.json');
const submissions = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun private submission unavailable'), {
    code: 'RAILGUN_PRIVATE_SUBMISSION_REFUSED',
  });
// The warm review window, and the cap no recovered review may exceed.
const REVIEW_WINDOW_MS = 30000;
// Recovered review budget: a pinned policy, never caller data. Three clocks:
// H, the person's review deadline; F = H + admissionMs, by which signing,
// history reconciliation and journal begin must be admitted (the service's
// review expiry, checked again before and after journal begin, and on the
// monotonic clock by this module's submission entry); and E, the
// first genuine authority's own unrenewed age. H is offered only if
// E >= F + sendReserveMs, the time left for the raw send and its
// acknowledgement. The allowances refuse before the preflight, before the
// nullifier query is admitted to the transport (the preflight's nullifier
// admission deadline, enforced again at the RPC's transport admission) and
// before any EOA request once the review floor is out of reach. Admission is
// not departure: on a new SOCKS+TLS connection the nullifier can leave after
// its deadline by the connect time, and a read that outruns the tail then
// ends in the refusal before any EOA request: disclosed, never sent.
//
// The committed policy is H = F with a 10 s send reserve, a 15 s review
// floor and the 30 s cap. The 10 s reserve is a tested availability
// trade-off, not an assurance that a send finishes within it: against 20 s
// it offers a recovered review more often, and in exchange raises the
// chance that a send ends with an uncertain acknowledgement (a journaled
// attempt cut off by E). The finite matrix in
// railgun-private-submission-boundaries.test.js establishes neither an
// optimal reserve nor a success rate. Known limitation: H = F leaves no
// admission allowance after the person's deadline, so signing, the history
// refresh and journal begin must also complete before H, and an approval
// close to H can fail during signing or admission after the person
// approved. No UX change is planned for it.
const BUDGET = (() => {
  const value = require('./railgun-recovered-review-budget.json');
  const keys = [
    'admissionMs',
    'disclosureTailMs',
    'eoaAllowanceMs',
    'preflightAllowanceMs',
    'reviewMinMs',
    'reviewWindowMs',
    'sendReserveMs',
  ];
  assert.deepEqual(Object.keys(value).sort(), keys);
  for (const key of keys) assert.ok(Number.isSafeInteger(value[key]) && value[key] >= 0);
  assert.ok(
    value.reviewWindowMs <= REVIEW_WINDOW_MS &&
      value.reviewMinMs > 0 &&
      value.reviewMinMs <= value.reviewWindowMs &&
      value.sendReserveMs > 0 &&
      value.reviewWindowMs + value.admissionMs + value.sendReserveMs < 60000 &&
      value.reviewMinMs +
        value.admissionMs +
        value.sendReserveMs +
        value.preflightAllowanceMs +
        value.eoaAllowanceMs <
        60000
  );
  return Object.freeze({ ...value });
})();
// railgun-private-proof.js: a receipt lives 60 s after its verifier exits.
// The caller's estimate starts before the verifier runs, so it is earlier
// than the genuine expiry by the verifier's own duration (conservative).
const PROOF_RECEIPT_MS = 60000;
const budgetFail = () =>
  Object.assign(new Error('Railgun private review budget unavailable'), {
    code: 'RAILGUN_PRIVATE_REVIEW_BUDGET',
  });
// Whole milliseconds strictly inside a monotonic end; never rounds up.
const leftUntil = (end) => Math.floor(end - performance.now()) - 1;
// Refusal diagnostics, keyed by the frozen returned value so every caller's
// closed result shape is unchanged. Closed enumerations and identifier codes
// only: never messages, stacks, RPC payloads, nullifiers, calldata or paths.
const diagnostics = new WeakMap();
const DIAGNOSTIC = Object.freeze({
  stage: Object.freeze([
    'completion',
    'recovery',
    'proof',
    'preflight',
    'eoa',
    'submission',
    'admission',
    'history',
    'prior-attempt',
    'disclosure-review',
    'wallet',
    'txid',
    'source',
    'creator',
    'membership',
    'root',
  ]),
  // open: construction; acquire: the anchored reads; admission: the checks
  // between the acquired observation and EOA work.
  substage: Object.freeze(['open', 'acquire', 'admission']),
  reason: Object.freeze(['rpc', 'stale', 'inactive', 'mismatch', 'refused']),
  step: Object.freeze([
    'deployment',
    'artifacts',
    'rootHistory',
    'unshieldFee',
    'verifier',
    'nullifiers',
    'anchor-recheck',
  ]),
  deploymentStep: Object.freeze([
    'anchor',
    'code-proxy',
    'code-relayAdapt',
    'code-wrappedNative',
    'code-implementation',
    'slot-implementation',
    'slot-paused',
    'getter-railgun',
    'getter-wBase',
    'getter-shieldFee',
    'getter-tokenBlocklist',
    'anchor-recheck',
  ]),
  // Closed TOR_REQUEST_FAILED stages (wallet-tor-transport.js), on rpc refusals.
  // Diagnostic only: socket-new and socket-reused never prove the request was
  // not delivered, and no stage authorizes a retry or anything else.
  causeStage: Object.freeze([
    'connect',
    'tls',
    'socket-new',
    'socket-reused',
    'response',
    'unclassified',
  ]),
});
// The preflight's code shape, refusing long hex runs that could carry data.
const diagnosticCode = (value) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) && !/[0-9A-F]{16}/.test(value)
    ? value
    : 'UNCLASSIFIED';
function diagnose(stage, substage, error) {
  const stageValue = DIAGNOSTIC.stage.includes(stage) ? stage : 'unknown';
  try {
    // Own data properties only: no getter or proxy trap runs here.
    const own = (key) => {
      if (!error || typeof error !== 'object' || require('util').types.isProxy(error)) return;
      const descriptor = Object.getOwnPropertyDescriptor(error, key);
      return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    };
    const code = diagnosticCode(own('code'));
    const preflight = code === 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED';
    const pick = (key) => {
      const value = preflight ? own(key) : undefined;
      return DIAGNOSTIC[key].includes(value) ? { [key]: value } : {};
    };
    const reason = pick('reason'),
      step = pick('step');
    return Object.freeze({
      stage: stageValue,
      ...(stage === 'preflight' && DIAGNOSTIC.substage.includes(substage) ? { substage } : {}),
      code,
      ...reason,
      ...step,
      ...(step.step === 'deployment' ? pick('deploymentStep') : {}),
      ...(reason.reason === 'rpc'
        ? { causeCode: diagnosticCode(own('causeCode')), ...pick('causeStage') }
        : {}),
    });
  } catch {
    return Object.freeze({ stage: stageValue, code: 'UNCLASSIFIED' });
  }
}
// The first refusal is the specific one; later cleanup failures never replace it.
const noteRefusal = (state, error, substage) => {
  state.diagnostic ??= diagnose(state.stage, substage, error);
};
function refusalResult(state, extra = {}) {
  const result = Object.freeze({ status: 'recovery-required', stage: state.stage, ...extra });
  if (state.diagnostic) diagnostics.set(result, state.diagnostic);
  return result;
}
function getRailgunPrivateSubmissionDiagnostic(result) {
  return (result && typeof result === 'object' && diagnostics.get(result)) || null;
}
// The same bounded tuple for one preflight run outside a submission (the live
// qualifier's read-only probe). Reads the error's own data properties only.
function getRailgunPrivatePreflightDiagnostic(substage, error) {
  return diagnose('preflight', substage, error);
}
// Both callers are fixed entry points below. This core is not exported and
// accepts no renderer/caller-selected admission callback or completion object.
async function submitFinal({
  enrollment,
  snapshot,
  reservations,
  capsules,
  records,
  context,
  claim,
  proverArchive,
  artifactDirectory,
  review,
  gasLimit,
  maxGasFee,
  state,
  preparedProof,
  currentCheckpointHash,
  // Recovered only: a conservative monotonic end of the caller's authorities.
  lifetimeEnd = null,
  extraCurrent = () => {},
}) {
  const kind = snapshot.stored.capsule.selection.kind;
  const partial = kind === 'railgun-partial-unshield';
  let proof, preflight, scope, substage;
  let handle, network, intent;
  const callbacks = new Set();
  const track =
    (use) =>
    (...args) => {
      const pending = use(...args);
      callbacks.add(pending);
      pending.then(
        () => callbacks.delete(pending),
        () => callbacks.delete(pending)
      );
      return pending;
    };
  try {
    const recovered = records.find((v) => v.entry.id === snapshot.entry.id);
    assert.ok(recovered);
    const attest = async () => {
      context.assertCurrent();
      claim.assertCurrent();
      extraCurrent();
      reservations.assertReceiptContext(recovered.receipt, 'recovery');
      assert.deepEqual(await reservations.assertReceipt(recovered.receipt), snapshot.entry);
      assert.deepEqual(await capsules.get(snapshot.entry.id), snapshot.stored);
      context.assertCurrent();
      claim.assertCurrent();
      extraCurrent();
    };
    await attest();
    const { capsule, provedTransaction: tx } = snapshot.stored;
    const owner = snapshot.entry.signing.submitter;
    const signer = require('./signers').getSigner(0);
    assert.equal((await signer.getAddress()).toLowerCase(), owner);
    assert.ok(typeof signer.signTransaction === 'function' && !signer.sendTransaction);
    if (capsule.selection.kind !== 'railgun-private-transfer')
      assert.equal(capsule.selection.recipient, owner);
    const evidence = {
      intent: capsule.preparation.transaction,
      transaction: tx,
      expected: capsule.preparation.expected,
    };
    state.stage = 'proof';
    proof =
      preparedProof ??
      (await verifyRailgunPrivateProof({
        enrollment,
        proverArchive,
        artifactDirectory,
        ...evidence,
        signal: AbortSignal.any([claim.signal, context.signal]),
      }));
    await attest();
    state.stage = 'preflight';
    const input = {
      tree: capsule.selection.tree,
      merkleRoot: capsule.preparation.expected.merkleRoot,
      nullifier: snapshot.entry.facts.nullifier,
      checkpointHash: currentCheckpointHash ?? snapshot.entry.facts.checkpointHash,
      minimumBlock: snapshot.minimumBlock,
    };
    substage = 'open';
    preflight = createRailgunPrivatePreflight({
      enrollment,
      artifactDirectory,
      input,
      ...(partial ? { intentKind: kind } : {}),
      ...(claim.destinationConstraints
        ? { destinationConstraint: claim.destinationConstraints.protocol }
        : {}),
      // Recovered only: the nullifier admission deadline. The preflight and
      // its RPC refuse to admit the selected nullifier's request to the
      // transport once the review floor is out of reach (the nullifier read,
      // its anchor recheck and the EOA reads still to come).
      ...(lifetimeEnd
        ? {
            admissionDeadline:
              lifetimeEnd() -
              (BUDGET.reviewMinMs +
                BUDGET.admissionMs +
                BUDGET.sendReserveMs +
                BUDGET.eoaAllowanceMs +
                BUDGET.disclosureTailMs),
          }
        : {}),
    });
    const stop = () => preflight.close();
    const signal = AbortSignal.any([claim.signal, context.signal]);
    signal.addEventListener('abort', stop, { once: true });
    let acquired, preflightStarted;
    const timer = setTimeout(stop, 20000);
    timer.unref?.();
    try {
      assert.ok(!signal.aborted);
      substage = 'acquire';
      // At or before the preflight's own age origin: a conservative end.
      preflightStarted = performance.now();
      acquired = await preflight.acquire();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    }
    substage = 'admission';
    const observed = assertRailgunPrivatePreflight(preflight, acquired.receipt, enrollment, 10000);
    assert.deepEqual(observed.input, input);
    assert.equal(Object.hasOwn(observed, 'intentKind'), partial);
    if (partial) assert.equal(observed.intentKind, kind);
    const assertCurrent = (minimumRemainingMs = 0) => {
      context.assertCurrent();
      claim.assertCurrent();
      extraCurrent(minimumRemainingMs);
      reservations.assertReceiptContext(recovered.receipt, 'recovery');
      assertRailgunPrivateProof(proof.receipt, enrollment, evidence, minimumRemainingMs);
      assert.equal(
        assertRailgunPrivatePreflight(preflight, acquired.receipt, enrollment, minimumRemainingMs),
        observed
      );
    };
    assertCurrent();
    const parent = enrollment.getContext('engine');
    scope = createPrivacyScope({
      profileId: getPrivacyContext(parent).profileId,
      signal: AbortSignal.any([claim.signal, context.signal, proof.signal, preflight.signal]),
      isCurrent: () => {
        try {
          assertCurrent();
          return true;
        } catch {
          return false;
        }
      },
    });
    handle = scope.getContext({
      kind: 'public-address',
      principal: owner,
      chainId: pins.chainId,
      role: 'transaction-rpc',
    });
    network = require('./private-transaction-network').getPrivateTransactionNetwork(
      handle,
      ...(claim.destinationConstraints
        ? [{ destinationConstraint: claim.destinationConstraints.transaction }]
        : [])
    );
    intent = railgunTransactJournalIntent({ ...tx, from: owner });
    assert.equal(intent.intentDigest, snapshot.entry.facts.intentDigest);
    state.stage = 'eoa';
    const wallStarted = Date.now(),
      monoStarted = performance.now();
    let reviewMs = REVIEW_WINDOW_MS,
      admissionMs = 0;
    if (lifetimeEnd) {
      // Shorten, never renew: H ends admissionMs + sendReserveMs before the
      // first authority would. Refused here, before any EOA request
      // discloses the proved calldata, unless the floor remains reachable.
      const end = Math.min(lifetimeEnd(), preflightStarted + PREFLIGHT_MAX_AGE_MS);
      admissionMs = BUDGET.admissionMs;
      reviewMs = Math.min(
        BUDGET.reviewWindowMs,
        leftUntil(end) - admissionMs - BUDGET.sendReserveMs
      );
      if (!(reviewMs >= BUDGET.reviewMinMs + BUDGET.eoaAllowanceMs)) throw budgetFail();
      assertCurrent(reviewMs + admissionMs + BUDGET.sendReserveMs);
    }
    // H (the person's deadline) and F (signing and journal admission) on
    // both clocks, fixed before any EOA request and never renewed. The warm
    // path keeps F = H: one 30 s deadline for review, signing and begin.
    const reviewDeadline = wallStarted + reviewMs,
      reviewEnd = monoStarted + reviewMs;
    const admissionDeadline = reviewDeadline + admissionMs,
      admissionEnd = reviewEnd + admissionMs;
    // The service and the network check this entry before the review, at
    // broadcast entry, before journal begin and before the raw send, beside
    // the service's wall-clock expiry F. Recovered only: F on the monotonic
    // clock too, so a backward wall-clock step after signing cannot admit
    // journal begin or the send after F. Never in the scope's isCurrent: an
    // acknowledgement after F must stay acknowledged, not become uncertain.
    submissions.set(handle, {
      intent,
      assertCurrent: () => {
        assertCurrent();
        if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);
      },
    });
    await network.assertCanSubmit(scope.signal);
    assert.equal(
      (await network.request(pins.chainId, 'eth_getCode', [owner, 'pending'])).result,
      '0x'
    );
    const rpcTx = { from: owner, to: tx.to, value: '0x0', data: tx.data };
    const estimate = await network.request(pins.chainId, 'eth_estimateGas', [rpcTx]);
    assert.ok(BigInt(estimate.result) > 0n && BigInt(estimate.result) <= gasLimit);
    await network.request(pins.chainId, 'eth_call', [rpcTx, 'latest']);
    await attest();
    assertCurrent();
    state.stage = 'submission';
    let signingAttempted = false;
    const submissionSigner = Object.freeze({
      getAddress: track(async () => {
        assertCurrent();
        const address = await signer.getAddress();
        assertCurrent();
        assert.equal(address.toLowerCase(), owner);
        return address;
      }),
      signTransaction: track(async (transaction) => {
        assert.ok(!signingAttempted);
        signingAttempted = true;
        await attest();
        assertCurrent();
        // A wall-clock step cannot extend recovered admission past its
        // monotonic end, which the send reserve was measured against.
        if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);
        const signed = await signer.signTransaction(transaction);
        // Signing may be held across durable history changes. Re-read both
        // private records before exposing signed bytes to raw submission.
        await attest();
        assertCurrent();
        // Dominated by the network's entry check of this submission, which
        // follows with no event-loop turn between; kept so signed bytes
        // never leave this callback after F.
        if (lifetimeEnd) assert.ok(performance.now() < admissionEnd);
        return signed;
      }),
    });
    state.outcome = await require('./transaction-service').signAndSendTransaction(
      {
        chainId: pins.chainId,
        to: tx.to,
        value: '0',
        data: tx.data,
        gasLimit: gasLimit.toString(),
      },
      submissionSigner,
      {
        privacyContext: handle,
        intent,
        // The service's single expiry is F: it bounds the review step,
        // signing, and the checks before and after journal begin.
        reviewExpiresAt: admissionDeadline,
        review: track(async (request) => {
          await attest();
          assertCurrent();
          const actual = request.transaction;
          assert.equal(request.from.toLowerCase(), owner);
          assert.deepEqual(railgunTransactJournalIntent({ ...actual, from: owner }), intent);
          const fee = BigInt(actual.gasPrice ?? actual.maxFeePerGas);
          assert.ok(
            BigInt(actual.gasLimit) === gasLimit && fee > 0n && gasLimit * fee <= maxGasFee
          );
          const latest = await network.request(pins.chainId, 'eth_getTransactionCount', [
            owner,
            'latest',
          ]);
          const pending = await network.request(pins.chainId, 'eth_getTransactionCount', [
            owner,
            'pending',
          ]);
          assert.ok(
            BigInt(latest.result) === BigInt(pending.result) &&
              BigInt(pending.result) === BigInt(actual.nonce)
          );
          const balance = await network.request(pins.chainId, 'eth_getBalance', [owner, 'pending']);
          assert.ok(BigInt(balance.result) >= gasLimit * fee);
          assertCurrent();
          const approved = await Promise.resolve()
            .then(() => {
              // This is admission to the actual review callback, after every
              // setup await. Do not renew the service's existing review clock.
              // A recovered review needs its floor left before H, and every
              // authority must outlive F by the send reserve.
              if (lifetimeEnd) {
                const left = leftUntil(reviewEnd);
                if (!(left >= BUDGET.reviewMinMs)) throw budgetFail();
                assertCurrent(left + admissionMs + BUDGET.sendReserveMs);
              } else assertCurrent();
              return review(
                Object.freeze({
                  ...request,
                  // The person's deadline is H, never the later admission F.
                  expiresAt: reviewDeadline,
                  intent,
                  operation: intent.operation,
                  // The signed capsule's own foreign destination, never caller data.
                  ...(Object.hasOwn(capsule.selection, 'recipientRelationship')
                    ? {
                        recipientRelationship: 'foreign',
                        canonicalDestination: capsule.selection.recipient,
                      }
                    : {}),
                  maxGasFee,
                  fundingAddressPublic: true,
                  chainStateVerified: false,
                })
              );
            })
            .catch(() => {
              throw fail();
            });
          await attest();
          assertCurrent();
          // Approval counts only before H, on both clocks. Under H = F the
          // monotonic check is dominated by the one before the signer, which
          // runs later against the same instant and before any signing; with
          // a split policy (admissionMs > 0) it alone enforces H.
          assert.ok(Date.now() < reviewDeadline);
          if (lifetimeEnd) assert.ok(performance.now() < reviewEnd);
          return approved === true;
        }),
      }
    );
  } catch (error) {
    if (
      state.stage === 'submission' &&
      network &&
      intent &&
      typeof error?.transactionHash === 'string' &&
      /^0x[0-9a-f]{64}$/.test(error.transactionHash)
    ) {
      try {
        const records = await network.listSubmissions();
        const attempted = records.find((v) => v.hash === error.transactionHash);
        assert.deepEqual(attempted?.intent, intent);
        state.outcome = Object.freeze({
          transactionHash: attempted.hash,
          submissionStatus: 'unknown',
        });
      } catch {
        // If history cannot be authenticated, retain the private hold and
        // require cold recovery rather than report an unbound hash.
      }
    }
    // Expected refusal is a value, so it does not close authenticated stores.
    noteRefusal(state, error, substage);
  } finally {
    if (handle) submissions.delete(handle);
    // Revoke all admissions before draining borrowed signer/review work;
    // one cleanup exception cannot release the recovery owner early.
    for (const close of [() => scope?.close(), () => preflight?.close(), () => proof?.close()]) {
      try {
        close();
      } catch {
        /* Continue revocation and callback drainage. */
      }
    }
    await Promise.allSettled([...callbacks]);
  }
}

async function submitRailgunPrivateTransaction({
  identity,
  enrollment,
  completion,
  proverArchive,
  artifactDirectory,
  review,
  gasLimit,
  maxGasFee,
}) {
  let claim;
  const state = { stage: 'completion' };
  try {
    assert.equal(typeof review, 'function');
    assert.ok(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= 3000000n);
    assert.ok(typeof maxGasFee === 'bigint' && maxGasFee > 0n && maxGasFee <= 2000000000000000n);
    claim = claimRailgunPrivateCompletion(completion, identity, enrollment);
    const snapshot = claim.assertCurrent();
    const kind = snapshot.stored.capsule.selection.kind;
    const partial = kind === 'railgun-partial-unshield';
    assert.equal(snapshot.stored.capsule.version, partial ? 2 : 1);
    assert.ok(
      ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
        kind
      )
    );
    const reservations = await enrollment.openReservations();
    const capsules = await enrollment.openPrivateCapsules();
    state.stage = 'recovery';
    await reservations.withSigningRecovery(
      async (records, context) => {
        await submitFinal({
          enrollment,
          snapshot,
          reservations,
          capsules,
          records,
          context,
          claim,
          proverArchive,
          artifactDirectory,
          review,
          gasLimit,
          maxGasFee,
          state,
        });
      },
      { timeoutMs: 120000 }
    );
  } catch (error) {
    // A phase expiry after journaling must not hide its acknowledged/uncertain hash.
    noteRefusal(state, error);
  } finally {
    claim?.close();
  }
  return state.outcome ? Object.freeze(state.outcome) : refusalResult(state);
}
function assertRailgunPrivateSubmission(handle, intent) {
  try {
    const entry = submissions.get(handle);
    assert.ok(entry);
    assert.deepEqual(entry.intent, intent);
    entry.assertCurrent();
  } catch {
    throw fail();
  }
}
// Cold admission is invocation-private. Neither its data nor a proof-recovery
// diagnostic can mint a warm completion or be supplied to submitFinal.
const recoveredBusy = new WeakSet();
const detach = (value) => {
  const freeze = (v) => {
    if (v && typeof v === 'object') {
      Object.values(v).forEach(freeze);
      Object.freeze(v);
    }
    return v;
  };
  return freeze(JSON.parse(JSON.stringify(value)));
};
async function submitRailgunRecoveredPrivateTransaction(options) {
  const state = { stage: 'admission' };
  let enrollment,
    controller,
    timer,
    scope,
    account,
    mirror,
    proof,
    poi,
    roots,
    sourceOutcome,
    provenanceExitUnknown = false,
    claimed = false,
    constraints = [],
    previewClients = [];
  const stop = () => {
    controller?.abort();
    for (const close of [
      () => scope?.close(),
      () => poi?.close(),
      () => roots?.close(),
      () => proof?.close(),
      ...constraints.map((value) => () => value.close()),
    ]) {
      try {
        close();
      } catch {
        /* Other resources must still be revoked. */
      }
    }
  };
  try {
    const { types } = require('util');
    assert.ok(
      options && !types.isProxy(options) && Object.getPrototypeOf(options) === Object.prototype
    );
    const required = [
      'identity',
      'enrollment',
      'coordinator',
      'destination',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'holdId',
      'reviewDisclosures',
      'reviewTransaction',
      'gasLimit',
      'maxGasFee',
      'signal',
    ];
    assert.deepEqual(
      Reflect.ownKeys(options).sort(),
      [...required, ...(Object.hasOwn(options, 'timeoutMs') ? ['timeoutMs'] : [])].sort()
    );
    for (const key of Reflect.ownKeys(options))
      assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value'));
    const {
      identity,
      coordinator,
      destination,
      holdId,
      signal,
      reviewDisclosures,
      reviewTransaction,
      gasLimit,
      maxGasFee,
      artifactDirectory,
      timeoutMs = 600000,
    } = options;
    enrollment = options.enrollment;
    assert.ok(require('./railgun-account-enrollment').isRailgunAccountEnrollment(enrollment));
    assert.ok(!recoveredBusy.has(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600000);
    assert.match(holdId, /^[0-9a-f]{64}$/);
    assert.equal(typeof reviewDisclosures, 'function');
    assert.equal(typeof reviewTransaction, 'function');
    assert.ok(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= 3000000n);
    assert.ok(typeof maxGasFee === 'bigint' && maxGasFee > 0n && maxGasFee <= 2000000000000000n);
    assert.ok(require('path').isAbsolute(artifactDirectory));
    const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(options.archive);
    const proverArchive = require('./railgun-prover-runtime').verifyRailgunProverRuntime(
      options.proverArchive
    );
    const { assertRailgunIdentity } = require('./railgun-identity');
    const {
      getRailgunAccountPublicIdentity,
      assertRailgunAccountPublicDestination,
    } = require('./railgun-account-public');
    const publicPolicy = require('./railgun-public-policy').getRailgunPublicPolicy(archive);
    const walletPolicy = require('./railgun-account-wallet').getRailgunAccountWalletPolicy({
      archive,
      coordinator,
      enrollment,
    });
    const txidPolicy = require('./railgun-txid-policy').getRailgunTxidPolicy(archive);
    const parent = enrollment.getContext('engine');
    const descriptor = assertRailgunIdentity(identity, parent);
    assert.deepEqual(descriptor, enrollment.descriptor);
    const publicIdentity = detach(
      getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy)
    );
    controller = new AbortController();
    const lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const started = performance.now(),
      deadline = started + timeoutMs;
    let owned, generation, token, completedCheckpoint, submitterMetadata;
    const readSubmitterMetadata = () => {
      const { getWalletRecord, WALLET_TYPES } = require('../identity-manager');
      const record = getWalletRecord(0);
      assert.ok(record && record.index === 0 && record.type === WALLET_TYPES.MNEMONIC);
      const address = require('ethers').getAddress(record.address).toLowerCase();
      assert.ok(BigInt(address) > 0n);
      return Object.freeze({ index: 0, type: record.type, address });
    };
    const current = (margin = 0) => {
      const now = performance.now();
      assert.ok(!lifetime.aborted && now >= started && now + margin < deadline);
      getPrivacyContext(parent);
      assert.deepEqual(assertRailgunIdentity(identity, parent), descriptor);
      assert.deepEqual(
        getRailgunAccountPublicIdentity(coordinator, enrollment, publicPolicy),
        publicIdentity
      );
      assertRailgunAccountPublicDestination(coordinator, enrollment, destination, publicPolicy);
      for (const value of constraints) assert.ok(!value.signal.aborted);
      if (submitterMetadata) assert.deepEqual(readSubmitterMetadata(), submitterMetadata);
      if (generation) assert.deepEqual(enrollment.catalog.activeFor(walletPolicy), generation);
      if (token) assert.deepEqual(coordinator.assertSnapshot(token), completedCheckpoint);
    };
    const remaining = (cap, reserve = 0) => {
      current(reserve);
      const budget = Math.min(cap, Math.floor(deadline - performance.now()) - reserve);
      assert.ok(budget > 0);
      return budget;
    };
    // Await original work, including ignored cancellation. Timers revoke
    // admission but never release exclusion around an uncooperative callback.
    const bounded = async (cap, reserve, run) => {
      const budget = remaining(cap, reserve),
        end = performance.now() + budget;
      const local = setTimeout(() => controller.abort(), budget);
      local.unref?.();
      try {
        const value = await run(budget);
        current();
        assert.ok(performance.now() < end);
        return value;
      } finally {
        clearTimeout(local);
      }
    };
    current();
    recoveredBusy.add(enrollment);
    claimed = true;
    timer = setTimeout(stop, timeoutMs);
    timer.unref?.();
    lifetime.addEventListener('abort', stop, { once: true });
    state.stage = 'history';
    const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
    current();
    const select = (records) => {
      const matches = records.filter((value) => value.entry.id === holdId);
      assert.equal(matches.length, 1);
      return matches[0];
    };
    const baseline = await reservations.withSigningRecovery(
      async (records, context) => {
        try {
          current();
          context.assertCurrent();
          const selected = select(records);
          reservations.assertReceiptContext(selected.receipt, 'recovery');
          assert.deepEqual(await reservations.assertReceipt(selected.receipt), selected.entry);
          const stored = await capsules.readSigned(selected.receipt);
          context.assertCurrent();
          current();
          assert.equal(stored.holdId, holdId);
          assert.equal(stored.capsule.walletId, descriptor.walletId);
          assert.ok(stored.signature && stored.provedTransaction);
          const capsule = require('./railgun-private-capsule').normalizeRailgunPrivateCapsule(
            stored.capsule
          );
          require('./railgun-private-intent').matchRailgunPrivateProvedTransaction(
            capsule.preparation.transaction,
            stored.provedTransaction,
            capsule.preparation.expected
          );
          assert.equal(
            railgunTransactJournalIntent({
              ...stored.provedTransaction,
              from: selected.entry.signing.submitter,
            }).intentDigest,
            selected.entry.facts.intentDigest
          );
          if (capsule.selection.kind !== 'railgun-private-transfer')
            assert.equal(capsule.selection.recipient, selected.entry.signing.submitter);
          return detach({ entry: selected.entry, stored });
        } catch {
          return null;
        }
      },
      { timeoutMs: remaining(15000) }
    );
    current();
    assert.ok(baseline);
    const { capsule, provedTransaction } = baseline.stored;
    const owner = baseline.entry.signing.submitter;
    assert.match(owner, /^0x[0-9a-f]{40}$/);
    // Public vault metadata only before review: getAddress() itself may
    // borrow the EOA key. The real signer is checked in the final core.
    submitterMetadata = readSubmitterMetadata();
    assert.equal(submitterMetadata.address, owner);
    current();
    scope = createPrivacyScope({
      profileId: getPrivacyContext(parent).profileId,
      signal: lifetime,
      isCurrent: () => {
        try {
          current();
          return true;
        } catch {
          return false;
        }
      },
    });
    const {
      createPrivateRpc,
      getPrivateRpcDestination,
      getPrivateRpcDestinationDetails,
      createPrivateRpcDestinationConstraint,
    } = require('../networks/private-rpc');
    const protocolHandle = scope.getContext({
      ...getPrivacyContext(parent).subject,
      role: 'protocol-rpc',
      operation: undefined,
    });
    const transactionHandle = scope.getContext({
      kind: 'public-address',
      principal: owner,
      chainId: pins.chainId,
      role: 'transaction-rpc',
    });
    const details = [];
    for (const [handle, role] of [
      [protocolHandle, 'protocol-rpc'],
      [transactionHandle, 'transaction-rpc'],
    ]) {
      const rpc = createPrivateRpc(handle, role);
      previewClients.push(rpc);
      const observation = getPrivateRpcDestination(rpc, handle);
      details.push(getPrivateRpcDestinationDetails(observation));
      constraints.push(
        createPrivateRpcDestinationConstraint({ observation, signal: lifetime, deadline })
      );
    }
    const destinationConstraints = Object.freeze({
      protocol: constraints[0].constraint,
      transaction: constraints[1].constraint,
    });
    state.stage = 'prior-attempt';
    const journal = require('./private-submission-journal').getPrivateSubmissionJournal(
      transactionHandle
    );
    const history = await journal.readSnapshot();
    current();
    assert.ok(!history.records.some((record) => !record.resolution));
    assert.ok(
      ![...history.records, ...history.archive].some(
        (record) =>
          record.intent?.kind === 'railgun-transact' &&
          record.intent.tree === capsule.selection.tree &&
          record.intent.nullifier === capsule.preparation.expected.nullifier
      )
    );
    const { POI_URL } = require('./railgun-public-services');
    const { REQUIRED_LIST, normalizePoiNotes } = require('./railgun-poi-records');
    const summary = detach({
      purpose: 'railgun-recovered-private-submission',
      chainId: pins.chainId,
      operation: capsule.selection.kind,
      submitter: owner,
      recipient: capsule.selection.recipient,
      ...(Object.hasOwn(capsule.selection, 'recipientRelationship')
        ? {
            recipientRelationship: 'foreign',
            foreignOutputPoiDisclosure:
              "A later POI submission for this transaction by this account links the recipient's blinded output commitment to this spend at the POI aggregator.",
          }
        : {}),
      selection: {
        noteId: `${capsule.selection.tree}:${capsule.selection.position}`,
        originalCheckpointHash: baseline.entry.facts.checkpointHash,
      },
      destinations: {
        retainedSource: getPrivateRpcDestinationDetails(destination).url,
        protocolRpc: details[0].url,
        transactionRpc: details[1].url,
        poi: POI_URL,
        txid: POI_URL,
      },
      exposures: {
        source: [
          'lazy-chain-id-check',
          'public-proxy-logs',
          'canonical-blocks',
          'retained-range-and-timing',
        ],
        poi: [
          'selected-blinded-commitment',
          'commitment-type',
          'required-list',
          'membership-roots',
          'membership-position-and-signed-event',
        ],
        txidIfTransact: [
          'latest-txid',
          'checkpoint-tree-index-root',
          'creating-transaction-source-binding',
        ],
        privatePreflight: [
          'lazy-chain-id-check',
          'deployment-code-and-storage',
          'verification-key',
          'unshield-fee',
          'original-input-tree',
          'original-merkle-root',
          'selected-nullifier',
          'root-history',
          'unspent-check',
        ],
        transactionRpc: [
          'lazy-chain-id-check',
          'public-submitter',
          'code',
          'nonce',
          'balance',
          'fee-estimates',
          'original-proved-calldata',
          'recipient',
          'nullifier',
          'commitments',
          'encrypted-output',
          'eth_estimateGas',
          'eth_call',
          'signed-transaction',
        ],
      },
      requiredList: REQUIRED_LIST,
      inputCreatorDeterminedByCompletedWallet: true,
      originalSpendingSignatureReused: true,
      newSpendingSignature: false,
      eoaSigningAndBroadcast: true,
      simulationBeforeTransactionReview: true,
      automaticRetry: false,
      chainStateVerified: false,
    });
    state.stage = 'disclosure-review';
    assert.equal(await bounded(30000, 175000, () => reviewDisclosures(summary, lifetime)), true);
    state.stage = 'wallet';
    const owners = Object.freeze({ identity, enrollment, coordinator });
    await bounded(180000, 175000, async (budget) => {
      account = await require('./railgun-account-wallet').openRailgunCompletedAccountWallet({
        ...owners,
        archive,
        destination,
        signal: lifetime,
        timeoutMs: budget,
      });
      try {
        current();
        owned = detach(
          require('./railgun-account-wallet').readRailgunCompletedAccountPrivateInput(
            account,
            owners,
            capsule
          )
        );
        generation = detach(enrollment.catalog.activeFor(walletPolicy));
        assert.equal(generation.id, owned.generationId);
      } finally {
        await account.close();
        account = null;
      }
    });
    current();
    const record = owned.ownedRecord;
    assert.equal(record.id, owned.binding.id);
    assert.equal(record.type, owned.binding.type);
    assert.equal(record.hash, owned.binding.noteHash);
    assert.equal(record.txid, owned.binding.txid);
    assert.equal(record.nullifier, owned.binding.nullifier);
    assert.equal(record.hash, capsule.noteHash);
    assert.equal(record.nullifier, capsule.preparation.expected.nullifier);
    assert.ok(record.blockNumber >= require('./railgun-owned-poi-records').POI_LAUNCH_BLOCK);
    const note = detach({
      type: record.type,
      txid: record.txid,
      hash: record.hash,
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      blockNumber: record.blockNumber,
    });
    let mirrorState, noteWitness;
    if (record.type === 'Transact') {
      state.stage = 'txid';
      await bounded(180000, 175000, async () => {
        mirror = await require('./railgun-account-txid').openRailgunAccountTxid({
          enrollment,
          coordinator,
          archive,
          create: false,
          checkpointOnly: true,
          signal: lifetime,
        });
        try {
          current();
          assert.equal(mirror.policy, txidPolicy);
          assert.deepEqual(mirror.publicIdentity, publicIdentity);
          const before = detach(await mirror.inspect());
          current();
          assert.ok(before.checkpoint && !before.pending);
          const result = await mirror.witnessNote(note);
          current();
          assert.deepEqual(await mirror.inspect(), before);
          current();
          mirrorState = before.checkpoint.state;
          noteWitness = require('./railgun-txid-note-witness').normalizeRailgunNoteTxidWitness(
            result.noteWitness,
            mirrorState,
            note
          );
        } finally {
          await mirror.close();
          mirror = null;
        }
      });
    } else assert.equal(record.type, 'Shield');
    state.stage = 'recovery';
    await reservations.withSigningRecovery(
      async (records, context) => {
        const phaseSignal = AbortSignal.any([lifetime, context.signal]);
        let eligibilityScope, sourceReceipt, membership, rootReceipt, rootPoint, verifiedCreator;
        // Taken before each acquisition, so at or before its age origin.
        let proofStarted, poiStarted, rootStarted;
        const phaseCurrent = (margin = 0) => {
          current(margin);
          context.assertCurrent();
          assert.ok(
            Number.isFinite(context.deadline) && performance.now() + margin < context.deadline
          );
        };
        const phaseBudget = (cap, reserve = 0) => {
          phaseCurrent(reserve);
          const left =
            Math.floor(Math.min(deadline, context.deadline) - performance.now()) - reserve;
          assert.ok(left > 0);
          return Math.min(cap, left);
        };
        const attest = async () => {
          phaseCurrent();
          const selected = select(records);
          assert.deepEqual(selected.entry, baseline.entry);
          reservations.assertReceiptContext(selected.receipt, 'recovery');
          assert.deepEqual(await reservations.assertReceipt(selected.receipt), baseline.entry);
          assert.deepEqual(await capsules.readSigned(selected.receipt), baseline.stored);
          phaseCurrent();
        };
        try {
          await attest();
          state.stage = 'source';
          let snapshot;
          try {
            snapshot = await coordinator.withCompletedPublicSnapshot(
              { destination, signal: phaseSignal, timeoutMs: phaseBudget(45000, 125000) },
              async (source) => {
                try {
                  phaseCurrent();
                  assert.equal(
                    require('./railgun-wallet-coverage').checkpointHash(source.checkpoint),
                    owned.binding.checkpointHash
                  );
                  assert.deepEqual(source.checkpoint.to, owned.publicThrough);
                  let creator;
                  if (note.type === 'Transact')
                    creator =
                      await require('./railgun-private-creator').collectRailgunPrivateCreator({
                        note,
                        checkpoint: source.checkpoint,
                        visit: source.visitSource,
                        assertCurrent: () => {
                          phaseCurrent();
                          assert.ok(!source.signal.aborted);
                        },
                      });
                  return { creator };
                } catch {
                  return null;
                } // Expected semantic refusal must not close a healthy shared coordinator.
              }
            );
          } catch (error) {
            sourceOutcome =
              require('./railgun-scan-coordinator').getRailgunCompletedSnapshotOutcome(
                coordinator,
                error
              );
            throw fail();
          }
          // Save genuine failure provenance above before a local cancellation check.
          phaseCurrent();
          assert.ok(snapshot.value);
          token = snapshot.evidence;
          completedCheckpoint = detach(coordinator.assertSnapshot(token));
          assert.equal(
            require('./railgun-wallet-coverage').checkpointHash(completedCheckpoint),
            owned.binding.checkpointHash
          );
          assert.deepEqual(completedCheckpoint.to, owned.publicThrough);
          phaseCurrent();
          if (note.type === 'Transact') {
            state.stage = 'creator';
            const creator = snapshot.value.creator,
              row = noteWitness.witness.row;
            assert.deepEqual(creator.note, note);
            assert.equal(creator.checkpointHash, owned.binding.checkpointHash);
            assert.match(row.graphID, /^0x[0-9a-f]{192}$/);
            const index = BigInt('0x' + row.graphID.slice(66, 130));
            assert.ok(index <= BigInt(Number.MAX_SAFE_INTEGER));
            assert.equal(Number(index), creator.creator.transactionIndex);
            assert.equal(row.blockNumber, creator.creator.blockNumber);
            assert.equal('0x' + row.txid, creator.creator.transactionHash);
            verifiedCreator =
              await require('./railgun-note-provenance').verifyRailgunNoteProvenance({
                handle: enrollment.getContext('engine', 'note-provenance'),
                archive,
                state: mirrorState,
                note,
                noteWitness,
                events: creator.events,
                signal: phaseSignal,
                timeoutMs: phaseBudget(30000, 105000),
              });
            phaseCurrent();
            assert.equal(verifiedCreator.pathVerified, true);
            assert.equal(verifiedCreator.suppliedCreatorEventsMatched, true);
            assert.equal(verifiedCreator.utilityExitObserved, true);
            assert.deepEqual(verifiedCreator.coverage, {
              matchedRows: 1,
              knownOmissions: 0,
              boundParamsChecked: false,
              unshieldCommitmentHashesChecked: false,
              globalTxidCompleteness: false,
            });
            if (row.unshield) assert.equal(verifiedCreator.unshieldCommitmentVerified, true);
            const text = JSON.stringify({
              archive,
              state: mirrorState,
              note: noteWitness.note,
              noteWitness,
              events: creator.events,
            });
            assert.equal(
              verifiedCreator.inputSha256,
              require('crypto').createHash('sha256').update(text).digest('hex')
            );
            rootPoint = Object.freeze({ index: mirrorState.count - 1, root: mirrorState.root });
          }
          state.stage = 'proof';
          const evidence = {
            intent: capsule.preparation.transaction,
            transaction: provedTransaction,
            expected: capsule.preparation.expected,
          };
          proofStarted = performance.now();
          proof = await verifyRailgunPrivateProof({
            enrollment,
            proverArchive,
            artifactDirectory,
            ...evidence,
            signal: phaseSignal,
            timeoutMs: phaseBudget(60000, 80000),
          });
          await attest();
          eligibilityScope = createPrivacyScope({
            profileId: getPrivacyContext(parent).profileId,
            signal: AbortSignal.any([lifetime, context.signal]),
            isCurrent: () => {
              try {
                phaseCurrent();
                return true;
              } catch {
                return false;
              }
            },
          });
          const operation = 'poi:' + require('crypto').randomBytes(32).toString('hex');
          const poiHandle = eligibilityScope.getContext({
            ...getPrivacyContext(parent).subject,
            role: 'poi',
            operation,
          });
          const notes = normalizePoiNotes([
            { blindedCommitment: record.blindedCommitment, type: record.type },
          ]);
          state.stage = 'membership';
          const listBudget = phaseBudget(15000, 65000);
          poi = require('./railgun-poi-source').createRailgunPoiSource({
            handle: poiHandle,
            notes,
          });
          assert.ok(poi.closed && typeof poi.closed.then === 'function');
          poiStarted = performance.now();
          const acquired = await poi.acquire({ timeoutMs: listBudget });
          phaseCurrent();
          sourceReceipt = acquired.receipt;
          const observation = poi.assertResult(sourceReceipt);
          assert.equal(observation.listKey, REQUIRED_LIST);
          assert.equal(observation.rootsAccepted, true);
          assert.deepEqual(
            observation.statuses,
            notes.map((value) => ({ ...value, status: 'Valid' }))
          );
          membership = await require('./railgun-poi-membership').verifyRailgunPoiMembership({
            handle: poiHandle,
            source: poi,
            receipt: sourceReceipt,
            archive,
            timeoutMs: phaseBudget(15000, 60000),
          });
          phaseCurrent();
          const live = (margin = 0) => {
            phaseCurrent(margin);
            assertRailgunPrivateProof(proof.receipt, enrollment, evidence, margin);
            assert.equal(poi.assertResult(sourceReceipt, margin), observation);
            const checked = require('./railgun-poi-membership').assertRailgunPoiMembership(
              membership.receipt,
              poiHandle,
              margin
            );
            assert.equal(checked, membership.observation);
            assert.equal(checked.listKey, REQUIRED_LIST);
            assert.equal(checked.membershipVerified, true);
            assert.equal(checked.rootsAccepted, true);
            assert.deepEqual(
              checked.statuses,
              notes.map((value) => ({ ...value, status: 'Valid' }))
            );
            if (roots) roots.assertRoot(rootReceipt, rootPoint, margin);
          };
          if (rootPoint) {
            state.stage = 'root';
            roots = require('./railgun-txid-root').createRailgunTxidRootSource(
              eligibilityScope.getContext({
                kind: 'service',
                principal: 'railgun-public-sync',
                protocol: 'railgun',
                deployment: 'sepolia',
                chainId: pins.chainId,
                role: 'public-services',
              })
            );
            const budget = phaseBudget(15000, 50000);
            const rootTimer = setTimeout(() => eligibilityScope.close(), budget);
            rootTimer.unref?.();
            try {
              rootStarted = performance.now();
              rootReceipt = await roots.acquire(rootPoint);
            } finally {
              clearTimeout(rootTimer);
            }
          }
          // Conservative: each start was taken before its acquisition (C before
          // the verifier ran, so earlier than its genuine expiry by the
          // verifier's duration). The genuine receipts remain the authority.
          const lifetimeEnd = () =>
            Math.min(
              deadline,
              context.deadline,
              proofStarted + PROOF_RECEIPT_MS,
              poiStarted + require('./railgun-poi-source').MAX_AGE_MS,
              rootPoint ? rootStarted + require('./railgun-txid-root').MAX_AGE_MS : Infinity
            );
          // Before any preflight read: refuse once the review floor, admission,
          // the send reserve and the expected preflight and EOA reads cannot
          // all fit. An early hint only: the preflight itself enforces the
          // nullifier boundary against the same estimate.
          const early =
            BUDGET.reviewMinMs +
            BUDGET.admissionMs +
            BUDGET.sendReserveMs +
            BUDGET.preflightAllowanceMs +
            BUDGET.eoaAllowanceMs;
          if (!(leftUntil(lifetimeEnd()) >= early)) throw budgetFail();
          live(early);
          await attest();
          const submissionSnapshot = Object.freeze({
            ...baseline,
            minimumBlock: owned.publicThrough.number,
          });
          const admission = Object.freeze({
            signal: eligibilityScope.signal,
            destinationConstraints,
            assertCurrent: () => {
              live();
              return submissionSnapshot;
            },
          });
          await submitFinal({
            enrollment,
            snapshot: submissionSnapshot,
            reservations,
            capsules,
            records,
            context,
            claim: admission,
            proverArchive,
            artifactDirectory,
            review: reviewTransaction,
            gasLimit,
            maxGasFee,
            state,
            preparedProof: proof,
            currentCheckpointHash: owned.binding.checkpointHash,
            lifetimeEnd,
            extraCurrent: live,
          });
        } catch (error) {
          noteRefusal(state, error);
          if (error?.code === 'RAILGUN_NOTE_PROVENANCE_EXIT_UNOBSERVED') {
            provenanceExitUnknown = true;
            try {
              require('./railgun-identity').quarantineRailgunIdentityCredentials(identity);
            } catch {
              // The original typed error must still reach the recovery owner.
            }
            throw error;
          }
          // Expected refusal stays inside recovery; any already durable send
          // outcome survives cleanup or outer post-attestation failure.
        } finally {
          for (const close of [
            () => roots?.close(),
            () => poi?.close(),
            () => proof?.close(),
            () => eligibilityScope?.close(),
          ]) {
            try {
              close();
            } catch {
              controller.abort();
            }
          }
          if (poi) {
            // A rejected/missing barrier cannot stand in for physical drainage.
            const barrier = poi.closed;
            if (!barrier || typeof barrier.then !== 'function') await new Promise(() => {});
            await barrier.catch(() => new Promise(() => {}));
          }
        }
      },
      { timeoutMs: remaining(175000) }
    );
  } catch (error) {
    // Never promote thrown transaction hashes or recovery diagnostics; only
    // the bounded refusal diagnostic is kept, outside the result shape.
    noteRefusal(state, error);
  } finally {
    clearTimeout(timer);
    stop();
    // Both close promises must be observed even if an earlier close rejects.
    // Genuine account/mirror implementations retain their shared phase on an
    // unobserved exit; this invocation does not forge successful physical drain.
    const drains = [account, mirror].filter(Boolean).map(async (value) => {
      await value.close();
    });
    await Promise.allSettled(drains);
    for (const client of previewClients) {
      try {
        client.release();
      } catch {
        /* Logical release only. */
      }
    }
    if (claimed && !provenanceExitUnknown) recoveredBusy.delete(enrollment);
  }
  return state.outcome
    ? Object.freeze(state.outcome)
    : refusalResult(state, sourceOutcome ? { sourceOutcome } : {});
}

module.exports = {
  submitRailgunPrivateTransaction,
  submitRailgunRecoveredPrivateTransaction,
  assertRailgunPrivateSubmission,
  getRailgunPrivateSubmissionDiagnostic,
  getRailgunPrivatePreflightDiagnostic,
};
