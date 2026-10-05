/** Fixture data oracle for the pinned external surface, not an authority issuer.
 * Reading a conforming snapshot or token shape never establishes genuine origin. */
const assert = require('assert/strict');
const { createHash } = require('crypto');
const pin = require('./railgun-kohaku-contract-pin.json');
function assertPinnedContracts(files) {
  assert.deepEqual(Object.keys(files).sort(), Object.keys(pin.files).sort());
  for (const [name, expected] of Object.entries(pin.files)) {
    assert.ok(Buffer.isBuffer(files[name]));
    assert.equal(createHash('sha256').update(files[name]).digest('hex'), expected, name);
  }
  return Object.freeze({ revision: pin.revision, files: Object.keys(pin.files).length });
}
function assetKey(asset) {
  assert.ok(asset && typeof asset === 'object');
  assert.ok(pin.assetKinds.includes(asset.__type));
  const keys = asset.__type === 'native' ? ['__type'] : ['__type', 'contract'];
  if (asset.__type === 'erc721') keys.push('tokenId');
  assert.deepEqual(Object.keys(asset).sort(), keys.sort());
  if (asset.__type === 'native') return 'native';
  assert.match(asset.contract, /^0x[0-9a-fA-F]{40}$/);
  if (asset.__type === 'erc721') {
    assert.equal(typeof asset.tokenId, 'bigint');
    assert.ok(asset.tokenId >= 0n && asset.tokenId < 1n << 256n);
  }
  return `${asset.__type}:${asset.contract.toLowerCase()}:${asset.tokenId ?? ''}`;
}
function assertSurface(instance, mode) {
  assert.ok(['view', ...Object.keys(pin.freedomModes)].includes(mode));
  for (const method of [...pin.instance.required, 'notes', 'status'])
    assert.equal(typeof instance[method], 'function', method);
  const allowed = pin.freedomModes[mode] || [];
  for (const method of pin.instance.featureMethods)
    assert.equal(typeof instance[method], allowed.includes(method) ? 'function' : 'undefined');
  if (mode !== 'view') {
    assert.equal(typeof instance.close, 'function');
    assert.ok(instance.signal instanceof AbortSignal);
    assert.ok(instance.closed && typeof instance.closed.then === 'function');
  }
}
function assertReadProjection(expected, { method, args, value, promiseReturned }) {
  assert.equal(promiseReturned, true, 'Pinned read signatures return Promises');
  if (method === 'instanceId') {
    assert.equal(value, expected.instanceId);
    return;
  }
  assert.ok(['balance', 'notes'].includes(method));
  const [filters, includeSpent = false] = args;
  assert.equal(typeof includeSpent, 'boolean');
  const keys = filters === undefined ? null : new Set(filters.map(assetKey));
  const selected = expected.received.filter(
    (note) =>
      (method === 'notes' && includeSpent ? true : note.spentTxid === false) &&
      (keys === null ||
        (pin.assetKinds.includes(note.asset.__type) && keys.has(assetKey(note.asset))))
  );
  for (const note of selected) {
    assetKey(note.asset);
    assert.equal(typeof note.amount, 'bigint');
    assert.ok(note.amount >= 0n);
    assert.equal(note.tag, 'unverified');
  }
  assert.ok(Array.isArray(value));
  if (method === 'notes') {
    assert.equal(new Set(value.map((note) => note.id)).size, value.length);
    const order = (notes) => [...notes].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(order(value), order(selected));
    return;
  }
  const totals = new Map();
  for (const note of selected) {
    const key = assetKey(note.asset);
    totals.set(key, (totals.get(key) ?? 0n) + note.amount);
  }
  assert.equal(value.length, totals.size);
  for (const amount of value) {
    assert.deepEqual(Object.keys(amount).sort(), ['amount', 'asset', 'tag']);
    assert.equal(typeof amount.amount, 'bigint');
    assert.equal(amount.tag, 'unverified');
    const key = assetKey(amount.asset);
    assert.ok(totals.has(key), 'Unexpected or duplicate asset balance');
    assert.equal(amount.amount, totals.get(key), 'Unspent note/balance conservation');
    totals.delete(key);
  }
  assert.equal(totals.size, 0);
}
function assertOpaqueOperationShape(operation, lane) {
  assert.ok(['private', 'public'].includes(lane));
  assert.ok(Object.isFrozen(operation));
  assert.deepEqual(Reflect.ownKeys(operation), ['__type']);
  assert.equal(operation.__type, pin.operations[lane]);
}
function assertForwardedSettlement(actual, delegated, { lane, outcome, hash }) {
  assert.ok(['private', 'public'].includes(lane));
  assert.ok(['acknowledged', 'uncertain', 'unresolved', 'refused'].includes(outcome));
  assert.equal(actual.promiseReturned, true);
  assert.equal(delegated.promiseReturned, true);
  assert.equal(actual.status, delegated.status);
  const field = actual.status === 'fulfilled' ? 'value' : 'reason';
  assert.ok(['fulfilled', 'rejected'].includes(actual.status));
  assert.equal(actual[field], delegated[field], 'Original specialized result/error identity');
  const result = actual[field];
  assert.ok(result && typeof result === 'object');
  if (outcome === 'acknowledged') {
    assert.equal(actual.status, 'fulfilled');
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    assert.equal(result.hash.toLowerCase(), hash);
  } else if (outcome === 'uncertain') {
    assert.equal(actual.status, lane === 'public' ? 'rejected' : 'fulfilled');
    if (lane === 'public') assert.equal(result.code, 'PRIVATE_BROADCAST_UNCERTAIN');
    assert.equal(result.submissionStatus, 'unknown');
    assert.match(hash, /^0x[0-9a-f]{64}$/);
    assert.equal(result.transactionHash, hash);
  } else if (outcome === 'unresolved') {
    assert.equal(lane, 'public');
    assert.equal(actual.status, 'rejected');
    assert.equal(result.code, 'PRIVATE_SUBMISSION_UNRESOLVED');
  } else if (actual.status === 'fulfilled') {
    assert.equal(lane, 'private');
    assert.ok(['refused', 'recovery-required'].includes(result.status));
    assert.equal(typeof result.stage, 'string');
  } else assert.equal(result.code, 'RAILGUN_KOHAKU_REFUSED');
}
module.exports = {
  assertPinnedContracts,
  assertSurface,
  assertReadProjection,
  assertOpaqueOperationShape,
  assertForwardedSettlement,
};
