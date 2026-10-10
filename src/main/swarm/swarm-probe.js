/**
 * Swarm Content Probe
 *
 * Polls the Bee HTTP gateway with HEAD /bzz/<hash><path> until the content
 * is retrievable (200), the Bee node is detected as unreachable, or an
 * overall timeout elapses. Used to gate webview navigation to `bzz://` URLs
 * so the user sees the tab spinner instead of Bee's raw 404 JSON body while
 * the node is still connecting to peers.
 *
 * The probe must target the same path the navigation will load, not just
 * the bare hash: a manifest without a root index document 404s on
 * `/bzz/<hash>` permanently even when `/bzz/<hash>/index.html` is
 * instantly retrievable, and the probe cannot tell that 404 apart from a
 * still-warming node — it would poll until the overall timeout and strand
 * the user on the error page (#172).
 *
 * A 404 alone is ambiguous, but its body is not: the node answers a path
 * the manifest doesn't contain with `path address not found`, and content
 * it can't retrieve (a node on the path, or the whole site) with a plain
 * `Not Found`. A quick 404 is re-read with GET (HEAD carries no body), and
 * `path address not found` ends the probe as `path_not_found` instead of
 * polling out the whole budget on a typo or a stale deep link (#175).
 * Ant gives that answer on a cold node since v0.5.64 (freedom-hq/ant#154),
 * so no warm-up lookup of the site root is needed. An answer given
 * instantly comes from a manifest the node already holds and ends the
 * probe at once. A slower one came from a fresh lookup, which for a
 * feed-backed site may have landed on an older update than the latest
 * (a page the site just added), so it ends the probe only when the next
 * attempt says the same.
 *
 * Each probe gets a unique id and an AbortController; callers can cancel via
 * cancelProbe(id). Resolves with one of:
 *   { ok: true }
 *   { ok: false, reason: 'bee_unreachable' }   // API refused/failed to connect
 *   { ok: false, reason: 'not_found', lastStatus, peers }
 *                                              // overall timeout reached
 *   { ok: false, reason: 'path_not_found' }    // manifest has no such path
 *   { ok: false, reason: 'other', status }     // unexpected HTTP status
 *   { ok: false, reason: 'aborted' }           // cancelProbe() called
 *
 * `lastStatus` is the node's last answer before the timeout (404, a 5xx,
 * or 'no_response' when the attempt itself timed out) and `peers` its
 * connected peer count then (null when the node didn't say), so the error
 * page can tell a node short of peers from content the network lacks.
 */

const crypto = require('crypto');
const log = require('../logger');
const { getAntApiUrl } = require('../service-registry');

const DEFAULT_DELAYS_MS = [0, 500, 1000, 2000, 3000];
// Overall budget for a single probe. Freshly-started Bee nodes can take
// several minutes to gather enough peers to resolve feed-based content, so
// we stay generous and let the user cancel via the stop button if needed.
const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60_000;
// Per-attempt cap. Bee's own feed lookup can easily take a few seconds, so
// this needs to be generous — a too-tight cap (we previously used 3s) will
// abort every request right before Bee responds, making progress impossible.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;
// A 404 slower than this came from a retrieval that gave up, so re-reading
// it would only repeat that wait. Measured against Ant v0.5.64 on mainnet
// in October 2026 (PR #623): a site the network lacks took 10.8 s to answer
// `Not Found`, a missing path in a reachable site about 2.3-2.5 s cold and
// under 1 ms once cached. Re-measure on an Ant bump that touches retrieval
// or replica sweeps: if a missing site starts 404ing under this window, the
// probe re-reads every such 404 with one extra GET (harmless, just slower).
const QUICK_404_MS = 5_000;
// A `path address not found` faster than this came from a manifest the
// node already held and is final on its own; a slower one (a cold lookup)
// needs the next attempt to agree. Same October 2026 measurements: cached
// answers in under 1 ms, cold ones in 2 s or more.
const WARM_404_MS = 1_000;
// Cap on the follow-up requests (404 body, peer count).
const SIDE_REQUEST_TIMEOUT_MS = 5_000;
// The message Bee and Ant give a manifest lookup that misses.
const MISSING_PATH_MESSAGE = 'path address not found';

