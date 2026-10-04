const { createHash } = require('crypto');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const {
  normalizeRailgunPoiShieldFacts,
  normalizeRailgunPoiShieldInput,
} = require('./railgun-poi-shield-selector-data');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const copy = (v) => JSON.parse(JSON.stringify(v));
const reverse = (v) => {
  if (Array.isArray(v)) return v.map(reverse);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .reverse()
        .map(([k, value]) => [k, reverse(value)])
    );
  return v;
};
let capsule, creator;
beforeEach(() => {
  capsule = sample().capsule;
  creator = {
    type: 'Shield',
    tree: capsule.selection.tree,
    position: capsule.selection.position,
    preimage: {
      npk: hex(7),
      token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      value: capsule.preparation.amount,
    },
    ciphertext: { encryptedBundle: [hex(8), hex(9), hex(10)], shieldKey: hex(11) },
  };
});

test.each([false, true])(
  'canonical detached binding for unshield=%s grants no authority',
  (unshield) => {
    capsule = sample(unshield).capsule;
    const original = copy({ capsule, creator });
    const result = normalizeRailgunPoiShieldInput(capsule, creator);
    expect(result.bindingDigest).toBe(
      unshield
        ? 'ecf9d41c226dd4ab590ffb896183655a394dfcb3a8d0e256f780c1e6533b6749'
        : '3f74ecb729ffc71fdc6cea4ff1bc0d24c2e9771947c23477e8aef9379ece2645'
    );
    expect(result.facts).toEqual({
      npk: hex(7),
      token: pins.wrappedNative,
      value: '1000',
      tree: 0,
      position: 1,
      noteHash: capsule.noteHash,
    });
    expect(Object.keys(result).sort()).toEqual(['bindingDigest', 'facts']);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.facts)).toBe(true);
    expect(result.bindingDigest).toBe(
      createHash('sha256')
        .update('freedom:railgun:poi-shield-selector-v1\0')
        .update(JSON.stringify({ capsule: normalizeRailgunPrivateCapsule(capsule), creator }))
        .digest('hex')
    );
    expect(normalizeRailgunPoiShieldInput(reverse(capsule), reverse(creator))).toEqual(result);
    expect({ capsule, creator }).toEqual(original);
    capsule.noteHash = hex(99);
    creator.preimage.npk = hex(98);
    creator.ciphertext.encryptedBundle[0] = hex(97);
    expect(result.facts.noteHash).toBe(original.capsule.noteHash);
    expect(result.facts.npk).toBe(original.creator.preimage.npk);
    expect(normalizeRailgunPoiShieldInput(original.capsule, original.creator)).toEqual(result);
  }
);
test('partial Shield creator binds the full input value and canonical v2 capsule', () => {
  capsule = createRailgunPartialCapsuleData().capsule;
  const result = normalizeRailgunPoiShieldInput(capsule, creator);
  expect(result.facts.value).toBe('1000');
  expect(result.facts.noteHash).toBe(capsule.noteHash);
  expect(result.bindingDigest).toBe(
    createHash('sha256')
      .update('freedom:railgun:poi-shield-selector-v1\0')
      .update(JSON.stringify({ capsule: normalizeRailgunPrivateCapsule(capsule), creator }))
      .digest('hex')
  );
  expect(normalizeRailgunPoiShieldInput(reverse(capsule), reverse(creator))).toEqual(result);
  const changed = createRailgunPartialCapsuleData({ unshieldAmount: '300' }).capsule;
  const changedResult = normalizeRailgunPoiShieldInput(changed, creator);
  expect(changedResult.facts).toEqual(result.facts);
  expect(changedResult.bindingDigest).not.toBe(result.bindingDigest);
  expect(Object.isFrozen(result.facts)).toBe(true);
  creator.preimage.value = '1';
  expect(result.facts.value).toBe('1000');
});
test.each([
  'gross-unshield',
  'change',
  'version',
  'legacy-amount',
  'missing-input',
  'conservation',
])('partial Shield creator refuses %s in place of the original input', (kind) => {
  capsule = createRailgunPartialCapsuleData().capsule;
  if (kind === 'gross-unshield') creator.preimage.value = capsule.preparation.unshieldAmount;
  if (kind === 'change') creator.preimage.value = capsule.preparation.changeAmount;
  if (kind === 'version') capsule.version = 1;
  if (kind === 'legacy-amount') capsule.preparation.amount = '1000';
  if (kind === 'missing-input') delete capsule.preparation.inputAmount;
  if (kind === 'conservation') capsule.preparation.inputAmount = '1001';
  expect(() => normalizeRailgunPoiShieldInput(capsule, creator)).toThrow();
});

test.each(['bundle', 'shield-key', 'path', 'wallet', 'expected-hash'])(
  'binds %s even when public hashing facts remain identical',
  (mode) => {
    const before = normalizeRailgunPoiShieldInput(capsule, creator);
    if (mode === 'bundle') creator.ciphertext.encryptedBundle[1] = hex(100);
    if (mode === 'shield-key') creator.ciphertext.shieldKey = hex(100);
    if (mode === 'path') capsule.pathElements[0] = hex(100);
    if (mode === 'wallet') capsule.walletId = '3'.repeat(64);
    if (mode === 'expected-hash') capsule.preparation.expectedHash = hex(100);
    const after = normalizeRailgunPoiShieldInput(capsule, creator);
    expect(after.facts).toEqual(before.facts);
    expect(after.bindingDigest).not.toBe(before.bindingDigest);
  }
);

