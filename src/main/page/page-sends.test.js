// Sends through main (freedom-core design 0011, PRQ-5b): eth_sendTransaction,
// from every account kind, a Safe account's included. Main reads the site's
// contract rule itself, with Agent custody read live and the fee check's
// verdict; otherwise it prompts with its own view, judges the fee again at
// the press, and its own issuer mints the dapp-send token (or a safe-send
// for the site), bound to the prompt's handle and the requester's key, spent
// in the same run as the last checks. After the signer's wait, the name and
// the document are checked again before the signed bytes are recorded or
// sent, and every write under the key after a send is made by the guard that
// resolves the name again.

const { EventEmitter } = require('events');
const { createPageDocuments } = require('./page-documents');
const { createPageRequests, GONE } = require('./page-requests');
const { createEthereumDispatchers } = require('./page-ethereum');
const { txOf } = require('./page-sends');
const { AgentWalletController } = require('../agent/agent-wallet-controller');
const confirmations = require('../wallet/signing-confirmation');

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
  // The Safe whose address a safe-send token binds.
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
const PHONE = '0x4444444444444444444444444444444444444444';
const SAFE_INDEX = 1000;
const LEDGER_INDEX = 1;
const PHONE_INDEX = 2000;
const CONTRACT = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CONTRACT_CHECKSUMMED = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SELECTOR = '0x095ea7b3';
const DATA = `${SELECTOR}${'00'.repeat(64)}`;
const CALL = { to: CONTRACT, value: '0x0', data: DATA };
const TRANSFER = { to: ACCOUNT, value: '0x2386f26fc10000' };
const HASH = `0x${'ab'.repeat(32)}`;
const PHONE_HASH = `0x${'cd'.repeat(32)}`;
const SAFE_TX_HASH = `0x${'ef'.repeat(32)}`;
const EXEC_HASH = `0x${'12'.repeat(32)}`;
const PASSING = Object.freeze({
  maxCost: '60000000000000',
  comparable: true,
  ratio: '1',
  above: false,
  oneEndpoint: false,
  basis: 'quote',
  autoApprove: true,
});
const ABOVE = Object.freeze({ ...PASSING, ratio: '20', above: true, autoApprove: false });
const NO_ADDRESS = { error: { code: 4100, message: 'This page has no address to connect from yet' } };
const NOT_CONNECTED = { error: { code: 4100, message: 'Not connected. Call eth_requestAccounts first.' } };
const REJECTED = { error: { code: 4001, message: 'User rejected the request' } };
const PENDING = { error: { code: -32002, message: 'Another wallet request is already pending' } };
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
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
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

function backends() {
  const state = {
    enabled: true,
    permissions: new Map(),
    wallets: [
      { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
      { index: LEDGER_INDEX, name: 'Ledger', address: LEDGER, type: 'ledger' },
      { index: PHONE_INDEX, name: 'Phone', address: PHONE, type: 'remote' },
      { index: SAFE_INDEX, name: 'Team Safe', address: SAFE, type: 'safe', deployed: { 100: { block: 1 } } },
    ],
    selected: new Map(),
    networks: { 1: { name: 'Ethereum', nativeSymbol: 'ETH' }, 100: { name: 'Gnosis Chain', nativeSymbol: 'xDAI' } },
    lastUsed: [],
    custody: new Set(),
    unlocked: true,
    agent: null,
    // The site's contract rules: [key, to, selector, chainId, value].
    txRules: [],
    paused: false,
    quoteFails: false,
    prices: { type: 'legacy', gasPrice: '1000000000', effectiveGasPrice: '1000000000' },
    verdict: PASSING,
    // The fee at the press, when it differs from the one shown.
    atPress: null,
    // What signAndRecord was asked, and what reached the records.
    records: [],
    committed: [],
    sendFails: null,
    // Held at the device (a Ledger or the core's signature), before the
    // commit; and a phone's own send, which signs and broadcasts at once.
    signerHold: null,
    phoneHold: null,
    turns: [],
    paymentWaiting: false,
    turnBusy: false,
    safe: { started: [], listeners: new Set(), guards: new Map() },
  };
  const signer = { signTransaction: jest.fn() };
  const phoneSigner = { sendTransaction: jest.fn() };
  const settle = (event) => {
    for (const listener of [...state.safe.listeners]) listener(event);
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
    sends: {
      inCustody: (guestId) => state.custody.has(guestId),
      isVaultUnlocked: async () => (typeof state.unlocked === 'function' ? state.unlocked() : state.unlocked),
      ruleMatches: jest.fn((key, to, selector, chainId, value) =>
        state.txRules.some(
          (rule) =>
            rule[0] === key &&
            rule[1] === to.toLowerCase() &&
            rule[2] === selector &&
            rule[3] === chainId &&
            BigInt(value) <= BigInt(rule[4])
        )
      ),
      rulePaused: jest.fn(async () => state.paused),
      addTransactionAutoApprove: jest.fn((key, to, selector, chainId, value) => {
        state.txRules.push([key, to.toLowerCase(), selector, chainId, value]);
      }),
      estimateGas: jest.fn(async () => {
        if (state.quoteFails) throw new Error('Gas estimation failed: execution reverted');
        return { gasLimit: '60000' };
      }),
      getGasPrices: jest.fn(async () => state.prices),
      checkFees: jest.fn(async () => ({ ...state.verdict })),
      checkAtApproval: jest.fn(async (_tx, { acknowledged } = {}) => {
        const verdict = state.atPress || state.verdict;
        return { ...verdict, askAgain: verdict.above === true && acknowledged !== true };
      }),
      getSigner: jest.fn((index) => (index === PHONE_INDEX ? phoneSigner : signer)),
      signAndRecord: jest.fn(async (tx, chosen, context, options) => {
        state.records.push({ tx, context, walletIndex: options.walletIndex });
        if (state.sendFails) throw state.sendFails;
        if (typeof chosen.sendTransaction === 'function') {
          // A phone: it signs and broadcasts in one step.
          if (state.phoneHold) await state.phoneHold.promise;
          state.committed.push(tx);
          options.onCommitted?.();
          return { hash: PHONE_HASH };
        }
        if (state.signerHold) await state.signerHold.promise;
        const commit = async () => {
          state.committed.push(tx);
          return { intentId: 'intent-1' };
        };
        await (options.guardCommit ? options.guardCommit(commit) : commit());
        options.onCommitted?.();
        return { hash: HASH };
      }),
      takeSiteTurn: jest.fn(async (site, { wait }) => {
        state.turns.push([site, wait]);
        if (state.turnBusy && !wait) throw Object.assign(new Error('busy'), { code: 'SITE_TURN_BUSY' });
        return () => {};
      }),
      sitePaymentWaiting: jest.fn(async () => state.paymentWaiting),
      startSafeSend: jest.fn(async (options) => {
        state.safe.started.push(options);
        return { safeIndex: options.safeIndex, safeTxHash: SAFE_TX_HASH, threshold: 2, collected: 1, status: 'awaiting' };
      }),
      onSafeSendSettled: (listener) => {
        state.safe.listeners.add(listener);
        return () => state.safe.listeners.delete(listener);
      },
      guardSiteSafeSend: (safeTxHash, guard) => {
        state.safe.guards.set(safeTxHash, guard);
        return () => {
          if (state.safe.guards.get(safeTxHash) === guard) state.safe.guards.delete(safeTxHash);
        };
      },
      siteWithdrawn: () => Object.assign(new Error('withdrawn'), { code: 'SAFE_SITE_WITHDRAWN' }),
      // The boards main runs in the approvals document (APS-3b), when a test sets them.
      safeBoards: () => state.safeBoards || null,
    },
  };
  // An execution of the site's SafeTx, as safe-transactions.js and the
  // executor run one: past the request's guard, then the executor's waits
  // (its quote, the site's turn, its signer: `duringWait` runs among them),
  // and the same guard again at the commit after the signature. Not at all
  // for the site when it has no guard.
  const executeSafe = async ({ hash = EXEC_HASH, duringWait = null } = {}) => {
    const guard = state.safe.guards.get(SAFE_TX_HASH);
    if (!guard) return { executed: false, guarded: false };
    let executed = false;
    try {
      await guard(async () => {
        await new Promise((resolve) => setImmediate(resolve));
        duringWait?.();
        return guard(async () => {
          executed = true;
          settle({ safeIndex: SAFE_INDEX, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash });
          return { hash };
        });
      });
    } catch (err) {
      return { executed, refused: err.code };
    }
    return { executed };
  };
  return { state, deps, signer, phoneSigner, settle, executeSafe };
}

function setup({ approvalsDocument = false } = {}) {
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
  const { state, deps, signer, phoneSigner, settle, executeSafe } = backends();
  const sent = [];
  const timers = [];
  const traced = [];
  const requests = createPageRequests({
    documents,
    webContentsFromId: (id) => guests.get(id),
    dispatchers: createEthereumDispatchers(deps),
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
    // With the approvals document on (APS-3b): its prompts land in `sent` too.
    approvals: approvalsDocument ? { send: (windowId, channel, payload) => sent.push([windowId, channel, payload]) } : null,
  });

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
    const n = nonce();
    expect(requests.hello(eventFrom(guest), { nonce: n }).ok).toBe(true);
    if (front) requests.foreground({ sender: { id: 500 + window } }, { guest: guest.id });
    return {
      guest,
      ask: (method, params = []) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method, params }),
      send: (tx) => requests.request(eventFrom(guest), { nonce: n, provider: 'ethereum', method: 'eth_sendTransaction', params: [tx] }),
    };
  }

  const prompts = (windowId = 1) => sent.filter(([w, c]) => w === windowId && c === 'page:prompt').map(([, , p]) => p);
  const lastPrompt = (windowId = 1) => prompts(windowId).at(-1);
  const closed = () => sent.filter(([, c]) => c === 'page:prompt-closed').map(([, , p]) => p);
  const decide = (handle, approve, choices, windowId = 1) =>
    approvalsDocument
      ? requests.decideInWindow(windowId, { handle, approve, choices })
      : requests.decide({ sender: { id: 500 + windowId } }, { handle, approve, choices });
  const connect = (key = KEY_A, walletIndex = 0, extra = {}) =>
    state.permissions.set(key, { origin: key, walletIndex, chainId: 100, ...extra });
  const rule = (key = KEY_A, to = CONTRACT, value = '0') => state.txRules.push([key, to, SELECTOR, 100, value]);
  const expire = () => {
    for (const timer of timers.filter((t) => !t.cleared)) {
      timer.cleared = true;
      timer.fn();
    }
  };
  const minted = () => traced.filter((entry) => entry.kind === 'token-minted');
  const spent = () => traced.filter((entry) => entry.kind === 'token-spent');

  return {
    requests,
    state,
    deps,
    signer,
    phoneSigner,
    settle,
    executeSafe,
    sent,
    tab,
    names,
    nameHolds,
    prompts,
    lastPrompt,
    closed,
    decide,
    connect,
    rule,
    guests,
    expire,
    traced,
    minted,
    spent,
  };
}

