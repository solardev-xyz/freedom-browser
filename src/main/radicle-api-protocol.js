/**
 * Embedded Radicle API serving — the repository-viewer API that Freedom
 * consumes, backed directly by the in-process node.
 *
 * Two consumers share `serveRepoApi`:
 *  - the `radapi:` scheme registered here, fetched by the internal
 *    rad-browser.html page (its `base` param becomes `radapi://local`);
 *  - the `rad:` scheme handler (radicle/rad-protocol.js), which serves
 *    dweb pages through the same native serving core.
 *
 * The two have deliberately different reach: `rad:` is public repo data
 * for any page, `radapi:` adds node-level endpoints and private repos and
 * is restricted to the internal viewer by an onBeforeRequest frame check
 * (guardRadicleApiRequest — see the note there on why the request itself
 * carries nothing trustworthy).
 *
 * Served repo endpoints:
 *   /                   → embedded node health/version
 *   /api/v1/stats       → node summary used by the Nodes panel
 *   /api/v1/repos       → locally seeded repositories
 *   (root)              → repo metadata used by the viewer
 *   /tree/SHA[/path]    → tree entries at the requested commit
 *   /blob/SHA/path      → blob content at the requested commit
 *   /readme/SHA         → root readme blob
 *   /commits?parent=SHA → paginated commit history
 *   /commits/SHA        → commit metadata and structured diff
 *   /stats/tree/SHA     → commit, branch, and contributor counts
 *   /remotes            → signed remote branch heads
 *   /issues[/ID]        → collaborative issue reads
 *   /patches[/ID]       → collaborative patch reads
 *
 * Revisions are full commit object IDs only. Refs and arbitrary revspecs
 * are deliberately rejected at this boundary.
 *
 * **On the freedom-radicled service** (`FREEDOM_RADICLE_BACKEND=service`,
 * development builds only; freedom-core design 0008, Main's side, "Reads
 * take admission and cancel", and "JSON results"), the same endpoints, with
 * the same paths, statuses and headers, read the service instead:
 * - **Admission:** each request takes a slot of main's dweb admission
 *   (dweb/fetch-admission.js: 256 active and 512 waiting, across sessions),
 *   fenced to its session, and holds it until its body is over: read to its
 *   end, failed, cancelled, idle past 60 s with a pull waiting, or its
 *   session closed. A full admission is a 503 at once (deviation
 *   `rad-admission`). `rad:` takes it in place of rad-read-admission.js,
 *   which stays the add-on's.
 * - **Streaming:** each endpoint is one `rad.read` (`serviceRoute`), passed
 *   through `callStream`: the response is built from its head and its body
 *   stream, so main holds one 128 KiB ring for it and nothing more. The
 *   request's abort, or its session's close, sends `cancel`, before the
 *   head or during the body. A `HEAD` cancels the body once the head has
 *   come. The node endpoints read collected values in a scope: `/` the
 *   `status`, `/api/v1/stats` the composed `node_info`; `rad:`'s
 *   visibility check reads `repo_info` the same way.
 * - **Statuses** (0008, Errors): 404 for `not_found`, 400 for
 *   `invalid_argument`, 413 for `too_large` (deviation `size-caps`), 503
 *   for `busy`, `stopped` and `quarantined`, 504 for `deadline` (deviation
 *   `read-deadline`); any other failure is 404 or 500 by today's message
 *   test. The listing's and the node endpoints' failures keep today's 500
 *   and 503.
 * - **Texts:** `rad:` answers main's fixed text for each failure, never the
 *   service's message, as it does the add-on's (#1050); `radapi:` keeps the
 *   message for the internal viewer. Logs redact as before.
 */

const log = require('./logger');
const embedded = require('./radicle-embedded');
const { isDisabledForProfile } = require('./radicle-manager');
const { radicleBackendKind } = require('./radicle/radicle-backend-kind');
const { acquireDwebFetch, fenceDwebSession, AdmissionFull } = require('./dweb/fetch-admission');
const { idleBoundBody } = require('./dweb/plan-executor');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');
const { runWithPrivateLogContext, redactForLog } = require('./private/private-log-context');
const { internalPageFileForUrl } = require('./ipc-sender-policy');

const RID_RE = /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/;
// Repo metadata reads in flight at once for the `/api/v1/repos` listing.
// Each is a libradicle call holding a libuv threadpool thread; an unbounded
// fan-out over every seeded repo queues them all at once, and async fs,
// dns.lookup, zlib and crypto across main wait behind the queue (#514).
const REPO_LIST_CONCURRENCY = 2;
const REVISION_RE = /^[0-9a-f]{40}$/;
const MISSING_RE = /not found|does not exist|NotFound/i;
// What `rad:` answers for a repository it will not serve, private or absent.
const REPO_NOT_FOUND = Object.freeze({ error: 'repository not found' });
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

