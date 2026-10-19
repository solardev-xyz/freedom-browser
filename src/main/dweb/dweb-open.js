/**
 * `dweb.open`'s planning up to any lookup: fc-dweb's `open` (freedom-core
 * design 0006), ported. A request becomes a plan (a fetch, a redirect or an
 * error) or, for a name host, `{ pending }`: the name to resolve and what
 * its plan needs once it is.
 *
 * The core plans every request main serves. Main plans with this copy only
 * to check the core's plans, as the core's `validate_plan` re-plans with
 * its own `open` (`plan-validation.js`): a hash host (a Swarm reference, a
 * CID, an IPNS key, a DNSLink name the node resolves itself) needs no
 * lookup, so its target depends on the URL alone. The stand-in core the
 * real-handler tests use (`test/helpers/fake-dweb-core.js`) plans with it
 * too, and the core's vectors (`vectors/dweb.json`, `requests`) check it
 * whenever they are found (`dweb-vectors.test.js`). Moved from the stand-in.
 */

const { gatewayFormRedirect } = require('../ipfs/gateway-form');
const {
  cidV0ToV1Base32,
  cidV1B58btcToBase32,
  ipnsMhToCidV1Base36,
} = require('../../shared/cid-utils');
const { isDwebNameHost, isPotentialEnsName } = require('../../shared/origin-utils');

/** `bzz:`'s request header allowlist (security audit O-2, #429). */
const FORWARDED_REQUEST_HEADERS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-range',
  'if-unmodified-since',
  'range',
  'user-agent',
]);

/** Swarm's retrieval hints: every `bzz:` fetch carries each once, at this value. */
const SWARM_HEADERS = new Map([
  ['swarm-chunk-retrieval-timeout', '30s'],
  ['swarm-redundancy-strategy', '3'],
  ['swarm-redundancy-fallback-mode', 'true'],
]);

/** `ipfs:`'s request header strip-list: none of these reaches the node. */
const STRIPPED_REQUEST_HEADERS = new Set([
  'host',
  'origin',
  'referer',
  'cookie',
  'authorization',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const BZZ_RETRY_DELAYS_MS = [500, 1000, 2000, 3000, 5000, 5000, 10000, 10000, 15000];
const BZZ_RETRY_STATUSES = [500, 502, 503, 504];
const BZZ_HEADERS_MS = 30_000;
const NATIVE_QUEUE_MS = 15_000;
const NATIVE_HEADERS_MS = 30_000;
const BODY_IDLE_MS = 60_000;

const ANT_NOT_READY = 'Swarm node is not ready';
const NATIVE_NOT_RUNNING = 'freedom-ipfs node is not running';
const GATEWAY_NOT_RUNNING = 'external IPFS gateway is not running';

const BZZ_HASH_RE = /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/;
const CID_RE = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{49,}|z[1-9A-HJ-NP-Za-km-z]{40,})$/i;
const IPNS_HOST_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,252}$/;

const hasEmptyLabel = (host) => host.split('.').some((label) => label.length === 0);

/** What the content's bytes rest on, by backend (display only). */
function contentTrust(backend) {
  if (backend?.ant === 'bundled' || backend?.ipfs === 'native') return 'node_asserted';
  return 'unverified';
}

/** `(method || 'GET').toUpperCase()`. */
function requestMethod(method) {
  return (method || 'GET').toUpperCase();
}

/** The URL's scheme, lowercased, as the URL parser's scheme state reads it:
 * leading and trailing C0 controls and spaces removed, then every tab and
 * newline. */
function urlScheme(url) {
  const text = String(url);
  let start = 0;
  let end = text.length;
  while (start < end && text.charCodeAt(start) <= 0x20) start += 1;
  while (end > start && text.charCodeAt(end - 1) <= 0x20) end -= 1;
  const input = text.slice(start, end).replace(/[\t\n\r]/g, '');
  const colon = input.indexOf(':');
  if (colon < 0) return null;
  const scheme = input.slice(0, colon);
  return /^[A-Za-z][A-Za-z0-9+.-]*$/.test(scheme) ? scheme.toLowerCase() : null;
}

/**
 * A node-relative request target as an HTTP client sends it: dot segments
 * resolved, `\` read as `/`, the path and query sets percent-encoded. Null
 * if the URL parser refuses it.
 */
