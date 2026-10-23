/**
 * The wallet's intent records over IPC (freedom-core design 0005, "Retrying
 * an intent"), for the chrome only: none of these channels is open to a
 * page (ipc-sender-policy.js).
 *
 * - `wallet:intents-list`: the held intents, as summaries. The signed bytes
 *   never leave main.
 * - `wallet:intent-resend(intentId, authorization)`: send a held intent's
 *   bytes again. Nothing is signed, and the intent keeps its one nonce.
 *   The authorization is an `intent-resend` confirmation of the intent
 *   itself: its id, chain, sender, nonce and the hash of the bytes. The
 *   handler builds what the confirmation must match from main's own record
 *   of the intent, never from fields the caller submits. Unlike a send, no
 *   request fields are taken at all. A refusal of any kind (a lapsed or
 *   stale confirmation, a refused broadcast, a failed write) still says
 *   where the intent stands: its current summary, so the chrome keeps
 *   offering that payment, at that nonce, and never a new one. Only an
 *   intent main doesn't know (`INTENT_UNKNOWN`) comes without one.
 * - `wallet:intent-replacement-fees(intentId)` and
 *   `wallet:intent-replace(intentId, fees, authorization)`: sign a held
 *   intent again at its nonce, paying the same thing with fees at least
 *   10% higher. The authorization is an `intent-replace` confirmation of
 *   the intent and those fees; the payment it binds comes from main's
 *   record, and only the fees from the caller. Offered for a refusal over
 *   fees, and as "speed up" for a payment that may be stuck. Refusals
 *   carry the intent's current summary, as a resend's do.
 * - `wallet:intent-close(intentId, authorization)`: close by hand a held
 *   intent shown as Couldn't confirm (design 0005, "State history", #94),
 *   only once a verified read showed its nonce used at a finalized block,
 *   so none of its transactions can be mined. The authorization is an
 *   `intent-close` confirmation of the intent and every hash it has, built
 *   from main's record. Under the account's reservation lock, and only for
 *   those hashes: a replacement committed meanwhile closes nothing. The
 *   intent is retired durably, and its history row says its payment is
 *   unconfirmed. Refusals carry the intent's current summary.
 * - `wallet:intents-changed`: to the chrome windows whenever the records
 *   change, or what the finality tracker saw of a held intent does.
 */

const { ipcMain } = require('electron');
const { closedText, getIntentStore } = require('./intent-store');
const { resendAndRecord, replaceAndRecord, recordSettlement } = require('./tx-recorder');
const { replacementFees } = require('./transaction-service');
const { getSigner } = require('./signers');
const paymentHistory = require('../payment-history');
const { KINDS: CONFIRM_KINDS, consumeConfirmation } = require('./signing-confirmation');
const { getIntentTracker } = require('./intent-tracker');
const { OBSERVED } = require('./intent-labels');
const { withAccountLock } = require('./nonce-reservations');
const { getTxExplorerUrl } = require('./chains');

const OUTCOME_ATTENTION = Object.freeze({
  rejected: 'refused',
  not_sent: 'not-sent',
  uncertain: 'uncertain',
  sent: 'sent',
});

/**
 * Where a held intent stands, for display: `sending` (a handoff is under
 * way), the last outcome of this run (`sent`, `uncertain`, `refused`,
 * `not-sent`), `not-sent` for one never handed off, or, for one recovered
 * from disk, whose earlier outcomes are only summarized, what the finality
 * tracker's reads saw: `absent` when verified evidence shows none of its
 * transactions on chain, else `pending`. (One on chain is not waiting:
 * see `receipt`.)
 */
function attentionOf(view, observation = null) {
  const last = view.handoffs[view.handoffs.length - 1];
  if (last) return last.outcome ? OUTCOME_ATTENTION[last.outcome.outcome] : 'sending';
  if (view.handoffCount === 0) return 'not-sent';
  if (!view.possiblySent) return 'not-sent';
  return observation?.observed === OBSERVED.ABSENT ? 'absent' : 'pending';
}

