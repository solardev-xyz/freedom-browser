'use strict';

/**
 * Whether the postage batch an agent publication uses can stamp it yet, and
 * what the approval card shows about it.
 *
 * Its reads follow the Swarm switch (swarm/swarm-backend-kind.js, read
 * once; freedom-core design 0015, "Every bee-js call, mapped"; the SWM-6 to
 * SWM-9 plan's PR 8.4), chosen at each call:
 * - on `js`, bee-js through swarm-service.js: `selectBestBatch` over
 *   `stamp.getAll`, `stamp.get`, `stamp.getGlobal` and
 *   `status.getChainState`;
 * - on `core`, the core's `swarm.stamps` for the batch list (the same
 *   choice, swarm-agent-core.js) and for one batch (`{ id }`), and `GET
 *   /batches/<id>` and `GET /chainstate` on the node's transport
 *   (swarm-node-reads.js), mapped as bee-js maps them.
 * Either way the batch reads as `{ usable, amount, ttlSeconds,
 * remainingBytes }` and the rest as bee-js gives it.
 */

const crypto = require('crypto');
const { getAntApiUrl } = require('../service-registry');

const SETTLEMENT_BLOCKS = 10;
const READ_TIMEOUT_MS = 10_000;
const CHUNK_BYTES = 4096;
// Below this the approval card warns that the batch is close to expiry; the
// same thresholds as the Storage screen (stamp-manager.js).
const TTL_WARN_SECONDS = 7 * 86_400;
const TTL_CRITICAL_SECONDS = 86_400;

// Chunks an upload of `bytes` stamps: its data chunks, the intermediate
// chunks of the Swarm hash tree (128 references per chunk, 64 when each
// reference also carries a decryption key), and about one manifest chunk per
// file. An estimate for the approval card, not an exact count.
function estimateChunks(bytes, { encrypted = false, files = 1 } = {}) {
  const data = Math.max(1, Math.ceil(Math.max(0, bytes) / CHUNK_BYTES));
  const branching = encrypted ? 64 : 128;
  let intermediate = 0;
  for (let level = data; level > 1; level = Math.ceil(level / branching)) intermediate += Math.ceil(level / branching);
  return data + intermediate + Math.max(1, files);
}

function durationSeconds(duration) {
  if (duration && typeof duration.toSeconds === 'function') return duration.toSeconds();
  return Number.isFinite(duration) ? duration : 0;
}

function backendKey() {
  return crypto.createHash('sha256').update(getAntApiUrl() || '').digest('hex');
}

/**
 * The reads over bee-js (the JS backend): `getBee()` and `selectBestBatch`,
 * swarm-service.js's unless a test gives its own.
 */
function beePostage({ getBee, selectBestBatch } = {}) {
  const service = () => require('../swarm/swarm-service');
  const bee = () => (getBee || service().getBee)();
  const options = { timeout: READ_TIMEOUT_MS };
  return {
    selectBestBatch: (bytes) =>
      (selectBestBatch || service().selectBestBatch)(bytes, { requireCapacity: true, requestOptions: options }),
    async stamp(batchId) {
      const local = await bee().stamp.get(batchId, options);
      return {
        usable: local.usable,
        amount: local.amount,
        ttlSeconds: durationSeconds(local.duration),
        remainingBytes: local.remainingSize?.toBytes?.(),
      };
    },
    globalBatch: (batchId) => bee().stamp.getGlobal(batchId, options),
    chainState: () => bee().status.getChainState(options),
  };
}

/**
 * The reads on the core's backend: the core's `swarm.stamps`
 * (swarm-agent-core.js), and `/batches` and `/chainstate` on the node's
 * transport (swarm-node-reads.js).
 */
function corePostage() {
  const core = () => require('./swarm-agent-core').agentSwarmCore();
  const node = () => require('./swarm-node-reads');
  return {
    selectBestBatch: (bytes) => core().selectBestBatch(bytes, { requireCapacity: true }),
    async stamp(batchId) {
      const local = await core().getStamp(batchId);
      return {
        usable: local.usable,
        amount: local.amount,
        ttlSeconds: durationSeconds(local.duration),
        remainingBytes: local.remainingSize,
      };
    },
    globalBatch: (batchId) => node().getGlobalBatch(batchId),
    chainState: () => node().getChainState(),
  };
}

/** The reads on the process's Swarm backend, chosen at each call. */
function backendPostage() {
  const js = beePostage();
  const core = corePostage();
  const pick = () => (require('../swarm/swarm-backend-kind').swarmBackendKind() === 'core' ? core : js);
  return {
    selectBestBatch: (...args) => pick().selectBestBatch(...args),
    stamp: (...args) => pick().stamp(...args),
    globalBatch: (...args) => pick().globalBatch(...args),
    chainState: (...args) => pick().chainState(...args),
  };
}

