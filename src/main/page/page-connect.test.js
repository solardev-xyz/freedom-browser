// Connecting through main (freedom-core design 0011, PRQ-4):
// `eth_requestAccounts` prompts through main and main writes the grant, for
// the requester's key; `wallet_switchEthereumChain` writes the grant's
// chain, selects the chain for the page's window and sends `chainChanged`.
// Both check a DNS name over IPNS again before they use it and just before
// their effect.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { createPageEvents } = require('./page-events');
const { normalizeOrigin } = require('../../shared/origin-utils');
const { AgentWalletController } = require('../agent/agent-wallet-controller');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const DAPP = `${KEY_A}/app`;
const OTHER = `${KEY_B}/`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ONCHAIN = '0x00000095643cffa7d9fae407a84dfcb6406456c6';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const SECOND = '0x2222222222222222222222222222222222222222';
const SAFE = '0x3333333333333333333333333333333333333333';
const UNDEPLOYED = '0x4444444444444444444444444444444444444444';
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

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
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

function backends() {
  const state = {
    enabled: true,
    permissions: new Map(),
    wallets: [
      { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
      { index: 1000, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
      { index: 1001, name: 'New Safe', address: UNDEPLOYED, type: 'safe', deployed: {} },
    ],
    active: 0,
    selected: new Map(),
    available: new Set([1, 100]),
    networks: { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis Chain' }, 10: { name: 'Optimism' }, 31337: { name: 'Anvil' } },
    grants: [],
    lastUsed: [],
    selections: [],
    agent: null,
    derive: null,
    grantFails: false,
  };
  const deps = {
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
    getPermission: jest.fn((key) => state.permissions.get(key) || null),
    getDerivedWallets: jest.fn(async () => (state.derive ? state.derive() : state.wallets)),
    chainRequest: jest.fn(async () => ({ result: '0x0' })),
    isChainAvailable: (chainId) => state.available.has(chainId),
    chainName: (chainId) => state.networks[chainId]?.name,
    networks: () => state.networks,
    getActiveWalletIndex: () => state.active,
    grantPermission: jest.fn((key, walletIndex, chainId) => {
      if (state.grantFails) throw new Error('disk full');
      state.grants.push({ key, walletIndex, chainId });
      state.permissions.set(key, { origin: key, walletIndex, chainId });
    }),
    updateLastUsed: jest.fn((key, chainId) => {
      state.lastUsed.push(chainId === undefined ? [key] : [key, chainId]);
      const permission = state.permissions.get(key);
      if (permission && chainId !== undefined) permission.chainId = chainId;
    }),
    selectChainForPage: jest.fn((windowId, chainId) => {
      state.selections.push([windowId, chainId]);
      state.selected.set(windowId, chainId);
      return true;
    }),
    agentWalletRequest: jest.fn(async (guestId, request, options) =>
      (state.agent ? state.agent(guestId, request, options) : { handled: false })
    ),
  };
  return { state, deps };
}

function setup({ resolveEnsContent } = {}) {
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
  const { state, deps } = backends();
  const sent = [];
  const timers = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers(deps),
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
  });

  function greet(guest) {
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    return {
      guest,
      ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
    };
  }

  function tab(url = DAPP, { window = 1, bind = null, front = true } = {}) {
    const guest = new Guest({ window });
    guests.set(guest.id, guest);
    requests.track(guest);
    if (bind) {
      expect(requests.bindName({ sender: guest.hostWebContents }, { guest: guest.id, name: bind, key: url.slice(7).split('/')[0] })).toBe(true);
    }
    guest.commit(url);
    const page = greet(guest);
    if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return page;
  }

  const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });

  // Main's deadline for every request still running.
  const expire = () => {
    for (const timer of timers.filter((t) => !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };

  return { requests, documents, state, deps, sent, tab, greet, names, resolutions, prompts, decide, guests, expire };
}

describe('eth_requestAccounts through main (0011 PRQ-4)', () => {
  test('a connected site gets its account with no prompt, and its last-used time', async () => {
    const env = setup();
    env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 1, chainId: 100 });
    const page = env.tab();
    expect(await page.ask('eth_requestAccounts')).toEqual({ result: [SECOND] });
    expect(env.prompts()).toEqual([]);
    expect(env.state.lastUsed).toEqual([[KEY_A]]);
    expect(env.deps.grantPermission).not.toHaveBeenCalled();
  });

  test('main prompts with its own view, and writes the grant for the requester\'s key from the user\'s pick', async () => {
    const env = setup();
    env.state.selected.set(1, 1);
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    const [prompt] = env.prompts();
    expect(prompt).toEqual({
      handle: expect.stringMatching(/^[0-9a-f]{64}$/),
      guest: page.guest.id,
      kind: 'eth.connect',
      site: { key: KEY_A, label: KEY_A },
      view: {
        // The undeployed Safe can't serve a dApp, and isn't offered.
        accounts: [
          { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
          { index: 1, name: 'Second', address: SECOND, type: 'mnemonic' },
          { index: 1000, name: 'Team Safe', address: SAFE, type: 'safe' },
        ],
        defaultIndex: 0,
        chain: { id: 1, name: 'Ethereum' },
      },
    });
    expect(await env.decide(prompt.handle, true, { walletIndex: 1 })).toEqual({ ok: true });
    expect(await answer).toEqual({ result: [SECOND] });
    // The chain the page reads, at the decision.
    expect(env.state.grants).toEqual([{ key: KEY_A, walletIndex: 1, chainId: 1 }]);
    await flush();
    expect(page.guest.events).toEqual([
      ['accountsChanged', [SECOND]],
      ['connect', { chainId: '0x1' }],
    ]);
  });

  test('the grant\'s accountsChanged reaches every live document of the key, and no other', async () => {
    const env = setup();
    const other = env.tab(`${KEY_A}/other`, { front: false });
    const elsewhere = env.tab(OTHER, { front: false });
    const inWindow2 = env.tab(`${KEY_A}/x`, { window: 2, front: false });
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 });
    await answer;
    await flush();
    expect(other.guest.events).toEqual([['accountsChanged', [ACCOUNT]]]);
    expect(inWindow2.guest.events).toEqual([['accountsChanged', [ACCOUNT]]]);
    expect(elsewhere.guest.events).toEqual([]);
  });

  test('a rejection answers 4001 and writes nothing', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    expect(await env.decide(env.prompts()[0].handle, false)).toEqual({ ok: true });
    expect(await answer).toEqual(REJECTED);
    expect(env.state.grants).toEqual([]);
    expect(page.guest.events).toEqual([]);
  });

  test('a pick the prompt didn\'t offer is refused, and the prompt stays', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    const { handle } = env.prompts()[0];
    for (const choices of [{ walletIndex: 1001 }, { walletIndex: 7 }, { walletIndex: '0' }, {}, { walletIndex: 0, site: KEY_B }]) {
      expect(await env.decide(handle, true, choices)).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(env.state.grants).toEqual([]);
    expect(await env.decide(handle, true, { walletIndex: 1000 })).toEqual({ ok: true });
    expect(await answer).toEqual({ result: [SAFE] });
    expect(env.state.grants).toEqual([{ key: KEY_A, walletIndex: 1000, chainId: 100 }]);
  });

  test('the active account is the default, or the first offered when it can\'t serve a dApp', async () => {
    const env = setup();
    env.state.active = 1001;
    const page = env.tab();
    page.ask('eth_requestAccounts');
    await flush();
    expect(env.prompts()[0].view.defaultIndex).toBe(0);
    const again = setup();
    again.state.active = 1000;
    again.tab().ask('eth_requestAccounts');
    await flush();
    expect(again.prompts()[0].view.defaultIndex).toBe(1000);
  });

  test('an onchain app\'s grant carries its own chain', async () => {
    const env = setup();
    env.state.selected.set(1, 100);
    const page = env.tab(`web3://${ONCHAIN}.eip155-31337/`);
    const answer = page.ask('eth_requestAccounts');
    await flush();
    const [prompt] = env.prompts();
    expect(prompt.site.key).toBe(`web3://${ONCHAIN}:31337`);
    expect(prompt.view.chain).toEqual({ id: 31337, name: 'Anvil' });
    await env.decide(prompt.handle, true, { walletIndex: 0 });
    expect(await answer).toEqual({ result: [ACCOUNT] });
    expect(env.state.grants).toEqual([{ key: `web3://${ONCHAIN}:31337`, walletIndex: 0, chainId: 31337 }]);
    // The window's selection is the user's: connecting doesn't change it.
    expect(env.state.selections).toEqual([]);
  });

  test('a keyless document is refused with no prompt; the switch off answers 4900', async () => {
    const env = setup();
    const keyless = env.tab('data:text/html,hi');
    expect(await keyless.ask('eth_requestAccounts')).toEqual(NO_ADDRESS);
    expect(await keyless.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual(NO_ADDRESS);
    env.state.enabled = false;
    const page = env.tab();
    expect(await page.ask('eth_requestAccounts')).toEqual({ error: { code: 4900, message: 'Disconnected' } });
    expect(env.prompts()).toEqual([]);
    expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
  });

  test('a document that navigates while its prompt is open gets no grant and no answer', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    const { handle } = env.prompts()[0];
    page.guest.commit(OTHER);
    expect(await answer).toEqual({ gone: true });
    expect(await env.decide(handle, true, { walletIndex: 0 })).toEqual({ ok: false, reason: 'closed' });
    expect(env.state.grants).toEqual([]);
  });

  test('an account that went while the prompt was open writes no grant', async () => {
    const env = setup();
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    env.state.wallets = env.state.wallets.filter((wallet) => wallet.index !== 1);
    await env.decide(env.prompts()[0].handle, true, { walletIndex: 1 });
    expect(await answer).toEqual({ error: { code: -32603, message: 'The selected account is no longer available' } });
    expect(env.state.grants).toEqual([]);
  });

  test('a grant that fails to save answers the dApp, and tells it nothing else', async () => {
    const env = setup();
    env.state.grantFails = true;
    const page = env.tab();
    const answer = page.ask('eth_requestAccounts');
    await flush();
    await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 });
    expect(await answer).toEqual({ error: { code: -32603, message: 'Failed to save the connection' } });
    await flush();
    expect(page.guest.events).toEqual([]);
  });

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
      }
    );
    expect(env.prompts()).toEqual([]);
    env.state.agent = async () => ({ handled: true, error: { code: 4001, message: 'User rejected the request' } });
    expect(await page.ask('eth_requestAccounts')).toEqual(REJECTED);
    // A tab it doesn't hold, or a route that fails, takes the prompt.
    env.state.agent = async () => {
      throw new Error('agent gone');
    };
    page.ask('eth_requestAccounts');
    await flush();
    expect(env.prompts()).toHaveLength(1);
  });

  // The agent's own approval runs inside the request's life: the document's
  // one wallet slot, main's deadline and its document, and main's checks
  // before the grant the agent writes. The agent route here is the real
  // AgentWalletController, as the agent service calls it, with an approval
  // the test answers.
  describe('a tab the agent holds, inside the request\'s life', () => {
    function withAgent(env, { pageUrl = null, withdrawOnAbort = false } = {}) {
      const approvals = [];
      env.state.walletIndexUpdates = [];
      const controller = new AgentWalletController({
        identityManager: {
          getDerivedWallets: async () => env.state.wallets,
          getActiveWalletIndex: () => 0,
        },
        getPermission: (key) => env.state.permissions.get(key) || null,
        grantPermission: env.deps.grantPermission,
        updateLastUsed: env.deps.updateLastUsed,
        updateWalletIndex: jest.fn((key, walletIndex) => {
          env.state.walletIndexUpdates.push([key, walletIndex]);
          const permission = env.state.permissions.get(key);
          if (permission) permission.walletIndex = walletIndex;
        }),
        getChain: (chainId) => ({ chainId, name: 'Gnosis Chain', nativeCurrency: { symbol: 'xDAI', decimals: 18 } }),
      });
      env.state.agent = (guestId, request, options) =>
        controller.handleRequest(
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
          },
          request
        );
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

  describe('a DNS name over IPNS', () => {
    function named() {
      const env = setup();
      env.names.set(NAME, IPNS_KEY);
      const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
      return { env, page };
    }

    test('the grant is the name\'s, after the name is checked again', async () => {
      const { env, page } = named();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      expect(env.prompts()[0].site).toEqual({ key: NAME, label: NAME });
      env.resolutions.length = 0;
      await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 });
      expect(await answer).toEqual({ result: [ACCOUNT] });
      expect(env.state.grants).toEqual([{ key: NAME, walletIndex: 0, chainId: 100 }]);
      await flush();
      // Once before the grant, and once before accountsChanged, which is
      // name-revalidated.
      expect(env.resolutions).toEqual([NAME, NAME]);
      expect(page.guest.events).toEqual([
        ['accountsChanged', [ACCOUNT]],
        ['connect', { chainId: '0x64' }],
      ]);
    });

    // #1192 round 1: a connect's new-grant events and the key's other grant
    // events are one ordering domain (PRQ-6), so a revocation made while the
    // connect's accountsChanged waits on the name is heard after it.
    test('a revocation while the connect\'s accountsChanged waits on the name: heard after it, the last event main\'s state', async () => {
      const names = new Map([[NAME, IPNS_KEY]]);
      const resolved = [];
      let holdAt = null;
      let open;
      const gate = new Promise((resolve) => (open = resolve));
      const env = setup({
        resolveEnsContent: async (name) => {
          resolved.push(name);
          if (holdAt !== null && --holdAt === 0) await gate;
          const key = names.get(name);
          return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
        },
      });
      const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
      const events = createPageEvents({
        requests: () => env.requests,
        getDerivedWallets: async () => env.state.wallets,
        normalizeKey: normalizeOrigin,
      });
      const answer = page.ask('eth_requestAccounts');
      await flush();
      // After the decision: the check before the grant, then the one before
      // the connect's accountsChanged, which waits.
      resolved.length = 0;
      holdAt = 2;
      await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 });
      expect(await answer).toEqual({ result: [ACCOUNT] });
      await flush();
      expect(resolved).toEqual([NAME, NAME]);
      expect(page.guest.events).toEqual([]);
      // The grant is revoked meanwhile. Its event waits for the connect's.
      env.state.permissions.delete(NAME);
      const revoked = events.grantChanged({ key: NAME, walletIndex: null });
      await flush();
      expect(resolved).toEqual([NAME, NAME]);
      expect(page.guest.events).toEqual([]);
      open();
      await revoked;
      expect(page.guest.events).toEqual([
        ['accountsChanged', [ACCOUNT]],
        ['connect', { chainId: '0x64' }],
        ['accountsChanged', []],
      ]);
    });

    test('a name that moves off its IPNS key while its connect prompt is open gets no grant', async () => {
      const { env, page } = named();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      env.names.set(NAME, OTHER_IPNS_KEY);
      await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 });
      expect(await answer).toEqual(NO_ADDRESS);
      expect(env.state.grants).toEqual([]);
      await flush();
      expect(page.guest.events).toEqual([]);
      // The binding has ended: the page is keyless now.
      expect(await page.ask('eth_requestAccounts')).toEqual(NO_ADDRESS);
      expect(env.prompts()).toHaveLength(1);
    });

    test('a name that moves while the accounts are read after the decision gets no grant', async () => {
      const { env, page } = named();
      const answer = page.ask('eth_requestAccounts');
      await flush();
      env.state.derive = async () => {
        env.names.set(NAME, OTHER_IPNS_KEY);
        return env.state.wallets;
      };
      await env.decide(env.prompts()[0].handle, true, { walletIndex: 0 });
      expect(await answer).toEqual(NO_ADDRESS);
      expect(env.state.grants).toEqual([]);
    });

    test('a connected name that has moved gets no account and no last-used time', async () => {
      const { env, page } = named();
      env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
      env.names.set(NAME, OTHER_IPNS_KEY);
      expect(await page.ask('eth_requestAccounts')).toEqual(NO_ADDRESS);
      expect(env.state.lastUsed).toEqual([]);
    });

    test('another request ending the binding in the same turn as the connect\'s last check: no grant', async () => {
      const pending = [];
      const env = setup({
        resolveEnsContent: (name) =>
          new Promise((resolve) => {
            pending.push({ name, answer: (decoded) => resolve({ type: 'ok', protocol: 'ipns', decoded }) });
          }),
      });
      const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
      pending.shift().answer(IPNS_KEY);
      await flush();
      const connect = page.ask('eth_requestAccounts');
      await flush();
      // Its checks before the agent's route and before the grant is read.
      pending.shift().answer(IPNS_KEY);
      await flush();
      pending.shift().answer(IPNS_KEY);
      await flush();
      const { handle } = env.prompts()[0];
      env.decide(handle, true, { walletIndex: 0 });
      const accounts = page.ask('eth_accounts');
      await flush();
      // The connect's last check, and eth_accounts' first: answered in the
      // same turn, the bound key first and then elsewhere.
      expect(pending).toHaveLength(2);
      const [last, other] = pending.splice(0);
      last.answer(IPNS_KEY);
      other.answer(OTHER_IPNS_KEY);
      expect(await connect).toEqual(NO_ADDRESS);
      expect(await accounts).toEqual({ result: [] });
      expect(env.state.grants).toEqual([]);
    });
  });
});

