const mockWallet = jest.fn(),
  mockPrepare = jest.fn(),
  mockProver = jest.fn();
jest.mock('./railgun-wallet-job', () => ({ withWallet: (...args) => mockWallet(...args) }));
jest.mock('./railgun-private-witness', () => ({
  prepareRailgunPrivateWitness: (...args) => mockPrepare(...args),
}));
jest.mock('./railgun-private-prover', () => ({
  createRailgunPrivateProver: (...args) => mockProver(...args),
}));
const { run } = require('./railgun-private-operate-job');
let input, restored, prepared, prover;
beforeEach(() => {
  jest.resetAllMocks();
  input = {
    restore: true,
    privateIntent: { selection: true },
    privateOperation: { proverArchive: '/prover.asar', artifactDirectory: '/artifacts' },
  };
  restored = {
    archive: '/engine.asar',
    descriptor: { spendingPublicKey: ['1'.repeat(64), '2'.repeat(64)] },
    signal: new AbortController().signal,
    exchangePrivateIntent: jest.fn(async () => ({ status: 'refused' })),
  };
  prepared = {
    witness: { secret: true },
    transaction: { secret: true },
    publicPreparation: { intent: 'public' },
  };
  prover = {
    prove: jest.fn(async () => ({ transaction: { public: true }, independentlyVerified: false })),
    close: jest.fn(),
  };
  mockProver.mockResolvedValue(prover);
  mockPrepare.mockResolvedValue(prepared);
  mockWallet.mockImplementation(async (_text, _context, purpose, use) => {
    expect(purpose).toBe('private-operate');
    return use(restored);
  });
});
test('loads prover before offering intent; refusal is normal and closes artifacts without exposing witness', async () => {
  restored.exchangePrivateIntent.mockImplementation(async (value) => {
    expect(mockProver).toHaveBeenCalledTimes(1);
    expect(value).toBe(prepared.publicPreparation);
    return { status: 'refused' };
  });
  const result = await run(JSON.stringify(input), {});
  expect(result).toEqual({
    privatePreparation: prepared.publicPreparation,
    privateOperation: { status: 'refused' },
  });
  expect(prover.prove).not.toHaveBeenCalled();
  expect(prover.close).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(result)).not.toContain('secret');
});
test('a signature is applied only to the retained witness and returns an independently unverified transaction', async () => {
  const signature = { R8: [], S: 'test' };
  restored.exchangePrivateIntent.mockResolvedValue({ status: 'signed', signature });
  const result = await run(JSON.stringify(input), {});
  expect(prover.prove).toHaveBeenCalledWith(prepared, signature);
  expect(result.privateOperation).toEqual({
    status: 'proved',
    transaction: { public: true },
    independentlyVerified: false,
  });
  expect(prover.close).toHaveBeenCalledTimes(1);
});
test.each([{ status: 'refused', extra: true }, { status: 'other' }, null])(
  'malformed authorization refuses and drains artifacts (%#)',
  async (response) => {
    restored.exchangePrivateIntent.mockResolvedValue(response);
    await expect(run(JSON.stringify(input), {})).rejects.toThrow();
    expect(prover.prove).not.toHaveBeenCalled();
    expect(prover.close).toHaveBeenCalledTimes(1);
  }
);
test('artifact loading failure never requests authorization', async () => {
  mockProver.mockRejectedValue(Error('artifact failure'));
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
});
test.each([{ restore: false }, { privateOperation: { extra: true } }, { privateIntent: null }])(
  'bad operation input refuses before wallet restoration (%#)',
  async (change) => {
    await expect(run(JSON.stringify({ ...input, ...change }), {})).rejects.toThrow();
    expect(mockWallet).not.toHaveBeenCalled();
  }
);
