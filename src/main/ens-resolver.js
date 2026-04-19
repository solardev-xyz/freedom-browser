const log = require('./logger');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const { ens_normalize } = require('@adraffy/ens-normalize');
const IPC = require('../shared/ipc-channels');
const { success, failure } = require('./ipc-contract');
const { loadSettings, DEFAULT_ENS_PUBLIC_RPC_PROVIDERS } = require('./settings-store');

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

// Public RPC providers as fallbacks
const PUBLIC_RPC_PROVIDERS = [
  process.env.ETH_RPC,
  'https://ethereum.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth.merkle.io',
].filter(Boolean);

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

// Build the effective provider list: custom RPC first (if set), then public fallbacks
function getRpcProviders() {
  const custom = getCustomRpcUrl();
  if (custom) {
    return [custom, ...PUBLIC_RPC_PROVIDERS];
  }
  return PUBLIC_RPC_PROVIDERS;
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

async function fetchAnchorFromProvider(url, anchor, timeoutMs) {
  const provider = new ethers.JsonRpcProvider(url);
  const cleanup = () => {
    try { provider.destroy(); } catch { /* already torn down */ }
  };
  try {
    const fetchBlock = async () => {
      if (anchor === 'latest-32') {
        // ~3min behind head on mainnet — safe against typical reorgs but
        // fresher than finalized. Two RTTs because getBlock(n-32) depends
        // on the latest block number first.
        const latest = await provider.getBlockNumber();
        const block = await provider.getBlock(latest - 32);
        if (!block) throw new Error(`block ${latest - 32} not available`);
        return { number: block.number, hash: block.hash };
      }
      const block = await provider.getBlock(anchor);
      if (!block) throw new Error(`block tag ${anchor} returned null`);
      return { number: block.number, hash: block.hash };
    };
    return await withTimeout(fetchBlock(), timeoutMs, cleanup);
  } finally {
    cleanup();
  }
}

// Race the first two available providers; pick the LOWER block number so
// everyone querying at that (older) hash sees identical state even if one
// provider is ahead. On all-failed, fall back sequentially to remaining
// providers and quarantine each failure.
async function getPinnedBlock() {
  const settings = loadSettings();
  const anchor = settings.ensBlockAnchor || 'latest';
  const ttl = typeof settings.ensBlockAnchorTtlMs === 'number'
    ? settings.ensBlockAnchorTtlMs
    : 30_000;
  const timeoutMs = Number(settings.ensQuorumTimeoutMs) || 5000;

  if (pinnedBlockCache
      && pinnedBlockCache.anchor === anchor
      && Date.now() < pinnedBlockCache.expiresAt) {
    return { number: pinnedBlockCache.number, hash: pinnedBlockCache.hash };
  }

  const available = getAvailableProviders();
  if (available.length === 0) {
    throw new Error('No available RPC providers for block anchor');
  }

  // First wave: race the top two (if available).
  const firstWave = available.slice(0, 2);
  const firstResults = await Promise.allSettled(
    firstWave.map((url) =>
      fetchAnchorFromProvider(url, anchor, timeoutMs).then(
        (block) => ({ url, block }),
        (err) => { markProviderFailure(url); throw err; }
      )
    )
  );

  const firstWins = firstResults
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);

  for (const { url } of firstWins) markProviderSuccess(url);

  if (firstWins.length > 0) {
    // Take the lower block number — conservative anchor, shared by all.
    const chosen = firstWins.reduce((a, b) =>
      a.block.number <= b.block.number ? a : b
    ).block;
    pinnedBlockCache = { anchor, ...chosen, expiresAt: Date.now() + ttl };
    return chosen;
  }

  // Both failed — try the rest sequentially.
  let lastError = null;
  for (const url of available.slice(2)) {
    try {
      const block = await fetchAnchorFromProvider(url, anchor, timeoutMs);
      markProviderSuccess(url);
      pinnedBlockCache = { anchor, ...block, expiresAt: Date.now() + ttl };
      return block;
    } catch (err) {
      lastError = err;
      markProviderFailure(url);
      log.warn(`[ens] anchor fetch failed via ${url}: ${err.message}`);
    }
  }

  throw new Error(
    `Could not pin block anchor (${anchor}): ${lastError?.message || 'all providers failed'}`
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

// Invalidate cached provider (legacy path) AND the shuffled/quarantine pool
// used by consensusResolve. Tests call this between cases; production callers
// invoke it after settings edits so a re-tested RPC gets a fresh chance.
function invalidateCachedProvider() {
  if (cachedProvider) {
    log.info(`[ens] Invalidating cached provider: ${cachedProviderUrl}`);
    cachedProvider.destroy();
    cachedProvider = null;
    cachedProviderUrl = null;
  }
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
// produce byte-identical `data` OR M legs produce `not_found`. Stragglers
// still in flight are left to settle on their own (their connections are
// already torn down on timeout; otherwise they just complete and discard).
async function runConsensusWave({ providers, name, callData, blockHash, timeoutMs, m }) {
  const results = new Map(); // url → leg result
  const byData = new Map();  // resolvedData bytes → Set<url>
  const byNotFound = new Set();
  const queried = providers.map(hostOf);

  // Shared token so we can tear down straggler providers when M-agreement
  // fires before all legs settle — keeps sockets + parsing work from
  // running uselessly in the background.
  const cancelToken = { cleanups: new Set() };

  let earlyResolve;
  const earlyPromise = new Promise((res) => { earlyResolve = res; });

  const checkEarly = () => {
    for (const [bytes, urls] of byData) {
      if (urls.size >= m) {
        earlyResolve({ kind: 'agreed_data', bytes, urls: Array.from(urls) });
        return true;
      }
    }
    if (byNotFound.size >= m) {
      earlyResolve({ kind: 'agreed_not_found', urls: Array.from(byNotFound) });
      return true;
    }
    return false;
  };

  const legPromises = providers.map((url) =>
    runQuorumLeg(url, name, callData, blockHash, timeoutMs, cancelToken).then((r) => {
      results.set(url, r);
      if (r.status === 'data') {
        const bucket = byData.get(r.resolvedData) || new Set();
        bucket.add(url);
        byData.set(r.resolvedData, bucket);
      } else if (r.status === 'not_found') {
        byNotFound.add(url);
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

  return { outcome, results, byData, byNotFound, queried };
}

// Pick the most common value in an array (first wins on tie).
function pluralityOf(values) {
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) { best = v; bestCount = c; }
  }
  return best;
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
function buildConflictGroups({ byData, byNotFound }) {
  const groups = [];
  for (const [bytes, urls] of byData) {
    groups.push({ resolvedData: bytes, urls: Array.from(urls).map(hostOf) });
  }
  if (byNotFound.size > 0) {
    groups.push({ resolvedData: null, reason: 'NO_RESOLVER', urls: Array.from(byNotFound).map(hostOf) });
  }
  return groups;
}

// Analyze a settled wave where no M-agreement emerged. Classifies the
// aggregate shape into `unverified` (exactly one semantic response),
// `conflict` (two or more disagreeing responses), or `all_errored` (no
// response at all — caller may escalate to a second wave).
function classifyNoAgreement({ results, byData, byNotFound }) {
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

  // 2+ responses but no M-group → they disagreed.
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
    block = await fetchAnchorFromProvider(customRpc, anchor, timeoutMs);
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

// Returns one of:
//   { outcome: 'data',       resolvedData, resolverAddress, trust, block }
//   { outcome: 'not_found',  reason,                         trust, block }
//   { outcome: 'conflict',   groups,                         trust, block }
// Throws when there are no providers or both waves all-errored.
async function consensusResolve(normalizedName, callData, kind = 'content') {
  const settings = loadSettings();

  // Custom RPC: try first, fall back to public quorum on any failure so
  // users with a misbehaving own-node still resolve.
  const customRpc =
    settings.enableEnsCustomRpc && (settings.ensRpcUrl || '').trim();
  if (customRpc) {
    const customResult = await tryCustomRpcFastPath(customRpc, normalizedName, callData, settings);
    if (customResult) return customResult;
  }

  // Settings override: if user disabled quorum explicitly, take one
  // non-quarantined provider and return as unverified. No corroboration.
  const quorumDisabled = settings.enableEnsQuorum === false;

  // Pin a shared block for all legs so honest-but-unsynced providers don't
  // produce false conflicts.
  const block = await getPinnedBlock();

  const desiredK = Math.max(2, Math.min(Number(settings.ensQuorumK) || 3, 9));
  const desiredM = Math.max(2, Math.min(Number(settings.ensQuorumM) || 2, desiredK));
  const timeoutMs = Number(settings.ensQuorumTimeoutMs) || 5000;

  const available = getAvailableProviders();
  if (available.length === 0) {
    throw new Error('No available RPC providers for ENS consensus resolution');
  }

  // Degraded single-provider path (only one non-quarantined provider, or
  // quorum disabled by user). Outcome is always `unverified` because there
  // is no second source to corroborate against.
  if (quorumDisabled || available.length === 1) {
    const url = available[0];
    const legResult = await runQuorumLeg(url, normalizedName, callData, block.hash, timeoutMs);
    const trust = buildTrust({
      level: 'unverified',
      agreed: [hostOf(url)],
      dissented: [],
      queried: [hostOf(url)],
      k: 1,
      m: desiredM,
      block,
    });
    if (legResult.status === 'data') {
      return { outcome: 'data', resolvedData: legResult.resolvedData, resolverAddress: legResult.resolverAddress, trust, block };
    }
    if (legResult.status === 'not_found') {
      return { outcome: 'not_found', reason: legResult.reason || 'NO_RESOLVER', trust, block };
    }
    throw legResult.error || new Error('Single-provider resolution failed');
  }

  const effectiveK = Math.min(desiredK, available.length);
  const effectiveM = Math.min(desiredM, effectiveK);

  const firstSelection = available.slice(0, effectiveK);

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
  });

  // All-errored first wave → escalate once to remaining non-quarantined providers.
  if (wave.outcome.kind === 'all_settled') {
    const verdict = classifyNoAgreement(wave);
    if (verdict.kind === 'all_errored') {
      const remaining = getAvailableProviders().filter((u) => !firstSelection.includes(u));
      if (remaining.length > 0) {
        const secondK = Math.min(desiredK, remaining.length);
        const secondSelection = remaining.slice(0, secondK);
        log.info(`[ens] consensus escalating to second wave providers=[${secondSelection.map(hostOf).join(',')}]`);
        wave = await runConsensusWave({
          providers: secondSelection,
          name: normalizedName,
          callData,
          blockHash: block.hash,
          timeoutMs,
          m: Math.min(desiredM, secondK),
        });
      }
    }
  }

  // Wave-scoped trust builder — the four shared parts (queried, k, m, block)
  // would otherwise repeat across every terminal branch.
  const trustFor = (level, agreed, dissented = []) => buildTrust({
    level, agreed, dissented,
    queried: wave.queried,
    k: wave.queried.length,
    m: effectiveM,
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
    const reasons = agreedUrls.map((u) => wave.results.get(u)?.reason || 'NO_RESOLVER');
    const firstAgreer = wave.results.get(agreedUrls[0]);
    return {
      outcome: 'not_found',
      reason: pluralityOf(reasons),
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

async function doResolveEnsContent(normalized) {
  const node = ethers.namehash(normalized);
  const callData = CONTENTHASH_SELECTOR + node.slice(2);

  const consensus = await consensusResolve(normalized, callData, 'content');
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
          invalidateCachedProvider();
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
