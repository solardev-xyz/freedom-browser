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
const { TypedDataEncoder } = require('ethers');

// The identity core's approval tokens (design 0012, APB-1), simulated
// (test/helpers/simulated-approvals.js): main's issuer mints through it.
const mockApprovals = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({
  vaultBackend: {
    get approval() {
      return mockApprovals.approval;
    },
  },
}));
jest.mock('../identity-manager', () => ({
  ...jest.requireActual('../identity-manager'),
  // The Safe whose address a Safe message's token binds.
  getWalletRecord: (index) => (index === 1000 ? { index, type: 'safe', address: '0x' + '33'.repeat(20) } : null),
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
// The data's EIP-712 hash, which the core binds to its token.
const TYPED_HASH = TypedDataEncoder.hash(TYPED.domain, { Order: TYPED.types.Order }, TYPED.message);
const TYPED_VIEW = { primaryType: 'Order', domain: { chainId: '0x64' }, message: [] };
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const NOT_CONNECTED = { error: { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const CUSTODY = {
  error: { code: 4100, message: 'The origin is not authorized for this operation', data: { reason: 'agent_custody' } },
};
const RULE_GONE = {
  error: { code: -32603, message: "Signing was not confirmed: this request is not covered by the site's auto-approve rules" },
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
    // The core's hash of a device's typed data, when a test holds it.
    hashHold: null,
    hashWaits: 0,
    // A vault signer's own wait before the core signs, when a test holds it.
    addressHold: null,
    // `prepare`: the session's preparation and the vault's state, when a
    // test holds them; `ownersSigned`: each free owner's signature, made
    // past the caller's last check.
    safe: { complete: true, sessions: [], completed: [], cancelled: [], prepare: null, preparing: 0, ownersSigned: 0 },
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
      // As signers.js: a signature no token answers awaits its caller's
      // last check (`beforeSign`) after the signer's own waits (a device's
      // hash of typed data, which a test holds with `hashHold`), right
      // before it signs.
      getSigner: jest.fn((index, authorized) => {
        const device = state.wallets.find((wallet) => wallet.index === index)?.type !== 'mnemonic';
        const last = authorized?.confirmation ? null : authorized?.beforeSign;
        if (!last) return signer;
        // A vault's own wait (its address from the core), when held.
        const vaultWait = async () => {
          if (!device && state.addressHold) await state.addressHold.promise;
        };
        return {
          signMessage: async (message) => {
            await vaultWait();
            await last();
            return signer.signMessage(message);
          },
          signTypedData: async (data, options) => {
            await vaultWait();
            if (device && state.hashHold) {
              state.hashWaits += 1;
              await state.hashHold.promise;
            }
            await last();
            return signer.signTypedData(data, options);
          },
        };
      }),
      // The identity core's `approval.check` (design 0012), simulated from
      // the same state: the grant exposing the account and its signing rule,
      // outside custody, never 32 bytes nor a warned view.
      checkStanding: jest.fn(async (page, request) => {
        const refused = (reason) => ({ covered: false, reason });
        if (page?.agent !== false) return refused('custody');
        const permission = state.permissions.get(page.origin);
        if (permission?.walletIndex !== request.account || permission.autoApprove?.signing !== true) return refused('no_rule');
        if (request.kind === 'message' && signsRawHash(request.payload)) return refused('warning');
        if (request.kind === 'typed_data' && state.typedWarnings.length > 0) return refused('warning');
        return { covered: true, reason: null };
      }),
      setSigningAutoApprove: jest.fn((key, enabled) => {
        state.rules.push([key, enabled]);
        const permission = state.permissions.get(key);
        if (permission) permission.autoApprove = { ...(permission.autoApprove || {}), signing: enabled };
      }),
      startSafeMessage: jest.fn(async (options) => {
        state.safe.sessions.push(options);
        // As safe-messages.js: the request's preparation and the vault's
        // state, then the free owner's signer, which awaits the caller's
        // last check right before it signs.
        if (state.safe.prepare) {
          state.safe.preparing += 1;
          await state.safe.prepare.promise;
        }
        if (options.beforeSign) await options.beforeSign();
        state.safe.ownersSigned += 1;
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
      // The boards main runs in the approvals document (APS-3b), when a test sets them.
      safeBoards: () => state.safeBoards || null,
    },
  };
  return { state, deps, signer };
}

function setup({ dispatchers: custom, approvalsDocument = false, touchId = false } = {}) {
  const guests = new Map();
  const names = new Map();
  const nameHolds = new Map(); // name -> deferred: the next resolution waits for it
  // name -> queue of { promise, resolve, answer }: each next resolution waits
  // for its own, and answers its own key.
  const resolutionQueues = new Map();
  const queueResolution = (name, answer) => {
    const hold = { ...deferred(), answer, started: false };
    if (!resolutionQueues.has(name)) resolutionQueues.set(name, []);
    resolutionQueues.get(name).push(hold);
    return hold;
  };
  const documents = createPageDocuments({
    isPrivateWebContents: () => false,
    isChromeIndexUrl: (url) => url === CHROME_URL,
    isAgentPage: () => false,
    windowIdOf: (contents) => contents.window,
    resolveEnsContent: async (name) => {
      const queued = resolutionQueues.get(name)?.shift();
      if (queued) {
        queued.started = true;
        await queued.promise;
        return { type: 'ok', protocol: 'ipns', decoded: queued.answer };
      }
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
    // With the approvals document on (APS-2): its prompts land in `sent`
    // too, and main unlocks with the password its decision carries.
    approvals: approvalsDocument ? { send: (windowId, channel, payload) => sent.push([windowId, channel, payload]) } : null,
    unlockVault: async (password) => {
      unlockAttempts.push(password);
      if (password !== 'right password') throw new Error('Incorrect password');
      state.unlocked = true;
    },
    touchIdAvailable: async () => touchId,
    unlockWithTouchId: async () => {
      unlockAttempts.push('touch id');
      if (state.touchIdFails) return { success: false, error: 'Touch ID failed' };
      state.unlocked = true;
      return { success: true };
    },
  });
  const unlockAttempts = [];

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
    approvalsDocument
      ? requests.decideInWindow(windowId, { handle, approve, choices })
      : requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
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
    queueResolution,
    prompts,
    lastPrompt,
    decide,
    connect,
    guests,
    expire,
    traced,
    minted,
    unlockAttempts,
  };
}

beforeEach(() => {
  confirmations._reset();
  mockApprovals.reset();
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
    // One token, minted by the core for this approval and handed to the
    // signature, under the page (design 0012), and none left.
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'sign-message' })]);
    expect(env.deps.signing.getSigner).toHaveBeenCalledTimes(1);
    expect(env.deps.signing.getSigner).toHaveBeenCalledWith(0, {
      confirmation: expect.objectContaining({
        kind: 'sign-message',
        account: 0,
        payload: { message: MESSAGE },
        handle: expect.stringMatching(/^[0-9a-f]{64}$/),
        page: expect.objectContaining({ origin: KEY_A, agent: false }),
      }),
    });
    expect(env.traced.filter((entry) => entry.kind === 'token-spent')).toHaveLength(1);
    expect(mockApprovals.outstanding()).toBe(0);
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

  // The core spends a token as the signature presents it (design 0012):
  // here, the simulated core's check of `sign.message`.
  const present = (confirmation, page = confirmation.page) =>
    mockApprovals.authorize('sign.message', 0, { message: MESSAGE }, {
      ...confirmations.signingAuthorization(confirmation),
      page,
    });

  test('no token without an approval of a live record', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await Promise.race([env.decide(env.lastPrompt().handle, false), flush()]);
    await flush();
    const { context, release } = contexts[0];
    // Rejected: nothing to mint on.
    await expect(context.confirm('sign-message', 0, MESSAGE)).rejects.toThrow(/not confirmed/);
    release();
    await answer;
    // An answered record mints nothing either.
    await expect(context.confirm('sign-message', 0, MESSAGE)).rejects.toThrow(/not confirmed/);
    expect(mockApprovals.outstanding()).toBe(0);
    expect(mockApprovals.calls).toEqual([]);
  });

  test("an approval mints one token, of a page kind only, under `page` with the document's PageContext", async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    await expect(context.confirm('wallet-send', 0, { chainId: 100, to: ACCOUNT })).rejects.toThrow(
      /Not a page confirmation kind/
    );
    const confirmation = await context.confirm('sign-message', 0, MESSAGE);
    expect(confirmation.token).toMatch(/^[0-9a-f]{64}$/);
    const pageContext = {
      origin: KEY_A,
      top_origin: KEY_A,
      frame: context.requester.frame,
      navigation: context.requester.navigation,
      agent: false,
    };
    expect(context.pageContext()).toEqual(pageContext);
    expect(mockApprovals.calls).toEqual([
      {
        method: 'approval.issue',
        params: { kind: 'sign-message', account: 0, payload: { message: MESSAGE }, handle: confirmation.handle },
        page: pageContext,
      },
    ]);
    await expect(context.confirm('sign-message', 0, MESSAGE)).rejects.toThrow(/not confirmed/);
    expect(context.spend(confirmation)).toBe(confirmation);
    expect(() => present(confirmation)).not.toThrow();
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
    const tokenA = await a.context.confirm('sign-message', 0, MESSAGE);
    const tokenA2 = await a2.context.confirm('sign-message', 0, MESSAGE);
    await b.context.confirm('sign-message', 0, MESSAGE);
    // Main's own check: another record's confirmation is refused, and burnt.
    expect(() => a2.context.spend(tokenA)).toThrow(/not the confirmation of this request/);
    await flush();
    expect(() => present(tokenA)).toThrow(/unknown_token/);
    // The core's: presented for another document of the same key, or for
    // another key's, refused, and burnt.
    expect(() => present(tokenA2, b.context.pageContext())).toThrow(/mismatch/);
    expect(() => present(tokenA2)).toThrow(/unknown_token/);
    const again = await b.context.confirm('sign-message', 0, MESSAGE).catch(() => null);
    expect(again).toBeNull();
    for (const { release } of contexts) release();
  });

  test('a token whose document navigated is refused, and burnt', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    const confirmation = await context.confirm('sign-message', 0, MESSAGE);
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    expect(() => context.spend(confirmation)).toThrow(/the document that asked has gone/);
    await flush();
    expect(mockApprovals.outstanding()).toBe(0);
    release();
  });

  test('a token spent twice: the second is refused', async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    const confirmation = await context.confirm('sign-message', 0, MESSAGE);
    context.spend(confirmation);
    // Refused, and burnt: the signature it was handed to gets nothing.
    expect(() => context.spend(confirmation)).toThrow(/not confirmed/);
    await flush();
    expect(() => present(confirmation)).toThrow(/unknown_token/);
    release();
    await answer;
  });

  test("a page token never signs as main's own, and main mints no page kind for itself", async () => {
    const { env, contexts } = withContexts();
    const page = env.tab();
    const { context, answer, release } = await approved(env, contexts, page);
    const confirmation = await context.confirm('sign-message', 0, MESSAGE);
    expect(() => present({ ...confirmation, handle: undefined }, null)).toThrow(/mismatch/);
    await expect(confirmations.issueConfirmation('sign-message', 0, MESSAGE)).rejects.toThrow(/issued for its page/);
    release();
    await answer;
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
    // A page's signature, never main's own: under its PageContext, as the
    // site's rule (`{ standing }`), the typed data's view on the page's chain
    // (design 0012).
    const pageContext = expect.objectContaining({ origin: KEY_A, top_origin: KEY_A, agent: false });
    // With the dispatcher's last check, which a vault's signer leaves to the
    // core (`signers.js`).
    expect(env.deps.signing.getSigner.mock.calls).toEqual([
      [0, { page: pageContext, standing: {}, chainId: 100, beforeSign: expect.any(Function) }],
      [0, { page: pageContext, standing: {}, chainId: 100, beforeSign: expect.any(Function) }],
    ]);
    // The core chose each (`approval.check`), and read it again just before
    // the signer is called and as the signer's last check: what the request
    // signs, for the account the grant exposes, on the page's chain.
    const message = [KEY_A, { kind: 'message', account: 0, accountType: 'mnemonic', payload: MESSAGE, chainId: 100 }];
    const typed = [KEY_A, { kind: 'typed_data', account: 0, accountType: 'mnemonic', payload: TYPED, chainId: 100 }];
    expect(env.deps.signing.checkStanding.mock.calls.map(([context, request]) => [context.origin, request])).toEqual([
      message,
      message,
      message,
      typed,
      typed,
      typed,
    ]);
  });

  test("a rule the core doesn't hold sends the request to its prompt; one it refuses at the signature answers as before", async () => {
    const env = setup();
    ruled(env);
    const page = env.tab();
    // The core reads no rule (its file, its account): the prompt.
    env.deps.signing.checkStanding.mockImplementationOnce(async () => ({ covered: false, reason: 'no_rule' }));
    const prompted = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    await env.decide(env.lastPrompt().handle, false);
    expect(await prompted).toEqual(REJECTED);
    // A check that fails reads as not covered.
    env.deps.signing.checkStanding.mockImplementationOnce(async () => {
      throw new Error('core gone');
    });
    const failed = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    await env.decide(env.lastPrompt().handle, false);
    expect(await failed).toEqual(REJECTED);
    // The core refuses the signature itself under `{ standing }`.
    const refusing = (reason) =>
      env.signer.signMessage.mockImplementationOnce(async () => {
        const { confirmationError } = require('../wallet/signing-confirmation');
        throw confirmationError(Object.assign(new Error('refused'), { code: 'not_authorized', data: { reason } }));
      });
    refusing('custody');
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(CUSTODY);
    refusing('no_rule');
    expect(await page.ask('personal_sign', [MESSAGE, ACCOUNT])).toEqual(RULE_GONE);
    expect(env.state.signed).toEqual([]);
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

  // A signature can wait (a Ledger, the phone bridge): what main writes
  // under the name after it, it writes only once the name answers again.
  const heldSignature = (env) => {
    const device = deferred();
    env.signer.signMessage.mockImplementationOnce(async (message) => {
      await device.promise;
      env.state.signed.push(['message', message]);
      return '0xheldsig';
    });
    return device;
  };

  test('moved while an approved signature waits on its device: no "always allow" rule, no last use, no signature to the page', async () => {
    const { env, page } = named();
    const device = heldSignature(env);
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    await flush();
    expect(env.signer.signMessage).toHaveBeenCalledTimes(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    device.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.rules).toEqual([]);
    expect(env.deps.signing.setSigningAutoApprove).not.toHaveBeenCalled();
    expect(env.state.lastUsed).toEqual([]);
    expect(env.state.permissions.get(NAME).autoApprove).toBeUndefined();
  });

  test("moved while a rule-answered signature waits on its device: the name's last use untouched, no signature to the page", async () => {
    const { env, page } = named({ rule: true });
    const device = heldSignature(env);
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.signer.signMessage).toHaveBeenCalledTimes(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    device.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.lastUsed).toEqual([]);
    expect(env.deps.updateLastUsed).not.toHaveBeenCalled();
  });

  test('an honest name after a waiting signature: the rule and the last use written, under the name', async () => {
    const { env, page } = named();
    const device = heldSignature(env);
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    await flush();
    device.resolve();
    expect(await answer).toEqual({ result: '0xheldsig' });
    expect(env.state.rules).toEqual([[NAME, true]]);
    const ruled = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    expect(await ruled).toEqual({ result: '0xmsgsig' });
    expect(env.state.lastUsed).toEqual([[NAME]]);
  });

  test('moved while an approved signature waits on its device, with no "always allow": no signature to the page', async () => {
    const { env, page } = named();
    const device = heldSignature(env);
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    env.decide(env.lastPrompt().handle, true, { alwaysAllow: false });
    await flush();
    expect(env.signer.signMessage).toHaveBeenCalledTimes(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    device.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.rules).toEqual([]);
    expect(env.state.lastUsed).toEqual([]);
  });

  // A losing name check of another request of the same document, queued so
  // it resolves at every point around the post-signature check: whenever a
  // grant write happens, the document still holds the name at that moment.
  // The guard runs the write in the same run as its last check, so no check
  // can end the binding between them.
  const keyOf = (env, page) => env.documents.liveDocuments().find((doc) => doc.guest === page.guest.id)?.key ?? null;
  const ticks = async (n) => {
    for (let i = 0; i < n; i += 1) await Promise.resolve();
  };

  test.each([...Array(16).keys()])(
    'a losing concurrent name check %i ticks after the post-signature check resolves never lands between the check and the rule write',
    async (offset) => {
      const { env, page } = named();
      const writes = [];
      env.deps.signing.setSigningAutoApprove.mockImplementation((key, enabled) => writes.push([key, enabled, keyOf(env, page)]));
      const device = heldSignature(env);
      const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
      await flush();
      env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
      await flush();
      // The other request's check: it will find the name moved.
      const loser = env.queueResolution(NAME, OTHER_IPNS_KEY);
      const accounts = page.ask('eth_accounts');
      await flush();
      expect(loser.started).toBe(true);
      // The signature's post-wait check: the name still answers when asked.
      const guard = env.queueResolution(NAME, IPNS_KEY);
      device.resolve();
      await flush();
      expect(guard.started).toBe(true);
      guard.resolve();
      await ticks(offset);
      loser.resolve();
      const answered = await answer;
      await accounts;
      for (const [, , key] of writes) expect(key).toBe(NAME);
      // The signature, if the name still held when main answered (after the
      // rule's write), or the keyless answer.
      expect([{ result: '0xheldsig' }, NO_ADDRESS]).toContainEqual(answered);
      if (answered.result) expect(writes).toHaveLength(1);
    }
  );

  test.each([...Array(16).keys()])(
    "a losing concurrent name check %i ticks after the rule path's post-signature check resolves never lands between the check and the last-use write",
    async (offset) => {
      const { env, page } = named({ rule: true });
      const writes = [];
      env.deps.updateLastUsed.mockImplementation((key) => writes.push([key, keyOf(env, page)]));
      const device = heldSignature(env);
      const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
      await flush();
      const loser = env.queueResolution(NAME, OTHER_IPNS_KEY);
      const accounts = page.ask('eth_accounts');
      await flush();
      const guard = env.queueResolution(NAME, IPNS_KEY);
      device.resolve();
      await flush();
      expect(guard.started).toBe(true);
      guard.resolve();
      await ticks(offset);
      loser.resolve();
      await answer;
      await accounts;
      for (const [, key] of writes) expect(key).toBe(NAME);
    }
  );

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

// The last wait before a rule's signature is the core's own reading of the
// rule, after the name's: a Ledger, a phone and a Safe present no
// `{ standing }` the core could judge again as they sign, so a rule revoked
// while the name resolved is seen there, before the device is asked.
describe('a rule revoked while the name resolves just before the effect', () => {
  const PHONE = '0x4444444444444444444444444444444444444444';
  const PHONE_INDEX = 2000;

  // The site's signing rule over a DNS name, and the name's resolution just
  // before the effect held: the one after the vault's check, the last wait
  // but the core's reading. `held` resolves once it waits.
  function heldAtTheEffect(walletIndex) {
    const env = setup();
    env.state.wallets.push({ index: PHONE_INDEX, name: 'Phone', address: PHONE, type: 'remote' });
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, walletIndex, { autoApprove: { signing: true } });
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const hold = deferred();
    const held = deferred();
    env.state.unlocked = () => {
      env.state.unlocked = true;
      env.nameHolds.set(NAME, hold);
      held.resolve();
      return true;
    };
    return { env, page, hold, held };
  }

  const ask = (page, method, address) =>
    page.ask(method, method === 'personal_sign' ? [MESSAGE, address] : [address, TYPED]);

  test.each([
    ['a Ledger', 1, LEDGER, 'personal_sign'],
    ['a Ledger', 1, LEDGER, 'eth_signTypedData_v4'],
    ['a phone', PHONE_INDEX, PHONE, 'personal_sign'],
    ['a phone', PHONE_INDEX, PHONE, 'eth_signTypedData_v4'],
    ['a Safe', SAFE_INDEX, SAFE, 'personal_sign'],
    ['the vault', 0, ACCOUNT, 'personal_sign'],
  ])('%s: refused, nothing signed (%s)', async (_label, walletIndex, address, method) => {
    const { env, page, hold, held } = heldAtTheEffect(walletIndex);
    const answer = ask(page, method, address);
    await held.promise;
    await flush();
    // The choice's reading only, so far.
    expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(1);
    env.state.permissions.get(NAME).autoApprove = { signing: false };
    hold.resolve();
    expect(await answer).toEqual(RULE_GONE);
    // The core read the rule again after the name, and refused.
    expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(2);
    await expect(env.deps.signing.checkStanding.mock.results[1].value).resolves.toEqual({ covered: false, reason: 'no_rule' });
    expect(env.deps.signing.getSigner).not.toHaveBeenCalled();
    expect(env.signer.signMessage).not.toHaveBeenCalled();
    expect(env.signer.signTypedData).not.toHaveBeenCalled();
    expect(env.state.safe.sessions).toEqual([]);
    expect(env.state.signed).toEqual([]);
    expect(env.state.lastUsed).toEqual([]);
  });

  test('a rule that holds through the name: the Ledger signs', async () => {
    const { env, page, hold, held } = heldAtTheEffect(1);
    const answer = ask(page, 'personal_sign', LEDGER);
    await held.promise;
    await flush();
    hold.resolve();
    expect(await answer).toEqual({ result: '0xmsgsig' });
    expect(env.state.signed).toEqual([['message', MESSAGE]]);
  });

  test("the vault's signature still goes with `{ standing }` past that reading, and the core's refusal there stands", async () => {
    const { env, page, hold, held } = heldAtTheEffect(0);
    const answer = ask(page, 'personal_sign', ACCOUNT);
    await held.promise;
    await flush();
    // The rule holds through the name; the core judges it again as it signs.
    env.signer.signMessage.mockImplementationOnce(async () => {
      const { confirmationError } = require('../wallet/signing-confirmation');
      throw confirmationError(Object.assign(new Error('refused'), { code: 'not_authorized', data: { reason: 'no_rule' } }));
    });
    hold.resolve();
    expect(await answer).toEqual(RULE_GONE);
    expect(env.deps.signing.getSigner).toHaveBeenCalledWith(0, {
      page: expect.objectContaining({ origin: NAME, agent: false }),
      standing: {},
      chainId: 100,
      beforeSign: expect.any(Function),
    });
    expect(env.state.signed).toEqual([]);
  });
});

