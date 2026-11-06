/**
 * A phone account's payment, checked against the one the user confirmed
 * (freedom-core design 0012, PHN-1 and PHN-2, "Unverified payments"). Main
 * does it until the core takes the check over.
 *
 * The phone signs and broadcasts the payment itself and reports its hash.
 * The job bound the account, `to`, `value`, `data` and the chain. Main
 * compares the reported transaction with those fields once its own RPC
 * shows it: at the answer (transaction-service.js), or later, from the
 * record kept in the payment's history row (tx-recorder.js), so a restart
 * loses no check. Until then the payment is unverified, never confirmed.
 *
 * `data` is kept as its length and SHA-256, never its bytes: comparing by
 * them is as strict as comparing the bytes. A transaction with no chain id
 * (pre-EIP-155) differs: its signature is valid on every chain, so it is
 * not bound to the one confirmed.
 *
 * The age comes first: a record waits only while
 * `answeredAt <= now < answeredAt + CHECK_WINDOW_MS` on the wall clock.
 * Past that, or under a clock set before the answer, it ends unknown, never
 * verified.
 */

const crypto = require('crypto');
const chainData = require('../networks/chain-data');
const { REMOTE_ERROR_CODES } = require('./remote/errors');

// A day of the wall clock, from the answer.
const CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
// Rechecked after 5 s, then at doubling intervals up to every 10 minutes.
const FIRST_RECHECK_MS = 5_000;
const MAX_RECHECK_MS = 10 * 60 * 1000;

/** A quantity (0x-hex or decimal string, number or bigint) as a BigInt, or null. None is 0. */
function quantityOf(value) {
  if (value === undefined || value === null || value === '') return 0n;
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Calldata as lowercase hex: none is `0x`. Null for anything else. */
function calldataOf(data) {
  if (data === undefined || data === null || data === '') return '0x';
  return typeof data === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(data) ? data.toLowerCase() : null;
}

/** Calldata as its length in bytes and its SHA-256 (hex); both null when it isn't hex. */
function digestOf(data) {
  const calldata = calldataOf(data);
  if (calldata === null) return { dataLength: null, dataSha256: null };
  const bytes = Buffer.from(calldata.slice(2), 'hex');
  return {
    dataLength: bytes.length,
    dataSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null);
const decimal = (value) => {
  const quantity = quantityOf(value);
  return quantity === null ? null : quantity.toString(10);
};

/**
 * What a phone payment was confirmed for, as its record keeps it: the
 * account, `to`, `value` and the chain as decimal strings, `data` by its
 * length and SHA-256. A field main can't read is null, and never matches.
 *
 * @param {{from: string, to: string, value?: *, data?: string, chainId: number}} job
 */
function boundFieldsOf({ from, to, value, data, chainId }) {
  return {
    from: lower(from),
    to: lower(to),
    value: decimal(value),
    ...digestOf(data),
    chainId: chainId === undefined || chainId === null ? null : decimal(chainId),
  };
}

/**
 * A transaction as main's RPC shows it, in the record's form. A missing
 * chain id stays null, so it never matches.
 *
 * @param {object} tx - eth_getTransactionByHash's result
 */
function observedFieldsOf(tx) {
  return {
    from: lower(tx.from),
    to: lower(tx.to),
    value: decimal(tx.value),
    ...digestOf(tx.input ?? tx.data),
    chainId: tx.chainId === undefined || tx.chainId === null ? null : decimal(tx.chainId),
  };
}

/**
 * How a visible transaction differs from a payment's bound fields: null
 * when it is the one confirmed; REMOTE_WRONG_ACCOUNT when another account
 * sent it; REMOTE_WRONG_TRANSACTION when its recipient, amount, data or
 * chain differs (a contract creation, or no chain id, included). The phone
 * picks its own nonce, gas and fees, so those aren't compared.
 *
 * @param {object} tx - eth_getTransactionByHash's result
 * @param {object} bound - boundFieldsOf's record
 * @returns {string|null}
 */
function differenceOf(tx, bound) {
  const seen = observedFieldsOf(tx);
  const same = (field) => bound[field] !== null && seen[field] === bound[field];
  if (!same('from')) return REMOTE_ERROR_CODES.WRONG_ACCOUNT;
  const sameTransaction =
    same('to') && same('value') && same('dataLength') && same('dataSha256') && same('chainId');
  return sameTransaction ? null : REMOTE_ERROR_CODES.WRONG_TRANSACTION;
}

/** Main's RPC's view of a transaction on a chain: the transaction, or null when not visible. Throws as chain-data does. */
async function lookUp(hash, chainId) {
  const { result } = await chainData.request(chainId, 'eth_getTransactionByHash', [hash]);
  return result ?? null;
}

/** Whether a record still waits for its check at `now` (wall-clock ms). */
function withinWindow(record, now) {
  const answeredAt = record?.answeredAt;
  return Number.isFinite(answeredAt) && answeredAt <= now && now < answeredAt + CHECK_WINDOW_MS;
}

/**
 * One later check of an unverified payment: its age first, then main's RPC.
 *
 * @param {string} hash - the hash the phone reported
 * @param {object} record - the bound fields and `answeredAt` (ms)
 * @param {number} chainId - the chain to read, the job's
 * @param {number} now - the wall clock, ms
 * @returns {Promise<{state: 'verified'} | {state: 'mismatch', code: string, observed: object}
 *   | {state: 'unknown'} | {state: 'unverified', error?: string}>}
 */
async function recheck(hash, record, chainId, now) {
  if (!withinWindow(record, now)) return { state: 'unknown' };
  let tx;
  try {
    tx = await lookUp(hash, chainId);
  } catch (err) {
    return { state: 'unverified', error: err.message };
  }
  if (!tx) return { state: 'unverified' };
  const code = differenceOf(tx, record);
  if (code === null) return { state: 'verified' };
  return { state: 'mismatch', code, observed: observedFieldsOf(tx) };
}

/**
 * How long to wait before the next recheck, after waiting `previous` ms
 * (none yet: FIRST_RECHECK_MS): double, at most MAX_RECHECK_MS, and never
 * past the end of the record's window, so it ends on time.
 */
function nextRecheckIn(record, previous, now) {
  const wait = previous ? Math.min(previous * 2, MAX_RECHECK_MS) : FIRST_RECHECK_MS;
  const left = Number.isFinite(record?.answeredAt) ? record.answeredAt + CHECK_WINDOW_MS - now : 0;
  return Math.max(0, Math.min(wait, left));
}

module.exports = {
  CHECK_WINDOW_MS,
  FIRST_RECHECK_MS,
  MAX_RECHECK_MS,
  boundFieldsOf,
  observedFieldsOf,
  differenceOf,
  lookUp,
  withinWindow,
  recheck,
  nextRecheckIn,
};
