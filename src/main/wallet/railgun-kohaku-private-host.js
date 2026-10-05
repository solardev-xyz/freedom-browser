/** Fixed adopting Freedom bridge. Account lifecycle transfers to the genuine
 * facade; identity/enrollment/coordinator remain borrowed. No public accessor
 * exposes its plugin, completion receipt or staging replacement account.
 */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { createRailgunKohakuPlugin } = require('./railgun-kohaku-plugin');
const { createRailgunKohakuBroadcaster } = require('./railgun-kohaku-broadcaster');
const fail = () =>
  Object.assign(new Error('Kohaku private host unavailable'), {
    code: 'RAILGUN_KOHAKU_PRIVATE_HOST_REFUSED',
  });
function createRailgunKohakuPrivateHost(options) {
  let adoptedPlugin;
  try {
    const keys = [
      'account',
      'owners',
      'signal',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'reviewPreparation',
      'reviewTransaction',
      'gasLimit',
      'maxGasFee',
    ];
    assert.ok(options && !isProxy(options) && Object.getPrototypeOf(options) === Object.prototype);
    assert.deepEqual(Reflect.ownKeys(options).sort(), [...keys].sort());
    const copied = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(options, key);
      assert.ok(descriptor && Object.hasOwn(descriptor, 'value'));
      copied[key] = descriptor.value;
    }
    const plugin = createRailgunKohakuPlugin({ ...copied, mode: 'private' });
    adoptedPlugin = plugin;
    const broadcaster = createRailgunKohakuBroadcaster(plugin),
      operations = new WeakMap();
    async function prepare(method, args) {
      const operation = await plugin[method](...args);
      // The facade retains and closes any late completion after cancellation.
      if (plugin.signal.aborted) throw fail();
      const handle = Object.freeze({});
      operations.set(handle, operation);
      return Object.freeze({ handle });
    }
    return Object.freeze({
      signal: plugin.signal,
      closed: plugin.closed,
      instanceId: () => plugin.instanceId(),
      balance: (assets) => plugin.balance(assets),
      notes: (assets, includeSpent) => plugin.notes(assets, includeSpent),
      prepareTransfer: (value, to) => prepare('prepareTransfer', [value, to]),
      prepareUnshield: (value, to, opts) => prepare('prepareUnshield', [value, to, opts]),
      async broadcast(handle) {
        if (!operations.has(handle)) throw fail();
        const operation = operations.get(handle);
        operations.delete(handle);
        return broadcaster.broadcast(operation);
      },
      close: () => {
        plugin.close();
      },
    });
  } catch {
    if (adoptedPlugin) {
      // Revocation is unconditional after adoption. Failure does not assert
      // that the facade's independent drainage barrier has succeeded.
      try {
        adoptedPlugin.close();
      } catch {
        /* Preserve sanitized refusal. */
      }
      Promise.prototype.then.call(
        adoptedPlugin.closed,
        () => {},
        () => {}
      );
    }
    throw fail();
  }
}
module.exports = { createRailgunKohakuPrivateHost };
