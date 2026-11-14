/**
 * The permission files the identity core writes (freedom-core design 0012,
 * "The files (Q10)"; APB-3): `swarm-permissions.json` and
 * `radicle-permissions.json`. Main names their stores in the hello's
 * `grant_moved` (core-client.js) and writes neither file: every change goes
 * to the core's write methods (`approval.grant`, `approval.revoke`,
 * `approval.touch`), and main reads each store through the core
 * (`approval.grants`). The stores' modules (swarm/swarm-permissions.js,
 * radicle/radicle-permissions.js) keep their reads synchronous on the
 * mirror kept here.
 *
 * - **The mirror** holds each store as the core last answered for it: the
 *   whole store at each start of the core (its `ready`), and a key again
 *   after each write main makes there, whatever its outcome, and at each
 *   `approval.changed` the core sends for it. Only the core's answers fill
 *   it; nothing here reads the file. Answers are applied in the order they
 *   were asked, so an older one never replaces a newer one.
 * - **Fail closed:** before the first load a store holds no grant, so every
 *   check answers as for a site that isn't connected, and a page's request
 *   waits for the load (`whenLoaded`). A load that fails keeps what the
 *   mirror held (nothing, at first) until the next start loads it again.
 *   A key that can't be read back after a write is dropped until then.
 * - **Callers** (design 0012, API): a page's write under `page` with its
 *   PageContext, for its own key; the chrome's narrowing (a revoke, a rule
 *   turned off) as `chrome`; main's own as `shell`, naming the key (a Swarm
 *   manifest's projection, a site's own disconnect relayed without its
 *   page).
 * - **A failed write** keeps the core's outcome (design 0012, "The files"):
 *   a widening not applied rejects (`storage`, `applied: false`), as
 *   Swarm's failed save did; a narrowing stands, not saved (`applied:
 *   true`), and resolves with a warning; a failed directory flush
 *   (`durable: false`) resolves with a warning, as main's own saves did.
 */

// Logged as the stores' own messages were, on the console.
const log = console;

const STORES = Object.freeze(['swarm', 'radicle']);
const LABELS = Object.freeze({ swarm: '[SwarmPermissions]', radicle: '[RadiclePermissions]' });

let backendOverride = null;

/** The core's approval methods (vault-backend.js), or a test's. */
function backend() {
  return backendOverride || require('./vault-backend').vaultBackend.approval;
}

