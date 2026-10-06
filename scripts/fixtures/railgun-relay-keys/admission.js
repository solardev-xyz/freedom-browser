'use strict';

// Offline candidate policy only. Actual pinned Noble is supplied by the reviewed harness.
// No wallet/operator/transport trust or transaction authority follows from these tokens.
const fail = (code) => {
  const error = new Error(code);
  error.code = code;
  throw error;
};
function snapshot(value, length, code) {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) fail(code);
  return new Uint8Array(value);
}
function equalBytes(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
const littleEndian = (bytes) => {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1)
    value = (value << 8n) | BigInt(bytes[index]);
  return value;
};
function createAdmission(noble, nodeCrypto) {
  const keys = new WeakMap(),
    signatures = new WeakMap();
  const counts = { signatureCalls: 0, ecdhCalls: 0 };
  function pointBytes(input, role) {
    const bytes = snapshot(input, 32, `${role}_LENGTH`);
    let point;
    try {
      point = noble.Point.fromHex(bytes, true);
    } catch {
      fail(`${role}_DECODE`);
    }
    if (!equalBytes(bytes, point.toRawBytes())) fail(`${role}_CANONICAL`);
    if (point.equals(noble.Point.ZERO)) fail(`${role}_IDENTITY`);
    if (noble.ExtendedPoint.fromAffine(point).isSmallOrder()) fail(`${role}_SMALL_ORDER`);
    if (!point.isTorsionFree()) fail(`${role}_TORSION`);
    return bytes;
  }
  function admitPublicKey(input) {
    const bytes = pointBytes(input, 'A');
    const token = Object.freeze({});
    keys.set(token, bytes);
    return token;
  }
  function admitSignature(input) {
    const bytes = snapshot(input, 64, 'SIGNATURE_LENGTH');
    // R is independently validated: this hardened application subset rejects identity R.
    pointBytes(bytes.subarray(0, 32), 'R');
    if (littleEndian(bytes.subarray(32)) >= noble.CURVE.l) fail('S_RANGE');
    const token = Object.freeze({});
    signatures.set(token, bytes);
    return token;
  }
  function keyBytes(token) {
    const bytes = keys.get(token);
    if (!bytes) fail('KEY_TOKEN');
    return new Uint8Array(bytes);
  }
  function signatureBytes(token) {
    const bytes = signatures.get(token);
    if (!bytes) fail('SIGNATURE_TOKEN');
    return new Uint8Array(bytes);
  }
  async function verify(publicKey, signature, message) {
    // Detach all caller-owned values before any cryptographic await.
    const a = keyBytes(admitPublicKey(publicKey));
    const sig = signatureBytes(admitSignature(signature));
    if (!(message instanceof Uint8Array) || message.byteLength > 16000) fail('MESSAGE_BOUND');
    const msg = new Uint8Array(message);
    counts.signatureCalls += 1;
    if (!(await noble.verify(sig, msg, a))) fail('SIGNATURE_EQUATION');
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(a)]);
    const publicObject = nodeCrypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
    if (!nodeCrypto.verify(null, msg, publicObject, sig)) fail('NODE_SIGNATURE_EQUATION');
    return Object.freeze({
      publicKeyHex: Buffer.from(a).toString('hex'),
      messageSha256: nodeCrypto.createHash('sha256').update(msg).digest('hex'),
    });
  }
  async function sharedSecret(privateSeed, peerPublicKey) {
    const seed = snapshot(privateSeed, 32, 'SEED_LENGTH');
    const peer = keyBytes(admitPublicKey(peerPublicKey));
    counts.ecdhCalls += 1;
    const shared = await noble.getSharedSecret(seed, peer);
    if (
      !(shared instanceof Uint8Array) ||
      shared.byteLength !== 32 ||
      shared.every((byte) => byte === 0)
    )
      fail('SHARED_SECRET');
    return new Uint8Array(shared);
  }
  return Object.freeze({
    admitPublicKey,
    admitSignature,
    keyBytes,
    signatureBytes,
    verify,
    sharedSecret,
    counts: () => Object.freeze({ ...counts }),
  });
}

module.exports = { createAdmission };
