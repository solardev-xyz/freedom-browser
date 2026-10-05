jest.mock('./railgun-own-txid', () => ({ matchRailgunOwnTxid: jest.fn((v) => ({ row: v.row })) }));
jest.mock('./railgun-txid-note-witness', () => ({
  normalizeRailgunTxidWitness: jest.fn((v) => v),
}));
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
    descriptor: {
      walletId: require('../../../scripts/fixtures/railgun-own-txid-data').sample().capsule
        .walletId,
    },
    preparation: {
      creator: { type: 'Shield', position: 1 },
      ownEvidence: {
        capsule: require('../../../scripts/fixtures/railgun-own-txid-data').sample(unshield)
          .capsule,
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
    expect(v.descriptor.walletId).toBe(input().descriptor.walletId);
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

// Public structural fixtures use real capsule, receipt, row and path-schema
// normalization. They do not prove ownership, Merkle paths or Groth16 validity.
describe('combined partial proof binding', () => {
  beforeEach(() => {
    require('./railgun-own-txid').matchRailgunOwnTxid.mockImplementation(
      jest.requireActual('./railgun-own-txid').matchRailgunOwnTxid
    );
    require('./railgun-txid-note-witness').normalizeRailgunTxidWitness.mockImplementation(
      jest.requireActual('./railgun-txid-note-witness').normalizeRailgunTxidWitness
    );
    require('./railgun-poi-shield-selector-data').normalizeRailgunPoiShieldInput.mockImplementation(
      jest.requireActual('./railgun-poi-shield-selector-data').normalizeRailgunPoiShieldInput
    );
  });
  function partial(type = 'Shield') {
    const evidence =
      require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial();
    const v = input();
    const { capsule, row } = evidence;
    v.descriptor = {
      walletId: capsule.walletId,
      instanceId: '0zk1' + 'q'.repeat(123),
      masterPublicKey: hex(3).slice(2),
      spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
      viewingPublicKey: hex(6).slice(2),
      accountIndex: 0,
    };
    v.preparation.ownEvidence = evidence;
    v.preparation.creator =
      type === 'Shield'
        ? {
            type,
            tree: capsule.selection.tree,
            position: capsule.selection.position,
            preimage: {
              npk: hex(7),
              token: {
                tokenType: 0,
                tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
                tokenSubID: hex(0),
              },
              value: capsule.preparation.inputAmount,
            },
            ciphertext: { encryptedBundle: [hex(8), hex(9), hex(10)], shieldKey: hex(11) },
          }
        : {
            type,
            tree: capsule.selection.tree,
            position: capsule.selection.position,
            hash: capsule.noteHash,
            ciphertext: {
              ciphertext: [hex(8), hex(9), hex(10), hex(11)],
              blindedSenderViewingKey: hex(12),
              blindedReceiverViewingKey: hex(13),
              annotationData: '0x',
              memo: '0x',
            },
          };
    const state = { count: 1, root: hex(8).slice(2), transcript: hex(16).slice(2), breaks: [] };
    v.preparation.state = state;
    v.preparation.witness = {
      row: JSON.parse(JSON.stringify(row)),
      leaf: hex(17).slice(2),
      railgunTxid: hex(9).slice(2),
      rowSha256: require('crypto').createHash('sha256').update(JSON.stringify(row)).digest('hex'),
      index: 0,
      elements: Array(16).fill(hex(0).slice(2)),
      root: state.root,
      checkpointIndex: 0,
      transcript: state.transcript,
      continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(0, []),
      globalTxidCompleteness: false,
    };
    return v;
  }
  test.each(['Shield', 'Transact'])(
    'derives exact combined marker/count from real normalized %s input',
    (type) => {
      const v = partial(type),
        normalized = normalize(v),
        fields = expected(normalized);
      expect(fields).toMatchObject({
        railgunTxidIfHasUnshield: hex(9),
        outputCount: 1,
        txidMerklerootIndex: 0,
      });
      const p = { ...payload(), txidMerklerootIndex: 0, railgunTxidIfHasUnshield: hex(9) };
      expect(bind(p, fields)).toEqual(p);
      expect(Object.isFrozen(normalized.preparation.ownEvidence.capsule)).toBe(true);
      v.preparation.ownEvidence.row.commitments.reverse();
      expect(normalized.preparation.ownEvidence.row.commitments).not.toEqual(
        v.preparation.ownEvidence.row.commitments
      );
    }
  );
  test.each([
    'version',
    'kind',
    'order',
    'extra-output',
    'extra-input',
    'receipt',
    'state',
    'witness-row',
    'creator-value',
    'list-count',
  ])('refuses structurally inconsistent partial %s', (fault) => {
    const v = partial(),
      e = v.preparation.ownEvidence;
    if (fault === 'version') e.capsule.version = 1;
    if (fault === 'kind') e.capsule.selection.kind = 'railgun-token-unshield';
    if (fault === 'order') e.row.commitments.reverse();
    if (fault === 'extra-output') e.row.commitments.push(hex(33));
    if (fault === 'extra-input') e.row.nullifiers.push(hex(33));
    if (fault === 'receipt') e.receipt.logs.pop();
    if (fault === 'state') v.preparation.state.root = hex(33).slice(2);
    if (fault === 'witness-row') v.preparation.witness.row.commitments[0] = hex(33);
    if (fault === 'creator-value') v.preparation.creator.preimage.value = '400';
    if (fault === 'list-count') v.listProofs.push(v.listProofs[0]);
    expect(() => normalize(v)).toThrow();
  });
  test.each(['zero-marker', 'foreign-marker', 'short-marker', 'no-change', 'two-changes'])(
    'binder rejects partial %s even if a separate cryptographic verifier would return true',
    (fault) => {
      const fields = expected(partial());
      const p = { ...payload(), txidMerklerootIndex: 0, railgunTxidIfHasUnshield: hex(9) };
      if (fault === 'zero-marker') p.railgunTxidIfHasUnshield = '0x00';
      if (fault === 'foreign-marker') p.railgunTxidIfHasUnshield = hex(10);
      if (fault === 'short-marker') p.railgunTxidIfHasUnshield = '0x09';
      if (fault === 'no-change') p.blindedCommitmentsOut = [];
      if (fault === 'two-changes') p.blindedCommitmentsOut.push(hex(10));
      expect(() => bind(p, fields)).toThrow();
    }
  );
  test('transfer-shaped proof with a positive marker is not a transfer binding', () => {
    const p = payload();
    p.railgunTxidIfHasUnshield = hex(9);
    expect(require('./railgun-poi-payload').normalizeRailgunPoiPayload(p)).toEqual(p);
    expect(() =>
      bind(p, { ...expected(partial()), txidMerklerootIndex: 5, railgunTxidIfHasUnshield: '0x00' })
    ).toThrow();
  });
});
