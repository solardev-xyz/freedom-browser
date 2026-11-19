// The Agent's sheet answering the identity core's prompts in a tab it holds
// (freedom-core design 0012, "The Agent's answer", APB-5a). A connect or a
// signature from such a tab goes to the core's `eip1193.request` like any
// page's, with `agent: true` in its PageContext; when the core asks main
// `approval.request` for an `eth.connect` or `eth.sign` prompt, main's relay
// routes it to the Agent's sheet when the echoed PageContext and live
// custody both say the Agent holds the tab, on a 0011 handle main opens on
// the request's record (`page-requests.js` `agentPrompt`), and to the
// user's prompt otherwise, for the same prompt id. A `vault.unlock` or an
// `eth.send` is never the sheet's (sends stay on the agent's route until
// APB-5b).
//
// Everything here runs over main's real page requests, Ethereum
// dispatchers and relay. Behind the relay a stand-in core records every
// call main's client makes, asks main its prompts through the relay's own
// handler, and answers from main's decision as the core does. The agent
// service's route (`agentPrompt`) is a stub each test drives.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { createEip1193Relay } = require('./page-eip1193');
const { CoreError, REQUIREMENT_UNMET } = require('../core/service-client');

// The identity core's approval methods, which main never calls for a
// connect or a signature since APB-4: the core mints its tokens and writes
// its grants itself, on main's answer to its prompt.
jest.mock('../core/vault-backend', () => ({
  vaultBackend: {
    approval: {
      issue: jest.fn(async () => {
        throw new Error('approval.issue is not main\'s here');
      }),
      grant: jest.fn(async () => {
        throw new Error('approval.grant is not main\'s here');
      }),
      spend: jest.fn(async () => ({})),
      discard: jest.fn(async () => ({})),
      check: jest.fn(async () => ({ covered: false })),
    },
  },
}));
const { vaultBackend: mockVault } = require('../core/vault-backend');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const DAPP = `${KEY_A}/app`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const NAME = 'example.com';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const LEDGER_ADDRESS = '0x3333333333333333333333333333333333333333';
const LEDGER_INDEX = 2;
const WALLETS = Object.freeze([
  Object.freeze({ index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' }),
  Object.freeze({ index: 1, name: 'Second', address: SECOND, type: 'mnemonic' }),
  Object.freeze({ index: LEDGER_INDEX, name: 'Ledger', address: LEDGER_ADDRESS, type: 'ledger' }),
]);
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
// The core's hash of TYPED, as its view shows it (a stand-in's).
const TYPED_HASH = `0x${'5a'.repeat(32)}`;
const TRANSFER = { to: SECOND, value: '0x2386f26fc10000' };
const CHAIN = Object.freeze({ id: 100, name: 'Gnosis Chain' });
const GENERATION = 3;
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const PENDING = { error: { code: -32002, message: 'Another wallet request is already pending' } };
const TIMED_OUT = { error: { message: 'Request timed out' } };
const CUSTODY_LOST = {
  error: { code: -32603, message: 'Signing was not confirmed: the Agent no longer holds this tab' },
};
// What the stand-in core answers for a send it was never asked to make.
const NOT_SENT = { error: { code: 4200, message: 'The stand-in core sends nothing' } };

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
// Flushed until `check()` holds, or fails.
async function until(check) {
  for (let i = 0; i < 20 && !check(); i += 1) await flush();
  expect(check()).toBe(true);
}
const pick = ({ index, name, address, type }) => ({ index, name, address, type });

/** A tab guest: a webview webContents hosted by chrome window `window`. */
class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextId++;
    this.window = window;
    this.hostWebContents = { id: 500 + window, isDestroyed: () => false, mainFrame: { url: CHROME_URL } };
    this.destroyed = false;
    this.mainFrame = this.frame('about:blank');
  }

  frame(url) {
    return {
      url,
      frameTreeNodeId: 1000 + this.id,
      processId: 1,
      routingId: this.id,
      detached: false,
      send: jest.fn(),
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
 * The identity core, stood in behind main's relay. Every call main's client
 * makes of it is recorded (`calls`, by method; `sent`, each request with
 * the PageContext main sent). A connect with no grant asks main
 * `approval.request` for `eth.connect`; a signature asks `eth.sign` with a
 * view in `signShown`'s form, for the account the site's grant names (a
 * vault account's offers "Always allow", a device's doesn't), and, with
 * `unlockFirst`, `vault.unlock` before it, as a rule's request does; a send
 * asks `eth.send`. Every ask, and main's answer to it, is in `asked`. On
 * main's approve the core writes the grant or signs: a vault account's
 * signature is `0xsig`, a Ledger's is `{ device }` for main to sign with,
 * on the handle main approved. Busy is `-32002`, anything else not
 * approved `4001`.
 *
 * Hooks a test sets: `beforeAsk(kind)` runs before each ask, `afterApprove`
 * after main approved, and `viewMessage` is the message the core's view
 * shows (what its token would bind) in place of the page's.
 */
function standInCore(state, relayOf) {
  let lastId = 0;
  const core = {
    hello: { core_version: '0.21.0' },
    calls: [],
    sent: [],
    asked: [],
    // The core's own cancel of each prompt, by prompt id.
    cancels: new Map(),
    // The watchdog holds main takes while it answers a prompt, and how many
    // are held now.
    held: 0,
    holdWatchdog: jest.fn(() => {
      core.held += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        core.held -= 1;
      };
    }),
    beforeAsk: null,
    afterApprove: null,
    unlockFirst: false,
    viewMessage: null,
    request: async (method, body, context, options) => {
      core.calls.push(method);
      if (method !== 'eip1193.request') throw new Error(`The stand-in core takes no ${method}`);
      if (options.requires && !options.requires(core.hello)) {
        throw new CoreError(REQUIREMENT_UNMET, "The identity core can't take this request");
      }
      const id = ++lastId;
      core.sent.push({ id, method: body.method, params: body.params, page: context.page });
      options.onSent(id, GENERATION);
      return answer(id, body, context.page, options.signal);
    },
  };

  // A prompt id: 16 random bytes in hex, as the core makes them.
  const promptOf = (id, step) => `${'c'.repeat(24)}${(id * 16 + step).toString(16).padStart(8, '0')}`;

  async function ask(id, page, signal, { kind, view, choices, step = 0 }) {
    await core.beforeAsk?.(kind);
    const prompt = promptOf(id, step);
    // The core cancels its prompt when main cancels the request.
    const cancel = new AbortController();
    signal?.addEventListener('abort', () => cancel.abort(), { once: true });
    core.cancels.set(prompt, cancel);
    const entry = { id, kind, prompt, page, view, choices, answer: undefined };
    core.asked.push(entry);
    entry.answer = await relayOf().approvalRequest(
      { request: id, prompt, page, kind, view, choices },
      { generation: GENERATION, signal: cancel.signal }
    );
    if (entry.answer.approve === true) await core.afterApprove?.(kind, entry.answer);
    return entry.answer;
  }

  const refusal = (decision) => (decision.busy ? PENDING : REJECTED);

  function signView(method, params, account) {
    const view = { method, account: pick(account), chain: { ...CHAIN } };
    if (method === 'personal_sign') {
      view.message = { hex: core.viewMessage ?? params[0], rawHash: false };
    } else {
      view.typedData = {
        hash: TYPED_HASH,
        view: { domain: { chainId: 100 }, primary_type: 'Order', message: { amount: '1' } },
        warnings: [],
      };
      view.chains = {};
    }
    return view;
  }

  async function answer(id, { method, params, world }, page, signal) {
    if (!world.enabled) return { error: { code: 4900, message: 'Disconnected' } };
    if (!page.origin) return NO_ADDRESS;
    const grant = state.permissions.get(page.origin);
    const account = grant ? world.wallets.find((wallet) => wallet.index === grant.walletIndex) : null;
    if (method === 'eth_requestAccounts') {
      if (account) return { result: [account.address] };
      const offered = world.wallets;
      const decision = await ask(id, page, signal, {
        kind: 'eth.connect',
        view: { accounts: offered.map(pick), defaultIndex: offered[0].index, chain: { ...CHAIN } },
        choices: { walletIndex: offered.map((wallet) => wallet.index) },
      });
      if (decision.approve !== true) return refusal(decision);
      const chosen = offered.find((wallet) => wallet.index === decision.choices.walletIndex);
      state.permissions.set(page.origin, { origin: page.origin, walletIndex: chosen.index, chainId: 100 });
      return { result: [chosen.address] };
    }
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') {
      if (!account) return { error: { code: 4100, message: 'The requested account has not been authorized' } };
      if (core.unlockFirst) {
        const unlock = await ask(id, page, signal, {
          kind: 'vault.unlock',
          view: { account: pick(account), reason: 'sign' },
          choices: {},
          step: 1,
        });
        if (unlock.approve !== true) return refusal(unlock);
      }
      const decision = await ask(id, page, signal, {
        kind: 'eth.sign',
        view: signView(method, params, account),
        choices: { alwaysAllow: account.type === 'mnemonic' ? [false, true] : [false] },
      });
      if (decision.approve !== true) return refusal(decision);
      if (account.type === 'ledger') {
        return {
          device: {
            type: 'ledger',
            kind: 'sign-message',
            account: account.index,
            payload: { message: params[0] },
            handle: decision.handle,
            token: 'tok',
          },
        };
      }
      return { result: '0xsig' };
    }
    if (method === 'eth_sendTransaction') {
      if (!account) return { error: { code: 4100, message: 'The requested account has not been authorized' } };
      const decision = await ask(id, page, signal, {
        kind: 'eth.send',
        view: {
          account: pick(account),
          chain: { ...CHAIN, symbol: 'xDAI' },
          tx: { to: TRANSFER.to, value: '10000000000000000', data: '0x' },
          fee: { gasLimit: '21000', gasPrice: '1000000000', estimate: '21000000000000' },
          feeCheck: null,
          feeAskAgain: false,
          alwaysAllow: true,
        },
        choices: { alwaysAllow: [false, true], feeAcknowledged: [false] },
      });
      return decision.approve === true ? NOT_SENT : refusal(decision);
    }
    return { error: { code: 4200, message: `The stand-in core answers no ${method}` } };
  }

  return core;
}

// Every environment a test made, for the checks after it.
const envs = [];

function setup() {
  const guests = new Map();
  const names = new Map();
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const state = {
    enabled: true,
    // Main's copy of the grants, which the core writes.
    permissions: new Map(),
    wallets: WALLETS.map((wallet) => ({ ...wallet })),
    // The tabs the Agent holds: main's custody, read live.
    custody: new Set(),
    // Main's wallet list as the relay reads it for the core's world, when a
    // test holds it.
    derive: null,
    // The Ledger's signer as main builds it, what it signed, the tokens main
    // discarded, and a wait before the device is asked.
    signers: [],
    signed: [],
    discarded: [],
    deviceWait: null,
  };
  let relay = null;
  const core = standInCore(state, () => relay);
  // The agent service's route for a core's prompt (`setAgentPromptRoute`).
  const agentPrompt = jest.fn(async () => ({ handled: false }));
  relay = createEip1193Relay({
    coreClient: () => core,
    watchdogMs: () => 135_000,
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: () => 100,
    getDerivedWallets: async () => (state.derive ? state.derive() : state.wallets),
    networks: () => ({ 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } }),
    isChainAvailable: (chainId) => Number(chainId) === 100,
    getActiveWalletIndex: () => 0,
    rulePaused: async () => false,
    selectChainForPage: () => {},
    isVaultUnlocked: async () => true,
    discardToken: (token) => state.discarded.push(token),
    agentPrompt,
  });
  const deps = {
    relay,
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: () => 100,
    getPermission: (key) => state.permissions.get(key) || null,
    getDerivedWallets: async () => state.wallets,
    updateLastUsed: jest.fn(),
    permissionsLoaded: async () => {},
    // The agent's own route, for a send in custody (until APB-5b).
    agentWalletRequest: jest.fn(async () => ({ handled: false })),
    signing: { inCustody: (guestId) => state.custody.has(guestId) },
    sends: { inCustody: (guestId) => state.custody.has(guestId) },
    deviceDeps: {
      walletList: async () => state.wallets,
      // A Ledger's signer as `signers.js` runs one: its own wait, then the
      // caller's last check (`beforeSign`), then the device.
      getSigner: (index, authorized) => {
        state.signers.push([index, authorized]);
        return {
          signMessage: async (message) => {
            await state.deviceWait?.();
            if (authorized?.beforeSign) await authorized.beforeSign();
            state.signed.push(['message', message]);
            return '0xledgersig';
          },
        };
      },
      discardToken: (token) => state.discarded.push(token),
    },
    coreSendDeps: { discardToken: (token) => state.discarded.push(token) },
  };
  const sent = [];
  const timers = [];
  const trace = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers(deps),
    hooks: { onTrace: (entry) => trace.push(entry) },
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
    // A PageContext's `agent`: the Agent's custody of the tab, read live.
    isAgentGuest: (guestId) => state.custody.has(guestId),
  });
  // Every handle that closed, with why.
  const closedHandles = [];
  requests.onHandleClosed((closed) => closedHandles.push({ ...closed }));

  /** A tracked guest on `url` whose document has said hello, in front. */
  function tab(url = DAPP, { bind = null, custody = false } = {}) {
    const guest = new Guest();
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      expect(
        requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })
      ).toBe(true);
    }
    guest.commit(url);
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n })).toEqual({ ok: true, navigation: expect.any(Number) });
    requests.foreground({ sender: { id: 501 } }, { guest: guest.id });
    if (custody) state.custody.add(guest.id);
    return {
      guest,
      ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
    };
  }

  // The user's prompts main showed in the chrome window.
  const prompts = () => sent.filter(([w, c]) => w === 1 && c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices = {}) => requests.decide({ sender: { id: 501 } }, { handle, approve, choices });
  const connect = (key = KEY_A, walletIndex = 0) => state.permissions.set(key, { origin: key, walletIndex, chainId: 100 });
  // Main's deadline for every request still running.
  const expire = () => {
    for (const timer of timers.filter((t) => !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };

  /**
   * The Agent's sheet, waiting: each ask of the route is kept, to be
   * decided by the test (`resolve`), with the watchdog holds main had taken
   * as the sheet opened. A handle that closes withdraws the sheet, as the
   * agent service does on its signal.
   */
  function sheet() {
    const asks = [];
    agentPrompt.mockImplementation(
      (guestId, prompt, options) =>
        new Promise((resolve) => {
          asks.push({ guestId, prompt, options, resolve, heldThen: core.held });
          options.signal.addEventListener('abort', () => resolve({ handled: true, decision: { closed: true } }), {
            once: true,
          });
        })
    );
    return asks;
  }

  const env = {
    requests,
    state,
    deps,
    core,
    names,
    agentPrompt,
    sent,
    trace,
    closedHandles,
    tab,
    prompts,
    decide,
    connect,
    expire,
    sheet,
  };
  envs.push(env);
  return env;
}

beforeEach(() => {
  envs.length = 0;
  jest.clearAllMocks();
});

// Main never mints or grants for a connect or a signature: no
// `approval.issue` or `approval.grant` reached the core, through main's
// client or the vault backend.
afterEach(() => {
  expect(mockVault.approval.issue).not.toHaveBeenCalled();
  expect(mockVault.approval.grant).not.toHaveBeenCalled();
  for (const env of envs) expect(env.core.calls.filter((method) => method !== 'eip1193.request')).toEqual([]);
});

const ASKS = {
  eth_requestAccounts: (page) => page.ask('eth_requestAccounts'),
  personal_sign: (page) => page.ask('personal_sign', [MESSAGE, ACCOUNT]),
  eth_signTypedData_v4: (page) => page.ask('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(TYPED)]),
};
const METHODS = Object.keys(ASKS);
const SIGNATURES = ['personal_sign', 'eth_signTypedData_v4'];
const kindOf = (method) => (method === 'eth_requestAccounts' ? 'eth.connect' : 'eth.sign');
// A site connected for the signatures; a connect asks with no grant.
const ready = (env, method) => {
  if (method !== 'eth_requestAccounts') env.connect();
};
// What the core answers the page for the sheet's approve.
const APPROVED = { eth_requestAccounts: { result: [SECOND] }, personal_sign: { result: '0xsig' }, eth_signTypedData_v4: { result: '0xsig' } };
const APPROVE = {
  eth_requestAccounts: { handled: true, decision: { approve: true, walletIndex: 1 } },
  personal_sign: { handled: true, decision: { approve: true } },
  eth_signTypedData_v4: { handled: true, decision: { approve: true } },
};

describe("a tab the Agent holds: its sheet answers the core's connect and signature prompts (0012 APB-5a)", () => {
  test.each(METHODS)(
    "%s goes to the core with agent: true, and the sheet's approve answers the core's prompt id on the handle main opened for it",
    async (method) => {
      const env = setup();
      ready(env, method);
      const asks = env.sheet();
      const page = env.tab(DAPP, { custody: true });
      const answer = ASKS[method](page);
      await until(() => asks.length === 1);
      // The core's, like any page's: main's own agent route never took it.
      expect(env.core.sent).toEqual([
        expect.objectContaining({ method, page: expect.objectContaining({ origin: KEY_A, agent: true }) }),
      ]);
      expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
      const [asked] = env.core.asked;
      expect(asked.kind).toBe(kindOf(method));
      const [ask] = asks;
      expect(ask.guestId).toBe(page.guest.id);
      expect(ask.prompt).toMatchObject({ kind: kindOf(method), method, chainId: 100 });
      expect(ask.options).toEqual({
        signal: expect.any(AbortSignal),
        attested: { key: KEY_A, transportKey: KEY_A },
        answered: expect.any(Promise),
      });
      // The sheet decides on a handle main opened on the request's record;
      // the user is shown nothing.
      expect(env.trace.filter((entry) => entry.kind === 'sheet-opened')).toHaveLength(1);
      expect(env.prompts()).toEqual([]);
      // Main holds the core's watchdog while the sheet is open, and lets go
      // once it has answered.
      expect(ask.heldThen).toBe(1);
      expect(env.core.holdWatchdog).toHaveBeenCalledWith(GENERATION, env.core.sent[0].id);

      ask.resolve(APPROVE[method]);
      expect(await answer).toEqual(APPROVED[method]);
      const choices = method === 'eth_requestAccounts' ? { walletIndex: 1 } : { alwaysAllow: false };
      expect(asked.answer).toEqual({
        prompt: asked.prompt,
        handle: expect.stringMatching(/^[0-9a-f]{64}$/),
        approve: true,
        choices,
        world: expect.objectContaining({ enabled: true, wallets: expect.any(Array) }),
      });
      // That handle is the one main opened on the record for the sheet,
      // closed as decided.
      expect(env.closedHandles).toEqual([
        { handle: asked.answer.handle, window: 1, guest: page.guest.id, reason: 'decided' },
      ]);
      expect(env.trace.filter((entry) => entry.kind === 'sheet-decided')).toEqual([
        expect.objectContaining({ approve: true }),
      ]);
      expect(env.core.held).toBe(0);
      // The agent service hears the page's answer.
      await expect(ask.options.answered).resolves.toEqual(APPROVED[method]);
      if (method === 'eth_requestAccounts') expect(env.state.permissions.get(KEY_A)).toMatchObject({ walletIndex: 1 });
      expect(mockVault.approval.issue).not.toHaveBeenCalled();
      expect(mockVault.approval.grant).not.toHaveBeenCalled();
      expect(env.core.calls).toEqual(['eip1193.request']);
    }
  );

  test("the sheet gets the core's view, which its token binds, not the page's params", async () => {
    const env = setup();
    env.connect();
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    // The page asks for "hello"; the core's view says "core".
    env.core.viewMessage = '0x636f7265';
    const message = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await until(() => asks.length === 1);
    expect(asks[0].prompt).toEqual({
      kind: 'eth.sign',
      method: 'personal_sign',
      params: [MESSAGE, ACCOUNT],
      chainId: 100,
      view: {
        method: 'personal_sign',
        account: pick(WALLETS[0]),
        chain: CHAIN,
        message: { hex: '0x636f7265', rawHash: false },
        // "Always allow" is offered for a vault account (the sheet never
        // ticks it).
        alwaysAllow: true,
      },
    });
    asks[0].resolve(APPROVE.personal_sign);
    expect(await message).toEqual({ result: '0xsig' });

    const typed = page.ask('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(TYPED)]);
    await until(() => asks.length === 2);
    expect(asks[1].prompt.view).toEqual({
      method: 'eth_signTypedData_v4',
      account: pick(WALLETS[0]),
      chain: CHAIN,
      typedData: {
        hash: TYPED_HASH,
        view: { domain: { chainId: 100 }, primary_type: 'Order', message: { amount: '1' } },
        warnings: [],
      },
      chains: {},
      alwaysAllow: true,
    });
    asks[1].resolve(APPROVE.eth_signTypedData_v4);
    expect(await typed).toEqual({ result: '0xsig' });

    // A connect's view: the accounts and the default the core offers.
    env.state.permissions.clear();
    const connect = page.ask('eth_requestAccounts');
    await until(() => asks.length === 3);
    expect(asks[2].prompt).toEqual({
      kind: 'eth.connect',
      method: 'eth_requestAccounts',
      params: [],
      chainId: 100,
      view: { accounts: WALLETS.map(pick), defaultIndex: 0, chain: CHAIN },
    });
    asks[2].resolve({ handled: true, decision: { approve: true, walletIndex: 0 } });
    expect(await connect).toEqual({ result: [ACCOUNT] });
  });

  test('"Always allow" is never ticked by the sheet, even where the core offers it', async () => {
    const env = setup();
    env.connect();
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    for (const [i, method] of SIGNATURES.entries()) {
      const answer = ASKS[method](page);
      await until(() => asks.length === i + 1);
      const asked = env.core.asked[i];
      expect(asked.choices).toEqual({ alwaysAllow: [false, true] });
      // Whatever the agent service's decision carries.
      asks[i].resolve({ handled: true, decision: { approve: true, alwaysAllow: true, choices: { alwaysAllow: true } } });
      expect(await answer).toEqual({ result: '0xsig' });
      expect(asked.answer).toMatchObject({ approve: true, choices: { alwaysAllow: false } });
    }
  });

  test.each(METHODS)('%s declined by the sheet: the core hears approve: false on that handle, and the page 4001', async (method) => {
    const env = setup();
    ready(env, method);
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    const answer = ASKS[method](page);
    await until(() => asks.length === 1);
    asks[0].resolve({ handled: true, decision: { approve: false } });
    expect(await answer).toEqual(REJECTED);
    const [asked] = env.core.asked;
    expect(asked.answer).toEqual({ prompt: asked.prompt, handle: expect.stringMatching(/^[0-9a-f]{64}$/), approve: false, choices: {} });
    expect(env.closedHandles).toEqual([{ handle: asked.answer.handle, window: 1, guest: page.guest.id, reason: 'decided' }]);
    await expect(asks[0].options.answered).resolves.toEqual(REJECTED);
    expect(env.prompts()).toEqual([]);
  });

  test.each(METHODS)('%s withdrawn by the sheet: the core hears its prompt closed', async (method) => {
    const env = setup();
    ready(env, method);
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    const answer = ASKS[method](page);
    await until(() => asks.length === 1);
    asks[0].resolve({ handled: true, decision: { closed: true } });
    expect(await answer).toEqual(REJECTED);
    const [asked] = env.core.asked;
    expect(asked.answer).toEqual({ prompt: asked.prompt, closed: 'cancelled' });
    expect(env.closedHandles).toEqual([expect.objectContaining({ guest: page.guest.id, reason: 'cancelled' })]);
    expect(env.prompts()).toEqual([]);
  });

  test("the core's cancel closes the sheet's handle and withdraws it", async () => {
    const env = setup();
    env.connect();
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    const answer = ASKS.personal_sign(page);
    await until(() => asks.length === 1);
    const [asked] = env.core.asked;
    env.core.cancels.get(asked.prompt).abort();
    expect(await answer).toEqual(REJECTED);
    expect(asks[0].options.signal.aborted).toBe(true);
    expect(asked.answer).toEqual({ prompt: asked.prompt, closed: 'cancelled' });
    expect(env.closedHandles).toEqual([expect.objectContaining({ reason: 'cancelled' })]);
  });

  test.each([
    ['too large', { code: -32602, message: 'Wallet request is too large' }],
    ['on another transport', { code: 4100, message: 'Wallet request origin did not match the page' }],
    ['a Safe', { code: -32603, message: 'Agent signing and transfers are unavailable for this wallet type; use Freedom’s wallet controls' }],
    ['for another address', { code: -32603, message: 'Signature account does not match the connected wallet' }],
  ])("the agent's own refusal (A7-3, %s): the page gets its error, the core a closed prompt, and the sheet's handle closes", async (_label, error) => {
    const env = setup();
    env.connect();
    const page = env.tab(DAPP, { custody: true });
    env.agentPrompt.mockImplementation(async () => ({ handled: true, error, errorCode: 'POLICY_DENIED' }));
    for (const method of METHODS) {
      if (method === 'eth_requestAccounts') env.state.permissions.clear();
      else env.connect();
      env.core.asked.length = 0;
      env.closedHandles.length = 0;
      expect({ method, answer: await ASKS[method](page) }).toEqual({ method, answer: { error } });
      const [asked] = env.core.asked;
      expect({ method, core: asked.answer }).toEqual({ method, core: { prompt: asked.prompt, closed: 'cancelled' } });
      expect(env.closedHandles).toEqual([expect.objectContaining({ reason: 'cancelled' })]);
      // No grant written for a connect refused.
      if (method === 'eth_requestAccounts') expect(env.state.permissions.has(KEY_A)).toBe(false);
    }
    expect(env.prompts()).toEqual([]);
  });

  test("a connect the sheet approves for an account the core didn't offer: the page gets -32603, the core a closed prompt", async () => {
    const env = setup();
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    const answer = ASKS.eth_requestAccounts(page);
    await until(() => asks.length === 1);
    asks[0].resolve({ handled: true, decision: { approve: true, walletIndex: 77 } });
    expect(await answer).toEqual({ error: { code: -32603, message: 'The selected wallet is unavailable' } });
    const [asked] = env.core.asked;
    expect(asked.answer).toEqual({ prompt: asked.prompt, closed: 'cancelled' });
    expect(env.state.permissions.has(KEY_A)).toBe(false);
  });

  describe("the user's prompt, for the same prompt id, when the sheet doesn't answer it", () => {
    test.each(METHODS)("%s the agent service doesn't take: the user's prompt shows, and its decision answers the core's prompt id", async (method) => {
      const env = setup();
      ready(env, method);
      const page = env.tab(DAPP, { custody: true });
      const answer = ASKS[method](page);
      await until(() => env.prompts().length === 1);
      expect(env.agentPrompt).toHaveBeenCalledTimes(1);
      const [shown] = env.prompts();
      expect(shown).toMatchObject({ guest: page.guest.id, kind: kindOf(method) });
      // The sheet's handle closed before the user's opened.
      expect(env.closedHandles).toEqual([expect.objectContaining({ reason: 'cancelled' })]);
      expect(env.closedHandles[0].handle).not.toBe(shown.handle);
      expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
      expect(await answer).toEqual(REJECTED);
      const [asked] = env.core.asked;
      expect(asked.answer).toEqual({ prompt: asked.prompt, handle: shown.handle, approve: false, choices: {} });
    });

    test.each(METHODS)('%s sent outside custody (agent: false), with custody begun before the prompt: the user\'s prompt, never the sheet', async (method) => {
      const env = setup();
      ready(env, method);
      const page = env.tab(DAPP);
      env.core.beforeAsk = () => env.state.custody.add(page.guest.id);
      const answer = ASKS[method](page);
      await until(() => env.prompts().length === 1);
      expect(env.core.sent[0].page.agent).toBe(false);
      expect(env.state.custody.has(page.guest.id)).toBe(true);
      expect(env.agentPrompt).not.toHaveBeenCalled();
      const [shown] = env.prompts();
      expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
      expect(await answer).toEqual(REJECTED);
      expect(env.core.asked[0].answer).toMatchObject({ prompt: env.core.asked[0].prompt, handle: shown.handle });
    });

    test.each(METHODS)('%s sent in custody (agent: true), with custody gone before the prompt: the user\'s prompt, never the sheet', async (method) => {
      const env = setup();
      ready(env, method);
      const page = env.tab(DAPP, { custody: true });
      env.core.beforeAsk = () => env.state.custody.delete(page.guest.id);
      const answer = ASKS[method](page);
      await until(() => env.prompts().length === 1);
      expect(env.core.sent[0].page.agent).toBe(true);
      expect(env.agentPrompt).not.toHaveBeenCalled();
      const [shown] = env.prompts();
      expect(shown.kind).toBe(kindOf(method));
      expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
      expect(await answer).toEqual(REJECTED);
      expect(env.core.asked[0].answer).toMatchObject({ prompt: env.core.asked[0].prompt, handle: shown.handle });
    });

    test("a vault.unlock the core asks in custody is the user's prompt; the signature after it is the sheet's", async () => {
      const env = setup();
      env.connect();
      env.core.unlockFirst = true;
      const asks = env.sheet();
      const page = env.tab(DAPP, { custody: true });
      const answer = ASKS.personal_sign(page);
      await until(() => env.prompts().length === 1);
      const [shown] = env.prompts();
      expect(shown).toMatchObject({ kind: 'vault.unlock', view: { account: pick(WALLETS[0]), reason: 'sign' } });
      const [unlock] = env.core.asked;
      expect(unlock).toMatchObject({ kind: 'vault.unlock', page: expect.objectContaining({ agent: true }) });
      expect(env.agentPrompt).not.toHaveBeenCalled();
      // A decision is answered once the request it decided is.
      const decided = env.decide(shown.handle, true);
      await until(() => asks.length === 1);
      expect(unlock.answer).toMatchObject({ prompt: unlock.prompt, handle: shown.handle, approve: true, choices: {} });
      expect(asks[0].prompt.kind).toBe('eth.sign');
      asks[0].resolve(APPROVE.personal_sign);
      expect(await answer).toEqual({ result: '0xsig' });
      expect(await decided).toEqual({ ok: true });
      expect(env.agentPrompt).toHaveBeenCalledTimes(1);
      expect(env.prompts()).toHaveLength(1);
    });

    test("an eth.send prompt is never the sheet's: a send the agent's route declines asks the user", async () => {
      const env = setup();
      env.connect();
      const page = env.tab(DAPP, { custody: true });
      const answer = page.ask('eth_sendTransaction', [TRANSFER]);
      await until(() => env.prompts().length === 1);
      // The agent's own route was offered it first (until APB-5b).
      expect(env.deps.agentWalletRequest).toHaveBeenCalledTimes(1);
      expect(env.core.sent[0]).toMatchObject({ method: 'eth_sendTransaction', page: expect.objectContaining({ agent: true }) });
      expect(env.core.asked[0].kind).toBe('eth.send');
      expect(env.agentPrompt).not.toHaveBeenCalled();
      const [shown] = env.prompts();
      expect(shown.kind).toBe('eth.send');
      expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
      expect(await answer).toEqual(REJECTED);
    });
  });

  describe("the document's one wallet slot", () => {
    test('a second request while the sheet decides: -32002, the core hears busy, and the sheet is asked once', async () => {
      const env = setup();
      env.connect();
      const asks = env.sheet();
      const page = env.tab(DAPP, { custody: true });
      const first = ASKS.personal_sign(page);
      await until(() => asks.length === 1);
      expect(await ASKS.eth_signTypedData_v4(page)).toEqual(PENDING);
      expect(env.core.asked[1].answer).toEqual({ prompt: env.core.asked[1].prompt, busy: true });
      expect(env.agentPrompt).toHaveBeenCalledTimes(1);
      asks[0].resolve(APPROVE.personal_sign);
      expect(await first).toEqual({ result: '0xsig' });
    });

    test("a request while the user's prompt is open: -32002, the sheet never asked", async () => {
      const env = setup();
      const page = env.tab(DAPP);
      // The user's connect prompt, outside custody.
      const connect = ASKS.eth_requestAccounts(page);
      await until(() => env.prompts().length === 1);
      env.connect();
      env.state.custody.add(page.guest.id);
      expect(await ASKS.personal_sign(page)).toEqual(PENDING);
      expect(env.core.asked[1]).toMatchObject({ kind: 'eth.sign', page: expect.objectContaining({ agent: true }) });
      expect(env.core.asked[1].answer).toEqual({ prompt: env.core.asked[1].prompt, busy: true });
      expect(env.agentPrompt).not.toHaveBeenCalled();
      expect(await env.decide(env.prompts()[0].handle, false)).toEqual({ ok: true });
      expect(await connect).toEqual(REJECTED);
    });
  });

  test.each(METHODS)("%s: the record's deadline runs while the sheet decides, and ends it: the page times out, the core hears expired", async (method) => {
    const env = setup();
    ready(env, method);
    const asks = env.sheet();
    const page = env.tab(DAPP, { custody: true });
    const answer = ASKS[method](page);
    await until(() => asks.length === 1);
    env.expire();
    expect(await answer).toEqual(TIMED_OUT);
    expect(asks[0].options.signal.aborted).toBe(true);
    await until(() => env.core.asked[0].answer !== undefined);
    const [asked] = env.core.asked;
    expect(asked.answer).toEqual({ prompt: asked.prompt, closed: 'expired' });
    expect(env.closedHandles).toEqual([expect.objectContaining({ guest: page.guest.id, reason: 'expired' })]);
    // The sheet's approve after that changes nothing.
    asks[0].resolve(APPROVE[method]);
    await flush();
    expect(env.core.asked).toHaveLength(1);
    expect(env.state.permissions.get(KEY_A)?.walletIndex ?? null).toBe(method === 'eth_requestAccounts' ? null : 0);
    // The agent service hears no result.
    expect((await asks[0].options.answered).result).toBeUndefined();
  });

  describe('custody, read again after the sheet\'s approve (A7-6)', () => {
    test.each(SIGNATURES)("%s: custody lost between the sheet's approve and main's answer: the page gets main's refusal, the core a closed prompt, nothing signed", async (method) => {
      const env = setup();
      env.connect();
      const page = env.tab(DAPP, { custody: true });
      env.agentPrompt.mockImplementation(async () => {
        // Custody ends while main builds its answer to the core.
        env.state.derive = () => {
          env.state.custody.delete(page.guest.id);
          return env.state.wallets;
        };
        return APPROVE[method];
      });
      expect(await ASKS[method](page)).toEqual(CUSTODY_LOST);
      const [asked] = env.core.asked;
      expect(asked.answer).toEqual({ prompt: asked.prompt, closed: 'cancelled' });
    });

    test.each([
      ['held throughout: the Ledger signs', null, { result: '0xledgersig' }],
      ['lost after main answered the core, before the device step', 'afterApprove', CUSTODY_LOST],
      ["lost during the device's own wait, before it is asked", 'deviceWait', CUSTODY_LOST],
    ])("a Ledger's { device } after the sheet's approve, custody %s", async (_label, when, expected) => {
      const env = setup();
      env.connect(KEY_A, LEDGER_INDEX);
      const asks = env.sheet();
      const page = env.tab(DAPP, { custody: true });
      const lose = () => env.state.custody.delete(page.guest.id);
      if (when === 'afterApprove') env.core.afterApprove = lose;
      if (when === 'deviceWait') env.state.deviceWait = lose;
      const answer = page.ask('personal_sign', [MESSAGE, LEDGER_ADDRESS]);
      await until(() => asks.length === 1);
      // A device's account: "Always allow" isn't offered.
      expect(env.core.asked[0].choices).toEqual({ alwaysAllow: [false] });
      asks[0].resolve(APPROVE.personal_sign);
      expect(await answer).toEqual(expected);
      const [asked] = env.core.asked;
      expect(asked.answer).toMatchObject({ prompt: asked.prompt, approve: true, choices: { alwaysAllow: false } });
      if (when === 'afterApprove') {
        // Refused before the token is presented: no signer built.
        expect(env.state.signers).toEqual([]);
      } else {
        // The signer was handed the core's token on the sheet's handle, with
        // main's custody check as its last step.
        expect(env.state.signers).toEqual([
          [
            LEDGER_INDEX,
            {
              confirmation: {
                token: 'tok',
                kind: 'sign-message',
                account: LEDGER_INDEX,
                payload: { message: MESSAGE },
                handle: asked.answer.handle,
                page: expect.objectContaining({ origin: KEY_A, agent: true }),
              },
              beforeSign: expect.any(Function),
            },
          ],
        ]);
      }
      expect(env.state.signed).toEqual(when ? [] : [['message', MESSAGE]]);
      // The token is burnt once main's step ends, spent or not.
      expect(env.state.discarded).toEqual(['tok']);
    });
  });

  test('a DNS name over IPNS: the sheet acts under the name main attested, and the core gets the binding', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME);
    const asks = env.sheet();
    const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME, custody: true });
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await until(() => asks.length === 1);
    expect(env.core.sent[0].page).toMatchObject({ origin: NAME, transport_key: `ipns://${IPNS_KEY}`, agent: true });
    expect(asks[0].options.attested).toEqual({ key: NAME, transportKey: `ipns://${IPNS_KEY}` });
    asks[0].resolve(APPROVE.personal_sign);
    expect(await answer).toEqual({ result: '0xsig' });
  });
});
