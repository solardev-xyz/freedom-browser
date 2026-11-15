// x402 auto-pay caps through main's real detector, sign flow, injector, IPC,
// cap mirror and confirmations, over the identity core's x402 methods
// (cored 0.18.0, X402-1/X402-2), simulated (test/helpers/simulated-
// approvals.js); the real core's in x402.integration.test.js. Only the
// core, Electron and the stores around them are faked.
//
// #1024: the core charges a cap as it signs a payment (`x402.authorize`), so
// two auto-pays can never both be signed against headroom for one, and main
// settles each charge with it (`x402.settle`): `withheld` gives the charge
// back when the signature never goes out, `sent` keeps it.
// #1044: an allowance pays only for a live tab the user controls.
// #1023: a cap's amount or window is the core's; main's edit is refused.

jest.mock('../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const ipcHandlers = {};
const mockHostSend = jest.fn();
// Tabs by webContents id: live user tabs of the chrome window (id 1).
const mockTabs = new Map();
jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel, handler) => {
      ipcHandlers[channel] = handler;
    },
  },
  webContents: { fromId: (id) => mockTabs.get(id) ?? null },
}));

// The identity core: its x402 store (main's mirror reads it), its
// `x402-payment` tokens, `x402.authorize` and `x402.settle`.
const mockCore = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({ vaultBackend: { approval: mockCore.approval, x402: mockCore.x402 } }));

jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 0,
  getActiveWalletAddress: async () => '0x0000000000000000000000000000000000000001',
  getWalletRecord: () => null,
  isHardwareWalletIndex: (index) => index >= 100,
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
}));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: jest.fn() }));
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
const caps = require('./caps');
const grants = require('../core/grants');
const confirmations = require('../wallet/signing-confirmation');
const { setAgentPageCustody } = require('../wallet/agent-tab-custody');
const { registerX402Ipc, paymentApprovalRequest } = require('./ipc');

const ORIGIN = 'https://api.example';
// The core keys a cap's asset in lowercase.
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
const AUTO_PAY = { cap: { agent: false, attributable: true } };

// The core's signature of a payment, each one counted: the account's
// authorization, with a runway the facilitator accepts.
const mockSigner = jest.fn((params, accept) => ({
  x402Version: 2,
  payload: {
    authorization: {
      from: '0x0000000000000000000000000000000000000001',
      to: accept.payTo,
      value: accept.amount,
      validAfter: '0',
      validBefore: String(Math.floor(Date.now() / 1000) + 300),
      nonce: '0x' + '11'.repeat(32),
    },
    signature: '0xabc',
  },
  accepted: accept,
}));
const realAuthorize = mockCore.x402.authorize;

// The mirror main reads caps from, loaded from the simulated core.
const loadCaps = () => grants._useBackendForTests(mockCore.approval);

beforeAll(() => registerX402Ipc());

beforeEach(async () => {
  mockCore.reset();
  mockCore.setX402Signer(mockSigner);
  mockSigner.mockClear();
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
  await loadCaps();
});

afterEach(() => {
  mockCore.x402.authorize = realAuthorize;
});

afterAll(() => grants._useBackendForTests(null));

// A cap of `capAmount` the core holds for the paid origin (as the approval
// card grants it), and main's mirror of it.
async function grantCap(capAmount = PRICE, extra = {}) {
  const cap = mockCore.seedCap({ origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount, windowSeconds: 3600, ...extra });
  await loadCaps();
  return cap;
}
// What the core has charged the cap.
const spent = () => mockCore.cap(ORIGIN, CHAIN, USDC)?.spentAmount;
const signatures = () => mockSigner.mock.calls.length;
const coreAsked = () => mockCore.calls.filter(({ method }) => method === 'x402.authorize');
// The settles of the core's charges, main's (the simulated core records
// its own too, when a signature it charged for fails; only the test of
// that case has one, and it reads none).
const settles = () => mockCore.calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => params);

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
const resume = (tabId) => ipcHandlers['x402:resume-unlock']({ sender: CHROME }, { webContentsId: tabId });
const cardsRaised = () =>
  mockHostSend.mock.calls.filter(([channel]) => channel === 'x402:approval-needed').map(([, p]) => p.detectionId);
