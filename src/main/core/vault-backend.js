/**
 * The single module every vault and key consumer imports (freedom-core
 * design 0001, "Migration in freedom-browser"). It talks to freedom-cored
 * through the CoreClient; no key material is kept here.
 *
 * - Secret fields travel as base64 of their UTF-8 bytes (`Buffer.from(s,
 *   'utf8')`, as passworder does), and come back the same way (`mnemonic_b64`)
 *   or as `private_key_hex`.
 * - Core errors become `Error`s with the JS message (the core sends the
 *   parity strings) and a `code`. The key store's and the secrets file's
 *   errors (design 0013) get main's own message, a cause and a way forward
 *   (key-store-messages.js), with the core's `code` and `data` kept.
 * - Vault mutations run one at a time (design 0001, "Reconciliation"), so
 *   the `vault.status` recorded before each belongs to exactly that
 *   operation. If the core dies before replying, this waits for the
 *   restarted core and asks `vault.reconcile` whether the mutation committed.
 *   If the core can't come back, the operation stays pending: it is settled,
 *   with its continuation, as soon as the core is ready again, and no other
 *   mutation runs before that.
 * - Every request runs under its method's hang watchdog (core-deadlines.js):
 *   15 s for an immediate method, 45 s on the vault queue. A core that hangs
 *   past it is killed and restarted, which fails the request
 *   `core_unavailable`, so a mutation reconciles as after a crash. A
 *   request that drives a Ledger (design 0016) goes only through
 *   `ledgerCall`, under the device watchdog its params give it. A Ledger
 *   key's `sign.*` (LDG-3, on the core's Ledger backend) is sent so by
 *   `deviceCall`, opened in main's relay for the core's `shell.ledger_apdu`
 *   (ledger-relay.js) as it is written.
 */

const log = require('../logger');
const { getCoreClient, getLedgerRelay } = require('./core-process');
const { deviceWatchdogMs, drivesDevice, isDeviceMethod, watchdogMs } = require('./core-deadlines');
const { keyStoreMessage } = require('./key-store-messages');
const { requiresStore } = require('./core-client');

const CORE_UNAVAILABLE = 'core_unavailable';
// The intent journal is the core's (design 0013, PRF-6(b)): its requests go
// only to a core whose hello echoed `intents`.
const INTENTS = Object.freeze({ requires: requiresStore('intents') });
// payment-history.sqlite is the core's (design 0013, PRF-6(c)): its requests
// go only to a core whose hello echoed `payments`.
const PAYMENTS = Object.freeze({ requires: requiresStore('payments') });
// The JavaScript classes a payment-history refusal names (`data.name`).
const PAYMENT_ERROR_CLASSES = Object.freeze({ Error, TypeError, RangeError, SyntaxError });
// `vault-meta.json` is the core's (design 0013, PRF-6(a)): its requests,
// and `vault.create`'s and `vault.import`'s, which write it with the vault,
// go only to a core whose hello echoed `vault_meta`.
const VAULT_META = requiresStore('vault_meta');
// `safe-pending.json` is the core's (design 0013, PRF-6(d)): its requests go
// only to a core whose hello echoed `safe_pending`.
const SAFE_PENDING = requiresStore('safe_pending');
// The RPC-key requests' `requires` (PRF-6(e)).
const RPC_KEYS = Object.freeze({ requires: requiresStore('rpc_api_keys') });
// The mutations that write vault-meta.json with the vault, and so their
// reconcile too.
const META_OPS = new Set(['create', 'import']);
// @scure/bip39 strengths (bits) and their word counts.
const WORDS_BY_STRENGTH = { 128: 12, 160: 15, 192: 18, 224: 21, 256: 24 };

