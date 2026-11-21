/**
 * Pending SafeTx store — the half-signed transaction that survives a
 * restart, kept by the identity core (freedom-core design 0013, "Pending
 * Safe transactions"; PRF-6(d)).
 *
 * One pending SafeTx per Safe at a time, by design (research doc B.4):
 * a single slot sidesteps the nonce-replacement/ordering swamp that
 * Safe's hosted service exists to manage. Collected signatures are just
 * bytes — safe to persist, useless without the Safe and its chain state.
 *
 * `safe-pending.json` has moved to the core (the hello's `store_moved`,
 * core/core-client.js): the core is its only writer, in today's text, and
 * main writes it nowhere. Main keeps a copy of the store as the core holds
 * it, so its reads stay synchronous (`getPending`, `listPendingIndexes`)
 * and an entry read is the same object while it lives, which the
 * signature loops check (`signature-collection.js`):
 * - **One core process at a time:** the copy is the store as the running
 *   core process loaded it (`attachCore`): `safe_pending.list`, then
 *   `safe_pending.get` for each index, at each `ready`. From the core's
 *   exit (or a new `ready`) until that process's load has succeeded, the
 *   copy is unavailable: `getPending` answers null and
 *   `listPendingIndexes` none (design 0013's G29), and `ready`, which Safe
 *   flows and every write wait on, waits for that load. A load that fails
 *   rejects it, and nothing acts on the store until a load succeeds: each
 *   later wait tries one. An entry keeps its object only when the reload
 *   finds it as it was (the core's answer deep-equal to it); any other is a
 *   new object, so a loop that holds the old one stops.
 * - **Written through:** `setPending` and `clearPending` wait for the copy,
 *   send the change to the core and apply it to the copy only once the core
 *   has answered it. A write queued before the core process changed waits
 *   for its successor's load, and is refused (SAFE_DISCARDED) unless that
 *   reload kept the entry the caller read. A change the core refuses or reports failed
 *   (`storage`, the store as it was), or whose answer is lost (written or
 *   not), throws, and the index is read again from the core into a new
 *   object, so a loop that holds the old one stops; if the core can't
 *   answer that read, the new object is the entry as the core last
 *   confirmed it, until the next start of the core loads the store again.
 *   Nothing is sent again (design 0013's G9).
 * - **In turn:** loads, writes and their reads go to the core one at a
 *   time, each once the one before has answered, so a later answer is
 *   never overtaken by an earlier one.
 * - **A deleted Safe's entry** is cleared by the core itself, in
 *   `accounts.remove` (identity-manager.js `deleteDerivedWallet`), which
 *   then drops it from main's copy (`forgetPending`), or reads it again
 *   when the removal failed partway (`refreshPending`).
 */

const { codedError, SAFE_DISCARDED } = require('./errors');

const LOG = '[SafePending]';

// Main's copy, as the core holds it: wallet index -> entry. Read only
// while `available`.
const cache = new Map();
// Each entry's JSON text as the core last confirmed it: what a failed
// write falls back to when the core can't be read.
const confirmed = new Map();
// Main's requests to the store, one at a time.
let turn = Promise.resolve();
// Each local drop (`forgetPending`) is counted: a load drops what it read
// for an index forgotten since it began.
let drops = 0;
const droppedAt = new Map();

// Whether the copy is the running core process's, loaded. `epoch` counts
// each process (an exit, a `ready`): a load applies only within the one it
// began in. `waiter` is the wait for the running process's load, settled
// by it (or by the core giving up).
let available = false;
let epoch = 0;
let waiter = null;
let attachedCore = null;

function vault() {
  return require('../../core/vault-backend').vaultBackend;
}

function inTurn(task) {
  const run = turn.then(task);
  turn = run.catch(() => {});
  return run;
}

function newWaiter() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject, done: false };
}

function settle(wait, error = null) {
  if (wait.done) return;
  wait.done = true;
  if (error) wait.reject(error);
  else wait.resolve();
}

