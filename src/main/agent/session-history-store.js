'use strict';

const { normalizePrivacy } = require('./session-privacy');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const log = require('../logger');
const { normalizeAgentApprovalMode } = require('../../shared/agent-approval-modes');
const { normalizeSubagentReceipt, normalizeSubagentReceipts } = require('./subagent-receipt');
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
const SCHEMA_VERSION = 6;
const MAX_TITLE_LENGTH = 120;
const MAX_MODEL_FIELD_LENGTH = 240;
const SESSION_STATUSES = new Set(['running', 'ready', 'interrupted', 'failed', 'cancelled']);
const TURN_STATUSES = new Set(['running', 'completed', 'interrupted', 'failed', 'cancelled']);
const GUIDANCE_STATUSES = new Set(['queued', 'applying', 'applied', 'cancelled']);
const ACTIVITY_EFFECTS = new Set(['observed', 'changed', 'managed']);
const ACTIVITY_APPROVALS = new Set(['requested', 'approved', 'declined', 'withdrawn', 'reviewer_approved']);
const ACTIVITY_STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled']);
// Saved activity is bounded per class, so one turn cannot grow without limit
// (a codemode loop of failing calls once saved ~25 MB), while a loop of routine
// reads or failures cannot push approvals or effects out of the record.
// Total: at most 8,500 items per turn.
const ACTIVITY_LIMITS = Object.freeze({
  receipt: 4_000,
  consequential: 2_000,
  failed: 500,
  routine: 2_000,
});
const RECEIPT_KEYS = ['wallet', 'publication', 'nodeRequest', 'nodeLifecycle', 'workspace', 'upload'];
const CONSEQUENTIAL_KEYS = ['subagent', 'subagents', 'attachment', 'artifact', 'artifacts'];
const CONSEQUENTIAL_OPERATIONS = new Set(['codemode', 'delegate_task', 'helper_task', 'domain_execute']);
const MAX_NESTED_ERROR_CODES = 5;

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

// receipt: approvals and effect receipts (wallet, publication, node, workspace,
// upload, MCP requests). consequential: other actions with effects even when no
// prompt was shown (clicks, typing, page tools, dialogs), helpers, attachments,
// artifacts, tool scripts, and items that did not finish (running, cancelled).
function activityClass(item) {
  if (ACTIVITY_APPROVALS.has(item.approval) || RECEIPT_KEYS.some(key => item[key]) ||
      item.operation === 'mcp_request') return 'receipt';
  if (CONSEQUENTIAL_KEYS.some(key => item[key]) || item.effect === 'changed' ||
      CONSEQUENTIAL_OPERATIONS.has(item.operation) || item.status === 'running' ||
      item.status === 'cancelled') return 'consequential';
  if (item.status !== 'succeeded') return 'failed';
  return 'routine';
}

// Routine reads and failures keep their latest entries. An over-long receipt or
// consequential class also keeps its start: a run's first effects and its latest
// state are both evidence.
function boundedSelection(items, className) {
  const limit = ACTIVITY_LIMITS[className];
  if (items.length <= limit) return items;
  const head = ['receipt', 'consequential'].includes(className) ? Math.floor(limit / 4) : 0;
  return items.slice(0, head).concat(items.slice(items.length - (limit - head)));
}

function nestedParentId(item) {
  return typeof item.parentToolCallId === 'string' && item.parentToolCallId.length <= 160
    ? item.parentToolCallId : null;
}

// A failing call made by a tool script is folded into the script's own item as a
// count, instead of being saved as one more row per failed nested call.
function foldNestedFailures(items) {
  const parents = new Map(items.filter(item => typeof item.toolCallId === 'string')
    .map(item => [item.toolCallId, item]));
  const folds = new Map();
  const remaining = items.filter(item => {
    const parent = parents.get(nestedParentId(item));
    if (!parent || parent === item || activityClass(item) !== 'failed') return true;
    const fold = folds.get(parent) || { count: 0, errorCodes: new Set() };
    fold.count += 1;
    if (typeof item.errorCode === 'string' && item.errorCode.length <= 120 &&
        fold.errorCodes.size < MAX_NESTED_ERROR_CODES) fold.errorCodes.add(item.errorCode);
    folds.set(parent, fold);
    return false;
  });
  if (!folds.size) return items;
  return remaining.map(item => {
    const fold = folds.get(item);
    if (!fold) return item;
    const previous = Number.isSafeInteger(item.nestedFailures) && item.nestedFailures > 0 ? item.nestedFailures : 0;
    const errorCodes = [...new Set([...(Array.isArray(item.nestedErrorCodes) ? item.nestedErrorCodes : []), ...fold.errorCodes])]
      .filter(code => typeof code === 'string' && code.length <= 120).slice(0, MAX_NESTED_ERROR_CODES);
    return { ...item, nestedFailures: previous + fold.count, ...(errorCodes.length && { nestedErrorCodes: errorCodes }) };
  });
}

