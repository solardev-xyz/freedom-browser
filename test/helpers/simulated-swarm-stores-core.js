/**
 * freedom-cored's Swarm store methods (freedom-core design 0015, "Methods
 * main calls"; D3, D5, D7; SWM-6) for unit tests, simulated on the
 * reference modules, so a suite's file-text assertions still pin today's
 * formats: `swarm.identities` on reference-feed-store.js, `swarm.manifest`
 * on reference-permission-manifests.js and `swarm.history` on
 * reference-publish-history.js, each loaded once (their caches and a page
 * consent's token live as long as the simulated core), on the suite's
 * Freedom root, so they see the suite's mocks (identity-manager's owners,
 * the Swarm grants, electron). The real core is tested against main from
 * SWM-6's PR 6.2 on.
 *
 * `simulatedSwarmStores(options)` gives `request(method, params, context,
 * options)`, the client's `request` as core/swarm-stores.js calls it, and
 * `stores`, swarm-stores.js's calls made over it
 * (`createSwarmStores({ request })`). A request is read as the core reads
 * it:
 * - **`requires`** is asked with a hello whose `store_moved` echoes
 *   `swarm_stores` while `moved` (the default), and none otherwise: on
 *   false the request fails `requirement_unmet`, unrun, as main's client
 *   fails it unsent. A request without it, while not moved, is the core's
 *   `not_moved` (`data.store: "swarm_stores"`).
 * - **params** are `{ op, ...members }`, each member typed: an unknown op
 *   or member, a required one missing or of another type, or a value no
 *   store holds (a BigInt, bytes, an array with a hole) is
 *   `invalid_argument`; main's own op from the chrome, or any
 *   `swarm.manifest` op from it, is `forbidden`.
 * - **the op** runs as the core's does (fc-swarm-provider's `ops/`): the
 *   chrome's identity ops as feed-store.js's IPC handlers run them (a
 *   change under the site's lock with `source: 'user'`, then the state with
 *   owners), main's own with `source: 'user'`, the manifest page path as
 *   `checkPageManifest` and `decidePageManifest` run it after main's window
 *   checks (`live` main's answer to the guard), and the history's ops as
 *   publish-history.js's own functions, `add` and `update` among them (core
 *   PR K1).
 * - **the answer** is `{ result_typed }`, or `{ error_typed: { name,
 *   message, code? } }` for what the reference threw (its class when it is
 *   `Error`, `TypeError` or `RangeError`, else `Error`; its `code` when a
 *   string).
 *
 * Each reference loads at its first use, in the module registry current
 * then.
 *
 * `fetchManifest({ for, url })` answers a check's `shell.swarm_manifest`
 * as main's handler would (`{ status, body_base64 }` or `{ failed: true }`;
 * by default `{ failed: true }`, which the check reads as unresolved).
 * `fail(method, params)`, when set, runs before each op and fails it by
 * throwing (its error, with `code` `storage` unless it set one, as a
 * protocol error). `calls` records `[method, op, caller]`. `references()`
 * is the three modules; `restart()` drops their caches and the history's
 * database handle, as a core's restart does (a consent's token goes with
 * it).
 */

const { CoreError, SWARM_STORES } = require('../../src/main/core/core-client');
const { createSwarmStores } = require('../../src/main/core/swarm-stores');
const { readPlain, writeTyped } = require('../../src/main/core/swarm-typed');

const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError']);
const FEED_GRANT_REFUSED = 'Swarm feed access is granted only from its own prompt';

// A member's kind: `string` and `boolean` required, `[kind, default]`
// optional, `js` any store value (`undefined` when absent).
const S = 'string';
const B = 'boolean';
const J = 'js';

/** A store value as the core holds one: no BigInt, bytes or hole. */
function storeValue(value) {
  if (typeof value === 'bigint') return false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (!Object.hasOwn(value, i) || !storeValue(value[i])) return false;
    }
    return true;
  }
  if (value !== null && typeof value === 'object') return Object.values(value).every(storeValue);
  return true;
}

function invalid(message) {
  return new CoreError('invalid_argument', message);
}

/**
 * `params`' members for an op whose members are `spec`, as the core reads
 * them (`ops::Members`).
 */
function readMembers(method, name, params, spec) {
  const out = {};
  for (const key of Object.keys(params)) {
    if (key === 'op') continue;
    if (!Object.hasOwn(spec, key)) throw invalid(`${name} takes no member ${key}`);
    let value;
    try {
      value = readPlain(params[key]);
    } catch (err) {
      throw invalid(`${key}: ${err.message}`);
    }
    if (!storeValue(value)) throw invalid(`${key} holds no store value`);
    out[key] = value;
  }
  for (const [key, kind] of Object.entries(spec)) {
    const [type, fallback] = Array.isArray(kind) ? kind : [kind, undefined];
    if (type === J) continue;
    if (!Object.hasOwn(out, key)) {
      if (fallback === undefined) throw invalid(`${key} is missing`);
      out[key] = fallback;
    } else if (typeof out[key] !== type) {
      throw invalid(`${key} must be a ${type}`);
    }
  }
  return out;
}

