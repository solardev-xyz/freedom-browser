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
 * Connecting (PRQ-4):
 *
 *   - `eth_requestAccounts`: a tab the agent holds is answered by the agent
 *     service, as through the chrome before. A connected site gets its
 *     account. Otherwise main prompts (`eth.connect`, held while its tab is
 *     in the background) and, on the user's approval, writes the grant
 *     itself, for the requester's key: the account the user picked, and the
 *     chain the page reads. Name-revalidated: the name is resolved again
 *     before the grant is read and again after the prompt, and the grant is
 *     written only while the document still holds it (`holdsKey`, just
 *     before the write). A name that has moved gets no grant.
 *   - `wallet_switchEthereumChain`: a chain the registry knows and has a
 *     source for. Main writes the grant's chain, selects the chain for the
 *     page's window (`wallet/selected-chain.js`, which tells the chrome) and
 *     sends `chainChanged`, but never to an onchain app, which keeps its own
 *     chain. Name-revalidated: after the name has moved, it is refused with
 *     nothing changed.
 *
 * Signing (PRQ-5a, `page-signing.js`): `personal_sign` and
 * `eth_signTypedData_v4`, from every account kind, a Safe's messages
 * included. Main reads the site's signing rule itself, with Agent custody
 * read live, prompts otherwise (`eth.sign`), and mints and spends the
 * approval's token with its own issuer.
 *
 * Sending (PRQ-5b, `page-sends.js`): `eth_sendTransaction`, from every
 * account kind, a Safe account's included. Main reads the site's contract
 * rule itself, with Agent custody read live and the fee check's verdict,
 * prompts otherwise (`eth.send`, and a Safe's signing board after it), and
 * mints and spends the approval's token (`dapp-send`, or a `safe-send` for
 * the site) with its own issuer.
 *
 * A document with no key is refused all three, as the chrome refused them:
 * "This page has no address to connect from yet".
 *
 * Every method answers `4900` while the Identity & Wallet switch is off,
 * as the chrome did. The chrome's own path for these methods stays until
 * PRQ-9 removes it, but the preload no longer sends pages' requests there.
 */

const { ETHEREUM_RPC_READS } = require('./page-methods');
const { SIGNING_METHODS, createSigningDispatchers } = require('./page-signing');
const { SEND_METHODS, createSendDispatchers } = require('./page-sends');

// What the chrome's getCurrentChainId falls back to: Gnosis.
const FALLBACK_CHAIN_ID = 100;

const DISCONNECTED = Object.freeze({ code: 4900, message: 'Disconnected' });
const INVALID_PARAMS = Object.freeze({ code: -32602, message: 'Invalid parameters' });
const INTERNAL_ERROR_CODE = -32603;
const USER_REJECTED = Object.freeze({ code: 4001, message: 'User rejected the request' });
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
const UNSUPPORTED = Object.freeze({ code: 4200, message: 'Method not supported' });
const CHAIN_NOT_ADDED = Object.freeze({ code: 4902, message: 'Unrecognized chain ID' });
const GRANT_FAILED = Object.freeze({ code: INTERNAL_ERROR_CODE, message: 'Failed to save the connection' });
const ACCOUNT_GONE = Object.freeze({ code: INTERNAL_ERROR_CODE, message: 'The selected account is no longer available' });

// v1 Safes live on Gnosis: one whose contract isn't there yet can't serve a
// dApp, and isn't offered (the chrome's `safeNotConnectable`).
const GNOSIS_CHAIN_ID = 100;

/** The methods this dispatcher serves: PRQ-3's reads. */
const ETHEREUM_READ_METHODS = Object.freeze(['eth_chainId', 'net_version', 'eth_accounts', ...ETHEREUM_RPC_READS]);

/** And PRQ-4's: connecting. */
const ETHEREUM_CONNECT_METHODS = Object.freeze(['eth_requestAccounts', 'wallet_switchEthereumChain']);

/** And PRQ-5a's: messages and typed data. */
const ETHEREUM_SIGNING_METHODS = SIGNING_METHODS;

/** And PRQ-5b's: sends. */
const ETHEREUM_SEND_METHODS = SEND_METHODS;

