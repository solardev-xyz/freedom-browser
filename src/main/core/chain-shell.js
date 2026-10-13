/**
 * Main's executors for the chain thread's I/O (freedom-core design 0005,
 * Requests the core makes, Transport and Main's pool): `shell.rpc` with
 * `policy: "plain"`, and `shell.blockscout`. Naming's requests share
 * `shell.rpc`; the chain thread's carry one `generation`, where naming's
 * carry `generations` (`isChainRequest`).
 *
 * - **`{ not_sent: true }`** answers a request main performed nothing for:
 *   its chain's generation is no longer current or its endpoint reference
 *   unknown, the core cancelled it before its exchange started, or its
 *   endpoint was refused before connecting (the endpoint policy, the onion
 *   gate). It proves no byte of the request left main, which the core's
 *   broadcast outcomes rely on, so nothing else is answered with it.
 * - **Errors** are the chain thread's closed set of transport failures,
 *   with no text and no `data`. Anything else closes the core, so every
 *   failure is mapped into the set (`chainHandler`).
 * - **Main's pool:** a body is charged as it is read; past the pool, the
 *   exchange is `busy`.
 */

const dns = require('node:dns');
const { ShellError } = require('./core-client');
const { fetchLoop, makeHop, withDeadline, isOk } = require('./naming-shell');
const { validateRpcUrl } = require('../networks/network-registry');
const {
  BlockscoutError,
  LookupsExhausted,
  MAX_REDIRECTS,
  REDIRECT_STATUSES,
  boundLookups,
  redirectTarget,
} = require('../networks/blockscout-logs');

/** The largest answer main reads for chain data (deviation
 * `response-caps`): an `html()` document at its 8 MiB limit, as hex in a
 * JSON-RPC answer, with room for envelopes. */
const ANSWER_BYTES = 18 * 1024 * 1024;
/** A Blockscout page's cap, as blockscout-logs.js reads one. */
const PAGE_BYTES = 8 * 1024 * 1024;
/** The page headers the core reads (its cooldown and size checks): main
 * sends those the page has, three of the eight a reply may carry. */
const PAGE_HEADERS = ['content-length', 'x-ratelimit-reset', 'retry-after'];
/** The chain thread's transport failures that main sends. The core also
 * takes `deadline`, which main never sends: its deadline is `timeout`. */
const CHAIN_FAILURES = new Set([
  'timeout',
  'network',
  'refused',
  'too_large',
  'busy',
  'cancelled',
  'stale_generation',
]);
/** Main performed nothing: no byte of the request left it. */
const NOT_SENT = Object.freeze({ not_sent: true });

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether one of the core's requests is the chain thread's: naming's
 * carry `generations`, one per scope (design 0004). */
function isChainRequest(params) {
  return !isObject(params.generations);
}

/** A failure as the chain thread takes it: a code of its set as it is;
 * otherwise `cancelled` once the core cancelled, or `network`, which may
 * have followed a send. */
function chainFailure(err, signal) {
  if (err instanceof ShellError && CHAIN_FAILURES.has(err.code)) return err;
  return new ShellError(signal.aborted ? 'cancelled' : 'network');
}

/** `handler`, with every failure in the chain thread's set. */
function chainHandler(handler) {
  return async (params, context) => {
    try {
      return await handler(params, context);
    } catch (err) {
      throw chainFailure(err, context.signal);
    }
  };
}

/** The cap the core asks an answer to keep (`max_bytes`), within main's
 * own; null when it names none. */
function answerCap(maxBytes, cap) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return null;
  return Math.min(maxBytes, cap);
}

/** A page's URL: the endpoint's, then the core's path and query, which
 * must start the path and can't leave the endpoint's origin; null for
 * anything else. */
function pageUrl(base, query) {
  if (typeof query !== 'string' || !query.startsWith('/')) return null;
  try {
    const url = new URL(`${base}${query}`);
    return url.origin === new URL(base).origin ? url.href : null;
  } catch {
    return null;
  }
}

/** The headers the core reads, those the page has. */
function pageHeaders(headers) {
  const kept = {};
  for (const name of PAGE_HEADERS) {
    if (Object.hasOwn(headers, name) && typeof headers[name] === 'string') {
      kept[name] = headers[name];
    }
  }
  return kept;
}