// Items are classified after normalization, so saving and reading back a turn
// classifies, folds and bounds it the same way.
function normalizeActivity(activity) {
  if (!Array.isArray(activity)) return [];
  const items = foldNestedFailures(activity.filter((item) => item && typeof item === 'object')
    .map(normalizeActivityItem));
  const classes = { receipt: [], consequential: [], failed: [], routine: [] };
  for (const item of items) classes[activityClass(item)].push(item);
  const retained = new Set(Object.entries(classes)
    .flatMap(([name, members]) => boundedSelection(members, name)));
  return items.filter(item => retained.has(item));
}

function normalizeActivityItem(item) {
  const label = optionalString(item.label, 240);
  const intent = optionalString(item.intent, 240);
  const origin = originScopeForUrl(optionalString(item.origin, 512));
  const pageTitle = optionalString(item.pageTitle, 240);
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
  const subagent = normalizeSubagentReceipt(item.subagent);
  const subagents = normalizeSubagentReceipts(item.subagents);
  const artifacts = Array.isArray(item.artifacts)
    ? item.artifacts.map(normalizeArtifact).filter(Boolean).slice(0, 100)
    : [];
  return {
    toolCallId: optionalString(item.toolCallId, 160) || '',
    ...(Number.isSafeInteger(item.textOffset) && item.textOffset >= 0 && { textOffset: item.textOffset }),
    ...(Number.isSafeInteger(item.timelineOrder) && item.timelineOrder >= 0 && { timelineOrder: item.timelineOrder }),
    operation: optionalString(item.operation, 120) || '',
    ...(nestedParentId(item) && { parentToolCallId: nestedParentId(item) }),
    status: ACTIVITY_STATUSES.has(item.status) ? item.status : 'failed',
    ...(label && { label }),
    ...(intent && { intent }),
    ...(ACTIVITY_EFFECTS.has(item.effect) && { effect: item.effect }),
    ...(ACTIVITY_APPROVALS.has(item.approval) && { approval: item.approval }),
    ...(origin && { origin }),
    ...(pageTitle && { pageTitle }),
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
    ...(subagent && { subagent }),
    ...(subagents && { subagents }),
    ...(artifacts.length && { artifacts }),
    ...(Number.isSafeInteger(item.pageCount) && item.pageCount >= 0
      ? { pageCount: item.pageCount }
      : {}),
    ...(typeof item.errorCode === 'string' && item.errorCode.length <= 120
      ? { errorCode: item.errorCode }
      : {}),
    ...(Number.isSafeInteger(item.nestedFailures) && item.nestedFailures > 0 && {
      nestedFailures: item.nestedFailures,
      ...(Array.isArray(item.nestedErrorCodes) && {
        nestedErrorCodes: item.nestedErrorCodes
          .filter(code => typeof code === 'string' && code.length <= 120)
          .slice(0, MAX_NESTED_ERROR_CODES),
      }),
    }),
  };
}

