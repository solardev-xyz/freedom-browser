jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// A tab's webContents, the same object for each look-up of its id, so the
// custody module's marks stick to it.
const mockLoadURL = jest.fn().mockResolvedValue();
const mockHostSend = jest.fn();
const mockTabs = new Map();
jest.mock('electron', () => ({
  webContents: {
    fromId: jest.fn((id) => {
      if (!mockTabs.has(id)) mockTabs.set(id, { id, loadURL: mockLoadURL, hostWebContents: { send: mockHostSend } });
      return mockTabs.get(id);
    }),
  },
}));

// The identity core (cored 0.18.0: X402-1's `x402.authorize` and
// `x402.settle`, its `x402-payment` tokens and its x402 store), simulated
// (test/helpers/simulated-approvals.js); the real core's in
// x402.integration.test.js.
const mockCore = require('../../../test/helpers/simulated-approvals').simulatedApprovals();
jest.mock('../core/vault-backend', () => ({ vaultBackend: { approval: mockCore.approval, x402: mockCore.x402 } }));

// Account 0 is the vault's; 100 is a Ledger's index range.
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 0,
  getWalletRecord: (index) => (index === 100 ? { index, type: 'ledger' } : null),
  isHardwareWalletIndex: (index) => index >= 100,
  WALLET_TYPES: { MNEMONIC: 'mnemonic' },
}));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: jest.fn() }));

// Real intercept module: setPendingPayment stashes into the real Map,
// which the test reads back through the injector.
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));
jest.mock('../payment-history', () => ({
  append: jest.fn(),
  KINDS: { X402: 'x402' },
  STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
}));

const intercept = require('./intercept');
const grants = require('../core/grants');
const { setAgentPageCustody } = require('../wallet/agent-tab-custody');
const { KINDS, NOT_CONFIRMED, issueConfirmation, confirmationFor, _reset } = require('../wallet/signing-confirmation');
const { isVaultLockedError } = require('../wallet/vault-errors');
const { signAndQueueRetry, CAP_NOT_COVERED } = require('./sign-flow');

// Lowercase canonical — matches what `tupleFromAccept` emits.
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';
const ORIGIN = 'https://api.example';
const URL_ = `${ORIGIN}/article`;

const baseAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '10000',
  asset: BASE_USDC, payTo: '0xBaseBaseBaseBaseBaseBaseBaseBaseBaseBase',
};
const gnosisAccept = {
  scheme: 'exact', network: 'eip155:100', amount: '20000',
  asset: GNOSIS_USDCE, payTo: '0xGnosisGnosisGnosisGnosisGnosisGnosisGnos',
};

function requirementsWith(...accepts) {
  return { x402Version: 2, resource: { url: URL_ }, accepts };
}

function detectionFor(url = URL_, accepts = [baseAccept, gnosisAccept], extra = {}) {
  return { url, requirements: requirementsWith(...accepts), detectionId: 'req-7001', resourceType: 'xhr', ...extra };
}

// The confirmation the card's Pay mints (`wallet:confirm-signing`) and
// x402:approve holds, for this detection, entry, account and grant.
async function approved(detection, { tab = 7, acceptIndex = 0, account = 0, grant = null } = {}) {
  const payment = {
    webContentsId: tab,
    detectionId: detection.detectionId,
    url: detection.url,
    acceptIndex,
    accept: detection.requirements.accepts[acceptIndex],
    grant,
  };
  const { token } = await issueConfirmation(KINDS.X402_PAYMENT, account, payment);
  return confirmationFor(token, KINDS.X402_PAYMENT, account, payment);
}

function corePayments() {
  return mockCore.calls.filter(({ method }) => method === 'x402.authorize');
}

function settles() {
  return mockCore.calls.filter(({ method }) => method === 'x402.settle').map(({ params }) => params);
}

// The mirror main reads caps from, loaded from the simulated core.
const loadCaps = () => grants._useBackendForTests(mockCore.approval);

