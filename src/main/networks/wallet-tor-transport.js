/** Main-only bounded HTTP/1.1 transport. Explicit context and managed Arti
 * lifetime are required. No cookies, redirects, retries, or direct fallback.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const { connectIsolatedSocks } = require('./isolated-socks');
const { getPrivacyContext, privacyError } = require('./privacy-context');

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
  let closed = false;
  let inFlight = 0;

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
  }

  function makeAgent(group, secure) {
    const agent = new (secure ? https.Agent : http.Agent)({
      keepAlive: true,
      maxSockets: 2,
      maxTotalSockets: 4,
      maxFreeSockets: 1,
    });
    agent.createConnection = (options, callback) => {
      connectIsolatedSocks({
        endpoint: group.endpoint,
        hostname: options.host,
        port: Number(options.port),
        token: group.context.isolationToken,
        signal: options.privacySignal,
      })
        .then((socket) => {
          if (group.closed || options.privacySignal.aborted) {
            socket.destroy();
            throw privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled');
          }
          group.sockets.add(socket);
          socket.once('close', () => group.sockets.delete(socket));
          if (!secure) {
            callback(null, socket);
            socket.resume();
            return;
          }
          // Never accept caller-supplied TLS overrides or disable validation.
          const secured = tls.connect({
            socket,
            host: options.host,
            servername: net.isIP(options.host) ? undefined : options.host,
            rejectUnauthorized: true,
            ca,
            ALPNProtocols: ['http/1.1'],
          });
          group.sockets.add(secured);
          secured.once('close', () => group.sockets.delete(secured));
          const abort = () =>
            secured.destroy(privacyError('PRIVACY_REQUEST_ABORTED', 'Private request cancelled'));
          options.privacySignal.addEventListener('abort', abort, { once: true });
          let settled = false;
          function finish(error) {
            if (settled) return;
            settled = true;
            options.privacySignal.removeEventListener('abort', abort);
            if (error) {
              secured.destroy();
              callback(privacyError('TOR_TLS_FAILED', 'Private TLS connection failed'));
            } else callback(null, secured);
          }
          secured.once('secureConnect', () => finish());
          secured.on('error', finish);
          secured.once('close', () => finish(new Error('closed')));
          if (options.privacySignal.aborted) abort();
          socket.resume();
        })
        .catch((error) => callback(error));
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
    { method = 'GET', headers = {}, body, signal, timeoutMs = 30000 } = {}
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
      timeoutMs > 120000
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
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    timer.unref();
    group.pending += 1;
    inFlight += 1;
    try {
      const result = await new Promise((resolve, reject) => {
        const client = url.protocol === 'https:' ? https : http;
        const req = client.request(
          url,
          {
            method,
            headers: Object.fromEntries(requestHeaders),
            agent: url.protocol === 'https:' ? group.https : group.http,
            signal: combined,
            privacySignal: combined,
          },
          (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400) {
              response.destroy();
              reject(
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
              response.destroy();
              reject(
                privacyError('PRIVATE_ENCODING_REFUSED', 'Unsupported private response encoding')
              );
              return;
            }
            let size = 0;
            const chunks = [];
            response.on('data', (chunk) => {
              size += chunk.length;
              if (size > 4 * 1024 * 1024) {
                response.destroy();
                reject(privacyError('PRIVATE_RESPONSE_TOO_LARGE', 'Private response is too large'));
              } else chunks.push(chunk);
            });
            response.on('error', () =>
              reject(privacyError('TOR_RESPONSE_FAILED', 'Private response failed'))
            );
            response.on('end', () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
              })
            );
          }
        );
        req.on('error', () =>
          reject(
            privacyError(
              combined.aborted
                ? timeout.signal.aborted
                  ? 'TOR_REQUEST_TIMEOUT'
                  : 'PRIVACY_REQUEST_ABORTED'
                : 'TOR_REQUEST_FAILED',
              'Private HTTP request failed'
            )
          )
        );
        if (bytes) req.write(bytes);
        req.end();
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
      throw privacyError('TOR_REQUEST_FAILED', 'Private HTTP request failed');
    } finally {
      clearTimeout(timer);
      group.pending -= 1;
      inFlight -= 1;
      if (!group.closed && group.pending === 0) {
        group.idleTimer = setTimeout(group.revoke, idleMs);
        group.idleTimer.unref();
      }
    }
  }

  function close() {
    closed = true;
    for (const [handle, group] of groups) closeGroup(handle, group);
  }

  return Object.freeze({
    request,
    close,
    release(handle) {
      const group = groups.get(handle);
      if (group) closeGroup(handle, group);
    },
  });
}

module.exports = { createWalletTorTransport };
