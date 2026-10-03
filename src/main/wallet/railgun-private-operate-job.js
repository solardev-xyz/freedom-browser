/** Restored-wallet prepare/prove utility. Main authorizes only an exact public
 * intent; the witness remains here while the separate signer runs. A refusal is
 * a normal result, so the host can re-attest the read-only wallet window.
 */
const assert = require('assert/strict');
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
        const response = await restored.exchangePrivateIntent(prepared.publicPreparation);
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
        const proof = await prover.prove(prepared, response.signature);
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
