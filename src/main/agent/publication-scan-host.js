'use strict';

// Main-process side of the pre-publish scan. The ~30 rules run over every
// byte of a publication (up to 50 MiB, binaries read a second time as
// latin1), which takes seconds on a large text-heavy folder; on Electron's
// main thread that froze every window for the whole check. It runs in one
// lazily spawned worker instead (see task-worker-host.js). Only when that
// worker cannot start, or crashes on the request, is the scan run here, as it
// was before.
const path = require('node:path');
const { createTaskWorkerHost, TaskWorkerUnavailable, TaskWorkerTimeout } = require('../task-worker-host');
const { preparePublication } = require('./publication-scan');
const { revivePreparedPublication } = require('./publication-scan-transfer');

// A 50 MiB publication scans in about 1.5 s; this is a broken worker, not a
// big folder, and the same input would freeze the main thread just as long.
const SCAN_TIMEOUT_MS = 60_000;

const scanWorker = createTaskWorkerHost({
  name: 'PublicationScan',
  workerPath: path.join(__dirname, 'publication-scan-worker.js'),
  timeoutMs: SCAN_TIMEOUT_MS,
});

/**
 * preparePublication, off the main thread. Same result shape (frozen, Buffers)
 * and the same coded errors (PUBLICATION_EMPTY, PUBLICATION_TOO_MANY_FINDINGS).
 * @param {object} source
 * @param {{ signal?: AbortSignal, worker?: { run: Function } }} [options]
 */
async function preparePublicationOffThread(source, { signal, worker = scanWorker } = {}) {
  let scan;
  try {
    scan = await worker.run('prepare', { source }, { signal });
  } catch (error) {
    if (error instanceof TaskWorkerUnavailable) return preparePublication(source);
    if (error instanceof TaskWorkerTimeout) {
      throw new Error('The pre-publish check did not finish in time. Nothing was uploaded; try a smaller publication.', { cause: error });
    }
    throw error;
  }
  return revivePreparedPublication(scan);
}

module.exports = { SCAN_TIMEOUT_MS, preparePublicationOffThread, scanWorker };
