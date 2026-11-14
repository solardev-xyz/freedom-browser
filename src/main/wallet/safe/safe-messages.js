/**
 * SafeMessage signing sessions — EIP-1271 message signing for dApps.
 *
 * A dApp's personal_sign / eth_signTypedData_v4 against a Safe account
 * is answered with owner signatures over the SafeMessage EIP-712
 * envelope; the verifying dApp calls `isValidSignature` on the Safe,
 * whose fallback handler checks the same owner signatures against the
 * same envelope. Owners sign through the ordinary collection machinery
 * (signature-collection.js), so the board UX — free vault signatures,
 * Ledger tap, phone QR — is identical to sends.
 *
 * Sessions are IN-MEMORY only, unlike pending sends: a dApp request is
 * a live promise that dies with its page (or the app), so a persisted
 * half-signed message could never be delivered. They also don't touch
 * the Safe nonce, so a parked send never blocks a message session —
 * only the per-safe device-ceremony lock is shared.
 *
 * Every session belongs to exactly one requesting page: it is bound to
 * the requester (site + webContents) that opened it and guarded by an
 * unguessable per-session token that every subsequent state/sign/
 * complete/cancel call must present. Another page can neither observe,
 * resume, nor replace a live session — it is told to wait. Sessions of
 * pages that navigated away or closed are dropped automatically.
 *
 * A session main opens for a page's request (freedom-core design 0011,
 * PRQ-5: `page/page-signing.js`, `{ owner: 'main' }`) is never resumed by
 * another start, and only main completes it: the chrome's signing board
 * collects its device signatures with the session token, and main hands the
 * signature to the page that asked.
 *
 * Every owner's signature presents the session's Safe approval (freedom-core
 * design 0012, APB-1c; `safe-approvals.js`): the one the page's
 * `safe-message` token gave, or its site's rule (`approval.spend {
 * standing }`), held by the page, under whose PageContext each vault owner
 * signs. Main ends it when the threshold's last signature is made, and
 * again before the signatures are joined, before a cancel, and before a
 * session whose page went away is dropped: each waits for the core's end,
 * and does nothing if it fails (SAFE_APPROVAL_END_FAILED).
 */

const { randomUUID } = require('crypto');
const { getAddress, hashMessage, TypedDataEncoder } = require('ethers');
const { getEip712MessageTypes, buildSignatureBytes } = require('@safe-global/protocol-kit');

const { SAFE_VERSION } = require('./safe-executor');
const { getSafeRecord, isMarkedDeployed, DEPLOY_CHAIN_ID } = require('./safe-service');
const { vaultBackend } = require('../../core/vault-backend');
const {
  normalizeMessage,
  normalizeTypedData,
  withoutDomainType,
  toCoreTypedData,
} = require('../signing-utils');
const {
  release,
  acquire,
  isBusy,
  ownersView,
  collectFreeSignatures,
  signEntryOwner,
} = require('./signature-collection');
const { getSession, setSession, discardSession } = require('./message-sessions');
const safeApprovals = require('./safe-approvals');
const { codedError, SAFE_BUSY, SAFE_DISCARDED, SAFE_MESSAGE_EXISTS } = require('./errors');

const MESSAGE = safeApprovals.KINDS.MESSAGE;
const store = {
  get: getSession,
  set: setSession,
  idOf: (entry) => entry.hash,
  approvalOf: (safeIndex, entry) => (entry.dead ? null : safeApprovals.held(MESSAGE, safeIndex, entry.hash)),
  // Ended for good (its page gone, or its caller's last check refused):
  // kept only until its approval's end, and nothing more signs it.
  ended: (entry) => entry.dead === true,
  forgetApproval: (safeIndex, entry) => safeApprovals.forget(MESSAGE, safeIndex, entry.hash),
  // The threshold's last signature ends the approval (design 0012): no
  // owner signs the SafeMessage after it.
  signed: async (safeIndex, entry) => {
    if (entry.signatures.length >= entry.threshold) await safeApprovals.end(MESSAGE, safeIndex, entry.hash);
  },
};

