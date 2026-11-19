'use strict';

/**
 * Main's relay to the identity core's Ethereum dispatcher (freedom-core
 * design 0012, "fc-eip1193 and approval.request"; step APB-4a).
 *
 * `page-ethereum.js` hands a page's request here for the methods the core
 * answers from cored 0.20.0: the reads (`eth_chainId`, `net_version`,
 * `eth_accounts` and the 23 read-only methods), the connect
 * (`eth_requestAccounts`) and `wallet_switchEthereumChain`. Signatures and
 * sends stay on main's own routes until APB-4b and APB-4c.
 *
 *   - **The request** goes to `eip1193.request { method, params?, world }`
 *     under `page`, with the document's PageContext: its key as `origin`,
 *     or the empty origin `""` for a document with no key, which the core
 *     answers as such (`4100` for a connect or a switch, `[]` for
 *     `eth_accounts`). `world` is main's wallet state read as main sends it:
 *     the Identity & Wallet switch, an onchain app's own chain and the
 *     window's, the wallets as main lists them, the registry's networks
 *     (each one's name, whether it has a source, and its native symbol),
 *     the active account, and, for a send only (APB-4c), D12's pause.
 *   - **Its answer** is the page's: `{ result }` or `{ error }`, with the
 *     EIP-1193 code main gave before. `{ send }` and `{ device }` are main's
 *     to act on (APB-4b, APB-4c), and never reach a page: for these methods
 *     each is an internal error. A 0001 error (the core down, a crossed
 *     answer's `not_authorized`) is `-32603`. Where main itself refused the
 *     core a step (the name moved, the window's prompt budget), the page
 *     gets main's own answer, as from main's route.
 *   - **The request is cancelled** when main answers the page's record (its
 *     deadline, its document gone), and its hang watchdog is held while
 *     main answers one of its prompts (0012's `Steps` class).
 *
 * The core asks main three things about a request it runs, each naming the
 * request by its 0001 id on the process main sent it to, and its
 * PageContext, which must be the one main sent:
 *
 *   - **`approval.request { request, prompt, page, kind, view, choices }`:**
 *     an `eth.connect` opens main's connect prompt from the core's view and
 *     choices, on the request's record, whose handle record keeps the
 *     core's prompt id. Main answers with the decision on that handle,
 *     echoing the prompt id and the handle: `{ prompt, handle, approve:
 *     true, choices, world }` once the user approves (the document still
 *     holding its key, name and all), `{ prompt, handle, approve: false,
 *     choices: {} }` on a rejection, `{ prompt, closed }` when the handle
 *     closes otherwise, and `{ prompt, busy: true }` when the document
 *     already has a wallet prompt. The other kinds (`eth.sign`, `eth.send`,
 *     `vault.unlock`) answer `busy` until APB-4b and APB-4c serve them. A
 *     core's cancel closes the prompt.
 *   - **`approval.recheck { request, page }`:** `{ live, agent }`, read
 *     now: whether the request is still open and its document still holds
 *     its key (a DNS name over IPNS resolved again), and whether the Agent
 *     holds its tab.
 *   - **`eip1193.select_chain { request, page, chain_id }`:** a switch's
 *     selection, for the chain the page asked for and nothing else: main
 *     selects it for the request's window and sends `chainChanged` as its
 *     own switch did, then answers `{}`.
 *
 * Anything else, or a request main doesn't know, is `invalid_argument`,
 * which the core takes as a crossed answer: the page's request fails, with
 * nothing written.
 */

const { ShellError } = require('../core/service-client');

