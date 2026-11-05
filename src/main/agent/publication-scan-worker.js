'use strict';

// Worker-thread side of the pre-publish scan: runs preparePublication (every
// rule over every byte, metadata stripping) for publication-scan-host.js, so a
// 50 MiB folder no longer freezes every browser window while it is checked.
const { isMainThread, parentPort } = require('node:worker_threads');
const { preparePublication } = require('./publication-scan');
const { withBuffers } = require('./publication-scan-transfer');

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    if (message?.op !== 'prepare') return;
    try {
      parentPort.postMessage({ id: message.id, ok: true, result: preparePublication(withBuffers(message.source)) });
    } catch (err) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        code: typeof err?.code === 'string' ? err.code : undefined,
        error: String(err?.message || err).slice(0, 500),
      });
    }
  });
}
