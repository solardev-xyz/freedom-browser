'use strict';

const crypto = require('crypto');
const { getBee, selectBestBatch } = require('../swarm/swarm-service');
const { getAntApiUrl } = require('../service-registry');

const SETTLEMENT_BLOCKS = 10;
const READ_TIMEOUT_MS = 10_000;

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

module.exports = { SwarmPostageReadiness, SETTLEMENT_BLOCKS, backendKey };
