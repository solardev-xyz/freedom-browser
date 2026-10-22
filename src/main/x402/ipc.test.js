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

beforeAll(() => {
  registerX402Ipc();
});

beforeEach(() => {
  intercept.clearAllDetectedPayments();
  intercept.clearAllPendingPayments();
  intercept.clearAllAwaitingResponse();
  intercept.clearAllPendingUnlockResume();
  intercept.clearAllPendingUnlockWaits();
  mockClient.createPaymentPayload.mockReset();
  mockCreateClient.mockReset().mockResolvedValue(mockClient);
  mockGetActiveWalletIndex.mockReturnValue(0);
  webContents.fromId.mockReset();
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

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
    expect(result.success).toBe(true);
    expect(result.asset).toBeNull();
  });

  test('returns an error when no payment was detected for the tab', async () => {
    const result = await ipcHandlers['x402:get-details'](senderEvent(999));
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

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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
    webContents.fromId.mockReturnValue({ hostWebContents: { send: sidebarSend } });

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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
  const seedDetection = (tabId = 42, resourceType = 'mainFrame') => {
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
  };

  test('signs, stashes a V2 pending payment, and re-navigates the webview', async () => {
    seedDetection(42);
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue({ loadURL });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:approve'](senderEvent(42));

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

    const result = await ipcHandlers['x402:approve'](senderEvent(42));
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
    const result = await ipcHandlers['x402:approve'](senderEvent(42));
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
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
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
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    const result = await ipcHandlers['x402:approve'](senderEvent(42), {});
    expect(result.success).toBe(true);
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('cap-authorized inject (snapshot path) stamps authorizedBy=cap so a raced-over cap withholds the signature', async () => {
    const snapshot = {
      url: 'https://api.example/article',
      requirements: v2Detected().requirements,
      resourceType: 'mainFrame',
    };
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
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

    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:approve'](senderEvent(42));
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
    webContents.fromId.mockReturnValue({ hostWebContents: { send: jest.fn() } });

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
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:resume-unlock'](senderEvent(42));
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
    webContents.fromId.mockReturnValue({ hostWebContents: { send: jest.fn() } });
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
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    const approveResult = await ipcHandlers['x402:approve'](senderEvent(42));
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
    const result = await ipcHandlers['x402:resume-unlock'](senderEvent(42));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no pending unlock-resume/i);
  });

  test('x402:resume-unlock settles a pending unlock-wait (subresource path) without invoking signAndQueueRetry from the IPC', async () => {
    // The IPC must NOT call signAndQueueRetry on the wait path —
    // calling it would double-sign for the closure-driven attempt.
    const waitPromise = intercept.setPendingUnlockWait(42);

    const result = await ipcHandlers['x402:resume-unlock'](senderEvent(42));
    expect(result).toEqual({ success: true });
    expect(intercept.hasPendingUnlockWait(42)).toBe(false);
    await expect(waitPromise).resolves.toBeUndefined();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  test('manual approve path stamps authorizedBy=manual so a false consume still attaches the header', async () => {
    seedDetection(42);
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    await ipcHandlers['x402:approve'](senderEvent(42), {});

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
    seedDetection(42, 'xhr');
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue({ loadURL });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:approve'](senderEvent(42));

    expect(result.success).toBe(true);
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

    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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
    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
    expect(result.autoPay.kind).toBe('over-cap');
    expect(result.autoPay.remaining).toBe('1');
  });

  test('returns kind=none when no permission exists', async () => {
    seedDetection();
    mockGetPermission.mockReturnValueOnce(null);
    const result = await ipcHandlers['x402:get-details'](senderEvent(42));
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
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
  });

  test('with a grant arg: persists the cap (consume is deferred until inject — see intercept.test.js)', async () => {
    const result = await ipcHandlers['x402:approve'](senderEvent(42), {
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
    await ipcHandlers['x402:approve'](senderEvent(42), {});
    expect(mockGrant).not.toHaveBeenCalled();
    expect(mockTryConsume).not.toHaveBeenCalled();
  });

  test('a failed grant does not block the sign / pay flow', async () => {
    mockGrant.mockImplementation(() => {
      throw new Error('windowSeconds must be positive');
    });
    const result = await ipcHandlers['x402:approve'](senderEvent(42), {
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

    const result = await ipcHandlers['x402:reject'](senderEvent(42), { detectionId: 'req-9001' });
    expect(result).toEqual({ success: true, settled: true });

    // Detector returns null, page sees the 402.
    expect(await handlerPromise).toBeNull();
  });

  test('returns settled=false when there is no pending approval for the detectionId', async () => {
    const result = await ipcHandlers['x402:reject'](senderEvent(42), { detectionId: 'req-nonexistent' });
    expect(result).toEqual({ success: true, settled: false });
  });

  test('refuses without a detectionId', async () => {
    const result = await ipcHandlers['x402:reject'](senderEvent(42), {});
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

    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const result = await ipcHandlers['x402:approve'](senderEvent(42), {
      detectionId: 'req-9100',
    });
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
    const result = await ipcHandlers['x402:approve'](senderEvent(42), {
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
    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });
    const result = await ipcHandlers['x402:approve'](senderEvent(42), {
      detectionId: 'req-9300',
    });
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

    webContents.fromId.mockReturnValue({ loadURL: jest.fn().mockResolvedValue() });
    mockClient.createPaymentPayload.mockResolvedValue({
      x402Version: 2,
      payload: { authorization: {}, signature: '0xabc' },
    });

    const approveResult = await ipcHandlers['x402:approve'](senderEvent(42), {
      detectionId: 'req-9002',
    });
    expect(approveResult.success).toBe(true);

    const handlerResult = await handlerPromise;
    expect(handlerResult).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/segment/0'] },
    });
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
    webContents.fromId.mockReturnValue({
      canGoBack: () => true,
      goBack,
      loadURL: jest.fn(),
    });

    await ipcHandlers['x402:cancel'](senderEvent(42));

    expect(goBack).toHaveBeenCalledTimes(1);
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('falls back to about:blank when no history is available', async () => {
    const loadURL = jest.fn().mockResolvedValue();
    webContents.fromId.mockReturnValue({
      canGoBack: () => false,
      goBack: jest.fn(),
      loadURL,
    });

    await ipcHandlers['x402:cancel'](senderEvent(42));

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
    webContents.fromId.mockReturnValue({ canGoBack: () => true, goBack, loadURL });

    const event = senderEvent(42);
    const result = await ipcHandlers['x402:cancel'](event, { webContentsId: 42, navigate: false });

    expect(result.success).toBe(true);
    expect(goBack).not.toHaveBeenCalled();
    expect(loadURL).not.toHaveBeenCalled();
    expect(intercept.getDetectedPayment(42)).toBeNull();
  });

  test('no-ops if the webContents has already gone away', async () => {
    webContents.fromId.mockReturnValue(null);
    const result = await ipcHandlers['x402:cancel'](senderEvent(42));
    expect(result.success).toBe(true);
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
    webContents.fromId.mockReturnValue({ hostWebContents: { send: sidebarSend } });

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
    webContents.fromId.mockReturnValue({ hostWebContents: { send: sidebarSend } });

    const result = await ipcHandlers['x402:refresh-balances'](senderEvent(42));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/RPC down/);
    expect(sidebarSend).not.toHaveBeenCalled();
  });
});