beforeEach(() => {
  confirmations._reset();
  mockApprovals.reset();
});

describe('a send through main, on the prompt main shows (0011 PRQ-5b)', () => {
  test("main's own view: the account, the chain, the transaction in main's form, the fee and its check", async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    expect(env.prompts()).toEqual([
      {
        handle: expect.stringMatching(/^[0-9a-f]{64}$/),
        guest: page.guest.id,
        kind: 'eth.send',
        site: { key: KEY_A, label: KEY_A },
        view: {
          account: { index: 0, name: 'Main Wallet', address: ACCOUNT, type: 'mnemonic' },
          chain: { id: 100, name: 'Gnosis Chain', symbol: 'xDAI' },
          tx: { to: CONTRACT_CHECKSUMMED, value: '0', data: DATA },
          fee: { gasLimit: '60000', gasPrice: '1000000000', estimate: '60000000000000' },
          feeCheck: PASSING,
          feeAskAgain: false,
          alwaysAllow: true,
        },
      },
    ]);
    // Quoted for the account and the page's chain, and judged as main signs it.
    expect(env.deps.sends.estimateGas).toHaveBeenCalledWith({ from: ACCOUNT, to: CONTRACT, value: '0', data: DATA, chainId: 100 });
    expect(env.deps.sends.checkFees).toHaveBeenCalledWith({
      to: CONTRACT,
      value: '0',
      data: DATA,
      chainId: 100,
      gasLimit: '60000',
      gasPrice: '1000000000',
    });
    expect(env.state.records).toEqual([]);
    expect(await env.decide(env.lastPrompt().handle, true, {})).toEqual({ ok: true });
    expect(await answer).toEqual({ result: HASH });
    // Signed with the fee shown, recorded under the requester's key.
    expect(env.state.records).toEqual([
      {
        tx: { to: CONTRACT, value: '0', data: DATA, chainId: 100, gasLimit: '60000', gasPrice: '1000000000' },
        context: { kind: 'dapp-send', origin: KEY_A },
        walletIndex: 0,
      },
    ]);
    expect(env.state.committed).toHaveLength(1);
    // One token, minted for this approval and spent by main, and none left.
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'dapp-send' })]);
    expect(env.spent()).toHaveLength(1);
    expect(mockApprovals.outstanding()).toBe(0);
    // A confirmed send isn't a use of the rule: no last-used write; and no
    // rule without "always allow".
    expect(env.state.lastUsed).toEqual([]);
    expect(env.deps.sends.addTransactionAutoApprove).not.toHaveBeenCalled();
    // The fee was judged again at the press.
    expect(env.deps.sends.checkAtApproval).toHaveBeenCalledWith(expect.objectContaining({ gasLimit: '60000' }), {
      acknowledged: false,
    });
  });

  test('a plain transfer: its value in the view, "always allow" not offered; an ERC-20 transfer recorded as one', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    page.send(TRANSFER);
    await flush();
    expect(env.lastPrompt().view).toMatchObject({
      tx: { to: ACCOUNT, value: '10000000000000000', data: '0x' },
      alwaysAllow: false,
    });
    await env.decide(env.lastPrompt().handle, false);
    const recipient = '5'.repeat(40);
    const erc20 = { to: CONTRACT, data: `0xa9059cbb${'0'.repeat(24)}${recipient}${(1000n).toString(16).padStart(64, '0')}` };
    const answer = page.send(erc20);
    await flush();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: HASH });
    expect(env.state.records[0].context).toEqual({
      kind: 'dapp-send',
      origin: KEY_A,
      asset: CONTRACT,
      toAddress: `0x${recipient}`,
      amount: '1000',
      metadata: { erc20Method: 'transfer' },
    });
  });

  test('rejected: 4001, nothing sent and no token minted', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, false);
    expect(await answer).toEqual(REJECTED);
    expect(env.state.records).toEqual([]);
    expect(env.minted()).toEqual([]);
  });

  test("a site that isn't connected, a keyless page, and a malformed transaction are refused unprompted", async () => {
    const env = setup();
    const page = env.tab();
    expect(await page.send(CALL)).toEqual(NOT_CONNECTED);
    const blank = env.tab('data:text/html,<p>x</p>');
    expect(await blank.send(CALL)).toEqual(NO_ADDRESS);
    env.connect();
    for (const [params, message] of [
      [[], 'Transaction parameters are required'],
      [[{ value: '0x1' }], 'The transaction needs a recipient address (to)'],
      [[{ to: 'vitalik.eth' }], 'The transaction needs a recipient address (to)'],
      [[{ to: CONTRACT, value: '-1' }], 'Invalid transaction value'],
      [[{ to: CONTRACT, value: 1.5 }], 'Invalid transaction value'],
      [[{ to: CONTRACT, value: { hex: '0x1' } }], 'Invalid transaction value'],
      [[{ to: CONTRACT, data: 'deadbeef' }], 'Invalid transaction data'],
      // Bytes: an odd number of hex digits is no byte string.
      [[{ to: CONTRACT, data: '0x1' }], 'Invalid transaction data'],
      [[{ to: CONTRACT, data: '0xabc' }], 'Invalid transaction data'],
    ]) {
      expect(await page.ask('eth_sendTransaction', params)).toEqual({ error: { code: -32602, message } });
    }
    expect(env.prompts()).toEqual([]);
    expect(env.deps.sends.estimateGas).not.toHaveBeenCalled();
  });

  test("the page's from and chainId are ignored, outside custody too", async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.send({ ...CALL, from: LEDGER, chainId: '0x1' });
    await flush();
    expect(env.lastPrompt().view).toMatchObject({ account: { index: 0 }, chain: { id: 100 } });
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: HASH });
    expect(env.state.records[0].tx).toMatchObject({ chainId: 100 });
    expect(env.state.records[0].tx.from).toBeUndefined();
  });

  test('the shape checks: a quantity as hex, decimal or a number; data as hex', () => {
    expect(txOf([{ to: CONTRACT, value: '0x10', data: '0xAB' }])).toEqual({ to: CONTRACT, value: '16', data: '0xAB', gas: null });
    expect(txOf([{ to: CONTRACT, value: 16, gas: '0x5208' }])).toEqual({ to: CONTRACT, value: '16', data: '0x', gas: '21000' });
    expect(txOf([{ to: CONTRACT }])).toEqual({ to: CONTRACT, value: '0', data: '0x', gas: null });
  });

  test('a Safe sends only on Gnosis', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    env.state.selected.set(1, 1);
    const page = env.tab();
    expect(await page.send(CALL)).toEqual({
      error: {
        code: -32603,
        message: 'This multi-owner account can only transact on Gnosis Chain — switch the app to Gnosis first.',
      },
    });
    expect(env.prompts()).toEqual([]);
  });

  test('"always allow" records the contract rule for the requester\'s key, with the confirmed send\'s value', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.send({ ...CALL, value: '0x2386f26fc10000' });
    await flush();
    // A decision with anything but the prompt's choices is refused.
    expect(await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true, site: KEY_B })).toEqual({
      ok: false,
      reason: 'invalid',
    });
    expect(await env.decide(env.lastPrompt().handle, true, { alwaysAllow: 'yes' })).toEqual({ ok: false, reason: 'invalid' });
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ result: HASH });
    expect(env.deps.sends.addTransactionAutoApprove).toHaveBeenCalledWith(KEY_A, CONTRACT, SELECTOR, 100, '10000000000000000');
  });

  test('"always allow" records nothing for a plain transfer, or when the send fails', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    let answer = page.send(TRANSFER);
    await flush();
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ result: HASH });
    env.state.sendFails = new Error('insufficient funds for gas * price + value');
    answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ error: { code: -32603, message: 'insufficient funds for gas * price + value' } });
    expect(env.deps.sends.addTransactionAutoApprove).not.toHaveBeenCalled();
  });

  test('a fee newly above the threshold at the press is asked again, and sent once confirmed again', async () => {
    const env = setup();
    env.connect();
    env.state.atPress = ABOVE;
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    const first = env.lastPrompt();
    // page:decide answers once the request does, after the second prompt.
    const decided = env.decide(first.handle, true, {});
    await flush();
    expect(env.prompts()).toHaveLength(2);
    const second = env.lastPrompt();
    expect(second).toMatchObject({ kind: 'eth.send', view: { feeCheck: { ...ABOVE, askAgain: true }, feeAskAgain: true } });
    expect(second.handle).not.toBe(first.handle);
    expect(env.state.records).toEqual([]);
    expect(env.minted()).toEqual([]);
    await env.decide(second.handle, true, { feeAcknowledged: true });
    expect(await answer).toEqual({ result: HASH });
    expect(await decided).toEqual({ ok: true });
    expect(env.deps.sends.checkAtApproval).toHaveBeenLastCalledWith(expect.anything(), { acknowledged: true });
    // One token, for the approval that sent it.
    expect(env.minted()).toHaveLength(1);
  });

  test("the core's fee check refusing the mint asks again with its verdict, and the next mint is acknowledged", async () => {
    // Main's check at the press passes; the core's own, at the mint, reads
    // newer evidence (design 0012, "The fee check") and refuses once.
    const coreVerdict = {
      max_cost: '60000000000000',
      comparable: true,
      ratio: '20',
      above: true,
      one_endpoint: false,
      basis: 'quote',
      auto_approve: false,
    };
    const issue = jest.spyOn(mockApprovals.approval, 'issue');
    issue.mockRejectedValueOnce(
      Object.assign(new Error('fee'), { code: 'not_authorized', data: { reason: 'fee_check', fee_check: coreVerdict } })
    );
    try {
      const env = setup();
      env.connect();
      const page = env.tab();
      const answer = page.send(CALL);
      await flush();
      const first = env.lastPrompt();
      expect(first.view).toMatchObject({ feeCheck: PASSING, feeAskAgain: false });
      const decided = env.decide(first.handle, true, {});
      await flush();
      // Not the page's answer: the prompt shows again, with the core's verdict.
      expect(env.prompts()).toHaveLength(2);
      const second = env.lastPrompt();
      expect(second.handle).not.toBe(first.handle);
      expect(second).toMatchObject({
        kind: 'eth.send',
        view: { feeCheck: { ...ABOVE, askAgain: true }, feeAskAgain: true },
      });
      expect(issue).toHaveBeenCalledTimes(1);
      expect(issue.mock.calls[0][0]).not.toHaveProperty('fee_ack');
      expect(env.state.records).toEqual([]);
      expect(env.minted()).toEqual([]);
      await env.decide(second.handle, true, { feeAcknowledged: true });
      expect(await answer).toEqual({ result: HASH });
      expect(await decided).toEqual({ ok: true });
      // The second mint carries the acknowledgement, under the second handle.
      expect(issue).toHaveBeenCalledTimes(2);
      expect(issue.mock.calls[1][0]).toMatchObject({ kind: 'dapp-send', fee_ack: true, handle: second.handle });
      expect(env.minted()).toHaveLength(1);
      expect(env.state.committed).toHaveLength(1);
      expect(mockApprovals.outstanding()).toBe(0);
    } finally {
      issue.mockRestore();
    }
  });

  test("a fee that couldn't be quoted: the prompt says so, and its approval asks for the quote again", async () => {
    const env = setup();
    env.connect();
    env.state.quoteFails = true;
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    expect(env.lastPrompt().view).toMatchObject({ fee: null, feeCheck: null });
    env.state.quoteFails = false;
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    expect(env.prompts()).toHaveLength(2);
    expect(env.lastPrompt().view.fee).toEqual({ gasLimit: '60000', gasPrice: '1000000000', estimate: '60000000000000' });
    expect(env.minted()).toEqual([]);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: HASH });
  });

  test("a Ledger signs in main; a device's own decline answers the user's rejection", async () => {
    const env = setup();
    env.connect(KEY_A, LEDGER_INDEX);
    const page = env.tab();
    let answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: HASH });
    // A device spends the token through the core (design 0012) before it
    // signs: its signer is handed the confirmation, the page's.
    expect(env.deps.sends.getSigner).toHaveBeenCalledWith(LEDGER_INDEX, {
      confirmation: expect.objectContaining({ kind: 'dapp-send', account: LEDGER_INDEX, page: expect.objectContaining({ origin: KEY_A }) }),
    });
    env.state.sendFails = Object.assign(new Error('Rejected on device'), { code: 'LEDGER_USER_REJECTED' });
    answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(REJECTED);
  });

  test("a phone account: no fee to check, its job through main's bridge, and an unknown outcome never 4001", async () => {
    const env = setup();
    env.connect(KEY_A, PHONE_INDEX);
    const page = env.tab();
    let answer = page.send(CALL);
    await flush();
    expect(env.lastPrompt().view).toMatchObject({ account: { type: 'remote' }, feeCheck: null });
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: PHONE_HASH });
    expect(env.deps.sends.checkFees).not.toHaveBeenCalled();
    expect(env.deps.sends.checkAtApproval).not.toHaveBeenCalled();
    // D13: the phone may have sent it.
    env.state.sendFails = Object.assign(new Error('lost'), { code: 'REMOTE_OUTCOME_UNKNOWN' });
    answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({
      error: {
        code: -32603,
        message: "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
        data: { outcome: 'unknown' },
      },
    });
    env.state.sendFails = Object.assign(new Error('declined'), { code: 'REMOTE_USER_REJECTED' });
    answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(REJECTED);
  });

  test('one pending wallet prompt per document; the slot stays taken while an approved send is at its device', async () => {
    const env = setup();
    env.connect(KEY_A, LEDGER_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    expect(await page.send(CALL)).toEqual(PENDING);
    env.state.signerHold = deferred();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    expect(env.state.records).toHaveLength(1);
    expect(await page.ask('personal_sign', ['0x68', LEDGER])).toEqual(PENDING);
    env.state.signerHold.resolve();
    expect(await answer).toEqual({ result: HASH });
  });

  test("main's deadline: a prompt never shown closes with nothing sent; one shown has none", async () => {
    const env = setup();
    env.connect();
    const front = env.tab(OTHER);
    const page = env.tab(DAPP, { front: false });
    void front;
    const answer = page.send(CALL);
    await flush();
    expect(env.prompts()).toEqual([]);
    env.expire();
    expect(await answer).toEqual({ error: { message: 'Request timed out' } });
    expect(env.state.records).toEqual([]);
    // Shown: no deadline.
    env.requests.foreground({ sender: { id: 501 } }, { guest: page.guest.id });
    const shown = page.send(CALL);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.send');
    env.expire();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await shown).toEqual({ result: HASH });
  });

  test('a document that navigates while its prompt is open gets nothing, and nothing is sent', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    const { handle } = env.lastPrompt();
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    expect(await env.decide(handle, true, {})).toMatchObject({ ok: false });
    expect(env.state.records).toEqual([]);
    expect(env.minted()).toEqual([]);
  });

  test('a grant revoked while the prompt is open sends nothing', async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.state.permissions.delete(KEY_A);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(NOT_CONNECTED);
    expect(env.state.records).toEqual([]);
    expect(env.minted()).toEqual([]);
  });
});

