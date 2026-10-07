const mockRegistry = {
  getNetwork: jest.fn(),
  getEndpoints: jest.fn(),
  getEndpointSources: jest.fn(() => []),
  getEndpointSourceList: jest.fn(() => []),
};
const mockMyotis = {
  NETWORKS: new Map([[1, {}], [100, {}]]),
  isReady: jest.fn(),
  markUnhealthy: jest.fn(),
  getStatus: jest.fn(),
  getAccount: jest.fn(),
  ethCallTx: jest.fn(),
  getCode: jest.fn(),
  getStorageAt: jest.fn(),
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

// Let every queued continuation run without advancing any timer.
function flushMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
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
  ERROR_RANK,
  SOURCE_CAPABILITIES,
  LOG_TRUNCATION_TAIL_BLOCKS,
  LOG_TRUNCATION_MIN_SPAN,
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
    mockMyotis.getAccount.mockResolvedValue({ verifyMethod: 'headerChain', exists: true, balanceWei: '42', nonce: 3 });

    await expect(request(100, 'eth_getBalance', ['0xabc', 'latest'])).resolves.toEqual({
      result: '0x2a',
      source: 'myotis',
      verified: true,
    });
    expect(mockMyotis.getAccount).toHaveBeenCalledWith('0xabc', 100);
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  // "Serve a state read only with its verdict" (myotis-node README, https://github.com/biafra23/myotis/pull/538):
  // data keys without verifyMethod are no answer, however plausible.
  test.each(['eth_getBalance', 'eth_getTransactionCount'])('does not serve an unverified %s', async (method) => {
    mockMyotis.getAccount.mockResolvedValue({
      verifyMethod: null, failReason: 'beaconNotSynced', exists: true, balanceWei: '42', nonce: 3,
    });
    mockRequestViaColibri.mockResolvedValue('0x7');
    await expect(request(1, method, ['0xabc', 'latest'])).resolves.toMatchObject({ result: '0x7', source: 'colibri' });
  });

  test.each([['eth_getBalance'], ['eth_getTransactionCount']])('serves %s 0x0 for an account proven absent', async (method) => {
    mockMyotis.getAccount.mockResolvedValue({
      verifyMethod: 'headerChain', exists: false, balanceWei: null, nonce: -1,
    });
    await expect(request(1, method, ['0xabc', 'latest'])).resolves.toEqual({
      result: '0x0', source: 'myotis', verified: true,
    });
  });

  test('serves eth_getCode from Myotis with its verdict', async () => {
    mockMyotis.getCode.mockResolvedValue({ verifyMethod: 'headerChain', codeHex: '0x6080ABCD' });
    await expect(request(1, 'eth_getCode', ['0xabc', 'latest'])).resolves.toEqual({
      result: '0x6080abcd', source: 'myotis', verified: true,
    });
    expect(mockMyotis.getCode).toHaveBeenCalledWith('0xabc', 1);
    mockMyotis.getCode.mockResolvedValue({ verifyMethod: 'headerChain', codeHex: '0x' });
    await expect(request(1, 'eth_getCode', ['0xabc'])).resolves.toMatchObject({ result: '0x', source: 'myotis' });
  });

  test.each([
    [{ verifyMethod: null, failReason: 'noPeers', codeHex: '0x60' }],
    [{ verifyMethod: 'headerChain', codeHex: '0x6' }],
    [{ verifyMethod: 'headerChain', codeHex: null }],
  ])('does not serve unverified or malformed code: %j', async (payload) => {
    mockMyotis.getCode.mockResolvedValue(payload);
    mockRequestViaColibri.mockResolvedValue('0x60');
    await expect(request(1, 'eth_getCode', ['0xabc', 'latest'])).resolves.toMatchObject({ source: 'colibri' });
  });

  test('pads eth_getStorageAt to the 32-byte word and serves an empty slot as zero', async () => {
    mockMyotis.getStorageAt.mockResolvedValue({ verifyMethod: 'headerChain', valueHex: '0x2A' });
    await expect(request(100, 'eth_getStorageAt', ['0xabc', '0x0', 'latest'])).resolves.toEqual({
      result: `0x${'0'.repeat(62)}2a`, source: 'myotis', verified: true,
    });
    expect(mockMyotis.getStorageAt).toHaveBeenCalledWith('0xabc', '0x0', 100);
    mockMyotis.getStorageAt.mockResolvedValue({ verifyMethod: 'headerChain', valueHex: null });
    await expect(request(100, 'eth_getStorageAt', ['0xabc', '0x0'])).resolves.toMatchObject({
      result: `0x${'0'.repeat(64)}`, source: 'myotis',
    });
  });

  test.each([
    ['eth_getCode', ['0xabc', 'finalized']],
    ['eth_getStorageAt', ['0xabc', '0x0', '0x10']],
  ])('sends %s at a non-latest block to a source that honours the tag', async (method, params) => {
    mockRequestViaColibri.mockResolvedValue('0x');
    await expect(request(1, method, params)).resolves.toMatchObject({ source: 'colibri' });
    expect(mockMyotis.getCode).not.toHaveBeenCalled();
    expect(mockMyotis.getStorageAt).not.toHaveBeenCalled();
  });

  test.each(['eth_call', 'eth_estimateGas'])('preserves verified %s revert data without another source', async (method) => {
    const native = method === 'eth_call' ? mockMyotis.ethCallTx : mockMyotis.estimateGas;
    native.mockResolvedValue({ status: 'revert', dataHex: '0x08c379a0abcd' });
    global.fetch = jest.fn();
    await expect(request(1, method, [{ to: '0xabc' }])).rejects.toMatchObject({ code: 3, data: '0x08c379a0abcd' });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test.each([{ status: 'unavailable', reason: 'cancelled' }, { error: 'deadline exceeded' }])('falls through unavailable read shapes: %s', async (payload) => {
    mockMyotis.ethCallTx.mockResolvedValue(payload);
    mockRequestViaColibri.mockResolvedValue('0xfallback');
    await expect(request(1, 'eth_call', [{ to: '0xabc' }])).resolves.toMatchObject({ source: 'colibri', result: '0xfallback' });
  });

  // ABI 36: nothing was sent, so this is neither uncertain nor worth a second
  // broadcaster — the reason is geth's txpool verdict, served under -32000.
  test('serves a rejected Myotis send as a definite error without another broadcaster', async () => {
    const rejected = Object.assign(new Error('nonce too low: next nonce 5, tx nonce 4'), {
      code: -32000, myotisRefusal: 'rejected',
    });
    mockMyotis.sendRawTransaction.mockRejectedValue(rejected);
    global.fetch = jest.fn();
    await expect(broadcastRawTransaction(1, '0xsigned')).rejects.toBe(rejected);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('does not retry an in-band failed broadcast at another broadcaster', async () => {
    mockMyotis.sendRawTransaction.mockResolvedValue({ error: 'connection lost' });
    global.fetch = jest.fn();
    await expect(broadcastRawTransaction(1, '0xsigned')).rejects.toMatchObject({ code: 'MYOTIS_BROADCAST_UNCERTAIN' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('sends pending nonce reads to a source that honours the block tag', async () => {
    mockMyotis.getAccount.mockResolvedValue({ verifyMethod: 'headerChain', exists: true, nonce: 3 });
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
    ], { deadlineMs: expect.any(Number) });
  });

  test('sends historical balance reads to a source that honours the block tag', async () => {
    mockMyotis.getAccount.mockResolvedValue({ verifyMethod: 'headerChain', exists: true, balanceWei: '42' });
    mockRequestViaColibri.mockResolvedValue('0x1');

    await expect(request(100, 'eth_getBalance', ['0xabc', '0x1234'])).resolves.toMatchObject({
      result: '0x1',
      source: 'colibri',
    });
    expect(mockMyotis.getAccount).not.toHaveBeenCalled();
  });

  test('sends non-latest gas estimates to a source that honours the block tag', async () => {
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas: 21000 });
    mockRequestViaColibri.mockResolvedValue('0x5208');

    await expect(
      request(100, 'eth_estimateGas', [{ to: '0xabc' }, 'pending'])
    ).resolves.toMatchObject({ source: 'colibri' });
    expect(mockMyotis.estimateGas).not.toHaveBeenCalled();
  });

  test('sends historical eth_call to a source that honours the block tag', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0xhead' });
    mockRequestViaColibri.mockResolvedValue('0xhistoric');

    await expect(
      request(100, 'eth_call', [{ to: '0xabc', data: '0x70a08231' }, '0x10d4f00'])
    ).resolves.toEqual({ result: '0xhistoric', source: 'colibri', verified: true });
    expect(mockMyotis.ethCallTx).not.toHaveBeenCalled();
  });

  test('sends eth_call state overrides to a source that can apply them', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0xhead' });
    mockRequestViaColibri.mockResolvedValue('0xsimulated');

    await expect(
      request(100, 'eth_call', [
        { to: '0xabc', data: '0x70a08231' },
        'latest',
        { '0xabc': { balance: '0x1' } },
      ])
    ).resolves.toMatchObject({ result: '0xsimulated', source: 'colibri' });
    expect(mockMyotis.ethCallTx).not.toHaveBeenCalled();
  });

  // ABI 34/35: the engine applies or refuses every field, so a call carrying
  // gas, fees, nonce, an access list or EIP-7702 authorizations is executed by
  // Myotis with all of them — none is stripped on the way to the addon.
  test('passes the whole transaction object, every field intact, to Myotis', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ status: 'ok', resultHex: '0x2a' });
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas: 61000 });
    const tx = {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      data: '0x3e12cc2e',
      value: '0x1',
      gas: '0x5208',
      maxFeePerGas: '0x3b9aca00',
      maxPriorityFeePerGas: '0x1',
      nonce: '0x7',
      chainId: '0x64',
      type: '0x4',
      accessList: [{ address: '0x3333333333333333333333333333333333333333', storageKeys: [] }],
      authorizationList: [{
        address: '0x05ae73c5925d843864ae6f261f3175de2ebcd963',
        nonce: '0x0', chainId: '0x64', yParity: '0x1', r: '0x9a3b', s: '0x0c5d',
      }],
    };

    await expect(request(100, 'eth_call', [tx, 'latest'])).resolves.toEqual({
      result: '0x2a', source: 'myotis', verified: true,
    });
    await expect(request(100, 'eth_estimateGas', [tx])).resolves.toMatchObject({
      result: '0xee48', source: 'myotis',
    });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith({ chainId: 100, tx, block: 'latest' });
    expect(mockMyotis.estimateGas).toHaveBeenCalledWith({ chainId: 100, tx, block: 'latest' });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  // A refusal of the request itself is Myotis's answer: no retry, no remote
  // fallback that might accept it by ignoring a field (an estimate without the
  // authorization list is too low to mine), and no adaptive demotion.
  test.each(['eth_call', 'eth_estimateGas'])('serves a permanent -32602 refusal of %s without falling back', async (method) => {
    const native = method === 'eth_call' ? mockMyotis.ethCallTx : mockMyotis.estimateGas;
    native.mockResolvedValue({
      error: 'invalid transaction object: chainId 1 does not match this node\'s chain (100)',
      code: -32602,
    });
    global.fetch = jest.fn();

    await expect(request(100, method, [{ to: '0xabc', chainId: '0x1' }])).rejects.toMatchObject({
      code: -32602,
      message: 'invalid transaction object: chainId 1 does not match this node\'s chain (100)',
      myotisRefusal: 'invalid-params',
    });
    expect(native).toHaveBeenCalledTimes(1);
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    // Not counted against the route: a valid request still goes to Myotis.
    native.mockResolvedValue({ status: 'ok', resultHex: '0x2a', gas: 21000 });
    await expect(request(100, method, [{ to: '0xabc' }])).resolves.toMatchObject({ source: 'myotis' });
  });

  test('serves a -32602 refusal of an account read without falling back', async () => {
    mockMyotis.getAccount.mockResolvedValue({ error: 'invalid address (expected 20-byte hex)', code: -32602 });
    global.fetch = jest.fn();
    await expect(request(1, 'eth_getBalance', ['0xnot-an-address', 'latest'])).rejects.toMatchObject({
      code: -32602, myotisRefusal: 'invalid-params',
    });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  // ABI 33: an executor whose fork table disagrees with the verified header,
  // or a call above the engine's own gas budget, says nothing about the
  // request — this build cannot run it, so the next source may.
  test.each([
    'block 23000000 carries an EIP-7843 slot number, so it is an Amsterdam block, but this build\'s fork table puts it before Amsterdam; refusing to run it under the older fork\'s rules',
    'block 23000000 is an Amsterdam block but its header has no slot number (EIP-7843); refusing to run SLOTNUM against a made-up value',
    'the call ran out of this node\'s 30000000-gas call budget, below the 50000000 gas it allows',
  ])('falls back on a capability refusal: %s', async (error) => {
    mockMyotis.ethCallTx.mockResolvedValue({ error, code: -32602 });
    mockRequestViaColibri.mockResolvedValue('0xelsewhere');
    await expect(request(1, 'eth_call', [{ to: '0xabc' }])).resolves.toMatchObject({
      result: '0xelsewhere', source: 'colibri',
    });
  });

  test('sends blob transactions to another source instead of a Myotis refusal', async () => {
    mockRequestViaColibri.mockResolvedValue('0x5208');
    await expect(request(1, 'eth_estimateGas', [{
      to: '0xabc', blobVersionedHashes: ['0x01' + '00'.repeat(31)], maxFeePerBlobGas: '0x1',
    }])).resolves.toMatchObject({ source: 'colibri' });
    expect(mockMyotis.estimateGas).not.toHaveBeenCalled();
    // An empty blob list is not a blob transaction.
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas: 21000 });
    await expect(request(1, 'eth_estimateGas', [{ to: '0xabc', blobVersionedHashes: [] }]))
      .resolves.toMatchObject({ source: 'myotis' });
  });

  // ABI 34/35: geth's -32000 with its exact wording, a verified answer like a revert.
  test.each([
    ['eth_estimateGas', 'gas required exceeds allowance (21000)'],
    ['eth_estimateGas', 'insufficient funds for transfer'],
    ['eth_call', 'err: insufficient funds for gas * price + value: address 0x1111111111111111111111111111111111111111 have 0 want 21000 (supplied gas 21000)'],
    ['eth_call', 'out of gas'],
  ])('serves an infeasible %s as geth\'s -32000 "%s"', async (method, reason) => {
    const native = method === 'eth_call' ? mockMyotis.ethCallTx : mockMyotis.estimateGas;
    native.mockResolvedValue({ status: 'infeasible', reason });
    global.fetch = jest.fn();
    await expect(request(1, method, [{ to: '0xabc', gas: '0x5208' }])).rejects.toMatchObject({
      code: -32000, message: reason, myotisRefusal: 'infeasible',
    });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('still serves a plain head-state eth_call from Myotis', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(100, 'eth_call', [{ to: '0xabc', data: '0x70a08231' }, 'latest'])
    ).resolves.toEqual({ result: '0x2a', source: 'myotis', verified: true });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith({
      chainId: 100, tx: { to: '0xabc', data: '0x70a08231' }, block: 'latest',
    });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  test('includes source-specific trust evidence only when requested', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0x2a' });

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
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0x2a' });

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
    ], { deadlineMs: expect.any(Number) });
  });

  // The worker host terminates a Colibri worker still verifying past this
  // deadline (#495), so it must be the same budget the caller waits for.
  test('hands Colibri the same deadline the caller waits on', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 7000 },
    });
    mockRequestViaColibri.mockResolvedValue('0x1');
    await request(100, 'eth_call', [{ to: '0xabc', data: '0x' }, 'latest']);
    expect(mockRequestViaColibri).toHaveBeenLastCalledWith(
      100, 'eth_call', expect.any(Array), { deadlineMs: 7000 }
    );
    await request(100, 'eth_call', [{ to: '0xabc', data: '0x01' }, 'latest'], {
      routingContext: { origin: 'https://app.example' },
    });
    expect(mockRequestViaColibri).toHaveBeenLastCalledWith(
      100, 'eth_call', expect.any(Array), { deadlineMs: 2000 }
    );
  });

  test('does not fall through to another broadcaster after an uncertain Myotis outcome', async () => {
    global.fetch = jest.fn();
    mockMyotis.isReady.mockReturnValue(true);
    const error = Object.assign(new Error('broadcast outcome uncertain'), { code: 'MYOTIS_BROADCAST_UNCERTAIN' });
    mockMyotis.sendRawTransaction.mockRejectedValueOnce(error);
    await expect(broadcastRawTransaction(100, '0xsigned')).rejects.toBe(error);
    expect(global.fetch).not.toHaveBeenCalled();
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
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas: 21000 });

    await expect(
      request(100, 'eth_estimateGas', [{ to: '0xabc', value: '1000000000000000000' }])
    ).resolves.toMatchObject({ result: '0x5208', source: 'myotis' });
    // The transaction object carries QUANTITYs, so the engine sees hex.
    expect(mockMyotis.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ tx: { to: '0xabc', value: '0xde0b6b3a7640000' } })
    );
  });

  // The engine's parser takes only 0x-hex for chainId/type and its -32602 is
  // served as final, so a dApp sending them as a JSON number or a decimal
  // string must reach Myotis already hex-encoded — not be refused outright.
  test.each([
    ['JSON numbers', { chainId: 100, type: 2 }],
    ['decimal strings', { chainId: '100', type: '2' }],
    ['zero-padded hex', { chainId: '0x064', type: '0x02' }],
  ])('hex-encodes chainId and type given as %s before Myotis sees them', async (_label, fields) => {
    mockMyotis.ethCallTx.mockResolvedValue({ status: 'ok', resultHex: '0x2a' });
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas: 21000 });

    await expect(
      request(100, 'eth_call', [{ to: '0xabc', data: '0x70a08231', ...fields }, 'latest'])
    ).resolves.toEqual({ result: '0x2a', source: 'myotis', verified: true });
    await expect(
      request(100, 'eth_estimateGas', [{ to: '0xabc', ...fields }])
    ).resolves.toMatchObject({ result: '0x5208', source: 'myotis' });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith(expect.objectContaining({
      tx: { to: '0xabc', data: '0x70a08231', chainId: '0x64', type: '0x2' },
    }));
    expect(mockMyotis.estimateGas).toHaveBeenCalledWith(expect.objectContaining({
      tx: { to: '0xabc', chainId: '0x64', type: '0x2' },
    }));
  });

  test('hex-encodes a legacy type 0 rather than dropping it', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ status: 'ok', resultHex: '0x2a' });

    await request(1, 'eth_call', [{ to: '0xabc', type: 0 }, 'latest']);
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith(
      expect.objectContaining({ tx: { to: '0xabc', type: '0x0' } })
    );
  });

  test.each([
    ['a decimal string', '21000'],
    ['a hex string', '0x5208'],
    ['a fractional number', 21000.5],
    ['a number beyond the safe range', 2 ** 53],
    ['a negative number', -1],
  ])('refuses %s gas estimate from Myotis and uses another source', async (_label, gas) => {
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas });
    mockRequestViaColibri.mockResolvedValue('0x5208');

    await expect(request(1, 'eth_estimateGas', [{ to: '0xabc' }])).resolves.toMatchObject({
      result: '0x5208',
      source: 'colibri',
    });
  });

  test('executes the standardized "input" calldata alias on the Myotis path', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', input: '0x70a08231' }, 'latest'])
    ).resolves.toEqual({ result: '0x2a', source: 'myotis', verified: true });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith(
      expect.objectContaining({ tx: expect.objectContaining({ to: '0xabc', data: '0x70a08231' }) })
    );
  });

  test('estimates gas against the "input" calldata alias rather than an empty call', async () => {
    mockMyotis.estimateGas.mockResolvedValue({ status: 'ok', gas: 54000 });

    await expect(
      request(1, 'eth_estimateGas', [{ to: '0xabc', input: '0xa9059cbb' }])
    ).resolves.toMatchObject({ result: '0xd2f0', source: 'myotis' });
    expect(mockMyotis.estimateGas).toHaveBeenCalledWith(
      expect.objectContaining({ tx: expect.objectContaining({ to: '0xabc', data: '0xa9059cbb' }) })
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
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0x2a' });

    await expect(
      request(1, 'eth_call', [{ to: '0xabc', data: '0x', input: '0x70a08231' }, 'latest'])
    ).resolves.toMatchObject({ source: 'myotis' });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith(
      expect.objectContaining({ tx: expect.objectContaining({ data: '0x70a08231' }) })
    );
  });

  // The engine refuses the ambiguous pair itself (permanent -32602, as strict
  // nodes do), so both payloads reach it and the refusal is the answer.
  test('lets Myotis refuse calls with conflicting data/input calldata', async () => {
    mockMyotis.ethCallTx.mockResolvedValue({
      error: "invalid transaction object: both 'data' and 'input' are set and not equal; use 'input'",
      code: -32602,
    });
    mockRequestViaColibri.mockResolvedValue('0xlenient');

    await expect(
      request(100, 'eth_call', [
        { to: '0xabc', data: '0x70a08231', input: '0xa9059cbb' },
        'latest',
      ])
    ).rejects.toMatchObject({ code: -32602, myotisRefusal: 'invalid-params' });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledWith(expect.objectContaining({
      tx: { to: '0xabc', data: '0x70a08231', input: '0xa9059cbb' },
    }));
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
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

  test('never routes to an excluded source', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockRequestViaColibri.mockResolvedValue('0xcolibri');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });

    await expect(
      request(100, 'eth_call', [{}, 'latest'], { excludeSources: ['colibri'] })
    ).resolves.toMatchObject({ result: '0xrpc', source: 'direct' });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();

    await expect(request(100, 'eth_call', [{}, 'latest'])).resolves.toMatchObject({
      result: '0xcolibri',
      source: 'colibri',
    });
  });

  // Colibri truncates wide ranges (#496), so no
  // caller's eth_getLogs reaches it, including a page's window.ethereum read
  // (wallet:chain-request passes only a routingContext).
  test('never routes eth_getLogs to Colibri, even for a page-driven read', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockRequestViaColibri.mockResolvedValue(['0xtruncated']);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: ['0xlog'] }),
    });

    await expect(
      request(100, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }], {
        routingContext: { origin: 'https://app.example' },
      })
    ).resolves.toMatchObject({ result: ['0xlog'], source: 'direct', verified: false });
    await expect(request(100, 'eth_getLogs', [{}])).resolves.toMatchObject({
      source: 'direct',
    });
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
  });

  test('names the exclusion when it leaves no source to ask', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri'] },
      quorum: { timeoutMs: 5000 },
    });
    global.fetch = jest.fn();

    await expect(request(100, 'eth_getLogs', [{}])).rejects.toThrow(
      'No chain source left for eth_getLogs on chain 100: read order [colibri], ' +
        'excluded for this request: colibri'
    );
    await expect(
      request(100, 'eth_call', [{}, 'latest'], { excludeSources: ['colibri'] })
    ).rejects.toThrow(/No chain source left for eth_call .*excluded for this request: colibri/);
    expect(mockRequestViaColibri).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('names the exclusion when every remaining source fails', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri', 'myotis'] },
      quorum: { timeoutMs: 5000 },
    });
    mockMyotis.isReady.mockReturnValue(false);

    await expect(request(100, 'eth_getLogs', [{}])).rejects.toThrow(
      /All chain sources failed for eth_getLogs \(myotis: .*; excluded for this request: colibri\)/
    );
  });

  test('falls through after two seconds and temporarily bypasses a timed-out Myotis route', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    const hangingRead = deferred();
    mockMyotis.ethCallTx.mockReturnValue(hangingRead.promise);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const params = [{
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      data: '0x1234',
    }, 'latest'];
    const options = { routingContext: { origin: 'https://swap.example' } };

    const first = request(1, 'eth_call', params, options);
    await jest.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toMatchObject({ result: '0xrpc', source: 'direct' });

    await expect(request(1, 'eth_call', params, options)).resolves.toMatchObject({
      result: '0xrpc',
      source: 'direct',
    });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);

    hangingRead.resolve({ resultHex: '0xlate' });
    await Promise.resolve();
  });

  test('keeps non-cancellable Myotis work from starving interactive fallbacks', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockMyotis.ethCallTx.mockReturnValue(new Promise(() => {}));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const options = { routingContext: { origin: 'https://swap.example' } };
    const requests = Array.from({ length: 6 }, (_value, index) =>
      request(1, 'eth_call', [{
        to: `0x${String(index + 1).padStart(40, '0')}`,
        data: '0x1234',
      }, 'latest'], options));

    await jest.advanceTimersByTimeAsync(2000);
    // Compare the whole source list, not `arrayContaining`: identical matchers
    // there are satisfied by a single match, so 5-of-6 falling elsewhere would
    // still pass.
    const settled = await Promise.all(requests);
    expect(settled.map((entry) => entry.source)).toEqual(Array(6).fill('direct'));
    expect(mockMyotis.markUnhealthy).not.toHaveBeenCalled();
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);
  });

  test('falls back at the caller deadline while a healthy Myotis read completes late', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    const slowRead = deferred();
    mockMyotis.ethCallTx.mockReturnValueOnce(slowRead.promise)
      .mockResolvedValue({ resultHex: '0xverified' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, json: async () => ({ result: '0xrpc' }),
    });
    const options = { routingContext: { origin: 'https://swap.example' } };
    const read = (to) => request(1, 'eth_call', [{ to, data: '0x1234' }, 'latest'], options);
    const first = read('0x1111111111111111111111111111111111111111');
    await jest.advanceTimersByTimeAsync(2000);
    await expect(first).resolves.toMatchObject({ source: 'direct', result: '0xrpc' });
    expect(mockMyotis.markUnhealthy).not.toHaveBeenCalled();

    // Different route, same chain: native admission stays occupied until the
    // first request actually settles, although its caller already has an answer.
    const second = read('0x2222222222222222222222222222222222222222');
    await jest.advanceTimersByTimeAsync(100);
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);
    slowRead.resolve({ resultHex: '0xlate' });
    await jest.advanceTimersByTimeAsync(0);
    await expect(second).resolves.toMatchObject({ source: 'myotis', result: '0xverified' });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mockMyotis.markUnhealthy).not.toHaveBeenCalled();
  });

  test('serializes concurrent Myotis reads instead of downgrading the second one', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    const balanceRead = deferred();
    const decimalsRead = deferred();
    mockMyotis.ethCallTx
      .mockReturnValueOnce(balanceRead.promise)
      .mockReturnValueOnce(decimalsRead.promise);
    global.fetch = jest.fn();
    const token = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // The shape wallet reads actually use: balanceOf + decimals in one
    // Promise.all. Neither may silently lose verification for being second.
    const balance = request(1, 'eth_call', [{ to: token, data: '0x70a08231' }, 'latest']);
    const decimals = request(1, 'eth_call', [{ to: token, data: '0x313ce567' }, 'latest']);

    await flushMicrotasks();
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);
    balanceRead.resolve({ resultHex: '0x2a' });
    await expect(balance).resolves.toEqual({
      result: '0x2a',
      source: 'myotis',
      verified: true,
    });

    await flushMicrotasks();
    decimalsRead.resolve({ resultHex: '0x12' });
    await expect(decimals).resolves.toEqual({
      result: '0x12',
      source: 'myotis',
      verified: true,
    });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(2);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('keeps a Myotis-terminal read order working under concurrency', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis'] },
      quorum: { timeoutMs: 5000 },
    });
    mockMyotis.getAccount.mockResolvedValue({ verifyMethod: 'headerChain', exists: true, balanceWei: '42', nonce: 3 });

    await expect(Promise.all([
      request(1, 'eth_getBalance', ['0xabc', 'latest']),
      request(1, 'eth_getTransactionCount', ['0xabc', 'latest']),
    ])).resolves.toEqual([
      { result: '0x2a', source: 'myotis', verified: true },
      { result: '0x3', source: 'myotis', verified: true },
    ]);
    expect(mockMyotis.getAccount).toHaveBeenCalledTimes(2);
  });

  test('refuses Myotis once its wait queue is full instead of parking unbounded work', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'direct'] },
      quorum: { timeoutMs: 5000 },
    });
    mockMyotis.ethCallTx.mockReturnValue(new Promise(() => {}));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    // One read holds the slot, sixteen queue behind it, the eighteenth is
    // refused outright rather than waiting on a slot that is not turning over.
    const requests = Array.from({ length: 18 }, (_value, index) =>
      request(1, 'eth_call', [{
        to: `0x${String(index + 1).padStart(40, '0')}`,
        data: '0x1234',
      }, 'latest']));

    await expect(requests[17]).resolves.toMatchObject({ source: 'direct' });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(5000);
    const settled = await Promise.all(requests);
    expect(settled.map((entry) => entry.source)).toEqual(Array(18).fill('direct'));
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);
  });

  test('releases the Myotis slot when the trust status binding throws synchronously', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis', 'direct'] },
      quorum: { timeoutMs: 500 },
    });
    mockMyotis.getStatus.mockImplementationOnce(() => {
      throw new Error('native getStatus binding failed');
    });
    mockMyotis.ethCallTx.mockResolvedValue({ resultHex: '0x2a' });
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ result: '0xrpc' }),
    });
    const params = [{
      to: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      data: '0x1234',
    }, 'latest'];

    await expect(request(1, 'eth_call', params, { includeTrust: true }))
      .resolves.toMatchObject({ source: 'direct' });
    // A single synchronous throw must not strand the one Myotis slot: the next
    // read still reaches Myotis instead of queueing behind a leaked count.
    await expect(request(1, 'eth_call', params, { includeTrust: true }))
      .resolves.toMatchObject({ source: 'myotis', verified: true });
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
    const options = { routingContext: { origin: 'https://swap.example' } };

    const first = request(1, 'eth_call', params, options);
    const second = request(1, 'eth_call', params, options);
    await expect(request(1, 'eth_call', params, options))
      .resolves.toMatchObject({ source: 'direct' });
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

    const response = request(1, 'eth_call', [{ to: '0xabc' }, 'latest'], {
      routingContext: { origin: 'https://swap.example' },
    });
    await jest.advanceTimersByTimeAsync(2000);

    await expect(response).resolves.toMatchObject({
      result: '0xverified',
      source: 'colibri',
    });
    expect(mockRequestViaColibri).toHaveBeenCalledTimes(1);
  });

  test('keeps a wallet read verified when quorum agrees after the interactive budget', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum', 'direct'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    global.fetch = jest.fn().mockImplementation((_url, options) =>
      new Promise((resolve, reject) => {
        // Slow-but-healthy endpoints: they agree at 3s, inside the chain's
        // configured 5s quorum timeout but past the interactive budget.
        setTimeout(() => resolve({ ok: true, json: async () => ({ result: '0x42' }) }), 3000);
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }));

    // No routingContext: this is a wallet-internal read, not a page a user is
    // watching, so it must not be downgraded to an unverified Direct answer.
    const response = request(1, 'eth_call', [{ to: '0xabc' }, 'latest']);
    await jest.advanceTimersByTimeAsync(3000);

    await expect(response).resolves.toEqual({
      result: '0x42',
      source: 'quorum',
      verified: true,
    });
  });

  test('gives quorum the configured timeout when it is the last configured source', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue([
      'https://a.example',
      'https://b.example',
      'https://c.example',
    ]);
    global.fetch = jest.fn().mockImplementation((_url, options) =>
      new Promise((resolve, reject) => {
        setTimeout(() => resolve({ ok: true, json: async () => ({ result: '0x42' }) }), 3000);
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }));

    // Even an app-driven read: with nothing to fall through to, cutting the
    // per-endpoint timeout to 2s only turns a working read into a failure.
    const response = request(1, 'eth_call', [{ to: '0xabc' }, 'latest'], {
      routingContext: { origin: 'https://swap.example' },
    });
    await jest.advanceTimersByTimeAsync(3000);

    await expect(response).resolves.toEqual({
      result: '0x42',
      source: 'quorum',
      verified: true,
    });
  });

  test('gives Colibri the configured timeout when it is the last configured source', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['colibri'] },
      quorum: { timeoutMs: 5000 },
    });
    const slowProver = deferred();
    mockRequestViaColibri.mockReturnValue(slowProver.promise);

    const response = request(1, 'eth_call', [{ to: '0xabc' }, 'latest'], {
      routingContext: { origin: 'https://swap.example' },
    });
    await jest.advanceTimersByTimeAsync(3000);
    slowProver.resolve('0xverified');

    await expect(response).resolves.toEqual({
      result: '0xverified',
      source: 'colibri',
      verified: true,
    });
  });

  test('gives Myotis the configured timeout when it is the last configured source', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['myotis'] },
      quorum: { timeoutMs: 5000 },
    });
    const slowRead = deferred();
    mockMyotis.ethCallTx.mockReturnValue(slowRead.promise);

    const response = request(1, 'eth_call', [{ to: '0xabc' }, 'latest'], {
      routingContext: { origin: 'https://swap.example' },
    });
    await jest.advanceTimersByTimeAsync(3000);
    slowRead.resolve({ resultHex: '0xverified' });

    await expect(response).resolves.toEqual({
      result: '0xverified',
      source: 'myotis',
      verified: true,
    });
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


