/**
 * In-memory SafeMessage session slots, one per Safe wallet index.
 *
 * Split out of safe-messages.js so lifecycle owners with no business in
 * the signing stack (identity-manager deleting a Safe, webContents
 * teardown hooks) can force-drop a session without pulling in ethers/
 * protocol-kit. Entries are opaque here except for `detach`, the hook a
 * session registers to unhook its webContents lifecycle listeners.
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

module.exports = { getSession, setSession, discardSession };
