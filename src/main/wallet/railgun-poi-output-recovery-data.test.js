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
test("a marked foreign transfer is admitted under its own capsule digest for A's POI", () => {
  const foreign = () => {
    const value = input();
    const capsule = value.preparation.ownEvidence.capsule;
    capsule.selection.recipient = '0zk1' + 'p'.repeat(123);
    capsule.preparation.recipient = '0zk1' + 'p'.repeat(123);
    capsule.selection.recipientRelationship = 'foreign';
    value.binding.capsuleDigest = digestRailgunPrivateCapsule(capsule);
    return value;
  };
  const normalized = normalize(foreign());
  expect(normalized.preparation.ownEvidence.capsule.selection.recipientRelationship).toBe(
    'foreign'
  );
  expect(normalized.binding.capsuleDigest).not.toBe(input().binding.capsuleDigest);
  const unmarked = foreign();
  delete unmarked.preparation.ownEvidence.capsule.selection.recipientRelationship;
  unmarked.binding.capsuleDigest = digestRailgunPrivateCapsule(
    unmarked.preparation.ownEvidence.capsule
  );
  expect(() => normalize(unmarked)).toThrow();
  const stale = foreign();
  stale.binding.capsuleDigest = input().binding.capsuleDigest;
  expect(() => normalize(stale)).toThrow();
  const own = foreign();
  own.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
  expect(() => normalize(own)).toThrow();
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
test.each(['empty', 'two', 'short-marker', 'wide-zero', 'extra'])(
  'recovered output rejects %s',
  (kind) => {
    const v = { blindedCommitmentsOut: [hex(1)], railgunTxidIfHasUnshield: '0x00' };
    if (kind === 'empty') v.blindedCommitmentsOut = [];
    if (kind === 'two') v.blindedCommitmentsOut.push(hex(2));
    if (kind === 'short-marker') v.railgunTxidIfHasUnshield = '0x03';
    if (kind === 'wide-zero') v.railgunTxidIfHasUnshield = hex(0);
    if (kind === 'extra') v.npk = hex(4);
    expect(() => output(v)).toThrow();
  }
);
function transactInput() {
  const value = input(),
    capsule = value.preparation.ownEvidence.capsule;
  value.preparation.creator = {
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
  };
  return value;
}
test('actual Transact output normalizer detaches canonical data without saved output or proof authority', () => {
  const value = transactInput();
  const result = normalize(value);
  expect(result).toEqual(value);
  expect(Object.isFrozen(result.preparation.creator.ciphertext.ciphertext)).toBe(true);
  value.preparation.creator.ciphertext.ciphertext[0] = hex(900);
  expect(result.preparation.creator.ciphertext.ciphertext[0]).toBe(hex(7));
  expect(result).not.toHaveProperty('proofVerified');
  expect(result).not.toHaveProperty('blindedCommitmentsOut');
});
test.each([
  'unknown',
  'missing',
  'tree',
  'position',
  'hash',
  'cipher-count',
  'cipher-extra',
  'memo-odd',
  'annotation-limit',
  'descriptor-wallet',
  'descriptor-recipient',
  'capsule',
  'witness',
  'saved-output',
])('actual Transact output input refuses %s before credential access', (fault) => {
  const value = transactInput(),
    creator = value.preparation.creator;
  if (fault === 'unknown') creator.type = 'Unknown';
  if (fault === 'missing') delete creator.type;
  if (fault === 'tree') creator.tree++;
  if (fault === 'position') creator.position++;
  if (fault === 'hash') creator.hash = hex(900);
  if (fault === 'cipher-count') creator.ciphertext.ciphertext.pop();
  if (fault === 'cipher-extra') creator.ciphertext.legacy = true;
  if (fault === 'memo-odd') creator.ciphertext.memo = '0x1';
  if (fault === 'annotation-limit') creator.ciphertext.annotationData = '0x' + '11'.repeat(3521);
  if (fault === 'descriptor-wallet') value.descriptor.walletId = 'a'.repeat(64);
  if (fault === 'descriptor-recipient') value.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
  if (fault === 'capsule') value.preparation.ownEvidence.capsule.noteHash = hex(900);
  if (fault === 'witness') value.preparation.witness.checkpointIndex++;
  if (fault === 'saved-output') value.blindedCommitmentsOut = [hex(900)];
  expect(() => normalize(value)).toThrow();
});
test('Transact output input retains the exact 64KiB whole-message boundary', () => {
  const value = transactInput();
  value.archive += 'x'.repeat(65536 - Buffer.byteLength(JSON.stringify(value)));
  expect(Buffer.byteLength(JSON.stringify(value))).toBe(65536);
  expect(normalize(value).archive).toBe(value.archive);
  value.archive += 'x';
  expect(() => normalize(value)).toThrow();
});

function partialInput(type = 'Shield') {
  const value = type === 'Shield' ? input() : transactInput();
  const evidence =
    require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial();
  value.preparation.ownEvidence = evidence;
  value.binding.capsuleDigest = digestRailgunPrivateCapsule(evidence.capsule);
  value.preparation.witness.row = JSON.parse(JSON.stringify(evidence.row));
  value.preparation.witness.rowSha256 = sha(JSON.stringify(evidence.row));
  if (type === 'Transact') value.preparation.creator.hash = evidence.capsule.noteHash;
  return value;
}
test.each(['Shield', 'Transact'])(
  'partial %s data uses real v2/mixed receipt validators without saved output',
  (type) => {
    const v = partialInput(type);
    const result = normalize(v);
    expect(result).toEqual(v);
    expect(result.preparation.ownEvidence.row.commitments).toEqual([
      v.preparation.ownEvidence.capsule.preparation.expected.changeCommitment,
      v.preparation.ownEvidence.capsule.preparation.expected.unshieldCommitment,
    ]);
    expect(result.descriptor.instanceId).not.toBe(
      result.preparation.ownEvidence.capsule.selection.recipient
    );
    expect(Object.isFrozen(result.preparation.ownEvidence.capsule)).toBe(true);
    expect(result).not.toHaveProperty('blindedCommitmentsOut');
    expect(result.preparation).not.toHaveProperty('listProofs');
  }
);
test.each([
  'order',
  'gross',
  'recipient',
  'position',
  'capsule-version',
  'witness-row',
  'saved-change',
])('partial %s substitution refuses without utility admission', (fault) => {
  const v = partialInput();
  const e = v.preparation.ownEvidence;
  if (fault === 'order') e.row.commitments.reverse();
  if (fault === 'gross') e.row.unshield.value = '401';
  if (fault === 'recipient') e.row.unshield.toAddress = '0x' + '21'.repeat(20);
  if (fault === 'position') e.row.utxoBatchStartPositionOut++;
  if (fault === 'capsule-version') e.capsule.version = 1;
  if (fault === 'witness-row') v.preparation.witness.row.commitments.reverse();
  if (fault === 'saved-change') v.preparation.expectedBlindedChange = hex(9);
  expect(() => normalize(v)).toThrow();
});
test.each([1n, FIELD - 1n])(
  'recovered combined output preserves exact leading-zero/nonzero marker %s',
  (marker) => {
    const value = { blindedCommitmentsOut: [hex(2)], railgunTxidIfHasUnshield: hex(marker) };
    expect(output(value)).toEqual(value);
    expect(Object.isFrozen(output(value))).toBe(true);
  }
);
test.each([hex(0), hex(FIELD), '0x01', 1, '0X' + '0'.repeat(63) + '1'])(
  'recovered combined marker rejects %p',
  (marker) => {
    expect(() =>
      output({ blindedCommitmentsOut: [hex(2)], railgunTxidIfHasUnshield: marker })
    ).toThrow();
  }
);
