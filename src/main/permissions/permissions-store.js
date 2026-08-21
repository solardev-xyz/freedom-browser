/**
 * Site Permissions Store
 *
 * Persists per-origin web-permission decisions ("allow"/"deny") for the
 * active profile in `<userData>/permissions.json`:
 *
 *   { "<origin>": { "<permission>": "allow" | "deny" } }
 *
 * Origins are normalized with the shared permission-key rules
 * (src/shared/origin-utils.js), the same representation the dApp and
 * Swarm permission stores use — so `bzz://name.eth` keys as `name.eth`
 * while a raw hash keys as `bzz://<hash>`, and web2 + web3 permissions
 * agree on what a "site" is.
 *
 * Session-only (unremembered) decisions never reach this store — they
 * live in the permissions manager's in-memory map.
 */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { normalizeOrigin } = require('../../shared/origin-utils');

const PERMISSIONS_FILE = 'permissions.json';
const VALID_DECISIONS = new Set(['allow', 'deny']);

// In-memory cache of decisions
let permissionsCache = null;

function getPermissionsPath() {
  return path.join(app.getPath('userData'), PERMISSIONS_FILE);
}

/**
 * Load all stored decisions from disk (cached after first read).
 * @returns {Object} Map of origin -> { permission: 'allow'|'deny' }
 */
function loadPermissions() {
  if (permissionsCache !== null) {
    return permissionsCache;
  }

  try {
    const filePath = getPermissionsPath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      permissionsCache = parsed && typeof parsed === 'object' ? parsed : {};
    } else {
      permissionsCache = {};
    }
  } catch (err) {
    console.error('[SitePermissions] Failed to load permissions:', err);
    permissionsCache = {};
  }

  return permissionsCache;
}

function savePermissions() {
  try {
    const filePath = getPermissionsPath();
    fs.writeFileSync(filePath, JSON.stringify(permissionsCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[SitePermissions] Failed to save permissions:', err);
  }
}

/**
 * Get the stored decision for an origin + permission.
 * @param {string} origin
 * @param {string} permission - Storage key (e.g. 'camera', 'notifications')
 * @returns {'allow'|'deny'|null}
 */
function getDecision(origin, permission) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  const decision = permissions[key]?.[permission];
  return VALID_DECISIONS.has(decision) ? decision : null;
}

/**
 * Store a decision for an origin + permission.
 * @param {string} origin
 * @param {string} permission
 * @param {'allow'|'deny'} decision
 * @returns {boolean} True when stored
 */
function setDecision(origin, permission, decision) {
  if (!VALID_DECISIONS.has(decision)) return false;
  if (!permission || typeof permission !== 'string') return false;

  const key = normalizeOrigin(origin);
  if (!key) return false;

  const permissions = loadPermissions();
  // Self-heal a hand-edited file mapping an origin to a non-object —
  // assigning onto a string primitive would silently no-op (sloppy mode)
  // while this function still reports success.
  if (
    !permissions[key] ||
    typeof permissions[key] !== 'object' ||
    Array.isArray(permissions[key])
  ) {
    permissions[key] = {};
  }
  permissions[key][permission] = decision;
  permissionsCache = permissions;
  savePermissions();
  return true;
}

/**
 * Remove the stored decision for an origin + permission.
 * @returns {boolean} True when a decision was removed
 */
function removeDecision(origin, permission) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (!permissions[key] || !(permission in permissions[key])) {
    return false;
  }

  delete permissions[key][permission];
  if (Object.keys(permissions[key]).length === 0) {
    delete permissions[key];
  }
  permissionsCache = permissions;
  savePermissions();
  return true;
}

/**
 * Remove all stored decisions for an origin.
 * @returns {boolean} True when the origin had decisions
 */
function removeOrigin(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (!permissions[key]) return false;

  delete permissions[key];
  permissionsCache = permissions;
  savePermissions();
  return true;
}

/**
 * Remove every stored decision.
 */
function clearAll() {
  permissionsCache = {};
  savePermissions();
}

/**
 * Get a deep copy of all stored decisions.
 * @returns {Object} Map of origin -> { permission: 'allow'|'deny' }
 */
function getAllDecisions() {
  const permissions = loadPermissions();
  const copy = {};
  for (const [origin, decisions] of Object.entries(permissions)) {
    copy[origin] = { ...decisions };
  }
  return copy;
}

function _resetCache() {
  permissionsCache = null;
}

module.exports = {
  loadPermissions,
  getDecision,
  setDecision,
  removeDecision,
  removeOrigin,
  clearAll,
  getAllDecisions,
  _resetCache,
};
