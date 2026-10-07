/** Trusted-host POI data exports. Values grant no account or disclosure authority. */
const {
  createRailgunTxidProjection,
  validateRailgunTxidRow,
} = require('@freedom/railgun-kohaku-adapter/host/poi');
module.exports = {
  createRailgunTxidProjection,
  validateRailgunTxidRow,
};
