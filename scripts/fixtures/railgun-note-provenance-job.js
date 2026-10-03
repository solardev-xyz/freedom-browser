/** Synthetic public TXID evidence for detached-verifier qualification only. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
exports.run = async function run(text, { request, signal, guardReport }) {
  const { archive } = JSON.parse(text);
  const verified =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const r = createRequire(path.join(verified, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const projection =
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
  let previous;
  const rows = Array.from({ length: 3 }, (_, i) => {
    const nullifiers = [hex(10 + i)];
    previous = calculateRailgunTransactionVerificationHash(previous, nullifiers[0]);
    return {
      version: 'V2',
      graphID: hex(i + 1) + '0'.repeat(128),
      commitments: [hex(20 + i)],
      nullifiers,
      boundParamsHash: hex(30 + i),
      blockNumber: i + 1,
      txid: hex(40 + i).slice(2),
      timestamp: i + 1,
      utxoTreeIn: 0,
      utxoTreeOut: 0,
      utxoBatchStartPositionOut: i,
      verificationHash: previous,
    };
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const { state, writes } = await projection.append(projection.empty(), rows, read);
  writes.forEach(({ key, value }) => values.set(key, value));
  const row = rows[1],
    note = {
      type: 'Transact',
      txid: '0x' + row.txid,
      hash: row.commitments[0],
      tree: 0,
      position: 1,
      blockNumber: 2,
    };
  const noteWitness =
    await require('../../src/main/wallet/railgun-txid-note-witness').findRailgunNoteTxidWitness({
      state,
      note,
      read,
      projection,
    });
  const events = [
    { name: 'Nullified', logIndex: 1, tree: 0, values: row.nullifiers },
    { name: 'Transact', logIndex: 2, tree: 0, start: 1, hashes: row.commitments },
  ];
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: { state, note, noteWitness, events, guards },
        })
      )
    ),
    { id: 1, value: null }
  );
};
