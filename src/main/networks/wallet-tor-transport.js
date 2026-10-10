/** Main-only bounded HTTP/1.1 transport. Explicit context and managed Arti
 * lifetime are required. No cookies, redirects, retries, or direct fallback.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { connectIsolatedSocks } = require('./isolated-socks');
const { getPrivacyContext, privacyError } = require('./privacy-context');
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Closed local stage of a TOR_REQUEST_FAILED, derived only from this request's
// own lifecycle (never from a URL, header, body or library message):
// connect: SOCKS/Tor stream setup failed, so no TLS or HTTP bytes left;
// tls: the TLS handshake or certificate check failed before any HTTP bytes;
// socket-new / socket-reused: a fresh or kept-alive connection was assigned
// and the request may have reached the server, but no response byte came;
// response: a response byte arrived (headers possibly incomplete);
// unclassified: anything else, including the generic fallback for
// unexpected exceptions, deterministic local SOCKS refusals and an assigned
// socket whose byte counter is absent or unusable.
// The stage is a diagnostic only. socket-new and socket-reused never prove
// that the request was not delivered or acted on, and no stage authorizes
// anything or makes a retry safe: callers must not derive either from it.
const REQUEST_FAILURE_STAGES = Object.freeze([
  'connect',
  'tls',
  'socket-new',
  'socket-reused',
  'response',
  'unclassified',
]);
const CONNECT_STAGES = Object.freeze({
  SOCKS_CONNECTION_FAILED: 'connect',
  SOCKS_CONNECTION_CLOSED: 'connect',
  SOCKS_TIMEOUT: 'connect',
  SOCKS_PROTOCOL_ERROR: 'connect',
  TOR_TLS_FAILED: 'tls',
});
const requestFailed = (stage) =>
  Object.assign(privacyError('TOR_REQUEST_FAILED', 'Private HTTP request failed'), {
    stage: REQUEST_FAILURE_STAGES.includes(stage) ? stage : 'unclassified',
  });

function createWalletTorTransport({
  getEndpoint = () => require('../tor-manager').getWalletSocksEndpoint(),
  ca,
  allowHttp = false,
  idleMs = 30000,
} = {}) {
  if (!Number.isFinite(idleMs) || idleMs < 1 || idleMs > 120000) {
    throw privacyError('INVALID_PRIVATE_REQUEST', 'Invalid private transport idle timeout');
  }
  const groups = new Map();
  // These outlive retired groups: release/replacement must not hide cleanup
  // from the terminal close barrier. Destruction is not an observed close.
  const sockets = new Set();
  const requests = new Set();
  let closed = false;
  let inFlight = 0;
  let connections = 0;
  let resolveClosed;
  const drained = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function checkClosed() {
    if (closed && !groups.size && !inFlight && !connections && !requests.size && !sockets.size)
      resolveClosed();
  }

  function trackSocket(group, socket) {
    if (sockets.has(socket)) return;
    sockets.add(socket);
    group.sockets.add(socket);
    // Keep an error consumer even after handshake/request ownership ends.
    socket.on('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      group.sockets.delete(socket);
      checkClosed();
    });
    if (closed || group.closed) socket.destroy();
  }

  function closeGroup(handle, group) {
    if (group.closed) return;
    group.closed = true;
    clearTimeout(group.idleTimer);
    group.context.signal.removeEventListener('abort', group.revoke);
    group.endpoint.signal.removeEventListener('abort', group.revoke);
    group.controller.abort();
    for (const socket of group.sockets) socket.destroy();
    group.http.destroy();
    group.https.destroy();
    if (groups.get(handle) === group) groups.delete(handle);
    checkClosed();
  }

  function makeAgent(group, secure) {
    const agent = new (secure ? https.Agent : http.Agent)({
      keepAlive: true,
      maxSockets: 2,
      maxTotalSockets: 4,
      maxFreeSockets: 1,
    });
    // Node's same-origin replacement path can pass the retired socket's
    // options to createSocket(req, options). Bind private lifetime data to
    // the actual queued request instead of inheriting the previous request's.
    const requestOptions = new WeakMap();
    const addRequest = agent.addRequest;
    agent.addRequest = function (req, options) {
      requestOptions.set(req, {
        signal: options.signal,
        privacySignal: options.privacySignal,
        privacyAttempt: options.privacyAttempt,
        privacyConnectTimeoutMs: options.privacyConnectTimeoutMs,
        privacyDeadline: options.privacyDeadline,
        privacyTimeout: options.privacyTimeout,
        privacyFailConnection: options.privacyFailConnection,
      });
      return addRequest.call(this, req, options);
    };
    const createSocket = agent.createSocket;
    agent.createSocket = function (req, options, callback) {
      const visited = new Set();
      const usable = (request) => {
        const owned = requestOptions.get(request);
        if (
          !owned ||
          !(owned.privacySignal instanceof AbortSignal) ||
          !(owned.privacyTimeout instanceof AbortController) ||
          !Number.isFinite(owned.privacyDeadline)
        )
          return false;
        if (owned.privacyDeadline <= performance.now()) owned.privacyTimeout.abort();
        return !request.destroyed && !owned.privacySignal.aborted;
      };
      // Node retains destroyed queue heads until a replacement socket emits
      // free. Do not modify its queue: let Node skip those heads, but bind the
      // setup to the first surviving request it will actually serve.
      const next = () => {
        if (
          closed ||
          group.closed ||
          group.endpoint.signal.aborted ||
          group.context.signal.aborted
        ) {
          callback(privacyError('PRIVACY_REQUEST_ABORTED', 'Private request unavailable'));
          return;
        }
        const owner = usable(req) ? req : this.requests[this.getName(options)]?.find(usable);
        if (!owner || visited.has(owner) || visited.size >= 32) {
          callback(privacyError('PRIVACY_REQUEST_ABORTED', 'Private request unavailable'));
          return;
        }
        visited.add(owner);
        const owned = requestOptions.get(owner);
        return createSocket.call(this, req, { ...options, ...owned }, (error, socket) => {
          // Serve a different owner only when the setup owner died. Finish
          // abort propagation first; never retry a still-live owner's failure.
          if (error && !usable(owner)) return queueMicrotask(next);
          if (error && owner !== req) owned.privacyFailConnection();
          callback(error, socket);
        });
      };
      return next();
    };
    agent.createConnection = (options, callback) => {
      connections += 1;
      let notified = false;
      let socket;
      let secured;
      function notify(error, connected) {
        if (notified) return;
        notified = true;
        try {
          callback(error, connected);
        } catch {
          // A throwing agent callback must neither be called twice nor leave
          // a connection unowned. Its request still has its bounded timeout.
          secured?.destroy();
          socket?.destroy();
        }
      }
      async function connect() {
        let setupUsesRequestDeadline = false;
        try {
          if (closed || group.closed || options.privacySignal.aborted)
            throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
          const remainingMs = options.privacyDeadline - performance.now();
          if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
            options.privacyTimeout.abort();
            throw privacyError('TOR_REQUEST_TIMEOUT', 'Private HTTP request failed');
          }
          setupUsesRequestDeadline = options.privacyConnectTimeoutMs >= remainingMs;
          socket = await connectIsolatedSocks(
            {
              endpoint: group.endpoint,
              hostname: options.host,
              port: Number(options.port),
              token: group.context.isolationToken,
              signal: options.privacySignal,
              // Queue time is already spent. The original request timer and
              // combined signal continue to bound setup, TLS and the response.
              timeoutMs: Math.min(options.privacyConnectTimeoutMs, remainingMs),
            },
            (created) => trackSocket(group, created)
          );
          if (closed || group.closed || options.privacySignal.aborted)
            throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
          if (!secure) {
            notify(null, socket);
            socket.resume();
            return;
          }
          // Never accept caller-supplied TLS overrides or disable validation.
          secured = tls.connect({
            socket,
            host: options.host,
            servername: net.isIP(options.host) ? undefined : options.host,
            rejectUnauthorized: true,
            ca,
            ALPNProtocols: ['http/1.1'],
          });
          await new Promise((resolve, reject) => {
            let settled = false;
            const abort = () => finish(true);
            function finish(error) {
              if (settled) return;
              settled = true;
              options.privacySignal.removeEventListener('abort', abort);
              if (error) {
                secured.destroy();
                reject(privacyError('TOR_TLS_FAILED', 'Private TLS connection failed'));
              } else resolve();
            }
            secured.once('secureConnect', () => finish());
            secured.on('error', finish);
            secured.once('close', () => finish(true));
            options.privacySignal.addEventListener('abort', abort, { once: true });
            trackSocket(group, secured);
            if (closed || group.closed || options.privacySignal.aborted) abort();
            socket.resume();
          });
          if (closed || group.closed || options.privacySignal.aborted)
            throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
          notify(null, secured);
        } catch (error) {
          secured?.destroy();
          socket?.destroy();
          const code = typeof error?.code === 'string' ? error.code : '';
          // If the request-bound setup timer wins a timer tie, classify the
          // same expired request consistently through its original controller.
          if (code === 'SOCKS_TIMEOUT' && setupUsesRequestDeadline) options.privacyTimeout.abort();
          if (options.privacyAttempt && !options.privacyAttempt.connect)
            options.privacyAttempt.connect = Object.hasOwn(CONNECT_STAGES, code)
              ? CONNECT_STAGES[code]
              : 'unclassified';
          notify(error);
        } finally {
          connections -= 1;
          checkClosed();
        }
      }
      // connect consumes every failure and retains ownership through the
      // handshake and agent callback, even after the request rejected early.
      void connect();
      // Agent waits for the callback: never return an unnegotiated socket.
      return undefined;
    };
    return agent;
  }

  function groupFor(handle, context) {
    const endpoint = getEndpoint();
    if (!endpoint?.signal || endpoint.signal.aborted) {
      throw privacyError('TOR_NOT_READY', 'Managed Tor is not ready');
    }
    let group = groups.get(handle);
    if (group && (group.endpoint !== endpoint || group.endpoint.signal.aborted)) {
      closeGroup(handle, group);
      group = null;
    }
    if (!group) {
      if (groups.size >= 32)
        throw privacyError('TOR_CONTEXT_LIMIT', 'Private transport context limit reached');
      group = {
        context,
        endpoint,
        sockets: new Set(),
        controller: new AbortController(),
        pending: 0,
        closed: false,
      };
      group.http = makeAgent(group, false);
      group.https = makeAgent(group, true);
      group.revoke = () => closeGroup(handle, group);
      context.signal.addEventListener('abort', group.revoke, { once: true });
      endpoint.signal.addEventListener('abort', group.revoke, { once: true });
      groups.set(handle, group);
    }
    clearTimeout(group.idleTimer);
    return group;
  }

  async function request(
    handle,
    input,
    {
      method = 'GET',
      headers = {},
      body,
      signal,
      timeoutMs = 30000,
      connectTimeoutMs = Math.min(10000, timeoutMs),
      maxResponseBytes = MAX_RESPONSE_BYTES,
      requireFramedResponse = false,
    } = {}
  ) {
    if (closed) throw privacyError('TOR_TRANSPORT_CLOSED', 'Private transport is closed');
    const context = getPrivacyContext(handle);
    if (
      context.requirements.content !== 'public' ||
      context.requirements.correctness !== 'any' ||
      context.requirements.maxAgeMs !== null
    ) {
      throw privacyError(
        'UNSUPPORTED_PRIVACY_REQUIREMENTS',
        'Transport alone cannot meet these requirements'
      );
    }
    let url;
    try {
      url = new URL(input);
    } catch {
      throw privacyError('INVALID_PRIVATE_REQUEST', 'Invalid private request URL');
    }
    if (
      (!allowHttp && url.protocol !== 'https:') ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      net.isIP(url.hostname.replace(/^\[|\]$/g, '')) === 6 ||
      !['GET', 'POST'].includes(method) ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 120000 ||
      !Number.isFinite(connectTimeoutMs) ||
      connectTimeoutMs <= 0 ||
      connectTimeoutMs > timeoutMs ||
      !Number.isSafeInteger(maxResponseBytes) ||
      maxResponseBytes < 1 ||
      maxResponseBytes > MAX_RESPONSE_BYTES ||
      typeof requireFramedResponse !== 'boolean' ||
      (signal !== undefined && !(signal instanceof AbortSignal))
    ) {
      throw privacyError('INVALID_PRIVATE_REQUEST', 'Unsupported private HTTP request');
    }
    if (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) {
      throw privacyError('INVALID_PRIVATE_REQUEST', 'Unsupported private request body');
    }
    const bytes = body === undefined ? undefined : Buffer.from(body);
    if (bytes?.length > 1024 * 1024)
      throw privacyError('PRIVATE_REQUEST_TOO_LARGE', 'Private request is too large');
    let requestHeaders;
    try {
      requestHeaders = new Headers(headers);
    } catch {
      throw privacyError('INVALID_PRIVATE_REQUEST', 'Invalid private request headers');
    }
    for (const name of [
      'host',
      'connection',
      'upgrade',
      'transfer-encoding',
      'content-length',
      'proxy-authorization',
      'cookie',
    ]) {
      if (requestHeaders.has(name))
        throw privacyError('INVALID_PRIVATE_REQUEST', 'Unsupported private request header');
    }
    requestHeaders.set('accept-encoding', 'identity');
    if (bytes) requestHeaders.set('content-length', String(bytes.length));
    if (signal?.aborted) throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
    if (inFlight >= 32) throw privacyError('TOR_REQUEST_LIMIT', 'Private request limit reached');
    const group = groupFor(handle, context);
    const timeout = new AbortController();
    const combined = AbortSignal.any([
      group.controller.signal,
      context.signal,
      group.endpoint.signal,
      timeout.signal,
      ...(signal ? [signal] : []),
    ]);
    const deadline = performance.now() + timeoutMs;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    group.pending += 1;
    inFlight += 1;
    try {
      const result = await new Promise((resolve, reject) => {
        let settled = false,
          socketAssigned = false,
          receivedResponse;
        // Written only by this request's own connection attempt (see makeAgent).
        const attempt = { connect: null };
        // Application bytes on the assigned (TLS) socket when it was assigned:
        // any later growth means response bytes arrived, even partial headers.
        // A counter that is absent or not a usable integer at either end, or
        // that went backwards, proves nothing either way: unclassified.
        let assigned;
        const assign = (socket) => {
          socketAssigned = true;
          assigned ??= { socket, bytes: socket?.bytesRead };
        };
        const stage = () => {
          if (receivedResponse) return 'response';
          if (socketAssigned) {
            const before = assigned?.bytes,
              after = assigned?.socket?.bytesRead;
            if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after) || after < before)
              return 'unclassified';
            if (after !== before) return 'response';
            return req.reusedSocket === true ? 'socket-reused' : 'socket-new';
          }
          return attempt.connect || 'unclassified';
        };
        const failure = () =>
          combined.aborted
            ? privacyError(
                timeout.signal.aborted ? 'TOR_REQUEST_TIMEOUT' : 'PRIVACY_REQUEST_ABORTED',
                'Private HTTP request failed'
              )
            : requestFailed(stage());
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          combined.removeEventListener('abort', abort);
          // A destroyed, never-assigned Agent queue entry may never emit
          // close. It owns no physical socket. Connection continuations and
          // every raw/TLS socket remain independently tracked until drained;
          // assigned requests still require their actual close event.
          if (error && !socketAssigned && !req.socket) requests.delete(req);
          if (error) reject(error);
          else resolve(value);
        };
        const abort = () => {
          // A queued ClientRequest may never receive a socket after its agent
          // closes. Revoke it directly rather than relying on a future Node
          // socket assignment to deliver the request's error event.
          const error = failure();
          finish(error);
          req.destroy(error);
        };
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
          url,
          {
            method,
            headers: Object.fromEntries(requestHeaders),
            agent: url.protocol === 'https:' ? group.https : group.http,
            signal: combined,
            privacySignal: combined,
            privacyAttempt: attempt,
            privacyConnectTimeoutMs: connectTimeoutMs,
            privacyDeadline: deadline,
            privacyTimeout: timeout,
            privacyFailConnection: () => {
              const error = failure();
              finish(error);
              req.destroy(error);
            },
          },
          (response) => {
            receivedResponse = response;
            const failResponse = (error) => {
              if (settled) return;
              finish(error);
              response.destroy();
            };
            // Consumers precede every early destroy, including refusals in
            // the headers callback and errors delivered after cancellation.
            response.on('error', () =>
              failResponse(privacyError('TOR_RESPONSE_FAILED', 'Private response failed'))
            );
            response.once('aborted', () =>
              failResponse(privacyError('TOR_RESPONSE_FAILED', 'Private response failed'))
            );
            response.once('close', () => {
              if (!response.complete)
                finish(privacyError('TOR_RESPONSE_FAILED', 'Private response failed'));
            });
            if (settled) {
              response.destroy();
              return;
            }
            if (response.statusCode >= 300 && response.statusCode < 400) {
              failResponse(
                privacyError(
                  'PRIVATE_REDIRECT_REFUSED',
                  'Private redirects require a new approved request'
                )
              );
              return;
            }
            if (
              response.headers['content-encoding'] &&
              response.headers['content-encoding'] !== 'identity'
            ) {
              failResponse(
                privacyError('PRIVATE_ENCODING_REFUSED', 'Unsupported private response encoding')
              );
              return;
            }
            if (requireFramedResponse) {
              const length = response.headers['content-length'];
              const encoding = response.headers['transfer-encoding'];
              // Node's strict HTTP parser rejects conflicting/duplicate
              // framing. Close-delimited completion alone is insufficient
              // for callers that must classify a whole bounded response.
              const framed =
                (typeof length === 'string' && /^\d+$/.test(length) && encoding === undefined) ||
                (length === undefined &&
                  typeof encoding === 'string' &&
                  /^chunked$/i.test(encoding));
              if (!framed) {
                failResponse(
                  privacyError('PRIVATE_FRAMING_REFUSED', 'Unsupported private response framing')
                );
                return;
              }
            }
            let size = 0;
            const chunks = [];
            response.on('data', (chunk) => {
              if (settled) return;
              size += chunk.length;
              // Bound retained body chunks, not incoming chunks, wire bytes,
              // headers, or the HTTP/TLS/socket implementation's buffers.
              if (size > maxResponseBytes) {
                failResponse(
                  privacyError('PRIVATE_RESPONSE_TOO_LARGE', 'Private response is too large')
                );
              } else chunks.push(chunk);
            });
            response.on('end', () => {
              if (settled) return;
              if (!response.complete) {
                failResponse(privacyError('TOR_RESPONSE_FAILED', 'Private response failed'));
                return;
              }
              finish(null, {
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              });
            });
          }
        );
        // Retain the error consumer for errors delivered after cancellation.
        req.on('error', () => finish(failure()));
        if (req.socket) assign(req.socket);
        req.once('socket', assign);
        requests.add(req);
        req.once('close', () => {
          requests.delete(req);
          // A Connection: close response can be complete before its readable
          // end event is delivered. Let that event finish the body first.
          if (!receivedResponse?.complete) finish(failure());
          checkClosed();
        });
        combined.addEventListener('abort', abort, { once: true });
        if (combined.aborted) {
          abort();
          return;
        }
        try {
          if (bytes) req.write(bytes);
          req.end();
        } catch {
          finish(failure());
          req.destroy();
        }
      });
      getPrivacyContext(handle);
      if (combined.aborted || group.closed)
        throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
      return result;
    } catch (error) {
      // Node/library exceptions may include URLs or header values. Only our
      // fixed transport diagnostics are permitted across this boundary.
      if (typeof error?.code === 'string' && /^(PRIVATE_|PRIVACY_|TOR_)/.test(error.code))
        throw error;
      throw requestFailed('unclassified');
    } finally {
      clearTimeout(timer);
      group.pending -= 1;
      inFlight -= 1;
      if (!group.closed && group.pending === 0) {
        group.idleTimer = setTimeout(group.revoke, idleMs);
        group.idleTimer.unref();
      }
      checkClosed();
    }
  }

  function close() {
    closed = true;
    for (const [handle, group] of groups) closeGroup(handle, group);
    checkClosed();
  }

  return Object.freeze({
    request,
    close,
    // Never rejects; terminal close waits for observed cleanup, with no hard
    // drain deadline. A fresh instance does not allocate a new Tor identity.
    closed: drained,
    release(handle) {
      const group = groups.get(handle);
      if (group) closeGroup(handle, group);
    },
  });
}

module.exports = { createWalletTorTransport, REQUEST_FAILURE_STAGES };
