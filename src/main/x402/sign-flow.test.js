jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockLoadURL = jest.fn().mockResolvedValue();
jest.mock('electron', () => ({
  webContents: {
    fromId: jest.fn(() => ({ loadURL: mockLoadURL })),
  },
}));

const mockClient = {
  address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  createPaymentPayload: jest.fn(),
};
const mockCreateClient = jest.fn(async () => mockClient);
jest.mock('./client', () => ({
  createX402Client: (idx) => mockCreateClient(idx),
}));

jest.mock('../identity-manager', () => ({
  getActiveWalletIndex: () => 0,
}));

// Real intercept module: setPendingPayment stashes into the real Map,
// which the test reads back via getPendingPayment-equivalent lookup.
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: jest.fn(),
}));
jest.mock('../payment-history', () => ({
  append: jest.fn(),
  KINDS: { X402: 'x402' },
  STATUSES: { SETTLED: 'settled', NO_RECEIPT: 'no-receipt', FAILED: 'failed' },
}));
jest.mock('./permissions', () => ({
  grant: jest.fn(),
  getPermission: jest.fn(() => null),
  tryConsume: jest.fn(() => true),
}));

const intercept = require('./intercept');
const permissions = require('./permissions');
const { signAndQueueRetry } = require('./sign-flow');

// Lowercase canonical — matches what `tupleFromAccept` emits.
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const GNOSIS_USDCE = '0x2a22f9c3b484c3629090feed35f17ff8f88f76f0';

const baseAccept = {
  scheme: 'exact', network: 'eip155:8453', amount: '10000',
  asset: BASE_USDC, payTo: '0xBaseBaseBaseBaseBaseBaseBaseBaseBaseBase',
};
const gnosisAccept = {
  scheme: 'exact', network: 'eip155:100', amount: '20000',
  asset: GNOSIS_USDCE, payTo: '0xGnosisGnosisGnosisGnosisGnosisGnosisGnos',
};

function requirementsWith(...accepts) {
  return { x402Version: 2, resource: { url: 'https://api.example/article' }, accepts };
}

beforeEach(() => {
  intercept.clearAllPendingPayments();
  intercept.clearAllDetectedPayments();
  intercept.clearAllAwaitingResponse();
  mockClient.createPaymentPayload.mockReset().mockResolvedValue({
    x402Version: 2,
    payload: { authorization: {}, signature: '0xsig' },
  });
  mockCreateClient.mockClear();
  mockLoadURL.mockClear();
  permissions.grant.mockClear();
  permissions.tryConsume.mockClear().mockReturnValue(true);
});

// Inspect the pending-payment slot the way the injector does, to
// verify what would actually ride on the next request to a given URL.
function consumePending(webContentsId, url) {
  const result = intercept.injectPaymentSignatureHandler({
    webContentsId, url, requestHeaders: {},
  });
  return result;
}