// What `rad:` answers for any other add-on error: a fixed text for its
// category, never the add-on's own. libradicle's text for a repository that
// isn't stored names its storage path, `<radicle home>/storage/<rid>`, under
// the user's profile, and its storage and git errors can name files there
// too (#1050). The status is still decided on the add-on's text: 404 for
// MISSING_RE, 500 for the rest. The texts are freedom-radicled's where it
// has one (`not found`, `the read failed`).
const PUBLIC_READ_ERRORS = Object.freeze({
  missing: Object.freeze({ error: 'not found' }),
  tooLarge: Object.freeze({ error: 'repository data too large to serve here' }),
  cancelled: Object.freeze({ error: 'request cancelled' }),
  failed: Object.freeze({ error: 'the read failed' }),
});
// libradicle's texts for a read past one of its bounds (`TooLarge`,
// `TooDeep`), and for a cancelled one (`Cancelled`; `clone cancelled` in
// older add-ons).
const TOO_LARGE_RE =
  /^(?:\d+ bytes is over the limit of \d+|the tree is nested deeper than \d+ levels)$/;
const CANCELLED_RE = /^(?:clone )?cancelled$/;

function publicReadError(message, missing) {
  if (missing) return PUBLIC_READ_ERRORS.missing;
  if (TOO_LARGE_RE.test(message)) return PUBLIC_READ_ERRORS.tooLarge;
  if (CANCELLED_RE.test(message)) return PUBLIC_READ_ERRORS.cancelled;
  return PUBLIC_READ_ERRORS.failed;
}

// The one page allowed to reach `radapi:`. Unlike `rad:` — public repo
// data any dweb page may read — this scheme exposes node-level endpoints
// (health, peer counts, the full seeded-repo list) and repo reads that
// include PRIVATE repositories, so it is browser-internal surface.
//
// It cannot be gated on anything in the request: Chromium sends no
// `Origin` header to `protocol.handle` for a custom scheme, and does not
// enforce the CORS response headers we set on one either — a plain
// `fetch('radapi://local/api/v1/repos')` from any page reads the body.
// The initiating frame's URL, taken from the network layer before the
// handler runs, is the only value the main process can trust here.
//
// The match is ipc-sender-policy's exact one: the frame's resolved file
// path must sit directly in this checkout's (or this app.asar's)
// `renderer/pages` directory, never a suffix test. A local file saved as
// `…/src/renderer/pages/rad-browser.html` anywhere else on disk and opened
// as file:// is not the viewer (#662).
const INTERNAL_PAGE_FILE = 'rad-browser.html';

function isInternalPageUrl(rawUrl) {
  return internalPageFileForUrl(rawUrl) === INTERNAL_PAGE_FILE;
}

/**
 * onBeforeRequest guard: drop every `radapi:` request that was not made
 * by the internal repository viewer. Fails closed — a request with no
 * attributable frame (a popup, a service worker, main-frame navigation
 * typed into the address bar) is not the viewer and is cancelled.
 */
function guardRadicleApiRequest(details) {
  if (!details?.url?.startsWith('radapi:')) return null;
  if (isInternalPageUrl(details.frame?.url)) return null;
  log.warn('[radapi] Blocked a request from a frame that is not the internal repository viewer');
  return { cancel: true };
}

function json(body, status = 200, { cors = true } = {}) {
  return jsonText(JSON.stringify(body), status, { cors });
}

function jsonHeaders(cors) {
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return headers;
}

// `text` is JSON already — the addon's own output, passed through as is.
function jsonText(text, status = 200, { cors = true } = {}) {
  return new Response(text, {
    status,
    headers: jsonHeaders(cors),
  });
}

/**
 * `Promise.all(items.map(fn))` with at most `limit` calls of `fn` pending;
 * results keep the input order, and the first rejection rejects the whole.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const OVER_CAP = Symbol('over the cap');

/**
 * `JSON.stringify(value)` for the JSON data serveRepoApi replies with,
 * stopping once the text would pass `maxChars`: null then, before the rest
 * is built. A string is measured before it is escaped (its JSON form is at
 * least its length + 2), so one huge string never gets copied either.
 * Without a cap it is JSON.stringify.
 */
function boundedStringify(value, maxChars) {
  if (maxChars === null || maxChars === undefined) return JSON.stringify(value);
  const parts = [];
  let length = 0;
  const push = (text) => {
    length += text.length;
    if (length > maxChars) throw OVER_CAP;
    parts.push(text);
  };
  // A string's JSON form is at least its length + 2: refuse it unescaped.
  const quote = (text) => {
    if (length + text.length + 2 > maxChars) throw OVER_CAP;
    return JSON.stringify(text);
  };
  const resolve = (item, key) =>
    item !== null && typeof item === 'object' && typeof item.toJSON === 'function'
      ? item.toJSON(key)
      : item;
  // What JSON.stringify leaves out of an object, and writes as null in an array.
  const omitted = (item) =>
    item === undefined || typeof item === 'function' || typeof item === 'symbol';
  const write = (item) => {
    if (item === null) return push('null');
    switch (typeof item) {
      case 'string':
        return push(quote(item));
      case 'number':
        return push(Number.isFinite(item) ? String(item) : 'null');
      case 'boolean':
        return push(item ? 'true' : 'false');
      case 'bigint':
        return push(JSON.stringify(item)); // throws, as JSON.stringify does
      default:
        break;
    }
    if (Array.isArray(item)) {
      push('[');
      for (let index = 0; index < item.length; index += 1) {
        if (index > 0) push(',');
        const element = resolve(item[index], String(index));
        if (omitted(element)) push('null');
        else write(element);
      }
      return push(']');
    }
    push('{');
    let first = true;
    for (const name of Object.keys(item)) {
      const member = resolve(item[name], name);
      if (omitted(member)) continue;
      push(`${first ? '' : ','}${quote(name)}:`);
      first = false;
      write(member);
    }
    return push('}');
  };
  const top = resolve(value, '');
  if (omitted(top)) return undefined;
  try {
    write(top);
  } catch (err) {
    if (err === OVER_CAP) return null;
    throw err;
  }
  return parts.join('');
}

