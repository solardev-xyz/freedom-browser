/** Controlled engine shim: boundary/equivalence tests, not cryptographic evidence. */
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const {
  createRailgunPartialCapsuleData,
  createRailgunLegacyCapsuleData,
} = require('../../../scripts/fixtures/railgun-partial-capsule-data');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const root = '/railgun-crypto-test/node_modules/@railgun-community/engine/dist/';
const mockRuntime = jest.fn(() => '/railgun-crypto-test');
jest.mock('./railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (...args) => mockRuntime(...args),
}));
let f, args, note, output, annotation, symmetric, witness, hooks, decryptWork, mutateWitness;
const tokenHash = hex(9);
const hash = (npk, token, value) => npk + BigInt(token) + value;
const poseidon = (values) => values.reduce((a, b) => a + b, 0n) % FIELD;
const bind = () => {
  const e = f.capsule.preparation.expected;
  e.boundParamsHash = hex(
    BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [f.inner.boundParams]))) %
      FIELD
  );
  f.inner.commitments =
    f.capsule.version === 2 ? [e.changeCommitment, e.unshieldCommitment] : [e.commitment];
  f.capsule.preparation.transaction.data = f.encode();
  f.capsule.preparation.expectedHash = hex(
    poseidon([
      BigInt(e.merkleRoot),
      BigInt(e.boundParamsHash),
      BigInt(e.nullifier),
      ...f.inner.commitments.map(BigInt),
    ])
  );
};
function setup(kind = 'railgun-partial-unshield') {
  f =
    kind === 'railgun-partial-unshield'
      ? createRailgunPartialCapsuleData()
      : createRailgunLegacyCapsuleData(kind);
  const partial = kind === 'railgun-partial-unshield',
    full = kind === 'railgun-token-unshield';
  const tokenData = { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: '0' };
  note = {
    hash: hash(10n, tokenHash, 1000n),
    value: 1000n,
    tokenHash,
    tokenData,
    random: '01',
    notePublicKey: 10n,
  };
  output = {
    value: partial ? 600n : 1000n,
    tokenHash,
    tokenData: { ...tokenData },
    random: '02',
    notePublicKey: 20n,
    memoText: undefined,
  };
  output.hash = hash(output.notePublicKey, output.tokenHash, output.value);
  const e = f.capsule.preparation.expected;
  const unshieldHash =
    BigInt(f.capsule.selection.recipient.startsWith('0x') ? f.capsule.selection.recipient : '0') +
    (partial ? 400n : 1000n) +
    9n;
  if (partial) {
    e.changeCommitment = hex(output.hash);
    e.unshieldCommitment = hex(unshieldHash);
  } else e.commitment = hex(full ? unshieldHash : output.hash);
  f.capsule.noteHash = hex(note.hash);
  bind();
  annotation = { outputType: 2, senderRandom: '0'.repeat(30) };
  symmetric = Buffer.alloc(32, 8);
  decryptWork = undefined;
  mutateWitness = undefined;
  const controller = new AbortController();
  const descriptor = {
    walletId: f.capsule.walletId,
    instanceId: f.owned.read.instanceId,
    spendingPublicKey: ['01', '02'],
  };
  const proof = {
    leaf: hex(note.hash).slice(2),
    root: hex(1).slice(2),
    elements: f.capsule.pathElements.map((v) => v.slice(2)),
    indices: hex(1).slice(2),
  };
  const wallet = {
    addressKeys: { masterPublicKey: 77n },
    viewingKeyPair: { privateKey: Buffer.alloc(32, 7) },
    getAddress: () => descriptor.instanceId,
    getNullifyingKey: () => 8n,
    getViewingKeyPair: () => wallet.viewingKeyPair,
    getSpendingKeyPair: jest.fn(() => {
      throw Error('Spending key forbidden');
    }),
    TXOs: jest.fn(async () => [{ tree: 0, position: 1, spendtxid: false, note }]),
    tokenDataGetter: {},
  };
  args = {
    archive: '/engine.asar',
    wallet,
    descriptor,
    signal: controller.signal,
    controller,
    selection: f.capsule.selection,
    checkpoint: { state: { trees: [{ tree: 0, length: 2, root: hex(1) }] } },
    tree: { getMerkleProof: jest.fn(async () => proof) },
    scan: {
      instanceId: descriptor.instanceId,
      received: [
        { tree: 0, position: 1, spentTxid: false, hash: hex(note.hash).slice(2), value: '1000' },
      ],
      ownedPoi: [{ id: '0:1', hash: hex(note.hash), nullifier: hex(2) }],
    },
  };
  hooks = {
    create: jest.fn(() => output),
    decrypt: jest.fn(async () => (decryptWork ? await decryptWork : output)),
    getHash: jest.fn(hash),
    getNpk: jest.fn((_mpk, random) => (random === '01' ? 10n : 20n)),
    getNoteHash: jest.fn((recipient, _token, value) => BigInt(recipient) + value + 9n),
    verifyPath: jest.fn(() => true),
    annotate: jest.fn(() => annotation),
    request: jest.fn(),
    dummy: jest.fn(),
  };
  const priv = {
    tokenAddress: 9n,
    randomIn: [1n],
    valueIn: [1000n],
    pathElements: [Array(16).fill(6n)],
    leavesIndices: [1n],
    valueOut: partial ? [600n, 400n] : [1000n],
    publicKey: [1n, 2n],
    npkOut: partial
      ? [20n, BigInt(f.capsule.selection.recipient)]
      : [full ? BigInt(f.capsule.selection.recipient) : 20n],
    nullifyingKey: 8n,
  };
  witness = {
    txidVersion: 'V2_PoseidonMerkle',
    privateInputs: priv,
    publicInputs: {
      merkleRoot: 1n,
      boundParamsHash: BigInt(e.boundParamsHash),
      nullifiers: [2n],
      commitmentsOut: f.inner.commitments.map(BigInt),
    },
    boundParams: f.inner.boundParams,
  };
  class Transaction {
    constructor(_chain, _token, _tree, _inputs, outputs, adapt) {
      this.outputs = outputs;
      expect(adapt).toEqual({ contract: '0x' + '0'.repeat(40), parameters: hex(0) });
    }
    addUnshieldData(data, value) {
      expect(data.allowOverride).toBe(false);
      expect(value).toBe(partial ? 400n : 1000n);
    }
    async generateTransactionRequest(wallet) {
      hooks.request();
      expect(await wallet.getSpendingKeyPair()).toEqual({ pubkey: [1n, 2n] });
      expect(await wallet.getUTXOMerkletree().getMerkleProof(0, 1)).toBe(proof);
      if (mutateWitness) mutateWitness();
      return witness;
    }
    async generateDummyProvedTransaction(prover) {
      hooks.dummy();
      prover.options.assertArtifactExists(1, partial ? 2 : 1);
      return f.inner;
    }
  }
  const modules = {
    'utils/poseidon': { poseidon, initPoseidonPromise: Promise.resolve() },
    'transaction/transaction': { Transaction },
    'note/transact-note': {
      TransactNote: {
        createTransfer: hooks.create,
        decrypt: hooks.decrypt,
        getHash: hooks.getHash,
        getNullifier: () => 2n,
      },
    },
    'prover/prover': {
      Prover: class {
        constructor(options) {
          this.options = options;
        }
        static formatProof(p) {
          return p;
        }
      },
    },
    'utils/keys-utils': { getSharedSymmetricKey: async () => symmetric },
    'merkletree/merkle-proof': { verifyMerkleProof: hooks.verifyPath },
    'note/note-util': { getNoteHash: hooks.getNoteHash },
    'note/shield-note': { ShieldNote: { getNotePublicKey: hooks.getNpk } },
    'models/formatted-types': { OutputType: { Change: 2 } },
    'models/transaction-constants': { MEMO_SENDER_RANDOM_NULL: '0'.repeat(30) },
    'note/memo': { Memo: { decryptNoteAnnotationData: hooks.annotate } },
    'key-derivation/wallet-node': { WalletNode: { getMasterPublicKey: () => 77n } },
    'transaction/bound-params': {
      hashBoundParamsV2: (b) =>
        BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [b]))) % FIELD,
    },
  };
  for (const [name, value] of Object.entries(modules))
    jest.doMock(root + name, () => value, { virtual: true });
}
beforeEach(() => {
  jest.resetModules();
  mockRuntime.mockClear();
  setup();
});
const prepare = () => require('./railgun-private-witness').prepareRailgunPrivateWitness(args);
const reconstruct = () =>
  require('./railgun-private-reconstruct').reconstructRailgunPrivateWitness({
    ...args,
    capsule: f.capsule,
  });
