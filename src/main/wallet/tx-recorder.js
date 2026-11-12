/**
 * History writes are best-effort: a store-side failure logs and lets the
 * tx through (broadcast already returned). Confirmation is polled in the
 * background; if the app exits before resolution, payment-history's
 * repollPending picks the row up on next boot.
 *
 * A phone payment whose transaction wasn't visible at the answer is
 * written `unverified`, with the fields it was confirmed for in the row's
 * `metadata.phoneCheck` (phone-payments.js), and is not polled for a
 * receipt: a receipt says the reported hash was mined, not that it is the
 * payment confirmed. Its fields are checked once the transaction is
 * visible, this run or the next (resumePhoneChecks): the same, it goes on
 * as `pending`, and the receipt poll follows; different, it is
 * `wrong-transaction`, for good; not seen within a day of the answer, or
 * under a clock set back, `unknown`. If its row can't be written, the
 * reply says `phoneCheck: 'unknown'` at once.
 */

const log = require('../logger');
const {
  signAndSendTransaction,
  resendIntent,
  replaceIntent,
  waitForTransaction,
} = require('./transaction-service');
const { getIntentStore } = require('./intent-store');
const phonePayments = require('./phone-payments');
const paymentHistory = require('../payment-history');
const { KINDS, STATUSES } = paymentHistory;

// JSON-RPC eth_sendTransaction.value is hex-encoded ("0x123abc"); the
// payment-history schema stores atomic units as a decimal digit string.
// BigInt accepts both shapes; toString(10) normalises.
function toAtomicDecimal(value) {
  if (value === undefined || value === null || value === '') return '0';
  return BigInt(value).toString(10);
}

function pollReceipt(rowId, hash, chainId) {
  waitForTransaction(hash, chainId)
    .then((receipt) => {
      const gas = { gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice };
      try {
        if (receipt.status === STATUSES.CONFIRMED) {
          paymentHistory.markConfirmed(rowId, gas);
        } else {
          paymentHistory.markFailed(rowId, gas);
        }
      } catch (err) {
        // The store throws when the DB closes mid-poll (app quitting). Log
        // and drop; repollPending on next boot resolves the row from chain.
        log.warn(`[TxRecorder] post-receipt write failed for row ${rowId}: ${err.message}`);
      }
    })
    .catch((err) => {
      // A timeout doesn't mean the tx failed; leave the row pending and
      // let repollPending sort it out on next boot.
      log.warn(`[TxRecorder] waitForTransaction failed for row ${rowId}: ${err.message}`);
    });
  // Main (#749) sweeps every pending row once a receipt settles, for the
  // 'dropped' rows a re-send on the same nonce leaves. A re-send here is
  // the same intent's row, which the finality tracker labels (taken among
  // them), so there is none to find, and the sweep stays at boot.
}

// The signing account and nonce, so repollPending can tell a transaction
// that will never be mined (its nonce taken by another) from one still
// waiting. Phone wallets pick their own nonce and report none. Not an
// intent's: the finality tracker labels its row from verified evidence at
// the finalized block, whichever of its hashes was mined, where a sighting
// of one hash's nonce taken would call a replaced payment dropped.
function withSentFields(metadata, response) {
  if (response.intentId) return metadata;
  if (typeof response.from !== 'string' || !Number.isSafeInteger(response.nonce)) {
    return metadata;
  }
  return { ...(metadata || {}), txFrom: response.from, txNonce: response.nonce };
}

// History rows this run wrote, by intent id: any later reply for the
// intent (a resend's, or its original send's arriving after a resend's)
// updates its row instead of adding one.
const rowsByIntent = new Map();
// How far back a resend after a restart looks for its intent's row.
const ROW_LOOKBACK = 500;

function findIntentRow(response, kind) {
  const { intentId } = response;
  if (rowsByIntent.has(intentId)) return paymentHistory.getById(rowsByIntent.get(intentId));
  // Only a resend or a replacement can follow a row written by an earlier run.
  if (!response.resent && !response.replaced) return null;
  return (
    paymentHistory
      .getRecent({ chainId: response.chainId, kind, limit: ROW_LOOKBACK })
      .find((row) => row.metadata?.intentId === intentId) ?? null
  );
}

// Intent sends carry their intent and its outcome in the row's metadata.
function metadataFor(metadata, response) {
  if (!response.intentId) return metadata;
  return { ...metadata, intentId: response.intentId, outcome: response.outcome };
}

