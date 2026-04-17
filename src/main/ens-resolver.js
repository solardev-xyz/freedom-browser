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
];

// bytes4(keccak256("contenthash(bytes32)"))
const CONTENTHASH_SELECTOR = '0xbc1c4a73';

// ENS contenthash byte patterns (EIP-1577). We preserve the CIDv0 base58
// output ("QmFoo…") for IPFS/IPNS to stay byte-compatible with the
// previous ethers-based implementation — users' bookmarks and history
// entries keyed on the old URI form keep matching.
//   0xe3 01 70             — ipfs-ns, cidv1, dag-pb
//   0xe5 01 72             — ipns-ns, cidv1, libp2p-key
//   0xe4 01 01 fa 01 1b 20 — swarm-ns + manifest codec, 32-byte keccak
const IPFS_CONTENTHASH_RE = /^0x(e3010170|e5010172)(([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]*))$/;
const SWARM_CONTENTHASH_RE = /^0xe40101fa011b20([0-9a-f]{64})$/;

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

// Cache for working provider
let cachedProvider = null;
let cachedProviderUrl = null;

// Cache for ENS resolution results (name -> { result, timestamp })
const ENS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ensResultCache = new Map();

// Independent from ensResultCache so content and addr lookups don't evict each other.
const ensAddressCache = new Map();

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

async function resolveEnsContent(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('ENS name is empty');
  }

  // Basic normalization; full ENS nameprep is more complex but this is fine
  // for normal .eth and .box names.
  const normalized = trimmed.toLowerCase();
  log.info(`[ens] Resolving: ${normalized}`);

  // Check cache first
  const cached = ensResultCache.get(normalized);
  if (cached && Date.now() - cached.timestamp < ENS_CACHE_TTL_MS) {
    log.info(`[ens] Cache hit for ${normalized} → ${cached.result.uri || cached.result.reason}`);
    return cached.result;
  }

  // Retry loop for provider errors
  let lastError;
  for (let attempt = 1; attempt <= MAX_RESOLUTION_RETRIES; attempt++) {
    try {
      return await doResolveEnsContent(normalized, attempt);
    } catch (err) {
      lastError = err;
      if (isProviderError(err) && attempt < MAX_RESOLUTION_RETRIES) {
        log.warn(
          `[ens] Provider error on attempt ${attempt}/${MAX_RESOLUTION_RETRIES}: ${err.message}`
        );
        invalidateCachedProvider();
        // Continue to next attempt
      } else {
        // Not a provider error or out of retries - rethrow
        throw err;
      }
    }
  }

  // Should not reach here, but just in case
  throw lastError;
}

async function doResolveEnsContent(normalized, attempt) {
  const provider = await getWorkingProvider();
  const node = ethers.namehash(normalized);
  const callData = CONTENTHASH_SELECTOR + node.slice(2);

  log.info(
    `[ens] UR resolving content for: ${normalized}${attempt > 1 ? ` (attempt ${attempt})` : ''}`
  );

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
    const scheme = ipfs[1] === 'e3010170' ? 'ipfs' : 'ipns';
    const length = parseInt(ipfs[4], 16);
    if (ipfs[5].length === length * 2) {
      const decoded = ethers.encodeBase58('0x' + ipfs[2]);
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
    return {
      codec: 'swarm-ns',
      protocol: 'bzz',
      uri: `bzz://${swarm[1]}`,
      decoded: swarm[1],
    };
  }
  return null;
}

function cacheContentResult(normalized, result) {
  ensResultCache.set(normalized, { result, timestamp: Date.now() });
  if (result.type === 'ok') {
    log.info(`[ens] Resolved: ${normalized} → ${result.uri}`);
  } else {
    log.info(`[ens] ${result.reason} for ${normalized}`);
  }
  return result;
}

// Resolve an ENS name's primary ETH address (the `addr` record).
// Uses provider.resolveName() which handles resolver lookup, addr(bytes32),
// and CCIP-Read — so .eth, subdomains, and .box names all work via the
// same path as address-bar content resolution.
async function resolveEnsAddress(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    throw new Error('ENS name is empty');
  }

  const normalized = trimmed.toLowerCase();

  const cached = ensAddressCache.get(normalized);
  if (cached && Date.now() - cached.timestamp < ENS_CACHE_TTL_MS) {
    log.info(`[ens] Address cache hit for ${normalized} -> ${cached.address}`);
    return { success: true, name: normalized, address: cached.address };
  }

  let lastError;
  for (let attempt = 1; attempt <= MAX_RESOLUTION_RETRIES; attempt++) {
    try {
      const provider = await getWorkingProvider();
      log.info(
        `[ens] Resolving address record for: ${normalized}${attempt > 1 ? ` (attempt ${attempt})` : ''}`
      );

      const address = await provider.resolveName(normalized);

      if (!address) {
        return {
          success: false,
          name: normalized,
          reason: 'NO_ADDRESS',
          error: `No address record set for ${normalized}`,
        };
      }

      ensAddressCache.set(normalized, { address, timestamp: Date.now() });
      log.info(`[ens] Resolved address: ${normalized} -> ${address}`);
      return { success: true, name: normalized, address };
    } catch (err) {
      lastError = err;
      if (isProviderError(err) && attempt < MAX_RESOLUTION_RETRIES) {
        log.warn(
          `[ens] Address resolution provider error on attempt ${attempt}/${MAX_RESOLUTION_RETRIES}: ${err.message}`
        );
        invalidateCachedProvider();
        continue;
      }
      throw err;
    }
  }

  throw lastError;
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
}

module.exports = {
  registerEnsIpc,
  resolveEnsContent,
  resolveEnsAddress,
  testRpcUrl,
  invalidateCachedProvider,
  universalResolverCall,
  isResolverNotFoundError,
};
