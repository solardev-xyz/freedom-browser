/**
 * EVM chain catalog.
 *
 * chainlist.org publishes the ethereum-lists/chains data as a flat array
 * of chains, each with its RPC endpoints, native currency, and explorer.
 * The add-chain search reads from here. The catalog is cached on disk so
 * search works offline and doesn't re-download a ~2 MB file on every use.
 *
 * This module normally runs inside `chain-catalog-worker.js` (#503 item 12):
 * parsing and re-serializing the ~2.3 MB catalog, and filtering it per
 * keystroke, is kept off Electron's main thread — `chain-catalog-host.js` is
 * what the IPC handlers call. The worker passes the cache path and a log
 * sink through `configure()`; with no configuration (the host's main-thread
 * fallback, unit tests) it uses Electron's userData and the main logger.
 */

const path = require('node:path');
const fs = require('node:fs');

const CATALOG_URL = 'https://chainlist.org/rpcs.json';
const CACHE_FILE = 'chain-catalog.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 30_000;
const MAX_SEARCH_RESULTS = 50;

let configuredCachePath = null;
let configuredLog = null;

// Electron and the main logger are only required when nothing was
// configured: neither is usable from a worker thread.
function cachePath() {
  if (configuredCachePath) return configuredCachePath;
  return path.join(require('electron').app.getPath('userData'), CACHE_FILE);
}

function logError(message) {
  (configuredLog || require('../logger')).error(message);
}

function configure({ cachePath: file = null, log = null } = {}) {
  configuredCachePath = file;
  configuredLog = log;
}

// In-memory copy of the on-disk cache: { fetchedAt, chains }.
let memo = null;
// A single shared promise while a network fetch is in flight, so a burst
// of searches (e.g. search-as-you-type) triggers only one download.
let inFlight = null;

function isFresh(entry) {
  return entry && Date.now() - entry.fetchedAt < TTL_MS;
}

function readDiskCache() {
  try {
    const entry = JSON.parse(fs.readFileSync(cachePath(), 'utf-8'));
    return Array.isArray(entry.chains) ? entry : null;
  } catch {
    return null;
  }
}

async function fetchCatalog() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const chains = await res.json();
    if (!Array.isArray(chains)) throw new Error('catalog is not an array');
    return chains;
  } finally {
    clearTimeout(timer);
  }
}

// The chain array, refreshed from the network when the cache is stale.
// A failed refresh falls back to a stale cache rather than failing — a
// day-old chain list is far better than none.
async function loadCatalog() {
  if (isFresh(memo)) return memo.chains;

  const cached = memo || readDiskCache();
  if (isFresh(cached)) {
    memo = cached;
    return cached.chains;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const chains = await fetchCatalog();
      memo = { fetchedAt: Date.now(), chains };
      try {
        fs.writeFileSync(cachePath(), JSON.stringify(memo), 'utf-8');
      } catch (err) {
        logError(`[chain-catalog] failed to write cache: ${err.message}`);
      }
      return chains;
    } catch (err) {
      logError(`[chain-catalog] fetch failed: ${err.message}`);
      if (cached) {
        memo = cached;
        return cached.chains;
      }
      throw err;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// RPC URLs from a catalog entry that Freedom can use as-is: plain https
// endpoints with no API-key placeholder, deduplicated.
function usableRpcUrls(chain) {
  const seen = new Set();
  const out = [];
  for (const entry of chain.rpc || []) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (!url || !url.startsWith('https://') || url.includes('${')) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

function slimChain(chain) {
  return {
    chainId: chain.chainId,
    name: chain.name,
    currency: chain.nativeCurrency?.symbol || null,
    isTestnet: !!chain.isTestnet,
    rpcCount: usableRpcUrls(chain).length,
  };
}

// Search by name, short name, or exact chainId. An empty query returns
// the highest-TVL chains so the picker opens on the chains a user is
// most likely to want.
async function searchChains(query) {
  const chains = await loadCatalog();
  const q = String(query || '').trim().toLowerCase();

  if (!q) {
    return [...chains]
      .sort((a, b) => (b.tvl || 0) - (a.tvl || 0))
      .slice(0, MAX_SEARCH_RESULTS)
      .map(slimChain);
  }

  const hits = chains.filter(
    (c) =>
      String(c.chainId) === q ||
      c.name?.toLowerCase().includes(q) ||
      c.shortName?.toLowerCase().includes(q)
  );
  return hits.slice(0, MAX_SEARCH_RESULTS).map(slimChain);
}

// The full, normalized record for one chain — only the fields Freedom
// needs to register it. null when the catalog has no such chain.
async function getCatalogChain(chainId) {
  const chains = await loadCatalog();
  const chain = chains.find((c) => c.chainId === Number(chainId));
  if (!chain) return null;
  return {
    chainId: chain.chainId,
    name: chain.name,
    nativeCurrency: chain.nativeCurrency || null,
    rpcUrls: usableRpcUrls(chain),
    explorerUrl: chain.explorers?.[0]?.url || null,
    isTestnet: !!chain.isTestnet,
  };
}

module.exports = { CACHE_FILE, configure, searchChains, getCatalogChain };
