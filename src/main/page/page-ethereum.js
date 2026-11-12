'use strict';

/**
 * The Ethereum dispatcher for page requests (freedom-core design 0011, "The
 * dispatcher"; step PRQ-3: the reads).
 *
 * The chrome's `dapp-provider.js` answered these methods for a page; main
 * now answers them itself, from the attested requester
 * (`page-documents.js`), with the same answers:
 *
 *   - `eth_chainId` and `net_version`: an onchain app's own chain (the
 *     record's `chain`, from its committed `web3://` URL), or else the chain
 *     the page's window selected (`wallet/selected-chain.js`), or else
 *     Gnosis. Permission-free: nothing of the key is read.
 *   - `eth_accounts`: the account the key's grant exposes, or `[]`. A
 *     document with no key gets `[]` and reads no grant. Name-revalidated:
 *     for a DNS name over IPNS, main resolves the name again before it reads
 *     the grant and again after its last wait, and a name that no longer
 *     answers the document's IPNS key answers `[]` and ends the binding.
 *   - The other 23 read-only methods: a read through the core on the same
 *     chain, with the key as the router's routing hint (`origin`), and the
 *     chrome's error text when the chain has no RPC provider.
 *     Permission-free: the key as it stands, with no resolution.
 *
 * Every method answers `4900` while the Identity & Wallet switch is off,
 * as the chrome did. The chrome's own path for these methods stays until
 * PRQ-9 removes it, but the preload no longer sends pages' requests there.
 */

const { ETHEREUM_RPC_READS } = require('./page-methods');

// What the chrome's getCurrentChainId falls back to: Gnosis.
const FALLBACK_CHAIN_ID = 100;

const DISCONNECTED = Object.freeze({ code: 4900, message: 'Disconnected' });
const INVALID_PARAMS = Object.freeze({ code: -32602, message: 'Invalid parameters' });
const INTERNAL_ERROR_CODE = -32603;

/** The methods this dispatcher serves: PRQ-3's reads. */
const ETHEREUM_READ_METHODS = Object.freeze(['eth_chainId', 'net_version', 'eth_accounts', ...ETHEREUM_RPC_READS]);

function defaultDependencies() {
  return {
    identityWalletEnabled: () => require('../settings-store').loadSettings()?.enableIdentityWallet === true,
    selectedChainOf: (windowId) => require('../wallet/selected-chain').selectedChainOf(windowId),
    getPermission: (key) => require('../wallet/dapp-permissions').getPermission(key),
    getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
    chainRequest: (chainId, method, params, options) =>
      require('../networks/chain-data').request(chainId, method, params, options),
    isChainAvailable: (chainId) => require('../networks/network-registry').isChainAvailable(chainId),
    chainName: (chainId) => require('../networks/network-registry').getAllNetworks()?.[chainId]?.name,
  };
}

/** True for a value the JSON for the core carries at its own size. */
function holdsBinary(params) {
  // The size walk has already bounded the request (10,000 values, 32
  // levels) and taken only its own types, so this walk is bounded too.
  const stack = [params];
  while (stack.length > 0) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
    if (Array.isArray(value)) {
      for (const item of value) stack.push(item);
    } else {
      for (const name in value) {
        if (Object.prototype.hasOwnProperty.call(value, name)) stack.push(value[name]);
      }
    }
  }
  return false;
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 * @returns {Record<string, (context: object) => Promise<object>>} the
 *   dispatchers, keyed `ethereum:<method>`, for `createPageRequests`.
 */
function createEthereumDispatchers(deps = {}) {
  const {
    identityWalletEnabled,
    selectedChainOf,
    getPermission,
    getDerivedWallets,
    chainRequest,
    isChainAvailable,
    chainName,
  } = { ...defaultDependencies(), ...deps };

  // The chain this page reads: what the chrome's getCurrentChainId answered.
  function chainIdOf(requester) {
    if (Number.isSafeInteger(requester.chain) && requester.chain > 0) return requester.chain;
    let selected;
    try {
      selected = selectedChainOf(requester.window);
    } catch {
      selected = null;
    }
    return Number.isSafeInteger(selected) && selected > 0 ? selected : FALLBACK_CHAIN_ID;
  }

  const hex = (chainId) => `0x${chainId.toString(16)}`;

  async function accounts(context) {
    const { requester } = context;
    if (!requester.key) return [];
    // Name-revalidated: before the grant is read, and after the last wait;
    // and the account goes out only while the document holds the name.
    const keyless = { keyless: { result: [] } };
    if (!(await context.nameHolds(keyless))) return [];
    const permission = getPermission(requester.key);
    if (!permission) return [];
    let wallets;
    try {
      const listed = await getDerivedWallets();
      wallets = Array.isArray(listed) ? listed : [];
    } catch {
      wallets = [];
    }
    const wallet = wallets.find((candidate) => candidate?.index === permission.walletIndex);
    if (!wallet) return [];
    if (!(await context.nameHolds(keyless))) return [];
    return [wallet.address];
  }

  // The chrome's proxyRpcCall: its message for a chain with no provider.
  function readError(err, chainId) {
    const code = err?.code || INTERNAL_ERROR_CODE;
    let message = (typeof err?.message === 'string' && err.message) || `All chain sources failed for chain ${chainId}`;
    try {
      if (isChainAvailable(chainId) === false) {
        const name = chainName(chainId);
        message = `${name || `Chain ${chainId}`} requires an RPC provider. Please configure one in Settings.`;
      }
    } catch {
      // Keep the router's own message if the registry can't say.
    }
    const error = { code, message };
    if (err?.data !== undefined) error.data = err.data;
    return error;
  }

  async function read(context) {
    const { requester, method } = context;
    const chainId = chainIdOf(requester);
    const params = context.params || [];
    // JSON would carry a byte as up to 13 characters of an object's keys:
    // no read takes binary data, so none reaches the JSON.
    if (holdsBinary(params)) return { error: { ...INVALID_PARAMS } };
    // The core's request is serialized as JSON in this call, before it
    // returns: the copy the request's charge pays for.
    context.copied('ethereum:chain-request');
    try {
      const response = await chainRequest(chainId, method, params, {
        routingContext: { origin: requester.key },
      });
      return { result: response?.result };
    } catch (err) {
      return { error: readError(err, chainId) };
    }
  }

  const serve = (answer) => async (context) => {
    if (!identityWalletEnabled()) return { error: { ...DISCONNECTED } };
    return answer(context);
  };

  const dispatchers = {
    'ethereum:eth_chainId': serve(async ({ requester }) => ({ result: hex(chainIdOf(requester)) })),
    'ethereum:net_version': serve(async ({ requester }) => ({ result: String(chainIdOf(requester)) })),
    'ethereum:eth_accounts': serve(async (context) => ({ result: await accounts(context) })),
  };
  for (const method of ETHEREUM_RPC_READS) dispatchers[`ethereum:${method}`] = serve(read);
  return dispatchers;
}

module.exports = {
  ETHEREUM_READ_METHODS,
  FALLBACK_CHAIN_ID,
  createEthereumDispatchers,
};
