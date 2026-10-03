const mockIpcHandlers = new Map();
const mockWebContents = [];
jest.mock('electron', () => ({
  ipcMain: { handle: (channel, handler) => mockIpcHandlers.set(channel, handler) },
  webContents: { getAllWebContents: () => mockWebContents },
}));
jest.mock('../logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('./swarm-service', () => {
  const { isUsableStamp, isPendingStamp, isPropagatingStamp, isFullImmutableStamp } =
    jest.requireActual('./swarm-service');
  return { isUsableStamp, isPendingStamp, isPropagatingStamp, isFullImmutableStamp };
});

const {
  createPublishSetupService,
  classifyReadiness,
  normalizeQuote,
  roundUpToCent,
  formatUnits,
  parseXdaiShortfall,
  parseDepositAmount,
  PLANS,
  REQUOTE_MS,
  WATCH_REFRESH_MS,
  FUNDING_TX_POLL_MS,
  CONFIRM_POLL_MS,
  CONFIRM_TIMEOUT_MS,
  CHAIN_INIT_SLOW_MS,
} = require('./publish-setup-service');

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const CHEQUEBOOK = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const BATCH_A = 'a'.repeat(64);
const BATCH_B = 'b'.repeat(64);
const TX_HASH = `0x${'1'.repeat(64)}`;

const ok = (data, status = 200) => ({ ok: true, status, data, message: null });
const fail = (status, message = null) => ({
  ok: false,
  status,
  data: message ? { code: status, message } : null,
  message,
});

function quoteBody(overrides = {}) {
  return {
    depth: 20,
    days: 30,
    amountPerChunk: '65676000',
    planCostPlur: '68866000000000',
    settlementDepositPlur: '10000000000000',
    walletAddress: WALLET,
    walletBzzPlur: '0',
    walletXdaiWei: '0',
    bzzToAcquirePlur: '78866000000000',
    swapInputWei: '432000000000000000',
    gasReserveWei: '15000000000000000',
    xdaiRequiredWei: '447000000000000000',
    xdaiToSendWei: '447000000000000000',
    sufficientFunds: false,
    ...overrides,
  };
}

const funded = (overrides = {}) =>
  quoteBody({
    walletXdaiWei: '447000000000000000',
    xdaiToSendWei: '0',
    sufficientFunds: true,
    ...overrides,
  });

function depositBody(overrides = {}) {
  return {
    chequebook: CHEQUEBOOK,
    managed: true,
    depositPlur: '0',
    targetPlur: '10000000000000',
    shortfallPlur: '10000000000000',
    needsTopUp: true,
    walletAddress: WALLET,
    walletBzzPlur: '0',
    walletXdaiWei: '0',
    bzzToAcquirePlur: '10000000000000',
    swapInputWei: '700000000000000',
    gasReserveWei: '15000000000000000',
    xdaiRequiredWei: '15700000000000000',
    xdaiToSendWei: '15700000000000000',
    sufficientFunds: false,
    ...overrides,
  };
}

function createApi() {
  return {
    getHealth: jest.fn().mockResolvedValue(ok({ status: 'ok', chainReady: true })),
    getNode: jest.fn().mockResolvedValue(ok({ beeMode: 'light' })),
    getReadiness: jest.fn().mockResolvedValue(ok({})),
    getStamps: jest.fn().mockResolvedValue(ok({ stamps: [] })),
    getAddresses: jest.fn().mockResolvedValue(ok({ ethereum: WALLET })),
    getWallet: jest
      .fn()
      .mockResolvedValue(
        ok({ nativeTokenBalance: '250000000000000000', bzzBalance: '5000000000000000' })
      ),
    getChequebookAddress: jest.fn().mockResolvedValue(ok({ chequebookAddress: CHEQUEBOOK })),
    getChequebookBalance: jest.fn().mockResolvedValue(ok({ availableBalance: '10000000000000' })),
    getStorageQuote: jest.fn().mockResolvedValue(ok(quoteBody())),
    buyStorage: jest.fn().mockResolvedValue(ok({ batchID: BATCH_A }, 201)),
    extendStorage: jest.fn().mockResolvedValue(ok({ batchID: BATCH_A })),
    getSettlementDeposit: jest
      .fn()
      .mockResolvedValue(ok(depositBody({ needsTopUp: false, shortfallPlur: '0' }))),
    topUpSettlementDeposit: jest.fn().mockResolvedValue(ok(depositBody({ needsTopUp: false }))),
  };
}

function setup({
  status = 'running',
  error = null,
  registryMode = 'bundled',
  api = createApi(),
} = {}) {
  const node = { status, error, registryMode };
  const published = [];
  const restartNode = jest.fn().mockResolvedValue();
  const getTransactionStatus = jest.fn().mockResolvedValue({ status: 'pending' });
  const service = createPublishSetupService({
    api,
    getNodeStatus: () => ({ status: node.status, error: node.error }),
    getRegistryMode: () => node.registryMode,
    restartNode,
    getTransactionStatus,
    publish: (state) => published.push(state),
    now: () => Date.now(),
  });
  return { service, api, node, published, restartNode, getTransactionStatus };
}

// Let every pending promise chain settle without moving the clock.
const settle = () => jest.advanceTimersByTimeAsync(0);

// The node lists the batch the buy returns (BATCH_A) as usable at once, as
// antd v0.5.50 does: the purchase goes straight from confirming to done.
const listBoughtBatchAsUsable = (api) =>
  api.getStamps.mockResolvedValue(ok({ stamps: [{ batchID: BATCH_A, usable: true }] }));

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('pure helpers', () => {
  test('rounds a wei amount up to the next cent and never below it', () => {
    expect(roundUpToCent('447000000000000000')).toEqual({
      wei: '450000000000000000',
      display: '0.45',
    });
    expect(roundUpToCent('450000000000000000')).toEqual({
      wei: '450000000000000000',
      display: '0.45',
    });
    expect(roundUpToCent('1')).toEqual({ wei: '10000000000000000', display: '0.01' });
    expect(roundUpToCent('0')).toEqual({ wei: '0', display: '0.00' });
    expect(roundUpToCent('12345000000000000000')).toEqual({
      wei: '12350000000000000000',
      display: '12.35',
    });
    expect(roundUpToCent('not a number')).toBeNull();
    expect(roundUpToCent('-5')).toBeNull();
  });

  test('formats token amounts with at most four decimals', () => {
    expect(formatUnits('10000000000000', 16)).toBe('0.001');
    expect(formatUnits('250000000000000000', 18)).toBe('0.25');
    expect(formatUnits('1000000000000000000', 18)).toBe('1');
    expect(formatUnits('123456789000000000', 18)).toBe('0.1234');
    expect(formatUnits(null, 18)).toBeNull();
  });

  test('normalizes a quote into what the pay step shows and the write route needs', () => {
    expect(normalizeQuote(quoteBody(), 'buy')).toEqual({
      depth: 20,
      days: 30,
      amountPerChunk: '65676000',
      walletAddress: WALLET,
      walletXdai: '0',
      xdaiToSendWei: '447000000000000000',
      send: { wei: '450000000000000000', display: '0.45' },
      price: { wei: '450000000000000000', display: '0.45' },
      depositXbzz: '0.001',
      sufficientFunds: false,
    });
    expect(normalizeQuote(quoteBody({ settlementDepositPlur: '0' }), 'buy').depositXbzz).toBeNull();
    expect(normalizeQuote(depositBody(), 'deposit')).toMatchObject({
      amountPerChunk: null,
      depositXbzz: '0.001',
    });
  });

  test('refuses a quote it cannot pay from', () => {
    expect(normalizeQuote(quoteBody({ amountPerChunk: undefined }), 'buy')).toBeNull();
    expect(normalizeQuote(quoteBody({ walletAddress: 'nope' }), 'buy')).toBeNull();
    expect(normalizeQuote(quoteBody({ sufficientFunds: 'yes' }), 'buy')).toBeNull();
    expect(normalizeQuote(quoteBody({ xdaiToSendWei: '1.5' }), 'buy')).toBeNull();
    expect(normalizeQuote(null, 'buy')).toBeNull();
  });
});

