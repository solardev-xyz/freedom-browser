/**
 * Chain Configuration
 *
 * Provides chain utilities and metadata, sourcing base data from the network registry.
 * Also provides additional metadata not stored in the registry (contracts, nativeCurrency structure).
 */

const {
  getAllNetworks: getRegistryChains,
  getNetwork: getRegistryChain,
} = require('../networks/network-registry');

// Additional chain metadata not in the registry
// (contracts, supportsHelios, etc.)
const ETHER_NATIVE_CURRENCY = { name: 'Ether', symbol: 'ETH', decimals: 18 };

const CHAIN_METADATA = {
  1: {
    nativeCurrency: ETHER_NATIVE_CURRENCY,
    supportsHelios: true,
  },
  100: {
    nativeCurrency: {
      name: 'xDAI',
      symbol: 'xDAI',
      decimals: 18,
    },
    supportsHelios: false,
    contracts: {
      bzzToken: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
      postageStamp: '0x30d155478eF27Ab32A1D578BE7b84BC5988B2b4a',
      staking: '0x781c6D1f0eaE6F1Da1F604c6cDCcdB8B76428ba7',
      priceOracle: '0x0FDc5429C50e2a39066D8A94F3e2D2476fcc3b85',
    },
  },
  8453: {
    nativeCurrency: ETHER_NATIVE_CURRENCY,
    supportsHelios: false,
  },
};

// Default chain
const DEFAULT_CHAIN_ID = 1;

/**
 * Get chain configuration by ID (merges registry + metadata)
 */
function getChain(chainId) {
  const registryChain = getRegistryChain(chainId);
  if (!registryChain) return null;

  const metadata = CHAIN_METADATA[chainId] || {};

  // Build nativeCurrency from registry if not in metadata
  const nativeCurrency = metadata.nativeCurrency || {
    name: registryChain.nativeSymbol,
    symbol: registryChain.nativeSymbol,
    decimals: 18,
  };

  return {
    ...registryChain,
    ...metadata,
    nativeCurrency,
  };
}

/**
 * Get all supported chains
 */
function getAllChains() {
  const registryChains = getRegistryChains();
  return Object.keys(registryChains).map((chainId) => getChain(parseInt(chainId)));
}

/**
 * Check if a chain is supported
 */
function isChainSupported(chainId) {
  return getRegistryChain(chainId) !== null;
}

/**
 * Convert chain ID to hex
 */
function toChainIdHex(chainId) {
  return '0x' + chainId.toString(16);
}

/**
 * Convert hex chain ID to number
 */
function toChainIdNumber(chainIdHex) {
  return parseInt(chainIdHex, 16);
}

/**
 * Get block explorer URL for an address
 */
function getAddressExplorerUrl(chainId, address) {
  const chain = getChain(chainId);
  if (!chain) return null;
  return `${chain.blockExplorer}/address/${address}`;
}

/**
 * Get block explorer URL for a transaction
 */
function getTxExplorerUrl(chainId, txHash) {
  const base = getChain(chainId)?.blockExplorer;
  if (typeof base !== 'string' || base !== base.trim() || !/^https?:\/\//i.test(base)) return null;
  try {
    const url = new URL(base);
    if (!url.hostname || url.username || url.password || base.includes('?') || base.includes('#'))
      return null;
  } catch {
    return null;
  }
  return `${base}/tx/${txHash}`;
}

module.exports = {
  CHAIN_METADATA,
  DEFAULT_CHAIN_ID,
  getChain,
  getAllChains,
  isChainSupported,
  toChainIdHex,
  toChainIdNumber,
  getAddressExplorerUrl,
  getTxExplorerUrl,
};
