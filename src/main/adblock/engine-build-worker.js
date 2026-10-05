// Worker-thread side of the ad-block engine build (#512). One build per
// worker: engine-build-host.js spawns it, posts the job, takes the serialized
// engine back (its buffer transferred, not copied) and terminates it, so the
// parse's garbage never lingers in a long-lived heap.
const { isMainThread, parentPort } = require('node:worker_threads');
const { buildSerializedEngine } = require('./engine-build');

if (!isMainThread && parentPort) {
  parentPort.once('message', async (job) => {
    try {
      const { bytes, warnings } = await buildSerializedEngine(job);
      parentPort.postMessage({ ok: true, bytes, warnings }, bytes ? [bytes.buffer] : []);
    } catch (err) {
      parentPort.postMessage({ ok: false, error: String(err?.message || err).slice(0, 500) });
    }
  });
}
