const mockGetPath = jest.fn();
jest.mock('electron', () => ({
  app: { getPath: (...args) => mockGetPath(...args) },
}));

const mockLogInfo = jest.fn();
const mockLogWarn = jest.fn();
jest.mock('../logger', () => ({
  info: (...args) => mockLogInfo(...args),
  warn: (...args) => mockLogWarn(...args),
}));

const mockMkdirSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();
const mockUnlinkSync = jest.fn();
jest.mock('node:fs', () => ({
  mkdirSync: (...args) => mockMkdirSync(...args),
  readFileSync: (...args) => mockReadFileSync(...args),
  writeFileSync: (...args) => mockWriteFileSync(...args),
  unlinkSync: (...args) => mockUnlinkSync(...args),
}));

// Mock-prefixed names so Jest's "out-of-scope variable" guard permits them
// in the factory (the factory runs before top-level `const` initializers).
const mockColibriCtor = jest.fn();
const mockRegisterStorage = jest.fn(() => Promise.resolve());
const mockClientInstances = [];
jest.mock('@corpus-core/colibri-stateless', () => {
  class FakeColibri {
    constructor(config) {
      mockColibriCtor(config);
      this.config = config;
      this.destroy = jest.fn();
      this.request = jest.fn().mockResolvedValue('0x2a');
      mockClientInstances.push(this);
    }
    static register_storage(storage) { return mockRegisterStorage(storage); }
  }
  return {
    __esModule: true,
    default: FakeColibri,
    Strategy: { VerifiedOnly: Symbol('VerifiedOnly') },
  };
});
const { Strategy } = require('@corpus-core/colibri-stateless');

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

beforeEach(() => {
  clearColibriClientForTest();
  jest.clearAllMocks();
  mockClientInstances.length = 0;
  mockGetPath.mockReturnValue('/tmp/freedom-test-userdata');
  mockLoadSettings.mockReturnValue({ ...DEFAULTS });
  mockUniversalResolverCall.mockResolvedValue({
    resolvedData: '0xdeadbeef',
    resolverAddress: '0x000000000000000000000000000000000000ffff',
  });
  mockUniversalResolverReverse.mockResolvedValue({ name: 'vitalik.eth' });
});

