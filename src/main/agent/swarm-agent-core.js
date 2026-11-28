'use strict';

/**
 * The agent's Swarm calls on the core's Swarm backend (freedom-core design
 * 0015, "Methods main calls" and "Every bee-js call, mapped"; the SWM-6 to
 * SWM-9 plan's PR 8.4): what swarm-publication-controller.js and
 * swarm-postage-readiness.js call in a process whose Swarm backend is
 * `core` (swarm/swarm-backend-kind.js, read once), in place of the JS
 * backend's publish-service.js, feed-service.js, swarm-signer.js and
 * swarm-service.js. Each answers as the function it replaces answers, so
 * the agent's modules run unchanged:
 *
 * - `publishData(data, options)`, `publishCollection(files, options)`:
 *   `swarm.publish` (`data` with one part, `collection` with a part per
 *   file), pinned, `deferred` as publish-service.js sends it, `encrypt` only
 *   for a draft, the agent's `batch` when it names one, and no `history`:
 *   the agent writes its own `freedom://agent` row before the upload, while
 *   it waits for postage, through publish-history.js's `coreOps` (PR 6.4).
 *   A part of at most 64 KiB of data goes inline; a larger one, and each
 *   file of a collection, is the bytes main holds, which the core pulls
 *   (`shell.swarm_part`). The answer, `{ reference, tag_uid, batch, bytes
 *   }`, is `normalizeUploadResult`'s.
 * - `getUploadStatus(tagUid)`: `swarm.upload_status { tag_uid }`,
 *   `normalizeTag`'s object, within bee-js's 10 s.
 * - `createFeed`, `updateFeed`, `readFeedState`: `swarm.feed` under the Bee
 *   wallet key (SW-1), its topic `Topic.fromString(topic)`'s 32 bytes,
 *   keccak256 of the string's UTF-8; `min_index` as `updateFeed`'s
 *   `minIndex`. The core signs with the vault's Bee wallet key, so each is
 *   sent only while that key's owner is still the one the caller's signer
 *   names (`feedSigner`), and a manifest the core made for another owner is
 *   refused. Each is cancelled once the controller stops waiting for it
 *   (60 s for a write, 10 s for a read).
 * - `feedSigner()`: the Bee wallet's owner (identity-manager.js), a locked
 *   vault refused with swarm-signer.js's text; it signs nothing in main.
 * - `getStamp(id)`: `swarm.stamps { id }`, the core's normalizer
 *   (bee-js's `mapPostageBatch`: sizes in bytes, the duration in seconds);
 *   `selectBestBatch(bytes, { requireCapacity })`: swarm-service.js's choice
 *   over `swarm.stamps {}`'s list, with its errors, codes and capacity.
 *
 * **The request** is core/swarm-own-calls.js's (PR 8.3), as freedom://publish
 * sends its own: `swarm.publish`'s params from `publishParams`, each request
 * sent as `shell` under its watchdog (`swarm.publish` an idle method, which
 * the executor moves on with its progress) and opened in main's executor
 * (core/swarm-shell.js) from its `onSent`, its answer read by
 * `readOwnAnswer`: the result of `swarm.publish`, `swarm.stamps` and
 * `swarm.upload_status` only in exactly the core's shape, what the core
 * threw as an Error with `message`, `code`, `status` and `capacity` (the
 * agent reads `status` for a known failure, `code` and `capacity` for
 * postage), anything else, and a parent main can't open, `CoreError`
 * `internal`. This module keeps only the agent's own: the feed ops under
 * the Bee wallet key and their owner checks, the batch choice, and each
 * answer mapped to what the agent's modules read.
 *
 * `swarm.publish` carries no total deadline: an upload the controller gave
 * up on can still answer, and the controller keeps that late receipt.
 */

const { keccak256, toUtf8Bytes, getAddress } = require('ethers');
const { createSwarmOwnCalls, swarmOwnCalls } = require('../core/swarm-own-calls');

// bee-js's `{ timeout: 10_000 }` on a stamp read and a tag read.
const READ_TIMEOUT_MS = 10_000;
// How long the controller waits for a feed write (its FEED_TIMEOUT_MS) and
// a feed read (its interactive timeout).
const FEED_WRITE_TIMEOUT_MS = 60_000;
const FEED_READ_TIMEOUT_MS = 10_000;
// swarm-service.js's selectBestBatch.
const SIZE_SAFETY_MARGIN = 1.5;
const VAULT_LOCKED_MESSAGE = 'Vault is locked';
const BEE_WALLET = Object.freeze({ kind: 'bee_wallet' });

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/** `Topic.fromString(text)`: keccak256 of its UTF-8, as 64 hex. */
function topicHex(text) {
  return keccak256(toUtf8Bytes(String(text))).slice(2);
}

