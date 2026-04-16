// In-memory fake of better-sqlite3 sized to the publishes table only.
// Mirrors the prepared SQL strings used by src/main/swarm/publish-history.js;
// throws on anything else so a schema drift surfaces as a test failure.

function cloneRow(row) {
  return row ? { ...row } : row;
}

const INSERT_SQL = `INSERT INTO publishes (
  type, name, status, reference, bzz_url, tag_uid, batch_id, origin, bytes_size,
  started_at, completed_at, error_message
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const UPDATE_SQL = `UPDATE publishes SET
  status = COALESCE(?, status),
  reference = COALESCE(?, reference),
  bzz_url = COALESCE(?, bzz_url),
  tag_uid = COALESCE(?, tag_uid),
  batch_id = COALESCE(?, batch_id),
  bytes_size = COALESCE(?, bytes_size),
  completed_at = COALESCE(?, completed_at),
  error_message = COALESCE(?, error_message)
WHERE id = ?`;

const SWEEP_SQL = `UPDATE publishes SET status = ?, error_message = ?, completed_at = ? WHERE status = ?`;

const GET_ALL_SQL = `SELECT * FROM publishes ORDER BY started_at DESC`;
const GET_BY_ID_SQL = `SELECT * FROM publishes WHERE id = ?`;
const DELETE_BY_ID_SQL = `DELETE FROM publishes WHERE id = ?`;
const CLEAR_SQL = `DELETE FROM publishes`;

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();

const NORMALIZED = {
  insert: norm(INSERT_SQL),
  update: norm(UPDATE_SQL),
  sweep: norm(SWEEP_SQL),
  getAll: norm(GET_ALL_SQL),
  getById: norm(GET_BY_ID_SQL),
  deleteById: norm(DELETE_BY_ID_SQL),
  clear: norm(CLEAR_SQL),
};

const COLUMNS = [
  'type', 'name', 'status', 'reference', 'bzz_url', 'tag_uid', 'batch_id',
  'origin', 'bytes_size', 'started_at', 'completed_at', 'error_message',
];

class FakeBetterSqlite3PublishesDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.rows = [];
    this.nextId = 1;
    this.userVersion = 0;
  }

  pragma(statement, options = {}) {
    if (statement === 'journal_mode = WAL') return 'wal';
    if (statement === 'user_version' && options.simple) return this.userVersion;
    if (statement === 'user_version = 1') {
      this.userVersion = 1;
      return this.userVersion;
    }
    return null;
  }

  exec() {
    // CREATE TABLE / CREATE INDEX — fake storage doesn't enforce schema.
  }

  prepare(sql) {
    const normalized = norm(sql);

    if (normalized === NORMALIZED.insert) {
      return {
        run: (...values) => {
          const row = { id: this.nextId++ };
          COLUMNS.forEach((col, i) => {
            row[col] = values[i] ?? null;
          });
          this.rows.push(row);
          return { changes: 1, lastInsertRowid: row.id };
        },
      };
    }

    if (normalized === NORMALIZED.update) {
      return {
        run: (status, reference, bzzUrl, tagUid, batchId, bytesSize, completedAt, errorMessage, id) => {
          const row = this.rows.find((r) => r.id === id);
          if (!row) return { changes: 0 };
          if (status !== null) row.status = status;
          if (reference !== null) row.reference = reference;
          if (bzzUrl !== null) row.bzz_url = bzzUrl;
          if (tagUid !== null) row.tag_uid = tagUid;
          if (batchId !== null) row.batch_id = batchId;
          if (bytesSize !== null) row.bytes_size = bytesSize;
          if (completedAt !== null) row.completed_at = completedAt;
          if (errorMessage !== null) row.error_message = errorMessage;
          return { changes: 1 };
        },
      };
    }

    if (normalized === NORMALIZED.sweep) {
      return {
        run: (newStatus, errorMessage, completedAt, oldStatus) => {
          let changes = 0;
          for (const row of this.rows) {
            if (row.status === oldStatus) {
              row.status = newStatus;
              row.error_message = errorMessage;
              row.completed_at = completedAt;
              changes++;
            }
          }
          return { changes };
        },
      };
    }

    if (normalized === NORMALIZED.getAll) {
      return {
        all: () =>
          [...this.rows]
            .sort((a, b) => b.started_at - a.started_at)
            .map(cloneRow),
      };
    }

    if (normalized === NORMALIZED.getById) {
      return {
        get: (id) => cloneRow(this.rows.find((r) => r.id === id) || null),
      };
    }

    if (normalized === NORMALIZED.deleteById) {
      return {
        run: (id) => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.id !== id);
          return { changes: before - this.rows.length };
        },
      };
    }

    if (normalized === NORMALIZED.clear) {
      return {
        run: () => {
          const changes = this.rows.length;
          this.rows = [];
          return { changes };
        },
      };
    }

    throw new Error(`Unsupported SQL in fake-better-sqlite3-publishes: ${normalized}`);
  }

  // Real better-sqlite3 returns a wrapper that runs fn inside BEGIN/COMMIT.
  // The fake has no isolation; just call the fn.
  transaction(fn) {
    return (...args) => fn(...args);
  }

  close() {}
}

module.exports = FakeBetterSqlite3PublishesDatabase;