// Validate that a bzz reference is a 64- or 128-char hex string.
// Matches the check used in request-rewriter.js.
const BZZ_HASH_RE = /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/;

const activeProbes = new Map();

// 5xx statuses that mean "not yet", kept in step with RETRYABLE_STATUSES
// in bzz-protocol.js.
const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

function pickDelay(attemptIndex, delays) {
  if (attemptIndex < delays.length) return delays[attemptIndex];
  return delays[delays.length - 1];
}

function createAbortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function isAbortError(err) {
  return err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
}

// A short GET beside the probe's own HEAD (404 body, peer count): aborted
// with the probe or after SIDE_REQUEST_TIMEOUT_MS, so a slow node can't
// stall a probe iteration for a full attempt timeout. Resolves with the
// parsed JSON body, or `null` on any failure.
async function sideRequest(fetchImpl, url, signal) {
  const ctl = new AbortController();
  const relayAbort = () => ctl.abort();
  signal.addEventListener('abort', relayAbort, { once: true });
  const timer = setTimeout(() => ctl.abort(), SIDE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: ctl.signal });
    if (typeof response?.json !== 'function') return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relayAbort);
  }
}

async function isMissingPath(fetchImpl, url, signal) {
  const body = await sideRequest(fetchImpl, url, signal);
  return typeof body?.message === 'string' && body.message.toLowerCase() === MISSING_PATH_MESSAGE;
}

async function countPeers(fetchImpl, beeUrl, signal) {
  const body = await sideRequest(fetchImpl, `${beeUrl}/peers`, signal);
  return Array.isArray(body?.peers) ? body.peers.length : null;
}

// A double-dot path segment in any of the forms WHATWG URL normalizes:
// `..`, `.%2e`, `%2e.`, `%2e%2e` (case-insensitive).
const DOUBLE_DOT_SEGMENT_RE = /^(\.|%2e){2}$/i;

