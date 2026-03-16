/**
 * Swarm Provider Permissions
 *
 * Manages which origins have been granted permission to publish through
 * the user's Swarm node. Separate from dApp wallet permissions — Swarm
 * permissions consume storage/bandwidth, wallet permissions expose accounts.
 *
 * Permissions are persisted to disk. Schema per origin:
 *   { origin, connectedAt, lastUsed, autoPublish: false }
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
    autoPublish: false,
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
  registerSwarmPermissionsIpc,
  _resetCache,
};
