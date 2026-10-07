/** Trusted-host compatibility exports. Validation grants no operation authority. */
const {
  normalizeRailgunSignature,
  normalizeRailgunSpendSignature,
  normalizeRailgunSpendKeyRequest,
  normalizeRailgunPrivateVerification,
  normalizeRailgunPrivateReceiver,
} = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = {
  normalizeRailgunSignature,
  normalizeRailgunSpendSignature,
  normalizeRailgunSpendKeyRequest,
  normalizeRailgunPrivateVerification,
  normalizeRailgunPrivateReceiver,
};
