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
 *     never a transaction rule; `approval.revoke` under a page for its own
 *     key, the chrome (`'chrome'`) or main (`shell`); `approval.touch` under
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
 *     rule for the same call, and replies `{ added: true }` (or why not);
 *   - a flagged `dapp-send` spent under `page` (a device's: cored 0.16.0,
 *     "A device send's rule") writes nothing and replies `{ bound, receipt }`;
 *     `approval.remember { receipt }`, under the page the token was spent
 *     under (origin, frame, navigation), takes it once, whatever the
 *     outcome (`unknown_token`, `expired` after ten minutes, `mismatch`),
 *     and writes that rule as the signature would, `{ rule }`; at most 64
 *     are open, the oldest dropped, and a dApp revoke for the key, or
 *     `approval.forget_account`, drops the key's or the account's;
 *   - APR-4 (cored 0.16.0): a page's signature needs its authorization (a
 *     page-kind token, `{ standing }` or `{ safe }`), and a Safe's (typed
 *     data declaring `SafeTx` or `SafeMessage`, or a call to
 *     `execTransaction`) a token or `{ safe }` under every caller, main's
 *     included; without one it is `not_authorized` (`no_token`), before the
 *     key (so while locked too). Main's own other signatures sign on its
 *     word. `{ standing }` answers only a page, and never a Safe's
 *     signature (`no_rule`), and `approval.check` never covers a Safe's
 *     request but a Safe account's.
 *   - x402's store is the core's (X402-1, cored 0.18.0; X402-2: `grant_moved`
 *     names `x402`): `approval.grants` reads an origin's caps as main's
 *     mirror takes them, `approval.revoke` drops one (`{ cap: { chain_id,
 *     asset } }`, any case) or all (`"grant"`) under the chrome or main;
 *     `x402.authorize` (main only) pays with a token, spent against exactly
 *     the tab, detection, URL, entry, account and grant it binds (the grant
 *     written after the signature, then a covering cap charged), or under
 *     `{ cap: { agent, attributable } }` the first entry a live cap covers,
 *     charged before the signature (`agent` is `custody`, not attributable
 *     `no_rule`, none covering `cap`; a locked vault charges nothing), and
 *     replies `{ payload, reservation, accept_index, charged, grant? }`;
 *     `x402.settle` gives a reservation's charge back (`withheld`) only to
 *     the cap generation it was taken from, or keeps it (`sent`), once
 *     (an unknown reservation is `invalid_argument`). cored 0.19.0
 *     (X402-2b): `sent` for a cap's payment whose cap was revoked, or
 *     revoked and granted again, since its charge is `cap_changed`; a
 *     `device: { kind, address }` payment uses no key (a locked vault
 *     doesn't stop it) and replies `{ device: { typed_data, hash },
 *     reservation, accept_index, charged }` (simulated typed data, and a
 *     sha256 digest the device's signature must recover over), then
 *     `x402.settle { reservation, signature }` checks it (`wrong_account`,
 *     `bad_response`, with `refunded`; the reservation spent) and replies
 *     `{ payload, charged, grant? }`, a token's grant and charge written
 *     then; and `x402.update` narrows a cap, each field given strictly
 *     (`forbidden` otherwise; a page's `forbidden`). `seedCap`, `cap`,
 *     `setX402Locked`, `setX402Signer` and `openReservations` drive it.
 * Every call is recorded in `calls` as `{ method, params, page }`.
 */
const crypto = require('crypto');
const { TypedDataEncoder, recoverAddress } = require('ethers');
const { normalizeOrigin } = require('../../src/shared/origin-utils');
const { VAULT_LOCKED_MESSAGE } = require('../../src/main/wallet/vault-errors');

const PAGE_KINDS = new Set(['dapp-send', 'sign-message', 'sign-typed-data', 'safe-message']);
const MAX_OUTSTANDING = 32;
// Q9: a limited rule answers for 30 days of the wall clock.
const RULE_TTL_MS = 2_592_000_000;

const coded = (message, code) => Object.assign(new Error(message), { code });

// `execTransaction`'s selector: a transaction whose data starts with it is a
// Safe's, whatever its `to` (cored 0.16.0, APR-4b).
const EXEC_TRANSACTION = '0x6a761202';
const SAFE_TYPES = ['SafeTx', 'SafeMessage'];

/**
 * The caller a request's context names, as vault-backend sends it: a page's
 * PageContext (an object) is `page`, `'chrome'` the chrome, and none main
 * itself (`shell`). Only a PageContext is a page: the chrome's sentinel is
 * not one.
 */
function callerOf(context) {
  if (context === 'chrome') return 'chrome';
  return context !== null && typeof context === 'object' ? 'page' : 'shell';
}

/** The PageContext a page's request carries, or null under another caller. */
const pageContext = (context) => (callerOf(context) === 'page' ? context : null);

/**
 * Whether a signature is a Safe's, as the core tells (APR-4b): typed data
 * whose `types` declare `SafeTx` or `SafeMessage`, primary or not, or a
 * transaction whose data calls `execTransaction`.
 */
function isSafes(method, request) {
  if (method === 'sign.transaction') {
    return typeof request?.tx?.data === 'string' && request.tx.data.toLowerCase().startsWith(EXEC_TRANSACTION);
  }
  if (method === 'sign.typed_data') {
    const types = request?.typed_data?.types;
    return Boolean(types) && typeof types === 'object' && SAFE_TYPES.some((name) => Object.hasOwn(types, name));
  }
  return false;
}

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
// A finalize receipt's life and count (cored 0.16.0, "A device send's rule").
const RECEIPT_LIFE_MS = 600000;
const MAX_RECEIPTS = 64;

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

  const pageOf = (context, handle) => {
    const page = pageContext(context);
    return page ? { origin: page.origin, frame: page.frame, navigation: page.navigation, handle } : null;
  };
  const holderOf = (context) => {
    const page = pageContext(context);
    return page ? { origin: page.origin, frame: page.frame, navigation: page.navigation } : null;
  };
  const digestOf = (kind, account, payload, page) =>
    stable({ kind, account: account ?? null, facts: facts(kind, payload), page: page ?? null });

  // The page of the last token `take` spent, when it was a flagged dApp
  // send's.
  let remembered = null;
  // Finalize receipts: id -> { document, account, rule, expiresAt }.
  const receipts = new Map();
  const dropReceipts = (drop) => {
    for (const [id, entry] of receipts) if (drop(entry)) receipts.delete(id);
  };
  // The rule `sign.transaction` would write for a send: to, selector, chain, value.
  const proposedRule = (tx) => ({
    to: typeof tx?.to === 'string' ? tx.to : null,
    selector: typeof tx?.data === 'string' && /^0x[0-9a-fA-F]{8}/.test(tx.data) ? tx.data.slice(0, 10) : null,
    chainId: tx?.chain_id === undefined || tx?.chain_id === null ? null : Number(tx.chain_id),
    value: tx?.value ?? '0',
  });
  // The rule a flagged send asked for, written for `key` as the core writes
  // it (`token-remember`), and its reply.
  function writeRule(key, account, rule) {
    if (!dapp.exposes(key, account)) return { added: false, reason: 'not_exposed' };
    if (!rule.to || !rule.selector || !Number.isSafeInteger(rule.chainId) || rule.chainId < 1) {
      return { added: false, reason: 'no_rule' };
    }
    dapp.allowTransaction(key, rule.to, rule.selector, rule.chainId, rule.value);
    return { added: true };
  }

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

  // x402's caps (X402-1): origin -> [{ chainId, asset (lowercase), capAmount,
  // spentAmount, createdAt, expiresAt, generation }], and the reservations
  // of their charges: id -> { origin, chainId, asset, amount, generation }.
  const x402Caps = new Map();
  const reservations = new Map();
  let capGenerations = 0;
  let x402Locked = false;
  // `(params, accept) => payload`, or null for the default authorization.
  let x402Signer = null;
  const nowSeconds = () => Math.floor(wallNow() / 1000);
  const capRecord = (origin, cap) => ({
    origin,
    chainId: cap.chainId,
    asset: cap.asset,
    capAmount: cap.capAmount,
    spentAmount: cap.spentAmount,
    createdAt: cap.createdAt,
    expiresAt: cap.expiresAt,
  });
  // The cap key the core computes from a paid URL: its origin.
  function capKeyOf(url) {
    try {
      const parsed = new URL(url);
      return normalizeOrigin(parsed.origin === 'null' ? url : parsed.origin) || null;
    } catch {
      return null;
    }
  }
  function tupleOf(accept) {
    const match = typeof accept?.network === 'string' ? /^eip155:(\d+)$/.exec(accept.network) : null;
    if (!match || typeof accept.amount !== 'string' || !/^\d+$/.test(accept.amount) || typeof accept.asset !== 'string') {
      return null;
    }
    return { chainId: Number(match[1]), asset: accept.asset.toLowerCase(), amount: accept.amount };
  }
  function findCap(origin, chainId, asset) {
    return (x402Caps.get(origin) || []).find((cap) => cap.chainId === chainId && cap.asset === String(asset).toLowerCase());
  }
  function covering(origin, accept) {
    const tuple = tupleOf(accept);
    const cap = tuple ? findCap(origin, tuple.chainId, tuple.asset) : null;
    const t = nowSeconds();
    if (!cap || !(cap.createdAt <= t && t < cap.expiresAt)) return null;
    return BigInt(tuple.amount) <= BigInt(cap.capAmount) - BigInt(cap.spentAmount) ? { cap, tuple } : null;
  }
  // Charges the cap covering `accept`: its reservation, or null for none.
  // `byCap`: a cap's payment (`authorization: { cap }`), which `sent` holds
  // to the cap it charged (`cap_changed`, cored 0.19.0).
  function chargeCap(origin, accept, { byCap = false } = {}) {
    const found = covering(origin, accept);
    if (!found) return null;
    const { cap, tuple } = found;
    cap.spentAmount = (BigInt(cap.spentAmount) + BigInt(tuple.amount)).toString();
    while (reservations.size >= 64) reservations.delete(reservations.keys().next().value);
    const id = crypto.randomBytes(16).toString('hex');
    reservations.set(id, {
      origin,
      chainId: cap.chainId,
      asset: cap.asset,
      amount: tuple.amount,
      generation: cap.generation,
      charged: true,
      byCap,
    });
    return id;
  }
  // A reservation's charge given back, only to the cap it was taken from:
  // a revoke drops its generation. Whether it was.
  function refund(held) {
    if (!held?.charged) return false;
    const cap = findCap(held.origin, held.chainId, held.asset);
    if (!cap || cap.generation !== held.generation) return false;
    const spent = BigInt(cap.spentAmount);
    const amount = BigInt(held.amount);
    cap.spentAmount = (spent >= amount ? spent - amount : 0n).toString();
    return true;
  }
  // The device path's typed data (cored 0.19.0, `x402.authorize { device }`),
  // simulated: EIP-3009's shape, and a digest of it the device's signature
  // must recover over (the real core's is its EIP-712 hash).
  function deviceTypedData(device, accept) {
    const t = nowSeconds();
    const typedData = {
      domain: { name: accept.extra?.name ?? '', version: accept.extra?.version ?? '', chainId: tupleOf(accept)?.chainId, verifyingContract: accept.asset },
      types: { TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }] },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: device.address,
        to: accept.payTo,
        value: accept.amount,
        validAfter: String(t - 600),
        validBefore: String(t + (accept.maxTimeoutSeconds ?? 60)),
        nonce: '0x' + crypto.randomBytes(32).toString('hex'),
      },
    };
    return { typed_data: typedData, hash: '0x' + crypto.createHash('sha256').update(stable(typedData)).digest('hex') };
  }
  function writeCap(origin, chainId, asset, capAmount, windowSeconds, createdAt = nowSeconds()) {
    const caps = (x402Caps.get(origin) || []).filter((cap) => !(cap.chainId === chainId && cap.asset === asset.toLowerCase()));
    caps.push({
      chainId,
      asset: asset.toLowerCase(),
      capAmount,
      spentAmount: '0',
      createdAt,
      expiresAt: createdAt + windowSeconds,
      generation: ++capGenerations,
    });
    x402Caps.set(origin, caps);
    return caps[caps.length - 1];
  }
  function signPayment(params, accept) {
    if (x402Signer) return x402Signer(params, accept);
    const t = nowSeconds();
    return {
      x402Version: params.requirements?.x402Version ?? 2,
      payload: {
        authorization: {
          from: '0x' + (Number(params.account) + 1).toString(16).padStart(40, '0'),
          to: accept.payTo,
          value: accept.amount,
          validAfter: String(t - 600),
          validBefore: String(t + (accept.maxTimeoutSeconds ?? 60)),
          nonce: '0x' + crypto.randomBytes(32).toString('hex'),
        },
        signature: '0x' + 'ab'.repeat(65),
      },
      accepted: accept,
    };
  }

  // A device's reservation, waiting for its signature: what the payment
  // binds, and the typed data's digest the signature must recover over.
  function awaitSignature(device, accept, index, typed, { reservation, origin, grant }) {
    let id = reservation;
    if (!id) {
      while (reservations.size >= 64) reservations.delete(reservations.keys().next().value);
      id = crypto.randomBytes(16).toString('hex');
      reservations.set(id, { origin, charged: false, byCap: false });
    }
    Object.assign(reservations.get(id), {
      awaiting: { device, accept, index, hash: typed.hash, message: typed.typed_data.message, grant, origin },
    });
    return id;
  }

  const x402 = {
    async authorize(params, context = null) {
      calls.push({ method: 'x402.authorize', params, page: context });
      if (callerOf(context) !== 'shell') throw coded('x402.authorize: main only', 'forbidden');
      const { account, device, detection, requirements, authorization, accept_index: acceptIndex, grant } = params ?? {};
      const accepts = Array.isArray(requirements?.accepts) ? requirements.accepts : [];
      const origin = capKeyOf(detection?.url);
      if (!origin || typeof detection?.id !== 'string' || !Number.isSafeInteger(detection?.tab)) {
        throw coded('detection: invalid', 'invalid_argument');
      }
      if (
        device !== undefined &&
        (!['ledger', 'phone'].includes(device?.kind) || !/^0x[0-9a-fA-F]{40}$/.test(device?.address ?? ''))
      ) {
        throw coded('device: invalid', 'invalid_argument');
      }
      let grantReply;
      if (authorization?.cap) {
        if (acceptIndex !== undefined || grant !== undefined) {
          throw coded("a cap's payment takes no accept_index or grant", 'invalid_argument');
        }
        if (authorization.cap.agent === true) throw refused('custody');
        if (authorization.cap.attributable !== true) throw refused('no_rule');
        // A device's payment uses no key: a locked vault doesn't stop it.
        if (x402Locked && !device) throw new Error(VAULT_LOCKED_MESSAGE);
        const index = accepts.findIndex((accept) => covering(origin, accept));
        if (index < 0) throw refused('cap');
        // The charge comes first: nothing is signed without it.
        const reservation = chargeCap(origin, accepts[index], { byCap: true });
        if (device) {
          const typed = deviceTypedData(device, accepts[index]);
          awaitSignature(device, accepts[index], index, typed, { reservation, origin });
          return { device: typed, reservation, accept_index: index, charged: true };
        }
        try {
          const payload = signPayment(params, accepts[index]);
          return { payload, reservation, accept_index: index, charged: true };
        } catch (err) {
          await x402.settle({ reservation, outcome: 'withheld' });
          throw err;
        }
      }
      if (typeof authorization?.token !== 'string') throw refused('no_token');
      // Spent against exactly what it binds, burnt whatever the outcome.
      take(authorization.token, 'shell', (entry) =>
        entry.kind === 'x402-payment'
          ? { account, payload: { detection, accept_index: acceptIndex, accept: accepts[acceptIndex], grant }, page: null }
          : null
      );
      if (device) {
        // A token's grant and charge wait for the device's signature.
        const typed = deviceTypedData(device, accepts[acceptIndex]);
        const reservation = awaitSignature(device, accepts[acceptIndex], acceptIndex, typed, { origin, grant });
        return { device: typed, reservation, accept_index: acceptIndex, charged: false };
      }
      if (x402Locked) throw new Error(VAULT_LOCKED_MESSAGE);
      const index = acceptIndex;
      const payload = signPayment(params, accepts[index]);
      if (grant) {
        const tuple = tupleOf(accepts[index]);
        if (!tuple || !/^\d+$/.test(grant.cap_amount ?? '') || !Number.isSafeInteger(grant.window_seconds) || grant.window_seconds < 1) {
          grantReply = { added: false, reason: 'invalid' };
        } else {
          writeCap(origin, tuple.chainId, tuple.asset, grant.cap_amount, grant.window_seconds);
          grantReply = { added: true };
        }
      }
      const reservation = chargeCap(origin, accepts[index]);
      return {
        payload,
        reservation,
        accept_index: index,
        charged: reservation !== null,
        ...(grantReply ? { grant: grantReply } : {}),
      };
    },
    async settle(params, context = null) {
      calls.push({ method: 'x402.settle', params, page: context });
      if (callerOf(context) !== 'shell') throw coded('x402.settle: main only', 'forbidden');
      const held = reservations.get(params?.reservation);
      if (!held) throw coded('reservation: unknown', 'invalid_argument');
      if ((params.signature === undefined) === (params.outcome === undefined)) {
        throw coded('signature and outcome: exactly one', 'invalid_argument');
      }
      if (params.signature !== undefined) return settleSignature(params.reservation, held, params.signature);
      if (params.outcome !== 'sent' && params.outcome !== 'withheld') throw coded('outcome: unknown', 'invalid_argument');
      // `sent` before a device's signature: refused, the reservation kept.
      if (held.awaiting && params.outcome === 'sent') throw coded('sent before the signature', 'invalid_argument');
      reservations.delete(params.reservation);
      if (params.outcome === 'sent') {
        // A cap's payment goes out only while the cap it charged stands.
        if (held.byCap) {
          const cap = findCap(held.origin, held.chainId, held.asset);
          if (!cap || cap.generation !== held.generation) throw refused('cap_changed');
        }
        return { refunded: false };
      }
      return { refunded: refund(held) };
    },
    /** `x402.update`: a cap's narrowing (cored 0.19.0), the chrome's or main's. */
    async update(params, context = null) {
      calls.push({ method: 'x402.update', params, page: context });
      if (callerOf(context) === 'page') throw coded("a page doesn't narrow x402's caps", 'forbidden');
      const { key, cap: which, cap_amount: capAmount, window_seconds: windowSeconds } = params ?? {};
      if (capAmount === undefined && windowSeconds === undefined) throw coded('nothing to narrow', 'invalid_argument');
      if (capAmount !== undefined && !/^(0|[1-9]\d*)$/.test(capAmount ?? '')) throw coded('cap_amount: invalid', 'invalid_argument');
      if (windowSeconds !== undefined && (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1)) {
        throw coded('window_seconds: invalid', 'invalid_argument');
      }
      const cap = findCap(key, which?.chain_id, which?.asset);
      if (!cap) throw coded('no such cap', 'invalid_argument');
      // Each field given strictly narrower, or nothing is written.
      if (capAmount !== undefined && !(BigInt(capAmount) < BigInt(cap.capAmount))) throw coded('not a narrowing', 'forbidden');
      if (windowSeconds !== undefined && !(cap.createdAt + windowSeconds < cap.expiresAt)) throw coded('not a narrowing', 'forbidden');
      if (capAmount !== undefined) cap.capAmount = capAmount;
      if (windowSeconds !== undefined) cap.expiresAt = cap.createdAt + windowSeconds;
      return { cap: capRecord(key, cap) };
    },
  };

  // `x402.settle { reservation, signature }`: the device's answer, checked
  // as PHN-1 checks a phone's (it must recover to the device's address over
  // the digest). Refused, the reservation is spent and its charge given back.
  function settleSignature(id, held, signature) {
    const awaiting = held.awaiting;
    if (!awaiting) throw coded('reservation: not waiting for a signature', 'invalid_argument');
    const refuse = (reason) => {
      reservations.delete(id);
      return Object.assign(refused(reason), { data: { reason, refunded: refund(held) } });
    };
    if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw refuse('bad_response');
    let signer;
    try {
      signer = recoverAddress(awaiting.hash, signature);
    } catch {
      throw refuse('bad_response');
    }
    if (signer.toLowerCase() !== awaiting.device.address.toLowerCase()) throw refuse('wrong_account');
    delete held.awaiting;
    let grantReply;
    let charged = held.charged === true;
    if (!held.charged) {
      // A token's payment: the grant as bound, then a cap that covers it charged.
      if (awaiting.grant) {
        const tuple = tupleOf(awaiting.accept);
        writeCap(awaiting.origin, tuple.chainId, tuple.asset, awaiting.grant.cap_amount, awaiting.grant.window_seconds);
        grantReply = { added: true };
      }
      const found = covering(awaiting.origin, awaiting.accept);
      if (found) {
        const { cap, tuple } = found;
        cap.spentAmount = (BigInt(cap.spentAmount) + BigInt(tuple.amount)).toString();
        Object.assign(held, { chainId: cap.chainId, asset: cap.asset, amount: tuple.amount, generation: cap.generation, charged: true });
        charged = true;
      }
    }
    // The payment, the device's signature in it exactly as it answered.
    const payload = { x402Version: 2, payload: { authorization: { ...awaiting.message }, signature }, accepted: awaiting.accept };
    return { payload, charged, ...(grantReply ? { grant: grantReply } : {}) };
  }

  const approval = {
    async issue(params, context = null) {
      calls.push({ method: 'approval.issue', params, page: context });
      const { kind, account, payload, handle } = params;
      const caller = callerOf(context);
      // A Safe send is a page's when it names a site, which its page says.
      // The chrome mints no kind.
      const pageKind = PAGE_KINDS.has(kind) || (kind === 'safe-send' && caller === 'page');
      if (caller === 'chrome' || pageKind !== (caller === 'page')) {
        throw Object.assign(new Error("this caller can't confirm this kind"), { code: 'forbidden' });
      }
      if (caller === 'page' && !/^[0-9a-f]{64}$/.test(handle ?? '')) {
        throw Object.assign(new Error('A page confirmation needs its handle'), { code: 'invalid_argument' });
      }
      while (tokens.size >= MAX_OUTSTANDING) tokens.delete(tokens.keys().next().value);
      const token = crypto.randomBytes(32).toString('hex');
      const bound = pageOf(context, handle);
      const entry = {
        kind,
        account,
        minter: caller,
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
      // Spent only by the caller kind that minted it: the chrome, which
      // mints none, spends none.
      const spent = take(token, callerOf(context), (entry) => (entry.kind === kind ? { account, payload, page } : null));
      remembered = null;
      // A flagged dApp send spent here, under its page, is a device's: a
      // receipt, no rule.
      const holder = holderOf(context);
      if (holder && kind === 'dapp-send' && spent.remember === true) {
        while (receipts.size >= MAX_RECEIPTS) receipts.delete(receipts.keys().next().value);
        const receipt = crypto.randomBytes(16).toString('hex');
        receipts.set(receipt, {
          document: holder,
          account,
          rule: proposedRule(payload?.tx),
          expiresAt: now() + RECEIPT_LIFE_MS,
        });
        return { bound: true, receipt };
      }
      if (kind === 'safe-send' || kind === 'safe-message') {
        const safe = crypto.randomBytes(16).toString('hex');
        const holder = holderOf(context);
        // A Safe's new send approval ends its older one.
        if (kind === 'safe-send') {
          for (const [id, entry] of safes) if (entry.kind === kind && entry.account === account) safes.delete(id);
        }
        safes.set(safe, { kind, account, holder });
        return { bound: true, safe };
      }
      return { bound: true };
    },
    // A device send's "Always allow" (cored 0.16.0): its receipt, presented
    // once by the document it was given to.
    async remember(params, context = null) {
      calls.push({ method: 'approval.remember', params, page: context });
      if (callerOf(context) !== 'page') throw coded('approval.remember: page only', 'forbidden');
      const receipt = params?.receipt;
      const entry = typeof receipt === 'string' ? receipts.get(receipt) : undefined;
      if (typeof receipt === 'string') receipts.delete(receipt);
      if (typeof receipt !== 'string' || Object.keys(params).length !== 1) {
        throw coded('receipt: required', 'invalid_argument');
      }
      if (!entry) throw refused('unknown_token');
      if (entry.expiresAt <= now()) throw refused('expired');
      if (stable(holderOf(context)) !== stable(entry.document)) throw refused('mismatch');
      return { rule: writeRule(entry.document.origin, entry.account, entry.rule) };
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
      // The method table admits `approval.check` from a page only.
      if (callerOf(context) !== 'page') {
        throw Object.assign(new Error('a standing rule answers only a page'), { code: 'forbidden' });
      }
      const answer = standing(context, params) || noRule();
      // No rule answers a Safe's signature (APR-4b) but a Safe account's
      // own: the page's prompt does.
      const { request = {} } = params;
      const method = { transaction: 'sign.transaction', typed_data: 'sign.typed_data' }[request.kind];
      if (answer.covered === true && request.account_kind !== 'safe' && isSafes(method, request)) return noRule();
      return answer.covered === true ? { covered: true } : { covered: false, reason: answer.reason ?? 'no_rule' };
    },
    // The dApp store's writes (APB-2): a page's for its own key, main's own
    // as `shell`.
    async grant(params, context = null) {
      calls.push({ method: 'approval.grant', params, page: context });
      const { store, change } = params;
      // The core admits `approval.grant` from a page or main, never the chrome.
      if (context === 'chrome') throw coded('approval.grant: not open to the chrome', 'forbidden');
      if (store !== 'dapp' || callerOf(context) !== 'page') throw coded("this caller can't write this store's grants", 'forbidden');
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
      if (store === 'x402') {
        if (callerOf(context) === 'page') throw coded("a page doesn't revoke x402's caps", 'forbidden');
        const caps = x402Caps.get(key) || [];
        let kept;
        if (what === 'grant') kept = [];
        else if (what?.cap) {
          const asset = String(what.cap.asset).toLowerCase();
          kept = caps.filter((cap) => !(cap.chainId === what.cap.chain_id && cap.asset === asset));
        } else throw coded('what: unknown for this store', 'invalid_argument');
        if (kept.length > 0) x402Caps.set(key, kept);
        else x402Caps.delete(key);
        return { revoked: kept.length !== caps.length };
      }
      if (store !== 'dapp') throw coded('not moved', 'not_moved');
      if (callerOf(context) === 'page' && context.origin !== key) {
        throw coded('a page revokes only its own grant', 'forbidden');
      }
      let revoked;
      // Every dApp revoke for the key drops its receipts (a narrowing wins).
      dropReceipts((entry) => entry.document.origin === key);
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
      if (callerOf(context) !== 'page') throw coded('only a page marks its own use', 'forbidden');
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
      dropReceipts((entry) => entry.account === walletIndex || keys.includes(entry.document.origin));
      return { keys };
    },
    async grants(params) {
      calls.push({ method: 'approval.grants', params, page: null });
      if (params.store === 'x402') {
        const keys = params.key !== undefined ? [params.key] : [...x402Caps.keys()];
        return { records: keys.flatMap((key) => (x402Caps.get(key) || []).map((cap) => capRecord(key, cap))) };
      }
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
    const caller = callerOf(page);
    const safeSignature = isSafes(method, request);
    if (!authorization) {
      // APR-4 (cored 0.16.0): a page's (or the chrome's) signature needs its
      // authorization, and a Safe's one under every caller; main's own
      // other signatures sign on its word.
      if (caller !== 'shell' || safeSignature) throw refused('no_token');
      return null;
    }
    if (authorization.safe !== undefined) {
      // A Safe approval: open, presented by its holder, for an owner's typed
      // data or the executor's transaction, which ends it.
      const entry = safes.get(authorization.safe);
      if (!entry) throw refused('unknown_token');
      // A page presents its own, main the wallet's; the chrome holds none.
      if (caller === 'chrome' || stable(holderOf(page)) !== stable(entry.holder) || method === 'sign.message') {
        throw refused('mismatch');
      }
      if (method === 'sign.transaction') {
        if (entry.kind !== 'safe-send') throw refused('mismatch');
        if (executorRefusal) throw refused(executorRefusal);
        safes.delete(authorization.safe);
      }
      return null;
    }
    if (authorization.standing) {
      // A standing rule answers only a page, and never a Safe's signature
      // (cored 0.16.0; `forbidden` from main or the chrome before).
      if (caller !== 'page' || safeSignature) throw refused('no_rule');
      const kind = method === 'sign.transaction' ? 'transaction' : method === 'sign.message' ? 'message' : 'typed_data';
      const answer = standing(page, { request: { kind, account, ...request }, paused: authorization.standing.paused }) || noRule();
      if (answer.covered !== true) throw refused(answer.reason ?? 'no_rule');
      return null;
    }
    const { token, handle, intent } = authorization;
    const bound = pageOf(page, handle);
    // A token is spent only by the caller kind that minted it.
    const minter = caller;
    const underPage = caller === 'page';
    if (method === 'sign.transaction') {
      take(token, minter, (entry) => {
        if (intent) {
          if (entry.kind !== 'intent-replace' || underPage || authorization.kind !== undefined) return null;
          return { account, payload: { intent_id: intent.id, sender: entry.sender, tx: request.tx }, page: null };
        }
        // A send's token names the kind it was minted as (design 0012,
        // "Naming the kind").
        if (authorization.kind !== entry.kind) return null;
        const fits = underPage ? entry.kind === 'dapp-send' : entry.kind === 'wallet-send' || entry.kind === 'executor-send';
        return fits ? { account, payload: { tx: request.tx }, page: bound } : null;
      });
      // A flagged dApp send: the core writes the limited contract rule for
      // the page's key as it signs (design 0012, The model, APB-2).
      const flagged = remembered;
      remembered = null;
      if (!flagged) return null;
      return writeRule(flagged.origin, account, proposedRule(request.tx));
    } else if (method === 'sign.message') {
      take(token, minter, (entry) =>
        entry.kind === 'sign-message' && underPage ? { account, payload: { message: request.message }, page: bound } : null
      );
    } else {
      const { expected_hash: expectedHash, ...payload } = request;
      const entry = take(token, minter, (candidate) =>
        candidate.kind === 'sign-typed-data' && underPage ? { account, payload, page: bound } : null
      );
      if (entry.hash !== expectedHash) throw refused('mismatch');
    }
    return null;
  }

  return {
    approval,
    x402,
    authorize,
    calls,
    /** A cap as the core holds it: `{ origin, chainId, asset, capAmount, spentAmount?, createdAt?, expiresAt? | windowSeconds? }`. */
    seedCap({ origin, chainId, asset, capAmount, spentAmount = '0', createdAt = nowSeconds() - 60, expiresAt, windowSeconds = 86400 }) {
      const cap = writeCap(origin, chainId, asset, capAmount, (expiresAt ?? createdAt + windowSeconds) - createdAt, createdAt);
      cap.spentAmount = spentAmount;
      return capRecord(origin, cap);
    },
    /** The cap the core holds now, or null. */
    cap(origin, chainId, asset) {
      const cap = findCap(origin, chainId, asset);
      return cap ? capRecord(origin, cap) : null;
    },
    setX402Locked(locked) {
      x402Locked = locked === true;
    },
    setX402Signer(fn) {
      x402Signer = typeof fn === 'function' ? fn : null;
    },
    openReservations: () => reservations.size,
    outstanding: () => tokens.size,
    openReceipts: () => receipts.size,
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
      safes.set(safe, { kind, account, holder: holderOf(page) });
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
      receipts.clear();
      dapp.entries.clear();
      x402Caps.clear();
      reservations.clear();
      x402Locked = false;
      x402Signer = null;
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
