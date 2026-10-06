// Main-process side of the Colibri worker (#495): one long-lived worker per
// chain (`colibri-worker.js`) owns that chain's Colibri clients and verifier
// storage. This module hands out EIP-1193-shaped client proxies whose
// `request()` is a message round trip, so neither the router nor ethers'
// BrowserProvider (ENS) ever runs WASM verification on the main thread.
//
// A worker is replaced, never repaired:
// - a WASM trap (#453) marks it retiring: new requests go to a fresh worker and
//   the old one is terminated once its in-flight requests settle;
// - a request still pending at its caller's deadline triggers a liveness ping.
//   No pong within STUCK_PROBE_MS means the worker is stuck inside a
//   verification nobody is waiting for any more, so it is terminated and every
//   request on it fails (and falls through). A worker that does answer is only
//   waiting on the network, and keeps the request until ABANDONED_MS after the
//   deadline, after which it is terminated too — Colibri's own fetches carry no
//   timeout, so this is what bounds work the caller already gave up on.
//
// Every request promise returned here therefore settles: with the worker's
// answer, or when its worker is replaced. The router keeps its in-flight slot
// until then, as before.
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const log = require('../logger');

const WORKER_PATH = path.join(__dirname, 'colibri-worker.js');
// Requests without a caller deadline (ENS resolution through ethers) still get
// a liveness check, just a late one.
const DEFAULT_DEADLINE_MS = 60_000;
const STUCK_PROBE_MS = 1_000;
const ABANDONED_MS = 60_000;
const RESOURCE_LIMITS = Object.freeze({
  maxOldGenerationSizeMb: 256,
  maxYoungGenerationSizeMb: 32,
  stackSizeMb: 4,
});

class ColibriWorkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ColibriWorkerError';
  }
}

const workers = new Map();
let nextRequestId = 1;
let nextClientId = 1;
let storageDirOverride = null;

function storageDir() {
  if (storageDirOverride) return storageDirOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'colibri');
}

function reviveError(serialized) {
  const err = new Error(serialized?.message || 'Colibri request failed');
  if (serialized?.name) err.name = serialized.name;
  if (serialized?.code !== undefined) err.code = serialized.code;
  if (serialized?.data !== undefined) err.data = serialized.data;
  return err;
}

function settle(entry, id, fn) {
  const pending = entry.pending.get(id);
  if (!pending) return;
  entry.pending.delete(id);
  clearTimeout(pending.timer);
  fn(pending);
  if (entry.retiring && entry.pending.size === 0) terminate(entry);
}

function terminate(entry) {
  if (entry.terminated) return;
  entry.terminated = true;
  if (workers.get(entry.chainId) === entry) workers.delete(entry.chainId);
  for (const timer of entry.probes.values()) clearTimeout(timer);
  entry.probes.clear();
  try {
    Promise.resolve(entry.worker.terminate()).catch(() => {});
  } catch {
    // Already gone; the 'exit' handler below stays attached either way.
  }
}

// Fail everything on this worker and stop it. Idempotent: 'error', 'exit' and
// the watchdog can all race here.
function replace(entry, reason) {
  const wasLive = !entry.terminated;
  entry.readyReject?.(new ColibriWorkerError(`Colibri worker failed to start: ${reason}`));
  terminate(entry);
  const pending = [...entry.pending.values()];
  entry.pending.clear();
  for (const request of pending) {
    clearTimeout(request.timer);
    request.reject(new ColibriWorkerError(`Colibri worker replaced: ${reason}`));
  }
  if (wasLive && pending.length) {
    log.warn(`[colibri] chain ${entry.chainId} worker replaced (${reason}); ` +
      `${pending.length} request(s) failed`);
  }
}

