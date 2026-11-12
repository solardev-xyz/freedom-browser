// Signing through main (freedom-core design 0011, PRQ-5a): `personal_sign`
// and `eth_signTypedData_v4`, from every account kind, a Safe's messages
// included. Main reads the site's signing rule itself, with Agent custody
// read live; otherwise it prompts, and its own issuer mints the approval's
// token, bound to the prompt's handle and the requester's attested key, and
// spends it just before the signature. A DNS name over IPNS is checked
// again before every use and just before the effect.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests, GONE } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { AgentWalletController } = require('../agent/agent-wallet-controller');
const confirmations = require('../wallet/signing-confirmation');
const { normalizeMessage, messageToBytes, signsRawHash } = require('../wallet/signing-utils');

const CHROME_URL = 'file:///app/src/renderer/index.html';
const KEY_A = `bzz://${'a'.repeat(64)}`;
const KEY_B = `bzz://${'b'.repeat(64)}`;
const DAPP = `${KEY_A}/app`;
const OTHER = `${KEY_B}/`;
const IPNS_KEY = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const OTHER_IPNS_KEY = 'k51qzi5uqu5dh71qgwangrt6r0nd4094i88nsady6qgd1dhjcyfsaqmpp143ab';
const NAME = 'example.com';
const ACCOUNT = '0x1111111111111111111111111111111111111111';
const LEDGER = '0x2222222222222222222222222222222222222222';
const SAFE = '0x3333333333333333333333333333333333333333';
const SAFE_INDEX = 1000;
const MESSAGE = '0x68656c6c6f'; // "hello"
const RAW_HASH = `0x${'ab'.repeat(32)}`;
const TYPED = {
  types: {
    EIP712Domain: [{ name: 'chainId', type: 'uint256' }],
    Order: [{ name: 'amount', type: 'uint256' }],
  },
  domain: { chainId: 100 },
  primaryType: 'Order',
  message: { amount: '1' },
};
const TYPED_HASH = `0x${'cd'.repeat(32)}`;
const TYPED_VIEW = { primaryType: 'Order', domain: { chainId: '0x64' }, message: [] };
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const NOT_CONNECTED = { error: { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const CUSTODY = {
  error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'agent_custody' } },
};

let nextId = 1;
let nextNonce = 1;
const nonce = () => (nextNonce++).toString(16).padStart(32, '0');
const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
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

  destroy() {
    this.destroyed = true;
    this.emit('destroyed');
  }
}

const eventFrom = (guest) => ({ sender: guest, senderFrame: guest.mainFrame });

