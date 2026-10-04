const { createHash } = require('crypto');
const { sample } = require('../../../scripts/fixtures/railgun-own-txid-data');
const { digestRailgunPrivateCapsule } = require('./railgun-private-capsule');
const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const {
  normalizeRailgunPoiOutputRecoveryInput: normalize,
  normalizeRailgunRecoveredPoiOutput: output,
} = require('./railgun-poi-output-recovery-data');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sha = (v) => createHash('sha256').update(v).digest('hex');
function input() {
  const ownEvidence = sample(),
    capsule = ownEvidence.capsule,
    state = { count: 1, root: hex(1).slice(2), transcript: hex(2).slice(2), breaks: [] };
  return {
    archive: '/fixture-engine.asar',
    descriptor: {
      walletId: capsule.walletId,
      instanceId: capsule.selection.recipient,
      masterPublicKey: hex(3).slice(2),
      spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
      viewingPublicKey: hex(6).slice(2),
      accountIndex: 0,
    },
    binding: {
      capsuleDigest: digestRailgunPrivateCapsule(capsule),
      bindingDigest: '7'.repeat(64),
      payloadSha256: '8'.repeat(64),
      revision: 1,
    },
    preparation: {
      creator: {
        type: 'Shield',
        tree: 0,
        position: 1,
        preimage: {
          npk: hex(3),
          value: '1000',
          token: {
            tokenType: 0,
            tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
            tokenSubID: hex(0),
          },
        },
        ciphertext: { encryptedBundle: [hex(4), hex(5), hex(6)], shieldKey: hex(7) },
      },
      ownEvidence,
      state,
      witness: {
        row: JSON.parse(JSON.stringify(ownEvidence.row)),
        leaf: hex(8).slice(2),
        railgunTxid: hex(9).slice(2),
        rowSha256: sha(JSON.stringify(ownEvidence.row)),
        index: 0,
        elements: Array(16).fill(hex(0).slice(2)),
        root: state.root,
        checkpointIndex: 0,
        transcript: state.transcript,
        continuity: classifyRailgunTxidContinuity(0, []),
        globalTxidCompleteness: false,
      },
    },
  };
}
test('real capsule, transaction, receipt and witness validators accept detached frozen structural data', () => {
  const value = input(),
    normalized = normalize(value);
  expect(normalized).toEqual(value);
  expect(Object.isFrozen(normalized.descriptor.spendingPublicKey)).toBe(true);
  expect(Object.isFrozen(normalized.preparation.ownEvidence.receipt.logs[0])).toBe(true);
  value.descriptor.spendingPublicKey[0] = hex(10).slice(2);
  value.preparation.creator.ciphertext.encryptedBundle[0] = hex(11);
  value.preparation.witness.elements[0] = hex(12).slice(2);
  expect(normalized.descriptor.spendingPublicKey[0]).toBe(hex(4).slice(2));
  expect(normalized.preparation.creator.ciphertext.encryptedBundle[0]).toBe(hex(4));
  expect(normalized.preparation.witness.elements[0]).toBe(hex(0).slice(2));
  expect(normalized).not.toHaveProperty('proofVerified');
});
test.each([
  'saved-proof',
  'saved-output',
  'list-witness',
  'key',
  'extra-binding',
  'relative-archive',
  'descriptor-extra',
  'account-negative',
  'account-overflow',
  'wallet',
  'address',
  'viewing-key',
  'master-field',
  'spending-field',
  'spending-count',
  'revision-zero',
  'revision-five',
  'revision-fraction',
  'capsule-digest',
  'payload-digest',
  'creator-type',
  'creator-position',
  'creator-token',
  'creator-value',
  'creator-ciphertext',
  'capsule-path',
  'commitment',
  'transaction',
  'receipt',
  'row-hash',
  'path-length',
  'path-field',
  'checkpoint-index',
  'root',
  'row-position',
])('refuses malformed or injected %s before utility work', (kind) => {
  const v = input(),
    p = v.preparation;
  if (kind === 'saved-proof') v.proof = {};
  if (kind === 'saved-output') v.blindedCommitmentsOut = [hex(1)];
  if (kind === 'list-witness') p.listProofs = [];
  if (kind === 'key') v.viewingKey = 'private-sentinel';
  if (kind === 'extra-binding') v.binding.expectedOutput = hex(1);
  if (kind === 'relative-archive') v.archive = 'engine.asar';
  if (kind === 'descriptor-extra') v.descriptor.privateKey = 'private-sentinel';
  if (kind === 'account-negative') v.descriptor.accountIndex = -1;
  if (kind === 'account-overflow') v.descriptor.accountIndex = 65536;
  if (kind === 'wallet') v.descriptor.walletId = 'a'.repeat(64);
  if (kind === 'address') v.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
  if (kind === 'viewing-key') v.descriptor.viewingPublicKey = hex(1);
  if (kind === 'master-field') v.descriptor.masterPublicKey = hex(FIELD).slice(2);
  if (kind === 'spending-field') v.descriptor.spendingPublicKey[0] = hex(FIELD).slice(2);
  if (kind === 'spending-count') v.descriptor.spendingPublicKey.push(hex(1).slice(2));
  if (kind === 'revision-zero') v.binding.revision = 0;
  if (kind === 'revision-five') v.binding.revision = 5;
  if (kind === 'revision-fraction') v.binding.revision = 1.5;
  if (kind === 'capsule-digest') v.binding.capsuleDigest = '0'.repeat(64);
  if (kind === 'payload-digest') v.binding.payloadSha256 = 'not-a-digest';
  if (kind === 'creator-type') p.creator.type = 'Transact';
  if (kind === 'creator-position') p.creator.position++;
  if (kind === 'creator-token') p.creator.preimage.token.tokenAddress = '0x' + '1'.repeat(40);
  if (kind === 'creator-value') p.creator.preimage.value = '1001';
  if (kind === 'creator-ciphertext') p.creator.ciphertext.encryptedBundle.pop();
  if (kind === 'capsule-path') p.ownEvidence.capsule.pathElements.pop();
  if (kind === 'commitment') p.ownEvidence.row.commitments[0] = hex(100);
  if (kind === 'transaction') p.ownEvidence.transaction.hash = hex(101);
  if (kind === 'receipt') p.ownEvidence.receipt.status = '0x0';
  if (kind === 'row-hash') p.witness.rowSha256 = '0'.repeat(64);
  if (kind === 'path-length') p.witness.elements.pop();
  if (kind === 'path-field') p.witness.elements[0] = hex(FIELD).slice(2);
  if (kind === 'checkpoint-index') p.witness.checkpointIndex++;
  if (kind === 'root') p.witness.root = hex(100).slice(2);
  if (kind === 'row-position') {
    p.witness.row.utxoBatchStartPositionOut++;
    p.witness.rowSha256 = sha(JSON.stringify(p.witness.row));
  }
  expect(() => normalize(v)).toThrow();
});
test('full unshield cannot enter the transfer viewing utility', () => {
  const v = input();
  v.preparation.ownEvidence = sample(true);
  v.binding.capsuleDigest = digestRailgunPrivateCapsule(v.preparation.ownEvidence.capsule);
  expect(() => normalize(v)).toThrow();
});
test('complete UTF-8 input is bounded before normalization', () => {
  const v = input(),
    size = Buffer.byteLength(JSON.stringify(v));
  v.archive += 'x'.repeat(65536 - size);
  expect(Buffer.byteLength(JSON.stringify(v))).toBe(65536);
  expect(normalize(v).archive).toBe(v.archive);
  v.archive += 'x';
  expect(() => normalize(v)).toThrow();
});
test.each([1n, FIELD - 1n])('recovered output accepts exact nonzero BN254 field %s', (value) => {
  const source = { blindedCommitmentsOut: [hex(value)], railgunTxidIfHasUnshield: '0x00' };
  const result = output(source);
  source.blindedCommitmentsOut[0] = hex(2);
  expect(result.blindedCommitmentsOut).toEqual([hex(value)]);
  expect(Object.isFrozen(result.blindedCommitmentsOut)).toBe(true);
});
test.each([hex(0), hex(FIELD), hex(FIELD + 1n), '0x1', hex(1).slice(2), '0x' + 'A'.repeat(64), 1n])(
  'recovered output rejects noncanonical or out-of-range field %#',
  (value) => {
    expect(() =>
      output({ blindedCommitmentsOut: [value], railgunTxidIfHasUnshield: '0x00' })
    ).toThrow();
  }
);
test.each(['empty', 'two', 'marker', 'wide-zero', 'extra'])(
  'recovered output rejects %s',
  (kind) => {
    const v = { blindedCommitmentsOut: [hex(1)], railgunTxidIfHasUnshield: '0x00' };
    if (kind === 'empty') v.blindedCommitmentsOut = [];
    if (kind === 'two') v.blindedCommitmentsOut.push(hex(2));
    if (kind === 'marker') v.railgunTxidIfHasUnshield = hex(3);
    if (kind === 'wide-zero') v.railgunTxidIfHasUnshield = hex(0);
    if (kind === 'extra') v.npk = hex(4);
    expect(() => output(v)).toThrow();
  }
);
