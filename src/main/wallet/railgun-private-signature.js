/** Trusted-host compatibility exports. Validation grants no operation authority. */
const { normalizeRailgunSignature } = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = {
  normalizeRailgunSignature,
};
