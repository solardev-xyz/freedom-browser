'use strict';

/**
 * The Ethereum events the chrome used to send pages, sent by main
 * (freedom-core design 0011, "Events"; step PRQ-6):
 *
 *   - `chainChanged`, when the user picks a chain in a window's chain
 *     switcher (the chrome's `wallet:select-chain`, which
 *     `wallet/selected-chain.js` records): to every live document of that
 *     window whose chain follows the selection, so never to an onchain app,
 *     which keeps its own chain, and only when the chain the document reads
 *     changes ("All Chains" reads as Gnosis, as `eth_chainId` answers it).
 *   - `accountsChanged`, when a grant is revoked (the chrome's disconnect,
 *     an account deleted) or its account changes (`wallet/dapp-permissions.js`):
 *     to every live document of the key, in every window. `[]` for a
 *     revocation, else the grant's new account.
 *
 * Today the chrome told only the visible tab (`chain-switcher.js`,
 * `dapp-connect.js`'s disconnect). A method main serves sends its own
 * events from its own step (`page-ethereum.js`: a connect's grant, a page's
 * `wallet_switchEthereumChain`).
 *
 * Every event goes through `sendEvent` (`page-requests.js`): with the
 * target document's nonce, to its guest's main frame only, while the
 * document is current, and, to a name-keyed document, an `accountsChanged`
 * only once main has resolved the name again to the document's IPNS key. A
 * private window's page, a preview and a sub-frame never said hello, so
 * they are no live document.
 *
 * The documents are the ones live when the change happened. Main sends one
 * change's events after the last change's, per window for the chain and
 * per key for the account, so each document hears the changes in their
 * order, and the last it hears is the state main holds.
 */

const { FALLBACK_CHAIN_ID } = require('./page-ethereum');

const hex = (chainId) => `0x${chainId.toString(16)}`;

// The chain a page reads for a window's selection: Gnosis for "All Chains"
// (null), as `eth_chainId` answers it (`page-ethereum.js`).
function chainReadFor(selected) {
  return Number.isSafeInteger(selected) && selected > 0 ? selected : FALLBACK_CHAIN_ID;
}

function defaultDependencies() {
  return {
    requests: () => require('./page-requests').getPageRequests(),
    getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
    normalizeKey: (key) => require('../../shared/origin-utils').normalizeOrigin(key),
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 *   `requests()` gives `liveDocuments()` and `sendEvent(target, provider,
 *   event, data)`.
 */
function createPageEvents(deps = {}) {
  const { requests, getDerivedWallets, normalizeKey } = { ...defaultDependencies(), ...deps };

  // name -> the promise of its last change's sends
  const queues = new Map();

  function enqueue(name, job) {
    const before = queues.get(name) || Promise.resolve();
    const done = before.then(job).catch(() => []);
    queues.set(name, done);
    done.then(() => {
      if (queues.get(name) === done) queues.delete(name);
    });
    return done;
  }

  async function sendAll(targets, event, data) {
    const outcomes = [];
    for (const target of targets) {
      let outcome;
      try {
        outcome = await requests().sendEvent(target, 'ethereum', event, data);
      } catch {
        outcome = { ok: false, reason: 'failed' };
      }
      outcomes.push({ guest: target.guest, navigation: target.navigation, ...outcome });
    }
    return outcomes;
  }

  function live() {
    try {
      const docs = requests().liveDocuments();
      return Array.isArray(docs) ? docs : [];
    } catch {
      return [];
    }
  }

  /**
   * Window `window`'s chrome changed its selection from `previous` to
   * `next`. Resolves with each send's outcome.
   */
  function chainSelected({ window: windowId, previous, next } = {}) {
    if (!Number.isInteger(windowId)) return Promise.resolve([]);
    const before = chainReadFor(previous);
    const after = chainReadFor(next);
    if (before === after) return Promise.resolve([]);
    // Every page of the window reads the selection, but an onchain app.
    const targets = live().filter((doc) => doc.window === windowId && !doc.chain);
    return enqueue(`chain:${windowId}`, () => sendAll(targets, 'chainChanged', hex(after)));
  }

  async function accountsFor(walletIndex) {
    if (walletIndex === null || walletIndex === undefined) return [];
    let wallets;
    try {
      wallets = await getDerivedWallets();
    } catch {
      return [];
    }
    const wallet = Array.isArray(wallets) ? wallets.find((candidate) => candidate?.index === walletIndex) : null;
    return typeof wallet?.address === 'string' && wallet.address ? [wallet.address] : [];
  }

  function sameKey(doc, key) {
    if (!doc.key) return false;
    try {
      return normalizeKey(doc.key) === key;
    } catch {
      return false;
    }
  }

  /**
   * The grant for `key` was revoked (`walletIndex` null) or now exposes
   * account `walletIndex`. Resolves with each send's outcome.
   */
  function grantChanged({ key, walletIndex } = {}) {
    if (typeof key !== 'string' || !key) return Promise.resolve([]);
    const targets = live().filter((doc) => sameKey(doc, key));
    return enqueue(`accounts:${key}`, async () =>
      sendAll(targets, 'accountsChanged', await accountsFor(walletIndex))
    );
  }

  return { chainSelected, grantChanged };
}

let shared = null;

function getPageEvents() {
  if (!shared) shared = createPageEvents();
  return shared;
}

/**
 * index.js: main hears the chrome's chain selections and the grants'
 * changes, and tells the pages. Returns a function that stops it.
 */
function registerPageEvents({
  selectedChain = require('../wallet/selected-chain'),
  permissions = require('../wallet/dapp-permissions'),
  events = getPageEvents(),
} = {}) {
  const stops = [
    selectedChain.onChromeSelection((change) => {
      events.chainSelected(change);
    }),
    permissions.onGrantChanged((change) => {
      events.grantChanged(change);
    }),
  ];
  return () => {
    for (const stop of stops) stop();
  };
}

module.exports = {
  createPageEvents,
  getPageEvents,
  registerPageEvents,
  chainReadFor,
};
