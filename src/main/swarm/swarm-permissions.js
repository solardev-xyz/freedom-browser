/**
 * Swarm Provider Permissions
 *
 * Manages which origins have been granted permission to publish through
 * the user's Swarm node. Separate from dApp wallet permissions — Swarm
 * permissions consume storage/bandwidth, wallet permissions expose accounts.
 *
 * Schema per origin (`swarm-permissions.json`):
 *   { origin, connectedAt, lastUsed,
 *     autoApprove: { publish: false, feeds: false, signing: false, messaging: false },
 *     messaging?: { grantedAt } }
 *
 * `messaging` is the messaging-tier grant (PSS/GSOC subscribe + send +
 * identity disclosure); `autoApprove.messaging` additionally skips the
 * per-send prompt for granted origins.
 *
 * The identity core writes the file (freedom-core design 0012, APB-3:
 * `swarm` is in the hello's `grant_moved`), and main writes it nowhere.
 * Reads are the core's store as main last read it (core/grants.js); each
 * change goes to the core, and resolves once main has read the key back:
 * - a page's (`{ page }`, its PageContext) under `page`, for its own key;
 * - the chrome's narrowing (`source: 'user'` with no page: a revoke, a rule
 *   turned off) as `chrome`;
 * - a manifest's projection (`source: 'manifest'`) as `shell`, naming the
 *   key (design 0012, "The model").
 * A widening with neither a page nor a manifest behind it is refused here.
 */
const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { withOriginLock } = require('./origin-mutation-lock');
const { grantStore } = require('../core/grants');

const store = () => grantStore('swarm');
// A widening that is neither a page's nor a manifest's (see above).
const NO_DECISION = 'A Swarm grant is written only from its prompt or a manifest';

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

/**
 * Who makes a change (core/grants.js): a page's own (its PageContext), a
 * manifest's projection (`shell`), or the chrome's narrowing. A page writes
 * only its own key.
 */
function callerFor(key, { page = null, source = 'user' } = {}, widening = false) {
  if (page) {
    if (page.origin !== key) throw new Error('A page changes only its own Swarm grant');
    return page;
  }
  if (source === 'manifest') return null;
  if (widening) throw new Error(NO_DECISION);
  return 'chrome';
}

// A grant main names the key of (`shell`), as the core's API has it.
function withKey(change, caller, key) {
  return caller === null ? { ...change, key } : change;
}

/**
 * Check if an origin has Swarm publishing permission.
 * @param {string} origin
 * @returns {Object|null} Permission data or null
 */
function getPermission(origin) {
  return store().get(normalizeOrigin(origin));
}

/**
 * Grant Swarm publishing permission to an origin: a new connection, with
 * no rule, replacing any it had.
 * @param {string} origin
 * @param {{ page?: object, source?: string }} [options]
 * @returns {Promise<Object>} The created permission
 */
async function grantPermission(origin, options = {}) {
  const key = normalizeOrigin(origin);
  const caller = callerFor(key, options, true);
  await store().grant(withKey({ op: 'connect' }, caller, key), caller);
  console.log('[SwarmPermissions] Granted permission to:', key);
  return getPermission(key);
}

/**
 * Revoke Swarm publishing permission for an origin.
 * @param {string} origin
 * @param {{ page?: object, source?: string }} [options]
 * @returns {Promise<boolean>} True if permission was revoked
 */
async function revokePermission(origin, options = {}) {
  const key = normalizeOrigin(origin);
  if (!getPermission(key)) return false;
  await store().revoke(key, 'grant', callerFor(key, options));
  if (getPermission(key)) return false;
  notifyRevokeListeners(key);
  if ((options.source ?? 'user') === 'user') notifyManifestMutation(key, 'connection');
  console.log('[SwarmPermissions] Revoked permission for:', key);
  return true;
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
  return store().all();
}

/**
 * Update the last used timestamp for an origin: a page's own use, under
 * `page` (the core takes it from no other caller).
 * @param {string} origin
 * @param {{ page?: object }} [options]
 * @returns {Promise<boolean>} True if updated
 */
async function updateLastUsed(origin, { page = null } = {}) {
  const key = normalizeOrigin(origin);
  if (!getPermission(key) || !page) return false;
  if (page.origin !== key) throw new Error('A page changes only its own Swarm grant');
  await store().touch(page);
  return true;
}

const VALID_AUTO_APPROVE_TYPES = new Set(['publish', 'feeds', 'signing', 'messaging']);

/**
 * Check if an auto-approve type is enabled for an origin.
 * @param {string} origin
 * @param {'publish'|'feeds'|'signing'|'messaging'} type
 * @returns {boolean}
 */
function getAutoApprove(origin, type) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;
  const permission = getPermission(origin);
  return permission?.autoApprove?.[type] === true;
}

/**
 * Set an auto-approve type for an origin: on as a grant (`flag`), off as a
 * revoke of the flag.
 * @param {string} origin
 * @param {'publish'|'feeds'|'signing'|'messaging'} type
 * @param {boolean} enabled
 * @param {{ page?: object, source?: string }} [options]
 * @returns {Promise<boolean>} True if updated
 */
async function setAutoApprove(origin, type, enabled, options = {}) {
  if (!VALID_AUTO_APPROVE_TYPES.has(type)) return false;
  const key = normalizeOrigin(origin);
  if (!getPermission(key)) return false;
  const on = enabled === true;
  const caller = callerFor(key, options, on);
  if (on) await store().grant(withKey({ op: 'flag', flag: type }, caller, key), caller);
  else await store().revoke(key, { flag: type }, caller);
  if ((options.source ?? 'user') === 'user') notifyManifestMutation(key, `autoApprove.${type}`);

  console.log(`[SwarmPermissions] Auto-approve ${type} ${on ? 'enabled' : 'disabled'} for:`, key);
  return true;
}

/**
 * Grant the messaging tier (PSS/GSOC) to an already-connected origin.
 * @param {string} origin
 * @param {{ page?: object, source?: string }} [options]
 * @returns {Promise<boolean>} True if granted
 */
async function grantMessaging(origin, options = {}) {
  const key = normalizeOrigin(origin);
  if (!getPermission(key)) return false;
  const caller = callerFor(key, options, true);
  await store().grant(withKey({ op: 'messaging' }, caller, key), caller);
  if ((options.source ?? 'user') === 'user') notifyManifestMutation(key, 'messagingGrant');

  console.log('[SwarmPermissions] Messaging granted for:', key);
  return true;
}

async function revokeMessaging(origin, options = {}) {
  const key = normalizeOrigin(origin);
  if (!getPermission(key)?.messaging) return false;
  await store().revoke(key, 'messaging', callerFor(key, options));
  notifyRevokeListeners(key);
  if ((options.source ?? 'user') === 'user') notifyManifestMutation(key, 'messagingGrant');
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

/** Resolves once the core's store has been read (core/grants.js). */
function whenLoaded() {
  return store().whenLoaded();
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
  whenLoaded,
};
