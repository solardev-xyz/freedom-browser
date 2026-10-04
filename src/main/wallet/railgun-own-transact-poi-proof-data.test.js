const {
  normalizeRailgunOwnPoiProofInput: normalize,
  expectedRailgunOwnPoiFields: expected,
} = require('./railgun-own-poi-proof-data');
// Structural fixture only: real capsule/receipt/row/schema checks, synthetic
// Merkle fields. It does not establish cryptographic path/proof correctness.
function makeTransactProofFixture(unshield = false) {
  const h = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const hash = (v) =>
    require('crypto').createHash('sha256').update(JSON.stringify(v)).digest('hex');
  const evidence = require('../../../scripts/fixtures/railgun-own-txid-data').sample(unshield);
  const descriptor = {
    walletId: evidence.capsule.walletId,
    instanceId: '0zk1' + 'q'.repeat(123),
    masterPublicKey: h(3).slice(2),
    spendingPublicKey: [h(4).slice(2), h(5).slice(2)],
    viewingPublicKey: h(6).slice(2),
    accountIndex: 0,
  };
  const creator = {
    type: 'Transact',
    tree: evidence.capsule.selection.tree,
    position: evidence.capsule.selection.position,
    hash: evidence.capsule.noteHash,
    ciphertext: {
      ciphertext: [h(7), h(8), h(9), h(10)],
      blindedSenderViewingKey: h(11),
      blindedReceiverViewingKey: h(12),
      annotationData: '0x',
      memo: '0x',
    },
  };
  const state = { count: 2, root: h(15).slice(2), transcript: h(16).slice(2), breaks: [] };
  const witnessFor = (row, index) => ({
    row: JSON.parse(JSON.stringify(row)),
    leaf: h(17 + index).slice(2),
    railgunTxid: h(19 + index).slice(2),
    rowSha256: hash(row),
    index,
    elements: Array(16).fill(h(0).slice(2)),
    root: state.root,
    checkpointIndex: 1,
    transcript: state.transcript,
    continuity: require('./railgun-txid-omissions').classifyRailgunTxidContinuity(1, []),
    globalTxidCompleteness: false,
  });
  const blockNumber = evidence.row.blockNumber - 1;
  const creatorRow = {
    version: 'V2',
    graphID: h(blockNumber) + h(2).slice(2) + h(0).slice(2),
    commitments: [creator.hash],
    nullifiers: [h(700)],
    boundParamsHash: h(701),
    blockNumber,
    txid: h(706).slice(2),
    timestamp: blockNumber,
    utxoTreeIn: creator.tree,
    utxoTreeOut: creator.tree,
    utxoBatchStartPositionOut: creator.position,
    verificationHash: evidence.row.verificationHash,
  };
  const note = {
    type: 'Transact',
    tree: creator.tree,
    position: creator.position,
    hash: creator.hash,
    txid: h(706),
    blockNumber,
  };
  const input = {
    archive: '/engine.asar',
    proverArchive: '/prover.asar',
    artifactDirectory: '/artifacts',
    descriptor,
    preparation: { creator, ownEvidence: evidence, state, witness: witnessFor(evidence.row, 1) },
    listProofs: [
      {
        leaf: h(21).slice(2),
        root: h(22).slice(2),
        indices: h(0).slice(2),
        elements: Array(16).fill(h(0).slice(2)),
      },
    ],
  };
  const selectorInput =
    require('./railgun-poi-transact-selector-data').prepareRailgunPoiTransactSelectorInput({
      archive: input.archive,
      descriptor,
      capsule: evidence.capsule,
      creator,
    });
  return {
    input,
    selector: {
      blindedCommitment: h(21),
      bindingDigest: selectorInput.bindingDigest,
      inputSha256: hash(selectorInput),
    },
    creatorProvenance: {
      note,
      noteWitness: {
        note,
        outputIndex: 0,
        witness: witnessFor(creatorRow, 0),
        ownershipVerified: false,
        eventCoverageVerified: false,
        rootAccepted: false,
        spendingEnabled: false,
      },
      verification: {
        utilityExitObserved: true,
        pathVerified: true,
        suppliedCreatorEventsMatched: true,
        coverage: { matchedRows: 1, knownOmissions: 0 },
      },
    },
  };
}

