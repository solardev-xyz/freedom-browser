/** Opt-in offline evidence over genuine owners. No authority or host is issued.
 * Counters measure supplied fixture seams, not all OS or transport activity. */
const native = require('./railgun-native-assertions');
const { assert } = native;
const oracle = require('./railgun-kohaku-contract-oracle');
const wallet = '../../src/main/wallet/';
async function qualifyPrivateAdapterReads({ adapter, account, owners, measure }) {
  const { readRailgunAccountOwnedNotes: read } = require(wallet + 'railgun-account-wallet');
  const baseline = read(account, owners);
  const clone = (value) =>
    Array.isArray(value)
      ? value.map(clone)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]))
        : value;
  const expected = clone(baseline);
  assert.equal(expected.read.instanceId, owners.identity.descriptor.instanceId);
  assert.equal(Object.isFrozen(adapter), true);
  assert.deepEqual(
    Object.keys(adapter).sort(),
    [
      'balance',
      'close',
      'closed',
      'instanceId',
      'notes',
      'prepareTransfer',
      'prepareUnshield',
      'provenance',
      'signal',
    ].sort()
  );
  assert.equal(adapter.provenance, 'host-supplied');
  const before = measure();
  const calls = [
    ['instanceId', []],
    ['balance', []],
    ['notes', []],
    ['notes', [undefined, true]],
    ['balance', [[]]],
    ['notes', [[], true]],
    ['balance', [[{ __type: 'native' }]]],
  ];
  assert.ok(expected.read.received.length >= 3, 'Fixed genuine fixture has three read examples');
  for (const asset of expected.read.received.slice(0, 3).map((note) => note.asset)) {
    const filter = {
      ...asset,
      ...(asset.contract ? { contract: '0x' + asset.contract.slice(2).toUpperCase() } : {}),
    };
    calls.push(['balance', [[filter]]], ['notes', [[filter], true]]);
  }
  for (const [method, args] of calls) {
    const pending = adapter[method](...args);
    const value = await pending;
    oracle.assertReadProjection(expected.read, {
      method,
      args,
      value,
      promiseReturned: pending instanceof Promise,
    });
    if (Array.isArray(value)) {
      assert.equal(Object.isFrozen(value), false, 'Returned array is mutable');
      // Mutate only returned detached data. A live borrowed snapshot must never
      // change, even if an implementation accidentally shares nested assets.
      for (const item of value) {
        const changed = item.amount + 1n;
        item.amount = changed;
        assert.equal(item.amount, changed, 'Returned record is mutable');
        item.asset.__type = 'fixture-mutated';
        assert.equal(item.asset.__type, 'fixture-mutated', 'Returned asset is mutable');
      }
      value.length = 0;
      assert.equal(value.length, 0, 'Returned array is mutable');
    }
    assert.deepEqual(read(account, owners), expected);
    assert.deepEqual(baseline, expected);
    assert.equal(owners.identity.descriptor.instanceId, expected.read.instanceId);
    assert.deepEqual(measure(), before, 'Adapter reads added measured work');
  }
  return Object.freeze({
    calls: 13,
    genuineOwnedSnapshotCompared: true,
    detachedMutationIsolation: true,
    noAdditionalMeasuredWork: true,
    eligibilityGranted: false,
    genericHostQualified: false,
  });
}
async function assertPrivateAdapterReadRefusals(adapter, measure) {
  const before = measure();
  for (const method of ['instanceId', 'balance', 'notes'])
    await assert.rejects(adapter[method](), { code: 'RAILGUN_KOHAKU_PRIVATE_ADAPTER_REFUSED' });
  assert.deepEqual(measure(), before, 'Refused adapter reads added measured work');
  return Object.freeze({ calls: 3, noAdditionalMeasuredWork: true });
}
function installPrivateAdapterSettlementObserver() {
  for (const name of ['railgun-kohaku-private-host', 'railgun-kohaku-broadcaster'])
    assert.equal(
      !!require.cache[require.resolve(wallet + name)],
      false,
      'Install before host/broadcaster import'
    );
  const facade = require(wallet + 'railgun-kohaku-plugin');
  const name = 'broadcastRailgunKohakuOperation';
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
  };
  let active = true,
    closing;
  const settle = (promise) =>
    Promise.resolve(promise).then(
      (value) => ({ status: 'fulfilled', value, promiseReturned: promise instanceof Promise }),
      (reason) => ({ status: 'rejected', reason, promiseReturned: promise instanceof Promise })
    );
  function observed(...args) {
    assert.equal(active, true);
    counts.delegateCalls++;
    const promise = Reflect.apply(original, this, args);
    const settled = settle(promise).then((value) => {
      counts.delegateSettlements++;
      return value;
    });
    records.push(settled);
    pending.push(settled);
    return promise;
  }
  facade[name] = observed;
  return Object.freeze({
    begin(invoke) {
      assert.equal(active, true);
      const index = records.length;
      const promise = invoke();
      const caller = settle(promise);
      pending.push(caller);
      assert.equal(records.length, index + 1, 'Exactly one genuine delegate call');
      const delegated = records[index];
      let checked = false;
      return Object.freeze({
        promise,
        async assert(expected) {
          assert.equal(checked, false);
          const actual = await caller,
            source = await delegated;
          oracle.assertForwardedSettlement(actual, source, { ...expected, lane: 'private' });
          const value = actual.status === 'fulfilled' ? actual.value : actual.reason;
          const keys = Object.keys(value).sort();
          assert.ok(keys.length <= 8);
          const schema = Object.freeze(
            Object.fromEntries(keys.map((key) => [key, typeof value[key]]))
          );
          const expectedFields =
            actual.status === 'rejected'
              ? { code: 'string' }
              : expected.outcome === 'acknowledged'
                ? {
                    broadcastSource: 'string',
                    chainId: 'number',
                    explorerUrl: value.explorerUrl === null ? 'object' : 'string',
                    from: 'string',
                    hash: 'string',
                    nonce: 'number',
                    to: 'string',
                    value: 'string',
                  }
                : expected.outcome === 'uncertain'
                  ? { submissionStatus: 'string', transactionHash: 'string' }
                  : { stage: 'string', status: 'string' };
          assert.deepEqual(schema, expectedFields, 'Exact specialized outcome field/type contract');
          checked = true;
          counts.checkedCalls++;
          counts[expected.outcome]++;
          return Object.freeze({
            status: actual.status,
            fields: schema,
            originalValueIdentity: true,
          });
        },
      });
    },
    report: () => ({ ...counts }),
    close() {
      if (closing) return closing;
      active = false;
      closing = (async () => {
        let timer;
        try {
          assert.equal(facade[name], observed);
        } finally {
          facade[name] = original;
          try {
            await Promise.race([
              Promise.all(pending),
              new Promise((_, reject) => {
                timer = setTimeout(() => {
                  const error = Error('Private adapter observer drain timeout');
                  native.record(error, 'private-adapter.settlement-drain');
                  reject(error);
                }, 150000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          assert.equal(counts.delegateCalls, counts.delegateSettlements);
          assert.equal(counts.delegateCalls, counts.checkedCalls);
          records.length = 0;
          pending.length = 0;
        }
      })();
      closing.catch((error) => native.record(error, 'private-adapter.observer.close'));
      return closing;
    },
  });
}
module.exports = {
  qualifyPrivateAdapterReads,
  assertPrivateAdapterReadRefusals,
  installPrivateAdapterSettlementObserver,
};
