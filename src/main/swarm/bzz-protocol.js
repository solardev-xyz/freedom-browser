/**
 * bzz:// protocol handler
 *
 * Registers a main-process handler for the `bzz:` scheme (standard, secure,
 * streaming, CORS-enabled; see `registerSchemesAsPrivileged` in index.js).
 * Every `bzz://<hash>/<path>` request — top-level navigation, sub-resource,
 * `fetch`, media `Range`, CSS `url(...)`, service worker — flows through
 * this handler instead of Chromium going directly to the Ant gateway.
 *
 * The core plans each request (freedom-core design 0006, `dweb.open`): it
 * parses the URL, resolves a name host, applies the header allowlist (O-2,
 * #429) and Swarm's retrieval hints, refuses other methods (405) and encoded
 * separators (400), and fixes the retry schedule (~50 s of back-off on 500,
 * 502, 503 and 504; 404 is final, so SPAs that feature-detect missing
 * endpoints render fast) and the 30 s per-attempt deadline. Main checks the
 * plan and executes it (`dweb/dweb-handler.js`): this file is the Ant
 * transport the plan's `ant` node maps to.
 *
 * Why this lives here and not as a `webRequest` redirect: cold Ant nodes
 * produce transient 5xx responses on first contact with a chunk even when the
 * content is healthy, and the webRequest session API has no primitive for
 * "retry this request". Moving the transport here lets us retry transient
 * failures transparently, stream the response back, and preserve Range
 * semantics without injecting any script into the page.
 */

const log = require('../logger');
const { MODE, getAntApiUrl, getService } = require('../service-registry');
const { handleDwebRequest } = require('../dweb/dweb-handler');
const { isLoopbackGatewayUrl, netGatewayFetch } = require('../ipfs/gateway-transport');
const { announceMainProcessAntDial } = require('./ant-api-main-dials');
const { isPrivateLogContext, runWithPrivateLogContext } = require('../private/private-log-context');

// Chromium's network errors, read as the codes undici gives the same
// failures, so a remote Ant that refuses a connection is still "bee gateway
// unreachable" (503) once it is dialled on the session's stack.
const CHROMIUM_ERROR_CODES = new Map([
  ['net::ERR_CONNECTION_REFUSED', 'ECONNREFUSED'],
  ['net::ERR_CONNECTION_RESET', 'ECONNRESET'],
  ['net::ERR_NAME_NOT_RESOLVED', 'ENOTFOUND'],
]);

function withChromiumCode(err) {
  const code = CHROMIUM_ERROR_CODES.get(String(err?.message || '').trim());
  if (code && err && typeof err === 'object' && !err.code) err.code = code;
  return err;
}

/**
 * Dials the Ant once.
 *
 * - A loopback Ant, bundled or external, with Node's `fetch` (undici): it
 *   needs no proxy, and the dial stays outside the session's `webRequest`.
 * - A non-loopback Ant (deviation `transport`, #360) with `net.request` on the
 *   request's session (`ipfs/gateway-transport.js`): manual redirects, the
 *   onion refusal before dialling when the session would resolve the host
 *   DIRECT, credentials omitted and no HTTP cache. That dial passes the
 *   session's `webRequest` with no frame, where `ant-api-guard.js` cancels
 *   anything on the node's origin, so this exact URL is announced to the
 *   guard (`ant-api-main-dials.js`) and released once the dial settles.
 */
async function dialAnt(url, init, { session, fetchImpl }) {
  if (isLoopbackGatewayUrl(url)) return fetchImpl(url, init);
  const release = announceMainProcessAntDial(url);
  try {
    return await netGatewayFetch(url, init, session ? { session } : {});
  } catch (err) {
    throw withChromiumCode(err);
  } finally {
    release();
  }
}

/**
 * One attempt of the plan's fetch, with its own AbortController: linked to
 * the page's signal, so a cancellation still aborts the dial, and with the
 * plan's per-attempt deadline, so an Ant that accepts the connection and then
 * stalls (crash mid-response, paused worker) can't hang the retry loop.
 * Once the headers are in, the page's signal is unhooked: after that, a
 * cancel of the body is what stops the transfer.
 */
