const log = require('./logger');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const IPC = require('../shared/ipc-channels');
const { success, failure } = require('./ipc-contract');
const { loadSettings } = require('./settings-store');

// ENS v3 Universal Resolver (ENS Labs, current generation).
// One call here replaces the 3-step "registry lookup → supportsWildcard
// → contenthash" flow ethers would otherwise make, and handles CCIP-Read
// transparently for offchain resolvers (.box via 3DNS).
// If ENS ships a v4 UR, old deployments keep working — bumping is optional.
const UNIVERSAL_RESOLVER_ADDRESS = '0x5a9236e72a66d3e08b83dcf489b4d850792b6009';
const UR_ABI = [
  'function resolve(bytes name, bytes data) view returns (bytes resolvedData, address resolverAddress)',
  'function resolveMulticall(bytes name, bytes[] calls) view returns (bytes[] results)',
  'function reverse(bytes lookupAddress, uint256 coinType) view returns (string primaryName, address resolver, address reverseResolver)',
];

// bytes4(keccak256("contenthash(bytes32)"))
const CONTENTHASH_SELECTOR = '0xbc1c4a73';
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

let cachedProvider = null;
let cachedProviderUrl = null;

const ENS_CACHE_TTL_MS = 15 * 60 * 1000;
const ensResultCache = new Map();

// Independent from ensResultCache so content and addr lookups don't evict each other.
const ensAddressCache = new Map();

// Address (lowercased 0x) → { result, timestamp } for reverse lookups.
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

// Invalidate cached provider so next call tries a fresh one
function invalidateCachedProvider() {
  if (cachedProvider) {
    log.info(`[ens] Invalidating cached provider: ${cachedProviderUrl}`);
    cachedProvider.destroy();
    cachedProvider = null;
    cachedProviderUrl = null;
  }
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

// UR reverts with these custom errors when a name has no resolver or its
// resolver isn't a contract. Callers want to treat both as "not found".
function isResolverNotFoundError(err) {
  const msg = err?.message || '';
  const data = err?.info?.error?.data || err?.data || '';
  return (
    /ResolverNotFound|ResolverNotContract/i.test(msg) ||
    // ResolverNotFound(bytes) selector
    (typeof data === 'string' && data.startsWith('0x7199966d'))
  );
}

// Call the Universal Resolver's resolve(name, data). `callData` is the raw
// ABI-encoded call the resolver would have received directly (selector +
// args). Returns { bytes, resolverAddress } where `bytes` is the decoded
// inner return value of that call.
//
// CCIP-Read is opted into per-call here because ethers v6 doesn't enable it
// by default — needed for .box domains resolved via 3DNS.
async function universalResolverCall(provider, name, callData) {
  const ur = new ethers.Contract(UNIVERSAL_RESOLVER_ADDRESS, UR_ABI, provider);
  const encodedName = ethers.dnsEncode(name, 255);
  const [resolvedData, resolverAddress] = await ur.resolve(encodedName, callData, {
    enableCcipRead: true,
  });
  // UR returns the resolver's ABI-encoded response as `bytes`; unwrap it.
  const [bytes] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes'], resolvedData);
  return { bytes, resolverAddress };
}

// Batch multiple resolver lookups on the same ENS name through the UR.
// Each `callData` entry is a resolver function selector + args (e.g. addr
// + text + contenthash for a profile view). Returns an array of the
// per-call inner bytes, in order — each is the resolver's raw response
// that the caller can then ABI-decode for its specific return type.
//
// Unlike the single-call helper, this does not return the resolver
// address — the UR's resolveMulticall signature doesn't expose it.
async function universalResolverMulticall(provider, name, callDatas) {
  const ur = new ethers.Contract(UNIVERSAL_RESOLVER_ADDRESS, UR_ABI, provider);
  const encodedName = ethers.dnsEncode(name, 255);
  const results = await ur.resolveMulticall(encodedName, callDatas, {
    enableCcipRead: true,
  });
  const coder = ethers.AbiCoder.defaultAbiCoder();
  return results.map((r) => coder.decode(['bytes'], r)[0]);
}

async function resolveEnsContent(name) {
  return resolveWithCache(name, ensResultCache, doResolveEnsContent, 'content');
}

async function doResolveEnsContent(normalized) {
  const provider = await getWorkingProvider();
  const node = ethers.namehash(normalized);
  const callData = CONTENTHASH_SELECTOR + node.slice(2);

  let urResult;
  try {
    urResult = await universalResolverCall(provider, normalized, callData);
  } catch (err) {
    if (isProviderError(err)) throw err;
    if (isResolverNotFoundError(err)) {
      return cacheContentResult(normalized, {
        type: 'not_found',
        reason: 'NO_RESOLVER',
        name: normalized,
      });
    }
    // CCIP-Read gateway failures, resolver reverts, etc.
    log.info(`[ens] UR resolve failed for ${normalized}: ${err.message}`);
    return cacheContentResult(normalized, {
      type: 'not_found',
      reason: 'NO_CONTENTHASH',
      name: normalized,
      error: err.message,
    });
  }

  if (!urResult.bytes || urResult.bytes === '0x') {
    return cacheContentResult(normalized, {
      type: 'not_found',
      reason: 'EMPTY_CONTENTHASH',
      name: normalized,
    });
  }

  const parsed = parseContentHashBytes(urResult.bytes);
  if (!parsed) {
    log.warn(`[ens] UNSUPPORTED_CONTENTHASH_FORMAT for ${normalized}: ${urResult.bytes}`);
    return cacheContentResult(normalized, {
      type: 'unsupported',
      reason: 'UNSUPPORTED_CONTENTHASH_FORMAT',
      name: normalized,
      contentHash: urResult.bytes,
    });
  }

  return cacheContentResult(normalized, { type: 'ok', name: normalized, ...parsed });
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

// Shared validation + cache + retry wrapper for the content-hash and
// addr lookup paths. Both do the same thing: trim, lowercase, check the
// same-shape TTL cache, retry up to MAX_RESOLUTION_RETRIES on provider
// errors, invalidate the cached provider between attempts.
async function resolveWithCache(name, cache, doResolve, label) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('ENS name is empty');
  }
  const normalized = trimmed.toLowerCase();

  const cached = cache.get(normalized);
  if (cached && Date.now() - cached.timestamp < ENS_CACHE_TTL_MS) {
    log.info(`[ens] ${label} cache hit for ${normalized}`);
    return cached.result;
  }

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
}

