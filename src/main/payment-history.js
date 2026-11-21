/**
 * Payment history: the unified ledger of every outgoing payment the browser
 * signs or sends — x402 micropayments, wallet sends, dapp-routed sends.
 *
 * The ledger is `payment-history.sqlite`, which the identity core keeps
 * (freedom-core design 0013, "Payment history"; PRF-6(c)): this build names
 * `payments` in the hello's `store_moved`, so the core is the database's
 * one writer and reader, and main opens none of its files. Each function
 * here is one `payments.*` request (core/vault-backend.js), answered as the
 * module answered it when it kept the database itself, but asynchronously:
 * a record (camelCase, `metadata` parsed) or null, a list of them, a count.
 * A refusal is thrown as the module threw it (the class and message the
 * core names), and a core that can't serve the store fails the request
 * (`requirement_unmet`, `storage`, `core_unavailable`). The core opens the
 * database at its first request and imports the legacy `x402-receipts.json`
 * then, once.
 *
 * Schema is intentionally a superset of what any current source produces;
 * source-specific extras go in the `metadata` JSON blob so future kinds
 * (Lightning, rollups, …) don't need migrations. See KINDS / STATUSES.
 *
 * Broadcast txs are born 'pending' and need a follow-up markConfirmed /
 * markFailed; if the app exits in between, repollPending picks them up
 * once the core is up again. x402 receipts are born final.
 */

const log = require('./logger');
const { ipcMain } = require('electron');
const IPC = require('../shared/ipc-channels');
const { broadcastToAllWebContents } = require('./lib/broadcast-to-all-webcontents');
const { vaultBackend } = require('./core/vault-backend');

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
  // A wallet intent whose nonce another transaction used, read at the
  // finalized block: this payment may or may not have happened (it may
  // have been signed elsewhere too).
  TAKEN: 'taken',
  // Never mined, and never can be: another transaction took its nonce.
  DROPPED: 'dropped',
  // A wallet intent the user closed by hand once its label couldn't be
  // read (Couldn't confirm): whether it paid is unknown.
  UNCONFIRMED: 'unconfirmed',
  // A phone account's payment whose reported transaction main hasn't seen
  // yet, so hasn't compared with the one confirmed (tx-recorder.js, design
  // 0012 "Unverified payments"). Not polled for a receipt: once checked
  // and the same, it goes on as 'pending'.
  UNVERIFIED: 'unverified',
  // A phone payment whose reported transaction, once visible, isn't the
  // one confirmed (its sender, recipient, amount, data or chain differs).
  // Never confirmed.
  WRONG_TRANSACTION: 'wrong-transaction',
  // A phone payment never seen on chain within a day of its answer, or
  // whose check a clock set back ended: whether it is the one confirmed is
  // unknown.
  UNKNOWN: 'unknown',
});

// "Table changed, re-query." Receivers ignore the payload and pull
// fresh state via `payments:get-recent`; the id/kind/status/txHash
// fields are forward-compat for receivers that may want to filter
// (e.g. "ignore unless kind === 'x402'") without an extra IPC. Sent once
// the core has answered a write that changed a row.
function broadcastTxRecorded(entry) {
  broadcastToAllWebContents(IPC.PAYMENTS_TX_RECORDED, entry ? {
    id: entry.id,
    kind: entry.kind,
    status: entry.status,
    txHash: entry.txHash ?? null,
  } : { id: null });
}

// The codes of a failure the core answered before it wrote anything, or
// that main refused unsent: the write didn't happen. Any other failure (a
// lost answer: `core_unavailable`, a hang's `timeout`, `cancelled`,
// `internal`) leaves its outcome unknown until the core is back.
const NOT_WRITTEN = new Set([
  'invalid_argument',
  'not_moved',
  'forbidden',
  'no_profile',
  'storage',
  'deadline',
  'unknown_method',
  'requirement_unmet',
  'busy',
]);
const outcomeUnknown = (err) => !NOT_WRITTEN.has(err?.code);

