const mockVerify = jest.fn();
jest.mock('./railgun-prover-runtime', () => ({
  loadRailgunProverRuntime: () => ({ verify: (...args) => mockVerify(...args) }),
}));
jest.mock('./railgun-private-intent', () => ({ matchRailgunPrivateProvedTransaction: jest.fn() }));
jest.mock('./railgun-artifacts', () => ({ loadRailgunArtifacts: jest.fn() }));
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { matchRailgunPrivateProvedTransaction } = require('./railgun-private-intent');
const { loadRailgunArtifacts } = require('./railgun-artifacts');
const { run } = require('./railgun-private-verify-job');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const baseField = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
let input, context, controller, artifacts, proof, checked;
function encode() {
  input.transaction.data = new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [
    [
      [
        proof,
        hex(11),
        [hex(12)],
        [hex(13)],
        [0, 0, 0, 11155111, '0x' + '0'.repeat(40), hex(0), []],
        [hex(0), [0, '0x' + '0'.repeat(40), 0], 0],
      ],
    ],
  ]);
}
beforeEach(() => {
  jest.clearAllMocks();
  controller = new AbortController();
  proof = [
    [1n, 2n],
    [
      [3n, 4n],
      [5n, 6n],
    ],
    [7n, 8n],
  ];
  input = {
    archive: '/prover.asar',
    artifactDirectory: '/artifacts',
    expected: {},
    intent: {},
    transaction: {},
  };
  encode();
  checked = {
    kind: 'railgun-private-transfer',
    merkleRoot: hex(11),
    boundParamsHash: hex(14),
    nullifier: hex(12),
    commitment: hex(13),
    digest: hex(15),
  };
  matchRailgunPrivateProvedTransaction.mockReturnValue(checked);
  artifacts = { wasm: Buffer.alloc(2, 1), zkey: Buffer.alloc(3, 1), vkey: { nPublic: 4 } };
  loadRailgunArtifacts.mockResolvedValue(artifacts);
  mockVerify.mockResolvedValue(true);
  context = {
    signal: controller.signal,
    guardReport: jest.fn(() => ({ attempts: 0 })),
    request: jest.fn(async () => JSON.stringify({ id: 1, value: null })),
  };
});
const invoke = () => run(JSON.stringify(input), context);
test('reverses contract Fq2 order and verifies only checked public signals', async () => {
  await invoke();
  expect(matchRailgunPrivateProvedTransaction).toHaveBeenCalledWith(
    input.intent,
    input.transaction,
    input.expected
  );
  expect(mockVerify).toHaveBeenCalledWith(artifacts.vkey, [11n, 14n, 12n, 13n], {
    pi_a: [1n, 2n, 1n],
    pi_b: [
      [4n, 3n],
      [6n, 5n],
      [1n, 0n],
    ],
    pi_c: [7n, 8n, 1n],
    protocol: 'groth16',
    curve: 'bn128',
  });
  expect(JSON.parse(context.request.mock.calls[0][0]).value).toMatchObject({
    verified: true,
    transactionDigest: hex(15),
  });
  expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(5).fill(0));
});
test.each([baseField, baseField + 1n, (1n << 256n) - 1n])(
  'refuses noncanonical curve coordinate %s',
  async (value) => {
    proof[1][1][0] = value;
    encode();
    await expect(invoke()).rejects.toThrow();
    expect(loadRailgunArtifacts).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
  }
);
test.each([
  () => {
    mockVerify.mockResolvedValue(false);
  },
  () => {
    mockVerify.mockRejectedValueOnce(Error('verify'));
  },
  () => {
    mockVerify.mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });
  },
  () => {
    context.guardReport.mockReturnValue({ attempts: 1 });
  },
])('refuses failure or revocation and wipes artifacts %#', async (change) => {
  change();
  await expect(invoke()).rejects.toThrow();
  expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(5).fill(0));
  expect(context.request).not.toHaveBeenCalled();
});
test('refuses extra key-bearing input or mismatched intent before loading artifacts', async () => {
  input.key = 'not-accepted';
  await expect(invoke()).rejects.toThrow();
  delete input.key;
  matchRailgunPrivateProvedTransaction.mockImplementationOnce(() => {
    throw Error('intent');
  });
  await expect(invoke()).rejects.toThrow();
  expect(loadRailgunArtifacts).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
});

function partial() {
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const fixture = createRailgunPartialCapsuleData();
  input.intent = fixture.capsule.preparation.transaction;
  input.expected = fixture.capsule.preparation.expected;
  fixture.inner.proof = {
    a: { x: 1, y: 2 },
    b: { x: [3, 4], y: [5, 6] },
    c: { x: 7, y: 8 },
  };
  input.transaction = { ...input.intent, data: fixture.encode() };
  matchRailgunPrivateProvedTransaction.mockImplementationOnce(
    jest.requireActual('./railgun-private-intent').matchRailgunPrivateProvedTransaction
  );
  artifacts.vkey.nPublic = 5;
  return fixture;
}
test('real partial intent selects pinned 01x02 and independently verifies all five ordered signals', async () => {
  partial();
  await invoke();
  expect(loadRailgunArtifacts.mock.calls[0][0].variant).toBe('01x02');
  const expected = input.expected;
  expect(mockVerify.mock.calls[0][1]).toEqual(
    [
      expected.merkleRoot,
      expected.boundParamsHash,
      expected.nullifier,
      expected.changeCommitment,
      expected.unshieldCommitment,
    ].map(BigInt)
  );
  expect(context.request).toHaveBeenCalledTimes(1);
  expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(5).fill(0));
});
test('a partial proof cannot use a one-output verification key', async () => {
  partial();
  artifacts.vkey.nPublic = 4;
  await expect(invoke()).rejects.toThrow();
  expect(mockVerify).not.toHaveBeenCalled();
  expect(context.request).not.toHaveBeenCalled();
  expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(5).fill(0));
});
test.each(['root', 'nullifier', 'change', 'unshield', 'bound', 'swapped'])(
  'partial final %s mutation refuses before artifact loading',
  async (mode) => {
    const fixture = partial();
    if (mode === 'root') fixture.inner.merkleRoot = hex(9);
    if (mode === 'nullifier') fixture.inner.nullifiers[0] = hex(9);
    if (mode === 'change') fixture.inner.commitments[0] = hex(9);
    if (mode === 'unshield') fixture.inner.commitments[1] = hex(9);
    if (mode === 'bound') fixture.inner.boundParams.commitmentCiphertext[0].memo = '0x1122';
    if (mode === 'swapped') fixture.inner.commitments.reverse();
    input.transaction.data = fixture.encode();
    await expect(invoke()).rejects.toThrow();
    expect(loadRailgunArtifacts).not.toHaveBeenCalled();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(context.request).not.toHaveBeenCalled();
  }
);
test('unknown verification kind refuses before artifacts', async () => {
  checked.kind = 'railgun-unknown';
  await expect(invoke()).rejects.toThrow();
  expect(loadRailgunArtifacts).not.toHaveBeenCalled();
  expect(mockVerify).not.toHaveBeenCalled();
});
