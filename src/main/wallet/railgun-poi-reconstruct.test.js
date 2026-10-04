const mockArchive = '/synthetic-poi-engine.asar';
let mockResolvePoseidon, mockPoseidon, mockSeenKey, mockController;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => mockArchive),
}));
jest.mock('./railgun-private-capsule', () => ({ normalizeRailgunPrivateCapsule: (v) => v }));
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockPoseidon;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    getPublicViewingKey: jest.fn(async (key) => {
      mockSeenKey = key;
      mockController.abort();
      return Buffer.alloc(32, 1);
    }),
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/wallet/view-only-wallet',
  () => ({}),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/erc20/shield-note-erc20',
  () => ({}),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({}),
  { virtual: true }
);
const { reconstructRailgunPoiNotes } = require('./railgun-poi-reconstruct');
const runtime = require('./railgun-engine-runtime');
const keys = require('/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils');
beforeEach(() => {
  jest.clearAllMocks();
  mockSeenKey = undefined;
  mockController = new AbortController();
  mockPoseidon = new Promise((resolve) => {
    mockResolvePoseidon = resolve;
  });
});
function args() {
  return {
    archive: mockArchive,
    descriptor: { spendingPublicKey: ['0'.repeat(64), '0'.repeat(64)] },
    viewingKey: Buffer.alloc(32, 7),
    capsule: { version: 1, selection: { kind: 'railgun-private-transfer' } },
    creator: {},
    signal: mockController.signal,
  };
}
test('cancellation after async key work wipes only the owned copy', async () => {
  const input = args();
  const running = reconstructRailgunPoiNotes(input);
  mockResolvePoseidon();
  await expect(running).rejects.toThrow();
  expect(mockSeenKey).not.toBe(input.viewingKey);
  expect(mockSeenKey.equals(Buffer.alloc(32))).toBe(true);
  expect(input.viewingKey.equals(Buffer.alloc(32, 7))).toBe(true);
});
test('caller mutation during engine initialization cannot replace captured key or descriptor', async () => {
  const input = args();
  const running = reconstructRailgunPoiNotes(input);
  input.viewingKey.fill(9);
  input.descriptor.spendingPublicKey[0] = 'not hex';
  let observed;
  keys.getPublicViewingKey.mockImplementationOnce(async (key) => {
    mockSeenKey = key;
    observed = Buffer.from(key);
    mockController.abort();
    return Buffer.alloc(32, 1);
  });
  mockResolvePoseidon();
  await expect(running).rejects.toThrow();
  expect(observed.equals(Buffer.alloc(32, 7))).toBe(true);
  expect(mockSeenKey.equals(Buffer.alloc(32))).toBe(true);
  expect(input.viewingKey.equals(Buffer.alloc(32, 9))).toBe(true);
});
test('pre-aborted and oversized data refuse before engine or key work', async () => {
  mockController.abort();
  await expect(reconstructRailgunPoiNotes(args())).rejects.toThrow();
  mockController = new AbortController();
  await expect(
    reconstructRailgunPoiNotes({ ...args(), creator: { text: 'x'.repeat(65536) } })
  ).rejects.toThrow();
  expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(keys.getPublicViewingKey).not.toHaveBeenCalled();
});
test('abort during engine initialization prevents any key-derived work', async () => {
  const input = args();
  const running = reconstructRailgunPoiNotes(input);
  mockController.abort();
  mockResolvePoseidon();
  await expect(running).rejects.toThrow();
  expect(keys.getPublicViewingKey).not.toHaveBeenCalled();
  expect(input.viewingKey.equals(Buffer.alloc(32, 7))).toBe(true);
});

test('normalized v2 partial capsule refuses before runtime and any owned viewing-key copy', async () => {
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const capsule = jest
    .requireActual('./railgun-private-capsule')
    .normalizeRailgunPrivateCapsule(createRailgunPartialCapsuleData().capsule);
  const input = { ...args(), capsule };
  mockResolvePoseidon();
  await expect(reconstructRailgunPoiNotes(input)).rejects.toThrow();
  expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(keys.getPublicViewingKey).not.toHaveBeenCalled();
  expect(mockSeenKey).toBeUndefined();
  expect(input.viewingKey.equals(Buffer.alloc(32, 7))).toBe(true);
});
