/**
 * Chain Registry
 *
 * Centralized registry for blockchain chains and tokens.
 * Supports built-in chains/tokens and user-added custom entries.
 */

const { app, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// Lazy-loaded to avoid circular dependencies
let rpcManager = null;
function getRpcManager() {
  if (!rpcManager) {
    rpcManager = require('./wallet/rpc-manager');
  }
  return rpcManager;
}

// Registry state
let chains = {};
let tokens = {};
let initialized = false;

// File paths
function getBuiltinChainsPath() {
  // In development, use src/shared
  // In production, use resources
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'src', 'shared', 'chains.json');
  }
  return path.join(__dirname, '..', 'shared', 'chains.json');
}

function getBuiltinTokensPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'src', 'shared', 'tokens.json');
  }
  return path.join(__dirname, '..', 'shared', 'tokens.json');
}

function getCustomChainsPath() {
  return path.join(app.getPath('userData'), 'custom-chains.json');
}

function getCustomTokensPath() {
  return path.join(app.getPath('userData'), 'custom-tokens.json');
}

/**
 * Initialize the registry by loading all data
 */
function initRegistry() {
  if (initialized) return;

  try {
    // Load builtin data
    const builtinChains = loadJsonFile(getBuiltinChainsPath(), {});
    const builtinTokens = loadJsonFile(getBuiltinTokensPath(), {});

    // Load custom data
    const customChains = loadJsonFile(getCustomChainsPath(), {});
    const customTokens = loadJsonFile(getCustomTokensPath(), {});

    // Merge (custom overrides builtin)
    chains = { ...builtinChains, ...customChains };
    tokens = { ...builtinTokens, ...customTokens };

    initialized = true;
    console.log(
      `[ChainRegistry] Initialized with ${Object.keys(chains).length} chains, ${Object.keys(tokens).length} tokens`
    );
  } catch (err) {
    console.error('[ChainRegistry] Failed to initialize:', err);
    // Use empty objects as fallback
    chains = {};
    tokens = {};
    initialized = true;
  }
}

/**
 * Load JSON file with fallback
 */
function loadJsonFile(filePath, fallback = {}) {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    }
  } catch (err) {
    console.error(`[ChainRegistry] Failed to load ${filePath}:`, err.message);
  }
  return fallback;
}

/**
 * Save custom chains to file
 */
