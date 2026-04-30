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
 *   bzz://myapp.eth/page    → myapp.eth        (transport-aware ENS, name-keyed)
 *   ipfs://QmABC/docs       → ipfs://QmABC     (root CID, path-insensitive)
 *   ipfs://myapp.eth/docs   → myapp.eth        (transport-aware ENS, name-keyed)
 *   ipns://host/guide       → ipns://host      (hostname, path-insensitive)
 *   ipns://myapp.eth/guide  → myapp.eth        (transport-aware ENS, name-keyed)
 *   rad://z123/tree         → rad://z123       (RID, path-insensitive)
 *   https://app.example.com → https://app.example.com
 *
 * The ENS-host carve-out for transport URLs keeps permissions stable across
 * the legacy `ens://` form and the new transport-aware display: a user who
 * granted a permission to `myapp.eth` via `ens://myapp.eth` still has it
 * after the address bar starts displaying the same site as `bzz://myapp.eth`.
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
  // ENS-host carve-out: bzz://name.eth/path → name.eth (same key as the
  // legacy ens://name.eth form, so permissions don't fork across transport
  // and legacy displays of the same site).
  const dwebMatch = trimmed.match(/^(ipfs|bzz|ipns):\/\/([^/]+)/i);
  if (dwebMatch) {
    const host = dwebMatch[2];
    const lowerHost = host.toLowerCase();
    if (lowerHost.endsWith('.eth') || lowerHost.endsWith('.box')) {
      return lowerHost;
    }
    return `${dwebMatch[1].toLowerCase()}://${host}`;
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
