/**
 * The sealed release of a Radicle node key (freedom-core design 0008, "The
 * sealed release"; the core's `fc-seal`), for tests that hand freedom-radicled
 * a key of their own, as the core's `nodes.seal_radicle_key` would: HPKE
 * (RFC 9180) in base mode, single-shot, with exactly fc-seal's suite:
 *
 * - KEM: DHKEM(X25519, HKDF-SHA256), 0x0020;
 * - KDF: HKDF-SHA256, 0x0001;
 * - AEAD: AES-256-GCM, 0x0002;
 * - `info`: `freedom-radicle-node-key/1`; `aad`: empty.
 *
 * `sealRadicleKey(recipient, seed)` seals the 32-byte Ed25519 seed to
 * `rad.hello`'s recipient (32 bytes, base64), and returns `{ enc,
 * ciphertext }` in base64, as `rad.identity { sealed }` takes them. Test
 * code only: production main never holds a key (0008, "What sealing
 * protects").
 */

const crypto = require('crypto');

const INFO = Buffer.from('freedom-radicle-node-key/1');
const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
const KEY_LEN = 32;
const NONCE_LEN = 12;
// The fixed prefixes of an X25519 key's DER: PKCS#8 private, SPKI public.
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

const u16 = (value) => Buffer.from([value >> 8, value & 0xff]);
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), u16(KEM_ID)]);
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), u16(KEM_ID), u16(KDF_ID), u16(AEAD_ID)]);
const VERSION = Buffer.from('HPKE-v1');

const extract = (salt, ikm) => crypto.createHmac('sha256', salt).update(ikm).digest();

function expand(prk, info, length) {
  // One block of HKDF-Expand is enough for every length used here.
  if (length > 32) throw new Error('expand: one block only');
  return crypto
    .createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([1])]))
    .digest()
    .subarray(0, length);
}

const labeledExtract = (suite, salt, label, ikm) =>
  extract(salt, Buffer.concat([VERSION, suite, Buffer.from(label), ikm]));

const labeledExpand = (suite, prk, label, info, length) =>
  expand(prk, Buffer.concat([u16(length), VERSION, suite, Buffer.from(label), info]), length);

/**
 * Seals `seed` (32 bytes) to `recipient` (an X25519 public key, base64).
 * `ephemeral`, 32 bytes, fixes the sender's key for a reproducible seal;
 * otherwise it is random.
 */
function sealRadicleKey(recipient, seed, ephemeral = crypto.randomBytes(32)) {
  const pkR = Buffer.from(recipient, 'base64');
  if (pkR.length !== 32 || seed.length !== 32) throw new Error('sealRadicleKey: 32-byte inputs');
  const skE = crypto.createPrivateKey({
    key: Buffer.concat([X25519_PKCS8, ephemeral]),
    format: 'der',
    type: 'pkcs8',
  });
  const enc = crypto.createPublicKey(skE).export({ format: 'der', type: 'spki' }).subarray(-32);
  const dh = crypto.diffieHellman({
    privateKey: skE,
    publicKey: crypto.createPublicKey({
      key: Buffer.concat([X25519_SPKI, pkR]),
      format: 'der',
      type: 'spki',
    }),
  });
  // Encap's ExtractAndExpand.
  const eaePrk = labeledExtract(KEM_SUITE, Buffer.alloc(0), 'eae_prk', dh);
  const shared = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', Buffer.concat([enc, pkR]), 32);
  // The key schedule, base mode: no PSK.
  const context = Buffer.concat([
    Buffer.from([0]),
    labeledExtract(HPKE_SUITE, Buffer.alloc(0), 'psk_id_hash', Buffer.alloc(0)),
    labeledExtract(HPKE_SUITE, Buffer.alloc(0), 'info_hash', INFO),
  ]);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', Buffer.alloc(0));
  const key = labeledExpand(HPKE_SUITE, secret, 'key', context, KEY_LEN);
  const nonce = labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, NONCE_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const sealed = Buffer.concat([cipher.update(seed), cipher.final(), cipher.getAuthTag()]);
  return { enc: enc.toString('base64'), ciphertext: sealed.toString('base64') };
}

module.exports = { sealRadicleKey, INFO };
