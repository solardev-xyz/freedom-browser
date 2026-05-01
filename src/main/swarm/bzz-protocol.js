/**
 * bzz:// protocol handler
 *
 * Registers a main-process handler for the `bzz:` scheme (standard, secure,
 * streaming, CORS-enabled; see `registerSchemesAsPrivileged` in index.js).
 * Every `bzz://<hash>/<path>` request — top-level navigation, sub-resource,
 * `fetch`, media `Range`, CSS `url(...)`, service worker — flows through
 * this handler instead of Chromium going directly to the Bee gateway.
 *
 * Why this lives here and not as a `webRequest` redirect:
 *
 * Cold Bee nodes produce transient 5xx responses on first contact with a
 * chunk even when the content is healthy and peers are plentiful (see
 * "Swarm Content Retrieval" in the README for measured reliability). The
 * webRequest session API has no primitive for "retry this request", so a
 * failed sub-resource can't be recovered at the session layer. Moving the
 * transport here lets us retry transient failures transparently, stream
 * the response back, and preserve Range semantics without injecting any
 * script into the page.
 *
 * Contract:
 *  - GET / HEAD are retried on 500, 502, 503, 504 with bounded
 *    exponential backoff (~50 s total backoff budget).
 *  - 404 is **not** retried. Top-level navigation is gated by the probe
 *    in `swarm-probe.js`, which only resolves once Bee is warm enough to
 *    HEAD the manifest. Subresource 404s after that point are almost
 *    always genuine "asset doesn't exist" cases — e.g. SPAs feature-
 *    detecting endpoints — and need to fail fast so the page can render
 *    its own fallback rather than stalling for ~50 s per missing asset.
 *  - Other methods are single-shot: the request body is a consumable
 *    ReadableStream, so we can't replay it. This primarily affects POST,
 *    which bzz sites don't use for reads.
 *  - Every outgoing request carries `Swarm-Chunk-Retrieval-Timeout`,
 *    `Swarm-Redundancy-Strategy`, and `Swarm-Redundancy-Fallback-Mode`
 *    so Bee gets extra server-side runway per chunk. These are ignored
 *    by Bee for non-redundant content, so they're always safe to set.
 *  - Response body is streamed (no buffering), so large files and media
 *    Range requests don't balloon memory.
 */

const log = require('../logger');
const { getBeeApiUrl } = require('../service-registry');
const { resolveEnsContent } = require('../ens-resolver');
const { isEnsHost } = require('../../shared/origin-utils');

// Per-attempt retry schedule. First entry is the delay BEFORE the 2nd
// attempt, etc. Total backoff budget ≈ sum of all values (~50s). The probe
// in `swarm-probe.js` already gates the top-level navigation on a longer
// (~5 min) deadline, so per-subresource budgets can stay short — otherwise
// a legitimate 404 paints the broken-image placeholder minutes late and
// `<img onerror>` / `fetch().catch()` for real 404s also lag.
const RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000];

// Per-attempt deadline. Bee's `Swarm-Chunk-Retrieval-Timeout: 30s` already
// bounds server-side work, but it doesn't help if Bee accepts the TCP
// connection and then stalls (crash mid-response, paused worker, debugger
// breakpoint). This safety net mirrors the per-attempt timeout in
// swarm-probe.js so the retry loop can always make progress.
const ATTEMPT_TIMEOUT_MS = 30_000;

// 5xx only — 404 is treated as a definitive "not found" so SPAs that
// feature-detect missing endpoints render fast. See the file header for
// rationale (the navigation probe handles the cold-start 404 case
// upstream of subresource fetches).
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

// 64-char or 128-char lowercase/uppercase hex (unencrypted / encrypted refs).
const BZZ_HASH_RE = /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/;

// Request headers we should not forward to Bee — either Chromium-injected
// privileged-scheme noise or headers that refer to the bzz:// origin and
// would confuse the gateway. `cookie` / `authorization` aren't a real
// security risk against localhost Bee but stripping them keeps the request
// shape consistent with how we strip Origin / Referer.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'authorization',
  // Connection / hop-by-hop
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function sanitizeRequestHeaders(requestHeaders) {
  const out = new Headers();
  for (const [name, value] of requestHeaders.entries()) {
    if (STRIPPED_REQUEST_HEADERS.has(name.toLowerCase())) continue;
    out.append(name, value);
  }
  out.set('Swarm-Chunk-Retrieval-Timeout', '30s');
  out.set('Swarm-Redundancy-Strategy', '3');
  out.set('Swarm-Redundancy-Fallback-Mode', 'true');
  return out;
}