/** Every method main's Ethereum dispatcher serves, and so the preload routes to main. */
const ETHEREUM_PAGE_METHODS = Object.freeze([
  ...ETHEREUM_READ_METHODS,
  ...ETHEREUM_CONNECT_METHODS,
  ...ETHEREUM_SIGNING_METHODS,
  ...ETHEREUM_SEND_METHODS,
]);

// How main reaches the agent service for a tab it holds (index.js sets it
// once the agent runtime exists): `(guestId, request, { signal, attested,
// beforeEffect, effectAllowed }) => ({ handled, result, error })`,
// `{ handled: false }` for a tab the agent doesn't hold.
let agentWalletRoute = null;

/** index.js: the agent service's wallet route, for the tabs it holds. */
function setAgentWalletRoute(route) {
  agentWalletRoute = typeof route === 'function' ? route : null;
}

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
    networks: () => require('../networks/network-registry').getAllNetworks() || {},
    getActiveWalletIndex: () => require('../identity-manager').getActiveWalletIndex(),
    grantPermission: (key, walletIndex, chainId) =>
      require('../wallet/dapp-permissions').grantPermission(key, walletIndex, chainId),
    updateLastUsed: (key, chainId) => require('../wallet/dapp-permissions').updateLastUsed(key, chainId),
    selectChainForPage: (windowId, chainId) =>
      require('../wallet/selected-chain').selectChainForPage(windowId, chainId),
    agentWalletRequest: async (guestId, request, options) =>
      (agentWalletRoute ? agentWalletRoute(guestId, request, options) : { handled: false }),
  };
}

