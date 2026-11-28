/**
 * Publish History (SQLite-backed).
 *
 * On first open: migrate the legacy publish-history.json one-shot, then sweep
 * any 'uploading' rows left behind by a crashed prior session into 'failed'
 * (we don't recover in-flight uploads — the user re-initiates).
 *
 * **Where it lives** (freedom-core design 0015, D3, D7 and D10; the SWM-6 to
 * SWM-9 plan's PR 6.4): main's own database, publish-history.sqlite, unless
 * this process's hello names `swarm_stores` (core-client.js
 * `swarmStoresNamed()`: a process on the core's Swarm backend, from SWM-7's
 * flip, PR 7.4; until then only tests). Then the history is the core's, and
 * main never opens the database, its `-wal` and `-shm` files or the legacy
 * publish-history.json, whose one-shot import is the core's too (D10):
 * - the chrome's handlers (`registerPublishHistoryIpc`) relay to the core's
 *   `swarm.history` `list` and `clear`, as `chrome`, and keep their
 *   `{ success }` wrap around its answer or its error;
 * - main's own calls are `coreOps`, the core's `add`, `update`, `list`,
 *   `clear` and `remove`, as `shell`: the rows publish-service.js's
 *   freedom://publish handlers keep around an upload, and the agent's
 *   publication controller's (`freedom://agent`, written before the
 *   upload); their callers pick these or the functions below by
 *   `swarmStoresNamed()`;
 * - every function below that opens the database throws, unrun (`getDb`).
 *   Among them are the JS provider's direct calls (swarm-provider-ipc.js's
 *   `addEntry` and `updateEntry`), which have no place on such a process:
 *   the JS provider can't run there (the plan's point 1; PR 7.4 sends its
 *   methods to the core).
 */

const log = require('../logger');
const { app, ipcMain } = require('electron');
const { getFreedomDataPath } = require('../freedom-root');
const { normalizeOrigin } = require('../../shared/origin-utils');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const HISTORY_FILE = 'publish-history.sqlite';
const LEGACY_FILE = 'publish-history.json';
// The most of a legacy file the core's hand-over reads (freedom-core
// payments_store.rs `PUBLISH_HISTORY.max_bytes`); a larger one it never
// copies or imports.
const LEGACY_MAX_BYTES = 16 * 1024 * 1024;
const SCHEMA_VERSION = 1;
const ORPHAN_SWEEP_MESSAGE = 'interrupted by app exit';
const MIGRATED_SUFFIX = '.migrated';

const FINAL_STATUSES = new Set(['completed', 'failed']);
const isFinalStatus = (status) => FINAL_STATUSES.has(status);

let db = null;
let statements = null;

/** Whether the history is the core's (core-client.js `swarmStoresNamed`). */
function storeIsCore() {
  return require('../core/core-client').swarmStoresNamed();
}

/**
 * Throws once the history is the core's: main then never opens
 * publish-history.sqlite or the legacy publish-history.json (design 0015,
 * D3 and D10; the SWM-6 to SWM-9 plan, section 5).
 */
function assertMainStore() {
  if (storeIsCore()) {
    throw new Error(`${HISTORY_FILE} is the identity core's: main doesn't open it`);
  }
}

