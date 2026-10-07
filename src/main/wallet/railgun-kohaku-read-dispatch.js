/** Compatibility re-export. Internal read sequencing is implemented in
 * @freedom/railgun-kohaku-adapter/read (vendor/railgun-kohaku-adapter/); this
 * module keeps Freedom's require path and export shape.
 */
const { dispatchRailgunKohakuRead } = require('@freedom/railgun-kohaku-adapter/read');
module.exports = { dispatchRailgunKohakuRead };
