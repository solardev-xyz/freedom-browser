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
//
// A request that was merely on the same worker as the one that broke it is
// not failed with it (#750): one unknown-hash receipt lookup used to take its
// worker's two to four unrelated requests down too. Such a bystander is sent
// once more, to the fresh worker, with whatever is left of its own deadline:
// - when the worker is killed as stuck, every request on it that has not
//   itself reached its deadline. The host cannot see which request the
//   verifier is spinning in, only whose deadline fired first. The suspects
//   are the requests already posted when the liveness ping went out (one
//   posted later never reached the stuck worker) and still pending when the
//   probe expires. With one suspect left it is blamed. With several that all
//   share one method (a dApp polling a pending receipt every second has its
//   previous poll on the worker too) one of them is blamed, the deadline
//   holder when it is still among them: the router's fault backoff is per
//   method, so that names the right one whichever of them spins. With mixed
//   methods nobody is: the overdue ones fail as bystanders, and the real
//   culprit, resent, is caught (and blamed) on its next worker if it spins
//   again, alone or among requests of its own method;
// - after a trap, every draining request the retired WASM instance refused
//   (the worker reports those as `retry`; colibri-runtime.js).
// The request that trapped or overran, or was blamed for a stuck worker, is
// not retried (even with deadline left: it would spin again), nor is a
// bystander a second time, nor one whose client was destroyed meanwhile.
//
// A bystander that still fails (overdue itself, already resent, or refused
// by the retired instance with no deadline left) carries `colibriBystander`
// on its error: the router's per-method verifier-fault backoff must not count
// a fault another request caused against the bystander's own method.
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

// Whether `request` may be sent again to a fresh worker (see the header). The
// request whose deadline started the stuck-worker check has none left.
function canResend(request) {
  return !request.resent && !request.client.destroyed &&
    request.deadlineAt - Date.now() > 0;
}

function resend(request) {
  request.resent = true;
  dispatch(request).catch(request.reject);
}

function bystanderError(err) {
  err.colibriBystander = true;
  return err;
}

// Fail everything on this worker and stop it. Idempotent: 'error', 'exit' and
// the watchdog can all race here. `culpritId` names the request known to have
// led to the replacement, when one did; every other request is a bystander.
// `{ unattributed }` (a stuck worker with several suspects on it) marks every
// request a bystander: one of them caused it, but which is unknown. With
// `{ resendBystanders }` (the stuck-worker watchdog), requests that did not
// cause the replacement, or may not have, are sent once more; the culprit
// never is.
function replace(entry, reason, {
  resendBystanders = false,
  culpritId = null,
  unattributed = false,
} = {}) {
  const wasLive = !entry.terminated;
  entry.readyReject?.(new ColibriWorkerError(`Colibri worker failed to start: ${reason}`));
  terminate(entry);
  const pending = [...entry.pending.entries()];
  entry.pending.clear();
  let failed = 0;
  let resent = 0;
  for (const [id, request] of pending) {
    clearTimeout(request.timer);
    if (resendBystanders && id !== culpritId && canResend(request)) {
      resent += 1;
      resend(request);
      continue;
    }
    failed += 1;
    const err = new ColibriWorkerError(`Colibri worker replaced: ${reason}`);
    request.reject(unattributed || (culpritId !== null && id !== culpritId) ? bystanderError(err) : err);
  }
  if (wasLive && pending.length) {
    log.warn(`[colibri] chain ${entry.chainId} worker replaced (${reason}); ` +
      `${failed} request(s) failed` + (resent ? `, ${resent} sent to the new worker` : ''));
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
          else if (message.retry && canResend(pending)) resend(pending);
          else if (message.retry) pending.reject(bystanderError(reviveError(message.error)));
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

// The request to blame for a stuck worker, or null when it cannot be told.
// `id` is the request whose deadline started the probe.
function stuckCulprit(entry, id, suspects) {
  const remaining = [...suspects].filter((suspect) => entry.pending.has(suspect));
  if (remaining.length === 0) return null;
  const { method } = entry.pending.get(remaining[0]);
  if (!remaining.every((suspect) => entry.pending.get(suspect).method === method)) return null;
  return remaining.includes(id) ? id : remaining[0];
}

function onDeadline(entry, id) {
  const pending = entry.pending.get(id);
  if (!pending || entry.terminated) return;
  const probeId = nextRequestId++;
  // Only a request already posted when the ping goes out can be the one the
  // worker is stuck in. The worker answers a ping synchronously from its
  // message handler and handles messages in order, so one posted after the
  // ping (a dApp's next receipt poll queued behind the spinning lookup) was
  // never even delivered to it if the pong does not come.
  const suspects = new Set(entry.pending.keys());
  entry.probes.set(probeId, setTimeout(() => {
    entry.probes.delete(probeId);
    // The worker is stuck, but in whichever request it is verifying, not
    // necessarily this one: this request's deadline may simply have come
    // first. A request alone among the suspects still on the worker is known
    // to be the culprit; among several of one method, one of them stands for
    // that method; otherwise nobody is blamed (see the header).
    const culpritId = stuckCulprit(entry, id, suspects);
    replace(entry, 'verification still running after its deadline', {
      resendBystanders: true,
      culpritId,
      unattributed: culpritId === null,
    });
  }, STUCK_PROBE_MS));
  try {
    entry.worker.postMessage({ type: 'ping', id: probeId });
  } catch {
    replace(entry, 'worker unreachable');
    return;
  }
  pending.timer = setTimeout(() => {
    if (entry.pending.has(id)) {
      replace(entry, 'request abandoned after its deadline', { culpritId: id });
    }
  }, ABANDONED_MS);
}

// Posts `request` to the chain's live worker (spawning one if needed). The
// request object outlives a worker: a resend dispatches it again, and its
// promise settles once, through request.resolve/reject.
async function dispatch(request) {
  const { client } = request;
  const entry = await liveEntry(client.chainId).ready;
  if (client.destroyed) throw new ColibriWorkerError('Colibri client was destroyed');
  // The deadline runs from the first time a worker is ready for the request,
  // as it always has; a resend keeps what is left of it.
  if (request.deadlineAt === null) request.deadlineAt = Date.now() + request.deadlineMs;
  const id = nextRequestId++;
  entry.pending.set(id, request);
  for (const old of client.workers) if (old.terminated) client.workers.delete(old);
  client.workers.add(entry);
  request.timer = setTimeout(
    () => onDeadline(entry, id),
    Math.max(1, request.deadlineAt - Date.now())
  );
  try {
    entry.worker.postMessage({
      type: 'request',
      id,
      clientId: client.id,
      config: client.config,
      method: request.method,
      params: request.params,
    });
  } catch (err) {
    settle(entry, id, (p) => p.reject(new ColibriWorkerError(
      `Colibri request could not be sent: ${err.message}`
    )));
  }
}

function sendRequest(client, method, params, deadlineMs) {
  return new Promise((resolve, reject) => {
    const request = {
      client,
      method,
      params,
      deadlineMs: Math.max(1, Number(deadlineMs) || DEFAULT_DEADLINE_MS),
      deadlineAt: null,
      resolve,
      reject,
      timer: null,
      resent: false,
    };
    dispatch(request).catch(reject);
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
