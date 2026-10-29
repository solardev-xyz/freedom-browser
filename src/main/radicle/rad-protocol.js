/**
 * rad:// protocol handler
 *
 * Registers a main-process handler for the `rad:` scheme so any page —
 * including dweb pages served from `bzz://` — can `fetch()` public Radicle
 * repo data through the in-process Radicle node. Both URL forms are
 * supported: `rad://<rid>/<path>` and the canonical URN form
 * `rad:<rid>/<path>`.
 *
 * Unlike `bzz:`/`ipfs:`, the `rad` scheme is registered WITHOUT
 * `standard: true` (see `registerSchemesAsPrivileged` in index.js).
 * Standard schemes get their host lowercased by Chromium's URL
 * canonicalization, which would destroy the case-sensitive base58 RID.
 * IPFS escapes this by re-encoding CIDs to case-insensitive base32; no
 * such re-encoding exists for RIDs. Non-standard schemes are opaque to
 * the canonicalizer, so `request.url` arrives verbatim and is parsed here
 * by hand.
 *
 * Contract:
 *  - GET / HEAD only. Writes (issues, patches, seeding) go through the consented
 *    provider API, never through this handler.
 *  - Only the per-repo surface `/api/v1/repos/rad:<rid>/...` is reachable.
 *    Node-level endpoints (repo listing, node info, sessions) are private
 *    to the user and must not be exposed to arbitrary pages. Path segments
 *    are validated against traversal so a page cannot climb out of its
 *    repo scope.
 *  - Responses stream through with `Access-Control-Allow-Origin: *` so
 *    cross-origin dweb pages (the primary consumer) can read them. Repo
 *    data is public P2P content; the sensitive surface is excluded above.
 *  - Gated on the active profile's Radicle node mode (403 when disabled),
 *    checked per-request like every other Radicle consumer in main.
 *  - Bounded (R-3): reads go through rad-read-admission.js (concurrency,
 *    per-requester queue, wait and run timeouts, abort when the page goes
 *    away), and a response over MAX_RESPONSE_CHARS is refused.
 */

const log = require('../logger');
const {
  runWithPrivateLogContext,
  redactForLog,
  redactUrlForLog,
  redactedFailure,
} = require('../private/private-log-context');
const { isDisabledForProfile } = require('../radicle-manager');
const { decodeRepoApiPath, serveRepoApi } = require('../radicle-api-protocol');
const { createRadReadAdmission, RadReadRefused } = require('./rad-read-admission');
const { registerWebRequestHandler } = require('../webrequest-dispatcher');

// The most JSON text one `rad:` response carries (a blob, a diff, a tree).
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024;

const admission = createRadReadAdmission();

// Cancellation. Chromium cancels a `rad:` request when its page navigates
// away or its tab or window closes, but Electron does not abort the
// Request's AbortSignal for a `protocol.handle` handler (Electron 45, seen
// in a probe). webRequest does report it: onBeforeRequest, then the handler,
// then onErrorOccurred with net::ERR_ABORTED, all with the same request id.
// The handler gets no id, so each request's id is claimed in arrival order
// per URL, and an ERR_ABORTED for it aborts the read's own signal. The same
// details name the requesting tab (webContentsId), which the request itself
// does not either: Chromium sends no referrer to a non-standard scheme.
//
// Do not "simplify" this to `request.signal`: on the Electron we ship it is
// never aborted for a protocol.handle request, on navigation or on window
// close alike (probed on Electron 45 for #947). Revisit only once Electron
// aborts it, with a test in a real Electron process.
const unclaimedIds = new Map(); // url -> [{ id, webContentsId }], oldest first
const readControllers = new Map(); // webRequest id -> AbortController

function noteRadRequest(details) {
  if (!details?.url?.startsWith('rad:')) return null;
  const ids = unclaimedIds.get(details.url) || [];
  ids.push({ id: details.id, webContentsId: details.webContentsId });
  unclaimedIds.set(details.url, ids);
  return null;
}

function endRadRequest(details) {
  if (!details?.url?.startsWith('rad:')) return;
  const ids = unclaimedIds.get(details.url);
  if (ids) {
    const index = ids.findIndex((entry) => entry.id === details.id);
    if (index !== -1) ids.splice(index, 1);
    if (!ids.length) unclaimedIds.delete(details.url);
  }
  const controller = readControllers.get(details.id);
  readControllers.delete(details.id);
  if (controller && details.error === 'net::ERR_ABORTED') controller.abort();
}

// This read's signal, aborted when its page goes away, and its tab.
function claimRead(request) {
  const ids = unclaimedIds.get(request.url);
  const entry = ids?.shift();
  if (ids && !ids.length) unclaimedIds.delete(request.url);
  if (!entry) return { signal: request.signal, webContentsId: null, release: () => {} };
  const controller = new AbortController();
  readControllers.set(entry.id, controller);
  return {
    signal: controller.signal,
    webContentsId: entry.webContentsId ?? null,
    release: () => readControllers.delete(entry.id),
  };
}

// Who a read is counted against: its tab, within its session (each private
// window has its own session). Without a tab (a request webRequest did not
// attribute), the referrer's origin, else one bucket for the session.
function requesterKey(request, session, webContentsId) {
  if (webContentsId !== null && webContentsId !== undefined) return `${session}|tab:${webContentsId}`;
  let origin = '';
  try {
    const referrer = new URL(request.referrer);
    origin = referrer.host ? `${referrer.protocol}//${referrer.host}` : referrer.protocol;
  } catch {
    // No referrer
  }
  return `${session}|${origin}`;
}

