jest.mock('./railgun-own-txid', () => ({ matchRailgunOwnTxid: (v) => ({ row: v.row }) }));
jest.mock('./railgun-txid-note-witness', () => ({ normalizeRailgunTxidWitness: (v) => v }));
jest.mock('./railgun-poi-shield-selector-data', () => ({
  normalizeRailgunPoiShieldInput: jest.fn((capsule, creator) => {
    if (creator.type !== 'Shield' || capsule.selection.position !== creator.position)
      throw Error('creator mismatch');
  }),
}));
const {
  normalizeRailgunOwnPoiProofInput: normalize,
  expectedRailgunOwnPoiFields: expected,
  bindRailgunOwnPoiPayload: bind,
} = require('./railgun-own-poi-proof-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
function input(unshield = false) {
  const row = { boundParamsHash: hex(7) };
  return {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor: { walletId: 'test-wallet' },
    preparation: {
      creator: { type: 'Shield', position: 0 },
      ownEvidence: {
        capsule: {
          version: 1,
          walletId: 'test-wallet',
          selection: {
            position: 0,
            kind: unshield ? 'railgun-token-unshield' : 'railgun-private-transfer',
          },
        },
        record: {},
        transaction: {},
        receipt: {},
        row,
      },
      state: {},
      witness: { row, root: hex(8).slice(2), checkpointIndex: 5, railgunTxid: hex(9).slice(2) },
    },
    listProofs: [{ leaf: hex(1), root: hex(2), indices: hex(3), elements: Array(16).fill(hex(0)) }],
  };
}
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
    poiMerkleroots: [hex(2).slice(2)],
    txidMerkleroot: hex(8).slice(2),
    txidMerklerootIndex: 5,
    railgunTxidIfHasUnshield: unshield ? hex(9) : '0x00',
    blindedCommitmentsOut: unshield ? [] : [hex(4)],
  };
}
test.each([false, true])(
  'binds host-derived fields and returns detached canonical %s input',
  (unshield) => {
    const source = input(unshield),
      v = normalize(source),
      fields = expected(v);
    expect(v.listProofs[0].leaf).toBe(hex(1).slice(2));
    expect(Object.isFrozen(v.preparation.ownEvidence.capsule.selection)).toBe(true);
    source.descriptor.walletId = 'changed';
    source.preparation.witness.root = hex(10).slice(2);
    expect(v.descriptor.walletId).toBe('test-wallet');
    expect(fields.txidMerkleroot).toBe(hex(8).slice(2));
    expect(fields.outputCount).toBe(unshield ? 0 : 1);
    const p = payload(unshield),
      result = bind(p, fields);
    expect(result).toEqual(p);
    p.proof.pi_a[0] = '11';
    expect(result.proof.pi_a[0]).toBe('1');
    expect(Object.isFrozen(result.proof.pi_a)).toBe(true);
  }
);
test.each([
  'extra',
  'relative-engine',
  'relative-prover',
  'relative-artifacts',
  'preparation-shape',
  'evidence-shape',
  'creator',
  'position',
  'wallet',
  'row',
  'proof-count',
  'proof-depth',
  'proof-index',
  'proof-root',
])('refuses malformed %s before key work', (fault) => {
  const v = input();
  if (fault === 'extra') v.callerWitness = {};
  if (fault === 'relative-engine') v.archive = 'engine.asar';
  if (fault === 'relative-prover') v.proverArchive = 'prover.asar';
  if (fault === 'relative-artifacts') v.artifactDirectory = 'artifacts';
  if (fault === 'preparation-shape') v.preparation.extra = {};
  if (fault === 'evidence-shape') v.preparation.ownEvidence.extra = {};
  if (fault === 'creator') v.preparation.creator.type = 'Transact';
  if (fault === 'position') v.preparation.creator.position++;
  if (fault === 'wallet') v.descriptor.walletId = 'foreign';
  if (fault === 'row') v.preparation.witness.row = { changed: true };
  if (fault === 'proof-count') v.listProofs.push(v.listProofs[0]);
  if (fault === 'proof-depth') v.listProofs[0].elements.pop();
  if (fault === 'proof-index') v.listProofs[0].indices = hex(65536);
  if (fault === 'proof-root') v.listProofs[0].root = 'f'.repeat(64);
  expect(() => normalize(v)).toThrow();
});
test('bounds complete input at the utility transport limit including paths and capsule', () => {
  const v = input();
  v.descriptor.padding = '';
  const length = Buffer.byteLength(JSON.stringify(v));
  v.descriptor.padding = 'x'.repeat(65536 - length);
  expect(Buffer.byteLength(JSON.stringify(v))).toBe(65536);
  expect(normalize(v).descriptor.padding.length).toBe(65536 - length);
  v.descriptor.padding += 'x';
  expect(() => normalize(v)).toThrow();
});
test.each(['list', 'poi-root', 'txid-root', 'checkpoint', 'marker', 'output-count', 'proof-extra'])(
  'refuses viewing-job payload changed at %s',
  (fault) => {
    const v = payload();
    if (fault === 'list') v.listKey = 'f'.repeat(64);
    if (fault === 'poi-root') v.poiMerkleroots[0] = hex(11).slice(2);
    if (fault === 'txid-root') v.txidMerkleroot = hex(11).slice(2);
    if (fault === 'checkpoint') v.txidMerklerootIndex++;
    if (fault === 'marker') {
      v.railgunTxidIfHasUnshield = hex(9);
      v.blindedCommitmentsOut = [];
    }
    if (fault === 'output-count') v.blindedCommitmentsOut.push(hex(12));
    if (fault === 'proof-extra') v.proof.privateWitness = {};
    expect(() => bind(v, expected(input()))).toThrow();
  }
);

test.each(['Shield', 'Transact'])(
  'v2 partial %s input refuses before creator binding and public-field derivation',
  (type) => {
    const {
      createRailgunPartialCapsuleData,
    } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
    const value = input();
    value.preparation.ownEvidence.capsule =
      require('./railgun-private-capsule').normalizeRailgunPrivateCapsule(
        createRailgunPartialCapsuleData().capsule
      );
    value.preparation.creator.type = type;
    const shield = require('./railgun-poi-shield-selector-data').normalizeRailgunPoiShieldInput;
    shield.mockClear();
    expect(() => normalize(value)).toThrow();
    expect(() => expected(value)).toThrow();
    expect(shield).not.toHaveBeenCalled();
  }
);
