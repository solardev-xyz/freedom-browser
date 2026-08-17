const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
};
const mockMyotis = {
  NETWORKS: new Map([[1, {}], [100, {}]]),
  isReady: jest.fn(),
  getStatus: jest.fn(),
  getAccount: jest.fn(),
  ethCall: jest.fn(),
  estimateGas: jest.fn(),
  feeEstimate: jest.fn(),
  sendRawTransaction: jest.fn(),
};
const mockRequestViaColibri = jest.fn();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

jest.mock('./network-registry', () => mockRegistry);
jest.mock('../myotis/myotis-manager', () => mockMyotis);
jest.mock('../ens/colibri-resolver', () => ({
  requestViaColibri: (...args) => mockRequestViaColibri(...args),
}));
jest.mock('../logger', () => ({ verbose: jest.fn() }));

const {
  request,
  getFeeQuote,
  broadcastRawTransaction,
  clearAdaptiveRoutingForTest,
} = require('./chain-data-router');
const originalFetch = global.fetch;

describe('chain-data-router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAdaptiveRoutingForTest();
    mockRegistry.getNetwork.mockReturnValue({
      access: {
        readOrder: ['myotis', 'colibri', 'direct'],
        broadcastOrder: ['myotis', 'direct'],
      },
      quorum: { k: 3, m: 2, timeoutMs: 1000 },
    });
    mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
      role === 'prover' ? ['https://prover.example'] : ['https://rpc.example']
    );
    mockMyotis.isReady.mockReturnValue(true);
    mockMyotis.getStatus.mockReturnValue({ optimisticBlockNumber: 25_684_159 });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
  });

  test('serves account balances from the matching Myotis chain', async () => {
    mockMyotis.getAccount.mockResolvedValue({ status: 'ok', balanceWei: '42', nonce: 3 });

    await expect(request(100, 'eth_getBalance', ['0xabc', 'latest'])).resolves.toEqual({
      result: '0x2a',
      source: 'myotis',
      verified: true,
    });
    expect(mockMyotis.getAccount).toHaveBeenCalledWith('0xabc', 100);
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  test('sends pending nonce reads to a source that honours the block tag', async () => {
    mockMyotis.getAccount.mockResolvedValue({ status: 'ok', nonce: 3 });
    mockRequestViaColibri.mockResolvedValue('0x5');

    await expect(
      request(100, 'eth_getTransactionCount', ['0xabc', 'pending'])
    ).resolves.toEqual({
      result: '0x5',
      source: 'colibri',
      verified: true,
    });
    expect(mockMyotis.getAccount).not.toHaveBeenCalled();
    expect(mockRequestViaColibri).toHaveBeenCalledWith(100, 'eth_getTransactionCount', [
      '0xabc',
      'pending',
    ]);
  });

  test('sends historical balance reads to a source that honours the block tag', async () => {
    mockMyotis.getAccount.mockResolvedValue({ status: 'ok', balanceWei: '42' });
    mockRequestViaColibri.mockResolvedValue('0x1');

    await expect(request(100, 'eth_getBalance', ['0xabc', '0x1234'])).resolves.toMatchObject({
      result: '0x1',
      source: 'colibri',
    });
    expect(mockMyotis.getAccount).not.toHaveBeenCalled();
  });

  test('sends non-latest gas estimates to a source that honours the block tag', async () => {
    mockMyotis.estimateGas.mockResolvedValue({ gasLimit: '21000' });
    mockRequestViaColibri.mockResolvedValue('0x5208');

    await expect(
      request(100, 'eth_estimateGas', [{ to: '0xabc' }, 'pending'])
    ).resolves.toMatchObject({ source: 'colibri' });
    expect(mockMyotis.estimateGas).not.toHaveBeenCalled();
  });

  test('sends historical eth_call to a source that honours the block tag', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0xhead' });
    mockRequestViaColibri.mockResolvedValue('0xhistoric');

    await expect(
      request(100, 'eth_call', [{ to: '0xabc', data: '0x70a08231' }, '0x10d4f00'])
    ).resolves.toEqual({ result: '0xhistoric', source: 'colibri', verified: true });
    expect(mockMyotis.ethCall).not.toHaveBeenCalled();
  });

  test('sends eth_call state overrides to a source that can apply them', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0xhead' });
    mockRequestViaColibri.mockResolvedValue('0xsimulated');

    await expect(
      request(100, 'eth_call', [
        { to: '0xabc', data: '0x70a08231' },
        'latest',
        { '0xabc': { balance: '0x1' } },
      ])
    ).resolves.toMatchObject({ result: '0xsimulated', source: 'colibri' });
    expect(mockMyotis.ethCall).not.toHaveBeenCalled();
  });

  test('sends calls carrying gas/fee/nonce fields to a source that honours them', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0xhead' });
    mockMyotis.estimateGas.mockResolvedValue({ gasLimit: '21000' });
    mockRequestViaColibri.mockResolvedValue('0xcapped');

    await expect(
      request(100, 'eth_call', [{ to: '0xabc', data: '0x', gas: '0x5208' }, 'latest'])
    ).resolves.toMatchObject({ source: 'colibri' });
    await expect(
      request(100, 'eth_estimateGas', [{ to: '0xabc', maxFeePerGas: '0x1' }])
    ).resolves.toMatchObject({ source: 'colibri' });
    expect(mockMyotis.ethCall).not.toHaveBeenCalled();
    expect(mockMyotis.estimateGas).not.toHaveBeenCalled();
  });

  test('still serves a plain head-state eth_call from Myotis', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(100, 'eth_call', [{ to: '0xabc', data: '0x70a08231' }, 'latest'])
    ).resolves.toEqual({ result: '0x2a', source: 'myotis', verified: true });
    expect(mockMyotis.ethCall).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 100, to: '0xabc', block: 'latest' })
    );
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  test('includes source-specific trust evidence only when requested', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(
        1,
        'eth_call',
        [{ to: '0xabc', data: '0x70a08231' }, 'latest'],
        { includeTrust: true }
      )
    ).resolves.toEqual({
      result: '0x2a',
      source: 'myotis',
      verified: true,
      trust: {
        level: 'verified',
        method: 'myotis',
        finality: 'optimistic',
        proof: 'P2P light client (optimistic beacon root — attested, not finalized)',
        block: 25_684_159,
        agreed: ['myotis-p2p'],
        dissented: [],
        queried: ['myotis-p2p'],
        quorum: { k: 1, m: 1, achieved: true },
      },
    });
  });

  test('does not attach a sampled Myotis block when the verified head moved during the call', async () => {
    mockMyotis.getStatus
      .mockReturnValueOnce({ optimisticBlockNumber: 25_684_159 })
      .mockReturnValueOnce({ optimisticBlockNumber: 25_684_160 });
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0x2a' });

    const response = await request(
      1,
      'eth_call',
      [{ to: '0xabc', data: '0x70a08231' }, 'latest'],
      { includeTrust: true }
    );

    expect(response.trust.block).toBeNull();
  });

  test('falls through unsupported Myotis reads to the per-chain Colibri client', async () => {
    mockRequestViaColibri.mockResolvedValue('0x6000');

    await expect(request(100, 'eth_getCode', ['0xabc', 'latest'])).resolves.toEqual({
      result: '0x6000',
      source: 'colibri',
      verified: true,
    });
    expect(mockRequestViaColibri).toHaveBeenCalledWith(100, 'eth_getCode', [
      '0xabc',
      'latest',
    ]);
  });

  test('uses Myotis P2P transaction broadcast before RPC', async () => {
    mockMyotis.sendRawTransaction.mockResolvedValue({ txHash: '0x1234' });

    await expect(broadcastRawTransaction(100, '0xsigned')).resolves.toEqual({
      result: '0x1234',
      source: 'myotis',
    });
    expect(mockMyotis.sendRawTransaction).toHaveBeenCalledWith('0xsigned', 100);
  });

  test('uses one Myotis response for a complete fee quote', async () => {
    mockMyotis.feeEstimate.mockResolvedValue({
      gasPriceWei: '100',
      maxPriorityFeePerGasWei: '2',
    });

    await expect(getFeeQuote(100)).resolves.toEqual({
      type: 'eip1559',
      baseFee: '98',
      maxPriorityFeePerGas: '2',
      // 2x base fee + priority fee: headroom for a base fee that rises
      // between the quote and inclusion.
      maxFeePerGas: '198',
      effectiveGasPrice: '100',
      source: 'myotis',
      verified: true,
    });
    expect(mockMyotis.feeEstimate).toHaveBeenCalledTimes(1);
    expect(mockMyotis.feeEstimate).toHaveBeenCalledWith(100);
  });

  test('downgrades an inconsistent fee quote instead of signing invalid EIP-1559 fees', async () => {
    mockMyotis.feeEstimate.mockResolvedValue({
      gasPriceWei: '3727',
      maxPriorityFeePerGasWei: '1000000000',
    });

    await expect(getFeeQuote(100)).resolves.toEqual({
      type: 'legacy',
      gasPrice: '3727',
      effectiveGasPrice: '3727',
      source: 'myotis',
      verified: true,
    });
  });

  test('gets direct fee components from the same RPC endpoint', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['direct'] },
      quorum: { timeoutMs: 1000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://primary.example',
      'https://secondary.example',
    ]);
    global.fetch = jest.fn().mockImplementation(async (url, options) => {
      const { method } = JSON.parse(options.body);
      return {
        ok: true,
        json: async () => ({ result: method === 'eth_gasPrice' ? '0xebd' : '0x1' }),
        url,
      };
    });

    await expect(getFeeQuote(100)).resolves.toMatchObject({
      type: 'eip1559',
      baseFee: '3772',
      maxFeePerGas: '7545',
      maxPriorityFeePerGas: '1',
      effectiveGasPrice: '3773',
      source: 'direct',
    });
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://primary.example',
      'https://primary.example',
    ]);
  });

  test('keeps stateful dapp filters on one direct RPC endpoint', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xfilter' }),
    });

    await expect(request(1, 'eth_newFilter', [{ address: '0xabc' }])).resolves.toEqual({
      result: '0xfilter',
      source: 'direct',
      verified: false,
    });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('hex-encodes decimal call quantities so the quorum tier can serve them', async () => {
    mockMyotis.isReady.mockReturnValue(false);
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum', 'direct'] },
      quorum: { k: 2, m: 2, timeoutMs: 1000 },
    });
    mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
      role === 'prover' ? [] : ['https://a.example', 'https://b.example']
    );
    global.fetch = jest.fn().mockImplementation(async (_url, options) => {
      const { params } = JSON.parse(options.body);
      // A spec-compliant node rejects a decimal QUANTITY outright.
      if (!/^0x[0-9a-f]+$/.test(params[0].value)) {
        return {
          ok: true,
          json: async () => ({
            error: { code: -32602, message: 'invalid argument 0: hex string without 0x prefix' },
          }),
        };
      }
      return { ok: true, json: async () => ({ result: '0x5208' }) };
    });

    await expect(
      request(1, 'eth_estimateGas', [
        { from: '0xabc', to: '0xdef', value: '1000000000000000000' },
      ])
    ).resolves.toEqual({ result: '0x5208', source: 'quorum', verified: true });
    expect(
      global.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).params[0].value)
    ).toEqual(['0xde0b6b3a7640000', '0xde0b6b3a7640000']);
  });

  test('hex-encodes decimal quantities on eth_call as well', async () => {
    mockMyotis.isReady.mockReturnValue(false);
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['direct'] },
      quorum: { timeoutMs: 1000 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ result: '0x1' }) });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', value: '10', gas: '21000' }, 'latest'])
    ).resolves.toMatchObject({ result: '0x1', source: 'direct' });
    const [call, blockTag] = JSON.parse(global.fetch.mock.calls[0][1].body).params;
    expect(call).toEqual({ to: '0xabc', value: '0xa', gas: '0x5208' });
    expect(blockTag).toBe('latest');
  });

  test('keeps normalized call quantities usable by the Myotis estimator', async () => {
    mockMyotis.estimateGas.mockResolvedValue({ gasLimit: '21000' });

    await expect(
      request(100, 'eth_estimateGas', [{ to: '0xabc', value: '1000000000000000000' }])
    ).resolves.toMatchObject({ result: '0x5208', source: 'myotis' });
    expect(mockMyotis.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ value: '1000000000000000000' })
    );
  });

  test('executes the standardized "input" calldata alias on the Myotis path', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', input: '0x70a08231' }, 'latest'])
    ).resolves.toEqual({ result: '0x2a', source: 'myotis', verified: true });
    expect(mockMyotis.ethCall).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xabc', data: '0x70a08231' })
    );
  });

  test('estimates gas against the "input" calldata alias rather than an empty call', async () => {
    mockMyotis.estimateGas.mockResolvedValue({ gasLimit: '54000' });

    await expect(
      request(1, 'eth_estimateGas', [{ to: '0xabc', input: '0xa9059cbb' }])
    ).resolves.toMatchObject({ result: '0xd2f0', source: 'myotis' });
    expect(mockMyotis.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ to: '0xabc', data: '0xa9059cbb' })
    );
  });

  test('carries the "input" alias into the calldata every RPC tier reads', async () => {
    mockMyotis.isReady.mockReturnValue(false);
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['direct'] },
      quorum: { timeoutMs: 1000 },
    });
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ result: '0x1' }) });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', input: '0x70a08231' }, 'latest'])
    ).resolves.toMatchObject({ result: '0x1', source: 'direct' });
    const [call] = JSON.parse(global.fetch.mock.calls[0][1].body).params;
    expect(call).toEqual({ to: '0xabc', input: '0x70a08231', data: '0x70a08231' });
  });

  test('prefers "input" over an empty "data" placeholder', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', data: '0x', input: '0x70a08231' }, 'latest'])
    ).resolves.toMatchObject({ source: 'myotis' });
    expect(mockMyotis.ethCall).toHaveBeenCalledWith(
      expect.objectContaining({ data: '0x70a08231' })
    );
  });

  test('sends calls with conflicting data/input calldata to a source that can reject them', async () => {
    mockMyotis.ethCall.mockResolvedValue({ resultHex: '0xhead' });
    mockRequestViaColibri.mockResolvedValue('0xstrict');

    await expect(
      request(100, 'eth_call', [
        { to: '0xabc', data: '0x70a08231', input: '0xa9059cbb' },
        'latest',
      ])
    ).resolves.toMatchObject({ result: '0xstrict', source: 'colibri' });
    expect(mockMyotis.ethCall).not.toHaveBeenCalled();
  });

  test('falls back to direct RPC when Myotis is not ready', async () => {
    mockMyotis.isReady.mockReturnValue(false);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });

    await expect(broadcastRawTransaction(1, '0xsigned')).resolves.toEqual({
      result: '0xrpc',
      source: 'direct',
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://rpc.example',
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('preserves the final RPC error code and revert data for dapps', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['direct'] },
      quorum: { timeoutMs: 1000 },
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { code: 3, message: 'execution reverted', data: '0x08c379a0' },
      }),
    });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', data: '0xdeadbeef' }, 'latest'])
    ).rejects.toMatchObject({
      code: 3,
      message: 'execution reverted',
      data: '0x08c379a0',
    });
  });

  test('does not attempt Myotis for a custom chain with default access policy', async () => {
    mockRegistry.getNetwork.mockReturnValue({ access: {}, quorum: { timeoutMs: 1000 } });
    mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
      role === 'prover' ? [] : ['https://rpc.example']
    );
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0x6000' }),
    });

    await expect(request(777, 'eth_getCode', ['0xabc', 'latest'])).resolves.toMatchObject({
      result: '0x6000',
      source: 'direct',
    });
    expect(mockMyotis.isReady).not.toHaveBeenCalled();
  });

  test('falls through after two seconds and temporarily bypasses a timed-out Colibri route', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockRequestViaColibri.mockReturnValue(new Promise(() => {}));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const params = [{ to: '0xabc', data: '0x1234' }, 'latest'];
    const options = { routingContext: { origin: 'https://swap.example' } };

    const first = request(1, 'eth_call', params, options);
    await jest.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toMatchObject({ result: '0xrpc', source: 'direct' });

    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({
      result: '0xrpc',
      source: 'direct',
    });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(1);
  });

  test('escalates Colibri timeout cooldowns from 15 to 30 to 60 seconds and resets on success', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    const hanging = [deferred(), deferred(), deferred()];
    mockRequestViaColibri.mockImplementation(() => {
      const call = mockRequestViaColibri.mock.calls.length;
      return call <= hanging.length ? hanging[call - 1].promise : Promise.resolve('0xverified');
    });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const params = [{ to: '0xabc', data: '0x1234' }, 'latest'];
    const options = { routingContext: { origin: 'https://swap.example' } };

    const timeOutAttempt = async (attempt) => {
      const response = request(1, 'eth_call', params, options);
      await jest.advanceTimersByTimeAsync(2000);
      await expect(response).resolves.toMatchObject({ source: 'direct' });
      hanging[attempt].resolve('0xlate');
      await Promise.resolve();
    };

    await timeOutAttempt(0);
    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({ source: 'direct' });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(15_000);
    await timeOutAttempt(1);
    await jest.advanceTimersByTimeAsync(29_999);
    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({ source: 'direct' });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(1);
    await timeOutAttempt(2);
    await jest.advanceTimersByTimeAsync(59_999);
    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({ source: 'direct' });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(3);

    await jest.advanceTimersByTimeAsync(1);
    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({
      result: '0xverified',
      source: 'colibri',
    });
    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({
      source: 'colibri',
    });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(5);
  });

  test('demotes deterministic Colibri execution limits only for the matching app and target', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockRequestViaColibri.mockRejectedValue(new Error('prover execution failed: Out of gas'));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const firstTarget = [{
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      data: '0x1234',
    }, 'latest'];
    const secondTarget = [{
      to: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      data: '0x1234',
    }, 'latest'];
    const firstApp = { routingContext: { origin: 'https://swap.example' } };
    const secondApp = { routingContext: { origin: 'https://other.example' } };

    await expect(request(1, 'eth_call', firstTarget, firstApp)).resolves.toMatchObject({
      source: 'direct',
    });
    await expect(request(1, 'eth_call', firstTarget, firstApp)).resolves.toMatchObject({
      source: 'direct',
    });
    await expect(request(1, 'eth_call', secondTarget, firstApp)).resolves.toMatchObject({
      source: 'direct',
    });
    await expect(request(1, 'eth_call', firstTarget, secondApp)).resolves.toMatchObject({
      source: 'direct',
    });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(3);
  });

  test('bounds non-cancellable Colibri work for one route', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockRequestViaColibri.mockReturnValue(new Promise(() => {}));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const params = [{ to: '0xabc', data: '0x1234' }, 'latest'];

    const first = request(1, 'eth_call', params);
    const second = request(1, 'eth_call', params);
    await expect(request(1, 'eth_call', params)).resolves.toMatchObject({ source: 'direct' });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(2);

    await jest.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toMatchObject({ source: 'direct' });
    await expect(second).resolves.toMatchObject({ source: 'direct' });
  });

  test('settles quorum as soon as enough matching endpoints respond', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    const responses = [deferred(), deferred()];
    let thirdSignal;
    global.fetch = jest.fn().mockImplementation((url, options) => {
      if (url === 'https://a.example') return responses[0].promise;
      if (url === 'https://b.example') return responses[1].promise;
      thirdSignal = options.signal;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });

    const result = request(1, 'eth_call', [{ to: '0xabc' }, 'latest']);
    responses[0].resolve({ ok: true, json: async () => ({ result: '0x42' }) });
    responses[1].resolve({ ok: true, json: async () => ({ result: '0x42' }) });

    await expect(result).resolves.toEqual({ result: '0x42', source: 'quorum', verified: true });
    expect(thirdSignal.aborted).toBe(true);
  });

  test('carries in-flight RPC work past the quorum deadline without restarting it', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum', 'direct'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
      'https://d.example',
    ]);
    global.fetch = jest.fn().mockImplementation((_url, options) => {
      if (global.fetch.mock.calls.length > 3) {
        return Promise.resolve({ ok: true, json: async () => ({ result: '0xrpc' }) });
      }
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    });
    const params = [{ to: '0xabc', data: '0x1234' }, 'latest'];
    const options = { routingContext: { origin: 'https://swap.example' } };

    const first = request(1, 'eth_call', params, options);
    await jest.advanceTimersByTimeAsync(1999);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    // Verification has stopped, but the same three requests stay alive under
    // Direct's five-second compatibility budget.
    expect(global.fetch).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(2999);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1);
    await expect(first).resolves.toMatchObject({ result: '0xrpc', source: 'direct' });
    expect(global.fetch).toHaveBeenCalledTimes(4);

    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({
      source: 'direct',
    });
    expect(global.fetch).toHaveBeenCalledTimes(5);
  });

  test('does not extend quorum past two seconds when another source precedes Direct', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum', 'colibri', 'direct'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    global.fetch = jest.fn().mockImplementation((_url, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }));
    mockRequestViaColibri.mockResolvedValue('0xverified');

    const response = request(1, 'eth_call', [{ to: '0xabc' }, 'latest']);
    await jest.advanceTimersByTimeAsync(2000);

    await expect(response).resolves.toMatchObject({
      result: '0xverified',
      source: 'colibri',
    });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(1);
  });

  test('reuses a successful quorum member as Direct when verification becomes impossible', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum', 'direct'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    const directCandidate = deferred();
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url === 'https://a.example') return directCandidate.promise;
      return Promise.resolve({
        ok: true,
        json: async () => ({ error: { code: -32000, message: 'Out of gas' } }),
      });
    });
    const params = [{ to: '0xabc', data: '0x1234' }, 'latest'];
    const options = {
      includeTrust: true,
      routingContext: { origin: 'https://swap.example' },
    };

    const first = request(1, 'eth_call', params, options);
    await Promise.resolve();
    await Promise.resolve();
    expect(global.fetch).toHaveBeenCalledTimes(3);
    directCandidate.resolve({ ok: true, json: async () => ({ result: '0x42' }) });

    await expect(first).resolves.toEqual({
      result: '0x42',
      source: 'direct',
      verified: false,
      trust: {
        level: 'unverified',
        method: 'direct',
        block: null,
        agreed: ['a.example'],
        dissented: [],
        queried: ['a.example', 'b.example', 'c.example'],
        quorum: { k: 3, m: 2, achieved: false },
      },
    });
    // No fourth request was issued: Direct consumed the response already made
    // by the quorum tier.
    expect(global.fetch).toHaveBeenCalledTimes(3);

    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ result: '0xnext' }) });
    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({
      result: '0xnext',
      source: 'direct',
    });
    // The two deterministic quorum failures demoted quorum for this route, so
    // the next call performs only one fresh Direct request.
    expect(global.fetch).toHaveBeenCalledTimes(4);
  });

  test('does not use a partial quorum response when Direct is absent from the policy', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url === 'https://a.example') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ result: '0xsingle' }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ error: { code: -32000, message: 'Out of gas' } }),
      });
    });

    await expect(request(1, 'eth_call', [{ to: '0xabc' }, 'latest'])).rejects.toThrow(
      'All chain sources failed'
    );
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});