beforeEach(async () => {
  intercept.clearAllPendingPayments();
  intercept.clearAllDetectedPayments();
  intercept.clearAllAwaitingResponse();
  mockCore.reset();
  _reset();
  mockTabs.clear();
  mockLoadURL.mockClear();
  mockHostSend.mockClear();
  await loadCaps();
});

afterAll(() => grants._useBackendForTests(null));

// Inspect the pending-payment slot the way the injector does, to
// verify what would actually ride on the next request to a given URL.
function consumePending(webContentsId, url) {
  return intercept.injectPaymentSignatureHandler({ webContentsId, url, requestHeaders: {} });
}

function decodedHeader(result) {
  const value = result?.requestHeaders['PAYMENT-SIGNATURE'];
  return value ? JSON.parse(Buffer.from(value, 'base64').toString()) : null;
}

describe('signAndQueueRetry — the core picks and signs the entry', () => {
  test("an approval presents its token and the entry it binds; the core signs that entry, from the token's account", async () => {
    const detection = detectionFor();
    const confirmation = await approved(detection, { acceptIndex: 1 });

    await signAndQueueRetry(7, { detection, confirmation });

    expect(corePayments().map(({ params, page }) => ({ params, page }))).toEqual([
      {
        params: {
          account: 0,
          detection: { tab: 7, id: 'req-7001', url: URL_ },
          requirements: detection.requirements,
          authorization: { token: confirmation.token },
          accept_index: 1,
        },
        page: null,
      },
    ]);
    const header = decodedHeader(consumePending(7, URL_));
    expect(header.accepted).toEqual(gnosisAccept);
    expect(header.payload.authorization.from).toBe('0x' + '1'.padStart(40, '0'));
    // Nothing charged: no cap covers it.
    expect(settles()).toEqual([]);
  });

  test("a cap's auto-pay asks the core for the first entry a cap covers, in the seller's order, and stashes the one it signed", async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 100, asset: GNOSIS_USDCE, capAmount: '50000' });
    await loadCaps();

    await signAndQueueRetry(7, { detection: detectionFor(), authorizedBy: 'cap' });

    const [{ params }] = corePayments();
    expect(params.authorization).toEqual({ cap: { agent: false, attributable: true } });
    expect(params).not.toHaveProperty('accept_index');
    expect(params).not.toHaveProperty('grant');
    expect(mockCore.cap(ORIGIN, 100, GNOSIS_USDCE).spentAmount).toBe('20000');
    expect(mockHostSend).toHaveBeenCalledWith('x402:cap-consumed', { origin: ORIGIN });
    const injected = consumePending(7, URL_);
    expect(decodedHeader(injected).accepted).toEqual(gnosisAccept);
    // The header went out: its charge is kept.
    expect(settles()).toEqual([{ reservation: expect.stringMatching(/^[0-9a-f]{32}$/), outcome: 'sent' }]);
  });

  test('an auto-pay no cap covers is refused by the core: nothing signed, stashed or charged', async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '9999' });
    await loadCaps();

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap' }).catch((e) => e);

    expect(err.code).toBe(CAP_NOT_COVERED);
    expect(consumePending(7, URL_)).toBeNull();
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
    expect(mockLoadURL).not.toHaveBeenCalled();
  });

  test("a cap's payment handed the card's token burns it: the core is never shown it", async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
    const detection = detectionFor(URL_, [baseAccept]);
    const confirmation = await approved(detection);

    await signAndQueueRetry(7, { detection, authorizedBy: 'cap', confirmation });

    expect(corePayments()[0].params.authorization).toEqual({ cap: { agent: false, attributable: true } });
    expect(mockCore.calls.filter(({ method }) => method === 'approval.discard').map(({ params }) => params))
      .toEqual([{ token: confirmation.token }]);
    expect(mockCore.outstanding()).toBe(0);
  });

  test('a manual payment without a token is not sent to the core', async () => {
    await expect(signAndQueueRetry(7, { detection: detectionFor() })).rejects.toThrow(/no confirmation token/);
    expect(corePayments()).toEqual([]);
  });

  test("another tab's token is refused by the core and burnt", async () => {
    const detection = detectionFor();
    const confirmation = await approved(detection, { tab: 8 });

    const err = await signAndQueueRetry(7, { detection, confirmation }).catch((e) => e);

    expect(err.code).toBe(NOT_CONFIRMED);
    expect(err.reason).toBe('mismatch');
    expect(consumePending(7, URL_)).toBeNull();
    const again = await signAndQueueRetry(8, { detection, confirmation }).catch((e) => e);
    expect(again.reason).toBe('unknown_token');
  });

  test('a grant the token binds rides to the core, which writes the cap and charges the payment to it', async () => {
    const detection = detectionFor(URL_, [baseAccept]);
    const grant = { capAmount: '100000', windowSeconds: 86400 };
    const confirmation = await approved(detection, { grant });

    await signAndQueueRetry(7, { detection, confirmation });

    expect(corePayments()[0].params.grant).toEqual({ cap_amount: '100000', window_seconds: 86400 });
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC)).toMatchObject({ capAmount: '100000', spentAmount: '10000' });
    expect(mockHostSend).toHaveBeenCalledWith('x402:cap-consumed', { origin: ORIGIN });
    expect(consumePending(7, URL_)?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });

  test('normalizes dweb ENS origins before cap accounting and banner refresh', async () => {
    mockCore.seedCap({ origin: 'paywall.eth', chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();

    await signAndQueueRetry(7, {
      detection: detectionFor('bzz://Paywall.eth/segment', [baseAccept]),
      authorizedBy: 'cap',
    });

    expect(corePayments()[0].params.detection.url).toBe('bzz://Paywall.eth/segment');
    expect(mockCore.cap('paywall.eth', 8453, BASE_USDC).spentAmount).toBe('10000');
    expect(mockHostSend).toHaveBeenCalledWith('x402:cap-consumed', { origin: 'paywall.eth' });
    expect(consumePending(7, 'bzz://Paywall.eth/segment')?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });
});

// #1044: an allowance pays only for a live tab the user controls, read
// before the core is asked and again once it has signed.
describe('signAndQueueRetry — custody', () => {
  beforeEach(async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
  });

  test('a tab in Agent custody is not paid from a cap, and the core is not asked', async () => {
    setAgentPageCustody(require('electron').webContents.fromId(7), true);

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap' }).catch((e) => e);

    expect(err.code).toBe(CAP_NOT_COVERED);
    expect(corePayments()).toEqual([]);
  });

  test('a tab that goes into Agent custody while the core signs: the signature is dropped and its charge given back', async () => {
    mockCore.setX402Signer((params, accept) => {
      setAgentPageCustody(require('electron').webContents.fromId(params.detection.tab), true);
      return { x402Version: 2, payload: { authorization: { validBefore: String(Math.floor(Date.now() / 1000) + 60) } }, accepted: accept };
    });

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap' }).catch((e) => e);

    expect(err.code).toBe(CAP_NOT_COVERED);
    expect(consumePending(7, URL_)).toBeNull();
    await new Promise(setImmediate);
    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'withheld' }]);
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
  });

  test("the core's own custody refusal goes to the card", async () => {
    const realAuthorize = mockCore.x402.authorize;
    mockCore.x402.authorize = (params) => realAuthorize({ ...params, authorization: { cap: { agent: true, attributable: true } } });
    try {
      const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap' }).catch((e) => e);
      expect(err.code).toBe(CAP_NOT_COVERED);
    } finally {
      mockCore.x402.authorize = realAuthorize;
    }
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
  });

  test('a locked vault signs nothing and charges nothing', async () => {
    mockCore.setX402Locked(true);

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap' }).catch((e) => e);

    expect(isVaultLockedError(err)).toBe(true);
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
    expect(consumePending(7, URL_)).toBeNull();
  });
});

