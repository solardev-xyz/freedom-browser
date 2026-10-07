/** Trusted-host compatibility exports. Validation grants no operation authority. */
const {
  normalizeRailgunPrivateRecoveryInput,
  normalizeRailgunPrivateRecoveryResult,
} = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = {
  normalizeRailgunPrivateRecoveryInput,
  normalizeRailgunPrivateRecoveryResult,
};
