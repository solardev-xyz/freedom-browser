// Main's own part around the identity core's Ethereum dispatcher (freedom-core
// design 0012, APB-4d). Every Ethereum page method goes to the core's
// `eip1193.request` through main's relay (`page-eip1193.js`), and main keeps
// only what the core doesn't hold: the method list the preload routes to
// main, binary params refused before any JSON, a DNS name over IPNS checked
// again before the key is used and after the core's answer, and the agent's
// route for a tab it holds, which stays in main until APR-7.
//
// The dispatchers here run over main's real relay. Behind it, a stand-in
// core answers from the world main sends and main's copy of the grants, and
// asks main for a connect's prompt through the relay's own handler, as the
// core does. The relay and the core themselves are tested in
// page-eip1193.test.js and the page-eip1193 integration tests.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests, GONE } = require('./page-requests');
const { CLASS, methodRow, ETHEREUM_RPC_READS } = require('./page-methods');
const { ETHEREUM_READ_METHODS, ETHEREUM_PAGE_METHODS, createEthereumDispatchers } = require('./page-ethereum');
const { createEip1193Relay } = require('./page-eip1193');
const { createPageEvents } = require('./page-events');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { AgentWalletController } = require('../agent/agent-wallet-controller');
const confirmations = require('../wallet/signing-confirmation');
const {
  normalizeMessage,
  normalizeTypedData,
  messageToBytes,
  toCoreTypedData,
  buildTransaction,
} = require('../wallet/signing-utils');
const { coreCheckedSigner } = require('../../../test/helpers/simulated-approvals');
const { TypedDataEncoder } = require('ethers');

// The identity core's approval tokens (design 0012, APB-1), simulated
// (test/helpers/simulated-approvals.js): main's issuer mints the Agent's
// page tokens through it.
const mockApprovals = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({
  vaultBackend: {
    get approval() {
      return mockApprovals.approval;
    },
  },
}));

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const DAPP = `${KEY_A}/app`;
const OTHER = `${KEY_B}/`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const LEDGER = '0x2222222222222222222222222222222222222222';
const SAFE = '0x3333333333333333333333333333333333333333';
const UNDEPLOYED = '0x4444444444444444444444444444444444444444';
const PHONE = '0x4444444444444444444444444444444444444444';
const SAFE_INDEX = 1000;
const LEDGER_INDEX = 1;
const PHONE_INDEX = 2000;
const CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const SELECTOR = '0x095ea7b3';
const DATA = `${SELECTOR}${'00'.repeat(64)}`;
const CALL = { to: CONTRACT, value: '0x0', data: DATA };
const TRANSFER = { to: ACCOUNT, value: '0x2386f26fc10000' };
const HASH = `0x${'ab'.repeat(32)}`;
const MESSAGE = '0x68656c6c6f'; // "hello"
const TYPED = {
  types: {
    EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
    Order: [{ name: 'amount', type: 'uint256' }],
  },
  domain: { chainId: 100 },
  primaryType: 'Order',
  message: { amount: '1' },
};
// The data's EIP-712 hash, which the core binds to its token.
const TYPED_HASH = TypedDataEncoder.hash(TYPED.domain, { Order: TYPED.types.Order }, TYPED.message);
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const PENDING = { error: { code: -32002, message: 'Another wallet request is already pending' } };
const DISCONNECTED = { error: { code: 4900, message: 'Disconnected' } };
// The stand-in core's answer to a signature or a send (`standInCore`).
const STAND_IN_REFUSAL = { error: { code: 4200, message: 'The stand-in core answers no signature or send' } };
const GENERATION = 3;

