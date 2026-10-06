/** Controlled engine seams only. No authenticated archive or crypto executes. */
const { AbiCoder, Interface, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { prepareRailgunRelayDraft } = require('./railgun-relay-witness');
const { reconstructRailgunRelayDraft } = require('./railgun-relay-reconstruct');
let mockState;
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: jest.fn(() => '/relay-test-engine.asar'),
}));
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/key-derivation/bech32',
  () => ({
    decodeAddress: (...args) => mockState.decode(...args),
    encodeAddress: (...args) => mockState.encode(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/utils/poseidon',
  () => ({
    get initPoseidonPromise() {
      return mockState.init;
    },
    poseidon: (...args) => mockState.poseidon(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/merkletree/merkle-proof',
  () => ({
    verifyMerkleProof: (...args) => mockState.merkle(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/models/formatted-types',
  () => ({
    OutputType: { Transfer: 0, BroadcasterFee: 1 },
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/note/transact-note',
  () => ({
    get TransactNote() {
      return mockState.Note;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/transaction/transaction',
  () => ({
    get Transaction() {
      return mockState.Transaction;
    },
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/transaction/bound-params',
  () => ({
    hashBoundParamsV2: (...args) => mockState.boundHash(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/note/note-util',
  () => ({
    getTokenDataHash: (...args) => mockState.tokenHash(...args),
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/note/shield-note',
  () => ({
    ShieldNote: { getNotePublicKey: (...args) => mockState.npk(...args) },
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/key-derivation/wallet-node',
  () => ({
    WalletNode: { getMasterPublicKey: (...args) => mockState.master(...args) },
  }),
  { virtual: true }
);
jest.mock(
  '/relay-test-engine.asar/node_modules/@railgun-community/engine/dist/utils/keys-utils',
  () => ({
    getSharedSymmetricKey: (...args) => mockState.symmetric(...args),
    getNoteBlindingKeys: (...args) => mockState.blind(...args),
  }),
  { virtual: true }
);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const bytes = (n, count = 32) => Buffer.alloc(count, n);
const clone = (value) => JSON.parse(JSON.stringify(value));
const abi = new Interface([TRANSACT_ABI]);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function fixture() {
  const selfAddress = '0zk1' + 'p'.repeat(123),
    peerAddress = '0zk1' + 'q'.repeat(123);
  const self = { masterPublicKey: 7n, viewingPublicKey: bytes(2) };
  const peer = {
    masterPublicKey: 8n,
    viewingPublicKey: bytes(3),
    version: 1,
    chain: { type: 0, id: pins.chainId },
  };
  const token = { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: '0' };
  const tokenHash = '00'.repeat(31) + '09';
  const npk = (master, random) => master + BigInt('0x' + random);
  const noteHash = (key, _token, amount) => (key + amount + 9n) % FIELD;
  const output = (index) => {
    const receiver = index === 0 ? peer : self,
      seed = index === 0 ? 17 : 34;
    const random = bytes(seed, 16).toString('hex'),
      value = index === 0 ? 100n : 600n;
    const key = npk(receiver.masterPublicKey, random);
    return {
      receiverAddressData: {
        masterPublicKey: receiver.masterPublicKey,
        viewingPublicKey: Buffer.from(receiver.viewingPublicKey),
      },
      value,
      tokenData: { ...token },
      tokenHash,
      outputType: index === 0 ? 1 : 0,
      walletSource: 'freedomfixture',
      memoText: undefined,
      random,
      senderRandom: bytes(seed + 1, 15).toString('hex'),
      notePublicKey: key,
      hash: noteHash(key, tokenHash, value),
    };
  };
  const cipher = (index) => {
    const seed = index === 0 ? 17 : 34;
    return {
      ciphertext: [hex(seed), hex(seed), hex(9), hex(index === 0 ? 100 : 600)],
      blindedSenderViewingKey: '0x' + bytes(seed + 2).toString('hex'),
      blindedReceiverViewingKey: '0x' + bytes(seed + 3).toString('hex'),
      annotationData: '0x' + (index === 0 ? '01' : '00'),
      memo: '0x',
    };
  };
  const input = { random: '01'.repeat(16), value: 700n, tokenData: token, tokenHash };
  input.notePublicKey = npk(self.masterPublicKey, input.random);
  input.hash = noteHash(input.notePublicKey, tokenHash, input.value);
  const proof = {
    leaf: hex(input.hash).slice(2),
    root: hex(77).slice(2),
    indices: hex(3).slice(2),
    elements: Array(16).fill(hex(1).slice(2)),
  };
  const record = {
    tree: 0,
    position: 3,
    spentTxid: false,
    hash: hex(input.hash).slice(2),
    value: '700',
  };
  const controller = new AbortController();
  const state = {
    self,
    peer,
    output,
    cipher,
    init: Promise.resolve(),
    loans: [],
    controller,
    decode: jest.fn(() => ({
      ...peer,
      viewingPublicKey: Buffer.from(peer.viewingPublicKey),
      chain: { ...peer.chain },
    })),
    encode: jest.fn(() => peerAddress),
    poseidon: jest.fn((items) => items.reduce((a, b) => a + b, 0n) % FIELD),
    merkle: jest.fn((p) => JSON.stringify(p) === JSON.stringify(proof)),
    tokenHash: jest.fn(() => tokenHash),
    npk: jest.fn(npk),
    master: jest.fn((pub, key) => {
      expect(pub).toEqual([4n, 5n]);
      expect(key).toBe(6n);
      return 7n;
    }),
    boundHash: jest.fn(
      (bound) =>
        BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    ),
    blind: jest.fn((_sender, receiver, random, senderRandom) => {
      const seed = parseInt(random.slice(0, 2), 16);
      expect(senderRandom).toBe(bytes(seed + 1, 15).toString('hex'));
      expect(Buffer.from(receiver)).toEqual(
        seed === 17 ? peer.viewingPublicKey : self.viewingPublicKey
      );
      return {
        blindedSenderViewingKey: bytes(seed + 2),
        blindedReceiverViewingKey: bytes(seed + 3),
      };
    }),
    symmetric: jest.fn(async (key, receiver) => {
      expect(key).toEqual(bytes(99));
      const result = bytes(receiver[0]);
      state.loans.push(result);
      return result;
    }),
  };
  state.Note = {
    createTransfer: jest.fn((receiver, sender, value, _token, visible, type, memo) => {
      const index = type === 1 ? 0 : 1;
      expect(receiver.masterPublicKey).toBe(index === 0 ? 8n : 7n);
      expect(sender).toBe(self);
      expect(value).toBe(index === 0 ? 100n : 600n);
      expect(visible).toBe(false);
      expect(memo).toBeUndefined();
      return output(index);
    }),
    decrypt: jest.fn(
      async (
        _version,
        _chain,
        address,
        ciphertext,
        symmetric,
        memo,
        annotation,
        _key,
        receiver,
        sender,
        sent,
        legacy
      ) => {
        expect(address).toBe(self);
        expect(sent).toBe(true);
        expect(legacy).toBe(false);
        expect(memo).toBe('0x');
        const seed = Number(BigInt('0x' + ciphertext.data[0]));
        if (![17, 34].includes(seed)) throw Error('Damaged ciphertext');
        expect(symmetric[0]).toBe(seed + 3);
        expect(receiver).toEqual(bytes(seed + 3));
        expect(sender).toEqual(bytes(seed + 2));
        const recovered = output(seed === 17 ? 0 : 1);
        recovered.outputType = parseInt(annotation.slice(2), 16);
        return recovered;
      }
    ),
    getHash: jest.fn(noteHash),
    getNullifier: jest.fn(() => 88n),
  };
  state.generate = jest.fn(async (wallet, version, password, boundInput, outputs) => {
    expect(await wallet.getSpendingKeyPair()).toEqual({ pubkey: [4n, 5n] });
    expect(version).toBe('V2_PoseidonMerkle');
    expect(password).toBe('');
    expect(await wallet.getUTXOMerkletree().getMerkleProof(0, 3)).toBe(proof);
    const boundParams = {
      treeNumber: 0,
      minGasPrice: boundInput.minGasPrice,
      unshield: 0,
      chainID: pins.chainId,
      adaptContract: '0x' + '0'.repeat(40),
      adaptParams: hex(0),
      commitmentCiphertext: [cipher(0), cipher(1)],
    };
    return {
      privateInputs: {
        publicKey: [4n, 5n],
        valueIn: [700n],
        valueOut: outputs.map((v) => v.value),
      },
      publicInputs: {
        merkleRoot: 77n,
        nullifiers: [88n],
        commitmentsOut: outputs.map((v) => v.hash),
        boundParamsHash: state.boundHash(boundParams),
      },
      boundParams,
    };
  });
  state.Transaction = class {
    constructor(_chain, _token, tree, txos, outputs) {
      expect(tree).toBe(0);
      expect(txos).toHaveLength(1);
      this.outputs = outputs;
    }
    generateTransactionRequest(...args) {
      return state.generate(...args, this.outputs);
    }
  };
  const fields = {
    fees: { [pins.wrappedNative]: '0xde0b6b3a7640000' },
    feeExpiration: 1,
    feesID: 'unit-only',
    railgunAddress: peerAddress,
    availableWallets: 1,
    version: '8.0.0',
    relayAdapt: pins.relayAdapt,
    requiredPOIListKeys: [],
    reliability: -1,
  };
  state.args = {
    archive: '/untrusted-input.asar',
    signal: controller.signal,
    descriptor: {
      walletId: '11'.repeat(32),
      instanceId: selfAddress,
      spendingPublicKey: [hex(4).slice(2), hex(5).slice(2)],
    },
    wallet: {
      getAddress: jest.fn(() => selfAddress),
      addressKeys: self,
      viewingKeyPair: { privateKey: bytes(99), pubkey: self.viewingPublicKey },
      getNullifyingKey: jest.fn(() => 6n),
      getViewingKeyPair: jest.fn(() => ({ privateKey: bytes(99), pubkey: self.viewingPublicKey })),
      getSpendingKeyPair: jest.fn(() => {
        throw Error('Spending key forbidden');
      }),
      TXOs: jest.fn(async () => [{ tree: 0, position: 3, spendtxid: false, note: input }]),
      tokenDataGetter: {},
    },
    tree: { getMerkleProof: jest.fn(async () => proof) },
    checkpoint: { state: { trees: [{ tree: 0, length: 4, root: hex(77) }] } },
    scan: {
      instanceId: selfAddress,
      received: [record],
      ownedPoi: [{ id: '0:3', hash: hex(input.hash), nullifier: hex(88) }],
    },
    request: {
      selection: { tree: 0, position: 3 },
      context: {
        walletId: '11'.repeat(32),
        self: {
          address: selfAddress,
          masterPublicKey: '7',
          viewingPublicKey: self.viewingPublicKey.toString('hex'),
        },
        peer: {
          address: peerAddress,
          masterPublicKey: '8',
          viewingPublicKey: peer.viewingPublicKey.toString('hex'),
        },
        quote: {
          data: Buffer.from(JSON.stringify(fields)).toString('hex'),
          signature: '04'.repeat(64),
        },
        gas: { transactionType: 0, gasEstimate: '84', gasPrice: '1', minGasPrice: '1' },
        inputAmount: '700',
        feeAmount: '100',
        selfAmount: '600',
        feeCap: '100',
      },
    },
  };
  return state;
}
const prepare = () => prepareRailgunRelayDraft(mockState.args);
const recover = (draft) =>
  reconstructRailgunRelayDraft({ ...mockState.args, draftText: JSON.stringify(draft) });
const refused = { code: 'RAILGUN_RELAY_RECONSTRUCTION_REFUSED' };
beforeEach(() => {
  mockState = fixture();
  jest.clearAllMocks();
});

test('fee-first construction returns only canonical zero-proof draft; reconstruction uses fresh objects', async () => {
  const draft = await prepare();
  expect(draft).toEqual(normalizeRailgunRelayDraftCapsule(draft).data);
  expect(Object.keys(draft).sort()).toEqual([
    'engineSha256',
    'intent',
    'noteHash',
    'pathElements',
    'schema',
    'selection',
    'walletId',
  ]);
  const [[tx]] = abi.decodeFunctionData('transact', draft.intent.transaction.data);
  expect(tx.proof.a.x).toBe(0n);
  expect(tx.commitments).toHaveLength(2);
  const fresh = fixture();
  fresh.Note.createTransfer.mockImplementation(() => {
    throw Error('No construction during reconstruction');
  });
  fresh.generate.mockImplementation(() => {
    throw Error('No generation during reconstruction');
  });
  mockState = fresh;
  const result = await recover(draft);
  expect(result).toEqual({
    draftDigest: normalizeRailgunRelayDraftCapsule(draft).digest,
    expectedHash: draft.intent.expectedHash,
    recoveredOutputs: 2,
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(fresh.Note.createTransfer).not.toHaveBeenCalled();
  expect(fresh.generate).not.toHaveBeenCalled();
  expect(fresh.args.wallet.getSpendingKeyPair).not.toHaveBeenCalled();
  expect(fresh.Note.decrypt).toHaveBeenCalledTimes(2);
  expect(fresh.loans.every((key) => key.every((n) => n === 0))).toBe(true);
});

test('constructor detaches all request data before its first await', async () => {
  const gate = deferred();
  mockState.init = gate.promise;
  const pending = prepare();
  mockState.args.request.selection.position = 99;
  mockState.args.request.context.peer.masterPublicKey = '99';
  mockState.args.request.context.gas.minGasPrice = '99';
  mockState.args.request.context.quote.data = '00';
  gate.resolve();
  const draft = await pending;
  expect(draft.selection.position).toBe(3);
  expect(draft.intent.context.peer.masterPublicKey).toBe('8');
  expect(draft.intent.context.gas.minGasPrice).toBe('1');
});

test.each([
  [
    'extra authority flag',
    (s) => {
      s.args.request.verified = true;
    },
  ],
  [
    'extra selection',
    (s) => {
      s.args.request.selection.kind = 'railgun-private-transfer';
    },
  ],
  [
    'wrong input amount',
    (s) => {
      s.args.request.context.inputAmount = '701';
      s.args.request.context.selfAmount = '601';
    },
  ],
  [
    'fee cap',
    (s) => {
      s.args.request.context.feeCap = '99';
    },
  ],
  [
    'self viewing key',
    (s) => {
      s.args.request.context.self.viewingPublicKey = '05'.repeat(32);
    },
  ],
  [
    'peer master',
    (s) => {
      s.args.request.context.peer.masterPublicKey = '9';
    },
  ],
  [
    'all chains peer',
    (s) => {
      s.decode.mockImplementation(() => ({ ...s.peer, chain: undefined }));
    },
  ],
  [
    'duplicate selected note',
    (s) => {
      s.args.scan.received.push({ ...s.args.scan.received[0] });
    },
  ],
  [
    'spent selected note',
    (s) => {
      s.args.scan.received[0].spentTxid = hex(2);
    },
  ],
  [
    'bad merkle path',
    (s) => {
      s.merkle.mockReturnValue(false);
    },
  ],
  [
    'wrong wallet source',
    (s) => {
      const make = s.Note.createTransfer.getMockImplementation();
      s.Note.createTransfer.mockImplementation((...args) => ({
        ...make(...args),
        walletSource: 'freedom',
      }));
    },
  ],
])('construction refuses %s', async (_name, mutate) => {
  mutate(mockState);
  await expect(prepare()).rejects.toMatchObject({ code: 'RAILGUN_RELAY_DRAFT_REFUSED' });
});

test.each([
  [
    'engine pin',
    (draft) => {
      draft.engineSha256 = 'ff'.repeat(32);
    },
  ],
  [
    'input note hash',
    (draft) => {
      draft.noteHash = hex(1);
    },
  ],
  [
    'merkle path',
    (draft) => {
      draft.pathElements[0] = hex(2);
    },
  ],
  [
    'expected hash',
    (draft) => {
      draft.intent.expectedHash = hex(2);
    },
  ],
  [
    'self key',
    (draft) => {
      draft.intent.context.self.viewingPublicKey = '05'.repeat(32);
    },
  ],
  [
    'peer key',
    (draft) => {
      draft.intent.context.peer.viewingPublicKey = '05'.repeat(32);
    },
  ],
])('fresh reconstruction refuses changed %s', async (_name, mutate) => {
  const draft = clone(await prepare());
  mutate(draft);
  await expect(recover(draft)).rejects.toMatchObject(refused);
});

function changeWire(draft, mutate) {
  const [transactions] = abi.decodeFunctionData('transact', draft.intent.transaction.data);
  const original = transactions[0];
  const tx = {
    proof: {
      a: original.proof.a.toObject(),
      b: { x: [...original.proof.b.x], y: [...original.proof.b.y] },
      c: original.proof.c.toObject(),
    },
    merkleRoot: original.merkleRoot,
    nullifiers: [...original.nullifiers],
    commitments: [...original.commitments],
    boundParams: {
      ...original.boundParams.toObject(),
      commitmentCiphertext: original.boundParams.commitmentCiphertext.map((bundle) => ({
        ...bundle.toObject(),
        ciphertext: [...bundle.ciphertext],
      })),
    },
    unshieldPreimage: {
      ...original.unshieldPreimage.toObject(),
      token: original.unshieldPreimage.token.toObject(),
    },
  };
  mutate(tx);
  draft.intent.transaction.data = abi.encodeFunctionData('transact', [[tx]]);
  draft.intent.expected.boundParamsHash = hex(mockState.boundHash(tx.boundParams));
  draft.intent.expectedHash = hex(
    mockState.poseidon([
      77n,
      BigInt(draft.intent.expected.boundParamsHash),
      88n,
      BigInt(draft.intent.expected.feeCommitment),
      BigInt(draft.intent.expected.selfCommitment),
    ])
  );
}
test.each([
  [
    'ciphertext with untouched constructor objects',
    (tx) => {
      tx.boundParams.commitmentCiphertext[0].ciphertext[1] = hex(99);
    },
  ],
  [
    'fee/self ciphertext order',
    (tx) => {
      tx.boundParams.commitmentCiphertext.reverse();
    },
  ],
  [
    'annotation output type',
    (tx) => {
      tx.boundParams.commitmentCiphertext[0].annotationData = '0x00';
    },
  ],
  [
    'receiver blinded key',
    (tx) => {
      tx.boundParams.commitmentCiphertext[0].blindedReceiverViewingKey = hex(99);
    },
  ],
])('serialized %s fails despite recomputed outer hashes', async (_name, mutate) => {
  const draft = clone(await prepare());
  changeWire(draft, mutate);
  // Establish that rejection is deeper than the public shape/hash policy.
  expect(normalizeRailgunRelayDraftCapsule(draft).data).toEqual(draft);
  await expect(recover(draft)).rejects.toMatchObject(refused);
  expect(mockState.loans.every((key) => key.every((n) => n === 0))).toBe(true);
});

test.each([
  [
    'empty unblind fallback',
    (o) => {
      o.receiverAddressData.viewingPublicKey = new Uint8Array();
    },
  ],
  [
    'wrong recipient viewing key with same master',
    (o) => {
      o.receiverAddressData.viewingPublicKey = bytes(7);
    },
  ],
  [
    'wrong value',
    (o) => {
      o.value++;
    },
  ],
  [
    'wrong token',
    (o) => {
      o.tokenData.tokenAddress = '0x' + '11'.repeat(20);
    },
  ],
  [
    'wrong source',
    (o) => {
      o.walletSource = 'freedom';
    },
  ],
  [
    'nonempty memo',
    (o) => {
      o.memoText = 'message';
    },
  ],
  [
    'changed random',
    (o) => {
      o.random = '05'.repeat(16);
    },
  ],
  [
    'changed sender random',
    (o) => {
      o.senderRandom = '05'.repeat(15);
    },
  ],
  [
    'wrong commitment',
    (o) => {
      o.hash++;
    },
  ],
])('decrypted %s refuses and wipes the admitted symmetric key', async (_name, mutate) => {
  const draft = await prepare();
  const decrypt = mockState.Note.decrypt.getMockImplementation();
  mockState.Note.decrypt.mockImplementation(async (...args) => {
    const value = await decrypt(...args);
    mutate(value);
    return value;
  });
  await expect(recover(draft)).rejects.toMatchObject(refused);
  expect(mockState.loans).toHaveLength(1);
  expect(mockState.loans[0]).toEqual(bytes(0));
});

test('abort while ECDH awaits still wipes its late key and never decrypts', async () => {
  const draft = await prepare(),
    gate = deferred(),
    key = bytes(7);
  mockState.symmetric.mockReturnValue(gate.promise);
  const pending = recover(draft);
  while (!mockState.symmetric.mock.calls.length) await Promise.resolve();
  mockState.controller.abort();
  gate.resolve(key);
  await expect(pending).rejects.toMatchObject(refused);
  expect(key).toEqual(bytes(0));
  expect(mockState.Note.decrypt).not.toHaveBeenCalled();
});

test('abort during original decryption waits for settlement then refuses and wipes', async () => {
  const draft = await prepare(),
    gate = deferred();
  mockState.Note.decrypt.mockReturnValue(gate.promise);
  let settled = false;
  const pending = recover(draft).finally(() => {
    settled = true;
  });
  while (!mockState.Note.decrypt.mock.calls.length) await Promise.resolve();
  mockState.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve(mockState.output(0));
  await expect(pending).rejects.toMatchObject(refused);
  expect(mockState.loans[0]).toEqual(bytes(0));
});

test('noncanonical, oversized and missing serialized input refuses before runtime', async () => {
  const draft = await prepare();
  const verify = require('./railgun-engine-runtime').verifyRailgunEngineRuntime;
  verify.mockClear();
  for (const draftText of [JSON.stringify(draft) + ' ', ' '.repeat(65537), undefined])
    await expect(
      reconstructRailgunRelayDraft({ ...mockState.args, draftText })
    ).rejects.toMatchObject(refused);
  expect(verify).not.toHaveBeenCalled();
});

test('final lifetime check refuses reentrant close during expected-hash computation', async () => {
  const draft = await prepare();
  const calculate = mockState.poseidon.getMockImplementation();
  mockState.poseidon.mockImplementation((...args) => {
    const value = calculate(...args);
    mockState.controller.abort();
    return value;
  });
  await expect(recover(draft)).rejects.toMatchObject(refused);
});
test('construction awaits original generation then refuses its late result on abort', async () => {
  const gate = deferred(),
    original = mockState.generate.getMockImplementation();
  mockState.generate.mockImplementation(async (...args) => {
    await gate.promise;
    return original(...args);
  });
  let settled = false;
  const pending = prepare().finally(() => {
    settled = true;
  });
  while (!mockState.generate.mock.calls.length) await Promise.resolve();
  mockState.controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.resolve();
  await expect(pending).rejects.toMatchObject({ code: 'RAILGUN_RELAY_DRAFT_REFUSED' });
});
test('original decrypt rejection is sanitized after wiping its key', async () => {
  const draft = await prepare();
  mockState.Note.decrypt.mockRejectedValue(Error('controlled private diagnostic'));
  await expect(recover(draft)).rejects.toMatchObject(refused);
  expect(mockState.loans[0]).toEqual(bytes(0));
});

test('serialized fee commitment mismatch reaches C normalizer and refuses before runtime', async () => {
  const draft = clone(await prepare());
  expect(normalizeRailgunRelayDraftCapsule(draft).data).toEqual(draft);
  changeWire(draft, (transaction) => {
    transaction.commitments[0] = hex(99);
  });
  expect(draft.intent.expected.feeCommitment).not.toBe(hex(99));
  const normalize = jest.fn(normalizeRailgunRelayDraftCapsule);
  let reconstruct, verify;
  jest.doMock('./railgun-relay-capsule', () => ({
    normalizeRailgunRelayDraftCapsule: normalize,
  }));
  try {
    // Observe the actual production data validator, without replacing its result.
    jest.isolateModules(() => {
      reconstruct = require('./railgun-relay-reconstruct').reconstructRailgunRelayDraft;
      verify = require('./railgun-engine-runtime').verifyRailgunEngineRuntime;
    });
    verify.mockClear();
    await expect(
      reconstruct({ ...mockState.args, draftText: JSON.stringify(draft) })
    ).rejects.toMatchObject(refused);
    expect(normalize).toHaveBeenCalledTimes(1);
    expect(normalize).toHaveBeenCalledWith(draft);
    expect(normalize.mock.results[0].type).toBe('throw');
    expect(normalize.mock.results[0].value).toMatchObject({
      code: 'RAILGUN_RELAY_DRAFT_CAPSULE_REFUSED',
    });
    expect(verify).not.toHaveBeenCalled();
  } finally {
    jest.dontMock('./railgun-relay-capsule');
  }
});