function withoutBody(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function serveNodeApi(pathname, { signal = null } = {}) {
  if (onService()) return serveServiceNodeApi(pathname, { signal });
  try {
    const status = await embedded.status();
    if (pathname === '/') {
      return json({
        version: status?.version || 'embedded',
        mode: 'embedded',
      }, 200, { cors: false });
    }
    const repos = await embedded.listRepos();
    return json({
      repos: { total: repos.length },
      peers: { connected: status?.connectedPeers ?? 0 },
    }, 200, { cors: false });
  } catch (err) {
    // PRIVATE MODE GUARD: a private session's registration marks this, and
    // the add-on's text can name its storage path (#1050).
    log.warn('[radapi] node status failed:', redactForLog(err.message));
    return json({ error: err.message }, 503, { cors: false });
  }
}

function decodeRepoApiPath(apiPath) {
  if (!apiPath) return [];
  if (!apiPath.startsWith('/') || apiPath.includes('\\')) return null;

  const raw = apiPath.slice(1).split('/');
  const decoded = [];
  for (let index = 0; index < raw.length; index += 1) {
    const segment = raw[index];
    if (segment === '') {
      if (index === raw.length - 1) continue;
      return null;
    }
    let value;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return null;
    }
    // Encoded separators are separators too; accepting them would bypass
    // segment-level traversal validation after decoding.
    // eslint-disable-next-line no-control-regex
    if (value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value)) {
      return null;
    }
    decoded.push(value);
  }
  return decoded;
}

function paginate(items, searchParams) {
  const params =
    searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || '');
  const status = params.get('status');
  const filtered = status ? items.filter((item) => item?.state?.status === status) : items;
  const page = Math.max(0, Number.parseInt(params.get('page') || '0', 10) || 0);
  const perPage = Math.min(
    100,
    Math.max(1, Number.parseInt(params.get('perPage') || '30', 10) || 30)
  );
  return filtered.slice(page * perPage, (page + 1) * perPage);
}

function pageParams(searchParams) {
  const params =
    searchParams instanceof URLSearchParams ? searchParams : new URLSearchParams(searchParams || '');
  return {
    page: Math.min(
      1_000_000,
      Math.max(0, Number.parseInt(params.get('page') || '0', 10) || 0)
    ),
    perPage: Math.min(
      100,
      Math.max(1, Number.parseInt(params.get('perPage') || '30', 10) || 30)
    ),
  };
}

/**
 * Serve one repo-scoped API path from the embedded node.
 * @param {string} rid - Full RID with rad: prefix (validated here)
 * @param {string} apiPath - Path under the repo root, e.g. '' or
 *   '/tree/<sha>/src' or '/blob/<sha>/README.md' (URL-encoded segments ok)
 * @param {object} [options]
 * @param {string|null} [options.partition] - on the service, a private
 *   session's partition, whose admission the read takes
 * @param {object|null} [options.admitted] - on the service, the request's
 *   admission (`serveAdmitted`'s `{ signal, stream }`), when its handler
 *   took it; without it, the read takes its own
 * @returns {Promise<Response>}
 */
async function serveRepoApi(
  rid,
  apiPath,
  {
    method = 'GET',
    search = '',
    allowPrivate = false,
    maxResponseChars = null,
    signal = null,
    partition = null,
    admitted = null,
  } = {}
) {
  if (onService()) {
    // The service streams what it serves, and caps it itself (deviation
    // `size-caps`): `maxResponseChars` is the add-on's bound.
    const serve = (life) =>
      serveServiceRepoApi(rid, apiPath, { method, search, allowPrivate, ...life });
    if (admitted) return serve(admitted);
    return serveAdmitted({ partition, signal }, serve, (status, message) =>
      json({ error: message }, status, { cors: !allowPrivate })
    );
  }
  return embedded.withReadBounds({ signal, maxReplyChars: maxResponseChars }, () =>
    serveBoundedRepoApi(rid, apiPath, { method, search, allowPrivate, maxResponseChars, signal })
  );
}

