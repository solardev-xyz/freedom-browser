/**
 * Radicle Provider Permissions
 *
 * Manages which origins may act on the user's Radicle node. Two tiers per
 * origin, mirroring the Swarm provider's connection/feed split:
 *  - connection (the permission record existing)
 *  - signing grant (identity disclosure + COB writes)
 *
 * Persisted to disk. Schema per origin:
 *   { origin, connectedAt, lastUsed, signing: false,
 *     autoApprove: { node: false, signing: false } }
 */

const { ipcMain } = require('electron');
const { getFreedomDataPath } = require('../freedom-root');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { isPrivateSender } = require('../private/private-sender');

const PERMISSIONS_FILE = 'radicle-permissions.json';

let permissionsCache = null;

function getPermissionsPath() {
  return getFreedomDataPath(PERMISSIONS_FILE);
}

function loadPermissions() {
  if (permissionsCache !== null) {
    return permissionsCache;
  }

  try {
    const filePath = getPermissionsPath();
    if (fs.existsSync(filePath)) {
      permissionsCache = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } else {
      permissionsCache = {};
    }
  } catch (err) {
    console.error('[RadiclePermissions] Failed to load permissions:', err);
    permissionsCache = {};
  }

  return permissionsCache;
}

function savePermissions() {
  try {
    fs.writeFileSync(getPermissionsPath(), JSON.stringify(permissionsCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[RadiclePermissions] Failed to save permissions:', err);
  }
}

const VALID_AUTO_APPROVE_TYPES = new Set(['node', 'signing']);
const DEFAULT_AUTO_APPROVE = () => ({ node: false, signing: false });

/** @returns {Object|null} Permission data or null */
function getPermission(origin) {
  const permissions = loadPermissions();
  return permissions[normalizeOrigin(origin)] || null;
}

/** Grant connection permission to an origin. */
function grantPermission(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  const now = Date.now();

  const permission = {
    origin: key,
    connectedAt: now,
    lastUsed: now,
    signing: false,
    autoApprove: DEFAULT_AUTO_APPROVE(),
  };

  permissions[key] = permission;
  permissionsCache = permissions;
  savePermissions();

  console.log('[RadiclePermissions] Granted permission to:', key);
  return permission;
}

/** @returns {boolean} True if permission was revoked */
function revokePermission(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (permissions[key]) {
    delete permissions[key];
    permissionsCache = permissions;
    savePermissions();
    console.log('[RadiclePermissions] Revoked permission for:', key);
    notifyRevokeListeners(key);
    return true;
  }

  return false;
}

// Revocation hook: this module is a pure permission store. Main's page
// requests register here to tell a revoked site's pages (`disconnect`,
// src/main/page/page-radicle.js), whichever path revoked it.
const revokeListeners = new Set();

/**
 * Hear every revoked connection, with its normalized key. `null` forgets
 * every listener (tests). Returns a function that stops it.
 */
function onRevoke(listener) {
  if (listener === null) {
    revokeListeners.clear();
    return () => {};
  }
  if (typeof listener !== 'function') return () => {};
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}

function notifyRevokeListeners(key) {
  for (const listener of revokeListeners) {
    try {
      listener(key);
    } catch (err) {
      console.error('[RadiclePermissions] Revoke listener failed:', err);
    }
  }
}

/** @returns {Object[]} All permissions, sorted by lastUsed desc */
function getAllPermissions() {
  return Object.values(loadPermissions()).sort((a, b) => b.lastUsed - a.lastUsed);
}

/** @returns {boolean} True if updated */
function updateLastUsed(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (permissions[key]) {
    const now = Date.now();
    // lastUsed is a coarse "when was this dApp active" signal — skip the
    // disk write while it's fresh, so cheap polling methods (seed status)
    // don't rewrite the JSON every couple of seconds.
    if (now - (permissions[key].lastUsed || 0) < 60000) return true;
    permissions[key].lastUsed = now;
    permissionsCache = permissions;
    savePermissions();
    return true;
  }

  return false;
}

/** Signing tier: identity disclosure + COB writes. Requires connection. */
function hasSigningGrant(origin) {
  return getPermission(origin)?.signing === true;
}

/** @returns {boolean} True if granted (false when origin not connected) */
function grantSigning(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]) return false;

  permissions[key].signing = true;
  permissionsCache = permissions;
  savePermissions();
  console.log('[RadiclePermissions] Signing grant for:', key);
  return true;
}

