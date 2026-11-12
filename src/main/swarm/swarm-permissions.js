/**
 * Swarm Provider Permissions
 *
 * Manages which origins have been granted permission to publish through
 * the user's Swarm node. Separate from dApp wallet permissions — Swarm
 * permissions consume storage/bandwidth, wallet permissions expose accounts.
 *
 * Permissions are persisted to disk. Schema per origin:
 *   { origin, connectedAt, lastUsed,
 *     autoApprove: { publish: false, feeds: false, signing: false, messaging: false },
 *     messaging?: { grantedAt } }
 *
 * `messaging` is the messaging-tier grant (PSS/GSOC subscribe + send +
 * identity disclosure); `autoApprove.messaging` additionally skips the
 * per-send prompt for granted origins.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { withOriginLock } = require('./origin-mutation-lock');

const PERMISSIONS_FILE = 'swarm-permissions.json';

// The chrome's grant writes main refuses (freedom-core design 0011,
// "Grants"; PRQ-7b): main writes them itself, for the key it attested, from
// the user's decision on the prompt it issued (page/page-swarm.js).
const GRANT_REFUSED = 'A Swarm connection is granted only from its own prompt';
const MESSAGING_GRANT_REFUSED = 'Swarm messaging is granted only from its own prompt';
const MESSAGING_RULE_REFUSED = 'Messaging auto-approve is turned on only from a messaging prompt';
const PUBLISH_RULE_REFUSED = 'Publish auto-approve is turned on only from a publish prompt';
const FEEDS_RULE_REFUSED = 'Feed auto-approve is turned on only from a feed prompt';
const SIGNING_RULE_REFUSED = 'Signing auto-approve is turned on only from a signing prompt';
const RULE_REFUSED = 'Swarm auto-approve is turned on only from its own prompt';
// Every rule is main's alone to turn on, from the user's "always allow" on
// the prompt it showed (freedom-core design 0011, "Grants"): messaging from
// PRQ-7b, publishing from PRQ-7c, feeds and signing from PRQ-7d.
const RULES_ONLY_FROM_MAIN = Object.freeze({
  messaging: MESSAGING_RULE_REFUSED,
  publish: PUBLISH_RULE_REFUSED,
  feeds: FEEDS_RULE_REFUSED,
  signing: SIGNING_RULE_REFUSED,
});

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
  const filePath = getPermissionsPath();
  const tempPath = `${filePath}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(permissionsCache, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    permissionsCache = null;
    throw err;
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
function revokePermission(origin, { source = 'user' } = {}) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (permissions[key]) {
    delete permissions[key];
    permissionsCache = permissions;
    savePermissions();
    notifyRevokeListeners(key);
    if (source === 'user') notifyManifestMutation(key, 'connection');
    console.log('[SwarmPermissions] Revoked permission for:', key);
    return true;
  }

  return false;
}

// Revocation hook — this module is a pure permission store; live-resource
// teardown (e.g. cancelling messaging subscriptions) is owned by the
// provider layer, which registers itself here at startup.
const revokeListeners = new Set();
let manifestMutationListener = null;

function onRevoke(listener) {
  if (listener === null) {
    revokeListeners.clear();
    return () => {};
  }
  if (typeof listener !== 'function') return () => {};
  revokeListeners.add(listener);
  return () => revokeListeners.delete(listener);
}

function onManifestMutation(listener) {
  manifestMutationListener = listener;
}

function notifyManifestMutation(origin, projectionKey) {
  manifestMutationListener?.(origin, projectionKey);
}

function notifyRevokeListeners(origin) {
  for (const listener of revokeListeners) {
    try {
      listener(origin);
    } catch (err) {
      console.error('[SwarmPermissions] Revoke listener failed:', err);
    }
  }
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

const VALID_AUTO_APPROVE_TYPES = new Set(['publish', 'feeds', 'signing', 'messaging']);
const DEFAULT_AUTO_APPROVE = () => ({
  publish: false,
  feeds: false,
  signing: false,
  messaging: false,
});

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
function setAutoApprove(origin, type, enabled, { source = 'user' } = {}) {
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
  if (source === 'user') notifyManifestMutation(key, `autoApprove.${type}`);

  console.log(`[SwarmPermissions] Auto-approve ${type} ${enabled ? 'enabled' : 'disabled'} for:`, key);
  return true;
}

/**
 * Grant the messaging tier (PSS/GSOC) to an already-connected origin.
 * @param {string} origin
 * @returns {boolean} True if granted
 */
