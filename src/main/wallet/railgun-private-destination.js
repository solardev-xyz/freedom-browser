/** Trusted-host compatibility exports. Validation grants no operation authority. */
const {
  isRailgunForeignTransfer,
  assertRailgunPrivateTransferRecipient,
  decodeRailgunForeignDestination,
  verifyRailgunForeignOutput,
} = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = {
  isRailgunForeignTransfer,
  assertRailgunPrivateTransferRecipient,
  decodeRailgunForeignDestination,
  verifyRailgunForeignOutput,
};
