/** Public synthetic witnesses only. Qualification job, never an application API. */
const assert = require('assert/strict');
const { createHash } = require('crypto');

exports.run = async function run(input, { progress }) {
  assert.ok(['ragequit', 'transact_1x1'].includes(input.circuit));
  const sdk = require(input.sdkEntry);
  for (const [kind, bytes] of Object.entries(input.artifacts)) {
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sdk.DEFAULT_CIRCUIT_MANIFEST[input.circuit][`${kind}Sha256`]);
  }
  const hashService = await sdk.PoseidonHashService.create();
  const merkleService = new sdk.MerkleService({ hashService });
  const noteComputationService = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.CryptoService() });
  const witnessService = new sdk.WitnessPreparationService({ hashService, merkleService, noteComputationService });
  const ownerAddress = `0x${'11'.repeat(20)}`, tokenId = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const privateNullifyingKey = `0x${'02'.repeat(32)}`, privateRevocableKey = `0x${'03'.repeat(32)}`;
  const noteSecret = `0x${'04'.repeat(32)}`, label = '0x0a', value = '0x2710';
  const noteAddressHash = noteComputationService.computeNoteAddressHash(ownerAddress, noteSecret);
  const commitment = noteComputationService.computeFullCommitment({ noteAddressHash, tokenId, value, label });
  const note = { noteAddressHash, commitment, tokenId, value, label, ownerAddress, noteSecret, isOwned: true,
    status: sdk.NoteStatus.ACTIVE, createdAtBlock: '0x6553f100', spentAtBlock: null, txHash: `0x${'ab'.repeat(32)}` };
  const keystoreLeaves = [hashService.hash([ownerAddress, hashService.hash([privateNullifyingKey]),
    noteComputationService.computeAuthDigest(privateRevocableKey)])];
  const nullifier = noteComputationService.computeNullifier(privateNullifyingKey, commitment);
  let witness, expected;
  if (input.circuit === 'ragequit') {
    const result = await witnessService.buildRagequitWitness({ note, ownerAddress, privateNullifyingKey,
      privateRevocableKey, tokenId, label, keystoreLeaves });
    witness = result.witness;
    expected = [nullifier, commitment, await merkleService.computeRoot(keystoreLeaves), ownerAddress, value, tokenId, label];
  } else {
    // 10,000 in = 6,000 public withdrawal + 4,000 private change.
    const outputHash = noteComputationService.computeNoteAddressHash(ownerAddress, `0x${'05'.repeat(32)}`);
    const change = { ...note, noteAddressHash: outputHash, noteSecret: `0x${'05'.repeat(32)}`, value: '0xfa0',
      status: sdk.NoteStatus.PENDING };
    change.commitment = noteComputationService.computeFullCommitment({ noteAddressHash: outputHash, tokenId, value: change.value, label });
    const tag = hashService.hash([`0x${Buffer.from('privacy_pools_note').toString('hex')}`]);
    const stateLeaves = [hashService.hash([tag, commitment, note.createdAtBlock])];
    const aspLeaves = [noteComputationService.computeLabelHash(label)];
    witness = await witnessService.buildTransactWitness({ inputNotes: [note], changeNotes: [change], recipientNotes: [],
      ownerAddress, privateNullifyingKey, privateRevocableKey, tokenId, amountOut: '0x1770', tokenIdOut: tokenId,
      context: input.relayContext || '0x1234', stateLeaves, keystoreLeaves, aspLeaves });
    expected = [nullifier, change.commitment, await merkleService.computeRoot(stateLeaves),
      await merkleService.computeRoot(keystoreLeaves), await merkleService.computeRoot(aspLeaves), '0x1770', tokenId, input.relayContext || '0x1234'];
  }
  const artifact = async (name, kind) => { assert.equal(name, input.circuit); return input.artifacts[kind]; };
  const prover = input.singleThread ? require('./serial-prover.cjs') : new sdk.Groth16Prover();
  const service = new sdk.ProofService({ circuitArtifacts: {
    getWasm: (name) => artifact(name, 'wasm'), getProvingKey: (name) => artifact(name, 'provingKey'),
    getVerificationKey: (name) => artifact(name, 'verificationKey'),
  }, groth16Prover: {
    fullProve(...args) { const task = prover.fullProve(...args); progress(); return task; },
    verify: (...args) => prover.verify(...args),
  } });
  const start = performance.now();
  const proof = input.circuit === 'ragequit' ? await service.proveRagequit(witness) : await service.proveTransact(witness, 1, 1);
  const provingMs = Math.round(performance.now() - start);
  const verify = (p) => input.circuit === 'ragequit' ? service.verifyRagequit(p) : service.verifyTransact(p, 1, 1);
  assert.equal(await verify(proof), true);
  assert.deepEqual(proof.publicSignals.map(BigInt), expected.map(BigInt));
  const altered = { ...proof, publicSignals: [...proof.publicSignals] };
  const valueIndex = input.circuit === 'ragequit' ? 4 : 5;
  altered.publicSignals[valueIndex] = `0x${(BigInt(altered.publicSignals[valueIndex]) + 1n).toString(16)}`;
  assert.equal(await verify(altered), false);
  return { circuit: input.circuit, prover: input.singleThread ? 'single-thread' : 'sdk-default', verified: true, publicSignalsBound: true, tamperedAmountRejected: true,
    ...(input.relayContext ? { publicFixture: { proof, commitment } } : {}),
    publicSignalCount: proof.publicSignals.length, provingMs, rssBytes: process.memoryUsage().rss,
    fromAsar: __filename.includes('.asar/'), sdkFromAsar: input.sdkEntry.includes('.asar/'),
    node: process.versions.node, electron: process.versions.electron };
};
