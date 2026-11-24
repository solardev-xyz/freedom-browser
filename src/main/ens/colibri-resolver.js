// Colibri itself runs outside the main thread, on one of two backends with
// one interface, picked by the development switch (colibri-backend.js,
// freedom-core design 0014, COL-5): by default a per-chain worker thread
// (#495, colibri-worker-host.js), whose synchronous WASM verification must
// never block Electron's main process, and which owns the package (via
// colibri-runtime), its disk storage and trap recovery; with
// FREEDOM_COLIBRI_BACKEND=service in a development build, the freedom-colibrid
// processes (colibri-service.js). Packaged builds always run the WASM one.
// The backend is part of a client's settings: a switch rebuilds the client
// on the other one.
const workerHost = require('./colibri-worker-host');
const { colibriBackendKind } = require('./colibri-backend');
const log = require('../logger');
const registry = require('../networks/network-registry');
const { isPrivateLogContext, privateSessionLive } = require('../private/private-log-context');
const { hostOf } = require('../ens-resolver');

// PRIVATE MODE GUARD (Colibri store, #1058). Colibri's store names every
// contract a read touched (`call_<chain>_<address>`), so a private window's
// reads must not go to the disk-backed one under <userData>/colibri. Every
// read here runs on one of two lanes per chain: the normal one, on the
// chain's disk-backed worker as before, or the private one, on the chain's
// private worker, whose store is in memory only and ends with the last
// private window (colibri-worker-host.js, or the chain's private process in
// colibri-service.js; `endPrivateColibriSession`). The
// lane is the async context's (private/private-log-context.js). Every read
// here is one of chain data's `shell.verified` operations (names don't use
// Colibri, #1076), and its executor sets that context from whether the
// operation may serve a private window (`runVerified`, core/naming-verified.js,
// which core/chain-verified.js shares). Clients, builds and their
// generations are kept per lane.
//
// A private read must also belong to the private session that is still
// open (`privateSessionLive`). A read that waited on Myotis, the network or
// anything else before reaching here can find its last private window
// closed: it is refused rather than given a fresh private worker, whose store
// would then carry its read into the next private session.
// colibri-service.js, once the switch has asked for it: loaded only then.
let colibriService = null;

function backendFor(kind) {
  if (kind !== 'service') return workerHost;
  colibriService ??= require('./colibri-service');
  return colibriService;
}

const clients = new Map();
const inFlightBuilds = new Map();
const clientReferences = new Map();
const retiredClients = new Set();
const buildGenerations = new Map();

function destroyClient(client) {
  if (!client || typeof client.destroy !== 'function') return;
  try {
    client.destroy();
  } catch (err) {
    log.warn(`[ens-colibri] failed to destroy old client: ${err.message}`);
  }
}

function retainClient(client) {
  clientReferences.set(client, (clientReferences.get(client) || 0) + 1);
}

function releaseClient(client) {
  const remaining = (clientReferences.get(client) || 1) - 1;
  if (remaining > 0) {
    clientReferences.set(client, remaining);
    return;
  }
  clientReferences.delete(client);
  if (retiredClients.delete(client)) destroyClient(client);
}

function retireClient(client) {
  if (!client) return;
  if ((clientReferences.get(client) || 0) > 0) {
    retiredClients.add(client);
    return;
  }
  destroyClient(client);
}

// Obtain a live client with a reference already held, closing
// the use-after-destroy window: retainClient only ran inside the old
// useClient, i.e. after `await getClient` resolved, and in that microtask gap a
// concurrent request's failure path could release the last ref and destroy the
// very client this caller was about to use. Here we retain optimistically and
// then re-validate that the retained client is still the cached one (and not
// retired); if it was swapped/evicted during the gap, release and re-acquire.
// The caller releases in a finally.
function laneKey(chainId, privateLane) {
  return privateLane ? `${chainId}:private` : String(chainId);
}

// A private read from a session that has ended: refused as a bystander, as
// the worker host refuses a stale private client, so the router's fault
// backoff does not count it.
function privateSessionEnded() {
  const err = new Error('Colibri private session ended');
  err.name = 'ColibriWorkerError';
  err.colibriBystander = true;
  return err;
}

function assertLaneLive(privateLane) {
  if (privateLane && !privateSessionLive()) throw privateSessionEnded();
}

async function acquireClient(chainId, privateLane = false) {
  const id = Number(chainId);
  const lane = laneKey(id, privateLane);
  for (;;) {
    const client = await getClient(id, privateLane);
    retainClient(client);
    const cached = clients.get(lane);
    if (cached?.client === client && !retiredClients.has(client)) {
      return { client };
    }
    // Evicted or rebuilt during the acquire gap — drop our ref and retry.
    releaseClient(client);
  }
}

