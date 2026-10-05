const { createHash } = require('crypto');
const mockArchive = '/fixture-output-recover.asar';
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const mockHash = (text) => '0' + createHash('sha256').update(text).digest('hex').slice(1);
const mockPair = (a, b) => mockHash(a + b);
const mockTransactionHash = (row) => ({
  hash: mockHash(JSON.stringify(row)),
  railgunTxid: mockHash(row.nullifiers[0]),
});
const mockVerificationHash = () => '0x' + '17'.padStart(64, '0');
let mockZeros, mockPoseidonReady, mockReconstruct, mockGlobalPosition, mockBlinded;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((v) => v) }));
jest.mock('./railgun-public-records', () => ({
  ...jest.requireActual('./railgun-public-records'),
  ZERO_NODES: mockZeros,
}));
jest.mock('./railgun-poi-reconstruct', () => ({
  reconstructRailgunPoiNotes: (options) => mockReconstruct(options),
}));
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockPoseidonReady;
    },
    poseidonHex: (values) => mockPair(...values),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/transaction/railgun-txid',
  () => ({
    createRailgunTransactionWithHash: (row) => mockTransactionHash(row),
    calculateRailgunTransactionVerificationHash: (...args) => mockVerificationHash(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/poi/global-tree-position',
  () => ({
    getGlobalTreePosition: (...args) => mockGlobalPosition(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/poi/blinded-commitment',
  () => ({
    BlindedCommitment: { getForShieldOrTransact: (...args) => mockBlinded(...args) },
  }),
  { virtual: true }
);
jest.mock('./railgun-poi-prover', () => {
  throw Error('Output recovery must not load prover');
});
jest.mock('./railgun-artifacts', () => {
  throw Error('Output recovery must not load artifacts');
});
jest.mock('./privacy-storage', () => {
  throw Error('Output recovery must not load storage');
});
jest.mock('../networks/private-rpc', () => {
  throw Error('Output recovery must not load RPC');
});
let input, text, run, caller, bytes, request, requestKey, guardReport;
const sha = (v) => createHash('sha256').update(v).digest('hex');
beforeEach(async () => {
  jest.resetModules();
  mockZeros = [mockHash('zero')];
  for (let i = 0; i < 16; i++) mockZeros.push(mockPair(mockZeros[i], mockZeros[i]));
  mockPoseidonReady = Promise.resolve();
  mockReconstruct = jest.fn(async () => ({
    npksOut: [123n],
    valuesOut: [1000n],
    privateSentinel: 'never-serialize-private-notes',
  }));
  mockGlobalPosition = jest.fn((tree, position) => BigInt(tree) * 65536n + BigInt(position));
  mockBlinded = jest.fn(
    (commitment, npk, position) => '0x' + mockHash(`${commitment}:${npk}:${position}`)
  );
  const ownEvidence = require('../../../scripts/fixtures/railgun-own-txid-data').sample(),
    capsule = ownEvidence.capsule;
  const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
    hashPair: mockPair,
    transactionHash: mockTransactionHash,
    verificationHash: mockVerificationHash,
    zeroNodes: mockZeros,
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const appended = await projection.append(projection.empty(), [ownEvidence.row], read);
  for (const { key, value } of appended.writes) values.set(key, value);
  const witness = await projection.witness(
    appended.state,
    mockTransactionHash(ownEvidence.row).railgunTxid,
    read
  );
  input = {
    archive: mockArchive,
    descriptor: {
      walletId: capsule.walletId,
      instanceId: capsule.selection.recipient,
      masterPublicKey: hex(3).slice(2),
      spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
      viewingPublicKey: hex(6).slice(2),
      accountIndex: 0,
    },
    binding: {
      capsuleDigest: require('./railgun-private-capsule').digestRailgunPrivateCapsule(capsule),
      bindingDigest: '7'.repeat(64),
      payloadSha256: '8'.repeat(64),
      revision: 1,
    },
    preparation: {
      creator: {
        type: 'Shield',
        tree: 0,
        position: 1,
        preimage: {
          npk: hex(3),
          value: '1000',
          token: {
            tokenType: 0,
            tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
            tokenSubID: hex(0),
          },
        },
        ciphertext: { encryptedBundle: [hex(4), hex(5), hex(6)], shieldKey: hex(7) },
      },
      ownEvidence,
      state: JSON.parse(JSON.stringify(appended.state)),
      witness: JSON.parse(JSON.stringify(witness)),
    },
  };
  text = JSON.stringify(input);
  caller = new AbortController();
  bytes = Buffer.alloc(32, 7);
  requestKey = jest.fn(async (wire) => {
    expect(JSON.parse(wire)).toEqual({
      id: 1,
      method: 'key',
      purpose: 'poi-output-recover',
      inputSha256: sha(text),
    });
    return bytes;
  });
  request = jest.fn(async () => JSON.stringify({ id: 2, value: null }));
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['network'] }));
  run = require('./railgun-poi-output-recover-job').run;
});
const context = () => ({ request, requestKey, signal: caller.signal, guardReport });
const failure = {
  code: 'RAILGUN_POI_OUTPUT_RECOVERY_REFUSED',
  message: 'Railgun POI output recovery unavailable',
};
test('real validators and deterministic real Merkle path precede one key; output derives from row and reconstructed NPK', async () => {
  request.mockImplementation(async (wire) => {
    expect(bytes.every((v) => v === 0)).toBe(true);
    const message = JSON.parse(wire);
    expect(message).toEqual({
      id: 2,
      method: 'result',
      value: {
        recoveryInputSha256: sha(text),
        payloadSha256: input.binding.payloadSha256,
        output: {
          blindedCommitmentsOut: [
            '0x' + mockHash(`${input.preparation.witness.row.commitments[0]}:123:65659`),
          ],
          railgunTxidIfHasUnshield: '0x00',
        },
        engineSha256: require('./railgun-engine-manifest.json').sha256,
        sourceAuthenticated: false,
        proofVerified: false,
        membershipAuthenticated: false,
        rootAccepted: false,
        disclosureEnabled: false,
        spendingEnabled: false,
        guards: { attempts: 0, canaries: 1, hooks: ['network'] },
      },
    });
    expect(wire).not.toContain('never-serialize-private-notes');
    return JSON.stringify({ id: 2, value: null });
  });
  await run(text, context());
  expect(requestKey).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(mockGlobalPosition).toHaveBeenCalledWith(1, 123);
  expect(mockBlinded).toHaveBeenCalledWith(
    input.preparation.witness.row.commitments[0],
    123n,
    65659n
  );
  expect(mockReconstruct).toHaveBeenCalledWith({
    archive: mockArchive,
    descriptor: input.descriptor,
    viewingKey: bytes,
    capsule: input.preparation.ownEvidence.capsule,
    creator: input.preparation.creator,
    signal: caller.signal,
  });
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(requestKey).toHaveBeenCalledTimes(1);
});
test.each([
  'oversize',
  'json',
  'descriptor',
  'creator',
  'commitment',
  'saved-output',
  'path',
  'leaf',
  'engine',
  'aborted',
])('%s refuses before requesting a credential, using real structure/path checks', async (kind) => {
  if (kind === 'descriptor') input.descriptor.spendingPublicKey = [];
  if (kind === 'creator') input.preparation.creator.position++;
  if (kind === 'commitment') input.preparation.ownEvidence.row.commitments[0] = hex(99);
  if (kind === 'saved-output') input.blindedCommitmentsOut = [hex(10)];
  if (kind === 'path') input.preparation.witness.elements[0] = hex(10).slice(2);
  if (kind === 'leaf') input.preparation.witness.leaf = hex(10).slice(2);
  text = kind === 'oversize' ? 'x'.repeat(65537) : kind === 'json' ? '{' : JSON.stringify(input);
  if (kind === 'engine')
    require('./railgun-engine-runtime').verifyRailgunEngineRuntime.mockImplementationOnce(() => {
      throw Error('private-sentinel');
    });
  if (kind === 'aborted') caller.abort();
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(requestKey).not.toHaveBeenCalled();
  expect(mockReconstruct).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test.each([
  'short-key',
  'long-key',
  'reconstruct',
  'empty-npk',
  'extra-npk',
  'empty-value',
  'zero-value',
  'negative-value',
  'zero-output',
  'guard',
  'ack',
  'ack-json',
  'result-transport',
])('%s refuses and wipes all received key bytes', async (kind) => {
  if (kind === 'short-key') bytes = Buffer.alloc(31, 7);
  if (kind === 'long-key') bytes = Buffer.alloc(33, 7);
  if (kind === 'reconstruct') mockReconstruct.mockRejectedValueOnce(Error('private-sentinel'));
  if (kind === 'empty-npk')
    mockReconstruct.mockResolvedValueOnce({ npksOut: [], valuesOut: [1000n] });
  if (kind === 'extra-npk')
    mockReconstruct.mockResolvedValueOnce({ npksOut: [1n, 2n], valuesOut: [1000n] });
  if (kind === 'empty-value')
    mockReconstruct.mockResolvedValueOnce({ npksOut: [1n], valuesOut: [] });
  if (kind === 'zero-value')
    mockReconstruct.mockResolvedValueOnce({ npksOut: [1n], valuesOut: [0n] });
  if (kind === 'negative-value')
    mockReconstruct.mockResolvedValueOnce({ npksOut: [1n], valuesOut: [-1n] });
  if (kind === 'zero-output') mockBlinded.mockReturnValueOnce(hex(0));
  if (kind === 'guard') guardReport.mockReturnValueOnce({ attempts: 1 });
  if (kind === 'ack') request.mockResolvedValueOnce(JSON.stringify({ id: 1, value: null }));
  if (kind === 'ack-json') request.mockResolvedValueOnce('{');
  if (kind === 'result-transport') request.mockRejectedValueOnce(Error('private-sentinel'));
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(bytes.every((v) => v === 0)).toBe(true);
  expect(requestKey).toHaveBeenCalledTimes(1);
});
test('nonbinary credential refuses without invoking reconstruction', async () => {
  requestKey.mockResolvedValueOnce('secret-string');
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(mockReconstruct).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('cancellation while initializing crypto refuses before key and spends the single-run allowance', async () => {
  let release;
  mockPoseidonReady = new Promise((resolve) => {
    release = resolve;
  });
  const pending = run(text, context());
  caller.abort();
  release();
  await expect(pending).rejects.toMatchObject(failure);
  caller = new AbortController();
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(requestKey).not.toHaveBeenCalled();
});
test('late binary credential after cancellation is wiped without reconstruction', async () => {
  requestKey.mockImplementationOnce(async () => {
    caller.abort();
    return bytes;
  });
  await expect(run(text, context())).rejects.toMatchObject(failure);
  expect(bytes.every((v) => v === 0)).toBe(true);
  expect(mockReconstruct).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test('ignored reconstruction abort drains before settlement and cannot emit a late output', async () => {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  mockReconstruct.mockImplementationOnce(async () => {
    enter();
    await gate;
    return { npksOut: [123n], valuesOut: [1000n] };
  });
  let settled = false;
  const pending = run(text, context()).finally(() => {
    settled = true;
  });
  try {
    await Promise.race([entered, pending]);
    caller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    release();
  }
  await expect(pending).rejects.toMatchObject(failure);
  expect(bytes.every((v) => v === 0)).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
function useTransactCreator() {
  const capsule = input.preparation.ownEvidence.capsule;
  input.preparation.creator = {
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
  };
}
test('Transact output worker uses actual input/path validators before one key and retains output-only result shape', async () => {
  useTransactCreator();
  text = JSON.stringify(input);
  await run(text, context());
  expect(requestKey).toHaveBeenCalledTimes(1);
  expect(mockReconstruct).toHaveBeenCalledWith(
    expect.objectContaining({
      creator: input.preparation.creator,
      capsule: input.preparation.ownEvidence.capsule,
    })
  );
  expect(request).toHaveBeenCalledTimes(1);
  const output = JSON.parse(request.mock.calls[0][0]).value;
  expect(output.output.blindedCommitmentsOut).toHaveLength(1);
  expect(output.output.railgunTxidIfHasUnshield).toBe('0x00');
  expect(output.sourceAuthenticated).toBe(false);
  expect(output.proofVerified).toBe(false);
  expect(bytes.every((value) => value === 0)).toBe(true);
});
test.each(['unknown', 'hash', 'position', 'memo', 'receiver', 'path', 'saved-output'])(
  'actual Transact worker normalizer/path refuses %s before key or reconstruction',
  async (fault) => {
    useTransactCreator();
    if (fault === 'unknown') input.preparation.creator.type = 'Unknown';
    if (fault === 'hash') input.preparation.creator.hash = hex(900);
    if (fault === 'position') input.preparation.creator.position++;
    if (fault === 'memo') input.preparation.creator.ciphertext.memo = '0x1';
    if (fault === 'receiver') input.descriptor.instanceId = '0zk1' + 'p'.repeat(123);
    if (fault === 'path') input.preparation.witness.elements[0] = hex(900).slice(2);
    if (fault === 'saved-output') input.blindedCommitmentsOut = [hex(900)];
    text = JSON.stringify(input);
    await expect(run(text, context())).rejects.toMatchObject(failure);
    expect(requestKey).not.toHaveBeenCalled();
    expect(mockReconstruct).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);

// Actual reconstruction and capsule/receipt/path validators; cryptographic engine
// primitives/decryption are controlled toy seams, not native crypto evidence.
let mockWallet, mockInputNote, mockOutputNote, mockAnnotation, mockDecryptQueue, mockSharedCopies;
let mockNoteHash, mockUnshieldHash;
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    getPublicViewingKey: async () => Buffer.from(hex(6).slice(2), 'hex'),
    getSharedSymmetricKey: async () => {
      const key = Buffer.alloc(32, 8);
      mockSharedCopies.push(key);
      return key;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/wallet/view-only-wallet',
  () => ({
    ViewOnlyWallet: class {
      constructor() {
        return mockWallet;
      }
      static generateID() {
        return '1'.repeat(64);
      }
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/note/erc20/shield-note-erc20',
  () => ({
    ShieldNoteERC20: class {
      constructor() {
        return mockInputNote;
      }
      static decryptRandom() {
        return '01'.repeat(16);
      }
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({
    TransactNote: {
      decrypt: async () => mockDecryptQueue.shift() || mockOutputNote,
      getHash: (...args) => mockNoteHash(...args),
      getNullifier: () => 2n,
    },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/note/note-util',
  () => ({
    getTokenDataERC20: () => ({
      tokenType: 0,
      tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
      tokenSubID: '0x' + '0'.repeat(64),
    }),
    getTokenDataHash: () => 'a'.repeat(64),
    getNoteHash: (...args) => mockUnshieldHash(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/note/shield-note',
  () => ({
    ShieldNote: { getNotePublicKey: (_master, random) => (random === '01'.repeat(16) ? 3n : 11n) },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/note/memo',
  () => ({
    Memo: { decryptNoteAnnotationData: (...args) => mockAnnotation(...args) },
  }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/models/formatted-types',
  () => ({ OutputType: { Change: 2 } }),
  { virtual: true }
);
jest.mock(
  '/fixture-output-recover.asar/node_modules/@railgun-community/engine/dist/models/transaction-constants',
  () => ({ MEMO_SENDER_RANDOM_NULL: '0'.repeat(30) }),
  { virtual: true }
);

async function partialJob(type = 'Shield') {
  const e = require('../../../scripts/fixtures/railgun-partial-own-txid-data').samplePartial();
  const projection = require('./railgun-txid-projection').createRailgunTxidProjection({
    hashPair: mockPair,
    transactionHash: mockTransactionHash,
    verificationHash: mockVerificationHash,
    zeroNodes: mockZeros,
  });
  const values = new Map(),
    read = async (key) => values.get(key) ?? null;
  const appended = await projection.append(projection.empty(), [e.row], read);
  for (const { key, value } of appended.writes) values.set(key, value);
  const witness = await projection.witness(
    appended.state,
    mockTransactionHash(e.row).railgunTxid,
    read
  );
  input.preparation.ownEvidence = e;
  input.preparation.state = JSON.parse(JSON.stringify(appended.state));
  input.preparation.witness = JSON.parse(JSON.stringify(witness));
  input.binding.capsuleDigest = require('./railgun-private-capsule').digestRailgunPrivateCapsule(
    e.capsule
  );
  input.descriptor.walletId = e.capsule.walletId;
  input.descriptor.instanceId = '0zk1' + 'q'.repeat(123);
  if (type === 'Transact')
    input.preparation.creator = {
      type,
      tree: 0,
      position: 1,
      hash: e.capsule.noteHash,
      ciphertext: {
        ciphertext: [hex(7), hex(8), hex(9), hex(10)],
        blindedSenderViewingKey: hex(11),
        blindedReceiverViewingKey: hex(12),
        annotationData: '0x',
        memo: '0x',
      },
    };
  mockWallet = {
    masterPublicKey: 3n,
    addressKeys: { masterPublicKey: 3n },
    getAddress: () => input.descriptor.instanceId,
    generateShareableViewingKey: () => 'public-fixture',
    getNullifyingKey: () => 6n,
  };
  const tokenData = {
    tokenType: 0,
    tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
    tokenSubID: hex(0),
  };
  mockInputNote = {
    notePublicKey: 3n,
    random: '01'.repeat(16),
    value: 1000n,
    tokenHash: 'a'.repeat(64),
    tokenData,
    hash: 5n,
  };
  mockOutputNote = {
    notePublicKey: 11n,
    random: '02'.repeat(16),
    value: 600n,
    tokenHash: 'a'.repeat(64),
    tokenData: { ...tokenData },
    hash: 3n,
  };
  mockDecryptQueue = type === 'Transact' ? [mockInputNote] : [];
  mockSharedCopies = [];
  mockNoteHash = jest.fn((npk) => (npk === 3n ? 5n : 3n));
  mockUnshieldHash = jest.fn(() => 4n);
  mockAnnotation = jest.fn(() => ({ outputType: 2, senderRandom: '0'.repeat(30) }));
  mockReconstruct = jest.fn(
    jest.requireActual('./railgun-poi-reconstruct').reconstructRailgunPoiNotes
  );
  text = JSON.stringify(input);
}
test.each(['Shield', 'Transact'])(
  'partial %s actual reconstruction derives C and own T after one key without saved proof/output input',
  async (type) => {
    await partialJob(type);
    const before = JSON.stringify(input);
    await run(text, context());
    expect(requestKey).toHaveBeenCalledTimes(1);
    expect(mockReconstruct).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    const result = JSON.parse(request.mock.calls[0][0]).value;
    expect(result.output).toEqual({
      blindedCommitmentsOut: [
        '0x' + mockHash(`${input.preparation.witness.row.commitments[0]}:11:65659`),
      ],
      railgunTxidIfHasUnshield: '0x' + input.preparation.witness.railgunTxid,
    });
    expect(mockBlinded).toHaveBeenCalledWith(
      input.preparation.witness.row.commitments[0],
      11n,
      65659n
    );
    expect(mockUnshieldHash).toHaveBeenCalledWith(
      input.preparation.ownEvidence.capsule.selection.recipient,
      mockInputNote.tokenData,
      400n
    );
    expect(mockAnnotation).toHaveBeenCalledTimes(1);
    expect(text).not.toContain('blindedCommitmentsOut');
    expect(JSON.stringify(input)).toBe(before);
    expect(bytes.every((v) => v === 0)).toBe(true);
    expect(mockSharedCopies.length).toBeGreaterThan(0);
    expect(mockSharedCopies.every((v) => v.every((b) => b === 0))).toBe(true);
  }
);
test.each([
  'foreign-self-npk',
  'wrong-C',
  'token',
  'annotation',
  'sender-random',
  'memo',
  'unshield-hash',
])(
  'partial actual reconstruction rejects %s despite decrypt success and wipes the one key',
  async (fault) => {
    await partialJob();
    // For foreign-self-npk the toy commitment function still returns the exact
    // expected output hash. Only the wallet-derived self NPK comparison fails.
    if (fault === 'foreign-self-npk') mockOutputNote.notePublicKey = 12n;
    if (fault === 'wrong-C') mockOutputNote.value = 599n;
    if (fault === 'token') mockOutputNote.tokenData.tokenAddress = '0x' + '11'.repeat(20);
    if (fault === 'annotation')
      mockAnnotation.mockReturnValue({ outputType: 0, senderRandom: '0'.repeat(30) });
    if (fault === 'sender-random')
      mockAnnotation.mockReturnValue({ outputType: 2, senderRandom: '1'.repeat(30) });
    if (fault === 'memo') mockOutputNote.memoText = 'not-absent';
    if (fault === 'unshield-hash') mockUnshieldHash.mockReturnValue(7n);
    await expect(run(text, context())).rejects.toMatchObject(failure);
    expect(requestKey).toHaveBeenCalledTimes(1);
    expect(mockBlinded).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(bytes.every((v) => v === 0)).toBe(true);
    expect(mockSharedCopies.every((v) => v.every((b) => b === 0))).toBe(true);
  }
);
test.each(['order', 'wrong-row-U', 'wrong-T', 'bad-path'])(
  'partial %s refuses before key admission',
  async (fault) => {
    await partialJob();
    if (fault === 'order') input.preparation.ownEvidence.row.commitments.reverse();
    if (fault === 'wrong-row-U') input.preparation.ownEvidence.row.unshield.value = '401';
    if (fault === 'wrong-T') input.preparation.witness.railgunTxid = hex(91).slice(2);
    if (fault === 'bad-path') input.preparation.witness.elements[0] = hex(91).slice(2);
    text = JSON.stringify(input);
    await expect(run(text, context())).rejects.toMatchObject(failure);
    expect(requestKey).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
