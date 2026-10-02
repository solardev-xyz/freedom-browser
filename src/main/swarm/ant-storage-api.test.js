const mockGetAntApiUrl = jest.fn();
jest.mock('../service-registry', () => ({ getAntApiUrl: () => mockGetAntApiUrl() }));

const api = require('./ant-storage-api');

const respond = (body, status = 200) =>
  jest
    .fn()
    .mockResolvedValue(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
    );

beforeEach(() => {
  mockGetAntApiUrl.mockReset().mockReturnValue('http://127.0.0.1:11633/');
});

describe('antRequest', () => {
  test('resolves the body, status and the node’s message', async () => {
    const fetchImpl = respond(
      { code: 400, message: 'not enough xDAI: send 0.1200 more xDAI' },
      400
    );
    await expect(api.getStorageQuote({ depth: 20, days: 30 }, { fetchImpl })).resolves.toEqual({
      ok: false,
      status: 400,
      data: { code: 400, message: 'not enough xDAI: send 0.1200 more xDAI' },
      message: 'not enough xDAI: send 0.1200 more xDAI',
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://127.0.0.1:11633/v0/storage/quote?depth=20&days=30'
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      signal: expect.any(AbortSignal),
    });
  });

  test('never sends without a node URL, and says so', async () => {
    mockGetAntApiUrl.mockReturnValue(null);
    const fetchImpl = jest.fn();
    await expect(
      api.buyStorage({ depth: 20, amountPerChunk: '1' }, { fetchImpl })
    ).resolves.toMatchObject({
      ok: false,
      status: 0,
      notSent: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('tells a timeout from a refused connection', async () => {
    const timeout = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    await expect(
      api.getHealth({ fetchImpl: jest.fn().mockRejectedValue(timeout) })
    ).resolves.toMatchObject({ status: 0, timedOut: true, unreachable: false });
    await expect(
      api.getHealth({ fetchImpl: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) })
    ).resolves.toMatchObject({ status: 0, timedOut: false, unreachable: true });
  });

  test('a refused connection never delivered the request; a reset mid-request may have', async () => {
    // undici's shape: TypeError('fetch failed') with the socket error as cause.
    const failed = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code } });
    const refused = await api.buyStorage(
      { depth: 20, amountPerChunk: '1' },
      { fetchImpl: jest.fn().mockRejectedValue(failed('ECONNREFUSED')) }
    );
    expect(refused).toMatchObject({ status: 0, unreachable: true, refused: true });
    expect(api.isUncertainWrite(refused)).toBe(false);
    expect(api.describeAntError(refused)).toBe('Cannot reach the Swarm node.');

    const reset = await api.buyStorage(
      { depth: 20, amountPerChunk: '1' },
      { fetchImpl: jest.fn().mockRejectedValue(failed('ECONNRESET')) }
    );
    expect(reset).toMatchObject({ status: 0, unreachable: true, refused: false });
    expect(api.isUncertainWrite(reset)).toBe(true);
  });

  test('keeps a non-JSON body out of `data`', async () => {
    await expect(api.getNode({ fetchImpl: respond('<html>', 502) })).resolves.toEqual({
      ok: false,
      status: 502,
      data: null,
      message: null,
    });
  });
});

describe('storage routes', () => {
  test('buys immutable batches unless told otherwise', async () => {
    const fetchImpl = respond({ batchID: 'ab' }, 201);
    await api.buyStorage({ depth: 20, amountPerChunk: '65676' }, { fetchImpl });
    await api.buyStorage({ depth: 20, amountPerChunk: '65676', immutable: false }, { fetchImpl });
    expect(fetchImpl.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      [
        'POST',
        'http://127.0.0.1:11633/v0/storage/buy?depth=20&amountPerChunk=65676&immutable=true',
      ],
      [
        'POST',
        'http://127.0.0.1:11633/v0/storage/buy?depth=20&amountPerChunk=65676&immutable=false',
      ],
    ]);
  });

  test('extends by time, or resizes when given a depth', async () => {
    const fetchImpl = respond({ batchID: 'ab' });
    await api.extendStorage({ batchId: 'ab', amountPerChunk: '9' }, { fetchImpl });
    await api.extendStorage({ batchId: 'ab', amountPerChunk: '9', depth: 22 }, { fetchImpl });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:11633/v0/storage/extend?batchId=ab&amountPerChunk=9',
      'http://127.0.0.1:11633/v0/storage/extend?batchId=ab&amountPerChunk=9&depth=22',
    ]);
  });

  test('prices an extension against the batch', async () => {
    const fetchImpl = respond({});
    await api.getStorageQuote({ batchId: 'ab', days: 0, depth: 22 }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'http://127.0.0.1:11633/v0/storage/quote?batchId=ab&depth=22&days=0'
    );
  });

  test('reads and tops up the settlement deposit', async () => {
    const fetchImpl = respond({ needsTopUp: false });
    await api.getSettlementDeposit({ fetchImpl });
    await api.topUpSettlementDeposit({ fetchImpl });
    expect(fetchImpl.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ['GET', 'http://127.0.0.1:11633/v0/settlement/deposit'],
      ['POST', 'http://127.0.0.1:11633/v0/settlement/deposit'],
    ]);
  });
});

