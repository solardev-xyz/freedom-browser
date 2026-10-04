const mockArchive = '/synthetic-poi-engine.asar';
let mockResolvePoseidon, mockPoseidon, mockSeenKey, mockController;
let mockWallet, mockInputNote, mockOutputNote, mockAnnotation;
const mockShared = jest.fn(),
  mockDecrypt = jest.fn(),
  mockHash = jest.fn(),
  mockUnshieldHash = jest.fn(),
  mockNpk = jest.fn();
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => mockArchive),
}));
jest.mock('./railgun-private-capsule', () => ({
  normalizeRailgunPrivateCapsule: jest.fn((v) => v),
}));
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
    getSharedSymmetricKey: (...args) => mockShared(...args),
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
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/erc20/shield-note-erc20',
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
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({
    TransactNote: {
      decrypt: (...args) => mockDecrypt(...args),
      getHash: (...args) => mockHash(...args),
      getNullifier: () => 2n,
    },
  }),
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

test('unsupported capsule version refuses before runtime and any owned viewing-key copy', async () => {
  const {
    createRailgunPartialCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const capsule = jest
    .requireActual('./railgun-private-capsule')
    .normalizeRailgunPrivateCapsule(createRailgunPartialCapsuleData().capsule);
  const input = { ...args(), capsule: { ...capsule, version: 3 } };
  mockResolvePoseidon();
  await expect(reconstructRailgunPoiNotes(input)).rejects.toThrow();
  expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
  expect(keys.getPublicViewingKey).not.toHaveBeenCalled();
  expect(mockSeenKey).toBeUndefined();
  expect(input.viewingKey.equals(Buffer.alloc(32, 7))).toBe(true);
});

jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/note-util',
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
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/shield-note',
  () => ({
    ShieldNote: { getNotePublicKey: (...args) => mockNpk(...args) },
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/note/memo',
  () => ({
    Memo: { decryptNoteAnnotationData: (...args) => mockAnnotation(...args) },
  }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/models/formatted-types',
  () => ({ OutputType: { Change: 2 } }),
  { virtual: true }
);
jest.mock(
  '/synthetic-poi-engine.asar/node_modules/@railgun-community/engine/dist/models/transaction-constants',
  () => ({ MEMO_SENDER_RANDOM_NULL: '0'.repeat(30) }),
  { virtual: true }
);

describe('original partial change reconstruction with real capsule/ABI normalization', () => {
  const { Interface, AbiCoder, keccak256 } = require('ethers');
  const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
  const pins = require('./railgun-shield-pins.json');
  const {
    createRailgunPartialCapsuleData,
    createRailgunLegacyCapsuleData,
  } = require('../../../scripts/fixtures/railgun-partial-capsule-data');
  const capsuleModule = require('./railgun-private-capsule');
  const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
  let borrowed;
  beforeEach(() => {
    mockPoseidon = Promise.resolve();
    borrowed = [];
    capsuleModule.normalizeRailgunPrivateCapsule.mockImplementation(
      jest.requireActual('./railgun-private-capsule').normalizeRailgunPrivateCapsule
    );
    keys.getPublicViewingKey.mockImplementation(async (key) => {
      mockSeenKey = key;
      return Buffer.alloc(32, 1);
    });
    mockShared.mockImplementation(async () => {
      const key = Buffer.alloc(32, 8);
      borrowed.push(key);
      return key;
    });
    mockWallet = {
      masterPublicKey: 9n,
      addressKeys: { masterPublicKey: 9n },
      getAddress: () => '0zk1' + 'q'.repeat(123),
      generateShareableViewingKey: () => 'public-test-data',
      getNullifyingKey: () => 6n,
    };
    const tokenData = { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) };
    mockInputNote = {
      notePublicKey: 10n,
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
    mockDecrypt.mockImplementation(async () => ({
      ...mockOutputNote,
      tokenData: { ...mockOutputNote.tokenData },
    }));
    mockNpk.mockImplementation((_mpk, random) => (random === mockInputNote.random ? 10n : 11n));
    mockHash.mockImplementation((npk) => (npk === 10n ? 5n : 3n));
    mockUnshieldHash.mockReturnValue(4n);
    mockAnnotation = jest.fn(() => ({ outputType: 2, senderRandom: '0'.repeat(30) }));
  });
  function input(creatorType = 'Shield', kind = 'railgun-partial-unshield') {
    const fixture =
      kind === 'railgun-partial-unshield'
        ? createRailgunPartialCapsuleData()
        : createRailgunLegacyCapsuleData(kind);
    const capsule = fixture.capsule;
    const descriptor = {
      walletId: capsule.walletId,
      instanceId: mockWallet.getAddress(),
      masterPublicKey: hex(9).slice(2),
      viewingPublicKey: '01'.repeat(32),
      spendingPublicKey: [hex(7).slice(2), hex(8).slice(2)],
    };
    const creator =
      creatorType === 'Shield'
        ? {
            type: 'Shield',
            tree: 0,
            position: 1,
            preimage: {
              npk: hex(10),
              token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
              value: '1000',
            },
            ciphertext: { encryptedBundle: [hex(31), hex(32), hex(33)], shieldKey: hex(34) },
          }
        : {
            type: 'Transact',
            tree: 0,
            position: 1,
            hash: hex(5),
            ciphertext: { ...fixture.inner.boundParams.commitmentCiphertext[0] },
          };
    if (creatorType === 'Transact') mockDecrypt.mockResolvedValueOnce(mockInputNote);
    return {
      fixture,
      args: {
        archive: mockArchive,
        descriptor,
        viewingKey: Buffer.alloc(32, 7),
        capsule,
        creator,
        signal: mockController.signal,
      },
    };
  }
  function recode(fixture) {
    fixture.capsule.preparation.transaction.data = new Interface([TRANSACT_ABI]).encodeFunctionData(
      'transact',
      [[fixture.inner]]
    );
    fixture.capsule.preparation.expected.boundParamsHash = hex(
      BigInt(
        keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [fixture.inner.boundParams]))
      ) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n
    );
  }
  function wiped(a) {
    expect(mockSeenKey.equals(Buffer.alloc(32))).toBe(true);
    expect(a.viewingKey.equals(Buffer.alloc(32, 7))).toBe(true);
    expect(borrowed.length).toBeGreaterThan(0);
    for (const key of borrowed) expect(key.equals(Buffer.alloc(32))).toBe(true);
  }
  test.each(['Shield', 'Transact'])(
    '%s input reconstructs V with only ORIGINAL same-account Change C output',
    async (type) => {
      const { args: a } = input(type),
        before = JSON.stringify(a.capsule);
      const result = await reconstructRailgunPoiNotes(a);
      expect(result.valuesIn).toEqual([1000n]);
      expect(result.valuesOut).toEqual([600n]);
      expect(result.npksOut).toEqual([11n]);
      expect(result.inputNpk).toBe(10n);
      expect(result.utxoPositionsIn).toEqual([1]);
      expect(mockUnshieldHash).toHaveBeenCalledWith(
        a.capsule.selection.recipient,
        mockInputNote.tokenData,
        400n
      );
      const call = mockDecrypt.mock.calls.at(-1),
        bundle = new Interface([TRANSACT_ABI]).decodeFunctionData(
          'transact',
          a.capsule.preparation.transaction.data
        )[0][0].boundParams.commitmentCiphertext[0];
      expect(call[3]).toEqual({
        iv: bundle.ciphertext[0].slice(2, 34),
        tag: bundle.ciphertext[0].slice(34),
        data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
      });
      expect(call[5]).toBe('0x');
      expect(call[6]).toBe(bundle.annotationData);
      expect(call[10]).toBe(false);
      expect(call[11]).toBe(false);
      expect(mockAnnotation).toHaveBeenCalledWith(bundle.annotationData, mockSeenKey);
      expect(JSON.stringify(a.capsule)).toBe(before);
      wiped(a);
    }
  );
  test.each(['railgun-private-transfer', 'railgun-token-unshield'])(
    'legacy %s remains compatible without Change annotation requirements',
    async (kind) => {
      const { args: a } = input('Shield', kind);
      mockOutputNote.value = 1000n;
      mockUnshieldHash.mockReturnValue(3n);
      const result = await reconstructRailgunPoiNotes(a);
      expect(result.valuesOut).toEqual(kind === 'railgun-private-transfer' ? [1000n] : []);
      expect(mockAnnotation).not.toHaveBeenCalled();
      wiped(a);
    }
  );
  test.each(['Shield', 'Transact'])(
    'coherent capsule amounts still require the recovered %s input value',
    async (type) => {
      const { args: a } = input(type);
      a.capsule.preparation.inputAmount = '1001';
      a.capsule.preparation.changeAmount = '601';
      if (type === 'Shield') a.creator.preimage.value = '1001';
      expect(() => capsuleModule.normalizeRailgunPrivateCapsule(a.capsule)).not.toThrow();
      await expect(reconstructRailgunPoiNotes(a)).rejects.toThrow();
      wiped(a);
    }
  );
  test.each([
    'wrong-value',
    'foreign-npk',
    'wrong-token',
    'wrong-token-type',
    'wrong-subID',
    'wrong-token-hash',
    'wrong-hash',
    'hash-inconsistent',
    'annotation-transfer',
    'annotation-null',
    'sender-random',
    'memo-text',
    'memo-ciphertext',
    'bad-unshield-hash',
    'decrypt-failure',
  ])('refuses partial %s and wipes every borrowed key', async (mode) => {
    const { args: a, fixture } = input();
    if (mode === 'wrong-value') mockOutputNote.value = 601n;
    if (mode === 'foreign-npk') {
      mockOutputNote.notePublicKey = 12n;
      mockHash.mockImplementation((npk) => (npk === 10n ? 5n : 3n));
    }
    if (mode === 'wrong-token') mockOutputNote.tokenData.tokenAddress = pins.proxy;
    if (mode === 'wrong-token-type') mockOutputNote.tokenData.tokenType = 1;
    if (mode === 'wrong-subID') mockOutputNote.tokenData.tokenSubID = hex(1);
    if (mode === 'wrong-token-hash') mockOutputNote.tokenHash = 'b'.repeat(64);
    if (mode === 'wrong-hash') mockOutputNote.hash = 4n;
    if (mode === 'hash-inconsistent') mockHash.mockImplementation((npk) => (npk === 10n ? 5n : 8n));
    if (mode === 'annotation-transfer')
      mockAnnotation.mockReturnValue({ outputType: 0, senderRandom: '0'.repeat(30) });
    if (mode === 'annotation-null') mockAnnotation.mockReturnValue(undefined);
    if (mode === 'sender-random')
      mockAnnotation.mockReturnValue({ outputType: 2, senderRandom: '1'.repeat(30) });
    if (mode === 'memo-text') mockOutputNote.memoText = 'unexpected';
    if (mode === 'memo-ciphertext') {
      fixture.inner.boundParams.commitmentCiphertext[0].memo = '0x11';
      recode(fixture);
    }
    if (mode === 'bad-unshield-hash') mockUnshieldHash.mockReturnValue(8n);
    if (mode === 'decrypt-failure') mockDecrypt.mockRejectedValue(Error('bad tag'));
    await expect(reconstructRailgunPoiNotes(a)).rejects.toThrow();
    wiped(a);
  });
  test.each([
    'input',
    'unshield',
    'change',
    'zero-unshield',
    'all-unshield',
    'commitments-reversed',
    'version',
    'extra',
  ])('real capsule normalizer rejects inconsistent partial %s before runtime', async (mode) => {
    const { args: a, fixture } = input();
    if (mode === 'input') a.capsule.preparation.inputAmount = '1001';
    if (mode === 'unshield') a.capsule.preparation.unshieldAmount = '401';
    if (mode === 'change') a.capsule.preparation.changeAmount = '601';
    if (mode === 'zero-unshield') a.capsule.preparation.unshieldAmount = '0';
    if (mode === 'all-unshield') a.capsule.preparation.unshieldAmount = '1000';
    if (mode === 'commitments-reversed') {
      fixture.inner.commitments.reverse();
      recode(fixture);
    }
    if (mode === 'version') a.capsule.version = 1;
    if (mode === 'extra') a.capsule.preparation.random = 'secret';
    await expect(reconstructRailgunPoiNotes(a)).rejects.toThrow();
    expect(runtime.verifyRailgunEngineRuntime).not.toHaveBeenCalled();
    expect(mockSeenKey).toBeUndefined();
  });
  test('caller mutation during pending output decrypt cannot change original capsule/amount/key', async () => {
    const { args: a } = input();
    let release, entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    mockDecrypt.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ ...mockOutputNote });
          entered();
        })
    );
    const work = reconstructRailgunPoiNotes(a);
    await ready;
    a.capsule.preparation.changeAmount = '9';
    a.capsule.preparation.transaction.data = '0x';
    a.viewingKey.fill(9);
    release();
    expect((await work).valuesOut).toEqual([600n]);
    expect(mockSeenKey.equals(Buffer.alloc(32))).toBe(true);
    expect(a.viewingKey.equals(Buffer.alloc(32, 9))).toBe(true);
  });
  test('cancelled pending output decrypt drains its working key and cannot return secrets', async () => {
    const { args: a } = input();
    let release, entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    mockDecrypt.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ ...mockOutputNote });
          entered();
        })
    );
    let settled = false;
    const work = reconstructRailgunPoiNotes(a).finally(() => {
      settled = true;
    });
    const rejected = expect(work).rejects.toThrow();
    await ready;
    mockController.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(mockSeenKey.equals(Buffer.alloc(32))).toBe(false);
    release();
    await rejected;
    wiped(a);
  });
});
