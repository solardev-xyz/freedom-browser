/**
 * A stand-in for freedom-cored's `dweb.open` (freedom-core design 0006), for
 * tests that drive the real `bzz:`, `ipfs:` and `ipns:` handlers without a
 * core process.
 *
 * It plans as fc-dweb's `open` does: the URL and host canonicalization, the
 * name hosts and which resolver they go to, the header policies, the retry
 * and timer tables, the response operations and the status mapping. The core
 * is the authority; this copy is checked against the core's own vectors
 * (`vectors/dweb.json`, `requests`) by `src/main/dweb/dweb-vectors.test.js`
 * whenever they are found, and the real binary is driven by
 * `src/main/dweb/dweb.integration.test.js`.
 *
 * Name resolution is the test's: `resolveContent(name)` and
 * `resolveTezos(name)` return or throw what the reference's resolvers would.
 */

const {
  normalizeTarget,
  requestMethod,
  urlScheme,
  contentTrust,
  FORWARDED_REQUEST_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  SWARM_HEADERS,
} = require('../../src/main/dweb/plan-validation');
const { gatewayFormRedirect } = require('../../src/main/ipfs/gateway-form');
const {
  cidV0ToV1Base32,
  cidV1B58btcToBase32,
  ipnsMhToCidV1Base36,
} = require('../../src/shared/cid-utils');
const {
  isDwebNameHost,
  isPotentialEnsName,
  isTezosDomainHost,
} = require('../../src/shared/origin-utils');

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

function nameSystemLabelForHost(host) {
  const lower = String(host || '').toLowerCase();
  if (lower.endsWith('.tez')) return 'Tezos Domains';
  if (lower.endsWith('.wei')) return 'WNS';
  if (lower.endsWith('.gwei')) return 'GNS';
  return 'ENS';
}

function nameSystemLabelForResult(result, host) {
  if (result?.system === 'tezos') return 'Tezos Domains';
  if (result?.system === 'wns') return 'WNS';
  if (result?.system === 'gns') return 'GNS';
  return nameSystemLabelForHost(host);
}

function joinPublishedPath(basePath, requestPath) {
  const base = basePath && basePath !== '/' ? basePath.replace(/\/$/, '') : '';
  const requested = requestPath || '/';
  if (!base) return requested.startsWith('/') ? requested : `/${requested}`;
  if (requested === '/') return `${base}/`;
  return `${base}${requested.startsWith('/') ? requested : `/${requested}`}`;
}

/** A name's resolution, mapped as the handlers mapped `resolveContentName`'s. */
async function resolveName(pending, resolvers) {
  const { scheme, host, pathname, search } = pending;
  const fallback = nameSystemLabelForHost(host);
  let result;
  try {
    result = await (isTezosDomainHost(host)
      ? resolvers.resolveTezos(host)
      : resolvers.resolveContent(host));
  } catch (err) {
    return errorPlan(502, `${fallback} resolver error: ${err.message}`);
  }
  if (!result) return errorPlan(502, `${fallback} resolver returned no result for ${host}`);
  const label = nameSystemLabelForResult(result, host);
  if (result.type === 'ok') {
    if (result.protocol !== scheme) {
      const expected = scheme === 'bzz' ? 'Swarm' : scheme.toUpperCase();
      return errorPlan(
        404,
        `${label} name ${host} resolves to ${result.protocol}, not ${expected}`
      );
    }
    const target = `/${scheme}/${result.decoded}${joinPublishedPath(result.basePath, pathname)}${search}`;
    return fetchPlan(
      scheme,
      pending.backend,
      target,
      pending.headers,
      pending.smallText,
      typeof result.trust?.level === 'string' ? result.trust.level : null
    );
  }
  if (result.type === 'not_found') {
    return errorPlan(
      404,
      `${label} name ${host} has no contenthash (${result.reason || 'unknown'})`
    );
  }
  if (result.type === 'unsupported') {
    return errorPlan(415, `${label} name ${host} contenthash format unsupported`);
  }
  if (result.type === 'conflict') return errorPlan(502, `${label} providers disagree on ${host}`);
  const detail = result.error || result.reason || 'unknown';
  return errorPlan(502, `${label} resolution failed for ${host}: ${detail}`);
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

function invalidArgument() {
  const err = new Error('Invalid parameters');
  err.code = 'invalid_argument';
  return err;
}

/**
 * A plan, as `dweb.open` makes it.
 *
 * @param {{url: string, method?: string, headers: string[][], backend: object}} request
 * @param {{resolveContent?: Function, resolveTezos?: Function}} [resolvers]
 */
async function planDweb(request, resolvers = {}) {
  const scheme = urlScheme(request.url);
  const backend = request.backend || {};
  const serves =
    (scheme === 'bzz' && typeof backend.ant === 'string') ||
    ((scheme === 'ipfs' || scheme === 'ipns') && typeof backend.ipfs === 'string');
  if (!serves) throw invalidArgument();
  const headers = new Headers();
  for (const [name, value] of request.headers || []) headers.append(name, value);
  const opened = scheme === 'bzz' ? openBzz(request, headers) : openIpfs(scheme, request, headers);
  if (!opened.pending) return opened;
  return resolveName(opened.pending, {
    resolveContent: resolvers.resolveContent || (async () => null),
    resolveTezos: resolvers.resolveTezos || (async () => null),
  });
}

/**
 * A naming driver whose `open` plans with `planDweb` at once, at generation
 * zero, honouring `ready` as the real driver does. `calls` records each
 * request it was given.
 */
function createFakeDwebDriver(resolvers = {}) {
  const calls = [];
  return {
    calls,
    async open(params, { signal = null, ready = null } = {}) {
      calls.push(params);
      if (signal?.aborted) {
        const err = new Error('Cancelled');
        err.code = 'cancelled';
        throw err;
      }
      const reply = {
        plan: await planDweb(params, resolvers),
        generations: { ens: 0, tezos: 0, lifecycle: 0 },
        attempts: 0,
      };
      if (ready) await ready(reply);
      return reply;
    },
  };
}

module.exports = {
  planDweb,
  createFakeDwebDriver,
  BZZ_RETRY_DELAYS_MS,
  BZZ_HEADERS_MS,
  NATIVE_HEADERS_MS,
  BODY_IDLE_MS,
};
