/** Keyless relay signature verification with no fixed production caller yet.
 * Binary-key admission still refuses the future relay-signature-verify purpose;
 * the generic trusted-main result-only process API is unchanged. A record digest and
 * a valid signature do not authenticate durable custody, review or permission.
 * No key, storage, viewing credential, note reconstruction or prover is used.
 */
const assert = require('assert/strict');
const path = require('path');
const { createHash } = require('crypto');
const { normalizeRailgunRelayUnsignedIntent } = require('./railgun-relay-intent');
const { normalizeRailgunSignature } = require('./railgun-private-signature');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const field = (value) =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value) && BigInt(value) < FIELD;
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
let attempted = false;
exports.run = async function run(text, { request, signal, guardReport }) {
  assert.equal(attempted, false);
  attempted = true;
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'intent',
    'recordDigest',
    'signature',
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
  const signature = normalizeRailgunSignature(input.signature);
  // A fixed serialization contract shared with the future main-side result join:
  // lowercase SHA256 of UTF-8 JSON, ordered R8 then S, normalized hex strings.
  const signatureDigest = createHash('sha256').update(JSON.stringify(signature)).digest('hex');
  const publicKey = input.spendingPublicKey.map(BigInt);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const root = path.join(archive, 'node_modules/@railgun-community/engine/dist');
  const { poseidon, initPoseidonPromise } = require(path.join(root, 'utils/poseidon'));
  await initPoseidonPromise;
  assert.ok(!signal.aborted);
  const expected = intent.data.expected;
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
  const { verifyEDDSA } = require(path.join(root, 'utils/keys-utils'));
  assert.equal(
    verifyEDDSA(message, { R8: signature.R8.map(BigInt), S: BigInt(signature.S) }, publicKey),
    true
  );
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
            recordDigest: input.recordDigest,
            intentDigest: intent.digest,
            message: intent.data.expectedHash,
            signatureDigest,
            signatureVerified: true,
            guards,
            inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  assert.ok(!signal.aborted);
};