/**
 * publish-service.js's `normalizeUploadResult` of the core's answer, which
 * `readOwnAnswer` read as exactly `{ reference, tag_uid, batch, bytes }`.
 */
function uploadResult(result) {
  return {
    reference: result.reference,
    bzzUrl: `bzz://${result.reference}`,
    tagUid: result.tag_uid || null,
    batchIdUsed: result.batch || null,
    bytesSize: result.bytes,
  };
}

/** Bytes as `Buffer.from` makes them: a string's UTF-8, else the view itself. */
function bytesOf(data) {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('Data must be a string or bytes');
}

/**
 * swarm-service.js's `selectBestBatch` over the core's normalized batches
 * (`swarm.stamps {}`): usable, `remainingSize` at least 1.5 times the
 * upload, the longest `duration`; else a propagating one with that room
 * (`propagating: true`, the node's own flag, which the core keeps). With
 * `requireCapacity`, none is its error, with `code` and `capacity`.
 */
function chooseBatch(batches, estimatedSizeBytes, { requireCapacity = false } = {}, log = null) {
  const requiredBytes = estimatedSizeBytes * SIZE_SAFETY_MARGIN;
  const remainingOf = (batch) => (finite(batch?.remainingSize) ? batch.remainingSize : 0);
  const ttlOf = (batch) => (finite(batch?.duration) ? batch.duration : 0);
  const usable = (batch) => batch?.usable === true;
  let best = null;
  let bestTtl = -1;
  let usableCount = 0;
  let largestRemaining = 0;
  for (const batch of batches) {
    if (!usable(batch)) continue;
    usableCount++;
    const remaining = remainingOf(batch);
    largestRemaining = Math.max(largestRemaining, remaining);
    const ttl = ttlOf(batch);
    if (remaining >= requiredBytes && ttl > bestTtl) {
      best = batch;
      bestTtl = ttl;
    }
  }
  if (!best && batches.some((batch) => !usable(batch))) {
    for (const batch of batches) {
      if (usable(batch) || batch?.propagating !== true) continue;
      const ttl = ttlOf(batch);
      if (remainingOf(batch) >= requiredBytes && ttl > bestTtl) {
        best = batch;
        bestTtl = ttl;
      }
    }
    if (best) {
      log?.info(
        `[SwarmPublication] Using propagating batch ${best.batchID}; the node holds the upload until the network knows it`
      );
    }
  }
  if (!best && requireCapacity) {
    const message = usableCount
      ? 'No postage batch has enough capacity for this upload. Select or purchase a suitable batch.'
      : 'No usable postage batch is available. Check your stamps before publishing.';
    throw Object.assign(new Error(message), {
      code: usableCount ? 'POSTAGE_CAPACITY_INSUFFICIENT' : 'POSTAGE_UNAVAILABLE',
      capacity: {
        uploadBytes: estimatedSizeBytes,
        requiredBytes: Math.ceil(requiredBytes),
        largestRemainingBytes: largestRemaining,
      },
    });
  }
  if (!best) return null;
  return String(best.batchID || '');
}

// The seams core/swarm-own-calls.js takes; each defaults to main's own.
const OWN_CALL_SEAMS = ['coreClient', 'swarmShell', 'nodeBackend', 'pool', 'now', 'log'];

/**
 * The agent's calls over main's core (core-process.js's client and Swarm
 * shell by default).
 *
 * @param {object} [deps] injected for tests, each defaulting to main's own:
 *   swarm-own-calls.js's seams (`coreClient()`, `swarmShell()`,
 *   `nodeBackend()`, `pool`, `now()`, `log`) and `beeWalletAddress()`
 */
