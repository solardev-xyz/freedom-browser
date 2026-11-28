/**
 * A page's Safe messages (EIP-1271) on the core's Safe backend
 * (freedom-core design 0016, "Messages (EIP-1271)", API, and the S5
 * amendment; SAFE-3's PR 5; FREEDOM_SAFE_BACKEND=core, development builds
 * only: safe-backend-kind.js). safe-messages.js routes its calls here on the
 * core, and keeps today's protocol-kit path on js.
 *
 * - **Opened by the core.** `safe.message_start`, under `page` with the
 *   request's PageContext, with the page's request as sent and its
 *   authorization: the `safe-message` token the core minted for the page's
 *   prompt and that prompt's handle, `{ token, handle }`, or the site's
 *   standing rule, `{ standing: { paused? } }`. The core spends the token
 *   (or checks and counts the rule) itself, reads the Safe's setup
 *   (verified), builds the SafeMessage and its hash, and signs with the
 *   vault owners while the vault is unlocked. Main spends nothing and holds
 *   no Safe approval for it.
 * - **The core's session ID never leaves main** (the SAFE-3 plan's point
 *   7). It comes once, in `safe.message_start`'s answer, and main keeps it
 *   in the session's entry beside main's own token for the session
 *   (`randomUUID`, as today's path makes one). The states main gives out
 *   (the page's prompt, the chrome's `wallet:safe-message-*`, the approvals
 *   document's board) carry main's token, never the ID; nothing logs either.
 * - **Every board call names main's token** and is checked against the
 *   session it was issued for, before anything is sent: one Safe's session
 *   per index, so another session's token (an earlier one of the Safe's, or
 *   another Safe's) is "This signature request belongs to a different
 *   page", and `state` answers it null. Only then does main present the
 *   core's ID, to `safe.message_sign`, `.message_state`, `.message_cancel`
 *   or `.message_complete`, as main's own (`shell`).
 * - **Owners:** `safe.message_sign` without an owner is the vault owners'
 *   sweep, with one that owner. A Ledger owner is refused here, unsent,
 *   until SAFE-3's PR 8 (main's binding of the SafeMessage): no device is
 *   asked for a Safe owner before then. A phone owner is the core's own
 *   refusal.
 * - **One session per Safe, main's** (the core's rule): while one is open
 *   for a live page, another start is SAFE_MESSAGE_EXISTS, unsent. One
 *   whose page has gone is cancelled first, as today's dead leftover is
 *   dropped.
 * - **Its page's lifetime:** main cancels the session when its page
 *   navigates or closes (as `attachRequesterLifecycle` does today), and a
 *   page that goes while its session opens gets none (cancelled at once).
 *   A cancel the core couldn't answer leaves the entry, ended, for the next
 *   start to cancel again; a session in a core process that has since
 *   ended went with it.
 *
 * Each start and each signature holds main's own step exclusion for the
 * Safe, as today's path does, so a Safe's deletion waits for it; the core
 * holds the Safe through the same steps. A refusal of the core's keeps its
 * code (wallet/safe/errors.js): nothing here falls back to main's own path.
 */

const { randomUUID } = require('crypto');
const { codedError, SAFE_BUSY, SAFE_DISCARDED, SAFE_MESSAGE_EXISTS, SAFE_UNSUPPORTED } = require('./errors');
const safeApprovals = require('./safe-approvals');
const {
  getSession,
  setSession,
  discardSession,
  requesterWebContents,
  requesterGone,
  watchRequester,
} = require('./message-sessions');

const NO_SESSION = 'No signature request is open for this account';
const OTHER_PAGE = 'This signature request belongs to a different page';
const EXISTS = 'Another signature request is already open for this account — finish or cancel it first';
// The core's session ID: 16 bytes as 32 lowercase hex digits.
const SESSION_ID = /^[0-9a-f]{32}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE = /^0x(?:[0-9a-fA-F]{2})+$/;

function vault() {
  return require('../../core/vault-backend').vaultBackend;
}

const pageWentAway = () => new Error('The requesting page went away before the signature request opened');
const discarded = () => codedError('The request was discarded while the signature was being made', SAFE_DISCARDED);
const unanswered = () => new Error("The identity core answered no state of this account's signature request");

/** `{ token, handle }`, or `{ standing: { paused? } }`: what `safe.message_start` presents. */
function authorizationOf(authorization) {
  if (authorization && typeof authorization === 'object' && authorization.standing !== undefined) {
    const { standing } = authorization;
    if (!standing || typeof standing !== 'object' || Object.keys(authorization).length !== 1) {
      throw new Error('This signature request was not confirmed');
    }
    return { standing: typeof standing.paused === 'boolean' ? { paused: standing.paused } : {} };
  }
  const { token, handle } = authorization ?? {};
  if (typeof token !== 'string' || !token || typeof handle !== 'string' || !handle) {
    throw new Error('This signature request was not confirmed');
  }
  return { token, handle };
}