function colibriRevertData(err) {
  const data = err?.data || err?.info?.error?.data || '';
  return typeof data === 'string' && data.length >= 10 ? data : null;
}

function retryableColibriError(err) {
  if (!err) return false;
  if (err.code === 'CALL_EXCEPTION') return colibriRevertData(err) === null;
  if (['NETWORK_ERROR', 'SERVER_ERROR', 'TIMEOUT'].includes(err.code)) return true;
  if (err.info?.error?.code === -32603) return true;
  return /ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|network|no response|timeout/i
    .test(err.shortMessage || err.message || '');
}

function sanitizeColibriErrorDetail(value, maxLength = 200) {
  if (value == null || value === '') return '';
  const cleaned = String(value)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '<url>')
    .replace(/0x[0-9a-fA-F]{66,}/g, (hex) =>
      `${hex.slice(0, 10)}…(${Math.floor((hex.length - 2) / 2)} bytes)`
    )
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length <= maxLength
    ? cleaned
    : `${cleaned.slice(0, maxLength - 1)}…`;
}

function colibriErrorForLog(err) {
  const nested = err?.info?.error;
  const message = sanitizeColibriErrorDetail(
    err?.shortMessage || err?.reason || err?.message || String(err)
  );
  const fields = [`error=${JSON.stringify(message || 'unknown error')}`];
  if (err?.code != null) fields.push(`code=${sanitizeColibriErrorDetail(err.code, 40)}`);
  if (nested?.code != null) fields.push(`rpcCode=${sanitizeColibriErrorDetail(nested.code, 40)}`);
  if (nested?.message) {
    fields.push(`rpcMessage=${JSON.stringify(sanitizeColibriErrorDetail(nested.message))}`);
  }
  fields.push(`revert=${colibriRevertData(err)?.slice(0, 10) || 'none'}`);
  return fields.join(' ');
}

// Evict only the client that actually failed. If another concurrent request
// or a settings change has already installed a replacement, leave it intact.
function evictFailedClient(lane, failedClient) {
  const cached = clients.get(lane);
  if (cached?.client !== failedClient) return;
  clients.delete(lane);
  retireClient(failedClient);
}

// Retry exactly once after rebuilding the in-memory verifier. This recovers
// from a stale runtime after sleep or a transient prover/network failure while
// preserving fail-closed behavior: proof failures and reverts carrying actual
// EVM revert data are never retried or reclassified.
async function withColibriClientRetry(chainId, operation) {
  const id = Number(chainId);
  // Read once: the retry stays on the lane the request started on.
  const privateLane = isPrivateLogContext();
  assertLaneLive(privateLane);
  const first = await acquireClient(id, privateLane);
  try {
    return await operation(first);
  } catch (err) {
    if (!retryableColibriError(err)) throw err;
    log.warn(
      `[colibri] chain ${id} request failed; rebuilding client and retrying once ` +
      colibriErrorForLog(err)
    );
    evictFailedClient(laneKey(id, privateLane), first.client);
    const retry = await acquireClient(id, privateLane);
    try {
      return await operation(retry);
    } finally {
      releaseClient(retry.client);
    }
  } finally {
    // Always releases first's acquire ref — on success, on a rethrown
    // non-retryable error, and after the retry path above. Dropping the last
    // ref on an evicted/retired client is what finally destroys it.
    releaseClient(first.client);
  }
}

async function buildClient({ chainId, privateLane, key, backend, proverUrl, zkProof, generation }) {
  const lane = laneKey(chainId, privateLane);
  const host = backendFor(backend);
  const lanePrivate = privateLane ? { private: true } : null;
  // The client first: the backend learns the lane's settings from it, and
  // the native one lets a lane it stopped under other settings start again
  // (colibri-service.js). It is used only once the lane is ready, and
  // destroyed if it never gets there.
  const client = host.createClient({ chainId, proverUrl, zkProof, ...lanePrivate });
  // The chain's worker registers the verifier's storage before it reports
  // ready; settings-change rebuilds reuse the same worker and storage. The
  // private lane's is its private worker, with storage in memory only.
  try {
    if (lanePrivate) await host.ensureWorker(chainId, lanePrivate);
    else await host.ensureWorker(chainId);
  } catch (err) {
    destroyClient(client);
    throw err;
  }

  if (generation !== buildGenerations.get(lane)) {
    destroyClient(client);
    return getClient(chainId, privateLane);
  }

  const previousClient = clients.get(lane)?.client;
  clients.set(lane, { client, key });
  retireClient(previousClient);
  log.info(
    `[colibri] chain ${chainId}${privateLane ? ' (private)' : ''} client ready ` +
    `(prover=${hostOf(proverUrl)}, zk=${zkProof}${backend === 'service' ? ', service' : ''})`
  );
  return client;
}

