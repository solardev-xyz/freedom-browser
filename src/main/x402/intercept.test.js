jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const mockHostSend = jest.fn();
jest.mock('electron', () => ({
  webContents: {
    fromId: jest.fn(() => ({ hostWebContents: { send: mockHostSend } })),
  },
}));

const mockRegister = jest.fn();
jest.mock('../webrequest-dispatcher', () => ({
  registerWebRequestHandler: (...args) => mockRegister(...args),
}));

const mockAppendReceipt = jest.fn();
jest.mock('../payment-history', () => ({
  append: (...args) => mockAppendReceipt(...args),
  KINDS: { X402: 'x402', WALLET_SEND: 'wallet-send', DAPP_SEND: 'dapp-send' },
  STATUSES: {
    PENDING: 'pending', CONFIRMED: 'confirmed', FAILED: 'failed',
    SETTLED: 'settled', NO_RECEIPT: 'no-receipt',
  },
}));

// Auto-pay branch dispatches signAndQueueRetry via a lazy require —
// mock it so detector tests don't drag the whole sign flow in.
const mockSignAndQueueRetry = jest.fn();
jest.mock('./sign-flow', () => ({
  signAndQueueRetry: (...args) => mockSignAndQueueRetry(...args),
}));


const mockGetPermission = jest.fn(() => null);
const mockTryConsume = jest.fn(() => true);
jest.mock('./permissions', () => ({
  getPermission: (...args) => mockGetPermission(...args),
  tryConsume: (...args) => mockTryConsume(...args),
}));

const { webContents } = require('electron');
const { VAULT_LOCKED_MESSAGE } = require('../wallet/vault-errors');
const {
  X402_HEADERS,
  installX402Interception,
  captureRequestContextHandler,
  clearRequestContextHandler,
  detectPaymentRequiredHandler,
  injectPaymentSignatureHandler,
  paymentResponseLoggingHandler,
  parsePaymentRequiredHeader,
  setPendingPayment,
  getDetectedPayment,
  clearDetectedPayment,
  clearAllPendingPayments,
  clearAllDetectedPayments,
  clearAllAwaitingResponse,
  clearAllRequestContext,
  consumePendingUnlockResume,
  clearAllPendingUnlockResume,
  hasPendingUnlockWait,
  settlePendingUnlockWait,
  clearAllPendingUnlockWaits,
  hasPendingApproval,
  settlePendingApproval,
  abortPendingApproval,
  clearAllPendingApprovals,
  clearAllHostSenders,
  cleanupWebContents,
} = require('./intercept');

// Yield enough microtasks for the detector's retry loop to settle a
// decision, run the sign attempt + catch, fire the result event, and
// re-arm pendingApproval. 5 is the observed minimum across the chain
// (decision-resolve → sign-throw → catch → sendToHost → loop iter →
// new setPendingApproval) — bump if the loop body gains more awaits.
const flushRetryMicrotasks = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  clearAllPendingPayments();
  clearAllDetectedPayments();
  clearAllAwaitingResponse();
  clearAllRequestContext();
  clearAllPendingUnlockResume();
  clearAllPendingUnlockWaits();
  clearAllPendingApprovals();
  clearAllHostSenders();
  webContents.fromId.mockReset().mockImplementation(() => ({
    hostWebContents: { send: mockHostSend },
  }));
  mockRegister.mockClear();
  mockAppendReceipt.mockReset();
  mockHostSend.mockClear();
  mockSignAndQueueRetry.mockReset().mockResolvedValue(undefined);
  mockGetPermission.mockReset().mockReturnValue(null);
  mockTryConsume.mockReset().mockReturnValue(true);
});

// Canonical Base USDC PaymentRequired (V2). `resource` is an object per
// @x402/core/schemas — see PaymentRequiredV2Schema in
// node_modules/@x402/core/dist/cjs/schemas/index.js. A plain-string
// resource is rejected by the schema even though the x402Client
// happens to accept it.
const sampleRequirements = {
  x402Version: 2,
  resource: { url: 'https://api.example/article' },
  accepts: [
    {
      scheme: 'exact',
      network: 'eip155:8453',
      amount: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      // No per-accepts `resource` in V2 — that's a V1 PaymentRequirements
      // field. V2's resource lives at the top level only.
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};
const sampleRequirementsB64 = Buffer.from(JSON.stringify(sampleRequirements)).toString('base64');

// Canonical V1 PaymentRequired — distinct field set (maxAmountRequired,
// description required, string-network, string-resource).
const sampleRequirementsV1 = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'base',
      maxAmountRequired: '10000',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      payTo: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
      maxTimeoutSeconds: 60,
      resource: 'https://api.example/article',
      description: 'Premium article',
      extra: { name: 'USD Coin', version: '2' },
    },
  ],
};
const sampleRequirementsV1B64 = Buffer.from(JSON.stringify(sampleRequirementsV1)).toString('base64');

// === parsePaymentRequiredHeader ==========================================

describe('parsePaymentRequiredHeader', () => {
  test('round-trips valid base64-encoded JSON', () => {
    const result = parsePaymentRequiredHeader(sampleRequirementsB64);
    expect(result).toEqual(sampleRequirements);
  });

  test.each([
    ['empty string', ''],
    ['null', null],
    ['non-string', 42],
    ['base64 of non-JSON', Buffer.from('not json').toString('base64')],
    ['base64 of JSON without x402Version', Buffer.from('{"accepts":[]}').toString('base64')],
    ['base64 of JSON with empty accepts', Buffer.from('{"x402Version":2,"accepts":[]}').toString('base64')],
    ['base64 of JSON with plain-string resource (V2 requires object)', Buffer.from(JSON.stringify({
      x402Version: 2, resource: 'plain-string', accepts: sampleRequirements.accepts,
    })).toString('base64')],
  ])('returns null for %s', (_label, input) => {
    expect(parsePaymentRequiredHeader(input)).toBeNull();
  });
});

// === detectPaymentRequiredHandler ========================================

