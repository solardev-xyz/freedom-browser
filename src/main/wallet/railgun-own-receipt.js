/** Read-only RPC comparison step for a detached own-operation capture.
 * The composition must authenticate/rederive the capture before use. This step
 * fetches only a journal-known hash and returns observations, never authority.
 * Prepared readers retain one destination/client, not consent or an authenticated
 * capture. Their opaque destination requires an explicit trusted-main accessor.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const {
  getPrivateTransactionNetwork,
  getPrivateTransactionNetworkDestination,
  assertPrivateTransactionNetworkDestination,
} = require('./private-transaction-network');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const { inspectRailgunTransactReceipt } = require('./railgun-transact-receipt');
const { readRailgunRecoveryFinality } = require('./railgun-recovery-finality');
const readers = new WeakMap();
const PREPARED_MS = 120000,
  OPERATION_MS = 60000;
const refused = (stage = 'context') => Object.freeze({ status: 'refused', stage });
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function copy(value, max = 128 * 1024) {
  const text = JSON.stringify(value);
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= max);
  return JSON.parse(text);
}
function options(value, required, optional = []) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  const keys = Reflect.ownKeys(value);
  assert.ok(required.every((key) => keys.includes(key)));
  assert.ok(keys.every((key) => [...required, ...optional].includes(key)));
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
  readers.delete(state.reader);
  state.input = null;
  state.projection = null;
  state.network = null;
  state.destination = null;
  state.handle = null;
  state.parent = null;
  state.scope = null;
  state.resolveClosed();
}
function revoke(reader) {
  const state = readers.get(reader);
  if (!state || state.revoked) return;
  state.revoked = true;
  clearTimeout(state.timer);
  state.scope.signal.removeEventListener('abort', state.onAbort);
  state.network.signal.removeEventListener('abort', state.onAbort);
  state.scope.close();
  clean(state);
}
// Returned methods retain only the opaque reader, not the private capture.
function closeReader(reader) {
  return () => revoke(reader);
}
function readerScope(parent, signal, enrollmentSignal) {
  return createPrivacyScope({
    profileId: getPrivacyContext(parent).profileId,
    signal: AbortSignal.any([signal, enrollmentSignal]),
    isCurrent: () => {
      getPrivacyContext(parent);
      return true;
    },
  });
}
function current(state) {
  const now = performance.now();
  if (
    state.revoked ||
    !Number.isFinite(now) ||
    !Number.isFinite(state.preparedAt) ||
    now < state.preparedAt ||
    now >= state.expiresAt ||
    (state.claimed && (now < state.started || now >= state.deadline))
  ) {
    revoke(state.reader);
    throw Error('refused');
  }
  try {
    assert.ok(!state.scope.signal.aborted);
    getPrivacyContext(state.parent);
    assertPrivateTransactionNetworkDestination(state.network, state.handle, state.destination);
    assert.ok(!state.revoked && !state.scope.signal.aborted);
  } catch {
    revoke(state.reader);
    throw Error('refused');
  }
}
function prepareRailgunOwnReceiptReader(value) {
  let scope, reader;
  try {
    // Include preparation in the nonrenewing lifetime, even though it does no
    // network/storage work and normally completes synchronously.
    const preparedAt = performance.now();
    const {
      enrollment,
      capture,
      signal,
      timeoutMs = PREPARED_MS,
    } = options(value, ['enrollment', 'capture', 'signal'], ['timeoutMs']);
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= PREPARED_MS);
    const input = freeze(copy(capture));
    assert.match(input.bindingDigest, /^[0-9a-f]{64}$/);
    assert.match(input.submitter, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(input.submitter) > 0n);
    const projection = freeze(projectRailgunOwnRecord(input.record));
    assert.deepEqual(projection, input.projection);
    assert.deepEqual(
      railgunTransactJournalIntent({ ...input.provedTransaction, from: input.submitter }),
      projection.intent
    );
    const parent = enrollment.getContext('engine');
    scope = readerScope(parent, signal, enrollment.signal);
    const handle = scope.getContext({
      kind: 'public-address',
      principal: input.submitter,
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const network = getPrivateTransactionNetwork(handle);
    const destination = getPrivateTransactionNetworkDestination(network, handle);
    assert.ok(network.signal instanceof AbortSignal && !network.signal.aborted);
    reader = Object.freeze({});
    let resolveClosed;
    const closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    const state = {
      reader,
      input,
      projection,
      parent,
      scope,
      handle,
      network,
      destination,
      preparedAt,
      expiresAt: preparedAt + timeoutMs,
      claimed: false,
      revoked: false,
      pending: false,
      resolveClosed,
      onAbort: closeReader(reader),
    };
    readers.set(reader, state);
    scope.signal.addEventListener('abort', state.onAbort, { once: true });
    network.signal.addEventListener('abort', state.onAbort, { once: true });
    current(state);
    state.timer = setTimeout(state.onAbort, Math.max(1, state.expiresAt - performance.now()));
    state.timer.unref?.();
    current(state);
    return Object.freeze({
      status: 'prepared',
      reader,
      destination,
      signal: scope.signal,
      close: closeReader(reader),
      // Logical operation drain only, not terminal closure of the shared
      // private-RPC transport or every pooled physical socket.
      closed,
      accountAuthenticated: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    });
  } catch {
    if (reader) revoke(reader);
    else scope?.close();
    return refused();
  }
}

// Non-async admission synchronously claims a genuine reader before scheduling
// any work. Bad/overlapping calls cannot revoke an already admitted operation.
function observePreparedRailgunOwnReceipt(reader, value = {}) {
  let state,
    admitted = false;
  try {
    const { timeoutMs = OPERATION_MS } = options(value, [], ['timeoutMs']);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= OPERATION_MS);
    state = readers.get(reader);
    assert.ok(state && !state.claimed);
    current(state);
    state.claimed = true;
    state.pending = true;
    admitted = true;
    state.started = performance.now();
    state.wallStarted = new Date().toISOString();
    state.deadline = Math.min(state.expiresAt, state.started + timeoutMs);
    clearTimeout(state.timer);
    state.timer = setTimeout(state.onAbort, Math.max(1, state.deadline - performance.now()));
    state.timer.unref?.();
  } catch {
    if (admitted) {
      revoke(reader);
      state.pending = false;
      clean(state);
    }
    return Promise.resolve(refused());
  }
  return Promise.resolve()
    .then(() => observe(state))
    .finally(() => {
      revoke(reader);
      state.pending = false;
      clean(state);
    });
}

async function observe(state) {
  let stage = 'context';
  try {
    const { input, projection, network, started, wallStarted } = state;
    const assertCurrent = () => current(state);
    assertCurrent();
    const request = async (method, params) => {
      assertCurrent();
      const response = await network.request(11155111, method, params);
      assertCurrent();
      return copy(response.result);
    };
    stage = 'transaction';
    const transaction = await request('eth_getTransactionByHash', [projection.hash]);
    stage = 'receipt';
    const receipt = await request('eth_getTransactionReceipt', [projection.hash]);
    // Bound this triple; downstream source/verifier checks include additional data.
    copy({ record: input.record, transaction, receipt });
    stage = 'receipt-match';
    const outcome = inspectRailgunTransactReceipt(input.record, transaction, receipt);
    assert.equal(outcome.status, 'matched');
    assert.deepEqual(outcome, projection.railgun.transact);
    const oldFinalized = {
      number: projection.railgun.finalizedBlockNumber,
      hash: projection.railgun.finalizedBlockHash,
    };
    const archiveAnchor = Object.hasOwn(input.record, 'archivedAt')
      ? { number: input.record.finalized.blockNumber, hash: input.record.finalized.blockHash }
      : null;
    const record = {
      observation: { blockNumber: projection.blockNumber, blockHash: projection.blockHash },
    };
    const finalityNetwork = {
      request: async (_chain, method, params) => ({ result: await request(method, params) }),
    };
    const anchorsActuallyChecked = [];
    const checkHeader = async (kind, point) => {
      const header = await request('eth_getBlockByNumber', [
        '0x' + point.number.toString(16),
        false,
      ]);
      assert.equal(BigInt(header.number), BigInt(point.number));
      assert.equal(header.hash, point.hash);
      anchorsActuallyChecked.push({
        kind,
        ...point,
        observedMonotonicMs: performance.now(),
        observedAt: new Date().toISOString(),
      });
      return { number: point.number, hash: point.hash };
    };
    stage = 'finality-before';
    const before = await readRailgunRecoveryFinality(
      finalityNetwork,
      record,
      assertCurrent,
      oldFinalized
    );
    stage = 'inclusion';
    const included = await checkHeader('inclusion', {
      number: projection.blockNumber,
      hash: projection.blockHash,
    });
    stage = 'resolution-anchor';
    await checkHeader('resolution', oldFinalized);
    if (archiveAnchor) {
      stage = 'archive-anchor';
      assert.ok(before.number >= archiveAnchor.number);
      await checkHeader('archive', archiveAnchor);
    }
    stage = 'finality-after';
    const after = await readRailgunRecoveryFinality(finalityNetwork, record, assertCurrent, before);
    stage = 'inclusion-repeat';
    await checkHeader('inclusion-repeat', included);
    assertCurrent();
    return freeze({
      status: 'observed',
      observation: {
        captureBindingDigest: input.bindingDigest,
        transaction,
        receipt,
        included,
        oldFinalized,
        finalizedBefore: before,
        finalizedAfter: after,
        capturedRepresentation: archiveAnchor ? 'archived' : 'active',
        archiveAnchor,
        anchorsActuallyChecked,
        startedMonotonicMs: started,
        completedMonotonicMs: performance.now(),
        startedAt: wallStarted,
        completedAt: new Date().toISOString(),
        receiptMatched: true,
        rpcConsistencyObserved: true,
        trust: 'unverified-rpc',
        accountAuthenticated: false,
        sourceAuthenticated: false,
        currentCanonicalityVerified: false,
        finalityVerified: false,
        txidPathVerified: false,
        txidRootAccepted: false,
        poiVerified: false,
        spendingEnabled: false,
      },
    });
  } catch {
    return refused(stage);
  }
}

async function observeRailgunOwnReceipt({
  enrollment,
  capture,
  signal,
  timeoutMs = OPERATION_MS,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > OPERATION_MS)
    return refused();
  // The same absolute preparation deadline bounds this whole compatibility
  // wrapper; claiming cannot add another operation-length window.
  const prepared = prepareRailgunOwnReceiptReader({ enrollment, capture, signal, timeoutMs });
  if (prepared.status !== 'prepared') return prepared;
  return observePreparedRailgunOwnReceipt(prepared.reader, { timeoutMs });
}
module.exports = {
  observeRailgunOwnReceipt,
  prepareRailgunOwnReceiptReader,
  observePreparedRailgunOwnReceipt,
};