describe('resolveViaColibri', () => {
  test('constructs the client lazily with the partner-confirmed config', async () => {
    expect(mockColibriCtor).not.toHaveBeenCalled();
    await resolveViaColibri('vitalik.eth', '0xbc1c58d1...');
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
    expect(mockColibriCtor).toHaveBeenCalledWith({
      chainId: 1,
      prover: ['https://test-prover.example'],
      zk_proof: true,
      privacy_mode: 'basic',
      proofStrategy: Strategy.VerifiedOnly,
      max_latest_age_seconds: 60,
    });
  });

  test('registers disk storage exactly once and before the first client constructor', async () => {
    await resolveViaColibri('a.eth', '0x');
    await resolveViaColibri('b.eth', '0x');
    expect(mockRegisterStorage).toHaveBeenCalledTimes(1);
    expect(mockRegisterStorage.mock.invocationCallOrder[0])
      .toBeLessThan(mockColibriCtor.mock.invocationCallOrder[0]);
  });

  test('does not re-register storage on a settings-driven rebuild', async () => {
    await resolveViaColibri('a.eth', '0x');
    mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
    await resolveViaColibri('b.eth', '0x');
    expect(mockRegisterStorage).toHaveBeenCalledTimes(1);
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
  });

  test('reuses the singleton across calls when settings are unchanged', async () => {
    await resolveViaColibri('one.eth', '0x');
    await resolveViaColibri('two.eth', '0x');
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(1);
  });

  test('concurrent first calls collapse onto one construction', async () => {
    const [a, b, c] = await Promise.all([
      resolveViaColibri('a.eth', '0x'),
      resolveViaColibri('b.eth', '0x'),
      resolveViaColibri('c.eth', '0x'),
    ]);
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
    expect(mockRegisterStorage).toHaveBeenCalledTimes(1);
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
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
    expect(mockColibriCtor.mock.calls[1][0].prover).toEqual(['https://other-prover.example']);
    expect(mockBrowserProvider).toHaveBeenCalledTimes(2);
    expect(firstClient.destroy).toHaveBeenCalledTimes(1);
    expect(mockClientInstances[1].destroy).not.toHaveBeenCalled();
  });

  test('rebuilds the client when zk_proof toggles', async () => {
    await resolveViaColibri('one.eth', '0x');
    mockLoadSettings.mockReturnValue({ ...DEFAULTS, ensColibriZkProof: false });
    await resolveViaColibri('two.eth', '0x');
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
    expect(mockColibriCtor.mock.calls[1][0].zk_proof).toBe(false);
  });

  test('does not let an obsolete in-flight build replace newer settings', async () => {
    let releaseStorage;
    mockRegisterStorage.mockImplementationOnce(() => new Promise((resolve) => { releaseStorage = resolve; }));

    const first = resolveViaColibri('old.eth', '0x');
    mockLoadSettings.mockReturnValue({
      ...DEFAULTS,
      ensColibriProverUrl: 'https://new-prover.example',
    });
    const second = resolveViaColibri('new.eth', '0x');

    releaseStorage();
    await Promise.all([first, second]);

    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
    expect(mockClientInstances[0].config.prover).toEqual(['https://test-prover.example']);
    expect(mockClientInstances[1].config.prover).toEqual(['https://new-prover.example']);
    expect(mockClientInstances[0].destroy).toHaveBeenCalledTimes(1);
    expect(mockClientInstances[1].destroy).not.toHaveBeenCalled();
    expect(mockUniversalResolverCall).toHaveBeenCalledWith(
      expect.objectContaining({ client: mockClientInstances[1] }),
      'old.eth',
      '0x',
    );
    expect(mockUniversalResolverCall).toHaveBeenCalledWith(
      expect.objectContaining({ client: mockClientInstances[1] }),
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
    expect(mockColibriCtor.mock.calls[0][0].prover).toEqual(['https://custom.example/keyXYZ']);
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
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
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
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
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
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
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
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
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
    );
    expect(result).toEqual({ name: 'vitalik.eth' });
  });

  test('reuses the singleton + cached provider across forward and reverse calls', async () => {
    await resolveViaColibri('vitalik.eth', '0x');
    await resolveReverseViaColibri(ADDR_BYTES);
    expect(mockColibriCtor).toHaveBeenCalledTimes(1);
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
    expect(mockColibriCtor).toHaveBeenCalledWith(expect.objectContaining({ chainId: 100 }));
    expect(gnosisClient.request).toHaveBeenCalledWith({
      method: 'eth_getBalance',
      params: ['0xabc', 'latest'],
    });

    await requestViaColibri(1, 'eth_blockNumber');
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
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
    expect(mockColibriCtor).toHaveBeenCalledTimes(2);
    expect(mockClientInstances[1].request).toHaveBeenCalledTimes(1);
  });
});

describe('disk storage adapter', () => {
  // Captured from the register_storage call after triggering construction.
  // No public export — the integration assertion (passed to register_storage)
  // is more valuable than unit-testing the adapter in isolation.
  async function captureStorage() {
    await resolveViaColibri('a.eth', '0x');
    return mockRegisterStorage.mock.calls[0][0];
  }

  test('creates the colibri subdirectory under app userData on first use', async () => {
    await captureStorage();
    expect(mockGetPath).toHaveBeenCalledWith('userData');
    expect(mockMkdirSync).toHaveBeenCalledWith(
      '/tmp/freedom-test-userdata/colibri',
      { recursive: true },
    );
  });

  test('get/set/del route through fs against the colibri subdirectory', async () => {
    const storage = await captureStorage();
    mockReadFileSync.mockReturnValue(Buffer.from([1, 2, 3]));
    expect(storage.get('states_1')).toEqual(Buffer.from([1, 2, 3]));
    expect(mockReadFileSync).toHaveBeenCalledWith('/tmp/freedom-test-userdata/colibri/states_1');

    storage.set('sync_1_42', new Uint8Array([9, 9]));
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/tmp/freedom-test-userdata/colibri/sync_1_42',
      new Uint8Array([9, 9]),
    );

    storage.del('states_1');
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/freedom-test-userdata/colibri/states_1');
  });

  test('get returns null when the underlying file is missing (warm-cache miss)', async () => {
    const storage = await captureStorage();
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(storage.get('missing')).toBeNull();
  });

  test('del absorbs ENOENT but rethrows other errors (e.g. permission)', async () => {
    const storage = await captureStorage();
    mockUnlinkSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(() => storage.del('already-gone')).not.toThrow();

    mockUnlinkSync.mockImplementation(() => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); });
    expect(() => storage.del('locked')).toThrow(/EACCES/);
  });
});
