jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Capture every ipcMain.handle so the tests can drive handlers directly
// without going through Electron's IPC layer.
const ipcHandlers = {};
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
  },
  webContents: {
    fromId: jest.fn(),
  },
  // The chrome window a host webContents is: none, unless a test says so.
  BrowserWindow: {
    fromWebContents: (...args) => mockFromWebContents(...args),
  },
}));
const mockFromWebContents = jest.fn(() => null);

// The identity core (cored 0.18.0: X402-1's `x402.authorize` and
// `x402.settle`, its `x402-payment` tokens and its x402 store; X402-2),
// simulated (test/helpers/simulated-approvals.js): it mints, checks and
// spends the payment tokens, signs and charges, and holds the caps main
// reads through its mirror (core/grants.js) and revokes through
// `approval.revoke`.
const mockCore = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({ vaultBackend: { approval: mockCore.approval, x402: mockCore.x402 } }));

const mockGetActiveWalletIndex = jest.fn(() => 0);
const mockGetActiveWalletAddress = jest.fn(async () => '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => mockGetActiveWalletIndex(),
  getActiveWalletAddress: () => mockGetActiveWalletAddress(),
  // Every account here is the vault's own (a device account's index is 100+).
  getWalletRecord: () => null,
  isHardwareWalletIndex: (index) => index >= 100,
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
}));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: jest.fn() }));

// balance-service is dragged in via x402:get-details enrichment +
// x402:refresh-balances. Tests that don't care about balances default
// to empty.
const mockGetBalancesWithCache = jest.fn(async () => ({
  balances: {},
  fromCache: true,
}));
const mockGetAllBalances = jest.fn(async () => ({}));
const mockClearBalanceCache = jest.fn();
jest.mock('../wallet/balance-service', () => ({
  getBalancesWithCache: (...args) => mockGetBalancesWithCache(...args),
  getAllBalances: (...args) => mockGetAllBalances(...args),
  clearBalanceCache: (...args) => mockClearBalanceCache(...args),
}));

// Helper: balance-service entries are `{raw, formatted, symbol, decimals}`.
// Tests that want to control fundability per token pass these shapes
// through `mockGetBalancesWithCache.mockResolvedValueOnce(...)`.
function balanceEntry(raw) {
  return { raw, formatted: '0', symbol: 'USDC', decimals: 6 };
}

// Real intercept module (real Maps) — we want to exercise the
// setPending/clearDetected interactions end-to-end. Stub electron's `app`
// because intercept requires it for getInterstitialFileUrl.
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));

const mockGetToken = jest.fn();
jest.mock('../token-registry', () => ({
  getToken: (key) => mockGetToken(key),
  getTokenKey: (chainId, addr) => `${chainId}:${addr}`,
}));

const mockGetRecentReceipts = jest.fn();
jest.mock('../payment-history', () => ({
  getRecent: (...args) => mockGetRecentReceipts(...args),
  appendOnce: jest.fn(),
  reserveHistorySlot: () => ({}),
  releaseHistorySlot: jest.fn(),
  KINDS: { X402: 'x402', WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
  STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
}));

const { webContents } = require('electron');
const log = require('../logger');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');
const intercept = require('./intercept');
const { outgoingHeaderForVersion } = require('./intercept');
const { registerX402Ipc, paymentApprovalRequest } = require('./ipc');
const { requestWindowId } = require('../windows/request-window');
const confirmations = require('../wallet/signing-confirmation');
const grants = require('../core/grants');

const ORIGIN = 'https://api.example';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

// The mirror main reads caps from, loaded again from the simulated core
// (after a test seeds caps there).
const loadCaps = () => grants._useBackendForTests(mockCore.approval);

// The core's own `x402.authorize`, put back before each test: a test may
// hold its answer (`coreAnswersLater`) or refuse through it.
const coreAuthorize = mockCore.x402.authorize;

// Every payment the core signed, as it signed it: the account, the entry,
// and the window the sign ran for (`requestWindowId`, APS-5). The payload
// is the simulated core's: an EIP-3009 authorization from the account.
const signed = [];
function signPayment(params, accept) {
  signed.push({ account: params.account, accept, url: params.detection.url, window: requestWindowId() });
  const now = Math.floor(Date.now() / 1000);
  return {
    x402Version: params.requirements?.x402Version ?? 2,
    payload: {
      authorization: {
        from: '0x' + (Number(params.account) + 1).toString(16).padStart(40, '0'),
        to: accept.payTo,
        value: accept.amount,
        validAfter: String(now - 600),
        validBefore: String(now + (accept.maxTimeoutSeconds ?? 60)),
        nonce: '0x' + '11'.repeat(32),
      },
      signature: '0x' + 'ab'.repeat(65),
    },
    accepted: accept,
  };
}

const coreCalls = (method) => mockCore.calls.filter((call) => call.method === method);
// What main asked the core to pay (`x402.authorize`), signed or refused.
const corePayments = () => coreCalls('x402.authorize');
const settles = () => coreCalls('x402.settle').map(({ params }) => params);

// The core's refusal of a token presented for a payment other than the one
// it binds (`mismatch`), in main's words.
const REFUSED_AS_ANOTHER = {
  success: false,
  code: 'SIGNING_NOT_CONFIRMED',
  error: expect.stringMatching(/request differs from what was confirmed/),
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeAll(() => {
  registerX402Ipc();
});

beforeEach(async () => {
  confirmations._reset();
  intercept.clearAllDetectedPayments();
  intercept.clearAllPendingPayments();
  intercept.clearAllAwaitingResponse();
  intercept.clearAllPendingUnlockResume();
  intercept.clearAllPendingUnlockWaits();
  mockCore.reset();
  mockCore.x402.authorize = coreAuthorize;
  signed.length = 0;
  mockCore.setX402Signer(signPayment);
  mockGetActiveWalletIndex.mockReturnValue(0);
  intercept.clearAllApprovalClaims();
  CHROME.send.mockReset();
  // Every tab is one of CHROME's unless a test says otherwise.
  webContents.fromId.mockReset().mockImplementation((id) => hostedTab({ id }));
  mockGetBalancesWithCache.mockReset().mockResolvedValue({ balances: {}, fromCache: true });
  mockGetAllBalances.mockReset().mockResolvedValue({});
  mockClearBalanceCache.mockReset();
  mockGetToken.mockReset();
  mockGetRecentReceipts.mockReset().mockReturnValue([]);
  log.warn.mockClear();
  await loadCaps();
});

afterAll(() => grants._useBackendForTests(null));

const v2Detected = (overrides = {}) => ({
  url: 'https://api.example/article',
  requirements: {
    x402Version: 2,
    resource: { url: 'https://api.example/article' },
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      },
    ],
  },
  detectedAt: Date.now(),
  ...overrides,
});

const senderEvent = (id) => ({ sender: { id } });

// The chrome window whose sidebar shows the payment card, and a tab guest
// it hosts: x402:get-details and x402:approve answer only the window that
// hosts the payment's tab.
const CHROME = { id: 1, send: jest.fn() };
const fromChrome = { sender: CHROME };
function hostedTab(props = {}) {
  return {
    loadURL: jest.fn().mockResolvedValue(),
    isDestroyed: () => false,
    ...props,
    hostWebContents: { ...CHROME, ...props.hostWebContents, id: CHROME.id },
  };
}

// An auto-pay cap the core holds for api.example's USDC on Base, loaded
// into main's mirror.
async function seedCap(fields = {}) {
  mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: USDC, capAmount: '20000', ...fields });
  await loadCaps();
}

// The activity pane's revoke of that cap (the core's `approval.revoke`).
async function revokeCap() {
  expect(await ipcHandlers['x402:revoke-permission'](fromChrome, { origin: ORIGIN, chainId: 8453, asset: USDC }))
    .toEqual({ success: true });
}

// The payment as the approval card shows it for main's record of a
// detection: the subresource detection awaiting `detectionId`, else the
// tab-keyed one. What the card hands `wallet:confirm-signing` on Pay.
function paymentAsShown(tabId, { detectionId, acceptIndex = 0, grant } = {}) {
  const awaiting = detectionId ? intercept.getPendingApproval(detectionId) : null;
  const record = awaiting ?? intercept.getDetectedPayment(tabId);
  return {
    webContentsId: awaiting?.webContentsId ?? tabId,
    detectionId: detectionId ?? record.detectionId,
    url: record.url,
    acceptIndex,
    accept: record.requirements.accepts[acceptIndex],
    grant: grant ?? null,
  };
}

// The token the card mints for `payment` through `wallet:confirm-signing`:
// the core's (`approval.issue` as main), for the account main binds.
async function tokenFor(payment, walletIndex = 0) {
  return (await confirmations.issueConfirmation(confirmations.KINDS.X402_PAYMENT, walletIndex, payment)).token;
}

// Press Pay the way the card does: mint for the payment shown, then
// approve it with that token.
async function approveAsCard(tabId, opts = {}) {
  const payment = paymentAsShown(tabId, opts);
  const confirmation = await tokenFor(payment, opts.walletIndex ?? 0);
  return ipcHandlers['x402:approve'](fromChrome, {
    webContentsId: tabId,
    detectionId: payment.detectionId,
    selectedAcceptIndex: payment.acceptIndex,
    grant: opts.grant,
    confirmation,
  });
}

// A payment the core signs but answers only when the test lets it go: the
// token spent and the signature made, the reply still on its way.
function coreAnswersLater() {
  let release;
  const answered = new Promise((resolve) => {
    release = resolve;
  });
  mockCore.x402.authorize = async (params, context) => {
    const reply = await coreAuthorize(params, context);
    await answered;
    return reply;
  };
  return () => release();
}

// === outgoingHeaderForVersion ============================================

describe('outgoingHeaderForVersion', () => {
  test('V2 uses PAYMENT-SIGNATURE', () => {
    expect(outgoingHeaderForVersion(2)).toBe('PAYMENT-SIGNATURE');
  });
  test('V1 uses X-PAYMENT', () => {
    expect(outgoingHeaderForVersion(1)).toBe('X-PAYMENT');
  });
  test('unknown version defaults to V2 (newest)', () => {
    expect(outgoingHeaderForVersion(99)).toBe('PAYMENT-SIGNATURE');
  });
});

// === x402:get-details ====================================================

