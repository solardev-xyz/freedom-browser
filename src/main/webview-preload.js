/**
 * Preload script for webviews
 *
 * This runs in the context of all webviews:
 * - Exposes freedomAPI for internal pages (freedom://history, etc.)
 * - Handles context menu for all pages
 */

const { contextBridge, ipcRenderer } = require('electron');

// The webview preload runs in a sandbox — require() is restricted to a small
// whitelist (electron, events, timers, url), so we cannot read provider
// injection sources from disk here. The main process reads them and serves
// the content over sync IPC.
const ETHEREUM_INJECT_SOURCE = ipcRenderer.sendSync('internal:get-ethereum-inject-source');

// Internal pages list — canonical source is src/shared/internal-pages.json,
// served by the main process via sync IPC so preloads don't need require().
const internalPages = ipcRenderer.sendSync('internal:get-pages');

// Whitelist of all internal page files (routable + other like error.html)
const ALLOWED_FILES = [...Object.values(internalPages.routable), ...internalPages.other];

const isInternalPage = () => {
  const location = globalThis.location;
  if (!location || location.protocol !== 'file:') return false;
  const pathname = location.pathname || '';
  return ALLOWED_FILES.some((file) => pathname.endsWith(`/pages/${file}`));
};

const isSettingsPage = () => {
  const location = globalThis.location;
  if (!location || location.protocol !== 'file:') return false;
  const pathname = location.pathname || '';
  const settingsFile = internalPages.routable?.settings || 'settings.html';
  return pathname.endsWith(`/pages/${settingsFile}`);
};

const isProfilesPage = () => {
  const location = globalThis.location;
  if (!location || location.protocol !== 'file:') return false;
  const pathname = location.pathname || '';
  const profilesFile = internalPages.routable?.profiles || 'profiles.html';
  return pathname.endsWith(`/pages/${profilesFile}`);
};

// Profile management (rename / delete / import / open + the create-modal
// trigger) is allowed from the settings Profile section and the dedicated
// freedom://profiles manager page.
const isProfileManagerPage = () => isSettingsPage() || isProfilesPage();

const guardInternal =
  (name, fn) =>
  (...args) => {
    if (!isInternalPage()) {
      const url = globalThis.location?.href || 'unknown';
      console.warn(`[freedomAPI] blocked "${name}" on non-internal page: ${url}`);
      return Promise.reject(new Error('freedomAPI is only available on internal pages'));
    }
    return fn(...args);
  };

const guardSettingsPage =
  (name, fn) =>
  (...args) => {
    if (!isSettingsPage()) {
      const url = globalThis.location?.href || 'unknown';
      console.warn(`[freedomAPI] blocked settings-only "${name}" on page: ${url}`);
      return Promise.reject(new Error('freedomAPI profile changes are only available on settings'));
    }
    return fn(...args);
  };

const guardProfileManagerPage =
  (name, fn) =>
  (...args) => {
    if (!isProfileManagerPage()) {
      const url = globalThis.location?.href || 'unknown';
      console.warn(`[freedomAPI] blocked profile-management "${name}" on page: ${url}`);
      return Promise.reject(
        new Error('freedomAPI profile changes are only available on profile management pages')
      );
    }
    return fn(...args);
  };

// Webviews reuse the same webContents across navigations, so ipcRenderer
// listeners registered by one page survive into the next. Track every
// subscription and tear them all down on pagehide so callers don't have to.
const activeSubscriptions = new Set();
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const unsubscribe of activeSubscriptions) {
      try {
        unsubscribe();
      } catch {
        // best-effort cleanup
      }
    }
    activeSubscriptions.clear();
  });
}

const guardInternalSubscription = (name, channel) => (callback) => {
  if (!isInternalPage()) {
    console.warn(`[freedomAPI] blocked subscription "${name}" on non-internal page`);
    return () => {};
  }
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  const unsubscribe = () => {
    ipcRenderer.removeListener(channel, handler);
    activeSubscriptions.delete(unsubscribe);
  };
  activeSubscriptions.add(unsubscribe);
  return unsubscribe;
};

const findClosestAnchor = (start) => {
  let element = start;
  while (element && element !== document.body) {
    if (element.tagName === 'A') return element;
    element = element.parentElement;
  }
  return null;
};

