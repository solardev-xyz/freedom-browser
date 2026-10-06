/** Coherent toy engine for full-value transfers to a different controlled account.
 * It models sender/receiver key agreement, blinded keys, sender-only annotation and
 * authenticated ciphertext, so the real witness, receiver job, cold reconstruction
 * and POI reconstruction can be exercised together. It is not cryptographic
 * evidence: native campaigns must still qualify the pinned engine.
 */
const { createHash } = require('crypto');
const { Interface, AbiCoder, keccak256 } = require('ethers');
const { TRANSACT_ABI, BOUND_PARAMS } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const manifest = require('./railgun-engine-manifest.json');
jest.mock('./railgun-engine-runtime', () => ({ verifyRailgunEngineRuntime: (value) => value }));
const ARCHIVE = '/foreign-toy-engine.asar';
const ROOT = ARCHIVE + '/node_modules/@railgun-community/engine/dist/';
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const NULL_RANDOM = '0'.repeat(30);
const ZERO = '0x' + '0'.repeat(40);
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const sha = (...parts) => createHash('sha256').update(parts.join('|')).digest();
const keyHex = (value) => Buffer.from(value).toString('hex');
const abi = new Interface([TRANSACT_ABI]);
const boundHash = (bound) =>
  BigInt(keccak256(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [bound]))) % FIELD;
const poseidon = (values) => values.map(BigInt).reduce((a, b) => a + b, 0n) % FIELD;
const TOKEN_HASH = 'ab'.repeat(32);
const tokenData = () => ({ tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) });
const npk = (mpk, random) => poseidon([mpk, BigInt('0x' + random)]);
const noteHash = (key, hash, value) =>
  poseidon([key, BigInt('0x' + hash.replace(/^0x/, '')), value]);
const nullifier = (key, position) => poseidon([key, BigInt(position), 99n]);
const address = (letter) => '0zk1' + letter.repeat(123);
let toy, A, B, C;

