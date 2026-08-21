/**
 * Private (ephemeral) browsing windows.
 *
 * Each private window gets a unique NON-persisted Electron session via a
 * `private-<uuid>` partition (no `persist:` prefix, so Chromium keeps all
 * site data — cookies, localStorage, IndexedDB, caches — in memory only).
 * The partition name is plumbed to the window's renderer as a query
 * parameter; tabs.js stamps it on every webview it creates BEFORE first
 * load, so no private page ever touches the default session.
 *
 * On window close the partition's session is cleared with
 * `clearStorageData()` + `clearCache()` as belt-and-braces (the data is
 * in-memory anyway), registered cleanup hooks run (in-flight private
 * downloads cancel, private download rows purge, session-only permission
 * decisions drop — see src/main/index.js),
 * and all references are dropped. Partition UUIDs are never reused. The
 * download hooks run in registration order: in-flight private downloads are
 * cancelled before their rows are dropped, so no transfer outlives the
 * window that owns it.
 *
 * Write guards elsewhere key off this module's registry:
 *   - history:   src/main/history.js         (PRIVATE MODE GUARD)
 *   - favicons:  src/main/favicons.js        (PRIVATE MODE GUARD)
 *   - publish:   src/main/swarm/publish-service.js (PRIVATE MODE GUARD)
 *   - providers: src/main/webview-preload.js (PRIVATE MODE GUARD, via the
 *                `private:is-private` sync IPC in ipc-handlers.js)
 *
 * The persistent-log guards (window title, downloads, navigation URLs,
 * permission origins) key off the same registry. The dweb protocol handlers
 * and the name resolvers behind them are guarded a level down, by the
 * async-context marker in src/main/private/private-log-context.js — set
 * once by whoever knows the session (the per-session protocol registration,
 * the resolver IPC handlers) and read by every log site underneath.
 */

const crypto = require('crypto');
const log = require('../logger');
const { BrowserWindow, session } = require('electron');

// Lazy: this module is required by the write guards (history, favicons,
// publish-service) purely for isPrivateWebContents(); pulling the window
// factory (and its settings-store dependency tree) into their module
// graphs at require time would be wasted weight — and makes their Jest
// suites needlessly heavy.
function requireCreateMainWindow() {
  return require('../windows/mainWindow').createMainWindow;
}

const PRIVATE_PARTITION_PREFIX = 'private-';

// Live private windows: BrowserWindow id -> { partition, session }.
const privateWindows = new Map();
// All partitions ever created by this process, and the ids of every window
// that ever hosted one. Both outlive the window deliberately: a closed
// window's identity stays "known" so late IPC from a tearing-down window is
// still recognised as private — deny-by-default for anything that ever was
// private. `isPrivateWebContents` consults `everPrivateWindowIds` (not just
// the live map) precisely so the private *chrome* renderer — which runs on
// the DEFAULT session, where the session-identity check cannot see it — is
// still refused by the write guards while its window tears down.
const privatePartitions = new Set();
const everPrivateWindowIds = new Set();
// Live private session objects, for fast sender.session identity checks.
const privateSessions = new Set();

// Configures a freshly created private session (protocol handlers, download
// hook, permission handlers, webRequest dispatcher). Set once at bootstrap
// by src/main/index.js — kept as an injection point so this module doesn't
// import half the app (and so tests can observe the call).
let sessionConfigurator = null;

// Cleanup hooks run (best-effort) when a private window closes, with the
// window's partition name. Registered at bootstrap: private downloads
// purge, session-only permission decisions drop.
const cleanupHooks = [];

function setPrivateSessionConfigurator(fn) {
  sessionConfigurator = typeof fn === 'function' ? fn : null;
}

function registerPrivateCleanup(fn) {
  if (typeof fn === 'function') cleanupHooks.push(fn);
}

/**
 * True for any partition this process ever handed to a private window,
 * including ones whose window has since closed. Callers that hold a
 * partition *name* (rather than a webContents) use this to fail closed —
 * `isPrivateWebContents` is the equivalent check keyed on a sender.
 */
function isPrivatePartition(partition) {
  return typeof partition === 'string' && privatePartitions.has(partition);
}

/**
 * True when the given webContents belongs to a private window — either a
 * webview running on a private partition (session identity) or the private
 * window's own chrome renderer (owning BrowserWindow identity). Used by the
 * main-process write guards; `undefined`/destroyed senders report false.
 */
