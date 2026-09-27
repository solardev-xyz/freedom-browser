/** Verified native exit, with the reviewed single-thread prover factory. */
const { createHash } = require('crypto');
const { ARTIFACTS, validWitness } = require('./ppv2-ragequit-policy');
const { validProof } = require('./ppv2-deposit-policy');
exports.run = async function run(input, { progress }) {
  if (!validWitness(input.witness)) throw new Error('Invalid exit witness');
  for (const entry of ARTIFACTS) {
    const bytes = input.artifacts[entry.kind];
    if (!(bytes instanceof Uint8Array) || bytes.length !== entry.size ||
        createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('Invalid exit artifact');
  }
  const sdk = require(input.sdkEntry), prover = require(input.proverEntry);
  const artifact = (name, kind) => {
    if (name !== 'ragequit') throw new Error('Unsupported exit circuit');
    return Promise.resolve(input.artifacts[kind]);
  };
  const service = new sdk.ProofService({ circuitArtifacts: {
    getWasm: (name) => artifact(name, 'wasm'), getProvingKey: (name) => artifact(name, 'provingKey'),
    getVerificationKey: (name) => artifact(name, 'verificationKey'),
  }, groth16Prover: {
    fullProve(...args) { const task = prover.fullProve(...args); progress(); return task; },
    verify: (...args) => prover.verify(...args),
  } });
  const proof = await service.proveRagequit(input.witness);
  if (!validProof(proof, 7) || !(await service.verifyRagequit(proof))) throw new Error('Exit proof rejected');
  return { verified: true, proof };
};
