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
const { dwebVerifier } = require('../core/dweb-verify');
const { loadsOnlyVerifiedContent } = require('../dweb/strict-mode');
const { getActiveProfile } = require('../profile-resolver');
const { isLoopbackGatewayUrl, netGatewayFetch } = require('../ipfs/gateway-transport');
const { announceMainProcessAntDial } = require('./ant-api-main-dials');
const { leaseWriteSession, AntNotDialled } = require('./ant-write-sessions');
const { unlessAborted } = require('../lib/unless-aborted');
const { isPrivateLogContext, runWithPrivateLogContext } = require('../private/private-log-context');
const { serveLabelled } = require('../dweb/content-trust');

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

// Remote Ant dials abandoned while their transport hadn't returned (a session
// proxy lookup that ignores the abort): past this many, new ones fail at
// once, as naming's abandoned hops do.
const MAX_ABANDONED_DIALS = 64;
let abandonedDials = 0;

/**
 * Dials the Ant once.
 *
 * - A loopback Ant, bundled or external, with Node's `fetch` (undici): it
 *   needs no proxy, and the dial stays outside the session's `webRequest`. A
 *   stream body goes with `duplex: 'half'`, pulled as the socket takes it.
 * - A non-loopback Ant (deviation `transport`, #360) with `net.request`
 *   (`ipfs/gateway-transport.js`): manual redirects, the onion refusal
 *   before dialling when the session would resolve the host DIRECT,
 *   credentials omitted and no HTTP cache, and a stream body written as it
 *   is pulled.
 *   - A read (GET or HEAD) goes on the request's session. That dial passes
 *     the session's `webRequest` with no frame, where `ant-api-guard.js`
 *     cancels anything on the node's origin, so this exact URL and the one
 *     method the dial sends are announced to the guard
 *     (`ant-api-main-dials.js`) and released once the dial settles.
 *     Chromium may send a read again when a reused connection closes before
 *     its headers, which is idempotent.
 *   - A write (POST, or ant-storage-api's PUT) goes on a write session of
 *     its own, on the request session's proxy, with no connection open
 *     before it, whose own guard admits that write and nothing else
 *     (`ant-write-sessions.js`, which refuses any other method undialled):
 *     Chromium sends it once, whole or streamed, and it fails when the node
 *     hangs up (freedom-core design 0015, point 6; #1344). It holds that
 *     session until its reply is over.
 *
 * The remote dial is waited on only while the attempt lives: its header
 * deadline, the page's abort or the session's close ends the wait at once,
 * even while the session's proxy lookup ignores it. That work is abandoned:
 * the transport refuses to dial an aborted request once the lookup returns,
 * anything it still brings is discarded, and it is counted until it settles.
 */
async function dialAnt(url, init, { session, fetchImpl }) {
  if (isLoopbackGatewayUrl(url)) {
    return isStreamBody(init.body) ? dialWithUpload(url, init, fetchImpl) : fetchImpl(url, init);
  }
  if (abandonedDials >= MAX_ABANDONED_DIALS) {
    const err = new AntNotDialled('too many abandoned Ant dials');
    if (isStreamBody(init.body)) init.body.cancel(err).catch(() => {});
    throw err;
  }
  const write = init.method !== 'GET' && init.method !== 'HEAD';
  const release = write ? () => {} : announceMainProcessAntDial(url, init.method);
  const dialling = Promise.resolve().then(() =>
    write ? dialWrite(url, init, session) : netGatewayFetch(url, init, session ? { session } : {})
  );
  try {
    return await unlessAborted(dialling, init.signal);
  } catch (err) {
    if (init.signal.aborted) {
      abandonedDials += 1;
      dialling
        .then(
          (late) => late?.body?.cancel().catch(() => {}),
          () => {}
        )
        .finally(() => {
          abandonedDials -= 1;
        });
    }
    throw withChromiumCode(err);
  } finally {
    release();
  }
}

/**
 * A write to a remote Ant, on a write session leased for it
 * (`ant-write-sessions.js`) and handed back once its reply is over: its
 * body's end, failure or cancel, or the dial's failure. A stream body is
 * cancelled when no session could be prepared, since nothing will pull it.
 */
