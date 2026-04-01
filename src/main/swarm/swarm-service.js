/**
 * Swarm Service
 *
 * Owns the bee-js Bee client instance and exposes it to other main-process
 * modules. The client is created lazily from the service registry's active
 * Bee API URL and recreated if the URL changes.
 */

const { Bee } = require('@ethersphere/bee-js');
const { getBeeApiUrl } = require('../service-registry');
const log = require('electron-log');

let beeClient = null;
let beeClientUrl = null;

/**
 * Get or create the Bee client. Recreates if the Bee API URL has changed.
 */
function getBee() {
  const url = getBeeApiUrl();
  if (!beeClient || beeClientUrl !== url) {
    beeClient = new Bee(url);
    beeClientUrl = url;
    log.info(`[SwarmService] Bee client created for ${url}`);
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
 */
async function selectBestBatch(estimatedSizeBytes) {
  const bee = getBee();
  const batches = await bee.getPostageBatches();

  const requiredBytes = estimatedSizeBytes * SIZE_SAFETY_MARGIN;

  let best = null;
  let bestTtl = -1;

  for (const batch of batches) {
    if (!batch.usable) continue;

    const remaining = batch.remainingSize && typeof batch.remainingSize.toBytes === 'function'
      ? batch.remainingSize.toBytes()
      : 0;

    if (remaining < requiredBytes) continue;

    const ttl = batch.duration && typeof batch.duration.toSeconds === 'function'
      ? batch.duration.toSeconds()
      : 0;

    if (ttl > bestTtl) {
      best = batch;
      bestTtl = ttl;
    }
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