function normalizeGuidance(guidance) {
  if (!Array.isArray(guidance)) return [];
  return guidance
    .filter((item) => item && typeof item === 'object')
    .slice(0, 1_000)
    .map((item) => ({
      guidanceId: optionalString(item.guidanceId, 160) || '',
      ...(Number.isSafeInteger(item.textOffset) && item.textOffset >= 0 && { textOffset: item.textOffset }),
      ...(Number.isSafeInteger(item.timelineOrder) && item.timelineOrder >= 0 && { timelineOrder: item.timelineOrder }),
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

function rowToSession(row, includePrivacy = false) {
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
    ...(includePrivacy === true && { privacy: normalizePrivacy(safeJsonParse(row.privacy_json, null)) }),
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
    activity: normalizeActivity(safeJsonParse(row.activity_json, [])).map(item => {
      if (row.status !== 'interrupted' || item.operation !== 'delegate_task') return item;
      const receipts = item.subagents || (item.subagent ? [item.subagent] : []);
      if (item.status !== 'running' && !receipts.some(receipt => receipt.state === 'running')) return item;
      const interrupt = receipt => receipt.state === 'running' ? { ...receipt, state: 'cancelled', report: 'Interrupted when Freedom closed. This helper was not restarted.' } : receipt;
      return { ...item, status: 'failed', label: 'Helper interrupted',
        ...(item.subagent && { subagent: interrupt(item.subagent) }),
        ...(item.subagents && { subagents: item.subagents.map(interrupt) }) };
    }),
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
    try {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.#migrate();
    } catch (error) {
      // A rolled-back migration must be retried, not bypassed by a cached connection.
      this.close();
      throw error;
    }
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
      this.db.transaction(() => {
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
      })();
    }
    if (version < 2) {
      this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN guidance_json TEXT NOT NULL DEFAULT '[]';
      `);
      this.db.pragma('user_version = 2');
      })();
    }
    if (version < 3) {
      this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE agent_turns
          ADD COLUMN attachments_json TEXT NOT NULL DEFAULT '[]';
      `);
      this.db.pragma('user_version = 3');
      })();
    }
    if (version < 4) {
      this.db.transaction(() => {
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
      this.db.pragma('user_version = 4');
      })();
    }
    if (version < 5) {
      this.db.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS agent_helper_reports (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
          run_id TEXT NOT NULL REFERENCES agent_turns(id) ON DELETE CASCADE,
          task_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL,
          report TEXT NOT NULL, report_chars INTEGER NOT NULL,
          truncated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_helper_reports_session ON agent_helper_reports(session_id, created_at DESC);`);
        // Finalize each bounded read before writing: better-sqlite3 forbids
        // writes while an iterate() cursor is active on this connection.
        const readBatch = this.db.prepare(`SELECT id, session_id, activity_json, started_at
          FROM agent_turns WHERE id > ? ORDER BY id ASC LIMIT 100`);
        const update = this.db.prepare('UPDATE agent_turns SET activity_json = ? WHERE id = ? AND session_id = ?');
        let cursor = '';
        while (true) {
          const rows = readBatch.all(cursor);
          if (!rows.length) break;
          for (const row of rows) {
            const activity = this.#compactReports(row.session_id, row.id, safeJsonParse(row.activity_json, []), row.started_at);
            update.run(JSON.stringify(activity), row.id, row.session_id);
          }
          cursor = rows.at(-1).id;
        }
        this.db.pragma('user_version = 5');
      })();
    }
    if (version < 6) {
      this.db.transaction(() => {
        this.db.exec('ALTER TABLE agent_sessions ADD COLUMN privacy_json TEXT');
        this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
      })();
    }
  }

  updatePrivacy({ conversationId, privacy }) {
    const id = requiredString(conversationId, 'Agent conversation ID', 160);
    this.getDb().prepare('UPDATE agent_sessions SET privacy_json = ? WHERE id = ?')
      .run(JSON.stringify(normalizePrivacy(privacy)), id);
  }

  // Reports belong to conversation history, but not to its eagerly loaded JSON.
  // Immutable IDs also keep earlier follow-up reports addressable.
  saveHelperReport(conversationId, runId, value, createdAt = this.now()) {
    const receipt = normalizeSubagentReceipt(value);
    if (!receipt || !receipt.report || receipt.reportId) return receipt;
    const db = this.getDb();
    if (!db.prepare('SELECT id FROM agent_turns WHERE id = ? AND session_id = ?').get(runId, conversationId)) {
      throw new Error('Report conversation is unavailable. Reopen the conversation before retrieving reports.');
    }
    const reportId = `report_${crypto.createHash('sha256').update(JSON.stringify([conversationId, runId, receipt.taskId, receipt.state, receipt.report, receipt.reportTruncated])).digest('hex')}`;
    let reportChars = 0;
    for (const _character of receipt.report) reportChars++;
    db.prepare(`INSERT OR IGNORE INTO agent_helper_reports
      (id, session_id, run_id, task_id, title, state, report, report_chars, truncated, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(reportId, conversationId, runId,
      receipt.taskId, receipt.title, receipt.state, receipt.report, reportChars, receipt.reportTruncated ? 1 : 0, createdAt);
    return normalizeSubagentReceipt({ ...receipt, reportId, reportChars, report: receipt.report.slice(0, 600) });
  }

  #compactReports(conversationId, runId, activity, createdAt) {
    return normalizeActivity(activity).map(item => ({ ...item,
      ...(item.subagent && { subagent: this.saveHelperReport(conversationId, runId, item.subagent, createdAt) }),
      ...(item.subagents && { subagents: item.subagents.map(receipt => this.saveHelperReport(conversationId, runId, receipt, createdAt)) }),
    }));
  }

  helperReports(conversationId, params = {}) {
    const id = requiredString(conversationId, 'Agent conversation ID', 160);
    const { action = 'list', reportId, offset = 0, limit = action === 'read' ? 8000 : 20, query = '' } = params;
    if (!['list', 'read'].includes(action) || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > (action === 'read' ? 16000 : 50) ||
        typeof query !== 'string' || query.length > 200 ||
        (action === 'read' && !/^report_[a-f0-9]{64}$/.test(reportId || ''))) {
      throw new TypeError('Use list with an optional search query and offset, or read with a reportId and character offset. Limits: 50 entries or 16000 characters.');
    }
    const db = this.getDb();
    if (action === 'list') {
      const rows = db.prepare(`SELECT id, run_id, task_id, title, state, report_chars, truncated, created_at
        FROM agent_helper_reports WHERE session_id = ? AND (instr(lower(title), lower(?)) > 0 OR instr(lower(report), lower(?)) > 0)
        ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`).all(id, query, query, limit + 1, offset);
      return { reports: rows.slice(0, limit).map(row => ({ reportId: row.id, runId: row.run_id, taskId: row.task_id,
        title: row.title, state: row.state, reportChars: row.report_chars, reportTruncated: Boolean(row.truncated), createdAt: row.created_at })),
      nextOffset: rows.length > limit ? offset + limit : null };
    }
    // SQLite pages by Unicode code point, avoiding split surrogate pairs and
    // loading only the requested text into the main process.
    const row = db.prepare('SELECT substr(report, ?, ?) AS text, report_chars, truncated FROM agent_helper_reports WHERE session_id = ? AND id = ?')
      .get(offset + 1, limit, id, reportId);
    if (!row) return { error: 'Report not found in this conversation. List its saved reports and use a returned reportId.' };
    return { reportId, text: row.text, offset, reportChars: row.report_chars, reportTruncated: Boolean(row.truncated),
      nextOffset: offset + limit < row.report_chars ? offset + limit : null };
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
      setSessionModel: db.prepare(`
        UPDATE agent_sessions SET provider_id = ?, model_id = ?, thinking_level = ?
        WHERE id = ? AND COALESCE(provider_id, '') = '' AND COALESCE(model_id, '') = ''
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
      updateRunningTurnActivity: db.prepare(`
        UPDATE agent_turns SET activity_json = ?
        WHERE id = ? AND session_id = ? AND status = 'running'
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
      entry.status === 'ready' ? 'ready' : 'running',
      createdAt,
      createdAt
    );
    return this.getSession(id);
  }

  setSessionModel(entry) {
    const id = requiredString(entry?.conversationId, 'Agent conversation ID', 160);
    const providerId = requiredString(entry?.providerId, 'Agent provider ID', MAX_MODEL_FIELD_LENGTH);
    const modelId = requiredString(entry?.modelId, 'Agent model ID', MAX_MODEL_FIELD_LENGTH);
    return this.#getStatements().setSessionModel.run(providerId, modelId,
      optionalString(entry.thinkingLevel, 80), id).changes === 1;
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
    const activity = this.#compactReports(sessionId, runId, entry?.activity);
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
    const activity = this.#compactReports(sessionId, runId, entry?.activity);
    const statement = entry.running === true
      ? this.#getStatements().updateRunningTurnActivity : this.#getStatements().updateTurnActivity;
    const result = statement.run(
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
    const session = rowToSession(this.#getStatements().getSession.get(id), true);
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