async function dialWrite(url, init, source) {
  let lease;
  try {
    lease = await leaseWriteSession(source, url, init.method, init.signal);
  } catch (err) {
    if (isStreamBody(init.body)) init.body.cancel(err).catch(() => {});
    throw err;
  }
  try {
    const response = await netGatewayFetch(url, init, { session: lease.session });
    return endingWith(response, lease.release);
  } catch (err) {
    lease.release();
    throw err;
  }
}

// A web `ReadableStream` request body (an upload streamed from the core).
function isStreamBody(body) {
  return typeof body?.getReader === 'function';
}

/**
 * The request body `request()` takes: none, bytes, or a `ReadableStream` of
 * bytes, and none on a GET or HEAD. Refused before any dial or announcement.
 */
function checkBody(method, body) {
  if (body == null) return;
  if (method === 'GET' || method === 'HEAD') {
    throw new TypeError(`a ${method} request cannot carry a body`);
  }
  if (!(body instanceof Uint8Array) && !isStreamBody(body)) {
    throw new TypeError('an Ant request body is bytes or a stream');
  }
}

function abortError() {
  return new DOMException('This operation was aborted', 'AbortError');
}

/**
 * A stream body for undici, ended with its dial. Once a fetch is cancelled
 * (an abort, or its reply's body cancelled), Node's fetch keeps reading the
 * request's stream to its end and drops each chunk unsent (undici's
 * `processBodyChunk`): an upload from the core would be pulled whole, for
 * nothing. So the body goes through this stream, pulled one chunk at a time
 * as undici asks. `end(reason)` cancels the source and fails every later
 * read, which stops undici's loop; a body already over is left alone.
 */
