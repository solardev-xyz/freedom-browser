const log = require('./logger');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const { ens_normalize } = require('@adraffy/ens-normalize');
const IPC = require('../shared/ipc-channels');
const { cidV1BytesToBase32 } = require('../shared/cid-utils');
const registry = require('./networks/network-registry');
const { prefetchGatewayUrl, NOOP_HANDLE: NOOP_PREFETCH } = require('./ens-prefetch');
const myotisManager = require('./myotis/myotis-manager');
const { capCache } = require('./cache-utils');
const {
  runWithPrivateLogContext,
  redactForLog,
} = require('./private/private-log-context');
const { isPrivateWebContents } = require('./private/private-windows');

// PRIVATE MODE GUARD (name logging): the name being resolved IS the
// browsing history of the tab that asked for it, and log.info/warn land in
// the persistent <userData>/logs/main.log, which outlives the private
// window and the app. Every log line below that carries a name, an address
// or a resolved target goes through these. The context is set by the IPC
// handlers (from event.sender) and by the dweb protocol handlers (from
// their session) — see src/main/private/private-log-context.js.
const nameForLog = (name) => redactForLog(name);

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

// Contract-backed Ethereum name systems on mainnet. WNS and GNS store
// resolver data directly on NameNFT-style ERC-721 contracts, using ENS-style
// namehash token IDs and ENS-compatible resolver function signatures.
const WNS_ADDRESS = '0x0000000000696760E15f265e828DB644A0c242EB';
const GNS_ADDRESS = '0x9D51D507BC7264d4fE8Ad1cf7Fe191933A0a81d6';
const NAME_NFT_ABI = [
  'function contenthash(bytes32 node) view returns (bytes)',
  'function addr(bytes32 node) view returns (address)',
  'function reverseResolve(address addr) view returns (string)',
];
const NAME_NFT_INTERFACE = new ethers.Interface(NAME_NFT_ABI);

const NAME_SYSTEMS = {
  ens: { id: 'ens', label: 'ENS' },
  wns: {
    id: 'wns',
    label: 'WNS',
    suffix: '.wei',
    contractAddress: WNS_ADDRESS,
  },
  gns: {
    id: 'gns',
    label: 'GNS',
    suffix: '.gwei',
    contractAddress: GNS_ADDRESS,
  },
};

function nameSystemForName(name) {
  const lower = String(name || '').toLowerCase();
  for (const system of [NAME_SYSTEMS.wns, NAME_SYSTEMS.gns]) {
    if (lower.endsWith(system.suffix)) return system;
  }
  return NAME_SYSTEMS.ens;
}

// bytes4(keccak256("contenthash(bytes32)"))
const CONTENTHASH_SELECTOR = '0xbc1c58d1';
// bytes4(keccak256("addr(bytes32)"))
const ADDR_SELECTOR = '0x3b3b57de';

// Myotis's native ENS API returns ERC-3668 OffchainLookup envelopes to the
// host. Freedom drives one bounded gateway round and re-enters the engine so
// the callback executes against the same beacon-anchored state root.
const MYOTIS_CCIP_MAX_ROUNDS = 1;
const MYOTIS_CCIP_TIMEOUT_MS = 15000;
const MYOTIS_CCIP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CCIP_HTTP_ERROR_SELECTOR = 'ca7a4e75';

// SLIP-0044 coin type for Ethereum mainnet, used by UR.reverse.
const ETH_COIN_TYPE = 60n;

// ENS contenthash byte patterns (EIP-1577). We preserve the CIDv0 base58
// output ("QmFoo…") for IPFS dag-pb to stay byte-compatible with the
// previous ethers-based implementation — users' bookmarks and history
// entries keyed on the old URI form keep matching. Non-dag-pb CIDv1 IPFS
// records are returned as CIDv1 base32, which is Chromium-safe.
//   0xe3 01 70             — ipfs-ns, cidv1, dag-pb
//   0xe3 01 55             — ipfs-ns, cidv1, raw
//   0xe5 01 72             — ipns-ns, cidv1, libp2p-key
//   0xe4 01 01 fa 01 1b 20 — swarm-ns + manifest codec, 32-byte keccak
const IPFS_DAG_PB_CONTENTHASH_RE =
  /^0xe3010170(?<multihash>(?<mhCode>[0-9a-f]{2})(?<mhLen>[0-9a-f]{2})(?<digest>[0-9a-f]*))$/;
const IPFS_CIDV1_CONTENTHASH_RE = /^0xe301(?<cid>01[0-9a-f]+)$/;
const IPNS_CONTENTHASH_RE =
  /^0xe5010172(?<multihash>(?<mhCode>[0-9a-f]{2})(?<mhLen>[0-9a-f]{2})(?<digest>[0-9a-f]*))$/;
const SWARM_CONTENTHASH_RE = /^0xe40101fa011b20(?<swarmHash>[0-9a-f]{64})$/;

// ---------------------------------------------------------------------------
// Session-shuffled public-RPC pool with per-provider quarantine. Backs the
// quorum strategy for forward and reverse resolution.
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

