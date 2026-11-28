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
 * **The parent:** from each request's `onSent`, before the core can ask
 * anything for it, main opens it in its executor (core/swarm-shell.js) with
 * its grammar row (`rowFor`), the params it sent, the node's transport
 * captured as it is sent (`antBackend()`: the default session's), its
 * signal and, but for `swarm.publish` (an idle method), the `swarm`
 * deadline, and a publish's parts. The parent closes with the request. A
 * parent main can't open ends the request, which fails.
 *
 * **The answer** is the core's typed form: `{ result_typed }`, read plain,
 * or `{ error_typed: { message, code?, status?, capacity? } }` (D5), thrown
 * as an Error with those fields, which the agent reads (`status` for a
 * known failure, `code` and `capacity` for postage). Any other form is the
 * core's fault, `CoreError` `internal`. The result's charge on the Swarm
 * I/O pool goes back once it is read. The protocol's own errors (`busy`,
 * `cancelled`, `core_unavailable`, …) are the client's `CoreError`s.
 *
 * `swarm.publish` carries no total deadline: an upload the controller gave
 * up on can still answer, and the controller keeps that late receipt.
 */

const { keccak256, toUtf8Bytes, getAddress } = require('ethers');
const { CoreError } = require('../core/service-client');
const { idleWatchdogMs, isIdleMethod, watchdogMs, SWARM_DEADLINE_MS } = require('../core/core-deadlines');
const { rowFor } = require('../core/swarm-grammar');
const { readPlain, TypedFormError } = require('../core/swarm-typed');

// A part of `swarm.publish` goes inline up to this (the core's INLINE_BYTES).
const INLINE_BYTES = 64 * 1024;
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

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;

/** `Topic.fromString(text)`: keccak256 of its UTF-8, as 64 hex. */
function topicHex(text) {
  return keccak256(toUtf8Bytes(String(text))).slice(2);
}

function malformed(method, why) {
  return new CoreError('internal', `The core's ${method} answer is malformed: ${why}`);
}

/** What a shell method threw (`{ message, code?, status?, capacity? }`), as an Error. */
function thrownError(method, value) {
  if (!isPlainObject(value)) throw malformed(method, 'error_typed is not an object');
  const { message, code, status, capacity } = value;
  const known = ['message', 'code', 'status', 'capacity'];
  if (
    typeof message !== 'string' ||
    Object.keys(value).some((key) => !known.includes(key)) ||
    (Object.hasOwn(value, 'code') && typeof code !== 'string') ||
    (Object.hasOwn(value, 'status') && !Number.isSafeInteger(status)) ||
    (Object.hasOwn(value, 'capacity') &&
      !(
        isPlainObject(capacity) &&
        ['uploadBytes', 'requiredBytes', 'largestRemainingBytes'].every((key) => finite(capacity[key]))
      ))
  ) {
    throw malformed(method, 'error_typed is not { message, code?, status?, capacity? }');
  }
  const err = new Error(message);
  if (Object.hasOwn(value, 'code')) err.code = code;
  if (Object.hasOwn(value, 'status')) err.status = status;
  if (Object.hasOwn(value, 'capacity')) {
    err.capacity = {
      uploadBytes: capacity.uploadBytes,
      requiredBytes: capacity.requiredBytes,
      largestRemainingBytes: capacity.largestRemainingBytes,
    };
  }
  return err;
}

/** The core's answer to `method`: its result, or what it threw, thrown. */
function readShellAnswer(method, answer) {
  if (!isPlainObject(answer)) throw malformed(method, 'not an object');
  const keys = Object.keys(answer);
  if (keys.length !== 1 || (keys[0] !== 'result_typed' && keys[0] !== 'error_typed')) {
    throw malformed(method, 'not { result_typed } or { error_typed }');
  }
  let value;
  try {
    value = readPlain(answer[keys[0]]);
  } catch (err) {
    if (err instanceof TypedFormError) throw malformed(method, err.message);
    throw err;
  }
  if (keys[0] === 'error_typed') throw thrownError(method, value);
  return value;
}

