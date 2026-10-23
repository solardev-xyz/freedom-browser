// D13, end to end: what a site hears about a phone account's payment whose
// answer was lost. A phone signs and broadcasts the payment itself, so once
// the request reached it the payment may have been sent. A site told
// "rejected" (EIP-1193 4001) may send the request again, and the phone could
// pay twice, so the site must hear that the outcome is unknown.
//
// Real on both sides of IPC: main's `wallet:confirm-signing` and
// `wallet:dapp-send-transaction` handlers, transaction service, phone signer
// and bridge; the renderer's session broker (over a scripted openlv session)
// and dApp approval. Mocked: chain data, permissions, and the phone itself.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Wallet } = require('ethers');
const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

// Main's IPC registry, a fresh one per test (startPhone).
const mockMain = { handle: new Map(), on: new Map() };
// The chrome window's webContents, a fresh one per test (startPhone).
const mockWindow = { webContents: null };
// The wallet's records (intent store, payment history) live in a scratch
// profile per test.
let mockUserData;
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: {
    handle: (channel, handler) => mockMain.handle.set(channel, handler),
    on: (channel, handler) => mockMain.on.set(channel, handler),
    removeHandler: () => {},
  },
  BrowserWindow: {
    getFocusedWindow: () => mockWindow,
    getAllWindows: () => [],
  },
  webContents: { getAllWebContents: () => [] },
}));
jest.mock('qrcode', () => ({}));
jest.mock('../../../main/wallet/balance-service', () => ({}));
jest.mock('../../../main/wallet/rpc-manager', () => ({ getEffectiveRpcUrls: () => [] }));
jest.mock('../../../main/wallet/chains', () => ({
  getChain: () => null,
  getAllChains: () => [],
  getTxExplorerUrl: () => null,
}));
jest.mock('../../../main/networks/chain-data', () => ({
  request: jest.fn(async (_chainId, method) => {
    throw new Error(`unexpected read ${method}`);
  }),
  broadcastRawTransaction: jest.fn(),
  getFeeQuote: jest.fn(),
}));
jest.mock('../../../main/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../../../main/wallet/signers', () => ({ getSigner: (index) => mockSigners[index] }));
jest.mock('../../../main/identity-manager', () => ({
  getWalletRecord: () => null,
  getActiveWalletIndex: () => 0,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
jest.mock('../../../main/wallet/provider-manager', () => ({ testProvider: jest.fn() }));
jest.mock('better-sqlite3', () => require('../../../../test/helpers/fake-better-sqlite3-payments'));
jest.mock('../../../main/wallet/dapp-permissions', () => ({
  getPermission: (site) => (site === 'https://app.example' ? { walletIndex: 4 } : null),
  // The site's "Always allow" covers the auto-approved test's contract call.
  isTransactionAutoApproved: () => mockAutoApprove,
  addTransactionAutoApprove: jest.fn(),
  getSigningAutoApprove: () => false,
}));

let mockSigners;
let mockAutoApprove = false;

// Anvil/Hardhat-default test key: well known, never funded on mainnet.
const PHONE = new Wallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const PHONE_INDEX = 4;
const SITE = 'https://app.example';
const SITE_UNKNOWN = {
  code: -32603,
  message:
    "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
  data: { outcome: 'unknown' },
};

const DAPP_TX_ELEMENT_IDS = [
  'sidebar-dapp-tx',
  'dapp-tx-back',
  'dapp-tx-site',
  'dapp-tx-to',
  'dapp-tx-value',
  'dapp-tx-data',
  'dapp-tx-data-row',
  'dapp-tx-network',
  'dapp-tx-fee',
  'dapp-tx-warning',
  'dapp-tx-unlock',
  'dapp-tx-touchid-btn',
  'dapp-tx-password-link',
  'dapp-tx-password-section',
  'dapp-tx-password-input',
  'dapp-tx-password-submit',
  'dapp-tx-error',
  'dapp-tx-reject',
  'dapp-tx-approve',
  'dapp-tx-auto-approve-row',
  'dapp-tx-auto-approve',
];

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await flush();
};
// Until `condition` holds. The flows read the wallet's records from disk
// on the way, so a fixed number of turns of the event loop isn't enough;
// a flow that outlived its test would also run on into the next one.
const until = async (condition, what) => {
  for (let i = 0; i < 20000; i += 1) {
    if (condition()) return;
    await flush();
  }
  throw new Error(`timed out waiting for ${what}`);
};
const shown = (ctx) =>
  until(() => ctx.elements['dapp-tx-error'].textContent !== '', 'the approval to show the outcome');

// The phone's side of openlv: links at once, answers the network switch,
// and answers the payment only as `answer` says (by default, never).
function scriptedOpenlv(answer = () => new Promise(() => {})) {
  const listeners = new Set();
  let status = 'created';
  const session = {
    status: {
      get: () => status,
      subscribe(listener) {
        listeners.add(listener);
        listener(status);
        return () => listeners.delete(listener);
      },
      until: async (isMatch) => {
        // The phone scans the code: the link comes up.
        status = 'connected';
        for (const listener of listeners) listener(status);
        return isMatch(status) ? status : undefined;
      },
    },
    error: { get: () => undefined },
    connect: jest.fn(async () => {}),
    send: jest.fn(async ({ method }) =>
      method === 'wallet_switchEthereumChain' ? { result: null } : answer()
    ),
    close: jest.fn(async () => {}),
    getHandshakeParameters: () => ({ version: 1, sessionId: 'abcdef1234567890' }),
  };
  return {
    session,
    sdk: {
      createSession: jest.fn(async () => session),
      webrtc: () => 'WEBRTC',
      encodeConnectionURL: () => 'openlv://abcdef1234567890@1',
    },
  };
}

/**
 * Main (signer, bridge, wallet handlers) and the renderer's session broker,
 * wired as the preload wires them. `holdRequestSent: 'question'` keeps the
 * broker's question to main (may the request go?) from reaching main until
 * the test delivers it; `'answer'` lets main answer at once and holds the
 * answer on its way back. `holdAbort` holds main's abort to the renderer.
 */
async function startPhone({ answer, holdRequestSent = null, holdAbort = false } = {}) {
  jest.resetModules();
  // Each test's main gets its own IPC registry: a flow of an earlier test
  // can only ever reach that test's handlers.
  const registry = { handle: new Map(), on: new Map() };
  mockMain.handle = registry.handle;
  mockMain.on = registry.on;

  const { createRemoteBackend } = require('../../../main/wallet/remote/signer');
  mockSigners = {
    [PHONE_INDEX]: createRemoteBackend({ index: PHONE_INDEX, address: PHONE.address }),
  };
  require('../../../main/wallet/remote/bridge').registerRemoteSignerIpc();
  require('../../../main/wallet/wallet-ipc').registerWalletIpc();
  const chrome = { sender: { id: 7 } };
  const invoke = (channel, ...args) => registry.handle.get(channel)(chrome, ...args);
  const fromChrome = (channel, payload) => registry.on.get(channel)(chrome, payload);

  const held = { requestSent: [], abort: [] };
  const toRenderer = {};
  const webContents = { id: 7, isDestroyed: () => false, send: jest.fn() };
  mockWindow.webContents = webContents;
  webContents.send.mockImplementation((channel, payload) => {
    const deliver = () => setImmediate(() => toRenderer[channel]?.(payload));
    if (holdAbort && channel === 'remote-signer:abort') held.abort.push(deliver);
    else deliver();
  });
  const openlv = scriptedOpenlv(answer);
  const { createRemoteSessionBroker } = await import('./remote-session.js');
  const broker = createRemoteSessionBroker({
    openlv: openlv.sdk,
    remoteSigner: {
      onRequest: (callback) => {
        toRenderer['remote-signer:request'] = callback;
        return () => {};
      },
      onAbort: (callback) => {
        toRenderer['remote-signer:abort'] = callback;
        return () => {};
      },
      respond: (payload) => fromChrome('remote-signer:response', payload),
      requestSent: (jobId) => {
        const ask = () => invoke('remote-signer:request-sent', { jobId });
        if (holdRequestSent === 'question') {
          return new Promise((resolve) => held.requestSent.push(() => resolve(ask())));
        }
        const answered = ask();
        if (holdRequestSent === 'answer') {
          return new Promise((resolve) => held.requestSent.push(() => resolve(answered)));
        }
        return Promise.resolve(answered);
      },
    },
    signaling: { p: 'mqtt', s: 'wss://relay.test/mqtt' },
    bridgeOrigin: 'https://bridge.test',
  });
  broker.start();
  const jobs = [];
  broker.onJobEvent((event) => jobs.push(event));

  return {
    invoke,
    broker,
    jobs,
    // What reached the phone, by method.
    phoneGot: () => openlv.session.send.mock.calls.map(([message]) => message.method),
    deliver: {
      requestSent: () => held.requestSent.splice(0).forEach((deliver) => deliver()),
      abort: () => held.abort.splice(0).forEach((deliver) => deliver()),
    },
  };
}

const rendererWindow = (phone) => ({
  electronAPI: { getSettings: async () => ({ enableIdentityWallet: true }) },
  addEventListener: () => {},
  identity: { getStatus: async () => ({ isUnlocked: true }) },
  dappPermissions: {
    getPermission: async () => ({ walletIndex: PHONE_INDEX, chainId: 100 }),
    isTransactionAutoApproved: async () => mockAutoApprove,
    updateLastUsed: async () => {},
  },
  networks: { getChains: async () => ({ success: true, chains: { 100: { name: 'Gnosis' } } }) },
  wallet: {
    getDerivedWallets: async () => ({
      success: true,
      wallets: [{ index: PHONE_INDEX, address: PHONE.address, type: 'remote' }],
    }),
    estimateGas: async () => ({ success: true, gasLimit: '21000' }),
    getGasPrice: async () => ({
      success: true,
      type: 'legacy',
      gasPrice: '1000000000',
      effectiveGasPrice: '1000000000',
    }),
    confirmSigning: (...args) => phone.invoke('wallet:confirm-signing', ...args),
    dappSendTransaction: (...args) => phone.invoke('wallet:dapp-send-transaction', ...args),
  },
});

function mockRendererModules() {
  jest.doMock('./wallet-utils.js', () => ({
    // A phone account skips the vault's unlock, as in the app.
    bypassUnlockGateForDevice: (_index, _unlock, confirm) => {
      if (confirm) confirm.disabled = false;
      return true;
    },
    bypassUnlockGateForSafe: () => false,
    isSafeAccount: () => false,
    renderSafeFeePayer: () => {},
    truncateAddress: (address) => address,
    signingButtonLabel: () => 'Confirm on your phone…',
    GNOSIS_CHAIN_ID: 100,
  }));
  jest.doMock('./safe-signing.js', () => ({
    openSafeSigningBoard: () => {},
    isSafeSigningBoardOpen: () => false,
    openSafeMessageBoard: () => {},
    abandonSafeMessageBoard: () => {},
  }));
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div'), selectedChainId: 100 },
    registerScreenHider: () => {},
    hideAllSubscreens: () => {},
  }));
  jest.doMock('../sidebar.js', () => ({ open: () => {} }));
}

