// Main's relay to the identity core's Ethereum dispatcher (freedom-core
// design 0012, APB-4a): the reads, the connect and the switch go to
// `eip1193.request` under the page's PageContext, and main serves the
// core's `approval.request`, `approval.recheck` and `eip1193.select_chain`
// for the request they name. Here the core is a stand-in that asks what a
// script tells it to; page-eip1193.integration.test.js runs the real one.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { createEip1193Relay, connectShown } = require('./page-eip1193');

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

function setup() {
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
    }),
    setTimer: () => ({}),
    clearTimer: () => {},
    chromeWindowOf: (contents) => (contents?.id >= 500 ? contents.id - 500 : null),
    sendToWindow: (windowId, channel, payload) => sent.push([windowId, channel, payload]),
    watchWindow: () => {},
    isAgentGuest: () => state.agent,
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
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
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

  test('crossed requests are refused: another document\'s page, an unknown request, a malformed prompt id or view, a connect for another method', async () => {
    const env = setup();
    const page = env.tab();
    const other = env.tab(`${KEY_B}/`, { front: false });
    const refusals = [];
    env.core.script = async ({ id, page: pc }) => {
      const otherPage = { ...pc, origin: KEY_B, top_origin: KEY_B };
      const tries = [
        connectAsk(id, otherPage),
        connectAsk(id + 100, pc),
        { ...connectAsk(id, pc), prompt: 'C'.repeat(32) },
        { ...connectAsk(id, pc), choices: { walletIndex: [1, 0] } },
        { ...connectAsk(id, pc), extra: true },
        { ...connectAsk(id, pc), kind: 'swarm.connect' },
      ];
      for (const ask of tries) {
        await env.relay.approvalRequest(ask, { generation: GENERATION }).then(
          () => refusals.push('answered'),
          (err) => refusals.push(err.code)
        );
      }
      // Another process's request of the same id.
      await env.relay.approvalRequest(connectAsk(id, pc), { generation: GENERATION + 1 }).catch((err) => refusals.push(err.code));
      return { result: '0x64' };
    };
    expect(await page.ask('eth_chainId', [])).toEqual({ result: '0x64' });
    // A connect prompt for a request that isn't a connect.
    expect(refusals).toEqual(Array(7).fill('invalid_argument'));
    expect(env.prompts()).toEqual([]);
    expect(other.guest.events).toEqual([]);
  });

  test('the kinds APB-4b and APB-4c serve answer busy, and open nothing', async () => {
    const env = setup();
    const page = env.tab();
    const answers = [];
    env.core.script = async ({ id, page: pc }) => {
      for (const kind of ['eth.sign', 'eth.send', 'vault.unlock']) {
        answers.push(await env.relay.approvalRequest({ ...connectAsk(id, pc), kind }, { generation: GENERATION }));
      }
      return { error: { code: -32002, message: 'Another wallet request is already pending' } };
    };
    await page.ask('eth_requestAccounts', []);
    expect(answers).toEqual(Array(3).fill({ prompt: PROMPT, busy: true }));
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
