const log = require('./logger');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const { ens_normalize } = require('@adraffy/ens-normalize');
const IPC = require('../shared/ipc-channels');
const { success, failure } = require('./ipc-contract');
const { loadSettings, DEFAULT_ENS_PUBLIC_RPC_PROVIDERS } = require('./settings-store');
const { prefetchGatewayUrl, NOOP_HANDLE: NOOP_PREFETCH } = require('./ens-prefetch');

// Canonical ENS Universal Resolver — a DAO-owned proxy that delegates to
// the current implementation, so future UR upgrades don't require a code
// change here. Docs: https://docs.ens.domains/resolvers/universal/
// One call replaces the 3-step "registry lookup → supportsWildcard →
// contenthash" flow ethers would otherwise make, and handles CCIP-Read
// transparently for offchain resolvers (.box via 3DNS).
const UNIVERSAL_RESOLVER_ADDRESS = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
const UR_ABI = [
  'function resolve(bytes name, bytes data) view returns (bytes result, address resolver)',
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primary, address resolver, address reverseResolver)',
];

// bytes4(keccak256("contenthash(bytes32)"))
const CONTENTHASH_SELECTOR = '0xbc1c58d1';
// bytes4(keccak256("addr(bytes32)"))
const ADDR_SELECTOR = '0x3b3b57de';

// SLIP-0044 coin type for Ethereum mainnet, used by UR.reverse.
const ETH_COIN_TYPE = 60n;

// ENS contenthash byte patterns (EIP-1577). We preserve the CIDv0 base58
// output ("QmFoo…") for IPFS/IPNS to stay byte-compatible with the
// previous ethers-based implementation — users' bookmarks and history
// entries keyed on the old URI form keep matching.
//   0xe3 01 70             — ipfs-ns, cidv1, dag-pb
//   0xe5 01 72             — ipns-ns, cidv1, libp2p-key
//   0xe4 01 01 fa 01 1b 20 — swarm-ns + manifest codec, 32-byte keccak
const IPFS_CONTENTHASH_RE =
  /^0x(?<codecPrefix>e3010170|e5010172)(?<multihash>(?<mhCode>[0-9a-f]{2})(?<mhLen>[0-9a-f]{2})(?<digest>[0-9a-f]*))$/;
const SWARM_CONTENTHASH_RE = /^0xe40101fa011b20(?<swarmHash>[0-9a-f]{64})$/;

// Read effective custom RPC URL from settings (empty string = disabled/unset)
function getCustomRpcUrl() {
  try {
    const settings = loadSettings();
    if (settings.enableEnsCustomRpc !== true) return '';
    return (settings.ensRpcUrl || '').trim();
  } catch {
    return '';
  }
}

// Build the effective provider list for the legacy single-source path
// (reverse resolution). Sources from the same user-configured list the
// quorum path uses, so a provider the user removed in settings is also
// excluded here.
function getRpcProviders() {
  const custom = getCustomRpcUrl();
  const publicList = getEffectivePublicProviders();
  return custom ? [custom, ...publicList] : publicList;
}

// ---------------------------------------------------------------------------
// Session-shuffled public-RPC pool with per-provider quarantine. Backs the
// `consensusResolve` primitive defined later; the one remaining caller of
// the older `getWorkingProvider` path is reverse resolution.
// ---------------------------------------------------------------------------

// Per-provider sticky failure with exponential cooldown. In-memory only,
// cleared on process restart and on settings change (via invalidateProviderPool).
const quarantine = new Map(); // url → { failures, cooldownUntil }
const QUARANTINE_BASE_MS = 60_000;
const QUARANTINE_MAX_MS = 600_000;

// Shuffle state: recomputed on first use and whenever the effective provider
// list changes. `sourceKey` is the joined URL list we shuffled, so we can
// detect settings edits without diffing array contents every call.
let shuffledProviderOrder = null;
let shuffledProviderSourceKey = null;

