/**
 * dApp Permissions Manager
 *
 * Manages which dApps (origins) have been granted permission to connect
 * to the wallet. Permissions are persisted to disk and include:
 * - Which wallet index is exposed to the dApp
 * - Which chain was last used
 * - Connection timestamps
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const IPC = require('../../shared/ipc-channels');

const PERMISSIONS_FILE = 'dapp-permissions.json';
const DEFAULT_AUTO_APPROVE = () => ({ signing: false, transactions: [] });

// In-memory cache of permissions
let permissionsCache = null;

/**
 * Get the path to the permissions file
 */
function getPermissionsPath() {
  return path.join(app.getPath('userData'), PERMISSIONS_FILE);
}

/**
 * Load permissions from disk
 * @returns {Object} Map of origin -> permission data
 */
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
    console.error('[DAppPermissions] Failed to load permissions:', err);
    permissionsCache = {};
  }

  return permissionsCache;
}

/**
 * Save permissions to disk
 */
function savePermissions() {
  try {
    const filePath = getPermissionsPath();
    fs.writeFileSync(filePath, JSON.stringify(permissionsCache, null, 2), 'utf-8');
  } catch (err) {
    console.error('[DAppPermissions] Failed to save permissions:', err);
  }
}

/**
 * Normalize an origin URL to a consistent format
 * @param {string} origin - Origin URL (e.g., "https://uniswap.org")
 * @returns {string} Normalized origin
 */
function normalizeOrigin(origin) {
  if (!origin) return '';
  try {
    const url = new URL(origin);
    // Return protocol + host (no path, no trailing slash)
    return `${url.protocol}//${url.host}`;
  } catch {
    // If not a valid URL, return as-is
    return origin;
  }
}

/**
 * Check if an origin has permission to connect
 * @param {string} origin - The dApp origin
 * @returns {Object|null} Permission data or null if not permitted
 */
function getPermission(origin) {
  const permissions = loadPermissions();
  const normalizedOrigin = normalizeOrigin(origin);
  return permissions[normalizedOrigin] || null;
}

/**
 * Grant permission to an origin
 * @param {string} origin - The dApp origin
 * @param {number} walletIndex - Which wallet to expose
 * @param {number} chainId - Initial chain ID
 * @returns {Object} The created permission
 */
function grantPermission(origin, walletIndex, chainId) {
  const permissions = loadPermissions();
  const normalizedOrigin = normalizeOrigin(origin);
  const now = Date.now();

  const permission = {
    origin: normalizedOrigin,
    connectedAt: now,
    lastUsed: now,
    walletIndex: walletIndex,
    chainId: chainId,
    autoApprove: DEFAULT_AUTO_APPROVE(),
  };

  permissions[normalizedOrigin] = permission;
  permissionsCache = permissions;
  savePermissions();

  console.log('[DAppPermissions] Granted permission to:', normalizedOrigin);
  return permission;
}

/**
 * Revoke permission for an origin
 * @param {string} origin - The dApp origin
 * @returns {boolean} True if permission was revoked
 */
function revokePermission(origin) {
  const permissions = loadPermissions();
  const normalizedOrigin = normalizeOrigin(origin);

  if (permissions[normalizedOrigin]) {
    delete permissions[normalizedOrigin];
    permissionsCache = permissions;
    savePermissions();
    console.log('[DAppPermissions] Revoked permission for:', normalizedOrigin);
    return true;
  }

  return false;
}

/**
 * Get all granted permissions
 * @returns {Object[]} Array of permission objects
 */
function getAllPermissions() {
  const permissions = loadPermissions();
  return Object.values(permissions).sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * Update the last used timestamp for an origin
 * @param {string} origin - The dApp origin
 * @param {number} [chainId] - Optionally update the chain ID
 * @returns {boolean} True if updated
 */
function updateLastUsed(origin, chainId) {
  const permissions = loadPermissions();
  const normalizedOrigin = normalizeOrigin(origin);

  if (permissions[normalizedOrigin]) {
    permissions[normalizedOrigin].lastUsed = Date.now();
    if (chainId !== undefined) {
      permissions[normalizedOrigin].chainId = chainId;
    }
    permissionsCache = permissions;
    savePermissions();
    return true;
  }

  return false;
}

/**
 * Update the wallet index for an origin
 * @param {string} origin - The dApp origin
 * @param {number} walletIndex - New wallet index
 * @returns {boolean} True if updated
 */
function updateWalletIndex(origin, walletIndex) {
  const permissions = loadPermissions();
  const normalizedOrigin = normalizeOrigin(origin);

  if (permissions[normalizedOrigin]) {
    permissions[normalizedOrigin].walletIndex = walletIndex;
    permissions[normalizedOrigin].lastUsed = Date.now();
    permissionsCache = permissions;
    savePermissions();
    return true;
  }

  return false;
}

/**
 * Check if signing auto-approve is enabled for an origin.
 * @param {string} origin
 * @returns {boolean}
 */
function getSigningAutoApprove(origin) {
  const permission = getPermission(origin);
  return permission?.autoApprove?.signing === true;
}

/**
 * Set signing auto-approve for an origin.
 * @param {string} origin
 * @param {boolean} enabled
 * @returns {boolean} True if updated
 */
function setSigningAutoApprove(origin, enabled) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);

  if (!permissions[key]) return false;

  if (!permissions[key].autoApprove) {
    permissions[key].autoApprove = DEFAULT_AUTO_APPROVE();
  }

  permissions[key].autoApprove.signing = enabled;
  permissionsCache = permissions;
  savePermissions();

  console.log(`[DAppPermissions] Signing auto-approve ${enabled ? 'enabled' : 'disabled'} for:`, key);
  return true;
}

