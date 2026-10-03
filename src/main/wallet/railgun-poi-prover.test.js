let mockPrepared, mockArtifacts, mockSerial, mockProve, mockDebug, mockScope, mockController;
jest.mock('./railgun-poi-witness', () => ({
  prepareRailgunPoiWitness: jest.fn(async () => mockPrepared),
}));
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => '/poi-engine.asar'),
}));
jest.mock('./railgun-prover-runtime', () => ({
  loadRailgunProverRuntime: jest.fn(() => mockSerial),
}));
jest.mock('./railgun-artifacts', () => ({
  loadRailgunArtifacts: jest.fn(async () => mockArtifacts),
}));
jest.mock('../networks/privacy-context', () => ({ createPrivacyScope: jest.fn(() => mockScope) }));
jest.mock(
  '/poi-engine.asar/node_modules/@railgun-community/engine/dist/debugger/debugger',
  () => ({ default: mockDebug }),
  { virtual: true }
);
jest.mock(
  '/poi-engine.asar/node_modules/@railgun-community/engine/dist/prover/prover',
  () => ({
    Prover: class {
      setSnarkJSGroth16() {}
      provePOI(...args) {
        return mockProve(...args);
      }
    },
  }),
  { virtual: true }
);
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
const proof = () => ({
  pi_a: ['1', '2'],
  pi_b: [
    ['3', '4'],
    ['5', '6'],
  ],
  pi_c: ['7', '8'],
});
let prove;
beforeEach(() => {
  jest.resetModules();
  mockController = new AbortController();
  globalThis.curve_bn128 = null;
  mockDebug = {};
  mockArtifacts = { wasm: Buffer.alloc(4, 1), zkey: Buffer.alloc(4, 2), vkey: {} };
  mockScope = { getContext: jest.fn(() => ({})), close: jest.fn() };
  mockPrepared = {
    inputs: { randomsIn: ['private-sentinel'] },
    blindedIn: [hex(1n)],
    blindedOut: [hex(2n)],
    listKey: require('./railgun-poi-records').REQUIRED_LIST,
    txidRootIndex: 6,
    expectedPublicInputs: {
      blindedCommitmentsOut: [2n, 0n, 0n],
      anyRailgunTxidMerklerootAfterTransaction: 5n,
      railgunTxidIfHasUnshield: 0n,
      poiMerkleroots: [3n, 4n, 4n],
    },
  };
  mockProve = jest.fn(async () => ({
    publicInputs: structuredClone(mockPrepared.expectedPublicInputs),
    proof: proof(),
  }));
  mockSerial = { fullProve: jest.fn(), verify: jest.fn(async (_v, signals) => signals[3] === 5n) };
  prove = require('./railgun-poi-prover').proveRailgunPoi;
});
afterEach(() => {
  delete globalThis.curve_bn128;
});
const options = () => ({
  archive: '/engine.asar',
  proverArchive: '/prover.asar',
  artifactDirectory: '/artifacts',
  signal: mockController.signal,
});
function wiped() {
  expect(mockArtifacts.wasm.equals(Buffer.alloc(4))).toBe(true);
  expect(mockArtifacts.zkey.equals(Buffer.alloc(4))).toBe(true);
  expect(mockScope.close).toHaveBeenCalledTimes(1);
}
test('only canonical public payload leaves after expected-signal verification and negative control', async () => {
  const result = await prove(options());
  expect(mockSerial.verify).toHaveBeenCalledTimes(2);
  expect(mockSerial.verify.mock.calls[0][1]).toEqual([2n, 0n, 0n, 5n, 0n, 3n, 4n, 4n]);
  expect(result.payload.txidMerklerootIndex).toBe(6);
  expect(result.payload.railgunTxidIfHasUnshield).toBe('0x00');
  expect(result.independentlyVerified).toBe(false);
  expect(result.disclosureEnabled).toBe(false);
  expect(JSON.stringify(result)).not.toContain('private-sentinel');
  expect(Object.isFrozen(result.payload.proof.pi_b[0])).toBe(true);
  wiped();
  await expect(prove(options())).rejects.toMatchObject({ code: 'RAILGUN_POI_PROOF_REFUSED' });
  expect(mockProve).toHaveBeenCalledTimes(1);
});
test.each(['missing-verify', 'missing-prove', 'debugger', 'workers'])(
  'refuses %s before proof/artifacts',
  async (mode) => {
    if (mode === 'missing-verify') delete mockSerial.verify;
    if (mode === 'missing-prove') delete mockSerial.fullProve;
    if (mode === 'debugger') mockDebug.engineDebugger = { log: jest.fn() };
    if (mode === 'workers') globalThis.curve_bn128 = {};
    await expect(prove(options())).rejects.toMatchObject({ code: 'RAILGUN_POI_PROOF_REFUSED' });
    expect(mockProve).not.toHaveBeenCalled();
    expect(require('./railgun-artifacts').loadRailgunArtifacts).not.toHaveBeenCalled();
  }
);
test.each(['always-true', 'always-false', 'changed-signal', 'malformed-proof', 'secret-error'])(
  'refuses %s and wipes artifacts',
  async (mode) => {
    if (mode === 'always-true') mockSerial.verify.mockResolvedValue(true);
    if (mode === 'always-false') mockSerial.verify.mockResolvedValue(false);
    if (mode === 'changed-signal')
      mockProve.mockImplementation(async () => ({
        publicInputs: { ...mockPrepared.expectedPublicInputs, railgunTxidIfHasUnshield: 1n },
        proof: proof(),
      }));
    if (mode === 'malformed-proof')
      mockProve.mockImplementation(async () => ({
        publicInputs: mockPrepared.expectedPublicInputs,
        proof: { ...proof(), random: 'private-sentinel' },
      }));
    if (mode === 'secret-error') mockProve.mockRejectedValue(Error('private-sentinel'));
    await expect(prove(options())).rejects.toMatchObject({
      code: 'RAILGUN_POI_PROOF_REFUSED',
      message: 'Railgun POI proof unavailable',
    });
    wiped();
  }
);
test('cancellation drains pending proving before wiping or returning', async () => {
  let release;
  mockProve.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const running = prove(options());
  for (let i = 0; i < 10 && !release; i++) await Promise.resolve();
  expect(release).toBeDefined();
  mockController.abort();
  expect(mockArtifacts.wasm[0]).toBe(1);
  release({ publicInputs: mockPrepared.expectedPublicInputs, proof: proof() });
  await expect(running).rejects.toMatchObject({ code: 'RAILGUN_POI_PROOF_REFUSED' });
  expect(mockSerial.verify).not.toHaveBeenCalled();
  wiped();
});

test.each(['debugger-during-proof', 'workers-after-proof'])(
  'refuses %s and retains only sanitized error',
  async (mode) => {
    mockProve.mockImplementation(async () => {
      if (mode === 'debugger-during-proof') mockDebug.engineDebugger = { log: jest.fn() };
      else globalThis.curve_bn128 = {};
      return { publicInputs: structuredClone(mockPrepared.expectedPublicInputs), proof: proof() };
    });
    await expect(prove(options())).rejects.toMatchObject({
      code: 'RAILGUN_POI_PROOF_REFUSED',
      message: 'Railgun POI proof unavailable',
    });
    wiped();
  }
);
