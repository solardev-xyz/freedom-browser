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