// cored 0.18.0 signs x402 payments only with the vault's own accounts: a
// device account is refused before the core is asked (core #392 pending).
describe('signAndQueueRetry — device accounts', () => {
  test("a device account's auto-pay goes to the card, unasked", async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap', walletIndex: 100 }).catch((e) => e);

    expect(err.code).toBe(CAP_NOT_COVERED);
    expect(err.message).toMatch(/Ledger or phone/);
    expect(corePayments()).toEqual([]);
  });

  test("a device account's approval is refused unasked, and its token burnt", async () => {
    const detection = detectionFor();
    const confirmation = await approved(detection, { account: 100 });

    await expect(signAndQueueRetry(7, { detection, confirmation, walletIndex: 100 })).rejects.toThrow(/Ledger or phone/);

    expect(corePayments()).toEqual([]);
    expect(mockCore.calls.filter(({ method }) => method === 'approval.discard').map(({ params }) => params))
      .toEqual([{ token: confirmation.token }]);
  });
});

// The SDK stamps validBefore before it asks the signer to sign, so a slow
// on-device confirmation can outlive the authorization. Anything the
// facilitator would refuse (`validBefore < now + 6`) must not be dispatched.
describe('signAndQueueRetry — authorization freshness', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function signsValidUntil(validBefore) {
    mockCore.setX402Signer((params, accept) => ({
      x402Version: 2,
      payload: { authorization: { validBefore: String(validBefore) }, signature: '0xsig' },
      accepted: accept,
    }));
  }

  function detection() {
    return detectionFor(URL_, [baseAccept], { resourceType: 'mainFrame' });
  }

  test('rejects — and stashes nothing — when the device confirmation outlived validBefore', async () => {
    signsValidUntil(nowSeconds() - 5);
    const d = detection();

    await expect(signAndQueueRetry(7, { detection: d, confirmation: await approved(d) }))
      .rejects.toThrow(/expired while it was being confirmed/i);

    // No signature armed for the injector, no re-navigation: the doomed
    // retry that would trip the loop guard never goes out.
    expect(consumePending(7, URL_)).toBeNull();
    expect(mockLoadURL).not.toHaveBeenCalled();
  });

  test('rejects inside the facilitator skew window even though validBefore is future', async () => {
    signsValidUntil(nowSeconds() + 2);
    const d = detection();

    await expect(signAndQueueRetry(7, { detection: d, confirmation: await approved(d) }))
      .rejects.toThrow(/expired while it was being confirmed/i);
  });

  test("a cap's payment refused for its runway gives its charge back", async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
    signsValidUntil(nowSeconds() + 2);

    await expect(signAndQueueRetry(7, { detection: detection(), authorizedBy: 'cap' }))
      .rejects.toThrow(/expired while it was being confirmed/i);

    await new Promise(setImmediate);
    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'withheld' }]);
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
  });

  test('keeps the detection so the user can retry from the same card', async () => {
    // Seed through the real detector — there is no public setter for the
    // detected-payments map, and this is the entry point production uses.
    const requirements = {
      x402Version: 2,
      resource: { url: URL_ },
      accepts: [{
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: BASE_USDC,
        payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
        maxTimeoutSeconds: 60,
        extra: { name: 'USD Coin', version: '2' },
      }],
    };
    intercept.detectPaymentRequiredHandler({
      webContentsId: 7,
      url: URL_,
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(requirements)).toString('base64')],
      },
    });
    const detected = intercept.getDetectedPayment(7);
    expect(detected).toBeTruthy();

    signsValidUntil(nowSeconds() - 1);

    await expect(signAndQueueRetry(7, { confirmation: await approved(detected) }))
      .rejects.toThrow(/expired while it was being confirmed/i);

    expect(intercept.getDetectedPayment(7)).toBeTruthy();
  });

  test('dispatches normally when the authorization still has runway', async () => {
    signsValidUntil(nowSeconds() + 60);
    const d = detection();

    await signAndQueueRetry(7, { detection: d, confirmation: await approved(d) });

    expect(consumePending(7, URL_)?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    expect(mockLoadURL).toHaveBeenCalledWith(URL_);
  });
});
