/** Fixed main-only local history discovery. IDs and states are detached data,
 * never retry, submission or ownership authority. Existing-only store opening
 * can refresh leases/floors; it never creates or adopts recovery history. */
const assert = require('assert/strict');
const { isProxy } = require('util').types;
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { assertRailgunAccountPublicDestination } = require('./railgun-account-public');
const fail = () =>
  Object.assign(new Error('Railgun recovery history unavailable'), {
    code: 'RAILGUN_PRIVATE_RECOVERY_HISTORY_REFUSED',
  });
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const signalCurrent = (signal) => {
  assert.ok(signal && !isProxy(signal) && Object.getPrototypeOf(signal) === AbortSignal.prototype);
  assert.ok(!Object.hasOwn(signal, 'aborted') && !Object.hasOwn(signal, 'reason'));
  for (const key of Reflect.ownKeys(signal))
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(signal, key), 'value'));
  assert.equal(Reflect.apply(aborted, signal, []), false);
};
const shape = (value, keys) => {
  assert.ok(value && !isProxy(value) && Object.getPrototypeOf(value) === Object.prototype);
  assert.deepEqual(Reflect.ownKeys(value).sort(), [...keys].sort());
  for (const key of keys)
    assert.ok(Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
};
async function readRailgunPrivateRecoveryHistory(options) {
  let controller, timer;
  try {
    shape(options, ['owners', 'destination', 'signal', 'after']);
    const { owners, destination, signal, after } = options;
    shape(owners, ['identity', 'enrollment', 'coordinator']);
    const { identity, enrollment, coordinator } = owners;
    signalCurrent(signal);
    assert.ok(after === null || (typeof after === 'string' && /^[0-9a-f]{64}$/.test(after)));
    assert.ok(isRailgunAccountEnrollment(enrollment));
    const parent = enrollment.getContext('engine');
    const descriptor = JSON.stringify(assertRailgunIdentity(identity, parent));
    assert.equal(JSON.stringify(enrollment.descriptor), descriptor);
    // Authenticate the coordinator before reading any of its exposed fields.
    assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
    controller = new AbortController();
    const lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const started = performance.now(),
      deadline = started + 45000;
    const current = () => {
      assert.ok(!lifetime.aborted && performance.now() >= started && performance.now() < deadline);
      assert.equal(JSON.stringify(assertRailgunIdentity(identity, parent)), descriptor);
      assert.equal(JSON.stringify(enrollment.descriptor), descriptor);
      assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
    };
    current();
    timer = setTimeout(() => controller.abort(), 45000);
    timer.unref?.();
    const { reservations, capsules } = await enrollment.openPrivateRecoveryStores();
    current();
    const page = await reservations.withSigningRecovery(
      async (values, context) => {
        const active = () => {
          context.assertCurrent();
          current();
        };
        active();
        assert.ok(Array.isArray(values) && values.length <= 512);
        const ids = new Set();
        for (const { entry } of values) {
          assert.equal(entry.state, 'signing');
          assert.match(entry.id, /^[0-9a-f]{64}$/);
          assert.ok(!ids.has(entry.id));
          ids.add(entry.id);
        }
        const ordered = [...values].sort((a, b) =>
          a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0
        );
        const remaining = ordered.filter(({ entry }) => after === null || entry.id > after);
        const records = [];
        for (const { entry, receipt } of remaining.slice(0, 16)) {
          active();
          let stored, localState;
          try {
            try {
              stored = await capsules.readSignedUnfinished(receipt);
              localState = 'signed-unfinished';
            } catch (error) {
              if (error.code !== 'RAILGUN_CAPSULE_NOT_READY') throw error;
              active();
              try {
                stored = await capsules.readSigned(receipt);
                localState = 'proof-present';
              } catch (error) {
                if (error.code !== 'RAILGUN_CAPSULE_NOT_READY') throw error;
                // Both readers checked capsule/reservation binding before readiness.
                // Missing signature is a diagnostic, not a checked signing digest.
                localState = 'signature-unavailable';
              }
            }
          } catch (error) {
            if (error.code !== 'RAILGUN_CAPSULE_NOT_FOUND') throw error;
            localState = 'capsule-unavailable';
          }
          active();
          if (stored) {
            assert.equal(stored.holdId, entry.id);
            assert.equal(stored.capsule.walletId, enrollment.descriptor.walletId);
          }
          assert.ok(
            [
              'railgun-private-transfer',
              'railgun-token-unshield',
              'railgun-partial-unshield',
            ].includes(entry.facts.kind)
          );
          records.push(Object.freeze({ holdId: entry.id, kind: entry.facts.kind, localState }));
        }
        active();
        return Object.freeze({
          records: Object.freeze(records),
          nextAfter: remaining.length > 16 ? records.at(-1).holdId : null,
          totalSigning: values.length,
        });
      },
      { timeoutMs: Math.max(1, Math.floor(deadline - performance.now())) }
    );
    current();
    return page;
  } catch {
    throw fail();
  } finally {
    clearTimeout(timer);
    controller?.abort();
  }
}
module.exports = { readRailgunPrivateRecoveryHistory };