describe('x402:get-details', () => {
  test('returns the detected payment for the sender tab', async () => {
    intercept.detectedPaymentsForTest?.(); // no-op safety
    // Set up state via the public setter path that the real detector uses.
    const detected = v2Detected();
    // Push into the real Map by calling the detector — simpler than
    // reaching into internals. Skip and use the exposed clear/get APIs:
    // poke the Map directly through the module's internals.
    const internal = require('./intercept');
    // No public setter for detectedPayments; we instead call the real
    // detector path via the dispatcher handler so we exercise the same
    // entry point as production.
    internal.detectPaymentRequiredHandler({
      webContentsId: 42,
      url: detected.url,
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(detected.requirements)).toString('base64')],
      },
    });

    mockGetToken.mockReturnValueOnce({ symbol: 'USDC', decimals: 6 });

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.success).toBe(true);
    expect(result.url).toBe(detected.url);
    expect(result.requirements.x402Version).toBe(2);
    expect(result.asset).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(mockGetToken).toHaveBeenCalledWith('8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  test('returns null asset when the token is not in the allowlist', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    mockGetToken.mockReturnValueOnce(undefined);

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.success).toBe(true);
    expect(result.asset).toBeNull();
  });

  test('returns an error when no payment was detected for the tab', async () => {
    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 999 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pending/i);
  });

  test('returns an enriched accepts[] with per-entry balance + fundable + asset + autoPay', async () => {
    // Multi-accept detection: Base USDC + Gnosis USDC.e. Wallet holds
    // enough USDC for Base, not enough USDC.e for Gnosis. Chooser data
    // must reflect that asymmetry.
    const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';
    const baseAccept = v2Detected().requirements.accepts[0];
    const gnosisAccept = {
      ...baseAccept,
      network: 'eip155:100',
      amount: '20000',
      asset: GNOSIS_USDCE,
    };
    const multiAccept = {
      ...v2Detected().requirements,
      accepts: [baseAccept, gnosisAccept],
    };
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(multiAccept)).toString('base64')],
      },
    });
    mockGetToken.mockImplementation((key) => {
      if (key.startsWith('8453:')) return { symbol: 'USDC', decimals: 6 };
      if (key.startsWith('100:')) return { symbol: 'USDC.e', decimals: 6 };
      return null;
    });
    mockGetBalancesWithCache.mockResolvedValueOnce({
      balances: {
        '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': balanceEntry('50000'),  // covers 10000
        [`100:${GNOSIS_USDCE}`]: balanceEntry('1000'),                              // short of 20000
      },
      fromCache: true,
    });

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.success).toBe(true);
    expect(result.accepts).toHaveLength(2);
    expect(result.accepts[0]).toMatchObject({
      tuple: { chainId: 8453, asset: baseAccept.asset, amount: '10000' },
      asset: { symbol: 'USDC', decimals: 6 },
      balance: '50000',
      fundable: true,
    });
    expect(result.accepts[1]).toMatchObject({
      tuple: { chainId: 100, asset: GNOSIS_USDCE, amount: '20000' },
      asset: { symbol: 'USDC.e', decimals: 6 },
      balance: '1000',
      fundable: false,
    });
    // initialSelectionIndex = first fundable = 0 (Base).
    expect(result.initialSelectionIndex).toBe(0);
  });

  test('initialSelectionIndex points at the first fundable entry, even if accepts[0] is unfundable', async () => {
    const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';
    const baseAccept = v2Detected().requirements.accepts[0];
    const gnosisAccept = {
      ...baseAccept, network: 'eip155:100', amount: '5000', asset: GNOSIS_USDCE,
    };
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify({
          ...v2Detected().requirements,
          accepts: [baseAccept, gnosisAccept],
        })).toString('base64')],
      },
    });
    mockGetToken.mockReturnValue({ symbol: 'USDC', decimals: 6 });
    mockGetBalancesWithCache.mockResolvedValueOnce({
      balances: { [`100:${GNOSIS_USDCE}`]: balanceEntry('50000') },
      fromCache: true,
    });

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.accepts[0].fundable).toBe(false);
    expect(result.accepts[1].fundable).toBe(true);
    expect(result.initialSelectionIndex).toBe(1);
  });

  test('initialSelectionIndex falls back to 0 when nothing is fundable', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    mockGetBalancesWithCache.mockResolvedValueOnce({ balances: {}, fromCache: true });

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.accepts[0].fundable).toBe(false);
    expect(result.initialSelectionIndex).toBe(0);
  });

  test('kicks a fresh balance fetch after serving cached approval-card details', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    const fresh = {
      '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': balanceEntry('90000'),
    };
    mockGetBalancesWithCache.mockResolvedValueOnce({ balances: {}, fromCache: true });
    mockGetAllBalances.mockResolvedValueOnce(fresh);
    const sidebarSend = jest.fn();
    webContents.fromId.mockReturnValue(hostedTab({ hostWebContents: { send: sidebarSend } }));

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    await Promise.resolve();

    expect(result.success).toBe(true);
    expect(mockGetBalancesWithCache).toHaveBeenCalledWith(expect.any(String), false);
    expect(mockGetAllBalances).toHaveBeenCalledWith(expect.any(String));
    expect(sidebarSend).toHaveBeenCalledWith('x402:balances-updated', expect.objectContaining({
      webContentsId: 42,
      balances: fresh,
    }));
  });
});

// === x402:approve ========================================================

