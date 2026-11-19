// Main's relay to the identity core's Ethereum dispatcher (freedom-core
// design 0012, APB-4a and APB-4b): the reads, the connect, the switch and
// the signatures go to `eip1193.request` under the page's PageContext, main
// serves the core's `approval.request`, `approval.recheck` and
// `eip1193.select_chain` for the request they name, and a signature's
// `{ device }` goes to main's device step. Here the core is a stand-in that asks what a
// script tells it to; page-eip1193.integration.test.js runs the real one.

const { EventEmitter } = require('events');
const os = require('os');
const { PassThrough, Writable } = require('stream');
const { CoreClient } = require('../core/core-client');
const { CoreError, REQUIREMENT_UNMET, RESTART_DELAYS_MS } = require('../core/service-client');
const { encodeFrame, FrameDecoder, KIND_JSON } = require('../core/frame');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { createEip1193Relay, connectShown, signShown, unlockShown, sendShown } = require('./page-eip1193');
const { buildTransaction, toCoreTransaction } = require('../wallet/signing-utils');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const GENERATION = 3;
const PROMPT = 'c'.repeat(32);
const OTHER_PROMPT = 'd'.repeat(32);
const NO_ADDRESS = { code: 4100, message: 'This page has no address to connect from yet' };

let nextGuest = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

class Guest extends EventEmitter {
  constructor({ window = 1 } = {}) {
    super();
    this.id = nextGuest++;
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
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

/**
 * The core's stand-in: each `eip1193.request` runs `script({ id, params,
 * page, signal })`, whose return is the core's answer. It asks main through
 * the relay's handlers, as the core's own requests would reach them.
 */
function standInCore() {
  let lastId = 0;
  const core = {
    // The hello of the process main sends to: a core that checks a bound
    // document's name itself (cored 0.21.0, APR-5f).
    hello: { core_version: '0.21.0' },
    sent: [],
    holds: [],
    released: [],
    script: async () => ({ result: null }),
    request: jest.fn(async (method, params, context, options) => {
      // The client's check of the process it writes the frame to
      // (`requires`), as ServiceClient makes it: refused unsent.
      if (options.requires && !options.requires(core.hello)) {
        throw new CoreError(REQUIREMENT_UNMET, "The identity core can't take this request");
      }
      const id = ++lastId;
      core.sent.push({ id, method, params, context, watchdogMs: options.watchdogMs });
      options.onSent(id, GENERATION);
      if (options.signal?.aborted) throw Object.assign(new Error('Cancelled'), { code: 'cancelled' });
      return core.script({ id, params, page: context.page, signal: options.signal });
    }),
    holdWatchdog: jest.fn((generation, id) => {
      core.holds.push([generation, id]);
      return () => core.released.push([generation, id]);
    }),
    handle: jest.fn(),
  };
  return core;
}

function setup({ approvalsDocument = false, deviceDeps = {}, coreSendDeps = {}, coreClient = null } = {}) {
  const guests = new Map();
  const names = new Map();
  const state = {
    enabled: true,
    wallets: [
      { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
    ],
    selected: new Map(),
    selections: [],
    agent: false,
    paused: false,
    unlocked: true,
    discarded: [],
    // Main's copy of the grants, and the last uses it sent the core.
    grants: new Map(),
    touched: [],
    custody: false,
    // The names main resolved, and, while set, a promise each resolution
    // waits on before it reads `names`.
    resolutions: [],
    nameHold: null,
  };
  const networks = {
    1: { name: 'Ethereum', nativeSymbol: 'ETH' },
    100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' },
    10: { name: 'Optimism' },
  };
  const available = new Set([1, 100]);
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      state.resolutions.push(name);
      if (state.nameHold) await state.nameHold;
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const core = coreClient || standInCore();
  const relay = createEip1193Relay({
    coreClient: () => core,
    watchdogMs: () => 135_000,
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
    getDerivedWallets: async () => state.wallets,
    networks: () => networks,
    isChainAvailable: (chainId) => available.has(Number(chainId)),
    getActiveWalletIndex: () => 0,
    rulePaused: async () => state.paused,
    selectChainForPage: jest.fn((windowId, chainId) => {
      state.selections.push([windowId, chainId]);
      state.selected.set(windowId, chainId);
    }),
    isVaultUnlocked: async () => state.unlocked,
    discardToken: (token) => state.discarded.push(token),
  });
  const sent = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers({
      relay,
      identityWalletEnabled: () => state.enabled,
      permissionsLoaded: async () => {},
      agentWalletRequest: async () => ({ handled: false }),
      getPermission: (key) => state.grants.get(key) || state.grants.get('*') || null,
      getDerivedWallets: async () => state.wallets,
      updateLastUsed: async (key, chainId, page) => state.touched.push([key, page]),
      signing: { inCustody: () => false },
      sends: { inCustody: () => state.custody },
      coreSendDeps: {
        discardToken: (token) => state.discarded.push(token),
        ...coreSendDeps,
      },
      deviceDeps: {
        walletList: async () => state.wallets,
        discardToken: (token) => state.discarded.push(token),
        ...deviceDeps,
      },
    }),
    setTimer: () => ({}),
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: () => {},
    isAgentGuest: () => state.agent,
    // With the approvals document on: its prompts land in `sent` too, and
    // main unlocks with the password its decision carries.
    approvals: approvalsDocument ? { send: (windowId, channel, payload) => sent.push([windowId, channel, payload]) } : null,
    unlockVault: async (password) => {
      if (password !== 'right password') throw new Error('Incorrect password');
      state.unlocked = true;
    },
    touchIdAvailable: async () => false,
  });

  function tab(url = `${KEY_A}/app`, { window = 1, bind = null, front = true } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] });
    }
    guest.commit(url);
    const n = nonce();
    const greeted = requests.hello(eventFrom(guest), { nonce: n });
    expect(greeted.ok).toBe(true);
    if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return {
      guest,
      ask: (method, params) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
      // Main's own check of the document's name, as one of the steps main
      // holds makes it (a send's turn, a device's signature): a name that
      // moved ends main's binding.
      mainChecks: (key) => documents.recheckName({ guest: guest.id, navigation: greeted.navigation, nonce: n, key }),
    };
  }

  const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
  const closed = () => sent.filter(([, c]) => c === 'page:prompt-closed').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    approvalsDocument
      ? requests.decideInWindow(windowId, { handle, approve, choices })
      : requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  return { requests, relay, core, state, names, tab, prompts, closed, decide, sent };
}

// The core's connect prompt for request `id`, as cored 0.20.0 and later ask it.
const connectAsk = (id, page, prompt = PROMPT) => ({
  request: id,
  prompt,
  page,
  kind: 'eth.connect',
  view: {
    accounts: [
      { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
    ],
    defaultIndex: 0,
    chain: { id: 100, name: 'Gnosis Chain' },
  },
  choices: { walletIndex: [0, 1] },
});

describe('the relay to eip1193.request (0012 APB-4a)', () => {
  test('a read goes to the core under the page\'s PageContext, with main\'s world, and its answer is the page\'s', async () => {
    const env = setup();
    env.state.selected.set(1, 1);
    const page = env.tab();
    env.core.script = async () => ({ result: '0x1' });
    expect(await page.ask('eth_chainId', [])).toEqual({ result: '0x1' });
    const [sent] = env.core.sent;
    expect(sent.method).toBe('eip1193.request');
    // A method the core reads no params for is sent without them.
    expect(sent.params).toEqual({
      method: 'eth_chainId',
      world: {
        enabled: true,
        chain: null,
        window_chain: 1,
        wallets: env.state.wallets,
        networks: {
          1: { available: true, name: 'Ethereum', symbol: 'ETH' },
          100: { available: true, name: 'Gnosis Chain', symbol: 'xDAI' },
          10: { available: false, name: 'Optimism' },
        },
        active: 0,
      },
    });
    expect(sent.context).toEqual({
      caller: 'page',
      page: { origin: KEY_A, top_origin: KEY_A, frame: 1000 + page.guest.id, navigation: expect.any(Number), agent: false },
    });
    expect(sent.watchdogMs).toBe(135_000);
    // The read methods carry their params; binary never reaches the JSON.
    env.core.script = async () => ({ error: { code: -32000, message: 'execution reverted', data: '0x08' } });
    expect(await page.ask('eth_call', [{ to: ACCOUNT }, 'latest'])).toEqual({
      error: { code: -32000, message: 'execution reverted', data: '0x08' },
    });
    expect(env.core.sent[1].params.params).toEqual([{ to: ACCOUNT }, 'latest']);
    expect(await page.ask('eth_call', [new Uint8Array(4)])).toEqual({
      error: { code: -32602, message: 'Invalid parameters' },
    });
    expect(env.core.sent).toHaveLength(2);
    expect(env.relay.running()).toBe(0);
  });

  test('a send\'s world carries D12\'s pause; no other method reads it', async () => {
    const env = setup();
    const page = env.tab();
    const context = { requester: { key: KEY_A, window: 1, chain: null } };
    env.state.paused = true;
    expect((await env.relay.worldFor(context, 'eth_sendTransaction')).paused).toBe(true);
    env.state.paused = false;
    expect((await env.relay.worldFor(context, 'eth_sendTransaction')).paused).toBe(false);
    expect('paused' in (await env.relay.worldFor(context, 'eth_accounts'))).toBe(false);
    // No key: paused, which no rule answers.
    expect((await env.relay.worldFor({ requester: { window: 1 } }, 'eth_sendTransaction')).paused).toBe(true);
    expect(page).toBeTruthy();
  });

  test('a keyless document goes with the empty origin, and gets the core\'s 4100 for a connect', async () => {
    const env = setup();
    const page = env.tab('data:text/html,<h1>keyless</h1>');
    env.core.script = async ({ page: pc }) =>
      pc.origin === '' ? { error: { ...NO_ADDRESS } } : { error: { code: -1, message: 'keyed' } };
    expect(await page.ask('eth_requestAccounts', [])).toEqual({ error: NO_ADDRESS });
    expect(env.core.sent[0].context.page).toMatchObject({ origin: '', top_origin: '' });
    expect(env.prompts()).toEqual([]);
  });

  test('{ send } and { device } never reach the page; a 0001 error is -32603', async () => {
    const env = setup();
    const page = env.tab();
    env.core.script = async () => ({ send: { kind: 'dapp-send', token: 'secret' } });
    const answered = await page.ask('eth_chainId', []);
    expect(answered.error.code).toBe(-32603);
    expect(JSON.stringify(answered)).not.toContain('secret');
    env.core.script = async () => {
      throw Object.assign(new Error('main\'s answer isn\'t the decision on this request\'s prompt'), {
        code: 'not_authorized',
      });
    };
    expect(await page.ask('net_version', [])).toEqual({
      error: { code: -32603, message: 'main\'s answer isn\'t the decision on this request\'s prompt' },
    });
  });
});

describe('approval.request for eth.connect (0012 APB-4a)', () => {
  test('main opens its connect prompt from the core\'s view, and answers with the decision on that handle, the prompt id echoed', async () => {
    const env = setup();
    const page = env.tab();
    let answer;
    env.core.script = async ({ id, page: pc }) => {
      answer = await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION });
      return { result: [SECOND] };
    };
    const asked = page.ask('eth_requestAccounts', []);
    await flush();
    const [shown] = env.prompts();
    expect(shown).toMatchObject({ kind: 'eth.connect', site: { key: KEY_A, label: KEY_A }, view: connectAsk(1).view });
    // The watchdog is held while main answers the prompt.
    expect(env.core.holds).toEqual([[GENERATION, 1]]);
    expect(env.core.released).toEqual([]);
    expect(await env.decide(shown.handle, true, { walletIndex: 1 })).toEqual({ ok: true });
    expect(await asked).toEqual({ result: [SECOND] });
    expect(answer).toEqual({
      prompt: PROMPT,
      handle: shown.handle,
      approve: true,
      choices: { walletIndex: 1 },
      world: expect.objectContaining({ enabled: true, wallets: env.state.wallets, active: 0 }),
    });
    expect(env.core.released).toEqual([[GENERATION, 1]]);
    // The new grant's events, after the answer.
    await flush();
    expect(page.guest.events).toEqual([
      ['accountsChanged', [SECOND]],
      ['connect', { chainId: '0x64' }],
    ]);
  });

  test('a rejection answers on its handle with no world; a pick not offered is refused at the decision', async () => {
    const env = setup();
    const page = env.tab();
    let answer;
    env.core.script = async ({ id, page: pc }) => {
      answer = await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION });
      return { error: { code: 4001, message: 'User rejected the request' } };
    };
    const asked = page.ask('eth_requestAccounts', []);
    await flush();
    const [shown] = env.prompts();
    expect(await env.decide(shown.handle, true, { walletIndex: 7 })).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
    expect(await asked).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    expect(answer).toEqual({ prompt: PROMPT, handle: shown.handle, approve: false, choices: {} });
    await flush();
    expect(page.guest.events).toEqual([]);
  });

  test('a navigation closes the prompt: the core hears closed, navigated, and the page nothing', async () => {
    const env = setup();
    const page = env.tab();
    let answer;
    env.core.script = async ({ id, page: pc }) => {
      answer = await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION });
      return { error: { code: 4001, message: 'User rejected the request' } };
    };
    const asked = page.ask('eth_requestAccounts', []);
    await flush();
    const [shown] = env.prompts();
    page.guest.commit(`${KEY_A}/next`);
    await flush();
    expect(answer).toEqual({ prompt: PROMPT, closed: 'navigated' });
    expect(env.closed()).toEqual([{ handle: shown.handle, reason: 'navigated' }]);
    expect(await asked).toEqual({ gone: true });
    expect(env.core.released).toEqual([[GENERATION, 1]]);
  });

  test('two prompts from one document: the second is busy, and a decision on the first answers only the first', async () => {
    const env = setup();
    const page = env.tab();
    const answers = {};
    // Both reach the core before either prompt opens; then the core asks.
    let go;
    const gate = new Promise((resolve) => {
      go = resolve;
    });
    env.core.script = async ({ id, page: pc }) => {
      await gate;
      if (id === 2) await flush();
      const prompt = id === 1 ? PROMPT : OTHER_PROMPT;
      answers[id] = await env.relay.approvalRequest(connectAsk(id, pc, prompt), { generation: GENERATION });
      return answers[id].busy
        ? { error: { code: -32002, message: 'Another wallet request is already pending' } }
        : { result: [ACCOUNT] };
    };
    const first = page.ask('eth_requestAccounts', []);
    await flush();
    const second = page.ask('eth_requestAccounts', []);
    await flush();
    expect(env.core.sent).toHaveLength(2);
    go();
    // Once a prompt is open, main's own route refuses a third before the core.
    await flush();
    expect(await page.ask('eth_requestAccounts', [])).toEqual({
      error: { code: -32002, message: 'Another wallet request is already pending' },
    });
    expect(env.core.sent).toHaveLength(2);
    expect(await second).toEqual({ error: { code: -32002, message: 'Another wallet request is already pending' } });
    expect(answers[2]).toEqual({ prompt: OTHER_PROMPT, busy: true });
    const [shown] = env.prompts();
    expect(env.prompts()).toHaveLength(1);
    expect(await env.decide(shown.handle, true, { walletIndex: 0 })).toEqual({ ok: true });
    expect(await first).toEqual({ result: [ACCOUNT] });
    expect(answers[1]).toMatchObject({ prompt: PROMPT, handle: shown.handle, approve: true });
  });

  test('crossed requests are refused: another document\'s page, an unknown request, another process, a malformed prompt id or view, a connect for another method', async () => {
    const env = setup();
    const page = env.tab();
    const other = env.tab(`${KEY_B}/`, { front: false });
    const refusals = [];
    // Each try is refused at once; one that opened a prompt would wait.
    const attempt = (ask, generation = GENERATION) =>
      Promise.race([
        env.relay.approvalRequest(ask, { generation }).then(() => 'answered', (err) => err.code),
        flush().then(() => 'opened'),
      ]);
    let answer;
    env.core.script = async ({ id, page: pc }) => {
      if (id === 1) {
        // A connect prompt for a request that isn't a connect.
        refusals.push(await attempt(connectAsk(id, pc)));
        return { result: '0x64' };
      }
      const otherPage = { ...pc, origin: KEY_B, top_origin: KEY_B };
      const tries = [
        connectAsk(id, otherPage),
        connectAsk(id, { ...pc, navigation: pc.navigation + 1 }),
        connectAsk(id + 100, pc),
        { ...connectAsk(id, pc), prompt: 'C'.repeat(32) },
        { ...connectAsk(id, pc), choices: { walletIndex: [1, 0] } },
        { ...connectAsk(id, pc), extra: true },
        { ...connectAsk(id, pc), kind: 'swarm.connect' },
      ];
      for (const ask of tries) refusals.push(await attempt(ask));
      // Another process's request of the same id.
      refusals.push(await attempt(connectAsk(id, pc), GENERATION + 1));
      // The core's own ask still opens its prompt.
      answer = await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION });
      return { result: [ACCOUNT] };
    };
    expect(await page.ask('eth_chainId', [])).toEqual({ result: '0x64' });
    const asked = page.ask('eth_requestAccounts', []);
    await flush();
    await flush();
    expect(refusals).toEqual(Array(9).fill('invalid_argument'));
    const [shown] = env.prompts();
    expect(env.prompts()).toHaveLength(1);
    expect(await env.decide(shown.handle, true, { walletIndex: 0 })).toEqual({ ok: true });
    expect(await asked).toEqual({ result: [ACCOUNT] });
    expect(answer).toMatchObject({ prompt: PROMPT, handle: shown.handle, approve: true });
    expect(other.guest.events).toEqual([]);
  });

  test('a send\'s, a signature\'s or an unlock\'s prompt for a connect is refused, and opens nothing', async () => {
    const env = setup();
    const page = env.tab();
    const answers = [];
    env.core.script = async ({ id, page: pc }) => {
      for (const kind of ['eth.send', 'eth.sign', 'vault.unlock']) {
        await expect(
          env.relay.approvalRequest({ ...connectAsk(id, pc), kind }, { generation: GENERATION })
        ).rejects.toMatchObject({ code: 'invalid_argument' });
      }
      return { error: { code: -32002, message: 'Another wallet request is already pending' } };
    };
    await page.ask('eth_requestAccounts', []);
    expect(answers).toEqual([]);
    expect(env.prompts()).toEqual([]);
  });

  test('the core\'s cancel closes the prompt, cancelled', async () => {
    const env = setup();
    const page = env.tab();
    const cancel = new AbortController();
    let answer;
    env.core.script = async ({ id, page: pc }) => {
      answer = await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION, signal: cancel.signal });
      return { error: { code: -32603, message: 'The request\'s deadline passed' } };
    };
    const asked = page.ask('eth_requestAccounts', []);
    await flush();
    const [shown] = env.prompts();
    cancel.abort();
    expect(await asked).toEqual({ error: { code: -32603, message: 'The request\'s deadline passed' } });
    expect(answer).toEqual({ prompt: PROMPT, closed: 'cancelled' });
    expect(env.closed()).toEqual([{ handle: shown.handle, reason: 'cancelled' }]);
  });

  test('a name moved off its IPNS key by the approve: the core hears closed, and the page main\'s 4100', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    let answer;
    env.core.script = async ({ id, page: pc }) => {
      answer = await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION });
      return { error: { code: 4001, message: 'User rejected the request' } };
    };
    const asked = page.ask('eth_requestAccounts', []);
    await flush();
    const [shown] = env.prompts();
    expect(env.core.sent[0].context.page.origin).toBe(NAME);
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(shown.handle, true, { walletIndex: 0 })).toEqual({ ok: true });
    expect(await asked).toEqual({ error: NO_ADDRESS });
    expect(answer).toEqual({ prompt: PROMPT, closed: 'cancelled' });
  });

  test('the core\'s view is rebuilt to main\'s form, and a malformed one refused', () => {
    expect(connectShown(connectAsk(1).view, { walletIndex: [0, 1] }).view).toEqual(connectAsk(1).view);
    const bad = [
      [{ ...connectAsk(1).view, defaultIndex: 5 }, { walletIndex: [0, 1] }],
      [{ ...connectAsk(1).view, chain: { id: 0, name: null } }, { walletIndex: [0, 1] }],
      [connectAsk(1).view, { walletIndex: [0] }],
      [connectAsk(1).view, { walletIndex: [0, 1], extra: [] }],
      [{ ...connectAsk(1).view, accounts: [{ index: 0 }, { index: 0 }] }, { walletIndex: [0, 0] }],
    ];
    for (const [view, choices] of bad) expect(() => connectShown(view, choices)).toThrow('invalid_argument');
  });
});