/**
 * One Blockscout page through blockscout-logs.js's redirect policy: each
 * hop checked before it is dialled (on https, and off the endpoint's origin
 * never to a local address, by name or as it resolves), at most three. A
 * refused hop is one `refused`, its reason not told (design 0005, Logs).
 * Only a 2xx body is read: the core judges the status, the size and the
 * cooldown headers itself. With too many lookups still outstanding, a hop
 * that needs one is `busy`.
 */
async function readPage(url, { hop, lookup, signal, max, charge }) {
  const origin = new URL(url).origin;
  let current = url;
  for (let hops = 0; ; hops += 1) {
    const response = await hop(current, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
      max,
      read: isOk,
      charge,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return {
        status: response.status,
        headers: pageHeaders(response.headers),
        body: response.body.toString('base64'),
      };
    }
    let next;
    try {
      next = await redirectTarget(response.headers.location, current, origin, { lookup, signal });
    } catch (err) {
      if (err instanceof BlockscoutError) throw new ShellError('refused');
      if (err instanceof LookupsExhausted) throw new ShellError('busy');
      throw err;
    }
    if (hops + 1 > MAX_REDIRECTS) throw new ShellError('refused');
    current = next.href;
  }
}

/**
 * Registers the executors on `client`, for the chain thread's requests.
 *
 * @param {import('./core-client').CoreClient} client
 * @param {object} config - main's chain configuration: `endpoint(ref)`, the
 *   `{ url, chainId }` behind a reference it knows (each names one chain's
 *   endpoint), and `generation(chainId)`, the chain's current generation
 * @param {object} [deps] - test seams: hop, lookup
 */
function registerChainShell(client, config, deps = {}) {
  const hop = deps.hop || makeHop();
  // A redirect's DNS check: the lookups a cancel or a deadline left running
  // keep their slots until they settle.
  const lookup = boundLookups(deps.lookup || dns.promises.lookup);
  // The URL behind a request's reference while the request runs under its
  // chain's current generation (one main hasn't seen yet is newer, never
  // stale); null otherwise.
  const current = (params) => {
    const endpoint = config.endpoint(params.endpoint);
    if (!endpoint) return null;
    const generation = params.generation;
    if (!Number.isSafeInteger(generation) || generation < config.generation(endpoint.chainId)) {
      return null;
    }
    return endpoint.url;
  };

  // One exchange, as today's router makes it: no 429 back-off and no
  // repeated attempts; redirects as naming's (deviation `rpc-redirects`).
  client.handle(
    'shell.rpc',
    chainHandler(async (params, { signal, charge }) => {
      const url = current(params);
      if (!url || signal.aborted || validateRpcUrl(url) !== null) return NOT_SENT;
      const max = answerCap(params.max_bytes, ANSWER_BYTES);
      if (params.policy !== 'plain' || typeof params.body !== 'string' || max === null) {
        throw new ShellError('refused');
      }
      let hops = 0;
      try {
        const response = await withDeadline(params, signal, (within) =>
          fetchLoop(url, params.body, {
            hop: (target, options) => {
              hops += 1;
              return hop(target, options);
            },
            allowed: (location) => validateRpcUrl(location) === null,
            signal: within,
            plain: true,
            // A non-2xx answer is `HTTP <status>`, its body unread.
            read: isOk,
            max,
            charge,
          })
        );
        return { status: response.status, body: response.body.toString('base64') };
      } catch (err) {
        // The onion gate refused the first hop before its request existed.
        if (hops === 1 && err?.unsent) return NOT_SENT;
        throw err;
      }
    }),
    { when: isChainRequest }
  );

  client.handle(
    'shell.blockscout',
    chainHandler(async (params, { signal, charge }) => {
      const base = current(params);
      if (!base || signal.aborted) return NOT_SENT;
      const url = pageUrl(base, params.query);
      const max = answerCap(params.max_bytes, PAGE_BYTES);
      if (!url || max === null) throw new ShellError('refused');
      return withDeadline(params, signal, (within) =>
        readPage(url, { hop, lookup, signal: within, max, charge })
      );
    }),
    { when: isChainRequest }
  );
}

module.exports = {
  registerChainShell,
  isChainRequest,
  chainHandler,
  NOT_SENT,
  ANSWER_BYTES,
  PAGE_BYTES,
  PAGE_HEADERS,
};