function account(n, letter, mpk) {
  const priv = Buffer.alloc(32, n);
  const value = {
    n,
    priv,
    vpk: sha('pub', keyHex(priv)),
    mpk,
    nk: BigInt(n) * 1000003n,
    address: address(letter),
    walletId: n.toString(16).repeat(64).slice(0, 64),
    shareable: 'shareable-' + n,
    spending: [hex(n * 10 + 1).slice(2), hex(n * 10 + 2).slice(2)],
  };
  value.keys = { masterPublicKey: value.mpk, viewingPublicKey: value.vpk };
  value.descriptor = {
    walletId: value.walletId,
    instanceId: value.address,
    masterPublicKey: value.mpk.toString(16).padStart(64, '0'),
    viewingPublicKey: keyHex(value.vpk),
    spendingPublicKey: value.spending,
    accountIndex: 0,
  };
  return value;
}
function createToy() {
  const t = {
    entries: [],
    accounts: [],
    registry: new Map(),
    borrowed: [],
    counter: 0,
    fault: {},
    calls: { create: [], decrypt: [], shared: [] },
  };
  const pub = (priv) => sha('pub', keyHex(priv));
  const blind = (senderVpk, receiverVpk, random, senderRandom) => ({
    blindedSenderViewingKey: sha('bs', keyHex(senderVpk), random, senderRandom),
    blindedReceiverViewingKey: sha('br', keyHex(receiverVpk), random, senderRandom),
  });
  const makeNote = (fields) => {
    const key = npk(fields.receiverAddressData.masterPublicKey, fields.random);
    return {
      ...fields,
      tokenHash: TOKEN_HASH,
      notePublicKey: key,
      hash: noteHash(key, TOKEN_HASH, fields.value),
    };
  };
  const annotate = (data, priv) => {
    const entry = t.entries.find((e) => e.annotationData === data);
    return entry && entry.senderVpk === keyHex(pub(priv)) ? { ...entry.annotation } : undefined;
  };
  t.encrypt = (note, sender) => {
    if (note.senderRandom === undefined) throw Error('Sender random is not defined');
    const id = ++t.counter;
    const blinded = blind(
      sender.viewingPublicKey,
      note.receiverAddressData.viewingPublicKey,
      note.random,
      note.senderRandom
    );
    const receiver = note.receiverAddressData;
    const entry = {
      ciphertext: ['ivtag', 'c1', 'c2', 'c3'].map((part) => '0x' + keyHex(sha(part, id))),
      annotationData: '0x' + keyHex(sha('annotation', id)),
      memo: note.memoText === undefined ? '0x' : '0x' + Buffer.from(note.memoText).toString('hex'),
      shared: sha('shared', id),
      blinded,
      senderVpk: keyHex(sender.viewingPublicKey),
      receiverVpk: keyHex(receiver.viewingPublicKey),
      encodedMPK:
        note.senderRandom !== NULL_RANDOM
          ? receiver.masterPublicKey
          : receiver.masterPublicKey ^ sender.masterPublicKey,
      random: note.random,
      value: note.value,
      memoText: note.memoText,
      annotation: {
        outputType: note.outputType,
        senderRandom: note.senderRandom,
        walletSource: note.walletSource,
      },
    };
    t.entries.push(entry);
    return {
      ciphertext: [...entry.ciphertext],
      blindedSenderViewingKey: '0x' + keyHex(blinded.blindedSenderViewingKey),
      blindedReceiverViewingKey: '0x' + keyHex(blinded.blindedReceiverViewingKey),
      annotationData: entry.annotationData,
      memo: entry.memo,
    };
  };
  const TransactNote = {
    createTransfer(receiver, sender, value, data, showSender, outputType, memoText) {
      t.calls.create.push([receiver, sender, value, data, showSender, outputType, memoText]);
      const id = ++t.counter;
      return makeNote({
        receiverAddressData: receiver,
        senderAddressData: sender,
        random: keyHex(sha('random', id)).slice(0, 32),
        senderRandom: showSender ? NULL_RANDOM : keyHex(sha('sender', id)).slice(0, 30),
        value,
        tokenData: { ...data },
        outputType,
        walletSource: 'freedomfixture',
        memoText,
        ...t.fault,
      });
    },
    async decrypt(...args) {
      const [version, chain, current, ct, shared, memo, annotationData, priv, bReceiver] = args;
      const [isSentNote, isLegacy, getter] = args.slice(10, 13);
      const call = { current, isSentNote, isLegacy, priv: keyHex(priv) };
      t.calls.decrypt.push(call);
      expect(version).toBe('V2_PoseidonMerkle');
      expect(chain).toEqual({ type: 0, id: pins.chainId });
      const entry = t.entries.find((e) => e.ciphertext[1] === '0x' + ct.data[0]);
      const full = ['0x' + ct.iv + ct.tag, ...ct.data.map((v) => '0x' + v)];
      if (
        !entry ||
        JSON.stringify(full) !== JSON.stringify(entry.ciphertext) ||
        memo !== entry.memo ||
        keyHex(shared) !== keyHex(entry.shared)
      )
        throw Error('Unable to decrypt ciphertext.');
      const token = await getter.getTokenDataFromHash(version, chain, TOKEN_HASH);
      if (isSentNote) {
        const annotation =
          annotationData === entry.annotationData ? annotate(annotationData, priv) : undefined;
        const random = annotation?.senderRandom;
        const unblinded =
          random !== undefined &&
          keyHex(bReceiver) === keyHex(entry.blinded.blindedReceiverViewingKey);
        call.result = makeNote({
          receiverAddressData: {
            masterPublicKey:
              random !== undefined && random !== NULL_RANDOM
                ? entry.encodedMPK
                : entry.encodedMPK ^ current.masterPublicKey,
            viewingPublicKey: unblinded ? Buffer.from(entry.receiverVpk, 'hex') : new Uint8Array(),
          },
          senderAddressData: current,
          random: entry.random,
          value: entry.value,
          tokenData: token,
          outputType: annotation?.outputType,
          walletSource: annotation?.walletSource,
          senderRandom: random,
          memoText: entry.memoText,
        });
        return call.result;
      }
      call.result = makeNote({
        receiverAddressData: current,
        senderAddressData:
          entry.encodedMPK !== current.masterPublicKey
            ? { masterPublicKey: entry.encodedMPK ^ current.masterPublicKey }
            : undefined,
        random: entry.random,
        value: entry.value,
        tokenData: token,
        outputType: undefined,
        walletSource: undefined,
        senderRandom: undefined,
        memoText: entry.memoText,
      });
      return call.result;
    },
    getHash: noteHash,
    getNullifier: nullifier,
  };
  class Transaction {
    constructor(chain, token, tree, utxos, outputs, adapt) {
      Object.assign(this, { tree, utxos, outputs, adapt });
    }
    addUnshieldData() {
      throw Error('Transfer fixture only');
    }
    async generateTransactionRequest(wallet, version, _key, globalBoundParams) {
      const [utxo] = this.utxos;
      const proof = await wallet.getUTXOMerkletree().getMerkleProof(this.tree, utxo.position);
      const spending = await wallet.getSpendingKeyPair();
      const viewing = wallet.getViewingKeyPair();
      const nk = wallet.getNullifyingKey();
      const boundParams = {
        treeNumber: this.tree,
        minGasPrice: globalBoundParams.minGasPrice,
        unshield: 0,
        chainID: pins.chainId,
        adaptContract: this.adapt.contract,
        adaptParams: this.adapt.parameters,
        commitmentCiphertext: this.outputs.map((note) =>
          t.encrypt(note, {
            masterPublicKey: wallet.addressKeys.masterPublicKey,
            viewingPublicKey: viewing.pubkey,
          })
        ),
      };
      return {
        txidVersion: version,
        privateInputs: {
          tokenAddress: BigInt('0x' + utxo.note.tokenHash),
          randomIn: [BigInt('0x' + utxo.note.random)],
          valueIn: [utxo.note.value],
          pathElements: [proof.elements.map((v) => BigInt('0x' + v))],
          leavesIndices: [BigInt(utxo.position)],
          valueOut: this.outputs.map((note) => note.value),
          publicKey: spending.pubkey,
          npkOut: this.outputs.map((note) => note.notePublicKey),
          nullifyingKey: nk,
        },
        publicInputs: {
          merkleRoot: BigInt('0x' + proof.root),
          boundParamsHash: boundHash(boundParams),
          nullifiers: [nullifier(nk, utxo.position)],
          commitmentsOut: this.outputs.map((note) => note.hash),
        },
        boundParams,
      };
    }
    async generateDummyProvedTransaction(prover, witness) {
      prover.options.assertArtifactExists(1, witness.publicInputs.commitmentsOut.length);
      return {
        proof: { a: { x: 0n, y: 0n }, b: { x: [0n, 0n], y: [0n, 0n] }, c: { x: 0n, y: 0n } },
        merkleRoot: hex(witness.publicInputs.merkleRoot),
        nullifiers: witness.publicInputs.nullifiers.map(hex),
        commitments: witness.publicInputs.commitmentsOut.map(hex),
        boundParams: witness.boundParams,
        unshieldPreimage: {
          npk: hex(0),
          token: { tokenType: 0, tokenAddress: ZERO, tokenSubID: 0n },
          value: 0n,
        },
      };
    }
  }
  const byPub = (value) => t.accounts.find((a) => keyHex(a.vpk) === keyHex(value));
  t.modules = {
    'utils/poseidon': { poseidon, initPoseidonPromise: Promise.resolve() },
    'key-derivation/bech32': {
      decodeAddress(value) {
        const entry = t.registry.get(value);
        if (!entry) throw Error('Failed to decode bech32 address');
        return {
          masterPublicKey: entry.mpk,
          viewingPublicKey: Uint8Array.from(entry.vpk),
          version: entry.version,
          chain: entry.chain === undefined ? undefined : { ...entry.chain },
        };
      },
      encodeAddress(data) {
        for (const [value, entry] of t.registry)
          if (
            entry.canonical &&
            entry.mpk === data.masterPublicKey &&
            keyHex(entry.vpk) === keyHex(data.viewingPublicKey) &&
            JSON.stringify(entry.chain) === JSON.stringify(data.chain)
          )
            return value;
        throw Error('No canonical encoding');
      },
    },
    'key-derivation/wallet-node': {
      WalletNode: { getMasterPublicKey: (_key, nk) => t.accounts.find((a) => a.nk === nk).mpk },
    },
    'note/transact-note': { TransactNote },
    'note/shield-note': { ShieldNote: { getNotePublicKey: npk } },
    'note/erc20/shield-note-erc20': {
      ShieldNoteERC20: class {
        constructor() {
          throw Error('Transact creator fixture only');
        }
      },
    },
    'note/note-util': {
      getTokenDataERC20: (token) => ({ tokenType: 0, tokenAddress: token, tokenSubID: hex(0) }),
      getTokenDataHash: () => TOKEN_HASH,
      getNoteHash: (recipient, _data, value) => poseidon([BigInt(recipient), value]),
    },
    'note/memo': { Memo: { decryptNoteAnnotationData: annotate } },
    'utils/keys-utils': {
      getPublicViewingKey: async (priv) => pub(priv),
      getNoteBlindingKeys: blind,
      async getSharedSymmetricKey(priv, blinded) {
        const p = keyHex(pub(priv)),
          b = keyHex(blinded);
        t.calls.shared.push({ priv: keyHex(priv), blinded: b });
        const entry = t.entries.find(
          (e) =>
            (e.senderVpk === p && keyHex(e.blinded.blindedReceiverViewingKey) === b) ||
            (e.receiverVpk === p && keyHex(e.blinded.blindedSenderViewingKey) === b)
        );
        const value = Buffer.from(entry ? entry.shared : sha('wrong', p, b));
        t.borrowed.push(value);
        return value;
      },
    },
    'models/formatted-types': { OutputType: { Transfer: 0, BroadcasterFee: 1, Change: 2 } },
    'models/transaction-constants': { MEMO_SENDER_RANDOM_NULL: NULL_RANDOM },
    'wallet/view-only-wallet': {
      ViewOnlyWallet: class {
        constructor(_id, _db, viewing) {
          const a = byPub(viewing.pubkey);
          return {
            getAddress: () => a.address,
            masterPublicKey: a.mpk,
            addressKeys: a.keys,
            generateShareableViewingKey: () => a.shareable,
            getNullifyingKey: () => a.nk,
          };
        }
        static generateID(shareable) {
          return t.accounts.find((a) => a.shareable === shareable)?.walletId;
        }
      },
    },
    'merkletree/merkle-proof': { verifyMerkleProof: () => true },
    'prover/prover': {
      Prover: class {
        constructor(options) {
          this.options = options;
        }
        static formatProof(proof) {
          return proof;
        }
      },
    },
    'transaction/transaction': { Transaction },
    'transaction/bound-params': { hashBoundParamsV2: boundHash },
  };
  return t;
}
function register(value, owner, { chain, version = 1, canonical = true, keys } = {}) {
  toy.registry.set(value, {
    mpk: keys?.masterPublicKey ?? owner.mpk,
    vpk: keys?.viewingPublicKey ?? owner.vpk,
    chain,
    version,
    canonical,
  });
}
const ROOT_HEX = hex(1234567);
let input, restoredA, controller;
beforeEach(() => {
  jest.resetModules();
  toy = createToy();
  for (const [name, value] of Object.entries(toy.modules))
    jest.doMock(ROOT + name, () => value, { virtual: true });
  A = account(1, 'q', 10n ** 30n);
  B = account(2, 'p', 2n * 10n ** 31n);
  C = account(3, 'r', 3n * 10n ** 32n);
  toy.accounts.push(A, B, C);
  for (const owner of [A, B, C]) register(owner.address, owner);
  // A's input: an ordinary Transact note received from C.
  const received = toy.modules['note/transact-note'].TransactNote.createTransfer(
    A.keys,
    C.keys,
    1000n,
    tokenData(),
    false,
    0,
    undefined
  );
  const inputBundle = toy.encrypt(received, C.keys);
  toy.calls.create.length = 0;
  input = {
    note: { ...received, receiverAddressData: A.keys },
    bundle: inputBundle,
    position: 1,
  };
  controller = new AbortController();
  restoredA = restored(A);
});
function restored(owner) {
  const wallet = {
    addressKeys: owner.keys,
    viewingKeyPair: { privateKey: owner.priv, pubkey: owner.vpk },
    getAddress: () => owner.address,
    getNullifyingKey: () => owner.nk,
    getViewingKeyPair: () => wallet.viewingKeyPair,
    getSpendingKeyPair: jest.fn(() => {
      throw Error('Spending key forbidden');
    }),
    TXOs: jest.fn(async () => [
      { tree: 0, position: input.position, spendtxid: false, note: input.note },
    ]),
    tokenDataGetter: {
      getTokenDataFromHash: async (_v, _c, value) => {
        expect(value).toBe(TOKEN_HASH);
        return tokenData();
      },
    },
  };
  const proof = {
    leaf: hex(input.note.hash).slice(2),
    root: ROOT_HEX.slice(2),
    elements: Array(16).fill(hex(6).slice(2)),
    indices: hex(input.position).slice(2),
  };
  return {
    archive: ARCHIVE,
    wallet,
    descriptor: owner.descriptor,
    signal: controller.signal,
    checkpoint: { state: { trees: [{ tree: 0, length: 2, root: ROOT_HEX }] } },
    tree: { getMerkleProof: jest.fn(async () => proof) },
    scan: {
      instanceId: owner.address,
      received: [
        {
          tree: 0,
          position: input.position,
          spentTxid: false,
          hash: hex(input.note.hash).slice(2),
          value: '1000',
        },
      ],
      ownedPoi: [
        {
          id: '0:' + input.position,
          hash: hex(input.note.hash),
          nullifier: hex(nullifier(owner.nk, input.position)),
        },
      ],
    },
  };
}
const selection = (recipient = B.address) => ({
  kind: 'railgun-private-transfer',
  tree: 0,
  position: input.position,
  recipient,
  recipientRelationship: 'foreign',
});
const prepare = (value = selection()) =>
  require('./railgun-private-witness').prepareRailgunPrivateWitness({
    ...restoredA,
    selection: value,
  });