function backends() {
  const state = {
    enabled: true,
    permissions: new Map(),
    wallets: [
      { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      { index: 1, name: 'Ledger', address: LEDGER, type: 'ledger' },
      { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
    ],
    selected: new Map(),
    networks: { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis Chain' } },
    lastUsed: [],
    rules: [],
    custody: new Set(),
    unlocked: true,
    typedWarnings: [],
    typedView: null,
    agent: null,
    signed: [],
    signerFails: null,
    safe: { complete: true, sessions: [], completed: [], cancelled: [] },
  };
  const signer = {
    signMessage: jest.fn(async (message) => {
      if (state.signerFails) throw state.signerFails;
      state.signed.push(['message', message]);
      return '0xmsgsig';
    }),
    signTypedData: jest.fn(async (data, options) => {
      if (state.signerFails) throw state.signerFails;
      state.signed.push(['typed', data, options]);
      return '0xtypedsig';
    }),
  };
  const deps = {
    identityWalletEnabled: () => state.enabled,
    selectedChainOf: (windowId) => (state.selected.has(windowId) ? state.selected.get(windowId) : 100),
    getPermission: jest.fn((key) => state.permissions.get(key) || null),
    getDerivedWallets: jest.fn(async () => state.wallets),
    chainRequest: jest.fn(async () => ({ result: '0x0' })),
    isChainAvailable: () => true,
    chainName: (chainId) => state.networks[chainId]?.name,
    networks: () => state.networks,
    getActiveWalletIndex: () => 0,
    grantPermission: jest.fn(),
    updateLastUsed: jest.fn((key, chainId) => {
      state.lastUsed.push(chainId === undefined ? [key] : [key, chainId]);
    }),
    selectChainForPage: jest.fn(),
    agentWalletRequest: jest.fn(async (guestId, request, options) =>
      (state.agent ? state.agent(guestId, request, options) : { handled: false })
    ),
    signing: {
      inCustody: (guestId) => state.custody.has(guestId),
      isVaultUnlocked: async () => (typeof state.unlocked === 'function' ? state.unlocked() : state.unlocked),
      // As main's messageViewFor: the bytes the core signs.
      messageView: (message) => {
        if (typeof message !== 'string') throw new Error('The message to sign must be text or 0x-prefixed hex');
        return { hex: `0x${messageToBytes(normalizeMessage(message)).toString('hex')}`, rawHash: signsRawHash(message) };
      },
      typedDataView: jest.fn(async (typedData, chainId) => {
        if (state.typedView) return state.typedView(typedData, chainId);
        if (!typedData || typeof typedData !== 'object') throw new Error('Typed data is required');
        return { hash: TYPED_HASH, view: TYPED_VIEW, warnings: state.typedWarnings.slice() };
      }),
      signsRawHash,
      getSigner: jest.fn(() => signer),
      setSigningAutoApprove: jest.fn((key, enabled) => {
        state.rules.push([key, enabled]);
        const permission = state.permissions.get(key);
        if (permission) permission.autoApprove = { ...(permission.autoApprove || {}), signing: enabled };
      }),
      startSafeMessage: jest.fn(async (options) => {
        state.safe.sessions.push(options);
        return {
          safeIndex: options.safeIndex,
          kind: 'message',
          token: `session-${state.safe.sessions.length}`,
          threshold: 2,
          collected: state.safe.complete ? 2 : 1,
          complete: state.safe.complete,
          display: options.display,
        };
      }),
      completeSafeMessage: jest.fn((safeIndex, token) => {
        state.safe.completed.push([safeIndex, token]);
        return { signature: '0xsafesig' };
      }),
      cancelSafeMessage: jest.fn((safeIndex, token) => {
        state.safe.cancelled.push([safeIndex, token]);
      }),
    },
  };
  return { state, deps, signer };
}

function setup({ dispatchers: custom } = {}) {
  const guests = new Map();
  const names = new Map();
  const nameHolds = new Map(); // name -> deferred: the next resolution waits for it
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      const hold = nameHolds.get(name);
      if (hold) {
        nameHolds.delete(name);
        await hold.promise;
      }
      const key = names.get(name);
      return key ? { type: 'ok', protocol: 'ipns', decoded: key } : { type: 'not_found' };
    },
  });
  const { state, deps, signer } = backends();
  const sent = [];
  const timers = [];
  const traced = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: custom || createEthereumDispatchers(deps),
    hooks: { onTrace: (entry) => traced.push(entry) },
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
  const lastPrompt = (windowId = 1) => prompts(windowId).at(-1);
  const decide = (handle, approve, choices, windowId = 1) =>
    requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  const connect = (key = KEY_A, walletIndex = 0, extra = {}) =>
    state.permissions.set(key, { origin: key, walletIndex, chainId: 100, ...extra });
  const expire = () => {
    for (const timer of timers.filter((t) => !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  const minted = () => traced.filter((entry) => entry.kind === 'token-minted');

  return {
    requests,
    documents,
    state,
    deps,
    signer,
    sent,
    tab,
    greet,
    names,
    nameHolds,
    prompts,
    lastPrompt,
    decide,
    connect,
    guests,
    expire,
    traced,
    minted,
  };
}

beforeEach(() => {
  confirmations._reset();
});

describe('signing through main, on the prompt main shows (0011 PRQ-5a)', () => {
  test("personal_sign: main's own view, and on approval the signature its issuer's token authorized", async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.prompts()).toEqual([
      {
        handle: expect.stringMatching(/^[0-9a-f]{64}$/),
        guest: page.guest.id,
        kind: 'eth.sign',
        site: { key: KEY_A, label: KEY_A },
        view: {
          method: 'personal_sign',
          account: { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
          chain: { id: 100, name: 'Gnosis Chain' },
          message: { hex: MESSAGE, rawHash: false },
        },
      },
    ]);
    expect(env.state.signed).toEqual([]);
    expect(await env.decide(env.lastPrompt().handle, true, {})).toEqual({ ok: true });
    expect(await answer).toEqual({ result: '0xmsgsig' });
    expect(env.state.signed).toEqual([['message', MESSAGE]]);
    // One token, minted for this approval and spent by main, and none left.
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'sign-message' })]);
    expect(env.traced.filter((entry) => entry.kind === 'token-spent')).toHaveLength(1);
    expect(confirmations._outstandingCount()).toBe(0);
    // A confirmed signature isn't a use of the rule: no last-used write.
    expect(env.state.lastUsed).toEqual([]);
  });

  test("eth_signTypedData_v4: the core's view, and the signature bound to the hash it computed", async () => {
    const env = setup();
    env.connect();
    env.state.selected.set(1, 1);
    const page = env.tab();
    const answer = page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
    await flush();
    // Viewed against the chain the page reads.
    expect(env.deps.signing.typedDataView).toHaveBeenCalledWith(TYPED, 1);
    expect(env.lastPrompt().view).toEqual({
      method: 'eth_signTypedData_v4',
      account: { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      chain: { id: 1, name: 'Ethereum' },
      typedData: { hash: TYPED_HASH, view: TYPED_VIEW, warnings: [] },
      chains: {},
    });
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xtypedsig' });
    expect(env.state.signed).toEqual([['typed', TYPED, { expectedHash: TYPED_HASH }]]);
  });

  test("a chain-mismatch warning names the page's chain and the data's", async () => {
    const env = setup();
    env.connect();
    env.state.typedWarnings = ['chain-mismatch'];
    env.state.typedView = async () => ({
      hash: TYPED_HASH,
      view: { ...TYPED_VIEW, domain: { chainId: '0x1' } },
      warnings: ['chain-mismatch'],
    });
    const page = env.tab();
    page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
    await flush();
    expect(env.lastPrompt().view.chains).toEqual({ 100: { name: 'Gnosis Chain' }, 1: { name: 'Ethereum' } });
  });

  test('rejected: 4001, nothing signed and no token minted', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await env.decide(env.lastPrompt().handle, false);
    expect(await answer).toEqual(REJECTED);
    expect(env.state.signed).toEqual([]);
    expect(env.minted()).toEqual([]);
  });

  test("a site that isn't connected, or a keyless page, is refused unprompted", async () => {
    const env = setup();
    const page = env.tab();
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(NOT_CONNECTED);
    const blank = env.tab('data:text/html,<p>x</p>');
    expect(await blank.ask('eth_signTypedData_v4', [ACCOUNT, TYPED])).toEqual(NO_ADDRESS);
    expect(env.prompts()).toEqual([]);
    expect(env.deps.signing.typedDataView).not.toHaveBeenCalled();
  });

  test("a message main can't show is refused before any prompt", async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    expect(await page.ask('personal_sign', [{ not: 'text' }, ACCOUNT])).toEqual({
      error: { code: -32603, message: 'The message to sign must be text or 0x-prefixed hex' },
    });
    expect(await page.ask('eth_signTypedData_v4', [ACCOUNT, 'not typed data'])).toEqual({
      error: { code: -32603, message: 'Typed data is required' },
    });
    expect(env.prompts()).toEqual([]);
  });

  test('a Safe signs only on Gnosis', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    env.state.selected.set(1, 1);
    const page = env.tab();
    expect(await page.ask('personal_sign', [MESSAGE, SAFE])).toEqual({
      error: { code: -32603, message: 'This multi-owner account can only sign on Gnosis Chain — switch the app to Gnosis first.' },
    });
    expect(env.prompts()).toEqual([]);
  });

  test('"always allow" sets the site\'s rule for the requester\'s key, once the signature is made', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    // The one choice the prompt takes: nothing else, and no site.
    expect(await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true, site: KEY_B })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await env.decide(env.lastPrompt().handle, true, { alwaysAllow: 'yes' })).toEqual({ ok: false, reason: 'invalid' });
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ result: '0xmsgsig' });
    expect(env.state.rules).toEqual([[KEY_A, true]]);
  });

  test('"always allow" sets nothing when the signature fails', async () => {
    const env = setup();
    env.connect();
    env.state.signerFails = new Error('device unplugged');
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ error: { code: -32603, message: 'device unplugged' } });
    expect(env.state.rules).toEqual([]);
  });

  test("a device's own decline answers the user's rejection", async () => {
    const env = setup();
    env.connect(KEY_A, 1);
    env.state.signerFails = Object.assign(new Error('Rejected on the Ledger'), { code: 'LEDGER_USER_REJECTED' });
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, LEDGER]);
    await flush();
    expect(env.lastPrompt().view.account.type).toBe('ledger');
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(REJECTED);
  });

  test('one pending wallet prompt per document: the next request gets -32002', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(await page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED])).toEqual({
      error: { code: -32002, message: 'Another wallet request is already pending' },
    });
  });

  test('the slot stays taken while an approved signature runs', async () => {
    const env = setup();
    env.connect(KEY_A, 1);
    const device = deferred();
    env.signer.signMessage.mockImplementationOnce(async () => {
      await device.promise;
      return '0xledgersig';
    });
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, LEDGER]);
    await flush();
    const decided = env.decide(env.lastPrompt().handle, true, {});
    await flush();
    expect(await page.ask('personal_sign', [MESSAGE, LEDGER])).toEqual({
      error: { code: -32002, message: 'Another wallet request is already pending' },
    });
    device.resolve();
    expect(await answer).toEqual({ result: '0xledgersig' });
    expect(await decided).toEqual({ ok: true });
  });

  test("main's deadline: a prompt never shown closes with nothing signed; one shown has none", async () => {
    const env = setup();
    env.connect();
    const front = env.tab(`${KEY_A}/front`);
    const background = env.tab(DAPP, { front: false });
    const unseen = background.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.prompts()).toEqual([]);
    const seen = front.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.prompts()).toHaveLength(1);
    env.expire();
    expect(await unseen).toEqual({ error: { message: 'Request timed out' } });
    // The shown prompt is still open, and still signs.
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await seen).toEqual({ result: '0xmsgsig' });
    expect(env.state.signed).toEqual([['message', MESSAGE]]);
    // And the expired one never shows when its tab comes to the front.
    env.requests.foreground({ sender: { id: 501 } }, { guest: background.guest.id });
    expect(env.prompts()).toHaveLength(1);
  });

  test('a document that navigates while its prompt is open gets nothing, and nothing is signed', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const { handle } = env.lastPrompt();
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    expect(await env.decide(handle, true, {})).toEqual({ ok: false, reason: 'closed' });
    expect(env.state.signed).toEqual([]);
    expect(env.minted()).toEqual([]);
  });

  test('a grant revoked while the prompt is open signs nothing', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.state.permissions.delete(KEY_A);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(NOT_CONNECTED);
    expect(env.state.signed).toEqual([]);
    expect(env.minted()).toEqual([]);
  });
});

