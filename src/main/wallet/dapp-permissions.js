/**
 * dApp Permissions, kept by the identity core (freedom-core design 0012,
 * APB-2).
 *
 * `dapp-permissions.json` has moved to the core (the hello's `grant_moved`,
 * core/core-client.js): the core is its only writer, in today's format, and
 * main writes it nowhere. Each change goes to the core's write methods
 * ("The files (Q10)", API):
 * - **A page's**, under `page` with the request's PageContext, for its own
 *   key: a connect and its account (`approval.grant`, `connect` and
 *   `account`), its last use and chain (`approval.touch`), and "Always
 *   allow" on a signing prompt (`approval.grant`'s `signing`: Q9's limited
 *   rule, which clears today's flag in the same write). A transaction rule
 *   comes only with the confirmed send it was ticked on: the core writes it
 *   as it signs, and says so in `sign.transaction`'s reply.
 * - **Main's own**, as `shell`: the chrome's revoke, its signing rule or
 *   contract rule turned off (`approval.revoke`; it only narrows), and an
 *   account deleted (`approval.forget_account`).
 *
 * A failed write is reported as the core reports it: a widening (a connect,
 * a rule) isn't applied, so a connect fails; a narrowing (a revoke, a rule
 * turned off) stands in the core's memory and isn't saved, so a restart
 * before the next save brings the old file back; and a change after which
 * the directory couldn't be flushed is in place but not durable
 * (`durable: false`). Each is logged, as today's failed saves are.
 *
 * Main keeps a copy of the store as the core holds it, for its own checks
 * (whether a site is connected, and with which account): read whole with
 * `approval.grants` at each start of the core, and a key's entry again for
 * each `approval.changed` the core sends and at each of main's writes. The
 * chrome's reads ask the core itself. Today's rules (`autoApprove.signing`,
 * `autoApprove.transactions`) answer nothing from here on (Q9): the core
 * judges every standing rule (`approval.check`, `{ standing }`).
 *
 * A grant revoked, or its account changed, is told to whoever listens
 * (`onGrantChanged`): main sends `accountsChanged` to every live document
 * of the key (freedom-core design 0011, "Events"; PRQ-6,
 * `page/page-events.js`). A grant main writes from a connect is told by its
 * own dispatcher (`page/page-ethereum.js`).
 */

const { ipcMain } = require('electron');
const IPC = require('../../shared/ipc-channels');
const { normalizeOrigin } = require('../../shared/origin-utils');

const STORE = 'dapp';
const GRANT_REFUSED = 'A dApp connection is granted only from its own prompt';
const SIGNING_RULE_REFUSED = 'Signing auto-approve is turned on only from a signing prompt';
const PAGE_ONLY = 'A site’s grant is written only under its own page';
// How long a page's request waits for main's first copy of the store
// before it reads it as it stands (empty: no site connected).
const FIRST_LOAD_WAIT_MS = 15_000;

// Main's copy of the store, as the core holds it: key -> entry.
const grants = new Map();
// The order of main's reads and writes of each key, as the core answers
// them in the order they were sent: an answer older than the one already
// applied is dropped. `seq` counts every one sent.
let seq = 0;
const applied = new Map();
let wholeAt = 0;

// The core client main's copy follows, its first load, and who waits on it.
let attachedCore = null;
let loadedOnce = false;
let loadWaiters = [];

// Called with { key, walletIndex } when a grant is revoked (walletIndex
// null) or its account changes.
const grantListeners = new Set();

/**
 * Hear of every grant revoked or whose account changes: `{ key,
 * walletIndex }`, with the normalized key, and null for a revocation.
 * Returns a function that stops it.
 */
function onGrantChanged(listener) {
  if (typeof listener !== 'function') return () => {};
  grantListeners.add(listener);
  return () => grantListeners.delete(listener);
}

function grantChanged(key, walletIndex) {
  const change = Object.freeze({ key, walletIndex });
  for (const listener of grantListeners) {
    try {
      listener(change);
    } catch {
      // One listener's failure must not keep the others from hearing it.
    }
  }
}

function vault() {
  return require('../core/vault-backend').vaultBackend;
}

