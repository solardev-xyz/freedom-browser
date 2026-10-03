const { normalizeRailgunSignature } = require('./railgun-private-signature');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const value = () => ({ R8: [hex(1n), hex(2n)], S: hex(3n) });
test('copies and freezes signature coordinates without attesting cryptographic validity', () => {
  const input = value(),
    result = normalizeRailgunSignature(input);
  input.R8[0] = hex(4n);
  expect(result).toEqual(value());
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.R8)).toBe(true);
});
test.each(['shape', 'extra', 'length', 'field', 'subgroup', 'negative', 'number', 'uppercase'])(
  'rejects malformed signature %s',
  (mode) => {
    let input = value();
    if (mode === 'shape') input = [];
    if (mode === 'extra') input.secret = 'not permitted';
    if (mode === 'length') input.R8.push(hex(3n));
    if (mode === 'field')
      input.R8[0] =
        hex(21888242871839275222246405745257275088548364400416034343698204186575808495617n);
    if (mode === 'subgroup')
      input.S = hex(2736030358979909402780800718157159386076813972158567259200215660948447373041n);
    if (mode === 'negative') input.S = '-1';
    if (mode === 'number') input.S = 1;
    if (mode === 'uppercase') input.R8[0] = hex(10n).toUpperCase();
    expect(() => normalizeRailgunSignature(input)).toThrow();
  }
);