async function serveBoundedRepoApi(
  rid,
  apiPath,
  { method, search, allowPrivate, maxResponseChars, signal }
) {
  // `rad:` (public repos only, served to any dweb page) keeps the wildcard
  // ACAO; `radapi:` (allowPrivate: node-level and private-repo data, internal
  // viewer only) sends none. The frame guard is the real boundary there —
  // Chromium does not enforce CORS on custom schemes — but a private
  // response should not advertise itself as readable by any origin either
  // (docs/security-audit-electron.md, O-12).
  // `rad:` caps what it hands a page (R-3). An addon reply over the cap is
  // refused before it is parsed (radicle-embedded's read bounds), and a
  // composed reply stops serializing at the cap: either is a 502. The
  // add-on has already built its own string by then; R-18 bounds that.
  const tooLarge = (text) => maxResponseChars !== null && text.length > maxResponseChars;
  const tooLargeReply = () =>
    json({ error: 'repository data too large to serve here' }, 502, { cors: !allowPrivate });
  // The read has ended for its caller (R-3: gone, or out of time), who
  // reads nothing more: no serialization, no further addon call.
  const endedReply = () => json({ error: 'request cancelled' }, 503, { cors: !allowPrivate });
  const reply = (payload, status = 200) => {
    if (signal?.aborted) return endedReply();
    const text = boundedStringify(payload, maxResponseChars);
    return text === null ? tooLargeReply() : jsonText(text, status, { cors: !allowPrivate });
  };
  // Blob, readme, tree and commit reads are forwarded as the addon's JSON
  // text: a big file or diff is not parsed and re-stringified on main.
  const replyText = (text) => {
    if (signal?.aborted) return endedReply();
    return tooLarge(text) ? tooLargeReply() : jsonText(text, 200, { cors: !allowPrivate });
  };
  if (!RID_RE.test(rid)) {
    return reply({ error: 'invalid RID' }, 400);
  }
  const parts = decodeRepoApiPath(apiPath);
  if (!parts) return reply({ error: 'invalid repository path' }, 400);
  const section = parts[0] || null;
  const revision = parts[1];

  try {
    if (!allowPrivate) {
      // A private repository answers exactly as one that is not stored: the
      // same status and body. A 403 for private beside a 404 for absent let
      // any page test whether a private RID is on this node (R-2).
      let info;
      try {
        info = await embedded.repoInfo(rid);
      } catch (err) {
        if (MISSING_RE.test(err.message)) return reply(REPO_NOT_FOUND, 404);
        throw err;
      }
      if (info?.visibility?.type !== 'public') {
        return reply(REPO_NOT_FOUND, 404);
      }
    }
    // Every addon call checks the read's signal first (withReadBounds);
    // this one makes the visibility read's end the read's end too, before
    // any section's call.
    if (signal?.aborted) return endedReply();
    let response;
    if (!section) {
      response = reply(await embedded.buildRepoMeta(rid));
    } else {
      switch (section) {
        case 'tree':
          response = REVISION_RE.test(revision || '')
            ? replyText(await embedded.treeAtRaw(rid, revision, parts.slice(2).join('/')))
            : reply({ error: 'missing revision' }, 400);
          break;
        case 'blob': {
          const blobPath = parts.slice(2).join('/');
          response =
            REVISION_RE.test(revision || '') && blobPath
              ? replyText(await embedded.blobAtRaw(rid, revision, blobPath))
              : reply({ error: 'missing path' }, 400);
          break;
        }
        case 'readme': {
          if (!REVISION_RE.test(revision || '')) {
            response = reply({ error: 'missing revision' }, 400);
          } else {
            const readme = await embedded.readmeAtRaw(rid, revision);
            response = readme ? replyText(readme) : reply({ error: 'no readme' }, 404);
          }
          break;
        }
        case 'commits': {
          if (parts.length > 2) return reply({ error: 'invalid commit path' }, 400);
          if (revision) {
            response = REVISION_RE.test(revision)
              ? replyText(await embedded.commitRaw(rid, revision))
              : reply({ error: 'invalid revision' }, 400);
          } else {
            const params =
              search instanceof URLSearchParams
                ? search
                : new URLSearchParams(search || '');
            const parent = params.get('parent');
            if (!REVISION_RE.test(parent || '')) {
              response = reply({ error: 'missing parent revision' }, 400);
            } else {
              const { page, perPage } = pageParams(params);
              response = replyText(await embedded.commitsRaw(rid, parent, page, perPage));
            }
          }
          break;
        }
        case 'stats':
          response =
            parts[1] === 'tree' && REVISION_RE.test(parts[2] || '')
              ? reply(await embedded.repoStats(rid, parts[2]))
              : reply({ error: 'invalid stats path' }, 400);
          break;
        case 'remotes':
          response = reply(await embedded.remotes(rid));
          break;
        case 'issues':
          if (parts.length > 2) return reply({ error: 'invalid issue path' }, 400);
          response = parts[1]
            ? reply(await embedded.issue(rid, parts[1]))
            : reply(paginate(await embedded.issues(rid), search));
          break;
        case 'patches':
          if (parts.length > 2) return reply({ error: 'invalid patch path' }, 400);
          response = parts[1]
            ? reply(await embedded.patch(rid, parts[1]))
            : reply(paginate(await embedded.patches(rid), search));
          break;
        default:
          response = reply({ error: `unsupported endpoint: ${section}` }, 404);
      }
    }
    return method === 'HEAD' ? withoutBody(response) : response;
  } catch (err) {
    if (err instanceof embedded.ReadEnded) return endedReply();
    if (err instanceof embedded.ReplyTooLarge) {
      return method === 'HEAD' ? withoutBody(tooLargeReply()) : tooLargeReply();
    }
    const missing = MISSING_RE.test(err.message);
    if (!missing) {
      // PRIVATE MODE GUARD: this core serves both `rad:` and `radapi:`, and
      // both registrations mark private sessions — the RID, the repo path
      // and the error text (which quotes them) must never reach main.log
      // for a private window.
      log.warn('[radapi]', redactForLog(rid), redactForLog(apiPath), '→', redactForLog(err.message));
    }
    // `radapi:` keeps the add-on's text: its replies reach the internal
    // viewer only (guardRadicleApiRequest). `rad:` replies to any page.
    const body = allowPrivate ? { error: err.message } : publicReadError(err.message, missing);
    return reply(body, missing ? 404 : 500);
  }
}

