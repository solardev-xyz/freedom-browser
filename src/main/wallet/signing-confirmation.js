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
 * for a live request; the token never leaves main. A page token binds the
 * prompt's handle and the requesting document (its PageContext: the
 * attested key, the frame and the document's number), so a token answers
 * one prompt of one document. The chrome's `wallet:confirm-signing` refuses
 * each page kind once its methods have moved to main (`wallet-ipc.js`,
 * PRQ-5).
 *
 * Tokens through the core (freedom-core design 0012, APB-1): every kind but
 * x402's two is minted, checked and spent by the identity core
 * (`approval.issue`, `approval.spend`, `approval.discard`), never in JS: a
 * wallet kind from main itself (`shell`), a page kind under `page` with the
 * request's PageContext. The core binds the request in the form it will
 * sign it (`corePayload`), so what was confirmed is what is signed: a
 * signature the core makes presents its token to `sign.*` itself
 * (`signingAuthorization`), and the core spends it there; a device's
 * signature (Ledger, phone), and the kinds that sign nothing (a held
 * intent's resend and close, a Safe's send and message, whose owners sign
 * later) spend theirs through `approval.spend` (`spendConfirmation`). A
 * presented token is burnt whatever the outcome, as before, and main
 * discards one a request ended without presenting (`discardConfirmation`).
 * A send's token names its kind to `sign.transaction`, which refuses it
 * under another (`signingAuthorization`; freedom-core design 0012, "Naming
 * the kind"). Main keeps the kind it minted each of its own tokens as, and
 * burns one the chrome presents on another kind's route before the core is
 * asked to sign (`confirmationFor`).
 * `x402-payment` stays main's until the core can spend it (X402-1), and
 * `x402-cap-update`, the panel's decision, until X402-2: both are minted
 * and spent here, in JS, as before.
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

// The sends: a token of one names its kind to `sign.transaction` (design
// 0012, "Naming the kind"). An intent-replace names its intent instead.
const SEND_KINDS = new Set([KINDS.WALLET_SEND, KINDS.EXECUTOR_SEND, KINDS.DAPP_SEND]);

/** Whether a confirmation of `kind` for `payload` serves a page's request. */
function isPageKind(kind, payload) {
  if (PAGE_KIND_SET.has(kind)) return true;
  return kind === KINDS.SAFE_SEND && payload?.origin !== undefined && payload?.origin !== null;
}

// A page token's handle: the 32 random bytes main issued, in hex.
const HANDLE = /^[0-9a-f]{64}$/;

const outstanding = new Map(); // token -> { kind, digest, expiresAt }: x402's kinds only

// The kind main asked the core to mint for each token of its own, which the
// chrome presents back with a request: token -> { kind, expiresAt }. Main
// checks that kind against the route's before the token is presented, as its
// own check did before APB-1, and the signature names it to the core
// (`signingAuthorization`): the wallet's send route never presents an
// executor-send token, nor the executor's route a wallet-send token, and the
// core refuses one named as another kind. Bounded as the core bounds its
// tokens; one main no longer knows is refused, so evicting one can't skip
// the check.
const minted = new Map();
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

function digestFor(kind, accountIndex, payload) {
  return sha256(stableStringify({ kind, ...bindingFor(kind, accountIndex, payload) }));
}

// The kinds main still mints and spends in JS: x402's (above).
const MAIN_KINDS = new Set([KINDS.X402_PAYMENT, KINDS.X402_CAP_UPDATE]);
const ALL_KINDS = new Set(Object.values(KINDS));

/** Whether the identity core mints and spends `kind`'s tokens (APB-1). */
function isCoreKind(kind) {
  return ALL_KINDS.has(kind) && !MAIN_KINDS.has(kind);
}

function pruneExpired() {
  const t = now();
  for (const [token, entry] of outstanding) {
    if (entry.expiresAt <= t) outstanding.delete(token);
  }
}

// ---- main's own kinds: x402's, in JS ----

/**
 * Issue one of main's own tokens (x402's kinds), at once. Throws on a
 * malformed request (nothing is issued) and for any other kind.
 *
 * @returns {{token: string, expiresAt: number}}
 */
function issueMain(kind, accountIndex, payload) {
  if (!MAIN_KINDS.has(kind)) throw new Error(`Not one of main's own confirmation kinds: ${kind}`);
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
 * Spend one of main's own tokens (x402's kinds) for the request about to be
 * paid or applied. Burns the token on every presentation. Throws (code
 * SIGNING_NOT_CONFIRMED) unless the token was issued for this kind and this
 * exact request and has not expired. The core's kinds are spent by the core.
 */
function consumeConfirmation(token, kind, accountIndex, payload) {
  if (typeof token !== 'string' || token.length === 0) {
    throw notConfirmed('no confirmation token');
  }
  const entry = outstanding.get(token);
  outstanding.delete(token);
  if (!MAIN_KINDS.has(kind)) throw notConfirmed('the identity core spends this confirmation');
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
  return {};
}

// ---- the core's kinds (freedom-core design 0012, APB-1) ----

function vault() {
  return require('../core/vault-backend').vaultBackend;
}

// v1 Safes live on Gnosis (`safe-service.js`, DEPLOY_CHAIN_ID): a Safe
// message's chain, as main reads it from the Safe's record.
const SAFE_CHAIN_ID = 100;

// The core's refusals (`not_authorized`, design 0012, API), in today's words:
// a token's, and a standing rule's (`{ standing }`).
const REFUSALS = Object.freeze({
  no_token: 'no confirmation token',
  unknown_token: 'unknown or already used confirmation',
  expired: 'confirmation expired',
  mismatch: 'request differs from what was confirmed',
  no_rule: "this request is not covered by the site's auto-approve rules",
  paused: 'auto-approve is paused while a payment this site requested is waiting',
  fee_check: "the network fee needs the user's confirmation",
  custody: 'the agent holds this tab',
  rate_limited: "this site's auto-approve limit is reached",
  warning: "this request needs the user's review",
});

/**
 * A core error as main reports a confirmation's failure: a refusal
 * (`not_authorized`, or `forbidden` for a caller that can't present it) as
 * SIGNING_NOT_CONFIRMED, in today's words, with the core's `reason` kept
 * for the dispatcher (a standing rule's fee check sends a page's send to its
 * prompt). Anything else is passed on, a locked vault's `vault_locked` among
 * them.
 */
function confirmationError(err) {
  if (err?.code === 'not_authorized') {
    const reason = typeof err.data?.reason === 'string' ? err.data.reason : null;
    const mapped = notConfirmed(REFUSALS[reason] ?? err.message);
    if (reason) mapped.reason = reason;
    return mapped;
  }
  if (err?.code === 'forbidden') return notConfirmed(err.message);
  return err;
}

/** The core's fee verdict (`fee_check`) in main's words (`fee-check.js`). */
function feeVerdict(verdict) {
  return {
    maxCost: verdict?.max_cost ?? null,
    comparable: verdict?.comparable === true,
    ratio: verdict?.ratio ?? null,
    above: verdict?.above === true,
    oneEndpoint: verdict?.one_endpoint === true,
    basis: verdict?.basis ?? null,
    autoApprove: verdict?.auto_approve === true,
  };
}

function coreAddress(value, field) {
  const lower = address(value, field);
  if (!lower) throw new Error(`Invalid ${field}`);
  return lower;
}

/**
 * A send's transaction as main will hand it to `sign.transaction`: built as
 * main builds every send (`buildTransaction`), then in the core's wire form
 * (`toCoreTransaction`), so the core binds the type and the fee fields it
 * will sign. Its nonce only when the token binds one (intent-replace).
 */
function coreTx(tx, nonceValue) {
  if (!tx || typeof tx !== 'object') throw new Error('Transaction is required');
  const { buildTransaction, toCoreTransaction } = require('./signing-utils');
  const built = buildTransaction({
    to: tx.to,
    value: tx.value,
    data: tx.data,
    gasLimit: tx.gasLimit,
    maxFeePerGas: tx.maxFeePerGas,
    maxPriorityFeePerGas: tx.maxPriorityFeePerGas,
    gasPrice: tx.gasPrice,
    nonce: nonceValue,
    chainId: chain(tx.chainId),
  });
  const { tx: wire } = toCoreTransaction(built);
  if (nonceValue === undefined) delete wire.nonce;
  return wire;
}

/** A Safe's address, from its record: the Safe a token binds. */
function safeAddress(safeIndex) {
  const record = require('../identity-manager').getWalletRecord(safeIndex);
  if (!record || record.type !== 'safe' || typeof record.address !== 'string') {
    throw new Error('Unknown Safe account');
  }
  return coreAddress(record.address, 'Safe address');
}

/**
 * A request of `kind` in the form the core binds it (design 0012, "Tokens";
 * fc-approval's `bind.rs`): `{ account?, payload }`, the `sign.*`
 * parameters but the key for a kind the core signs, the core's own form for
 * the others. Main's own checks of the request come first (`bindingFor`), so
 * a malformed one fails in today's words.
 *
 * @param {object} [options] `chainId`: a page's chain, which a typed-data
 *   view is made against (`typedDataViewOptions`); `remember`: a dApp send
 *   whose "Always allow" was ticked (design 0012, `token-remember`)
 */
function corePayload(kind, accountIndex, payload, { chainId, remember } = {}) {
  const facts = bindingFor(kind, accountIndex, payload);
  switch (kind) {
    case KINDS.WALLET_SEND:
    case KINDS.EXECUTOR_SEND:
      return { account: facts.walletIndex, payload: { tx: coreTx(payload) } };
    case KINDS.DAPP_SEND:
      // The flag rides beside the binding: the core keeps it with the
      // token, and its `sign.transaction` says what became of the rule.
      return {
        account: facts.walletIndex,
        payload: { tx: coreTx(payload), ...(remember === true ? { remember: true } : {}) },
      };
    case KINDS.SIGN_MESSAGE: {
      const { normalizeMessage, messageToBytes } = require('./signing-utils');
      const bytes = typeof payload === 'string' ? messageToBytes(normalizeMessage(payload)) : Buffer.from(payload);
      return { account: facts.walletIndex, payload: { message: '0x' + bytes.toString('hex') } };
    }
    case KINDS.SIGN_TYPED_DATA: {
      const { normalizeTypedData, toCoreTypedData, typedDataViewOptions } = require('./signing-utils');
      const typedData = normalizeTypedData(payload);
      if (!typedData || typeof typedData !== 'object') throw new Error('Typed data is required');
      const options = typedDataViewOptions(typedData, chainId);
      const body = { typed_data: toCoreTypedData(typedData) };
      if (options.primaryType !== undefined) body.primary_type = options.primaryType;
      if (options.chainId !== undefined) body.chain_id = String(options.chainId);
      return { account: facts.walletIndex, payload: body };
    }
    case KINDS.SAFE_SEND:
      return {
        account: facts.safeIndex,
        payload: {
          safe: safeAddress(facts.safeIndex),
          chain_id: String(facts.chainId),
          tx: { to: coreAddress(facts.to, 'to'), value: facts.value, data: facts.data },
        },
      };
    case KINDS.SAFE_MESSAGE:
      return {
        account: facts.safeIndex,
        payload: {
          safe: safeAddress(facts.safeIndex),
          chain_id: String(SAFE_CHAIN_ID),
          method: payload.method,
          params: payload.params,
        },
      };
    case KINDS.INTENT_RESEND:
      return {
        payload: {
          intent_id: facts.intentId,
          chain_id: String(facts.chainId),
          sender: facts.sender,
          nonce: String(facts.nonce),
          hash: facts.hash,
        },
      };
    case KINDS.INTENT_REPLACE:
      // The account that signs it again, from main's record of the intent:
      // the core binds it, and `sign.transaction` requires it.
      return {
        ...(Number.isInteger(accountIndex) && accountIndex >= 0 ? { account: accountIndex } : {}),
        payload: { intent_id: facts.intentId, sender: facts.sender, tx: coreTx(payload, facts.nonce) },
      };
    case KINDS.INTENT_CLOSE:
      return {
        payload: {
          intent_id: facts.intentId,
          chain_id: String(facts.chainId),
          sender: facts.sender,
          nonce: String(facts.nonce),
          hashes: facts.hashes,
        },
      };
    default:
      throw new Error(`Not a core confirmation kind: ${kind}`);
  }
}

/**
 * A confirmation main holds for a request: its token and what the core
 * bound, to present at the signature (`signingAuthorization`) or to spend
 * (`spendConfirmation`). A page's names its prompt's handle and the
 * requesting document's PageContext.
 *
 * @typedef {{token: string, kind: string, account?: number, payload: object,
 *   handle?: string, page?: object, intent?: {id: string}}} Confirmation
 */

async function issueCore(kind, accountIndex, payload, { page = null, handle, feeAcknowledged, phone, chainId, remember } = {}) {
  const request = corePayload(kind, accountIndex, payload, { chainId, remember });
  const params = { kind, payload: request.payload };
  if (request.account !== undefined) params.account = request.account;
  if (handle !== undefined) params.handle = handle;
  if (feeAcknowledged === true) params.fee_ack = true;
  if (phone === true) params.phone = true;
  let reply;
  try {
    reply = await vault().approval.issue(params, page);
  } catch (err) {
    // The core's own fee check at minting (design 0012, "The fee check"):
    // above its threshold, the user confirms the fee again first.
    if (err?.code === 'not_authorized' && err.data?.reason === 'fee_check') {
      const { feeCheckError, FEE_CHECK_ASK_AGAIN } = require('./fee-check');
      throw feeCheckError(FEE_CHECK_ASK_AGAIN, feeVerdict(err.data.fee_check));
    }
    throw confirmationError(err);
  }
  const confirmation = { token: reply.token, kind, payload: request.payload };
  if (request.account !== undefined) confirmation.account = request.account;
  if (handle !== undefined) confirmation.handle = handle;
  if (page) confirmation.page = page;
  return {
    token: reply.token,
    expiresAt: Date.now() + (Number(reply.expires_in_ms) || 0),
    confirmation,
    ...(typeof reply.hash === 'string' ? { hash: reply.hash, view: reply.view } : {}),
    ...(reply.fee_check ? { feeCheck: feeVerdict(reply.fee_check) } : {}),
  };
}

/**
 * Issue a single-use confirmation token for exactly this request, from
 * main itself: a wallet kind through the identity core (`approval.issue`
 * as `shell`), or one of x402's kinds in JS. Rejects on a malformed request
 * (nothing is issued), and with FEE_CHECK_ASK_AGAIN and the core's verdict
 * for a send above the fee check's threshold not acknowledged.
 *
 * @param {object} [options] `feeAcknowledged`: the user confirmed a fee
 *   above the threshold again; `phone`: a phone account's send, whose fee
 *   the phone picks (the core's fee check skips it)
 * @returns {Promise<{token: string, expiresAt: number}>}
 */
async function issueConfirmation(kind, accountIndex, payload, options = {}) {
  if (MAIN_KINDS.has(kind)) return issueMain(kind, accountIndex, payload);
  if (isPageKind(kind, payload)) throw new Error(`A page confirmation is issued for its page: ${kind}`);
  const { token, expiresAt } = await issueCore(kind, accountIndex, payload, {
    feeAcknowledged: options.feeAcknowledged,
    phone: options.phone,
  });
  rememberKind(token, kind, expiresAt);
  return { token, expiresAt };
}

// Main's record of the kind it minted `token` as (`minted`): the oldest
// dropped past the bound, expired ones first.
function rememberKind(token, kind, expiresAt) {
  if (minted.size >= MAX_OUTSTANDING) {
    const t = Date.now();
    for (const [held, entry] of minted) {
      if (entry.expiresAt <= t) minted.delete(held);
    }
  }
  while (minted.size >= MAX_OUTSTANDING) minted.delete(minted.keys().next().value);
  minted.set(token, { kind, expiresAt });
}

/**
 * Main's own issuer for a page's request (design 0011, "Approval tokens"):
 * a token of a page kind, minted by the core under `page` with the
 * requesting document's PageContext and the prompt's handle (design 0012).
 * The page dispatcher calls it only on the user's approval of a prompt main
 * showed for a live request record, with the account and payload from the
 * request main holds (`page-requests.js`). Rejects for any other kind.
 *
 * @param {{handle: string, context: object}} page the prompt's handle and
 *   the document's PageContext (`{ origin, top_origin, frame, navigation,
 *   agent }`)
 * @param {object} [options] `chainId`: the page's chain, for typed data;
 *   for a dApp send, `feeAcknowledged` (the user confirmed a fee above the
 *   threshold again), `phone` (a phone account's, whose fee it picks) and
 *   `remember` ("Always allow" ticked: the core says at the signature
 *   whether it wrote the rule, `rule`)
 * @returns {Promise<Confirmation & {hash?: string, view?: object}>}
 */
async function issuePageConfirmation(kind, accountIndex, payload, page, options = {}) {
  if (!isPageKind(kind, payload)) throw new Error(`Not a page confirmation kind: ${kind}`);
  if (typeof page?.handle !== 'string' || !HANDLE.test(page.handle)) {
    throw new Error('A page confirmation needs its handle');
  }
  if (!page.context || typeof page.context.origin !== 'string' || !page.context.origin) {
    throw new Error('A page confirmation needs its page');
  }
  const issued = await issueCore(kind, accountIndex, payload, {
    page: page.context,
    handle: page.handle,
    chainId: options.chainId,
    feeAcknowledged: options.feeAcknowledged,
    phone: options.phone,
    remember: kind === KINDS.DAPP_SEND && options.remember === true,
  });
  return {
    ...issued.confirmation,
    ...(issued.hash !== undefined ? { hash: issued.hash, view: issued.view } : {}),
  };
}

/**
 * The confirmation a handler holds for a token the chrome presented with
 * its request (`wallet:confirm-signing`'s), read as the core binds it.
 * Throws (SIGNING_NOT_CONFIRMED) for no token, and burns the token, before
 * anything is asked of the core, for a token main didn't mint as this
 * route's kind (`minted`: an executor-send token on the wallet's send route,
 * or the reverse) and for a request that can't be read, as before.
 *
 * @returns {Confirmation}
 */
function confirmationFor(token, kind, accountIndex, payload, options = {}) {
  if (typeof token !== 'string' || token.length === 0) throw notConfirmed('no confirmation token');
  const issued = minted.get(token);
  minted.delete(token);
  if (!issued) {
    discardConfirmation(token);
    throw notConfirmed('unknown or already used confirmation');
  }
  if (issued.kind !== kind) {
    discardConfirmation(token);
    throw notConfirmed('request differs from what was confirmed');
  }
  let request;
  try {
    request = corePayload(kind, accountIndex, payload, options);
  } catch (err) {
    discardConfirmation(token);
    throw notConfirmed(err.message);
  }
  const confirmation = { token, kind, payload: request.payload };
  if (request.account !== undefined) confirmation.account = request.account;
  return confirmation;
}

/**
 * Spend a confirmation through the core (`approval.spend`): for a kind that
 * signs nothing here (a held intent's resend and close, a Safe's send and
 * message, whose owners sign later), and for a device's signature (a
 * Ledger, a phone), which the core advises on. Burns the token whatever the
 * outcome. Rejects (SIGNING_NOT_CONFIRMED) unless it was issued for this
 * kind, this request and, for a page's, this document and prompt.
 *
 * @param {Confirmation} confirmation
 * @returns {Promise<{bound: boolean, safe?: string}>} `safe`: the Safe
 *   approval a Safe's send or message gives (design 0012)
 */
async function spendConfirmation(confirmation) {
  const { token, kind, account, payload, handle, page } = confirmation || {};
  if (typeof token !== 'string' || token.length === 0) throw notConfirmed('no confirmation token');
  const params = { token, kind, payload };
  if (account !== undefined) params.account = account;
  if (handle !== undefined) params.handle = handle;
  try {
    return await vault().approval.spend(params, page || null);
  } catch (err) {
    throw confirmationError(err);
  }
}

/**
 * Spend a Safe's send or message confirmation (`spendConfirmation`). The
 * Safe approval the core gives for it is ended at once: until APB-1c
 * carries it to each owner's signature and the executor's, nothing presents
 * it, and an approval nothing holds is one nothing can misuse.
 *
 * @param {Confirmation} confirmation
 */
async function spendSafeConfirmation(confirmation) {
  const spent = await spendConfirmation(confirmation);
  if (typeof spent?.safe === 'string') {
    try {
      await vault().approval.end(spent.safe, confirmation.page || null);
    } catch {
      // Gone with the core, or dropped among its 64: nothing holds it.
    }
  }
  return { bound: spent?.bound === true };
}

/**
 * What a signature the core makes presents (design 0012, API): `sign.*`'s
 * `authorization`, `{ token, handle? }`; for a send, `{ token, kind,
 * handle? }`, naming the kind main minted it as (`wallet-send`,
 * `executor-send` or `dapp-send`), without which `sign.transaction` refuses
 * it (cored 0.15.0, "Naming the kind"); for an intent-replace, `{ token,
 * intent: { id } }`. And the PageContext of a page's request, under which
 * it is sent. The core spends the token there.
 *
 * @param {Confirmation} confirmation
 * @returns {{authorization: object, page: object|null}}
 */
function signingAuthorization(confirmation) {
  const authorization = { token: confirmation.token };
  if (SEND_KINDS.has(confirmation.kind)) authorization.kind = confirmation.kind;
  if (confirmation.handle !== undefined) authorization.handle = confirmation.handle;
  if (confirmation.intent) authorization.intent = { id: confirmation.intent.id };
  return { authorization, page: confirmation.page || null };
}

// The core's account kinds (design 0012, `approval.check`), by main's
// wallet type: a vault account, a Ledger, a phone, a Safe.
const ACCOUNT_KINDS = Object.freeze({ mnemonic: 'vault', ledger: 'ledger', remote: 'phone', safe: 'safe' });

/**
 * `approval.check`'s `request`, and its `chain_id` and `paused`, for a
 * page's request as the core takes them: a message's bytes in hex, typed
 * data in the core's form with the page's `primaryType` (viewed on the
 * page's chain), or the send main would sign, without its nonce.
 */
function standingRequest({ kind, account, accountType, payload, chainId, paused }) {
  const accountKind = ACCOUNT_KINDS[accountType];
  if (!accountKind) throw new Error(`Unknown account type: ${accountType}`);
  const request = { kind, account: index(account, 'account'), account_kind: accountKind };
  const params = { request };
  const utils = require('./signing-utils');
  switch (kind) {
    case 'message': {
      const bytes = typeof payload === 'string' ? utils.messageToBytes(utils.normalizeMessage(payload)) : Buffer.from(payload);
      request.message = '0x' + bytes.toString('hex');
      return params;
    }
    case 'typed_data': {
      const typedData = utils.normalizeTypedData(payload);
      if (!typedData || typeof typedData !== 'object') throw new Error('Typed data is required');
      const options = utils.typedDataViewOptions(typedData, chainId);
      request.typed_data = utils.toCoreTypedData(typedData);
      if (options.primaryType !== undefined) request.primary_type = options.primaryType;
      if (options.chainId !== undefined) params.chain_id = options.chainId;
      return params;
    }
    case 'transaction':
      request.tx = coreTx(payload);
      params.chain_id = chain(payload.chainId);
      // Main's D12 reading, in the send's own turn; none reads as paused.
      params.paused = paused !== false;
      return params;
    default:
      throw new Error(`Unknown request kind: ${kind}`);
  }
}

/**
 * Whether a site's standing rule would answer a page's request now (design
 * 0012, `approval.check`): the core reads today's rules from the dApp file
 * main writes, for the page's own key, outside Agent custody (the
 * PageContext's `agent`), with the D12 pause main reads and the core's own
 * fee evidence for a send. Advice, for main's choice between a prompt and
 * none: `sign.*` decides again under `{ standing }`. Asked under `page` with
 * the request's PageContext; it counts nothing and writes nothing. Never
 * rejects: a request the core can't judge, or a failed call, reads as not
 * covered, and the request goes to its prompt.
 *
 * @param {object} page the request's PageContext
 * @param {{kind: 'message'|'typed_data'|'transaction', account: number,
 *   accountType: string, payload: *, chainId?: number, paused?: boolean}} request
 *   `payload`: the message, the typed data, or the send main would sign
 *   (`{ to, value, data, chainId, gasLimit, … }`); `chainId`: the page's
 *   chain; `paused`: main's D12 reading, for a send
 * @returns {Promise<{covered: boolean, reason: string|null}>}
 */
async function checkStanding(page, request) {
  if (!page || typeof page.origin !== 'string' || !page.origin) return { covered: false, reason: 'no_page' };
  let params;
  try {
    params = standingRequest(request || {});
  } catch {
    return { covered: false, reason: 'invalid' };
  }
  try {
    const reply = await vault().approval.check(params, page);
    if (reply?.covered === true) return { covered: true, reason: null };
    return { covered: false, reason: typeof reply?.reason === 'string' ? reply.reason : null };
  } catch (err) {
    return { covered: false, reason: typeof err?.code === 'string' ? err.code : 'error' };
  }
}

/**
 * Whether main writes today's transaction rule after an "Always allow"
 * send (design 0012, The model, "Before APB-2"): the core signs a vault
 * account's flagged `dapp-send` and replies what became of the rule, which
 * before the dApp file's move is always `{ added: false, reason:
 * 'not_moved' }`; main then writes it, as today. Any other reply (none, a
 * rule the core added, or another reason) leaves main's file alone. A
 * device's send (a Ledger, a phone) is signed outside the core, which
 * writes nothing for it: main writes the rule, as today.
 *
 * @param {boolean} coreSigned the core made the signature
 * @param {object|null|undefined} rule the `sign.transaction` reply's `rule`
 */
function mainWritesRule(coreSigned, rule) {
  if (!coreSigned) return true;
  return rule?.added === false && rule.reason === 'not_moved';
}

/**
 * Burn a token without spending it: for a request that ended before it
 * presented its token, or refused before it named a request to check the
 * token against. The core answers `{}` for a token already spent or
 * unknown, so this is safe to call after any outcome; it never rejects.
 */
function discardConfirmation(token) {
  if (typeof token !== 'string' || token.length === 0) return Promise.resolve();
  outstanding.delete(token);
  minted.delete(token);
  return vault()
    .approval.discard(token)
    .then(
      () => {},
      () => {}
    );
}

/**
 * Run `fn` holding `token`, and burn the token afterwards, whatever
 * happened: a token is spent at its first presentation, so one whose
 * request ended before its signature can't be presented again.
 */
async function withConfirmation(token, fn) {
  try {
    return await fn();
  } finally {
    await discardConfirmation(token);
  }
}

function _reset() {
  outstanding.clear();
  minted.clear();
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
  ACCOUNT_KINDS,
  bindingFor,
  checkStanding,
  confirmationError,
  corePayload,
  isCoreKind,
  isPageKind,
  mainWritesRule,
  issueConfirmation,
  issueMainConfirmation: issueMain,
  issuePageConfirmation,
  confirmationFor,
  consumeConfirmation,
  spendConfirmation,
  spendSafeConfirmation,
  signingAuthorization,
  discardConfirmation,
  withConfirmation,
  _reset,
  _setNow,
  _outstandingCount,
};