// Each area's accounts, as its own tests had them: a connect offers every
// account but the undeployed Safe; a signature and a send care what kind of
// signer each account has.
const CONNECT_WALLETS = Object.freeze([
  { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
  { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
  { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
  { index: 1001, name: 'New Safe', address: UNDEPLOYED, type: 'safe', deployed: {} },
]);
const SIGNING_WALLETS = Object.freeze([
  { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
  { index: LEDGER_INDEX, name: 'Ledger', address: LEDGER, type: 'ledger' },
  { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
]);
const SENDING_WALLETS = Object.freeze([
  { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
  { index: LEDGER_INDEX, name: 'Ledger', address: LEDGER, type: 'ledger' },
  { index: PHONE_INDEX, name: 'Phone', address: PHONE, type: 'remote' },
  { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
]);

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** A tab guest: a webview webContents hosted by chrome window `window`. */
class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.events = [];
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: jest.fn((_channel, message) => this.events.push([message.event, message.data])),
    };
  }

  isDestroyed() {
    return this.destroyed;
  }

  getType() {
    return 'webview';
  }

  getURL() {
    return this.mainFrame.url;
  }

  commit(url) {
    this.mainFrame.detached = true;
    this.mainFrame = this.frame(url);
    this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 1, this.mainFrame.routingId);
  }

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

/**
 * The identity core's stand-in behind main's relay: each `eip1193.request`
 * is answered from the world main sent with it and main's copy of the
 * grants (`state.permissions`), for the page's origin as main sent it. A
 * connect with no grant asks main for its prompt through the relay's
 * `approval.request` handler, and on the user's approval writes the grant
 * (`grantPermission`) before it answers, as the core writes it under the
 * request's PageContext. It signs and sends nothing: a signature or a send
 * reaches it only from a tab the agent doesn't hold, and it answers those
 * `4200`, or `4100` for a keyless document as the core does, which the tests
 * of main's gates read as the core's answer.
 */
function standInCore(state, grantPermission, relayOf) {
  let lastId = 0;
  const core = {
    // Every request main sent, with the PageContext it went under.
    sent: [],
    // The origins whose grant the core read.
    grantReads: [],
    request: async (method, body, context, options) => {
      const id = ++lastId;
      core.sent.push({ id, method: body.method, params: body.params, page: context.page });
      options.onSent(id, GENERATION);
      if (options.signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
      return answer(id, body, context.page, options.signal);
    },
  };

  function grantedAccount(page, world) {
    if (!page.origin) return null;
    core.grantReads.push(page.origin);
    const grant = state.permissions.get(page.origin);
    if (!grant) return null;
    return world.wallets.find((wallet) => wallet.index === grant.walletIndex)?.address || null;
  }

  async function connect(id, page, world, chainId, signal) {
    const offered = world.wallets.filter((wallet) => wallet.type !== 'safe' || wallet.deployed?.[100]);
    const decision = await relayOf().approvalRequest(
      {
        request: id,
        prompt: id.toString(16).padStart(32, '0'),
        page,
        kind: 'eth.connect',
        view: {
          accounts: offered.map(({ index, name, address, type }) => ({ index, name, address, type })),
          defaultIndex: offered[0]?.index ?? null,
          chain: { id: chainId, name: world.networks[chainId]?.name ?? null },
        },
        choices: { walletIndex: offered.map((wallet) => wallet.index) },
      },
      { generation: GENERATION, signal }
    );
    if (decision.busy) return PENDING;
    if (decision.approve !== true) return REJECTED;
    const chosen = offered.find((wallet) => wallet.index === decision.choices.walletIndex);
    const at = decision.world.chain || decision.world.window_chain || 100;
    grantPermission(page.origin, chosen.index, at);
    return { result: [chosen.address] };
  }

  async function answer(id, { method, params, world }, page, signal) {
    if (!world.enabled) return DISCONNECTED;
    const chainId = world.chain || world.window_chain || 100;
    if (method === 'eth_chainId') return { result: `0x${chainId.toString(16)}` };
    if (method === 'net_version') return { result: String(chainId) };
    if (ETHEREUM_RPC_READS.includes(method)) {
      state.reads.push({ chainId, method, params, origin: page.origin });
      return { result: `${method}@${chainId}` };
    }
    if (method === 'eth_accounts') {
      const account = grantedAccount(page, world);
      return { result: account ? [account] : [] };
    }
    if (method === 'eth_requestAccounts') {
      if (!page.origin) return NO_ADDRESS;
      const account = grantedAccount(page, world);
      return account ? { result: [account] } : connect(id, page, world, chainId, signal);
    }
    if (!page.origin) return NO_ADDRESS;
    return STAND_IN_REFUSAL;
  }

  return core;
}

/** Main's backends and the dispatchers' deps, all in memory, over main's relay. */
function backends({ wallets = CONNECT_WALLETS } = {}) {
  const state = {
    enabled: true,
    // Main's copy of the grants, which the core writes.
    permissions: new Map(),
    wallets: wallets.map((wallet) => ({ ...wallet })),
    selected: new Map(),
    available: new Set([1, 100]),
    networks: { 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } },
    // The grants written (by the core for main's prompt, or the agent's).
    grants: [],
    lastUsed: [],
    // The tabs the agent holds.
    custody: new Set(),
    agent: null,
    // Main's wallet list as the relay reads it for the core's world, when a
    // test holds it.
    derive: null,
    // The core's chain reads, with the origin each went under.
    reads: [],
    signed: [],
    // A relay request from a tab the agent holds: the agent answers those,
    // so any here fails the test (see `afterEach`).
    misrouted: [],
  };
  const signer = {
    signMessage: jest.fn(async (message) => {
      state.signed.push(['message', message]);
      return '0xmsgsig';
    }),
    signTypedData: jest.fn(async (data, options) => {
      state.signed.push(['typed', data, options]);
      return '0xtypedsig';
    }),
  };
  // The core's grant write, under the request's PageContext, and main's copy
  // of it.
  const grantPermission = jest.fn((key, walletIndex, chainId) => {
    state.grants.push({ key, walletIndex, chainId });
    state.permissions.set(key, { origin: key, walletIndex, chainId });
  });
  let relay = null;
  const core = standInCore(state, grantPermission, () => relay);
  relay = createEip1193Relay({
    coreClient: () => core,
    watchdogMs: () => 135_000,
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
    getDerivedWallets: async () => (state.derive ? state.derive() : state.wallets),
    networks: () => state.networks,
    isChainAvailable: (chainId) => state.available.has(Number(chainId)),
    getActiveWalletIndex: () => 0,
    rulePaused: async () => false,
    selectChainForPage: () => {},
    isVaultUnlocked: async () => true,
    discardToken: () => {},
  });
  const deps = {
    relay: {
      request: (context, options) => {
        if (state.custody.has(context.requester.guest)) {
          state.misrouted.push({ guest: context.requester.guest, method: context.method });
        }
        return relay.request(context, options);
      },
    },
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
    getPermission: (key) => state.permissions.get(key) || null,
    getDerivedWallets: async () => state.wallets,
    updateLastUsed: jest.fn((key, chainId) => {
      state.lastUsed.push(chainId === undefined ? [key] : [key, chainId]);
      const permission = state.permissions.get(key);
      if (permission && chainId !== undefined) permission.chainId = chainId;
    }),
    permissionsLoaded: async () => {},
    agentWalletRequest: jest.fn(async (guestId, request, options) =>
      (state.agent ? state.agent(guestId, request, options) : { handled: false })
    ),
    signing: { inCustody: (guestId) => state.custody.has(guestId) },
    sends: { inCustody: (guestId) => state.custody.has(guestId) },
    deviceDeps: { walletList: async () => state.wallets, discardToken: () => {} },
    coreSendDeps: { discardToken: () => {} },
  };
  return { state, deps, core, signer, grantPermission };
}

// Every environment a test made, for the check after it.
const envs = [];

function setup({ resolveEnsContent, agentContext = false, wallets } = {}) {
  const guests = new Map();
  const names = new Map();
  const resolutions = [];
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent:
      resolveEnsContent ||
      (async (name) => {
        resolutions.push(name);
        const key = names.get(name);
        return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
      }),
  });
  const { state, deps, core, signer, grantPermission } = backends({ wallets });
  const sent = [];
  const timers = [];
  const trace = [];
  const copies = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers(deps),
    hooks: {
      onTrace: (entry) => trace.push(entry),
      onCopy: (entry) => copies.push({ ...entry, sentSoFar: core.sent.length }),
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cleared = true;
    },
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: () => {},
    // A PageContext's `agent`: the same custody the dispatchers read, for
    // the Agent's own requests (`agentContext`); otherwise false.
    isAgentGuest: (guestId) => agentContext && state.custody.has(guestId),
  });

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n })).toEqual({ ok: true, navigation: expect.any(Number) });
    return {
      guest,
      ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
      send: (tx) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method: 'eth_sendTransaction', params: [tx] }),
    };
  }

  /** A tracked guest on `url` whose document has said hello. */
  function tab(url = DAPP, { window = 1, bind = null, front = true } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      expect(
        requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })
      ).toBe(true);
    }
    guest.commit(url);
    const page = greet(guest);
    if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return page;
  }

  const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  const connect = (key = KEY_A, walletIndex = 0, extra = {}) =>
    state.permissions.set(key, { origin: key, walletIndex, chainId: 100, ...extra });
  // Main's deadline for every request still running.
  const expire = () => {
    for (const timer of timers.filter((t) => !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  const minted = () => trace.filter((entry) => entry.kind === 'token-minted');

  const env = {
    requests,
    documents,
    state,
    deps,
    core,
    signer,
    grantPermission,
    sent,
    trace,
    copies,
    tab,
    greet,
    names,
    resolutions,
    prompts,
    decide,
    connect,
    guests,
    expire,
    minted,
  };
  envs.push(env);
  return env;
}

beforeEach(() => {
  confirmations._reset();
  mockApprovals.reset();
  envs.length = 0;
});

// The agent answers for a tab it holds, and the core is never asked.
afterEach(() => {
  for (const env of envs) expect(env.state.misrouted).toEqual([]);
});

describe("main's part around the core's dispatcher (0012 APB-4d)", () => {
  test('the dispatcher serves exactly the moved methods: the read-only list, eth_accounts, connecting, signing and sends', () => {
    // The read-only list the chrome served (page-methods.test.js pins it):
    // eth_chainId, net_version and the RPC reads.
    const readOnly = ['eth_chainId', 'net_version', ...ETHEREUM_RPC_READS];
    expect(readOnly).toHaveLength(25);
    expect([...ETHEREUM_READ_METHODS].sort()).toEqual([...readOnly, 'eth_accounts'].sort());
    expect([...ETHEREUM_PAGE_METHODS].sort()).toEqual(
      [
        ...ETHEREUM_READ_METHODS,
        'eth_requestAccounts',
        'wallet_switchEthereumChain',
        'personal_sign',
        'eth_signTypedData_v4',
        'eth_sendTransaction',
      ].sort()
    );
    expect(Object.keys(createEthereumDispatchers(backends().deps)).sort()).toEqual(
      ETHEREUM_PAGE_METHODS.map((method) => `ethereum:${method}`).sort()
    );
    // The preload sends every window.ethereum method to main (PRQ-9): it
    // keeps no list of routed methods, so nothing goes anywhere else.
    const preload = fs.readFileSync(path.join(__dirname, '../webview-preload.js'), 'utf-8');
    expect(preload).not.toMatch(/PAGE_ROUTES|routedToMain|sendToHost\('(?:dapp|swarm|radicle):/);
    // Each has its row, of the class the design gives it.
    for (const method of ETHEREUM_READ_METHODS) {
      const expected = method === 'eth_accounts' ? CLASS.NAME_REVALIDATED : CLASS.PERMISSION_FREE;
      expect({ method, class: methodRow('ethereum', method).class }).toEqual({ method, class: expected });
    }
  });

  test('params holding binary data are refused before any JSON, and the read\'s copy is charged first', async () => {
    const env = setup();
    const page = env.tab(DAPP);
    for (const params of [[new Uint8Array(32)], [{ data: new ArrayBuffer(8) }], { to: [new Uint8Array(1)] }]) {
      expect(await page.ask('eth_call', params)).toEqual({ error: { code: -32602, message: 'Invalid parameters' } });
    }
    // Nothing reached the core.
    expect(env.core.sent).toEqual([]);
    expect(env.copies).toEqual([]);

    expect(await page.ask('eth_call', [{ to: ACCOUNT, data: '0x1234' }, 'latest'])).toEqual({ result: 'eth_call@100' });
    // Reported before the core's request was made, with the charge in place.
    expect(env.copies).toEqual([
      expect.objectContaining({ label: 'ethereum:chain-request', inPlace: true, sentSoFar: 0 }),
    ]);
    // The chain and account reads make no copy of the request.
    await page.ask('eth_chainId');
    await page.ask('eth_accounts');
    expect(env.copies).toHaveLength(1);
  });

  describe('a DNS name over IPNS', () => {
    function named() {
      const env = setup();
      env.names.set(NAME, IPNS_KEY);
      env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
      env.state.permissions.set(`ipns://${IPNS_KEY}`, { origin: `ipns://${IPNS_KEY}`, walletIndex: 1, chainId: 100 });
      const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
      return { env, page };
    }

    test('eth_accounts answers the name\'s account, checking the name before the core reads the grant and after its answer', async () => {
      const { env, page } = named();
      expect(await page.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      // The commit's check, then one before the core's request and one
      // after its answer.
      expect(env.resolutions).toEqual([NAME, NAME, NAME]);
      // The core read the name's grant.
      expect(env.core.grantReads).toEqual([NAME]);
    });

    test('once the name moves off the IPNS key, eth_accounts answers [] and the binding ends; reads still answer, with no resolution', async () => {
      const { env, page } = named();
      expect(await page.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      env.names.set(NAME, OTHER_IPNS_KEY);
      env.resolutions.length = 0;

      // The permission-free reads go to the core under the key as it
      // stands, resolving nothing.
      expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
      expect(await page.ask('net_version')).toEqual({ result: '100' });
      expect(await page.ask('eth_blockNumber')).toEqual({ result: 'eth_blockNumber@100' });
      expect(env.state.reads.at(-1).origin).toBe(NAME);
      expect(env.resolutions).toEqual([]);

      env.core.grantReads.length = 0;
      const asked = env.core.sent.length;
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.resolutions).toEqual([NAME]);
      // Answered before the core was asked.
      expect(env.core.sent).toHaveLength(asked);
      expect(env.trace.filter((e) => e.kind === 'name-checked').at(-1)).toMatchObject({ holds: false });

      // The binding has ended: the document is keyless now, so its next
      // eth_accounts resolves nothing, not even the IPNS key's own, and
      // goes to the core with the empty origin, which reads no grant; its
      // reads go under the empty origin too.
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.resolutions).toEqual([NAME]);
      expect(env.core.sent.at(-1).page.origin).toBe('');
      expect(env.core.grantReads).toEqual([]);
      expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
      expect(await page.ask('eth_blockNumber')).toEqual({ result: 'eth_blockNumber@100' });
      expect(env.state.reads.at(-1).origin).toBe('');

      // Even with the name answering again, a reload on the same key is
      // bound only by a fresh page:bind-name.
      env.names.set(NAME, IPNS_KEY);
      page.guest.commit(`ipns://${IPNS_KEY}/docs`);
      const reloaded = env.greet(page.guest);
      expect(await reloaded.ask('eth_accounts')).toEqual({ result: [SECOND] });
      expect(env.core.grantReads.at(-1)).toBe(`ipns://${IPNS_KEY}`);
    });

    // Main's wallet list is read for the core's world while the request
    // is out, between main's two checks.
    test('a name that moves while the wallets are read answers []', async () => {
      const { env, page } = named();
      env.state.derive = async () => {
        env.names.set(NAME, OTHER_IPNS_KEY);
        return env.state.wallets;
      };
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    });

    test('a frame that moved off its IPNS key during the resolution answers []', async () => {
      let release;
      const env = setup({
        resolveEnsContent: async () => {
          if (release === undefined) return { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY };
          await new Promise((resolve) => {
            release = resolve;
          });
          return { type: 'ok', protocol: 'ipns', decoded: IPNS_KEY };
        },
      });
      env.state.permissions.set(NAME, { walletIndex: 0 });
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      await flush();
      release = null;
      const answer = page.ask('eth_accounts');
      await flush();
      // The frame now shows another site, whose commit main hasn't seen yet.
      page.guest.mainFrame.url = `ipns://${OTHER_IPNS_KEY}/`;
      release();
      expect(await answer).toEqual({ result: [] });
    });

    describe('concurrent checks of one name', () => {
      // Every resolution waits until the test answers it, in order.
      function held() {
        const pending = [];
        const env = setup({
          resolveEnsContent: (name) =>
            new Promise((resolve) => {
              pending.push({ name, answer: (decoded) => resolve({ type: 'ok', protocol: 'ipns', decoded }) });
            }),
        });
        env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
        const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
        return { env, page, pending };
      }

      // Two eth_accounts, each at its last check, after the commit's and
      // each one's first have answered the bound key.
      async function atFinalChecks() {
        const { env, page, pending } = held();
        pending.shift().answer(IPNS_KEY);
        await flush();
        const a = page.ask('eth_accounts');
        const b = page.ask('eth_accounts');
        await flush();
        expect(pending).toHaveLength(2);
        for (const first of pending.splice(0)) first.answer(IPNS_KEY);
        await flush();
        expect(pending).toHaveLength(2);
        return { env, page, pending, a, b };
      }

      test('the first answering the bound key and the second elsewhere, in the same turn: both answer []', async () => {
        const { pending, a, b } = await atFinalChecks();
        const [first, second] = pending.splice(0);
        first.answer(IPNS_KEY);
        second.answer(OTHER_IPNS_KEY);
        expect({ a: await a, b: await b }).toEqual({ a: { result: [] }, b: { result: [] } });
      });

      test('the other order, in the same turn: both answer []', async () => {
        const { pending, a, b } = await atFinalChecks();
        const [first, second] = pending.splice(0);
        second.answer(OTHER_IPNS_KEY);
        first.answer(IPNS_KEY);
        expect({ a: await a, b: await b }).toEqual({ a: { result: [] }, b: { result: [] } });
      });

      test('a request answered before the name is found moved keeps its answer; the later one gets []', async () => {
        const { page, pending, a, b } = await atFinalChecks();
        const [first, second] = pending.splice(0);
        first.answer(IPNS_KEY);
        expect(await a).toEqual({ result: [ACCOUNT] });
        second.answer(OTHER_IPNS_KEY);
        expect(await b).toEqual({ result: [] });
        // The binding has ended: the next request resolves nothing.
        expect(await page.ask('eth_accounts')).toEqual({ result: [] });
        expect(pending).toEqual([]);
      });
    });

    test('the chrome may bind a name only for a guest it hosts', () => {
      const env = setup();
      const guest = new Guest({ window: 1 });
      env.guests.set(guest.id, guest);
      env.requests.track(guest);
      const own = { sender: guest.hostWebContents };
      const other = { sender: { id: 999 } };
      expect(env.requests.bindName(other, { guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(false);
      expect(env.requests.bindName(own, { guest: 12345, name: NAME, key: IPNS_KEY })).toBe(false);
      expect(env.requests.bindName(own, { guest: guest.id, name: 'name.eth', key: IPNS_KEY })).toBe(false);
      expect(env.requests.bindName(own, { guest: guest.id, name: NAME, key: 'not/a/key' })).toBe(false);
      expect(env.requests.bindName(own, null)).toBe(false);
      guest.destroyed = true;
      expect(env.requests.bindName(own, { guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(false);
      guest.destroyed = false;
      expect(env.requests.bindName(own, { guest: guest.id, name: NAME, key: IPNS_KEY })).toBe(true);
    });
  });

  // Main's gates before the agent's route and the core, which main's own
  // routes' tests covered until APB-4d removed those routes: the early exit
  // to the core with the switch off or no key, the custody gate on a
  // signature or a send, and the name checks before the agent and the core.
  describe("main's gates before the agent's route and the core", () => {
    // The methods the agent's route may answer, each as a page asks it.
    const ASKS = {
      eth_requestAccounts: (page) => page.ask('eth_requestAccounts'),
      personal_sign: (page) => page.ask('personal_sign', [MESSAGE, ACCOUNT]),
      eth_signTypedData_v4: (page) => page.ask('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(TYPED)]),
      eth_sendTransaction: (page) => page.send(TRANSFER),
    };
    const METHODS = Object.keys(ASKS);
    // Only a tab the agent holds is offered these.
    const GATED = ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'];

    // An agent route that would answer whatever it were offered.
    function eagerAgent(env) {
      env.state.agent = async () => ({ handled: true, result: HASH });
    }

    // The requests the core was sent, with the origin each went under.
    const sentToCore = (env) => env.core.sent.map((request) => [request.method, request.page.origin]);

    test('with the switch off, each goes straight to the core, which answers 4900: the agent is never offered it, even in custody', async () => {
      const env = setup({ wallets: SENDING_WALLETS });
      eagerAgent(env);
      env.connect();
      const page = env.tab(DAPP);
      env.state.custody.add(page.guest.id);
      env.state.enabled = false;
      for (const method of METHODS) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: DISCONNECTED });
      }
      expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
      expect(sentToCore(env)).toEqual(METHODS.map((method) => [method, KEY_A]));
      // From a tab the agent holds, as this test means them to be.
      expect(env.state.misrouted.map((request) => request.method)).toEqual(METHODS);
      env.state.misrouted.length = 0;
    });

    test("a keyless document's go straight to the core under the empty origin, which answers 4100: the agent is never offered them, even in custody", async () => {
      const env = setup({ wallets: SENDING_WALLETS });
      eagerAgent(env);
      const page = env.tab('data:text/html,<h1>keyless</h1>');
      env.state.custody.add(page.guest.id);
      for (const method of METHODS) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: NO_ADDRESS });
      }
      expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
      expect(sentToCore(env)).toEqual(METHODS.map((method) => [method, '']));
      expect(env.state.misrouted.map((request) => request.method)).toEqual(METHODS);
      env.state.misrouted.length = 0;
    });

    test('from a tab the agent does not hold, a signature or a send is never offered to the agent: the core answers it', async () => {
      const env = setup({ wallets: SENDING_WALLETS });
      eagerAgent(env);
      env.connect();
      const page = env.tab(DAPP);
      for (const method of GATED) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: STAND_IN_REFUSAL });
      }
      expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
      expect(sentToCore(env)).toEqual(GATED.map((method) => [method, KEY_A]));
    });

    describe('a DNS name over IPNS', () => {
      function bound({ custody = false } = {}) {
        const env = setup({ wallets: SENDING_WALLETS });
        env.names.set(NAME, IPNS_KEY);
        env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
        const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
        if (custody) env.state.custody.add(page.guest.id);
        return { env, page };
      }
      const lastNameCheck = (env) => env.trace.filter((entry) => entry.kind === 'name-checked').at(-1);

      test.each(METHODS)('outside custody, %s from a name that moved off its IPNS key answers 4100, and the core is never asked', async (method) => {
        const { env, page } = bound();
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        expect(await ASKS[method](page)).toEqual(NO_ADDRESS);
        expect(env.core.sent).toEqual([]);
        expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
        // The binding has ended.
        expect(lastNameCheck(env)).toMatchObject({ holds: false });
      });

      test.each(METHODS)('in custody, %s from a name that moved off its IPNS key is never offered to the agent, nor sent to the core', async (method) => {
        const { env, page } = bound({ custody: true });
        eagerAgent(env);
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        expect(await ASKS[method](page)).toEqual(NO_ADDRESS);
        expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
        expect(env.core.sent).toEqual([]);
      });

      // The agent's route declines a tab it no longer holds: main then asks
      // the core, but only after checking the name again.
      test.each(METHODS)('%s whose name moves while the agent declines it (its custody ended) answers 4100, and the core is never asked', async (method) => {
        const { env, page } = bound({ custody: true });
        env.state.agent = async () => {
          env.state.custody.delete(page.guest.id);
          env.names.set(NAME, OTHER_IPNS_KEY);
          return { handled: false };
        };
        expect(await ASKS[method](page)).toEqual(NO_ADDRESS);
        expect(env.deps.agentWalletRequest).toHaveBeenCalledTimes(1);
        expect(env.core.sent).toEqual([]);
        expect(lastNameCheck(env)).toMatchObject({ holds: false });
      });
    });
  });
});

// The agent's route for eth_requestAccounts (0011 PRQ-4), which stays in
// main until APR-7: the core is asked only when the agent doesn't take the
// request.
describe('eth_requestAccounts from a tab the agent holds', () => {
  test('a tab the agent holds is answered by the agent service, with no prompt', async () => {
    const env = setup();
    env.state.agent = async () => ({ handled: true, result: [SECOND] });
    const page = env.tab();
    expect(await page.ask('eth_requestAccounts')).toEqual({ result: [SECOND] });
    expect(env.deps.agentWalletRequest).toHaveBeenCalledWith(
      page.guest.id,
      { method: 'eth_requestAccounts', params: [], chainId: 100 },
      {
        signal: expect.any(AbortSignal),
        attested: { key: KEY_A, transportKey: KEY_A },
        beforeEffect: expect.any(Function),
        effectAllowed: expect.any(Function),
        grantWritten: expect.any(Function),
        // Main's issuer for the Agent's decision on a signature or a send
        // (design 0012, APB-1d); a connect mints nothing.
        pageToken: { mint: expect.any(Function), present: expect.any(Function), holds: expect.any(Function), discard: expect.any(Function) },
        pageContext: expect.any(Function),
      }
    );
    expect(env.prompts()).toEqual([]);
    env.state.agent = async () => ({ handled: true, error: { code: 4001, message: 'User rejected the request' } });
    expect(await page.ask('eth_requestAccounts')).toEqual(REJECTED);
    // The core was never asked.
    expect(env.core.sent).toEqual([]);
    // A tab it doesn't hold, or a route that fails, takes the prompt: the
    // core's, which main shows.
    env.state.agent = async () => {
      throw new Error('agent gone');
    };
    page.ask('eth_requestAccounts');
    await flush();
    expect(env.prompts()).toHaveLength(1);
    expect(env.core.sent).toHaveLength(1);
  });

  // The agent's own approval runs inside the request's life: the document's
  // one wallet slot, main's deadline and its document, and main's checks
  // before the grant the agent writes. The agent route here is the real
  // AgentWalletController, as the agent service calls it, with an approval
  // the test answers.
  describe('a tab the agent holds, inside the request\'s life', () => {
    // `holdAfter`: a promise the route waits on after the controller's
    // effect, before it answers, as the agent service once waited on the
    // Agent's steering: the request can end there.
    function withAgent(env, { pageUrl = null, withdrawOnAbort = false, holdAfter = null } = {}) {
      const approvals = [];
      env.state.walletIndexUpdates = [];
      // The agent holds the tabs opened from here on: the core is never
      // asked for them.
      const realTab = env.tab;
      env.tab = (...args) => {
        const page = realTab(...args);
        env.state.custody.add(page.guest.id);
        return page;
      };
      const controller = new AgentWalletController({
        identityManager: {
          getDerivedWallets: async () => env.state.wallets,
          getActiveWalletIndex: () => 0,
        },
        getPermission: (key) => env.state.permissions.get(key) || null,
        // The agent's grant goes to the core, as main's prompt's does.
        grantPermission: env.grantPermission,
        updateLastUsed: env.deps.updateLastUsed,
        updateWalletIndex: jest.fn((key, walletIndex) => {
          env.state.walletIndexUpdates.push([key, walletIndex]);
          const permission = env.state.permissions.get(key);
          if (permission) permission.walletIndex = walletIndex;
        }),
        getChain: (chainId) => ({ chainId, name: 'Gnosis Chain', nativeCurrency: { symbol: 'xDAI', decimals: 18 } }),
      });
      env.state.agent = async (guestId, request, options) => {
        const outcome = await controller.handleRequest(
          {
            tabId: `tab_${guestId}`,
            // The page the agent's run sees in that tab.
            pageUrl: pageUrl || env.guests.get(guestId).getURL(),
            conversationId: 'conversation_1',
            requestApproval: () =>
              new Promise((resolve) => {
                approvals.push({ resolve, signal: options.signal });
                if (withdrawOnAbort) options.signal.addEventListener('abort', () => resolve('withdrawn'));
              }),
            attested: options.attested,
            beforeEffect: options.beforeEffect,
            effectAllowed: options.effectAllowed,
            grantWritten: options.grantWritten,
            pageContext: options.pageContext,
          },
          request
        );
        if (holdAfter) await holdAfter;
        return outcome;
      };
      return approvals;
    }

    test('it connects under the attested key, the grant written once main\'s checks pass', async () => {
      const env = setup();
      const approvals = withAgent(env);
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      expect(approvals).toHaveLength(1);
      expect(env.prompts()).toEqual([]);
      approvals[0].resolve({ status: 'approved', walletIndex: 1 });
      expect(await answer).toEqual({ result: [SECOND] });
      expect(env.state.grants).toEqual([{ key: KEY_A, walletIndex: 1, chainId: 100 }]);
    });

    // #1192 round 1: the agent's first connect writes a grant, so the key's
    // pages hear it as from main's own connect.
    test('a first connect: accountsChanged to every live document of the key, and connect to the one that asked (PRQ-6)', async () => {
      const env = setup();
      const approvals = withAgent(env);
      const other = env.tab(`${KEY_A}/other`, { front: false });
      const elsewhere = env.tab(OTHER, { front: false });
      const inWindow2 = env.tab(`${KEY_A}/x`, { window: 2, front: false });
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      approvals[0].resolve({ status: 'approved', walletIndex: 1 });
      expect(await answer).toEqual({ result: [SECOND] });
      await flush();
      expect(page.guest.events).toEqual([
        ['accountsChanged', [SECOND]],
        ['connect', { chainId: '0x64' }],
      ]);
      expect(other.guest.events).toEqual([['accountsChanged', [SECOND]]]);
      expect(inWindow2.guest.events).toEqual([['accountsChanged', [SECOND]]]);
      expect(elsewhere.guest.events).toEqual([]);
    });

    // #1192 round 2: what the agent's write did is decided in its guarded
    // run and told there, not inferred from the store before its wait.
    test('a grant revoked while the agent\'s approval waits: the approval creates it again, announced once, after the revocation\'s event', async () => {
      const env = setup();
      env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 0, chainId: 100 });
      const approvals = withAgent(env);
      const events = createPageEvents({
        requests: () => env.requests,
        getDerivedWallets: async () => env.state.wallets,
        normalizeKey: normalizeOrigin,
      });
      const other = env.tab(`${KEY_A}/other`, { front: false });
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      // The user disconnects the site while the agent's approval is open.
      env.state.permissions.delete(KEY_A);
      await events.grantChanged({ key: KEY_A, walletIndex: null });
      approvals[0].resolve({ status: 'approved', walletIndex: 1 });
      expect(await answer).toEqual({ result: [SECOND] });
      await flush();
      expect(env.state.grants).toEqual([{ key: KEY_A, walletIndex: 1, chainId: 100 }]);
      expect(page.guest.events).toEqual([
        ['accountsChanged', []],
        ['accountsChanged', [SECOND]],
        ['connect', { chainId: '0x64' }],
      ]);
      expect(other.guest.events).toEqual([
        ['accountsChanged', []],
        ['accountsChanged', [SECOND]],
      ]);
    });

    test('a site connected through main\'s prompt while the agent\'s approval waits: the approval creates nothing, so nothing is announced twice', async () => {
      const env = setup();
      const approvals = withAgent(env);
      const agentRoute = env.state.agent;
      const page = env.tab();
      // Another page of the key, in window 2, which the agent doesn't hold.
      const other = env.tab(`${KEY_A}/other`, { window: 2 });
      env.state.custody.delete(other.guest.id);
      env.state.agent = (guestId, request, options) =>
        guestId === page.guest.id ? agentRoute(guestId, request, options) : { handled: false };
      const answer = page.ask('eth_requestAccounts');
      await flush();
      expect(approvals).toHaveLength(1);
      // The other page connects through main's prompt meanwhile.
      const otherAnswer = other.ask('eth_requestAccounts');
      await flush();
      const [prompt] = env.prompts(2);
      await env.decide(prompt.handle, true, { walletIndex: 0 }, 2);
      expect(await otherAnswer).toEqual({ result: [ACCOUNT] });
      await flush();
      // Then the agent's approval picks the same account: the grant is left
      // as it is.
      approvals[0].resolve({ status: 'approved', walletIndex: 0 });
      expect(await answer).toEqual({ result: [ACCOUNT] });
      await flush();
      expect(env.state.grants).toEqual([{ key: KEY_A, walletIndex: 0, chainId: 100 }]);
      expect(other.guest.events).toEqual([
        ['accountsChanged', [ACCOUNT]],
        ['connect', { chainId: '0x64' }],
      ]);
      // The agent's page heard main's connect once, and no "first" connect
      // of its own.
      expect(page.guest.events).toEqual([['accountsChanged', [ACCOUNT]]]);
    });

    // #1192 round 3: a grant the agent wrote whose request then ended
    // without its answer. The grant exists, so the key's other pages hear
    // it; the page that asked, which never got the account, hears nothing.
    describe('the request ends after the agent\'s write, before its answer', () => {
      function written() {
        const env = setup();
        let release;
        const holdAfter = new Promise((resolve) => (release = resolve));
        const approvals = withAgent(env, { holdAfter });
        const other = env.tab(`${KEY_A}/other`, { front: false });
        const inWindow2 = env.tab(`${KEY_A}/x`, { window: 2, front: false });
        const elsewhere = env.tab(OTHER, { front: false });
        const page = env.tab();
        return { env, approvals, release, other, inWindow2, elsewhere, page };
      }

      async function writeAndHold({ env, approvals, page }) {
        const answer = page.ask('eth_requestAccounts');
        await flush();
        approvals[0].resolve({ status: 'approved', walletIndex: 1 });
        await flush();
        // Written, and the answer held behind it.
        expect(env.state.grants).toEqual([{ key: KEY_A, walletIndex: 1, chainId: 100 }]);
        // Wrapped: an async function returning the answer itself would wait for it.
        return { answer };
      }

      test('its deadline: the page hears "Request timed out" and no event; the key\'s other pages hear the account', async () => {
        const t = written();
        const { answer } = await writeAndHold(t);
        t.env.expire();
        expect(await answer).toEqual({ error: { message: 'Request timed out' } });
        await flush();
        t.release();
        await flush();
        expect(t.page.guest.events).toEqual([]);
        expect(t.other.guest.events).toEqual([['accountsChanged', [SECOND]]]);
        expect(t.inWindow2.guest.events).toEqual([['accountsChanged', [SECOND]]]);
        expect(t.elsewhere.guest.events).toEqual([]);
        expect(t.env.state.grants).toHaveLength(1);
      });

      test('its tab closed: the page gets no answer and no event; the key\'s other pages hear the account', async () => {
        const t = written();
        const { answer } = await writeAndHold(t);
        t.page.guest.destroyed = true;
        t.page.guest.emit('destroyed');
        expect(await answer).toEqual({ gone: true });
        await flush();
        t.release();
        await flush();
        expect(t.page.guest.events).toEqual([]);
        expect(t.other.guest.events).toEqual([['accountsChanged', [SECOND]]]);
        expect(t.inWindow2.guest.events).toEqual([['accountsChanged', [SECOND]]]);
        expect(t.elsewhere.guest.events).toEqual([]);
      });

      test('answered in time: the page hears the account and connect, once', async () => {
        const t = written();
        const { answer } = await writeAndHold(t);
        t.release();
        expect(await answer).toEqual({ result: [SECOND] });
        await flush();
        expect(t.page.guest.events).toEqual([
          ['accountsChanged', [SECOND]],
          ['connect', { chainId: '0x64' }],
        ]);
        expect(t.other.guest.events).toEqual([['accountsChanged', [SECOND]]]);
      });
    });

    test('a connected site\'s agent approval writes no new grant, so sends no new-grant events (an account change is the grant store\'s to tell)', async () => {
      const env = setup();
      env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 1, chainId: 100 });
      const approvals = withAgent(env);
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      approvals[0].resolve({ status: 'approved', walletIndex: 1 });
      expect(await answer).toEqual({ result: [SECOND] });
      await flush();
      expect(page.guest.events).toEqual([]);
    });

    test('a declined agent approval sends nothing', async () => {
      const env = setup();
      const approvals = withAgent(env);
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      approvals[0].resolve('declined');
      expect((await answer).error).toBeDefined();
      await flush();
      expect(page.guest.events).toEqual([]);
      expect(env.state.grants).toEqual([]);
    });

    test('it holds the document\'s one wallet slot: the next request gets -32002, another document\'s doesn\'t', async () => {
      const env = setup();
      const approvals = withAgent(env);
      const page = env.tab();
      const other = env.tab(OTHER, { front: false });
      const first = page.ask('eth_requestAccounts');
      await flush();
      expect(await page.ask('eth_requestAccounts')).toEqual({
        error: { code: -32002, message: 'Another wallet request is already pending' },
      });
      expect(approvals).toHaveLength(1);
      other.ask('eth_requestAccounts');
      await flush();
      expect(approvals).toHaveLength(2);
      approvals[0].resolve('declined');
      expect(await first).toEqual(REJECTED);
      // Answered: the slot is free again.
      page.ask('eth_requestAccounts');
      await flush();
      expect(approvals).toHaveLength(3);
    });

    test('main\'s deadline answers "Request timed out", withdraws the approval, and an approval after it writes nothing', async () => {
      const env = setup();
      const approvals = withAgent(env);
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      expect(approvals[0].signal.aborted).toBe(false);
      env.expire();
      expect(await answer).toEqual({ error: { message: 'Request timed out' } });
      expect(approvals[0].signal.aborted).toBe(true);
      // The agent's approval goes through anyway, later.
      approvals[0].resolve({ status: 'approved', walletIndex: 0 });
      await flush();
      expect(env.state.grants).toEqual([]);
      expect(env.state.lastUsed).toEqual([]);
      // Nothing written, so nothing told (PRQ-6).
      expect(page.guest.events).toEqual([]);
      // And the document may ask again.
      page.ask('eth_requestAccounts');
      await flush();
      expect(approvals).toHaveLength(2);
    });

    test('a connected site: the agent\'s approval updates its grant (account, chain, last used)', async () => {
      const env = setup();
      env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 0, chainId: 1 });
      const approvals = withAgent(env);
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      approvals[0].resolve({ status: 'approved', walletIndex: 1 });
      expect(await answer).toEqual({ result: [SECOND] });
      expect(env.state.walletIndexUpdates).toEqual([[KEY_A, 1]]);
      expect(env.state.lastUsed).toEqual([[KEY_A, 100]]);
      expect(env.state.permissions.get(KEY_A)).toMatchObject({ walletIndex: 1, chainId: 100 });
      expect(env.state.grants).toEqual([]);
    });

    test('a connected site\'s agent approval after the deadline leaves its grant unchanged', async () => {
      const env = setup();
      env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 0, chainId: 1 });
      const approvals = withAgent(env);
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      env.expire();
      expect(await answer).toEqual({ error: { message: 'Request timed out' } });
      approvals[0].resolve({ status: 'approved', walletIndex: 1 });
      await flush();
      expect(env.state.walletIndexUpdates).toEqual([]);
      expect(env.state.lastUsed).toEqual([]);
      expect(env.state.grants).toEqual([]);
      expect(env.state.permissions.get(KEY_A)).toMatchObject({ walletIndex: 0, chainId: 1 });
    });

    test('a document that goes while the approval is open: withdrawn, and nothing written', async () => {
      const env = setup();
      const approvals = withAgent(env, { withdrawOnAbort: true });
      const page = env.tab();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      page.guest.commit(OTHER);
      expect(await answer).toEqual({ gone: true });
      expect(approvals[0].signal.aborted).toBe(true);
      await flush();
      expect(env.state.grants).toEqual([]);
    });

    describe('a DNS name over IPNS', () => {
      function named(options = {}) {
        const env = setup();
        env.names.set(NAME, IPNS_KEY);
        const approvals = withAgent(env, { pageUrl: `ipns://${IPNS_KEY}/docs`, ...options });
        const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
        return { env, page, approvals };
      }

      test('an honest named page connects under custody, under its name', async () => {
        const { env, page, approvals } = named();
        const answer = page.ask('eth_requestAccounts');
        await flush();
        env.resolutions.length = 0;
        approvals[0].resolve({ status: 'approved', walletIndex: 0 });
        expect(await answer).toEqual({ result: [ACCOUNT] });
        expect(env.state.grants).toEqual([{ key: NAME, walletIndex: 0, chainId: 100 }]);
        // Checked again before the write.
        expect(env.resolutions).toEqual([NAME]);
      });

      test('a name that moves while the agent\'s approval is open gets no grant', async () => {
        const { env, page, approvals } = named();
        const answer = page.ask('eth_requestAccounts');
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        approvals[0].resolve({ status: 'approved', walletIndex: 0 });
        expect(await answer).toEqual(NO_ADDRESS);
        expect(env.state.grants).toEqual([]);
      });

      test('a connected name: the agent\'s approval updates its grant after the name is checked again', async () => {
        const { env, page, approvals } = named();
        env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 1 });
        const answer = page.ask('eth_requestAccounts');
        await flush();
        env.resolutions.length = 0;
        approvals[0].resolve({ status: 'approved', walletIndex: 1 });
        expect(await answer).toEqual({ result: [SECOND] });
        expect(env.resolutions).toEqual([NAME]);
        expect(env.state.permissions.get(NAME)).toMatchObject({ walletIndex: 1, chainId: 100 });
      });

      test('a connected name that moves while the agent\'s approval is open keeps its grant unchanged', async () => {
        const { env, page, approvals } = named();
        env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 1 });
        const answer = page.ask('eth_requestAccounts');
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        approvals[0].resolve({ status: 'approved', walletIndex: 1 });
        expect(await answer).toEqual(NO_ADDRESS);
        expect(env.state.walletIndexUpdates).toEqual([]);
        expect(env.state.lastUsed).toEqual([]);
        expect(env.state.permissions.get(NAME)).toMatchObject({ walletIndex: 0, chainId: 1 });
      });

      test('a name that has moved before it asks never reaches the agent', async () => {
        const { env, page, approvals } = named();
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        expect(await page.ask('eth_requestAccounts')).toEqual(NO_ADDRESS);
        expect(approvals).toEqual([]);
        expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
      });
    });
  });
});