function endableBody(body) {
  const reader = body.getReader();
  let over = false;
  let ended = null;
  const end = (reason) => {
    if (over) return;
    over = true;
    ended = reason ?? abortError();
    reader.cancel(ended).catch(() => {});
  };
  const stream = new ReadableStream(
    {
      async pull(controller) {
        if (ended) {
          controller.error(ended);
          return;
        }
        let next;
        try {
          next = await reader.read();
        } catch (err) {
          over = true;
          controller.error(err);
          return;
        }
        if (ended) {
          controller.error(ended);
          return;
        }
        if (next.done) {
          over = true;
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      cancel(reason) {
        end(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return { stream, end };
}

/**
 * `response` with a body that runs `end` once it is over: its end, its
 * failure (at once, read or not) or its cancel. A reply without a body runs
 * it at once.
 */
function endingWith(response, end) {
  if (!response.body) {
    end();
    return response;
  }
  const reader = response.body.getReader();
  const body = new ReadableStream(
    {
      start(controller) {
        reader.closed.then(
          () => {},
          (err) => {
            end(err);
            try {
              controller.error(err);
            } catch {
              // Already closed or failed.
            }
          }
        );
      },
      async pull(controller) {
        let next;
        try {
          next = await reader.read();
        } catch (err) {
          end(err);
          controller.error(err);
          return;
        }
        if (next.done) {
          end();
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      },
      cancel(reason) {
        end(reason);
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A loopback dial with a stream body: undici's half duplex, the body pulled
 * as the socket takes it, and ended with the dial (`endableBody`): at the
 * attempt's abort, the dial's failure, or its reply's end, cancel or
 * failure, so an upload left behind is cancelled, never drained.
 */
async function dialWithUpload(url, init, fetchImpl) {
  const upload = endableBody(init.body);
  const { signal } = init;
  const onAbort = () => upload.end(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, body: upload.stream, duplex: 'half' });
    return endingWith(response, upload.end);
  } catch (err) {
    upload.end(err);
    throw err;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * One attempt of the plan's fetch, with its own AbortController: linked to
 * the page's signal, so a cancellation still aborts the dial, and with the
 * plan's per-attempt deadline, so an Ant that accepts the connection and then
 * stalls (crash mid-response, paused worker) can't hang the retry loop.
 * Once the headers are in, the page's signal is unhooked: after that, a
 * cancel of the body is what stops the transfer. A `headersTimeoutMs` of
 * null, or none, sets no deadline (main's Swarm calls: `ant-api-call.js`).
 */
async function fetchOnce(
  url,
  { method = 'GET', headers, body = null, signal, headersTimeoutMs = null },
  transport
) {
  checkBody(method, body);
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
      {
        method,
        headers,
        ...(body !== null && { body }),
        signal: attemptCtl.signal,
        redirect: 'manual',
      },
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
 * "Verify content from this node" for the profile's Swarm node
 * (freedom-core design 0009, Modes): kept with the node's endpoint in the
 * profile (`nodes.bee`, the Swarm slot's key), on unless the profile turned
 * it off.
 */
function verifiesExternalAnt() {
  return getActiveProfile()?.metadata?.nodes?.bee?.verify !== false;
}

/**
 * The Ant serving `bzz:` now, captured when a request is admitted and kept
 * for it, retries included, so a settings change mid-request can't redirect
 * the fetch (design 0006, Binding). The core learns only its mode and
 * whether it is up, never its URL.
 *
 * Its verification is captured with it (freedom-core design 0009, Verify
 * plans): an external Ant, a reused one among them, carries `verify: true`
 * while the profile's setting is on. Ant has no probe: Bee's API, which Ant
 * follows, always serves `/chunks` and `/bytes`. The profile's strict mode
 * is captured with it too: an external Ant carries `strict: true` while
 * "Load only verified content from external nodes" is on, its verification
 * on or off (`dweb/strict-mode.js`). The bundled Ant, and an external one
 * with both settings off, keep the two-key reference, as does every Ant
 * while the core's verifier isn't attached: the core can't serve a verify
 * plan or know strict mode then.
 *
 * `request({ path, method, headers, body, signal, headersTimeoutMs })` is
 * one dial of `path` on this node, with no retry: the dweb plan's executor
 * retries around it, and main's Swarm executor never does
 * (`ant-api-call.js`). `body` is bytes or a `ReadableStream` of bytes (a
 * POST's or a PUT's; design 0015, The transport), pulled only as the node
 * takes it. A remote node's POST or PUT goes on a write session (`dialAnt`),
 * so it is sent once. Main's own calls (`ant-storage-api.js`) use it too.
 *
 * `url` is the node's root without a trailing slash, which `request()` joins
 * `path` to (`ant-manager.js` registers none; ant-storage-api always dropped
 * one).
 *
 * @param {object} [transport]
 * @param {Electron.Session} [transport.session] - the request's session
 * @param {typeof fetch} [transport.fetchImpl] - the loopback dial
 */
function antBackend({ session = null, fetchImpl = fetch } = {}) {
  const api = getAntApiUrl();
  const url = (typeof api === 'string' && api.replace(/\/+$/, '')) || null;
  const mode = getService('ant')?.mode === MODE.BUNDLED ? 'bundled' : 'external';
  // An external Ant, against a core whose verifier is attached.
  const attached = mode === 'external' && dwebVerifier() !== null;
  const verify = attached && verifiesExternalAnt();
  const strict = attached && loadsOnlyVerifiedContent();
  return {
    ref: {
      ant: mode,
      up: Boolean(url),
      ...(verify && { verify: true }),
      ...(strict && { strict: true }),
    },
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
 * @param {(trust: object) => void} [options.onTrust] - the content's trust
 *   (dweb-handler.js), for the trust panel
 */
function handleBzzRequest(
  request,
  {
    session = null,
    partition = null,
    isPrivate = isPrivateLogContext(),
    fetchImpl = (...args) => fetch(...args),
    onTrust,
  } = {}
) {
  return runWithPrivateLogContext(isPrivate, () =>
    handleDwebRequest(request, {
      backend: antBackend({ session, fetchImpl }),
      partition,
      tag: '[bzz-protocol]',
      onTrust,
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
    // Each response carries its content label for the trust panel
    // (dweb/content-trust.js), which the session takes off before any page
    // can read it.
    targetSession.protocol.handle('bzz', (request) =>
      serveLabelled((onTrust) =>
        handleBzzRequest(request, {
          session: targetSession,
          partition: privatePartition,
          isPrivate,
          onTrust,
        })
      )
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
  abandonedAntDials: () => abandonedDials,
  MAX_ABANDONED_DIALS,
};
