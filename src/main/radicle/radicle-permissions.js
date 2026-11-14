/**
 * Radicle Provider Permissions
 *
 * Manages which origins may act on the user's Radicle node. Two tiers per
 * origin, mirroring the Swarm provider's connection/feed split:
 *  - connection (the permission record existing)
 *  - signing grant (identity disclosure + COB writes)
 *
 * Schema per origin (`radicle-permissions.json`):
 *   { origin, connectedAt, lastUsed, signing: false,
 *     autoApprove: { node: false, signing: false } }
 *
 * The identity core writes the file (freedom-core design 0012, APB-3:
 * `radicle` is in the hello's `grant_moved`), and main writes it nowhere.
 * Reads are the core's store as main last read it (core/grants.js); each
 * change goes to the core, and resolves once main has read the key back:
 * - a page's (`{ page }`, its PageContext) under `page`, for its own key:
 *   the only caller the core takes a Radicle grant, a rule or a last use
 *   from;
 * - a narrowing (a revoke, a rule turned off) from the chrome
 *   (`{ caller: 'chrome' }`) or from main itself (`shell`, the default).
 */

const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { isPrivateSender } = require('../private/private-sender');
const { grantStore } = require('../core/grants');

const store = () => grantStore('radicle');
// How fresh a last use stays unwritten: the core writes none fresher
// (design 0012's port of the 60 s), so main doesn't ask.
const LAST_USED_FRESH_MS = 60000;

const VALID_AUTO_APPROVE_TYPES = new Set(['node', 'signing']);

// A page's own key, the only one it changes.
function pageFor(key, page) {
  if (!page) throw new Error('A Radicle grant is written only from its prompt');
  if (page.origin !== key) throw new Error('A page changes only its own Radicle grant');
  return page;
}

// A narrowing's caller: the page's own, the chrome's, or main's (`shell`).
function narrowingCaller(key, { page = null, caller = 'shell' } = {}) {
  if (page) return pageFor(key, page);
  return caller === 'chrome' ? 'chrome' : null;
}

/** @returns {Object|null} Permission data or null */
function getPermission(origin) {
  return store().get(normalizeOrigin(origin));
}

/**
 * Grant connection permission to an origin, from its page's prompt: a new
 * connection, with no signing grant and no rule, replacing any it had.
 * @returns {Promise<Object>}
 */
async function grantPermission(origin, { page = null } = {}) {
  const key = normalizeOrigin(origin);
  const caller = pageFor(key, page);
  await store().grant({ op: 'connect' }, caller);
  console.log('[RadiclePermissions] Granted permission to:', key);
  return getPermission(key);
}

/** @returns {Promise<boolean>} True if permission was revoked */
async function revokePermission(origin, options = {}) {
  const key = normalizeOrigin(origin);
  if (!getPermission(key)) return false;
  await store().revoke(key, 'grant', narrowingCaller(key, options));
  if (getPermission(key)) return false;
  console.log('[RadiclePermissions] Revoked permission for:', key);
  notifyRevokeListeners(key);
  return true;
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
  return store().all();
}

/**
 * A page's last use, under `page`. lastUsed is a coarse "when was this
 * dApp active" signal, written at most once a minute, so cheap polling
 * methods (seed status) don't rewrite the JSON every couple of seconds.
 * @returns {Promise<boolean>} True if the origin is connected
 */
async function updateLastUsed(origin, { page = null } = {}) {
  const key = normalizeOrigin(origin);
  const permission = getPermission(key);
  if (!permission) return false;
  if (!page) return true;
  if (Date.now() - (permission.lastUsed || 0) < LAST_USED_FRESH_MS) return true;
  await store().touch(pageFor(key, page));
  return true;
}

/** Signing tier: identity disclosure + COB writes. Requires connection. */
function hasSigningGrant(origin) {
  return getPermission(origin)?.signing === true;
}

/** @returns {Promise<boolean>} True if granted (false when origin not connected) */
async function grantSigning(origin, { page = null } = {}) {
  const key = normalizeOrigin(origin);
  const caller = pageFor(key, page);
  if (!getPermission(key)) return false;
  await store().grant({ op: 'signing' }, caller);
  console.log('[RadiclePermissions] Signing grant for:', key);
  return hasSigningGrant(key);
}

function getAutoApprove(origin, type) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;
  return getPermission(origin)?.autoApprove?.[type] === true;
}

/**
 * A rule on (a grant, from the page's prompt) or off (a revoke of the
 * flag, from the page, the chrome or main).
 * @returns {Promise<boolean>} True if updated
 */
async function setAutoApprove(origin, type, enabled, options = {}) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;
  const key = normalizeOrigin(origin);
  if (!getPermission(key)) return false;
  const on = enabled === true;
  if (on) await store().grant({ op: 'flag', flag: type }, pageFor(key, options.page));
  else await store().revoke(key, { flag: type }, narrowingCaller(key, options));

  console.log(
    `[RadiclePermissions] Auto-approve ${type} ${on ? 'enabled' : 'disabled'} for:`,
    key
  );
  return true;
}

/**
 * Resolves once the running core's store has been read: true, or false if
 * it can't be (core/grants.js).
 */
function whenLoaded() {
  return store().whenLoaded();
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
  ipcMain.handle(IPC.RADICLE_REVOKE_PERMISSION, (_event, origin) => revokePermission(origin, { caller: 'chrome' }));
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
    return isPrivateSender(event) ? false : setAutoApprove(origin, type, enabled, { caller: 'chrome' });
  });

  console.log('[RadiclePermissions] IPC handlers registered');
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
  whenLoaded,
};
