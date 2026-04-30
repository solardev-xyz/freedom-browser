/**
 * Origin Normalization Utilities (Renderer)
 *
 * ESM copy of src/shared/origin-utils.js. The shared file is CommonJS and
 * cannot be imported directly by the renderer (script type="module" context
 * with no Node require). Both implementations MUST stay in sync; drift is
 * guarded against by src/renderer/lib/origin-utils.test.js which asserts
 * equivalence across a battery of inputs.
 *
 * Rules (must match shared/origin-utils.js exactly):
 *
 *   ens://myapp.eth/#/path  → myapp.eth       (ENS name, lowercased)
 *   myapp.eth/blog          → myapp.eth        (bare ENS)
 *   bzz://abc123/page       → bzz://abc123     (root ref)
 *   bzz://myapp.eth/page    → myapp.eth        (transport ENS — name-keyed)
 *   ipfs://QmABC/docs       → ipfs://QmABC     (root CID)
 *   ipfs://myapp.eth/docs   → myapp.eth        (transport ENS — name-keyed)
 *   ipns://host/guide       → ipns://host      (hostname)
 *   ipns://myapp.eth/guide  → myapp.eth        (transport ENS — name-keyed)
 *   rad://z123/tree         → rad://z123       (RID)
 *   https://app.example.com → https://app.example.com
 */

/**
 * True when `host` looks like an ENS name (ends in `.eth` or `.box`).
 * Single source of truth for the ENS TLD set across the renderer.
 *
 * @param {string} host
 * @returns {boolean}
 */
export function isEnsHost(host) {
  if (!host || typeof host !== 'string') return false;
  const lower = host.toLowerCase();
  return lower.endsWith('.eth') || lower.endsWith('.box');
}

/**
 * Extract the permission key from a display URL.
 * Returns the root content identity, never including paths.
 *
 * @param {string} displayUrl
 * @returns {string|null}
 */
export function getPermissionKey(displayUrl) {
  if (!displayUrl) return null;

  const trimmed = displayUrl.trim();
  if (!trimmed) return null;

  // ENS name without protocol (e.g., 1inch.eth/path).
  // Split on /, ?, and # so that hash-routed SPAs (`name.eth#/swap`) and
  // share-link queries (`name.eth?ref=...`) collapse to the same key as
  // the canonical bare name.
  if (/^[a-z0-9-]+\.(eth|box)/i.test(trimmed)) {
    return trimmed.split(/[/?#]/, 1)[0].toLowerCase();
  }

  // ens:// protocol → extract ENS name (e.g., ens://1inch.eth/#/path → 1inch.eth)
  const ensMatch = trimmed.match(/^ens:\/\/([^/?#]+)/i);
  if (ensMatch) {
    return ensMatch[1].toLowerCase();
  }

  // dweb protocols: ipfs://CID/path → ipfs://CID
  // ENS-host carve-out: bzz://name.eth/path → name.eth (same key as the
  // legacy ens://name.eth form, so permissions don't fork across transport
  // and legacy displays of the same site). The host pattern excludes
  // ?, # and / so query/fragment components don't fork the key per route.
  const dwebMatch = trimmed.match(/^(ipfs|bzz|ipns):\/\/([^/?#]+)/i);
  if (dwebMatch) {
    const host = dwebMatch[2];
    if (isEnsHost(host)) {
      return host.toLowerCase();
    }
    return `${dwebMatch[1].toLowerCase()}://${host}`;
  }

  // rad:// protocol
  const radMatch = trimmed.match(/^rad:\/\/([^/?#]+)/i);
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
export function normalizeOrigin(origin) {
  return getPermissionKey(origin) || '';
}
