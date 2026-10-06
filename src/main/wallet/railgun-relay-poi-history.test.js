const { REQUIRED_LIST } = require('./railgun-poi-records');
const {
  normalizeRailgunRelayPoiHistory: normalize,
  MAX_HISTORY_BYTES,
} = require('./railgun-relay-poi-history');
const hex = (value) => BigInt(value).toString(16).padStart(64, '0');
const refused = expect.objectContaining({ code: 'RAILGUN_RELAY_POI_HISTORY_REFUSED' });
function fixture() {
  return {
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest: 'ab'.repeat(32),
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: '0x' + hex(1), type: 'Transact' },
    proof: { leaf: hex(1), root: hex(2), indices: hex(5), elements: Array(16).fill(hex(3)) },
    event: {
      signedPOIEvent: {
        index: 5,
        blindedCommitment: '0x' + hex(1),
        type: 'Transact',
        signature: '12'.repeat(64),
      },
      validatedMerkleroot: hex(4),
    },
  };
}
test('detaches exact history without interpreting its dummy signature/path as validity', () => {
  const input = fixture(),
    result = normalize(input);
  expect(result.data).toEqual(input);
  expect(normalize(result.data)).toEqual(result);
  expect(Object.isFrozen(result.data.proof.elements)).toBe(true);
  input.proof.elements[0] = hex(9);
  expect(result.data.proof.elements[0]).toBe(hex(3));
  expect(result.data.event.validatedMerkleroot).not.toBe(result.data.proof.root);
  expect(Object.keys(result).sort()).toEqual(['data', 'digest']);
});
test('preserves exact signed prefix and distinguishes history digests', () => {
  const v = fixture(),
    prefixed = normalize(v);
  v.event.signedPOIEvent.blindedCommitment = hex(1);
  const bare = normalize(v);
  expect(bare.data.event.signedPOIEvent.blindedCommitment).toBe(hex(1));
  expect(bare.digest).not.toBe(prefixed.digest);
});
test.each([
  [
    'schema',
    (v) => {
      v.schema = 'railgun-relay-pre-poi-binding-v1';
    },
  ],
  [
    'list',
    (v) => {
      v.listKey = '00'.repeat(32);
    },
  ],
  [
    'note',
    (v) => {
      v.note.blindedCommitment = '0x' + hex(2);
    },
  ],
  [
    'kind',
    (v) => {
      v.note.type = 'Unshield';
    },
  ],
  [
    'event kind',
    (v) => {
      v.event.signedPOIEvent.type = 'Shield';
    },
  ],
  [
    'event index',
    (v) => {
      v.event.signedPOIEvent.index = 6;
    },
  ],
  [
    'event leaf',
    (v) => {
      v.event.signedPOIEvent.blindedCommitment = hex(2);
    },
  ],
  [
    'signature',
    (v) => {
      v.event.signedPOIEvent.signature += '00';
    },
  ],
  [
    'index bound',
    (v) => {
      v.proof.indices = hex(65536);
      v.event.signedPOIEvent.index = 65536;
    },
  ],
  [
    'path length',
    (v) => {
      v.proof.elements.push(hex(4));
    },
  ],
  [
    'noncanonical path field',
    (v) => {
      v.proof.elements[0] = '0x' + hex(4);
    },
  ],
  [
    'root range',
    (v) => {
      v.proof.root = 'ff'.repeat(32);
    },
  ],
  [
    'fresh authority flag',
    (v) => {
      v.fresh = true;
    },
  ],
])('refuses %s substitution', (_name, mutate) => {
  const value = fixture();
  mutate(value);
  expect(() => normalize(value)).toThrow(refused);
});
test('rejects getters, array extras, sparse paths and proxies without evaluating traps', () => {
  for (const at of ['object', 'element']) {
    const value = fixture(),
      getter = jest.fn();
    Object.defineProperty(
      at === 'object' ? value.note : value.proof.elements,
      at === 'object' ? 'type' : '0',
      { enumerable: true, get: getter }
    );
    expect(() => normalize(value)).toThrow(refused);
    expect(getter).not.toHaveBeenCalled();
  }
  const value = fixture();
  value.proof.elements.extra = true;
  expect(() => normalize(value)).toThrow(refused);
  value.proof.elements = new Array(16);
  expect(() => normalize(value)).toThrow(refused);
  const trap = jest.fn();
  value.proof.elements = new Proxy(Array(16).fill(hex(0)), { getPrototypeOf: trap });
  expect(() => normalize(value)).toThrow(refused);
  expect(trap).not.toHaveBeenCalled();
});
test('maximum-width allowed fields stay below the reserved history slot', () => {
  const value = fixture();
  value.proof.indices = hex(65535);
  value.event.signedPOIEvent.index = 65535;
  const maximum = normalize(value).data;
  // All fields have fixed widths except kind (Transact), prefix (0x), and index.
  expect(Buffer.byteLength(JSON.stringify(maximum))).toBe(2023);
  expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThan(MAX_HISTORY_BYTES);
});