// A write whose outcome is unknown changed the history, or didn't, and no
// one heard of it: at the core's next start, once the history has been
// read again, every listener is told to read it again too.
let rereadOwed = false;

/**
 * One write: the core's record of it (or `removed`), broadcast when it
 * changed something (`changed`), and the re-read owed when its answer was
 * lost.
 */
async function written(request, changed) {
  let answer;
  try {
    answer = await request();
  } catch (err) {
    if (outcomeUnknown(err)) rereadOwed = true;
    throw err;
  }
  changed(answer);
  return answer;
}

/** The core's record of a write, broadcast when it names a row. */
function recorded(request) {
  return written(request, (entry) => {
    if (entry) broadcastTxRecorded(entry);
  });
}

/**
 * Insert a payment record. Status defaults to 'pending' for broadcast
 * kinds (wallet-send / dapp-send) and is required for x402 (which is
 * born final). Resolves with the persisted record.
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
function append(entry = {}) {
  return recorded(() => vaultBackend.payments.append(entry));
}

/**
 * Patch a row by id. Any field omitted is ignored (the row keeps its
 * value). Status transitioning to a final value also stamps
 * `confirmedAt = now()` when the caller didn't supply one. Resolves with
 * the record, or null when no row has `id`.
 */
function update(id, patch = {}) {
  return recorded(() => vaultBackend.payments.update(id, patch));
}

function markConfirmed(id, receipt = {}) {
  return recorded(() => vaultBackend.payments.markConfirmed(id, receipt));
}

function markFailed(id, info = {}) {
  return recorded(() => vaultBackend.payments.markFailed(id, info));
}

// Merges into the row's metadata rather than replacing it: a Safe row's
// own metadata must survive the status change. Only a row still pending
// is marked: the sweep decides 'dropped' from a lookup it awaited, and a
// concurrent finaliser (tx-recorder's markConfirmed/markFailed) may have
// written the row's final status meanwhile; that status stands. The core
// reads and writes the row in one transaction, so nothing lands between.
function markDropped(id) {
  return recorded(() => vaultBackend.payments.markDropped(id));
}

/**
 * Filtered, paginated read. Filters are AND-combined. All optional; any
 * other key is dropped, and `limit` is clamped to 500.
 *
 * @param {object} filters
 * @param {string} [filters.kind]
 * @param {number} [filters.chainId]
 * @param {string} [filters.origin]
 * @param {string} [filters.status]
 * @param {number} [filters.limit=50]
 * @param {number} [filters.offset=0]
 * @param {'chrome'|null} [caller] — `'chrome'` for a read relayed from IPC
 */
function getRecent(filters = {}, caller = null) {
  return vaultBackend.payments.getRecent(filters, caller);
}

function getById(id, caller = null) {
  return vaultBackend.payments.getById(id, caller);
}

function getCount(filters = {}, caller = null) {
  return vaultBackend.payments.getCount(filters, caller);
}

function clear(caller = null) {
  return written(
    () => vaultBackend.payments.clear(caller),
    (removed) => {
      if (removed > 0) broadcastTxRecorded(null);
    }
  );
}

// === Appends that must land once =========================================

// How many records may wait to land before x402 signs no new payment
// (historyBacklogFull), how many times each is sent, and how long one kept
// while the core is up (refused by a busy database, or failed after the
// core's restart was already done) waits before it is tried again without a
// restart.
const KEPT_LIMIT = 100;
const KEPT_ATTEMPTS = 3;
const KEPT_RETRY_MS = 60 * 1000;
// The most recent rows a kept append's read-back searches, newest first,
// under its own kind, chain, origin and status (the core's page cap).
const KEPT_WINDOW = 500;
// Appends not yet known to have landed, in order: `{ entry, unknown,
// attempts }`. In memory only: a crash before one lands loses it, as the
// module before PRF-6(c) lost a row whose synchronous write a crash beat.
const kept = [];
// Every record appendOnce took that hasn't landed, been found, or been
// given up: those kept, and those on their way to the core. None is ever
// dropped to make room.
const unlanded = new Set();
// The slots x402 reserved for payments it is signing, or has signed and not
// yet recorded (reserveHistorySlot): each becomes a record (appendOnce) or
// is released.
const reserved = new Set();
// The core client attachCore follows, and its starts' work, one at a time.
let attachedClient = null;
let settling = Promise.resolve();