/**
 * A key's entry as the core answered it, sent at `at`, into main's copy:
 * unless an answer sent later has been applied already. A revocation, or
 * an account changed, is told (`onGrantChanged`); a connect isn't (`silent`:
 * its dispatcher tells it).
 */
function applyEntry(key, entry, at, { silent = false } = {}) {
  if (at < (applied.get(key) || 0) || at < wholeAt) return;
  applied.set(key, at);
  const before = grants.get(key) || null;
  const record = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null;
  if (record) grants.set(key, record);
  else grants.delete(key);
  if (!before || silent) return;
  if (!record) grantChanged(key, null);
  else if (record.walletIndex !== before.walletIndex) grantChanged(key, record.walletIndex);
}

/** The core's records, keyed as the file keys them (each `origin`). */
function keyed(records) {
  const out = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    if (record && typeof record === 'object' && typeof record.origin === 'string') {
      const key = normalizeOrigin(record.origin);
      if (key) out.set(key, record);
    }
  }
  return out;
}

/** The store as the core holds it, whole: main's copy replaced. */
async function refreshPermissions() {
  const at = ++seq;
  const { records } = await vault().approval.grants({ store: STORE });
  const next = keyed(records);
  if (at < wholeAt) return;
  for (const key of [...grants.keys()]) {
    if (!next.has(key)) applyEntry(key, null, at);
  }
  for (const [key, record] of next) applyEntry(key, record, at);
  wholeAt = at;
}

/** A key's entry as the core holds it, into main's copy; null for none. */
async function refreshGrant(origin) {
  const key = normalizeOrigin(origin);
  if (!key) return null;
  const at = ++seq;
  const { records } = await vault().approval.grants({ store: STORE, key });
  const entry = keyed(records).get(key) || null;
  applyEntry(key, entry, at);
  return entry;
}

/** A key's entry read again after a write that answers no entry. */
function reread(key) {
  refreshGrant(key).catch((err) =>
    console.error('[DAppPermissions] Failed to read a changed permission:', err?.message || err)
  );
}

function markLoaded() {
  loadedOnce = true;
  const waiters = loadWaiters;
  loadWaiters = [];
  for (const resolve of waiters) resolve();
}

/**
 * core-process.js: main's copy follows `client`, the core client, from its
 * first handshake: read whole at each start of the core (a restarted core
 * reads the file again), and a key again for each `approval.changed`.
 */
function attachCore(client) {
  if (!client || typeof client.on !== 'function' || client === attachedCore) return;
  attachedCore = client;
  client.on('ready', () => {
    refreshPermissions()
      .catch((err) => console.error('[DAppPermissions] Failed to load permissions:', err?.message || err))
      .finally(markLoaded);
  });
  // A core that fails to start leaves the store unread: a page's request
  // then reads no grant rather than waiting.
  client.on('failed', markLoaded);
  client.on('event', (name, data) => {
    if (name !== 'approval.changed' || data?.store !== STORE || typeof data.key !== 'string') return;
    refreshGrant(data.key).catch((err) =>
      console.error('[DAppPermissions] Failed to read a changed permission:', err?.message || err)
    );
  });
}

/**
 * Resolves once main's copy has been read from the core the first time (or
 * that failed), at once with no core attached, and at the latest after
 * FIRST_LOAD_WAIT_MS: a page's request reads the grants after it.
 */
function whenLoaded() {
  if (loadedOnce || !attachedCore) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, FIRST_LOAD_WAIT_MS);
    timer.unref?.();
    loadWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Main's copy of the store: key -> entry. */
function loadPermissions() {
  return Object.fromEntries(grants);
}

/**
 * The key a page's write is for: its own (`PageContext.origin`), and the one
 * the caller names, which must be the same. Throws otherwise.
 */
function pageKey(origin, page) {
  const key = normalizeOrigin(origin);
  if (!key || !page || typeof page.origin !== 'string' || normalizeOrigin(page.origin) !== key) {
    throw Object.assign(new Error(PAGE_ONLY), { code: 'forbidden' });
  }
  return key;
}

