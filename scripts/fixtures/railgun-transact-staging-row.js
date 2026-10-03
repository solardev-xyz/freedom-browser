/** Keyless pinned-engine construction of one explicitly synthetic TXID row. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
exports.run = async (text, { request, signal, guardReport }) => {
  const { archive, row: input } = JSON.parse(text);
  const verified =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const r = createRequire(path.join(verified, 'package.json'));
  const root = path.dirname(r.resolve('@railgun-community/engine'));
  const { initPoseidonPromise, poseidonHex } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { createRailgunTransactionWithHash, calculateRailgunTransactionVerificationHash } = require(
    path.join(root, 'transaction/railgun-txid')
  );
  const row = {
    ...input,
    verificationHash: calculateRailgunTransactionVerificationHash(undefined, input.nullifiers[0]),
  };
  const projection =
    require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
      hashPair: (a, b) => poseidonHex([a, b]),
      transactionHash: createRailgunTransactionWithHash,
      verificationHash: calculateRailgunTransactionVerificationHash,
      zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
    });
  const { state } = await projection.append(projection.empty(), [row], async () => null);
  assert.equal(signal.aborted, false);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(JSON.stringify({ id: 1, method: 'result', value: { row, state, guards } }))
    ),
    { id: 1, value: null }
  );
};
