/** Main-owned, one-job Electron utility process. Lifetime and result boundary,
 * not an OS sandbox. Main chooses the module, inputs and result validator.
 * RSS polling is a soft limit; V8 heap limits do not bound native/WASM memory.
 */
const path = require('path');
const { serialize } = require('v8');
const { getPrivacyContext, privacyError } = require('../networks/privacy-context');
let activeProcesses = 0;

function runPrivacyProcess({ handle, filename, input, validateResult, onProgress,
  signal, timeoutMs = 120000, heapMb = 256, rssMb = 768 }) {
  const context = getPrivacyContext(handle);
  const fail = (code = 'PRIVATE_PROCESS_FAILED') => privacyError(code, 'Private computation could not complete');
  if (context.subject.kind !== 'private-account' || context.subject.role !== 'prover' || context.subject.chainId !== 11155111 ||
      typeof filename !== 'string' || !path.isAbsolute(filename) || typeof validateResult !== 'function' || (onProgress !== undefined && typeof onProgress !== 'function') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000 ||
      !Number.isInteger(heapMb) || heapMb < 16 || heapMb > 1024 || !Number.isInteger(rssMb) || rssMb < 64 || rssMb > 2048) {
    throw fail('PRIVATE_PROCESS_INVALID');
  }
  const { app, utilityProcess } = require('electron');
  if (!app.isReady()) throw fail('PRIVATE_PROCESS_UNAVAILABLE');
  const lifetime = AbortSignal.any([context.signal, ...(signal ? [signal] : [])]);
  if (lifetime.aborted) return Promise.reject(fail('PRIVACY_REQUEST_ABORTED'));
  if (activeProcesses >= 2) throw fail('PRIVATE_PROCESS_BUSY');
  activeProcesses += 1;
  return new Promise((resolve, reject) => {
    let child, outcome, result, exited = false, stopping = false, escalation, deadline, memoryPoll;
    let peakRssBytes = 0, progressSeen = false;
    const abort = () => stop(fail('PRIVACY_REQUEST_ABORTED'));
    const quit = () => stop(fail('PRIVACY_REQUEST_ABORTED'));
    // Capacity and result remain held until exit is observed, even after kill().
    function finish() {
      if (exited) return;
      exited = true;
      clearTimeout(escalation); clearTimeout(deadline); clearInterval(memoryPoll);
      lifetime.removeEventListener('abort', abort); app.removeListener('before-quit', quit);
      activeProcesses -= 1;
      try {
        getPrivacyContext(handle);
        if (lifetime.aborted) throw fail('PRIVACY_REQUEST_ABORTED');
        if (outcome) throw outcome;
        if (result === undefined) throw fail();
        resolve({ result, peakRssBytes });
      } catch (error) { reject(error); }
    }
    function terminate() {
      if (exited || !child?.pid) return;
      const pid = child.pid;
      try { child.kill(); } catch { /* Escalate below; never deliver a result while alive. */ }
      if (exited) return;
      escalation ||= setTimeout(() => {
        if (!exited && child.pid === pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* Exit event remains authoritative. */ }
        }
      }, 250);
    }
    function stop(error) {
      if (exited) return;
      if (error) outcome ||= error;
      stopping = true;
      terminate();
    }
    function sampleMemory() {
      if (!child?.pid || exited) return;
      try {
        const metric = app.getAppMetrics().find((entry) => entry.pid === child.pid);
        if (metric?.memory?.workingSetSize !== undefined) {
          const bytes = metric.memory.workingSetSize * 1024;
          peakRssBytes = Math.max(peakRssBytes, bytes);
          if (bytes > rssMb * 1024 * 1024) stop(fail('PRIVATE_PROCESS_MEMORY_LIMIT'));
        }
      } catch { stop(fail('PRIVATE_PROCESS_MEMORY_UNAVAILABLE')); }
    }
    try {
      child = utilityProcess.fork(path.join(__dirname, 'privacy-process-entry.js'), [], {
        // Chromium merges utility-process environments: {} does not remove
        // inherited variables. Blank every parent key before process creation;
        // the bootstrap removes these empty entries before loading SDK code.
        env: Object.fromEntries(Object.keys(process.env).map((key) => [key, ''])),
        execArgv: [`--max-old-space-size=${heapMb}`], cwd: app.getPath('temp'),
        stdio: 'ignore', serviceName: 'Freedom private computation',
      });
      child.once('exit', finish);
      child.once('error', () => stop(fail()));
      child.once('spawn', () => {
        if (stopping || lifetime.aborted) { stop(fail('PRIVACY_REQUEST_ABORTED')); return; }
        try { child.postMessage({ filename, input }); } catch { stop(fail()); }
      });
      child.on('message', (message) => {
        if (stopping || exited) return;
        try {
          getPrivacyContext(handle);
          if (lifetime.aborted) { abort(); return; }
          if (message?.type === 'progress' && message.phase === 'proving' && !progressSeen) {
            progressSeen = true; onProgress?.('proving'); return;
          }
          if (message?.type !== 'result' || serialize(message.value).length > 1024 * 1024 || validateResult(message.value) !== true) {
            stop(fail()); return;
          }
          result = message.value;
          sampleMemory(); stop();
        } catch { stop(fail()); }
      });
      lifetime.addEventListener('abort', abort, { once: true });
      app.once('before-quit', quit);
      deadline = setTimeout(() => stop(fail('PRIVACY_REQUEST_ABORTED')), timeoutMs);
      memoryPoll = setInterval(sampleMemory, 100);
      if (lifetime.aborted) abort();
    } catch {
      outcome = fail();
      if (child) stop(outcome);
      else finish();
    }
  });
}

module.exports = { runPrivacyProcess };
