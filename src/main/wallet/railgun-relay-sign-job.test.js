const mockPublic = jest.fn(),
  mockSign = jest.fn(),
  mockVerify = jest.fn(),
  mockPoseidon = jest.fn();
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => '/relay-engine.asar'),
}));
jest.mock(
  '/relay-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    initPoseidonPromise: Promise.resolve(),
    poseidon: (...args) => mockPoseidon(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    getPublicSpendingKey: (...args) => mockPublic(...args),
    signEDDSA: (...args) => mockSign(...args),
    verifyEDDSA: (...args) => mockVerify(...args),
  }),
  { virtual: true }
);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let fixture, input, context, controller, bytes, run;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  fixture =
    require('../../../scripts/fixtures/railgun-relay-unsigned-data').createRailgunRelayUnsignedData();
  input = {
    archive: '/relay-engine.asar',
    intent: fixture.draft.intent,
    recordDigest: '12'.repeat(32),
    spendingPublicKey: [hex(5), hex(6)],
  };
  controller = new AbortController();
  bytes = new Uint8Array(32).fill(7);
  mockPoseidon.mockReturnValue(11n);
  mockPublic.mockReturnValue([5n, 6n]);
  mockSign.mockReturnValue({ R8: [8n, 9n], S: 10n });
  mockVerify.mockReturnValue(true);
  context = {
    signal: controller.signal,
    requestKey: jest.fn(async () => bytes),
    request: jest.fn(async () => JSON.stringify({ id: 2, value: null })),
    guardReport: jest.fn(() => ({ attempts: 0, hooks: ['test'], canaries: 1 })),
  };
  run = require('./railgun-relay-sign-job').run;
});
const invoke = () => run(JSON.stringify(input), context);
test('one relay signature independently hashes all five ordered calldata inputs and wipes before result', async () => {
  context.request.mockImplementation(async () => {
    expect([...bytes]).toEqual(Array(32).fill(0));
    return JSON.stringify({ id: 2, value: null });
  });
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
  const intentDigest = require('./railgun-relay-intent').normalizeRailgunRelayUnsignedIntent(
    input.intent
  ).digest;
  expect(JSON.parse(context.requestKey.mock.calls[0][0])).toEqual({
    id: 1,
    method: 'key',
    purpose: 'relay-sign',
    recordDigest: input.recordDigest,
    intentDigest,
    expectedHash: hex(11),
  });
  expect(mockVerify).toHaveBeenCalledWith(11n, { R8: [8n, 9n], S: 10n }, [5n, 6n]);
  expect(JSON.parse(context.request.mock.calls[0][0])).toEqual({
    id: 2,
    method: 'result',
    value: {
      signature: { R8: [hex(8), hex(9)], S: hex(10) },
      message: hex(11),
      recordDigest: input.recordDigest,
      intentDigest,
      guards: context.guardReport(),
      inventory: require('./railgun-engine-manifest.json').inventory.sha256,
    },
  });
  expect(mockSign).toHaveBeenCalledTimes(1);
  await expect(invoke()).rejects.toThrow();
  expect(context.requestKey).toHaveBeenCalledTimes(1);
});
test.each([
  'extra',
  'record digest',
  'public key',
  'kind',
  'nonzero proof',
  'expected hash',
  'fee order',
  'bound hash',
  'abort',
  'guard',
])('invalid %s refuses before any spending loan', async (kind) => {
  if (kind === 'extra') input.extra = true;
  if (kind === 'record digest') input.recordDigest = 'x';
  if (kind === 'public key') input.spendingPublicKey[1] = '0x' + 'ff'.repeat(32);
  if (kind === 'kind') input.intent.expected.kind = 'railgun-private-transfer';
  if (kind === 'nonzero proof') {
    fixture.inner.proof.a.x = 1;
    input.intent = fixture.build();
  }
  if (kind === 'expected hash') input.intent.expectedHash = hex(12);
  if (kind === 'fee order')
    [input.intent.expected.feeCommitment, input.intent.expected.selfCommitment] = [
      input.intent.expected.selfCommitment,
      input.intent.expected.feeCommitment,
    ];
  if (kind === 'bound hash') input.intent.expected.boundParamsHash = hex(12);
  if (kind === 'abort') controller.abort();
  if (kind === 'guard') context.guardReport.mockReturnValue({ attempts: 1 });
  await expect(invoke()).rejects.toThrow();
  expect(context.requestKey).not.toHaveBeenCalled();
  expect(mockSign).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
  // A refused invocation cannot be retried inside the same utility.
  await expect(invoke()).rejects.toThrow();
  expect(context.requestKey).not.toHaveBeenCalled();
});
test('coherently swapped fee/self calldata still cannot retain the original message', async () => {
  fixture.inner.commitments.reverse();
  [fixture.expected.feeCommitment, fixture.expected.selfCommitment] = [
    fixture.expected.selfCommitment,
    fixture.expected.feeCommitment,
  ];
  input.intent = fixture.build();
  mockPoseidon.mockImplementation((values) => (values.at(-2) === 10n ? 12n : 11n));
  await expect(invoke()).rejects.toThrow();
  expect(mockPoseidon).toHaveBeenCalledTimes(1);
  expect(context.requestKey).not.toHaveBeenCalled();
});
test.each([
  'short key',
  'wrong public key',
  'sign throws',
  'verify fails',
  'bad signature',
  'abort after loan',
  'guard after loan',
  'abort after signing',
])('%s wipes received bytes and suppresses result', async (kind) => {
  if (kind === 'short key') bytes = new Uint8Array(31).fill(7);
  if (kind === 'wrong public key') mockPublic.mockReturnValue([5n, 7n]);
  if (kind === 'sign throws')
    mockSign.mockImplementationOnce(() => {
      throw Error('sign');
    });
  if (kind === 'verify fails') mockVerify.mockReturnValue(false);
  if (kind === 'bad signature') mockSign.mockReturnValue({ R8: [8n, 9n], S: 1n << 254n });
  if (kind === 'abort after loan')
    context.requestKey.mockImplementation(async () => {
      controller.abort();
      return bytes;
    });
  if (kind === 'guard after loan')
    context.requestKey.mockImplementation(async () => {
      context.guardReport.mockReturnValue({ attempts: 1 });
      return bytes;
    });
  if (kind === 'abort after signing')
    mockSign.mockImplementationOnce(() => {
      controller.abort();
      return { R8: [8n, 9n], S: 10n };
    });
  await expect(invoke()).rejects.toThrow();
  expect([...bytes]).toEqual(Array(bytes.length).fill(0));
  expect(context.request).not.toHaveBeenCalled();
});
test('only the admitted 32-byte key view is wiped', async () => {
  const backing = new Uint8Array(40).fill(7);
  bytes = backing.subarray(4, 36);
  await invoke();
  expect([...backing]).toEqual([...Array(4).fill(7), ...Array(32).fill(0), ...Array(4).fill(7)]);
});
test('abort while original key request is pending waits for its original return and wipes', async () => {
  let resolve;
  context.requestKey.mockReturnValue(
    new Promise((yes) => {
      resolve = yes;
    })
  );
  const pending = invoke();
  while (!context.requestKey.mock.calls.length) await Promise.resolve();
  controller.abort();
  resolve(bytes);
  await expect(pending).rejects.toThrow();
  expect([...bytes]).toEqual(Array(32).fill(0));
  expect(mockSign).not.toHaveBeenCalled();
});
test('a wrong acknowledgement or post-result abort cannot report completion', async () => {
  context.request.mockImplementation(async () => {
    controller.abort();
    return JSON.stringify({ id: 2, value: null });
  });
  await expect(invoke()).rejects.toThrow();
  expect([...bytes]).toEqual(Array(32).fill(0));
});
test('unknown acknowledgement is refused after key wipe', async () => {
  context.request.mockResolvedValue(JSON.stringify({ id: 2, value: true }));
  await expect(invoke()).rejects.toThrow();
  expect([...bytes]).toEqual(Array(32).fill(0));
});
test('oversized init refuses before runtime or key admission', async () => {
  input.extra = 'x'.repeat(65536);
  await expect(invoke()).rejects.toThrow();
  expect(require('./railgun-engine-runtime').verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(context.requestKey).not.toHaveBeenCalled();
});
