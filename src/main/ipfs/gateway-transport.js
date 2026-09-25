/**
 * The one way this app dials a configured content-node endpoint: the external
 * IPFS gateway (`ipfs-manager.js`) and the speculative gateway warm-up
 * (`ens-prefetch.js`, for the Ant API too — it is configurable to a remote
 * host in exactly the same way).
 *
 * WHY THIS EXISTS
 *
 * `serveExternalGatewayRequest` and the gateway probes used Node's global
 * `fetch` (undici). undici has its own socket stack, so it never sees
 * `session.setProxy` — the PAC `src/main/tor-proxy.js` installs on every
 * tracked session. `ens-prefetch.js` dialled the same endpoints with a bare
 * `net.request`, so the same request class took three different routes
 * depending on which file issued it (#355). A bare `net.request` is not
 * equivalent to this transport: it only follows a proxy policy the session is
 * carrying *at that moment* (an onion gateway published while Tor is stopping
 * resolves DIRECT, leaking the name to the system resolver), and it reads and
 * writes Chromium's on-disk HTTP cache.
 *
 * The PAC's scope is `.onion`-only (see `buildOnionPacScript`): a clearnet
 * gateway resolves DIRECT with Tor on or off, so the everyday remote gateway
 * is a consistency gap rather than a live leak. A gateway *on* a `.onion`
 * host is the case that actually breaks today: undici hands the onion name to
 * the system resolver (a DNS leak of the endpoint the user configured) and the
 * load then fails, because only Tor can resolve it. Routing through Chromium
 * makes the gateway follow whatever proxy policy the session carries — today's
 * onion PAC and anything installed on that session later.
 *
 * WHY `net.request` AND NOT `net.fetch`
 *
 * Measured against Electron 44.3.0 on 2026-09-15 (probe in this PR's
 * description): `net.fetch(url, { redirect: 'manual' })` does not return the
 * 3xx — it rejects with "Redirect was cancelled". The external gateway path
 * *must* surface the 3xx (with its `Location` rewritten into the `ipfs://`
 * URL space, see `rewriteGatewayLocation`), so `net.fetch` cannot carry this
 * path's hardening. `net.request` can: with `redirect: 'manual'` it emits a
 * `redirect` event carrying the status and the response headers, and the
 * request is dropped as soon as we abort it — it is never followed.
 *
 * Same probe, other measurements this file depends on:
 *  - Chromium reports `content-encoding: gzip` plus the *compressed*
 *    `content-length` while handing back an already-decoded body — exactly
 *    like undici, so `DROPPED_UPSTREAM_RESPONSE_HEADERS` in `ipfs-manager.js`
 *    stays load-bearing after the transport change.
 *  - A PAC that proxies everything is bypassed for loopback hosts, so a
 *    loopback gateway is unaffected by any proxy policy either way.
 *  - Chromium's HTTP cache is on by default for `net.request` and undici had
 *    none, so the transport change silently added one: re-measured on Electron
 *    44.3.0 (`ipfs-gateway-proxy.test.js`), a second load of a
 *    `max-age=29030400, immutable` gateway URL never reaches the origin and
 *    its body is written into the profile's `Cache_Data`. `cache: 'no-store'`
 *    is what keeps this path cacheless — see the note on the option below.
 *  - `net.request` reaches registered custom protocol handlers unless
 *    `bypassCustomProtocolHandlers` is set. The test harness owns `http:` and
 *    `https:` (`test-harness.js`), so without that option a gateway request
 *    would be answered by the harness stub instead of the gateway. undici
 *    never saw those handlers; the option keeps the behaviour identical.
 *
 * WHY AN `.onion` GATEWAY IS CHECKED BEFORE IT IS DIALLED
 *
 * Routing through Chromium only helps once the session actually carries the
 * PAC. At launch it does not: `startIpfs()` probes the configured gateway
 * immediately, while `tor-manager` is still waiting for Arti's SOCKS listener
 * to bootstrap (seconds, up to ~120s). Measured on Electron 44.3.0,
 * `session.resolveProxy` answers `DIRECT` for the onion URL in that window and
 * the dial fails with `net::ERR_NAME_NOT_RESOLVED` in ~12ms — i.e. Chromium
 * handed the onion hostname to the system resolver, the exact leak this
 * transport exists to close. So a `.onion` dial is refused outright unless the
 * session resolves it through a proxy: no name leaves the machine, and the
 * caller sees a failed request it can retry (`ipfs-manager.js` keeps its
 * health check armed for exactly that, so the node completes its start once
 * the PAC lands).
 */

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// `localhost` counts as loopback here: it resolves there, and Kubo binds its
// RPC API to loopback by default, so it is the same machine either way.
//
// Literal IPv4 loopback only: every octet must be digits. A `127.` *prefix*
// test would also accept a resolvable DNS name like `127.evil.example`, which
// points wherever its owner wants — and this gate is what keeps the
// unsolicited `:5001` RPC POST on the user's own machine.
function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'localhost' || host === '[::1]' || host === '::1' || LOOPBACK_IPV4.test(host);
}