function normalizeTarget(target) {
  try {
    const url = new URL(`http://node${target}`);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

function errorPlan(status, message) {
  return { error: { status, code: status, message } };
}

function notRunning(backend) {
  if (backend.ant) return errorPlan(503, ANT_NOT_READY);
  return errorPlan(503, backend.ipfs === 'native' ? NATIVE_NOT_RUNNING : GATEWAY_NOT_RUNNING);
}

function retry(backend) {
  return backend.ant
    ? {
        statuses: [...BZZ_RETRY_STATUSES],
        on_error: true,
        attempts: 1 + BZZ_RETRY_DELAYS_MS.length,
        delays_ms: [...BZZ_RETRY_DELAYS_MS],
      }
    : { statuses: [], on_error: false, attempts: 1, delays_ms: [] };
}

function timers(backend) {
  if (backend.ant)
    return { queue_ms: null, headers_ms: BZZ_HEADERS_MS, body_idle_ms: BODY_IDLE_MS };
  if (backend.ipfs === 'native') {
    return { queue_ms: NATIVE_QUEUE_MS, headers_ms: NATIVE_HEADERS_MS, body_idle_ms: BODY_IDLE_MS };
  }
  return { queue_ms: null, headers_ms: null, body_idle_ms: BODY_IDLE_MS };
}

/** A fetch for a node-relative target (`/<namespace>/<ref>…`), or the
 * node's absence as an error. */
function fetchPlan(scheme, backend, target, headers, smallText, nameTrust = null) {
  if (!backend.up) return notRunning(backend);
  let response;
  if (backend.ant) response = ['canonicalize_redirect', 'strip_page_state'];
  else if (backend.ipfs === 'gateway') {
    response = ['strip_decoded_encoding', 'strip_page_state', 'canonicalize_redirect'];
  } else {
    response = ['strip_page_state', ...(smallText ? ['small_text'] : [])];
  }
  return {
    fetch: {
      node: scheme === 'bzz' ? 'ant' : 'ipfs',
      path: normalizeTarget(target) ?? target,
      headers,
      retry: retry(backend),
      timers: timers(backend),
      response,
      trust: { name: nameTrust, content: contentTrust(backend) },
    },
  };
}

function bzzHeaders(headers) {
  const out = new Headers();
  for (const [name, value] of headers) {
    if (FORWARDED_REQUEST_HEADERS.has(name)) out.append(name, value);
  }
  for (const [name, value] of SWARM_HEADERS) out.set(name, value);
  return [...out];
}

function ipfsHeaders(headers) {
  return [...headers].filter(([name]) => !STRIPPED_REQUEST_HEADERS.has(name));
}

function isNavigation(headers) {
  return (headers.get('accept') || '').split(',')[0].trim().toLowerCase() === 'text/html';
}

function lowercased(kind, host, namespace, encoding, publish) {
  return (
    `lowercased ${kind} host "${host}" is not a valid ${namespace} reference. ` +
    `Chromium's standard-scheme URL parser lowercased the host segment and destroyed the ` +
    `case-sensitive ${encoding}. Publish the resource with its ${publish} form for ` +
    'sub-resource use.'
  );
}

function openBzz({ url, method, backend }, headers) {
  if (!['GET', 'HEAD'].includes(requestMethod(method))) return errorPlan(405, 'method not allowed');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return errorPlan(400, 'invalid bzz reference');
  }
  if (/%(?:2f|5c)/i.test(parsed.pathname)) return errorPlan(400, 'invalid bzz path');
  const host = parsed.hostname;
  const sanitized = bzzHeaders(headers);
  if (BZZ_HASH_RE.test(host)) {
    if (!backend.up) return notRunning(backend);
    return fetchPlan('bzz', backend, `/bzz/${host}${parsed.pathname}${parsed.search}`, sanitized);
  }
  if ((isDwebNameHost(host) || isPotentialEnsName(host)) && !hasEmptyLabel(host)) {
    if (!backend.up) return notRunning(backend);
    return {
      pending: {
        scheme: 'bzz',
        host,
        pathname: parsed.pathname,
        search: parsed.search,
        backend,
        headers: sanitized,
        smallText: false,
      },
    };
  }
  return errorPlan(400, 'invalid bzz reference');
}

function openIpfs(scheme, { url, method, backend }, headers) {
  const verb = requestMethod(method);
  if (verb !== 'GET' && verb !== 'HEAD') {
    return errorPlan(405, 'freedom-ipfs native gateway supports GET and HEAD');
  }
  const redirect = gatewayFormRedirect(url);
  if (redirect?.location) {
    return {
      redirect: {
        status: 307,
        location: redirect.location,
        headers: [['access-control-allow-origin', '*']],
      },
    };
  }
  if (redirect?.refuse) {
    return errorPlan(
      400,
      `gateway-form ${scheme} URL has no canonical ipfs:// or ipns:// form; ` +
        "not serving it under the gateway host's origin"
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return errorPlan(400, `invalid ${scheme} reference`);
  }
  let host = parsed.hostname;
  const { pathname, search } = parsed;
  const smallText = verb === 'GET' && isNavigation(headers);
  const sanitized = ipfsHeaders(headers);
  if (scheme === 'ipfs' && CID_RE.test(host)) {
    if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/i.test(host)) {
      const canonical = cidV0ToV1Base32(host);
      if (!canonical) {
        return errorPlan(
          400,
          lowercased('CIDv0', host, 'IPFS', 'base58btc encoding', 'CIDv1 base32 (bafy...)')
        );
      }
      host = canonical;
    } else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(host)) {
      const canonical = cidV1B58btcToBase32(host);
      if (!canonical) {
        return errorPlan(
          400,
          lowercased(
            'CIDv1 base58btc',
            host,
            'IPFS',
            'base58btc encoding',
            'CIDv1 base32 (bafy...)'
          )
        );
      }
      host = canonical;
    }
    return fetchPlan(scheme, backend, `/ipfs/${host}${pathname}${search}`, sanitized, smallText);
  }
  if (scheme === 'ipns' && !isDwebNameHost(host) && IPNS_HOST_RE.test(host)) {
    if (/^(12D3|16Uiu2H|Qm)/i.test(host)) {
      const canonical = ipnsMhToCidV1Base36(host);
      if (!canonical) {
        return errorPlan(
          400,
          lowercased(
            'base58btc IPNS',
            host,
            'IPNS',
            'encoding',
            'libp2p-key base36 (k51.../k2k4...)'
          )
        );
      }
      host = canonical;
    } else if (/^z[1-9A-HJ-NP-Za-km-z]{40,}$/i.test(host)) {
      const canonical = cidV1B58btcToBase32(host);
      if (!canonical) {
        return errorPlan(
          400,
          lowercased(
            'CIDv1 base58btc IPNS',
            host,
            'IPNS',
            'base58btc encoding',
            'libp2p-key base36 (k51.../k2k4...) or CIDv1 base32 (bafy...)'
          )
        );
      }
      host = canonical;
    }
    return fetchPlan(scheme, backend, `/ipns/${host}${pathname}${search}`, sanitized, smallText);
  }
  if (
    (isDwebNameHost(host) || (scheme === 'ipfs' && isPotentialEnsName(host))) &&
    !hasEmptyLabel(host)
  ) {
    return {
      pending: { scheme, host, pathname, search, backend, headers: sanitized, smallText },
    };
  }
  return errorPlan(400, `invalid ${scheme} reference`);
}