function capsuleFor(prepared, value = selection()) {
  return require('./railgun-private-capsule').normalizeRailgunPrivateCapsule({
    version: 1,
    walletId: A.walletId,
    engineSha256: manifest.sha256,
    selection: value,
    preparation: prepared.publicPreparation,
    noteHash: hex(input.note.hash),
    pathElements: prepared.witness.privateInputs.pathElements[0].map(hex),
  });
}
const reconstruct = (capsule) =>
  require('./railgun-private-reconstruct').reconstructRailgunPrivateWitness({
    ...restoredA,
    capsule,
  });
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
// Honest or deliberately faulty foreign intent built without the witness self-check,
// as a corrupted engine or altered record would present it to later checks.
async function craft(fault = {}) {
  toy.fault = fault.note || {};
  const { TransactNote } = toy.modules['note/transact-note'];
  const output = TransactNote.createTransfer(
    fault.receiver || B.keys,
    A.keys,
    1000n,
    tokenData(),
    !!fault.showSender,
    fault.outputType ?? 0,
    fault.memo
  );
  toy.fault = {};
  const { Transaction } = toy.modules['transaction/transaction'];
  const tx = new Transaction({}, tokenData(), 0, [], [output], {
    contract: ZERO,
    parameters: hex(0),
  });
  tx.utxos = [{ position: input.position, note: input.note }];
  const generated = await tx.generateTransactionRequest(
    {
      getUTXOMerkletree: () => restoredA.tree,
      getSpendingKeyPair: async () => ({ pubkey: A.spending.map((v) => BigInt('0x' + v)) }),
      getViewingKeyPair: () => ({ privateKey: A.priv, pubkey: A.vpk }),
      getNullifyingKey: () => A.nk,
      addressKeys: A.keys,
    },
    'V2_PoseidonMerkle',
    '',
    { minGasPrice: 0n }
  );
  const dummy = await tx.generateDummyProvedTransaction(
    { options: { assertArtifactExists: () => {} } },
    generated
  );
  const pub = generated.publicInputs;
  const expected = {
    kind: 'railgun-private-transfer',
    tree: 0,
    merkleRoot: hex(pub.merkleRoot),
    nullifier: hex(pub.nullifiers[0]),
    commitment: hex(pub.commitmentsOut[0]),
    boundParamsHash: hex(pub.boundParamsHash),
  };
  const transaction = {
    chainId: pins.chainId,
    to: pins.proxy,
    value: '0',
    data: abi.encodeFunctionData('transact', [[dummy]]),
  };
  return {
    output,
    generated,
    publicPreparation: {
      transaction,
      expected,
      expectedHash: hex(
        poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut])
      ),
      recipient: fault.recipient || B.address,
      amount: '1000',
    },
  };
}
function receiverJob(intent, recipient = B.address) {
  const calls = { key: 0, result: [] };
  const key = Buffer.from(A.priv);
  const run = require('./railgun-private-receive-job').run(
    JSON.stringify({
      archive: ARCHIVE,
      descriptor: A.descriptor,
      transaction: intent.transaction,
      expected: intent.expected,
      recipient,
      recipientRelationship: 'foreign',
      amount: '1000',
    }),
    {
      signal: controller.signal,
      guardReport: () => ({ attempts: 0, canaries: 1, hooks: ['test.hook'] }),
      requestKey: async () => {
        calls.key++;
        return key;
      },
      request: async (wire) => {
        calls.result.push(JSON.parse(wire));
        return JSON.stringify({ id: 2, value: null });
      },
    }
  );
  return { run, calls, key };
}
function poiInput(owner, capsule, creator) {
  return {
    archive: ARCHIVE,
    descriptor: owner.descriptor,
    viewingKey: Buffer.from(owner.priv),
    capsule,
    creator,
    signal: controller.signal,
  };
}
const inputCreator = () => ({
  type: 'Transact',
  tree: 0,
  position: input.position,
  hash: hex(input.note.hash),
  ciphertext: input.bundle,
});
const wiped = (borrowed = true) => {
  if (borrowed) expect(toy.borrowed.length).toBeGreaterThan(0);
  for (const value of toy.borrowed) expect(value.equals(Buffer.alloc(32))).toBe(true);
};

