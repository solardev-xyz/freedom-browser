/** The native foreign-recipient fixture job against the pinned fixture engine.
 * Public test mnemonic only; the capsule comes from the production witness, so
 * real address decoding, note encryption and key agreement reach the job.
 */
const path = require('path');
const { Interface } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const { PRIVATE_EVENTS } = require('../../src/main/wallet/railgun-transact-receipt');
jest.mock('../../src/main/wallet/railgun-engine-runtime', () => ({
  verifyRailgunEngineRuntime: (value) => value,
}));
const ARCHIVE = path.join(__dirname, 'railgun-engine');
const engine = path.join(ARCHIVE, 'node_modules/@railgun-community/engine/dist');
const imp = (name) => require(path.join(engine, name));
const wallet = (name) => require(path.join('../../src/main/wallet', name));
const job = require('./railgun-foreign-recipient-job');
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const CHAIN = { type: 0, id: pins.chainId };
const POSITION = 7,
  OUTPUT = 9;
const transactAbi = new Interface([TRANSACT_ABI]),
  eventsAbi = new Interface(PRIVATE_EVENTS);
let A, B, C, tokenData, received, tree, creator, capsule, outputEvent;
const denied = new Proxy(
  {},
  {
    get() {
      throw Error('No test storage or prover');
    },
  }
);
async function account(accountIndex) {
  const { deriveRailgunKey } = require('../../src/main/identity/railgun-key-derivation');
  const { getPublicSpendingKey, getPublicViewingKey } = imp('utils/keys-utils');
  const { ViewOnlyWallet } = imp('wallet/view-only-wallet');
  const seed = require('@scure/bip39').mnemonicToSeedSync(MNEMONIC);
  const spending = deriveRailgunKey(seed, `m/44'/1984'/0'/0'/${accountIndex}'`);
  const viewingKey = deriveRailgunKey(seed, `m/420'/1984'/0'/0'/${accountIndex}'`);
  seed.fill(0);
  const spendingPublicKey = getPublicSpendingKey(spending);
  spending.fill(0);
  const viewOnly = new ViewOnlyWallet(
    'ab'.repeat(32),
    denied,
    { privateKey: viewingKey, pubkey: await getPublicViewingKey(viewingKey) },
    spendingPublicKey,
    undefined,
    denied
  );
  return {
    viewingKey,
    viewOnly,
    keys: viewOnly.addressKeys,
    address: viewOnly.getAddress(),
    nullifyingKey: viewOnly.getNullifyingKey(),
    descriptor: {
      instanceId: viewOnly.getAddress(),
      masterPublicKey: hex(viewOnly.masterPublicKey).slice(2),
      spendingPublicKey: spendingPublicKey.map((v) => hex(v).slice(2)),
      viewingPublicKey: Buffer.from(viewOnly.viewingPublicKey).toString('hex'),
      walletId: ViewOnlyWallet.generateID(viewOnly.generateShareableViewingKey()),
      accountIndex,
    },
  };
}
// The engine's own V2 commitment ciphertext for a note sent by `sender`.
async function encryptFrom(sender, note) {
  const { getNoteBlindingKeys, getSharedSymmetricKey } = imp('utils/keys-utils');
  const { ByteUtils } = imp('utils/bytes');
  const pair = sender.viewOnly.viewingKeyPair;
  const blinded = await getNoteBlindingKeys(
    pair.pubkey,
    note.receiverAddressData.viewingPublicKey,
    note.random,
    note.senderRandom
  );
  const symmetric = await getSharedSymmetricKey(pair.privateKey, blinded.blindedReceiverViewingKey);
  try {
    const { noteCiphertext, noteMemo, annotationData } = note.encryptV2(
      'V2_PoseidonMerkle',
      symmetric,
      sender.keys.masterPublicKey,
      note.senderRandom,
      pair.privateKey
    );
    return {
      ciphertext: [`${noteCiphertext.iv}${noteCiphertext.tag}`, ...noteCiphertext.data].map((v) =>
        ByteUtils.hexlify(v, true)
      ),
      blindedSenderViewingKey: ByteUtils.hexlify(blinded.blindedSenderViewingKey, true),
      blindedReceiverViewingKey: ByteUtils.hexlify(blinded.blindedReceiverViewingKey, true),
      memo: ByteUtils.hexlify(noteMemo, true),
      annotationData: ByteUtils.hexlify(annotationData, true),
    };
  } finally {
    symmetric.fill(0);
  }
}
function transactEvent(data, startPosition = OUTPUT, commitments) {
  const [[tx]] = transactAbi.decodeFunctionData('transact', data);
  const c = tx.boundParams.commitmentCiphertext[0];
  return eventsAbi.encodeEventLog(eventsAbi.getEvent('Transact'), [
    0,
    startPosition,
    commitments ?? [...tx.commitments],
    [
      {
        ciphertext: [...c.ciphertext],
        blindedSenderViewingKey: c.blindedSenderViewingKey,
        blindedReceiverViewingKey: c.blindedReceiverViewingKey,
        annotationData: c.annotationData,
        memo: c.memo,
      },
    ],
  ]);
}
beforeAll(async () => {
  await imp('utils/poseidon').initPoseidonPromise;
  imp('wallet/wallet-info').default.setWalletSource('freedomfixture');
  [A, B, C] = await Promise.all([account(0), account(1), account(2)]);
  const { getTokenDataERC20 } = imp('note/note-util');
  const { TransactNote } = imp('note/transact-note');
  const { poseidon } = imp('utils/poseidon');
  tokenData = getTokenDataERC20(pins.wrappedNative);
  // A's spendable input: an ordinary hidden-sender transfer note from C.
  received = TransactNote.createTransfer(A.keys, C.keys, 1000n, tokenData, false, 0, undefined);
  let root = received.hash;
  for (let i = 0; i < 16; i++) root = poseidon((POSITION >> i) & 1 ? [0n, root] : [root, 0n]);
  tree = {
    leaf: hex(received.hash).slice(2),
    root: hex(root).slice(2),
    indices: hex(POSITION).slice(2),
    elements: Array(16).fill(hex(0).slice(2)),
  };
  creator = {
    type: 'Transact',
    tree: 0,
    position: POSITION,
    hash: hex(received.hash),
    ciphertext: await encryptFrom(C, received),
  };
  const selection = {
    kind: 'railgun-private-transfer',
    tree: 0,
    position: POSITION,
    recipient: B.address,
    recipientRelationship: 'foreign',
  };
  const controller = new AbortController();
  const prepared = await wallet('railgun-private-witness').prepareRailgunPrivateWitness({
    archive: ARCHIVE,
    descriptor: A.descriptor,
    signal: controller.signal,
    selection,
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
      tokenDataGetter: { getTokenDataFromHash: async () => tokenData },
    },
    tree: { getMerkleProof: async () => tree },
    checkpoint: { state: { trees: [{ tree: 0, length: 8, root: '0x' + tree.root }] } },
    scan: {
      instanceId: A.address,
      received: [{ tree: 0, position: POSITION, spentTxid: false, hash: tree.leaf, value: '1000' }],
      ownedPoi: [
        {
          id: '0:' + POSITION,
          hash: hex(received.hash),
          nullifier: hex(TransactNote.getNullifier(A.nullifyingKey, POSITION)),
        },
      ],
    },
  });
  capsule = JSON.parse(
    JSON.stringify(
      wallet('railgun-private-capsule').normalizeRailgunPrivateCapsule({
        version: 1,
        walletId: A.descriptor.walletId,
        engineSha256: require('../../src/main/wallet/railgun-engine-manifest.json').sha256,
        selection,
        preparation: prepared.publicPreparation,
        noteHash: hex(received.hash),
        pathElements: prepared.witness.privateInputs.pathElements[0].map(hex),
      })
    )
  );
  outputEvent = transactEvent(capsule.preparation.transaction.data);
});
async function run(input) {
  const results = [];
  const controller = new AbortController();
  await job.run(JSON.stringify({ archive: ARCHIVE, ...input }), {
    signal: controller.signal,
    guardReport: () => ({ attempts: 0, canaries: 1, hooks: ['test.hook'] }),
    request: async (wire) => {
      const message = JSON.parse(wire);
      expect(Object.keys(message).sort()).toEqual(['id', 'method', 'value']);
      results.push(message.value);
      return JSON.stringify({ id: 1, value: null });
    },
  });
  expect(results).toHaveLength(1);
  return results[0];
}
const receiptInput = (changes = {}) => ({
  mode: 'receipt',
  descriptor: A.descriptor,
  capsule,
  provedData: capsule.preparation.transaction.data,
  creator,
  outputPosition: OUTPUT,
  transactionHash: hex(1050),
  blockNumber: 5944750,
  event: outputEvent,
  ...changes,
});
async function decryptAsReceiver(owner, data) {
  const [[tx]] = transactAbi.decodeFunctionData('transact', data);
  const bundle = tx.boundParams.commitmentCiphertext[0];
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
      { getTokenDataFromHash: async () => tokenData },
      undefined,
      undefined
    );
  } finally {
    symmetric.fill(0);
  }
}