// Fisher-Yates with Math.random — not adversarial, just load-spreading
// across the user population so everyone doesn't hammer position 0.
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Effective public-RPC list from settings, with ETH_RPC env override
// prepended for dev convenience. Falls back to defaults if the saved list
// is empty/missing — the settings UI will enforce non-emptiness, but
// defense-in-depth here keeps resolution working if the file is corrupted.
function getEffectivePublicProviders() {
  const settings = loadSettings();
  const saved =
    Array.isArray(settings.ensPublicRpcProviders) && settings.ensPublicRpcProviders.length > 0
      ? settings.ensPublicRpcProviders
      : DEFAULT_ENS_PUBLIC_RPC_PROVIDERS;

  const envOverride = (process.env.ETH_RPC || '').trim();
  const list = envOverride ? [envOverride, ...saved] : [...saved];

  // De-dupe by case-insensitive URL; drop empties.
  const seen = new Set();
  return list.filter((url) => {
    if (typeof url !== 'string') return false;
    const trimmed = url.trim();
    if (!trimmed) return false;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Shuffled provider order, recomputed only when the effective list changes.
function getShuffledPublicProviders() {
  const effective = getEffectivePublicProviders();
  const sourceKey = effective.join('|');
  if (shuffledProviderSourceKey !== sourceKey) {
    shuffledProviderOrder = shuffleInPlace([...effective]);
    shuffledProviderSourceKey = sourceKey;
  }
  return shuffledProviderOrder;
}

function isQuarantined(url) {
  const entry = quarantine.get(url);
  if (!entry) return false;
  if (Date.now() >= entry.cooldownUntil) {
    quarantine.delete(url);
    return false;
  }
  return true;
}

function markProviderFailure(url) {
  const entry = quarantine.get(url) || { failures: 0, cooldownUntil: 0 };
  entry.failures += 1;
  const cooldown = Math.min(QUARANTINE_BASE_MS * 2 ** (entry.failures - 1), QUARANTINE_MAX_MS);
  entry.cooldownUntil = Date.now() + cooldown;
  quarantine.set(url, entry);
}

function markProviderSuccess(url) {
  quarantine.delete(url);
}

// Returns providers in shuffled order, quarantined ones filtered out.
function getAvailableProviders() {
  return getShuffledPublicProviders().filter((url) => !isQuarantined(url));
}

// Reset all pool state. Settings-list changes are detected lazily by
// `getShuffledPublicProviders` (source-key diff), so this is only needed
// for tests and for the exported `invalidateCachedProvider` that external
// code calls after a settings edit to also drop quarantine memory.
function invalidateProviderPool() {
  shuffledProviderOrder = null;
  shuffledProviderSourceKey = null;
  quarantine.clear();
  pinnedBlockCache = null;
}

// ---------------------------------------------------------------------------
// Block anchor: the shared (number, hash) all quorum legs query at, so
// honest-but-unsynced providers don't produce false conflicts. Fetched from
// one or two providers, cached for ensBlockAnchorTtlMs (default 30s).
// ---------------------------------------------------------------------------

let pinnedBlockCache = null; // { anchor, number, hash, expiresAt }

// Safety depth (in blocks) subtracted from the corroborated head before the
// anchor hash is fetched. Keeps the anchor past typical reorg depth and
// gives providers time to converge on block availability.
//   latest:     ~1.5min behind head (12s * 8)
//   latest-32:  ~6.5min behind head — stronger but fresher than finalized
//   finalized:  already settled on-chain; no additional depth needed
const ANCHOR_SAFETY_DEPTH = { latest: 8, 'latest-32': 32, finalized: 0 };

// Minimum provider count for the corroborated quorum path. With K<3 a
// single lying provider can bias the anchor selection (median needs 3 to
// tolerate 1 outlier), so fewer than 3 available providers falls through
// to the single-source unverified path instead of claiming "verified".
const MIN_QUORUM_PROVIDERS = 3;

// Create a short-lived provider for a single scoped operation, wrap the
// caller's work in withTimeout, and guarantee the provider is destroyed
// on both success and timeout. `fn` receives the bound provider.
async function withEphemeralProvider(url, timeoutMs, fn) {
  const provider = new ethers.JsonRpcProvider(url);
  const cleanup = () => { try { provider.destroy(); } catch { /* already torn down */ } };
  try {
    return await withTimeout(fn(provider), timeoutMs, cleanup);
  } finally {
    cleanup();
  }
}

// Step 1 of anchor corroboration: the head (or finalized) block NUMBER.
// The finalized tag requires getBlock; everything else uses getBlockNumber.
async function fetchProviderHead(url, anchor, timeoutMs) {
  return withEphemeralProvider(url, timeoutMs, async (provider) => {
    if (anchor === 'finalized') {
      const block = await provider.getBlock('finalized');
      if (!block) throw new Error('finalized tag returned null');
      return block.number;
    }
    return provider.getBlockNumber();
  });
}

// Step 2 of anchor corroboration: the canonical block HASH at a specific
// block NUMBER. M providers must agree for the anchor to be usable.
async function fetchProviderBlockHashAt(url, blockNumber, timeoutMs) {
  return withEphemeralProvider(url, timeoutMs, async (provider) => {
    const block = await provider.getBlock(blockNumber);
    if (!block) throw new Error(`block ${blockNumber} not available`);
    return block.hash;
  });
}

// Single-source anchor: both steps (head → depth-safe target → block hash)
// against one provider, reusing one provider instance. Used by paths that
// explicitly opt out of cross-provider corroboration (user's custom RPC
// and the degraded single-available-provider case).
async function fetchSingleSourceAnchor(url, anchor, timeoutMs) {
  return withEphemeralProvider(url, timeoutMs, async (provider) => {
    let headNumber;
    if (anchor === 'finalized') {
      const block = await provider.getBlock('finalized');
      if (!block) throw new Error('finalized tag returned null');
      headNumber = block.number;
    } else {
      headNumber = await provider.getBlockNumber();
    }
    const safetyDepth = ANCHOR_SAFETY_DEPTH[anchor] ?? 8;
    const targetNumber = headNumber - safetyDepth;
    const block = await provider.getBlock(targetNumber);
    if (!block) throw new Error(`block ${targetNumber} not available`);
    return { number: targetNumber, hash: block.hash };
  });
}

// Pick a head number robust to up to (K-1)/2 lying providers — i.e. the
// median. Only called when heads.length ≥ 3 (the K<3 path bypasses
// corroboration entirely and falls through to single-source unverified).
function deriveCorroboratedHead(heads) {
  if (heads.length < MIN_QUORUM_PROVIDERS) {
    return { head: null, ok: false, reason: `need ≥${MIN_QUORUM_PROVIDERS} heads, got ${heads.length}` };
  }
  const sorted = heads.slice().sort((a, b) => a - b);
  return { head: sorted[Math.floor(sorted.length / 2)], ok: true };
}

// Two-step anchor corroboration: collect heads from K providers, derive a
// safety-deep target number from the median, then require M providers to
// agree on the block hash AT that target. A single malicious RPC cannot
// force a stale anchor — the median is robust to one outlier, and the
// hash-quorum step rejects solo forgeries. No M-agreement on the hash
// → throw rather than silently promote uncorroborated state to verified.
async function getPinnedBlock() {
  const settings = loadSettings();
  const anchor = settings.ensBlockAnchor || 'latest';
  const ttl = typeof settings.ensBlockAnchorTtlMs === 'number'
    ? settings.ensBlockAnchorTtlMs
    : 30_000;
  const timeoutMs = Number(settings.ensQuorumTimeoutMs) || 5000;
  const desiredK = Math.max(2, Math.min(Number(settings.ensQuorumK) || 3, 9));
  const desiredM = Math.max(2, Math.min(Number(settings.ensQuorumM) || 2, desiredK));

  if (pinnedBlockCache
      && pinnedBlockCache.anchor === anchor
      && Date.now() < pinnedBlockCache.expiresAt) {
    return { number: pinnedBlockCache.number, hash: pinnedBlockCache.hash };
  }

  const available = getAvailableProviders();
  if (available.length < MIN_QUORUM_PROVIDERS) {
    // Caller will fall through to the single-source unverified path.
    return null;
  }

  const effectiveM = Math.min(desiredM, available.length);

  // Step 1: probe every available provider for its head in parallel. Using
  // the whole pool (not just the first K) makes the median more robust
  // and means a single flaky provider can't sink the anchor step — there
  // are typically several more healthy RPCs left to corroborate against.
  const headResults = await Promise.allSettled(
    available.map((url) =>
      fetchProviderHead(url, anchor, timeoutMs)
        .then((number) => ({ url, number }))
        .catch((err) => { markProviderFailure(url); throw err; })
    )
  );
  const heads = headResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
  for (const { url } of heads) markProviderSuccess(url);

  if (heads.length < MIN_QUORUM_PROVIDERS) {
    // Runtime flakes left us without enough heads to corroborate. Caller
    // degrades to single-source unverified rather than failing the whole
    // resolution — the next retry will almost certainly hit the same
    // degraded path once the failed providers are quarantined anyway.
    log.info(`[ens] anchor infeasible: ${heads.length} of ${available.length} heads collected`);
    return null;
  }

  const { head, ok, reason } = deriveCorroboratedHead(heads.map((h) => h.number));
  if (!ok) {
    log.info(`[ens] anchor head disagreement: ${reason}`);
    return null;
  }

  const safetyDepth = ANCHOR_SAFETY_DEPTH[anchor] ?? 8;
  const targetNumber = head - safetyDepth;

  // Step 2: ask the same head-responders for the hash at the target. Any
  // provider reachable moments ago is likely still reachable, which keeps
  // the hash-quorum set as large as possible (harder for an attacker to
  // form a fake majority).
  const hashResults = await Promise.allSettled(
    heads.map(({ url }) =>
      fetchProviderBlockHashAt(url, targetNumber, timeoutMs)
        .then((hash) => ({ url, hash }))
        .catch((err) => { markProviderFailure(url); throw err; })
    )
  );
  const hashes = hashResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  const byHash = new Map();
  for (const { url, hash } of hashes) {
    const bucket = byHash.get(hash) || [];
    bucket.push(url);
    byHash.set(hash, bucket);
  }

  // Pick the hash with the MOST agreement (plurality) and require it to
  // meet both the user-configured M AND a strict majority of actual
  // respondents. "First bucket with ≥M" let a small collusion win via
  // Map iteration order when the probe set exceeds K — two attackers in
  // a 9-provider pool could be inserted first and satisfy M=2 even
  // though seven honest providers agreed on a different hash. On a
  // canonical chain honest providers all return the same hash, so the
  // largest bucket is the honest one unless attackers form a majority
  // (outside the threat model).
  let winner = { hash: null, urls: [] };
  for (const [hash, urls] of byHash) {
    if (urls.length > winner.urls.length) {
      winner = { hash, urls };
    }
  }
  const majorityThreshold = Math.floor(hashes.length / 2) + 1;
  const hashQuorumThreshold = Math.max(effectiveM, majorityThreshold);

  if (winner.urls.length >= hashQuorumThreshold) {
    for (const url of winner.urls) markProviderSuccess(url);
    const chosen = { number: targetNumber, hash: winner.hash };
    pinnedBlockCache = { anchor, ...chosen, expiresAt: Date.now() + ttl };
    return chosen;
  }

  throw new Error(
    `Could not reach hash quorum at block ${targetNumber} ` +
    `(largest bucket ${winner.urls.length} of ${hashes.length} responses, need ≥${hashQuorumThreshold})`
  );
}

// ethers v6 calls ignore AbortSignal, so on timeout we rely on the caller's
// onTimeout callback to destroy the provider and tear down the request.
function withTimeout(promise, ms, onTimeout) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (onTimeout) {
        try { onTimeout(); } catch { /* ignore teardown errors */ }
      }
      const err = new Error(`timeout after ${ms}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

let cachedProvider = null;
let cachedProviderUrl = null;

// Outcome-specific TTLs. Indexed by trust.level; the default fallback
// applies to legacy code paths (e.g. reverse resolution) that don't carry
// a trust field. Verified/user-configured outcomes are stable enough for
// 15min; unverified answers expire in 60s so transient public-RPC noise
// doesn't pin the user-facing result for long; conflict outcomes are
// negative-cached for 10s purely to avoid re-entry storms on repeated
// navigation attempts during an active lie.
const TTL_BY_LEVEL = {
  verified: 15 * 60 * 1000,
  'user-configured': 15 * 60 * 1000,
  unverified: 60 * 1000,
  conflict: 10 * 1000,
};
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

function ttlForResult(result) {
  const level = result?.trust?.level;
  if (level && Object.prototype.hasOwnProperty.call(TTL_BY_LEVEL, level)) {
    return TTL_BY_LEVEL[level];
  }
  return DEFAULT_CACHE_TTL_MS;
}

// Upper bound per cache. Long browsing sessions can accumulate thousands
// of distinct ENS names; without a cap the caches grow unboundedly since
// expired entries are only evicted on re-read. On set, if we're over the
// cap, drop expired entries first, then fall back to FIFO eviction.
const MAX_CACHE_ENTRIES = 500;

function capCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
      if (cache.size <= MAX_CACHE_ENTRIES) return;
    }
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  }
}

const ensResultCache = new Map();

// Independent from ensResultCache so content and addr lookups don't evict each other.
const ensAddressCache = new Map();

// Address (lowercased 0x) → { result, expiresAt } for reverse lookups.
const ensReverseCache = new Map();

// Get a working provider, trying each in sequence with fallback
async function getWorkingProvider() {
  // If the cached provider's URL no longer matches the current settings, invalidate it
  if (cachedProvider && cachedProviderUrl) {
    const providers = getRpcProviders();
    if (providers[0] !== cachedProviderUrl) {
      log.info(`[ens] Settings changed, invalidating cached provider: ${cachedProviderUrl}`);
      cachedProvider.destroy();
      cachedProvider = null;
      cachedProviderUrl = null;
    }
  }

  // Return cached provider if still working
  if (cachedProvider && cachedProviderUrl) {
    try {
      await cachedProvider.getBlockNumber();
      log.info(`[ens] Reusing cached provider: ${cachedProviderUrl}`);
      return cachedProvider;
    } catch {
      log.warn(`[ens] Cached provider ${cachedProviderUrl} failed, trying fallbacks...`);
      cachedProvider.destroy();
      cachedProvider = null;
      cachedProviderUrl = null;
    }
  }

  // Try each provider in sequence
  const providers = getRpcProviders();
  const total = providers.length;
  for (let i = 0; i < total; i++) {
    const rpcUrl = providers[i];
    const providerNum = `${i + 1}/${total}`;
    let provider;
    try {
      log.info(`[ens] Trying provider ${providerNum}: ${rpcUrl}`);
      provider = new ethers.JsonRpcProvider(rpcUrl);
      await provider.getBlockNumber(); // Health check
      log.info(`[ens] Using provider ${providerNum}: ${rpcUrl}`);
      cachedProvider = provider;
      cachedProviderUrl = rpcUrl;
      return provider;
    } catch (err) {
      log.warn(`[ens] Provider ${providerNum} failed: ${err.message}`);
      if (provider) {
        provider.destroy();
      }
    }
  }

  throw new Error('All RPC providers failed. Check your network connection.');
}

// Drop the cached single-provider used by getWorkingProvider. Cheap reset
// for the legacy retry loop — keeps quorum-path state (shuffled order,
// quarantine memory, pinned block anchor) intact, so a transient flake
// during reverse resolution doesn't make the next quorum wave pay an
// extra anchor RTT.
function dropCachedProvider() {
  if (cachedProvider) {
    log.info(`[ens] Invalidating cached provider: ${cachedProviderUrl}`);
    cachedProvider.destroy();
    cachedProvider = null;
    cachedProviderUrl = null;
  }
}

// Full reset: drop the legacy cached provider AND wipe the quorum pool
// (shuffled order, quarantine, pinned block). External callers use this
// after a settings edit so a re-tested RPC gets a fresh chance; tests
// call it between cases for a clean slate.
function invalidateCachedProvider() {
  dropCachedProvider();
  invalidateProviderPool();
}

// Check if an error is a provider/network error that warrants retry
function isProviderError(err) {
  const message = err.message || '';
  const code = err.code || '';

  // ethers.js error codes for network/server issues
  if (code === 'SERVER_ERROR' || code === 'NETWORK_ERROR' || code === 'TIMEOUT') {
    return true;
  }

  // CALL_EXCEPTION can mean contract reverted OR RPC provider failed.
  // Check for RPC internal errors (-32603) which indicate provider issues.
  if (code === 'CALL_EXCEPTION') {
    const rpcErrorCode = err.info?.error?.code;
    const rpcErrorMsg = err.info?.error?.message || '';
    // -32603 = JSON-RPC internal error, "no response" = provider didn't respond
    if (rpcErrorCode === -32603 || /no response/i.test(rpcErrorMsg)) {
      return true;
    }
  }

  // Common HTTP error patterns
  if (/502|503|504|429|timeout|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(message)) {
    return true;
  }

  return false;
}

// Maximum retries for provider errors during resolution
const MAX_RESOLUTION_RETRIES = 3;

// Canonical UR custom errors we classify. ethers v6 surfaces the 4-byte
// selector via err.data on CALL_EXCEPTION; some wrappers (JSON-RPC
// proxies) expose it under err.info.error.data instead — check both.
// Selectors are bytes4(keccak256(signature)).
//
// https://docs.ens.domains/resolvers/universal/
const UR_NOT_FOUND_SELECTORS = new Set([
  '0x77209fe8', // ResolverNotFound(bytes)
  '0x1e9535f2', // ResolverNotContract(bytes,address)
]);
const REVERSE_MISMATCH_SELECTOR = '0xef9c03ce'; // ReverseAddressMismatch(string,bytes)

function urErrorSelector(err) {
  const data = err?.data || err?.info?.error?.data || '';
  if (typeof data !== 'string' || data.length < 10) return null;
  return data.slice(0, 10).toLowerCase();
}

function isResolverNotFoundError(err) {
  const msg = err?.message || '';
  if (/ResolverNotFound|ResolverNotContract/i.test(msg)) return true;
  const sel = urErrorSelector(err);
  return sel !== null && UR_NOT_FOUND_SELECTORS.has(sel);
}

// UR.reverse reverts with this when the claimed primary name doesn't
// forward-resolve back to the input address. Semantically: spoofed or
// stale reverse record.
function isReverseAddressMismatchError(err) {
  const msg = err?.message || '';
  if (/ReverseAddressMismatch/i.test(msg)) return true;
  return urErrorSelector(err) === REVERSE_MISMATCH_SELECTOR;
}

// Call the Universal Resolver's resolve(name, data). `callData` is the raw
// ABI-encoded call the resolver would have received directly (selector +
// args). Returns the raw ABI-encoded response — the caller must decode
// per their function's return type (e.g. decode(['bytes'], ...) for
// contenthash, or decode(['address'], ...) for addr). Returning pre-decoded
// bytes here would silently work for dynamic returns and overflow for
// static ones.
//
// CCIP-Read is opted into per-call here because ethers v6 doesn't enable it
// by default — needed for .box domains resolved via 3DNS.
//
// `overrides` are merged into the call's overrides object (e.g. blockTag
// for block-pinned consensus legs). Callers that pass nothing get the
// default { enableCcipRead: true } shape.
async function universalResolverCall(provider, name, callData, overrides = {}) {
  const ur = new ethers.Contract(UNIVERSAL_RESOLVER_ADDRESS, UR_ABI, provider);
  const encodedName = ethers.dnsEncode(name, 255);
  const [resolvedData, resolverAddress] = await ur.resolve(encodedName, callData, {
    enableCcipRead: true,
    ...overrides,
  });
  return { resolvedData, resolverAddress };
}

// ---------------------------------------------------------------------------
// Consensus resolution: hedged-quorum over K public RPCs at a shared pinned
// block. Detects a lying RPC by requiring M byte-identical responses;
// single-source responses are returned with trust.level='unverified'.
// ---------------------------------------------------------------------------

function hostOf(url) {
  try { return new URL(url).host; }
  catch { return url; }
}

// Run a single leg: construct provider, call UR at blockTag=hash, classify
// result into one of:
//   { status: 'data',      resolvedData, resolverAddress }
//   { status: 'not_found', reason: 'NO_RESOLVER' | 'NO_CONTENTHASH', error? }
//   { status: 'error',     error }   ← quarantined
//
// NO_CONTENTHASH covers the case where the UR reverts for a reason other
// than ResolverNotFound (e.g. CCIP gateway failed for .box names). The
// provider answered, just not usefully — not quarantined. Network/timeout
// errors are the only class that quarantines.
//
// `cancelToken.cleanups` lets a caller (runConsensusWave) forcibly destroy
// this leg's provider when early-quorum agreement makes the leg redundant.
async function runQuorumLeg(url, name, callData, blockHash, timeoutMs, cancelToken) {
  let provider;
  const cleanup = () => {
    if (provider) {
      try { provider.destroy(); } catch { /* already torn down */ }
      provider = null;
    }
  };
  if (cancelToken) cancelToken.cleanups.add(cleanup);
  try {
    provider = new ethers.JsonRpcProvider(url);
    const urCall = universalResolverCall(provider, name, callData, { blockTag: blockHash });
    const result = await withTimeout(urCall, timeoutMs, cleanup);
    markProviderSuccess(url);
    return { url, status: 'data', resolvedData: result.resolvedData, resolverAddress: result.resolverAddress };
  } catch (err) {
    if (isResolverNotFoundError(err)) {
      markProviderSuccess(url);
      return { url, status: 'not_found', reason: 'NO_RESOLVER' };
    }
    if (isProviderError(err) || err.code === 'TIMEOUT') {
      markProviderFailure(url);
      return { url, status: 'error', error: err };
    }
    // Unknown UR revert — provider responded, response wasn't usable.
    // Treat as semantic "no contenthash here" for quorum agreement.
    markProviderSuccess(url);
    return { url, status: 'not_found', reason: 'NO_CONTENTHASH', error: err };
  } finally {
    cleanup();
  }
}

// Race K provider legs to an M-agreement. Returns early as soon as M legs
// produce byte-identical `data` OR M legs produce `not_found` with the
// same reason. Mixed negative reasons (NO_RESOLVER vs NO_CONTENTHASH)
// bucket separately — they describe different states, so conflating them
// would let a transient CCIP failure combine with a real NO_RESOLVER to
// forge a "verified not-found".
async function runConsensusWave({
  providers, name, callData, blockHash, timeoutMs, m, onFirstData,
}) {
  const results = new Map();    // url → leg result
  const byData = new Map();     // resolvedData bytes → Set<url>
  const byNegative = new Map(); // reason (e.g. NO_RESOLVER) → Set<url>
  const queried = providers.map(hostOf);

  // Shared token so we can tear down straggler providers when M-agreement
  // fires before all legs settle — keeps sockets + parsing work from
  // running uselessly in the background.
  const cancelToken = { cleanups: new Set() };

  // First `data` response kicks off speculative prefetch (if caller wired
  // one). Stored so we can abort on non-verified outcomes. Hard invariant:
  // onFirstData errors must never affect quorum — hence the try/catch and
  // the `?.abort` / noop fallback.
  let firstDataSeen = false;
  let prefetchHandle = null;
  const kickOffPrefetch = (resolvedData) => {
    if (firstDataSeen || !onFirstData) return;
    firstDataSeen = true;
    try {
      prefetchHandle = onFirstData(resolvedData) || NOOP_PREFETCH;
    } catch (err) {
      log.info(`[ens] onFirstData threw, skipping prefetch: ${err.message}`);
      prefetchHandle = NOOP_PREFETCH;
    }
  };

  let earlyResolve;
  const earlyPromise = new Promise((res) => { earlyResolve = res; });

  const checkEarly = () => {
    for (const [bytes, urls] of byData) {
      if (urls.size >= m) {
        earlyResolve({ kind: 'agreed_data', bytes, urls: Array.from(urls) });
        return true;
      }
    }
    for (const [reason, urls] of byNegative) {
      if (urls.size >= m) {
        earlyResolve({ kind: 'agreed_not_found', reason, urls: Array.from(urls) });
        return true;
      }
    }
    return false;
  };

  const legPromises = providers.map((url) =>
    runQuorumLeg(url, name, callData, blockHash, timeoutMs, cancelToken).then((r) => {
      results.set(url, r);
      if (r.status === 'data') {
        kickOffPrefetch(r.resolvedData);
        const bucket = byData.get(r.resolvedData) || new Set();
        bucket.add(url);
        byData.set(r.resolvedData, bucket);
      } else if (r.status === 'not_found') {
        const reason = r.reason || 'NO_RESOLVER';
        const bucket = byNegative.get(reason) || new Set();
        bucket.add(url);
        byNegative.set(reason, bucket);
      }
      checkEarly();
    })
  );

  const allSettled = Promise.allSettled(legPromises).then(() => ({ kind: 'all_settled' }));
  const outcome = await Promise.race([earlyPromise, allSettled]);

  // Tear down any still-open legs. Cleanups are idempotent (they null out
  // provider on first call), so running them against already-settled legs
  // is a no-op.
  if (outcome.kind !== 'all_settled') {
    for (const fn of cancelToken.cleanups) fn();
  }

  // Prefetch is only useful for `agreed_data` — everything else either
  // routes to an interstitial or throws, and the gateway fetch would be
  // wasted (or would warm attacker-chosen content the renderer will never
  // load). Aborting on anything-but-agreed_data is the safe default; the
  // prefetch module's abort is idempotent so this is fire-and-forget.
  if (outcome.kind !== 'agreed_data' && prefetchHandle) {
    try { prefetchHandle.abort(); } catch { /* never propagate */ }
  }

  return { outcome, results, byData, byNegative, queried, mUsed: m };
}

// Build the trust metadata object the renderer surfaces on the shield.
function buildTrust({ level, agreed, dissented, queried, k, m, block }) {
  return {
    level,
    block,
    agreed: agreed.slice(),
    dissented: dissented.slice(),
    queried: queried.slice(),
    quorum: { k, m, achieved: level === 'verified' },
  };
}

// Build the `groups` payload for conflict outcomes. Mixed bytes groups and
// a single synthetic not_found group are surfaced so the interstitial can
// show "these hosts said A, these said B, these said not-registered."
function buildConflictGroups({ byData, byNegative }) {
  const groups = [];
  for (const [bytes, urls] of byData) {
    groups.push({ resolvedData: bytes, urls: Array.from(urls).map(hostOf) });
  }
  for (const [reason, urls] of byNegative) {
    groups.push({ resolvedData: null, reason, urls: Array.from(urls).map(hostOf) });
  }
  return groups;
}

// Analyze a settled wave where no M-agreement emerged. Classifies the
// aggregate shape into `unverified` (exactly one semantic response),
// `conflict` (two or more disagreeing responses), or `all_errored` (no
// response at all — caller may escalate to a second wave).
function classifyNoAgreement({ results }) {
  let dataResponses = 0;
  let notFoundResponses = 0;
  let errorCount = 0;
  for (const r of results.values()) {
    if (r.status === 'data') dataResponses += 1;
    else if (r.status === 'not_found') notFoundResponses += 1;
    else errorCount += 1;
  }
  const total = dataResponses + notFoundResponses;

  if (total === 0) return { kind: 'all_errored', errorCount };

  // Exactly one semantic response across all legs → unverified.
  if (total === 1) {
    if (dataResponses === 1) {
      const [sole] = Array.from(results.values()).filter((r) => r.status === 'data');
      return { kind: 'unverified_data', leg: sole };
    }
    const [sole] = Array.from(results.values()).filter((r) => r.status === 'not_found');
    return { kind: 'unverified_not_found', leg: sole };
  }

  // 2+ responses but no M-group (across any data bucket or any single
  // negative-reason bucket) → they disagreed.
  return { kind: 'conflict' };
}

// Custom-RPC fast path: single leg against the user's own node, labelled
// trust='user-configured'. On any failure, return null so the caller falls
// back to the public quorum path (preserving existing graceful-degrade
// behavior). Pinned block is fetched from the same custom RPC — we don't
// want to send user-node requests to public RPCs behind their back.
async function tryCustomRpcFastPath(customRpc, name, callData, settings) {
  const anchor = settings.ensBlockAnchor || 'latest';
  const timeoutMs = Number(settings.ensQuorumTimeoutMs) || 5000;
  let block;
  try {
    block = await fetchSingleSourceAnchor(customRpc, anchor, timeoutMs);
  } catch (err) {
    log.warn(`[ens] custom RPC anchor fetch failed (${hostOf(customRpc)}): ${err.message}`);
    return null;
  }

  const leg = await runQuorumLeg(customRpc, name, callData, block.hash, timeoutMs);
  if (leg.status === 'error') {
    log.warn(`[ens] custom RPC leg failed (${hostOf(customRpc)}): ${leg.error?.message}`);
    return null;
  }

  const trust = buildTrust({
    level: 'user-configured',
    agreed: [hostOf(customRpc)],
    dissented: [],
    queried: [hostOf(customRpc)],
    k: 1,
    m: 1,
    block,
  });
  if (leg.status === 'data') {
    return {
      outcome: 'data',
      resolvedData: leg.resolvedData,
      resolverAddress: leg.resolverAddress,
      trust,
      block,
    };
  }
  return { outcome: 'not_found', reason: leg.reason || 'NO_RESOLVER', trust, block };
}

// Degraded resolution against a single RPC. Shared by the K<3 config
// paths and the runtime "anchor corroboration infeasible" fallback so
// both produce the same `unverified` shape. Throws only when the single
// provider itself errors.
async function resolveSingleSourceUnverified(url, name, callData, anchor, timeoutMs) {
  let block;
  try {
    block = await fetchSingleSourceAnchor(url, anchor, timeoutMs);
  } catch (err) {
    throw new Error(`Single-provider anchor fetch failed: ${err.message}`, { cause: err });
  }
  const legResult = await runQuorumLeg(url, name, callData, block.hash, timeoutMs);
  const trust = buildTrust({
    level: 'unverified',
    agreed: [hostOf(url)],
    dissented: [],
    queried: [hostOf(url)],
    k: 1,
    m: 1,
    block,
  });
  if (legResult.status === 'data') {
    return {
      outcome: 'data',
      resolvedData: legResult.resolvedData,
      resolverAddress: legResult.resolverAddress,
      trust,
      block,
    };
  }
  if (legResult.status === 'not_found') {
    return { outcome: 'not_found', reason: legResult.reason || 'NO_RESOLVER', trust, block };
  }
  throw legResult.error || new Error('Single-provider resolution failed');
}

// Returns one of:
//   { outcome: 'data',       resolvedData, resolverAddress, trust, block }
//   { outcome: 'not_found',  reason,                         trust, block }
//   { outcome: 'conflict',   groups,                         trust, block }
// Throws when there are no providers or both waves all-errored.
async function consensusResolve(normalizedName, callData, kind = 'content', options = {}) {
  const settings = loadSettings();

  // Custom RPC: try first, fall back to public quorum on any failure so
  // users with a misbehaving own-node still resolve.
  const customRpc =
    settings.enableEnsCustomRpc && (settings.ensRpcUrl || '').trim();
  if (customRpc) {
    const customResult = await tryCustomRpcFastPath(customRpc, normalizedName, callData, settings);
    if (customResult) return customResult;
  }

  const quorumDisabled = settings.enableEnsQuorum === false;
  const desiredK = Math.max(1, Math.min(Number(settings.ensQuorumK) || 3, 9));
  const desiredM = Math.max(1, Math.min(Number(settings.ensQuorumM) || 2, desiredK));
  const timeoutMs = Number(settings.ensQuorumTimeoutMs) || 5000;
  const anchor = settings.ensBlockAnchor || 'latest';

  const available = getAvailableProviders();
  if (available.length === 0) {
    throw new Error('No available RPC providers for ENS consensus resolution');
  }

  // Degraded single-source path. Taken when:
  //   - user disabled quorum explicitly, OR
  //   - fewer than 3 providers are non-quarantined (not enough to tolerate
  //     one outlier via median), OR
  //   - user configured sub-minimum K/M (K<3 or M<2). In that case the
  //     corroborated path can't honestly produce `verified` anyway, so we
  //     respect the user's intent and downgrade rather than hard-failing.
  // A single liar within the drift window can bias a K=2 anchor into the
  // past; we surface the outcome as `unverified` rather than minting a
  // "verified" badge we can't defend.
  const quorumUnderpowered =
    desiredK < MIN_QUORUM_PROVIDERS || desiredM < 2;
  if (quorumDisabled || available.length < MIN_QUORUM_PROVIDERS || quorumUnderpowered) {
    return resolveSingleSourceUnverified(available[0], normalizedName, callData, anchor, timeoutMs);
  }

  // Corroborated anchor required before the quorum wave — a malicious
  // provider lying about the head cannot unilaterally pin stale state.
  // Returns null when corroboration is infeasible at runtime (flakes
  // leaving fewer than MIN_QUORUM_PROVIDERS heads); we degrade to the
  // single-source unverified path rather than failing the whole request.
  const block = await getPinnedBlock();
  if (!block) {
    const freshAvailable = getAvailableProviders();
    const fallbackUrl = freshAvailable[0] || available[0];
    return resolveSingleSourceUnverified(fallbackUrl, normalizedName, callData, anchor, timeoutMs);
  }

  // Refresh the available pool — anchor corroboration may have quarantined
  // flaky providers, and reusing the pre-anchor snapshot would immediately
  // retry them in the wave. Worst case: one bad responder plus two
  // already-quarantined flakes in the first K would let classifyNoAgreement
  // return unverified_data from a single (possibly malicious) source while
  // the providers that carried anchor corroboration sit idle.
  const waveAvailable = getAvailableProviders();
  if (waveAvailable.length < MIN_QUORUM_PROVIDERS) {
    return resolveSingleSourceUnverified(
      waveAvailable[0] || available[0],
      normalizedName, callData, anchor, timeoutMs
    );
  }

  const effectiveK = Math.min(desiredK, waveAvailable.length);
  const effectiveM = Math.min(desiredM, effectiveK);

  const firstSelection = waveAvailable.slice(0, effectiveK);

  log.info(
    `[ens] consensus kind=${kind} name=${normalizedName} k=${effectiveK} m=${effectiveM} ` +
    `block=${block.hash}@${block.number} providers=[${firstSelection.map(hostOf).join(',')}]`
  );

  let wave = await runConsensusWave({
    providers: firstSelection,
    name: normalizedName,
    callData,
    blockHash: block.hash,
    timeoutMs,
    m: effectiveM,
    onFirstData: options.onFirstData,
  });

  // First-wave settled without agreement → escalate once to remaining
  // non-quarantined providers when they could plausibly do better.
  //   - all_errored: any fresh response is an upgrade from "no evidence."
  //   - unverified_data / unverified_not_found: replace ONLY if the second
  //     wave actually reaches quorum. If the second wave also fails to
  //     agree, the first wave's single data point is still our best
  //     evidence; trading it for second-wave noise would be a downgrade.
  if (wave.outcome.kind === 'all_settled') {
    const verdict = classifyNoAgreement(wave);
    const upgradable =
      verdict.kind === 'all_errored' ||
      verdict.kind === 'unverified_data' ||
      verdict.kind === 'unverified_not_found';
    if (upgradable) {
      const remaining = getAvailableProviders().filter((u) => !firstSelection.includes(u));
      // Unverified upgrades require enough fresh providers for the second
      // wave alone to clear the quorum threshold; otherwise the escalation
      // can only ever produce more unverified evidence.
      const minRemaining = verdict.kind === 'all_errored' ? 1 : effectiveM;
      if (remaining.length >= minRemaining) {
        const secondK = Math.min(desiredK, remaining.length);
        const secondSelection = remaining.slice(0, secondK);
        log.info(`[ens] consensus escalating to second wave providers=[${secondSelection.map(hostOf).join(',')}]`);
        const secondWave = await runConsensusWave({
          providers: secondSelection,
          name: normalizedName,
          callData,
          blockHash: block.hash,
          timeoutMs,
          m: Math.min(desiredM, secondK),
          onFirstData: options.onFirstData,
        });
        const secondAgreed =
          secondWave.outcome.kind === 'agreed_data' ||
          secondWave.outcome.kind === 'agreed_not_found';
        if (verdict.kind === 'all_errored' || secondAgreed) {
          wave = secondWave;
        }
      }
    }
  }

  // Wave-scoped trust builder — `m` comes from the wave that actually
  // produced the answer (second-wave fallbacks run with a lower m when
  // fewer providers remain; using the caller's effectiveM here would
  // report an impossible k=2, m=3, achieved=true on those paths).
  const trustFor = (level, agreed, dissented = []) => buildTrust({
    level, agreed, dissented,
    queried: wave.queried,
    k: wave.queried.length,
    m: wave.mUsed,
    block,
  });

  if (wave.outcome.kind === 'agreed_data') {
    const agreedUrls = wave.outcome.urls;
    const winningLeg = wave.results.get(agreedUrls[0]);
    return {
      outcome: 'data',
      resolvedData: winningLeg.resolvedData,
      resolverAddress: winningLeg.resolverAddress,
      trust: trustFor('verified', agreedUrls.map(hostOf)),
      block,
    };
  }

  if (wave.outcome.kind === 'agreed_not_found') {
    const agreedUrls = wave.outcome.urls;
    const firstAgreer = wave.results.get(agreedUrls[0]);
    return {
      outcome: 'not_found',
      reason: wave.outcome.reason,
      error: firstAgreer?.error?.message,
      trust: trustFor('verified', agreedUrls.map(hostOf)),
      block,
    };
  }

  const verdict = classifyNoAgreement(wave);

  if (verdict.kind === 'all_errored') {
    throw new Error(`All ${wave.queried.length} RPC providers failed for ${normalizedName}`);
  }

  if (verdict.kind === 'unverified_data') {
    const leg = verdict.leg;
    return {
      outcome: 'data',
      resolvedData: leg.resolvedData,
      resolverAddress: leg.resolverAddress,
      trust: trustFor('unverified', [hostOf(leg.url)]),
      block,
    };
  }

  if (verdict.kind === 'unverified_not_found') {
    const leg = verdict.leg;
    return {
      outcome: 'not_found',
      reason: leg.reason || 'NO_RESOLVER',
      error: leg.error?.message,
      trust: trustFor('unverified', [hostOf(leg.url)]),
      block,
    };
  }

  return {
    outcome: 'conflict',
    groups: buildConflictGroups(wave),
    trust: trustFor('conflict', [], wave.queried),
    block,
  };
}

async function resolveEnsContent(name) {
  return resolveWithCache(name, ensResultCache, doResolveEnsContent, 'content');
}

// Decodes the UR's ABI-encoded return, parses the multicodec content hash,
// and kicks off a gateway prefetch for bzz:// / ipfs:// (never ipns://).
//
// Caveat: prefetch fires on the FIRST responder's bytes, not the agreed
// bytes. If the first responder is a lying RPC and the eventual quorum
// outcome is `agreed_data` on different bytes (or `conflict`/unverified),
// the warmed gateway entry is for content the renderer will never load.
// That's bandwidth, not a trust hole — the gateway is content-addressed,
// so a wrong-bytes warm doesn't poison the verified path. The "200–500ms
// saving" assumes an honest first responder; under attack the optimization
// degrades to a no-op (and may waste a small amount of gateway traffic).
function prefetchOnFirstData(resolvedData) {
  try {
    const [inner] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], resolvedData);
    if (!inner || inner === '0x') return null;
    const parsed = parseContentHashBytes(inner);
    if (!parsed || !parsed.uri) return null;
    return prefetchGatewayUrl(parsed.uri);
  } catch {
    return null;
  }
}

async function doResolveEnsContent(normalized) {
  const node = ethers.namehash(normalized);
  const callData = CONTENTHASH_SELECTOR + node.slice(2);

  const consensus = await consensusResolve(normalized, callData, 'content', {
    onFirstData: prefetchOnFirstData,
  });
  const { trust } = consensus;

  if (consensus.outcome === 'conflict') {
    return cacheContentResult(normalized, {
      type: 'conflict',
      name: normalized,
      trust,
      groups: consensus.groups,
    });
  }

  if (consensus.outcome === 'not_found') {
    const out = {
      type: 'not_found',
      reason: consensus.reason || 'NO_RESOLVER',
      name: normalized,
      trust,
    };
    if (consensus.error) out.error = consensus.error;
    return cacheContentResult(normalized, out);
  }

  // outcome === 'data' — decode ABI-wrapped `bytes` return of contenthash().
  let innerBytes;
  try {
    [innerBytes] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], consensus.resolvedData);
  } catch (err) {
    log.warn(`[ens] Failed to decode contenthash bytes for ${normalized}: ${err.message}`);
    return cacheContentResult(normalized, {
      type: 'unsupported',
      reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
      name: normalized,
      contentHash: consensus.resolvedData,
      trust,
    });
  }

  if (!innerBytes || innerBytes === '0x') {
    return cacheContentResult(normalized, {
      type: 'not_found',
      reason: 'EMPTY_CONTENTHASH',
      name: normalized,
      trust,
    });
  }

  const parsed = parseContentHashBytes(innerBytes);
  if (!parsed) {
    log.warn(`[ens] UNSUPPORTED_CONTENTHASH_FORMAT for ${normalized}: ${innerBytes}`);
    return cacheContentResult(normalized, {
      type: 'unsupported',
      reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
      name: normalized,
      contentHash: innerBytes,
      trust,
    });
  }

  return cacheContentResult(normalized, { type: 'ok', name: normalized, ...parsed, trust });
}

// Decode raw ENS contenthash bytes into our result shape. Mirrors ethers'
// internal decoder bit-for-bit to preserve CIDv0 base58 output for IPFS
// — a content-hash library would normalize everything to CIDv1, breaking
// history/bookmark matching on names users already visited.
// Returns null for any format we don't support.
function parseContentHashBytes(hex0x) {
  const ipfs = hex0x.match(IPFS_CONTENTHASH_RE);
  if (ipfs) {
    const { codecPrefix, multihash, mhLen, digest } = ipfs.groups;
    if (digest.length === parseInt(mhLen, 16) * 2) {
      const scheme = codecPrefix === 'e3010170' ? 'ipfs' : 'ipns';
      const decoded = ethers.encodeBase58('0x' + multihash);
      return {
        codec: `${scheme}-ns`,
        protocol: scheme,
        uri: `${scheme}://${decoded}`,
        decoded,
      };
    }
  }
  const swarm = hex0x.match(SWARM_CONTENTHASH_RE);
  if (swarm) {
    const hash = swarm.groups.swarmHash;
    return {
      codec: 'swarm-ns',
      protocol: 'bzz',
      uri: `bzz://${hash}`,
      decoded: hash,
    };
  }
  return null;
}

