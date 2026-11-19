// Worker-thread side of Colibri (#495). Proof verification is synchronous WASM:
// on Electron's main thread a large proof froze the whole browser until it
// returned (21-26 s for an eth_getLogs scan, #494). Each chain gets one
// long-lived worker running this file; it owns that chain's Colibri clients
// and the verifier's disk storage, and the main process talks to it over
// messages (`colibri-worker-host.js`). A verification that outlives its caller
// can then be stopped with `worker.terminate()` instead of running to the end.
const fs = require('node:fs');
const path = require('node:path');
const { isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');

// privacy_mode 'basic' is a strict improvement (call params never sent
// to the prover); pinning rather than exposing as a toggle keeps the
// threat model legible.
const PRIVACY_MODE = 'basic';
const MAX_LATEST_AGE_SECONDS = 60;
const MAX_ERROR_MESSAGE = 2000;
// colibri-runtime.js's refusal on an instance retired after a trap.
const RETIRED_RUNTIME_ERROR = /Colibri WASM runtime was retired after a trap/;

// Disk-backed storage adapter for Colibri's verifier state (sync committee
// pubkeys, current head witness, etc — keys like "states_1" / "sync_1_<slot>").
// The bundled default writes these to process.cwd(), which means launching
// the browser from a different directory loses the warm-cache state and
// scatters files across the filesystem. The host passes a stable per-app dir
// (`<userData>/colibri`) to the normal windows' workers (a private window's
// gets none: createMemoryStorage below); keys are chain-scoped, so workers for *different*
// chains never write the same file. Two workers for the *same* chain can,
// though: when a WASM trap retires a worker that still has requests in
// flight, it keeps draining (with a fresh instance on the same storage) while
// its replacement already serves new requests, and both read and write the
// same `states_<chain>` / `sync_<chain>_*` keys. A plain writeFileSync
// truncates the target before writing, so a read from the other thread in
// between would see an empty or partial file. `set` therefore writes a temp
// file unique to this thread and renames it over the key: rename replaces the
// target atomically, so a reader sees either the old bytes or the new ones.
//
// Two costs of temp+rename, handled here:
// - A worker can die between the write and the rename — the stuck-worker
//   watchdog's `worker.terminate()` is uncatchable, so no cleanup runs — and
//   the temp name is unique, so nothing ever overwrites it. Creating the
//   storage sweeps temp files older than STALE_TMP_MS: a write is one
//   synchronous call, so a temp that old belongs to a dead thread, never to a
//   write still in flight on a live one (same or other process).
// - On Windows, replacing a file that another handle has open (Defender or
//   the search indexer scanning the fresh temp, or the other thread reading
//   the key) fails with EPERM/EACCES/EBUSY until that handle closes. The
//   old in-place write never hit this, so the rename is retried briefly on
//   those codes before giving up — the same thing graceful-fs does.
const TMP_FILE = /^\..+\.\d+-\d+-\d+\.tmp$/;
const STALE_TMP_MS = 60_000;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80, 160];
let tmpCounter = 0;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRY_CODES.has(err?.code) || attempt >= RENAME_RETRY_DELAYS_MS.length) throw err;
      sleepSync(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function sweepStaleTempFiles(dir, now = Date.now()) {
  let names;
  try { names = fs.readdirSync(dir); }
  catch { return; }
  for (const name of names) {
    if (!TMP_FILE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > STALE_TMP_MS) fs.unlinkSync(file);
    } catch { /* gone already, or not ours to remove — try again next start */ }
  }
}

