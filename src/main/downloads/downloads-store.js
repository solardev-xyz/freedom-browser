/**
 * Download history (SQLite-backed). One row per download the browser has
 * accepted via `will-download`, mirrored live while the DownloadItem is in
 * flight and left behind as history once it settles.
 *
 * PRIVATE MODE GUARD (downloads): private-window downloads never reach
 * this store — their rows live in private-downloads-store.js (in-memory,
 * partition-scoped). The is_private / session_partition columns remain for
 * schema continuity and the legacy startup sweep (removeAllPrivateDownloads)
 * that cleans rows written by older builds.
 *
 * States: 'in_progress' | 'completed' | 'cancelled' | 'interrupted'.
 * Rows left 'in_progress' by a crash are swept to 'interrupted' on the
 * next startup (see markStaleInProgressAsInterrupted).
 */

const log = require('../logger');
const { app } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');

const DB_FILE = 'downloads.sqlite';

const STATES = Object.freeze({
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  INTERRUPTED: 'interrupted',
});

// Database instance (singleton)
let db = null;

/**
 * Get or create the database connection
 * @returns {Database.Database}
 */
function getDb() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), DB_FILE);
  log.info('[Downloads] Opening database:', dbPath);

  db = new Database(dbPath);

  // Enable WAL mode for better performance
  db.pragma('journal_mode = WAL');

  // Run migrations
  migrateDatabase();

  return db;
}

/**
 * Close the database connection
 */
function closeDb() {
  if (db) {
    log.info('[Downloads] Closing database');
    db.close();
    db = null;
    statements = null;
  }
}

/**
 * Run database migrations based on user_version
 */
function migrateDatabase() {
  const version = db.pragma('user_version', { simple: true });
  log.info('[Downloads] Current schema version:', version);

  if (version < 1) {
    log.info('[Downloads] Running migration to version 1');
    db.exec(`
      CREATE TABLE IF NOT EXISTS downloads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT NOT NULL,
        filename TEXT NOT NULL,
        save_path TEXT,
        mime_type TEXT,
        total_bytes INTEGER DEFAULT 0,
        received_bytes INTEGER DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'in_progress',
        start_time INTEGER NOT NULL,
        end_time INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_downloads_start_time ON downloads(start_time DESC);
      CREATE INDEX IF NOT EXISTS idx_downloads_state ON downloads(state);
    `);
    db.pragma('user_version = 1');
  }

  if (version < 2) {
    log.info('[Downloads] Running migration to version 2 (private-window columns)');
    // Historical: older builds flagged private-window rows here so they
    // could be purged later. Private rows no longer reach SQLite at all
    // (see private-downloads-store.js); the columns stay for schema
    // continuity and the legacy startup sweep.
    // (`session_partition`, not `partition` — PARTITION is an SQL keyword.)
    db.exec(`
      ALTER TABLE downloads ADD COLUMN is_private INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE downloads ADD COLUMN session_partition TEXT;
    `);
    db.pragma('user_version = 2');
  }

  // Future migrations go here:
  // if (version < 3) { ... db.pragma('user_version = 3'); }
}

// Prepared statements (lazily initialized)
let statements = null;

