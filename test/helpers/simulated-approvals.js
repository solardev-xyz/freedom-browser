/**
 * The identity core's approval tokens (freedom-core design 0012, APR-3) for
 * unit tests, simulated in JS: `approval.issue`, `approval.spend`,
 * `approval.discard` and `approval.end`, and the check `sign.*` makes of an
 * `authorization`. The real core is tested against main in
 * src/main/wallet/signing-confirmation.integration.test.js; this keeps the
 * rules main's wiring relies on:
 *   - a page kind is minted only under `page`, with its PageContext and a
 *     handle, and a wallet kind only under `shell`;
 *   - a token binds its kind, account, payload and page (origin, frame,
 *     navigation, handle), and is burnt at its first presentation, whatever
 *     the outcome; at most 32 are outstanding, the oldest dropped;
 *   - `sign.*` spends a page's `dapp-send`, `sign-message` and
 *     `sign-typed-data` under `page`, and the wallet's `wallet-send`,
 *     `executor-send` and (with its intent) `intent-replace` under `shell`;
 *     a send's token names its kind (`authorization.kind`), and one named
 *     as none, or as another, is refused (cored 0.15.0);
 *   - a typed-data token keeps the data's EIP-712 hash, which the signature's
 *     `expected_hash` must equal;
 *   - a site's standing rule answers `approval.check` and a `sign.*` under
 *     `page` with `{ standing }` as the test's `setStanding(fn)` says (none
 *     by default), and a flagged `dapp-send`'s signature replies that no
 *     rule was written (`not_moved`: the dApp file hasn't moved to the core).
 * Every call is recorded in `calls` as `{ method, params, page }`.
 */
const crypto = require('crypto');
const { TypedDataEncoder } = require('ethers');

const PAGE_KINDS = new Set(['dapp-send', 'sign-message', 'sign-typed-data', 'safe-message']);
const MAX_OUTSTANDING = 32;

