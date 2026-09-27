jest.mock('./privacy-process', () => ({ runPrivacyProcess: (input) => mockRun(input) }));
jest.mock('./privacy-artifacts', () => ({ createPrivacyArtifactLoader: () => ({ load: (name) => mockLoad(name) }) }));
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { createPrivacyScope } = require('../networks/privacy-context');
const { createPPv2DepositProver } = require('./ppv2-deposit-prover');
const { FIELD, NATIVE, DEPOSIT_ABI, ARTIFACTS, formatProof } = require('./ppv2-deposit-policy');
let mockRun, mockLoad, scope, prover, witness, proof, config;
const ownerAddress = `0x${'11'.repeat(20)}`, entrypointAddress = `0x${'22'.repeat(20)}`;
const note = { hint: `0x${'33'.repeat(32)}`, data: `0x${'44'.repeat(128)}` };
const ciphertext = `0x${'55'.repeat(128)}`;
const abi = new Interface([DEPOSIT_ABI]);
const intent = { amount: 100n, maxFee: 1n, ownerAddress, entrypointAddress };
const context = keccak256(AbiCoder.defaultAbiCoder().encode(['tuple(bytes32 hint,bytes data)'], [note]));
beforeEach(() => {
  scope = createPrivacyScope({ profileId: 'fixture', signal: new AbortController().signal });
  const handle = (role) => scope.getContext({ kind: 'private-account', principal: 'a', protocol: 'privacy-pools-v2', deployment: 'sepolia', chainId: 11155111, role });
  config = { handle: handle('prover'), artifactHandle: handle('artifacts'), sdkEntry: '/reviewed/sdk.cjs', directory: '/reviewed/artifacts',
    manifest: { deposit: Object.fromEntries(ARTIFACTS.map((entry) => [`${entry.kind}Sha256`, entry.sha256])) } };
  witness = { tokenId: NATIVE, value: '0x64', context, noteAddressHash: '0x1', depositSecret: '0x2' };
  // Shape-only fixture. The real SDK proof/verification is exercised in Electron.
  proof = { proof: { pi_a: ['0x1', '0x2', '0x1'], pi_b: [['0x1', '0x2'], ['0x3', '0x4'], ['0x1', '0x0']],
    pi_c: ['0x5', '0x6', '0x1'], protocol: 'groth16', curve: 'bn128' }, publicSignals: ['0x7', NATIVE, '0x64', `0x${(BigInt(context) % FIELD).toString(16)}`] };
  mockLoad = jest.fn(async () => Buffer.alloc(1));
  mockRun = jest.fn(async (args) => {
    const result = { verified: true, proof: structuredClone(proof) };
    if (!args.validateResult(result)) throw new Error('Invalid process result');
    return { result };
  });
  prover = createPPv2DepositProver(config);
});
afterEach(() => scope.close());
async function prepare(mutate = (value) => value) {
  const issued = await prover.service.proveDeposit(witness);
  const evm = prover.service.formatForEVM(issued);
  return mutate({ __type: 'publicOperation', txs: [{ to: entrypointAddress, value: 101n,
    data: abi.encodeFunctionData('deposit', [evm, note, ciphertext]) }] });
}
test('only a bounded native deposit intent can produce an immutable sender/chain transaction', async () => {
  const result = await prover.prepare(intent, () => prepare());
  expect(result).toMatchObject({ kind: 'ppv2-native-deposit', chainId: 11155111, from: ownerAddress, to: entrypointAddress,
    value: 101n, amount: 100n, fee: 1n, proofVerified: true, chainStateVerified: false });
  expect(Object.isFrozen(result)).toBe(true);
  expect(mockLoad.mock.calls.map(([name]) => name)).toEqual(ARTIFACTS.map((entry) => entry.name));
  expect(Object.keys(mockRun.mock.calls[0][0].input).sort()).toEqual(['artifacts', 'sdkEntry', 'witness']);
  for (const input of [{ amount: 0n }, { amount: -1n }, { amount: 1n << 128n }, { amount: 100 }, { maxFee: -1n }]) {
    await expect(prover.prepare({ ...intent, ...input }, () => prepare())).rejects.toMatchObject({ code: 'PRIVATE_PPV2_DEPOSIT_REFUSED' });
  }
  expect(mockRun).toHaveBeenCalledTimes(1);
});
test('refuses unscoped proving, witness widening/mutation and mismatched native amount', async () => {
  await expect(prover.service.proveDeposit(witness)).rejects.toThrow();
  for (const change of [{ value: '0x65' }, { tokenId: '0x1' }, { noteAddressHash: `0x${FIELD.toString(16)}` },
    { extraSecret: 'no' }, { context: '0x' + 'f'.repeat(65) }]) {
    await expect(prover.prepare(intent, () => prover.service.proveDeposit({ ...witness, ...change }))).rejects.toThrow();
  }
  expect(mockRun).not.toHaveBeenCalled();
  const prepared = prover.prepare(intent, () => prepare());
  witness.value = '0x65'; // Snapshot was taken synchronously before artifact awaits.
  expect((await prepared).amount).toBe(100n);
  expect(mockRun.mock.calls[0][0].input.witness.value).toBe('0x64');
});
test.each(['amount', 'context', 'curve', 'coordinate', 'shape'])('refuses a child result with changed %s', async (field) => {
  if (field === 'amount') proof.publicSignals[2] = '0x65';
  if (field === 'context') proof.publicSignals[3] = '0x0';
  if (field === 'curve') proof.proof.curve = 'other';
  if (field === 'coordinate') proof.proof.pi_a[0] = `0x${'f'.repeat(64)}`;
  if (field === 'shape') proof.publicSignals.push('0x0');
  await expect(prover.prepare(intent, () => prepare())).rejects.toMatchObject({ code: 'PRIVATE_PPV2_DEPOSIT_REFUSED' });
});
test.each(['target', 'fee', 'proof', 'note', 'trailing', 'approval', 'ciphertext'])('refuses prepared transaction tampering: %s', async (field) => {
  await expect(prover.prepare(intent, () => prepare((result) => {
    const tx = result.txs[0];
    if (field === 'target') tx.to = ownerAddress;
    if (field === 'fee') tx.value = 102n;
    if (field === 'trailing') tx.data += '00';
    if (field === 'approval') result.txs.push(tx);
    if (['proof', 'note', 'ciphertext'].includes(field)) {
      const forged = structuredClone(proof);
      if (field === 'proof') forged.publicSignals[0] = '0x8';
      tx.data = abi.encodeFunctionData('deposit', [formatProof(forged), field === 'note' ? { ...note, data: '0x1234' } : note,
        field === 'ciphertext' ? '0x' : ciphertext]);
    }
    return result;
  }))).rejects.toMatchObject({ code: 'PRIVATE_PPV2_DEPOSIT_REFUSED' });
});
test('refuses unissued proof formatting, extra circuits, changed pins and concurrent preparation', async () => {
  expect(() => prover.service.formatForEVM(proof)).toThrow();
  for (const method of ['proveTransact', 'proveRagequit', 'verifyDeposit', 'verifyTransact', 'verifyRagequit', 'loadCircuit']) expect(() => prover.service[method]()).toThrow();
  expect(() => createPPv2DepositProver({ ...config, manifest: {} })).toThrow();
  const pending = prover.prepare(intent, () => prepare());
  await expect(prover.prepare(intent, () => prepare())).rejects.toThrow(); await pending;
});
test('artifact failure starts no process; revocation refuses late process and transaction results', async () => {
  mockLoad.mockRejectedValueOnce(new Error('private path'));
  await expect(prover.prepare(intent, () => prepare())).rejects.toMatchObject({ message: 'Deposit does not match its reviewed intent' });
  expect(mockRun).not.toHaveBeenCalled();
  mockRun.mockImplementationOnce(async () => { scope.close(); return { result: { proof } }; });
  await expect(prover.prepare(intent, () => prepare())).rejects.toMatchObject({ code: 'PRIVACY_CONTEXT_REVOKED' });
});
