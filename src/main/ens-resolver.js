const log = require('./logger');
const { ipcMain } = require('electron');
const { ethers } = require('ethers');
const { ens_normalize } = require('@adraffy/ens-normalize');
const IPC = require('../shared/ipc-channels');
const registry = require('./networks/network-registry');
const { UNAVAILABLE } = require('./core/naming-driver');
const { runWithPrivateLogContext, redactForLog } = require('./private/private-log-context');
const { isPrivateWebContents } = require('./private/private-windows');

// ENS, WNS and GNS names are resolved by the naming core (freedom-core
// design 0004): the lookups below go to its driver, which returns the
// core's results in the shapes the renderer, the wallet and the dweb
// protocol handlers read. What stays here is what main still needs around
// it: the configuration the core is sent (NamingConfig), the contract calls
// the verified adapters make for the core (naming-verified.js), the IPC
// handlers and the invalidation entry points.
//
// PRIVATE MODE GUARD (name logging): the name being resolved IS the
// browsing history of the tab that asked for it, and log lines land in the
// persistent <userData>/logs/main.log, which outlives the private window
// and the app. The IPC handlers mark their lookups private from
// event.sender, as the dweb protocol handlers do from their session (see
// src/main/private/private-log-context.js); the driver passes that on to
// the core, which logs no names. What is logged here goes through
// redactForLog.

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

// SLIP-0044 coin type for Ethereum mainnet, used by UR.reverse.
const ETH_COIN_TYPE = 60n;

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

// A settings edit (network-ipc): the registry re-reads its configuration,
// and the core takes the new snapshot with its providers reset: the RPC
// pool, quarantine, block anchor and resolution caches.
function invalidateCachedProvider() {
  registry.invalidate();
  require('./core/naming').namingSettingsChanged();
}

// The naming core's driver: every lookup goes to the core. Without one (the
// core not attached yet, or stopped for good), a lookup fails as the
// driver's own does when no core process serves it.
function namingDriver() {
  const driver = require('./core/naming').namingDriver();
  if (!driver) throw new Error(UNAVAILABLE);
  return driver;
}

// The core takes a name as a string (null and undefined as empty) and a
// finite chain ID. Anything else is refused here before any network, as the
// lookups have always refused it.
const isName = (name) => name == null || typeof name === 'string';

// A name that isn't a string: its trim throws, or it is empty.
function nameRefusal(name) {
  return (name || '').trim()
    ? new TypeError('ENS name must be a string')
    : new Error('ENS name is empty');
}

