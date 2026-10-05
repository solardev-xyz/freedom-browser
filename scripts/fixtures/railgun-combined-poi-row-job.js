/** Keyless fixture projection of the ACTUAL signed partial transaction. The
 * creating transaction (when present) remains the public-vector fixture row.
 * Never replace commitments with invented unshield-only or change-only rows. */
const { assert } = require('./railgun-native-assertions');
const path = require('path');
const { createRequire } = require('module');
const { graph } = require('./railgun-combined-poi-chain');
const { normalizeTxidPage } = require('../../src/main/wallet/railgun-public-services');
exports.run = async (text, { request, signal, guardReport }) => {
  const { archive, priorRows, row: own } = JSON.parse(text);
  assert.ok(Array.isArray(priorRows) && priorRows.length <= 1);
  assert.equal(own.commitments.length, 2);
  assert.equal(own.nullifiers.length, 1);
  assert.ok(own.unshield);
  const verified =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const r = createRequire(path.join(verified, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { getNoteHash } = require(path.join(root, 'note/note-util'));
  const u = own.unshield;
  assert.equal(
    own.commitments[1],
    '0x' + getNoteHash(u.toAddress, u.tokenData, BigInt(u.value)).toString(16).padStart(64, '0')
  );
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  let previous;
  const supplied = [...priorRows, own].map((row) => {
    const verificationHash = calculateRailgunTransactionVerificationHash(
      previous,
      row.nullifiers[0]
    );
    previous = verificationHash;
    return { ...row, verificationHash };
  });
  // The mirror hashes row JSON bytes into its transcript. Project exactly the
  // same canonical key order as the genuine GraphQL ingestion boundary.
  const rows = normalizeTxidPage(supplied.map(graph), '0x00').transactions;
  assert.deepEqual(rows, supplied);
  const projection =
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  const checkpoints = [];
  for (let count = 1; count <= rows.length; count++) {
    const { state } = await projection.append(
      projection.empty(),
      rows.slice(0, count),
      async () => null
    );
    checkpoints.push(state);
  }
  const state = checkpoints.at(-1);
  assert.equal(signal.aborted, false);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({ id: 1, method: 'result', value: { rows, state, checkpoints, guards } })
      )
    ),
    { id: 1, value: null }
  );
};
