/**
 * PRIVATE MODE GUARD (downloads): in-memory download history for private
 * windows, keyed by their `private-<uuid>` session partition.
 *
 * Rows for downloads started on a private partition must NEVER reach the
 * profile's downloads.sqlite: a crash would strand them on disk, and even a
 * clean DELETE does not scrub previously written SQLite/WAL pages — the
 * URL and save path could remain recoverable. So private rows live only in
 * this process-memory Map and evaporate with the window (`dropPartition`
 * runs from the private-window close hook in src/main/index.js).
 *
 * Row shape mirrors downloads-store.js (snake_case columns) so renderers
 * treat both sources identically. Ids are NEGATIVE so they can never
 * collide with SQLite AUTOINCREMENT rowids and id-based IPC (pause /
 * open / remove) can route to the right store by sign alone.
 *
 * Deliberately dependency-free (no electron, no better-sqlite3): the state
 * vocabulary is duplicated from downloads-store.STATES rather than
 * imported, so requiring this module can never touch the SQLite store.
 */

const STATE_IN_PROGRESS = 'in_progress';

// Negative id sequence; never reset while the process lives so ids are
// unique across all private windows of a session.
let nextId = -1;

// id -> row. Insertion order is not relied upon — queries sort by
// start_time like the SQLite store does.
const rows = new Map();

/**
 * Record a private download. Mirrors downloads-store.insertDownload but
 * requires the owning partition and always flags the row private.
 * @param {object} entry - { url, filename, savePath, mimeType, totalBytes,
 *   startTime, partition }
 * @returns {object} The inserted row (with its negative id)
 */
function insertDownload(entry) {
  const { url, filename, savePath, mimeType, totalBytes, startTime, partition } = entry;
  const row = {
    id: nextId--,
    url,
    filename,
    save_path: savePath || null,
    mime_type: mimeType || null,
    total_bytes: totalBytes || 0,
    received_bytes: 0,
    state: STATE_IN_PROGRESS,
    start_time: startTime || Date.now(),
    end_time: null,
    is_private: 1,
    session_partition: partition,
  };
  rows.set(row.id, row);
  return { ...row };
}

/**
 * Patch a private row. Same COALESCE semantics as the SQLite store: only
 * the provided fields are written.
 * @param {number} id - Row id (negative)
 * @param {object} patch - { receivedBytes, totalBytes, state, savePath, endTime }
 * @returns {boolean} Whether a row was updated
 */
function updateDownload(id, patch = {}) {
  const row = rows.get(id);
  if (!row) return false;
  if (patch.receivedBytes != null) row.received_bytes = patch.receivedBytes;
  if (patch.totalBytes != null) row.total_bytes = patch.totalBytes;
  if (patch.state != null) row.state = patch.state;
  if (patch.savePath != null) row.save_path = patch.savePath;
  if (patch.endTime != null) row.end_time = patch.endTime;
  return true;
}

/**
 * Get a private row by id.
 * @param {number} id - Row id (negative)
 * @returns {object|null}
 */
function getDownloadById(id) {
  const row = rows.get(id);
  return row ? { ...row } : null;
}

/**
 * All rows for one partition, newest first (matches getAllDownloads order).
 * @param {string} partition
 * @returns {Array} Row copies
 */
function getDownloads(partition) {
  const result = [];
  for (const row of rows.values()) {
    if (row.session_partition === partition) result.push({ ...row });
  }
  return result.sort((a, b) => b.start_time - a.start_time);
}

/**
 * Search one partition's rows by filename or URL substring. Matching is
 * case-insensitive to mirror SQLite's LIKE on the persistent store.
 * @param {string} partition
 * @param {string} query
 * @param {number} limit
 * @returns {Array} Matching row copies, newest first
 */
function searchDownloads(partition, query, limit = 100) {
  const needle = String(query || '').toLowerCase();
  return getDownloads(partition)
    .filter(
      (row) =>
        String(row.filename || '')
          .toLowerCase()
          .includes(needle) ||
        String(row.url || '')
          .toLowerCase()
          .includes(needle)
    )
    .slice(0, limit);
}

/**
 * Remove one private row (history entry only — never touches the file).
 * @param {number} id - Row id (negative)
 * @returns {boolean} Whether the row was removed
 */
function removeDownload(id) {
  return rows.delete(id);
}

/**
 * Clear one partition's settled rows (in-progress rows are kept — cancel
 * first), mirroring clearDownloads on the persistent store.
 * @param {string} partition
 * @returns {number} Number of rows removed
 */
function clearSettled(partition) {
  let removed = 0;
  for (const [id, row] of rows) {
    if (row.session_partition === partition && row.state !== STATE_IN_PROGRESS) {
      rows.delete(id);
      removed++;
    }
  }
  return removed;
}

/**
 * Drop every row for a partition. Called from the private-window close
 * hook — this is the entire "purge": the rows only ever existed in this
 * process's memory, so there is nothing on disk to clean up, crash or not.
 * @param {string} partition
 * @returns {number} Number of rows dropped
 */
function dropPartition(partition) {
  if (!partition) return 0;
  let removed = 0;
  for (const [id, row] of rows) {
    if (row.session_partition === partition) {
      rows.delete(id);
      removed++;
    }
  }
  return removed;
}

/** Total row count across all partitions (test/diagnostic helper). */
function getCount() {
  return rows.size;
}

// Test-only: drop all rows and restart the id sequence.
function _resetState() {
  rows.clear();
  nextId = -1;
}

module.exports = {
  insertDownload,
  updateDownload,
  getDownloadById,
  getDownloads,
  searchDownloads,
  removeDownload,
  clearSettled,
  dropPartition,
  getCount,
  _resetState,
};
