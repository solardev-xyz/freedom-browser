const log = require('./logger');
const { net } = require('electron');
const { convertProtocolUrl, sanitizeUrlForLog } = require('./request-rewriter');
const { getBeeApiUrl } = require('./service-registry');

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

    // bzz:// is now served by the custom protocol handler in
    // src/main/swarm/bzz-protocol.js, so convertProtocolUrl no longer
    // rewrites it. The prefetch fires from the main process directly via
    // net.request, which doesn't go through the protocol handler, so we
    // build the Bee gateway URL ourselves — same shape the bzz-protocol
    // handler ultimately proxies to.
    let url;
    if (uri.startsWith('bzz://')) {
      const afterScheme = uri.slice(6).replace(/^\/+/, '');
      const hash = afterScheme.split(/[/?#]/)[0];
      if (!hash || !/^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(hash)) {
        return NOOP_HANDLE;
      }
      url = `${getBeeApiUrl()}/bzz/${afterScheme}`;
    } else {
      const { converted, url: convertedUrl } = convertProtocolUrl(uri);
      if (!converted) return NOOP_HANDLE;
      url = convertedUrl;
    }

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
      log.debug(`[ens-prefetch] aborted ${sanitizeUrlForLog(url)}`);
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
      log.debug(`[ens-prefetch] ${sanitizeUrlForLog(url)} — ${err.message}`);
      markFinished();
    });
    request.end();

    timer = setTimeout(() => {
      if (!aborted) {
        log.debug(`[ens-prefetch] timeout ${sanitizeUrlForLog(url)}`);
        abort();
      }
    }, PREFETCH_TIMEOUT_MS);

    log.info(`[ens-prefetch] warming ${sanitizeUrlForLog(url)}`);
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