describe("main's issuer: a page token only for a live record, bound to its handle and key", () => {
  // A dispatcher that prompts and hands the test its context.
  function withContexts() {
    const contexts = [];
    const dispatch = async (context) => {
      const decision = await context.prompt({ kind: 'eth.sign', view: {}, choices: () => ({}) });
      // The request stays open until the test lets it go.
      const open = deferred();
      contexts.push({ context, decision, release: open.resolve });
      await open.promise;
      return { result: 'done' };
    };
    const env = setup({ dispatchers: { 'ethereum:personal_sign': dispatch, 'ethereum:eth_signTypedData_v4': dispatch } });
    return { env, contexts };
  }

  async function approved(env, contexts, page) {
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await Promise.race([env.decide(env.lastPrompt().handle, true, {}), flush()]);
    await flush();
    return { answer, ...contexts.at(-1) };
  }

  test('no token without an approval of a live record', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await Promise.race([env.decide(env.lastPrompt().handle, false), flush()]);
    await flush();
    const { context, release } = contexts[0];
    // Rejected: nothing to mint on.
    expect(() => context.confirm('sign-message', 0, MESSAGE)).toThrow(/not confirmed/);
    release();
    await answer;
    // An answered record mints nothing either.
    expect(() => context.confirm('sign-message', 0, MESSAGE)).toThrow(/not confirmed/);
    expect(confirmations._outstandingCount()).toBe(0);
  });

  test('an approval mints one token, of a page kind only', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    expect(() => context.confirm('wallet-send', 0, { chainId: 100, to: ACCOUNT })).toThrow(/Not a page confirmation kind/);
    const token = context.confirm('sign-message', 0, MESSAGE);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(() => context.confirm('sign-message', 0, MESSAGE)).toThrow(/not confirmed/);
    expect(context.spend(token, 'sign-message', 0, MESSAGE)).toEqual({});
    release();
    await answer;
  });

  test('a token minted for handle A is refused for handle B, and for another key', async () => {
    const { env, contexts } = withContexts();
    const pageA = env.tab();
    const pageA2 = env.tab(`${KEY_A}/second`, { front: false });
    const pageB = env.tab(OTHER, { front: false });
    const a = await approved(env, contexts, pageA);
    env.requests.foreground({ sender: { id: 501 } }, { guest: pageA2.guest.id });
    const a2 = await approved(env, contexts, pageA2);
    env.requests.foreground({ sender: { id: 501 } }, { guest: pageB.guest.id });
    const b = await approved(env, contexts, pageB);
    const tokenA = a.context.confirm('sign-message', 0, MESSAGE);
    const tokenA2 = a2.context.confirm('sign-message', 0, MESSAGE);
    b.context.confirm('sign-message', 0, MESSAGE);
    // The same key, another handle: refused, and burnt.
    expect(() => a2.context.spend(tokenA, 'sign-message', 0, MESSAGE)).toThrow(/differs from what was confirmed/);
    expect(() => a.context.spend(tokenA, 'sign-message', 0, MESSAGE)).toThrow(/unknown or already used/);
    // Another key's request: refused, and burnt.
    expect(() => b.context.spend(tokenA2, 'sign-message', 0, MESSAGE)).toThrow(/differs from what was confirmed/);
    expect(() => a2.context.spend(tokenA2, 'sign-message', 0, MESSAGE)).toThrow(/unknown or already used/);
    for (const { release } of contexts) release();
  });

  test('another key, at the issuer: the same handle and payload for another site is refused', () => {
    const handle = 'f'.repeat(64);
    const { token } = confirmations.issuePageConfirmation('sign-message', 0, MESSAGE, { handle, key: KEY_A });
    expect(() => confirmations.consumePageConfirmation(token, 'sign-message', 0, MESSAGE, { handle, key: KEY_B })).toThrow(
      /differs from what was confirmed/
    );
  });

  test('a token whose document navigated is refused, and burnt', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    const token = context.confirm('sign-message', 0, MESSAGE);
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    expect(() => context.spend(token, 'sign-message', 0, MESSAGE)).toThrow(/the document that asked has gone/);
    expect(confirmations._outstandingCount()).toBe(0);
    release();
  });

  test('a token spent twice: the second is refused', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    const token = context.confirm('sign-message', 0, MESSAGE);
    context.spend(token, 'sign-message', 0, MESSAGE);
    expect(() => context.spend(token, 'sign-message', 0, MESSAGE)).toThrow(/not confirmed/);
    release();
    await answer;
  });

  test('the chrome route never spends a page token, nor a page a chrome token', () => {
    const handle = 'e'.repeat(64);
    const page = confirmations.issuePageConfirmation('sign-message', 0, MESSAGE, { handle, key: KEY_A });
    expect(() => confirmations.consumeConfirmation(page.token, 'sign-message', 0, MESSAGE)).toThrow(/spent only by main/);
    const chrome = confirmations.issueConfirmation('sign-message', 0, MESSAGE);
    expect(() =>
      confirmations.consumePageConfirmation(chrome.token, 'sign-message', 0, MESSAGE, { handle, key: KEY_A })
    ).toThrow(/not a page confirmation/);
  });
});

