const mockWallet = jest.fn(),
  mockPrepare = jest.fn(),
  mockProver = jest.fn(),
  mockReconstruct = jest.fn();
jest.mock('./railgun-wallet-job', () => ({ withWallet: (...args) => mockWallet(...args) }));
jest.mock('./railgun-private-witness', () => ({
  prepareRailgunPrivateWitness: (...args) => mockPrepare(...args),
}));
jest.mock('./railgun-private-prover', () => ({
  createRailgunPrivateProver: (...args) => mockProver(...args),
}));
jest.mock('./railgun-private-reconstruct', () => ({
  reconstructRailgunPrivateWitness: (...args) => mockReconstruct(...args),
}));
const { run } = require('./railgun-private-operate-job');
let input, restored, prepared, reconstructed, prover;
beforeEach(() => {
  jest.resetAllMocks();
  const capsule = require('../../../scripts/fixtures/railgun-capsule-data').capsule('1'.repeat(64));
  input = {
    restore: true,
    privateIntent: capsule.selection,
    privateOperation: { proverArchive: '/prover.asar', artifactDirectory: '/artifacts' },
  };
  restored = {
    archive: '/engine.asar',
    descriptor: { walletId: capsule.walletId, spendingPublicKey: ['1'.repeat(64), '2'.repeat(64)] },
    scan: { ownedPoi: [{ id: '0:1', hash: capsule.noteHash }] },
    signal: new AbortController().signal,
    exchangePrivateIntent: jest.fn(async () => ({ status: 'refused' })),
  };
  prepared = {
    witness: {
      privateInputs: { secret: true, pathElements: [capsule.pathElements.map(BigInt)] },
      publicInputs: { root: 1n },
    },
    transaction: { secret: true },
    publicPreparation: capsule.preparation,
  };
  prover = {
    prove: jest.fn(async () => ({ transaction: { public: true }, independentlyVerified: false })),
    close: jest.fn(),
  };
  reconstructed = { ...prepared, transaction: { reconstructed: true } };
  mockReconstruct.mockResolvedValue(reconstructed);
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
    expect(value.preparation).toBe(prepared.publicPreparation);
    expect(value.capsule.pathElements).toHaveLength(16);
    expect(mockReconstruct).toHaveBeenCalledTimes(1);
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
  expect(prover.prove).toHaveBeenCalledWith(reconstructed, signature);
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

test('a capsule that cannot recreate the original witness refuses before offering or signing', async () => {
  mockReconstruct.mockResolvedValue({
    ...reconstructed,
    witness: { ...prepared.witness, privateInputs: { different: true } },
  });
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
  expect(prover.prove).not.toHaveBeenCalled();
  expect(prover.close).toHaveBeenCalled();
});

test('public-input reconstruction mismatch refuses before offering', async () => {
  mockReconstruct.mockResolvedValue({
    ...reconstructed,
    witness: { ...prepared.witness, publicInputs: { root: 2n } },
  });
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
  expect(prover.close).toHaveBeenCalled();
});