function saveCustomChains(customChains) {
  try {
    const filePath = getCustomChainsPath();
    fs.writeFileSync(filePath, JSON.stringify(customChains, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[ChainRegistry] Failed to save custom chains:', err);
    return false;
  }
}

/**
 * Save custom tokens to file
 */
function saveCustomTokens(customTokens) {
  try {
    const filePath = getCustomTokensPath();
    fs.writeFileSync(filePath, JSON.stringify(customTokens, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[ChainRegistry] Failed to save custom tokens:', err);
    return false;
  }
}

/**
 * Get all chains
 */
function getChains() {
  initRegistry();
  return { ...chains };
}

/**
 * Get a specific chain by ID
 */
function getChain(chainId) {
  initRegistry();
  return chains[chainId] || null;
}

/**
 * Get all tokens, optionally filtered by chain ID
 */
function getTokens(chainId = null) {
  initRegistry();

  if (chainId === null) {
    return { ...tokens };
  }

  // Filter by chain ID
  const filtered = {};
  for (const [key, token] of Object.entries(tokens)) {
    if (token.chainId === chainId) {
      filtered[key] = token;
    }
  }
  return filtered;
}

/**
 * Get a specific token by key
 */
function getToken(key) {
  initRegistry();
  return tokens[key] || null;
}

/**
 * Generate token key from chainId and address
 */
function getTokenKey(chainId, address) {
  if (!address) {
    return `${chainId}:native`;
  }
  return `${chainId}:${address}`;
}

/**
 * Add a custom chain
 */
function addCustomChain(chain) {
  initRegistry();

  if (!chain.chainId) {
    return { success: false, error: 'Chain ID is required' };
  }

  const chainId = chain.chainId.toString();

  // Check if it's a builtin chain
  const builtinChains = loadJsonFile(getBuiltinChainsPath(), {});
  if (builtinChains[chainId]) {
    return { success: false, error: 'Cannot override built-in chain' };
  }

  // Load current custom chains and add new one
  const customChains = loadJsonFile(getCustomChainsPath(), {});
  customChains[chainId] = {
    ...chain,
    chainId: parseInt(chainId),
    builtin: false,
  };

  if (!saveCustomChains(customChains)) {
    return { success: false, error: 'Failed to save custom chain' };
  }

  // Update in-memory registry
  chains[chainId] = customChains[chainId];

  return { success: true, chain: chains[chainId] };
}

/**
 * Add a custom token
 */
function addCustomToken(token) {
  initRegistry();

  if (!token.chainId) {
    return { success: false, error: 'Chain ID is required' };
  }

  if (!token.symbol) {
    return { success: false, error: 'Token symbol is required' };
  }

  const key = getTokenKey(token.chainId, token.address);

  // Check if it's a builtin token
  const builtinTokens = loadJsonFile(getBuiltinTokensPath(), {});
  if (builtinTokens[key]) {
    return { success: false, error: 'Cannot override built-in token' };
  }

  // Load current custom tokens and add new one
  const customTokens = loadJsonFile(getCustomTokensPath(), {});
  customTokens[key] = {
    ...token,
    builtin: false,
  };

  if (!saveCustomTokens(customTokens)) {
    return { success: false, error: 'Failed to save custom token' };
  }

  // Update in-memory registry
  tokens[key] = customTokens[key];

  return { success: true, token: tokens[key], key };
}

/**
 * Remove a custom chain
 */
function removeCustomChain(chainId) {
  initRegistry();

  const chainIdStr = chainId.toString();

  // Check if it's a builtin chain
  const builtinChains = loadJsonFile(getBuiltinChainsPath(), {});
  if (builtinChains[chainIdStr]) {
    return { success: false, error: 'Cannot remove built-in chain' };
  }

  // Load and update custom chains
  const customChains = loadJsonFile(getCustomChainsPath(), {});
  if (!customChains[chainIdStr]) {
    return { success: false, error: 'Custom chain not found' };
  }

  delete customChains[chainIdStr];

  if (!saveCustomChains(customChains)) {
    return { success: false, error: 'Failed to save changes' };
  }

  // Update in-memory registry
  delete chains[chainIdStr];

  return { success: true };
}

/**
 * Remove a custom token
 */
function removeCustomToken(key) {
  initRegistry();

  // Check if it's a builtin token
  const builtinTokens = loadJsonFile(getBuiltinTokensPath(), {});
  if (builtinTokens[key]) {
    return { success: false, error: 'Cannot remove built-in token' };
  }

  // Load and update custom tokens
  const customTokens = loadJsonFile(getCustomTokensPath(), {});
  if (!customTokens[key]) {
    return { success: false, error: 'Custom token not found' };
  }

  delete customTokens[key];

  if (!saveCustomTokens(customTokens)) {
    return { success: false, error: 'Failed to save changes' };
  }

  // Update in-memory registry
  delete tokens[key];

  return { success: true };
}

/**
 * Check if a chain is available for use
 * A chain is available if:
 * - It has public RPCs (hasPublicRpc: true), OR
 * - User has configured an RPC provider that supports this chain
 * @param {number|string} chainId - Chain ID
 * @returns {boolean}
 */
function isChainAvailable(chainId) {
  initRegistry();
  const chain = chains[chainId];
  if (!chain) return false;

  // Chain has public RPCs - always available
  if (chain.hasPublicRpc) {
    return true;
  }

  // Check if any configured provider supports this chain
  const rpc = getRpcManager();
  const providerUrls = rpc.getEffectiveRpcUrls(chainId);
  return providerUrls.length > 0;
}

/**
 * Get all available chains (chains that can actually be used)
 * @returns {Object} Map of chainId -> chain config
 */
function getAvailableChains() {
  initRegistry();
  const available = {};
  for (const [chainId, chain] of Object.entries(chains)) {
    if (isChainAvailable(chainId)) {
      available[chainId] = chain;
    }
  }
  return available;
}

/**
 * Register IPC handlers
 */
function registerChainRegistryIpc() {
  ipcMain.handle('chain-registry:get-chains', () => {
    return { success: true, chains: getChains() };
  });

  ipcMain.handle('chain-registry:get-tokens', (_event, chainId) => {
    return { success: true, tokens: getTokens(chainId) };
  });

  ipcMain.handle('chain-registry:get-chain', (_event, chainId) => {
    const chain = getChain(chainId);
    if (!chain) {
      return { success: false, error: 'Chain not found' };
    }
    return { success: true, chain };
  });

  ipcMain.handle('chain-registry:get-token', (_event, key) => {
    const token = getToken(key);
    if (!token) {
      return { success: false, error: 'Token not found' };
    }
    return { success: true, token };
  });

  ipcMain.handle('chain-registry:add-chain', (_event, chain) => {
    return addCustomChain(chain);
  });

  ipcMain.handle('chain-registry:add-token', (_event, token) => {
    return addCustomToken(token);
  });

  ipcMain.handle('chain-registry:remove-chain', (_event, chainId) => {
    return removeCustomChain(chainId);
  });

  ipcMain.handle('chain-registry:remove-token', (_event, key) => {
    return removeCustomToken(key);
  });

  ipcMain.handle('chain-registry:get-available-chains', () => {
    return { success: true, chains: getAvailableChains() };
  });

  ipcMain.handle('chain-registry:is-chain-available', (_event, chainId) => {
    return { success: true, available: isChainAvailable(chainId) };
  });

  console.log('[ChainRegistry] IPC handlers registered');
}

module.exports = {
  initRegistry,
  getChains,
  getChain,
  getTokens,
  getToken,
  getTokenKey,
  addCustomChain,
  addCustomToken,
  removeCustomChain,
  removeCustomToken,
  isChainAvailable,
  getAvailableChains,
  registerChainRegistryIpc,
};
