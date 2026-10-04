const { normalizeRailgunPoiPayload: normalize } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function payload(unshield = false) {
  return {
    listKey: REQUIRED_LIST,
    proof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    poiMerkleroots: [hex(3n).slice(2)],
    txidMerkleroot: hex(4n).slice(2),
    txidMerklerootIndex: 6,
    blindedCommitmentsOut: unshield ? [] : [hex(5n)],
    railgunTxidIfHasUnshield: unshield ? hex(6n) : '0x00',
  };
}
test.each([false, true])(
  'canonical %s payload is detached/frozen and preserves snarkjs coordinate order',
  (unshield) => {
    const v = payload(unshield),
      result = normalize(v);
    expect(result).toEqual(v);
    v.proof.pi_b[0][0] = '9';
    expect(result.proof.pi_b[0]).toEqual(['3', '4']);
    expect(Object.isFrozen(result.proof.pi_b[0])).toBe(true);
    expect(Object.isFrozen(result.poiMerkleroots)).toBe(true);
    expect(Object.keys(result)).not.toContain('txidLeafIndex');
  }
);
test('proof coordinates use the larger base field while public roots use the scalar field', () => {
  const v = payload();
  v.proof.pi_a[0] = (BASE - 1n).toString();
  expect(normalize(v).proof.pi_a[0]).toBe(v.proof.pi_a[0]);
  v.proof.pi_a[0] = BASE.toString();
  expect(() => normalize(v)).toThrow();
  v.proof.pi_a[0] = '1';
  v.txidMerkleroot = hex(FIELD).slice(2);
  expect(() => normalize(v)).toThrow();
});
test.each([
  [
    'extra-witness',
    (v) => {
      v.randomsIn = ['secret-sentinel'];
    },
  ],
  [
    'foreign-list',
    (v) => {
      v.listKey = '0'.repeat(64);
    },
  ],
  [
    'extra-coordinate',
    (v) => {
      v.proof.pi_a.push('1');
    },
  ],
  [
    'extra-proof-field',
    (v) => {
      v.proof.privateInputs = {};
    },
  ],
  [
    'leading-zero',
    (v) => {
      v.proof.pi_c[0] = '01';
    },
  ],
  [
    'negative',
    (v) => {
      v.proof.pi_c[0] = '-1';
    },
  ],
  [
    'number',
    (v) => {
      v.proof.pi_c[0] = 1;
    },
  ],
  [
    'extra-root',
    (v) => {
      v.poiMerkleroots.push(v.poiMerkleroots[0]);
    },
  ],
  [
    'noncanonical-root',
    (v) => {
      v.txidMerkleroot = '0x' + v.txidMerkleroot;
    },
  ],
  [
    'index-overflow',
    (v) => {
      v.txidMerklerootIndex = 8000;
    },
  ],
  [
    'fractional-index',
    (v) => {
      v.txidMerklerootIndex = 1.5;
    },
  ],
  [
    'extra-discriminator',
    (v) => {
      v.kind = 'partial-unshield';
    },
  ],
  [
    'empty-unshield-marker',
    (v) => {
      v.blindedCommitmentsOut = [];
    },
  ],
  [
    'zero-output',
    (v) => {
      v.blindedCommitmentsOut = [hex(0n)];
    },
  ],
  [
    'padded-zero-marker',
    (v) => {
      v.railgunTxidIfHasUnshield = hex(0n);
    },
  ],
  [
    'oversize',
    (v) => {
      v.extra = 'secret-sentinel'.repeat(2000);
    },
  ],
])('refuses %s with a fixed public error', (_name, change) => {
  const v = payload();
  change(v);
  expect(() => normalize(v)).toThrow(
    expect.objectContaining({
      code: 'RAILGUN_POI_PAYLOAD_REFUSED',
      message: 'Railgun POI payload unavailable',
    })
  );
});

test('combined payload retains the exact seven-key wire schema and leading-zero marker', () => {
  const value = payload();
  value.railgunTxidIfHasUnshield = hex(6n);
  const result = normalize(value);
  expect(JSON.stringify(result)).toBe(JSON.stringify(value));
  expect(Object.keys(result)).toHaveLength(7);
  expect(Object.isFrozen(result.blindedCommitmentsOut)).toBe(true);
});
// Captured from the pre-widening HEAD implementation; canonical order is part
// of existing payload, submission-envelope and request-body digest bindings.
test.each([
  [false, '52f3ed00d460736b3b1656c58e5964340765491d42f7cb758181c2df6cd3048e'],
  [true, '5ca54b055bf7afea23437433ab94c21be40687ca8a7e8b8c644a15c647b1458d'],
])('legacy %s canonical payload bytes retain their digest', (unshield, digest) => {
  expect(
    require('crypto')
      .createHash('sha256')
      .update(JSON.stringify(normalize(payload(unshield))))
      .digest('hex')
  ).toBe(digest);
});