function getDb() {
  // Every read and write of the database, and the legacy import, come
  // through here.
  assertMainStore();
  if (db) return db;

  const dbPath = getFreedomDataPath(HISTORY_FILE);
  log.info('[PublishHistory] Opening database:', dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  migrateDatabase();
  migrateFromJson();
  sweepOrphans();

  return db;
}

function closeDb() {
  if (db) {
    log.info('[PublishHistory] Closing database');
    db.close();
    db = null;
    statements = null;
  }
}

function migrateDatabase() {
  const version = db.pragma('user_version', { simple: true });

  if (version < SCHEMA_VERSION) {
    log.info(`[PublishHistory] Migrating schema ${version} → ${SCHEMA_VERSION}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS publishes (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        type          TEXT NOT NULL,
        name          TEXT,
        status        TEXT NOT NULL,
        reference     TEXT,
        bzz_url       TEXT,
        tag_uid       INTEGER,
        batch_id      TEXT,
        origin        TEXT,
        bytes_size    INTEGER,
        started_at    INTEGER NOT NULL,
        completed_at  INTEGER,
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_publishes_started   ON publishes(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_publishes_type      ON publishes(type);
      CREATE INDEX IF NOT EXISTS idx_publishes_status    ON publishes(status);
      CREATE INDEX IF NOT EXISTS idx_publishes_reference ON publishes(reference);
      CREATE INDEX IF NOT EXISTS idx_publishes_origin    ON publishes(origin);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

/**
 * `file` read as the core's hand-over reads a legacy file (fc-store's
 * `read_file`): `{ bytes }` for a regular file, not a link, that this user
 * owns (on POSIX) and that holds at most `LEGACY_MAX_BYTES`; `'missing'`;
 * or `'unreadable'` for anything else.
 */
function readAsCore(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    return err.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
  const owned = typeof process.getuid !== 'function' || stat.uid === process.getuid();
  if (!stat.isFile() || !owned || stat.size > LEGACY_MAX_BYTES) return 'unreadable';
  try {
    const bytes = fs.readFileSync(file);
    return bytes.length > LEGACY_MAX_BYTES ? 'unreadable' : { bytes };
  } catch {
    return 'unreadable';
  }
}

/**
 * `file`, in `dir`, made durable as the core's step 4 syncs its `.migrated`
 * before it drops the original: the file's fsync, then, but on Windows,
 * the directory's.
 */
function syncMarker(dir, file) {
  const fd = fs.openSync(file, process.platform === 'win32' ? 'r+' : 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform === 'win32') return;
  const dirFd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(dirFd);
  } finally {
    fs.closeSync(dirFd);
  }
}

/**
 * Whether the core imported the profile's legacy file already, and so
 * nothing is left to import: the core's D10 hand-over (freedom-core design
 * 0015, D10; design 0017, C5; `payments_store.rs` `hand_over_of`, step 4).
 * In a moved profile the core copies `jsonPath` into the Freedom root,
 * imports the copy there and renames it `.migrated`, and drops the original
 * only at its own next start, once that `.migrated` holds exactly the
 * original's bytes and no other file there under either name conflicts. A
 * start on this module before then would import the original again (the
 * SWM-6 to SWM-9 plan, point 2). So, in that state, the original is
 * retired as the core's step 4 retires it: the `.migrated` made durable,
 * then the original removed; if the sync fails it stays, for a later start,
 * unimported. Any other state (the profile's root layout, no `.migrated`
 * there, other bytes, a file the core wouldn't read) is left to the import
 * below, as before.
 *
 * @param {string} jsonPath - the profile's legacy file, present
 * @returns {boolean} true when the core's import stands and nothing is imported
 */
function retireIfCoreImported(jsonPath) {
  const markerPath = getFreedomDataPath(LEGACY_FILE + MIGRATED_SUFFIX);
  const freedomRoot = path.dirname(markerPath);
  // The profile's root layout: its own `.migrated` is the stray case above.
  if (freedomRoot === path.dirname(jsonPath)) return false;
  const original = readAsCore(jsonPath);
  if (typeof original === 'string') return false;
  const found = (file) => {
    const read = readAsCore(file);
    if (read === 'missing') return 'missing';
    return typeof read === 'object' && read.bytes.equals(original.bytes) ? 'same' : 'other';
  };
  const copy = found(getFreedomDataPath(LEGACY_FILE));
  if (found(markerPath) !== 'same' || copy === 'other') return false;
  try {
    syncMarker(freedomRoot, markerPath);
  } catch (err) {
    log.error(
      "[PublishHistory] Cannot sync the Freedom root's publish-history.json.migrated; the original stays:",
      err.message
    );
    return true;
  }
  try {
    fs.unlinkSync(jsonPath);
    log.info(
      '[PublishHistory] Dropped publish-history.json at the profile root (the core imported its copy)'
    );
  } catch (err) {
    log.error(
      '[PublishHistory] Failed to remove publish-history.json at the profile root:',
      err.message
    );
  }
  return true;
}

// Renamed to .migrated on success; left in place on parse failure as a
// recovery breadcrumb.
function migrateFromJson() {
  const jsonPath = path.join(app.getPath('userData'), 'publish-history.json');
  if (!fs.existsSync(jsonPath)) return;

  // .migrated present = prior successful migration. The publishes table has
  // no unique key, so re-importing a stray .json would duplicate every row.
  const migratedPath = jsonPath + MIGRATED_SUFFIX;
  if (fs.existsSync(migratedPath)) {
    try {
      fs.unlinkSync(jsonPath);
      log.info('[PublishHistory] Dropped stray publish-history.json (already migrated)');
    } catch (err) {
      log.error('[PublishHistory] Failed to remove stray publish-history.json:', err.message);
    }
    return;
  }

  // The core's hand-over imported it already (a moved profile, back on
  // main's own history before the core's next start).
  if (retireIfCoreImported(jsonPath)) return;

  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const entries = Array.isArray(raw?.entries) ? raw.entries : [];

    if (entries.length > 0) {
      const insert = db.prepare(`
        INSERT INTO publishes (
          type, name, status, reference, bzz_url, tag_uid, batch_id,
          origin, bytes_size, started_at, completed_at, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const insertMany = db.transaction((items) => {
        for (const e of items) {
          // Date.parse returns NaN for malformed input; better-sqlite3 rejects
          // NaN at bind, which would roll back the whole migration and trap us
          // in a retry loop on every boot. Fall back to now() on bad input.
          const parsed = e.timestamp ? Date.parse(e.timestamp) : NaN;
          const startedAt = Number.isFinite(parsed) ? parsed : Date.now();
          const status = e.status || 'completed';
          const finalized = isFinalStatus(status);
          insert.run(
            e.type || 'data',
            e.name || null,
            status,
            e.reference || null,
            e.bzzUrl || null,
            e.tagUid ?? null,
            e.batchIdUsed || null,
            null,
            null,
            startedAt,
            finalized ? startedAt : null,
            null
          );
        }
      });

      insertMany(entries);
      log.info(`[PublishHistory] Migrated ${entries.length} entries from JSON`);
    }

    fs.renameSync(jsonPath, migratedPath);
  } catch (err) {
    log.error('[PublishHistory] Failed to migrate from JSON:', err.message);
  }
}

function sweepOrphans() {
  const stmt = db.prepare(`
    UPDATE publishes
    SET status = ?, error_message = ?, completed_at = ?
    WHERE status = ?
  `);
  const result = stmt.run('failed', ORPHAN_SWEEP_MESSAGE, Date.now(), 'uploading');
  if (result.changes > 0) {
    log.info(`[PublishHistory] Swept ${result.changes} orphaned uploading rows to failed`);
  }
}

function getStatements() {
  assertMainStore();
  if (statements) return statements;

  const database = getDb();
  statements = {
    insert: database.prepare(`
      INSERT INTO publishes (
        type, name, status, reference, bzz_url, tag_uid, batch_id,
        origin, bytes_size, started_at, completed_at, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    // Passing NULL for any column keeps the existing value.
    update: database.prepare(`
      UPDATE publishes SET
        status        = COALESCE(?, status),
        reference     = COALESCE(?, reference),
        bzz_url       = COALESCE(?, bzz_url),
        tag_uid       = COALESCE(?, tag_uid),
        batch_id      = COALESCE(?, batch_id),
        bytes_size    = COALESCE(?, bytes_size),
        completed_at  = COALESCE(?, completed_at),
        error_message = COALESCE(?, error_message)
      WHERE id = ?
    `),
    getAll: database.prepare(`SELECT * FROM publishes ORDER BY started_at DESC`),
    getById: database.prepare(`SELECT * FROM publishes WHERE id = ?`),
    delete: database.prepare(`DELETE FROM publishes WHERE id = ?`),
    clear: database.prepare(`DELETE FROM publishes`),
  };
  return statements;
}

// id is now an integer (was a generated string in the JSON store);
// the renderer never reads it, so the type change is transparent.
function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    status: row.status,
    reference: row.reference,
    bzzUrl: row.bzz_url,
    tagUid: row.tag_uid,
    batchIdUsed: row.batch_id,
    origin: row.origin,
    bytesSize: row.bytes_size,
    timestamp: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    errorMessage: row.error_message,
  };
}

function addEntry(entry = {}) {
  const startedAt = Date.now();
  const status = entry.status || 'uploading';
  const finalized = isFinalStatus(status);

  const result = getStatements().insert.run(
    entry.type || 'data',
    entry.name || null,
    status,
    entry.reference || null,
    entry.bzzUrl || null,
    entry.tagUid ?? null,
    entry.batchIdUsed || null,
    entry.origin || null,
    entry.bytesSize ?? null,
    startedAt,
    finalized ? startedAt : null,
    entry.errorMessage || null
  );

  return rowToEntry(getStatements().getById.get(result.lastInsertRowid));
}

function updateEntry(id, updates = {}) {
  const status = updates.status || null;
  const finalized = isFinalStatus(status);

  const result = getStatements().update.run(
    status,
    updates.reference || null,
    updates.bzzUrl || null,
    updates.tagUid ?? null,
    updates.batchIdUsed || null,
    updates.bytesSize ?? null,
    finalized ? Date.now() : null,
    updates.errorMessage || null,
    id
  );

  if (result.changes === 0) return null;
  return rowToEntry(getStatements().getById.get(id));
}

function getEntries() {
  return getStatements().getAll.all().map(rowToEntry);
}

function clearEntries() {
  getStatements().clear.run();
}

function removeEntry(id) {
  return getStatements().delete.run(id).changes > 0;
}

/**
 * The core's `swarm.history` op `op` with `members`, main's own (`shell`)
 * or the chrome's request main relays (`chrome`): the op's answer, or what
 * it threw (core/swarm-stores.js).
 */
function historyOp(op, members = {}, caller = 'shell') {
  return require('../core/swarm-stores').history(op, members, { caller });
}

/**
 * `entry` with its site (`origin`) as its permission key
 * (`normalizeOrigin`), as main gives every site to the core's stores, which
 * normalize none again (fc-swarm-provider's `stores`). The core stores the
 * row's origin as given, as the reference does; main's own rows carry
 * `freedom://publish` and `freedom://agent`, each its own key, so their
 * rows are the reference's.
 */
function withSiteKey(entry) {
  if (entry === null || typeof entry !== 'object' || typeof entry.origin !== 'string') {
    return entry;
  }
  return { ...entry, origin: normalizeOrigin(entry.origin) };
}

/**
 * Main's own calls on the core's history (design 0015, "Methods main
 * calls": `swarm.history`; core PR K1's `add` and `update`), for a process
 * whose hello names `swarm_stores`: each the core's `shell` op for this
 * module's function of the same name, with that function's arguments. Each
 * resolves with what the function returns (`addEntry`'s row, `updateEntry`'s
 * row or `null`, `removeEntry`'s boolean), or rejects with what it throws
 * or the protocol's error (core/swarm-stores.js). The core takes each row's
 * times from its own clock, as the function takes `Date.now()`.
 *
 * Unused while main writes publish-history.sqlite: publish-service.js and
 * the agent's publication controller call these or the functions below by
 * `swarmStoresNamed()`.
 */
const coreOps = Object.freeze({
  addEntry: (entry) => historyOp('add', { entry: withSiteKey(entry) }),
  updateEntry: (id, updates) => historyOp('update', { id, updates }),
  getEntries: () => historyOp('list'),
  clearEntries: () => historyOp('clear'),
  removeEntry: (id) => historyOp('remove', { id }),
});

/**
 * The chrome's request relayed to the core's `op`, as `chrome`, in the
 * handler's own wrap: `wrap(answer)`, or `{ success: false, error }` for
 * what the op threw or the protocol's error.
 */
async function chromeRelay(op, wrap, what) {
  try {
    return wrap(await historyOp(op, {}, 'chrome'));
  } catch (err) {
    log.error(`[PublishHistory] Failed to ${what} history:`, err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Register IPC handlers for the publish history. Once the history is the
 * core's (`storeIsCore()`), each relays the chrome's request to the core's
 * op, as `chrome` (design 0015, D7), in the same wrap.
 */
function registerPublishHistoryIpc() {
  ipcMain.handle('swarm:get-publish-history', () => {
    if (storeIsCore()) {
      return chromeRelay('list', (entries) => ({ success: true, entries }), 'get');
    }
    try {
      return { success: true, entries: getEntries() };
    } catch (err) {
      log.error('[PublishHistory] Failed to get history:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:clear-publish-history', () => {
    if (storeIsCore()) return chromeRelay('clear', () => ({ success: true }), 'clear');
    try {
      clearEntries();
      return { success: true };
    } catch (err) {
      log.error('[PublishHistory] Failed to clear history:', err.message);
      return { success: false, error: err.message };
    }
  });

  log.info('[PublishHistory] IPC handlers registered');
}

module.exports = {
  addEntry,
  updateEntry,
  getEntries,
  clearEntries,
  removeEntry,
  registerPublishHistoryIpc,
  coreOps,
  getDb,
  closeDb,
  ORPHAN_SWEEP_MESSAGE,
};