/** publish-service.js's `normalizeUploadResult` of the core's answer. */
function uploadResult(result) {
  if (
    !isPlainObject(result) ||
    typeof result.reference !== 'string' ||
    !(result.tag_uid === null || finite(result.tag_uid)) ||
    typeof result.batch !== 'string' ||
    !Number.isSafeInteger(result.bytes)
  ) {
    throw malformed('swarm.publish', 'not { reference, tag_uid, batch, bytes }');
  }
  const { reference } = result;
  return {
    reference,
    bzzUrl: reference ? `bzz://${reference}` : null,
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

function defaultDependencies() {
  return {
    coreClient: () => require('../core/core-process').getCoreClient(),
    swarmShell: () => require('../core/core-process').getSwarmShell(),
    // The node's transport, captured as each request is sent.
    nodeBackend: () => require('../swarm/bzz-protocol').antBackend(),
    beeWalletAddress: () => require('../identity-manager').getBeeWalletAddress(),
    pool: require('../core/swarm-io-pool').swarmIoPool,
    now: () => Date.now(),
    log: require('../logger'),
  };
}

/**
 * The agent's calls over main's core (core-process.js's client and Swarm
 * shell by default).
 *
 * @param {object} [deps] injected for tests; each defaults to main's own
 */
function createAgentSwarmCore(deps = {}) {
  const { coreClient, swarmShell, nodeBackend, beeWalletAddress, pool, now, log } = {
    ...defaultDependencies(),
    ...deps,
  };

  /**
   * Sends `method` as `shell` with `params` and opens it in the executor
   * from its `onSent`; resolves with its result, or rejects with what the
   * core threw or the protocol's error.
   */
  async function call(method, params, { parts = null, signal = null } = {}) {
    const client = coreClient();
    const shell = swarmShell();
    if (!client || !shell) throw new CoreError('core_unavailable', 'The identity core is not running');
    const row = rowFor(method, params);
    if (row === null) throw new TypeError(`${method} has no grammar row for these params`);
    const idle = isIdleMethod(method);
    // Ends the request if its parent can't be opened: the core is told.
    const own = new AbortController();
    const merged = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
    let parent = null;
    let unheld = false;
    let reply;
    try {
      reply = await client.request(
        method,
        params,
        { caller: 'shell' },
        {
          ...(idle ? { idleWatchdogMs: idleWatchdogMs(method) } : { watchdogMs: watchdogMs(method) }),
          signal: merged,
          pool,
          onSent: (id, generation) => {
            try {
              parent = shell.open(
                { generation, id },
                {
                  row,
                  params,
                  backend: nodeBackend(),
                  signal: merged,
                  deadlineAt: idle ? null : now() + SWARM_DEADLINE_MS,
                  parts,
                }
              );
            } catch (err) {
              unheld = true;
              log.warn('[SwarmPublication] a request could not be opened for the core', {
                row,
                reason: err?.name || 'Error',
              });
              own.abort();
            }
          },
        }
      );
    } catch (err) {
      if (unheld) throw new Error("The request couldn't be opened for the identity core's calls", { cause: err });
      throw err;
    } finally {
      parent?.close();
    }
    // Pooled, the result comes with its release (service-client.js).
    const { result, release } = pool ? reply : { result: reply, release: () => {} };
    try {
      return readShellAnswer(method, result);
    } finally {
      release();
    }
  }

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
    /** publish-service.js's `publishData`: `{ name?, contentType?, batchId?, encrypt? }`. */
    async publishData(data, options = {}) {
      const bytes = bytesOf(data);
      const inline = bytes.byteLength <= INLINE_BYTES;
      const part = inline
        ? { bytes: bytes.byteLength, base64: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64') }
        : { bytes: bytes.byteLength, part: 0 };
      const params = {
        kind: 'data',
        parts: [part],
        ...(nonEmpty(options.name) && { name: options.name }),
        ...(nonEmpty(options.contentType) && { content_type: options.contentType }),
        ...(options.encrypt === true && { encrypt: true }),
        ...(options.batchId && { batch: options.batchId }),
        pin: true,
        deferred: false,
      };
      const parts = inline ? null : new Map([[0, bytes]]);
      return uploadResult(await call('swarm.publish', params, { parts }));
    },

    /** publish-service.js's `publishCollection`: `[{ path, bytes }]`, `{ indexDocument?, batchId?, encrypt? }`. */
    async publishCollection(files, options = {}) {
      const parts = new Map();
      const entries = files.map((file, k) => {
        const bytes = bytesOf(file.bytes);
        parts.set(k, bytes);
        return { path: file.path, bytes: bytes.byteLength, part: k };
      });
      const params = {
        kind: 'collection',
        parts: entries,
        ...(nonEmpty(options.indexDocument) && { index_document: options.indexDocument }),
        ...(options.encrypt === true && { encrypt: true }),
        ...(options.batchId && { batch: options.batchId }),
        pin: true,
        deferred: true,
      };
      return uploadResult(await call('swarm.publish', params, { parts }));
    },

    /** publish-service.js's `getUploadStatus`. */
    getUploadStatus(tagUid) {
      return call('swarm.upload_status', { tag_uid: tagUid }, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    },

    /** The agent's signer: the Bee wallet's owner, which the core signs for. */
    async feedSigner() {
      const owner = await walletOwner();
      return { address: owner, signer: { owner } };
    },

    /** feed-service.js's `createFeed(signer, topicString, batchId)`. */
    async createFeed(signer, topicString, batchId) {
      await sameOwner(signer?.owner);
      const result = await call(
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
      return call(
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
      return call(
        'swarm.feed',
        { op: 'read', key: BEE_WALLET, topic: topicHex(topicString) },
        { signal: AbortSignal.timeout(FEED_READ_TIMEOUT_MS) }
      );
    },

    /** bee-js's `stamp.get(id)` as the core normalizes it. */
    getStamp(id) {
      return call('swarm.stamps', { id }, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
    },

    /** swarm-service.js's `selectBestBatch(bytes, { requireCapacity })` over the core's list. */
    async selectBestBatch(estimatedSizeBytes, options = {}) {
      const batches = await call('swarm.stamps', {}, { signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
      if (!Array.isArray(batches)) throw malformed('swarm.stamps', 'not a list');
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
  INLINE_BYTES,
  READ_TIMEOUT_MS,
  agentSwarmCore,
  chooseBatch,
  createAgentSwarmCore,
  readShellAnswer,
  topicHex,
  uploadResult,
};