// Lazy singleton. Cache key is the tuple of settings that materially
// affect proof state (prover URL + zk_proof flag) and the backend; a runtime
// change to any tears down the cached instance and rebuilds. WASM init is paid
// on first use, not module load. `inFlightBuild` collapses concurrent
// first-call lookups onto a single construction. The generation counter
// prevents a slower old-settings build from replacing a newer client.
async function getClient(chainId = 1, privateLane = false) {
  const id = Number(chainId);
  const lane = laneKey(id, privateLane);
  // Checked on every acquire: a retry, or a rebuild after the session's end
  // discarded its build, must not start the next session's worker.
  assertLaneLive(privateLane);
  const [proverUrl] = registry.getEndpoints(id, 'prover');
  if (!proverUrl) {
    throw new Error(`No Colibri prover configured for chain ${id}`);
  }
  const zkProof = registry.getNetwork(id)?.zkProof !== false;
  const backend = colibriBackendKind();
  const key = `${backend}|${proverUrl}|${zkProof}`;
  const cached = clients.get(lane);
  const inFlight = inFlightBuilds.get(lane);
  if (cached?.client && cached.key === key) {
    if (inFlight && inFlight.key !== key) {
      buildGenerations.set(lane, (buildGenerations.get(lane) || 0) + 1);
    }
    return cached.client;
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const generation = (buildGenerations.get(lane) || 0) + 1;
  buildGenerations.set(lane, generation);
  const promise = buildClient({
    chainId: id,
    privateLane,
    key,
    backend,
    proverUrl,
    zkProof,
    generation,
  });
  inFlightBuilds.set(lane, { key, promise, generation });
  try { return await promise; }
  finally {
    if (inFlightBuilds.get(lane)?.promise === promise) inFlightBuilds.delete(lane);
  }
}

// Chain data's Colibri operations (core/chain-verified.js). ENS, reverse and
// NameNFT lookups don't use Colibri (#1076): it runs their `eth_call` on
// contract code from a public RPC, unchecked against the proven code hash.
//
// `deadlineMs` is how long the caller will wait: past it, a worker still
// verifying this request is terminated rather than left running.
async function requestViaColibri(chainId, method, params = [], { deadlineMs } = {}) {
  return withColibriClientRetry(chainId, ({ client }) =>
    client.request({ method, params }, { deadlineMs })
  );
}

// The last private window has closed (#1058): drop every private lane's
// client, discard a private build still in flight, and end the private
// session in the worker host, which terminates the private workers and
// their in-memory stores, and in the service once it was loaded, which
// stops its private processes. Normal lanes are untouched. A private read after
// this starts a fresh, empty store.
function endPrivateColibriSession() {
  const privateLanes = new Set(
    [...clients.keys(), ...inFlightBuilds.keys(), ...buildGenerations.keys()]
      .filter((lane) => lane.endsWith(':private'))
  );
  for (const lane of privateLanes) {
    buildGenerations.set(lane, (buildGenerations.get(lane) || 0) + 1);
    inFlightBuilds.delete(lane);
    const cached = clients.get(lane);
    clients.delete(lane);
    if (cached) retireClient(cached.client);
  }
  workerHost.endPrivateSession();
  colibriService?.endPrivateSession();
}

// The quit: every freedom-colibrid process stops (the WASM workers don't
// hold the app open). Resolves once each has exited.
function stopColibri() {
  return colibriService ? colibriService.stopAll() : Promise.resolve();
}

// Registers the end of the private session: once the last private window
// has closed, its Colibri store goes (`endPrivateColibriSession`). The
// private-window registry's hooks run after the closed window has left the
// count (private/private-windows.js).
function registerColibriPrivateCleanup({ registerPrivateCleanup, getPrivateWindowCount }) {
  registerPrivateCleanup(() => {
    if (getPrivateWindowCount() === 0) endPrivateColibriSession();
  });
}

function clearColibriClientForTest() {
  for (const { client } of clients.values()) retireClient(client);
  for (const lane of new Set([
    ...clients.keys(),
    ...inFlightBuilds.keys(),
    ...buildGenerations.keys(),
  ])) {
    buildGenerations.set(lane, (buildGenerations.get(lane) || 0) + 1);
  }
  clients.clear();
  inFlightBuilds.clear();
  for (const client of retiredClients) destroyClient(client);
  clientReferences.clear();
  retiredClients.clear();
}

module.exports = {
  requestViaColibri,
  endPrivateColibriSession,
  registerColibriPrivateCleanup,
  stopColibri,
  clearColibriClientForTest,
};
