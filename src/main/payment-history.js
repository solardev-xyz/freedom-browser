/**
 * Payment history (SQLite-backed). Unified ledger of every outgoing
 * payment the browser signs or sends — x402 micropayments, wallet sends,
 * dapp-routed sends. Replaces the legacy x402-receipts.json store.
 *
 * Schema is intentionally a superset of what any current source produces;
 * source-specific extras go in the `metadata` JSON blob so future kinds
 * (Lightning, rollups, …) don't need migrations. See KINDS / STATUSES.
 *
 * Broadcast txs are born 'pending' and need a follow-up markConfirmed /
 * markFailed; if the app exits in between, repollPending picks them up
 * next boot. x402 receipts are born final.
 */

const log = require('./logger');
const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const IPC = require('../shared/ipc-channels');
const { broadcastToAllWebContents } = require('./lib/broadcast-to-all-webcontents');

const SCHEMA_VERSION = 1;
const DB_FILE = 'payment-history.sqlite';
const LEGACY_JSON_FILE = 'x402-receipts.json';
const MIGRATED_SUFFIX = '.migrated';

const KINDS = Object.freeze({
  X402: 'x402',
  WALLET_SEND: 'wallet-send',
  DAPP_SEND: 'dapp-send',
  SAFE_SEND: 'safe-send',
  SAFE_DEPLOY: 'safe-deploy',
});
const STATUSES = Object.freeze({
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  FAILED: 'failed',
  SETTLED: 'settled',
  NO_RECEIPT: 'no-receipt',
});
const FINAL_STATUSES = new Set([
  STATUSES.CONFIRMED, STATUSES.FAILED, STATUSES.SETTLED, STATUSES.NO_RECEIPT,
]);
const isFinalStatus = (status) => FINAL_STATUSES.has(status);

let db = null;
let statements = null;

function getDb() {
  if (db) return db;

  const dbPath = path.join(app.getPath('userData'), DB_FILE);
  log.info('[PaymentHistory] Opening database:', dbPath);

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  migrateDatabase();
  migrateFromJson();

  return db;
}

function closeDb() {
  if (db) {
    log.info('[PaymentHistory] Closing database');
    db.close();
    db = null;
    statements = null;
  }
}

