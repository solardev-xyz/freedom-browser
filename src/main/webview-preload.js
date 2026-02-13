/**
 * Preload script for webviews
 *
 * This runs in the context of all webviews:
 * - Exposes freedomAPI for internal pages (freedom://history, etc.)
 * - Handles context menu for all pages
 */

const { contextBridge, ipcRenderer } = require('electron');

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

// Expose APIs to internal pages (guarded for safety)
contextBridge.exposeInMainWorld('freedomAPI', {
  // History
  getHistory: guardInternal('getHistory', (options) => ipcRenderer.invoke('history:get', options)),
  addHistory: guardInternal('addHistory', (entry) => ipcRenderer.invoke('history:add', entry)),
  removeHistory: guardInternal('removeHistory', (id) => ipcRenderer.invoke('history:remove', id)),
  clearHistory: guardInternal('clearHistory', () => ipcRenderer.invoke('history:clear')),

  // Settings (read-only for internal pages)
  getSettings: guardInternal('getSettings', () => ipcRenderer.invoke('settings:get')),

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

// Pending requests waiting for response
const pendingRequests = new Map();
let requestId = 0;

// Event listeners
const eventListeners = {
  connect: [],
  disconnect: [],
  chainChanged: [],
  accountsChanged: [],
  message: [],
};

// Provider state (updated by renderer)
let providerState = {
  chainId: null,
  accounts: [],
  isConnected: false,
};

/**
 * Generate unique request ID
 */
function getNextRequestId() {
  return ++requestId;
}

/**
 * EIP-1193 Provider Error
 */
class ProviderRpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
    this.name = 'ProviderRpcError';
  }
}

/**
 * The Ethereum provider object injected as window.ethereum
 */
const ethereumProvider = {
  // MetaMask compatibility
  isMetaMask: true,
  isFreedomBrowser: true,

  // State getters
  get chainId() {
    return providerState.chainId;
  },
  get selectedAddress() {
    return providerState.accounts[0] || null;
  },
  get networkVersion() {
    if (!providerState.chainId) return null;
    return String(parseInt(providerState.chainId, 16));
  },

  /**
   * Check if connected to the network
   */
  isConnected() {
    return providerState.isConnected;
  },

  /**
   * EIP-1193 request method - main entry point
   */
  async request({ method, params }) {
    if (!method) {
      throw new ProviderRpcError(4200, 'Invalid request: method is required');
    }

    const id = getNextRequestId();
    const origin = window.location.origin;

    return new Promise((resolve, reject) => {
      // Store the pending request
      pendingRequests.set(id, { resolve, reject, method });

      // Send request to renderer via host
      ipcRenderer.sendToHost('dapp:provider-request', {
        id,
        method,
        params: params || [],
        origin,
      });

      // Timeout after 5 minutes for transactions, 60 seconds for other requests
      const timeout = method === 'eth_sendTransaction' ? 300000 : 60000;
      setTimeout(() => {
        if (pendingRequests.has(id)) {
          pendingRequests.delete(id);
          reject(new ProviderRpcError(4200, 'Request timed out'));
        }
      }, timeout);
    });
  },

  /**
   * Add event listener
   */
  on(event, handler) {
    if (eventListeners[event]) {
      eventListeners[event].push(handler);
    }
    return this;
  },

  /**
   * Remove event listener
   */
  removeListener(event, handler) {
    if (eventListeners[event]) {
      const index = eventListeners[event].indexOf(handler);
      if (index > -1) {
        eventListeners[event].splice(index, 1);
      }
    }
    return this;
  },

  /**
   * Add event listener (alias)
   */
  addListener(event, handler) {
    return this.on(event, handler);
  },

  /**
   * Remove all listeners for an event
   */
  removeAllListeners(event) {
    if (event && eventListeners[event]) {
      eventListeners[event] = [];
    }
    return this;
  },

  // Legacy methods for compatibility
  enable() {
    return this.request({ method: 'eth_requestAccounts' });
  },

  send(methodOrPayload, paramsOrCallback) {
    // Handle different call signatures
    if (typeof methodOrPayload === 'string') {
      return this.request({ method: methodOrPayload, params: paramsOrCallback });
    }
    // Legacy payload format
    if (typeof paramsOrCallback === 'function') {
      this.sendAsync(methodOrPayload, paramsOrCallback);
      return;
    }
    return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
  },

  sendAsync(payload, callback) {
    this.request({ method: payload.method, params: payload.params })
      .then((result) => {
        callback(null, { id: payload.id, jsonrpc: '2.0', result });
      })
      .catch((error) => {
        callback(error, null);
      });
  },
};

/**
 * Emit event to listeners
 */
function emitProviderEvent(event, data) {
  if (eventListeners[event]) {
    eventListeners[event].forEach((handler) => {
      try {
        handler(data);
      } catch (err) {
        console.error(`[Ethereum Provider] Error in ${event} handler:`, err);
      }
    });
  }
}

// Handle responses from renderer
ipcRenderer.on('dapp:provider-response', (_event, { id, result, error }) => {
  const pending = pendingRequests.get(id);
  if (pending) {
    pendingRequests.delete(id);
    if (error) {
      pending.reject(new ProviderRpcError(error.code || 4000, error.message, error.data));
    } else {
      pending.resolve(result);
    }
  }
});

