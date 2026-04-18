/**
 * Publish History (SQLite-backed).
 *
 * On first open: migrate the legacy publish-history.json one-shot, then sweep
 * any 'uploading' rows left behind by a crashed prior session into 'failed'
 * (we don't recover in-flight uploads — the user re-initiates).
 */

const log = require('../logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA_VERSION = 1;
const ORPHAN_SWEEP_MESSAGE = 'interrupted by app exit';
const MIGRATED_SUFFIX = '.migrated';

const FINAL_STATUSES = new Set(['completed', 'failed']);
const isFinalStatus = (status) => FINAL_STATUSES.has(status);

let db = null;
let statements = null;

function getDb() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'publish-history.sqlite');
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

function registerPublishHistoryIpc() {
  ipcMain.handle('swarm:get-publish-history', () => {
    try {
      return { success: true, entries: getEntries() };
    } catch (err) {
      log.error('[PublishHistory] Failed to get history:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:clear-publish-history', () => {
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
  getDb,
  closeDb,
  ORPHAN_SWEEP_MESSAGE,
};
