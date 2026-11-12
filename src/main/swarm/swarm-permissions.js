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
 *
 * `act` holds the publishers this origin may open ACT shares from without a
 * prompt (#648): `{ [compressed publisher key]: { grantedAt } }`. It is per
 * publisher on purpose: the node's ACT key is one identity for every site,
 * so a per-site flag would hand everything ever shared with the user to any
 * site allowed once. It lives in the origin's record, so disconnecting the
 * origin drops it with everything else.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { withOriginLock } = require('./origin-mutation-lock');
const { normalizeActPublisher } = require('./act-publisher');
// Required on first use: private-windows.js pulls in the app logger and
// BrowserWindow, which most of this module's callers (and tests) never need.
function isPrivateSender(event) {
  return require('../private/private-sender').isPrivateSender(event);
}

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
 * Let an origin open ACT shares from one publisher without asking ("always
 * allow" on the ACT prompt). Needs the origin's connection grant.
 * @param {string} origin
 * @param {string} publisher - any spelling normalizeActPublisher accepts
 * @returns {boolean} True if stored
 */
function grantActPublisher(origin, publisher) {
  const normalized = normalizeActPublisher(publisher);
  if (!normalized) return false;
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]) return false;

  if (!permissions[key].act || typeof permissions[key].act !== 'object') {
    permissions[key].act = {};
  }
  permissions[key].act[normalized.publicKey] = { grantedAt: Date.now() };
  permissionsCache = permissions;
  savePermissions();
  console.log('[SwarmPermissions] ACT publisher allowed for:', key);
  return true;
}

/**
 * @returns {boolean} True if a stored grant was removed
 */
function revokeActPublisher(origin, publisher) {
  const normalized = normalizeActPublisher(publisher);
  if (!normalized) return false;
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  const grants = permissions[key]?.act;
  if (!grants || !Object.hasOwn(grants, normalized.publicKey)) return false;

  delete grants[normalized.publicKey];
  if (Object.keys(grants).length === 0) delete permissions[key].act;
  permissionsCache = permissions;
  savePermissions();
  console.log('[SwarmPermissions] ACT publisher removed for:', key);
  return true;
}

/**
 * Whether `origin` may open ACT shares from `publisher` without a prompt.
 * False for a malformed publisher and for an origin with no connection.
 */
function hasActGrant(origin, publisher) {
  const normalized = normalizeActPublisher(publisher);
  if (!normalized) return false;
  const grants = getPermission(origin)?.act;
  return !!grants && typeof grants === 'object' && Object.hasOwn(grants, normalized.publicKey);
}

/**
 * The publishers an origin may open ACT shares from without a prompt.
 * @returns {{ publicKey: string, address: string, grantedAt: number }[]}
 */
function getActGrants(origin) {
  const grants = getPermission(origin)?.act;
  if (!grants || typeof grants !== 'object') return [];
  const out = [];
  for (const [publicKey, entry] of Object.entries(grants)) {
    const normalized = normalizeActPublisher(publicKey);
    if (!normalized) continue;
    out.push({ ...normalized, grantedAt: Number(entry?.grantedAt) || 0 });
  }
  return out.sort((a, b) => b.grantedAt - a.grantedAt);
}

/**
 * What the ACT prompt shows for a publisher, from main's own normaliser, so
 * the prompt names exactly the key the grant and the node request use.
 * @returns {{ valid: false } | { valid: true, publicKey: string, address: string, granted: boolean }}
 */
function describeActPublisher(origin, publisher) {
  const normalized = normalizeActPublisher(publisher);
  if (!normalized) return { valid: false };
  return { valid: true, ...normalized, granted: hasActGrant(origin, normalized.publicKey) };
}

/**
 * Register IPC handlers for Swarm permissions.
 */
function registerSwarmPermissionsIpc() {
  ipcMain.handle(IPC.SWARM_GET_PERMISSION, (_event, origin) => {
    return getPermission(origin);
  });

  ipcMain.handle(IPC.SWARM_GRANT_PERMISSION, (_event, origin) => {
    return withOriginLock(origin, () => grantPermission(origin));
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

  ipcMain.handle(IPC.SWARM_SET_AUTO_APPROVE, (_event, origin, type, enabled) => {
    return withOriginLock(origin, () => setAutoApprove(origin, type, enabled));
  });

  ipcMain.handle(IPC.SWARM_GRANT_MESSAGING, (_event, origin) => {
    return withOriginLock(origin, () => grantMessaging(origin));
  });

  ipcMain.handle(IPC.SWARM_HAS_MESSAGING_GRANT, (_event, origin) => {
    return hasMessagingGrant(origin);
  });

  ipcMain.handle(IPC.SWARM_REVOKE_MESSAGING, (_event, origin) => {
    return withOriginLock(origin, () => revokeMessaging(origin));
  });

  // A private window gets no lasting ACT grant (#648). It has no
  // window.swarm to ask from, so this refusal is defence in depth; an
  // unclassifiable sender counts as private (private-sender.js).
  ipcMain.handle(IPC.SWARM_GRANT_ACT, (event, origin, publisher) => {
    if (isPrivateSender(event)) return false;
    return withOriginLock(origin, () => grantActPublisher(origin, publisher));
  });

  ipcMain.handle(IPC.SWARM_REVOKE_ACT, (_event, origin, publisher) => {
    return withOriginLock(origin, () => revokeActPublisher(origin, publisher));
  });

  ipcMain.handle(IPC.SWARM_GET_ACT_GRANTS, (_event, origin) => {
    return getActGrants(origin);
  });

  ipcMain.handle(IPC.SWARM_DESCRIBE_ACT_PUBLISHER, (_event, origin, publisher) => {
    return describeActPublisher(origin, publisher);
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
  grantActPublisher,
  revokeActPublisher,
  hasActGrant,
  getActGrants,
  describeActPublisher,
  onRevoke,
  onManifestMutation,
  registerSwarmPermissionsIpc,
  _resetCache,
};
