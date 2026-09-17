/* global jest */

/**
 * Stand-ins for Electron's `net.request` / `ClientRequest` / `IncomingMessage`.
 *
 * The event sequences these reproduce were measured against Electron 44.3.0 on
 * 2026-09-15 (probe cited in `src/main/ipfs/gateway-transport.js`):
 *  - under `redirect: 'manual'` a 3xx emits `redirect` (status, method,
 *    redirect URL, headers-as-arrays) and *no* `response`; the request has to
 *    be aborted or it hangs,
 *  - a normal answer emits `response` with `statusCode` / `statusMessage` /
 *    `headers` (string values, arrays for `set-cookie`), then `data`* + `end`,
 *  - a connection failure emits `error` on the request with a `net::ERR_…`
 *    message,
 *  - a request aborted mid-body emits nothing further on the response.
 *
 * Shared by `src/main/ipfs/gateway-transport.test.js` and
 * `src/main/ipfs-manager.test.js` so the two cannot drift apart about what
 * Electron's stack actually does.
 */

const { EventEmitter } = require('events');

class FakeClientRequest extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sentHeaders = {};
    this.ended = false;
    this.aborted = false;
  }

  setHeader(name, value) {
    this.sentHeaders[name] = value;
  }

  end() {
    this.ended = true;
  }

  abort() {
    this.aborted = true;
    this.emit('abort');
  }
}

class FakeIncomingMessage extends EventEmitter {
  constructor({ statusCode = 200, statusMessage = 'OK', headers = {} } = {}) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    this.paused = false;
    this.destroyed = false;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  destroy() {
    this.destroyed = true;
  }
}

/** Answer a fake request the way Chromium answers a real one. */
function emitResponse(
  request,
  { status = 200, statusMessage = 'OK', headers = {}, chunks = [], end = true } = {}
) {
  const response = new FakeIncomingMessage({ statusCode: status, statusMessage, headers });
  request.emit('response', response);
  for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
  if (end) response.emit('end');
  return response;
}

/** Answer a fake request with a redirect that must not be followed. */
function emitRedirect(request, { status = 301, location, headers = {} } = {}) {
  request.emit('redirect', status, 'GET', location, {
    ...(location ? { location: [location] } : {}),
    ...headers,
  });
}

/**
 * Build an Electron `net` mock. `respond(request, options)` is called (async,
 * as a real request would answer) for every request; a `respond` that does
 * nothing models a gateway that never answers.
 */
function createNetMock(respond = () => {}) {
  const requests = [];
  const request = jest.fn((options) => {
    const fake = new FakeClientRequest(options);
    requests.push(fake);
    setImmediate(() => respond(fake, options));
    return fake;
  });
  return { request, requests, urls: () => requests.map((entry) => entry.options.url) };
}

module.exports = {
  FakeClientRequest,
  FakeIncomingMessage,
  createNetMock,
  emitResponse,
  emitRedirect,
};