async function doResolveEnsAddress(normalized) {
  const provider = await getWorkingProvider();
  const node = ethers.namehash(normalized);
  const callData = ADDR_SELECTOR + node.slice(2);

  let urResult;
  try {
    urResult = await universalResolverCall(provider, normalized, callData);
  } catch (err) {
    if (isProviderError(err)) throw err;
    if (isResolverNotFoundError(err)) {
      return cacheAddressResult(normalized, noAddressResult(normalized));
    }
    log.info(`[ens] UR addr resolve failed for ${normalized}: ${err.message}`);
    return cacheAddressResult(normalized, {
      success: false,
      name: normalized,
      reason: 'RESOLUTION_ERROR',
      error: err.message,
    });
  }

  if (!urResult.bytes || urResult.bytes === '0x') {
    return cacheAddressResult(normalized, noAddressResult(normalized));
  }

  let address;
  try {
    [address] = ethers.AbiCoder.defaultAbiCoder().decode(['address'], urResult.bytes);
  } catch (err) {
    log.warn(`[ens] Failed to decode addr bytes for ${normalized}: ${err.message}`);
    return cacheAddressResult(normalized, {
      success: false,
      name: normalized,
      reason: 'RESOLUTION_ERROR',
      error: err.message,
    });
  }

  if (address === ethers.ZeroAddress) {
    return cacheAddressResult(normalized, noAddressResult(normalized));
  }

  return cacheAddressResult(normalized, {
    success: true,
    name: normalized,
    address,
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
function cacheAndLog(cache, normalized, result, okValue) {
  cache.set(normalized, { result, timestamp: Date.now() });
  if (okValue) {
    log.info(`[ens] Resolved: ${normalized} → ${okValue}`);
  } else {
    log.info(`[ens] ${result.reason} for ${normalized}`);
  }
  return result;
}

// Resolve an address to its ENS primary name, forward-verifying the
// result. Conservative: returns { success: true, name } ONLY when the
// claimed reverse name resolves its own addr record back to the same
// address. Reverse records are user-set and spoofable; anyone can claim
// any name, so the forward-verify is the only way to trust the output.
async function resolveEnsReverse(address) {
  if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return {
      success: false,
      address,
      reason: 'INVALID_ADDRESS',
      error: `Invalid address: ${address}`,
    };
  }
  // Address is already validated — delegate cache/retry plumbing to the
  // shared helper. trim() + lowercase inside are no-ops on a canonical
  // lowercased 40-hex address.
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

  // Otherwise the reverse is spoofed or stale — reject.
  const forward = await resolveEnsAddress(claimedName);
  if (!forward.success || forward.address.toLowerCase() !== normalizedAddress.toLowerCase()) {
    return cacheReverseResult(normalizedAddress, {
      success: false,
      address: normalizedAddress,
      // Deliberately verbose key so a naive UI can't mistake it for the
      // verified name — callers reading `.claimedUnverifiedName` know it
      // failed forward-verify and must not render it as the recipient.
      claimedUnverifiedName: claimedName,
      reason: 'UNVERIFIED',
      error: `Reverse record ${claimedName} does not forward-verify to ${normalizedAddress}`,
    });
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

module.exports = {
  registerEnsIpc,
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  testRpcUrl,
  invalidateCachedProvider,
  universalResolverCall,
  universalResolverMulticall,
  isResolverNotFoundError,
};
