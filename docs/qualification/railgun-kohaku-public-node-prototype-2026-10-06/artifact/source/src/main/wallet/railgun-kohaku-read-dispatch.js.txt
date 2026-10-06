/** Internal read sequencing only. Fixed main composition supplies these ports;
 * their shape confers no account, plugin, operation or currentness authority.
 */
const assert = require('assert/strict');
function dispatchRailgunKohakuRead(ports, method, args) {
  try {
    assert.ok(['instanceId', 'balance', 'notes'].includes(method));
    const captured = ports.capture();
    return ports.retain(
      Promise.resolve(captured.view[method](...args))
        .then((result) => {
          ports.recheck(captured);
          return result;
        })
        .catch(() => {
          throw ports.refused();
        })
    );
  } catch {
    return Promise.reject(ports.refused());
  }
}
module.exports = { dispatchRailgunKohakuRead };
