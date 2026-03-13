function cloneRow(row) {
  return row ? { ...row } : row;
}

function matchesLike(value, pattern) {
  const normalizedValue = String(value || '').toLowerCase();
  const normalizedPattern = String(pattern || '')
    .toLowerCase()
    .replace(/%/g, '');

  return normalizedValue.includes(normalizedPattern);
}

class FakeBetterSqlite3Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.rows = [];
    this.nextId = 1;
    this.userVersion = 0;
  }

  pragma(statement, options = {}) {
    if (statement === 'journal_mode = WAL') {
      return 'wal';
    }

    if (statement === 'user_version' && options.simple) {
      return this.userVersion;
    }

    if (statement === 'user_version = 1') {
      this.userVersion = 1;
      return this.userVersion;
    }

    return null;
  }

  exec() {}

  prepare(sql) {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();

    if (normalizedSql.startsWith('INSERT INTO history')) {
      return {
        run: (url, title, timestamp, protocol) => {
          const existing = this.rows.find((row) => row.url === url);
          if (existing) {
            existing.title = title;
            existing.timestamp = timestamp;
            existing.visit_count += 1;
            existing.protocol = protocol;

            return {
              changes: 1,
              lastInsertRowid: existing.id,
            };
          }

          const row = {
            id: this.nextId++,
            url,
            title,
            timestamp,
            visit_count: 1,
            protocol,
          };
          this.rows.push(row);

          return {
            changes: 1,
            lastInsertRowid: row.id,
          };
        },
      };
    }

    if (normalizedSql === 'SELECT * FROM history ORDER BY timestamp DESC LIMIT ?') {
      return {
        all: (limit) => this.getSortedRows().slice(0, limit).map(cloneRow),
      };
    }

    if (normalizedSql === 'SELECT * FROM history ORDER BY timestamp DESC') {
      return {
        all: () => this.getSortedRows().map(cloneRow),
      };
    }

    if (
      normalizedSql === 'SELECT * FROM history WHERE url LIKE ? OR title LIKE ? ORDER BY timestamp DESC LIMIT ?'
    ) {
      return {
        all: (urlPattern, titlePattern, limit) =>
          this.getSortedRows()
            .filter(
              (row) => matchesLike(row.url, urlPattern) || matchesLike(row.title, titlePattern)
            )
            .slice(0, limit)
            .map(cloneRow),
      };
    }

    if (normalizedSql === 'SELECT * FROM history WHERE id = ?') {
      return {
        get: (id) => cloneRow(this.rows.find((row) => row.id === id) || null),
      };
    }

    if (normalizedSql === 'DELETE FROM history WHERE id = ?') {
      return {
        run: (id) => {
          const initialLength = this.rows.length;
          this.rows = this.rows.filter((row) => row.id !== id);

          return {
            changes: initialLength - this.rows.length,
          };
        },
      };
    }

    if (normalizedSql === 'DELETE FROM history') {
      return {
        run: () => {
          const changes = this.rows.length;
          this.rows = [];

          return { changes };
        },
      };
    }

    if (normalizedSql === 'SELECT COUNT(*) as count FROM history') {
      return {
        get: () => ({ count: this.rows.length }),
      };
    }

    throw new Error(`Unsupported SQL in fake better-sqlite3: ${normalizedSql}`);
  }

  close() {}

  getSortedRows() {
    return [...this.rows].sort((first, second) => second.timestamp - first.timestamp);
  }
}

module.exports = FakeBetterSqlite3Database;
