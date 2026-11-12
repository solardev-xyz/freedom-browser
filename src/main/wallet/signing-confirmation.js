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
 *     user confirms; switching accounts before the send refuses it. A
 *     dapp-send also binds the site it is for (`origin`, as a permission
 *     key), which it must have: the payment is recorded under it, and
 *     "Always allow" pauses for that site while the payment waits.
 *   - sign-message / sign-typed-data: the account and a SHA-256 digest of
 *     the message / typed data (canonical JSON, key order ignored). A
 *     sign-typed-data token also carries the EIP-712 hash of the data, as
 *     the identity core computed it when the user confirmed (freedom-core
 *     #88): spending the token hands it back, and a vault account's
 *     signature passes it to the core as `expected_hash`, so the core signs
 *     nothing but the confirmed digest.
 *   - safe-send: the Safe, chainId, to, value, data of the SafeTx, and the
 *     site a dApp's SafeTx is for (`origin`, as a permission key), or none
 *     for the wallet's own: adding, removing or changing it refuses.
 *   - safe-message: the Safe and a digest of the dApp's {method, params}.
 *   - intent-resend: one held wallet intent as the user saw it: its id,
 *     chainId, sender, nonce and the hash of the signed bytes to be sent
 *     again. Nothing is signed; the handler builds the binding from main's
 *     own record of the intent, never from fields the caller submits
 *     (`wallet:intent-resend`).
 *   - executor-send: a transaction main sends on its own account's behalf
 *     (a Safe's execution or activation, paid by its executor) whose fee
 *     the fee check stopped for the user (design 0005, A): the executor's
 *     wallet index, chainId, to, value, data, the gas limit and the fees
 *     shown. Main signs it with exactly those fees, or not at all.
 *   - intent-replace: a held intent signed again at its nonce with new
 *     fees: its id, chainId, sender, nonce, the payment it keeps (to,
 *     value, data, gasLimit) and the new fees. The handler takes the
 *     payment from main's record and only the fees from the caller
 *     (`wallet:intent-replace`).
 *   - intent-close: a held intent shown as Couldn't confirm, closed by
 *     hand: its id, chainId, sender, nonce and every hash it was signed
 *     as, in order (the revision the user saw). Nothing is signed; the
 *     handler builds the binding from main's record (`wallet:intent-close`).
 *   - x402-payment: one HTTP 402 payment on its approval card: the
 *     account (the active one when the user confirms, as for a
 *     wallet-send), the detection it is for (the tab's webContentsId,
 *     the detectionId and the URL), the chosen `accepts[]` entry (its
 *     index, scheme, network, asset, amount and payTo, plus a digest of
 *     the whole entry) and the allowance granted with it, or none.
 *     `x402:approve` builds the binding from main's record of the
 *     detection and takes only the entry's index and the grant from the
 *     caller.
 *   - x402-cap-update: one edit of a site's auto-pay cap (#1023): the
 *     chrome window it was confirmed in, the cap's key (origin, chainId,
 *     asset), the cap as main holds it (its amount, createdAt, expiresAt
 *     and the generation of the grant it is: a cap revoked and granted
 *     again within one second has the same createdAt) and the new amount
 *     or window, or both. Main fills in the window and the cap itself,
 *     when the token is minted and when `x402:update-permission` spends
 *     it, so a token can't change another cap, make another change, apply
 *     after the cap has changed, or be spent by another window.
 *
 * Auto-approved dApp requests carry no token: `wallet-ipc.js` evaluates the
 * stored auto-approve policy in main instead of trusting the renderer's
 * decision. Likewise an x402 payment a site's allowance covers is paid by
 * main's detector without a token (`x402/intercept.js`).
 *
 * The page kinds (freedom-core design 0011, "Approval tokens"): the kinds
 * that serve a page's request, `dapp-send`, `sign-message`,
 * `sign-typed-data`, `safe-message` and a `safe-send` that names a site.
 * Their tokens come from main's own issuer (`issuePageConfirmation`), which
 * the page dispatcher calls on the user's approval of a prompt main showed
 * for a live request; the token never leaves main, and the dispatcher spends
 * it (`consumePageConfirmation`). A page token's binding gains two fields,
 * both from main's request record: the prompt's handle, so a token answers
 * one prompt, and the requester's attested key, so a token minted for one
 * site's request can't sign another's. A page token is never spent on the
 * chrome's route (`consumeConfirmation`), nor a chrome token on a page's.
 * The chrome's `wallet:confirm-signing` refuses each page kind once its
 * methods have moved to main (`wallet-ipc.js`, PRQ-5).
 */

const crypto = require('crypto');
const { normalizeOrigin } = require('../../shared/origin-utils');

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
  INTENT_RESEND: 'intent-resend',
  INTENT_REPLACE: 'intent-replace',
  INTENT_CLOSE: 'intent-close',
  EXECUTOR_SEND: 'executor-send',
  X402_PAYMENT: 'x402-payment',
  X402_CAP_UPDATE: 'x402-cap-update',
});
// The most hashes an intent-close binds: above the intent store's bound on
// an intent's signatures (LIMITS.hashesPerIntent).
const MAX_CLOSE_HASHES = 64;