describe('approval.recheck and eip1193.select_chain (0012 APB-4a)', () => {
  test('a recheck reads the document and custody now', async () => {
    const env = setup();
    const page = env.tab();
    const rechecks = [];
    let done;
    env.core.script = async ({ id, page: pc }) => {
      rechecks.push(await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION }));
      env.state.agent = true;
      rechecks.push(await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION }));
      page.guest.commit(`${KEY_A}/next`);
      rechecks.push(await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION }));
      done = true;
      return { result: [ACCOUNT] };
    };
    // The navigation answers the page (gone); the core's request runs on.
    expect(await page.ask('eth_requestAccounts', [])).toEqual({ gone: true });
    await flush();
    expect(done).toBe(true);
    expect(rechecks).toEqual([
      { live: true, agent: false },
      { live: true, agent: true },
      { live: false, agent: true },
    ]);
  });

  test('select_chain selects for the request\'s window and sends chainChanged to that window\'s pages only, before the answer', async () => {
    const env = setup();
    const sibling = env.tab(`${KEY_B}/`, { front: false });
    const onchain = env.tab(`web3://${ONCHAIN}.eip155-1/`, { front: false });
    const elsewhere = env.tab(`${KEY_B}/w2`, { window: 2, front: false });
    const page = env.tab();
    let selected;
    env.core.script = async ({ id, page: pc }) => {
      selected = await env.relay.selectChain({ request: id, page: pc, chain_id: 1 }, { generation: GENERATION });
      expect(page.guest.events).toEqual([['chainChanged', '0x1']]);
      return { result: null };
    };
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(selected).toEqual({});
    expect(env.state.selections).toEqual([[1, 1]]);
    expect(env.core.sent[0].params.params).toEqual([{ chainId: '0x1' }]);
    expect(sibling.guest.events).toEqual([['chainChanged', '0x1']]);
    expect(onchain.guest.events).toEqual([]);
    expect(elsewhere.guest.events).toEqual([]);
  });

  test('select_chain refuses a chain the page didn\'t ask for, one the registry can\'t serve, and a document that lost its key', async () => {
    const env = setup();
    const page = env.tab();
    const outcomes = [];
    env.core.script = async ({ id, page: pc }) => {
      for (const chain_id of [100, 10, 0]) {
        await env.relay
          .selectChain({ request: id, page: pc, chain_id }, { generation: GENERATION })
          .then(() => outcomes.push('selected'), (err) => outcomes.push(err.code));
      }
      return { error: { code: -32603, message: 'mismatch' } };
    };
    await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }]);
    // And one asked for chain 10, which has no source.
    env.core.script = async ({ id, page: pc }) => {
      await env.relay
        .selectChain({ request: id, page: pc, chain_id: 10 }, { generation: GENERATION })
        .then(() => outcomes.push('selected'), (err) => outcomes.push(err.code));
      return { result: null };
    };
    await page.ask('wallet_switchEthereumChain', [{ chainId: '0xa' }]);
    expect(outcomes).toEqual(Array(4).fill('invalid_argument'));
    expect(env.state.selections).toEqual([]);
    expect(page.guest.events).toEqual([]);

    // A bound document whose key main no longer holds by the selection
    // (main's own check of the name, for a step it holds, ended its
    // binding): main's recheck reads it, resolving nothing, and nothing is
    // selected, with main's 4100.
    env.names.set(NAME, IPNS_KEY);
    const named = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    await flush();
    const rechecks = [];
    env.core.script = async ({ id, page: pc }) => {
      rechecks.push(await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION }));
      env.names.set(NAME, OTHER_IPNS_KEY);
      await named.mainChecks(NAME);
      const resolved = env.state.resolutions.length;
      rechecks.push(await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION }));
      expect(env.state.resolutions).toHaveLength(resolved);
      await env.relay
        .selectChain({ request: id, page: pc, chain_id: 1 }, { generation: GENERATION })
        .then(() => outcomes.push('selected'), (err) => outcomes.push(err.code));
      return { error: { code: -32603, message: 'mismatch' } };
    };
    expect(await named.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ error: NO_ADDRESS });
    expect(rechecks).toEqual([
      { live: true, agent: false },
      { live: false, agent: false },
    ]);
    expect(outcomes.at(-1)).toBe('invalid_argument');
    expect(env.state.selections).toEqual([]);
  });
});

// ---- APB-4b: the signatures, `vault.unlock` and `{ device }` ----