function isPrivateWebContents(webContents) {
  if (!webContents) return false;
  try {
    if (webContents.session && privateSessions.has(webContents.session)) {
      return true;
    }
  } catch {
    // webContents may be destroyed mid-check
  }
  try {
    const host = webContents.hostWebContents || webContents;
    const win = BrowserWindow.fromWebContents(host);
    // `everPrivateWindowIds`, not `privateWindows`: the live map entry is
    // deleted the moment 'closed' fires, but the chrome renderer can still
    // be dispatching IPC during teardown. Once private, always private.
    return !!win && everPrivateWindowIds.has(win.id);
  } catch {
    return false;
  }
}

/** Partition name for a private window's webContents, or null. */
function getPartitionForWebContents(webContents) {
  if (!webContents) return null;
  try {
    const host = webContents.hostWebContents || webContents;
    const win = BrowserWindow.fromWebContents(host);
    if (win && privateWindows.has(win.id)) {
      return privateWindows.get(win.id).partition;
    }
  } catch {
    // fall through
  }
  return null;
}

function runCleanupHooks(partition) {
  for (const hook of cleanupHooks) {
    try {
      hook(partition);
    } catch (err) {
      log.error('[private] cleanup hook failed:', err?.message || err);
    }
  }
}

/**
 * Evaporate the private session's in-memory state. The non-persisted
 * partition holds nothing on disk, but clearing explicitly is the
 * belt-and-braces the feature promises (and covers Chromium caches that
 * outlive the last webContents on the session).
 */
async function destroyPrivateSession(privateSession, partition) {
  try {
    await privateSession.clearStorageData();
  } catch (err) {
    log.warn(`[private] clearStorageData failed for ${partition}:`, err?.message || err);
  }
  try {
    await privateSession.clearCache();
  } catch (err) {
    log.warn(`[private] clearCache failed for ${partition}:`, err?.message || err);
  }
}

/**
 * Open a new private browsing window.
 *
 * Fails CLOSED: if the session cannot be configured the window is not opened
 * at all and null is returned. A bare private session has no permission
 * handler (Electron's default *grants* every request), no per-session
 * protocol handlers and no downloads hook — i.e. the opposite of what the
 * window promises — so refusing to open is the only safe degradation.
 * Callers treat a falsy result as "nothing happened".
 *
 * @param {string|null} initialUrl - optional URL for the first tab
 * @returns {Electron.BrowserWindow|null}
 */
function createPrivateWindow(initialUrl = null) {
  const partition = `${PRIVATE_PARTITION_PREFIX}${crypto.randomUUID()}`;
  // No `persist:` prefix — this is the whole point: Electron keeps the
  // session in memory and never writes site data under userData.
  const privateSession = session.fromPartition(partition);

  privatePartitions.add(partition);
  privateSessions.add(privateSession);

  if (!sessionConfigurator) {
    log.error('[private] no session configurator installed — refusing to open a private window');
    privateSessions.delete(privateSession);
    return null;
  }
  try {
    sessionConfigurator(privateSession, { partition });
  } catch (err) {
    log.error(
      '[private] session configurator failed — refusing to open a private window:',
      err?.message || err
    );
    privateSessions.delete(privateSession);
    return null;
  }

  const window = requireCreateMainWindow()(initialUrl, { privatePartition: partition });
  privateWindows.set(window.id, { partition, session: privateSession });
  everPrivateWindowIds.add(window.id);
  log.info(`[private] Opened private window ${window.id} on partition ${partition}`);

  window.on('closed', () => {
    privateWindows.delete(window.id);
    runCleanupHooks(partition);
    destroyPrivateSession(privateSession, partition).finally(() => {
      privateSessions.delete(privateSession);
      log.info(`[private] Private window closed, partition ${partition} cleared`);
    });
  });

  return window;
}

function getPrivateWindowCount() {
  return privateWindows.size;
}

// Test-only: drop all registry state (Jest suites share the module).
function _resetState() {
  privateWindows.clear();
  privatePartitions.clear();
  everPrivateWindowIds.clear();
  privateSessions.clear();
  cleanupHooks.length = 0;
  sessionConfigurator = null;
}

module.exports = {
  PRIVATE_PARTITION_PREFIX,
  createPrivateWindow,
  setPrivateSessionConfigurator,
  registerPrivateCleanup,
  isPrivatePartition,
  isPrivateWebContents,
  getPartitionForWebContents,
  getPrivateWindowCount,
  _resetState,
};
