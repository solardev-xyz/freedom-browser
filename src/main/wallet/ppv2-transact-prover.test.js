jest.mock('./privacy-process', () => ({ runPrivacyProcess: (args) => mockRun(args) }));
jest.mock('./privacy-artifacts', () => ({ createPrivacyArtifactLoader: () => ({ load: mockLoad }) }));
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2TransactProver } = require('./ppv2-transact-prover');
const { NATIVE, FIELD } = require('./ppv2-deposit-policy');
const { ARTIFACTS } = require('./ppv2-transact-policy');
const owner = `0x${'11'.repeat(20)}`, commitment = `0x${'7'.padStart(64, '0')}`;
const intent = { owner, commitment, amount: 50n, value: 100n, maxFee: 10n };
const mockLoad = jest.fn(async () => Buffer.alloc(1));
let mockRun, scope, prover, witness, proof, config;
beforeEach(() => {
  mockLoad.mockClear();
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  const handle = (role) => scope.getContext({ kind: 'private-account', principal: 'fixture', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
  config = { handle: handle('prover'), artifactHandle: handle('artifacts'), sdkEntry: '/reviewed/sdk.cjs',
    proverEntry: '/reviewed/serial-prover.cjs', directory: '/reviewed/artifacts',
    manifest: { transact_1x1: Object.fromEntries(ARTIFACTS.map((e) => [`${e.kind}Sha256`, e.sha256])) } };
  witness = { stateRoot: '0x8', keystoreRoot: '0x9', associationSetRoot: '0xa', amountOut: '0x3c', tokenIdOut: NATIVE,
    context: '0xb', ownerAddress: owner, privateNullifyingKey: '0x2', privateRevocableKey: '0x3',
    keystoreLeafIndex: '0x0', keystoreTreeDepth: '0x0', tokenId: NATIVE,
    noteSecret: ['0x1'], value: ['0x64'], label: ['0xc'], stateLeafIndex: ['0x0'], stateTreeDepth: ['0x0'],
    associationSetLeafIndex: ['0x0'], associationSetTreeDepth: ['0x0'], timestamp: ['0x1'],
    outputNoteAddressHash: ['0xd'], outputValue: ['0x28'], outputLabel: ['0xc'],
    keystoreSiblings: Array(18).fill('0x0'), stateSiblings: [Array(22).fill('0x0')], associationSetSiblings: [Array(18).fill('0x0')] };
  // Shape-only fixtures; Electron qualification runs the actual Groth16 circuit.
  proof = { proof: { pi_a: ['0x1', '0x2', '0x1'], pi_b: [['0x1', '0x2'], ['0x3', '0x4'], ['0x1', '0x0']],
    pi_c: ['0x5', '0x6', '0x1'], protocol: 'groth16', curve: 'bn128' },
  publicSignals: ['0x1', '0x2', '0x8', '0x9', '0xa', '0x3c', NATIVE, '0xb'] };
  mockRun = jest.fn(async (args) => {
    const result = { verified: true, proof: structuredClone(proof) };
    if (!args.validateResult(result)) throw new Error('Invalid controlled result');
    return { result };
  });
  prover = createPPv2TransactProver(config);
});
afterEach(() => scope.close());
async function prepare() {
  await prover.service.proveTransact(witness, 1, 1);
  return prover.service.proveTransact(witness, 1, 1);
}
test('requires two owned proofs and binds the selected input without raising the process budget', async () => {
  const result = await prover.prepare(intent, prepare);
  expect(result.proof).toEqual(proof); expect(Object.isFrozen(result.proof.publicSignals)).toBe(true);
  expect(mockRun).toHaveBeenCalledTimes(2);
  expect(mockRun.mock.calls[0][0].rssMb).toBeUndefined();
  expect(mockRun.mock.calls[0][0].input.commitment).toBe(commitment);
  expect(mockLoad.mock.calls.map(([name]) => name)).toEqual([...ARTIFACTS, ...ARTIFACTS].map((e) => e.name));
});
test('rejects witness widening, wrong note value, token, owner, and unsafe tree bounds before proving', async () => {
  await expect(prover.service.proveTransact(witness, 1, 1)).rejects.toThrow();
  for (const change of [{ ownerAddress: '0x1' }, { tokenId: '0x1' }, { value: ['0x65'] }, { outputValue: ['0x0'] },
    { outputLabel: ['0xd'] }, { keystoreSiblings: [] }, { stateSiblings: [[]] }, { stateTreeDepth: ['0x17'] },
    { associationSetRoot: `0x${FIELD.toString(16)}` }, { extraSecret: 'no' }]) {
    await expect(prover.prepare(intent, () => prover.service.proveTransact({ ...witness, ...change }, 1, 1))).rejects.toThrow();
  }
  expect(mockRun).not.toHaveBeenCalled();
});
test.each([2, 3, 4, 5, 6, 7])('rejects changed public signal %s', async (index) => {
  proof.publicSignals[index] = '0x1';
  await expect(prover.prepare(intent, prepare)).rejects.toMatchObject({ code: 'PRIVATE_PPV2_WITHDRAWAL_REFUSED' });
});
test('rejects another circuit or manifest and a missing final proof', async () => {
  config.manifest.transact_1x1.wasmSha256 = '00'.repeat(32);
  expect(() => createPPv2TransactProver(config)).toThrow();
  await expect(prover.prepare(intent, () => prover.service.proveTransact(witness, 2, 1))).rejects.toThrow();
  await expect(prover.prepare(intent, () => prover.service.proveTransact(witness, 1, 1))).rejects.toThrow();
});
test('allows only the most recent issued proof to be formatted and limits proofs to two', async () => {
  await prover.prepare(intent, async () => {
    const first = await prover.service.proveTransact(witness, 1, 1);
    expect(() => prover.service.formatForEVM(structuredClone(first))).toThrow();
    const second = await prover.service.proveTransact(witness, 1, 1);
    expect(() => prover.service.formatForEVM(first)).toThrow();
    expect(() => prover.service.formatForEVM(second)).not.toThrow();
    await expect(prover.service.proveTransact(witness, 1, 1)).rejects.toThrow();
  });
  expect(() => prover.service.formatForEVM(proof)).toThrow();
});
test('snapshots witness arrays and refuses late results after lock', async () => {
  const pending = prover.prepare(intent, prepare);
  witness.keystoreSiblings[0] = '0x7'; await pending;
  expect(mockRun.mock.calls[0][0].input.witness.keystoreSiblings[0]).toBe('0x0');
  mockRun.mockImplementationOnce(async () => { scope.close(); return { result: { proof } }; });
  await expect(prover.prepare(intent, prepare)).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});

test('a caught final proof failure cannot return the preliminary proof as final', async () => {
  await expect(prover.prepare(intent, async () => {
    await prover.service.proveTransact(witness, 1, 1);
    mockRun.mockRejectedValueOnce(new Error('Proof failed'));
    await prover.service.proveTransact(witness, 1, 1).catch(() => {});
  })).rejects.toThrow();
});
