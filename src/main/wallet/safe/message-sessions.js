/**
 * In-memory SafeMessage session slots, one per Safe wallet index.
 *
 * Split out of safe-messages.js so lifecycle owners with no business in
 * the signing stack (identity-manager deleting a Safe, webContents
 * teardown hooks) can force-drop a session without pulling in ethers/
 * protocol-kit. Entries are opaque here except for `detach`, the hook a
 * session registers to unhook its webContents lifecycle listeners.
 *
 * The requesting page's liveness, which both backends' sessions follow
 * (safe-messages.js on js, core-messages.js on the core), is read here too.
 */

const sessions = new Map();

/** @returns {Object|null} the live session entry for a safe index */
function getSession(safeIndex) {
  return sessions.get(safeIndex) || null;
}

function setSession(safeIndex, entry) {
  sessions.set(safeIndex, entry);
}

/**
 * Force-drop a session regardless of its request token — the trusted
 * cleanup path (Safe deletion, requesting page gone, test reset). A
 * signature ceremony that lands afterwards is dropped by the identity
 * re-check in signature-collection, never attached to a new session.
 *
 * @returns {boolean} whether a session existed
 */
function discardSession(safeIndex) {
  const entry = sessions.get(safeIndex);
  if (!entry) {
    return false;
  }
  sessions.delete(safeIndex);
  try {
    entry.detach?.();
  } catch {
    // webContents already torn down — nothing left to unhook
  }
  return true;
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

module.exports = {
  getSession,
  setSession,
  discardSession,
  requesterWebContents,
  requesterGone,
  watchRequester,
};
