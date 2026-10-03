/** Offline public synthetic witnesses; never an application operation. */
const assert = require('assert/strict');
const { createHash } = require('crypto');

exports.run = async function run(input, { progress }) {
  assert.ok(['transact_1x2', 'transact_2x1'].includes(input.circuit));
  require('../../src/main/wallet/ppv2-runtime').assertPPv2RuntimeEntries(input);
  const sdk = require(input.sdkEntry);
  for (const [kind, bytes] of Object.entries(input.artifacts)) {
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      sdk.DEFAULT_CIRCUIT_MANIFEST[input.circuit][`${kind}Sha256`]
    );
  }
  assert.deepEqual(Object.keys(input.artifacts).sort(), ['provingKey', 'verificationKey', 'wasm']);
  const hashService = await sdk.PoseidonHashService.create();
  const merkleService = new sdk.MerkleService({ hashService });
  const notes = new sdk.NoteComputationService({
    hashService,
    cryptoService: new sdk.CryptoService(),
  });
  const witnessService = new sdk.WitnessPreparationService({
    hashService,
    merkleService,
    noteComputationService: notes,
  });
  const ownerAddress = `0x${'11'.repeat(20)}`;
  const tokenId = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const privateNullifyingKey = `0x${'02'.repeat(32)}`;
  const privateRevocableKey = `0x${'03'.repeat(32)}`;
  function note(owner, secretByte, value) {
    const noteSecret = `0x${secretByte.repeat(32)}`;
    const noteAddressHash = notes.computeNoteAddressHash(owner, noteSecret);
    const fields = { noteAddressHash, tokenId, value: `0x${value.toString(16)}`, label: '0x0a' };
    return {
      ...fields,
      commitment: notes.computeFullCommitment(fields),
      ownerAddress: owner,
      noteSecret,
      isOwned: owner === ownerAddress,
      status: sdk.NoteStatus.ACTIVE,
      createdAtBlock: '0x6553f100',
      spentAtBlock: null,
      txHash: `0x${'ab'.repeat(32)}`,
    };
  }
  const twoInputs = input.circuit === 'transact_2x1';
  const inputNotes = twoInputs
    ? [note(ownerAddress, '04', 5000), note(ownerAddress, '05', 5000)]
    : [note(ownerAddress, '04', 10000)];
  const changeNotes = [note(ownerAddress, '06', 4000)];
  const recipientNotes = twoInputs ? [] : [note(`0x${'22'.repeat(20)}`, '07', 6000)];
  const outputs = [...changeNotes, ...recipientNotes];
  const keystoreLeaves = [
    hashService.hash([
      ownerAddress,
      hashService.hash([privateNullifyingKey]),
      notes.computeAuthDigest(privateRevocableKey),
    ]),
  ];
  const tag = hashService.hash([`0x${Buffer.from('privacy_pools_note').toString('hex')}`]);
  const stateLeaves = inputNotes.map((n) =>
    hashService.hash([tag, n.commitment, n.createdAtBlock])
  );
  const aspLeaves = [notes.computeLabelHash('0x0a')];
  const amountOut = twoInputs ? '0x1770' : '0x0';
  const tokenIdOut = twoInputs ? tokenId : `0x${'00'.repeat(20)}`;
  const witness = await witnessService.buildTransactWitness({
    inputNotes,
    changeNotes,
    recipientNotes,
    ownerAddress,
    privateNullifyingKey,
    privateRevocableKey,
    tokenId,
    amountOut,
    tokenIdOut,
    context: '0x1234',
    stateLeaves,
    keystoreLeaves,
    aspLeaves,
  });
  const expected = [
    ...inputNotes.map((n) => notes.computeNullifier(privateNullifyingKey, n.commitment)),
    ...outputs.map((n) => n.commitment),
    await merkleService.computeRoot(stateLeaves),
    await merkleService.computeRoot(keystoreLeaves),
    await merkleService.computeRoot(aspLeaves),
    amountOut,
    tokenIdOut,
    '0x1234',
  ];
  const prover = require(input.proverEntry);
  const artifact = async (name, kind) => {
    assert.equal(name, input.circuit);
    return input.artifacts[kind];
  };
  const service = new sdk.ProofService({
    circuitArtifacts: {
      getWasm: (name) => artifact(name, 'wasm'),
      getProvingKey: (name) => artifact(name, 'provingKey'),
      getVerificationKey: (name) => artifact(name, 'verificationKey'),
    },
    groth16Prover: {
      fullProve(...args) {
        progress();
        return prover.fullProve(...args);
      },
      verify: (...args) => prover.verify(...args),
    },
  });
  const started = performance.now();
  const proof = await service.proveTransact(witness, inputNotes.length, outputs.length);
  const provingMs = Math.round(performance.now() - started);
  assert.deepEqual(proof.publicSignals.map(BigInt), expected.map(BigInt));
  const verify = (value) => service.verifyTransact(value, inputNotes.length, outputs.length);
  assert.equal(await verify(proof), true);
  const altered = { ...proof, publicSignals: [...proof.publicSignals] };
  altered.publicSignals[inputNotes.length + outputs.length + 3] =
    `0x${(BigInt(amountOut) + 1n).toString(16)}`;
  assert.equal(await verify(altered), false);
  return {
    circuit: input.circuit,
    verified: true,
    publicSignalsBound: true,
    tamperedAmountRejected: true,
    publicSignalCount: expected.length,
    provingMs,
    rssBytes: process.memoryUsage().rss,
  };
};