test.each(['railgun-partial-unshield', 'railgun-private-transfer', 'railgun-token-unshield'])(
  'prepares and reconstructs exact %s witness without fresh output generation',
  async (kind) => {
    setup(kind);
    const prepared = await prepare();
    expect(prepared.publicPreparation).toEqual(f.capsule.preparation);
    expect(args.wallet.getSpendingKeyPair).not.toHaveBeenCalled();
    if (kind === 'railgun-partial-unshield')
      expect(hooks.create).toHaveBeenCalledWith(
        args.wallet.addressKeys,
        args.wallet.addressKeys,
        600n,
        note.tokenData,
        true,
        2,
        undefined
      );
    const calls = hooks.create.mock.calls.length;
    hooks.create.mockImplementation(() => {
      throw Error('No fresh randomness');
    });
    const restored = await reconstruct();
    expect(restored.witness.privateInputs).toEqual(prepared.witness.privateInputs);
    expect(restored.witness.publicInputs).toEqual(prepared.witness.publicInputs);
    expect(hooks.create).toHaveBeenCalledTimes(calls);
    expect(hooks.request).toHaveBeenCalledTimes(1);
    expect(hooks.dummy).toHaveBeenCalledTimes(1);
    expect(symmetric.every((v) => v === 0)).toBe(kind !== 'railgun-token-unshield');
    const p = { a: { x: 1, y: 2 }, b: { x: [3, 4], y: [5, 6] }, c: { x: 7, y: 8 } };
    const prove = { proveRailgun: jest.fn(async () => ({ proof: p })) };
    const tx = await restored.transaction.generateProvedTransaction(
      'V2_PoseidonMerkle',
      prove,
      restored.witness,
      () => {}
    );
    expect(tx.commitments).toEqual(f.inner.commitments);
    const [[decoded]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
      'transact',
      f.capsule.preparation.transaction.data
    );
    expect(tx.boundParams).toEqual(decoded.boundParams);
    expect(tx.unshieldPreimage).toEqual(decoded.unshieldPreimage);
    expect(prove.proveRailgun).toHaveBeenCalledTimes(1);
  }
);