test('addresses mode derives the genuine descriptor shape for accounts 0, 1 and 2', async () => {
  const value = await run({ mode: 'addresses' });
  expect(value.accounts).toEqual([A.descriptor, B.descriptor, C.descriptor]);
  const decoded = imp('key-derivation/bech32').decodeAddress(value.ownChainAddress);
  expect(decoded.chain).toEqual(CHAIN);
  expect(decoded.masterPublicKey).toBe(A.keys.masterPublicKey);
  expect(Buffer.from(decoded.viewingPublicKey)).toEqual(Buffer.from(A.keys.viewingPublicKey));
  expect(value.ownChainAddress).not.toBe(A.address);
  expect(value.guards.attempts).toBe(0);
});
test('receipt mode: B receives the hidden-sender note, A only sent it, C sees nothing', async () => {
  const value = await run(receiptInput());
  const output = await decryptAsReceiver(B, capsule.preparation.transaction.data);
  const { BlindedCommitment } = imp('poi/blinded-commitment');
  const position = imp('poi/global-tree-position').getGlobalTreePosition(0, OUTPUT);
  expect(value).toMatchObject({
    mode: 'receipt',
    accounts: [A.descriptor, B.descriptor, C.descriptor],
    creatorType: 'Transact',
    recipient: {
      classification: 'matched',
      receivedRecords: 1,
      sentRecords: 0,
      senderAddressHidden: true,
      npk: hex(output.notePublicKey),
      blindedCommitment: BlindedCommitment.getForShieldOrTransact(
        capsule.preparation.expected.commitment,
        output.notePublicKey,
        position
      ),
    },
    sender: { classification: 'matched', receivedRecords: 0, sentRecords: 1 },
    unrelated: { classification: 'not-addressed', receivedRecords: 0, sentRecords: 0 },
    poi: {
      npkOutIsRecipientNpk: true,
      outputHashIsReviewedCommitment: true,
      blindedOutputIsRecipientBlindedCommitment: true,
      alteredDestinationRefused: true,
    },
  });
  expect(output.senderAddressData).toBeUndefined();
  expect(output.value).toBe(1000n);
});
test('receipt mode refuses an event, proof data or capsule that does not match', async () => {
  const otherCommitment = transactEvent(capsule.preparation.transaction.data, OUTPUT, [
    hex(BigInt(capsule.preparation.expected.commitment) + 1n),
  ]);
  const redirected = JSON.parse(JSON.stringify(capsule));
  redirected.selection.recipient = C.address;
  redirected.preparation.recipient = C.address;
  for (const changes of [
    { event: otherCommitment },
    { event: transactEvent(capsule.preparation.transaction.data, OUTPUT + 1) },
    { capsule: redirected },
    { descriptor: B.descriptor },
    { creator: { ...creator, position: POSITION + 1 } },
  ])
    await expect(run(receiptInput(changes))).rejects.toThrow();
});
// B's own unshield of the received note: B's nullifier, the full value and a
// public test recipient. Path elements are unused selector data here.
function recipientUnshieldCapsule() {
  const { AbiCoder, keccak256 } = require('ethers');
  const { BOUND_PARAMS } = require('../../src/main/wallet/railgun-private-policy');
  const { TransactNote } = imp('note/transact-note');
  const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
  const recipient = '0x' + '12'.repeat(20);
  const bound = {
    treeNumber: 0,
    minGasPrice: 0,
    unshield: 1,
    chainID: pins.chainId,
    adaptContract: '0x' + '0'.repeat(40),
    adaptParams: hex(0),
    commitmentCiphertext: [],
  };
  const expected = {
    kind: 'railgun-token-unshield',
    tree: 0,
    merkleRoot: hex(777),
    nullifier: hex(TransactNote.getNullifier(B.nullifyingKey, OUTPUT)),
    commitment: hex(imp('note/note-util').getNoteHash(recipient, tokenData, 1000n)),
    boundParamsHash: hex(
      BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD
    ),
    recipient,
    amount: '1000',
  };
  const data = transactAbi.encodeFunctionData('transact', [
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
  return {
    version: 1,
    walletId: B.descriptor.walletId,
    engineSha256: 'e'.repeat(64),
    selection: { kind: 'railgun-token-unshield', tree: 0, position: OUTPUT, recipient },
    preparation: {
      transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data },
      expected,
      expectedHash: hex(5),
      recipient,
      amount: '1000',
    },
    noteHash: capsule.preparation.expected.commitment,
    pathElements: Array(16).fill(hex(0)),
  };
}
test("recipient-spend mode: B alone recovers the input NPK that A's POI used", async () => {
  const fromSender = await run(receiptInput());
  const [[tx]] = transactAbi.decodeFunctionData('transact', capsule.preparation.transaction.data);
  const c = tx.boundParams.commitmentCiphertext[0];
  const recipientCreator = {
    type: 'Transact',
    tree: 0,
    position: OUTPUT,
    hash: capsule.preparation.expected.commitment,
    ciphertext: {
      ciphertext: [...c.ciphertext],
      blindedSenderViewingKey: c.blindedSenderViewingKey,
      blindedReceiverViewingKey: c.blindedReceiverViewingKey,
      annotationData: c.annotationData,
      memo: c.memo,
    },
  };
  const input = {
    mode: 'recipient-spend',
    descriptor: B.descriptor,
    capsule: recipientUnshieldCapsule(),
    creator: recipientCreator,
  };
  const value = await run(input);
  const output = await decryptAsReceiver(B, capsule.preparation.transaction.data);
  expect(value).toMatchObject({
    mode: 'recipient-spend',
    derivedAccountIndexes: [1],
    inputNpk: hex(output.notePublicKey),
    valueIn: '1000',
    creatorType: 'Transact',
    alteredCreatorRefused: true,
  });
  expect(value.inputNpk).toBe(fromSender.poi.npkOut);
  for (const changes of [
    { descriptor: A.descriptor },
    { capsule: { ...input.capsule, walletId: A.descriptor.walletId } },
    { creator: { ...recipientCreator, position: OUTPUT + 1 } },
    { creator: creator },
  ])
    await expect(run({ ...input, ...changes })).rejects.toThrow();
});
