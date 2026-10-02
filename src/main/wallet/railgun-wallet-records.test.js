const {
  createRailgunTokenResolver,
  validateRailgunWalletRecords,
} = require('./railgun-wallet-records');
const hex = (n) => BigInt(n).toString(16).padStart(64, '0');
const nftHash = 'a'.repeat(64),
  nft = { tokenType: 1, tokenAddress: '0x' + '12'.repeat(20), tokenSubID: hex(1) };
const dependencies = {
  getTokenDataHash: (token) => (token.tokenType ? nftHash : hex(99)),
  getTokenDataERC20: () => ({
    tokenType: 0,
    tokenAddress: '0x' + '00'.repeat(19) + '63',
    tokenSubID: hex(0),
  }),
};
const chain = { type: 0, id: 11155111 },
  version = 'V2_PoseidonMerkle';
test('token metadata resolves locally and returned objects cannot mutate the source map', async () => {
  const resolver = createRailgunTokenResolver({ ...dependencies, sourceTokens: [nft] });
  const value = await resolver.getTokenDataFromHash(version, chain, nftHash);
  expect(value).toEqual(nft);
  value.tokenType = 2;
  expect(await resolver.getTokenDataFromHash(version, chain, nftHash)).toEqual(nft);
  expect((await resolver.getTokenDataFromHash(version, chain, hex(99))).tokenType).toBe(0);
  resolver.assertComplete();
});
test.each(['missing', 'chain', 'hash'])(
  'a caught %s token error permanently refuses scan completion',
  async (mode) => {
    const resolver = createRailgunTokenResolver({ ...dependencies, sourceTokens: [] });
    await expect(
      resolver.getTokenDataFromHash(
        version,
        mode === 'chain' ? { type: 0, id: 1 } : chain,
        mode === 'hash' ? 'broken' : nftHash
      )
    ).rejects.toThrow();
    expect(() => resolver.assertComplete()).toThrow('resolution failed');
    await expect(resolver.getTokenDataFromHash(version, chain, hex(99))).rejects.toThrow();
  }
);
function fixture() {
  const txo = {
    tree: 0,
    position: 0,
    txid: hex(4),
    blockNumber: 100,
    commitmentType: 'ShieldCommitment',
    nullifier: hex(5),
    spendtxid: false,
    note: { hash: 1n },
  };
  return {
    txos: [txo],
    expectedReceived: [{ tree: 0, position: 0 }],
    trees: [{ tree: 0, length: 2 }],
    readCommitment: jest.fn(async (tree, position) => ({
      utxoTree: tree,
      utxoIndex: position,
      hash: hex(position + 1),
      txid: hex(4),
      blockNumber: 100,
      commitmentType: 'ShieldCommitment',
    })),
    readNullifier: jest.fn(async () => undefined),
    nullifyingKey: 1n,
    getNullifier: (_key, position) => BigInt(position + 5),
    tokenResolver: createRailgunTokenResolver({ ...dependencies, sourceTokens: [] }),
  };
}
test('a mismatched stored note is fatal even if it was not expected', async () => {
  const input = fixture();
  input.txos[0].note.hash = 9n;
  input.expectedReceived = [];
  await expect(validateRailgunWalletRecords(input)).rejects.toThrow(
    'Recovered note does not match'
  );
});
test.each(['duplicate', 'bounds', 'nullifier', 'spent', 'txid', 'block', 'type'])(
  'refuses %s wallet/source inconsistency',
  async (mode) => {
    const input = fixture(),
      txo = input.txos[0];
    if (mode === 'duplicate') input.txos.push(txo);
    if (mode === 'bounds') txo.position = 2;
    if (mode === 'nullifier') txo.nullifier = hex(6);
    if (mode === 'spent') input.readNullifier.mockResolvedValue(hex(9));
    if (mode === 'txid') txo.txid = hex(9);
    if (mode === 'block') txo.blockNumber = 99;
    if (mode === 'type') txo.commitmentType = 'TransactCommitmentV2';
    await expect(validateRailgunWalletRecords(input)).rejects.toThrow();
  }
);
test('accepts spent state only when it matches the complete local nullifier set', async () => {
  const input = fixture();
  input.txos[0].spendtxid = hex(9);
  input.readNullifier.mockResolvedValue('0x' + hex(9));
  expect((await validateRailgunWalletRecords(input)).accepted).toHaveLength(1);
});

