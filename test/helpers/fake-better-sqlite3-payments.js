// In-memory fake of better-sqlite3 sized to the `payments` table only.
// Mirrors the SQL strings emitted by the reference payment-history module
// (reference-payment-history.js; main's own is the identity core's client
// since PRF-6(c), and the simulated core runs the reference) — both
// the static prepared statements and the dynamic getRecent/getCount
// queries (whose WHERE clauses vary by filter set). Unknown SQL throws
// so schema drift surfaces as a test failure.

const COLUMNS = [
  'kind', 'chain_id', 'tx_hash', 'from_address', 'to_address', 'asset',
  'amount', 'origin', 'url', 'status', 'created_at', 'confirmed_at',
  'gas_used', 'gas_price', 'metadata',
];

const norm = (sql) => sql.replace(/\s+/g, ' ').trim();
const cloneRow = (row) => (row ? { ...row } : row);

const INSERT_NORM = norm(`INSERT INTO payments (
  kind, chain_id, tx_hash, from_address, to_address, asset, amount,
  origin, url, status, created_at, confirmed_at, gas_used, gas_price, metadata
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const UPDATE_NORM = norm(`UPDATE payments SET
  tx_hash      = COALESCE(?, tx_hash),
  status       = COALESCE(?, status),
  confirmed_at = COALESCE(?, confirmed_at),
  gas_used     = COALESCE(?, gas_used),
  gas_price    = COALESCE(?, gas_price),
  metadata     = COALESCE(?, metadata)
WHERE id = ?`);

const GET_BY_ID_NORM     = norm(`SELECT * FROM payments WHERE id = ?`);
const GET_PENDING_NORM   = norm(`SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC`);
const CLEAR_NORM         = norm(`DELETE FROM payments`);
const DELETE_BY_ID_NORM  = norm(`DELETE FROM payments WHERE id = ?`);

// getRecent / getCount build SQL like:
//   SELECT * FROM payments [WHERE col = ? AND ...] ORDER BY created_at DESC LIMIT ? OFFSET ?
//   SELECT COUNT(*) AS n FROM payments [WHERE col = ? AND ...]
const DYNAMIC_SELECT_RE = /^SELECT \* FROM payments(?: WHERE (.+?))? ORDER BY created_at DESC LIMIT \? OFFSET \?$/;
const DYNAMIC_COUNT_RE  = /^SELECT COUNT\(\*\) AS n FROM payments(?: WHERE (.+?))?$/;

function parseWhereClause(whereStr) {
  // e.g. "kind = ? AND chain_id = ?" → ['kind', 'chain_id']
  if (!whereStr) return [];
  return whereStr.split(' AND ').map((part) => part.split(' = ')[0].trim());
}

function rowMatchesFilters(row, columns, values) {
  for (let i = 0; i < columns.length; i++) {
    if (row[columns[i]] !== values[i]) return false;
  }
  return true;
}

class FakeBetterSqlite3PaymentsDatabase {
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
    // CREATE TABLE / CREATE INDEX / VACUUM — schema isn't enforced.
  }

  prepare(sql) {
    const normalized = norm(sql);

    if (normalized === INSERT_NORM) {
      return { run: (...values) => this._insert(values) };
    }

    if (normalized === UPDATE_NORM) {
      return { run: (...values) => this._update(values) };
    }

    if (normalized === GET_BY_ID_NORM) {
      return { get: (id) => cloneRow(this.rows.find((r) => r.id === id)) || null };
    }

    if (normalized === GET_PENDING_NORM) {
      return {
        all: () => this.rows
          .filter((r) => r.status === 'pending')
          .sort((a, b) => a.created_at - b.created_at)
          .map(cloneRow),
      };
    }

    if (normalized === CLEAR_NORM) {
      return {
        run: () => {
          const changes = this.rows.length;
          this.rows = [];
          return { changes };
        },
      };
    }

    if (normalized === DELETE_BY_ID_NORM) {
      return {
        run: (id) => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.id !== id);
          return { changes: before - this.rows.length };
        },
      };
    }

    const selectMatch = DYNAMIC_SELECT_RE.exec(normalized);
    if (selectMatch) {
      const cols = parseWhereClause(selectMatch[1]);
      return {
        all: (...params) => {
          const filterValues = params.slice(0, cols.length);
          const limit = params[cols.length];
          const offset = params[cols.length + 1];
          const filtered = this.rows
            .filter((r) => rowMatchesFilters(r, cols, filterValues))
            .sort((a, b) => b.created_at - a.created_at);
          return filtered.slice(offset, offset + limit).map(cloneRow);
        },
      };
    }

    const countMatch = DYNAMIC_COUNT_RE.exec(normalized);
    if (countMatch) {
      const cols = parseWhereClause(countMatch[1]);
      return {
        get: (...params) => {
          const filterValues = params.slice(0, cols.length);
          return { n: this.rows.filter((r) => rowMatchesFilters(r, cols, filterValues)).length };
        },
      };
    }

    throw new Error(`Unsupported SQL in fake-better-sqlite3-payments: ${normalized}`);
  }

  // Real better-sqlite3 wraps fn in BEGIN/COMMIT; the fake has no
  // isolation and just defers to fn.
  transaction(fn) {
    return (...args) => fn(...args);
  }

  close() {}

  _insert(values) {
    const row = { id: this.nextId++ };
    COLUMNS.forEach((col, i) => { row[col] = values[i] ?? null; });
    this.rows.push(row);
    return { changes: 1, lastInsertRowid: row.id };
  }

  _update(values) {
    const [txHash, status, confirmedAt, gasUsed, gasPrice, metadata, id] = values;
    const row = this.rows.find((r) => r.id === id);
    if (!row) return { changes: 0 };
    if (txHash !== null && txHash !== undefined) row.tx_hash = txHash;
    if (status !== null && status !== undefined) row.status = status;
    if (confirmedAt !== null && confirmedAt !== undefined) row.confirmed_at = confirmedAt;
    if (gasUsed !== null && gasUsed !== undefined) row.gas_used = gasUsed;
    if (gasPrice !== null && gasPrice !== undefined) row.gas_price = gasPrice;
    if (metadata !== null && metadata !== undefined) row.metadata = metadata;
    return { changes: 1 };
  }
}

module.exports = FakeBetterSqlite3PaymentsDatabase;
