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
const { normalizeOrigin } = require('../../shared/origin-utils');
const { transactionAutoApprovePaused } = require('./auto-approve-pause');

const PERMISSIONS_FILE = 'dapp-permissions.json';
const GRANT_REFUSED = 'A dApp connection is granted only from its own prompt';
const CHAIN_REFUSED = 'A dApp connection’s chain is set only by the page’s own request';
const SIGNING_RULE_REFUSED = 'Signing auto-approve is turned on only from a signing prompt';
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
 * Revoke every permission bound to a wallet index.
 *
 * Called when an account is deleted: a permission is a standing
 * authorisation to sign with one specific account, so it cannot outlive
 * that account. Left behind, the stored `walletIndex` becomes a dangling
 * reference — for a deleted hardware account it points at an index with
 * no device and no vault key, for a deleted mnemonic account at an
 * account the user believes is gone. Either way the origin keeps its
 * auto-approve rules and would sign against an account the user can no
 * longer see. Origins must reconnect and pick a live account.
 *
 * @param {number} walletIndex
 * @returns {string[]} Origins whose permission was revoked
 */
function revokePermissionsForWalletIndex(walletIndex) {
  const permissions = loadPermissions();
  const revoked = Object.keys(permissions).filter(
    (origin) => permissions[origin]?.walletIndex === walletIndex
  );

  if (revoked.length === 0) {
    return [];
  }

  for (const origin of revoked) {
    delete permissions[origin];
  }
  permissionsCache = permissions;
  savePermissions();

  console.log(
    `[DAppPermissions] Revoked ${revoked.length} permission(s) for deleted wallet ${walletIndex}:`,
    revoked.join(', ')
  );
  return revoked;
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
 * A transaction's `value` in wei, as a BigInt: absent means 0. Null for a
 * value that isn't a non-negative integer (decimal or 0x-hex string,
 * number or bigint), which no rule covers.
 */
function weiOf(value) {
  if (value === undefined || value === null || value === '') return 0n;
  if (!['string', 'number', 'bigint'].includes(typeof value)) return null;
  try {
    const wei = BigInt(value);
    return wei >= 0n ? wei : null;
  } catch {
    return null;
  }
}

/**
 * The most `value` a transaction rule covers, in wei: the value of the
 * confirmed send it was recorded from (`maxValue`, a decimal string). A
 * rule recorded before rules carried a value covers only calls that send
 * none: it came from a send of at least 0, and of no more is known.
 */
function ruleMaxValue(rule) {
  return typeof rule?.maxValue === 'string' && /^\d+$/.test(rule.maxValue)
    ? BigInt(rule.maxValue)
    : 0n;
}

function sameCall(rule, to, selector, chainId) {
  return (
    typeof rule?.to === 'string' &&
    typeof rule?.selector === 'string' &&
    rule.to.toLowerCase() === to &&
    rule.selector.toLowerCase() === selector &&
    rule.chainId === chainId
  );
}

/**
 * Check if a transaction is auto-approved for an origin.
 * Matches on contract address + 4-byte function selector + chainId, and
 * covers no more `value` than the send the rule was recorded from.
 * Plain ETH transfers (no data) are never auto-approved.
 * @param {string} origin
 * @param {string} to - Contract address
 * @param {string} selector - 4-byte function selector (0x prefixed, 10 chars)
 * @param {number} chainId
 * @param {string|number|bigint} [value] - The transaction's value in wei
 *   (decimal or 0x-hex); absent means 0
 * @returns {boolean}
 */
function isTransactionAutoApproved(origin, to, selector, chainId, value) {
  if (!to || !selector || selector.length < 10) return false;
  const wei = weiOf(value);
  if (wei === null) return false;

  const permission = getPermission(origin);
  const txRules = permission?.autoApprove?.transactions;
  if (!Array.isArray(txRules) || txRules.length === 0) return false;

  const normalizedTo = to.toLowerCase();
  const normalizedSelector = selector.slice(0, 10).toLowerCase();

  return txRules.some(
    (rule) =>
      sameCall(rule, normalizedTo, normalizedSelector, chainId) && wei <= ruleMaxValue(rule)
  );
}

/**
 * Add a transaction auto-approve rule for an origin, from a send the user
 * confirmed: it covers that call with no more `value` than that send's.
 * Added again for the same call, the rule covers the larger of the two
 * values the user confirmed.
 * @param {string} origin
 * @param {string} to - Contract address
 * @param {string} selector - 4-byte function selector (0x prefixed)
 * @param {number} chainId
 * @param {string|number|bigint} [value] - The confirmed send's value in
 *   wei; absent means 0
 * @returns {boolean} True if the rule covers that send now
 */