describe('x402:approve', () => {
  // `resourceType` is what gates the re-navigation in sign-flow. The
  // approve IPC flow is the "user clicked Pay in the sidebar after the
  // article 402'd" path — that's always a mainFrame navigation, so
  // seeding with mainFrame matches production. Subresource behaviour
  // (no tab navigation) is exercised in a dedicated test below.
  const seedDetection = (tabId = 42, resourceType = 'mainFrame') =>
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: tabId,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType,
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });

  const snapshot = () => ({
    url: 'https://api.example/article',
    requirements: v2Detected().requirements,
    resourceType: 'mainFrame',
  });

  test('has the core sign it with the card\'s token, stashes a V2 pending payment, and re-navigates the webview', async () => {
    seedDetection(42);
    const detectionId = intercept.getDetectedPayment(42).detectionId;
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL }));

    const result = await approveAsCard(42);

    expect(result.success).toBe(true);
    // The token the core minted, presented to the core's `x402.authorize`
    // for this tab, detection, URL and entry, from account 0.
    expect(coreCalls('approval.issue').map(({ params, page }) => ({ params, page }))).toEqual([
      {
        params: {
          kind: 'x402-payment',
          account: 0,
          payload: {
            detection: { tab: 42, id: detectionId, url: 'https://api.example/article' },
            accept_index: 0,
            accept: v2Detected().requirements.accepts[0],
          },
        },
        page: null,
      },
    ]);
    expect(corePayments().map(({ params, page }) => ({ params, page }))).toEqual([
      {
        params: {
          account: 0,
          detection: { tab: 42, id: detectionId, url: 'https://api.example/article' },
          requirements: v2Detected().requirements,
          authorization: { token: expect.stringMatching(/^[0-9a-f]{64}$/) },
          accept_index: 0,
        },
        page: null,
      },
    ]);
    expect(signed).toHaveLength(1);
    expect(loadURL).toHaveBeenCalledWith('https://api.example/article');

    // The pending payment is now armed for the retry; the inject handler
    // should attach PAYMENT-SIGNATURE on the matching outbound request.
    const injected = await intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: { Accept: 'text/html' },
    });
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();

    // The detected payment is cleared once we've signed it — preventing
    // a stale interstitial from re-using the requirements after the
    // re-navigation already kicked off.
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('surfaces a vault-locked error verbatim to the renderer', async () => {
    seedDetection(42);
    mockCore.setX402Locked(true);

    const result = await approveAsCard(42);
    expect(result.success).toBe(false);
    expect(result.error).toBe(VAULT_LOCKED_MESSAGE);
    expect(signed).toEqual([]);
    // No pending payment armed when signing failed.
    expect(await intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    })).toBeNull();
  });

  test('refuses to sign if there is no detected payment for the tab', async () => {
    const result = await ipcHandlers['x402:approve'](fromChrome);
    expect(result.success).toBe(false);
    expect(corePayments()).toEqual([]);
  });

  test('snapshot path (auto-pay): does NOT clear the tab-keyed detection so a newer pending approval flow survives', async () => {
    // Auto-pay captured snapshot A. Before A's setImmediate fires, a
    // second 402 (B) replaces detectedPayments[42]. When sign-flow
    // completes for A, it must not clear the map and erase B.
    seedDetection(42);  // simulate B sitting in the map
    expect(intercept.getDetectedPayment(42)).not.toBeNull();
    await seedCap();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));

    const { signAndQueueRetry } = require('./sign-flow');
    await signAndQueueRetry(42, { detection: snapshot(), authorizedBy: 'cap' });

    expect(signed).toHaveLength(1);
    // Map entry survives — whatever is in the map (e.g. B's approval
    // card) remains accessible to the IPC handlers.
    expect(intercept.getDetectedPayment(42)).not.toBeNull();
  });

  test('IPC approve path (no snapshot): does clear the tab-keyed detection on success', async () => {
    // Sanity-check that the lookup-by-id path retains its existing clear
    // behaviour.
    seedDetection(42);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    const result = await approveAsCard(42);
    expect(result.success).toBe(true);
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('an auto-pay (snapshot path) is charged by the core before it is signed, and withheld if its cap goes before the retry', async () => {
    await seedCap();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    let spentAtSign = null;
    mockCore.setX402Signer((params, accept) => {
      spentAtSign = mockCore.cap(ORIGIN, 8453, USDC).spentAmount;
      return signPayment(params, accept);
    });

    const { signAndQueueRetry } = require('./sign-flow');
    await signAndQueueRetry(42, { detection: snapshot(), authorizedBy: 'cap' });

    // A cap's payment, asked of the core with no token: #1024, the core
    // charged the cap before it signed the authorization.
    expect(corePayments().map(({ params }) => params.authorization)).toEqual([
      { cap: { agent: false, attributable: true } },
    ]);
    expect(spentAtSign).toBe('10000');
    // The cap was revoked before the retry: withheld, and its charge
    // settled back (`withheld`).
    await revokeCap();
    const injected = await intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    expect(injected).toBeNull();
    expect(settles()).toEqual([{ reservation: expect.stringMatching(/^[0-9a-f]{32}$/), outcome: 'withheld' }]);
  });

  test('an auto-pay its cap no longer covers is not signed at all', async () => {
    await seedCap({ capAmount: '9999' });

    const { signAndQueueRetry } = require('./sign-flow');
    await expect(signAndQueueRetry(42, { detection: snapshot(), authorizedBy: 'cap' }))
      .rejects.toMatchObject({ code: 'X402_CAP_NOT_COVERED' });
    expect(signed).toEqual([]);
    expect(mockCore.cap(ORIGIN, 8453, USDC).spentAmount).toBe('0');
  });

  test('IPC approve on a cap-tagged detection (vault-unlock resume path) signs with cap authorization', async () => {
    // Auto-pay was blocked by a locked vault. The detector tagged the
    // detection authorizedBy=cap (covered by an intercept.test.js test);
    // here we simulate the end state and verify that x402:approve reads
    // the tag and threads it through to signAndQueueRetry: the core
    // charges the cap as it signs, and the inject handler still withholds
    // if that cap has gone.
    seedDetection(42);
    Object.assign(intercept.getDetectedPayment(42), { authorizedBy: 'cap' });
    await seedCap();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));

    const result = await approveAsCard(42);
    expect(result.success).toBe(true);
    expect(corePayments().map(({ params }) => params.authorization)).toEqual([
      { cap: { agent: false, attributable: true } },
    ]);
    expect(mockCore.cap(ORIGIN, 8453, USDC).spentAmount).toBe('10000');

    // The pending payment carries CAP authorization. A cap gone withholds.
    await revokeCap();
    const injected = await intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    expect(injected).toBeNull();
  });

  test('vault-unlock resume: x402:resume-unlock uses the stashed snapshot, even if a NEWER 402 replaced the map detection', async () => {
    // Full reproduction of the reviewer's bad-interleaving scenario:
    //   1. Cap-covered A 402s; vault is locked; resume token captured.
    //   2. Newer B 402s and replaces detectedPayments[id].
    //   3. User unlocks; renderer calls x402:resume-unlock (NOT approve).
    //   4. Resume must sign A (from token), not B (from map).
    const urlA = 'https://api.example/article-A';
    const urlB = 'https://api.example/article-B';
    const requirementsB64 = Buffer.from(
      JSON.stringify(v2Detected().requirements)
    ).toString('base64');
    // B charges more than the cap holds: it goes to the approval card.
    const overCapB64 = Buffer.from(JSON.stringify({
      ...v2Detected().requirements,
      accepts: [{ ...v2Detected().requirements.accepts[0], amount: '30000' }],
    })).toString('base64');

    // (1) A — cap-covered, vault locked at sign time.
    await seedCap();
    mockCore.setX402Locked(true);
    // A cap answers only for a live user tab main can attribute the 402 to.
    webContents.fromId.mockReturnValue(hostedTab({ hostWebContents: { send: jest.fn() } }));

    intercept.detectPaymentRequiredHandler({
      webContentsId: 42,
      url: urlA,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [requirementsB64] },
    });
    // Wait for setImmediate + the .catch microtask to settle.
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    expect(signed).toEqual([]);

    // (2) B — replaces detectedPayments[42].
    intercept.detectPaymentRequiredHandler({
      webContentsId: 42,
      url: urlB,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [overCapB64] },
    });
    expect(intercept.getDetectedPayment(42)?.url).toBe(urlB);

    // (3) User unlocks. Renderer fires the dedicated resume IPC.
    mockCore.setX402Locked(false);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));

    const result = await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 42 });
    expect(result.success).toBe(true);
    expect(signed.map(({ url }) => url)).toEqual([urlA]);

    // (4) Pending payment is for A (the resume token), not B: its cap
    // still stands, so inject attaches the header — the CAP-withhold
    // behaviour is tested elsewhere; here we're verifying the right URL
    // was signed.
    expect(await intercept.injectPaymentSignatureHandler({
      webContentsId: 42, url: urlA, requestHeaders: {},
    })).not.toBeNull();

    // And NO pending payment for B (the newer map detection was ignored).
    expect(await intercept.injectPaymentSignatureHandler({
      webContentsId: 42, url: urlB, requestHeaders: {},
    })).toBeNull();
  });

  test('x402:approve does NOT consume an unrelated resume token (source-mixing fix)', async () => {
    // Scenario: A is cap-covered + vault locked → resume token stashed.
    // Before unlock, B 402s and the sidebar shows a manual approval card.
    // The user clicks Pay for B. The resume token for A must survive —
    // x402:approve must sign B (from the map) without touching the token.
    const urlA = 'https://api.example/article-A';
    const urlB = 'https://api.example/article-B';
    const requirementsB64 = Buffer.from(
      JSON.stringify(v2Detected().requirements)
    ).toString('base64');
    const overCapB64 = Buffer.from(JSON.stringify({
      ...v2Detected().requirements,
      accepts: [{ ...v2Detected().requirements.accepts[0], amount: '30000' }],
    })).toString('base64');

    // (1) A → cap-covered → vault locked → token stashed.
    await seedCap();
    mockCore.setX402Locked(true);
    // A cap answers only for a live user tab main can attribute the 402 to.
    webContents.fromId.mockReturnValue(hostedTab({ hostWebContents: { send: jest.fn() } }));
    intercept.detectPaymentRequiredHandler({
      webContentsId: 42, url: urlA,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [requirementsB64] },
    });
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    // (2) B → over the cap → approval card path → map has B.
    intercept.detectPaymentRequiredHandler({
      webContentsId: 42, url: urlB,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [overCapB64] },
    });

    // (3) User clicks Pay on B's manual approval card.
    mockCore.setX402Locked(false);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    const approveResult = await approveAsCard(42);
    expect(approveResult.success).toBe(true);
    expect(signed.map(({ url }) => url)).toEqual([urlB]);

    // Pending payment is for B (what the user actually approved), not A.
    expect(await intercept.injectPaymentSignatureHandler({
      webContentsId: 42, url: urlB, requestHeaders: {},
    })).not.toBeNull();
    // And NO pending for A — the resume token survived (will be consumed
    // by x402:resume-unlock when the user finishes unlocking).
    expect(await intercept.injectPaymentSignatureHandler({
      webContentsId: 42, url: urlA, requestHeaders: {},
    })).toBeNull();

    // (4) The resume token for A is still consumable via the dedicated
    // channel — verify by exhausting it now.
    expect(intercept.consumePendingUnlockResume(42)).not.toBeNull();
  });

  test('x402:resume-unlock returns an error when no token is stashed', async () => {
    const result = await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 42 });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pending unlock-resume/i);
  });

  test('x402:resume-unlock settles a pending unlock-wait (subresource path) without invoking signAndQueueRetry from the IPC', async () => {
    // The IPC must NOT call signAndQueueRetry on the wait path —
    // calling it would double-sign for the closure-driven attempt.
    const waitPromise = intercept.setPendingUnlockWait(42);

    const result = await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 42 });
    expect(result).toEqual({ success: true });
    expect(intercept.hasPendingUnlockWait(42)).toBe(false);
    await expect(waitPromise).resolves.toBeUndefined();
    expect(corePayments()).toEqual([]);
  });

  test('manual approve path stamps authorizedBy=manual so a payment no cap was charged for still attaches the header', async () => {
    seedDetection(42);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    await approveAsCard(42);

    // No cap covers it: the core charged nothing, and it goes out anyway.
    const injected = await intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    expect(settles()).toEqual([]);
  });

  test('subresource 402 (xhr/fetch/media/...): pays and stashes signature but does NOT navigate the tab', async () => {
    // The whole point: a 402 on a page's fetch() must not yank the tab
    // away from the page that initiated the fetch. We still sign + stash
    // the pending PAYMENT-SIGNATURE so an x402-aware page that retries
    // gets the injection on its next outbound request.
    const detecting = seedDetection(42, 'xhr');
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL }));

    const result = await approveAsCard(42);

    // The detector holding the subresource open signs and 307s.
    expect(result).toEqual({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(signed).toHaveLength(1);
    expect(loadURL).not.toHaveBeenCalled();
    // Injection is still armed so a page-initiated retry gets paid.
    const injected = await intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });
});

// === auto-pay state + grant + consume ====================================

describe('x402:get-details autoPay', () => {
  const seedDetection = () =>
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });

  // The caps are the core's, read on main's mirror: seeded after the 402
  // reached its card, so the detector doesn't auto-pay it.
  test('returns kind=cover when an active cap fits the charge', async () => {
    seedDetection();
    await seedCap({ capAmount: '10000000' });

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.autoPay).toMatchObject({ kind: 'cover', capAmount: '10000000' });
  });

  test('returns kind=over-cap when the cap exists but is already spent', async () => {
    seedDetection();
    // only 1 atomic unit left; charge is 10000
    await seedCap({ capAmount: '10000000', spentAmount: '9999999' });
    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.autoPay.kind).toBe('over-cap');
    expect(result.autoPay.remaining).toBe('1');
  });

  test('returns kind=none when no permission exists for this origin, chain and asset', async () => {
    seedDetection();
    // Caps for another site, and for this site on another chain, answer
    // nothing here.
    mockCore.seedCap({ origin: 'https://other.example', chainId: 8453, asset: USDC, capAmount: '10000000' });
    mockCore.seedCap({ origin: ORIGIN, chainId: 100, asset: USDC, capAmount: '10000000' });
    await loadCaps();
    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.autoPay).toEqual({ kind: 'none' });
  });
});

describe('x402:approve permission interactions', () => {
  const seedDetection = () =>
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
  const inject = () => intercept.injectPaymentSignatureHandler({
    webContentsId: 42,
    url: 'https://api.example/article',
    requestHeaders: {},
  });

  beforeEach(() => {
    seedDetection();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
  });

  test('with a grant arg: the token binds it, and the core writes the cap and charges this payment to it', async () => {
    const window = 30 * 24 * 60 * 60;
    const result = await approveAsCard(42, { grant: { capAmount: '10000000', windowSeconds: window } });

    expect(result.success).toBe(true);
    // Minted with the grant, presented with it, written by the core: main
    // writes no cap itself.
    expect(coreCalls('approval.issue')[0].params.payload.grant).toEqual({ cap_amount: '10000000', window_seconds: window });
    expect(corePayments()[0].params.grant).toEqual({ cap_amount: '10000000', window_seconds: window });
    expect(coreCalls('approval.grant')).toEqual([]);
    const cap = mockCore.cap(ORIGIN, 8453, USDC);
    expect(cap).toMatchObject({ capAmount: '10000000', spentAmount: '10000' });
    expect(cap.expiresAt - cap.createdAt).toBe(window);
    // The charge rides on the pending payment and is kept once the header
    // goes out.
    expect(inject()?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'sent' }]);
  });

  test('without a grant arg: no cap is written, and nothing is charged', async () => {
    await approveAsCard(42);
    expect(corePayments()[0].params).not.toHaveProperty('grant');
    expect(mockCore.cap(ORIGIN, 8453, USDC)).toBeNull();
    expect(inject()?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    expect(settles()).toEqual([]);
  });

  test('a grant the core does not add does not block the sign / pay flow', async () => {
    const result = await approveAsCard(42, {
      grant: { capAmount: '10000000', windowSeconds: -1 },
    });
    expect(result.success).toBe(true);
    // The core signed the payment and added no cap.
    expect(signed).toHaveLength(1);
    expect(mockCore.cap(ORIGIN, 8453, USDC)).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/grant not added \(invalid\)/));
    expect(inject()?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });
});