function notDurable(what, reply) {
  if (reply?.durable === false) {
    console.warn(`[DAppPermissions] ${what}, but it may not survive a power loss yet (the flush after the rename failed)`);
  }
}

/** Whether a failed write still stands in the core: a narrowing, not saved. */
function standsUnsaved(err) {
  return err?.code === 'storage' && err?.data?.applied === true;
}

function writeFailed(what, err) {
  if (standsUnsaved(err)) {
    console.error(`[DAppPermissions] ${what}, but it couldn't be saved: a restart before the next save brings it back`);
  } else {
    console.error(`[DAppPermissions] Failed to save permissions (${what}):`, err?.message || err);
  }
}

/**
 * Check if an origin has permission to connect, in main's copy.
 * @param {string} origin - The dApp origin
 * @returns {Object|null} Permission data or null if not permitted
 */
function getPermission(origin) {
  return grants.get(normalizeOrigin(origin)) || null;
}

/**
 * A page's connect, from the user's decision on the prompt main showed: the
 * core writes the grant for the page's key. Rejects when it isn't written
 * (a widening whose write failed isn't applied).
 * @param {string} origin - The dApp's key, the page's own
 * @param {number} walletIndex - Which wallet to expose
 * @param {number} chainId - Initial chain ID
 * @param {object} page - the request's PageContext
 * @returns {Promise<Object>} The created permission
 */
async function grantPermission(origin, walletIndex, chainId, page) {
  const key = pageKey(origin, page);
  const at = ++seq;
  let reply;
  try {
    reply = await vault().approval.grant(
      { store: STORE, change: { op: 'connect', account: walletIndex, chain_id: chainId } },
      page
    );
  } catch (err) {
    writeFailed(`connecting ${key}`, err);
    throw err;
  }
  notDurable(`Granted ${key}`, reply);
  const grant = reply?.grant ?? null;
  applyEntry(key, grant, at, { silent: true });
  if (!grant) throw new Error('The connection was not recorded');
  console.log('[DAppPermissions] Granted permission to:', key);
  return grant;
}

/**
 * Revoke permission for an origin (the chrome's disconnect): main's own,
 * which only narrows.
 * @param {string} origin - The dApp origin
 * @returns {Promise<boolean>} True if permission was revoked
 */