function cacheContentResult(normalized, result) {
  return cacheAndLog(ensResultCache, normalized, result, result.uri);
}

// Resolve an ENS name's primary ETH address (the `addr` record).
// Single UR call (vs ethers' registry → addr 2-step flow); CCIP-Read
// handled transparently via OffchainLookup.
async function resolveEnsAddress(name) {
  return resolveWithCache(name, ensAddressCache, doResolveEnsAddress, 'addr');
}

// Concurrent resolves of the same `${label}:${normalized}` share one
// in-flight promise so address-bar + wallet lookups (or two rapid clicks)
// don't fire two full quorum waves. Per-label key prevents content and
// addr lookups for the same name from colliding — they query different
// selectors and need independent caches.
const inFlightResolves = new Map();

// Shared validation + cache wrapper for the content-hash and addr lookup
// paths. The consensusResolve primitive handles provider-error escalation
// internally via its second-wave logic, so no outer retry loop is needed
// for the new path. Legacy reverse-resolution uses its own retry below.
//
// Normalization goes through @adraffy/ens-normalize (UTS-46 / ENSIP-15),
// not a bare .toLowerCase(). That's correct for unicode ENS names
// (emoji labels, non-ASCII domains) whose namehash depends on canonical
// NFC form. `ens_normalize` is a no-op beyond lowercasing for pure-ASCII
// names like "Vitalik.ETH", so callers that pass 0x addresses (reverse
// lookup) are unaffected. Invalid labels throw — which propagates to
// the IPC handler and surfaces as a RESOLUTION_ERROR to the renderer.
async function resolveWithCache(name, cache, doResolve, label) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('ENS name is empty');
  }
  const normalized = ens_normalize(trimmed);

  const cached = cache.get(normalized);
  if (cached && Date.now() < cached.expiresAt) {
    log.info(`[ens] ${label} cache hit for ${normalized}`);
    return cached.result;
  }

  const dedupKey = `${label}:${normalized}`;
  const existing = inFlightResolves.get(dedupKey);
  if (existing) {
    log.info(`[ens] ${label} joining in-flight resolution for ${normalized}`);
    return existing;
  }

  // consensusResolve (content/addr paths) handles provider-error escalation
  // internally via its second-wave logic, so the outer retry loop only runs
  // for the legacy reverse-resolution path.
  const needsLegacyRetry = label === 'reverse';

  const promise = (async () => {
    if (!needsLegacyRetry) return doResolve(normalized);

    let lastError;
    for (let attempt = 1; attempt <= MAX_RESOLUTION_RETRIES; attempt++) {
      try {
        return await doResolve(normalized);
      } catch (err) {
        lastError = err;
        if (isProviderError(err) && attempt < MAX_RESOLUTION_RETRIES) {
          log.warn(
            `[ens] ${label} provider error on attempt ${attempt}/${MAX_RESOLUTION_RETRIES}: ${err.message}`
          );
          dropCachedProvider();
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  })().finally(() => {
    inFlightResolves.delete(dedupKey);
  });

  inFlightResolves.set(dedupKey, promise);
  return promise;
}

async function doResolveEnsAddress(normalized) {
  const node = ethers.namehash(normalized);
  const callData = ADDR_SELECTOR + node.slice(2);

  const consensus = await consensusResolve(normalized, callData, 'addr');
  const { trust } = consensus;

  if (consensus.outcome === 'conflict') {
    return cacheAddressResult(normalized, {
      success: false,
      name: normalized,
      reason: 'CONFLICT',
      trust,
      groups: consensus.groups,
    });
  }

  if (consensus.outcome === 'not_found') {
    // addr() has NO_RESOLVER as the only well-defined "no address" path.
    // A non-ResolverNotFound revert (NO_CONTENTHASH from the leg classifier)
    // means the resolver answered but not usefully — surface as a resolution
    // error rather than silently returning "no address", since sending to a
    // name mid-transient-failure shouldn't be confused with "no account".
    if (consensus.reason === 'NO_CONTENTHASH') {
      return cacheAddressResult(normalized, {
        success: false,
        name: normalized,
        reason: 'RESOLUTION_ERROR',
        error: consensus.error,
        trust,
      });
    }
    return cacheAddressResult(normalized, { ...noAddressResult(normalized), trust });
  }

  // outcome === 'data' — addr() returns a plain 32-byte ABI-encoded address
  // (static type, not bytes-wrapped).
  if (!consensus.resolvedData || consensus.resolvedData === '0x') {
    return cacheAddressResult(normalized, { ...noAddressResult(normalized), trust });
  }

  let address;
  try {
    [address] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], consensus.resolvedData);
  } catch (err) {
    log.warn(`[ens] Failed to decode addr bytes for ${normalized}: ${err.message}`);
    return cacheAddressResult(normalized, {
      success: false,
      name: normalized,
      reason: 'RESOLUTION_ERROR',
      error: err.message,
      trust,
    });
  }

  if (address === ethers.ZeroAddress) {
    return cacheAddressResult(normalized, { ...noAddressResult(normalized), trust });
  }

  return cacheAddressResult(normalized, {
    success: true,
    name: normalized,
    address,
    trust,
  });
}

