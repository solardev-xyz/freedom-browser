/** Historical data checks are shared; current engine/account binding stays here. */
const assert = require('assert/strict');
const {
  normalizeRailgunPrivateCapsule,
  digestRailgunPrivateCapsule,
} = require('@freedom/railgun-kohaku-adapter/host/data');
function normalizeRailgunNewCapsule(value, { walletId, selection, preparation, noteHash }) {
  const normalized = normalizeRailgunPrivateCapsule(value);
  const partial = selection?.kind === 'railgun-partial-unshield';
  const {
    transaction,
    expected,
    expectedHash,
    recipient,
    amount,
    inputAmount,
    unshieldAmount,
    changeAmount,
  } = preparation;
  const expectedCapsule = normalizeRailgunPrivateCapsule({
    version: partial ? 2 : 1,
    walletId,
    selection,
    engineSha256: require('./railgun-engine-manifest.json').sha256,
    preparation: {
      transaction,
      expected,
      expectedHash,
      recipient,
      ...(partial ? { inputAmount, unshieldAmount, changeAmount } : { amount }),
    },
    noteHash: noteHash === undefined ? normalized.noteHash : noteHash,
    pathElements: normalized.pathElements,
  });
  assert.deepEqual(normalized, expectedCapsule);
  return expectedCapsule;
}
module.exports = {
  normalizeRailgunPrivateCapsule,
  digestRailgunPrivateCapsule,
  normalizeRailgunNewCapsule,
};
