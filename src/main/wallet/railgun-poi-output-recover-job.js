/** One viewing-only output reconstruction in a fresh utility. The saved blinded
 * output is never an input. No proof generation, artifacts, network or stores.
 */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const {
  normalizeRailgunPoiOutputRecoveryInput,
  normalizeRailgunRecoveredPoiOutput,
} = require('./railgun-poi-output-recovery-data');
const { getRailgunOwnPoiShape } = require('./railgun-own-poi-shape-data');
const { verifyRailgunEngineRuntime } = require('./railgun-engine-runtime');
let attempted = false;
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  let key;
  try {
    assert.equal(attempted, false);
    attempted = true;
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
    const input = normalizeRailgunPoiOutputRecoveryInput(JSON.parse(text));
    const inputSha256 = createHash('sha256').update(text).digest('hex');
    const archive = verifyRailgunEngineRuntime(input.archive);
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
    const { creator, ownEvidence, state, witness } = input.preparation;
    // Fresh path crypto is checked before the only credential request. Original
    // saved proof roots/index are deliberately absent and are not revalidated here.
    projection.verifyWitness(state, witness);
    const outputShape = getRailgunOwnPoiShape(ownEvidence.capsule);
    const expected = ownEvidence.capsule.preparation.expected;
    assert.deepEqual(
      witness.row.commitments,
      outputShape.hasUnshield
        ? [expected.changeCommitment, expected.unshieldCommitment]
        : [expected.commitment]
    );
    active();
    const bytes = await requestKey(
      JSON.stringify({
        id: 1,
        method: 'key',
        purpose: 'poi-output-recover',
        inputSha256,
      })
    );
    assert.ok(bytes instanceof Uint8Array);
    key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(key.length, 32);
    active();
    let output;
    try {
      const notes = await require('./railgun-poi-reconstruct').reconstructRailgunPoiNotes({
        archive,
        descriptor: input.descriptor,
        viewingKey: key,
        capsule: ownEvidence.capsule,
        creator,
        signal,
      });
      active();
      assert.equal(notes.npksOut.length, 1);
      assert.equal(notes.valuesOut.length, 1);
      assert.ok(notes.valuesOut[0] > 0n);
      const position = imp('poi/global-tree-position').getGlobalTreePosition(
        witness.row.utxoTreeOut,
        witness.row.utxoBatchStartPositionOut
      );
      output = normalizeRailgunRecoveredPoiOutput({
        blindedCommitmentsOut: [
          imp('poi/blinded-commitment').BlindedCommitment.getForShieldOrTransact(
            witness.row.commitments[0],
            notes.npksOut[0],
            position
          ),
        ],
        railgunTxidIfHasUnshield: outputShape.hasUnshield ? '0x' + witness.railgunTxid : '0x00',
      });
    } finally {
      key.fill(0);
    }
    active();
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 2,
            method: 'result',
            value: {
              recoveryInputSha256: inputSha256,
              payloadSha256: input.binding.payloadSha256,
              output,
              engineSha256: require('./railgun-engine-manifest.json').sha256,
              sourceAuthenticated: false,
              proofVerified: false,
              membershipAuthenticated: false,
              rootAccepted: false,
              disclosureEnabled: false,
              spendingEnabled: false,
              guards,
            },
          })
        )
      ),
      { id: 2, value: null }
    );
    active();
  } catch {
    throw Object.assign(new Error('Railgun POI output recovery unavailable'), {
      code: 'RAILGUN_POI_OUTPUT_RECOVERY_REFUSED',
    });
  } finally {
    key?.fill(0);
  }
};
