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

// Account 0 is the vault's; 100 a Ledger's, 101 a phone's, 102 a Safe's,
// and 103 a device account since deleted (the device index range).
const { Wallet: MockWallet } = require('ethers');
const mockDeviceKey = new MockWallet('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const mockOtherKey = new MockWallet('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 0,
  getWalletRecord: (index) =>
    ({
      100: { index, type: 'ledger', address: mockDeviceKey.address },
      101: { index, type: 'remote', address: mockDeviceKey.address },
      102: { index, type: 'safe', address: '0x' + '5a'.repeat(20) },
    })[index] ?? null,
  isHardwareWalletIndex: (index) => index >= 100,
  WALLET_TYPES: { MNEMONIC: 'mnemonic', LEDGER: 'ledger', REMOTE: 'remote', SAFE: 'safe' },
}));
// A device's signature (wallet/signers.js: the Ledger's EIP-712 signature,
// or the phone's through its core job), faked by a key over the hash the
// core gave; the signer factory itself runs in x402.integration.test.js.
const mockDevice = { asked: [], sign: null };
jest.mock('../wallet/signers', () => ({
  getSigner: (index) => ({
    signTypedData: async (typedData, options) => {
      mockDevice.asked.push({ index, typedData, options });
      return mockDevice.sign(typedData, options);
    },
  }),
}));
jest.mock('../vault-timer', () => ({ resetVaultAutoLockTimer: jest.fn() }));

// Real intercept module: setPendingPayment stashes into the real Map,
// which the test reads back through the injector.
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));
// Whether payment-history says too many records wait to land.
let mockHistoryBacklogFull = false;
jest.mock('../payment-history', () => ({
  appendOnce: jest.fn(),
  historyBacklogFull: () => mockHistoryBacklogFull,
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
  mockDevice.asked.length = 0;
  mockDevice.sign = (_typedData, { expectedHash }) => mockDeviceKey.signingKey.sign(expectedHash).serialized;
  await loadCaps();
});

afterAll(() => grants._useBackendForTests(null));

// Inspect the pending-payment slot the way the injector does, to
// verify what would actually ride on the next request to a given URL.
async function consumePending(webContentsId, url) {
  return intercept.injectPaymentSignatureHandler({ webContentsId, url, requestHeaders: {} });
}

// A settle is fire-and-forget: its reply lands a few turns later.
const flushSettles = () => new Promise((resolve) => setImmediate(resolve));

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
    const header = decodedHeader(await consumePending(7, URL_));
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
    const injected = await consumePending(7, URL_);
    expect(decodedHeader(injected).accepted).toEqual(gnosisAccept);
    // The header went out: its charge is kept.
    expect(settles()).toEqual([{ reservation: expect.stringMatching(/^[0-9a-f]{32}$/), outcome: 'sent' }]);
  });

  test('an auto-pay no cap covers is refused by the core: nothing signed, stashed or charged', async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '9999' });
    await loadCaps();

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap' }).catch((e) => e);

    expect(err.code).toBe(CAP_NOT_COVERED);
    expect(await consumePending(7, URL_)).toBeNull();
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
    expect(await consumePending(7, URL_)).toBeNull();
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
    expect((await consumePending(7, URL_))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
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
    expect((await consumePending(7, 'bzz://Paywall.eth/segment'))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });
});

// #1044: an allowance pays only for a live tab the user controls, read
// before the core is asked and again once it has signed.
// The payment history is the identity core's (design 0013, PRF-6(c)), and
// an x402 record waits in main until it lands: while 100 wait, nothing more
// is signed, so no money leaves without a place in the history.
describe('signAndQueueRetry — the payment history full', () => {
  afterEach(() => {
    mockHistoryBacklogFull = false;
  });

  test.each([
    ['an approval', true],
    ["a cap's auto-pay", false],
  ])("%s isn't signed while 100 records wait: nothing charged, signed or stashed", async (_name, manual) => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
    const detection = detectionFor(URL_, [baseAccept]);
    const optsFor = async () =>
      manual ? { detection, confirmation: await approved(detection) } : { detection, authorizedBy: 'cap' };
    const spentBefore = mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount;
    mockHistoryBacklogFull = true;
    const err = await signAndQueueRetry(7, await optsFor()).catch((e) => e);
    expect(err).toMatchObject({
      code: 'X402_PAYMENT_HISTORY_FULL',
      message: 'Payment history is unavailable; try again shortly',
    });
    await flushSettles();
    expect(corePayments()).toEqual([]);
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe(spentBefore);
    expect(settles()).toEqual([]);
    expect(mockDevice.asked).toEqual([]);
    expect(await consumePending(7, URL_)).toBeNull();
    // Once the records have landed, the next payment is signed.
    mockHistoryBacklogFull = false;
    await signAndQueueRetry(7, await optsFor());
    expect(corePayments()).toHaveLength(1);
    expect(decodedHeader(await consumePending(7, URL_)).accepted).toEqual(baseAccept);
  });
});

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
    expect(await consumePending(7, URL_)).toBeNull();
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
    expect(await consumePending(7, URL_)).toBeNull();
  });
});

