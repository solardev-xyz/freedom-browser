/** Utility-only POI witness assembly. Inputs describe observations, not live
 * authorization. Private return fields must never leave the viewing utility.
 * Derive output positions and marker from the compared row/receipt, never from
 * caller-supplied POI public inputs. No proving, key acquisition or disclosure.
 */
const assert = require('assert/strict');
const path = require('path');
const { normalizeRailgunTxidWitness } = require('./railgun-txid-note-witness');
const { matchRailgunOwnTxid } = require('./railgun-own-txid');
const { reconstructRailgunPoiNotes } = require('./railgun-poi-reconstruct');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (v) => v.toString(16).padStart(64, '0');
const shape = (v, keys) => assert.deepEqual(Object.keys(v).sort(), [...keys].sort());
function field(value) {
  assert.equal(typeof value, 'string');
  assert.match(value, /^(?:0x)?[0-9a-f]{64}$/);
  const bare = value.replace(/^0x/, '');
  assert.ok(BigInt('0x' + bare) < FIELD);
  return bare;
}
function membership(value) {
  shape(value, ['leaf', 'root', 'indices', 'elements']);
  const indices = field(value.indices);
  assert.ok(BigInt('0x' + indices) < 65536n);
  assert.ok(Array.isArray(value.elements) && value.elements.length === 16);
  return {
    leaf: field(value.leaf),
    root: field(value.root),
    indices,
    elements: value.elements.map(field),
  };
}
async function prepareRailgunPoiWitness(options) {
  let key;
  try {
    shape(options, [
      'archive',
      'descriptor',
      'viewingKey',
      'creator',
      'ownEvidence',
      'state',
      'witness',
      'listProofs',
      'signal',
    ]);
    const { signal } = options;
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    assert.ok(options.viewingKey instanceof Uint8Array && options.viewingKey.byteLength === 32);
    const text = JSON.stringify({
      descriptor: options.descriptor,
      creator: options.creator,
      ownEvidence: options.ownEvidence,
      state: options.state,
      witness: options.witness,
      listProofs: options.listProofs,
    });
    assert.ok(Buffer.byteLength(text) <= 192 * 1024);
    const input = JSON.parse(text);
    shape(input.ownEvidence, ['capsule', 'record', 'transaction', 'receipt', 'row']);
    const matched = matchRailgunOwnTxid(input.ownEvidence);
    const witness = normalizeRailgunTxidWitness(input.witness, input.state);
    assert.deepEqual(witness.row, matched.row);
    assert.ok(Array.isArray(input.listProofs) && input.listProofs.length === 1);
    const proofs = input.listProofs.map(membership);
    key = Buffer.from(options.viewingKey);
    const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(options.archive);
    const imp = (name) =>
      require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
    const { initPoseidonPromise, poseidonHex } = imp('utils/poseidon');
    await initPoseidonPromise;
    active();
    const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = imp(
      'transaction/railgun-txid'
    );
    const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('./railgun-public-records').ZERO_NODES,
    });
    projection.verifyWitness(input.state, witness);
    const notes = await reconstructRailgunPoiNotes({
      archive,
      descriptor: input.descriptor,
      viewingKey: key,
      capsule: input.ownEvidence.capsule,
      creator: input.creator,
      signal,
    });
    active();
    const { row } = witness;
    assert.ok(['unshield', 'shielded', 'partial-unshield'].includes(matched.output.kind));
    const partial = matched.output.kind === 'partial-unshield';
    const unshield = partial || matched.output.kind === 'unshield';
    const ordinaryOutput = partial || !unshield;
    assert.equal(row.nullifiers.length, 1);
    assert.equal(row.commitments.length, partial ? 2 : 1);
    assert.equal(row.utxoTreeIn, notes.utxoTreeIn);
    assert.equal(
      row.nullifiers[0],
      '0x' +
        hex(
          imp('note/transact-note').TransactNote.getNullifier(
            notes.nullifyingKey,
            notes.utxoPositionsIn[0]
          )
        )
    );
    const { getGlobalTreePosition } = imp('poi/global-tree-position');
    const { BlindedCommitment } = imp('poi/blinded-commitment');
    const blindedIn = [
      BlindedCommitment.getForShieldOrTransact(
        input.ownEvidence.capsule.noteHash,
        notes.inputNpk,
        getGlobalTreePosition(notes.utxoTreeIn, notes.utxoPositionsIn[0])
      ),
    ];
    assert.equal(proofs[0].leaf, blindedIn[0].slice(2));
    assert.equal(imp('merkletree/merkle-proof').verifyMerkleProof(proofs[0]), true);
    assert.equal(Object.hasOwn(row, 'unshield'), unshield);
    assert.equal(notes.npksOut.length, ordinaryOutput ? 1 : 0);
    assert.equal(notes.valuesOut.length, ordinaryOutput ? 1 : 0);
    if (ordinaryOutput) assert.ok(notes.valuesOut[0] > 0n);
    const globalOut = getGlobalTreePosition(row.utxoTreeOut, row.utxoBatchStartPositionOut);
    const blindedOut = ordinaryOutput
      ? [BlindedCommitment.getForShieldOrTransact(row.commitments[0], notes.npksOut[0], globalOut)]
      : [];
    // The circuit accepts either zero or TXID regardless of transaction kind.
    // The application must derive this marker; there is no override parameter.
    const marker = unshield ? BlindedCommitment.getForUnshield('0x' + witness.railgunTxid) : '0x00';
    const inputs = {
      anyRailgunTxidMerklerootAfterTransaction: witness.root,
      boundParamsHash: row.boundParamsHash,
      nullifiers: [...row.nullifiers],
      commitmentsOut: [...row.commitments],
      spendingPublicKey: notes.spendingPublicKey,
      nullifyingKey: notes.nullifyingKey,
      token: notes.token,
      randomsIn: notes.randomsIn,
      valuesIn: notes.valuesIn,
      utxoPositionsIn: notes.utxoPositionsIn,
      utxoTreeIn: notes.utxoTreeIn,
      npksOut: notes.npksOut,
      valuesOut: notes.valuesOut,
      utxoBatchGlobalStartPositionOut: globalOut,
      railgunTxidIfHasUnshield: marker,
      railgunTxidMerkleProofIndices: hex(BigInt(witness.index)),
      railgunTxidMerkleProofPathElements: [...witness.elements],
      poiMerkleroots: proofs.map((v) => v.root),
      poiInMerkleProofIndices: proofs.map((v) => v.indices),
      poiInMerkleProofPathElements: proofs.map((v) => [...v.elements]),
    };
    assert.equal(
      imp('merkletree/merkle-proof').verifyMerkleProof({
        leaf: witness.leaf,
        root: witness.root,
        indices: inputs.railgunTxidMerkleProofIndices,
        elements: inputs.railgunTxidMerkleProofPathElements,
      }),
      true
    );
    const expectedPublicInputs = {
      blindedCommitmentsOut: [...blindedOut.map(BigInt), ...Array(3 - blindedOut.length).fill(0n)],
      railgunTxidIfHasUnshield: BigInt(marker),
      anyRailgunTxidMerklerootAfterTransaction: BigInt('0x' + witness.root),
      poiMerkleroots: [
        BigInt('0x' + proofs[0].root),
        ...Array(2).fill(imp('models/merkletree-types').MERKLE_ZERO_VALUE_BIGINT),
      ],
    };
    active();
    return {
      inputs,
      blindedIn,
      blindedOut,
      expectedPublicInputs,
      listKey: require('./railgun-poi-records').REQUIRED_LIST,
      txidLeafIndex: witness.index,
      txidRootIndex: witness.checkpointIndex,
      sourceAuthenticated: false,
      membershipAuthenticated: false,
      rootAccepted: false,
      disclosureEnabled: false,
      spendingEnabled: false,
    };
  } catch {
    throw Object.assign(new Error('Railgun POI witness unavailable'), {
      code: 'RAILGUN_POI_WITNESS_REFUSED',
    });
  } finally {
    key?.fill(0);
  }
}
module.exports = { prepareRailgunPoiWitness };
