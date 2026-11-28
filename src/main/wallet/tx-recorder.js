/**
 * History writes are best-effort: a store-side failure logs and lets the
 * tx through (broadcast already returned). Confirmation is polled in the
 * background; if the app exits before resolution, payment-history's
 * repollPending picks the row up at the core's next start. The history is
 * the identity core's (design 0013, PRF-6(c)), so every read and write here
 * awaits its answer; main's read-then-write steps on a row run one at a
 * time (`serialized`, by row, intent and phone job).
 *
 * A phone payment whose transaction wasn't visible at the answer is
 * written `unverified`, with the identity core's job id in the row's
 * `metadata.phoneCheck` (design 0012, PHN-2), and is not polled for a
 * receipt: a receipt says the reported hash was mined, not that it is the
 * payment confirmed. The core checks it once the transaction is visible,
 * this run or the next, and says so with `phone.checked` for the job: the
 * same, it goes on as `pending`, and the receipt poll follows; different,
 * it is `wrong-transaction` (another transaction the phone sent), for good;
 * not seen within a day of the answer, or under a clock set back,
 * `unknown`. One whose record the core couldn't save is `unknown` at once,
 * and a later `phone.checked` for it still counts. A `phone.lost` (the
 * core's file of records found unreadable) ends every row still waiting
 * as `unknown`, and so does a row older than the core's day by a margin,
 * which no core can still report. If its row can't be written, the reply
 * says `phoneCheck: 'unknown'` at once.
 */

