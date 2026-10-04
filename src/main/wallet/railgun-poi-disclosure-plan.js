/** Genuine main-owned review inventory, not consent or a transport permit.
 * Registered coordinator policy is checked, not a pinned engine archive. No
 * selector derivation, utility, service query or logical intent mutation.
 * Existing encrypted-store opens retain normal lease/floor/key housekeeping.
 */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const { getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const {
  assertRailgunAccountPublic,
  getRailgunAccountPublicIdentity,
} = require('./railgun-account-public');
const { withRailgunOwnOperationRecovery } = require('./railgun-own-operation');
const { assertRailgunOwnPoiCapture } = require('./railgun-own-poi-binding');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const plans = new WeakMap(),
  live = new Map(),
  operations = new Map();
const TTL_MS = 120000;
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
function current(state, deadline) {
  assert.ok(!state.revoked && !state.controller.signal.aborted);
  const now = performance.now();
  assert.ok(
    Number.isFinite(now) && now >= state.lastNow && now < state.expiresAt && now < deadline
  );
  state.lastNow = now;
  const b = state.bindings;
  for (const signal of [b.identity.signal, b.enrollment.signal, b.coordinator.signal])
    assert.ok(!signal.aborted);
  assert.equal(b.enrollment.directory, state.directory);
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
  if (state.store) assert.ok(!state.store.signal.aborted);
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
    endpoint: 'https://ppoi.fdi.network',
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
    const left = Math.floor(Math.min(deadline, state.expiresAt) - performance.now());
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
module.exports = { prepareRailgunPoiDisclosurePlan, revalidateRailgunPoiDisclosurePlan };