/**
 * The site asks for a payment on the dApp approval, over main's real
 * handlers, and the user confirms it.
 */
async function start(options = {}) {
  const phone = await startPhone(options);
  const elements = Object.fromEntries(
    DAPP_TX_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elements['dapp-tx-auto-approve'].checked = false;
  global.document = createDocument({ elementsById: elements });
  global.window = rendererWindow(phone);
  mockRendererModules();
  const dappTx = await import('./dapp-tx.js');
  dappTx.initDappTx();

  const site = { state: 'pending' };
  const answered = dappTx
    .showDappTxApproval({}, SITE, { to: '0x' + '22'.repeat(20), value: '0x1' }, 100)
    .then(
      (value) => Object.assign(site, { state: 'resolved', value }),
      (value) => Object.assign(site, { state: 'rejected', value })
    );
  await settle();
  elements['dapp-tx-approve'].dispatch('click');
  if (options.holdRequestSent) {
    await until(() => phone.phoneGot().length === 1, 'the network switch');
    await settle();
  } else {
    // The payment request is on the phone now.
    await until(() => phone.phoneGot().length === 2, 'the payment request on the phone');
    expect(phone.phoneGot()).toEqual(['wallet_switchEthereumChain', 'eth_sendTransaction']);
  }
  return { ...phone, elements, site, answered };
}

/**
 * The site's auto-approved payment, through the real dApp provider, over
 * main's real handlers: what the page receives.
 */
async function startAutoApproved(options = {}) {
  mockAutoApprove = true;
  const phone = await startPhone(options);
  const address = createElement('input');
  address.value = SITE;
  global.document = createDocument({ elementsById: { 'address-input': address } });
  global.window = rendererWindow(phone);
  mockRendererModules();
  jest.doMock('../wallet-ui.js', () => ({
    showDappConnect: jest.fn(),
    getSelectedChainId: () => 100,
    setSelectedChainId: jest.fn(),
    updateConnectionBanner: jest.fn(),
    showDappTxApproval: jest.fn(),
    showDappSignApproval: jest.fn(),
    showVaultUnlock: jest.fn(),
    updateSwarmConnectionBanner: jest.fn(),
    updateX402ConnectionBanner: jest.fn(),
  }));
  const provider = await import('../dapp-provider.js');
  await settle();
  const webview = createElement('webview');
  webview.send = jest.fn();
  webview.getURL = () => SITE;
  provider.setupWebviewProvider(webview);
  webview.dispatch('did-frame-navigate', {
    isMainFrame: true,
    frameProcessId: 7,
    frameRoutingId: 4,
  });
  webview.dispatch('ipc-message', {
    channel: 'dapp:provider-request',
    frameId: [7, 4],
    args: [
      {
        id: 31,
        method: 'eth_sendTransaction',
        params: [{ to: '0x' + '22'.repeat(20), data: '0x095ea7b3' + '00'.repeat(64) }],
      },
    ],
  });
  const pageGot = () =>
    webview.send.mock.calls
      .filter(([channel]) => channel === 'dapp:provider-response')
      .map(([, response]) => response);
  await until(() => pageGot().length > 0, "the page's answer");
  return { ...phone, pageGot };
}

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-unknown-'));
  for (const level of ['log', 'warn', 'error'])
    jest.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  mockAutoApprove = false;
  delete global.window;
  delete global.document;
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

describe("a site's answer when its phone payment's outcome is unknown (D13)", () => {
  test('the user stops waiting: Reject tells the site the outcome is unknown, never 4001', async () => {
    const { elements, broker, jobs, site, answered } = await start();
    broker.cancelJob(jobs.find((event) => event.phase === 'qr').jobId);
    await shown({ elements });

    expect(elements['dapp-tx-error'].textContent).toMatch(/unknown whether this payment was sent/);
    expect(elements['dapp-tx-approve'].disabled).toBe(true);
    expect(site.state).toBe('pending');

    elements['dapp-tx-reject'].dispatch('click');
    await answered;
    expect(site).toEqual({ state: 'rejected', value: SITE_UNKNOWN });
  });

  test("main's own timeout: Back tells the site the same", async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const { elements, site, answered } = await start();
    jest.advanceTimersByTime(5 * 60 * 1000 + 1);
    await shown({ elements });

    expect(elements['dapp-tx-approve'].disabled).toBe(true);
    elements['dapp-tx-back'].dispatch('click');
    await answered;
    expect(site).toEqual({ state: 'rejected', value: SITE_UNKNOWN });
  });

  test("the phone's own refusal is an answer: nothing was sent, so 4001 stands", async () => {
    const { elements, site, answered } = await start({
      answer: async () => ({ error: { code: 4001, message: 'User denied.' } }),
    });
    await shown({ elements });

    expect(elements['dapp-tx-error'].textContent).toBe('Request rejected on your phone.');
    expect(elements['dapp-tx-approve'].disabled).toBe(false);
    elements['dapp-tx-reject'].dispatch('click');
    await answered;
    expect(site).toEqual({
      state: 'rejected',
      value: { code: 4001, message: 'User rejected the request' },
    });
  });
});

