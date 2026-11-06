// x402 auto-pay caps through main's real detector, sign flow, injector, cap
// store and confirmations; only the signer, Electron and the stores around
// them are mocked.
//
// #1024: a cap is charged before a payment is signed, so two auto-pays can
// never both be signed against headroom for one, and the charge is given
// back when the signature never goes out.
// #1023: a cap's amount or window changes only with a confirmation for
// exactly that edit.

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockUserData;
const ipcHandlers = {};
const mockHostSend = jest.fn();
// Tabs by webContents id: live user tabs of the chrome window (id 1).
const mockTabs = new Map();
jest.mock('electron', () => ({
  app: { getPath: () => mockUserData },
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
  },
  webContents: { fromId: (id) => mockTabs.get(id) ?? null },
}));

const mockClient = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  createPaymentPayload: jest.fn(),
};
jest.mock('./client', () => ({ createX402Client: jest.fn(async () => mockClient) }));
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 0,
  getActiveWalletAddress: async () => mockClient.address,
}));
jest.mock('../wallet/balance-service', () => ({
  getBalancesWithCache: async () => ({ balances: {}, fromCache: true }),
  getAllBalances: async () => ({}),
  clearBalanceCache: () => {},
}));
jest.mock('../webrequest-dispatcher', () => ({ registerWebRequestHandler: jest.fn() }));
jest.mock('../token-registry', () => ({ getToken: () => null, getTokenKey: (c, a) => `${c}:${a}` }));
jest.mock('../payment-history', () => ({
  getRecent: () => [],
  append: jest.fn(),
  KINDS: { X402: 'x402' },
  STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
}));

const intercept = require('./intercept');
const permissions = require('./permissions');
const confirmations = require('../wallet/signing-confirmation');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');
const { registerX402Ipc } = require('./ipc');

const ORIGIN = 'https://api.example';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const CHAIN = 8453;
const PRICE = '10000';
const REQUIREMENTS = {
  x402Version: 2,
  resource: { url: `${ORIGIN}/article` },
  accepts: [
    {
      scheme: 'exact',
      network: `eip155:${CHAIN}`,
      amount: PRICE,
      asset: USDC,
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};
const CHROME = { id: 1, send: mockHostSend, isDestroyed: () => false };
const SIGNED = { x402Version: 2, payload: { authorization: {}, signature: '0xabc' } };

beforeAll(() => registerX402Ipc());

beforeEach(() => {
  mockUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'x402-cap-charge-'));
  permissions._resetCache();
  confirmations._reset();
  intercept.clearAllPendingPayments();
  intercept.clearAllDetectedPayments();
  intercept.clearAllAwaitingResponse();
  intercept.clearAllPendingApprovals();
  intercept.clearAllApprovalClaims();
  intercept.clearAllPendingUnlockWaits();
  intercept.clearAllPendingUnlockResume();
  intercept.clearAllHostSenders();
  mockTabs.clear();
  for (const id of [41, 42]) {
    mockTabs.set(id, {
      id,
      hostWebContents: CHROME,
      isDestroyed: () => false,
      loadURL: jest.fn().mockResolvedValue(),
    });
  }
  mockHostSend.mockReset();
  mockClient.createPaymentPayload.mockReset().mockResolvedValue(SIGNED);
});

afterEach(() => {
  fs.rmSync(mockUserData, { recursive: true, force: true });
});

// A cap of `capAmount` for the paid origin, as the approval card grants it.
const grantCap = (capAmount = PRICE) => permissions.grant(ORIGIN, CHAIN, USDC, capAmount, 3600);
const spent = () => permissions.getPermission(ORIGIN, CHAIN, USDC)?.spentAmount;

const detect = (tabId, { id, resourceType = 'xhr', url = `${ORIGIN}/seg/${id}` } = {}) =>
  intercept.detectPaymentRequiredHandler({
    id,
    webContentsId: tabId,
    url,
    statusLine: 'HTTP/1.1 402 Payment Required',
    resourceType,
    responseHeaders: {
      'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(REQUIREMENTS)).toString('base64')],
    },
  });
const retry = (tabId, url, id) =>
  intercept.injectPaymentSignatureHandler({ id, webContentsId: tabId, url, requestHeaders: {} });
const cardsRaised = () =>
  mockHostSend.mock.calls.filter(([channel]) => channel === 'x402:approval-needed').map(([, p]) => p.detectionId);
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

// A sign held on the device until the test lets it go.
function holdSign() {
  let release;
  mockClient.createPaymentPayload.mockImplementationOnce(
    () => new Promise((resolve) => { release = () => resolve(SIGNED); }));
  return () => release();
}

