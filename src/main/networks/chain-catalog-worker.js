// Worker-thread side of the chainlist catalog (#503 item 12). Holds the
// catalog (fetch, disk cache, in-memory copy) and answers searches, so the
// main thread never parses, re-serializes or filters the ~2.3 MB list; see
// `chain-catalog.js` and `chain-catalog-host.js`.
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const catalog = require('./chain-catalog');

const OPS = {
  search: (message) => catalog.searchChains(message.query),
  get: (message) => catalog.getCatalogChain(message.chainId),
};

if (!isMainThread && parentPort) {
  catalog.configure({
    cachePath: workerData.cachePath,
    log: { error: (message) => parentPort.postMessage({ type: 'log', level: 'error', message }) },
  });
  parentPort.on('message', async (message) => {
    const op = OPS[message?.op];
    if (!op) return;
    try {
      parentPort.postMessage({ id: message.id, ok: true, result: await op(message) });
    } catch (err) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: String(err?.message || err).slice(0, 500),
      });
    }
  });
}