describe('detectPaymentRequiredHandler', () => {
  const detail = (overrides = {}) => ({
    webContentsId: 7,
    url: 'https://api.example/article',
    statusLine: 'HTTP/1.1 402 Payment Required',
    responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    ...overrides,
  });

  test('on 402 with V2 header: stashes the payment and fires the approval event at the host', async () => {
    // Handler is async (returns a Promise — see the 307 path for why).
    // Non-cap-covered branch still resolves to null; side effects are
    // synchronous before the function ever awaits anything.
    const result = await detectPaymentRequiredHandler(detail());

    expect(result).toBeNull();
    expect(getDetectedPayment(7)).toMatchObject({
      url: 'https://api.example/article',
      requirements: sampleRequirements,
    });
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-needed', expect.objectContaining({
      webContentsId: 7,
      url: 'https://api.example/article',
    }));
  });

  test('captures resourceType on the detection so sign-flow can route the retry correctly', () => {
    detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
    expect(getDetectedPayment(7)?.resourceType).toBe('xhr');

    clearDetectedPayment(7);
    detectPaymentRequiredHandler(detail({ resourceType: 'mainFrame' }));
    expect(getDetectedPayment(7)?.resourceType).toBe('mainFrame');
  });

  test('cap-covered detection is tagged authorizedBy=cap on the stored entry so the resume-after-vault-unlock path preserves consent', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    detectPaymentRequiredHandler(detail());
    expect(getDetectedPayment(7)?.authorizedBy).toBe('cap');
  });

  test('non-cap-covered detection has no authorizedBy tag (sidebar approval = manual)', () => {
    // Default mockGetPermission returns null → no coverage → approval card path.
    detectPaymentRequiredHandler(detail());
    expect(getDetectedPayment(7)?.authorizedBy).toBeUndefined();
  });

  test('subresource cap-covered 402 returns a same-URL 307 redirect (Chromium follows it transparently)', async () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    // mockSignAndQueueRetry defaults to resolve(undefined) in beforeEach
    // — the handler awaits this synchronously before returning the 307.
    const result = await detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
    expect(result).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: {
        Location: ['https://api.example/article'],
      },
    });
    expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7, expect.objectContaining({
      detection: expect.objectContaining({
        url: 'https://api.example/article',
        resourceType: 'xhr',
      }),
      authorizedBy: 'cap',
    }));
    // No approval-needed event — auto-pay is silent.
    expect(mockHostSend).not.toHaveBeenCalled();
  });

  test('loop guard fires even when the cap no longer covers (rejected retry exhausted the cap; do not fall into approval-card flow)', async () => {
    // Bad interleaving: the rejected signed attempt consumed the last
    // headroom; findCoveringPermission now returns null. Without the
    // guard sitting ABOVE the coverage check, this falls into the
    // approval-card path and prompts the user to re-authorise a charge
    // the server is refusing.
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      authorizedBy: 'cap',
    });
    injectPaymentSignatureHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    // Cap is exhausted (or revoked, or any other "no cover" state).
    mockGetPermission.mockReturnValueOnce(null);

    const result = await detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));

    // No 307, no approval-needed event — receipt handler will log failed.
    // (The earlier injectPaymentSignatureHandler fires x402:cap-consumed
    // during setup; we only care that no approval-needed event leaked.)
    expect(result).toBeNull();
    expect(mockSignAndQueueRetry).not.toHaveBeenCalled();
    expect(mockHostSend).not.toHaveBeenCalledWith('x402:approval-needed', expect.anything());
  });

  test('loop guard: 402 on a request we already signed does NOT re-sign (server rejected the signature)', async () => {
    // Set up the "we already signed and injected" state: pending +
    // awaitingResponse both populated. This is what `injectPaymentSignatureHandler`
    // leaves on the map after attaching a PAYMENT-SIGNATURE to an
    // outgoing request — then the server returns 402 (rejected) and
    // we hit the detector again with the same (id, url).
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      authorizedBy: 'cap',
    });
    injectPaymentSignatureHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
    // Cap still covers — without the guard the detector would re-sign.
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '10000',
      createdAt: 1, expiresAt: 9999999999,
    });

    const result = await detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));

    // No re-sign, no 307; the receipt handler (next in the chain) will
    // see the failed signed attempt and log a `failed` row.
    expect(result).toBeNull();
    expect(mockSignAndQueueRetry).not.toHaveBeenCalled();
  });

  test('subresource cap-covered 402 with locked vault HOLDS the response open until x402:resume-unlock, then retries sign and returns 307', async () => {
    // The detector must NOT return null here — that would lose the
    // original fetch for vanilla `fetch()`/lazy-load/video callers that
    // don't retry. Hold the response open across user unlock instead.
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockSignAndQueueRetry.mockReset()
      .mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE))
      .mockResolvedValueOnce(undefined);

    // Don't await — detector hangs on the wait entry.
    const handlerPromise = detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
    // Yield for: sign-attempt-throw, catch, sendToHost, setPendingUnlockWait.
    await flushRetryMicrotasks();

    expect(mockHostSend).toHaveBeenCalledWith('x402:unlock-needed', {
      webContentsId: 7,
      origin: 'https://api.example',
    });
    expect(hasPendingUnlockWait(7)).toBe(true);
    // No resume token on the subresource path — the closure carries the snapshot.
    expect(consumePendingUnlockResume(7)).toBeNull();

    // User unlocks; IPC settles the wait. Detector retries sign → 307.
    settlePendingUnlockWait(7);

    const result = await handlerPromise;
    expect(result).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/article'] },
    });
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(2);
  });

  test('subresource cap-covered locked-vault: tab destruction aborts the wait → handler returns null without re-signing', async () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

    const handlerPromise = detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
    await flushRetryMicrotasks();
    expect(hasPendingUnlockWait(7)).toBe(true);

    cleanupWebContents(7);

    expect(hasPendingUnlockWait(7)).toBe(false);
    const result = await handlerPromise;
    expect(result).toBeNull();
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(1);
  });

  test('subresource cap-covered locked-vault: if the second sign also fails locked, fires unlock-needed again and re-arms the wait', async () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockSignAndQueueRetry.mockReset()
      .mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE))
      .mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE))
      .mockResolvedValueOnce(undefined);

    const handlerPromise = detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
    await flushRetryMicrotasks();
    expect(hasPendingUnlockWait(7)).toBe(true);

    settlePendingUnlockWait(7);
    await flushRetryMicrotasks();

    // Second sign also threw locked → new wait registered, second unlock-needed fired.
    expect(hasPendingUnlockWait(7)).toBe(true);
    const unlockCalls = mockHostSend.mock.calls.filter((c) => c[0] === 'x402:unlock-needed');
    expect(unlockCalls).toHaveLength(2);

    settlePendingUnlockWait(7);
    const result = await handlerPromise;
    expect(result).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/article'] },
    });
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(3);
  });

  test('subresource cap-covered locked-vault: the wait entry has a TTL so a same-tab navigation cannot strand it indefinitely', async () => {
    // Without this, a tab that navigates away without firing the
    // `destroyed` event (so cleanupWebContents never runs) leaves the
    // wait entry and the held-open onHeadersReceived sitting in memory.
    jest.useFakeTimers();
    try {
      mockGetPermission.mockReturnValueOnce({
        capAmount: '20000', spentAmount: '0',
        createdAt: 1, expiresAt: 9999999999,
      });
      mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

      const handlerPromise = detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
      // flushRetryMicrotasks reaches into queueMicrotask via Promise.resolve;
      // safe under fakeTimers (only setTimeout is faked).
      await flushRetryMicrotasks();
      expect(hasPendingUnlockWait(7)).toBe(true);

      // Advance past the 5-minute TTL (matches UNLOCK_RESUME_TTL_MS).
      jest.advanceTimersByTime(6 * 60 * 1000);

      expect(hasPendingUnlockWait(7)).toBe(false);
      const result = await handlerPromise;
      expect(result).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('subresource cap-covered: non-vault-locked sign failure returns null without entering the retry loop', async () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error('signTypedData reverted'));

    const result = await detectPaymentRequiredHandler(detail({ resourceType: 'xhr' }));
    expect(result).toBeNull();
    expect(hasPendingUnlockWait(7)).toBe(false);
    expect(mockHostSend).not.toHaveBeenCalledWith('x402:unlock-needed', expect.anything());
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(1);
  });

  test('auto-pay: when an active cap covers the charge, calls signAndQueueRetry with a detection snapshot and authorizedBy=cap', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    // Use real timers so the setImmediate inside the auto-pay branch
    // actually fires.
    detectPaymentRequiredHandler(detail({ resourceType: 'mainFrame' }));
    return new Promise((resolve) => setImmediate(() => {
      expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7, {
        detection: expect.objectContaining({
          url: 'https://api.example/article',
          requirements: sampleRequirements,
          resourceType: 'mainFrame',
        }),
        authorizedBy: 'cap',  // matches AUTHORIZED_BY.CAP
      });
      expect(mockHostSend).not.toHaveBeenCalled();
      resolve();
    }));
  });

  test('auto-pay: a locked-vault failure on mainFrame asks the host renderer to unlock AND stashes a resume token with the original snapshot', () => {
    // mainFrame-specific: the setImmediate dispatch loses the detector
    // closure by the time the user unlocks, so the snapshot has to live
    // in the resume token. (Subresource keeps the snapshot in the
    // awaiting detector's closure — see the wait-loop tests above.)
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

    detectPaymentRequiredHandler(detail({ resourceType: 'mainFrame' }));
    return new Promise((resolve) => {
      // Two setImmediate ticks: one to fire signAndQueueRetry, one for
      // the catch handler's microtask + sendToHost call.
      setImmediate(() => setImmediate(() => {
        expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7, expect.objectContaining({
          detection: expect.objectContaining({ url: 'https://api.example/article' }),
        }));
        expect(mockHostSend).toHaveBeenCalledWith('x402:unlock-needed', {
          webContentsId: 7,
          origin: 'https://api.example',
        });
        // Resume token captures the original detection + CAP authorization
        // so a newer 402 replacing detectedPayments[7] while the user
        // unlocks can't redirect the resume to sign a different charge.
        const resume = consumePendingUnlockResume(7);
        expect(resume).not.toBeNull();
        expect(resume.detection).toEqual(expect.objectContaining({
          url: 'https://api.example/article',
          requirements: sampleRequirements,
        }));
        expect(resume.authorizedBy).toBe('cap');
        resolve();
      }));
    });
  });

  test('consumePendingUnlockResume returns null past the TTL', async () => {
    // mainFrame keeps the legacy resume-token path (setImmediate dispatch
    // loses the detector closure, so the snapshot is stashed for the IPC
    // to consume on unlock). The subresource path keeps its snapshot in
    // the awaiting detector's closure and doesn't stash a token at all.
    const realNow = Date.now;
    const t0 = realNow();
    Date.now = () => t0;
    try {
      mockGetPermission.mockReturnValueOnce({
        capAmount: '20000', spentAmount: '0',
        createdAt: 1, expiresAt: 9999999999,
      });
      mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
      detectPaymentRequiredHandler(detail({ resourceType: 'mainFrame' }));
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

      // Jump past the 5-minute TTL.
      Date.now = () => t0 + 6 * 60 * 1000;
      expect(consumePendingUnlockResume(7)).toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('cleanupWebContents drops a stashed mainFrame resume token for the closed tab', () => {
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '0',
      createdAt: 1, expiresAt: 9999999999,
    });
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    detectPaymentRequiredHandler(detail({ resourceType: 'mainFrame' }));
    return new Promise((resolve) => {
      setImmediate(() => setImmediate(() => {
        cleanupWebContents(7);
        expect(consumePendingUnlockResume(7)).toBeNull();
        resolve();
      }));
    });
  });

  test('accepts a V1 PaymentRequired payload from X-PAYMENT-REQUIRED', () => {
    detectPaymentRequiredHandler(detail({
      responseHeaders: { 'X-PAYMENT-REQUIRED': [sampleRequirementsV1B64] },
    }));
    expect(getDetectedPayment(7)?.requirements.x402Version).toBe(1);
  });

  test('header lookup is case-insensitive (servers vary on casing)', () => {
    detectPaymentRequiredHandler(detail({
      responseHeaders: { 'payment-required': [sampleRequirementsB64] },
    }));
    expect(getDetectedPayment(7)).not.toBeNull();
  });

  test('ignores non-402 responses even with PAYMENT-REQUIRED header', () => {
    detectPaymentRequiredHandler(detail({
      statusLine: 'HTTP/1.1 200 OK',
    }));
    expect(getDetectedPayment(7)).toBeNull();
  });

  test('ignores 402 with no payment header (body-only V1 servers fall through here)', () => {
    detectPaymentRequiredHandler(detail({ responseHeaders: {} }));
    expect(getDetectedPayment(7)).toBeNull();
  });

  test('ignores 402 with an unparseable payment header', () => {
    detectPaymentRequiredHandler(detail({
      responseHeaders: { 'PAYMENT-REQUIRED': ['!!not base64!!'] },
    }));
    expect(getDetectedPayment(7)).toBeNull();
  });

  test('ignores 402 with no webContentsId (service worker, favicon discovery, …)', () => {
    detectPaymentRequiredHandler(detail({ webContentsId: undefined }));
    detectPaymentRequiredHandler(detail({ webContentsId: -1 }));
    expect(mockHostSend).not.toHaveBeenCalled();
  });

  test('separates detections by webContentsId (different tabs)', () => {
    detectPaymentRequiredHandler(detail({ webContentsId: 7 }));
    detectPaymentRequiredHandler(detail({
      webContentsId: 8,
      url: 'https://other.example/page',
    }));

    expect(getDetectedPayment(7)?.url).toBe('https://api.example/article');
    expect(getDetectedPayment(8)?.url).toBe('https://other.example/page');
  });

  test('a fresh detection on the same tab replaces the prior one', () => {
    detectPaymentRequiredHandler(detail({ url: 'https://api.example/article-1' }));
    detectPaymentRequiredHandler(detail({ url: 'https://api.example/article-2' }));
    expect(getDetectedPayment(7)?.url).toBe('https://api.example/article-2');
  });

  test('clearDetectedPayment wipes a single tab', () => {
    detectPaymentRequiredHandler(detail());
    clearDetectedPayment(7);
    expect(getDetectedPayment(7)).toBeNull();
  });
});