/**
 * The session's approval ended (`approval.end`, which the core answers only
 * after a signature already presenting it), then the session dropped. One
 * drop at a time per session: its page's close after its navigation, or a
 * new request that finds its page gone, shares the one under way. If the
 * end fails, the session stays as it was (its signatures, its approval) and
 * the drop rejects; the next one tries again.
 */
function endAndDiscard(safeIndex, entry) {
  // Ended for good from here, whether or not the end succeeds: no board
  // action signs it, and a signature landing for it is dropped.
  entry.dead = true;
  if (!entry.dropping) {
    entry.dropping = (async () => {
      await safeApprovals.end(MESSAGE, safeIndex, entry.hash);
      if (getSession(safeIndex) === entry) discardSession(safeIndex);
    })().catch((err) => {
      entry.dropping = null;
      throw err;
    });
  }
  return entry.dropping;
}

/**
 * The digest a VERIFIER computes for the dApp's request — EIP-191 for
 * personal messages (0x-hex decoded to bytes, exactly like the EOA
 * signer backends), the EIP-712 hash for typed data. This digest is
 * what goes into the SafeMessage envelope's `message` bytes field.
 * (protocol-kit's hashSafeMessage is deliberately not used for personal
 * messages: viem hashes hex STRINGS as UTF-8 text.)
 */
async function requestDigest(method, params) {
  if (method === 'personal_sign') {
    return hashMessage(normalizeMessage(params[0]));
  }
  if (method === 'eth_signTypedData_v4') {
    // The identity core's hash, with the same strict rules as its signing
    // (freedom-core design 0002): ethers would hash a `bool` given "false"
    // as true, and the owners' signature over this digest would carry that.
    return vaultBackend.typedDataHash(toCoreTypedData(normalizeTypedData(params[1])));
  }
  throw new Error(`Unsupported signing method for Safe accounts: ${method}`);
}

/**
 * The session's caller identity: the requesting page's permission key
 * plus its webview's webContents id. Two tabs are two callers even on
 * the same site — an unknown id never matches anything.
 */
function sameRequester(a, b) {
  return Boolean(
    a &&
      b &&
      a.webContentsId != null &&
      a.webContentsId === b.webContentsId &&
      a.origin === b.origin
  );
}

/** The Electron webContents behind a requester, when still around. */
function requesterWebContents(requester) {
  if (requester?.webContentsId == null) {
    return null;
  }
  try {
    return require('electron').webContents?.fromId?.(requester.webContentsId) || null;
  } catch {
    return null;
  }
}

/**
 * A session whose requesting page provably no longer exists is a dead
 * leftover (its promise died with the page) — safe to replace. Unknown
 * liveness counts as ALIVE: the new request is refused rather than a
 * possibly-live ceremony hijacked.
 */
function requesterGone(entry) {
  if (entry.requester?.webContentsId == null) {
    return false;
  }
  const contents = requesterWebContents(entry.requester);
  return !contents || contents.isDestroyed();
}

/**
 * Notes whether the requesting page navigates or closes during an await.
 * @returns {{ gone: () => boolean, stop: () => void }}
 */
function watchRequester(requester) {
  if (requester?.webContentsId == null) {
    return { gone: () => false, stop: () => {} };
  }
  const contents = requesterWebContents(requester);
  if (!contents) {
    return { gone: () => true, stop: () => {} };
  }
  let left = false;
  const mark = () => {
    left = true;
  };
  contents.on('destroyed', mark);
  contents.on('did-navigate', mark);
  return {
    gone: () => left || contents.isDestroyed(),
    stop: () => {
      contents.removeListener('destroyed', mark);
      contents.removeListener('did-navigate', mark);
    },
  };
}