describe('an auto-pay charges its cap before it signs (#1024)', () => {
  test('two subresource auto-pays one cap covers: one is signed, the other goes to the card', async () => {
    grantCap(PRICE);
    const release = holdSign();

    const first = detect(42, { id: 1 });
    // The first is on the device; the cap has been charged already.
    expect(spent()).toBe(PRICE);
    const second = detect(42, { id: 2 });
    await settle();

    expect(cardsRaised()).toEqual(['req-2']);
    release();
    await expect(first).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(retry(42, `${ORIGIN}/seg/1`, 11)?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    expect(spent()).toBe(PRICE);

    intercept.cleanupWebContents(42);
    await expect(second).resolves.toBeNull();
  });

  test('two paywalls on two tabs that one cap covers: one is signed, the other goes to the card', async () => {
    grantCap(PRICE);
    expect(await detect(41, { id: 3, resourceType: 'mainFrame', url: `${ORIGIN}/a` })).toBeNull();
    expect(await detect(42, { id: 4, resourceType: 'mainFrame', url: `${ORIGIN}/b` })).toBeNull();
    await settle();

    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(cardsRaised()).toEqual(['req-4']);
    expect(spent()).toBe(PRICE);
  });

  test('a sign that fails gives the charge back', async () => {
    grantCap('20000');
    mockClient.createPaymentPayload.mockRejectedValueOnce(new Error('device unplugged'));
    await expect(detect(42, { id: 5 })).resolves.toBeNull();
    expect(spent()).toBe('0');
  });

  test('a vault that is locked gives the charge back while the user unlocks it', async () => {
    grantCap('20000');
    const { createX402Client } = require('./client');
    createX402Client.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    const pending = detect(42, { id: 6 });
    await settle();
    expect(spent()).toBe('0');

    // Unlocked: it is charged again and signed.
    await ipcHandlers['x402:resume-unlock']({ sender: CHROME }, { webContentsId: 42 });
    await expect(pending).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(spent()).toBe(PRICE);
  });

  test('spent while the vault was locked, it goes to the card instead of being signed', async () => {
    grantCap(PRICE);
    const { createX402Client } = require('./client');
    createX402Client.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    const pending = detect(42, { id: 7 });
    await settle();
    // Another payment uses the cap meanwhile.
    expect(permissions.charge(ORIGIN, CHAIN, USDC, PRICE)).not.toBeNull();

    await ipcHandlers['x402:resume-unlock']({ sender: CHROME }, { webContentsId: 42 });
    await settle();
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(cardsRaised()).toEqual(['req-7']);

    intercept.cleanupWebContents(42);
    await expect(pending).resolves.toBeNull();
  });
});

describe('a paywall auto-pay held for a vault unlock (#1024)', () => {
  test('spent meanwhile, the unlock signs nothing and reloads the page to its card', async () => {
    grantCap(PRICE);
    const { createX402Client } = require('./client');
    createX402Client.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    expect(await detect(42, { id: 8, resourceType: 'mainFrame', url: `${ORIGIN}/c` })).toBeNull();
    await settle();
    expect(spent()).toBe('0');
    expect(permissions.charge(ORIGIN, CHAIN, USDC, PRICE)).not.toBeNull();

    const result = await ipcHandlers['x402:resume-unlock']({ sender: CHROME }, { webContentsId: 42 });
    expect(result).toMatchObject({ success: false, code: 'X402_CAP_NOT_COVERED' });
    expect(mockClient.createPaymentPayload).not.toHaveBeenCalled();
    expect(mockTabs.get(42).loadURL).toHaveBeenCalledWith(`${ORIGIN}/c`);
  });

  test('still covered, the unlock charges it again and signs it', async () => {
    grantCap(PRICE);
    const { createX402Client } = require('./client');
    createX402Client.mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    expect(await detect(42, { id: 9, resourceType: 'mainFrame', url: `${ORIGIN}/d` })).toBeNull();
    await settle();

    await expect(ipcHandlers['x402:resume-unlock']({ sender: CHROME }, { webContentsId: 42 }))
      .resolves.toMatchObject({ success: true });
    expect(mockClient.createPaymentPayload).toHaveBeenCalledTimes(1);
    expect(spent()).toBe(PRICE);
  });
});

describe('a charge is given back when its signature never goes out (#1024)', () => {
  async function signedAutoPay(id) {
    grantCap('20000');
    await expect(detect(42, { id })).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(spent()).toBe(PRICE);
  }

  test('a pending signature that expires unsent, on the next request of any page', async () => {
    await signedAutoPay(26);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(retry(41, 'https://elsewhere.example/', 36)).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(spent()).toBe('0');
  });

  test('a pending signature that expires unsent', async () => {
    await signedAutoPay(21);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(retry(42, `${ORIGIN}/seg/21`, 31)).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(spent()).toBe('0');
  });

  test('the tab closing before the retry', async () => {
    await signedAutoPay(22);
    intercept.cleanupWebContents(42);
    expect(spent()).toBe('0');
  });

  test('the cap revoked and granted again before the retry: withheld, and the new cap is not charged', async () => {
    await signedAutoPay(23);
    permissions.revoke(ORIGIN, CHAIN, USDC);
    const realNow = Date.now;
    Date.now = () => realNow() + 2000; // a new grant is another cap
    try {
      grantCap('20000');
      expect(retry(42, `${ORIGIN}/seg/23`, 33)).toBeNull();
    } finally {
      Date.now = realNow;
    }
    expect(spent()).toBe('0');
  });

  // A cap's createdAt is in whole seconds: one revoked and granted again
  // within the same second is still another cap (#1028 review).
  describe('the cap revoked and granted again within the same second', () => {
    let realNow;
    beforeEach(() => {
      realNow = Date.now;
      const fixed = realNow();
      Date.now = () => fixed;
    });
    afterEach(() => {
      Date.now = realNow;
    });

    test('a new cap that does not cover it: the old charge does not stand, and the header is withheld', async () => {
      await signedAutoPay(27);
      const { createdAt } = permissions.getPermission(ORIGIN, CHAIN, USDC);
      permissions.revoke(ORIGIN, CHAIN, USDC);
      grantCap('1');
      expect(permissions.getPermission(ORIGIN, CHAIN, USDC).createdAt).toBe(createdAt);

      expect(retry(42, `${ORIGIN}/seg/27`, 37)).toBeNull();
      expect(spent()).toBe('0');
    });

    test('a new cap the same as the old: withheld, and the old charge is not given back to it', async () => {
      await signedAutoPay(28);
      permissions.revoke(ORIGIN, CHAIN, USDC);
      grantCap('20000');
      // The new cap's own charge, which the old one's refund must not undo.
      expect(permissions.charge(ORIGIN, CHAIN, USDC, PRICE)).not.toBeNull();

      expect(retry(42, `${ORIGIN}/seg/28`, 38)).toBeNull();
      expect(spent()).toBe(PRICE);
    });

    test('the tab closing: the old charge is not given back to the new cap', async () => {
      await signedAutoPay(29);
      permissions.revoke(ORIGIN, CHAIN, USDC);
      grantCap('20000');
      expect(permissions.charge(ORIGIN, CHAIN, USDC, PRICE)).not.toBeNull();

      intercept.cleanupWebContents(42);
      expect(spent()).toBe(PRICE);
    });

    test('the cap left alone: the header goes out', async () => {
      await signedAutoPay(30);
      expect(retry(42, `${ORIGIN}/seg/30`, 40)?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
      expect(spent()).toBe(PRICE);
    });
  });

  test('once the header has gone out, the charge stays whatever the server answers', async () => {
    await signedAutoPay(24);
    expect(retry(42, `${ORIGIN}/seg/24`, 34)?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    intercept.paymentResponseLoggingHandler({
      id: 34,
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {},
      url: `${ORIGIN}/seg/24`,
    });
    expect(spent()).toBe(PRICE);
  });

  test('a payment the user approved with an allowance is charged as it is stashed, and given back unsent', async () => {
    const pending = detect(42, { id: 25 });
    await settle();
    expect(cardsRaised()).toEqual(['req-25']);
    const grant = { capAmount: '50000', windowSeconds: 3600 };
    const payment = {
      webContentsId: 42,
      detectionId: 'req-25',
      url: `${ORIGIN}/seg/25`,
      acceptIndex: 0,
      accept: REQUIREMENTS.accepts[0],
      grant,
    };
    const { token } = confirmations.issueConfirmation(confirmations.KINDS.X402_PAYMENT, 0, payment);
    await ipcHandlers['x402:approve']({ sender: CHROME }, {
      webContentsId: 42,
      detectionId: 'req-25',
      selectedAcceptIndex: 0,
      grant,
      confirmation: token,
    });
    await expect(pending).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(spent()).toBe(PRICE);

    intercept.cleanupWebContents(42);
    expect(spent()).toBe('0');
  });
});

describe('x402:update-permission needs a confirmation for the edit (#1023)', () => {
  const EDIT = { origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount: '99000000' };
  const mint = (edit, windowId = CHROME.id) =>
    confirmations.issueConfirmation(
      confirmations.KINDS.X402_CAP_UPDATE,
      null,
      permissions.capUpdateRequest(windowId, edit)
    ).token;

  test('a bare call raises nothing', async () => {
    grantCap(PRICE);
    const result = await ipcHandlers['x402:update-permission']({ sender: CHROME }, EDIT);
    expect(result).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(permissions.getPermission(ORIGIN, CHAIN, USDC).capAmount).toBe(PRICE);

    const window = await ipcHandlers['x402:update-permission']({ sender: CHROME }, {
      origin: ORIGIN,
      chainId: CHAIN,
      asset: USDC,
      windowSeconds: 10 * 365 * 86400,
    });
    expect(window).toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    const cap = permissions.getPermission(ORIGIN, CHAIN, USDC);
    expect(cap.expiresAt - cap.createdAt).toBe(3600);
  });

  test('with its token, from the window that confirmed it, the edit is applied once', async () => {
    grantCap(PRICE);
    const confirmation = mint(EDIT);
    await expect(ipcHandlers['x402:update-permission']({ sender: { id: 2 } }, { ...EDIT, confirmation }))
      .resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });

    await expect(
      ipcHandlers['x402:update-permission']({ sender: CHROME }, { ...EDIT, confirmation: mint(EDIT) })
    ).resolves.toMatchObject({ success: true, permission: { capAmount: '99000000' } });
    expect(permissions.getPermission(ORIGIN, CHAIN, USDC).capAmount).toBe('99000000');
  });

  test('a token minted before the cap changed does not apply after', async () => {
    grantCap(PRICE);
    const confirmation = mint(EDIT);
    // Spent meanwhile: not a change of the cap. Its window moved: one.
    permissions.charge(ORIGIN, CHAIN, USDC, PRICE);
    permissions.updatePermission(ORIGIN, CHAIN, USDC, { windowSeconds: 7200 });
    await expect(ipcHandlers['x402:update-permission']({ sender: CHROME }, { ...EDIT, confirmation }))
      .resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
    expect(permissions.getPermission(ORIGIN, CHAIN, USDC).capAmount).toBe(PRICE);
  });

  test('a token minted before the cap was revoked and granted again, in the same second, does not apply after', async () => {
    const realNow = Date.now;
    const fixed = realNow();
    Date.now = () => fixed;
    try {
      const old = grantCap(PRICE);
      const confirmation = mint(EDIT);
      permissions.revoke(ORIGIN, CHAIN, USDC);
      // The same cap again, to the second: amount, createdAt and expiresAt.
      const replacement = grantCap(PRICE);
      expect(replacement).toEqual(old);

      await expect(ipcHandlers['x402:update-permission']({ sender: CHROME }, { ...EDIT, confirmation }))
        .resolves.toMatchObject({ success: false, code: 'SIGNING_NOT_CONFIRMED' });
      expect(permissions.getPermission(ORIGIN, CHAIN, USDC).capAmount).toBe(PRICE);

      // A token minted for the replacement applies to it.
      await expect(ipcHandlers['x402:update-permission']({ sender: CHROME }, { ...EDIT, confirmation: mint(EDIT) }))
        .resolves.toMatchObject({ success: true, permission: { capAmount: '99000000' } });
    } finally {
      Date.now = realNow;
    }
  });
});

describe('the cap store charges and gives back', () => {
  test('a charge goes back only to the cap it was taken from, never below zero', () => {
    grantCap('20000');
    const taken = permissions.charge(ORIGIN, CHAIN, USDC, PRICE);
    expect(taken).toMatchObject({ origin: ORIGIN, chainId: CHAIN, asset: USDC, amount: PRICE });
    expect(permissions.chargeStands(taken)).toBe(true);
    expect(permissions.refund(taken)).toBe(true);
    expect(spent()).toBe('0');
    expect(permissions.refund(taken)).toBe(true);
    expect(spent()).toBe('0');

    permissions.revoke(ORIGIN, CHAIN, USDC);
    expect(permissions.chargeStands(taken)).toBe(false);
    expect(permissions.refund(taken)).toBe(false);
  });

  test('no charge beyond the cap', () => {
    grantCap(PRICE);
    expect(permissions.charge(ORIGIN, CHAIN, USDC, PRICE)).not.toBeNull();
    expect(permissions.charge(ORIGIN, CHAIN, USDC, '1')).toBeNull();
    expect(permissions.tryConsume(ORIGIN, CHAIN, USDC, '1')).toBe(false);
  });
});
