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

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');

const PERMISSIONS_FILE = 'radicle-permissions.json';

let permissionsCache = null;

function getPermissionsPath() {
  return path.join(app.getPath('userData'), PERMISSIONS_FILE);
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
    return true;
  }

  return false;
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

function registerRadiclePermissionsIpc() {
  ipcMain.handle(IPC.RADICLE_GET_PERMISSION, (_event, origin) => getPermission(origin));
  ipcMain.handle(IPC.RADICLE_GRANT_PERMISSION, (_event, origin) => grantPermission(origin));
  ipcMain.handle(IPC.RADICLE_REVOKE_PERMISSION, (_event, origin) => revokePermission(origin));
  ipcMain.handle(IPC.RADICLE_GET_ALL_PERMISSIONS, () => getAllPermissions());
  ipcMain.handle(IPC.RADICLE_UPDATE_LAST_USED, (_event, origin) => updateLastUsed(origin));
  ipcMain.handle(IPC.RADICLE_HAS_SIGNING_GRANT, (_event, origin) => hasSigningGrant(origin));
  ipcMain.handle(IPC.RADICLE_GRANT_SIGNING, (_event, origin) => grantSigning(origin));
  ipcMain.handle(IPC.RADICLE_GET_AUTO_APPROVE, (_event, origin, type) =>
    getAutoApprove(origin, type)
  );
  ipcMain.handle(IPC.RADICLE_SET_AUTO_APPROVE, (_event, origin, type, enabled) =>
    setAutoApprove(origin, type, enabled)
  );

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
  registerRadiclePermissionsIpc,
  _resetCache,
};