// What the chrome's getCurrentChainId falls back to (`page-ethereum.js`).
const FALLBACK_CHAIN_ID = 100;
const INTERNAL_ERROR_CODE = -32603;
const PROMPT_PENDING_CODE = -32002;
const NO_ADDRESS = Object.freeze({ code: 4100, message: 'This page has no address to connect from yet' });
// The core's prompt id: 16 random bytes, as 32 lowercase hex digits.
const PROMPT_ID = /^[0-9a-f]{32}$/;
// 0011's reasons a handle closes with no decision.
const CLOSED_REASONS = new Set(['navigated', 'closed', 'cancelled', 'expired']);
// The kinds the core asks for from 0.20.0; main serves `eth.connect` here.
const LATER_KINDS = new Set(['eth.sign', 'eth.send', 'vault.unlock']);
const PAGE_FIELDS = Object.freeze(['origin', 'top_origin', 'frame', 'navigation', 'agent']);
const SELECT_KEYS = new Set(['request', 'page', 'chain_id']);
const RECHECK_KEYS = new Set(['request', 'page']);
const PROMPT_KEYS = new Set(['request', 'prompt', 'page', 'kind', 'view', 'choices']);
// D12's pause is read only for a send's rule (APB-4c): the core reads it
// nowhere else, and a missing one counts as paused.
const PAUSE_METHODS = new Set(['eth_sendTransaction']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOnlyKeys(value, keys) {
  return Object.keys(value).every((key) => keys.has(key));
}

const positive = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const hex = (chainId) => `0x${chainId.toString(16)}`;
const invalid = () => new ShellError('invalid_argument');

function defaultDependencies() {
  return {
    coreClient: () => require('../core/core-process').getCoreClient(),
    watchdogMs: () => require('../core/core-deadlines').watchdogMs('eip1193.request'),
    identityWalletEnabled: () => require('../settings-store').loadSettings()?.enableIdentityWallet === true,
    selectedChainOf: (windowId) => require('../wallet/selected-chain').selectedChainOf(windowId),
    getDerivedWallets: () => require('../identity-manager').getDerivedWallets(),
    networks: () => require('../networks/network-registry').getAllNetworks() || {},
    isChainAvailable: (chainId) => require('../networks/network-registry').isChainAvailable(chainId),
    getActiveWalletIndex: () => require('../identity-manager').getActiveWalletIndex(),
    rulePaused: (key) => require('../wallet/auto-approve-pause').transactionAutoApprovePaused(key),
    selectChainForPage: (windowId, chainId) =>
      require('../wallet/selected-chain').selectChainForPage(windowId, chainId),
  };
}

/**
 * The connect prompt's view, rebuilt to main's form from the core's, and
 * the indexes the core offers: the accounts shown, each once and in order.
 * Throws on anything else.
 */
function connectShown(view, choices) {
  if (!isPlainObject(view) || !isPlainObject(choices)) throw invalid();
  if (!hasOnlyKeys(choices, new Set(['walletIndex'])) || !Array.isArray(choices.walletIndex)) throw invalid();
  if (!hasOnlyKeys(view, new Set(['accounts', 'defaultIndex', 'chain'])) || !Array.isArray(view.accounts)) {
    throw invalid();
  }
  const offered = choices.walletIndex;
  if (offered.length !== view.accounts.length) throw invalid();
  const accounts = view.accounts.map((account, i) => {
    if (!isPlainObject(account) || !Number.isInteger(account.index) || account.index !== offered[i]) throw invalid();
    return {
      index: account.index,
      name: typeof account.name === 'string' ? account.name : '',
      address: typeof account.address === 'string' ? account.address : null,
      type: typeof account.type === 'string' ? account.type : 'mnemonic',
    };
  });
  if (new Set(offered).size !== offered.length) throw invalid();
  const { defaultIndex, chain } = view;
  if (defaultIndex !== null && !offered.includes(defaultIndex)) throw invalid();
  if (!isPlainObject(chain) || !positive(chain.id)) throw invalid();
  if (chain.name !== null && typeof chain.name !== 'string') throw invalid();
  return {
    view: { accounts, defaultIndex, chain: { id: chain.id, name: chain.name } },
    offered: new Set(offered),
  };
}

/**
 * @param {object} [deps] injected for tests; each defaults to main's own.
 */
function createEip1193Relay(deps = {}) {
  const {
    coreClient,
    watchdogMs,
    identityWalletEnabled,
    selectedChainOf,
    getDerivedWallets,
    networks,
    isChainAvailable,
    getActiveWalletIndex,
    rulePaused,
    selectChainForPage,
  } = { ...defaultDependencies(), ...deps };

  // `${generation}:${id}` -> the request main sent the core, while it runs.
  const running = new Map();

  const read = (fn, fallback) => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  async function walletList() {
    try {
      const listed = await getDerivedWallets();
      return Array.isArray(listed) ? listed : [];
    } catch {
      return [];
    }
  }

  // The registry as the core reads it: each network's name, whether it has
  // a source, and its native symbol for a send's view.
  function networkTable() {
    const table = {};
    const all = read(networks, {});
    if (!all || typeof all !== 'object') return table;
    for (const [id, network] of Object.entries(all)) {
      if (!network || typeof network !== 'object') continue;
      const entry = { available: read(() => Boolean(isChainAvailable(Number(id))), false) };
      if (typeof network.name === 'string') entry.name = network.name;
      if (typeof network.nativeSymbol === 'string' && network.nativeSymbol) entry.symbol = network.nativeSymbol;
      table[id] = entry;
    }
    return table;
  }

  /** Main's wallet state for a request of `method`, read now. */
  async function worldFor(context, method) {
    const { requester } = context;
    const world = {
      enabled: read(() => identityWalletEnabled() === true, false),
      chain: positive(requester.chain),
      window_chain: positive(read(() => selectedChainOf(requester.window), null)),
      wallets: await walletList(),
      networks: networkTable(),
    };
    const active = read(getActiveWalletIndex, undefined);
    if (active !== undefined) world.active = active;
    if (PAUSE_METHODS.has(method)) {
      let paused;
      try {
        paused = requester.key ? (await rulePaused(requester.key)) === true : true;
      } catch {
        paused = true;
      }
      world.paused = paused;
    }
    return world;
  }

  /** The document's PageContext, with the empty origin for one with no key. */
  function pageOf(context) {
    const { requester } = context;
    const page = context.pageContext();
    return {
      origin: requester.key || '',
      top_origin: requester.topKey || requester.key || '',
      frame: page.frame,
      navigation: page.navigation,
      agent: page.agent === true,
    };
  }

  // The core's answer as the page gets it.
  function pageAnswer(reply) {
    if (isPlainObject(reply)) {
      const keys = Object.keys(reply);
      if (keys.length === 1 && keys[0] === 'result') return { result: reply.result };
      if (keys.length === 1 && keys[0] === 'error' && isPlainObject(reply.error)) {
        const { code, message, data } = reply.error;
        return { error: data === undefined ? { code, message } : { code, message, data } };
      }
    }
    // `{ send }` and `{ device }` are main's, and no method here gets one.
    return { error: { code: INTERNAL_ERROR_CODE, message: 'The identity core gave no answer for the page' } };
  }

  function failure(err) {
    const message = typeof err?.message === 'string' && err.message ? err.message : 'Internal error';
    return { error: { code: INTERNAL_ERROR_CODE, message } };
  }

  /**
   * Run the page's request in the core. `params` are sent only where the
   * core reads them; `announce(context, account, chainId, written)` tells a
   * new grant's events, queued at the approve (`page-ethereum.js`).
   */
  async function request(context, { params, announce = null } = {}) {
    const method = context.method;
    const client = read(coreClient, null);
    if (!client) return { error: { code: INTERNAL_ERROR_CODE, message: 'The identity core is not running' } };
    const page = pageOf(context);
    const body = { method, world: await worldFor(context, method) };
    if (params !== undefined) body.params = params;
    const entry = { context, method, page, params, client, announce, id: null, generation: null };
    entry.override = null;
    entry.granted = null;
    let key = null;
    let answer;
    try {
      const reply = await client.request('eip1193.request', body, { caller: 'page', page }, {
        watchdogMs: read(watchdogMs, null),
        signal: context.signal,
        onSent: (id, generation) => {
          entry.id = id;
          entry.generation = generation;
          key = `${generation}:${id}`;
          running.set(key, entry);
        },
      });
      answer = pageAnswer(reply);
    } catch (err) {
      answer = failure(err);
    } finally {
      if (key !== null && running.get(key) === entry) running.delete(key);
    }
    if (entry.granted) {
      const account = Array.isArray(answer.result) && typeof answer.result[0] === 'string' ? answer.result[0] : null;
      if (account && !entry.override) entry.granted.resolve(account);
      else entry.granted.reject(new Error('no grant written'));
    }
    return entry.override ? { error: { ...entry.override } } : answer;
  }

  // The request a core's request names, with the PageContext main sent.
  function runningFor(params, generation, keys) {
    if (!isPlainObject(params) || !hasOnlyKeys(params, keys) || !Number.isSafeInteger(params.request)) throw invalid();
    const entry = running.get(`${generation}:${params.request}`);
    if (!entry) throw invalid();
    const page = params.page;
    if (!isPlainObject(page) || !hasOnlyKeys(page, new Set(PAGE_FIELDS))) throw invalid();
    if (!PAGE_FIELDS.every((field) => page[field] === entry.page[field])) throw invalid();
    return entry;
  }

  function grantWritten(entry, chainId) {
    let settle;
    const written = new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
    written.catch(() => {});
    entry.granted = settle;
    try {
      entry.announce?.(entry.context, null, chainId, written);
    } catch {
      // The grant's events never change the answer.
    }
  }

  // Main's answer to the core for its connect prompt's decision.
  async function connectAnswer(entry, prompt, decision) {
    const { context } = entry;
    if (decision.error) {
      // The document's one wallet prompt is taken (`-32002`), or the
      // window's prompt budget is spent (`-32005`, which the page gets
      // instead of the core's `-32002`). Nothing opened.
      if (decision.error.code !== PROMPT_PENDING_CODE) entry.override = { ...decision.error };
      return { prompt, busy: true };
    }
    // The handle's record keeps the core's id from here on.
    const id = typeof decision.prompt === 'string' ? decision.prompt : prompt;
    if (decision.closed !== undefined) {
      return { prompt: id, closed: CLOSED_REASONS.has(decision.closed) ? decision.closed : 'cancelled' };
    }
    if (decision.approve !== true) return { prompt: id, handle: decision.handle, approve: false, choices: {} };
    // Name-revalidated: once the user has approved, the document must still
    // hold its key, a DNS name over IPNS resolved again, or the core writes
    // nothing and the page hears what a keyless document would.
    const keyless = { keyless: { error: { ...NO_ADDRESS } } };
    if (!(await context.nameHolds(keyless)) || !context.holdsKey()) {
      entry.override = { ...NO_ADDRESS };
      return { prompt: id, closed: 'cancelled' };
    }
    const world = await worldFor(context, entry.method);
    grantWritten(entry, world.chain || world.window_chain || FALLBACK_CHAIN_ID);
    return {
      prompt: id,
      handle: decision.handle,
      approve: true,
      choices: { walletIndex: decision.choices.walletIndex },
      world,
    };
  }

  async function approvalRequest(params, { signal, generation } = {}) {
    const entry = runningFor(params, generation, PROMPT_KEYS);
    const { prompt, kind } = params;
    if (typeof prompt !== 'string' || !PROMPT_ID.test(prompt)) throw invalid();
    // APB-4b and APB-4c serve these; nothing asks for them before.
    if (LATER_KINDS.has(kind)) return { prompt, busy: true };
    if (kind !== 'eth.connect' || entry.method !== 'eth_requestAccounts') throw invalid();
    const shown = connectShown(params.view, params.choices);
    if (signal?.aborted) return { prompt, closed: 'cancelled' };
    const { context } = entry;
    // No overall deadline while main answers its prompt.
    const release = entry.client.holdWatchdog?.(entry.generation, entry.id) || (() => {});
    const onAbort = () => context.cancelPrompt(prompt);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const decision = await context.prompt({
        kind: 'eth.connect',
        view: shown.view,
        corePrompt: prompt,
        // The one thing the user picks: which offered account.
        choices: (raw) =>
          Object.keys(raw).every((name) => name === 'walletIndex') &&
          Number.isInteger(raw.walletIndex) &&
          shown.offered.has(raw.walletIndex)
            ? { walletIndex: raw.walletIndex }
            : null,
      });
      return await connectAnswer(entry, prompt, decision);
    } finally {
      signal?.removeEventListener('abort', onAbort);
      release();
    }
  }

  async function approvalRecheck(params, { generation } = {}) {
    const entry = runningFor(params, generation, RECHECK_KEYS);
    const { context } = entry;
    const live =
      !context.signal.aborted &&
      context.isCurrent() &&
      context.holdsKey() &&
      (await context.nameHolds()) &&
      !context.signal.aborted &&
      context.holdsKey();
    return { live: live === true, agent: context.pageContext().agent === true };
  }

  // The chain the page asked for, as main's own switch read it.
  function askedChain(params) {
    const first = Array.isArray(params) || isPlainObject(params) ? params[0] : undefined;
    const raw = isPlainObject(first) ? first.chainId : undefined;
    return typeof raw === 'string' || typeof raw === 'number' ? parseInt(raw, 16) : NaN;
  }

  function windowChainOf(windowId) {
    return positive(read(() => selectedChainOf(windowId), null)) || FALLBACK_CHAIN_ID;
  }

  async function selectChain(params, { generation } = {}) {
    const entry = runningFor(params, generation, SELECT_KEYS);
    if (entry.method !== 'wallet_switchEthereumChain') throw invalid();
    const chainId = params.chain_id;
    // The chain the page asked for, which main's registry knows and has a
    // source for, and an onchain app's own: nothing else is selected.
    if (!positive(chainId) || chainId !== askedChain(entry.params)) throw invalid();
    if (!read(() => networks()?.[chainId], null) || !read(() => isChainAvailable(chainId), false)) throw invalid();
    const { context } = entry;
    const { requester } = context;
    const pinned = positive(requester.chain);
    if (pinned && chainId !== pinned) throw invalid();
    if (context.signal.aborted || !context.isCurrent()) throw invalid();
    // The name rechecked moments ago; the key held at the effect itself.
    if (!context.holdsKey()) {
      entry.override = { ...NO_ADDRESS };
      throw invalid();
    }
    const previous = windowChainOf(requester.window);
    selectChainForPage(requester.window, chainId);
    // The chain changed for every other page of the window too, but the
    // onchain apps.
    const others =
      previous === chainId
        ? []
        : context
          .liveDocuments()
          .filter(
            (doc) =>
              doc.window === requester.window &&
              !doc.chain &&
              !(doc.guest === requester.guest && doc.navigation === requester.navigation)
          );
    // In the window's order with the chain switcher's events (PRQ-6), and
    // before the page's answer, as main's own switch sent them.
    await context.inChainOrder(requester.window, async () => {
      if (!pinned) await context.sendEvent(requester, 'chainChanged', hex(chainId));
      for (const doc of others) await context.sendEvent(doc, 'chainChanged', hex(chainId));
    });
    return {};
  }

  /** Serve the core's requests about the page requests main relays. */
  function attach(client) {
    client.handle('approval.request', approvalRequest);
    client.handle('approval.recheck', approvalRecheck);
    client.handle('eip1193.select_chain', selectChain);
  }

  return {
    request,
    attach,
    worldFor,
    approvalRequest,
    approvalRecheck,
    selectChain,
    running: () => running.size,
  };
}

let shared = null;

/** Main's relay, shared by the page dispatchers and the core's client. */
function getEip1193Relay() {
  if (!shared) shared = createEip1193Relay();
  return shared;
}

/** core-process.js: serve the core's requests before anything is sent. */
function attachEip1193(client) {
  getEip1193Relay().attach(client);
}

module.exports = {
  createEip1193Relay,
  getEip1193Relay,
  attachEip1193,
  connectShown,
};
