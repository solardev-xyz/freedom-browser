/** Restartable own-hash private transaction recovery from the EOA journal.
 * Resolution never releases a private signing hold or authorizes replay.
 */
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const { getPrivateTransactionNetwork } = require('./private-transaction-network');
const { inspectRailgunTransactReceipt } = require('./railgun-transact-receipt');
const { readRailgunRecoveryFinality } = require('./railgun-recovery-finality');
const {
  validRailgunTransactResolution,
  freezeRailgunTransactResolution,
} = require('./railgun-transact-resolution');
const owners = new WeakMap(),
  permits = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun transact recovery unavailable'), {
    code: 'RAILGUN_TRANSACT_RECOVERY_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
function openRailgunTransactRecovery(owner) {
  check(typeof owner === 'string' && /^0x[0-9a-f]{40}$/.test(owner) && BigInt(owner) > 0n);
  const parent = openPrivacySession();
  const subject = {
    kind: 'public-address',
    principal: owner,
    chainId: 11155111,
    role: 'transaction-rpc',
  };
  const parentHandle = parent.getContext(subject);
  const scope = createPrivacyScope({
    profileId: getPrivacyContext(parentHandle).profileId,
    signal: parent.signal,
    isCurrent: () => {
      try {
        getPrivacyContext(parentHandle);
        return true;
      } catch {
        return false;
      }
    },
  });
  const handle = scope.getContext(subject);
  let network;
  try {
    network = getPrivateTransactionNetwork(handle);
  } catch (error) {
    scope.close();
    throw error;
  }
  let busy = false,
    currentHash = null,
    currentPermit = null;
  owners.set(handle, {
    active: () => busy && !scope.signal.aborted,
    hash: () => currentHash,
    permit: () => currentPermit,
  });
  const active = () => network.assertActive();
  async function list() {
    active();
    const records = await network.listSubmissions();
    active();
    return Object.freeze(records.filter((r) => r.intent?.kind === 'railgun-transact'));
  }
  async function observe(hash) {
    active();
    const record = (await list()).find((r) => r.hash === hash);
    check(record);
    const current = await network.reconcileSubmission(hash);
    active();
    check(current.intent?.digest === record.intent.digest);
    if (current.observation?.status !== 'included')
      return Object.freeze({ record: current, transact: null });
    const { result: transaction } = await network.request(11155111, 'eth_getTransactionByHash', [
      hash,
    ]);
    const { result: receipt } = await network.request(11155111, 'eth_getTransactionReceipt', [
      hash,
    ]);
    active();
    const transact = inspectRailgunTransactReceipt(current, transaction, receipt);
    check(
      transact.status !== 'matched' ||
        (transact.blockHash === current.observation.blockHash &&
          BigInt(transact.blockNumber) === BigInt(current.observation.blockNumber))
    );
    return Object.freeze({ record: current, transact });
  }
  async function resolve(hash, { minimumConfirmations, review, reviewTimeoutMs = 120000 } = {}) {
    check(
      !busy &&
        Number.isSafeInteger(minimumConfirmations) &&
        minimumConfirmations >= 3 &&
        typeof review === 'function' &&
        Number.isSafeInteger(reviewTimeoutMs) &&
        reviewTimeoutMs > 0 &&
        reviewTimeoutMs <= 120000
    );
    busy = true;
    currentHash = hash;
    let attemptActive = true,
      callback;
    const current = () => {
      check(attemptActive);
      active();
    };
    const inspect = async (hash) => {
      current();
      const value = await observe(hash);
      current();
      return value;
    };
    try {
      return await network.resolveSubmission(hash, {
        minimumConfirmations,
        reviewTimeoutMs,
        review: (request) => {
          check(!callback);
          callback = (async () => {
            const before = await inspect(hash);
            check(
              before.record.observation.status === request.observation.status &&
                before.record.observation.blockHash === request.observation.blockHash &&
                before.record.observation.blockNumber === request.observation.blockNumber
            );
            // A nonce-consumed observation cannot identify the mined candidate;
            // a success without its note is also unresolved. Neither grants retry.
            check(
              before.record.observation.status === 'reverted' ||
                (before.record.observation.status === 'included' &&
                  before.transact?.status === 'matched')
            );
            const finalized = await readRailgunRecoveryFinality(network, before.record, current);
            const decision = await review(
              Object.freeze({ ...request, transact: before.transact, finalized })
            );
            current();
            const after = await inspect(hash);
            check(
              before.record.observation.status === after.record.observation.status &&
                before.record.observation.blockHash === after.record.observation.blockHash &&
                before.record.observation.blockNumber === after.record.observation.blockNumber &&
                JSON.stringify(before.transact) === JSON.stringify(after.transact)
            );
            const final = await readRailgunRecoveryFinality(
              network,
              after.record,
              current,
              finalized
            );
            const details = freezeRailgunTransactResolution({
              outcome: after.transact ? 'matched' : 'reverted',
              finalizedBlockNumber: final.number,
              finalizedBlockHash: final.hash,
              transact: after.transact,
            });
            check(validRailgunTransactResolution(details, after.record));
            currentPermit = Object.freeze({});
            permits.set(currentPermit, {
              details,
              digest: after.record.intent.digest,
              nonce: after.record.nonce,
              hash,
              at: performance.now(),
              active: () => attemptActive && busy && !scope.signal.aborted,
            });
            return decision;
          })();
          return callback;
        },
      });
    } finally {
      attemptActive = false;
      if (callback) await Promise.allSettled([callback]);
      busy = false;
      currentHash = currentPermit = null;
    }
  }
  return Object.freeze({
    list,
    observe,
    resolve,
    close: () => scope.close(),
    signal: scope.signal,
  });
}
function assertRailgunTransactResolution(permit, record) {
  const entry = permits.get(permit),
    now = performance.now();
  check(
    entry &&
      entry.active() &&
      entry.hash === record.hash &&
      entry.digest === record.intent?.digest &&
      entry.nonce === record.nonce &&
      now >= entry.at &&
      now - entry.at < 60000 &&
      validRailgunTransactResolution(entry.details, record)
  );
  return entry.details;
}
function authorizeRailgunResolution(handle, record, completed = false) {
  const entry = owners.get(handle);
  check(entry && entry.active() && entry.hash() === record.hash);
  if (!completed) return;
  const permit = entry.permit();
  assertRailgunTransactResolution(permit, record);
  return permit;
}
module.exports = {
  openRailgunTransactRecovery,
  authorizeRailgunResolution,
  assertRailgunTransactResolution,
};
