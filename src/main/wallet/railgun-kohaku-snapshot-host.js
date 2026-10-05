/** Fixed main-only bridge borrowing an already-open genuine account. It emits
 * read data, never a receipt or grant, and never scans or closes borrowed owners.
 */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { readRailgunAccountOwnedNotes } = require('./railgun-account-wallet');
const { getRailgunAccountPublicIdentity } = require('./railgun-account-public');
const fail = () =>
  Object.assign(new Error('Kohaku snapshot host unavailable'), {
    code: 'RAILGUN_KOHAKU_SNAPSHOT_REFUSED',
  });
function shape(value, keys) {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
function createRailgunKohakuSnapshotHost(options) {
  try {
    shape(options, ['account', 'owners', 'signal']);
    shape(options.owners, ['identity', 'enrollment', 'coordinator']);
    const { account, signal } = options,
      owners = Object.freeze({ ...options.owners });
    // Genuine owner join precedes accessing account/owner properties.
    readRailgunAccountOwnedNotes(account, owners);
    const signals = [
      signal,
      account.signal,
      owners.identity.signal,
      owners.enrollment.signal,
      owners.coordinator.signal,
    ];
    assert.ok(signals.every((value) => value instanceof AbortSignal && !value.aborted));
    const lifetime = AbortSignal.any(signals);
    function current() {
      assert.ok(!lifetime.aborted);
      const observed = readRailgunAccountOwnedNotes(account, owners);
      const publicIdentity = getRailgunAccountPublicIdentity(owners.coordinator, owners.enrollment);
      assert.ok(!lifetime.aborted);
      return { observed, publicIdentity, view: account.view, generationId: account.generationId };
    }
    current();
    return Object.freeze({
      signal: lifetime,
      capture() {
        try {
          const before = current();
          // These genuine normalized records are already deeply frozen. Only
          // the read projection is supplied; the adapter makes its own copies.
          const snapshot = Object.freeze({
            instanceId: before.observed.read.instanceId,
            received: before.observed.read.received,
          });
          return Object.freeze({
            snapshot,
            assertCurrent() {
              try {
                const after = current();
                assert.equal(after.view, before.view);
                assert.equal(after.generationId, before.generationId);
                assert.equal(after.observed.checkpointHash, before.observed.checkpointHash);
                assert.deepEqual(after.publicIdentity, before.publicIdentity);
                assert.ok(!lifetime.aborted);
              } catch {
                throw fail();
              }
            },
          });
        } catch {
          throw fail();
        }
      },
    });
  } catch {
    throw fail();
  }
}
module.exports = { createRailgunKohakuSnapshotHost };