/**
 * Send, then write the payment-history row: one row per intent. Sending
 * an intent again (a Safe "Try again", for instance) updates the row its
 * first send wrote, or writes it if that send failed before it could; so
 * does a first send whose reply comes after a resend's.
 *
 * @param {object} params       Same shape as signAndSendTransaction.
 * @param {import('./signers').Signer} signer
 * @param {object} context
 * @param {string} context.kind         paymentHistory.KINDS member
 * @param {string} [context.origin]     normalised origin (dapp sends only)
 * @param {string} [context.fromAddress] human-visible sender; defaults to the
 *                                      signer's address (which is the *executor*
 *                                      for Safe txs, not the paying account —
 *                                      pass the safe address explicitly there)
 * @param {string} [context.asset]      ERC-20 contract address (null = native)
 * @param {string} [context.amount]     atomic units; defaults to params.value
 *                                      (which is 0 for ERC-20 transfers — pass
 *                                      this explicitly when you have the human
 *                                      amount on hand)
 * @param {string} [context.toAddress]  human-visible recipient; defaults to
 *                                      params.to (which is the *contract*
 *                                      address for ERC-20 transfers, not the
 *                                      recipient — pass this explicitly when
 *                                      you have the real recipient)
 * @param {object} [context.metadata]   free-form per-kind extras
 * @param {object} [options]
 * @param {string} [options.intentKey]  names the intent across retries
 *                                      (signAndSendTransaction). Main's own
 *                                      callers only: never read from
 *                                      `context`, which a renderer may fill.
 * @param {number} [options.walletIndex] the signing account's wallet index,
 *                                      kept with the intent so a replacement
 *                                      can find its signer. Main's own
 *                                      callers only, like `intentKey`.
 * @param {() => void} [options.onCommitted] see signAndSendTransaction
 * @param {Function} [options.guardCommit] see signAndSendTransaction. Main's
 *                                      own callers only, like `intentKey`.
 */
async function signAndRecord(
  params,
  signer,
  context,
  { intentKey = null, walletIndex = null, onCommitted = null, guardCommit = null } = {}
) {
  const response = await signAndSendTransaction(params, signer, {
    intentKey,
    context: { kind: context.kind, origin: context.origin, walletIndex },
    onCommitted,
    guardCommit,
  });
  return recordSend(response, {
    kind: context.kind,
    chainId: params.chainId,
    fromAddress: context.fromAddress ?? response.from,
    toAddress: context.toAddress ?? params.to,
    asset: context.asset ?? null,
    amount: toAtomicDecimal(context.amount ?? params.value),
    origin: context.origin ?? null,
    metadata: context.metadata,
  });
}

// A phone payment not yet checked keeps what it was confirmed for.
function withPhoneRecord(metadata, phoneRecord) {
  if (!phoneRecord) return metadata;
  return { ...(metadata || {}), phoneCheck: { state: 'unverified', ...phoneRecord } };
}

// One payment-history row per intent: write it, or update the row an
// earlier reply of the same intent wrote, then poll for the receipt. A
// phone payment not yet checked is written `unverified` and watched
// instead (watchPhonePayment).
function recordSend(response, row) {
  const { phoneRecord, ...reply } = response;
  const unverified = reply.phoneCheck === 'unverified';
  let written;
  let existing;
  try {
    existing = reply.intentId ? findIntentRow(reply, row.kind) : null;
    if (existing) {
      written =
        paymentHistory.update(existing.id, {
          txHash: reply.hash,
          metadata: withSentFields(metadataFor(existing.metadata, reply), reply),
        }) ?? existing;
    } else {
      written = paymentHistory.append({
        ...row,
        txHash: reply.hash,
        ...(unverified ? { status: STATUSES.UNVERIFIED } : {}),
        metadata: withPhoneRecord(
          withSentFields(metadataFor(row.metadata, reply), reply),
          unverified ? phoneRecord : null
        ),
      });
    }
    if (reply.intentId) rowsByIntent.set(reply.intentId, written.id);
  } catch (err) {
    log.error('[TxRecorder] failed to record pending row:', err.message);
    // An unverified phone payment with no record can't be checked later:
    // its outcome is unknown at once (design 0012, "A failed save").
    return {
      ...reply,
      ...(unverified ? { phoneCheck: 'unknown' } : {}),
      recorded: false,
      recordError: err.message,
    };
  }

  if (unverified) {
    watchPhonePayment(written.id);
  } else if (!existing || existing.status === STATUSES.PENDING) {
    // A row already settled by its first send's poll needs no second one.
    pollReceipt(written.id, reply.hash, row.chainId);
  }
  return { ...reply, recorded: true, paymentId: written.id };
}

// The unverified phone payments this run watches, by row id: their next
// recheck's timer.
const phoneWatches = new Map();

