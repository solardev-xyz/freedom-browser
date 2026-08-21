const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { ethers } = require('ethers');
const Colibri = require('@corpus-core/colibri-stateless').default;
const { Strategy } = require('@corpus-core/colibri-stateless');
const log = require('../logger');
const registry = require('../networks/network-registry');
const { universalResolverCall, universalResolverReverse, hostOf } = require('../ens-resolver');

// privacy_mode 'basic' is a strict improvement (call params never sent
// to the prover); pinning rather than exposing as a toggle keeps the
// threat model legible.
const PRIVACY_MODE = 'basic';
const MAX_LATEST_AGE_SECONDS = 60;

const clients = new Map();
const inFlightBuilds = new Map();
const clientReferences = new Map();
const retiredClients = new Set();
let storageRegistration = null;
let storageRegistered = false;
const buildGenerations = new Map();

// Disk-backed storage adapter for Colibri's verifier state (sync committee
// pubkeys, current head witness, etc — keys like "states_1" / "sync_1_<slot>").
// The bundled default writes these to process.cwd(), which means launching
// the browser from a different directory loses the warm-cache state and
// scatters files across the filesystem. Redirect to a stable per-app dir.
function createDiskStorage() {
  const dir = path.join(app.getPath('userData'), 'colibri');
  fs.mkdirSync(dir, { recursive: true });
  return {
    get: (key) => {
      try { return fs.readFileSync(path.join(dir, key)); }
      catch { return null; }
    },
    set: (key, value) => { fs.writeFileSync(path.join(dir, key), value); },
    del: (key) => {
      try { fs.unlinkSync(path.join(dir, key)); }
      catch (err) { if (err.code !== 'ENOENT') throw err; }
    },
  };
}

async function ensureStorageRegistered() {
  if (storageRegistered) return;
  if (!storageRegistration) {
    storageRegistration = Colibri.register_storage(createDiskStorage())
      .then(() => { storageRegistered = true; })
      .catch((err) => {
        storageRegistration = null;
        throw err;
      });
  }
  await storageRegistration;
}

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
async function acquireClient(chainId) {
  const id = Number(chainId);
  for (;;) {
    const client = await getClient(id);
    retainClient(client);
    const cached = clients.get(id);
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
function evictFailedClient(chainId, failedClient) {
  const cached = clients.get(chainId);
  if (cached?.client !== failedClient) return;
  clients.delete(chainId);
  retireClient(failedClient);
}

// Retry exactly once after rebuilding the in-memory verifier. This recovers
// from a stale runtime after sleep or a transient prover/network failure while
// preserving fail-closed behavior: proof failures and reverts carrying actual
// EVM revert data are never retried or reclassified.
async function withColibriClientRetry(chainId, operation) {
  const id = Number(chainId);
  const first = await acquireClient(id);
  try {
    return await operation(first);
  } catch (err) {
    if (!retryableColibriError(err)) throw err;
    log.warn(
      `[colibri] chain ${id} request failed; rebuilding client and retrying once ` +
      colibriErrorForLog(err)
    );
    evictFailedClient(id, first.client);
    const retry = await acquireClient(id);
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

async function buildClient({ chainId, key, proverUrl, zkProof, generation }) {
  // Storage adapter is registered exactly once per process: on the very
  // first construction. Later settings-change rebuilds reuse it — the
  // adapter is keyless and the Colibri runtime expects a single global.
  await ensureStorageRegistered();

  const client = new Colibri({
    chainId,
    prover: [proverUrl],
    zk_proof: zkProof,
    privacy_mode: PRIVACY_MODE,
    proofStrategy: Strategy.VerifiedOnly,
    max_latest_age_seconds: MAX_LATEST_AGE_SECONDS,
  });

  if (generation !== buildGenerations.get(chainId)) {
    destroyClient(client);
    return getClient(chainId);
  }

  const previousClient = clients.get(chainId)?.client;
  // Co-locate the provider with its client in one entry so acquireClient
  // captures the {client, provider} pair atomically — a separate providers
  // map can return undefined mid-rebuild or a provider from another
  // generation.
  clients.set(chainId, { client, key, provider: new ethers.BrowserProvider(client) });
  retireClient(previousClient);
  log.info(`[colibri] chain ${chainId} client ready (prover=${hostOf(proverUrl)}, zk=${zkProof})`);
  return client;
}

// Lazy singleton. Cache key is the tuple of settings that materially
// affect proof state (prover URL + zk_proof flag); a runtime change to
// either tears down the cached instance and rebuilds. WASM init is paid
// on first use, not module load. `inFlightBuild` collapses concurrent
// first-call lookups onto a single construction. The generation counter
// prevents a slower old-settings build from replacing a newer client.
async function getClient(chainId = 1) {
  const id = Number(chainId);
  const [proverUrl] = registry.getEndpoints(id, 'prover');
  if (!proverUrl) {
    throw new Error(`No Colibri prover configured for chain ${id}`);
  }
  const zkProof = registry.getNetwork(id)?.zkProof !== false;
  const key = `${proverUrl}|${zkProof}`;
  const cached = clients.get(id);
  const inFlight = inFlightBuilds.get(id);
  if (cached?.client && cached.key === key) {
    if (inFlight && inFlight.key !== key) {
      buildGenerations.set(id, (buildGenerations.get(id) || 0) + 1);
    }
    return cached.client;
  }
  if (inFlight && inFlight.key === key) return inFlight.promise;

  const generation = (buildGenerations.get(id) || 0) + 1;
  buildGenerations.set(id, generation);
  const promise = buildClient({ chainId: id, key, proverUrl, zkProof, generation });
  inFlightBuilds.set(id, { key, promise, generation });
  try { return await promise; }
  finally {
    if (inFlightBuilds.get(id)?.promise === promise) inFlightBuilds.delete(id);
  }
}

// Drop-in for what a single `consensusResolve` leg does today, but the
// answer is cryptographically verified by Colibri rather than corroborated
// across multiple public RPCs. No blockTag override — Colibri's verifier
// pins to head − 1 by construction (sync committee signatures for block N
// live in block N+1).
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
// network/verification failure — the orchestrator classifies.
async function resolveReverseViaColibri(addressBytes) {
  return withColibriClientRetry(1, ({ provider }) =>
    universalResolverReverse(provider, addressBytes)
  );
}

async function requestViaColibri(chainId, method, params = []) {
  return withColibriClientRetry(chainId, ({ client }) =>
    client.request({ method, params })
  );
}

function clearColibriClientForTest() {
  for (const { client } of clients.values()) retireClient(client);
  for (const chainId of new Set([
    ...clients.keys(),
    ...inFlightBuilds.keys(),
    ...buildGenerations.keys(),
  ])) {
    buildGenerations.set(chainId, (buildGenerations.get(chainId) || 0) + 1);
  }
  clients.clear();
  inFlightBuilds.clear();
  for (const client of retiredClients) destroyClient(client);
  clientReferences.clear();
  retiredClients.clear();
  storageRegistration = null;
  storageRegistered = false;
}

module.exports = {
  resolveCallViaColibri,
  resolveViaColibri,
  resolveReverseViaColibri,
  requestViaColibri,
  clearColibriClientForTest,
};