describe('signAndQueueRetry — selectedAccept resolution', () => {
  test('opts.selectedAccept WINS over detection.selectedAccept and accepts[0]', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: requirementsWith(baseAccept, gnosisAccept),
        resourceType: 'xhr',
        selectedAccept: gnosisAccept,  // would otherwise win
      },
      selectedAccept: baseAccept,
    });

    // The SDK was called with a single-entry accepts[] — the explicit opts.
    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(expect.objectContaining({
      accepts: [baseAccept],
    }));
    // And the receipt context records the explicit opts' chainId + asset.
    const injected = consumePending(7, 'https://api.example/article');
    expect(injected?.requestHeaders['PAYMENT-SIGNATURE']).toBeDefined();
  });

  test('detection.selectedAccept WINS over accepts[0] when opts.selectedAccept is omitted', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: requirementsWith(baseAccept, gnosisAccept),
        resourceType: 'xhr',
        selectedAccept: gnosisAccept,
      },
    });

    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(expect.objectContaining({
      accepts: [gnosisAccept],
    }));
  });

  test('falls back to accepts[0] when neither opts nor detection carry a selection', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: requirementsWith(baseAccept, gnosisAccept),
        resourceType: 'xhr',
      },
    });

    expect(mockClient.createPaymentPayload).toHaveBeenCalledWith(expect.objectContaining({
      accepts: [baseAccept],
    }));
  });

  test('throws "No accepts[] entry to sign" when every resolution source is empty', async () => {
    await expect(signAndQueueRetry(7, {
      detection: {
        url: 'https://api.example/article',
        requirements: { x402Version: 2, accepts: [] },
        resourceType: 'xhr',
      },
    })).rejects.toThrow(/No accepts\[\] entry to sign/);
  });

  test('normalizes dweb ENS origins before cap accounting and banner refresh', async () => {
    await signAndQueueRetry(7, {
      detection: {
        url: 'bzz://Paywall.eth/segment',
        requirements: requirementsWith(baseAccept),
        resourceType: 'xhr',
      },
      authorizedBy: 'cap',
    });

    consumePending(7, 'bzz://Paywall.eth/segment');

    expect(permissions.tryConsume).toHaveBeenCalledWith(
      'paywall.eth',
      8453,
      BASE_USDC,
      '10000'
    );
  });
});

// The SDK stamps validBefore before it asks the signer to sign, so a slow
// on-device confirmation can outlive the authorization. Anything the
// facilitator would refuse (`validBefore < now + 6`) must not be dispatched.
describe('signAndQueueRetry — authorization freshness', () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  function payloadValidUntil(validBefore) {
    return {
      x402Version: 2,
      payload: { authorization: { validBefore: String(validBefore) }, signature: '0xsig' },
    };
  }

  function detection() {
    return {
      url: 'https://api.example/article',
      requirements: requirementsWith(baseAccept),
      resourceType: 'mainFrame',
    };
  }

  test('rejects — and stashes nothing — when the device confirmation outlived validBefore', async () => {
    mockClient.createPaymentPayload.mockResolvedValue(payloadValidUntil(nowSeconds() - 5));

    await expect(signAndQueueRetry(7, { detection: detection() }))
      .rejects.toThrow(/expired while it was being confirmed/i);

    // No signature armed for the injector, no re-navigation: the doomed
    // retry that would trip the loop guard never goes out.
    expect(consumePending(7, 'https://api.example/article')).toBeNull();
    expect(mockLoadURL).not.toHaveBeenCalled();
  });

  test('rejects inside the facilitator skew window even though validBefore is future', async () => {
    mockClient.createPaymentPayload.mockResolvedValue(payloadValidUntil(nowSeconds() + 2));

    await expect(signAndQueueRetry(7, { detection: detection() }))
      .rejects.toThrow(/expired while it was being confirmed/i);
  });

  test('keeps the detection so the user can retry from the same card', async () => {
    // Seed through the real detector — there is no public setter for the
    // detected-payments map, and this is the entry point production uses.
    const requirements = {
      x402Version: 2,
      resource: { url: 'https://api.example/article' },
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
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: {
        'PAYMENT-REQUIRED': [Buffer.from(JSON.stringify(requirements)).toString('base64')],
      },
    });
    expect(intercept.getDetectedPayment(7)).toBeTruthy();

    mockClient.createPaymentPayload.mockResolvedValue(payloadValidUntil(nowSeconds() - 1));

    await expect(signAndQueueRetry(7)).rejects.toThrow(/expired while it was being confirmed/i);

    expect(intercept.getDetectedPayment(7)).toBeTruthy();
  });

  test('dispatches normally when the authorization still has runway', async () => {
    mockClient.createPaymentPayload.mockResolvedValue(payloadValidUntil(nowSeconds() + 60));

    await signAndQueueRetry(7, { detection: detection() });

    expect(consumePending(7, 'https://api.example/article')?.requestHeaders['PAYMENT-SIGNATURE'])
      .toBeDefined();
    expect(mockLoadURL).toHaveBeenCalledWith('https://api.example/article');
  });
});
