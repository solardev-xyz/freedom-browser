'use strict';

/**
 * The Ethereum dispatcher for page requests (freedom-core design 0011, "The
 * dispatcher"; design 0012, APB-4).
 *
 * Every Ethereum method a page asks main for goes to the identity core's
 * `eip1193.request` through main's relay (`page-eip1193.js`), under the
 * request's PageContext: the reads (`eth_chainId`, `net_version`,
 * `eth_accounts` and the 23 read-only methods, PRQ-3), the connect and the
 * chain switch (PRQ-4, APB-4a), the signatures (PRQ-5a, APB-4b) and the sends
 * (PRQ-5b, APB-4c). The core asks main for its prompts, the document's
 * recheck and the switch's selection; a Ledger's, a phone's or a Safe's
 * signature comes back as `{ device }`, which main spends
 * (`page-devices.js`), and a send as `{ send }` or `{ device }`, which main
 * takes through the site's turn, the nonce, the record and the broadcast
 * (`page-core-sends.js`).
 *
 * In a tab the Agent holds, every request goes to the core like any page's,
 * and the Agent's sheet answers the core's prompt for a connect, a
 * signature or a send (design 0012, "The Agent's answer", APB-5;
 * `page-eip1193.js`). The agent's own route, which answered them before the
 * core was asked, minting their tokens and writing their grants through
 * main, was removed in APB-5.
 *
 * Main keeps what the core doesn't hold:
 *
 *   - A DNS name over IPNS where main holds the step (design 0012,
 *     APR-5f): the core checks the name itself at each of the reference's
 *     checks of `eth_accounts`, the connect, the switch, the signatures and
 *     the sends, under the `transport_key` main's relay sends (APB-4e,
 *     cored 0.21.0), and answers as a keyless document's once it moved
 *     ("This page has no address to connect from yet", or `[]` for
 *     `eth_accounts`). Main checks it again only after the steps it holds:
 *     a send's after the site's turn, after the signature and before the
 *     writes after it (`page-core-sends.js`), a Safe's before each
 *     execution, and a device's signature after the device signs
 *     (`page-devices.js`).
 *   - A new grant's events (PRQ-6), queued in the key's order at the write.
 *   - Binary params, refused before any JSON.
 *   - A send's form (`txOf`), checked first, in custody or not.
 *
 * The routes main ran itself before the core's dispatcher (design 0011,
 * PRQ-3 to PRQ-6: `page-signing.js`, `page-sends.js` and this file's own
 * reads, connect and switch) were removed in APB-4d once nothing called them.
 */

const { ETHEREUM_RPC_READS } = require('./page-methods');
const { guestInCustody } = require('./page-custody');
const { createDeviceSigning } = require('./page-devices');
const { createCoreSends, txOf } = require('./page-core-sends');

// What the chrome's getCurrentChainId falls back to: Gnosis.
const FALLBACK_CHAIN_ID = 100;

const INVALID_PARAMS = Object.freeze({ code: -32602, message: 'Invalid parameters' });

/** The methods this dispatcher serves: PRQ-3's reads. */
const ETHEREUM_READ_METHODS = Object.freeze(['eth_chainId', 'net_version', 'eth_accounts', ...ETHEREUM_RPC_READS]);

/** And PRQ-4's: connecting. */
const ETHEREUM_CONNECT_METHODS = Object.freeze(['eth_requestAccounts', 'wallet_switchEthereumChain']);

/** And PRQ-5a's: messages and typed data. */
const ETHEREUM_SIGNING_METHODS = Object.freeze(['personal_sign', 'eth_signTypedData_v4']);

/** And PRQ-5b's: sends. */
const ETHEREUM_SEND_METHODS = Object.freeze(['eth_sendTransaction']);

/** Every method main's Ethereum dispatcher serves, and so the preload routes to main. */
const ETHEREUM_PAGE_METHODS = Object.freeze([
  ...ETHEREUM_READ_METHODS,
  ...ETHEREUM_CONNECT_METHODS,
  ...ETHEREUM_SIGNING_METHODS,
  ...ETHEREUM_SEND_METHODS,
]);

