'use strict';

const databases = new Map();
const normalize = (sql) => sql.replace(/\s+/g, ' ').trim();
const clone = (row) => (row ? { ...row } : row);

class FakeBetterSqlite3AgentHistoryDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    const existing = databases.get(filePath);
    if (existing) {
      this.state = existing;
    } else {
      this.state = { sessions: [], turns: [], reports: [], userVersion: 0 };
      databases.set(filePath, this.state);
    }
  }

  pragma(statement, options = {}) {
    if (statement === 'journal_mode = WAL') return 'wal';
    if (statement === 'foreign_keys = ON') return 1;
    if (statement === 'user_version' && options.simple) return this.state.userVersion;
    const version = /^user_version = (\d+)$/.exec(statement);
    if (version) {
      this.state.userVersion = Number(version[1]);
      return this.state.userVersion;
    }
    return null;
  }

  exec() {}

  transaction(fn) {
    return (...args) => fn(...args);
  }

  close() {}

  prepare(sql) {
    const query = normalize(sql);

    if (query === 'SELECT id, session_id, activity_json, started_at FROM agent_turns WHERE id > ? ORDER BY id ASC LIMIT 100') {
      return { all: cursor => this.state.turns.filter(row => row.id > cursor)
        .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).slice(0, 100).map(clone) };
    }
    if (query === 'SELECT id FROM agent_turns WHERE id = ? AND session_id = ?') {
      return { get: (id, sessionId) => clone(this.state.turns.find(row => row.id === id && row.session_id === sessionId)) };
    }
    if (query === 'UPDATE agent_turns SET activity_json = ? WHERE id = ? AND session_id = ?') {
      return { run: (json, id, sessionId) => {
        const row = this.state.turns.find(row => row.id === id && row.session_id === sessionId);
        if (row) row.activity_json = json;
        return { changes: row ? 1 : 0 };
      } };
    }
    if (query.startsWith('INSERT OR IGNORE INTO agent_helper_reports')) {
      return { run: (id, session_id, run_id, task_id, title, state, report, report_chars, truncated, created_at) => {
        if (this.state.reports.some(row => row.id === id)) return { changes: 0 };
        this.state.reports.push({ id, session_id, run_id, task_id, title, state, report, report_chars, truncated, created_at });
        return { changes: 1 };
      } };
    }
    if (query.startsWith('SELECT id, run_id, task_id, title, state, report_chars')) {
      return { all: (id, query, _query, limit, offset) => this.state.reports.filter(row => row.session_id === id &&
        (row.title.toLowerCase().includes(query.toLowerCase()) || row.report.toLowerCase().includes(query.toLowerCase())))
        .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)).slice(offset, offset + limit).map(clone) };
    }
    if (query.startsWith('SELECT substr(report,')) {
      return { get: (start, limit, sessionId, id) => {
        const row = this.state.reports.find(row => row.id === id && row.session_id === sessionId);
        return row && { text: Array.from(row.report).slice(start - 1, start - 1 + limit).join(''), report_chars: row.report_chars, truncated: row.truncated };
      } };
    }

    if (query.startsWith('INSERT INTO agent_sessions')) {
      return {
        run: (
          id,
          title,
          approvalMode,
          providerId,
          modelId,
          thinkingLevel,
          status,
          createdAt,
          updatedAt
        ) => {
          if (this.state.sessions.some((row) => row.id === id)) throw new Error('UNIQUE session');
          this.state.sessions.push({
            id,
            title,
            approval_mode: approvalMode,
            provider_id: providerId,
            model_id: modelId,
            thinking_level: thinkingLevel,
            status,
            created_at: createdAt,
            updated_at: updatedAt,
          });
          return { changes: 1 };
        },
      };
    }

    if (query.startsWith('INSERT INTO agent_turns')) {
      return {
        run: (id, sessionId, position, userText, startedAt, attachmentsJson, approvalMode) => {
          if (this.state.turns.some((row) => row.id === id)) throw new Error('UNIQUE turn');
          this.state.turns.push({
            id,
            session_id: sessionId,
            position,
            user_text: userText,
            assistant_text: '',
            status: 'running',
            started_at: startedAt,
            duration_ms: null,
            activity_json: '[]',
            guidance_json: '[]',
            attachments_json: attachmentsJson || '[]',
            approval_mode: approvalMode || 'every_interaction',
            error_code: null,
            error_message: null,
          });
          return { changes: 1 };
        },
      };
    }

    if (query.startsWith('UPDATE agent_turns SET assistant_text = ?')) {
      return {
        run: (
          assistantText,
          status,
          durationMs,
          activityJson,
          guidanceJson,
          errorCode,
          errorMessage,
          id,
          sessionId
        ) => {
          const row = this.state.turns.find(
            (candidate) => candidate.id === id && candidate.session_id === sessionId
          );
          if (!row) return { changes: 0 };
          Object.assign(row, {
            assistant_text: assistantText,
            status,
            duration_ms: durationMs,
            activity_json: activityJson,
            guidance_json: guidanceJson,
            error_code: errorCode,
            error_message: errorMessage,
          });
          return { changes: 1 };
        },
      };
    }

    if (query === 'UPDATE agent_turns SET guidance_json = ? WHERE id = ? AND session_id = ?') {
      return {
        run: (guidanceJson, id, sessionId) => {
          const row = this.state.turns.find(
            (candidate) => candidate.id === id && candidate.session_id === sessionId
          );
          if (!row) return { changes: 0 };
          row.guidance_json = guidanceJson;
          return { changes: 1 };
        },
      };
    }

    if (
      query ===
      "UPDATE agent_turns SET activity_json = ? WHERE id = ? AND session_id = ? AND status != 'running'" ||
      query === "UPDATE agent_turns SET activity_json = ? WHERE id = ? AND session_id = ? AND status = 'running'"
    ) {
      return {
        run: (activityJson, id, sessionId) => {
          const row = this.state.turns.find(
            (candidate) =>
              candidate.id === id &&
              candidate.session_id === sessionId &&
              (query.includes("status !=") ? candidate.status !== 'running' : candidate.status === 'running')
          );
          if (!row) return { changes: 0 };
          row.activity_json = activityJson;
          return { changes: 1 };
        },
      };
    }

    if (query === 'UPDATE agent_sessions SET privacy_json = ? WHERE id = ?') {
      return { run: (privacyJson, id) => {
        const row = this.state.sessions.find(row => row.id === id);
        if (!row) return { changes: 0 };
        row.privacy_json = privacyJson;
        return { changes: 1 };
      } };
    }
    if (query === 'UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?') {
      return {
        run: (status, updatedAt, id) => {
          const row = this.state.sessions.find((candidate) => candidate.id === id);
          if (!row) return { changes: 0 };
          row.status = status;
          row.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (query === 'UPDATE agent_sessions SET updated_at = ? WHERE id = ?') {
      return {
        run: (updatedAt, id) => {
          const row = this.state.sessions.find((candidate) => candidate.id === id);
          if (!row) return { changes: 0 };
          row.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (query === 'UPDATE agent_sessions SET approval_mode = ?, updated_at = ? WHERE id = ?') {
      return {
        run: (approvalMode, updatedAt, id) => {
          const row = this.state.sessions.find((candidate) => candidate.id === id);
          if (!row) return { changes: 0 };
          row.approval_mode = approvalMode;
          row.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (query.startsWith('SELECT s.*, COUNT(t.id) AS turn_count FROM agent_sessions s LEFT JOIN')) {
      const rows = () =>
        this.state.sessions
          .map((session) => ({
            ...clone(session),
            turn_count: this.state.turns.filter((turn) => turn.session_id === session.id).length,
          }))
          .sort((first, second) => second.updated_at - first.updated_at);
      if (query.includes('WHERE s.id = ?')) {
        return { get: (id) => rows().find((row) => row.id === id) };
      }
      return { all: rows };
    }

    if (query === 'SELECT * FROM agent_turns WHERE session_id = ? ORDER BY position ASC') {
      return {
        all: (sessionId) =>
          this.state.turns
            .filter((row) => row.session_id === sessionId)
            .sort((first, second) => first.position - second.position)
            .map(clone),
      };
    }

    if (query === 'UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?') {
      return {
        run: (title, updatedAt, id) => {
          const row = this.state.sessions.find((candidate) => candidate.id === id);
          if (!row) return { changes: 0 };
          row.title = title;
          row.updated_at = updatedAt;
          return { changes: 1 };
        },
      };
    }

    if (query === 'DELETE FROM agent_turns WHERE session_id = ?') {
      return {
        run: (sessionId) => {
          this.state.reports = this.state.reports.filter(row => row.session_id !== sessionId);
          const before = this.state.turns.length;
          this.state.turns = this.state.turns.filter((row) => row.session_id !== sessionId);
          return { changes: before - this.state.turns.length };
        },
      };
    }

    if (query === 'DELETE FROM agent_sessions WHERE id = ?') {
      return {
        run: (id) => {
          const before = this.state.sessions.length;
          this.state.sessions = this.state.sessions.filter((row) => row.id !== id);
          return { changes: before - this.state.sessions.length };
        },
      };
    }

    if (query.startsWith("UPDATE agent_turns SET status = 'interrupted'")) {
      return {
        run: () => {
          let changes = 0;
          for (const row of this.state.turns) {
            if (row.status !== 'running') continue;
            row.status = 'interrupted';
            row.error_code = null;
            row.error_message = null;
            changes++;
          }
          return { changes };
        },
      };
    }

    if (query.startsWith("UPDATE agent_sessions SET status = 'interrupted'")) {
      return {
        run: (updatedAt) => {
          let changes = 0;
          for (const row of this.state.sessions) {
            if (row.status !== 'running') continue;
            row.status = 'interrupted';
            row.updated_at = updatedAt;
            changes++;
          }
          return { changes };
        },
      };
    }

    throw new Error(`Unsupported SQL in fake-better-sqlite3-agent-history: ${query}`);
  }

  static reset() {
    databases.clear();
  }
}

module.exports = FakeBetterSqlite3AgentHistoryDatabase;