describe('classifyReadiness', () => {
  const running = { status: 'running', error: null, registryMode: 'bundled' };
  const probe = (overrides = {}) => ({
    at: 0,
    unreachable: false,
    chainReady: true,
    nodeMode: 'light',
    peersReady: true,
    stamps: { known: true, usable: 1, total: 1 },
    ...overrides,
  });

  test.each([
    [{ status: 'stopped' }, 'stopped', 'node-stopped'],
    [{ status: 'starting' }, 'starting', 'node-stopped'],
    [{ status: 'stopping' }, 'stopping', 'node-stopped'],
    [{ status: 'error', error: 'Startup timed out' }, 'error', 'node-stopped'],
    [{ status: 'running', registryMode: 'disabled' }, 'disabled', 'node-stopped'],
  ])('a node that is not running (%j) is %s', (node, key, reason) => {
    const result = classifyReadiness({
      node: { registryMode: 'bundled', ...node },
      probe: probe(),
    });
    expect(result).toMatchObject({ ok: false, key, reason });
  });

  test('says what the node failed with, instead of a generic error', () => {
    expect(
      classifyReadiness({ node: { status: 'error', error: 'Startup timed out' }, probe: null })
        .message
    ).toBe('The Swarm node failed: Startup timed out');
  });

  test('waits for chain init, and suggests the RPC or a restart once it is slow', () => {
    const syncing = probe({ chainReady: false, stamps: { known: false } });
    expect(
      classifyReadiness({ node: running, probe: syncing, runningSince: 0, now: 1000 })
    ).toMatchObject({
      key: 'chain-syncing',
      reason: 'node-not-ready',
      slow: false,
    });
    const slow = classifyReadiness({
      node: running,
      probe: syncing,
      runningSince: 0,
      now: CHAIN_INIT_SLOW_MS + 1,
    });
    expect(slow).toMatchObject({ key: 'chain-syncing', slow: true });
    expect(slow.message).toMatch(/Gnosis RPC/);
  });

  test('only a node that says ultra-light is one', () => {
    expect(
      classifyReadiness({ node: running, probe: probe({ nodeMode: 'ultraLight' }) })
    ).toMatchObject({
      key: 'ultra-light',
      reason: 'ultra-light-mode',
    });
    expect(
      classifyReadiness({
        node: { ...running, registryMode: 'external' },
        probe: probe({ nodeMode: 'ultraLight' }),
      }).message
    ).toMatch(/where the node is managed/);
  });

  test('checks peers, then stamps', () => {
    expect(classifyReadiness({ node: running, probe: probe({ peersReady: false }) }).key).toBe(
      'connecting'
    );
    expect(
      classifyReadiness({ node: running, probe: probe({ stamps: { known: false } }) }).key
    ).toBe('checking');
    expect(
      classifyReadiness({
        node: running,
        probe: probe({ stamps: { known: true, usable: 0, total: 0 } }),
      })
    ).toMatchObject({ key: 'needs-storage', reason: 'no-usable-stamps' });
    expect(
      classifyReadiness({
        node: running,
        probe: probe({ stamps: { known: true, usable: 0, total: 2 } }),
      }).message
    ).toMatch(/can be used anymore/);
    expect(
      classifyReadiness({
        node: running,
        probe: probe({ stamps: { known: true, usable: 0, pending: 1, propagating: 1, total: 1 } }),
      })
    ).toMatchObject({ ok: true, key: 'storage-pending', reason: null });
    expect(
      classifyReadiness({
        node: running,
        probe: probe({ stamps: { known: true, usable: 0, pending: 1, propagating: 0, total: 1 } }),
      })
    ).toMatchObject({ ok: false, key: 'storage-pending', reason: 'node-not-ready' });
    expect(
      classifyReadiness({
        node: running,
        probe: probe({ stamps: { known: true, usable: 2, total: 3 } }),
      })
    ).toEqual({
      ok: true,
      key: 'ready',
      reason: null,
      message: 'Ready to publish. 2 storage batches available.',
      slow: false,
    });
  });
});