const capConsumed = () => mockHostSend.mock.calls.filter(([channel]) => channel === 'x402:cap-consumed');
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const toAgent = (tabId) => setAgentPageCustody(mockTabs.get(tabId), true);

// The core's signature held (on the device, say) until the test lets it
// go. The core charges the cap first, as it does before it signs.
function holdSign() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  mockCore.x402.authorize = async (params, context) => {
    mockCore.x402.authorize = realAuthorize;
    const reply = await realAuthorize(params, context);
    await gate;
    return reply;
  };
  return () => release();
}

describe('the core charges an auto-pay as it signs it (#1024)', () => {
  test('two subresource auto-pays one cap covers: one is signed, the other goes to the card', async () => {
    await grantCap(PRICE);
    const release = holdSign();

    const first = detect(42, { id: 1 });
    await settle();
    // The first is on the device; the core has charged the cap already,
    // though main's mirror hasn't read it back yet.
    expect(spent()).toBe(PRICE);
    expect(caps.getPermission(ORIGIN, CHAIN, USDC).spentAmount).toBe('0');
    const second = detect(42, { id: 2 });
    await settle();

    // The mirror said it was covered: the core was asked, and refused it.
    expect(coreAsked()).toHaveLength(2);
    expect(cardsRaised()).toEqual(['req-2']);
    release();
    await expect(first).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(signatures()).toBe(1);
    expect((await retry(42, `${ORIGIN}/seg/1`, 11))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    await settle();
    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'sent' }]);
    expect(spent()).toBe(PRICE);

    intercept.cleanupWebContents(42);
    await expect(second).resolves.toBeNull();
  });

  test('two paywalls on two tabs that one cap covers: one is signed, the other reloads to the card', async () => {
    await grantCap(PRICE);
    expect(await detect(41, { id: 3, resourceType: 'mainFrame', url: `${ORIGIN}/a` })).toBeNull();
    expect(await detect(42, { id: 4, resourceType: 'mainFrame', url: `${ORIGIN}/b` })).toBeNull();
    await settle();

    expect(coreAsked()).toHaveLength(2);
    expect(signatures()).toBe(1);
    expect(spent()).toBe(PRICE);
    expect((await retry(41, `${ORIGIN}/a`, 13))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    // The one the core refused loads again, and its 402 goes to the card:
    // the mirror has read the charge back.
    expect(mockTabs.get(42).loadURL).toHaveBeenCalledWith(`${ORIGIN}/b`);
    expect(cardsRaised()).toEqual([]);
    expect(await detect(42, { id: 14, resourceType: 'mainFrame', url: `${ORIGIN}/b` })).toBeNull();
    await settle();
    expect(cardsRaised()).toEqual(['req-14']);
    expect(signatures()).toBe(1);
  });

  test('a signature the core fails to make leaves the cap uncharged', async () => {
    await grantCap('20000');
    mockSigner.mockImplementationOnce(() => {
      throw new Error('device unplugged');
    });
    await expect(detect(42, { id: 5 })).resolves.toBeNull();
    expect(spent()).toBe('0');
  });

  test("a signature main can't send (its runway ran out) gives the charge back", async () => {
    await grantCap('20000');
    mockSigner.mockImplementationOnce((params, accept) => ({
      x402Version: 2,
      payload: { authorization: { validBefore: String(Math.floor(Date.now() / 1000) + 2) }, signature: '0xabc' },
      accepted: accept,
    }));
    await expect(detect(42, { id: 15 })).resolves.toBeNull();
    await settle();
    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'withheld' }]);
    expect(spent()).toBe('0');
    expect(await retry(42, `${ORIGIN}/seg/15`, 25)).toBeNull();
  });

  test('a locked vault charges nothing while the user unlocks it; unlocked, the core charges it and signs', async () => {
    await grantCap('20000');
    mockCore.setX402Locked(true);
    const pending = detect(42, { id: 6 });
    await settle();
    expect(intercept.hasPendingUnlockWait(42)).toBe(true);
    expect(spent()).toBe('0');
    expect(signatures()).toBe(0);

    // Unlocked: the core is asked again, charges it and signs.
    mockCore.setX402Locked(false);
    await resume(42);
    await expect(pending).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(coreAsked()).toHaveLength(2);
    expect(spent()).toBe(PRICE);
  });

  test('spent while the vault was locked, it goes to the card instead of being signed', async () => {
    await grantCap(PRICE);
    mockCore.setX402Locked(true);
    const pending = detect(42, { id: 7 });
    await settle();
    mockCore.setX402Locked(false);
    // Another tab's auto-pay uses the cap meanwhile.
    await expect(detect(41, { id: 70 })).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(spent()).toBe(PRICE);

    await resume(42);
    await settle();
    // Asked again, the core refused it: only the other tab's was signed.
    expect(coreAsked()).toHaveLength(3);
    expect(signatures()).toBe(1);
    expect(cardsRaised()).toEqual(['req-7']);

    intercept.cleanupWebContents(42);
    await expect(pending).resolves.toBeNull();
  });
});