test('shield commitment mismatch is quarantined before unavailable NFT metadata can poison coverage', async () => {
  const { inspectRailgunShield } = require('./railgun-wallet-records');
  const tokenResolver = createRailgunTokenResolver({ ...dependencies, sourceTokens: [] });
  const key = Buffer.alloc(32, 8);
  const input = {
    leaf: {
      commitmentType: 'ShieldCommitment',
      shieldKey: hex(3),
      hash: hex(7),
      encryptedBundle: [],
      preImage: { token: nft, npk: hex(9), value: '0001' },
    },
    wallet: { viewingKeyPair: { privateKey: Buffer.alloc(32) }, masterPublicKey: 1n },
    ShieldNote: {
      decryptRandom: () => '00'.repeat(16),
      getNotePublicKey: () => 8n,
      getShieldNoteHash: () => 7n,
    },
    getSharedSymmetricKey: async () => key,
    getTokenDataHash: () => nftHash,
    tokenResolver,
  };
  expect((await inspectRailgunShield(input)).status).toBe('commitment-mismatch');
  tokenResolver.assertComplete();
  expect(key.equals(Buffer.alloc(32))).toBe(true);
  input.leaf.preImage.npk = hex(8);
  await expect(inspectRailgunShield(input)).rejects.toThrow('Source token preimage');
  expect(() => tokenResolver.assertComplete()).toThrow();
});

test.each(['matched', 'mismatch', 'noncanonical-token', 'foreign'])(
  'Transact preflight handles %s before token resolution',
  async (mode) => {
    const { inspectRailgunTransact } = require('./railgun-wallet-records');
    const resolver = createRailgunTokenResolver({ ...dependencies, sourceTokens: [] });
    const field = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
    const tokenHash =
      mode === 'mismatch' ? nftHash : mode === 'noncanonical-token' ? hex(field + 1n) : hex(99);
    const keys = [];
    const result = await inspectRailgunTransact({
      leaf: {
        commitmentType: 'TransactCommitmentV2',
        hash: hex(1),
        ciphertext: {
          ciphertext: { iv: '', tag: '', data: [] },
          memo: '0x',
          annotationData: '0x',
          blindedSenderViewingKey: hex(2),
          blindedReceiverViewingKey: hex(3),
        },
      },
      wallet: { viewingKeyPair: { privateKey: Buffer.alloc(32) }, masterPublicKey: 1n },
      ShieldNote: { getNotePublicKey: () => 8n },
      TransactNote: {
        getHash: () => (mode === 'mismatch' ? 9n : 1n),
        getDecodedMasterPublicKey: () => 1n,
      },
      AES: {
        decryptGCM: () => {
          if (mode === 'foreign')
            throw new Error('Unable to decrypt ciphertext.', {
              cause: new Error('Unsupported state or unable to authenticate data'),
            });
          return [hex(1), tokenHash, hex(7)];
        },
      },
      Memo: { decryptNoteAnnotationData: () => undefined },
      ByteUtils: { hexlify: (value) => value },
      getSharedSymmetricKey: async () => {
        const key = Buffer.alloc(32, 8);
        keys.push(key);
        return key;
      },
      tokenResolver: resolver,
    });
    expect(result.status).toBe(
      mode === 'matched' ? 'matched' : mode === 'foreign' ? 'not-addressed' : 'commitment-mismatch'
    );
    resolver.assertComplete();
    expect(keys.every((key) => key.equals(Buffer.alloc(32)))).toBe(true);
  }
);

test('a missing authenticated note cannot complete validation', async () => {
  const input = fixture();
  input.txos = [];
  await expect(validateRailgunWalletRecords(input)).rejects.toThrow(
    'Missing authenticated wallet note'
  );
});

test.each(['valid', 'missing', 'duplicate', 'hash', 'block'])(
  'sent-note validation checks %s against preflight and source',
  async (mode) => {
    const { validateRailgunSentRecords } = require('./railgun-wallet-records');
    const input = fixture();
    const leaf = {
      utxoTree: 0,
      utxoIndex: 0,
      hash: hex(1),
      txid: hex(4),
      blockNumber: 100,
      commitmentType: 'TransactCommitmentV2',
    };
    const item = {
      tree: 0,
      position: 0,
      txid: hex(4),
      commitmentType: 'TransactCommitmentV2',
      note: { hash: 1n, blockNumber: 100 },
    };
    const args = {
      sent: [item],
      expectedSent: [{ tree: 0, position: 0 }],
      trees: input.trees,
      readCommitment: async () => leaf,
      tokenResolver: input.tokenResolver,
    };
    if (mode === 'missing') args.sent = [];
    if (mode === 'duplicate') args.sent.push(item);
    if (mode === 'hash') item.note.hash = 2n;
    if (mode === 'block') item.note.blockNumber = 99;
    if (mode === 'valid') await expect(validateRailgunSentRecords(args)).resolves.toBeUndefined();
    else await expect(validateRailgunSentRecords(args)).rejects.toThrow();
  }
);