describe('publish readiness', () => {
  test('reads chain init, mode, peers and usable stamps', async () => {
    const { service, api } = setup();
    api.getStamps.mockResolvedValue(ok({ stamps: [{ usable: true }, { usable: false }] }));

    await expect(service.getPublishReadiness()).resolves.toEqual({
      ok: true,
      reason: null,
      message: 'Ready to publish. 1 storage batch available.',
    });
    expect(api.getHealth).toHaveBeenCalledTimes(1);
    expect(api.getNode).toHaveBeenCalledTimes(1);
    expect(api.getReadiness).toHaveBeenCalledTimes(1);
    expect(api.getStamps).toHaveBeenCalledTimes(1);
  });

  test('a full immutable batch is not storage: readiness asks for a plan', async () => {
    // depth 20, bucketDepth 16: a bucket holds 2^4 = 16 chunks.
    const full = {
      batchID: BATCH_A,
      usable: true,
      immutableFlag: true,
      depth: 20,
      bucketDepth: 16,
      utilization: 16,
    };
    const { service, api } = setup();
    api.getStamps.mockResolvedValue(ok({ stamps: [full] }));
    await expect(service.getPublishReadiness()).resolves.toEqual({
      ok: false,
      reason: 'no-usable-stamps',
      message: 'Your storage is full. Buy a storage plan to keep publishing.',
    });
    expect(service.getState().stamps).toMatchObject({ usable: 0, total: 1 });

    // One chunk short of full still publishes; so does a full mutable batch,
    // which keeps stamping by overwriting (messaging relies on it).
    const { service: room, api: roomApi } = setup();
    roomApi.getStamps.mockResolvedValue(
      ok({
        stamps: [
          { ...full, utilization: 15 },
          { ...full, batchID: BATCH_B, immutableFlag: false },
        ],
      })
    );
    await expect(room.getPublishReadiness()).resolves.toMatchObject({ ok: true });
    expect(room.getState().stamps).toMatchObject({ usable: 2 });
  });

  test('during chain init it reports node-not-ready, not missing stamps', async () => {
    // antd answers GET /stamps with an empty list until chain init is done.
    const { service, api } = setup();
    api.getHealth.mockResolvedValue(ok({ status: 'ok', chainReady: false }));

    await expect(service.getPublishReadiness()).resolves.toMatchObject({
      ok: false,
      reason: 'node-not-ready',
    });
    expect(api.getStamps).not.toHaveBeenCalled();
  });

  test('treats a node without the chainReady flag as ready', async () => {
    const { service, api } = setup();
    api.getHealth.mockResolvedValue(ok({ status: 'ok' }));
    api.getStamps.mockResolvedValue(ok({ stamps: [{ usable: true }] }));

    await expect(service.getPublishReadiness()).resolves.toMatchObject({ ok: true });
  });

  test('reuses a fresh probe instead of asking the node again', async () => {
    const { service, api } = setup();
    await service.getPublishReadiness();
    await service.getPublishReadiness();
    expect(api.getHealth).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(2_500);
    await service.getPublishReadiness();
    expect(api.getHealth).toHaveBeenCalledTimes(2);
  });

  test('asks nothing of a node that is not running', async () => {
    const { service, api } = setup({ status: 'stopped' });
    await expect(service.getPublishReadiness()).resolves.toMatchObject({
      ok: false,
      reason: 'node-stopped',
    });
    expect(api.getHealth).not.toHaveBeenCalled();
  });

  test('an unreachable node is stopped for the provider', async () => {
    const { service, api } = setup();
    api.getHealth.mockResolvedValue({ ok: false, status: 0, data: null, unreachable: true });
    await expect(service.getPublishReadiness()).resolves.toMatchObject({
      ok: false,
      reason: 'node-stopped',
    });
  });
});