describe('classifying failures', () => {
  const res = (status, message = null, extra = {}) => ({
    ok: false,
    status,
    data: null,
    message,
    ...extra,
  });

  test('a node without the routes: Bee’s 404 and an older Ant’s fallback 501', () => {
    expect(api.isStorageRouteMissing(res(404, 'Not Found'))).toBe(true);
    expect(api.isStorageRouteMissing(res(404))).toBe(true);
    // The quote route itself, for a batch that is gone: the routes exist.
    expect(api.isStorageRouteMissing(res(404, 'batch not found on chain'))).toBe(false);
    expect(api.isStorageRouteMissing(res(405))).toBe(true);
    expect(api.isStorageRouteMissing(res(501, 'not implemented in ant'))).toBe(true);
    expect(
      api.isStorageRouteMissing(
        res(501, 'on-chain writes require a configured wallet key + RPC endpoint')
      )
    ).toBe(false);
    expect(api.isStorageRouteMissing({ ok: true, status: 200 })).toBe(false);
  });

  test('an upload refused because peers have not synced the batch yet', () => {
    expect(
      api.isBatchNotYetKnownError(
        'Unprocessable Entity: {"code":422,"message":"push chunk failed: pushsync: postage batch 0xb8be73e4475fe3166d58a935d31bcfae417e6265143ba037cd271e89430b6ab1 rejected by 2 peer(s) as not found on-chain (peer said: invalid stamp: batchstore get: get batch b8be73e4475fe3166d58a935d31bcfae417e6265143ba037cd271e89430b6ab1: storage: not found, not found)"}'
      )
    ).toBe(true);
    expect(api.isBatchNotYetKnownError('pushsync: no peers')).toBe(false);
    expect(api.isBatchNotYetKnownError(undefined)).toBe(false);
  });

  test('a write whose outcome is unknown', () => {
    expect(api.isUncertainWrite(res(504, 'chain transaction timed out'))).toBe(true);
    expect(api.isUncertainWrite(res(0, null, { timedOut: true }))).toBe(true);
    expect(api.isUncertainWrite(res(0, null, { unreachable: true }))).toBe(true);
    expect(api.isUncertainWrite(res(0, null, { notSent: true }))).toBe(false);
    expect(api.isUncertainWrite(res(0, null, { unreachable: true, refused: true }))).toBe(false);
    expect(api.isUncertainWrite(res(502, 'reverted'))).toBe(false);
    expect(api.isUncertainWrite(res(409, 'busy'))).toBe(false);
  });

  test.each([
    [
      res(400, 'not enough xDAI: send 0.1200 more xDAI to your account, then try again'),
      'not enough xDAI: send 0.1200 more xDAI to your account, then try again',
    ],
    [
      res(409, 'another on-chain operation is in progress'),
      'another on-chain operation is in progress',
    ],
    [
      res(503, 'chain init in progress; retry shortly'),
      'The Swarm node is still connecting to Gnosis Chain. This can take a few minutes after it starts.',
    ],
    [
      res(501, 'on-chain writes require a configured wallet key + RPC endpoint'),
      'The Swarm node cannot send transactions: it has no Gnosis Chain connection or no wallet key.',
    ],
    [
      res(501, 'not implemented in ant'),
      'This Swarm node cannot buy storage with xDAI. It needs a newer version of Ant.',
    ],
    [
      res(502, 'swap xDAI for xBZZ: transaction reverted: 0x0'),
      'Buying storage failed on Gnosis Chain: swap xDAI for xBZZ: transaction reverted: 0x0',
    ],
    [
      res(504, 'chain transaction timed out'),
      'Gnosis Chain did not confirm the transaction in time. It may still go through.',
    ],
    [res(404, 'batch not found on chain'), 'Buying storage failed: batch not found on chain.'],
    [res(500), 'Buying storage failed (HTTP 500).'],
    [res(0, null, { notSent: true }), 'The Swarm node is not running.'],
    [res(0, null, { timedOut: true }), 'The Swarm node did not answer in time.'],
    [res(0, null, { unreachable: true }), 'Cannot reach the Swarm node.'],
  ])('describes %j for the user', (response, message) => {
    expect(api.describeAntError(response, 'Buying storage')).toBe(message);
  });
});
