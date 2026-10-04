/** Utility-only proof execution over a witness retained by its preparer. Load
 * every artifact before requesting a signature. Neither witness nor key leaves
 * this utility; the final transaction still needs independent verification.
 */
const assert = require('assert/strict'),
  path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('./railgun-private-intent');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SUBGROUP = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;
const field = (value, limit = FIELD) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < limit;
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
async function createRailgunPrivateProver({
  archive,
  proverArchive,
  artifactDirectory,
  spendingPublicKey,
  signal,
  intentKind,
}) {
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  const legacyKinds = ['railgun-private-transfer', 'railgun-token-unshield'];
  assert.ok(
    intentKind === undefined || [...legacyKinds, 'railgun-partial-unshield'].includes(intentKind)
  );
  const partial = intentKind === 'railgun-partial-unshield',
    outputCount = partial ? 2 : 1;
  assert.ok(
    Array.isArray(spendingPublicKey) &&
      spendingPublicKey.length === 2 &&
      spendingPublicKey.every((v) => field(v))
  );
  const publicKey = spendingPublicKey.map(BigInt);
  archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const engine = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { poseidon, initPoseidonPromise } = require(path.join(engine, 'utils/poseidon'));
  await initPoseidonPromise;
  const { verifyEDDSA } = require(path.join(engine, 'utils/keys-utils'));
  const { Prover } = require(path.join(engine, 'prover/prover'));
  const serial = require('./railgun-prover-runtime').loadRailgunProverRuntime(proverArchive);
  const scope = require('../networks/privacy-context').createPrivacyScope({
    profileId: 'railgun-private-prover',
    signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'proof',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'artifacts',
  });
  let artifacts,
    closed = false,
    used = false;
  const active = () => assert.ok(!closed && !scope.signal.aborted);
  const close = () => {
    if (closed) return;
    closed = true;
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope.close();
  };
  try {
    artifacts = await require('./railgun-artifacts').loadRailgunArtifacts({
      handle,
      directory: artifactDirectory,
      variant: partial ? '01x02' : '01x01',
    });
    active();
    const prover = new Prover({
      assertArtifactExists: (inputs, outputs) => {
        assert.equal(inputs, 1);
        assert.equal(outputs, outputCount);
      },
      getArtifacts: async (pub) => {
        active();
        assert.equal(pub.nullifiers.length, 1);
        assert.equal(pub.commitmentsOut.length, outputCount);
        return artifacts;
      },
    });
    prover.setSnarkJSGroth16(serial);
    async function prove(prepared, signature) {
      active();
      assert.equal(used, false);
      used = true;
      try {
        const { witness, transaction, publicPreparation } = prepared;
        assert.deepEqual(witness.privateInputs.publicKey, publicKey);
        const intent = Object.freeze({ ...publicPreparation.transaction });
        const expected = Object.freeze({ ...publicPreparation.expected });
        const checked = validateRailgunPrivateSigningIntent(intent, expected);
        assert.ok(
          intentKind === undefined
            ? legacyKinds.includes(checked.kind)
            : checked.kind === intentKind
        );
        const commitments = partial
          ? [checked.changeCommitment, checked.unshieldCommitment]
          : [checked.commitment];
        const pub = witness.publicInputs;
        assert.deepEqual(
          [pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut].map(hex),
          [checked.merkleRoot, checked.boundParamsHash, checked.nullifier, ...commitments]
        );
        const message = poseidon([
          pub.merkleRoot,
          pub.boundParamsHash,
          ...pub.nullifiers,
          ...pub.commitmentsOut,
        ]);
        assert.equal(hex(message), publicPreparation.expectedHash);
        assert.deepEqual(Object.keys(signature).sort(), ['R8', 'S']);
        assert.ok(
          Array.isArray(signature.R8) &&
            signature.R8.length === 2 &&
            signature.R8.every((v) => field(v)) &&
            field(signature.S, SUBGROUP)
        );
        const checkedSignature = { R8: signature.R8.map(BigInt), S: BigInt(signature.S) };
        assert.equal(verifyEDDSA(message, checkedSignature, publicKey), true);
        active();
        const proved = await transaction.generateProvedTransaction(
          'V2_PoseidonMerkle',
          prover,
          { ...witness, signature: [...checkedSignature.R8, checkedSignature.S] },
          () => {}
        );
        active();
        const finalTransaction = Object.freeze({
          ...intent,
          data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[proved]]),
        });
        const final = matchRailgunPrivateProvedTransaction(intent, finalTransaction, expected);
        return Object.freeze({
          transaction: finalTransaction,
          transactionDigest: final.digest,
          independentlyVerified: false,
        });
      } finally {
        close();
      }
    }
    return Object.freeze({ prove, close });
  } catch (error) {
    close();
    throw error;
  }
}
module.exports = { createRailgunPrivateProver };