class VaultBackendError extends Error {
  constructor(code, message, data) {
    super(message);
    this.name = 'VaultBackendError';
    this.code = code;
    this.data = data;
  }
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

function unb64(value) {
  return Buffer.from(value, 'base64').toString('utf8');
}

function client() {
  const core = getCoreClient();
  if (!core) throw new VaultBackendError(CORE_UNAVAILABLE, 'The identity core is not running');
  return core;
}

/**
 * Whether `page` is a PageContext the core can decode (fc-protocol's
 * `PageContext`): `origin` and `top_origin` strings, `frame` and
 * `navigation` unsigned integers, `agent` a boolean or absent, and
 * `transport_key` (cored 0.21.0, for a DNS name over IPNS) a string or
 * absent. The core reads any other as a protocol error and exits, failing
 * every request in flight. A keyless document has no key to send: from cored 0.18.0 the core
 * answers an empty `origin` `invalid_argument` on every page method but
 * `eip1193.request`, and main sends no page method for one (the page
 * providers refuse it first).
 */
function decodablePage(page) {
  return (
    typeof page === 'object' &&
    typeof page.origin === 'string' &&
    typeof page.top_origin === 'string' &&
    Number.isSafeInteger(page.frame) &&
    page.frame >= 0 &&
    Number.isSafeInteger(page.navigation) &&
    page.navigation >= 0 &&
    (page.agent == null || typeof page.agent === 'boolean') &&
    (page.transport_key == null || typeof page.transport_key === 'string')
  );
}

/** A request's context: main itself (`shell`), the chrome's relayed
 * (`'chrome'`), or a page's with its PageContext (`call`). */
function contextOf(page) {
  if (page === 'chrome') return { caller: 'chrome' };
  if (!page) return { caller: 'shell' };
  if (decodablePage(page)) return { caller: 'page', page };
  throw new VaultBackendError('invalid_argument', 'A page request needs its page’s context');
}

/** A request's failure as a VaultBackendError, the key store's and the
 * secrets file's with main's own message (`call`). */
function backendError(err) {
  if (err instanceof VaultBackendError) return err;
  const code = err.code || CORE_UNAVAILABLE;
  return new VaultBackendError(code, keyStoreMessage(code, err.data) ?? err.message, err.data);
}

/**
 * One core request under its watchdog: from main itself (caller `shell`), or
 * for a page's request under `page` with its PageContext (freedom-core
 * designs 0011 and 0012, "PageContext"): `{ origin, top_origin, frame,
 * navigation, agent, transport_key? }`. `'chrome'` relays the chrome's own request (a
 * grant's narrowing from its settings: design 0012, "The model"). A
 * PageContext the core couldn't decode (a null `origin`, say) is refused
 * here, `invalid_argument`, and never sent: it would end the core.
 *
 * `requires` is the shared client's (service-client.js): a set-A store's
 * requests (design 0013, "One writer per store") pass
 * `requiresStore(name)` (core-client.js), so a core whose hello didn't
 * echo the store fails them `requirement_unmet` in main, unsent. Null
 * (the default) for every other request.
 *
 * The watchdog is the method's (`watchdogMs`), which takes no params. A
 * request that drives a Ledger (design 0016, `drivesDevice`: a Ledger
 * key's `sign.*`, every `ledger.*`, `x402.settle { reservation,
 * typed_data }`) would be killed at its 15 s, so it is refused here,
 * `invalid_argument`, unsent: it goes through `ledgerCall`.
 */
async function call(method, params = {}, page = null, { requires = null } = {}) {
  const context = contextOf(page);
  try {
    if (isDeviceMethod(method) && drivesDevice(method, params)) {
      throw new VaultBackendError('invalid_argument', 'A Ledger request goes through ledgerCall');
    }
    return await client().request(method, params, context, {
      watchdogMs: watchdogMs(method),
      requires,
    });
  } catch (err) {
    throw backendError(err);
  }
}

/**
 * Why main can't derive a Ledger's stream for a request (ledger-relay.js
 * `prepare`'s `reason`), as the core refuses the same before its first
 * APDU (design 0016, "Bounds", API, "Errors"): what a Ledger can't carry is
 * `device_failed` with its `LEDGER_*` code; anything else is invalid.
 */
const UNPREPARED_CODES = Object.freeze({
  'device-bounds': 'LEDGER_TOO_LARGE',
  'empty-message': 'LEDGER_EMPTY_MESSAGE',
  'not-canonical': 'LEDGER_TYPE_NOT_CANONICAL',
});

function unprepared({ rule, reason }) {
  const ledger = Object.hasOwn(UNPREPARED_CODES, reason) ? UNPREPARED_CODES[reason] : null;
  if (ledger) return new VaultBackendError('device_failed', 'Ledger device failed', { ledger });
  const message =
    reason === 'hash-mismatch'
      ? 'The typed data changed after it was confirmed'
      : "A Ledger can't sign this request";
  return new VaultBackendError('invalid_argument', message, { rule, reason });
}

/**
 * A Ledger key's `sign.*` (freedom-core design 0016, "Accounts", API;
 * LDG-3's PR 7), on the core's Ledger backend: `params.key` is `{ kind:
 * 'ledger', index, path, address }`, `path` the account's path from main's
 * own record snapshot (`getWalletRecord`, the LDG-3 plan's point 2). The
 * core builds every APDU and sends each to main as one `shell.ledger_apdu`;
 * main's relay (ledger-relay.js) admits each against the stream main
 * derives here itself, before the request is sent (`prepare`), and carries
 * it to the device:
 * - **Refused unsent** when main can't derive the stream (`unprepared`):
 *   what a Ledger can't carry (`LEDGER_TOO_LARGE`, `LEDGER_EMPTY_MESSAGE`,
 *   `LEDGER_TYPE_NOT_CANONICAL`, as the core's `device_failed` would name
 *   it), typed data that isn't the confirmed hash's, or a path that isn't
 *   one of the schemes'. Nothing is presented, so a token stays unspent
 *   (its caller discards it).
 * - **Sent with `ledgerCall`**, under the device watchdog (point 3) and
 *   with `requires: vault_meta` (D9: the core reads the Ledger's record
 *   only once `vault-meta.json` is its own, `not_moved` otherwise), and
 *   opened in the relay from its `onSent`, before the core can ask
 *   anything for it.
 * - `beforeSign`, the caller's last check, is held by the relay before the
 *   first APDU after `B0 01` (point 7); its refusal is main's own cancel,
 *   and the caller gets that refusal, not the cancel. `hashOnlySurface` is
 *   the hash-only warning's (point 12; LDG-3's PR 11). `signal` is main's
 *   own cancel (the user's Cancel, point 5): the core is told, and the
 *   relay closes the device at once.
 * - The parent's end closes it in the relay, whatever the response.
 *
 * `page` is `call`'s.
 */
async function deviceCall(
  method,
  params,
  page = null,
  { beforeSign = null, hashOnlySurface = null, signal = null } = {}
) {
  const relay = getLedgerRelay();
  if (!relay) throw new VaultBackendError(CORE_UNAVAILABLE, 'The identity core is not running');
  const prepared = relay.prepare({ method, params, path: params?.key?.path });
  if (!prepared.ok) throw unprepared(prepared);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let handle = null;
  let unopened = null;
  try {
    return await ledgerCall(method, params, page, {
      signal: controller.signal,
      requires: VAULT_META,
      onSent: (id, generation) => {
        try {
          handle = relay.open({ id, generation }, { prepared, controller, beforeSign, hashOnlySurface });
        } catch (err) {
          // Its APDUs would all be refused: main cancels it at once.
          unopened = err;
          controller.abort();
        }
      },
    });
  } catch (err) {
    // The caller's last check refused it: its own error, not the cancel.
    if (handle?.stopped) throw handle.stopped;
    if (unopened) throw unopened;
    throw err;
  } finally {
    signal?.removeEventListener('abort', cancel);
    handle?.close();
  }
}

/**
 * A request of a device-class method (freedom-core design 0016, D7) under
 * the watchdog its params give it (core-deadlines.js `deviceWatchdogMs`):
 * one that drives a Ledger (`drivesDevice`) goes with the client's device
 * watchdog, 5 minutes and 15 s until its first `shell.ledger_apdu` (7
 * minutes and 15 s for a Ledger owner's Safe signature), which main's
 * relay sets again at each APDU and each answer (service-client.js
 * `watchdogReset`, keyed by what `onSent` reports); any other goes with
 * its plain watchdog. LDG-3's Ledger flows send through this.
 *
 * `ledgerOwner`: whether a `safe.sign_owner` or `safe.message_sign`
 * names a Ledger owner, from main's record of it. `page` and `requires`
 * are `call`'s; `onSent` and `signal` the client's (service-client.js
 * `requestTo`).
 */
async function ledgerCall(
  method,
  params,
  page = null,
  { ledgerOwner = false, onSent = null, signal = null, requires = null } = {}
) {
  const context = contextOf(page);
  try {
    const ms = deviceWatchdogMs(method, params, { ledgerOwner });
    const watchdog = drivesDevice(method, params, { ledgerOwner })
      ? { deviceWatchdogMs: ms }
      : { watchdogMs: ms };
    return await client().request(method, params, context, {
      ...watchdog,
      onSent,
      signal,
      requires,
    });
  } catch (err) {
    throw backendError(err);
  }
}

/**
 * A `safe_pending.*` request (design 0013, PRF-6(d)), main's own, with
 * `requires: SAFE_PENDING`. With `mark` (`coreProcess()`), it goes to that
 * very process or nowhere: one that has ended, or a client main has
 * replaced, fails it `core_unavailable`, unsent, so a request meant for one
 * process's copy of the store never reaches its successor. Without one, to
 * whichever process serves.
 */
async function safePendingCall(method, params, mark) {
  if (!mark) return call(method, params, null, { requires: SAFE_PENDING });
  try {
    if (getCoreClient() !== mark.core) {
      throw new VaultBackendError(CORE_UNAVAILABLE, 'The identity core is not running');
    }
    return await mark.core.requestTo(mark.gen, method, params, { caller: 'shell' }, {
      watchdogMs: watchdogMs(method),
      requires: SAFE_PENDING,
    });
  } catch (err) {
    if (err instanceof VaultBackendError) throw err;
    const code = err.code || CORE_UNAVAILABLE;
    throw new VaultBackendError(code, err.message, err.data);
  }
}

/**
 * An intent-journal request (`intents.*`, design 0013, "The intent
 * journal"), always main's own (`shell`: the core refuses every one from
 * the chrome or a page). It goes with `requires: INTENTS`, so a core that
 * didn't take the store fails it `requirement_unmet` in main, unsent. A
 * rule's refusal (`invalid_argument`), a failed append and a load that
 * can't read the file (`storage`) carry the reference's `INTENT_*` code as
 * `data.code`: that code becomes the error's, with the reference's
 * message, so callers keep branching on today's codes (`INTENT_NOT_HELD`,
 * `INTENT_CHANGED`, `INTENT_STORE_FULL`, …). Anything else keeps its own
 * code: `core_unavailable` for a request whose reply was lost, whose
 * outcome is then unknown (main never sends it again: design 0013's
 * coordinator call G9).
 */
async function intentsCall(method, params) {
  try {
    return await call(method, params, null, INTENTS);
  } catch (err) {
    const code = err.data?.code;
    if (typeof code === 'string' && code.startsWith('INTENT_')) {
      throw new VaultBackendError(code, err.message, err.data);
    }
    throw err;
  }
}

/**
 * A payment-history request (`payments.*`, design 0013, "Payment history"),
 * from main itself (`caller` null: `shell`) or relayed for the chrome
 * (`'chrome'`, which the core takes only for `get_recent`, `get_by_id`,
 * `get_count` and `clear`). It goes with `requires: PAYMENTS`, so a core
 * that didn't take the store fails it `requirement_unmet` in main, unsent.
 * A refusal is `invalid_argument` with payment-history.js's message and its
 * class as `data.name`: it is thrown again as that class (coordinator call
 * G13), with the core's code and data, so callers see what the module threw
 * before. A database the core can't use is `storage` with `{ store:
 * 'payments', kind }`, and that and anything else keep their own code:
 * `core_unavailable` for a request whose reply was lost, whose outcome is
 * then unknown (main never sends it again: G9).
 */
async function paymentsCall(method, params, caller = null) {
  try {
    return await call(method, params, caller, PAYMENTS);
  } catch (err) {
    const name = err.code === 'invalid_argument' ? err.data?.name : undefined;
    if (typeof name === 'string' && Object.hasOwn(PAYMENT_ERROR_CLASSES, name)) {
      const ErrorClass = PAYMENT_ERROR_CLASSES[name];
      throw Object.assign(new ErrorClass(err.message), { code: err.code, data: err.data });
    }
    throw err;
  }
}

/**
 * A `vault-meta.json` request (`accounts.*`, design 0013, "`vault-meta.json`"),
 * from main itself (`caller` null: `shell`) or relayed for the chrome
 * (`'chrome'`). It goes with `requires: VAULT_META`, so a core that didn't
 * take the store fails it `requirement_unmet` in main, unsent. A refusal is
 * `invalid_argument` with the reference's message, and its `err.code` as
 * `data.code` where it set one: that code becomes the error's, so callers
 * keep branching on today's codes (`LEDGER_ACCOUNT_UNCHECKED`,
 * `SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE`, …).
 */
async function accountsCall(method, params, caller = null) {
  try {
    return await call(method, params, caller, { requires: VAULT_META });
  } catch (err) {
    if (err.code === 'invalid_argument' && typeof err.data?.code === 'string') {
      throw new VaultBackendError(err.data.code, err.message, err.data);
    }
    throw err;
  }
}

/** `params` with `name` when one is given: absent means the core's default. */
function named(params, name) {
  return name === undefined ? params : { ...params, name };
}

/**
 * `sign.*`'s caller and `authorization` (freedom-core design 0012, API):
 * `{ token, handle? }`, or `{ token, intent: { id } }` for an
 * intent-replace, or `{ standing: { paused? } }` for a request a site's
 * standing rule answers, checked by the core before any key is derived; a
 * page's under `page` with its PageContext. None, from main itself, as
 * before.
 */
function signed(params, { authorization = null } = {}) {
  return authorization ? { ...params, authorization } : params;
}

/**
 * A `sign.*` request: a Ledger key's through the relay (`deviceCall`),
 * any other key's as `call` sends it.
 */
function signCall(method, params, options) {
  if (params.key?.kind === 'ledger') {
    return deviceCall(method, params, options.page || null, {
      beforeSign: options.beforeSign || null,
      hashOnlySurface: options.hashOnlySurface || null,
      signal: options.signal || null,
    });
  }
  return call(method, params, options.page);
}

// ---- lock tracking (for reconciliation's `install`) ----

// Counts locks main requested and `vault.locked` events, across core
// generations. A reconciled mutation installs its secrets only if none
// happened since it started: an acknowledged lock is never undone.
let locks = 0;
let watchedClient = null;

function watchCore() {
  const core = getCoreClient();
  if (!core || core === watchedClient) return;
  watchedClient = core;
  core.on('event', (name) => {
    if (name === 'vault.locked') locks += 1;
  });
  // A lost mutation is settled as soon as the core is back.
  core.on('ready', () => {
    if (pending) drain();
  });
}

// ---- mutations: one at a time, with reconciliation ----

// Everything from settling an earlier lost mutation, through the status
// snapshot and the call, to reconciliation and its continuation, runs in
// this queue. Locks, unlocks and reads stay outside it.
let queue = Promise.resolve();

function serialized(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

/**
 * A mutation whose reply was lost and that isn't settled yet:
 * `{ op, password, mnemonic?, install, before, locksAtStart, onCommitted? }`.
 * `found` is set once reconciliation has established the commit; the record
 * stays until its continuation has succeeded too.
 */
let pending = null;

/** A mutation's `requires`: `VAULT_META` for a create or an import. */
function requiresFor(op) {
  return META_OPS.has(op) ? VAULT_META : null;
}

/**
 * Whether the lost mutation committed: its committed result, or null. A
 * create's or an import's carries `meta` (design 0013, "The vault and its
 * metadata, one write"): `"written"`, or `"pending"` while the core's
 * journal waits for its recovery to install the metadata. Main writes
 * nothing for either.
 */
async function reconcile(record) {
  const result = await call(
    'vault.reconcile',
    {
      op: record.op,
      fingerprint_before: record.before,
      password_b64: b64(record.password),
      ...(record.mnemonic ? { mnemonic_b64: b64(record.mnemonic) } : {}),
      install: record.install && locks === record.locksAtStart,
    },
    null,
    { requires: requiresFor(record.op) }
  );
  if (result.status !== 'committed') return null;
  if (result.meta === 'pending') {
    log.warn(
      "[VaultBackend] A lost vault operation committed; the core's recovery installs its metadata"
    );
  }
  return result;
}

/**
 * Settles the pending mutation, if any: reconciles it (throws while the core
 * is still down), then runs its continuation (a failure keeps it pending, to
 * be retried). Returns `{ record, found }` when it had committed.
 */
async function settlePending() {
  if (!pending) return null;
  const record = pending;
  if (!record.found) {
    const found = await reconcile(record);
    if (!found) {
      pending = null;
      return null;
    }
    record.found = found;
  }
  if (record.onCommitted) await record.onCommitted(record.found);
  pending = null;
  return { record, found: record.found };
}

// What an automatic settlement found, kept briefly for a caller that retries
// the same request (see mutate). Consumed by the next mutation.
let lastSettled = null;
let lastSettledTimer = null;
const SETTLED_KEEP_MS = 5 * 60_000;

function keepSettled(settled) {
  clearTimeout(lastSettledTimer);
  lastSettled = settled;
  if (!settled) return;
  lastSettledTimer = setTimeout(() => {
    lastSettled = null;
  }, SETTLED_KEEP_MS);
  lastSettledTimer.unref?.();
}

function drain() {
  serialized(async () => keepSettled(await settlePending())).catch((err) => {
    log.warn('[VaultBackend] A lost vault operation is still unsettled', { code: err.code });
  });
}

function sameRequest(a, b) {
  return (
    a.op === b.op && a.password === b.password && (a.mnemonic || null) === (b.mnemonic || null)
  );
}

/**
 * Runs a vault mutation with lost-reply reconciliation.
 * @param {string} method
 * @param {object|Function} params - or a function returning them, called
 *   after `precheck`
 * @param {object} record - { op, password, mnemonic?, install, onCommitted? }
 * @param {Function} [precheck] - runs once earlier work is settled
 */
function mutate(method, params, record, precheck) {
  watchCore();
  return serialized(async () => {
    const settled = (await settlePending()) || lastSettled;
    keepSettled(null);
    // The same request again (a retry after `core_unavailable`) gets the
    // result its first attempt committed.
    if (settled && sameRequest(settled.record, record)) {
      return { ...settled.found, reconciled: true };
    }
    if (precheck) await precheck();
    const request = typeof params === 'function' ? params() : params;
    const status = await call('vault.status');
    const full = { ...record, before: status.fingerprint, locksAtStart: locks };
    try {
      return await call(method, request, null, { requires: requiresFor(record.op) });
    } catch (err) {
      // Error replies always mean "not committed"; only a missing reply needs
      // reconciliation.
      if (err.code !== CORE_UNAVAILABLE) throw err;
      let found;
      try {
        await client().whenReady();
        found = await reconcile(full);
      } catch {
        pending = full;
        throw err;
      }
      if (!found) throw err;
      return { ...found, reconciled: true };
    }
  });
}

// ---- local checks main keeps (parity with the JS it replaces) ----

/** `createMnemonic(strength = 256)` → @scure/bip39's argument errors. */
function wordsFor(strength = 256) {
  if (typeof strength !== 'number') {
    throw new TypeError(`expected number, got ${typeof strength}`);
  }
  if (!Number.isInteger(strength) || strength < 0) {
    throw new RangeError(`expected integer >= 0, got ${strength}`);
  }
  if (strength % 32 !== 0 || strength > 256) throw new RangeError('Invalid entropy');
  const words = WORDS_BY_STRENGTH[strength];
  if (!words) throw new RangeError('invalid entropy length');
  return words;
}

// ---- the API ----

const vaultBackend = {
  /** `{ exists, unlocked, epoch, fingerprint }` */
  status() {
    return call('vault.status');
  },

  async generateMnemonic(strength) {
    const words = wordsFor(strength);
    const result = await call('keys.generate_mnemonic', { words });
    return unb64(result.mnemonic_b64);
  },

  async validateMnemonic(mnemonic) {
    if (!mnemonic || typeof mnemonic !== 'string' || !mnemonic.isWellFormed()) return false;
    const result = await call('keys.validate_mnemonic', { mnemonic_b64: b64(mnemonic) });
    return result.valid === true;
  },

  /**
   * The vault and its `vault-meta.json`, written by the core as one
   * operation (design 0013, PRF-6(a)), and only on a core that took
   * `vault_meta` (`requirement_unmet` on any other, nothing written).
   * @returns {{ mnemonic: string, addresses: { user_wallet, bee_wallet } }}
   * @param {boolean} [userKnowsPassword] - the metadata's
   *   `userKnowsPassword` (false for Quick Setup), required by the core
   * @param {Function} [onCommitted] - continuation if the reply was lost and
   *   the core only came back later
   */
  async createVault(password, strength = 256, { userKnowsPassword = true, onCommitted } = {}) {
    let words;
    const result = await mutate(
      'vault.create',
      () => ({ password_b64: b64(password), words, user_knows_password: userKnowsPassword }),
      { op: 'create', password, install: true, onCommitted },
      // JS order: an existing vault, then the strength, then the password.
      async () => {
        if ((await call('vault.status')).exists) {
          throw new VaultBackendError(
            'vault_exists',
            'Vault already exists. Use importVault to replace.'
          );
        }
        words = wordsFor(strength);
      }
    );
    return { mnemonic: unb64(result.mnemonic_b64), addresses: result.addresses };
  },

  /**
   * The vault and its `vault-meta.json`, as `createVault` writes them.
   * @param {boolean} [userKnowsPassword] - as `createVault`'s
   * @param {boolean} [quickUnlock] - Quick Setup (design 0013, "The re-wrap's
   *   two entries"): the core writes quick unlock's credential for the new
   *   vault before the vault commits, so the vault never exists without it
   */
  async importVault(
    password,
    mnemonic,
    { overwrite = false, quickUnlock = false, userKnowsPassword = true, onCommitted } = {}
  ) {
    if (typeof mnemonic !== 'string' || !mnemonic.isWellFormed()) {
      throw new VaultBackendError('invalid_mnemonic', 'Invalid mnemonic');
    }
    const result = await mutate(
      'vault.import',
      {
        password_b64: b64(password),
        mnemonic_b64: b64(mnemonic),
        overwrite,
        user_knows_password: userKnowsPassword,
        ...(quickUnlock ? { quick_unlock: true } : {}),
      },
      { op: 'import', password, mnemonic, install: true, onCommitted }
    );
    return { addresses: result.addresses };
  },

  /** @returns {{ addresses: { user_wallet, bee_wallet } }} */
  unlock(password) {
    watchCore();
    return call('vault.unlock', { password_b64: b64(password) });
  },

  /**
   * Runs `task` on the mutation queue: no create, import, password change
   * or delete starts until it settles, and it starts only after those
   * already queued (0013 PRF-2b, PRF-2d: quick-unlock.dat is checked
   * against the vault, used and removed under it). Unlocks, reads and quick_unlock.* stay outside
   * the queue, so `task` may call them. Never call it from inside a
   * mutation's own continuation (`onCommitted`): it would wait on itself.
   */
  whileVaultHeld(task) {
    return serialized(task);
  },

  async lock() {
    watchCore();
    locks += 1;
    await call('vault.lock');
  },

  /** Restarts the auto-lock timer if unlocked. Fire and forget. */
  touch() {
    call('vault.touch').catch(() => {});
  },

  async verifyPassword(password) {
    await call('vault.verify_password', { password_b64: b64(password) });
  },

  /** Error order as JS: no vault → … → incorrect password → weak new one. */
  async changePassword(current, next) {
    await mutate(
      'vault.change_password',
      { password_b64: b64(current), new_password_b64: b64(next) },
      { op: 'change_password', password: next, install: false }
    );
  },

  async deleteVault(password) {
    await mutate(
      'vault.delete',
      { password_b64: b64(password) },
      { op: 'delete', password, install: false }
    );
  },

  /** Verifies the password, then needs the vault unlocked. */
  async exportMnemonic(password) {
    const result = await call('vault.export_mnemonic', { password_b64: b64(password) });
    return unb64(result.mnemonic_b64);
  },

  /** @returns {string} 0x private key */
  async exportPrivateKey(password, account) {
    const result = await call('vault.export_private_key', {
      password_b64: b64(password),
      account,
    });
    return result.private_key_hex;
  },

  // ---- quick unlock (design 0013, "The re-wrap"; cored 0.17.0) ----
  //
  // The vault password in the core's key store. `enroll` is main's own
  // (`shell`), with a password main has: one it unsealed from
  // quick-unlock.dat, or one the user typed. The rest are the chrome's
  // (`chrome`), each after main's Touch ID prompt; the password never comes
  // back to main.

  /** `{ enabled, policy, available }`, from the core's view of the file. */
  quickUnlockStatus() {
    return call('quick_unlock.status', {}, 'chrome');
  },

  /** Writes the credential for this vault; the password is checked first. */
  async quickUnlockEnroll(password) {
    await call('quick_unlock.enroll', { password_b64: b64(password) });
  },

  /** Unlocks with the credential, as `unlock` answers: `{ addresses }`. */
  quickUnlock() {
    watchCore();
    return call('quick_unlock.unlock', {}, 'chrome');
  },

  /** Unlocks with the credential, then exports, with no password. */
  async quickExportMnemonic() {
    watchCore();
    const result = await call('quick_unlock.export_mnemonic', {}, 'chrome');
    return unb64(result.mnemonic_b64);
  },

  /** @returns {string} 0x private key */
  async quickExportPrivateKey(account) {
    watchCore();
    const result = await call('quick_unlock.export_private_key', { account }, 'chrome');
    return result.private_key_hex;
  },

  /** Removes the credential (both names); its key is forgotten after. */
  async quickUnlockDisable() {
    await call('quick_unlock.disable', {}, 'chrome');
  },

  /**
   * `vault-meta.json`'s methods (design 0013, "`vault-meta.json`";
   * cored 0.23.0), one per change identity-manager.js made to it before
   * PRF-6(a). The core writes the file alone, in today's text; main reads it
   * only for its synchronous lookups. `caller` is `'chrome'` for a request
   * the chrome made over IPC and null (`shell`) for main's own; the device,
   * phone and Safe methods are main's only. A write may answer `durable:
   * false` (written, not yet flushed).
   */
  accounts: {
    /** `getDerivedWallets()`: the list, its first-list default written once. */
    async list(caller = null) {
      return (await accountsCall('accounts.list', {}, caller)).wallets;
    },
    /** The whole file (`identity:get-vault-meta`), or null without one. */
    async meta(caller = null) {
      return (await accountsCall('accounts.meta', {}, caller)).meta;
    },
    /** `getActiveWalletIndex()`. */
    async active(caller = null) {
      return (await accountsCall('accounts.active', {}, caller)).index;
    },
    /** A mnemonic account at the core's next index, needing the vault unlocked: `{ index, name, address }`. */
    async addMnemonic(name, caller = null) {
      return (await accountsCall('accounts.add_mnemonic', named({}, name), caller)).wallet;
    },
    /** A Ledger record main read back from the device at `path`, `matched`. */
    async addLedger({ name, address, path }) {
      return (await accountsCall('accounts.add_ledger', named({ address, path }, name))).wallet;
    },
    /** A phone record whose account the phone proved, `matched`. */
    async addRemote({ name, address }) {
      return (await accountsCall('accounts.add_remote', named({ address }, name))).wallet;
    },
    /**
     * What a device's answer showed about a `'ledger'` or `'remote'`
     * record: its check state after it (a matched record stays matched),
     * or null for no such record.
     */
    async recordAddressCheck(type, index, matched) {
      return (await accountsCall('accounts.record_address_check', { type, index, matched }))
        .address_check;
    },
    /** A Safe record over existing owners, under the reference's checks. */
    async addSafe({ name, address, owners, threshold, saltNonce }) {
      const params = named({ address, owners, threshold, salt_nonce: saltNonce }, name);
      return (await accountsCall('accounts.add_safe', params)).wallet;
    },
    /** A Safe's verified deployment on `chainId`: `{ verified: true }`. */
    async markSafeDeployed(index, chainId) {
      await accountsCall('accounts.mark_safe_deployed', { index, chain_id: chainId });
    },
    async setActive(index, caller = null) {
      await accountsCall('accounts.set_active', { index }, caller);
    },
    /** The name as given. */
    async rename(index, name, caller = null) {
      await accountsCall('accounts.rename', named({ index }, name), caller);
    },
    /**
     * Removes an account, in one request: the refusals (the main wallet, a
     * Safe's owner, and an account the Swarm feeds in `swarmReferences`
     * still name, `[{ origin, … }]` as main's feed store found them); for a
     * Safe, its open Safe approvals ended; the account's dApp grants
     * forgotten (a forget that fails refuses the removal); then the
     * record. The Swarm refusal gets back the references main passed
     * (`err.references`), as before.
     */
    async remove(index, swarmReferences = [], caller = null) {
      try {
        await accountsCall('accounts.remove', { index, swarm_references: swarmReferences }, caller);
      } catch (err) {
        if (err.code === 'SWARM_PUBLISHER_IDENTITY_WALLET_IN_USE') err.references = swarmReferences;
        throw err;
      }
    },
  },

  /**
   * The Ledger's account methods (design 0016, Accounts; LDG-3's PR 8),
   * main's own (`shell`), each one operation on the core's device lane:
   * sent through `ledgerCall`, under the device watchdog, with `onSent` and
   * `signal` the relay's (wallet/ledger/core-accounts.js opens the parent
   * from `onSent`). Both go with `requires: vault_meta`: `ledger.add`
   * writes its record through the core's accounts store, and
   * `ledger.accounts` checks the core's own unmatched records (D1), which
   * the core reads only once the store is moved, so the stream main
   * expects is the one that process sends. A refusal of the record's write
   * (`invalid_argument` with `data.code`) takes that code, as an
   * `accounts.*` request's does.
   */
  ledger: {
    /** `ledger.accounts { scheme, start, count }` → `{ accounts, mismatched }`. */
    async accounts(params, { onSent = null, signal = null } = {}) {
      return ledgerCall('ledger.accounts', params, null, { onSent, signal, requires: VAULT_META });
    },
    /** `ledger.add { scheme, index, name? }` → `{ path, address, wallet, durable? }`. */
    async add(params, { onSent = null, signal = null } = {}) {
      try {
        return await ledgerCall('ledger.add', params, null, {
          onSent,
          signal,
          requires: VAULT_META,
        });
      } catch (err) {
        if (err.code === 'invalid_argument' && typeof err.data?.code === 'string') {
          throw new VaultBackendError(err.data.code, err.message, err.data);
        }
        throw err;
      }
    },
  },

  /**
   * The pending Safe transactions, `safe-pending.json` (design 0013,
   * "Pending Safe transactions"; cored 0.23.0), which the core keeps once
   * the hello names `safe_pending` (wallet/safe/pending-store.js is main's
   * copy). Each is main's own (`shell`: the core refuses them from the
   * chrome or a page), with `requires: requiresStore('safe_pending')`, so a
   * core that didn't take the store fails it `requirement_unmet` in main,
   * unsent. `index` is the Safe's wallet index; an entry is any JSON value,
   * kept as main sent it. A failed write is `storage` (and a set past the
   * file's 1 MiB bound `invalid_argument`), the store as it was; a write
   * may answer `durable: false` (written, not yet flushed). Each takes an
   * optional `mark` (`coreProcess()`): the request then goes to that
   * process only, and fails `core_unavailable` once it has ended.
   */
  safePending: {
    /** `getPending(index)`: the entry, or null for none. */
    async get(index, mark = null) {
      return (await safePendingCall('safe_pending.get', { index }, mark)).entry;
    },
    /** `listPendingIndexes()`: the indices with an entry, in the file's key order. */
    async list(mark = null) {
      return (await safePendingCall('safe_pending.list', {}, mark)).indices;
    },
    /** `setPending(index, entry)` → `{ durable }`. */
    set(index, entry, mark = null) {
      return safePendingCall('safe_pending.set', { index, entry }, mark);
    },
    /** `clearPending(index)` → `{ cleared, durable }` (`cleared`: it had an entry). */
    clear(index, mark = null) {
      return safePendingCall('safe_pending.clear', { index }, mark);
    },
  },

  /** Public data only; needs the vault unlocked. */
  addresses({ accounts = [], publishers = [] } = {}) {
    return call('keys.addresses', { accounts, publishers });
  },

  /** @param {Uint8Array|Buffer} publicKey - 32-byte Ed25519 key; works while locked */
  async radicleDid(publicKey) {
    const result = await call('keys.radicle_did', {
      public_key: Buffer.from(publicKey).toString('hex'),
    });
    return result.did;
  },

  /**
   * Signing in the core (freedom-core design 0002). `key` is a reference:
   * `{ kind: 'account', index }` here; Swarm adds `bee_wallet` and
   * `publisher`; design 0016 adds a Ledger's, `{ kind: 'ledger', index,
   * path, address }`, which signs on the core's device lane through main's
   * relay (`deviceCall`; LDG-3, on the core's Ledger backend). Inputs are
   * already in the core's wire form.
   */
  sign: {
    /**
     * `options`: `{ authorization, page }`, the confirmation the core checks
     * and the PageContext of a page's request (`signed`); for a Ledger key
     * also `deviceCall`'s `beforeSign`, `hashOnlySurface` and `signal`.
     * @returns {{ raw: string, hash: string, rule?: object }} `rule`: what
     *   became of a flagged `dapp-send`'s "Always allow" (design 0012)
     */
    transaction(key, tx, options = {}) {
      return signCall('sign.transaction', signed({ key, tx }, options), options);
    },
    /** @param {Uint8Array} bytes @returns {string} 65-byte signature, v 27/28 */
    async message(key, bytes, options = {}) {
      const message = '0x' + Buffer.from(bytes).toString('hex');
      return (await signCall('sign.message', signed({ key, message }, options), options)).signature;
    },
    /**
     * Signs only if the data's digest is `expectedHash`, the hash the user
     * confirmed (or, for main's own typed data, the one main just hashed);
     * any other is refused before a key is touched (freedom-core #88).
     * `options.primaryType` and `options.chainId` are what the core was told
     * beside the data when its token was minted (`typedDataView`): the view
     * the token binds is built again from them.
     * @param {{domain, types, message}} typedData
     * @param {string} expectedHash - 0x and 64 hex digits
     */
    async typedData(key, typedData, expectedHash, options = {}) {
      const params = { key, typed_data: typedData, expected_hash: expectedHash };
      if (options.primaryType !== undefined) params.primary_type = options.primaryType;
      if (options.chainId !== undefined) params.chain_id = options.chainId;
      return (await signCall('sign.typed_data', signed(params, options), options)).signature;
    },
    /**
     * A Swarm single-owner chunk; the core computes the chunk address from
     * the payload. `span` defaults to the payload length (as does 0).
     * A page's SOC (design 0012, "A page's SOC") goes under `page` with its
     * PageContext and `authorization: { swarm, soc }`, which the core checks
     * against the page's Swarm grant before any key is derived; main's own,
     * with neither, as `shell`.
     * @param {{ identifier: Uint8Array, payload: Uint8Array, span?: bigint }} chunk
     * @param {{ page?: object, authorization?: { swarm: 'user'|'auto', soc: 'feed'|'raw' } }} [options]
     * @returns {{ signature, owner, chunk_address, soc_address, span }}
     */
    soc(key, { identifier, payload, span }, options = {}) {
      const params = {
        key,
        identifier: '0x' + Buffer.from(identifier).toString('hex'),
        payload: '0x' + Buffer.from(payload).toString('hex'),
        ...(span !== undefined && span !== null ? { span: String(span) } : {}),
      };
      return call('swarm.sign_soc', signed(params, options), options.page || null);
    },
  },

  /**
   * Design 0012's approval tokens (cored 0.14.0, APR-3), which main mints
   * and spends through the core instead of in JS: a wallet kind from main
   * itself (`shell`), a page kind under `page` with the request's
   * PageContext. The token is a bearer secret: never logged.
   */
  approval: {
    /** `{ kind, account?, payload, handle?, fee_ack?, phone? }` → `{ token, expires_in_ms, hash?, view?, fee_check? }` */
    issue(params, page = null) {
      return call('approval.issue', params, page);
    },
    /**
     * `{ token, kind, account?, payload, handle? }` → `{ bound, safe?, receipt? }`.
     * `receipt`: a flagged `dapp-send` spent under `page` for a device (cored
     * 0.16.0, design 0012 "A device send's rule"), which `remember` presents.
     */
    spend(params, page = null) {
      return call('approval.spend', params, page);
    },
    /**
     * A device send's "Always allow" (cored 0.16.0, design 0012 "A device
     * send's rule"): `spend`'s receipt, presented once, always under `page`
     * with the PageContext the token was spent under, after the device
     * signed and main recorded the send. `{ receipt }` → `{ rule: { added,
     * reason?, durable? } }`. The receipt is a bearer secret: never logged.
     */
    remember(params, page) {
      return call('approval.remember', params, page);
    },
    /** Burns a token whatever it was: `{}` for one spent or unknown too. */
    discard(token) {
      return call('approval.discard', { token });
    },
    /** Ends a Safe approval: `{}` whatever it was. */
    end(safe, page = null) {
      return call('approval.end', { safe }, page);
    },
    /**
     * Whether a site's standing rule would answer a page's request (always
     * under `page`): `{ request, chain_id?, paused? }` → `{ covered, reason? }`.
     * Advice: `sign.*` decides again under `{ standing }`.
     */
    check(params, page) {
      return call('approval.check', params, page);
    },
    /**
     * The permission files' write methods (design 0012, API), for a file in
     * the hello's `grant_moved`: `dapp` from APB-2 (wallet/dapp-permissions.js),
     * `swarm` and `radicle` from APB-3, and `x402`'s revokes from X402-2
     * (core/grants.js). `caller` is a page's PageContext (its own key),
     * `'chrome'` (a narrowing from the chrome's settings) or null (`shell`,
     * main's own: an account deleted, a manifest's projection).
     */
    /** `{ store, change }` → `{ grant, durable? }` */
    grant(params, caller = null) {
      return call('approval.grant', params, caller);
    },
    /** `{ store, key, what }` → `{ revoked, durable? }` */
    revoke(params, caller = null) {
      return call('approval.revoke', params, caller);
    },
    /** A page's last use: `{ store, chain_id? }` → `{ durable? }`, always under `page` */
    touch(params, page) {
      return call('approval.touch', params, page);
    },
    /**
     * A page's Radicle COB write its "always allow writes" rule would answer
     * (cored 0.16.0, design 0012 "A page's Radicle write"), always under
     * `page`, for its own key: `{ key }` → `{ covered, reason? }`. A decision,
     * not advice: a covered write is counted in R-6, and main forwards it.
     */
    radicleWrite(params, page) {
      return call('approval.radicle_write', params, page);
    },
    /** `{ wallet_index }` → `{ keys, durable? }`, main's own */
    forgetAccount(walletIndex) {
      return call('approval.forget_account', { wallet_index: walletIndex });
    },
    /** `{ store, key? }` → `{ records }`, the store as the core holds it */
    grants(params) {
      return call('approval.grants', params);
    },
  },

  /**
   * x402's payments (cored 0.18.0, design 0012 "x402"; X402-2), main's own
   * (`shell`): the core checks the `x402-payment` token or a cap, charges the
   * cap before it signs, builds the payment byte for byte as `@x402/evm`
   * builds it and signs it with the account's vault key, or, for a Ledger or
   * phone account (`device`, cored 0.19.0), gives the typed data its device
   * signs and checks that signature at `settle`; a Ledger's payment made
   * with `now_s` (cored 0.30.0) it signs on its device lane instead, at
   * `settleOnLedger`.
   */
  x402: {
    /**
     * `{ account, device?: { kind, address }, now_s?, detection: { tab, id,
     * url }, requirements, authorization: { token } | { cap: { agent,
     * attributable } }, accept_index?, grant? }` → `{ payload, reservation,
     * accept_index, charged, grant?, durable? }`, or with `device` `{
     * device: { typed_data, hash }, reservation, accept_index, charged,
     * durable? }`. `now_s` (cored 0.30.0, design 0016's D2) only with a
     * Ledger's `device`: main's clock, which the authorization's times
     * are built on. The payload is a signed authorization: never logged.
     */
    authorize(params) {
      return call('x402.authorize', params);
    },
    /**
     * `{ reservation, outcome: 'withheld' | 'sent' }` → `{ refunded, durable? }`;
     * `{ reservation, signature }` (a device's, cored 0.19.0) →
     * `{ payload, charged, grant?, durable? }`, the payload JSON text with
     * the device's signature in it (never logged).
     */
    settle(params) {
      return call('x402.settle', params);
    },
    /**
     * A Ledger payment's `{ reservation, typed_data }` (design 0016, "x402
     * from a Ledger account", D2; cored 0.30.0) → `{ payload, charged,
     * grant?, durable? }`: main's own rebuild of the authorization, which
     * the core signs on its device lane. It drives the device, so it goes
     * through `ledgerCall`, under the device watchdog; `onSent` and
     * `signal` are the client's, for main's relay (x402/caps.js
     * `settleTypedData`). The payload is a signed authorization: never
     * logged.
     */
    settleOnLedger(params, { onSent = null, signal = null } = {}) {
      return ledgerCall('x402.settle', params, null, { onSent, signal });
    },
    /**
     * A cap's narrowing (cored 0.19.0), the chrome's or main's own:
     * `{ key, cap: { chain_id, asset }, cap_amount?, window_seconds? }` →
     * `{ cap, durable? }`. Anything not strictly narrower is `forbidden`.
     */
    update(params, caller = 'chrome') {
      return call('x402.update', params, caller);
    },
  },

  /**
   * The intent journal, `wallet-intents.jsonl` (freedom-core design 0013,
   * "The intent journal"; PRF-6(b)), which the core keeps once the hello
   * names `intents` (wallet/intent-store.js is main's adapter). Members are
   * snake_case, the reference's argument names otherwise; each answer holds
   * the reference's return value as it is (its views' camelCase keys
   * included). Every write that appends a line carries main's `run`
   * (intent-store.js's `RUN_ID`), which the core writes on the line;
   * `void` and `retire` carry `lock: true`, main's word that it holds the
   * account's reservation lock (until 0012's APR-6).
   */
  intents: {
    /** `{ run, chain_id, sender, nonce, hash, raw, via, intent_id?, context? }` → `{ intent }` */
    commit(params) {
      return intentsCall('intents.commit', params);
    },
    /** `{ run, intent_id, hash? }` → `{ handoff: { handoffId, hash, raw } }` */
    handoff(params) {
      return intentsCall('intents.handoff', params);
    },
    /** `{ run, intent_id, handoff_id, outcome, source?, reason_class? }` → `{ intent }` (null for an unknown intent) */
    outcome(params) {
      return intentsCall('intents.outcome', params);
    },
    /** `{ run, intent_id, label, hash?, block, hashes? }` → `{ intent }` */
    settle(params) {
      return intentsCall('intents.settle', params);
    },
    /** `{ run, intent_id, lock }` → `{ intent }` */
    void(params) {
      return intentsCall('intents.void', params);
    },
    /** `{ run, intent_id, block, hashes, lock }` → `{ intent }` */
    retire(params) {
      return intentsCall('intents.retire', params);
    },
    /** `{ run, intent_id, bracket?, unread_since? }` → `{ intent }` */
    track(params) {
      return intentsCall('intents.track', params);
    },
    /** `{ intent_id }` → `{ withdrawn }`: no line, so no `run` */
    withdrawOrigin(params) {
      return intentsCall('intents.withdraw_origin', params);
    },
    /** `{}` → `{}` */
    compact() {
      return intentsCall('intents.compact', {});
    },
    /** `{ intent_id }` → `{ intent }`, null for none */
    get(params) {
      return intentsCall('intents.get', params);
    },
    /** `{ key }` → `{ intent }`, the held intent with that key or null */
    byKey(params) {
      return intentsCall('intents.by_key', params);
    },
    /** `{}` → `{ intents }`, the held ones by account and nonce */
    held() {
      return intentsCall('intents.held', {});
    },
    /** `{}` → `{ intents }` */
    list() {
      return intentsCall('intents.list', {});
    },
    /** `{ chain_id, sender }` → `{ nonces }`, ascending */
    heldNonces(params) {
      return intentsCall('intents.held_nonces', params);
    },
    /** `{}` → `{ usage: { file, owed, budget, limit } }`; the first request loads the store */
    usage() {
      return intentsCall('intents.usage', {});
    },
    /** `{ intent_id, run }` → `{ refusal }`, null when a void of that run would pass (lock aside) */
    voidRefusal(params) {
      return intentsCall('intents.void_refusal', params);
    },
  },

  /**
   * The payment history, `payment-history.sqlite` (design 0013, "Payment
   * history"; cored 0.23.0), which the core keeps once the hello names
   * `payments` (payment-history.js is its client). Each is one function of
   * the module before PRF-6(c), answered as it answered: a record (camelCase,
   * `metadata` parsed) or null, a list of them, a count. `caller` is
   * `'chrome'` for a read or clear the chrome made over IPC and null
   * (`shell`) for main's own; the writes and the repoll's methods are main's
   * only.
   */
  payments: {
    /** `append(entry)`: the record written. */
    async append(entry) {
      return (await paymentsCall('payments.append', { entry })).payment;
    },
    /** `update(id, patch)`: the record, or null when no row has `id`. */
    async update(id, patch) {
      return (await paymentsCall('payments.update', { id, patch })).payment;
    },
    async markConfirmed(id, receipt) {
      return (await paymentsCall('payments.mark_confirmed', { id, receipt })).payment;
    },
    async markFailed(id, info) {
      return (await paymentsCall('payments.mark_failed', { id, info })).payment;
    },
    /** Only a row still pending, read and written in one step: null otherwise. */
    async markDropped(id) {
      return (await paymentsCall('payments.mark_dropped', { id })).payment;
    },
    /**
     * The repoll's sighting of a dropped transaction on a row still pending:
     * `metadata.txDroppedSeenAt` set to `seenAt`, or removed for null.
     */
    async setDroppedSeen(id, seenAt) {
      await paymentsCall('payments.set_dropped_seen', { id, seen_at: seenAt });
    },
    /** The repoll's rows: every pending one, oldest first, as SQLite holds it (snake_case, `metadata` its text). */
    async pending() {
      return (await paymentsCall('payments.pending', {})).payments;
    },
    async getRecent(filters, caller = null) {
      return (await paymentsCall('payments.get_recent', { filters }, caller)).payments;
    },
    async getById(id, caller = null) {
      return (await paymentsCall('payments.get_by_id', { id }, caller)).payment;
    },
    async getCount(filters, caller = null) {
      return (await paymentsCall('payments.get_count', { filters }, caller)).count;
    },
    /** Every row deleted: how many. */
    async clear(caller = null) {
      return (await paymentsCall('payments.clear', {}, caller)).removed;
    },
  },

  /**
   * The RPC API keys (freedom-core design 0013, "RPC API keys"; PRF-6(e)),
   * which the core keeps once the hello names `rpc_api_keys`
   * (wallet/rpc-manager.js). Each request goes with `requires`, so a core
   * that didn't take the store (0.22.0) fails it `requirement_unmet` in
   * main, unsent. `caller` is `'chrome'` (the settings page's, relayed) or
   * null (`shell`, main's own).
   */
  secrets: {
    /** `{}` → `{ keys: [{ id, api_key }] }`, `shell` only. Never logged. */
    rpcApiKeys() {
      return call('secrets.rpc_api_keys', {}, null, RPC_KEYS);
    },
    /** `{}` → `{ providers: [{ id, present }] }`, never a key */
    rpcApiKeyStatus(caller = null) {
      return call('secrets.rpc_api_key_status', {}, caller, RPC_KEYS);
    },
    /** `{ id, api_key }` → `{ providers, durable? }`: replaces the provider's key */
    setRpcApiKey(params, caller = null) {
      return call('secrets.set_rpc_api_key', params, caller, RPC_KEYS);
    },
    /** `{ id }` → `{ providers, durable? }` */
    removeRpcApiKey(params, caller = null) {
      return call('secrets.remove_rpc_api_key', params, caller, RPC_KEYS);
    },
  },

  /**
   * Phone jobs (freedom-core design 0012, PHN-1; cored 0.18.0), which main's
   * bridge relays to the chrome's openlv session (wallet/remote/bridge.js).
   * The core makes each job from a checked authorization, for the
   * webContents main names as `target`, and checks the phone's answer.
   */
  phone: {
    /**
     * `{ account, address, method, payload, target, authorization? }` →
     * `{ job, expires_in_ms, request: { method, params } }`, under `page`
     * with the request's PageContext, or as main's own (`shell`).
     */
    job(params, page = null) {
      return call('phone.job', params, page);
    },
    /** `{ job, sender }` → `{}`: the job marked possibly sent. `sender` is the IPC sender's id, never the message's. */
    sent(params) {
      return call('phone.sent', params, 'chrome');
    },
    /**
     * `{ job, sender, result | error }` → the core's outcome. The chrome's
     * answer goes as `chrome`; main's own timeout as `shell` (`caller` null).
     */
    result(params, caller = 'chrome') {
      return call('phone.result', params, caller);
    },
  },

  /**
   * The core process answering main's requests now, as an opaque mark, or
   * null while none does. What a process keeps only in its memory (design
   * 0012's Safe approvals) ends with it: the next process doesn't know it,
   * and a request still on its way to it fails once it has exited.
   */
  coreProcess() {
    const core = getCoreClient();
    const gen = core?.current ?? null;
    return core && gen && core.serves(gen) ? Object.freeze({ core, gen }) : null;
  },

  /**
   * Whether the process `mark` names (`coreProcess()`) has ended since: it
   * exited, or main stopped its client. Null (none answered then) counts as
   * ended, and anything else that isn't a mark doesn't.
   */
  coreProcessEnded(mark) {
    if (mark === null) return true;
    if (!mark?.core || !mark.gen) return false;
    return mark.gen.exited === true || getCoreClient() !== mark.core;
  },

  /**
   * EIP-712 digest with the core's strict rules, and the core's view of
   * exactly what it signs (freedom-core design 0002, #88): ethers'
   * getPayload, with `ignored`, `named_type` and `chain` reports. Public,
   * works while locked. A view too large for one reply is refused.
   *
   * @param {{domain, types, message}} typedData
   * @param {{primaryType?: *, chainId?: number}} [options] - `primaryType`
   *   as the dApp sent it, whatever its JSON type, only when it sent one;
   *   `chainId`, the dApp's active chain. Neither changes what is signed.
   * @returns {Promise<{hash: string, view: object}>}
   */
  typedDataView(typedData, options = {}) {
    const params = { typed_data: typedData };
    // `null` is a value (it reads `mismatch`); only an absent one is unknown.
    if (options.primaryType !== undefined) {
      params.primary_type = options.primaryType;
    }
    if (Number.isSafeInteger(options.chainId) && options.chainId >= 0) {
      params.chain_id = String(options.chainId);
    }
    return call('typed_data.hash', params);
  },

  /** EIP-712 digest with the core's strict rules; public, works while locked. */
  async typedDataHash(typedData) {
    return (await vaultBackend.typedDataView(typedData)).hash;
  },

  /**
   * The Radicle node key, sealed by the core to the freedom-radicled
   * process's `recipient` (its X25519 public key for this start, base64, as
   * `rad.hello` gave it; freedom-core design 0008, "The sealed release"):
   * `{ enc, ciphertext }`, base64, which main passes on in `rad.identity`
   * and never opens. Main never sees the key. Errors keep the core's codes:
   * `no_vault` (the only answer that leads to a throwaway key), and
   * `vault_locked` while locked, or when a lock came before the reply was
   * handed to the core's writer (the start's boundary).
   */
  async sealRadicleKey(recipient) {
    const { enc, ciphertext } = await call('nodes.seal_radicle_key', { recipient });
    return { enc, ciphertext };
  },

  /**
   * Calls `listener(name, data)` on the core's `vault.unlocked` and
   * `vault.locked` events; returns its unsubscribe. With no core client,
   * nothing is subscribed: `status()` then fails `core_unavailable`.
   */
  onVaultEvent(listener) {
    const core = getCoreClient();
    if (!core) return () => {};
    const onEvent = (name, data) => {
      if (name === 'vault.unlocked' || name === 'vault.locked') listener(name, data);
    };
    core.on('event', onEvent);
    return () => core.removeListener('event', onEvent);
  },

  /**
   * Writes a node identity through the core's journal. `spec` is
   * `{ node: 'bee', data_dir, api_port, p2p_port }`,
   * `{ node: 'radicle', home, alias }` (the key file, for the add-on), or
   * `{ node: 'radicle', home, alias, custody: 'sealed', wipe? }` (no key
   * file; any is removed: freedom-core design 0008, "The switch" and
   * "Identity changes"). A lost reply is resolved with `nodes.op_status`.
   */
  async writeNodeIdentity(spec, opId) {
    try {
      return await call('nodes.write_identity', { op_id: opId, ...spec });
    } catch (err) {
      if (err.code !== CORE_UNAVAILABLE) throw err;
      let status;
      try {
        await client().whenReady();
        ({ status } = await call('nodes.op_status', { op_id: opId }));
      } catch {
        throw err; // outcome unknown
      }
      // Never committed: the caller's node may already be wiped.
      if (status === 'not_committed') throw err;
      // installed, pending_recovery or corrupt; only the status is known.
      return { status, reconciled: true };
    }
  },
};

module.exports = {
  vaultBackend,
  VaultBackendError,
  // For tests.
  _internal: {
    call,
    ledgerCall,
    deviceCall,
    wordsFor,
    reset() {
      locks = 0;
      watchedClient = null;
      pending = null;
      queue = Promise.resolve();
      keepSettled(null);
    },
    hasPending: () => pending !== null,
  },
};
