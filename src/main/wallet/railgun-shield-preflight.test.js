let mockEnrollment, mockMode, mockEndpoint;
const mockRpcOptions = jest.fn(),
  mockRequest = jest.fn(),
  mockRelease = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-shield-pins.json', () => {
  const pins = jest.requireActual('./railgun-shield-pins.json');
  const { keccak256 } = require('ethers');
  return {
    ...pins,
    codeHashes: Object.fromEntries(
      Object.keys(pins.codeHashes).map((n) => [n, keccak256('0x6001')])
    ),
  };
});
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (handle, role, options) => {
    mockRpcOptions(options);
    const { getPrivacyContext } = require('../networks/privacy-context');
    const context = getPrivacyContext(handle);
    expect(role).toBe('protocol-rpc');
    expect(context.subject.operation).toBe('shield-preflight');
    return {
      request: mockRequest,
      release: mockRelease,
      signal: AbortSignal.any([context.signal, mockEndpoint.signal]),
      assertActive: () => {
        getPrivacyContext(handle);
        if (mockEndpoint.signal.aborted) throw Error('endpoint revoked');
      },
    };
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { Interface, id, toBeHex } = require('ethers');
const {
  createRailgunShieldPreflight,
  assertRailgunShieldPreflight,
  MAX_AGE_MS,
} = require('./railgun-shield-preflight');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([
  'function railgun() view returns (address)',
  'function wBase() view returns (address)',
  'function shieldFee() view returns (uint120)',
  'function tokenBlocklist(address) view returns (bool)',
]);
const block = { number: '0xb4911f', hash: '0x' + '1'.repeat(64), timestamp: '0x0' };
let scope, source;
beforeEach(() => {
  jest.clearAllMocks();
  mockMode = null;
  block.timestamp = toBeHex(Math.floor(Date.now() / 1000));
  mockEndpoint = new AbortController();
  scope = createPrivacyScope({ profileId: 'preflight-test', signal: new AbortController().signal });
  mockEnrollment = {
    signal: scope.signal,
    getContext: (role, operation) =>
      scope.getContext({
        kind: 'private-account',
        principal: 'railgun:0',
        protocol: 'railgun',
        deployment: 'sepolia',
        chainId: 11155111,
        role,
        operation,
      }),
  };
  mockRequest.mockImplementation(async (method, params, validate) => {
    let result;
    if (method === 'eth_getBlockByNumber')
      result =
        mockMode === 'head' && params[0] !== 'latest'
          ? { ...block, hash: '0x' + '2'.repeat(64) }
          : block;
    else if (method === 'eth_getCode')
      result =
        mockMode === 'code' ||
        (mockMode === 'implementation-code' && params[0] === pins.implementation)
          ? '0x6002'
          : '0x6001';
    else if (method === 'eth_getStorageAt') {
      const implementation = toBeHex(BigInt(id('eip1967.proxy.implementation')) - 1n, 32);
      result =
        params[1] === implementation
          ? '0x' + pins.implementation.slice(2).padStart(64, '0')
          : '0x' + '0'.repeat(64);
      if (
        mockMode === 'slot' ||
        (mockMode === 'implementation' && params[1] === implementation) ||
        (mockMode === 'paused' && params[1] !== implementation)
      )
        result = '0x' + '1'.repeat(64);
    } else if (method === 'eth_call') {
      const parsed = abi.parseTransaction(params[0]);
      const values = {
        railgun: mockMode === 'relay' ? pins.relayAdapt : pins.proxy,
        wBase: mockMode === 'weth' ? pins.proxy : pins.wrappedNative,
        shieldFee: mockMode === 'fee' ? 26 : 25,
        tokenBlocklist: mockMode === 'blocked',
      };
      result = abi.encodeFunctionResult(parsed.name, [values[parsed.name]]).toLowerCase();
      if (mockMode === 'padding') result += '00';
    } else throw Error('Unexpected request');
    if (!validate(result))
      throw Object.assign(Error('Invalid response'), { code: 'PRIVATE_RPC_INVALID' });
    return { result };
  });
  source = createRailgunShieldPreflight(mockEnrollment);
});
afterEach(() => {
  source.close();
  scope.close();
  jest.restoreAllMocks();
});
test('fixed code/slot/getter reads share one canonical latest anchor; receipts are branded and bounded', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const acquired = await source.acquire();
  expect(assertRailgunShieldPreflight(source, acquired.receipt, mockEnrollment)).toEqual({
    anchor: block,
    shieldFeeBps: 25,
    deploymentMatched: true,
    trust: 'unverified-rpc',
    signingEnabled: false,
  });
  expect(mockRequest).toHaveBeenCalledTimes(12);
  for (const [method, params] of mockRequest.mock.calls)
    if (method !== 'eth_getBlockByNumber')
      expect(params.at(-1)).toEqual({ blockHash: block.hash, requireCanonical: true });
  expect(() =>
    assertRailgunShieldPreflight({ ...source }, acquired.receipt, mockEnrollment)
  ).toThrow();
  expect(() => assertRailgunShieldPreflight(source, {}, mockEnrollment)).toThrow();
  now = 99;
  expect(() => source.assertResult(acquired.receipt)).toThrow();
  now = 100 + MAX_AGE_MS;
  expect(() => source.assertResult(acquired.receipt)).toThrow();
  now = 100;
  await source.acquire();
  expect(() => source.assertResult(acquired.receipt)).toThrow();
});
test.each([
  'code',
  'implementation-code',
  'implementation',
  'paused',
  'slot',
  'relay',
  'weth',
  'fee',
  'blocked',
  'padding',
  'head',
])('changed or malformed %s refuses and releases transport', async (mode) => {
  mockMode = mode;
  const expected = {
    code: ['mismatch', 'code-proxy'],
    'implementation-code': ['mismatch', 'code-implementation'],
    implementation: ['mismatch', 'slot-implementation'],
    paused: ['mismatch', 'slot-paused'],
    slot: ['mismatch', 'slot-implementation'],
    relay: ['mismatch', 'getter-railgun'],
    weth: ['mismatch', 'getter-wBase'],
    fee: ['mismatch', 'getter-shieldFee'],
    blocked: ['mismatch', 'getter-tokenBlocklist'],
    padding: ['rpc', 'getter-railgun'],
    head: ['stale', 'anchor-recheck'],
  }[mode];
  await expect(source.acquire()).rejects.toMatchObject({ reason: expected[0], step: expected[1] });
  expect(mockRelease).toHaveBeenCalledTimes(1);
  expect(source.signal.aborted).toBe(true);
});
test.each(['lock', 'endpoint'])('late response after %s cannot issue evidence', async (kind) => {
  let release;
  mockRequest.mockImplementationOnce(async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return { result: block };
  });
  const pending = source.acquire(),
    refused = expect(pending).rejects.toThrow();
  await expect(source.acquire()).rejects.toThrow();
  if (kind === 'lock') scope.close();
  else mockEndpoint.abort();
  release();
  await refused;
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
test('forged enrollment is refused before obtaining a transport', () => {
  expect(() => createRailgunShieldPreflight({ ...mockEnrollment })).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('slow acquisition cannot renew anchor freshness at completion', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  const original = mockRequest.getMockImplementation();
  mockRequest.mockImplementation(async (...args) => {
    const value = await original(...args);
    now += 6000;
    return value;
  });
  await expect(source.acquire()).rejects.toThrow();
  expect(source.signal.aborted).toBe(true);
  expect(mockRequest.mock.calls.length).toBeLessThan(12);
});

test.each(['old', 'future', 'height'])(
  'stale %s anchor refuses before code reads',
  async (mode) => {
    if (mode === 'height') block.number = '0x64';
    else block.timestamp = toBeHex(Math.floor(Date.now() / 1000) + (mode === 'old' ? -121 : 31));
    await expect(source.acquire()).rejects.toMatchObject({ reason: 'stale', step: 'anchor' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    block.number = '0xb4911f';
  }
);
test('RPC refusal is classified separately from a deployment mismatch', async () => {
  mockRequest.mockRejectedValueOnce(Error('network details not exposed'));
  await expect(source.acquire()).rejects.toMatchObject({
    reason: 'rpc',
    step: 'anchor',
    causeCode: 'UNCLASSIFIED',
  });
});
test.each(['connect', 'tls', 'socket-new', 'socket-reused', 'response', 'unclassified'])(
  'a deployment RPC preserves the closed Tor stage %s',
  async (stage) => {
    mockRequest.mockRejectedValueOnce(
      Object.assign(Error('private details'), { code: 'TOR_REQUEST_FAILED', stage })
    );
    const error = await source.acquire().catch((error) => error);
    expect(error).toMatchObject({
      reason: 'rpc',
      step: 'anchor',
      causeCode: 'TOR_REQUEST_FAILED',
      causeStage: stage,
    });
    expect(JSON.stringify(error)).not.toContain('private details');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test.each(['accessor', 'inherited', 'unknown', 'wrong-code'])(
  'a %s deployment transport stage is not forwarded',
  async (kind) => {
    const error = Object.assign(Error('private details'), {
      code: kind === 'wrong-code' ? 'PRIVATE_RPC_INVALID' : 'TOR_REQUEST_FAILED',
    });
    const getter = jest.fn(() => 'connect');
    if (kind === 'accessor') Object.defineProperty(error, 'stage', { get: getter });
    else if (kind === 'inherited') Object.setPrototypeOf(error, { stage: 'connect' });
    else error.stage = kind === 'unknown' ? 'https://private.example' : 'connect';
    mockRequest.mockRejectedValueOnce(error);
    const result = await source.acquire().catch((error) => error);
    expect(result).not.toHaveProperty('causeStage');
    expect(getter).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test.each(['accessor', 'inherited', 'proxy', 'object'])(
  'a %s RPC error code is never evaluated',
  async (kind) => {
    const trap = jest.fn(() => {
      throw Error('private details');
    });
    let error = { stage: 'connect' };
    if (kind === 'accessor') Object.defineProperty(error, 'code', { get: trap });
    if (kind === 'inherited') Object.setPrototypeOf(error, { code: 'TOR_REQUEST_FAILED' });
    if (kind === 'proxy') error = new Proxy(error, { get: trap, getOwnPropertyDescriptor: trap });
    if (kind === 'object') error.code = { toString: trap };
    mockRequest.mockRejectedValueOnce(error);
    const result = await source.acquire().catch((value) => value);
    expect(result).toMatchObject({ reason: 'rpc', step: 'anchor', causeCode: 'UNCLASSIFIED' });
    expect(result).not.toHaveProperty('causeStage');
    expect(trap).not.toHaveBeenCalled();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  }
);
test('foreign enrollment cannot use a genuine receipt', async () => {
  const result = await source.acquire();
  const original = mockEnrollment;
  mockEnrollment = { ...original };
  expect(() => assertRailgunShieldPreflight(source, result.receipt, mockEnrollment)).toThrow();
  mockEnrollment = original;
});

test('optional protocol constraint reaches deployment RPC before first query', () => {
  const constraint = Object.freeze({});
  source.close();
  source = createRailgunShieldPreflight(mockEnrollment, { destinationConstraint: constraint });
  expect(mockRpcOptions).toHaveBeenLastCalledWith({ destinationConstraint: constraint });
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each([null, false, { destinationConstraint: {}, bypass: true }])(
  'malformed preflight options refuse without network work',
  (options) => {
    expect(() => createRailgunShieldPreflight(mockEnrollment, options)).toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  }
);