describe("main's issuer: a dapp-send or a site's safe-send token only for its handle and key", () => {
  const TX = { to: CONTRACT, value: '0', data: DATA, chainId: 100, gasLimit: '60000', gasPrice: '1' };

  const PAGE_A = Object.freeze({ origin: KEY_A, top_origin: KEY_A, frame: 1, navigation: 1, agent: false });
  // A send as main signs it, presented to the (simulated) core with its
  // token: the core spends it there (design 0012).
  const { buildTransaction, toCoreTransaction } = require('../wallet/signing-utils');
  const present = (confirmation, tx, overrides = {}) =>
    mockApprovals.authorize(
      'sign.transaction',
      0,
      { tx: toCoreTransaction(buildTransaction({ ...tx, nonce: 3 })).tx },
      { ...confirmations.signingAuthorization(confirmation), ...overrides }
    );
  const mint = (payload, handle = 'a'.repeat(64), kind = 'dapp-send', index = 0) =>
    confirmations.issuePageConfirmation(kind, index, payload, { handle, context: PAGE_A });

  test('a dapp-send token minted for handle A is refused for handle B, for another key, and spent twice', async () => {
    let confirmation = await mint({ ...TX, origin: KEY_A });
    expect(() => present(confirmation, TX, { authorization: { token: confirmation.token, handle: 'b'.repeat(64) } })).toThrow(
      /mismatch/
    );
    confirmation = await mint({ ...TX, origin: KEY_A });
    expect(() => present(confirmation, TX, { page: { ...PAGE_A, origin: KEY_B } })).toThrow(/mismatch/);
    confirmation = await mint({ ...TX, origin: KEY_A });
    expect(() => present(confirmation, TX)).not.toThrow();
    expect(() => present(confirmation, TX)).toThrow(/unknown_token/);
    // Another fee, recipient or value than the one confirmed: refused.
    confirmation = await mint({ ...TX, origin: KEY_A });
    expect(() => present(confirmation, { ...TX, gasPrice: '2' })).toThrow(/mismatch/);
  });

  test('a safe-send is a page kind only when it names a site, and its token binds the page', async () => {
    const safeTx = { tx: { to: CONTRACT, value: '0', data: DATA }, chainId: 100 };
    await expect(mint(safeTx, 'c'.repeat(64), 'safe-send', SAFE_INDEX)).rejects.toThrow(/Not a page confirmation kind/);
    const confirmation = await mint({ ...safeTx, origin: KEY_A }, 'c'.repeat(64), 'safe-send', SAFE_INDEX);
    await expect(confirmations.spendSafeConfirmation({ ...confirmation, page: { ...PAGE_A, origin: KEY_B } })).rejects.toThrow(
      /differs/
    );
    const again = await mint({ ...safeTx, origin: KEY_A }, 'c'.repeat(64), 'safe-send', SAFE_INDEX);
    await expect(confirmations.spendSafeConfirmation(again)).resolves.toEqual({ bound: true });
    expect(mockApprovals.calls.filter((call) => call.method === 'approval.spend').at(-1).page).toEqual(PAGE_A);
  });

  test('the token for a send whose document navigated after the approval is never spent: nothing sent', async () => {
    const env = setup();
    env.connect(KEY_A, LEDGER_INDEX);
    const page = env.tab();
    env.state.turnHold = deferred();
    const turn = env.deps.sends.takeSiteTurn;
    turn.mockImplementationOnce(async () => {
      await env.state.turnHold.promise;
      return () => {};
    });
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    env.state.turnHold.resolve();
    await flush();
    expect(env.state.records).toEqual([]);
    expect(env.minted()).toEqual([]);
  });
});

