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
 * - **Loaded** whole at each start of the core (`attachCore`):
 *   `safe_pending.list`, then `safe_pending.get` for each index. A reload
 *   keeps an entry's object when the core's entry is the one main had.
 *   Until a load has succeeded the copy is empty, so `getPending` answers
 *   null (design 0013's G29). Safe flows wait on `ready` first: the first
 *   load, then another if that one failed, which rejects as it fails.
 * - **Written through:** `setPending` and `clearPending` send the change to
 *   the core and apply it to the copy only once the core has answered it.
 *   A change the core refuses or reports failed (`storage`, the store as it
 *   was), or whose answer is lost, throws, and the index is read again from
 *   the core into a new object, so a loop that holds the old one stops; if
 *   the core can't answer that read, the new object is the entry as the core
 *   last confirmed it. Nothing is sent again (design 0013's G9): the next
 *   start of the core loads the store again.
 * - **In turn:** loads, writes and their reads go to the core one at a
 *   time, each once the one before has answered, so a later answer is
 *   never overtaken by an earlier one.
 * - **A deleted Safe's entry** is cleared by the core itself, in
 *   `accounts.remove` (identity-manager.js `deleteDerivedWallet`), which
 *   then drops it from main's copy (`forgetPending`), or reads it again
 *   when the removal failed partway (`refreshPending`).
 */

const LOG = '[SafePending]';

// Main's copy, as the core holds it: wallet index -> entry.
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

// The core client the copy follows, whether a load has succeeded, and the
// first load after attaching (settled however it ends).
let attachedCore = null;
let loaded = false;
let firstLoad = null;
let settleFirstLoad = null;

function vault() {
  return require('../../core/vault-backend').vaultBackend;
}

function inTurn(task) {
  const run = turn.then(task);
  turn = run.catch(() => {});
  return run;
}

function drop(index) {
  cache.delete(index);
  confirmed.delete(index);
}

/** The core's entry for `index` into the copy; the one main has is kept when equal. */
function adopt(index, entry) {
  const text = JSON.stringify(entry);
  if (!cache.has(index) || confirmed.get(index) !== text) cache.set(index, entry);
  confirmed.set(index, text);
}

const isIndex = (value) => Number.isSafeInteger(value) && value >= 0;

/** The store, whole, from the core into the copy. Throws as a request fails. */
async function loadAll() {
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
  const droppedSince = (index) => (droppedAt.get(index) ?? 0) > since;
  for (const index of [...cache.keys()]) {
    if (!entries.has(index) && !droppedSince(index)) drop(index);
  }
  for (const [index, entry] of entries) {
    if (!droppedSince(index)) adopt(index, entry);
  }
  loaded = true;
}

function load() {
  return inTurn(loadAll);
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
 * core-process.js: main's copy follows `client`, the core client, loaded
 * whole at each start of the core (a restarted core reads the file again).
 */
function attachCore(client) {
  if (!client || typeof client.on !== 'function' || client === attachedCore) return;
  attachedCore = client;
  firstLoad = new Promise((resolve) => {
    settleFirstLoad = resolve;
  });
  const settle = settleFirstLoad;
  client.on('ready', () => {
    load()
      .catch((err) =>
        console.error(
          `${LOG} Failed to load the pending Safe transactions (${err?.code || 'error'}):`,
          err?.message || err
        )
      )
      .finally(settle);
  });
  // A core that fails to start leaves the copy unread: `ready` then tries
  // a load of its own, which fails as the core is down.
  client.on('failed', settle);
}

/** Resolves once main's copy has been loaded; rejects if it can't be. */
async function whenLoaded() {
  if (!loaded && firstLoad) await firstLoad;
  if (!loaded) await load();
}

/** @returns {Object|null} The pending entry for a safe wallet index */
function getPending(safeIndex) {
  return cache.get(safeIndex) || null;
}

/**
 * Sets the Safe's pending entry in the core, then in main's copy: `entry`
 * itself, which `getPending` answers from then on. Rejects as the core's
 * answer does, with the index read again (see above).
 */
function setPending(safeIndex, entry) {
  return inTurn(async () => {
    let reply;
    try {
      reply = await vault().safePending.set(safeIndex, entry);
    } catch (err) {
      await readAgain(safeIndex);
      throw err;
    }
    notDurable('A pending Safe transaction was saved', reply);
    cache.set(safeIndex, entry);
    confirmed.set(safeIndex, JSON.stringify(entry));
  });
}

/** Clears the Safe's pending entry in the core, then in main's copy; rejects as `setPending` does. */
function clearPending(safeIndex) {
  return inTurn(async () => {
    let reply;
    try {
      reply = await vault().safePending.clear(safeIndex);
    } catch (err) {
      await readAgain(safeIndex);
      throw err;
    }
    notDurable('A pending Safe transaction was cleared', reply);
    drop(safeIndex);
  });
}

/** Safe wallet indexes that currently have a pending SafeTx, ascending. */
function listPendingIndexes() {
  return [...cache.keys()].sort((a, b) => a - b);
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
  attachedCore = null;
  loaded = false;
  firstLoad = null;
  settleFirstLoad = null;
}

module.exports = {
  /** Resolves once main's copy has been loaded from the core; rejects if it can't be. */
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