// Fail closed: a URL we cannot parse is not treated as loopback, so it takes
// the proxy-honouring transport rather than the one that ignores the session.
function isLoopbackGatewayUrl(url) {
  try {
    return isLoopbackHostname(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

// The PAC's own host test, mirrored (`dnsDomainIs(host, ".onion") || host ===
// "onion"` in src/main/tor-proxy.js), so the two cannot disagree about what
// counts as an onion address. A trailing root dot is stripped: `abc.onion.`
// is the same name to Chromium and to the resolver.
function isOnionHostname(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  return host === 'onion' || host.endsWith('.onion');
}

// Fail closed the other way round from `isLoopbackGatewayUrl`: an unparseable
// URL is not onion, so it takes the ordinary path rather than being refused.
function isOnionGatewayUrl(url) {
  try {
    return isOnionHostname(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

async function defaultResolveProxy(url) {
  // `net.request` dials on `session.defaultSession` unless told otherwise, so
  // that is the session whose proxy policy decides this request's fate.
  const { session } = require('electron');
  const targetSession = session?.defaultSession;
  if (typeof targetSession?.resolveProxy !== 'function') {
    throw new Error('session.resolveProxy is unavailable');
  }
  return targetSession.resolveProxy(url);
}

// Chromium answers with the PAC result list: `SOCKS5 127.0.0.1:9150`,
// `PROXY host:port`, `DIRECT`, or a fallback chain (`SOCKS5 host:port;DIRECT`).
// Only an all-proxy list counts as routed — a chain that can fall back to
// DIRECT resolves the name locally the moment the proxy is unreachable, which
// is the leak, not a degraded mode.
function isProxiedResolution(resolved) {
  const entries = String(resolved || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!entries.length) return false;
  return entries.every((entry) => entry.toUpperCase() !== 'DIRECT');
}

async function assertOnionRoutable(url, deps) {
  let resolved;
  try {
    resolved = await (deps.resolveProxy || defaultResolveProxy)(url);
  } catch (err) {
    // A session we cannot ask is a session we cannot trust to proxy: refuse
    // rather than dial and hope.
    throw new Error(`.onion gateway proxy route could not be resolved: ${err?.message || err}`, {
      cause: err,
    });
  }
  if (!isProxiedResolution(resolved)) {
    throw new Error(
      `.onion gateway is not routed through a proxy (resolveProxy: ${resolved || '(empty)'}) — not dialled, so the onion hostname is never sent to the system resolver`
    );
  }
}

// Statuses the fetch spec forbids a body on. Chromium delivers no body for
// them either, and `new Response(body, { status })` throws if one is passed.
// The spec's list also names the informational 101/103, but they are
// deliberately absent: `Response` only accepts 200-599, so `new Response(null,
// { status: 101 })` throws a RangeError rather than answering. Chromium never
// surfaces an informational status as a final response, and if it ever did the
// out-of-range guard below turns it into a failed request instead.
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

// `new Response(…, { status })` throws a RangeError outside 200-599, and these
// constructions run inside `net.request` event handlers where a throw is an
// uncaught main-process exception, not a failed request. Build through this so
// any such status unwinds the promise like any other transport failure.
function buildResponse(body, init) {
  try {
    return new Response(body, init);
  } catch (err) {
    throw new Error(
      `gateway response could not be represented (status ${init?.status}): ${err?.message || err}`,
      {
        cause: err,
      }
    );
  }
}

function abortError() {
  if (typeof DOMException === 'function') {
    return new DOMException('The operation was aborted', 'AbortError');
  }
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

// Electron reports a response's headers as `string | string[]` values (the
// `redirect` event uses arrays throughout; `set-cookie` is always an array).
function headersFromNetResponse(rawHeaders) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(rawHeaders || {})) {
    const values = Array.isArray(value) ? value : [value];
    for (const entry of values) {
      if (entry == null) continue;
      try {
        headers.append(name, String(entry));
      } catch {
        /* A header Chromium accepted but `Headers` rejects is dropped, not fatal. */
      }
    }
  }
  return headers;
}

function defaultNetRequest(options) {
  const { net } = require('electron');
  const request = typeof net?.request === 'function' ? net.request(options) : null;
  // Fail closed rather than falling back to a transport that ignores the
  // session proxy: an unusable `net` must surface as a failed gateway
  // request, never as a silently unproxied one.
  if (typeof request?.on !== 'function') {
    throw new Error('Electron net.request is unavailable');
  }
  return request;
}

/**
 * `fetch`-shaped GET/HEAD over Chromium's network stack, so the request
 * follows the session's proxy configuration.
 *
 * Supports exactly what the external gateway path uses: `method`, `headers`,
 * `signal` and `redirect: 'manual'`. Any other redirect mode is rejected
 * outright — `follow` on this path is the SSRF hole `redirect: 'manual'` was
 * added to close (a gateway answering `302 Location: http://127.0.0.1:1633/…`
 * would have Freedom fetch the user's own loopback services and hand the body
 * back under the `ipfs://` origin), so it must not be reachable by accident.
 *
 * @param {string} url
 * @param {{method?: string, headers?: Headers, signal?: AbortSignal, redirect?: string}} init
 * @param {{requestImpl?: Function, resolveProxy?: Function}} deps - test seams for
 *   `net.request` and `session.resolveProxy`
 * @returns {Promise<Response>}
 */
async function netGatewayFetch(url, init = {}, deps = {}) {
  const { method = 'GET', headers, signal, redirect = 'manual' } = init;
  if (redirect !== 'manual') {
    throw new Error(`gateway transport supports redirect: 'manual' only (got '${redirect}')`);
  }
  if (signal?.aborted) throw abortError();
  // Refused before the request exists, so Chromium is never asked to resolve
  // an onion name the session would send DIRECT (see the file header).
  if (isOnionGatewayUrl(url)) await assertOnionRoutable(url, deps);
  const requestImpl = deps.requestImpl || defaultNetRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    let bodyController = null;
    let onAbort = null;

    // Re-checked here, not just on entry: `assertOnionRoutable` awaits
    // `session.resolveProxy`, so the caller's deadline (the probe's 2s timer)
    // can land while that is in flight. `addEventListener('abort')` never
    // fires for a signal that already aborted, so creating the request now
    // would dial the gateway *after* the abort with nothing left able to
    // cancel it — the returned promise would then hang until the network
    // settled it, stalling whoever awaited it.
    if (signal?.aborted) {
      reject(abortError());
      return;
    }

    const request = requestImpl({
      method,
      url,
      redirect: 'manual',
      // Nothing from the session but its proxy policy: no cookies and no
      // stored credentials travel to a third-party gateway, matching what
      // undici sent (nothing) on this path.
      credentials: 'omit',
      useSessionCookies: false,
      // Neither read from nor written to Chromium's HTTP cache — undici had no
      // cache at all, and both halves of that matter here:
      //  - Kubo serves every `/ipfs/<cid>` (the reachability probe's
      //    `bafkqaaa` included) with `Cache-Control: public, max-age=29030400,
      //    immutable`, so a cached 200 would answer `probeExternalGateway`
      //    forever — a dead remote gateway would read healthy across restarts
      //    and the unreachable-status/retry path (#351) would never arm.
      //  - `ipfs://` loads from a private window come through this same
      //    handler, so storing would write visited CIDs, gateway host and page
      //    bytes into the *default* profile's on-disk cache — as would
      //    `ens-prefetch.js`, for content the user only ever resolved.
      cache: 'no-store',
      // Straight to the network — never back into a registered `http(s)`
      // protocol handler (the test harness registers one).
      bypassCustomProtocolHandlers: true,
    });

    const detach = () => {
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      onAbort = null;
    };
    const abortRequest = () => {
      try {
        request.abort();
      } catch {
        /* already finished */
      }
    };
    const fail = (err) => {
      detach();
      if (!settled) {
        settled = true;
        reject(err);
        return;
      }
      // The response was already handed back: surface the failure on its body
      // stream so the caller's reader (and its byte counter) unwinds.
      try {
        bodyController?.error(err);
      } catch {
        /* stream already closed or errored */
      }
    };
    const succeed = (response) => {
      settled = true;
      resolve(response);
    };

    if (signal) {
      onAbort = () => {
        abortRequest();
        fail(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    // `redirect: 'manual'`: the hop is reported, never taken. Aborting here is
    // what stops Chromium from following it (an unanswered `redirect` event
    // leaves the request hanging), and the 3xx goes back to the caller with
    // its headers so `Location` can be rewritten into the `ipfs://` space.
    request.on('redirect', (status, _method, _redirectUrl, responseHeaders) => {
      abortRequest();
      detach();
      if (settled) return;
      try {
        succeed(buildResponse(null, { status, headers: headersFromNetResponse(responseHeaders) }));
      } catch (err) {
        fail(err);
      }
    });

    request.on('response', (response) => {
      // Every response this handler abandons (drained or destroyed) still needs
      // an 'error' listener: it is an EventEmitter, so a socket error emitted on
      // one with no listener is an uncaught main-process exception, not a failed
      // request. The streaming branch below attaches its own via `fail`.
      const ignoreErrorsOnAbandoned = () => response.on?.('error', () => {});

      if (settled) {
        ignoreErrorsOnAbandoned();
        response.destroy?.();
        return;
      }
      const status = response.statusCode;
      const statusText = response.statusMessage || '';
      const responseHeaders = headersFromNetResponse(response.headers);

      if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
        // Drained and abandoned: nothing reads it after this, so it needs the
        // same 'error' handling as the destroyed one above.
        ignoreErrorsOnAbandoned();
        response.resume?.();
        detach();
        try {
          succeed(buildResponse(null, { status, statusText, headers: responseHeaders }));
        } catch (err) {
          abortRequest();
          fail(err);
        }
        return;
      }

      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
          response.on('data', (chunk) => {
            try {
              controller.enqueue(chunk);
            } catch {
              return; // cancelled/errored downstream
            }
            // Backpressure: stop pulling from the socket until the consumer
            // asks for more, so a fast gateway can't outrun a slow page.
            if (controller.desiredSize !== null && controller.desiredSize <= 0) {
              response.pause?.();
            }
          });
          response.on('end', () => {
            detach();
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
          response.on('aborted', () => fail(abortError()));
          response.on('error', (err) => fail(err));
        },
        pull() {
          response.resume?.();
        },
        cancel() {
          detach();
          abortRequest();
        },
      });

      try {
        succeed(buildResponse(body, { status, statusText, headers: responseHeaders }));
      } catch (err) {
        // Nobody will ever read `body`, so stop pulling from the socket rather
        // than leaving a paused stream behind the rejected promise.
        abortRequest();
        fail(err);
      }
    });

    request.on('error', (err) => fail(err));

    try {
      // `Headers` on this path, but a plain object must not silently send
      // nothing if a future caller passes one.
      const entries =
        typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers || {});
      for (const [name, value] of entries) {
        request.setHeader(name, value);
      }
      request.end();
    } catch (err) {
      // The request exists but was never ended: settle it, or a rejected
      // promise leaves a half-built ClientRequest behind in Chromium.
      abortRequest();
      fail(err);
    }
  });
}

/**
 * Dial an external IPFS gateway URL.
 *
 * Loopback gateways (the documented Kubo/IPFS Desktop setup) keep Node's
 * `fetch`: Chromium bypasses proxies for loopback anyway, so there is nothing
 * to honour, and the local path stays byte-for-byte what it was. Everything
 * else goes through Chromium, where the session's proxy policy applies.
 *
 * @param {string} url
 * @param {object} init - `fetch` init, restricted to what `netGatewayFetch` supports
 * @param {{nodeFetch?: Function, requestImpl?: Function, resolveProxy?: Function}} deps - test seam
 * @returns {Promise<Response>}
 */
async function gatewayFetch(url, init = {}, deps = {}) {
  if (isLoopbackGatewayUrl(url)) {
    return (deps.nodeFetch || fetch)(url, init);
  }
  return netGatewayFetch(url, init, deps);
}

module.exports = {
  gatewayFetch,
  netGatewayFetch,
  isLoopbackHostname,
  isLoopbackGatewayUrl,
  isOnionHostname,
  isOnionGatewayUrl,
};