function migrateDatabase() {
  const version = db.pragma('user_version', { simple: true });

  if (version < SCHEMA_VERSION) {
    log.info(`[PaymentHistory] Migrating schema ${version} → ${SCHEMA_VERSION}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        kind          TEXT    NOT NULL,
        chain_id      INTEGER NOT NULL,
        tx_hash       TEXT,
        from_address  TEXT,
        to_address    TEXT,
        asset         TEXT,
        amount        TEXT    NOT NULL,
        origin        TEXT,
        url           TEXT,
        status        TEXT    NOT NULL,
        created_at    INTEGER NOT NULL,
        confirmed_at  INTEGER,
        gas_used      TEXT,
        gas_price     TEXT,
        metadata      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payments_created ON payments(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_payments_kind    ON payments(kind);
      CREATE INDEX IF NOT EXISTS idx_payments_chain   ON payments(chain_id);
      CREATE INDEX IF NOT EXISTS idx_payments_origin  ON payments(origin);
      CREATE INDEX IF NOT EXISTS idx_payments_tx_hash ON payments(tx_hash);
      CREATE INDEX IF NOT EXISTS idx_payments_status  ON payments(status);
    `);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

// One-shot import of the legacy x402-receipts.json store. Renamed to
// `.migrated` on success because the table has no natural unique key —
// re-importing would duplicate every row.
function migrateFromJson() {
  const jsonPath = path.join(app.getPath('userData'), LEGACY_JSON_FILE);
  if (!fs.existsSync(jsonPath)) return;

  const migratedPath = jsonPath + MIGRATED_SUFFIX;
  if (fs.existsSync(migratedPath)) {
    try {
      fs.unlinkSync(jsonPath);
      log.info('[PaymentHistory] Dropped stray x402-receipts.json (already migrated)');
    } catch (err) {
      log.error('[PaymentHistory] Failed to remove stray x402-receipts.json:', err.message);
    }
    return;
  }

  try {
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    const entries = Array.isArray(raw) ? raw : [];

    if (entries.length > 0) {
      let imported = 0;
      const insertOne = (e) => {
        // settledAt was stored in seconds; the new store uses ms.
        const hasSettledAt = Number.isFinite(e.settledAt);
        const settledMs = hasSettledAt ? e.settledAt * 1000 : Date.now();
        const status = typeof e.status === 'string' ? e.status : STATUSES.NO_RECEIPT;
        const metadata = legacyMetadataFor(e, status);
        const row = legacyRowFor(e, settledMs, status, hasSettledAt);
        if (legacyAlreadyImported(row, metadata)) return;
        insertRow({
          ...row,
          kind: KINDS.X402,
          metadata,
        });
        imported++;
      };

      db.transaction((items) => { for (const e of items) insertOne(e); })(entries);
      log.info(`[PaymentHistory] Migrated ${imported} entries from x402-receipts.json`);
    }

    fs.renameSync(jsonPath, migratedPath);
  } catch (err) {
    log.error('[PaymentHistory] Failed to migrate from JSON:', err.message);
  }
}

function legacyMetadataFor(entry, status) {
  const legacyId = typeof entry.id === 'string' && entry.id
    ? entry.id
    : [
      'legacy',
      Number.isFinite(entry.settledAt) ? entry.settledAt : '',
      status,
      entry.chainId ?? '',
      entry.txHash ?? '',
      entry.url ?? '',
      entry.amount ?? '',
    ].join(':');
  return JSON.stringify({ legacyId });
}

function legacyRowFor(entry, settledMs, status, hasSettledAt) {
  return {
    chainId: Number.isFinite(entry.chainId) ? entry.chainId : 0,
    txHash: typeof entry.txHash === 'string' ? entry.txHash : null,
    asset: typeof entry.asset === 'string' ? entry.asset : null,
    amount: typeof entry.amount === 'string' ? entry.amount : '0',
    origin: typeof entry.origin === 'string' ? entry.origin : null,
    url: typeof entry.url === 'string' ? entry.url : null,
    status,
    createdAt: settledMs,
    confirmedAt: isFinalStatus(status) ? settledMs : null,
    hasSettledAt,
  };
}

function legacyAlreadyImported(legacy, metadata) {
  return getDb()
    .prepare('SELECT * FROM payments WHERE kind = ? ORDER BY created_at DESC LIMIT ? OFFSET ?')
    .all(KINDS.X402, 100_000, 0)
    .some((row) => row.metadata === metadata || legacyRowMatches(row, legacy));
}

function legacyRowMatches(row, legacy) {
  return (
    row.chain_id === legacy.chainId &&
    (row.tx_hash ?? null) === legacy.txHash &&
    (row.asset ?? null) === legacy.asset &&
    row.amount === legacy.amount &&
    (row.origin ?? null) === legacy.origin &&
    (row.url ?? null) === legacy.url &&
    row.status === legacy.status &&
    (!legacy.hasSettledAt || row.created_at === legacy.createdAt)
  );
}

// Shared row builder so the migration path doesn't need a bespoke INSERT
// SQL (and the test fake doesn't need a second recogniser for it).
function insertRow(row) {
  return getStatements().insert.run(
    row.kind,
    row.chainId,
    row.txHash ?? null,
    row.fromAddress ?? null,
    row.toAddress ?? null,
    row.asset ?? null,
    row.amount,
    row.origin ?? null,
    row.url ?? null,
    row.status,
    row.createdAt,
    row.confirmedAt ?? null,
    row.gasUsed ?? null,
    row.gasPrice ?? null,
    row.metadata ?? null,
  );
}

function getStatements() {
  if (statements) return statements;

  const database = getDb();
  statements = {
    insert: database.prepare(`
      INSERT INTO payments (
        kind, chain_id, tx_hash, from_address, to_address, asset, amount,
        origin, url, status, created_at, confirmed_at, gas_used, gas_price, metadata
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: database.prepare(`
      UPDATE payments SET
        tx_hash      = COALESCE(?, tx_hash),
        status       = COALESCE(?, status),
        confirmed_at = COALESCE(?, confirmed_at),
        gas_used     = COALESCE(?, gas_used),
        gas_price    = COALESCE(?, gas_price),
        metadata     = COALESCE(?, metadata)
      WHERE id = ?
    `),
    getById: database.prepare(`SELECT * FROM payments WHERE id = ?`),
    getPending: database.prepare(`
      SELECT * FROM payments WHERE status = '${STATUSES.PENDING}' ORDER BY created_at ASC
    `),
    clear: database.prepare(`DELETE FROM payments`),
    deleteById: database.prepare(`DELETE FROM payments WHERE id = ?`),
  };
  return statements;
}

// SQLite columns are snake_case; the renderer-facing API is camelCase.
function rowToEntry(row) {
  if (!row) return null;
  let metadata = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { /* ignore */ }
  }
  return {
    id: row.id,
    kind: row.kind,
    chainId: row.chain_id,
    txHash: row.tx_hash,
    fromAddress: row.from_address,
    toAddress: row.to_address,
    asset: row.asset,
    amount: row.amount,
    origin: row.origin,
    url: row.url,
    status: row.status,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    gasUsed: row.gas_used,
    gasPrice: row.gas_price,
    metadata,
  };
}

/**
 * Insert a payment record. Status defaults to 'pending' for broadcast
 * kinds (wallet-send / dapp-send) and is required for x402 (which is
 * born final). Returns the persisted record.
 *
 * @param {object} entry
 * @param {'x402'|'wallet-send'|'dapp-send'} entry.kind
 * @param {number} entry.chainId
 * @param {string} entry.amount — atomic units, digit string
 * @param {string|null} [entry.txHash]
 * @param {string|null} [entry.fromAddress]
 * @param {string|null} [entry.toAddress]
 * @param {string|null} [entry.asset] — ERC-20 contract; null = native
 * @param {string|null} [entry.origin]
 * @param {string|null} [entry.url]
 * @param {string} [entry.status]
 * @param {number} [entry.createdAt] — ms epoch; defaults to now
 * @param {object|null} [entry.metadata]
 */
// "Table changed, re-query." Receivers ignore the payload and pull
// fresh state via `payments:get-recent`; the id/kind/status/txHash
// fields are forward-compat for receivers that may want to filter
// (e.g. "ignore unless kind === 'x402'") without an extra IPC.
function broadcastTxRecorded(entry) {
  broadcastToAllWebContents(IPC.PAYMENTS_TX_RECORDED, entry ? {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    txHash: entry.txHash ?? null,
  } : { id: null });
}

function append(entry = {}) {
  if (!Object.values(KINDS).includes(entry.kind)) {
    throw new Error(`payment-history: unknown kind '${entry.kind}'`);
  }
  if (!Number.isFinite(entry.chainId)) {
    throw new Error('payment-history: chainId must be a finite number');
  }
  if (typeof entry.amount !== 'string' || !/^\d+$/.test(entry.amount)) {
    throw new Error('payment-history: amount must be a digit string');
  }

  const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : Date.now();
  const status = entry.status || (entry.kind === KINDS.X402 ? STATUSES.SETTLED : STATUSES.PENDING);

  const result = insertRow({
    ...entry,
    createdAt,
    status,
    confirmedAt: isFinalStatus(status) ? createdAt : null,
    metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
  });

  const inserted = rowToEntry(getStatements().getById.get(result.lastInsertRowid));
  broadcastTxRecorded(inserted);
  return inserted;
}

/**
 * Patch a row by id. Any field omitted is ignored (COALESCE keeps the
 * existing value). Status transitioning to a final value also stamps
 * `confirmed_at = now()` when the caller didn't supply one.
 */
function update(id, patch = {}) {
  const transitioningToFinal = patch.status && isFinalStatus(patch.status);
  const confirmedAt = patch.confirmedAt ?? (transitioningToFinal ? Date.now() : null);

  const result = getStatements().update.run(
    patch.txHash ?? null,
    patch.status ?? null,
    confirmedAt,
    patch.gasUsed ?? null,
    patch.gasPrice ?? null,
    patch.metadata ? JSON.stringify(patch.metadata) : null,
    id,
  );
  if (result.changes === 0) return null;
  const updated = rowToEntry(getStatements().getById.get(id));
  broadcastTxRecorded(updated);
  return updated;
}

function markConfirmed(id, receipt = {}) {
  return update(id, {
    status: STATUSES.CONFIRMED,
    gasUsed: receipt.gasUsed,
    gasPrice: receipt.gasPrice ?? receipt.effectiveGasPrice,
    confirmedAt: receipt.confirmedAt,
  });
}

function markFailed(id, { reason, gasUsed, gasPrice } = {}) {
  return update(id, {
    status: STATUSES.FAILED,
    gasUsed,
    gasPrice,
    metadata: reason ? { failureReason: reason } : undefined,
  });
}

// Filter keys the store accepts; anything else is silently dropped so the
// renderer can pass through UI state without breaking. Clamping `limit`
// and `offset` guards against a runaway page-size request pulling the
// entire table across IPC.
const FILTER_KEYS = ['kind', 'chainId', 'origin', 'status'];
const MAX_LIMIT = 500;

function sanitizeFilters(raw = {}) {
  const out = {};
  for (const key of FILTER_KEYS) {
    if (raw[key] !== undefined) out[key] = raw[key];
  }
  if (raw.limit !== undefined) {
    out.limit = Math.min(Math.max(0, Number(raw.limit) | 0), MAX_LIMIT);
  }
  if (raw.offset !== undefined) {
    out.offset = Math.max(0, Number(raw.offset) | 0);
  }
  return out;
}

// Build a WHERE fragment + parameter array from a sanitised filter object.
// Used by both getRecent and getCount so the filter shape stays in lock-step.
function buildWhere(filters) {
  const where = [];
  const params = [];
  if (filters.kind)               { where.push('kind = ?');     params.push(filters.kind); }
  if (filters.chainId !== undefined) { where.push('chain_id = ?'); params.push(filters.chainId); }
  if (filters.origin)             { where.push('origin = ?');   params.push(filters.origin); }
  if (filters.status)             { where.push('status = ?');   params.push(filters.status); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return { clause, params };
}

/**
 * Filtered, paginated read. Filters are AND-combined. All optional.
 *
 * @param {object} filters
 * @param {string} [filters.kind]
 * @param {number} [filters.chainId]
 * @param {string} [filters.origin]
 * @param {string} [filters.status]
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 */
function getRecent(filters = {}) {
  const safe = sanitizeFilters(filters);
  const { clause, params } = buildWhere(safe);
  const sql = `SELECT * FROM payments ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
  return getDb()
    .prepare(sql)
    .all(...params, safe.limit ?? 50, safe.offset ?? 0)
    .map(rowToEntry);
}

function getById(id) {
  return rowToEntry(getStatements().getById.get(id));
}

function getCount(filters = {}) {
  const { clause, params } = buildWhere(sanitizeFilters(filters));
  return getDb().prepare(`SELECT COUNT(*) AS n FROM payments ${clause}`).get(...params).n;
}

function clear() {
  const changes = getStatements().clear.run().changes;
  if (changes > 0) broadcastTxRecorded(null);
  return changes;
}

function removeById(id) {
  const removed = getStatements().deleteById.run(id).changes > 0;
  if (removed) broadcastTxRecorded(null);
  return removed;
}

/**
 * Re-poll every `pending` row's status. For each row, the caller-supplied
 * `getStatusFn(txHash, chainId)` is awaited; if it returns a final status
 * the row is updated. Anything that throws or stays pending is left alone.
 *
 * Exposed as an explicit function (not auto-run on open) so callers can
 * trigger it once the provider stack is up. PH2 will wire this from
 * `index.js` after the wallet bootstrap finishes.
 *
 * @param {(txHash:string, chainId:number) => Promise<{status:string, gasUsed?:string, gasPrice?:string}>} getStatusFn
 * @returns {Promise<{ resolved:number, stillPending:number, errors:number }>}
 */
async function repollPending(getStatusFn) {
  const pending = getStatements().getPending.all();
  let resolved = 0;
  let stillPending = 0;
  let errors = 0;

  for (const row of pending) {
    if (!row.tx_hash) { stillPending++; continue; }
    try {
      const r = await getStatusFn(row.tx_hash, row.chain_id);
      if (r?.status === STATUSES.CONFIRMED) {
        markConfirmed(row.id, { gasUsed: r.gasUsed, gasPrice: r.gasPrice ?? r.effectiveGasPrice });
        resolved++;
      } else if (r?.status === STATUSES.FAILED) {
        markFailed(row.id, { gasUsed: r.gasUsed, gasPrice: r.gasPrice ?? r.effectiveGasPrice });
        resolved++;
      } else {
        stillPending++;
      }
    } catch (err) {
      log.warn(`[PaymentHistory] repoll failed for row ${row.id}: ${err.message}`);
      errors++;
    }
  }

  if (resolved > 0) log.info(`[PaymentHistory] repoll resolved ${resolved} pending row(s)`);
  return { resolved, stillPending, errors };
}

// === IPC =================================================================

function registerPaymentHistoryIpc() {
  ipcMain.handle(IPC.PAYMENTS_GET_RECENT, (_event, filters) => {
    try {
      return { success: true, payments: getRecent(filters) };
    } catch (err) {
      log.error('[PaymentHistory] get-recent failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.PAYMENTS_GET_BY_ID, (_event, id) => {
    if (!Number.isInteger(id)) {
      return { success: false, error: 'id must be an integer' };
    }
    try {
      return { success: true, payment: getById(id) };
    } catch (err) {
      log.error('[PaymentHistory] get-by-id failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.PAYMENTS_GET_COUNT, (_event, filters) => {
    try {
      return { success: true, count: getCount(filters) };
    } catch (err) {
      log.error('[PaymentHistory] get-count failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.PAYMENTS_CLEAR, () => {
    try {
      return { success: true, removed: clear() };
    } catch (err) {
      log.error('[PaymentHistory] clear failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  log.info('[PaymentHistory] IPC handlers registered');
}

module.exports = {
  KINDS,
  STATUSES,
  getDb,
  closeDb,
  append,
  update,
  markConfirmed,
  markFailed,
  getRecent,
  getById,
  getCount,
  clear,
  removeById,
  repollPending,
  registerPaymentHistoryIpc,
  _migrateFromJsonForTest: migrateFromJson,
};
