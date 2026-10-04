let mockEnrollment, mockEndpoint, mockDeployment, mockBase, mockMode;
const mockRpcOptions = jest.fn(),
  mockDeploymentOptions = jest.fn(),
  mockRequest = jest.fn(),
  mockRelease = jest.fn(),
  mockLoad = jest.fn(),
  mockVerifier = jest.fn();
jest.mock('./railgun-account-enrollment', () => ({
  isRailgunAccountEnrollment: (v) => v === mockEnrollment,
}));
jest.mock('./railgun-shield-preflight', () => ({
  MAX_AGE_MS: 60000,
  createRailgunShieldPreflight: (enrollment, options) => {
    mockDeploymentOptions(enrollment, options);
    return mockDeployment;
  },
  assertRailgunShieldPreflight: (source, receipt, enrollment) => {
    if (
      source !== mockDeployment ||
      receipt !== mockBase ||
      enrollment !== mockEnrollment ||
      source.signal.aborted
    )
      throw Error('deployment refused');
    return source.assertResult(receipt);
  },
}));
jest.mock('./railgun-artifacts', () => ({
  loadRailgunArtifacts: (...args) => mockLoad(...args),
  assertRailgunArtifactVerifier: (...args) => mockVerifier(...args),
}));
jest.mock('../networks/private-rpc', () => ({
  createPrivateRpc: (handle, role, options) => {
    mockRpcOptions(options);
    const { getPrivacyContext } = require('../networks/privacy-context');
    const context = getPrivacyContext(handle);
    expect(role).toBe('protocol-rpc');
    expect(context.subject.operation).toBe('private-preflight');
    return {
      request: mockRequest,
      release: mockRelease,
      signal: AbortSignal.any([context.signal, mockEndpoint.signal]),
      assertActive() {
        getPrivacyContext(handle);
        if (mockEndpoint.signal.aborted) throw Error('endpoint');
      },
    };
  },
}));
const { createPrivacyScope } = require('../networks/privacy-context');
const { Interface } = require('ethers');
const {
  createRailgunPrivatePreflight,
  assertRailgunPrivatePreflight,
  MAX_AGE_MS,
} = require('./railgun-private-preflight');
const pins = require('./railgun-shield-pins.json');
const abi = new Interface([
  'function rootHistory(uint256,bytes32) view returns (bool)',
  'function nullifiers(uint256,bytes32) view returns (bool)',
  'function unshieldFee() view returns (uint120)',
  'function getVerificationKey(uint256,uint256)',
]);
const anchor = { number: '0xb4911f', hash: '0x' + '1'.repeat(64), timestamp: '0x123456' };
const input = () => ({
  tree: 0,
  merkleRoot: '0x' + '1'.repeat(64),
  nullifier: '0x' + '2'.repeat(64),
  checkpointHash: '3'.repeat(64),
  minimumBlock: 11800000,
});
let scope, source, artifacts;
function open(selected = input()) {
  if (mockDeployment.signal.aborted) {
    const controller = new AbortController();
    mockDeployment = {
      ...mockDeployment,
      signal: controller.signal,
      close: jest.fn(() => controller.abort()),
    };
  }
  return createRailgunPrivatePreflight({
    enrollment: mockEnrollment,
    input: selected,
    artifactDirectory: '/fixture/artifacts',
  });
}
beforeEach(() => {
  jest.resetAllMocks();
  mockMode = null;
  scope = createPrivacyScope({
    profileId: 'private-preflight',
    signal: new AbortController().signal,
  });
  mockEndpoint = new AbortController();
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
  const controller = new AbortController();
  mockBase = Object.freeze({});
  mockDeployment = {
    signal: controller.signal,
    acquire: jest.fn(async () => ({ receipt: mockBase })),
    assertResult: jest.fn(() => ({ anchor: Object.freeze({ ...anchor }) })),
    close: jest.fn(() => controller.abort()),
  };
  artifacts = { wasm: Buffer.alloc(4, 1), zkey: Buffer.alloc(4, 2), vkey: {} };
  mockLoad.mockImplementation(async () => {
    if (mockMode === 'artifacts') throw Error('artifacts');
    return artifacts;
  });
  mockVerifier.mockImplementation((a, encoded) => {
    expect(a).toBe(artifacts);
    expect(encoded).toBe('0x1234');
    if (mockMode === 'verifier') throw Error('verifier mismatch');
  });
  mockRequest.mockImplementation(async (method, params, validate) => {
    let result;
    if (method === 'eth_getBlockByNumber')
      result = { ...anchor, ...(mockMode === 'anchor' ? { hash: '0x' + '9'.repeat(64) } : {}) };
    else {
      expect(method).toBe('eth_call');
      expect(params[0].to).toBe(pins.proxy);
      const parsed = abi.parseTransaction(params[0]);
      if (parsed.name === 'getVerificationKey') {
        expect([...parsed.args]).toEqual([1n, 1n]);
        result = '0x1234';
      } else
        result = abi.encodeFunctionResult(parsed.name, [
          {
            rootHistory: mockMode !== 'root',
            nullifiers: mockMode === 'spent',
            unshieldFee: mockMode === 'fee' ? 26n : 25n,
          }[parsed.name],
        ]);
      if (mockMode === 'padding') result += '00';
    }
    if (!validate(result)) throw Error('RPC refused');
    return { result };
  });
  source = open();
});
afterEach(() => {
  source.close();
  scope.close();
  jest.restoreAllMocks();
});
test('deployment, input and verifier observations share one canonical block without granting ownership', async () => {
  const acquired = await source.acquire();
  expect(JSON.parse(JSON.stringify(acquired.observation))).toStrictEqual(acquired.observation);
  expect(assertRailgunPrivatePreflight(source, acquired.receipt, mockEnrollment)).toEqual({
    anchor,
    input: input(),
    deploymentMatched: true,
    verifierMatched: true,
    rootAccepted: true,
    inputUnspent: true,
    unshieldFeeBps: 25,
    trust: 'unverified-rpc',
    ownershipVerified: false,
    signingEnabled: false,
  });
  expect(mockRequest).toHaveBeenCalledTimes(5);
  for (const [method, params] of mockRequest.mock.calls) {
    if (method === 'eth_call')
      expect(params[1]).toEqual({ blockHash: anchor.hash, requireCanonical: true });
    else expect(params).toEqual([anchor.number, false]);
  }
  const calls = mockRequest.mock.calls
    .filter(([method]) => method === 'eth_call')
    .map(([, params]) => abi.parseTransaction(params[0]));
  expect([...calls[0].args]).toEqual([0n, input().merkleRoot]);
  expect(calls.map((call) => call.name)).toEqual([
    'rootHistory',
    'unshieldFee',
    'getVerificationKey',
    'nullifiers',
  ]);
  expect([...calls[3].args]).toEqual([0n, input().nullifier]);
  expect(artifacts.wasm.every((v) => v === 0)).toBe(true);
  expect(artifacts.zkey.every((v) => v === 0)).toBe(true);
  expect(() =>
    assertRailgunPrivatePreflight({ ...source }, acquired.receipt, mockEnrollment)
  ).toThrow();
  expect(() => source.assertResult({ ...acquired.receipt })).toThrow();
});
test('selection is copied before any asynchronous read', async () => {
  source.close();
  const selected = input();
  source = open(selected);
  selected.nullifier = '0x' + '0'.repeat(64);
  const acquired = await source.acquire();
  expect(acquired.observation.input).toEqual(input());
  expect(Object.isFrozen(acquired.observation.input)).toBe(true);
});
test.each(['root', 'spent', 'fee', 'verifier', 'padding', 'anchor', 'artifacts'])(
  'changed %s refuses without evidence and closes both transports',
  async (mode) => {
    mockMode = mode;
    await expect(source.acquire()).rejects.toMatchObject({
      code: 'RAILGUN_PRIVATE_PREFLIGHT_REFUSED',
    });
    expect(source.signal.aborted).toBe(true);
    expect(mockDeployment.close).toHaveBeenCalledTimes(1);
    expect(mockRelease).toHaveBeenCalledTimes(1);
    if (mode !== 'artifacts') expect(artifacts.wasm.every((v) => v === 0)).toBe(true);
    if (['root', 'fee', 'verifier', 'artifacts'].includes(mode))
      expect(
        mockRequest.mock.calls
          .filter(([method]) => method === 'eth_call')
          .some(([, params]) => abi.parseTransaction(params[0]).name === 'nullifiers')
      ).toBe(false);
  }
);
test('source age starts before deployment acquisition and supports a conservative signing margin', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockDeployment.acquire.mockImplementation(async () => {
    now += 20000;
    return { receipt: mockBase };
  });
  const acquired = await source.acquire();
  source.assertResult(acquired.receipt, 39999);
  expect(() => source.assertResult(acquired.receipt, 40000)).toThrow();
  expect(() => source.assertResult(acquired.receipt, -1)).toThrow();
  expect(() => source.assertResult(acquired.receipt, MAX_AGE_MS)).toThrow();
  now = 99;
  expect(() => source.assertResult(acquired.receipt)).toThrow();
  now = 60100;
  expect(() => source.assertResult(acquired.receipt)).toThrow();
});
test('slow local artifacts or RPC cannot renew deployment freshness', async () => {
  let now = 100;
  jest.spyOn(performance, 'now').mockImplementation(() => now);
  mockLoad.mockImplementation(async () => {
    now += MAX_AGE_MS;
    return artifacts;
  });
  await expect(source.acquire()).rejects.toMatchObject({ reason: 'stale' });
  expect(mockRequest).not.toHaveBeenCalled();
});
test('a header below the captured public checkpoint refuses before private input reads', async () => {
  source.close();
  source = open({ ...input(), minimumBlock: 20000000 });
  await expect(source.acquire()).rejects.toMatchObject({ reason: 'stale' });
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each(['lock', 'endpoint', 'close'])(
  'late response after %s cannot issue evidence',
  async (kind) => {
    let release;
    mockRequest.mockImplementationOnce(async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { result: abi.encodeFunctionResult('rootHistory', [true]) };
    });
    const pending = source.acquire(),
      refused = expect(pending).rejects.toThrow();
    while (!release) await Promise.resolve();
    await expect(source.acquire()).rejects.toThrow();
    if (kind === 'lock') scope.close();
    else if (kind === 'endpoint') mockEndpoint.abort();
    else source.close();
    release();
    await refused;
    expect(mockRelease).toHaveBeenCalledTimes(1);
  }
);
test.each([
  { tree: 65536 },
  { nullifier: '0x' + 'f'.repeat(64) },
  { merkleRoot: '0x' + 'A'.repeat(64) },
  { checkpointHash: 'x' },
  { minimumBlock: -1 },
  { extra: true },
])('malformed selection refuses before transport (%#)', (invalid) => {
  expect(() => open({ ...input(), ...invalid })).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test('new acquisition revokes older receipts, and deployment expiry is still enforced', async () => {
  const first = await source.acquire();
  await source.acquire();
  expect(() => source.assertResult(first.receipt)).toThrow();
  const last = await source.acquire();
  mockDeployment.assertResult.mockImplementation(() => {
    throw Error('expired base');
  });
  expect(() => source.assertResult(last.receipt)).toThrow();
});
test('an already revoked endpoint refuses construction and drains the newly acquired transport', () => {
  mockEndpoint.abort();
  mockRelease.mockClear();
  expect(() => open()).toThrow();
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
test('a forged enrollment never acquires an RPC source', () => {
  expect(() =>
    createRailgunPrivatePreflight({
      enrollment: { ...mockEnrollment },
      input: input(),
      artifactDirectory: '/fixture/artifacts',
    })
  ).toThrow();
  expect(mockRequest).not.toHaveBeenCalled();
});
test.each(['deployment', 'private'])(
  'RPC cause codes survive %s failures without raw diagnostics',
  async (kind) => {
    if (kind === 'deployment')
      mockDeployment.acquire.mockRejectedValueOnce(
        Object.assign(Error('secret endpoint detail'), {
          reason: 'rpc',
          causeCode: 'TOR_REQUEST_FAILED',
        })
      );
    else
      mockRequest.mockRejectedValueOnce(
        Object.assign(Error('secret request detail'), { code: 'TOR_REQUEST_FAILED' })
      );
    const error = await source.acquire().catch((error) => error);
    expect(error).toMatchObject({
      reason: 'rpc',
      causeCode: 'TOR_REQUEST_FAILED',
      step: kind === 'deployment' ? 'deployment' : 'rootHistory',
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Railgun private preflight unavailable');
    expect(error.cause).toBeUndefined();
    expect(require('util').inspect(error)).not.toContain('secret');
  }
);
test('untrusted RPC error codes are redacted', async () => {
  mockRequest.mockRejectedValueOnce(
    Object.assign(Error('secret'), { code: 'https://secret-endpoint.example' })
  );
  await expect(source.acquire()).rejects.toMatchObject({
    reason: 'rpc',
    causeCode: 'UNCLASSIFIED',
  });
});
test('deployment mismatch never queries the private input', async () => {
  mockDeployment.acquire.mockRejectedValueOnce(
    Object.assign(Error('deployment mismatch'), { reason: 'mismatch' })
  );
  await expect(source.acquire()).rejects.toMatchObject({ reason: 'mismatch', step: 'deployment' });
  expect(mockRequest).not.toHaveBeenCalled();
});
test('revocation during verifier comparison is inactive, not a governance mismatch', async () => {
  mockVerifier.mockImplementation(() => {
    scope.close();
    throw Error('revoked artifact');
  });
  await expect(source.acquire()).rejects.toMatchObject({ reason: 'inactive', step: 'verifier' });
});

test('one protocol restriction reaches both deployment and selected-nullifier clients', () => {
  const constraint = Object.freeze({});
  source = createRailgunPrivatePreflight({
    enrollment: mockEnrollment,
    input: input(),
    artifactDirectory: '/fixture/artifacts',
    destinationConstraint: constraint,
  });
  expect(mockDeploymentOptions).toHaveBeenLastCalledWith(mockEnrollment, {
    destinationConstraint: constraint,
  });
  expect(mockRpcOptions).toHaveBeenLastCalledWith({ destinationConstraint: constraint });
});
