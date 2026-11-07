const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({
  info: (...args) => mockLogInfo(...args),
  warn: (...args) => mockLogWarn(...args),
}));

// Colibri runs in a worker thread (colibri-worker-host / colibri-worker); this
// suite covers the main-process client lifecycle above it, so the host is
// replaced by in-process fake clients. The worker side has its own suites.
// Mock-prefixed names so Jest's "out-of-scope variable" guard permits them
// in the factory (the factory runs before top-level `const` initializers).
// Every client's `request` goes through `mockRequest(client, ...)`, so a
// test scripts answers across rebuilds and sees which client asked.
const mockCreateClient = jest.fn();
const mockEnsureWorker = jest.fn(() => Promise.resolve());
const mockRequest = jest.fn();
const mockClientInstances = [];
jest.mock('./colibri-worker-host', () => ({
  ensureWorker: (...args) => mockEnsureWorker(...args),
  createClient: (config) => {
    mockCreateClient(config);
    const client = {
      config,
      destroy: jest.fn(),
    };
    client.request = jest.fn((...args) => mockRequest(client, ...args));
    mockClientInstances.push(client);
    return client;
  },
}));

// The registry is mocked; tests still pump a legacy-shaped object via
// mockLoadSettings and the mock translates the two fields this module
// reads (prover URL, zkProof) into the registry shape.
const mockLoadSettings = jest.fn();
jest.mock('../networks/network-registry', () => ({
  getNetwork: () => ({ zkProof: (mockLoadSettings() || {}).ensColibriZkProof !== false }),
  getEndpoints: (_chainId, role) =>
    role === 'prover'
      // Empty setting → the builtin prover (stand-in for colibri-corpus).
      ? [((mockLoadSettings() || {}).ensColibriProverUrl || 'https://test-prover.example').trim()]
      : [],
}));

// Only hostOf is imported. Re-exporting the whole ens-resolver here would
// pull every ENS dependency into the test.
jest.mock('../ens-resolver', () => ({
  hostOf: (url) => { try { return new URL(url).host; } catch { return url; } },
}));

const colibriResolver = require('./colibri-resolver');
const { requestViaColibri, clearColibriClientForTest } = colibriResolver;

const DEFAULTS = {
  ensColibriProverUrl: '',
  ensColibriZkProof: true,
};

beforeEach(() => {
  clearColibriClientForTest();
  jest.clearAllMocks();
  mockClientInstances.length = 0;
  mockLoadSettings.mockReturnValue({ ...DEFAULTS });
  mockRequest.mockResolvedValue('0x2a');
});

// Colibri 3.0.3 runs an `eth_call` on contract code from a public RPC,
// unchecked against the proven code hash, and proves nothing for a call
// that reads no storage. So it serves no ENS, reverse or NameNFT lookup
// (#1076): the module has no adapter for one.
test('offers chain-data requests only, with no name-resolution adapter', () => {
  expect(Object.keys(colibriResolver).sort()).toEqual([
    'clearColibriClientForTest',
    'requestViaColibri',
  ]);
});

