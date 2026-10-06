/** Full-value transfer to a different account through the real pinned fixture engine.
 * Public test keys only; no stores, network, artifacts, signatures or proofs. The
 * production witness, receiver job, cold reconstruction and POI reconstruction run
 * against actual address decoding, note encryption and key agreement.
 */
const path = require('path');
const { Interface } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
jest.mock('../../src/main/wallet/railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => value,
}));
const ARCHIVE = path.join(__dirname, 'railgun-engine');
const engine = path.join(ARCHIVE, 'node_modules/@railgun-community/engine/dist');
const imp = (name) => require(path.join(engine, name));
const wallet = (name) => require(path.join('../../src/main/wallet', name));
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const ZERO = '0x' + '0'.repeat(40);
const CHAIN = { type: 0, id: pins.chainId };
const POSITION = 7;
const abi = new Interface([TRANSACT_ABI]);
let A, B, C, tokenData, received, tree, controller;
const denied = new Proxy(
  {},
  {
    get() {
      throw Error('No test storage or prover');
    },
  }
);
async function account(n) {
  const { getPublicSpendingKey, getPublicViewingKey } = imp('utils/keys-utils');
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet');
  const viewingKey = Buffer.alloc(32, n + 1);
  const spendingPublicKey = getPublicSpendingKey(Buffer.alloc(32, n));
  const viewOnly = new ViewOnlyWallet(
    'ab'.repeat(32),
    denied,
    { privateKey: viewingKey, pubkey: await getPublicViewingKey(viewingKey) },
    spendingPublicKey,
    undefined,
    denied
  );
  const value = {
    viewingKey,
    keys: viewOnly.addressKeys,
    address: viewOnly.getAddress(),
    nullifyingKey: viewOnly.getNullifyingKey(),
    viewOnly,
  };
  value.descriptor = {
    walletId: ViewOnlyWallet.generateID(viewOnly.generateShareableViewingKey()),
    instanceId: value.address,
    masterPublicKey: hex(value.keys.masterPublicKey).slice(2),
    viewingPublicKey: Buffer.from(value.keys.viewingPublicKey).toString('hex'),
    spendingPublicKey: spendingPublicKey.map((v) => hex(v).slice(2)),
    accountIndex: 0,
  };
  return value;
}
beforeAll(async () => {
  await imp('utils/poseidon').initPoseidonPromise;
  imp('wallet/wallet-info').default.setWalletSource('freedomfixture');
  [A, B, C] = await Promise.all([account(10), account(20), account(30)]);
  const { getTokenDataERC20 } = imp('note/note-util');
  const { TransactNote } = imp('note/transact-note');
  const { poseidon } = imp('utils/poseidon');
  tokenData = getTokenDataERC20(pins.wrappedNative);
  // A's spendable input: an ordinary transfer note from C.
  received = TransactNote.createTransfer(A.keys, C.keys, 1000n, tokenData, false, 0, undefined);
  let root = received.hash;
  for (let i = 0; i < 16; i++) root = poseidon((POSITION >> i) & 1 ? [0n, root] : [root, 0n]);
  tree = {
    leaf: hex(received.hash).slice(2),
    root: hex(root).slice(2),
    indices: hex(POSITION).slice(2),
    elements: Array(16).fill(hex(0).slice(2)),
  };
  expect(imp('merkletree/merkle-proof').verifyMerkleProof(tree)).toBe(true);
});
beforeEach(() => {
  controller = new AbortController();
});
const getter = () => ({ getTokenDataFromHash: async () => tokenData });
function restored() {
  return {
    archive: ARCHIVE,
    descriptor: A.descriptor,
    signal: controller.signal,
    wallet: {
      addressKeys: A.keys,
      viewingKeyPair: A.viewOnly.viewingKeyPair,
      getAddress: () => A.address,
      getNullifyingKey: () => A.nullifyingKey,
      getViewingKeyPair: () => A.viewOnly.viewingKeyPair,
      getSpendingKeyPair: () => {
        throw Error('Spending key forbidden');
      },
      TXOs: async () => [{ tree: 0, position: POSITION, spendtxid: false, note: received }],
      tokenDataGetter: getter(),
    },
    tree: { getMerkleProof: async () => tree },
    checkpoint: { state: { trees: [{ tree: 0, length: 8, root: '0x' + tree.root }] } },
    scan: {
      instanceId: A.address,
      received: [
        {
          tree: 0,
          position: POSITION,
          spentTxid: false,
          hash: tree.leaf,
          value: '1000',
        },
      ],
      ownedPoi: [
        {
          id: '0:' + POSITION,
          hash: hex(received.hash),
          nullifier: hex(
            imp('note/transact-note').TransactNote.getNullifier(A.nullifyingKey, POSITION)
          ),
        },
      ],
    },
  };
}
const selection = (recipient) => ({
  kind: 'railgun-private-transfer',
  tree: 0,
  position: POSITION,
  recipient,
  recipientRelationship: 'foreign',
});
async function prepare(recipient = B.address) {
  const prepared = await wallet('railgun-private-witness').prepareRailgunPrivateWitness({
    ...restored(),
    selection: selection(recipient),
  });
  const capsule = wallet('railgun-private-capsule').normalizeRailgunPrivateCapsule({
    version: 1,
    walletId: A.descriptor.walletId,
    engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
    selection: selection(recipient),
    preparation: prepared.publicPreparation,
    noteHash: hex(received.hash),
    pathElements: prepared.witness.privateInputs.pathElements[0].map(hex),
  });
  return { prepared, capsule };
}
function receive(preparation, recipient = B.address) {
  const calls = { key: 0, results: [] };
  const run = wallet('railgun-private-receive-job').run(
    JSON.stringify({
      archive: ARCHIVE,
      descriptor: A.descriptor,
      transaction: preparation.transaction,
      expected: preparation.expected,
      recipient,
      recipientRelationship: 'foreign',
      amount: '1000',
    }),
    {
      signal: controller.signal,
      guardReport: () => ({ attempts: 0, canaries: 1, hooks: ['test.hook'] }),
      requestKey: async () => {
        calls.key++;
        return Buffer.from(A.viewingKey);
      },
      request: async (wire) => {
        calls.results.push(JSON.parse(wire).value);
        return JSON.stringify({ id: 2, value: null });
      },
    }
  );
  return { run, calls };
}
const bundleOf = (data) => {
  const [[tx]] = abi.decodeFunctionData('transact', data);
  const b = tx.boundParams.commitmentCiphertext[0];
  return {
    ciphertext: [...b.ciphertext],
    blindedSenderViewingKey: b.blindedSenderViewingKey,
    blindedReceiverViewingKey: b.blindedReceiverViewingKey,
    annotationData: b.annotationData,
    memo: b.memo,
  };
};
async function decryptAsReceiver(owner, bundle) {
  const { getSharedSymmetricKey } = imp('utils/keys-utils');
  const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
  const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
  const symmetric = await getSharedSymmetricKey(owner.viewingKey, sender);
  try {
    return await imp('note/transact-note').TransactNote.decrypt(
      'V2_PoseidonMerkle',
      CHAIN,
      owner.keys,
      {
        iv: bundle.ciphertext[0].slice(2, 34),
        tag: bundle.ciphertext[0].slice(34),
        data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
      },
      symmetric,
      bundle.memo,
      bundle.annotationData,
      owner.viewingKey,
      receiver,
      sender,
      false,
      false,
      getter(),
      undefined,
      undefined
    );
  } finally {
    symmetric?.fill(0);
  }
}