// Review of #787, M1: main allows the request before it goes, in one turn,
// so its timeout can't land between the request going out and main knowing.
describe("the request goes only with main's leave (787-M1)", () => {
  const FIVE_MINUTES = 5 * 60 * 1000 + 1;

  test('the question reaches main after its timeout: nothing goes to the phone, and the timeout stands', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const ctx = await start({ holdRequestSent: 'question' });
    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain']);

    jest.advanceTimersByTime(FIVE_MINUTES);
    await settle();
    ctx.deliver.requestSent();
    await shown(ctx);

    // Main had given up, so it refused: the payment never reached the phone.
    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain']);
    expect(ctx.elements['dapp-tx-error'].textContent).toMatch(/did not respond in time/);
    expect(ctx.elements['dapp-tx-approve'].disabled).toBe(false);
    ctx.elements['dapp-tx-reject'].dispatch('click');
    await ctx.answered;
    expect(ctx.site.value).toEqual({ code: 4001, message: 'User rejected the request' });
  });

  test('main allowed it, and its abort is late: the payment went, so the outcome is unknown', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    const ctx = await start({ holdAbort: true });
    jest.advanceTimersByTime(FIVE_MINUTES);
    await shown(ctx);

    expect(ctx.elements['dapp-tx-approve'].disabled).toBe(true);
    ctx.deliver.abort();
    await settle();
    ctx.elements['dapp-tx-back'].dispatch('click');
    await ctx.answered;
    expect(ctx.site.value).toEqual(SITE_UNKNOWN);
  });

  test('main allowed it, then timed out before it went: nothing goes, and the outcome stays unknown', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
    // Main marks the payment and allows it at once; its answer is held on
    // the way back while main times out and its abort lands first.
    const ctx = await start({ holdRequestSent: 'answer' });
    jest.advanceTimersByTime(FIVE_MINUTES);
    await until(() => ctx.jobs.some((event) => event.phase === 'aborted'), "main's abort");
    ctx.deliver.requestSent();
    await settle();

    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain']);
    expect(ctx.elements['dapp-tx-approve'].disabled).toBe(true);
    ctx.elements['dapp-tx-reject'].dispatch('click');
    await ctx.answered;
    expect(ctx.site.value).toEqual(SITE_UNKNOWN);
  });
});

