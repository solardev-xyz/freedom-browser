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
 *   request fields are taken at all.
 * - `wallet:intents-changed`: to the chrome windows whenever the records
 *   change.
 */

const { ipcMain } = require('electron');
const { getIntentStore } = require('./intent-store');
const { resendAndRecord } = require('./tx-recorder');
const { KINDS: CONFIRM_KINDS, consumeConfirmation } = require('./signing-confirmation');

const OUTCOME_ATTENTION = Object.freeze({
  rejected: 'refused',
  not_sent: 'not-sent',
  uncertain: 'uncertain',
  sent: 'sent',
});

/**
 * Where a held intent stands, for display: `sending` (a handoff is under
 * way), the last outcome of this run (`sent`, `uncertain`, `refused`,
 * `not-sent`), `not-sent` for one never handed off, or `pending` for one
 * recovered from disk, whose earlier outcomes are only summarized.
 */
function attentionOf(view) {
  const last = view.handoffs[view.handoffs.length - 1];
  if (last) return last.outcome ? OUTCOME_ATTENTION[last.outcome.outcome] : 'sending';
  if (view.handoffCount === 0) return 'not-sent';
  return view.possiblySent ? 'pending' : 'not-sent';
}

/** A held intent for the renderer: what it pays and where it stands. */
function intentSummary(view) {
  const last = view.handoffs[view.handoffs.length - 1];
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
    attention: attentionOf(view),
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

async function listHeldIntents() {
  const store = getIntentStore();
  await store.ready;
  return store.held().map(intentSummary);
}

async function resendHeldIntent(intentId, authorization) {
  const store = getIntentStore();
  await store.ready;
  const view = typeof intentId === 'string' ? store.get(intentId) : null;
  if (!view) {
    const error = new Error("This payment is not in the wallet's records.");
    error.code = 'INTENT_UNKNOWN';
    throw error;
  }
  if (view.state !== 'held') {
    const error = new Error(
      view.state === 'voided' ? 'This payment was voided.' : 'This payment is already settled.'
    );
    error.code = 'INTENT_NOT_HELD';
    throw error;
  }
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
      return { success: false, error: err.message, ...intentFailure(err) };
    }
  });

  getIntentStore().onChange(() => {
    for (const win of windows()) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send('wallet:intents-changed');
      } catch {
        // The window is closing.
      }
    }
  });
}

module.exports = {
  attentionOf,
  intentFailure,
  intentSummary,
  registerIntentIpc,
  resendBinding,
};
