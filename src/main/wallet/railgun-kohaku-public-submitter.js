/** Main-owned public Shield handoff bound to one genuine Kohaku instance.
 * Public operations use this submitter, not the private broadcaster interface.
 */
const {
  assertRailgunKohakuPublicPlugin,
  submitRailgunKohakuPublicOperation,
} = require('./railgun-kohaku-plugin');
function createRailgunKohakuPublicSubmitter(plugin) {
  assertRailgunKohakuPublicPlugin(plugin);
  return Object.freeze({
    submit: (operation) => submitRailgunKohakuPublicOperation(plugin, operation),
  });
}
module.exports = { createRailgunKohakuPublicSubmitter };