describe('the armed purchase', () => {
  test('waits for the payment, then buys exactly once with the quoted amount', async () => {
    const { service, api } = setup();
    expect(service.arm({ kind: 'buy', planId: 'starter' })).toMatchObject({ ok: true });
    await settle();

    expect(api.getStorageQuote).toHaveBeenCalledWith({ depth: 20, days: 30 });
    expect(service.getState().operation).toMatchObject({
      phase: 'awaiting-funds',
      quote: { send: { display: '0.45' }, walletAddress: WALLET },
    });
    expect(api.buyStorage).not.toHaveBeenCalled();

    // Still short on the next quote: nothing is bought.
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(api.getStorageQuote).toHaveBeenCalledTimes(2);
    expect(api.buyStorage).not.toHaveBeenCalled();

    // The payment lands.
    api.getStorageQuote.mockResolvedValue(ok(funded({ amountPerChunk: '70000000' })));
    api.getStamps.mockResolvedValue(ok({ stamps: [{ batchID: BATCH_A, usable: true }] }));
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);

    expect(api.buyStorage).toHaveBeenCalledTimes(1);
    expect(api.buyStorage).toHaveBeenCalledWith({
      depth: 20,
      amountPerChunk: '70000000',
      immutable: true,
    });
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { batchId: BATCH_A },
    });

    // Done means done: no more quotes, no second buy.
    await jest.advanceTimersByTimeAsync(REQUOTE_MS * 5);
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
    expect(api.getStorageQuote).toHaveBeenCalledTimes(3);
  });

  test('buys at once when the node already holds enough', async () => {
    const { service, api } = setup();
    listBoughtBatchAsUsable(api);
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    service.arm({ kind: 'buy', planId: 'plus' });
    await settle();

    expect(api.getStorageQuote).toHaveBeenCalledWith({ depth: 22, days: 365 });
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('never runs a second buy while one is on its way', async () => {
    const { service, api } = setup();
    listBoughtBatchAsUsable(api);
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    let finishBuy;
    api.buyStorage.mockReturnValue(
      new Promise((resolve) => {
        finishBuy = resolve;
      })
    );

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation.phase).toBe('executing');

    await jest.advanceTimersByTimeAsync(REQUOTE_MS * 10);
    expect(service.arm({ kind: 'buy', planId: 'starter' })).toMatchObject({ ok: false });
    expect(service.cancel()).toMatchObject({ ok: false });
    expect(service.getState().canRestart).toBe(false);
    expect(api.getStorageQuote).toHaveBeenCalledTimes(1);
    expect(api.buyStorage).toHaveBeenCalledTimes(1);

    finishBuy(ok({ batchID: BATCH_A }, 201));
    await settle();
    expect(service.getState().operation.phase).toBe('done');
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('two quotes that both see the funds still buy once', async () => {
    // The timer's re-quote is slow; the payment confirmation starts a second
    // one that answers first. Whichever lands second must not buy again.
    const { service, api, getTransactionStatus } = setup();
    listBoughtBatchAsUsable(api);
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();

    let answerSlowQuote;
    api.getStorageQuote
      .mockReturnValueOnce(
        new Promise((resolve) => {
          answerSlowQuote = resolve;
        })
      )
      .mockResolvedValue(ok(funded()));
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);

    getTransactionStatus.mockResolvedValue({ status: 'confirmed' });
    service.trackFundingTx(TX_HASH);
    await settle();
    expect(api.buyStorage).toHaveBeenCalledTimes(1);

    answerSlowQuote(ok(funded()));
    await settle();
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
    expect(service.getState().operation.phase).toBe('done');
  });

  test('on 409 it waits, re-quotes and tries again', async () => {
    const { service, api } = setup();
    listBoughtBatchAsUsable(api);
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.buyStorage
      .mockResolvedValueOnce(fail(409, 'another on-chain operation is in progress'))
      .mockResolvedValueOnce(ok({ batchID: BATCH_A }, 201));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'quoting',
      notice: 'another on-chain operation is in progress',
    });

    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(api.getStorageQuote).toHaveBeenCalledTimes(2);
    expect(api.buyStorage).toHaveBeenCalledTimes(2);
    expect(service.getState().operation.phase).toBe('done');
  });

  test('a funds race sends it back to waiting for payment with the node’s message', async () => {
    const { service, api } = setup();
    api.getStorageQuote
      .mockResolvedValueOnce(ok(funded()))
      .mockResolvedValue(ok(quoteBody({ xdaiToSendWei: '120000000000000000' })));
    api.buyStorage.mockResolvedValue(
      fail(400, 'not enough xDAI: send 0.1200 more xDAI to your account, then try again')
    );

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'awaiting-funds',
      notice: 'not enough xDAI: send 0.1200 more xDAI to your account, then try again',
    });

    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(service.getState().operation).toMatchObject({
      phase: 'awaiting-funds',
      notice: null,
      quote: { send: { display: '0.12' } },
    });
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('after a timeout it looks for the new batch before calling it a failure', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.getStamps
      .mockResolvedValueOnce(ok({ stamps: [{ batchID: BATCH_A, usable: true }] }))
      .mockResolvedValue(
        ok({
          stamps: [
            { batchID: BATCH_A, usable: true },
            { batchID: BATCH_B, usable: true },
          ],
        })
      );
    api.buyStorage.mockResolvedValue(fail(504, 'chain transaction timed out'));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();

    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { batchId: BATCH_B },
    });
  });

  test('an unconfirmed buy fails as uncertain and is never retried on its own', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.getStamps.mockResolvedValue(ok({ stamps: [] }));
    api.buyStorage.mockResolvedValue({ ok: false, status: 0, data: null, timedOut: true });

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    const op = service.getState().operation;
    expect(op).toMatchObject({ phase: 'failed', uncertain: true });
    expect(op.error).toMatch(/may still go through/);

    await jest.advanceTimersByTimeAsync(REQUOTE_MS * 10);
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('a chain error fails with the node’s reason, in context', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.buyStorage.mockResolvedValue(fail(502, 'swap xDAI for xBZZ: transaction reverted: 0x0'));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'failed',
      uncertain: false,
      error: 'Buying storage failed on Gnosis Chain: swap xDAI for xBZZ: transaction reverted: 0x0',
    });
  });

  test('keeps quoting through chain init and says so', async () => {
    const { service, api } = setup();
    api.getStorageQuote
      .mockResolvedValueOnce(fail(503, 'chain init in progress; retry shortly'))
      .mockResolvedValue(ok(quoteBody()));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation).toMatchObject({ phase: 'quoting' });
    expect(service.getState().operation.notice).toMatch(/still connecting to Gnosis Chain/);

    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(service.getState().operation).toMatchObject({ phase: 'awaiting-funds', notice: null });
  });

  test('a node without the storage routes fails the purchase and stops offering it', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(fail(501, 'not implemented in ant'));
    api.getSettlementDeposit.mockResolvedValue(fail(501, 'not implemented in ant'));
    service.watch('test:card', true);
    await settle();
    expect(service.getState().account.storage).toBe('missing');
    expect(service.getState().canBuy).toBe(false);

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'failed',
      error: 'This Swarm node cannot buy storage with xDAI. It needs a newer version of Ant.',
    });
  });

  test('cancel stops the re-quoting', async () => {
    const { service, api } = setup();
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();

    expect(service.cancel()).toMatchObject({ ok: true });
    expect(service.getState().operation).toBeNull();
    await jest.advanceTimersByTimeAsync(REQUOTE_MS * 5);
    expect(api.getStorageQuote).toHaveBeenCalledTimes(1);
  });

  test('a cancel naming another operation leaves the current one alone', async () => {
    const { service } = setup();
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    const { id } = service.getState().operation;

    expect(service.cancel(id + 1)).toMatchObject({ ok: true });
    expect(service.getState().operation).toMatchObject({ id });
    expect(service.cancel(id)).toMatchObject({ ok: true });
    expect(service.getState().operation).toBeNull();
  });

  test('a window leaving a finished result drops it only once no other window shows it', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(fail(501, 'not implemented in ant'));
    api.getSettlementDeposit.mockResolvedValue(fail(501, 'not implemented in ant'));
    service.watch('1:publish-setup', true);
    service.watch('2:publish-setup', true);
    service.watch('2:node-card', true);
    await settle();
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    const { id } = service.getState().operation;
    expect(service.getState().operation.phase).toBe('failed');

    // Window 1 leaves (a tab switch): window 2 still has the failure up.
    service.watch('1:publish-setup', false);
    expect(service.dismiss(id, '1:')).toMatchObject({ ok: true });
    expect(service.getState().operation).toMatchObject({ id, phase: 'failed' });

    // Window 2 leaves too: nobody shows it any more. Its node card does not
    // count as showing the result.
    service.watch('2:publish-setup', false);
    expect(service.dismiss(id, '2:')).toMatchObject({ ok: true });
    expect(service.getState().operation).toBeNull();
  });

  async function failedWithTwoScreens() {
    const ctx = setup();
    ctx.api.getStorageQuote.mockResolvedValue(fail(501, 'not implemented in ant'));
    ctx.api.getSettlementDeposit.mockResolvedValue(fail(501, 'not implemented in ant'));
    ctx.service.watch('1:publish-setup', true);
    ctx.service.watch('2:publish-setup', true);
    await settle();
    ctx.service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(ctx.service.getState().operation.phase).toBe('failed');
    return { ...ctx, id: ctx.service.getState().operation.id };
  }

  test('a window that already left a result does not keep it alive by reopening', async () => {
    const { service, id } = await failedWithTwoScreens();
    // Window 1 leaves (deferred: window 2 shows it), then reopens the screen,
    // which hides the result it already left and never dismisses it again.
    service.watch('1:publish-setup', false);
    service.dismiss(id, '1:');
    service.watch('1:publish-setup', true);
    expect(service.getState().operation).toMatchObject({ id, phase: 'failed' });

    // Window 2 leaves: only window 1's screen is up, and it left the result.
    service.watch('2:publish-setup', false);
    service.dismiss(id, '2:');
    expect(service.getState().operation).toBeNull();
  });

  test('closing the last window showing a result another left drops it', async () => {
    const { service, id } = await failedWithTwoScreens();
    service.watch('1:publish-setup', false);
    service.dismiss(id, '1:');
    expect(service.getState().operation).toMatchObject({ id });

    // Window 2 closes with the result on screen: no dismissal ever comes.
    service.unwatchPrefix('2:');
    expect(service.getState().operation).toBeNull();
  });

  test('a result nobody has left yet survives its screens going away', async () => {
    const { service, id } = await failedWithTwoScreens();
    service.unwatchPrefix('1:');
    service.watch('2:publish-setup', false);
    expect(service.getState().operation).toMatchObject({ id, phase: 'failed' });
  });

  test('a dismissal never drops a running operation or another one', async () => {
    const { service } = setup();
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    const { id } = service.getState().operation;
    expect(service.getState().operation.phase).not.toMatch(/done|failed/);

    expect(service.dismiss(id, '1:')).toMatchObject({ ok: true });
    expect(service.dismiss(id + 1, '1:')).toMatchObject({ ok: true });
    expect(service.getState().operation).toMatchObject({ id });
  });

  test('refuses requests it cannot price', () => {
    const { service } = setup();
    expect(service.arm({ kind: 'buy', planId: 'huge' })).toEqual({
      ok: false,
      error: 'Unknown storage plan.',
    });
    expect(service.arm({ kind: 'extend', batchId: 'xyz', days: 30 })).toMatchObject({ ok: false });
    expect(service.arm({ kind: 'extend', batchId: BATCH_A, days: 0 })).toMatchObject({ ok: false });
    expect(service.arm({ kind: 'extend', batchId: BATCH_A, days: -1 })).toMatchObject({
      ok: false,
    });
    expect(service.arm({ kind: 'extend', batchId: BATCH_A, days: 0, depth: 3 })).toMatchObject({
      ok: false,
    });
    expect(service.arm({ kind: 'withdraw' })).toMatchObject({ ok: false });
    expect(service.getState().operation).toBeNull();
  });

  test('never spends from a node Freedom found already running', () => {
    const { service, api } = setup({ registryMode: 'reused' });
    expect(service.arm({ kind: 'buy', planId: 'starter' })).toMatchObject({ ok: false });
    expect(api.getStorageQuote).not.toHaveBeenCalled();
    expect(service.getState().canBuy).toBe(false);
  });
});

