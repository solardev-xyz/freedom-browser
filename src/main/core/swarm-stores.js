/**
 * Main's typed calls to the Swarm stores in freedom-cored (freedom-core
 * design 0015, "Methods main calls"; SWM-4's D3, D5, D7 and D8; the
 * SWM-6 to SWM-9 plan's PR 6.1): `swarm.identities` (the feed store,
 * `swarm-feeds.json`), `swarm.manifest` (the manifest store,
 * `swarm-manifest-grants.json`, with its projections onto the Swarm grants)
 * and `swarm.history` (the publish history, `publish-history.sqlite`).
 *
 * **Unused until SWM-7's flip.** The core serves these only once a hello
 * names `swarm_stores` (D3; `not_moved` before), and no build's hello does
 * until PR 7.4 (core-client.js `storeMovedFor`). So every call goes with
 * `requires: requiresStore('swarm_stores')`, and on any process whose hello
 * didn't echo the name it fails `requirement_unmet` in main, unsent. PRs
 * 6.2 to 6.4 make feed-store.js, permission-manifests.js and
 * publish-history.js clients of these on the core's backend; nothing in
 * production calls them yet.
 *
 * **The wire form** (D5, D7; fc-swarm-provider's `ops::Members`): params
 * are `{ op, ...members }`, `op` a string naming the op and each member a
 * value in the typed form (swarm-typed.js `writeTyped`), since the
 * reference reads the chrome's IPC values by their JavaScript types. A
 * member whose value is `undefined` is left out: the core reads an absent
 * member as `undefined`, and a string member (a site's key, a token, a URL)
 * as missing. The answer is `{ result_typed }`, the op's result as the
 * reference returned it, or `{ error_typed: { name, message, code? } }`,
 * what it threw: thrown here again as that class (`Error`, `TypeError` or
 * `RangeError`), with its `code` where it had one (`identity_taken`,
 * `store_full`, `history_blob`, …). An answer in any other form is the
 * core's fault: `CoreError` `internal`. The protocol's own errors stay the
 * client's `CoreError`s with their codes: `not_moved` (data.store
 * `swarm_stores`, or `swarm` for a manifest op before the grants moved),
 * `invalid_argument` (an op or member the core doesn't read),
 * `forbidden` (main's own op from the chrome), `busy`, `cancelled`,
 * `core_unavailable` and `requirement_unmet`.
 *
 * **The ops** (`OPS`), as the core defines them, each with its members and
 * who may call it; an op, a member or a caller not listed throws a
 * TypeError here, unsent (main's own bug):
 * - `swarm.identities` (fc-swarm-provider's `ops/identities.rs`): the
 *   chrome's, one per feed-store.js IPC handler, named by its channel,
 *   which main relays as `chrome`; and main's own (D7), shell only, named
 *   by the function main calls: page-swarm.js's feed prompt, its two reads,
 *   and `getEthereumWalletIdentityReferences` for `accounts.remove` (D8).
 * - `swarm.history` (`ops/history.rs`): `list`, `clear` and `remove`, the
 *   chrome's and main's; `add` and `update`, main's own (core PR K1, in
 *   flight: a core without them answers `invalid_argument`).
 * - `swarm.manifest` (`ops/manifest.rs`): main's only (the schema's
 *   callers), the page path's `check`, `decide` and `release`, and the
 *   chrome's three IPC handlers' `get`, `use-individual` and `disconnect`,
 *   which main proxies as `shell`.
 *
 * Each goes under its method's hang watchdog (core-deadlines.js: all three
 * are answered at once). `createSwarmStores({ request })` makes the calls
 * over another sender (a test's simulated core,
 * test/helpers/simulated-swarm-stores-core.js); the module's own
 * `identities`, `history` and `manifest` send to the running core.
 */

const { CoreError, requiresStore, SWARM_STORES } = require('./core-client');
const { watchdogMs } = require('./core-deadlines');
const { readPlain, writeTyped, TypedFormError } = require('./swarm-typed');