const NOT_CONFIRMED = 'SIGNING_NOT_CONFIRMED';

// The kinds that serve page requests, but a Safe send, which is one only
// when it names a site (a dApp's transaction from a Safe account).
const PAGE_KINDS = Object.freeze([KINDS.DAPP_SEND, KINDS.SIGN_MESSAGE, KINDS.SIGN_TYPED_DATA, KINDS.SAFE_MESSAGE]);
const PAGE_KIND_SET = new Set(PAGE_KINDS);

/** Whether a confirmation of `kind` for `payload` serves a page's request. */
function isPageKind(kind, payload) {
  if (PAGE_KIND_SET.has(kind)) return true;
  return kind === KINDS.SAFE_SEND && payload?.origin !== undefined && payload?.origin !== null;
}

// A page token's handle: the 32 random bytes main issued, in hex.
const HANDLE = /^[0-9a-f]{64}$/;

const outstanding = new Map(); // token -> { kind, digest, expiresAt, bound, page }
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

function intentId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(value)) {
    throw new Error('Invalid intent id');
  }
  return value;
}

function nonce(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid nonce');
  }
  return value;
}

function txHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('Invalid transaction hash');
  }
  return value.toLowerCase();
}

/** A detection's id as intercept.js mints it (`req-<n>`, `gen-<uuid>`). */
function detectionId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new Error('Invalid detection id');
  }
  return value;
}

/** A non-empty string, compared exactly. */
function text(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

/**
 * An x402 payment's allowance, as the card hands it to `x402:approve`:
 * none, or its cap and window exactly as given. The permissions store
 * validates them when it records the grant.
 */
function x402Grant(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid grant');
  }
  return { capAmount: value.capAmount ?? null, windowSeconds: value.windowSeconds ?? null };
}

