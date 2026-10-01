/** Bound SDK work even when a dependency ignores cancellation. Closing the
 * child scope revokes transport, storage, proving and the account lease.
 */
const { privacyError } = require('../networks/privacy-context');
const MAX_TASK_MS = 300000;
function createPPv2TaskBudget({ scope, handle, onProgress }) {
  let current = null,
    scannedBlocks = 0,
    completedWindows = 0;
  function progress(stage, counts = {}) {
    if (!current || scope.signal.aborted) return;
    const event = {
      task: current.stage,
      stage,
      elapsedMs: Math.max(0, Math.round(performance.now() - current.started)),
    };
    for (const key of ['completedWindows', 'scannedBlocks']) {
      if (Number.isSafeInteger(counts[key]) && counts[key] >= 0) event[key] = counts[key];
    }
    if (
      stage === 'history' &&
      current.allowScanProgress &&
      Number.isSafeInteger(event.completedWindows) &&
      event.completedWindows > completedWindows &&
      Number.isSafeInteger(event.scannedBlocks) &&
      event.scannedBlocks > scannedBlocks
    ) {
      completedWindows = event.completedWindows;
      scannedBlocks = event.scannedBlocks;
      current.renew();
    }
    try {
      Promise.resolve(onProgress?.(Object.freeze(event))).catch(() => {});
    } catch {
      /* Diagnostics cannot change operation authority. */
    }
  }
  function observeHead(head) {
    if (!current || !current.allowScanProgress || scope.signal.aborted) return;
    if (
      typeof head === 'bigint' &&
      head >= 0n &&
      (current.maximumHead === null || head > current.maximumHead)
    )
      current.maximumHead = head;
  }
  function beforeScan({ fromBlock, toBlock, floor, head }) {
    if (!current || !current.allowScanProgress || scope.signal.aborted)
      throw privacyError('PRIVATE_PPV2_SCAN_LIMIT', 'Scan is outside a bounded task');
    const stop = () => {
      current.expire('PRIVATE_PPV2_SCAN_LIMIT');
      throw privacyError('PRIVATE_PPV2_SCAN_LIMIT', 'History scan exceeded its work limit');
    };
    if (
      ![fromBlock, toBlock, floor, head].every(
        (v) => typeof v === 'bigint' && v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER)
      ) ||
      fromBlock < floor ||
      toBlock < fromBlock ||
      head < floor
    )
      return stop();
    observeHead(head);
    const maximumHead = current.maximumHead;
    if (toBlock > maximumHead) return stop();
    if (!current.scan) {
      const span = maximumHead - floor + 10001n;
      current.scan = {
        head: maximumHead,
        floor,
        blocks: 0n,
        allowance: (span > 5000n ? span : 5000n) * 64n,
      };
    }
    const scan = current.scan,
      blocks = toBlock - fromBlock + 1n;
    // Fix the first observed basis. A later remote head cannot grow the budget
    // indefinitely; the margin permits ordinary chain growth during long scans.
    if (
      floor !== scan.floor ||
      maximumHead > scan.head + 10000n ||
      scan.blocks + blocks > scan.allowance
    )
      return stop();
    scan.blocks += blocks;
  }
  async function run(
    stage,
    task,
    timeoutMs = MAX_TASK_MS,
    { allowScanProgress = false, maySubmit = false } = {}
  ) {
    if (current || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TASK_MS) {
      throw privacyError('PRIVATE_PPV2_UNAVAILABLE', 'Controlled PPv2 task is unavailable');
    }
    let timeoutCode = null,
      stallTimer;
    const expire = (code = 'PRIVATE_PPV2_TASK_TIMEOUT') => {
      timeoutCode = code;
      progress(code === 'PRIVATE_PPV2_SCAN_LIMIT' ? 'scan-limit' : 'timed-out');
      scope.close();
    };
    const renew = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(expire, timeoutMs);
    };
    current = {
      stage,
      started: performance.now(),
      scan: null,
      maximumHead: null,
      allowScanProgress,
      renew,
      expire,
    };
    // Scan latency is unbounded by chain age. Bound completed work instead of
    // restarting a healthy full scan forever at an arbitrary wall-clock limit.
    // A smaller caller timeout remains an absolute diagnostic/test budget.
    const timer =
      allowScanProgress && timeoutMs === MAX_TASK_MS ? null : setTimeout(expire, timeoutMs);
    renew();
    try {
      progress('started');
      const result = await scope.run(handle, task);
      progress('complete');
      return result;
    } catch (error) {
      if (timeoutCode)
        throw Object.assign(
          privacyError(
            timeoutCode,
            maySubmit
              ? 'Submission outcome may be unknown; reconcile before further action'
              : 'Controlled PPv2 task exceeded its work or stall limit'
          ),
          maySubmit ? { submissionStatus: 'unknown', reconciliationRequired: true } : {}
        );
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(stallTimer);
      current = null;
    }
  }
  return Object.freeze({ run, progress, beforeScan, observeHead });
}
module.exports = { createPPv2TaskBudget, MAX_TASK_MS };
