/**
 * Tests for the renderer-side dApp provider handler.
 *
 * Focus: binding response delivery to the document that made the request.
 * Main drops Safe signing sessions on navigation, but the renderer must
 * also suppress its own response send — provider request ids restart per
 * document, so a result (or error) that lands after a navigation could
 * satisfy a reused id in the replacement document.
 */

const { createDocument, createElement } = require('../../../test/helpers/fake-dom.js');

const originalWindow = global.window;
const originalDocument = global.document;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const SAFE_WALLET_INDEX = 1000;

// [processId, routingId] of the guest's main frame and of a sub-frame.
const MAIN_FRAME = [7, 4];
const SUB_FRAME = [8, 5];

const loadProvider = async (options = {}) => {
  jest.resetModules();

  const state = {
    permission: options.permission ?? null,
  };
  // Grants by site, for tests with more than one webview. When given, it
  // answers every key (an unlisted site has no grant).
  const permissionsByKey = options.permissionsByKey ?? null;

  const walletMocks = {
    getDerivedWallets: jest.fn(async () => ({ success: true, wallets: [] })),
    safeMessageStart: jest.fn(async () => ({
      success: true,
      state: { complete: true, token: 'tok' },
    })),
    safeMessageComplete: jest.fn(async () => ({ success: true, signature: '0xsig' })),
    signMessage: jest.fn(async () => ({ success: true, signature: '0xeoa' })),
    signTypedData: jest.fn(async () => ({ success: true, signature: '0xeoa' })),
    // Main's reading of what a request signs (freedom-core #88, #89).
    messageView: jest.fn(async (message) => {
      const utils = require('../../main/wallet/signing-utils.js');
      try {
        const bytes = utils.messageToBytes(utils.normalizeMessage(message));
        return { success: true, hex: '0x' + bytes.toString('hex'), rawHash: utils.signsRawHash(message) };
      } catch (err) {
        return { success: false, error: err.message };
      }
    }),
    typedDataView: jest.fn(async () => ({
      success: true,
      hash: '0x' + '11'.repeat(32),
      view: { domain: {}, types: {}, primary_type: 'M', message: {}, ignored: [], named_type: 'match', chain: 'match' },
      warnings: options.typedDataWarnings ?? [],
    })),
    requestChain: jest.fn(async () => ({ success: true, result: '0xfeed' })),
    confirmSigning: jest.fn(async () => ({ success: true, token: 'confirm-token' })),
    getGasPrice: jest.fn(async () => ({ success: true, type: 'legacy', gasPrice: '7' })),
    estimateGas: jest.fn(async () => ({ success: true, gasLimit: '50000' })),
    dappSendTransaction: jest.fn(async () => ({ success: true, hash: '0xtx' })),
  };

  const dappPermissions = {
    getPermission: jest.fn(async (key) =>
      permissionsByKey ? permissionsByKey[key] ?? null : state.permission),
    updateLastUsed: jest.fn(async () => {}),
    isTransactionAutoApproved: jest.fn(async () => options.txAutoApproved ?? false),
  };

  global.window = {
    electronAPI: {
      getSettings: jest.fn(async () => ({ enableIdentityWallet: true })),
    },
    addEventListener: jest.fn(),
    dappPermissions,
    wallet: walletMocks,
    networks: {
      getChains: jest.fn(async () => ({
        success: true,
        chains: { 1: { name: 'Ethereum' }, 100: { name: 'Gnosis' } },
      })),
      isChainAvailable: jest.fn(async () => ({ available: true })),
    },
    identity: { getStatus: jest.fn(async () => ({ isUnlocked: true })) },
  };

  // The address bar shows the *visible* tab. Requests must never be
  // attributed to it (#764) — each webview's own committed display URL
  // (tabs.js' getDisplayUrlForWebview, mocked below) is the identity.
  const addressInput = createElement('input');
  addressInput.value = options.addressBar ?? 'https://app.example';
  global.document = createDocument({ elementsById: { 'address-input': addressInput } });

  const walletUi = {
    showDappConnect: jest.fn(),
    getSelectedChainId: jest.fn(() => 100),
    setSelectedChainId: jest.fn(),
    updateConnectionBanner: jest.fn(),
    showDappTxApproval: jest.fn(),
    showDappSignApproval: jest.fn(),
    showVaultUnlock: jest.fn(),
    updateSwarmConnectionBanner: jest.fn(),
    updateX402ConnectionBanner: jest.fn(),
  };
  jest.doMock('./wallet-ui.js', () => walletUi);
  jest.doMock('./wallet/dapp-tx.js', () => ({
    buildDappTxContext: jest.fn(),
    extractSelector: jest.fn((data) => (data && data.length >= 10 ? data.slice(0, 10) : null)),
  }));
  jest.doMock('./wallet/wallet-utils.js', () => ({
    isSafeAccount: jest.fn((index) => index >= SAFE_WALLET_INDEX),
    GNOSIS_CHAIN_ID: 100,
  }));
  const safeSigning = {
    openSafeMessageBoard: jest.fn(),
    abandonSafeMessageBoard: jest.fn(),
  };
  jest.doMock('./wallet/safe-signing.js', () => safeSigning);
  jest.doMock('./origin-utils.js', () => ({
    ...jest.requireActual('./origin-utils.js'),
    getPermissionKey: jest.fn((url) => url || null),
  }));
  // Navigation's hash/CID/key -> name map (state.knownEnsNames).
  const knownEnsNames = new Map();
  jest.doMock('./state.js', () => ({ state: { knownEnsNames } }));
  const committedDisplayUrls = new Map();
  const tabs = {
    getDisplayUrlForWebview: jest.fn((wv) => committedDisplayUrls.get(wv) ?? ''),
  };
  jest.doMock('./tabs.js', () => tabs);

  const mod = await import('./dapp-provider.js');
  // Let the async settings read land so the feature gate opens.
  await flushMicrotasks();

  // A tab's webview, attached as guest webContents `webContentsId`, with
  // `url` committed (its tab's committedDisplayUrl).
  const addWebview = ({ url, webContentsId }) => {
    const wv = createElement('webview');
    wv.send = jest.fn();
    wv.getURL = jest.fn(() => url);
    wv.getWebContentsId = jest.fn(() => webContentsId);
    committedDisplayUrls.set(wv, url);
    mod.setupWebviewProvider(wv);
    return wv;
  };
  // The guest's main frame commits, as Electron reports it before any
  // message from the new document (see guest-main-frame.js).
  const commitMainFrameOf = (wv, [frameProcessId, frameRoutingId], isMainFrame = true) => {
    wv.dispatch('did-frame-navigate', { isMainFrame, frameProcessId, frameRoutingId });
  };
  const sendRequestFrom = (wv, request, frameId = MAIN_FRAME) => {
    wv.dispatch('ipc-message', {
      channel: 'dapp:provider-request',
      frameId,
      args: [request],
    });
  };

  const webview = addWebview({
    url: options.webviewUrl || 'https://app.example',
    webContentsId: 42,
  });
  const commitMainFrame = (frame, isMainFrame) => commitMainFrameOf(webview, frame, isMainFrame);
  if (options.mainFrameCommitted !== false) commitMainFrame(MAIN_FRAME);

  const sendRequest = (request, frameId = MAIN_FRAME) => sendRequestFrom(webview, request, frameId);

  return {
    mod,
    webview,
    addWebview,
    commitMainFrameOf,
    sendRequestFrom,
    sendRequest,
    commitMainFrame,
    state,
    walletMocks,
    dappPermissions,
    safeSigning,
    walletUi,
    knownEnsNames,
  };
};