describe('a paywall auto-pay held for a vault unlock (#1024)', () => {
  test('spent meanwhile, the unlock signs nothing and reloads the page to its card', async () => {
    await grantCap(PRICE);
    mockCore.setX402Locked(true);
    expect(await detect(42, { id: 8, resourceType: 'mainFrame', url: `${ORIGIN}/c` })).toBeNull();
    await settle();
    expect(spent()).toBe('0');
    mockCore.setX402Locked(false);
    await expect(detect(41, { id: 80 })).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });

    const result = await resume(42);
    expect(result).toMatchObject({ success: false, code: 'X402_CAP_NOT_COVERED' });
    // The core was asked again, and signed only the other tab's.
    expect(coreAsked()).toHaveLength(3);
    expect(signatures()).toBe(1);
    expect(spent()).toBe(PRICE);
    expect(mockTabs.get(42).loadURL).toHaveBeenCalledWith(`${ORIGIN}/c`);
  });

  test('still covered, the unlock has the core charge it again and sign it', async () => {
    await grantCap(PRICE);
    mockCore.setX402Locked(true);
    expect(await detect(42, { id: 9, resourceType: 'mainFrame', url: `${ORIGIN}/d` })).toBeNull();
    await settle();
    expect(spent()).toBe('0');
    mockCore.setX402Locked(false);

    await expect(resume(42)).resolves.toMatchObject({ success: true });
    expect(signatures()).toBe(1);
    expect(spent()).toBe(PRICE);
    expect((await retry(42, `${ORIGIN}/d`, 19))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });
});

