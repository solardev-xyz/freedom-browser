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

// Expose APIs to internal pages (guarded for safety)
contextBridge.exposeInMainWorld('freedomAPI', {
  // History
  getHistory: guardInternal('getHistory', (options) => ipcRenderer.invoke('history:get', options)),
  addHistory: guardInternal('addHistory', (entry) => ipcRenderer.invoke('history:add', entry)),
  removeHistory: guardInternal('removeHistory', (id) => ipcRenderer.invoke('history:remove', id)),
  clearHistory: guardInternal('clearHistory', () => ipcRenderer.invoke('history:clear')),

  // Settings
  getSettings: guardInternal('getSettings', () => ipcRenderer.invoke('settings:get')),
  saveSettings: guardInternal('saveSettings', (settings) =>
    ipcRenderer.invoke('settings:save', settings)
  ),

  // Platform / environment info needed by settings page
  getPlatform: guardInternal('getPlatform', () => ipcRenderer.invoke('window:get-platform')),

  // ENS RPC test (used by settings page)
  testEnsRpc: guardInternal('testEnsRpc', (url) => ipcRenderer.invoke('ens:test-rpc', { url })),

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

  // Bookmarks (read-only for internal pages)
  getBookmarks: guardInternal('getBookmarks', () => ipcRenderer.invoke('bookmarks:get')),

  // Navigation
  openInNewTab: guardInternal('openInNewTab', (url) =>
    ipcRenderer.invoke('internal:open-url-in-new-tab', url)
  ),

  // Favicons
  getCachedFavicon: guardInternal('getCachedFavicon', (url) =>
    ipcRenderer.invoke('favicon:get-cached', url)
  ),

  // Radicle
  seedRadicle: guardInternal('seedRadicle', (rid) => ipcRenderer.invoke('radicle:seed', rid)),
  getRadicleStatus: guardInternal('getRadicleStatus', () => ipcRenderer.invoke('radicle:getStatus')),
  getRadicleRepoPayload: guardInternal('getRadicleRepoPayload', (rid) =>
    ipcRenderer.invoke('radicle:getRepoPayload', rid)
  ),
  syncRadicleRepo: guardInternal('syncRadicleRepo', (rid) =>
    ipcRenderer.invoke('radicle:syncRepo', rid)
  ),

  // Clipboard
  copyText: guardInternal('copyText', (text) =>
    ipcRenderer.invoke('clipboard:copy-text', text)
  ),

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
    getStamps: guardInternal('swarm.getStamps', () =>
      ipcRenderer.invoke('swarm:get-stamps')
    ),
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

// Get context information when right-clicking
document.addEventListener(
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
        context.linkUrl = element.href;
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

    // Prevent the default context menu
    event.preventDefault();

    // Send context info to the host renderer
    ipcRenderer.sendToHost('context-menu', context);
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
  window.postMessage({
    type: 'FREEDOM_ETHEREUM_RESPONSE',
    id,
    result,
    error,
  }, window.location.origin);
});

ipcRenderer.on('dapp:provider-event', (_event, { event, data }) => {
  window.postMessage({
    type: 'FREEDOM_ETHEREUM_EVENT',
    event,
    data,
  }, window.location.origin);
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
            const timeout = (method.startsWith('swarm_publish') || method === 'swarm_writeFeedEntry' || method === 'swarm_updateFeed') ? 300000 : 60000;
            setTimeout(() => {
              if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Request timed out'));
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

        on(event, handler) { if (eventListeners[event]) eventListeners[event].push(handler); return this; },
        removeListener(event, handler) {
          if (eventListeners[event]) {
            const i = eventListeners[event].indexOf(handler);
            if (i > -1) eventListeners[event].splice(i, 1);
          }
          return this;
        },
        addListener(event, handler) { return this.on(event, handler); },
        removeAllListeners(event) { if (event && eventListeners[event]) eventListeners[event] = []; return this; },
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
  window.postMessage({
    type: 'FREEDOM_SWARM_RESPONSE',
    id,
    result,
    error,
  }, window.location.origin);
});

ipcRenderer.on('swarm:provider-event', (_event, { event, data }) => {
  window.postMessage({
    type: 'FREEDOM_SWARM_EVENT',
    event,
    data,
  }, window.location.origin);
});

// ------------------------------------------------------------------
// Bzz sub-resource retry shim
//
// Pages served from Bee's /bzz/<hash>/ gateway path can hit transient
// 404/500 responses on sub-resources (images, stylesheets, scripts,
// fonts, media) while the node is still connecting to peers and
// fetching chunks. The top-level navigation is already protected by
// the main-process probe, but sub-resources go straight through the
// network stack and surface as broken images and missing styles.
//
// This shim listens for resource load errors on the document (capture
// phase, since error events don't bubble) and retries failed same-origin
// requests by re-assigning the element's src/href with a cache-busting
// query parameter, up to a bounded number of attempts. It also wraps
// window.fetch so retryable (fetch-based) sub-resources get the same
// treatment.
//
// Retries only fire for requests aimed at the same page origin, which
// after the request-rewriter's redirects means requests to the local
// Bee gateway under the current /bzz/<hash>/ base. External URLs
// (analytics, third-party CDNs) are passed through unchanged.
// ------------------------------------------------------------------
try {
  const isOnBzzGateway = () => {
    const loc = globalThis.location;
    if (!loc || loc.protocol !== 'http:') return false;
    if (loc.hostname !== '127.0.0.1' && loc.hostname !== 'localhost') return false;
    return loc.pathname.startsWith('/bzz/');
  };

  if (isOnBzzGateway()) {
    // The main-process probe can wait up to 5 minutes for Bee to find the
    // top-level HTML, so sub-resources on the resulting page may still be
    // unreachable for tens of seconds afterwards. Keep retrying long enough
    // that a cold node has a realistic chance of producing the missing
    // chunks before we give up.
    const DELAYS_MS = [
      500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 10000, 15000, 15000,
      15000, 30000, 30000, 30000,
    ];
    const MAX_RETRIES = DELAYS_MS.length;
    const retryCounts = new WeakMap();

    const isSameOrigin = (urlStr) => {
      try {
        const parsed = new URL(urlStr, globalThis.location.href);
        return parsed.origin === globalThis.location.origin;
      } catch {
        return false;
      }
    };

    const withCacheBust = (urlStr) => {
      try {
        const parsed = new URL(urlStr, globalThis.location.href);
        parsed.searchParams.set('__bzzretry', String(Date.now()));
        return parsed.href;
      } catch {
        return urlStr;
      }
    };

    const scheduleElementRetry = (el, attr) => {
      const src = el.getAttribute(attr);
      if (!src || !isSameOrigin(src)) return;
      const count = retryCounts.get(el) || 0;
      if (count >= MAX_RETRIES) {
        console.warn(
          '[webview-preload] giving up retrying',
          el.tagName,
          src,
          'after',
          count,
          'attempts'
        );
        return;
      }
      retryCounts.set(el, count + 1);
      const delay = DELAYS_MS[Math.min(count, DELAYS_MS.length - 1)];
      console.debug(
        '[webview-preload] retry',
        el.tagName,
        src,
        `attempt ${count + 1}/${MAX_RETRIES} in ${delay}ms`
      );
      setTimeout(() => {
        el.setAttribute(attr, withCacheBust(src));
      }, delay);
    };

    const handleResourceError = (event) => {
      const t = event.target;
      if (!t || !t.tagName) return;
      const tag = t.tagName.toUpperCase();
      if (
        tag === 'IMG' ||
        tag === 'SCRIPT' ||
        tag === 'VIDEO' ||
        tag === 'AUDIO' ||
        tag === 'SOURCE' ||
        tag === 'IFRAME' ||
        tag === 'TRACK'
      ) {
        scheduleElementRetry(t, 'src');
      } else if (tag === 'LINK') {
        scheduleElementRetry(t, 'href');
      }
    };

    document.addEventListener('error', handleResourceError, true);

    // Wrap fetch so JS-issued same-origin requests also recover from
    // transient 404/500s and network-level failures (ECONNREFUSED etc.
    // while Bee is still starting).
    const originalFetch = window.fetch?.bind(window);
    if (originalFetch) {
      const tryFetch = async (input, init) => {
        try {
          const response = await originalFetch(input, init);
          return { response };
        } catch (err) {
          return { error: err };
        }
      };

      window.fetch = async function wrappedFetch(input, init) {
        const url =
          typeof input === 'string'
            ? input
            : input && typeof input.url === 'string'
            ? input.url
            : null;
        if (!url || !isSameOrigin(url)) {
          return originalFetch(input, init);
        }
        let result = await tryFetch(input, init);
        let attempt = 0;
        const shouldRetry = (r) =>
          r.error !== undefined ||
          (r.response && (r.response.status === 404 || r.response.status === 500));
        while (shouldRetry(result) && attempt < MAX_RETRIES) {
          const delay = DELAYS_MS[Math.min(attempt, DELAYS_MS.length - 1)];
          console.debug(
            '[webview-preload] retry fetch',
            url,
            result.error
              ? `(error: ${result.error.message})`
              : `(status: ${result.response.status})`,
            `attempt ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`
          );
          await new Promise((r) => setTimeout(r, delay));
          result = await tryFetch(input, init);
          attempt += 1;
        }
        if (result.error) throw result.error;
        return result.response;
      };
    }

    console.log('[webview-preload] Bzz retry shim installed for', globalThis.location.pathname);
  }
} catch (err) {
  console.error('[webview-preload] Failed to install bzz retry shim:', err);
}

console.log('[webview-preload] Loaded (freedomAPI + context menu + ethereum + swarm provider)');
