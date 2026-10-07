/** Historical intent checks share the installed package implementation. */
const {
  validateRailgunPrivateSigningIntent,
  matchRailgunPrivateProvedTransaction,
} = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = { validateRailgunPrivateSigningIntent, matchRailgunPrivateProvedTransaction };
