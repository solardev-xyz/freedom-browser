'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const log = require('../logger');

const DB_FILE = 'agent-workspaces.sqlite';
const SCHEMA_VERSION = 1;
const WORKSPACE_DIRECTORY = 'agent-workspaces';
const MAX_RETAINED_COMMANDS = 1_000;
const COMMAND_STATES = new Set([
  'running',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'sandbox_denied',
  'interrupted',
]);

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
  if (typeof value !== 'string') throw new TypeError('Workspace metadata must be a string');
  return value.slice(0, maxLength);
}

function opaqueWorkspaceId() {
  return `workspace_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function opaqueCommandId() {
  return `workspace_cmd_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function rowToWorkspace(row) {
  if (!row) return null;
  return Object.freeze({
    workspaceId: row.id,
    conversationId: row.conversation_id,
    enabled: row.enabled === 1,
    backend: row.backend || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function rowToCommand(row) {
  if (!row) return null;
  return Object.freeze({
    commandId: row.id,
    workspaceId: row.workspace_id,
    conversationId: row.conversation_id,
    command: row.command_text,
    workingDirectory: row.working_directory,
    state: COMMAND_STATES.has(row.state) ? row.state : 'interrupted',
    backend: row.backend || '',
    startedAt: row.started_at,
    ...(Number.isFinite(row.finished_at) && { finishedAt: row.finished_at }),
    ...(Number.isFinite(row.duration_ms) && { durationMs: row.duration_ms }),
    ...(Number.isInteger(row.exit_code) && { exitCode: row.exit_code }),
    ...(row.signal && { signal: row.signal }),
    stdout: row.stdout || '',
    stderr: row.stderr || '',
    stdoutTruncated: row.stdout_truncated === 1,
    stderrTruncated: row.stderr_truncated === 1,
    terminationGuarantee: row.termination_guarantee || 'not_applicable',
    sideEffects: row.side_effects || 'unknown',
    ...(row.error_code && {
      error: Object.freeze({
        code: row.error_code,
        message: row.error_message || 'The workspace command did not complete',
      }),
    }),
  });
}

class AgentManagedWorkspaceStore {
  constructor(options = {}) {
    this.userDataDir = requiredString(options.userDataDir, 'Workspace userDataDir', 4_096);
    this.Database = options.Database || Database;
    this.now = options.now || Date.now;
    this.workspaceIdFactory = options.workspaceIdFactory || opaqueWorkspaceId;
    this.commandIdFactory = options.commandIdFactory || opaqueCommandId;
    this.maxRetainedCommands = Number.isSafeInteger(options.maxRetainedCommands)
      ? Math.max(1, options.maxRetainedCommands)
      : MAX_RETAINED_COMMANDS;
    this.workspaceParent = path.join(this.userDataDir, WORKSPACE_DIRECTORY);
    this.db = null;
    this.statements = null;
  }

  getDb() {
    if (this.db) return this.db;
    const dbPath = path.join(this.userDataDir, DB_FILE);
    log.info('[AgentWorkspaces] Opening database:', dbPath);
    this.db = new this.Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.#migrate();
    return this.db;
  }

  close() {
    if (!this.db) return;
    log.info('[AgentWorkspaces] Closing database');
    this.db.close();
    this.db = null;
    this.statements = null;
  }

  #migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_workspaces (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 0,
          backend TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS agent_workspace_commands (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES agent_workspaces(id) ON DELETE CASCADE,
          conversation_id TEXT NOT NULL,
          command_text TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          state TEXT NOT NULL,
          backend TEXT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          duration_ms INTEGER,
          exit_code INTEGER,
          signal TEXT,
          stdout TEXT NOT NULL DEFAULT '',
          stderr TEXT NOT NULL DEFAULT '',
          stdout_truncated INTEGER NOT NULL DEFAULT 0,
          stderr_truncated INTEGER NOT NULL DEFAULT 0,
          termination_guarantee TEXT,
          side_effects TEXT,
          error_code TEXT,
          error_message TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_agent_workspace_commands_owner
          ON agent_workspace_commands(conversation_id, started_at DESC);
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  #getStatements() {
    if (this.statements) return this.statements;
    const db = this.getDb();
    this.statements = {
      insertWorkspace: db.prepare(`
        INSERT INTO agent_workspaces (
          id, conversation_id, enabled, backend, created_at, updated_at
        ) VALUES (?, ?, 0, NULL, ?, ?)
      `),
      getWorkspace: db.prepare(`SELECT * FROM agent_workspaces WHERE id = ?`),
      getConversationWorkspace: db.prepare(
        `SELECT * FROM agent_workspaces WHERE conversation_id = ?`
      ),
      enableWorkspace: db.prepare(`
        UPDATE agent_workspaces SET enabled = 1, backend = ?, updated_at = ?
        WHERE id = ? AND conversation_id = ?
      `),
      insertCommand: db.prepare(`
        INSERT INTO agent_workspace_commands (
          id, workspace_id, conversation_id, command_text, working_directory,
          state, backend, started_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
      `),
      finishCommand: db.prepare(`
        UPDATE agent_workspace_commands SET
          state = ?, finished_at = ?, duration_ms = ?, exit_code = ?, signal = ?,
          stdout = ?, stderr = ?, stdout_truncated = ?, stderr_truncated = ?,
          termination_guarantee = ?, side_effects = ?, error_code = ?, error_message = ?
        WHERE id = ? AND workspace_id = ?
      `),
      listCommands: db.prepare(`
        SELECT * FROM agent_workspace_commands
        WHERE conversation_id = ? ORDER BY started_at DESC LIMIT ?
      `),
      interruptCommands: db.prepare(`
        UPDATE agent_workspace_commands SET
          state = 'interrupted', finished_at = ?, duration_ms = MAX(0, ? - started_at),
          termination_guarantee = COALESCE(termination_guarantee, 'unknown'),
          side_effects = 'unknown', error_code = 'WORKSPACE_EXECUTION_INTERRUPTED',
          error_message = 'Freedom restarted before the command receipt was recorded'
        WHERE state = 'running'
      `),
      pruneCommands: db.prepare(`
        DELETE FROM agent_workspace_commands
        WHERE id IN (
          SELECT id FROM agent_workspace_commands
          WHERE state != 'running'
          ORDER BY started_at DESC
          LIMIT -1 OFFSET ?
        )
      `),
      deleteWorkspace: db.prepare(
        `DELETE FROM agent_workspaces WHERE id = ? AND conversation_id = ?`
      ),
    };
    return this.statements;
  }

  workspacePath(workspaceId) {
    const id = requiredString(workspaceId, 'Workspace ID', 160);
    if (!/^workspace_[a-f0-9]{20}$/.test(id)) throw new TypeError('Workspace ID is invalid');
    return path.join(this.workspaceParent, id);
  }

  getForConversation(conversationId) {
    return rowToWorkspace(
      this.#getStatements().getConversationWorkspace.get(
        requiredString(conversationId, 'Conversation ID', 160)
      )
    );
  }

  get(workspaceId) {
    return rowToWorkspace(
      this.#getStatements().getWorkspace.get(requiredString(workspaceId, 'Workspace ID', 160))
    );
  }

  async ensureForConversation(conversationId) {
    const ownerId = requiredString(conversationId, 'Conversation ID', 160);
    const existing = this.getForConversation(ownerId);
    if (existing) {
      await this.#validateWorkspaceDirectory(existing.workspaceId);
      return existing;
    }
    await fs.promises.mkdir(this.workspaceParent, { recursive: true, mode: 0o700 });
    await fs.promises.chmod(this.workspaceParent, 0o700);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const workspaceId = this.workspaceIdFactory();
      const workspacePath = this.workspacePath(workspaceId);
      try {
        await fs.promises.mkdir(workspacePath, { mode: 0o700 });
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      try {
        await fs.promises.mkdir(path.join(workspacePath, '.git'), { mode: 0o700 });
        const createdAt = this.now();
        this.#getStatements().insertWorkspace.run(workspaceId, ownerId, createdAt, createdAt);
        return this.get(workspaceId);
      } catch (error) {
        try {
          await fs.promises.rm(workspacePath, { recursive: true, force: false });
        } catch (cleanupError) {
          log.warn(
            '[AgentWorkspaces] Could not remove an incomplete managed workspace:',
            cleanupError?.message
          );
        }
        throw error;
      }
    }
    throw new Error('Freedom could not allocate a unique managed workspace');
  }

  async #validateWorkspaceDirectory(workspaceId) {
    const parent = await fs.promises.realpath(this.workspaceParent);
    const candidate = this.workspacePath(workspaceId);
    const entry = await fs.promises.lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error('Managed workspace storage is unavailable');
    }
    const canonical = await fs.promises.realpath(candidate);
    if (path.dirname(canonical) !== parent || path.basename(canonical) !== workspaceId) {
      throw new Error('Managed workspace storage is unavailable');
    }
    return canonical;
  }

  async resolvePath(workspaceId) {
    return this.#validateWorkspaceDirectory(workspaceId);
  }

  enable(workspaceId, conversationId, backend) {
    const id = requiredString(workspaceId, 'Workspace ID', 160);
    const ownerId = requiredString(conversationId, 'Conversation ID', 160);
    const result = this.#getStatements().enableWorkspace.run(
      requiredString(backend, 'Workspace backend', 80),
      this.now(),
      id,
      ownerId
    );
    return result.changes > 0 ? this.get(id) : null;
  }

  startCommand(entry) {
    const commandId = this.commandIdFactory();
    const startedAt = Number.isFinite(entry?.startedAt) ? entry.startedAt : this.now();
    this.#getStatements().insertCommand.run(
      commandId,
      requiredString(entry?.workspaceId, 'Workspace ID', 160),
      requiredString(entry?.conversationId, 'Conversation ID', 160),
      requiredString(entry?.command, 'Workspace command', 32_000),
      requiredString(entry?.workingDirectory, 'Workspace working directory', 1_024),
      requiredString(entry?.backend, 'Workspace backend', 80),
      startedAt
    );
    this.#getStatements().pruneCommands.run(this.maxRetainedCommands);
    return commandId;
  }

  finishCommand(commandId, workspaceId, receipt) {
    const state = COMMAND_STATES.has(receipt?.state) ? receipt.state : 'interrupted';
    const result = this.#getStatements().finishCommand.run(
      state,
      Number.isFinite(receipt?.finishedAt) ? receipt.finishedAt : this.now(),
      Number.isFinite(receipt?.durationMs) ? Math.max(0, receipt.durationMs) : null,
      Number.isInteger(receipt?.exitCode) ? receipt.exitCode : null,
      optionalString(receipt?.signal, 40),
      optionalString(receipt?.stdout, 65_536) || '',
      optionalString(receipt?.stderr, 65_536) || '',
      receipt?.stdoutTruncated === true ? 1 : 0,
      receipt?.stderrTruncated === true ? 1 : 0,
      optionalString(receipt?.terminationGuarantee, 80),
      optionalString(receipt?.sideEffects, 40) || 'unknown',
      optionalString(receipt?.error?.code, 120),
      optionalString(receipt?.error?.message, 512),
      requiredString(commandId, 'Workspace command ID', 160),
      requiredString(workspaceId, 'Workspace ID', 160)
    );
    return result.changes > 0;
  }

  listCommands(conversationId, limit = 50) {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(100, Math.max(1, limit)) : 50;
    return this.#getStatements()
      .listCommands.all(requiredString(conversationId, 'Conversation ID', 160), boundedLimit)
      .map(rowToCommand);
  }

  markStaleRunningAsInterrupted() {
    const now = this.now();
    return this.#getStatements().interruptCommands.run(now, now).changes;
  }

  async deleteConversation(conversationId) {
    const ownerId = requiredString(conversationId, 'Conversation ID', 160);
    const workspace = this.getForConversation(ownerId);
    if (!workspace) return false;
    const workspacePath = await this.#validateWorkspaceDirectory(workspace.workspaceId);
    await fs.promises.rm(workspacePath, { recursive: true, force: false });
    return this.#getStatements().deleteWorkspace.run(workspace.workspaceId, ownerId).changes > 0;
  }
}

module.exports = {
  AgentManagedWorkspaceStore,
  COMMAND_STATES,
  DB_FILE,
  MAX_RETAINED_COMMANDS,
  SCHEMA_VERSION,
  WORKSPACE_DIRECTORY,
  opaqueCommandId,
  opaqueWorkspaceId,
  rowToCommand,
  rowToWorkspace,
};
