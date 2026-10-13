/**
 * Nonce reservations (freedom-core design 0005, "Retrying an intent").
 *
 * Main picks the nonce of every send it signs, with a vault key or a Ledger
 * device. Two sends from one account must never share a nonce, and a new
 * intent must never take a nonce that a held intent still has. So each
 * account, `(chainId, sender)`, has one lock, and a new intent's nonce is
 * chosen and committed under it:
 *
 *   lock → nonce = max(pending, highest held nonce + 1) → build, sign (a
 *   device approval included) and commit the intent → release
 *
 * - **The key** is the address, not the wallet index: two indexes that
 *   resolve to one address share a lock.
 * - **A failure before the commit** (the user rejected it on the device, the
 *   vault locked, the commit's write failed) releases the reservation with
 *   nothing recorded, so the next send gets the same nonce.
 * - **Waiters** give up after WAIT_TIMEOUT_MS. The holder is never cut short:
 *   it may be waiting for the user to approve on a device.
 * - **Send again and replacements** keep their intent's nonce: they take the
 *   lock with `withAccountLock` and never read `pending`. So does voiding,
 *   which needs the lock's token (intent-store.js).
 */

const WAIT_TIMEOUT_MS = 3 * 60 * 1000;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

// Account key → its lock's queue of waiters. An account is in the map while
// its lock is held.
const locks = new Map();
// Token → account key, for exactly as long as the token's lock is held.
const liveTokens = new WeakMap();

function accountKey(chainId, sender) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new TypeError(`Invalid chain id: ${chainId}`);
  }
  if (typeof sender !== 'string' || !ADDRESS_PATTERN.test(sender)) {
    throw new TypeError('Invalid sender address');
  }
  return `${chainId}:${sender.toLowerCase()}`;
}

function lockTimeoutError() {
  const error = new Error('Another transaction from this account is waiting for approval.');
  error.code = 'NONCE_LOCK_TIMEOUT';
  return error;
}

function acquire(key, waitMs) {
  const lock = locks.get(key);
  if (!lock) {
    locks.set(key, { waiters: [] });
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const index = lock.waiters.indexOf(waiter);
      if (index !== -1) lock.waiters.splice(index, 1);
      reject(lockTimeoutError());
    }, waitMs);
    waiter.timer.unref?.();
    lock.waiters.push(waiter);
  });
}

// Hands the lock straight to the first waiter, so no newcomer can take it
// in between.
function release(key) {
  const next = locks.get(key).waiters.shift();
  if (!next) {
    locks.delete(key);
    return;
  }
  clearTimeout(next.timer);
  next.resolve();
}

/**
 * Run `fn` holding the account's lock, and release it when `fn` settles.
 *
 * @template T
 * @param {{ chainId: number, sender: string, waitMs?: number }} account
 * @param {(lock: object) => Promise<T>|T} fn receives the lock's token,
 *   valid until `fn` settles (see holdsAccountLock)
 * @returns {Promise<T>}
 */
async function withAccountLock({ chainId, sender, waitMs = WAIT_TIMEOUT_MS }, fn) {
  const key = accountKey(chainId, sender);
  if (!(waitMs > 0)) throw new TypeError(`Invalid lock wait: ${waitMs}`);
  await acquire(key, waitMs);
  const lock = Object.freeze({ chainId, sender: sender.toLowerCase() });
  liveTokens.set(lock, key);
  try {
    return await fn(lock);
  } finally {
    liveTokens.delete(lock);
    release(key);
  }
}

/** Whether `lock` is a token of the account's lock, and that lock is held. */
function holdsAccountLock(lock, chainId, sender) {
  if (!lock || typeof lock !== 'object') return false;
  try {
    return liveTokens.get(lock) === accountKey(chainId, sender);
  } catch {
    return false;
  }
}

function toNonce(value) {
  let nonce;
  try {
    nonce = typeof value === 'number' ? value : Number(BigInt(value));
  } catch {
    nonce = NaN;
  }
  if (!Number.isSafeInteger(nonce) || nonce < 0) {
    throw new Error(`Invalid pending transaction count: ${value}`);
  }
  return nonce;
}

/**
 * Reserve the account's next nonce for a new intent, and run `fn` with it
 * under the account's lock. `fn` builds, signs and commits the intent; the
 * reservation ends when it settles.
 *
 * @template T
 * @param {object} options
 * @param {number} options.chainId
 * @param {string} options.sender
 * @param {() => Promise<number|bigint|string>} options.readPending the
 *   account's `pending` transaction count
 * @param {{ ready?: Promise<unknown>, heldNonces: (chainId: number, sender: string) => number[] }} options.store
 *   the intent store
 * @param {number} [options.waitMs]
 * @param {(nonce: number, lock: object) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function reserve({ chainId, sender, readPending, store, waitMs }, fn) {
  return withAccountLock({ chainId, sender, waitMs }, async (lock) => {
    await store.ready;
    const pending = toNonce(await readPending());
    const floor = store.heldNonces(chainId, sender).reduce((max, n) => Math.max(max, n + 1), 0);
    return fn(Math.max(pending, floor), lock);
  });
}

module.exports = {
  WAIT_TIMEOUT_MS,
  accountKey,
  holdsAccountLock,
  reserve,
  withAccountLock,
};