// Effective mainnet `rpc`-role endpoint pool from the network registry,
// with the ETH_RPC env override prepended for dev convenience. The registry
// resolves coverage, key substitution and removals; a user-added endpoint
// sorts ahead of the builtin pool.
function getEffectiveRpcEndpoints() {
  const saved = registry.getEndpoints(1, 'rpc');

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
  const effective = getEffectiveRpcEndpoints();
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
// one or two providers, cached for the network's quorum.anchorTtlMs (default 30s).
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

// Every JSON-RPC endpoint used in this module serves Ethereum Mainnet. Tell
// ethers that up front so its short-lived providers do not start an
// independent eth_chainId detection loop. A failed or cancelled quorum leg
// otherwise leaves ethers printing its generic "failed to detect network"
// retry message until teardown catches up.
const ETHEREUM_MAINNET_CHAIN_ID = 1;
const EPHEMERAL_PROVIDER_OPTIONS = { staticNetwork: true };

function createEthereumProvider(url) {
  return new ethers.JsonRpcProvider(
    url,
    ETHEREUM_MAINNET_CHAIN_ID,
    EPHEMERAL_PROVIDER_OPTIONS,
  );
}

// Create a short-lived provider for a single scoped operation, wrap the
// caller's work in withTimeout, and guarantee the provider is destroyed
// on both success and timeout. `fn` receives the bound provider.
async function withEphemeralProvider(url, timeoutMs, fn) {
  const provider = createEthereumProvider(url);
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
  const { quorum } = registry.getNetwork(1);
  const anchor = quorum.anchor || 'latest';
  const ttl = typeof quorum.anchorTtlMs === 'number'
    ? quorum.anchorTtlMs
    : 30_000;
  const timeoutMs = Number(quorum.timeoutMs) || 5000;
  const desiredK = Math.max(2, Math.min(Number(quorum.k) || 3, 9));
  const desiredM = Math.max(2, Math.min(Number(quorum.m) || 2, desiredK));

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

// Outcome-specific TTLs. Indexed by trust.level; the default fallback
// applies to results that don't carry a trust field. Verified/user-configured
// outcomes are stable enough for 15min; unverified answers expire in 60s so
// transient public-RPC noise doesn't pin the user-facing result for long;
// conflict outcomes are negative-cached for 10s purely to avoid re-entry storms on repeated
// navigation attempts during an active lie.
const TTL_BY_LEVEL = {
  verified: 15 * 60 * 1000,
  'user-configured': 15 * 60 * 1000,
  unverified: 60 * 1000,
  conflict: 10 * 1000,
};
const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;

function ttlForResult(result) {
  // UNVERIFIED outcomes describe a transient on-chain state (e.g. a
  // reverse record that doesn't forward-verify) even when the underlying
  // proof was cryptographically sound. Trust.level reads `verified` in
  // that case — short-cache anyway so the user sees a fresh outcome
  // when the on-chain state changes. Without this override the level
  // table would pin the result for 15min.
  if (result?.reason === 'UNVERIFIED') return TTL_BY_LEVEL.unverified;

  const level = result?.trust?.level;
  if (level && Object.prototype.hasOwnProperty.call(TTL_BY_LEVEL, level)) {
    return TTL_BY_LEVEL[level];
  }
  return DEFAULT_CACHE_TTL_MS;
}

const ensResultCache = new Map();

// Independent from ensResultCache so content and addr lookups don't evict each other.
const ensAddressCache = new Map();

// Address (lowercased 0x) → { result, expiresAt } for reverse lookups.
const ensReverseCache = new Map();
let resolutionLifecycleEpoch = 0;

// Any Ethereum Myotis lifecycle boundary invalidates both cached and in-flight
// policy decisions. Ready transitions let the preferred local tier overtake a
// fallback answer; unavailable/stopping transitions prevent stale local reads
// from being cached after shutdown.
myotisManager.onAvailabilityTransition((event) => {
  if (event?.chainId != null && Number(event.chainId) !== 1) return;
  const swept = ensResultCache.size + ensAddressCache.size + ensReverseCache.size;
  resolutionLifecycleEpoch += 1;
  ensResultCache.clear();
  ensAddressCache.clear();
  ensReverseCache.clear();
  inFlightResolves.clear();
  log.info(
    `[ens] myotis ${event?.ready ? 'ready' : 'unavailable'} reason=${event?.reason || 'unknown'} ` +
    `epoch=${event?.epoch ?? 'unknown'} swept=${swept} cached resolution result(s)`
  );
});

// Full reset: wipe the quorum pool (shuffled order, quarantine, pinned block),
// AND flush the per-name resolution caches. External callers use this after
// a settings edit:
// the resolution caches store each name's trust level, which is derived
// from the verification method — so a method change must drop them or
// stale results keep their old trust until their TTL expires.
function invalidateCachedProvider() {
  invalidateProviderPool();
  clearEnsResolutionCaches();
  registry.invalidate();
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

// ethers v6 stashes contract-revert data at either `.data` (newer wrappers)
// or `.info.error.data` (the JSON-RPC error envelope). One reader, used by
// every callsite that wants to inspect the revert payload.
function getRevertData(err) {
  const data = err?.data || err?.info?.error?.data || '';
  return typeof data === 'string' && data.length >= 10 ? data : null;
}

// Keep provider diagnostics useful without dumping full transaction calldata,
// endpoint URLs, or arbitrarily large upstream messages into the application
// log. ethers' `shortMessage` is preferred because its full CALL_EXCEPTION
// message includes the complete Universal Resolver request.
function sanitizeErrorDetail(value, maxLength = 240) {
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

function formatResolutionErrorForLog(err) {
  const nested = err?.info?.error;
  const message = sanitizeErrorDetail(
    err?.shortMessage || err?.reason || err?.message || String(err)
  );
  const fields = [`error=${JSON.stringify(message || 'unknown error')}`];
  if (err?.code != null) fields.push(`code=${sanitizeErrorDetail(err.code, 40)}`);
  if (nested?.code != null) fields.push(`rpcCode=${sanitizeErrorDetail(nested.code, 40)}`);
  if (nested?.message) {
    fields.push(`rpcMessage=${JSON.stringify(sanitizeErrorDetail(nested.message))}`);
  }
  const revertData = getRevertData(err);
  fields.push(`revert=${revertData ? revertData.slice(0, 10) : 'none'}`);
  return fields.join(' ');
}

function urErrorSelector(err) {
  const data = getRevertData(err);
  return data ? data.slice(0, 10).toLowerCase() : null;
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

// Decode the claimed primary name out of a ReverseAddressMismatch revert.
// The UR's custom error is `ReverseAddressMismatch(string,bytes)`, so the
// first ABI arg after the 4-byte selector is the claimed name string.
// Returns null if the data is missing or malformed — the warning UI then
// falls back to a name-less "unverified reverse" message.
function decodeReverseMismatchClaimedName(err) {
  const data = getRevertData(err);
  if (!data || data.slice(0, 10).toLowerCase() !== REVERSE_MISMATCH_SELECTOR) return null;
  try {
    const [name] = ethers.AbiCoder.defaultAbiCoder().decode(
      ['string', 'bytes'],
      '0x' + data.slice(10),
    );
    return name || null;
  } catch {
    return null;
  }
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

function nodeFromResolverCallData(callData) {
  const hex = typeof callData === 'string' ? callData : '';
  if (!/^0x[0-9a-fA-F]{72,}$/.test(hex)) {
    throw new Error('Invalid resolver call data');
  }
  return '0x' + hex.slice(10, 74);
}

// NameNFT-backed systems store ENS-compatible resolver records directly on
// their registry contracts. This adapter returns the same raw `resolvedData`
// shape as the Universal Resolver path so the quorum analyzer and record
// decoders can be shared unchanged.
async function nameNftResolverCall(provider, name, callData, overrides = {}) {
  const nameSystem = nameSystemForName(name);
  if (!nameSystem.contractAddress) {
    throw new Error(`No NameNFT contract configured for ${nameSystem.label}`);
  }
  const selector = String(callData || '').slice(0, 10).toLowerCase();
  const node = nodeFromResolverCallData(callData);
  const registryContract = new ethers.Contract(
    nameSystem.contractAddress,
    NAME_NFT_ABI,
    provider
  );

  if (selector === CONTENTHASH_SELECTOR) {
    const contenthash = await registryContract.contenthash(node, overrides);
    return {
      resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes'],
        [contenthash || '0x'],
      ),
      resolverAddress: nameSystem.contractAddress,
    };
  }

  if (selector === ADDR_SELECTOR) {
    const address = await registryContract.addr(node, overrides);
    return {
      resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [address || ethers.ZeroAddress],
      ),
      resolverAddress: nameSystem.contractAddress,
    };
  }

  throw new Error(`Unsupported ${nameSystem.label} resolver selector: ${selector}`);
}

// Reverse counterpart: call the UR's reverse(bytes, uint256). The UR
// verifies the claimed primary name forward-resolves back to the input
// address inside the contract — a successful return is already
// trust-checked at the contract level. A spoofed reverse record surfaces
// as `ReverseAddressMismatch` (selector 0xef9c03ce) on the err.data.
// `addressBytes` is the 20-byte representation produced by `ethers.getBytes`.
async function universalResolverReverse(provider, addressBytes, overrides = {}) {
  const ur = new ethers.Contract(UNIVERSAL_RESOLVER_ADDRESS, UR_ABI, provider);
  const [name] = await ur.reverse(addressBytes, ETH_COIN_TYPE, {
    enableCcipRead: true,
    ...overrides,
  });
  return { name };
}

// Reverse calls need to participate in the same byte-agreement machinery as
// forward records. Encode every semantic UR outcome as deterministic bytes so
// quorum can compare successful names, empty records, mismatches, and verified
// contract errors without collapsing them into the forward resolver's generic
// NO_CONTENTHASH bucket.
const REVERSE_OUTCOME = Object.freeze({
  noRecord: 0,
  name: 1,
  mismatch: 2,
  error: 3,
});

function encodeReverseOutcome(status, detail = '') {
  return ethers.AbiCoder.defaultAbiCoder().encode(['uint8', 'string'], [status, detail]);
}

function decodeReverseOutcome(resolvedData) {
  const [status, detail] = ethers.AbiCoder.defaultAbiCoder().decode(
    ['uint8', 'string'],
    resolvedData
  );
  return { status: Number(status), detail: String(detail || '') };
}

async function universalResolverReverseCall(provider, normalizedAddress, _callData, overrides = {}) {
  try {
    const { name } = await universalResolverReverse(
      provider,
      ethers.getBytes(normalizedAddress),
      overrides
    );
    return {
      resolvedData: encodeReverseOutcome(
        name ? REVERSE_OUTCOME.name : REVERSE_OUTCOME.noRecord,
        name || ''
      ),
      resolverAddress: UNIVERSAL_RESOLVER_ADDRESS,
    };
  } catch (err) {
    if (isProviderError(err)) throw err;
    if (isResolverNotFoundError(err)) {
      return {
        resolvedData: encodeReverseOutcome(REVERSE_OUTCOME.noRecord),
        resolverAddress: UNIVERSAL_RESOLVER_ADDRESS,
      };
    }
    if (isReverseAddressMismatchError(err)) {
      return {
        resolvedData: encodeReverseOutcome(
          REVERSE_OUTCOME.mismatch,
          decodeReverseMismatchClaimedName(err) || ''
        ),
        resolverAddress: UNIVERSAL_RESOLVER_ADDRESS,
      };
    }
    return {
      resolvedData: encodeReverseOutcome(REVERSE_OUTCOME.error, err.message),
      resolverAddress: UNIVERSAL_RESOLVER_ADDRESS,
    };
  }
}

// NameNFT reverseResolve(address) adapter. `name` is a synthetic value with
// the target system's suffix, allowing the existing NameNFT routing helper to
// select the correct contract while quorum compares ABI-identical strings.
async function nameNftReverseResolverCall(provider, name, callData, overrides = {}) {
  const nameSystem = nameSystemForName(name);
  if (!nameSystem.contractAddress) {
    throw new Error(`No NameNFT contract configured for ${nameSystem.label}`);
  }
  const [address] = NAME_NFT_INTERFACE.decodeFunctionData('reverseResolve', callData);
  const registryContract = new ethers.Contract(
    nameSystem.contractAddress,
    NAME_NFT_ABI,
    provider
  );
  const claimedName = await registryContract.reverseResolve(address, overrides);
  return {
    resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(['string'], [claimedName || '']),
    resolverAddress: nameSystem.contractAddress,
  };
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
async function runQuorumLeg(
  url,
  name,
  callData,
  blockHash,
  timeoutMs,
  cancelToken,
  callResolver = universalResolverCall,
) {
  let provider;
  const cleanup = () => {
    if (provider) {
      try { provider.destroy(); } catch { /* already torn down */ }
      provider = null;
    }
  };
  if (cancelToken) cancelToken.cleanups.add(cleanup);
  try {
    provider = createEthereumProvider(url);
    const urCall = callResolver(provider, name, callData, { blockTag: blockHash });
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
  callResolver = universalResolverCall,
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
    runQuorumLeg(
      url,
      name,
      callData,
      blockHash,
      timeoutMs,
      cancelToken,
      callResolver,
    ).then((r) => {
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
function buildTrust({ level, system = 'ens', agreed, dissented, queried, k, m, block }) {
  return {
    level,
    system,
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

async function readMyotisCcipBody(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MYOTIS_CCIP_MAX_RESPONSE_BYTES) {
    throw new Error(`response exceeds ${MYOTIS_CCIP_MAX_RESPONSE_BYTES} bytes`);
  }

  if (!response.body?.getReader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > MYOTIS_CCIP_MAX_RESPONSE_BYTES) {
      throw new Error(`response exceeds ${MYOTIS_CCIP_MAX_RESPONSE_BYTES} bytes`);
    }
    return body;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MYOTIS_CCIP_MAX_RESPONSE_BYTES) {
      try { await reader.cancel(); } catch { /* best-effort response teardown */ }
      throw new Error(`response exceeds ${MYOTIS_CCIP_MAX_RESPONSE_BYTES} bytes`);
    }
    body += decoder.decode(value, { stream: true });
  }
  return body + decoder.decode();
}

function containsCcipHttpError(dataHex) {
  const bare = String(dataHex).replace(/^0x/i, '').toLowerCase();
  for (let i = 0; i + CCIP_HTTP_ERROR_SELECTOR.length <= bare.length; i += 2) {
    if (bare.slice(i, i + CCIP_HTTP_ERROR_SELECTOR.length) === CCIP_HTTP_ERROR_SELECTOR) {
      return true;
    }
  }
  return false;
}

async function fetchMyotisCcipResponse(rec) {
  const senderHex = rec.senderHex;
  const callDataHex = rec.callDataHex;
  const urls = Array.isArray(rec.urls) ? rec.urls.filter((url) => typeof url === 'string') : [];
  if (!senderHex || !callDataHex || urls.length === 0) {
    throw new Error('CCIP-Read OffchainLookup did not include an actionable gateway tuple');
  }

  const reasons = [];
  for (const template of urls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MYOTIS_CCIP_TIMEOUT_MS);
    try {
      const useGet = template.includes('{data}');
      const url = template.replaceAll('{sender}', senderHex).replaceAll('{data}', callDataHex);
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(`unsupported gateway protocol ${parsed.protocol}`);
      }
      const response = await fetch(url, {
        method: useGet ? 'GET' : 'POST',
        headers: useGet
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: useGet ? undefined : JSON.stringify({ sender: senderHex, data: callDataHex }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readMyotisCcipBody(response);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error('response is not valid JSON');
      }
      const dataHex = typeof payload?.data === 'string' && /^0x[0-9a-fA-F]*$/.test(payload.data)
        ? payload.data
        : null;
      if (!dataHex) throw new Error('response has no hex data field');
      if ((dataHex.length - 2) % 2 !== 0) throw new Error('response data has odd-length hex');
      if (containsCcipHttpError(dataHex)) throw new Error('gateway returned HttpError');
      return dataHex;
    } catch (err) {
      reasons.push(`${template.slice(0, 200)}: ${err.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`CCIP-Read gateway failed: ${reasons.join('; ')}`);
}

// Drive the host half of ERC-3668 for the native engine. Myotis performs the
// resolver walk and verified callback execution; Freedom only fetches the
// gateway payload carried by the on-chain OffchainLookup tuple. One round is
// allowed, matching the upstream host driver and preventing recursive fetches.
async function resolveMyotisEnsRecord(params) {
  const original = { ...params, root: params.root || 'auto' };
  let rec = await myotisManager.resolveEnsRecord(original);
  if (rec.error) throw new Error(rec.error);

  for (let round = 0; rec.status === 'offchain'; round++) {
    if (round >= MYOTIS_CCIP_MAX_ROUNDS) {
      throw new Error(`CCIP-Read recursion exceeds ${MYOTIS_CCIP_MAX_ROUNDS} round`);
    }
    const responseHex = await fetchMyotisCcipResponse(rec);
    rec = await myotisManager.resolveEnsRecord({
      ...original,
      method: 'ccipCallback',
      queryMethod: original.method,
      senderHex: rec.senderHex,
      callbackFunctionHex: rec.callbackFunctionHex,
      responseHex,
      extraDataHex: rec.extraDataHex,
      wrapped: rec.wrapped === true,
      finalized: rec.verified === true,
    });
    if (rec.error) throw new Error(rec.error);
  }
  return rec;
}

// The specialized ENS record API can pin to finalized state and reports that
// fact explicitly. Re-encode its decoded values to the raw ABI return shape
// shared by Colibri and RPC quorum so downstream decoders remain unchanged.
async function tryMyotisEnsPath(name, callData, nameSystem) {
  const selector = String(callData).slice(0, 10).toLowerCase();
  const method =
    selector === CONTENTHASH_SELECTOR
      ? 'contenthash'
      : selector === ADDR_SELECTOR
        ? 'addr'
        : null;
  if (!method) return null;

  const rec = await resolveMyotisEnsRecord({ method, name });
  const trust = buildMyotisTrust(rec, nameSystem);
  if (rec.status === 'noRecord') {
    return {
      outcome: 'data',
      resolvedData:
        method === 'contenthash'
          ? ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], ['0x'])
          : ethers.AbiCoder.defaultAbiCoder().encode(['address'], [ethers.ZeroAddress]),
      resolverAddress: null,
      trust,
      block: rec.blockNumber ?? null,
    };
  }
  if (rec.status !== 'ok') {
    throw new Error(`unexpected ${method} record shape: ${JSON.stringify(rec).slice(0, 200)}`);
  }
  const value = method === 'contenthash' ? rec.dataHex : rec.addressHex;
  if (!value) {
    throw new Error(`missing ${method} value: ${JSON.stringify(rec).slice(0, 200)}`);
  }
  return {
    outcome: 'data',
    resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(
      [method === 'contenthash' ? 'bytes' : 'address'],
      [value]
    ),
    resolverAddress: null,
    trust,
    block: rec.blockNumber ?? null,
  };
}

// WNS and GNS are separate NameNFT contracts, not ENS registries. Myotis's
// generic verified eth_call can execute their existing calldata locally. The
// current v0.1.7 addon pins generic calls to the beacon optimistic head. Every
// state fetch is MPT-verified against that root and the root is authenticated
// by the light client's sync committee; `ok` therefore means cryptographically
// verified, while the trust metadata still states that it is not finalized.
async function tryMyotisContractPath(callData, nameSystem) {
  const rec = await myotisManager.ethCall({
    to: nameSystem.contractAddress,
    data: callData,
    block: 'latest',
  });
  if (rec.error) throw new Error(rec.error);
  if (rec.status !== 'ok' || typeof rec.resultHex !== 'string') {
    throw new Error(`Myotis contract call unavailable: ${rec.reason || rec.status || 'unknown'}`);
  }
  const status = myotisManager.getStatus() || {};
  const blockNumber = status.optimisticBlockNumber ?? null;
  const trust = buildMyotisTrust({ verified: false, blockNumber }, nameSystem);
  return {
    outcome: 'data',
    resolvedData: rec.resultHex,
    resolverAddress: nameSystem.contractAddress,
    trust,
    block: blockNumber,
  };
}

// Returns null only while the node cannot serve or when the requested selector
// is outside Freedom's current content/address surface. Real read failures
// throw so the orchestrator logs the handoff to the configured fallback.
async function tryMyotisPath(name, callData, nameSystem) {
  if (!myotisManager.isReady()) return null;
  const epoch = myotisManager.getAvailabilityEpoch();
  const result = nameSystem.contractAddress
    ? await tryMyotisContractPath(callData, nameSystem)
    : await tryMyotisEnsPath(name, callData, nameSystem);
  if (epoch !== myotisManager.getAvailabilityEpoch() || !myotisManager.isReady()) {
    const err = new Error('Myotis availability changed during verified read');
    err.code = 'MYOTIS_LIFECYCLE_CHANGED';
    throw err;
  }
  return result;
}

// `verified` on the engine result is a FINALITY flag: true means the query ran
// against the beacon-finalized root; false means the sync-committee-attested
// optimistic root. Both paths cryptographically verify state and fail closed.
// Keep the distinction in `finality` and proof copy instead of mislabelling an
// authenticated optimistic result as an unverified RPC response. This matches
// Colibri, whose verified proof also targets a recent sync-committee head.
function buildMyotisTrust(rec, nameSystem = NAME_SYSTEMS.ens) {
  const finalized = rec.verified === true;
  return {
    level: 'verified',
    system: nameSystem.id,
    method: 'myotis',
    finality: finalized ? 'finalized' : 'optimistic',
    proof: finalized
      ? 'P2P light client (beacon-finalized, sync-committee proof)'
      : 'P2P light client (optimistic beacon root — attested, not finalized)',
    block: rec.blockNumber ?? null,
    agreed: ['myotis-p2p'],
    dissented: [],
    queried: ['myotis-p2p'],
    quorum: { k: 1, m: 1, achieved: true },
  };
}

// Colibri primary path: a single cryptographically-verified eth_call against
// the Universal Resolver via @corpus-core/colibri-stateless. The verifier
// runs the EVM locally against proven storage, so a successful return is
// already cross-checked against the Ethereum sync committee (or, with
// zk_proof, a recursive zk sync proof). No anchor corroboration is needed —
// Colibri pins to head − 1 by construction (sync committee signature for
// block N lives in block N+1).
//
// Throws on proof-verification failure / network error / prover outage so
// the orchestrator can fall through to the next configured method.
async function tryColibriPath(
  name,
  callData,
  callResolver = universalResolverCall,
  nameSystem = NAME_SYSTEMS.ens,
) {
  // Lazy require avoids a load-time cycle: colibri-resolver imports
  // universalResolverCall + hostOf from this module.
  const { resolveCallViaColibri } = require('./ens/colibri-resolver');
  const proverHost = colibriProverHost();

  let result;
  try {
    result = await resolveCallViaColibri(name, callData, callResolver);
  } catch (err) {
    if (isResolverNotFoundError(err)) {
      return {
        outcome: 'not_found',
        reason: 'NO_RESOLVER',
        trust: buildColibriTrust(proverHost, nameSystem),
        block: null,
      };
    }
    if (err.code === 'CALL_EXCEPTION' && getRevertData(err)) {
      // Verified revert with an unknown selector — same semantics as the
      // quorum path's NO_CONTENTHASH bucket. Upstream maps that to
      // RESOLUTION_ERROR for addr lookups and "no contenthash" for content.
      return {
        outcome: 'not_found',
        reason: 'NO_CONTENTHASH',
        error: err.message,
        trust: buildColibriTrust(proverHost, nameSystem),
        block: null,
      };
    }
    throw err;
  }

  return {
    outcome: 'data',
    resolvedData: result.resolvedData,
    resolverAddress: result.resolverAddress,
    trust: buildColibriTrust(proverHost, nameSystem),
    block: null,
  };
}

// Host of the configured mainnet Colibri prover, for trust labelling.
// Empty when none is configured — the colibri path then errors and the
// orchestrator falls through to the quorum fallback.
function colibriProverHost() {
  const [proverUrl] = registry.getEndpoints(1, 'prover');
  return proverUrl ? hostOf(proverUrl) : '';
}

function colibriProofLabel() {
  return registry.getNetwork(1).zkProof === false
    ? 'Sync-committee proof'
    : 'ZK sync-committee proof';
}

function buildColibriTrust(proverHost, nameSystem = NAME_SYSTEMS.ens) {
  return {
    level: 'verified',
    system: nameSystem.id,
    method: 'colibri',
    prover: proverHost,
    proof: colibriProofLabel(),
    block: null,
    agreed: [proverHost],
    dissented: [],
    queried: [proverHost],
    quorum: { k: 1, m: 1, achieved: true },
  };
}

// Single-leg fast path for the `direct` strategy. `userConfigured` is the
// honest trust basis: true when the endpoint is a user-added source
// (trust='user-configured'), false when `direct` was chosen without a
// custom endpoint so it's just an unverified builtin public RPC. On any
// failure, return null so the caller can try the next configured method.
// Pinned block is fetched from the same RPC — we don't want to send
// user-node requests to public RPCs behind their back.
async function tryDirectResolve(
  rpcUrl,
  name,
  callData,
  userConfigured,
  callResolver = universalResolverCall,
  nameSystem = NAME_SYSTEMS.ens,
) {
  const { quorum } = registry.getNetwork(1);
  const anchor = quorum.anchor || 'latest';
  const timeoutMs = Number(quorum.timeoutMs) || 5000;
  let block;
  try {
    block = await fetchSingleSourceAnchor(rpcUrl, anchor, timeoutMs);
  } catch (err) {
    log.warn(`[ens] direct RPC anchor fetch failed (${hostOf(rpcUrl)}): ${err.message}`);
    return null;
  }

  const leg = await runQuorumLeg(
    rpcUrl,
    name,
    callData,
    block.hash,
    timeoutMs,
    null,
    callResolver,
  );
  if (leg.status === 'error') {
    log.warn(`[ens] direct RPC leg failed (${hostOf(rpcUrl)}): ${leg.error?.message}`);
    return null;
  }

  const trust = buildTrust({
    level: userConfigured ? 'user-configured' : 'unverified',
    system: nameSystem.id,
    agreed: [hostOf(rpcUrl)],
    dissented: [],
    queried: [hostOf(rpcUrl)],
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
  return {
    outcome: 'not_found',
    reason: leg.reason || 'NO_RESOLVER',
    error: leg.error?.message,
    trust,
    block,
  };
}

// Degraded resolution against a single RPC. Shared by the K<3 config
// paths and the runtime "anchor corroboration infeasible" fallback so
// both produce the same `unverified` shape. Throws only when the single
// provider itself errors.
async function resolveSingleSourceUnverified(
  url,
  name,
  callData,
  anchor,
  timeoutMs,
  callResolver = universalResolverCall,
  nameSystem = NAME_SYSTEMS.ens,
) {
  let block;
  try {
    block = await fetchSingleSourceAnchor(url, anchor, timeoutMs);
  } catch (err) {
    throw new Error(`Single-provider anchor fetch failed: ${err.message}`, { cause: err });
  }
  const legResult = await runQuorumLeg(
    url,
    name,
    callData,
    block.hash,
    timeoutMs,
    null,
    callResolver,
  );
  const trust = buildTrust({
    level: 'unverified',
    system: nameSystem.id,
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
    return {
      outcome: 'not_found',
      reason: legResult.reason || 'NO_RESOLVER',
      error: legResult.error?.message,
      trust,
      block,
    };
  }
  throw legResult.error || new Error('Single-provider resolution failed');
}

function getDirectRpcCandidate(chainId) {
  const cid = String(chainId);
  const [url] = registry.getEndpoints(chainId, 'rpc');
  if (!url) return { url: null, userConfigured: false };

  const source = registry.getEndpointSources(chainId, 'rpc').find(
    (src) => !src.keyed && src.coverage?.[cid] === url
  );
  const sourceMeta = source
    ? registry.getEndpointSourceList().find((src) => src.id === source.id)
    : null;
  return {
    url,
    userConfigured: !!sourceMeta && !sourceMeta.builtin && !sourceMeta.removed && !sourceMeta.keyed,
  };
}

// Returns one of:
//   { outcome: 'data',       resolvedData, resolverAddress, trust, block }
//   { outcome: 'not_found',  reason,                         trust, block }
//   { outcome: 'conflict',   groups,                         trust, block }
// Throws when there are no providers or both waves all-errored.
async function resolveViaQuorum(normalizedName, callData, kind = 'content', options = {}) {
  const network = registry.getNetwork(1);
  const callResolver = options.callResolver || universalResolverCall;
  const nameSystem = options.nameSystem || NAME_SYSTEMS.ens;

  const { quorum } = network;
  const desiredK = Math.max(1, Math.min(Number(quorum.k) || 3, 9));
  const desiredM = Math.max(1, Math.min(Number(quorum.m) || 2, desiredK));
  const timeoutMs = Number(quorum.timeoutMs) || 5000;
  const anchor = quorum.anchor || 'latest';

  const available = getAvailableProviders();
  if (available.length === 0) {
    throw new Error('No available RPC providers for ENS consensus resolution');
  }

  // Degraded single-source path. Taken when:
  //   - fewer than 3 providers are non-quarantined (not enough to tolerate
  //     one outlier via median), OR
  //   - the network's K/M is sub-minimum (K<3 or M<2). In that case the
  //     corroborated path can't honestly produce `verified` anyway, so we
  //     respect the configuration and downgrade rather than hard-failing.
  // A single liar within the drift window can bias a K=2 anchor into the
  // past; we surface the outcome as `unverified` rather than minting a
  // "verified" badge we can't defend.
  const quorumUnderpowered =
    desiredK < MIN_QUORUM_PROVIDERS || desiredM < 2;
  if (available.length < MIN_QUORUM_PROVIDERS || quorumUnderpowered) {
    return resolveSingleSourceUnverified(
      available[0],
      normalizedName,
      callData,
      anchor,
      timeoutMs,
      callResolver,
      nameSystem,
    );
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
    return resolveSingleSourceUnverified(
      fallbackUrl,
      normalizedName,
      callData,
      anchor,
      timeoutMs,
      callResolver,
      nameSystem,
    );
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
      normalizedName,
      callData,
      anchor,
      timeoutMs,
      callResolver,
      nameSystem,
    );
  }

  const effectiveK = Math.min(desiredK, waveAvailable.length);
  const effectiveM = Math.min(desiredM, effectiveK);

  const firstSelection = waveAvailable.slice(0, effectiveK);

  log.info(
    `[ens] consensus kind=${kind} name=${nameForLog(normalizedName)} k=${effectiveK} m=${effectiveM} ` +
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
    callResolver,
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
          callResolver,
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
    level,
    system: nameSystem.id,
    agreed,
    dissented,
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

const RESOLUTION_METHOD_IDS = new Set(['myotis', 'colibri', 'quorum', 'direct']);

function resolutionPolicy(network) {
  const verification = network?.verification || {};
  const configured = Array.isArray(verification.order)
    ? verification.order.filter((method, index, all) =>
        RESOLUTION_METHOD_IDS.has(method) && all.indexOf(method) === index
      )
    : [];
  if (configured.length > 0) {
    return {
      order: configured,
      preferVerified: verification.preferVerified === true,
    };
  }

  // Legacy network-config.json files only have `primary`. Preserve their old
  // behavior until the user saves the new policy: Myotis first when enabled,
  // the selected remote strategy next, and quorum as Colibri/direct fallback.
  const primary = ['colibri', 'quorum', 'direct'].includes(verification.primary)
    ? verification.primary
    : 'colibri';
  return {
    order: [...new Set(['myotis', primary, ...(primary === 'quorum' ? [] : ['quorum'])])],
    preferVerified: false,
  };
}

function isProvisionalResolution(result) {
  return result?.trust?.level === 'unverified';
}

function unavailableResolutionReason(method) {
  if (method === 'myotis') {
    return myotisManager.isEnabled() ? 'not-ready' : 'disabled';
  }
  if (method === 'direct') return 'not-configured';
  return 'unavailable';
}

function logForwardMethodOutcome({
  method, normalizedName, kind, result, action, reason, durationMs,
}) {
  const outcome = result?.outcome ? String(result.outcome).toUpperCase() : 'SKIP';
  const trust = result?.trust?.level || 'none';
  log.info(
    `[ens] method=${method} name=${nameForLog(normalizedName)} kind=${kind} outcome=${outcome} ` +
    `trust=${trust} action=${action} reason=${reason || 'none'} durationMs=${durationMs}`
  );
}

// Execute exactly one configured method. Keeping this separate from the
// fallback loop is important for reverse records: a WNS/GNS reverse claim
// must be forward-verified through the same source that produced the claim.
async function resolveWithMethod(method, normalizedName, callData, kind, options = {}) {
  const callResolver = options.callResolver || universalResolverCall;
  const nameSystem = options.nameSystem || NAME_SYSTEMS.ens;

  if (method === 'myotis') {
    if (!myotisManager.isEnabled()) return null;
    return tryMyotisPath(normalizedName, callData, nameSystem);
  }
  if (method === 'colibri') {
    return tryColibriPath(normalizedName, callData, callResolver, nameSystem);
  }
  if (method === 'direct') {
    const direct = getDirectRpcCandidate(1);
    if (!direct.url) return null;
    return tryDirectResolve(
      direct.url,
      normalizedName,
      callData,
      direct.userConfigured,
      callResolver,
      nameSystem,
    );
  }
  if (method === 'quorum') {
    return resolveViaQuorum(normalizedName, callData, kind, options);
  }
  return null;
}

// Execute the user's unified resolution order. An unverified answer can be
// retained provisionally while later methods get a chance to produce a
// verified result; conflicts and user-configured/verified answers always stop.
async function consensusResolve(normalizedName, callData, kind = 'content', options = {}) {
  const network = registry.getNetwork(1);
  const callResolver = options.callResolver || universalResolverCall;
  const nameSystem = options.nameSystem || NAME_SYSTEMS.ens;
  const { order, preferVerified } = resolutionPolicy(network);
  let provisional = null;
  let provisionalMethod = null;
  let lastError = null;

  log.info(
    `[ens] policy name=${nameForLog(normalizedName)} kind=${kind} order=[${order.join(',')}] ` +
    `preferVerified=${preferVerified}`
  );

  for (const method of order) {
    const startedAt = Date.now();
    let result;
    try {
      result = await resolveWithMethod(method, normalizedName, callData, kind, {
        ...options,
        callResolver,
        nameSystem,
      });
    } catch (err) {
      if (err?.code === 'MYOTIS_LIFECYCLE_CHANGED') throw err;
      lastError = err;
      log.warn(
        `[ens] ${method}-fallback name=${nameForLog(normalizedName)} kind=${kind} ` +
        formatResolutionErrorForLog(err)
      );
      logForwardMethodOutcome({
        method,
        normalizedName,
        kind,
        result: { outcome: 'error' },
        action: 'continue',
        reason: err?.code || 'error',
        durationMs: Date.now() - startedAt,
      });
      continue;
    }

    if (!result) {
      logForwardMethodOutcome({
        method,
        normalizedName,
        kind,
        result,
        action: 'continue',
        reason: unavailableResolutionReason(method),
        durationMs: Date.now() - startedAt,
      });
      continue;
    }
    if (preferVerified && isProvisionalResolution(result)) {
      if (!provisional) {
        provisional = result;
        provisionalMethod = method;
      }
      logForwardMethodOutcome({
        method,
        normalizedName,
        kind,
        result,
        action: 'continue',
        reason: 'prefer-verified',
        durationMs: Date.now() - startedAt,
      });
      continue;
    }
    logForwardMethodOutcome({
      method,
      normalizedName,
      kind,
      result,
      action: 'accept',
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  if (provisional) {
    logForwardMethodOutcome({
      method: provisionalMethod,
      normalizedName,
      kind,
      result: provisional,
      action: 'accept',
      reason: 'fallback-exhausted',
      durationMs: 0,
    });
    return provisional;
  }
  if (lastError) throw lastError;
  throw new Error(`No enabled name-resolution method could resolve ${normalizedName}`);
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
  const nameSystem = nameSystemForName(normalized);

  const consensus = await consensusResolve(normalized, callData, 'content', {
    onFirstData: prefetchOnFirstData,
    callResolver: nameSystem.contractAddress ? nameNftResolverCall : universalResolverCall,
    nameSystem,
  });
  const { trust } = consensus;

  if (consensus.outcome === 'conflict') {
    return cacheContentResult(normalized, {
      type: 'conflict',
      name: normalized,
      system: nameSystem.id,
      trust,
      groups: consensus.groups,
    });
  }

  if (consensus.outcome === 'not_found') {
    const out = {
      type: 'not_found',
      reason: consensus.reason || 'NO_RESOLVER',
      name: normalized,
      system: nameSystem.id,
      trust,
    };
    if (consensus.error) out.error = consensus.error;
    if (out.reason === 'NO_CONTENTHASH' && out.error) {
      // Unknown UR/CCIP reverts are transient failures, not authoritative
      // empty records. Let reloads re-probe instead of pinning a negative.
      log.info(`[ens] NO_CONTENTHASH for ${nameForLog(normalized)} (not cached)`);
      return out;
    }
    return cacheContentResult(normalized, out);
  }

  // outcome === 'data' — decode ABI-wrapped `bytes` return of contenthash().
  let innerBytes;
  try {
    [innerBytes] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], consensus.resolvedData);
  } catch (err) {
    log.warn(
      `[ens] Failed to decode contenthash bytes for ${nameForLog(normalized)}: ${err.message}`
    );
    return cacheContentResult(normalized, {
      type: 'unsupported',
      reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
      name: normalized,
      system: nameSystem.id,
      contentHash: consensus.resolvedData,
      trust,
    });
  }

  if (!innerBytes || innerBytes === '0x') {
    return cacheContentResult(normalized, {
      type: 'not_found',
      reason: 'EMPTY_CONTENTHASH',
      name: normalized,
      system: nameSystem.id,
      trust,
    });
  }

  const parsed = parseContentHashBytes(innerBytes);
  if (!parsed) {
    log.warn(
      `[ens] UNSUPPORTED_CONTENTHASH_FORMAT for ${nameForLog(normalized)}: ${redactForLog(innerBytes)}`
    );
    return cacheContentResult(normalized, {
      type: 'unsupported',
      reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
      name: normalized,
      system: nameSystem.id,
      contentHash: innerBytes,
      trust,
    });
  }

  return cacheContentResult(normalized, {
    type: 'ok',
    name: normalized,
    system: nameSystem.id,
    ...parsed,
    trust,
  });
}

// Decode raw ENS contenthash bytes into our result shape. Mirrors ethers'
// internal decoder bit-for-bit to preserve CIDv0 base58 output for IPFS
// — a content-hash library would normalize everything to CIDv1, breaking
// history/bookmark matching on names users already visited.
// Returns null for any format we don't support.
function parseContentHashBytes(hex0x) {
  const dagPb = hex0x.match(IPFS_DAG_PB_CONTENTHASH_RE);
  if (dagPb) {
    const { multihash, mhLen, digest } = dagPb.groups;
    if (digest.length === parseInt(mhLen, 16) * 2) {
      const decoded = ethers.encodeBase58('0x' + multihash);
      return {
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${decoded}`,
        decoded,
      };
    }
  }
  const ipfsCidV1 = hex0x.match(IPFS_CIDV1_CONTENTHASH_RE);
  if (ipfsCidV1) {
    const decoded = cidV1BytesToBase32(ethers.getBytes('0x' + ipfsCidV1.groups.cid));
    if (decoded) {
      return {
        codec: 'ipfs-ns',
        protocol: 'ipfs',
        uri: `ipfs://${decoded}`,
        decoded,
      };
    }
  }
  const ipns = hex0x.match(IPNS_CONTENTHASH_RE);
  if (ipns) {
    const { multihash, mhLen, digest } = ipns.groups;
    if (digest.length === parseInt(mhLen, 16) * 2) {
      const decoded = ethers.encodeBase58('0x' + multihash);
      return {
        codec: 'ipns-ns',
        protocol: 'ipns',
        uri: `ipns://${decoded}`,
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

// Shared validation + cache wrapper for content-hash, addr, and reverse
// lookups. Each strategy handles provider fallback internally, so this layer
// only normalizes, caches, and deduplicates concurrent work.
//
// Normalization goes through @adraffy/ens-normalize (UTS-46 / ENSIP-15),
// not a bare .toLowerCase(). That's correct for unicode ENS names
// (emoji labels, non-ASCII domains) whose namehash depends on canonical
// NFC form. `ens_normalize` is a no-op beyond lowercasing for pure-ASCII
// names like "Vitalik.ETH", so callers that pass 0x addresses (reverse
// lookup) are unaffected. Invalid labels throw — which propagates to
// the IPC handler and surfaces as a RESOLUTION_ERROR to the renderer.
// Pure-ASCII names (the vast majority — vitalik.eth, app.eth, …) survive
// `ens_normalize` unchanged beyond a lowercase. Skipping the full UTS-46
// pass for them avoids paying the normalization cost on every cache-hit
// path (the bzz protocol handler now resolves on every subresource
// request, so a busy page can fan out dozens of cache hits per page load).
const PURE_ASCII_HOST = /^[a-z0-9-.]+$/;
const MAX_LIFECYCLE_RESTARTS = 3;

function fastNormalize(trimmed) {
  const lowered = trimmed.toLowerCase();
  if (PURE_ASCII_HOST.test(lowered)) return lowered;
  return ens_normalize(trimmed);
}

async function resolveWithCache(name, cache, doResolve, label) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('ENS name is empty');
  }
  const normalized = fastNormalize(trimmed);

  const cached = cache.get(normalized);
  if (cached && Date.now() < cached.expiresAt) {
    log.debug(`[ens] ${label} cache hit for ${nameForLog(normalized)}`);
    return cached.result;
  }

  const dedupKey = `${label}:${normalized}`;
  const existing = inFlightResolves.get(dedupKey);
  if (existing) {
    log.info(`[ens] ${label} joining in-flight resolution for ${nameForLog(normalized)}`);
    return existing;
  }

  let promise;
  promise = resolveAcrossStableLifecycle(normalized, cache, doResolve, label).finally(() => {
    // A Myotis transition clears the map so a fresh request can begin. Do not
    // let the older promise's finally handler delete that replacement entry.
    if (inFlightResolves.get(dedupKey) === promise) {
      inFlightResolves.delete(dedupKey);
    }
  });

  inFlightResolves.set(dedupKey, promise);
  return promise;
}

async function resolveAcrossStableLifecycle(normalized, cache, doResolve, label) {
  for (let attempt = 1; attempt <= MAX_LIFECYCLE_RESTARTS; attempt++) {
    const epoch = resolutionLifecycleEpoch;
    let result;
    try {
      result = await doResolve(normalized);
    } catch (err) {
      if (epoch === resolutionLifecycleEpoch) throw err;
      log.info(
        `[ens] ${label} lifecycle changed during failed resolution for ${nameForLog(normalized)}; ` +
        `restarting (${attempt}/${MAX_LIFECYCLE_RESTARTS})`
      );
      continue;
    }

    if (epoch === resolutionLifecycleEpoch) return result;

    // doResolve helpers cache before returning. Remove only this stale result;
    // a newer concurrent request may already have populated the same key.
    const cached = cache.get(normalized);
    if (cached?.result === result) cache.delete(normalized);
    log.info(
      `[ens] ${label} lifecycle changed during resolution for ${nameForLog(normalized)}; ` +
      `discarding stale result and restarting (${attempt}/${MAX_LIFECYCLE_RESTARTS})`
    );
  }
  throw new Error(`Myotis availability changed repeatedly while resolving ${normalized}`);
}

async function doResolveEnsAddress(normalized) {
  const node = ethers.namehash(normalized);
  const callData = ADDR_SELECTOR + node.slice(2);
  const nameSystem = nameSystemForName(normalized);

  const consensus = await consensusResolve(normalized, callData, 'addr', {
    callResolver: nameSystem.contractAddress ? nameNftResolverCall : universalResolverCall,
    nameSystem,
  });
  const { trust } = consensus;

  if (consensus.outcome === 'conflict') {
    return cacheAddressResult(normalized, {
      success: false,
      name: normalized,
      system: nameSystem.id,
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
        system: nameSystem.id,
        reason: 'RESOLUTION_ERROR',
        error: consensus.error,
        trust,
      });
    }
    return cacheAddressResult(normalized, {
      ...noAddressResult(normalized),
      system: nameSystem.id,
      trust,
    });
  }

  // outcome === 'data' — addr() returns a plain 32-byte ABI-encoded address
  // (static type, not bytes-wrapped).
  if (!consensus.resolvedData || consensus.resolvedData === '0x') {
    return cacheAddressResult(normalized, {
      ...noAddressResult(normalized),
      system: nameSystem.id,
      trust,
    });
  }

  let address;
  try {
    [address] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], consensus.resolvedData);
  } catch (err) {
    log.warn(`[ens] Failed to decode addr bytes for ${nameForLog(normalized)}: ${err.message}`);
    return cacheAddressResult(normalized, {
      success: false,
      name: normalized,
      system: nameSystem.id,
      reason: 'RESOLUTION_ERROR',
      error: err.message,
      trust,
    });
  }

  if (address === ethers.ZeroAddress) {
    return cacheAddressResult(normalized, {
      ...noAddressResult(normalized),
      system: nameSystem.id,
      trust,
    });
  }

  return cacheAddressResult(normalized, {
    success: true,
    name: normalized,
    system: nameSystem.id,
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
    log.info(
      `[ens] Resolved: ${nameForLog(normalized)} → ${redactForLog(okValue)} (ttl=${ttl}ms)`
    );
  } else {
    log.info(`[ens] ${result.reason || result.type} for ${nameForLog(normalized)} (ttl=${ttl}ms)`);
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

// Colibri reverse path: cryptographically-verified `ur.reverse`. Returns
// the common reverse-result shape plus a `trust` object so the
// renderer can surface a "verified" indicator. ReverseAddressMismatch
// surfaces as UNVERIFIED — the proof was valid but the contract reverted,
// which is the spoofed-reverse-record signal.
async function tryColibriReverse(normalizedAddress) {
  const { resolveReverseViaColibri } = require('./ens/colibri-resolver');
  const trust = buildColibriTrust(colibriProverHost());
  const addrBytes = ethers.getBytes(normalizedAddress);

  let name;
  try {
    ({ name } = await resolveReverseViaColibri(addrBytes));
  } catch (err) {
    if (isResolverNotFoundError(err)) {
      return { ...noReverseResult(normalizedAddress), trust };
    }
    if (isReverseAddressMismatchError(err)) {
      return {
        success: false,
        address: normalizedAddress,
        system: 'ens',
        reason: 'UNVERIFIED',
        claimedName: decodeReverseMismatchClaimedName(err),
        error: `Reverse record for ${normalizedAddress} does not forward-verify`,
        trust,
      };
    }
    throw err;
  }

  if (!name) return { ...noReverseResult(normalizedAddress), trust };
  return { success: true, address: normalizedAddress, name, system: 'ens', trust };
}

const CONTRACT_BACKED_REVERSE_SYSTEMS = [NAME_SYSTEMS.wns, NAME_SYSTEMS.gns];

function unverifiedReverseResult(normalizedAddress, nameSystem, claimedName, detail, trust = undefined) {
  return {
    success: false,
    address: normalizedAddress,
    system: nameSystem.id,
    reason: 'UNVERIFIED',
    claimedName: claimedName || null,
    error: detail || `Reverse record for ${normalizedAddress} does not forward-verify`,
    ...(trust ? { trust } : {}),
  };
}

async function readMyotisReverse(normalizedAddress) {
  const ensRec = await resolveMyotisEnsRecord({
    method: 'reverse',
    addressHex: normalizedAddress,
  });
  const ensTrust = buildMyotisTrust(ensRec, NAME_SYSTEMS.ens);
  if (ensRec.status === 'ok' && ensRec.name) {
    return {
      success: true,
      address: normalizedAddress,
      name: ensRec.name,
      system: 'ens',
      trust: ensTrust,
    };
  }
  if (ensRec.status !== 'noRecord') {
    throw new Error(`unexpected reverse record shape: ${JSON.stringify(ensRec).slice(0, 200)}`);
  }

  // WNS/GNS reverse records live on their NameNFT contracts. Query each over
  // Myotis and forward-check any claim through the same local verified-call
  // path before presenting it as a name.
  let firstUnverified = null;
  let lastTrust = ensTrust;
  for (const nameSystem of CONTRACT_BACKED_REVERSE_SYSTEMS) {
    const reverseCall = NAME_NFT_INTERFACE.encodeFunctionData('reverseResolve', [
      normalizedAddress,
    ]);
    const reverseOutcome = await tryMyotisContractPath(reverseCall, nameSystem);
    lastTrust = reverseOutcome.trust;
    let claimedName;
    try {
      [claimedName] = NAME_NFT_INTERFACE.decodeFunctionResult(
        'reverseResolve',
        reverseOutcome.resolvedData
      );
    } catch (err) {
      throw new Error(`invalid ${nameSystem.label} reverse response: ${err.message}`, {
        cause: err,
      });
    }
    if (!claimedName) continue;

    const claimedSystem = nameSystemForName(claimedName);
    if (claimedSystem.id !== nameSystem.id) {
      const invalid = unverifiedReverseResult(
        normalizedAddress,
        nameSystem,
        claimedName,
        `Reverse record for ${normalizedAddress} claims a non-${nameSystem.label} name`,
        reverseOutcome.trust
      );
      if (!firstUnverified) firstUnverified = invalid;
      continue;
    }

    let forwardOutcome;
    try {
      const normalizedClaim = fastNormalize(String(claimedName).trim());
      const forwardCall = ADDR_SELECTOR + ethers.namehash(normalizedClaim).slice(2);
      forwardOutcome = await tryMyotisContractPath(forwardCall, nameSystem);
      const [forwardAddress] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['address'],
        forwardOutcome.resolvedData
      );
      if (String(forwardAddress).toLowerCase() === normalizedAddress) {
        return {
          success: true,
          address: normalizedAddress,
          name: normalizedClaim,
          system: nameSystem.id,
          trust: forwardOutcome.trust,
        };
      }
    } catch (err) {
      log.info(
        `[${nameSystem.id}] myotis forward verification failed for ${nameForLog(normalizedAddress)}: ` +
        `${err.message}`
      );
    }

    const invalid = unverifiedReverseResult(
      normalizedAddress,
      nameSystem,
      claimedName,
      `Reverse record for ${normalizedAddress} does not forward-verify`,
      forwardOutcome?.trust || reverseOutcome.trust
    );
    if (!firstUnverified) firstUnverified = invalid;
  }

  return firstUnverified || {
    ...noReverseResult(normalizedAddress),
    trust: lastTrust,
  };
}

async function tryMyotisReverse(normalizedAddress) {
  if (!myotisManager.isReady()) return null;
  const epoch = myotisManager.getAvailabilityEpoch();
  const result = await readMyotisReverse(normalizedAddress);
  if (epoch !== myotisManager.getAvailabilityEpoch() || !myotisManager.isReady()) {
    const err = new Error('Myotis availability changed during verified reverse read');
    err.code = 'MYOTIS_LIFECYCLE_CHANGED';
    throw err;
  }
  return result;
}

function reverseConflictResult(normalizedAddress, nameSystem, outcome) {
  return {
    success: false,
    address: normalizedAddress,
    system: nameSystem.id,
    reason: 'CONFLICT',
    error: `Providers disagreed about the reverse record for ${normalizedAddress}`,
    trust: outcome.trust,
    groups: outcome.groups,
  };
}

async function resolveEnsReverseWithMethod(method, normalizedAddress) {
  if (method === 'colibri') return tryColibriReverse(normalizedAddress);

  const outcome = await resolveWithMethod(method, normalizedAddress, '0x', 'reverse-ens', {
    callResolver: universalResolverReverseCall,
    nameSystem: NAME_SYSTEMS.ens,
  });
  if (!outcome) return null;
  if (outcome.outcome === 'conflict') {
    return reverseConflictResult(normalizedAddress, NAME_SYSTEMS.ens, outcome);
  }
  if (outcome.outcome === 'not_found') {
    return { ...noReverseResult(normalizedAddress), trust: outcome.trust };
  }

  const decoded = decodeReverseOutcome(outcome.resolvedData);
  if (decoded.status === REVERSE_OUTCOME.name) {
    return {
      success: true,
      address: normalizedAddress,
      name: decoded.detail,
      system: 'ens',
      trust: outcome.trust,
    };
  }
  if (decoded.status === REVERSE_OUTCOME.mismatch) {
    return unverifiedReverseResult(
      normalizedAddress,
      NAME_SYSTEMS.ens,
      decoded.detail || null,
      `Reverse record for ${normalizedAddress} does not forward-verify`,
      outcome.trust
    );
  }
  if (decoded.status === REVERSE_OUTCOME.error) {
    return {
      success: false,
      address: normalizedAddress,
      system: 'ens',
      reason: 'RESOLUTION_ERROR',
      error: decoded.detail,
      trust: outcome.trust,
    };
  }
  return { ...noReverseResult(normalizedAddress), trust: outcome.trust };
}

async function resolveContractBackedReverseWithMethod(method, normalizedAddress, ensResult) {
  if (ensResult?.reason !== 'NO_REVERSE') return ensResult;

  let firstUnverified = null;
  let lastTrust = ensResult.trust;
  for (const nameSystem of CONTRACT_BACKED_REVERSE_SYSTEMS) {
    const reverseCall = NAME_NFT_INTERFACE.encodeFunctionData('reverseResolve', [
      normalizedAddress,
    ]);
    const syntheticName = `reverse${nameSystem.suffix}`;
    const reverseOutcome = await resolveWithMethod(
      method,
      syntheticName,
      reverseCall,
      `reverse-${nameSystem.id}`,
      { callResolver: nameNftReverseResolverCall, nameSystem }
    );
    if (!reverseOutcome) return null;
    lastTrust = reverseOutcome.trust || lastTrust;
    if (reverseOutcome.outcome === 'conflict') {
      return reverseConflictResult(normalizedAddress, nameSystem, reverseOutcome);
    }
    if (reverseOutcome.outcome === 'not_found') continue;

    let claimedName;
    try {
      [claimedName] = ethers.AbiCoder.defaultAbiCoder().decode(
        ['string'],
        reverseOutcome.resolvedData
      );
    } catch (err) {
      throw new Error(`invalid ${nameSystem.label} reverse response: ${err.message}`, {
        cause: err,
      });
    }
    if (!claimedName) continue;

    const claimedSystem = nameSystemForName(claimedName);
    if (claimedSystem.id !== nameSystem.id) {
      firstUnverified ||= unverifiedReverseResult(
        normalizedAddress,
        nameSystem,
        claimedName,
        `Reverse record for ${normalizedAddress} claims a non-${nameSystem.label} name`,
        reverseOutcome.trust
      );
      continue;
    }

    let forwardOutcome;
    try {
      const normalizedClaim = fastNormalize(String(claimedName).trim());
      const forwardCall = ADDR_SELECTOR + ethers.namehash(normalizedClaim).slice(2);
      forwardOutcome = await resolveWithMethod(
        method,
        normalizedClaim,
        forwardCall,
        `reverse-forward-${nameSystem.id}`,
        { callResolver: nameNftResolverCall, nameSystem }
      );
      if (forwardOutcome?.outcome === 'data') {
        const [forwardAddress] = ethers.AbiCoder.defaultAbiCoder().decode(
          ['address'],
          forwardOutcome.resolvedData
        );
        if (String(forwardAddress).toLowerCase() === normalizedAddress) {
          return {
            success: true,
            address: normalizedAddress,
            name: normalizedClaim,
            system: nameSystem.id,
            trust: forwardOutcome.trust,
          };
        }
      }
    } catch (err) {
      log.info(
        `[${nameSystem.id}] ${method} forward verification failed for ${nameForLog(normalizedAddress)}: ` +
        `${err.message}`
      );
    }

    firstUnverified ||= unverifiedReverseResult(
      normalizedAddress,
      nameSystem,
      claimedName,
      `Reverse record for ${normalizedAddress} does not forward-verify`,
      forwardOutcome?.trust || reverseOutcome.trust
    );
  }

  return firstUnverified || {
    ...noReverseResult(normalizedAddress),
    trust: lastTrust,
  };
}

function isProvisionalReverse(result) {
  return result?.trust?.level === 'unverified' || result?.reason === 'UNVERIFIED';
}

function logReverseMethodOutcome(method, normalizedAddress, result, action, reason = '') {
  const outcome = result?.success ? 'RESOLVED' : result?.reason || 'UNAVAILABLE';
  const system = outcome === 'NO_REVERSE'
    ? 'ens,wns,gns'
    : result?.system || result?.trust?.system || 'none';
  const trust = result?.trust?.level || 'none';
  log.info(
    `[ens] reverse method=${method} address=${nameForLog(normalizedAddress)} outcome=${outcome} ` +
    `system=${system} trust=${trust} action=${action}${reason ? ` reason=${reason}` : ''}`
  );
}

async function doResolveEnsReverse(normalizedAddress) {
  const network = registry.getNetwork(1);
  const { order, preferVerified } = resolutionPolicy(network);
  let provisional = null;
  let provisionalMethod = null;
  let lastError = null;

  log.info(
    `[ens] reverse policy address=${nameForLog(normalizedAddress)} order=[${order.join(',')}] ` +
    `preferVerified=${preferVerified}`
  );

  for (const method of order) {
    let result = null;
    let unavailableReason = 'unavailable';
    try {
      if (method === 'myotis') {
        if (myotisManager.isEnabled()) {
          result = await tryMyotisReverse(normalizedAddress);
          if (!result) unavailableReason = 'not-ready';
        } else {
          unavailableReason = 'disabled';
        }
      } else {
        const ensResult = await resolveEnsReverseWithMethod(method, normalizedAddress);
        result = await resolveContractBackedReverseWithMethod(
          method,
          normalizedAddress,
          ensResult
        );
      }
    } catch (err) {
      if (err?.code === 'MYOTIS_LIFECYCLE_CHANGED') throw err;
      lastError = err;
      log.warn(
        `[ens] reverse method=${method} address=${nameForLog(normalizedAddress)} outcome=ERROR ` +
        `action=continue error=${err.message}`
      );
      continue;
    }

    if (!result) {
      logReverseMethodOutcome(method, normalizedAddress, result, 'continue', unavailableReason);
      continue;
    }
    if (preferVerified && isProvisionalReverse(result)) {
      if (!provisional) {
        provisional = result;
        provisionalMethod = method;
      }
      logReverseMethodOutcome(method, normalizedAddress, result, 'continue', 'prefer-verified');
      continue;
    }
    logReverseMethodOutcome(method, normalizedAddress, result, 'accept');
    return cacheReverseResult(normalizedAddress, result);
  }

  if (provisional) {
    logReverseMethodOutcome(
      provisionalMethod,
      normalizedAddress,
      provisional,
      'accept',
      'no-better-result'
    );
    return cacheReverseResult(normalizedAddress, provisional);
  }
  if (lastError) throw lastError;
  throw new Error(`No enabled name-resolution method could reverse-resolve ${normalizedAddress}`);
}

function noReverseResult(normalizedAddress) {
  return {
    success: false,
    address: normalizedAddress,
    reason: 'NO_REVERSE',
    error: `No primary name set for ${normalizedAddress}`,
  };
}

function cacheReverseResult(normalizedAddress, result) {
  return cacheAndLog(ensReverseCache, normalizedAddress, result, result.name);
}

// PRIVATE MODE GUARD (name logging): a name typed in a private window's
// address bar reaches the resolver through these handlers, so they are the
// point where the sender's private-ness is still known. Marking the async
// subtree redacts every downstream log site — including the ones inside
// the consensus wave, the per-method dispatch and the shared
// cache-and-log — without threading a flag through every resolver hop. The
// resolution itself is unchanged.
function privateResolveContext(event) {
  return isPrivateWebContents(event?.sender);
}

function registerEnsIpc() {
  ipcMain.handle(IPC.ENS_RESOLVE, async (event, payload = {}) => {
    const { name } = payload;

    return runWithPrivateLogContext(privateResolveContext(event), async () => {
      try {
        const result = await resolveEnsContent(name);
        return result;
      } catch (err) {
        log.error('[ens] resolution error', redactForLog(err));
        return {
          type: 'error',
          name: (name || '').trim().toLowerCase(),
          reason: 'RESOLUTION_ERROR',
          error: err.message,
        };
      }
    });
  });

  ipcMain.handle(IPC.ENS_RESOLVE_ADDRESS, async (event, payload = {}) => {
    const { name } = payload;
    return runWithPrivateLogContext(privateResolveContext(event), async () => {
      try {
        return await resolveEnsAddress(name);
      } catch (err) {
        log.error('[ens] address resolution error', redactForLog(err));
        return {
          success: false,
          name: (name || '').trim().toLowerCase(),
          reason: 'RESOLUTION_ERROR',
          error: err.message,
        };
      }
    });
  });

  ipcMain.handle(IPC.ENS_RESOLVE_REVERSE, async (event, payload = {}) => {
    const { address } = payload;
    return runWithPrivateLogContext(privateResolveContext(event), async () => {
      try {
        return await resolveEnsReverse(address);
      } catch (err) {
        log.error('[ens] reverse resolution error', redactForLog(err));
        return {
          success: false,
          address: typeof address === 'string' ? address.toLowerCase() : null,
          reason: 'RESOLUTION_ERROR',
          error: err.message,
        };
      }
    });
  });

  // Drop the cached contenthash for `name`. Used by the renderer's
  // swarm-probe failure handler so a "Try Again" click does a fresh
  // resolution rather than re-probing a stale contenthash.
  ipcMain.handle(IPC.ENS_INVALIDATE_CONTENT, async (event, payload = {}) => {
    const { name } = payload;
    return runWithPrivateLogContext(privateResolveContext(event), () =>
      invalidateEnsContent(name)
    );
  });
}

// Drop the contenthash cache entry for `name` (no-op if absent). Returns
// true when an entry was evicted, false otherwise.
function invalidateEnsContent(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) return false;
  let key;
  try {
    key = fastNormalize(trimmed);
  } catch {
    return false;
  }
  const had = ensResultCache.has(key);
  ensResultCache.delete(key);
  if (had) {
    log.info(`[ens] content cache invalidated for ${nameForLog(key)}`);
  }
  return had;
}

// Drop all cached resolution results. Called from invalidateCachedProvider
// after a settings edit (equivalent to waiting out the TTLs); tests also
// call it directly to share ENS names across cases without cross-pollution.
function clearEnsResolutionCaches() {
  resolutionLifecycleEpoch += 1;
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
  invalidateCachedProvider,
  invalidateEnsContent,
  universalResolverCall,
  universalResolverReverse,
  isResolverNotFoundError,
  clearEnsResolutionCaches,
  hostOf,
};