// Review of #787, M2: once the payment is on the phone, only the phone's
// explicit refusals say it wasn't sent.
describe("the phone's error answers to a payment on it (787-M2)", () => {
  const INTERNAL = { error: { code: -32603, message: 'No response after submitting the payment' } };

  test.each([
    ['an internal error', INTERNAL],
    ['an unrecognised code', { error: { code: -32000, message: 'something went wrong' } }],
    ['an error with no code', { error: { message: 'oops' } }],
  ])(
    '%s leaves the outcome unknown: no second request, and the site hears unknown',
    async (_name, reply) => {
      let requests = 0;
      const ctx = await start({
        answer: async () => {
          requests += 1;
          return reply;
        },
      });
      await shown(ctx);
      expect(ctx.elements['dapp-tx-error'].textContent).toMatch(
        /unknown whether this payment was sent/
      );
      expect(ctx.elements['dapp-tx-approve'].disabled).toBe(true);
      ctx.elements['dapp-tx-approve'].dispatch('click');
      await settle();
      expect(requests).toBe(1);

      ctx.elements['dapp-tx-reject'].dispatch('click');
      await ctx.answered;
      expect(ctx.site.value).toEqual(SITE_UNKNOWN);
    }
  );

  test.each([[4100], [4200]])(
    'the explicit refusal %s is an answer: nothing was sent',
    async (code) => {
      const ctx = await start({ answer: async () => ({ error: { code, message: 'refused' } }) });
      await shown(ctx);
      expect(ctx.elements['dapp-tx-error'].textContent).toBe('refused');
      expect(ctx.elements['dapp-tx-approve'].disabled).toBe(false);
      ctx.elements['dapp-tx-reject'].dispatch('click');
      await ctx.answered;
      expect(ctx.site.value).toEqual({ code: 4001, message: 'User rejected the request' });
    }
  );

  test('an auto-approved payment: the page hears unknown from an internal error', async () => {
    const ctx = await startAutoApproved({ answer: async () => INTERNAL });
    expect(ctx.phoneGot()).toEqual(['wallet_switchEthereumChain', 'eth_sendTransaction']);
    expect(ctx.pageGot()).toEqual([{ id: 31, result: null, error: SITE_UNKNOWN }]);
  });

  test("an auto-approved payment: the phone's own rejection reaches the page as before", async () => {
    const ctx = await startAutoApproved({
      answer: async () => ({ error: { code: 4001, message: 'User denied.' } }),
    });
    expect(ctx.pageGot()).toEqual([
      {
        id: 31,
        result: null,
        error: { code: -32603, message: 'Request rejected on your phone.', data: undefined },
      },
    ]);
  });
});
