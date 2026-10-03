const { classifyRailgunTxidContinuity } = require('./railgun-txid-omissions');
const observed = () => ({
  index: 4188,
  precedingRoot: '29b951c81d6d0bd08e8b4657d6a6cc6409d9c2e30f6554b1c4d317dfc8fdf368',
  blockNumber: 11816741,
  txid: '4b78372a9f06a8ab7ccb8a02373d279fc385515139c6ef157d2fe79ee147e932',
  graphID:
    '0x0000000000000000000000000000000000000000000000000000000000b44f2500000000000000000000000000000000000000000000000000000000000000400000000000000000000000000000000000000000000000000000000000000000',
  firstNullifier: '0x1c2cf5a682d5ae2b1617b985a8bc31e3ebcd6c730907b7aa9c67d44763402cae',
  expected: '0xfbd11184128f1161139df47f15f76a22a3c64dd6fb8dc656421d7133fce42b0a',
  actual: '0x39dc4b897e3739eb2793437d1e272514314e08dc9e494d859da6a058d005ada8',
});
test('the investigated occurrence is classified without granting completeness or modifying its input', () => {
  const input = observed(),
    before = JSON.stringify(input);
  const value = classifyRailgunTxidContinuity(4229, [input]);
  expect(value.status).toBe('known-service-omission');
  expect(value.globalTxidCompleteness).toBe(false);
  expect(value.knownServiceOmissions[0].missingCommitmentPositions).toEqual([10136, 10137]);
  expect(Object.isFrozen(value.knownServiceOmissions[0].missingCommitmentPositions)).toBe(true);
  expect(JSON.stringify(input)).toBe(before);
});
test.each(Object.keys(observed()))(
  'changing %s cannot widen the exception to another omission',
  (field) => {
    const input = observed();
    input[field] = typeof input[field] === 'number' ? input[field] + 1 : input[field] + '0';
    expect(() => classifyRailgunTxidContinuity(4229, [input])).toThrow();
  }
);
test('extra, repeated, future, malformed and out-of-scope breaks refuse', () => {
  for (const [index, breaks] of [
    [4229, [observed(), observed()]],
    [4187, [observed()]],
    [4229, [{ ...observed(), approved: true }]],
    [4229, [null]],
    [4188, []],
    [4229, []],
    [-1, []],
    [65536, []],
    [1.5, []],
  ])
    expect(() => classifyRailgunTxidContinuity(index, breaks)).toThrow();
});
test('an unbroken observed stream still grants no global completeness claim', () => {
  for (const index of [0, 4187])
    expect(classifyRailgunTxidContinuity(index, [])).toEqual({
      status: 'unbroken-observed-stream',
      globalTxidCompleteness: false,
      knownServiceOmissions: [],
    });
});
