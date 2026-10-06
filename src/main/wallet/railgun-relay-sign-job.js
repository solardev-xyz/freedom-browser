/** Fixed relay signature job. Exact binary-key process/identity admission is
 * available, but the connected controller permit consumer is not installed.
 * That fixed one-use controller permit must authenticate
 * both durable signing markers, ownership, review and fresh disclosure gates.
 * Public intent checks and an echoed record digest are not that authority.
 * No viewing credential, storage, note decryption or network is available here.
 */
const assert = require('assert/strict');
const path = require('path');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < FIELD;
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
let attempted = false;
exports.run = async function run(text, { request, requestKey, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'intent',
    'recordDigest',
    'spendingPublicKey',
  ]);
  assert.match(input.recordDigest, /^[0-9a-f]{64}$/);
  assert.ok(
    Array.isArray(input.spendingPublicKey) &&
      input.spendingPublicKey.length === 2 &&
      input.spendingPublicKey.every(field)
  );
  assert.ok(!signal.aborted);
  const intent = normalizeRailgunRelayUnsignedIntent(input.intent);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const root = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { poseidon, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  assert.ok(!signal.aborted);
  const { getPublicSpendingKey, signEDDSA, verifyEDDSA } = require(
    path.join(root, 'utils/keys-utils')
  );
  const expected = intent.data.expected;
  // The only accepted message is independently derived from canonical calldata:
  // one nullifier, then the fee commitment, then the self commitment.
  const message = poseidon(
    [
      expected.merkleRoot,
      expected.boundParamsHash,
      expected.nullifier,
      expected.feeCommitment,
      expected.selfCommitment,
    ].map(BigInt)
  );
  assert.equal(hex(message), intent.data.expectedHash);
  assert.equal(guardReport().attempts, 0);
  assert.ok(!signal.aborted);
  const bytes = await requestKey(
    JSON.stringify({
      id: 1,
      method: 'key',
      purpose: 'relay-sign',
      recordDigest: input.recordDigest,
      intentDigest: intent.digest,
      expectedHash: intent.data.expectedHash,
    })
  );
  assert.ok(bytes instanceof Uint8Array);
  const key = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let signature;
  try {
    assert.equal(key.length, 32);
    assert.ok(!signal.aborted);
    assert.equal(guardReport().attempts, 0);
    const publicKey = getPublicSpendingKey(key);
    assert.deepEqual(publicKey.map(hex), input.spendingPublicKey);
    signature = signEDDSA(key, message);
    assert.equal(verifyEDDSA(message, signature, publicKey), true);
    signature = normalizeRailgunSignature({ R8: signature.R8.map(hex), S: hex(signature.S) });
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
            signature,
            message: intent.data.expectedHash,
            recordDigest: input.recordDigest,
            intentDigest: intent.digest,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 2, value: null }
  );
  assert.ok(!signal.aborted);
};
