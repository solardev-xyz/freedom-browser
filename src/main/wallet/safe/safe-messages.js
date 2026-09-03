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
 */

const { randomUUID } = require('crypto');
const { getAddress, hashMessage, TypedDataEncoder } = require('ethers');
const { getEip712MessageTypes, buildSignatureBytes } = require('@safe-global/protocol-kit');

const { SAFE_VERSION } = require('./safe-executor');
const { getSafeRecord, DEPLOY_CHAIN_ID } = require('./safe-service');
const {
  normalizeMessage,
  normalizeTypedData,
  withoutDomainType,
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
const { codedError, SAFE_BUSY, SAFE_MESSAGE_EXISTS } = require('./errors');

const store = { get: getSession, set: setSession, idOf: (entry) => entry.hash };

/**
 * The digest a VERIFIER computes for the dApp's request — EIP-191 for
 * personal messages (0x-hex decoded to bytes, exactly like the EOA
 * signer backends), the EIP-712 hash for typed data. This digest is
 * what goes into the SafeMessage envelope's `message` bytes field.
 * (protocol-kit's hashSafeMessage is deliberately not used for personal
 * messages: viem hashes hex STRINGS as UTF-8 text.)
 */
function requestDigest(method, params) {
  if (method === 'personal_sign') {
    return hashMessage(normalizeMessage(params[0]));
  }
  if (method === 'eth_signTypedData_v4') {
    const { domain, types, message } = normalizeTypedData(params[1]);
    return TypedDataEncoder.hash(domain, withoutDomainType(types), message);
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
    if (getSession(safeIndex) === entry) {
      discardSession(safeIndex);
    }
  };
  contents.on('destroyed', drop);
  contents.on('did-navigate', drop);
  entry.detach = () => {
    contents.removeListener('destroyed', drop);
    contents.removeListener('did-navigate', drop);
  };
}

/** The session, but only for the caller holding its token. */
function requireSession(safeIndex, token) {
  const entry = getSession(safeIndex);
  if (!entry) {
    throw new Error('No signature request is open for this account');
  }
  if (token !== entry.token) {
    throw new Error('This signature request belongs to a different page');
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
  if (!entry || token !== entry.token) {
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
 * @returns {Promise<Object>} SafeMessageState (including `token`)
 */
async function startSafeMessage({ safeIndex, request, display, requester }) {
  const record = getSafeRecord(safeIndex);
  // isValidSignature lives on the deployed contract — nothing to verify
  // against before activation.
  if (!record.deployed?.[DEPLOY_CHAIN_ID]) {
    throw new Error('Activate this account on Gnosis before signing for apps');
  }
  const digest = requestDigest(request.method, request.params);
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
    if (existing.hash === hash && sameRequester(existing.requester, requester)) {
      // The identical request from the SAME page again (retried without
      // navigating) — resume: the collected signatures are still valid
      // for this hash.
      return signSafeMessage(safeIndex, undefined, existing.token);
    }
    if (!requesterGone(existing)) {
      // A different request, or the same digest from a DIFFERENT page:
      // never resume or replace someone else's live ceremony.
      throw codedError(
        'Another signature request is already open for this account — finish or cancel it first',
        SAFE_MESSAGE_EXISTS
      );
    }
    // The requesting page provably no longer exists — dead leftover.
    discardSession(safeIndex);
  }

  acquire(safeIndex);
  try {
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
    };
    setSession(safeIndex, entry);
    attachRequesterLifecycle(safeIndex, entry);
    await collectFreeSignatures(store, safeIndex, record.owners);
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
 * @param {number} safeIndex
 * @param {string} token - The session token from startSafeMessage
 * @returns {{signature: string}}
 */
function completeSafeMessage(safeIndex, token) {
  if (isBusy(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  const entry = requireSession(safeIndex, token);
  if (entry.signatures.length < entry.threshold) {
    throw new Error(
      `Not enough signatures yet (${entry.signatures.length} of ${entry.threshold})`
    );
  }
  // buildSignatureBytes sorts its input in place — hand it a copy.
  const signature = buildSignatureBytes(entry.signatures.map((sig) => ({ ...sig })));
  discardSession(safeIndex);
  return { signature };
}

/**
 * Drop the session (collected signatures are thrown away). Idempotent
 * when nothing is open; refused with someone else's token.
 */
function cancelSafeMessage(safeIndex, token) {
  if (isBusy(safeIndex)) {
    throw codedError('Wait for the current step to finish first', SAFE_BUSY);
  }
  if (!getSession(safeIndex)) {
    return; // already gone — cancelling twice is fine
  }
  requireSession(safeIndex, token);
  discardSession(safeIndex);
}

module.exports = {
  startSafeMessage,
  signSafeMessage,
  completeSafeMessage,
  cancelSafeMessage,
  getSafeMessageState,
};