// Refusals a higher fee answers (design 0005, "Refusals").
const FEE_REFUSALS = new Set([
  'transaction underpriced',
  'replacement transaction underpriced',
  'max fee per gas less than block base fee',
]);

/**
 * What replacement a held intent is offered: `replace` after a refusal over
 * fees, `speed-up` for one that may be sitting unmined, else null. Only
 * with its signing account known.
 */
function replacementOffer(view, attention) {
  if (!Number.isSafeInteger(view.context?.walletIndex)) return null;
  if (attention === 'refused') {
    const reason = view.handoffs[view.handoffs.length - 1]?.outcome?.reasonClass;
    return FEE_REFUSALS.has(reason) ? 'replace' : null;
  }
  return ['uncertain', 'pending', 'absent'].includes(attention) ? 'speed-up' : null;
}

/**
 * A held intent for the renderer: what it pays and where it stands, with
 * what the finality tracker last saw of it (`observation`), if anything.
 */
function intentSummary(view, observation = null) {
  const last = view.handoffs[view.handoffs.length - 1];
  const attention = attentionOf(view, observation);
  return {
    intentId: view.intentId,
    chainId: view.chainId,
    sender: view.sender,
    nonce: view.nonce,
    hash: view.hash,
    state: view.state,
    kind: view.context?.kind ?? null,
    origin: view.context?.origin ?? null,
    walletIndex: view.context?.walletIndex ?? null,
    fields: view.fields,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    handoffCount: view.handoffCount,
    possiblySent: view.possiblySent,
    lastOutcome: last?.outcome
      ? { outcome: last.outcome.outcome, reasonClass: last.outcome.reasonClass }
      : null,
    attention,
    replacement: replacementOffer(view, attention),
  };
}

// What an intent-resend confirmation of `view` binds.
function resendBinding(view) {
  return {
    intentId: view.intentId,
    chainId: view.chainId,
    sender: view.sender,
    nonce: view.nonce,
    hash: view.hash,
  };
}

/** The intent fields a failed send or resend reports, from its error. */
function intentFailure(err) {
  const fields = {};
  if (typeof err?.code === 'string') fields.code = err.code;
  if (err?.outcome) fields.outcome = err.outcome;
  if (err?.reasonClass) fields.reasonClass = err.reasonClass;
  if (err?.intentId) {
    fields.intentId = err.intentId;
    const view = getIntentStore().get(err.intentId);
    if (view) fields.intent = intentSummary(view);
  }
  return fields;
}

// The receipts payment history has seen for intents, by intent id: a held
// intent whose transaction is already mined needs no attention, though it
// stays held until its label is read at the finalized block.
const RECEIPT_LOOKBACK = 500;

function receiptsByIntent() {
  const receipts = new Map();
  try {
    for (const row of paymentHistory.getRecent({ limit: RECEIPT_LOOKBACK })) {
      const intentId = row.metadata?.intentId;
      if (intentId && (row.status === 'confirmed' || row.status === 'failed')) {
        receipts.set(intentId, row.status);
      }
    }
  } catch (err) {
    console.warn('[WalletIPC] Payment history unavailable for held payments:', err.message);
  }
  return receipts;
}

/**
 * Main's current word on an intent a request named: its id and summary
 * (whose `state` says whether it is still held), or nothing for an intent
 * main doesn't know.
 */
function currentIntent(intentId) {
  if (typeof intentId !== 'string') return {};
  try {
    const view = getIntentStore().get(intentId);
    return view ? { intentId: view.intentId, intent: intentSummary(view) } : {};
  } catch {
    // The records aren't loaded: no word either way.
    return {};
  }
}

/**
 * What Couldn't confirm shows of a held intent, or null when it isn't
 * shown: its hashes, each with a block-explorer link, and whether it may
 * be closed by hand.
 */
function couldntConfirmOf(view, tracker) {
  const state = tracker.couldntConfirm(view);
  if (!state) return null;
  return {
    since: state.since,
    closable: state.closable,
    hashes: view.hashes.map(({ hash }) => ({
      hash,
      explorerUrl: getTxExplorerUrl(view.chainId, hash) ?? null,
    })),
  };
}

