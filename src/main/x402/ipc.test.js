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
}));

const mockClient = {
  createPaymentPayload: jest.fn(),
};
const mockCreateClient = jest.fn(async () => mockClient);
jest.mock('./client', () => ({
  createX402Client: (idx) => mockCreateClient(idx),
}));

const mockGetActiveWalletIndex = jest.fn(() => 0);
const mockGetActiveWalletAddress = jest.fn(async () => '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => mockGetActiveWalletIndex(),
  getActiveWalletAddress: () => mockGetActiveWalletAddress(),
}));

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
  append: jest.fn(),
  KINDS: { X402: 'x402', WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
  STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
}));

const mockGrant = jest.fn();
const mockGetPermission = jest.fn();
const mockTryConsume = jest.fn();
const mockRevoke = jest.fn();
const mockRevokeAllForOrigin = jest.fn();
const mockUpdatePermission = jest.fn();
const mockGetAllPermissions = jest.fn();
jest.mock('./permissions', () => ({
  grant: (...a) => mockGrant(...a),
  getPermission: (...a) => mockGetPermission(...a),
  tryConsume: (...a) => mockTryConsume(...a),
  revoke: (...a) => mockRevoke(...a),
  revokeAllForOrigin: (...a) => mockRevokeAllForOrigin(...a),
  updatePermission: (...a) => mockUpdatePermission(...a),
  getAllPermissions: (...a) => mockGetAllPermissions(...a),
}));

const { webContents } = require('electron');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');
const intercept = require('./intercept');
const { outgoingHeaderForVersion } = require('./intercept');
const { registerX402Ipc } = require('./ipc');
const confirmations = require('../wallet/signing-confirmation');

beforeAll(() => {
  registerX402Ipc();
});

beforeEach(() => {
  confirmations._reset();
  intercept.clearAllDetectedPayments();
  intercept.clearAllPendingPayments();
  intercept.clearAllAwaitingResponse();
  intercept.clearAllPendingUnlockResume();
  intercept.clearAllPendingUnlockWaits();
  mockClient.createPaymentPayload.mockReset();
  mockCreateClient.mockReset().mockResolvedValue(mockClient);
  mockGetActiveWalletIndex.mockReturnValue(0);
  intercept.clearAllApprovalClaims();
  CHROME.send.mockReset();
  // Every tab is one of CHROME's unless a test says otherwise.
  webContents.fromId.mockReset().mockImplementation((id) => hostedTab({ id }));
  mockGetBalancesWithCache.mockReset().mockResolvedValue({ balances: {}, fromCache: true });
  mockGetAllBalances.mockReset().mockResolvedValue({});
  mockClearBalanceCache.mockReset();
  mockGetToken.mockReset();
  mockGrant.mockReset();
  mockGetPermission.mockReset().mockReturnValue(null);
  mockTryConsume.mockReset().mockReturnValue(false);
  mockRevoke.mockReset();
  mockRevokeAllForOrigin.mockReset();
  mockUpdatePermission.mockReset();
  mockGetAllPermissions.mockReset().mockReturnValue([]);
  mockGetRecentReceipts.mockReset().mockReturnValue([]);
});

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

// The token the card mints for `payment` (main binds the active account).
function confirmationFor(payment, walletIndex = 0) {
  return confirmations.issueConfirmation(confirmations.KINDS.X402_PAYMENT, walletIndex, payment).token;
}