const MESSAGE = '0x48656c6c6f';
const TYPED = JSON.stringify({
  types: { EIP712Domain: [{ name: 'name', type: 'string' }], Mail: [{ name: 'contents', type: 'string' }] },
  domain: { name: 'Fixture' },
  primaryType: 'Mail',
  message: { contents: 'hi' },
});
const TYPED_HASH = '0x' + '5a'.repeat(32);
const LEDGER = 1000000;
const PHONE = 1000001;
const SAFE = 5000;
const SAFE_ADDRESS = '0x' + 'aa'.repeat(20);
const TOKEN = 'b'.repeat(64);
const DEVICE_WALLETS = [
  { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
  { index: LEDGER, name: 'Ledger', address: SECOND, type: 'ledger' },
  { index: PHONE, name: 'Phone', address: SECOND, type: 'remote' },
  { index: SAFE, name: 'Safe', address: SAFE_ADDRESS, type: 'safe' },
];
const accountOf = (index) => DEVICE_WALLETS.find((wallet) => wallet.index === index);

// The core's eth.sign prompt for request `id`, as cored 0.20.0 and later ask it.
function signAsk(id, page, { method = 'personal_sign', account = 0, offered = [false, true], prompt = PROMPT } = {}) {
  const view = { method, account: accountOf(account), chain: { id: 100, name: 'Gnosis Chain' } };
  if (method === 'personal_sign') view.message = { hex: MESSAGE, rawHash: false };
  else view.typedData = { hash: TYPED_HASH, view: { primary_type: 'Mail' }, warnings: [] };
  if (method !== 'personal_sign') view.chains = {};
  return { request: id, prompt, page, kind: 'eth.sign', view, choices: { alwaysAllow: offered } };
}
const unlockAsk = (id, page, prompt = PROMPT) => ({
  request: id,
  prompt,
  page,
  kind: 'vault.unlock',
  view: { account: accountOf(0), reason: 'sign' },
  choices: {},
});

// A stand-in core that asks main `ask(id, page)` and, on an approve, answers
// with `onApprove(answer)`; otherwise with the reference's 4001.
function asking(env, ask, onApprove) {
  const answers = [];
  env.core.script = async ({ id, page: pc }) => {
    const answer = await env.relay.approvalRequest(ask(id, pc), { generation: GENERATION });
    answers.push(answer);
    if (answer.approve === true) return onApprove(answer, pc);
    if (answer.busy) return { error: { code: -32002, message: 'Another wallet request is already pending' } };
    return { error: { code: 4001, message: 'User rejected the request' } };
  };
  return answers;
}

describe('signatures through the relay (0012 APB-4b)', () => {
  test('personal_sign goes to the core with its params; main\'s eth.sign prompt shows the core\'s view; the approve echoes the prompt and handle, with "Always allow" and world; the core\'s signature is the page\'s', async () => {
    const env = setup();
    const page = env.tab();
    const answers = asking(env, signAsk, () => ({ result: '0x' + '1'.repeat(130) }));
    const asked = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.core.sent[0].params).toMatchObject({ method: 'personal_sign', params: [MESSAGE, ACCOUNT] });
    expect(env.core.sent[0].params.world.paused).toBeUndefined();
    const [shown] = env.prompts();
    expect(shown.kind).toBe('eth.sign');
    expect(shown.view).toEqual({
      method: 'personal_sign',
      account: accountOf(0),
      chain: { id: 100, name: 'Gnosis Chain' },
      message: { hex: MESSAGE, rawHash: false },
      alwaysAllow: true,
    });
    expect(env.core.holds).toEqual([[GENERATION, 1]]);
    expect(await env.decide(shown.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect(await asked).toEqual({ result: '0x' + '1'.repeat(130) });
    expect(answers).toEqual([
      {
        prompt: PROMPT,
        handle: shown.handle,
        approve: true,
        choices: { alwaysAllow: true },
        world: expect.objectContaining({ enabled: true, window_chain: 100, wallets: env.state.wallets }),
      },
    ]);
    expect(env.core.released).toEqual([[GENERATION, 1]]);
    // A typed-data request's view keeps the core's view of the data.
    asking(env, (id, pc) => signAsk(id, pc, { method: 'eth_signTypedData_v4' }), () => ({ result: '0x02' }));
    const typed = page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
    await flush();
    const typedShown = env.prompts()[1];
    expect(typedShown.view).toMatchObject({
      method: 'eth_signTypedData_v4',
      typedData: { hash: TYPED_HASH, view: { primary_type: 'Mail' }, warnings: [] },
      chains: {},
      alwaysAllow: true,
    });
    expect(await env.decide(typedShown.handle, true, {})).toEqual({ ok: true });
    expect(await typed).toEqual({ result: '0x02' });
  });

  test('a rejection answers on its handle, and the core\'s 4001 is the page\'s; a rule-answered signature opens no prompt', async () => {
    const env = setup();
    const page = env.tab();
    const answers = asking(env, signAsk, () => ({ result: '0x01' }));
    const asked = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const [shown] = env.prompts();
    expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
    expect(await asked).toEqual({ error: { code: 4001, message: 'User rejected the request' } });
    expect(answers).toEqual([{ prompt: PROMPT, handle: shown.handle, approve: false, choices: {} }]);
    // The rule: the core rechecks the document and signs, with no prompt.
    let recheck;
    env.core.script = async ({ id, page: pc }) => {
      recheck = await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION });
      return { result: '0x03' };
    };
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual({ result: '0x03' });
    expect(recheck).toEqual({ live: true, agent: false });
    expect(env.prompts()).toHaveLength(1);
  });

  test('a device\'s prompt offers no "Always allow": main\'s view says so, a ticked box is refused at the decision with the prompt still open', async () => {
    const env = setup();
    env.state.wallets = DEVICE_WALLETS;
    const page = env.tab();
    const answers = asking(env, (id, pc) => signAsk(id, pc, { account: LEDGER, offered: [false] }), () => ({
      error: { code: 4001, message: 'User rejected the request' },
    }));
    const asked = page.ask('personal_sign', [MESSAGE, SECOND]);
    await flush();
    const [shown] = env.prompts();
    expect(shown.view).toMatchObject({ account: accountOf(LEDGER), alwaysAllow: false });
    expect(await env.decide(shown.handle, true, { alwaysAllow: true })).toEqual({ ok: false, reason: 'invalid' });
    expect(answers).toEqual([]);
    expect(await env.decide(shown.handle, true, { alwaysAllow: false })).toEqual({ ok: true });
    await asked;
    expect(answers[0]).toMatchObject({ approve: true, choices: { alwaysAllow: false } });
  });

  test('crossed sign prompts are refused: a view for another method, choices that don\'t offer false or repeat, an unlock for another reason', async () => {
    const env = setup();
    const page = env.tab();
    const refusals = [];
    env.core.script = async ({ id, page: pc }) => {
      const tries = [
        signAsk(id, pc, { method: 'eth_signTypedData_v4' }),
        signAsk(id, pc, { offered: [true] }),
        signAsk(id, pc, { offered: [false, false] }),
        { ...signAsk(id, pc), choices: { alwaysAllow: [false], other: [1] } },
        { ...unlockAsk(id, pc), view: { account: accountOf(0), reason: 'send' } },
        { ...unlockAsk(id, pc), choices: { password: [] } },
        { ...connectAsk(id, pc) },
      ];
      for (const ask of tries) {
        refusals.push(
          await env.relay.approvalRequest(ask, { generation: GENERATION }).then(
            () => 'answered',
            (err) => err.code
          )
        );
      }
      return { error: { code: -32603, message: 'crossed' } };
    };
    await page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    expect(refusals).toEqual(Array(7).fill('invalid_argument'));
    expect(env.prompts()).toEqual([]);
    // The view rebuilt: unknown fields refused, a typed-data view's message refused.
    expect(() => signShown({ ...signAsk(1, {}).view, extra: 1 }, { alwaysAllow: [false] }, 'personal_sign')).toThrow();
    expect(() =>
      signShown({ ...signAsk(1, {}, { method: 'eth_signTypedData_v4' }).view, message: {} }, { alwaysAllow: [false] }, 'eth_signTypedData_v4')
    ).toThrow();
    expect(unlockShown({ account: accountOf(0), reason: 'sign' }, {}, 'personal_sign')).toEqual({
      view: { account: accountOf(0), reason: 'sign' },
    });
  });

  test('vault.unlock: a rejection, a navigation and busy answer as such; an approve goes to the core as it is, which refuses the signature while the vault is still locked', async () => {
    const env = setup();
    const page = env.tab();
    // The core's answer after an approve: the vault's refusal while it is
    // still locked (core #398), else the signature.
    const answers = asking(env, unlockAsk, () =>
      env.state.unlocked ? { result: '0x01' } : { error: { code: -32603, message: 'Vault is locked' } }
    );
    env.state.unlocked = false;
    const rejected = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    let [shown] = env.prompts();
    expect(shown).toMatchObject({ kind: 'vault.unlock', view: { account: accountOf(0), reason: 'sign' } });
    expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
    await rejected;
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, handle: shown.handle, approve: false, choices: {} });

    // Approved with the vault still locked: the approve goes to the core as
    // it is, and the page hears the core's refusal.
    const locked = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    shown = env.prompts()[1];
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(await locked).toEqual({ error: { code: -32603, message: 'Vault is locked' } });
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, handle: shown.handle, approve: true, choices: {}, world: expect.any(Object) });

    // Open: approved, with no choices and main's world.
    const open = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    shown = env.prompts()[2];
    env.state.unlocked = true;
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(await open).toEqual({ result: '0x01' });
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, handle: shown.handle, approve: true, choices: {}, world: expect.any(Object) });

    // Busy: a second unlock while the first is up.
    env.state.unlocked = false;
    const first = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const second = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(await second).toEqual({ error: { code: -32002, message: 'Another wallet request is already pending' } });
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, busy: true });
    // The navigation closes the first's.
    page.guest.commit(`${KEY_A}/next`);
    expect(await first).toEqual({ gone: true });
    await flush();
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, closed: 'navigated' });
  });

  test('with the approvals document on: a vault account\'s prompt asks for the unlock first, whose cancel gives 4001 "User cancelled unlock"; a rule\'s unlock takes the password, and its approve names its own handle', async () => {
    const env = setup({ approvalsDocument: true });
    const page = env.tab();
    env.state.unlocked = false;
    const answers = asking(env, signAsk, () => ({ result: '0x01' }));
    const cancelled = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const [unlock] = env.prompts();
    expect(unlock).toMatchObject({ kind: 'vault.unlock', view: { account: accountOf(0), reason: 'sign' } });
    expect(await env.decide(unlock.handle, false)).toEqual({ ok: true });
    expect(await cancelled).toEqual({ error: { code: 4001, message: 'User cancelled unlock' } });
    expect(answers).toEqual([{ prompt: PROMPT, closed: 'cancelled' }]);

    const ruleAnswers = asking(env, unlockAsk, () => ({ result: '0x04' }));
    const ruled = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const first = env.prompts()[1];
    expect(await env.decide(first.handle, true, { password: 'wrong' })).toEqual({ ok: true });
    await flush();
    const again = env.prompts()[2];
    expect(again.view.failed).toBe(true);
    expect(await env.decide(again.handle, true, { password: 'right password' })).toEqual({ ok: true });
    expect(await ruled).toEqual({ result: '0x04' });
    expect(ruleAnswers).toEqual([{ prompt: PROMPT, handle: again.handle, approve: true, choices: {}, world: expect.any(Object) }]);
    expect(JSON.stringify(ruleAnswers)).not.toContain('right password');
  });

  test('a name moved off its IPNS key by the approve: the core hears closed, and the page main\'s 4100', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answers = asking(env, signAsk, () => ({ result: '0x01' }));
    const asked = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const [shown] = env.prompts();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(await asked).toEqual({ error: NO_ADDRESS });
    expect(answers).toEqual([{ prompt: PROMPT, closed: 'cancelled' }]);
  });

  test('a vault signature: the core checks the name after it (APR-5f), so main resolves nothing after its answer; one whose binding main ended meanwhile is withheld with main\'s 4100', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    // From main's prompt: approved with the name in place; the core's
    // signature goes to the page with no resolution of main's after it.
    const prompted = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    await flush();
    let resolved;
    const answers = asking(env, signAsk, () => {
      resolved = env.state.resolutions.length;
      return { result: '0x01' };
    });
    const asked = prompted.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const [shown] = env.prompts();
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    expect(await asked).toEqual({ result: '0x01' });
    expect(env.state.resolutions).toHaveLength(resolved);
    expect(answers).toEqual([expect.objectContaining({ prompt: PROMPT, handle: shown.handle, approve: true })]);
    expect(env.core.sent.at(-1).context.page.transport_key).toBe(`ipns://${IPNS_KEY}`);
    // A rule's signature, with no prompt, while main's own check of the
    // name (a step main holds) finds it moved and ends main's binding: the
    // core's signature is withheld.
    const ruled = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    await flush();
    env.core.script = async () => {
      env.names.set(NAME, OTHER_IPNS_KEY);
      await ruled.mainChecks(NAME);
      return { result: '0x03' };
    };
    expect(await ruled.ask('eth_signTypedData_v4', [ACCOUNT, '{}'])).toEqual({ error: NO_ADDRESS });
    expect(env.core.sent.at(-1).params).toMatchObject({ method: 'eth_signTypedData_v4', params: [ACCOUNT, '{}'] });
    expect(env.prompts()).toHaveLength(1);
  });
});

