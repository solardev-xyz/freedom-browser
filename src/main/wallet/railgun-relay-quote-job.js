/** Guarded public-only quote check. No account, note, key loan or network. */
const assert = require('assert/strict');
const path = require('path');
const crypto = require('crypto');
const {
  shape,
  digest,
  normalizeRailgunRelayQuote,
  EXPECTED_GUARDS,
} = require('./railgun-relay-quote-data');
exports.run = async function run(text, { request, signal, guardReport }) {
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  assert.equal(typeof text, 'string');
  assert.ok(Buffer.byteLength(text) <= 24000);
  const input = JSON.parse(text);
  shape(input, ['archive', 'quote', 'gas']);
  const binding = normalizeRailgunRelayQuote(input.quote, input.gas);
  const archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(input.archive);
  const { decodeAddress, encodeAddress } = require(
    path.join(archive, 'node_modules/@railgun-community/engine/dist/key-derivation/bech32')
  );
  const noble = require(path.join(archive, 'node_modules/@noble/ed25519/lib/index.js'));
  const decoded = decodeAddress(binding.fields.railgunAddress);
  assert.deepEqual(decoded.chain, { type: 0, id: binding.chainId });
  assert.equal(decoded.version, 1);
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  assert.ok(
    typeof decoded.masterPublicKey === 'bigint' &&
      decoded.masterPublicKey > 0n &&
      decoded.masterPublicKey < FIELD
  );
  assert.equal(encodeAddress(decoded), binding.fields.railgunAddress);
  function point(bytes) {
    assert.ok(bytes instanceof Uint8Array && bytes.length === 32);
    const p = noble.Point.fromHex(bytes, true);
    assert.deepEqual(Buffer.from(p.toRawBytes()), Buffer.from(bytes));
    assert.equal(p.equals(noble.Point.ZERO), false);
    assert.equal(noble.ExtendedPoint.fromAffine(p).isSmallOrder(), false);
    assert.equal(p.isTorsionFree(), true);
  }
  const publicKey = Buffer.from(decoded.viewingPublicKey);
  const signature = Buffer.from(binding.quote.signature, 'hex');
  const message = Buffer.from(binding.quote.data, 'hex');
  point(publicKey);
  point(signature.subarray(0, 32));
  let scalar = 0n;
  for (let i = 63; i >= 32; i--) scalar = (scalar << 8n) | BigInt(signature[i]);
  assert.ok(scalar < noble.CURVE.l);
  active();
  assert.equal(await noble.verify(signature, message, publicKey), true);
  active();
  const key = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKey]),
    format: 'der',
    type: 'spki',
  });
  assert.equal(crypto.verify(null, message, key, signature), true);
  active();
  const guards = guardReport();
  assert.deepEqual(guards, EXPECTED_GUARDS);
  assert.deepEqual(
    JSON.parse(
      await request(
        JSON.stringify({
          id: 1,
          method: 'result',
          value: {
            inputSha256: digest(text),
            quoteSha256: binding.quoteSha256,
            viewingPublicKey: publicKey.toString('hex'),
            masterPublicKey: decoded.masterPublicKey.toString(),
            signatureVerified: true,
            operatorTrusted: false,
            spendingEnabled: false,
            disclosureEnabled: false,
            engineSha256: require('./railgun-engine-manifest.json').sha256,
            guards,
          },
        })
      )
    ),
    { id: 1, value: null }
  );
  active();
};