const getRawDwebHref = (anchor) => {
  const rawHref = anchor?.getAttribute?.('href')?.trim();
  if (!rawHref) return null;
  if (/^(ipfs|ipns):\/\//i.test(rawHref)) return rawHref;
  return null;
};

// Intercept dweb links before Chromium resolves the anchor href. `ipfs:` and
// `ipns:` are standard schemes, so the browser lowercases the host segment
// before will-navigate fires (and before setWindowOpenHandler fires for
// _blank / Cmd+Click new windows); that destroys CIDv0/CIDv1-base58btc/
// base58 IPNS keys. The raw DOM attribute still has the original case, so
// route it through the host renderer's loadTarget/formatIpfsUrl pipeline
// while the bytes are recoverable. Same-tab and new-tab dispositions are
// both handled here so the new-window code path (Chromium →
// setWindowOpenHandler → tab:new-with-url in the main process) never gets
// the lowercased URL — see `src/main/webcontents-setup.js#setWindowOpenHandler`.
//
// Two listeners — one each for `click` (primary button) and `auxclick`
// (non-primary, i.e. middle/right). Per the UI Events spec, modern
// Chromium dispatches `click` only for the primary button; middle-click
// link activations arrive via `auxclick` exclusively. A previous version
// only listened to `click` and relied on `event.button === 1` inside that
// handler, which never fired for real middle-clicks (it only matched
// dispatched-from-script synthetic events used by the unit tests).
const handleDwebLinkActivation = (event) => {
  if (event.defaultPrevented) return;
  // Primary (0, click) or middle (1, auxclick) — that's the only
  // intersection our two listeners care about. Right-click (2) is owned
  // by the contextmenu listener.
  if (event.button !== 0 && event.button !== 1) return;

  const anchor = findClosestAnchor(event.target);
  const href = getRawDwebHref(anchor);
  if (!href) return;

  // Mirror Chromium's link disposition heuristic: middle-click,
  // ctrl/cmd-click, shift-click, or `target="_blank"` open in a new tab;
  // a named `target` (anything not starting with `_`) reuses an existing
  // tab with that name (or opens a new one if none exists); everything
  // else navigates the current tab. (We don't distinguish foreground vs
  // background tab here — same as freedom's existing `tab:new-with-url`
  // flow which always opens foreground.)
  //
  // The target attribute is forwarded so the host renderer can route
  // through the same named-tab reuse path that Chromium's
  // setWindowOpenHandler → tab:new-with-url uses for non-dweb links.
  // Without this, a named target on a dweb link would silently fall
  // into the unconditional newTab branch and lose its tab-reuse
  // semantics. (`_blank` / `_self` / `_parent` / `_top` are passed
  // through too but the renderer only treats names without a leading
  // underscore as named targets, mirroring webcontents-setup.js.)
  const target = anchor.getAttribute?.('target') || '';
  const isBlank = /^_blank$/i.test(target);
  const isNamedTarget = target && !target.startsWith('_');
  const wantsNewTab =
    event.button === 1 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    isBlank ||
    isNamedTarget;

  event.preventDefault();
  ipcRenderer.sendToHost('link:navigate', {
    url: href,
    disposition: wantsNewTab ? 'newTab' : 'currentTab',
    target: target || null,
  });
};

document.addEventListener('click', handleDwebLinkActivation, true);
document.addEventListener('auxclick', handleDwebLinkActivation, true);

// Notify the host renderer when the cursor enters/leaves the bottom-left
// region of the viewport so the link-hover URL preview can flip to the
// opposite corner (matches Chrome's status-bubble behaviour). Only emits
// on zone transitions to keep IPC traffic minimal — for typical browsing
// the channel is silent.
//
// Width must track the actual bar's `max-width: min(70%, 640px)` from
// link-status.css. Both reference the webview content area — the CSS
// `%` resolves against the bar's positioning ancestor `.content-page`,
// and `window.innerWidth` here is the guest webview's viewport, which
// is the same width as `.content-page`. Keeping these consistent
// matters when the sidebar is open: a `vw`-based CSS width plus a
// webview-relative zone width would diverge by the sidebar's 320 px
// and leave a band where the bar covers the link the user is hovering.
const LINK_STATUS_ZONE_BAND_PX = 28; // bottom band height (~bar height)
const LINK_STATUS_ZONE_MAX_WIDTH_PX = 640;
const LINK_STATUS_ZONE_CONTENT_FRACTION = 0.7;
const linkStatusZoneWidth = () =>
  Math.min(LINK_STATUS_ZONE_MAX_WIDTH_PX, window.innerWidth * LINK_STATUS_ZONE_CONTENT_FRACTION);
let linkStatusInZone = false;
const sendLinkStatusZone = (inZone) => {
  if (linkStatusInZone === inZone) return;
  linkStatusInZone = inZone;
  ipcRenderer.sendToHost('link-status:zone', { inLeftZone: inZone });
};
document.addEventListener(
  'mousemove',
  (event) => {
    const inZone =
      event.clientY > window.innerHeight - LINK_STATUS_ZONE_BAND_PX &&
      event.clientX < linkStatusZoneWidth();
    sendLinkStatusZone(inZone);
  },
  { passive: true, capture: true }
);
document.addEventListener('mouseleave', () => sendLinkStatusZone(false));
window.addEventListener('blur', () => sendLinkStatusZone(false));

// Expose APIs to internal pages (guarded for safety)
contextBridge.exposeInMainWorld('freedomAPI', {
  // History
  getHistory: guardInternal('getHistory', (options) => ipcRenderer.invoke('history:get', options)),
  addHistory: guardInternal('addHistory', (entry) => ipcRenderer.invoke('history:add', entry)),
  removeHistory: guardInternal('removeHistory', (id) => ipcRenderer.invoke('history:remove', id)),
  clearHistory: guardInternal('clearHistory', () => ipcRenderer.invoke('history:clear')),

  // Unified payment history (read-only — producers record in main directly).
  getPayments: guardInternal('getPayments', (filters) =>
    ipcRenderer.invoke('payments:get-recent', filters)
  ),
  getPaymentsCount: guardInternal('getPaymentsCount', (filters) =>
    ipcRenderer.invoke('payments:get-count', filters)
  ),
  clearPayments: guardInternal('clearPayments', () => ipcRenderer.invoke('payments:clear')),

  // Token registry — used by the payments page to resolve asset
  // metadata (symbol, decimals) per chainId:address.
  getTokens: guardInternal('getTokens', (chainId) =>
    ipcRenderer.invoke('tokens:get-tokens', chainId)
  ),

  // Settings
  getSettings: guardInternal('getSettings', () => ipcRenderer.invoke('settings:get')),
  saveSettings: guardInternal('saveSettings', (settings) =>
    ipcRenderer.invoke('settings:save', settings)
  ),
  relaunchApp: guardInternal('relaunchApp', () => ipcRenderer.send('app:relaunch')),

  // Platform / environment info needed by settings page
  getPlatform: guardInternal('getPlatform', () => ipcRenderer.invoke('window:get-platform')),
  getActiveProfile: guardInternal('getActiveProfile', () =>
    ipcRenderer.invoke('profile:get-active')
  ),
  onProfileUpdated: guardInternalSubscription('onProfileUpdated', 'profile:updated'),
  listProfiles: guardInternal('listProfiles', () => ipcRenderer.invoke('profile:list')),
  createProfile: guardProfileManagerPage('createProfile', (profile) =>
    ipcRenderer.invoke('profile:create', profile)
  ),
  importProfile: guardProfileManagerPage('importProfile', (id) =>
    ipcRenderer.invoke('profile:import', { id })
  ),
  renameProfile: guardProfileManagerPage('renameProfile', (id, displayName) =>
    ipcRenderer.invoke('profile:rename', { id, displayName })
  ),
  openProfile: guardProfileManagerPage('openProfile', (id) =>
    ipcRenderer.invoke('profile:open', { id })
  ),
  // Opens the profile and lands its window on the Profile settings page (where
  // renaming now lives). The intent is a boolean flag — main maps it to the
  // internal deep-link so an arbitrary URL never crosses this boundary.
  openProfileSettings: guardProfileManagerPage('openProfileSettings', (id) =>
    ipcRenderer.invoke('profile:open', { id, openSettings: true })
  ),
  deleteProfile: guardProfileManagerPage('deleteProfile', (id, confirmDisplayName) =>
    ipcRenderer.invoke('profile:delete', { id, confirmDisplayName })
  ),
  updateProfileNodeConfig: guardSettingsPage('updateProfileNodeConfig', (protocol, config) =>
    ipcRenderer.invoke('profile:update-node-config', { protocol, config })
  ),
  // Asks main to open the chrome's shared create-profile modal over this
  // webview's owning window.
  requestCreateProfileModal: guardProfileManagerPage('requestCreateProfileModal', () =>
    ipcRenderer.send('profile:request-create-modal')
  ),

  // Network configuration (the Networks settings page + the ENS lens).
  getNetworkConfig: guardInternal('getNetworkConfig', () =>
    ipcRenderer.invoke('networks:get-config')
  ),
  updateNetwork: guardInternal('updateNetwork', (chainId, patch) =>
    ipcRenderer.invoke('networks:update-network', chainId, patch)
  ),
  upsertEndpointSource: guardInternal('upsertEndpointSource', (id, source) =>
    ipcRenderer.invoke('networks:upsert-source', id, source)
  ),
  removeEndpointSource: guardInternal('removeEndpointSource', (id) =>
    ipcRenderer.invoke('networks:remove-source', id)
  ),
  restoreEndpointSource: guardInternal('restoreEndpointSource', (id) =>
    ipcRenderer.invoke('networks:restore-source', id)
  ),
  setNetworkApiKey: guardInternal('setNetworkApiKey', (providerId, apiKey) =>
    ipcRenderer.invoke('networks:set-api-key', providerId, apiKey)
  ),
  removeNetworkApiKey: guardInternal('removeNetworkApiKey', (providerId) =>
    ipcRenderer.invoke('networks:remove-api-key', providerId)
  ),
  testNetworkApiKey: guardInternal('testNetworkApiKey', (providerId, apiKey) =>
    ipcRenderer.invoke('networks:test-api-key', providerId, apiKey)
  ),
  searchChains: guardInternal('searchChains', (query) =>
    ipcRenderer.invoke('networks:search-chains', query)
  ),
  getCatalogChain: guardInternal('getCatalogChain', (chainId) =>
    ipcRenderer.invoke('networks:get-catalog-chain', chainId)
  ),
  addChain: guardInternal('addChain', (chain, rpcUrls) =>
    ipcRenderer.invoke('networks:add-chain', chain, rpcUrls)
  ),
  removeChain: guardInternal('removeChain', (chainId) =>
    ipcRenderer.invoke('networks:remove-chain', chainId)
  ),

  // Service registry snapshot (read-only).
  getServiceRegistry: guardInternal('getServiceRegistry', () =>
    ipcRenderer.invoke('service-registry:get')
  ),

  // Opens the sidebar publish-setup checklist in the host window.
  openPublishSetup: guardInternal('openPublishSetup', () =>
    ipcRenderer.invoke('sidebar:open-publish-setup')
  ),

  // Auto-unsubscribed on pagehide.
  onSettingsUpdated: guardInternalSubscription('onSettingsUpdated', 'settings:updated'),
  // freedom://payments uses this for live refresh on settlements (no
  // user-driven event for a server-acknowledged paid request).
  onPaymentRecorded: guardInternalSubscription('onPaymentRecorded', 'payments:tx-recorded'),

  // Bookmarks (read-only for internal pages)
  getBookmarks: guardInternal('getBookmarks', () => ipcRenderer.invoke('bookmarks:get')),

  // Navigation
  openInNewTab: guardInternal('openInNewTab', (url) =>
    ipcRenderer.invoke('internal:open-url-in-new-tab', url)
  ),

  // Signals from ENS interstitial pages back to the address-bar shell.
  // Uses sendToHost because the shell is the webview's parent frame, not
  // the main process — shorter, avoids a main round-trip. Both sides of
  // this channel are renderer code; preload's sandbox blocks relative
  // require, and navigation.js is ESM and can't import the CommonJS
  // shared module — strings are kept hardcoded on both ends.
  ensContinueUnverified: guardInternal('ensContinueUnverified', (name) => {
    ipcRenderer.sendToHost('ens:continue-unverified', { name });
  }),
  ensOpenSettings: guardInternal('ensOpenSettings', () => {
    ipcRenderer.sendToHost('ens:open-settings');
  }),

  // Favicons
  getCachedFavicon: guardInternal('getCachedFavicon', (url) =>
    ipcRenderer.invoke('favicon:get-cached', url)
  ),

  // Radicle
  seedRadicle: guardInternal('seedRadicle', (rid) => ipcRenderer.invoke('radicle:seed', rid)),
  getRadicleStatus: guardInternal('getRadicleStatus', () =>
    ipcRenderer.invoke('radicle:getStatus')
  ),
  getRadicleRepoPayload: guardInternal('getRadicleRepoPayload', (rid) =>
    ipcRenderer.invoke('radicle:getRepoPayload', rid)
  ),
  syncRadicleRepo: guardInternal('syncRadicleRepo', (rid) =>
    ipcRenderer.invoke('radicle:syncRepo', rid)
  ),

  // Clipboard
  copyText: guardInternal('copyText', (text) => ipcRenderer.invoke('clipboard:copy-text', text)),

  // Swarm publishing (internal-only, path-based methods)
  swarm: {
    publishData: guardInternal('swarm.publishData', (data) =>
      ipcRenderer.invoke('swarm:publish-data', data)
    ),
    publishFilePath: guardInternal('swarm.publishFilePath', (filePath) =>
      ipcRenderer.invoke('swarm:publish-file', filePath)
    ),
    publishDirectoryPath: guardInternal('swarm.publishDirectoryPath', (dirPath) =>
      ipcRenderer.invoke('swarm:publish-directory', dirPath)
    ),
    getUploadStatus: guardInternal('swarm.getUploadStatus', (tagUid) =>
      ipcRenderer.invoke('swarm:get-upload-status', tagUid)
    ),
    getStamps: guardInternal('swarm.getStamps', () => ipcRenderer.invoke('swarm:get-stamps')),
    pickFileForPublish: guardInternal('swarm.pickFileForPublish', () =>
      ipcRenderer.invoke('swarm:pick-file')
    ),
    pickDirectoryForPublish: guardInternal('swarm.pickDirectoryForPublish', () =>
      ipcRenderer.invoke('swarm:pick-directory')
    ),
    getPublishHistory: guardInternal('swarm.getPublishHistory', () =>
      ipcRenderer.invoke('swarm:get-publish-history')
    ),
    clearPublishHistory: guardInternal('swarm.clearPublishHistory', () =>
      ipcRenderer.invoke('swarm:clear-publish-history')
    ),
  },
});

// ============================================
// Context Menu Handler (works on all pages)
// ============================================

// Get context information when right-clicking.
//
// Registered on window in the capture phase: window is the first node in the
// capture path and the preload runs before any page script, so no page
// handler (not even a window-level capture listener calling
// stopPropagation()) can starve the interceptor. The send is deferred with
// setTimeout so the defaultPrevented check happens after the full dispatch,
// honoring only a genuine preventDefault() from the page (standard browser
// semantics).
window.addEventListener(
  'contextmenu',
  (event) => {
    const context = {
      x: event.clientX,
      y: event.clientY,
      pageUrl: window.location.href,
      pageTitle: document.title,
      linkUrl: null,
      linkText: null,
      selectedText: null,
      imageSrc: null,
      imageAlt: null,
      isEditable: false,
      mediaType: null,
    };

    // Check for selected text
    const selection = window.getSelection();
    if (selection && selection.toString().trim()) {
      context.selectedText = selection.toString();
    }

    // Walk up the DOM tree to find links, images, etc.
    let element = event.target;
    while (element && element !== document.body) {
      // Check for links
      if (element.tagName === 'A' && element.href) {
        context.linkUrl = getRawDwebHref(element) || element.href;
        context.linkText = element.textContent?.trim() || '';
      }

      // Check for images
      if (element.tagName === 'IMG' && element.src) {
        context.imageSrc = element.src;
        context.imageAlt = element.alt || '';
        context.mediaType = 'image';
      }

      // Check for video
      if (element.tagName === 'VIDEO') {
        context.mediaType = 'video';
        if (element.src) {
          context.mediaSrc = element.src;
        } else if (element.querySelector('source')) {
          context.mediaSrc = element.querySelector('source').src;
        }
      }

      // Check for audio
      if (element.tagName === 'AUDIO') {
        context.mediaType = 'audio';
        if (element.src) {
          context.mediaSrc = element.src;
        } else if (element.querySelector('source')) {
          context.mediaSrc = element.querySelector('source').src;
        }
      }

      // Check if element is editable
      if (
        element.tagName === 'INPUT' ||
        element.tagName === 'TEXTAREA' ||
        element.isContentEditable
      ) {
        context.isEditable = true;
      }

      element = element.parentElement;
    }

    // Decide after page handlers have run (setTimeout fires after the
    // event dispatch completes; a microtask would run between listeners).
    setTimeout(() => {
      // The page suppressed the menu with preventDefault() — honor it.
      if (event.defaultPrevented) return;

      // Send context info to the host renderer
      ipcRenderer.sendToHost('context-menu', context);
    }, 0);
  },
  true
);

// Handle context menu actions from the renderer
ipcRenderer.on('context-menu-action', (_event, action, data) => {
  switch (action) {
    case 'copy':
      document.execCommand('copy');
      break;
    case 'cut':
      document.execCommand('cut');
      break;
    case 'paste':
      document.execCommand('paste');
      break;
    case 'select-all':
      document.execCommand('selectAll');
      break;
    case 'copy-text':
      if (data?.text) {
        navigator.clipboard.writeText(data.text).catch(console.error);
      }
      break;
  }
});

// ============================================
// Ethereum Provider (EIP-1193)
// ============================================

// Injected into the page realm so dapps see window.ethereum as an own-property
// of their own window, which many wallet-detection libraries require.
// The preload realm only bridges messages to/from the host renderer (below).
try {
  const script = document.createElement('script');
  script.textContent = ETHEREUM_INJECT_SOURCE;

  // Inject before any page scripts run
  const inject = () => {
    const head = document.head || document.documentElement;
    head.insertBefore(script, head.firstChild);
    script.remove();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', inject, { once: true });
  } else {
    inject();
  }
} catch (err) {
  console.error('[webview-preload] Failed to inject ethereum provider:', err);
}

// Bridge postMessage from page to IPC
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.type === 'FREEDOM_ETHEREUM_REQUEST') {
    const { id, method, params } = event.data;
    const origin = window.location.origin;

    ipcRenderer.sendToHost('dapp:provider-request', {
      id,
      method,
      params,
      origin,
    });
  }
});