const IDENTITIES = 'swarm.identities';
const HISTORY = 'swarm.history';
const MANIFEST = 'swarm.manifest';

const BOTH = Object.freeze(['chrome', 'shell']);
const SHELL = Object.freeze(['shell']);

function op(members, callers) {
  return Object.freeze({ members: Object.freeze(members), callers });
}

/**
 * Each method's ops: their members (the core's names) and their callers.
 * Members a site's key (`origin`, `key`), a token, a URL or an outcome are
 * strings to the core, and `eager` and `live` booleans; every other member
 * is the JavaScript value the reference reads.
 */
const OPS = Object.freeze({
  [IDENTITIES]: Object.freeze({
    // The chrome's (feed-store.js `registerFeedStoreIpc`).
    'get-all-origins': op([], BOTH),
    'has-feed-identity': op(['origin'], BOTH),
    'get-identity-mode': op(['origin'], BOTH),
    'get-origin-identities': op(['origin'], BOTH),
    'create-app-scoped-identity': op(['origin', 'options'], BOTH),
    'ensure-ant-wallet-identity': op(['origin', 'options'], BOTH),
    'activate-feed-identity': op(['origin', 'identity_id'], BOTH),
    'set-feed-identity': op([], BOTH),
    'revoke-feed-access': op(['origin'], BOTH),
    // Main's own (D7, D8).
    getOriginIdentityStateWithOwners: op(['key'], SHELL),
    previewAppScopedIdentity: op(['key', 'options'], SHELL),
    createAppScopedIdentityAt: op(['key', 'index', 'options'], SHELL),
    ensureAntWalletIdentity: op(['key', 'options'], SHELL),
    activateIdentity: op(['key', 'identity_id'], SHELL),
    grantFeedAccess: op(['key'], SHELL),
    hasFeedGrant: op(['key'], SHELL),
    assertFeedGrantable: op(['key'], SHELL),
    getEthereumWalletIdentityReferences: op(['wallet_index'], SHELL),
  }),
  [HISTORY]: Object.freeze({
    list: op([], BOTH),
    clear: op([], BOTH),
    remove: op(['id'], BOTH),
    // Main's own (core PR K1).
    add: op(['entry'], SHELL),
    update: op(['id', 'updates'], SHELL),
  }),
  [MANIFEST]: Object.freeze({
    check: op(['key', 'url', 'eager'], SHELL),
    decide: op(['key', 'token', 'outcome', 'live'], SHELL),
    release: op(['token'], SHELL),
    get: op(['origin'], SHELL),
    'use-individual': op(['origin', 'capability'], SHELL),
    disconnect: op(['origin'], SHELL),
  }),
});

// Every call's `requires`: only a process whose hello echoed the name.
const REQUIRES = requiresStore(SWARM_STORES);

// The classes a store op throws (fc-swarm-provider's `ErrorName`).
const ERROR_CLASSES = Object.freeze({ Error, TypeError, RangeError });

/**
 * The params of `method`'s `op` with `members`, for `caller`: `{ op,
 * ...typed members }`, each member written by `writeTyped`, one that is
 * undefined left out. Throws a TypeError for an op, a member or a caller
 * `OPS` doesn't list, and `writeTyped`'s TypedFormError for a member no
 * store holds.
 *
 * @param {string} method
 * @param {string} name - the op
 * @param {object} [members]
 * @param {'chrome'|'shell'} [caller]
 * @returns {object}
 */
