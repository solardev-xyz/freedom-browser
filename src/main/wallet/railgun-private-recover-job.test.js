const mockWallet = jest.fn(),
  mockReconstruct = jest.fn(),
  mockProver = jest.fn(),
  mockPrepare = jest.fn();
jest.mock('./railgun-wallet-job', () => ({ withWallet: (...args) => mockWallet(...args) }));
jest.mock('./railgun-private-reconstruct', () => ({
  reconstructRailgunPrivateWitness: (...args) => mockReconstruct(...args),
}));
jest.mock('./railgun-private-prover', () => ({
  createRailgunPrivateProver: (...args) => mockProver(...args),
}));
jest.mock('./railgun-private-witness', () => ({
  prepareRailgunPrivateWitness: (...args) => mockPrepare(...args),
}));
const { run } = require('./railgun-private-recover-job');
const fixture = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let input, restored, prover, reconstructed, controller;
beforeEach(() => {
  jest.resetAllMocks();
  const { capsule } = fixture.createRailgunLegacyCapsuleData();
  controller = new AbortController();
  input = {
    restore: true,
    walletId: capsule.walletId,
    privateRecovery: {
      capsule,
      signature: { R8: [hex(1), hex(2)], S: hex(3) },
      proverArchive: '/prover.asar',
      artifactDirectory: '/artifacts',
    },
  };
  restored = {
    archive: '/engine.asar',
    descriptor: { walletId: capsule.walletId, spendingPublicKey: ['1'.repeat(64), '2'.repeat(64)] },
    signal: controller.signal,
  };
  reconstructed = {
    witness: { privateInputs: { secret: true } },
    publicPreparation: capsule.preparation,
  };
  prover = {
    prove: jest.fn(async () => ({
      transaction: { public: true },
      transactionDigest: 'checked',
      independentlyVerified: false,
    })),
    close: jest.fn(),
  };
  mockReconstruct.mockResolvedValue(reconstructed);
  mockProver.mockResolvedValue(prover);
  mockWallet.mockImplementation(async (_text, _ctx, purpose, use) => {
    expect(purpose).toBe('private-recover');
    return use(restored);
  });
});
test.each(['railgun-private-transfer', 'railgun-token-unshield', 'railgun-partial-unshield'])(
  '%s uses only original capsule and signature with no prepare or authorization exchange',
  async (kind) => {
    const { capsule } =
      kind === 'railgun-partial-unshield'
        ? fixture.createRailgunPartialCapsuleData()
        : fixture.createRailgunLegacyCapsuleData(kind);
    input.privateRecovery.capsule = capsule;
    const value = await run(JSON.stringify(input), {});
    expect(mockReconstruct).toHaveBeenCalledWith(expect.objectContaining({ capsule }));
    expect(mockProver).toHaveBeenCalledWith(
      expect.objectContaining({
        intentKind: kind,
        proverArchive: '/prover.asar',
        artifactDirectory: '/artifacts',
      })
    );
    expect(prover.prove).toHaveBeenCalledWith(reconstructed, input.privateRecovery.signature);
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(value).toEqual({
      privateRecovery: {
        status: 'proved',
        transaction: { public: true },
        transactionDigest: 'checked',
        independentlyVerified: false,
      },
    });
    expect(JSON.stringify(value)).not.toContain('secret');
    expect(prover.close).toHaveBeenCalledTimes(1);
  }
);
test.each([
  'restore',
  'privateIntent',
  'privateOperation',
  'missing-signature',
  'extra-option',
  'foreign-wallet',
])('invalid %s input never restores or borrows a viewing key', async (mode) => {
  if (mode === 'restore') input.restore = false;
  if (mode === 'privateIntent') input.privateIntent = {};
  if (mode === 'privateOperation') input.privateOperation = {};
  if (mode === 'missing-signature') delete input.privateRecovery.signature;
  if (mode === 'extra-option') input.privateRecovery.onIntent = true;
  if (mode === 'foreign-wallet') input.walletId = '2'.repeat(64);
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(mockWallet).not.toHaveBeenCalled();
});
test.each(['reconstruct', 'artifacts', 'proof'])(
  '%s failure closes loaded prover and never prepares',
  async (stage) => {
    if (stage === 'reconstruct') mockReconstruct.mockRejectedValue(Error('refused'));
    if (stage === 'artifacts') mockProver.mockRejectedValue(Error('refused'));
    if (stage === 'proof') prover.prove.mockRejectedValue(Error('refused'));
    await expect(run(JSON.stringify(input), {})).rejects.toThrow();
    expect(mockPrepare).not.toHaveBeenCalled();
    expect(prover.close).toHaveBeenCalledTimes(stage === 'proof' ? 1 : 0);
  }
);
test.each(['reconstruct', 'artifacts', 'proof'])(
  'cancellation during %s never emits a recovery result',
  async (stage) => {
    if (stage === 'reconstruct')
      mockReconstruct.mockImplementation(async () => {
        controller.abort();
        return reconstructed;
      });
    if (stage === 'artifacts')
      mockProver.mockImplementation(async () => {
        controller.abort();
        return prover;
      });
    if (stage === 'proof')
      prover.prove.mockImplementation(async () => {
        controller.abort();
        return { transaction: {} };
      });
    await expect(run(JSON.stringify(input), {})).rejects.toThrow();
    expect(prover.close).toHaveBeenCalledTimes(stage === 'reconstruct' ? 0 : 1);
    if (stage !== 'proof') expect(prover.prove).not.toHaveBeenCalled();
  }
);
test('an injected authorization exchange surface refuses without reconstructing', async () => {
  restored.exchangePrivateIntent = jest.fn();
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(mockReconstruct).not.toHaveBeenCalled();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
});