function createAgentSwarmCore(deps = {}) {
  const beeWalletAddress =
    deps.beeWalletAddress || (() => require('../identity-manager').getBeeWalletAddress());
  const log = deps.log || require('../logger');
  // freedom://publish's own calls, unless a test gives seams of its own.
  const seams = Object.fromEntries(
    OWN_CALL_SEAMS.filter((seam) => deps[seam] !== undefined).map((seam) => [seam, deps[seam]])
  );
  const own = Object.keys(seams).length > 0 ? createSwarmOwnCalls(seams) : swarmOwnCalls();

  /** The Bee wallet's owner now, checksummed; a locked vault throws. */
  async function walletOwner() {
    const owner = await beeWalletAddress();
    if (!owner) throw new Error(VAULT_LOCKED_MESSAGE);
    return getAddress(owner);
  }

  /** Throws unless the Bee wallet's owner is still `signer`'s. */
  async function sameOwner(owner) {
    if ((await walletOwner()) !== getAddress(String(owner || ''))) {
      throw new Error('Your Swarm identity changed, so the feed was not written');
    }
  }

  return Object.freeze({
    /**
     * publish-service.js's `publishData`: `{ name?, contentType?, batchId?,
     * encrypt? }`, one `data` part (inline up to 64 KiB), not deferred.
     */
    async publishData(data, options = {}) {
      return uploadResult(
        await own.publish({
          kind: 'data',
          parts: [{ bytes: bytesOf(data) }],
          name: nonEmpty(options.name) ? options.name : undefined,
          contentType: nonEmpty(options.contentType) ? options.contentType : undefined,
          encrypt: options.encrypt === true,
          batch: options.batchId || undefined,
          deferred: false,
        })
      );
    },

    /**
     * publish-service.js's `publishCollection`: `[{ path, bytes }]`,
     * `{ indexDocument?, batchId?, encrypt? }`, a part per file, deferred.
     */
    async publishCollection(files, options = {}) {
      return uploadResult(
        await own.publish({
          kind: 'collection',
          parts: files.map((file) => ({ path: file.path, bytes: bytesOf(file.bytes) })),
          indexDocument: nonEmpty(options.indexDocument) ? options.indexDocument : undefined,
          encrypt: options.encrypt === true,
          batch: options.batchId || undefined,
          deferred: true,
        })
      );
    },

    /** publish-service.js's `getUploadStatus`. */
    getUploadStatus(tagUid) {
      return own.uploadStatus(tagUid, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    },

    /** The agent's signer: the Bee wallet's owner, which the core signs for. */
    async feedSigner() {
      const owner = await walletOwner();
      return { address: owner, signer: { owner } };
    },

    /** feed-service.js's `createFeed(signer, topicString, batchId)`. */
    async createFeed(signer, topicString, batchId) {
      await sameOwner(signer?.owner);
      const result = await own.call(
        'swarm.feed',
        { op: 'create', key: BEE_WALLET, topic: topicHex(topicString), ...(batchId && { batch: batchId }) },
        { signal: AbortSignal.timeout(FEED_WRITE_TIMEOUT_MS) }
      );
      if (getAddress(String(result?.owner || '')) !== getAddress(signer.owner)) {
        throw new Error('Your Swarm identity changed, so the feed was not written');
      }
      return result;
    },

    /** feed-service.js's `updateFeed(signer, topicString, reference, batchId, { minIndex })`. */
    async updateFeed(signer, topicString, contentReference, batchId, options = {}) {
      const minIndex =
        Number.isSafeInteger(options.minIndex) && options.minIndex > 0 ? options.minIndex : 0;
      await sameOwner(signer?.owner);
      return own.call(
        'swarm.feed',
        {
          op: 'update',
          key: BEE_WALLET,
          topic: topicHex(topicString),
          reference: contentReference,
          ...(minIndex > 0 && { min_index: minIndex }),
          ...(batchId && { batch: batchId }),
        },
        { signal: AbortSignal.timeout(FEED_WRITE_TIMEOUT_MS) }
      );
    },

    /** feed-service.js's `readFeedState(owner, topicString)`, for the Bee wallet's owner. */
    async readFeedState(owner, topicString) {
      await sameOwner(owner);
      return own.call(
        'swarm.feed',
        { op: 'read', key: BEE_WALLET, topic: topicHex(topicString) },
        { signal: AbortSignal.timeout(FEED_READ_TIMEOUT_MS) }
      );
    },

    /** bee-js's `stamp.get(id)` as the core normalizes it. */
    getStamp(id) {
      return own.stamps({ id }, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    },

    /** swarm-service.js's `selectBestBatch(bytes, { requireCapacity })` over the core's list. */
    async selectBestBatch(estimatedSizeBytes, options = {}) {
      const batches = await own.stamps({}, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      return chooseBatch(batches, estimatedSizeBytes, options, log);
    },
  });
}

let shared = null;

/** The agent's calls over main's own core, made once. */
function agentSwarmCore() {
  if (!shared) shared = createAgentSwarmCore();
  return shared;
}

module.exports = {
  READ_TIMEOUT_MS,
  agentSwarmCore,
  chooseBatch,
  createAgentSwarmCore,
  topicHex,
  uploadResult,
};