// ---- on the freedom-radicled service (freedom-core design 0008) ----

const onService = () => radicleBackendKind() === 'service';

/** How long a pull on a service body may wait for bytes before the body
 * fails as truncated (0008, Main's side: "the blob and JSON bodies are
 * 0007's pull-driven streams, with idle bounds"; 0006's body idle). A
 * paused body, which asks for nothing, is never timed out. */
const BODY_IDLE_MS = 60_000;

const NO_README = 'no readme';
const REQUEST_CANCELLED = 'request cancelled';
const RADICLE_BUSY = 'Radicle is busy; try again';
const NODE_NOT_RUNNING = 'the Radicle node is not running';
const READ_TIMED_OUT = 'Radicle read timed out';

// The service's own texts for `stopped` (freedom-radicled's reads and
// pools): fixed, naming nothing a request didn't, so `rad:` may answer with
// them as main's own. Any other `stopped` text is answered NODE_NOT_RUNNING.
const SERVICE_STOPPED_TEXTS = new Set([
  'the repository is being repaired',
  "a write to the repository is under way, and its outcome isn't proven yet",
  NODE_NOT_RUNNING,
  'the Radicle service is stopping',
]);

/** What `rad:` answers for a read refused or failed on the service, by its
 * code: main's fixed texts (#1050), as for the add-on. */
const SERVICE_PUBLIC_ERRORS = Object.freeze({
  invalid: Object.freeze({ error: 'invalid request' }),
  busy: Object.freeze({ error: RADICLE_BUSY }),
  notRunning: Object.freeze({ error: NODE_NOT_RUNNING }),
  quarantined: Object.freeze({
    error: "the repository is quarantined: Radicle couldn't repair it",
  }),
  timedOut: Object.freeze({ error: READ_TIMED_OUT }),
});

/**
 * One `rad:` or `radapi:` request's admission on the service (0008, Main's
 * side: "Reads take admission and cancel"; deviation `rad-admission`).
 *
 * The request is fenced to its session, then takes a slot of main's dweb
 * admission (dweb/fetch-admission.js), the one the `bzz:`, `ipfs:` and
 * `ipns:` fetches take. `serve({ signal, stream })` then answers it:
 * `signal` aborts with the request (`signal`) or its session's close, and
 * cancels the reads it is given to; `stream(body)` hands a service body to
 * the response, bounded by BODY_IDLE_MS while a pull waits, and failed when
 * the session closes. The slot and the fence are held until the body is
 * over (read to its end, failed, cancelled, idle or stopped), or, for an
 * answer without one, until it is made. `onEnd` runs once then.
 *
 * A full admission is `refuse(503, …)` at once; a request whose session has
 * closed, or that is aborted while it waits, `refuse(503, 'request
 * cancelled')`, for nobody.
 */
async function serveAdmitted(
  { partition = null, signal = null, onEnd = null } = {},
  serve,
  refuse
) {
  let fence;
  try {
    fence = fenceDwebSession(partition);
  } catch {
    onEnd?.();
    return refuse(503, REQUEST_CANCELLED);
  }
  const life = signal ? AbortSignal.any([signal, fence.signal]) : fence.signal;
  let slot;
  try {
    slot = await acquireDwebFetch({ partition, signal: life });
  } catch (err) {
    fence.dispose();
    onEnd?.();
    return refuse(503, err instanceof AdmissionFull ? RADICLE_BUSY : REQUEST_CANCELLED);
  }
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    slot.release();
    fence.dispose();
    onEnd?.();
  };
  let streamed = null;
  const stream = (body) => {
    streamed = idleBoundBody(body, BODY_IDLE_MS, fence.signal, () => finish());
    return streamed;
  };
  try {
    const response = await serve({ signal: life, stream });
    if (!streamed) finish();
    return response;
  } catch (err) {
    streamed?.cancel().catch(() => {});
    finish();
    throw err;
  }
}

/**
 * The `rad.read` behind a repository path (0008, "JSON results": every
 * export's route), as serveBoundedRepoApi reads the add-on for it:
 * `{ op, args }`, or the refusal main answers itself, `{ refusal: { status,
 * body }, early }` (`early`: answered as is, even to a HEAD, as today).
 */
