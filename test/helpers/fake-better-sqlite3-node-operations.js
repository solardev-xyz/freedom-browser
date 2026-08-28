'use strict';

const databases = new Map();
const normalize = (sql) => sql.replace(/\s+/g, ' ').trim();
const clone = (row) => (row ? { ...row } : row);

class FakeBetterSqlite3NodeOperationsDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    const existing = databases.get(filePath);
    if (existing) {
      this.state = existing;
    } else {
      this.state = { operations: [], userVersion: 0 };
      databases.set(filePath, this.state);
    }
  }

  pragma(statement, options = {}) {
    if (statement === 'journal_mode = WAL') return 'wal';
    if (statement === 'user_version' && options.simple) return this.state.userVersion;
    const version = /^user_version = (\d+)$/.exec(statement);
    if (version) {
      this.state.userVersion = Number(version[1]);
      return this.state.userVersion;
    }
    return null;
  }

  exec() {}

  close() {}

  prepare(sql) {
    const query = normalize(sql);
    if (query.startsWith('INSERT INTO agent_node_operations')) {
      return {
        run: (
          id,
          ownerId,
          state,
          service,
          transport,
          effect,
          method,
          path,
          headerNamesJson,
          bodySha256,
          createdAt,
          updatedAt
        ) => {
          this.state.operations.push({
            id,
            owner_id: ownerId,
            state,
            service,
            transport,
            effect,
            method,
            path,
            header_names_json: headerNamesJson,
            body_sha256: bodySha256,
            response_status: null,
            response_status_text: null,
            response_headers_json: null,
            response_body: null,
            response_bytes: null,
            error_code: null,
            error_message: null,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { changes: 1 };
        },
      };
    }
    if (query.startsWith('UPDATE agent_node_operations SET state = ?, error_code = NULL')) {
      return {
        run: (state, updatedAt, id) => this.#update(id, {
          state,
          error_code: null,
          error_message: null,
          updated_at: updatedAt,
        }),
      };
    }
    if (query.startsWith('UPDATE agent_node_operations SET state = ?, response_status = ?')) {
      return {
        run: (
          state,
          status,
          statusText,
          headersJson,
          body,
          bytes,
          updatedAt,
          id
        ) => this.#update(id, {
          state,
          response_status: status,
          response_status_text: statusText,
          response_headers_json: headersJson,
          response_body: body,
          response_bytes: bytes,
          error_code: null,
          error_message: null,
          updated_at: updatedAt,
        }),
      };
    }
    if (
      query.startsWith('UPDATE agent_node_operations SET state = ?, error_code = ?, error_message = ?') &&
      query.endsWith('WHERE id = ?')
    ) {
      return {
        run: (state, errorCode, errorMessage, updatedAt, id) => this.#update(id, {
          state,
          error_code: errorCode,
          error_message: errorMessage,
          updated_at: updatedAt,
        }),
      };
    }
    if (query === 'SELECT * FROM agent_node_operations WHERE id = ? AND owner_id = ?') {
      return {
        get: (id, ownerId) =>
          clone(this.state.operations.find((row) => row.id === id && row.owner_id === ownerId)),
      };
    }
    if (query === 'SELECT * FROM agent_node_operations WHERE id = ?') {
      return { get: (id) => clone(this.state.operations.find((row) => row.id === id)) };
    }
    if (query.startsWith('SELECT * FROM agent_node_operations WHERE owner_id = ?')) {
      return {
        all: (ownerId, limit) =>
          this.state.operations
            .filter((row) => row.owner_id === ownerId)
            .sort((first, second) => second.updated_at - first.updated_at)
            .slice(0, limit)
            .map(clone),
      };
    }
    if (
      query.startsWith('UPDATE agent_node_operations SET state = ?, error_code = ?, error_message = ?') &&
      query.endsWith('WHERE state = ?')
    ) {
      return {
        run: (state, errorCode, errorMessage, updatedAt, priorState) => {
          let changes = 0;
          for (const row of this.state.operations) {
            if (row.state !== priorState) continue;
            Object.assign(row, {
              state,
              error_code: errorCode,
              error_message: errorMessage,
              updated_at: updatedAt,
            });
            changes++;
          }
          return { changes };
        },
      };
    }
    if (query.startsWith('DELETE FROM agent_node_operations WHERE id IN')) {
      return { run: () => ({ changes: 0 }) };
    }
    throw new Error(`Unsupported SQL in fake-better-sqlite3-node-operations: ${query}`);
  }

  #update(id, changes) {
    const row = this.state.operations.find((candidate) => candidate.id === id);
    if (!row) return { changes: 0 };
    Object.assign(row, changes);
    return { changes: 1 };
  }

  static reset() {
    databases.clear();
  }
}

module.exports = FakeBetterSqlite3NodeOperationsDatabase;