describe('confirming a bought batch', () => {
  // Bee's shape for a batch that exists but may not stamp yet.
  const pending = { batchID: BATCH_A, usable: false, exists: true, batchTTL: 2_592_000 };
  const usable = { batchID: BATCH_A, usable: true, exists: true, batchTTL: 2_592_000 };

  test('stays confirming until the node calls the new batch usable', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.getStamps.mockResolvedValue(ok({ stamps: [pending] }));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'confirming',
      result: { batchId: BATCH_A },
    });
    // Busy, not done: no second purchase, and the readiness says why.
    expect(service.arm({ kind: 'buy', planId: 'starter' })).toMatchObject({ ok: false });
    await expect(service.getPublishReadiness()).resolves.toMatchObject({
      ok: false,
      reason: 'node-not-ready',
      message: 'Your new storage is reaching the Swarm network. Publishing works in a moment.',
    });

    api.getStamps.mockResolvedValue(ok({ stamps: [usable] }));
    await jest.advanceTimersByTimeAsync(CONFIRM_POLL_MS);
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { batchId: BATCH_A },
    });
    expect(service.getState().operation.result.slow).toBeUndefined();
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('gives up waiting after the confirm window and says the network is slow', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.getStamps.mockResolvedValue(ok({ stamps: [pending] }));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    await jest.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + CONFIRM_POLL_MS);
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { batchId: BATCH_A, slow: true },
    });
  });

  test('a propagating batch lets publishing through while it reaches the network', async () => {
    // Ant v0.5.52+ takes uploads with such a batch and holds each push.
    const { service, api } = setup();
    api.getStamps.mockResolvedValue(ok({ stamps: [{ ...pending, propagating: true }] }));
    await expect(service.getPublishReadiness()).resolves.toEqual({
      ok: true,
      reason: null,
      message:
        'Your new storage is reaching the Swarm network. Uploads you start now finish once it arrives.',
    });
    expect(service.getState().readiness.key).toBe('storage-pending');
    expect(service.getState().stamps).toMatchObject({ usable: 0, pending: 1 });
  });

  test('a batch peers rejected asks for a plan at once', async () => {
    // Same shape as a fresh batch, but Ant says waiting won't help.
    const { service, api } = setup();
    api.getStamps.mockResolvedValue(ok({ stamps: [{ ...pending, propagating: false }] }));
    await expect(service.getPublishReadiness()).resolves.toEqual({
      ok: false,
      reason: 'no-usable-stamps',
      message: 'None of your storage can be used anymore. Buy a storage plan to publish.',
    });
    expect(service.getState().stamps).toMatchObject({ usable: 0, pending: 0, total: 1 });
  });

  test('a bought batch peers reject fails the purchase instead of holding the spinner', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.getStamps.mockResolvedValue(ok({ stamps: [{ ...pending, propagating: true }] }));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    expect(service.getState().operation.phase).toBe('confirming');

    api.getStamps.mockResolvedValue(ok({ stamps: [{ ...pending, propagating: false }] }));
    await jest.advanceTimersByTimeAsync(CONFIRM_POLL_MS);
    expect(service.getState().operation).toMatchObject({
      phase: 'failed',
      uncertain: false,
      error: expect.stringMatching(/did not accept it/),
    });
    // Not stuck for the confirm window: a new plan can be armed right away.
    expect(service.arm({ kind: 'buy', planId: 'starter' })).toMatchObject({ ok: true });
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('a batch not listed yet, or still without the flag, keeps confirming', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    api.getStamps.mockResolvedValue(ok({ stamps: [] }));

    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();
    await jest.advanceTimersByTimeAsync(CONFIRM_POLL_MS);
    api.getStamps.mockResolvedValue(ok({ stamps: [pending] }));
    await jest.advanceTimersByTimeAsync(CONFIRM_POLL_MS);
    expect(service.getState().operation.phase).toBe('confirming');
  });

  test('a node without the flag: the awaiting-confirmations shape is pending, and publishing is held back', async () => {
    const { service, api } = setup();
    api.getStamps.mockResolvedValue(ok({ stamps: [pending] }));
    await expect(service.getPublishReadiness()).resolves.toEqual({
      ok: false,
      reason: 'node-not-ready',
      message: 'Your new storage is reaching the Swarm network. Publishing works in a moment.',
    });
    expect(service.getState().readiness.key).toBe('storage-pending');
  });

  test('a batch that is gone or expired is not pending', async () => {
    const { service, api } = setup();
    api.getStamps.mockResolvedValue(
      ok({
        stamps: [
          { batchID: BATCH_A, usable: false, exists: false, batchTTL: -1 },
          { batchID: BATCH_B, usable: false, exists: true, batchTTL: 0 },
        ],
      })
    );
    await expect(service.getPublishReadiness()).resolves.toMatchObject({
      reason: 'no-usable-stamps',
    });
    expect(service.getState().stamps).toEqual({ known: true, usable: 0, pending: 0, total: 2 });
  });
});

