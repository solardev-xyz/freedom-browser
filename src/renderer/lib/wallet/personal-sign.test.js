// The approval screen turns main's hex back into what it shows
// (freedom-core #88): text when the bytes are UTF-8, hex otherwise.
describe('personal-sign', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('./personal-sign.js');
  });

  test('hex to bytes, strictly', () => {
    expect(Array.from(mod.hexToBytes('0x00ff'))).toEqual([0, 255]);
    expect(Array.from(mod.hexToBytes('0xABcd'))).toEqual([0xab, 0xcd]);
    expect(Array.from(mod.hexToBytes('0x'))).toEqual([]);
    for (const bad of ['0x0', '0x41zz42', 'ab', 42, null]) {
      expect(mod.hexToBytes(bad)).toBeNull();
    }
    expect(mod.bytesToHex(new Uint8Array([0, 0xab]))).toBe('0x00ab');
  });

  test('text only when the bytes are well-formed UTF-8', () => {
    expect(mod.utf8Text(mod.hexToBytes('0x68c3a9'))).toBe('hé');
    expect(mod.utf8Text(mod.hexToBytes('0x'))).toBe('');
    expect(mod.utf8Text(mod.hexToBytes('0xfffefd00'))).toBeNull();
    expect(mod.utf8Text(mod.hexToBytes('0xc3'))).toBeNull();
    expect(mod.utf8Text(null)).toBeNull();
  });
});
