let mockInstances;
jest.mock('./railgun-kohaku-plugin', () => ({
  assertRailgunKohakuPrivatePlugin: (plugin) => {
    if (!mockInstances.has(plugin)) throw Error('Railgun Kohaku operation unavailable');
  },
  broadcastRailgunKohakuOperation: (plugin, operation) => mockInstances.get(plugin)(operation),
}));
const { createRailgunKohakuBroadcaster } = require('./railgun-kohaku-broadcaster');
beforeEach(() => {
  mockInstances = new WeakMap();
});
test('fixed broadcaster shape binds exact genuine instance without a transport option', async () => {
  const plugin = Object.freeze({}),
    operation = Object.freeze({ __type: 'privateOperation' });
  const result = Object.freeze({ status: 'unknown' }),
    submit = jest.fn(async () => result);
  mockInstances.set(plugin, submit);
  const broadcaster = createRailgunKohakuBroadcaster(plugin);
  expect(Object.keys(broadcaster)).toEqual(['broadcast']);
  expect(Object.isFrozen(broadcaster)).toBe(true);
  expect(await broadcaster.broadcast(operation)).toBe(result);
  expect(submit).toHaveBeenCalledWith(operation);
});
test.each([null, undefined, {}, { prepareTransfer() {} }])(
  'rejects unregistered plugin %p at construction',
  (plugin) => {
    expect(() => createRailgunKohakuBroadcaster(plugin)).toThrow(
      'Railgun Kohaku operation unavailable'
    );
  }
);
test('does not flatten controller rejection into success or void', async () => {
  const plugin = {},
    error = Error('bounded refusal');
  mockInstances.set(
    plugin,
    jest.fn(async () => {
      throw error;
    })
  );
  await expect(createRailgunKohakuBroadcaster(plugin).broadcast({})).rejects.toBe(error);
});
