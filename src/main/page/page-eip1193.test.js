// Main's relay to the identity core's Ethereum dispatcher (freedom-core
// design 0012, APB-4a and APB-4b): the reads, the connect, the switch and
// the signatures go to `eip1193.request` under the page's PageContext, main
// serves the core's `approval.request`, `approval.recheck` and
// `eip1193.select_chain` for the request they name, and a signature's
// `{ device }` goes to main's device step. Here the core is a stand-in that asks what a
// script tells it to; page-eip1193.integration.test.js runs the real one.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { createEip1193Relay, connectShown, signShown, unlockShown } = require('./page-eip1193');

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
    sent: [],
    holds: [],
    released: [],
    script: async () => ({ result: null }),
    request: jest.fn(async (method, params, context, options) => {
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

function setup({ approvalsDocument = false, deviceDeps = {} } = {}) {
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
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const core = standInCore();
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
      signing: { inCustody: () => false },
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
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return {
      guest,
      ask: (method, params) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
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

// The core's connect prompt for request `id`, as cored 0.20.0 asks it.
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

  test('eth.send answers busy until APB-4c; a signature\'s or an unlock\'s prompt for a connect is refused; neither opens anything', async () => {
    const env = setup();
    const page = env.tab();
    const answers = [];
    env.core.script = async ({ id, page: pc }) => {
      answers.push(await env.relay.approvalRequest({ ...connectAsk(id, pc), kind: 'eth.send' }, { generation: GENERATION }));
      for (const kind of ['eth.sign', 'vault.unlock']) {
        await expect(
          env.relay.approvalRequest({ ...connectAsk(id, pc), kind }, { generation: GENERATION })
        ).rejects.toMatchObject({ code: 'invalid_argument' });
      }
      return { error: { code: -32002, message: 'Another wallet request is already pending' } };
    };
    await page.ask('eth_requestAccounts', []);
    expect(answers).toEqual([{ prompt: PROMPT, busy: true }]);
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

    // A name that moved since the recheck: nothing selected, and main's 4100.
    env.names.set(NAME, IPNS_KEY);
    const named = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    env.core.script = async ({ id, page: pc }) => {
      env.names.set(NAME, OTHER_IPNS_KEY);
      await env.relay.approvalRecheck({ request: id, page: pc }, { generation: GENERATION });
      await env.relay
        .selectChain({ request: id, page: pc, chain_id: 1 }, { generation: GENERATION })
        .then(() => outcomes.push('selected'), (err) => outcomes.push(err.code));
      return { error: { code: -32603, message: 'mismatch' } };
    };
    expect(await named.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ error: NO_ADDRESS });
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

// The core's eth.sign prompt for request `id`, as cored 0.20.0 asks it.
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

  test('vault.unlock: a rejection, a navigation and busy answer as such; an approve only once the vault is open', async () => {
    const env = setup();
    const page = env.tab();
    const answers = asking(env, unlockAsk, () => ({ result: '0x01' }));
    env.state.unlocked = false;
    const rejected = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    let [shown] = env.prompts();
    expect(shown).toMatchObject({ kind: 'vault.unlock', view: { account: accountOf(0), reason: 'sign' } });
    expect(await env.decide(shown.handle, false)).toEqual({ ok: true });
    await rejected;
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, handle: shown.handle, approve: false, choices: {} });

    // Approved with the vault still locked: no approve.
    const locked = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    shown = env.prompts()[1];
    expect(await env.decide(shown.handle, true, {})).toEqual({ ok: true });
    await locked;
    expect(answers.at(-1)).toEqual({ prompt: PROMPT, handle: shown.handle, approve: false, choices: {} });

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