function noAddressResult(normalized) {
  return {
    success: false,
    name: normalized,
    reason: 'NO_ADDRESS',
    error: `No address record set for ${normalized}`,
  };
}

function cacheAddressResult(normalized, result) {
  return cacheAndLog(ensAddressCache, normalized, result, result.address);
}

// Shared cache-set + log-and-return for both lookup paths. `okValue` is
// the success-case display (uri for content, address for addr); passing
// a truthy value logs "Resolved → <value>", otherwise logs the reason.
// TTL is derived from the result's trust.level — see TTL_BY_LEVEL.
function cacheAndLog(cache, normalized, result, okValue) {
  const ttl = ttlForResult(result);
  cache.set(normalized, { result, expiresAt: Date.now() + ttl });
  capCache(cache);
  if (okValue) {
    log.info(`[ens] Resolved: ${normalized} → ${okValue} (ttl=${ttl}ms)`);
  } else {
    log.info(`[ens] ${result.reason || result.type} for ${normalized} (ttl=${ttl}ms)`);
  }
  return result;
}

// Resolve an address to its ENS primary name. The UR verifies the reverse
// record forward-resolves back to the input address internally and reverts
// with ReverseAddressMismatch if not — so a successful return is already
// a trusted name. Spoofed/stale reverses surface as UNVERIFIED.
async function resolveEnsReverse(address) {
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return {
      success: false,
      address,
      reason: 'INVALID_ADDRESS',
      error: `Invalid address: ${address}`,
    };
  }
  return resolveWithCache(address, ensReverseCache, doResolveEnsReverse, 'reverse');
}