function getStatements() {
  if (statements) return statements;

  const database = getDb();

  statements = {
    insert: database.prepare(`
      INSERT INTO downloads (
        url, filename, save_path, mime_type, total_bytes, received_bytes,
        state, start_time, end_time, is_private, session_partition
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: database.prepare(`
      UPDATE downloads SET
        received_bytes = COALESCE(?, received_bytes),
        total_bytes    = COALESCE(?, total_bytes),
        state          = COALESCE(?, state),
        save_path      = COALESCE(?, save_path),
        end_time       = COALESCE(?, end_time)
      WHERE id = ?
    `),
    getAll: database.prepare(`
      SELECT * FROM downloads ORDER BY start_time DESC
    `),
    search: database.prepare(`
      SELECT * FROM downloads
      WHERE filename LIKE ? OR url LIKE ?
      ORDER BY start_time DESC
      LIMIT ?
    `),
    getById: database.prepare(`
      SELECT * FROM downloads WHERE id = ?
    `),
    remove: database.prepare(`
      DELETE FROM downloads WHERE id = ?
    `),
    clearSettled: database.prepare(`
      DELETE FROM downloads WHERE state != 'in_progress'
    `),
    sweepStale: database.prepare(`
      UPDATE downloads SET state = 'interrupted', end_time = ? WHERE state = 'in_progress'
    `),
    removeAllPrivate: database.prepare(`
      DELETE FROM downloads WHERE is_private = 1
    `),
    count: database.prepare(`
      SELECT COUNT(*) as count FROM downloads
    `),
  };

  return statements;
}

/**
 * Insert a new download row (state starts as in_progress).
 * `isPrivate` / `partition` write the legacy private columns; the manager
 * never passes them anymore (private rows are in-memory only) — they exist
 * so tests can fabricate rows for the legacy startup sweep.
 * @param {object} entry - { url, filename, savePath, mimeType, totalBytes, startTime }
 * @returns {object} The inserted row shape (with id)
 */
function insertDownload(entry) {
  const { url, filename, savePath, mimeType, totalBytes, startTime, isPrivate, partition } = entry;
  const start = startTime || Date.now();
  const privateFlag = isPrivate ? 1 : 0;

  const stmt = getStatements().insert;
  const result = stmt.run(
    url,
    filename,
    savePath || null,
    mimeType || null,
    totalBytes || 0,
    0,
    STATES.IN_PROGRESS,
    start,
    null,
    privateFlag,
    partition || null
  );

  log.info('[Downloads] Recorded download start:', filename, privateFlag ? '(private)' : '');

  return {
    id: result.lastInsertRowid,
    url,
    filename,
    save_path: savePath || null,
    mime_type: mimeType || null,
    total_bytes: totalBytes || 0,
    received_bytes: 0,
    state: STATES.IN_PROGRESS,
    start_time: start,
    end_time: null,
    is_private: privateFlag,
    session_partition: partition || null,
  };
}

/**
 * Patch a download row. Only the provided fields are written.
 * @param {number} id - Row ID
 * @param {object} patch - { receivedBytes, totalBytes, state, savePath, endTime }
 * @returns {boolean} Whether a row was updated
 */
function updateDownload(id, patch = {}) {
  const stmt = getStatements().update;
  const result = stmt.run(
    patch.receivedBytes ?? null,
    patch.totalBytes ?? null,
    patch.state ?? null,
    patch.savePath ?? null,
    patch.endTime ?? null,
    id
  );
  return result.changes > 0;
}

/**
 * Get all downloads, newest first
 * @returns {Array} Download rows
 */
function getAllDownloads() {
  const stmt = getStatements().getAll;
  return stmt.all();
}

/**
 * Search downloads by filename or URL
 * @param {string} query - Search query
 * @param {number} limit - Maximum results
 * @returns {Array} Matching rows
 */
function searchDownloads(query, limit = 100) {
  const searchPattern = `%${query}%`;
  const stmt = getStatements().search;
  return stmt.all(searchPattern, searchPattern, limit);
}

/**
 * Get a download row by ID
 * @param {number} id - Row ID
 * @returns {object|null}
 */
function getDownloadById(id) {
  const stmt = getStatements().getById;
  return stmt.get(id) || null;
}

/**
 * Remove a download row by ID (history entry only — never touches the file)
 * @param {number} id - Row ID
 * @returns {boolean} Whether the row was removed
 */
function removeDownload(id) {
  const stmt = getStatements().remove;
  const result = stmt.run(id);
  log.info('[Downloads] Removed entry:', id, '(changes:', result.changes, ')');
  return result.changes > 0;
}

/**
 * Clear all settled downloads (in-progress rows are kept — cancel first)
 * @returns {number} Number of rows removed
 */
function clearDownloads() {
  const stmt = getStatements().clearSettled;
  const result = stmt.run();
  log.info('[Downloads] Cleared download history (', result.changes, 'entries)');
  return result.changes;
}

/**
 * PRIVATE MODE GUARD (downloads history): legacy startup sweep. Current
 * code never writes private rows to SQLite (they live in
 * private-downloads-store.js), but builds before that change did — drop
 * any such rows left behind in an old profile. Files on disk are
 * untouched. Note: a plain DELETE cannot scrub previously written
 * SQLite/WAL pages, which is exactly why private rows are no longer
 * written here in the first place.
 * @returns {number} Number of rows removed
 */
function removeAllPrivateDownloads() {
  const stmt = getStatements().removeAllPrivate;
  const result = stmt.run();
  if (result.changes > 0) {
    log.info('[Downloads] Purged', result.changes, 'stale private download entries at startup');
  }
  return result.changes;
}

/**
 * Sweep rows left 'in_progress' by a previous run (crash / force quit) to
 * 'interrupted'. Call once at startup, before any UI reads the table.
 * @returns {number} Number of rows swept
 */
function markStaleInProgressAsInterrupted() {
  const stmt = getStatements().sweepStale;
  const result = stmt.run(Date.now());
  if (result.changes > 0) {
    log.info('[Downloads] Marked', result.changes, 'stale in-progress downloads as interrupted');
  }
  return result.changes;
}

/**
 * Get download row count
 * @returns {number} Total rows
 */
function getDownloadCount() {
  const stmt = getStatements().count;
  const result = stmt.get();
  return result.count;
}

module.exports = {
  STATES,
  getDb,
  closeDb,
  insertDownload,
  updateDownload,
  getAllDownloads,
  searchDownloads,
  getDownloadById,
  removeDownload,
  clearDownloads,
  removeAllPrivateDownloads,
  markStaleInProgressAsInterrupted,
  getDownloadCount,
};