// cored 0.19.0's device path (X402-2b): a Ledger's or a phone's payment is
// authorized by the core with no key (`x402.authorize { device }`), signed
// on the device over the core's typed data, and checked by the core
// (`x402.settle { reservation, signature }`).
describe('signAndQueueRetry — device accounts', () => {
  const deviceSettles = () => settles().filter((params) => params.signature !== undefined);

  test("a Ledger's approval: the core spends the token with no key, the Ledger signs the core's typed data, and the core's payment is stashed", async () => {
    const detection = detectionFor();
    const confirmation = await approved(detection, { account: 100 });

    await signAndQueueRetry(7, { detection, confirmation, walletIndex: 100 });

    const [{ params }] = corePayments();
    expect(params).toMatchObject({
      account: 100,
      device: { kind: 'ledger', address: mockDeviceKey.address },
      authorization: { token: confirmation.token },
      accept_index: 0,
    });
    // The device was asked once, for the typed data the core gave, to sign
    // over the core's hash.
    expect(mockDevice.asked).toHaveLength(1);
    expect(mockDevice.asked[0].index).toBe(100);
    expect(mockDevice.asked[0].typedData.message).toMatchObject({ from: mockDeviceKey.address, value: baseAccept.amount });
    expect(mockDevice.asked[0].options.expectedHash).toMatch(/^0x[0-9a-f]{64}$/);
    const [settled] = deviceSettles();
    expect(settled).toEqual({ reservation: expect.stringMatching(/^[0-9a-f]{32}$/), signature: expect.any(String) });
    // The header is the core's payment, with the device's signature in it.
    const header = decodedHeader(await consumePending(7, URL_));
    expect(header.payload.signature).toBe(settled.signature);
    expect(header.payload.authorization.from).toBe(mockDeviceKey.address);
    expect(settles().at(-1)).toEqual({ reservation: settled.reservation, outcome: 'sent' });
  });

  test("a phone's auto-pay: the cap is charged before the phone signs, and a locked vault doesn't stop it", async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
    mockCore.setX402Locked(true);
    let spentWhenAsked = null;
    mockDevice.sign = (_typedData, { expectedHash }) => {
      spentWhenAsked = mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount;
      return mockDeviceKey.signingKey.sign(expectedHash).serialized;
    };

    await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap', walletIndex: 101 });

    expect(corePayments()[0].params).toMatchObject({
      account: 101,
      device: { kind: 'phone', address: mockDeviceKey.address },
      authorization: { cap: { agent: false, attributable: true } },
    });
    expect(spentWhenAsked).toBe('10000');
    expect(mockHostSend).toHaveBeenCalledWith('x402:cap-consumed', { origin: ORIGIN });
    expect(decodedHeader(await consumePending(7, URL_)).payload.authorization.from).toBe(mockDeviceKey.address);
  });

  test("a device that refuses: nothing is stashed, the device's error is the caller's, and the charge goes back (withheld)", async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
    const refusal = Object.assign(new Error('Rejected on the device'), { code: 'LEDGER_REJECTED' });
    mockDevice.sign = () => {
      throw refusal;
    };

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap', walletIndex: 100 }).catch((e) => e);

    expect(err).toBe(refusal);
    await flushSettles();
    expect(deviceSettles()).toEqual([]);
    expect(settles()).toEqual([{ reservation: expect.any(String), outcome: 'withheld' }]);
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
    expect(await consumePending(7, URL_)).toBeNull();
  });

  test('a signature from another key: the core refuses it and gives the charge back there; main settles nothing more', async () => {
    mockCore.seedCap({ origin: ORIGIN, chainId: 8453, asset: BASE_USDC, capAmount: '50000' });
    await loadCaps();
    mockDevice.sign = (_typedData, { expectedHash }) => mockOtherKey.signingKey.sign(expectedHash).serialized;

    const err = await signAndQueueRetry(7, { detection: detectionFor(URL_, [baseAccept]), authorizedBy: 'cap', walletIndex: 100 }).catch((e) => e);

    expect(err.message).toMatch(/another account/);
    expect(err.cause.data).toEqual({ reason: 'wrong_account', refunded: true });
    await flushSettles();
    expect(settles()).toEqual([{ reservation: expect.any(String), signature: expect.any(String) }]);
    expect(mockCore.cap(ORIGIN, 8453, BASE_USDC).spentAmount).toBe('0');
    expect(mockCore.openReservations()).toBe(0);
    expect(await consumePending(7, URL_)).toBeNull();
  });

  test("a malformed signature: refused (bad_response); a token's payment had charged nothing", async () => {
    const detection = detectionFor();
    const confirmation = await approved(detection, { account: 100 });
    mockDevice.sign = () => '0x1234';

    const err = await signAndQueueRetry(7, { detection, confirmation, walletIndex: 100 }).catch((e) => e);

    expect(err.message).toMatch(/couldn't be read/);
    expect(err.cause.data).toEqual({ reason: 'bad_response', refunded: false });
    expect(mockHostSend).not.toHaveBeenCalledWith('x402:cap-consumed', expect.anything());
  });

  test.each([
    [102, /A Safe account can't pay/],
    [103, /no longer exists/],
  ])('account %i is refused unasked, and its token burnt', async (walletIndex, message) => {
    const detection = detectionFor();
    const confirmation = await approved(detection, { account: walletIndex });

    await expect(signAndQueueRetry(7, { detection, confirmation, walletIndex })).rejects.toThrow(message);

    expect(corePayments()).toEqual([]);
    expect(mockDevice.asked).toEqual([]);
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
    expect(await consumePending(7, URL_)).toBeNull();
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

    expect((await consumePending(7, URL_))?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
    expect(mockLoadURL).toHaveBeenCalledWith(URL_);
  });
});
