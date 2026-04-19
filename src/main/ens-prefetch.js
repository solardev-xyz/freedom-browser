const log = require('./logger');
const { net } = require('electron');
const { convertProtocolUrl } = require('./request-rewriter');

// Hygiene timeout — not trust-critical. A misbehaving gateway shouldn't
// hold a socket open forever for speculative content the user may never
// see. Quorum outcomes typically tear prefetch down earlier via abort().
const PREFETCH_TIMEOUT_MS = 10_000;

const NOOP_HANDLE = Object.freeze({ abort: () => {} });

/**
 * Speculatively warm the local gateway cache for a bzz:// or ipfs:// URI
 * while the public-quorum wave is still resolving. Returns an abort handle
 * the consensus wave calls when the outcome isn't verified-data (so
 * rejected or cancelled speculation doesn't keep a socket open).
 *
 * Never affects resolution state. Any failure (bad URI, ipns://, net
 * error, thrown exception) degrades silently to a noop handle.
 *
 * @param {string} uri - decoded content URI (bzz:// or ipfs://)
 * @returns {{ abort: () => void }}
 */
function prefetchGatewayUrl(uri) {
  try {
    if (process.env.ENS_DISABLE_PREFETCH === '1') return NOOP_HANDLE;
    if (typeof uri !== 'string' || !uri) return NOOP_HANDLE;
    // IPNS is a mutable two-hop resolution — speculating pre-consensus
    // leaks interest in the name to more infrastructure than we need.
    if (uri.startsWith('ipns://')) return NOOP_HANDLE;
    if (!uri.startsWith('bzz://') && !uri.startsWith('ipfs://')) return NOOP_HANDLE;

    const { converted, url } = convertProtocolUrl(uri);
    if (!converted) return NOOP_HANDLE;

    let aborted = false;
    let request = null;
    let timer = null;

    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (request) {
        try { request.abort(); } catch { /* already done */ }
        request = null;
      }
    };

    const abort = () => {
      if (aborted) return;
      aborted = true;
      log.info(`[ens-prefetch] aborted ${url}`);
      cleanup();
    };

    // Request completed naturally — release the hygiene timer and drop
    // the handle so abort() becomes a no-op. Don't call cleanup(), which
    // would invoke abort() on an already-finished request.
    const markFinished = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      request = null;
    };

    request = net.request({ method: 'GET', url });
    request.on('response', (response) => {
      // Drain the body into /dev/null — the gateway parses + caches it on
      // its side regardless. We just don't need the bytes in this process.
      response.on('data', () => {});
      response.on('end', markFinished);
      response.on('error', markFinished);
    });
    request.on('error', (err) => {
      log.info(`[ens-prefetch] ${url} — ${err.message}`);
      markFinished();
    });
    request.end();

    timer = setTimeout(() => {
      if (!aborted) {
        log.info(`[ens-prefetch] timeout ${url}`);
        abort();
      }
    }, PREFETCH_TIMEOUT_MS);

    log.info(`[ens-prefetch] warming ${url}`);
    return { abort };
  } catch (err) {
    // Hard rule: prefetch can never break the caller.
    log.warn(`[ens-prefetch] noop after throw: ${err.message}`);
    return NOOP_HANDLE;
  }
}

module.exports = {
  prefetchGatewayUrl,
  PREFETCH_TIMEOUT_MS,
  NOOP_HANDLE,
};
