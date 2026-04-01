/**
 * Publish History
 *
 * Persists recent Swarm publishes to a JSON file. Designed as a storage
 * abstraction so it can be migrated to SQLite later if publish history
 * grows into a real job system.
 *
 * Entry model:
 *   { id, reference, bzzUrl, type, name, timestamp, tagUid, batchIdUsed, status }
 *
 * Status lifecycle: uploading → completed / failed
 */

const fs = require('fs');
const path = require('path');
const { app, ipcMain } = require('electron');
const log = require('electron-log');

const HISTORY_FILE = path.join(app.getPath('userData'), 'publish-history.json');
const MAX_ENTRIES = 100;
const SCHEMA_VERSION = 1;

let entries = null; // lazy-loaded

// ============================================
// Storage layer
// ============================================

function load() {
  if (entries !== null) return;

  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (raw.version === SCHEMA_VERSION && Array.isArray(raw.entries)) {
        entries = raw.entries;
        return;
      }
    }
  } catch (err) {
    log.error('[PublishHistory] Failed to load history:', err.message);
  }

  entries = [];
}

function save() {
  try {
    const data = JSON.stringify({ version: SCHEMA_VERSION, entries }, null, 2);
    fs.writeFileSync(HISTORY_FILE, data, 'utf-8');
  } catch (err) {
    log.error('[PublishHistory] Failed to save history:', err.message);
  }
}

// ============================================
// Public API
// ============================================

function addEntry(entry) {
  load();

  const record = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    reference: entry.reference || null,
    bzzUrl: entry.bzzUrl || null,
    type: entry.type || 'data', // 'data', 'file', 'directory'
    name: entry.name || null,
    timestamp: new Date().toISOString(),
    tagUid: entry.tagUid || null,
    batchIdUsed: entry.batchIdUsed || null,
    status: entry.status || 'uploading',
  };

  entries.unshift(record);

  // Cap the list
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(0, MAX_ENTRIES);
  }

  save();
  return record;
}

function updateEntry(id, updates) {
  load();

  const entry = entries.find((e) => e.id === id);
  if (!entry) return null;

  if (updates.status) entry.status = updates.status;
  if (updates.reference) entry.reference = updates.reference;
  if (updates.bzzUrl) entry.bzzUrl = updates.bzzUrl;
  if (updates.tagUid !== undefined) entry.tagUid = updates.tagUid;
  if (updates.batchIdUsed) entry.batchIdUsed = updates.batchIdUsed;

  save();
  return entry;
}

function getEntries() {
  load();
  return [...entries];
}

function clearEntries() {
  entries = [];
  save();
}

function removeEntry(id) {
  load();
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  if (entries.length !== before) save();
}

// ============================================
// IPC registration
// ============================================

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
};