function storeParams(method, name, members = {}, caller = 'shell') {
  const ops = Object.hasOwn(OPS, method) ? OPS[method] : null;
  if (!ops) throw new TypeError(`${method} is no Swarm store method`);
  const spec = typeof name === 'string' && Object.hasOwn(ops, name) ? ops[name] : null;
  if (!spec) throw new TypeError(`${method} has no op ${name}`);
  if (!spec.callers.includes(caller)) {
    throw new TypeError(`${method} ${name} is not for the ${caller}`);
  }
  if (members === null || typeof members !== 'object' || Array.isArray(members)) {
    throw new TypeError(`${method} ${name}: members must be an object`);
  }
  const params = { op: name };
  for (const key of Object.keys(members)) {
    if (!spec.members.includes(key)) {
      throw new TypeError(`${method} ${name} takes no member ${key}`);
    }
    if (members[key] !== undefined) params[key] = writeTyped(members[key]);
  }
  return params;
}

/** A malformed answer: the core's fault. */
function malformed(method, why) {
  return new CoreError('internal', `The core's ${method} answer is malformed: ${why}`);
}

/**
 * What a store op threw (`{ name, message, code? }`, typed), as an Error of
 * its class, with its code where it had one; anything else is malformed.
 */
function thrownError(method, value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(method, 'error_typed is not an object');
  }
  const { name, message, code } = value;
  const extra = Object.keys(value).filter((k) => !['name', 'message', 'code'].includes(k));
  if (
    typeof name !== 'string' ||
    !Object.hasOwn(ERROR_CLASSES, name) ||
    typeof message !== 'string' ||
    (Object.hasOwn(value, 'code') && typeof code !== 'string') ||
    extra.length > 0
  ) {
    throw malformed(method, 'error_typed is not { name, message, code? }');
  }
  const err = new ERROR_CLASSES[name](message);
  if (Object.hasOwn(value, 'code')) err.code = code;
  return err;
}

/**
 * `method`'s answer read: the result, or what the op threw, thrown again
 * (`thrownError`). Throws `CoreError` `internal` for any other form.
 *
 * @param {string} method
 * @param {*} answer - the request's result
 * @returns {*}
 */
function readStoreAnswer(method, answer) {
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) {
    throw malformed(method, 'not an object');
  }
  const keys = Object.keys(answer);
  if (keys.length !== 1 || (keys[0] !== 'result_typed' && keys[0] !== 'error_typed')) {
    throw malformed(method, 'not { result_typed } or { error_typed }');
  }
  let value;
  try {
    value = readPlain(answer[keys[0]]);
  } catch (err) {
    if (err instanceof TypedFormError) throw malformed(method, err.message);
    throw err;
  }
  if (keys[0] === 'error_typed') throw thrownError(method, value);
  return value;
}

/** The running core's request, or `core_unavailable`. */
function coreRequest(method, params, context, options) {
  const core = require('./core-process').getCoreClient();
  if (!core) throw new CoreError('core_unavailable', 'The identity core is not running');
  return core.request(method, params, context, options);
}

/**
 * The typed calls over `request(method, params, context, options)`, the
 * client's `request` (the running core's by default).
 *
 * Each of `identities`, `history` and `manifest` is `(op, members = {},
 * { caller = 'shell', signal = null } = {})`: `members` the op's own as
 * JavaScript values, `caller` `'chrome'` for a chrome's request main
 * relays. It resolves with the op's result, or rejects with what the op
 * threw or the protocol's error (above).
 *
 * @param {{ request?: Function }} [deps]
 */
function createSwarmStores({ request = coreRequest } = {}) {
  const call =
    (method) =>
    async (name, members = {}, { caller = 'shell', signal = null } = {}) => {
      const params = storeParams(method, name, members, caller);
      const answer = await request(
        method,
        params,
        { caller },
        { watchdogMs: watchdogMs(method), requires: REQUIRES, signal }
      );
      return readStoreAnswer(method, answer);
    };
  return Object.freeze({
    identities: call(IDENTITIES),
    history: call(HISTORY),
    manifest: call(MANIFEST),
  });
}

const stores = createSwarmStores();

module.exports = {
  IDENTITIES,
  HISTORY,
  MANIFEST,
  OPS,
  identities: stores.identities,
  history: stores.history,
  manifest: stores.manifest,
  createSwarmStores,
  storeParams,
  readStoreAnswer,
};
