/** Verification only: public 1x1 proof plus pinned verification key. */
const { createHash } = require('crypto');
const { validProof } = require('./ppv2-deposit-policy');
const VKEY = Object.freeze({ name: 'transact_1x1.vkey.json', size: 4531,
  sha256: 'e429d3e895de5cc9d2839a3fd8303fadd30be3759bac06ce7fb063ceda198308' });
exports.VKEY = VKEY;
exports.run = async function run(input) {
  if (!validProof(input.proof, 8) || !(input.vkey instanceof Uint8Array) || input.vkey.length !== VKEY.size ||
      createHash('sha256').update(input.vkey).digest('hex') !== VKEY.sha256) throw new Error('Invalid relay verification input');
  const sdk = require(input.sdkEntry);
  const service = new sdk.ProofService({ groth16Prover: new sdk.Groth16Prover(), circuitArtifacts: {
    getVerificationKey: async (name) => { if (name !== 'transact_1x1') throw new Error('Unsupported circuit'); return input.vkey; },
  } });
  return { verified: await service.verifyTransact(input.proof, 1, 1) };
};
