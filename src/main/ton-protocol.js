const http = require('http');
const { Readable } = require('stream');
const { isTonHost } = require('../shared/ton-suffixes');

const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function transportHeaders(headers) {
  const blocked = new Set(HOP_HEADERS);
  for (const name of (headers.get('connection') || '').split(','))
    blocked.add(name.trim().toLowerCase());
  return Object.fromEntries([...headers].filter(([name]) => !blocked.has(name.toLowerCase())));
}

async function handleTonRequest(request, { getProxyUrl, requestImpl = http.request }) {
  let target;
  try {
    target = new URL(request.url);
  } catch {
    return new Response('Invalid TON site', { status: 400 });
  }
  if (
    target.protocol !== 'tonsite:' ||
    !isTonHost(target.hostname, true) ||
    target.username ||
    target.password ||
    target.port
  ) {
    return new Response('Invalid TON site', { status: 400 });
  }
  const proxyUrl = getProxyUrl();
  if (!proxyUrl) return new Response('TON proxy is not running', { status: 503 });
  const proxy = new URL(proxyUrl);
  const host = target.hostname.toLowerCase().replace(/\.$/, '');
  const wireUrl = `http://${host}${target.pathname}${target.search}`;
  try {
    return await new Promise((resolve, reject) => {
      const outgoing = requestImpl(
        {
          hostname: proxy.hostname,
          port: proxy.port,
          path: wireUrl,
          method: request.method,
          headers: { ...transportHeaders(request.headers), Host: host },
          signal: request.signal,
        },
        (incoming) => {
          try {
            const headers = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
              headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            }
            const cleanHeaders = new Headers(transportHeaders(headers));
            const location = cleanHeaders.get('location');
            if (location && [301, 302, 303, 307, 308].includes(incoming.statusCode)) {
              const redirect = new URL(location, wireUrl);
              if (
                ['http:', 'https:'].includes(redirect.protocol) &&
                (isTonHost(redirect.hostname) || redirect.hostname === host)
              ) {
                cleanHeaders.set(
                  'location',
                  `tonsite://${redirect.host}${redirect.pathname}${redirect.search}${redirect.hash}`
                );
              }
            }
            const noBody =
              request.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode);
            if (noBody) incoming.resume();
            resolve(
              new Response(noBody ? null : Readable.toWeb(incoming), {
                status: incoming.statusCode,
                headers: cleanHeaders,
              })
            );
          } catch (err) {
            incoming.destroy();
            reject(err);
          }
        }
      );
      outgoing.setTimeout(120_000, () => outgoing.destroy(new Error('TON proxy timed out')));
      outgoing.on('error', reject);
      if (request.body && !['GET', 'HEAD'].includes(request.method)) {
        Readable.fromWeb(request.body)
          .on('error', (err) => outgoing.destroy(err))
          .pipe(outgoing);
      } else outgoing.end();
    });
  } catch {
    return new Response('TON proxy unavailable', { status: 502 });
  }
}

function registerTonProtocol(targetSession, options) {
  if (!targetSession.protocol.isProtocolHandled('tonsite')) {
    targetSession.protocol.handle('tonsite', (request) => handleTonRequest(request, options));
  }
}

module.exports = { handleTonRequest, registerTonProtocol, transportHeaders };
