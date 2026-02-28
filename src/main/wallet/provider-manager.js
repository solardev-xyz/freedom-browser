/**
 * Provider Manager
 *
 * Manages ethers.js providers with fallback support for resilience.
 * Supports both public RPCs (for chains like Gnosis) and user-configured
 * RPC providers (for chains like Ethereum that require API keys).
 */

const { FallbackProvider, JsonRpcProvider } = require('ethers');
const { getChain, getAllChains } = require('./chains');
const { getEffectiveRpcUrls } = require('./rpc-manager');

// Cache providers by chain ID
const providerCache = new Map();

// Provider configuration
const PROVIDER_CONFIG = {
  stallTimeout: 2000, // Time before trying next provider (increased for public RPCs)
  quorum: 1, // Require only 1 provider to agree (for speed)
  retries: 2, // Number of retries for failed requests
  retryDelay: 500, // Delay between retries in ms
};

/**
 * Get RPC URLs for a chain
 * Uses public RPCs if available, otherwise uses configured provider URLs
 */
function getRpcUrlsForChain(chainId) {
  const chain = getChain(chainId);
  if (!chain) {
    return [];
  }

  // If chain has public RPCs, use those
  if (chain.hasPublicRpc && chain.rpcUrls && chain.rpcUrls.length > 0) {
    return chain.rpcUrls;
  }

  // Otherwise, get URLs from configured RPC providers
  return getEffectiveRpcUrls(chainId);
}

/**
 * Create a FallbackProvider for a given chain
 */
function createFallbackProvider(chainId) {
  const chain = getChain(chainId);
  if (!chain) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  const rpcUrls = getRpcUrlsForChain(chainId);

  if (rpcUrls.length === 0) {
    throw new Error(
      `No RPC endpoints available for ${chain.name}. ` +
        'Please configure an RPC provider (Alchemy, Infura, or DRPC) in Settings.'
    );
  }

  // Create providers from RPC URLs with priority
  const providers = rpcUrls.map((url, index) => ({
    provider: new JsonRpcProvider(url, chainId, {
      staticNetwork: true,
      batchMaxCount: 1, // Disable batching for public RPCs
    }),
    priority: index === 0 ? 1 : 2, // First URL has higher priority
    weight: index === 0 ? 2 : 1,
    stallTimeout: PROVIDER_CONFIG.stallTimeout,
  }));

  const fallbackProvider = new FallbackProvider(providers, chainId, {
    quorum: PROVIDER_CONFIG.quorum,
  });

  return fallbackProvider;
}

/**
 * Sleep helper for retries
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute a provider call with retry logic
 */
async function withRetry(fn, retries = PROVIDER_CONFIG.retries, chainId = null) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      console.warn(`[ProviderManager] Attempt ${attempt + 1} failed:`, err.message);

      // If we hit a server error (403, 429, etc.), the FallbackProvider may be in a bad state
      // Clear the cache so the next attempt creates fresh providers
      if (chainId && isServerError(err)) {
        console.warn(`[ProviderManager] Server error detected, clearing provider cache for chain ${chainId}`);
        providerCache.delete(chainId);
      }

      if (attempt < retries) {
        await sleep(PROVIDER_CONFIG.retryDelay * (attempt + 1)); // Exponential backoff
      }
    }
  }
  throw lastError;
}

/**
 * Check if an error is a server-side error (rate limit, blocked, etc.)
 */
function isServerError(err) {
  const msg = err.message || '';
  return (
    err.code === 'SERVER_ERROR' ||
    msg.includes('SERVER_ERROR') ||
    msg.includes('403') ||
    msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    msg.includes('rate limit') ||
    msg.includes('blocked') ||
    msg.includes('invalid numeric value') // FallbackProvider quorum error from bad response
  );
}

/**
 * Get or create a provider for a chain
 */
function getProvider(chainId) {
  if (!providerCache.has(chainId)) {
    try {
      const provider = createFallbackProvider(chainId);
      providerCache.set(chainId, provider);
    } catch (err) {
      console.error(`[ProviderManager] Failed to create provider for chain ${chainId}:`, err);
      return null;
    }
  }
  return providerCache.get(chainId);
}

/**
 * Clear provider cache (for testing or when RPC config changes)
 * @param {number|string} [chainId] - Optional chain ID to clear specific cache
 */
function clearProviderCache(chainId) {
  if (chainId !== undefined) {
    providerCache.delete(chainId);
    providerCache.delete(String(chainId));
    providerCache.delete(Number(chainId));
  } else {
    providerCache.clear();
  }
}

/**
 * Called when RPC provider API keys change
 * Clears all cached providers so they get recreated with new URLs
 */
function onApiKeysChanged() {
  console.log('[ProviderManager] API keys changed, clearing provider cache');
  providerCache.clear();
}

/**
 * Get providers for all supported chains
 */
function getAllProviders() {
  const result = {};
  for (const chain of getAllChains()) {
    result[chain.chainId] = getProvider(chain.chainId);
  }
  return result;
}

/**
 * Test provider connectivity
 */
async function testProvider(chainId) {
  const provider = getProvider(chainId);
  if (!provider) {
    return { success: false, error: 'No provider available' };
  }

  try {
    const blockNumber = await provider.getBlockNumber();
    return { success: true, blockNumber };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  getProvider,
  clearProviderCache,
  onApiKeysChanged,
  getAllProviders,
  testProvider,
  withRetry,
};
