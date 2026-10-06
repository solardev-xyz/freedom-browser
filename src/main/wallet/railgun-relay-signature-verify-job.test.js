const mockVerify = jest.fn(),
  mockPoseidon = jest.fn();
let mockInit;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => '/relay-engine.asar'),
}));
jest.mock(
  '/relay-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockInit;
    },
    poseidon: (...args) => mockPoseidon(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    verifyEDDSA: (...args) => mockVerify(...args),
    getPublicSpendingKey: () => {
      throw Error('Key derivation forbidden');
    },
    signEDDSA: () => {
      throw Error('Signing forbidden');
    },
  }),
  { virtual: true }
);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let fixture, input, context, controller, run;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockVerify.mockReset().mockReturnValue(true);
  mockPoseidon.mockReset().mockReturnValue(11n);
  mockInit = Promise.resolve();
  fixture =
    require('../../../scripts/fixtures/railgun-relay-unsigned-data').createRailgunRelayUnsignedData();
  input = {
    archive: '/relay-engine.asar',
    intent: fixture.draft.intent,
    recordDigest: '12'.repeat(32),
    signature: { R8: [hex(8), hex(9)], S: hex(10) },
    spendingPublicKey: [hex(5), hex(6)],
  };
  controller = new AbortController();
  context = {
    signal: controller.signal,
    request: jest.fn(async () => JSON.stringify({ id: 1, value: null })),
    guardReport: jest.fn(() => ({ attempts: 0, hooks: ['controlled-test'], canaries: 1 })),
  };
  Object.defineProperty(context, 'requestKey', {
    get() {
      throw Error('No key capability may be read');
    },
  });
  run = require('./railgun-relay-signature-verify-job').run;
});
const invoke = () => run(JSON.stringify(input), context);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let i = 0; i < 20 && !predicate(); i++) await Promise.resolve();
  expect(predicate()).toBe(true);
}