function spawn(chainId) {
  const entry = {
    chainId,
    worker: null,
    pending: new Map(),
    probes: new Map(),
    retiring: false,
    terminated: false,
    readyReject: null,
    ready: null,
  };
  entry.ready = new Promise((resolve, reject) => {
    entry.readyResolve = resolve;
    entry.readyReject = reject;
  });
  // Callers that never await `ready` (a replaced worker) must not leave an
  // unhandled rejection behind.
  entry.ready.catch(() => {});
  workers.set(chainId, entry);
  try {
    entry.worker = new Worker(WORKER_PATH, {
      workerData: { storageDir: storageDir() },
      execArgv: [],
      env: { C4_DISABLE_NATIVE: '1' },
      resourceLimits: RESOURCE_LIMITS,
      // No `stdout: true`: Colibri's own console output keeps going to the
      // terminal as it did on the main thread, and a piped stream would hold
      // a ref'd port that keeps the process alive past `unref()`.
    });
  } catch (err) {
    entry.terminated = true;
    workers.delete(chainId);
    entry.readyReject(new ColibriWorkerError(`Colibri worker failed to start: ${err.message}`));
    return entry;
  }
  const { worker } = entry;
  worker.on('message', (message) => {
    switch (message?.type) {
      case 'ready':
        entry.readyReject = null;
        entry.readyResolve(entry);
        return;
      case 'init-error':
        replace(entry, `init failed (${message.error?.message || 'unknown error'})`);
        return;
      case 'result':
        settle(entry, message.id, (pending) => {
          if (message.ok) pending.resolve(message.result);
          else pending.reject(reviveError(message.error));
        });
        return;
      case 'pong': {
        const timer = entry.probes.get(message.id);
        if (timer) {
          clearTimeout(timer);
          entry.probes.delete(message.id);
        }
        return;
      }
      case 'trap':
        log.warn(`[colibri] chain ${chainId} WASM verifier trapped (${message.message}); ` +
          'replacing the worker');
        retire(entry);
        return;
      default:
    }
  });
  // Keep both attached through termination: a late worker error must not
  // become an unhandled main-process EventEmitter error.
  worker.on('error', (err) => replace(entry, `worker error: ${err?.message || err}`));
  worker.on('exit', (code) => replace(entry, `worker exited (${code})`));
  // An idle worker must not keep the process alive at quit. After the
  // listeners: attaching a 'message' listener re-refs the worker's port.
  worker.unref?.();
  return entry;
}

function retire(entry) {
  entry.retiring = true;
  if (workers.get(entry.chainId) === entry) workers.delete(entry.chainId);
  if (entry.pending.size === 0) terminate(entry);
}

function liveEntry(chainId) {
  const id = Number(chainId);
  const entry = workers.get(id);
  if (entry && !entry.retiring && !entry.terminated) return entry;
  return spawn(id);
}

// Resolves once the chain's worker has its storage registered.
function ensureWorker(chainId) {
  return liveEntry(chainId).ready.then(() => undefined);
}

function onDeadline(entry, id) {
  const pending = entry.pending.get(id);
  if (!pending || entry.terminated) return;
  const probeId = nextRequestId++;
  entry.probes.set(probeId, setTimeout(() => {
    entry.probes.delete(probeId);
    replace(entry, 'verification still running after its deadline');
  }, STUCK_PROBE_MS));
  try {
    entry.worker.postMessage({ type: 'ping', id: probeId });
  } catch {
    replace(entry, 'worker unreachable');
    return;
  }
  pending.timer = setTimeout(() => {
    if (entry.pending.has(id)) replace(entry, 'request abandoned after its deadline');
  }, ABANDONED_MS);
}

async function sendRequest(client, method, params, deadlineMs) {
  const entry = await liveEntry(client.chainId).ready;
  if (client.destroyed) throw new ColibriWorkerError('Colibri client was destroyed');
  return new Promise((resolve, reject) => {
    const id = nextRequestId++;
    const pending = { resolve, reject, timer: null };
    entry.pending.set(id, pending);
    for (const old of client.workers) if (old.terminated) client.workers.delete(old);
    client.workers.add(entry);
    pending.timer = setTimeout(
      () => onDeadline(entry, id),
      Math.max(1, Number(deadlineMs) || DEFAULT_DEADLINE_MS)
    );
    try {
      entry.worker.postMessage({
        type: 'request',
        id,
        clientId: client.id,
        config: client.config,
        method,
        params,
      });
    } catch (err) {
      settle(entry, id, (p) => p.reject(new ColibriWorkerError(
        `Colibri request could not be sent: ${err.message}`
      )));
    }
  });
}

// A Colibri client living in the chain's worker. `request` is EIP-1193, plus an
// optional `{ deadlineMs }` the caller will wait at most (see `onDeadline`).
function createClient({ chainId, proverUrl, zkProof }) {
  const client = {
    id: nextClientId++,
    chainId: Number(chainId),
    config: { chainId: Number(chainId), proverUrl, zkProof: zkProof !== false },
    destroyed: false,
    workers: new Set(),
  };
  return {
    request({ method, params } = {}, { deadlineMs } = {}) {
      return sendRequest(client, method, params ?? [], deadlineMs);
    },
    destroy() {
      if (client.destroyed) return;
      client.destroyed = true;
      for (const entry of client.workers) {
        if (entry.terminated) continue;
        try { entry.worker.postMessage({ type: 'destroy', clientId: client.id }); }
        catch { /* the worker is going away */ }
      }
      client.workers.clear();
    },
  };
}

function resetForTest({ storageDir: dir = null } = {}) {
  for (const entry of [...workers.values()]) replace(entry, 'test reset');
  workers.clear();
  storageDirOverride = dir;
}

module.exports = {
  createClient,
  ensureWorker,
  ColibriWorkerError,
  resetForTest,
  DEFAULT_DEADLINE_MS,
  STUCK_PROBE_MS,
  ABANDONED_MS,
};
