/**
 * A dweb plan is input to check, not permission to dial (freedom-core design
 * 0006, "Validation before any dial").
 *
 * `dweb.open` answers a `bzz:`, `ipfs:` or `ipns:` request with a plan: a
 * fetch (what main asks the node and how it treats the answer), a redirect
 * answered without a node, or an error. Main refuses a plan unless it passes
 * every check for its variant, against the request main admitted (its URL,
 * method and backend); a refused plan gets a 502 and is logged as a core
 * fault. The first failing check names the refusal, in this order:
 * `shape`, `method`, `node`, `path`, `header`, `retry`, `timers`,
 * `response`, `trust`, `redirect`, `error`.
 *
 * A fetch plan is also judged against the request's own plan, made again
 * here with main's copy of the core's planning (`dweb-open.js`), as the
 * core's `validate_plan` makes it with `open` (freedom-core#97). A hash host
 * (a Swarm reference, a CID, an IPNS key, a DNSLink name the node resolves
 * itself) needs no lookup: its plan must fetch exactly the target rebuilt
 * from the URL (`path`), and no name stands behind it, so its name label is
 * `null` (`trust`). A request that plans no fetch (a gateway-form URL, an
 * invalid host) gets none (`path`). Only a name host's target comes from
 * the core's resolution, and only it may carry a name label.
 *
 * This is fc-dweb's `validate_plan`, ported: both pass the design's vectors
 * (`vectors/dweb.json`, `validation`). Where it is stricter than today's
 * handlers, the design names the deviation: `plan-paths` (a target is judged
 * as decoded too, so no escape climbs out of `/<namespace>/<ref>`) and
 * `plan-headers` (header values are RFC 9110 field values).
 */

const { gatewayFormRedirect } = require('../ipfs/gateway-form');
const {
  openDweb,
  contentTrust,
  normalizeTarget,
  requestMethod,
  urlScheme,
  FORWARDED_REQUEST_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  SWARM_HEADERS,
} = require('./dweb-open');

/** Today's retry table is the most a plan may ask for. */
const RETRY_STATUSES = new Set([500, 502, 503, 504]);
const MAX_ATTEMPTS = 10;
const MAX_RETRY_DELAY_MS = 15_000;

/** Timer bounds: the native node's queue, `bzz:`'s and the native node's
 * header deadline, and the body idle bound (deviation `body-idle`). */
const MAX_QUEUE_MS = 15_000;
const MAX_HEADERS_MS = 30_000;
const MAX_BODY_IDLE_MS = 60_000;

/** The statuses an error plan may carry: today's. */
const ERROR_STATUSES = new Set([400, 404, 405, 415, 502, 503]);
/** An error plan's message, in UTF-16 code units: twice the URL bound. */
const MAX_MESSAGE_UNITS = 131_072;

/** A gateway-form redirect's only header besides `Location`. */
const REDIRECT_HEADERS = [['access-control-allow-origin', '*']];

/** The response operations each backend allows. */
const RESPONSE_OPERATIONS = {
  ant: new Set(['canonicalize_redirect', 'strip_page_state']),
  native: new Set(['strip_page_state', 'small_text']),
  gateway: new Set([
    'strip_decoded_encoding',
    'strip_page_state',
    'canonicalize_redirect',
    'small_text',
  ]),
};

const SCHEMES = new Set(['bzz', 'ipfs', 'ipns']);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** `{ ant: mode, up }` or `{ ipfs: mode, up }`: which node, in which mode. */
function backendKind(backend) {
  if (typeof backend?.ant === 'string') return 'ant';
  if (backend?.ipfs === 'native') return 'native';
  if (backend?.ipfs === 'gateway') return 'gateway';
  return null;
}

/** An object with exactly these keys. */
function exact(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** `[[name, value], …]`, all strings, or null. */
function stringPairs(value) {
  if (!Array.isArray(value)) return null;
  for (const pair of value) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== 'string' ||
      typeof pair[1] !== 'string'
    ) {
      return null;
    }
  }
  return value;
}

