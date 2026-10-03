/** Synthetic row projection for native composition qualification; no wallet key. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
exports.run = async function run(text, { request, signal, guardReport }) {
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
  if (row.unshield) {
    const { getNoteHash } = require(path.join(root, 'note/note-util'));
    const u = row.unshield;
    row.commitments = [
      '0x' + getNoteHash(u.toAddress, u.tokenData, BigInt(u.value)).toString(16).padStart(64, '0'),
    ];
  }
  row.verificationHash = calculateRailgunTransactionVerificationHash(undefined, row.nullifiers[0]);
  const projection =
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  const { state } = await projection.append(projection.empty(), [row], async () => null);
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(JSON.stringify({ id: 1, method: 'result', value: { row, state, guards } }))
    ),
    { id: 1, value: null }
  );
};