test.each([
  [
    'creator-extra',
    (v) => {
      v.extra = true;
    },
  ],
  [
    'creator-missing',
    (v) => {
      delete v.ciphertext;
    },
  ],
  [
    'Transact',
    (v) => {
      v.type = 'Transact';
    },
  ],
  [
    'tree',
    (v) => {
      v.tree++;
    },
  ],
  [
    'position',
    (v) => {
      v.position++;
    },
  ],
  [
    'preimage-extra',
    (v) => {
      v.preimage.random = hex(1);
    },
  ],
  [
    'preimage-missing',
    (v) => {
      delete v.preimage.npk;
    },
  ],
  [
    'token-extra',
    (v) => {
      v.preimage.token.extra = true;
    },
  ],
  [
    'token-type',
    (v) => {
      v.preimage.token.tokenType = '0';
    },
  ],
  [
    'token-subid',
    (v) => {
      v.preimage.token.tokenSubID = hex(1);
    },
  ],
  [
    'token-subid-prefix',
    (v) => {
      v.preimage.token.tokenSubID = '0'.repeat(64);
    },
  ],
  [
    'amount-binding',
    (v) => {
      v.preimage.value = '999';
    },
  ],
  [
    'ciphertext-extra',
    (v) => {
      v.ciphertext.memo = '0x';
    },
  ],
  [
    'ciphertext-missing',
    (v) => {
      delete v.ciphertext.shieldKey;
    },
  ],
  [
    'bundle-short',
    (v) => {
      v.ciphertext.encryptedBundle.pop();
    },
  ],
  [
    'bundle-long',
    (v) => {
      v.ciphertext.encryptedBundle.push(hex(1));
    },
  ],
  [
    'bundle-not-array',
    (v) => {
      v.ciphertext.encryptedBundle = {};
    },
  ],
  [
    'bundle-prefix',
    (v) => {
      v.ciphertext.encryptedBundle[0] = 'a'.repeat(64);
    },
  ],
  [
    'bundle-case',
    (v) => {
      v.ciphertext.encryptedBundle[0] = '0x' + 'A'.repeat(64);
    },
  ],
  [
    'bundle-number',
    (v) => {
      v.ciphertext.encryptedBundle[0] = 1;
    },
  ],
  [
    'shield-key-length',
    (v) => {
      v.ciphertext.shieldKey = '0x12';
    },
  ],
])('refuses exact creator schema/binding violation %s', (_name, mutate) => {
  mutate(creator);
  expect(() => normalizeRailgunPoiShieldInput(capsule, creator)).toThrow();
});

test.each([
  ['npk', hex(FIELD)],
  ['noteHash', hex(FIELD)],
  ['npk', '0x' + 'A'.repeat(64)],
  ['noteHash', '0X' + '0'.repeat(64)],
  ['npk', '0'.repeat(64)],
  ['npk', '0x01'],
  ['npk', 7],
  ['token', '0x' + '34'.repeat(20)],
  ['token', pins.wrappedNative.toUpperCase()],
  ['value', '0'],
  ['value', '-1'],
  ['value', '01'],
  ['value', '+1'],
  ['value', '1.0'],
  ['value', '1e3'],
  ['value', ' 1'],
  ['value', 1000],
  ['value', (1n << 120n).toString()],
  ['tree', -1],
  ['tree', 65536],
  ['tree', 1.5],
  ['tree', '0'],
  ['position', -1],
  ['position', 65536],
  ['position', 0.5],
  ['position', '1'],
])('refuses noncanonical fact %s=%s', (key, value) => {
  const { facts } = normalizeRailgunPoiShieldInput(capsule, creator);
  expect(() => normalizeRailgunPoiShieldFacts({ ...facts, [key]: value })).toThrow();
});

test('facts require exact keys and accept inclusive endpoints below bounds', () => {
  const { facts } = normalizeRailgunPoiShieldInput(capsule, creator);
  expect(() => normalizeRailgunPoiShieldFacts({ ...facts, extra: true })).toThrow();
  const missing = { ...facts };
  delete missing.token;
  expect(() => normalizeRailgunPoiShieldFacts(missing)).toThrow();
  const boundary = {
    ...facts,
    npk: hex(0),
    noteHash: hex(FIELD - 1n),
    value: ((1n << 120n) - 1n).toString(),
    tree: 65535,
    position: 65535,
  };
  expect(normalizeRailgunPoiShieldFacts(boundary)).toEqual(boundary);
  // Ciphertext bytes are not field elements or authenticated at this boundary.
  creator.ciphertext.shieldKey = '0x' + 'ff'.repeat(32);
  expect(normalizeRailgunPoiShieldInput(capsule, creator).facts).toEqual(facts);
});

test('bounds combined input and validates the capsule, including same-position substitutions', () => {
  const original = normalizeRailgunPoiShieldInput(capsule, creator);
  const different = copy(capsule);
  different.noteHash = hex(22);
  expect(normalizeRailgunPrivateCapsule(different).selection).toEqual(capsule.selection);
  const changed = normalizeRailgunPoiShieldInput(different, creator);
  expect(changed.facts.noteHash).toBe(hex(22));
  expect(changed.bindingDigest).not.toBe(original.bindingDigest);
  // Hash/preimage consistency is deliberately deferred to the keyless worker.
  expect(() => normalizeRailgunPoiShieldInput({ ...capsule, version: 2 }, creator)).toThrow();
  expect(() =>
    normalizeRailgunPoiShieldInput(capsule, {
      ...creator,
      ciphertext: { ...creator.ciphertext, shieldKey: 'a'.repeat(65536) },
    })
  ).toThrow();
});
