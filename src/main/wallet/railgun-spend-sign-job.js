/** One-use private-transaction signature utility. No viewing key, notes, storage
 * or provider. Main must establish ownership, recipient, POI and reservation
 * authority before supplying a spending key; this job is not that authority.
 */
const assert = require('assert/strict'),
  path = require('path');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < FIELD;
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'expected',
    'expectedHash',
    'spendingPublicKey',
    'transaction',
  ]);
  assert.ok(!signal.aborted);
  const checked = validateRailgunPrivateSigningIntent(input.transaction, input.expected);
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'].includes(
      checked.kind
    )
  );
  const partial = checked.kind === 'railgun-partial-unshield';
  assert.ok(field(input.expectedHash));
  assert.ok(
    Array.isArray(input.spendingPublicKey) &&
      input.spendingPublicKey.length === 2 &&
      input.spendingPublicKey.every(field)
  );
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive),
    root = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { poseidon, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  const { getPublicSpendingKey, signEDDSA, verifyEDDSA } = require(
    path.join(root, 'utils/keys-utils')
  );
  if (partial || checked.kind === 'railgun-token-unshield') {
    const { getNoteHash } = require(path.join(root, 'note/note-util'));
    assert.equal(
      hex(
        getNoteHash(
          checked.recipient,
          {
            tokenType: 0,
            tokenAddress: pins.wrappedNative,
            tokenSubID: '0',
          },
          BigInt(partial ? checked.unshieldAmount : checked.amount)
        )
      ),
      partial ? checked.unshieldCommitment : checked.commitment
    );
  }
  // Match the SDK HardwareWallet connector's exact public-input order. Never
  // sign a caller digest without reconstructing it from the checked transaction.
  const message = poseidon(
    [
      checked.merkleRoot,
      checked.boundParamsHash,
      checked.nullifier,
      ...(partial ? [checked.changeCommitment, checked.unshieldCommitment] : [checked.commitment]),
    ].map(BigInt)
  );
  assert.equal(hex(message), input.expectedHash);
  assert.equal(guardReport().attempts, 0);
  assert.ok(!signal.aborted);
  const bytes = await requestKey(
    JSON.stringify({
      id: 1,
      method: 'key',
      purpose: 'spending-sign',
      transactionDigest: checked.digest,
      expectedHash: hex(message),
    })
  );
  assert.ok(bytes instanceof Uint8Array);
  const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let signature;
  try {
    assert.equal(key.length, 32);
    assert.ok(!signal.aborted);
    const publicKey = getPublicSpendingKey(key);
    assert.deepEqual(publicKey.map(hex), input.spendingPublicKey);
    signature = signEDDSA(key, message);
    assert.equal(verifyEDDSA(message, signature, publicKey), true);
  } finally {
    key.fill(0);
  }
  assert.ok(!signal.aborted);
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 2,
          method: 'result',
          value: {
            signature: { R8: signature.R8.map(hex), S: hex(signature.S) },
            message: input.expectedHash,
            transactionDigest: checked.digest,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 2, value: null }
  );
};
