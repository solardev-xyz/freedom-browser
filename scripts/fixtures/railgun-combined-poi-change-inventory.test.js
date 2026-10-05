jest.mock('./railgun-native-assertions', () => ({ assert: require('assert/strict') }));
const { assertChanges } = require('./railgun-combined-poi-change-inventory');
const before = {
  wallet: 'a',
  journal: 'b',
  catalog: 'c',
  poi: 'd',
  capsules: 'e',
  reservations: 'f',
  enrollment: 'g',
  source: 'h',
};
const allowed = { wallet: 'walletAndCoverage', journal: 'walletJournal' };
test('only exact wallet/journal paths may change, without exposing paths', () => {
  expect(assertChanges(before, { ...before, wallet: 'new', journal: 'new' }, allowed)).toEqual([
    'walletAndCoverage',
    'walletJournal',
  ]);
  expect(assertChanges(before, before, allowed)).toEqual([]);
});
test.each(['catalog', 'poi', 'capsules', 'reservations', 'enrollment', 'source'])(
  'refuses changed protected %s bytes',
  (name) => {
    expect(() => assertChanges(before, { ...before, [name]: 'changed' }, allowed)).toThrow();
  }
);
test('rejects file addition and removal even under an allowed class', () => {
  expect(() => assertChanges(before, { ...before, extra: 'x' }, allowed)).toThrow();
  const after = { ...before };
  delete after.wallet;
  expect(() => assertChanges(before, after, allowed)).toThrow();
});