describe('the Colibri client', () => {
  const BLOCK = ['eth_blockNumber', []];
  const asked = (client, method = 'eth_blockNumber', params = []) => [
    client,
    { method, params },
    { deadlineMs: undefined },
  ];

  test('constructs the worker client lazily with the configured prover', async () => {
    expect(mockCreateClient).not.toHaveBeenCalled();
    await requestViaColibri(1, ...BLOCK);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledWith({
      chainId: 1,
      proverUrl: 'https://test-prover.example',
      zkProof: true,
    });
  });

  test('waits for the chain worker before creating the first client', async () => {
    await requestViaColibri(1, ...BLOCK);
    expect(mockEnsureWorker).toHaveBeenCalledWith(1);
    expect(mockEnsureWorker.mock.invocationCallOrder[0])
      .toBeLessThan(mockCreateClient.mock.invocationCallOrder[0]);
  });

  test('fails the request when the chain worker cannot start', async () => {
    mockEnsureWorker.mockRejectedValueOnce(new Error('Colibri worker failed to start: boom'));
    await expect(requestViaColibri(1, ...BLOCK)).rejects.toThrow(/failed to start/);
    expect(mockCreateClient).not.toHaveBeenCalled();
    await expect(requestViaColibri(1, ...BLOCK)).resolves.toBe('0x2a');
  });

  test('reuses the singleton across calls when settings are unchanged', async () => {
    await requestViaColibri(1, ...BLOCK);
    await requestViaColibri(1, 'eth_getBalance', ['0xabc', 'latest']);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockRequest).toHaveBeenCalledWith(
      ...asked(mockClientInstances[0], 'eth_getBalance', ['0xabc', 'latest'])
    );
  });

  test('concurrent first calls collapse onto one construction', async () => {
    const results = await Promise.all([
      requestViaColibri(1, ...BLOCK),
      requestViaColibri(1, ...BLOCK),
      requestViaColibri(1, ...BLOCK),
    ]);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['0x2a', '0x2a', '0x2a']);
  });

  test('rebuilds the client when the prover URL changes', async () => {
    await requestViaColibri(1, ...BLOCK);
    const firstClient = mockClientInstances[0];
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://other-prover.example',
    });
    await requestViaColibri(1, ...BLOCK);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient.mock.calls[1][0].proverUrl).toBe('https://other-prover.example');
    expect(firstClient.destroy).toHaveBeenCalledTimes(1);
    expect(mockClientInstances[1].destroy).not.toHaveBeenCalled();
  });

  test('rebuilds the client when zk_proof toggles', async () => {
    await requestViaColibri(1, ...BLOCK);
    mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
    await requestViaColibri(1, ...BLOCK);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient.mock.calls[1][0].zkProof).toBe(false);
  });

  test('does not let an obsolete in-flight build replace newer settings', async () => {
    let releaseWorker;
    mockEnsureWorker.mockImplementationOnce(() => new Promise((resolve) => { releaseWorker = resolve; }));

    const first = requestViaColibri(1, 'eth_getBalance', ['0x01', 'latest']);
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://new-prover.example',
    });
    const second = requestViaColibri(1, 'eth_getBalance', ['0x02', 'latest']);

    releaseWorker();
    await Promise.all([first, second]);

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    const byProver = (url) => mockClientInstances.find((c) => c.config.proverUrl === url);
    const oldClient = byProver('https://test-prover.example');
    const newClient = byProver('https://new-prover.example');
    expect(oldClient.destroy).toHaveBeenCalledTimes(1);
    expect(newClient.destroy).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledWith(...asked(newClient, 'eth_getBalance', ['0x01', 'latest']));
    expect(mockRequest).toHaveBeenCalledWith(...asked(newClient, 'eth_getBalance', ['0x02', 'latest']));
    expect(oldClient.request).not.toHaveBeenCalled();
  });

  test('respects a custom prover URL from settings', async () => {
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://custom.example/keyXYZ',
    });
    await requestViaColibri(1, ...BLOCK);
    expect(mockCreateClient.mock.calls[0][0].proverUrl).toBe('https://custom.example/keyXYZ');
  });

  test('propagates errors from the client (e.g. verification failure)', async () => {
    const err = new Error('proof verification failed');
    mockRequest.mockRejectedValue(err);
    await expect(requestViaColibri(1, ...BLOCK)).rejects.toBe(err);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  test('rebuilds once and retries a CALL_EXCEPTION without revert data', async () => {
    const err = Object.assign(new Error('full ethers message with 0x' + 'ab'.repeat(200)), {
      code: 'CALL_EXCEPTION',
      shortMessage: 'missing revert data',
      info: { error: { code: -32603, message: 'prover returned no response' } },
    });
    mockRequest.mockRejectedValueOnce(err).mockResolvedValueOnce('0xfeed');

    await expect(requestViaColibri(1, ...BLOCK)).resolves.toBe('0xfeed');

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockClientInstances[0].destroy).toHaveBeenCalledTimes(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      '[colibri] chain 1 request failed; rebuilding client and retrying once ' +
      'error="missing revert data" code=CALL_EXCEPTION rpcCode=-32603 ' +
      'rpcMessage="prover returned no response" revert=none'
    );
  });

  test('bounds a retryable failure to one rebuild', async () => {
    const err = Object.assign(new Error('request timed out'), { code: 'TIMEOUT' });
    mockRequest.mockRejectedValue(err);

    await expect(requestViaColibri(1, ...BLOCK)).rejects.toBe(err);

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  test('does not destroy a failed shared client while a sibling request still uses it', async () => {
    let rejectFirst;
    let resolveSibling;
    mockRequest
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSibling = resolve; }))
      .mockResolvedValueOnce('0xrecovered');

    const first = requestViaColibri(1, ...BLOCK);
    const sibling = requestViaColibri(1, ...BLOCK);
    while (mockRequest.mock.calls.length < 2) await Promise.resolve();
    const sharedClient = mockClientInstances[0];

    rejectFirst(Object.assign(new Error('network unavailable'), { code: 'NETWORK_ERROR' }));
    await expect(first).resolves.toBe('0xrecovered');
    expect(sharedClient.destroy).not.toHaveBeenCalled();

    resolveSibling('0xsibling');
    await expect(sibling).resolves.toBe('0xsibling');
    expect(sharedClient.destroy).toHaveBeenCalledTimes(1);
  });

  test('does not retry an EVM revert carrying verified revert data', async () => {
    const err = Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      data: '0xdeadbeef',
    });
    mockRequest.mockRejectedValue(err);

    await expect(requestViaColibri(1, ...BLOCK)).rejects.toBe(err);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });
});

describe('requestViaColibri', () => {
  test('creates and reuses an independent Gnosis client', async () => {
    mockLoadSettings.mockReturnValue({ ...DEFAULTS });
    await expect(
      requestViaColibri(100, 'eth_getBalance', ['0xabc', 'latest'])
    ).resolves.toBe('0x2a');
    const gnosisClient = mockClientInstances[0];
    expect(mockCreateClient).toHaveBeenCalledWith(expect.objectContaining({ chainId: 100 }));
    expect(gnosisClient.request).toHaveBeenCalledWith({
      method: 'eth_getBalance',
      params: ['0xabc', 'latest'],
    }, { deadlineMs: undefined });

    await requestViaColibri(1, 'eth_blockNumber');
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  test('hands the caller deadline to the worker client', async () => {
    await requestViaColibri(100, 'eth_call', [{}, 'latest'], { deadlineMs: 2000 });
    expect(mockClientInstances[0].request).toHaveBeenCalledWith(
      { method: 'eth_call', params: [{}, 'latest'] },
      { deadlineMs: 2000 },
    );
  });

  test('rebuilds the affected chain client once after a network failure', async () => {
    await requestViaColibri(100, 'eth_blockNumber');
    const firstClient = mockClientInstances[0];
    firstClient.request
      .mockRejectedValueOnce(Object.assign(new Error('network unavailable'), {
        code: 'NETWORK_ERROR',
      }));

    await expect(requestViaColibri(100, 'eth_blockNumber')).resolves.toBe('0x2a');

    expect(firstClient.destroy).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockClientInstances[1].request).toHaveBeenCalledTimes(1);
  });
});
