/** Compatibility re-export. The completed host-supplied snapshot plugin is
 * implemented in @freedom/railgun-kohaku-adapter (vendor/railgun-kohaku-adapter/);
 * this module keeps Freedom's require path and export shape.
 */
const { createRailgunKohakuSnapshotPlugin } = require('@freedom/railgun-kohaku-adapter');
module.exports = { createRailgunKohakuSnapshotPlugin };