// A device's typed data waits once more inside its signer, on the core's
// hash, and a Safe's message on its preparation and the vault's state: the
// core's reading of the rule, and custody, are the signer's last check,
// right before each signature (`beforeSign`), so neither wait lets a rule
// revoked or a tab taken into custody reach a signer.
describe('a rule revoked or custody entered while a signer waits, just before its signature', () => {
  const PHONE = '0x4444444444444444444444444444444444444444';
  const PHONE_INDEX = 2000;

  function ruledTab(walletIndex) {
    const env = setup();
    env.state.wallets.push({ index: PHONE_INDEX, name: 'Phone', address: PHONE, type: 'remote' });
    env.connect(KEY_A, walletIndex, { autoApprove: { signing: true } });
    return { env, page: env.tab() };
  }
  const change = (env, page, what) => {
    if (what === 'custody entered') env.state.custody.add(page.guest.id);
    else env.state.permissions.get(KEY_A).autoApprove = { signing: false };
  };

  test.each([
    ['a Ledger', 1, LEDGER, 'the rule revoked', RULE_GONE],
    ['a Ledger', 1, LEDGER, 'custody entered', CUSTODY],
    ['a phone', PHONE_INDEX, PHONE, 'the rule revoked', RULE_GONE],
    ['a phone', PHONE_INDEX, PHONE, 'custody entered', CUSTODY],
  ])("%s's typed data, %s while the core hashes it: refused, the device never asked", async (_label, walletIndex, address, what, refused) => {
    const { env, page } = ruledTab(walletIndex);
    env.state.hashHold = deferred();
    const answer = page.ask('eth_signTypedData_v4', [address, TYPED]);
    await flush();
    // Past the choice and the dispatcher's own last reading, in the signer.
    expect(env.state.hashWaits).toBe(1);
    expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(2);
    change(env, page, what);
    env.state.hashHold.resolve();
    expect(await answer).toEqual(refused);
    expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(3);
    expect(env.signer.signTypedData).not.toHaveBeenCalled();
    expect(env.state.signed).toEqual([]);
    expect(env.state.lastUsed).toEqual([]);
  });

  test('a rule that holds through the hash: the Ledger and the phone sign', async () => {
    for (const [walletIndex, address] of [
      [1, LEDGER],
      [PHONE_INDEX, PHONE],
    ]) {
      const { env, page } = ruledTab(walletIndex);
      env.state.hashHold = deferred();
      const answer = page.ask('eth_signTypedData_v4', [address, TYPED]);
      await flush();
      env.state.hashHold.resolve();
      expect(await answer).toEqual({ result: '0xtypedsig' });
      expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(3);
      expect(env.state.signed).toEqual([['typed', TYPED, { expectedHash: TYPED_HASH }]]);
    }
  });

  test.each([
    ['the rule revoked', RULE_GONE],
    ['custody entered', CUSTODY],
  ])("a Safe's message, %s while its session prepares: refused, no owner signs", async (what, refused) => {
    const { env, page } = ruledTab(SAFE_INDEX);
    env.state.safe.prepare = deferred();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    expect(env.state.safe.preparing).toBe(1);
    expect(env.state.safe.sessions[0].beforeSign).toEqual(expect.any(Function));
    change(env, page, what);
    env.state.safe.prepare.resolve();
    expect(await answer).toEqual(refused);
    expect(env.state.safe.ownersSigned).toBe(0);
    expect(env.state.safe.completed).toEqual([]);
    expect(env.prompts()).toEqual([]);
    expect(env.state.lastUsed).toEqual([]);
  });

  test.each([
    ['the rule revoked', RULE_GONE],
    ['custody entered', CUSTODY],
  ])("the vault's signature, %s while its signer waits: refused, the core never asked to sign", async (what, refused) => {
    const { env, page } = ruledTab(0);
    env.state.addressHold = deferred();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(2);
    change(env, page, what);
    env.state.addressHold.resolve();
    expect(await answer).toEqual(refused);
    expect(env.deps.signing.checkStanding).toHaveBeenCalledTimes(3);
    expect(env.signer.signMessage).not.toHaveBeenCalled();
    expect(env.state.signed).toEqual([]);
  });

  test("a rule that holds through the Safe's preparation: its owner signs, and the page gets the signature", async () => {
    const { env, page } = ruledTab(SAFE_INDEX);
    env.state.safe.prepare = deferred();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    env.state.safe.prepare.resolve();
    expect(await answer).toEqual({ result: '0xsafesig' });
    expect(env.state.safe.ownersSigned).toBe(1);
    expect(env.state.safe.completed).toHaveLength(1);
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

// With the approvals document on (freedom-core design 0011, APS-2), the
// document has no unlock of its own in the signing screen: a vault
// account's prompt asks for the vault unlocked first, on main's own
// prompt, and main unlocks with the password its decision carries.
describe('with the approvals document on (0011 APS-2)', () => {
  test('a locked vault: the unlock first, a wrong password asked again, then the signature\'s prompt', async () => {
    const env = setup({ approvalsDocument: true });
    env.connect();
    env.state.unlocked = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt()).toMatchObject({
      kind: 'vault.unlock',
      view: { account: { index: 0, address: ACCOUNT, type: 'mnemonic' }, reason: 'sign' },
    });
    // No password, or another key: refused, the prompt stays.
    expect(await env.decide(env.lastPrompt().handle, true, {})).toEqual({ ok: false, reason: 'invalid' });
    expect(await env.decide(env.lastPrompt().handle, true, { password: 'x', site: 'y' })).toEqual({ ok: false, reason: 'invalid' });
    const first = env.lastPrompt().handle;
    env.decide(first, true, { password: 'wrong' });
    await flush();
    expect(env.lastPrompt()).toMatchObject({ kind: 'vault.unlock', view: { reason: 'sign', failed: true } });
    expect(env.lastPrompt().handle).not.toBe(first);
    env.decide(env.lastPrompt().handle, true, { password: 'right password' });
    await flush();
    expect(env.unlockAttempts).toEqual(['wrong', 'right password']);
    expect(env.lastPrompt()).toMatchObject({ kind: 'eth.sign', view: { method: 'personal_sign' } });
    expect(env.minted()).toEqual([]);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xmsgsig' });
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'sign-message' })]);
  });

  test('a rejected unlock signs nothing; an unlocked vault, or a Ledger account, asks for none', async () => {
    const env = setup({ approvalsDocument: true });
    env.connect();
    env.state.unlocked = false;
    const page = env.tab();
    const rejected = page.ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    await env.decide(env.lastPrompt().handle, false, {});
    expect(await rejected).toEqual({ error: { code: 4001, message: 'User cancelled unlock' } });
    expect(env.state.signed).toEqual([]);

    const ledger = setup({ approvalsDocument: true });
    ledger.connect(KEY_A, 1);
    ledger.state.unlocked = false;
    ledger.tab().ask('personal_sign', [MESSAGE, LEDGER]);
    await flush();
    expect(ledger.prompts().map((p) => p.kind)).toEqual(['eth.sign']);

    const open = setup({ approvalsDocument: true });
    open.connect();
    open.tab().ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(open.prompts().map((p) => p.kind)).toEqual(['eth.sign']);
  });

  // Codex on #1208: a password lives no longer than its own attempt. The
  // decision's invocation is answered once the attempt is done, not when
  // the request is, and nothing main keeps (the prompt's decision, the
  // record, the trace, a pending invocation) holds the decision's payload.
  test('a password is held only for its own attempt: wrong ones don\'t pile up, and none outlives the unlock', async () => {
    const v8 = require('v8');
    const vm = require('vm');
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc');
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const collected = async (refs) => {
      for (let i = 0; i < 5; i += 1) {
        await tick();
        gc();
      }
      return refs.map((ref) => ref.deref() === undefined);
    };

    const env = setup({ approvalsDocument: true });
    env.connect();
    env.state.unlocked = false;
    const page = env.tab();
    let settled = false;
    const answer = page.ask('personal_sign', [MESSAGE, ACCOUNT]).then((value) => {
      settled = true;
      return value;
    });
    await flush();
    // Each attempt's payload is made here and only weakly kept by the test.
    const attempt = (password) => {
      const payload = { handle: env.lastPrompt().handle, approve: true, choices: { password } };
      return { refs: [new WeakRef(payload), new WeakRef(payload.choices)], answered: env.requests.decideInWindow(1, payload) };
    };
    const wrong = [];
    for (const password of ['wrong one', 'wrong two', 'wrong three']) {
      const { refs, answered } = attempt(password);
      // Answered once the attempt is done, with the request still open.
      expect(await answered).toEqual({ ok: true });
      expect(settled).toBe(false);
      await flush();
      expect(env.lastPrompt()).toMatchObject({ kind: 'vault.unlock', view: { failed: true } });
      wrong.push(...refs);
    }
    expect(await collected(wrong)).toEqual(wrong.map(() => true));

    const right = attempt('right password');
    expect(await right.answered).toEqual({ ok: true });
    await flush();
    // The signature's prompt waits, the request still open; the unlock's
    // payload is gone all the same.
    expect(env.lastPrompt().kind).toBe('eth.sign');
    expect(settled).toBe(false);
    expect(await collected(right.refs)).toEqual([true, true]);
    const kept = JSON.stringify([env.traced, env.requests.promptState(), env.sent]);
    for (const password of ['wrong one', 'wrong two', 'wrong three', 'right password']) expect(kept).not.toContain(password);
    expect(env.unlockAttempts).toEqual(['wrong one', 'wrong two', 'wrong three', 'right password']);

    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xmsgsig' });
  });

  // APS-3: Touch ID in the panel, run by main, where main offers it.
  test('Touch ID: offered only where main can use it, run by main, a failure asked again', async () => {
    const env = setup({ approvalsDocument: true, touchId: true });
    env.connect();
    env.state.unlocked = false;
    env.state.touchIdFails = true;
    const answer = env.tab().ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.lastPrompt()).toMatchObject({ kind: 'vault.unlock', view: { reason: 'sign', touchId: true } });
    env.decide(env.lastPrompt().handle, true, { touchId: true });
    await flush();
    expect(env.lastPrompt()).toMatchObject({ kind: 'vault.unlock', view: { touchId: true, failed: true } });
    env.state.touchIdFails = false;
    env.decide(env.lastPrompt().handle, true, { touchId: true });
    await flush();
    expect(env.unlockAttempts).toEqual(['touch id', 'touch id']);
    expect(env.lastPrompt().kind).toBe('eth.sign');
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: '0xmsgsig' });

    // Not offered: a Touch ID decision is no decision.
    const plain = setup({ approvalsDocument: true });
    plain.connect();
    plain.state.unlocked = false;
    plain.tab().ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(plain.lastPrompt().view.touchId).toBeUndefined();
    expect(await plain.decide(plain.lastPrompt().handle, true, { touchId: true })).toEqual({ ok: false, reason: 'invalid' });
    expect(plain.unlockAttempts).toEqual([]);
  });

  test('the document off: no unlock first, as the chrome\'s screen unlocks in place', async () => {
    const env = setup();
    env.connect();
    env.state.unlocked = false;
    env.tab().ask('personal_sign', [MESSAGE, ACCOUNT]);
    await flush();
    expect(env.prompts().map((p) => p.kind)).toEqual(['eth.sign']);
  });
});

