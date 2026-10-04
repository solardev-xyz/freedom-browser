/** Genuine main-owned review inventory and a fixed unwired submission controller.
 * Inventory exports check registered policy without utility/network work or
 * logical intent mutation. Submission separately pins runtime/validation and
 * requires its trusted-main review dependency; no human-consent claim is made.
 * Existing encrypted-store opens retain normal lease/floor/key housekeeping.
 */
const assert = require('assert/strict');
const { createHash, randomUUID } = require('crypto');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const {
  assertRailgunAccountPublic,
  getRailgunAccountPublicIdentity,
  getRailgunAccountPublicDestination,
  assertRailgunAccountPublicDestination,
} = require('./railgun-account-public');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const {
  assertRailgunOwnPoiCapture,
  assertRailgunOwnPoiStableCapture,
} = require('./railgun-own-poi-binding');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const plans = new WeakMap(),
  live = new Map(),
  operations = new Map();
const TTL_MS = 120000;
const POI_URL = 'https://ppoi.fdi.network';
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const snapshot = (value) => freeze(JSON.parse(JSON.stringify(value)));
const refused = (stage) => Object.freeze({ status: 'refused', stage });
function options(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  // Snapshot options without invoking getters or retaining a mutable container.
  return Object.fromEntries(
    keys.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      assert.ok(Object.hasOwn(descriptor, 'value'));
      return [key, descriptor.value];
    })
  );
}
function clean(state) {
  if (!state.revoked || state.pending) return;
  if (live.get(state.directory) === state.plan) live.delete(state.directory);
  plans.delete(state.plan);
  state.bindings = null;
  state.entry = null;
  state.capture = null;
  state.store = null;
  state.capsuleDigest = null;
  state.resolveClosed();
}
function revoke(plan) {
  const state = plans.get(plan);
  if (!state || state.revoked) return;
  state.revoked = true;
  clearTimeout(state.ttlTimer);
  for (const [signal, listener] of state.listeners) signal.removeEventListener('abort', listener);
  state.listeners.clear();
  // Mark revoked before dispatch: abort listeners may synchronously reenter.
  state.controller.abort();
  clean(state);
}
function watch(state, signal) {
  assert.ok(signal instanceof AbortSignal);
  // A late borrowed open may settle after revocation. Do not attach fresh
  // listeners to a dead plan, or attach twice to a shared parent/store signal.
  if (state.revoked || state.listeners.has(signal)) return;
  const listener = () => revoke(state.plan);
  signal.addEventListener('abort', listener, { once: true });
  state.listeners.set(signal, listener);
  if (signal.aborted) revoke(state.plan);
}
function context(identity, enrollment, coordinator) {
  assert.ok(isRailgunAccountEnrollment(enrollment));
  const handle = enrollment.getContext('engine');
  const parent = getPrivacyContext(handle);
  const descriptor = snapshot(assertRailgunIdentity(identity, handle));
  assert.deepEqual(descriptor, enrollment.descriptor);
  assert.ok(
    Number.isSafeInteger(descriptor.accountIndex) &&
      descriptor.accountIndex >= 0 &&
      descriptor.accountIndex <= 65535
  );
  const policy = assertRailgunAccountPublic(coordinator, enrollment);
  const publicIdentity = snapshot(getRailgunAccountPublicIdentity(coordinator, enrollment, policy));
  assert.ok(typeof enrollment.directory === 'string' && enrollment.directory.length > 0);
  return {
    identity,
    enrollment,
    coordinator,
    handle,
    descriptor,
    policy,
    policySnapshot: snapshot(policy),
    publicIdentity,
    profileId: parent.profileId,
    generation: parent.generation,
    subject: snapshot(parent.subject),
  };
}
function assertBindings(b, directory) {
  for (const signal of [b.identity.signal, b.enrollment.signal, b.coordinator.signal])
    assert.ok(!signal.aborted);
  assert.equal(b.enrollment.directory, directory);
  const parent = getPrivacyContext(b.handle);
  assert.equal(parent.profileId, b.profileId);
  assert.equal(parent.generation, b.generation);
  assert.deepEqual(parent.subject, b.subject);
  assert.deepEqual(assertRailgunIdentity(b.identity, b.handle), b.descriptor);
  assert.deepEqual(b.enrollment.descriptor, b.descriptor);
  assert.equal(assertRailgunAccountPublic(b.coordinator, b.enrollment, b.policy), b.policy);
  assert.deepEqual(b.policy, b.policySnapshot);
  assert.deepEqual(
    getRailgunAccountPublicIdentity(b.coordinator, b.enrollment, b.policy),
    b.publicIdentity
  );
}
function current(state, deadline) {
  assert.ok(!state.revoked && !state.controller.signal.aborted);
  const now = performance.now();
  assert.ok(
    Number.isFinite(now) &&
      now >= state.lastNow &&
      (state.promoted || now < state.expiresAt) &&
      now < deadline
  );
  state.lastNow = now;
  assertBindings(state.bindings, state.directory);
  if (state.store) assert.ok(!state.store.signal.aborted);
}
// This claim excludes the sender/plan operations and attempted output only.
// Legacy Stage A/history/ordinary diagnostics retain their existing overlap
// except for the output module's local owner map. This is not consent authority.
const attemptedClaimFailure = () =>
  Object.assign(new Error('Railgun POI disclosure plan unavailable'), {
    code: 'RAILGUN_POI_DISCLOSURE_PLAN_REFUSED',
  });
