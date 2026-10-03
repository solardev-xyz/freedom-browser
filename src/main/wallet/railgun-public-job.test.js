const { run } = require('./railgun-public-job');
const { QUALIFIED_THROUGH } = require('./railgun-public-policy');
const input = () => ({
  mode: 'apply',
  archive: '/not-an-authenticated-archive.asar',
  qualifiedThrough: QUALIFIED_THROUGH,
  plan: {},
});
test.each(['mode', 'extra-key', 'ceiling'])(
  'job refuses %s before requesting source or loading an archive',
  async (kind) => {
    const value = input(),
      request = jest.fn();
    if (kind === 'mode') value.mode = 'sign';
    if (kind === 'extra-key') value.crashPhase = 'commitments';
    if (kind === 'ceiling') value.qualifiedThrough++;
    await expect(run(JSON.stringify(value), { request })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  }
);
test.each(['batch', 'count', 'bytes'])(
  'job refuses oversized %s before loading apply runtime',
  async (kind) => {
    let calls = 0;
    const request = jest.fn(async (wire) => {
      const { id, method } = JSON.parse(wire);
      expect(method).toBe('sourceNext');
      calls++;
      if (calls > 33) throw Error('test source exceeded expected bound');
      const value =
        kind === 'batch'
          ? Array(129).fill({})
          : kind === 'bytes'
            ? [{ value: 'x'.repeat(4 * 1024 * 1024 + 4096) }]
            : Array(128).fill({});
      return JSON.stringify({ id, value });
    });
    await expect(run(JSON.stringify(input()), { request })).rejects.toThrow();
    expect(calls).toBe(kind === 'count' ? 33 : 1);
  }
);
test('runtime refuses the inherited test environment before opening the archive', async () => {
  const request = jest.fn();
  await expect(
    run(JSON.stringify({ ...input(), mode: 'plan', plan: undefined, storeId: 'a'.repeat(64) }), {
      request,
    })
  ).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
});