test.each(['prepare', 'reconstruct'])(
  '%s rejects an internally coherent foreign NPK/hash/value via explicit self-NPK binding',
  async (route) => {
    output.notePublicKey = 30n;
    output.hash = hash(30n, output.tokenHash, output.value);
    f.capsule.preparation.expected.changeCommitment = hex(output.hash);
    bind();
    witness.publicInputs.commitmentsOut[0] = output.hash;
    witness.privateInputs.npkOut[0] = 30n;
    await expect(route === 'prepare' ? prepare() : reconstruct()).rejects.toThrow();
    expect(hooks.decrypt).toHaveBeenCalledTimes(1);
    expect(hooks.getNpk).toHaveBeenCalledWith(77n, '02');
    expect(symmetric.every((v) => v === 0)).toBe(true);
  }
);
test.each([
  'value',
  'tokenHash',
  'tokenAddress',
  'tokenType',
  'tokenSubID',
  'hash',
  'annotation',
  'senderRandom',
  'memoText',
  'memo',
  'null-output',
])('rejects partial %s after decryption and wipes symmetric key in both routes', async (mode) => {
  const change = () => {
    if (mode === 'value') output.value = 599n;
    if (mode === 'tokenHash') output.tokenHash = hex(8);
    if (mode === 'tokenAddress') output.tokenData.tokenAddress = '0x' + '34'.repeat(20);
    if (mode === 'tokenType') output.tokenData.tokenType = 1;
    if (mode === 'tokenSubID') output.tokenData.tokenSubID = '1';
    if (mode === 'hash') output.hash++;
    if (mode === 'annotation') annotation.outputType = 0;
    if (mode === 'senderRandom') annotation.senderRandom = '1'.repeat(30);
    if (mode === 'memoText') output.memoText = 'unexpected';
    if (mode === 'memo') {
      f.inner.boundParams.commitmentCiphertext[0].memo = '0x00';
      bind();
    }
    if (mode === 'null-output') hooks.decrypt.mockResolvedValue(null);
  };
  for (const route of ['prepare', 'reconstruct']) {
    setup();
    change();
    await expect(route === 'prepare' ? prepare() : reconstruct()).rejects.toThrow();
    expect(symmetric.every((v) => v === 0)).toBe(true);
  }
});
test.each(['prepare', 'reconstruct'])(
  '%s abort after borrowed decryption refuses and wipes before return',
  async (route) => {
    let resolve;
    decryptWork = new Promise((r) => (resolve = r));
    const work = route === 'prepare' ? prepare() : reconstruct();
    for (let i = 0; i < 20 && !hooks.decrypt.mock.calls.length; i++) await Promise.resolve();
    expect(hooks.decrypt).toHaveBeenCalledTimes(1);
    args.controller.abort();
    resolve(output);
    await expect(work).rejects.toThrow();
    expect(symmetric.every((v) => v === 0)).toBe(true);
  }
);
test.each(['unshield', 'values', 'npks', 'outputCount', 'nullifier', 'root'])(
  'preparer refuses mismatched generated %s',
  async (mode) => {
    mutateWitness = () => {
      if (mode === 'unshield') witness.publicInputs.commitmentsOut[1]++;
      if (mode === 'values') witness.privateInputs.valueOut = [599n, 401n];
      if (mode === 'npks') witness.privateInputs.npkOut[0] = 30n;
      if (mode === 'outputCount') witness.publicInputs.commitmentsOut.pop();
      if (mode === 'nullifier') witness.publicInputs.nullifiers[0]++;
      if (mode === 'root') witness.publicInputs.merkleRoot++;
    };
    await expect(prepare()).rejects.toThrow();
  }
);
test.each(['0', '1000', '1001', '0400', '4e2', 400])(
  'preparer refuses invalid partial amount %s before SDK construction',
  async (amount) => {
    args.selection = { ...args.selection, unshieldAmount: amount };
    await expect(prepare()).rejects.toThrow();
    expect(hooks.create).not.toHaveBeenCalled();
    expect(hooks.request).not.toHaveBeenCalled();
  }
);
test('structurally coherent wrong unshield hash refuses before output decryption', async () => {
  f.capsule.preparation.expected.unshieldCommitment = hex(80);
  bind();
  expect(normalizeRailgunPrivateCapsule(f.capsule).version).toBe(2);
  await expect(reconstruct()).rejects.toThrow();
  expect(hooks.decrypt).not.toHaveBeenCalled();
});
test('aborted entry touches neither runtime nor wallet', async () => {
  args.controller.abort();
  await expect(prepare()).rejects.toThrow();
  await expect(reconstruct()).rejects.toThrow();
  expect(mockRuntime).not.toHaveBeenCalled();
  expect(args.wallet.TXOs).not.toHaveBeenCalled();
});