function thrownAnswer(err) {
  const name = ERROR_NAMES.has(err?.name) ? err.name : 'Error';
  const value = { name, message: String(err?.message ?? err) };
  if (typeof err?.code === 'string' && ERROR_NAMES.has(err?.name)) value.code = err.code;
  return { error_typed: writeTyped(value) };
}

function simulatedSwarmStores({ moved = true, fetchManifest = null, fail = null } = {}) {
  const sim = { moved, fetchManifest, fail, calls: [] };
  // Each reference is loaded at its first use, in the registry that is
  // current then (a suite that only uses the feed store never loads the
  // manifest store's grants).
  const loaded = {};
  const FILES = {
    feeds: './reference-feed-store',
    manifests: './reference-permission-manifests',
    history: './reference-publish-history',
  };
  const references = () => {
    const out = {};
    for (const [name, file] of Object.entries(FILES)) {
      Object.defineProperty(out, name, {
        enumerable: true,
        get: () => {
          if (!loaded[name]) loaded[name] = require(file);
          return loaded[name];
        },
      });
    }
    return out;
  };
  const lock = (key, task) =>
    require('../../src/main/swarm/origin-mutation-lock').withOriginLock(key, task);

  // A check's fetch: main's `shell.swarm_manifest` answer as the
  // reference's `discover` reads a response; `{ failed: true }` throws, a
  // transport failure.
  const manifestFetch = (key) => async (request) => {
    const answer = sim.fetchManifest
      ? await sim.fetchManifest({ for: key, url: request.url })
      : null;
    if (!answer || answer.failed === true) throw new Error('fetch failed');
    const body = Buffer.from(answer.body_base64, 'base64');
    return new Response([101, 204, 205, 304].includes(answer.status) ? null : body, {
      status: answer.status,
    });
  };

  const withSource = (options) => ({ ...options, source: 'user' });

  const OPS = {
    'swarm.identities': {
      'get-all-origins': [{}, false, ({ feeds }) => feeds.getAllOriginEntries()],
      'has-feed-identity': [
        { origin: S },
        false,
        ({ feeds }, m) => feeds.hasIdentityMode(m.origin),
      ],
      'get-identity-mode': [
        { origin: S },
        false,
        ({ feeds }, m) => feeds.getOriginEntry(m.origin)?.identityMode || null,
      ],
      'get-origin-identities': [
        { origin: S },
        false,
        ({ feeds }, m) => feeds.getOriginIdentityStateWithOwners(m.origin),
      ],
      'create-app-scoped-identity': [
        { origin: S, options: J },
        false,
        ({ feeds }, m) =>
          lock(m.origin, async () => {
            feeds.createAppScopedIdentity(m.origin, withSource(m.options));
            return feeds.getOriginIdentityStateWithOwners(m.origin);
          }),
      ],
      'ensure-ant-wallet-identity': [
        { origin: S, options: J },
        false,
        ({ feeds }, m) =>
          lock(m.origin, async () => {
            feeds.ensureAntWalletIdentity(m.origin, withSource(m.options));
            return feeds.getOriginIdentityStateWithOwners(m.origin);
          }),
      ],
      'activate-feed-identity': [
        { origin: S, identity_id: J },
        false,
        ({ feeds }, m) =>
          lock(m.origin, async () => {
            feeds.activateIdentity(m.origin, m.identity_id);
            return feeds.getOriginIdentityStateWithOwners(m.origin);
          }),
      ],
      'set-feed-identity': [
        {},
        false,
        () => {
          throw new Error(FEED_GRANT_REFUSED);
        },
      ],
      'revoke-feed-access': [
        { origin: S },
        false,
        ({ feeds }, m) =>
          lock(m.origin, () => {
            feeds.revokeFeedAccess(m.origin);
            return true;
          }),
      ],
      getOriginIdentityStateWithOwners: [
        { key: S },
        true,
        ({ feeds }, m) => feeds.getOriginIdentityStateWithOwners(m.key),
      ],
      previewAppScopedIdentity: [
        { key: S, options: J },
        true,
        ({ feeds }, m) => feeds.previewAppScopedIdentity(m.key, m.options),
      ],
      createAppScopedIdentityAt: [
        { key: S, index: J, options: J },
        true,
        ({ feeds }, m) => feeds.createAppScopedIdentityAt(m.key, m.index, withSource(m.options)),
      ],
      ensureAntWalletIdentity: [
        { key: S, options: J },
        true,
        ({ feeds }, m) => feeds.ensureAntWalletIdentity(m.key, withSource(m.options)),
      ],
      activateIdentity: [
        { key: S, identity_id: J },
        true,
        ({ feeds }, m) => feeds.activateIdentity(m.key, m.identity_id, { source: 'user' }),
      ],
      grantFeedAccess: [
        { key: S },
        true,
        ({ feeds }, m) => feeds.grantFeedAccess(m.key, { source: 'user' }),
      ],
      hasFeedGrant: [{ key: S }, true, ({ feeds }, m) => feeds.hasFeedGrant(m.key)],
      assertFeedGrantable: [{ key: S }, true, ({ feeds }, m) => feeds.assertFeedGrantable(m.key)],
      getEthereumWalletIdentityReferences: [
        { wallet_index: J },
        true,
        ({ feeds }, m) => feeds.getEthereumWalletIdentityReferences(m.wallet_index),
      ],
    },
    'swarm.history': {
      list: [{}, false, ({ history }) => history.getEntries()],
      clear: [{}, false, ({ history }) => history.clearEntries()],
      remove: [{ id: J }, false, ({ history }, m) => history.removeEntry(m.id)],
      add: [{ entry: J }, true, ({ history }, m) => history.addEntry(m.entry)],
      update: [
        { id: J, updates: J },
        true,
        ({ history }, m) => history.updateEntry(m.id, m.updates),
      ],
    },
    'swarm.manifest': {
      check: [
        { key: S, url: S, eager: [B, false] },
        true,
        ({ manifests }, m) =>
          lock(m.key, () =>
            manifests.checkManifest(
              { origin: m.key, committedUrl: m.url, eager: m.eager },
              { owner: 'page', fetchManifest: manifestFetch(m.key), fetchContext: {} }
            )
          ),
      ],
      decide: [
        { key: S, token: S, outcome: S, live: B },
        true,
        ({ manifests }, m) =>
          manifests.decidePageManifest(m.key, m.token, m.outcome, {
            recheck: async () => m.live,
            holds: () => true,
          }),
      ],
      release: [{ token: S }, true, ({ manifests }, m) => manifests.releasePageManifest(m.token)],
      get: [
        { origin: S },
        true,
        ({ manifests }, m) => lock(m.origin, () => manifests.getRecord(m.origin)),
      ],
      'use-individual': [
        { origin: S, capability: J },
        true,
        ({ manifests }, m) => lock(m.origin, () => manifests.useIndividual(m.origin, m.capability)),
      ],
      disconnect: [
        { origin: S },
        true,
        ({ manifests }, m) => lock(m.origin, () => manifests.disconnect(m.origin)),
      ],
    },
  };

  sim.request = async (method, params, context = {}, options = {}) => {
    const caller = context.caller === 'chrome' ? 'chrome' : 'shell';
    const ops = Object.hasOwn(OPS, method) ? OPS[method] : null;
    if (!ops) throw new CoreError('unknown_method', `unknown method ${method}`);
    const hello = { store_moved: sim.moved ? [SWARM_STORES] : [] };
    if (options.requires && options.requires(hello) !== true) {
      throw new CoreError('requirement_unmet', "The core can't take this request");
    }
    if (!sim.moved) {
      throw new CoreError('not_moved', 'main still writes the Swarm stores', {
        store: SWARM_STORES,
      });
    }
    if (params === null || typeof params !== 'object' || Array.isArray(params)) {
      throw invalid('params must be an object');
    }
    if (typeof params.op !== 'string') throw invalid('op must be a string');
    const name = params.op;
    const entry = Object.hasOwn(ops, name) ? ops[name] : null;
    if (!entry) throw invalid(`${method} has no op ${name}`);
    const [spec, mainOnly, run] = entry;
    if (caller === 'chrome' && (mainOnly || method === 'swarm.manifest')) {
      throw new CoreError('forbidden', `${name} is main's own op`);
    }
    const members = readMembers(method, name, params, spec);
    sim.calls.push([method, name, caller]);
    if (sim.fail) {
      try {
        await sim.fail(method, params);
      } catch (err) {
        throw new CoreError(err.code || 'storage', err.message, err.data);
      }
    }
    let result;
    try {
      result = await run(references(), members);
    } catch (err) {
      return thrownAnswer(err);
    }
    return { result_typed: writeTyped(result) };
  };

  sim.stores = createSwarmStores({ request: sim.request });
  sim.references = references;
  sim.restart = () => {
    loaded.feeds?._resetCache();
    loaded.manifests?._resetForTests();
    loaded.history?.closeDb();
  };
  return sim;
}

module.exports = { simulatedSwarmStores };