const log = require('../logger');
const {
  signAndSendTransaction,
  resendIntent,
  replaceIntent,
  replaceIntentWith,
  waitForTransaction,
} = require('./transaction-service');
const { getIntentStore } = require('./intent-store');
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
    .then(async (receipt) => {
      const gas = { gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice };
      try {
        if (receipt.status === STATUSES.CONFIRMED) {
          await paymentHistory.markConfirmed(rowId, gas);
        } else {
          await paymentHistory.markFailed(rowId, gas);
        }
      } catch (err) {
        // The core couldn't write it (stopped as the app quits, or
        // restarted). Log and drop; repollPending at the core's next start
        // resolves the row from chain.
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

// Main's steps that read a history row (or find it) and write it back with
// what they read, one at a time per key: the core answers each request in
// turn, so two such steps on one row could otherwise interleave, and the
// later write would drop what the earlier one added to the row's metadata.
// (They ran in one synchronous turn each while main kept the database.)
// Keys: `intent:<id>` around finding (or writing) an intent's row, so its
// replies and its settlement write one row between them; `row:<id>` around
// each read-then-write of a row, whatever flow it is from; `job:<id>`
// around a phone job's check. A step takes an intent's key before a row's,
// never the other way, and steps on other keys go on meanwhile: a scan of
// many rows holds each row's key only for its own write, never a new
// send's first append.
const queues = new Map();
function serialized(key, task) {
  const run = (queues.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run.then(
    () => {},
    () => {}
  );
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

// The row `rowId` read afresh and written with `change(row)` (a patch, or
// null to leave it), under the row's key. Resolves with the record written,
// or null.
function rewriteRow(rowId, change) {
  return serialized(`row:${rowId}`, async () => {
    const row = await paymentHistory.getById(rowId);
    const patch = row ? change(row) : null;
    return patch ? paymentHistory.update(rowId, patch) : null;
  });
}

async function findIntentRow(response, kind) {
  const { intentId } = response;
  if (rowsByIntent.has(intentId)) return paymentHistory.getById(rowsByIntent.get(intentId));
  // Only a resend or a replacement can follow a row written by an earlier run.
  if (!response.resent && !response.replaced) return null;
  return (
    (await paymentHistory.getRecent({ chainId: response.chainId, kind, limit: ROW_LOOKBACK }))
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

// A phone payment the core hasn't verified keeps its job, for the core's
// `phone.checked`: `unverified`, or `unknown` when the core couldn't save
// its record.
function withPhoneRecord(metadata, state, phoneRecord) {
  if (!phoneRecord) return metadata;
  return { ...(metadata || {}), phoneCheck: { state, ...phoneRecord } };
}

// One payment-history row per intent: write it, or update the row an
// earlier reply of the same intent wrote, then poll for the receipt. A
// phone payment not yet checked is written `unverified` and watched
// instead, for the core's `phone.checked` (phoneChecked).
function recordSend(response, row) {
  // A send that isn't an intent's writes a new row, which nothing else
  // reads first.
  if (!response.intentId) return writeSendRow(response, row);
  return serialized(`intent:${response.intentId}`, () => writeSendRow(response, row));
}

async function writeSendRow(response, row) {
  const { phoneRecord, ...reply } = response;
  const unverified = reply.phoneCheck === 'unverified';
  // The core couldn't save its record, and still checks it in memory.
  const unsaved = reply.phoneCheck === 'unknown' && Boolean(phoneRecord);
  let written;
  let existing;
  try {
    existing = reply.intentId ? await findIntentRow(reply, row.kind) : null;
    if (existing) {
      written =
        (await rewriteRow(existing.id, (current) => ({
          txHash: reply.hash,
          metadata: withSentFields(metadataFor(current.metadata, reply), reply),
        }))) ?? existing;
    } else {
      written = await paymentHistory.append({
        ...row,
        txHash: reply.hash,
        ...(unverified ? { status: STATUSES.UNVERIFIED } : unsaved ? { status: STATUSES.UNKNOWN } : {}),
        metadata: withPhoneRecord(
          withSentFields(metadataFor(row.metadata, reply), reply),
          unverified ? 'unverified' : 'unknown',
          unverified || unsaved ? phoneRecord : null
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
    phoneDeadline(written.id, phoneRecord?.answeredAt);
  } else if (unsaved) {
    // Not polled: only the core's `phone.checked` can verify it.
  } else if (!existing || existing.status === STATUSES.PENDING) {
    // A row already settled by its first send's poll needs no second one.
    pollReceipt(written.id, reply.hash, row.chainId);
  }
  return { ...reply, recorded: true, paymentId: written.id };
}

// The core's day for a phone payment's check, from its answer (design
// 0012, "Unverified payments"), and the margin past it after which main
// ends a row the core no longer reports (its record lost with no
// `phone.lost`: removed, or never saved): `unknown`, never verified.
const PHONE_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000;
const PHONE_DEADLINE_MARGIN_MS = 10 * 60 * 1000;

// The rows this run waits on, by row id: their deadline's timer.
const phoneDeadlines = new Map();

// A phone check's end, by the core's outcome: the row's status from then on.
const PHONE_CHECK_STATUS = Object.freeze({
  verified: STATUSES.PENDING,
  mismatch: STATUSES.WRONG_TRANSACTION,
  unknown: STATUSES.UNKNOWN,
});

// The job a row waits on: an unverified row's, or an unsaved one's (the
// core still checks it in memory). Null for any other row.
function waitingJob(row) {
  const record = row?.metadata?.phoneCheck;
  if (!record || typeof record.job !== 'string') return null;
  if (row.status === STATUSES.UNVERIFIED) return record.job;
  if (row.status === STATUSES.UNKNOWN && record.state === 'unknown' && record.durable === false) return record.job;
  return null;
}

// One page of rows a scan reads at a time: the history store's own page
// cap (payment-history.js MAX_LIMIT).
const PHONE_PAGE = 500;

// Every row of `status`, page by page. Best-effort, like every history read.
async function rowsWithStatus(status) {
  const rows = [];
  for (let offset = 0; ; offset += PHONE_PAGE) {
    const page = await paymentHistory.getRecent({ status, limit: PHONE_PAGE, offset });
    rows.push(...page);
    if (page.length < PHONE_PAGE) break;
  }
  return rows;
}

// The row waiting on `job`, or null.
async function rowOfJob(job) {
  for (const status of [STATUSES.UNVERIFIED, STATUSES.UNKNOWN]) {
    const row = (await rowsWithStatus(status)).find((candidate) => waitingJob(candidate) === job);
    if (row) return row;
  }
  return null;
}

// A row's check, ended: its status and its record's state, with what the
// core said, if the row read afresh is still as `still(row)` wants it.
// Resolves with the record written, or null.
function endPhoneCheck(rowId, still, state, extra = {}) {
  return rewriteRow(rowId, (row) => {
    if (!still(row)) return null;
    clearTimeout(phoneDeadlines.get(rowId));
    phoneDeadlines.delete(rowId);
    return {
      status: PHONE_CHECK_STATUS[state],
      metadata: {
        ...(row.metadata || {}),
        phoneCheck: { ...(row.metadata?.phoneCheck || {}), state, checkedAt: Date.now(), ...extra },
      },
    };
  });
}

const isUnverified = (row) => row.status === STATUSES.UNVERIFIED;

/**
 * The core's `phone.checked { job, outcome, reason?, transaction?, rule? }`:
 * the row waiting on the job ends. `verified` goes on as `pending`, and the
 * receipt poll follows; `mismatch` is another transaction the phone sent,
 * kept with its fields (`observed`), never the confirmed one; `unknown`
 * stays unknown. `rule`: a flagged send's "Always allow", written by the
 * core only now that its transaction showed and matched. Resolves with
 * whether a row was updated.
 */
async function phoneChecked(data) {
  const { job, outcome } = data || {};
  if (typeof job !== 'string' || !Object.hasOwn(PHONE_CHECK_STATUS, outcome)) return false;
  if (data.rule && typeof data.rule === 'object') {
    if (data.rule.added === true) log.info('[TxRecorder] a phone send\'s contract rule was saved once its payment verified');
    else log.warn(`[TxRecorder] a phone send's contract rule was not saved: ${data.rule.reason || 'no reason'}`);
  }
  return serialized(`job:${job}`, () => endJobCheck(job, outcome, data));
}

async function endJobCheck(job, outcome, data) {
  const found = await rowOfJob(job);
  if (!found) return false;
  const waiting = (row) => waitingJob(row) === job;
  if (outcome === 'mismatch') {
    const ended = await endPhoneCheck(found.id, waiting, 'mismatch', {
      ...(typeof data.reason === 'string' ? { code: data.reason } : {}),
      ...(data.transaction && typeof data.transaction === 'object' ? { observed: data.transaction } : {}),
    });
    if (!ended) return false;
    log.warn(`[TxRecorder] phone payment row ${found.id} is another transaction than the one confirmed`);
    return true;
  }
  const ended = await endPhoneCheck(found.id, waiting, outcome);
  if (!ended) return false;
  if (outcome === 'verified') pollReceipt(ended.id, ended.txHash, ended.chainId);
  return true;
}

/**
 * The core's `phone.lost {}`: its file of records was unreadable, so no
 * row still unverified will be reported. Each ends `unknown`. Resolves with
 * how many.
 */
async function phoneLost() {
  let rows = [];
  try {
    rows = await rowsWithStatus(STATUSES.UNVERIFIED);
  } catch (err) {
    log.warn(`[TxRecorder] could not read unverified phone payments: ${err.message}`);
  }
  let ended = 0;
  for (const row of rows) {
    if (await endPhoneCheck(row.id, isUnverified, 'unknown', { lost: true })) ended += 1;
  }
  return ended;
}

// Ends the row `unknown` once the core's day and the margin have passed,
// if it is still unverified then.
function phoneDeadline(rowId, answeredAt) {
  if (phoneDeadlines.has(rowId) || !Number.isFinite(answeredAt)) return;
  const wait = Math.max(0, answeredAt + PHONE_CHECK_WINDOW_MS + PHONE_DEADLINE_MARGIN_MS - Date.now());
  const timer = setTimeout(() => {
    phoneDeadlines.delete(rowId);
    endPhoneCheck(rowId, isUnverified, 'unknown').catch((err) => {
      log.warn(`[TxRecorder] phone deadline failed for row ${rowId}: ${err.message}`);
    });
  }, Math.min(wait, 2 ** 31 - 1));
  timer.unref?.();
  phoneDeadlines.set(rowId, timer);
}

/**
 * At a start: the phone payments an earlier run left unverified. One with
 * the core's job waits for its `phone.checked` (the core rechecks its
 * records at each start), up to its deadline; one an earlier build checked
 * itself, with no job, can't be checked by the core, and ends `unknown`.
 * Best-effort, like every history read: resolves with how many it waits on.
 */
async function resumePhoneChecks() {
  let rows;
  try {
    rows = await rowsWithStatus(STATUSES.UNVERIFIED);
  } catch (err) {
    log.warn(`[TxRecorder] could not read unverified phone payments: ${err.message}`);
    return 0;
  }
  let waiting = 0;
  for (const row of rows) {
    if (waitingJob(row)) {
      phoneDeadline(row.id, row.metadata.phoneCheck.answeredAt);
      waiting += 1;
    } else {
      await endPhoneCheck(row.id, (current) => isUnverified(current) && !waitingJob(current), 'unknown');
    }
  }
  return waiting;
}

/**
 * core-process.js: the core's phone events, from its first handshake on.
 * A restarted core rechecks its records at its start and reports them.
 */
let attachedCore = null;
function attachPhoneEvents(client) {
  if (!client || typeof client.on !== 'function' || client === attachedCore) return;
  attachedCore = client;
  client.on('event', (name, data) => {
    let kept;
    if (name === 'phone.checked') kept = phoneChecked(data);
    else if (name === 'phone.lost') kept = phoneLost();
    else return;
    kept.catch((err) => {
      log.warn(`[TxRecorder] could not keep the core's ${name}: ${err.message}`);
    });
  });
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
  const intent = await getIntentStore().get(intentId);
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
  const intent = await getIntentStore().get(intentId);
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
 * Replace a held intent at its nonce with a transaction prepared whole
 * (replaceIntentWith: a Safe deployment's speed-up, `safe.deploy`'s send)
 * and keep its history row, which then names the replacement's hash.
 * Throws as replaceIntentWith does.
 *
 * @param {string} intentId
 * @param {Object} params
 * @param {import('./signers').Signer} signer
 */
async function replaceWithAndRecord(intentId, params, signer) {
  const response = await replaceIntentWith(intentId, params, signer);
  const intent = await getIntentStore().get(intentId);
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
async function rowOfIntent(intent) {
  if (rowsByIntent.has(intent.intentId)) {
    const row = await paymentHistory.getById(rowsByIntent.get(intent.intentId));
    if (row) return row;
  }
  return (
    (await paymentHistory.getRecent({ chainId: intent.chainId, limit: ROW_LOOKBACK }))
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
 * history write: resolves with the row, or null.
 *
 * @param {object} intent - the intent's view, read before it settled
 * @param {{label: 'paid'|'failed'|'taken'|'closed', hash: string|null, block: number}} settlement
 */
async function recordSettlement(intent, { label, hash, block }) {
  const status = SETTLED_STATUS[label];
  if (!status) return null;
  return serialized(`intent:${intent.intentId}`, () =>
    writeSettlement(intent, { label, hash, block }, status)
  );
}

async function writeSettlement(intent, { label, hash, block }, status) {
  const finality = { label, block };
  try {
    const row = await rowOfIntent(intent);
    if (row) {
      return await rewriteRow(row.id, (current) => ({
        status,
        txHash: hash ?? undefined,
        metadata: { ...current.metadata, intentId: intent.intentId, finality },
      }));
    }
    const written = await paymentHistory.append({
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
  replaceWithAndRecord,
  recordSettlement,
  resumePhoneChecks,
  attachPhoneEvents,
  phoneChecked,
  phoneLost,
  KINDS,
};
