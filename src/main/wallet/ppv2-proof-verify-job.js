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
  // Verification has its own pinned single-thread curve path. Refuse worker
  // creation before loading that implementation, even if upstream regresses.
  require('worker_threads').Worker = class {
    constructor() {
      throw new Error('Public verification cannot create workers');
    }
  };
  require('module').syncBuiltinESMExports();
  const verifier = require(input.proverEntry);
  const verified = await verifier.verify(
    JSON.parse(Buffer.from(input.vkey).toString('utf8')),
    input.proof.publicSignals,
    input.proof.proof
  );
  // The module initializes this cache to null; only its multi-thread path
  // populates it with a curve. A fresh verification must leave it empty.
  if (globalThis.curve_bn128 != null) throw new Error('Unexpected shared verification curve');
  return { verified: verified === true };
};