function createDiskStorage(dir) {
  fs.mkdirSync(dir, { recursive: true });
  sweepStaleTempFiles(dir);
  return {
    get: (key) => {
      try { return fs.readFileSync(path.join(dir, key)); }
      catch { return null; }
    },
    set: (key, value) => {
      const target = path.join(dir, key);
      tmpCounter += 1;
      const tmp = path.join(dir, `.${key}.${process.pid}-${threadId}-${tmpCounter}.tmp`);
      try {
        fs.writeFileSync(tmp, value);
        renameWithRetry(tmp, target);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch { /* never created, or already renamed */ }
        throw err;
      }
    },
    del: (key) => {
      try { fs.unlinkSync(path.join(dir, key)); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    },
  };
}

// A private window's verifier state (#1058). Besides headers and sync state,
// Colibri saves `tx_cache_<chain>`, `code_<hash>` and `call_<chain>_<address>`
// records, and the last names every contract a page called: on disk they
// would outlive the private window. The host spawns the private windows'
// workers with no storage dir, and they get this instead, the same
// interface held in the worker's own memory. It ends with the worker, which
// the host terminates when the last private window closes.
//
// That can be days, and Buffer bytes live outside the V8 heap, so the
// worker's maxOldGenerationSizeMb does not count them. The cache records
// (`call_`, `code_`, `tx_cache_`) are what grows with browsing, one per
// contract or bytecode a page touches, so they share a byte budget and the
// least recently used one is dropped once it is spent: Colibri reads a
// missing record as a cache miss and fetches and verifies it again. The
// verifier's own state (`states_`, `sync_`, headers) is never dropped, since
// losing it would mean bootstrapping verification again; it grows by one
// sync-committee record per ~27 h period, which stays small for any window
// lifetime.
const MEMORY_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const MEMORY_CACHE_KEY = /^(call_|code_|tx_cache_)/;

function createMemoryStorage({ maxCacheBytes = MEMORY_CACHE_MAX_BYTES } = {}) {
  const entries = new Map();
  // Cache records only, oldest use first (a Map keeps insertion order, and a
  // use re-inserts the key at the end).
  const cache = new Map();
  let cacheBytes = 0;

  function dropCached(key) {
    if (!cache.has(key)) return;
    cacheBytes -= cache.get(key);
    cache.delete(key);
  }

  function del(key) {
    entries.delete(key);
    dropCached(key);
  }

  return {
    get: (key) => {
      if (!entries.has(key)) return null;
      if (cache.has(key)) {
        const size = cache.get(key);
        cache.delete(key);
        cache.set(key, size);
      }
      return Buffer.from(entries.get(key));
    },
    set: (key, value) => {
      const copy = Buffer.from(value);
      del(key);
      if (!MEMORY_CACHE_KEY.test(key)) {
        entries.set(key, copy);
        return;
      }
      // A record bigger than the whole budget is not kept at all.
      if (copy.length > maxCacheBytes) return;
      for (const oldest of cache.keys()) {
        if (cacheBytes + copy.length <= maxCacheBytes) break;
        del(oldest);
      }
      entries.set(key, copy);
      cache.set(key, copy.length);
      cacheBytes += copy.length;
    },
    del,
  };
}

// The worker's storage: on disk under `storageDir`, or in memory when the
// host passes none. Anything but a non-empty path gets memory: a missing
// dir must never fall back to some disk location (Colibri's own default is
// process.cwd()).
function createStorage(storageDir) {
  return typeof storageDir === 'string' && storageDir !== ''
    ? createDiskStorage(storageDir)
    : createMemoryStorage();
}

// Only plain, cloneable fields cross back to the main process. The router
// (via colibri-resolver.js) reads `code`, `data` (EVM revert bytes) and
// `message`.
function serializeError(err) {
  const out = {
    name: typeof err?.name === 'string' ? err.name : 'Error',
    message: String(err?.message ?? err ?? 'unknown error').slice(0, MAX_ERROR_MESSAGE),
  };
  if (typeof err?.code === 'number' || typeof err?.code === 'string') out.code = err.code;
  if (typeof err?.data === 'string') out.data = err.data;
  return out;
}

function createColibriService({ runtime, storageDir, post }) {
  const { Colibri, Strategy } = runtime;
  const clients = new Map();

  function clientFor(clientId, config) {
    let client = clients.get(clientId);
    if (!client) {
      client = new Colibri({
        chainId: config.chainId,
        prover: [config.proverUrl],
        zk_proof: config.zkProof,
        privacy_mode: PRIVACY_MODE,
        proofStrategy: Strategy.VerifiedOnly,
        max_latest_age_seconds: MAX_LATEST_AGE_SECONDS,
      });
      clients.set(clientId, client);
    }
    return client;
  }

  function destroy(clientId) {
    const client = clients.get(clientId);
    clients.delete(clientId);
    try { client?.destroy?.(); } catch { /* the host already dropped it */ }
  }

  async function init() {
    // A WASM trap leaves this worker's instance unusable; colibri-runtime swaps
    // in a fresh one, but the host replaces the whole worker anyway.
    runtime.setRuntimeResetListener?.((err) => {
      post({ type: 'trap', message: serializeError(err).message });
    });
    await Colibri.register_storage(createStorage(storageDir));
  }

  async function handle(message) {
    if (message?.type === 'ping') {
      post({ type: 'pong', id: message.id });
      return;
    }
    if (message?.type === 'destroy') {
      destroy(message.clientId);
      return;
    }
    if (message?.type !== 'request') return;
    const { id, clientId, config, method, params } = message;
    try {
      const result = await clientFor(clientId, config).request({ method, params });
      post({ type: 'result', id, ok: true, result });
    } catch (err) {
      const error = serializeError(err);
      // Refused by a WASM instance another request's trap retired: this request
      // did nothing wrong, and the host sends it to a fresh worker (#750).
      const retry = RETIRED_RUNTIME_ERROR.test(error.message);
      post({ type: 'result', id, ok: false, error, ...(retry ? { retry } : {}) });
    }
  }

  return { init, handle, clients };
}

if (!isMainThread && parentPort) {
  const post = (message) => parentPort.postMessage(message);
  try {
    // Never require the package directly — colibri-runtime pins the WASM
    // runtime and the bounds-check flag (see the comments there).
    const service = createColibriService({
      runtime: require('./colibri-runtime'),
      storageDir: workerData.storageDir,
      post,
    });
    parentPort.on('message', (message) => { service.handle(message); });
    service.init().then(
      () => post({ type: 'ready' }),
      (err) => post({ type: 'init-error', error: serializeError(err) })
    );
  } catch (err) {
    post({ type: 'init-error', error: serializeError(err) });
  }
}

module.exports = {
  createColibriService,
  createDiskStorage,
  createMemoryStorage,
  MEMORY_CACHE_MAX_BYTES,
  serializeError,
  STALE_TMP_MS,
};
