const {
  normalizeRailgunRelayPrePoiBinding: binding,
  normalizeRailgunRelayPrePoiPayload: payload,
  bindRailgunRelayPrePoiPayload: bind,
  RAILGUN_RELAY_PRE_POI_MAX_BINDING_BYTES: BINDING_BYTES,
  RAILGUN_RELAY_PRE_POI_MAX_PAYLOAD_BYTES: PAYLOAD_BYTES,
  RAILGUN_RELAY_PRE_POI_MAX_BOUND_BYTES: BOUND_BYTES,
} = require('./railgun-relay-pre-poi-data');
const { normalizeRailgunPoiPayload } = require('./railgun-poi-payload');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
function fixture() {
  const expected = {
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest: 'ff'.repeat(32),
    chainId: pins.chainId,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: { leaf: hex(1), root: hex(2), indices: hex(5), elements: Array(16).fill(hex(3)) },
    txidLeafHash: hex(4),
    txidMerkleroot: hex(6),
    blindedCommitmentsOut: ['0x' + hex(7), '0x' + hex(8)],
  };
  const value = {
    snarkProof: {
      pi_a: ['1', '2'],
      pi_b: [
        ['3', '4'],
        ['5', '6'],
      ],
      pi_c: ['7', '8'],
    },
    txidMerkleroot: expected.txidMerkleroot,
    poiMerkleroots: [expected.listWitness.root],
    blindedCommitmentsOut: [...expected.blindedCommitmentsOut],
    railgunTxidIfHasUnshield: '0x00',
  };
  return { expected, value };
}
function refused(fn) {
  expect(fn).toThrow(expect.objectContaining({ code: 'RAILGUN_RELAY_PRE_POI_DATA_REFUSED' }));
}
test('bind preserves exact original witness and ordered values without mathematical or authority assertions', () => {
  const { expected, value } = fixture();
  const result = bind(value, expected);
  expect(result).toEqual({
    schema: 'railgun-relay-pre-poi-bound-v1',
    binding: expected,
    payload: value,
  });
  expect(Object.keys(result)).toEqual(['schema', 'binding', 'payload']);
  expect(result.binding.draftDigest).toBe('ff'.repeat(32)); // SHA-256 is not Fr.
  const text = JSON.stringify(result);
  expected.listWitness.elements[0] = hex(99);
  expected.blindedCommitmentsOut.reverse();
  value.snarkProof.pi_b[0][0] = '999';
  value.poiMerkleroots[0] = hex(99);
  expect(JSON.stringify(result)).toBe(text);
  function immutable(v) {
    if (v && typeof v === 'object') {
      expect(Object.isFrozen(v)).toBe(true);
      Object.values(v).forEach(immutable);
    }
  }
  immutable(result);
});
test('maxima follow exact fixed-width fields plus eight 77-digit coordinates', () => {
  const { expected, value } = fixture();
  expected.listWitness = {
    leaf: hex(FIELD - 1n),
    root: hex(FIELD - 1n),
    indices: hex(65535),
    elements: Array(16).fill(hex(FIELD - 1n)),
  };
  expected.txidLeafHash = expected.txidMerkleroot = hex(FIELD - 1n);
  expected.blindedCommitmentsOut = ['0x' + hex(FIELD - 1n), '0x' + hex(FIELD - 2n)];
  value.txidMerkleroot = expected.txidMerkleroot;
  value.poiMerkleroots = [expected.listWitness.root];
  value.blindedCommitmentsOut = [...expected.blindedCommitmentsOut];
  const p = (BASE - 1n).toString();
  value.snarkProof = {
    pi_a: [p, p],
    pi_b: [
      [p, p],
      [p, p],
    ],
    pi_c: [p, p],
  };
  const result = bind(value, expected);
  expect(Buffer.byteLength(JSON.stringify(result.binding))).toBe(BINDING_BYTES);
  expect(Buffer.byteLength(JSON.stringify(result.payload))).toBe(PAYLOAD_BYTES);
  expect(Buffer.byteLength(JSON.stringify(result))).toBe(BOUND_BYTES);
  expect([BINDING_BYTES, PAYLOAD_BYTES, BOUND_BYTES]).toEqual([1912, 1055, 3032]);
});
test.each([
  [
    'schema',
    (v) => {
      v.schema = 'railgun-own-poi-v1';
    },
  ],
  [
    'chain',
    (v) => {
      v.chainId = 1;
    },
  ],
  [
    'version',
    (v) => {
      v.txidVersion = 'V3_PoseidonMerkle';
    },
  ],
  [
    'list',
    (v) => {
      v.listKey = '44'.repeat(32);
    },
  ],
  [
    'draft digest',
    (v) => {
      v.draftDigest = '0x' + '00'.repeat(32);
    },
  ],
  [
    'extra mined index',
    (v) => {
      v.txidMerklerootIndex = 0;
    },
  ],
  [
    'oversized witness index',
    (v) => {
      v.listWitness.indices = hex(65536);
    },
  ],
  [
    'short witness',
    (v) => {
      v.listWitness.elements.pop();
    },
  ],
  [
    'long witness',
    (v) => {
      v.listWitness.elements.push(hex(0));
    },
  ],
  [
    'witness prefix',
    (v) => {
      v.listWitness.leaf = '0x' + v.listWitness.leaf;
    },
  ],
  [
    'witness Fr boundary',
    (v) => {
      v.listWitness.root = hex(FIELD);
    },
  ],
  [
    'witness sibling Fr boundary',
    (v) => {
      v.listWitness.elements[15] = hex(FIELD);
    },
  ],
  [
    'leaf Fr boundary',
    (v) => {
      v.txidLeafHash = hex(FIELD);
    },
  ],
  [
    'root Fr boundary',
    (v) => {
      v.txidMerkleroot = hex(FIELD);
    },
  ],
  [
    'missing output',
    (v) => {
      v.blindedCommitmentsOut.pop();
    },
  ],
  [
    'extra output',
    (v) => {
      v.blindedCommitmentsOut.push('0x' + hex(9));
    },
  ],
  [
    'duplicate output',
    (v) => {
      v.blindedCommitmentsOut[1] = v.blindedCommitmentsOut[0];
    },
  ],
  [
    'zero output',
    (v) => {
      v.blindedCommitmentsOut[0] = '0x' + hex(0);
    },
  ],
  [
    'output Fr boundary',
    (v) => {
      v.blindedCommitmentsOut[0] = '0x' + hex(FIELD);
    },
  ],
  [
    'output bare',
    (v) => {
      v.blindedCommitmentsOut[0] = hex(1);
    },
  ],
])('binding refuses %s', (_name, change) => {
  const { expected } = fixture();
  change(expected);
  refused(() => binding(expected));
});
test.each([
  [
    'mined index',
    (v) => {
      v.txidMerklerootIndex = 0;
    },
  ],
  [
    'mined proof key',
    (v) => {
      v.proof = v.snarkProof;
      delete v.snarkProof;
    },
  ],
  [
    'mined list key',
    (v) => {
      v.listKey = REQUIRED_LIST;
    },
  ],
  [
    'extra homogeneous coordinate',
    (v) => {
      v.snarkProof.pi_a.push('1');
    },
  ],
  [
    'extra proof protocol',
    (v) => {
      v.snarkProof.protocol = 'groth16';
    },
  ],
  [
    'G2 extra row',
    (v) => {
      v.snarkProof.pi_b.push(['1', '0']);
    },
  ],
  [
    'G2 flat',
    (v) => {
      v.snarkProof.pi_b = ['1', '2'];
    },
  ],
  [
    'numeric coordinate',
    (v) => {
      v.snarkProof.pi_a[0] = 1;
    },
  ],
  [
    'BigInt coordinate',
    (v) => {
      v.snarkProof.pi_a[0] = 1n;
    },
  ],
  [
    'negative coordinate',
    (v) => {
      v.snarkProof.pi_a[0] = '-1';
    },
  ],
  [
    'leading zero',
    (v) => {
      v.snarkProof.pi_a[0] = '01';
    },
  ],
  [
    'hex coordinate',
    (v) => {
      v.snarkProof.pi_a[0] = '0x01';
    },
  ],
  [
    'exponent coordinate',
    (v) => {
      v.snarkProof.pi_a[0] = '1e1';
    },
  ],
  [
    'base field boundary',
    (v) => {
      v.snarkProof.pi_c[1] = BASE.toString();
    },
  ],
  [
    'oversized coordinate',
    (v) => {
      v.snarkProof.pi_c[1] = '1'.repeat(10000);
    },
  ],
  [
    'extra list',
    (v) => {
      v.poiMerkleroots.push(hex(1));
    },
  ],
  [
    'root prefix',
    (v) => {
      v.txidMerkleroot = '0x' + v.txidMerkleroot;
    },
  ],
  [
    'list root Fr',
    (v) => {
      v.poiMerkleroots[0] = hex(FIELD);
    },
  ],
  [
    'zero output',
    (v) => {
      v.blindedCommitmentsOut[0] = '0x' + hex(0);
    },
  ],
  [
    'third output',
    (v) => {
      v.blindedCommitmentsOut.push('0x' + hex(9));
    },
  ],
  [
    'duplicate outputs',
    (v) => {
      v.blindedCommitmentsOut[1] = v.blindedCommitmentsOut[0];
    },
  ],
  [
    'unshield',
    (v) => {
      v.railgunTxidIfHasUnshield = '0x' + hex(1);
    },
  ],
  [
    'wide zero marker',
    (v) => {
      v.railgunTxidIfHasUnshield = '0x' + hex(0);
    },
  ],
])('payload refuses %s', (_name, change) => {
  const { value } = fixture();
  change(value);
  refused(() => payload(value));
});
test.each(['txidMerkleroot', 'poiMerkleroots', 'blindedCommitmentsOut'])(
  'binding refuses changed %s while shape alone accepts',
  (key) => {
    const { expected, value } = fixture();
    if (key === 'txidMerkleroot') value[key] = hex(10);
    else if (key === 'poiMerkleroots') value[key] = [hex(10)];
    else value[key].reverse();
    expect(() => payload(value)).not.toThrow();
    refused(() => bind(value, expected));
  }
);
test('the mined normalizer still refuses two-output pretransaction data and the reverse domain', () => {
  const { value } = fixture();
  const mined = {
    listKey: REQUIRED_LIST,
    proof: value.snarkProof,
    poiMerkleroots: value.poiMerkleroots,
    txidMerkleroot: value.txidMerkleroot,
    txidMerklerootIndex: 0,
    blindedCommitmentsOut: [value.blindedCommitmentsOut[0]],
    railgunTxidIfHasUnshield: '0x00',
  };
  expect(() => normalizeRailgunPoiPayload(mined)).not.toThrow();
  refused(() => payload(mined));
  expect(() => normalizeRailgunPoiPayload(value)).toThrow();
  mined.blindedCommitmentsOut = value.blindedCommitmentsOut;
  expect(() => normalizeRailgunPoiPayload(mined)).toThrow();
});
test.each(['binding', 'witness', 'witnessArray', 'payload', 'proof', 'proofArray'])(
  'rejects proxy/accessor data before caller code: %s',
  (where) => {
    const setup = () => {
      const { expected, value } = fixture();
      if (where === 'binding')
        return { get: () => expected, set: (v) => ({ expected: v, value }), expected, value };
      if (where === 'witness')
        return {
          get: () => expected.listWitness,
          set: (v) => {
            expected.listWitness = v;
            return { expected, value };
          },
          expected,
          value,
        };
      if (where === 'witnessArray')
        return {
          get: () => expected.listWitness.elements,
          set: (v) => {
            expected.listWitness.elements = v;
            return { expected, value };
          },
          expected,
          value,
        };
      if (where === 'payload')
        return { get: () => value, set: (v) => ({ expected, value: v }), expected, value };
      if (where === 'proof')
        return {
          get: () => value.snarkProof,
          set: (v) => {
            value.snarkProof = v;
            return { expected, value };
          },
          expected,
          value,
        };
      return {
        get: () => value.snarkProof.pi_b[0],
        set: (v) => {
          value.snarkProof.pi_b[0] = v;
          return { expected, value };
        },
        expected,
        value,
      };
    };
    let x = setup();
    const trap = jest.fn(() => {
      throw Error('caller code');
    });
    let changed = x.set(new Proxy(x.get(), { get: trap, getPrototypeOf: trap, ownKeys: trap }));
    refused(() => bind(changed.value, changed.expected));
    expect(trap).not.toHaveBeenCalled();
    x = setup();
    const target = x.get(),
      name = Array.isArray(target) ? '0' : Object.keys(target)[0];
    Object.defineProperty(target, name, { enumerable: true, get: trap });
    changed = x.set(target);
    refused(() => bind(changed.value, changed.expected));
    expect(trap).not.toHaveBeenCalled();
  }
);
test.each([
  'sparse',
  'symbol',
  'extra',
  'nonenumerable',
  'arraySubclass',
  'typedArray',
  'nullPrototype',
])('rejects nonordinary value shape: %s', (kind) => {
  const { expected, value } = fixture();
  const a = value.snarkProof.pi_a;
  if (kind === 'sparse') delete a[0];
  else if (kind === 'symbol') a[Symbol('extra')] = 0;
  else if (kind === 'extra') a.extra = 0;
  else if (kind === 'nonenumerable')
    Object.defineProperty(a, '0', { value: '1', enumerable: false });
  else if (kind === 'arraySubclass') {
    class Custom extends Array {}
    value.snarkProof.pi_a = new Custom('1', '2');
  } else if (kind === 'typedArray') value.snarkProof.pi_a = new Uint8Array([1, 2]);
  else Object.setPrototypeOf(value, null);
  refused(() => bind(value, expected));
});
