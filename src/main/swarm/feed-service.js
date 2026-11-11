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
const { dataSizeFromSpan } = require('./chunk-service');
const { noUsableBatchError } = require('./batch-errors');
const { currentVaultEpoch, assertVaultEpoch } = require('../identity/vault-epoch');
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
 * A queued write holds its signer's key until its turn. It runs only if the
 * vault epoch is still the one its key was read in (`epoch`, taken when it
 * was queued unless the caller read the key earlier): a lock meanwhile ends
 * the key's use (K-1).
 *
 * @param {string} topicHex - Topic hex string used as the lock key
 * @param {Function} fn - Async function to execute under the lock
 * @param {number} [epoch] - Vault epoch the signer key was read in
 * @returns {Promise<*>} Result of fn
 */
async function withWriteLock(topicHex, fn, epoch = currentVaultEpoch()) {
  const prev = writeLocks.get(topicHex) || Promise.resolve();
  const guarded = () => {
    assertVaultEpoch(epoch);
    return fn();
  };
  const next = prev.then(guarded, guarded);
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

// ---------------------------------------------------------------------------
// Metered reads — a page's feed read is paid for before its bytes are held
// ---------------------------------------------------------------------------

// Error bodies are read for their message only.
const MAX_ERROR_BODY_BYTES = 4096;

/**
 * A refusal from the read meter (see readFeedPayload), carried as an error
 * so the caller can hand the meter's own answer back to the page.
 */
function meterRefusal(refusal) {
  const err = new Error('Feed read refused by the read budget');
  err.refusal = refusal;
  return err;
}

/** A feed entry larger than one read may ever return. */
function entryTooLarge(limit, actual) {
  const err = new Error(`Feed entry exceeds the maximum read size of ${limit} bytes`);
  err.reason = 'data_too_large';
  err.limit = limit;
  if (actual !== undefined) err.actual = actual;
  return err;
}

/**
 * Read a node's response body piece by piece. `admit(bytes, total)` sees
 * each piece before it is kept and throws to refuse it; the body is then
 * cancelled, so the node stops sending and nothing past the refusal is held.
 *
 * @param {ReadableStream<Uint8Array>|null} body
 * @param {(bytes: number, total: number) => void} admit
 * @returns {Promise<Buffer>}
 */
async function readBodyAdmitted(body, admit) {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const pieces = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      admit(value.byteLength, total);
      pieces.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
  return Buffer.concat(pieces, total);
}

/** The first MAX_ERROR_BODY_BYTES of an error body, as text. */
async function readErrorText(body) {
  if (!body) return '';
  const reader = body.getReader();
  const pieces = [];
  let total = 0;
  try {
    while (total < MAX_ERROR_BODY_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      pieces.push(Buffer.from(value));
      total += value.byteLength;
    }
  } catch {
    // A broken error body leaves the status to speak for itself.
  }
  reader.cancel().catch(() => {});
  return Buffer.concat(pieces).subarray(0, MAX_ERROR_BODY_BYTES).toString('utf8');
}

/**
 * GET a node path and return the response once its headers are in, its body
 * unread. Failures read as bee-js's own: a BeeResponseError with the status
 * and bee-js's message (`statusText: body`) for an error status, and one
 * without a status for a network error, so callers tell them apart as they
 * do for bee-js's calls.
 */
async function fetchNode(bee, path) {
  const baseUrl = bee.url.endsWith('/') ? bee.url : `${bee.url}/`;
  const url = new URL(path, baseUrl).href;
  let response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json, text/plain, */*',
        // A compressed body would decode past its Content-Length.
        'accept-encoding': 'identity',
      },
    });
  } catch (err) {
    const message = err.cause?.message ? `${err.message}: ${err.cause.message}` : err.message;
    throw new BeeResponseError('GET', url, message);
  }
  if (!response.ok) {
    const raw = await readErrorText(response.body);
    let data;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = raw;
      }
    }
    const bodyMessage = typeof data === 'string' ? data : JSON.stringify(data);
    const message = bodyMessage ? `${response.statusText}: ${bodyMessage}` : response.statusText;
    throw new BeeResponseError('GET', url, message, data, response.status, response.statusText);
  }
  return response;
}

/** The body's declared length, or null when it has none it can be held to. */
function declaredLength(response) {
  const encoding = response.headers.get('content-encoding');
  if (encoding && encoding.toLowerCase() !== 'identity') return null;
  const value = response.headers.get('content-length');
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const length = Number(value.trim());
  return Number.isSafeInteger(length) ? length : null;
}

/**
 * The entry at an explicit index: its SOC first, then, for an entry larger
 * than one chunk, the node's join of the chunk the SOC wraps (`GET /bytes`).
 *
 * The SOC is charged as soon as it is read. The wrapped chunk's span gives
 * the entry's size. An entry that fits in the SOC is its payload held to that
 * size. A larger one past the meter's maxBytes is data_too_large; otherwise
 * the rest of its size (the SOC counts towards it) is reserved before
 * `/bytes` is asked for, and the join is held to that size.
 */
async function readExactFeedEntry(bee, owner, topic, index, meter) {
  const feedIndex = normalizeFeedIndex(index);
  const reference = bee.calculateSingleOwnerChunkAddress(makeFeedIdentifier(topic, feedIndex), owner);
  const raw = await bee.chunk.download(reference);
  // The SOC came off the network: charge it before any refusal.
  const socRefusal = meter.charge(raw.length);
  const soc = bee.unmarshalSingleOwnerChunk(raw, reference);
  const cac = bee.makeContentAddressedChunk(soc.payload, soc.span);

  // The entry's size, with the redundancy level cleared, as readData reads a root.
  const size = dataSizeFromSpan(cac.span.toUint8Array());
  let payload;
  if (cac.span.toBigInt() <= 4096n) {
    if (socRefusal) throw meterRefusal(socRefusal);
    // The entry is the SOC's payload held to that size, as readData holds a
    // one-chunk root: bytes past the span are not the entry, and a span past
    // the payload is an entry the chunk doesn't hold.
    const expected = Number(size);
    const inline = Buffer.from(cac.payload.toUint8Array());
    if (inline.length < expected) {
      throw new Error(`Node returned ${inline.length} bytes for a ${expected}-byte feed entry`);
    }
    payload = inline.subarray(0, expected);
  } else {
    if (size > BigInt(meter.maxBytes)) {
      throw entryTooLarge(meter.maxBytes, size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : size);
    }
    if (socRefusal) throw meterRefusal(socRefusal);
    const expected = Number(size);
    if (expected > raw.length) {
      const refusal = meter.reserve(expected - raw.length);
      if (refusal) throw meterRefusal(refusal);
    }
    const body = await bee.data.downloadReadable(toHex(cac.address));
    payload = await readBodyAdmitted(body, (_bytes, total) => {
      if (total > expected) {
        throw new Error(`Node returned more than ${expected} bytes for a ${expected}-byte feed entry`);
      }
    });
    if (payload.length !== expected) {
      throw new Error(`Node returned ${payload.length} bytes for a ${expected}-byte feed entry`);
    }
  }

  return { payload, feedIndex, feedIndexNext: feedIndex.next() };
}

/**
 * The latest entry, as the node resolves it (`GET /feeds/<owner>/<topic>`).
 * Its size is known only from the response. A declared Content-Length is
 * checked and reserved before the body is read, and the body is held to it;
 * a body without one is reserved piece by piece as it streams. Either way a
 * body past the meter's maxBytes is data_too_large and one past what is left
 * of the window is refused, and the body is cancelled there.
 */
async function readLatestFeedEntry(bee, owner, topic, meter) {
  const response = await fetchNode(bee, `feeds/${owner.toHex()}/${topic.toHex()}`);
  let feedIndex;
  let feedIndexNext;
  let declared;
  try {
    // The same headers, and the same errors when they are missing, as bee-js.
    const indexHeader = response.headers.get('swarm-feed-index');
    const nextHeader = response.headers.get('swarm-feed-index-next');
    if (!indexHeader) throw new Error('Response did not contain expected swarm-feed-index!');
    if (!nextHeader) throw new Error('Response did not contain expected swarm-feed-index-next!');
    feedIndex = new FeedIndex(indexHeader);
    feedIndexNext = new FeedIndex(nextHeader);

    declared = declaredLength(response);
    if (declared !== null) {
      if (declared > meter.maxBytes) throw entryTooLarge(meter.maxBytes, declared);
      const refusal = meter.reserve(declared);
      if (refusal) throw meterRefusal(refusal);
    }
  } catch (err) {
    response.body?.cancel().catch(() => {});
    throw err;
  }

  const payload = await readBodyAdmitted(response.body, (bytes, total) => {
    if (declared !== null) {
      if (total > declared) {
        throw new Error(`Node sent more than the ${declared} bytes it declared for the feed entry`);
      }
      return;
    }
    if (total > meter.maxBytes) throw entryTooLarge(meter.maxBytes);
    const refusal = meter.reserve(bytes);
    if (refusal) throw meterRefusal(refusal);
  });
  if (declared !== null && payload.length !== declared) {
    throw new Error(`Node sent ${payload.length} of the ${declared} bytes it declared for the feed entry`);
  }

  return { payload, feedIndex, feedIndexNext };
}

/**
 * Whether feed entry `index` exists, for a write at that index: its update
 * chunk (the SOC) is read and checked against its address. The SOC is the
 * entry, so the content it wraps is not fetched.
 *
 * Only a 404 means the index is free. A 500, a network error or timeout, or
 * an answer that is not that SOC can't tell a free index from an entry the
 * node failed to fetch, so it throws, and the write is refused rather than
 * written over an entry a reader would otherwise see (#1054). The caller
 * reports it as a node error, which the page may retry.
 */
async function feedEntryExists(bee, owner, topic, index) {
  const reference = bee.calculateSingleOwnerChunkAddress(makeFeedIdentifier(topic, index), owner);
  let raw;
  try {
    raw = await bee.chunk.download(reference);
  } catch (err) {
    if (err instanceof BeeResponseError && err.status === 404) return false;
    throw err;
  }
  bee.unmarshalSingleOwnerChunk(raw, reference);
  return true;
}

// Highest index the head probe will look for: 2^40 updates is far beyond any
// real feed, and it bounds the probe to ~80 chunk reads.
const MAX_PROBED_FEED_INDEX = 2 ** 40;

// Only a 404 says an update chunk is missing. A 500 ("read chunk failed")
// can't tell a missing chunk from an unreachable one, so it propagates:
// reading it as missing would call a live feed empty or under-read its head.
async function feedUpdateChunkExists(bee, owner, topic, index) {
  const reference = bee.calculateSingleOwnerChunkAddress(makeFeedIdentifier(topic, index), owner);
  try {
    await bee.chunk.download(reference);
    return true;
  } catch (err) {
    if (err instanceof BeeResponseError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Find a sequence feed's latest index by reading its update chunks directly,
 * for when the latest-update lookup (GET /feeds) answered "not found".
 *
 * That 404 is not proof the feed is empty: Ant also answers 404 ("wrapped
 * chunk cannot be retrieved") for a feed whose latest legacy (ts||ref)
 * update points at a chunk that is gone, e.g. after the content's batch
 * expired. The update chunks themselves can still be there, so ask for them
 * by address (GET /chunks): grow then bisect to the last index that exists.
 *
 * The probe assumes the updates are contiguous from index 0 to the head, as
 * a sequence feed writes them. Two cases break that and it then reads low:
 * - a gap (a missing intermediate update) ends the probe at the gap, so the
 *   head reads as the last index before it;
 * - a missing index 0 (the first update's batch expired while later ones,
 *   stamped on another batch, survive) reads as "no update", although the
 *   feed is live. Nothing on the network tells that apart from a new feed.
 * So a writer that knows a later index must pass it (updateFeed's minIndex),
 * and should read the feed back after writing (see readFeedState).
 *
 * @returns {Promise<number|null>} Latest index, or null when the feed has no update
 */
async function probeFeedHead(bee, owner, topic) {
  if (!(await feedUpdateChunkExists(bee, owner, topic, 0))) return null;
  let lo = 0; // known to exist
  let hi = 1; // first index not yet known to be missing
  while (hi <= MAX_PROBED_FEED_INDEX && await feedUpdateChunkExists(bee, owner, topic, hi)) {
    lo = hi;
    hi *= 2;
  }
  if (hi > MAX_PROBED_FEED_INDEX) {
    throw new Error('Feed head probe exceeded the maximum feed index');
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await feedUpdateChunkExists(bee, owner, topic, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Resolve the next available feed index using the public FeedReader API.
 * On a non-empty feed, downloads the latest payload to get feedIndexNext.
 * When that lookup answers "not found" (BeeResponseError 404/500), the
 * update chunks are probed directly (see probeFeedHead) and only a feed
 * with no update at index 0 starts at 0 — so a live feed whose latest
 * update's content expired is continued, not restarted under its own head.
 * All other errors (network, timeout) propagate to the caller.
 *
 * @param {import('@ethersphere/bee-js').FeedWriter|import('@ethersphere/bee-js').FeedReader} reader
 * @param {import('@ethersphere/bee-js').Bee} bee
 * @param {import('@ethersphere/bee-js').EthAddress} owner
 * @param {import('@ethersphere/bee-js').Topic} topic
 * @param {number} [minIndex=0] - Lowest index the caller will accept, from an
 *   index it already knows was written (the probe can read a live feed low)
 * @returns {Promise<number>} Next index to write at
 */
async function resolveNextIndex(reader, bee, owner, topic, minIndex = 0) {
  return Math.max(minIndex, await resolveNetworkNextIndex(reader, bee, owner, topic));
}

async function resolveNetworkNextIndex(reader, bee, owner, topic) {
  try {
    const latest = await reader.downloadPayload();
    if (latest.feedIndexNext) {
      return feedIndexToNumber(latest.feedIndexNext);
    }
    // feedIndexNext not set — fall back to feedIndex + 1
    return feedIndexToNumber(latest.feedIndex) + 1;
  } catch (err) {
    if (isNotFoundError(err)) {
      const head = await probeFeedHead(bee, owner, topic);
      return head === null ? 0 : head + 1;
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
    throw noUsableBatchError();
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
 * @param {{ minIndex?: number, epoch?: number }} [options] - minIndex: write at
 *   this index or later, for a caller that knows the feed already reached
 *   minIndex - 1. epoch: the vault epoch the key was read in (K-1); the
 *   write stops if the vault was locked since.
 * @returns {Promise<{ index: number }>}
 */
async function updateFeed(signerPrivateKey, topicString, contentReference, batchId, options = {}) {
  const epoch = Number.isSafeInteger(options.epoch) ? options.epoch : currentVaultEpoch();
  const minIndex = Number.isSafeInteger(options.minIndex) && options.minIndex > 0 ? options.minIndex : 0;
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const topic = Topic.fromString(topicString);

  const resolvedBatchId = batchId || await selectBestBatch(4096);
  if (!resolvedBatchId) {
    throw noUsableBatchError();
  }

  const topicHex = topic.toHex();

  const result = await withWriteLock(topicHex, async () => {
    const writer = bee.feed.makeWriter(topic, privateKey);
    const nextIndex = await resolveNextIndex(writer, bee, privateKey.publicKey().address(), topic, minIndex);
    assertVaultEpoch(epoch); // the index lookup awaited the network
    await writer.uploadReference(resolvedBatchId, contentReference, { index: nextIndex });
    return { index: nextIndex };
  }, epoch);

  log.info(`[FeedService] Feed updated: topic=${topicString}, ref=${contentReference}, index=${result.index}`);

  return { index: result.index };
}

/**
 * The page's payload can't be written. An SOC carries 1 to 4096 bytes and a
 * larger payload goes up through /bytes, so the one payload refused here is
 * an empty one, at the point where bee-js would refuse it as it builds the
 * chunk. `reason` marks it as the page's, so the provider tells it apart from
 * a node's failure whatever either one's message says (#1054).
 */
function unwritablePayloadError() {
  const err = new Error('A feed entry needs at least 1 byte of data');
  err.reason = 'payload_too_large';
  return err;
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
 * @param {{ batchId?: string, index?: number, epoch?: number }} [options] -
 *   epoch: the vault epoch the key was read in (K-1)
 * @returns {Promise<{ index: number }>}
 */
async function writeFeedPayload(signerPrivateKey, topicString, data, options = {}) {
  const { batchId, index } = options;
  const epoch = Number.isSafeInteger(options.epoch) ? options.epoch : currentVaultEpoch();
  const bee = getBee();
  const privateKey = new PrivateKey(signerPrivateKey);
  const topic = Topic.fromString(topicString);

  const dataSize = typeof data === 'string' ? Buffer.byteLength(data, 'utf-8') : data.length;
  const resolvedBatchId = batchId || await selectBestBatch(Math.max(dataSize, 4096));
  if (!resolvedBatchId) {
    throw noUsableBatchError();
  }

  const topicHex = topic.toHex();

  const result = await withWriteLock(topicHex, async () => {
    const writer = bee.feed.makeWriter(topic, privateKey);

    let writeIndex;
    if (index !== undefined && index !== null) {
      // Explicit index — check for existing entry (overwrite protection)
      if (await feedEntryExists(bee, privateKey.publicKey().address(), topic, index)) {
        const err = new Error(`Feed entry already exists at index ${index}`);
        err.reason = 'index_already_exists';
        throw err;
      }
      writeIndex = index;
    } else {
      // Auto-increment — resolve next available index
      writeIndex = await resolveNextIndex(writer, bee, privateKey.publicKey().address(), topic);
    }

    if (dataSize === 0) throw unwritablePayloadError();
    assertVaultEpoch(epoch); // the index checks awaited the network
    await writer.uploadPayload(resolvedBatchId, data, { index: writeIndex });
    return { index: writeIndex };
  }, epoch);

  log.info(`[FeedService] Feed payload written: topic=${topicString}, index=${result.index}`);

  return result;
}

/**
 * Read a feed entry at a specific index, or read the latest entry, paid for
 * through `meter` before its bytes are held (see readExactFeedEntry and
 * readLatestFeedEntry). The meter is the caller's read budget:
 * - `maxBytes`: the most one read may return; a larger entry is refused
 *   with an error whose `reason` is `data_too_large` (`limit`, and `actual`
 *   when the size is known), before its body is read;
 * - `charge(bytes)`: bytes that already came off the network, charged
 *   whatever happens next;
 * - `reserve(bytes)`: bytes about to be read, reserved in one step or not
 *   at all.
 * `charge` and `reserve` return null, or a refusal; a refusal is thrown as an
 * error whose `refusal` is that value, and nothing more is read.
 *
 * @param {string} ownerAddress - Feed owner Ethereum address (hex, with or without 0x)
 * @param {import('@ethersphere/bee-js').Topic} topic - Topic object (already resolved — not a string)
 * @param {number} [index] - Specific index to read. If omitted, reads latest.
 * @param {{ maxBytes: number, charge: (bytes: number) => any, reserve: (bytes: number) => any }} meter
 * @returns {Promise<{ payload: Buffer, index: number, nextIndex: number|null }>}
 */
async function readFeedPayload(ownerAddress, topic, index, meter) {
  // Every read is metered: a missing meter is the caller's bug, refused here
  // before anything is asked of the node rather than as a TypeError midway.
  if (
    !meter ||
    !Number.isSafeInteger(meter.maxBytes) ||
    meter.maxBytes < 0 ||
    typeof meter.charge !== 'function' ||
    typeof meter.reserve !== 'function'
  ) {
    throw new TypeError('readFeedPayload needs a read meter ({ maxBytes, charge, reserve })');
  }
  const bee = getBee();
  const owner = new EthAddress(ownerAddress);

  try {
    const result = index !== undefined && index !== null
      ? await readExactFeedEntry(bee, owner, topic, index, meter)
      : await readLatestFeedEntry(bee, owner, topic, meter);

    const readIndex = feedIndexToNumber(result.feedIndex);
    const nextIndex = result.feedIndexNext
      ? feedIndexToNumber(result.feedIndexNext)
      : null;

    return { payload: result.payload, index: readIndex, nextIndex };
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

/**
 * Whether a feed already has an update, read before asking to write one.
 * A 404 from the latest-update lookup is checked against the update chunks
 * themselves (probeFeedHead): Ant also answers 404 for a live feed whose
 * latest update's content has expired, and that feed must still read as
 * existing. A 500 or a network error, from either the lookup or a chunk
 * probe, can't tell an empty feed from an unreachable one, so it throws and
 * the caller reads it as unknown.
 *
 * `exists: false` means no update was found, not that none was ever written:
 * a feed whose index-0 update expired with its batch reads the same (see
 * probeFeedHead). Callers that write must not take it as proof of an empty
 * feed; the publication controller reads the feed back after updating it.
 *
 * @param {string} ownerAddress - 0x-prefixed owner address
 * @param {string} topicString - Topic string (as passed to updateFeed)
 * @returns {Promise<{ exists: true, index: number } | { exists: false }>}
 */
async function readFeedState(ownerAddress, topicString) {
  const bee = getBee();
  const topic = Topic.fromString(topicString);
  const owner = new EthAddress(ownerAddress);
  const reader = bee.feed.makeReader(topic, owner);
  try {
    const latest = await reader.downloadPayload();
    return { exists: true, index: feedIndexToNumber(latest.feedIndex) };
  } catch (err) {
    if (!(err instanceof BeeResponseError && err.status === 404)) throw err;
  }
  const head = await probeFeedHead(bee, owner, topic);
  return head === null ? { exists: false } : { exists: true, index: head };
}

module.exports = {
  buildTopicString,
  readFeedState,
  createFeed,
  updateFeed,
  writeFeedPayload,
  readFeedPayload,
  withWriteLock,
  feedIndexToNumber,
  isNotFoundError,
};
