'use strict';

const crypto = require('crypto');
const { getBee, selectBestBatch } = require('../swarm/swarm-service');
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

class SwarmPostageReadiness {
  constructor(options = {}) {
    this.getBee = options.getBee || getBee;
    this.selectBestBatch = options.selectBestBatch || selectBestBatch;
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
    return this.selectBestBatch(bytes, { requireCapacity: true, requestOptions: { timeout: READ_TIMEOUT_MS } });
  }

  // What the approval card shows about postage before anything is uploaded:
  // the batch this publication will use, its remaining time, and the share of
  // its prepaid storage the upload is expected to take. Read-only; never buys.
  async preview(ownerId, bytes, options = {}) {
    const batchId = await this.select(ownerId, bytes);
    if (!batchId) return { status: 'none' };
    const local = await this.getBee().stamp.get(batchId, { timeout: READ_TIMEOUT_MS });
    const ttlSeconds = Math.max(0, Math.floor(durationSeconds(local.duration)));
    const chunks = estimateChunks(bytes, options);
    // `amount` is the batch's per-chunk balance in PLUR. Without it the card
    // shows the time left without a cost.
    const amount = String(local.amount ?? '');
    const estimatedCostPlur = /^\d{1,40}$/.test(amount) ? (BigInt(amount) * BigInt(chunks)).toString() : null;
    const remainingBytes = local.remainingSize?.toBytes?.();
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
    const bee = this.getBee();
    const options = { timeout: READ_TIMEOUT_MS };
    const [local, chainBatch, chain] = await Promise.all([
      bee.stamp.get(batchId, options), bee.stamp.getGlobal(batchId, options),
      bee.status.getChainState(options),
    ]);
    if (!Number.isSafeInteger(chain.block) || chain.block < 1) throw new Error('Chain height is unavailable');
    if (!Number.isFinite(chainBatch.batchTTL) || chainBatch.batchTTL <= 0) {
      throw Object.assign(new Error('The postage batch has expired. Inspect postage before publishing.'), { code: 'POSTAGE_UNAVAILABLE', permanent: true });
    }
    const remaining = local.remainingSize?.toBytes();
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