describe('extend and deposit', () => {
  test('extends by days, and resizes with a depth, passing the quoted amount', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockResolvedValue(
      ok(funded({ amountPerChunk: '99', settlementDepositPlur: '0' }))
    );

    service.arm({ kind: 'extend', batchId: `0x${BATCH_A.toUpperCase()}`, days: 90 });
    await settle();
    expect(api.getStorageQuote).toHaveBeenLastCalledWith({
      batchId: BATCH_A,
      days: 90,
      depth: undefined,
    });
    expect(api.extendStorage).toHaveBeenLastCalledWith({
      batchId: BATCH_A,
      amountPerChunk: '99',
      depth: undefined,
    });
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { batchId: BATCH_A },
    });

    service.arm({ kind: 'extend', batchId: BATCH_A, days: 0, depth: 22 });
    await settle();
    expect(api.getStorageQuote).toHaveBeenLastCalledWith({ batchId: BATCH_A, days: 0, depth: 22 });
    expect(api.extendStorage).toHaveBeenLastCalledWith({
      batchId: BATCH_A,
      amountPerChunk: '99',
      depth: 22,
    });
  });

  test('tops up the deposit only when it is short, once the xDAI is there', async () => {
    const { service, api } = setup();
    api.getSettlementDeposit.mockResolvedValue(ok(depositBody()));

    service.arm({ kind: 'deposit' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'awaiting-funds',
      quote: { send: { display: '0.02' }, depositXbzz: '0.001' },
    });
    expect(api.topUpSettlementDeposit).not.toHaveBeenCalled();

    api.getSettlementDeposit.mockResolvedValue(ok(depositBody({ sufficientFunds: true })));
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(api.topUpSettlementDeposit).toHaveBeenCalledTimes(1);
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { deposit: true },
    });
  });

  test('a full deposit needs nothing; a missing or unmanaged chequebook is explained', async () => {
    const { service, api } = setup();
    service.arm({ kind: 'deposit' });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { deposit: true, alreadyFull: true },
    });

    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ chequebook: null, needsTopUp: false }))
    );
    service.arm({ kind: 'deposit' });
    await settle();
    expect(service.getState().operation.error).toMatch(/first storage purchase creates/);

    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ managed: false, needsTopUp: false }))
    );
    service.arm({ kind: 'deposit' });
    await settle();
    expect(service.getState().operation.error).toMatch(/its own configuration/);
    expect(api.topUpSettlementDeposit).not.toHaveBeenCalled();
  });
});

describe('a deposit of a chosen amount (freedom-hq/ant#126)', () => {
  const AMOUNT = '1000000000000000'; // 0.1 xBZZ
  const SHORT = 'not enough xDAI: send 0.1201 more xDAI to your account, then try again';
  const withSettlement = (api) =>
    api.getNode.mockResolvedValue(
      ok({ beeMode: 'light', settlement: { supported: true, swapSwitch: true } })
    );

  test('the node prices it by refusing, the pay step asks for that, and it deposits once paid', async () => {
    const { service, api } = setup();
    withSettlement(api);
    // A full deposit is no reason to skip an amount the user asked for.
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, shortfallPlur: '0', walletXdaiWei: '0' }))
    );
    api.topUpSettlementDeposit.mockResolvedValue(fail(400, SHORT));

    service.arm({ kind: 'deposit', amountPlur: AMOUNT });
    await settle();
    expect(api.topUpSettlementDeposit).toHaveBeenCalledTimes(1);
    expect(api.topUpSettlementDeposit).toHaveBeenLastCalledWith({ amountPlur: AMOUNT });
    expect(service.getState().operation).toMatchObject({
      phase: 'awaiting-funds',
      request: { kind: 'deposit', amountPlur: AMOUNT, walletXdaiWei: '0' },
      notice: null,
      quote: {
        walletAddress: WALLET,
        send: { display: '0.13', wei: '130000000000000000' },
        depositXbzz: '0.1',
        sufficientFunds: false,
      },
    });

    // Not enough arrived yet: no second write.
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, walletXdaiWei: '120000000000000000' }))
    );
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(api.topUpSettlementDeposit).toHaveBeenCalledTimes(1);
    expect(service.getState().operation.quote.send.display).toBe('0.01');

    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, walletXdaiWei: '130000000000000000' }))
    );
    api.topUpSettlementDeposit.mockResolvedValue(ok(depositBody({ needsTopUp: false })));
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(api.topUpSettlementDeposit).toHaveBeenCalledTimes(2);
    expect(api.topUpSettlementDeposit).toHaveBeenLastCalledWith({ amountPlur: AMOUNT });
    expect(service.getState().operation).toMatchObject({
      phase: 'done',
      result: { deposit: true },
    });
  });

  test('a node that already holds the xDAI deposits at once, once the user saw that balance', async () => {
    const { service, api } = setup();
    withSettlement(api);
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, walletXdaiWei: '900000000000000000' }))
    );
    service.arm({ kind: 'deposit', amountPlur: AMOUNT, walletXdaiWei: '900000000000000000' });
    await settle();
    expect(api.topUpSettlementDeposit).toHaveBeenCalledTimes(1);
    expect(service.getState().operation.phase).toBe('done');
  });

  test('never lets the node swap wallet xDAI the deposit screen did not show', async () => {
    const { service, api } = setup();
    withSettlement(api);
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, walletXdaiWei: '900000000000000000' }))
    );
    // No balance shown (an older screen, or a wallet read as empty)…
    service.arm({ kind: 'deposit', amountPlur: AMOUNT });
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'failed',
      error: expect.stringMatching(/more xDAI than when you chose/),
    });
    // …or a smaller one than the wallet holds now: nothing is sent either.
    service.arm({ kind: 'deposit', amountPlur: AMOUNT, walletXdaiWei: '100000000000000000' });
    await settle();
    expect(service.getState().operation.phase).toBe('failed');
    expect(api.topUpSettlementDeposit).not.toHaveBeenCalled();
  });

  test('a wallet that grew after the price was known pays without asking again', async () => {
    const { service, api } = setup();
    withSettlement(api);
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, walletXdaiWei: '0' }))
    );
    api.topUpSettlementDeposit.mockResolvedValue(fail(400, SHORT));
    service.arm({ kind: 'deposit', amountPlur: AMOUNT, walletXdaiWei: '0' });
    await settle();
    expect(service.getState().operation.phase).toBe('awaiting-funds');
    // The user paid the figure the pay step showed (and a little more).
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ needsTopUp: false, walletXdaiWei: '200000000000000000' }))
    );
    api.topUpSettlementDeposit.mockResolvedValue(ok(depositBody({ needsTopUp: false })));
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(api.topUpSettlementDeposit).toHaveBeenCalledTimes(2);
    expect(service.getState().operation.phase).toBe('done');
  });

  test('the wallet balance the screen showed must be a wei integer', () => {
    const { service } = setup();
    for (const walletXdaiWei of ['-1', '1.5', 'abc', '01', 5]) {
      expect(service.arm({ kind: 'deposit', amountPlur: AMOUNT, walletXdaiWei }).ok).toBe(false);
    }
    expect(service.arm({ kind: 'deposit', amountPlur: AMOUNT, walletXdaiWei: '0' }).ok).toBe(true);
  });

  test('an Ant from before #126 would ignore the amount, so nothing is sent', async () => {
    const { service, api } = setup();
    // createApi's /node has no `settlement` object: v0.5.56 and older.
    service.arm({ kind: 'deposit', amountPlur: AMOUNT });
    await settle();
    expect(service.getState().operation).toMatchObject({ phase: 'failed' });
    expect(service.getState().operation.error).toMatch(/default target/);
    expect(api.topUpSettlementDeposit).not.toHaveBeenCalled();
  });

  test('keeps the deposit route’s guards: no chequebook, unmanaged', async () => {
    const { service, api } = setup();
    withSettlement(api);
    api.getSettlementDeposit.mockResolvedValue(ok(depositBody({ chequebook: null })));
    service.arm({ kind: 'deposit', amountPlur: AMOUNT });
    await settle();
    expect(service.getState().operation.error).toMatch(/first storage purchase creates/);

    api.getSettlementDeposit.mockResolvedValue(ok(depositBody({ managed: false })));
    service.arm({ kind: 'deposit', amountPlur: AMOUNT });
    await settle();
    expect(service.getState().operation.error).toMatch(/its own configuration/);
    expect(api.topUpSettlementDeposit).not.toHaveBeenCalled();
  });

  test('a refusal without a figure fails rather than guessing', async () => {
    const { service, api } = setup();
    withSettlement(api);
    api.topUpSettlementDeposit.mockResolvedValue(fail(400, 'not enough xDAI'));
    service.arm({ kind: 'deposit', amountPlur: AMOUNT });
    await settle();
    expect(service.getState().operation).toMatchObject({ phase: 'failed', error: 'not enough xDAI' });
  });

  test('an amount out of range or not a PLUR integer is refused before anything runs', () => {
    const { service, api } = setup();
    for (const amountPlur of ['0', '-1', '1.5', 'abc', '01000000000000000', 1e15, '9999999999999']) {
      expect(service.arm({ kind: 'deposit', amountPlur })).toEqual({
        ok: false,
        error: expect.stringMatching(/between 0\.001 and 10 xBZZ/),
      });
    }
    expect(service.arm({ kind: 'deposit', amountPlur: '100000000000000001' }).ok).toBe(false);
    expect(parseDepositAmount('10000000000000')).toBe('10000000000000');
    expect(parseDepositAmount('100000000000000000')).toBe('100000000000000000');
    expect(api.getSettlementDeposit).not.toHaveBeenCalled();
  });

  test('reads the shortfall antd names', () => {
    expect(parseXdaiShortfall(SHORT)).toBe(120_100_000_000_000_000n);
    expect(parseXdaiShortfall('not enough xDAI: send 2 more xDAI')).toBe(2n * 10n ** 18n);
    expect(parseXdaiShortfall('not enough xDAI')).toBeNull();
    expect(parseXdaiShortfall('send 0.0000 more xDAI')).toBeNull();
    expect(parseXdaiShortfall(null)).toBeNull();
  });
});