// Handle events from renderer (accountsChanged, chainChanged, etc.)
ipcRenderer.on('dapp:provider-event', (_event, { event, data }) => {
  // Update internal state
  if (event === 'chainChanged') {
    providerState.chainId = data;
  } else if (event === 'accountsChanged') {
    providerState.accounts = data || [];
  } else if (event === 'connect') {
    providerState.isConnected = true;
    providerState.chainId = data?.chainId || null;
  } else if (event === 'disconnect') {
    providerState.isConnected = false;
    providerState.accounts = [];
  }

  // Emit to dApp listeners
  emitProviderEvent(event, data);
});

// Handle state sync from renderer (initial state)
ipcRenderer.on('dapp:provider-state', (_event, state) => {
  providerState = { ...providerState, ...state };
});

// Inject window.ethereum using contextBridge for security
// Note: We need to use a proxy to make it work with dApps that check property existence
try {
  // For sites that check window.ethereum directly, we inject it into the page context
  // This runs before page scripts via webview's preload
  const script = document.createElement('script');
  script.textContent = `
    (function() {
      // Placeholder that will be connected via postMessage
      const pendingRequests = new Map();
      let requestId = 0;
      const eventListeners = {
        connect: [],
        disconnect: [],
        chainChanged: [],
        accountsChanged: [],
        message: [],
      };
      let providerState = { chainId: null, accounts: [], isConnected: false };

      function emitEvent(event, data) {
        if (eventListeners[event]) {
          eventListeners[event].forEach(h => { try { h(data); } catch(e) {} });
        }
      }

      window.ethereum = {
        isMetaMask: true,
        isFreedomBrowser: true,
        get chainId() { return providerState.chainId; },
        get selectedAddress() { return providerState.accounts[0] || null; },
        get networkVersion() { return providerState.chainId ? String(parseInt(providerState.chainId, 16)) : null; },
        isConnected: () => providerState.isConnected,
        request: async function({ method, params }) {
          const id = ++requestId;
          console.log('[ethereum] Request:', id, method, params);
          return new Promise((resolve, reject) => {
            pendingRequests.set(id, { resolve, reject });
            console.log('[ethereum] Stored pending request:', id, 'total pending:', pendingRequests.size);
            window.postMessage({ type: 'FREEDOM_ETHEREUM_REQUEST', id, method, params: params || [] }, '*');
            setTimeout(() => {
              if (pendingRequests.has(id)) {
                pendingRequests.delete(id);
                reject(new Error('Request timed out'));
              }
            }, method === 'eth_sendTransaction' ? 300000 : 60000);
          });
        },
        on: function(event, handler) { if (eventListeners[event]) eventListeners[event].push(handler); return this; },
        removeListener: function(event, handler) {
          if (eventListeners[event]) {
            const i = eventListeners[event].indexOf(handler);
            if (i > -1) eventListeners[event].splice(i, 1);
          }
          return this;
        },
        addListener: function(event, handler) { return this.on(event, handler); },
        removeAllListeners: function(event) { if (event && eventListeners[event]) eventListeners[event] = []; return this; },
        enable: function() { return this.request({ method: 'eth_requestAccounts' }); },
        send: function(methodOrPayload, paramsOrCallback) {
          if (typeof methodOrPayload === 'string') return this.request({ method: methodOrPayload, params: paramsOrCallback });
          if (typeof paramsOrCallback === 'function') { this.sendAsync(methodOrPayload, paramsOrCallback); return; }
          return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
        },
        sendAsync: function(payload, callback) {
          this.request({ method: payload.method, params: payload.params })
            .then(result => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
            .catch(error => callback(error, null));
        },
      };

      // Listen for responses
      window.addEventListener('message', function(event) {
        if (event.source !== window) return;
        if (event.data.type === 'FREEDOM_ETHEREUM_RESPONSE') {
          console.log('[ethereum] Received response:', event.data.id, event.data.result, event.data.error);
          const pending = pendingRequests.get(event.data.id);
          console.log('[ethereum] Pending request found:', !!pending, 'pendingRequests size:', pendingRequests.size);
          if (pending) {
            pendingRequests.delete(event.data.id);
            if (event.data.error) {
              const err = new Error(event.data.error.message);
              err.code = event.data.error.code;
              pending.reject(err);
            } else {
              console.log('[ethereum] Resolving with:', event.data.result);
              pending.resolve(event.data.result);
            }
          }
        } else if (event.data.type === 'FREEDOM_ETHEREUM_EVENT') {
          if (event.data.event === 'chainChanged') providerState.chainId = event.data.data;
          else if (event.data.event === 'accountsChanged') providerState.accounts = event.data.data || [];
          else if (event.data.event === 'connect') { providerState.isConnected = true; providerState.chainId = event.data.data?.chainId; }
          else if (event.data.event === 'disconnect') { providerState.isConnected = false; providerState.accounts = []; }
          emitEvent(event.data.event, event.data.data);
        } else if (event.data.type === 'FREEDOM_ETHEREUM_STATE') {
          providerState = { ...providerState, ...event.data.state };
        }
      });

      // Announce provider (EIP-6963)
      window.dispatchEvent(new Event('ethereum#initialized'));
    })();
  `;

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

ipcRenderer.on('dapp:provider-state', (_event, state) => {
  window.postMessage({
    type: 'FREEDOM_ETHEREUM_STATE',
    state,
  }, window.location.origin);
});

console.log('[webview-preload] Loaded (freedomAPI + context menu + ethereum provider)');
