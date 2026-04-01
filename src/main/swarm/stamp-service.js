/**
 * Stamp Service
 *
 * Postage batch operations via bee-js: list, cost estimation, and purchase.
 * All bee-js types stay behind this boundary — the renderer receives
 * normalized Freedom batch model objects.
 */

const { ipcMain } = require('electron');
const { Size, Duration } = require('@ethersphere/bee-js');
const { getBee, toHex } = require('./swarm-service');
const log = require('electron-log');

const BUY_TIMEOUT_MS = 300000; // 5 minutes — chain tx can be slow

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

const batchIdToHex = toHex;

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

  let expiresApprox = null;
  if (ttlSeconds > 0 && batch.duration && typeof batch.duration.toEndDate === 'function') {
    try {
      expiresApprox = batch.duration.toEndDate().toISOString();
    } catch {
      // Duration.toEndDate may fail for edge cases
    }
  }

  return {
    batchId,
    usable: batch.usable === true,
    isMutable: batch.immutableFlag === false,
    sizeBytes,
    remainingBytes,
    usagePercent: Math.round(usageRaw * 100),
    ttlSeconds,
    expiresApprox,
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

  const batchIdHex = batchIdToHex(batchId);
  log.info(`[StampService] Purchased batch ${batchIdHex} (${sizeGB} GB, ${durationDays} days)`);
  return batchIdHex;
}

/**
 * Estimate cost to extend a batch's duration.
 */
async function getDurationExtensionCost(batchIdHex, additionalDays) {
  const bee = getBee();
  const cost = await bee.getDurationExtensionCost(
    batchIdHex,
    Duration.fromDays(additionalDays)
  );
  return { bzz: cost.toSignificantDigits(4) };
}

/**
 * Estimate cost to extend a batch's size.
 * Note: bee-js treats size as ABSOLUTE (new total), not incremental.
 * This is different from duration which is RELATIVE (additional time).
 */
async function getSizeExtensionCost(batchIdHex, newSizeGB) {
  const bee = getBee();
  const cost = await bee.getSizeExtensionCost(
    batchIdHex,
    Size.fromGigabytes(newSizeGB)
  );
  return { bzz: cost.toSignificantDigits(4) };
}

/**
 * Extend a batch's duration.
 */
async function extendStorageDuration(batchIdHex, additionalDays) {
  const bee = getBee();
  const result = await bee.extendStorageDuration(
    batchIdHex,
    Duration.fromDays(additionalDays),
    { timeout: BUY_TIMEOUT_MS }
  );
  const resultHex = batchIdToHex(result, batchIdHex);
  log.info(`[StampService] Extended duration of ${batchIdHex} by ${additionalDays} days`);
  return resultHex;
}

/**
 * Extend a batch's size.
 * Note: newSizeGB is ABSOLUTE (new total), not incremental.
 */
