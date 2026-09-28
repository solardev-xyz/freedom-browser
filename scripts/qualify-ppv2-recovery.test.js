const { abi, applyTreeEvent } = require('./qualify-ppv2-recovery');
const event = (name, values) => abi.parseLog(abi.encodeEventLog(abi.getEvent(name), values));
test('public recovery replays actual pool batches and keystore inserts/updates', () => {
  const leaves = [];
  expect(applyTreeEvent(leaves, event('LeavesInserted', [[10, 11], 100, 0]))).toBe(100n);
  applyTreeEvent(leaves, event('LeafInserted', [12, 101, 2]));
  applyTreeEvent(leaves, event('LeafUpdated', [13, 102, 1]));
  expect(leaves).toEqual(['0xa', '0xd', '0xc']);
});
test.each([
  ['LeavesInserted', [[1], 100, 1]], ['LeavesInserted', [[], 100, 0]],
  ['LeafInserted', [1, 100, 1]], ['LeafUpdated', [1, 100, 0]],
])('refuses missing or out-of-order %s history', (name, values) => {
  expect(() => applyTreeEvent([], event(name, values))).toThrow();
});