test('keyless verifier independently hashes five ordered inputs and returns only public binding', async () => {
  await invoke();
  const expected = input.intent.expected;
  expect(mockPoseidon).toHaveBeenCalledWith(
    [
      expected.merkleRoot,
      expected.boundParamsHash,
      expected.nullifier,
      expected.feeCommitment,
      expected.selfCommitment,
    ].map(BigInt)
  );
  expect(mockVerify).toHaveBeenCalledTimes(1);
  expect(mockVerify).toHaveBeenCalledWith(11n, { R8: [8n, 9n], S: 10n }, [5n, 6n]);
  expect(context.request).toHaveBeenCalledTimes(1);
  const signatureDigest = require('crypto')
    .createHash('sha256')
    .update(JSON.stringify({ R8: [hex(8), hex(9)], S: hex(10) }))
    .digest('hex');
  expect(JSON.parse(context.request.mock.calls[0][0])).toEqual({
    id: 1,
    method: 'result',
    value: {
      recordDigest: input.recordDigest,
      intentDigest: require('./railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(
        input.intent
      ).digest,
      message: hex(11),
      signatureDigest,
      signatureVerified: true,
      guards: context.guardReport(),
      inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    },
  });
  await expect(invoke()).rejects.toThrow();
  expect(context.request).toHaveBeenCalledTimes(1);
});
test('normalized signature property order defines the digest, not incoming order', async () => {
  input.signature = { S: hex(10), R8: [hex(8), hex(9)] };
  await invoke();
  expect(JSON.parse(context.request.mock.calls[0][0]).value.signatureDigest).toBe(
    require('crypto')
      .createHash('sha256')
      .update(JSON.stringify({ R8: [hex(8), hex(9)], S: hex(10) }))
      .digest('hex')
  );
});
test.each([
  'extra',
  'missing signature',
  'record digest',
  'key length',
  'key field',
  'key uppercase',
  'signature extra',
  'signature R8 length',
  'signature R8 field',
  'signature S subgroup',
  'kind',
  'nonzero proof',
  'bound hash',
  'fee order',
  'abort',
])('invalid %s refuses without result and consumes the attempt', async (kind) => {
  if (kind === 'extra') input.extra = true;
  if (kind === 'missing signature') delete input.signature;
  if (kind === 'record digest') input.recordDigest = 'x';
  if (kind === 'key length') input.spendingPublicKey.push(hex(1));
  if (kind === 'key field') input.spendingPublicKey[0] = '0x' + 'f'.repeat(64);
  if (kind === 'key uppercase') input.spendingPublicKey[0] = '0x' + 'A'.repeat(64);
  if (kind === 'signature extra') input.signature.extra = true;
  if (kind === 'signature R8 length') input.signature.R8.push(hex(1));
  if (kind === 'signature R8 field') input.signature.R8[0] = '0x' + 'f'.repeat(64);
  if (kind === 'signature S subgroup')
    input.signature.S =
      hex(2736030358979909402780800718157159386076813972158567259200215660948447373041n);
  if (kind === 'kind') input.intent.expected.kind = 'railgun-private-transfer';
  if (kind === 'nonzero proof') {
    fixture.inner.proof.a.x = 1;
    input.intent = fixture.build();
  }
  if (kind === 'bound hash') input.intent.expected.boundParamsHash = hex(12);
  if (kind === 'fee order')
    [input.intent.expected.feeCommitment, input.intent.expected.selfCommitment] = [
      input.intent.expected.selfCommitment,
      input.intent.expected.feeCommitment,
    ];
  if (kind === 'abort') controller.abort();
  await expect(invoke()).rejects.toThrow();
  await expect(invoke()).rejects.toThrow();
  expect(mockVerify).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
});
test('coherent calldata commitment swap cannot retain the original expected message', async () => {
  fixture.inner.commitments.reverse();
  [fixture.expected.feeCommitment, fixture.expected.selfCommitment] = [
    fixture.expected.selfCommitment,
    fixture.expected.feeCommitment,
  ];
  input.intent = fixture.build();
  mockPoseidon.mockImplementation((values) => (values.at(-2) === 10n ? 12n : 11n));
  await expect(invoke()).rejects.toThrow();
  expect(mockPoseidon).toHaveBeenCalledTimes(1);
  expect(mockVerify).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
});
test.each([
  'false',
  'truthy',
  'throw',
  'different hash',
  'guard before',
  'guard after',
  'abort after',
])('%s verification cannot publish a result', async (mode) => {
  if (mode === 'false') mockVerify.mockReturnValue(false);
  if (mode === 'truthy') mockVerify.mockReturnValue(1);
  if (mode === 'throw')
    mockVerify.mockImplementation(() => {
      throw Error('verification failed');
    });
  if (mode === 'different hash') input.intent.expectedHash = hex(12);
  if (mode === 'guard before') context.guardReport.mockReturnValue({ attempts: 1 });
  if (mode === 'guard after')
    mockVerify.mockImplementation(() => {
      context.guardReport.mockReturnValue({ attempts: 1 });
      return true;
    });
  if (mode === 'abort after')
    mockVerify.mockImplementation(() => {
      controller.abort();
      return true;
    });
  await expect(invoke()).rejects.toThrow();
  expect(context.request).not.toHaveBeenCalled();
});
test('abort waits for original poseidon initialization settlement', async () => {
  const init = deferred();
  mockInit = init.promise;
  let settled = false;
  const pending = invoke();
  pending.catch(() => {
    settled = true;
  });
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  init.resolve();
  await expect(pending).rejects.toThrow();
  expect(mockVerify).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
});
test('original init rejection is preserved without any result', async () => {
  const init = deferred(),
    error = new Error('init');
  mockInit = init.promise;
  const pending = invoke();
  init.reject(error);
  await expect(pending).rejects.toBe(error);
  expect(context.request).not.toHaveBeenCalled();
});
test.each(['resolve', 'reject'])(
  'abort during original result request waits for %s',
  async (mode) => {
    const result = deferred(),
      error = new Error('broker');
    context.request.mockReturnValue(result.promise);
    const pending = invoke();
    let settled = false;
    pending.catch(() => {
      settled = true;
    });
    await until(() => context.request.mock.calls.length === 1);
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    if (mode === 'resolve') {
      result.resolve(JSON.stringify({ id: 1, value: null }));
      await expect(pending).rejects.toThrow();
    } else {
      result.reject(error);
      await expect(pending).rejects.toBe(error);
    }
  }
);
test.each([
  { id: 2, value: null },
  { id: 1, value: true },
  { id: 1, value: null, extra: true },
])('wrong original acknowledgement %j refuses', async (value) => {
  context.request.mockResolvedValue(JSON.stringify(value));
  await expect(invoke()).rejects.toThrow();
});
test.each(['oversize', 'nonstring', 'malformed'])(
  '%s input refuses before runtime load',
  async (mode) => {
    const text = mode === 'oversize' ? ' '.repeat(65537) : mode === 'nonstring' ? input : '{';
    await expect(run(text, context)).rejects.toThrow();
    expect(require('./railgun-engine-runtime').verifyRailgunEngineRuntime).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
  }
);