// A phone check's end, by its outcome: the row's status from then on.
const PHONE_CHECK_STATUS = Object.freeze({
  verified: STATUSES.PENDING,
  mismatch: STATUSES.WRONG_TRANSACTION,
  unknown: STATUSES.UNKNOWN,
});

/**
 * Check an unverified phone payment's row now, or after `delay` ms, and
 * keep checking it until it ends (phone-payments.js): after 5 s, then at
 * doubling intervals up to every 10 minutes, and never past a day from its
 * answer. Its age comes first, before any read. Once per row per run.
 *
 * @param {number} rowId
 * @param {number} [delay] - ms before the first check (default 5 s)
 */
function watchPhonePayment(rowId, delay = phonePayments.FIRST_RECHECK_MS) {
  if (phoneWatches.has(rowId)) return;
  const schedule = (wait, previous) => {
    const timer = setTimeout(() => {
      checkPhonePayment(rowId)
        .then((record) => {
          if (!record) {
            phoneWatches.delete(rowId);
            return;
          }
          const next = phonePayments.nextRecheckIn(record, previous, Date.now());
          schedule(next, next);
        })
        .catch((err) => {
          phoneWatches.delete(rowId);
          log.warn(`[TxRecorder] phone check failed for row ${rowId}: ${err.message}`);
        });
    }, wait);
    timer.unref?.();
    phoneWatches.set(rowId, timer);
  };
  schedule(delay, delay);
}

// The record of a row still unverified, or null.
function unverifiedRecord(row) {
  if (row?.status !== STATUSES.UNVERIFIED) return null;
  const record = row.metadata?.phoneCheck;
  return record && typeof record === 'object' ? record : null;
}

/**
 * One check of an unverified phone payment's row. Returns its record while
 * it still waits; null once it ended (verified, mismatch, unknown) or is no
 * longer unverified. A row whose record is unreadable ends unknown.
 */
async function checkPhonePayment(rowId) {
  const row = paymentHistory.getById(rowId);
  if (row?.status !== STATUSES.UNVERIFIED) return null;
  const record = unverifiedRecord(row);
  const result = record
    ? await phonePayments.recheck(row.txHash, record, row.chainId, Date.now())
    : { state: 'unknown' };
  if (result.state === 'unverified') {
    if (result.error)
      log.warn(`[TxRecorder] phone check lookup failed for row ${rowId}: ${result.error}`);
    return record;
  }
  // Re-read: the lookup awaited, and the row may have been removed.
  const current = paymentHistory.getById(rowId);
  if (current?.status !== STATUSES.UNVERIFIED) return null;
  const phoneCheck = {
    ...(current.metadata?.phoneCheck || {}),
    state: result.state,
    checkedAt: Date.now(),
    ...(result.state === 'mismatch' ? { code: result.code, observed: result.observed } : {}),
  };
  paymentHistory.update(rowId, {
    status: PHONE_CHECK_STATUS[result.state],
    metadata: { ...(current.metadata || {}), phoneCheck },
  });
  if (result.state === 'mismatch') {
    log.warn(
      `[TxRecorder] phone payment row ${rowId} is not the transaction confirmed (${result.code})`
    );
  }
  if (result.state === 'verified') pollReceipt(rowId, current.txHash, current.chainId);
  return null;
}

// One page of unverified rows a start reads at a time: the history store's
// own page cap (payment-history.js MAX_LIMIT).
const PHONE_PAGE = 500;

/**
 * At a start: check every phone payment an earlier run left unverified,
 * now (its age first), then as watchPhonePayment does. It pages through
 * all of them, not just the newest page, so none is left unverified past
 * its 24 hours. The pages are read before any check runs (each check is
 * scheduled, not run inline), so a row changing state can't shift the
 * offsets. Best-effort, like every history read: returns how many it
 * watches.
 */
function resumePhoneChecks() {
  const ids = [];
  try {
    for (let offset = 0; ; offset += PHONE_PAGE) {
      const page = paymentHistory.getRecent({
        status: STATUSES.UNVERIFIED,
        limit: PHONE_PAGE,
        offset,
      });
      for (const row of page) ids.push(row.id);
      if (page.length < PHONE_PAGE) break;
    }
  } catch (err) {
    log.warn(`[TxRecorder] could not read unverified phone payments: ${err.message}`);
    if (ids.length === 0) return 0;
  }
  for (const id of new Set(ids)) watchPhonePayment(id, 0);
  return new Set(ids).size;
}

const ERC20_TRANSFER = '0xa9059cbb';