describe("the site's contract rule, read by main for the request it holds", () => {
  test('the rule answers a contract call with no prompt, and marks the site used', async () => {
    const env = setup();
    env.connect();
    env.rule();
    const page = env.tab();
    expect(await page.send(CALL)).toEqual({ result: HASH });
    expect(env.prompts()).toEqual([]);
    expect(env.minted()).toEqual([]);
    // A page's send, never main's own: under its PageContext (design 0012),
    // with no token until `{ standing }` (APB-1b).
    expect(env.deps.sends.getSigner).toHaveBeenCalledWith(0, {
      page: expect.objectContaining({ origin: KEY_A, top_origin: KEY_A, agent: false }),
    });
    expect(env.state.lastUsed).toEqual([[KEY_A]]);
    // In its own turn, silently: a busy turn or a waiting payment pauses it (D12).
    expect(env.state.turns).toEqual([[KEY_A, false]]);
    expect(env.state.committed).toHaveLength(1);
  });

  test('never for a plain transfer, never for a Safe, never for more value, and paused while a payment waits', async () => {
    const env = setup();
    env.connect();
    env.rule(KEY_A, ACCOUNT);
    env.rule();
    const page = env.tab();
    page.send(TRANSFER);
    await flush();
    expect(env.prompts()).toHaveLength(1);
    await env.decide(env.lastPrompt().handle, false);
    page.send({ ...CALL, value: '0x1' });
    await flush();
    expect(env.prompts()).toHaveLength(2);
    await env.decide(env.lastPrompt().handle, false);
    env.state.paused = true;
    page.send(CALL);
    await flush();
    expect(env.prompts()).toHaveLength(3);
    await env.decide(env.lastPrompt().handle, false);
    env.state.paused = false;
    env.connect(KEY_A, SAFE_INDEX);
    env.rule(KEY_A, CONTRACT);
    page.send(CALL);
    await flush();
    expect(env.prompts()).toHaveLength(4);
    expect(env.state.records).toEqual([]);
  });

  test('a rule answers only a live request of its own key', async () => {
    const env = setup();
    env.connect(KEY_A);
    env.connect(KEY_B);
    env.rule(KEY_A);
    const other = env.tab(OTHER);
    other.send(CALL);
    await flush();
    // Another site's rule never answers this page.
    expect(env.prompts()).toHaveLength(1);
    expect(env.deps.sends.ruleMatches).toHaveBeenCalledWith(KEY_B, CONTRACT, SELECTOR, 100, '0');
    expect(env.state.records).toEqual([]);
  });

  test('a silent send finding the turn taken, or a payment of the site waiting, is refused with nothing sent (D12)', async () => {
    const env = setup();
    env.connect();
    env.rule();
    const page = env.tab();
    env.state.turnBusy = true;
    const paused = {
      error: {
        code: -32603,
        message: 'Signing was not confirmed: auto-approve is paused while a payment this site requested is waiting',
      },
    };
    expect(await page.send(CALL)).toEqual(paused);
    env.state.turnBusy = false;
    env.state.paymentWaiting = true;
    expect(await page.send(CALL)).toEqual(paused);
    expect(env.state.records).toEqual([]);
  });

  test('a fee that needs the user goes to the prompt, with the quote and verdict it got', async () => {
    const env = setup();
    env.connect();
    env.rule();
    for (const verdict of [
      { ...PASSING, comparable: false, ratio: null, autoApprove: false },
      { ...PASSING, oneEndpoint: true, autoApprove: false },
      ABOVE,
    ]) {
      env.state.verdict = verdict;
      const page = env.tab();
      page.send(CALL);
      await flush();
      expect(env.lastPrompt()).toMatchObject({ kind: 'eth.send', view: { feeCheck: verdict, fee: { gasLimit: '60000' } } });
      await env.decide(env.lastPrompt().handle, false);
    }
    expect(env.deps.sends.estimateGas).toHaveBeenCalledTimes(3);
    expect(env.state.records).toEqual([]);
  });

  test('a phone account under the rule has no fee to check', async () => {
    const env = setup();
    env.connect(KEY_A, PHONE_INDEX);
    env.rule();
    const page = env.tab();
    expect(await page.send(CALL)).toEqual({ result: PHONE_HASH });
    expect(env.deps.sends.checkFees).not.toHaveBeenCalled();
  });

  test('a locked vault asks for its unlock first, and the rule sends once it is unlocked', async () => {
    const env = setup();
    env.connect();
    env.rule();
    env.state.unlocked = false;
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    expect(env.lastPrompt()).toMatchObject({ kind: 'vault.unlock', view: { reason: 'send', account: { index: 0 } } });
    expect(env.state.records).toEqual([]);
    env.state.unlocked = true;
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: HASH });
    expect(env.minted()).toEqual([]);
  });

  test('an unlock the user cancels sends nothing; a rule removed during the unlock sends nothing', async () => {
    const env = setup();
    env.connect();
    env.rule();
    env.state.unlocked = false;
    const page = env.tab();
    let answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, false);
    expect(await answer).toEqual({ error: { code: 4001, message: 'User cancelled unlock' } });
    answer = page.send(CALL);
    await flush();
    env.state.txRules = [];
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(RULE_GONE);
    expect(env.state.records).toEqual([]);
  });
});