describe("the site's rule, read by main for the request it holds", () => {
  const ruled = (env, key = KEY_A, walletIndex = 0) => env.connect(key, walletIndex, { autoApprove: { signing: true } });

  test("a page's concurrent signatures under the rule all sign: none waits on a wallet slot", async () => {
    const env = setup();
    ruled(env);
    const page = env.tab();
    const answers = await Promise.all([
      page.ask('personal_sign', [MESSAGE, ACCOUNT]),
      page.ask('personal_sign', [MESSAGE, ACCOUNT]),
      page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]),
    ]);
    expect(answers).toEqual([{ result: '0xmsgsig' }, { result: '0xmsgsig' }, { result: '0xtypedsig' }]);
    expect(env.deps.agentWalletRequest).not.toHaveBeenCalled();
  });

  test('the rule answers with no prompt, and marks the site used', async () => {
    const env = setup();
    ruled(env);
    const page = env.tab();
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual({ result: '0xmsgsig' });
    expect(await page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED])).toEqual({ result: '0xtypedsig' });
    expect(env.prompts()).toEqual([]);
    expect(env.state.signed).toEqual([
      ['message', MESSAGE],
      ['typed', TYPED, { expectedHash: TYPED_HASH }],
    ]);
    expect(env.state.lastUsed).toEqual([[KEY_A], [KEY_A]]);
  });

  test('a warned request always prompts: a 32-byte message, and typed data the view warns about', async () => {
    const env = setup();
    ruled(env);
    env.state.typedWarnings = ['chain-absent'];
    const page = env.tab();
    page.ask('personal_sign', [RAW_HASH, ACCOUNT]);
    await flush();
    expect(env.lastPrompt().view.message).toEqual({ hex: RAW_HASH, rawHash: true });
    await env.decide(env.lastPrompt().handle, false);
    await flush();
    page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
    await flush();
    expect(env.lastPrompt().view.typedData.warnings).toEqual(['chain-absent']);
    expect(env.state.signed).toEqual([]);
  });

  test('a rule answers only a live request of its own key', async () => {
    const env = setup();
    ruled(env);
    env.connect(KEY_B);
    const other = env.tab(OTHER);
    other.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    // Site B has no rule of its own: it is prompted, whatever A's says.
    expect(env.prompts()).toHaveLength(1);
    expect(env.state.signed).toEqual([]);
    // A's own page, gone while its request waits on the core's view.
    const view = deferred();
    env.deps.signing.typedDataView.mockImplementationOnce(async () => {
      await view.promise;
      return { hash: TYPED_HASH, view: TYPED_VIEW, warnings: [] };
    });
    const page = env.tab(DAPP, { front: false });
    const answer = page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
    await flush();
    page.guest.commit(OTHER);
    view.resolve();
    expect(await answer).toBe(GONE);
    expect(env.state.signed).toEqual([]);
  });

  test('a locked vault asks for its unlock first, and the rule signs once it is unlocked', async () => {
    const env = setup();
    ruled(env);
    env.state.unlocked = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt()).toMatchObject({
      kind: 'vault.unlock',
      site: { key: KEY_A },
      view: { account: { index: 0, type: 'mnemonic' }, reason: 'sign' },
    });
    env.state.unlocked = true;
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xmsgsig' });
  });

  test('an unlock the user cancels signs nothing', async () => {
    const env = setup();
    ruled(env);
    env.state.unlocked = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await env.decide(env.lastPrompt().handle, false);
    expect(await answer).toEqual({ error: { code: 4001, message: 'User cancelled unlock' } });
    expect(env.state.signed).toEqual([]);
  });

  test('a rule turned off while the unlock waits signs nothing', async () => {
    const env = setup();
    ruled(env);
    env.state.unlocked = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.state.permissions.get(KEY_A).autoApprove.signing = false;
    await env.decide(env.lastPrompt().handle, true, {});
    expect((await answer).error).toMatchObject({ code: -32603, message: expect.stringMatching(/auto-approve rules/) });
    expect(env.state.signed).toEqual([]);
  });
});

