/** Fixed adopting Freedom Shield bridge. The genuine public facade retains
 * account/controller lifetimes; identity/enrollment/coordinator stay borrowed.
 * Public tokens and controller authority never leave this main-owned bridge.
 */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { createRailgunKohakuPlugin } = require('./railgun-kohaku-plugin');
const { createRailgunKohakuPublicSubmitter } = require('./railgun-kohaku-public-submitter');
const fail = () =>
  Object.assign(new Error('Kohaku public host unavailable'), {
    code: 'RAILGUN_KOHAKU_PUBLIC_HOST_REFUSED',
  });
function createRailgunKohakuPublicHost(options) {
  let adoptedPlugin;
  try {
    const keys = [
      'account',
      'owners',
      'signal',
      'archive',
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
    const plugin = createRailgunKohakuPlugin({ ...copied, mode: 'public' });
    adoptedPlugin = plugin;
    const submitter = createRailgunKohakuPublicSubmitter(plugin);
    let operations = new WeakMap(),
      closing = false;
    return Object.freeze({
      signal: plugin.signal,
      closed: plugin.closed,
      instanceId: () => plugin.instanceId(),
      balance: (assets) => plugin.balance(assets),
      notes: (assets, includeSpent) => plugin.notes(assets, includeSpent),
      async prepareShield(value, to) {
        if (closing || plugin.signal.aborted) throw fail();
        const operation = await plugin.prepareShield(value, to);
        // The genuine facade owns any late Shield controller and its drainage.
        if (closing || plugin.signal.aborted) throw fail();
        const handle = Object.freeze({});
        operations.set(handle, operation);
        return Object.freeze({ handle });
      },
      submit(handle) {
        if (closing || plugin.signal.aborted || !operations.has(handle))
          return Promise.reject(fail());
        const operation = operations.get(handle);
        operations.delete(handle);
        // Preserve the original public promise/error; closed separately retains
        // controller work after an early outward cancellation or lost response.
        return submitter.submit(operation);
      },
      close() {
        if (closing) return;
        closing = true;
        operations = new WeakMap();
        plugin.close();
      },
    });
  } catch {
    if (adoptedPlugin) {
      try {
        adoptedPlugin.close();
      } catch {
        /* Still observe the genuine logical drain after revocation failure. */
      }
      // A synchronous constructor refusal cannot await this independent drain
      // and must not turn its eventual rejection into an unhandled promise.
      Promise.prototype.then.call(
        adoptedPlugin.closed,
        () => {},
        () => {}
      );
    }
    throw fail();
  }
}
module.exports = { createRailgunKohakuPublicHost };
