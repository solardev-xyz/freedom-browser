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
 * - **No stale grant:** a key the core reports changed (`approval.changed`)
 *   is forgotten at once and reads as no grant until the core's answer for
 *   it lands, so a narrowing never waits behind that read. A revoke or a
 *   connect main writes (a connect replaces a site's rules) hides its key
 *   the same way, from before the write until the answer after it; a
 *   widening keeps the narrower record while the core writes it, then
 *   forgets it until that answer; a last use (`touch`) hides nothing.
 * - **One mirror per core process:** each exit and each start of the core
 *   makes a new, empty mirror that isn't ready until that process's load.
 *   A page's request waits for it (`whenLoaded`), and is refused if it
 *   fails or the core gives up (`failed`): nothing the previous process
 *   answered is used. Every check before the load answers as for a site
 *   that isn't connected. A key that can't be read is dropped until the
 *   core answers for it again.
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
  // The current core process's mirror (a generation): key -> the record as
  // that process holds it, the order of its answers, key -> the latest read
  // asked for it until it lands, and its load: not yet answered
  // (`unready`), `loaded`, or `failed`.
  const generation = (state = 'unready') => ({
    records: new Map(),
    wholeAt: 0,
    keyAt: new Map(),
    reading: new Map(),
    state,
  });
  let gen = generation();
  // Every read takes the next number; one is applied only to the generation
  // it was asked in, and only if no read asked after it has been applied
  // for that key (or for the whole store).
  let asked = 0;
  // whenLoaded() calls waiting for a generation's load.
  let waiters = [];
  // key -> the grant and revoke writes in flight for it: the key reads as
  // no grant until the last one ends and the core has answered for it.
  const writing = new Map();

  function settleWaiters(ok) {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(ok);
  }

  // A core process exited, or one started: an empty mirror, not ready.
  function restart() {
    gen = generation();
  }

  // The core gave up: an empty mirror that stays unready.
  function fail() {
    gen = generation('failed');
    settleWaiters(false);
  }

  async function load() {
    const g = gen;
    const n = ++asked;
    let reply;
    try {
      reply = await backend().grants({ store });
    } catch (err) {
      if (g !== gen) return false;
      log.warn(`${label} could not read the grants from the identity core:`, err.message);
      if (g.state === 'unready') {
        g.state = 'failed';
        settleWaiters(false);
      }
      return false;
    }
    // An answer from a process that has since exited loads nothing.
    if (g !== gen) return false;
    if (n > g.wholeAt) {
      const next = new Map();
      for (const record of Array.isArray(reply?.records) ? reply.records : []) {
        if (record && typeof record === 'object' && typeof record.origin === 'string') next.set(record.origin, record);
      }
      // A key read or dropped after this load asked keeps its newer state.
      for (const [key, at] of g.keyAt) {
        if (at < n) continue;
        if (g.records.has(key)) next.set(key, g.records.get(key));
        else next.delete(key);
      }
      g.records = next;
      g.wholeAt = n;
    }
    g.state = 'loaded';
    settleWaiters(true);
    return true;
  }

  // The key's record read from the core. Never rejects: a read that fails
  // drops the key until the core answers again (fail closed).
  function refresh(key) {
    const g = gen;
    const n = ++asked;
    const apply = (record) => {
      if (g !== gen || n < g.wholeAt || n < (g.keyAt.get(key) || 0)) return;
      g.keyAt.set(key, n);
      if (record) g.records.set(key, record);
      else g.records.delete(key);
    };
    const read = Promise.resolve()
      .then(() => backend().grants({ store, key }))
      .then(
        (reply) => {
          const record = Array.isArray(reply?.records) ? reply.records[0] : null;
          apply(record && typeof record === 'object' ? record : null);
        },
        (err) => {
          log.warn(`${label} could not read a grant from the identity core:`, err.message);
          apply(null);
        }
      )
      .finally(() => {
        if (g.reading.get(key) === read) g.reading.delete(key);
      });
    g.reading.set(key, read);
    return read;
  }

  // The key reads as no grant from here until a read asked after this
  // lands: one already in flight can't bring back the record.
  function forget(key) {
    gen.keyAt.set(key, ++asked);
    gen.records.delete(key);
  }

  // Resolves once no read of the key is in flight for the current process.
  async function settled(key) {
    while (gen.reading.has(key)) await gen.reading.get(key);
  }

  /**
   * `approval.changed` for the key: forgotten at once, then read again.
   * A narrowing the core has applied never waits behind the read.
   */
  function changed(key) {
    forget(key);
    return refresh(key);
  }

  /**
   * One write to the core, then its key read back. `mode` is what the key
   * reads as meanwhile:
   * - `hide`, a write that can narrow (a revoke; a connect, which replaces
   *   a site's record and its rules): no grant, from before the write
   *   until the core's answer after it;
   * - `forget`, a widening: the record as it was (never more than the core
   *   now holds) while the core writes, then no grant until its answer;
   * - `keep`, a last use: the record.
   * Resolves the core's reply (`{ saved: false }` for a narrowing that
   * stands unsaved) once the key's reads have landed; rejects with the
   * core's error for a write that took no effect.
   */
  async function write(method, params, caller, key, mode) {
    if (mode === 'hide') writing.set(key, (writing.get(key) || 0) + 1);
    let reply = null;
    let failure = null;
    try {
      reply = await backend()[method](params, caller);
    } catch (err) {
      failure = err;
    } finally {
      // Whatever was read while the write was in flight may predate it.
      if (mode !== 'keep') forget(key);
      if (mode === 'hide') {
        const left = writing.get(key) - 1;
        if (left > 0) writing.set(key, left);
        else writing.delete(key);
      }
    }
    refresh(key);
    await settled(key);
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

  const visible = (key) => !writing.has(key);

  return {
    /** The key's record (a copy), or null. */
    get(key) {
      const record = visible(key) ? gen.records.get(key) : null;
      return record ? structuredClone(record) : null;
    },
    /** Every record (copies), most recently used first. */
    all() {
      return [...gen.records.values()]
        .filter((record) => visible(record.origin))
        .map((record) => structuredClone(record))
        .sort((a, b) => b.lastUsed - a.lastUsed);
    },
    /**
     * Resolves once the current core process's load has been answered: true
     * once it has loaded, false if it failed or the core gave up. A wait
     * across an exit waits for the next process's load.
     */
    whenLoaded() {
      if (gen.state === 'loaded') return Promise.resolve(true);
      if (gen.state === 'failed') return Promise.resolve(false);
      return new Promise((resolve) => waiters.push(resolve));
    },
    load,
    restart,
    fail,
    changed,
    /**
     * `approval.grant { store, change }`: a page's for its own key, or main's
     * (`shell`, `change.key`).
     */
    grant(change, caller) {
      const key = callerKey(caller, change.key);
      return write('grant', { store, change }, caller, key, change.op === 'connect' ? 'hide' : 'forget');
    },
    /** `approval.revoke { store, key, what }`. */
    revoke(key, what, caller) {
      return write('revoke', { store, key, what }, caller, key, 'hide');
    },
    /** `approval.touch { store }`: a page's last use, under `page`. */
    touch(page) {
      return write('touch', { store }, page, page.origin, 'keep');
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
 * start). Each process the client runs gets its own empty mirror, not
 * ready until that process's load: made at its `exit` and again at the
 * next `ready`, which loads every store. A key is forgotten and read again
 * at each `approval.changed`. A client that gives up (`failed`) leaves the
 * mirrors empty and unready, and `whenLoaded` answers false.
 */
function attachGrants(client) {
  detachGrants();
  const each = (fn) => {
    for (const mirror of mirrors.values()) fn(mirror);
  };
  const onReady = () => {
    each((mirror) => mirror.restart());
    loadAll().catch(() => {});
  };
  const onExit = () => each((mirror) => mirror.restart());
  const onEvent = (name, data) => {
    if (name !== 'approval.changed' || typeof data?.key !== 'string' || !mirrors.has(data?.store)) return;
    mirrors.get(data.store).changed(data.key);
  };
  const onFailed = () => each((mirror) => mirror.fail());
  client.on('ready', onReady);
  client.on('exit', onExit);
  client.on('event', onEvent);
  client.on('failed', onFailed);
  detach = () => {
    client.removeListener('ready', onReady);
    client.removeListener('exit', onExit);
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
 * test/helpers/simulated-grant-core.js) in place of the core's, a new empty
 * mirror for each store (as at a core's start), then every store loaded
 * from it. Null goes back to the core, with the mirrors left unready.
 */
async function useBackendForTests(fake) {
  backendOverride = fake;
  for (const mirror of mirrors.values()) mirror.restart();
  if (fake) await loadAll();
}

module.exports = {
  GRANT_STORES: STORES,
  grantStore,
  attachGrants,
  detachGrants,
  _useBackendForTests: useBackendForTests,
};