describe('{ device } answers (0012 APB-4b)', () => {
  // A stand-in device step's dependencies: what each was asked.
  function deviceSetup(signature = '0x' + 'de'.repeat(65)) {
    const calls = { signers: [], signed: [], spentSafe: [], safes: [], cancelled: [] };
    const deviceDeps = {
      getSigner: (index, authorized) => {
        calls.signers.push([index, authorized]);
        return {
          signMessage: async (message) => {
            calls.signed.push(['message', message]);
            if (calls.fail) throw calls.fail;
            calls.duringSign?.();
            return signature;
          },
          signTypedData: async (typedData, options) => {
            calls.signed.push(['typed', typedData, options]);
            return signature;
          },
        };
      },
      spendSafe: async (confirmation) => {
        calls.spentSafe.push(confirmation);
        return { bound: true, approval: { id: 'e'.repeat(32), page: confirmation.page } };
      },
      startSafeMessage: async (options) => {
        calls.safes.push(options);
        return { complete: true, token: 'session' };
      },
      completeSafeMessage: async () => ({ signature: '0x5afe' }),
      cancelSafeMessage: async (index, token) => calls.cancelled.push(token),
      safeBoards: () => null,
    };
    const env = setup({ deviceDeps });
    env.state.wallets = DEVICE_WALLETS;
    return { env, calls };
  }

  // The core's prompt for a device's account, and its `{ device }` on the
  // approve: `device(answer, page)` builds it.
  const deviceAsk = (env, method, account, device) =>
    asking(env, (id, pc) => signAsk(id, pc, { method, account, offered: [false] }), (answer, pc) => ({
      device: device(answer, pc),
    }));

  async function approveOne(env, page, method, params) {
    const asked = page.ask(method, params);
    await flush();
    const shown = env.prompts().at(-1);
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    return { answer: await asked, shown };
  }

  test('a Ledger\'s message and typed data: the token as a confirmation for the request\'s PageContext and handle, the core\'s payload presented, then discarded', async () => {
    const { env, calls } = deviceSetup();
    const page = env.tab();
    let pc;
    deviceAsk(env, 'personal_sign', LEDGER, (answer, page0) => {
      pc = page0;
      return { type: 'ledger', kind: 'sign-message', account: LEDGER, payload: { message: MESSAGE }, handle: answer.handle, token: TOKEN };
    });
    const { answer, shown } = await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND]);
    expect(answer).toEqual({ result: '0x' + 'de'.repeat(65) });
    expect(calls.signers).toEqual([
      [LEDGER, { confirmation: { token: TOKEN, kind: 'sign-message', account: LEDGER, payload: { message: MESSAGE }, handle: shown.handle, page: pc } }],
    ]);
    expect(calls.signed).toEqual([['message', MESSAGE]]);
    expect(env.state.discarded).toEqual([TOKEN]);

    const payload = { typed_data: { primary_type: 'Mail' }, chain_id: '100' };
    deviceAsk(env, 'eth_signTypedData_v4', LEDGER, (approved) => ({
      type: 'ledger',
      kind: 'sign-typed-data',
      account: LEDGER,
      payload,
      expected_hash: TYPED_HASH,
      handle: approved.handle,
      token: TOKEN,
    }));
    const typed = await approveOne(env, page, 'eth_signTypedData_v4', [SECOND, TYPED]);
    expect(typed.answer).toEqual({ result: '0x' + 'de'.repeat(65) });
    expect(calls.signers[1][1].confirmation).toMatchObject({ kind: 'sign-typed-data', payload, handle: typed.shown.handle });
    // The page's typed data, which must hash to what the token bound.
    expect(calls.signed[1]).toEqual(['typed', TYPED, { expectedHash: TYPED_HASH }]);
  });

  test('a phone\'s signature goes the same way, its job the signer\'s; a Safe\'s spends its token for the Safe approval and starts the session with the core\'s payload', async () => {
    const { env, calls } = deviceSetup();
    const page = env.tab();
    deviceAsk(env, 'personal_sign', PHONE, (answer) => ({
      type: 'remote',
      kind: 'sign-message',
      account: PHONE,
      payload: { message: MESSAGE },
      handle: answer.handle,
      token: TOKEN,
    }));
    expect((await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND])).answer).toEqual({ result: '0x' + 'de'.repeat(65) });
    expect(calls.signers[0][0]).toBe(PHONE);

    const safePayload = { safe: SAFE_ADDRESS, chain_id: '100', method: 'personal_sign', params: [MESSAGE, SAFE_ADDRESS] };
    deviceAsk(env, 'personal_sign', SAFE, (answer) => ({
      type: 'safe',
      kind: 'safe-message',
      account: SAFE,
      payload: safePayload,
      handle: answer.handle,
      token: TOKEN,
    }));
    const safe = await approveOne(env, page, 'personal_sign', [MESSAGE, SAFE_ADDRESS]);
    expect(safe.answer).toEqual({ result: '0x5afe' });
    expect(calls.spentSafe).toEqual([
      expect.objectContaining({ token: TOKEN, kind: 'safe-message', account: SAFE, payload: safePayload, handle: safe.shown.handle }),
    ]);
    expect(calls.safes[0]).toMatchObject({
      safeIndex: SAFE,
      request: { method: 'personal_sign', params: [MESSAGE, SAFE_ADDRESS] },
      owner: 'main',
      approval: { id: 'e'.repeat(32) },
    });
    expect(calls.signers).toHaveLength(1);
    expect(env.state.discarded).toEqual([TOKEN, TOKEN]);
  });

  test('a crossed { device } is refused before any spend, its token discarded and in no answer: another handle, another kind, another type\'s, an account main doesn\'t list as that device, or a device for a connect', async () => {
    const { env, calls } = deviceSetup();
    const page = env.tab();
    const base = (answer) => ({
      type: 'ledger',
      kind: 'sign-message',
      account: LEDGER,
      payload: { message: MESSAGE },
      handle: answer.handle,
      token: TOKEN,
    });
    const crossings = [
      (answer) => ({ ...base(answer), handle: 'f'.repeat(64) }),
      (answer) => ({ ...base(answer), kind: 'sign-typed-data', expected_hash: TYPED_HASH }),
      (answer) => ({ ...base(answer), kind: 'safe-message' }),
      (answer) => ({ ...base(answer), type: 'safe' }),
      (answer) => ({ ...base(answer), payload: { message: MESSAGE, extra: 1 } }),
      (answer) => ({ ...base(answer), expected_hash: TYPED_HASH }),
      (answer) => ({ ...base(answer), extra: true }),
    ];
    for (const crossing of crossings) {
      deviceAsk(env, 'personal_sign', LEDGER, crossing);
      const { answer } = await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND]);
      expect(answer).toEqual({ error: { code: -32603, message: "The identity core's device answer doesn't match the request" } });
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
    }
    // A device type main doesn't list the account as: no spend either.
    deviceAsk(env, 'personal_sign', LEDGER, (answer) => ({ ...base(answer), type: 'remote' }));
    expect((await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND])).answer.error.code).toBe(-32603);
    expect(calls.signers).toEqual([]);
    expect(calls.spentSafe).toEqual([]);
    expect(env.state.discarded).toEqual(Array(crossings.length + 1).fill(TOKEN));
    // A `{ device }` with no prompt approved, or for a method that has none.
    env.core.script = async () => ({ device: { ...base({ handle: 'f'.repeat(64) }) } });
    expect((await page.ask('personal_sign', [MESSAGE, SECOND])).error.code).toBe(-32603);
    expect((await page.ask('eth_chainId', [])).error.code).toBe(-32603);
    expect(calls.signers).toEqual([]);
    expect(env.state.discarded).toHaveLength(crossings.length + 3);
  });

  test('a device\'s refusal is the user\'s 4001, a failure its message without the token, and a name that moved while the device signed gets main\'s 4100', async () => {
    const { env, calls } = deviceSetup();
    env.names.set(NAME, IPNS_KEY);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    deviceAsk(env, 'personal_sign', LEDGER, (answer) => ({
      type: 'ledger',
      kind: 'sign-message',
      account: LEDGER,
      payload: { message: MESSAGE },
      handle: answer.handle,
      token: TOKEN,
    }));
    calls.fail = Object.assign(new Error('Declined on the device'), { code: 'LEDGER_USER_REJECTED' });
    expect((await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND])).answer).toEqual({
      error: { code: 4001, message: 'User rejected the request' },
    });
    calls.fail = new Error('The device is busy');
    const failed = (await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND])).answer;
    expect(failed).toEqual({ error: { code: -32603, message: 'The device is busy' } });
    calls.fail = null;
    calls.duringSign = () => env.names.set(NAME, OTHER_IPNS_KEY);
    expect((await approveOne(env, page, 'personal_sign', [MESSAGE, SECOND])).answer).toEqual({ error: NO_ADDRESS });
    expect(env.state.discarded).toEqual([TOKEN, TOKEN, TOKEN]);
  });
});