async function doResolveEnsReverse(normalizedAddress) {
  const provider = await getWorkingProvider();
  const ur = new ethers.Contract(UNIVERSAL_RESOLVER_ADDRESS, UR_ABI, provider);
  const addrBytes = ethers.getBytes(normalizedAddress);

  let claimedName;
  try {
    const [name] = await ur.reverse(addrBytes, ETH_COIN_TYPE, { enableCcipRead: true });
    claimedName = name;
  } catch (err) {
    if (isProviderError(err)) throw err;
    if (isResolverNotFoundError(err)) {
      return cacheReverseResult(normalizedAddress, noReverseResult(normalizedAddress));
    }
    if (isReverseAddressMismatchError(err)) {
      return cacheReverseResult(normalizedAddress, {
        success: false,
        address: normalizedAddress,
        reason: 'UNVERIFIED',
        error: `Reverse record for ${normalizedAddress} does not forward-verify`,
      });
    }
    log.info(`[ens] UR reverse failed for ${normalizedAddress}: ${err.message}`);
    return cacheReverseResult(normalizedAddress, {
      success: false,
      address: normalizedAddress,
      reason: 'RESOLUTION_ERROR',
      error: err.message,
    });
  }

  if (!claimedName) {
    return cacheReverseResult(normalizedAddress, noReverseResult(normalizedAddress));
  }

  return cacheReverseResult(normalizedAddress, {
    success: true,
    address: normalizedAddress,
    name: claimedName,
  });
}

