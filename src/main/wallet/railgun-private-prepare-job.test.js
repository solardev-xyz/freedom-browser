const mockWallet = jest.fn(),
  mockPrepare = jest.fn();
jest.mock('./railgun-wallet-job', () => ({ withWallet: (...args) => mockWallet(...args) }));
jest.mock('./railgun-private-witness', () => ({
  prepareRailgunPrivateWitness: (...args) => mockPrepare(...args),
}));
const { run } = require('./railgun-private-prepare-job');
beforeEach(() => {
  jest.resetAllMocks();
});
test('refuses writable scans or absent selection before entering a key-holding runtime', async () => {
  for (const input of [{ restore: false, privateIntent: {} }, { restore: true }])
    await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(mockWallet).not.toHaveBeenCalled();
  expect(mockPrepare).not.toHaveBeenCalled();
});
test('only public preparation crosses the result boundary; the witness stays in the callback', async () => {
  const publicPreparation = { transaction: { data: 'public intent' } },
    selection = { tree: 0 };
  const restored = { wallet: {}, signal: new AbortController().signal };
  mockPrepare.mockResolvedValue({
    publicPreparation,
    witness: { secret: 'private witness' },
    transaction: { secret: true },
  });
  mockWallet.mockImplementation(async (text, context, purpose, prepare) => {
    expect(JSON.parse(text)).toEqual({ restore: true, privateIntent: selection });
    expect(context).toEqual({ host: true });
    expect(purpose).toBe('private-prepare');
    return prepare(restored);
  });
  const result = await run(JSON.stringify({ restore: true, privateIntent: selection }), {
    host: true,
  });
  expect(result).toEqual({ privatePreparation: publicPreparation });
  expect(JSON.stringify(result)).not.toContain('secret');
  expect(mockPrepare).toHaveBeenCalledWith({ ...restored, selection });
});
test('preparation failure propagates without creating a public result', async () => {
  mockWallet.mockImplementation((_text, _context, _purpose, prepare) => prepare({}));
  mockPrepare.mockRejectedValue(Error('invalid Merkle path'));
  await expect(run(JSON.stringify({ restore: true, privateIntent: {} }), {})).rejects.toThrow(
    'invalid Merkle path'
  );
});
