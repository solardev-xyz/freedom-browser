'use strict';

const databases = new Map();
const normalize = (sql) => sql.replace(/\s+/g, ' ').trim();
const clone = (row) => (row ? { ...row } : row);

class FakeBetterSqlite3WorkspacesDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.name = filePath;
    const existing = databases.get(filePath);
    if (existing) {
      this.state = existing;
    } else {
      this.state = { workspaces: [], commands: [], userVersion: 0 };
      databases.set(filePath, this.state);
    }
  }

  pragma(statement, options = {}) {
    if (statement === 'journal_mode = WAL') return 'wal';
    if (statement === 'foreign_keys = ON') return null;
    if (statement === 'user_version' && options.simple) return this.state.userVersion;
    const version = /^user_version = (\d+)$/.exec(statement);
    if (version) this.state.userVersion = Number(version[1]);
    return null;
  }

  exec() {}

  close() {}

  prepare(sql) {
    const query = normalize(sql);
    if (query.startsWith('INSERT INTO agent_workspaces')) {
      return {
        run: (id, conversationId, createdAt, updatedAt) => {
          this.state.workspaces.push({
            id,
            conversation_id: conversationId,
            enabled: 0,
            backend: null,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { changes: 1 };
        },
      };
    }
    if (query === 'SELECT * FROM agent_workspaces WHERE id = ?') {
      return { get: (id) => clone(this.state.workspaces.find((row) => row.id === id)) };
    }
    if (query === 'SELECT * FROM agent_workspaces WHERE conversation_id = ?') {
      return {
        get: (conversationId) =>
          clone(this.state.workspaces.find((row) => row.conversation_id === conversationId)),
      };
    }
    if (query.startsWith('UPDATE agent_workspaces SET enabled = 1')) {
      return {
        run: (backend, updatedAt, id, conversationId) => {
          const row = this.state.workspaces.find(
            (candidate) => candidate.id === id && candidate.conversation_id === conversationId
          );
          if (!row) return { changes: 0 };
          Object.assign(row, { enabled: 1, backend, updated_at: updatedAt });
          return { changes: 1 };
        },
      };
    }
    if (query.startsWith('INSERT INTO agent_workspace_commands')) {
      return {
        run: (
          id,
          workspaceId,
          conversationId,
          command,
          workingDirectory,
          backend,
          networkPosture,
          startedAt
        ) => {
          this.state.commands.push({
            id,
            workspace_id: workspaceId,
            conversation_id: conversationId,
            command_text: command,
            working_directory: workingDirectory,
            state: 'running',
            backend,
            network_posture: networkPosture,
            started_at: startedAt,
            finished_at: null,
            duration_ms: null,
            exit_code: null,
            signal: null,
            stdout: '',
            stderr: '',
            stdout_truncated: 0,
            stderr_truncated: 0,
            termination_guarantee: null,
            side_effects: null,
            error_code: null,
            error_message: null,
          });
          return { changes: 1 };
        },
      };
    }
    if (query.startsWith('UPDATE agent_workspace_commands SET state = ?, finished_at = ?')) {
      return {
        run: (
          state,
          finishedAt,
          durationMs,
          exitCode,
          signal,
          stdout,
          stderr,
          stdoutTruncated,
          stderrTruncated,
          terminationGuarantee,
          sideEffects,
          networkPosture,
          errorCode,
          errorMessage,
          id,
          workspaceId
        ) => {
          const row = this.state.commands.find(
            (candidate) => candidate.id === id && candidate.workspace_id === workspaceId
          );
          if (!row) return { changes: 0 };
          Object.assign(row, {
            state,
            finished_at: finishedAt,
            duration_ms: durationMs,
            exit_code: exitCode,
            signal,
            stdout,
            stderr,
            stdout_truncated: stdoutTruncated,
            stderr_truncated: stderrTruncated,
            termination_guarantee: terminationGuarantee,
            side_effects: sideEffects,
            network_posture: networkPosture,
            error_code: errorCode,
            error_message: errorMessage,
          });
          return { changes: 1 };
        },
      };
    }
    if (query.startsWith('SELECT * FROM agent_workspace_commands WHERE conversation_id = ?')) {
      return {
        all: (conversationId, limit) =>
          this.state.commands
            .filter((row) => row.conversation_id === conversationId)
            .sort((first, second) => second.started_at - first.started_at)
            .slice(0, limit)
            .map(clone),
      };
    }
    if (query.startsWith("UPDATE agent_workspace_commands SET state = 'interrupted'")) {
      return {
        run: (finishedAt, durationAt) => {
          let changes = 0;
          for (const row of this.state.commands) {
            if (row.state !== 'running') continue;
            Object.assign(row, {
              state: 'interrupted',
              finished_at: finishedAt,
              duration_ms: Math.max(0, durationAt - row.started_at),
              termination_guarantee: row.termination_guarantee || 'unknown',
              side_effects: 'unknown',
              error_code: 'WORKSPACE_EXECUTION_INTERRUPTED',
              error_message: 'Freedom restarted before the command receipt was recorded',
            });
            changes += 1;
          }
          return { changes };
        },
      };
    }
    if (query.startsWith('DELETE FROM agent_workspace_commands WHERE id IN')) {
      return { run: () => ({ changes: 0 }) };
    }
    if (query === 'DELETE FROM agent_workspaces WHERE id = ? AND conversation_id = ?') {
      return {
        run: (id, conversationId) => {
          const index = this.state.workspaces.findIndex(
            (row) => row.id === id && row.conversation_id === conversationId
          );
          if (index < 0) return { changes: 0 };
          this.state.workspaces.splice(index, 1);
          this.state.commands = this.state.commands.filter((row) => row.workspace_id !== id);
          return { changes: 1 };
        },
      };
    }
    throw new Error(`Unsupported SQL in fake-better-sqlite3-workspaces: ${query}`);
  }

  static reset() {
    databases.clear();
  }
}

module.exports = FakeBetterSqlite3WorkspacesDatabase;
