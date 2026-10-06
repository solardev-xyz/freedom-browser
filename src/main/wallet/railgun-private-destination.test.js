/** Each destination and sent-output check in isolation, with a minimal engine shim.
 * The coherent end-to-end model lives in railgun-private-foreign-transfer.test.js.
 */
const {
  isRailgunForeignTransfer,
  assertRailgunPrivateTransferRecipient,
  decodeRailgunForeignDestination,
  verifyRailgunForeignOutput,
} = require('./railgun-private-destination');
const pins = require('./railgun-shield-pins.json');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SELF = '0zk1' + 'q'.repeat(123),
  OTHER = '0zk1' + 'p'.repeat(123);
const NULL_RANDOM = '0'.repeat(30);
const own = { masterPublicKey: 11n, viewingPublicKey: Buffer.alloc(32, 1) };
const peer = { masterPublicKey: 22n, viewingPublicKey: Buffer.alloc(32, 2) };
const word = (n) => '0x' + n.toString(16).padStart(64, '0');
let decoded, encoded, output, blinded, shared, modules;
const imp = (name) => {
  if (!Object.hasOwn(modules, name)) throw Error('unexpected engine module ' + name);
  return modules[name];
};
beforeEach(() => {
  decoded = { ...peer, viewingPublicKey: Uint8Array.from(peer.viewingPublicKey), version: 1 };
  encoded = OTHER;
  shared = Buffer.alloc(32, 9);
  blinded = {
    blindedSenderViewingKey: Buffer.alloc(32, 5),
    blindedReceiverViewingKey: Buffer.alloc(32, 6),
  };
  output = {
    receiverAddressData: { ...peer, viewingPublicKey: Uint8Array.from(peer.viewingPublicKey) },
    value: 1000n,
    tokenHash: 'ab'.repeat(32),
    tokenData: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: word(0) },
    outputType: 0,
    walletSource: 'freedomfixture',
    memoText: undefined,
    random: '0f'.repeat(16),
    senderRandom: '1e'.repeat(15),
    notePublicKey: 33n,
    hash: 44n,
  };
  modules = {
    'key-derivation/bech32': {
      decodeAddress: jest.fn(() => decoded),
      encodeAddress: jest.fn(() => encoded),
    },
    'note/transact-note': {
      TransactNote: {
        decrypt: jest.fn(async () => output),
        getHash: jest.fn(() => 44n),
      },
    },
    'note/shield-note': { ShieldNote: { getNotePublicKey: jest.fn(() => 33n) } },
    'utils/keys-utils': {
      getSharedSymmetricKey: jest.fn(async () => shared),
      getNoteBlindingKeys: jest.fn(() => blinded),
    },
    'models/formatted-types': { OutputType: { Transfer: 0, BroadcasterFee: 1, Change: 2 } },
    'models/transaction-constants': { MEMO_SENDER_RANDOM_NULL: NULL_RANDOM },
  };
});
const bundle = () => ({
  ciphertext: [word(1), word(2), word(3), word(4)],
  blindedSenderViewingKey: '0x' + '05'.repeat(32),
  blindedReceiverViewingKey: '0x' + '06'.repeat(32),
  annotationData: '0x1122',
  memo: '0x',
});
const verify = (overrides = {}) =>
  verifyRailgunForeignOutput(imp, {
    bundle: bundle(),
    viewingPrivateKey: Buffer.alloc(32, 7),
    sender: own,
    destination: decodeRailgunForeignDestination(imp, OTHER, own),
    value: 1000n,
    tokenHash: 'ab'.repeat(32),
    commitment: 44n,
    tokenDataGetter: {},
    active: () => {},
    ...overrides,
  });