class SwarmPostageReadiness {
  /**
   * @param {object} [options]
   * @param {object} [options.postage] - the reads (`selectBestBatch`,
   *   `stamp`, `globalBatch`, `chainState`); the process's backend's by
   *   default
   * @param {Function} [options.getBee] - a bee-js client of the test's own,
   *   for the JS backend's reads
   * @param {Function} [options.selectBestBatch] - the JS backend's choice,
   *   the test's own
   */
  constructor(options = {}) {
    this.postage =
      options.postage ||
      (options.getBee || options.selectBestBatch
        ? beePostage({ getBee: options.getBee, selectBestBatch: options.selectBestBatch })
        : backendPostage());
    this.backendKey = options.backendKey || backendKey;
    this.operationStore = options.operationStore;
  }

  async select(ownerId, bytes) {
    // A just-purchased batch may not yet pass local usability. Keep its exact
    // identity instead of silently selecting another batch during propagation.
    const purchase = this.operationStore?.listRecent(ownerId, 20).find(record =>
      record.service === 'ant' && record.request.method === 'POST' &&
      /^\/stamps\/\d+\/\d+(?:\?|$)/.test(record.request.path) &&
      record.response?.status === 201 && Date.now() - record.updatedAt < 60 * 60 * 1000);
    if (purchase) {
      try {
        const id = JSON.parse(purchase.response.body).batchID;
        if (/^[a-f0-9]{64}$/i.test(id)) return id.toLowerCase();
      } catch { /* A malformed receipt cannot identify a batch. */ }
    }
    return this.postage.selectBestBatch(bytes);
  }

  // What the approval card shows about postage before anything is uploaded:
  // the batch this publication will use, its remaining time, and the share of
  // its prepaid storage the upload is expected to take. Read-only; never buys.
  async preview(ownerId, bytes, options = {}) {
    const batchId = await this.select(ownerId, bytes);
    if (!batchId) return { status: 'none' };
    const local = await this.postage.stamp(batchId);
    const ttlSeconds = Math.max(0, Math.floor(local.ttlSeconds));
    const chunks = estimateChunks(bytes, options);
    // `amount` is the batch's per-chunk balance in PLUR. Without it the card
    // shows the time left without a cost.
    const amount = String(local.amount ?? '');
    const estimatedCostPlur = /^\d{1,40}$/.test(amount) ? (BigInt(amount) * BigInt(chunks)).toString() : null;
    const { remainingBytes } = local;
    return {
      status: 'ready',
      batchId: String(batchId).toLowerCase(),
      usable: local.usable === true,
      ttlSeconds,
      estimatedChunks: chunks,
      ...(estimatedCostPlur !== null && { estimatedCostPlur }),
      ...(Number.isFinite(remainingBytes) && { remainingBytes }),
      expiry: ttlSeconds <= 0 ? 'expired' : ttlSeconds < TTL_CRITICAL_SECONDS ? 'critical'
        : ttlSeconds < TTL_WARN_SECONDS ? 'soon' : 'ok',
    };
  }

  async inspect(batchId, bytes, firstConfirmedBlock) {
    const [local, chainBatch, chain] = await Promise.all([
      this.postage.stamp(batchId), this.postage.globalBatch(batchId), this.postage.chainState(),
    ]);
    if (!Number.isSafeInteger(chain.block) || chain.block < 1) throw new Error('Chain height is unavailable');
    if (!Number.isFinite(chainBatch.batchTTL) || chainBatch.batchTTL <= 0) {
      throw Object.assign(new Error('The postage batch has expired. Inspect postage before publishing.'), { code: 'POSTAGE_UNAVAILABLE', permanent: true });
    }
    const remaining = local.remainingBytes;
    if (!Number.isFinite(remaining) || remaining < bytes * 1.5) {
      throw Object.assign(new Error('The selected postage batch lacks sufficient effective capacity. Inspect postage; do not repeat a purchase automatically.'), { code: 'POSTAGE_CAPACITY_INSUFFICIENT', permanent: true });
    }
    // Ant reports start=0. Count actual advancing blocks from our first
    // confirmed contract read rather than treating that placeholder as age.
    const base = Number.isSafeInteger(chainBatch.start) && chainBatch.start > 0
      ? chainBatch.start : firstConfirmedBlock ?? chain.block;
    return { firstConfirmedBlock: base, ready: local.usable === true && chain.block >= base + SETTLEMENT_BLOCKS,
      blocksRemaining: Math.max(0, base + SETTLEMENT_BLOCKS - chain.block) };
  }
}

module.exports = { SwarmPostageReadiness, SETTLEMENT_BLOCKS, TTL_CRITICAL_SECONDS, TTL_WARN_SECONDS, backendKey, estimateChunks };