// A separate closure retains only this small state; release clears owner data.
function attemptedClaimFacade(state) {
  const assertCurrent = () => {
    try {
      assert.ok(!state.released);
      for (const signal of state.signals) assert.ok(!signal.aborted);
      assert.equal(operations.get(state.directory), state.token);
      assertBindings(state.bindings, state.directory);
      // Genuine owner checks can synchronously invoke integration code. A
      // reentrant release or cancellation cannot rescue the current assertion.
      assert.ok(!state.released);
      for (const signal of state.signals) assert.ok(!signal.aborted);
      assert.equal(operations.get(state.directory), state.token);
    } catch {
      throw attemptedClaimFailure();
    }
  };
  const release = () => {
    if (state.released) return;
    state.released = true;
    if (operations.get(state.directory) === state.token) operations.delete(state.directory);
    state.bindings = null;
    state.signals = null;
    state.directory = null;
    state.token = null;
  };
  return Object.freeze({ assertCurrent, release });
}
function claimRailgunAttemptedPoiOutput(input) {
  try {
    const { identity, enrollment, coordinator, signal } = options(input, [
      'identity',
      'enrollment',
      'coordinator',
      'signal',
    ]);
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    const bindings = context(identity, enrollment, coordinator);
    const directory = enrollment.directory;
    const signals = [
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      getPrivacyContext(bindings.handle).signal,
    ];
    for (const ownerSignal of signals)
      assert.ok(ownerSignal instanceof AbortSignal && !ownerSignal.aborted);
    assertBindings(bindings, directory);
    for (const ownerSignal of signals) assert.ok(!ownerSignal.aborted);
    // No await or external callback between this final check and installation.
    // A nested claimant admitted during owner validation must remain the owner.
    assert.ok(!operations.has(directory));
    const state = { bindings, directory, signals, token: {}, released: false };
    const facade = attemptedClaimFacade(state);
    operations.set(directory, state.token);
    return facade;
  } catch {
    throw attemptedClaimFailure();
  }
}
function operationKind(capture, payload) {
  const kind = capture.capsule.selection.kind;
  assert.ok(kind === 'railgun-private-transfer' || kind === 'railgun-token-unshield');
  const transfer = kind === 'railgun-private-transfer';
  assert.equal(payload.blindedCommitmentsOut.length, transfer ? 1 : 0);
  assert.equal(payload.railgunTxidIfHasUnshield === '0x00', transfer);
  return transfer ? 'transfer' : 'unshield';
}
function summaryFor(state) {
  const payload = state.entry.payload;
  const operation = operationKind(state.capture, payload);
  const transfer = operation === 'transfer';
  const summary = freeze({
    version: 1,
    protocol: 'railgun',
    deployment: 'sepolia',
    chainId: 11155111,
    accountIndex: state.bindings.descriptor.accountIndex,
    endpoint: POI_URL,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    operation,
    outputCount: payload.blindedCommitmentsOut.length,
    unshieldIdCategory: transfer ? 'absent' : 'railgun-txid',
    requestInventory: [
      { method: 'ppoi_validate_poi_merkleroots', count: 1 },
      { method: 'ppoi_validate_txid_merkleroot', count: 1 },
      { method: 'ppoi_submit_transact_proof', count: 1 },
    ],
    disclosureCategories: [
      'proof-related-query-timing',
      'network-session-linkability',
      'transaction-linkability',
      'request-id-local-time',
      'poi-list-root',
      'txid-root-and-index',
      'snark-proof-and-public-inputs',
      transfer ? 'blinded-output-commitment' : 'unshield-railgun-txid',
    ],
    uncertaintyCategories: [
      'service-acceptance-unqualified',
      'non-delivery-not-established',
      'safe-retry-not-established',
      'irreversible-disclosure-possible-with-uncertain-outcome',
      'no-automatic-retry',
    ],
    requestIdAllocation: 'local-time-once-at-durable-attempt',
    displayFreshnessMs: TTL_MS,
    consentGranted: false,
    transportAuthorized: false,
    requestLimitsEnforced: false,
    proofVerified: false,
    rootsAccepted: false,
    spendingEnabled: false,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 4096);
  return summary;
}
async function inspect(state, deadline, progress) {
  const check = () => {
    assert.equal(operations.get(state.directory), state.owner);
    current(state, deadline);
  };
  const remaining = () => {
    check();
    const left = Math.floor(
      (state.promoted ? deadline : Math.min(deadline, state.expiresAt)) - performance.now()
    );
    assert.ok(left > 0);
    return left;
  };
  check();
  progress.stage = 'store';
  const store = await state.bindings.enrollment.openPoiIntents({ existingOnly: true });
  // Retain a late open until settlement; never close an enrollment-owned store
  // just because this plan's caller has stopped waiting.
  if (state.store) assert.equal(store, state.store);
  else {
    state.store = store;
    watch(state, store.signal);
  }
  check();
  progress.stage = 'entry';
  const loaded = await store.get(state.capsuleDigest);
  check();
  assert.ok(loaded && loaded.state === 'prepared');
  assert.equal(loaded.capsuleDigest, state.capsuleDigest);
  const entry = snapshot(loaded);
  const payload = normalizeRailgunPoiPayload(entry.payload);
  assert.deepEqual(payload, entry.payload);
  assert.equal(
    createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    entry.payloadSha256
  );
  if (state.entry) assert.deepEqual(entry, state.entry);
  else state.entry = entry;
  const readCurrent = async () => {
    check();
    const latest = await store.get(state.capsuleDigest);
    check();
    assert.deepEqual(latest, state.entry);
  };
  const bind = (capture) => {
    assert.equal(capture.capsuleDigest, entry.capsuleDigest);
    assert.equal(capture.bindingDigest, entry.bindingDigest);
    assert.deepEqual(capture.selector, entry.selector);
    operationKind(capture, payload);
    if (state.capture) assertRailgunOwnPoiCapture(capture, state.capture);
    else state.capture = snapshot(capture);
  };
  progress.stage = 'recovery';
  const recovered = await withRailgunOwnOperationRecovery(
    {
      enrollment: state.bindings.enrollment,
      selector: entry.selector,
      signal: state.controller.signal,
      timeoutMs: remaining(),
    },
    async (window) => {
      check();
      window.assertCurrent();
      progress.stage = 'binding';
      bind(window.capture);
      progress.stage = 'reattest';
      bind(await window.reattest());
      check();
      window.assertCurrent();
      await readCurrent();
      bind(await window.reattest());
      check();
      window.assertCurrent();
      return { checked: true };
    }
  );
  check();
  assert.equal(recovered.status, 'used');
  assert.deepEqual(recovered.value, { checked: true });
  progress.stage = 'final-entry';
  await readCurrent();
}
// This separate scope deliberately captures no private state or account data.
function wrapper(plan, summary, signal, closed) {
  return Object.freeze({
    status: 'prepared',
    plan,
    summary,
    signal,
    close: () => revoke(plan),
    closed,
  });
}
async function prepareRailgunPoiDisclosurePlan(input) {
  const progress = { stage: 'context' };
  let state,
    timer,
    success = false;
  try {
    const started = performance.now();
    const args = options(input, [
      'identity',
      'enrollment',
      'coordinator',
      'capsuleDigest',
      'signal',
      ...(Object.hasOwn(input, 'timeoutMs') ? ['timeoutMs'] : []),
    ]);
    const { identity, enrollment, coordinator, capsuleDigest, signal, timeoutMs = 15000 } = args;
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 45000);
    assert.equal(typeof capsuleDigest, 'string');
    assert.match(capsuleDigest, /^[0-9a-f]{64}$/);
    const bindings = context(identity, enrollment, coordinator);
    for (const ownerSignal of [identity.signal, enrollment.signal, coordinator.signal])
      assert.ok(ownerSignal instanceof AbortSignal && !ownerSignal.aborted);
    progress.stage = 'busy';
    assert.ok(!operations.has(enrollment.directory));
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const plan = Object.freeze({});
    state = {
      plan,
      directory: enrollment.directory,
      owner: {},
      bindings,
      capsuleDigest,
      controller: new AbortController(),
      listeners: new Map(),
      pending: 1,
      revoked: false,
      started,
      lastNow: started,
      expiresAt: started + TTL_MS,
      closed,
      resolveClosed,
    };
    plans.set(plan, state);
    operations.set(state.directory, state.owner);
    for (const ownerSignal of new Set([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      getPrivacyContext(bindings.handle).signal,
    ]))
      watch(state, ownerSignal);
    const deadline = started + timeoutMs;
    timer = setTimeout(() => revoke(plan), Math.max(0, deadline - performance.now()));
    timer.unref?.();
    await inspect(state, deadline, progress);
    const summary = summaryFor(state);
    progress.stage = 'lifetime';
    current(state, deadline);
    state.summary = summary;
    const previous = live.get(state.directory);
    live.set(state.directory, plan);
    if (previous) revoke(previous);
    // Old-plan abort listeners cannot replace an admitted operation, and any
    // cancellation they trigger must prevent publication of a live result.
    current(state, deadline);
    state.ttlTimer = setTimeout(
      () => revoke(plan),
      Math.max(0, state.expiresAt - performance.now())
    );
    state.ttlTimer.unref?.();
    success = true;
    return wrapper(plan, summary, state.controller.signal, closed);
  } catch {
    return refused(progress.stage);
  } finally {
    clearTimeout(timer);
    if (state) {
      if (!success) revoke(state.plan);
      if (operations.get(state.directory) === state.owner) operations.delete(state.directory);
      state.pending--;
      clean(state);
    }
  }
}
async function revalidateRailgunPoiDisclosurePlan(input) {
  const progress = { stage: 'context' };
  let state,
    timer,
    listener,
    signal,
    admitted = false;
  try {
    // Locate without invoking a getter so malformed options cannot conceal a
    // recognized plan from revocation, or manufacture a handle through accessors.
    const plan = input && Object.getOwnPropertyDescriptor(input, 'plan')?.value;
    state = plans.get(plan);
    assert.ok(state && !state.revoked);
    if (operations.has(state.directory)) return refused('busy');
    assert.ok(!state.claimed);
    const args = options(input, ['plan', 'identity', 'enrollment', 'coordinator', 'signal']);
    const b = state.bindings;
    assert.equal(args.identity, b.identity);
    assert.equal(args.enrollment, b.enrollment);
    assert.equal(args.coordinator, b.coordinator);
    signal = args.signal;
    assert.ok(signal instanceof AbortSignal);
    listener = () => revoke(plan);
    signal.addEventListener('abort', listener, { once: true });
    if (signal.aborted) revoke(plan);
    current(state, state.expiresAt);
    operations.set(state.directory, state.owner);
    state.pending++;
    admitted = true;
    const deadline = Math.min(state.expiresAt, performance.now() + 15000);
    timer = setTimeout(() => revoke(plan), Math.max(0, deadline - performance.now()));
    timer.unref?.();
    await inspect(state, deadline, progress);
    progress.stage = 'lifetime';
    current(state, deadline);
    return Object.freeze({ status: 'current', summary: state.summary });
  } catch {
    if (state) revoke(state.plan);
    return refused(progress.stage);
  } finally {
    clearTimeout(timer);
    if (listener) signal.removeEventListener('abort', listener);
    if (admitted) {
      if (operations.get(state.directory) === state.owner) operations.delete(state.directory);
      state.pending--;
      clean(state);
    }
  }
}
// Fixed unwired main controller. The review adapter is a trusted integration
// dependency, not evidence of a human gesture. No renderer/IPC route calls it.
// The adapter must settle on signal abort. Its promise is always awaited: an
// uncooperative adapter retains exclusion and cleanup indefinitely, with no
// hard drain-latency guarantee.
async function submitRailgunRetainedPoi(input) {
  const started = performance.now();
  let state,
    args,
    admitted = false,
    protectedBusy = false,
    timer,
    stage = 'context',
    possiblyCommitted = false,
    response,
    sourceOutcome,
    prepared,
    sourceDestination,
    destinationDetails,
    postScope,
    postHandle,
    list,
    txid,
    transport,
    postUsed = false;
  const closeOwned = (value) => {
    try {
      value?.close?.();
    } catch {
      // Drain promises remain mandatory even if immediate destruction throws.
    }
  };
  try {
    const plan = input && Object.getOwnPropertyDescriptor(input, 'plan')?.value;
    state = plans.get(plan);
    assert.ok(state && !state.revoked);
    if (operations.has(state.directory)) {
      protectedBusy = true;
      return refused('busy');
    }
    args = options(input, [
      'identity',
      'enrollment',
      'coordinator',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'plan',
      'review',
      'signal',
      ...(Object.hasOwn(input, 'timeoutMs') ? ['timeoutMs'] : []),
    ]);
    const { identity, enrollment, coordinator, signal, review, timeoutMs = 840000 } = args;
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 790000 && timeoutMs <= 840000);
    assert.ok(signal instanceof AbortSignal && !signal.aborted && typeof review === 'function');
    assert.equal(identity, state.bindings.identity);
    assert.equal(enrollment, state.bindings.enrollment);
    assert.equal(coordinator, state.bindings.coordinator);
    assert.ok(!state.claimed && live.get(state.directory) === plan);
    const deadline = started + timeoutMs;
    current(state, deadline);
    assert.ok(state.expiresAt - performance.now() >= 60000);
    // Synchronous claim before inspection/review. A denied or failed invocation
    // cannot be restarted with the same plan, including after a late callback.
    state.claimed = true;
    state.pending++;
    operations.set(state.directory, state.owner);
    admitted = true;
    watch(state, signal);
    timer = setTimeout(() => revoke(plan), Math.max(0, deadline - performance.now()));
    timer.unref?.();
    const senderCurrent = (margin = 0) => {
      assert.ok(Number.isSafeInteger(margin) && margin >= 0);
      assert.equal(operations.get(state.directory), state.owner);
      current(state, deadline - margin);
      if (sourceDestination)
        assertRailgunAccountPublicDestination(
          coordinator,
          enrollment,
          sourceDestination,
          state.bindings.policy
        );
    };
    const remaining = (maximum, reserve = 0) => {
      senderCurrent(reserve);
      const end = state.promoted ? deadline : Math.min(deadline, state.expiresAt);
      const left = Math.min(maximum, Math.floor(end - performance.now()) - reserve);
      assert.ok(left > 0);
      return left;
    };
    const stageRun = async (name, maximum, reserve, use) => {
      stage = name;
      const budget = remaining(maximum, reserve),
        end = performance.now() + budget;
      const check = (margin = 0) => {
        senderCurrent(reserve + margin);
        assert.ok(performance.now() + margin < end);
      };
      const timeout = setTimeout(() => revoke(plan), budget);
      timeout.unref?.();
      try {
        check();
        const value = await use(check, end);
        check();
        return value;
      } finally {
        clearTimeout(timeout);
      }
    };
    const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
    const { verifyRailgunProverRuntime } = require('./railgun-prover-runtime');
    const { getRailgunPublicPolicy } = require('./railgun-public-policy');
    const archive = verifyRailgunEngineRuntime(args.archive);
    const proverArchive = verifyRailgunProverRuntime(args.proverArchive);
    assert.equal(getRailgunPublicPolicy(archive), state.bindings.policy);
    assert.ok(
      typeof args.artifactDirectory === 'string' &&
        require('path').isAbsolute(args.artifactDirectory) &&
        Buffer.byteLength(args.artifactDirectory) <= 4096
    );
    await stageRun('prepare', 15000, 0, async (_check, end) => {
      await inspect(state, end, { stage: 'context' });
    });
    stage = 'destinations';
    sourceDestination = getRailgunAccountPublicDestination(
      coordinator,
      enrollment,
      state.bindings.policy
    );
    const {
      prepareRailgunOwnReceiptReader,
      assertPreparedRailgunOwnReceipt,
    } = require('./railgun-own-receipt');
    prepared = prepareRailgunOwnReceiptReader({
      enrollment,
      capture: state.capture,
      signal: state.controller.signal,
    });
    assert.equal(prepared.status, 'prepared');
    const { getPrivateRpcDestinationDetails } = require('../networks/private-rpc');
    destinationDetails = Object.freeze({
      source: getPrivateRpcDestinationDetails(sourceDestination),
      receipt: getPrivateRpcDestinationDetails(prepared.destination),
    });
    senderCurrent();
    const requestFor = (purpose) => {
      const submitting = purpose === 'submit-retained-poi';
      const base = state.summary;
      const request = freeze({
        version: 1,
        purpose,
        protocol: base.protocol,
        deployment: base.deployment,
        chainId: base.chainId,
        accountIndex: base.accountIndex,
        listKey: base.listKey,
        txidVersion: base.txidVersion,
        operation: base.operation,
        outputCount: base.outputCount,
        unshieldIdCategory: base.unshieldIdCategory,
        destinations: submitting
          ? [{ role: 'poi-service', origin: new URL(POI_URL).origin }]
          : [
              { role: 'source-rpc', origin: new URL(destinationDetails.source.url).origin },
              { role: 'receipt-rpc', origin: new URL(destinationDetails.receipt.url).origin },
              { role: 'poi-service', origin: new URL(POI_URL).origin },
            ],
        requestInventory: submitting
          ? [
              { method: 'ppoi_validate_poi_merkleroots', maxRequests: 1 },
              { method: 'ppoi_validate_txid_merkleroot', maxRequests: 1 },
              { method: 'ppoi_submit_transact_proof', maxRequests: 1 },
            ]
          : [
              { method: 'eth_getTransactionByHash', maxRequests: 1 },
              { method: 'eth_getTransactionReceipt', maxRequests: 1 },
              { method: 'eth_blockNumber', maxRequests: 2 },
              { method: 'eth_getBlockByNumber', maxRequests: 544 },
              { method: 'eth_getLogs', maxRequests: 1 },
              { method: 'eth_chainId', maxRequests: 2 },
              { method: 'ppoi_validated_txid', maxRequests: 7 },
              { method: 'ppoi_validate_txid_merkleroot', maxRequests: 7 },
            ],
        disclosureCategories: submitting
          ? base.disclosureCategories
          : [
              'journal-known-transaction',
              'retained-public-proxy-range',
              'current-txid-checkpoint',
              'rpc-destination',
              'network-session-linkability',
              'transaction-linkability',
              'query-timing',
              ...(base.operation === 'transfer' ? ['local-viewing-key-output-check'] : []),
            ],
        uncertaintyCategories: base.uncertaintyCategories,
        requestIdAllocation: base.requestIdAllocation,
        consentGranted: false,
        transportAuthorized: false,
        requestLimitsEnforced: false,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 8192);
      return request;
    };
    await stageRun('review-validation', 30000, 0, async () => {
      assert.equal(
        await review(requestFor('validate-retained-poi'), { signal: state.controller.signal }),
        true
      );
    });
    // This is the ONLY post-review strict capture. Its actual recovery/post-
    // attestation must settle inside display expiry before any network admission.
    await stageRun('post-review', 15000, 0, async (_check, end) => {
      await inspect(state, end, { stage: 'context' });
      assertPreparedRailgunOwnReceipt(prepared.reader, {
        enrollment,
        capture: state.capture,
        destination: prepared.destination,
      });
    });
    senderCurrent();
    assert.ok(performance.now() < state.expiresAt && !state.promoted);
    // Reserve the complete 600s validation and 130s remaining stages before any
    // network work; the original display lifetime must still be current here.
    assert.ok(deadline - performance.now() >= 730000);
    state.promoted = true;
    clearTimeout(state.ttlTimer);
    // The claimed plan never becomes reusable. Only this invocation advances
    // under its original total deadline; reader120s freshness is not renewed.
    const { validateRailgunRetainedPoiForSubmission } = require('./railgun-poi-cold-validation');
    await stageRun('validation', 600000, 130000, async (_check, end) => {
      const validated = await validateRailgunRetainedPoiForSubmission(
        {
          identity,
          enrollment,
          coordinator,
          archive,
          proverArchive,
          artifactDirectory: args.artifactDirectory,
          capsuleDigest: state.capsuleDigest,
          signal: state.controller.signal,
          timeoutMs: Math.max(1, Math.floor(end - performance.now())),
        },
        Object.freeze({
          entry: state.entry,
          capture: state.capture,
          sourceDestination,
          reader: prepared.reader,
          destination: prepared.destination,
        })
      );
      if (validated.status !== 'validated') {
        sourceOutcome = validated.sourceOutcome;
        stage = 'validation:' + validated.stage;
        throw Error('refused');
      }
      senderCurrent();
      assert.equal(validated.capsuleDigest, state.capsuleDigest);
      assert.equal(validated.revision, state.entry.revision);
      assert.equal(validated.payloadSha256, state.entry.payloadSha256);
      for (const key of [
        'outputMatched',
        'proofVerified',
        'independentlyVerified',
        'verifierExitObserved',
        'historicalRootMatchesLocalMirror',
        'ownTxidIncludedBySavedIndex',
        'localMirrorCheckpointMatched',
      ])
        assert.equal(validated[key], true);
      for (const key of [
        'originalRootsAccepted',
        'rootAccepted',
        'disclosureEnabled',
        'spendingEnabled',
      ])
        assert.equal(validated[key], false);
      assert.deepEqual(await state.store.get(state.capsuleDigest), state.entry);
    });
    await stageRun('review-submit', 60000, 70000, async () => {
      assert.equal(
        await review(requestFor('submit-retained-poi'), { signal: state.controller.signal }),
        true
      );
    });
    await stageRun('pre-root', 15000, 55000, async (_check, end) => {
      await inspect(state, end, { stage: 'context' });
    });
    senderCurrent(55000);
    const parent = getPrivacyContext(state.bindings.handle);
    const operation =
      'poi:' +
      createHash('sha256')
        .update(
          JSON.stringify([
            'freedom:railgun:retained-poi-submit-v1',
            randomUUID(),
            state.entry.payloadSha256,
          ])
        )
        .digest('hex');
    postScope = createPrivacyScope({
      profileId: parent.profileId,
      signal: state.controller.signal,
      isCurrent: () => {
        try {
          senderCurrent();
          return true;
        } catch {
          return false;
        }
      },
    });
    postHandle = postScope.getContext({ ...parent.subject, role: 'poi', operation });
    const {
      createRailgunPoiRootSource,
      createRailgunPoiTxidRootSource,
    } = require('./railgun-poi-root');
    const payload = state.entry.payload;
    list = createRailgunPoiRootSource({ handle: postHandle, root: payload.poiMerkleroots[0] });
    txid = createRailgunPoiTxidRootSource({
      handle: postHandle,
      root: payload.txidMerkleroot,
      index: payload.txidMerklerootIndex,
    });
    const acquired = await stageRun('roots', 15000, 40000, async (_check, end) => {
      let failed = false;
      const acquire = async (source) => {
        try {
          return await source.acquire({
            timeoutMs: Math.max(1, Math.floor(end - performance.now())),
          });
        } catch {
          failed = true;
          list.close();
          txid.close();
          throw Error('refused');
        }
      };
      const all = await Promise.allSettled([acquire(list), acquire(txid)]);
      assert.ok(!failed && all.every((value) => value.status === 'fulfilled'));
      return all.map((value) => value.value);
    });
    const assertRoots = (margin) => {
      senderCurrent(margin);
      assert.equal(list.assertResult(acquired[0].receipt, margin), acquired[0].observation);
      assert.equal(txid.assertResult(acquired[1].receipt, margin), acquired[1].observation);
    };
    assertRoots(40000);
    let begun;
    await stageRun('attempt', 15000, 25000, async () => {
      assertRoots(40000);
      // Until a genuine precommit refusal returns, a thrown/lost result may
      // follow persistence. No transport slot exists on that uncertain path.
      possiblyCommitted = true;
      begun = await state.store.beginAttempt({
        capsuleDigest: state.capsuleDigest,
        expectedRevision: state.entry.revision,
        expectedPayloadSha256: state.entry.payloadSha256,
        signal: state.controller.signal,
      });
      if (begun.status === 'refused') possiblyCommitted = false;
      assert.equal(begun.status, 'attempted');
      assertRoots(25000);
    });
    const {
      normalizeRailgunPoiSubmission,
      prepareRailgunPoiSubmission,
      inspectRailgunPoiResponse,
    } = require('./railgun-poi-submit-data');
    let durable;
    const readAttempt = async () => {
      senderCurrent();
      const value = await state.store.get(state.capsuleDigest);
      senderCurrent();
      const submission = prepareRailgunPoiSubmission({ payload, requestId: begun.attemptedAt });
      assert.deepEqual(value, {
        ...state.entry,
        state: 'attempted',
        attempt: { attemptedAt: begun.attemptedAt, submission },
      });
      assert.deepEqual(normalizeRailgunPoiSubmission(value.attempt.submission), submission);
      assert.equal(begun.capsuleDigest, state.capsuleDigest);
      assert.equal(begun.revision, state.entry.revision);
      assert.equal(begun.payloadSha256, state.entry.payloadSha256);
      assert.equal(begun.bodySha256, submission.bodySha256);
      assert.equal(begun.disclosureEnabled, false);
      assert.equal(begun.spendingEnabled, false);
      if (durable) assert.deepEqual(value, durable);
      else durable = snapshot(value);
      return submission;
    };
    await stageRun('readback', 5000, 20000, async () => {
      await readAttempt();
      assertRoots(20000);
    });
    await stageRun('final-account', 20000, 0, async (check, end) => {
      const used = await withRailgunOwnOperationRecovery(
        {
          enrollment,
          selector: state.entry.selector,
          signal: state.controller.signal,
          timeoutMs: Math.max(1, Math.floor(end - performance.now())),
        },
        async (window) => {
          const currentWindow = (margin = 0) => {
            check(margin);
            window.assertCurrent(margin);
            assertRoots(margin);
          };
          currentWindow(12000);
          assertRailgunOwnPoiStableCapture(window.capture, state.capture);
          assertRailgunOwnPoiStableCapture(await window.reattest(), state.capture);
          currentWindow(12000);
          const submission = await readAttempt();
          currentWindow(12000);
          assert.equal(new URL(submission.endpoint).origin, new URL(POI_URL).origin);
          const { createWalletTorTransport } = require('../networks/wallet-tor-transport');
          transport = createWalletTorTransport();
          currentWindow(12000);
          assert.ok(!postUsed);
          postUsed = true;
          stage = 'post';
          try {
            const reply = await transport.request(postHandle, submission.endpoint, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: submission.body,
              signal: state.controller.signal,
              timeoutMs: 10000,
              maxResponseBytes: 2048,
              requireFramedResponse: true,
            });
            response = inspectRailgunPoiResponse({
              submission,
              evidence: { kind: 'response', httpStatus: reply.status, body: reply.body },
            });
          } catch {
            response = inspectRailgunPoiResponse({
              submission,
              evidence: { kind: 'unavailable', reason: 'unavailable' },
            });
          } finally {
            try {
              transport.close();
            } finally {
              await transport.closed;
            }
          }
          currentWindow();
          assertRailgunOwnPoiStableCapture(await window.reattest(), state.capture);
          await readAttempt();
          currentWindow();
          return { checked: true };
        }
      );
      assert.equal(used.status, 'used');
      assert.deepEqual(used.value, { checked: true });
      assertRoots(0);
    });
    stage = 'response';
  } catch {
    // All errors are sanitized; uncertainty is never inferred from a service's
    // error code, and no raw URL, body, ID, root or proof leaves this controller.
  } finally {
    clearTimeout(timer);
    if (state && !protectedBusy) revoke(state.plan);
    for (const value of [prepared, list, txid, postScope, transport]) closeOwned(value);
    await Promise.allSettled([prepared?.closed, list?.closed, txid?.closed, transport?.closed]);
    if (admitted) {
      if (operations.get(state.directory) === state.owner) operations.delete(state.directory);
      state.pending--;
      clean(state);
    }
  }
  return Object.freeze({
    status: possiblyCommitted ? 'recovery-required' : 'refused',
    stage,
    ...(response ? { response } : {}),
    ...(sourceOutcome ? { sourceOutcome } : {}),
  });
}
module.exports = {
  prepareRailgunPoiDisclosurePlan,
  revalidateRailgunPoiDisclosurePlan,
  submitRailgunRetainedPoi,
  claimRailgunAttemptedPoiOutput,
};