function grantMessaging(origin, { source = 'user' } = {}) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (!permissions[key]) return false;

  permissions[key].messaging = { grantedAt: Date.now() };
  permissionsCache = permissions;
  savePermissions();
  if (source === 'user') notifyManifestMutation(key, 'messagingGrant');

  console.log('[SwarmPermissions] Messaging granted for:', key);
  return true;
}

function revokeMessaging(origin, { source = 'user' } = {}) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]?.messaging) return false;

  delete permissions[key].messaging;
  if (permissions[key].autoApprove) permissions[key].autoApprove.messaging = false;
  permissionsCache = permissions;
  savePermissions();
  notifyRevokeListeners(key);
  if (source === 'user') notifyManifestMutation(key, 'messagingGrant');
  return true;
}

/**
 * Check whether an origin holds the messaging-tier grant.
 * @param {string} origin
 * @returns {boolean}
 */
function hasMessagingGrant(origin) {
  const permission = getPermission(origin);
  return !!permission?.messaging;
}

/**
 * Register IPC handlers for Swarm permissions.
 */
function registerSwarmPermissionsIpc() {
  ipcMain.handle(IPC.SWARM_GET_PERMISSION, (_event, origin) => {
    return getPermission(origin);
  });

  // Refused for every site (freedom-core design 0011, "Grants"; PRQ-7b): a
  // Swarm connection is written by main itself, for the key it attested,
  // from the user's decision on the prompt it issued. The chrome named the
  // site here, so a compromised chrome could connect any site. Revoking
  // stays open: it only narrows.
  ipcMain.handle(IPC.SWARM_GRANT_PERMISSION, () => {
    throw new Error(GRANT_REFUSED);
  });

  ipcMain.handle(IPC.SWARM_REVOKE_PERMISSION, (_event, origin) => {
    return withOriginLock(origin, () => revokePermission(origin));
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

  // Every rule only from main (PRQ-7b to 7d): main sets each, for the
  // requester's key, from the user's "always allow" on the prompt it showed.
  // The chrome named the site here, so turning any rule on is refused;
  // turning one off only narrows, and stays open.
  ipcMain.handle(IPC.SWARM_SET_AUTO_APPROVE, (_event, origin, type, enabled) => {
    if (enabled !== false) {
      throw new Error(Object.prototype.hasOwnProperty.call(RULES_ONLY_FROM_MAIN, type) ? RULES_ONLY_FROM_MAIN[type] : RULE_REFUSED);
    }
    return withOriginLock(origin, () => setAutoApprove(origin, type, enabled));
  });

  // Refused for every site (PRQ-7b): the messaging grant is written by main
  // from the user's decision on its own messaging prompt. Revoking it
  // (swarm:revoke-messaging) stays open.
  ipcMain.handle(IPC.SWARM_GRANT_MESSAGING, () => {
    throw new Error(MESSAGING_GRANT_REFUSED);
  });

  ipcMain.handle(IPC.SWARM_HAS_MESSAGING_GRANT, (_event, origin) => {
    return hasMessagingGrant(origin);
  });

  ipcMain.handle(IPC.SWARM_REVOKE_MESSAGING, (_event, origin) => {
    return withOriginLock(origin, () => revokeMessaging(origin));
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
  grantMessaging,
  revokeMessaging,
  hasMessagingGrant,
  onRevoke,
  onManifestMutation,
  registerSwarmPermissionsIpc,
  _resetCache,
};