/**
 * Translate `bzz://<host>/<path>?<q>#<f>` into the Bee gateway URL.
 *
 * `<host>` is either:
 *  - a 64- or 128-char hex Swarm ref (synchronous path), OR
 *  - an ENS name ending in .eth / .box, resolved via the in-process
 *    `ens-resolver` cache. ENS resolution running here (not just in the
 *    renderer's address-bar pipeline) is what makes `bzz://name.eth/`
 *    survive as the URL Chromium loads — so DevTools, `window.location`,
 *    storage origin, and subresource fetches all see the ENS name rather
 *    than the resolved hash.
 *
 * Returns one of:
 *  - `{ ok: true, url }`              — usable Bee gateway URL.
 *  - `{ ok: false, status, message }` — semantic failure (404 mismatch /
 *    no contenthash, 415 unsupported codec, 502 resolver conflict/error).
 *  - `null`                           — malformed input. Caller emits 400
 *    to keep the existing "invalid bzz reference" surface stable.
 */
async function buildGatewayUrl(bzzUrl) {
  let parsed;
  try {
    parsed = new URL(bzzUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname;

  if (BZZ_HASH_RE.test(host)) {
    return {
      ok: true,
      url: `${getBeeApiUrl()}/bzz/${host}${parsed.pathname}${parsed.search}`,
    };
  }

  if (isEnsHost(host) && !hasEmptyLabel(host)) {
    return resolveEnsToGatewayUrl(host, parsed);
  }

  return null;
}

// Cheap pre-filter for hosts with empty labels (e.g. `.eth`, `foo..eth`).
// The resolver would reject these too, but catching them here avoids a
// wasted RPC. Do NOT enforce any minimum label length: legacy two-char
// `.eth` registrations (`me.eth`) and single-char subdomains
// (`a.foo.eth`, `1.poap.eth`) are both valid and common.
function hasEmptyLabel(host) {
  return host.split('.').some((label) => label.length === 0);
}

// Resolve an ENS host to a Bee gateway URL. `parsed` is the original
// `bzz://name.eth/path?q` URL — pathname/search are forwarded verbatim.
// Cross-transport mismatches (e.g. bzz://swarm.eth where the contenthash
// is IPFS) return 404 with an explanatory body, mirroring the renderer's
// transport assertion: a typed scheme is taken as user intent and we
// don't silently switch transports.
async function resolveEnsToGatewayUrl(host, parsed) {
  let result;
  try {
    result = await resolveEnsContent(host);
  } catch (err) {
    log.warn(`[bzz-protocol] ENS resolver threw for ${host}: ${err.message}`);
    return { ok: false, status: 502, message: `ENS resolver error: ${err.message}` };
  }

  if (!result) {
    return { ok: false, status: 502, message: `ENS resolver returned no result for ${host}` };
  }

  if (result.type === 'ok') {
    if (result.protocol !== 'bzz') {
      return {
        ok: false,
        status: 404,
        message: `ENS name ${host} resolves to ${result.protocol}, not Swarm`,
      };
    }
    return {
      ok: true,
      url: `${getBeeApiUrl()}/bzz/${result.decoded}${parsed.pathname}${parsed.search}`,
    };
  }

  if (result.type === 'not_found') {
    return {
      ok: false,
      status: 404,
      message: `ENS name ${host} has no contenthash (${result.reason || 'unknown'})`,
    };
  }

  if (result.type === 'unsupported') {
    return {
      ok: false,
      status: 415,
      message: `ENS name ${host} contenthash format unsupported`,
    };
  }

  if (result.type === 'conflict') {
    return { ok: false, status: 502, message: `ENS providers disagree on ${host}` };
  }

  // result.type === 'error' or anything we didn't model — degrade to 502.
  return {
    ok: false,
    status: 502,
    message: `ENS resolution failed for ${host}: ${result.error || result.reason || 'unknown'}`,
  };
}

// JSON 4xx/5xx response with the Swarm-shaped body the rest of the handler
// emits, so error pages and developer console messages don't see schema
// drift between hex-host and ENS-host failures.
function jsonErrorResponse(status, message) {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchOnce(gatewayUrl, init, fetchImpl, attemptTimeoutMs) {
  // Per-attempt AbortController, linked to the upstream request signal so
  // a webview cancellation still aborts the in-flight fetch, but with its
  // own timeout so a stalled Bee response can't hang the retry loop.
  const attemptCtl = new AbortController();
  const upstream = init.signal;
  const relayAbort = () => attemptCtl.abort();
  if (upstream) {
    if (upstream.aborted) attemptCtl.abort();
    else upstream.addEventListener('abort', relayAbort, { once: true });
  }
  const timer = setTimeout(() => attemptCtl.abort(), attemptTimeoutMs);

  try {
    const response = await fetchImpl(gatewayUrl, { ...init, signal: attemptCtl.signal });
    return { response };
  } catch (err) {
    // If we aborted but the upstream signal is still healthy, it was our
    // attempt-level timeout — surface it as a transient error so the retry
    // loop tries again rather than bubbling out the raw AbortError.
    if (attemptCtl.signal.aborted && !upstream?.aborted) {
      const e = new Error(`bee fetch timed out after ${attemptTimeoutMs}ms`);
      e.code = 'ATTEMPT_TIMEOUT';
      return { error: e };
    }
    return { error: err };
  } finally {
    clearTimeout(timer);
    if (upstream) upstream.removeEventListener('abort', relayAbort);
  }
}

function shouldRetry(result) {
  if (result.error) return true;
  return RETRYABLE_STATUSES.has(result.response.status);
}

async function fetchWithRetry(
  gatewayUrl,
  { method, headers, body, signal },
  fetchImpl,
  attemptTimeoutMs
) {
  const idempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());

  const attempt = async () => {
    const init = { method, headers, signal, redirect: 'manual' };
    // Web `fetch` requires `duplex: 'half'` for streaming request bodies. It's
    // inert on GET/HEAD where body is undefined, so always passing it is safe.
    if (body) {
      init.body = body;
      init.duplex = 'half';
    }
    return fetchOnce(gatewayUrl, init, fetchImpl, attemptTimeoutMs);
  };

  let result = await attempt();
  if (!idempotent) {
    if (result.error) throw result.error;
    return result.response;
  }

  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    if (!shouldRetry(result)) break;
    if (signal?.aborted) break;

    // Drain the previous response body so Node's fetch releases the socket
    // before we start the next attempt.
    if (result.response) {
      try {
        await result.response.body?.cancel();
      } catch {
        // ignored — the body may already be closed
      }
    }

    const delay = RETRY_DELAYS_MS[i];
    log.debug(
      `[bzz-protocol] retry ${i + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms ` +
        `(status=${result.response?.status ?? result.error?.code ?? 'error'}) ${gatewayUrl}`
    );
    await sleep(delay, signal);
    if (signal?.aborted) break;
    result = await attempt();
  }

  if (result.error) throw result.error;
  return result.response;
}

/**
 * Core handler, exported for testability. `fetchImpl` defaults to global
 * fetch but tests can inject a stub. `attemptTimeoutMs` is exposed for
 * tests that need to exercise per-attempt timeout behaviour.
 */
async function handleBzzRequest(
  request,
  { fetchImpl = fetch, attemptTimeoutMs = ATTEMPT_TIMEOUT_MS } = {}
) {
  const built = await buildGatewayUrl(request.url);
  if (!built) {
    return jsonErrorResponse(400, 'invalid bzz reference');
  }
  if (!built.ok) {
    log.info(`[bzz-protocol] ${built.status} for ${request.url}: ${built.message}`);
    return jsonErrorResponse(built.status, built.message);
  }
  const gatewayUrl = built.url;

  const headers = sanitizeRequestHeaders(request.headers);
  const method = request.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body;

  try {
    return await fetchWithRetry(
      gatewayUrl,
      { method, headers, body, signal: request.signal },
      fetchImpl,
      attemptTimeoutMs
    );
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const isConnRefused = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND';
    log.warn(
      `[bzz-protocol] fetch failed for ${gatewayUrl}: ${err?.message || err}` +
        (code ? ` (${code})` : '')
    );
    return jsonErrorResponse(
      isConnRefused ? 503 : 502,
      isConnRefused ? 'bee gateway unreachable' : 'bee gateway error'
    );
  }
}

/**
 * Register the `bzz:` protocol handler on the given session.
 * Call after `app.whenReady()`. The `bzz` scheme must already have been
 * registered privileged via `protocol.registerSchemesAsPrivileged` before
 * `app.ready` — see `main/index.js`.
 */
function registerBzzProtocol(targetSession) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[bzz-protocol] session.protocol.handle unavailable — skipping');
    return;
  }
  try {
    targetSession.protocol.handle('bzz', (request) => handleBzzRequest(request));
    log.info('[bzz-protocol] handler registered');
  } catch (err) {
    log.error('[bzz-protocol] failed to register handler:', err);
  }
}

module.exports = {
  registerBzzProtocol,
  handleBzzRequest,
  buildGatewayUrl,
  sanitizeRequestHeaders,
  RETRY_DELAYS_MS,
  RETRYABLE_STATUSES,
  ATTEMPT_TIMEOUT_MS,
};