// Normalize the optional probe path so the HEAD target mirrors the resource
// the navigation will load. Only origin-relative paths are accepted; the
// query/fragment are dropped (the gateway's manifest lookup ignores them)
// and anything malformed degrades to the bare-hash probe. Double-dot
// segments are rejected too: fetch normalizes them before sending, so a
// `..` could aim the probe at Bee API endpoints outside /bzz/*. The segment
// split treats `\` as a separator because WHATWG URL parsing does the same
// for http URLs — `/..\..\health` normalizes to `/health`.
function normalizeProbePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return '';
  const clean = path.split(/[?#]/, 1)[0];
  if (clean.split(/[/\\]/).some((segment) => DOUBLE_DOT_SEGMENT_RE.test(segment))) return '';
  return clean;
}

/**
 * Start probing for the availability of a `bzz://<hash><path>` resource.
 * `opts.path` is the origin-relative path within the manifest (e.g.
 * `/index.html`); omit or pass '' to probe the manifest root.
 * Returns `{ id, promise }`. The promise resolves with the outcome.
 * Cancel with cancelProbe(id).
 */
function startProbe(hash, opts = {}) {
  const delays = opts.delays || DEFAULT_DELAYS_MS;
  const overallTimeoutMs = opts.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  // undici again: no session proxy on this dial either, so an external Ant API
  // on a `.onion` host is not probed over Tor. Tracked in #360 with the rest.
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || createAbortableSleep;

  const probePath = normalizeProbePath(opts.path);

  const id = opts.id || crypto.randomUUID();
  const controller = new AbortController();
  activeProbes.set(id, controller);

  if (!BZZ_HASH_RE.test(String(hash || ''))) {
    activeProbes.delete(id);
    return {
      id,
      promise: Promise.resolve({ ok: false, reason: 'invalid_hash' }),
    };
  }

  const started = now();
  let lastStatus = null;
  // The previous attempt was a cold `path address not found` still awaiting
  // its confirmation.
  let coldMissingPath = false;

  const run = async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) return { ok: false, reason: 'aborted' };

        const delay = pickDelay(attempt, delays);
        if (delay > 0) {
          await sleep(delay, controller.signal);
          if (controller.signal.aborted) return { ok: false, reason: 'aborted' };
        }

        const beeUrl = getAntApiUrl();
        if (!beeUrl) {
          return { ok: false, reason: 'bee_unreachable' };
        }

        // Per-attempt timeout: abort this fetch without aborting the whole probe.
        const attemptCtl = new AbortController();
        const relayAbort = () => attemptCtl.abort();
        controller.signal.addEventListener('abort', relayAbort, { once: true });
        const attemptTimer = setTimeout(() => attemptCtl.abort(), attemptTimeoutMs);

        const target = `${beeUrl}/bzz/${hash}${probePath}`;
        const attemptStarted = now();
        let response = null;
        let fetchError = null;
        try {
          response = await fetchImpl(target, {
            method: 'HEAD',
            signal: attemptCtl.signal,
          });
        } catch (err) {
          fetchError = err;
        } finally {
          clearTimeout(attemptTimer);
          controller.signal.removeEventListener('abort', relayAbort);
        }

        if (controller.signal.aborted) return { ok: false, reason: 'aborted' };

        if (fetchError) {
          if (isAbortError(fetchError)) {
            // Per-attempt timeout: treat like a transient failure and keep polling.
            log.info(`[SwarmProbe] attempt timed out (${attemptTimeoutMs}ms), retrying`);
            lastStatus = 'no_response';
            coldMissingPath = false;
          } else {
            // Any other fetch failure (ECONNREFUSED, DNS, TLS, …) means the
            // Bee HTTP API itself is unreachable — bail out immediately so the
            // renderer can show the existing "Swarm node not running" page.
            log.info(
              `[SwarmProbe] bee unreachable: ${fetchError.cause?.code || fetchError.message}`
            );
            return { ok: false, reason: 'bee_unreachable' };
          }
        } else if (response.status === 200) {
          return { ok: true };
        } else if (response.status === 404 || TRANSIENT_STATUSES.has(response.status)) {
          // Content not (yet) resolvable — keep polling. Ant answers 503
          // when its peers can't serve the chunk yet (a cold node right
          // after start); the bzz: handler retries the same 5xx set.
          lastStatus = response.status;
          // Timed on the HEAD alone, before the GET below adds its own trip.
          const elapsed = now() - attemptStarted;
          const missingPath =
            response.status === 404 &&
            elapsed < QUICK_404_MS &&
            (await isMissingPath(fetchImpl, target, controller.signal));
          if (controller.signal.aborted) return { ok: false, reason: 'aborted' };
          if (missingPath && (elapsed < WARM_404_MS || coldMissingPath)) {
            log.info(`[SwarmProbe] path not in manifest: /bzz/${hash}${probePath}`);
            return { ok: false, reason: 'path_not_found' };
          }
          coldMissingPath = missingPath;
        } else {
          return { ok: false, reason: 'other', status: response.status };
        }

        if (now() - started >= overallTimeoutMs) {
          const peers = await countPeers(fetchImpl, beeUrl, controller.signal);
          if (controller.signal.aborted) return { ok: false, reason: 'aborted' };
          log.info(`[SwarmProbe] gave up: last answer ${lastStatus}, ${peers ?? '?'} peers`);
          return { ok: false, reason: 'not_found', lastStatus, peers };
        }
      }
    } finally {
      activeProbes.delete(id);
    }
  };

  return { id, promise: run() };
}

/**
 * Cancel an in-flight probe by id. Returns true if a probe was cancelled.
 */
function cancelProbe(id) {
  const controller = activeProbes.get(id);
  if (!controller) return false;
  controller.abort();
  activeProbes.delete(id);
  return true;
}

/**
 * For tests: how many probes are currently tracked.
 */
function getActiveProbeCount() {
  return activeProbes.size;
}

module.exports = {
  startProbe,
  cancelProbe,
  getActiveProbeCount,
  DEFAULT_DELAYS_MS,
  DEFAULT_OVERALL_TIMEOUT_MS,
  DEFAULT_ATTEMPT_TIMEOUT_MS,
};