/**
 * An append whose row must land exactly once though its caller doesn't wait
 * for it: an x402 payment's (x402/intercept.js), whose money has already
 * left, and whose row is the only record of it, with the payment's reserved
 * slot (reserveHistorySlot), which becomes the record. Never dropped to make
 * room: x402 refuses to sign a new payment while KEPT_LIMIT records and
 * slots wait. The entry is stamped with
 * its `createdAt` now, so a later send writes the same row. Sent at once;
 * resolves with the record, or with null when the core didn't answer it,
 * and never rejects. A failure keeps the entry for the core's next start
 * (attachCore):
 *   - refused, or never sent (the core wrote nothing): it is sent again,
 *     up to KEPT_ATTEMPTS times in all (and KEPT_RETRY_MS later when the
 *     core is up, without waiting for a restart);
 *   - its answer lost (the core may have written it): the row is looked
 *     for first (keptRow), and sent again only if it isn't there, so it is
 *     never written twice.
 */
function appendOnce(entry, slot = null) {
  const createdAt = Number.isFinite(entry?.createdAt) ? entry.createdAt : Date.now();
  const item = { entry: { ...entry, createdAt }, unknown: false, attempts: 0 };
  unlanded.add(item);
  // The payment's reserved slot becomes this record, in the same turn.
  releaseHistorySlot(slot);
  return sendKept(item);
}

/**
 * A slot for one payment's record, reserved before x402 asks the core to
 * sign it (x402/sign-flow.js), or null when KEPT_LIMIT records and slots
 * already wait: the payment is then refused, so no money leaves without a
 * place in the history, and no waiting record is ever dropped to make room.
 * Taken in one turn, so payments signed at once can't all find room. The
 * slot rides with the signed payment and becomes its record (appendOnce),
 * or is released (releaseHistorySlot) wherever the payment ends without
 * one.
 */
function reserveHistorySlot() {
  if (unlanded.size + reserved.size >= KEPT_LIMIT) return null;
  const slot = Object.freeze({ slot: reserved.size + unlanded.size });
  reserved.add(slot);
  return slot;
}

/** A reserved slot given back (again, or null: nothing). */
function releaseHistorySlot(slot) {
  if (slot) reserved.delete(slot);
}

/** How many records wait to land, and how many slots are reserved. */
function historyBacklog() {
  return { unlanded: unlanded.size, reserved: reserved.size, limit: KEPT_LIMIT };
}

async function sendKept(item) {
  item.attempts += 1;
  try {
    const row = await append(item.entry);
    unlanded.delete(item);
    return row;
  } catch (err) {
    item.unknown = item.unknown || outcomeUnknown(err);
    if (item.attempts < KEPT_ATTEMPTS) {
      keep(item);
      log.warn(
        `[PaymentHistory] a payment's row was not written (${err.code || err.message}); ` +
          `kept for the identity core's next start`
      );
    } else {
      unlanded.delete(item);
      log.error(
        `[PaymentHistory] a payment's row was not written after ${item.attempts} attempts ` +
          `(${err.code || err.message}); given up`
      );
    }
    return null;
  }
}

let keptTimer = null;
function keep(item) {
  kept.push(item);
  if (attachedClient?.state === 'ready' && !keptTimer) {
    keptTimer = setTimeout(() => {
      keptTimer = null;
      settling = settling.then(() =>
        settleKept().catch((err) => {
          log.warn(`[PaymentHistory] kept payments not settled: ${err.message}`);
        })
      );
    }, KEPT_RETRY_MS);
    keptTimer.unref?.();
  }
}

