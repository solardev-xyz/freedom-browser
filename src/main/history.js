const log = require('./logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const Database = require('better-sqlite3');
const IPC = require('../shared/ipc-channels');

// Database instance (singleton)
let db = null;

/**
 * Get or create the database connection
 * @returns {Database.Database}
 */
function getDb() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), 'history.sqlite');
  log.info('[History] Opening database:', dbPath);

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
    log.info('[History] Closing database');
    db.close();
    db = null;
  }
}

/**
 * Run database migrations based on user_version
 */
function migrateDatabase() {
  const version = db.pragma('user_version', { simple: true });
  log.info('[History] Current schema version:', version);

  if (version < 1) {
    log.info('[History] Running migration to version 1');
    db.exec(`
      CREATE TABLE IF NOT EXISTS history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        title TEXT,
        timestamp INTEGER NOT NULL,
        visit_count INTEGER DEFAULT 1,
        protocol TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_history_url ON history(url);
    `);
    db.pragma('user_version = 1');
  }

  // Future migrations go here:
  // if (version < 2) { ... db.pragma('user_version = 2'); }
}

// Prepared statements (lazily initialized)
let statements = null;

function getStatements() {
  if (statements) return statements;

  const database = getDb();

  statements = {
    upsert: database.prepare(`
      INSERT INTO history (url, title, timestamp, visit_count, protocol)
      VALUES (?, ?, ?, 1, ?)
      ON CONFLICT(url) DO UPDATE SET
        title = excluded.title,
        timestamp = excluded.timestamp,
        visit_count = visit_count + 1
    `),
    getRecent: database.prepare(`
      SELECT * FROM history ORDER BY timestamp DESC LIMIT ?
    `),
    getAll: database.prepare(`
      SELECT * FROM history ORDER BY timestamp DESC
    `),
    search: database.prepare(`
      SELECT * FROM history 
      WHERE url LIKE ? OR title LIKE ?
      ORDER BY timestamp DESC 
      LIMIT ?
    `),
    getById: database.prepare(`
      SELECT * FROM history WHERE id = ?
    `),
    remove: database.prepare(`
      DELETE FROM history WHERE id = ?
    `),
    clear: database.prepare(`
      DELETE FROM history
    `),
    count: database.prepare(`
      SELECT COUNT(*) as count FROM history
    `),
  };

  return statements;
}

/**
 * Add or update a history entry
 * @param {object} entry - { url, title, protocol }
 * @returns {object} The upserted entry
 */
function addHistoryEntry(entry) {
  const { url, title, protocol } = entry;
  const timestamp = Date.now();

  const stmt = getStatements().upsert;
  const result = stmt.run(url, title || '', timestamp, protocol || 'unknown');

  log.info('[History] Added/updated entry:', url, '(changes:', result.changes, ')');

  return {
    id: result.lastInsertRowid,
    url,
    title,
    timestamp,
    protocol,
  };
}

/**
 * Get recent history entries
 * @param {number} limit - Maximum number of entries to return
 * @returns {Array} History entries
 */
function getRecentHistory(limit = 100) {
  const stmt = getStatements().getRecent;
  return stmt.all(limit);
}

/**
 * Get all history entries
 * @returns {Array} All history entries
 */
function getAllHistory() {
  const stmt = getStatements().getAll;
  return stmt.all();
}

/**
 * Search history by URL or title
 * @param {string} query - Search query
 * @param {number} limit - Maximum results
 * @returns {Array} Matching entries
 */
function searchHistory(query, limit = 50) {
  const searchPattern = `%${query}%`;
  const stmt = getStatements().search;
  return stmt.all(searchPattern, searchPattern, limit);
}

/**
 * Remove a history entry by ID
 * @param {number} id - Entry ID
 * @returns {boolean} Whether the entry was removed
 */
function removeHistoryEntry(id) {
  const stmt = getStatements().remove;
  const result = stmt.run(id);
  log.info('[History] Removed entry:', id, '(changes:', result.changes, ')');
  return result.changes > 0;
}

/**
 * Clear all history
 * @returns {number} Number of entries removed
 */
function clearHistory() {
  const stmt = getStatements().clear;
  const result = stmt.run();
  log.info('[History] Cleared all history (', result.changes, 'entries)');

  // Vacuum to reclaim space
  getDb().exec('VACUUM');

  return result.changes;
}

/**
 * Get history entry count
 * @returns {number} Total entries
 */
function getHistoryCount() {
  const stmt = getStatements().count;
  const result = stmt.get();
  return result.count;
}

/**
 * Register IPC handlers for history operations
 */
function registerHistoryIpc() {
  // Get history (with optional limit)
  ipcMain.handle(IPC.HISTORY_GET, (_event, options = {}) => {
    const { limit, query } = options;

    if (query) {
      return searchHistory(query, limit || 50);
    }

    if (limit) {
      return getRecentHistory(limit);
    }

    return getAllHistory();
  });

  // Add history entry
  ipcMain.handle(IPC.HISTORY_ADD, (_event, entry) => {
    if (!entry?.url) {
      log.warn('[History] Attempted to add entry without URL');
      return null;
    }
    return addHistoryEntry(entry);
  });

  // Remove history entry by ID
  ipcMain.handle(IPC.HISTORY_REMOVE, (_event, id) => {
    return removeHistoryEntry(id);
  });

  // Clear all history
  ipcMain.handle(IPC.HISTORY_CLEAR, () => {
    return clearHistory();
  });

  log.info('[History] IPC handlers registered');
}

module.exports = {
  getDb,
  closeDb,
  addHistoryEntry,
  getRecentHistory,
  getAllHistory,
  searchHistory,
  removeHistoryEntry,
  clearHistory,
  getHistoryCount,
  registerHistoryIpc,
};
