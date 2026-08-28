'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const log = require('../logger');

const DB_FILE = 'agent-node-operations.sqlite';
const SCHEMA_VERSION = 1;
const MAX_RETAINED_OPERATIONS = 500;
const OPERATION_STATES = Object.freeze({
  NOT_DISPATCHED: 'not_dispatched',
  IN_FLIGHT: 'in_flight',
  RESPONDED: 'responded',
  DELIVERY_UNCERTAIN: 'delivery_uncertain',
});
const OPERATION_STATE_SET = new Set(Object.values(OPERATION_STATES));

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
  if (typeof value !== 'string') throw new TypeError('Optional node operation data must be a string');
  return value.slice(0, maxLength);
}

function safeJsonParse(value, fallback) {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToOperation(row) {
  if (!row) return null;
  const headerNames = safeJsonParse(row.header_names_json, []);
  const responseHeaders = safeJsonParse(row.response_headers_json, {});
  return Object.freeze({
    operationId: row.id,
    ownerId: row.owner_id,
    state: OPERATION_STATE_SET.has(row.state)
      ? row.state
      : OPERATION_STATES.DELIVERY_UNCERTAIN,
    service: row.service,
    transport: row.transport,
    effect: row.effect,
    request: Object.freeze({
      method: row.method,
      path: row.path,
      ...(Array.isArray(headerNames) && headerNames.length ? { headerNames } : {}),
      ...(row.body_sha256 ? { bodySha256: row.body_sha256 } : {}),
    }),
    ...(Number.isInteger(row.response_status) && {
      response: Object.freeze({
        status: row.response_status,
        statusText: row.response_status_text || '',
        headers:
          responseHeaders && typeof responseHeaders === 'object' && !Array.isArray(responseHeaders)
            ? Object.freeze(responseHeaders)
            : Object.freeze({}),
        body: row.response_body || '',
        bytes: Number.isSafeInteger(row.response_bytes) ? row.response_bytes : 0,
      }),
    }),
    ...(row.error_code && {
      error: Object.freeze({
        code: row.error_code,
        message: row.error_message || 'Freedom lost observability after dispatch',
      }),
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

class AgentNodeOperationStore {
  constructor(options = {}) {
    this.userDataDir = requiredString(options.userDataDir, 'Node operation userDataDir', 4_096);
    this.Database = options.Database || Database;
    this.now = options.now || Date.now;
    this.maxRetainedOperations = Number.isSafeInteger(options.maxRetainedOperations)
      ? Math.max(1, options.maxRetainedOperations)
      : MAX_RETAINED_OPERATIONS;
    this.db = null;
    this.statements = null;
  }

  getDb() {
    if (this.db) return this.db;
    const dbPath = path.join(this.userDataDir, DB_FILE);
    log.info('[AgentNodeOperations] Opening database:', dbPath);
    this.db = new this.Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.#migrate();
    return this.db;
  }

  close() {
    if (!this.db) return;
    log.info('[AgentNodeOperations] Closing database');
    this.db.close();
    this.db = null;
    this.statements = null;
  }

  #migrate() {
    const version = this.db.pragma('user_version', { simple: true });
    if (version < 1) {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS agent_node_operations (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          state TEXT NOT NULL,
          service TEXT NOT NULL,
          transport TEXT NOT NULL,
          effect TEXT NOT NULL,
          method TEXT NOT NULL,
          path TEXT NOT NULL,
          header_names_json TEXT NOT NULL DEFAULT '[]',
          body_sha256 TEXT,
          response_status INTEGER,
          response_status_text TEXT,
          response_headers_json TEXT,
          response_body TEXT,
          response_bytes INTEGER,
          error_code TEXT,
          error_message TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_node_operations_owner_updated
          ON agent_node_operations(owner_id, updated_at DESC);
      `);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    }
  }

  #getStatements() {
    if (this.statements) return this.statements;
    const db = this.getDb();
    this.statements = {
      insert: db.prepare(`
        INSERT INTO agent_node_operations (
          id, owner_id, state, service, transport, effect, method, path,
          header_names_json, body_sha256, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      markInFlight: db.prepare(`
        UPDATE agent_node_operations
        SET state = ?, error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `),
      markResponded: db.prepare(`
        UPDATE agent_node_operations SET
          state = ?, response_status = ?, response_status_text = ?,
          response_headers_json = ?, response_body = ?, response_bytes = ?,
          error_code = NULL, error_message = NULL, updated_at = ?
        WHERE id = ?
      `),
      markUncertain: db.prepare(`
        UPDATE agent_node_operations SET
          state = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE id = ?
      `),
      getOwned: db.prepare(`
        SELECT * FROM agent_node_operations WHERE id = ? AND owner_id = ?
      `),
      get: db.prepare(`SELECT * FROM agent_node_operations WHERE id = ?`),
      listRecent: db.prepare(`
        SELECT * FROM agent_node_operations
        WHERE owner_id = ?
        ORDER BY updated_at DESC
        LIMIT ?
      `),
      markStaleInFlight: db.prepare(`
        UPDATE agent_node_operations SET
          state = ?, error_code = ?, error_message = ?, updated_at = ?
        WHERE state = ?
      `),
      prune: db.prepare(`
        DELETE FROM agent_node_operations
        WHERE id IN (
          SELECT id FROM agent_node_operations
          WHERE state != ?
          ORDER BY updated_at DESC
          LIMIT -1 OFFSET ?
        )
      `),
    };
    return this.statements;
  }

  create(entry) {
    const id = requiredString(entry?.operationId, 'Node operation ID', 160);
    const ownerId = requiredString(entry?.ownerId, 'Node operation owner ID', 160);
    const createdAt = Number.isFinite(entry?.createdAt) ? entry.createdAt : this.now();
    const headerNames = Array.isArray(entry?.request?.headerNames)
      ? entry.request.headerNames.filter((value) => typeof value === 'string').slice(0, 32)
      : [];
    this.#getStatements().insert.run(
      id,
      ownerId,
      OPERATION_STATES.NOT_DISPATCHED,
      requiredString(entry?.service, 'Node operation service', 40),
      requiredString(entry?.transport, 'Node operation transport', 40),
      requiredString(entry?.effect, 'Node operation effect', 40),
      requiredString(entry?.request?.method, 'Node operation method', 12),
      requiredString(entry?.request?.path, 'Node operation path', 2_048),
      JSON.stringify(headerNames),
      optionalString(entry?.request?.bodySha256, 64),
      createdAt,
      createdAt
    );
    this.#getStatements().prune.run(OPERATION_STATES.IN_FLIGHT, this.maxRetainedOperations);
    return this.get(id, ownerId);
  }

  markInFlight(operationId) {
    this.#getStatements().markInFlight.run(
      OPERATION_STATES.IN_FLIGHT,
      this.now(),
      requiredString(operationId, 'Node operation ID', 160)
    );
    return this.getAny(operationId);
  }

  markResponded(operationId, response) {
    this.#getStatements().markResponded.run(
      OPERATION_STATES.RESPONDED,
      response.status,
      optionalString(response.statusText, 240) || '',
      JSON.stringify(response.headers || {}),
      optionalString(response.body, 65_536) || '',
      response.bytes,
      this.now(),
      requiredString(operationId, 'Node operation ID', 160)
    );
    return this.getAny(operationId);
  }

  markDeliveryUncertain(operationId, error) {
    this.#getStatements().markUncertain.run(
      OPERATION_STATES.DELIVERY_UNCERTAIN,
      optionalString(error?.code, 120) || 'NODE_DELIVERY_UNCERTAIN',
      optionalString(error?.message, 512) || 'Freedom lost observability after dispatch',
      this.now(),
      requiredString(operationId, 'Node operation ID', 160)
    );
    return this.getAny(operationId);
  }

  markStaleInFlightAsUncertain() {
    return this.#getStatements().markStaleInFlight.run(
      OPERATION_STATES.DELIVERY_UNCERTAIN,
      'NODE_DELIVERY_UNCERTAIN',
      'Freedom restarted before the node response was received',
      this.now(),
      OPERATION_STATES.IN_FLIGHT
    ).changes;
  }

  get(operationId, ownerId) {
    return rowToOperation(
      this.#getStatements().getOwned.get(
        requiredString(operationId, 'Node operation ID', 160),
        requiredString(ownerId, 'Node operation owner ID', 160)
      )
    );
  }

  getAny(operationId) {
    return rowToOperation(
      this.#getStatements().get.get(requiredString(operationId, 'Node operation ID', 160))
    );
  }

  listRecent(ownerId, limit = 20) {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(20, Math.max(1, limit)) : 20;
    return this.#getStatements()
      .listRecent.all(
        requiredString(ownerId, 'Node operation owner ID', 160),
        boundedLimit
      )
      .map(rowToOperation);
  }
}

module.exports = {
  AgentNodeOperationStore,
  DB_FILE,
  MAX_RETAINED_OPERATIONS,
  OPERATION_STATES,
  SCHEMA_VERSION,
};
