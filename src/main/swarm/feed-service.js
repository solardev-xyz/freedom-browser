/**
 * Feed Service
 *
 * Feed creation, update, payload write, and payload read via bee-js SOC/feeds API.
 * Runs in the main process only — provider-ipc orchestrates calls.
 *
 * Write serialization: all feed writes are serialized per-topic via withWriteLock()
 * to prevent index collisions from concurrent callers.
 */

const { PrivateKey, Topic, EthAddress, BeeResponseError, Bytes, Identifier, FeedIndex } = require('@ethersphere/bee-js');
const { getBee, selectBestBatch, toHex } = require('./swarm-service');
const log = require('electron-log');

// ---------------------------------------------------------------------------
// Write mutex — per-topic serialization for feed writes
// ---------------------------------------------------------------------------

const writeLocks = new Map();

/**
 * Serialize writes to the same topic. Concurrent writes to different topics
 * are fully parallel. The lock chains via .then(fn, fn) so a failed write
 * does not block subsequent writes.
 *
 * @param {string} topicHex - Topic hex string used as the lock key
 * @param {Function} fn - Async function to execute under the lock
 * @returns {Promise<*>} Result of fn
 */
async function withWriteLock(topicHex, fn) {
  const prev = writeLocks.get(topicHex) || Promise.resolve();
  const next = prev.then(fn, fn);
  writeLocks.set(topicHex, next);
  try {
    return await next;
  } finally {
    if (writeLocks.get(topicHex) === next) {
      writeLocks.delete(topicHex);
    }
  }
}

// ---------------------------------------------------------------------------
// Error discrimination
// ---------------------------------------------------------------------------

/**
 * Check whether an error from bee-js represents a "not found" condition
 * (HTTP 404 or 500 from the Bee API). Only BeeResponseError with these
 * status codes should be treated as "entry missing". All other errors
 * (network failures, timeouts, parse errors) must propagate so callers
 * don't silently proceed on transient failures.
 *
 * Intentionally stricter than bee-js's own `findNextIndex`, which catches
 * any BeeResponseError regardless of status. We only treat 404/500 as
 * "not found" to avoid silently resetting to index 0 on transient errors.
 */
function isNotFoundError(err) {
  return err instanceof BeeResponseError && (err.status === 404 || err.status === 500);
}

// ---------------------------------------------------------------------------
// Topic and index helpers
// ---------------------------------------------------------------------------

/**
 * Build the topic string for a feed: normalizedOrigin + "/" + feedName.
 * Used by both createFeed and updateFeed to ensure consistent topic derivation.
 * @param {string} normalizedOrigin
 * @param {string} feedName
 * @returns {string}
 */
function buildTopicString(normalizedOrigin, feedName) {
  return `${normalizedOrigin}/${feedName}`;
}

/**
 * Convert a FeedIndex to a JS number.
 * FeedIndex is a Bytes(8) with a toBigInt() method.
 * @param {import('@ethersphere/bee-js').FeedIndex} feedIndex
 * @returns {number}
 */
function feedIndexToNumber(feedIndex) {
  return Number(feedIndex.toBigInt());
}

function normalizeFeedIndex(index) {
  return typeof index === 'number' ? FeedIndex.fromBigInt(BigInt(index)) : index;
}

