/**
 * The CIDs of a `shell.dweb_get` path, read as freedom-core's fc-ipfs
 * `cid.rs` reads them: what the core writes passes, and nothing else does.
 */

const { ipfsCid, ipnsKey, MAX_CID_TEXT } = require('./cid-text');

const CID1 = 'bafybeiguwjmddvr4iiah6ekgvrovb5zfb6eg5c6loikxvxlxzlwea5dabm';
const RAW1 = 'bafkreie5iksgmmyl2f4ezy3qhpvlkehhebqtpymbiya5iz6wbtnl2ip33i';
const CID0 = 'QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG';
const KEY36 = 'k51qzi5uqu5dlvj2baxnqndepeb86cbk3ng7n3i46uzyxzyqj2xjonzllnv0v8';
const KEY32 = 'bafzaajaiaejcbzdibmxyzdjbbehgvizh6g5tikvy47mshdy6gwbruvgwvd24seje';

/** `bytes` as `b…` lowercase base32, unpadded. */
function base32(bytes) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  let out = 'b';
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += alphabet[(acc >> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += alphabet[(acc << (5 - bits)) & 31];
  return out;
}

/** `bytes` as `k…` lowercase base36. */
function base36(bytes) {
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let out = '';
  while (n > 0n) {
    out = '0123456789abcdefghijklmnopqrstuvwxyz'[Number(n % 36n)] + out;
    n /= 36n;
  }
  let zeros = 0;
  while (bytes[zeros] === 0) zeros += 1;
  return `k${'0'.repeat(zeros)}${out}`;
}

/** `text`, a 36-byte CID's base32 (2 bits of padding), with its last
 * padding bit set. */
function dirty(text) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
  const last = alphabet.indexOf(text.at(-1));
  if (last % 4 !== 0) throw new Error('padding already set');
  return text.slice(0, -1) + alphabet[last + 1];
}

const digest = (length, fill = 7) => new Array(length).fill(fill);
/** A CIDv1's bytes: version, codec, sha2-256 and a 32-byte digest. */
const v1 = (codec = [0x70], { version = [0x01], hash = [0x12], length = [0x20] } = {}) => [
  ...version,
  ...codec,
  ...hash,
  ...length,
  ...digest(32),
];

describe('ipfsCid', () => {
  test('a CIDv1 in lowercase base32, of any codec, and a CIDv0', () => {
    expect(ipfsCid(CID1)).toEqual({ version: 1, codec: 0x70n, hash: 0x12n, digest: 32 });
    expect(ipfsCid(RAW1)).toEqual({ version: 1, codec: 0x55n, hash: 0x12n, digest: 32 });
    expect(ipfsCid(CID0)).toEqual({ version: 0, codec: 0x70n, hash: 0x12n, digest: 32 });
    // A two-byte codec in its minimal form: dag-json, 0x0129.
    expect(ipfsCid(base32(v1([0xa9, 0x02])))).toMatchObject({ version: 1, codec: 0x0129n });
    // An identity digest up to 128 bytes; an empty one.
    expect(ipfsCid(base32([0x01, 0x55, 0x00, 0x80, 0x01, ...digest(128)]))).toMatchObject({
      hash: 0n,
      digest: 128,
    });
    expect(ipfsCid(base32([0x01, 0x55, 0x00, 0x00]))).toMatchObject({ digest: 0 });
  });

  test.each([
    ['an incomplete base32 quantum', 'ba'],
    ['a truncated CIDv1', CID1.slice(0, -1)],
    ['a CIDv1 two characters short', CID1.slice(0, -2)],
    ['a CIDv1 with a character more', `${CID1}a`],
    ["a CIDv1 whose padding bits aren't zero", dirty(CID1)],
    ['an uppercase CIDv1', CID1.toUpperCase()],
    ['a CIDv1 with an uppercase character', `${CID1.slice(0, -1)}M`],
    ['another multibase', 'zb2rhe5P4gXftAwvA4eXQ5HJwsER2owDyS9sKaQRRVQPn93bA'],
    ['the empty text', ''],
    ['the prefix alone', 'b'],
    ['a version 2', base32(v1([0x70], { version: [0x02] }))],
    ['a version 0 varint', base32(v1([0x70], { version: [0x00] }))],
    ['a CIDv0 multihash in base32', base32([0x12, 0x20, ...digest(32)])],
    ['a padded version varint', base32(v1([0x70], { version: [0x81, 0x00] }))],
    ['a padded codec varint', base32(v1([0xf0, 0x00]))],
    ['a padded hash varint', base32(v1([0x70], { hash: [0x92, 0x00] }))],
    ['a padded length varint', base32(v1([0x70], { length: [0xa0, 0x00] }))],
    ['a digest past its length', base32([...v1(), 0])],
    ['a digest short of its length', base32(v1().slice(0, -1))],
    ['a digest past 128 bytes', base32([0x01, 0x55, 0x00, 0x81, 0x01, ...digest(129)])],
    ['a varint past 10 bytes', base32([0x01, ...new Array(10).fill(0xff), 0x01, 0x12, 0x00])],
    ['text past the longest CID', `b${'a'.repeat(MAX_CID_TEXT + 1)}`],
    ['a CIDv0 lowercased', CID0.toLowerCase()],
    ['a CIDv0 one character short', CID0.slice(0, -1)],
    ['a CIDv0 one character more', `${CID0}1`],
    ['a CIDv0 below its multihash', `Qm${'1'.repeat(44)}`],
    ['a CIDv0 above its multihash', `Qm${'z'.repeat(44)}`],
    ['a CIDv0 with a character outside base58', `${CID0.slice(0, -1)}0`],
    ['an IPNS key', KEY36],
    ['not text', 7],
  ])('%s is refused', (_what, text) => {
    expect(ipfsCid(text)).toBeNull();
  });
});