// === WP7.1: approval-card subresource path (Option α) ====================

describe('approval-card subresource path (await user decision, then 307)', () => {
  const detail = (overrides = {}) => ({
    id: 1001,
    webContentsId: 7,
    url: 'https://api.example/segment/0',
    statusLine: 'HTTP/1.1 402 Payment Required',
    responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    resourceType: 'xhr',
    ...overrides,
  });

  test('mints a detectionId and includes it + resourceType in the approval-needed event payload', async () => {
    // Cap doesn't cover (default mockGetPermission returns null) → approval card path.
    // Don't await the detector — it will hang on the approval Promise.
    detectPaymentRequiredHandler(detail());
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-needed', expect.objectContaining({
      webContentsId: 7,
      url: 'https://api.example/segment/0',
      detectionId: 'req-1001',
      // resourceType in the payload is what tells the renderer to use
      // x402:reject (subresource) rather than x402:cancel (mainFrame).
      resourceType: 'xhr',
    }));
    abortPendingApproval('req-1001', new Error('test cleanup'));
  });

  test('on approve: signs with MANUAL authorization, returns 307, and fires approval-result success event', async () => {
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', { approved: true });

    const result = await handlerPromise;
    expect(result).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/segment/0'] },
    });
    expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7, expect.objectContaining({
      detection: expect.objectContaining({ url: 'https://api.example/segment/0' }),
      authorizedBy: 'manual',
    }));
    // P2: detector signals completion so the sidebar can close the card.
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-1001',
      success: true,
    });
  });

  // The sidebar's signature-flight lock is released ONLY by
  // x402:approval-result. Addressing that event through the paying tab's
  // webContents (the old sendToHost) meant closing the tab while the
  // device prompt was up dropped it — leaking the lock and bricking the
  // whole sidebar until restart. The host is bound at detection time and
  // outlives the tab, so the settle always lands.
  test('delivers approval-result after the paying tab is destroyed mid-signature', async () => {
    let settleSign;
    mockSignAndQueueRetry.mockReset().mockImplementation(
      () => new Promise((resolve) => { settleSign = resolve; })
    );

    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();
    settlePendingApproval('req-1001', { approved: true });
    await flushRetryMicrotasks();
    // Signature is on the device: nothing left to abort in main.
    expect(hasPendingApproval('req-1001')).toBe(false);

    // User closes the paying tab. The guest webContents is gone, so the
    // tab can no longer be used to find the sidebar's window.
    cleanupWebContents(7);
    webContents.fromId.mockReturnValue(undefined);
    mockHostSend.mockClear();

    settleSign();
    await handlerPromise;

    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-1001',
      success: true,
    });
  });

  test('destroying the paying tab cancels its card so a held signature lock is released', async () => {
    let settleSign;
    mockSignAndQueueRetry.mockReset().mockImplementation(
      () => new Promise((resolve) => { settleSign = resolve; })
    );

    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();
    settlePendingApproval('req-1001', { approved: true });
    await flushRetryMicrotasks();
    mockHostSend.mockClear();

    cleanupWebContents(7);

    // `cancelled` tells the card to tear down rather than offer a retry
    // against a detection nothing can settle — and that teardown is what
    // releases the sidebar, without waiting on the device.
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-1001',
      success: false,
      cancelled: true,
      error: 'The tab that requested this payment was closed.',
    });

    settleSign();
    await handlerPromise;
  });

  test('destroying the tab while the user is still deciding cancels the card too', async () => {
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();
    expect(hasPendingApproval('req-1001')).toBe(true);
    mockHostSend.mockClear();

    cleanupWebContents(7);

    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result', expect.objectContaining({
      detectionId: 'req-1001',
      cancelled: true,
    }));
    expect(hasPendingApproval('req-1001')).toBe(false);
    await expect(handlerPromise).resolves.toBeNull();
  });

  test('a tab with no x402 card in play sends nothing on destroy', () => {
    cleanupWebContents(99);
    expect(mockHostSend).not.toHaveBeenCalled();
  });

  test('manual approval preserves captured Range requestShape for the signed retry key', async () => {
    captureRequestContextHandler({
      id: 1001,
      webContentsId: 7,
      method: 'GET',
      url: 'https://api.example/segment/0',
      requestHeaders: { Range: 'bytes=0-99' },
      resourceType: 'xhr',
    });
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', { approved: true });

    await handlerPromise;
    expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7, expect.objectContaining({
      detection: expect.objectContaining({
        url: 'https://api.example/segment/0',
        requestShape: {
          method: 'GET',
          range: 'bytes=0-99',
        },
      }),
      authorizedBy: 'manual',
    }));
  });

  test('pending subresource approvals expire so held response callbacks cannot hang forever', async () => {
    jest.useFakeTimers();
    try {
      const handlerPromise = detectPaymentRequiredHandler(detail());
      await Promise.resolve();
      expect(hasPendingApproval('req-1001')).toBe(true);

      jest.advanceTimersByTime(6 * 60 * 1000);
      await flushRetryMicrotasks();

      expect(hasPendingApproval('req-1001')).toBe(false);
      expect(getDetectedPayment(7)).toBeNull();
      expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result', {
        detectionId: 'req-1001',
        success: false,
        error: 'Approval expired. Reload the resource to retry.',
      });
      await expect(handlerPromise).resolves.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('on sign failure AFTER approve: fires approval-result error event AND keeps the held response open (retry loop)', async () => {
    // Detector loops on sign failure — re-arms pendingApproval so the
    // renderer's restored card can submit again after the user fixes
    // the cause (typically: unlocks the vault). This test verifies the
    // failure event fires AND the handler does NOT resolve until the
    // user makes a final decision in a follow-up iteration.
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', { approved: true });
    // Yield enough times for: decision-resolve, sign-throw, catch,
    // sendToHost, loop iter, new setPendingApproval.
    await flushRetryMicrotasks();

    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result', {
      detectionId: 'req-1001',
      success: false,
      error: VAULT_LOCKED_MESSAGE,
    });
    // A new pending approval entry exists so the user's next click can
    // submit again. The handler is still awaiting it.
    expect(hasPendingApproval('req-1001')).toBe(true);

    // End the test cleanly by rejecting the second iteration.
    settlePendingApproval('req-1001', { approved: false });
    const result = await handlerPromise;
    expect(result).toBeNull();
  });

  test('retry loop: sign failure followed by a successful second click → returns 307; original load resumes', async () => {
    mockSignAndQueueRetry.mockReset()
      .mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE))
      .mockResolvedValueOnce(undefined);

    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    // First click: user thought the vault was unlocked but it wasn't.
    settlePendingApproval('req-1001', { approved: true });
    await flushRetryMicrotasks();

    // Renderer would have restored the card; user unlocks; clicks again.
    expect(hasPendingApproval('req-1001')).toBe(true);
    settlePendingApproval('req-1001', { approved: true });

    const result = await handlerPromise;
    expect(result).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/segment/0'] },
    });
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(2);
    // Both events fired: failure then success.
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result',
      expect.objectContaining({ success: false }));
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-result',
      expect.objectContaining({ success: true }));
  });

  test('retry loop: sign failure followed by Reject on the second click → returns null', async () => {
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', { approved: true });
    await flushRetryMicrotasks();

    // User clicks Reject the second time around.
    settlePendingApproval('req-1001', { approved: false });

    const result = await handlerPromise;
    expect(result).toBeNull();
    // Sign was only attempted once (the second iteration short-circuited
    // on the reject before reaching signAndQueueRetry).
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(1);
  });

  test('retry loop: sign failure followed by tab destroy → returns null', async () => {
    mockSignAndQueueRetry.mockReset().mockRejectedValueOnce(new Error(VAULT_LOCKED_MESSAGE));

    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', { approved: true });
    await flushRetryMicrotasks();

    expect(hasPendingApproval('req-1001')).toBe(true);
    cleanupWebContents(7);

    const result = await handlerPromise;
    expect(result).toBeNull();
  });

  test('on reject: returns null so the page sees the 402', async () => {
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', { approved: false });

    const result = await handlerPromise;
    expect(result).toBeNull();
    expect(mockSignAndQueueRetry).not.toHaveBeenCalled();
  });

  test('grant payload from approval rides through to signAndQueueRetry', async () => {
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();

    settlePendingApproval('req-1001', {
      approved: true,
      grant: { capAmount: '10000000', windowSeconds: 30 * 24 * 60 * 60 },
    });

    await handlerPromise;
    expect(mockSignAndQueueRetry).toHaveBeenCalledWith(7, expect.objectContaining({
      grant: { capAmount: '10000000', windowSeconds: 30 * 24 * 60 * 60 },
    }));
  });

  test('a newer 402 on the same tab aborts the older pending approval (single-card UI)', async () => {
    const firstPromise = detectPaymentRequiredHandler(detail({ id: 1001, url: 'https://api.example/segment/0' }));
    await Promise.resolve();
    expect(hasPendingApproval('req-1001')).toBe(true);

    // Newer 402 fires.
    const secondPromise = detectPaymentRequiredHandler(detail({ id: 1002, url: 'https://api.example/segment/1' }));
    await Promise.resolve();

    // Older entry gone, newer entry in place.
    expect(hasPendingApproval('req-1001')).toBe(false);
    expect(hasPendingApproval('req-1002')).toBe(true);

    // First handler resolved as null (aborted).
    expect(await firstPromise).toBeNull();

    // Clean up the second.
    settlePendingApproval('req-1002', { approved: false });
    expect(await secondPromise).toBeNull();
  });

  test('tab destruction aborts the pending approval (the dispatcher callback releases instead of hanging)', async () => {
    const handlerPromise = detectPaymentRequiredHandler(detail());
    await Promise.resolve();
    expect(hasPendingApproval('req-1001')).toBe(true);

    cleanupWebContents(7);

    expect(hasPendingApproval('req-1001')).toBe(false);
    expect(await handlerPromise).toBeNull();
  });

  test('mainFrame: NOT awaited; existing behaviour — event fires and handler returns null synchronously', async () => {
    // mainFrame keeps the legacy path: page sees the 402, user clicks
    // Approve later, x402:approve IPC fires wc.loadURL.
    const result = await detectPaymentRequiredHandler(detail({ resourceType: 'mainFrame' }));
    expect(result).toBeNull();
    expect(hasPendingApproval('req-1001')).toBe(false);
    expect(mockHostSend).toHaveBeenCalledWith('x402:approval-needed', expect.objectContaining({
      detectionId: 'req-1001',
    }));
  });

  test('falls back to a generated detectionId when details.id is missing', async () => {
    detectPaymentRequiredHandler(detail({ id: undefined }));
    // mockHostSend is host.send(channel, payload) → [channel, payload]
    const call = mockHostSend.mock.calls.find((c) => c[0] === 'x402:approval-needed');
    const payload = call?.[1];
    expect(payload?.detectionId).toMatch(/^gen-/);
    // Clean up.
    abortPendingApproval(payload.detectionId, new Error('test cleanup'));
  });
});