/**
 * Drop the session when its requesting page goes away — closed tab or
 * a main-frame navigation (including reload): either way the dApp's
 * promise is gone and the collected signatures must not linger for
 * whatever loads next.
 */
function attachRequesterLifecycle(safeIndex, entry) {
  const contents = requesterWebContents(entry.requester);
  if (!contents) {
    return;
  }
  const drop = () => {
    if (getSession(safeIndex) !== entry) return;
    // Its approval ended first, then the session dropped. Kept if the end
    // fails: its page's next event, or the next request for the Safe (which
    // finds its page gone), drops it again.
    endAndDiscard(safeIndex, entry).catch((err) => {
      console.warn('[SafeMessages] a gone page\'s signature request is kept for now:', err.message);
    });
  };
  contents.on('destroyed', drop);
  contents.on('did-navigate', drop);
  entry.detach = () => {
    contents.removeListener('destroyed', drop);
    contents.removeListener('did-navigate', drop);
  };
}

/** The session, but only for the caller holding its token. */
function requireSession(safeIndex, token, { ended = false } = {}) {
  const entry = getSession(safeIndex);
  if (!entry) {
    throw new Error('No signature request is open for this account');
  }
  if (token !== entry.token) {
    throw new Error('This signature request belongs to a different page');
  }
  // One whose page went away is kept only until its approval has ended.
  if (entry.dead && !ended) {
    throw codedError('This signature request has ended', SAFE_DISCARDED);
  }
  return entry;
}

/** The board's render model (internal — no token gate). */
function sessionState(safeIndex, entry = getSession(safeIndex)) {
  if (!entry) {
    return null;
  }

  let ownerIndexes = [];
  try {
    ownerIndexes = getSafeRecord(safeIndex).owners;
  } catch {
    // record gone — render what the session alone supports
  }
  return {
    safeIndex,
    kind: 'message',
    token: entry.token,
    chainId: entry.chainId,
    hash: entry.hash,
    threshold: entry.threshold,
    collected: entry.signatures.length,
    owners: ownersView(ownerIndexes, entry.signatures),
    display: entry.display,
    createdAt: entry.createdAt,
    complete: entry.signatures.length >= entry.threshold,
  };
}

/**
 * The render model for the caller holding the session token; null when
 * no session is open — or when the token doesn't match, which renders
 * exactly like "nothing to show" for that caller.
 */
function getSafeMessageState(safeIndex, token) {
  const entry = getSession(safeIndex);
  if (!entry || token !== entry.token || entry.dead) {
    return null;
  }
  return sessionState(safeIndex, entry);
}

/**
 * Open a SafeMessage session for a dApp signing request and silently
 * collect the free signatures (mnemonic owners, vault unlocked). Never
 * touches a device: the signing board drives those, per user action.
 *
 * The returned state carries the session `token` — the capability for
 * every follow-up call. Re-issuing the identical request from the SAME
 * page resumes its session (collected signatures stay valid for the
 * identical hash); any other page is refused while a session is live.
 *
 * @param {Object} params
 * @param {number} params.safeIndex
 * @param {{method: string, params: Array}} params.request - The dApp's
 *   verbatim personal_sign / eth_signTypedData_v4 request
 * @param {Object} params.display - Presentation facts for the board
 *   (site, method, preview…), stored verbatim
 * @param {{origin: string, webContentsId: number|null}} [params.requester]
 *   - The requesting page's identity (permission key + webview
 *   webContents id)
 * @param {{id: string, page: object}} params.approval - The Safe approval
 *   the request's `safe-message` token or its site's rule gave (design
 *   0012): held for the session, and ended if none opens for it
 * @param {() => Promise<void>} [params.beforeSign] - The caller's last
 *   check (a page's standing rule, for a message it answers): awaited
 *   inside each free owner's signer, after the request's preparation and
 *   right before that owner signs. Its refusal ends the session, nothing
 *   more signed, and rejects with the caller's own error.
 * @returns {Promise<Object>} SafeMessageState (including `token`)
 */
