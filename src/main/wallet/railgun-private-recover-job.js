/** Fixed viewing-only recovery utility: reconstruct the saved intent and reuse
 * its original signature. No preparation, random output, signer or POI exchange. */
const assert = require('assert/strict');
const { normalizeRailgunPrivateRecoveryInput } = require('./railgun-private-recovery-data');
exports.run = async (inputText, context) => {
  const input = JSON.parse(inputText);
  assert.equal(input.restore, true);
  assert.ok(!Object.hasOwn(input, 'privateIntent') && !Object.hasOwn(input, 'privateOperation'));
  const recovery = normalizeRailgunPrivateRecoveryInput(input.privateRecovery, {
    walletId: input.walletId,
  });
  return require('./railgun-wallet-job').withWallet(
    inputText,
    context,
    'private-recover',
    async (restored) => {
      let prover;
      const active = () => assert.ok(!restored.signal.aborted);
      try {
        active();
        assert.equal(restored.descriptor.walletId, recovery.capsule.walletId);
        assert.equal(restored.exchangePrivateIntent, undefined);
        const reconstructed =
          await require('./railgun-private-reconstruct').reconstructRailgunPrivateWitness({
            ...restored,
            capsule: recovery.capsule,
          });
        active();
        prover = await require('./railgun-private-prover').createRailgunPrivateProver({
          intentKind: recovery.capsule.selection.kind,
          archive: restored.archive,
          proverArchive: recovery.proverArchive,
          artifactDirectory: recovery.artifactDirectory,
          spendingPublicKey: restored.descriptor.spendingPublicKey.map((v) => '0x' + v),
          signal: restored.signal,
        });
        active();
        const proof = await prover.prove(reconstructed, recovery.signature);
        active();
        return { privateRecovery: { status: 'proved', ...proof } };
      } finally {
        prover?.close();
      }
    }
  );
};
