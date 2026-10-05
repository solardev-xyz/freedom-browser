/** Independent supplied-data host and pinned read oracle. This fixture issues no
 * Freedom ownership/receipt and performs no scan, storage or network operation. */
const assert = require('assert/strict');
const { assertReadProjection } = require('./railgun-kohaku-contract-oracle');
const instanceId = '0zk1' + 'q'.repeat(123);
const hex = (value) => '0x' + BigInt(value).toString(16).padStart(64, '0');
function snapshotFixture() {
  const erc20 = { __type: 'erc20', contract: '0x' + 'a'.repeat(40) };
  const erc721 = { __type: 'erc721', contract: '0x' + 'b'.repeat(40), tokenId: 7n };
  function note(position, amount, asset = erc20, spentTxid = false) {
    return {
      id: `0:${position}`,
      tree: 0,
      position,
      txid: hex(100 + position),
      hash: hex(200 + position),
      tokenHash: hex(300 + position),
      asset: { ...asset },
      amount,
      tag: 'unverified',
      spentTxid,
    };
  }
  return {
    instanceId,
    received: [note(0, 12n), note(1, 8n), note(2, 5n, erc20, hex(99)), note(3, 1n, erc721)],
  };
}
function copy(value) {
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
  return value;
}
function createMemorySnapshotHost(initial = snapshotFixture()) {
  const controller = new AbortController();
  let data = copy(initial),
    revision = 0;
  const counters = { captures: 0, rechecks: 0 };
  const host = Object.freeze({
    signal: controller.signal,
    capture() {
      assert.ok(!controller.signal.aborted);
      counters.captures++;
      const captured = revision;
      return {
        snapshot: copy(data),
        assertCurrent() {
          counters.rechecks++;
          assert.ok(!controller.signal.aborted && captured === revision);
        },
      };
    },
  });
  return {
    host,
    counters,
    replace(next) {
      data = copy(next);
      revision++;
    },
    close: () => controller.abort(),
  };
}
async function checkSnapshotConformance(plugin, expected) {
  assert.deepEqual(Object.keys(plugin).sort(), [
    'balance',
    'close',
    'closed',
    'instanceId',
    'notes',
    'provenance',
    'signal',
  ]);
  assert.equal(plugin.provenance, 'host-supplied');
  const asset = {
    ...expected.received[0].asset,
    contract: expected.received[0].asset.contract.toUpperCase().replace('0X', '0x'),
  };
  const vectors = [
    ['instanceId', []],
    ['balance', []],
    ['balance', [[]]],
    ['balance', [[asset, asset]]],
    ['balance', [[{ __type: 'native' }]]],
    ['notes', []],
    ['notes', [undefined, true]],
    ['notes', [[asset], false]],
    ['notes', [[], true]],
  ];
  for (const [method, args] of vectors) {
    const pending = plugin[method](...args);
    const value = await pending;
    assertReadProjection(expected, {
      method,
      args,
      value,
      promiseReturned: pending instanceof Promise,
    });
    if (Array.isArray(value)) {
      assert.equal(Object.isFrozen(value), false);
      for (const item of value) {
        assert.equal(Object.isFrozen(item), false);
        assert.equal(Object.isFrozen(item.asset), false);
        assert.ok(!expected.received.includes(item));
        assert.ok(!expected.received.some((note) => note.asset === item.asset));
      }
    }
  }
  return Object.freeze({
    readVectors: vectors.length,
    provenance: 'host-supplied',
    typescriptChecked: false,
  });
}
module.exports = { snapshotFixture, createMemorySnapshotHost, checkSnapshotConformance };
