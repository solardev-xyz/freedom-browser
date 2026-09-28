/**
 * Main-side signing confirmations (security audit O-7).
 *
 * The wallet's approval screens live in the chrome renderer; before this
 * module the signing IPC handlers signed whatever they were handed, so the
 * user's "Confirm" existed only as renderer UI state. Now every signing
 * handler refuses unless it is presented a confirmation token that main
 * issued for exactly the request it is about to sign:
 *
 *   1. When the user confirms an approval screen, the chrome calls
 *      `wallet:confirm-signing` with the request as shown (tx fields, or
 *      the message / typed data). Main canonicalises it, computes a
 *      binding digest and returns a random single-use token.
 *   2. The chrome passes the token to the signing handler with the request.
 *      The handler recomputes the digest from the request it actually
 *      received and signs only if the token exists, has not expired and
 *      its digest matches. The token is burnt on first presentation,
 *      whether or not it matched — a probe can't retry.
 *
 * What a token binds, per kind (see `bindingFor`):
 *   - wallet-send / dapp-send: the signing account (wallet index — the
 *     `from` address is a function of it), chainId, to, value, data and
 *     every gas field (gasLimit, maxFeePerGas, maxPriorityFeePerGas,
 *     gasPrice). A wallet-send binds the account that is active when the
 *     user confirms; switching accounts before the send refuses it.
 *   - sign-message / sign-typed-data: the account and a SHA-256 digest of
 *     the message / typed data (canonical JSON, key order ignored).
 *   - safe-send: the Safe, chainId, to, value, data of the SafeTx.
 *   - safe-message: the Safe and a digest of the dApp's {method, params}.
 *
 * Auto-approved dApp requests carry no token: `wallet-ipc.js` evaluates the
 * stored auto-approve policy in main instead of trusting the renderer's
 * decision.
 */

const crypto = require('crypto');

const CONFIRMATION_TTL_MS = 2 * 60 * 1000;
// A confirmation is minted right before the handler call it authorises, so
// only a handful can ever be outstanding. The cap bounds memory if a
// caller mints without spending.
const MAX_OUTSTANDING = 32;

const KINDS = Object.freeze({
  WALLET_SEND: 'wallet-send',
  DAPP_SEND: 'dapp-send',
  SIGN_MESSAGE: 'sign-message',
  SIGN_TYPED_DATA: 'sign-typed-data',
  SAFE_SEND: 'safe-send',
  SAFE_MESSAGE: 'safe-message',
});

const NOT_CONFIRMED = 'SIGNING_NOT_CONFIRMED';

const outstanding = new Map(); // token -> { kind, digest, expiresAt }
let now = () => Date.now();

function notConfirmed(reason) {
  const err = new Error(`Signing was not confirmed: ${reason}`);
  err.code = NOT_CONFIRMED;
  return err;
}

/** A quantity as a decimal string (hex/decimal/number/bigint in), or null. */
function quantity(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  try {
    const n = BigInt(value);
    if (n < 0n) throw new Error('negative');
    return n.toString();
  } catch {
    throw new Error(`Invalid ${field}`);
  }
}