function noReverseResult(normalizedAddress) {
  return {
    success: false,
    address: normalizedAddress,
    reason: 'NO_REVERSE',
    error: `No primary ENS name set for ${normalizedAddress}`,
  };
}

function cacheReverseResult(normalizedAddress, result) {
  return cacheAndLog(ensReverseCache, normalizedAddress, result, result.name);
}

// Test an RPC URL by connecting and fetching the block number.
// Note: this intentionally accepts any reachable http(s) URL — testing a
// local node (anvil/geth on 127.0.0.1, an internal RPC, etc.) is the
// primary use case, so we do not block private-IP or loopback ranges.
// Access is gated upstream by the freedomAPI guard (internal pages only).
async function testRpcUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) {
    return failure('INVALID_URL', 'RPC URL is empty');
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return failure('INVALID_URL', 'Invalid URL format');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return failure('INVALID_URL', 'URL must use http:// or https://');
  }

  let provider;
  try {
    provider = new ethers.JsonRpcProvider(trimmed);
    const blockNumber = await provider.getBlockNumber();
    log.info(`[ens] RPC test succeeded for ${trimmed}: block ${blockNumber}`);
    return success({ blockNumber });
  } catch (err) {
    log.warn(`[ens] RPC test failed for ${trimmed}: ${err.message}`);
    return failure('CONNECTION_FAILED', err.message);
  } finally {
    if (provider) {
      provider.destroy();
    }
  }
}

