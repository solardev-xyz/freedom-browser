// Structural seams only: no engine, signature or ownership verification is executed.
const {
  createRailgunRelayUnsignedData,
} = require('../../../scripts/fixtures/railgun-relay-unsigned-data');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { normalizeRailgunRelayPoiHistory } = require('./railgun-relay-poi-history');
const { normalizeRailgunRelayPrePoiBinding } = require('./railgun-relay-pre-poi-data');
const { REQUIRED_LIST } = require('./railgun-poi-records');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
function fixture(state = 'held') {
  const draft = createRailgunRelayUnsignedData().draft,
    draftDigest = normalizeRailgunRelayDraftCapsule(draft).digest;
  const proof = { leaf: hex(1), root: hex(2), indices: hex(5), elements: Array(16).fill(hex(3)) };
  const history = {
    schema: 'railgun-relay-input-poi-history-v1',
    draftDigest,
    listKey: REQUIRED_LIST,
    note: { blindedCommitment: '0x' + hex(1), type: 'Transact' },
    proof,
    event: {
      signedPOIEvent: {
        index: 5,
        blindedCommitment: '0x' + hex(1),
        type: 'Transact',
        signature: '12'.repeat(64),
      },
      validatedMerkleroot: hex(4),
    },
  };
  const prePoiBinding = {
    schema: 'railgun-relay-pre-poi-binding-v1',
    draftDigest,
    chainId: 11155111,
    txidVersion: 'V2_PoseidonMerkle',
    listKey: REQUIRED_LIST,
    listWitness: proof,
    txidLeafHash: hex(10),
    txidMerkleroot: hex(11),
    blindedCommitmentsOut: ['0x' + hex(12), '0x' + hex(13)],
  };
  const signature = ['signed', 'ready-local'].includes(state)
    ? { R8: ['0x' + hex(1), '0x' + hex(2)], S: '0x' + hex(3) }
    : null;
  const proved =
    state === 'ready-local'
      ? {
          transaction: draft.intent.transaction,
          payload: {
            snarkProof: {
              pi_a: ['1', '2'],
              pi_b: [
                ['3', '4'],
                ['5', '6'],
              ],
              pi_c: ['7', '8'],
            },
            txidMerkleroot: prePoiBinding.txidMerkleroot,
            poiMerkleroots: [proof.root],
            blindedCommitmentsOut: prePoiBinding.blindedCommitmentsOut,
            railgunTxidIfHasUnshield: '0x00',
          },
        }
      : null;
  return JSON.parse(
    JSON.stringify({
      schema: 'railgun-relay-local-record-v4',
      id: hex(100),
      binding: hex(101),
      walletId: draft.walletId,
      generationId: hex(102),
      checkpointHash: hex(103),
      authorizationDigest: hex(104),
      draft: normalizeRailgunRelayDraftCapsule(draft).data,
      history: normalizeRailgunRelayPoiHistory(history).data,
      prePoiBinding: normalizeRailgunRelayPrePoiBinding(prePoiBinding),
      state,
      signature,
      proved,
    })
  );
}
const mockWallet = jest.fn(),
  mockFresh = jest.fn(),
  mockCold = jest.fn();