/**
 * The held intents, each with where it stands and the receipt seen for it,
 * if any (`receipt`: a payment on chain no longer waits on the user), and
 * `couldntConfirm` for one whose label couldn't be read for a day. That
 * one waits on the user whatever a receipt said, since nothing verified
 * it: it has no `receipt`. Once its nonce is seen used, none of its
 * transactions can be mined, so it is offered no replacement.
 */
async function listHeldIntents() {
  const store = getIntentStore();
  await store.ready;
  const receipts = receiptsByIntent();
  const tracker = getIntentTracker();
  return store.held().map((view) => {
    const observation = tracker.observation(view.intentId);
    const mined = observation?.observed === OBSERVED.INCLUDED ? 'mined' : null;
    const couldntConfirm = couldntConfirmOf(view, tracker);
    const summary = intentSummary(view, observation);
    return {
      ...summary,
      observed: observation?.observed ?? null,
      // On chain, though not final yet: it no longer waits on the user.
      receipt: couldntConfirm ? null : (receipts.get(view.intentId) ?? mined),
      couldntConfirm,
      replacement: couldntConfirm?.closable ? null : summary.replacement,
    };
  });
}

/**
 * The held intents Payments waiting lists: those no receipt has shown
 * mined (the renderer's list applies the same rule, held-payments.js).
 * "Always allow" pauses for a site while one of these is its own
 * (auto-approve-pause.js, D12).
 */
async function waitingIntents() {
  return (await listHeldIntents()).filter((intent) => !intent.receipt);
}

// A held intent, or the error that says why there is none.
function heldView(store, intentId) {
  const view = typeof intentId === 'string' ? store.get(intentId) : null;
  if (!view) {
    const error = new Error("This payment is not in the wallet's records.");
    error.code = 'INTENT_UNKNOWN';
    throw error;
  }
  if (view.state !== 'held') {
    const error = new Error(closedText(view.state));
    error.code = 'INTENT_NOT_HELD';
    throw error;
  }
  return view;
}

async function resendHeldIntent(intentId, authorization) {
  const store = getIntentStore();
  await store.ready;
  const view = heldView(store, intentId);
  // The user confirmed this intent as main records it; nothing the caller
  // submits takes part.
  consumeConfirmation(
    authorization?.confirmation,
    CONFIRM_KINDS.INTENT_RESEND,
    null,
    resendBinding(view)
  );
  return resendAndRecord(view.intentId, { hash: view.hash });
}

// What an intent-replace confirmation binds: the payment from main's
// record, the fees as submitted.
function replaceBinding(view, fees) {
  return {
    intentId: view.intentId,
    chainId: view.chainId,
    sender: view.sender,
    nonce: view.nonce,
    to: view.fields.to,
    value: view.fields.value,
    data: view.fields.data,
    gasLimit: view.fields.gasLimit,
    maxFeePerGas: fees?.maxFeePerGas,
    maxPriorityFeePerGas: fees?.maxPriorityFeePerGas,
    gasPrice: fees?.gasPrice,
  };
}

async function replaceHeldIntent(intentId, fees, authorization) {
  const store = getIntentStore();
  await store.ready;
  const view = heldView(store, intentId);
  const walletIndex = view.context?.walletIndex;
  if (!Number.isSafeInteger(walletIndex)) {
    const error = new Error("This payment's account isn't known, so it can't be replaced.");
    error.code = 'INTENT_SIGNER_UNKNOWN';
    throw error;
  }
  const submitted = {
    maxFeePerGas: fees?.maxFeePerGas,
    maxPriorityFeePerGas: fees?.maxPriorityFeePerGas,
    gasPrice: fees?.gasPrice,
  };
  consumeConfirmation(
    authorization?.confirmation,
    CONFIRM_KINDS.INTENT_REPLACE,
    null,
    replaceBinding(view, submitted)
  );
  const confirmed = Object.fromEntries(
    Object.entries(submitted).filter(([, value]) => value !== undefined && value !== null)
  );
  return replaceAndRecord(view.intentId, confirmed, getSigner(walletIndex));
}

