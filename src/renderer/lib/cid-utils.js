// Minimal CIDv0 → CIDv1 base32 converter, plus an IPNS base58-multihash →
// CIDv1 libp2p-key base36 converter.
//
// Needed because Kubo's subdomain gateway redirects:
//   - `localhost:8080/ipfs/<CIDv0>`  → `<CIDv1-base32>.ipfs.localhost:8080`
//   - `localhost:8080/ipns/<base58>` → `<CIDv1-base36>.ipns.localhost:8080`
// DNS labels are case-insensitive, so base58btc is not subdomain-safe.
//
// Kept inline because the renderer has no bundler — bare module specifiers
// like `multiformats/cid` don't resolve, and the sandboxed renderer can't
// `require()` from node_modules.

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_MAP = new Map();
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_MAP.set(BASE58_ALPHABET[i], i);

// RFC 4648 base32, lowercase, no padding (used by CIDv1 'b' multibase prefix).
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

const base58Decode = (str) => {
  if (!str) return null;
  let num = 0n;
  for (let i = 0; i < str.length; i++) {
    const val = BASE58_MAP.get(str[i]);
    if (val === undefined) return null;
    num = num * 58n + BigInt(val);
  }
  let leadingOnes = 0;
  while (leadingOnes < str.length && str[leadingOnes] === '1') leadingOnes++;

  const bytes = [];
  let n = num;
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }

  const result = new Uint8Array(bytes.length + leadingOnes);
  for (let i = 0; i < bytes.length; i++) {
    result[leadingOnes + i] = bytes[i];
  }
  return result;
};

const base32Encode = (bytes) => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    value = ((value & 0xff) << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return output;
};

/**
 * Convert a CIDv0 ("Qm..." base58btc of a sha2-256 dag-pb multihash)
 * to the CIDv1 base32 form ("bafybei...") used by Kubo's subdomain gateway.
 * Returns null on any malformed input.
 */
export const cidV0ToV1Base32 = (cidV0) => {
  if (typeof cidV0 !== 'string') return null;
  if (!/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cidV0)) return null;
  const mh = base58Decode(cidV0);
  if (!mh || mh.length !== 34) return null;
  // Validate multihash header: 0x12 = sha2-256, 0x20 = 32-byte digest length.
  if (mh[0] !== 0x12 || mh[1] !== 0x20) return null;
  const v1 = new Uint8Array(mh.length + 2);
  v1[0] = 0x01; // CIDv1 version (varint, <128 so one byte)
  v1[1] = 0x70; // dag-pb codec (varint, <128 so one byte)
  v1.set(mh, 2);
  return 'b' + base32Encode(v1);
};

// Base36 encode for multibase 'k' — lowercase, no padding, leading zero
// bytes preserved as '0' chars (matches the multiformats basex convention).
const base36Encode = (bytes) => {
  let num = 0n;
  for (let i = 0; i < bytes.length; i++) {
    num = (num << 8n) | BigInt(bytes[i]);
  }
  const body = num === 0n ? '' : num.toString(36);
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  return '0'.repeat(leadingZeros) + body;
};

/**
 * Convert a base58btc IPNS multihash (peer-ID shape: "12D3Koo..." for
 * Ed25519, "Qm..." for sha2-256) to the CIDv1 libp2p-key base36 form
 * ("k51qzi..." / "k2k4...") used by Kubo's subdomain gateway. Accepts
 * any well-formed multihash — not just sha2-256 — because Ed25519 peer
 * IDs use the identity multihash (0x00). Returns null on malformed input.
 */
export const ipnsMhToCidV1Base36 = (mhBase58) => {
  if (typeof mhBase58 !== 'string') return null;
  const mh = base58Decode(mhBase58);
  // Multihash = 1-byte code + 1-byte digest length + digest. We only accept
  // single-byte-varint code/length (<128); fine for every code a libp2p peer
  // ID can use (identity 0x00, sha2-256 0x12) and any realistic digest size.
  if (!mh || mh.length < 3) return null;
  const code = mh[0];
  const digestLen = mh[1];
  if (code >= 0x80 || digestLen >= 0x80) return null;
  if (mh.length !== 2 + digestLen) return null;
  const v1 = new Uint8Array(mh.length + 2);
  v1[0] = 0x01; // CIDv1 version
  v1[1] = 0x72; // libp2p-key codec
  v1.set(mh, 2);
  return 'k' + base36Encode(v1);
};
