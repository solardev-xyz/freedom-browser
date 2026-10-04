// Worker-thread side of history search (#503). Holds its own read-only
// connection to history.sqlite (WAL lets it read while the main thread's
// connection writes) and answers the bounded queries in history-search.js,
// so a scored scan of a large history never runs on Electron's main thread.
const { isMainThread, parentPort, workerData } = require('node:worker_threads');
const { autocompleteHistory, historyPage } = require('./history-search');

let db = null;

function getDb() {
  if (db) return db;
  // A plain require, as in history.js: in a package this script runs from
  // app.asar and Electron's asar loader resolves better-sqlite3's native
  // binding from app.asar.unpacked (`asarUnpack` in package.json), in a
  // worker thread too. test-e2e/packaged/history-worker.spec.js checks it.
  const Database = require('better-sqlite3');
  db = new Database(workerData.dbPath, { readonly: true, fileMustExist: true });
  return db;
}

const OPS = {
  autocomplete: (message) => autocompleteHistory(getDb(), message.query),
  page: (message) => historyPage(getDb(), message.options),
};

if (!isMainThread && parentPort) {
  parentPort.on('message', (message) => {
    const op = OPS[message?.op];
    if (!op) return;
    try {
      getDb();
    } catch (err) {
      // Can't load better-sqlite3 or open the file: say so, so main stops
      // using this worker and searches on its own connection.
      parentPort.postMessage({
        id: message.id,
        ok: false,
        unavailable: true,
        error: String(err?.message || err).slice(0, 500),
      });
      return;
    }
    try {
      parentPort.postMessage({ id: message.id, ok: true, result: op(message) });
    } catch (err) {
      parentPort.postMessage({
        id: message.id,
        ok: false,
        error: String(err?.message || err).slice(0, 500),
      });
    }
  });
}