function addTransactionAutoApprove(origin, to, selector, chainId, value) {
  if (!to || !selector || selector.length < 10 || chainId === undefined) return false;
  const wei = weiOf(value);
  if (wei === null) return false;

  const permissions = loadPermissions();
  const key = normalizeOrigin(origin);
  if (!permissions[key]) return false;

  if (!permissions[key].autoApprove) {
    permissions[key].autoApprove = DEFAULT_AUTO_APPROVE();
  }

  const normalizedTo = to.toLowerCase();
  const normalizedSelector = selector.slice(0, 10).toLowerCase();

  const existing = permissions[key].autoApprove.transactions || [];
  const same = existing.find((r) => sameCall(r, normalizedTo, normalizedSelector, chainId));
  if (same && ruleMaxValue(same) >= wei) return true;

  if (same) {
    same.maxValue = wei.toString();
  } else {
    existing.push({
      to: normalizedTo,
      selector: normalizedSelector,
      chainId,
      maxValue: wei.toString(),
    });
  }
  permissions[key].autoApprove.transactions = existing;
  permissionsCache = permissions;
  savePermissions();

  console.log(
    `[DAppPermissions] Transaction auto-approve added for ${key}: ${normalizedTo} ${normalizedSelector} chain=${chainId} maxValue=${wei}`
  );
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

  // Refused for every site (freedom-core design 0011, "Grants"; PRQ-4): a
  // connection is written by main itself, for the key it attested, from the
  // user's decision on the prompt it issued (page/page-ethereum.js). The
  // chrome named the site here, so a compromised chrome could connect any
  // site to any account. Revoking stays open: it only narrows.
  ipcMain.handle(IPC.DAPP_GRANT_PERMISSION, () => {
    throw new Error(GRANT_REFUSED);
  });

  ipcMain.handle(IPC.DAPP_REVOKE_PERMISSION, (_event, origin) => {
    return revokePermission(origin);
  });

  ipcMain.handle(IPC.DAPP_GET_ALL_PERMISSIONS, () => {
    return getAllPermissions();
  });

  // The timestamp only (freedom-core design 0011, PRQ-4). A grant's chain
  // is written by main itself, from a page's wallet_switchEthereumChain or
  // its connect (page/page-ethereum.js); the chrome named the site here, so
  // a chain it supplies is refused. The signing paths still on the chrome
  // (until PRQ-5) only mark a site used.
  ipcMain.handle(IPC.DAPP_UPDATE_LAST_USED, (_event, origin, chainId) => {
    if (chainId !== undefined) throw new Error(CHAIN_REFUSED);
    return updateLastUsed(origin);
  });

  ipcMain.handle(IPC.DAPP_GET_SIGNING_AUTO_APPROVE, (_event, origin) => {
    return getSigningAutoApprove(origin);
  });

  // Clearing only (freedom-core design 0011, PRQ-5): main sets a site's
  // signing rule itself, for the requester's key, from the user's "always
  // allow" on a signing prompt main showed (page/page-signing.js). The
  // chrome named the site here, so a rule it sets is refused. Turning one
  // off only narrows, and stays open.
  ipcMain.handle(IPC.DAPP_SET_SIGNING_AUTO_APPROVE, (_event, origin, enabled) => {
    if (enabled !== false) throw new Error(SIGNING_RULE_REFUSED);
    return setSigningAutoApprove(origin, false);
  });

  // The renderer's question before a dApp transaction: auto-approve it, or
  // show the prompt. A covering rule is paused while one of the site's
  // payments is in Payments waiting (D12, auto-approve-pause.js).
  // `value` is the transaction's: a rule covers no more than the send it
  // was recorded from.
  ipcMain.handle(IPC.DAPP_IS_TX_AUTO_APPROVED, async (_event, origin, to, selector, chainId, value) => {
    if (!isTransactionAutoApproved(origin, to, selector, chainId, value)) return false;
    return !(await transactionAutoApprovePaused(origin));
  });

  // No IPC adds a transaction auto-approve rule: main records one itself,
  // for the requester's key, from a send the user just confirmed on main's
  // own prompt with "Always allow" (security audit O-7; freedom-core design
  // 0011, PRQ-5b: page/page-sends.js).

  ipcMain.handle(IPC.DAPP_REMOVE_TX_AUTO_APPROVE, (_event, origin, to, selector, chainId) => {
    return removeTransactionAutoApprove(origin, to, selector, chainId);
  });

  console.log('[DAppPermissions] IPC handlers registered');
}

function _resetCache() {
  permissionsCache = null;
}

module.exports = {
  loadPermissions,
  getPermission,
  grantPermission,
  revokePermission,
  revokePermissionsForWalletIndex,
  getAllPermissions,
  updateLastUsed,
  updateWalletIndex,
  getSigningAutoApprove,
  setSigningAutoApprove,
  isTransactionAutoApproved,
  addTransactionAutoApprove,
  removeTransactionAutoApprove,
  registerDappPermissionsIpc,
  _resetCache,
};
