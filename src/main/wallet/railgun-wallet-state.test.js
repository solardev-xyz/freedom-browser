const { inspectRailgunWalletState } = require('./railgun-wallet-state');
function fixture(rows) {
  const buffers = rows.map(([key, value]) => [Buffer.from(key), Buffer.from(value)]);
  let position = 0;
  const close = jest.fn();
  return {
    buffers,
    close,
    store: {
      getInstanceId: () => 'a'.repeat(64),
      openSnapshot: () => ({ close, next: () => buffers[position++] ?? null }),
    },
  };
}
test('canonical binary digest survives reopening and wipes every copied row', () => {
  const first = fixture([
      ['a', 'one'],
      ['b', 'two'],
    ]),
    second = fixture([
      ['a', 'one'],
      ['b', 'two'],
    ]);
  const result = inspectRailgunWalletState(first.store);
  expect(result).toEqual(inspectRailgunWalletState(second.store));
  expect(result).toMatchObject({
    schema: 'wallet-store-v1',
    storeId: 'a'.repeat(64),
    count: 2,
    bytes: 8,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(first.buffers.flat().every((value) => value.equals(Buffer.alloc(value.length)))).toBe(
    true
  );
});
test('length framing distinguishes ambiguous key/value concatenations', () => {
  expect(inspectRailgunWalletState(fixture([['a', 'bc']]).store).sha256).not.toBe(
    inspectRailgunWalletState(fixture([['ab', 'c']]).store).sha256
  );
});
test.each(
  [
    [
      ['b', 'two'],
      ['a', 'one'],
    ],
    [
      ['a', 'one'],
      ['a', 'two'],
    ],
    [['', 'one']],
    [['a', Buffer.alloc(1024 * 1024 + 1)]],
  ].map((rows) => [rows])
)('invalid store ordering or bounds cannot issue a digest', (rows) => {
  const value = fixture(rows);
  expect(() => inspectRailgunWalletState(value.store)).toThrow();
  expect(value.close).toHaveBeenCalledTimes(1);
});
test('identity is mandatory and an empty authenticated cache remains distinguishable', () => {
  const empty = fixture([]);
  expect(inspectRailgunWalletState(empty.store)).toMatchObject({ count: 0, bytes: 0 });
  empty.store.getInstanceId = () => null;
  expect(() => inspectRailgunWalletState(empty.store)).toThrow();
});
