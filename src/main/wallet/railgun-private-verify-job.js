/** Witness-free 1x1 transaction verification. This process receives only public
 * calldata/intent and authenticated artifacts; no key or storage broker.
 */
const assert = require('assert/strict');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { matchRailgunPrivateProvedTransaction } = require('./railgun-private-intent');
const BASE_FIELD = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
exports.run = async function run(text, { request, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'artifactDirectory',
    'expected',
    'intent',
    'transaction',
  ]);
  const checked = matchRailgunPrivateProvedTransaction(
    input.intent,
    input.transaction,
    input.expected
  );
  const [[tx]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
    'transact',
    input.transaction.data
  );
  const p = tx.proof;
  assert.ok([p.a.x, p.a.y, ...p.b.x, ...p.b.y, p.c.x, p.c.y].every((n) => n < BASE_FIELD));
  const proof = {
    pi_a: [p.a.x, p.a.y, 1n],
    pi_b: [
      [p.b.x[1], p.b.x[0]],
      [p.b.y[1], p.b.y[0]],
      [1n, 0n],
    ],
    pi_c: [p.c.x, p.c.y, 1n],
    protocol: 'groth16',
    curve: 'bn128',
  };
  const serial = require('./railgun-prover-runtime').loadRailgunProverRuntime(input.archive);
  const scope = require('../networks/privacy-context').createPrivacyScope({
    profileId: 'railgun-private-proof-verification',
    signal,
  });
  const handle = scope.getContext({
    kind: 'private-account',
    principal: 'proof',
    protocol: 'railgun',
    deployment: 'offline',
    chainId: 11155111,
    role: 'artifacts',
  });
  let artifacts;
  try {
    artifacts = await require('./railgun-artifacts').loadRailgunArtifacts({
      handle,
      directory: input.artifactDirectory,
      variant: '01x01',
    });
    assert.ok(!signal.aborted);
    const publicSignals = [
      checked.merkleRoot,
      checked.boundParamsHash,
      checked.nullifier,
      checked.commitment,
    ].map(BigInt);
    assert.equal(await serial.verify(artifacts.vkey, publicSignals, proof), true);
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
              transactionDigest: checked.digest,
              verified: true,
              guards,
              proverSha256: require('./railgun-prover-manifest.json').sha256,
            },
          })
        )
      ),
      { id: 1, value: null }
    );
  } finally {
    artifacts?.wasm.fill(0);
    artifacts?.zkey.fill(0);
    scope.close();
  }
};
