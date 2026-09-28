/**
 * IPC sender policy: who may call which main-process IPC channel.
 *
 * Every tab <webview> — including hostile https/bzz/ipfs pages and their
 * iframes — runs `webview-preload.js`, and that preload holds a real
 * `ipcRenderer`. Its own guards (`guardInternal`, `guardSettingsPage`, …)
 * only hold for as long as the renderer process is honest: a renderer
 * exploit calls `ipcRenderer.invoke('wallet:send-transaction', …)` directly.
 * Before this module, main checked the sender on a handful of channels only
 * (myotis recovery, profile mutations, clipboard read), so that one step
 * reached silent signing, secret export, permission self-grants and
 * arbitrary-file publishing. See docs/security-audit-electron.md, E-1.
 *
 * The policy is applied centrally by wrapping `ipcMain.handle`/`ipcMain.on`
 * before any module registers a handler, so no handler can be added without
 * it — a per-handler check is exactly the kind of guard that silently goes
 * missing on the next new channel. The tiers, by sender:
 *
 *   - The chrome renderer — the top frame of our own `renderer/index.html` in
 *     a BrowserWindow — may call every channel.
 *   - A tab webview may call only the channels its preload actually uses,
 *     each at the same tier the preload's own guard gives it:
 *       PUBLIC   any sender, any frame (read-only document-start bootstrap,
 *                adblock);
 *       INTERNAL the top frame of one of our internal pages
 *                (`renderer/pages/<file>` from internal-pages.json);
 *       SETTINGS the top frame of settings.html;
 *       PROFILE_MANAGER settings.html or profiles.html.
 *     `ipc-sender-policy.test.js` parses webview-preload.js and fails if a
 *     channel is added there without a tier here, or given a different tier.
 *   - Anything else (another webContents type, a sub-frame of the chrome, a
 *     frame that already navigated away) is refused.
 *
 * Paths are compared exactly (resolved `fileURLToPath` of the sender frame
 * against this checkout's / this asar's `renderer` directory), never by
 * suffix: a local file saved as `…/pages/settings.html` elsewhere on disk is
 * not an internal page.
 */
const path = require('path');
const { fileURLToPath } = require('url');

const RENDERER_DIR = path.resolve(__dirname, '..', 'renderer');
const CHROME_INDEX = path.join(RENDERER_DIR, 'index.html');
const PAGES_DIR = path.join(RENDERER_DIR, 'pages');

const internalPages = require('../shared/internal-pages.json');
const INTERNAL_PAGE_FILES = new Set([
  ...Object.values(internalPages.routable),
  ...internalPages.other,
]);
const SETTINGS_FILE = internalPages.routable.settings;
const PROFILES_FILE = internalPages.routable.profiles;

const TIER = Object.freeze({
  PUBLIC: 'public',
  INTERNAL: 'internal',
  SETTINGS: 'settings',
  PROFILE_MANAGER: 'profile-manager',
});

// Channels webview-preload.js reaches main on, outside any freedomAPI guard.
// Everything here must be safe to answer for arbitrary web content — and for
// any sender at all, since this tier is not narrowed by sender type.
const PUBLIC_CHANNELS = [
  'adblock:scriptlets',
  'adblock:cosmetic',
  'private:is-private',
  'internal:get-ethereum-inject-source',
  'internal:get-pages',
];

