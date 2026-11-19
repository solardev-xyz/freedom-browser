// Main's own part around the identity core's Ethereum dispatcher (freedom-core
// design 0012, APB-4d). Every Ethereum page method goes to the core's
// `eip1193.request` through main's relay (`page-eip1193.js`), and main keeps
// only what the core doesn't hold: the method list the preload routes to
// main, binary params refused before any JSON, a DNS name over IPNS checked
// again before the key is used and after the core's answer, and the agent's
// route for a send in a tab it holds, which stays in main until APB-5b. A
// connect or a signature in such a tab goes to the core like any page's,
// and the Agent's sheet answers the core's prompt for it (design 0012,
// APB-5a): page-agent-answers.test.js covers that.
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
const { createPageRequests } = require('./page-requests');
const { CLASS, methodRow, ETHEREUM_RPC_READS } = require('./page-methods');
const { ETHEREUM_READ_METHODS, ETHEREUM_PAGE_METHODS, createEthereumDispatchers } = require('./page-ethereum');
const { createEip1193Relay } = require('./page-eip1193');
const { CoreError, REQUIREMENT_UNMET } = require('../core/service-client');
const confirmations = require('../wallet/signing-confirmation');

// The identity core's approval tokens (design 0012, APB-1), simulated
// (test/helpers/simulated-approvals.js): main mints no page token (APB-5b),
// and a spy here would see any.
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
const DAPP = `${KEY_A}/app`;
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
const TRANSFER = { to: ACCOUNT, value: '0x2386f26fc10000' };
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
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const PENDING = { error: { code: -32002, message: 'Another wallet request is already pending' } };
const DISCONNECTED = { error: { code: 4900, message: 'Disconnected' } };
// The stand-in core's answer to a signature or a send (`standInCore`).
const STAND_IN_REFUSAL = { error: { code: 4200, message: 'The stand-in core answers no signature or send' } };
const GENERATION = 3;