// === setPendingPayment validation ========================================

describe('setPendingPayment input validation', () => {
  test('throws on an unrecognised header name (catches WP4 typos)', () => {
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: 'PAYMENT-SIGNAURE', // typo
      value: 'eyJ...',
    })).toThrow(/invalid pending-payment header/);
  });

  test('throws on null/undefined value', () => {
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: '',
    })).toThrow(/non-empty string/);
  });

  test('accepts the two canonical signature header names', () => {
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'eyJ...',
    })).not.toThrow();
    expect(() => setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V1,
      value: 'eyJ...',
    })).not.toThrow();
  });
});

// === injectPaymentSignatureHandler =======================================

describe('injectPaymentSignatureHandler', () => {
  const detail = (overrides = {}) => ({
    webContentsId: 7,
    url: 'https://api.example/article',
    requestHeaders: { Accept: 'text/html' },
    ...overrides,
  });

  test('attaches PAYMENT-SIGNATURE when a V2 pending payment exists', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'eyJwYXlsb2FkIjp7fX0=',
    });

    const result = injectPaymentSignatureHandler(detail());
    expect(result).toEqual({
      requestHeaders: {
        Accept: 'text/html',
        'PAYMENT-SIGNATURE': 'eyJwYXlsb2FkIjp7fX0=',
      },
    });
  });

  test('attaches X-PAYMENT when the pending entry is a V1 payload', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V1,
      value: 'eyJwYXlsb2FkIjp7fX0=',
    });
    const result = injectPaymentSignatureHandler(detail());
    expect(result.requestHeaders['X-PAYMENT']).toBeDefined();
    expect(result.requestHeaders['PAYMENT-SIGNATURE']).toBeUndefined();
  });

  test('one-shot: a second request to the same URL gets no injection', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
    });
    expect(injectPaymentSignatureHandler(detail())).not.toBeNull();
    expect(injectPaymentSignatureHandler(detail())).toBeNull();
  });

  test('passes through when there is no pending payment', () => {
    expect(injectPaymentSignatureHandler(detail())).toBeNull();
  });

  test('only fires for the exact (webContentsId, url) pair', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
    });

    // Wrong tab — pass through.
    expect(injectPaymentSignatureHandler(detail({ webContentsId: 9 }))).toBeNull();
    // Wrong URL — pass through.
    expect(injectPaymentSignatureHandler(detail({
      url: 'https://api.example/different',
    }))).toBeNull();
    // The original pending payment must still be there, not consumed.
    expect(injectPaymentSignatureHandler(detail())).not.toBeNull();
  });

  test('consumes the cap on inject (not on sign) using the stashed receipt context', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
    });
    expect(mockTryConsume).not.toHaveBeenCalled();

    injectPaymentSignatureHandler(detail());

    expect(mockTryConsume).toHaveBeenCalledWith(
      'https://api.example',
      8453,
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      '10000'
    );
  });

  test('skips cap consume when receipt context is incomplete (defensive)', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      // no origin/chainId/asset/amount — production sign-flow always
      // stashes these, but the inject handler shouldn't blow up if a
      // test or future caller skips them.
    });
    injectPaymentSignatureHandler(detail());
    expect(mockTryConsume).not.toHaveBeenCalled();
  });

  test('manual authorization: tryConsume returning false still attaches the header (user-explicit consent)', () => {
    mockTryConsume.mockReturnValueOnce(false);
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
      authorizedBy: 'manual',
    });
    const result = injectPaymentSignatureHandler(detail());
    expect(result.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig');
  });

  test('cap authorization: tryConsume returning false withholds the signature and drops the pending entry', () => {
    // Parallel-overshoot: two concurrent detections both passed the cap
    // check before either reached inject; the second one now finds the
    // cap exhausted and must NOT attach the signature (the cap was the
    // only consent). The detector will fire again on the resulting 402
    // and route to manual approval.
    mockTryConsume.mockReturnValueOnce(false);
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
      authorizedBy: 'cap',
    });

    expect(injectPaymentSignatureHandler(detail())).toBeNull();
    // One-shot drop even on withhold — a second inject attempt finds nothing.
    expect(injectPaymentSignatureHandler(detail())).toBeNull();
  });

  test('cap authorization with missing cap metadata withholds the signature', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      authorizedBy: 'cap',
    });

    expect(injectPaymentSignatureHandler(detail())).toBeNull();
    expect(mockTryConsume).not.toHaveBeenCalled();
    // One-shot drop even on withhold — a second inject attempt finds nothing.
    expect(injectPaymentSignatureHandler(detail())).toBeNull();
  });

  test('fires x402:cap-consumed at the host when the inject actually decremented a cap', () => {
    // Silent auto-pay (video segments, lazy paragraphs) never round-
    // trips through the renderer; without this event the sidebar's
    // auto-pay banner spend counter would stay stale until the next
    // page navigation.
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
      authorizedBy: 'cap',
    });
    // tryConsume defaults to mockReturnValue(true) in beforeEach.
    injectPaymentSignatureHandler(detail());
    // Origin is the only field the renderer needs (to filter multi-tab
    // payments) — full cap state is pulled fresh on the refresh IPC.
    expect(mockHostSend).toHaveBeenCalledWith('x402:cap-consumed', {
      origin: 'https://api.example',
    });
  });

  test('does NOT fire x402:cap-consumed when no cap was decremented (cap-raced withhold)', () => {
    mockTryConsume.mockReturnValueOnce(false);
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
      authorizedBy: 'cap',
    });
    injectPaymentSignatureHandler(detail());
    expect(mockHostSend).not.toHaveBeenCalledWith('x402:cap-consumed', expect.anything());
  });

  test('does NOT fire x402:cap-consumed for a manual pay without an existing cap (nothing to refresh)', () => {
    mockTryConsume.mockReturnValueOnce(false);
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
      authorizedBy: 'manual',
    });
    injectPaymentSignatureHandler(detail());
    expect(mockHostSend).not.toHaveBeenCalledWith('x402:cap-consumed', expect.anything());
  });

  test('default (no authorizedBy field) treats as manual — backward-compatible', () => {
    mockTryConsume.mockReturnValueOnce(false);
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
      // no authorizedBy
    });
    const result = injectPaymentSignatureHandler(detail());
    expect(result?.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig');
  });

  test('drops a stale pending entry past its TTL and does not attach the header', () => {
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
    });
    // Jump Date.now past PENDING_TTL_MS (60s).
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      const result = injectPaymentSignatureHandler(detail());
      expect(result).toBeNull();
      // And the consume must NOT have fired — stale signatures don't
      // charge the cap.
      expect(mockTryConsume).not.toHaveBeenCalled();
    } finally {
      Date.now = realNow;
    }
  });

  test('lazy sweep on setPendingPayment drops previously-expired entries from the map', () => {
    // Stash an entry, jump time past TTL, stash a fresh entry. The
    // fresh setPendingPayment should sweep the old one before adding.
    setPendingPayment(7, 'https://api.example/old', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'old-sig',
    });
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      setPendingPayment(7, 'https://api.example/new', {
        header: X402_HEADERS.SIGNATURE_V2,
        value: 'new-sig',
      });
      // Old entry is gone (without this test even attempting to inject it).
      expect(injectPaymentSignatureHandler({
        webContentsId: 7,
        url: 'https://api.example/old',
        requestHeaders: {},
      })).toBeNull();
      // New entry survives.
      const result = injectPaymentSignatureHandler({
        webContentsId: 7,
        url: 'https://api.example/new',
        requestHeaders: {},
      });
      expect(result?.requestHeaders['PAYMENT-SIGNATURE']).toBe('new-sig');
    } finally {
      Date.now = realNow;
    }
  });
});

