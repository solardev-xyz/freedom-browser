/** Offline actual-engine qualification of bounded TXID projection and paths.
 * The in-memory store simulates page persistence only; it is not an enrolled
 * account database and grants no account, POI or spend authority.
 */
const assert = require('assert/strict'),
  path = require('path');
const { createRequire } = require('module');
async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const r = createRequire(path.join(archive, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const { verifyMerkleProof } = require(path.join(root, 'merkletree/merkle-proof'));
  const projection = () =>
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  assert.ok(
    Number.isSafeInteger(input.checkpoint.index) &&
      input.checkpoint.index >= 0 &&
      input.checkpoint.index < 5000
  );
  assert.ok(Number.isSafeInteger(input.pages) && input.pages > 0 && input.pages <= 50);
  let sequence = 0,
    state = projection().empty(),
    replayed = false;
  const values = new Map(),
    samples = new Map();
  const read = async (key) => values.get(key) ?? null;
  for (let page = 0; page < input.pages && state.count <= input.checkpoint.index; page++) {
    assert.ok(!signal.aborted);
    const id = ++sequence;
    const reply = JSON.parse(await request(JSON.stringify({ id, method: 'page', page })));
    assert.equal(reply.id, id);
    const rows = reply.value.transactions.slice(0, input.checkpoint.index + 1 - state.count);
    for (let n = 0; n < rows.length; n++) {
      const index = state.count + n;
      if ([0, 4187, 4188, input.checkpoint.index].includes(index))
        samples.set(index, createRailgunTransactionWithHash(rows[n]).railgunTxid);
    }
    const result = await projection().append(state, rows, read);
    if (page === 1) {
      assert.deepEqual(await projection().append(state, rows, read), result);
      replayed = true;
    }
    for (const { key, value } of result.writes) values.set(key, value);
    state = JSON.parse(values.get('txid:state'));
  }
  assert.equal(state.count, input.checkpoint.index + 1);
  assert.equal(state.root, input.checkpoint.root);
  const proofs = [],
    noteWitnesses = [];
  for (const [index, txid] of samples) {
    const proof = await projection().witness(state, txid, read);
    assert.equal(proof.index, index);
    assert.equal(proof.root, input.checkpoint.root);
    assert.equal(
      verifyMerkleProof({
        leaf: proof.leaf,
        elements: proof.elements,
        indices: index.toString(16).padStart(64, '0'),
        root: proof.root,
      }),
      true
    );
    proofs.push({
      index,
      railgunTxid: txid,
      rowSha256: proof.rowSha256,
      leaf: proof.leaf,
      elements: proof.elements,
      root: proof.root,
      checkpointIndex: proof.checkpointIndex,
    });
    const inserted = proof.row.commitments.length - (proof.row.unshield ? 1 : 0);
    if (inserted > 0) {
      const note = {
        type: 'Transact',
        txid: '0x' + proof.row.txid,
        hash: proof.row.commitments[inserted - 1],
        tree: proof.row.utxoTreeOut,
        position: proof.row.utxoBatchStartPositionOut + inserted - 1,
        blockNumber: proof.row.blockNumber,
      };
      const { findRailgunNoteTxidWitness } = require(
        '../../src/main/wallet/railgun-txid-note-witness'
      );
      const start = performance.now();
      const found = await findRailgunNoteTxidWitness({
        state,
        note,
        read,
        projection: projection(),
      });
      assert.deepEqual(found.witness, proof);
      assert.equal(found.outputIndex, inserted - 1);
      assert.equal(found.spendingEnabled, false);
      if (noteWitnesses.length === 0) {
        await assert.rejects(() =>
          findRailgunNoteTxidWitness({
            state,
            note: { ...note, hash: '0x' + '0'.repeat(64) },
            read,
            projection: projection(),
          })
        );
      }
      noteWitnesses.push({ matched: true, elapsedMs: Math.round(performance.now() - start) });
    }
  }
  const corrupted = { ...state, root: '0'.repeat(64) };
  await assert.rejects(() => projection().witness(corrupted, samples.values().next().value, read));
  const value = {
    count: state.count,
    root: state.root,
    expectedRoot: input.checkpoint.root,
    matches: true,
    replayed,
    coldProjectionPerPage: true,
    durableAccountStorageQualified: false,
    continuity:
      require('../../src/main/wallet/railgun-txid-omissions').classifyRailgunTxidContinuity(
        state.count - 1,
        state.breaks
      ),
    verificationBreaks: state.breaks,
    transcript: state.transcript,
    proofs,
    noteWitnesses,
    wrongNoteHashRefused: noteWitnesses.length > 0,
    corruptRootRefused: true,
    records: values.size,
    guards: guardReport(),
    inventory: require('../../src/main/wallet/railgun-engine-manifest.json').inventory.sha256,
  };
  assert.equal(value.guards.attempts, 0);
  const id = sequence + 1;
  assert.deepEqual(JSON.parse(await request(JSON.stringify({ id, method: 'result', value }))), {
    id,
    value: null,
  });
}
module.exports = { run };
