/** Public synthetic fixtures built with pinned Poseidon, no wallet/key/network. */
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
  const { getNoteHash } = require(path.join(root, 'note/note-util'));
  const { sample } = require('./railgun-own-txid-data');
  const u = sample(true).row.unshield;
  const commitment =
    '0x' + getNoteHash(u.toAddress, u.tokenData, BigInt(u.value)).toString(16).padStart(64, '0');
  const wrongCommitment =
    '0x' +
    getNoteHash(u.toAddress, u.tokenData, BigInt(u.value) - 1n)
      .toString(16)
      .padStart(64, '0');
  const samples = [];
  for (const [name, evidence] of [
    ['transfer', sample()],
    ['unshield', sample(true, false, commitment)],
    ['archived-unshield', sample(true, true, commitment)],
    ['wrong-preimage', sample(true, false, wrongCommitment)],
  ]) {
    const projection =
      require('../../src/main/wallet/railgun-txid-projection').createRailgunTxidProjection({
        hashPair: (a, b) => poseidonHex([a, b]),
        transactionHash: createRailgunTransactionWithHash,
        verificationHash: calculateRailgunTransactionVerificationHash,
        zeroNodes: require('../../src/main/wallet/railgun-public-records').ZERO_NODES,
      });
    evidence.row.verificationHash = calculateRailgunTransactionVerificationHash(
      undefined,
      evidence.row.nullifiers[0]
    );
    const values = new Map(),
      read = async (key) => values.get(key) ?? null;
    const { state, writes } = await projection.append(projection.empty(), [evidence.row], read);
    writes.forEach(({ key, value }) => values.set(key, value));
    const txid = createRailgunTransactionWithHash(evidence.row).railgunTxid;
    const witness = await projection.witness(state, txid, read);
    samples.push({ name, evidence, state, witness });
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(JSON.stringify({ id: 1, method: 'result', value: { samples, guards } }))
    ),
    { id: 1, value: null }
  );
};