describe('Agent custody, read live', () => {
  const ruled = (env) => env.connect(KEY_A, 0, { autoApprove: { signing: true } });

  test('a tab that enters custody after its hello gets no standing rule', async () => {
    const env = setup();
    ruled(env);
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    expect(env.state.signed).toEqual([]);
  });

  test.each([
    ['the core\'s view', 'view'],
    ['the name', 'name'],
    ['the vault', 'vault'],
  ])('one that enters custody while its auto-approved request waits on %s is refused, nothing signed', async (_label, wait) => {
    const env = setup();
    let page;
    if (wait === 'name') {
      env.names.set(NAME, IPNS_KEY);
      env.connect(NAME, 0, { autoApprove: { signing: true } });
      page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    } else {
      ruled(env);
      page = env.tab();
    }
    const enter = () => env.state.custody.add(page.guest.id);
    let answer;
    if (wait === 'view') {
      const view = deferred();
      env.deps.signing.typedDataView.mockImplementationOnce(async () => {
        await view.promise;
        return { hash: TYPED_HASH, view: TYPED_VIEW, warnings: [] };
      });
      answer = page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
      await flush();
      enter();
      view.resolve();
    } else if (wait === 'name') {
      // The name's last resolution before the effect.
      const view = deferred();
      env.deps.signing.typedDataView.mockImplementationOnce(async () => {
        const hold = deferred();
        env.nameHolds.set(NAME, hold);
        view.resolve(hold);
        return { hash: TYPED_HASH, view: TYPED_VIEW, warnings: [] };
      });
      answer = page.ask('eth_signTypedData_v4', [ACCOUNT, TYPED]);
      const hold = await view.promise;
      await flush();
      enter();
      hold.resolve();
    } else {
      env.state.unlocked = false;
      answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
      await flush();
      enter();
      env.state.unlocked = true;
      await env.decide(env.lastPrompt().handle, true, {});
    }
    expect(await answer).toEqual(CUSTODY);
    expect(env.state.signed).toEqual([]);
  });

  test('one that leaves custody gets the rules for its next request; one already at its prompt keeps it', async () => {
    const env = setup();
    ruled(env);
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    const prompted = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    const { handle } = env.lastPrompt();
    env.state.custody.delete(page.guest.id);
    await flush();
    // Still waiting on the user: it doesn't turn automatic.
    expect(env.state.signed).toEqual([]);
    await env.decide(handle, true, {});
    expect(await prompted).toEqual({ result: '0xmsgsig' });
    // The next request: the rule answers.
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual({ result: '0xmsgsig' });
    expect(env.prompts()).toHaveLength(1);
  });

  test("a user's own decision counts in custody", async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.state.custody.add(page.guest.id);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xmsgsig' });
  });
});

