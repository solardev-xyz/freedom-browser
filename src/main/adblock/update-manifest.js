/**
 * Pure verification of the Swarm-feed filter-list manifest (WP5 5.B1).
 *
 * No I/O, no Swarm, no engine — just: is this manifest well-formed, authentic,
 * and newer than what we've applied? The update-manager (5.B2) does the feed
 * read, blob download, and engine rebuild around these checks.
 *
 * The manifest shape and the signing scheme are the cross-repo contract with
 * freedom-adblock-service/src/manifest.ts. `canonicalManifestForSigning` here
 * MUST produce byte-identical output to the publisher's function of the same
 * name, or every signature check fails.
 */

const { verifyMessage, getAddress } = require('ethers');
const { MANIFEST_SCHEMA } = require('./feed-config');

/** Recursively sort object keys so serialization is deterministic. */
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortDeep(value[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * The exact bytes `sig` is computed and verified over: the manifest without
 * its `sig` field, keys recursively sorted, compact. Mirror of the publisher's
 * canonicalManifestForSigning — keep the two in lockstep.
 */
function canonicalManifestForSigning(manifest) {
  const rest = { ...manifest };
  delete rest.sig;
  return JSON.stringify(sortDeep(rest));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0;
}

// Field formats for desktop list entries (contract: DesktopListEntry in
// freedom-adblock-service/src/manifest.ts). `list_id` names the output file
// (`<list_id>.txt`) the update-manager writes, so it must be a plain filename
// token — no separators, no dots, nothing that could path-escape the staging
// dir. `ref` is a bzz hex reference (64 hex chars, 128 when encrypted) and
// `sha256` a hex digest; anything else is malformed even if correctly signed.
const LIST_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CATEGORY_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SWARM_REF_RE = /^[0-9a-f]{64}(?:[0-9a-f]{64})?$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function isOptionalString(value) {
  return value === undefined || value === null || typeof value === 'string';
}

/** Strict shape check for one desktop list entry — see field notes above. */
function isValidDesktopListEntry(entry) {
  return (
    isPlainObject(entry) &&
    typeof entry.category === 'string' &&
    CATEGORY_RE.test(entry.category) &&
    typeof entry.list_id === 'string' &&
    LIST_ID_RE.test(entry.list_id) &&
    typeof entry.ref === 'string' &&
    SWARM_REF_RE.test(entry.ref) &&
    typeof entry.sha256 === 'string' &&
    SHA256_RE.test(entry.sha256) &&
    isPositiveInt(entry.bytes) &&
    Number.isInteger(entry.rule_count) &&
    entry.rule_count >= 0 &&
    isOptionalString(entry.title) &&
    isOptionalString(entry.source_url) &&
    isOptionalString(entry.license)
  );
}

/**
 * Validate and authenticate a manifest.
 *
 * @param {object} manifest - Parsed feed payload.
 * @param {object} opts
 * @param {string} opts.sigAddress - Pinned signer address (MANIFEST_SIG_ADDRESS).
 * @param {number} opts.appliedVersion - Highest version already applied (0 if none).
 * @param {boolean} [opts.allowRepublish] - Accept the applied version again
 *   (not anything older): used to backfill a category that wasn't enabled —
 *   and so wasn't downloaded — when that version was first applied.
 * @returns {{ ok: boolean, reason?: string, version?: number }}
 */
function verifyManifest(manifest, { sigAddress, appliedVersion = 0, allowRepublish = false }) {
  if (!isPlainObject(manifest)) return { ok: false, reason: 'not_an_object' };
  if (manifest.schema !== MANIFEST_SCHEMA) return { ok: false, reason: 'schema_mismatch' };
  if (!isPositiveInt(manifest.version)) return { ok: false, reason: 'bad_version' };
  if (typeof manifest.generated_at !== 'string') return { ok: false, reason: 'bad_generated_at' };

  const desktop = manifest.platforms?.desktop;
  if (!isPlainObject(desktop) || !Array.isArray(desktop.lists)) {
    return { ok: false, reason: 'bad_desktop_section' };
  }
  // Every entry is validated before anything downstream trusts its fields —
  // a signature only proves who published the manifest, not that its
  // contents are safe to act on.
  if (!desktop.lists.every(isValidDesktopListEntry)) {
    return { ok: false, reason: 'bad_list_entry' };
  }
  // Duplicate list_ids would write the same `<list_id>.txt` twice, leaving a
  // file whose bytes no longer match the first entry's recorded sha256.
  if (new Set(desktop.lists.map((e) => e.list_id)).size !== desktop.lists.length) {
    return { ok: false, reason: 'duplicate_list_id' };
  }

  // Downgrade protection: never move backward. The current version is also
  // rejected as a replay unless the caller is backfilling from it.
  const floor = allowRepublish ? appliedVersion - 1 : appliedVersion;
  if (manifest.version <= floor) {
    return { ok: false, reason: 'not_newer', version: manifest.version };
  }

  if (typeof manifest.sig !== 'string' || !manifest.sig) {
    return { ok: false, reason: 'missing_sig' };
  }

  let recovered;
  try {
    recovered = verifyMessage(canonicalManifestForSigning(manifest), manifest.sig);
  } catch {
    return { ok: false, reason: 'bad_sig' };
  }
  if (getAddress(recovered) !== getAddress(sigAddress)) {
    return { ok: false, reason: 'wrong_signer' };
  }

  return { ok: true, version: manifest.version };
}

/**
 * The desktop list entries for the currently-enabled categories, in the order
 * the manifest lists them. A category the manifest doesn't carry is skipped.
 *
 * @param {object} manifest - A manifest that has passed verifyManifest.
 * @param {Set<string>|string[]} enabledCategories - e.g. ['ads','privacy'].
 * @returns {Array<object>} desktop list entries
 */
function desktopListsFor(manifest, enabledCategories) {
  const enabled = new Set(enabledCategories);
  return manifest.platforms.desktop.lists.filter((entry) => enabled.has(entry.category));
}

module.exports = {
  canonicalManifestForSigning,
  verifyManifest,
  desktopListsFor,
};
