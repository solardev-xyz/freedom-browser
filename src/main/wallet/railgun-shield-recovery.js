/** Restartable public-address recovery; preparation/receiver receipts play no
 * role after the encrypted submission journal has recorded an attempt. Closure
 * waits for admitted work, not physical RPC transport/socket termination.
 */
const { isProxy } = require('util').types;
const { createPrivacyScope, getPrivacyContext } = require('../networks/privacy-context');
const { openPrivacySession } = require('./privacy-session');
const { getPrivateTransactionNetwork } = require('./private-transaction-network');
const { inspectRailgunShieldReceipt } = require('./railgun-shield-receipt');
const { readRailgunRecoveryFinality } = require('./railgun-recovery-finality');
const {
  validRailgunShieldResolution,
  freezeRailgunShieldResolution,
} = require('./railgun-shield-resolution');
const owners = new WeakMap(),
  permits = new WeakMap();
const fail = () =>
  Object.assign(new Error('Railgun shield recovery unavailable'), {
    code: 'RAILGUN_SHIELD_RECOVERY_REFUSED',
  });
const check = (value) => {
  if (!value) throw fail();
};
function openRailgunShieldRecovery(owner, options = {}) {
  try {
    return open(owner, options);
  } catch {
    throw fail();
  }
}
function open(owner, options) {
  check(typeof owner === 'string' && /^0x[0-9a-f]{40}$/.test(owner) && BigInt(owner) > 0n);
  check(options && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
  check(
    Reflect.ownKeys(options).every(
      (key) =>
        ['signal', 'destinationConstraint'].includes(key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(options, key), 'value')
    )
  );
  const { signal, destinationConstraint } = options;
  check(
    signal === undefined || (!isProxy(signal) && signal instanceof AbortSignal && !signal.aborted)
  );
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
    signal: signal === undefined ? parent.signal : AbortSignal.any([parent.signal, signal]),
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
    network = getPrivateTransactionNetwork(
      handle,
      ...(destinationConstraint === undefined ? [] : [{ destinationConstraint }])
    );
  } catch (error) {
    scope.close();
    throw error;
  }
  let busy = false,
    closed = false,
    currentHash = null,
    currentPermit = null,
    resolveClosed;
  const pending = new Set(),
    drained = new Promise((resolve) => (resolveClosed = resolve));
  const finish = () => {
    if (!closed || pending.size) return;
    scope.signal.removeEventListener('abort', close);
    network.signal.removeEventListener('abort', close);
    resolveClosed();
  };
  function close() {
    if (closed) return;
    closed = true;
    currentPermit = null;
    try {
      scope.close();
    } catch {
      // Admission is already revoked; cleanup must remain nonthrowing.
    }
    finish();
  }
  const active = () => {
    try {
      check(!closed && !scope.signal.aborted);
      network.assertActive();
    } catch {
      close();
      throw fail();
    }
  };
  const isCurrent = () => {
    try {
      active();
      return true;
    } catch {
      return false;
    }
  };
  const admit = (use) => {
    try {
      active();
    } catch {
      return Promise.reject(fail());
    }
    let resolve, reject;
    const work = new Promise((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Publish before invoking downstream code, which may close reentrantly.
    pending.add(work);
    const settled = () => {
      pending.delete(work);
      finish();
    };
    work.then(settled, settled);
    try {
      Promise.resolve(use()).then(resolve, () => reject(fail()));
    } catch {
      reject(fail());
    }
    return work;
  };
  scope.signal.addEventListener('abort', close, { once: true });
  network.signal.addEventListener('abort', close, { once: true });
  if (scope.signal.aborted || network.signal.aborted) close();
  active();
  owners.set(handle, {
    active: () => busy && isCurrent(),
    hash: () => currentHash,
    permit: () => currentPermit,
  });
  async function list() {
    active();
    const records = await network.listSubmissions();
    active();
    return Object.freeze(records.filter((r) => r.intent?.kind === 'railgun-native-shield'));
  }
  async function observe(hash) {
    active();
    const record = (await list()).find((r) => r.hash === hash);
    check(record);
    const current = await network.reconcileSubmission(hash);
    active();
    check(current.intent?.digest === record.intent.digest);
    if (current.observation?.status !== 'included')
      return Object.freeze({ record: current, shield: null });
    const { result: transaction } = await network.request(11155111, 'eth_getTransactionByHash', [
      hash,
    ]);
    active();
    const { result: receipt } = await network.request(11155111, 'eth_getTransactionReceipt', [
      hash,
    ]);
    active();
    const shield = inspectRailgunShieldReceipt(current, transaction, receipt);
    check(
      shield.status !== 'matched' ||
        (shield.blockHash === current.observation.blockHash &&
          BigInt(shield.blockNumber) === BigInt(current.observation.blockNumber))
    );
    return Object.freeze({ record: current, shield });
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
      // The network may already have persisted a resolution before its promise
      // settles. Do not replace that successful durable outcome after closure.
      return await network.resolveSubmission(hash, {
        minimumConfirmations,
        reviewTimeoutMs,
        review: (request) => {
          current();
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
                  before.shield?.status === 'matched')
            );
            const finalized = await readRailgunRecoveryFinality(network, before.record, current);
            const decision = await review(
              Object.freeze({ ...request, shield: before.shield, finalized })
            );
            current();
            const after = await inspect(hash);
            check(
              before.record.observation.status === after.record.observation.status &&
                before.record.observation.blockHash === after.record.observation.blockHash &&
                before.record.observation.blockNumber === after.record.observation.blockNumber &&
                JSON.stringify(before.shield) === JSON.stringify(after.shield)
            );
            const final = await readRailgunRecoveryFinality(
              network,
              after.record,
              current,
              finalized
            );
            const details = freezeRailgunShieldResolution({
              outcome: after.shield ? 'matched' : 'reverted',
              finalizedBlockNumber: final.number,
              finalizedBlockHash: final.hash,
              shield: after.shield,
            });
            check(validRailgunShieldResolution(details, after.record));
            current();
            currentPermit = Object.freeze({});
            permits.set(currentPermit, {
              details,
              digest: after.record.intent.digest,
              nonce: after.record.nonce,
              hash,
              at: performance.now(),
              active: () => attemptActive && busy && isCurrent(),
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
    list: () => admit(list),
    observe: (hash) => admit(() => observe(hash)),
    resolve: (hash, options) => admit(() => resolve(hash, options)),
    close,
    closed: drained,
    signal: scope.signal,
  });
}
function assertRailgunShieldResolution(permit, record) {
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
      validRailgunShieldResolution(entry.details, record)
  );
  return entry.details;
}
function authorizeRailgunResolution(handle, record, completed = false) {
  const entry = owners.get(handle);
  check(entry && entry.active() && entry.hash() === record.hash);
  if (!completed) return;
  const permit = entry.permit();
  assertRailgunShieldResolution(permit, record);
  return permit;
}
module.exports = {
  openRailgunShieldRecovery,
  authorizeRailgunResolution,
  assertRailgunShieldResolution,
};