describe('honest A to B full-value transfer', () => {
  test('witness creates one hidden-sender Transfer output for the decoded destination', async () => {
    const prepared = await prepare();
    expect(toy.calls.create).toHaveLength(1);
    const [receiver, sender, value, data, showSender, outputType, memo] = toy.calls.create[0];
    expect(receiver.masterPublicKey).toBe(B.mpk);
    expect(keyHex(receiver.viewingPublicKey)).toBe(keyHex(B.vpk));
    expect(sender).toBe(restoredA.wallet.addressKeys);
    expect([value, data, showSender, outputType, memo]).toEqual([
      1000n,
      input.note.tokenData,
      false,
      0,
      undefined,
    ]);
    expect(prepared.publicPreparation.recipient).toBe(B.address);
    expect(Object.keys(prepared.publicPreparation.expected).sort()).toEqual(
      ['boundParamsHash', 'commitment', 'kind', 'merkleRoot', 'nullifier', 'tree'].sort()
    );
    expect(prepared.publicPreparation.expected.kind).toBe('railgun-private-transfer');
    expect(prepared.witness.privateInputs.npkOut).toEqual([npk(B.mpk, toy.entries[1].random)]);
    // The pre-sign self-check recovered the output as the SENDER with A's key.
    const sent = toy.calls.decrypt.filter((call) => call.isSentNote);
    expect(sent).toHaveLength(1);
    expect(sent[0].priv).toBe(keyHex(A.priv));
    expect(restoredA.wallet.getSpendingKeyPair).not.toHaveBeenCalled();
    wiped();
    const capsule = capsuleFor(prepared);
    expect(capsule.version).toBe(1);
    expect(capsule.selection).toEqual(selection());
  });
  test('receiver job verifies the sent note and reports the explicit foreign marker', async () => {
    const prepared = await prepare();
    const job = receiverJob(prepared.publicPreparation);
    await job.run;
    expect(job.calls.key).toBe(1);
    expect(job.calls.result).toHaveLength(1);
    const { value } = job.calls.result[0];
    expect(value).toMatchObject({
      verified: true,
      recipient: B.address,
      recipientRelationship: 'foreign',
      amount: '1000',
    });
    expect(Object.keys(value).sort()).toEqual(
      [
        'verified',
        'transactionDigest',
        'recipient',
        'recipientRelationship',
        'amount',
        'inventory',
        'guards',
      ].sort()
    );
    expect(toy.calls.decrypt.at(-1)).toMatchObject({ isSentNote: true, isLegacy: false });
    expect(job.key.equals(Buffer.alloc(32))).toBe(true);
    wiped();
  });
  test('cold recovery reconstructs the signed foreign record without fresh output work', async () => {
    const prepared = await prepare();
    const capsule = JSON.parse(JSON.stringify(capsuleFor(prepared)));
    const created = toy.calls.create.length,
      entries = toy.entries.length;
    const restoredWitness = await reconstruct(capsule);
    expect(restoredWitness.witness.privateInputs).toEqual(prepared.witness.privateInputs);
    expect(restoredWitness.witness.publicInputs).toEqual(prepared.witness.publicInputs);
    expect(
      AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [restoredWitness.witness.boundParams])
    ).toBe(AbiCoder.defaultAbiCoder().encode([BOUND_PARAMS], [prepared.witness.boundParams]));
    expect(toy.calls.create).toHaveLength(created);
    expect(toy.entries).toHaveLength(entries);
    const prover = { proveRailgun: jest.fn(async () => ({ proof: { a: 1 } })) };
    const proved = await restoredWitness.transaction.generateProvedTransaction(
      'V2_PoseidonMerkle',
      prover,
      restoredWitness.witness,
      () => {}
    );
    expect(proved.commitments).toEqual([capsule.preparation.expected.commitment]);
    wiped();
  });
  test("A's POI output is B's actual output and B receives an ordinary Transact note", async () => {
    const prepared = await prepare();
    const capsule = capsuleFor(prepared);
    const { reconstructRailgunPoiNotes } = require('./railgun-poi-reconstruct');
    const spent = await reconstructRailgunPoiNotes(poiInput(A, capsule, inputCreator()));
    const outputNpk = npk(B.mpk, toy.entries[1].random);
    expect(spent.npksOut).toEqual([outputNpk]);
    expect(spent.valuesOut).toEqual([1000n]);
    // B: separate identity and keys; only public calldata ciphertext and B's own
    // token-unshield intent. Nothing from A's state or keys is supplied.
    const commitment = capsule.preparation.expected.commitment;
    const bundle = bundleOf(capsule.preparation.transaction.data);
    const recipient = '0x' + '12'.repeat(20);
    const bound = {
      treeNumber: 0,
      minGasPrice: 0,
      unshield: 1,
      chainID: pins.chainId,
      adaptContract: ZERO,
      adaptParams: hex(0),
      commitmentCiphertext: [],
    };
    const unshieldCommitment = poseidon([BigInt(recipient), 1000n]);
    const expected = {
      kind: 'railgun-token-unshield',
      tree: 0,
      merkleRoot: hex(777),
      nullifier: hex(nullifier(B.nk, 2)),
      commitment: hex(unshieldCommitment),
      boundParamsHash: hex(boundHash(bound)),
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
      walletId: B.walletId,
      engineSha256: manifest.sha256,
      selection: { kind: 'railgun-token-unshield', tree: 0, position: 2, recipient },
      preparation: {
        transaction: { chainId: pins.chainId, to: pins.proxy, value: '0', data },
        expected,
        expectedHash: hex(5),
        recipient,
        amount: '1000',
      },
      noteHash: commitment,
      pathElements: Array(16).fill(hex(6)),
    };
    const creator = {
      type: 'Transact',
      tree: 0,
      position: 2,
      hash: commitment,
      ciphertext: bundle,
    };
    const before = toy.calls.decrypt.length,
      shared = toy.calls.shared.length;
    const received = await reconstructRailgunPoiNotes(poiInput(B, capsuleB, creator));
    expect(received.inputNpk).toBe(outputNpk);
    expect(received.valuesIn).toEqual([1000n]);
    const calls = toy.calls.decrypt.slice(before);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ isSentNote: false, priv: keyHex(B.priv) });
    expect(calls[0].current).toBe(B.keys);
    // Normal received note: B's keys, no sender address, no type/memo annotation.
    expect(calls[0].result).toMatchObject({
      senderAddressData: undefined,
      outputType: undefined,
      memoText: undefined,
      value: 1000n,
    });
    expect(toy.calls.shared.slice(shared).every((call) => call.priv === keyHex(B.priv))).toBe(true);
    // A cannot treat B's output as an A-received input.
    const stolen = {
      ...capsuleB,
      walletId: A.walletId,
      preparation: {
        ...capsuleB.preparation,
        expected: { ...expected, nullifier: hex(nullifier(A.nk, 2)) },
      },
    };
    await expect(reconstructRailgunPoiNotes(poiInput(A, stolen, creator))).rejects.toThrow();
    wiped();
  });
});

