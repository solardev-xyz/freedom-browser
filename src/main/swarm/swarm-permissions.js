/**
 * Swarm Provider Permissions
 *
 * Manages which origins have been granted permission to publish through
 * the user's Swarm node. Separate from dApp wallet permissions — Swarm
 * permissions consume storage/bandwidth, wallet permissions expose accounts.
 *
 * Permissions are persisted to disk. Schema per origin:
 *   { origin, connectedAt, lastUsed, autoApprove: { publish: false, feeds: false } }
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');

const PERMISSIONS_FILE = 'swarm-permissions.json';

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
      const data = fs.readFileSync(filePath, 'utf-8');
      permissionsCache = JSON.parse(data);
    } else {
      permissionsCache = {};
    }
  } catch (err) {
    console.error('[SwarmPermissions] Failed to load permissions:', err);
    permissionsCache = {};
  }

  return permissionsCache;
}

function savePermissions() {
  try {
    const filePath = getPermissionsPath();
    fs.writeFileSync(filePath, JSON.stringify(permissionsCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[SwarmPermissions] Failed to save permissions:', err);
  }
}

/**
 * Check if an origin has Swarm publishing permission.
 * @param {string} origin
 * @returns {Object|null} Permission data or null
 */
function getPermission(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  return permissions[key] || null;
}

/**
 * Grant Swarm publishing permission to an origin.
 * @param {string} origin
 * @returns {Object} The created permission
 */
function grantPermission(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  const now = Date.now();

  const permission = {
    origin: key,
    connectedAt: now,
    lastUsed: now,
    autoApprove: DEFAULT_AUTO_APPROVE(),
  };

  permissions[key] = permission;
  permissionsCache = permissions;
  savePermissions();

  console.log('[SwarmPermissions] Granted permission to:', key);
  return permission;
}

/**
 * Revoke Swarm publishing permission for an origin.
 * @param {string} origin
 * @returns {boolean} True if permission was revoked
 */
function revokePermission(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (permissions[key]) {
    delete permissions[key];
    permissionsCache = permissions;
    savePermissions();
    console.log('[SwarmPermissions] Revoked permission for:', key);
    return true;
  }

  return false;
}

/**
 * Get all granted Swarm permissions.
 * @returns {Object[]} Array of permission objects, sorted by lastUsed desc
 */
function getAllPermissions() {
  const permissions = loadPermissions();
  return Object.values(permissions).sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * Update the last used timestamp for an origin.
 * @param {string} origin
 * @returns {boolean} True if updated
 */
function updateLastUsed(origin) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (permissions[key]) {
    permissions[key].lastUsed = Date.now();
    permissionsCache = permissions;
    savePermissions();
    return true;
  }

  return false;
}

const VALID_AUTO_APPROVE_TYPES = new Set(['publish', 'feeds']);
const DEFAULT_AUTO_APPROVE = () => ({ publish: false, feeds: false });

/**
 * Check if an auto-approve type is enabled for an origin.
 * @param {string} origin
 * @param {'publish'|'feeds'} type
 * @returns {boolean}
 */
function getAutoApprove(origin, type) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;
  const permission = getPermission(origin);
  return permission?.autoApprove?.[type] === true;
}

/**
 * Set an auto-approve type for an origin.
 * @param {string} origin
 * @param {'publish'|'feeds'} type
 * @param {boolean} enabled
 * @returns {boolean} True if updated
 */
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

  console.log(`[SwarmPermissions] Auto-approve ${type} ${enabled ? 'enabled' : 'disabled'} for:`, key);
  return true;
}

/**
 * Register IPC handlers for Swarm permissions.
 */
function registerSwarmPermissionsIpc() {
  ipcMain.handle(IPC.SWARM_GET_PERMISSION, (_event, origin) => {
    return getPermission(origin);
  });

  ipcMain.handle(IPC.SWARM_GRANT_PERMISSION, (_event, origin) => {
    return grantPermission(origin);
  });

  ipcMain.handle(IPC.SWARM_REVOKE_PERMISSION, (_event, origin) => {
    return revokePermission(origin);
  });

  ipcMain.handle(IPC.SWARM_GET_ALL_PERMISSIONS, () => {
    return getAllPermissions();
  });

  ipcMain.handle(IPC.SWARM_UPDATE_LAST_USED, (_event, origin) => {
    return updateLastUsed(origin);
  });

  ipcMain.handle(IPC.SWARM_GET_AUTO_APPROVE, (_event, origin, type) => {
    return getAutoApprove(origin, type);
  });

  ipcMain.handle(IPC.SWARM_SET_AUTO_APPROVE, (_event, origin, type, enabled) => {
    return setAutoApprove(origin, type, enabled);
  });

  console.log('[SwarmPermissions] IPC handlers registered');
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
  getAutoApprove,
  setAutoApprove,
  registerSwarmPermissionsIpc,
  _resetCache,
};