describe('x402:get-receipts', () => {
  test('delegates to payment-history filtered to kind=x402', async () => {
    mockGetRecentReceipts.mockReturnValueOnce([
      { id: 1, url: 'https://api.example/x', status: 'settled', kind: 'x402' },
    ]);
    const result = await ipcHandlers['x402:get-receipts'](senderEvent(42), { limit: 50 });
    expect(result).toEqual({ success: true, receipts: [
      { id: 1, url: 'https://api.example/x', status: 'settled', kind: 'x402' },
    ] });
    // The chrome's read, relayed to the core as the chrome's.
    expect(mockGetRecentReceipts).toHaveBeenCalledWith({ kind: 'x402', limit: 50 }, 'chrome');
  });

  test('passes through undefined limit when none provided', async () => {
    mockGetRecentReceipts.mockReturnValueOnce([]);
    const result = await ipcHandlers['x402:get-receipts'](senderEvent(42));
    expect(result.success).toBe(true);
    expect(mockGetRecentReceipts).toHaveBeenCalledWith({ kind: 'x402', limit: undefined }, 'chrome');
  });

  // The history is the identity core's (design 0013, PRF-6(c)).
  test("a core that can't answer is the handler's failure", async () => {
    mockGetRecentReceipts.mockRejectedValueOnce(
      Object.assign(new Error("The core can't take this request"), { code: 'requirement_unmet' })
    );
    const result = await ipcHandlers['x402:get-receipts'](senderEvent(42), { limit: 5 });
    expect(result).toEqual({ success: false, error: "The core can't take this request" });
  });
});

// The caps are the identity core's (X402-2): main lists them from its
// mirror, and a revoke is the core's `approval.revoke`, as the chrome.
describe('x402:get-all-permissions + x402:revoke-permission', () => {
  const A = 'https://a.example';
  const revokes = () => coreCalls('approval.revoke').map(({ params, page }) => ({ params, page }));

  beforeEach(async () => {
    mockCore.seedCap({ origin: A, chainId: 8453, asset: '0xabc', capAmount: '1' });
    mockCore.seedCap({ origin: A, chainId: 100, asset: '0xdef', capAmount: '2' });
    await loadCaps();
  });

  test('get-all-permissions lists the caps the core holds that answer now', async () => {
    mockCore.seedCap({ origin: 'https://expired.example', chainId: 8453, asset: '0xabc', capAmount: '1', windowSeconds: 30, createdAt: 1000 });
    await loadCaps();
    const result = await ipcHandlers['x402:get-all-permissions'](senderEvent(42));
    expect(result.success).toBe(true);
    expect(result.permissions).toHaveLength(2);
    expect(result.permissions[0]).toMatchObject({ origin: A, chainId: 8453, asset: '0xabc', capAmount: '1', spentAmount: '0' });
  });

  test('revoke-permission asks the core to revoke that cap, as the chrome', async () => {
    const result = await ipcHandlers['x402:revoke-permission'](senderEvent(42), {
      origin: A,
      chainId: 8453,
      asset: '0xabc',
    });
    expect(result).toEqual({ success: true });
    expect(revokes()).toEqual([
      { params: { store: 'x402', key: A, what: { cap: { chain_id: 8453, asset: '0xabc' } } }, page: 'chrome' },
    ]);
    expect(mockCore.cap(A, 8453, '0xabc')).toBeNull();
    // Main's mirror holds the core's answer by the time the revoke resolves.
    const { permissions } = await ipcHandlers['x402:get-all-permissions'](senderEvent(42));
    expect(permissions.map(({ chainId }) => chainId)).toEqual([100]);
  });

  test('revoke-all-for-origin asks the core to revoke every cap of the origin, as the chrome', async () => {
    const result = await ipcHandlers['x402:revoke-all-for-origin'](senderEvent(42), {
      origin: A,
    });
    expect(result).toEqual({ success: true });
    expect(revokes()).toEqual([{ params: { store: 'x402', key: A, what: 'grant' }, page: 'chrome' }]);
    expect(mockCore.cap(A, 8453, '0xabc')).toBeNull();
    expect(mockCore.cap(A, 100, '0xdef')).toBeNull();
    expect((await ipcHandlers['x402:get-all-permissions'](senderEvent(42))).permissions).toEqual([]);
  });

  test("a revoke the core refuses is reported as failed, and the cap stands", async () => {
    const realRevoke = mockCore.approval.revoke;
    mockCore.approval.revoke = async () => {
      throw Object.assign(new Error('the identity core is not running'), { code: 'unavailable' });
    };
    try {
      expect(await ipcHandlers['x402:revoke-permission'](senderEvent(42), { origin: A, chainId: 8453, asset: '0xabc' }))
        .toEqual({ success: false, error: 'the identity core is not running' });
      expect(await ipcHandlers['x402:revoke-all-for-origin'](senderEvent(42), { origin: A }))
        .toEqual({ success: false, error: 'the identity core is not running' });
    } finally {
      mockCore.approval.revoke = realRevoke;
    }
    expect(mockCore.cap(A, 8453, '0xabc')).not.toBeNull();
  });

  // #1023, X402-2, X402-2b: a cap's amount and window are the core's.
  // Widening one needs the core's decision (a payment's token that binds
  // the new cap); the pane lowers one through the core's narrowing
  // (`x402.update`, as the chrome). A change that isn't strictly narrower is
  // refused unasked, and nothing presented changes that.
  describe('update-permission narrows only, through the core', () => {
    const NARROW_ONLY = { success: false, error: require('./caps').NARROW_ONLY, code: 'forbidden' };
    const EDIT = { origin: A, chainId: 8453, asset: '0xabc', capAmount: '20000000' };

    test('a raise, from any sender, is refused, nothing is asked of the core, and the cap is unchanged', async () => {
      const before = mockCore.cap(A, 8453, '0xabc');
      await flush();
      const asked = mockCore.calls.length;
      for (const [sender, edit] of [
        [fromChrome, EDIT],
        [fromChrome, { ...EDIT, capAmount: '99000000' }],
        [fromChrome, { ...EDIT, capAmount: '1' }],
        [fromChrome, { ...EDIT, capAmount: undefined, windowSeconds: 365 * 86400 }],
        [{ sender: { id: 9 } }, EDIT],
        [{}, EDIT],
      ]) {
        expect(await ipcHandlers['x402:update-permission'](sender, edit)).toEqual(NARROW_ONLY);
      }
      for (const edit of [{ ...EDIT, asset: '0xdef', chainId: 100 }, { ...EDIT, origin: 'https://b.example' }, undefined]) {
        expect((await ipcHandlers['x402:update-permission'](fromChrome, edit)).success).toBe(false);
      }
      expect(mockCore.calls.slice(asked)).toEqual([]);
      expect(mockCore.cap(A, 8453, '0xabc')).toEqual(before);
      expect((await ipcHandlers['x402:get-all-permissions'](senderEvent(42))).permissions[0]).toMatchObject({ capAmount: '1' });
    });

    test('a lower amount goes to the core as the chrome, which writes it', async () => {
      mockCore.seedCap({ origin: A, chainId: 8453, asset: '0xabc', capAmount: '5000' });
      await loadCaps();
      const asked = mockCore.calls.length;
      expect(await ipcHandlers['x402:update-permission'](fromChrome, { ...EDIT, capAmount: '4000' })).toEqual({ success: true });
      expect(mockCore.calls.slice(asked).find(({ method }) => method === 'x402.update')).toMatchObject({
        params: { key: A, cap: { chain_id: 8453, asset: '0xabc' }, cap_amount: '4000' },
        page: 'chrome',
      });
      expect(mockCore.cap(A, 8453, '0xabc')).toMatchObject({ capAmount: '4000' });
    });

    test("a token the renderer presents is not spent: it still pays the payment it was minted for", async () => {
      detectOn(42, { id: 7901 });
      const confirmation = await tokenFor(paymentAsShown(42));
      const asked = mockCore.calls.length;

      expect(await ipcHandlers['x402:update-permission'](fromChrome, { ...EDIT, confirmation })).toEqual(NARROW_ONLY);
      expect(mockCore.calls.slice(asked)).toEqual([]);
      expect(mockCore.outstanding()).toBe(1);

      expect(await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7901',
        selectedAcceptIndex: 0,
        confirmation,
      })).toEqual({ success: true });
      expect(signed).toHaveLength(1);
    });
  });
});

// === x402:reject =========================================================