/**
 * Whether `row` is the one `entry` writes. An x402 payment names itself:
 * its authorization's nonce (EIP-3009's random 32 bytes, or Permit2's), in
 * the row's metadata. Without one, the fields that set it apart: the time
 * it was stamped with, its amount, URL, addresses, asset and settlement
 * transaction.
 */
function isKeptRow(row, entry) {
  const nonce = entry.metadata?.authorizationNonce;
  if (nonce) return row.metadata?.authorizationNonce === nonce;
  const same = (key) => (row[key] ?? null) === (entry[key] ?? null);
  return (
    row.createdAt === entry.createdAt &&
    ['amount', 'url', 'fromAddress', 'toAddress', 'asset', 'txHash'].every(same)
  );
}

/** The row a kept append wrote, read back, or null. */
async function keptRow(entry) {
  const filters = { kind: entry.kind, limit: KEPT_WINDOW };
  if (entry.chainId !== undefined) filters.chainId = entry.chainId;
  if (entry.origin) filters.origin = entry.origin;
  if (entry.status) filters.status = entry.status;
  const rows = await getRecent(filters);
  return rows.find((row) => isKeptRow(row, entry)) ?? null;
}

// The kept appends, settled one at a time: those whose answer was lost are
// read back first. One whose read fails waits for the next start.
async function settleKept() {
  for (const item of kept.splice(0)) {
    if (item.unknown) {
      let row;
      try {
        row = await keptRow(item.entry);
      } catch (err) {
        log.warn(`[PaymentHistory] a kept payment's row could not be looked for: ${err.message}`);
        keep(item);
        continue;
      }
      if (row) {
        // Written before its answer was lost: told now, never written again.
        unlanded.delete(item);
        broadcastTxRecorded(row);
        continue;
      }
      item.unknown = false;
    }
    await sendKept(item);
  }
}

// After writes whose answer was lost: the history read again (it answers
// once the core serves it), then every listener told to read it again.
async function settleReread() {
  if (!rereadOwed) return;
  rereadOwed = false;
  try {
    await getCount({});
  } catch (err) {
    rereadOwed = true;
    throw err;
  }
  broadcastTxRecorded(null);
}

/**
 * Re-poll every `pending` row's status. For each row, the caller-supplied
 * `getStatusFn(txHash, chainId, sent)` is awaited; if it returns a final status
 * the row is updated. Anything that throws or stays pending is left alone.
 * `sent` is `{ from, nonce }` as the row's metadata recorded them at send
 * time (tx-recorder), so a transaction whose nonce another transaction has
 * since taken resolves as 'dropped' instead of staying pending forever.
 *
 * Exposed as an explicit function (not auto-run) so callers can trigger it
 * once the provider stack is up: at each core start (attachCore, from
 * `index.js`).
 *
 * A call while a sweep is running cannot just join it: that sweep may have
 * read (or already checked) a row before the chain moved, e.g. before the
 * re-send that leaves the row 'dropped' was mined. So it queues one more
 * sweep to start once the running one ends, and resolves with that. Every
 * call made before the queued sweep starts shares it (including one landing
 * after the running sweep settled but before the queued one began), so a
 * burst of settled transactions still polls each row at most twice.
 *
 * 'dropped' is final, but one sighting of it is not proof: the nonce and
 * receipt reads behind it can be answered by different endpoints of one
 * source (quorum members, Direct's URL list), one of them lagging, which
 * reads a just-mined transaction as dropped. So the first sighting is only
 * recorded on the row (`txDroppedSeenAt`) and the row stays pending; a sweep
 * at least DROPPED_CONFIRM_MS later that sees it again marks it dropped. Any
 * 'pending' answer in between clears the sighting. When a sighting is
 * waiting, a confirming sweep is scheduled, so it does not wait for the next
 * transaction or boot.
 *
 * @param {(txHash:string, chainId:number, sent:{from?:string, nonce?:number}) => Promise<{status:string, gasUsed?:string, gasPrice?:string}>} getStatusFn
 * @returns {Promise<{ resolved:number, stillPending:number, errors:number }>}
 */