describe('Agent custody, read live', () => {
  test('a tab that enters custody after its hello gets no standing rule', async () => {
    const env = setup();
    env.connect();
    env.rule();
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    page.send(CALL);
    await flush();
    // The agent doesn't handle it: main's prompt, not the rule.
    expect(env.lastPrompt().kind).toBe('eth.send');
    expect(env.state.records).toEqual([]);
  });

  test.each([
    ['the quote', (env) => env.deps.sends.estimateGas],
    ['the fee check', (env) => env.deps.sends.checkFees],
  ])('one that enters custody while its rule-answered send waits on %s is refused, with nothing sent', async (_label, hookOf) => {
    const env = setup();
    env.connect();
    env.rule();
    const page = env.tab();
    const hold = deferred();
    const hook = hookOf(env);
    const real = hook.getMockImplementation();
    hook.mockImplementationOnce(async (...args) => {
      await hold.promise;
      return real(...args);
    });
    const answer = page.send(CALL);
    await flush();
    env.state.custody.add(page.guest.id);
    hold.resolve();
    expect(await answer).toEqual(CUSTODY);
    expect(env.state.records).toEqual([]);
  });

  test('one that enters custody while its vault unlock is open is refused, with nothing sent', async () => {
    const env = setup();
    env.connect();
    env.rule();
    env.state.unlocked = false;
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.state.custody.add(page.guest.id);
    env.state.unlocked = true;
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(CUSTODY);
    expect(env.state.records).toEqual([]);
  });

  test("one that enters custody while its device signs: the signed bytes are never recorded or sent", async () => {
    const env = setup();
    env.connect();
    env.rule();
    const page = env.tab();
    env.state.signerHold = deferred();
    const answer = page.send(CALL);
    await flush();
    expect(env.state.records).toHaveLength(1);
    env.state.custody.add(page.guest.id);
    env.state.signerHold.resolve();
    expect(await answer).toEqual(CUSTODY);
    expect(env.state.committed).toEqual([]);
    expect(env.state.lastUsed).toEqual([]);
  });

  test('one that leaves custody gets the rule for its next request; one already at its prompt keeps it', async () => {
    const env = setup();
    env.connect();
    env.rule();
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    const prompted = page.send(CALL);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.send');
    env.state.custody.delete(page.guest.id);
    await env.decide(env.lastPrompt().handle, true, {});
    // The user's own decision: a token, not the rule.
    expect(await prompted).toEqual({ result: HASH });
    expect(env.minted()).toHaveLength(1);
    expect(await page.send(CALL)).toEqual({ result: HASH });
    expect(env.minted()).toHaveLength(1);
    expect(env.prompts()).toHaveLength(1);
  });

  test("a user's own decision counts in custody", async () => {
    const env = setup();
    env.connect();
    const page = env.tab();
    env.state.custody.add(page.guest.id);
    const answer = page.send(CALL);
    await flush();
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual({ result: HASH });
  });
});