describe('the payment from the Freedom wallet', () => {
  test('a confirmed payment re-quotes at once instead of waiting for the next tick', async () => {
    const { service, api, getTransactionStatus } = setup();
    listBoughtBatchAsUsable(api);
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();

    expect(service.trackFundingTx(TX_HASH)).toEqual({ ok: true });
    expect(service.getState().operation.fundingTx).toEqual({ hash: TX_HASH, status: 'pending' });
    await settle();
    expect(getTransactionStatus).toHaveBeenCalledWith(TX_HASH, 100);

    getTransactionStatus.mockResolvedValue({ status: 'confirmed' });
    api.getStorageQuote.mockResolvedValue(ok(funded()));
    await jest.advanceTimersByTimeAsync(FUNDING_TX_POLL_MS);

    expect(service.getState().operation.phase).toBe('done');
    expect(api.buyStorage).toHaveBeenCalledTimes(1);
  });

  test('a reverted payment is reported, and the purchase stays armed', async () => {
    const { service, getTransactionStatus } = setup();
    getTransactionStatus.mockResolvedValue({ status: 'failed' });
    service.arm({ kind: 'buy', planId: 'starter' });
    await settle();

    service.trackFundingTx(TX_HASH);
    await settle();
    expect(service.getState().operation).toMatchObject({
      phase: 'awaiting-funds',
      fundingTx: { status: 'failed' },
    });
    expect(service.getState().operation.notice).toMatch(/failed on Gnosis Chain/);

    // The next quote keeps the payment failure on screen.
    await jest.advanceTimersByTimeAsync(REQUOTE_MS);
    expect(service.getState().operation.notice).toMatch(/failed on Gnosis Chain/);
  });

  test('ignores a hash without an armed purchase or in the wrong shape', () => {
    const { service } = setup();
    expect(service.trackFundingTx(TX_HASH)).toEqual({ ok: false });
    service.arm({ kind: 'buy', planId: 'starter' });
    expect(service.trackFundingTx('0x123')).toMatchObject({ ok: false });
  });
});

describe('watching and the account snapshot', () => {
  test('polls the chain-backed account only while a surface watches', async () => {
    const { service, api } = setup();
    api.getSettlementDeposit.mockResolvedValue(
      ok(depositBody({ walletXdaiWei: '250000000000000000' }))
    );
    api.getStamps.mockResolvedValue(ok({ stamps: [{ usable: true }] }));

    await settle();
    expect(api.getSettlementDeposit).not.toHaveBeenCalled();

    service.watch('1:node-card', true);
    await settle();
    expect(api.getSettlementDeposit).toHaveBeenCalledTimes(1);
    expect(service.getState().account).toEqual({
      storage: 'available',
      walletAddress: WALLET,
      xdai: '0.25',
      xdaiWei: '250000000000000000',
      bzz: '0',
      chequebook: {
        address: CHEQUEBOOK,
        deposit: '0',
        target: '0.001',
        needsTopUp: true,
        managed: true,
      },
    });

    await jest.advanceTimersByTimeAsync(WATCH_REFRESH_MS);
    expect(api.getSettlementDeposit).toHaveBeenCalledTimes(2);

    service.unwatchPrefix('1:');
    await jest.advanceTimersByTimeAsync(WATCH_REFRESH_MS * 4);
    expect(api.getSettlementDeposit).toHaveBeenCalledTimes(2);
  });

  test('reads balances through the Bee API on a node without the storage routes', async () => {
    const { service, api } = setup();
    api.getSettlementDeposit.mockResolvedValue(fail(404, 'Not Found'));
    service.watch('1:node-card', true);
    await settle();

    expect(service.getState().account).toEqual({
      storage: 'missing',
      walletAddress: WALLET,
      xdai: '0.25',
      xdaiWei: '250000000000000000',
      bzz: '0.5',
      chequebook: {
        address: CHEQUEBOOK,
        deposit: '0.001',
        target: null,
        needsTopUp: false,
        managed: null,
      },
    });
  });

  test('forgets the node’s snapshot when it stops, and broadcasts only real changes', async () => {
    const { service, node, published } = setup();
    service.watch('1:node-card', true);
    await settle();
    expect(service.getState().account).not.toBeNull();

    const before = published.length;
    service.handleNodeStatus();
    expect(published).toHaveLength(before);

    node.status = 'stopped';
    service.handleNodeStatus();
    expect(published).toHaveLength(before + 1);
    expect(service.getState()).toMatchObject({
      account: null,
      readiness: { key: 'stopped' },
      stamps: { known: false },
    });
  });
});