function createMirror(store) {
  const label = LABELS[store];
  // key -> the record as the core holds it, in the core's order.
  let records = new Map();
  // Every read takes the next number; one is applied only if no read asked
  // after it has been applied for that key (or for the whole store).
  let asked = 0;
  let wholeAt = 0;
  const keyAt = new Map();
  // Whether a load has been tried, and whether one has succeeded.
  let tried = false;
  let loaded = false;
  let waiters = [];

  function settleLoad() {
    tried = true;
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(loaded);
  }

  async function load() {
    const n = ++asked;
    let reply;
    try {
      reply = await backend().grants({ store });
    } catch (err) {
      log.warn(`${label} could not read the grants from the identity core:`, err.message);
      settleLoad();
      return false;
    }
    if (n > wholeAt) {
      const next = new Map();
      for (const record of Array.isArray(reply?.records) ? reply.records : []) {
        if (record && typeof record === 'object' && typeof record.origin === 'string') next.set(record.origin, record);
      }
      // A key read after this load asked keeps its newer answer.
      for (const [key, at] of keyAt) {
        if (at < n) continue;
        if (records.has(key)) next.set(key, records.get(key));
        else next.delete(key);
      }
      records = next;
      wholeAt = n;
    }
    loaded = true;
    settleLoad();
    return true;
  }

  async function refresh(key) {
    const n = ++asked;
    const reply = await backend().grants({ store, key });
    if (n < wholeAt || n < (keyAt.get(key) || 0)) return;
    keyAt.set(key, n);
    const record = Array.isArray(reply?.records) ? reply.records[0] : null;
    if (record && typeof record === 'object') records.set(key, record);
    else records.delete(key);
  }

  // Dropped until the core answers again (fail closed).
  function forget(key) {
    keyAt.set(key, ++asked);
    records.delete(key);
  }

  async function readBack(key) {
    try {
      await refresh(key);
    } catch (err) {
      log.warn(`${label} could not read a grant back from the identity core:`, err.message);
      forget(key);
    }
  }

  /**
   * One write to the core, then its key read back. Resolves the core's
   * reply (`{ saved: false }` for a narrowing that stands unsaved); rejects
   * with the core's error for a write that took no effect.
   */
  async function write(method, params, caller, key) {
    let reply = null;
    let failure = null;
    try {
      reply = await backend()[method](params, caller);
    } catch (err) {
      failure = err;
    }
    await readBack(key);
    if (failure) {
      if (failure.code === 'storage' && failure.data?.applied === true) {
        log.warn(`${label} Changed, but the change could not be saved: it stands until the browser restarts`);
        return { saved: false };
      }
      throw failure;
    }
    if (reply?.durable === false) {
      log.warn(`${label} Saved, but the save may not survive a power loss yet (the flush after the rename failed)`);
    }
    return reply;
  }

  return {
    /** The key's record (a copy), or null. */
    get(key) {
      const record = records.get(key);
      return record ? structuredClone(record) : null;
    },
    /** Every record (copies), most recently used first. */
    all() {
      return [...records.values()].map((record) => structuredClone(record)).sort((a, b) => b.lastUsed - a.lastUsed);
    },
    /**
     * Resolves once the store's first load has been tried: true once one has
     * succeeded, false while none has (the store holds no grant).
     */
    whenLoaded() {
      return tried ? Promise.resolve(loaded) : new Promise((resolve) => waiters.push(resolve));
    },
    load,
    refresh,
    settleLoad,
    /**
     * `approval.grant { store, change }`: a page's for its own key, or main's
     * (`shell`, `change.key`).
     */
    grant(change, caller) {
      const key = callerKey(caller, change.key);
      return write('grant', { store, change }, caller, key);
    },
    /** `approval.revoke { store, key, what }`. */
    revoke(key, what, caller) {
      return write('revoke', { store, key, what }, caller, key);
    },
    /** `approval.touch { store }`: a page's last use, under `page`. */
    touch(page) {
      return write('touch', { store }, page, page.origin);
    },
    _reset() {
      records = new Map();
      keyAt.clear();
      asked = 0;
      wholeAt = 0;
      tried = false;
      loaded = false;
    },
  };
}

function callerKey(caller, key) {
  if (caller && typeof caller === 'object') return caller.origin;
  return key;
}

const mirrors = new Map(STORES.map((store) => [store, createMirror(store)]));

/** The store's mirror and writes: `swarm` or `radicle`. */
function grantStore(store) {
  const mirror = mirrors.get(store);
  if (!mirror) throw new Error(`unknown grant store ${store}`);
  return mirror;
}

function loadAll() {
  return Promise.all([...mirrors.values()].map((mirror) => mirror.load()));
}

let detach = null;

/**
 * Keeps the mirrors with the core `client` (core-process.js, before its
 * start): every store loaded at each `ready`, a key read again at each
 * `approval.changed`. A client that fails for good settles the waits for
 * the first load, with nothing loaded.
 */
function attachGrants(client) {
  detachGrants();
  const onReady = () => {
    loadAll().catch(() => {});
  };
  const onEvent = (name, data) => {
    if (name !== 'approval.changed' || typeof data?.key !== 'string' || !mirrors.has(data?.store)) return;
    mirrors
      .get(data.store)
      .refresh(data.key)
      .catch((err) => log.warn(`${LABELS[data.store]} could not read a changed grant:`, err.message));
  };
  const onFailed = () => {
    for (const mirror of mirrors.values()) mirror.settleLoad();
  };
  client.on('ready', onReady);
  client.on('event', onEvent);
  client.on('failed', onFailed);
  detach = () => {
    client.removeListener('ready', onReady);
    client.removeListener('event', onEvent);
    client.removeListener('failed', onFailed);
  };
}

function detachGrants() {
  detach?.();
  detach = null;
}

/**
 * Tests: the core's approval methods (`{ grants, grant, revoke, touch }`,
 * test/helpers/simulated-grant-core.js) in place of the core's, the mirrors
 * emptied, then every store loaded from it. Null goes back to the core.
 */
async function useBackendForTests(fake) {
  backendOverride = fake;
  for (const mirror of mirrors.values()) mirror._reset();
  if (fake) await loadAll();
}

module.exports = {
  GRANT_STORES: STORES,
  grantStore,
  attachGrants,
  detachGrants,
  _useBackendForTests: useBackendForTests,
};
