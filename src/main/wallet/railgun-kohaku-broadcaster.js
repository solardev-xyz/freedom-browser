/** Kohaku private broadcaster bound to one genuine main-owned instance.
 * Public Shield operations deliberately have no route through this interface.
 */
const {
  assertRailgunKohakuPrivatePlugin,
  broadcastRailgunKohakuOperation,
} = require('./railgun-kohaku-plugin');
function createRailgunKohakuBroadcaster(plugin) {
  assertRailgunKohakuPrivatePlugin(plugin);
  return Object.freeze({
    broadcast: (operation) => broadcastRailgunKohakuOperation(plugin, operation),
  });
}
module.exports = { createRailgunKohakuBroadcaster };
