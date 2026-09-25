/** Lifecycle boundary for a main-reviewed worker entry point. A Node worker
 * is NOT an OS/network sandbox; qualify each SDK's egress before giving it keys.
 * JS heap limits also do not bound native/WASM allocations.
 */
const path = require('path');
const { Worker } = require('worker_threads');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
let activeWorkers = 0;

function runPrivacyWorker({ handle, filename, workerData, signal, timeoutMs = 120000, heapMb = 256 }) {
  const context = getPrivacyContext(handle);
  if (context.subject.kind !== 'private-account' || context.subject.role !== 'prover' || context.subject.chainId !== 11155111 ||
      typeof filename !== 'string' || !path.isAbsolute(filename) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      !Number.isSafeInteger(heapMb) || heapMb < 16 || heapMb > 1024) {
    throw privacyError('PRIVATE_WORKER_INVALID', 'Invalid proving worker configuration');
  }
  const lifetime = AbortSignal.any([context.signal, ...(signal ? [signal] : []), AbortSignal.timeout(timeoutMs)]);
  const cancelled = () => privacyError('PRIVACY_REQUEST_ABORTED', 'Proving worker cancelled');
  if (lifetime.aborted) return Promise.reject(cancelled());
  if (activeWorkers >= 2) throw privacyError('PRIVATE_WORKER_BUSY', 'Proving worker capacity reached');
  activeWorkers += 1;
  return new Promise((resolve, reject) => {
    let worker, finished = false;
    const abort = () => finish(cancelled());
    // Always wait for termination before releasing capacity or delivering a
    // result. A late message cannot commit state after cancellation or timeout.
    async function finish(error, result) {
      if (finished) return;
      finished = true;
      lifetime.removeEventListener('abort', abort);
      try {
        await worker?.terminate();
        getPrivacyContext(handle);
        if (lifetime.aborted) throw cancelled();
        if (error) throw error;
        resolve(result);
      } catch (failure) { reject(failure); }
      finally { activeWorkers -= 1; }
    }
    try {
      worker = new Worker(filename, { workerData, execArgv: [], env: {}, stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: heapMb, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 } });
      worker.stdout.resume(); worker.stderr.resume();
      worker.once('message', (result) => finish(null, result));
      worker.once('error', () => finish(privacyError('PRIVATE_WORKER_FAILED', 'Proving worker failed')));
      worker.once('exit', () => finish(privacyError('PRIVATE_WORKER_FAILED', 'Proving worker exited without a result')));
      lifetime.addEventListener('abort', abort, { once: true });
      if (lifetime.aborted) abort();
    } catch { finish(privacyError('PRIVATE_WORKER_FAILED', 'Proving worker could not start')); }
  });
}

module.exports = { runPrivacyWorker };
