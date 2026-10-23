// signsRawHash (#89): what a personal_sign signs, as main normalizes it, is
// compared with 32 bytes, the length whose EIP-191 signature is exactly a
// Swarm feed update's.
const { signsRawHash, RAW_HASH_LENGTH } = require('./signing-utils');

describe('signsRawHash', () => {
  test('exactly 32 bytes as signed, given as hex or as text', () => {
    expect(RAW_HASH_LENGTH).toBe(32);
    expect(signsRawHash('0x' + '00'.repeat(32))).toBe(true);
    expect(signsRawHash('0x' + 'Ab'.repeat(32))).toBe(true);
    expect(signsRawHash('y'.repeat(32))).toBe(true);
    // UTF-8 bytes, not characters: 16 two-byte and 8 four-byte characters.
    expect(signsRawHash('é'.repeat(16))).toBe(true);
    expect(signsRawHash('🔐'.repeat(8))).toBe(true);
  });

  test('any other length does not', () => {
    for (const message of [
      '',
      '0x',
      '0x' + '00'.repeat(31),
      '0x' + '00'.repeat(33),
      'y'.repeat(31),
      'y'.repeat(33),
      'é'.repeat(32),
      // 64 hex digits without 0x, or with 0X, are text: 64 and 66 bytes.
      'ab'.repeat(32),
      '0X' + 'ab'.repeat(32),
    ]) {
      expect(signsRawHash(message)).toBe(false);
    }
  });

  test('malformed hex does not count (signing refuses it); a non-string does', () => {
    expect(signsRawHash('0x' + 'zz'.repeat(32))).toBe(false);
    expect(signsRawHash('0x' + 'a'.repeat(63))).toBe(false);
    expect(signsRawHash(Array(32).fill(0))).toBe(true);
    expect(signsRawHash(new Uint8Array(32))).toBe(true);
    expect(signsRawHash(undefined)).toBe(true);
  });
});