// The destination chains ENS has coin types for.
function checkChainId(chainId) {
  if (!Number.isSafeInteger(chainId) || chainId < 1 || chainId >= 0x80000000) {
    throw new Error('Invalid ENS destination chain ID');
  }
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

// ethers v6 stashes contract-revert data at either `.data` (newer wrappers)
// or `.info.error.data` (the JSON-RPC error envelope). One reader, used by
// every callsite that wants to inspect the revert payload.
function getRevertData(err) {
  const data = err?.data || err?.info?.error?.data || '';
  return typeof data === 'string' && data.length >= 10 ? data : null;
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

// Call the Universal Resolver's resolve(name, data). `callData` is the raw
// ABI-encoded call the resolver would have received directly (selector +
// args). Returns the raw ABI-encoded response — the caller must decode
// per their function's return type (e.g. decode(['bytes'], ...) for
// contenthash, or decode(['address'], ...) for addr). Returning pre-decoded
// bytes here would silently work for dynamic returns and overflow for
// static ones.
//
// CCIP-Read is opted into per-call here because ethers v6 doesn't enable it
// by default — needed for .box domains resolved via 3DNS. The verified
// adapters (Myotis, Colibri) call at "latest", where ethers follows an
// OffchainLookup itself, through their providers' bounded ccipReadFetch.
//
// `overrides` are merged into the call's overrides object. Callers that
// pass nothing get the default { enableCcipRead: true } shape.
async function callUniversalResolver(provider, method, args, overrides) {
  const ur = new ethers.Contract(UNIVERSAL_RESOLVER_ADDRESS, UR_ABI, provider);
  return ur[method](...args, { enableCcipRead: true, ...overrides });
}

async function universalResolverCall(provider, name, callData, overrides = {}) {
  const encodedName = ethers.dnsEncode(name, 255);
  const [resolvedData, resolverAddress] = await callUniversalResolver(
    provider,
    'resolve',
    [encodedName, callData],
    overrides
  );
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
// shape as the Universal Resolver path, so the core decodes both alike.
async function nameNftResolverCall(provider, name, callData, overrides = {}) {
  const nameSystem = nameSystemForName(name);
  if (!nameSystem.contractAddress) {
    throw new Error(`No NameNFT contract configured for ${nameSystem.label}`);
  }
  const selector = String(callData || '')
    .slice(0, 10)
    .toLowerCase();
  const node = nodeFromResolverCallData(callData);
  const registryContract = new ethers.Contract(nameSystem.contractAddress, NAME_NFT_ABI, provider);

  if (selector === CONTENTHASH_SELECTOR) {
    const contenthash = await registryContract.contenthash(node, overrides);
    return {
      resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(['bytes'], [contenthash || '0x']),
      resolverAddress: nameSystem.contractAddress,
    };
  }

  if (selector === ADDR_SELECTOR) {
    const address = await registryContract.addr(node, overrides);
    return {
      resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(
        ['address'],
        [address || ethers.ZeroAddress]
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
async function universalResolverReverse(
  provider,
  addressBytes,
  overrides = {},
  coinType = ETH_COIN_TYPE
) {
  const [name] = await callUniversalResolver(
    provider,
    'reverse',
    [addressBytes, coinType],
    overrides
  );
  return { name };
}

// NameNFT reverseResolve(address) adapter. `name` is a synthetic value with
// the target system's suffix (`reverse.wei`, `reverse.gwei`), which selects
// the contract to call.
async function nameNftReverseResolverCall(provider, name, callData, overrides = {}) {
  const nameSystem = nameSystemForName(name);
  if (!nameSystem.contractAddress) {
    throw new Error(`No NameNFT contract configured for ${nameSystem.label}`);
  }
  const [address] = NAME_NFT_INTERFACE.decodeFunctionData('reverseResolve', callData);
  const registryContract = new ethers.Contract(nameSystem.contractAddress, NAME_NFT_ABI, provider);
  const claimedName = await registryContract.reverseResolve(address, overrides);
  return {
    resolvedData: ethers.AbiCoder.defaultAbiCoder().encode(['string'], [claimedName || '']),
    resolverAddress: nameSystem.contractAddress,
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function getDirectRpcCandidate(chainId) {
  const cid = String(chainId);
  const [url] = registry.getEndpoints(chainId, 'rpc');
  if (!url) return { url: null, userConfigured: false };

  const source = registry
    .getEndpointSources(chainId, 'rpc')
    .find((src) => !src.keyed && src.coverage?.[cid] === url);
  const sourceMeta = source
    ? registry.getEndpointSourceList().find((src) => src.id === source.id)
    : null;
  return {
    url,
    userConfigured: !!sourceMeta && !sourceMeta.builtin && !sourceMeta.removed && !sourceMeta.keyed,
  };
}

const RESOLUTION_METHOD_IDS = new Set(['myotis', 'colibri', 'quorum', 'direct']);

function resolutionPolicy(network) {
  const verification = network?.verification || {};
  const configured = Array.isArray(verification.order)
    ? verification.order.filter(
        (method, index, all) => RESOLUTION_METHOD_IDS.has(method) && all.indexOf(method) === index
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

async function resolveEnsContent(name) {
  if (!isName(name)) throw nameRefusal(name);
  return namingDriver().resolveContent(name ?? '');
}

async function resolveEnsAddress(name, chainId = 1) {
  if (!isName(name) || !Number.isFinite(chainId)) {
    checkChainId(chainId);
    throw nameRefusal(name);
  }
  return namingDriver().resolveAddress(name ?? '', chainId);
}

// ENS normalization (UTS-46 / ENSIP-15) through @adraffy/ens-normalize, not
// a bare .toLowerCase(): a unicode name's namehash depends on its canonical
// form. Pure-ASCII names (the vast majority — vitalik.eth, app.eth, …)
// survive `ens_normalize` unchanged beyond a lowercase, so they skip the full
// pass. Invalid labels throw. The driver names a lookup's subject with it, as
// the core's errors do.
const PURE_ASCII_HOST = /^[a-z0-9-.]+$/;

function fastNormalize(trimmed) {
  const lowered = trimmed.toLowerCase();
  if (PURE_ASCII_HOST.test(lowered)) return lowered;
  return ens_normalize(trimmed);
}

// Resolve an address to its primary name. The UR verifies the reverse
// record forward-resolves back to the input address, so a successful
// result is a trusted name; spoofed or stale reverses surface as UNVERIFIED.
async function resolveEnsReverse(address, chainId = 1) {
  if (typeof address !== 'string' || !Number.isFinite(chainId)) {
    if (typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return {
        success: false,
        address,
        reason: 'INVALID_ADDRESS',
        error: `Invalid address: ${address}`,
      };
    }
    checkChainId(chainId);
  }
  return namingDriver().resolveReverse(address, chainId);
}

// PRIVATE MODE GUARD (name logging): a name typed in a private window's
// address bar reaches the resolver through these handlers, so they are the
// point where the sender's private-ness is still known. Marking the async
// subtree redacts every downstream log site, and the driver tells the core
// with each lookup. The resolution itself is unchanged.
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
    const { name, chainId = 1 } = payload;
    return runWithPrivateLogContext(privateResolveContext(event), async () => {
      try {
        return await resolveEnsAddress(name, chainId);
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
    const { address, chainId = 1 } = payload;
    return runWithPrivateLogContext(privateResolveContext(event), async () => {
      try {
        return await resolveEnsReverse(address, chainId);
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
    return runWithPrivateLogContext(privateResolveContext(event), () => invalidateEnsContent(name));
  });
}

// Drop the core's contenthash cache entry for `name`: whether an entry was
// evicted. Nothing is cached without a core, nor for a name that isn't a
// string.
function invalidateEnsContent(name) {
  const driver = require('./core/naming').namingDriver();
  if (!driver || !isName(name)) return false;
  return driver.invalidateContent(name ?? '');
}

// Drop every cached resolution: the core clears its content, address and
// reverse caches and starts the lookups in flight again, as a Myotis
// transition does. Tests call it to share ENS names across cases without
// cross-pollution.
function clearEnsResolutionCaches() {
  require('./core/naming').namingCachesCleared();
}

module.exports = {
  registerEnsIpc,
  // The naming core's configuration reads them.
  getEffectiveRpcEndpoints,
  getDirectRpcCandidate,
  resolutionPolicy,
  resolveEnsContent,
  resolveEnsAddress,
  resolveEnsReverse,
  invalidateCachedProvider,
  invalidateEnsContent,
  // The verified adapters' contract calls (myotis-resolver, colibri-resolver,
  // naming-verified).
  universalResolverCall,
  universalResolverReverse,
  // The naming core's driver names a subject as the core's errors do.
  fastNormalize,
  nameNftResolverCall,
  nameNftReverseResolverCall,
  isResolverNotFoundError,
  clearEnsResolutionCaches,
  hostOf,
};
