'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const log = require('../logger');
const { normalizeAgentApprovalMode } = require('../../shared/agent-approval-modes');
const { originScopeForUrl } = require('../automation/origin-scoped-controller');
const {
  normalizeArtifact,
  normalizeAttachmentReceipt,
  normalizeNodeLifecycleReceipt,
  normalizeNodeRequestReceipt,
  normalizePublicationReceipt,
  normalizeUpload,
  normalizeWalletReceipt,
  normalizeWorkspaceReceipt,
} = require('./agent-progress');

const DB_FILE = 'agent-history.sqlite';
const SCHEMA_VERSION = 4;
const MAX_TITLE_LENGTH = 120;
const MAX_MODEL_FIELD_LENGTH = 240;
const SESSION_STATUSES = new Set(['running', 'ready', 'interrupted', 'failed', 'cancelled']);
const TURN_STATUSES = new Set(['running', 'completed', 'interrupted', 'failed', 'cancelled']);
const GUIDANCE_STATUSES = new Set(['queued', 'applying', 'applied', 'cancelled']);
const ACTIVITY_EFFECTS = new Set(['observed', 'changed', 'managed']);
const ACTIVITY_APPROVALS = new Set(['requested', 'approved', 'declined', 'withdrawn']);

function requiredString(value, label, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new TypeError(`${label} cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(value, maxLength) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new TypeError('Optional session metadata must be a string');
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    throw new TypeError(`Session metadata cannot exceed ${maxLength} characters`);
  }
  return normalized;
}

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeActivity(activity) {
  if (!Array.isArray(activity)) return [];
  return activity
    .filter((item) => item && typeof item === 'object')
    .slice(0, 2_000)
    .map((item) => {
      const label = optionalString(item.label, 240);
      const intent = optionalString(item.intent, 240);
      const origin = originScopeForUrl(optionalString(item.origin, 512));
      const destinationOrigin = originScopeForUrl(optionalString(item.destinationOrigin, 512));
      const pageId = optionalString(item.pageId, 160);
      const artifact = normalizeArtifact(item.artifact);
      const upload = normalizeUpload(item.upload);
      const wallet = normalizeWalletReceipt(item.wallet);
      const nodeLifecycle = normalizeNodeLifecycleReceipt(item.nodeLifecycle);
      const nodeRequest = normalizeNodeRequestReceipt(item.nodeRequest);
      const attachment = normalizeAttachmentReceipt(item.attachment, item.operation);
      const publication = normalizePublicationReceipt(item.publication);
      const workspace = normalizeWorkspaceReceipt(item.workspace);
      const artifacts = Array.isArray(item.artifacts)
        ? item.artifacts.map(normalizeArtifact).filter(Boolean).slice(0, 100)
        : [];
      return {
        toolCallId: optionalString(item.toolCallId, 160) || '',
        operation: optionalString(item.operation, 120) || '',
        status: ['running', 'succeeded', 'failed'].includes(item.status) ? item.status : 'failed',
        ...(label && { label }),
        ...(intent && { intent }),
        ...(ACTIVITY_EFFECTS.has(item.effect) && { effect: item.effect }),
        ...(ACTIVITY_APPROVALS.has(item.approval) && { approval: item.approval }),
        ...(origin && { origin }),
        ...(destinationOrigin && { destinationOrigin }),
        ...(pageId && { pageId }),
        ...(artifact && { artifact }),
        ...(upload && { upload }),
        ...(wallet && { wallet }),
        ...(nodeLifecycle && { nodeLifecycle }),
        ...(nodeRequest && { nodeRequest }),
        ...(attachment && { attachment }),
        ...(publication && { publication }),
        ...(workspace && { workspace }),
        ...(artifacts.length && { artifacts }),
        ...(Number.isSafeInteger(item.pageCount) && item.pageCount >= 0
          ? { pageCount: item.pageCount }
          : {}),
        ...(typeof item.errorCode === 'string' && item.errorCode.length <= 120
          ? { errorCode: item.errorCode }
          : {}),
      };
    });
}

function normalizeGuidance(guidance) {
  if (!Array.isArray(guidance)) return [];
  return guidance
    .filter((item) => item && typeof item === 'object')
    .slice(0, 1_000)
    .map((item) => ({
      guidanceId: optionalString(item.guidanceId, 160) || '',
      text: optionalString(item.text, 32_000) || '',
      status: GUIDANCE_STATUSES.has(item.status) ? item.status : 'cancelled',
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : 0,
    }))
    .filter((item) => item.guidanceId && item.text);
}

function normalizeAttachments(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((item) => item && typeof item === 'object')
    .slice(0, 10)
    .map((item) => {
      const kind = item.kind === 'folder' ? 'folder' : item.kind === 'file' ? 'file' : null;
      const resourceId = optionalString(item.resourceId, 160);
      const name = optionalString(item.name, 240);
      if (!kind || !resourceId || !name) return null;
      return {
        resourceId,
        kind,
        name,
        ...(Number.isSafeInteger(item.bytes) && item.bytes >= 0 ? { bytes: item.bytes } : {}),
        ...(typeof item.mimeType === 'string' && item.mimeType.length <= 160
          ? { mimeType: item.mimeType }
          : {}),
        ...(typeof item.category === 'string' && item.category.length <= 40
          ? { category: item.category }
          : {}),
        available: item.available !== false,
      };
    })
    .filter(Boolean);
}

function rowToSession(row) {
  if (!row) return null;
  return {
    conversationId: row.id,
    title: row.title,
    approvalMode: row.approval_mode,
    providerId: row.provider_id,
    modelId: row.model_id,
    thinkingLevel: row.thinking_level,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    turnCount: row.turn_count || 0,
  };
}

function rowToTurn(row) {
  if (!row) return null;
  const error = row.error_code
    ? { code: row.error_code, message: row.error_message || 'The agent turn failed' }
    : null;
  const guidance = normalizeGuidance(safeJsonParse(row.guidance_json, [])).map((item) =>
    row.status === 'interrupted' && (item.status === 'queued' || item.status === 'applying')
      ? { ...item, status: 'cancelled' }
      : item
  );
  return {
    runId: row.id,
    userText: row.user_text,
    assistantText: row.assistant_text || '',
    status: row.status,
    approvalMode: normalizeAgentApprovalMode(row.approval_mode) || 'every_interaction',
    startedAt: row.started_at,
    ...(Number.isFinite(row.duration_ms) && { durationMs: row.duration_ms }),
    activity: normalizeActivity(safeJsonParse(row.activity_json, [])),
    attachments: normalizeAttachments(safeJsonParse(row.attachments_json, [])),
    guidance,
    ...(error && { error }),
  };
}

class AgentSessionHistoryStore {
  constructor(options = {}) {
    this.userDataDir = requiredString(options.userDataDir, 'Agent history userDataDir', 4_096);
    this.Database = options.Database || Database;
    this.now = options.now || Date.now;
    this.db = null;
    this.statements = null;
  }

  getDb() {
    if (this.db) return this.db;
    const dbPath = path.join(this.userDataDir, DB_FILE);
    log.info('[AgentHistory] Opening database:', dbPath);
    this.db = new this.Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.#migrate();
    return this.db;
  }

  close() {
    if (!this.db) return;
    log.info('[AgentHistory] Closing database');
    this.db.close();
    this.db = null;
    this.statements = null;
  }

  #migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_sessions (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          approval_mode TEXT NOT NULL,
          provider_id TEXT,
          model_id TEXT,
          thinking_level TEXT,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_sessions_updated
          ON agent_sessions(updated_at DESC);

        CREATE TABLE IF NOT EXISTS agent_turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
          position INTEGER NOT NULL,
          user_text TEXT NOT NULL,
          assistant_text TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          duration_ms INTEGER,
          activity_json TEXT NOT NULL DEFAULT '[]',
          error_code TEXT,
          error_message TEXT,
          UNIQUE(session_id, position)
        );
        CREATE INDEX IF NOT EXISTS idx_agent_turns_session_position
          ON agent_turns(session_id, position ASC);
      `);
      this.db.pragma('user_version = 1');
    }
    if (version < 2) {
      this.db.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN guidance_json TEXT NOT NULL DEFAULT '[]';
      `);
      this.db.pragma('user_version = 2');
    }
    if (version < 3) {
      this.db.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
      `);
      this.db.pragma('user_version = 3');
    }
    if (version < 4) {
      this.db.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'every_interaction';
        UPDATE agent_turns
          SET approval_mode = COALESCE(
            (SELECT approval_mode FROM agent_sessions
              WHERE agent_sessions.id = agent_turns.session_id),
            'every_interaction'
          );
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  #getStatements() {
    if (this.statements) return this.statements;
    const db = this.getDb();
    this.statements = {
      insertSession: db.prepare(`
        INSERT INTO agent_sessions (
          id, title, approval_mode, provider_id, model_id, thinking_level,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      insertTurn: db.prepare(`
        INSERT INTO agent_turns (
          id, session_id, position, user_text, assistant_text, status,
          started_at, duration_ms, activity_json, attachments_json, approval_mode,
          error_code, error_message
        ) VALUES (?, ?, ?, ?, '', 'running', ?, NULL, '[]', ?, ?, NULL, NULL)
      `),
      finishTurn: db.prepare(`
        UPDATE agent_turns SET
          assistant_text = ?, status = ?, duration_ms = ?, activity_json = ?,
          guidance_json = ?, error_code = ?, error_message = ?
        WHERE id = ? AND session_id = ?
      `),
      updateTurnGuidance: db.prepare(`
        UPDATE agent_turns SET guidance_json = ?
        WHERE id = ? AND session_id = ?
      `),
      updateTurnActivity: db.prepare(`
        UPDATE agent_turns SET activity_json = ?
        WHERE id = ? AND session_id = ? AND status != 'running'
      `),
      touchSessionTime: db.prepare(`
        UPDATE agent_sessions SET updated_at = ? WHERE id = ?
      `),
      touchSession: db.prepare(`
        UPDATE agent_sessions SET status = ?, updated_at = ? WHERE id = ?
      `),
      updateSessionApprovalMode: db.prepare(`
        UPDATE agent_sessions SET approval_mode = ?, updated_at = ? WHERE id = ?
      `),
      listSessions: db.prepare(`
        SELECT s.*, COUNT(t.id) AS turn_count
        FROM agent_sessions s
        LEFT JOIN agent_turns t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
      `),
      getSession: db.prepare(`
        SELECT s.*, COUNT(t.id) AS turn_count
        FROM agent_sessions s
        LEFT JOIN agent_turns t ON t.session_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `),
      getTurns: db.prepare(`
        SELECT * FROM agent_turns WHERE session_id = ? ORDER BY position ASC
      `),
      renameSession: db.prepare(`
        UPDATE agent_sessions SET title = ?, updated_at = ? WHERE id = ?
      `),
      deleteTurns: db.prepare(`DELETE FROM agent_turns WHERE session_id = ?`),
      deleteSession: db.prepare(`DELETE FROM agent_sessions WHERE id = ?`),
      interruptTurns: db.prepare(`
        UPDATE agent_turns SET status = 'interrupted', error_code = NULL,
          error_message = NULL
        WHERE status = 'running'
      `),
      interruptSessions: db.prepare(`
        UPDATE agent_sessions SET status = 'interrupted', updated_at = ?
        WHERE status = 'running'
      `),
    };
    return this.statements;
  }

  createSession(entry) {
    const id = requiredString(entry?.conversationId, 'Agent conversation ID', 160);
    const title = requiredString(entry?.title, 'Agent session title', MAX_TITLE_LENGTH);
    const approvalMode = normalizeAgentApprovalMode(entry?.approvalMode);
    if (!approvalMode) throw new TypeError('Agent session requires a supported approval mode');
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : this.now();
    this.#getStatements().insertSession.run(
      id,
      title,
      approvalMode,
      optionalString(entry.providerId, MAX_MODEL_FIELD_LENGTH),
      optionalString(entry.modelId, MAX_MODEL_FIELD_LENGTH),
      optionalString(entry.thinkingLevel, 80),
      'running',
      createdAt,
      createdAt
    );
    return this.getSession(id);
  }

  startTurn(entry) {
    const sessionId = requiredString(entry?.conversationId, 'Agent conversation ID', 160);
    const runId = requiredString(entry?.runId, 'Agent run ID', 160);
    const userText = requiredString(entry?.userText, 'Agent turn text', 32_000);
    const startedAt = Number.isFinite(entry.startedAt) ? entry.startedAt : this.now();
    const position =
      Number.isSafeInteger(entry.position) && entry.position >= 0
        ? entry.position
        : this.#getStatements().getTurns.all(sessionId).length;
    const attachments = normalizeAttachments(entry?.attachments);
    const approvalMode = normalizeAgentApprovalMode(entry?.approvalMode);
    if (!approvalMode) throw new TypeError('Agent turn requires a supported approval mode');
    this.#getStatements().insertTurn.run(
      runId,
      sessionId,
      position,
      userText,
      startedAt,
      JSON.stringify(attachments),
      approvalMode
    );
    this.#getStatements().touchSession.run('running', startedAt, sessionId);
  }

  finishTurn(entry) {
    const sessionId = requiredString(entry?.conversationId, 'Agent conversation ID', 160);
    const runId = requiredString(entry?.runId, 'Agent run ID', 160);
    const status = TURN_STATUSES.has(entry?.status) ? entry.status : 'failed';
    const assistantText = typeof entry?.assistantText === 'string' ? entry.assistantText : '';
    const durationMs = Number.isFinite(entry?.durationMs) ? Math.max(0, entry.durationMs) : null;
    const activity = normalizeActivity(entry?.activity);
    const guidance = normalizeGuidance(entry?.guidance);
    const errorCode = optionalString(entry?.error?.code, 120);
    const errorMessage = optionalString(entry?.error?.message, 512);
    const result = this.#getStatements().finishTurn.run(
      assistantText,
      status,
      durationMs,
      JSON.stringify(activity),
      JSON.stringify(guidance),
      errorCode,
      errorMessage,
      runId,
      sessionId
    );
    if (result.changes > 0) {
      const sessionStatus = SESSION_STATUSES.has(status) ? status : 'ready';
      this.#getStatements().touchSession.run(
        status === 'completed' ? 'ready' : sessionStatus,
        this.now(),
        sessionId
      );
    }
    return result.changes > 0;
  }

  updateTurnGuidance(entry) {
    const sessionId = requiredString(entry?.conversationId, 'Agent conversation ID', 160);
    const runId = requiredString(entry?.runId, 'Agent run ID', 160);
    const guidance = normalizeGuidance(entry?.guidance);
    const result = this.#getStatements().updateTurnGuidance.run(
      JSON.stringify(guidance),
      runId,
      sessionId
    );
    if (result.changes > 0) {
      this.#getStatements().touchSession.run('running', this.now(), sessionId);
    }
    return result.changes > 0;
  }

  updateTurnActivity(entry) {
    const sessionId = requiredString(entry?.conversationId, 'Agent conversation ID', 160);
    const runId = requiredString(entry?.runId, 'Agent run ID', 160);
    const activity = normalizeActivity(entry?.activity);
    const result = this.#getStatements().updateTurnActivity.run(
      JSON.stringify(activity),
      runId,
      sessionId
    );
    if (result.changes > 0) {
      this.#getStatements().touchSessionTime.run(this.now(), sessionId);
    }
    return result.changes > 0;
  }

  updateApprovalMode(conversationId, value) {
    const id = requiredString(conversationId, 'Agent conversation ID', 160);
    const approvalMode = normalizeAgentApprovalMode(value);
    if (typeof value !== 'string' || !approvalMode) {
      throw new TypeError('Agent session requires a supported approval mode');
    }
    const result = this.#getStatements().updateSessionApprovalMode.run(
      approvalMode,
      this.now(),
      id
    );
    return result.changes > 0 ? this.getSession(id) : null;
  }

  listSessions() {
    return this.#getStatements().listSessions.all().map(rowToSession);
  }

  getSession(conversationId) {
    const id = requiredString(conversationId, 'Agent conversation ID', 160);
    const session = rowToSession(this.#getStatements().getSession.get(id));
    if (!session) return null;
    return {
      ...session,
      transcript: this.#getStatements().getTurns.all(id).map(rowToTurn),
    };
  }

  renameSession(conversationId, title) {
    const id = requiredString(conversationId, 'Agent conversation ID', 160);
    const normalizedTitle = requiredString(title, 'Agent session title', MAX_TITLE_LENGTH);
    const result = this.#getStatements().renameSession.run(normalizedTitle, this.now(), id);
    return result.changes > 0 ? this.getSession(id) : null;
  }

  deleteSession(conversationId) {
    const id = requiredString(conversationId, 'Agent conversation ID', 160);
    const statements = this.#getStatements();
    const remove = this.getDb().transaction((sessionId) => {
      statements.deleteTurns.run(sessionId);
      return statements.deleteSession.run(sessionId).changes > 0;
    });
    return remove(id);
  }

  markStaleRunningAsInterrupted() {
    const statements = this.#getStatements();
    const interruptedAt = this.now();
    const sweep = this.getDb().transaction(() => {
      const turns = statements.interruptTurns.run().changes;
      const sessions = statements.interruptSessions.run(interruptedAt).changes;
      return { sessions, turns };
    });
    return sweep();
  }
}

module.exports = {
  AgentSessionHistoryStore,
  DB_FILE,
  MAX_TITLE_LENGTH,
  SCHEMA_VERSION,
  normalizeActivity,
  normalizeAttachments,
  normalizeGuidance,
  rowToSession,
  rowToTurn,
};
