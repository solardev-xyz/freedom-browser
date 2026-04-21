/**
 * Swarm Content Probe
 *
 * Polls the Bee HTTP gateway with HEAD /bzz/<hash> until the content is
 * retrievable (200), the Bee node is detected as unreachable, or an overall
 * timeout elapses. Used to gate webview navigation to `bzz://` URLs so the
 * user sees the tab spinner instead of Bee's raw 404 JSON body while the
 * node is still connecting to peers.
 *
 * Each probe gets a unique id and an AbortController; callers can cancel via
 * cancelProbe(id). Resolves with one of:
 *   { ok: true }
 *   { ok: false, reason: 'bee_unreachable' }   // API refused/failed to connect
 *   { ok: false, reason: 'not_found' }         // overall timeout reached
 *   { ok: false, reason: 'other', status }     // unexpected HTTP status
 *   { ok: false, reason: 'aborted' }           // cancelProbe() called
 */

const crypto = require('crypto');
const log = require('electron-log');
const { getBeeApiUrl } = require('../service-registry');

const DEFAULT_DELAYS_MS = [0, 500, 1000, 2000, 3000];
// Overall budget for a single probe. Freshly-started Bee nodes can take
// several minutes to gather enough peers to resolve feed-based content, so
// we stay generous and let the user cancel via the stop button if needed.
const DEFAULT_OVERALL_TIMEOUT_MS = 5 * 60_000;
// Per-attempt cap. Bee's own feed lookup can easily take a few seconds, so
// this needs to be generous — a too-tight cap (we previously used 3s) will
// abort every request right before Bee responds, making progress impossible.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

// Validate that a bzz reference is a 64- or 128-char hex string.
// Matches the check used in request-rewriter.js.
const BZZ_HASH_RE = /^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/;

const activeProbes = new Map();

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

/**
 * Start probing for the availability of a `bzz://<hash>` resource.
 * Returns `{ id, promise }`. The promise resolves with the outcome.
 * Cancel with cancelProbe(id).
 */
function startProbe(hash, opts = {}) {
  const delays = opts.delays || DEFAULT_DELAYS_MS;
  const overallTimeoutMs = opts.overallTimeoutMs ?? DEFAULT_OVERALL_TIMEOUT_MS;
  const attemptTimeoutMs = opts.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const sleep = opts.sleep || createAbortableSleep;

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

  const run = async () => {
    try {
      for (let attempt = 0; ; attempt++) {
        if (controller.signal.aborted) return { ok: false, reason: 'aborted' };

        const delay = pickDelay(attempt, delays);
        if (delay > 0) {
          await sleep(delay, controller.signal);
          if (controller.signal.aborted) return { ok: false, reason: 'aborted' };
        }

        const beeUrl = getBeeApiUrl();
        if (!beeUrl) {
          return { ok: false, reason: 'bee_unreachable' };
        }

        // Per-attempt timeout: abort this fetch without aborting the whole probe.
        const attemptCtl = new AbortController();
        const relayAbort = () => attemptCtl.abort();
        controller.signal.addEventListener('abort', relayAbort, { once: true });
        const attemptTimer = setTimeout(() => attemptCtl.abort(), attemptTimeoutMs);

        let response = null;
        let fetchError = null;
        try {
          response = await fetchImpl(`${beeUrl}/bzz/${hash}`, {
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
        } else if (response.status === 404 || response.status === 500) {
          // Content not (yet) resolvable — keep polling.
        } else {
          return { ok: false, reason: 'other', status: response.status };
        }

        if (now() - started >= overallTimeoutMs) {
          return { ok: false, reason: 'not_found' };
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