// Each area's accounts, as its own tests had them: a connect offers every
// account but the undeployed Safe; a send cares what kind of signer each
// account has.
const CONNECT_WALLETS = Object.freeze([
  { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
  { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
  { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
  { index: 1001, name: 'New Safe', address: UNDEPLOYED, type: 'safe', deployed: {} },
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
 * request's PageContext. It signs and sends nothing: a signature, or a send
 * from a tab the agent doesn't hold, gets `4200`, or `4100` for a keyless
 * document as the core does, which the tests of main's gates read as the
 * core's answer.
 */
function standInCore(state, grantPermission, relayOf, names) {
  let lastId = 0;
  const core = {
    // A core that checks a bound document's name itself (cored 0.21.0).
    hello: { core_version: '0.21.0' },
    // Every request main sent, with the PageContext it went under.
    sent: [],
    // The origins whose grant the core read.
    grantReads: [],
    // The names the core checked itself (APR-5f), and the documents whose
    // binding a moved name ended.
    nameChecks: [],
    ended: new Set(),
    request: async (method, body, context, options) => {
      // The client's check of the process it writes to (`requires`).
      if (options.requires && !options.requires(core.hello)) {
        throw new CoreError(REQUIREMENT_UNMET, "The identity core can't take this request");
      }
      const id = ++lastId;
      core.sent.push({ id, method: body.method, params: body.params, page: context.page });
      options.onSent(id, GENERATION);
      if (options.signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
      return answer(id, body, context.page, options.signal);
    },
  };

  // The core's own check of a bound document's name (cored 0.21.0,
  // APR-5f): its naming reads the names main's does. A name that moved ends
  // the document's binding, and the document's later checks resolve
  // nothing.
  async function nameServes(page) {
    if (!page.transport_key || page.transport_key === page.origin) return true;
    const doc = [page.origin, page.transport_key, page.frame, page.navigation].join(' ');
    if (core.ended.has(doc)) return false;
    core.nameChecks.push(page.origin);
    await null;
    const serves = page.transport_key === `ipns://${names.get(page.origin)}`;
    if (!serves) core.ended.add(doc);
    return serves;
  }
  const checked = async (page, times) => {
    for (let i = 0; i < times; i += 1) if (!(await nameServes(page))) return false;
    return true;
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
      // Before the grant is read, and before the account goes out.
      if (!(await checked(page, 1))) return { result: [] };
      const account = grantedAccount(page, world);
      if (account && !(await checked(page, 1))) return { result: [] };
      return { result: account ? [account] : [] };
    }
    if (method === 'eth_requestAccounts') {
      if (!page.origin) return NO_ADDRESS;
      if (!(await checked(page, 2))) return NO_ADDRESS;
      const account = grantedAccount(page, world);
      return account ? { result: [account] } : connect(id, page, world, chainId, signal);
    }
    if (!page.origin) return NO_ADDRESS;
    if (!(await checked(page, 2))) return NO_ADDRESS;
    return STAND_IN_REFUSAL;
  }

  return core;
}

/** Main's backends and the dispatchers' deps, all in memory, over main's relay. */
function backends({ wallets = CONNECT_WALLETS, names = new Map() } = {}) {
  const state = {
    enabled: true,
    // Main's copy of the grants, which the core writes.
    permissions: new Map(),
    wallets: wallets.map((wallet) => ({ ...wallet })),
    selected: new Map(),
    available: new Set([1, 100]),
    networks: { 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } },
    // The grants the core wrote for main's prompt.
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
    // A send to the relay from a tab the agent holds: the agent's route
    // answers those until APB-5b, so any here fails the test (see
    // `afterEach`). A connect or a signature in custody goes to the core
    // (APB-5a).
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
  const core = standInCore(state, grantPermission, () => relay, names);
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
    relay: { request: (context, options) => relay.request(context, options) },
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
  const { state, deps, core, signer, grantPermission } = backends({ wallets, names });
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

// The agent answers a send for a tab it holds, and the core is never asked.
afterEach(() => {
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

  // The core checks a bound document's name itself (cored 0.21.0, APR-5f),
  // under the `transport_key` main's relay sends: main resolves it only at
  // the commit, and for the steps it holds.
  describe('a DNS name over IPNS', () => {
    function named() {
      const env = setup();
      env.names.set(NAME, IPNS_KEY);
      env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
      env.state.permissions.set(`ipns://${IPNS_KEY}`, { origin: `ipns://${IPNS_KEY}`, walletIndex: 1, chainId: 100 });
      const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
      return { env, page };
    }

    test('eth_accounts goes to the core with the binding, which checks the name before it reads the grant and before the account goes out; main resolves nothing after the commit', async () => {
      const { env, page } = named();
      expect(await page.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      // The commit's check, main's only.
      expect(env.resolutions).toEqual([NAME]);
      expect(env.core.sent.at(-1).page).toMatchObject({ origin: NAME, transport_key: `ipns://${IPNS_KEY}` });
      expect(env.core.nameChecks).toEqual([NAME, NAME]);
      expect(env.core.grantReads).toEqual([NAME]);
    });

    test('once the name moves off the IPNS key, the core answers eth_accounts [] and ends its binding; reads still answer, checking nothing; main resolves nothing', async () => {
      const { env, page } = named();
      expect(await page.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      env.names.set(NAME, OTHER_IPNS_KEY);
      env.resolutions.length = 0;
      env.core.nameChecks.length = 0;

      // The permission-free reads go to the core under the key as it
      // stands, resolving nothing.
      expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
      expect(await page.ask('net_version')).toEqual({ result: '100' });
      expect(await page.ask('eth_blockNumber')).toEqual({ result: 'eth_blockNumber@100' });
      expect(env.state.reads.at(-1).origin).toBe(NAME);
      expect(env.core.nameChecks).toEqual([]);

      env.core.grantReads.length = 0;
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.core.nameChecks).toEqual([NAME]);
      expect(env.core.grantReads).toEqual([]);
      // The core's binding has ended: its next check resolves nothing.
      // Main isn't told, so the document still sends its binding.
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.core.nameChecks).toEqual([NAME]);
      expect(env.core.sent.at(-1).page).toMatchObject({ origin: NAME, transport_key: `ipns://${IPNS_KEY}` });
      expect(env.resolutions).toEqual([]);

      // A new document binds again, from main's check at its commit.
      env.names.set(NAME, IPNS_KEY);
      page.guest.commit(`ipns://${IPNS_KEY}/docs`);
      await flush();
      const reloaded = env.greet(page.guest);
      expect(await reloaded.ask('eth_accounts')).toEqual({ result: [ACCOUNT] });
      expect(env.resolutions).toEqual([NAME]);
    });

    // Main's wallet list is read for the core's world before the request
    // goes out: the core's checks come after it.
    test('a name that moves while the wallets are read answers []', async () => {
      const { env, page } = named();
      env.state.derive = async () => {
        env.names.set(NAME, OTHER_IPNS_KEY);
        return env.state.wallets;
      };
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
    });

    // An account the core answered goes out only while main still holds
    // the key: main's own check of the name, for a step it holds, may end
    // its binding while the core's answer is on its way.
    test('an account whose binding main ended while the core answered is withheld: []', async () => {
      const { env, page } = named();
      await flush();
      const request = env.core.request;
      env.core.request = async (...args) => {
        const answer = await request(...args);
        env.names.set(NAME, OTHER_IPNS_KEY);
        const [requester] = env.documents.liveDocuments().filter((doc) => doc.guest === page.guest.id);
        expect(await env.documents.recheckName(requester)).toEqual({ ok: false, resolved: true });
        return answer;
      };
      expect(await page.ask('eth_accounts')).toEqual({ result: [] });
      expect(env.trace.filter((entry) => entry.kind === 'name-lost')).toHaveLength(1);
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
  // to the core with the switch off or no key, the custody gate on a send,
  // and the name checks before the agent's route. A connect or a signature
  // goes to the core in custody or not since APB-5a, and the core checks a
  // bound document's name itself (APR-5f).
  // APB-5b: main's agent route is gone; every request goes to the core, in
  // custody with `agent: true`, and the Agent's sheet answers the core's
  // prompt (page-agent-answers.test.js).
  describe("main's gates before the core, in custody or not", () => {
    // The page methods that may ask for a wallet, each as a page asks it.
    const ASKS = {
      eth_requestAccounts: (page) => page.ask('eth_requestAccounts'),
      personal_sign: (page) => page.ask('personal_sign', [MESSAGE, ACCOUNT]),
      eth_signTypedData_v4: (page) => page.ask('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(TYPED)]),
      eth_sendTransaction: (page) => page.send(TRANSFER),
    };
    const METHODS = Object.keys(ASKS);
    // The ones that may ask a prompt, whose prompt the Agent's sheet may answer.
    const GATED = ['personal_sign', 'eth_signTypedData_v4', 'eth_sendTransaction'];

    // The requests the core was sent, with the origin each went under.
    const sentToCore = (env) => env.core.sent.map((request) => [request.method, request.page.origin]);

    test('with the switch off, each goes straight to the core, which answers 4900, even in custody', async () => {
      const env = setup({ wallets: SENDING_WALLETS });
      env.connect();
      const page = env.tab(DAPP);
      env.state.custody.add(page.guest.id);
      env.state.enabled = false;
      for (const method of METHODS) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: DISCONNECTED });
      }
      expect(sentToCore(env)).toEqual(METHODS.map((method) => [method, KEY_A]));
    });

    test("a keyless document's go straight to the core under the empty origin, which answers 4100, even in custody", async () => {
      const env = setup({ wallets: SENDING_WALLETS });
      const page = env.tab('data:text/html,<h1>keyless</h1>');
      env.state.custody.add(page.guest.id);
      for (const method of METHODS) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: NO_ADDRESS });
      }
      expect(sentToCore(env)).toEqual(METHODS.map((method) => [method, '']));
    });

    test('from a tab the agent does not hold, a signature or a send goes to the core with agent: false', async () => {
      const env = setup({ wallets: SENDING_WALLETS });
      env.connect();
      const page = env.tab(DAPP);
      for (const method of GATED) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: STAND_IN_REFUSAL });
      }
      expect(env.core.sent.map((request) => [request.method, request.page.origin, request.page.agent])).toEqual(
        GATED.map((method) => [method, KEY_A, false])
      );
    });

    // APB-5a and APB-5b: main has no agent route; each goes to the core.
    test('in custody, a connect, a signature or a send goes to the core with agent: true', async () => {
      const env = setup({ wallets: SENDING_WALLETS, agentContext: true });
      env.connect();
      const page = env.tab(DAPP);
      env.state.custody.add(page.guest.id);
      expect(await ASKS.eth_requestAccounts(page)).toEqual({ result: [ACCOUNT] });
      for (const method of GATED) {
        expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: STAND_IN_REFUSAL });
      }
      expect(env.core.sent.map((request) => [request.method, request.page.agent])).toEqual(
        METHODS.map((method) => [method, true])
      );
    });

    describe('a DNS name over IPNS', () => {
      function bound({ custody = false } = {}) {
        const env = setup({ wallets: SENDING_WALLETS, agentContext: true });
        env.names.set(NAME, IPNS_KEY);
        env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
        const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
        if (custody) env.state.custody.add(page.guest.id);
        return { env, page };
      }

      // A connect, a signature, or a send outside custody: main resolves
      // nothing, and the core checks the name itself (APR-5f).
      test.each(METHODS)('outside custody, %s from a name that moved off its IPNS key goes to the core with the binding, resolving nothing in main, and the core\'s keyless 4100 reaches the page', async (method) => {
        const { env, page } = bound();
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        env.resolutions.length = 0;
        expect(await ASKS[method](page)).toEqual(NO_ADDRESS);
        expect(env.resolutions).toEqual([]);
        expect(env.core.sent.map((request) => [request.method, request.page.transport_key])).toEqual([
          [method, `ipns://${IPNS_KEY}`],
        ]);
        expect(env.core.nameChecks).toEqual([NAME]);
      });

      // In custody too, since APB-5: main checks no name before the core.
      test.each(METHODS)('in custody, %s from a name that moved off its IPNS key goes to the core with the binding and agent: true, and the core\'s keyless 4100 reaches the page', async (method) => {
        const { env, page } = bound({ custody: true });
        await flush();
        env.names.set(NAME, OTHER_IPNS_KEY);
        env.resolutions.length = 0;
        expect(await ASKS[method](page)).toEqual(NO_ADDRESS);
        expect(env.resolutions).toEqual([]);
        expect(env.core.sent.map((request) => [request.method, request.page.transport_key, request.page.agent])).toEqual([
          [method, `ipns://${IPNS_KEY}`, true],
        ]);
        expect(env.core.nameChecks).toEqual([NAME]);
      });
    });
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
