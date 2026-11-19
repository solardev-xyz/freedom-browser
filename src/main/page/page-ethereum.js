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
 * as the chrome did. The chrome has no path of its own for them (PRQ-9).
 *
 * The identity core's dispatcher (design 0012, APB-4a): with a `relay`
 * (`page-eip1193.js`, which main's own dispatchers get), the reads, the
 * connect and the switch go to the core's `eip1193.request`, and the core
 * asks main for the connect's prompt, the document's recheck and the
 * switch's selection. Main keeps what the core doesn't hold: the agent's
 * route for a tab it holds, a DNS name's resolution over IPNS (before the
 * key is used and after the last wait, as above), a new grant's events,
 * and binary params refused before any JSON. The routes above stay the
 * reference until APB-4d removes them.
 *
 * The signatures go to the core as well (APB-4b): the core shows its own
 * `eth.sign` prompt through main, or a rule answers it (with a locked
 * vault's `vault.unlock` first), and signs a vault account's itself. A
 * Ledger's, a phone's or a Safe's comes back as `{ device }`, which main
 * spends as its own route did (`page-devices.js`). Main keeps the agent's
 * route for a tab it holds, and checks the name again after the signature,
 * withholding it from a document whose name moved.
 *
 * And the sends (APB-4c): the core prepares the send (its estimate and its
 * own fee quote), asks its `eth.send` prompt through main or answers it by
 * the site's rule (a locked vault's `vault.unlock` first), and answers main
 * `{ send }` (a vault account's) or `{ device }` (a Ledger's, a phone's or
 * a Safe's). Main takes the site's turn, adds the nonce, has the core sign
 * or the device sign, records the send and broadcasts it
 * (`page-core-sends.js`). Main keeps the agent's route for a tab it holds,
 * the transaction's form checked first as on its own route, and a DNS
 * name's checks: before the key is used, after the agent's route, and in
 * the send's turn just before the signature and after a signer's wait.
 */

const { ETHEREUM_RPC_READS } = require('./page-methods');
const { SIGNING_METHODS, createSigningDispatchers, guestInCustody } = require('./page-signing');
const { createDeviceSigning } = require('./page-devices');
const { SEND_METHODS, createSendDispatchers, txOf, agentTxOf } = require('./page-sends');
const { createCoreSends } = require('./page-core-sends');

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
// beforeEffect, effectAllowed, grantWritten, pageContext, pageToken }) => ({ handled,
// result, error })`,
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
    // The dApp grants, which the identity core writes for a page's key under
    // its PageContext (design 0012, APB-2); main's copy, read from the core,
    // answers `getPermission` once it has been read the first time.
    grantPermission: (key, walletIndex, chainId, page) =>
      require('../wallet/dapp-permissions').grantPermission(key, walletIndex, chainId, page),
    updateLastUsed: (key, chainId, page) => require('../wallet/dapp-permissions').updateLastUsed(key, chainId, page),
    permissionsLoaded: () => require('../wallet/dapp-permissions').whenLoaded(),
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
  // The identity core's dispatcher, for the methods it answers (APB-4a).
  const relay = deps.relay || null;
  // Main's device steps for the core's `{ device }` answers (APB-4b).
  const devices = relay ? deps.devices || createDeviceSigning(deps.deviceDeps) : null;
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
    updateLastUsed: touchGrant,
    permissionsLoaded,
    selectChainForPage,
    agentWalletRequest,
  } = { ...defaultDependencies(), ...deps };

  // A page's last use (and chain) of its grant, written by the core under
  // the request's PageContext: sent in the caller's run, which made the last
  // checks. Never rejects; nothing waits on it.
  function updateLastUsed(context, chainId) {
    try {
      Promise.resolve(touchGrant(context.requester.key, chainId, context.pageContext())).catch(() => {});
    } catch {
      // The request's answer stands.
    }
  }

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
  // under the attested key, which for a DNS name over IPNS is the name. Its
  // signature or send is a page's (design 0012, APB-1): the Agent's decision
  // mints the request's page-kind token through main's issuer, and the
  // signer presents it under `page`, with the PageContext read live
  // (`agent: true`), and reads the decision again (`agentToken.holds`, the
  // name before it) as its last step, right before the core or the device
  // is asked; no standing rule answers it, and none goes as `shell`.
  // `params` are the request's own, or the dispatcher's checked form of them.
  async function agentAnswer(context, keyless, params = context.params) {
    const { requester, method } = context;
    const operation = await context.walletOperation(async ({ signal, open }) => {
      try {
        return await agentWalletRequest(
          requester.guest,
          { method, params, chainId: chainIdOf(requester) },
          {
            signal,
            attested: { key: requester.key, transportKey: requester.transportKey },
            // The document's PageContext, under which the core writes the
            // grant the agent's connect decides (design 0012, APB-2).
            pageContext: () => context.pageContext(),
            beforeEffect: async () => open() && (await context.nameHolds(keyless)) && open(),
            effectAllowed: () => open() && context.holdsKey(),
            // A page request the Agent answers is a page request (design
            // 0012): its decision mints the request's page-kind token
            // through main's issuer, and its signature presents it under
            // `page` with `agent: true`, never as main's own.
            pageToken: context.agentToken,
            // What the agent's own write did, told inside its guarded run
            // (PRQ-6): a grant it created gets main's new-grant events,
            // queued at that write. One it updated is told by the grant
            // store (`page-events.js`), and one it left as it was by no one.
            grantWritten: (effect) => {
              if (effect?.grant !== 'created' || typeof effect.account !== 'string' || !effect.account) return;
              const chainId =
                Number.isSafeInteger(effect.chainId) && effect.chainId > 0 ? effect.chainId : chainIdOf(requester);
              announceNewGrant(context, effect.account, chainId, effect.written);
            },
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

  // A new grant's events (today's, from the chrome's connect): the account
  // to every live document of the key, `connect` to the one that asked.
  // Called at the write itself, in the same run, by main's connect or by
  // the agent's (`grantWritten`), and queued there in the key's order with
  // its other grant events (PRQ-6, `page-events.js`): a revocation made
  // after the write is heard after them, even while a name's resolution
  // holds them. They go out once main has answered the request, as the
  // chrome sent them after its answer. The grant exists once written, so
  // the key's other documents hear it however the request ended; the
  // document that asked hears it only if its answer was the account, not
  // "Request timed out" or nothing at all.
  //
  // With the core's dispatcher (APB-4a) the grant's account is the core's
  // answer: `account` is null, and `written` resolves with it.
  function announceNewGrant(context, account, chainId, written = Promise.resolve()) {
    const { requester } = context;
    context.inGrantOrder(requester.key, async () => {
      // The core writes the grant (design 0012, APB-2): none written, none
      // told.
      let told;
      try {
        told = await written;
      } catch {
        return;
      }
      if (account === null) account = told;
      if (typeof account !== 'string' || !account) return;
      const answered = await context.whenAnswered();
      const others = context
        .liveDocuments()
        .filter(
          (doc) => doc.key === requester.key && !(doc.guest === requester.guest && doc.navigation === requester.navigation)
        );
      if (answered?.ok === true) {
        await context.sendEvent(requester, 'accountsChanged', [account]);
        await context.sendEvent(requester, 'connect', { chainId: hex(chainId) });
      }
      for (const doc of others) await context.sendEvent(doc, 'accountsChanged', [account]);
    });
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
      updateLastUsed(context);
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
    // Sent to the core in this run, under the request's PageContext; its
    // events queued here, in the key's order, sent only once it is written.
    let written;
    try {
      written = Promise.resolve(grantPermission(requester.key, chosen.index, chainId, context.pageContext()));
    } catch (err) {
      written = Promise.reject(err);
    }
    announceNewGrant(context, chosen.address, chainId, written);
    try {
      await written;
    } catch {
      // Not written (a widening whose write failed isn't applied).
      return { error: { ...GRANT_FAILED } };
    }
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
    if (getPermission(requester.key)) updateLastUsed(context, requested);
    selectChainForPage(requester.window, requested);
    // The chain changed for every other page of the window too, but the
    // onchain apps.
    const others =
      previous === requested
        ? []
        : context
          .liveDocuments()
          .filter(
            (doc) =>
              doc.window === requester.window &&
              !doc.chain &&
              !(doc.guest === requester.guest && doc.navigation === requester.navigation)
          );
    // In the window's order with the chain switcher's events (PRQ-6,
    // `page-events.js`), and before the answer, as from the chrome.
    await context.inChainOrder(requester.window, async () => {
      // The page that asked hears it first, unless it is an onchain app,
      // which keeps its own chain.
      if (!pinned) await context.sendEvent(requester, 'chainChanged', hex(requested));
      for (const doc of others) await context.sendEvent(doc, 'chainChanged', hex(requested));
    });
    return { result: null };
  }

  // The identity core's dispatcher (APB-4a, `page-eip1193.js`): the same
  // methods, and main's checks around them.
  const viaCore = (context, options) => relay.request(context, options);
  // Main's steps for the core's sends (APB-4c).
  const coreSends = relay
    ? createCoreSends(
      { getPermission, updateLastUsed, walletList },
      { inCustody: (guest) => custody(guest, sendDeps.inCustody), ...deps.coreSendDeps }
    )
    : null;

  async function coreRead(context) {
    // As `read`: no binary data reaches the JSON.
    if (holdsBinary(context.params || [])) return { error: { ...INVALID_PARAMS } };
    context.copied('ethereum:chain-request');
    return viaCore(context, { params: context.params });
  }

  async function coreAccounts(context) {
    const { requester } = context;
    const named = Boolean(requester.key) && identityWalletEnabled();
    // Name-revalidated, as `accounts`: before the core reads the grant, and
    // after its answer.
    const keyless = { keyless: { result: [] } };
    if (named && !(await context.nameHolds(keyless))) return { result: [] };
    const answer = await viaCore(context);
    if (named && !(await context.nameHolds(keyless))) return { result: [] };
    return answer;
  }

  async function coreRequestAccounts(context) {
    const { requester } = context;
    // The core answers `4900` with the switch off, then `4100` with no key.
    if (!requester.key || !identityWalletEnabled()) return viaCore(context);
    // The agent's route reads main's copy of the grants.
    await permissionsLoaded();
    const keyless = { keyless: { error: { ...NO_ADDRESS } } };
    if (!(await context.nameHolds(keyless))) return { error: { ...NO_ADDRESS } };
    // The agent's route stays main's until APR-7: the core is asked only
    // when the agent doesn't take the request.
    const agent = await agentAnswer(context, keyless);
    if (agent) return context.holdsKey() ? agent : { error: { ...NO_ADDRESS } };
    if (!(await context.nameHolds(keyless))) return { error: { ...NO_ADDRESS } };
    return viaCore(context, { announce: announceNewGrant });
  }

  async function coreSwitchChain(context) {
    context.copied('ethereum:eip1193-request');
    return viaCore(context, { params: context.params });
  }

  // Whether the agent holds the requester's tab now; unknown counts as held.
  function custody(guest, inCustody = null) {
    try {
      return (inCustody || signingDeps.inCustody || guestInCustody)(guest) === true;
    } catch {
      return true;
    }
  }

  // The signatures (APB-4b): main's agent route and name checks around the
  // core's, as main's own route (`page-signing.js`) ordered them.
  async function coreSign(context) {
    const { requester } = context;
    // The core answers `4900` with the switch off, then `4100` with no key.
    if (!requester.key || !identityWalletEnabled()) return viaCore(context, { params: context.params });
    // The agent's route reads main's copy of the grants.
    await permissionsLoaded();
    const keyless = { keyless: { error: { ...NO_ADDRESS } } };
    if (!(await context.nameHolds(keyless))) return { error: { ...NO_ADDRESS } };
    // A tab the agent holds: the agent service answers, within the request,
    // until APR-7. Only a tab in custody is offered to it.
    const agent = custody(requester.guest) ? await agentAnswer(context, keyless) : null;
    if (agent) return context.holdsKey() ? agent : { error: { ...NO_ADDRESS } };
    if (!(await context.nameHolds(keyless))) return { error: { ...NO_ADDRESS } };
    const answer = await viaCore(context, {
      params: context.params,
      device: (device, page) => devices.sign(context, device, page),
    });
    // After the signature's wait: the name again, and the key. A name that
    // moved gets no signature.
    if (answer.result !== undefined && (!(await context.nameHolds(keyless)) || !context.holdsKey())) {
      return { error: { ...NO_ADDRESS } };
    }
    return answer;
  }

  // The sends (APB-4c): main's agent route and name checks around the
  // core's, as main's own route (`page-sends.js`) ordered them.
  async function coreSend(context) {
    const { requester } = context;
    // The core answers `4900` with the switch off, then `4100` with no key.
    if (!requester.key || !identityWalletEnabled()) return viaCore(context, { params: context.params });
    // The agent's route reads main's copy of the grants.
    await permissionsLoaded();
    // The transaction's form first, in custody or not, as main's route
    // checked it: the agent gets only main's form of a well-formed one.
    let tx;
    try {
      tx = txOf(context.params);
    } catch (err) {
      return { error: { code: -32602, message: err.message } };
    }
    if (!(await context.nameHolds())) return { error: { ...NO_ADDRESS } };
    const agent = custody(requester.guest, sendDeps.inCustody) ? await agentAnswer(context, {}, [agentTxOf(tx)]) : null;
    // Refused because the name moved: the keyless answer. Sent: the hash.
    if (agent) return agent.error && !context.holdsKey() ? { error: { ...NO_ADDRESS } } : agent;
    if (!(await context.nameHolds())) return { error: { ...NO_ADDRESS } };
    // After `{ send }` or `{ device }` main checks the name itself, in the
    // send's turn and after a signer's wait (`page-core-sends.js`). Once a
    // payment has gone, its hash is the page's.
    return viaCore(context, {
      params: context.params,
      send: (send, page) => coreSends.pay(context, send, page),
      device: (device, page) => coreSends.device(context, device, page),
    });
  }

  const serve = (answer) => async (context) => {
    if (!identityWalletEnabled()) return { error: { ...DISCONNECTED } };
    // Main's copy of the grants, read from the core the first time.
    await permissionsLoaded();
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
  if (relay) {
    dispatchers['ethereum:eth_chainId'] = (context) => viaCore(context);
    dispatchers['ethereum:net_version'] = (context) => viaCore(context);
    dispatchers['ethereum:eth_accounts'] = coreAccounts;
    for (const method of ETHEREUM_RPC_READS) dispatchers[`ethereum:${method}`] = coreRead;
    dispatchers['ethereum:eth_requestAccounts'] = coreRequestAccounts;
    dispatchers['ethereum:wallet_switchEthereumChain'] = coreSwitchChain;
    for (const method of SIGNING_METHODS) dispatchers[`ethereum:${method}`] = coreSign;
    for (const method of SEND_METHODS) dispatchers[`ethereum:${method}`] = coreSend;
  }
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
