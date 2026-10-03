const mockArchive = '/synthetic-poi-assembly.asar';
let mockController, mockGate, mockRelease, mockSeen, mockObserved;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => mockArchive),
}));
jest.mock('./railgun-own-txid', () => ({
  matchRailgunOwnTxid: jest.fn((v) => ({ row: v.row, output: { kind: 'shielded' } })),
}));
jest.mock('./railgun-txid-note-witness', () => ({
  normalizeRailgunTxidWitness: jest.fn((v) => v),
}));
jest.mock('./railgun-txid-projection', () => ({
  createRailgunTxidProjection: () => ({ verifyWitness: jest.fn() }),
}));
jest.mock('./railgun-poi-reconstruct', () => ({
  reconstructRailgunPoiNotes: jest.fn(async (args) => {
    mockSeen = args.viewingKey;
    mockObserved = {
      key: Buffer.from(args.viewingKey),
      creator: structuredClone(args.creator),
      capsule: structuredClone(args.capsule),
    };
    mockController.abort();
    return {};
  }),
}));
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockGate;
    },
    poseidonHex: jest.fn(),
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-assembly.asar/node_modules/@railgun-community/engine/dist/transaction/railgun-txid',
  () => ({}),
  { virtual: true }
);
const { prepareRailgunPoiWitness } = require('./railgun-poi-witness');
const runtime = require('./railgun-engine-runtime');
const reconstruct = require('./railgun-poi-reconstruct').reconstructRailgunPoiNotes;
const zero = '0'.repeat(64);
function args() {
  return {
    archive: mockArchive,
    descriptor: {},
    viewingKey: Buffer.alloc(32, 7),
    creator: { marker: 'original' },
    ownEvidence: {
      capsule: { marker: 'original' },
      record: {},
      transaction: {},
      receipt: {},
      row: {},
    },
    state: {},
    witness: { row: {} },
    listProofs: [{ leaf: zero, root: zero, indices: zero, elements: Array(16).fill(zero) }],
    signal: mockController.signal,
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockController = new AbortController();
  mockSeen = mockObserved = undefined;
  mockGate = new Promise((resolve) => {
    mockRelease = resolve;
  });
});
test('assembly keeps one captured input and private key copy across async work and wipes on cancellation', async () => {
  const input = args();
  const promise = prepareRailgunPoiWitness(input);
  input.viewingKey.fill(9);
  input.creator.marker = 'changed';
  input.ownEvidence.capsule.marker = 'changed';
  mockRelease();
  await expect(promise).rejects.toMatchObject({ code: 'RAILGUN_POI_WITNESS_REFUSED' });
  expect(mockObserved.key.equals(Buffer.alloc(32, 7))).toBe(true);
  expect(mockObserved.creator.marker).toBe('original');
  expect(mockObserved.capsule.marker).toBe('original');
  expect(mockSeen.equals(Buffer.alloc(32))).toBe(true);
  expect(input.viewingKey.equals(Buffer.alloc(32, 9))).toBe(true);
});
test.each(['marker', 'outputPosition', 'listKey'])(
  'caller %s override refuses before engine/key work',
  async (name) => {
    await expect(prepareRailgunPoiWitness({ ...args(), [name]: 'override' })).rejects.toMatchObject(
      { code: 'RAILGUN_POI_WITNESS_REFUSED' }
    );
    expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
    expect(reconstruct).not.toHaveBeenCalled();
  }
);
test.each(['oversize', 'index', 'field', 'extra-proof', 'aborted'])(
  'bounded %s refusal sanitizes errors before engine work',
  async (mode) => {
    const input = args();
    if (mode === 'oversize') input.creator.text = 'secret-sentinel'.repeat(20000);
    if (mode === 'index') input.listProofs[0].indices = '1'.padEnd(64, '0');
    if (mode === 'field') input.listProofs[0].root = 'f'.repeat(64);
    if (mode === 'extra-proof') input.listProofs.push(input.listProofs[0]);
    if (mode === 'aborted') mockController.abort();
    await expect(prepareRailgunPoiWitness(input)).rejects.toMatchObject({
      message: 'Railgun POI witness unavailable',
      code: 'RAILGUN_POI_WITNESS_REFUSED',
    });
    expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  }
);