async function extendStorageSize(batchIdHex, newSizeGB) {
  const bee = getBee();
  const result = await bee.extendStorageSize(
    batchIdHex,
    Size.fromGigabytes(newSizeGB),
    { timeout: BUY_TIMEOUT_MS }
  );
  const resultHex = batchIdToHex(result, batchIdHex);
  log.info(`[StampService] Extended size of ${batchIdHex} to ${newSizeGB} GB`);
  return resultHex;
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
      const bee = getBee();
      const purchaseCost = await bee.getStorageCost(
        Size.fromGigabytes(sizeGB),
        Duration.fromDays(durationDays)
      );
      const insufficientError = await checkBzzBalance(purchaseCost);
      if (insufficientError) {
        return { success: false, error: insufficientError };
      }

      const batchId = await buyStorage(sizeGB, durationDays);

      // Auto-deposit into chequebook if empty (for bandwidth payments)
      await autoDepositChequebookIfEmpty();

      return { success: true, batchId };
    } catch (err) {
      log.error('[StampService] Failed to buy storage:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:get-duration-extension-cost', async (_event, batchId, additionalDays) => {
    try {
      if (!batchId || typeof batchId !== 'string') {
        return { success: false, error: 'Batch ID is required' };
      }
      if (!isPositiveNumber(additionalDays)) {
        return { success: false, error: 'Duration must be a positive number' };
      }
      const cost = await getDurationExtensionCost(batchId, additionalDays);
      return { success: true, ...cost };
    } catch (err) {
      log.error('[StampService] Failed to estimate duration extension cost:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:get-size-extension-cost', async (_event, batchId, newSizeGB) => {
    try {
      if (!batchId || typeof batchId !== 'string') {
        return { success: false, error: 'Batch ID is required' };
      }
      if (!isPositiveNumber(newSizeGB)) {
        return { success: false, error: 'Size must be a positive number' };
      }
      const cost = await getSizeExtensionCost(batchId, newSizeGB);
      return { success: true, ...cost };
    } catch (err) {
      log.error('[StampService] Failed to estimate size extension cost:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:extend-storage-duration', async (_event, batchId, additionalDays) => {
    try {
      if (!batchId || typeof batchId !== 'string') {
        return { success: false, error: 'Batch ID is required' };
      }
      if (!isPositiveNumber(additionalDays)) {
        return { success: false, error: 'Duration must be a positive number' };
      }
      // Pre-check xBZZ balance
      const durCostBzz = await getBee().getDurationExtensionCost(batchId, Duration.fromDays(additionalDays));
      const durInsufficient = await checkBzzBalance(durCostBzz);
      if (durInsufficient) {
        return { success: false, error: durInsufficient };
      }

      const resultId = await extendStorageDuration(batchId, additionalDays);
      return { success: true, batchId: resultId };
    } catch (err) {
      log.error('[StampService] Failed to extend duration:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:extend-storage-size', async (_event, batchId, newSizeGB) => {
    try {
      if (!batchId || typeof batchId !== 'string') {
        return { success: false, error: 'Batch ID is required' };
      }
      if (!isPositiveNumber(newSizeGB)) {
        return { success: false, error: 'Size must be a positive number' };
      }
      // Pre-check xBZZ balance
      const sizeCostBzz = await getBee().getSizeExtensionCost(batchId, Size.fromGigabytes(newSizeGB));
      const sizeInsufficient = await checkBzzBalance(sizeCostBzz);
      if (sizeInsufficient) {
        return { success: false, error: sizeInsufficient };
      }

      const resultId = await extendStorageSize(batchId, newSizeGB);
      return { success: true, batchId: resultId };
    } catch (err) {
      log.error('[StampService] Failed to extend size:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:get-chequebook-balance', async () => {
    try {
      const bee = getBee();
      const bal = await bee.getChequebookBalance();
      return {
        success: true,
        totalBalance: bal.totalBalance.toSignificantDigits(4),
        availableBalance: bal.availableBalance.toSignificantDigits(4),
        totalBalancePlur: bal.totalBalance.toPLURBigInt().toString(),
        availableBalancePlur: bal.availableBalance.toPLURBigInt().toString(),
      };
    } catch (err) {
      log.error('[StampService] Failed to get chequebook balance:', err.message);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('swarm:deposit-chequebook', async (_event, amountBzz) => {
    try {
      if (!isPositiveNumber(amountBzz)) {
        return { success: false, error: 'Amount must be a positive number' };
      }

      // Pre-check: verify Bee wallet has enough xBZZ
      const requiredPlur = BigInt(Math.round(amountBzz * 1e16));
      const walletBzz = await getBzzBalance();
      if (walletBzz !== null && walletBzz < requiredPlur) {
        return { success: false, error: `Insufficient xBZZ in Bee wallet. Need ${amountBzz} xBZZ.` };
      }

      const bee = getBee();
      const plurAmount = requiredPlur.toString();
      const txId = await bee.depositTokens(plurAmount, undefined, { timeout: BUY_TIMEOUT_MS });
      const txHex = toHex(txId);
      log.info(`[StampService] Deposited ${amountBzz} xBZZ into chequebook (tx: ${txHex})`);
      return { success: true, transactionId: txHex };
    } catch (err) {
      log.error('[StampService] Failed to deposit into chequebook:', err.message);
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
 * Check if the Bee wallet has enough xBZZ for a given cost.
 * Uses exact PLUR values. Returns an error string if insufficient, null if OK.
 * Non-fatal: returns null on any check failure so the operation can proceed.
 */
async function checkBzzBalance(costBzz) {
  try {
    const costPlur = costBzz.toPLURBigInt();
    const bzzBalance = await getBzzBalance();

    if (bzzBalance === null) return null;

    if (costPlur > 0n && bzzBalance < costPlur) {
      return `Insufficient xBZZ. Estimated cost is ~${costBzz.toSignificantDigits(4)} xBZZ.`;
    }

    return null;
  } catch (err) {
    log.error('[StampService] Balance pre-check failed:', err.message);
    return null; // Non-fatal — let the purchase attempt proceed
  }
}

const AUTO_DEPOSIT_BZZ = '1000000000000000'; // 0.1 xBZZ in PLUR

/**
 * Auto-deposit 0.1 xBZZ into the chequebook if it's empty and the
 * wallet has enough. Non-fatal — silently skips on any failure.
 */
async function autoDepositChequebookIfEmpty() {
  try {
    const bee = getBee();
    const bal = await bee.getChequebookBalance();
    const available = bal.availableBalance.toPLURBigInt();

    if (available > 0n) return; // Already funded

    const walletBal = await getBzzBalance();
    if (!walletBal || walletBal < BigInt(AUTO_DEPOSIT_BZZ)) return; // Not enough

    await bee.depositTokens(AUTO_DEPOSIT_BZZ);
    log.info('[StampService] Auto-deposited 0.1 xBZZ into chequebook');
  } catch (err) {
    log.error('[StampService] Auto-deposit failed (non-fatal):', err.message);
  }
}

module.exports = {
  normalizeBatch,
  registerSwarmIpc,
};