function address(value, field) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Invalid ${field}`);
  }
  return value.toLowerCase();
}

function hexData(value) {
  if (value === undefined || value === null || value === '' || value === '0x') {
    return '0x';
  }
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error('Invalid data');
  }
  return value.toLowerCase();
}

function index(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function chain(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error('Invalid chainId');
  }
  return n;
}

/** JSON with object keys sorted, so equal values always digest equal. */
function stableStringify(value) {
  if (value === undefined) {
    return 'null';
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function txFields(tx) {
  if (!tx || typeof tx !== 'object') {
    throw new Error('Transaction is required');
  }
  return {
    chainId: chain(tx.chainId),
    to: address(tx.to, 'to'),
    value: quantity(tx.value, 'value') ?? '0',
    data: hexData(tx.data),
    gasLimit: quantity(tx.gasLimit, 'gasLimit'),
    maxFeePerGas: quantity(tx.maxFeePerGas, 'maxFeePerGas'),
    maxPriorityFeePerGas: quantity(tx.maxPriorityFeePerGas, 'maxPriorityFeePerGas'),
    gasPrice: quantity(tx.gasPrice, 'gasPrice'),
  };
}

/**
 * The canonical facts a confirmation of `kind` binds. Used both when the
 * token is issued and when it is spent, so the two can't drift.
 *
 * @param {string} kind - one of KINDS
 * @param {number} accountIndex - wallet index (Safe index for safe-*)
 * @param {*} payload - tx object / message / typed data / {method, params}
 */
function bindingFor(kind, accountIndex, payload) {
  switch (kind) {
    case KINDS.WALLET_SEND:
    case KINDS.DAPP_SEND:
      return { walletIndex: index(accountIndex, 'wallet index'), ...txFields(payload) };
    case KINDS.SIGN_MESSAGE:
    case KINDS.SIGN_TYPED_DATA:
      if (payload === undefined || payload === null || payload === '') {
        throw new Error(kind === KINDS.SIGN_MESSAGE ? 'Message is required' : 'Typed data is required');
      }
      return {
        walletIndex: index(accountIndex, 'wallet index'),
        payloadHash: sha256(stableStringify(payload)),
      };
    case KINDS.SAFE_SEND: {
      const tx = payload?.tx;
      if (!tx || typeof tx !== 'object') {
        throw new Error('Transaction is required');
      }
      return {
        safeIndex: index(accountIndex, 'Safe index'),
        chainId: chain(payload.chainId),
        to: address(tx.to, 'to'),
        value: quantity(tx.value, 'value') ?? '0',
        data: hexData(tx.data),
      };
    }
    case KINDS.SAFE_MESSAGE:
      if (!payload || typeof payload.method !== 'string' || !Array.isArray(payload.params)) {
        throw new Error('Signature request is required');
      }
      return {
        safeIndex: index(accountIndex, 'Safe index'),
        method: payload.method,
        payloadHash: sha256(stableStringify(payload.params)),
      };
    default:
      throw new Error(`Unknown confirmation kind: ${kind}`);
  }
}

function digestFor(kind, accountIndex, payload) {
  return sha256(stableStringify({ kind, ...bindingFor(kind, accountIndex, payload) }));
}

function pruneExpired() {
  const t = now();
  for (const [token, entry] of outstanding) {
    if (entry.expiresAt <= t) outstanding.delete(token);
  }
}

/**
 * Issue a single-use confirmation token for exactly this request.
 * Throws on a malformed request (nothing is issued).
 *
 * @returns {{token: string, expiresAt: number}}
 */
function issueConfirmation(kind, accountIndex, payload) {
  const digest = digestFor(kind, accountIndex, payload);
  pruneExpired();
  while (outstanding.size >= MAX_OUTSTANDING) {
    // Map iteration order is insertion order: drop the oldest.
    outstanding.delete(outstanding.keys().next().value);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = now() + CONFIRMATION_TTL_MS;
  outstanding.set(token, { kind, digest, expiresAt });
  return { token, expiresAt };
}

/**
 * Spend a confirmation token for the request about to be signed. Burns the
 * token on every presentation. Throws (code SIGNING_NOT_CONFIRMED) unless
 * the token was issued for this kind and this exact request and has not
 * expired.
 */
function consumeConfirmation(token, kind, accountIndex, payload) {
  if (typeof token !== 'string' || token.length === 0) {
    throw notConfirmed('no confirmation token');
  }
  const entry = outstanding.get(token);
  outstanding.delete(token);
  if (!entry) {
    throw notConfirmed('unknown or already used confirmation');
  }
  if (entry.expiresAt <= now()) {
    throw notConfirmed('confirmation expired');
  }
  let digest;
  try {
    digest = digestFor(kind, accountIndex, payload);
  } catch (err) {
    throw notConfirmed(err.message);
  }
  if (entry.kind !== kind || entry.digest !== digest) {
    throw notConfirmed('request differs from what was confirmed');
  }
}

function _reset() {
  outstanding.clear();
  now = () => Date.now();
}

function _setNow(fn) {
  now = fn;
}

function _outstandingCount() {
  return outstanding.size;
}

module.exports = {
  CONFIRMATION_TTL_MS,
  MAX_OUTSTANDING,
  KINDS,
  NOT_CONFIRMED,
  bindingFor,
  issueConfirmation,
  consumeConfirmation,
  _reset,
  _setNow,
  _outstandingCount,
};