// APB-4c: the sends.
const CALL = { to: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', value: '0x0', data: `0x095ea7b3${'00'.repeat(32)}` };
// The core's prepared send for CALL: `sign.transaction`'s form, no nonce.
const CORE_TX = Object.freeze({
  type: 0,
  chain_id: '100',
  to: CALL.to,
  value: '0',
  data: CALL.data,
  gas_limit: '21000',
  gas_price: '1000000000',
});
const FEE = { gasLimit: '21000', gasPrice: '1000000000', estimate: '21000000000000' };
const SEND_HASH = '0x' + 'ab'.repeat(32);
const RECEIPT = 'e'.repeat(32);
const SEND_MISMATCH = { code: -32603, message: "The identity core's send doesn't match the request" };
const DEVICE_MISMATCH = { code: -32603, message: "The identity core's device answer doesn't match the request" };

// The core's eth.send prompt for request `id`, as cored 0.20.0 and later ask it.
function sendAsk(id, page, { account = 0, fee = FEE, again = false, prompt = PROMPT, above = false } = {}) {
  const safe = accountOf(account).type === 'safe';
  return {
    request: id,
    prompt,
    page,
    kind: 'eth.send',
    view: {
      account: accountOf(account),
      chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
      tx: { to: CALL.to, value: '0', data: CALL.data },
      fee: safe ? { paidBy: 'executor' } : fee,
      feeCheck: safe ? null : { comparable: true, above, autoApprove: !above, ratio: above ? 10 : 1 },
      feeAskAgain: again,
      alwaysAllow: !safe,
    },
    choices: { alwaysAllow: safe ? [false] : [false, true], feeAcknowledged: [false, true] },
  };
}

/**
 * Main's payment steps, stood in: the site's turn, the signer it builds,
 * the transaction service, which adds the nonce (7) as main does
 * (`buildTransaction`, then the core's form), runs main's guard after the
 * "signature" around the journal and broadcast (`committed`), and says
 * whether it recorded the send; and the core's `approval.check` for a
 * rule's send (`rule`: its answer, or a function giving it; covered when
 * null).
 */
function payments() {
  const paid = {
    turns: [],
    signed: [],
    committed: [],
    remembered: [],
    safes: [],
    checks: [],
    busy: false,
    waiting: false,
    refuse: null,
    during: null,
    failAfterSign: null,
    afterCommit: null,
    recorded: true,
    rule: null,
  };
  paid.deps = {
    takeSiteTurn: async (site, { wait }) => {
      paid.turns.push([site, wait]);
      if (paid.busy && !wait) throw Object.assign(new Error('busy'), { code: 'SITE_TURN_BUSY' });
      return () => {};
    },
    sitePaymentWaiting: async () => paid.waiting,
    getSigner: (index, authorized) => ({ index, authorized }),
    signAndRecord: async (tx, signer, context, options) => {
      const presented = toCoreTransaction(buildTransaction({ ...tx, nonce: 7 })).tx;
      if (paid.refuse) throw paid.refuse;
      const { authorized } = signer;
      // A Ledger's spend of a flagged token gives a receipt.
      if (authorized.confirmation?.account === LEDGER) authorized.onReceipt({ receipt: RECEIPT, page: authorized.confirmation.page });
      paid.signed.push({ index: signer.index, authorized, presented, tx, context });
      await paid.during?.();
      if (paid.failAfterSign) throw paid.failAfterSign;
      const commit = async () => {
        paid.committed.push(presented);
        return {};
      };
      await (options.guardCommit ? options.guardCommit(commit) : commit());
      options.onCommitted?.();
      await paid.afterCommit?.();
      return { hash: SEND_HASH, recorded: paid.recorded };
    },
    checkStanding: async (page, request) => {
      paid.checks.push({ page, request });
      return (typeof paid.rule === 'function' ? paid.rule() : paid.rule) ?? { covered: true, reason: null };
    },
    rememberDeviceSend: async (held) => {
      paid.remembered.push({ ...held });
      return { added: true };
    },
    reserveSafeSend: () => ({ release: () => {} }),
    spendSafe: async (confirmation) => {
      paid.safes.push(confirmation);
      return { approval: { id: 'f'.repeat(32), page: confirmation.page } };
    },
    startSafeSend: async () => {
      throw new Error('The Safe stand-in stops here');
    },
  };
  return paid;
}

describe('sends through the relay (0012 APB-4c)', () => {
  function sendSetup(options = {}) {
    const paid = payments();
    const env = setup({ ...options, coreSendDeps: paid.deps });
    env.state.wallets = DEVICE_WALLETS;
    env.state.grants.set('*', { walletIndex: 0 });
    return { env, paid };
  }
  // The core asks `ask(id, page)` and answers an approve with `onApprove`.
  const sending = (env, ask, onApprove) => asking(env, ask, onApprove);
  async function approveSend(env, page, choices = {}, params = [CALL]) {
    const asked = page.ask('eth_sendTransaction', params);
    await flush();
    const shown = env.prompts().at(-1);
    expect(await env.decide(shown.handle, true, choices)).toEqual({ ok: true });
    return { answer: await asked, shown };
  }
  const tokenSend = (answer, account = 0, tx = CORE_TX) => ({
    send: { kind: 'dapp-send', account, tx, handle: answer.handle, token: TOKEN },
  });

  test('a vault send: main\'s eth.send prompt from the core\'s view; the approve echoes the prompt and handle with both choices and world; { send } signed in the site\'s turn with only the nonce added, under the token, its handle and the request\'s PageContext; the page gets the hash', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const answers = sending(env, sendAsk, (answer) => tokenSend(answer));
    const asked = page.ask('eth_sendTransaction', [CALL]);
    await flush();
    expect(env.core.sent[0].params).toMatchObject({ method: 'eth_sendTransaction', params: [CALL], world: { paused: false } });
    const [shown] = env.prompts();
    expect(shown.kind).toBe('eth.send');
    expect(shown.view).toEqual(sendAsk(1, null).view);
    expect(await env.decide(shown.handle, true, { alwaysAllow: true })).toEqual({ ok: true });
    expect(await asked).toEqual({ result: SEND_HASH });
    expect(answers).toEqual([
      {
        prompt: PROMPT,
        handle: shown.handle,
        approve: true,
        choices: { alwaysAllow: true, feeAcknowledged: false },
        world: expect.objectContaining({ paused: false }),
      },
    ]);
    expect(paid.turns).toEqual([[KEY_A, true]]);
    const [signed] = paid.signed;
    // Main adds the nonce, and nothing else: the core's form comes back.
    expect(signed.presented).toEqual({ ...CORE_TX, nonce: '7' });
    expect(signed.index).toBe(0);
    expect(signed.authorized.confirmation).toEqual({
      token: TOKEN,
      kind: 'dapp-send',
      handle: shown.handle,
      page: env.core.sent[0].context.page,
    });
    expect(signed.context).toMatchObject({ kind: 'dapp-send', origin: KEY_A });
    expect(env.state.discarded).toEqual([TOKEN]);
  });

  test('a type-2 send: the core\'s two fees pass unchanged, with the nonce the only field added', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const fee = { gasLimit: '25200', maxFeePerGas: '3000000000', maxPriorityFeePerGas: '2000000000', estimate: '1' };
    const tx = { type: 2, chain_id: '100', to: CALL.to, value: '0', data: CALL.data, gas_limit: '25200', max_fee_per_gas: '3000000000', max_priority_fee_per_gas: '2000000000' };
    sending(env, (id, pc) => sendAsk(id, pc, { fee }), (answer) => tokenSend(answer, 0, tx));
    expect((await approveSend(env, page)).answer).toEqual({ result: SEND_HASH });
    expect(paid.signed[0].presented).toEqual({ ...tx, nonce: '7' });
  });

  test('a crossed { send } sends nothing: another handle, no approve, a token under a rule, a nonce, another field changed, another kind or account, a fee the prompt didn\'t show; its token is discarded', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const crossings = [
      (a) => ({ send: { ...tokenSend(a).send, handle: 'f'.repeat(64) } }),
      (a) => ({ send: { ...tokenSend(a).send, standing: true } }),
      (a) => ({ send: { ...tokenSend(a).send, kind: 'wallet-send' } }),
      (a) => ({ send: { ...tokenSend(a).send, remember: true } }),
      (a) => tokenSend(a, 1),
      (a) => tokenSend(a, 0, { ...CORE_TX, nonce: '1' }),
      (a) => tokenSend(a, 0, { ...CORE_TX, to: SECOND }),
      (a) => tokenSend(a, 0, { ...CORE_TX, value: '1' }),
      (a) => tokenSend(a, 0, { ...CORE_TX, data: '0x095ea7b3' }),
      (a) => tokenSend(a, 0, { ...CORE_TX, chain_id: '1' }),
      (a) => tokenSend(a, 0, { ...CORE_TX, gas_limit: '30000' }),
      (a) => tokenSend(a, 0, { ...CORE_TX, gas_price: '2000000000' }),
      (a) => tokenSend(a, 0, { ...CORE_TX, type: 2 }),
    ];
    for (const cross of crossings) {
      sending(env, sendAsk, cross);
      expect((await approveSend(env, page)).answer).toEqual({ error: SEND_MISMATCH });
    }
    // A token with no approve of main's, and a rule's send after one.
    env.core.script = async () => ({ send: { kind: 'dapp-send', account: 0, tx: CORE_TX, handle: 'f'.repeat(64), token: TOKEN } });
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ error: SEND_MISMATCH });
    sending(env, sendAsk, () => ({ send: { kind: 'dapp-send', account: 0, tx: CORE_TX, standing: true } }));
    expect((await approveSend(env, page)).answer).toEqual({ error: SEND_MISMATCH });
    // A send for another request's transaction.
    sending(env, sendAsk, (a) => tokenSend(a));
    expect((await approveSend(env, page, {}, [{ ...CALL, value: '0x1' }])).answer).toEqual({ error: SEND_MISMATCH });
    expect(paid.signed).toEqual([]);
    expect(paid.turns).toEqual([]);
    expect(env.state.discarded).toEqual(Array(15).fill(TOKEN));
  });

  test('a fee asked again: the core\'s new prompt shows feeAskAgain, its approve confirms the fee, and only that approve\'s handle sends', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const answers = [];
    env.core.script = async ({ id, page: pc }) => {
      answers.push(await env.relay.approvalRequest(sendAsk(id, pc), { generation: GENERATION }));
      const again = await env.relay.approvalRequest(sendAsk(id, pc, { prompt: OTHER_PROMPT, again: true, above: true }), {
        generation: GENERATION,
      });
      answers.push(again);
      return tokenSend(again);
    };
    const asked = page.ask('eth_sendTransaction', [CALL]);
    await flush();
    const [first] = env.prompts();
    // Its decision is answered with the request, once the second is decided.
    const firstDecided = env.decide(first.handle, true, {});
    await flush();
    const second = env.prompts().at(-1);
    expect(second.handle).not.toBe(first.handle);
    expect(second.view).toMatchObject({ feeAskAgain: true, feeCheck: { above: true } });
    // A pick the core doesn't offer is refused, with the prompt still open.
    expect(await env.decide(second.handle, true, { feeAcknowledged: 'yes' })).toMatchObject({ ok: false });
    expect(await env.decide(second.handle, true, { feeAcknowledged: true })).toEqual({ ok: true });
    expect(await firstDecided).toEqual({ ok: true });
    expect(await asked).toEqual({ result: SEND_HASH });
    expect(answers.map((a) => [a.prompt, a.handle, a.choices])).toEqual([
      [PROMPT, first.handle, { alwaysAllow: false, feeAcknowledged: false }],
      [OTHER_PROMPT, second.handle, { alwaysAllow: false, feeAcknowledged: true }],
    ]);
    expect(paid.signed).toHaveLength(1);
    // The first approve's handle no longer sends.
    env.core.script = async ({ id, page: pc }) => {
      const one = await env.relay.approvalRequest(sendAsk(id, pc), { generation: GENERATION });
      await env.relay.approvalRequest(sendAsk(id, pc, { prompt: OTHER_PROMPT, again: true, above: true }), { generation: GENERATION });
      return tokenSend(one);
    };
    const crossed = page.ask('eth_sendTransaction', [CALL]);
    await flush();
    const decided = env.decide(env.prompts().at(-1).handle, true, {});
    await flush();
    expect(await env.decide(env.prompts().at(-1).handle, true, { feeAcknowledged: true })).toEqual({ ok: true });
    expect(await crossed).toEqual({ error: SEND_MISMATCH });
    expect(await decided).toEqual({ ok: true });
    expect(paid.signed).toHaveLength(1);
  });

  test('a rule\'s send: no prompt; the turn without waiting; signed under { standing: { paused: false } } with the PageContext read live; the last use after the broadcast; a busy turn or a waiting payment is D12\'s refusal, custody agent_custody, a rule the core no longer allows the rule gone', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    env.core.script = async () => ({ send: { kind: 'dapp-send', account: 0, tx: CORE_TX, standing: true } });
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ result: SEND_HASH });
    expect(env.prompts()).toEqual([]);
    expect(paid.turns).toEqual([[KEY_A, false]]);
    expect(paid.signed[0].authorized).toEqual({ page: env.core.sent[0].context.page, standing: { paused: false } });
    expect(paid.signed[0].presented).toEqual({ ...CORE_TX, nonce: '7' });
    expect(env.state.touched).toEqual([[KEY_A, env.core.sent[0].context.page]]);
    const PAUSED = {
      code: -32603,
      message: 'Signing was not confirmed: auto-approve is paused while a payment this site requested is waiting',
    };
    paid.busy = true;
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ error: PAUSED });
    paid.busy = false;
    paid.waiting = true;
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ error: PAUSED });
    paid.waiting = false;
    env.state.custody = true;
    expect(await page.ask('eth_sendTransaction', [CALL])).toMatchObject({ error: { code: 4100, data: { reason: 'agent_custody' } } });
    env.state.custody = false;
    const { confirmationError } = require('../wallet/signing-confirmation');
    paid.refuse = confirmationError(Object.assign(new Error('rate'), { code: 'not_authorized', data: { reason: 'rate_limited' } }));
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({
      error: { code: -32603, message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules" },
    });
    paid.refuse = null;
    expect(paid.signed).toHaveLength(1);
    expect(env.state.touched).toHaveLength(1);
    // D12's pause goes to the core with the request: the core reads it.
    env.state.paused = true;
    await page.ask('eth_sendTransaction', [CALL]);
    expect(env.core.sent.at(-1).params.world.paused).toBe(true);
  });

  test('a device\'s send: a Ledger\'s spend presents the core\'s payload with the handle and PageContext, and its receipt is presented once the send is recorded; a phone\'s job gets the same; a Safe\'s safe-send is spent for its approval; a payload for another send is refused, nothing spent', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const deviceSend = (type, account) => (answer) => ({
      device: { type, kind: 'dapp-send', account, payload: { tx: CORE_TX }, handle: answer.handle, token: TOKEN },
    });
    env.state.grants.set('*', { walletIndex: LEDGER });
    sending(env, (id, pc) => sendAsk(id, pc, { account: LEDGER }), deviceSend('ledger', LEDGER));
    const ledger = await approveSend(env, page, { alwaysAllow: true });
    expect(ledger.answer).toEqual({ result: SEND_HASH });
    const pc = env.core.sent.at(-1).context.page;
    expect(paid.signed[0].index).toBe(LEDGER);
    expect(paid.signed[0].authorized.confirmation).toEqual({
      token: TOKEN,
      kind: 'dapp-send',
      account: LEDGER,
      payload: { tx: CORE_TX },
      handle: ledger.shown.handle,
      page: pc,
    });
    expect(paid.signed[0].presented).toEqual({ ...CORE_TX, nonce: '7' });
    expect(paid.remembered).toEqual([{ receipt: RECEIPT, page: pc }]);
    env.state.grants.set('*', { walletIndex: PHONE });
    sending(env, (id, pc0) => sendAsk(id, pc0, { account: PHONE }), deviceSend('remote', PHONE));
    const phone = await approveSend(env, page);
    expect(phone.answer).toEqual({ result: SEND_HASH });
    expect(paid.signed[1].authorized.confirmation).toMatchObject({ kind: 'dapp-send', account: PHONE, payload: { tx: CORE_TX }, handle: phone.shown.handle });
    // A Safe's: spent for the Safe approval (the stand-in stops at the start).
    env.state.grants.set('*', { walletIndex: SAFE });
    const safePayload = { safe: SAFE_ADDRESS, chain_id: '100', tx: { to: CALL.to, value: '0', data: CALL.data } };
    sending(env, (id, pc0) => sendAsk(id, pc0, { account: SAFE }), (answer) => ({
      device: { type: 'safe', kind: 'safe-send', account: SAFE, payload: safePayload, handle: answer.handle, token: TOKEN },
    }));
    const safe = await approveSend(env, page);
    expect(safe.answer).toEqual({ error: { code: -32603, message: 'The Safe stand-in stops here' } });
    expect(paid.safes).toEqual([
      { token: TOKEN, kind: 'safe-send', account: SAFE, payload: safePayload, handle: safe.shown.handle, page: env.core.sent.at(-1).context.page },
    ]);
    // Crossed: another send's payload, a signature's kind, a ticked Safe, another Safe.
    const crossed = [
      (a) => ({ device: { ...deviceSend('remote', PHONE)(a).device, payload: { tx: { ...CORE_TX, to: SECOND } } } }),
      (a) => ({ device: { ...deviceSend('remote', PHONE)(a).device, kind: 'sign-message' } }),
      (a) => ({ device: { ...deviceSend('remote', PHONE)(a).device, payload: { tx: CORE_TX, remember: true } } }),
      (a) => ({ device: { type: 'safe', kind: 'safe-send', account: SAFE, payload: { ...safePayload, safe: SECOND }, handle: a.handle, token: TOKEN } }),
      (a) => ({ device: { type: 'safe', kind: 'safe-send', account: SAFE, payload: { ...safePayload, chain_id: '1' }, handle: a.handle, token: TOKEN } }),
    ];
    env.state.grants.set('*', { walletIndex: PHONE });
    for (const cross of crossed) {
      sending(env, (id, pc0) => sendAsk(id, pc0, { account: PHONE }), cross);
      expect((await approveSend(env, page)).answer).toEqual({ error: DEVICE_MISMATCH });
    }
    expect(paid.signed).toHaveLength(2);
    expect(paid.safes).toHaveLength(1);
  });

  test('a name moved off its IPNS key: by the approve, the core hears closed and mints nothing; in the send\'s turn, or during the signature, nothing is recorded or sent', async () => {
    const { env, paid } = sendSetup();
    env.names.set(NAME, IPNS_KEY);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answers = sending(env, sendAsk, (answer) => tokenSend(answer));
    const asked = page.ask('eth_sendTransaction', [CALL]);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.decide(env.prompts().at(-1).handle, true, {})).toEqual({ ok: true });
    expect(await asked).toEqual({ error: NO_ADDRESS });
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, closed: 'cancelled' });
    // Moved after the approve, before the turn's check: nothing signed.
    env.names.set(NAME, IPNS_KEY);
    const page2 = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    sending(env, sendAsk, (answer) => {
      env.names.set(NAME, OTHER_IPNS_KEY);
      return tokenSend(answer);
    });
    expect((await approveSend(env, page2)).answer).toEqual({ error: NO_ADDRESS });
    expect(paid.signed).toEqual([]);
    // Moved during the signature: withdrawn before it is recorded.
    env.names.set(NAME, IPNS_KEY);
    const page3 = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    paid.during = async () => env.names.set(NAME, OTHER_IPNS_KEY);
    sending(env, sendAsk, (answer) => tokenSend(answer));
    expect((await approveSend(env, page3)).answer).toEqual({ error: NO_ADDRESS });
    expect(paid.signed).toHaveLength(1);
    expect(env.state.discarded).toEqual([TOKEN, TOKEN]);
  });

  test('with the approvals document on, a vault account\'s send asks for the unlock first; a cancel is the page\'s 4001 and the core hears closed; a rule\'s unlock (reason "send") goes to the core as it is', async () => {
    const { env } = sendSetup({ approvalsDocument: true });
    env.state.unlocked = false;
    const page = env.tab();
    const answers = sending(env, sendAsk, (answer) => tokenSend(answer));
    const asked = page.ask('eth_sendTransaction', [CALL]);
    await flush();
    const unlock = env.prompts().at(-1);
    expect(unlock).toMatchObject({ kind: 'vault.unlock', view: { account: accountOf(0), reason: 'send' } });
    expect(await env.decide(unlock.handle, false, {})).toEqual({ ok: true });
    expect(await asked).toEqual({ error: { code: 4001, message: 'User cancelled unlock' } });
    expect(answers).toEqual([{ prompt: PROMPT, closed: 'cancelled' }]);
    const ruleAnswers = sending(env, (id, pc) => ({ ...unlockAsk(id, pc), view: { account: accountOf(0), reason: 'send' } }), () => ({
      send: { kind: 'dapp-send', account: 0, tx: CORE_TX, standing: true },
    }));
    const ruled = page.ask('eth_sendTransaction', [CALL]);
    await flush();
    const shown = env.prompts().at(-1);
    expect(shown).toMatchObject({ kind: 'vault.unlock', view: { reason: 'send' } });
    expect(await env.decide(shown.handle, true, { password: 'right password' })).toEqual({ ok: true });
    expect(await ruled).toEqual({ result: SEND_HASH });
    expect(ruleAnswers).toEqual([{ prompt: PROMPT, handle: shown.handle, approve: true, choices: {}, world: expect.objectContaining({ paused: false }) }]);
  });

  test('the core\'s send view is rebuilt to main\'s form, and a malformed one refused', () => {
    const { view, choices } = sendAsk(1, null);
    expect(sendShown(view, choices).view).toEqual(view);
    expect([...sendShown(view, choices).offered.alwaysAllow]).toEqual([false, true]);
    const bad = [
      [{ ...view, extra: 1 }, choices],
      [{ ...view, chain: { id: 100, name: 'Gnosis Chain' } }, choices],
      [{ ...view, tx: { ...view.tx, nonce: '1' } }, choices],
      [{ ...view, fee: { gasLimit: 21000 } }, choices],
      [{ ...view, feeCheck: { nested: {} } }, choices],
      [{ ...view, feeAskAgain: 'no' }, choices],
      [view, { alwaysAllow: [true], feeAcknowledged: [false, true] }],
      [view, { alwaysAllow: [false, true] }],
      [view, { ...choices, other: [false] }],
    ];
    for (const [v, c] of bad) expect(() => sendShown(v, c)).toThrow();
  });

  // Round 1 of #1283's review, and main's checks in 0012's APR-5f bullet.
  const NOT_CONNECTED = { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' };
  const RULE_GONE = {
    code: -32603,
    message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules",
  };
  const ACCOUNT_GONE = { code: -32603, message: 'The connected account is no longer available' };
  const ruleSend = () => ({ send: { kind: 'dapp-send', account: 0, tx: CORE_TX, standing: true } });
  const deviceSendOf = (type, account) => (answer) => ({
    device: { type, kind: 'dapp-send', account, payload: { tx: CORE_TX }, handle: answer.handle, token: TOKEN },
  });

  test('a grant revoked or moved after the approve, as the core returns { send }, or during the signature: nothing is signed, or nothing signed is recorded or sent; a rule\'s send likewise', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const grantChanges = [() => env.state.grants.delete('*'), () => env.state.grants.set('*', { walletIndex: 1 })];
    for (const change of grantChanges) {
      env.state.grants.set('*', { walletIndex: 0 });
      sending(env, sendAsk, (answer) => {
        change();
        return tokenSend(answer);
      });
      expect((await approveSend(env, page)).answer).toEqual({ error: NOT_CONNECTED });
    }
    expect(paid.turns).toEqual([
      [KEY_A, true],
      [KEY_A, true],
    ]);
    expect(paid.signed).toEqual([]);
    // Revoked while the core signed: withdrawn before the journal.
    env.state.grants.set('*', { walletIndex: 0 });
    paid.during = async () => env.state.grants.delete('*');
    sending(env, sendAsk, (answer) => tokenSend(answer));
    expect((await approveSend(env, page)).answer).toEqual({ error: NOT_CONNECTED });
    expect(paid.signed).toHaveLength(1);
    expect(paid.committed).toEqual([]);
    expect(env.state.discarded).toEqual([TOKEN, TOKEN, TOKEN]);
    // A rule's send: its grant gone as the core answers, or while it signs.
    paid.during = null;
    for (const change of grantChanges) {
      env.state.grants.set('*', { walletIndex: 0 });
      env.core.script = async () => {
        change();
        return ruleSend();
      };
      expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ error: RULE_GONE });
    }
    expect(paid.signed).toHaveLength(1);
    env.state.grants.set('*', { walletIndex: 0 });
    env.core.script = async () => ruleSend();
    paid.during = async () => env.state.grants.delete('*');
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ error: RULE_GONE });
    expect(paid.signed).toHaveLength(2);
    expect(paid.committed).toEqual([]);
    expect(env.state.touched).toEqual([]);
  });

  test('a Ledger\'s send with "Always allow": one not recorded, or one that fails after the device signed, presents no receipt and writes no rule; a recorded one presents it', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    env.state.grants.set('*', { walletIndex: LEDGER });
    sending(env, (id, pc) => sendAsk(id, pc, { account: LEDGER }), deviceSendOf('ledger', LEDGER));
    paid.recorded = false;
    expect((await approveSend(env, page, { alwaysAllow: true })).answer).toEqual({ result: SEND_HASH });
    expect(paid.committed).toHaveLength(1);
    expect(paid.remembered).toEqual([]);
    paid.recorded = true;
    paid.failAfterSign = new Error('The broadcast failed');
    expect((await approveSend(env, page, { alwaysAllow: true })).answer).toEqual({
      error: { code: -32603, message: 'The broadcast failed' },
    });
    expect(paid.signed).toHaveLength(2);
    expect(paid.committed).toHaveLength(1);
    expect(paid.remembered).toEqual([]);
    paid.failAfterSign = null;
    expect((await approveSend(env, page, { alwaysAllow: true })).answer).toEqual({ result: SEND_HASH });
    expect(paid.remembered).toEqual([{ receipt: RECEIPT, page: env.core.sent.at(-1).context.page }]);
    expect(env.state.discarded).toEqual([TOKEN, TOKEN, TOKEN]);
  });

  test('a device\'s send answered for another type than main\'s wallet record (a Ledger\'s as a phone\'s, a phone\'s as a Ledger\'s, the vault\'s as a Ledger\'s): no turn, no spend, no device, its token discarded', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    const crossed = [
      [LEDGER, 'remote'],
      [PHONE, 'ledger'],
      [0, 'ledger'],
    ];
    for (const [account, type] of crossed) {
      env.state.grants.set('*', { walletIndex: account });
      sending(env, (id, pc) => sendAsk(id, pc, { account }), deviceSendOf(type, account));
      expect((await approveSend(env, page)).answer).toEqual({ error: ACCOUNT_GONE });
    }
    expect(paid.turns).toEqual([]);
    expect(paid.signed).toEqual([]);
    expect(env.state.discarded).toEqual([TOKEN, TOKEN, TOKEN]);
  });

  test('a rule\'s send reads the site\'s rule again (approval.check under the PageContext read live, not paused) just before the signature and after it: one the core no longer answers sends nothing; after the signature, the rate its own slot spent and its fee stand', async () => {
    const { env, paid } = sendSetup();
    const page = env.tab();
    env.core.script = async () => ruleSend();
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ result: SEND_HASH });
    const request = {
      kind: 'transaction',
      account: 0,
      accountType: 'mnemonic',
      payload: { to: CALL.to, value: '0', data: CALL.data, chainId: 100, gasLimit: '21000', gasPrice: '1000000000' },
      paused: false,
    };
    const checked = { page: env.core.sent.at(-1).context.page, request };
    expect(paid.checks).toEqual([checked, checked]);
    expect(paid.committed).toHaveLength(1);
    // Before the signature: no rule, the rate spent, a failed check, custody.
    const before = [
      [{ covered: false, reason: 'no_rule' }, { error: RULE_GONE }],
      [{ covered: false, reason: 'rate_limited' }, { error: RULE_GONE }],
      [{ covered: false, reason: 'fee_check' }, { error: RULE_GONE }],
      [
        () => {
          throw new Error('The core is gone');
        },
        { error: RULE_GONE },
      ],
      [{ covered: false, reason: 'custody' }, { error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'agent_custody' } } }],
    ];
    for (const [rule, answer] of before) {
      paid.rule = rule;
      expect(await page.ask('eth_sendTransaction', [CALL])).toEqual(answer);
    }
    expect(paid.signed).toHaveLength(1);
    // After it: a rule revoked or the grant's account gone while the core
    // signed is withdrawn before the journal; the rate and the fee stand.
    paid.rule = null;
    for (const reason of ['no_rule', 'not_exposed', 'warning']) {
      paid.during = async () => {
        paid.rule = { covered: false, reason };
      };
      expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ error: RULE_GONE });
      paid.rule = null;
    }
    expect(paid.signed).toHaveLength(4);
    expect(paid.committed).toHaveLength(1);
    expect(env.state.touched).toHaveLength(1);
    for (const reason of ['rate_limited', 'fee_check']) {
      paid.during = async () => {
        paid.rule = { covered: false, reason };
      };
      expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ result: SEND_HASH });
      paid.rule = null;
    }
    expect(paid.committed).toHaveLength(3);
    expect(env.state.touched).toHaveLength(3);
  });

  test('a name moved off its IPNS key after the broadcast: the hash is the page\'s, with no last use for a rule\'s send and no receipt for a Ledger\'s', async () => {
    const { env, paid } = sendSetup();
    env.names.set(NAME, IPNS_KEY);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    env.core.script = async () => ruleSend();
    paid.afterCommit = async () => env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await page.ask('eth_sendTransaction', [CALL])).toEqual({ result: SEND_HASH });
    expect(paid.committed).toHaveLength(1);
    expect(env.state.touched).toEqual([]);
    env.names.set(NAME, IPNS_KEY);
    const ledgerPage = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    env.state.grants.set('*', { walletIndex: LEDGER });
    sending(env, (id, pc) => sendAsk(id, pc, { account: LEDGER }), deviceSendOf('ledger', LEDGER));
    expect((await approveSend(env, ledgerPage, { alwaysAllow: true })).answer).toEqual({ result: SEND_HASH });
    expect(paid.committed).toHaveLength(2);
    expect(paid.remembered).toEqual([]);
  });

  // Round 1 of #1284's review: the payment facts main records for a send
  // the core decided, and a Safe's SafeTx past its start (its board, its
  // outcome, and the site's guard on its execution), which only the deleted
  // route's tests (page-sends.test.js) covered.
  describe("the payment facts main records, and a Safe's SafeTx after its start", () => {
    const SAFE_TX_HASH = `0x${'ef'.repeat(32)}`;
    const EXEC_HASH = `0x${'12'.repeat(32)}`;
    const GONE = { gone: true };
    const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
    // An ERC-20 transfer, on CALL's (checksummed) token, of more than 2^53
    // units to a mixed-case recipient.
    const RECIPIENT = 'aBcDeF0123456789aBcDeF0123456789aBcDeF01';
    const AMOUNT = 10n ** 24n + 7n;
    const TRANSFER = {
      to: CALL.to,
      value: '0x0',
      data: `0xa9059cbb${'0'.repeat(24)}${RECIPIENT}${AMOUNT.toString(16).padStart(64, '0')}`,
    };
    // A plain payment of 0.01 xDAI.
    const PAYMENT = { to: SECOND, value: '0x2386f26fc10000', data: '0x' };
    // A request's transaction as main checked it (`txOf`).
    const checkedTx = (request) => ({ to: request.to, value: BigInt(request.value).toString(), data: request.data });
    // The core's eth.send prompt for `request`.
    const askFor = (request, options = {}) => (id, pc) => {
      const ask = sendAsk(id, pc, options);
      ask.view.tx = checkedTx(request);
      return ask;
    };
    // The core's `{ device }` for a Safe's send of `request`, with its token.
    const safeDevice = (answer, request, token = TOKEN) => ({
      device: {
        type: 'safe',
        kind: 'safe-send',
        account: SAFE,
        payload: { safe: SAFE_ADDRESS, chain_id: '100', tx: checkedTx(request) },
        handle: answer.handle,
        token,
      },
    });
    const PENDING_EXISTS = 'A transaction is already waiting for signatures — finish or discard it first';

    /**
     * Main's Safe steps, stood in as safe-transactions.js runs them: the
     * Safe's reservation (refused while a SafeTx is pending, `pendingExists`,
     * or another send holds it), the SafeTx's start (only under that
     * reservation, still held after `startHold`), its outcomes (`settle`),
     * the site's guard on its execution, and an execution (`execute`): past
     * the request's guard, then the executor's waits (its quote, the site's
     * turn, its signer: `duringWait` runs among them), and the same guard
     * again at the commit. Not for the site at all when it has no guard.
     */
    function safeSetup() {
      const paid = payments();
      const safe = {
        started: [],
        listeners: new Set(),
        guards: new Map(),
        reserved: new Set(),
        pendingExists: false,
        startHold: null,
      };
      Object.assign(paid.deps, {
        reserveSafeSend: (safeIndex) => {
          if (safe.pendingExists || safe.reserved.has(safeIndex)) {
            throw Object.assign(new Error(PENDING_EXISTS), { code: 'SAFE_PENDING_EXISTS' });
          }
          safe.reserved.add(safeIndex);
          return { safeIndex, release: () => safe.reserved.delete(safeIndex) };
        },
        startSafeSend: async ({ reservation, ...options }) => {
          if (safe.startHold) await safe.startHold;
          if (reservation?.safeIndex !== options.safeIndex || !safe.reserved.has(options.safeIndex)) {
            throw new Error('Started without its reservation');
          }
          safe.started.push(options);
          return { safeIndex: options.safeIndex, safeTxHash: SAFE_TX_HASH, threshold: 2, collected: 1, status: 'awaiting' };
        },
        onSafeSendSettled: (listener) => {
          safe.listeners.add(listener);
          return () => safe.listeners.delete(listener);
        },
        guardSiteSafeSend: (safeTxHash, guard) => {
          safe.guards.set(safeTxHash, guard);
          return () => {
            if (safe.guards.get(safeTxHash) === guard) safe.guards.delete(safeTxHash);
          };
        },
        siteWithdrawn: () => Object.assign(new Error('withdrawn'), { code: 'SAFE_SITE_WITHDRAWN' }),
        safeBoards: () => null,
      });
      safe.settle = (event) => {
        for (const listener of [...safe.listeners]) listener(event);
      };
      safe.execute = async ({ hash = EXEC_HASH, duringWait = null } = {}) => {
        const guard = safe.guards.get(SAFE_TX_HASH);
        if (!guard) return { executed: false, guarded: false };
        let executed = false;
        try {
          await guard(async () => {
            await new Promise((resolve) => setImmediate(resolve));
            duringWait?.();
            return guard(async () => {
              executed = true;
              safe.settle({ safeIndex: SAFE, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash });
              return { hash };
            });
          });
        } catch (err) {
          return { executed, refused: err.code };
        }
        return { executed };
      };
      const env = setup({ coreSendDeps: paid.deps });
      env.state.wallets = DEVICE_WALLETS;
      env.state.grants.set('*', { walletIndex: SAFE });
      return { env, paid, safe };
    }

    // The page's send of `request` from the Safe, approved. Resolves once
    // its SafeTx has started and its board shows, with the page's answer
    // and the approve's page:decide still pending.
    async function safeStart(env, page, request = CALL) {
      sending(env, askFor(request, { account: SAFE }), (answer) => safeDevice(answer, request));
      const answer = page.ask('eth_sendTransaction', [request]);
      await flush();
      const decided = env.decide(env.prompts().at(-1).handle, true, {});
      await flush();
      await flush();
      const board = env.prompts().at(-1);
      expect(board.kind).toBe('eth.safe_send');
      return { answer, decided, board };
    }
    const pending = async (promise) => {
      let settled = false;
      promise.then(() => {
        settled = true;
      });
      await flush();
      return !settled;
    };

    test('an ERC-20 transfer the core sends is recorded as one, an approved send\'s and a rule\'s: the token, the recipient and the amount in the payment history; a contract call records only the site', async () => {
      const { env, paid } = sendSetup();
      const page = env.tab();
      const tx = { ...CORE_TX, data: TRANSFER.data };
      sending(env, askFor(TRANSFER), (answer) => tokenSend(answer, 0, tx));
      expect((await approveSend(env, page, {}, [TRANSFER])).answer).toEqual({ result: SEND_HASH });
      env.core.script = async () => ({ send: { kind: 'dapp-send', account: 0, tx, standing: true } });
      expect(await page.ask('eth_sendTransaction', [TRANSFER])).toEqual({ result: SEND_HASH });
      sending(env, sendAsk, (answer) => tokenSend(answer));
      expect((await approveSend(env, page)).answer).toEqual({ result: SEND_HASH });
      const transfer = {
        kind: 'dapp-send',
        origin: KEY_A,
        asset: CALL.to.toLowerCase(),
        toAddress: `0x${RECIPIENT.toLowerCase()}`,
        amount: AMOUNT.toString(),
        metadata: { erc20Method: 'transfer' },
      };
      expect(paid.signed.map((signed) => signed.context)).toEqual([transfer, transfer, { kind: 'dapp-send', origin: KEY_A }]);
      expect(paid.committed).toHaveLength(3);
    });

    test('a Safe\'s SafeTx starts for the requester\'s key, from the Safe approval its token gave, with the board\'s display of a contract call, an ERC-20 transfer and a plain payment; a discarded one answers 4001', async () => {
      const { env, paid, safe } = safeSetup();
      const page = env.tab();
      const cases = [
        [CALL, { site: KEY_A, asset: null, toAddress: CALL.to, amount: '0', label: 'a contract call to 0x8335…2913' }],
        [
          TRANSFER,
          {
            site: KEY_A,
            asset: CALL.to.toLowerCase(),
            toAddress: `0x${RECIPIENT.toLowerCase()}`,
            amount: AMOUNT.toString(),
            label: 'sending tokens to 0xabcd…ef01',
          },
        ],
        [PAYMENT, { site: KEY_A, asset: null, toAddress: SECOND, amount: '10000000000000000' }],
      ];
      for (const [request, display] of cases) {
        const { answer, board } = await safeStart(env, page, request);
        const pc = env.core.sent.at(-1).context.page;
        expect(paid.safes.at(-1)).toMatchObject({ token: TOKEN, kind: 'safe-send', account: SAFE, page: pc });
        expect(safe.started.at(-1)).toEqual({
          safeIndex: SAFE,
          tx: checkedTx(request),
          display,
          chainId: 100,
          approval: { id: 'f'.repeat(32), page: pc },
        });
        expect(Object.keys(safe.started.at(-1).display)).toEqual(Object.keys(display));
        expect(board.view).toMatchObject({ safeIndex: SAFE, state: { safeTxHash: SAFE_TX_HASH } });
        expect(safe.reserved.size).toBe(0);
        safe.settle({ safeIndex: SAFE, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
        expect(await answer).toEqual(REJECTED);
      }
      expect(safe.started).toHaveLength(3);
      expect(safe.guards.size).toBe(0);
      expect(safe.listeners.size).toBe(0);
    });

    test('another SafeTx\'s outcome, or another Safe\'s, is not this one\'s; executed past the site\'s guard, the page gets the execution\'s hash, and the guard, the listener and the board end with the request', async () => {
      const { env, safe } = safeSetup();
      const page = env.tab();
      const { answer, decided, board } = await safeStart(env, page);
      safe.settle({ safeIndex: SAFE, safeTxHash: `0x${'99'.repeat(32)}`, outcome: 'executed', hash: '0xother' });
      safe.settle({ safeIndex: SAFE + 1, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash: '0xother' });
      expect(await pending(answer)).toBe(true);
      expect(await safe.execute()).toEqual({ executed: true });
      expect(await answer).toEqual({ result: EXEC_HASH });
      expect(await decided).toEqual({ ok: true });
      expect(safe.guards.size).toBe(0);
      expect(safe.listeners.size).toBe(0);
      expect(env.closed().map((c) => c.handle)).toContain(board.handle);
    });

    test('a board the user leaves parks the SafeTx: the page waits without its document\'s wallet slot, so the document may ask again; executed later, the page gets the hash', async () => {
      const { env, safe } = safeSetup();
      const page = env.tab();
      const { answer, decided, board } = await safeStart(env, page);
      const left = env.decide(board.handle, false);
      expect(await pending(answer)).toBe(true);
      asking(env, (id, pc) => signAsk(id, pc, { account: SAFE }), () => ({ result: '0x5afe' }));
      const signed = page.ask('personal_sign', [MESSAGE, SAFE_ADDRESS]);
      await flush();
      expect(env.prompts().at(-1).kind).toBe('eth.sign');
      expect(await env.decide(env.prompts().at(-1).handle, false)).toEqual({ ok: true });
      expect(await signed).toEqual(REJECTED);
      expect(await safe.execute()).toEqual({ executed: true });
      expect(await answer).toEqual({ result: EXEC_HASH });
      expect(await left).toEqual({ ok: true });
      expect(await decided).toEqual({ ok: true });
    });

    test('a document that navigates while its SafeTx waits: the request goes, and with it the guard, so a later execution isn\'t for the site', async () => {
      const { env, safe } = safeSetup();
      const page = env.tab();
      const { answer } = await safeStart(env, page);
      page.guest.commit(`${KEY_A}/next`);
      expect(await answer).toEqual(GONE);
      await flush();
      expect(safe.listeners.size).toBe(0);
      expect(safe.guards.size).toBe(0);
      expect(await safe.execute()).toEqual({ executed: false, guarded: false });
    });

    test('parked, and its name moves before it executes: not executed for the site, and the keyless answer', async () => {
      const { env, safe } = safeSetup();
      env.names.set(NAME, IPNS_KEY);
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      const { answer, board } = await safeStart(env, page);
      env.decide(board.handle, false);
      await flush();
      env.names.set(NAME, OTHER_IPNS_KEY);
      expect(await safe.execute()).toEqual({ executed: false, refused: 'SAFE_SITE_WITHDRAWN' });
      expect(await answer).toEqual({ error: NO_ADDRESS });
      expect(safe.guards.size).toBe(0);
    });

    test('parked, and its grant revoked or moved to another account before it executes: not executed for the site, and the keyless answer', async () => {
      const { env, safe } = safeSetup();
      const page = env.tab();
      for (const change of [() => env.state.grants.delete('*'), () => env.state.grants.set('*', { walletIndex: 0 })]) {
        env.state.grants.set('*', { walletIndex: SAFE });
        const { answer, board } = await safeStart(env, page);
        env.decide(board.handle, false);
        await flush();
        change();
        expect(await safe.execute()).toEqual({ executed: false, refused: 'SAFE_SITE_WITHDRAWN' });
        expect(await answer).toEqual({ error: NO_ADDRESS });
        expect(safe.guards.size).toBe(0);
      }
    });

    test('its name moves during the execution\'s waits (the quote, the signer): refused at the commit, nothing executed for the site', async () => {
      const { env, safe } = safeSetup();
      env.names.set(NAME, IPNS_KEY);
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      const { answer } = await safeStart(env, page);
      expect(await safe.execute({ duringWait: () => env.names.set(NAME, OTHER_IPNS_KEY) })).toEqual({
        executed: false,
        refused: 'SAFE_SITE_WITHDRAWN',
      });
      expect(await answer).toEqual({ error: NO_ADDRESS });
    });

    test('a name or grant that moves as the core answers starts no SafeTx and spends nothing; an honest name, parked, executes later; one that moves after its execution still hears its hash', async () => {
      const { env, paid, safe } = safeSetup();
      const named = () => {
        env.names.set(NAME, IPNS_KEY);
        return env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      };
      const moves = [
        [() => env.names.set(NAME, OTHER_IPNS_KEY), NO_ADDRESS],
        [() => env.state.grants.delete('*'), NOT_CONNECTED],
      ];
      for (const [move, refusal] of moves) {
        const page = named();
        env.state.grants.set('*', { walletIndex: SAFE });
        sending(env, askFor(CALL, { account: SAFE }), (answer) => {
          move();
          return safeDevice(answer, CALL);
        });
        expect((await approveSend(env, page)).answer).toEqual({ error: refusal });
      }
      expect(paid.safes).toEqual([]);
      expect(safe.started).toEqual([]);
      expect(env.state.discarded).toEqual([TOKEN, TOKEN]);
      env.state.grants.set('*', { walletIndex: SAFE });
      const honest = named();
      const parked = await safeStart(env, honest);
      env.decide(parked.board.handle, false);
      await flush();
      expect(await safe.execute()).toEqual({ executed: true });
      expect(await parked.answer).toEqual({ result: EXEC_HASH });
      // Executed past the guard, and the name moves before main hears of it.
      const late = await safeStart(env, honest);
      await safe.guards.get(SAFE_TX_HASH)(async () => {
        env.names.set(NAME, OTHER_IPNS_KEY);
        safe.settle({ safeIndex: SAFE, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash: EXEC_HASH });
      });
      expect(await late.answer).toEqual({ result: EXEC_HASH });
    });

    // 0012 APB-1c, and #1245's review: one pending SafeTx per Safe, reserved
    // before the token is spent, since the core's new Safe approval ends the
    // pending one's. A second send is refused before it spends anything.
    test('a Safe with a SafeTx pending, or another send holding its reservation while its SafeTx starts: a second send is refused before its token is spent, discarded unspent, and starts no SafeTx; the first starts with its own approval', async () => {
      const { env, paid, safe } = safeSetup();
      const SECOND_TOKEN = 'c'.repeat(64);
      const PENDING = { error: { code: -32603, message: PENDING_EXISTS } };
      const spent = () => paid.safes.map((confirmation) => confirmation.token);
      // A SafeTx already pending for the Safe.
      safe.pendingExists = true;
      sending(env, askFor(CALL, { account: SAFE }), (answer) => safeDevice(answer, CALL, SECOND_TOKEN));
      expect((await approveSend(env, env.tab())).answer).toEqual(PENDING);
      expect(spent()).toEqual([]);
      expect(safe.started).toEqual([]);
      expect(env.state.discarded).toEqual([SECOND_TOKEN]);
      safe.pendingExists = false;
      // The first send holds the reservation while its SafeTx starts.
      let start;
      safe.startHold = new Promise((resolve) => (start = resolve));
      sending(env, askFor(CALL, { account: SAFE }), (answer) => safeDevice(answer, CALL));
      const first = env.tab().ask('eth_sendTransaction', [CALL]);
      await flush();
      env.decide(env.prompts().at(-1).handle, true, {});
      await flush();
      expect(safe.reserved.has(SAFE)).toBe(true);
      expect(spent()).toEqual([TOKEN]);
      sending(env, askFor(CALL, { account: SAFE }), (answer) => safeDevice(answer, CALL, SECOND_TOKEN));
      expect((await approveSend(env, env.tab())).answer).toEqual(PENDING);
      expect(spent()).toEqual([TOKEN]);
      expect(safe.started).toEqual([]);
      expect(env.state.discarded).toEqual([SECOND_TOKEN, SECOND_TOKEN]);
      expect(safe.reserved.has(SAFE)).toBe(true);
      start();
      await flush();
      expect(safe.started).toHaveLength(1);
      expect(safe.started[0].approval).toEqual({ id: 'f'.repeat(32), page: paid.safes[0].page });
      expect(safe.reserved.size).toBe(0);
      expect(env.state.discarded).toEqual([SECOND_TOKEN, SECOND_TOKEN, TOKEN]);
      safe.settle({ safeIndex: SAFE, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
      expect(await first).toEqual(REJECTED);
    });

    // The guard's `live()` checks: the request answered, its signal aborted,
    // while its document still holds its key and its grant. Main answers it
    // here by the SafeTx's outcome, heard first.
    test('an execution whose guard waits on the name while the request is answered: the name comes back still holding, and the execution is refused, never entered', async () => {
      const { env, safe } = safeSetup();
      env.names.set(NAME, IPNS_KEY);
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      const { answer } = await safeStart(env, page);
      const guard = safe.guards.get(SAFE_TX_HASH);
      let resolveName;
      env.state.nameHold = new Promise((resolve) => (resolveName = resolve));
      const resolved = env.state.resolutions.length;
      let entered = false;
      let outcome = null;
      guard(async () => {
        entered = true;
        return { hash: EXEC_HASH };
      }).then(
        () => (outcome = 'executed'),
        (err) => (outcome = err.code)
      );
      await flush();
      // The guard waits on the name.
      expect(env.state.resolutions.slice(resolved)).toEqual([NAME]);
      expect(outcome).toBe(null);
      safe.settle({ safeIndex: SAFE, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
      expect(await answer).toEqual(REJECTED);
      expect(safe.guards.size).toBe(0);
      env.state.nameHold = null;
      resolveName();
      await flush();
      expect(outcome).toBe('SAFE_SITE_WITHDRAWN');
      expect(entered).toBe(false);
    });

    test('the request answered during the execution\'s waits (the quote, the signer): the guard the executor kept refuses at the commit at once, resolving no name, and nothing executes for the site', async () => {
      const { env, safe } = safeSetup();
      env.names.set(NAME, IPNS_KEY);
      const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
      const { answer } = await safeStart(env, page);
      // The executor reads the guard once, at its start, and runs it again
      // at its commit (`guardCommit`).
      const guard = safe.guards.get(SAFE_TX_HASH);
      let commit;
      const waits = new Promise((resolve) => (commit = resolve));
      let executed = false;
      let outcome = null;
      guard(async () => {
        await waits;
        return guard(async () => {
          executed = true;
          return { hash: EXEC_HASH };
        });
      }).then(
        () => (outcome = 'executed'),
        (err) => (outcome = err.code)
      );
      await flush();
      safe.settle({ safeIndex: SAFE, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
      expect(await answer).toEqual(REJECTED);
      // A name resolution from here on would wait.
      let resolveName;
      env.state.nameHold = new Promise((resolve) => (resolveName = resolve));
      const resolved = env.state.resolutions.length;
      commit();
      await flush();
      expect(outcome).toBe('SAFE_SITE_WITHDRAWN');
      expect(executed).toBe(false);
      expect(env.state.resolutions).toHaveLength(resolved);
      env.state.nameHold = null;
      resolveName();
    });
  });
});

// ---- APB-4e: `transport_key` for a DNS name over IPNS (cored 0.21.0) ----

describe('transport_key for a DNS name over IPNS (0012 APR-5f, APB-4e)', () => {
  const TRANSPORT = `ipns://${IPNS_KEY}`;
  const NAME_CHECKED = [
    ['eth_accounts', [], { result: [] }],
    ['eth_requestAccounts', [], { error: NO_ADDRESS }],
    ['personal_sign', [MESSAGE, ACCOUNT], { error: NO_ADDRESS }],
    ['eth_signTypedData_v4', [ACCOUNT, TYPED], { error: NO_ADDRESS }],
    ['wallet_switchEthereumChain', [{ chainId: '0x1' }], { error: NO_ADDRESS }],
    ['eth_sendTransaction', [{ to: ACCOUNT, value: '0x1' }], { error: NO_ADDRESS }],
  ];

  async function bound(env) {
    env.names.set(NAME, IPNS_KEY);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    await flush();
    return page;
  }

  test('sent only for a bound document: not for another key, a keyless document, or an IPNS key whose name check failed at its commit', async () => {
    const env = setup();
    env.core.script = async () => ({ result: [] });
    const named = await bound(env);
    const keyed = env.tab();
    const keyless = env.tab('data:text/html,<h1>keyless</h1>');
    env.names.set('unbound.example', OTHER_IPNS_KEY);
    const unverified = env.tab(`ipns://${IPNS_KEY}/x`, { bind: 'unbound.example' });
    await flush();
    for (const page of [named, keyed, keyless, unverified]) await page.ask('eth_accounts', []);
    expect(env.core.sent.map(({ context }) => context.page)).toEqual([
      { origin: NAME, top_origin: NAME, frame: expect.any(Number), navigation: expect.any(Number), agent: false, transport_key: TRANSPORT },
      { origin: KEY_A, top_origin: KEY_A, frame: expect.any(Number), navigation: expect.any(Number), agent: false },
      { origin: '', top_origin: '', frame: expect.any(Number), navigation: expect.any(Number), agent: false },
      { origin: TRANSPORT, top_origin: TRANSPORT, frame: expect.any(Number), navigation: expect.any(Number), agent: false },
    ]);
    // The reads carry it too, and the core checks no name for them.
    await named.ask('eth_chainId', []);
    expect(env.core.sent.at(-1).context.page.transport_key).toBe(TRANSPORT);
  });

  test('the echo: the core\'s page with the transport key main sent is accepted; a missing, null or other one for a bound page, or one for a page sent none, is crossed', async () => {
    const env = setup();
    const named = await bound(env);
    const keyed = env.tab();
    const outcomes = [];
    const tryAll = (pages) => async ({ id }) => {
      for (const pc of pages) {
        await Promise.all([
          env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION }),
          env.relay.selectChain({ request: id, page: pc, chain_id: 1 }, { generation: GENERATION }),
          env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION }),
        ].map((p) => p.then(() => 'ok', (err) => err.code))).then((codes) => outcomes.push(codes));
      }
      return { result: [] };
    };
    // A bound page: the echo must carry the transport key exactly.
    env.core.script = async (args) => {
      const sent = args.page;
      const { transport_key: _dropped, ...without } = sent;
      return tryAll([
        { ...without },
        { ...sent, transport_key: null },
        { ...sent, transport_key: `ipns://${OTHER_IPNS_KEY}` },
        { ...sent, transport_key: NAME },
      ])(args);
    };
    await named.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }]);
    expect(outcomes.splice(0)).toEqual(Array(4).fill(['invalid_argument', 'invalid_argument', 'invalid_argument']));
    // A page sent none: an echoed transport key is crossed.
    env.core.script = async (args) => tryAll([{ ...args.page, transport_key: TRANSPORT }])(args);
    await keyed.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }]);
    expect(outcomes.splice(0)).toEqual([['invalid_argument', 'invalid_argument', 'invalid_argument']]);
    expect(env.state.selections).toEqual([]);
    expect(env.prompts()).toEqual([]);
    // The echo as sent, a copy: the recheck answers, and the switch selects.
    env.core.script = async ({ id, page: pc }) => {
      expect(pc.transport_key).toBe(TRANSPORT);
      outcomes.push(await env.relay.approvalRecheck({ request: id, page: { ...pc } }, { generation: GENERATION }));
      outcomes.push(await env.relay.selectChain({ request: id, page: { ...pc }, chain_id: 1 }, { generation: GENERATION }));
      return { result: null };
    };
    expect(await named.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(outcomes).toEqual([{ live: true, agent: false }, {}]);
    expect(env.state.selections).toEqual([[1, 1]]);
  });

  describe('the version gate: a bound document\'s name-checked requests go only to a core from 0.21.0', () => {
    test.each(NAME_CHECKED)('a 0.20.0 core: %s answers as a keyless document\'s, and nothing is sent', async (method, params, keyless) => {
      const env = setup();
      env.core.hello = { core_version: '0.20.0' };
      const page = await bound(env);
      expect(await page.ask(method, params)).toEqual(keyless);
      expect(env.core.sent).toEqual([]);
      expect(env.prompts()).toEqual([]);
    });

    test.each(NAME_CHECKED)('a 0.21.0 core: %s goes to the core with the binding', async (method, params) => {
      const env = setup();
      env.core.script = async () => ({ result: 'answered' });
      const page = await bound(env);
      await page.ask(method, params);
      expect(env.core.sent.map(({ params: body, context }) => [body.method, context.page.transport_key])).toEqual([
        [method, TRANSPORT],
      ]);
    });

    test('on an older core the reads still go, and so does everything with the switch off (the core answers 4900 before any name)', async () => {
      const env = setup();
      env.core.hello = { core_version: '0.20.0' };
      env.core.script = async ({ params }) => (params.method === 'eth_chainId' ? { result: '0x64' } : { error: { code: 4900, message: 'Disconnected' } });
      const page = await bound(env);
      expect(await page.ask('eth_chainId', [])).toEqual({ result: '0x64' });
      env.state.enabled = false;
      expect(await page.ask('eth_requestAccounts', [])).toEqual({ error: { code: 4900, message: 'Disconnected' } });
      expect(env.core.sent.map(({ params: body }) => body.method)).toEqual(['eth_chainId', 'eth_requestAccounts']);
      // An unbound document is never gated.
      env.state.enabled = true;
      env.core.script = async () => ({ result: [] });
      expect(await env.tab().ask('eth_accounts', [])).toEqual({ result: [] });
    });

    test.each([
      ['0.21.0', true],
      ['0.21.1', true],
      ['0.22.0-rc.1', true],
      ['1.0.0', true],
      ['0.21.0+build.7', true],
      ['0.21.0-rc.1', false],
      ['0.20.9', false],
      ['0.9.99', false],
      ['00.21.0', false],
      ['0.21', false],
      ['v0.21.0', false],
      ['dev', false],
    ])('core_version %s counts as checking names: %s', async (version, routed) => {
      const env = setup();
      env.core.hello = { core_version: version };
      env.core.script = async () => ({ result: ['sent'] });
      const page = await bound(env);
      expect(await page.ask('eth_accounts', [])).toEqual({ result: routed ? ['sent'] : [] });
      expect(env.core.sent).toHaveLength(routed ? 1 : 0);
    });

    test('the check is the client\'s, on the process it writes to: asked only for a bound document\'s name-checked requests, and only its refusal answers keyless', async () => {
      const env = setup();
      env.core.script = async () => ({ result: ['sent'] });
      const page = await bound(env);
      await page.ask('eth_accounts', []);
      await page.ask('eth_chainId', []);
      await env.tab().ask('eth_accounts', []);
      const asked = env.core.request.mock.calls.map(([, body, , options]) => [body.method, typeof options.requires]);
      expect(asked).toEqual([
        ['eth_accounts', 'function'],
        ['eth_chainId', 'object'],
        ['eth_accounts', 'object'],
      ]);
      // What it requires: a hello from 0.21.0 on; none, or no version, fails.
      const requires = env.core.request.mock.calls[0][3].requires;
      expect([{ core_version: '0.21.0' }, { core_version: '0.20.0' }, {}, null].map(requires)).toEqual([true, false, false, false]);
      // Any other failure of the client's is the core's failure, not a
      // keyless answer.
      env.core.request.mockImplementationOnce(async () => {
        throw new CoreError('core_unavailable', 'The identity core is not running');
      });
      expect(await page.ask('eth_accounts', [])).toEqual({
        error: { code: -32603, message: 'The identity core is not running' },
      });
    });
  });

  describe('a core that restarts while a bound document\'s request waits for it (r1)', () => {
    /**
     * A freedom-cored process for a real CoreClient: it answers the hello
     * as `version`, and each `eip1193.request` as a core that checks no
     * name would for a key with a grant: the account, or a signature.
     */
    class CoredProcess extends EventEmitter {
      constructor(version) {
        super();
        this.pid = 4242;
        this.stdout = new PassThrough();
        this.stderr = new PassThrough();
        this.requests = [];
        const decoder = new FrameDecoder();
        this.stdin = new Writable({
          write: (chunk, _encoding, callback) => {
            for (const frame of decoder.push(chunk)) {
              if (frame.kind !== KIND_JSON || frame.message?.type !== 'request') continue;
              const { id, method, params, context } = frame.message;
              this.requests.push({ method, params, context });
              let result = {};
              if (method === 'core.hello') result = { protocol: 2, core_version: version, capabilities: ['streams'] };
              else if (method === 'eip1193.request') result = { result: params.method === 'personal_sign' ? '0x5167' : [ACCOUNT] };
              this.stdout.write(encodeFrame({ type: 'response', id, result }));
            }
            callback();
          },
          final: (callback) => {
            setImmediate(() => this.exit(0));
            callback();
          },
        });
      }

      exit(code, { close = true } = {}) {
        this.emit('exit', code, null);
        if (close) setImmediate(() => this.close(code));
      }

      close(code) {
        this.stdout.end();
        this.emit('close', code, null);
      }

      kill() {
        setImmediate(() => this.exit(null));
        return true;
      }
    }

    // A real CoreClient whose processes answer the hello as `versions`, in
    // turn, and whose timers run only when the test runs them.
    function restartingCore(versions) {
      const children = [];
      const timers = [];
      const client = new CoreClient({
        spawn: jest.fn(() => {
          const child = new CoredProcess(versions[Math.min(children.length, versions.length - 1)]);
          children.push(child);
          return child;
        }),
        command: '/bin/freedom-cored',
        args: ['serve'],
        log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        grantRoot: os.tmpdir(),
        setTimer: (fn, ms) => {
          const timer = { fn, ms, cleared: false };
          timers.push(timer);
          return timer;
        },
        clearTimer: (timer) => {
          if (timer) timer.cleared = true;
        },
        now: () => 0,
      });
      const runTimers = (ms) => {
        for (const timer of timers.splice(0)) {
          if (!timer.cleared && timer.ms === ms) timer.fn();
          else if (!timer.cleared) timers.push(timer);
        }
      };
      const relayed = () =>
        children.map((child) =>
          child.requests.filter(({ method }) => method === 'eip1193.request').map(({ params, context }) => [params.method, context.page.transport_key])
        );
      return { client, children, runTimers, relayed };
    }

    // The bound document's requests, asked once the first core exited: the
    // client is starting the next and still holds the first one's hello.
    async function askedAcrossRestart(versions) {
      const restart = restartingCore(versions);
      const env = setup({ coreClient: restart.client });
      const page = await bound(env);
      await restart.client.start();
      restart.children[0].exit(1, { close: false });
      expect(restart.client.state).toBe('starting');
      expect(restart.client.hello.core_version).toBe(versions[0]);
      const answers = Promise.all([
        page.ask('eth_accounts', []),
        page.ask('eth_requestAccounts', []),
        page.ask('personal_sign', [MESSAGE, ACCOUNT]),
      ]);
      await flush();
      restart.children[0].close(1);
      await flush();
      restart.runTimers(RESTART_DELAYS_MS[0]);
      const answered = await answers;
      await restart.client.stop();
      return { answered, restart, env };
    }

    test('0.21.0 exits and 0.20.0 replaces it: eth_accounts, a connect and a signature go by the replacement\'s hello and answer keyless, and neither core gets them', async () => {
      const { answered, restart, env } = await askedAcrossRestart(['0.21.0', '0.20.0']);
      expect(answered).toEqual([{ result: [] }, { error: NO_ADDRESS }, { error: NO_ADDRESS }]);
      expect(restart.children).toHaveLength(2);
      expect(restart.relayed()).toEqual([[], []]);
      expect(env.prompts()).toEqual([]);
    });

    test('0.21.0 exits and a 0.21.0 pre-release replaces it: keyless too', async () => {
      const { answered, restart } = await askedAcrossRestart(['0.21.0', '0.21.0-rc.1']);
      expect(answered).toEqual([{ result: [] }, { error: NO_ADDRESS }, { error: NO_ADDRESS }]);
      expect(restart.relayed()).toEqual([[], []]);
    });

    test('0.20.0 exits and 0.21.0 replaces it: the requests go to the replacement with the binding', async () => {
      const { answered, restart } = await askedAcrossRestart(['0.20.0', '0.21.0']);
      expect(answered).toEqual([{ result: [ACCOUNT] }, { result: [ACCOUNT] }, { result: '0x5167' }]);
      const transport = `ipns://${IPNS_KEY}`;
      const [first, second] = restart.relayed();
      expect(first).toEqual([]);
      expect(second.sort()).toEqual([
        ['eth_accounts', transport],
        ['eth_requestAccounts', transport],
        ['personal_sign', transport],
      ]);
    });
  });

  test('a key that differs from a transport key of any other form gets the keyless answers, and nothing is sent', async () => {
    const env = setup();
    const page = env.tab();
    let context;
    env.core.script = async () => ({ result: ['sent'] });
    // A document's record whose key and transport key differ, the transport
    // key not `ipns://` and letters and digits: no binding main can send.
    const fake = (method, transportKey) => ({
      method,
      requester: { key: NAME, topKey: NAME, transportKey, window: 1, guest: page.guest.id },
      pageContext: () => ({ frame: 1, navigation: 2, agent: false }),
      signal: new AbortController().signal,
      keylessOnceUnheld: () => {},
    });
    for (const transportKey of [`ipns://${IPNS_KEY}/x`, 'ipns://', `https://${NAME}`, null]) {
      context = fake('eth_accounts', transportKey);
      expect(await env.relay.request(context)).toEqual({ result: [] });
      context = fake('personal_sign', transportKey);
      expect(await env.relay.request(context, { params: [MESSAGE, ACCOUNT] })).toEqual({ error: NO_ADDRESS });
    }
    expect(env.core.sent).toEqual([]);
  });
});
