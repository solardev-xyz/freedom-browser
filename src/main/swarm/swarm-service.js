/**
 * Swarm Service
 *
 * Owns the bee-js Bee client instance and exposes it to other main-process
 * modules. The client is created lazily from the service registry's active
 * Bee API URL and recreated if the URL changes.
 */

const { Bee } = require('@ethersphere/bee-js');
const { getAntApiUrl } = require('../service-registry');
const antApi = require('./ant-storage-api');
const log = require('electron-log');

let beeClient = null;
let beeClientUrl = null;

/**
 * Get or create the Bee client. Recreates if the Bee API URL has changed.
 */
function getBee() {
  // bee-js brings its own HTTP stack, which does not honour `session.setProxy`
  // — an external Ant API on a `.onion` host is not reached over Tor. Tracked
  // with the other Swarm call sites in #360.
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
 * Whether the node can stamp uploads with this batch. The one usable-stamp
 * check in Freedom: it takes the node's raw `/stamps` JSON and bee-js batch
 * objects alike, and publish readiness, the swarm provider and batch
 * selection all use it.
 */
function isUsableStamp(batch) {
  return batch?.usable === true;
}

/**
 * Whether a batch the node does not let stamp yet is on its way to usable.
 * Ant v0.5.52+ says so outright: `propagating` is true while a batch this
 * node just bought is inside bee's ~70 s confirmation window, and false for
 * one waiting won't fix (storer peers rejected it, or the chain says it is
 * gone or expired). A node that sends no flag (older Ant, bee) is read by
 * bee's "exists, awaiting confirmations" shape instead, which cannot tell a
 * fresh batch from a rejected one.
 *
 * Takes the node's raw `/stamps` JSON: bee-js drops `exists` and
 * `propagating` and clamps `batchTTL` to at least 1.
 */
function isPendingStamp(batch) {
  if (!batch || batch.usable === true) return false;
  if (typeof batch.propagating === 'boolean') return batch.propagating;
  return batch.exists !== false && Number(batch.batchTTL) > 0;
}

/**
 * Whether uploads can use a not-yet-usable batch right away: Ant accepts a
 * propagating batch and holds each push until the network knows it. Only a
 * node that reports the flag promises that. Raw `/stamps` JSON, as above.
 */
function isPropagatingStamp(batch) {
  return batch?.usable !== true && batch?.propagating === true;
}

/**
 * Whether an immutable batch has no room left, from the node's raw `/stamps`
 * JSON: its fullest bucket holds `2^(depth - bucketDepth)` chunks, and an
 * immutable batch refuses a stamp once it is reached. bee-js reports such a
 * batch's remainingSize as 0, so selectBestBatch never picks it; readiness
 * must not count it as storage either. A full *mutable* batch keeps
 * stamping by overwriting its oldest stamps (see selectBestBatch), so only
 * the immutable kind is full here.
 */
function isFullImmutableStamp(batch) {
  if (batch?.immutableFlag !== true) return false;
  const { utilization, depth, bucketDepth } = batch;
  if (![utilization, depth, bucketDepth].every(Number.isInteger) || depth < bucketDepth) {
    return false;
  }
  return utilization >= 2 ** (depth - bucketDepth);
}

/**
 * The key a batch ID is compared by: lower-case hex without a `0x` prefix.
 * bee-js `toHex()` gives bare hex; a node's raw `/stamps` JSON may carry
 * either form, so every comparison between the two goes through this.
 */
function batchIdKey(value) {
  return toHex(value).trim().replace(/^0x/i, '').toLowerCase();
}

/**
 * IDs of the node's propagating batches, from its raw `/stamps` (bee-js
 * drops the flag), as batchIdKey keys. Empty when the node can't be read:
 * the caller then treats the batch as not usable, as it did before the flag
 * existed.
 */
async function getPropagatingBatchIds() {
  const res = await antApi.getStamps();
  const stamps = res.ok && Array.isArray(res.data?.stamps) ? res.data.stamps : [];
  return new Set(stamps.filter(isPropagatingStamp).map((s) => batchIdKey(s.batchID)));
}

/**
 * Select the best postage batch for an upload of the given size.
 * "Best" = usable, enough remaining space (with 1.5x safety margin),
 * longest TTL. Returns the batch ID hex string, or null if none qualifies.
 *
 * When no usable batch has room, a propagating one that does is next (see
 * isPropagatingStamp): a publish started right after a buy then waits in
 * the node for the network instead of failing here.
 *
 * With `allowFullMutable`, a usable mutable batch without remaining space
 * is the last fallback. bee-js reports remainingSize 0 once a mutable
 * batch's buckets are full, but the node keeps accepting writes by
 * overwriting the oldest stamp per bucket — which evicts whatever those
 * stamps protected. That trade-off is only acceptable for ephemeral
 * traffic (messaging), never for content publishes, so it is opt-in per
 * call site. Freedom buys immutable batches, so only a batch bought
 * elsewhere or before that can be such a fallback.
 */
async function selectBestBatch(estimatedSizeBytes, options = {}) {
  const bee = getBee();
  const batches = await bee.stamp.getAll();

  const requiredBytes = estimatedSizeBytes * SIZE_SAFETY_MARGIN;
  const remainingOf = (batch) =>
    batch.remainingSize && typeof batch.remainingSize.toBytes === 'function'
      ? batch.remainingSize.toBytes()
      : 0;
  const ttlOf = (batch) =>
    batch.duration && typeof batch.duration.toSeconds === 'function'
      ? batch.duration.toSeconds()
      : 0;

  let best = null;
  let bestTtl = -1;
  let fullMutable = null;
  let fullMutableTtl = -1;

  for (const batch of batches) {
    if (!isUsableStamp(batch)) continue;

    const remaining = remainingOf(batch);
    const ttl = ttlOf(batch);

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

  if (!best && batches.some((batch) => !isUsableStamp(batch))) {
    const propagating = await getPropagatingBatchIds();
    for (const batch of batches) {
      if (isUsableStamp(batch) || !propagating.has(batchIdKey(batch.batchID))) continue;
      const ttl = ttlOf(batch);
      if (remainingOf(batch) >= requiredBytes && ttl > bestTtl) {
        best = batch;
        bestTtl = ttl;
      }
    }
    if (best) {
      log.info(
        `[SwarmService] Using propagating batch ${toHex(best.batchID)}; the node holds the upload until the network knows it`
      );
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
  isUsableStamp,
  isPendingStamp,
  isPropagatingStamp,
  isFullImmutableStamp,
  batchIdKey,
  getPropagatingBatchIds,
  toHex,
};