function concatUint8Arrays(parts) {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function makeFeedIdentifier(topic, index) {
  const feedIndex = normalizeFeedIndex(index);
  return new Identifier(Bytes.keccak256(concatUint8Arrays([
    topic.toUint8Array(),
    feedIndex.toUint8Array(),
  ])).toUint8Array());
}

async function downloadExactFeedPayload(bee, owner, topic, index) {
  const feedIndex = normalizeFeedIndex(index);
  const identifier = makeFeedIdentifier(topic, feedIndex);
  const reference = bee.calculateSingleOwnerChunkAddress(identifier, owner);
  const raw = await bee.chunk.download(reference);
  const soc = bee.unmarshalSingleOwnerChunk(raw, reference);
  const cac = bee.makeContentAddressedChunk(soc.payload, soc.span);
  const payload = cac.span.toBigInt() <= 4096n
    ? cac.payload
    : await bee.data.download(cac.address);

  return {
    payload,
    feedIndex,
    feedIndexNext: feedIndex.next(),
  };
}

/**
 * Resolve the next available feed index using the public FeedReader API.
 * On a non-empty feed, downloads the latest payload to get feedIndexNext.
 * On an empty feed (BeeResponseError 404/500), defaults to 0.
 * All other errors (network, timeout) propagate to the caller.
 *
 * @param {import('@ethersphere/bee-js').FeedWriter|import('@ethersphere/bee-js').FeedReader} reader
 * @returns {Promise<number>} Next index to write at
 */
async function resolveNextIndex(reader) {
  try {
    const latest = await reader.downloadPayload();
    if (latest.feedIndexNext) {
      return feedIndexToNumber(latest.feedIndexNext);
    }
    // feedIndexNext not set — fall back to feedIndex + 1
    return feedIndexToNumber(latest.feedIndex) + 1;
  } catch (err) {
    if (isNotFoundError(err)) {
      return 0;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Feed operations
// ---------------------------------------------------------------------------

/**
 * Create a feed and its manifest.
 * The manifest provides a stable bzz:// URL that always resolves to the
 * latest feed update.
 *
 * @param {string} signerPrivateKey - 0x-prefixed hex private key
 * @param {string} topicString - Topic string (from buildTopicString)
 * @param {string} [batchId] - Postage batch ID. Auto-selected if omitted.
 * @returns {Promise<{ topic: string, owner: string, manifestReference: string, bzzUrl: string }>}
 */
async function createFeed(signerPrivateKey, topicString, batchId) {
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const owner = privateKey.publicKey().address();
  const topic = Topic.fromString(topicString);

  const resolvedBatchId = batchId || await selectBestBatch(4096);
  if (!resolvedBatchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const manifest = await bee.feed.createManifest(resolvedBatchId, topic, owner);
  const manifestReference = toHex(manifest);

  log.info(`[FeedService] Feed created: topic=${topicString}, owner=${owner.toHex()}`);

  return {
    topic: topic.toHex(),
    owner: owner.toChecksum(),
    manifestReference,
    bzzUrl: `bzz://${manifestReference}`,
  };
}

/**
 * Update a feed to point at a new content reference.
 * Wrapped in the per-topic write lock to prevent index collisions.
 *
 * @param {string} signerPrivateKey - 0x-prefixed hex private key
 * @param {string} topicString - Topic string (from buildTopicString)
 * @param {string} contentReference - Swarm reference to point the feed at
 * @param {string} [batchId] - Postage batch ID. Auto-selected if omitted.
 * @returns {Promise<{ index: number }>}
 */
async function updateFeed(signerPrivateKey, topicString, contentReference, batchId) {
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const topic = Topic.fromString(topicString);

  const resolvedBatchId = batchId || await selectBestBatch(4096);
  if (!resolvedBatchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const topicHex = topic.toHex();

  const result = await withWriteLock(topicHex, async () => {
    const writer = bee.feed.makeWriter(topic, privateKey);
    const nextIndex = await resolveNextIndex(writer);
    await writer.uploadReference(resolvedBatchId, contentReference, { index: nextIndex });
    return { index: nextIndex };
  });

  log.info(`[FeedService] Feed updated: topic=${topicString}, ref=${contentReference}, index=${result.index}`);

  return { index: result.index };
}

/**
 * Write arbitrary payload data to a feed index as a Single Owner Chunk.
 * Wrapped in the per-topic write lock.
 *
 * If index is omitted, auto-increments to the next available index.
 * If index is provided, checks for existing entry (overwrite protection).
 *
 * Note: bee-js handles payloads > 4096 bytes by uploading via /bytes and
 * wrapping the root chunk into the SOC. The batch size estimate uses the
 * actual payload size so stamp selection accounts for larger entries.
 *
 * @param {string} signerPrivateKey - 0x-prefixed hex private key
 * @param {string} topicString - Topic string (from buildTopicString)
 * @param {string|Buffer|Uint8Array} data - Payload to write
 * @param {{ batchId?: string, index?: number }} [options]
 * @returns {Promise<{ index: number }>}
 */
async function writeFeedPayload(signerPrivateKey, topicString, data, options = {}) {
  const { batchId, index } = options;
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const topic = Topic.fromString(topicString);

  const dataSize = typeof data === 'string' ? Buffer.byteLength(data, 'utf-8') : data.length;
  const resolvedBatchId = batchId || await selectBestBatch(Math.max(dataSize, 4096));
  if (!resolvedBatchId) {
    throw new Error('No usable postage batch available. Purchase stamps first.');
  }

  const topicHex = topic.toHex();

  const result = await withWriteLock(topicHex, async () => {
    const writer = bee.feed.makeWriter(topic, privateKey);

    let writeIndex;
    if (index !== undefined && index !== null) {
      // Explicit index — check for existing entry (overwrite protection)
      try {
        await downloadExactFeedPayload(bee, privateKey.publicKey().address(), topic, index);
        const err = new Error(`Feed entry already exists at index ${index}`);
        err.reason = 'index_already_exists';
        throw err;
      } catch (e) {
        if (e.reason === 'index_already_exists') throw e;
        // Only treat "not found" as "index available". Other errors propagate.
        if (!isNotFoundError(e)) throw e;
      }
      writeIndex = index;
    } else {
      // Auto-increment — resolve next available index
      writeIndex = await resolveNextIndex(writer);
    }

    await writer.uploadPayload(resolvedBatchId, data, { index: writeIndex });
    return { index: writeIndex };
  });

  log.info(`[FeedService] Feed payload written: topic=${topicString}, index=${result.index}`);

  return result;
}

/**
 * Read a feed entry at a specific index, or read the latest entry.
 *
 * @param {string} ownerAddress - Feed owner Ethereum address (hex, with or without 0x)
 * @param {import('@ethersphere/bee-js').Topic} topic - Topic object (already resolved — not a string)
 * @param {number} [index] - Specific index to read. If omitted, reads latest.
 * @returns {Promise<{ payload: Buffer, index: number, nextIndex: number|null }>}
 */
async function readFeedPayload(ownerAddress, topic, index) {
  const bee = getBee();
  const owner = new EthAddress(ownerAddress);
  const reader = bee.feed.makeReader(topic, owner);

  try {
    const result = index !== undefined && index !== null
      ? await downloadExactFeedPayload(bee, owner, topic, index)
      : await reader.downloadPayload();

    const payload = Buffer.from(result.payload.toUint8Array());
    const readIndex = feedIndexToNumber(result.feedIndex);
    const nextIndex = result.feedIndexNext
      ? feedIndexToNumber(result.feedIndexNext)
      : null;

    return { payload, index: readIndex, nextIndex };
  } catch (err) {
    // Only map "not found" errors to semantic reasons.
    // All other errors (network, timeout, parse) propagate as-is.
    if (!isNotFoundError(err)) throw err;

    if (index !== undefined && index !== null) {
      const error = new Error(`Feed entry not found at index ${index}`);
      error.reason = 'entry_not_found';
      throw error;
    }
    const error = new Error('Feed is empty — no entries to read');
    error.reason = 'feed_empty';
    throw error;
  }
}

module.exports = {
  buildTopicString,
  createFeed,
  updateFeed,
  writeFeedPayload,
  readFeedPayload,
  withWriteLock,
  feedIndexToNumber,
  isNotFoundError,
};