describe('main-side string policy', () => {
  const transfer = (recipient, marker) => ({
    kind: 'railgun-private-transfer',
    recipient,
    ...(marker === undefined ? {} : { recipientRelationship: marker }),
  });
  test('an unmarked transfer keeps the exact historical self equality', () => {
    expect(assertRailgunPrivateTransferRecipient(transfer(SELF), SELF)).toBe('self');
    expect(assertRailgunPrivateTransferRecipient(transfer('legacy-self'), 'legacy-self')).toBe(
      'self'
    );
    expect(() => assertRailgunPrivateTransferRecipient(transfer(OTHER), SELF)).toThrow();
    expect(isRailgunForeignTransfer(transfer(SELF))).toBe(false);
  });
  test('only an explicit well-formed foreign marker names another destination', () => {
    expect(assertRailgunPrivateTransferRecipient(transfer(OTHER, 'foreign'), SELF)).toBe('foreign');
    expect(isRailgunForeignTransfer(transfer(OTHER, 'foreign'))).toBe(true);
    for (const [recipient, marker] of [
      [SELF, 'foreign'],
      [OTHER, 'self'],
      [OTHER, 'Foreign'],
      [OTHER, true],
      ['0zk1' + 'P'.repeat(123), 'foreign'],
      ['0zk1' + 'p'.repeat(124), 'foreign'],
      ['0zk1' + 'b'.repeat(123), 'foreign'],
      ['0x' + '12'.repeat(20), 'foreign'],
    ])
      expect(() =>
        assertRailgunPrivateTransferRecipient(transfer(recipient, marker), SELF)
      ).toThrow();
    expect(() =>
      assertRailgunPrivateTransferRecipient(
        { ...transfer(OTHER, 'foreign'), kind: 'railgun-partial-unshield' },
        SELF
      )
    ).toThrow();
    expect(() =>
      assertRailgunPrivateTransferRecipient(transfer(OTHER, 'foreign'), undefined)
    ).toThrow();
  });
});

describe('strict destination decode', () => {
  test('accepts all-chain and exact Sepolia canonical encodings with fresh key copies', () => {
    const value = decodeRailgunForeignDestination(imp, OTHER, own);
    expect(value).toEqual({
      masterPublicKey: 22n,
      viewingPublicKey: Uint8Array.from(peer.viewingPublicKey),
      version: 1,
    });
    expect(value.viewingPublicKey).not.toBe(decoded.viewingPublicKey);
    expect(Object.isFrozen(value)).toBe(true);
    decoded.chain = { type: 0, id: pins.chainId };
    expect(decodeRailgunForeignDestination(imp, OTHER, own).chain).toEqual({
      type: 0,
      id: pins.chainId,
    });
    expect(modules['key-derivation/bech32'].encodeAddress).toHaveBeenLastCalledWith(decoded);
  });
  test.each([
    ['wrong chain id', () => (decoded.chain = { type: 0, id: 1 })],
    ['wrong chain type', () => (decoded.chain = { type: 1, id: pins.chainId })],
    ['unsupported version', () => (decoded.version = 2)],
    ['missing version', () => delete decoded.version],
    ['non-canonical', () => (encoded = '0zk1' + 'r'.repeat(123))],
    ['zero master key', () => (decoded.masterPublicKey = 0n)],
    ['field-sized master key', () => (decoded.masterPublicKey = FIELD)],
    ['numeric master key', () => (decoded.masterPublicKey = 22)],
    ['short viewing key', () => (decoded.viewingPublicKey = new Uint8Array(31))],
    ['own master key', () => (decoded.masterPublicKey = own.masterPublicKey)],
    ['own viewing key', () => (decoded.viewingPublicKey = Uint8Array.from(own.viewingPublicKey))],
    [
      'own keys at another encoding',
      () =>
        Object.assign(decoded, own, { viewingPublicKey: Uint8Array.from(own.viewingPublicKey) }),
    ],
    [
      'undecodable',
      () =>
        modules['key-derivation/bech32'].decodeAddress.mockImplementation(() => {
          throw Error('Failed to decode bech32 address');
        }),
    ],
  ])('refuses %s', (_name, mutate) => {
    mutate();
    expect(() => decodeRailgunForeignDestination(imp, OTHER, own)).toThrow();
  });
  test('refuses malformed strings before any engine decode', () => {
    for (const value of ['0zk1' + 'P'.repeat(123), OTHER + 'q', 'self', 7])
      expect(() => decodeRailgunForeignDestination(imp, value, own)).toThrow();
    expect(modules['key-derivation/bech32'].decodeAddress).not.toHaveBeenCalled();
  });
  test('refuses when the own viewing key is unavailable for comparison', () => {
    expect(() =>
      decodeRailgunForeignDestination(imp, OTHER, { masterPublicKey: own.masterPublicKey })
    ).toThrow();
  });
});

