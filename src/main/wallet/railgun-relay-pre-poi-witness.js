/** Utility-only private witness assembly. Never broker/serialize this complete
 * result: inputs contain private note/key material. A future fixed job may
 * project the binding/public signals only. No proving or authority is issued.
 */
const assert = require('assert/strict');
const path = require('path');
const { shape, freeze } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const { assertRailgunRelaySignal } = require('./railgun-relay-wallet-data');
const { REQUIRED_LIST, verifyPoiEvent, verifyPoiMembership } = require('./railgun-poi-records');
const hex = (v) => BigInt(v).toString(16).padStart(64, '0');
async function assemble(options, local) {
  try {
    shape(options, [
      'archive',
      'wallet',
      'descriptor',
      'checkpoint',
      'scan',
      'draftText',
      'history',
      'signal',
    ]);
    const { archive, wallet, descriptor, checkpoint, scan, draftText, signal } = options;
    const active = () => assertRailgunRelaySignal(signal);
    active();
    assert.ok(typeof draftText === 'string' && Buffer.byteLength(draftText) <= 65536);
    const draft = normalizeRailgunRelayDraftCapsule(JSON.parse(draftText));
    assert.equal(JSON.stringify(draft.data), draftText);
    const history = normalizeRailgunRelayPoiHistory(options.history);
    assert.equal(history.data.draftDigest, draft.digest);
    verifyPoiEvent([history.data.event], history.data.note, history.data.proof);
    const core = require('./railgun-relay-reconstruct');
    const notes = await (
      local ? core.reconstructRailgunRelayLocalWitness : core.reconstructRailgunRelayWitness
    )({
      archive,
      wallet,
      descriptor,
      checkpoint,
      scan,
      draftText,
      signal,
    });
    active();
    assert.deepEqual(notes.publicReconstruction, {
      draftDigest: draft.digest,
      expectedHash: draft.data.intent.expectedHash,
      recoveredOutputs: 2,
    });
    const { prePoi, witness } = notes;
    const { selection, intent } = draft.data;
    assert.equal(prePoi.utxoTreeIn, selection.tree);
    assert.deepEqual(prePoi.utxoPositionsIn, [selection.position]);
    assert.equal(prePoi.inputNoteType, history.data.note.type);
    assert.deepEqual(prePoi.valuesIn, [BigInt(intent.context.inputAmount)]);
    assert.deepEqual(prePoi.valuesOut, [
      BigInt(intent.context.feeAmount),
      BigInt(intent.context.selfAmount),
    ]);
    assert.equal(prePoi.npksOut.length, 2);
    assert.equal(witness.txidVersion, 'V2_PoseidonMerkle');
    const pub = witness.publicInputs;
    assert.equal(pub.merkleRoot, BigInt(intent.expected.merkleRoot));
    assert.equal(pub.boundParamsHash, BigInt(intent.expected.boundParamsHash));
    assert.deepEqual(pub.nullifiers, [BigInt(intent.expected.nullifier)]);
    assert.deepEqual(pub.commitmentsOut, [
      BigInt(intent.expected.feeCommitment),
      BigInt(intent.expected.selfCommitment),
    ]);
    const verified = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
    const imp = (name) =>
      require(path.join(verified, 'node_modules/@railgun-community/engine/dist', name));
    const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
    await initPoseidonPromise;
    active();
    const { getGlobalTreePosition, getGlobalTreePositionPreTransactionPOIProof } = imp(
      'poi/global-tree-position'
    );
    const { BlindedCommitment } = imp('poi/blinded-commitment');
    const inputBlind = BlindedCommitment.getForShieldOrTransact(
      draft.data.noteHash,
      prePoi.inputNpk,
      getGlobalTreePosition(selection.tree, selection.position)
    );
    assert.equal(inputBlind, history.data.note.blindedCommitment);
    verifyPoiMembership([history.data.proof], [history.data.note], (a, b) =>
      hex(poseidon([BigInt('0x' + a), BigInt('0x' + b)]))
    );
    const globalPosition = getGlobalTreePositionPreTransactionPOIProof();
    assert.equal(globalPosition, 199999n * 65536n + 199999n);
    const { getRailgunTransactionIDFromBigInts, getRailgunTxidLeafHash } = imp(
      'transaction/railgun-txid'
    );
    const txid = getRailgunTransactionIDFromBigInts(
      pub.nullifiers,
      pub.commitmentsOut,
      pub.boundParamsHash
    );
    const leaf = getRailgunTxidLeafHash(txid, BigInt(selection.tree), globalPosition);
    const txidPath = imp('merkletree/merkle-proof').createDummyMerkleProof(leaf);
    assert.equal(txidPath.leaf, leaf);
    assert.equal(txidPath.indices, hex(0n));
    assert.deepEqual(txidPath.elements, Array(16).fill(hex(0n)));
    assert.equal(imp('merkletree/merkle-proof').verifyMerkleProof(txidPath), true);
    const blindedOut = pub.commitmentsOut.map((commitment, index) =>
      BlindedCommitment.getForShieldOrTransact(
        '0x' + hex(commitment),
        prePoi.npksOut[index],
        globalPosition + BigInt(index)
      )
    );
    const binding = normalizeRailgunRelayPrePoiBinding({
      schema: 'railgun-relay-pre-poi-binding-v1',
      draftDigest: draft.digest,
      chainId: 11155111,
      txidVersion: 'V2_PoseidonMerkle',
      listKey: REQUIRED_LIST,
      listWitness: history.data.proof,
      txidLeafHash: leaf,
      txidMerkleroot: txidPath.root,
      blindedCommitmentsOut: blindedOut,
    });
    const inputs = {
      anyRailgunTxidMerklerootAfterTransaction: txidPath.root,
      boundParamsHash: '0x' + hex(pub.boundParamsHash),
      nullifiers: pub.nullifiers.map((v) => '0x' + hex(v)),
      commitmentsOut: pub.commitmentsOut.map((v) => '0x' + hex(v)),
      spendingPublicKey: [...prePoi.spendingPublicKey],
      nullifyingKey: prePoi.nullifyingKey,
      token: prePoi.token,
      randomsIn: [...prePoi.randomsIn],
      valuesIn: [...prePoi.valuesIn],
      utxoPositionsIn: [...prePoi.utxoPositionsIn],
      utxoTreeIn: prePoi.utxoTreeIn,
      npksOut: [...prePoi.npksOut],
      valuesOut: [...prePoi.valuesOut],
      utxoBatchGlobalStartPositionOut: globalPosition,
      railgunTxidIfHasUnshield: '0x00',
      railgunTxidMerkleProofIndices: txidPath.indices,
      railgunTxidMerkleProofPathElements: [...txidPath.elements],
      poiMerkleroots: [history.data.proof.root],
      poiInMerkleProofIndices: [history.data.proof.indices],
      poiInMerkleProofPathElements: [[...history.data.proof.elements]],
    };
    const zero = imp('models/merkletree-types').MERKLE_ZERO_VALUE_BIGINT;
    const publicSignals = [
      ...blindedOut.map(BigInt),
      0n,
      BigInt('0x' + txidPath.root),
      0n,
      BigInt('0x' + history.data.proof.root),
      zero,
      zero,
    ];
    active();
    return freeze({ witness, inputs, binding, publicSignals, historyDigest: history.digest });
  } catch {
    throw Object.assign(new Error('Railgun relay pre-transaction witness refused'), {
      code: 'RAILGUN_RELAY_PRE_POI_WITNESS_REFUSED',
    });
  }
}
module.exports = {
  prepareRailgunRelayPrePoiWitness: (options) => assemble(options, false),
  restoreRailgunRelayPrePoiWitness: (options) => assemble(options, true),
};
