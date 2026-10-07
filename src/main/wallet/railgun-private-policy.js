/** Structural policy compatibility; authority remains with the wallet host. */
const {
  TRANSACT_ABI,
  BOUND_PARAMS,
  validateRailgunPrivateTransaction,
} = require('@freedom/railgun-kohaku-adapter/host/data');
module.exports = { TRANSACT_ABI, BOUND_PARAMS, validateRailgunPrivateTransaction };