function serviceRoute(rid, parts, search) {
  const section = parts[0] || null;
  const revision = parts[1];
  const refuse = (error, status = 400, early = false) => ({
    refusal: { status, body: { error } },
    early,
  });
  const params = () =>
    search instanceof URLSearchParams ? search : new URLSearchParams(search || '');
  // The page ops' `status`, `page` and `per_page`: the raw query strings,
  // or null, which the service reads as main's `paginate` does.
  const page = () => {
    const query = params();
    return { status: query.get('status'), page: query.get('page'), per_page: query.get('perPage') };
  };
  if (!section) return { op: 'repo_meta', args: { rid } };
  switch (section) {
    case 'tree':
      return REVISION_RE.test(revision || '')
        ? { op: 'tree_at', args: { rid, revision, path: parts.slice(2).join('/') } }
        : refuse('missing revision');
    case 'blob': {
      const blobPath = parts.slice(2).join('/');
      return REVISION_RE.test(revision || '') && blobPath
        ? { op: 'blob_at', args: { rid, revision, path: blobPath } }
        : refuse('missing path');
    }
    case 'readme':
      return REVISION_RE.test(revision || '')
        ? { op: 'readme_at', args: { rid, revision } }
        : refuse('missing revision');
    case 'commits': {
      if (parts.length > 2) return refuse('invalid commit path', 400, true);
      if (revision) {
        return REVISION_RE.test(revision)
          ? { op: 'commit', args: { rid, revision } }
          : refuse('invalid revision');
      }
      const query = params();
      const parent = query.get('parent');
      if (!REVISION_RE.test(parent || '')) return refuse('missing parent revision');
      const { page: number, perPage } = pageParams(query);
      return { op: 'commits', args: { rid, parent, page: number, per_page: perPage } };
    }
    case 'stats':
      return parts[1] === 'tree' && REVISION_RE.test(parts[2] || '')
        ? { op: 'repo_stats', args: { rid, revision: parts[2] } }
        : refuse('invalid stats path');
    case 'remotes':
      return { op: 'remotes', args: { rid } };
    case 'issues':
      if (parts.length > 2) return refuse('invalid issue path', 400, true);
      return parts[1]
        ? { op: 'issue', args: { rid, issue_id: parts[1] } }
        : { op: 'issues_page', args: { rid, ...page() } };
    case 'patches':
      if (parts.length > 2) return refuse('invalid patch path', 400, true);
      return parts[1]
        ? { op: 'patch', args: { rid, patch_id: parts[1] } }
        : { op: 'patches_page', args: { rid, ...page() } };
    default:
      return refuse(`unsupported endpoint: ${section}`, 404);
  }
}

/**
 * The HTTP status for a read the service refused or failed (0008, Errors):
 * by its code, and otherwise by today's message test. Besides the
 * service's codes: `radicle_unavailable` and `stale_generation`, the
 * service not there to read from or its generation ended under the read
 * (radicled-client.js), are 503; `timeout`, main's watchdog past the read's
 * deadline to its head (0008, Deadlines), is 504.
 */
function serviceStatus(err) {
  switch (err?.code) {
    case 'not_found':
      return 404;
    case 'invalid_argument':
      return 400;
    case 'too_large':
      return 413;
    case 'busy':
    case 'stopped':
    case 'quarantined':
    case 'cancelled':
    case 'radicle_unavailable':
    case 'stale_generation':
      return 503;
    case 'deadline':
    case 'timeout':
      return 504;
    default:
      return MISSING_RE.test(String(err?.message ?? '')) ? 404 : 500;
  }
}

/** What `rad:` answers for `err` with `status`: main's fixed text, never
 * the service's (see SERVICE_PUBLIC_ERRORS). */
function servicePublicError(err, status, op) {
  const message = String(err?.message ?? '');
  switch (status) {
    case 400:
      return SERVICE_PUBLIC_ERRORS.invalid;
    case 404:
      // readme_at's own not-found: the text main answered itself.
      return op === 'readme_at' && message === NO_README
        ? { error: NO_README }
        : PUBLIC_READ_ERRORS.missing;
    case 413:
      return PUBLIC_READ_ERRORS.tooLarge;
    case 503:
      if (err?.code === 'busy') return SERVICE_PUBLIC_ERRORS.busy;
      if (err?.code === 'cancelled') return PUBLIC_READ_ERRORS.cancelled;
      if (err?.code === 'quarantined') return SERVICE_PUBLIC_ERRORS.quarantined;
      if (err?.code === 'stopped' && SERVICE_STOPPED_TEXTS.has(message)) return { error: message };
      return SERVICE_PUBLIC_ERRORS.notRunning;
    case 504:
      return SERVICE_PUBLIC_ERRORS.timedOut;
    default:
      return publicReadError(message, false);
  }
}

/** serveRepoApi on the service: one `rad.read`, streamed (see the module's
 * doc). `signal` and `stream` are the request's admission's. */