// What an intent-close confirmation of `view` binds: the intent, and every
// hash it has, in order (the revision the user saw).
function closeBinding(view) {
  return {
    intentId: view.intentId,
    chainId: view.chainId,
    sender: view.sender,
    nonce: view.nonce,
    hashes: view.hashes.map((entry) => entry.hash),
  };
}

/**
 * Close a held intent by hand (design 0005, "State history"). The tracker
 * must show it as Couldn't confirm, with a verified read in this run that
 * saw its nonce past N at a finalized block: N is used on the finalized
 * chain, so none of its signed versions can be mined. Then, under the
 * account's lock, the store retires it, only if it still has the hashes
 * the user confirmed.
 */
async function closeHeldIntent(intentId, authorization) {
  const store = getIntentStore();
  await store.ready;
  const view = heldView(store, intentId);
  const binding = closeBinding(view);
  consumeConfirmation(authorization?.confirmation, CONFIRM_KINDS.INTENT_CLOSE, null, binding);
  const evidence = getIntentTracker().closeEvidence(view.intentId);
  if (!evidence) {
    const error = new Error(
      "This payment can't be closed: the network hasn't shown that its place in the queue " +
        'was used.'
    );
    error.code = 'INTENT_CLOSE_REFUSED';
    throw error;
  }
  const closed = await withAccountLock({ chainId: view.chainId, sender: view.sender }, (lock) =>
    store.retire({ intentId: view.intentId, block: evidence.block, hashes: binding.hashes }, lock)
  );
  console.log(
    `[WalletIPC] Closed intent ${view.intentId} by hand; its nonce ${view.nonce} was used ` +
      `by finalized block ${evidence.block}`
  );
  recordSettlement(view, { label: 'closed', hash: null, block: evidence.block });
  return { intentId: closed.intentId, intent: intentSummary(closed) };
}

/**
 * @param {object} [options]
 * @param {() => Electron.BrowserWindow[]} [options.windows] the chrome
 *   windows to tell about changes
 */
function registerIntentIpc({
  windows = () => require('../windows/mainWindow').getMainWindows(),
} = {}) {
  ipcMain.handle('wallet:intents-list', async () => {
    try {
      return { success: true, intents: await listHeldIntents() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('wallet:intent-resend', async (_event, intentId, authorization) => {
    try {
      return { success: true, ...(await resendHeldIntent(intentId, authorization)) };
    } catch (err) {
      console.error('[WalletIPC] Sending a payment again failed:', err);
      return {
        success: false,
        error: err.message,
        ...intentFailure(err),
        ...currentIntent(intentId),
      };
    }
  });

  ipcMain.handle('wallet:intent-replacement-fees', async (_event, intentId) => {
    try {
      return { success: true, fees: await replacementFees(intentId) };
    } catch (err) {
      return {
        success: false,
        error: err.message,
        ...intentFailure(err),
        ...currentIntent(intentId),
      };
    }
  });

  ipcMain.handle('wallet:intent-replace', async (_event, intentId, fees, authorization) => {
    try {
      return { success: true, ...(await replaceHeldIntent(intentId, fees, authorization)) };
    } catch (err) {
      console.error('[WalletIPC] Replacing a payment failed:', err);
      return {
        success: false,
        error: err.message,
        ...intentFailure(err),
        ...currentIntent(intentId),
      };
    }
  });

  ipcMain.handle('wallet:intent-close', async (_event, intentId, authorization) => {
    try {
      return { success: true, ...(await closeHeldIntent(intentId, authorization)) };
    } catch (err) {
      console.error('[WalletIPC] Closing a payment failed:', err);
      return {
        success: false,
        error: err.message,
        ...intentFailure(err),
        ...currentIntent(intentId),
      };
    }
  });

  const changed = () => {
    for (const win of windows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('wallet:intents-changed');
      } catch {
        // The window is closing.
      }
    }
  };
  getIntentStore().onChange(changed);
  getIntentTracker().onChange(changed);
}

module.exports = {
  attentionOf,
  closeBinding,
  currentIntent,
  intentFailure,
  intentSummary,
  registerIntentIpc,
  replaceBinding,
  replacementOffer,
  resendBinding,
  waitingIntents,
};
