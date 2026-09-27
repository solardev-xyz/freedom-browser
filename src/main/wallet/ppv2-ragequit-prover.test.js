jest.mock('./privacy-process', () => ({ runPrivacyProcess: (args) => mockRun(args) }));
jest.mock('./privacy-artifacts', () => ({ createPrivacyArtifactLoader: () => ({ load: mockLoad }) }));
const { Interface } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2RagequitProver } = require('./ppv2-ragequit-prover');
const { NATIVE, FIELD, formatProof } = require('./ppv2-deposit-policy');
const { ARTIFACTS, RAGEQUIT_ABI } = require('./ppv2-ragequit-policy');
const ownerAddress = `0x${'11'.repeat(20)}`, poolAddress = `0x${'22'.repeat(20)}`;
const commitment = `0x${'7'.padStart(64, '0')}`;
const intent = { ownerAddress, poolAddress, commitment, amount: 100n };
const abi = new Interface([RAGEQUIT_ABI]);
const mockLoad = jest.fn(async () => Buffer.alloc(1));
let mockRun, scope, prover, witness, proof, config;
beforeEach(() => {
  mockLoad.mockClear();
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  const handle = (role) => scope.getContext({ kind: 'private-account', principal: 'fixture', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
  config = { handle: handle('prover'), artifactHandle: handle('artifacts'), sdkEntry: '/reviewed/sdk.cjs',
    proverEntry: '/reviewed/serial-prover.cjs', directory: '/reviewed/artifacts',
    manifest: { ragequit: Object.fromEntries(ARTIFACTS.map((entry) => [`${entry.kind}Sha256`, entry.sha256])) } };
  witness = { keystoreRoot: '0x9', ownerAddress, value: '0x64', tokenId: NATIVE, label: '0xa', metadata: '0x0',
    noteSecret: '0x1', privateNullifyingKey: '0x2', privateRevocableKey: '0x3', keystoreLeafIndex: '0x0',
    keystoreTreeDepth: '0x0', keystoreSiblings: Array(18).fill('0x0') };
  // Shape-only fixtures; Electron tests run actual Groth16 proving/verification.
  proof = { proof: { pi_a: ['0x1', '0x2', '0x1'], pi_b: [['0x1', '0x2'], ['0x3', '0x4'], ['0x1', '0x0']],
    pi_c: ['0x5', '0x6', '0x1'], protocol: 'groth16', curve: 'bn128' },
  publicSignals: ['0x8', commitment, '0x9', ownerAddress, '0x64', NATIVE, '0xa'] };
  mockRun = jest.fn(async (args) => {
    const result = { verified: true, proof: structuredClone(proof) };
    if (!args.validateResult(result)) throw new Error('Invalid controlled result');
    return { result };
  });
  prover = createPPv2RagequitProver(config);
});
afterEach(() => scope.close());
async function prepare(mutate = (v) => v) {
  const issued = await prover.service.proveRagequit(witness);
  return mutate({ __type: 'publicOperation', txs: [{ to: poolAddress, value: 0n,
    data: abi.encodeFunctionData('ragequit', [prover.service.formatForEVM(issued)]) }] });
}

test('binds the recovered native note, owner and pool without raising the process budget', async () => {
  const result = await prover.prepare(intent, () => prepare());
  expect(result).toMatchObject({ kind: 'ppv2-native-ragequit', commitment, amount: 100n, value: 0n,
    from: ownerAddress, to: poolAddress, proofVerified: true, chainStateVerified: false });
  expect(Object.isFrozen(result)).toBe(true);
  expect(mockRun.mock.calls[0][0].rssMb).toBeUndefined();
  expect(mockLoad.mock.calls.map(([name]) => name)).toEqual(ARTIFACTS.map((entry) => entry.name));
});

test('rejects witness widening, another owner/token/value and invalid tree bounds before starting a child', async () => {
  await expect(prover.service.proveRagequit(witness)).rejects.toThrow();
  for (const change of [{ ownerAddress: poolAddress }, { tokenId: '0x1' }, { value: '0x65' }, { metadata: '0x1' },
    { keystoreSiblings: [] }, { keystoreTreeDepth: '0x13' }, { keystoreRoot: `0x${FIELD.toString(16)}` }, { extraSecret: 'no' }]) {
    await expect(prover.prepare(intent, () => prover.service.proveRagequit({ ...witness, ...change }))).rejects.toThrow();
  }
  expect(mockRun).not.toHaveBeenCalled();
});

test.each([1, 2, 3, 4, 5, 6])('rejects a proof with changed public signal %s', async (index) => {
  proof.publicSignals[index] = '0x1';
  await expect(prover.prepare(intent, () => prepare())).rejects.toMatchObject({ code: 'PRIVATE_PPV2_EXIT_REFUSED' });
});

test.each(['target', 'value', 'proof', 'extra', 'trailing'])('rejects changed prepared exit %s', async (change) => {
  await expect(prover.prepare(intent, () => prepare((result) => {
    const tx = result.txs[0];
    if (change === 'target') tx.to = ownerAddress;
    if (change === 'value') tx.value = 1n;
    if (change === 'extra') result.txs.push(tx);
    if (change === 'trailing') tx.data += '00';
    if (change === 'proof') {
      const changed = structuredClone(proof); changed.publicSignals[0] = '0x9';
      tx.data = abi.encodeFunctionData('ragequit', [formatProof(changed)]);
    }
    return result;
  }))).rejects.toThrow();
});

test('snapshots mutable arrays, refuses unissued formatting, and refuses late results after lock', async () => {
  expect(() => prover.service.formatForEVM(proof)).toThrow();
  const pending = prover.prepare(intent, () => prepare());
  witness.keystoreSiblings[0] = '0x7';
  await pending;
  expect(mockRun.mock.calls[0][0].input.witness.keystoreSiblings[0]).toBe('0x0');
  mockRun.mockImplementationOnce(async () => { scope.close(); return { result: { proof } }; });
  await expect(prover.prepare(intent, () => prepare())).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});