// Bridge IPC responses back to page
ipcRenderer.on('dapp:provider-response', (_event, { id, result, error }) => {
  console.log('[webview-preload] Received provider response:', { id, result, error });
  window.postMessage(
    {
      type: 'FREEDOM_ETHEREUM_RESPONSE',
      id,
      result,
      error,
    },
    window.location.origin
  );
});

ipcRenderer.on('dapp:provider-event', (_event, { event, data }) => {
  window.postMessage(
    {
      type: 'FREEDOM_ETHEREUM_EVENT',
      event,
      data,
    },
    window.location.origin
  );
});

// ============================================
// Swarm Provider (window.swarm)
// ============================================

try {
  const swarmScript = document.createElement('script');
  swarmScript.textContent = `
    (function() {
      const pendingRequests = new Map();
      let requestId = 0;
      const eventListeners = { connect: [], disconnect: [] };

      function emitEvent(event, data) {
        if (eventListeners[event]) {
          eventListeners[event].forEach(h => { try { h(data); } catch(e) {} });
        }
      }

      window.swarm = {
        isFreedomBrowser: true,

        async request({ method, params }) {
          if (!method) throw new Error('method is required');
          const id = ++requestId;
          return new Promise((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject });
            window.postMessage({ type: 'FREEDOM_SWARM_REQUEST', id, method, params: params || {} }, '*');
            const longRunning = method.startsWith('swarm_publish') ||
              method === 'swarm_createFeed' ||
              method === 'swarm_updateFeed' ||
              method === 'swarm_writeFeedEntry' ||
              method === 'swarm_writeSingleOwnerChunk' ||
              method === 'swarm_getSigningIdentity' ||
              method === 'swarm_apiRequest';
            const timeout = longRunning ? 300000 : 60000;
            setTimeout(() => {
              if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                const err = new Error('Request timed out');
                err.code = -32603;
                reject(err);
              }
            }, timeout);
          });
        },

        requestAccess() { return this.request({ method: 'swarm_requestAccess' }); },
        getCapabilities() { return this.request({ method: 'swarm_getCapabilities' }); },
        publishData(params) { return this.request({ method: 'swarm_publishData', params: params }); },
        publishFiles(params) { return this.request({ method: 'swarm_publishFiles', params: params }); },
        getUploadStatus(params) { return this.request({ method: 'swarm_getUploadStatus', params: params }); },
        createFeed(params) { return this.request({ method: 'swarm_createFeed', params: params }); },
        updateFeed(params) { return this.request({ method: 'swarm_updateFeed', params: params }); },
        writeFeedEntry(params) { return this.request({ method: 'swarm_writeFeedEntry', params: params }); },
        readFeedEntry(params) { return this.request({ method: 'swarm_readFeedEntry', params: params }); },
        listFeeds() { return this.request({ method: 'swarm_listFeeds' }); },
        publishChunk(params) { return this.request({ method: 'swarm_publishChunk', params: params }); },
        readChunk(params) { return this.request({ method: 'swarm_readChunk', params: params }); },
        writeSingleOwnerChunk(params) { return this.request({ method: 'swarm_writeSingleOwnerChunk', params: params }); },
        readSingleOwnerChunk(params) { return this.request({ method: 'swarm_readSingleOwnerChunk', params: params }); },
        getSigningIdentity() { return this.request({ method: 'swarm_getSigningIdentity' }); },
        apiRequest(params) { return this.request({ method: 'swarm_apiRequest', params: params }); },

        on(event, handler) { if (eventListeners[event]) eventListeners[event].push(handler); return this; },
        removeListener(event, handler) {
          if (eventListeners[event]) {
            const i = eventListeners[event].indexOf(handler);
            if (i > -1) eventListeners[event].splice(i, 1);
          }
          return this;
        },
        addListener(event, handler) { return this.on(event, handler); },
        removeAllListeners(event) {
          if (event && eventListeners[event]) eventListeners[event] = [];
          if (!event) Object.keys(eventListeners).forEach((key) => { eventListeners[key] = []; });
          return this;
        },
      };

      window.addEventListener('message', function(event) {
        if (event.source !== window) return;
        if (event.data.type === 'FREEDOM_SWARM_RESPONSE') {
          const pending = pendingRequests.get(event.data.id);
          if (pending) {
            pendingRequests.delete(event.data.id);
            if (event.data.error) {
              const err = new Error(event.data.error.message);
              err.code = event.data.error.code;
              err.data = event.data.error.data;
              pending.reject(err);
            } else {
              pending.resolve(event.data.result);
            }
          }
        } else if (event.data.type === 'FREEDOM_SWARM_EVENT') {
          emitEvent(event.data.event, event.data.data);
        }
      });
    })();
  `;

  const injectSwarm = () => {
    const head = document.head || document.documentElement;
    head.insertBefore(swarmScript, head.firstChild);
    swarmScript.remove();
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectSwarm, { once: true });
  } else {
    injectSwarm();
  }
} catch (err) {
  console.error('[webview-preload] Failed to inject swarm provider:', err);
}

// Bridge postMessage from page to IPC (Swarm)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.type === 'FREEDOM_SWARM_REQUEST') {
    const { id, method, params } = event.data;
    ipcRenderer.sendToHost('swarm:provider-request', { id, method, params });
  }
});

// Bridge IPC responses back to page (Swarm)
ipcRenderer.on('swarm:provider-response', (_event, { id, result, error }) => {
  window.postMessage(
    {
      type: 'FREEDOM_SWARM_RESPONSE',
      id,
      result,
      error,
    },
    window.location.origin
  );
});

ipcRenderer.on('swarm:provider-event', (_event, { event, data }) => {
  window.postMessage(
    {
      type: 'FREEDOM_SWARM_EVENT',
      event,
      data,
    },
    window.location.origin
  );
});

// Note: transient 404/500 recovery for bzz:// sub-resources is handled by the
// main-process `bzz:` protocol handler in `src/main/swarm/bzz-protocol.js`,
// not by in-page JavaScript. See README "Swarm Content Retrieval".

console.log('[webview-preload] Loaded (freedomAPI + context menu + ethereum + swarm provider)');
