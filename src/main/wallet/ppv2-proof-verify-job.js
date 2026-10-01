/** No witness or proving key enters this job. Main pins both the runtime and
 * verification key; the prover's own verified flag is not sufficient.
 */
const { createHash } = require('crypto');
const { validProof, ARTIFACTS: deposit } = require('./ppv2-deposit-policy');
const { ARTIFACTS: ragequit } = require('./ppv2-ragequit-policy');
const { ARTIFACTS: transact } = require('./ppv2-transact-policy');
const circuits = {
  deposit: { artifacts: deposit, signals: 4 },
  ragequit: { artifacts: ragequit, signals: 7 },
  transact_1x1: { artifacts: transact, signals: 8 },
};
exports.run = async function run(input) {
  const config = Object.hasOwn(circuits, input?.circuit) && circuits[input.circuit];
  const expected = config?.artifacts.find((a) => a.kind === 'verificationKey');
  if (
    !config ||
    Object.keys(input).sort().join(',') !== 'circuit,proof,proverEntry,sdkEntry,vkey' ||
    !validProof(input.proof, config.signals) ||
    !(input.vkey instanceof Uint8Array) ||
    input.vkey.length !== expected.size ||
    createHash('sha256').update(input.vkey).digest('hex') !== expected.sha256
  )
    throw new Error('Invalid public proof verification input');
  require('./ppv2-runtime').assertPPv2RuntimeEntries(input);
  const verifier = require(input.proverEntry);
  const verified = await verifier.verify(
    JSON.parse(Buffer.from(input.vkey).toString('utf8')),
    input.proof.publicSignals,
    input.proof.proof
  );
  return { verified: verified === true };
};
