/**
 * The CIDs in a `shell.dweb_get` path, read strictly, as freedom-core's
 * verifier writes them (fc-ipfs `cid.rs`): a CIDv1 in lowercase base32, a
 * CIDv0 (base58btc), and an IPNS name, a CIDv1 of the libp2p-key codec in
 * lowercase base32 or base36. Each is decoded, bounded, and parsed whole:
 * the version, the codec, the hash function and the digest's length as
 * minimal varints, and the digest exactly that long. Anything else is null,
 * and main dials nothing for it.
 *
 * `src/shared/cid-utils.js` canonicalises what a page or the address bar
 * names: it reads varints leniently and decodes no base32 or base36, so it
 * isn't this check.
 */

const LIBP2P_KEY = 0x72n;
/** A varint's most bytes, and a digest's (fc-ipfs's MAX_DIGEST). */
const MAX_VARINT = 10;
const MAX_DIGEST = 128;
/** The longest binary CID: four varints at their longest, and the digest. */
const MAX_CID = 4 * MAX_VARINT + MAX_DIGEST;
/** The longest text of a CID past its multibase prefix: base32 carries 5
 * bits a character, base36 more. Longer text isn't decoded. */
const MAX_CID_TEXT = Math.ceil((MAX_CID * 8) / 5);
/** A CIDv0's text: `Qm` and 44 more base58btc characters. */
const CIDV0_TEXT = /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/;

const table = (alphabet) => {
  const out = new Int8Array(128).fill(-1);
  for (let i = 0; i < alphabet.length; i++) out[alphabet.charCodeAt(i)] = i;
  return out;
};
const B32 = table('abcdefghijklmnopqrstuvwxyz234567');
const B36 = table('0123456789abcdefghijklmnopqrstuvwxyz');
const B58 = table('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz');

const digit = (alphabet, text, i) => {
  const code = text.charCodeAt(i);
  return code < 128 ? alphabet[code] : -1;
};

/** The varint at `at`, in its minimal encoding: `[value, next]`, or null
 * past the bytes, 10 bytes or 64 bits, or with a trailing zero group. */
function varint(bytes, at) {
  let value = 0n;
  for (let i = 0; i < MAX_VARINT && at + i < bytes.length; i++) {
    const byte = bytes[at + i];
    const low = byte & 0x7f;
    if (i === MAX_VARINT - 1 && low > 1) return null;
    value |= BigInt(low) << BigInt(7 * i);
    if ((byte & 0x80) === 0) return i > 0 && byte === 0 ? null : [value, at + i + 1];
  }
  return null;
}

/** A whole binary CID: `{ version, codec, hash, digest }`, or null. A CIDv0
 * is a bare sha2-256 multihash: `12 20` and 32 bytes. */
function parse(bytes) {
  if (bytes.length >= 34 && bytes[0] === 0x12 && bytes[1] === 0x20) {
    return bytes.length === 34 ? { version: 0, codec: 0x70n, hash: 0x12n, digest: 32 } : null;
  }
  const version = varint(bytes, 0);
  if (!version || version[0] !== 1n) return null;
  const codec = varint(bytes, version[1]);
  if (!codec) return null;
  const hash = varint(bytes, codec[1]);
  if (!hash) return null;
  const length = varint(bytes, hash[1]);
  if (!length || length[0] > BigInt(MAX_DIGEST)) return null;
  const digest = Number(length[0]);
  if (length[1] + digest !== bytes.length) return null;
  return { version: 1, codec: codec[0], hash: hash[0], digest };
}

/** RFC 4648 base32, lowercase, unpadded: its bytes, or null. What is left
 * past the last byte must be fewer than 5 bits, all zero. */
function base32(body) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i++) {
    const v = digit(B32, body, i);
    if (v < 0) return null;
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push(acc >> bits);
      acc &= (1 << bits) - 1;
    }
  }
  return bits >= 5 || acc !== 0 ? null : Uint8Array.from(out);
}

/** A big-endian base change, as multibase defines base36 and base58btc:
 * each leading zero digit is a leading zero byte. */
function baseChange(alphabet, base, body) {
  let zeros = 0;
  while (zeros < body.length && digit(alphabet, body, zeros) === 0) zeros += 1;
  let n = 0n;
  for (let i = 0; i < body.length; i++) {
    const v = digit(alphabet, body, i);
    if (v < 0) return null;
    n = n * base + BigInt(v);
  }
  const out = [];
  while (n > 0n) {
    out.push(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array(zeros).fill(0), ...out.reverse()]);
}

/** A CIDv1 from its lowercase base32 text (`b…`), or null. */
function cidV1Base32(text) {
  if (typeof text !== 'string' || text[0] !== 'b' || text.length - 1 > MAX_CID_TEXT) return null;
  const bytes = base32(text.slice(1));
  const cid = bytes && parse(bytes);
  return cid?.version === 1 ? cid : null;
}

/**
 * The CID of an `/ipfs/` path, as the core writes it: a CIDv1 in lowercase
 * base32, or a CIDv0 (a dag-pb link may name one). `{ version, codec,
 * hash, digest }` (the digest's length), or null.
 */
function ipfsCid(text) {
  if (typeof text !== 'string') return null;
  if (CIDV0_TEXT.test(text)) {
    const cid = parse(baseChange(B58, 58n, text));
    return cid?.version === 0 ? cid : null;
  }
  return cidV1Base32(text);
}

/**
 * An IPNS name as the core asks for its record: a CIDv1 of the libp2p-key
 * codec, in lowercase base36 (`k…`, as Kubo writes names) or base32
 * (`b…`). The CID, or null.
 */
function ipnsKey(text) {
  if (typeof text !== 'string') return null;
  let cid;
  if (text[0] === 'b') {
    cid = cidV1Base32(text);
  } else if (text[0] === 'k' && text.length - 1 <= MAX_CID_TEXT) {
    const bytes = baseChange(B36, 36n, text.slice(1));
    cid = bytes && parse(bytes);
  }
  return cid?.version === 1 && cid.codec === LIBP2P_KEY ? cid : null;
}

module.exports = { ipfsCid, ipnsKey, MAX_CID_TEXT };
