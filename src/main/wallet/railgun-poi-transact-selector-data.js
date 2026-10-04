/** Canonical private input for one received Transact selector. These data checks
 * confer no source, ownership, list membership or disclosure authority. */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const shape = (value, keys) => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
};
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
function prepareRailgunPoiTransactSelectorInput(value) {
  const text = JSON.stringify(value);
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  shape(input, ['archive', 'descriptor', 'capsule', 'creator']);
  assert.ok(typeof input.archive === 'string' && path.isAbsolute(input.archive));
  shape(input.descriptor, [
    'walletId',
    'instanceId',
    'masterPublicKey',
    'spendingPublicKey',
    'viewingPublicKey',
    'accountIndex',
  ]);
  const d = input.descriptor;
  assert.ok(Number.isSafeInteger(d.accountIndex) && d.accountIndex >= 0 && d.accountIndex <= 65535);
  for (const name of ['walletId', 'viewingPublicKey', 'masterPublicKey'])
    assert.match(d[name], /^[0-9a-f]{64}$/);
  assert.ok(BigInt('0x' + d.masterPublicKey) < FIELD);
  assert.match(d.instanceId, /^0zk1[023456789acdefghjklmnpqrstuvwxyz]{123}$/);
  assert.ok(Array.isArray(d.spendingPublicKey) && d.spendingPublicKey.length === 2);
  for (const key of d.spendingPublicKey) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(BigInt('0x' + key) < FIELD);
  }
  const descriptor = {
    walletId: d.walletId,
    instanceId: d.instanceId,
    masterPublicKey: d.masterPublicKey,
    spendingPublicKey: [...d.spendingPublicKey],
    viewingPublicKey: d.viewingPublicKey,
    accountIndex: d.accountIndex,
  };
  const capsule = normalizeRailgunPrivateCapsule(input.capsule);
  assert.equal(capsule.walletId, descriptor.walletId);
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield'].includes(capsule.selection.kind)
  );
  if (capsule.selection.kind === 'railgun-private-transfer')
    assert.equal(capsule.selection.recipient, descriptor.instanceId);
  const c = input.creator;
  shape(c, ['type', 'tree', 'position', 'hash', 'ciphertext']);
  assert.equal(c.type, 'Transact');
  for (const name of ['tree', 'position']) {
    assert.ok(Number.isSafeInteger(c[name]) && c[name] >= 0 && c[name] < 65536);
    assert.equal(c[name], capsule.selection[name]);
  }
  assert.match(c.hash, /^0x[0-9a-f]{64}$/);
  assert.ok(BigInt(c.hash) < FIELD);
  assert.equal(c.hash, capsule.noteHash);
  const b = c.ciphertext;
  shape(b, [
    'ciphertext',
    'blindedSenderViewingKey',
    'blindedReceiverViewingKey',
    'annotationData',
    'memo',
  ]);
  assert.ok(Array.isArray(b.ciphertext) && b.ciphertext.length === 4);
  for (const hex of [...b.ciphertext, b.blindedSenderViewingKey, b.blindedReceiverViewingKey])
    assert.match(hex, /^0x[0-9a-f]{64}$/);
  for (const hex of [b.annotationData, b.memo]) assert.match(hex, /^0x(?:[0-9a-f]{2})*$/);
  const padded = (hex) => Math.ceil((hex.length - 2) / 2 / 32) * 32;
  assert.ok(576 + padded(b.annotationData) + padded(b.memo) <= 4096);
  const creator = {
    type: 'Transact',
    tree: c.tree,
    position: c.position,
    hash: c.hash,
    ciphertext: {
      ciphertext: [...b.ciphertext],
      blindedSenderViewingKey: b.blindedSenderViewingKey,
      blindedReceiverViewingKey: b.blindedReceiverViewingKey,
      annotationData: b.annotationData,
      memo: b.memo,
    },
  };
  const bindingDigest = createHash('sha256')
    .update('freedom:railgun:poi-transact-selector-v1\0')
    .update(JSON.stringify({ descriptor, capsule, creator }))
    .digest('hex');
  const result = { archive: input.archive, descriptor, capsule, creator, bindingDigest };
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65536);
  return freeze(result);
}
function normalizeRailgunPoiTransactSelectorInput(value) {
  shape(value, ['archive', 'descriptor', 'capsule', 'creator', 'bindingDigest']);
  const { bindingDigest, ...facts } = value;
  assert.match(bindingDigest, /^[0-9a-f]{64}$/);
  const normalized = prepareRailgunPoiTransactSelectorInput(facts);
  assert.equal(bindingDigest, normalized.bindingDigest);
  return normalized;
}
module.exports = {
  prepareRailgunPoiTransactSelectorInput,
  normalizeRailgunPoiTransactSelectorInput,
};
