/**
 * Ethereum provider injection source.
 *
 * This file is read as text by webview-preload.js and injected into the page
 * context as a <script> body. It MUST NOT use Node-only APIs or CommonJS
 * requires — the code runs inside the target page's realm.
 *
 * Kept in its own file so it can be unit-tested in isolation (load the
 * source, evaluate against a JSDOM window, assert the provider shape).
 */
(function () {
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
      eventListeners[event].forEach((h) => {
        try {
          h(data);
        } catch {
          /* swallow listener errors */
        }
      });
    }
  }

  window.ethereum = {
    isMetaMask: true,
    isFreedomBrowser: true,
    get chainId() {
      return providerState.chainId;
    },
    get selectedAddress() {
      return providerState.accounts[0] || null;
    },
    get networkVersion() {
      return providerState.chainId ? String(parseInt(providerState.chainId, 16)) : null;
    },
    isConnected: () => providerState.isConnected,
    request: async function ({ method, params }) {
      const id = ++requestId;
      console.log('[ethereum] Request:', id, method, params);
      return new Promise((resolve, reject) => {
        pendingRequests.set(id, { resolve, reject });
        console.log(
          '[ethereum] Stored pending request:',
          id,
          'total pending:',
          pendingRequests.size
        );
        window.postMessage(
          { type: 'FREEDOM_ETHEREUM_REQUEST', id, method, params: params || [] },
          '*'
        );
        setTimeout(
          () => {
            if (pendingRequests.has(id)) {
              pendingRequests.delete(id);
              reject(new Error('Request timed out'));
            }
          },
          method === 'eth_sendTransaction' ? 300000 : 60000
        );
      });
    },
    on: function (event, handler) {
      if (eventListeners[event]) eventListeners[event].push(handler);
      return this;
    },
    removeListener: function (event, handler) {
      if (eventListeners[event]) {
        const i = eventListeners[event].indexOf(handler);
        if (i > -1) eventListeners[event].splice(i, 1);
      }
      return this;
    },
    addListener: function (event, handler) {
      return this.on(event, handler);
    },
    removeAllListeners: function (event) {
      if (event && eventListeners[event]) eventListeners[event] = [];
      return this;
    },
    enable: function () {
      return this.request({ method: 'eth_requestAccounts' });
    },
    send: function (methodOrPayload, paramsOrCallback) {
      if (typeof methodOrPayload === 'string')
        return this.request({ method: methodOrPayload, params: paramsOrCallback });
      if (typeof paramsOrCallback === 'function') {
        this.sendAsync(methodOrPayload, paramsOrCallback);
        return;
      }
      return this.request({ method: methodOrPayload.method, params: methodOrPayload.params });
    },
    sendAsync: function (payload, callback) {
      this.request({ method: payload.method, params: payload.params })
        .then((result) => callback(null, { id: payload.id, jsonrpc: '2.0', result }))
        .catch((error) => callback(error, null));
    },
  };

  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    if (!event.data || typeof event.data !== 'object') return;
    if (event.data.type === 'FREEDOM_ETHEREUM_RESPONSE') {
      console.log(
        '[ethereum] Received response:',
        event.data.id,
        event.data.result,
        event.data.error
      );
      const pending = pendingRequests.get(event.data.id);
      console.log(
        '[ethereum] Pending request found:',
        !!pending,
        'pendingRequests size:',
        pendingRequests.size
      );
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
      else if (event.data.event === 'accountsChanged')
        providerState.accounts = event.data.data || [];
      else if (event.data.event === 'connect') {
        providerState.isConnected = true;
        providerState.chainId = event.data.data?.chainId;
      } else if (event.data.event === 'disconnect') {
        providerState.isConnected = false;
        providerState.accounts = [];
      }
      emitEvent(event.data.event, event.data.data);
    } else if (event.data.type === 'FREEDOM_ETHEREUM_STATE') {
      providerState = { ...providerState, ...event.data.state };
    }
  });

  // EIP-6963: announce this provider to dapps that listen for multi-wallet
  // discovery. Config (uuid, name, icon, rdns) is seeded by the main process
  // via a __FREEDOM_PROVIDER_CONFIG__ preamble prepended to this source.
  // If the preamble is missing (main-process bug / race), log and skip the
  // 6963 announce — window.ethereum is already installed above, and the
  // legacy ethereum#initialized event below still fires, so dapps degrade
  // to the pre-6963 code path instead of losing provider support entirely.
  const providerConfig = window.__FREEDOM_PROVIDER_CONFIG__;
  delete window.__FREEDOM_PROVIDER_CONFIG__;
  if (providerConfig) {
    const providerDetail = Object.freeze({
      info: Object.freeze({ ...providerConfig }),
      provider: window.ethereum,
    });
    const announceProvider = () => {
      window.dispatchEvent(
        new CustomEvent('eip6963:announceProvider', { detail: providerDetail })
      );
    };
    window.addEventListener('eip6963:requestProvider', announceProvider);
    announceProvider();
  } else {
    console.error(
      '[ethereum] EIP-6963 provider config missing — preamble not prepended'
    );
  }

  // Legacy signal — some older dapps still wait for this.
  window.dispatchEvent(new Event('ethereum#initialized'));
})();