describe('x402:reject (subresource approval-card decline)', () => {
  test('settles a pending approval as not-approved', async () => {
    // Drive the detector into the approval-card await branch by firing
    // a subresource 402 with no cap. The detector's promise hangs.
    const handlerPromise = require('./intercept').detectPaymentRequiredHandler({
      id: 9001,
      webContentsId: 42,
      url: 'https://api.example/segment/0',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'xhr',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    await Promise.resolve();

    const result = await ipcHandlers['x402:reject'](fromChrome, { detectionId: 'req-9001' });
    expect(result).toEqual({ success: true, settled: true });

    // Detector returns null, page sees the 402.
    expect(await handlerPromise).toBeNull();
  });

  test('returns settled=false when there is no pending approval for the detectionId', async () => {
    const result = await ipcHandlers['x402:reject'](fromChrome, { detectionId: 'req-nonexistent' });
    expect(result).toEqual({ success: true, settled: false });
  });

  test('refuses without a detectionId', async () => {
    const result = await ipcHandlers['x402:reject'](fromChrome, {});
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/detectionId required/i);
  });
});

describe('x402:approve with detectionId — strict identity (P1)', () => {
  test('returns pending:true so the renderer waits for the approval-result event', async () => {
    const handlerPromise = require('./intercept').detectPaymentRequiredHandler({
      id: 9100,
      webContentsId: 42,
      url: 'https://api.example/segment/0',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'xhr',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    await Promise.resolve();

    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));

    const result = await approveAsCard(42, { detectionId: 'req-9100' });
    expect(result).toEqual({ success: true, pending: true });

    // Detector continues and ends up resolving with the 307.
    await handlerPromise;
  });

  test('stale detectionId does NOT fall through to mainFrame path (closes the approved-A-paid-B race)', async () => {
    // A's card was shown for detectionId-A. B's 402 already replaced
    // detectedPayments[id] with detectionId-B. A stale click now arrives.
    // The IPC must refuse — falling through would sign B as if A.
    intercept.detectPaymentRequiredHandler({
      id: 9200,
      webContentsId: 42,
      url: 'https://api.example/segment/B',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame', // not in approval-await; just populates map
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    // Map now has detectionId=req-9200 for tab 42. Click arrives for A.
    const result = await ipcHandlers['x402:approve'](fromChrome, {
      detectionId: 'req-NONEXISTENT-A',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/stale|superseded/i);
    expect(corePayments()).toEqual([]);
  });

  test('detectionId that matches the tab-keyed map IS allowed to fall through (mainFrame approval-card)', async () => {
    // Seed a mainFrame detection — detectedPayments[42].detectionId
    // will be 'req-9300'. The sidebar's Approve click for that same
    // detectionId should sign via the existing mainFrame flow.
    intercept.detectPaymentRequiredHandler({
      id: 9300,
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    const result = await approveAsCard(42, { detectionId: 'req-9300' });
    expect(result.success).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(signed).toHaveLength(1);
  });
});

describe('x402:approve with detectionId (subresource approval-card sign-on-click)', () => {
  test('settles the pending approval; detector signs and returns 307', async () => {
    const handlerPromise = require('./intercept').detectPaymentRequiredHandler({
      id: 9002,
      webContentsId: 42,
      url: 'https://api.example/segment/0',
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'xhr',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    await Promise.resolve();

    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));

    const approveResult = await approveAsCard(42, { detectionId: 'req-9002' });
    expect(approveResult.success).toBe(true);

    const handlerResult = await handlerPromise;
    expect(handlerResult).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/segment/0'] },
    });
  });
});

// === x402:approve confirmation token (O-7) ================================
//
// x402:approve has the core sign only with an 'x402-payment' token the core
// minted for exactly the payment main holds: its tab and detection, the
// chosen accepts[] entry, the active account and the grant (X402-2). Main
// reads the token as the core binds it, refusing and burning one it didn't
// mint as this kind before the core is asked; the core spends it at the
// payment's `x402.authorize` against exactly what it binds, and refuses
// (`mismatch`) and burns one presented for another payment. Auto-pay within
// an allowance signs in the detector, with no token.

describe('x402:approve requires a confirmation token for exactly this payment', () => {
  const OTHER_ASSET = '0x50c5725949a6f0c72e6c4a641f24049a917db0cb';
  const twoAccepts = () => {
    const requirements = v2Detected().requirements;
    return {
      ...requirements,
      accepts: [
        requirements.accepts[0],
        { ...requirements.accepts[0], asset: OTHER_ASSET, amount: '20000000000000000', extra: { name: 'Dai', version: '1' } },
      ],
    };
  };
  const detect = (tabId, { id, resourceType = 'mainFrame', url = 'https://api.example/article', requirements } = {}) =>
    intercept.detectPaymentRequiredHandler({
      id,
      webContentsId: tabId,
      url,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType,
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(requirements ?? v2Detected().requirements)).toString('base64'),
        ],
      },
    });

  let loadURL;
  beforeEach(() => {
    loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL }));
  });

  const nothingSigned = () => {
    expect(signed).toEqual([]);
    expect(loadURL).not.toHaveBeenCalled();
  };
  // Refused in main, before the core is asked to pay.
  const coreNotAsked = () => expect(corePayments()).toEqual([]);

  test('a paywall approval without a token is refused before anything is signed', async () => {
    detect(42, { id: 7001 });
    const result = await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7001',
      selectedAcceptIndex: 0,
    });
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(result.error).toMatch(/no confirmation token/);
    coreNotAsked();
    nothingSigned();
    // The payment is still there for the user to approve.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7001');
  });

  test('a subresource approval without a token leaves the detector waiting', async () => {
    const detecting = detect(42, { id: 7002, resourceType: 'xhr' });
    // None, an empty one, and one main never had the core mint.
    for (const confirmation of [undefined, '', 'f'.repeat(64)]) {
      const result = await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7002',
        confirmation,
      });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    }
    expect(intercept.hasPendingApproval('req-7002')).toBe(true);
    coreNotAsked();
    nothingSigned();

    // The user's own confirmation still pays it.
    expect(await approveAsCard(42, { detectionId: 'req-7002' })).toEqual({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
  });

  test("a token minted for tab A's payment cannot approve tab B's: the core refuses it and burns it", async () => {
    detect(41, { id: 7101, url: 'https://a.example/article' });
    detect(42, { id: 7102, url: 'https://b.example/article' });
    const confirmation = await tokenFor(paymentAsShown(41));

    const result = await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7102',
      selectedAcceptIndex: 0,
      confirmation,
    });
    expect(result).toMatchObject(REFUSED_AS_ANOTHER);
    nothingSigned();

    // Nor does a token that names tab A but B's detection: main binds the
    // tab it holds B's detection for.
    const relabelled = await tokenFor({ ...paymentAsShown(42), webContentsId: 41 });
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7102',
      confirmation: relabelled,
    })).toMatchObject(REFUSED_AS_ANOTHER);
    nothingSigned();
    // Each was presented to the core for B's payment, and burnt there.
    expect(corePayments().map(({ params }) => params.detection)).toEqual([
      { tab: 42, id: 'req-7102', url: 'https://b.example/article' },
      { tab: 42, id: 'req-7102', url: 'https://b.example/article' },
    ]);
    expect(mockCore.outstanding()).toBe(0);
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7102');
    expect(intercept.isApprovalClaimed('req-7102')).toBe(false);
  });

  test("a token for tab A's subresource payment cannot settle tab B's: the core refuses it, and B's detector waits again", async () => {
    const detectingA = detect(41, { id: 7201, resourceType: 'xhr', url: 'https://a.example/seg' });
    const detectingB = detect(42, { id: 7202, resourceType: 'xhr', url: 'https://b.example/seg' });
    const confirmation = await tokenFor(paymentAsShown(41, { detectionId: 'req-7201' }));

    // Main reads the token as the core binds it and hands it to B's
    // detector, which presents it to the core for B's payment.
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7202',
      confirmation,
    })).toEqual({ success: true, pending: true });
    await flush();
    expect(CHROME.send).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-7202',
      success: false,
      error: expect.stringMatching(/request differs from what was confirmed/),
    });
    expect(corePayments().map(({ params }) => params.detection.id)).toEqual(['req-7202']);
    expect(mockCore.outstanding()).toBe(0);
    expect(intercept.hasPendingApproval('req-7202')).toBe(true);
    expect(intercept.hasPendingApproval('req-7201')).toBe(true);
    nothingSigned();

    intercept.abortPendingApproval('req-7201', new Error('cleared'));
    intercept.abortPendingApproval('req-7202', new Error('cleared'));
    await Promise.all([detectingA, detectingB]);
  });

  test('a token for accept entry 0 cannot sign entry 1', async () => {
    detect(42, { id: 7301, requirements: twoAccepts() });
    const confirmation = await tokenFor(paymentAsShown(42, { acceptIndex: 0 }));

    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7301',
      selectedAcceptIndex: 1,
      confirmation,
    })).toMatchObject(REFUSED_AS_ANOTHER);
    nothingSigned();

    // Nor does one that claims index 1 with entry 0's terms.
    const mislabelled = await tokenFor({ ...paymentAsShown(42, { acceptIndex: 0 }), acceptIndex: 1 });
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7301',
      selectedAcceptIndex: 1,
      confirmation: mislabelled,
    })).toMatchObject(REFUSED_AS_ANOTHER);
    nothingSigned();

    // Entry 1's own token signs entry 1, and only it.
    expect(await approveAsCard(42, { detectionId: 'req-7301', acceptIndex: 1 })).toEqual({ success: true });
    expect(signed.map(({ accept }) => accept)).toEqual([twoAccepts().accepts[1]]);
  });

  test('an omitted index means entry 0: a token for entry 1 does not cover it', async () => {
    const detecting = detect(42, { id: 7302, resourceType: 'xhr', requirements: twoAccepts() });
    const confirmation = await tokenFor(paymentAsShown(42, { detectionId: 'req-7302', acceptIndex: 1 }));
    // No index: main hands the core entry 0, the entry it would sign, and
    // the core refuses the token; the detector waits again.
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7302',
      confirmation,
    })).toEqual({ success: true, pending: true });
    await flush();
    expect(corePayments().map(({ params }) => params.accept_index)).toEqual([0]);
    expect(CHROME.send).toHaveBeenCalledWith('x402:approval-result', expect.objectContaining({
      detectionId: 'req-7302',
      success: false,
    }));
    expect(intercept.hasPendingApproval('req-7302')).toBe(true);
    nothingSigned();

    expect(await approveAsCard(42, { detectionId: 'req-7302', acceptIndex: 1 })).toEqual({ success: true, pending: true });
    await detecting;
    expect(signed.map(({ accept }) => accept)).toEqual([twoAccepts().accepts[1]]);
  });

  test('an index outside accepts[] is refused, and burns the token', async () => {
    detect(42, { id: 7303 });
    const payment = paymentAsShown(42);
    const confirmation = await tokenFor(payment);
    for (const selectedAcceptIndex of [1, -1, 0.5, '0']) {
      expect(await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7303',
        selectedAcceptIndex,
        confirmation,
      })).toMatchObject({ success: false });
    }
    expect(mockCore.outstanding()).toBe(0);
    nothingSigned();
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7303',
      selectedAcceptIndex: 0,
      confirmation,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED', error: expect.stringMatching(/already used/) });
    coreNotAsked();
    nothingSigned();
  });

  test('a replayed token is refused', async () => {
    detect(42, { id: 7401 });
    const payment = paymentAsShown(42);
    const confirmation = await tokenFor(payment);
    const args = { webContentsId: 42, detectionId: 'req-7401', selectedAcceptIndex: 0, confirmation };

    // The first use fails after the core spent it (the vault locked); the
    // payment stays, and the same token can't be presented again.
    mockCore.setX402Locked(true);
    expect(await ipcHandlers['x402:approve'](fromChrome, args)).toMatchObject({
      success: false,
      error: VAULT_LOCKED_MESSAGE,
    });
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7401');
    mockCore.setX402Locked(false);

    const replay = await ipcHandlers['x402:approve'](fromChrome, args);
    expect(replay).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(replay.error).toMatch(/already used/);
    // Asked once: the replay was refused in main.
    expect(corePayments()).toHaveLength(1);
    expect(mockCore.outstanding()).toBe(0);
    nothingSigned();
  });

  test('an expired token is refused', async () => {
    let clock = 5_000_000;
    mockCore.setNow(() => clock);
    detect(42, { id: 7402 });
    const confirmation = await tokenFor(paymentAsShown(42));
    clock += confirmations.CONFIRMATION_TTL_MS;

    const result = await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7402',
      selectedAcceptIndex: 0,
      confirmation,
    });
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(result.error).toMatch(/expired/);
    nothingSigned();
  });

  test('a stale detection burns the token it was handed', async () => {
    detect(42, { id: 7403 });
    const confirmation = await tokenFor(paymentAsShown(42));
    // A newer 402 supersedes the one the token was minted for.
    detect(42, { id: 7404 });
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7403',
      confirmation,
    })).toMatchObject({ success: false, error: expect.stringMatching(/stale/) });
    expect(coreCalls('approval.discard').map(({ params }) => params)).toEqual([{ token: confirmation }]);
    expect(mockCore.outstanding()).toBe(0);
    coreNotAsked();
    nothingSigned();
  });

  test('a detection that never reached a card (no detectionId) cannot be approved', async () => {
    // What an allowance-covered paywall leaves in the map: no detectionId.
    detect(42, { id: 7405 });
    const stored = intercept.getDetectedPayment(42);
    delete stored.detectionId;
    stored.authorizedBy = 'cap';

    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      selectedAcceptIndex: 0,
    })).toMatchObject({ success: false, error: expect.stringMatching(/No pending x402 payment/) });
    coreNotAsked();
    nothingSigned();
  });

  test('the token binds the account: switching accounts after confirming refuses it', async () => {
    detect(42, { id: 7501 });
    const confirmation = await tokenFor(paymentAsShown(42), 0);
    mockGetActiveWalletIndex.mockReturnValue(1);

    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7501',
      selectedAcceptIndex: 0,
      confirmation,
    })).toMatchObject(REFUSED_AS_ANOTHER);
    // Presented for the account active now, which the token doesn't bind.
    expect(corePayments().map(({ params }) => params.account)).toEqual([1]);
    nothingSigned();
  });

  test('the account checked is the account that signs, on both paths', async () => {
    // Account 3 is active when x402:approve reads the token; any later
    // read of the active account would see 5. The signature must use 3.
    mockGetActiveWalletIndex.mockReturnValue(5);
    detect(42, { id: 7502 });
    mockGetActiveWalletIndex.mockReturnValueOnce(3);
    expect(await approveAsCard(42, { walletIndex: 3 })).toEqual({ success: true });
    expect(corePayments().map(({ params }) => params.account)).toEqual([3]);
    expect(signed.map(({ account }) => account)).toEqual([3]);

    // Subresource: the detector signs after the IPC has returned.
    const detecting = detect(43, { id: 7503, resourceType: 'xhr' });
    mockGetActiveWalletIndex.mockReturnValueOnce(3);
    expect(await approveAsCard(43, { detectionId: 'req-7503', walletIndex: 3 })).toEqual({ success: true, pending: true });
    await detecting;
    expect(corePayments().map(({ params }) => params.account)).toEqual([3, 3]);
    expect(signed.map(({ account }) => account)).toEqual([3, 3]);
  });

  test('the token binds the grant: none confirmed means none can be added, nor a larger one', async () => {
    detect(42, { id: 7601 });
    const GRANT = { capAmount: '10000000', windowSeconds: 30 * 24 * 60 * 60 };

    const withoutGrant = await tokenFor(paymentAsShown(42));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7601',
      selectedAcceptIndex: 0,
      grant: GRANT,
      confirmation: withoutGrant,
    })).toMatchObject(REFUSED_AS_ANOTHER);

    const smallGrant = await tokenFor(paymentAsShown(42, { grant: GRANT }));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7601',
      selectedAcceptIndex: 0,
      grant: { ...GRANT, capAmount: '1000000000000' },
      confirmation: smallGrant,
    })).toMatchObject(REFUSED_AS_ANOTHER);
    expect(mockCore.cap(ORIGIN, 8453, USDC)).toBeNull();
    nothingSigned();

    expect(await approveAsCard(42, { grant: GRANT })).toEqual({ success: true });
    const cap = mockCore.cap(ORIGIN, 8453, USDC);
    expect(cap).toMatchObject({ capAmount: GRANT.capAmount });
    expect(cap.expiresAt - cap.createdAt).toBe(GRANT.windowSeconds);
  });

  describe('auto-pay within an allowance still pays with no token', () => {
    beforeEach(async () => {
      await seedCap();
      // An allowance answers only for a live user tab main can attribute
      // the 402 to.
      webContents.fromId.mockReturnValue(hostedTab({ loadURL, hostWebContents: { send: jest.fn() } }));
    });

    test('a paywall the allowance covers is signed and reloaded', async () => {
      expect(await detect(42, { id: 7701 })).toBeNull();
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

      expect(corePayments().map(({ params }) => ({ account: params.account, authorization: params.authorization }))).toEqual([
        { account: 0, authorization: { cap: { agent: false, attributable: true } } },
      ]);
      expect(loadURL).toHaveBeenCalledWith('https://api.example/article');
      expect(coreCalls('approval.issue')).toEqual([]);
      expect(mockCore.cap(ORIGIN, 8453, USDC).spentAmount).toBe('10000');
      expect((await intercept.injectPaymentSignatureHandler({
        webContentsId: 42,
        url: 'https://api.example/article',
        requestHeaders: {},
      }))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    });

    test('a subresource the allowance covers is signed and redirected', async () => {
      expect(await detect(42, { id: 7702, resourceType: 'xhr', url: 'https://api.example/seg/1' })).toEqual({
        statusLine: 'HTTP/1.1 307 Temporary Redirect',
        responseHeaders: { Location: ['https://api.example/seg/1'] },
      });
      expect(signed).toHaveLength(1);
      expect(intercept.hasPendingApproval('req-7702')).toBe(false);
    });

    test('a charge over the allowance goes to the card, and needs a token', async () => {
      await seedCap({ spentAmount: '15000' });
      expect(await detect(42, { id: 7703 })).toBeNull();
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
      coreNotAsked();
      expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7703');
      expect(await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7703',
      })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      coreNotAsked();
    });
  });
});

