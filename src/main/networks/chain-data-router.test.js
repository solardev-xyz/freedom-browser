const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
};
const mockMyotis = {
  NETWORKS: new Map([[1, {}], [100, {}]]),
  isReady: jest.fn(),
  getAccount: jest.fn(),
  ethCall: jest.fn(),
  estimateGas: jest.fn(),
  feeEstimate: jest.fn(),
  sendRawTransaction: jest.fn(),
};
const mockRequestViaColibri = jest.fn();

jest.mock('./network-registry', () => mockRegistry);
jest.mock('../myotis/myotis-manager', () => mockMyotis);
jest.mock('../ens/colibri-resolver', () => ({
  requestViaColibri: (...args) => mockRequestViaColibri(...args),
}));
jest.mock('../logger', () => ({ verbose: jest.fn() }));

const { request, getFeeQuote, broadcastRawTransaction } = require('./chain-data-router');
const originalFetch = global.fetch;

describe('chain-data-router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
  });

  afterEach(() => {
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
});
