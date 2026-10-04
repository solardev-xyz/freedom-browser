/** Detached keyless TXID/path and unshield-preimage verification. No account,
 * store, network, wallet secret or spending authority is available to this job.
 */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { createHash } = require('crypto');
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  assert.ok(!signal.aborted);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), ['archive', 'bindingDigest', 'state', 'witness']);
  assert.match(input.bindingDigest, /^[0-9a-f]{64}$/);
  const witness = require('./railgun-txid-note-witness').normalizeRailgunTxidWitness(
    input.witness,
    input.state
  );
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  assert.ok(!signal.aborted);
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
    hashPair: (a, b) => poseidonHex([a, b]),
    transactionHash: createRailgunTransactionWithHash,
    verificationHash: calculateRailgunTransactionVerificationHash,
    zeroNodes: require('./railgun-public-records').ZERO_NODES,
  });
  projection.verifyWitness(input.state, witness);
  const unshield = witness.row.unshield;
  if (unshield) {
    const partial = witness.row.commitments.length === 2;
    assert.ok(partial || witness.row.commitments.length === 1);
    if (partial) {
      // Only the first commitment is an ordinary change leaf. The final
      // unshield commitment shares its TXID but has no UTXO-tree position.
      assert.equal(witness.row.nullifiers.length, 1);
      assert.ok(witness.row.utxoTreeOut < 65536);
      assert.ok(witness.row.utxoBatchStartPositionOut < 65536);
      assert.deepEqual(unshield.tokenData, {
        tokenType: 0,
        tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
        tokenSubID: '0x' + '0'.repeat(64),
      });
      assert.ok(BigInt(unshield.value) > 0n);
    } else {
      assert.equal(witness.row.utxoTreeOut, 99999);
      assert.equal(witness.row.utxoBatchStartPositionOut, 99999);
    }
    const { getNoteHash, assertValidNoteToken } = require(path.join(root, 'note/note-util'));
    const value = BigInt(unshield.value);
    assertValidNoteToken(unshield.tokenData, value);
    const commitment = getNoteHash(unshield.toAddress, unshield.tokenData, value);
    assert.equal(
      '0x' + commitment.toString(16).padStart(64, '0'),
      witness.row.commitments[partial ? 1 : 0]
    );
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: {
            inputSha256: createHash('sha256').update(text).digest('hex'),
            bindingDigest: input.bindingDigest,
            railgunTxid: witness.railgunTxid,
            pathVerified: true,
            unshieldCommitmentVerified: !!unshield,
            sourceAuthenticated: false,
            rootAccepted: false,
            spendingEnabled: false,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  assert.ok(!signal.aborted);
};