/**
 * Plans a request as `dweb.open` does, up to any lookup.
 *
 * @param {{url: string, method?: string, headers?: string[][], backend: object}} request
 * @returns {object|null} a plan (`{ fetch | redirect | error }`), `{ pending }`
 *   for a name host, or null for a request the core can't plan (not a
 *   `bzz:`, `ipfs:` or `ipns:` URL, or a backend that doesn't serve its
 *   scheme)
 */
function openDweb(request) {
  const scheme = urlScheme(request.url);
  const backend = request.backend || {};
  const serves =
    (scheme === 'bzz' && typeof backend.ant === 'string') ||
    ((scheme === 'ipfs' || scheme === 'ipns') && typeof backend.ipfs === 'string');
  if (!serves) return null;
  const headers = new Headers();
  for (const [name, value] of request.headers || []) headers.append(name, value);
  return scheme === 'bzz' ? openBzz(request, headers) : openIpfs(scheme, request, headers);
}

module.exports = {
  openDweb,
  fetchPlan,
  errorPlan,
  contentTrust,
  normalizeTarget,
  requestMethod,
  urlScheme,
  FORWARDED_REQUEST_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  SWARM_HEADERS,
  BZZ_RETRY_DELAYS_MS,
  BZZ_HEADERS_MS,
  NATIVE_HEADERS_MS,
  BODY_IDLE_MS,
};
