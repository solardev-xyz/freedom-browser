'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

const SOCKET_ROUTE = '/.freedom-preview/socket';
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_SOCKETS = 32;
const MAX_PREVIEW_SOCKETS = 4;
const POLL_MS = 15_000;
const IDLE_MS = 30_000;

function socketTarget(value, host, port) {
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid socket URL');
  const url = new URL(value);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash ||
      !((url.hostname === host && (!url.port || Number(url.port) === port)) ||
        (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && Number(url.port) === port))) {
    throw new Error('Socket destination is outside this preview');
  }
  return `ws://127.0.0.1:${port}${url.pathname}${url.search}`;
}

// The custom preview scheme cannot perform a browser WebSocket upgrade. The
// page uses bounded same-origin requests; only main opens the upstream socket.
class WorkspacePreviewSockets {
  constructor({ isLive, connect = (url, protocols, options) => new WebSocket(url, protocols, options) }) {
    this.isLive = isLive;
    this.connect = connect;
    this.entries = new Map();
    this.timer = null;
  }

  #timer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      for (const [id, entry] of this.entries) {
        if (Date.now() - entry.touched > IDLE_MS || !this.isLive(entry.preview)) this.#remove(id);
      }
      if (!this.entries.size) { clearInterval(this.timer); this.timer = null; }
    }, 1000);
    this.timer.unref?.();
  }

  #remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    entry.socket.terminate();
    entry.wake?.();
  }

  async request(preview, host, input, signal) {
    if (signal?.aborted || !input || input.key !== preview.socketKey || !this.isLive(preview)) throw new Error('Preview socket unavailable');
    if (input.action === 'open') {
      const target = socketTarget(input.url, host, preview.port);
      const protocols = input.protocols || [];
      if (!Array.isArray(protocols) || protocols.length > 8 ||
          new Set(protocols).size !== protocols.length || protocols.some(p => typeof p !== 'string' ||
          p.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(p))) throw new Error('Invalid socket protocols');
      if (this.entries.size >= MAX_SOCKETS || [...this.entries.values()].filter(e => e.preview === preview).length >= MAX_PREVIEW_SOCKETS) {
        throw new Error('Preview socket limit reached');
      }
      const id = crypto.randomBytes(20).toString('hex');
      const socket = this.connect(target, protocols, {
        handshakeTimeout: 5000, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false,
        followRedirects: false, origin: `http://127.0.0.1:${preview.port}`,
      });
      const entry = { socket, preview, touched: Date.now(), events: [], bytes: 0, polling: false, closed: false };
      this.entries.set(id, entry);
      const enqueue = (event, size = 0) => {
        if (!this.entries.has(id)) return;
        if (entry.bytes + size > MAX_FRAME_BYTES || entry.events.length >= 128) {
          entry.events = [{ type: 'close', code: 1009, reason: 'Preview socket buffer exceeded', wasClean: false }];
          entry.bytes = 0; entry.closed = true; socket.terminate();
        } else { entry.events.push(event); entry.bytes += size; }
        entry.wake?.();
      };
      socket.on('open', () => enqueue({ type: 'open', protocol: socket.protocol || '' }));
      socket.on('message', (data, binary) => {
        const bytes = Buffer.from(data);
        enqueue({ type: 'message', binary, data: binary ? bytes.toString('base64') : bytes.toString('utf8') }, bytes.length);
      });
      socket.on('error', () => enqueue({ type: 'error' }));
      socket.on('close', (code) => {
        entry.closed = true;
        enqueue({ type: 'close', code, reason: '', wasClean: code === 1000 });
      });
      this.#timer();
      return { id };
    }
    const entry = this.entries.get(input.id);
    if (!entry || entry.preview !== preview) throw new Error('Preview socket unavailable');
    entry.touched = Date.now();
    if (input.action === 'close') {
      if (input.code !== undefined && input.code !== 1000 && !(Number.isInteger(input.code) && input.code >= 3000 && input.code <= 4999)) throw new Error('Invalid close code');
      if (typeof input.reason !== 'string' || Buffer.byteLength(input.reason) > 123) throw new Error('Invalid close reason');
      entry.socket.close(input.code || 1000, input.reason);
      return { ok: true };
    }
    if (input.action === 'send') {
      if (entry.socket.readyState !== WebSocket.OPEN || typeof input.data !== 'string' || typeof input.binary !== 'boolean') throw new Error('Socket not open');
      const data = input.binary ? Buffer.from(input.data, 'base64') : Buffer.from(input.data);
      if (data.length > MAX_FRAME_BYTES || entry.socket.bufferedAmount + data.length > MAX_FRAME_BYTES) {
        this.#remove(input.id); throw new Error('Socket buffer exceeded');
      }
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        };
        const abort = () => { this.#remove(input.id); finish(new Error('Socket send stopped')); };
        const timer = setTimeout(abort, 5000);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { entry.socket.send(data, { binary: input.binary }, finish); } catch (error) { finish(error); }
      });
      return { ok: true };
    }
    if (input.action !== 'poll' || entry.polling) throw new Error('Invalid socket poll');
    entry.polling = true;
    let timer;
    try {
      if (!entry.events.length && !entry.closed && !signal?.aborted) await new Promise(resolve => {
        entry.wake = resolve;
        timer = setTimeout(resolve, POLL_MS);
        signal?.addEventListener('abort', resolve, { once: true });
      });
      if (!this.isLive(preview) || !this.entries.has(input.id)) throw new Error('Preview server stopped');
      const events = entry.events;
      entry.events = []; entry.bytes = 0;
      if (entry.closed) this.#remove(input.id);
      return { events };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', entry.wake);
      entry.wake = null; entry.polling = false;
    }
  }

  revoke(preview) {
    for (const [id, entry] of this.entries) if (entry.preview === preview) this.#remove(id);
  }

  dispose() {
    for (const id of this.entries.keys()) this.#remove(id);
    clearInterval(this.timer); this.timer = null;
  }
}

module.exports = { WorkspacePreviewSockets, SOCKET_ROUTE, MAX_FRAME_BYTES, socketTarget };