// Long enough for a lagging endpoint to catch up (10 mainnet blocks,
// 24 on Gnosis); short enough that a dropped row resolves in the same session.
const DROPPED_CONFIRM_MS = 2 * 60 * 1000;
let repollInFlight = null;
let repollQueued = null;
let confirmTimer = null;
function repollPending(getStatusFn) {
  // Not started yet, so it reads every row after this call: join it.
  if (repollQueued) return repollQueued;
  if (!repollInFlight) return startRepoll(getStatusFn);
  repollQueued = repollInFlight
    .catch(() => { /* the caller of that sweep sees its error */ })
    .then(() => {
      repollQueued = null;
      return startRepoll(getStatusFn);
    });
  return repollQueued;
}

function startRepoll(getStatusFn) {
  const sweep = repollPendingOnce(getStatusFn).finally(() => {
    if (repollInFlight === sweep) repollInFlight = null;
  });
  repollInFlight = sweep;
  return sweep;
}

function scheduleDroppedConfirm(getStatusFn, delayMs) {
  if (confirmTimer) return;
  confirmTimer = setTimeout(() => {
    confirmTimer = null;
    repollPending(getStatusFn).catch((err) => {
      log.warn(`[PaymentHistory] dropped-confirm sweep failed: ${err.message}`);
    });
  }, Math.max(1000, delayMs));
  confirmTimer.unref?.();
}

function rowMetadata(row) {
  try { return row.metadata ? JSON.parse(row.metadata) : null; } catch { return null; }
}

// The core re-reads the row rather than taking the sweep's snapshot: the
// status lookup awaited in between, and a concurrent finaliser
// (tx-recorder's markFailed with its failureReason) may have written the
// row meanwhile. A row no longer pending is left alone. Its answer doesn't
// say whether it wrote, and the sighting is the sweep's own bookkeeping,
// which no page shows: nothing is broadcast.
function setDroppedSeenAt(row, seenAt) {
  return vaultBackend.payments.setDroppedSeen(row.id, seenAt);
}

function sentFields(row) {
  const metadata = rowMetadata(row);
  return {
    from: typeof metadata?.txFrom === 'string' ? metadata.txFrom : undefined,
    nonce: Number.isSafeInteger(metadata?.txNonce) ? metadata.txNonce : undefined,
    sweep: true,
  };
}

// The rows come as SQLite holds them (`payments.pending`): snake_case
// columns, `metadata` its JSON text.
async function repollPendingOnce(getStatusFn) {
  const pending = await vaultBackend.payments.pending();
  let resolved = 0;
  let stillPending = 0;
  let errors = 0;
  let nextConfirmIn = null;

  for (const row of pending) {
    if (!row.tx_hash) { stillPending++; continue; }
    try {
      const r = await getStatusFn(row.tx_hash, row.chain_id, sentFields(row));
      const seenAt = rowMetadata(row)?.txDroppedSeenAt;
      if (r?.status === STATUSES.DROPPED) {
        const now = Date.now();
        if (Number.isFinite(seenAt) && now - seenAt >= DROPPED_CONFIRM_MS) {
          if (await markDropped(row.id)) resolved++;
          continue;
        }
        if (!Number.isFinite(seenAt) || seenAt > now) await setDroppedSeenAt(row, now);
        const waitMs = Number.isFinite(seenAt) && seenAt <= now
          ? DROPPED_CONFIRM_MS - (now - seenAt)
          : DROPPED_CONFIRM_MS;
        nextConfirmIn = nextConfirmIn === null ? waitMs : Math.min(nextConfirmIn, waitMs);
        stillPending++;
      } else if (r?.status === STATUSES.CONFIRMED) {
        await markConfirmed(row.id, { gasUsed: r.gasUsed, gasPrice: r.gasPrice ?? r.effectiveGasPrice });
        resolved++;
      } else if (r?.status === STATUSES.FAILED) {
        await markFailed(row.id, { gasUsed: r.gasUsed, gasPrice: r.gasPrice ?? r.effectiveGasPrice });
        resolved++;
      } else {
        // Not seen dropped this time: a later sighting starts over.
        if (r?.status === STATUSES.PENDING && seenAt !== undefined) await setDroppedSeenAt(row, null);
        stillPending++;
      }
    } catch (err) {
      log.warn(`[PaymentHistory] repoll failed for row ${row.id}: ${err.message}`);
      errors++;
    }
  }

  if (resolved > 0) log.info(`[PaymentHistory] repoll resolved ${resolved} pending row(s)`);
  if (nextConfirmIn !== null) scheduleDroppedConfirm(getStatusFn, nextConfirmIn);
  return { resolved, stillPending, errors };
}