describe('a tab the agent holds: its signature inside the request', () => {
  function withAgent(env, { withdrawOnAbort = false } = {}) {
    const approvals = [];
    // The agent drives only tabs in its custody.
    const realTab = env.tab;
    env.tab = (...args) => {
      const page = realTab(...args);
      env.state.custody.add(page.guest.id);
      return page;
    };
    const controller = new AgentWalletController({
      identityManager: { getDerivedWallets: async () => env.state.wallets, getActiveWalletIndex: () => 0 },
      getPermission: (key) => env.state.permissions.get(key) || null,
      grantPermission: jest.fn(),
      updateLastUsed: env.deps.updateLastUsed,
      updateWalletIndex: jest.fn(),
      getChain: (chainId) => ({ chainId, name: 'Gnosis Chain', nativeCurrency: { symbol: 'xDAI', decimals: 18 } }),
      getSigner: (index, authorized) => {
        env.state.agentSigners.push([index, authorized]);
        return agentSigner(env, index, authorized);
      },
    });
    env.state.agentSigners = [];
    env.state.agent = (guestId, request, options) =>
      controller.handleRequest(
        {
          tabId: `tab_${guestId}`,
          pageUrl: env.guests.get(guestId).getURL(),
          conversationId: 'conversation_1',
          requestApproval: () =>
            new Promise((resolve) => {
              approvals.push({ resolve, signal: options.signal });
              if (withdrawOnAbort) options.signal.addEventListener('abort', () => resolve('withdrawn'));
            }),
          attested: options.attested,
          beforeEffect: options.beforeEffect,
          effectAllowed: options.effectAllowed,
          pageToken: options.pageToken,
          pageContext: options.pageContext,
        },
        request
      );
    return approvals;
  }

  // The agent's signer as the identity core checks it (simulated): what it
  // presents (`signers.js`) is checked before the signature, a token for its
  // kind, page and handle, and burnt there. As `signers.js` runs it, its own
  // wait comes first (the address, the core's hash, a device's spend; held
  // when a test sets `env.state.agentSignerWait`), then the caller's last
  // check (`beforeSign`), then the core.
  function agentSigner(env, index, authorized) {
    const presented = authorized?.confirmation
      ? confirmations.signingAuthorization(authorized.confirmation)
      : { page: authorized?.page ?? null };
    const lastStep = async () => {
      const wait = env.state.agentSignerWait;
      if (wait) {
        wait.reached.resolve();
        await wait.promise;
      }
      if (authorized?.beforeSign) await authorized.beforeSign();
    };
    return {
      signMessage: async (message) => {
        await lastStep();
        mockApprovals.authorize(
          'sign.message',
          index,
          { message: `0x${messageToBytes(normalizeMessage(message)).toString('hex')}` },
          presented
        );
        return env.signer.signMessage(message);
      },
      signTypedData: async (data, options = {}) => {
        await lastStep();
        const bound = authorized?.confirmation?.payload ?? {};
        mockApprovals.authorize(
          'sign.typed_data',
          index,
          {
            typed_data: toCoreTypedData(normalizeTypedData(data)),
            ...(bound.primary_type !== undefined ? { primary_type: bound.primary_type } : {}),
            ...(bound.chain_id !== undefined ? { chain_id: bound.chain_id } : {}),
            expected_hash: options.expectedHash,
          },
          presented
        );
        return env.signer.signTypedData(data, options);
      },
    };
  }

  // Every signature the core was asked for: under `page`, with a token.
  const signatures = () => mockApprovals.calls.filter((call) => call.method.startsWith('sign.'));

  test('it signs under the attested key once approved, holding the document\'s slot', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(approvals).toHaveLength(1);
    expect(env.prompts()).toEqual([]);
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual({
      error: { code: -32002, message: 'Another wallet request is already pending' },
    });
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: '0xmsgsig' });
    expect(env.state.signed).toEqual([['message', MESSAGE]]);
  });

  // Design 0012 (APB-1d): a page request the Agent answers is a page
  // request. Its decision mints the request's page-kind token through
  // main's issuer, under `page` with the request's PageContext (`agent:
  // true`) and a handle main drew for it, and the signature presents that
  // token under `page`, never as main's own.
  test.each([
    ['personal_sign', [MESSAGE, ACCOUNT], 'sign-message', 'sign.message', '0xmsgsig'],
    ['eth_signTypedData_v4', [ACCOUNT, TYPED], 'sign-typed-data', 'sign.typed_data', '0xtypedsig'],
  ])("%s: the Agent's decision mints its page-kind token, and the signature presents it under `page` with agent: true", async (method, params, kind, signMethod, signature) => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask(method, params);
    await flush();
    // Nothing is minted before the Agent decides.
    expect(mockApprovals.calls).toEqual([]);
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: signature });
    const PAGE = { origin: KEY_A, top_origin: KEY_A, frame: page.guest.mainFrame.frameTreeNodeId, navigation: expect.any(Number), agent: true };
    expect(env.minted()).toEqual([expect.objectContaining({ token: kind, by: 'agent' })]);
    const [issue] = mockApprovals.calls;
    expect(issue).toMatchObject({ method: 'approval.issue', params: { kind, account: 0 }, page: PAGE });
    const handle = issue.params.handle;
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    // The signer was handed that token, under the PageContext read again,
    // with main's gate as its last step.
    expect(env.state.agentSigners).toEqual([
      [0, { confirmation: expect.objectContaining({ kind, account: 0, handle, page: PAGE }), beforeSign: expect.any(Function) }],
    ]);
    // The core saw one signature, under `page`, with the token: spent there.
    expect(signatures()).toEqual([
      expect.objectContaining({ method: signMethod, page: PAGE, params: expect.objectContaining({ authorization: { token: expect.any(String), handle } }) }),
    ]);
    expect(signatures().filter((call) => !call.page)).toEqual([]);
    expect(mockApprovals.outstanding()).toBe(0);
    if (kind === 'sign-typed-data') {
      // Viewed on the page's chain; the hash the core bound is the one signed.
      expect(issue.params.payload).toMatchObject({ primary_type: 'Order', chain_id: '100' });
      expect(env.state.signed).toEqual([['typed', TYPED, { expectedHash: TYPED_HASH }]]);
    }
  });

  test('a standing rule never answers it: the Agent decides, and its token signs', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect(KEY_A, 0, { autoApprove: { signing: true } });
    mockApprovals.setStanding(() => ({ covered: true }));
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(approvals).toHaveLength(1);
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: '0xmsgsig' });
    // The site's rule is the core's, and the core was never asked.
    expect(env.core.sent).toEqual([]);
    expect(mockApprovals.calls.filter((call) => call.method === 'approval.check')).toEqual([]);
    expect(signatures()).toEqual([
      expect.objectContaining({ page: expect.objectContaining({ agent: true }), params: expect.objectContaining({ authorization: expect.objectContaining({ token: expect.any(String) }) }) }),
    ]);
  });

  test('declined by the Agent: nothing minted, nothing signed', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    approvals[0].resolve('declined');
    expect(await answer).toEqual(REJECTED);
    expect(mockApprovals.calls).toEqual([]);
    expect(env.state.signed).toEqual([]);
  });

  test('a tab the agent no longer holds at its decision mints nothing, and signs nothing', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.state.custody.delete(page.guest.id);
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } });
    expect(mockApprovals.calls).toEqual([]);
    expect(env.state.signed).toEqual([]);
  });

  test('custody ending between the mint and the signature: the token burnt, nothing signed', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const issue = mockApprovals.approval.issue;
    const spy = jest.spyOn(mockApprovals.approval, 'issue').mockImplementationOnce(async (...args) => {
      const minted = await issue(...args);
      env.state.custody.delete(page.guest.id);
      return minted;
    });
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } });
    spy.mockRestore();
    expect(signatures()).toEqual([]);
    expect(mockApprovals.calls.filter((call) => call.method === 'approval.discard')).not.toEqual([]);
    expect(mockApprovals.outstanding()).toBe(0);
    expect(env.state.signed).toEqual([]);
  });

  // Main's issuer for the Agent mints only within the request's wallet
  // operation, once, and only the kinds the Agent answers.
  test('main mints for the Agent once per request, within its operation, only its kinds', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const tokens = [];
    let held = null;
    env.state.agent = async (_guestId, _request, options) => {
      held = options.pageToken;
      await expect(options.pageToken.mint('safe-message', 0, { method: 'personal_sign', params: [] })).rejects.toThrow(
        /Not a kind the Agent answers/
      );
      await expect(options.pageToken.mint('wallet-send', 0, {})).rejects.toThrow(/Not a kind the Agent answers/);
      tokens.push(await options.pageToken.mint('sign-message', 0, MESSAGE));
      await expect(options.pageToken.mint('sign-message', 0, MESSAGE)).rejects.toThrow(/this request has been decided/);
      options.pageToken.discard(tokens[0]);
      return { handled: true, error: { code: 4001, message: 'User rejected the request' } };
    };
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(REJECTED);
    expect(tokens).toHaveLength(1);
    expect(mockApprovals.calls.filter((call) => call.method === 'approval.issue')).toHaveLength(1);
    // After the request: nothing more, and the token isn't presented.
    await expect(held.mint('sign-message', 0, MESSAGE)).rejects.toThrow(/no live request the Agent answers/);
    expect(() => held.present(tokens[0])).toThrow(/Signing was not confirmed/);
    expect(mockApprovals.outstanding()).toBe(0);
  });

  // Codex on #1246: whether the Agent's decision still holds, read at the
  // signer's last step: the request, its document and key, the token this
  // decision's, and the agent's custody, read now. A refusal burns the
  // token if it is still unspent.
  test("main's issuer reads the Agent's decision again: its request, its token and its tab, now", async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    let held = null;
    let token = null;
    env.state.agent = async (_guestId, _request, options) => {
      held = options.pageToken;
      token = await held.mint('sign-message', 0, MESSAGE);
      expect(() => held.holds(token)).not.toThrow();
      held.present(token);
      // Spent there: the decision still holds after its presentation.
      expect(() => held.holds(token)).not.toThrow();
      expect(() => held.holds({ ...token, handle: 'f'.repeat(64) })).toThrow(/not the confirmation of this request/);
      expect(() => held.holds(null)).toThrow(/not the confirmation of this request/);
      env.state.custody.delete(page.guest.id);
      expect(() => held.holds(token)).toThrow(/the Agent no longer holds this tab/);
      env.state.custody.add(page.guest.id);
      expect(() => held.holds(token)).not.toThrow();
      return { handled: true, error: { code: 4001, message: 'User rejected the request' } };
    };
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(REJECTED);
    // After the request: it no longer holds.
    expect(() => held.holds(token)).toThrow(/the document that asked has gone/);
    // An unspent token it refuses is burnt.
    const discards = () => mockApprovals.calls.filter((call) => call.method === 'approval.discard').length;
    const before = discards();
    env.state.agent = async (_guestId, _request, options) => {
      const fresh = await options.pageToken.mint('sign-message', 0, MESSAGE);
      env.state.custody.delete(page.guest.id);
      expect(() => options.pageToken.holds(fresh)).toThrow(/the Agent no longer holds this tab/);
      return { handled: true, error: { code: 4001, message: 'User rejected the request' } };
    };
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(REJECTED);
    expect(discards()).toBe(before + 1);
    expect(mockApprovals.outstanding()).toBe(0);
  });

  test("withdrawn at main's deadline: the agent's later approval signs nothing", async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
    await flush();
    env.expire();
    expect(await answer).toEqual({ error: { message: 'Request timed out' } });
    expect(approvals[0].signal.aborted).toBe(true);
    approvals[0].resolve('approved');
    await flush();
    expect(env.state.signed).toEqual([]);
  });

  test.each([
    ['its document navigates', (page) => page.guest.commit(`${KEY_A}/next`)],
    ['its tab closes', (page) => page.guest.destroy()],
  ])('withdrawn when %s: the agent\'s later approval signs nothing', async (_label, end) => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.connect();
    const approvals = withAgent(env);
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    end(page);
    expect(await answer).toBe(GONE);
    approvals[0].resolve('approved');
    await flush();
    expect(env.state.signed).toEqual([]);
  });

  test('the name is checked again just before the signature: one that moved gets none', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const approvals = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    approvals[0].resolve('approved');
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.signed).toEqual([]);
  });

  // Codex on #1246: the name, checked before the mint, is checked again
  // after it: the core's mint is a wait, and a DNS name over IPNS can move
  // during it.
  test.each([
    ['personal_sign', [MESSAGE, ACCOUNT]],
    ['eth_signTypedData_v4', [ACCOUNT, TYPED]],
  ])('%s: a name that moves while the Agent\'s token is minted: no signer asked, nothing signed, the token burnt', async (method, params) => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const approvals = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const minting = deferred();
    const release = deferred();
    const issue = mockApprovals.approval.issue;
    const spy = jest.spyOn(mockApprovals.approval, 'issue').mockImplementationOnce(async (...args) => {
      minting.resolve();
      await release.promise;
      return issue(...args);
    });
    try {
      const answer = page.ask(method, params);
      await flush();
      approvals[0].resolve('approved');
      await minting.promise;
      env.names.set(NAME, OTHER_IPNS_KEY);
      release.resolve();
      expect(await answer).toEqual(NO_ADDRESS);
    } finally {
      spy.mockRestore();
    }
    expect(env.state.agentSigners).toEqual([]);
    expect(signatures()).toEqual([]);
    expect(env.state.signed).toEqual([]);
    expect(mockApprovals.outstanding()).toBe(0);
  });

  // Codex on #1246: main presented the token as the signer was built, and
  // the signer waits after that (the address, the core's hash, a device's
  // spend); its last step reads the name, the document and the tab again,
  // right before the core is asked.
  test.each([
    ['personal_sign', [MESSAGE, ACCOUNT]],
    ['eth_signTypedData_v4', [ACCOUNT, TYPED]],
  ])("%s: the signer's last step, after its own wait, is main's gate: the tab, the document or the name changed there signs nothing", async (method, params) => {
    for (const [label, change, expected] of [
      ['the agent leaves the tab', (env, page) => env.state.custody.delete(page.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }],
      ['the document navigates', (env, page) => page.guest.commit(`ipns://${IPNS_KEY}/next`), GONE],
      ['the name moves', (env) => env.names.set(NAME, OTHER_IPNS_KEY), NO_ADDRESS],
      ['nothing changes', () => {}, null],
    ]) {
      mockApprovals.reset();
      const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
      env.names.set(NAME, IPNS_KEY);
      env.connect(NAME);
      const approvals = withAgent(env);
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      env.state.agentSignerWait = { ...deferred(), reached: deferred() };
      const answer = page.ask(method, params);
      await flush();
      approvals[0].resolve('approved');
      await env.state.agentSignerWait.reached.promise;
      // Presented: the signer was built with the token, and waits.
      expect({ label, signers: env.state.agentSigners.length }).toEqual({ label, signers: 1 });
      change(env, page);
      env.state.agentSignerWait.resolve();
      if (expected) {
        expect({ label, answer: await answer }).toEqual({ label, answer: expected });
        await flush();
        expect({ label, signatures: signatures() }).toEqual({ label, signatures: [] });
        expect({ label, signed: env.state.signed }).toEqual({ label, signed: [] });
        // Burnt: never spent, discarded.
        expect({ label, outstanding: mockApprovals.outstanding() }).toEqual({ label, outstanding: 0 });
      } else {
        expect({ label, answer: await answer }).toEqual({ label, answer: { result: expect.any(String) } });
        expect({ label, signatures: signatures().length }).toEqual({ label, signatures: 1 });
      }
    }
  });

  test('an honest name signs under custody, under its name', async () => {
    const env = setup({ agentContext: true, wallets: SIGNING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const approvals = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: '0xmsgsig' });
    expect(env.state.lastUsed).toEqual([[NAME, 100]]);
  });
});