function stable(value) {
  if (value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

function refused(reason) {
  return Object.assign(new Error(`not authorized: ${reason}`), { code: 'not_authorized', data: { reason } });
}

// A transaction as the core binds it: every field but the nonce (unless
// bound), quantities in decimal, addresses and bytes in lowercase.
function txFacts(tx, withNonce) {
  const quantity = (value) => (value === undefined || value === null ? null : BigInt(value).toString());
  return {
    type: tx.type ?? null,
    chain_id: quantity(tx.chain_id),
    to: typeof tx.to === 'string' ? tx.to.toLowerCase() : null,
    value: quantity(tx.value ?? '0'),
    data: typeof tx.data === 'string' ? tx.data.toLowerCase() : '0x',
    gas_limit: quantity(tx.gas_limit),
    gas_price: quantity(tx.gas_price),
    max_fee_per_gas: quantity(tx.max_fee_per_gas),
    max_priority_fee_per_gas: quantity(tx.max_priority_fee_per_gas),
    ...(withNonce ? { nonce: quantity(tx.nonce) } : {}),
  };
}

function facts(kind, payload) {
  switch (kind) {
    case 'wallet-send':
    case 'executor-send':
    case 'dapp-send':
      return { tx: txFacts(payload.tx, false) };
    case 'intent-replace':
      return { intent_id: payload.intent_id, sender: String(payload.sender).toLowerCase(), tx: txFacts(payload.tx, true) };
    case 'sign-message':
      return { message: String(payload.message).toLowerCase() };
    default:
      return payload;
  }
}

const TOKEN_LIFE_MS = 120000;

function simulatedApprovals() {
  const calls = [];
  // The core's vault clock: two minutes of life a token (setNow to move it).
  let now = () => Date.now();
  const tokens = new Map(); // token -> { kind, account, digest, page, hash, sender, remember }
  const safes = new Set();
  // A site's standing rule, as the core reads it: `(page, { request,
  // chain_id?, paused? })` → `{ covered, reason? }`. None answers by default.
  const noRule = () => ({ covered: false, reason: 'no_rule' });
  let standing = noRule;

  const pageOf = (context, handle) =>
    context ? { origin: context.origin, frame: context.frame, navigation: context.navigation, handle } : null;
  const digestOf = (kind, account, payload, page) =>
    stable({ kind, account: account ?? null, facts: facts(kind, payload), page: page ?? null });

  // Whether the last token `take` spent was a flagged dApp send's.
  let remembered = null;

  // Spends `token` for a request: burnt whatever the outcome.
  function take(token, minter, fits) {
    if (typeof token !== 'string' || !token) throw refused('no_token');
    const entry = tokens.get(token);
    tokens.delete(token);
    if (!entry) throw refused('unknown_token');
    if (entry.expiresAt <= now()) throw refused('expired');
    if (entry.minter !== minter) throw refused('mismatch');
    const request = fits(entry);
    if (!request || entry.digest !== digestOf(entry.kind, request.account, request.payload, request.page)) {
      throw refused('mismatch');
    }
    remembered = entry.remember === true && Boolean(request.page);
    return entry;
  }

  const approval = {
    async issue(params, context = null) {
      calls.push({ method: 'approval.issue', params, page: context });
      const { kind, account, payload, handle } = params;
      // A Safe send is a page's when it names a site, which its page says.
      const pageKind = PAGE_KINDS.has(kind) || (kind === 'safe-send' && Boolean(context));
      if (pageKind !== Boolean(context)) {
        throw Object.assign(new Error("this caller can't confirm this kind"), { code: 'forbidden' });
      }
      if (context && !/^[0-9a-f]{64}$/.test(handle ?? '')) {
        throw Object.assign(new Error('A page confirmation needs its handle'), { code: 'invalid_argument' });
      }
      while (tokens.size >= MAX_OUTSTANDING) tokens.delete(tokens.keys().next().value);
      const token = crypto.randomBytes(32).toString('hex');
      const bound = pageOf(context, handle);
      const entry = {
        kind,
        account,
        minter: context ? 'page' : 'shell',
        digest: digestOf(kind, account, payload, bound),
        expiresAt: now() + TOKEN_LIFE_MS,
      };
      let typed = {};
      if (kind === 'sign-typed-data') {
        const { domain, types, message } = payload.typed_data;
        entry.hash = TypedDataEncoder.hash(domain, types, message);
        typed = { hash: entry.hash, view: { primary_type: payload.primary_type ?? null } };
      }
      if (kind === 'intent-replace') entry.sender = payload.sender;
      if (kind === 'dapp-send') entry.remember = payload.remember === true;
      tokens.set(token, entry);
      return { token, expires_in_ms: TOKEN_LIFE_MS, ...typed };
    },
    async spend(params, context = null) {
      calls.push({ method: 'approval.spend', params, page: context });
      const { token, kind, account, payload, handle } = params;
      const page = pageOf(context, handle);
      take(token, context ? 'page' : 'shell', (entry) => (entry.kind === kind ? { account, payload, page } : null));
      if (kind === 'safe-send' || kind === 'safe-message') {
        const safe = crypto.randomBytes(16).toString('hex');
        safes.add(safe);
        return { bound: true, safe };
      }
      return { bound: true };
    },
    async discard(token) {
      calls.push({ method: 'approval.discard', params: { token }, page: null });
      tokens.delete(token);
      return {};
    },
    async end(safe, context = null) {
      calls.push({ method: 'approval.end', params: { safe }, page: context });
      safes.delete(safe);
      return {};
    },
    async check(params, context = null) {
      calls.push({ method: 'approval.check', params, page: context });
      if (!context) throw Object.assign(new Error('a standing rule answers only a page'), { code: 'forbidden' });
      const answer = standing(context, params) || noRule();
      return answer.covered === true ? { covered: true } : { covered: false, reason: answer.reason ?? 'no_rule' };
    },
  };

  /**
   * `sign.*`'s check of its `authorization`, before the key: `method` is
   * `sign.transaction`, `sign.message` or `sign.typed_data`, `request` the
   * key's account and what it signs (`{ tx }`, `{ message }`, or
   * `{ typed_data, primary_type?, chain_id?, expected_hash }`).
   */
  function authorize(method, account, request, { authorization = null, page = null } = {}) {
    calls.push({ method, params: { account, ...request, ...(authorization ? { authorization } : {}) }, page });
    if (!authorization) return null;
    if (authorization.standing) {
      if (!page) throw Object.assign(new Error('a standing rule answers only a page'), { code: 'forbidden' });
      const kind = method === 'sign.transaction' ? 'transaction' : method === 'sign.message' ? 'message' : 'typed_data';
      const answer = standing(page, { request: { kind, account, ...request }, paused: authorization.standing.paused }) || noRule();
      if (answer.covered !== true) throw refused(answer.reason ?? 'no_rule');
      return null;
    }
    const { token, handle, intent } = authorization;
    const bound = pageOf(page, handle);
    const minter = page ? 'page' : 'shell';
    if (method === 'sign.transaction') {
      take(token, minter, (entry) => {
        if (intent) {
          if (entry.kind !== 'intent-replace' || page || authorization.kind !== undefined) return null;
          return { account, payload: { intent_id: intent.id, sender: entry.sender, tx: request.tx }, page: null };
        }
        // A send's token names the kind it was minted as (design 0012,
        // "Naming the kind").
        if (authorization.kind !== entry.kind) return null;
        const fits = page ? entry.kind === 'dapp-send' : entry.kind === 'wallet-send' || entry.kind === 'executor-send';
        return fits ? { account, payload: { tx: request.tx }, page: bound } : null;
      });
      // A flagged dApp send: the core signs and writes no rule before the
      // dApp file moves to it (design 0012, The model).
      const spent = remembered;
      remembered = null;
      return spent ? { added: false, reason: 'not_moved' } : null;
    } else if (method === 'sign.message') {
      take(token, minter, (entry) =>
        entry.kind === 'sign-message' && page ? { account, payload: { message: request.message }, page: bound } : null
      );
    } else {
      const { expected_hash: expectedHash, ...payload } = request;
      const entry = take(token, minter, (candidate) =>
        candidate.kind === 'sign-typed-data' && page ? { account, payload, page: bound } : null
      );
      if (entry.hash !== expectedHash) throw refused('mismatch');
    }
    return null;
  }

  return {
    approval,
    authorize,
    calls,
    outstanding: () => tokens.size,
    setNow(fn) {
      now = fn;
    },
    /** The site's standing rule the core reads (`approval.check`, `{ standing }`). */
    setStanding(fn) {
      standing = typeof fn === 'function' ? fn : noRule;
    },
    openSafeApprovals: () => safes.size,
    reset() {
      calls.length = 0;
      tokens.clear();
      safes.clear();
      now = () => Date.now();
      standing = noRule;
      remembered = null;
    },
  };
}

/**
 * A test's vault signer as the core checks it: `sign.transaction` presents
 * the confirmation `getSigner` was handed (`authorized`), or the page's
 * standing rule (`{ standing }`), which `approvals` checks before `signer`
 * is asked, refusing in today's words; the core's `rule` reply reaches
 * `authorized.onRule`, as `signers.js` hands it on.
 */
function coreCheckedSigner(approvals, signer, index, authorized = {}) {
  const { toCoreTransaction } = require('../../src/main/wallet/signing-utils');
  const { signingAuthorization, confirmationError } = require('../../src/main/wallet/signing-confirmation');
  const presented = () => {
    if (authorized?.confirmation) return signingAuthorization(authorized.confirmation);
    const page = authorized?.page ?? null;
    return page && authorized?.standing ? { authorization: { standing: { ...authorized.standing } }, page } : { page };
  };
  return {
    ...signer,
    signTransaction: async (tx) => {
      let rule;
      try {
        rule = approvals.authorize('sign.transaction', index, { tx: toCoreTransaction(tx).tx }, presented());
      } catch (err) {
        throw confirmationError(err);
      }
      const raw = await signer.signTransaction(tx);
      if (typeof authorized?.onRule === 'function') authorized.onRule(rule ?? null);
      return raw;
    },
  };
}

module.exports = { simulatedApprovals, coreCheckedSigner };
