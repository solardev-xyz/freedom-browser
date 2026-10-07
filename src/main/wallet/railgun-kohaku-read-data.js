/** Compatibility re-export. The pure read-data projections are implemented in
 * @freedom/railgun-kohaku-adapter/read (vendor/railgun-kohaku-adapter/); this
 * module keeps Freedom's require path and export shape.
 */
const {
  normalizeRailgunKohakuReadFilter,
  projectRailgunKohakuBalance,
  projectRailgunKohakuNotes,
} = require('@freedom/railgun-kohaku-adapter/read');
module.exports = {
  normalizeRailgunKohakuReadFilter,
  projectRailgunKohakuBalance,
  projectRailgunKohakuNotes,
};