/**
 * A state of the core's for `entry`'s session, as main gives it out: the
 * board's fields with main's token for the session, and nothing else the
 * core sent. Null for one that isn't this session's (another Safe, another
 * SafeMessage).
 */
function stateFor(entry, state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
  if (state.safeIndex !== entry.safeIndex || state.kind !== 'message' || state.hash !== entry.hash) return null;
  const owners = Array.isArray(state.owners)
    ? state.owners.map((owner) => ({
        index: owner?.index,
        address: typeof owner?.address === 'string' ? owner.address : null,
        type: typeof owner?.type === 'string' ? owner.type : 'mnemonic',
        signed: owner?.signed === true,
      }))
    : [];
  return {
    safeIndex: entry.safeIndex,
    kind: 'message',
    token: entry.token,
    chainId: state.chainId,
    hash: entry.hash,
    threshold: state.threshold,
    collected: state.collected,
    owners,
    display: state.display,
    createdAt: state.createdAt,
    complete: state.complete === true,
  };
}

/**
 * The session for the caller holding main's `token` for it, or the
 * refusal, before anything is sent: none open, another session's token, or
 * one main has ended. A session whose core process has ended went with it:
 * dropped here.
 */
function requireSession(safeIndex, token) {
  const entry = getSession(safeIndex);
  if (!entry) throw new Error(NO_SESSION);
  if (typeof token !== 'string' || token !== entry.token) throw new Error(OTHER_PAGE);
  if (vault().coreProcessEnded(entry.core)) {
    discardSession(safeIndex);
    throw new Error(NO_SESSION);
  }
  if (entry.dead) throw codedError('This signature request has ended', SAFE_DISCARDED);
  return entry;
}

/**
 * The session cancelled in the core (`safe.message_cancel`), then main's
 * entry dropped. Ended for good from the first try: nothing more signs it
 * through main. The core ends a session a step holds at once (SAFE_BUSY),
 * so that drops it too; any other failure keeps the entry, ended, for the
 * next drop, and rejects. One drop at a time per session.
 */
function endAndDrop(safeIndex, entry) {
  entry.dead = true;
  if (!entry.dropping) {
    entry.dropping = (async () => {
      let busy = null;
      if (!vault().coreProcessEnded(entry.core)) {
        try {
          await vault().safe.messageCancel({ safe: safeIndex, session: entry.session });
        } catch (err) {
          if (err?.code !== SAFE_BUSY) throw err;
          busy = err;
        }
      }
      if (getSession(safeIndex) === entry) discardSession(safeIndex);
      return busy;
    })().finally(() => {
      entry.dropping = null;
    });
  }
  return entry.dropping;
}

/** Cancel the session when its page navigates or closes. */
function attachRequesterLifecycle(safeIndex, entry) {
  const contents = requesterWebContents(entry.requester);
  if (!contents) return;
  const drop = () => {
    if (getSession(safeIndex) !== entry) return;
    endAndDrop(safeIndex, entry).catch((err) => {
      console.warn("[SafeMessages] a gone page's signature request is kept, ended, for now:", err.message);
    });
  };
  contents.on('destroyed', drop);
  contents.on('did-navigate', drop);
  entry.detach = () => {
    contents.removeListener('destroyed', drop);
    contents.removeListener('did-navigate', drop);
  };
}

/**
 * A page's Safe message opened in the core (`safe.message_start`): its
 * state, with main's token for the session.
 *
 * @param {object} options
 * @param {number} options.safeIndex
 * @param {{method: string, params: Array}} options.request - the page's request as sent
 * @param {object} [options.display] - the board's facts (site, method), kept by the core
 * @param {{origin: string, webContentsId: number|null}} [options.requester] - the requesting page
 * @param {{token: string, handle: string}|{standing: {paused?: boolean}}} options.authorization
 * @param {object} options.page - the request's PageContext
 * @returns {Promise<object>} the session's state
 */
