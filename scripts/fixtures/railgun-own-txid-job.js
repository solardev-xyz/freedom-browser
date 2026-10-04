/** Public synthetic fixtures built with pinned Poseidon, no wallet/key/network. */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
exports.run = async function run(text, { request, signal, guardReport }) {
  const { archive, mode } = JSON.parse(text);
  assert.ok(mode === undefined || mode === 'partial');
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
  const noteHash = (u, value = u.value) =>
    '0x' + getNoteHash(u.toAddress, u.tokenData, BigInt(value)).toString(16).padStart(64, '0');
  let inputs;
  if (mode === 'partial') {
    const { samplePartial } = require('./railgun-partial-own-txid-data');
    const make = (options = {}, mutation) => {
      const base = samplePartial(options);
      const u = base.row.unshield;
      const change = noteHash(
        { ...u, toAddress: '0x' + '17'.repeat(32) },
        base.capsule.preparation.changeAmount
      );
      const unshield = noteHash(u, mutation === 'wrong-preimage' ? BigInt(u.value) - 1n : u.value);
      const commitments =
        mutation === 'swapped-commitments' ? [unshield, change] : [change, unshield];
      return samplePartial({ ...options, commitments });
    };
    inputs = [
      ['partial-unshield', make()],
      ['archived-partial-unshield', make({ archived: true })],
      ['zero-fee', make({ unshieldAmount: '1' })],
      [
        'same-recipient-treasury',
        make({
          recipient: require('../../src/main/wallet/railgun-transact-receipt-policy').treasury,
        }),
      ],
      ['wrong-preimage', make({}, 'wrong-preimage')],
      ['swapped-commitments', make({}, 'swapped-commitments')],
    ];
  } else {
    const u = sample(true).row.unshield;
    inputs = [
      ['transfer', sample()],
      ['unshield', sample(true, false, noteHash(u))],
      ['archived-unshield', sample(true, true, noteHash(u))],
      ['wrong-preimage', sample(true, false, noteHash(u, BigInt(u.value) - 1n))],
    ];
  }
  const samples = [];
  for (const [name, evidence] of inputs) {
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
    projection.verifyWitness(state, witness);
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