/** A core process ended or began: the copy is unavailable until its load. */
function invalidate() {
  available = false;
  epoch += 1;
  if (!waiter || waiter.done) waiter = newWaiter();
}

function drop(index) {
  cache.delete(index);
  confirmed.delete(index);
}

const isIndex = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * The store, whole, from the core into the copy, which is then available:
 * true, or false when another core process began meanwhile (whose own load
 * decides). Throws as a request fails, the copy left unavailable.
 */
async function loadAll() {
  const began = epoch;
  const since = drops;
  const indices = await vault().safePending.list();
  if (!Array.isArray(indices) || !indices.every(isIndex)) {
    throw new Error('The identity core answered no list of pending Safe transactions');
  }
  const entries = new Map();
  for (const index of indices) {
    const entry = await vault().safePending.get(index);
    if (entry) entries.set(index, entry);
  }
  if (epoch !== began) return false;
  const droppedSince = (index) => (droppedAt.get(index) ?? 0) > since;
  for (const index of [...cache.keys()]) {
    if (!entries.has(index) && !droppedSince(index)) drop(index);
  }
  for (const [index, entry] of entries) {
    if (droppedSince(index)) continue;
    const text = JSON.stringify(entry);
    // The object main had, only where the core's entry is that object as
    // it stands now: confirmed, it lives on; anything else is new.
    const held = cache.get(index);
    if (!held || JSON.stringify(held) !== text) cache.set(index, entry);
    confirmed.set(index, text);
  }
  available = true;
  return true;
}

function load() {
  return inTurn(loadAll);
}

/**
 * Resolves once the copy is the running core process's, loaded; rejects
 * when that load fails. With none under way (no core attached, or its load
 * failed), it loads now.
 */
async function whenLoaded() {
  for (;;) {
    if (available) return;
    if (waiter && !waiter.done) {
      await waiter.promise;
      continue;
    }
    const began = epoch;
    try {
      if (await load()) return;
    } catch (err) {
      // A load for a process that has since been replaced decides nothing:
      // its successor's load does.
      if (epoch === began) throw err;
    }
  }
}

/**
 * After a write that failed: the index as the core last confirmed it, as a
 * new object at once, then as the core answers it now. A read that fails
 * keeps the first.
 */
async function readAgain(index) {
  const text = confirmed.get(index);
  if (text === undefined) cache.delete(index);
  else cache.set(index, JSON.parse(text));
  try {
    const entry = await vault().safePending.get(index);
    if (entry) {
      cache.set(index, entry);
      confirmed.set(index, JSON.stringify(entry));
    } else {
      drop(index);
    }
  } catch (err) {
    console.warn(
      `${LOG} A pending Safe transaction could not be read again (${err?.code || 'error'}):`,
      err?.message || err
    );
  }
}

function notDurable(what, reply) {
  if (reply?.durable === false) {
    console.warn(
      `${LOG} ${what}, but it may not survive a power loss yet (the flush after the rename failed)`
    );
  }
}

/**
 * core-process.js: main's copy follows `client`, the core client: loaded
 * whole at each start of the core (a restarted core reads the file again),
 * and unavailable from each exit until then.
 */
function attachCore(client) {
  if (!client || typeof client.on !== 'function' || client === attachedCore) return;
  attachedCore = client;
  invalidate();
  client.on('exit', invalidate);
  client.on('ready', () => {
    invalidate();
    const wait = waiter;
    const began = epoch;
    load().then(
      (applied) => {
        if (applied) settle(wait);
      },
      (err) => {
        console.error(
          `${LOG} Failed to load the pending Safe transactions (${err?.code || 'error'}):`,
          err?.message || err
        );
        // Only the running process's load settles the wait: an older one's
        // failure, like its success, is its successor's to decide.
        if (epoch === began) settle(wait, err);
      }
    );
  });
  // A core that gives up leaves the copy unloaded: the wait fails, and each
  // later one tries a load of its own, which fails while the core is down.
  client.on('failed', () => {
    if (waiter && !waiter.done) {
      settle(
        waiter,
        Object.assign(new Error('The identity core is not running'), { code: 'core_unavailable' })
      );
    }
  });
}

