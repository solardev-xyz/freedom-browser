const mockVerify = jest.fn(),
  mockPoseidon = jest.fn(),
  mockLoad = jest.fn(),
  mockSet = jest.fn();
jest.mock(
  '/fixture/engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({ poseidon: (...args) => mockPoseidon(...args), initPoseidonPromise: Promise.resolve() }),
  { virtual: true }
);
jest.mock(
  '/fixture/engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({ verifyEDDSA: (...args) => mockVerify(...args) }),
  { virtual: true }
);
jest.mock(
  '/fixture/engine.asar/node_modules/@railgun-community/engine/dist/prover/prover',
  () => ({
    Prover: class {
      constructor(options) {
        this.options = options;
      }
      setSnarkJSGroth16(...args) {
        mockSet(...args);
      }
    },
  }),
  { virtual: true }
);
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (value) => value }));
jest.mock('./railgun-prover-runtime', () => ({
  loadRailgunProverRuntime: () => ({ serial: true }),
}));
jest.mock('./railgun-artifacts', () => ({ loadRailgunArtifacts: (...args) => mockLoad(...args) }));
jest.mock('./railgun-private-intent', () => ({
  validateRailgunPrivateSigningIntent: jest.fn(),
  matchRailgunPrivateProvedTransaction: jest.fn(),
}));
jest.mock('ethers', () => ({
  ...jest.requireActual('ethers'),
  Interface: class {
    encodeFunctionData() {
      return 'final-calldata';
    }
  },
}));
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const { createRailgunPrivateProver } = require('./railgun-private-prover');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let controller, artifacts, prepared, signature, helpers;
async function open(intentKind) {
  const helper = await createRailgunPrivateProver({
    archive: '/fixture/engine.asar',
    proverArchive: '/fixture/prover.asar',
    artifactDirectory: '/fixture/artifacts',
    spendingPublicKey: [hex(8), hex(9)],
    signal: controller.signal,
    ...(intentKind === undefined ? {} : { intentKind }),
  });
  helpers.push(helper);
  return helper;
}
beforeEach(() => {
  jest.resetAllMocks();
  helpers = [];
  controller = new AbortController();
  artifacts = { wasm: Buffer.alloc(4, 1), zkey: Buffer.alloc(4, 2) };
  mockLoad.mockResolvedValue(artifacts);
  mockVerify.mockReturnValue(true);
  mockPoseidon.mockReturnValue(5n);
  validateRailgunPrivateSigningIntent.mockReturnValue({
    kind: 'railgun-private-transfer',
    merkleRoot: hex(1),
    boundParamsHash: hex(2),
    nullifier: hex(3),
    commitment: hex(4),
  });
  matchRailgunPrivateProvedTransaction.mockReturnValue({ digest: hex(6) });
  prepared = {
    witness: {
      publicInputs: { merkleRoot: 1n, boundParamsHash: 2n, nullifiers: [3n], commitmentsOut: [4n] },
      privateInputs: { witnessOnly: true, publicKey: [8n, 9n] },
    },
    transaction: {
      generateProvedTransaction: jest.fn(async (_version, prover) => {
        prover.options.assertArtifactExists(1, 1);
        expect(await prover.options.getArtifacts(prepared.witness.publicInputs)).toBe(artifacts);
        return {};
      }),
    },
    publicPreparation: {
      transaction: { to: 'target', data: 'intent' },
      expected: { kind: 'railgun-private-transfer' },
      expectedHash: hex(5),
    },
  };
  signature = { R8: [hex(10), hex(11)], S: hex(12) };
});
afterEach(() => {
  helpers.forEach((helper) => helper.close());
});
test('loads artifacts before signing, binds signature to witness, returns only an unverified public result', async () => {
  const helper = await open();
  expect(mockLoad).toHaveBeenCalledTimes(1);
  expect(mockVerify).not.toHaveBeenCalled();
  const result = await helper.prove(prepared, signature);
  expect(mockVerify).toHaveBeenCalledWith(5n, { R8: [10n, 11n], S: 12n }, [8n, 9n]);
  expect(prepared.transaction.generateProvedTransaction.mock.calls[0][2]).toEqual({
    ...prepared.witness,
    signature: [10n, 11n, 12n],
  });
  expect(result).toEqual({
    transaction: { to: 'target', data: 'final-calldata' },
    transactionDigest: hex(6),
    independentlyVerified: false,
  });
  expect(JSON.stringify(result)).not.toContain('witnessOnly');
  await expect(helper.prove(prepared, signature)).rejects.toThrow();
  helper.close();
  expect(artifacts.wasm.every((v) => v === 0)).toBe(true);
  expect(artifacts.zkey.every((v) => v === 0)).toBe(true);
});
test.each(['signature', 'message', 'root', 'scalar', 'extra', 'public-key'])(
  'invalid %s is refused before the expensive prover',
  async (mode) => {
    const helper = await open();
    if (mode === 'signature') mockVerify.mockReturnValue(false);
    if (mode === 'message') prepared.publicPreparation.expectedHash = hex(6);
    if (mode === 'root') prepared.witness.publicInputs.merkleRoot = 6n;
    if (mode === 'scalar')
      signature.S =
        hex(2736030358979909402780800718157159386076813972158567259200215660948447373041n);
    if (mode === 'extra') signature.extra = true;
    if (mode === 'public-key') prepared.witness.privateInputs.publicKey = [9n, 8n];
    await expect(helper.prove(prepared, signature)).rejects.toThrow();
    expect(prepared.transaction.generateProvedTransaction).not.toHaveBeenCalled();
    expect(artifacts.wasm.every((v) => v === 0)).toBe(true);
    expect(artifacts.zkey.every((v) => v === 0)).toBe(true);
  }
);
test('intent is copied before proving yields, preventing late result substitution', async () => {
  const helper = await open();
  prepared.transaction.generateProvedTransaction.mockImplementation(async () => {
    prepared.publicPreparation.transaction.to = 'substituted';
    prepared.publicPreparation.expected.kind = 'substituted';
    return {};
  });
  const result = await helper.prove(prepared, signature);
  expect(result.transaction.to).toBe('target');
  expect(matchRailgunPrivateProvedTransaction).toHaveBeenCalledWith(
    { to: 'target', data: 'intent' },
    result.transaction,
    { kind: 'railgun-private-transfer' }
  );
});
test('revocation after proving refuses a public result', async () => {
  const helper = await open();
  prepared.transaction.generateProvedTransaction.mockImplementation(async () => {
    controller.abort();
    return {};
  });
  await expect(helper.prove(prepared, signature)).rejects.toThrow();
  expect(matchRailgunPrivateProvedTransaction).not.toHaveBeenCalled();
});
test('late artifact loading after cancellation wipes returned buffers', async () => {
  mockLoad.mockImplementation(async () => {
    controller.abort();
    return artifacts;
  });
  await expect(open()).rejects.toThrow();
  expect(artifacts.wasm.every((v) => v === 0)).toBe(true);
  expect(artifacts.zkey.every((v) => v === 0)).toBe(true);
});
test('a changed final intent is refused even after the SDK returns a proof', async () => {
  const helper = await open();
  matchRailgunPrivateProvedTransaction.mockImplementation(() => {
    throw Error('different intent');
  });
  await expect(helper.prove(prepared, signature)).rejects.toThrow('different intent');
});

