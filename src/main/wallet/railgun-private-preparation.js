/** Trusted-host compatibility exports. Validation grants no operation authority. */
const {
  selectRailgunPrivatePreparation,
  normalizeRailgunPrivatePreparation,
  normalizeRailgunPrivateOffer,
  normalizeRailgunPrivateOperation,
} = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = {
  selectRailgunPrivatePreparation,
  normalizeRailgunPrivatePreparation,
  normalizeRailgunPrivateOffer,
  normalizeRailgunPrivateOperation,
};
