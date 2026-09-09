'use strict';

// Raw source deliberately avoids serializing coverage-instrumented functions.
const PREVIEW_SOCKET_CLIENT = String.raw`
(() => {
  const config = __FREEDOM_SOCKET_CONFIG__;
  const nativeFetch = window.fetch.bind(window);
  const limit = 1048576;
  const encoder = new TextEncoder();
  const sockets = new Set();
  async function request(action, data = {}, keepalive = false) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const response = await nativeFetch('/.freedom-preview/socket', {
        method: 'POST', credentials: 'omit', cache: 'no-store', keepalive,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, action, key: config.key }),
      });
      if (response.ok) return response.json();
      await response.body?.cancel();
      if (response.status !== 503 || attempt === 3) throw new Error('Preview connection unavailable');
      await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
    }
  }
  class PreviewWebSocket extends EventTarget {
    #state = 0; #id = null; #buffered = 0; #sending = Promise.resolve(); #protocol = '';
    constructor(value, protocols = []) {
      super();
      const url = new URL(String(value), location.href);
      if (!['ws:', 'wss:', 'freedom-preview:'].includes(url.protocol) || url.username || url.password || url.hash ||
          !((url.hostname === location.hostname && (!url.port || Number(url.port) === config.port)) ||
            (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && Number(url.port) === config.port))) {
        throw new DOMException('WebSocket destination is outside this preview', 'SecurityError');
      }
      if (url.protocol === 'freedom-preview:') url.protocol = 'ws:';
      const normalized = url.protocol === 'freedom-preview:' ? 'ws://' + url.host + url.pathname + url.search : url.href;
      if (typeof protocols === 'string') protocols = [protocols];
      if (!Array.isArray(protocols) || protocols.length > 8 || new Set(protocols).size !== protocols.length ||
          protocols.some(p => typeof p !== 'string' || p.length > 128 || !/^[!#$%&'*+.^_\x60|~0-9A-Za-z-]+$/.test(p))) {
        throw new DOMException('Invalid WebSocket protocols', 'SyntaxError');
      }
      Object.defineProperty(this, 'url', { value: normalized, enumerable: true });
      this.binaryType = 'blob'; this.onopen = this.onmessage = this.onerror = this.onclose = null;
      sockets.add(this);
      void this.#open(normalized, protocols);
    }
    get readyState() { return this.#state; }
    get bufferedAmount() { return this.#buffered; }
    get protocol() { return this.#protocol; }
    get extensions() { return ''; }
    #emit(event) {
      this.dispatchEvent(event);
      if (typeof this['on' + event.type] === 'function') {
        try { this['on' + event.type](event); } catch (error) { reportError(error); }
      }
    }
    #finish(code = 1006, reason = '', wasClean = false) {
      if (this.#state === 3) return;
      this.#state = 3; sockets.delete(this);
      this.#emit(new CloseEvent('close', { code, reason, wasClean }));
    }
    async #open(url, protocols) {
      try {
        this.#id = (await request('open', { url, protocols })).id;
        if (this.#state !== 0) { await request('close', { id: this.#id, reason: '' }); this.#finish(); return; }
        while (this.#state !== 3) {
          const { events } = await request('poll', { id: this.#id });
          for (const event of events) {
            if (event.type === 'open' && this.#state === 0) {
              this.#protocol = event.protocol; this.#state = 1; this.#emit(new Event('open'));
            } else if (event.type === 'message' && this.#state === 1) {
              let data = event.data;
              if (event.binary) {
                const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
                data = this.binaryType === 'arraybuffer' ? bytes.buffer : new Blob([bytes]);
              }
              this.#emit(new MessageEvent('message', { data, origin: location.origin }));
            } else if (event.type === 'error') this.#emit(new Event('error'));
            else if (event.type === 'close') this.#finish(event.code, event.reason, event.wasClean);
          }
        }
      } catch { if (this.#state !== 3) { this.#emit(new Event('error')); this.#finish(); } }
    }
    send(value) {
      if (this.#state === 0) throw new DOMException('WebSocket is connecting', 'InvalidStateError');
      if (this.#state !== 1) return;
      const binary = value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value);
      const size = binary ? (value.size ?? value.byteLength) : encoder.encode(String(value)).length;
      if (this.#buffered + size > limit) { this.close(4009, 'Preview socket buffer exceeded'); return; }
      // Match browser send(): callers may mutate their typed array immediately.
      const snapshot = !binary ? String(value) : value instanceof Blob ? value :
        value instanceof ArrayBuffer ? new Uint8Array(value).slice() :
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
      this.#buffered += size;
      this.#sending = this.#sending.then(async () => {
        let data = snapshot;
        if (binary) {
          const bytes = snapshot instanceof Blob ? new Uint8Array(await snapshot.arrayBuffer()) : snapshot;
          let text = ''; for (const byte of bytes) text += String.fromCharCode(byte);
          data = btoa(text);
        }
        await request('send', { id: this.#id, binary, data });
      }).catch(() => { this.#emit(new Event('error')); this.#finish(); }).finally(() => { this.#buffered -= size; });
    }
    close(code = 1000, reason = '') {
      if (code !== 1000 && !(Number.isInteger(code) && code >= 3000 && code <= 4999)) throw new DOMException('Invalid close code', 'InvalidAccessError');
      reason = String(reason);
      if (encoder.encode(reason).length > 123) throw new DOMException('Close reason too long', 'SyntaxError');
      if (this.#state >= 2) return;
      this.#state = 2;
      if (this.#id) void this.#sending.then(() => request('close', { id: this.#id, code, reason })).catch(() => this.#finish());
    }
  }
  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    Object.defineProperty(PreviewWebSocket, name, { value });
    Object.defineProperty(PreviewWebSocket.prototype, name, { value });
  }
  window.WebSocket = PreviewWebSocket;
  let statusPending = false;
  const statusTimer = setInterval(async () => {
    if (statusPending) return;
    statusPending = true;
    try {
      const response = await nativeFetch('/.freedom-preview/status', {
        credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(5000),
      });
      if (response.ok && (await response.json()).processId !== config.processId) location.reload();
    } catch { /* A stopped server can later be restarted by an approved action. */ }
    finally { statusPending = false; }
  }, 5000);
  addEventListener('pagehide', () => {
    clearInterval(statusTimer);
    for (const socket of sockets) socket.close();
  });
})();
`;

function previewSocketScript(key, port, processId) {
  return PREVIEW_SOCKET_CLIENT.replace('__FREEDOM_SOCKET_CONFIG__', JSON.stringify({ key, port, processId }));
}

module.exports = { previewSocketScript };
