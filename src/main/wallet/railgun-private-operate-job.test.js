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
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const boundOf = (capsule) =>
  new Interface([TRANSACT_ABI]).decodeFunctionData(
    'transact',
    capsule.preparation.transaction.data
  )[0][0].boundParams;
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
      boundParams: boundOf(capsule),
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

test('partial binds prover kind and emits v2 only after private/public/ciphertext reconstruction equivalence', async () => {
  const capsule =
    require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunPartialCapsuleData()
      .capsule;
  input.privateIntent = capsule.selection;
  prepared.publicPreparation = capsule.preparation;
  prepared.witness.boundParams =
    require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunPartialCapsuleData().inner.boundParams;
  reconstructed = {
    ...prepared,
    witness: { ...prepared.witness, boundParams: boundOf(capsule) },
  };
  mockReconstruct.mockResolvedValue(reconstructed);
  restored.exchangePrivateIntent.mockImplementation(async ({ capsule: received }) => {
    expect(received.version).toBe(2);
    expect(received.preparation).toEqual(capsule.preparation);
    expect(mockProver).toHaveBeenCalledWith(
      expect.objectContaining({ intentKind: 'railgun-partial-unshield' })
    );
    expect(mockProver.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrepare.mock.invocationCallOrder[0]
    );
    return { status: 'signed', signature: { test: true } };
  });
  const value = await run(JSON.stringify(input), {});
  expect(value.privateOperation.status).toBe('proved');
  expect(prover.prove).toHaveBeenCalledWith(reconstructed, { test: true });
  expect(prover.close).toHaveBeenCalledTimes(1);
});
test('retained ciphertext mismatch refuses before any signature exchange', async () => {
  const bound = prepared.witness.boundParams.toObject(true);
  bound.adaptParams = '0x' + '01'.repeat(32);
  mockReconstruct.mockResolvedValue({
    ...reconstructed,
    witness: { ...prepared.witness, boundParams: bound },
  });
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
  expect(prover.prove).not.toHaveBeenCalled();
  expect(prover.close).toHaveBeenCalledTimes(1);
});
test('cancellation during reconstruction prevents signature exchange and closes loaded artifacts', async () => {
  const controller = new AbortController();
  restored.signal = controller.signal;
  mockReconstruct.mockImplementation(async () => {
    controller.abort();
    return reconstructed;
  });
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
  expect(prover.prove).not.toHaveBeenCalled();
  expect(prover.close).toHaveBeenCalledTimes(1);
});
test('legacy operation explicitly binds its original prover kind', async () => {
  await run(JSON.stringify(input), {});
  expect(mockProver).toHaveBeenCalledWith(
    expect.objectContaining({ intentKind: input.privateIntent.kind })
  );
  expect(mockReconstruct.mock.calls[0][0].capsule.version).toBe(1);
});

test('different reconstructed ciphertext refuses before signature even when public witness inputs agree', async () => {
  const f =
    require('../../../scripts/fixtures/railgun-partial-capsule-data').createRailgunPartialCapsuleData();
  input.privateIntent = f.capsule.selection;
  prepared.publicPreparation = f.capsule.preparation;
  prepared.witness.boundParams = boundOf(f.capsule);
  f.inner.boundParams.commitmentCiphertext[0].ciphertext[0] = '0x' + '99'.repeat(32);
  mockReconstruct.mockResolvedValue({
    ...prepared,
    witness: { ...prepared.witness, boundParams: f.inner.boundParams },
  });
  await expect(run(JSON.stringify(input), {})).rejects.toThrow();
  expect(restored.exchangePrivateIntent).not.toHaveBeenCalled();
  expect(prover.prove).not.toHaveBeenCalled();
  expect(prover.close).toHaveBeenCalledTimes(1);
});