// === One approval per detection, from the hosting window ==================

const detectOn = (tabId, { id, resourceType = 'mainFrame', url = 'https://api.example/article' } = {}) =>
  intercept.detectPaymentRequiredHandler({
    id,
    webContentsId: tabId,
    url,
    statusLine: 'HTTP/1.1 402 Payment Required',
    resourceType,
    responseHeaders: {
      'PAYMENT-REQUIRED': [
        Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
      ],
    },
  });

describe('x402:approve signs each detection once', () => {
  const approveWith = (tabId, detectionId, confirmation) =>
    ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: tabId,
      detectionId,
      selectedAcceptIndex: 0,
      confirmation,
    });
  const tokensFor = (payment, count) => Promise.all(Array.from({ length: count }, () => tokenFor(payment)));

  test('two tokens for one subresource detection: the second approval is refused', async () => {
    const detecting = detectOn(42, { id: 8001, resourceType: 'xhr', url: 'https://api.example/seg/1' });
    const payment = paymentAsShown(42, { detectionId: 'req-8001' });
    const [first, second, third] = await tokensFor(payment, 3);
    const release = coreAnswersLater();

    expect(await approveWith(42, 'req-8001', first)).toEqual({ success: true, pending: true });
    await flush();
    // While the core's answer to the first approval is on its way.
    const again = await approveWith(42, 'req-8001', second);
    expect(again).toMatchObject({ success: false, error: expect.stringMatching(/already been approved/) });
    expect([again.success, corePayments().length]).toEqual([false, 1]);

    release();
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    // And after it was signed: the detection is still the tab's record,
    // but it has been paid.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8001');
    expect(await approveWith(42, 'req-8001', third)).toMatchObject({ success: false });
    expect(signed).toHaveLength(1);
    // Every token presented was burnt.
    expect(mockCore.outstanding()).toBe(0);
  });

  test('two tokens for one paywall detection: the second approval is refused', async () => {
    detectOn(42, { id: 8002 });
    const payment = paymentAsShown(42);
    const [first, second] = await tokensFor(payment, 2);

    expect(await approveWith(42, 'req-8002', first)).toEqual({ success: true });
    const again = await approveWith(42, 'req-8002', second);
    expect([again.success, signed.length]).toEqual([false, 1]);
    expect(mockCore.outstanding()).toBe(0);
  });

  test('two concurrent paywall approvals: the one that arrives while the first is signing is refused', async () => {
    detectOn(42, { id: 8003 });
    const payment = paymentAsShown(42);
    const [first, second] = await tokensFor(payment, 2);
    const release = coreAnswersLater();

    const paying = approveWith(42, 'req-8003', first);
    await flush();
    // The detection is still in the map: its sign hasn't finished.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8003');
    const again = await approveWith(42, 'req-8003', second);
    expect(again).toMatchObject({ success: false, error: expect.stringMatching(/already been approved/) });

    release();
    expect(await paying).toEqual({ success: true });
    expect([again.success, corePayments().length, signed.length]).toEqual([false, 1, 1]);
    expect(mockCore.outstanding()).toBe(0);
  });

  test("a failed paywall sign hands the detection back for the card's retry, which pays it once", async () => {
    detectOn(42, { id: 8004 });
    const payment = paymentAsShown(42);
    const [first, retry, third] = await tokensFor(payment, 3);

    mockCore.setX402Locked(true);
    expect(await approveWith(42, 'req-8004', first)).toMatchObject({ success: false, error: VAULT_LOCKED_MESSAGE });
    mockCore.setX402Locked(false);
    expect(await approveWith(42, 'req-8004', retry)).toEqual({ success: true });
    expect(await approveWith(42, 'req-8004', third)).toMatchObject({ success: false });
    expect(signed).toHaveLength(1);
  });

  test('a failed subresource sign re-arms the detection; the retry pays it once', async () => {
    const detecting = detectOn(42, { id: 8005, resourceType: 'xhr', url: 'https://api.example/seg/2' });
    mockCore.setX402Locked(true);
    expect(await approveAsCard(42, { detectionId: 'req-8005' })).toEqual({ success: true, pending: true });
    await flush();
    // The detector told the card and re-armed the same detection.
    expect(intercept.hasPendingApproval('req-8005')).toBe(true);
    expect(CHROME.send).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-8005',
      success: false,
      error: VAULT_LOCKED_MESSAGE,
    });

    mockCore.setX402Locked(false);
    const retry = paymentAsShown(42, { detectionId: 'req-8005' });
    const [paid, extra] = await tokensFor(retry, 2);
    expect(await approveWith(42, 'req-8005', paid)).toEqual({ success: true, pending: true });
    expect(await approveWith(42, 'req-8005', extra)).toMatchObject({ success: false });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(signed).toHaveLength(1);
  });

  test("a newer 402 with the same request id is a fresh card, not the paid one's claim", async () => {
    // A followed retry whose signature never rode out 402s again under the
    // same request id, so the detector mints the same detectionId.
    const detecting = detectOn(42, { id: 8006, resourceType: 'xhr', url: 'https://api.example/seg/3' });
    expect(await approveAsCard(42, { detectionId: 'req-8006' })).toEqual({ success: true, pending: true });
    await detecting;

    const again = detectOn(42, { id: 8006, resourceType: 'xhr', url: 'https://api.example/seg/3' });
    expect(await approveAsCard(42, { detectionId: 'req-8006' })).toEqual({ success: true, pending: true });
    expect(await again).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(signed).toHaveLength(2);
  });

  test('a closed tab drops its claims', async () => {
    detectOn(42, { id: 8007 });
    const [first, second] = await tokensFor(paymentAsShown(42), 2);
    const release = coreAnswersLater();
    const paying = approveWith(42, 'req-8007', first);
    await flush();
    expect(intercept.isApprovalClaimed('req-8007')).toBe(true);
    intercept.cleanupWebContents(42);
    expect(intercept.isApprovalClaimed('req-8007')).toBe(false);
    // Its detection went with it, so nothing can approve it again.
    expect(await approveWith(42, 'req-8007', second)).toMatchObject({ success: false, error: expect.stringMatching(/stale/) });
    release();
    await paying;
    expect(signed).toHaveLength(1);
  });
});

