/**
 * A stand-in for freedom-cored's `dweb.open` (freedom-core design 0006), for
 * tests that drive the real `bzz:`, `ipfs:` and `ipns:` handlers without a
 * core process.
 *
 * It plans as fc-dweb's `open` does, with main's copy of that planning
 * (`src/main/dweb/dweb-open.js`: the URL and host canonicalization, the name
 * hosts and which resolver they go to, the header policies, the retry and
 * timer tables, the response operations and the status mapping), then maps a
 * name's resolution as the core does. The core is the authority; this copy is
 * checked against the core's own vectors (`vectors/dweb.json`, `requests`) by
 * `src/main/dweb/dweb-vectors.test.js` whenever they are found, and the real
 * binary is driven by `src/main/dweb/dweb.integration.test.js`.
 *
 * Name resolution is the test's: `resolveContent(name)` and
 * `resolveTezos(name)` return or throw what the reference's resolvers would.
 */

const {
  openDweb,
  fetchPlan,
  errorPlan,
  BZZ_RETRY_DELAYS_MS,
  BZZ_HEADERS_MS,
  NATIVE_HEADERS_MS,
  BODY_IDLE_MS,
} = require('../../src/main/dweb/dweb-open');
const { isTezosDomainHost } = require('../../src/shared/origin-utils');

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
  const opened = openDweb(request);
  if (!opened) throw invalidArgument();
  if (!opened.pending) return opened;
  return resolveName(opened.pending, {
    resolveContent: resolvers.resolveContent || (async () => null),
    resolveTezos: resolvers.resolveTezos || (async () => null),
  });
}

/**
 * A naming driver whose `open` plans with `planDweb` at once, at generation
 * zero, as the real driver hands plans over: `ready(reply, signal)` first
 * (its signal aborts with the request), then `use(reply)` in the same turn.
 * `calls` records each request it was given.
 */
function createFakeDwebDriver(resolvers = {}) {
  const calls = [];
  const cancelled = () => Object.assign(new Error('Cancelled'), { code: 'cancelled' });
  return {
    calls,
    async open(params, { signal = null, ready = null, use = null } = {}) {
      calls.push(params);
      if (signal?.aborted) throw cancelled();
      const reply = {
        plan: await planDweb(params, resolvers),
        generations: { ens: 0, tezos: 0, lifecycle: 0 },
        attempts: 0,
      };
      if (signal?.aborted) throw cancelled();
      if (ready) await ready(reply, signal ?? new AbortController().signal);
      if (signal?.aborted) throw cancelled();
      return use ? use(reply) : reply;
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
