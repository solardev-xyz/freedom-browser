/**
 * Network configuration IPC.
 *
 * Bridges the settings UI (the Networks page + the ENS lens) to the
 * network registry: reads the merged config, applies mutations, and
 * manages keyed-provider API keys. After a mutation the downstream
 * provider/ENS caches are dropped so a config change takes effect
 * without a restart.
 */

const { ipcMain, webContents } = require('electron');
const IPC = require('../../shared/ipc-channels');
const registry = require('./network-registry');
const chainCatalog = require('./chain-catalog');
const tokenRegistry = require('../token-registry');
const rpcManager = require('../wallet/rpc-manager');
const { loadSettings } = require('../settings-store');

function broadcastNetworkConfigUpdated() {
  if (!webContents?.getAllWebContents) return;
  const payload = { ...loadSettings(), networkConfigUpdated: true };
  for (const wc of webContents.getAllWebContents()) {
    try {
      wc.send(IPC.SETTINGS_UPDATED, payload);
    } catch {
      // webContents may be destroyed
    }
  }
}

// registry.invalidate() already ran inside the mutation; this also drops
// the caches that sit downstream of the registry — the wallet provider
// pool and the ENS resolver pool — so the change is reflected live.
function refreshDownstream() {
  require('../wallet/provider-manager').clearProviderCache();
  require('../ens-resolver').invalidateCachedProvider();
  broadcastNetworkConfigUpdated();
}

function refreshAfterRpcManagerMutation(result) {
  if (result?.success) refreshDownstream();
  return result;
}

// The full config view: every network plus every endpoint source, with
// keyed providers tagged by whether an API key is configured.
function getConfig() {
  const sources = registry.getEndpointSourceList().map((src) =>
    src.keyed ? { ...src, hasKey: rpcManager.hasApiKey(src.id) } : src
  );
  return { networks: registry.getAllNetworks(), sources };
}

function normalizeChainForStorage(chain) {
  const nativeSymbol = chain?.nativeCurrency?.symbol || chain?.nativeSymbol;
  return nativeSymbol && !chain?.nativeSymbol
    ? { ...chain, nativeSymbol }
    : chain;
}

function nativeTokenForChain(chain, chainId) {
  const nativeCurrency = chain?.nativeCurrency || {};
  const symbol = String(nativeCurrency.symbol || chain?.nativeSymbol || '').trim();
  if (!symbol) return null;

  const decimals = Number(nativeCurrency.decimals);
  return {
    chainId: Number(chainId),
    address: null,
    symbol,
    name: String(nativeCurrency.name || symbol).trim() || symbol,
    decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 18,
  };
}

function registerNetworkConfigIpc() {
  ipcMain.handle('networks:get-config', () => {
    return { success: true, ...getConfig() };
  });

  ipcMain.handle('networks:update-network', (_event, chainId, patch) => {
    registry.updateNetwork(chainId, patch);
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:upsert-source', (_event, id, source) => {
    const result = registry.upsertEndpointSource(id, source);
    if (result?.success === false) return result;
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:remove-source', (_event, id) => {
    registry.removeEndpointSource(id);
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:restore-source', (_event, id) => {
    registry.restoreEndpointSource(id);
    refreshDownstream();
    return { success: true };
  });

  ipcMain.handle('networks:reset-source-coverage', (_event, id, chainId) => {
    const result = registry.resetEndpointSourceCoverage(id, chainId);
    if (result?.success === false) return result;
    refreshDownstream();
    return { success: true };
  });

  // API keys for keyed providers. rpc-manager clears wallet providers;
  // refreshDownstream also drops ENS caches so trust state follows the
  // effective endpoint list immediately.
  ipcMain.handle('networks:set-api-key', (_event, providerId, apiKey) => {
    return refreshAfterRpcManagerMutation(rpcManager.setApiKey(providerId, apiKey));
  });

  ipcMain.handle('networks:remove-api-key', (_event, providerId) => {
    return refreshAfterRpcManagerMutation(rpcManager.removeApiKey(providerId));
  });

  ipcMain.handle('networks:test-api-key', (_event, providerId, apiKey) => {
    return rpcManager.testApiKey(providerId, apiKey);
  });

  // The chainlist.org catalog backing the add-chain search. Both handlers
  // can hit the network, so they report failure as { success: false }
  // rather than rejecting.
  ipcMain.handle('networks:search-chains', async (_event, query) => {
    try {
      return { success: true, chains: await chainCatalog.searchChains(query) };
    } catch (err) {
      return { success: false, error: err.message || 'Chain catalog unavailable' };
    }
  });

  ipcMain.handle('networks:get-catalog-chain', async (_event, chainId) => {
    try {
      const chain = await chainCatalog.getCatalogChain(chainId);
      return chain
        ? { success: true, chain }
        : { success: false, error: 'Chain not found in catalog' };
    } catch (err) {
      return { success: false, error: err.message || 'Chain catalog unavailable' };
    }
  });

  // The chain set — the wallet and dapp provider read chains from here.
  ipcMain.handle('networks:get-chains', () => {
    return { success: true, chains: registry.getAllNetworks() };
  });

  ipcMain.handle('networks:get-chain', (_event, chainId) => {
    const chain = registry.getNetwork(chainId);
    return chain ? { success: true, chain } : { success: false, error: 'Chain not found' };
  });

  ipcMain.handle('networks:get-available-chains', () => {
    return { success: true, chains: registry.getAvailableChains() };
  });

  ipcMain.handle('networks:is-chain-available', (_event, chainId) => {
    return { success: true, available: registry.isChainAvailable(chainId) };
  });

  ipcMain.handle('networks:add-chain', (_event, chain, rpcUrls) => {
    const normalizedChain = normalizeChainForStorage(chain);
    const result = registry.addCustomChain(normalizedChain, rpcUrls || []);
    if (result.success) {
      // Register the chain's native asset so the wallet fetches its
      // balance — balances iterate token entries, and a custom chain
      // has none otherwise. Best-effort: a chain with no currency
      // symbol simply gets no native token.
      const nativeToken = nativeTokenForChain(normalizedChain, result.chainId);
      if (nativeToken) tokenRegistry.addCustomToken(nativeToken);
      refreshDownstream();
    }
    return result;
  });

  ipcMain.handle('networks:remove-chain', (_event, chainId) => {
    const result = registry.removeCustomChain(chainId);
    if (result.success) {
      tokenRegistry.removeCustomToken(tokenRegistry.getTokenKey(Number(chainId), null));
      refreshDownstream();
    }
    return result;
  });

  console.log('[NetworkConfig] IPC handlers registered');
}

module.exports = { registerNetworkConfigIpc };