/** @returns {Object|null} The pending entry for a safe wallet index */
function getPending(safeIndex) {
  return (available && cache.get(safeIndex)) || null;
}

// A write's turn that came while no core process's copy was loaded: it
// waits for the running one's load and takes its turn again.
const AGAIN = Symbol('again');

function replaced() {
  return codedError('This transaction was discarded or replaced', SAFE_DISCARDED);
}

/**
 * A write of `index`, sent in its turn (`send`, then `apply` once the core
 * has answered), on the copy the caller read: the entry it held then
 * (`basis`) in that process's copy. It is sent only once the running
 * process's copy is loaded, never ahead of that load, even when it was
 * queued before the process changed; and if the process changed since the
 * caller read it, only while the reload kept the caller's entry, so it
 * never writes over a different entry of a successor (SAFE_DISCARDED).
 */
async function write(index, send, apply) {
  const basis = cache.get(index);
  let seen = available ? epoch : null;
  for (;;) {
    await whenLoaded();
    const done = await inTurn(async () => {
      if (!available) return AGAIN;
      if (epoch !== seen) {
        if (cache.get(index) !== basis) throw replaced();
        seen = epoch;
      }
      let reply;
      try {
        reply = await send();
      } catch (err) {
        await readAgain(index);
        throw err;
      }
      apply(reply);
      return true;
    });
    if (done !== AGAIN) return;
  }
}

/**
 * Sets the Safe's pending entry in the core, then in main's copy: `entry`
 * itself, which `getPending` answers from then on. Waits for the copy
 * first (see `write`), and rejects as that wait or the core's answer does,
 * with the index read again (see above).
 */
function setPending(safeIndex, entry) {
  return write(
    safeIndex,
    () => vault().safePending.set(safeIndex, entry),
    (reply) => {
      notDurable('A pending Safe transaction was saved', reply);
      cache.set(safeIndex, entry);
      confirmed.set(safeIndex, JSON.stringify(entry));
    }
  );
}

/** Clears the Safe's pending entry in the core, then in main's copy; rejects as `setPending` does. */
function clearPending(safeIndex) {
  return write(
    safeIndex,
    () => vault().safePending.clear(safeIndex),
    (reply) => {
      notDurable('A pending Safe transaction was cleared', reply);
      drop(safeIndex);
    }
  );
}

/** Safe wallet indexes that currently have a pending SafeTx, ascending. */
function listPendingIndexes() {
  return available ? [...cache.keys()].sort((a, b) => a - b) : [];
}

/**
 * A deleted Safe's entry, which the core cleared in `accounts.remove`:
 * dropped from main's copy, without asking the core.
 */
function forgetPending(safeIndex) {
  drops += 1;
  droppedAt.set(safeIndex, drops);
  drop(safeIndex);
}

/**
 * The Safe's entry read again from the core, as after a failed write: for a
 * removal that failed after the core may have cleared it. Never rejects.
 */
function refreshPending(safeIndex) {
  return inTurn(() => readAgain(safeIndex));
}

/** Tests: an empty copy, attached to no core, with nothing in turn. */
function _reset() {
  cache.clear();
  confirmed.clear();
  droppedAt.clear();
  drops = 0;
  turn = Promise.resolve();
  available = false;
  epoch = 0;
  waiter = null;
  attachedCore = null;
}

module.exports = {
  /**
   * Resolves once main's copy is the running core process's, loaded;
   * rejects if that load fails (each later wait tries again).
   */
  get ready() {
    return whenLoaded();
  },
  attachCore,
  getPending,
  setPending,
  clearPending,
  listPendingIndexes,
  forgetPending,
  refreshPending,
  _reset,
};
