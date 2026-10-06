/** Disposable qualifier observers. Delegates are genuine exports, never issuers.
 * Counter equality covers these seams, not SQL/filesystem/OS activity. */
const nativeAssertions = require('./railgun-native-assertions');
const { assert } = nativeAssertions;
const oracle = require('./railgun-kohaku-contract-oracle');
const wallet = '../../src/main/wallet/';
// Fixture watchdog only: timeout is a sticky qualification failure, never a
// substitute for observed resource/child settlement. Keep it referenced.
async function boundedDrain(promise, label) {
  let timer;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = Error('Kohaku fixture resource-drain-timeout');
          nativeAssertions.record(error, label + '.resource-drain-timeout');
          reject(error);
        }, 150000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function installResourceMeter() {
  const counts = {
    utilityStarts: 0,
    utilitySettlements: 0,
    workerStarts: 0,
    workerSettlements: 0,
    rejectedBarriers: 0,
  };
  const installed = [],
    pending = [];
  let active = true,
    closing;
  function wrap(module, name, start, end) {
    const original = module[name];
    assert.equal(typeof original, 'function');
    const observed = (...args) => {
      assert.equal(active, true);
      counts[start]++;
      const task = original(...args);
      assert.ok(task.closed && typeof task.closed.then === 'function');
      pending.push(
        task.closed.then(
          () => {
            counts[end]++;
          },
          (error) => {
            counts[end]++;
            counts.rejectedBarriers++;
            nativeAssertions.record(error, 'kohaku-contract.' + name + '.closed');
          }
        )
      );
      return task;
    };
    module[name] = observed;
    installed.push(() => {
      assert.equal(module[name], observed);
      module[name] = original;
    });
  }
  for (const name of ['railgun-process', 'railgun-session-worker'])
    assert.equal(
      !!require.cache[require.resolve(wallet + name)],
      false,
      'Install before resource providers'
    );
  const session = require(wallet + 'railgun-session-worker');
  for (const name of ['startRailgunSessionWorker', 'startRailgunReadOnlySessionWorker'])
    wrap(session, name, 'workerStarts', 'workerSettlements');
  const process = require(wallet + 'railgun-process');
  wrap(process, 'startRailgunProcess', 'utilityStarts', 'utilitySettlements');
  return Object.freeze({
    snapshot: () => ({ ...counts }),
    close() {
      if (closing) return closing;
      active = false;
      // Owners close the resources first. Await all counter/error observations
      // before the final sticky gate; this is not independent physical-exit evidence.
      closing = (async () => {
        try {
          for (const restore of installed.reverse()) {
            try {
              restore();
            } catch (error) {
              nativeAssertions.record(error, 'kohaku-contract.provider.restore');
            }
          }
        } finally {
          await boundedDrain(Promise.all(pending), 'kohaku-contract.resources');
          pending.length = 0;
        }
      })();
      return closing;
    },
  });
}
function installSettlementObserver(lane) {
  assert.ok(['private', 'public'].includes(lane));
  const adapter =
    lane === 'private' ? 'railgun-kohaku-broadcaster' : 'railgun-kohaku-public-submitter';
  assert.equal(
    !!require.cache[require.resolve(wallet + adapter)],
    false,
    'Install before adapter import'
  );
  const facade = require(wallet + 'railgun-kohaku-plugin');
  const name =
    lane === 'private' ? 'broadcastRailgunKohakuOperation' : 'submitRailgunKohakuPublicOperation';
  const original = facade[name];
  assert.equal(typeof original, 'function');
  const records = [],
    pending = [];
  const counts = {
    delegateCalls: 0,
    delegateSettlements: 0,
    checkedCalls: 0,
    acknowledged: 0,
    uncertain: 0,
    refused: 0,
    unresolved: 0,
  };
  let active = true,
    hiddenPublicUsed = false;
  const settle = (promise) =>
    Promise.resolve(promise).then(
      (value) => ({
        status: 'fulfilled',
        value,
        promiseReturned: !!promise && typeof promise.then === 'function',
      }),
      (reason) => ({
        status: 'rejected',
        reason,
        promiseReturned: !!promise && typeof promise.then === 'function',
      })
    );
  const observed = (instance, operation) => {
    assert.equal(active, true);
    counts.delegateCalls++;
    const promise = original(instance, operation);
    const settled = settle(promise).then((value) => {
      counts.delegateSettlements++;
      return value;
    });
    records.push({ instance, operation, settled });
    pending.push(settled);
    return promise;
  };
  facade[name] = observed;
  return Object.freeze({
    begin(instance, operation, invoke) {
      assert.equal(active, true);
      const index = records.length;
      const promise = invoke();
      const caller = settle(promise);
      pending.push(caller);
      assert.equal(records.length, index + 1, 'Exactly one delegate entry per adapter call');
      const delegated = records[index];
      assert.equal(delegated.instance, instance);
      assert.equal(delegated.operation, operation);
      let checked = false;
      return Object.freeze({
        promise,
        async assert(expected) {
          assert.equal(checked, false);
          const actual = await caller;
          const source = await delegated.settled;
          // The meaningful identity check compares result/error values inside
          // these independently populated records, not the fresh wrapper objects.
          oracle.assertForwardedSettlement(actual, source, { ...expected, lane });
          checked = true;
          counts.checkedCalls++;
          counts[expected.outcome]++;
        },
      });
    },
    beginHiddenPublic(operation, invoke) {
      assert.equal(active, true);
      assert.equal(lane, 'public');
      hiddenPublicUsed = true;
      oracle.assertOpaqueOperationShape(operation, 'public');
      const index = records.length;
      const promise = invoke();
      const caller = settle(promise);
      pending.push(caller);
      assert.equal(records.length, index + 1, 'Exactly one hidden genuine public delegate');
      const delegated = records[index];
      facade.assertRailgunKohakuPublicPlugin(delegated.instance);
      oracle.assertOpaqueOperationShape(delegated.operation, 'public');
      assert.notEqual(delegated.operation, operation, 'Portable and genuine facade tokens differ');
      let checked = false;
      return Object.freeze({
        promise,
        async assert(expected) {
          assert.equal(checked, false);
          const actual = await caller,
            source = await delegated.settled;
          oracle.assertForwardedSettlement(actual, source, { ...expected, lane });
          const value = actual.status === 'fulfilled' ? actual.value : actual.reason;
          const fields = Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => {
                const descriptor = Object.getOwnPropertyDescriptor(value, key);
                assert.ok(Object.hasOwn(descriptor, 'value'));
                return [key, typeof descriptor.value];
              })
          );
          assert.deepEqual(
            fields,
            expected.outcome === 'acknowledged'
              ? {
                  broadcastSource: 'string',
                  chainId: 'number',
                  explorerUrl: 'object',
                  from: 'string',
                  hash: 'string',
                  nonce: 'number',
                  to: 'string',
                  value: 'string',
                }
              : expected.outcome === 'uncertain'
                ? {
                    code: 'string',
                    submissionStatus: 'string',
                    transactionHash: 'string',
                  }
                : { code: 'string' }
          );
          if (expected.outcome === 'acknowledged') {
            assert.equal(typeof expected.requestedAmount, 'string');
            assert.equal(value.value, expected.requestedAmount);
            assert.equal(value.explorerUrl, null);
          }
          checked = true;
          counts.checkedCalls++;
          counts[expected.outcome]++;
          return Object.freeze({
            acknowledgedValueEqualsRequest: expected.outcome === 'acknowledged',
            journalErrorCode: expected.outcome === 'uncertain' ? value.code : null,
            canonicalUncertaintyHash: expected.outcome === 'uncertain',
            status: actual.status,
            fields: Object.freeze(fields),
            originalValueOrErrorIdentity: true,
            genuinePublicFacadeTokenDistinct: true,
          });
        },
      });
    },
    report: () => ({ ...counts }),
    async close() {
      if (!active) return;
      active = false;
      try {
        assert.equal(facade[name], observed);
        facade[name] = original;
      } finally {
        await boundedDrain(Promise.all(pending), 'kohaku-contract.settlements');
        assert.equal(counts.delegateCalls, counts.delegateSettlements);
        if (hiddenPublicUsed) assert.equal(counts.delegateCalls, counts.checkedCalls);
        records.length = 0;
        pending.length = 0;
      }
    },
  });
}
module.exports = { installResourceMeter, installSettlementObserver };
