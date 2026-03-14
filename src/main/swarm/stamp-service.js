/**
 * Stamp Service
 *
 * Postage batch operations via bee-js: list, cost estimation, and purchase.
 * All bee-js types stay behind this boundary — the renderer receives
 * normalized Freedom batch model objects.
 */

const { ipcMain } = require('electron');
const { Size, Duration } = require('@ethersphere/bee-js');
const { getBee } = require('./swarm-service');
const log = require('electron-log');

const BUY_TIMEOUT_MS = 300000; // 5 minutes — chain tx can be slow

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Normalize a bee-js PostageBatch to the Freedom batch model.
 * Uses public bee-js class methods (toBytes, toSeconds) rather than
 * private properties.
 */
function normalizeBatch(batch) {
  let sizeBytes = 0;
  if (batch.size && typeof batch.size.toBytes === 'function') {
    sizeBytes = batch.size.toBytes();
  } else if (typeof batch.size === 'number') {
    sizeBytes = batch.size;
  }

  let remainingBytes = 0;
  if (batch.remainingSize && typeof batch.remainingSize.toBytes === 'function') {
    remainingBytes = batch.remainingSize.toBytes();
  } else if (typeof batch.remainingSize === 'number') {
    remainingBytes = batch.remainingSize;
  }

  let ttlSeconds = 0;
  if (batch.duration && typeof batch.duration.toSeconds === 'function') {
    ttlSeconds = batch.duration.toSeconds();
  } else if (typeof batch.duration === 'number') {
    ttlSeconds = batch.duration;
  }

  const usageRaw = typeof batch.usage === 'number' ? batch.usage : 0;

  const rawId = batch.batchID;
  const batchId = rawId && typeof rawId.toHex === 'function' ? rawId.toHex() : String(rawId || '');

  return {
    batchId,
    usable: batch.usable === true,
    isMutable: batch.immutableFlag === false,
    sizeBytes,
    remainingBytes,
    usagePercent: Math.round(usageRaw * 100),
    ttlSeconds,
  };
}

/**
 * List all postage batches, normalized to the Freedom batch model.
 */
async function getStamps() {
  const bee = getBee();
  const batches = await bee.getPostageBatches();
  return batches.map(normalizeBatch);
}

/**
 * Estimate cost for a new batch with the given size and duration.
 * Returns a formatted xBZZ string.
 */
async function getStorageCost(sizeGB, durationDays) {
  const bee = getBee();
  const cost = await bee.getStorageCost(
    Size.fromGigabytes(sizeGB),
    Duration.fromDays(durationDays)
  );

  return {
    bzz: cost.toSignificantDigits(4),
  };
}

/**
 * Purchase a new postage batch.
 */
async function buyStorage(sizeGB, durationDays) {
  const bee = getBee();
  const batchId = await bee.buyStorage(
    Size.fromGigabytes(sizeGB),
    Duration.fromDays(durationDays),
    { waitForUsable: false }, // Don't block — renderer polls for usability
    { timeout: BUY_TIMEOUT_MS } // BeeRequestOptions — HTTP timeout
  );

  const batchIdHex = typeof batchId?.toHex === 'function' ? batchId.toHex() : String(batchId);
  log.info(`[StampService] Purchased batch ${batchIdHex} (${sizeGB} GB, ${durationDays} days)`);
  return batchIdHex;
}

/**
 * Register IPC handlers for stamp operations.
 */
function registerSwarmIpc() {
  ipcMain.handle('swarm:get-stamps', async () => {
    try {
      const stamps = await getStamps();
      return { success: true, stamps };
    } catch (err) {
      log.error('[StampService] Failed to get stamps:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:get-storage-cost', async (_event, sizeGB, durationDays) => {
    try {
      if (!isPositiveNumber(sizeGB) || !isPositiveNumber(durationDays)) {
        return { success: false, error: 'Size and duration must be positive numbers' };
      }
      const cost = await getStorageCost(sizeGB, durationDays);
      return { success: true, ...cost };
    } catch (err) {
      log.error('[StampService] Failed to estimate storage cost:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:buy-storage', async (_event, sizeGB, durationDays) => {
    try {
      if (!isPositiveNumber(sizeGB) || !isPositiveNumber(durationDays)) {
        return { success: false, error: 'Size and duration must be positive numbers' };
      }

      // Pre-check: verify xBZZ balance covers the estimated cost
      const insufficientError = await checkBzzSufficiency(sizeGB, durationDays);
      if (insufficientError) {
        return { success: false, error: insufficientError };
      }

      const batchId = await buyStorage(sizeGB, durationDays);
      return { success: true, batchId };
    } catch (err) {
      log.error('[StampService] Failed to buy storage:', err.message);
      return { success: false, error: err.message };
    }
  });

  log.info('[StampService] IPC handlers registered');
}

/**
 * Fetch the Bee wallet's xBZZ balance in PLUR (raw BigInt).
 * Returns null if the balance cannot be determined.
 */
async function getBzzBalance() {
  const bee = getBee();
  const walletData = await bee.getWalletBalance();
  if (walletData?.bzzBalance && typeof walletData.bzzBalance.toPLURBigInt === 'function') {
    return walletData.bzzBalance.toPLURBigInt();
  }
  return null;
}

/**
 * Check if the Bee wallet has enough xBZZ for the given storage purchase.
 * Uses exact PLUR values for comparison, not rounded display strings.
 * Returns an error string if insufficient, or null if OK.
 */
async function checkBzzSufficiency(sizeGB, durationDays) {
  try {
    const bee = getBee();

    const cost = await bee.getStorageCost(
      Size.fromGigabytes(sizeGB),
      Duration.fromDays(durationDays)
    );

    const costPlur = cost.toPLURBigInt();
    const bzzBalance = await getBzzBalance();

    if (bzzBalance === null) return null; // Can't check — let Bee handle it

    if (costPlur > 0n && bzzBalance < costPlur) {
      return `Insufficient xBZZ. Estimated cost is ~${cost.toSignificantDigits(4)} xBZZ.`;
    }

    return null;
  } catch (err) {
    log.error('[StampService] Balance pre-check failed:', err.message);
    return null; // Non-fatal — let the purchase attempt proceed
  }
}

module.exports = {
  normalizeBatch,
  registerSwarmIpc,
};
