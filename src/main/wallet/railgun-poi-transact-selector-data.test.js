const { createHash } = require('crypto');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const {
  prepareRailgunPoiTransactSelectorInput: prepare,
  normalizeRailgunPoiTransactSelectorInput: normalize,
} = require('./railgun-poi-transact-selector-data');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function input(unshield = false) {
  const capsule = sample(unshield).capsule;
  return {
    archive: '/fixture-transact-selector.asar',
    descriptor: {
      walletId: capsule.walletId,
      instanceId: '0zk1' + 'q'.repeat(123),
      masterPublicKey: hex(3).slice(2),
      spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
      viewingPublicKey: hex(6).slice(2),
      accountIndex: 0,
    },
    capsule,
    creator: {
      type: 'Transact',
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      hash: capsule.noteHash,
      ciphertext: {
        ciphertext: [hex(7), hex(8), hex(9), hex(10)],
        blindedSenderViewingKey: hex(11),
        blindedReceiverViewingKey: hex(12),
        annotationData: '0x',
        memo: '0x',
      },
    },
  };
}
function partialInput(options) {
  const value = input();
  value.capsule = createRailgunPartialCapsuleData(options).capsule;
  value.descriptor.walletId = value.capsule.walletId;
  value.creator.hash = value.capsule.noteHash;
  return value;
}
test.each([false, true])(
  'real capsule validation binds detached transfer/unshield input: %s',
  (unshield) => {
    const raw = input(unshield),
      value = prepare(raw);
    expect(normalize(value)).toEqual(value);
    expect(value.bindingDigest).toBe(
      unshield
        ? 'bbd25a77b062f6e67fb489da921f60a4579947bcb9a7ec9c1dc6bd58480a258e'
        : '7d84cecff55e22dcf53619e0fb74b6df6b190bf37ca69b3d022efa3f1ece3679'
    );
    expect(value.bindingDigest).toBe(
      createHash('sha256')
        .update('freedom:railgun:poi-transact-selector-v1\0')
        .update(
          JSON.stringify({
            descriptor: value.descriptor,
            capsule: value.capsule,
            creator: value.creator,
          })
        )
        .digest('hex')
    );
    expect(Object.isFrozen(value.creator.ciphertext.ciphertext)).toBe(true);
    expect(Object.isFrozen(value.descriptor.spendingPublicKey)).toBe(true);
    raw.creator.ciphertext.ciphertext[0] = hex(99);
    raw.capsule.pathElements[0] = hex(99);
    expect(value.creator.ciphertext.ciphertext[0]).toBe(hex(7));
    expect(value.capsule.pathElements[0]).not.toBe(hex(99));
  }
);
test('a marked foreign transfer binds its destination and marker into the selector input', () => {
  const foreign = () => {
    const raw = input();
    raw.capsule.selection.recipient = '0zk1' + 'p'.repeat(123);
    raw.capsule.preparation.recipient = '0zk1' + 'p'.repeat(123);
    raw.capsule.selection.recipientRelationship = 'foreign';
    return raw;
  };
  const value = prepare(foreign());
  expect(value.capsule.selection.recipientRelationship).toBe('foreign');
  expect(normalize(value)).toEqual(value);
  expect(value.bindingDigest).not.toBe(prepare(input()).bindingDigest);
  const unmarked = foreign();
  delete unmarked.capsule.selection.recipientRelationship;
  expect(() => prepare(unmarked)).toThrow();
  const own = foreign();
  own.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
  expect(() => prepare(own)).toThrow();
});
test('partial input uses the v2 domain and binds the full input, not either output', () => {
  const raw = partialInput();
  const value = prepare(raw);
  const bound = JSON.stringify({
    descriptor: value.descriptor,
    capsule: value.capsule,
    creator: value.creator,
  });
  expect(value.bindingDigest).toBe(
    createHash('sha256')
      .update('freedom:railgun:poi-transact-selector-v2\0')
      .update(bound)
      .digest('hex')
  );
  expect(value.capsule.preparation.inputAmount).toBe('1000');
  expect(value.capsule.preparation.changeAmount).toBe('600');
  expect(value.capsule.preparation.unshieldAmount).toBe('400');
  expect(value.creator.hash).toBe(value.capsule.noteHash);
  expect(value.creator.hash).not.toBe(value.capsule.preparation.expected.changeCommitment);
  expect(normalize(value)).toEqual(value);
  const stale = {
    ...value,
    bindingDigest: createHash('sha256')
      .update('freedom:railgun:poi-transact-selector-v1\0')
      .update(bound)
      .digest('hex'),
  };
  expect(() => normalize(stale)).toThrow();
  expect(prepare(partialInput({ inputAmount: '1100' })).bindingDigest).not.toBe(
    value.bindingDigest
  );
  expect(prepare(partialInput({ unshieldAmount: '300' })).bindingDigest).not.toBe(
    value.bindingDigest
  );
  expect(Object.isFrozen(value.capsule.preparation)).toBe(true);
  raw.capsule.preparation.inputAmount = '1';
  raw.creator.ciphertext.memo = '0x12';
  expect(value.capsule.preparation.inputAmount).toBe('1000');
  expect(value.creator.ciphertext.memo).toBe('0x');
});
test.each([
  'version',
  'legacy-amount',
  'missing-input',
  'conservation',
  'selected-amount',
  'output-hash',
  'output-position',
  'caller-domain',
])('partial input refuses %s before deriving a selector', (kind) => {
  const value = partialInput();
  if (kind === 'version') value.capsule.version = 1;
  if (kind === 'legacy-amount') value.capsule.preparation.amount = '1000';
  if (kind === 'missing-input') delete value.capsule.preparation.inputAmount;
  if (kind === 'conservation') value.capsule.preparation.inputAmount = '1001';
  if (kind === 'selected-amount') value.capsule.selection.unshieldAmount = '401';
  if (kind === 'output-hash')
    value.creator.hash = value.capsule.preparation.expected.changeCommitment;
  if (kind === 'output-position') value.creator.position++;
  if (kind === 'caller-domain') value.domain = 'freedom:railgun:poi-transact-selector-v1\0';
  expect(() => prepare(value)).toThrow();
});
test('canonical property order is stable; archive relocation is not cryptographic binding authority', () => {
  const raw = input(),
    first = prepare(raw);
  const reversed = Object.fromEntries(Object.entries(raw).reverse());
  reversed.descriptor = Object.fromEntries(Object.entries(raw.descriptor).reverse());
  expect(prepare(reversed)).toEqual(first);
  raw.archive = '/another.asar';
  expect(prepare(raw).bindingDigest).toBe(first.bindingDigest);
});
test.each([
  'key',
  'npk',
  'proof',
  'completion',
  'extra-creator',
  'extra-cipher',
  'relative',
  'wallet',
  'recipient',
  'account-negative',
  'account-high',
  'account-fraction',
  'master-field',
  'spending-field',
  'spending-length',
  'viewing-prefix',
  'address',
  'shield',
  'tree',
  'position',
  'hash',
  'hash-field',
  'cipher-short',
  'cipher-case',
  'memo-odd',
  'path',
  'capsule-commitment',
])('rejects malformed or caller-injected %s', (kind) => {
  const v = input(),
    c = v.creator,
    d = v.descriptor;
  if (['key', 'npk', 'proof', 'completion'].includes(kind)) v[kind] = 'PRIVATE';
  if (kind === 'extra-creator') c.origin = {};
  if (kind === 'extra-cipher') c.ciphertext.privateKey = 'PRIVATE';
  if (kind === 'relative') v.archive = 'relative.asar';
  if (kind === 'wallet') d.walletId = 'a'.repeat(64);
  if (kind === 'recipient') d.instanceId = '0zk1' + 'p'.repeat(123);
  if (kind === 'account-negative') d.accountIndex = -1;
  if (kind === 'account-high') d.accountIndex = 65536;
  if (kind === 'account-fraction') d.accountIndex = 0.5;
  if (kind === 'master-field') d.masterPublicKey = hex(FIELD).slice(2);
  if (kind === 'spending-field') d.spendingPublicKey[0] = hex(FIELD).slice(2);
  if (kind === 'spending-length') d.spendingPublicKey.pop();
  if (kind === 'viewing-prefix') d.viewingPublicKey = hex(3);
  if (kind === 'address') d.instanceId = 'invalid';
  if (kind === 'shield') c.type = 'Shield';
  if (kind === 'tree') c.tree++;
  if (kind === 'position') c.position++;
  if (kind === 'hash') c.hash = hex(90);
  if (kind === 'hash-field') c.hash = hex(FIELD);
  if (kind === 'cipher-short') c.ciphertext.ciphertext.pop();
  if (kind === 'cipher-case') c.ciphertext.ciphertext[0] = '0x' + 'A'.repeat(64);
  if (kind === 'memo-odd') c.ciphertext.memo = '0x1';
  if (kind === 'path') v.capsule.pathElements.pop();
  if (kind === 'capsule-commitment') v.capsule.preparation.expected.commitment = hex(91);
  expect(() => prepare(v)).toThrow();
});
test.each([
  [0, 3520, true],
  [1760, 1760, true],
  [0, 3521, false],
  [1761, 1760, false],
  [256, 256, true],
])('canonical ABI allowance annotation=%i memo=%i allowed=%s', (annotation, memo, allowed) => {
  const v = input();
  v.creator.ciphertext.annotationData = '0x' + 'ab'.repeat(annotation);
  v.creator.ciphertext.memo = '0x' + 'cd'.repeat(memo);
  expect(Buffer.byteLength(JSON.stringify(v))).toBeLessThan(65536);
  if (allowed) expect(normalize(prepare(v)).creator).toEqual(v.creator);
  else expect(() => prepare(v)).toThrow();
});
test('full normalized UTF-8 envelope is capped at 64 KiB', () => {
  const v = input(),
    size = Buffer.byteLength(JSON.stringify(prepare(v)));
  v.archive += 'x'.repeat(65536 - size);
  expect(Buffer.byteLength(JSON.stringify(prepare(v)))).toBe(65536);
  v.archive += 'x';
  expect(() => prepare(v)).toThrow();
});
test.each(['digest', 'ciphertext', 'descriptor', 'capsule', 'extra'])(
  'normalizer refuses stale binding %s',
  (kind) => {
    const v = JSON.parse(JSON.stringify(prepare(input())));
    if (kind === 'digest') v.bindingDigest = '0'.repeat(64);
    if (kind === 'ciphertext') v.creator.ciphertext.memo = '0x01';
    if (kind === 'descriptor') v.descriptor.accountIndex++;
    if (kind === 'capsule') v.capsule.pathElements[0] = hex(90);
    if (kind === 'extra') v.npk = hex(1);
    expect(() => normalize(v)).toThrow();
  }
);