// #1044: an allowance pays only for a tab the user controls. Detection reads
// custody as the 402 arrives; a held auto-pay reads it again before the core
// is asked and once it has signed, so a tab that went into Agent custody
// meanwhile gets the approval card, with nothing charged or sent.
describe('a held auto-pay does not pay from the cap once its tab is in Agent custody (#1044)', () => {
  // A vault locked for the first payment, unlocked before the resume.
  const lockVaultOnce = () => {
    mockCore.setX402Locked(true);
    return () => mockCore.setX402Locked(false);
  };

  test('a subresource held for the unlock goes to the card, uncharged and unsigned', async () => {
    await grantCap(PRICE);
    const unlock = lockVaultOnce();
    const pending = detect(42, { id: 51 });
    await settle();
    expect(intercept.hasPendingUnlockWait(42)).toBe(true);
    expect(spent()).toBe('0');

    toAgent(42);
    unlock();
    await expect(resume(42)).resolves.toMatchObject({ success: true });
    await settle();

    // The core was not even asked again: only the locked attempt.
    expect(coreAsked()).toHaveLength(1);
    expect(signatures()).toBe(0);
    expect(spent()).toBe('0');
    expect(cardsRaised()).toEqual(['req-51']);
    // Nothing held is left for a later resume, and nothing signed to attach.
    expect(intercept.hasPendingUnlockWait(42)).toBe(false);
    expect(intercept.consumePendingUnlockResume(42)).toBeNull();
    expect(await retry(42, `${ORIGIN}/seg/51`, 61)).toBeNull();

    intercept.cleanupWebContents(42);
    await expect(pending).resolves.toBeNull();
  });

  test('a paywall held for the unlock reloads to its card, uncharged and unsigned', async () => {
    await grantCap(PRICE);
    const unlock = lockVaultOnce();
    expect(await detect(42, { id: 52, resourceType: 'mainFrame', url: `${ORIGIN}/e` })).toBeNull();
    await settle();
    expect(spent()).toBe('0');

    toAgent(42);
    unlock();
    await expect(resume(42)).resolves.toMatchObject({ success: false, code: 'X402_CAP_NOT_COVERED' });
    expect(coreAsked()).toHaveLength(1);
    expect(signatures()).toBe(0);
    expect(spent()).toBe('0');
    // The resume token is spent: a later resume finds nothing to sign.
    await expect(resume(42)).resolves.toMatchObject({
      success: false,
      error: 'No pending unlock-resume for this tab',
    });

    // The page loads again, and its 402 goes to the card, as any 402 on a
    // tab in Agent custody does.
    expect(mockTabs.get(42).loadURL).toHaveBeenCalledWith(`${ORIGIN}/e`);
    expect(await detect(42, { id: 53, resourceType: 'mainFrame', url: `${ORIGIN}/e` })).toBeNull();
    await settle();
    expect(cardsRaised()).toEqual(['req-53']);
    expect(coreAsked()).toHaveLength(1);
    expect(spent()).toBe('0');
  });

  test('a subresource whose tab goes into Agent custody while it is on the device: dropped, given back, to the card', async () => {
    await grantCap(PRICE);
    const release = holdSign();
    const pending = detect(42, { id: 54 });
    await settle();
    expect(signatures()).toBe(1);
    expect(spent()).toBe(PRICE);

    toAgent(42);
    release();
    await settle();

    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'withheld' }]);
    expect(spent()).toBe('0');
    expect(cardsRaised()).toEqual(['req-54']);
    expect(await retry(42, `${ORIGIN}/seg/54`, 64)).toBeNull();

    intercept.cleanupWebContents(42);
    await expect(pending).resolves.toBeNull();
  });

  test('a paywall whose tab goes into Agent custody while it is on the device: dropped, given back, reloaded to the card', async () => {
    await grantCap(PRICE);
    const release = holdSign();
    expect(await detect(42, { id: 55, resourceType: 'mainFrame', url: `${ORIGIN}/f` })).toBeNull();
    await settle();
    expect(signatures()).toBe(1);
    expect(spent()).toBe(PRICE);

    toAgent(42);
    release();
    await settle();

    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'withheld' }]);
    expect(spent()).toBe('0');
    expect(await retry(42, `${ORIGIN}/f`, 65)).toBeNull();
    expect(mockTabs.get(42).loadURL).toHaveBeenCalledTimes(1);
    expect(mockTabs.get(42).loadURL).toHaveBeenCalledWith(`${ORIGIN}/f`);
  });

  test("a tab back in the user's hands by the unlock is paid from the cap", async () => {
    await grantCap(PRICE);
    const unlock = lockVaultOnce();
    const pending = detect(42, { id: 56 });
    await settle();

    toAgent(42);
    setAgentPageCustody(mockTabs.get(42), false);
    unlock();
    await expect(resume(42)).resolves.toMatchObject({ success: true });
    await expect(pending).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(spent()).toBe(PRICE);
    expect(cardsRaised()).toEqual([]);
    expect((await retry(42, `${ORIGIN}/seg/56`, 66))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });

  test("another tab in Agent custody does not stop a user tab's held paywall", async () => {
    await grantCap(PRICE);
    const unlock = lockVaultOnce();
    expect(await detect(42, { id: 57, resourceType: 'mainFrame', url: `${ORIGIN}/g` })).toBeNull();
    await settle();

    toAgent(41);
    unlock();
    await expect(resume(42)).resolves.toMatchObject({ success: true });
    expect(signatures()).toBe(1);
    expect(spent()).toBe(PRICE);
    expect((await retry(42, `${ORIGIN}/g`, 67))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });
});