// Press Pay the way the card does: mint for the payment shown, then
// approve it with that token.
function approveAsCard(tabId, opts = {}) {
  const payment = paymentAsShown(tabId, opts);
  return ipcHandlers['x402:approve'](fromChrome, {
    webContentsId: tabId,
    detectionId: payment.detectionId,
    selectedAcceptIndex: payment.acceptIndex,
    grant: opts.grant,
    confirmation: confirmationFor(payment, opts.walletIndex ?? 0),
  });
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

  test('signs, stashes a V2 pending payment, and re-navigates the webview', async () => {
    seedDetection(42);
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await approveAsCard(42);

    expect(result.success).toBe(true);
    expect(mockCreateClient).toHaveBeenCalledWith(0);
    expect(loadURL).toHaveBeenCalledWith('https://api.example/article');

    // The pending payment is now armed for the retry; the inject handler
    // should attach PAYMENT-SIGNATURE on the matching outbound request.
    const injected = intercept.injectPaymentSignatureHandler({
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
    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

    const result = await approveAsCard(42);
    expect(result.success).toBe(false);
    expect(result.error).toBe(VAULT_LOCKED_MESSAGE);
    // No pending payment armed when signing failed.
    expect(intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    })).toBeNull();
  });

  test('refuses to sign if there is no detected payment for the tab', async () => {
    const result = await ipcHandlers['x402:approve'](fromChrome);
    expect(result.success).toBe(false);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test('snapshot path (auto-pay): does NOT clear the tab-keyed detection so a newer pending approval flow survives', async () => {
    // Auto-pay captured snapshot A. Before A's setImmediate fires, a
    // second 402 (B) replaces detectedPayments[42]. When sign-flow
    // completes for A, it must not clear the map and erase B.
    seedDetection(42);  // simulate B sitting in the map
    expect(intercept.getDetectedPayment(42)).not.toBeNull();

    const snapshot = {
      url: 'https://api.example/article',
      requirements: v2Detected().requirements,
      resourceType: 'mainFrame',
    };
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const { signAndQueueRetry } = require('./sign-flow');
    await signAndQueueRetry(42, { detection: snapshot });

    // Map entry survives — whatever is in the map (e.g. B's approval
    // card) remains accessible to the IPC handlers.
    expect(intercept.getDetectedPayment(42)).not.toBeNull();
  });

  test('IPC approve path (no snapshot): does clear the tab-keyed detection on success', async () => {
    // Sanity-check that the lookup-by-id path retains its existing clear
    // behaviour.
    seedDetection(42);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    const result = await approveAsCard(42);
    expect(result.success).toBe(true);
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('cap-authorized inject (snapshot path) stamps authorizedBy=cap so a raced-over cap withholds the signature', async () => {
    const snapshot = {
      url: 'https://api.example/article',
      requirements: v2Detected().requirements,
      resourceType: 'mainFrame',
    };
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const { signAndQueueRetry } = require('./sign-flow');
    await signAndQueueRetry(42, { detection: snapshot, authorizedBy: 'cap' });

    // Now simulate the raced-over cap by returning false on the inject.
    mockTryConsume.mockReturnValueOnce(false);
    const injected = intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    expect(injected).toBeNull();
  });

  test('IPC approve on a cap-tagged detection (vault-unlock resume path) signs with cap authorization', async () => {
    // Auto-pay was blocked by a locked vault. The detector tagged the
    // detection authorizedBy=cap (covered by an intercept.test.js test);
    // here we simulate the end state and verify that x402:approve reads
    // the tag and threads it through to signAndQueueRetry, so the inject
    // handler will still withhold on a raced-over cap.
    seedDetection(42);
    Object.assign(intercept.getDetectedPayment(42), { authorizedBy: 'cap' });

    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await approveAsCard(42);
    expect(result.success).toBe(true);

    // The pending payment carries CAP authorization. Race-over withholds.
    mockTryConsume.mockReturnValueOnce(false);
    const injected = intercept.injectPaymentSignatureHandler({
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

    // (1) A — cap-covered, vault locked at sign time.
    mockGetPermission.mockReturnValueOnce({
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
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

    // (2) B — replaces detectedPayments[42].
    intercept.detectPaymentRequiredHandler({
      webContentsId: 42,
      url: urlB,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [requirementsB64] },
    });
    expect(intercept.getDetectedPayment(42)?.url).toBe(urlB);

    // (3) User unlocks. Renderer fires the dedicated resume IPC.
    mockCreateClient.mockResolvedValueOnce(mockClient);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:resume-unlock'](fromChrome, { webContentsId: 42 });
    expect(result.success).toBe(true);

    // (4) Pending payment is for A (the resume token), not B. We let the
    // cap-consume succeed for this probe so inject attaches the header
    // — the CAP-withhold behaviour is tested elsewhere; here we're
    // verifying the right URL was signed.
    mockTryConsume.mockReturnValueOnce(true);
    expect(intercept.injectPaymentSignatureHandler({
      webContentsId: 42, url: urlA, requestHeaders: {},
    })).not.toBeNull();

    // And NO pending payment for B (the newer map detection was ignored).
    expect(intercept.injectPaymentSignatureHandler({
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

    // (1) A → cap-covered → vault locked → token stashed.
    mockGetPermission.mockReturnValueOnce({
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    // A cap answers only for a live user tab main can attribute the 402 to.
    webContents.fromId.mockReturnValue(hostedTab({ hostWebContents: { send: jest.fn() } }));
    intercept.detectPaymentRequiredHandler({
      webContentsId: 42, url: urlA,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [requirementsB64] },
    });
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

    // (2) B → not cap-covered → approval card path → map has B.
    intercept.detectPaymentRequiredHandler({
      webContentsId: 42, url: urlB,
      statusLine: 'HTTP/1.1 402 Payment Required',
      resourceType: 'mainFrame',
      responseHeaders: { 'PAYMENT-REQUIRED': [requirementsB64] },
    });

    // (3) User clicks Pay on B's manual approval card.
    mockCreateClient.mockResolvedValueOnce(mockClient);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    const approveResult = await approveAsCard(42);
    expect(approveResult.success).toBe(true);

    // Pending payment is for B (what the user actually approved), not A.
    mockTryConsume.mockReturnValueOnce(true);
    expect(intercept.injectPaymentSignatureHandler({
      webContentsId: 42, url: urlB, requestHeaders: {},
    })).not.toBeNull();
    // And NO pending for A — the resume token survived (will be consumed
    // by x402:resume-unlock when the user finishes unlocking).
    expect(intercept.injectPaymentSignatureHandler({
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
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test('manual approve path stamps authorizedBy=manual so a false consume still attaches the header', async () => {
    seedDetection(42);
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    await approveAsCard(42);

    mockTryConsume.mockReturnValueOnce(false);
    const injected = intercept.injectPaymentSignatureHandler({
      webContentsId: 42,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });

  test('subresource 402 (xhr/fetch/media/...): pays and stashes signature but does NOT navigate the tab', async () => {
    // The whole point: a 402 on a page's fetch() must not yank the tab
    // away from the page that initiated the fetch. We still sign + stash
    // the pending PAYMENT-SIGNATURE so an x402-aware page that retries
    // gets the injection on its next outbound request.
    const detecting = seedDetection(42, 'xhr');
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await approveAsCard(42);

    // The detector holding the subresource open signs and 307s.
    expect(result).toEqual({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(loadURL).not.toHaveBeenCalled();
    // Injection is still armed so a page-initiated retry gets paid.
    const injected = intercept.injectPaymentSignatureHandler({
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

  test('returns kind=cover when an active cap fits the charge', async () => {
    seedDetection();
    mockGetPermission.mockReturnValueOnce({
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      capAmount: '10000000',
      spentAmount: '0',
      createdAt: 1,
      expiresAt: 9999999999,
    });

    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.autoPay).toMatchObject({ kind: 'cover', capAmount: '10000000' });
    expect(mockGetPermission).toHaveBeenCalledWith(
      'https://api.example',
      8453,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    );
  });

  test('returns kind=over-cap when the cap exists but is already spent', async () => {
    seedDetection();
    mockGetPermission.mockReturnValueOnce({
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      capAmount: '10000000',
      spentAmount: '9999999', // only 1 atomic unit left; charge is 10000
      createdAt: 1,
      expiresAt: 9999999999,
    });
    const result = await ipcHandlers['x402:get-details'](fromChrome, { webContentsId: 42 });
    expect(result.autoPay.kind).toBe('over-cap');
    expect(result.autoPay.remaining).toBe('1');
  });

  test('returns kind=none when no permission exists', async () => {
    seedDetection();
    mockGetPermission.mockReturnValueOnce(null);
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

  beforeEach(() => {
    seedDetection();
    webContents.fromId.mockReturnValue(hostedTab({ loadURL: jest.fn().mockResolvedValue() }));
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
  });

  test('with a grant arg: persists the cap (consume is deferred until inject — see intercept.test.js)', async () => {
    const result = await approveAsCard(42, {
      grant: { capAmount: '10000000', windowSeconds: 30 * 24 * 60 * 60 },
    });

    expect(result.success).toBe(true);
    expect(mockGrant).toHaveBeenCalledWith(
      'https://api.example',
      8453,
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      '10000000',
      30 * 24 * 60 * 60
    );
    // tryConsume no longer fires in sign-flow — it moved to the inject
    // handler so subresource 402s that sign-but-never-retry don't silently
    // burn cap headroom. See injectPaymentSignatureHandler's "consumes
    // the cap on inject" test in intercept.test.js.
    expect(mockTryConsume).not.toHaveBeenCalled();
  });

  test('without a grant arg: does not grant, does not consume (consume fires on inject)', async () => {
    await approveAsCard(42);
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockTryConsume).not.toHaveBeenCalled();
  });

  test('a failed grant does not block the sign / pay flow', async () => {
    mockGrant.mockImplementation(() => {
      throw new Error('windowSeconds must be positive');
    });
    const result = await approveAsCard(42, {
      grant: { capAmount: '10000000', windowSeconds: -1 },
    });
    expect(result.success).toBe(true);
    // Sign-flow no longer calls tryConsume; the failed grant still
    // doesn't break the approve flow.
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
    expect(mockGetRecentReceipts).toHaveBeenCalledWith({ kind: 'x402', limit: 50 });
  });

  test('passes through undefined limit when none provided', async () => {
    mockGetRecentReceipts.mockReturnValueOnce([]);
    const result = await ipcHandlers['x402:get-receipts'](senderEvent(42));
    expect(result.success).toBe(true);
    expect(mockGetRecentReceipts).toHaveBeenCalledWith({ kind: 'x402', limit: undefined });
  });
});

describe('x402:get-all-permissions + x402:revoke-permission', () => {
  test('get-all-permissions forwards from the store', async () => {
    mockGetAllPermissions.mockReturnValueOnce([
      { origin: 'https://a.example', chainId: 8453, asset: '0xabc', capAmount: '1', spentAmount: '0' },
    ]);
    const result = await ipcHandlers['x402:get-all-permissions'](senderEvent(42));
    expect(result.permissions).toHaveLength(1);
    expect(result.permissions[0]).toMatchObject({ origin: 'https://a.example' });
  });

  test('revoke-permission forwards origin/chainId/asset to the store', async () => {
    const result = await ipcHandlers['x402:revoke-permission'](senderEvent(42), {
      origin: 'https://a.example',
      chainId: 8453,
      asset: '0xabc',
    });
    expect(result.success).toBe(true);
    expect(mockRevoke).toHaveBeenCalledWith('https://a.example', 8453, '0xabc');
  });

  test('revoke-all-for-origin forwards the origin to the store', async () => {
    const result = await ipcHandlers['x402:revoke-all-for-origin'](senderEvent(42), {
      origin: 'https://a.example',
    });
    expect(result.success).toBe(true);
    expect(mockRevokeAllForOrigin).toHaveBeenCalledWith('https://a.example');
  });

  test('update-permission forwards the patch to the store and returns the record', async () => {
    mockUpdatePermission.mockReturnValueOnce({
      origin: 'https://a.example',
      chainId: 8453,
      asset: '0xabc',
      capAmount: '20000000',
      spentAmount: '500000',
    });
    const result = await ipcHandlers['x402:update-permission'](senderEvent(42), {
      origin: 'https://a.example',
      chainId: 8453,
      asset: '0xabc',
      capAmount: '20000000',
    });
    expect(result.success).toBe(true);
    expect(result.permission).toMatchObject({ capAmount: '20000000', spentAmount: '500000' });
    expect(mockUpdatePermission).toHaveBeenCalledWith('https://a.example', 8453, '0xabc', {
      capAmount: '20000000',
      windowSeconds: undefined,
    });
  });

  test('update-permission surfaces validation errors', async () => {
    mockUpdatePermission.mockImplementationOnce(() => {
      throw new Error('x402-permissions: no permission to update');
    });
    const result = await ipcHandlers['x402:update-permission'](senderEvent(42), {
      origin: 'https://a.example',
      chainId: 8453,
      asset: '0xabc',
      capAmount: '20000000',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no permission/);
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
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

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
    expect(mockCreateClient).not.toHaveBeenCalled();
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
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    const result = await approveAsCard(42, { detectionId: 'req-9300' });
    expect(result.success).toBe(true);
    expect(result.pending).toBeUndefined();
    expect(mockCreateClient).toHaveBeenCalled();
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
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

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
// x402:approve signs only with an 'x402-payment' token minted for exactly
// the payment main holds: its tab and detection, the chosen accepts[]
// entry, the active account and the grant. Auto-pay within an allowance
// signs in the detector, with no token.

describe('x402:approve requires a confirmation token for exactly this payment', () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
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
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
  });

  const nothingSigned = () => {
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(loadURL).not.toHaveBeenCalled();
  };

  test('a paywall approval without a token is refused before anything is signed', async () => {
    detect(42, { id: 7001 });
    const result = await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7001',
      selectedAcceptIndex: 0,
    });
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(result.error).toMatch(/no confirmation token/);
    nothingSigned();
    // The payment is still there for the user to approve.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7001');
  });

  test('a subresource approval without a token leaves the detector waiting', async () => {
    const detecting = detect(42, { id: 7002, resourceType: 'xhr' });
    for (const confirmation of [undefined, '', 'f'.repeat(64)]) {
      const result = await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7002',
        confirmation,
      });
      expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    }
    expect(intercept.hasPendingApproval('req-7002')).toBe(true);
    nothingSigned();

    // The user's own confirmation still pays it.
    expect(await approveAsCard(42, { detectionId: 'req-7002' })).toEqual({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
  });

  test("a token minted for tab A's payment cannot approve tab B's", async () => {
    detect(41, { id: 7101, url: 'https://a.example/article' });
    detect(42, { id: 7102, url: 'https://b.example/article' });
    const confirmation = confirmationFor(paymentAsShown(41));

    const result = await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7102',
      selectedAcceptIndex: 0,
      confirmation,
    });
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    nothingSigned();

    // Nor does a token that names tab A but B's detection: main binds the
    // tab it holds B's detection for.
    const relabelled = confirmationFor({ ...paymentAsShown(42), webContentsId: 41 });
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7102',
      confirmation: relabelled,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    nothingSigned();
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7102');
  });

  test("a token for tab A's subresource payment cannot settle tab B's", async () => {
    const detectingA = detect(41, { id: 7201, resourceType: 'xhr', url: 'https://a.example/seg' });
    const detectingB = detect(42, { id: 7202, resourceType: 'xhr', url: 'https://b.example/seg' });
    const confirmation = confirmationFor(paymentAsShown(41, { detectionId: 'req-7201' }));

    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7202',
      confirmation,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(intercept.hasPendingApproval('req-7202')).toBe(true);
    expect(intercept.hasPendingApproval('req-7201')).toBe(true);
    nothingSigned();

    intercept.abortPendingApproval('req-7201', new Error('cleared'));
    intercept.abortPendingApproval('req-7202', new Error('cleared'));
    await Promise.all([detectingA, detectingB]);
  });

  test('a token for accept entry 0 cannot sign entry 1', async () => {
    detect(42, { id: 7301, requirements: twoAccepts() });
    const confirmation = confirmationFor(paymentAsShown(42, { acceptIndex: 0 }));

    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7301',
      selectedAcceptIndex: 1,
      confirmation,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    nothingSigned();

    // Nor does one that claims index 1 with entry 0's terms.
    const mislabelled = confirmationFor({ ...paymentAsShown(42, { acceptIndex: 0 }), acceptIndex: 1 });
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7301',
      selectedAcceptIndex: 1,
      confirmation: mislabelled,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    nothingSigned();

    // Entry 1's own token signs entry 1, and only it.
    expect(await approveAsCard(42, { detectionId: 'req-7301', acceptIndex: 1 })).toEqual({ success: true });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(mockClient.createPaymentPayload.mock.calls[0][0].accepts).toEqual([twoAccepts().accepts[1]]);
  });

  test('an omitted index means entry 0: a token for entry 1 does not cover it', async () => {
    const detecting = detect(42, { id: 7302, resourceType: 'xhr', requirements: twoAccepts() });
    const confirmation = confirmationFor(paymentAsShown(42, { detectionId: 'req-7302', acceptIndex: 1 }));
    // No index: main checks entry 0, the entry it would sign.
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7302',
      confirmation,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(intercept.hasPendingApproval('req-7302')).toBe(true);

    expect(await approveAsCard(42, { detectionId: 'req-7302', acceptIndex: 1 })).toEqual({ success: true, pending: true });
    await detecting;
    expect(mockClient.createPaymentPayload.mock.calls[0][0].accepts).toEqual([twoAccepts().accepts[1]]);
  });

  test('an index outside accepts[] is refused, and burns the token', async () => {
    detect(42, { id: 7303 });
    const payment = paymentAsShown(42);
    const confirmation = confirmationFor(payment);
    for (const selectedAcceptIndex of [1, -1, 0.5, '0']) {
      expect(await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7303',
        selectedAcceptIndex,
        confirmation,
      })).toMatchObject({ success: false });
    }
    nothingSigned();
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7303',
      selectedAcceptIndex: 0,
      confirmation,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED', error: expect.stringMatching(/already used/) });
    nothingSigned();
  });

  test('a replayed token is refused', async () => {
    detect(42, { id: 7401 });
    const payment = paymentAsShown(42);
    const confirmation = confirmationFor(payment);
    const args = { webContentsId: 42, detectionId: 'req-7401', selectedAcceptIndex: 0, confirmation };

    // The first use fails after the check (the vault locked); the payment
    // stays, and the same token can't be presented again.
    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    expect(await ipcHandlers['x402:approve'](fromChrome, args)).toMatchObject({
      success: false,
      error: VAULT_LOCKED_MESSAGE,
    });
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7401');
    mockCreateClient.mockClear();

    const replay = await ipcHandlers['x402:approve'](fromChrome, args);
    expect(replay).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(replay.error).toMatch(/already used/);
    nothingSigned();
  });

  test('an expired token is refused', async () => {
    let clock = 5_000_000;
    confirmations._setNow(() => clock);
    detect(42, { id: 7402 });
    const confirmation = confirmationFor(paymentAsShown(42));
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
    const confirmation = confirmationFor(paymentAsShown(42));
    // A newer 402 supersedes the one the token was minted for.
    detect(42, { id: 7404 });
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7403',
      confirmation,
    })).toMatchObject({ success: false, error: expect.stringMatching(/stale/) });
    expect(confirmations._outstandingCount()).toBe(0);
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
    nothingSigned();
  });

  test('the token binds the account: switching accounts after confirming refuses it', async () => {
    detect(42, { id: 7501 });
    const confirmation = confirmationFor(paymentAsShown(42), 0);
    mockGetActiveWalletIndex.mockReturnValue(1);

    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7501',
      selectedAcceptIndex: 0,
      confirmation,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    nothingSigned();
  });

  test('the account checked is the account that signs, on both paths', async () => {
    // Account 3 is active when x402:approve checks the token; any later
    // read of the active account would see 5. The signature must use 3.
    mockGetActiveWalletIndex.mockReturnValue(5);
    detect(42, { id: 7502 });
    mockGetActiveWalletIndex.mockReturnValueOnce(3);
    expect(await approveAsCard(42, { walletIndex: 3 })).toEqual({ success: true });
    expect(mockCreateClient.mock.calls).toEqual([[3]]);

    // Subresource: the detector signs after the IPC has returned.
    mockCreateClient.mockClear();
    const detecting = detect(43, { id: 7503, resourceType: 'xhr' });
    mockGetActiveWalletIndex.mockReturnValueOnce(3);
    expect(await approveAsCard(43, { detectionId: 'req-7503', walletIndex: 3 })).toEqual({ success: true, pending: true });
    await detecting;
    expect(mockCreateClient.mock.calls).toEqual([[3]]);
  });

  test('the token binds the grant: none confirmed means none can be added, nor a larger one', async () => {
    detect(42, { id: 7601 });
    const GRANT = { capAmount: '10000000', windowSeconds: 30 * 24 * 60 * 60 };

    const withoutGrant = confirmationFor(paymentAsShown(42));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7601',
      selectedAcceptIndex: 0,
      grant: GRANT,
      confirmation: withoutGrant,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

    const smallGrant = confirmationFor(paymentAsShown(42, { grant: GRANT }));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 42,
      detectionId: 'req-7601',
      selectedAcceptIndex: 0,
      grant: { ...GRANT, capAmount: '1000000000000' },
      confirmation: smallGrant,
    })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(mockGrant).not.toHaveBeenCalled();
    nothingSigned();

    expect(await approveAsCard(42, { grant: GRANT })).toEqual({ success: true });
    expect(mockGrant).toHaveBeenCalledWith('https://api.example', 8453, USDC, GRANT.capAmount, GRANT.windowSeconds);
  });

  describe('auto-pay within an allowance still pays with no token', () => {
    const cap = () => ({
      origin: 'https://api.example',
      chainId: 8453,
      asset: USDC,
      capAmount: '20000',
      spentAmount: '0',
      createdAt: 1,
      expiresAt: 9999999999,
    });

    beforeEach(() => {
      mockGetPermission.mockReturnValue(cap());
      // An allowance answers only for a live user tab main can attribute
      // the 402 to.
      webContents.fromId.mockReturnValue(hostedTab({ loadURL, hostWebContents: { send: jest.fn() } }));
    });

    test('a paywall the allowance covers is signed and reloaded', async () => {
      expect(await detect(42, { id: 7701 })).toBeNull();
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

      expect(mockCreateClient).toHaveBeenCalledWith(0);
      expect(loadURL).toHaveBeenCalledWith('https://api.example/article');
      expect(confirmations._outstandingCount()).toBe(0);
      mockTryConsume.mockReturnValueOnce(true);
      expect(intercept.injectPaymentSignatureHandler({
        webContentsId: 42,
        url: 'https://api.example/article',
        requestHeaders: {},
      })?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    });

    test('a subresource the allowance covers is signed and redirected', async () => {
      expect(await detect(42, { id: 7702, resourceType: 'xhr', url: 'https://api.example/seg/1' })).toEqual({
        statusLine: 'HTTP/1.1 307 Temporary Redirect',
        responseHeaders: { Location: ['https://api.example/seg/1'] },
      });
      expect(mockCreateClient).toHaveBeenCalledTimes(1);
      expect(intercept.hasPendingApproval('req-7702')).toBe(false);
    });

    test('a charge over the allowance goes to the card, and needs a token', async () => {
      mockGetPermission.mockReturnValue({ ...cap(), spentAmount: '15000' });
      expect(await detect(42, { id: 7703 })).toBeNull();
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-7703');
      expect(await ipcHandlers['x402:approve'](fromChrome, {
        webContentsId: 42,
        detectionId: 'req-7703',
      })).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(mockCreateClient).not.toHaveBeenCalled();
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

// A sign held open the way a hardware wallet holds it: on the device until
// the test lets it go.
function signOnDevice() {
  let release;
  mockClient.createPaymentPayload.mockImplementation(() => new Promise((resolve) => {
    release = () => resolve({ x402Version: 2, payload: { authorization: {}, signature: '0xabc' } });
  }));
  return () => release();
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('x402:approve signs each detection once', () => {
  const approveWith = (tabId, detectionId, confirmation) =>
    ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: tabId,
      detectionId,
      selectedAcceptIndex: 0,
      confirmation,
    });

  beforeEach(() => {
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
  });

  test('two tokens for one subresource detection: the second approval is refused', async () => {
    const detecting = detectOn(42, { id: 8001, resourceType: 'xhr', url: 'https://api.example/seg/1' });
    const payment = paymentAsShown(42, { detectionId: 'req-8001' });
    const [first, second, third] = [1, 2, 3].map(() => confirmationFor(payment));
    const release = signOnDevice();

    expect(await approveWith(42, 'req-8001', first)).toEqual({ success: true, pending: true });
    // While the first approval's sign is on the device.
    const again = await approveWith(42, 'req-8001', second);
    expect(again).toMatchObject({ success: false, error: expect.stringMatching(/already been approved/) });
    expect([again.success, mockClient.createPaymentPayload.mock.calls.length]).toEqual([false, 1]);

    release();
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    // And after it was signed: the detection is still the tab's record,
    // but it has been paid.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8001');
    expect(await approveWith(42, 'req-8001', third)).toMatchObject({ success: false });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    // Every token presented was burnt.
    expect(confirmations._outstandingCount()).toBe(0);
  });

  test('two tokens for one paywall detection: the second approval is refused', async () => {
    detectOn(42, { id: 8002 });
    const payment = paymentAsShown(42);
    const [first, second] = [1, 2].map(() => confirmationFor(payment));

    expect(await approveWith(42, 'req-8002', first)).toEqual({ success: true });
    const again = await approveWith(42, 'req-8002', second);
    expect([again.success, mockClient.createPaymentPayload.mock.calls.length]).toEqual([false, 1]);
    expect(confirmations._outstandingCount()).toBe(0);
  });

  test('two concurrent paywall approvals: the one that arrives while the first is signing is refused', async () => {
    detectOn(42, { id: 8003 });
    const payment = paymentAsShown(42);
    const [first, second] = [1, 2].map(() => confirmationFor(payment));
    const release = signOnDevice();

    const paying = approveWith(42, 'req-8003', first);
    await flush();
    // The detection is still in the map: its sign hasn't finished.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8003');
    const again = await approveWith(42, 'req-8003', second);
    expect(again).toMatchObject({ success: false, error: expect.stringMatching(/already been approved/) });

    release();
    expect(await paying).toEqual({ success: true });
    expect([again.success, mockClient.createPaymentPayload.mock.calls.length]).toEqual([false, 1]);
    expect(confirmations._outstandingCount()).toBe(0);
  });

  test("a failed paywall sign hands the detection back for the card's retry, which pays it once", async () => {
    detectOn(42, { id: 8004 });
    const payment = paymentAsShown(42);
    const [first, retry, third] = [1, 2, 3].map(() => confirmationFor(payment));

    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    expect(await approveWith(42, 'req-8004', first)).toMatchObject({ success: false, error: VAULT_LOCKED_MESSAGE });
    expect(await approveWith(42, 'req-8004', retry)).toEqual({ success: true });
    expect(await approveWith(42, 'req-8004', third)).toMatchObject({ success: false });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });

  test('a failed subresource sign re-arms the detection; the retry pays it once', async () => {
    const detecting = detectOn(42, { id: 8005, resourceType: 'xhr', url: 'https://api.example/seg/2' });
    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    expect(await approveAsCard(42, { detectionId: 'req-8005' })).toEqual({ success: true, pending: true });
    await flush();
    // The detector told the card and re-armed the same detection.
    expect(intercept.hasPendingApproval('req-8005')).toBe(true);
    expect(CHROME.send).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-8005',
      success: false,
      error: VAULT_LOCKED_MESSAGE,
    });

    const retry = paymentAsShown(42, { detectionId: 'req-8005' });
    const [paid, extra] = [1, 2].map(() => confirmationFor(retry));
    expect(await approveWith(42, 'req-8005', paid)).toEqual({ success: true, pending: true });
    expect(await approveWith(42, 'req-8005', extra)).toMatchObject({ success: false });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
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
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(2);
  });

  test('a closed tab drops its claims', async () => {
    detectOn(42, { id: 8007 });
    const [first, second] = [1, 2].map(() => confirmationFor(paymentAsShown(42)));
    const release = signOnDevice();
    const paying = approveWith(42, 'req-8007', first);
    await flush();
    expect(intercept.isApprovalClaimed('req-8007')).toBe(true);
    intercept.cleanupWebContents(42);
    expect(intercept.isApprovalClaimed('req-8007')).toBe(false);
    // Its detection went with it, so nothing can approve it again.
    expect(await approveWith(42, 'req-8007', second)).toMatchObject({ success: false, error: expect.stringMatching(/stale/) });
    release();
    await paying;
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
  });
});

describe("x402 payment authority belongs to the window hosting the payment's tab", () => {
  const OTHER_WINDOW = { sender: { id: 2, send: jest.fn() } };
  const SIGNED = { x402Version: 2, payload: { authorization: {}, signature: '0xabc' } };
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
    mockClient.createPaymentPayload.mockResolvedValue(SIGNED);
  });

  const nothingSigned = () => {
    expect(mockCreateClient).not.toHaveBeenCalled();
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
    const confirmation = confirmationFor(paymentAsShown(42));
    expect(await ipcHandlers['x402:approve'](OTHER_WINDOW, {
      webContentsId: 42,
      detectionId: 'req-8104',
      selectedAcceptIndex: 0,
      confirmation,
    })).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(confirmations._outstandingCount()).toBe(0);
    nothingSigned();
    // Not claimed by the refusal: the hosting window's own Pay still works.
    expect(intercept.getDetectedPayment(42)?.detectionId).toBe('req-8104');
    expect(await approveAsCard(42)).toEqual({ success: true });
    expect(loadURL).toHaveBeenCalledWith('https://api.example/article');
  });

  test("another window cannot settle this window's subresource approval", async () => {
    const detecting = detectOn(42, { id: 8105, resourceType: 'xhr', url: 'https://api.example/seg/9' });
    const confirmation = confirmationFor(paymentAsShown(42, { detectionId: 'req-8105' }));
    expect(await ipcHandlers['x402:approve'](OTHER_WINDOW, {
      webContentsId: 43,
      detectionId: 'req-8105',
      selectedAcceptIndex: 0,
      confirmation,
    })).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(confirmations._outstandingCount()).toBe(0);
    expect(intercept.hasPendingApproval('req-8105')).toBe(true);
    nothingSigned();

    expect(await approveAsCard(42, { detectionId: 'req-8105' })).toEqual({ success: true, pending: true });
    expect(await detecting).toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
  });

  test('a closed tab cannot be approved, and the token is burnt', async () => {
    detectOn(44, { id: 8106 });
    const confirmation = confirmationFor(paymentAsShown(44));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 44,
      detectionId: 'req-8106',
      selectedAcceptIndex: 0,
      confirmation,
    })).toEqual({ success: false, error: 'This payment is not on a tab of this window' });
    expect(confirmations._outstandingCount()).toBe(0);
    nothingSigned();

    // Nor one main can no longer find at all.
    tabs.delete(44);
    const again = confirmationFor(paymentAsShown(44));
    expect(await ipcHandlers['x402:approve'](fromChrome, {
      webContentsId: 44,
      detectionId: 'req-8106',
      selectedAcceptIndex: 0,
      confirmation: again,
    })).toMatchObject({ success: false });
    expect(confirmations._outstandingCount()).toBe(0);
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
    mockGetPermission.mockReturnValue({
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockCreateClient.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    detectOn(tabId, { id });
    await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    mockCreateClient.mockClear();
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
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
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