async function serveServiceRepoApi(rid, apiPath, { method, search, allowPrivate, signal, stream }) {
  const cors = !allowPrivate;
  const reply = (payload, status = 200) => json(payload, status, { cors });
  if (!RID_RE.test(rid)) return reply({ error: 'invalid RID' }, 400);
  const parts = decodeRepoApiPath(apiPath);
  if (!parts) return reply({ error: 'invalid repository path' }, 400);
  const route = serviceRoute(rid, parts, search);
  const read = { signal, admitted: true };
  // The op being read, for its failure's text.
  let reading = 'repo_info';
  try {
    if (!allowPrivate) {
      // A private repository answers exactly as one that isn't stored (R-2).
      let visible;
      try {
        visible = await embedded.callScoped(
          'repo_info',
          { rid },
          async (info) => info?.visibility?.type === 'public',
          read
        );
      } catch (err) {
        if (serviceStatus(err) === 404) return reply(REPO_NOT_FOUND, 404);
        throw err;
      }
      if (!visible) return reply(REPO_NOT_FOUND, 404);
    }
    if (route.refusal) {
      const refused = reply(route.refusal.body, route.refusal.status);
      return method === 'HEAD' && !route.early ? withoutBody(refused) : refused;
    }
    reading = route.op;
    const { body } = await embedded.callStream(route.op, route.args, read);
    // The page has gone, or its session closed, as the head came.
    if (signal?.aborted || method === 'HEAD') {
      body.cancel().catch(() => {});
      if (signal?.aborted) return reply(PUBLIC_READ_ERRORS.cancelled, 503);
      return new Response(null, { status: 200, headers: jsonHeaders(cors) });
    }
    return new Response(stream(body), { status: 200, headers: jsonHeaders(cors) });
  } catch (err) {
    const status = serviceStatus(err);
    if (status !== 404 && err?.code !== 'cancelled') {
      // PRIVATE MODE GUARD: as on the add-on — the RID, the repo path and
      // the error text never reach main.log for a private window.
      log.warn(
        '[radapi]',
        redactForLog(rid),
        redactForLog(apiPath),
        '→',
        redactForLog(err?.message)
      );
    }
    // `radapi:` keeps the service's text, for the internal viewer only;
    // `rad:` replies to any page. A cancelled read's answer goes to nobody.
    let body;
    if (err?.code === 'cancelled') body = PUBLIC_READ_ERRORS.cancelled;
    else if (allowPrivate) body = { error: err?.message };
    else body = servicePublicError(err, status, reading);
    return reply(body, status);
  }
}

/** serveNodeApi on the service: `/` from the collected `status`, and
 * `/api/v1/stats` from the composed `node_info` (0008, "JSON results"),
 * each used in its scope. A failure is a 503, as today, with its text: only
 * the internal viewer reads `radapi:`. */
async function serveServiceNodeApi(pathname, { signal }) {
  const read = { signal, admitted: true };
  const failed = (message) => {
    // PRIVATE MODE GUARD: as on the add-on (#1050).
    log.warn('[radapi] node status failed:', redactForLog(message));
    return json({ error: message }, 503, { cors: false });
  };
  try {
    if (pathname === '/') {
      const version = await embedded.callScoped(
        'status',
        {},
        async (status) => status?.version || 'embedded',
        read
      );
      return json({ version, mode: 'embedded' }, 200, { cors: false });
    }
    // `repos_total` is null when the service couldn't list the
    // repositories, with why in `repos_error`: the endpoint needs the count.
    const counts = await embedded.callScoped(
      'node_info',
      {},
      async (info) => ({
        total: Number.isSafeInteger(info?.repos_total) ? info.repos_total : null,
        error:
          typeof info?.repos_error === 'string'
            ? info.repos_error
            : 'the repository count is missing',
        connected: info?.connected_peers ?? 0,
      }),
      read
    );
    if (counts.total === null) return failed(counts.error);
    return json({ repos: { total: counts.total }, peers: { connected: counts.connected } }, 200, {
      cors: false,
    });
  } catch (err) {
    return failed(err?.message);
  }
}

/** The statuses the listing answers as they are; any other failure fails
 * it 500, as today. */
const LISTING_REFUSALS = new Set([413, 503, 504]);

/** The `/api/v1/repos` listing on the service: the composed `repos_meta`,
 * streamed. Its failure is today's 500 with the text, unless the service
 * refused it (413, 503, 504). */
async function serveServiceRepoList({ method, signal, stream }) {
  try {
    const { body } = await embedded.callStream('repos_meta', {}, { signal, admitted: true });
    if (signal?.aborted || method === 'HEAD') {
      body.cancel().catch(() => {});
      if (signal?.aborted) return json(PUBLIC_READ_ERRORS.cancelled, 503, { cors: false });
      return new Response(null, { status: 200, headers: jsonHeaders(false) });
    }
    return new Response(stream(body), { status: 200, headers: jsonHeaders(false) });
  } catch (err) {
    const status = serviceStatus(err);
    if (err?.code !== 'cancelled') {
      // PRIVATE MODE GUARD: as on the add-on; the text can name a RID.
      log.warn('[radapi] repository listing failed:', redactForLog(err?.message));
    }
    const body = err?.code === 'cancelled' ? PUBLIC_READ_ERRORS.cancelled : { error: err?.message };
    return json(body, LISTING_REFUSALS.has(status) ? status : 500, { cors: false });
  }
}

