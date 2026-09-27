/** Keys and note secret enter only this bounded, cancellable proof job. */
const { createHash } = require('crypto');
const { ARTIFACTS, validWitness } = require('./ppv2-transact-policy');
const { validProof } = require('./ppv2-deposit-policy');
exports.run = async function run(input, { progress }) {
  if (!validWitness(input.witness)) throw new Error('Invalid withdrawal witness');
  for (const e of ARTIFACTS) {
    const bytes = input.artifacts[e.kind];
    if (!(bytes instanceof Uint8Array) || bytes.length !== e.size || createHash('sha256').update(bytes).digest('hex') !== e.sha256) throw new Error('Invalid artifact');
  }
  const sdk = require(input.sdkEntry), prover = require(input.proverEntry), w = input.witness;
  const hashService = await sdk.PoseidonHashService.create();
  const notes = new sdk.NoteComputationService({ hashService, cryptoService: new sdk.CryptoService() });
  const commitment = notes.computeFullCommitment({ noteAddressHash: notes.computeNoteAddressHash(w.ownerAddress, w.noteSecret[0]),
    tokenId: w.tokenId, value: w.value[0], label: w.label[0] });
  if (BigInt(commitment) !== BigInt(input.commitment)) throw new Error('Input note mismatch');
  const expectedNullifier = notes.computeNullifier(w.privateNullifyingKey, commitment);
  const outputCommitment = notes.computeFullCommitment({ noteAddressHash: w.outputNoteAddressHash[0], tokenId: w.tokenId,
    value: w.outputValue[0], label: w.outputLabel[0] });
  const artifact = (name, kind) => { if (name !== 'transact_1x1') throw new Error('Unsupported circuit'); return Promise.resolve(input.artifacts[kind]); };
  const service = new sdk.ProofService({ circuitArtifacts: { getWasm: (n) => artifact(n, 'wasm'), getProvingKey: (n) => artifact(n, 'provingKey'),
    getVerificationKey: (n) => artifact(n, 'verificationKey') }, groth16Prover: {
    fullProve(...args) { const p = prover.fullProve(...args); progress(); return p; }, verify: (...args) => prover.verify(...args),
  } });
  const proof = await service.proveTransact(w, 1, 1);
  if (!validProof(proof, 8) || !(await service.verifyTransact(proof, 1, 1)) ||
      BigInt(proof.publicSignals[0]) !== BigInt(expectedNullifier) || BigInt(proof.publicSignals[1]) !== BigInt(outputCommitment)) throw new Error('Proof mismatch');
  return { verified: true, proof };
};
