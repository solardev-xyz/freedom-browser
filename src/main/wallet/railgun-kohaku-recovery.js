/** Fixed main-owned companion for authenticated discovery and explicit retained
 * operation recovery. Owners remain borrowed; no operation token is recreated. */
const assert = require('assert/strict');
const path = require('path');
const { isProxy, isPromise } = require('util').types;
const { isRailgunAccountEnrollment } = require('./railgun-account-enrollment');
const { assertRailgunIdentity } = require('./railgun-identity');
const { assertRailgunAccountPublicDestination } = require('./railgun-account-public');
const { readRailgunPrivateRecoveryHistory } = require('./railgun-private-recovery-history');
const { resumeRailgunAccountPrivateProof } = require('./railgun-private-proof-recovery');
const { submitRailgunRecoveredPrivateTransaction } = require('./railgun-private-submission');
const fail = () =>
  Object.assign(new Error('Railgun recovery companion unavailable'), {
    code: 'RAILGUN_KOHAKU_RECOVERY_REFUSED',
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
function createRailgunKohakuRecovery(options) {
  try {
    shape(options, [
      'owners',
      'destination',
      'archive',
      'proverArchive',
      'artifactDirectory',
      'reviewDisclosures',
      'reviewTransaction',
      'gasLimit',
      'maxGasFee',
      'signal',
    ]);
    const {
      owners,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      reviewDisclosures,
      reviewTransaction,
      gasLimit,
      maxGasFee,
      signal,
    } = options;
    shape(owners, ['identity', 'enrollment', 'coordinator']);
    const { identity, enrollment, coordinator } = owners;
    assert.ok(isRailgunAccountEnrollment(enrollment));
    signalCurrent(signal);
    for (const value of [archive, proverArchive, artifactDirectory])
      assert.ok(typeof value === 'string' && path.isAbsolute(value));
    assert.equal(typeof reviewDisclosures, 'function');
    assert.equal(typeof reviewTransaction, 'function');
    assert.ok(typeof gasLimit === 'bigint' && gasLimit > 0n && gasLimit <= 3000000n);
    assert.ok(typeof maxGasFee === 'bigint' && maxGasFee > 0n && maxGasFee <= 2000000000000000n);
    const parent = enrollment.getContext('engine');
    const descriptor = JSON.stringify(assertRailgunIdentity(identity, parent));
    assert.equal(JSON.stringify(enrollment.descriptor), descriptor);
    // Authenticate the coordinator before reading any of its exposed fields.
    assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
    const controller = new AbortController();
    const lifetime = AbortSignal.any([
      signal,
      identity.signal,
      enrollment.signal,
      coordinator.signal,
      controller.signal,
    ]);
    const current = () => {
      assert.ok(!lifetime.aborted);
      assert.equal(JSON.stringify(assertRailgunIdentity(identity, parent)), descriptor);
      assert.equal(JSON.stringify(enrollment.descriptor), descriptor);
      assertRailgunAccountPublicDestination(coordinator, enrollment, destination);
    };
    current();
    let busy = false,
      closing = false,
      finishClosed;
    const closed = new Promise((resolve) => {
      finishClosed = resolve;
    });
    const finish = () => {
      if (closing && !busy) {
        lifetime.removeEventListener('abort', close);
        finishClosed();
      }
    };
    function close() {
      if (closing) return;
      closing = true;
      controller.abort();
      finish();
    }
    function invoke(run) {
      try {
        assert.ok(!closing && !busy);
        current();
      } catch {
        return Promise.reject(fail());
      }
      busy = true;
      const settled = () => {
        busy = false;
        finish();
      };
      let pending;
      try {
        pending = run();
        assert.ok(isPromise(pending));
      } catch (error) {
        settled();
        return Promise.reject(error);
      }
      // Register bookkeeping before exposing the original promise. An immediate
      // await-then-action sees idle state; cancellation never replaces settlement.
      Promise.prototype.then.call(pending, settled, settled);
      return pending;
    }
    const boundOwners = Object.freeze({ identity, enrollment, coordinator });
    const common = Object.freeze({
      identity,
      enrollment,
      coordinator,
      destination,
      archive,
      proverArchive,
      artifactDirectory,
      signal: lifetime,
    });
    function action(holdId, submit) {
      if (typeof holdId !== 'string' || !/^[0-9a-f]{64}$/.test(holdId))
        return Promise.reject(fail());
      return invoke(() =>
        submit
          ? submitRailgunRecoveredPrivateTransaction({
              ...common,
              holdId,
              reviewDisclosures,
              reviewTransaction,
              gasLimit,
              maxGasFee,
            })
          : resumeRailgunAccountPrivateProof({ ...common, holdId })
      );
    }
    lifetime.addEventListener('abort', close, { once: true });
    if (lifetime.aborted) close();
    return Object.freeze({
      signal: lifetime,
      closed,
      history: (after = null) =>
        invoke(() =>
          readRailgunPrivateRecoveryHistory({
            owners: boundOwners,
            destination,
            signal: lifetime,
            after,
          })
        ),
      resumeProof: (holdId) => action(holdId, false),
      submitStored: (holdId) => action(holdId, true),
      close,
    });
  } catch {
    throw fail();
  }
}
module.exports = { createRailgunKohakuRecovery };
