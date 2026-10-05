const mockArchive = '/receiver-test-engine.asar';
let mockNote,
  mockWallet,
  mockPoseidon,
  mockPublicKey,
  mockShared,
  mockDecrypt,
  mockNpk,
  mockHash,
  mockUnshield,
  mockAnnotation;
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: jest.fn((v) => v) }));
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockPoseidon;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    getPublicViewingKey: (...a) => mockPublicKey(...a),
    getSharedSymmetricKey: (...a) => mockShared(...a),
  }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/wallet/view-only-wallet',
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
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({
    TransactNote: { decrypt: (...a) => mockDecrypt(...a), getHash: (...a) => mockHash(...a) },
  }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/note/note-util',
  () => ({
    getTokenDataERC20: () => ({
      tokenType: 0,
      tokenAddress: require('./railgun-shield-pins.json').wrappedNative,
      tokenSubID: '0x' + '0'.repeat(64),
    }),
    getTokenDataHash: () => 'a'.repeat(64),
    getNoteHash: (...a) => mockUnshield(...a),
  }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/note/shield-note',
  () => ({ ShieldNote: { getNotePublicKey: (...a) => mockNpk(...a) } }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/note/memo',
  () => ({ Memo: { decryptNoteAnnotationData: (...a) => mockAnnotation(...a) } }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/models/formatted-types',
  () => ({ OutputType: { Change: 2 } }),
  { virtual: true }
);
jest.mock(
  '/receiver-test-engine.asar/node_modules/@railgun-community/engine/dist/models/transaction-constants',
  () => ({ MEMO_SENDER_RANDOM_NULL: '0'.repeat(30) }),
  { virtual: true }
);
const { run } = require('./railgun-private-receive-job');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
let controller, key, shared, request, requestKey, guardReport;
beforeEach(() => {
  jest.clearAllMocks();
  controller = new AbortController();
  key = Buffer.alloc(32, 7);
  shared = Buffer.alloc(32, 8);
  mockPoseidon = Promise.resolve();
  mockPublicKey = jest.fn(async () => Buffer.alloc(32, 1));
  mockShared = jest.fn(async () => shared);
  mockWallet = {
    masterPublicKey: 9n,
    addressKeys: { masterPublicKey: 9n },
    getAddress: () => '0zk1' + 'q'.repeat(123),
    generateShareableViewingKey: () => 'public-test-data',
  };
  mockNote = {
    value: 600n,
    notePublicKey: 11n,
    random: '02'.repeat(16),
    tokenHash: 'a'.repeat(64),
    tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
    hash: 3n,
  };
  mockDecrypt = jest.fn(async () => mockNote);
  mockHash = jest.fn(() => 3n);
  mockNpk = jest.fn(() => 11n);
  mockUnshield = jest.fn(() => 4n);
  mockAnnotation = jest.fn(() => ({ outputType: 2, senderRandom: '0'.repeat(30) }));
  request = jest.fn(async () => JSON.stringify({ id: 2, value: null }));
  requestKey = jest.fn(async () => key);
  guardReport = jest.fn(() => ({ attempts: 0, canaries: 1, hooks: ['test.hook'] }));
});
function fixture(partial = true) {
  const data = partial
    ? createRailgunPartialCapsuleData()
    : createRailgunLegacyCapsuleData('railgun-private-transfer');
  if (!partial) mockNote.value = 1000n;
  const input = {
    archive: mockArchive,
    descriptor: {
      walletId: '1'.repeat(64),
      instanceId: mockWallet.getAddress(),
      masterPublicKey: hex(9).slice(2),
      viewingPublicKey: '01'.repeat(32),
      spendingPublicKey: [hex(7).slice(2), hex(8).slice(2)],
    },
    transaction: data.capsule.preparation.transaction,
    expected: data.capsule.preparation.expected,
    recipient: mockWallet.getAddress(),
    ...(partial ? { inputAmount: '1000' } : { amount: '1000' }),
  };
  return { input, data };
}
const execute = (input) =>
  run(JSON.stringify(input), { request, requestKey, signal: controller.signal, guardReport });
function recode({ input, data }) {
  input.transaction.data = new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [
    [data.inner],
  ]);
  input.expected.boundParamsHash = hex(
    BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [data.inner.boundParams]))) %
      21888242871839275222246405745257275088548364400416034343698204186575808495617n
  );
}
function wiped() {
  expect(key.equals(Buffer.alloc(key.length))).toBe(true);
  expect(shared.equals(Buffer.alloc(32))).toBe(true);
}
test.each([false, true])(
  'real %s intent produces exact receiver wire after viewing-only original-ciphertext check',
  async (partial) => {
    const { input } = fixture(partial);
    await execute(input);
    expect(requestKey).toHaveBeenCalledWith(
      JSON.stringify({ id: 1, method: 'key', purpose: 'private-receive' })
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe(
      JSON.stringify({
        id: 2,
        method: 'result',
        value: {
          verified: true,
          transactionDigest: validateRailgunPrivateSigningIntent(input.transaction, input.expected)
            .digest,
          recipient: input.recipient,
          ...(partial
            ? { inputAmount: '1000', unshieldAmount: '400', changeAmount: '600' }
            : { amount: '1000' }),
          inventory: require('./railgun-engine-manifest.json').inventory.sha256,
          guards: guardReport(),
        },
      })
    );
    const call = mockDecrypt.mock.calls[0],
      bundle = new Interface([TRANSACT_ABI]).decodeFunctionData(
        'transact',
        input.transaction.data
      )[0][0].boundParams.commitmentCiphertext[0];
    expect(call[3]).toEqual({
      iv: bundle.ciphertext[0].slice(2, 34),
      tag: bundle.ciphertext[0].slice(34),
      data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
    });
    expect(call[10]).toBe(false);
    expect(call[11]).toBe(false);
    if (partial) {
      expect(mockNpk).toHaveBeenCalledWith(9n, mockNote.random);
      expect(mockUnshield).toHaveBeenCalledWith(input.expected.recipient, mockNote.tokenData, 400n);
    } else {
      expect(mockNpk).not.toHaveBeenCalled();
      expect(mockUnshield).not.toHaveBeenCalled();
      expect(mockAnnotation).not.toHaveBeenCalled();
    }
    wiped();
  }
);
test.each([
  'value',
  'npk',
  'token',
  'tokenType',
  'subID',
  'hash',
  'hash-recompute',
  'annotation',
  'senderRandom',
  'memo',
  'memoText',
  'unshieldHash',
  'decrypt',
])('partial %s fails directly after original output decrypt', async (mode) => {
  const f = fixture();
  if (mode === 'value') mockNote.value = 601n;
  if (mode === 'npk') mockNote.notePublicKey = 12n;
  if (mode === 'token') mockNote.tokenData.tokenAddress = pins.proxy;
  if (mode === 'tokenType') mockNote.tokenData.tokenType = 1;
  if (mode === 'subID') mockNote.tokenData.tokenSubID = hex(1);
  if (mode === 'hash') mockNote.hash = 4n;
  if (mode === 'hash-recompute') mockHash.mockReturnValue(8n);
  if (mode === 'annotation')
    mockAnnotation.mockReturnValue({ outputType: 0, senderRandom: '0'.repeat(30) });
  if (mode === 'senderRandom')
    mockAnnotation.mockReturnValue({ outputType: 2, senderRandom: '1'.repeat(30) });
  if (mode === 'memo') {
    f.data.inner.boundParams.commitmentCiphertext[0].memo = '0x11';
    recode(f);
  }
  if (mode === 'memoText') mockNote.memoText = 'unexpected';
  if (mode === 'unshieldHash') mockUnshield.mockReturnValue(8n);
  if (mode === 'decrypt') mockDecrypt.mockRejectedValue(Error('bad tag'));
  expect(() =>
    validateRailgunPrivateSigningIntent(f.input.transaction, f.input.expected)
  ).not.toThrow();
  await expect(execute(f.input)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  wiped();
});
test.each([
  'amount',
  'changeAmount',
  'unshieldAmount',
  'zero',
  'all',
  'over-cap',
  'recipient',
  'expected',
  'order',
  'proof',
  'extra',
])('invalid public partial %s refuses before viewing-key request', async (mode) => {
  const f = fixture(),
    i = f.input;
  if (['amount', 'changeAmount', 'unshieldAmount', 'extra'].includes(mode)) i[mode] = '400';
  if (mode === 'zero') i.inputAmount = '0';
  if (mode === 'all') i.inputAmount = '400';
  if (mode === 'over-cap') i.inputAmount = '10000000000000001';
  if (mode === 'recipient') i.recipient = i.expected.recipient;
  if (mode === 'expected') i.expected.unshieldAmount = '401';
  if (mode === 'order') {
    f.data.inner.commitments.reverse();
    recode(f);
  }
  if (mode === 'proof') {
    f.data.inner.proof.a.x = 1;
    recode(f);
  }
  await expect(execute(i)).rejects.toThrow();
  expect(requestKey).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
test.each([0, 31, 33])(
  'wrong-sized %s-byte credential is wiped without cryptographic work',
  async (length) => {
    key = Buffer.alloc(length, 7);
    await expect(execute(fixture().input)).rejects.toThrow();
    expect(key.equals(Buffer.alloc(length))).toBe(true);
    expect(mockPublicKey).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  }
);
test.each(['poseidon', 'publicKey', 'shared', 'decrypt'])(
  'abort during %s drains its await and cannot return verified result',
  async (stage) => {
    const f = fixture();
    let release, enter;
    const entered = new Promise((r) => {
      enter = r;
    });
    const gate = new Promise((r) => {
      release = r;
    });
    if (stage === 'poseidon') {
      mockPoseidon = gate;
      enter();
    }
    if (stage === 'publicKey')
      mockPublicKey.mockImplementation(async () => {
        enter();
        await gate;
        return Buffer.alloc(32, 1);
      });
    if (stage === 'shared')
      mockShared.mockImplementation(async () => {
        enter();
        await gate;
        return shared;
      });
    if (stage === 'decrypt')
      mockDecrypt.mockImplementation(async () => {
        enter();
        await gate;
        return mockNote;
      });
    let settled = false;
    const work = execute(f.input).finally(() => {
      settled = true;
    });
    const failure = expect(work).rejects.toThrow();
    await entered;
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await failure;
    expect(request).not.toHaveBeenCalled();
    if (stage === 'poseidon') expect(requestKey).not.toHaveBeenCalled();
    else expect(key.equals(Buffer.alloc(32))).toBe(true);
    if (stage === 'shared' || stage === 'decrypt')
      expect(shared.equals(Buffer.alloc(32))).toBe(true);
  }
);
test.each(['guards', 'ack', 'post-result'])('refuses %s failure after decryption', async (mode) => {
  if (mode === 'guards')
    guardReport.mockReturnValue({ attempts: 1, canaries: 1, hooks: ['test.hook'] });
  if (mode === 'ack') request.mockResolvedValue('{"id":3,"value":null}');
  if (mode === 'post-result')
    request.mockImplementation(async () => {
      controller.abort();
      return '{"id":2,"value":null}';
    });
  await expect(execute(fixture().input)).rejects.toThrow();
  wiped();
});