test('real decode accepts only canonical all-chain or Sepolia addresses of another account', () => {
  const { decodeRailgunForeignDestination } = wallet('railgun-private-destination');
  const { encodeAddress } = imp('key-derivation/bech32');
  const decoded = decodeRailgunForeignDestination(imp, B.address, A.keys);
  expect(decoded.masterPublicKey).toBe(B.keys.masterPublicKey);
  expect(Buffer.from(decoded.viewingPublicKey)).toEqual(Buffer.from(B.keys.viewingPublicKey));
  const sepolia = encodeAddress({ ...B.keys, chain: CHAIN });
  expect(sepolia).not.toBe(B.address);
  expect(decodeRailgunForeignDestination(imp, sepolia, A.keys).chain).toEqual(CHAIN);
  for (const refused of [
    encodeAddress({ ...B.keys, chain: { type: 0, id: 1 } }),
    encodeAddress({ ...B.keys, chain: { type: 1, id: pins.chainId } }),
    encodeAddress({ ...A.keys, chain: CHAIN }),
    A.address,
    B.address.toUpperCase(),
    B.address.slice(0, -1) + (B.address.endsWith('q') ? 'p' : 'q'),
  ])
    expect(() => decodeRailgunForeignDestination(imp, refused, A.keys)).toThrow();
});
test('production witness, receiver job and cold reconstruction agree on the real foreign output', async () => {
  const { prepared, capsule } = await prepare();
  expect(capsule.selection.recipientRelationship).toBe('foreign');
  const job = receive(prepared.publicPreparation);
  await job.run;
  expect(job.calls.key).toBe(1);
  expect(job.calls.results[0]).toMatchObject({
    verified: true,
    recipient: B.address,
    recipientRelationship: 'foreign',
    amount: '1000',
  });
  const cold = await wallet('railgun-private-reconstruct').reconstructRailgunPrivateWitness({
    ...restored(),
    capsule: JSON.parse(JSON.stringify(capsule)),
  });
  expect(cold.witness.privateInputs).toEqual(prepared.witness.privateInputs);
  expect(cold.witness.publicInputs).toEqual(prepared.witness.publicInputs);
  // The foreign output NPK is B's: poseidon(B.MPK, random) from the real ciphertext.
  const output = await decryptAsReceiver(B, bundleOf(capsule.preparation.transaction.data));
  expect(prepared.witness.privateInputs.npkOut).toEqual([output.notePublicKey]);
  expect(output.notePublicKey).toBe(
    imp('note/shield-note').ShieldNote.getNotePublicKey(B.keys.masterPublicKey, output.random)
  );
});
test("B receives an ordinary hidden-sender Transact note; A's POI blinds that same note", async () => {
  const { capsule } = await prepare();
  const bundle = bundleOf(capsule.preparation.transaction.data);
  const output = await decryptAsReceiver(B, bundle);
  const commitment = BigInt(capsule.preparation.expected.commitment);
  expect(output.value).toBe(1000n);
  expect(output.hash).toBe(commitment);
  expect(output.senderAddressData).toBeUndefined();
  expect(output.memoText).toBeUndefined();
  await expect(decryptAsReceiver(A, bundle)).rejects.toThrow();
  await expect(decryptAsReceiver(C, bundle)).rejects.toThrow();
  // B's own spend of the received note: only B's descriptor/key and public ciphertext.
  const recipient = '0x' + '12'.repeat(20);
  const { getNoteHash } = imp('note/note-util');
  const { TransactNote } = imp('note/transact-note');
  const bound = {
    treeNumber: 0,
    minGasPrice: 0,
    unshield: 1,
    chainID: pins.chainId,
    adaptContract: ZERO,
    adaptParams: hex(0),
    commitmentCiphertext: [],
  };
  const { AbiCoder, keccak256 } = require('ethers');
  const { BOUND_PARAMS } = require('../../src/main/wallet/railgun-private-policy');
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const expected = {
    kind: 'railgun-token-unshield',
    tree: 0,
    merkleRoot: hex(777),
    nullifier: hex(TransactNote.getNullifier(B.nullifyingKey, 9)),
    commitment: hex(getNoteHash(recipient, tokenData, 1000n)),
    boundParamsHash: hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    ),
    recipient,
    amount: '1000',
  };
  const data = abi.encodeFunctionData('transact', [
    [
      {
        proof: { a: { x: 0, y: 0 }, b: { x: [0, 0], y: [0, 0] }, c: { x: 0, y: 0 } },
        merkleRoot: expected.merkleRoot,
        nullifiers: [expected.nullifier],
        commitments: [expected.commitment],
        boundParams: bound,
        unshieldPreimage: {
          npk: hex(BigInt(recipient)),
          token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: 0 },
          value: 1000,
        },
      },
    ],
  ]);
  const capsuleB = {
    version: 1,
    walletId: B.descriptor.walletId,
    engineSha256: 'e'.repeat(64),
    selection: { kind: 'railgun-token-unshield', tree: 0, position: 9, recipient },
    preparation: {
      transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data },
      expected,
      expectedHash: hex(5),
      recipient,
      amount: '1000',
    },
    noteHash: hex(commitment),
    pathElements: Array(16).fill(hex(6)),
  };
  const { reconstructRailgunPoiNotes } = wallet('railgun-poi-reconstruct');
  const asB = await reconstructRailgunPoiNotes({
    archive: ARCHIVE,
    descriptor: B.descriptor,
    viewingKey: Buffer.from(B.viewingKey),
    capsule: capsuleB,
    creator: { type: 'Transact', tree: 0, position: 9, hash: hex(commitment), ciphertext: bundle },
    signal: controller.signal,
  });
  expect(asB.inputNpk).toBe(output.notePublicKey);
  const { BlindedCommitment } = imp('poi/blinded-commitment');
  const position = imp('poi/global-tree-position').getGlobalTreePosition(0, 9);
  expect(BlindedCommitment.getForShieldOrTransact(hex(commitment), asB.inputNpk, position)).toBe(
    BlindedCommitment.getForShieldOrTransact(hex(commitment), output.notePublicKey, position)
  );
});
test('real sent-output check refuses the wrong account, altered ciphertext and unsafe outputs', async () => {
  const { verifyRailgunForeignOutput, decodeRailgunForeignDestination } = wallet(
    'railgun-private-destination'
  );
  const { TransactNote } = imp('note/transact-note');
  const { Transaction } = imp('transaction/transaction');
  const { OutputType } = imp('models/formatted-types');
  const build = async ({ showSender = false, outputType = OutputType.Transfer, memo } = {}) => {
    const output = TransactNote.createTransfer(
      B.keys,
      A.keys,
      1000n,
      tokenData,
      showSender,
      outputType,
      memo
    );
    const transaction = new Transaction(
      CHAIN,
      tokenData,
      0,
      [{ note: received, tree: 0, position: POSITION }],
      [output],
      { contract: ZERO, parameters: hex(0) }
    );
    const viewingKeyPair = A.viewOnly.viewingKeyPair;
    const request = await transaction.generateTransactionRequest(
      {
        getUTXOMerkletree: () => ({
          getRoot: async () => tree.root,
          getMerkleProof: async () => tree,
        }),
        getSpendingKeyPair: async () => ({
          pubkey: A.descriptor.spendingPublicKey.map((v) => BigInt('0x' + v)),
        }),
        getNullifyingKey: () => A.nullifyingKey,
        getViewingKeyPair: () => viewingKeyPair,
        viewingKeyPair,
        addressKeys: A.keys,
      },
      'V2_PoseidonMerkle',
      '',
      { minGasPrice: 0n }
    );
    return { bundle: request.boundParams.commitmentCiphertext[0], commitment: output.hash };
  };
  const verify = (fixture, destination = B.address, changes = {}) =>
    verifyRailgunForeignOutput(imp, {
      bundle: fixture.bundle,
      viewingPrivateKey: A.viewingKey,
      sender: A.keys,
      destination: decodeRailgunForeignDestination(imp, destination, A.keys),
      value: 1000n,
      tokenHash: received.tokenHash,
      commitment: fixture.commitment,
      tokenDataGetter: getter(),
      active: () => {},
      ...changes,
    });
  const honest = await build();
  expect((await verify(honest)).hash).toBe(honest.commitment);
  await expect(verify(honest, C.address)).rejects.toThrow();
  const altered = { ...honest.bundle, ciphertext: [...honest.bundle.ciphertext] };
  const word = altered.ciphertext[2];
  altered.ciphertext[2] = word.slice(0, -1) + (word.endsWith('0') ? '1' : '0');
  await expect(verify({ ...honest, bundle: altered })).rejects.toThrow();
  await expect(verify(honest, B.address, { value: 999n })).rejects.toThrow();
  await expect(verify(await build({ showSender: true }))).rejects.toThrow();
  await expect(verify(await build({ outputType: OutputType.Change }))).rejects.toThrow();
  await expect(verify(await build({ memo: 'hello' }))).rejects.toThrow();
});
test('the real receiver job refuses another account after decoding and own keys before the key', async () => {
  const { prepared } = await prepare();
  const job = receive(prepared.publicPreparation, C.address);
  await expect(job.run).rejects.toThrow();
  expect(job.calls.results).toEqual([]);
  const own = receive(
    prepared.publicPreparation,
    imp('key-derivation/bech32').encodeAddress({ ...A.keys, chain: CHAIN })
  );
  await expect(own.run).rejects.toThrow();
  expect(own.calls.key).toBe(0);
});