describe("x402 payment authority belongs to the window hosting the payment's tab", () => {
  const OTHER_WINDOW = { sender: { id: 2, send: jest.fn() } };
  let loadURL;
  let tabs;

  beforeEach(() => {
    loadURL = jest.fn().mockResolvedValue();
    // Tab 42 is CHROME's; tab 43 another window's; tab 44 is closing.
    tabs = new Map([
      [42, hostedTab({ id: 42, loadURL })],
      [43, { ...hostedTab({ id: 43, loadURL }), hostWebContents: { id: 2, send: jest.fn() } }],
      [44, hostedTab({ id: 44, loadURL, isDestroyed: () => true })],
    ]);
    webContents.fromId.mockImplementation((id) => tabs.get(id) ?? null);
  });

  // Nothing asked of the core, signed or navigated.
  const nothingSigned = () => {
    expect(corePayments()).toEqual([]);
    expect(signed).toEqual([]);
    expect(loadURL).not.toHaveBeenCalled();
  };

  test("x402:get-details serves the hosting window, and refuses another window's or a closed tab's", async () => {
    detectOn(42, { id: 8101 });
    detectOn(44, { id: 8102 });
    expect(await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42, detectionId: 'req-8101' }))
      .toMatchObject({ success: true, detectionId: 'req-8101' });
    expect(await ipcHandlers['x402:get-details'](OTHER_WINDOW, { webContentsId: 42, detectionId: 'req-8101' }))
      .toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(await ipcHandlers['x402:get-details'](OTHER_WINDOW, { webContentsId: 42 }))
      .toMatchObject({ success: false });
    expect(await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 44, detectionId: 'req-8102' }))
      .toMatchObject({ success: false, error: 'This payment is not on a tab of this window' });
    // With no tab named, the sender itself is not a tab of its own.
    expect(await ipcHandlers['x402:get-details'](fromChrome, { detectionId: 'req-8101' }))
      .toMatchObject({ success: false });
  });

  test("x402:get-details for a subresource is judged by the awaiting detection's tab, not the one named", async () => {
    detectOn(42, { id: 8103, resourceType: 'xhr' });
    expect(await ipcHandlers['x402:get-details'](OTHER_WINDOW, { webContentsId: 43, detectionId: 'req-8103' }))
      .toMatchObject({ success: false, error: 'This payment is not on a tab of this window' });
    expect(await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 43, detectionId: 'req-8103' }))
      .toMatchObject({ success: true, detectionId: 'req-8103' });
  });

  test("another window cannot approve this window's paywall; its token is burnt and the payment stays", async () => {
    detectOn(42, { id: 8104 });
    const confirmation = await tokenFor(paymentAsShown(42));
    expect(await ipcHandlers['x402:approve'](OTHER_WINDOW, {
      webContentsId: 42,
      detectionId: 'req-8104',
      selectedAcceptIndex: 0,
      confirmation,
    })).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(mockCore.outstanding()).toBe(0);
    nothingSigned();
    // Not claimed by the refusal: the hosting window's own Pay still works.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8104');
    expect(await approveAsCard(42)).toEqual({ success: true });
    expect(loadURL).toHaveBeenCalledWith('https://api.example/article');
  });

  test("another window cannot settle this window's subresource approval", async () => {
    const detecting = detectOn(42, { id: 8105, resourceType: 'xhr', url: 'https://api.example/seg/9' });
    const confirmation = await tokenFor(paymentAsShown(42, { detectionId: 'req-8105' }));
    expect(await ipcHandlers['x402:approve'](OTHER_WINDOW, {
      webContentsId: 43,
      detectionId: 'req-8105',
      selectedAcceptIndex: 0,
      confirmation,
    })).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(mockCore.outstanding()).toBe(0);
    expect(intercept.hasPendingApproval('req-8105')).toBe(true);
    nothingSigned();

    expect(await approveAsCard(42, { detectionId: 'req-8105' })).toEqual({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
  });

  test('a closed tab cannot be approved, and the token is burnt', async () => {
    detectOn(44, { id: 8106 });
    const confirmation = await tokenFor(paymentAsShown(44));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 44,
      detectionId: 'req-8106',
      selectedAcceptIndex: 0,
      confirmation,
    })).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(mockCore.outstanding()).toBe(0);
    nothingSigned();

    // Nor one main can no longer find at all.
    tabs.delete(44);
    const again = await tokenFor(paymentAsShown(44));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 44,
      detectionId: 'req-8106',
      selectedAcceptIndex: 0,
      confirmation: again,
    })).toMatchObject({ success: false });
    expect(mockCore.outstanding()).toBe(0);
    nothingSigned();
  });

  // Declining, cancelling and resuming sign nothing new, but each acts on
  // the payment: another window must not deny it, navigate its tab away,
  // or resume an allowance payment held for an unlock.
  const NOT_THIS_WINDOW = { success: false, error: 'This payment is not on a tab of this window' };

  // An allowance covers tab `tabId`'s paywall, the vault is locked when
  // auto-pay signs, and main stashes the payment until the user unlocks.
  // The allowance stays, so it still covers the payment on resume.
  async function lockedAutoPayOn(tabId, id) {
    await seedCap();
    mockCore.setX402Locked(true);
    detectOn(tabId, { id });
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    mockCore.setX402Locked(false);
    // The locked attempt asked the core, which charged and signed nothing.
    expect(signed).toEqual([]);
    expect(mockCore.cap(ORIGIN, 8453, USDC).spentAmount).toBe('0');
    mockCore.calls.splice(0);
  }

  // A subresource's allowance payment held for an unlock. Handled here so
  // that one left over by a failed test doesn't crash the next one's reset.
  function heldUnlockWait(tabId) {
    const waiting = intercept.setPendingUnlockWait(tabId);
    waiting.catch(() => {});
    return waiting;
  }

  test("x402:reject: another window cannot decline this window's subresource payment, even naming its own tab", async () => {
    const detecting = detectOn(42, { id: 8201, resourceType: 'xhr' });
    expect(await ipcHandlers['x402:reject'](OTHER_WINDOW, { detectionId: 'req-8201' }))
      .toEqual(NOT_THIS_WINDOW);
    // Judged by the awaiting detection's tab, not one the caller names.
    expect(await ipcHandlers['x402:reject'](OTHER_WINDOW, { webContentsId: 43, detectionId: 'req-8201' }))
      .toEqual(NOT_THIS_WINDOW);
    expect(intercept.hasPendingApproval('req-8201')).toBe(true);

    // The hosting window's own decline still settles it.
    expect(await ipcHandlers['x402:reject'](fromChrome, { detectionId: 'req-8201' }))
      .toEqual({ success: true, settled: true });
    expect(await detecting).toBeNull();
  });

  test("x402:reject refuses a closing tab's or a vanished tab's payment, and leaves it to the tab's cleanup", async () => {
    tabs.set(45, hostedTab({ id: 45, loadURL }));
    const detecting = detectOn(45, { id: 8202, resourceType: 'xhr' });
    tabs.get(45).isDestroyed = () => true;
    expect(await ipcHandlers['x402:reject'](fromChrome, { detectionId: 'req-8202' }))
      .toEqual(NOT_THIS_WINDOW);
    tabs.delete(45);
    expect(await ipcHandlers['x402:reject'](fromChrome, { detectionId: 'req-8202' }))
      .toEqual(NOT_THIS_WINDOW);
    expect(intercept.hasPendingApproval('req-8202')).toBe(true);

    intercept.cleanupWebContents(45);
    expect(await detecting).toBeNull();
    expect(intercept.hasPendingApproval('req-8202')).toBe(false);
  });

  test("x402:cancel: another window cannot clear this window's paywall or navigate its tab", async () => {
    detectOn(42, { id: 8203 });
    expect(await ipcHandlers['x402:cancel'](OTHER_WINDOW, { webContentsId: 42 })).toEqual(NOT_THIS_WINDOW);
    expect(await ipcHandlers['x402:cancel'](OTHER_WINDOW, { webContentsId: 42, navigate: false }))
      .toEqual(NOT_THIS_WINDOW);
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8203');
    expect(loadURL).not.toHaveBeenCalled();

    // The hosting window's own Cancel clears it and steps the tab away.
    expect(await ipcHandlers['x402:cancel'](fromChrome, { webContentsId: 42 })).toEqual({ success: true });
    expect(intercept.getDetectedPayment(42)).toBeNull();
    expect(loadURL).toHaveBeenCalledWith('about:blank');
  });

  test("x402:cancel refuses a closing tab, and a call naming no tab is not taken for the sender's", async () => {
    detectOn(44, { id: 8204 });
    expect(await ipcHandlers['x402:cancel'](fromChrome, { webContentsId: 44 })).toEqual(NOT_THIS_WINDOW);
    expect(intercept.getDetectedPayment(44)?.detectionId).toBe('req-8204');

    // Even were the sender's own id a tab it hosts, an unnamed tab is none.
    tabs.set(CHROME.id, hostedTab({ id: CHROME.id, loadURL }));
    detectOn(CHROME.id, { id: 8205 });
    expect(await ipcHandlers['x402:cancel'](fromChrome, {})).toEqual(NOT_THIS_WINDOW);
    expect(intercept.getDetectedPayment(CHROME.id)?.detectionId).toBe('req-8205');
    expect(loadURL).not.toHaveBeenCalled();
  });

  test("x402:resume-unlock: another window cannot release this window's held allowance payment", async () => {
    const waiting = heldUnlockWait(42);
    expect(await ipcHandlers['x402:resume-unlock'](OTHER_WINDOW, { webContentsId: 42 })).toEqual(NOT_THIS_WINDOW);
    expect(intercept.hasPendingUnlockWait(42)).toBe(true);
    // The hosting window's own resume releases it.
    expect(await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 42 })).toEqual({ success: true });
    await expect(waiting).resolves.toBeUndefined();

    // A paywall's held payment, too: refused, nothing signed, and it is
    // still there for this window's own resume.
    await lockedAutoPayOn(42, 8206);
    expect(await ipcHandlers['x402:resume-unlock'](OTHER_WINDOW, { webContentsId: 42 })).toEqual(NOT_THIS_WINDOW);
    nothingSigned();
    expect(await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 42 })).toEqual({ success: true });
    expect(signed).toHaveLength(1);
    expect(loadURL).toHaveBeenCalledWith('https://api.example/article');
  });

  test("x402:resume-unlock refuses a closing tab, and a call naming no tab is not taken for the sender's", async () => {
    tabs.set(45, hostedTab({ id: 45, loadURL }));
    await lockedAutoPayOn(45, 8207);
    const waiting = heldUnlockWait(46);
    tabs.set(46, hostedTab({ id: 46, loadURL, isDestroyed: () => true }));
    tabs.get(45).isDestroyed = () => true;
    expect(await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 45 })).toEqual(NOT_THIS_WINDOW);
    expect(await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 46 })).toEqual(NOT_THIS_WINDOW);
    nothingSigned();
    expect(intercept.hasPendingUnlockWait(46)).toBe(true);

    tabs.set(CHROME.id, hostedTab({ id: CHROME.id, loadURL }));
    const senderWaiting = heldUnlockWait(CHROME.id);
    expect(await ipcHandlers['x402:resume-unlock'](fromChrome, {})).toEqual(NOT_THIS_WINDOW);
    expect(intercept.hasPendingUnlockWait(CHROME.id)).toBe(true);

    // The tabs' own cleanup is what ends them.
    intercept.cleanupWebContents(46);
    intercept.cleanupWebContents(CHROME.id);
    await expect(waiting).rejects.toThrow('tab destroyed');
    await expect(senderWaiting).rejects.toThrow('tab destroyed');
    expect(intercept.consumePendingUnlockResume(45)).toMatchObject({ authorizedBy: 'cap' });
  });
});

