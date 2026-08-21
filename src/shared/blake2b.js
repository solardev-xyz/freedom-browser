// Minimal unkeyed BLAKE2b implementation for Tezos ScriptExpr hashing.
// BigInt keeps the 64-bit operations exact; domain resolution hashes only
// short big-map keys, so the simpler implementation is preferable to adding
// a runtime cryptography dependency for one primitive.

const MASK_64 = 0xffffffffffffffffn;
const IV = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];
const SIGMA = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
];

function rotateRight(value, shift) {
  const amount = BigInt(shift);
  return ((value >> amount) | (value << (64n - amount))) & MASK_64;
}

function readWord(bytes, offset) {
  let word = 0n;
  for (let index = 0; index < 8; index += 1) {
    word |= BigInt(bytes[offset + index] || 0) << BigInt(index * 8);
  }
  return word;
}

function mix(v, a, b, c, d, x, y) {
  v[a] = (v[a] + v[b] + x) & MASK_64;
  v[d] = rotateRight(v[d] ^ v[a], 32);
  v[c] = (v[c] + v[d]) & MASK_64;
  v[b] = rotateRight(v[b] ^ v[c], 24);
  v[a] = (v[a] + v[b] + y) & MASK_64;
  v[d] = rotateRight(v[d] ^ v[a], 16);
  v[c] = (v[c] + v[d]) & MASK_64;
  v[b] = rotateRight(v[b] ^ v[c], 63);
}

function compress(state, block, byteCount, last) {
  const words = Array.from({ length: 16 }, (_unused, index) => readWord(block, index * 8));
  const v = [...state, ...IV];
  v[12] ^= byteCount & MASK_64;
  v[13] ^= byteCount >> 64n;
  if (last) v[14] = (~v[14]) & MASK_64;

  for (const permutation of SIGMA) {
    mix(v, 0, 4, 8, 12, words[permutation[0]], words[permutation[1]]);
    mix(v, 1, 5, 9, 13, words[permutation[2]], words[permutation[3]]);
    mix(v, 2, 6, 10, 14, words[permutation[4]], words[permutation[5]]);
    mix(v, 3, 7, 11, 15, words[permutation[6]], words[permutation[7]]);
    mix(v, 0, 5, 10, 15, words[permutation[8]], words[permutation[9]]);
    mix(v, 1, 6, 11, 12, words[permutation[10]], words[permutation[11]]);
    mix(v, 2, 7, 8, 13, words[permutation[12]], words[permutation[13]]);
    mix(v, 3, 4, 9, 14, words[permutation[14]], words[permutation[15]]);
  }

  for (let index = 0; index < 8; index += 1) {
    state[index] = (state[index] ^ v[index] ^ v[index + 8]) & MASK_64;
  }
}

function blake2b(input, outputLength = 32) {
  if (!(input instanceof Uint8Array)) throw new TypeError('BLAKE2b input must be bytes');
  if (!Number.isInteger(outputLength) || outputLength < 1 || outputLength > 64) {
    throw new RangeError('BLAKE2b output length must be between 1 and 64 bytes');
  }

  const state = [...IV];
  state[0] ^= 0x01010000n ^ BigInt(outputLength);

  let offset = 0;
  while (offset + 128 < input.length) {
    compress(state, input.slice(offset, offset + 128), BigInt(offset + 128), false);
    offset += 128;
  }
  const finalBlock = new Uint8Array(128);
  finalBlock.set(input.slice(offset));
  compress(state, finalBlock, BigInt(input.length), true);

  const output = new Uint8Array(outputLength);
  for (let index = 0; index < outputLength; index += 1) {
    output[index] = Number((state[Math.floor(index / 8)] >> BigInt((index % 8) * 8)) & 0xffn);
  }
  return output;
}

module.exports = { blake2b };