/** An atomic amount as a digit string, or null for none. */
function digits(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Invalid ${field}`);
  return value;
}

/** A positive number of seconds, or null for none. */
function seconds(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

/** An x402 cap as main holds it: which grant it is, its amount and its window. */
function x402Cap(value) {
  if (!value || typeof value !== 'object') throw new Error('No such auto-pay cap');
  const capAmount = digits(value.capAmount, 'cap');
  if (
    capAmount === null ||
    !Number.isSafeInteger(value.createdAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation <= 0
  ) {
    throw new Error('Invalid auto-pay cap');
  }
  return { capAmount, createdAt: value.createdAt, expiresAt: value.expiresAt, generation: value.generation };
}

/** A Safe payment's site, if it has one (a dApp's), as its permission key. */
function optionalSite(value) {
  return value === undefined || value === null ? null : site(value);
}

/** A dApp payment's site, as its permission key: required. */
function site(value) {
  const key = typeof value === 'string' ? normalizeOrigin(value) : '';
  if (!key) throw new Error('A dApp payment needs the site it is for');
  return key;
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
    case KINDS.EXECUTOR_SEND:
      return { walletIndex: index(accountIndex, 'wallet index'), ...txFields(payload) };
    case KINDS.DAPP_SEND:
      return {
        walletIndex: index(accountIndex, 'wallet index'),
        ...txFields(payload),
        origin: site(payload.origin),
      };
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
        origin: optionalSite(payload.origin),
      };
    }
    case KINDS.INTENT_RESEND: {
      const sender = address(payload?.sender, 'sender');
      if (!sender) throw new Error('Invalid sender');
      return {
        intentId: intentId(payload?.intentId),
        chainId: chain(payload?.chainId),
        sender,
        nonce: nonce(payload?.nonce),
        hash: txHash(payload?.hash),
      };
    }
    case KINDS.INTENT_REPLACE: {
      const sender = address(payload?.sender, 'sender');
      if (!sender) throw new Error('Invalid sender');
      return {
        intentId: intentId(payload?.intentId),
        sender,
        nonce: nonce(payload?.nonce),
        ...txFields(payload),
      };
    }
    case KINDS.INTENT_CLOSE: {
      const sender = address(payload?.sender, 'sender');
      if (!sender) throw new Error('Invalid sender');
      const hashes = payload?.hashes;
      if (!Array.isArray(hashes) || hashes.length === 0 || hashes.length > MAX_CLOSE_HASHES) {
        throw new Error('Invalid hashes');
      }
      return {
        intentId: intentId(payload?.intentId),
        chainId: chain(payload?.chainId),
        sender,
        nonce: nonce(payload?.nonce),
        hashes: hashes.map(txHash),
      };
    }
    case KINDS.X402_PAYMENT: {
      const accept = payload?.accept;
      if (!accept || typeof accept !== 'object' || Array.isArray(accept)) {
        throw new Error('Payment option is required');
      }
      // V2 entries carry `amount`; V1 entries `maxAmountRequired`.
      const amount = quantity(accept.amount ?? accept.maxAmountRequired, 'amount');
      if (amount === null) throw new Error('Invalid amount');
      return {
        walletIndex: index(accountIndex, 'wallet index'),
        webContentsId: index(payload.webContentsId, 'tab'),
        detectionId: detectionId(payload.detectionId),
        url: text(payload.url, 'url'),
        acceptIndex: index(payload.acceptIndex, 'payment option'),
        scheme: text(accept.scheme, 'scheme'),
        network: text(accept.network, 'network'),
        asset: text(accept.asset, 'asset'),
        amount,
        payTo: text(accept.payTo, 'payTo'),
        acceptHash: sha256(stableStringify(accept)),
        grant: x402Grant(payload.grant),
      };
    }
    case KINDS.X402_CAP_UPDATE: {
      const origin = typeof payload?.origin === 'string' ? normalizeOrigin(payload.origin) : '';
      if (!origin) throw new Error('An auto-pay cap needs the site it is for');
      const capAmount = digits(payload.capAmount, 'cap');
      const windowSeconds = seconds(payload.windowSeconds, 'window');
      if (capAmount === null && windowSeconds === null) throw new Error('Nothing to change');
      return {
        window: index(payload.window, 'window'),
        origin,
        chainId: chain(payload.chainId),
        asset: text(payload.asset, 'asset'),
        current: x402Cap(payload.current),
        capAmount,
        windowSeconds,
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

function digestFor(kind, accountIndex, payload, page = null) {
  const binding = { kind, ...bindingFor(kind, accountIndex, payload) };
  if (page) binding.page = page;
  return sha256(stableStringify(binding));
}

/** A page token's two fields from main's request record, checked. */
function pageBinding(page) {
  const handle = page?.handle;
  const key = page?.key;
  if (typeof handle !== 'string' || !HANDLE.test(handle)) throw new Error('A page confirmation needs its handle');
  if (typeof key !== 'string' || key.length === 0) throw new Error('A page confirmation needs its key');
  return { handle, key };
}

function pruneExpired() {
  const t = now();
  for (const [token, entry] of outstanding) {
    if (entry.expiresAt <= t) outstanding.delete(token);
  }
}

/** A 0x-prefixed 32-byte hash, lowercase. */
function digestHex(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('Invalid typed data hash');
  }
  return value.toLowerCase();
}

/**
 * Issue a single-use confirmation token for exactly this request.
 * Throws on a malformed request (nothing is issued).
 *
 * @param {object} [bound] - facts main computed for the request, handed
 *   back when the token is spent: `{ hash }` for sign-typed-data, the
 *   core's EIP-712 hash of the data (required there).
 * @returns {{token: string, expiresAt: number}}
 */
function issueConfirmation(kind, accountIndex, payload, bound = {}) {
  return issue(kind, digestFor(kind, accountIndex, payload), bound, false);
}

/**
 * Main's own issuer for a page's request (design 0011, "Approval tokens"):
 * a token of a page kind, bound to the prompt's handle and the requester's
 * attested key as well. The page dispatcher calls it only on the user's
 * approval of a prompt main showed for a live request record, with the
 * handle and key from that record and the account and payload from the
 * request main holds (`page-requests.js`). Throws for any other kind.
 *
 * @param {{handle: string, key: string}} page
 */
function issuePageConfirmation(kind, accountIndex, payload, page, bound = {}) {
  if (!isPageKind(kind, payload)) throw new Error(`Not a page confirmation kind: ${kind}`);
  return issue(kind, digestFor(kind, accountIndex, payload, pageBinding(page)), bound, true);
}

function issue(kind, digest, bound, page) {
  const kept = kind === KINDS.SIGN_TYPED_DATA ? { hash: digestHex(bound?.hash) } : {};
  pruneExpired();
  while (outstanding.size >= MAX_OUTSTANDING) {
    // Map iteration order is insertion order: drop the oldest.
    outstanding.delete(outstanding.keys().next().value);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = now() + CONFIRMATION_TTL_MS;
  outstanding.set(token, { kind, digest, expiresAt, bound: kept, page });
  return { token, expiresAt };
}

/**
 * Spend a confirmation token for the request about to be signed. Burns the
 * token on every presentation. Throws (code SIGNING_NOT_CONFIRMED) unless
 * the token was issued for this kind and this exact request and has not
 * expired.
 *
 * @returns {object} what was bound with it (`{ hash }` for sign-typed-data)
 */
function consumeConfirmation(token, kind, accountIndex, payload) {
  return consume(token, kind, () => digestFor(kind, accountIndex, payload), false);
}

/**
 * Spend a page token (main's page dispatcher only): as `consumeConfirmation`,
 * and the token must have been minted by main's own issuer for this handle
 * and this key. A token minted for handle A is refused for handle B, and one
 * minted for one site's request for another's.
 *
 * @param {{handle: string, key: string}} page
 */
function consumePageConfirmation(token, kind, accountIndex, payload, page) {
  return consume(token, kind, () => digestFor(kind, accountIndex, payload, pageBinding(page)), true);
}

function consume(token, kind, digestOf, page) {
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
  // A page token is spent only by main's dispatcher, and a chrome token
  // never answers a page's request.
  if (entry.page !== page) {
    throw notConfirmed(page ? 'not a page confirmation' : 'a page confirmation is spent only by main');
  }
  let digest;
  try {
    digest = digestOf();
  } catch (err) {
    throw notConfirmed(err.message);
  }
  if (entry.kind !== kind || entry.digest !== digest) {
    throw notConfirmed('request differs from what was confirmed');
  }
  return { ...entry.bound };
}

/**
 * Burn a token without spending it: for a call refused before it named a
 * request to check the token against (a stale or unknown payment).
 */
function discardConfirmation(token) {
  if (typeof token === 'string') outstanding.delete(token);
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
  PAGE_KINDS,
  NOT_CONFIRMED,
  bindingFor,
  isPageKind,
  issueConfirmation,
  issuePageConfirmation,
  consumeConfirmation,
  consumePageConfirmation,
  discardConfirmation,
  _reset,
  _setNow,
  _outstandingCount,
};
