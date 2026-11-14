/**
 * The identity core's grant stores for Swarm and Radicle (freedom-core
 * design 0012, APB-3: both in the hello's `grant_moved`) for unit tests:
 * `approval.grants`, `approval.grant`, `approval.revoke` and
 * `approval.touch`, simulated in memory with the reference's operations (the
 * JS stores before the move, which the core ports with vectors), and its
 * callers as the core takes them:
 * - a page (a PageContext object) changes only its own key;
 * - `shell` (null) grants only in the Swarm store, naming `change.key`;
 * - `'chrome'` only narrows; a last use only from a page.
 *
 * Install it with `useSimulatedGrantCore()`, which loads main's mirrors
 * (src/main/core/grants.js) from it. `core.calls` records each write as
 * `{ method, params, caller }`; `core.failNext(method, error, { skip })`
 * makes the next such write (`'*'`: any write), after `skip` more, fail
 * with the core's error (`storage` with `data.applied`, as the core reports
 * a failed save), applying a narrowing first as the core does.
 * `core.file(store)` is the file's text as the core would write it.
 * `core.holdKeyReads()` holds the answers to the reads of one key (the
 * store as it stood when each was asked) until its `release()`.
 *
 * `attachedCoreClient()` is a core client as core-process.js attaches it
 * to the mirrors: `client.changed(store, key)` sends `approval.changed`, as
 * the core does after a change; `exit`, `ready` and `failed` are its own.
 */

const { EventEmitter } = require('events');

const STORES = ['swarm', 'radicle'];

function coreError(code, message, data) {
  return Object.assign(new Error(message), { code, data });
}

