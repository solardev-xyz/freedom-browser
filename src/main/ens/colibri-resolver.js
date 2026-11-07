const { ethers } = require('ethers');
const { ccipReadFetch } = require('./ccip-fetch');
// Colibri itself runs in a per-chain worker thread (#495): proof verification
// is synchronous WASM and must never block Electron's main process. The worker
// owns the package (via colibri-runtime), its disk storage and trap recovery.
const workerHost = require('./colibri-worker-host');
const log = require('../logger');
const registry = require('../networks/network-registry');
const { isPrivateLogContext } = require('../private/private-log-context');
const { universalResolverCall, universalResolverReverse, hostOf } = require('../ens-resolver');

// PRIVATE MODE GUARD (Colibri store, #1058). Colibri's store names every
// contract a read touched (`call_<chain>_<address>`), so a private window's
// reads must not go to the disk-backed one under <userData>/colibri. Every
// read here runs on one of two lanes per chain: the normal one, on the
// chain's disk-backed worker as before, or the private one, on the chain's
// private worker, whose store is in memory only and ends with the last
// private window (colibri-worker-host.js, `endPrivateColibriSession`). The
// lane is the async context's (private/private-log-context.js). Every read
// here is one of the cores' `shell.verified` operations, ENS and chain data
// alike, and their executor sets that context from whether the operation
// may serve a private window (core/naming-verified.js `runVerified`).
// Clients, builds and their generations are kept per lane.
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

// Obtain a live client + its provider with a reference already held, closing
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

async function acquireClient(chainId, privateLane = false) {
  const id = Number(chainId);
  const lane = laneKey(id, privateLane);
  for (;;) {
    const client = await getClient(id, privateLane);
    retainClient(client);
    const cached = clients.get(lane);
    if (cached?.client === client && !retiredClients.has(client)) {
      return { client, provider: cached.provider };
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

async function buildClient({ chainId, privateLane, key, proverUrl, zkProof, generation }) {
  const lane = laneKey(chainId, privateLane);
  // The chain's worker registers the verifier's storage before it reports
  // ready; settings-change rebuilds reuse the same worker and storage. The
  // private lane's is its private worker, with storage in memory only.
  const lanePrivate = privateLane ? { private: true } : null;
  if (lanePrivate) await workerHost.ensureWorker(chainId, lanePrivate);
  else await workerHost.ensureWorker(chainId);

  const client = workerHost.createClient({ chainId, proverUrl, zkProof, ...lanePrivate });

  if (generation !== buildGenerations.get(lane)) {
    destroyClient(client);
    return getClient(chainId, privateLane);
  }

  const previousClient = clients.get(lane)?.client;
  // Co-locate the provider with its client in one entry so acquireClient
  // captures the {client, provider} pair atomically — a separate providers
  // map can return undefined mid-rebuild or a provider from another
  // generation.
  const provider = new ethers.BrowserProvider(client);
  // Colibri pins EVM reads internally, so ethers sees "latest" and follows
  // OffchainLookup automatically. Its inherited gateway fetch has no body
  // cap and a 300s timeout; use the same bounds as Myotis.
  provider.ccipReadFetch = ccipReadFetch;
  clients.set(lane, { client, key, provider });
  retireClient(previousClient);
  log.info(
    `[colibri] chain ${chainId}${privateLane ? ' (private)' : ''} client ready ` +
    `(prover=${hostOf(proverUrl)}, zk=${zkProof})`
  );
  return client;
}

// Lazy singleton. Cache key is the tuple of settings that materially
// affect proof state (prover URL + zk_proof flag); a runtime change to
// either tears down the cached instance and rebuilds. WASM init is paid
// on first use, not module load. `inFlightBuild` collapses concurrent
// first-call lookups onto a single construction. The generation counter
// prevents a slower old-settings build from replacing a newer client.
async function getClient(chainId = 1, privateLane = false) {
  const id = Number(chainId);
  const lane = laneKey(id, privateLane);
  const [proverUrl] = registry.getEndpoints(id, 'prover');
  if (!proverUrl) {
    throw new Error(`No Colibri prover configured for chain ${id}`);
  }
  const zkProof = registry.getNetwork(id)?.zkProof !== false;
  const key = `${proverUrl}|${zkProof}`;
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
  const promise = buildClient({ chainId: id, privateLane, key, proverUrl, zkProof, generation });
  inFlightBuilds.set(lane, { key, promise, generation });
  try { return await promise; }
  finally {
    if (inFlightBuilds.get(lane)?.promise === promise) inFlightBuilds.delete(lane);
  }
}

// One resolver call (`callResolver`: the Universal Resolver or a NameNFT
// contract), its answer cryptographically verified by Colibri rather than
// corroborated across multiple public RPCs; the naming core's verified
// operations run it (core/naming-verified.js). No blockTag override —
// Colibri's verifier pins to head − 1 by construction (sync committee
// signatures for block N live in block N+1).
async function resolveCallViaColibri(name, callData, callResolver = universalResolverCall) {
  return withColibriClientRetry(1, ({ provider }) =>
    callResolver(provider, name, callData)
  );
}

async function resolveViaColibri(name, callData) {
  return resolveCallViaColibri(name, callData, universalResolverCall);
}

// Reverse counterpart: cryptographically-verified `ur.reverse` for an
// address. Returns { name } on a successful (forward-verified) lookup.
// Throws on revert (UR's ResolverNotFound / ReverseAddressMismatch) or
// network/verification failure — the naming core classifies.
async function resolveReverseViaColibri(addressBytes, coinType = 60n) {
  return withColibriClientRetry(1, ({ provider }) =>
    universalResolverReverse(provider, addressBytes, {}, coinType)
  );
}

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
// their in-memory stores. Normal lanes are untouched. A private read after
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
  resolveCallViaColibri,
  resolveViaColibri,
  resolveReverseViaColibri,
  requestViaColibri,
  endPrivateColibriSession,
  registerColibriPrivateCleanup,
  clearColibriClientForTest,
};
