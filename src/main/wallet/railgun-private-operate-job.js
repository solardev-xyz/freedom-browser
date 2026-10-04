/** Restored-wallet prepare/prove utility. Main authorizes only an exact public
 * intent; the witness remains here while the separate signer runs. A refusal is
 * a normal result, so the host can re-attest the read-only wallet window.
 */
const assert = require('assert/strict');
const { AbiCoder } = require('ethers');
const { BOUND_PARAMS } = require('./railgun-private-policy');
exports.run = async (inputText, context) => {
  const input = JSON.parse(inputText);
  assert.equal(input.restore, true);
  assert.ok(input.privateIntent && input.privateOperation);
  assert.deepEqual(Object.keys(input.privateOperation).sort(), [
    'artifactDirectory',
    'proverArchive',
  ]);
  return require('./railgun-wallet-job').withWallet(
    inputText,
    context,
    'private-operate',
    async (restored) => {
      let prover;
      try {
        prover = await require('./railgun-private-prover').createRailgunPrivateProver({
          intentKind: input.privateIntent.kind,
          archive: restored.archive,
          proverArchive: input.privateOperation.proverArchive,
          artifactDirectory: input.privateOperation.artifactDirectory,
          spendingPublicKey: restored.descriptor.spendingPublicKey.map((v) => '0x' + v),
          signal: restored.signal,
        });
        const prepared = await require('./railgun-private-witness').prepareRailgunPrivateWitness({
          ...restored,
          selection: input.privateIntent,
        });
        const selected = restored.scan.ownedPoi.filter(
          (v) => v.id === `${input.privateIntent.tree}:${input.privateIntent.position}`
        );
        assert.equal(selected.length, 1);
        const capsule = require('./railgun-private-capsule').normalizeRailgunPrivateCapsule({
          version: input.privateIntent.kind === 'railgun-partial-unshield' ? 2 : 1,
          walletId: restored.descriptor.walletId,
          engineSha256: require('./railgun-engine-manifest.json').sha256,
          selection: input.privateIntent,
          preparation: prepared.publicPreparation,
          noteHash: selected[0].hash,
          pathElements: prepared.witness.privateInputs.pathElements[0].map(
            (v) => '0x' + v.toString(16).padStart(64, '0')
          ),
        });
        // Exercise the recovery path before signing can make this intent durable.
        // A copying/encoding bug must refuse now, not strand a signed hold later.
        const reconstructed =
          await require('./railgun-private-reconstruct').reconstructRailgunPrivateWitness({
            ...restored,
            capsule,
          });
        assert.deepEqual(reconstructed.witness.privateInputs, prepared.witness.privateInputs);
        assert.deepEqual(reconstructed.witness.publicInputs, prepared.witness.publicInputs);
        // Decoded ethers tuples and SDK objects have different representations.
        // Compare their exact ABI bytes, including the original ciphertext.
        const coder = AbiCoder.defaultAbiCoder();
        assert.equal(
          coder.encode([BOUND_PARAMS], [reconstructed.witness.boundParams]),
          coder.encode([BOUND_PARAMS], [prepared.witness.boundParams])
        );
        assert.ok(!restored.signal.aborted);
        const response = await restored.exchangePrivateIntent({
          preparation: prepared.publicPreparation,
          capsule,
        });
        assert.ok(response && typeof response === 'object' && !Array.isArray(response));
        assert.ok(!restored.signal.aborted);
        if (response.status === 'refused') {
          assert.deepEqual(Object.keys(response), ['status']);
          return {
            privatePreparation: prepared.publicPreparation,
            privateOperation: { status: 'refused' },
          };
        }
        assert.deepEqual(Object.keys(response).sort(), ['signature', 'status']);
        assert.equal(response.status, 'signed');
        const proof = await prover.prove(reconstructed, response.signature);
        return {
          privatePreparation: prepared.publicPreparation,
          privateOperation: { status: 'proved', ...proof },
        };
      } finally {
        prover?.close();
      }
    }
  );
};