function partial() {
  prepared.publicPreparation.expected = { kind: 'railgun-partial-unshield' };
  prepared.witness.publicInputs.commitmentsOut = [4n, 6n];
  validateRailgunPrivateSigningIntent.mockReturnValue({
    kind: 'railgun-partial-unshield',
    merkleRoot: hex(1),
    boundParamsHash: hex(2),
    nullifier: hex(3),
    changeCommitment: hex(4),
    unshieldCommitment: hex(6),
  });
  prepared.transaction.generateProvedTransaction.mockImplementation(async (_version, prover) => {
    prover.options.assertArtifactExists(1, 2);
    expect(() => prover.options.assertArtifactExists(1, 1)).toThrow();
    expect(() => prover.options.assertArtifactExists(2, 2)).toThrow();
    await expect(
      prover.options.getArtifacts({ ...prepared.witness.publicInputs, commitmentsOut: [4n] })
    ).rejects.toThrow();
    expect(await prover.options.getArtifacts(prepared.witness.publicInputs)).toBe(artifacts);
    return {};
  });
}
test('explicit partial intent selects 01x02 and binds the signature to both ordered outputs', async () => {
  partial();
  const helper = await open('railgun-partial-unshield');
  expect(mockLoad.mock.calls[0][0].variant).toBe('01x02');
  expect(mockVerify).not.toHaveBeenCalled();
  await helper.prove(prepared, signature);
  expect(mockPoseidon).toHaveBeenCalledWith([1n, 2n, 3n, 4n, 6n]);
  expect(mockVerify).toHaveBeenCalledTimes(1);
  expect(prepared.transaction.generateProvedTransaction).toHaveBeenCalledTimes(1);
  expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(8).fill(0));
  await expect(helper.prove(prepared, signature)).rejects.toThrow();
});
test('a signature valid only for a four-input message cannot prove partial', async () => {
  partial();
  mockPoseidon.mockImplementation((values) => BigInt(values.length));
  mockVerify.mockImplementation((message) => message === 4n);
  const helper = await open('railgun-partial-unshield');
  await expect(helper.prove(prepared, signature)).rejects.toThrow();
  expect(mockVerify).toHaveBeenCalledWith(5n, { R8: [10n, 11n], S: 12n }, [8n, 9n]);
  expect(prepared.transaction.generateProvedTransaction).not.toHaveBeenCalled();
  expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(8).fill(0));
});
test.each([undefined, 'railgun-private-transfer', 'railgun-token-unshield'])(
  'legacy constructor binding %s cannot prove partial',
  async (intentKind) => {
    partial();
    const helper = await open(intentKind);
    expect(mockLoad.mock.calls[0][0].variant).toBe('01x01');
    await expect(helper.prove(prepared, signature)).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(prepared.transaction.generateProvedTransaction).not.toHaveBeenCalled();
    expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(8).fill(0));
  }
);
test.each(['railgun-partial-unshield', 'railgun-token-unshield'])(
  'explicit %s binding cannot silently accept a transfer',
  async (intentKind) => {
    const helper = await open(intentKind);
    await expect(helper.prove(prepared, signature)).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(prepared.transaction.generateProvedTransaction).not.toHaveBeenCalled();
  }
);
test.each([null, '', '01x02', 'railgun-unknown', 2])(
  'unknown intent kind %s refuses before artifact admission',
  async (kind) => {
    await expect(open(kind)).rejects.toThrow();
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockSet).not.toHaveBeenCalled();
  }
);
test.each(['root', 'bound', 'nullifier', 'change', 'unshield', 'swapped', 'missing', 'extra'])(
  'partial %s public-input mutation refuses before signature verification and proving',
  async (mode) => {
    partial();
    const helper = await open('railgun-partial-unshield');
    const pub = prepared.witness.publicInputs;
    if (mode === 'root') pub.merkleRoot++;
    if (mode === 'bound') pub.boundParamsHash++;
    if (mode === 'nullifier') pub.nullifiers[0]++;
    if (mode === 'change') pub.commitmentsOut[0]++;
    if (mode === 'unshield') pub.commitmentsOut[1]++;
    if (mode === 'swapped') pub.commitmentsOut.reverse();
    if (mode === 'missing') pub.commitmentsOut.pop();
    if (mode === 'extra') pub.nullifiers.push(7n);
    await expect(helper.prove(prepared, signature)).rejects.toThrow();
    expect(mockVerify).not.toHaveBeenCalled();
    expect(prepared.transaction.generateProvedTransaction).not.toHaveBeenCalled();
    expect([...artifacts.wasm, ...artifacts.zkey]).toEqual(Array(8).fill(0));
  }
);
