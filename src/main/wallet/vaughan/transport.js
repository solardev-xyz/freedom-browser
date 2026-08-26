/**
 * Vaughan JSON-RPC transport over local WebSocket.
 *
 * Per-operation connect/close (mirrors Ledger transport lifetime). Sends an
 * Origin header so Vaughan's trusted-host gate can accept Freedom Browser,
 * plus the provider.session bearer token when one is available — the provider
 * requires it once token enforcement is on and rejects arbitrary loopback
 * clients either way. The token travels as an Authorization header, never in
 * the URL, so it cannot leak through URL logging.
 */

const WebSocket = require('ws');

const { mapVaughanError } = require('./errors');
const { resolveSessionToken } = require('./session-token');

const DEFAULT_URL = process.env.FREEDOM_VAUGHAN_WS_URL || 'ws://127.0.0.1:8745';
const DEFAULT_ORIGIN = process.env.FREEDOM_VAUGHAN_WS_ORIGIN || 'https://freedom.browser';
const REQUEST_TIMEOUT_MS = 10_000;

let nextId = 1;

function rpcRequest(method, params = [], opts = {}) {
  const url = opts.url || DEFAULT_URL;
  const origin = opts.origin || DEFAULT_ORIGIN;
  const timeoutMs = Number.isInteger(opts.timeoutMs) ? opts.timeoutMs : REQUEST_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const id = nextId++;
    const headers = { Origin: origin };
    const token = resolveSessionToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => {
      ws.terminate();
      reject(mapVaughanError(Object.assign(new Error('Vaughan request timed out'), { code: 'ETIMEDOUT' })));
    }, timeoutMs);
    const finish = (fn) => (value) => {
      clearTimeout(timer);
      try {
        ws.close();
      } catch (_) {
        // no-op
      }
      fn(value);
    };
    const ok = finish(resolve);
    const fail = finish((err) => reject(mapVaughanError(err)));

    ws.once('open', () => {
      ws.send(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        })
      );
    });

    ws.once('error', fail);
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch (err) {
        fail(err);
        return;
      }
      if (msg.id !== id) {
        return;
      }
      if (msg.error) {
        const err = new Error(msg.error.message || 'Vaughan RPC error');
        err.eip1193Code = msg.error.code;
        err.data = msg.error.data;
        fail(err);
        return;
      }
      ok(msg.result);
    });
  });
}

module.exports = { rpcRequest, DEFAULT_URL, DEFAULT_ORIGIN };