function registerEnsIpc() {
  ipcMain.handle(IPC.ENS_RESOLVE, async (_event, payload = {}) => {
    const { name } = payload;

    try {
      const result = await resolveEnsContent(name);
      return result;
    } catch (err) {
      log.error('[ens] resolution error', err);
      return {
        type: 'error',
        name: (name || '').trim().toLowerCase(),
        reason: 'RESOLUTION_ERROR',
        error: err.message,
      };
    }
  });

  ipcMain.handle(IPC.ENS_TEST_RPC, async (_event, payload = {}) => {
    return testRpcUrl(payload.url);
  });

  ipcMain.handle(IPC.ENS_RESOLVE_ADDRESS, async (_event, payload = {}) => {
    const { name } = payload;
    try {
      return await resolveEnsAddress(name);
    } catch (err) {
      log.error('[ens] address resolution error', err);
      return {
        success: false,
        name: (name || '').trim().toLowerCase(),
        reason: 'RESOLUTION_ERROR',
        error: err.message,
      };
    }
  });

  ipcMain.handle(IPC.ENS_RESOLVE_REVERSE, async (_event, payload = {}) => {
    const { address } = payload;
    try {
      return await resolveEnsReverse(address);
    } catch (err) {
      log.error('[ens] reverse resolution error', err);
      return {
        success: false,
        address: typeof address === 'string' ? address.toLowerCase() : null,
        reason: 'RESOLUTION_ERROR',
        error: err.message,
      };
    }
  });
}

// Test-only: drop all cached resolution results so tests can share ENS
// names across cases without cross-pollution. Safe to call from production
// (equivalent to waiting out the TTLs), but not exposed over IPC.
function clearEnsCachesForTest() {
  ensResultCache.clear();
  ensAddressCache.clear();
  ensReverseCache.clear();
  inFlightResolves.clear();
}

module.exports = {
  registerEnsIpc,
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  testRpcUrl,
  invalidateCachedProvider,
  universalResolverCall,
  isResolverNotFoundError,
  clearEnsCachesForTest,
};