describe('destination refusals', () => {
  const variants = {
    'wrong chain': () => register(address('w'), B, { chain: { type: 0, id: 1 } }),
    'wrong chain type': () => register(address('w'), B, { chain: { type: 1, id: pins.chainId } }),
    'wrong version': () => register(address('w'), B, { version: 2 }),
    'non-canonical encoding': () => register(address('w'), B, { canonical: false }),
    'self keys presented as foreign': () =>
      register(address('w'), A, { chain: { type: 0, id: pins.chainId } }),
    'own master key': () =>
      register(address('w'), B, { keys: { masterPublicKey: A.mpk, viewingPublicKey: B.vpk } }),
    'own viewing key': () =>
      register(address('w'), B, { keys: { masterPublicKey: B.mpk, viewingPublicKey: A.vpk } }),
    undecodable: () => {},
  };
  test.each(Object.keys(variants))(
    '%s refuses before output creation or key release',
    async (name) => {
      variants[name]();
      await expect(prepare(selection(address('w')))).rejects.toThrow();
      expect(toy.calls.create).toEqual([]);
      expect(toy.calls.decrypt).toEqual([]);
      const intent = await craft();
      const job = receiverJob(intent.publicPreparation, address('w'));
      await expect(job.run).rejects.toThrow();
      expect(job.calls.key).toBe(0);
      expect(job.calls.result).toEqual([]);
    }
  );
  test('accepts the exact Sepolia-chain canonical encoding of a different account', async () => {
    register(address('z'), B, { chain: { type: 0, id: pins.chainId } });
    const prepared = await prepare(selection(address('z')));
    expect(prepared.publicPreparation.recipient).toBe(address('z'));
    await receiverJob(prepared.publicPreparation, address('z')).run;
  });
  test.each([
    ['uppercase', '0ZK1' + 'P'.repeat(123)],
    ['short', '0zk1' + 'p'.repeat(122)],
    ['bad charset', '0zk1' + 'b'.repeat(123)],
    ['self instance', 'self-instance'],
  ])('malformed %s destination refuses before output creation', async (_name, value) => {
    toy.registry.set(value, { mpk: B.mpk, vpk: B.vpk, version: 1, canonical: true });
    await expect(prepare(selection(value))).rejects.toThrow();
    expect(toy.calls.create).toEqual([]);
  });
  test('the own instance address with a foreign marker is refused', async () => {
    await expect(prepare(selection(A.address))).rejects.toThrow();
    expect(toy.calls.create).toEqual([]);
  });
});