// === The approvals panel's prompt (freedom-core design 0011, APS-5) =======
//
// With the approvals document on, `wallet:confirm-signing` asks for a payment
// in the window's panel with main's record of it: `paymentApprovalRequest`
// builds what the prompt shows and the token binds, and refuses, with
// nothing asked, whatever x402:approve would refuse.

describe('the panel asks for a payment as main holds it', () => {
  const FORGED = { scheme: 'exact', network: 'eip155:8453', amount: '1', asset: '0xforged', payTo: '0xforged' };

  test('the tab, URL and entry from main\'s record, not the chrome\'s; its token pays through x402:approve', async () => {
    detectOn(42, { id: 8301 });
    const request = paymentApprovalRequest(CHROME, {
      webContentsId: 42,
      detectionId: 'req-8301',
      url: 'https://evil.example/',
      acceptIndex: 0,
      accept: FORGED,
      grant: { capAmount: '5000000', windowSeconds: 86400, note: 'x' },
    });
    expect(request).toEqual({
      webContentsId: 42,
      detectionId: 'req-8301',
      url: 'https://api.example/article',
      acceptIndex: 0,
      accept: v2Detected().requirements.accepts[0],
      grant: { capAmount: '5000000', windowSeconds: 86400 },
    });
    const result = await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-8301',
      selectedAcceptIndex: 0,
      grant: { capAmount: '5000000', windowSeconds: 86400 },
      confirmation: await tokenFor(request),
    });
    expect(result).toEqual({ success: true });
    expect(signed.map(({ url, accept }) => ({ url, accept }))).toEqual([
      { url: 'https://api.example/article', accept: v2Detected().requirements.accepts[0] },
    ]);
    // The allowance the panel showed, written by the core.
    expect(mockCore.cap(ORIGIN, 8453, USDC)).toMatchObject({ capAmount: '5000000' });
  });

  test('a subresource\'s is judged by the awaiting detection\'s tab, not the one named', async () => {
    detectOn(42, { id: 8302, resourceType: 'xhr' });
    await Promise.resolve();
    expect(paymentApprovalRequest(CHROME, { webContentsId: 43, detectionId: 'req-8302' })).toMatchObject({
      webContentsId: 42,
      acceptIndex: 0,
      grant: null,
    });
    webContents.fromId.mockImplementation((id) =>
      id === 42 ? { ...hostedTab({ id }), hostWebContents: { id: 2, send: jest.fn() } } : hostedTab({ id })
    );
    expect(() => paymentApprovalRequest(CHROME, { webContentsId: 43, detectionId: 'req-8302' })).toThrow(
      'This payment is not on a tab of this window'
    );
    intercept.abortPendingApprovalsForTab(42, new Error('done'));
  });

  test('refused, with nothing asked, as x402:approve would refuse it', async () => {
    detectOn(42, { id: 8303 });
    detectOn(42, { id: 8304 });
    // Superseded, unknown, or none named.
    expect(() => paymentApprovalRequest(CHROME, { webContentsId: 42, detectionId: 'req-8303' })).toThrow(/stale/);
    expect(() => paymentApprovalRequest(CHROME, { webContentsId: 42 })).toThrow('No pending x402 payment to approve');
    // Another window's tab, or a sender that is none.
    expect(() => paymentApprovalRequest({ id: 2 }, { webContentsId: 42, detectionId: 'req-8304' })).toThrow('not on a tab of this window');
    // No entry at the index.
    for (const acceptIndex of [1, -1, 0.5, '0']) {
      expect(() => paymentApprovalRequest(CHROME, { webContentsId: 42, detectionId: 'req-8304', acceptIndex })).toThrow('No such payment option');
    }
    // An allowance the panel couldn't show as granted.
    for (const grant of [
      { capAmount: 5000000, windowSeconds: 86400 },
      { capAmount: '5e6', windowSeconds: 86400 },
      { capAmount: '5000000', windowSeconds: '86400' },
      { capAmount: '5000000', windowSeconds: 0 },
      { capAmount: '5000000', windowSeconds: 1.5 },
      { capAmount: '5000000' },
      ['5000000', 86400],
      'all',
    ]) {
      expect(() => paymentApprovalRequest(CHROME, { webContentsId: 42, detectionId: 'req-8304', grant })).toThrow('Invalid auto-pay allowance');
    }
    // Approved already.
    expect(await approveAsCard(42)).toEqual({ success: true });
    detectOn(42, { id: 8305 });
    intercept.claimApproval('req-8305', 42);
    expect(() => paymentApprovalRequest(CHROME, { webContentsId: 42, detectionId: 'req-8305' })).toThrow('already been approved');
  });
});

// A phone account's job goes to the window that asked (APS-4's
// request-window): for x402, the window hosting the payment's tab, on every
// path that signs, the auto-pay within a cap included (APS-5).
describe('an x402 payment signs for the window hosting its tab', () => {
  // The window each payment was signed for, as the core's sign saw it.
  const signedFor = () => signed.map(({ window }) => window);

  beforeEach(() => {
    mockFromWebContents.mockImplementation((contents) =>
      contents?.id === CHROME.id ? { id: 7, isDestroyed: () => false, webContents: contents } : null
    );
  });
  afterEach(() => {
    mockFromWebContents.mockReset().mockReturnValue(null);
    intercept.clearAllHostSenders();
  });

  test('a paywall paid on its card, a subresource paid on its card, and an auto-pay', async () => {
    detectOn(42, { id: 8401 });
    expect(await approveAsCard(42)).toEqual({ success: true });

    const detecting = detectOn(42, { id: 8402, resourceType: 'xhr', url: 'https://api.example/seg' });
    await Promise.resolve();
    expect(await approveAsCard(42, { detectionId: 'req-8402' })).toMatchObject({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });

    await seedCap({ capAmount: '1000000' });
    expect(await detectOn(42, { id: 8403, resourceType: 'xhr', url: 'https://api.example/seg2' })).toMatchObject({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
    });
    expect(corePayments().map(({ params }) => Object.keys(params.authorization))).toEqual([['token'], ['token'], ['cap']]);
    expect(signedFor()).toEqual([7, 7, 7]);
  });

  test('a tab main never saw in a window signs as before, for no window', async () => {
    mockFromWebContents.mockReturnValue(null);
    detectOn(42, { id: 8404 });
    expect(await approveAsCard(42)).toEqual({ success: true });
    expect(signedFor()).toEqual([null]);
  });
});

// === x402:cancel =========================================================

describe('x402:cancel', () => {
  test('clears the detection and steps back if history is available', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    const goBack = jest.fn();
    webContents.fromId.mockReturnValue(hostedTab({ canGoBack: () => true, goBack, loadURL: jest.fn() }));

    await ipcHandlers['x402:cancel'](fromChrome, { webContentsId: 42 });

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('falls back to about:blank when no history is available', async () => {
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ canGoBack: () => false, goBack: jest.fn(), loadURL }));

    await ipcHandlers['x402:cancel'](fromChrome, { webContentsId: 42 });

    expect(loadURL).toHaveBeenCalledWith('about:blank');
  });

  // The renderer runs the Back itself (through goBackInHistory, so the
  // gateway offer counts it as a traversal) and asks main only to clear.
  test('navigate: false clears the detection without navigating', async () => {
    require('./intercept').detectPaymentRequiredHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [
          Buffer.from(JSON.stringify(v2Detected().requirements)).toString('base64'),
        ],
      },
    });
    const goBack = jest.fn();
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ canGoBack: () => true, goBack, loadURL }));

    const result = await ipcHandlers['x402:cancel'](fromChrome, { webContentsId: 42, navigate: false });

    expect(result.success).toBe(true);
    expect(goBack).not.toHaveBeenCalled();
    expect(loadURL).not.toHaveBeenCalled();
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('refuses a tab main can no longer find', async () => {
    webContents.fromId.mockReturnValue(null);
    const result = await ipcHandlers['x402:cancel'](fromChrome, { webContentsId: 42 });
    expect(result).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
  });
});

describe('x402:refresh-balances', () => {
  test('clears the address cache, fetches fresh, and broadcasts x402:balances-updated', async () => {
    const fresh = {
      '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': {
        raw: '20000', formatted: '0.020000', symbol: 'USDC', decimals: 6,
      },
    };
    mockGetAllBalances.mockReset().mockResolvedValueOnce(fresh);

    const sidebarSend = jest.fn();
    webContents.fromId.mockReturnValue(hostedTab({ hostWebContents: { send: sidebarSend } }));

    const result = await ipcHandlers['x402:refresh-balances'](senderEvent(42));

    expect(result).toEqual({ success: true });
    expect(mockClearBalanceCache).toHaveBeenCalledWith(expect.any(String));
    expect(mockGetAllBalances).toHaveBeenCalledTimes(1);
    expect(sidebarSend).toHaveBeenCalledWith('x402:balances-updated', expect.objectContaining({
      webContentsId: 42,
      balances: fresh,
    }));
  });

  test('returns an error when the active wallet address can\'t be resolved (vault locked / no wallet)', async () => {
    // `mockResolvedValueOnce` queues a one-shot override; the default
    // (set at jest.mock time) stays intact for later tests.
    mockGetActiveWalletAddress.mockResolvedValueOnce(null);
    const result = await ipcHandlers['x402:refresh-balances'](senderEvent(42));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no active wallet/i);
  });

  test('surfaces fetch errors instead of broadcasting stale state', async () => {
    mockGetAllBalances.mockReset().mockRejectedValueOnce(new Error('RPC down'));
    const sidebarSend = jest.fn();
    webContents.fromId.mockReturnValue(hostedTab({ hostWebContents: { send: sidebarSend } }));

    const result = await ipcHandlers['x402:refresh-balances'](senderEvent(42));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/RPC down/);
    expect(sidebarSend).not.toHaveBeenCalled();
  });
});
