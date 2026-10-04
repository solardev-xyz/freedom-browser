const { createHash } = require('crypto');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let mockReady, mockReconstruct, mockPosition, mockBlinded;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((v) => v) }));
jest.mock('./railgun-poi-reconstruct', () => ({
  reconstructRailgunPoiNotes: (...args) => mockReconstruct(...args),
}));
jest.mock(
  '/fixture-transact-selector.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockReady;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-transact-selector.asar/node_modules/@railgun-community/engine/dist/poi/global-tree-position',
  () => ({ getGlobalTreePosition: (...args) => mockPosition(...args) }),
  { virtual: true }
);
jest.mock(
  '/fixture-transact-selector.asar/node_modules/@railgun-community/engine/dist/poi/blinded-commitment',
  () => ({ BlindedCommitment: { getForShieldOrTransact: (...args) => mockBlinded(...args) } }),
  { virtual: true }
);
jest.mock('./railgun-poi-prover', () => {
  throw Error('No prover');
});
jest.mock('./railgun-artifacts', () => {
  throw Error('No artifacts');
});
jest.mock('./privacy-storage', () => {
  throw Error('No stores');
});
jest.mock('../networks/private-rpc', () => {
  throw Error('No RPC');
});
let input, text, bytes, caller, request, requestKey, run, guardReport;
const sha = (v) => createHash('sha256').update(v).digest('hex');
function prepare(unshield = false) {
  const capsule = require('../../../scripts/fixtures/railgun-own-txid-data').sample(
    unshield
  ).capsule;
  return require('./railgun-poi-transact-selector-data').prepareRailgunPoiTransactSelectorInput({
    archive: '/fixture-transact-selector.asar',
    capsule,
    descriptor: {
      walletId: capsule.walletId,
      instanceId: '0zk1' + 'q'.repeat(123),
      masterPublicKey: hex(3).slice(2),
      spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
      viewingPublicKey: hex(6).slice(2),
      accountIndex: 0,
    },
    creator: {
      type: 'Transact',
      tree: capsule.selection.tree,
      position: capsule.selection.position,
      hash: capsule.noteHash,
      ciphertext: {
        ciphertext: [hex(7), hex(8), hex(9), hex(10)],
        blindedSenderViewingKey: hex(11),
        blindedReceiverViewingKey: hex(12),
        annotationData: '0x',
        memo: '0x',
      },
    },
  });
}
beforeEach(() => {
  jest.resetModules();
  mockReady = Promise.resolve();
  mockReconstruct = jest.fn(async () => ({
    inputNpk: 123n,
    npksOut: [456n],
    privateSentinel: 'PRIVATE',
  }));
  mockPosition = jest.fn((tree, position) => BigInt(tree) * 65536n + BigInt(position));
  mockBlinded = jest.fn(() => hex(77));
  input = prepare();
  text = JSON.stringify(input);
  bytes = Buffer.alloc(32, 7);
  caller = new AbortController();
  requestKey = jest.fn(async (wire) => {
    expect(JSON.parse(wire)).toEqual({
      id: 1,
      method: 'key',
      purpose: 'poi-transact-selector',
      inputSha256: sha(text),
    });
    return bytes;
  });
  request = jest.fn(async () => JSON.stringify({ id: 2, value: null }));
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['network'] }));
  run = require('./railgun-poi-transact-selector-job').run;
});
const context = () => ({ request, requestKey, signal: caller.signal, guardReport });
const failure = {
  code: 'RAILGUN_POI_TRANSACT_SELECTOR_REFUSED',
  message: 'Railgun Transact POI selector unavailable',
};
test.each([false, true])(
  'transfer/unshield input requires one viewing key, output never escapes: %s',
  async (unshield) => {
    input = prepare(unshield);
    text = JSON.stringify(input);
    request.mockImplementation(async (wire) => {
      expect(bytes.equals(Buffer.alloc(32))).toBe(true);
      expect(JSON.parse(wire)).toEqual({
        id: 2,
        method: 'result',
        value: {
          inputSha256: sha(text),
          bindingDigest: input.bindingDigest,
          blindedCommitment: hex(77),
          type: 'Transact',
          selectorDerived: true,
          receiverMatched: true,
          sourceAuthenticated: false,
          currentFinalityVerified: false,
          txidRootAccepted: false,
          membershipAuthenticated: false,
          disclosureEnabled: false,
          spendingEnabled: false,
          inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          guards: guardReport(),
        },
      });
      expect(wire).not.toContain('PRIVATE');
      expect(wire).not.toContain('npksOut');
      return JSON.stringify({ id: 2, value: null });
    });
    await run(text, context());
    expect(mockPosition).toHaveBeenCalledWith(input.creator.tree, input.creator.position);
    expect(mockBlinded).toHaveBeenCalledWith(input.capsule.noteHash, 123n, 1n);
    expect(mockReconstruct).toHaveBeenCalledWith({
      archive: input.archive,
      descriptor: input.descriptor,
      viewingKey: bytes,
      capsule: input.capsule,
      creator: input.creator,
      signal: caller.signal,
    });
    expect(requestKey).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    await expect(run(text, context())).rejects.toMatchObject(failure);
    expect(requestKey).toHaveBeenCalledTimes(1);
  }
);
test.each(['json', 'oversize', 'hash', 'creator', 'injection', 'engine', 'cancelled'])(
  'pre-key %s refusal',
  async (kind) => {
    const v = JSON.parse(text);
    if (kind === 'hash') v.bindingDigest = '0'.repeat(64);
    if (kind === 'creator') v.creator.position++;
    if (kind === 'injection') v.npk = hex(33);
    text = kind === 'json' ? '{' : kind === 'oversize' ? 'x'.repeat(65537) : JSON.stringify(v);
    if (kind === 'engine')
      require('./railgun-engine-runtime').verifyRailgunEngineRuntime.mockImplementationOnce(() => {
        throw Error('PRIVATE');
      });
    if (kind === 'cancelled') caller.abort();
    await expect(run(text, context())).rejects.toMatchObject(failure);
    expect(requestKey).not.toHaveBeenCalled();
    expect(mockReconstruct).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
test.each([
  'short',
  'long',
  'reconstruct',
  'cancelled',
  'invalid-selector',
  'guard',
  'ack',
  'ack-throw',
])('post-key %s refuses and wipes key', async (kind) => {
  if (kind === 'short') bytes = Buffer.alloc(31, 7);
  if (kind === 'long') bytes = Buffer.alloc(33, 7);
  if (kind === 'reconstruct') mockReconstruct.mockRejectedValue(Error('PRIVATE'));
  if (kind === 'cancelled')
    mockReconstruct.mockImplementation(async () => {
      caller.abort();
      return { inputNpk: 123n };
    });
  if (kind === 'invalid-selector') mockBlinded.mockReturnValue('0x' + 'f'.repeat(64));
  if (kind === 'guard') guardReport.mockReturnValue({ attempts: 1 });
  if (kind === 'ack') request.mockResolvedValue(JSON.stringify({ id: 1, value: null }));
  if (kind === 'ack-throw') request.mockRejectedValue(Error('PRIVATE'));
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(bytes.every((v) => v === 0)).toBe(true);
  expect(requestKey).toHaveBeenCalledTimes(1);
  if (!['ack', 'ack-throw'].includes(kind)) expect(request).not.toHaveBeenCalled();
});
test('cancelled pending credential response is wiped and never reconstructed', async () => {
  let release;
  requestKey.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const pending = run(text, context());
  while (!release) await Promise.resolve();
  caller.abort();
  release(bytes);
  await expect(pending).rejects.toMatchObject(failure);
  expect(bytes.equals(Buffer.alloc(32))).toBe(true);
  expect(mockReconstruct).not.toHaveBeenCalled();
});
