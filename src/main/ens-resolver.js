const log = require('./logger');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const IPC = require('../shared/ipc-channels');
const { success, failure } = require('./ipc-contract');
const { loadSettings } = require('./settings-store');

// Public RPC providers as fallbacks
const PUBLIC_RPC_PROVIDERS = [
  process.env.ETH_RPC,
  'https://ethereum.publicnode.com',
  'https://1rpc.io/eth',
  'https://eth.drpc.org',
  'https://eth-mainnet.public.blastapi.io',
  'https://eth.merkle.io',
].filter(Boolean);

// Custom RPC URL from settings (prepended to provider list when set)
let customRpcUrl = '';

// Build the effective provider list: custom RPC first (if set), then public fallbacks
function getRpcProviders() {
  if (customRpcUrl) {
    return [customRpcUrl, ...PUBLIC_RPC_PROVIDERS];
  }
  return PUBLIC_RPC_PROVIDERS;
}

// Load custom RPC URL from settings
function loadCustomRpcUrl() {
  try {
    const settings = loadSettings();
    const newUrl = (settings.ensRpcUrl || '').trim();
    if (newUrl !== customRpcUrl) {
      log.info(`[ens] Custom RPC URL changed: "${customRpcUrl}" -> "${newUrl}"`);
      customRpcUrl = newUrl;
      invalidateCachedProvider();
    }
  } catch (err) {
    log.warn(`[ens] Failed to load custom RPC setting: ${err.message}`);
  }
}

// Cache for working provider
let cachedProvider = null;
let cachedProviderUrl = null;

// Cache for ENS resolution results (name -> { result, timestamp })
const ENS_CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ensResultCache = new Map();

// Get a working provider, trying each in sequence with fallback
async function getWorkingProvider() {
  // Re-read custom RPC setting on each resolution attempt
  loadCustomRpcUrl();

  // Return cached provider if still working
  if (cachedProvider && cachedProviderUrl) {
    try {
      await cachedProvider.getBlockNumber();
      log.info(`[ens] Reusing cached provider: ${cachedProviderUrl}`);
      return cachedProvider;
    } catch {
      log.warn(`[ens] Cached provider ${cachedProviderUrl} failed, trying fallbacks...`);
      // Destroy failed provider to stop its background retry loop
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
      // Cache the working provider
      cachedProvider = provider;
      cachedProviderUrl = rpcUrl;
      return provider;
    } catch (err) {
      log.warn(`[ens] Provider ${providerNum} failed: ${err.message}`);
      // Destroy failed provider to stop its background retry loop
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

  // Use ethers.js built-in resolver which handles CCIP-Read (EIP-3668) automatically.
  // This is required for .box domains which use offchain resolution via 3dns.xyz.
  log.info(
    `[ens] Getting resolver for: ${normalized}${attempt > 1 ? ` (attempt ${attempt})` : ''}`
  );
  const resolver = await provider.getResolver(normalized);

  if (!resolver) {
    log.info(`[ens] No resolver found for: ${normalized}`);
    const result = {
      type: 'not_found',
      reason: 'NO_RESOLVER',
      name: normalized,
    };
    ensResultCache.set(normalized, { result, timestamp: Date.now() });
    return result;
  }

  log.info(`[ens] Getting content hash for: ${normalized}`);
  let contentHash;
  try {
    // getContentHash() handles CCIP-Read and returns formatted URI like "ipfs://Qm..." or "bzz://..."
    contentHash = await resolver.getContentHash();
  } catch (err) {
    // Re-throw provider errors so they trigger retry logic
    if (isProviderError(err)) {
      throw err;
    }
    // CCIP-Read failures or missing contenthash
    log.info(`[ens] Failed to get content hash for ${normalized}: ${err.message}`);
    const result = {
      type: 'not_found',
      reason: 'NO_CONTENTHASH',
      name: normalized,
      error: err.message,
    };
    ensResultCache.set(normalized, { result, timestamp: Date.now() });
    return result;
  }

  if (!contentHash) {
    log.info(`[ens] Empty content hash for: ${normalized}`);
    const result = {
      type: 'not_found',
      reason: 'EMPTY_CONTENTHASH',
      name: normalized,
    };
    ensResultCache.set(normalized, { result, timestamp: Date.now() });
    return result;
  }

  // ethers.js getContentHash() returns formatted URIs like:
  // - "ipfs://QmHash" or "ipfs://bafyHash"
  // - "ipns://name"
  // - "bzz://hash"
  // Parse the protocol and decoded value from the URI
  log.info(`[ens] Raw content hash for ${normalized}: ${contentHash}`);
  let result;
  const match = contentHash.match(/^([a-z]+):\/\/(.+)$/i);

  if (!match) {
    log.warn(`[ens] Unsupported content hash format for ${normalized}: ${contentHash}`);
    result = {
      type: 'unsupported',
      reason: `UNSUPPORTED_CONTENTHASH_FORMAT`,
      name: normalized,
      contentHash,
    };
    ensResultCache.set(normalized, { result, timestamp: Date.now() });
    return result;
  }

  const [, protocol, decoded] = match;
  const protocolLower = protocol.toLowerCase();

  if (protocolLower === 'bzz' || protocolLower === 'swarm') {
    result = {
      type: 'ok',
      name: normalized,
      codec: 'swarm-ns',
      protocol: 'bzz',
      uri: `bzz://${decoded}`,
      decoded,
    };
  } else if (protocolLower === 'ipfs') {
    result = {
      type: 'ok',
      name: normalized,
      codec: 'ipfs-ns',
      protocol: 'ipfs',
      uri: `ipfs://${decoded}`,
      decoded,
    };
  } else if (protocolLower === 'ipns') {
    result = {
      type: 'ok',
      name: normalized,
      codec: 'ipns-ns',
      protocol: 'ipns',
      uri: `ipns://${decoded}`,
      decoded,
    };
  } else {
    log.warn(`[ens] Unsupported protocol for ${normalized}: ${protocol}`);
    result = {
      type: 'unsupported',
      reason: `UNSUPPORTED_PROTOCOL (${protocol})`,
      name: normalized,
      protocol,
      decoded,
    };
  }

  if (result.type === 'ok') {
    log.info(`[ens] Resolved: ${normalized} → ${result.uri}`);
  }
  ensResultCache.set(normalized, { result, timestamp: Date.now() });
  return result;
}

// Test an RPC URL by connecting and fetching the block number
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
}

module.exports = {
  registerEnsIpc,
  resolveEnsContent,
  testRpcUrl,
  // Exposed for testing
  _setCustomRpcUrl(url) {
    customRpcUrl = url;
    invalidateCachedProvider();
  },
  _getCustomRpcUrl() {
    return customRpcUrl;
  },
};
