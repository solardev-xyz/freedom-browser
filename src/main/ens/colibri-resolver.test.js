jest.mock('electron', () => ({
  // CCIP gateways are dialled through Electron `net` (#359); the automatic-CCIP
  // tests below swap in a fake `request`.
  net: { request: () => ({}) },
}));

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
const mockCreateClient = jest.fn();
const mockEnsureWorker = jest.fn(() => Promise.resolve());
const mockClientInstances = [];
jest.mock('./colibri-worker-host', () => ({
  ensureWorker: (...args) => mockEnsureWorker(...args),
  createClient: (config) => {
    mockCreateClient(config);
    const client = {
      config,
      destroy: jest.fn(),
      request: jest.fn().mockResolvedValue('0x2a'),
    };
    mockClientInstances.push(client);
    return client;
  },
}));

const mockBrowserProvider = jest.fn().mockImplementation((client) => ({ kind: 'browser-provider', client }));
jest.mock('ethers', () => ({
  ethers: { BrowserProvider: mockBrowserProvider },
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

// Surgical: only stub the two symbols this module imports. Re-exporting the
// whole ens-resolver here would pull every ENS dependency into the test.
const mockUniversalResolverCall = jest.fn();
const mockUniversalResolverReverse = jest.fn();
jest.mock('../ens-resolver', () => ({
  universalResolverCall: (...args) => mockUniversalResolverCall(...args),
  universalResolverReverse: (...args) => mockUniversalResolverReverse(...args),
  hostOf: (url) => { try { return new URL(url).host; } catch { return url; } },
}));

const {
  resolveViaColibri,
  resolveReverseViaColibri,
  requestViaColibri,
  clearColibriClientForTest,
} = require('./colibri-resolver');

const DEFAULTS = {
  ensColibriProverUrl: '',
  ensColibriZkProof: true,
};

// Exercise ethers' actual automatic CCIP path. A mock UR that only returns
// canned data cannot detect an unbounded inherited BrowserProvider fetcher.
describe('automatic CCIP through the Colibri provider', () => {
  test.each(['forward', 'reverse'])(
    '%s callbacks use the bounded gateway fetcher',
    async (direction) => {
      const { ethers } = jest.requireActual('ethers');
      const abi = ethers.AbiCoder.defaultAbiCoder();
      const ur = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';
      const iface = new ethers.Interface([
        'error OffchainLookup(address sender,string[] urls,bytes callData,bytes4 callbackFunction,bytes extraData)',
      ]);
      let provider;
      mockBrowserProvider.mockImplementationOnce((client) => {
        provider = new ethers.BrowserProvider(client);
        client.request.mockImplementation(async ({ method, params }) => {
          if (method === 'eth_chainId') return '0x1';
          if (method !== 'eth_call') throw new Error(`Unexpected RPC ${method}`);
          if (params[0].data.startsWith('0x12345678')) return '0xcafe';
          throw Object.assign(new Error('execution reverted'), {
            code: 3,
            data: iface.encodeErrorResult('OffchainLookup', [
              ur,
              ['https://ccip.example/{data}'],
              '0xbeef',
              '0x12345678',
              '0xdead',
            ]),
          });
        });
        return provider;
      });
      const resolve =
        direction === 'forward' ? mockUniversalResolverCall : mockUniversalResolverReverse;
      resolve.mockImplementationOnce((p) =>
        p.call({ to: ur, data: '0xabcdef01', enableCcipRead: true })
      );
      const inherited = jest
        .spyOn(ethers.AbstractProvider.prototype, 'ccipReadFetch')
        .mockRejectedValue(new Error('unbounded inherited fetch must not run'));
      // CCIP gateways are dialled through Electron `net` (#359).
      const electron = require('electron');
      const { createNetMock, emitResponse } = require('../../../test/helpers/fake-electron-net');
      const originalNetRequest = electron.net.request;
      const net = createNetMock((request) =>
        emitResponse(request, { chunks: [JSON.stringify({ data: '0xabcd' })] })
      );
      electron.net.request = net.request;
      try {
        const result =
          direction === 'forward'
            ? await resolveViaColibri('test.offchaindemo.eth', '0x')
            : await resolveReverseViaColibri(ethers.getBytes(ur), 2147492101n);
        expect(result).toBe('0xcafe');
        expect(inherited).not.toHaveBeenCalled();
        expect(net.request).toHaveBeenCalledTimes(1);
        expect(mockClientInstances[0].request).toHaveBeenCalledWith({
          method: 'eth_call',
          params: [
            {
              to: ur.toLowerCase(),
              data: '0x12345678' + abi.encode(['bytes', 'bytes'], ['0xabcd', '0xdead']).slice(2),
            },
            'latest',
          ],
        });
      } finally {
        provider?.destroy();
        inherited.mockRestore();
        electron.net.request = originalNetRequest;
      }
    }
  );
});

beforeEach(() => {
  clearColibriClientForTest();
  jest.clearAllMocks();
  mockClientInstances.length = 0;
  mockLoadSettings.mockReturnValue({ ...DEFAULTS });
  mockUniversalResolverCall.mockResolvedValue({
    resolvedData: '0xdeadbeef',
    resolverAddress: '0x000000000000000000000000000000000000ffff',
  });
  mockUniversalResolverReverse.mockResolvedValue({ name: 'vitalik.eth' });
});

describe('resolveViaColibri', () => {
  test('constructs the worker client lazily with the configured prover', async () => {
    expect(mockCreateClient).not.toHaveBeenCalled();
    await resolveViaColibri('vitalik.eth', '0xbc1c58d1...');
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledWith({
      chainId: 1,
      proverUrl: 'https://test-prover.example',
      zkProof: true,
    });
  });

  test('waits for the chain worker before creating the first client', async () => {
    await resolveViaColibri('a.eth', '0x');
    expect(mockEnsureWorker).toHaveBeenCalledWith(1);
    expect(mockEnsureWorker.mock.invocationCallOrder[0])
      .toBeLessThan(mockCreateClient.mock.invocationCallOrder[0]);
  });

  test('fails the request when the chain worker cannot start', async () => {
    mockEnsureWorker.mockRejectedValueOnce(new Error('Colibri worker failed to start: boom'));
    await expect(resolveViaColibri('a.eth', '0x')).rejects.toThrow(/failed to start/);
    expect(mockCreateClient).not.toHaveBeenCalled();
    await expect(resolveViaColibri('b.eth', '0x')).resolves.toBeDefined();
  });

  test('reuses the singleton across calls when settings are unchanged', async () => {
    await resolveViaColibri('one.eth', '0x');
    await resolveViaColibri('two.eth', '0x');
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
  });

  test('concurrent first calls collapse onto one construction', async () => {
    const [a, b, c] = await Promise.all([
      resolveViaColibri('a.eth', '0x'),
      resolveViaColibri('b.eth', '0x'),
      resolveViaColibri('c.eth', '0x'),
    ]);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(c).toBeDefined();
  });

  test('rebuilds the client when the prover URL changes', async () => {
    await resolveViaColibri('one.eth', '0x');
    const firstClient = mockClientInstances[0];
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://other-prover.example',
    });
    await resolveViaColibri('two.eth', '0x');
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient.mock.calls[1][0].proverUrl).toBe('https://other-prover.example');
    expect(mockBrowserProvider).toHaveBeenCalledTimes(2);
    expect(firstClient.destroy).toHaveBeenCalledTimes(1);
    expect(mockClientInstances[1].destroy).not.toHaveBeenCalled();
  });

  test('rebuilds the client when zk_proof toggles', async () => {
    await resolveViaColibri('one.eth', '0x');
    mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
    await resolveViaColibri('two.eth', '0x');
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    expect(mockCreateClient.mock.calls[1][0].zkProof).toBe(false);
  });

  test('does not let an obsolete in-flight build replace newer settings', async () => {
    let releaseWorker;
    mockEnsureWorker.mockImplementationOnce(() => new Promise((resolve) => { releaseWorker = resolve; }));

    const first = resolveViaColibri('old.eth', '0x');
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://new-prover.example',
    });
    const second = resolveViaColibri('new.eth', '0x');

    releaseWorker();
    await Promise.all([first, second]);

    expect(mockCreateClient).toHaveBeenCalledTimes(2);
    const byProver = (url) => mockClientInstances.find((c) => c.config.proverUrl === url);
    const oldClient = byProver('https://test-prover.example');
    const newClient = byProver('https://new-prover.example');
    expect(oldClient.destroy).toHaveBeenCalledTimes(1);
    expect(newClient.destroy).not.toHaveBeenCalled();
    expect(mockUniversalResolverCall).toHaveBeenCalledWith(
      expect.objectContaining({ client: newClient }),
      'old.eth',
      '0x',
    );
    expect(mockUniversalResolverCall).toHaveBeenCalledWith(
      expect.objectContaining({ client: newClient }),
      'new.eth',
      '0x',
    );
  });

  test('respects a custom prover URL from settings', async () => {
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://custom.example/keyXYZ',
    });
    await resolveViaColibri('a.eth', '0x');
    expect(mockCreateClient.mock.calls[0][0].proverUrl).toBe('https://custom.example/keyXYZ');
  });

  test('passes name + callData through to universalResolverCall via the cached BrowserProvider', async () => {
    await resolveViaColibri('vitalik.eth', '0xbc1c58d1deadbeef');
    expect(mockUniversalResolverCall).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'browser-provider' }),
      'vitalik.eth',
      '0xbc1c58d1deadbeef',
    );
  });

  test('returns the universalResolverCall payload verbatim', async () => {
    const payload = {
      resolvedData: '0xfeedface',
      resolverAddress: '0x000000000000000000000000000000000000beef',
    };
    mockUniversalResolverCall.mockResolvedValue(payload);
    await expect(resolveViaColibri('a.eth', '0x')).resolves.toEqual(payload);
  });

  test('propagates errors from universalResolverCall (e.g. verification failure)', async () => {
    const err = new Error('proof verification failed');
    mockUniversalResolverCall.mockRejectedValue(err);
    await expect(resolveViaColibri('a.eth', '0x')).rejects.toBe(err);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  test('rebuilds once and retries a CALL_EXCEPTION without revert data', async () => {
    const err = Object.assign(new Error('full ethers message with 0x' + 'ab'.repeat(200)), {
      code: 'CALL_EXCEPTION',
      shortMessage: 'missing revert data',
      info: { error: { code: -32603, message: 'prover returned no response' } },
    });
    const recovered = { resolvedData: '0xfeed', resolverAddress: '0x1234' };
    mockUniversalResolverCall
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(recovered);

    await expect(resolveViaColibri('retry.eth', '0x')).resolves.toEqual(recovered);

    expect(mockUniversalResolverCall).toHaveBeenCalledTimes(2);
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
    mockUniversalResolverCall.mockRejectedValue(err);

    await expect(resolveViaColibri('still-down.eth', '0x')).rejects.toBe(err);

    expect(mockUniversalResolverCall).toHaveBeenCalledTimes(2);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  test('does not destroy a failed shared client while a sibling request still uses it', async () => {
    let rejectFirst;
    let resolveSibling;
    mockUniversalResolverCall
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveSibling = resolve; }))
      .mockResolvedValueOnce({ resolvedData: '0xrecovered' });

    const first = resolveViaColibri('first.eth', '0x');
    const sibling = resolveViaColibri('sibling.eth', '0x');
    while (mockUniversalResolverCall.mock.calls.length < 2) await Promise.resolve();
    const sharedClient = mockClientInstances[0];

    rejectFirst(Object.assign(new Error('network unavailable'), { code: 'NETWORK_ERROR' }));
    await expect(first).resolves.toEqual({ resolvedData: '0xrecovered' });
    expect(sharedClient.destroy).not.toHaveBeenCalled();

    resolveSibling({ resolvedData: '0xsibling' });
    await expect(sibling).resolves.toEqual({ resolvedData: '0xsibling' });
    expect(sharedClient.destroy).toHaveBeenCalledTimes(1);
  });

  test('does not retry an EVM revert carrying verified revert data', async () => {
    const err = Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION',
      data: '0xdeadbeef',
    });
    mockUniversalResolverCall.mockRejectedValue(err);

    await expect(resolveViaColibri('reverted.eth', '0x')).rejects.toBe(err);

    expect(mockUniversalResolverCall).toHaveBeenCalledTimes(1);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });
});

describe('resolveReverseViaColibri', () => {
  const ADDR_BYTES = new Uint8Array(20).fill(0xab);

  test('delegates to universalResolverReverse via the cached BrowserProvider', async () => {
    const result = await resolveReverseViaColibri(ADDR_BYTES);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
    expect(mockUniversalResolverReverse).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'browser-provider' }),
      ADDR_BYTES,
      {},
      60n,
    );
    expect(result).toEqual({ name: 'vitalik.eth' });
  });

  test('reuses the singleton + cached provider across forward and reverse calls', async () => {
    await resolveViaColibri('vitalik.eth', '0x');
    await resolveReverseViaColibri(ADDR_BYTES);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
  });

  test('propagates errors verbatim (caller classifies)', async () => {
    const err = Object.assign(new Error('ReverseAddressMismatch'), { data: '0xef9c03ce' });
    mockUniversalResolverReverse.mockRejectedValue(err);
    await expect(resolveReverseViaColibri(ADDR_BYTES)).rejects.toBe(err);
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