describe('APS-3b: with the approvals document on, main runs the Safe message\'s board in the panel', () => {
  const { createSafeBoards } = require('../approvals/safe-boards');

  // A 2-of-2 Safe's session: the vault owner signed as it opened; a Ledger
  // owner still to sign. Its token is main's.
  function withBoards(env) {
    const board = { signed: new Set([0]), signs: [] };
    env.state.safeBoards = createSafeBoards({
      getDerivedWallets: async () => env.state.wallets,
      messages: {
        state: (safeIndex, token) =>
          token === 'session-1'
            ? {
                safeIndex,
                kind: 'message',
                token,
                threshold: 2,
                collected: board.signed.size,
                owners: [
                  { index: 0, address: ACCOUNT, type: 'mnemonic', signed: board.signed.has(0) },
                  { index: 5, address: LEDGER, type: 'ledger', signed: board.signed.has(5) },
                ],
                display: { kind: 'message', site: KEY_A, method: 'personal_sign' },
                complete: board.signed.size >= 2,
              }
            : null,
        sign: async (safeIndex, owner, token) => {
          board.signs.push([owner, token]);
          if (owner !== undefined) board.signed.add(owner);
        },
      },
      sends: {},
    });
    return board;
  }

  test('the board shows in the document, without the session\'s token; the owner picked signs; main completes it', async () => {
    const env = setup({ approvalsDocument: true });
    const board = withBoards(env);
    env.connect(KEY_A, SAFE_INDEX);
    env.state.safe.complete = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    const shown = env.lastPrompt();
    expect(shown.kind).toBe('eth.safe_message');
    expect(shown.view).toMatchObject({ safe: { index: SAFE_INDEX }, threshold: 2, collected: 1, method: 'personal_sign', step: 'collect' });
    expect(JSON.stringify(shown)).not.toContain('session-1');
    expect(await env.requests.decide({ sender: { id: 501 } }, { handle: shown.handle, approve: true, choices: { action: 'sign', owner: 5 } })).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    expect(env.state.safe.completed).toEqual([]);
    const signed = env.decide(shown.handle, true, { action: 'sign', owner: 5 });
    expect(await answer).toEqual({ result: '0xsafesig' });
    expect(await signed).toEqual({ ok: true });
    expect(board.signs).toEqual([
      [undefined, 'session-1'],
      [5, 'session-1'],
    ]);
    expect(env.state.safe.completed).toEqual([[SAFE_INDEX, 'session-1']]);
    expect(env.state.safe.cancelled).toEqual([]);
    // The one token is the Safe message's own.
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'safe-message' })]);
  });

  test('Reject in the panel cancels the session, and answers 4001', async () => {
    const env = setup({ approvalsDocument: true });
    withBoards(env);
    env.connect(KEY_A, SAFE_INDEX);
    env.state.safe.complete = false;
    const page = env.tab();
    const answer = page.ask('personal_sign', [MESSAGE, SAFE]);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    env.decide(env.lastPrompt().handle, false);
    expect(await answer).toEqual(REJECTED);
    expect(env.state.safe.cancelled).toEqual([[SAFE_INDEX, 'session-1']]);
    expect(env.state.safe.completed).toEqual([]);
  });

  test('a document that navigates while the board shows: the session is cancelled, nothing completed', async () => {
    const env = setup({ approvalsDocument: true });
    withBoards(env);
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
});