describe('a DNS name over IPNS that moves off its key', () => {
  function named(env, extra = {}) {
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, extra.walletIndex ?? 0);
    return env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
  }

  test('an honest name sends under its name', async () => {
    const env = setup();
    const page = named(env);
    env.rule(NAME);
    expect(await page.send(CALL)).toEqual({ result: HASH });
    expect(env.state.records[0].context.origin).toBe(NAME);
    expect(env.state.lastUsed).toEqual([[NAME]]);
  });

  test('moved before the rule is read: refused, nothing sent and the grant never read', async () => {
    const env = setup();
    const page = named(env);
    env.rule(NAME);
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.deps.getPermission.mockClear();
    expect(await page.send(CALL)).toEqual(NO_ADDRESS);
    expect(env.deps.getPermission).not.toHaveBeenCalled();
    expect(env.state.records).toEqual([]);
  });

  test('moved during the resolution: refused, nothing sent', async () => {
    const env = setup();
    const page = named(env);
    env.rule(NAME);
    const hold = deferred();
    env.nameHolds.set(NAME, hold);
    const answer = page.send(CALL);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    hold.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.records).toEqual([]);
  });

  test('moved while the send prompt is open: refused, nothing sent, no token and no rule', async () => {
    const env = setup();
    const page = named(env);
    const answer = page.send(CALL);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.records).toEqual([]);
    expect(env.minted()).toEqual([]);
    expect(env.deps.sends.addTransactionAutoApprove).not.toHaveBeenCalled();
  });

  test("moved while the rule's unlock prompt is open: refused, nothing sent", async () => {
    const env = setup();
    const page = named(env);
    env.rule(NAME);
    env.state.unlocked = false;
    const answer = page.send(CALL);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.state.unlocked = true;
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.records).toEqual([]);
  });

  test('moved while the device signs: the signed bytes are never recorded or sent, and nothing is written', async () => {
    const env = setup();
    const page = named(env, { walletIndex: LEDGER_INDEX });
    const answer = page.send(CALL);
    await flush();
    env.state.signerHold = deferred();
    env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    await flush();
    expect(env.state.records).toHaveLength(1);
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.state.signerHold.resolve();
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.committed).toEqual([]);
    expect(env.deps.sends.addTransactionAutoApprove).not.toHaveBeenCalled();
  });

  // Main's gate is before the send. A payment that passed it and went out
  // is the requesting document's to hear of while that document is live,
  // whatever the name does next (D13); what is written under the name after
  // it still waits on the name.
  test("moved during a phone's send, which is checked before the phone is asked: the hash is the page's, nothing written", async () => {
    const env = setup();
    const page = named(env, { walletIndex: PHONE_INDEX });
    env.rule(NAME);
    env.state.phoneHold = deferred();
    const answer = page.send(CALL);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    env.state.phoneHold.resolve();
    expect(await answer).toEqual({ result: PHONE_HASH });
    expect(env.state.committed).toHaveLength(1);
    expect(env.state.lastUsed).toEqual([]);
  });

  test('moved after a rule-answered send went out: the hash is the page\'s, and no last use is written', async () => {
    const env = setup();
    const page = named(env);
    env.rule(NAME);
    const real = env.deps.sends.signAndRecord.getMockImplementation();
    env.deps.sends.signAndRecord.mockImplementationOnce(async (...args) => {
      const out = await real(...args);
      env.names.set(NAME, OTHER_IPNS_KEY);
      return out;
    });
    expect(await page.send(CALL)).toEqual({ result: HASH });
    expect(env.state.committed).toHaveLength(1);
    expect(env.state.lastUsed).toEqual([]);
    // The binding has ended: the document's next send is refused, with nothing sent.
    expect(await page.send(CALL)).toEqual(NO_ADDRESS);
    expect(env.state.committed).toHaveLength(1);
  });

  test('a document that navigates while its payment goes out hears nothing: the answer is only its own', async () => {
    const env = setup();
    const page = named(env, { walletIndex: PHONE_INDEX });
    env.rule(NAME);
    env.state.phoneHold = deferred();
    const answer = page.send(CALL);
    await flush();
    page.guest.commit(`ipns://${IPNS_KEY}/next`);
    env.state.phoneHold.resolve();
    expect(await answer).toBe(GONE);
    expect(env.state.lastUsed).toEqual([]);
  });

  test('moved after the send went out, before its rule is written: no rule, and the hash is the page\'s', async () => {
    const env = setup();
    const page = named(env);
    const answer = page.send(CALL);
    await flush();
    // The name answers for the send itself, and has moved by the rule's write.
    const real = env.deps.sends.signAndRecord.getMockImplementation();
    env.deps.sends.signAndRecord.mockImplementationOnce(async (...args) => {
      const out = await real(...args);
      env.names.set(NAME, OTHER_IPNS_KEY);
      return out;
    });
    await env.decide(env.lastPrompt().handle, true, { alwaysAllow: true });
    expect(await answer).toEqual({ result: HASH });
    expect(env.state.committed).toHaveLength(1);
    expect(env.deps.sends.addTransactionAutoApprove).not.toHaveBeenCalled();
  });
});