function getAutoApprove(origin, type) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;
  return getPermission(origin)?.autoApprove?.[type] === true;
}

function setAutoApprove(origin, type, enabled) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;

  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]) return false;

  if (!permissions[key].autoApprove) {
    permissions[key].autoApprove = DEFAULT_AUTO_APPROVE();
  }
  permissions[key].autoApprove[type] = enabled;
  permissionsCache = permissions;
  savePermissions();

  console.log(
    `[RadiclePermissions] Auto-approve ${type} ${enabled ? 'enabled' : 'disabled'} for:`,
    key
  );
  return true;
}

// The chrome's grant writes main refuses (freedom-core design 0011,
// "Grants"; PRQ-8a): a connection is written by main itself, for the key it
// attested, from the user's decision on the prompt it issued.
const GRANT_REFUSED = 'A Radicle connection is granted only from its own prompt';
// PRQ-8b: the node rule is read by main, which never turns it on: no prompt
// offers it, as none did before. The chrome may only turn it off.
const NODE_RULE_REFUSED = 'Radicle node auto-approve can only be turned off here';
// PRQ-8c: the signing grant and the signing rule are written by main, from
// its own prompts. The chrome may only turn the rule off, and revoke.
const SIGNING_GRANT_REFUSED = 'The Radicle signing grant is given only from its own prompt';
const SIGNING_RULE_REFUSED = 'Radicle signing auto-approve is turned on only from a write prompt';

function registerRadiclePermissionsIpc() {
  // PRIVATE MODE GUARD (R-9): a private window's sites are never recorded on
  // disk. A rule turned off from a private (or unclassifiable) sender
  // answers false and writes nothing. Revoking stays open, since it removes
  // a record.
  ipcMain.handle(IPC.RADICLE_GET_PERMISSION, (_event, origin) => getPermission(origin));
  // Refused for every site and every sender (design 0011, "Grants";
  // PRQ-8a): the chrome named the site here, so a compromised chrome could
  // connect any site. Revoking stays open: it only narrows.
  ipcMain.handle(IPC.RADICLE_GRANT_PERMISSION, () => {
    throw new Error(GRANT_REFUSED);
  });
  ipcMain.handle(IPC.RADICLE_REVOKE_PERMISSION, (_event, origin) => revokePermission(origin));
  ipcMain.handle(IPC.RADICLE_GET_ALL_PERMISSIONS, () => getAllPermissions());
  // Refused for every site and every sender (PRQ-8c): main grants signing
  // for the key it attested, from the user's decision on its prompt.
  ipcMain.handle(IPC.RADICLE_GRANT_SIGNING, () => {
    throw new Error(SIGNING_GRANT_REFUSED);
  });
  // Every rule only off, for every sender (design 0011, "Grants"; PRQ-8b
  // for the node rule, PRQ-8c for the signing rule): any value but `false`
  // is refused, so a truthy non-boolean can't turn one on.
  ipcMain.handle(IPC.RADICLE_SET_AUTO_APPROVE, (event, origin, type, enabled) => {
    if (enabled !== false) throw new Error(type === 'node' ? NODE_RULE_REFUSED : SIGNING_RULE_REFUSED);
    return isPrivateSender(event) ? false : setAutoApprove(origin, type, enabled);
  });

  console.log('[RadiclePermissions] IPC handlers registered');
}

// Exported for testing
function _resetCache() {
  permissionsCache = null;
}

module.exports = {
  getPermission,
  grantPermission,
  revokePermission,
  getAllPermissions,
  updateLastUsed,
  hasSigningGrant,
  grantSigning,
  getAutoApprove,
  setAutoApprove,
  onRevoke,
  registerRadiclePermissionsIpc,
  GRANT_REFUSED,
  NODE_RULE_REFUSED,
  SIGNING_GRANT_REFUSED,
  SIGNING_RULE_REFUSED,
  _resetCache,
};
