/** Compatibility re-export. The restricted host-relative transaction interface
 * is implemented in @freedom/railgun-kohaku-adapter (vendor/railgun-kohaku-adapter/);
 * this module keeps Freedom's require path and export shape.
 */
const {
  createRailgunKohakuPrivateAdapter,
  createRailgunKohakuPrivateAdapterBroadcaster,
} = require('@freedom/railgun-kohaku-adapter');
module.exports = {
  createRailgunKohakuPrivateAdapter,
  createRailgunKohakuPrivateAdapterBroadcaster,
};
