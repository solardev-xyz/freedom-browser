/**
 * Publish pick tokens
 *
 * swarm:publish-file / swarm:publish-directory never take a filesystem path
 * from a renderer. The pickers (swarm:pick-file / swarm:pick-directory) keep
 * the path the user chose in the native dialog here, in the main process, and
 * hand the renderer an opaque token instead. A publish handler then trades the
 * token back for the path.
 *
 * A token is:
 *   - single use: redeeming it removes it, whether or not the publish works;
 *   - short-lived: it expires TOKEN_TTL_MS after the pick;
 *   - bound to the webContents that picked (a token minted for one page is
 *     refused from any other sender) and to the kind of pick (a file token
 *     cannot publish a directory and vice versa).
 *
 * So a script running in an internal page can publish only what the user
 * just chose in a dialog, never an arbitrary path such as ~/.ssh (S-7, #660).
 */

const crypto = require('crypto');

// Between a pick and its publish there is only a readiness check, so a few
// minutes is ample; anything older is a stale page, and a fresh pick is one
// click away.
const TOKEN_TTL_MS = 5 * 60 * 1000;

function createPickTokenStore({ now = () => Date.now(), ttlMs = TOKEN_TTL_MS } = {}) {
  const entries = new Map();

  function sweep() {
    const t = now();
    for (const [token, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(token);
    }
  }

  // Remember `filePath` for `senderId` and return the token naming it.
  function mint({ path: filePath, kind, senderId }) {
    if (typeof filePath !== 'string' || !filePath) throw new Error('path is required');
    if (kind !== 'file' && kind !== 'directory') throw new Error(`unknown kind: ${kind}`);
    if (!Number.isInteger(senderId)) throw new Error('senderId is required');
    sweep();
    const token = crypto.randomBytes(32).toString('hex');
    entries.set(token, { path: filePath, kind, senderId, expiresAt: now() + ttlMs });
    return token;
  }

  // Trade a token back for its path. Returns { path } or { error }. The token
  // is spent on any lookup that finds it, so a refused attempt (wrong sender,
  // wrong kind) cannot be retried either.
  function redeem(token, { kind, senderId }) {
    sweep();
    if (typeof token !== 'string' || !entries.has(token)) {
      return { error: 'invalid' };
    }
    const entry = entries.get(token);
    entries.delete(token);
    if (entry.senderId !== senderId || entry.kind !== kind) {
      return { error: 'invalid' };
    }
    return { path: entry.path };
  }

  // Drop every token a webContents holds (it was destroyed).
  function revokeSender(senderId) {
    for (const [token, entry] of entries) {
      if (entry.senderId === senderId) entries.delete(token);
    }
  }

  return { mint, redeem, revokeSender, size: () => entries.size };
}

module.exports = { createPickTokenStore, TOKEN_TTL_MS };
