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
 *   - a `safe-send`'s or `safe-message`'s spend gives a Safe approval, held by
 *     its page or by the wallet (`shell`); `{ safe }` signs an owner's typed
 *     data or a send's executor (which ends it) only for its holder, until
 *     `approval.end`; a Safe's new send approval ends its older one;
 *   - the dApp store is the core's (APB-2, `grant_moved` names `dapp`): its
 *     write methods (`approval.grant` under `page` for the page's own key,
 *     never a transaction rule; `approval.revoke`; `approval.touch` under
 *     `page`; `approval.forget_account`) and `approval.grants` change and
 *     read `dapp`, entries in today's format with Q9's limited rules under
 *     `autoApprove.limited` ("Always allow" for signing clears today's flag
 *     in the same change);
 *   - a site's standing rule answers `approval.check` and a `sign.*` under
 *     `page` with `{ standing }` as the test's `setStanding(fn)` says, or by
 *     default as Q9 has it from that store: outside custody, the grant
 *     exposing the account, a live limited rule (30 days from its
 *     `grantedAt`; a contract rule's call and `maxValue`), and for a send
 *     not paused; today's rules answer nothing (Q9's rate and the fee check
 *     are the real core's, tested in signing-confirmation.integration);
 *   - a flagged `dapp-send`'s signature writes the limited contract rule for
 *     the page's key when its grant exposes the account, replacing today's
 *     rule for the same call, and replies `{ added: true }` (or why not).
 * Every call is recorded in `calls` as `{ method, params, page }`.
 */
const crypto = require('crypto');
const { TypedDataEncoder } = require('ethers');

const PAGE_KINDS = new Set(['dapp-send', 'sign-message', 'sign-typed-data', 'safe-message']);
const MAX_OUTSTANDING = 32;
// Q9: a limited rule answers for 30 days of the wall clock.
const RULE_TTL_MS = 2_592_000_000;

const coded = (message, code) => Object.assign(new Error(message), { code });

/**
 * The dApp store as the core holds it once `dapp-permissions.json` has
 * moved to it (design 0012, APB-2): key -> entry, today's format, Q9's
 * limited rules under `autoApprove.limited`. `wallNow` is its wall clock.
 */
function simulatedDappStore(wallNow) {
  const entries = new Map();
  const clone = (value) => (value == null ? null : JSON.parse(JSON.stringify(value)));
  const live = (rule) => {
    const at = wallNow();
    return typeof rule?.grantedAt === 'number' && rule.grantedAt <= at && at < rule.grantedAt + RULE_TTL_MS;
  };
  const sameCall = (rule, to, selector, chainId) =>
    typeof rule?.to === 'string' &&
    typeof rule?.selector === 'string' &&
    rule.to.toLowerCase() === to.toLowerCase() &&
    rule.selector.toLowerCase() === selector.toLowerCase() &&
    rule.chainId === chainId;
  const limitedOf = (entry) => {
    entry.autoApprove = entry.autoApprove || { signing: false, transactions: [] };
    if (!entry.autoApprove.limited || typeof entry.autoApprove.limited !== 'object') {
      entry.autoApprove.limited = { signing: null, transactions: [] };
    }
    return entry.autoApprove.limited;
  };
  return {
    entries,
    entry: (key) => clone(entries.get(key)),
    records: () => [...entries.values()].map(clone).sort((a, b) => b.lastUsed - a.lastUsed),
    /** A file the core read at its start, as given. */
    seed(key, entry) {
      entries.set(key, clone(entry));
    },
    exposes: (key, account) => entries.get(key)?.walletIndex === account,
    connect(key, account, chainId) {
      const now = wallNow();
      entries.set(key, {
        origin: key,
        connectedAt: now,
        lastUsed: now,
        walletIndex: account,
        chainId,
        autoApprove: { signing: false, transactions: [] },
      });
    },
    signingRule: (key) => live(entries.get(key)?.autoApprove?.limited?.signing),
    transactionRule(key, to, selector, chainId, value) {
      const rules = entries.get(key)?.autoApprove?.limited?.transactions;
      return (
        Array.isArray(rules) &&
        rules.some((rule) => sameCall(rule, to, selector, chainId) && live(rule) && BigInt(value || 0) <= BigInt(rule.maxValue))
      );
    },
    allowSigning(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      limitedOf(entry).signing = { grantedAt: wallNow() };
      entry.autoApprove.signing = false;
      return true;
    },
    allowTransaction(key, to, selector, chainId, value) {
      const entry = entries.get(key);
      if (!entry) return false;
      const limited = limitedOf(entry);
      const rule = { to: to.toLowerCase(), selector: selector.toLowerCase(), chainId, maxValue: BigInt(value || 0).toString(), grantedAt: wallNow() };
      limited.transactions = (limited.transactions || []).filter((r) => !sameCall(r, to, selector, chainId));
      limited.transactions.push(rule);
      entry.autoApprove.transactions = (entry.autoApprove.transactions || []).filter((r) => !sameCall(r, to, selector, chainId));
      return true;
    },
    signingOff(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      entry.autoApprove = entry.autoApprove || { signing: false, transactions: [] };
      entry.autoApprove.signing = false;
      if (entry.autoApprove.limited) entry.autoApprove.limited.signing = null;
      return true;
    },
    removeTransaction(key, to, selector, chainId) {
      const rules = entries.get(key)?.autoApprove;
      if (!rules) return false;
      const before = (rules.transactions || []).length + (rules.limited?.transactions || []).length;
      rules.transactions = (rules.transactions || []).filter((r) => !sameCall(r, to, selector, chainId));
      if (rules.limited) rules.limited.transactions = (rules.limited.transactions || []).filter((r) => !sameCall(r, to, selector, chainId));
      return before !== rules.transactions.length + (rules.limited?.transactions || []).length;
    },
    /** Q9's reading of a request, but its rate and the fee check. */
    covers(page, { request, paused }) {
      if (page.agent !== false) return { covered: false, reason: 'custody' };
      const key = page.origin;
      if (!this.exposes(key, request.account)) return { covered: false, reason: 'no_rule' };
      if (request.kind === 'transaction') {
        const { tx } = request;
        if (request.account_kind === 'safe' || typeof tx?.to !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(tx.data || '')) {
          return { covered: false, reason: 'no_rule' };
        }
        if (!this.transactionRule(key, tx.to, tx.data.slice(0, 10), Number(tx.chain_id), tx.value)) {
          return { covered: false, reason: 'no_rule' };
        }
        return paused === false ? { covered: true } : { covered: false, reason: 'paused' };
      }
      return this.signingRule(key) ? { covered: true } : { covered: false, reason: 'no_rule' };
    },
  };
}

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
  // Safe approvals (design 0012): id -> { kind, holder }, `holder` the
  // page's { origin, frame, navigation }, or null for the wallet's (`shell`).
  const safes = new Map();
  // The core's own fee check at a Safe executor's signature: a reason to
  // refuse it with (`fee_check`), or null.
  let executorRefusal = null;
  // A site's standing rule, as the core reads it: `(page, { request,
  // chain_id?, paused? })` → `{ covered, reason? }`. None answers by default.
  const noRule = () => ({ covered: false, reason: 'no_rule' });
  // The core's wall clock, which Q9's expiry reads (setWallNow to move it).
  let wallNow = () => Date.now();
  const dapp = simulatedDappStore(() => wallNow());
  const storeRule = (page, params) => dapp.covers(page, params);
  let standing = storeRule;

  const pageOf = (context, handle) =>
    context ? { origin: context.origin, frame: context.frame, navigation: context.navigation, handle } : null;
  const digestOf = (kind, account, payload, page) =>
    stable({ kind, account: account ?? null, facts: facts(kind, payload), page: page ?? null });

  // The page of the last token `take` spent, when it was a flagged dApp
  // send's.
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
    remembered = entry.remember === true && request.page ? request.page : null;
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
        const holder = context ? { origin: context.origin, frame: context.frame, navigation: context.navigation } : null;
        // A Safe's new send approval ends its older one.
        if (kind === 'safe-send') {
          for (const [id, entry] of safes) if (entry.kind === kind && entry.account === account) safes.delete(id);
        }
        safes.set(safe, { kind, account, holder });
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
    // The dApp store's writes (APB-2): a page's for its own key, main's own
    // as `shell`.
    async grant(params, context = null) {
      calls.push({ method: 'approval.grant', params, page: context });
      const { store, change } = params;
      if (store !== 'dapp' || !context) throw coded("this caller can't write this store's grants", 'forbidden');
      if (change?.op === 'transaction') throw coded('a transaction rule comes only with a confirmed send', 'forbidden');
      if (change && 'key' in change) throw coded('change: a page changes its own grant', 'invalid_argument');
      const key = context.origin;
      if (change?.op === 'connect') dapp.connect(key, change.account, change.chain_id);
      else if (change?.op === 'account') {
        if (!dapp.entries.has(key)) return { grant: null };
        Object.assign(dapp.entries.get(key), { walletIndex: change.account, lastUsed: wallNow() });
      } else if (change?.op === 'signing') {
        if (!dapp.allowSigning(key)) return { grant: null };
      } else throw coded('change: unknown op for this store', 'invalid_argument');
      return { grant: dapp.entry(key) };
    },
    async revoke(params, context = null) {
      calls.push({ method: 'approval.revoke', params, page: context });
      const { store, key, what } = params;
      if (store !== 'dapp') throw coded('not moved', 'not_moved');
      if (context && context.origin !== key) throw coded('a page revokes only its own grant', 'forbidden');
      let revoked;
      if (what === 'grant') revoked = dapp.entries.delete(key);
      else if (what === 'signing') revoked = dapp.signingOff(key);
      else if (what?.transaction) {
        const { to, selector, chain_id: chainId } = what.transaction;
        revoked = dapp.removeTransaction(key, to, selector, chainId);
      } else throw coded('what: unknown for this store', 'invalid_argument');
      return { revoked };
    },
    async touch(params, context = null) {
      calls.push({ method: 'approval.touch', params, page: context });
      if (params.store !== 'dapp') throw coded('not moved', 'not_moved');
      if (!context) throw coded('only a page marks its own use', 'forbidden');
      const entry = dapp.entries.get(context.origin);
      if (entry) {
        entry.lastUsed = wallNow();
        if (params.chain_id !== undefined) entry.chainId = params.chain_id;
      }
      return {};
    },
    async forgetAccount(walletIndex) {
      calls.push({ method: 'approval.forget_account', params: { wallet_index: walletIndex }, page: null });
      const keys = [...dapp.entries.keys()].filter((key) => dapp.exposes(key, walletIndex));
      for (const key of keys) dapp.entries.delete(key);
      return { keys };
    },
    async grants(params) {
      calls.push({ method: 'approval.grants', params, page: null });
      if (params.store !== 'dapp') return { records: [] };
      if (params.key !== undefined) {
        const entry = dapp.entry(params.key);
        return { records: entry ? [entry] : [] };
      }
      return { records: dapp.records() };
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
    if (authorization.safe !== undefined) {
      // A Safe approval: open, presented by its holder, for an owner's typed
      // data or the executor's transaction, which ends it.
      const entry = safes.get(authorization.safe);
      if (!entry) throw refused('unknown_token');
      const presenter = page ? { origin: page.origin, frame: page.frame, navigation: page.navigation } : null;
      if (stable(presenter) !== stable(entry.holder) || method === 'sign.message') throw refused('mismatch');
      if (method === 'sign.transaction') {
        if (entry.kind !== 'safe-send') throw refused('mismatch');
        if (executorRefusal) throw refused(executorRefusal);
        safes.delete(authorization.safe);
      }
      return null;
    }
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
      // A flagged dApp send: the core writes the limited contract rule for
      // the page's key as it signs (design 0012, The model, APB-2).
      const flagged = remembered;
      remembered = null;
      if (!flagged) return null;
      const { tx } = request;
      if (!dapp.exposes(flagged.origin, account)) return { added: false, reason: 'not_exposed' };
      if (typeof tx?.to !== 'string' || !/^0x[0-9a-fA-F]{8}/.test(tx.data || '')) return { added: false, reason: 'no_rule' };
      dapp.allowTransaction(flagged.origin, tx.to, tx.data.slice(0, 10), Number(tx.chain_id), tx.value);
      return { added: true };
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
    /**
     * The site's standing rule the core reads (`approval.check`, `{
     * standing }`); none given, Q9's reading of the dApp store.
     */
    setStanding(fn) {
      standing = typeof fn === 'function' ? fn : storeRule;
    },
    /** The dApp store the core holds (APB-2). */
    dapp,
    setWallNow(fn) {
      wallNow = fn;
    },
    openSafeApprovals: () => safes.size,
    isSafeApprovalOpen: (id) => safes.has(id),
    // A Safe approval as a spend gives one, for a test that starts past it.
    openSafeApproval({ kind = 'safe-send', account = 0, page = null } = {}) {
      const safe = crypto.randomBytes(16).toString('hex');
      safes.set(safe, { kind, account, holder: page ? { origin: page.origin, frame: page.frame, navigation: page.navigation } : null });
      return safe;
    },
    setExecutorRefusal(reason) {
      executorRefusal = reason;
    },
    reset() {
      calls.length = 0;
      tokens.clear();
      safes.clear();
      executorRefusal = null;
      now = () => Date.now();
      wallNow = () => Date.now();
      standing = storeRule;
      remembered = null;
      dapp.entries.clear();
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
  const { signingAuthorization, safeAuthorization, confirmationError } = require('../../src/main/wallet/signing-confirmation');
  const presented = () => {
    if (authorized?.confirmation) return signingAuthorization(authorized.confirmation);
    if (authorized?.safe) return safeAuthorization(authorized.safe);
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