async function revokePermission(origin) {
  const key = normalizeOrigin(origin);
  if (!key) return false;
  const at = ++seq;
  try {
    const reply = await vault().approval.revoke({ store: STORE, key, what: 'grant' });
    notDurable(`Revoked ${key}`, reply);
    if (reply?.revoked !== true) return false;
  } catch (err) {
    writeFailed(`revoking ${key}`, err);
    if (!standsUnsaved(err)) return false;
  }
  applyEntry(key, null, at);
  console.log('[DAppPermissions] Revoked permission for:', key);
  return true;
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
 * longer see. Origins must reconnect and pick a live account. The core
 * revokes them (`approval.forget_account`, main's own). Never rejects.
 *
 * @param {number} walletIndex
 * @returns {Promise<string[]>} Origins whose permission was revoked
 */
async function revokePermissionsForWalletIndex(walletIndex) {
  const at = ++seq;
  let reply;
  try {
    reply = await vault().approval.forgetAccount(walletIndex);
  } catch (err) {
    writeFailed(`revoking the permissions of deleted wallet ${walletIndex}`, err);
    // Revoked in the core's memory: main's copy reads them again.
    if (standsUnsaved(err)) await refreshPermissions().catch(() => {});
    return [];
  }
  notDurable(`Revoked the permissions of deleted wallet ${walletIndex}`, reply);
  const revoked = Array.isArray(reply?.keys) ? reply.keys.filter((key) => typeof key === 'string') : [];
  for (const key of revoked) applyEntry(normalizeOrigin(key), null, at);
  if (revoked.length > 0) {
    console.log(
      `[DAppPermissions] Revoked ${revoked.length} permission(s) for deleted wallet ${walletIndex}:`,
      revoked.join(', ')
    );
  }
  return revoked;
}

/**
 * Get all granted permissions, in main's copy.
 * @returns {Object[]} Array of permission objects
 */
function getAllPermissions() {
  return [...grants.values()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/**
 * A page's last use, and its chain: the core writes them for the page's
 * own key. Never rejects.
 * @param {string} origin - The dApp's key, the page's own
 * @param {number} [chainId] - Optionally update the chain ID
 * @param {object} page - the request's PageContext
 * @returns {Promise<boolean>} True if updated
 */
async function updateLastUsed(origin, chainId, page) {
  try {
    pageKey(origin, page);
    const params = { store: STORE };
    if (chainId !== undefined) params.chain_id = chainId;
    const reply = await vault().approval.touch(params, page);
    notDurable('Last use saved', reply);
    return true;
  } catch (err) {
    writeFailed('last use', err);
    return false;
  }
}

/**
 * The account a page's grant exposes, chosen again on its own prompt (the
 * agent's connect): the core writes it for the page's key. Rejects when it
 * isn't written.
 * @param {string} origin - The dApp's key, the page's own
 * @param {number} walletIndex - New wallet index
 * @param {object} page - the request's PageContext
 * @returns {Promise<boolean>} True if updated
 */
async function updateWalletIndex(origin, walletIndex, page) {
  const key = pageKey(origin, page);
  const at = ++seq;
  let reply;
  try {
    reply = await vault().approval.grant({ store: STORE, change: { op: 'account', account: walletIndex } }, page);
  } catch (err) {
    writeFailed(`the account of ${key}`, err);
    throw err;
  }
  notDurable(`Account of ${key} saved`, reply);
  applyEntry(key, reply?.grant ?? null, at);
  return Boolean(reply?.grant);
}

/**
 * Whether an entry stores a signing rule: Q9's limited one, or today's flag
 * (which answers nothing from APB-2, but an older build still would).
 */
function signingRuleStored(permission) {
  const rules = permission?.autoApprove;
  return rules?.signing === true || Boolean(rules?.limited?.signing);
}

/**
 * Check if a signing rule is stored for an origin, in main's copy.
 * @param {string} origin
 * @returns {boolean}
 */
function getSigningAutoApprove(origin) {
  return signingRuleStored(getPermission(origin));
}

/**
 * A site's signing rule: turned on only from "Always allow" on a signing
 * prompt main showed, under the page (Q9's limited rule, which clears
 * today's flag in the same write); turned off by the chrome (main's own,
 * which clears both). Never rejects.
 * @param {string} origin
 * @param {boolean} enabled
 * @param {object} [page] - the request's PageContext, to turn it on
 * @returns {Promise<boolean>} True if updated
 */
async function setSigningAutoApprove(origin, enabled, page) {
  const key = normalizeOrigin(origin);
  const at = ++seq;
  try {
    if (enabled) {
      pageKey(origin, page);
      const reply = await vault().approval.grant({ store: STORE, change: { op: 'signing' } }, page);
      notDurable(`Signing rule saved for ${key}`, reply);
      if (!reply?.grant) return false;
      applyEntry(key, reply.grant, at);
    } else {
      const reply = await vault().approval.revoke({ store: STORE, key, what: 'signing' });
      notDurable(`Signing rule turned off for ${key}`, reply);
      if (reply?.revoked !== true) return false;
      reread(key);
    }
  } catch (err) {
    writeFailed(`the signing rule of ${key}`, err);
    if (enabled || !standsUnsaved(err)) return false;
    reread(key);
  }
  console.log(`[DAppPermissions] Signing auto-approve ${enabled ? 'enabled' : 'disabled'} for:`, key);
  return true;
}

/**
 * Remove a site's contract rule (the chrome's), today's and Q9's limited
 * one for the same call, in one write: main's own, which only narrows.
 * Never rejects.
 * @param {string} origin
 * @param {string} to - Contract address
 * @param {string} selector - 4-byte function selector
 * @param {number} chainId
 * @returns {Promise<boolean>} True if removed
 */
async function removeTransactionAutoApprove(origin, to, selector, chainId) {
  const key = normalizeOrigin(origin);
  if (!key || typeof to !== 'string' || typeof selector !== 'string') return false;
  const call = { to: to.toLowerCase(), selector: selector.slice(0, 10).toLowerCase(), chain_id: chainId };
  try {
    const reply = await vault().approval.revoke({ store: STORE, key, what: { transaction: call } });
    notDurable(`Contract rule removed for ${key}`, reply);
    if (reply?.revoked !== true) return false;
  } catch (err) {
    writeFailed(`a contract rule of ${key}`, err);
    if (!standsUnsaved(err)) return false;
  }
  reread(key);
  console.log(`[DAppPermissions] Transaction auto-approve removed for ${key}: ${call.to} ${call.selector} chain=${chainId}`);
  return true;
}

/** The chrome's read of a key: the core's entry now, or null. */
async function readGrant(origin) {
  try {
    return await refreshGrant(origin);
  } catch (err) {
    console.error('[DAppPermissions] Failed to read a permission:', err?.message || err);
    return null;
  }
}

/**
 * Register IPC handlers for dApp permissions
 */
function registerDappPermissionsIpc() {
  // The chrome's reads ask the core: the store as it holds it now.
  ipcMain.handle(IPC.DAPP_GET_PERMISSION, (_event, origin) => {
    return readGrant(origin);
  });

  // Refused for every site (freedom-core design 0011, "Grants"; PRQ-4): a
  // connection is written by main itself, for the key it attested, from the
  // user's decision on the prompt it issued (page/page-ethereum.js). The
  // chrome named the site here, so a compromised chrome could connect any
  // site to any account. Revoking stays open: it only narrows.
  ipcMain.handle(IPC.DAPP_GRANT_PERMISSION, () => {
    throw new Error(GRANT_REFUSED);
  });

  // Main tells every live document of the key (`accountsChanged`, from
  // `onGrantChanged`; PRQ-6): the chrome no longer tells a page.
  ipcMain.handle(IPC.DAPP_REVOKE_PERMISSION, (_event, origin) => {
    return revokePermission(origin);
  });

  ipcMain.handle(IPC.DAPP_GET_ALL_PERMISSIONS, async () => {
    try {
      const { records } = await vault().approval.grants({ store: STORE });
      return [...keyed(records).values()];
    } catch (err) {
      console.error('[DAppPermissions] Failed to read permissions:', err?.message || err);
      return [];
    }
  });

  ipcMain.handle(IPC.DAPP_GET_SIGNING_AUTO_APPROVE, async (_event, origin) => {
    return signingRuleStored(await readGrant(origin));
  });

  // Clearing only (freedom-core design 0011, PRQ-5): main sets a site's
  // signing rule through the core, for the requester's key, from the user's
  // "always allow" on a signing prompt main showed (page/page-signing.js). The
  // chrome named the site here, so a rule it sets is refused. Turning one
  // off only narrows, and stays open.
  ipcMain.handle(IPC.DAPP_SET_SIGNING_AUTO_APPROVE, (_event, origin, enabled) => {
    if (enabled !== false) throw new Error(SIGNING_RULE_REFUSED);
    return setSigningAutoApprove(origin, false);
  });

  // No IPC adds a transaction auto-approve rule: the core writes one as it
  // signs a send the user just confirmed on main's own prompt with "Always
  // allow", for the requester's key (security audit O-7; freedom-core
  // design 0011, PRQ-5b; design 0012, APB-2: page/page-sends.js).

  ipcMain.handle(IPC.DAPP_REMOVE_TX_AUTO_APPROVE, (_event, origin, to, selector, chainId) => {
    return removeTransactionAutoApprove(origin, to, selector, chainId);
  });

  console.log('[DAppPermissions] IPC handlers registered');
}

function _resetCache() {
  grants.clear();
  applied.clear();
  seq = 0;
  wholeAt = 0;
  attachedCore = null;
  loadedOnce = false;
  loadWaiters = [];
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
  signingRuleStored,
  removeTransactionAutoApprove,
  refreshPermissions,
  refreshGrant,
  attachCore,
  whenLoaded,
  onGrantChanged,
  registerDappPermissionsIpc,
  _resetCache,
};