describe('a DNS name over IPNS that moves off its key', () => {
  function named({ rule = false } = {}) {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, 0, rule ? { autoApprove: { signing: true } } : {});
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    return { env, page };
  }

  test.each([[false], [true]])('honest: it signs under the name (rule: %s)', async (rule) => {
    const { env, page } = named({ rule });
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    if (!rule) {
      expect(env.lastPrompt().site).toEqual({ key: NAME, label: NAME });
      await env.decide(env.lastPrompt().handle, true, {});
    }
    expect(await answer).toEqual({ result: '0xmsgsig' });
  });

  test.each([[false], [true]])('moved before the rule is read: refused, nothing signed (rule: %s)', async (rule) => {
    const { env, page } = named({ rule });
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(NO_ADDRESS);
    expect(env.prompts()).toEqual([]);
    expect(env.state.signed).toEqual([]);
    expect(env.deps.getPermission).not.toHaveBeenCalledWith(NAME);
  });

  test.each([[false], [true]])('moved during the resolution: refused, nothing signed (rule: %s)', async (rule) => {
    const { env, page } = named({ rule });
    const hold = deferred();
    env.nameHolds.set(NAME, hold);
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    hold.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.signed).toEqual([]);
  });

  test('moved while the signing prompt is open: refused, nothing signed, no token', async () => {
    const { env, page } = named();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.signed).toEqual([]);
    expect(env.state.rules).toEqual([]);
    expect(env.minted()).toEqual([]);
  });

  test("moved while the rule's unlock prompt is open: refused, nothing signed", async () => {
    const { env, page } = named({ rule: true });
    env.state.unlocked = false;
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt().kind).toBe('vault.unlock');
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.state.unlocked = true;
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.signed).toEqual([]);
  });
});