/** A whole number from `min` to `max`. */
function integerIn(value, min, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** `%2E`, `%2F` and `%5C`, in any case, decoded in one pass. */
function decodeDotsAndSeparators(path) {
  return path.replace(/%(2[eEfF]|5[cC])/g, (escape) => {
    const code = escape.slice(1).toLowerCase();
    if (code === '2e') return '.';
    if (code === '2f') return '/';
    return '\\';
  });
}

/**
 * The path judged as decoded, not only as serialized: once its dot and
 * separator escapes are decoded and `/` and `\` both separate, no segment is
 * `.` or `..`, and the path still begins with `/<namespace>/<reference>`. A
 * normalized path has no literal dot segments, so any found here came from
 * escapes. An encoded separator that doesn't climb (`a%2Fb`) passes.
 */
function staysBeneath(pathname, namespace, reference) {
  const segments = decodeDotsAndSeparators(pathname).split(/[/\\]/);
  return (
    segments[0] === '' &&
    segments[1] === namespace &&
    segments[2] === reference &&
    !segments.some((segment) => segment === '.' || segment === '..')
  );
}

/** The target: normalized, in the request's namespace, with a reference. */
function checkPath(path, scheme) {
  if (normalizeTarget(path) !== path) return false;
  const pathname = path.split('?')[0];
  const segments = pathname.split('/');
  if (segments.length < 3 || segments[0] !== '') return false;
  const [, namespace, reference] = segments;
  const ok =
    scheme === 'bzz'
      ? namespace === 'bzz' &&
        /^(?:[0-9a-fA-F]{64}|[0-9a-fA-F]{128})$/.test(reference) &&
        !/%(?:2f|5c)/i.test(pathname)
      : namespace === scheme && /^[A-Za-z0-9._-]+$/.test(reference);
  return ok && staysBeneath(pathname, namespace, reference);
}

/** RFC 9110 `tchar`, lowercase letters only. */
const isHeaderName = (name) => /^[a-z0-9!#$%&'*+\-.^_`|~]+$/.test(name);

/** An RFC 9110 field value: visible ASCII, spaces and tabs, and obs-text,
 * with no other control character and no space or tab at either end. */
const isHeaderValue = (value) =>
  /^[\t\x20-\x7e\x80-\xff]*$/.test(value) && !/^[ \t]|[ \t]$/.test(value);

function checkHeaders(headers, scheme) {
  if (!headers.every(([name, value]) => isHeaderName(name) && isHeaderValue(value))) return false;
  if (scheme !== 'bzz') {
    return !headers.some(([name]) => STRIPPED_REQUEST_HEADERS.has(name));
  }
  const allowed = headers.every(
    ([name]) => FORWARDED_REQUEST_HEADERS.has(name) || SWARM_HEADERS.has(name)
  );
  const swarm = [...SWARM_HEADERS].every(([swarmName, fixed]) => {
    const values = headers.filter(([name]) => name === swarmName);
    return values.length === 1 && values[0][1] === fixed;
  });
  return allowed && swarm;
}

function checkRetry(retry, kind) {
  const { statuses, on_error: onError, attempts, delays_ms: delays } = retry;
  if (!Array.isArray(statuses) || typeof onError !== 'boolean' || !Array.isArray(delays)) {
    return false;
  }
  if (!integerIn(attempts, 1, MAX_ATTEMPTS)) return false;
  const seen = new Set();
  for (const status of statuses) {
    if (!integerIn(status, 0, 999) || !RETRY_STATUSES.has(status) || seen.has(status)) {
      return false;
    }
    seen.add(status);
  }
  if (
    delays.length !== attempts - 1 ||
    !delays.every((delay) => integerIn(delay, 0, MAX_RETRY_DELAY_MS))
  ) {
    return false;
  }
  // IPFS has no retry today.
  return kind === 'ant' || (attempts === 1 && statuses.length === 0 && !onError);
}

function checkTimers(timers, kind) {
  const bounded = (value, max, nullOk) => (value === null ? nullOk : integerIn(value, 1, max));
  return (
    bounded(timers.queue_ms, MAX_QUEUE_MS, true) &&
    bounded(timers.headers_ms, MAX_HEADERS_MS, kind === 'gateway') &&
    bounded(timers.body_idle_ms, MAX_BODY_IDLE_MS, false)
  );
}

function checkResponse(response, kind) {
  const seen = new Set();
  for (const op of response) {
    if (typeof op !== 'string' || !RESPONSE_OPERATIONS.gateway.has(op)) return false;
    if (!RESPONSE_OPERATIONS[kind].has(op) || seen.has(op)) return false;
    seen.add(op);
  }
  return true;
}

/** The content label is the backend's; a name label only behind a lookup
 * (`named`): a hash host's is `null`. */
function checkTrust(trust, backend, named) {
  return (
    (trust.name === null || (named && typeof trust.name === 'string')) &&
    trust.content === contentTrust(backend)
  );
}

/**
 * What the request's host means for a fetch plan, as `dweb.open` plans the
 * request (`dweb-open.js`): a hash host's target (`{ named: false, target }`),
 * which depends on the URL alone; a name host (`{ named: true }`), whose
 * target comes from the name's resolution; or null when no fetch answers the
 * request (a gateway-form URL, an invalid host).
 */
function requestHost(request) {
  const opened = openDweb({ url: request.url, method: request.method, backend: request.backend });
  if (opened?.pending) return { named: true, target: null };
  if (opened?.fetch) return { named: false, target: opened.fetch.path };
  return null;
}

function checkFetch(body, request, scheme) {
  if (!exact(body, ['node', 'path', 'headers', 'retry', 'timers', 'response', 'trust'])) {
    return 'shape';
  }
  const headers = stringPairs(body.headers);
  if (
    typeof body.path !== 'string' ||
    !headers ||
    !exact(body.retry, ['statuses', 'on_error', 'attempts', 'delays_ms']) ||
    !exact(body.timers, ['queue_ms', 'headers_ms', 'body_idle_ms']) ||
    !Array.isArray(body.response) ||
    !exact(body.trust, ['name', 'content'])
  ) {
    return 'shape';
  }
  const method = requestMethod(request.method);
  if (method !== 'GET' && method !== 'HEAD') return 'method';
  const { backend } = request;
  const kind = backendKind(backend);
  // The node is the backend main admitted for the scheme, and it is up.
  const nodeOk =
    backend?.up === true &&
    ((body.node === 'ant' && scheme === 'bzz' && kind === 'ant') ||
      (body.node === 'ipfs' &&
        (scheme === 'ipfs' || scheme === 'ipns') &&
        (kind === 'native' || kind === 'gateway')));
  if (!nodeOk) return 'node';
  if (!checkPath(body.path, scheme)) return 'path';
  // A hash host needs no lookup: the target is the request's own, rebuilt
  // here, and no name stands behind it.
  const host = requestHost(request);
  if (!host || (!host.named && body.path !== host.target)) return 'path';
  if (!checkHeaders(headers, scheme)) return 'header';
  if (!checkRetry(body.retry, kind)) return 'retry';
  if (!checkTimers(body.timers, kind)) return 'timers';
  if (!checkResponse(body.response, kind)) return 'response';
  if (!checkTrust(body.trust, backend, host.named)) return 'trust';
  return null;
}

/** A 307 to the request's canonical `ipfs:` or `ipns:` form, with only
 * `Access-Control-Allow-Origin: *`. A backend that isn't up can redirect. */
function checkRedirect(body, request, scheme) {
  if (!exact(body, ['status', 'location', 'headers'])) return 'shape';
  if (scheme !== 'ipfs' && scheme !== 'ipns') return 'redirect';
  if (body.status !== 307) return 'redirect';
  const expected = gatewayFormRedirect(request.url)?.location;
  if (!expected || body.location !== expected) return 'redirect';
  const headers = stringPairs(body.headers);
  const same =
    headers?.length === REDIRECT_HEADERS.length &&
    headers.every(
      ([name, value], i) => name === REDIRECT_HEADERS[i][0] && value === REDIRECT_HEADERS[i][1]
    );
  return same ? null : 'redirect';
}

/** One of today's statuses, the same code, and a bounded message. */
function checkError(body) {
  if (!exact(body, ['status', 'code', 'message'])) return 'shape';
  const statusOk = typeof body.status === 'number' && ERROR_STATUSES.has(body.status);
  const messageOk = typeof body.message === 'string' && body.message.length <= MAX_MESSAGE_UNITS;
  return statusOk && body.code === body.status && messageOk ? null : 'error';
}

/**
 * Checks a plan, as main received it, against the request it answers.
 *
 * @param {unknown} plan - `dweb.open`'s `plan`
 * @param {{url: string, method?: string, backend: object}} request - as main
 *   admitted it; `backend` is the reference main sent (`{ ant | ipfs: mode, up }`)
 * @returns {string|null} the refusal, or null for a plan main may use
 */
function validatePlan(plan, request) {
  if (!isObject(plan)) return 'shape';
  const variants = Object.keys(plan);
  if (variants.length !== 1) return 'shape';
  const [variant] = variants;
  const scheme = urlScheme(request.url);
  const known = SCHEMES.has(scheme) ? scheme : null;
  if (variant === 'fetch') return checkFetch(plan.fetch, request, known);
  if (variant === 'redirect') return checkRedirect(plan.redirect, request, known);
  if (variant === 'error') return checkError(plan.error);
  return 'shape';
}

module.exports = {
  validatePlan,
  backendKind,
  contentTrust,
  normalizeTarget,
  requestMethod,
  urlScheme,
  FORWARDED_REQUEST_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  SWARM_HEADERS,
  MAX_MESSAGE_UNITS,
};