jest.mock('./railgun-wallet-job', () => ({ withWallet: (...args) => mockWallet(...args) }));
jest.mock('./railgun-relay-pre-poi-witness', () => ({
  prepareRailgunRelayPrePoiWitness: (...args) => mockFresh(...args),
  restoreRailgunRelayPrePoiWitness: (...args) => mockCold(...args),
}));
function setup() {
  let run;
  jest.isolateModules(() => {
    run = require('./railgun-relay-pre-poi-job').run;
  });
  const record = fixture(),
    controller = new AbortController();
  const input = {
    archive: '/fixture-engine.asar',
    descriptor: { walletId: record.walletId },
    checkpoint: { current: true },
    walletId: record.walletId,
    restore: true,
    prefixes: { public: ['public'], wallet: ['wallet', 'sent'] },
    draftText: JSON.stringify(record.draft),
    history: record.history,
  };
  const restored = {
    archive: input.archive,
    wallet: { restored: true },
    descriptor: input.descriptor,
    checkpoint: input.checkpoint,
    scan: { owned: true },
    signal: controller.signal,
  };
  const assembled = {
    binding: record.prePoiBinding,
    historyDigest: normalizeRailgunRelayPoiHistory(record.history).digest,
  };
  mockFresh.mockResolvedValue(assembled);
  mockWallet.mockImplementation(async (text, context, purpose, callback) => {
    expect(text).toBe(JSON.stringify(input));
    expect(context.signal).toBe(controller.signal);
    expect(purpose).toBe('relay-pre-poi');
    return callback(restored);
  });
  return { run, input, restored, assembled, controller, context: { signal: controller.signal } };
}
beforeEach(() => jest.resetAllMocks());
test('fresh assembler receives original canonical draft and restored wallet; only detached binding leaves', async () => {
  const f = setup();
  for (const name of ['witness', 'inputs', 'publicSignals'])
    Object.defineProperty(f.assembled, name, {
      enumerable: true,
      get() {
        throw Error('private result touched');
      },
    });
  const result = await f.run(JSON.stringify(f.input), f.context);
  expect(mockCold).not.toHaveBeenCalled();
  expect(mockFresh).toHaveBeenCalledTimes(1);
  const called = mockFresh.mock.calls[0][0];
  expect(called).toEqual({ ...f.restored, draftText: f.input.draftText, history: f.input.history });
  expect(called.wallet).toBe(f.restored.wallet);
  expect(called.scan).toBe(f.restored.scan);
  expect(Object.keys(result)).toEqual(['relayPrePoiBinding']);
  expect(result.relayPrePoiBinding).toEqual({
    binding: f.assembled.binding,
    historyDigest: f.assembled.historyDigest,
    draftDigest: normalizeRailgunRelayDraftCapsule(JSON.parse(f.input.draftText)).digest,
    expectedHash: JSON.parse(f.input.draftText).intent.expectedHash,
  });
  expect(result.relayPrePoiBinding.binding).not.toBe(f.assembled.binding);
  expect(Object.isFrozen(result.relayPrePoiBinding.binding)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /witness|privateInputs|signature|authority|publicSignals|wallet/
  );
  await expect(f.run(JSON.stringify(f.input), f.context)).rejects.toThrow();
  expect(mockWallet).toHaveBeenCalledTimes(1);
});
test.each([
  ['total bytes', (f) => (f.input.checkpoint = { padding: 'x'.repeat(65536) })],
  ['UTF8 bytes', (f) => (f.input.checkpoint = { padding: 'é'.repeat(32768) })],
  ['relative archive', (f) => (f.input.archive = 'engine.asar')],
  ['wrong archive suffix', (f) => (f.input.archive = '/engine.js')],
  ['writable', (f) => (f.input.restore = false)],
  ['wallet', (f) => (f.input.walletId = hex(999))],
  ['descriptor', (f) => (f.input.descriptor.walletId = hex(999))],
  ['noncanonical draft', (f) => (f.input.draftText = ' ' + f.input.draftText)],
  ['history digest', (f) => (f.input.history.draftDigest = hex(999))],
  ['history extra', (f) => (f.input.history.signatureVerified = true)],
  ['cold mode', (f) => (f.input.local = true)],
  ['signing', (f) => (f.input.signature = {})],
  ['witness', (f) => (f.input.witness = {})],
  ['prover', (f) => (f.input.proverArchive = '/prover.asar')],
  ['aborted', (f) => f.controller.abort()],
])('refuses %s before wallet restoration/key request', async (_name, mutate) => {
  const f = setup();
  mutate(f);
  await expect(f.run(JSON.stringify(f.input), f.context)).rejects.toThrow();
  expect(mockWallet).not.toHaveBeenCalled();
  expect(mockFresh).not.toHaveBeenCalled();
  expect(mockCold).not.toHaveBeenCalled();
});
test.each([
  ['wrong history', (f) => (f.assembled.historyDigest = hex(99))],
  ['wrong draft', (f) => (f.assembled.binding.draftDigest = hex(99))],
  ['wrong list root', (f) => (f.assembled.binding.listWitness.root = hex(99))],
  ['private binding field', (f) => (f.assembled.binding.witness = {})],
  [
    'duplicate output blind',
    (f) =>
      (f.assembled.binding.blindedCommitmentsOut[1] = f.assembled.binding.blindedCommitmentsOut[0]),
  ],
  ['private exchange', (f) => (f.restored.exchangePrivateIntent = () => {})],
  ['record route', (f) => (f.restored.readRelayProofRecord = () => {})],
])('refuses %s without releasing a binding', async (_name, mutate) => {
  const f = setup();
  mutate(f);
  await expect(f.run(JSON.stringify(f.input), f.context)).rejects.toThrow();
  expect(mockCold).not.toHaveBeenCalled();
});
test('original fresh assembler failure is preserved and never retried cold', async () => {
  const f = setup(),
    error = Error('fresh original path refused');
  mockFresh.mockRejectedValue(error);
  await expect(f.run(JSON.stringify(f.input), f.context)).rejects.toBe(error);
  expect(mockCold).not.toHaveBeenCalled();
});
test('aborted original assembly remains awaited; its late binding cannot escape', async () => {
  const f = setup();
  let resolve,
    entered,
    settled = false;
  const reached = new Promise((yes) => {
    entered = yes;
  });
  const held = new Promise((yes) => {
    resolve = yes;
  });
  mockFresh.mockImplementation(() => {
    entered();
    return held;
  });
  const original = f.run(JSON.stringify(f.input), f.context);
  original.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await reached;
  f.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  resolve(f.assembled);
  await expect(original).rejects.toThrow();
  expect(mockCold).not.toHaveBeenCalled();
});