async function start({ safeIndex, request, display, requester, authorization, page }) {
  const presented = authorizationOf(authorization);
  const existing = getSession(safeIndex);
  if (existing) {
    // Another live page's: never replaced, and the core isn't asked.
    if (!existing.dead && !requesterGone(existing) && !vault().coreProcessEnded(existing.core)) {
      throw codedError(EXISTS, SAFE_MESSAGE_EXISTS);
    }
    // Its page gone, or ended by main: cancelled first.
    await endAndDrop(safeIndex, existing);
    if (getSession(safeIndex)) throw codedError(EXISTS, SAFE_MESSAGE_EXISTS);
  }
  const watch = watchRequester(requester);
  safeApprovals.beginStep(safeIndex);
  try {
    if (watch.gone()) throw pageWentAway();
    const answer = await vault().safe.messageStart(
      {
        safe: safeIndex,
        request: { method: request?.method, params: request?.params },
        display,
        authorization: presented,
      },
      page
    );
    const session = answer?.session;
    if (typeof session !== 'string' || !SESSION_ID.test(session)) {
      throw new Error("The identity core answered no signature request for this account");
    }
    const entry = {
      token: randomUUID(),
      session,
      safeIndex,
      hash: typeof answer.state?.hash === 'string' && HASH.test(answer.state.hash) ? answer.state.hash : null,
      requester: requester
        ? { origin: requester.origin ?? null, webContentsId: requester.webContentsId ?? null }
        : null,
      core: vault().coreProcess(),
      dead: false,
    };
    // Kept first, so that a session main won't use can still be cancelled.
    setSession(safeIndex, entry);
    const state = entry.hash ? stateFor(entry, answer.state) : null;
    if (!state || watch.gone()) {
      // Not this request's, or its page went while it opened: cancelled
      // at once. One the core couldn't cancel stays, ended, for the next
      // start to cancel again.
      await endAndDrop(safeIndex, entry).catch((err) => {
        console.warn('[SafeMessages] a signature request nobody can use is kept, ended, for now:', err.message);
      });
      throw state ? pageWentAway() : unanswered();
    }
    attachRequesterLifecycle(safeIndex, entry);
    return state;
  } finally {
    safeApprovals.endStep(safeIndex);
    watch.stop();
  }
}

function isLedgerOwner(ownerIndex) {
  const { getWalletRecord, WALLET_TYPES } = require('../../identity-manager');
  return getWalletRecord(ownerIndex)?.type === WALLET_TYPES.LEDGER;
}

/**
 * One owner's signature (`ownerIndex`), or the vault owners' sweep (none),
 * through `safe.message_sign`, for the caller holding main's `token`.
 * Resolves the session's state.
 */
async function sign(safeIndex, ownerIndex, token) {
  const entry = requireSession(safeIndex, token);
  const owner = ownerIndex === undefined || ownerIndex === null ? undefined : ownerIndex;
  if (owner !== undefined && (!Number.isSafeInteger(owner) || owner < 0)) {
    throw new Error('That account is not an owner of this Safe');
  }
  if (owner !== undefined && isLedgerOwner(owner)) {
    // SAFE-3's PR 8: a Ledger owner signs on the core only under main's
    // binding of the SafeMessage.
    throw codedError("A Ledger can't sign for a multi-owner account here yet", SAFE_UNSUPPORTED);
  }
  safeApprovals.beginStep(safeIndex);
  let answer;
  try {
    answer = await vault().safe.messageSign({ safe: safeIndex, session: entry.session, owner });
  } finally {
    safeApprovals.endStep(safeIndex);
  }
  // Cancelled or replaced meanwhile: nothing of it is shown as this one's.
  if (getSession(safeIndex) !== entry || entry.dead) throw discarded();
  const state = stateFor(entry, answer);
  if (!state) throw unanswered();
  return state;
}

/**
 * The session's state for the caller holding main's `token`: null when
 * none is open, for another session's token, or once it has ended.
 */
async function state(safeIndex, token) {
  const entry = getSession(safeIndex);
  if (!entry || typeof token !== 'string' || token !== entry.token || entry.dead) return null;
  if (vault().coreProcessEnded(entry.core)) {
    discardSession(safeIndex);
    return null;
  }
  return stateFor(entry, await vault().safe.messageState({ safe: safeIndex, session: entry.session }));
}

/**
 * The threshold met: the owners' signatures joined (`safe.message_complete`),
 * for main alone to hand to the page that asked; the session dropped.
 */
async function complete(safeIndex, token) {
  if (safeApprovals.stepRunning(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  const entry = requireSession(safeIndex, token);
  safeApprovals.beginStep(safeIndex);
  try {
    const answer = await vault().safe.messageComplete({ safe: safeIndex, session: entry.session });
    // The core dropped its session with the answer.
    if (getSession(safeIndex) === entry) discardSession(safeIndex);
    entry.dead = true;
    const signature = answer?.signature;
    if (typeof signature !== 'string' || !SIGNATURE.test(signature)) {
      throw new Error('The identity core answered no signature for this request');
    }
    return { signature };
  } finally {
    safeApprovals.endStep(safeIndex);
  }
}

/**
 * The session cancelled (`safe.message_cancel`): idempotent when none is
 * open; refused for another session's token. While a step holds the Safe
 * the core ends the session at once and answers SAFE_BUSY, which is passed
 * on: nothing more signs or completes it.
 */
async function cancel(safeIndex, token) {
  const entry = getSession(safeIndex);
  if (!entry) return;
  if (typeof token !== 'string' || token !== entry.token) throw new Error(OTHER_PAGE);
  // Ended already, or its core process gone: dropped all the same.
  const busy = await endAndDrop(safeIndex, entry);
  if (busy) throw busy;
}

module.exports = { start, sign, state, complete, cancel };