function defaultDependencies() {
  return {
    identityWalletEnabled: () => require('../settings-store').loadSettings()?.enableIdentityWallet === true,
    getPermission: (key) => require('../wallet/dapp-permissions').getPermission(key),
    getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
    // The dApp grants, which the identity core writes for a page's key under
    // its PageContext (design 0012, APB-2); main's copy, read from the core,
    // answers `getPermission` once it has been read the first time.
    updateLastUsed: (key, chainId, page) => require('../wallet/dapp-permissions').updateLastUsed(key, chainId, page),
    permissionsLoaded: () => require('../wallet/dapp-permissions').whenLoaded(),
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
  // Custody as the tests read it; main's own otherwise (`page-custody.js`).
  const signingDeps = deps.signing || {};
  const sendDeps = deps.sends || {};
  // The identity core's dispatcher, which answers every method (APB-4).
  const { relay } = deps;
  // Main's device steps for the core's `{ device }` answers (APB-4b).
  const devices = deps.devices || createDeviceSigning(deps.deviceDeps);
  const {
    identityWalletEnabled,
    getPermission,
    getDerivedWallets,
    updateLastUsed: touchGrant,
    permissionsLoaded,
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

  const hex = (chainId) => `0x${chainId.toString(16)}`;

  async function walletList() {
    try {
      const listed = await getDerivedWallets();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  // A new grant's events (today's, from the chrome's connect): the account
  // to every live document of the key, `connect` to the one that asked.
  // Called at the write itself, in the same run, by the core's connect
  // (through the relay's `announce`), and queued there in the key's order with
  // its other grant events (PRQ-6, `page-events.js`): a revocation made
  // after the write is heard after them, even while a name's resolution
  // holds them. They go out once main has answered the request, as the
  // chrome sent them after its answer. The grant exists once written, so
  // the key's other documents hear it however the request ended; the
  // document that asked hears it only if its answer was the account, not
  // "Request timed out" or nothing at all.
  //
  // The grant's account is the core's answer: `account` is null, and
  // `written` resolves with it.
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

  // The identity core's dispatcher (APB-4, `page-eip1193.js`), and main's
  // checks around it.
  const viaCore = (context, options) => relay.request(context, options);
  // Main's steps for the core's sends (APB-4c).
  const coreSends = createCoreSends(
    { getPermission, updateLastUsed, walletList },
    { inCustody: (guest) => custody(guest, sendDeps.inCustody), ...deps.coreSendDeps }
  );

  async function coreRead(context) {
    // JSON would carry a byte as up to 13 characters of an object's keys:
    // no read takes binary data, so none reaches the JSON. The core's
    // request is serialized as JSON in this call: the copy the request's
    // charge pays for.
    if (holdsBinary(context.params || [])) return { error: { ...INVALID_PARAMS } };
    context.copied('ethereum:chain-request');
    return viaCore(context, { params: context.params });
  }

  // The connect: the core's, which checks a bound document's name itself
  // (APR-5f), in custody or not. In a tab the Agent holds, its sheet
  // answers the core's prompt (APB-5, `page-eip1193.js`).
  function coreRequestAccounts(context) {
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

  // The signatures (APB-4b): the core's, in custody or not (APB-5: in a
  // tab the Agent holds, its sheet answers the core's prompt). The core
  // checks a bound document's name itself (APR-5f), and a device's
  // signature is checked again after the device signs (`page-devices.js`),
  // with custody for one the sheet approved (A7-6).
  function coreSign(context) {
    return viaCore(context, {
      params: context.params,
      device: (device, page, how) => devices.sign(context, device, page, how),
    });
  }

  // The sends (APB-4c): the core's, in custody or not (APB-5: in a tab the
  // Agent holds, its sheet answers the core's prompt). The core checks a
  // bound document's name itself (APR-5f-2), and main again in the send's
  // turn, after the signature and before the writes after it, with custody
  // for a send the sheet approved (A7-6, `page-core-sends.js`).
  async function coreSend(context) {
    const { requester } = context;
    // The core answers `4900` with the switch off, then `4100` with no key.
    if (!requester.key || !identityWalletEnabled()) return viaCore(context, { params: context.params });
    // Main's steps after the core's answer read main's copy of the grants.
    await permissionsLoaded();
    // The transaction's form first, in custody or not, as main's route
    // checked it.
    try {
      txOf(context.params);
    } catch (err) {
      return { error: { code: -32602, message: err.message } };
    }
    // After `{ send }` or `{ device }` main checks the name itself, in the
    // send's turn and after a signer's wait (`page-core-sends.js`). Once a
    // payment has gone, its hash is the page's.
    return viaCore(context, {
      params: context.params,
      send: (send, page, how) => coreSends.pay(context, send, page, how),
      device: (device, page, how) => coreSends.device(context, device, page, how),
    });
  }

  const dispatchers = {
    'ethereum:eth_chainId': (context) => viaCore(context),
    'ethereum:net_version': (context) => viaCore(context),
    // The core checks a bound document's name before it reads the grant
    // and before an account goes out (APR-5f).
    'ethereum:eth_accounts': (context) => viaCore(context),
    'ethereum:eth_requestAccounts': coreRequestAccounts,
    'ethereum:wallet_switchEthereumChain': coreSwitchChain,
  };
  for (const method of ETHEREUM_RPC_READS) dispatchers[`ethereum:${method}`] = coreRead;
  for (const method of ETHEREUM_SIGNING_METHODS) dispatchers[`ethereum:${method}`] = coreSign;
  for (const method of ETHEREUM_SEND_METHODS) dispatchers[`ethereum:${method}`] = coreSend;
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
};