describe('a tab the agent holds: its send inside the request', () => {
  function withAgent(env, { withdrawOnAbort = false } = {}) {
    const approvals = [];
    const realTab = env.tab;
    env.tab = (...args) => {
      const page = realTab(...args);
      env.state.custody.add(page.guest.id);
      return page;
    };
    const agentSends = [];
    const agentCommitted = [];
    const agentSigners = [];
    const controller = new AgentWalletController({
      identityManager: { getDerivedWallets: async () => env.state.wallets, getActiveWalletIndex: () => 0 },
      getPermission: (key) => env.state.permissions.get(key) || null,
      grantPermission: jest.fn(),
      updateLastUsed: env.deps.updateLastUsed,
      updateWalletIndex: jest.fn(),
      getChain: (chainId) => ({ chainId, name: 'Gnosis Chain', nativeCurrency: { symbol: 'xDAI', decimals: 18 } }),
      // The agent's signer as the identity core checks it (simulated):
      // what it presents (`signers.js`) is checked as it signs, after the
      // caller's last check (`beforeSign`), which `signers.js` awaits right
      // before the core or the device is asked.
      getSigner: (index, authorized) => {
        agentSigners.push([index, authorized]);
        const checked = coreCheckedSigner(mockApprovals, { signTransaction: async () => '0xsigned' }, index, authorized);
        return {
          ...checked,
          signTransaction: async (tx) => {
            if (authorized?.beforeSign) await authorized.beforeSign();
            env.state.agentSignerAsked = (env.state.agentSignerAsked || 0) + 1;
            return checked.signTransaction(tx);
          },
        };
      },
      estimateGas: async () => ({ gasLimit: '21000' }),
      getGasPrices: async () => ({ type: 'legacy', gasPrice: '1000000000' }),
      // As the transaction service runs it: the signature at the nonce main
      // chose, the signer's wait, then the caller's guard, which commits the
      // signed bytes itself or withdraws them, then the broadcast.
      signAndRecord: async (tx, signer, context, options) => {
        agentSends.push({ tx, context });
        // The service's own waits before it asks the signer (the fee, the
        // address, the nonce), when a test holds them.
        const wait = env.state.agentServiceWait;
        if (wait) {
          wait.reached.resolve();
          await wait.promise;
        }
        await signer.signTransaction(buildTransaction({ ...tx, nonce: 3 }));
        if (env.state.agentSignerHold) await env.state.agentSignerHold.promise;
        const commit = async () => {
          agentCommitted.push(tx);
          return {};
        };
        await (options?.guardCommit ? options.guardCommit(commit) : commit());
        env.state.afterAgentSend?.();
        return { hash: HASH, paymentId: 'payment_1' };
      },
    });
    env.state.agent = (guestId, request, options) =>
      controller.handleRequest(
        {
          tabId: `tab_${guestId}`,
          pageUrl: env.guests.get(guestId).getURL(),
          conversationId: 'conversation_1',
          requestApproval: () =>
            new Promise((resolve) => {
              approvals.push({ resolve, signal: options.signal });
              if (withdrawOnAbort) options.signal.addEventListener('abort', () => resolve('withdrawn'));
            }),
          attested: options.attested,
          beforeEffect: options.beforeEffect,
          effectAllowed: options.effectAllowed,
          pageToken: options.pageToken,
          pageContext: options.pageContext,
        },
        request
      );
    return { approvals, agentSends, agentCommitted, agentSigners };
  }

  // Every signature the core was asked for.
  const signatures = () => mockApprovals.calls.filter((call) => call.method.startsWith('sign.'));

  test("it sends under the attested key once approved, holding the document's slot", async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect();
    const { approvals, agentSends } = withAgent(env);
    const page = env.tab();
    const answer = page.send(TRANSFER);
    await flush();
    expect(approvals).toHaveLength(1);
    expect(env.prompts()).toEqual([]);
    expect(await page.send(TRANSFER)).toEqual(PENDING);
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: HASH });
    expect(agentSends).toEqual([expect.objectContaining({ context: { kind: 'dapp-send', origin: KEY_A } })]);
    expect(env.state.lastUsed).toEqual([[KEY_A, 100]]);
    // The core's path was never asked.
    expect(env.core.sent).toEqual([]);
  });

  // Design 0012 (APB-1d): the Agent's decision mints the request's
  // `dapp-send` token through main's issuer, under `page` with the
  // request's PageContext (`agent: true`) and a handle main drew for it;
  // the send presents it under `page`, naming its kind, never as main's own.
  test.each([
    ['a vault account', 0, ACCOUNT],
    ['a phone account, unjudged by the fee check', PHONE_INDEX, PHONE],
  ])("%s: the Agent's decision mints a dapp-send token, and the send presents it under `page` with agent: true", async (_label, walletIndex) => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect(KEY_A, walletIndex);
    const { approvals, agentSigners } = withAgent(env);
    const page = env.tab();
    const answer = page.send(TRANSFER);
    await flush();
    expect(mockApprovals.calls).toEqual([]);
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: HASH });
    const PAGE = { origin: KEY_A, top_origin: KEY_A, frame: page.guest.mainFrame.frameTreeNodeId, navigation: expect.any(Number), agent: true };
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'dapp-send', by: 'agent' })]);
    const [issue] = mockApprovals.calls;
    expect(issue).toMatchObject({ method: 'approval.issue', params: { kind: 'dapp-send', account: walletIndex }, page: PAGE });
    // No "Always allow", no fee acknowledged; a phone's send names itself.
    expect(issue.params.payload).not.toHaveProperty('remember');
    expect(issue.params).not.toHaveProperty('fee_ack');
    expect(issue.params.phone).toBe(walletIndex === PHONE_INDEX ? true : undefined);
    const handle = issue.params.handle;
    expect(handle).toMatch(/^[0-9a-f]{64}$/);
    expect(agentSigners).toEqual([
      [
        walletIndex,
        { confirmation: expect.objectContaining({ kind: 'dapp-send', account: walletIndex, handle, page: PAGE }), beforeSign: expect.any(Function) },
      ],
    ]);
    expect(signatures()).toEqual([
      expect.objectContaining({
        method: 'sign.transaction',
        page: PAGE,
        params: expect.objectContaining({ authorization: { token: expect.any(String), kind: 'dapp-send', handle } }),
      }),
    ]);
    expect(mockApprovals.outstanding()).toBe(0);
  });

  test('a contract rule never answers it: the Agent decides, and its token signs', async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect();
    // The site's contract rule is the core's: its check covers any request
    // it is asked about.
    mockApprovals.setStanding(() => ({ covered: true }));
    const { approvals } = withAgent(env);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    expect(approvals).toHaveLength(1);
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: HASH });
    expect(mockApprovals.calls.filter((call) => call.method === 'approval.check')).toEqual([]);
    expect(signatures()).toEqual([
      expect.objectContaining({
        page: expect.objectContaining({ agent: true }),
        params: expect.objectContaining({ authorization: expect.objectContaining({ token: expect.any(String), kind: 'dapp-send' }) }),
      }),
    ]);
  });

  test("a fee the core's check stops: refused, nothing signed (the Agent confirms no fee again)", async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect();
    const { approvals, agentSends } = withAgent(env);
    const issue = jest.spyOn(mockApprovals.approval, 'issue').mockImplementationOnce(async () => {
      throw Object.assign(new Error('The fee is above the check\'s threshold: confirm it again'), {
        code: 'not_authorized',
        data: { reason: 'fee_check', fee_check: { comparable: true, above: true, ratio: '3.5' } },
      });
    });
    const page = env.tab();
    const answer = page.send(TRANSFER);
    await flush();
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ error: { code: -32603, message: expect.any(String) } });
    issue.mockRestore();
    expect(agentSends).toEqual([]);
    expect(signatures()).toEqual([]);
  });

  test("withdrawn at main's deadline: the agent's later approval sends nothing", async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect();
    const { approvals, agentSends } = withAgent(env);
    const page = env.tab();
    const answer = page.send(TRANSFER);
    await flush();
    env.expire();
    expect(await answer).toEqual({ error: { message: 'Request timed out' } });
    expect(approvals[0].signal.aborted).toBe(true);
    approvals[0].resolve('approved');
    await flush();
    expect(agentSends).toEqual([]);
  });

  test.each([
    ['its document navigates', (page) => page.guest.commit(`${KEY_A}/next`)],
    ['its tab closes', (page) => page.guest.destroy()],
  ])("withdrawn when %s: the agent's later approval sends nothing", async (_label, end) => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect();
    const { approvals, agentSends } = withAgent(env);
    const page = env.tab();
    const answer = page.send(TRANSFER);
    await flush();
    end(page);
    expect(await answer).toBe(GONE);
    approvals[0].resolve('approved');
    await flush();
    expect(agentSends).toEqual([]);
  });

  test("a name that moves after the agent's send went out: the hash is the page's, its last use unwritten", async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const { approvals, agentSends } = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    env.state.afterAgentSend = () => env.names.set(NAME, OTHER_IPNS_KEY);
    const answer = page.send(TRANSFER);
    await flush();
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: HASH });
    expect(agentSends).toHaveLength(1);
    expect(env.state.lastUsed).toEqual([]);
  });

  test.each([
    [
      'its name moves',
      (env) => env.names.set(NAME, OTHER_IPNS_KEY),
      NO_ADDRESS,
    ],
    ['its document navigates', (env, page) => page.guest.commit(`ipns://${IPNS_KEY}/next`), GONE],
    [
      'its grant is revoked',
      (env) => env.state.permissions.delete(NAME),
      { error: { code: -32603, message: expect.stringContaining('no longer connected with this account') } },
    ],
    [
      'the agent leaves the tab',
      (env, page) => env.state.custody.delete(page.guest.id),
      { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } },
    ],
    [
      'its grant moves to another account',
      (env) => env.state.permissions.set(NAME, { origin: NAME, walletIndex: LEDGER_INDEX, chainId: 100 }),
      { error: { code: -32603, message: expect.stringContaining('no longer connected with this account') } },
    ],
  ])("when %s during the agent's signer wait: nothing is committed or broadcast", async (_label, change, expected) => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const { approvals, agentSends, agentCommitted } = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    env.state.agentSignerHold = deferred();
    const answer = page.send(TRANSFER);
    await flush();
    approvals[0].resolve('approved');
    await flush();
    // At the signer: past main's gate before the signature.
    expect(agentSends).toHaveLength(1);
    change(env, page);
    env.state.agentSignerHold.resolve();
    expect(await answer).toEqual(expected);
    expect(agentCommitted).toEqual([]);
    expect(env.state.lastUsed).toEqual([]);
  });

  test('malformed: refused at once (-32602), the agent never asked; the page\'s from and chainId ignored, as on main\'s path', async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.connect();
    const { approvals, agentSends } = withAgent(env);
    const page = env.tab();
    for (const [tx, message] of [
      [{ to: 'not-an-address', value: '0x1' }, 'The transaction needs a recipient address (to)'],
      [{ to: CONTRACT, value: '-1' }, 'Invalid transaction value'],
      [{ to: CONTRACT, data: '0xabc' }, 'Invalid transaction data'],
    ]) {
      expect(await page.send(tx)).toEqual({ error: { code: -32602, message } });
    }
    expect(approvals).toEqual([]);
    expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
    // A from and chainId the page names are ignored: the agent gets main's form.
    const answer = page.send({ ...TRANSFER, from: LEDGER, chainId: '0x1' });
    await flush();
    expect(env.deps.agentWalletRequest).toHaveBeenCalledWith(
      page.guest.id,
      { method: 'eth_sendTransaction', params: [{ to: TRANSFER.to, value: '10000000000000000', data: '0x' }], chainId: 100 },
      expect.anything()
    );
    approvals[0].resolve('approved');
    expect(await answer).toEqual({ result: HASH });
    expect(agentSends[0].tx).toMatchObject({ to: TRANSFER.to, value: '10000000000000000', chainId: 100 });
  });

  test('the name is checked again just before the send: one that moved gets none', async () => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const { approvals, agentSends } = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.send(TRANSFER);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    approvals[0].resolve('approved');
    expect(await answer).toEqual(NO_ADDRESS);
    expect(agentSends).toEqual([]);
  });

  // Codex on #1246: the name, checked before the mint, is checked again
  // after it: the core's mint is a wait, and a DNS name over IPNS can move
  // during it.
  test.each([
    ['a vault account', 0],
    ['a phone account', PHONE_INDEX],
  ])("%s: a name that moves while the Agent's token is minted: nothing signed or sent, the token burnt", async (_label, walletIndex) => {
    const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, walletIndex);
    const { approvals, agentSends, agentSigners, agentCommitted } = withAgent(env);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const minting = deferred();
    const release = deferred();
    const issue = mockApprovals.approval.issue;
    const spy = jest.spyOn(mockApprovals.approval, 'issue').mockImplementationOnce(async (...args) => {
      minting.resolve();
      await release.promise;
      return issue(...args);
    });
    try {
      const answer = page.send(TRANSFER);
      await flush();
      approvals[0].resolve('approved');
      await minting.promise;
      env.names.set(NAME, OTHER_IPNS_KEY);
      release.resolve();
      expect(await answer).toEqual(NO_ADDRESS);
    } finally {
      spy.mockRestore();
    }
    expect(agentSigners).toEqual([]);
    expect(agentSends).toEqual([]);
    expect(agentCommitted).toEqual([]);
    expect(signatures()).toEqual([]);
    expect(mockApprovals.outstanding()).toBe(0);
  });

  // Codex on #1246: main presented the token as the signer was built, and
  // the transaction service waits after that (the fee, the address, the
  // nonce) before it asks the signer; the signer's last step reads the
  // name, the document, the grant and the tab again, right before the core
  // or the device is asked, and a phone signs and broadcasts in that step.
  test.each([
    ['a vault account', 0],
    ['a phone account', PHONE_INDEX],
  ])("%s: when the tab, the document or the name changes during the service's wait, nothing is signed or sent", async (_label, walletIndex) => {
    for (const [label, change, expected] of [
      ['the agent leaves the tab', (env, page) => env.state.custody.delete(page.guest.id), { error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' } }],
      ['the document navigates', (env, page) => page.guest.commit(`ipns://${IPNS_KEY}/next`), GONE],
      ['the name moves', (env) => env.names.set(NAME, OTHER_IPNS_KEY), NO_ADDRESS],
      ['nothing changes', () => {}, null],
    ]) {
      mockApprovals.reset();
      const env = setup({ agentContext: true, wallets: SENDING_WALLETS });
      env.names.set(NAME, IPNS_KEY);
      env.connect(NAME, walletIndex);
      const { approvals, agentSigners, agentCommitted } = withAgent(env);
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      env.state.agentServiceWait = { ...deferred(), reached: deferred() };
      const answer = page.send(TRANSFER);
      await flush();
      approvals[0].resolve('approved');
      await env.state.agentServiceWait.reached.promise;
      // Presented: the signer was built with the token, and the service waits.
      expect({ label, signers: agentSigners.length }).toEqual({ label, signers: 1 });
      change(env, page);
      env.state.agentServiceWait.resolve();
      if (expected) {
        expect({ label, answer: await answer }).toEqual({ label, answer: expected });
        await flush();
        expect({ label, asked: env.state.agentSignerAsked ?? 0 }).toEqual({ label, asked: 0 });
        expect({ label, signatures: signatures() }).toEqual({ label, signatures: [] });
        expect({ label, committed: agentCommitted }).toEqual({ label, committed: [] });
        expect({ label, outstanding: mockApprovals.outstanding() }).toEqual({ label, outstanding: 0 });
      } else {
        expect({ label, answer: await answer }).toEqual({ label, answer: { result: HASH } });
        expect({ label, asked: env.state.agentSignerAsked }).toEqual({ label, asked: 1 });
        expect({ label, committed: agentCommitted.length }).toEqual({ label, committed: 1 });
      }
    }
  });
});

// A send's form, checked first in custody or not (`coreSend`): moved with
// `txOf` from main's own send route (page-sends.test.js) in APB-4d.
describe("a send's form (txOf)", () => {
  const { txOf } = require('./page-core-sends');

  test('the shape checks: a quantity as hex, decimal or a number; data as hex', () => {
    expect(txOf([{ to: CONTRACT, value: '0x10', data: '0xAB' }])).toEqual({ to: CONTRACT, value: '16', data: '0xAB', gas: null });
    expect(txOf([{ to: CONTRACT, value: 16, gas: '0x5208' }])).toEqual({ to: CONTRACT, value: '16', data: '0x', gas: '21000' });
    expect(txOf([{ to: CONTRACT }])).toEqual({ to: CONTRACT, value: '0', data: '0x', gas: null });
  });
});
