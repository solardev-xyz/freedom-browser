/** Keyless synthetic two-row mirror for retained-history qualification. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
exports.run = async (text, { request, signal, guardReport }) => {
  const { archive, row } = JSON.parse(text);
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
  const values = new Map();
  const read = async (key) => values.get(key) ?? null;
  const first = await projection.append(projection.empty(), [row], read);
  for (const { key, value } of first.writes) values.set(key, value);
  const field = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  const laterRow = {
    version: 'V2',
    graphID: field(row.blockNumber) + field(5).slice(2) + field(0).slice(2),
    commitments: [field(901)],
    nullifiers: [field(902)],
    boundParamsHash: field(903),
    blockNumber: row.blockNumber,
    txid: field(904).slice(2),
    timestamp: row.timestamp + 1,
    utxoTreeIn: 0,
    utxoTreeOut: 0,
    utxoBatchStartPositionOut: 2,
    verificationHash: calculateRailgunTransactionVerificationHash(row.verificationHash, field(902)),
  };
  const later = await projection.append(first.state, [laterRow], read);
  assert.notEqual(later.state.root, first.state.root);
  assert.equal(later.state.count, 2);
  assert.equal(signal.aborted, false);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: { first: first.state, row: laterRow, state: later.state, guards },
        })
      )
    ),
    { id: 1, value: null }
  );
};
