/** One reviewed deposit job, invoked only by the main-owned process host.
 * No signer, mnemonic, HTTP client or storage capability enters this process.
 */
const { createHash } = require('crypto');
const { ARTIFACTS, validWitness, validProof } = require('./ppv2-deposit-policy');

exports.run = async function run(input, { progress }) {
  if (!validWitness(input.witness)) throw new Error('Invalid deposit input');
  for (const entry of ARTIFACTS) {
    const bytes = input.artifacts[entry.kind];
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.length !== entry.size ||
      createHash('sha256').update(bytes).digest('hex') !== entry.sha256
    )
      throw new Error('Invalid deposit artifacts');
  }
  require('./ppv2-runtime').assertPPv2RuntimeEntries(input);
  const sdk = require(input.sdkEntry);
  const groth16 = new sdk.Groth16Prover();
  const artifact = (name, kind) => {
    if (name !== 'deposit') throw new Error('Unsupported circuit');
    return Promise.resolve(input.artifacts[kind]);
  };
  const service = new sdk.ProofService({
    circuitArtifacts: {
      getWasm: (name) => artifact(name, 'wasm'),
      getProvingKey: (name) => artifact(name, 'provingKey'),
      getVerificationKey: (name) => artifact(name, 'verificationKey'),
    },
    groth16Prover: {
      fullProve(...args) {
        const result = groth16.fullProve(...args);
        progress();
        return result;
      },
      verify: (...args) => groth16.verify(...args),
    },
  });
  const proof = await service.proveDeposit(input.witness);
  if (!validProof(proof) || !(await service.verifyDeposit(proof)))
    throw new Error('Deposit proof rejected');
  return { verified: true, proof };
};
