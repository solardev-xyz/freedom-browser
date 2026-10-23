// The renderer's reading of a personal_sign message must be main's
// (signing-utils.js): the 32-byte rule (#89) is decided on both sides.
describe('personal-sign', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('./personal-sign.js');
  });

  test('bytes as main signs them', () => {
    expect(Array.from(mod.personalSignBytes('0x00ff'))).toEqual([0, 255]);
    expect(Array.from(mod.personalSignBytes('0xABcd'))).toEqual([0xab, 0xcd]);
    expect(Array.from(mod.personalSignBytes('hé'))).toEqual([0x68, 0xc3, 0xa9]);
    expect(Array.from(mod.personalSignBytes('0X00'))).toEqual([0x30, 0x58, 0x30, 0x30]);
    expect(mod.personalSignBytes('0x0')).toBeNull();
    expect(mod.personalSignBytes('0x41zz42')).toBeNull();
    expect(mod.personalSignBytes(42)).toBeNull();
    expect(mod.bytesToHex(new Uint8Array([0, 0xab]))).toBe('0x00ab');
  });

  test('the same 32-byte rule as main', () => {
    const main = require('../../../main/wallet/signing-utils.js');
    for (const message of [
      '0x' + 'ab'.repeat(32),
      '0x' + 'AB'.repeat(32),
      'x'.repeat(32),
      'é'.repeat(16),
      '🔐'.repeat(8),
      '0x' + 'ab'.repeat(31),
      '0x' + 'ab'.repeat(33),
      'x'.repeat(31),
      'x'.repeat(33),
      'ab'.repeat(32),
      '0X' + 'ab'.repeat(32),
      '0x' + 'zz'.repeat(32),
      '',
      [1, 2, 3],
      undefined,
    ]) {
      expect([message, mod.signsRawHash(message)]).toEqual([message, main.signsRawHash(message)]);
    }
    expect(mod.RAW_HASH_LENGTH).toBe(main.RAW_HASH_LENGTH);
  });
});
