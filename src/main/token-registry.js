/**
 * Token Registry
 *
 * Builtin + user-added ERC-20 token metadata, keyed by `chainId:address`
 * (`chainId:native` for a chain's native asset). Chains themselves live
 * in the network registry — this module owns only tokens.
 */

const { app, ipcMain } = require('electron');
const { getFreedomDataPath } = require('./freedom-root');
const path = require('path');
const fs = require('fs');

// Builtin + custom tokens, merged once on first use. This module is the
// only writer of custom-tokens.json and addCustomToken/removeCustomToken
// patch this map in step with the file, so there is no invalidate path.
let tokens = {};
let initialized = false;

function getBuiltinTokensPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar', 'src', 'shared', 'tokens.json');
  }
  return path.join(__dirname, '..', 'shared', 'tokens.json');
}

function getCustomTokensPath() {
  return getFreedomDataPath('custom-tokens.json');
}

// An absent file is expected (custom-tokens.json until the user adds one);
// only genuine read/parse errors are logged.
function loadJsonFile(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[TokenRegistry] Failed to load ${filePath}:`, err.message);
    }
    return fallback;
  }
}

// Keep in sync with normalizeTokenKey in src/renderer/lib/wallet/funding-actions.js.
// Lowercase the address part of a token key on load + on lookup so
// EIP-55 checksum-cased keys in tokens.json match the lowercase asset
// addresses that `tupleFromAccept` (and any other normalized lookup
// path) emits. Ethereum addresses are case-insensitive on the wire;
// EIP-55 is a hex-only display convention and shouldn't drive
// downstream string compares.
function normalizeTokenKey(rawKey) {
  const colon = rawKey.indexOf(':');
  if (colon < 0) return rawKey;
  const chain = rawKey.slice(0, colon);
  const addr = rawKey.slice(colon + 1);
  return `${chain}:${addr.toLowerCase()}`;
}

function initRegistry() {
  if (initialized) return;
  const builtinTokens = loadJsonFile(getBuiltinTokensPath(), {});
  const customTokens = loadJsonFile(getCustomTokensPath(), {});
  const merged = { ...builtinTokens, ...customTokens };
  tokens = {};
  for (const [rawKey, value] of Object.entries(merged)) {
    tokens[normalizeTokenKey(rawKey)] = value;
  }
  initialized = true;
  console.log(`[TokenRegistry] Initialized with ${Object.keys(tokens).length} tokens`);
}

function saveCustomTokens(customTokens) {
  try {
    fs.writeFileSync(getCustomTokensPath(), JSON.stringify(customTokens, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('[TokenRegistry] Failed to save custom tokens:', err);
    return false;
  }
}

// All tokens, or — when a chainId is given — only that chain's tokens.
function getTokens(chainId = null) {
  initRegistry();
  if (chainId === null) return { ...tokens };
  const filtered = {};
  for (const [key, token] of Object.entries(tokens)) {
    if (token.chainId === chainId) filtered[key] = token;
  }
  return filtered;
}

function getToken(key) {
  initRegistry();
  return tokens[key] || null;
}

function getTokenKey(chainId, address) {
  return address ? `${chainId}:${address.toLowerCase()}` : `${chainId}:native`;
}

function addCustomToken(token) {
  initRegistry();
  if (!token.chainId) return { success: false, error: 'Chain ID is required' };
  if (!token.symbol) return { success: false, error: 'Token symbol is required' };

  const key = getTokenKey(token.chainId, token.address);
  const builtinTokens = loadJsonFile(getBuiltinTokensPath(), {});
  if (builtinTokens[key]) return { success: false, error: 'Cannot override built-in token' };

  const customTokens = loadJsonFile(getCustomTokensPath(), {});
  customTokens[key] = { ...token, builtin: false };
  if (!saveCustomTokens(customTokens)) {
    return { success: false, error: 'Failed to save custom token' };
  }
  tokens[key] = customTokens[key];
  return { success: true, token: tokens[key], key };
}

function removeCustomToken(key) {
  initRegistry();
  const builtinTokens = loadJsonFile(getBuiltinTokensPath(), {});
  if (builtinTokens[key]) return { success: false, error: 'Cannot remove built-in token' };

  const customTokens = loadJsonFile(getCustomTokensPath(), {});
  if (!customTokens[key]) return { success: false, error: 'Custom token not found' };
  delete customTokens[key];
  if (!saveCustomTokens(customTokens)) {
    return { success: false, error: 'Failed to save changes' };
  }
  delete tokens[key];
  return { success: true };
}

function registerTokenRegistryIpc() {
  ipcMain.handle('tokens:get-tokens', (_event, chainId) => {
    return { success: true, tokens: getTokens(chainId) };
  });

  ipcMain.handle('tokens:get-token', (_event, key) => {
    const token = getToken(key);
    return token ? { success: true, token } : { success: false, error: 'Token not found' };
  });

  ipcMain.handle('tokens:add-token', (_event, token) => addCustomToken(token));

  ipcMain.handle('tokens:remove-token', (_event, key) => removeCustomToken(key));

  console.log('[TokenRegistry] IPC handlers registered');
}

module.exports = {
  initRegistry,
  getTokens,
  getToken,
  getTokenKey,
  addCustomToken,
  removeCustomToken,
  registerTokenRegistryIpc,
};