const responsesSentTo = (webview) =>
  webview.send.mock.calls.filter(([channel]) => channel === 'dapp:provider-response');

const safePermission = () => ({
  walletIndex: SAFE_WALLET_INDEX,
  chainId: 100,
  autoApprove: { signing: true },
});

describe('dapp-provider document binding', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('delivers a Safe signature to the document that requested it', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });

    sendRequest({ id: 1, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    expect(walletMocks.safeMessageStart).toHaveBeenCalled();
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: '0xsig',
      error: null,
    });
  });

  test('a Safe signature that completes after navigation is never delivered', async () => {
    const completion = deferred();
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageComplete.mockReturnValue(completion.promise);

    sendRequest({ id: 2, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();
    expect(walletMocks.safeMessageComplete).toHaveBeenCalled();

    // The webview commits a navigation while the signing path is in flight.
    webview.dispatch('did-navigate', { url: 'https://evil.example' });

    completion.resolve({ success: true, signature: '0xsig' });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a signing error that arrives after navigation is never delivered', async () => {
    const completion = deferred();
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageComplete.mockReturnValue(completion.promise);

    sendRequest({ id: 3, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    webview.dispatch('did-navigate', { url: 'https://evil.example' });

    completion.resolve({ success: false, error: 'signing failed' });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('webview destruction mid-request also suppresses delivery', async () => {
    const completion = deferred();
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageComplete.mockReturnValue(completion.promise);

    sendRequest({ id: 4, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    webview.dispatch('destroyed', {});

    completion.resolve({ success: true, signature: '0xsig' });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('the signing board is opened for the requesting webview and withdrawn on navigation', async () => {
    const { webview, sendRequest, walletMocks, safeSigning } = await loadProvider({
      permission: safePermission(),
    });
    walletMocks.safeMessageStart.mockResolvedValue({
      success: true,
      state: { complete: false, token: 'tok' },
    });
    safeSigning.openSafeMessageBoard.mockReturnValue(new Promise(() => {}));

    sendRequest({ id: 5, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();
    expect(safeSigning.openSafeMessageBoard).toHaveBeenCalledWith(
      SAFE_WALLET_INDEX,
      { complete: false, token: 'tok' },
      webview
    );

    webview.dispatch('did-navigate', { url: 'https://other.example' });

    expect(safeSigning.abandonSafeMessageBoard).toHaveBeenCalledWith(webview);
  });

  test('webview destruction also withdraws the signing board', async () => {
    const { webview, safeSigning } = await loadProvider({ permission: safePermission() });

    webview.dispatch('destroyed', {});

    expect(safeSigning.abandonSafeMessageBoard).toHaveBeenCalledWith(webview);
  });

  test('a fresh request from the replacement document still gets its response', async () => {
    const { webview, sendRequest } = await loadProvider({
      permission: safePermission(),
    });

    webview.dispatch('did-navigate', { url: 'https://other.example' });

    sendRequest({ id: 1, method: 'eth_chainId', params: [] });
    await flushMicrotasks();

    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: '0x64',
      error: null,
    });
  });
});

describe('dapp-provider onchain application binding', () => {
  const APP_URL = 'web3://0x00000095643cffA7d9faE407A84Dfcb6406456C6.eip155-1/';

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('reports the chain encoded in the app origin', async () => {
    const { webview, sendRequest } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({ id: 10, method: 'eth_chainId', params: [] });
    sendRequest({ id: 11, method: 'net_version', params: [] });
    await flushMicrotasks();

    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 10,
      result: '0x1',
      error: null,
    });
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 11,
      result: '1',
      error: null,
    });
  });

  test('routes read calls to the app origin chain, not the globally selected chain', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({ id: 12, method: 'eth_call', params: [{ to: '0x1', data: '0x' }, 'latest'] });
    await flushMicrotasks();

    expect(walletMocks.requestChain).toHaveBeenCalledWith(
      1,
      'eth_call',
      [{ to: '0x1', data: '0x' }, 'latest'],
      { origin: APP_URL.toLowerCase() }
    );
    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 12,
      result: '0xfeed',
      error: null,
    });
  });

  test('pins the connect approval UI to the origin chain', async () => {
    const { sendRequest, walletUi } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({ id: 13, method: 'eth_requestAccounts', params: [] });
    await flushMicrotasks();

    expect(walletUi.setSelectedChainId).toHaveBeenCalledWith(1);
    expect(walletUi.showDappConnect).toHaveBeenCalled();
  });

  test('rejects switching an onchain app away from its origin chain', async () => {
    const { webview, sendRequest } = await loadProvider({ webviewUrl: APP_URL });

    sendRequest({
      id: 14,
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x64' }],
    });
    await flushMicrotasks();

    expect(webview.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 14,
      result: null,
      error: {
        code: 4200,
        message: 'This onchain application is pinned to chain 1.',
        data: undefined,
      },
    });
  });

  test('does not forward global wallet chain changes into a pinned app', async () => {
    const { mod, webview } = await loadProvider({ webviewUrl: APP_URL });

    mod.emitChainChanged(webview, '0x64');

    expect(webview.send).not.toHaveBeenCalledWith('dapp:provider-event', {
      event: 'chainChanged',
      data: '0x64',
    });
  });
});