describe("a Safe's message, in a session main owns", () => {
  test('the vault owners suffice: main opens the session for the requester, and completes it', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    expect(env.lastPrompt()).toMatchObject({ kind: 'eth.sign', view: { account: { index: SAFE_INDEX, type: 'safe' } } });
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xsafesig' });
    expect(env.state.safe.sessions).toEqual([
      {
        safeIndex: SAFE_INDEX,
        request: { method: 'personal_sign', params: [MESSAGE, SAFE] },
        display: { kind: 'message', site: KEY_A, method: 'personal_sign' },
        requester: { origin: KEY_A, webContentsId: page.guest.id },
        owner: 'main',
      },
    ]);
    expect(env.state.safe.completed).toEqual([[SAFE_INDEX, 'session-1']]);
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'safe-message' })]);
    expect(env.signer.signMessage).not.toHaveBeenCalled();
  });

  test("a device owner's signature: the board as a second prompt, completed by main on its approval", async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    env.state.safe.complete = false;
    const page = env.tab();
    const answer = page.ask('eth_signTypedData_v4', [SAFE, TYPED]);
    await flush();
    // page:decide answers once the request is answered, after the board.
    const signed = env.decide(env.lastPrompt().handle, true, {});
    await flush();
    const board = env.lastPrompt();
    expect(board).toMatchObject({
      kind: 'eth.safe_message',
      view: { safeIndex: SAFE_INDEX, state: { token: 'session-1', complete: false } },
    });
    expect(env.state.safe.completed).toEqual([]);
    await env.decide(board.handle, true, {});
    expect(await answer).toEqual({ result: '0xsafesig' });
    expect(env.state.safe.completed).toEqual([[SAFE_INDEX, 'session-1']]);
    expect(env.state.safe.cancelled).toEqual([]);
    expect(await signed).toEqual({ ok: true });
  });

  test('a board the user closes cancels the session, and answers 4001', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    env.state.safe.complete = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    await env.decide(env.lastPrompt().handle, false);
    expect(await answer).toEqual(REJECTED);
    expect(env.state.safe.cancelled).toEqual([[SAFE_INDEX, 'session-1']]);
    expect(env.state.safe.completed).toEqual([]);
  });

  test('a document that navigates while its board is open: the session is cancelled, nothing completed', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    env.state.safe.complete = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    await flush();
    expect(env.state.safe.cancelled).toEqual([[SAFE_INDEX, 'session-1']]);
    expect(env.state.safe.completed).toEqual([]);
  });

  test("the site's rule opens the session with no prompt, and a 32-byte message still prompts", async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX, { autoApprove: { signing: true } });
    const page = env.tab();
    expect(await page.ask('eth_signTypedData_v4', [SAFE, TYPED])).toEqual({ result: '0xsafesig' });
    expect(env.prompts()).toEqual([]);
    expect(env.minted()).toEqual([]);
    page.ask('personal_sign', [RAW_HASH, SAFE]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    expect(env.state.safe.sessions).toHaveLength(1);
  });

  test('a name that moves while the board is open gets no signature', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, SAFE_INDEX);
    env.state.safe.complete = false;
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.safe.completed).toEqual([]);
    expect(env.state.safe.cancelled).toEqual([[SAFE_INDEX, 'session-1']]);
  });
});