// Same RID shape the request-rewriter enforces: z + base58btc.
const RID_RE = /^z[1-9A-HJ-NP-Za-km-z]{20,60}$/;

const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

/**
 * Validate a repo-relative path (leading slash included) against segment
 * tricks that would let `fetch`'s URL normalization climb out of the
 * `/api/v1/repos/rad:<rid>` scope. Returns true when safe to forward.
 */
function isSafeRepoPath(path) {
  return decodeRepoApiPath(path) !== null;
}

/**
 * Parse and validate `rad://<rid>/<path>?<q>` (or `rad:<rid>/<path>?<q>`).
 *
 * Returns one of:
 *  - `{ ok: true, rid, path }`         — safe native repository reference.
 *  - `{ ok: false, status, message, logMessage }` — semantic failure (403
 *    disabled). Neither names the requested repo, but
 *    both go through `redactedFailure` so the log site's fail-closed
 *    contract (see `handleRadRequest`) holds for any failure added later.
 *  - `null`                           — malformed input. Caller emits 400.
 */
function buildRadReference(radUrl) {
  if (isDisabledForProfile()) {
    return redactedFailure(403, () => 'Radicle is disabled for this profile');
  }

  if (typeof radUrl !== 'string' || !radUrl.startsWith('rad:')) return null;
  const remainder = radUrl.startsWith('rad://') ? radUrl.slice(6) : radUrl.slice(4);

  // Fragments are never sent by Chromium; split off the query untouched.
  const queryIndex = remainder.indexOf('?');
  const withoutQuery = queryIndex === -1 ? remainder : remainder.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : remainder.slice(queryIndex);

  const slashIndex = withoutQuery.indexOf('/');
  const rid = slashIndex === -1 ? withoutQuery : withoutQuery.slice(0, slashIndex);
  const path = slashIndex === -1 ? '' : withoutQuery.slice(slashIndex);

  if (!RID_RE.test(rid)) return null;
  if (!isSafeRepoPath(path)) return null;

  return {
    ok: true,
    rid: `rad:${rid}`,
    path,
    search,
  };
}

// JSON error body shaped like the bzz handler's so dweb error surfaces
// don't see schema drift between transports.
function jsonErrorResponse(status, message) {
  return new Response(JSON.stringify({ code: status, message }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Core handler, exported for testability. `fetchImpl` defaults to global
 * fetch but tests can inject a stub.
 */
async function handleRadRequest(request, { session = 'default' } = {}) {
  const method = (request.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return jsonErrorResponse(405, 'method not allowed');
  }

  const built = buildRadReference(request.url);
  if (!built) {
    return jsonErrorResponse(400, 'invalid rad reference');
  }
  if (!built.ok) {
    // Fail closed: only a failure's own log variant may reach the
    // persistent log — `message` is page-facing and may name the request.
    log.info(
      `[rad-protocol] ${built.status} for ${redactUrlForLog(request.url)}: ` +
        `${built.logMessage ?? redactForLog(built.message)}`
    );
    return jsonErrorResponse(built.status, built.message);
  }

  const { signal, webContentsId, release } = claimRead(request);
  try {
    return await admission.run(requesterKey(request, session, webContentsId), signal, () =>
      serveRepoApi(built.rid, built.path, {
        method,
        search: built.search,
        maxResponseChars: MAX_RESPONSE_CHARS,
      })
    );
  } catch (err) {
    if (err instanceof RadReadRefused) return jsonErrorResponse(err.status, err.message);
    // The page is gone; nobody reads this.
    if (err?.name === 'AbortError') return jsonErrorResponse(503, 'request cancelled');
    throw err;
  } finally {
    release();
  }
}

let trackerRegistered = false;

/**
 * Register the `rad:` protocol handler on the given session.
 * Call after `app.whenReady()`. The `rad` scheme must already have been
 * registered privileged (non-standard, supportFetchAPI) via
 * `protocol.registerSchemesAsPrivileged` before `app.ready` — see
 * `main/index.js`.
 */
function registerRadProtocol(targetSession, { privatePartition = null } = {}) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[rad-protocol] session.protocol.handle unavailable — skipping');
    return;
  }
  // PRIVATE MODE GUARD (request logging): see registerBzzProtocol — one
  // registration per session, so the private session's handler marks every
  // request it serves as private for the duration.
  const isPrivate = !!privatePartition;
  // Process-wide, like radapi's guard: every session that attaches the
  // dispatcher afterwards sees it (src/main/index.js orders it so).
  if (!trackerRegistered) {
    registerWebRequestHandler('onBeforeRequest', 'rad-read-tracker', noteRadRequest);
    registerWebRequestHandler('onCompleted', 'rad-read-tracker', endRadRequest);
    registerWebRequestHandler('onErrorOccurred', 'rad-read-tracker', endRadRequest);
    trackerRegistered = true;
  }
  try {
    const session = privatePartition || 'default';
    targetSession.protocol.handle('rad', (request) =>
      runWithPrivateLogContext(isPrivate, () => handleRadRequest(request, { session }))
    );
    log.info('[rad-protocol] handler registered');
  } catch (err) {
    log.error('[rad-protocol] failed to register handler:', err);
  }
}

module.exports = {
  registerRadProtocol,
  handleRadRequest,
  buildRadReference,
  noteRadRequest,
  endRadRequest,
  MAX_RESPONSE_CHARS,
};