// What a held intent pays, for a history row its first send never wrote:
// an ERC-20 transfer's token, recipient and amount, or the native value.
function paymentOf(fields) {
  const data = String(fields?.data ?? '').toLowerCase();
  if (data.startsWith(ERC20_TRANSFER) && /^0x[0-9a-f]{136}/.test(data)) {
    return {
      asset: fields.to,
      toAddress: `0x${data.slice(34, 74)}`,
      amount: BigInt(`0x${data.slice(74, 138)}`).toString(10),
    };
  }
  return { asset: null, toAddress: fields?.to ?? null, amount: toAtomicDecimal(fields?.value) };
}

/**
 * Send a held intent's bytes again (resendIntent) and keep its history row:
 * update the one its earlier send wrote, or write it now if that send failed
 * before it could. Throws as resendIntent does.
 *
 * @param {string} intentId
 * @param {{ hash?: string }} [options] as resendIntent's
 */
async function resendAndRecord(intentId, options = {}) {
  const response = await resendIntent(intentId, options);
  const intent = getIntentStore().get(intentId);
  return recordSend(response, {
    kind: intent?.context?.kind ?? KINDS.WALLET_SEND,
    chainId: response.chainId,
    fromAddress: response.from,
    ...paymentOf(intent?.fields),
    origin: intent?.context?.origin ?? null,
    metadata: undefined,
  });
}

/**
 * Replace a held intent at its nonce with higher fees (replaceIntent) and
 * keep its history row, which then names the replacement's hash. Throws as
 * replaceIntent does.
 *
 * @param {string} intentId
 * @param {Object} fees
 * @param {import('./signers').Signer} signer
 */
async function replaceAndRecord(intentId, fees, signer) {
  const response = await replaceIntent(intentId, fees, signer);
  const intent = getIntentStore().get(intentId);
  return recordSend(response, {
    kind: intent?.context?.kind ?? KINDS.WALLET_SEND,
    chainId: response.chainId,
    fromAddress: response.from,
    ...paymentOf(intent?.fields),
    origin: intent?.context?.origin ?? null,
    metadata: undefined,
  });
}

// A settled intent's history status, by its label at the finalized block,
// and a closed one's: closed by hand, whether it paid unconfirmed.
const SETTLED_STATUS = Object.freeze({
  paid: STATUSES.CONFIRMED,
  failed: STATUSES.FAILED,
  taken: STATUSES.TAKEN,
  closed: STATUSES.UNCONFIRMED,
});

// The history row of an intent, by its id: this run's, or an earlier one's.
function rowOfIntent(intent) {
  if (rowsByIntent.has(intent.intentId)) {
    const row = paymentHistory.getById(rowsByIntent.get(intent.intentId));
    if (row) return row;
  }
  return (
    paymentHistory
      .getRecent({ chainId: intent.chainId, limit: ROW_LOOKBACK })
      .find((row) => row.metadata?.intentId === intent.intentId) ?? null
  );
}

/**
 * An intent's label at the finalized block, in its history row: paid as
 * `confirmed`, failed as `failed`, taken as `taken`, naming the included
 * transaction, with `metadata.finality`; and an intent closed by hand
 * (label `closed`, at the finalized block where its nonce was seen used)
 * as `unconfirmed`. An intent with no row (its send failed before one was
 * written, though its bytes went out) gets one now, so a payment that
 * happened is never missing from the history. Best-effort, like every
 * history write: returns the row, or null.
 *
 * @param {object} intent - the intent's view, read before it settled
 * @param {{label: 'paid'|'failed'|'taken'|'closed', hash: string|null, block: number}} settlement
 */
function recordSettlement(intent, { label, hash, block }) {
  const status = SETTLED_STATUS[label];
  if (!status) return null;
  const finality = { label, block };
  try {
    const row = rowOfIntent(intent);
    if (row) {
      return paymentHistory.update(row.id, {
        status,
        txHash: hash ?? undefined,
        metadata: { ...row.metadata, intentId: intent.intentId, finality },
      });
    }
    const written = paymentHistory.append({
      kind: Object.values(KINDS).includes(intent.context?.kind)
        ? intent.context.kind
        : KINDS.WALLET_SEND,
      chainId: intent.chainId,
      txHash: hash ?? intent.hashes[intent.hashes.length - 1]?.hash ?? null,
      fromAddress: intent.sender,
      ...paymentOf(intent.fields),
      origin: intent.context?.origin ?? null,
      status,
      metadata: { intentId: intent.intentId, finality },
    });
    rowsByIntent.set(intent.intentId, written.id);
    return written;
  } catch (err) {
    log.warn(`[TxRecorder] could not record intent ${intent.intentId} as ${label}: ${err.message}`);
    return null;
  }
}

module.exports = {
  signAndRecord,
  resendAndRecord,
  replaceAndRecord,
  recordSettlement,
  resumePhoneChecks,
  KINDS,
};
