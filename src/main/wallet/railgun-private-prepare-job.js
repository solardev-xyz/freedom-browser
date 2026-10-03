/** Separate viewing-key-only entry: restores and constructs a public intent.
 * Its unsigned witness dies with this utility. No signature, POI or reservation.
 */
const assert = require('assert/strict');
exports.run = async (inputText, context) => {
  const input = JSON.parse(inputText);
  assert.equal(input.restore, true);
  assert.ok(input.privateIntent);
  return require('./railgun-wallet-job').withWallet(
    inputText,
    context,
    'private-prepare',
    async (restored) => {
      const value = await require('./railgun-private-witness').prepareRailgunPrivateWitness({
        ...restored,
        selection: input.privateIntent,
      });
      return { privatePreparation: value.publicPreparation };
    }
  );
};
