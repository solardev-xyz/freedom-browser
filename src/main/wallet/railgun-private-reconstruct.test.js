const { reconstructRailgunPrivateWitness } = require('./railgun-private-reconstruct');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const {
  createRailgunPartialCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn() }));

test('unsupported capsule version refuses before runtime, wallet or note access', async () => {
  const capsule = normalizeRailgunPrivateCapsule(createRailgunPartialCapsuleData().capsule);
  const wallet = { getAddress: jest.fn(), TXOs: jest.fn(), getNullifyingKey: jest.fn() };
  await expect(
    reconstructRailgunPrivateWitness({
      archive: '/engine.asar',
      wallet,
      descriptor: { walletId: capsule.walletId },
      scan: {},
      capsule: { ...capsule, version: 3 },
      signal: new AbortController().signal,
    })
  ).rejects.toThrow();
  expect(require('./railgun-engine-runtime').verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  for (const method of Object.values(wallet)) expect(method).not.toHaveBeenCalled();
});
