const { Utils } = jest.requireActual('@ethersphere/bee-js');
const { USABLE_BYTES_BY_DEPTH, usableBytesForDepth } = require('./batch-sizes');

describe('batch sizes (#1257)', () => {
  test("match bee-js's table for unencrypted batches with no erasure coding", () => {
    for (const [depth, bytes] of Object.entries(USABLE_BYTES_BY_DEPTH)) {
      // bee-js rounds its parsed figures up, so depth 34 comes out one byte over.
      expect(
        Math.abs(Utils.getStampEffectiveBytes(Number(depth), false, 0) - bytes)
      ).toBeLessThanOrEqual(1);
    }
  });

  test('cover depth 17 to 34 and nothing else', () => {
    expect(Object.keys(USABLE_BYTES_BY_DEPTH).map(Number)).toEqual(
      Array.from({ length: 18 }, (_, i) => 17 + i)
    );
    expect(usableBytesForDepth(20)).toBe(687_620_000);
    expect(usableBytesForDepth(16)).toBeNull();
    expect(usableBytesForDepth(35)).toBeNull();
    expect(usableBytesForDepth('20')).toBeNull();
    expect(usableBytesForDepth(null)).toBeNull();
  });
});