// freedomAPI methods wrapped in guardInternal (plus the internal-page theme
// read, which the preload only issues on an internal page).
const INTERNAL_CHANNELS = [
  'adblock:get-allowlist',
  'adblock:get-status',
  'app:relaunch',
  'bookmarks:get',
  'clipboard:copy-text',
  'downloads:cancel',
  'downloads:clear',
  'downloads:get',
  'downloads:open-file',
  'downloads:pause',
  'downloads:remove',
  'downloads:resume',
  'downloads:show-in-folder',
  'favicon:get-cached',
  'history:add',
  'history:clear',
  'history:get',
  'history:remove',
  'internal:get-theme',
  'internal:open-url-in-new-tab',
  'myotis:getStatus',
  'networks:add-chain',
  'networks:get-catalog-chain',
  'networks:get-config',
  'networks:remove-api-key',
  'networks:remove-chain',
  'networks:remove-source',
  'networks:reset-source-coverage',
  'networks:restore-source',
  'networks:search-chains',
  'networks:set-api-key',
  'networks:test-api-key',
  'networks:update-network',
  'networks:upsert-source',
  'payments:clear',
  'payments:get-count',
  'payments:get-recent',
  'permissions:get-all',
  'profile:get-active',
  'profile:list',
  'radicle:getSeedStatus',
  'radicle:getStatus',
  'radicle:seed',
  'radicle:syncRepo',
  'service-registry:get',
  'settings:get',
  'settings:save',
  'shortcuts:get-state',
  'sidebar:open-publish-setup',
  'swarm:clear-publish-history',
  'swarm:get-publish-history',
  'swarm:get-stamps',
  'swarm:get-upload-status',
  'swarm:pick-directory',
  'swarm:pick-file',
  'swarm:publish-data',
  'swarm:publish-directory',
  'swarm:publish-file',
  'tokens:get-tokens',
  'window:get-platform',
];

// freedomAPI methods wrapped in guardSettingsPage.
const SETTINGS_CHANNELS = [
  'adblock:add-allowlist-host',
  'adblock:remove-allowlist-host',
  'permissions:revoke',
  'permissions:revoke-all',
  'permissions:revoke-origin',
  'profile:update-node-config',
  'radicle:checkBinary',
  'shortcuts:preview-binding',
  'shortcuts:reset',
  'shortcuts:set-override',
  'tor:checkBinary',
];

// freedomAPI methods wrapped in guardProfileManagerPage.
const PROFILE_MANAGER_CHANNELS = [
  'profile:create',
  'profile:delete',
  'profile:import',
  'profile:open',
  'profile:rename',
  'profile:request-create-modal',
];

const WEBVIEW_CHANNEL_TIERS = new Map([
  ...PUBLIC_CHANNELS.map((c) => [c, TIER.PUBLIC]),
  ...INTERNAL_CHANNELS.map((c) => [c, TIER.INTERNAL]),
  ...SETTINGS_CHANNELS.map((c) => [c, TIER.SETTINGS]),
  ...PROFILE_MANAGER_CHANNELS.map((c) => [c, TIER.PROFILE_MANAGER]),
]);

function senderType(event) {
  try {
    return event?.sender?.getType?.() || null;
  } catch {
    return null;
  }
}

// The sender frame's file path, or null when the frame is gone, is not the
// sender's top frame, or is not a file: URL.
function topFrameFilePath(event) {
  try {
    const frame = event?.senderFrame;
    if (!frame || frame !== event.sender?.mainFrame) return null;
    const url = frame.url;
    if (typeof url !== 'string' || !url.startsWith('file:')) return null;
    return path.resolve(fileURLToPath(url));
  } catch {
    return null;
  }
}

function isChromeSender(event) {
  return senderType(event) === 'window' && topFrameFilePath(event) === CHROME_INDEX;
}

// The internal page file (`settings.html`, …) a resolved file path names, or
// null. Exact directory comparison — see the file header.
function internalPageFileForPath(filePath) {
  if (!filePath || path.dirname(filePath) !== PAGES_DIR) return null;
  const file = path.basename(filePath);
  return INTERNAL_PAGE_FILES.has(file) ? file : null;
}

// Same check for a frame URL, for callers that only have the URL (the
// webRequest guards in the network layer have a frame, not an IPC event).
function filePathOfUrl(url) {
  try {
    if (typeof url !== 'string' || !url.startsWith('file:')) return null;
    return path.resolve(fileURLToPath(url));
  } catch {
    return null;
  }
}

function internalPageFileForUrl(url) {
  return internalPageFileForPath(filePathOfUrl(url));
}

function isChromeIndexUrl(url) {
  return filePathOfUrl(url) === CHROME_INDEX;
}

function internalPageFileOf(event) {
  if (senderType(event) !== 'webview') return null;
  return internalPageFileForPath(topFrameFilePath(event));
}

/**
 * @returns {boolean} whether `event`'s sender may use `channel`.
 */
