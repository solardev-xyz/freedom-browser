/** Bounded host.network.fetch adapter for reviewed Kohaku endpoints. This
 * capability mediates callers that use it; it is not an SDK/worker sandbox.
 */
const { getPrivacyContext, privacyError } = require('./privacy-context');
const { createWalletTorTransport } = require('./wallet-tor-transport');

function createKohakuNetwork({ handle, endpoints }) {
  const context = getPrivacyContext(handle);
  if (!require('../settings-store').isWalletTorExperimentAvailable() ||
      context.subject.kind !== 'private-account' || context.subject.chainId !== 11155111 ||
      !['asp', 'indexer', 'relayer', 'artifacts'].includes(context.subject.role)) {
    throw privacyError('PRIVATE_SDK_UNAVAILABLE', 'Experimental SDK transport is unavailable for this context');
  }
  const invalid = () => privacyError('PRIVATE_SDK_REQUEST_REFUSED', 'SDK request is outside its network capability');
  if (!Array.isArray(endpoints) || !endpoints.length || endpoints.length > 16) throw invalid();
  const routes = endpoints.map(({ url, methods, poolScope }) => {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash ||
        !Array.isArray(methods) || !methods.length || methods.some((method) => !['GET', 'POST'].includes(method)) ||
        (poolScope !== undefined && (typeof poolScope !== 'string' || !/^[0-9]{1,78}$/.test(poolScope)))) throw invalid();
    return { origin: target.origin, pathname: target.pathname, methods: [...methods], poolScope };
  });
  const tor = require('../tor-manager');
  const endpoint = tor.getWalletSocksEndpoint();
  if (!endpoint || endpoint.signal.aborted) throw privacyError('TOR_NOT_READY', 'Managed Tor is not ready');
  const transport = createWalletTorTransport();
  const close = () => transport.close();
  const lifetime = AbortSignal.any([context.signal, endpoint.signal]);
  lifetime.addEventListener('abort', close, { once: true });
  function assertActive() {
    getPrivacyContext(handle);
    if (lifetime.aborted || endpoint !== tor.getWalletSocksEndpoint()) {
      throw privacyError('PRIVACY_REQUEST_ABORTED', 'SDK network lifetime ended');
    }
  }
  return Object.freeze({
    async fetch(input, init = {}) {
      assertActive();
      let url, method, headers, body, signal;
      try {
        if (!init || typeof init !== 'object' || Object.keys(init).some((key) =>
          !['method', 'headers', 'body', 'signal', 'credentials', 'redirect'].includes(key))) throw invalid();
        const request = input instanceof Request ? input : null;
        // Arbitrary streams cannot be buffered without a separate bounded body
        // reader. Current ASP/relayer clients use strings; GET Requests work.
        if (request?.body || (request && request.credentials === 'include') ||
            (init.credentials !== undefined && init.credentials !== 'omit') ||
            (init.redirect !== undefined && init.redirect !== 'error')) throw invalid();
        url = new URL(request ? request.url : input);
        method = init.method || request?.method || 'GET';
        headers = new Headers(init.headers || request?.headers);
        body = init.body;
        signal = init.signal || request?.signal;
        if (url.protocol !== 'https:' || url.username || url.password || url.hash || /%(?:2f|5c|25)/i.test(url.pathname) ||
            (body !== undefined && typeof body !== 'string' && !(body instanceof Uint8Array)) ||
            (method === 'GET' && body !== undefined)) throw invalid();
        const route = routes.find((route) => route.origin === url.origin && route.methods.includes(method) &&
          (url.pathname === route.pathname || (route.pathname.endsWith('/') && url.pathname.startsWith(route.pathname))));
        if (!route) throw invalid();
        // No cookies, authorization, referer, cache validators or custom
        // identifiers can silently join accounts at an upstream service.
        for (const name of headers.keys()) {
          if (name === 'x-pool-scope' && route.poolScope !== undefined && headers.get(name) === route.poolScope) continue;
          if (!['accept', 'content-type'].includes(name)) throw invalid();
        }
        if (route.poolScope !== undefined) headers.set('x-pool-scope', route.poolScope);
      } catch { throw invalid(); }
      const result = await transport.request(handle, url.href, { method, headers, body,
        signal: AbortSignal.any([lifetime, ...(signal ? [signal] : [])]) });
      assertActive();
      const responseHeaders = new Headers();
      for (const name of ['content-type', 'content-length']) {
        const value = result.headers[name];
        if (typeof value === 'string') responseHeaders.set(name, value);
      }
      // The connector buffers at most 4 MiB, rejects redirects/compression,
      // and verifies TLS. Response provides the SDK's json/text/arrayBuffer API.
      return new Response([204, 205, 304].includes(result.status) ? null : result.body,
        { status: result.status, headers: responseHeaders });
    },
  });
}

module.exports = { createKohakuNetwork };