describe('ipnsKey', () => {
  test('a libp2p-key CIDv1 in lowercase base36 or base32', () => {
    const key = { version: 1, codec: 0x72n, hash: 0n, digest: 36 };
    expect(ipnsKey(KEY36)).toEqual(key);
    expect(ipnsKey(KEY32)).toEqual(key);
    // The same bytes, both ways.
    expect(ipnsKey(base36([0x01, 0x72, 0x12, 0x20, ...digest(32)]))).toMatchObject({
      hash: 0x12n,
    });
    expect(ipnsKey(base32([0x01, 0x72, 0x12, 0x20, ...digest(32)]))).toMatchObject({
      hash: 0x12n,
    });
  });

  test.each([
    ['text that is not a CID', 'kNOTACID'],
    ['an uppercase base36 key', `k${KEY36.slice(1).toUpperCase()}`],
    ['a base36 key with an uppercase character', `${KEY36.slice(0, -1)}V`],
    ['a base36 key with a character outside base36', `${KEY36.slice(0, -1)}-`],
    ['an uppercase base32 key', KEY32.toUpperCase()],
    ['a truncated base36 key', KEY36.slice(0, -1)],
    ['a truncated base32 key', KEY32.slice(0, -1)],
    ["a base32 key whose padding bits aren't zero", dirty(base32(v1([0x72])))],
    ['a dag-pb CID in base32', CID1],
    ['a raw CID in base36', base36(v1([0x55]))],
    ['a version 2 key in base36', base36(v1([0x72], { version: [0x02] }))],
    ['a version 2 key in base32', base32(v1([0x72], { version: [0x02] }))],
    ['a padded codec varint in base36', base36(v1([0xf2, 0x00]))],
    ['a key with a leading zero byte', base36([0x00, ...v1([0x72])])],
    ['a CIDv0', CID0],
    ['a base58 peer ID', '12D3KooWAsDaZWCkCEUN3myg49NoCMmrYYivmJVwjg7DVJBvWdaX'],
    ['a DNSLink name', 'example.com'],
    ['text past the longest CID', `k${'1'.repeat(MAX_CID_TEXT + 1)}`],
    ['the prefix alone', 'k'],
    ['not text', null],
  ])('%s is refused', (_what, text) => {
    expect(ipnsKey(text)).toBeNull();
  });
});