// Audit O-6 (#433): with nodeIntegrationInSubFrames a compromised iframe
// renderer still has ipcRenderer.sendToHost. Its provider requests must not
// be handled under the top page's permission key and wallet grants.
describe('dapp-provider only serves the guest main frame', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  test('a signing request from a sub-frame is dropped before any grant is read', async () => {
    const { webview, sendRequest, walletMocks, dappPermissions } = await loadProvider({
      permission: safePermission(),
    });

    sendRequest({ id: 1, method: 'personal_sign', params: ['0xdead', '0xsafe'] }, SUB_FRAME);
    await flushMicrotasks();

    expect(dappPermissions.getPermission).not.toHaveBeenCalled();
    expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a connect request from a sub-frame never opens the connect prompt', async () => {
    const { webview, sendRequest, walletUi } = await loadProvider();

    sendRequest({ id: 2, method: 'eth_requestAccounts', params: [] }, SUB_FRAME);
    await flushMicrotasks();

    expect(walletUi.showDappConnect).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  // Composition with the O-7 main-side signing confirmation (#446): the frame
  // gate sits in front of the whole request path, so a top-frame transaction
  // still reaches the approval UI (whose Confirm mints the token), and a
  // sub-frame one reaches neither the UI nor main's auto-approve check.
  test('a top-frame eth_sendTransaction still reaches the approval UI', async () => {
    const { sendRequest, walletUi, walletMocks } = await loadProvider({
      permission: { walletIndex: 0, chainId: 100, autoApprove: {} },
    });
    const tx = { to: '0xc0ffee', value: '0x1' };

    sendRequest({ id: 20, method: 'eth_sendTransaction', params: [tx] });
    await flushMicrotasks();

    expect(walletUi.showDappTxApproval).toHaveBeenCalledWith(
      expect.anything(), 'https://app.example', tx, 100
    );
    expect(walletMocks.dappSendTransaction).not.toHaveBeenCalled();
  });

  test('a top-frame auto-approved eth_sendTransaction still signs via main', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: { walletIndex: 0, chainId: 100, autoApprove: {} },
      txAutoApproved: true,
    });
    const data = '0x095ea7b3' + '00'.repeat(64);

    sendRequest({ id: 21, method: 'eth_sendTransaction', params: [{ to: '0xc0ffee', data }] });
    await flushMicrotasks();

    expect(walletMocks.dappSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xc0ffee', data, chainId: 100 }),
      0,
      undefined,
      { autoApprove: 'https://app.example', webContentsId: 42 }
    );
    expect(responsesSentTo(webview)).toEqual([
      ['dapp:provider-response', { id: 21, result: '0xtx', error: null }],
    ]);
  });

  // D13: a phone account's payment whose answer was lost may have been sent.
  // The site hears that its outcome is unknown, never 4001 ("rejected"),
  // which would invite the same request again.
  const SITE_UNKNOWN = {
    code: -32603,
    message:
      "The payment's outcome is unknown: it may have been sent. Check the wallet before retrying.",
    data: { outcome: 'unknown' },
  };

  test("an auto-approved payment whose phone answer was lost tells the site it's unknown", async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: { walletIndex: 0, chainId: 100, autoApprove: {} },
      txAutoApproved: true,
    });
    walletMocks.dappSendTransaction.mockResolvedValue({
      success: false,
      code: 'REMOTE_OUTCOME_UNKNOWN',
      error: "No answer came back from your phone, so it's unknown whether this payment was sent.",
    });
    const data = '0x095ea7b3' + '00'.repeat(64);

    sendRequest({ id: 24, method: 'eth_sendTransaction', params: [{ to: '0xc0ffee', data }] });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toEqual([
      ['dapp:provider-response', { id: 24, result: null, error: SITE_UNKNOWN }],
    ]);
  });

  test('any other auto-approved failure reaches the site as before', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: { walletIndex: 0, chainId: 100, autoApprove: {} },
      txAutoApproved: true,
    });
    walletMocks.dappSendTransaction.mockResolvedValue({
      success: false,
      code: 'REMOTE_USER_REJECTED',
      error: 'Request rejected on your phone.',
    });
    const data = '0x095ea7b3' + '00'.repeat(64);

    sendRequest({ id: 25, method: 'eth_sendTransaction', params: [{ to: '0xc0ffee', data }] });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toEqual([
      [
        'dapp:provider-response',
        {
          id: 25,
          result: null,
          error: { code: -32603, message: 'Request rejected on your phone.', data: undefined },
        },
      ],
    ]);
  });

  test("the approval's unknown outcome reaches the site as it is", async () => {
    const { webview, sendRequest, walletUi } = await loadProvider({
      permission: { walletIndex: 0, chainId: 100, autoApprove: {} },
    });
    walletUi.showDappTxApproval.mockRejectedValue({ ...SITE_UNKNOWN });

    sendRequest({
      id: 26,
      method: 'eth_sendTransaction',
      params: [{ to: '0xc0ffee', value: '0x1' }],
    });
    await flushMicrotasks();

    expect(responsesSentTo(webview)).toEqual([
      ['dapp:provider-response', { id: 26, result: null, error: SITE_UNKNOWN }],
    ]);
  });

  test('a sub-frame eth_sendTransaction reaches neither the approval UI nor main', async () => {
    const { webview, sendRequest, walletUi, walletMocks, dappPermissions } = await loadProvider({
      permission: { walletIndex: 0, chainId: 100, autoApprove: {} },
      txAutoApproved: true,
    });
    const data = '0x095ea7b3' + '00'.repeat(64);

    sendRequest({ id: 22, method: 'eth_sendTransaction', params: [{ to: '0xc0ffee', data }] }, SUB_FRAME);
    sendRequest({ id: 23, method: 'eth_sendTransaction', params: [{ to: '0xc0ffee' }] }, SUB_FRAME);
    await flushMicrotasks();

    expect(dappPermissions.getPermission).not.toHaveBeenCalled();
    expect(walletUi.showDappTxApproval).not.toHaveBeenCalled();
    expect(walletMocks.confirmSigning).not.toHaveBeenCalled();
    expect(walletMocks.dappSendTransaction).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a message without a frameId is dropped', async () => {
    const { webview, walletMocks } = await loadProvider({
      permission: safePermission(),
    });

    webview.dispatch('ipc-message', {
      channel: 'dapp:provider-request',
      args: [{ id: 3, method: 'personal_sign', params: ['0xdead', '0xsafe'] }],
    });
    await flushMicrotasks();

    expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('nothing is served before the main frame has committed', async () => {
    const { webview, sendRequest, walletMocks } = await loadProvider({
      permission: safePermission(),
      mainFrameCommitted: false,
    });

    sendRequest({ id: 4, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toHaveLength(0);
  });

  test('a sub-frame commit does not re-point the main frame', async () => {
    const { webview, sendRequest, commitMainFrame, walletMocks } = await loadProvider({
      permission: safePermission(),
    });

    commitMainFrame(SUB_FRAME, false);
    sendRequest({ id: 5, method: 'personal_sign', params: ['0xdead', '0xsafe'] }, SUB_FRAME);
    await flushMicrotasks();
    expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();

    sendRequest({ id: 6, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();
    expect(responsesSentTo(webview)).toEqual([
      ['dapp:provider-response', { id: 6, result: '0xsig', error: null }],
    ]);
  });

  test('follows the main frame across a cross-process commit', async () => {
    const { webview, sendRequest, commitMainFrame, walletMocks } = await loadProvider({
      permission: safePermission(),
    });
    const NEXT_MAIN_FRAME = [9, 4];

    commitMainFrame(NEXT_MAIN_FRAME);
    // The previous main frame's [processId, routingId] no longer counts.
    sendRequest({ id: 7, method: 'personal_sign', params: ['0xdead', '0xsafe'] }, MAIN_FRAME);
    await flushMicrotasks();
    expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();

    sendRequest({ id: 8, method: 'personal_sign', params: ['0xdead', '0xsafe'] }, NEXT_MAIN_FRAME);
    await flushMicrotasks();
    expect(responsesSentTo(webview)).toEqual([
      ['dapp:provider-response', { id: 8, result: '0xsig', error: null }],
    ]);
  });
});

// Security audit O-7: main signs only against a confirmation token or its
// own reading of the site's auto-approve policy. The renderer's side of
// that contract: auto-approved requests say so (and carry no token), and a
// user approval mints a token bound to exactly what is signed.
describe('dapp-provider signing authorization', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const eoaPermission = (autoApprove = {}) => ({ walletIndex: 0, chainId: 100, autoApprove });

  test('an auto-approved personal_sign asks main to check the site policy, with no token', async () => {
    const { sendRequest, walletMocks, walletUi } = await loadProvider({
      permission: eoaPermission({ signing: true }),
    });

    sendRequest({ id: 1, method: 'personal_sign', params: ['0xdead', '0xeoa'] });
    await flushMicrotasks();

    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(walletMocks.confirmSigning).not.toHaveBeenCalled();
    expect(walletMocks.signMessage).toHaveBeenCalledWith('0xdead', 0, {
      autoApprove: 'https://app.example',
      webContentsId: 42,
    });
  });

  test('an auto-approved Safe signature asks main to check the site policy', async () => {
    const { sendRequest, walletMocks } = await loadProvider({ permission: safePermission() });

    sendRequest({ id: 1, method: 'personal_sign', params: ['0xdead', '0xsafe'] });
    await flushMicrotasks();

    expect(walletMocks.confirmSigning).not.toHaveBeenCalled();
    expect(walletMocks.safeMessageStart.mock.calls[0][4]).toEqual({
      autoApprove: 'https://app.example',
      webContentsId: 42,
    });
  });

  test('an auto-approved transaction asks main to check the site rules, with no token', async () => {
    const { sendRequest, walletMocks, walletUi } = await loadProvider({
      permission: eoaPermission(),
      txAutoApproved: true,
    });
    const data = '0x095ea7b3' + '00'.repeat(64);

    sendRequest({ id: 1, method: 'eth_sendTransaction', params: [{ to: '0xc0ffee', data }] });
    await flushMicrotasks();

    expect(walletUi.showDappTxApproval).not.toHaveBeenCalled();
    expect(walletMocks.confirmSigning).not.toHaveBeenCalled();
    expect(walletMocks.dappSendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xc0ffee', data, chainId: 100 }),
      0,
      undefined,
      { autoApprove: 'https://app.example', webContentsId: 42 }
    );
  });

  test('a user-approved signature mints a token for exactly that payload', async () => {
    const { mod, walletMocks } = await loadProvider();
    const typedData = { domain: { chainId: 100 }, message: { a: 1 } };

    await mod.executeSign('eth_signTypedData_v4', ['0xeoa', typedData], 0, 'https://app.example', null);

    expect(walletMocks.confirmSigning).toHaveBeenCalledWith('sign-typed-data', 0, typedData);
    expect(walletMocks.signTypedData).toHaveBeenCalledWith(
      typedData,
      0,
      { confirmation: 'confirm-token' },
      { chainId: undefined }
    );
  });

  test('a user-approved Safe signature mints a safe-message token', async () => {
    const { mod, walletMocks } = await loadProvider();
    const params = ['0xdead', '0xsafe'];

    await mod.executeSign('personal_sign', params, SAFE_WALLET_INDEX, 'https://app.example', null);

    expect(walletMocks.confirmSigning).toHaveBeenCalledWith('safe-message', SAFE_WALLET_INDEX, {
      method: 'personal_sign',
      params,
    });
    expect(walletMocks.safeMessageStart.mock.calls[0][4]).toEqual({ confirmation: 'confirm-token' });
  });

  test('a refused confirmation signs nothing', async () => {
    const { mod, walletMocks } = await loadProvider();
    walletMocks.confirmSigning.mockResolvedValueOnce({ success: false, error: 'Message is required' });

    await expect(
      mod.executeSign('personal_sign', ['0xdead'], 0, 'https://app.example', null)
    ).rejects.toThrow('Message is required');
    expect(walletMocks.signMessage).not.toHaveBeenCalled();
  });
});

// #764: a request is attributed to the webview that sent it — its own
// committed page — never to the site in the address bar, which shows the
// visible tab. A background tab must not borrow the visible site's
// connection, its auto-approve rules, or its name on the prompt.
describe('dapp-provider attributes requests to the requesting webview', () => {
  const VISIBLE = 'https://trusted-dapp.example';
  const BACKGROUND = 'https://attacker.example';
  const TX_DATA = '0x095ea7b3' + '00'.repeat(64);

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  // The visible tab (the default webview, guest 42) is on the trusted dApp,
  // which the user connected with signing and transaction auto-approve; a
  // background tab (guest 77) is on another site. The address bar shows the
  // trusted dApp.
  const twoTabs = async ({ backgroundPermission = null, ...options } = {}) => {
    const ctx = await loadProvider({
      webviewUrl: VISIBLE,
      addressBar: VISIBLE,
      permissionsByKey: {
        [VISIBLE]: { walletIndex: 0, chainId: 100, autoApprove: { signing: true } },
        ...(backgroundPermission ? { [BACKGROUND]: backgroundPermission } : {}),
      },
      ...options,
    });
    ctx.mod.setActiveWebview(ctx.webview);
    const background = ctx.addWebview({ url: BACKGROUND, webContentsId: 77 });
    ctx.commitMainFrameOf(background, MAIN_FRAME);
    ctx.walletMocks.getDerivedWallets.mockResolvedValue({
      success: true,
      wallets: [
        { index: 0, address: '0xvisible' },
        { index: 3, address: '0xbackground' },
      ],
    });
    // The visible site has a transaction rule for every contract.
    ctx.dappPermissions.isTransactionAutoApproved.mockImplementation(async (key) => key === VISIBLE);
    return { ...ctx, background };
  };

  test('eth_accounts from an unconnected background tab returns no account', async () => {
    const { background, sendRequestFrom, dappPermissions } = await twoTabs();

    sendRequestFrom(background, { id: 1, method: 'eth_accounts' });
    await flushMicrotasks();

    expect(dappPermissions.getPermission).toHaveBeenCalledWith(BACKGROUND);
    expect(dappPermissions.getPermission).not.toHaveBeenCalledWith(VISIBLE);
    expect(background.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: [],
      error: null,
    });
  });

  test('eth_accounts from a connected background tab returns only its own account', async () => {
    const { background, sendRequestFrom } = await twoTabs({
      backgroundPermission: { walletIndex: 3, chainId: 100, autoApprove: {} },
    });

    sendRequestFrom(background, { id: 1, method: 'eth_accounts' });
    await flushMicrotasks();

    expect(background.send).toHaveBeenCalledWith('dapp:provider-response', {
      id: 1,
      result: ['0xbackground'],
      error: null,
    });
  });

  test('personal_sign from an unconnected background tab is refused, not auto-signed under the visible site', async () => {
    const { background, sendRequestFrom, walletMocks, walletUi } = await twoTabs();

    sendRequestFrom(background, { id: 1, method: 'personal_sign', params: ['0xdead', '0xvisible'] });
    await flushMicrotasks();

    expect(walletMocks.signMessage).not.toHaveBeenCalled();
    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(background.send).toHaveBeenCalledWith(
      'dapp:provider-response',
      expect.objectContaining({ id: 1, result: null, error: expect.objectContaining({ code: 4100 }) })
    );
  });

  test('a connected background tab without auto-approve gets a prompt naming its own site', async () => {
    const { background, sendRequestFrom, walletMocks, walletUi } = await twoTabs({
      backgroundPermission: { walletIndex: 3, chainId: 100, autoApprove: {} },
    });

    sendRequestFrom(background, { id: 1, method: 'personal_sign', params: ['0xdead', '0xbackground'] });
    await flushMicrotasks();

    expect(walletMocks.signMessage).not.toHaveBeenCalled();
    expect(walletUi.showDappSignApproval).toHaveBeenCalledWith(
      background, BACKGROUND, 'personal_sign', ['0xdead', '0xbackground']);
  });

  test('eth_sendTransaction from a background tab never applies the visible site’s rules', async () => {
    const { background, sendRequestFrom, walletMocks, walletUi, dappPermissions } = await twoTabs({
      backgroundPermission: { walletIndex: 3, chainId: 100, autoApprove: {} },
    });

    sendRequestFrom(background, {
      id: 1,
      method: 'eth_sendTransaction',
      params: [{ to: '0xc0ffee', data: TX_DATA }],
    });
    await flushMicrotasks();

    expect(dappPermissions.isTransactionAutoApproved).toHaveBeenCalledWith(
      BACKGROUND, '0xc0ffee', '0x095ea7b3', 100);
    expect(dappPermissions.isTransactionAutoApproved).not.toHaveBeenCalledWith(
      VISIBLE, expect.anything(), expect.anything(), expect.anything());
    expect(walletMocks.dappSendTransaction).not.toHaveBeenCalled();
    expect(walletUi.showDappTxApproval).toHaveBeenCalledWith(
      background, BACKGROUND, expect.objectContaining({ to: '0xc0ffee' }), 100);
  });

  test('eth_requestAccounts from a background tab prompts with its own site', async () => {
    const { background, sendRequestFrom, walletUi } = await twoTabs();

    sendRequestFrom(background, { id: 1, method: 'eth_requestAccounts' });
    await flushMicrotasks();

    expect(walletUi.showDappConnect).toHaveBeenCalledWith(
      BACKGROUND, BACKGROUND, expect.any(Function), expect.any(Function), background);
  });

  test('the visible tab’s own auto-approved request carries its own guest id to main', async () => {
    const { webview, sendRequestFrom, walletMocks } = await twoTabs();

    sendRequestFrom(webview, { id: 1, method: 'personal_sign', params: ['0xdead', '0xvisible'] });
    await flushMicrotasks();

    expect(walletMocks.signMessage).toHaveBeenCalledWith('0xdead', 0, {
      autoApprove: VISIBLE,
      webContentsId: 42,
    });
  });

  test('a page with no committed identity is attributed to no site, not the address bar', async () => {
    const { addWebview, commitMainFrameOf, sendRequestFrom, walletUi, walletMocks } = await twoTabs();
    const fresh = addWebview({ url: '', webContentsId: 88 });
    commitMainFrameOf(fresh, MAIN_FRAME);

    sendRequestFrom(fresh, { id: 1, method: 'personal_sign', params: ['0xdead', '0xvisible'] });
    await flushMicrotasks();

    expect(walletMocks.signMessage).not.toHaveBeenCalled();
    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(fresh.send).toHaveBeenCalledWith(
      'dapp:provider-response',
      expect.objectContaining({ error: expect.objectContaining({ code: 4100 }) })
    );
  });

  // A DNS-named ENS site over IPNS commits as ipns://<key> but is shown as
  // ens://example.com; it keeps the name key its grants were stored under
  // before #764, and main cross-checks the name against the guest's key.
  test('a DNS-named ENS site over IPNS is keyed on its name, not its IPNS key', async () => {
    const B58 = '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX';
    const B36 = 'k51qzi5uqu5dgkkr5wjh0m796f9u3tou74wn2q2u3shgh6yn52ce4hitig3if4';
    const NAMED = 'ens://example.com/';
    const { mod, addWebview, commitMainFrameOf, sendRequestFrom, walletUi, dappPermissions, knownEnsNames } =
      await twoTabs({
        backgroundPermission: null,
        permissionsByKey: {
          [VISIBLE]: { walletIndex: 0, chainId: 100, autoApprove: { signing: true } },
          [NAMED]: { walletIndex: 3, chainId: 100, autoApprove: {} },
        },
      });
    knownEnsNames.set(B58, 'example.com');
    const ipnsTab = addWebview({ url: `ipns://${B36}/`, webContentsId: 91 });
    commitMainFrameOf(ipnsTab, MAIN_FRAME);

    sendRequestFrom(ipnsTab, { id: 1, method: 'personal_sign', params: ['0xdead', '0xbackground'] });
    await flushMicrotasks();

    expect(dappPermissions.getPermission).toHaveBeenCalledWith(NAMED);
    expect(dappPermissions.getPermission).not.toHaveBeenCalledWith(`ipns://${B36}/`);
    expect(walletUi.showDappSignApproval).toHaveBeenCalledWith(
      ipnsTab, NAMED, 'personal_sign', ['0xdead', '0xbackground']);

    // The banner keys the same way; the Swarm/x402 banners read the page URL.
    mod.setActiveWebview(ipnsTab);
    expect(mod.getActiveDisplayUrl()).toBe(NAMED);
    expect(mod.getActivePageUrl()).toBe(`ipns://${B36}/`);
  });

  test('getActiveDisplayUrl reads the visible tab’s committed page, not the address bar', async () => {
    const { mod, background } = await twoTabs({ addressBar: 'half-typed draft' });

    expect(mod.getActiveDisplayUrl()).toBe(VISIBLE);
    mod.setActiveWebview(background);
    expect(mod.getActiveDisplayUrl()).toBe(BACKGROUND);
  });
});

// #89: a personal_sign of exactly 32 bytes always shows its prompt (with
// the warning), even with signing auto-approve, whatever the account.
// Other lengths and typed data are auto-signed as before.
describe('dapp-provider: the 32-byte prompt', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const autoSigning = (walletIndex) => ({ walletIndex, chainId: 100, autoApprove: { signing: true } });

  test.each([
    ['hex', '0x' + 'ab'.repeat(32)],
    ['text', 'z'.repeat(32)],
  ])('a 32-byte message as %s prompts under auto-approve, on every account kind', async (_label, message) => {
    for (const walletIndex of [0, 1000000, SAFE_WALLET_INDEX]) {
      const { sendRequest, walletUi, walletMocks } = await loadProvider({ permission: autoSigning(walletIndex) });
      sendRequest({ id: 1, method: 'personal_sign', params: [message, '0xaccount'] });
      await flushMicrotasks();

      expect(walletUi.showDappSignApproval).toHaveBeenCalledWith(
        expect.anything(), 'https://app.example', 'personal_sign', [message, '0xaccount'],
        expect.objectContaining({ warned: true, message: expect.objectContaining({ rawHash: true }) })
      );
      expect(walletMocks.signMessage).not.toHaveBeenCalled();
      expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();
    }
  });

  test.each([
    ['31 bytes', '0x' + 'ab'.repeat(31)],
    ['33 bytes', '0x' + 'ab'.repeat(33)],
    ['31 bytes of text', 'z'.repeat(31)],
  ])('%s are auto-signed with no prompt, as before', async (_label, message) => {
    const { webview, sendRequest, walletUi, walletMocks } = await loadProvider({ permission: autoSigning(0) });
    sendRequest({ id: 2, method: 'personal_sign', params: [message, '0xaccount'] });
    await flushMicrotasks();

    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(walletMocks.signMessage).toHaveBeenCalledWith(message, 0, { autoApprove: 'https://app.example', webContentsId: 42 });
    expect(responsesSentTo(webview)).toEqual([
      ['dapp:provider-response', { id: 2, result: '0xeoa', error: null }],
    ]);
  });

  test('typed data without a warning is auto-signed with no prompt, as before', async () => {
    const { sendRequest, walletUi, walletMocks } = await loadProvider({ permission: autoSigning(0) });
    const typed = JSON.stringify({ domain: { chainId: 100 }, types: { M: [] }, message: {} });
    sendRequest({ id: 3, method: 'eth_signTypedData_v4', params: ['0xaccount', typed] });
    await flushMicrotasks();

    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(walletMocks.signTypedData).toHaveBeenCalledWith(
      typed,
      0,
      { autoApprove: 'https://app.example', webContentsId: 42 },
      { chainId: 100 }
    );
  });
});

// freedom-core #88: main's view of what a request signs comes before any
// prompt, for every account kind; a request main can't show fails before
// it; a warned request always prompts, even under signing auto-approve.
describe('dapp-provider: the view before the prompt', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    global.window = originalWindow;
    global.document = originalDocument;
    jest.restoreAllMocks();
  });

  const TYPED = JSON.stringify({ domain: { chainId: 100 }, types: { M: [] }, primaryType: 'M', message: {} });
  const permissionFor = (walletIndex, autoApprove = {}) => ({ walletIndex, chainId: 100, autoApprove });

  test.each([
    ['a vault account', 0],
    ['a Ledger account', 1000000],
    ['a phone account', 1000001],
    ['a Safe account', SAFE_WALLET_INDEX],
  ])("typed data on %s is viewed before its prompt, against the dApp's chain", async (_label, walletIndex) => {
    const { sendRequest, walletUi, walletMocks } = await loadProvider({ permission: permissionFor(walletIndex) });
    sendRequest({ id: 1, method: 'eth_signTypedData_v4', params: ['0xaccount', TYPED] });
    await flushMicrotasks();

    expect(walletMocks.typedDataView).toHaveBeenCalledWith(TYPED, 100);
    expect(walletUi.showDappSignApproval).toHaveBeenCalledWith(
      expect.anything(),
      'https://app.example',
      'eth_signTypedData_v4',
      ['0xaccount', TYPED],
      expect.objectContaining({
        chainId: 100,
        typedData: expect.objectContaining({ hash: '0x' + '11'.repeat(32), warnings: [] }),
      })
    );
    expect(walletMocks.typedDataView.mock.invocationCallOrder[0]).toBeLessThan(
      walletUi.showDappSignApproval.mock.invocationCallOrder[0]
    );
  });

  test('typed data main refuses (malformed, or a view too large for one reply) fails before any prompt', async () => {
    const { webview, sendRequest, walletUi, walletMocks } = await loadProvider({
      permission: permissionFor(0, { signing: true }),
    });
    walletMocks.typedDataView.mockResolvedValue({
      success: false,
      code: 'invalid_argument',
      error: 'invalid typed data: too large to show in one reply',
    });
    sendRequest({ id: 2, method: 'eth_signTypedData_v4', params: ['0xaccount', TYPED] });
    await flushMicrotasks();

    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(walletMocks.signTypedData).not.toHaveBeenCalled();
    expect(responsesSentTo(webview)).toEqual([
      [
        'dapp:provider-response',
        {
          id: 2,
          result: null,
          error: { code: -32603, message: 'invalid typed data: too large to show in one reply', data: undefined },
        },
      ],
    ]);
  });

  test.each([
    [['named-type']],
    [['chain-mismatch']],
    [['chain-absent']],
    [['named-type', 'chain-absent']],
  ])('a warned request (%j) prompts under auto-approve, and nothing is signed until approved', async (warnings) => {
    for (const walletIndex of [0, SAFE_WALLET_INDEX]) {
      const { sendRequest, walletUi, walletMocks } = await loadProvider({
        permission: permissionFor(walletIndex, { signing: true }),
        typedDataWarnings: warnings,
      });
      sendRequest({ id: 3, method: 'eth_signTypedData_v4', params: ['0xaccount', TYPED] });
      await flushMicrotasks();

      expect(walletUi.showDappSignApproval).toHaveBeenCalledWith(
        expect.anything(),
        'https://app.example',
        'eth_signTypedData_v4',
        ['0xaccount', TYPED],
        expect.objectContaining({ warned: true, typedData: expect.objectContaining({ warnings }) })
      );
      expect(walletMocks.signTypedData).not.toHaveBeenCalled();
      expect(walletMocks.safeMessageStart).not.toHaveBeenCalled();
    }
  });

  test('an unwarned request is still auto-signed, Safe included', async () => {
    const { sendRequest, walletUi, walletMocks } = await loadProvider({ permission: safePermission() });
    sendRequest({ id: 4, method: 'eth_signTypedData_v4', params: ['0xsafe', TYPED] });
    await flushMicrotasks();

    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(walletMocks.safeMessageStart).toHaveBeenCalled();
  });

  test('personal_sign is prepared from the bytes main sends', async () => {
    const { webview, sendRequest, walletUi, walletMocks } = await loadProvider({ permission: permissionFor(0) });
    sendRequest({ id: 5, method: 'personal_sign', params: ['0x48656c6c6f', '0xaccount'] });
    await flushMicrotasks();
    expect(walletMocks.messageView).toHaveBeenCalledWith('0x48656c6c6f');
    expect(walletUi.showDappSignApproval).toHaveBeenCalledWith(
      expect.anything(),
      'https://app.example',
      'personal_sign',
      ['0x48656c6c6f', '0xaccount'],
      expect.objectContaining({ message: { success: true, hex: '0x48656c6c6f', rawHash: false } })
    );

    // Malformed hex can't be shown, nor signed: refused before a prompt.
    walletUi.showDappSignApproval.mockClear();
    sendRequest({ id: 6, method: 'personal_sign', params: ['0x41zz42', '0xaccount'] });
    await flushMicrotasks();
    expect(walletUi.showDappSignApproval).not.toHaveBeenCalled();
    expect(responsesSentTo(webview).at(-1)[1]).toMatchObject({ id: 6, error: { message: 'Invalid hex message' } });
  });
});