describe('a charge is given back when its signature never goes out (#1024)', () => {
  // The reservation the core gave main's last payment.
  let reservationGiven = null;
  const lastReservation = () => reservationGiven;
  beforeEach(() => {
    reservationGiven = null;
    mockCore.x402.authorize = async (params, context) => {
      const reply = await realAuthorize(params, context);
      reservationGiven = reply.reservation;
      return reply;
    };
  });

  // An auto-pay signed and stashed, the cap charged for it: its reservation.
  async function signedAutoPay(id) {
    await grantCap('20000');
    await expect(detect(42, { id })).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    expect(spent()).toBe(PRICE);
    await settle();
    mockHostSend.mockReset();
    expect(lastReservation()).toMatch(/^[0-9a-f]{32}$/);
    return lastReservation();
  }

  test('a pending signature that expires unsent, on the next request of any page', async () => {
    const reservation = await signedAutoPay(26);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(await retry(41, 'https://elsewhere.example/', 36)).toBeNull();
    } finally {
      Date.now = realNow;
    }
    await settle();
    expect(settles()).toEqual([{ reservation, outcome: 'withheld' }]);
    expect(spent()).toBe('0');
    expect(capConsumed()).toEqual([['x402:cap-consumed', { origin: ORIGIN }]]);
  });

  test('a pending signature that expires unsent', async () => {
    const reservation = await signedAutoPay(21);
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      expect(await retry(42, `${ORIGIN}/seg/21`, 31)).toBeNull();
    } finally {
      Date.now = realNow;
    }
    await settle();
    expect(settles()).toEqual([{ reservation, outcome: 'withheld' }]);
    expect(spent()).toBe('0');
  });

  test('the tab closing before the retry', async () => {
    const reservation = await signedAutoPay(22);
    intercept.cleanupWebContents(42);
    await settle();
    expect(settles()).toEqual([{ reservation, outcome: 'withheld' }]);
    expect(spent()).toBe('0');
  });

  test('the cap revoked before the retry: withheld, and a cap granted again later is not given the old charge', async () => {
    const reservation = await signedAutoPay(23);
    // The activity pane's revoke, through the core.
    await caps.revoke(ORIGIN, CHAIN, USDC);
    expect(await retry(42, `${ORIGIN}/seg/23`, 33)).toBeNull();
    await settle();
    expect(settles()).toEqual([{ reservation, outcome: 'withheld' }]);
    expect(capConsumed()).toEqual([]);

    await grantCap('20000');
    expect(spent()).toBe('0');
  });

  // The core gives a charge back only to the cap it was taken from (its
  // generation), however like it a cap granted again is: amount, createdAt
  // and expiresAt to the second (#1028 review).
  describe('the cap revoked and granted again, the same to the second', () => {
    let realNow;
    let fixed;
    beforeEach(() => {
      realNow = Date.now;
      fixed = realNow();
      Date.now = () => fixed;
    });
    afterEach(() => {
      Date.now = realNow;
    });

    // The cap revoked and granted again as it was, and the new one
    // charged by another tab's auto-pay, whose header goes out.
    async function grantedAgainAndCharged() {
      const old = mockCore.cap(ORIGIN, CHAIN, USDC);
      await caps.revoke(ORIGIN, CHAIN, USDC);
      await grantCap('20000', { createdAt: old.createdAt, expiresAt: old.expiresAt });
      expect(mockCore.cap(ORIGIN, CHAIN, USDC)).toEqual({ ...old, spentAmount: '0' });
      await expect(detect(41, { id: 90 })).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
      expect((await retry(41, `${ORIGIN}/seg/90`, 91))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
      expect(spent()).toBe(PRICE);
      await settle();
      mockHostSend.mockReset();
    }

    test('the tab closing: the old charge is not given back to the new cap', async () => {
      const reservation = await signedAutoPay(29);
      await grantedAgainAndCharged();

      intercept.cleanupWebContents(42);
      await settle();
      expect(settles()).toEqual([
        { reservation: expect.any(String), outcome: 'sent' },
        { reservation, outcome: 'withheld' },
      ]);
      expect(spent()).toBe(PRICE);
      expect(capConsumed()).toEqual([]);
    });

    test('the signature expiring unsent: the old charge is not given back to the new cap', async () => {
      const reservation = await signedAutoPay(31);
      await grantedAgainAndCharged();

      fixed += 61_000;
      expect(await retry(42, `${ORIGIN}/seg/31`, 41)).toBeNull();
      await settle();
      expect(settles()).toEqual([
        { reservation: expect.any(String), outcome: 'sent' },
        { reservation, outcome: 'withheld' },
      ]);
      expect(spent()).toBe(PRICE);
      expect(capConsumed()).toEqual([]);
    });

    // X402-2's decision 3, closed by cored 0.19.0: the mirror shows a cap
    // like the old one, so main's own check passes, but the core refuses
    // `sent` for a cap that isn't the one charged (`cap_changed`), and the
    // header is withheld. The reservation is spent there: nothing is given
    // back to the new cap, and nothing more is settled.
    test('the retry: the core refuses sent (cap_changed), and the header is withheld', async () => {
      const reservation = await signedAutoPay(32);
      await grantedAgainAndCharged();

      expect(await retry(42, `${ORIGIN}/seg/32`, 42)).toBeNull();
      await settle();
      expect(settles()).toEqual([
        { reservation: expect.any(String), outcome: 'sent' },
        { reservation, outcome: 'sent' },
      ]);
      expect(spent()).toBe(PRICE);
      expect(capConsumed()).toEqual([]);
      expect(mockCore.openReservations()).toBe(0);
    });

    test('the cap left alone: the header goes out', async () => {
      const reservation = await signedAutoPay(30);
      expect((await retry(42, `${ORIGIN}/seg/30`, 40))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
      await settle();
      expect(settles()).toEqual([{ reservation, outcome: 'sent' }]);
      expect(spent()).toBe(PRICE);
    });
  });

  test('once the header has gone out, the charge stays whatever the server answers', async () => {
    const reservation = await signedAutoPay(24);
    expect((await retry(42, `${ORIGIN}/seg/24`, 34))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    intercept.paymentResponseLoggingHandler({
      id: 34,
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {},
      url: `${ORIGIN}/seg/24`,
    });
    await settle();
    expect(settles()).toEqual([{ reservation, outcome: 'sent' }]);
    expect(spent()).toBe(PRICE);
    // Settled once: nothing left to give back.
    expect(mockCore.openReservations()).toBe(0);
  });

  test('a payment the user approved with an allowance is charged as it is stashed, and given back unsent', async () => {
    const pending = detect(42, { id: 25 });
    await settle();
    expect(cardsRaised()).toEqual(['req-25']);
    const grant = { capAmount: '50000', windowSeconds: 3600 };
    // The card's Pay: the panel's prompt names the payment from main's
    // record, and the core mints the `x402-payment` token that binds it.
    const payment = paymentApprovalRequest(CHROME, { webContentsId: 42, detectionId: 'req-25', acceptIndex: 0, grant });
    const { token } = await confirmations.issueConfirmation(confirmations.KINDS.X402_PAYMENT, 0, payment);
    await expect(
      ipcHandlers['x402:approve']({ sender: CHROME }, {
        webContentsId: 42,
        detectionId: 'req-25',
        selectedAcceptIndex: 0,
        grant,
        confirmation: token,
      })
    ).resolves.toEqual({ success: true, pending: true });
    await expect(pending).resolves.toMatchObject({ statusLine: 'HTTP/1.1 307 Temporary Redirect' });
    // The core spent the token, wrote the cap it binds and charged it.
    expect(coreAsked()[0].params.authorization).toEqual({ token });
    expect(coreAsked()[0].params.grant).toEqual({ cap_amount: '50000', window_seconds: 3600 });
    expect(mockCore.cap(ORIGIN, CHAIN, USDC)).toMatchObject({ capAmount: '50000', spentAmount: PRICE });
    const reservation = lastReservation();

    intercept.cleanupWebContents(42);
    await settle();
    expect(settles()).toEqual([{ reservation, outcome: 'withheld' }]);
    expect(spent()).toBe('0');
  });
});

describe('x402:update-permission narrows a cap through the core, and raises none (X402-2b, #1023)', () => {
  const update = (sender, args) => ipcHandlers['x402:update-permission']({ sender }, args);
  // The core asked anything since `from`.
  const askedSince = (from) => mockCore.calls.slice(from).map(({ method }) => method);
  const NARROW_ONLY = caps.NARROW_ONLY;

  test('a larger or equal amount or window is refused unasked, and the cap is unchanged', async () => {
    const cap = await grantCap(PRICE);
    const from = mockCore.calls.length;
    const window = cap.expiresAt - cap.createdAt;

    for (const change of [
      { capAmount: '99000000' },
      { capAmount: PRICE },
      { windowSeconds: 10 * 365 * 86400 },
      { windowSeconds: window },
      { capAmount: '1', windowSeconds: window + 1 },
    ]) {
      await expect(update(CHROME, { origin: ORIGIN, chainId: CHAIN, asset: USDC, ...change })).resolves.toEqual({
        success: false,
        error: NARROW_ONLY,
        code: 'forbidden',
      });
    }

    expect(askedSince(from)).toEqual([]);
    expect(mockCore.cap(ORIGIN, CHAIN, USDC)).toEqual(cap);
    expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toMatchObject({ capAmount: PRICE, expiresAt: cap.expiresAt });
  });

  test('a lower amount, then a shorter window: x402.update as the chrome, and the mirror reads it back', async () => {
    const cap = await grantCap('20000');
    const from = mockCore.calls.length;

    await expect(update(CHROME, { origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount: '15000' })).resolves.toEqual({
      success: true,
    });
    await expect(update(CHROME, { origin: ORIGIN, chainId: CHAIN, asset: USDC, windowSeconds: 600 })).resolves.toEqual({
      success: true,
    });

    const narrowings = mockCore.calls.slice(from).filter(({ method }) => method === 'x402.update');
    expect(narrowings.map(({ params, page }) => ({ params, page }))).toEqual([
      { params: { key: ORIGIN, cap: { chain_id: CHAIN, asset: USDC }, cap_amount: '15000' }, page: 'chrome' },
      { params: { key: ORIGIN, cap: { chain_id: CHAIN, asset: USDC }, window_seconds: 600 }, page: 'chrome' },
    ]);
    expect(askedSince(from).filter((method) => method !== 'approval.grants')).toEqual(['x402.update', 'x402.update']);
    expect(mockCore.cap(ORIGIN, CHAIN, USDC)).toMatchObject({ capAmount: '15000', expiresAt: cap.createdAt + 600 });
    expect(caps.getPermission(ORIGIN, CHAIN, USDC)).toMatchObject({ capAmount: '15000', expiresAt: cap.createdAt + 600 });
  });

  test("a cap that isn't there, or a malformed amount, is refused unasked", async () => {
    await grantCap('20000');
    const from = mockCore.calls.length;
    const other = await update(CHROME, { origin: 'https://other.example', chainId: CHAIN, asset: USDC, capAmount: '1' });
    expect(other).toMatchObject({ success: false, error: 'This auto-pay cap is no longer there' });
    const malformed = await update(CHROME, { origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount: '0100' });
    expect(malformed.success).toBe(false);
    const nothing = await update(CHROME, { origin: ORIGIN, chainId: CHAIN, asset: USDC });
    expect(nothing).toMatchObject({ success: false, error: 'Nothing to change' });
    expect(askedSince(from)).toEqual([]);
  });

  test("a narrowing the core refuses (its file says otherwise) is the core's refusal, with nothing written", async () => {
    await grantCap('20000');
    // The core's cap is already lower than the mirror says.
    const record = mockCore.cap(ORIGIN, CHAIN, USDC);
    await mockCore.x402.update({ key: ORIGIN, cap: { chain_id: CHAIN, asset: USDC }, cap_amount: '5000' }, 'chrome');
    expect(caps.getPermission(ORIGIN, CHAIN, USDC).capAmount).toBe(record.capAmount);

    const result = await update(CHROME, { origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount: '15000' });
    expect(result).toMatchObject({ success: false, code: 'forbidden' });
    expect(mockCore.cap(ORIGIN, CHAIN, USDC).capAmount).toBe('5000');
  });

  test("main's own x402-cap-update token changes nothing: a narrowing needs none, and a widening isn't possible", async () => {
    const cap = await grantCap(PRICE);
    // As main minted one before X402-2: bound to this window, this cap and
    // this (wider) edit.
    const edit = { origin: ORIGIN, chainId: CHAIN, asset: USDC, capAmount: '99000000' };
    const { token: confirmation } = confirmations.issueMainConfirmation(confirmations.KINDS.X402_CAP_UPDATE, null, {
      window: CHROME.id,
      ...edit,
      current: { capAmount: cap.capAmount, createdAt: cap.createdAt, expiresAt: cap.expiresAt, generation: 1 },
    });
    const from = mockCore.calls.length;

    await expect(update(CHROME, { ...edit, confirmation })).resolves.toMatchObject({ success: false, code: 'forbidden' });

    expect(askedSince(from)).toEqual([]);
    expect(mockCore.cap(ORIGIN, CHAIN, USDC)).toEqual(cap);
  });
});

// caps.js over the core: what main's sign flow and injector rely on.
describe('the core charges and gives back (caps.js)', () => {
  const pay = (id) =>
    caps.authorize({ account: 0, detection: { tab: 42, id, url: `${ORIGIN}/seg/${id}` }, requirements: REQUIREMENTS, authorization: AUTO_PAY });

  test('a charge goes back once, and only to the cap it was taken from', async () => {
    await grantCap('20000');
    const { reservation, charged } = await pay('a');
    expect(charged).toBe(true);
    expect(spent()).toBe(PRICE);
    // The mirror has read the charge back.
    await settle();
    expect(caps.getPermission(ORIGIN, CHAIN, USDC).spentAmount).toBe(PRICE);

    await expect(caps.settle(reservation, 'withheld', ORIGIN)).resolves.toBe(true);
    expect(spent()).toBe('0');
    // Settled already: the core holds it no more (`invalid_argument`), and
    // nothing goes back again; caps.settle never rejects.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(caps.settle(reservation, 'withheld', ORIGIN)).resolves.toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not settle a payment (withheld)'));
    } finally {
      warn.mockRestore();
    }
    expect(spent()).toBe('0');

    // Revoked, the cap it was taken from is gone: nothing to give it back to.
    const second = await pay('b');
    await caps.revoke(ORIGIN, CHAIN, USDC);
    await expect(caps.settle(second.reservation, 'withheld', ORIGIN)).resolves.toBe(false);
  });

  test('no charge beyond the cap', async () => {
    await grantCap(PRICE);
    await expect(pay('a')).resolves.toMatchObject({ charged: true });
    await expect(pay('b')).rejects.toMatchObject({ code: 'not_authorized', data: { reason: 'cap' } });
    expect(spent()).toBe(PRICE);
    expect(signatures()).toBe(1);
  });
});