async function fetchOnce(url, { method, headers, signal, headersTimeoutMs }, transport) {
  const attemptCtl = new AbortController();
  const relayAbort = () => attemptCtl.abort();
  if (signal) {
    if (signal.aborted) attemptCtl.abort();
    else signal.addEventListener('abort', relayAbort, { once: true });
  }
  let timedOut = false;
  const timer =
    headersTimeoutMs === null
      ? null
      : setTimeout(() => {
          timedOut = true;
          attemptCtl.abort();
        }, headersTimeoutMs);
  try {
    return await dialAnt(
      url,
      { method, headers, signal: attemptCtl.signal, redirect: 'manual' },
      transport
    );
  } catch (err) {
    // Our own deadline with the page still waiting: a transient error the
    // retry loop tries again, not the raw AbortError.
    if (timedOut && !signal?.aborted) {
      const timeout = new Error(`bee fetch timed out after ${headersTimeoutMs}ms`);
      timeout.code = 'ATTEMPT_TIMEOUT';
      throw timeout;
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relayAbort);
  }
}

/**
 * The Ant serving `bzz:` now, captured when a request is admitted and kept
 * for it, retries included, so a settings change mid-request can't redirect
 * the fetch (design 0006, Binding). The core learns only its mode and
 * whether it is up, never its URL.
 *
 * @param {object} [transport]
 * @param {Electron.Session} [transport.session] - the request's session
 * @param {typeof fetch} [transport.fetchImpl] - the loopback dial
 */
function antBackend({ session = null, fetchImpl = fetch } = {}) {
  const url = getAntApiUrl() || null;
  const mode = getService('ant')?.mode === MODE.BUNDLED ? 'bundled' : 'external';
  return {
    ref: { ant: mode, up: Boolean(url) },
    url,
    request: ({ path, ...init }) => fetchOnce(`${url}${path}`, init, { session, fetchImpl }),
  };
}

/**
 * Serves one `bzz:` request. Exported for in-process callers
 * (`permission-manifests.js`), which pass the session and private context
 * explicitly, and for tests.
 *
 * @param {Request} request
 * @param {object} [options]
 * @param {Electron.Session} [options.session] - the session the request is
 *   on; a remote Ant is dialled on its network stack
 * @param {string|null} [options.partition] - a private session's partition
 * @param {boolean} [options.isPrivate] - a private window's request
 * @param {typeof fetch} [options.fetchImpl] - the loopback Ant dial
 */
function handleBzzRequest(
  request,
  {
    session = null,
    partition = null,
    isPrivate = isPrivateLogContext(),
    fetchImpl = (...args) => fetch(...args),
  } = {}
) {
  return runWithPrivateLogContext(isPrivate, () =>
    handleDwebRequest(request, {
      backend: antBackend({ session, fetchImpl }),
      partition,
      tag: '[bzz-protocol]',
    })
  );
}

/**
 * Register the `bzz:` protocol handler on the given session.
 * Call after `app.whenReady()`. The `bzz` scheme must already have been
 * registered privileged via `protocol.registerSchemesAsPrivileged` before
 * `app.ready` — see `main/index.js`.
 */
function registerBzzProtocol(targetSession, { privatePartition = null } = {}) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[bzz-protocol] session.protocol.handle unavailable — skipping');
    return;
  }
  // PRIVATE MODE GUARD (request logging): this handler is registered once
  // per session, so a private window's session gets its own registration —
  // the one place where private-ness is known for every request it serves.
  // Marking the whole handler redacts the URL and gateway log lines here
  // AND marks its plan private for the core (see private-log-context.js).
  const isPrivate = !!privatePartition;
  try {
    targetSession.protocol.handle('bzz', (request) =>
      handleBzzRequest(request, {
        session: targetSession,
        partition: privatePartition,
        isPrivate,
      })
    );
    log.info('[bzz-protocol] handler registered');
  } catch (err) {
    log.error('[bzz-protocol] failed to register handler:', err);
  }
}

module.exports = {
  registerBzzProtocol,
  handleBzzRequest,
  antBackend,
};