describe('Ant bridge cancellation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearAdaptiveRoutingForTest();
    mockRegistry.getNetwork.mockReturnValue({ access: {
      readOrder: ['myotis', 'direct'], broadcastOrder: ['myotis', 'direct'],
    } });
    mockMyotis.isReady.mockReturnValue(true);
    global.fetch = jest.fn();
  });
  afterEach(() => { global.fetch = originalFetch; });

  test.each(['read', 'broadcast'])('does not fall through after a cancelled %s', async (kind) => {
    const controller = new AbortController();
    const waiting = deferred();
    const native = kind === 'read' ? mockMyotis.getAccount : mockMyotis.sendRawTransaction;
    native.mockReturnValue(waiting.promise);
    const pending = kind === 'read'
      ? request(100, 'eth_getBalance', ['0xabc', 'latest'], { signal: controller.signal })
      : broadcastRawTransaction(100, '0xsigned', { signal: controller.signal });
    await flushMicrotasks();
    controller.abort();
    waiting.reject(new Error('node stopped'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('background reads never queue for the Myotis slot ahead of wallet reads', async () => {
    mockRegistry.getEndpoints.mockReturnValue(['https://one.example']);
    global.fetch.mockResolvedValue({ ok: true, json: async () => ({ result: '0xrpc' }) });
    const held = deferred();
    mockMyotis.ethCallTx.mockReturnValueOnce(held.promise).mockResolvedValue({ resultHex: '0x2a' });
    const call = [{ to: `0x${'1'.padStart(40, '0')}`, data: '0x1234' }, 'latest'];
    const wallet = request(100, 'eth_call', call);
    await flushMicrotasks();
    // The slot is busy: Ant's read skips Myotis at once instead of waiting.
    await expect(request(100, 'eth_call', call, { background: true }))
      .resolves.toMatchObject({ source: 'direct' });
    expect(mockMyotis.ethCallTx).toHaveBeenCalledTimes(1);
    held.resolve({ resultHex: '0x1' });
    await expect(wallet).resolves.toMatchObject({ source: 'myotis' });
    // Nothing was left parked on the slot; an idle slot still serves Ant.
    await expect(request(100, 'eth_call', call, { background: true }))
      .resolves.toMatchObject({ source: 'myotis' });
  });

  test('direct timeout names a query timeout and can be widened, never narrowed', async () => {
    jest.useFakeTimers();
    try {
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['direct'] }, quorum: { timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue(['https://one.example']);
      global.fetch.mockImplementation((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }));
      const wide = request(100, 'eth_getLogs', [{}], { directTimeoutMs: 60000 });
      const settled = jest.fn();
      wide.then(settled, settled);
      await jest.advanceTimersByTimeAsync(5000);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(55000);
      await expect(wide).rejects.toThrow('RPC query timeout after 60000ms');

      const narrow = request(100, 'eth_getLogs', [{}], { directTimeoutMs: 10 });
      const narrowSettled = jest.fn();
      narrow.then(narrowSettled, narrowSettled);
      await jest.advanceTimersByTimeAsync(4000);
      expect(narrowSettled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      await expect(narrow).rejects.toThrow('RPC query timeout after 5000ms');
    } finally {
      jest.useRealTimers();
    }
  });

  test('quorumTimeoutMs widens the quorum budget, never narrows it below the configured one', async () => {
    jest.useFakeTimers();
    try {
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['quorum'] },
        quorum: { k: 3, m: 2, timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue(['https://a.example', 'https://b.example']);
      global.fetch.mockImplementation(
        (_url, { signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            );
          })
      );
      const wide = request(100, 'eth_getLogs', [{}], { quorumTimeoutMs: 30000 });
      const settled = jest.fn();
      wide.then(settled, settled);
      await jest.advanceTimersByTimeAsync(29000);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      expect(settled).toHaveBeenCalled();

      const narrow = request(100, 'eth_getLogs', [{}], { quorumTimeoutMs: 10 });
      const narrowSettled = jest.fn();
      narrow.then(narrowSettled, narrowSettled);
      await jest.advanceTimersByTimeAsync(4000);
      expect(narrowSettled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1000);
      expect(narrowSettled).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('without rangeCapOf a refused log range is not learned or routed around', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue(THREE_RPCS);
    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () =>
        url === 'https://c.example'
          ? { error: { code: -32701, message: 'exceed maximum block range: 50000' } }
          : { result: [] },
    }));
    const wide = [{ fromBlock: '0x1', toBlock: '0x1000000' }];
    await request(100, 'eth_getLogs', wide, { rankError: () => ERROR_RANK.REQUEST });
    await request(100, 'eth_getLogs', wide, { rankError: () => ERROR_RANK.REQUEST });
    // c is still asked: only a caller that names caps (Ant's bridge) learns them.
    expect(global.fetch.mock.calls.map(([url]) => url)).toEqual([...THREE_RPCS, ...THREE_RPCS]);
  });
  // The Ant log-scan error rule (rankError) is exercised as a tier x error
  // class x arrival order matrix in src/main/swarm/ant-log-scan-routing.test.js.
  // These pin that callers without rankError (wallet/app reads, broadcasts)
  // report failures exactly as before.
  const THREE_RPCS = ['https://a.example', 'https://b.example', 'https://c.example'];
  const hangUntilAborted = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });

  test('without rankError a quorum member error never replaces the aggregate', async () => {
    mockRegistry.getNetwork.mockReturnValue({
      access: { readOrder: ['quorum'] },
      quorum: { k: 3, m: 2, timeoutMs: 5000 },
    });
    mockRegistry.getEndpoints.mockReturnValue(THREE_RPCS);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        error: { code: 3, message: 'execution reverted', data: '0xdeadbeef' },
      }),
    });
    const params = [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, 'latest'];
    await expect(request(100, 'eth_call', params))
      .rejects.toThrow(/^All chain sources failed for eth_call/);
  });

  test('without rankError a range limit neither ends the request nor is kept', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['quorum', 'direct'] },
        quorum: { k: 3, m: 2, timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue([...THREE_RPCS, 'https://d.example']);
      global.fetch.mockImplementation((url, options) => {
        if (url === 'https://a.example') return hangUntilAborted(url, options);
        return Promise.resolve({
          ok: true,
          json: async () => ({
            error: { code: -32005, message: 'query exceeds max block range 50000' },
          }),
        });
      });
      const pending = request(100, 'eth_getLogs', [{}], { directTimeoutMs: 60000 });
      pending.catch(() => {});
      await jest.advanceTimersByTimeAsync(70000);
      // Quorum waits for the hung member, Direct asks the untried d and then
      // retries a at the widened budget; the last endpoint's error is reported.
      await expect(pending).rejects.toThrow('RPC query timeout after 60000ms');
      expect(global.fetch.mock.calls.map(([url]) => url))
        .toEqual([...THREE_RPCS, 'https://d.example', 'https://a.example']);
    } finally {
      jest.useRealTimers();
    }
  });

  // R5-M1: a broadcast's later client timeout is an uncertain outcome and must
  // not be hidden behind an earlier endpoint's definite-looking rejection.
  test("a broadcast's later timeout is not hidden by an earlier RPC rejection", async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      mockMyotis.isReady.mockReturnValue(false);
      mockRegistry.getNetwork.mockReturnValue({
        access: { broadcastOrder: ['myotis', 'direct'] },
        quorum: { timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue(['https://a.example', 'https://b.example']);
      global.fetch.mockImplementation((url, options) => (url === 'https://a.example'
        ? Promise.resolve({
          ok: true,
          json: async () => ({ error: { code: -32005, message: 'rate limit exceeded' } }),
        })
        : hangUntilAborted(url, options)));
      const sent = broadcastRawTransaction(100, '0xsigned');
      sent.catch(() => {});
      await jest.advanceTimersByTimeAsync(5000);
      await expect(sent).rejects.toThrow('RPC query timeout after 5000ms');
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not broadcast at a second RPC after cancellation', async () => {
    mockRegistry.getNetwork.mockReturnValue({ access: { broadcastOrder: ['direct'] } });
    mockRegistry.getEndpoints.mockReturnValue(['https://one.example', 'https://two.example']);
    const controller = new AbortController();
    global.fetch.mockImplementation(async () => {
      controller.abort();
      throw new Error('disconnected');
    });
    await expect(broadcastRawTransaction(100, '0xsigned', { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  describe('source capabilities (#497)', () => {
    test('each source declares what it never serves', () => {
      expect(SOURCE_CAPABILITIES.colibri.unsupported.has('eth_getLogs')).toBe(true);
      for (const source of ['myotis', 'colibri', 'quorum']) {
        expect(SOURCE_CAPABILITIES[source].unsupported.has('eth_newFilter')).toBe(true);
        expect(SOURCE_CAPABILITIES[source].unsupported.has('web3_clientVersion')).toBe(true);
      }
      expect(SOURCE_CAPABILITIES.direct.unsupported.size).toBe(0);
      expect(SOURCE_CAPABILITIES.quorum.logSpan).toBe('learned-per-endpoint');
      expect(SOURCE_CAPABILITIES.myotis.cost).toBe('serialized');
    });

    test('names the sources that cannot serve a filter when none is left', async () => {
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['myotis', 'colibri', 'quorum'] },
        quorum: { timeoutMs: 5000 },
      });
      global.fetch = jest.fn();
      await expect(request(1, 'eth_newFilter', [{}])).rejects.toThrow(
        'No chain source left for eth_newFilter on chain 1: read order ' +
          '[myotis, colibri, quorum], excluded for this request: myotis, colibri, quorum'
      );
      expect(global.fetch).not.toHaveBeenCalled();
      expect(mockRequestViaColibri).not.toHaveBeenCalled();
    });
  });

  // Public Gnosis RPCs answer a query matching more than ~50k logs with only
  // the latest ~474 blocks' logs and no error (#496).
  describe('silently truncated eth_getLogs answers (#496)', () => {
    const HEAD = 48_574_494;
    const hex = (n) => `0x${n.toString(16)}`;
    const FULL = [{ fromBlock: hex(16_514_506), toBlock: hex(HEAD) }];
    const log = (block) => ({ blockNumber: hex(block), logIndex: '0x0' });
    const TAIL = [log(HEAD - 473), log(HEAD - 10)];

    function useRpc(answer) {
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['colibri', 'direct'] },
        quorum: { timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockImplementation((_chainId, role) =>
        role === 'prover' ? ['https://prover.example'] : ['https://a.example', 'https://b.example']
      );
      global.fetch = jest.fn(async (_url, options) => {
        const { params } = JSON.parse(options.body);
        const reply = answer(params[0]);
        return { ok: true, json: async () => reply };
      });
    }
    const asked = () =>
      global.fetch.mock.calls.map(([url, options]) => {
        const { fromBlock, toBlock } = JSON.parse(options.body).params[0];
        return `${new URL(url).hostname} ${fromBlock}-${toBlock}`;
      });

    test('logs before the answer\'s oldest one fail the request, at once', async () => {
      // The re-query is itself cut to its own latest blocks: any log proves it.
      useRpc(({ toBlock }) => ({
        result: toBlock === FULL[0].toBlock ? TAIL : [log(Number(toBlock) - 5)],
      }));
      const error = await request(100, 'eth_getLogs', FULL).catch((err) => err);
      expect(error).toMatchObject({ name: 'TruncatedLogsError', code: -32005 });
      expect(error.message).toMatch(
        /too many logs: the RPC returned only the 2 logs in the last 474 blocks of the 32059989-block range/
      );
      // The check asks the same source for the blocks before the oldest log;
      // no later endpoint or source is asked.
      expect(asked()).toEqual([
        `a.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `a.example ${FULL[0].fromBlock}-${hex(HEAD - 474)}`,
      ]);
      expect(mockRequestViaColibri).not.toHaveBeenCalled();
    });

    test('an answer whose earlier blocks hold no logs is accepted (a new wallet)', async () => {
      useRpc(({ toBlock }) => ({ result: toBlock === FULL[0].toBlock ? TAIL : [] }));
      await expect(request(100, 'eth_getLogs', FULL)).resolves.toMatchObject({
        result: TAIL,
        source: 'direct',
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('a failed check accepts the answer as before', async () => {
      useRpc(({ toBlock }) =>
        toBlock === FULL[0].toBlock
          ? { result: TAIL }
          : { error: { code: -32005, message: 'query exceeds max block range 10000' } }
      );
      await expect(request(100, 'eth_getLogs', FULL)).resolves.toMatchObject({ result: TAIL });
    });

    test('a Direct check is bounded to one endpoint attempt, not one per endpoint', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['direct'] },
        quorum: { timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue([
        'https://a.example', 'https://b.example', 'https://c.example',
      ]);
      // The full range answers at once; every check query hangs until aborted.
      global.fetch = jest.fn((_url, options) => {
        const { toBlock } = JSON.parse(options.body).params[0];
        if (toBlock === FULL[0].toBlock) {
          return Promise.resolve({ ok: true, json: async () => ({ result: TAIL }) });
        }
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      });
      let settled = false;
      const pending = request(100, 'eth_getLogs', FULL).finally(() => { settled = true; });
      await jest.advanceTimersByTimeAsync(4999);
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      // Accepted after one 5s budget, not 3 × 5s; later endpoints are never
      // started once the bound has run out.
      await expect(pending).resolves.toMatchObject({ result: TAIL, source: 'direct' });
      expect(asked()).toEqual([
        `a.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `a.example ${FULL[0].fromBlock}-${hex(HEAD - 474)}`,
      ]);
    });

    test('a Direct check asks the endpoint that answered, not a hung earlier one', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['direct'] },
        quorum: { timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue(['https://a.example', 'https://c.example']);
      // a hangs on everything; c cuts the full range to its tail and finds
      // logs before it.
      global.fetch = jest.fn((url, options) => {
        if (new URL(url).hostname === 'a.example') {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        const { toBlock } = JSON.parse(options.body).params[0];
        const result = toBlock === FULL[0].toBlock ? TAIL : [log(Number(toBlock) - 5)];
        return Promise.resolve({ ok: true, json: async () => ({ result }) });
      });
      const pending = request(100, 'eth_getLogs', FULL).catch((err) => err);
      await jest.advanceTimersByTimeAsync(5000);
      // The hung a must not use up the check's one attempt: the truncated
      // answer from c is caught by asking c.
      await expect(pending).resolves.toMatchObject({ name: 'TruncatedLogsError' });
      expect(asked()).toEqual([
        `a.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `c.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `c.example ${FULL[0].fromBlock}-${hex(HEAD - 474)}`,
      ]);
    });

    test('a Direct check of a reused quorum answer asks the member that gave it', async () => {
      jest.useFakeTimers({ now: 1_000_000 });
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['quorum', 'direct'] },
        quorum: { k: 3, m: 2, timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue([
        'https://a.example', 'https://b.example', 'https://c.example',
      ]);
      // a hangs on everything; b cuts the full range to its tail and finds
      // logs before it; c disagrees, so quorum fails and Direct reuses b's
      // answer without asking again.
      global.fetch = jest.fn((url, options) => {
        const host = new URL(url).hostname;
        if (host === 'a.example') {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        const { toBlock } = JSON.parse(options.body).params[0];
        const result = host === 'c.example'
          ? []
          : toBlock === FULL[0].toBlock ? TAIL : [log(Number(toBlock) - 5)];
        return Promise.resolve({ ok: true, json: async () => ({ result }) });
      });
      const pending = request(100, 'eth_getLogs', FULL).catch((err) => err);
      await jest.advanceTimersByTimeAsync(10_000);
      // The check goes to b, the member whose answer was reused, not through
      // a registry-order walk where the hung a would use up its one attempt.
      await expect(pending).resolves.toMatchObject({ name: 'TruncatedLogsError' });
      expect(asked()).toEqual([
        `a.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `b.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `c.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `b.example ${FULL[0].fromBlock}-${hex(HEAD - 474)}`,
      ]);
    });

    test.each([
      ['an empty answer', FULL, []],
      ['logs spread past the tail', FULL, [log(HEAD - LOG_TRUNCATION_TAIL_BLOCKS), log(HEAD)]],
      [
        'a range narrower than the minimum span',
        [{ fromBlock: hex(HEAD - LOG_TRUNCATION_MIN_SPAN + 2), toBlock: hex(HEAD) }],
        TAIL,
      ],
      ['a range ending at a tag', [{ fromBlock: FULL[0].fromBlock, toBlock: 'latest' }], TAIL],
      ['logs without a block number', FULL, [{ logIndex: '0x0' }]],
    ])('%s is not checked', async (_name, params, result) => {
      useRpc(() => ({ result }));
      await expect(request(100, 'eth_getLogs', params)).resolves.toMatchObject({ result });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('a quorum that agrees on a truncated answer is checked through the quorum', async () => {
      mockRegistry.getNetwork.mockReturnValue({
        access: { readOrder: ['quorum', 'direct'] },
        quorum: { k: 2, m: 2, timeoutMs: 5000 },
      });
      mockRegistry.getEndpoints.mockReturnValue(['https://a.example', 'https://b.example']);
      global.fetch = jest.fn(async (_url, options) => {
        const { toBlock } = JSON.parse(options.body).params[0];
        const result = toBlock === FULL[0].toBlock ? TAIL : [log(Number(toBlock) - 5)];
        return { ok: true, json: async () => ({ result }) };
      });
      await expect(request(100, 'eth_getLogs', FULL)).rejects.toMatchObject({
        name: 'TruncatedLogsError',
      });
      expect(asked()).toEqual([
        `a.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `b.example ${FULL[0].fromBlock}-${FULL[0].toBlock}`,
        `a.example ${FULL[0].fromBlock}-${hex(HEAD - 474)}`,
        `b.example ${FULL[0].fromBlock}-${hex(HEAD - 474)}`,
      ]);
    });
  });
});