describe('sent-output verification refusals', () => {
  const faults = {
    'memo present': { memo: 'hello' },
    'sender revealed': { showSender: true },
    'change output type': { outputType: 2 },
    'broadcaster fee output type': { outputType: 1 },
    'other wallet source': { note: { walletSource: 'other' } },
  };
  test.each(Object.keys(faults))(
    '%s refuses in receiver job, cold recovery and POI',
    async (name) => {
      const intent = await craft(faults[name]);
      const job = receiverJob(intent.publicPreparation);
      await expect(job.run).rejects.toThrow();
      expect(job.calls.result).toEqual([]);
      expect(job.key.equals(Buffer.alloc(32))).toBe(true);
      const capsule = require('./railgun-private-capsule').normalizeRailgunPrivateCapsule({
        version: 1,
        walletId: A.walletId,
        engineSha256: manifest.sha256,
        selection: selection(),
        preparation: intent.publicPreparation,
        noteHash: hex(input.note.hash),
        pathElements: Array(16).fill(hex(6)),
      });
      await expect(reconstruct(capsule)).rejects.toThrow();
      const { reconstructRailgunPoiNotes } = require('./railgun-poi-reconstruct');
      await expect(
        reconstructRailgunPoiNotes(poiInput(A, capsule, inputCreator()))
      ).rejects.toThrow();
      wiped();
    }
  );
  test.each(['memo', 'showSender', 'outputType'])(
    'witness self-check refuses an engine output with %s fault before any intent',
    async (fault) => {
      toy.fault =
        fault === 'memo'
          ? { memoText: 'x' }
          : fault === 'showSender'
            ? { senderRandom: NULL_RANDOM }
            : { outputType: 2 };
      await expect(prepare()).rejects.toThrow();
      wiped(false);
    }
  );
  test.each([
    ['wrong master key', () => ({ masterPublicKey: C.mpk, viewingPublicKey: B.vpk })],
    ['wrong viewing key', () => ({ masterPublicKey: B.mpk, viewingPublicKey: C.vpk })],
    ['different account', () => C.keys],
  ])('%s: altered destination after review cannot be signed or recovered', async (_n, keys) => {
    const prepared = await prepare();
    register(address('y'), C, { keys: keys() });
    // Pre-sign receiver check with the altered destination.
    const job = receiverJob(prepared.publicPreparation, address('y'));
    await expect(job.run).rejects.toThrow();
    expect(job.calls.result).toEqual([]);
    // A record altered in one place is structurally refused; one altered
    // consistently is refused by the sent-output keys of the original ciphertext.
    const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
    const record = JSON.parse(JSON.stringify(capsuleFor(prepared)));
    record.selection.recipient = address('y');
    expect(() => normalizeRailgunPrivateCapsule(record)).toThrow();
    record.preparation.recipient = address('y');
    expect(normalizeRailgunPrivateCapsule(record).selection.recipient).toBe(address('y'));
    await expect(reconstruct(record)).rejects.toThrow();
    const { reconstructRailgunPoiNotes } = require('./railgun-poi-reconstruct');
    await expect(reconstructRailgunPoiNotes(poiInput(A, record, inputCreator()))).rejects.toThrow();
    wiped();
  });
  test('altered output ciphertext with rebound public hashes refuses everywhere', async () => {
    const intent = await craft();
    const [[tx]] = abi.decodeFunctionData('transact', intent.publicPreparation.transaction.data);
    const bound = {
      treeNumber: tx.boundParams.treeNumber,
      minGasPrice: tx.boundParams.minGasPrice,
      unshield: tx.boundParams.unshield,
      chainID: tx.boundParams.chainID,
      adaptContract: tx.boundParams.adaptContract,
      adaptParams: tx.boundParams.adaptParams,
      commitmentCiphertext: [bundleOf(intent.publicPreparation.transaction.data)],
    };
    const word = bound.commitmentCiphertext[0].ciphertext[2];
    bound.commitmentCiphertext[0].ciphertext[2] =
      word.slice(0, -1) + (word.endsWith('0') ? '1' : '0');
    const expected = {
      ...intent.publicPreparation.expected,
      boundParamsHash: hex(boundHash(bound)),
    };
    const data = abi.encodeFunctionData('transact', [
      [
        {
          proof: tx.proof,
          merkleRoot: tx.merkleRoot,
          nullifiers: [...tx.nullifiers],
          commitments: [...tx.commitments],
          boundParams: bound,
          unshieldPreimage: tx.unshieldPreimage,
        },
      ],
    ]);
    const publicPreparation = {
      ...intent.publicPreparation,
      transaction: { ...intent.publicPreparation.transaction, data },
      expected,
      expectedHash: hex(
        poseidon([
          BigInt(expected.merkleRoot),
          BigInt(expected.boundParamsHash),
          BigInt(expected.nullifier),
          BigInt(expected.commitment),
        ])
      ),
    };
    require('./railgun-private-intent').validateRailgunPrivateSigningIntent(
      publicPreparation.transaction,
      publicPreparation.expected
    );
    const job = receiverJob(publicPreparation);
    await expect(job.run).rejects.toThrow();
    expect(job.calls.result).toEqual([]);
    const capsule = require('./railgun-private-capsule').normalizeRailgunPrivateCapsule({
      version: 1,
      walletId: A.walletId,
      engineSha256: manifest.sha256,
      selection: selection(),
      preparation: publicPreparation,
      noteHash: hex(input.note.hash),
      pathElements: Array(16).fill(hex(6)),
    });
    await expect(reconstruct(capsule)).rejects.toThrow();
    wiped();
  });
  test('an unmarked transfer to B is refused as a self-transfer mismatch', async () => {
    const value = selection();
    delete value.recipientRelationship;
    await expect(prepare(value)).rejects.toThrow();
    expect(toy.calls.create).toEqual([]);
  });
});
