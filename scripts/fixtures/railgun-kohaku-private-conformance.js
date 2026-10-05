/** Independent in-memory host conformance only. No Freedom authority, crypto,
 * journal, key or network is simulated as a genuine receipt here.
 */
const assert = require('assert/strict');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const INSTANCE = '0zk1' + '0'.repeat(123),
  HASH = '0x' + '1'.repeat(64);
const ADDRESS = '0x' + '12'.repeat(20);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function independentPrivateHost() {
  const controller = new AbortController(),
    drain = deferred(),
    calls = [];
  const values = [
    {
      id: '0:1',
      tree: 0,
      position: 1,
      txid: HASH,
      hash: HASH,
      tokenHash: HASH,
      asset: { __type: 'erc20', contract: pins.wrappedNative },
      amount: 2000n,
      tag: 'unverified',
      spentTxid: false,
    },
  ];
  const handles = new WeakSet();
  const acknowledged = {
    hash: HASH,
    nonce: 0,
    from: ADDRESS,
    to: pins.proxy,
    value: '0',
    chainId: pins.chainId,
    broadcastSource: 'direct',
    explorerUrl: null,
  };
  const input = { asset: { ...values[0].asset }, amount: 2000n, noteId: '0:1' };
  function selected(assets) {
    return values.filter(
      (n) =>
        !assets ||
        assets.some(
          (a) => a.__type === n.asset.__type && a.contract.toLowerCase() === n.asset.contract
        )
    );
  }
  function prepare(method, value, recipient, options) {
    calls.push({ method, value, recipient, options });
    assert.ok(!controller.signal.aborted);
    assert.equal(value.noteId, '0:1');
    if (method === 'prepareTransfer') {
      assert.equal(value.amount, 2000n);
      assert.equal(recipient, INSTANCE);
    } else {
      assert.ok(value.amount > 0n && value.amount <= 2000n);
      assert.equal(recipient, ADDRESS);
    }
    const handle = Object.freeze({});
    handles.add(handle);
    return { handle };
  }
  const host = {
    signal: controller.signal,
    closed: drain.promise,
    async instanceId() {
      calls.push({ method: 'instanceId' });
      return INSTANCE;
    },
    async balance(assets) {
      calls.push({ method: 'balance' });
      return selected(assets).map(({ asset, amount, tag }) => ({ asset, amount, tag }));
    },
    async notes(assets) {
      calls.push({ method: 'notes' });
      return selected(assets);
    },
    async prepareTransfer(value, to) {
      return prepare('prepareTransfer', value, to);
    },
    async prepareUnshield(value, to, options) {
      return prepare('prepareUnshield', value, to, options);
    },
    async broadcast(handle) {
      assert.ok(handles.has(handle));
      handles.delete(handle);
      calls.push({ method: 'broadcast' });
      return acknowledged;
    },
    close() {
      calls.push({ method: 'close' });
      controller.abort();
      drain.resolve();
    },
  };
  return { host, controller, drain, calls, values, input, acknowledged };
}
async function checkPrivateConformance(create, broadcaster, kind) {
  const fixture = independentPrivateHost();
  const instance = create({ host: fixture.host, signal: new AbortController().signal });
  assert.equal(await instance.instanceId(), INSTANCE);
  assert.equal((await instance.balance())[0].amount, 2000n);
  assert.equal((await instance.notes())[0].id, '0:1');
  const operation =
    kind === 'transfer'
      ? await instance.prepareTransfer(fixture.input, INSTANCE)
      : await instance.prepareUnshield(
          { ...fixture.input, amount: kind === 'partial' ? 500n : 2000n },
          ADDRESS
        );
  const result = await broadcaster(instance).broadcast(operation);
  assert.equal(result, fixture.acknowledged);
  await instance.closed;
  assert.equal(fixture.calls.filter((v) => v.method === 'broadcast').length, 1);
  assert.equal(fixture.calls.filter((v) => v.method === 'close').length, 1);
  return { kind, reads: 3, preparation: 1, broadcast: 1, close: 1, authority: false };
}
module.exports = {
  independentPrivateHost,
  checkPrivateConformance,
  deferred,
  INSTANCE,
  HASH,
  ADDRESS,
};