describe('restart', () => {
  test('restarts the node once, from main, and reports a failure', async () => {
    const { service, restartNode } = setup({ status: 'error', error: 'Health check failed' });

    const first = service.restartNode();
    await expect(service.restartNode()).resolves.toMatchObject({ ok: false });
    await expect(first).resolves.toEqual({ ok: true, error: null });
    expect(restartNode).toHaveBeenCalledTimes(1);

    restartNode.mockRejectedValueOnce(new Error('port in use'));
    await expect(service.restartNode()).resolves.toEqual({ ok: false, error: 'port in use' });
    expect(service.getState().restart).toEqual({ inProgress: false, error: 'port in use' });
  });

  test('leaves nodes it does not manage alone', async () => {
    const { service, restartNode } = setup({ registryMode: 'reused' });
    await expect(service.restartNode()).resolves.toMatchObject({ ok: false });
    expect(restartNode).not.toHaveBeenCalled();
  });
});

describe('pickers', () => {
  test('prices every plan', async () => {
    const { service, api } = setup();
    api.getStorageQuote.mockImplementation(async ({ depth }) =>
      depth === 22 ? fail(502, 'rpc error') : ok(quoteBody({ depth }))
    );

    const { plans } = await service.getPlans();
    expect(api.getStorageQuote.mock.calls.map(([args]) => args)).toEqual(
      PLANS.map(({ depth, days }) => ({ depth, days }))
    );
    expect(plans.map((p) => [p.id, p.quote?.price.display ?? null])).toEqual([
      ['starter', '0.45'],
      ['advanced', '0.45'],
      ['plus', null],
    ]);
    expect(plans[2].error).toBe('Getting a price failed on Gnosis Chain: rpc error');
  });

  test('offers only sizes above the batch’s depth, keeping its expiry', async () => {
    const { service, api } = setup();
    const { durations, sizes } = await service.getExtendOptions(BATCH_A, 21);

    expect(durations.map((d) => d.days)).toEqual([30, 90, 180, 365]);
    expect(sizes.map((s) => s.depth)).toEqual([22]);
    expect(api.getStorageQuote).toHaveBeenCalledWith({ batchId: BATCH_A, days: 0, depth: 22 });
    expect(durations[0].quote).toMatchObject({ price: { display: '0.45' } });

    await expect(service.getExtendOptions('nope', 20)).resolves.toMatchObject({
      durations: [],
      sizes: [],
    });
  });
});

describe('registerPublishSetupIpc', () => {
  const path = require('path');
  const { pathToFileURL } = require('url');
  const RENDERER = path.resolve(__dirname, '..', '..', 'renderer');

  const statusListeners = [];
  const antManager = {
    getStatus: jest.fn(() => ({ status: 'stopped', error: null })),
    onStatusChange: jest.fn((listener) => statusListeners.push(listener)),
    stopAnt: jest.fn().mockResolvedValue(),
    startAnt: jest.fn().mockResolvedValue(),
  };

  // One app instance for the block, as in main: the service is a lazy
  // singleton wired to ant-manager when its IPC is registered.
  beforeAll(() => {
    mockIpcHandlers.clear();
    jest.isolateModules(() => {
      jest.doMock('../ant-manager', () => antManager);
      jest.doMock('../service-registry', () => ({
        getRegistry: () => ({ ant: { mode: 'bundled' } }),
        getAntApiUrl: () => null,
      }));
      jest.doMock('../wallet/transaction-service', () => ({ getTransactionStatus: jest.fn() }));
      require('./publish-setup-service').registerPublishSetupIpc();
    });
  });

  beforeEach(() => {
    mockWebContents.length = 0;
  });

  const contents = (url) => ({
    getURL: () => url,
    send: jest.fn(),
  });

  test('registers the setup channels and follows the node', async () => {
    expect([...mockIpcHandlers.keys()].sort()).toEqual(
      [
        'swarm:setup-arm',
        'swarm:setup-cancel',
        'swarm:setup-get-extend-options',
        'swarm:setup-get-plans',
        'swarm:setup-get-state',
        'swarm:setup-restart-node',
        'swarm:setup-track-funding-tx',
        'swarm:setup-watch',
      ].sort()
    );
    expect(statusListeners).toHaveLength(1);

    await expect(mockIpcHandlers.get('swarm:setup-get-state')()).resolves.toMatchObject({
      readiness: { key: 'stopped' },
    });
    await mockIpcHandlers.get('swarm:setup-restart-node')();
    expect(antManager.stopAnt).toHaveBeenCalledTimes(1);
    expect(antManager.startAnt).toHaveBeenCalledTimes(1);
  });

  test('pushes state to the chrome and internal pages, never to a web page', () => {
    const chrome = contents(pathToFileURL(path.join(RENDERER, 'index.html')).href);
    const settings = contents(pathToFileURL(path.join(RENDERER, 'pages', 'settings.html')).href);
    const page = contents('https://example.com/');
    const lookalike = contents('file:///tmp/pages/settings.html');
    mockWebContents.push(chrome, settings, page, lookalike);

    antManager.getStatus.mockReturnValue({ status: 'error', error: 'Startup timed out' });
    statusListeners[0]({ status: 'error', error: 'Startup timed out' });

    expect(chrome.send).toHaveBeenCalledWith(
      'swarm:setup-state',
      expect.objectContaining({ readiness: expect.objectContaining({ key: 'error' }) })
    );
    expect(settings.send).toHaveBeenCalledTimes(1);
    expect(page.send).not.toHaveBeenCalled();
    expect(lookalike.send).not.toHaveBeenCalled();
  });

  test('setup-cancel with { dismiss: true } is a dismissal, not a cancel', () => {
    const cancel = mockIpcHandlers.get('swarm:setup-cancel');
    const armed = mockIpcHandlers.get('swarm:setup-arm')({}, { kind: 'buy', planId: 'starter' });
    expect(armed).toMatchObject({ ok: true });
    const { id } = armed.state.operation;

    // A dismissal never drops a purchase that is still running…
    expect(cancel({ sender: { id: 3 } }, id, { dismiss: true })).toMatchObject({
      ok: true,
      state: { operation: { id } },
    });
    expect(cancel({ sender: { id: 3 } }, 'x', { dismiss: true })).toMatchObject({
      state: { operation: { id } },
    });
    // …while a cancel does.
    expect(cancel({ sender: { id: 3 } }, id)).toMatchObject({
      ok: true,
      state: { operation: null },
    });
  });

  test('drops a closed window’s watches', async () => {
    const destroyed = [];
    const sender = { id: 7, once: jest.fn((event, cb) => destroyed.push([event, cb])) };

    await mockIpcHandlers.get('swarm:setup-watch')({ sender }, 'node-card', true);
    await mockIpcHandlers.get('swarm:setup-watch')({ sender }, 'storage', true);
    expect(sender.once).toHaveBeenCalledTimes(1);
    expect(destroyed[0][0]).toBe('destroyed');
    destroyed[0][1]();

    // Watching again after the window went away registers a new cleanup.
    await mockIpcHandlers.get('swarm:setup-watch')({ sender }, 'node-card', true);
    expect(sender.once).toHaveBeenCalledTimes(2);
  });
});
