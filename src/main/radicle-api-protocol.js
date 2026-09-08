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
 */

const log = require('./logger');
const embedded = require('./radicle-embedded');
const { isDisabledForProfile } = require('./radicle-manager');
const { registerWebRequestHandler } = require('./webrequest-dispatcher');
const { runWithPrivateLogContext, redactForLog } = require('./private/private-log-context');

const RID_RE = /^rad:z[1-9A-HJ-NP-Za-km-z]{20,60}$/;
const REVISION_RE = /^[0-9a-f]{40}$/;
const ALLOWED_METHODS = new Set(['GET', 'HEAD']);

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
const INTERNAL_PAGE_SUFFIX = '/src/renderer/pages/rad-browser.html';

function isInternalPageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'file:') return false;
    return decodeURIComponent(parsed.pathname).replace(/\\/g, '/').endsWith(INTERNAL_PAGE_SUFFIX);
  } catch {
    return false;
  }
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
  const headers = { 'Content-Type': 'application/json' };
  if (cors) headers['Access-Control-Allow-Origin'] = '*';
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function withoutBody(response) {
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function serveNodeApi(pathname) {
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
    log.warn('[radapi] node status failed:', err.message);
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
 * @returns {Promise<Response>}
 */
async function serveRepoApi(
  rid,
  apiPath,
  { method = 'GET', search = '', allowPrivate = false } = {}
) {
  if (!RID_RE.test(rid)) {
    return json({ error: 'invalid RID' }, 400);
  }
  const parts = decodeRepoApiPath(apiPath);
  if (!parts) return json({ error: 'invalid repository path' }, 400);
  const section = parts[0] || null;
  const revision = parts[1];

  try {
    if (!allowPrivate) {
      const info = await embedded.repoInfo(rid);
      if (info?.visibility?.type !== 'public') {
        return json({ error: 'repository is not public' }, 403);
      }
    }
    let response;
    if (!section) {
      response = json(await embedded.buildRepoMeta(rid));
    } else {
      switch (section) {
        case 'tree':
          response = REVISION_RE.test(revision || '')
            ? json(await embedded.treeAt(rid, revision, parts.slice(2).join('/')))
            : json({ error: 'missing revision' }, 400);
          break;
        case 'blob': {
          const blobPath = parts.slice(2).join('/');
          response =
            REVISION_RE.test(revision || '') && blobPath
              ? json(await embedded.blobAt(rid, revision, blobPath))
              : json({ error: 'missing path' }, 400);
          break;
        }
        case 'readme': {
          if (!REVISION_RE.test(revision || '')) {
            response = json({ error: 'missing revision' }, 400);
          } else {
            const readme = await embedded.readmeAt(rid, revision);
            response = readme ? json(readme) : json({ error: 'no readme' }, 404);
          }
          break;
        }
        case 'commits': {
          if (parts.length > 2) return json({ error: 'invalid commit path' }, 400);
          if (revision) {
            response = REVISION_RE.test(revision)
              ? json(await embedded.commit(rid, revision))
              : json({ error: 'invalid revision' }, 400);
          } else {
            const params =
              search instanceof URLSearchParams
                ? search
                : new URLSearchParams(search || '');
            const parent = params.get('parent');
            if (!REVISION_RE.test(parent || '')) {
              response = json({ error: 'missing parent revision' }, 400);
            } else {
              const { page, perPage } = pageParams(params);
              response = json(await embedded.commits(rid, parent, page, perPage));
            }
          }
          break;
        }
        case 'stats':
          response =
            parts[1] === 'tree' && REVISION_RE.test(parts[2] || '')
              ? json(await embedded.repoStats(rid, parts[2]))
              : json({ error: 'invalid stats path' }, 400);
          break;
        case 'remotes':
          response = json(await embedded.remotes(rid));
          break;
        case 'issues':
          if (parts.length > 2) return json({ error: 'invalid issue path' }, 400);
          response = parts[1]
            ? json(await embedded.issue(rid, parts[1]))
            : json(paginate(await embedded.issues(rid), search));
          break;
        case 'patches':
          if (parts.length > 2) return json({ error: 'invalid patch path' }, 400);
          response = parts[1]
            ? json(await embedded.patch(rid, parts[1]))
            : json(paginate(await embedded.patches(rid), search));
          break;
        default:
          response = json({ error: `unsupported endpoint: ${section}` }, 404);
      }
    }
    return method === 'HEAD' ? withoutBody(response) : response;
  } catch (err) {
    const missing = /not found|does not exist|NotFound/i.test(err.message);
    if (!missing) {
      // PRIVATE MODE GUARD: this core serves both `rad:` and `radapi:`, and
      // both registrations mark private sessions — the RID, the repo path
      // and the error text (which quotes them) must never reach main.log
      // for a private window.
      log.warn('[radapi]', redactForLog(rid), redactForLog(apiPath), '→', redactForLog(err.message));
    }
    return json({ error: err.message }, missing ? 404 : 500);
  }
}

async function handleRadicleApiRequest(request) {
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

  if (url.pathname === '/' || url.pathname === '/api/v1/stats') {
    const response = await serveNodeApi(url.pathname);
    return method === 'HEAD' ? withoutBody(response) : response;
  }

  // radapi://local/api/v1/repos/<rid>[/section...]
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'repos') {
    return json({ error: 'not found' }, 404, { cors: false });
  }
  if (!parts[3]) {
    try {
      const repos = await embedded.listRepos();
      const response = json(
        await Promise.all(repos.map(({ rid }) => embedded.buildRepoMeta(rid))),
        200,
        { cors: false }
      );
      return method === 'HEAD' ? withoutBody(response) : response;
    } catch (err) {
      log.warn('[radapi] repository listing failed:', err.message);
      return json({ error: err.message }, 500, { cors: false });
    }
  }
  let rid;
  try {
    rid = decodeURIComponent(parts[3]);
  } catch {
    return json({ error: 'invalid RID encoding' }, 400);
  }
  const apiPath = parts.length > 4 ? `/${parts.slice(4).join('/')}` : '';
  return serveRepoApi(rid, apiPath, {
    method,
    search: url.searchParams,
    allowPrivate: true,
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
    registerWebRequestHandler('onBeforeRequest', 'radapi-guard', guardRadicleApiRequest);
    guardRegistered = true;
  }
  // PRIVATE MODE GUARD (request logging): same contract as registerRadProtocol
  // — one registration per session, so the private session's handler marks
  // every request it serves as private and the shared `serveRepoApi` log
  // sites redact the RID and repo path they would otherwise persist.
  const isPrivate = !!privatePartition;
  targetSession.protocol.handle('radapi', (request) =>
    runWithPrivateLogContext(isPrivate, () => handleRadicleApiRequest(request))
  );
  log.info('[radapi] Protocol handler registered');
}

module.exports = {
  registerRadicleApiProtocol,
  handleRadicleApiRequest,
  guardRadicleApiRequest,
  serveRepoApi,
  decodeRepoApiPath,
};
