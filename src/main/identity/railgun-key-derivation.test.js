const { mnemonicToSeedSync } = require('@scure/bip39');
const { deriveRailgunKey } = require('./railgun-key-derivation');
// Public upstream test vectors, not wallet credentials. Engine revision
// 6e2614d53a106dd62abad91e7ce03ee4a3956138, key-derivation.test.ts.
const mnemonic =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
test.each([
  [mnemonic, "m/0'", '67d7d19d00e6e3b3517fe68ac46505dd207df6e8fe3aa06ba3face352e7599ef'],
  [mnemonic, "m/0'/1'", '3428cfc939320328501174a4e76e869197ffc894b58dbf4d0e953c484d66cb5e'],
  [
    'culture flower sunny seat maximum begin design magnet side permit coin dial alter insect whisper series desk power cream afford regular strike poem ostrich',
    "m/1984'/0'/1'/1'",
    'aea163e55754955eb4f982838a3cf4ecac53e809a7a81943a7ec7386426f9d5d',
  ],
])('matches engine private-key vector %#', (phrase, path, expected) => {
  const seed = mnemonicToSeedSync(phrase),
    before = Buffer.from(seed);
  const key = deriveRailgunKey(seed, path);
  expect(key.toString('hex')).toBe(expected);
  expect(Buffer.from(seed)).toEqual(before);
  key.fill(0);
  expect(deriveRailgunKey(seed, path).toString('hex')).toBe(expected);
  seed.fill(0);
});
test.each(['m', "m/01'", "m/2147483648'", "m/-1'", 'm/0', "m/0'/0'/0'/0'/0'/0'"])(
  'refuses noncanonical or overbroad derivation %s',
  (path) => {
    expect(() => deriveRailgunKey(new Uint8Array(64), path)).toThrow();
  }
);