describe("a Safe's send: a safe-send token for the site, and its board as a second prompt", () => {
  test("the SafeTx starts for the requester's key, and the page gets the execution's hash", async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    expect(env.lastPrompt()).toMatchObject({
      kind: 'eth.send',
      view: { account: { type: 'safe' }, fee: { paidBy: 'executor' }, feeCheck: null, alwaysAllow: false },
    });
    expect(env.deps.sends.estimateGas).not.toHaveBeenCalled();
    const decided = env.decide(env.lastPrompt().handle, true, {});
    await flush();
    expect(env.state.safe.started).toEqual([
      {
        safeIndex: SAFE_INDEX,
        tx: { to: CONTRACT, value: '0', data: DATA },
        display: { site: KEY_A, asset: null, toAddress: CONTRACT, amount: '0', label: 'a contract call to 0x8335…2913' },
        chainId: 100,
      },
    ]);
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'safe-send' })]);
    // Minted and spent through the core under the page (design 0012); the
    // Safe approval it gave ended until APB-1c carries it to the owners.
    const page_ = expect.objectContaining({ origin: KEY_A, agent: false });
    expect(mockApprovals.calls.map(({ method, page: under }) => [method, under])).toEqual([
      ['approval.issue', page_],
      ['approval.spend', page_],
      ['approval.end', page_],
      ['approval.discard', null],
    ]);
    expect(mockApprovals.calls[0].params).toMatchObject({
      kind: 'safe-send',
      account: SAFE_INDEX,
      payload: { safe: '0x' + '33'.repeat(20), chain_id: '100', tx: { to: CONTRACT.toLowerCase(), value: '0' } },
    });
    const board = env.lastPrompt();
    expect(board).toMatchObject({
      kind: 'eth.safe_send',
      view: { safeIndex: SAFE_INDEX, state: { safeTxHash: SAFE_TX_HASH } },
    });
    // Another SafeTx's outcome is not this one's.
    env.settle({ safeIndex: SAFE_INDEX, safeTxHash: `0x${'99'.repeat(32)}`, outcome: 'executed', hash: '0xother' });
    await flush();
    // The board executes it at the threshold, past the request's guard.
    expect(await env.executeSafe()).toEqual({ executed: true });
    expect(await answer).toEqual({ result: EXEC_HASH });
    // The request has ended: its guard with it.
    expect(env.state.safe.guards.size).toBe(0);
    expect(await decided).toEqual({ ok: true });
    // The board's handle closes with the request.
    expect(env.closed().map((c) => c.handle)).toContain(board.handle);
    expect(env.state.safe.listeners.size).toBe(0);
    expect(env.state.records).toEqual([]);
  });

  test('a board the user leaves parks the SafeTx: the page waits, without its document\'s wallet slot', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    // page:decide answers once the request does: after the SafeTx's outcome.
    const left = env.decide(env.lastPrompt().handle, false);
    await flush();
    let settled = false;
    answer.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    // The document may ask again meanwhile.
    page.ask('personal_sign', ['0x68', SAFE]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    // Executed later (from the account card, say): checked again, and sent.
    expect(await env.executeSafe()).toEqual({ executed: true });
    expect(await answer).toEqual({ result: EXEC_HASH });
    expect(await left).toEqual({ ok: true });
  });

  test('a discarded SafeTx answers 4001', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    env.settle({ safeIndex: SAFE_INDEX, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
    expect(await answer).toEqual(REJECTED);
  });

  test('a document that navigates while its SafeTx waits: the SafeTx stays, and the request goes', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    page.guest.commit(`${KEY_A}/next`);
    expect(await answer).toBe(GONE);
    await flush();
    expect(env.state.safe.listeners.size).toBe(0);
    // No guard is left: a later execution isn't for the site.
    expect(env.state.safe.guards.size).toBe(0);
    expect(await env.executeSafe()).toEqual({ executed: false, guarded: false });
  });

  test('parked, and its name moves before it executes: not executed for the site, and the keyless answer', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, SAFE_INDEX);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    // Parked on the board.
    env.decide(env.lastPrompt().handle, false);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    expect(await env.executeSafe()).toEqual({ executed: false, refused: 'SAFE_SITE_WITHDRAWN' });
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.safe.guards.size).toBe(0);
  });

  test('parked, and its grant revoked before it executes: not executed for the site, and the keyless answer', async () => {
    const env = setup();
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    env.decide(env.lastPrompt().handle, false);
    await flush();
    env.state.permissions.delete(KEY_A);
    expect(await env.executeSafe()).toEqual({ executed: false, refused: 'SAFE_SITE_WITHDRAWN' });
    expect(await answer).toEqual(NO_ADDRESS);
  });

  test('its name moves during the execution\'s waits (the quote, the signer): refused at the commit, nothing sent for the site', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, SAFE_INDEX);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    expect(
      await env.executeSafe({ duringWait: () => env.names.set(NAME, OTHER_IPNS_KEY) })
    ).toEqual({ executed: false, refused: 'SAFE_SITE_WITHDRAWN' });
    expect(await answer).toEqual(NO_ADDRESS);
  });

  test('an honest name, parked and executed later: checked again, executed, and the hash goes back', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, SAFE_INDEX);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    env.decide(env.lastPrompt().handle, false);
    await flush();
    expect(await env.executeSafe()).toEqual({ executed: true });
    expect(await answer).toEqual({ result: EXEC_HASH });
  });

  test('a name that moves before the SafeTx starts gets none; one that moves after its execution still hears its hash', async () => {
    const env = setup();
    env.names.set(NAME, IPNS_KEY);
    env.connect(NAME, SAFE_INDEX);
    const page = env.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    let answer = page.send(CALL);
    await flush();
    env.names.set(NAME, OTHER_IPNS_KEY);
    await env.decide(env.lastPrompt().handle, true, {});
    expect(await answer).toEqual(NO_ADDRESS);
    expect(env.state.safe.started).toEqual([]);
    expect(env.minted()).toEqual([]);

    const again = setup();
    again.names.set(NAME, IPNS_KEY);
    again.connect(NAME, SAFE_INDEX);
    const second = again.tab(`ipns://${IPNS_KEY}/`, { bind: NAME });
    answer = second.send(CALL);
    await flush();
    again.decide(again.lastPrompt().handle, true, {});
    await flush();
    // Executed past the guard, and the name moves before main hears of it.
    const guard = again.state.safe.guards.get(SAFE_TX_HASH);
    await guard(async () => {
      again.names.set(NAME, OTHER_IPNS_KEY);
      again.settle({ safeIndex: SAFE_INDEX, safeTxHash: SAFE_TX_HASH, outcome: 'executed', hash: EXEC_HASH });
    });
    expect(await answer).toEqual({ result: EXEC_HASH });
  });
});