test.each([false, true])(
  'actual structural normalization accepts Transact transfer/unshield %s',
  (unshield) => {
    const { input } = makeTransactProofFixture(unshield);
    const result = normalize(input),
      fields = expected(result);
    expect(result).toEqual(input);
    expect(result.preparation.creator.type).toBe('Transact');
    expect(fields.outputCount).toBe(unshield ? 0 : 1);
    expect(fields.railgunTxidIfHasUnshield).toBe(
      unshield ? '0x' + input.preparation.witness.railgunTxid : '0x00'
    );
    expect(Object.isFrozen(result.preparation.creator.ciphertext.ciphertext)).toBe(true);
    expect(Object.isFrozen(result.preparation.ownEvidence.receipt.logs)).toBe(true);
    input.preparation.creator.ciphertext.ciphertext[0] = '0x' + '99'.repeat(32);
    input.descriptor.accountIndex++;
    expect(result.descriptor.accountIndex).toBe(0);
    expect(result.preparation.creator.ciphertext.ciphertext[0]).not.toBe(
      input.preparation.creator.ciphertext.ciphertext[0]
    );
  }
);
test('normalization agrees with selector canonical bytes despite incoming property order', () => {
  const fixture = makeTransactProofFixture();
  fixture.input.descriptor = Object.fromEntries(Object.entries(fixture.input.descriptor).reverse());
  fixture.input.preparation.creator = Object.fromEntries(
    Object.entries(fixture.input.preparation.creator).reverse()
  );
  const result = normalize(fixture.input);
  const selector =
    require('./railgun-poi-transact-selector-data').prepareRailgunPoiTransactSelectorInput({
      archive: result.archive,
      descriptor: result.descriptor,
      capsule: result.preparation.ownEvidence.capsule,
      creator: result.preparation.creator,
    });
  expect(selector.bindingDigest).toBe(fixture.selector.bindingDigest);
  expect(
    require('crypto').createHash('sha256').update(JSON.stringify(selector)).digest('hex')
  ).toBe(fixture.selector.inputSha256);
});
test.each([
  'unknown-type',
  'missing-type',
  'descriptor-key',
  'wrong-wallet',
  'sent-only',
  'creator-tree',
  'creator-position',
  'creator-hash',
  'ciphertext-size',
  'ciphertext-extra',
  'memo-odd',
  'annotation-oversize',
  'input-injection',
  'preparation-injection',
  'capsule-path',
  'capsule-commitment',
  'row-commitment',
  'row-nullifier',
  'receipt',
  'transaction',
  'witness-row',
  'witness-hash',
  'witness-index',
  'witness-root',
  'witness-checkpoint',
  'witness-transcript',
  'witness-path',
  'proof-depth',
  'proof-index',
  'proof-field',
  'proof-count',
])('actual Transact normalizer refuses malformed %s', (fault) => {
  const { input: v } = makeTransactProofFixture(),
    p = v.preparation;
  const other = '0x' + '00'.repeat(31) + '99';
  if (fault === 'unknown-type') p.creator.type = 'Unknown';
  if (fault === 'missing-type') delete p.creator.type;
  if (fault === 'descriptor-key') v.descriptor.viewingKey = 'private-sentinel';
  if (fault === 'wrong-wallet') v.descriptor.walletId = 'a'.repeat(64);
  if (fault === 'sent-only') v.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
  if (fault === 'creator-tree') p.creator.tree++;
  if (fault === 'creator-position') p.creator.position++;
  if (fault === 'creator-hash') p.creator.hash = other;
  if (fault === 'ciphertext-size') p.creator.ciphertext.ciphertext.pop();
  if (fault === 'ciphertext-extra') p.creator.ciphertext.legacy = true;
  if (fault === 'memo-odd') p.creator.ciphertext.memo = '0x1';
  if (fault === 'annotation-oversize')
    p.creator.ciphertext.annotationData = '0x' + '11'.repeat(3521);
  if (fault === 'input-injection') v.output = {};
  if (fault === 'preparation-injection') p.creatorProvenance = {};
  if (fault === 'capsule-path') p.ownEvidence.capsule.pathElements.pop();
  if (fault === 'capsule-commitment') p.ownEvidence.capsule.noteHash = other;
  if (fault === 'row-commitment') p.ownEvidence.row.commitments.push(other);
  if (fault === 'row-nullifier') p.ownEvidence.row.nullifiers.push(other);
  if (fault === 'receipt') p.ownEvidence.receipt.status = '0x0';
  if (fault === 'transaction') p.ownEvidence.transaction.hash = other;
  if (fault === 'witness-row') p.witness.row.commitments[0] = other;
  if (fault === 'witness-hash') p.witness.rowSha256 = '0'.repeat(64);
  if (fault === 'witness-index') p.witness.index = 2;
  if (fault === 'witness-root') p.witness.root = other.slice(2);
  if (fault === 'witness-checkpoint') p.witness.checkpointIndex = 0;
  if (fault === 'witness-transcript') p.witness.transcript = other.slice(2);
  if (fault === 'witness-path') p.witness.elements.pop();
  if (fault === 'proof-depth') v.listProofs[0].elements.pop();
  if (fault === 'proof-index') v.listProofs[0].indices = '1'.padEnd(64, '0');
  if (fault === 'proof-field') v.listProofs[0].root = 'f'.repeat(64);
  if (fault === 'proof-count') v.listProofs.push(v.listProofs[0]);
  expect(() => normalize(v)).toThrow();
});
test.each([
  [0, 3520, true],
  [1760, 1760, true],
  [0, 3521, false],
  [1761, 1760, false],
])('Transact event ABI bounds annotation=%i memo=%i accepted=%s', (annotation, memo, accepted) => {
  const { input } = makeTransactProofFixture();
  input.preparation.creator.ciphertext.annotationData = '0x' + '11'.repeat(annotation);
  input.preparation.creator.ciphertext.memo = '0x' + '22'.repeat(memo);
  if (accepted) expect(normalize(input).preparation.creator).toEqual(input.preparation.creator);
  else expect(() => normalize(input)).toThrow();
});