/**
 * index.js: the history's work at each start of the core `client` (main's,
 * by default), in turn, and at once too if it is up already:
 *   - the kept appends (appendOnce) settled: each written once;
 *   - after a write whose answer was lost, the history read again and
 *     every listener told to read it again (`{ id: null }`);
 *   - the repoll: rows a previous run left pending resolve once the core is
 *     up, and a mark a core restart lost is made good (design 0013's
 *     coordinator call G9: never resent blindly; re-read).
 */
function attachCore(getStatusFn, client) {
  const core = client === undefined ? require('./core/core-process').getCoreClient() : client;
  if (!core || typeof core.on !== 'function' || core === attachedClient) return;
  attachedClient = core;
  const started = () => {
    settling = settling.then(() => afterStart(getStatusFn));
  };
  core.on('ready', started);
  if (core.state === 'ready') started();
}

async function afterStart(getStatusFn) {
  await settleKept().catch((err) => {
    log.warn(`[PaymentHistory] kept payments not settled: ${err.message}`);
  });
  await settleReread().catch((err) => {
    log.warn(`[PaymentHistory] the history could not be read again: ${err.message}`);
  });
  repollPending(getStatusFn).catch((err) => {
    log.warn(`[PaymentHistory] repoll failed: ${err.message}`);
  });
}

// === IPC =================================================================

// The chrome's and the internal pages' requests, relayed to the core as the
// chrome's (design 0013's coordinator call G23).
function registerPaymentHistoryIpc() {
  ipcMain.handle(IPC.PAYMENTS_GET_RECENT, async (_event, filters) => {
    try {
      return { success: true, payments: await getRecent(filters, 'chrome') };
    } catch (err) {
      log.error('[PaymentHistory] get-recent failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.PAYMENTS_GET_BY_ID, async (_event, id) => {
    if (!Number.isInteger(id)) {
      return { success: false, error: 'id must be an integer' };
    }
    try {
      return { success: true, payment: await getById(id, 'chrome') };
    } catch (err) {
      log.error('[PaymentHistory] get-by-id failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.PAYMENTS_GET_COUNT, async (_event, filters) => {
    try {
      return { success: true, count: await getCount(filters, 'chrome') };
    } catch (err) {
      log.error('[PaymentHistory] get-count failed:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC.PAYMENTS_CLEAR, async () => {
    try {
      return { success: true, removed: await clear('chrome') };
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
  append,
  update,
  markConfirmed,
  markFailed,
  markDropped,
  getRecent,
  getById,
  getCount,
  clear,
  appendOnce,
  reserveHistorySlot,
  releaseHistorySlot,
  historyBacklog,
  repollPending,
  attachCore,
  DROPPED_CONFIRM_MS,
  registerPaymentHistoryIpc,
};
