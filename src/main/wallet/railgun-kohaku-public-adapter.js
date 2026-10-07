/** Compatibility re-export. The restricted public Shield trusted-host interface
 * is implemented in @freedom/railgun-kohaku-adapter (vendor/railgun-kohaku-adapter/);
 * this module keeps Freedom's require path and export shape.
 */
const {
  createRailgunKohakuPublicAdapter,
  createRailgunKohakuPublicAdapterSubmitter,
} = require('@freedom/railgun-kohaku-adapter');
module.exports = { createRailgunKohakuPublicAdapter, createRailgunKohakuPublicAdapterSubmitter };
