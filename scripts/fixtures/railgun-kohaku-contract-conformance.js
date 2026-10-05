/** Optional offline qualifier checks over existing genuine account/instance owners.
 * No issuer, generic Host, transport, signer, or operation submission is provided. */
const { assert } = require('./railgun-native-assertions');
const oracle = require('./railgun-kohaku-contract-oracle');
async function reads({ instance, account, owners, mode, measure }) {
  const wallet = require('../../src/main/wallet/railgun-account-wallet');
  const baseline = wallet.readRailgunAccountOwnedNotes(account, owners);
  const instanceId = owners.identity.descriptor.instanceId;
  assert.equal(baseline.read.instanceId, instanceId, 'Owned snapshot/identity join');
  oracle.assertSurface(instance, mode);
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
  for (const asset of baseline.read.received.slice(0, 3).map((note) => note.asset)) {
    const filter = {
      ...asset,
      ...(asset.contract ? { contract: '0x' + asset.contract.slice(2).toUpperCase() } : {}),
    };
    calls.push(['balance', [[filter]]], ['notes', [[filter], true]]);
  }
  for (const [method, args] of calls) {
    const pending = instance[method](...args);
    const promiseReturned = !!pending && typeof pending.then === 'function';
    const value = await pending;
    assert.equal(owners.identity.descriptor.instanceId, instanceId);
    if (method === 'instanceId') assert.equal(value, instanceId, 'Facade/identity join');
    assert.deepEqual(wallet.readRailgunAccountOwnedNotes(account, owners), baseline);
    oracle.assertReadProjection(baseline.read, { method, args, value, promiseReturned });
    assert.deepEqual(measure(), before, 'Read conformance added work');
  }
  return Object.freeze({
    mode,
    calls: calls.length,
    readsComparedToGenuineOwnedSnapshot: true,
    noAdditionalMeasuredWork: true,
    eligibilityGranted: false,
    typescriptConformance: false,
    portableHostQualified: false,
  });
}
async function qualifyOwnedView(options) {
  assert.equal(options.instance, options.account.view);
  return reads({ ...options, mode: 'view' });
}
async function qualifyOperationInstance(options) {
  assert.ok(['private', 'public'].includes(options.mode));
  const facade = require('../../src/main/wallet/railgun-kohaku-plugin');
  const check =
    options.mode === 'private'
      ? facade.assertRailgunKohakuPrivatePlugin
      : facade.assertRailgunKohakuPublicPlugin;
  check(options.instance);
  const report = await reads(options);
  check(options.instance);
  return report;
}
async function qualifyReadInstance({ account, owners, signal, measure }) {
  // Fixed genuine construction, not an injectable caller-supplied read issuer.
  const { createRailgunKohakuPlugin } = require('../../src/main/wallet/railgun-kohaku-plugin');
  const instance = createRailgunKohakuPlugin({ account, owners, signal });
  try {
    return await reads({ instance, account, owners, mode: 'read', measure });
  } finally {
    instance.close();
    await instance.closed;
  }
}
// Fixed fixture expectations, not caller-selected runtime authority.
function assertInstanceReadVector(reports, { lane, heldReview = false }) {
  assert.ok(['private', 'public'].includes(lane));
  assert.equal(typeof heldReview, 'boolean');
  const expected =
    lane === 'public'
      ? [['public', 13]]
      : heldReview
        ? [['private', 13]]
        : [
            ['private', 13],
            ['read', 13],
          ];
  assert.deepEqual(
    reports.map(({ mode, calls }) => [mode, calls]),
    expected
  );
}
module.exports = {
  qualifyOwnedView,
  qualifyOperationInstance,
  qualifyReadInstance,
  assertInstanceReadVector,
};
