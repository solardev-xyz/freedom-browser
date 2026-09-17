const log = require('./logger');
const { sanitizeUrlForLog } = require('./request-rewriter');
const { getAntApiUrl, getIpfsGatewayUrl } = require('./service-registry');
const { gatewayFetch } = require('./ipfs/gateway-transport');

// Hygiene timeout — not trust-critical. A misbehaving gateway shouldn't
// hold a socket open forever for speculative content the user may never
// see. Quorum outcomes typically tear prefetch down earlier via abort().
const PREFETCH_TIMEOUT_MS = 10_000;

const NOOP_HANDLE = Object.freeze({ abort: () => {} });

/**
 * Pull the body and throw it away. The point of the prefetch is the work the
 * *gateway* does fetching and caching the content; the bytes are of no use in
 * this process, but they have to be read for the gateway to do that work.
 *
 * The reader is cancelled on every exit path (natural end, read error, abort),
 * or the stream keeps pulling from a socket nobody is reading — the same rule
 * `src/main/http-fetch.js` follows.
 */
async function drainResponseBody(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) return;
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed or errored */
    }
  }
}

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

    // `bzz://` and `ipfs://` are now served by custom protocol handlers
    // in src/main/swarm/bzz-protocol.js and src/main/ipfs/ipfs-protocol.js,
    // so the request-rewriter no longer translates them. The prefetch
    // fires from the main process directly — bypassing the protocol
    // handlers — to warm the gateway's cache. We build the gateway URLs
    // ourselves; the same gateways the protocol handlers ultimately proxy
    // to, and through the same transport they use (`ipfs/gateway-transport`),
    // so a configured endpoint is dialled exactly one way in this app: a
    // loopback node over Node's `fetch`, anything else over Chromium with
    // the session's proxy policy, no HTTP cache and no `.onion` dial before
    // a proxy is actually routing it.
    let url;
    if (uri.startsWith('bzz://')) {
      const antApiUrl = getAntApiUrl();
      if (!antApiUrl) return NOOP_HANDLE;

      const afterScheme = uri.slice(6).replace(/^\/+/, '');
      const hash = afterScheme.split(/[/?#]/)[0];
      if (!hash || !/^[a-fA-F0-9]{64}([a-fA-F0-9]{64})?$/.test(hash)) {
        return NOOP_HANDLE;
      }
      url = `${antApiUrl}/bzz/${afterScheme}`;
    } else {
      // The registry publishes `ipfs.gateway` only for a node that committed to
      // serving (see publishExternalIpfsMode in main/ipfs-manager.js) — a
      // stopped, disabled or never-reachable external node reads null here, so
      // switching IPFS off in the nodes menu also stops this speculative traffic
      // instead of leaving a (possibly remote) gateway learning names the user
      // resolved but never visited. A gateway that goes down *after* it started
      // serving is the one case that keeps its URL published: the health check's
      // soft-ERROR branch deliberately keeps external mode up so it can recover
      // in place, so prefetches keep being dialled at it (and keep failing)
      // until it answers again or the user stops the node.
      const ipfsGatewayUrl = getIpfsGatewayUrl();
      if (!ipfsGatewayUrl) return NOOP_HANDLE;

      const afterScheme = uri.slice(7).replace(/^\/+/, '');
      const cid = afterScheme.split(/[/?#]/)[0];
      // CIDv1 base32 covers all codecs (`bafy…`, `bagu…`, `bah…`, …) —
      // see the `CID_RE` comment in `src/main/ipfs/ipfs-protocol.js` for
      // the codec-varint → 3rd-char mapping.
      if (
        !cid ||
        !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|ba[a-z2-7]{49,}|z[1-9A-HJ-NP-Za-km-z]{40,})$/i.test(cid)
      ) {
        return NOOP_HANDLE;
      }
      url = `${ipfsGatewayUrl}/ipfs/${afterScheme}`;
    }

    let aborted = false;
    let timer = null;
    const controller = new AbortController();

    // Request completed (or failed) — release the hygiene timer. A later
    // abort() then only signals a settled request, which is a no-op.
    const markFinished = () => {
      if (timer) { clearTimeout(timer); timer = null; }
    };

    const abort = () => {
      if (aborted) return;
      aborted = true;
      log.debug(`[ens-prefetch] aborted ${sanitizeUrlForLog(url)}`);
      markFinished();
      controller.abort();
    };

    // `redirect: 'manual'`, like every other dial of a configured gateway:
    // a hop is reported and dropped, never followed to wherever the gateway
    // points. Speculative traffic has no business chasing it.
    gatewayFetch(url, { method: 'GET', redirect: 'manual', signal: controller.signal })
      .then(drainResponseBody)
      .catch((err) => {
        // Includes the refusal to dial a `.onion` gateway the session is not
        // routing through a proxy — silent degradation, as everywhere here.
        log.debug(`[ens-prefetch] ${sanitizeUrlForLog(url)} — ${err?.message || err}`);
      })
      .finally(markFinished);

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