/** Whether a wallet record can serve a dApp: an undeployed Safe can't. */
function connectable(wallet) {
  if (!wallet || !Number.isInteger(wallet.index)) return false;
  if (wallet.type === 'safe') return Boolean(wallet.deployed?.[GNOSIS_CHAIN_ID]);
  return true;
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
  const signingDeps = deps.signing || {};
  const sendDeps = deps.sends || {};
  const {
    identityWalletEnabled,
    selectedChainOf,
    getPermission,
    getDerivedWallets,
    chainRequest,
    isChainAvailable,
    chainName,
    networks,
    getActiveWalletIndex,
    grantPermission,
    updateLastUsed,
    selectChainForPage,
    agentWalletRequest,
  } = { ...defaultDependencies(), ...deps };

  // The chain a window's pages read, but its onchain apps.
  function windowChainOf(windowId) {
    let selected;
    try {
      selected = selectedChainOf(windowId);
    } catch {
      selected = null;
    }
    return Number.isSafeInteger(selected) && selected > 0 ? selected : FALLBACK_CHAIN_ID;
  }

  // The chain this page reads: what the chrome's getCurrentChainId answered.
  function chainIdOf(requester) {
    if (Number.isSafeInteger(requester.chain) && requester.chain > 0) return requester.chain;
    return windowChainOf(requester.window);
  }

  const hex = (chainId) => `0x${chainId.toString(16)}`;

  async function walletList() {
    try {
      const listed = await getDerivedWallets();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  async function accounts(context) {
    const { requester } = context;
    if (!requester.key) return [];
    // Name-revalidated: before the grant is read, and after the last wait;
    // and the account goes out only while the document holds the name.
    const keyless = { keyless: { result: [] } };
    if (!(await context.nameHolds(keyless))) return [];
    const permission = getPermission(requester.key);
    if (!permission) return [];
    const wallets = await walletList();
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

  // A tab the agent holds: the agent service answers, with its own
  // approval, as it did through the chrome (`offerAgentWalletRequest`).
  // Custody is read live, at this request. The agent's approval runs inside
  // the request's life (`walletOperation`): it holds the document's one
  // wallet slot, it is withdrawn when main answers the request (its
  // deadline, its document gone), and the grant the agent writes waits on
  // main: the request still open, the name checked again, and the document
  // still holding the key in the same run as the write. The agent acts
  // under the attested key, which for a DNS name over IPNS is the name.
  async function agentAnswer(context, keyless) {
    const { requester, method, params } = context;
    const operation = await context.walletOperation(async ({ signal, open }) => {
      try {
        return await agentWalletRequest(
          requester.guest,
          { method, params, chainId: chainIdOf(requester) },
          {
            signal,
            attested: { key: requester.key, transportKey: requester.transportKey },
            beforeEffect: async () => open() && (await context.nameHolds(keyless)) && open(),
            effectAllowed: () => open() && context.holdsKey(),
          }
        );
      } catch {
        return null;
      }
    });
    if (operation.error) return { error: operation.error };
    const outcome = operation.done;
    if (!outcome || typeof outcome !== 'object' || outcome.handled !== true) return null;
    return outcome.error ? { error: outcome.error } : { result: outcome.result };
  }

  // The prompt's view: main's own wallet state (design 0011, "What a prompt
  // shows"). Only accounts that can serve a dApp are offered; the default
  // is the active one, or the first that can.
  function connectView(wallets, requester) {
    const offered = wallets.filter(connectable).map((wallet) => ({
      index: wallet.index,
      name: typeof wallet.name === 'string' ? wallet.name : '',
      address: typeof wallet.address === 'string' ? wallet.address : null,
      type: typeof wallet.type === 'string' ? wallet.type : 'mnemonic',
    }));
    let active;
    try {
      active = getActiveWalletIndex();
    } catch {
      active = null;
    }
    const defaultIndex = offered.some((wallet) => wallet.index === active) ? active : (offered[0]?.index ?? null);
    const chainId = chainIdOf(requester);
    let name;
    try {
      name = chainName(chainId) || null;
    } catch {
      name = null;
    }
    return { accounts: offered, defaultIndex, chain: { id: chainId, name } };
  }

  // The grant's events (today's, from the chrome's connect): the account to
  // every live document of the key, `connect` to the one that asked.
  async function announceConnection(context, account, chainId) {
    const { requester } = context;
    const others = context
      .liveDocuments()
      .filter((doc) => doc.key === requester.key && !(doc.guest === requester.guest && doc.navigation === requester.navigation));
    await context.sendEvent(requester, 'accountsChanged', [account]);
    await context.sendEvent(requester, 'connect', { chainId: hex(chainId) });
    for (const doc of others) await context.sendEvent(doc, 'accountsChanged', [account]);
  }

  async function requestAccounts(context) {
    const { requester } = context;
    if (!requester.key) return { error: { ...NO_ADDRESS } };
    // Name-revalidated: before the key is first used (the agent's route
    // included), after every wait, and the document must hold the key at
    // the write itself.
    const keyless = { keyless: { error: { ...NO_ADDRESS } } };
    if (!(await context.nameHolds(keyless))) return { error: { ...NO_ADDRESS } };
    const agent = await agentAnswer(context, keyless);
    // A name that moved meanwhile answers as a keyless document's would.
    if (agent) return context.holdsKey() ? agent : { error: { ...NO_ADDRESS } };
    if (!(await context.nameHolds(keyless))) return { error: { ...NO_ADDRESS } };
    const permission = getPermission(requester.key);
    if (permission) {
      const wallet = (await walletList()).find((candidate) => candidate?.index === permission.walletIndex);
      if (!(await context.nameHolds(keyless)) || !context.holdsKey()) return { error: { ...NO_ADDRESS } };
      updateLastUsed(requester.key);
      return { result: wallet?.address ? [wallet.address] : [] };
    }
    const view = connectView(await walletList(), requester);
    const offered = new Set(view.accounts.map((wallet) => wallet.index));
    const decision = await context.prompt({
      kind: 'eth.connect',
      view,
      // The one thing the user picks: which offered account, and nothing
      // else.
      choices: (raw) =>
        Object.keys(raw).every((name) => name === 'walletIndex') &&
        Number.isInteger(raw.walletIndex) &&
        offered.has(raw.walletIndex)
          ? { walletIndex: raw.walletIndex }
          : null,
    });
    if (decision.error) return { error: decision.error };
    // Closed some other way: main has answered the record already, or
    // answers nothing to a document that has gone.
    if (decision.closed || decision.approve !== true) return { error: { ...USER_REJECTED } };
    const chosen = (await walletList()).find(
      (wallet) => wallet?.index === decision.choices.walletIndex && connectable(wallet)
    );
    if (!chosen?.address) return { error: { ...ACCOUNT_GONE } };
    if (!(await context.nameHolds(keyless)) || !context.holdsKey()) return { error: { ...NO_ADDRESS } };
    const chainId = chainIdOf(requester);
    try {
      grantPermission(requester.key, chosen.index, chainId);
    } catch {
      return { error: { ...GRANT_FAILED } };
    }
    context.afterAnswer(() => announceConnection(context, chosen.address, chainId));
    return { result: [chosen.address] };
  }

  async function switchChain(context) {
    const { requester, params } = context;
    if (!requester.key) return { error: { ...NO_ADDRESS } };
    // Today's checks and answers (`handleSwitchChain`), in its order.
    if (!params || !params[0] || !params[0].chainId) return { error: { ...INVALID_PARAMS } };
    // As the chrome parsed it, but only from a string or a number: an object
    // from the page names no chain.
    const raw = params[0].chainId;
    const requested = typeof raw === 'string' || typeof raw === 'number' ? parseInt(raw, 16) : NaN;
    const pinned = Number.isSafeInteger(requester.chain) && requester.chain > 0 ? requester.chain : null;
    if (pinned && requested !== pinned) {
      return { error: { ...UNSUPPORTED, message: `This onchain application is pinned to chain ${pinned}.` } };
    }
    let known;
    try {
      known = networks()?.[requested];
    } catch {
      known = null;
    }
    if (!known) return { error: { ...CHAIN_NOT_ADDED } };
    let available;
    try {
      available = isChainAvailable(requested);
    } catch {
      available = false;
    }
    if (!available) {
      return {
        error: {
          code: 4902,
          message: `${known.name} requires an RPC provider. Please configure Alchemy, Infura, or DRPC in Settings.`,
        },
      };
    }
    // Name-revalidated: nothing changes once the name has moved off its
    // IPNS key, neither the grant's chain nor the window's.
    if (!(await context.nameHolds()) || !context.holdsKey()) return { error: { ...NO_ADDRESS } };
    const previous = windowChainOf(requester.window);
    if (getPermission(requester.key)) updateLastUsed(requester.key, requested);
    selectChainForPage(requester.window, requested);
    // The page that asked hears it first, as from the chrome, unless it is
    // an onchain app, which keeps its own chain.
    if (!pinned) await context.sendEvent(requester, 'chainChanged', hex(requested));
    // The chain changed for every other page of the window too, but the
    // onchain apps.
    if (previous !== requested) {
      const others = context
        .liveDocuments()
        .filter(
          (doc) =>
            doc.window === requester.window &&
            !doc.chain &&
            !(doc.guest === requester.guest && doc.navigation === requester.navigation)
        );
      for (const doc of others) await context.sendEvent(doc, 'chainChanged', hex(requested));
    }
    return { result: null };
  }

  const serve = (answer) => async (context) => {
    if (!identityWalletEnabled()) return { error: { ...DISCONNECTED } };
    return answer(context);
  };

  const dispatchers = {
    'ethereum:eth_chainId': serve(async ({ requester }) => ({ result: hex(chainIdOf(requester)) })),
    'ethereum:net_version': serve(async ({ requester }) => ({ result: String(chainIdOf(requester)) })),
    'ethereum:eth_accounts': serve(async (context) => ({ result: await accounts(context) })),
    'ethereum:eth_requestAccounts': serve(requestAccounts),
    'ethereum:wallet_switchEthereumChain': serve(switchChain),
  };
  for (const method of ETHEREUM_RPC_READS) dispatchers[`ethereum:${method}`] = serve(read);
  const signing = createSigningDispatchers(
    { getPermission, updateLastUsed, walletList, chainIdOf, chainName, networks, agentAnswer },
    signingDeps
  );
  for (const [route, dispatch] of Object.entries(signing)) dispatchers[route] = serve(dispatch);
  const sends = createSendDispatchers(
    { getPermission, updateLastUsed, walletList, chainIdOf, chainName, networks, agentAnswer },
    sendDeps
  );
  for (const [route, dispatch] of Object.entries(sends)) dispatchers[route] = serve(dispatch);
  return dispatchers;
}

module.exports = {
  ETHEREUM_READ_METHODS,
  ETHEREUM_CONNECT_METHODS,
  ETHEREUM_SIGNING_METHODS,
  ETHEREUM_SEND_METHODS,
  ETHEREUM_PAGE_METHODS,
  FALLBACK_CHAIN_ID,
  createEthereumDispatchers,
  setAgentWalletRoute,
};
