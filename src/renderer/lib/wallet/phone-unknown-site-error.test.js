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

const { Wallet } = require('ethers');
const { createDocument, createElement } = require('../../../../test/helpers/fake-dom.js');

// Main's IPC registry, and the chrome window's webContents (id 7).
const mockMain = { handle: new Map(), on: new Map() };
const mockWebContents = { id: 7, isDestroyed: () => false, send: jest.fn() };
jest.mock('electron', () => ({
  app: { getPath: () => require('os').tmpdir() },
  ipcMain: {
    handle: (channel, handler) => mockMain.handle.set(channel, handler),
    on: (channel, handler) => mockMain.on.set(channel, handler),
    removeHandler: () => {},
  },
  BrowserWindow: {
    getFocusedWindow: () => ({ webContents: mockWebContents }),
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
  isTransactionAutoApproved: () => false,
  addTransactionAutoApprove: jest.fn(),
  getSigningAutoApprove: () => false,
}));

let mockSigners;

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

async function start({ answer } = {}) {
  jest.resetModules();
  mockMain.handle.clear();
  mockMain.on.clear();

  // Main: the phone account's signer, the bridge and the wallet handlers.
  const { createRemoteBackend } = require('../../../main/wallet/remote/signer');
  mockSigners = {
    [PHONE_INDEX]: createRemoteBackend({ index: PHONE_INDEX, address: PHONE.address }),
  };
  require('../../../main/wallet/remote/bridge').registerRemoteSignerIpc();
  require('../../../main/wallet/wallet-ipc').registerWalletIpc();
  const invoke = (channel, ...args) => mockMain.handle.get(channel)({}, ...args);
  const fromChrome = (channel, payload) => mockMain.on.get(channel)({ sender: { id: 7 } }, payload);

  // The renderer's session broker, wired to main as the preload wires it.
  const toRenderer = {};
  mockWebContents.send.mockReset().mockImplementation((channel, payload) => {
    setImmediate(() => toRenderer[channel]?.(payload));
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
      requestSent: (jobId) => fromChrome('remote-signer:request-sent', { jobId }),
    },
    signaling: { p: 'mqtt', s: 'wss://relay.test/mqtt' },
    bridgeOrigin: 'https://bridge.test',
  });
  broker.start();
  const jobs = [];
  broker.onJobEvent((event) => jobs.push(event));

  // The renderer's dApp approval, over main's real handlers.
  const elements = Object.fromEntries(
    DAPP_TX_ELEMENT_IDS.map((id) => [id, createElement('button')])
  );
  elements['dapp-tx-auto-approve'].checked = false;
  global.document = createDocument({ elementsById: elements });
  global.window = {
    dappPermissions: { getPermission: async () => ({ walletIndex: PHONE_INDEX, chainId: 100 }) },
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
      confirmSigning: (...args) => invoke('wallet:confirm-signing', ...args),
      dappSendTransaction: (...args) => invoke('wallet:dapp-send-transaction', ...args),
    },
  };
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
  }));
  jest.doMock('./safe-signing.js', () => ({
    openSafeSigningBoard: () => {},
    isSafeSigningBoardOpen: () => false,
  }));
  jest.doMock('./wallet-state.js', () => ({
    walletState: { identityView: createElement('div'), selectedChainId: 100 },
    registerScreenHider: () => {},
    hideAllSubscreens: () => {},
  }));
  jest.doMock('../sidebar.js', () => ({ open: () => {} }));
  const dappTx = await import('./dapp-tx.js');
  dappTx.initDappTx();

  // The site asks for a payment; the user confirms it.
  const site = { state: 'pending' };
  const answered = dappTx
    .showDappTxApproval({}, SITE, { to: '0x' + '22'.repeat(20), value: '0x1' }, 100)
    .then(
      (value) => Object.assign(site, { state: 'resolved', value }),
      (value) => Object.assign(site, { state: 'rejected', value })
    );
  await settle();
  elements['dapp-tx-approve'].dispatch('click');
  await settle();
  // The payment request is on the phone now.
  expect(openlv.session.send.mock.calls.map(([message]) => message.method)).toEqual([
    'wallet_switchEthereumChain',
    'eth_sendTransaction',
  ]);

  return { elements, broker, jobs, site, answered };
}

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'])
    jest.spyOn(console, level).mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete global.window;
  delete global.document;
});

describe("a site's answer when its phone payment's outcome is unknown (D13)", () => {
  test('the user stops waiting: Reject tells the site the outcome is unknown, never 4001', async () => {
    const { elements, broker, jobs, site, answered } = await start();
    broker.cancelJob(jobs.find((event) => event.phase === 'qr').jobId);
    await settle();

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
    await settle();

    expect(elements['dapp-tx-approve'].disabled).toBe(true);
    elements['dapp-tx-back'].dispatch('click');
    await answered;
    expect(site).toEqual({ state: 'rejected', value: SITE_UNKNOWN });
  });

  test("the phone's own refusal is an answer: nothing was sent, so 4001 stands", async () => {
    const { elements, site, answered } = await start({
      answer: async () => ({ error: { code: 4001, message: 'User denied.' } }),
    });
    await settle();

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