describe('sent-output verification', () => {
  test('recovers as sender with the blinded receiver key and returns only public-safe data', async () => {
    const value = await verify();
    expect(value).toEqual({ notePublicKey: 33n, value: 1000n, hash: 44n });
    const [getShared] = [modules['utils/keys-utils'].getSharedSymmetricKey];
    expect(getShared.mock.calls[0][1]).toEqual(Buffer.alloc(32, 6));
    const call = modules['note/transact-note'].TransactNote.decrypt.mock.calls[0];
    expect(call[2]).toBe(own);
    expect(call.slice(10, 12)).toEqual([true, false]);
    expect(call[3]).toEqual({
      iv: word(1).slice(2, 34),
      tag: word(1).slice(34),
      data: [word(2), word(3), word(4)].map((v) => v.slice(2)),
    });
    expect(modules['note/shield-note'].ShieldNote.getNotePublicKey).toHaveBeenCalledWith(
      22n,
      output.random
    );
    expect(modules['utils/keys-utils'].getNoteBlindingKeys).toHaveBeenCalledWith(
      own.viewingPublicKey,
      Uint8Array.from(peer.viewingPublicKey),
      output.random,
      output.senderRandom
    );
    expect(shared.equals(Buffer.alloc(32))).toBe(true);
  });
  test.each([
    ['receiver master key', () => (output.receiverAddressData.masterPublicKey = 23n)],
    ['receiver viewing key', () => (output.receiverAddressData.viewingPublicKey[0] = 9)],
    [
      'unblinded viewing key',
      () => (output.receiverAddressData.viewingPublicKey = new Uint8Array()),
    ],
    ['value', () => (output.value = 999n)],
    ['token hash', () => (output.tokenHash = 'cd'.repeat(32))],
    ['token address', () => (output.tokenData.tokenAddress = pins.proxy)],
    ['token type', () => (output.tokenData.tokenType = 1)],
    ['token sub id', () => (output.tokenData.tokenSubID = word(1))],
    ['change type', () => (output.outputType = 2)],
    ['fee type', () => (output.outputType = 1)],
    ['missing annotation', () => (output.outputType = undefined)],
    ['wallet source', () => (output.walletSource = 'other')],
    ['memo text', () => (output.memoText = 'hello')],
    ['random', () => (output.random = 'zz')],
    ['sender revealed', () => (output.senderRandom = NULL_RANDOM)],
    ['sender random missing', () => (output.senderRandom = undefined)],
    ['npk', () => modules['note/shield-note'].ShieldNote.getNotePublicKey.mockReturnValue(34n)],
    ['hash', () => modules['note/transact-note'].TransactNote.getHash.mockReturnValue(45n)],
    ['commitment', () => (output.hash = 46n)],
    ['blinded sender', () => (blinded.blindedSenderViewingKey = Buffer.alloc(32, 15))],
    ['blinded receiver', () => (blinded.blindedReceiverViewingKey = Buffer.alloc(32, 16))],
    [
      'decrypt failure',
      () => modules['note/transact-note'].TransactNote.decrypt.mockRejectedValue(Error('bad tag')),
    ],
    ['short shared key', () => (shared = Buffer.alloc(31, 9))],
  ])('refuses %s and wipes the borrowed shared key', async (_name, mutate) => {
    mutate();
    await expect(verify()).rejects.toThrow();
    expect(shared.equals(Buffer.alloc(shared.length))).toBe(true);
  });
  test.each([
    ['memo ciphertext', (b) => (b.memo = '0x11')],
    ['missing memo', (b) => delete b.memo],
    ['ciphertext words', (b) => b.ciphertext.pop()],
    ['uppercase ciphertext', (b) => (b.ciphertext[0] = b.ciphertext[0].toUpperCase())],
    ['odd annotation', (b) => (b.annotationData = '0x1')],
    ['blinded key length', (b) => (b.blindedReceiverViewingKey = '0x06')],
  ])('refuses bundle %s before any key agreement', async (_name, mutate) => {
    const value = bundle();
    mutate(value);
    await expect(verify({ bundle: value })).rejects.toThrow();
    expect(modules['utils/keys-utils'].getSharedSymmetricKey).not.toHaveBeenCalled();
  });
  test('expected value and commitment are caller-bound', async () => {
    await expect(verify({ value: 999n })).rejects.toThrow();
    await expect(verify({ commitment: 45n })).rejects.toThrow();
    await expect(verify({ commitment: FIELD })).rejects.toThrow();
    await expect(verify({ active: undefined })).rejects.toThrow();
  });
  test('cancellation after decryption still wipes the borrowed shared key', async () => {
    let live = true;
    modules['note/transact-note'].TransactNote.decrypt.mockImplementation(async () => {
      live = false;
      return output;
    });
    await expect(
      verify({
        active: () => {
          if (!live) throw Error('aborted');
        },
      })
    ).rejects.toThrow('aborted');
    expect(shared.equals(Buffer.alloc(32))).toBe(true);
  });
});