// === Request-shape keying (concurrent Range, FIFO buckets, loop guard) ===
//
// Tests bridging-state behaviour added in WP-Range.2: pendingPayments
// keyed by request shape, awaitingResponse keyed by followed-request id.

describe('request-shape retry keying', () => {
  test('two concurrent Range requests on the same URL each get their own signature (no swap)', () => {
    // Detector saw two 402s for the same URL with different Range
    // headers — sign-flow stashes each under the matching retry key.
    setPendingPayment(7, 'https://x.example/media', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-bytes-0-99',
      origin: 'https://x.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
    }, { method: 'GET', range: 'bytes=0-99' });
    setPendingPayment(7, 'https://x.example/media', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-bytes-100-199',
      origin: 'https://x.example',
      chainId: 8453,
      asset: '0xabc',
      amount: '10000',
    }, { method: 'GET', range: 'bytes=100-199' });

    // Followed request for bytes=100-199 gets the bytes=100-199 sig —
    // not the bytes=0-99 one that was queued first.
    const r1 = injectPaymentSignatureHandler({
      id: 101,
      webContentsId: 7,
      url: 'https://x.example/media',
      requestHeaders: { Range: 'bytes=100-199' },
    });
    expect(r1.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig-bytes-100-199');

    // And the other followed request gets the other sig.
    const r2 = injectPaymentSignatureHandler({
      id: 102,
      webContentsId: 7,
      url: 'https://x.example/media',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    expect(r2.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig-bytes-0-99');
  });

  test('identical-shape requests share a FIFO bucket — first in, first out', () => {
    // Two truly indistinguishable requests (same URL, same Range). Each
    // gets a signature in the order it was queued.
    setPendingPayment(7, 'https://x.example/dup', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-first',
    });
    setPendingPayment(7, 'https://x.example/dup', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-second',
    });

    const r1 = injectPaymentSignatureHandler({
      id: 201,
      webContentsId: 7,
      url: 'https://x.example/dup',
      requestHeaders: {},
    });
    const r2 = injectPaymentSignatureHandler({
      id: 202,
      webContentsId: 7,
      url: 'https://x.example/dup',
      requestHeaders: {},
    });
    const r3 = injectPaymentSignatureHandler({
      id: 203,
      webContentsId: 7,
      url: 'https://x.example/dup',
      requestHeaders: {},
    });

    expect(r1.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig-first');
    expect(r2.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig-second');
    // Bucket empty — third request passes through unsigned.
    expect(r3).toBeNull();
  });

  test('different webContents IDs never share a bucket even with identical URL+Range', () => {
    setPendingPayment(7, 'https://x.example/v', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-tab-7',
    }, { range: 'bytes=0-99' });
    setPendingPayment(9, 'https://x.example/v', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-tab-9',
    }, { range: 'bytes=0-99' });

    const r7 = injectPaymentSignatureHandler({
      id: 301, webContentsId: 7, url: 'https://x.example/v',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    const r9 = injectPaymentSignatureHandler({
      id: 302, webContentsId: 9, url: 'https://x.example/v',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    expect(r7.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig-tab-7');
    expect(r9.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig-tab-9');
  });

  test('Range header lookup is case-insensitive (matches getHeaderValue)', () => {
    // Servers and clients can spell Range with arbitrary casing; the
    // bridging key has to normalize.
    setPendingPayment(7, 'https://x.example/m', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
    }, { range: 'bytes=0-99' });
    // Chromium might emit `range` lowercase; either casing must match.
    const result = injectPaymentSignatureHandler({
      id: 400,
      webContentsId: 7,
      url: 'https://x.example/m',
      requestHeaders: { range: 'bytes=0-99' },
    });
    expect(result?.requestHeaders['PAYMENT-SIGNATURE']).toBe('sig');
  });

  test('a request with no Range never shares a bucket with a Range-tagged signature', () => {
    // Defensive: queue a Range-tagged sig; a non-Range request for the
    // same URL must not pick it up.
    setPendingPayment(7, 'https://x.example/m', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'range-sig',
    }, { range: 'bytes=0-99' });

    const r = injectPaymentSignatureHandler({
      id: 500, webContentsId: 7, url: 'https://x.example/m',
      requestHeaders: {},
    });
    expect(r).toBeNull();
  });

  test('awaitingResponse is keyed by followed-request id (not url) so concurrent retries attribute correctly', () => {
    // Arm two awaitingResponse entries from two distinct inject calls.
    setPendingPayment(7, 'https://x.example/media', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-A',
      origin: 'https://x.example', chainId: 8453,
      asset: '0xabc', amount: '10000',
    }, { range: 'bytes=0-99' });
    setPendingPayment(7, 'https://x.example/media', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-B',
      origin: 'https://x.example', chainId: 8453,
      asset: '0xdef', amount: '20000',
    }, { range: 'bytes=100-199' });

    injectPaymentSignatureHandler({
      id: 601, webContentsId: 7, url: 'https://x.example/media',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    injectPaymentSignatureHandler({
      id: 602, webContentsId: 7, url: 'https://x.example/media',
      requestHeaders: { Range: 'bytes=100-199' },
    });

    // Two distinct receipts get logged, each tagged with the right amount.
    const responseB64 = Buffer.from(JSON.stringify({ txHash: '0xtx', success: true })).toString('base64');
    paymentResponseLoggingHandler({
      id: 601, webContentsId: 7, url: 'https://x.example/media',
      statusLine: 'HTTP/1.1 206 Partial Content',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    paymentResponseLoggingHandler({
      id: 602, webContentsId: 7, url: 'https://x.example/media',
      statusLine: 'HTTP/1.1 206 Partial Content',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(2);
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({ amount: '10000' }));
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({ amount: '20000' }));
  });

  test('loop guard fires by followed-request id (not url)', async () => {
    // Set up "already signed" state for id=701; a 402 on id=701 must NOT
    // re-sign even though the URL is the same.
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2, value: 'sig',
      origin: 'https://api.example', chainId: 8453,
      asset: '0xabc', amount: '10000', authorizedBy: 'cap',
    });
    injectPaymentSignatureHandler({
      id: 701, webContentsId: 7, url: 'https://api.example/article',
      requestHeaders: {},
    });

    // Cap still covers; without the id-based loop guard the detector
    // would re-sign.
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '10000',
      createdAt: 1, expiresAt: 9999999999,
    });
    const result = await detectPaymentRequiredHandler({
      id: 701,
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
      resourceType: 'xhr',
    });
    expect(result).toBeNull();
    expect(mockSignAndQueueRetry).not.toHaveBeenCalled();
  });

  test('loop guard does NOT fire when a NEW request id 402s the same URL (a different request shape on the wire)', async () => {
    // First-signed (id=801) already in awaitingResponse from inject.
    setPendingPayment(7, 'https://api.example/article', {
      header: X402_HEADERS.SIGNATURE_V2, value: 'sig',
      origin: 'https://api.example', chainId: 8453,
      asset: '0xabc', amount: '10000', authorizedBy: 'cap',
    });
    injectPaymentSignatureHandler({
      id: 801, webContentsId: 7, url: 'https://api.example/article',
      requestHeaders: {},
    });

    // A SECOND request to the same URL (different id) 402s. Loop guard
    // shouldn't fire — this is a fresh request, not a rejected retry.
    mockGetPermission.mockReturnValueOnce({
      capAmount: '20000', spentAmount: '10000',
      createdAt: 1, expiresAt: 9999999999,
    });
    const result = await detectPaymentRequiredHandler({
      id: 802,
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
      resourceType: 'xhr',
    });
    // Cap-covered auto-pay branch fires.
    expect(result).toEqual({
      statusLine: 'HTTP/1.1 307 Temporary Redirect',
      responseHeaders: { Location: ['https://api.example/article'] },
    });
    expect(mockSignAndQueueRetry).toHaveBeenCalledTimes(1);
  });
});

// === requestContext capture + cleanup ====================================

describe('captureRequestContextHandler', () => {
  test('stores method + url + range + webContentsId keyed by details.id', () => {
    captureRequestContextHandler({
      id: 900,
      webContentsId: 7,
      method: 'GET',
      url: 'https://x.example/m',
      requestHeaders: { Range: 'bytes=0-99' },
      resourceType: 'media',
    });
    // Verify via the detector's downstream consumer — feed a 402 with
    // the same id and assert requestShape rides into the detection.
    detectPaymentRequiredHandler({
      id: 900,
      webContentsId: 7,
      url: 'https://x.example/m',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
      resourceType: 'media',
    });
    expect(getDetectedPayment(7)?.requestShape).toEqual({
      method: 'GET',
      range: 'bytes=0-99',
    });
  });

  test('synthetic fallback when capture did not run (e.g. SW request or test driving the detector directly)', async () => {
    // No prior capture for id=901. Detection falls back to synthetic shape.
    await detectPaymentRequiredHandler({
      id: 901,
      webContentsId: 7,
      url: 'https://x.example/m',
      method: 'POST',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    expect(getDetectedPayment(7)?.requestShape).toEqual({
      method: 'POST',
      range: null,
    });
  });

  test('skips capture for non-x402 resource types (image, stylesheet, font, script) to bound the working set', async () => {
    // These resource types will never receive an x402 paywall in
    // practice — pages with image galleries / CSS sprites / web fonts
    // would otherwise flood `requestContext`.
    for (const resourceType of ['image', 'stylesheet', 'font', 'script']) {
      captureRequestContextHandler({
        id: 800 + resourceType.length, // distinct ids per type
        webContentsId: 7,
        method: 'GET',
        url: `https://x.example/${resourceType}`,
        requestHeaders: { Range: 'bytes=0-99' },
        resourceType,
      });
    }
    // None of these captures landed. A detection with the same id falls
    // back to synthetic shape.
    await detectPaymentRequiredHandler({
      id: 800 + 'image'.length,
      webContentsId: 7,
      url: 'https://x.example/image',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    expect(getDetectedPayment(7)?.requestShape).toEqual({
      method: 'GET',
      range: null,
    });
  });

  test('Range header case-insensitive on capture (lowercase from Chromium / proxies)', () => {
    captureRequestContextHandler({
      id: 902,
      webContentsId: 7,
      method: 'GET',
      url: 'https://x.example/m',
      requestHeaders: { range: 'bytes=0-99' },
    });
    detectPaymentRequiredHandler({
      id: 902,
      webContentsId: 7,
      url: 'https://x.example/m',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    expect(getDetectedPayment(7)?.requestShape).toEqual({
      method: 'GET',
      range: 'bytes=0-99',
    });
  });
});

describe('clearRequestContextHandler', () => {
  test('drops the requestContext entry for the given details.id', async () => {
    captureRequestContextHandler({
      id: 1000,
      webContentsId: 7,
      method: 'GET',
      url: 'https://x.example/m',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    clearRequestContextHandler({ id: 1000 });

    // A subsequent 402 with the same id finds no captured context →
    // synthetic fallback kicks in.
    await detectPaymentRequiredHandler({
      id: 1000,
      webContentsId: 7,
      url: 'https://x.example/m',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    expect(getDetectedPayment(7)?.requestShape).toEqual({
      method: 'GET',
      range: null,
    });
  });

  test('drops awaitingResponse for signed retries that error before response headers', () => {
    setPendingPayment(7, 'https://x.example/m', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig',
      origin: 'https://x.example',
      chainId: 8453,
      asset: '0xa',
      amount: '1',
    });
    injectPaymentSignatureHandler({
      id: 1010,
      webContentsId: 7,
      url: 'https://x.example/m',
      requestHeaders: {},
    });

    clearRequestContextHandler({ id: 1010 });

    const responseB64 = Buffer.from(JSON.stringify({ txHash: '0xtx' })).toString('base64');
    paymentResponseLoggingHandler({
      id: 1010,
      webContentsId: 7,
      url: 'https://x.example/m',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).not.toHaveBeenCalled();
  });

  test('TTL backstop: capture sweeps entries past TTL on each set()', () => {
    captureRequestContextHandler({
      id: 1100,
      webContentsId: 7,
      method: 'GET',
      url: 'https://x.example/old',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    // Jump past the 60s TTL.
    const realNow = Date.now;
    Date.now = () => realNow() + 61_000;
    try {
      captureRequestContextHandler({
        id: 1101,
        webContentsId: 7,
        method: 'GET',
        url: 'https://x.example/new',
        requestHeaders: {},
      });
      // Old entry was swept. Detection on id=1100 falls back to synthetic.
      detectPaymentRequiredHandler({
        id: 1100,
        webContentsId: 7,
        url: 'https://x.example/old',
        statusLine: 'HTTP/1.1 402 Payment Required',
        responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
      });
      expect(getDetectedPayment(7)?.requestShape).toEqual({
        method: 'GET',
        range: null,
      });
    } finally {
      Date.now = realNow;
    }
  });

  test('cleanupWebContents drops this tab\'s requestContext entries (without touching other tabs)', () => {
    captureRequestContextHandler({
      id: 1200, webContentsId: 7, method: 'GET',
      url: 'https://x.example/a',
      requestHeaders: { Range: 'bytes=0-99' },
    });
    captureRequestContextHandler({
      id: 1201, webContentsId: 9, method: 'GET',
      url: 'https://x.example/b',
      requestHeaders: { Range: 'bytes=0-99' },
    });

    cleanupWebContents(7);

    // Tab 7's entry is gone; tab 9's survives. Verify via the detector.
    detectPaymentRequiredHandler({
      id: 1200, webContentsId: 7,
      url: 'https://x.example/a',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    expect(getDetectedPayment(7)?.requestShape).toEqual({
      method: 'GET',
      range: null, // synthetic — captured shape was cleaned up
    });

    detectPaymentRequiredHandler({
      id: 1201, webContentsId: 9,
      url: 'https://x.example/b',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    expect(getDetectedPayment(9)?.requestShape).toEqual({
      method: 'GET',
      range: 'bytes=0-99', // captured shape preserved
    });
  });
});

// === cleanupWebContents ==================================================

describe('cleanupWebContents', () => {
  test('drops detected payment for the closed tab and leaves other tabs', () => {
    detectPaymentRequiredHandler({
      webContentsId: 7,
      url: 'https://a.example/',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    detectPaymentRequiredHandler({
      webContentsId: 8,
      url: 'https://b.example/',
      statusLine: 'HTTP/1.1 402 Payment Required',
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });

    cleanupWebContents(7);

    expect(getDetectedPayment(7)).toBeNull();
    expect(getDetectedPayment(8)).not.toBeNull();
  });

  test('drops only the closed tab\'s pending payments (not the URL on other tabs)', () => {
    setPendingPayment(7, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-7',
    });
    setPendingPayment(8, 'https://x.example/', {
      header: X402_HEADERS.SIGNATURE_V2,
      value: 'sig-8',
    });

    cleanupWebContents(7);

    expect(injectPaymentSignatureHandler({
      webContentsId: 7,
      url: 'https://x.example/',
      requestHeaders: {},
    })).toBeNull();
    expect(injectPaymentSignatureHandler({
      webContentsId: 8,
      url: 'https://x.example/',
      requestHeaders: {},
    })).not.toBeNull();
  });

  test('drops only the closed tab\'s in-flight awaitingResponse entries (keyed by request id, value-tagged with webContentsId)', () => {
    // Arm two in-flight entries from two tabs.
    setPendingPayment(7, 'https://x.example/a', {
      header: X402_HEADERS.SIGNATURE_V2, value: 'sig-7',
      origin: 'https://x.example', chainId: 8453, asset: '0xa', amount: '1',
    });
    setPendingPayment(8, 'https://x.example/a', {
      header: X402_HEADERS.SIGNATURE_V2, value: 'sig-8',
      origin: 'https://x.example', chainId: 8453, asset: '0xa', amount: '1',
    });
    injectPaymentSignatureHandler({
      id: 1300, webContentsId: 7, url: 'https://x.example/a',
      requestHeaders: {},
    });
    injectPaymentSignatureHandler({
      id: 1301, webContentsId: 8, url: 'https://x.example/a',
      requestHeaders: {},
    });

    cleanupWebContents(7);

    // Tab 7's in-flight signed request is recorded as no-receipt on cleanup.
    expect(mockAppendReceipt).toHaveBeenCalledTimes(1);
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://x.example',
      chainId: 8453,
      asset: '0xa',
      amount: '1',
      status: 'no-receipt',
      metadata: { cleanupReason: 'tab destroyed' },
    }));

    // Tab 7's later response no longer attributes a second time.
    const responseB64 = Buffer.from(JSON.stringify({ txHash: '0xtx' })).toString('base64');
    paymentResponseLoggingHandler({
      id: 1300, webContentsId: 7, url: 'https://x.example/a',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(1);

    // Tab 8's response still attributes.
    paymentResponseLoggingHandler({
      id: 1301, webContentsId: 8, url: 'https://x.example/a',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(2);
  });
});

// === isStatus402 edge cases (via detector) ===============================

describe('isStatus402 edge cases (via detector pass-through)', () => {
  // Drive through the detector to avoid exporting the inner helper just
  // for tests — the behaviour we care about is "non-402 status lines
  // never trigger a detection."
  const driveWith = (statusLine) => {
    detectPaymentRequiredHandler({
      webContentsId: 7,
      url: 'https://x.example/',
      statusLine,
      responseHeaders: { 'PAYMENT-REQUIRED': [sampleRequirementsB64] },
    });
    return getDetectedPayment(7);
  };

  test.each([
    ['undefined statusLine', undefined, false],
    ['null statusLine', null, false],
    ['number statusLine', 42, false],
    ['empty string', '', false],
    ['HTTP/2 402 Payment Required (with reason phrase)', 'HTTP/2 402 Payment Required', true],
    // HTTP/2 status lines can omit the reason phrase — Electron emits
    // just "HTTP/2 402" with no trailing space. The 402 must still be
    // detected; the regex anchors to end-of-string for this.
    ['HTTP/2 402 (no reason phrase)', 'HTTP/2 402', true],
  ])('%s', (_label, statusLine, expectDetected) => {
    const result = driveWith(statusLine);
    if (expectDetected) {
      expect(result).not.toBeNull();
    } else {
      expect(result).toBeNull();
    }
  });

  test('a 4022 status line (no padded boundary) is not a 402', () => {
    expect(driveWith('HTTP/1.1 4022 Something')).toBeNull();
  });
});

// === installX402Interception =============================================

describe('installX402Interception', () => {
  test('registers capture+inject on onBeforeSendHeaders, detect+receipt on onHeadersReceived, cleanup on onCompleted+onErrorOccurred', () => {
    installX402Interception();

    expect(mockRegister).toHaveBeenCalledTimes(6);
    expect(mockRegister).toHaveBeenCalledWith(
      'onBeforeSendHeaders',
      'x402-capture',
      captureRequestContextHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onBeforeSendHeaders',
      'x402-inject',
      injectPaymentSignatureHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onHeadersReceived',
      'x402-detect',
      detectPaymentRequiredHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onHeadersReceived',
      'x402-receipt',
      paymentResponseLoggingHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onCompleted',
      'x402-cleanup',
      clearRequestContextHandler
    );
    expect(mockRegister).toHaveBeenCalledWith(
      'onErrorOccurred',
      'x402-cleanup',
      clearRequestContextHandler
    );
  });

});

describe('paymentResponseLoggingHandler', () => {
  const responseB64 = Buffer.from(JSON.stringify({ txHash: '0xabc', success: true })).toString('base64');

  test('short-circuits without iterating headers when no injection is awaiting', () => {
    // Set a header that would otherwise be picked up. The handler must
    // not touch responseHeaders unless armed via injectPaymentSignatureHandler.
    const responseHeaders = {
      get [Symbol.iterator]() {
        throw new Error('paymentResponseLoggingHandler must not iterate headers on the miss path');
      },
    };
    const result = paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      responseHeaders,
    });
    expect(result).toBeNull();
  });

  const armInjection = (overrides = {}) => {
    setPendingPayment(7, 'https://api.example/article', {
      header: 'PAYMENT-SIGNATURE',
      value: 'sig',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      ...overrides,
    });
    injectPaymentSignatureHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      requestHeaders: {},
    });
  };

  test('on a 200 + PAYMENT-RESPONSE: writes a settled receipt with txHash', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(1);
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'x402',
      url: 'https://api.example/article',
      origin: 'https://api.example',
      chainId: 8453,
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '10000',
      txHash: '0xabc',
      status: 'settled',
    }));
  });

  test('on a 200 with no PAYMENT-RESPONSE: writes a no-receipt entry (user signed, server confirmed nothing)', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: {},
    });
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      txHash: null,
      status: 'no-receipt',
    }));
  });

  test('on a non-2xx: writes a failed receipt so the user can see they signed but got nothing', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 500 Internal Server Error',
      responseHeaders: {},
    });
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      txHash: null,
    }));
  });

  test('one-shot: a second response to the same URL does not write a duplicate', () => {
    armInjection();
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledTimes(1);
  });

  test('no injection awaiting: no receipt is written and headers are not touched', () => {
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).not.toHaveBeenCalled();
  });

  test('reads X-PAYMENT-RESPONSE (V1 canonical settlement header) when the pending payment was V1', () => {
    armInjection({ header: 'X-PAYMENT' });  // V1 signed-header marker
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'X-PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      txHash: '0xabc',
      status: 'settled',
    }));
  });

  test('falls back to the other version-header when the canonical one is missing', () => {
    // V1 signed but server emitted V2 header (drift). Still logs.
    armInjection({ header: 'X-PAYMENT' });
    paymentResponseLoggingHandler({
      webContentsId: 7,
      url: 'https://api.example/article',
      statusLine: 'HTTP/1.1 200 OK',
      responseHeaders: { 'PAYMENT-RESPONSE': [responseB64] },
    });
    expect(mockAppendReceipt).toHaveBeenCalledWith(expect.objectContaining({
      txHash: '0xabc',
      status: 'settled',
    }));
  });
});
