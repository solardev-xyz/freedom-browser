/**
 * Origin Normalization Utilities
 *
 * Shared origin normalization for permission keying. Used by the main process
 * for swarm-permissions and swarm-provider-ipc. The renderer has an identical
 * copy in src/renderer/lib/origin-utils.js (ES modules cannot require() this
 * file; keep both in sync — see origin-utils.test.js in that directory).
 *
 * Rules (security-critical, locked down in swarm-publishing-research.md):
 *
 *   ens://myapp.eth/#/path  → myapp.eth       (ENS name, lowercased)
 *   myapp.eth/blog          → myapp.eth        (bare ENS)
 *   bzz://abc123/page       → bzz://abc123     (root ref, path-insensitive)
 *   ipfs://QmABC/docs       → ipfs://QmABC     (root CID, path-insensitive)
 *   ipns://host/guide       → ipns://host      (hostname, path-insensitive)
 *   rad://z123/tree         → rad://z123       (RID, path-insensitive)
 *   https://app.example.com → https://app.example.com
 */

/**
 * Extract the permission key from a display URL.
 * Returns the root content identity, never including paths.
 *
 * @param {string} displayUrl
 * @returns {string|null}
 */
function getPermissionKey(displayUrl) {
  if (!displayUrl) return null;

  const trimmed = displayUrl.trim();
  if (!trimmed) return null;

  // ENS name without protocol (e.g., 1inch.eth/path)
  if (/^[a-z0-9-]+\.(eth|box)/i.test(trimmed)) {
    return trimmed.split('/')[0].toLowerCase();
  }

  // ens:// protocol → extract ENS name (e.g., ens://1inch.eth/#/path → 1inch.eth)
  const ensMatch = trimmed.match(/^ens:\/\/([^/#]+)/i);
  if (ensMatch) {
    return ensMatch[1].toLowerCase();
  }

  // dweb protocols: ipfs://CID/path → ipfs://CID
  const dwebMatch = trimmed.match(/^(ipfs|bzz|ipns):\/\/([^/]+)/i);
  if (dwebMatch) {
    return `${dwebMatch[1].toLowerCase()}://${dwebMatch[2]}`;
  }

  // rad:// protocol
  const radMatch = trimmed.match(/^rad:\/\/([^/]+)/i);
  if (radMatch) {
    return `rad://${radMatch[1]}`;
  }

  // Regular URL (https://host/path → https://host)
  try {
    const url = new URL(trimmed);
    if (url.origin === 'null') {
      return trimmed;
    }
    return url.origin;
  } catch {
    return trimmed;
  }
}

/**
 * Normalize an origin for permission storage lookup.
 * Same logic as getPermissionKey — named for clarity in permission store context.
 *
 * @param {string} origin
 * @returns {string}
 */
function normalizeOrigin(origin) {
  return getPermissionKey(origin) || '';
}

module.exports = { getPermissionKey, normalizeOrigin };
