// In-memory fake of better-sqlite3 sized to the `downloads` table only.
// Mirrors the SQL strings emitted by src/main/downloads/downloads-store.js.
// Unknown SQL throws so schema drift surfaces as a test failure.

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const cloneRow = (row) => (row ? { ...row } : row);

const matchesLike = (value, pattern) =>
  String(value || '')
    .toLowerCase()
    .includes(
      String(pattern || '')
        .toLowerCase()
        .replace(/%/g, '')
    );

const INSERT_NORM = norm(`INSERT INTO downloads (
  url, filename, save_path, mime_type, total_bytes, received_bytes,
  state, start_time, end_time, is_private, session_partition
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const UPDATE_NORM = norm(`UPDATE downloads SET
  received_bytes = COALESCE(?, received_bytes),
  total_bytes    = COALESCE(?, total_bytes),
  state          = COALESCE(?, state),
  save_path      = COALESCE(?, save_path),
  end_time       = COALESCE(?, end_time)
WHERE id = ?`);

const GET_ALL_NORM = norm(`SELECT * FROM downloads ORDER BY start_time DESC`);
const SEARCH_NORM = norm(`SELECT * FROM downloads
  WHERE filename LIKE ? OR url LIKE ?
  ORDER BY start_time DESC
  LIMIT ?`);
const GET_BY_ID_NORM = norm(`SELECT * FROM downloads WHERE id = ?`);
const REMOVE_NORM = norm(`DELETE FROM downloads WHERE id = ?`);
const CLEAR_NORM = norm(`DELETE FROM downloads WHERE state != 'in_progress'`);
const SWEEP_NORM = norm(
  `UPDATE downloads SET state = 'interrupted', end_time = ? WHERE state = 'in_progress'`
);
const COUNT_NORM = norm(`SELECT COUNT(*) as count FROM downloads`);
const REMOVE_ALL_PRIVATE_NORM = norm(`DELETE FROM downloads WHERE is_private = 1`);

class FakeBetterSqlite3DownloadsDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.rows = [];
    this.nextId = 1;
    this.userVersion = 0;
  }

  pragma(statement, options = {}) {
    if (statement === 'journal_mode = WAL') return 'wal';
    if (statement === 'user_version' && options.simple) return this.userVersion;
    const match = /^user_version = (\d+)$/.exec(statement);
    if (match) {
      this.userVersion = Number(match[1]);
      return this.userVersion;
    }
    return null;
  }

  exec() {
    // CREATE TABLE / CREATE INDEX — schema isn't enforced.
  }

  sortedRows() {
    return [...this.rows].sort((a, b) => b.start_time - a.start_time);
  }

  prepare(sql) {
    const normalized = norm(sql);

    if (normalized === INSERT_NORM) {
      return {
        run: (
          url,
          filename,
          savePath,
          mimeType,
          totalBytes,
          receivedBytes,
          state,
          startTime,
          endTime,
          isPrivate,
          sessionPartition
        ) => {
          const row = {
            id: this.nextId++,
            url,
            filename,
            save_path: savePath,
            mime_type: mimeType,
            total_bytes: totalBytes,
            received_bytes: receivedBytes,
            state,
            start_time: startTime,
            end_time: endTime,
            is_private: isPrivate,
            session_partition: sessionPartition,
          };
          this.rows.push(row);
          return { changes: 1, lastInsertRowid: row.id };
        },
      };
    }

    if (normalized === UPDATE_NORM) {
      return {
        run: (receivedBytes, totalBytes, state, savePath, endTime, id) => {
          const row = this.rows.find((r) => r.id === id);
          if (!row) return { changes: 0 };
          if (receivedBytes !== null && receivedBytes !== undefined)
            row.received_bytes = receivedBytes;
          if (totalBytes !== null && totalBytes !== undefined) row.total_bytes = totalBytes;
          if (state !== null && state !== undefined) row.state = state;
          if (savePath !== null && savePath !== undefined) row.save_path = savePath;
          if (endTime !== null && endTime !== undefined) row.end_time = endTime;
          return { changes: 1 };
        },
      };
    }

    if (normalized === GET_ALL_NORM) {
      return { all: () => this.sortedRows().map(cloneRow) };
    }

    if (normalized === SEARCH_NORM) {
      return {
        all: (filenamePattern, urlPattern, limit) =>
          this.sortedRows()
            .filter(
              (row) =>
                matchesLike(row.filename, filenamePattern) || matchesLike(row.url, urlPattern)
            )
            .slice(0, limit)
            .map(cloneRow),
      };
    }

    if (normalized === GET_BY_ID_NORM) {
      return { get: (id) => cloneRow(this.rows.find((r) => r.id === id)) };
    }

    if (normalized === REMOVE_NORM) {
      return {
        run: (id) => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.id !== id);
          return { changes: before - this.rows.length };
        },
      };
    }

    if (normalized === CLEAR_NORM) {
      return {
        run: () => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.state === 'in_progress');
          return { changes: before - this.rows.length };
        },
      };
    }

    if (normalized === SWEEP_NORM) {
      return {
        run: (endTime) => {
          let changes = 0;
          for (const row of this.rows) {
            if (row.state === 'in_progress') {
              row.state = 'interrupted';
              row.end_time = endTime;
              changes++;
            }
          }
          return { changes };
        },
      };
    }

    if (normalized === REMOVE_ALL_PRIVATE_NORM) {
      return {
        run: () => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.is_private !== 1);
          return { changes: before - this.rows.length };
        },
      };
    }

    if (normalized === COUNT_NORM) {
      return { get: () => ({ count: this.rows.length }) };
    }

    throw new Error(`Unsupported SQL in fake-better-sqlite3-downloads: ${normalized}`);
  }

  close() {}
}

module.exports = FakeBetterSqlite3DownloadsDatabase;