// The agent's own approval runs inside the request's life, as its connect
// does (PRQ-4): the agent route here is the real AgentWalletController, as
// the agent service calls it, with an approval the test answers.
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
      getSigner: () => env.signer,
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
        },
        request
      );
    return approvals;
  }

  test('it signs under the attested key once approved, holding the document\'s slot', async () => {
    const env = setup();
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

  test("withdrawn at main's deadline: the agent's later approval signs nothing", async () => {
    const env = setup();
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
    const env = setup();
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
    const env = setup();
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

  test('an honest name signs under custody, under its name', async () => {
    const env = setup();
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

// freedom-core #88 and #89, now that main reads the rule: a request the
// core's view warns about, and a personal_sign of exactly 32 bytes, always
// need the user's prompt, rule or not, on any account. The view here is
// main's own `typedDataViewFor`, with the core simulated by ethers.
describe('what the rule never answers: a warned view, and a 32-byte message', () => {
  const { TypedDataEncoder } = require('ethers');
  const {
    normalizeTypedData,
    toCoreTypedData,
    typedDataViewOptions,
    typedDataWarnings,
  } = require('../wallet/signing-utils');
  const { simulatedView } = require('../../../test/helpers/simulated-vault-core');
  const DATA = {
    types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }], Order: [{ name: 'amount', type: 'uint256' }] },
    domain: { chainId: 100 },
    primaryType: 'Order',
    message: { amount: '1' },
  };
  const withData = (changes) => ({ ...DATA, ...changes });

  function coreViewed(env) {
    env.state.typedView = async (typedData, chainId) => {
      const normalized = normalizeTypedData(typedData);
      if (!normalized || typeof normalized !== 'object') throw new Error('Typed data is required');
      const data = toCoreTypedData(normalized);
      const view = simulatedView(data, typedDataViewOptions(normalized, chainId));
      return { hash: TypedDataEncoder.hash(data.domain, data.types, data.message), view, warnings: typedDataWarnings(view) };
    };
  }
  const DATA_HASH = TypedDataEncoder.hash(DATA.domain, { Order: DATA.types.Order }, DATA.message);

  test.each([
    ['another primary type', withData({ primaryType: 'Other' }), 100],
    ['a primary type that is no string', withData({ primaryType: true }), 100],
    ['a false primary type', withData({ primaryType: false }), 100],
    ['a null primary type', withData({ primaryType: null }), 100],
    ['another chain than the page reads', DATA, 1],
    ['no chain', withData({ domain: { name: 'App' } }), 100],
  ])('typed data naming %s prompts under the rule', async (_label, data, chainId) => {
    const env = setup();
    coreViewed(env);
    env.state.selected.set(1, chainId);
    env.connect(KEY_A, 0, { autoApprove: { signing: true } });
    const page = env.tab();
    page.ask('eth_signTypedData_v4', [ACCOUNT, data]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    expect(env.lastPrompt().view.typedData.warnings.length).toBeGreaterThan(0);
    expect(env.state.signed).toEqual([]);
  });

  test("unwarned typed data is answered by the rule, signed as the core's hash", async () => {
    const env = setup();
    coreViewed(env);
    env.connect(KEY_A, 0, { autoApprove: { signing: true } });
    const page = env.tab();
    const { primaryType: _dropped, ...noPrimaryType } = DATA;
    expect(await page.ask('eth_signTypedData_v4', [ACCOUNT, DATA])).toEqual({ result: '0xtypedsig' });
    expect(await page.ask('eth_signTypedData_v4', [ACCOUNT, noPrimaryType])).toEqual({ result: '0xtypedsig' });
    expect(await page.ask('eth_signTypedData_v4', [ACCOUNT, JSON.stringify(DATA)])).toEqual({ result: '0xtypedsig' });
    expect(env.prompts()).toEqual([]);
    expect(env.state.signed.map(([, , options]) => options)).toEqual([
      { expectedHash: DATA_HASH },
      { expectedHash: DATA_HASH },
      { expectedHash: DATA_HASH },
    ]);
  });

  test("a Safe's warned typed data prompts; its unwarned typed data opens the session with no prompt", async () => {
    const env = setup();
    coreViewed(env);
    env.connect(KEY_A, SAFE_INDEX, { autoApprove: { signing: true } });
    const page = env.tab();
    page.ask('eth_signTypedData_v4', [SAFE, withData({ domain: { name: 'App', chainId: 1 } })]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    expect(env.state.safe.sessions).toEqual([]);
    await env.decide(env.lastPrompt().handle, false);
    expect(await page.ask('eth_signTypedData_v4', [SAFE, DATA])).toEqual({ result: '0xsafesig' });
    expect(env.state.safe.sessions).toHaveLength(1);
  });

  const RAW_HEX = `0x${'ab'.repeat(32)}`;
  test.each([
    ['as hex', RAW_HEX],
    ['as text', 'x'.repeat(32)],
    ['as multi-byte text', 'é'.repeat(16)],
    ['in uppercase hex', `0x${'AB'.repeat(32)}`],
  ])('a 32-byte message %s prompts under the rule, on any account, and signs when approved', async (_label, message) => {
    for (const walletIndex of [0, 1]) {
      const env = setup();
      env.connect(KEY_A, walletIndex, { autoApprove: { signing: true } });
      const page = env.tab();
      const answer = page.ask('personal_sign', [message, ACCOUNT]);
      await flush();
      expect(env.lastPrompt().view.message.rawHash).toBe(true);
      expect(env.state.signed).toEqual([]);
      await env.decide(env.lastPrompt().handle, true, {});
      expect(await answer).toEqual({ result: '0xmsgsig' });
      expect(env.state.signed).toEqual([['message', message]]);
    }
  });

  test('a message that is no string is never shown, so never signed', async () => {
    const env = setup();
    env.connect(KEY_A, 0, { autoApprove: { signing: true } });
    const page = env.tab();
    expect((await page.ask('personal_sign', [Array.from({ length: 32 }, () => 1), ACCOUNT])).error.code).toBe(-32603);
    expect(env.prompts()).toEqual([]);
    expect(env.state.signed).toEqual([]);
  });

  test.each([
    ['31 bytes of hex', `0x${'ab'.repeat(31)}`],
    ['33 bytes of hex', `0x${'ab'.repeat(33)}`],
    ['31 bytes of text', 'x'.repeat(31)],
    ['33 bytes of text', 'x'.repeat(33)],
    ['32 hex digits (16 bytes)', `0x${'ab'.repeat(16)}`],
    ['64 hex digits without 0x (64 bytes of text)', 'ab'.repeat(32)],
  ])('%s: answered by the rule', async (_label, message) => {
    const env = setup();
    env.connect(KEY_A, 0, { autoApprove: { signing: true } });
    const page = env.tab();
    expect(await page.ask('personal_sign', [message, ACCOUNT])).toEqual({ result: '0xmsgsig' });
    expect(env.prompts()).toEqual([]);
  });
});
