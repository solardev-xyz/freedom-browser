/**
 * Swarm references as CIDs (`bah5…`), as the Swarm gateway takes them in a
 * hostname (`<cid>.bzz.link`, gateway-offer.js) and as bee-js 13.2.0's
 * `Reference` writes and reads them. Main's own decoder, so the offer needs
 * no bee-js (freedom-core design 0015, SWM-8: "a small decoder in main").
 *
 * A Swarm CID is multibase `b` (RFC 4648 base32, lower case, no padding)
 * over 37 bytes:
 *
 *   0x01         CID version 1
 *   0xfa | 0xfb  the codec, a varint: swarm-manifest (250) or swarm-feed
 *   0x01           (251), whose second byte is 0x01
 *   0x1b         the multihash: keccak-256
 *   0x20         a 32-byte digest
 *   32 bytes     the reference
 *
 * The five header bytes are exactly eight characters, so every Swarm CID is
 * 61 characters, starting `bah5a` (manifest) or `bah5q` (feed). A 64-byte
 * (encrypted) reference has no CID form.
 *
 * `test/fixtures/swarm-cid/bee-js-13.2.0.json` holds what bee-js made of
 * every form this module handles; `swarm-cid.test.js` holds it to them.
 */

// A label worth decoding: the multibase prefix, then what the CIDv1 and
// Swarm codec header always encodes to. Only routes a label to the decoder.
const SWARM_CID_LABEL = /^bah5[a-z2-7]+$/;

const CODECS = { manifest: 0xfa, feed: 0xfb };
const KECCAK_256 = 0x1b;
const REFERENCE_BYTES = 32;
const HEADER_BYTES = 5;
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

const header = (codec) => [0x01, codec, 0x01, KECCAK_256, REFERENCE_BYTES];

/** RFC 4648 base32, lower case, unpadded: the final bits padded with zeros. */
function base32Encode(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xfff;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31];
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The bytes of base32 `text` (already only `[a-z2-7]`), leftover bits dropped. */
function base32Decode(text) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/**
 * The CID of a 32-byte reference, as bee-js's `Reference#toCid(type)`.
 *
 * @param {string} reference - 64 hex digits, any case, `0x` optional
 * @param {'manifest'|'feed'} type
 * @returns {string}
 */
function toSwarmCid(reference, type) {
  const codec = CODECS[type];
  if (codec === undefined) throw new TypeError(`a Swarm CID is a manifest or a feed, not ${type}`);
  if (typeof reference !== 'string' || !/^(0x)?[0-9a-f]{64}$/i.test(reference)) {
    throw new TypeError('only a 32-byte reference has a CID form');
  }
  const bytes = Buffer.concat([
    Buffer.from(header(codec)),
    Buffer.from(reference.replace(/^0x/i, ''), 'hex'),
  ]);
  return `b${base32Encode(bytes)}`;
}

/**
 * Decode a `bah5…` Swarm CID label to its 64-hex reference, or null.
 *
 * The label must be exactly the CID its reference encodes to as a manifest
 * or a feed, the two codecs the Swarm gateway takes: that rejects a wrong
 * version, codec, multihash, length, case, padding or trailing garbage in
 * one check. bee-js's `Reference` decodes any `bah5` string with a known
 * codec byte, so gateway-offer.js made the same check against it.
 *
 * @param {string} label - a lower-case DNS label
 * @returns {string|null} 64 lower-case hex digits
 */
function decodeSwarmCid(label) {
  if (typeof label !== 'string' || !SWARM_CID_LABEL.test(label)) return null;
  const bytes = base32Decode(label.slice(1));
  if (bytes.length !== HEADER_BYTES + REFERENCE_BYTES) return null;
  const type = Object.keys(CODECS).find((name) => CODECS[name] === bytes[1]);
  if (!type) return null;
  const reference = Buffer.from(bytes.subarray(HEADER_BYTES)).toString('hex');
  return toSwarmCid(reference, type) === label ? reference : null;
}

module.exports = { SWARM_CID_LABEL, toSwarmCid, decodeSwarmCid };