test('partial decrypt calls remain receiver-only with no legacy fallback', async () => {
  await prepare();
  await reconstruct();
  expect(hooks.decrypt).toHaveBeenCalledTimes(2);
  for (const call of hooks.decrypt.mock.calls) expect(call.slice(10, 12)).toEqual([false, false]);
});
test.each(['prepare', 'reconstruct'])(
  '%s decryption rejection wipes borrowed symmetric material',
  async (route) => {
    hooks.decrypt.mockRejectedValue(Error('authentication failed'));
    await expect(route === 'prepare' ? prepare() : reconstruct()).rejects.toThrow(
      'authentication failed'
    );
    expect(symmetric.every((value) => value === 0)).toBe(true);
  }
);
test('reconstructed proof facade refuses altered witness and cancellation before proving', async () => {
  const restored = await reconstruct();
  const prover = { proveRailgun: jest.fn() };
  await expect(
    restored.transaction.generateProvedTransaction(
      'V2_PoseidonMerkle',
      prover,
      {
        ...restored.witness,
        privateInputs: { ...restored.witness.privateInputs, valueOut: [599n, 401n] },
      },
      () => {}
    )
  ).rejects.toThrow();
  args.controller.abort();
  await expect(
    restored.transaction.generateProvedTransaction(
      'V2_PoseidonMerkle',
      prover,
      restored.witness,
      () => {}
    )
  ).rejects.toThrow();
  expect(prover.proveRailgun).not.toHaveBeenCalled();
});