// The agent's own approval runs inside the request's life, as its connect and
// signature do: the agent route here is the real AgentWalletController, as the
// agent service calls it, with an approval the test answers.
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
    const controller = new AgentWalletController({
      identityManager: { getDerivedWallets: async () => env.state.wallets, getActiveWalletIndex: () => 0 },
      getPermission: (key) => env.state.permissions.get(key) || null,
      grantPermission: jest.fn(),
      updateLastUsed: env.deps.updateLastUsed,
      updateWalletIndex: jest.fn(),
      getChain: (chainId) => ({ chainId, name: 'Gnosis Chain', nativeCurrency: { symbol: 'xDAI', decimals: 18 } }),
      getSigner: () => env.signer,
      estimateGas: async () => ({ gasLimit: '21000' }),
      getGasPrices: async () => ({ type: 'legacy', gasPrice: '1000000000' }),
      // As the transaction service runs it: the signer's wait, then the
      // caller's guard, which commits the signed bytes itself or withdraws
      // them, then the broadcast.
      signAndRecord: async (tx, _signer, context, options) => {
        agentSends.push({ tx, context });
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
        },
        request
      );
    return { approvals, agentSends, agentCommitted };
  }

  test("it sends under the attested key once approved, holding the document's slot", async () => {
    const env = setup();
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
    // Main's own path sent nothing.
    expect(env.state.records).toEqual([]);
  });

  test("withdrawn at main's deadline: the agent's later approval sends nothing", async () => {
    const env = setup();
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
    const env = setup();
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
    const env = setup();
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
      'its grant moves to another account',
      (env) => env.state.permissions.set(NAME, { origin: NAME, walletIndex: LEDGER_INDEX, chainId: 100 }),
      { error: { code: -32603, message: expect.stringContaining('no longer connected with this account') } },
    ],
  ])("when %s during the agent's signer wait: nothing is committed or broadcast", async (_label, change, expected) => {
    const env = setup();
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
    const env = setup();
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
    const env = setup();
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
});

describe('APS-3b: with the approvals document on, main runs the Safe send\'s board in the panel', () => {
  const { createSafeBoards } = require('../approvals/safe-boards');

  // A 2-of-2 Safe: the vault owner signed as the SafeTx started; a Ledger
  // owner still to sign. Its execution runs past the request's guard.
  function withBoards(env) {
    const board = { signed: new Set([0]), cancelled: 0, signs: [] };
    env.state.safeBoards = createSafeBoards({
      getDerivedWallets: async () => env.state.wallets,
      sends: {
        state: () => ({
          safeIndex: SAFE_INDEX,
          chainId: 100,
          safeTxHash: SAFE_TX_HASH,
          threshold: 2,
          collected: board.signed.size,
          owners: [
            { index: 0, address: ACCOUNT, type: 'mnemonic', signed: board.signed.has(0) },
            { index: 1, address: LEDGER, type: 'ledger', signed: board.signed.has(1) },
          ],
          executorIndex: 0,
          display: { site: KEY_A },
          status: 'awaiting',
        }),
        sign: async (safeIndex, owner) => {
          board.signs.push(owner);
          if (owner !== undefined) board.signed.add(owner);
        },
        execute: async () => {
          const run = await env.executeSafe();
          if (!run.executed) throw Object.assign(new Error('withdrawn'), { code: run.refused || 'SAFE_SITE_WITHDRAWN' });
          return { status: 'executed', safeTxHash: SAFE_TX_HASH, executed: { hash: EXEC_HASH, explorerUrl: null } };
        },
        cancel: () => {
          board.cancelled += 1;
          env.settle({ safeIndex: SAFE_INDEX, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
        },
        tx: () => ({ to: CONTRACT, value: '0', data: DATA }),
      },
      messages: {},
    });
    return board;
  }

  test('the board shows in the document with main\'s view; the owner the user picks signs; executed, the page gets the hash', async () => {
    const env = setup({ approvalsDocument: true });
    const board = withBoards(env);
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    const shown = env.lastPrompt();
    expect(shown.kind).toBe('eth.safe_send');
    expect(shown.view).toMatchObject({
      safe: { index: SAFE_INDEX },
      threshold: 2,
      collected: 1,
      tx: { to: CONTRACT, value: '0', data: DATA },
      executor: { index: 0, address: ACCOUNT },
      step: 'collect',
    });
    expect(shown.view.state).toBeUndefined();
    // The chrome decides none of it.
    expect(await env.requests.decide({ sender: { id: 501 } }, { handle: shown.handle, approve: true, choices: { action: 'sign', owner: 1 } })).toEqual({
      ok: false,
      reason: 'approvals-document',
    });
    // An owner who signed is no choice: refused, and the board stays.
    expect(await env.decide(shown.handle, true, { action: 'sign', owner: 0 })).toEqual({ ok: false, reason: 'invalid' });
    const signed = env.decide(shown.handle, true, { action: 'sign', owner: 1 });
    expect(await answer).toEqual({ result: EXEC_HASH });
    expect(await signed).toEqual({ ok: true });
    expect(board.signs).toEqual([undefined, 1]);
    // One token, the Safe send's own: the board's approval minted none.
    expect(env.minted()).toEqual([expect.objectContaining({ token: 'safe-send' })]);
    expect(env.state.safe.guards.size).toBe(0);
  });

  test('left in the panel: the SafeTx waits, the page too, without its wallet slot; discarded later, 4001', async () => {
    const env = setup({ approvalsDocument: true });
    withBoards(env);
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    expect(await env.decide(env.lastPrompt().handle, false)).toEqual({ ok: true });
    let settled = false;
    answer.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    page.ask('personal_sign', ['0x68', SAFE]);
    await flush();
    expect(env.lastPrompt().kind).toBe('eth.sign');
    env.settle({ safeIndex: SAFE_INDEX, safeTxHash: SAFE_TX_HASH, outcome: 'discarded' });
    expect(await answer).toEqual(REJECTED);
  });

  test('discarded in the panel, asked again first: the page hears 4001', async () => {
    const env = setup({ approvalsDocument: true });
    const board = withBoards(env);
    env.connect(KEY_A, SAFE_INDEX);
    const page = env.tab();
    const answer = page.send(CALL);
    await flush();
    env.decide(env.lastPrompt().handle, true, {});
    await flush();
    env.decide(env.lastPrompt().handle, true, { action: 'discard' });
    await flush();
    expect(env.lastPrompt().view.step).toBe('discard');
    expect(board.cancelled).toBe(0);
    env.decide(env.lastPrompt().handle, true, { action: 'discard' });
    expect(await answer).toEqual(REJECTED);
    expect(board.cancelled).toBe(1);
  });
});