/**
 * Check if a transaction is auto-approved for an origin.
 * Matches on contract address + 4-byte function selector + chainId.
 * Plain ETH transfers (no data) are never auto-approved.
 * @param {string} origin
 * @param {string} to - Contract address
 * @param {string} selector - 4-byte function selector (0x prefixed, 10 chars)
 * @param {number} chainId
 * @returns {boolean}
 */
function isTransactionAutoApproved(origin, to, selector, chainId) {
  if (!to || !selector || selector.length < 10) return false;

  const permission = getPermission(origin);
  const txRules = permission?.autoApprove?.transactions;
  if (!Array.isArray(txRules) || txRules.length === 0) return false;

  const normalizedTo = to.toLowerCase();
  const normalizedSelector = selector.slice(0, 10).toLowerCase();

  return txRules.some(
    (rule) =>
      rule.to.toLowerCase() === normalizedTo &&
      rule.selector.toLowerCase() === normalizedSelector &&
      rule.chainId === chainId
  );
}

/**
 * Add a transaction auto-approve rule for an origin.
 * @param {string} origin
 * @param {string} to - Contract address
 * @param {string} selector - 4-byte function selector (0x prefixed)
 * @param {number} chainId
 * @returns {boolean} True if added
 */
function addTransactionAutoApprove(origin, to, selector, chainId) {
  if (!to || !selector || selector.length < 10 || chainId === undefined) return false;

  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]) return false;

  if (!permissions[key].autoApprove) {
    permissions[key].autoApprove = DEFAULT_AUTO_APPROVE();
  }

  const normalizedTo = to.toLowerCase();
  const normalizedSelector = selector.slice(0, 10).toLowerCase();

  // Don't add duplicates
  const existing = permissions[key].autoApprove.transactions || [];
  const alreadyExists = existing.some(
    (r) => r.to.toLowerCase() === normalizedTo &&
           r.selector.toLowerCase() === normalizedSelector &&
           r.chainId === chainId
  );
  if (alreadyExists) return true;

  existing.push({ to: normalizedTo, selector: normalizedSelector, chainId });
  permissions[key].autoApprove.transactions = existing;
  permissionsCache = permissions;
  savePermissions();

  console.log(`[DAppPermissions] Transaction auto-approve added for ${key}: ${normalizedTo} ${normalizedSelector} chain=${chainId}`);
  return true;
}

/**
 * Remove a transaction auto-approve rule for an origin.
 * @param {string} origin
 * @param {string} to - Contract address
 * @param {string} selector - 4-byte function selector
 * @param {number} chainId
 * @returns {boolean} True if removed
 */
function removeTransactionAutoApprove(origin, to, selector, chainId) {
  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]?.autoApprove?.transactions) return false;

  const normalizedTo = to.toLowerCase();
  const normalizedSelector = selector.slice(0, 10).toLowerCase();

  const before = permissions[key].autoApprove.transactions.length;
  permissions[key].autoApprove.transactions = permissions[key].autoApprove.transactions.filter(
    (r) => !(r.to.toLowerCase() === normalizedTo &&
             r.selector.toLowerCase() === normalizedSelector &&
             r.chainId === chainId)
  );

  if (permissions[key].autoApprove.transactions.length === before) return false;

  permissionsCache = permissions;
  savePermissions();
  console.log(`[DAppPermissions] Transaction auto-approve removed for ${key}: ${normalizedTo} ${normalizedSelector} chain=${chainId}`);
  return true;
}

/**
 * Register IPC handlers for dApp permissions
 */
function registerDappPermissionsIpc() {
  ipcMain.handle(IPC.DAPP_GET_PERMISSION, (_event, origin) => {
    return getPermission(origin);
  });

  ipcMain.handle(IPC.DAPP_GRANT_PERMISSION, (_event, origin, walletIndex, chainId) => {
    return grantPermission(origin, walletIndex, chainId);
  });

  ipcMain.handle(IPC.DAPP_REVOKE_PERMISSION, (_event, origin) => {
    return revokePermission(origin);
  });

  ipcMain.handle(IPC.DAPP_GET_ALL_PERMISSIONS, () => {
    return getAllPermissions();
  });

  ipcMain.handle(IPC.DAPP_UPDATE_LAST_USED, (_event, origin, chainId) => {
    return updateLastUsed(origin, chainId);
  });

  ipcMain.handle(IPC.DAPP_GET_SIGNING_AUTO_APPROVE, (_event, origin) => {
    return getSigningAutoApprove(origin);
  });

  ipcMain.handle(IPC.DAPP_SET_SIGNING_AUTO_APPROVE, (_event, origin, enabled) => {
    return setSigningAutoApprove(origin, enabled);
  });

  ipcMain.handle(IPC.DAPP_IS_TX_AUTO_APPROVED, (_event, origin, to, selector, chainId) => {
    return isTransactionAutoApproved(origin, to, selector, chainId);
  });

  ipcMain.handle(IPC.DAPP_ADD_TX_AUTO_APPROVE, (_event, origin, to, selector, chainId) => {
    return addTransactionAutoApprove(origin, to, selector, chainId);
  });

  ipcMain.handle(IPC.DAPP_REMOVE_TX_AUTO_APPROVE, (_event, origin, to, selector, chainId) => {
    return removeTransactionAutoApprove(origin, to, selector, chainId);
  });

  console.log('[DAppPermissions] IPC handlers registered');
}

module.exports = {
  loadPermissions,
  getPermission,
  grantPermission,
  revokePermission,
  getAllPermissions,
  updateLastUsed,
  updateWalletIndex,
  getSigningAutoApprove,
  setSigningAutoApprove,
  isTransactionAutoApproved,
  addTransactionAutoApprove,
  removeTransactionAutoApprove,
  normalizeOrigin,
  registerDappPermissionsIpc,
};