async function startSafeMessage({ safeIndex, request, display, requester, owner = null, approval, beforeSign = null }) {
  // Set once a session holds the approval: otherwise it is ended here.
  const progress = { held: false };
  try {
    if (!safeApprovals.isApproval(approval)) throw new Error('This signature request was not confirmed');
    return await openSafeMessage({ safeIndex, request, display, requester, owner, approval, beforeSign, progress });
  } finally {
    if (!progress.held) await safeApprovals.release(approval);
  }
}

async function openSafeMessage({ safeIndex, request, display, requester, owner, approval, beforeSign, progress }) {
  const mainOwned = owner === 'main';
  const initial = getSafeRecord(safeIndex);
  // isValidSignature lives on the deployed contract — nothing to verify
  // against before activation. Only a verified check's mark counts
  // (#1066): a Safe still pending verification is refused too.
  if (!isMarkedDeployed(initial, DEPLOY_CHAIN_ID)) {
    throw new Error('Activate this account on Gnosis before signing for apps');
  }
  // Hashing awaits the identity core: watch the requesting page meanwhile,
  // since its lifecycle listeners are only attached to the session later.
  const watch = watchRequester(requester);
  let digest;
  try {
    digest = await requestDigest(request.method, request.params);
  } finally {
    watch.stop();
  }
  if (watch.gone()) {
    throw new Error('The requesting page went away before the signature request opened');
  }
  // The account may have changed meanwhile (deleted: getSafeRecord throws).
  const record = getSafeRecord(safeIndex);
  if (
    getAddress(record.address) !== getAddress(initial.address) ||
    !isMarkedDeployed(record, DEPLOY_CHAIN_ID)
  ) {
    throw new Error('This account changed while the signature request was opening');
  }
  const safeAddress = getAddress(record.address);
  const typedData = {
    types: getEip712MessageTypes(SAFE_VERSION),
    domain: { chainId: DEPLOY_CHAIN_ID, verifyingContract: safeAddress },
    primaryType: 'SafeMessage',
    message: { message: digest },
  };
  const hash = TypedDataEncoder.hash(
    typedData.domain,
    withoutDomainType(typedData.types),
    typedData.message
  );

  const existing = getSession(safeIndex);
  if (existing) {
    if (
      !existing.dead &&
      !mainOwned &&
      !existing.mainOwned &&
      existing.hash === hash &&
      sameRequester(existing.requester, requester)
    ) {
      // The identical request from the SAME page again (retried without
      // navigating) — resume: the collected signatures are still valid
      // for this hash, under the session's own approval.
      return signSafeMessage(safeIndex, undefined, existing.token);
    }
    if (!existing.dead && !requesterGone(existing)) {
      // A different request, or the same digest from a DIFFERENT page:
      // never resume or replace someone else's live ceremony.
      throw codedError(
        'Another signature request is already open for this account — finish or cancel it first',
        SAFE_MESSAGE_EXISTS
      );
    }
    // The requesting page provably no longer exists, or the session ended
    // and its drop hasn't finished — dead leftover.
    await endAndDiscard(safeIndex, existing);
    if (getSession(safeIndex)) {
      throw codedError(
        'Another signature request is already open for this account — finish or cancel it first',
        SAFE_MESSAGE_EXISTS
      );
    }
  }

  acquire(safeIndex);
  try {
    // The account may have changed while a leftover was dropped (deleted:
    // getSafeRecord throws).
    if (getAddress(getSafeRecord(safeIndex).address) !== safeAddress) {
      throw new Error('This account changed while the signature request was opening');
    }
    const entry = {
      token: randomUUID(),
      requester: requester
        ? { origin: requester.origin ?? null, webContentsId: requester.webContentsId ?? null }
        : null,
      chainId: DEPLOY_CHAIN_ID,
      typedData,
      hash,
      threshold: record.threshold,
      display,
      signatures: [],
      createdAt: Date.now(),
      mainOwned,
    };
    // Held first: a session opens only with its approval.
    await safeApprovals.hold(MESSAGE, safeIndex, approval, hash);
    progress.held = true;
    setSession(safeIndex, entry);
    attachRequesterLifecycle(safeIndex, entry);
    try {
      await collectFreeSignatures(store, safeIndex, record.owners, null, { beforeSign });
    } catch (err) {
      // The caller's last check refused: the session ends here (its
      // approval ended first), and what it collected goes with it. If the
      // end fails, it stays ended for the next drop to finish.
      await endAndDiscard(safeIndex, entry).catch((endError) => {
        console.warn('[SafeMessages] a refused signature request is kept, ended, for now:', endError.message);
      });
      throw err;
    }
  } finally {
    release(safeIndex);
  }
  return sessionState(safeIndex);
}

