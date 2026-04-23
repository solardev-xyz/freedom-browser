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
 * Cold Bee nodes produce transient 404/500 responses on first contact with
 * a chunk even when the content is healthy and peers are plentiful (see
 * "Swarm Content Retrieval" in the README for measured reliability). The
 * webRequest session API has no primitive for "retry this request", so a
 * failed sub-resource can't be recovered at the session layer. Moving the
 * transport here lets us retry transient failures transparently, stream
 * the response back, and preserve Range semantics without injecting any
 * script into the page.
 *
 * Contract:
 *  - GET / HEAD are retried on 404, 500, 502, 503, 504 with bounded
 *    exponential backoff (~3 min total budget).
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

// Per-attempt retry schedule. First entry is the delay BEFORE the 2nd
// attempt, etc. Total budget ≈ sum of all values (~3 min).
const RETRY_DELAYS_MS = [
  500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000, 15000, 30000, 30000, 30000,
];

const RETRYABLE_STATUSES = new Set([404, 500, 502, 503, 504]);
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD']);

// 64-char or 128-char lowercase/uppercase hex (unencrypted / encrypted refs).
const BZZ_HASH_RE = /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/;

// Request headers we should not forward to Bee — either Chromium-injected
// privileged-scheme noise or headers that refer to the bzz:// origin and
// would confuse the gateway.
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
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
 * Translate `bzz://<hash>/<path>?<q>#<f>` into the Bee gateway URL.
 * Returns `null` if the hash segment is not a valid 64/128-char hex ref.
 */
function buildGatewayUrl(bzzUrl) {
  const parsed = new URL(bzzUrl);
  const hash = parsed.hostname;
  if (!BZZ_HASH_RE.test(hash)) {
    return null;
  }
  const beeApiUrl = getBeeApiUrl();
  // parsed.pathname always starts with '/', parsed.search includes '?' or is ''.
  return `${beeApiUrl}/bzz/${hash}${parsed.pathname}${parsed.search}`;
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

async function fetchOnce(gatewayUrl, init, fetchImpl) {
  try {
    const response = await fetchImpl(gatewayUrl, init);
    return { response };
  } catch (err) {
    return { error: err };
  }
}

function shouldRetry(result) {
  if (result.error) return true;
  return RETRYABLE_STATUSES.has(result.response.status);
}

async function fetchWithRetry(gatewayUrl, { method, headers, body, signal }, fetchImpl) {
  const idempotent = IDEMPOTENT_METHODS.has(method.toUpperCase());

  const attempt = async () => {
    const init = { method, headers, signal, redirect: 'manual' };
    // Web `fetch` requires `duplex: 'half'` for streaming request bodies. It's
    // inert on GET/HEAD where body is undefined, so always passing it is safe.
    if (body) {
      init.body = body;
      init.duplex = 'half';
    }
    return fetchOnce(gatewayUrl, init, fetchImpl);
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
    log.info(
      `[bzz-protocol] retry ${i + 1}/${RETRY_DELAYS_MS.length} in ${delay}ms ` +
        `(status=${result.response?.status ?? 'error'}) ${gatewayUrl}`
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
 * fetch but tests can inject a stub.
 */
async function handleBzzRequest(request, { fetchImpl = fetch } = {}) {
  const gatewayUrl = buildGatewayUrl(request.url);
  if (!gatewayUrl) {
    return new Response(
      JSON.stringify({
        code: 400,
        message: 'invalid bzz reference',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
    );
  }

  const headers = sanitizeRequestHeaders(request.headers);
  const method = request.method || 'GET';
  const body = method === 'GET' || method === 'HEAD' ? undefined : request.body;

  try {
    return await fetchWithRetry(
      gatewayUrl,
      { method, headers, body, signal: request.signal },
      fetchImpl
    );
  } catch (err) {
    const code = err?.cause?.code || err?.code || '';
    const isConnRefused = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ENOTFOUND';
    log.warn(
      `[bzz-protocol] fetch failed for ${gatewayUrl}: ${err?.message || err}` +
        (code ? ` (${code})` : '')
    );
    return new Response(
      JSON.stringify({
        code: isConnRefused ? 503 : 502,
        message: isConnRefused
          ? 'bee gateway unreachable'
          : 'bee gateway error',
      }),
      {
        status: isConnRefused ? 503 : 502,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }
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
};