/**
 * Handles one `radapi:` request. `partition` is a private session's: on the
 * service, its reads take that session's admission.
 */
async function handleRadicleApiRequest(request, { partition = null } = {}) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return json({ error: 'invalid URL' }, 400, { cors: false });
  }

  if (isDisabledForProfile()) {
    return json({ error: 'Radicle is disabled for this profile' }, 403, { cors: false });
  }
  const method = (request.method || 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    return json({ error: 'method not allowed' }, 405, { cors: false });
  }
  // Second layer behind guardRadicleApiRequest, which is what actually
  // keeps web content out. Chromium attributes some requests with a
  // referrer and some with nothing at all (the internal viewer's own
  // fetches carry none — referrers from `file:` origins are suppressed),
  // so an absent referrer cannot be a rejection; a referrer naming some
  // other document can be, and is.
  const referrer = request.referrer;
  if (referrer && referrer !== 'about:client' && !isInternalPageUrl(referrer)) {
    return json({ error: 'radapi is restricted to internal pages' }, 403, { cors: false });
  }

  // On the service, each read takes the request's admission, for its whole
  // life (see the module's doc).
  const signal = request.signal ?? null;
  const admit = (serve) =>
    onService()
      ? serveAdmitted({ partition, signal }, serve, (status, message) =>
          json({ error: message }, status, { cors: false })
        )
      : serve({ signal: null, stream: null });

  if (url.pathname === '/' || url.pathname === '/api/v1/stats') {
    return admit(async (life) => {
      const response = await serveNodeApi(url.pathname, life);
      return method === 'HEAD' ? withoutBody(response) : response;
    });
  }

  // radapi://local/api/v1/repos/<rid>[/section...]
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'repos') {
    return json({ error: 'not found' }, 404, { cors: false });
  }
  if (!parts[3] && onService()) {
    return admit((life) => serveServiceRepoList({ method, ...life }));
  }
  if (!parts[3]) {
    try {
      const repos = await embedded.listRepos();
      const response = json(
        await mapWithConcurrency(repos, REPO_LIST_CONCURRENCY, ({ rid }) =>
          embedded.buildRepoMeta(rid)
        ),
        200,
        { cors: false }
      );
      return method === 'HEAD' ? withoutBody(response) : response;
    } catch (err) {
      // PRIVATE MODE GUARD: as for node status; the text can name a RID.
      log.warn('[radapi] repository listing failed:', redactForLog(err.message));
      return json({ error: err.message }, 500, { cors: false });
    }
  }
  let rid;
  try {
    rid = decodeURIComponent(parts[3]);
  } catch {
    return json({ error: 'invalid RID encoding' }, 400, { cors: false });
  }
  const apiPath = parts.length > 4 ? `/${parts.slice(4).join('/')}` : '';
  return serveRepoApi(rid, apiPath, {
    method,
    search: url.searchParams,
    allowPrivate: true,
    // The add-on's reads take no admission and no abort here, as before.
    ...(onService() ? { signal, partition } : {}),
  });
}

let guardRegistered = false;

/**
 * Register the radapi: handler on the given session. The scheme must have
 * been declared in `protocol.registerSchemesAsPrivileged` at startup.
 *
 * Also installs the frame guard, once — the dispatcher's handler registry
 * is process-wide, and every session that attaches the dispatcher picks it
 * up. Must therefore run before `attachWebRequestDispatcher()` for the
 * session, which is how src/main/index.js orders it.
 */
function registerRadicleApiProtocol(targetSession, { privatePartition = null } = {}) {
  if (!targetSession?.protocol?.handle) {
    log.warn('[radapi] session.protocol.handle unavailable — skipping');
    return;
  }
  if (!guardRegistered) {
    registerWebRequestHandler('onBeforeRequest', 'radapi-guard', guardRadicleApiRequest, {
      failClosed: true,
    });
    guardRegistered = true;
  }
  // PRIVATE MODE GUARD (request logging): same contract as registerRadProtocol
  // — one registration per session, so the private session's handler marks
  // every request it serves as private and the shared `serveRepoApi` log
  // sites redact the RID and repo path they would otherwise persist.
  const isPrivate = !!privatePartition;
  targetSession.protocol.handle('radapi', (request) =>
    runWithPrivateLogContext(isPrivate, () =>
      handleRadicleApiRequest(request, { partition: privatePartition })
    )
  );
  log.info('[radapi] Protocol handler registered');
}

module.exports = {
  registerRadicleApiProtocol,
  handleRadicleApiRequest,
  guardRadicleApiRequest,
  serveRepoApi,
  decodeRepoApiPath,
  mapWithConcurrency,
  boundedStringify,
  REPO_LIST_CONCURRENCY,
  // On the service.
  serveAdmitted,
  serviceRoute,
  BODY_IDLE_MS,
};