function isSenderAllowed(channel, event) {
  if (isChromeSender(event)) return true;
  const tier = WEBVIEW_CHANNEL_TIERS.get(channel);
  if (!tier) return false;
  // Read-only bootstrap answers, safe for anyone. Not narrowed to webviews:
  // the chrome window's preload also asks for `internal:get-pages` from a
  // document whose frame reports no URL yet, and refusing it would only add a
  // warning to every launch.
  if (tier === TIER.PUBLIC) return true;
  const file = internalPageFileOf(event);
  if (!file) return false;
  if (tier === TIER.INTERNAL) return true;
  if (tier === TIER.SETTINGS) return file === SETTINGS_FILE;
  if (tier === TIER.PROFILE_MANAGER) return file === SETTINGS_FILE || file === PROFILES_FILE;
  return false;
}

function describeSender(event) {
  const type = senderType(event) || 'unknown';
  let scheme = 'unknown';
  try {
    scheme = String(event?.senderFrame?.url || '').split(':')[0] || 'unknown';
  } catch {
    // frame disposed
  }
  // Scheme only: the log is persistent and a URL could come from a private
  // window.
  return `${type}/${scheme}`;
}

const INSTALLED = Symbol.for('freedom.ipcSenderPolicy');

/**
 * Wrap `ipcMain.handle`/`handleOnce`/`on`/`once` so every handler registered
 * afterwards runs only for an allowed sender. Must run before any module
 * registers a handler (top of main/index.js). Idempotent.
 */
function installIpcSenderPolicy(ipcMain, { logger = console } = {}) {
  if (!ipcMain || ipcMain[INSTALLED]) return;
  ipcMain[INSTALLED] = true;

  const reject = (channel, event) => {
    logger.warn?.(`[ipc-sender-policy] refused "${channel}" from ${describeSender(event)}`);
  };

  const wrapInvoke = (original) =>
    function (channel, handler) {
      if (typeof handler !== 'function') return original.call(this, channel, handler);
      return original.call(this, channel, function (event, ...args) {
        if (!isSenderAllowed(channel, event)) {
          reject(channel, event);
          throw new Error(`IPC channel "${channel}" is not available to this sender`);
        }
        return handler.call(this, event, ...args);
      });
    };

  // Listeners are wrapped once and remembered, so removeListener/off with the
  // caller's original function still finds the registered wrapper.
  const wrappedListeners = new WeakMap();
  const wrapListener = (channel, listener) => {
    let byChannel = wrappedListeners.get(listener);
    if (!byChannel) {
      byChannel = new Map();
      wrappedListeners.set(listener, byChannel);
    }
    if (!byChannel.has(channel)) {
      byChannel.set(channel, function (event, ...args) {
        if (!isSenderAllowed(channel, event)) {
          reject(channel, event);
          // A refused sendSync must still get an answer, or the calling
          // renderer blocks forever.
          try {
            if (event) event.returnValue = null;
          } catch {
            // not a sync message
          }
          return undefined;
        }
        return listener.call(this, event, ...args);
      });
    }
    return byChannel.get(channel);
  };
  const lookupListener = (channel, listener) =>
    wrappedListeners.get(listener)?.get(channel) || listener;

  const wrapOn = (original) =>
    function (channel, listener) {
      if (typeof listener !== 'function') return original.call(this, channel, listener);
      return original.call(this, channel, wrapListener(channel, listener));
    };
  const wrapOff = (original) =>
    function (channel, listener) {
      return original.call(this, channel, lookupListener(channel, listener));
    };

  ipcMain.handle = wrapInvoke(ipcMain.handle);
  if (typeof ipcMain.handleOnce === 'function') ipcMain.handleOnce = wrapInvoke(ipcMain.handleOnce);
  for (const method of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener']) {
    if (typeof ipcMain[method] === 'function') ipcMain[method] = wrapOn(ipcMain[method]);
  }
  for (const method of ['off', 'removeListener']) {
    if (typeof ipcMain[method] === 'function') ipcMain[method] = wrapOff(ipcMain[method]);
  }
}

module.exports = {
  installIpcSenderPolicy,
  isSenderAllowed,
  isChromeSender,
  internalPageFileForUrl,
  isChromeIndexUrl,
  TIER,
  WEBVIEW_CHANNEL_TIERS,
  PUBLIC_CHANNELS,
  INTERNAL_CHANNELS,
  SETTINGS_CHANNELS,
  PROFILE_MANAGER_CHANNELS,
  CHROME_INDEX,
  PAGES_DIR,
};