describe('wallet_switchEthereumChain through main (0011 PRQ-4)', () => {
  test('a known chain with a source: the grant\'s chain, the window\'s selection and chainChanged to its pages but onchain apps', async () => {
    const env = setup();
    env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 0, chainId: 100 });
    const sibling = env.tab(OTHER, { front: false });
    const onchain = env.tab(`web3://${ONCHAIN}.eip155-1/`, { front: false });
    const elsewhere = env.tab(OTHER, { window: 2, front: false });
    const page = env.tab();
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(env.state.lastUsed).toEqual([[KEY_A, 1]]);
    expect(env.state.permissions.get(KEY_A).chainId).toBe(1);
    expect(env.state.selections).toEqual([[1, 1]]);
    expect(page.guest.events).toEqual([['chainChanged', '0x1']]);
    expect(sibling.guest.events).toEqual([['chainChanged', '0x1']]);
    expect(onchain.guest.events).toEqual([]);
    expect(elsewhere.guest.events).toEqual([]);
    expect(await page.ask('eth_chainId')).toEqual({ result: '0x1' });
    // No prompt, as today.
    expect(env.prompts()).toEqual([]);
    // The same chain again: the page that asked hears it, the others don't.
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(page.guest.events).toHaveLength(2);
    expect(sibling.guest.events).toHaveLength(1);
  });

  test('a site with no grant switches the window\'s chain, and writes no grant', async () => {
    const env = setup();
    const page = env.tab();
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(env.state.lastUsed).toEqual([]);
    expect(env.state.grants).toEqual([]);
    expect(env.state.selections).toEqual([[1, 1]]);
  });

  test('today\'s refusals, with nothing changed', async () => {
    const env = setup();
    env.state.permissions.set(KEY_A, { origin: KEY_A, walletIndex: 0, chainId: 100 });
    const page = env.tab();
    const ask = (params) => page.ask('wallet_switchEthereumChain', params);
    expect(await ask([])).toEqual({ error: { code: -32602, message: 'Invalid parameters' } });
    expect(await ask([{}])).toEqual({ error: { code: -32602, message: 'Invalid parameters' } });
    expect(await ask([{ chainId: '0x5' }])).toEqual({ error: { code: 4902, message: 'Unrecognized chain ID' } });
    expect(await ask([{ chainId: { toString: 'x' } }])).toEqual({ error: { code: 4902, message: 'Unrecognized chain ID' } });
    expect(await ask([{ chainId: '0xa' }])).toEqual({
      error: { code: 4902, message: 'Optimism requires an RPC provider. Please configure Alchemy, Infura, or DRPC in Settings.' },
    });
    expect(env.state.lastUsed).toEqual([]);
    expect(env.state.selections).toEqual([]);
    expect(page.guest.events).toEqual([]);
  });

  test('an onchain app keeps its own chain: another is refused, its own selects it with no chainChanged to the app', async () => {
    const env = setup();
    const sibling = env.tab(OTHER, { front: false });
    const app = env.tab(`web3://${ONCHAIN}.eip155-1/`);
    expect(await app.ask('wallet_switchEthereumChain', [{ chainId: '0x64' }])).toEqual({
      error: { code: 4200, message: 'This onchain application is pinned to chain 1.' },
    });
    expect(env.state.selections).toEqual([]);
    expect(await app.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(env.state.selections).toEqual([[1, 1]]);
    expect(app.guest.events).toEqual([]);
    expect(sibling.guest.events).toEqual([['chainChanged', '0x1']]);
  });

  test('after the name moves off its IPNS key: refused, the grant\'s chain and the selected chain unchanged, and no chainChanged', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
    const sibling = env.tab(OTHER, { front: false });
    const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual(NO_ADDRESS);
    expect(env.state.permissions.get(NAME).chainId).toBe(100);
    expect(env.state.lastUsed).toEqual([]);
    expect(env.state.selections).toEqual([]);
    expect(await page.ask('eth_chainId')).toEqual({ result: '0x64' });
    expect(page.guest.events).toEqual([]);
    expect(sibling.guest.events).toEqual([]);
  });

  test('while the name still answers its key, the switch is the name\'s', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.state.permissions.set(NAME, { origin: NAME, walletIndex: 0, chainId: 100 });
    const page = env.tab(`ipns://${IPNS_KEY}/docs`, { bind: NAME });
    env.resolutions.length = 0;
    expect(await page.ask('wallet_switchEthereumChain', [{ chainId: '0x1' }])).toEqual({ result: null });
    expect(env.resolutions).toEqual([NAME]);
    expect(env.state.lastUsed).toEqual([[NAME, 1]]);
    expect(page.guest.events).toEqual([['chainChanged', '0x1']]);
  });
});