/**
 * Collect exactly one owner's signature (or, without an ownerIndex,
 * sweep the free ones — the board runs this on open). Same semantics as
 * the send flow's signSafePending: idempotent, per-safe lock, failures
 * belong to the row.
 *
 * @param {number} safeIndex
 * @param {number} [ownerIndex]
 * @param {string} token - The session token from startSafeMessage
 * @returns {Promise<Object>} SafeMessageState
 */
async function signSafeMessage(safeIndex, ownerIndex, token) {
  const record = getSafeRecord(safeIndex);
  requireSession(safeIndex, token);
  await signEntryOwner({ store, safeIndex, ownerIndex, ownerIndexes: record.owners });
  return sessionState(safeIndex);
}

/**
 * Close a threshold-met session and return the EIP-1271 signature: the
 * owners' signatures sorted by signer and concatenated, ready to hand
 * back to the dApp (which verifies via `isValidSignature` on the Safe).
 *
 * The session's approval is ended first (design 0012), the Safe held
 * meanwhile, so no owner signs between the two.
 *
 * @param {number} safeIndex
 * @param {string} token - The session token from startSafeMessage
 * @returns {Promise<{signature: string}>}
 */
async function completeSafeMessage(safeIndex, token) {
  if (isBusy(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  const entry = requireSession(safeIndex, token);
  if (entry.signatures.length < entry.threshold) {
    throw new Error(
      `Not enough signatures yet (${entry.signatures.length} of ${entry.threshold})`
    );
  }
  acquire(safeIndex);
  try {
    await safeApprovals.end(MESSAGE, safeIndex, entry.hash);
    if (getSession(safeIndex) !== entry || entry.dead) {
      throw new Error('No signature request is open for this account');
    }
    // buildSignatureBytes sorts its input in place — hand it a copy.
    const signature = buildSignatureBytes(entry.signatures.map((sig) => ({ ...sig })));
    discardSession(safeIndex);
    return { signature };
  } finally {
    release(safeIndex);
  }
}

/**
 * Drop the session (collected signatures are thrown away). Idempotent
 * when nothing is open; refused with someone else's token. Its approval is
 * ended first (design 0012), even while a device's step runs: the session
 * is then refused (SAFE_BUSY) and kept until its page goes, but no vault
 * owner signs it again.
 */
async function cancelSafeMessage(safeIndex, token) {
  if (!getSession(safeIndex)) {
    return; // already gone — cancelling twice is fine
  }
  const entry = requireSession(safeIndex, token, { ended: true });
  // Ended already (its page gone): its drop, again.
  if (entry.dead) {
    await endAndDiscard(safeIndex, entry);
    return;
  }
  await safeApprovals.end(MESSAGE, safeIndex, entry.hash);
  if (isBusy(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  if (getSession(safeIndex) === entry) discardSession(safeIndex);
}

module.exports = {
  startSafeMessage,
  signSafeMessage,
  completeSafeMessage,
  cancelSafeMessage,
  getSafeMessageState,
};