function simulatedGrantCore({ now = () => Date.now() } = {}) {
  const entries = { swarm: {}, radicle: {} };
  const calls = [];
  const failures = [];
  // The key reads' answers held by holdKeyReads(), or null.
  let held = null;

  const callerName = (caller) => (caller === 'chrome' ? 'chrome' : caller ? 'page' : 'shell');

  function storeOf(params) {
    if (!STORES.includes(params?.store)) throw coreError('invalid_argument', 'store: expected swarm or radicle');
    return params.store;
  }

  // A widening applies only if its save works; a narrowing stands either way.
  function applying(method, narrowing, apply) {
    const index = failures.findIndex((failure) => failure.method === method || failure.method === '*');
    const failure = index >= 0 ? failures[index] : null;
    if (!failure) return apply();
    if (failure.skip > 0) {
      failure.skip -= 1;
      return apply();
    }
    failures.splice(index, 1);
    if (narrowing && failure.error.data?.applied === true) apply();
    throw failure.error;
  }

  const swarmDefaults = () => ({ publish: false, feeds: false, signing: false, messaging: false });
  const radicleDefaults = () => ({ node: false, signing: false });

  return {
    calls,
    entries,
    failNext(method, error, { skip = 0 } = {}) {
      failures.push({ method, error, skip });
    },
    file(store) {
      return JSON.stringify(entries[store], null, 2);
    },
    holdKeyReads() {
      const answers = [];
      held = answers;
      return {
        get count() {
          return answers.length;
        },
        release() {
          if (held === answers) held = null;
          for (const answer of answers.splice(0)) answer();
        },
      };
    },
    async grants(params) {
      const store = storeOf(params);
      const all = entries[store];
      if (params.key !== undefined) {
        const reply = { records: all[params.key] ? [structuredClone(all[params.key])] : [] };
        if (!held) return reply;
        const answers = held;
        return new Promise((resolve) => answers.push(() => resolve(reply)));
      }
      return {
        records: Object.values(all)
          .sort((a, b) => b.lastUsed - a.lastUsed)
          .map((record) => structuredClone(record)),
      };
    },
    async grant(params, caller) {
      calls.push({ method: 'approval.grant', params: structuredClone(params), caller: callerName(caller) });
      const store = storeOf(params);
      const change = params.change || {};
      if (caller === 'chrome' || (caller === null && store !== 'swarm')) {
        throw coreError('forbidden', "this caller can't write this store's grants");
      }
      if (caller && change.key !== undefined) throw coreError('invalid_argument', 'change: a page changes its own grant');
      const key = caller ? caller.origin : change.key;
      if (typeof key !== 'string') throw coreError('invalid_argument', 'missing field key');
      const all = entries[store];
      return applying('approval.grant', false, () => {
        const time = now();
        if (change.op === 'connect') {
          all[key] =
            store === 'swarm'
              ? { origin: key, connectedAt: time, lastUsed: time, autoApprove: swarmDefaults() }
              : { origin: key, connectedAt: time, lastUsed: time, signing: false, autoApprove: radicleDefaults() };
        } else if (change.op === 'flag') {
          if (!all[key]) return { grant: null };
          all[key].autoApprove ||= store === 'swarm' ? swarmDefaults() : radicleDefaults();
          all[key].autoApprove[change.flag] = true;
        } else if (store === 'swarm' && change.op === 'messaging') {
          if (!all[key]) return { grant: null };
          all[key].messaging = { grantedAt: time };
        } else if (store === 'radicle' && change.op === 'signing') {
          if (!all[key]) return { grant: null };
          all[key].signing = true;
        } else {
          throw coreError('invalid_argument', 'change: unknown op for this store');
        }
        return { grant: structuredClone(all[key]) };
      });
    },
    async revoke(params, caller) {
      calls.push({ method: 'approval.revoke', params: structuredClone(params), caller: callerName(caller) });
      const store = storeOf(params);
      const { key, what } = params;
      if (caller && typeof caller === 'object' && caller.origin !== key) {
        throw coreError('forbidden', 'a page revokes only its own grant');
      }
      const all = entries[store];
      return applying('approval.revoke', true, () => {
        if (what === 'grant') {
          const had = Boolean(all[key]);
          delete all[key];
          return { revoked: had };
        }
        if (store === 'swarm' && what === 'messaging') {
          if (!all[key]?.messaging) return { revoked: false };
          delete all[key].messaging;
          if (all[key].autoApprove) all[key].autoApprove.messaging = false;
          return { revoked: true };
        }
        if (typeof what?.flag === 'string') {
          if (!all[key]) return { revoked: false };
          all[key].autoApprove ||= store === 'swarm' ? swarmDefaults() : radicleDefaults();
          all[key].autoApprove[what.flag] = false;
          return { revoked: true };
        }
        throw coreError('invalid_argument', 'what: unknown for this store');
      });
    },
    async touch(params, page) {
      calls.push({ method: 'approval.touch', params: structuredClone(params), caller: callerName(page) });
      const store = storeOf(params);
      if (!page || typeof page !== 'object') throw coreError('forbidden', 'only a page marks its own use');
      const entry = entries[store][page.origin];
      if (!entry) return {};
      const time = now();
      // Radicle's last use is written at most once a minute.
      if (store === 'radicle' && time - (entry.lastUsed || 0) < 60000) return {};
      entry.lastUsed = time;
      return {};
    },
  };
}

/**
 * Main's grant mirrors (core/grants.js) on a fresh simulated core, loaded
 * from it; resolves the core. `seed` gives each store's entries first.
 */
async function useSimulatedGrantCore(seed = {}, options = {}) {
  const core = simulatedGrantCore(options);
  for (const store of STORES) Object.assign(core.entries[store], structuredClone(seed[store] || {}));
  const grants = require('../../src/main/core/grants');
  grants.detachGrants();
  await grants._useBackendForTests(core);
  return core;
}

function attachedCoreClient() {
  const client = new EventEmitter();
  require('../../src/main/core/grants').attachGrants(client);
  client.changed = (store, key) => client.emit('event', 'approval.changed', { store, key });
  return client;
}

/** A page's PageContext, for a test's own grant writes. */
function testPage(origin, overrides = {}) {
  return { origin, top_origin: origin, frame: 1, navigation: 1, agent: false, ...overrides };
}

module.exports = { simulatedGrantCore, useSimulatedGrantCore, attachedCoreClient, testPage };
