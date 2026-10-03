/** Read-only RPC comparison step for a detached own-operation capture.
 * The composition must authenticate/rederive the capture before use. This step
 * fetches only a journal-known hash and returns observations, never authority.
 */
const assert = require('assert/strict');
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { getPrivateTransactionNetwork } = require('./private-transaction-network');
const { projectRailgunOwnRecord } = require('./railgun-own-txid');
const { railgunTransactJournalIntent } = require('./railgun-transact-intent');
const { inspectRailgunTransactReceipt } = require('./railgun-transact-receipt');
const { readRailgunRecoveryFinality } = require('./railgun-recovery-finality');
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
async function observeRailgunOwnReceipt({ enrollment, capture, signal, timeoutMs = 60000 } = {}) {
  let stage = 'context',
    scope,
    timer;
  try {
    assert.ok(isRailgunAccountEnrollment(enrollment));
    assert.ok(signal instanceof AbortSignal && !signal.aborted);
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
    const input = copy(capture);
    assert.match(input.bindingDigest, /^[0-9a-f]{64}$/);
    assert.match(input.submitter, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(input.submitter) > 0n);
    const projection = projectRailgunOwnRecord(input.record);
    assert.deepEqual(projection, input.projection);
    assert.deepEqual(
      railgunTransactJournalIntent({ ...input.provedTransaction, from: input.submitter }),
      projection.intent
    );
    const parent = enrollment.getContext('engine');
    const started = performance.now(),
      deadline = started + timeoutMs;
    const wallStarted = new Date().toISOString();
    scope = createPrivacyScope({
      profileId: getPrivacyContext(parent).profileId,
      signal: AbortSignal.any([signal, enrollment.signal]),
      isCurrent: () => {
        getPrivacyContext(parent);
        return true;
      },
    });
    const current = () => {
      getPrivacyContext(parent);
      assert.ok(
        !scope.signal.aborted && performance.now() >= started && performance.now() < deadline
      );
    };
    timer = setTimeout(() => scope.close(), timeoutMs);
    timer.unref?.();
    current();
    const handle = scope.getContext({
      kind: 'public-address',
      principal: input.submitter,
      chainId: 11155111,
      role: 'transaction-rpc',
    });
    const network = getPrivateTransactionNetwork(handle);
    const request = async (method, params) => {
      current();
      const response = await network.request(11155111, method, params);
      current();
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
      current,
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
    const after = await readRailgunRecoveryFinality(finalityNetwork, record, current, before);
    stage = 'inclusion-repeat';
    await checkHeader('inclusion-repeat', included);
    current();
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
    return Object.freeze({ status: 'refused', stage });
  } finally {
    clearTimeout(timer);
    scope?.close();
  }
}
module.exports = { observeRailgunOwnReceipt };
