/**
 * Swarm Service
 *
 * Owns the bee-js Bee client instance and exposes it to other main-process
 * modules. The client is created lazily from the service registry's active
 * Bee API URL and recreated if the URL changes.
 */

const { Bee } = require('@ethersphere/bee-js');
const { getAntApiUrl } = require('../service-registry');
const log = require('electron-log');

let beeClient = null;
let beeClientUrl = null;

/**
 * Get or create the Bee client. Recreates if the Bee API URL has changed.
 */
function getBee() {
  const url = getAntApiUrl();
  if (!url) {
    throw new Error('Swarm node is not ready');
  }
  if (!beeClient || beeClientUrl !== url) {
    beeClient = new Bee(url);
    beeClientUrl = url;
    log.info(`[SwarmService] Ant node client created for ${url}`);
  }
  return beeClient;
}

/**
 * Reset the cached client (e.g. on Bee restart).
 */
function resetBeeClient() {
  beeClient = null;
  beeClientUrl = null;
}

const SIZE_SAFETY_MARGIN = 1.5;

/**
 * Select the best usable postage batch for an upload of the given size.
 * "Best" = usable, enough remaining space (with 1.5x safety margin),
 * longest TTL. Returns the batch ID hex string, or null if none qualifies.
 *
 * With `allowFullMutable`, a usable mutable batch without remaining space
 * is accepted as a fallback when no batch has room. bee-js reports
 * remainingSize 0 once a mutable batch's buckets are full, but the node
 * keeps accepting writes by overwriting the oldest stamp per bucket —
 * which evicts whatever those stamps protected. That trade-off is only
 * acceptable for ephemeral traffic (messaging), never for content
 * publishes, so it is opt-in per call site.
 */
async function selectBestBatch(estimatedSizeBytes, options = {}) {
  const bee = getBee();
  const batches = await bee.getPostageBatches();

  const requiredBytes = estimatedSizeBytes * SIZE_SAFETY_MARGIN;

  let best = null;
  let bestTtl = -1;
  let fullMutable = null;
  let fullMutableTtl = -1;

  for (const batch of batches) {
    if (!batch.usable) continue;

    const remaining = batch.remainingSize && typeof batch.remainingSize.toBytes === 'function'
      ? batch.remainingSize.toBytes()
      : 0;

    const ttl = batch.duration && typeof batch.duration.toSeconds === 'function'
      ? batch.duration.toSeconds()
      : 0;

    if (remaining >= requiredBytes) {
      if (ttl > bestTtl) {
        best = batch;
        bestTtl = ttl;
      }
    } else if (options.allowFullMutable && batch.immutableFlag !== true && ttl > fullMutableTtl) {
      fullMutable = batch;
      fullMutableTtl = ttl;
    }
  }

  if (!best && fullMutable) {
    best = fullMutable;
    log.warn(
      `[SwarmService] No batch with remaining capacity; falling back to full mutable batch ${toHex(fullMutable.batchID)} — new stamps overwrite its oldest ones`
    );
  }

  if (!best) return null;

  const id = best.batchID;
  return id && typeof id.toHex === 'function' ? id.toHex() : String(id || '');
}

/**
 * Convert a bee-js typed-bytes object (BatchId, Reference, etc.) to hex string.
 */
function toHex(value, fallback = '') {
  if (value && typeof value.toHex === 'function') return value.toHex();
  return String(value || fallback);
}

module.exports = {
  getBee,
  resetBeeClient,
  selectBestBatch,
  toHex,
};
