// Main-process side of the chainlist catalog (#503 item 12): the add-chain
// search's IPC handlers call these, and the work runs in
// `chain-catalog-worker.js` — one lazily spawned worker that keeps the parsed
// catalog in memory across searches. Only when that worker cannot start, or
// crashes while serving a request (see task-worker-host.js), is the catalog
// loaded on the main thread for that request, as it was before.
const path = require('node:path');
const { app } = require('electron');
const { createTaskWorkerHost, TaskWorkerUnavailable } = require('../task-worker-host');
const catalog = require('./chain-catalog');

// Above chain-catalog.js's 30 s fetch timeout: a cold search waits on the
// download, and that is not a stuck worker.
//
// This is the worker's time on one request, not the caller's total wait: a
// search handed to a worker that is still starting can also wait up to
// WORKER_START_TIMEOUT_MS (30 s) for the start, so the worst case is about
// 75 s (plus any queue wait) before it settles. There is no outer deadline on
// purpose: nothing blocks on the answer (Settings' add-chain search is async,
// and a newer query supersedes a slow one via its `searchSeq`), and a
// deadline that also covered the start would re-charge it to the request
// (#545).
const REQUEST_TIMEOUT_MS = 45_000;

const catalogWorker = createTaskWorkerHost({
  name: 'ChainCatalog',
  workerPath: path.join(__dirname, 'chain-catalog-worker.js'),
  workerData: () => ({ cachePath: path.join(app.getPath('userData'), catalog.CACHE_FILE) }),
  timeoutMs: REQUEST_TIMEOUT_MS,
  resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
});

async function runOrFallback(op, payload, fallback) {
  try {
    return await catalogWorker.run(op, payload);
  } catch (error) {
    if (!(error instanceof TaskWorkerUnavailable)) throw error;
    return fallback();
  }
}

// Arguments arrive over IPC, so they are structured-clonable as they are;
// chain-catalog.js normalizes them on either side.
function searchChains(query) {
  return runOrFallback('search', { query }, () => catalog.searchChains(query));
}

function getCatalogChain(chainId) {
  return runOrFallback('get', { chainId }, () => catalog.getCatalogChain(chainId));
}

module.exports = { REQUEST_TIMEOUT_MS, catalogWorker, getCatalogChain, searchChains };
