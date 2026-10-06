/** Disposable public-vector construction only. No enrolled authority or stores.
 * Private witness objects returned here stay inside the producer process. */
const assert = require('assert/strict');
const path = require('path');
const { AbiCoder, Interface, keccak256 } = require('ethers');
const pins = require('../../src/main/wallet/railgun-shield-pins.json');
const { TRANSACT_ABI } = require('../../src/main/wallet/railgun-private-policy');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const ZERO = '0x' + '0'.repeat(40);
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const CIPHER =
  '(bytes32[4] ciphertext,bytes32 blindedSenderViewingKey,bytes32 blindedReceiverViewingKey,bytes annotationData,bytes memo)';
const boundType = (bits) =>
  `(uint16 treeNumber,uint${bits} minGasPrice,uint8 unshield,uint64 chainID,address adaptContract,bytes32 adaptParams,${CIPHER}[] commitmentCiphertext)`;
function assertLayout(note, outputs, sender, fee) {
  assert.equal(note.value, 1000n);
  assert.equal(outputs.length, 2);
  assert.deepEqual(
    outputs.map((v) => v.value),
    [100n, 900n]
  );
  assert.deepEqual(
    outputs.map((v) => v.outputType),
    [1, 0]
  );
  for (const [index, receiver] of [fee, sender].entries()) {
    assert.equal(outputs[index].receiverAddressData.masterPublicKey, receiver.masterPublicKey);
    assert.deepEqual(
      outputs[index].receiverAddressData.viewingPublicKey,
      receiver.viewingPublicKey
    );
    assert.equal(outputs[index].memoText, undefined);
  }
  assert.notEqual(fee.masterPublicKey, sender.masterPublicKey);
  assert.equal(
    outputs.reduce((sum, v) => sum + v.value, 0n),
    note.value
  );
}
async function assertEncryptedOutputs(engine, request, sender, fee) {
  const imp = (name) => require(path.join(engine, name));
  const { TransactNote } = imp('note/transact-note');
  const { getSharedSymmetricKey } = imp('utils/keys-utils');
  const { getTokenDataERC20, getTokenDataHash } = imp('note/note-util');
  const { Memo } = imp('note/memo');
  const tokenData = getTokenDataERC20(pins.wrappedNative);
  const tokenHash = getTokenDataHash(tokenData);
  const senderKey = Buffer.alloc(32, 8);
  try {
    for (const [index, receiverAddress] of [fee, sender].entries()) {
      const key = Buffer.alloc(32, index === 0 ? 10 : 8);
      let symmetric;
      try {
        const bundle = request.boundParams.commitmentCiphertext[index];
        const blindedSender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
        const blindedReceiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
        symmetric = await getSharedSymmetricKey(key, blindedSender);
        assert.ok(symmetric);
        const received = await TransactNote.decrypt(
          'V2_PoseidonMerkle',
          { type: 0, id: pins.chainId },
          receiverAddress,
          {
            iv: bundle.ciphertext[0].slice(2, 34),
            tag: bundle.ciphertext[0].slice(34),
            data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
          },
          symmetric,
          bundle.memo,
          bundle.annotationData,
          key,
          blindedReceiver,
          blindedSender,
          false,
          false,
          {
            getTokenDataFromHash: async (_version, _chain, value) => {
              assert.equal(value.replace(/^0x/, ''), tokenHash.replace(/^0x/, ''));
              return tokenData;
            },
          },
          undefined,
          undefined
        );
        assert.equal(received.value, index === 0 ? 100n : 900n);
        assert.equal(received.hash, request.publicInputs.commitmentsOut[index]);
        assert.equal(received.notePublicKey, request.privateInputs.npkOut[index]);
        assert.equal(received.random, (index === 0 ? '02' : '03').repeat(16));
        assert.equal(received.receiverAddressData.masterPublicKey, receiverAddress.masterPublicKey);
        assert.equal(received.memoText, undefined);
        assert.equal(bundle.memo, '0x');
        const annotation = Memo.decryptNoteAnnotationData(bundle.annotationData, senderKey);
        assert.equal(annotation?.outputType, index === 0 ? 1 : 0);
        assert.equal(annotation.senderRandom, (index === 0 ? '04' : '05').repeat(15));
      } finally {
        key.fill(0);
        symmetric?.fill(0);
      }
    }
  } finally {
    senderKey.fill(0);
  }
}
async function prepareRelayVector(engine, minGasPrice) {
  assert.ok(minGasPrice === 0 || minGasPrice === 1);
  const imp = (name) => require(path.join(engine, name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { poseidon } = imp('utils/poseidon');
  const { getPublicSpendingKey, getPublicViewingKey } = imp('utils/keys-utils');
  const { WalletNode } = imp('key-derivation/wallet-node');
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const { TransactNote } = imp('note/transact-note');
  const { Transaction } = imp('transaction/transaction');
  const { verifyMerkleProof, createDummyMerkleProof } = imp('merkletree/merkle-proof');
  const { getGlobalTreePosition, getGlobalTreePositionPreTransactionPOIProof } = imp(
    'poi/global-tree-position'
  );
  const { BlindedCommitment } = imp('poi/blinded-commitment');
  const { getRailgunTransactionIDFromBigInts, getRailgunTxidLeafHash } = imp(
    'transaction/railgun-txid'
  );
  const spendingKey = Buffer.alloc(32, 7),
    viewingKey = Buffer.alloc(32, 8);
  const feeSpendingKey = Buffer.alloc(32, 9),
    feeViewingKey = Buffer.alloc(32, 10);
  try {
    const publicKey = getPublicSpendingKey(spendingKey),
      nullifyingKey = 123n;
    const sender = {
      masterPublicKey: WalletNode.getMasterPublicKey(publicKey, nullifyingKey),
      viewingPublicKey: await getPublicViewingKey(viewingKey),
    };
    const fee = {
      masterPublicKey: WalletNode.getMasterPublicKey(getPublicSpendingKey(feeSpendingKey), 456n),
      viewingPublicKey: await getPublicViewingKey(feeViewingKey),
    };
    feeSpendingKey.fill(0);
    feeViewingKey.fill(0);
    imp('wallet/wallet-info').default.setWalletSource('freedom');
    const note = new ShieldNoteERC20(
      sender.masterPublicKey,
      '01'.repeat(16),
      1000n,
      pins.wrappedNative
    );
    const leaf = ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value);
    const position = 10245;
    let root = leaf;
    for (let i = 0; i < 16; i++) root = poseidon((position >> i) & 1 ? [0n, root] : [root, 0n]);
    const pathProof = {
      leaf: hex(leaf).slice(2),
      root: hex(root).slice(2),
      indices: hex(position).slice(2),
      elements: Array(16).fill(hex(0n).slice(2)),
    };
    assert.equal(verifyMerkleProof(pathProof), true);
    const viewingKeyPair = { privateKey: viewingKey, pubkey: sender.viewingPublicKey };
    const wallet = {
      getUTXOMerkletree: () => ({
        getRoot: async () => pathProof.root,
        getMerkleProof: async () => pathProof,
      }),
      getSpendingKeyPair: async () => ({ pubkey: publicKey }),
      getNullifyingKey: () => nullifyingKey,
      getViewingKeyPair: () => viewingKeyPair,
      viewingKeyPair,
      addressKeys: sender,
    };
    const outputs = [
      new TransactNote(
        fee,
        sender,
        '02'.repeat(16),
        100n,
        note.tokenData,
        1,
        'freedom',
        '04'.repeat(15),
        undefined
      ),
      new TransactNote(
        sender,
        sender,
        '03'.repeat(16),
        900n,
        note.tokenData,
        0,
        'freedom',
        '05'.repeat(15),
        undefined
      ),
    ];
    assertLayout(note, outputs, sender, fee);
    const transaction = new Transaction(
      { type: 0, id: pins.chainId },
      note.tokenData,
      0,
      [{ note, tree: 0, position }],
      outputs,
      { contract: ZERO, parameters: hex(0n) }
    );
    const request = await transaction.generateTransactionRequest(wallet, 'V2_PoseidonMerkle', '', {
      minGasPrice: BigInt(minGasPrice),
    });
    assert.deepEqual(request.privateInputs.valueIn, [1000n]);
    assert.deepEqual(request.privateInputs.valueOut, [100n, 900n]);
    assert.deepEqual(
      request.publicInputs.commitmentsOut,
      outputs.map((n) => n.hash)
    );
    assert.equal(request.boundParams.commitmentCiphertext.length, 2);
    assert.equal(request.boundParams.minGasPrice, BigInt(minGasPrice));
    await assertEncryptedOutputs(engine, request, sender, fee);
    const coder = AbiCoder.defaultAbiCoder();
    assert.equal(
      coder.encode([boundType(48)], [request.boundParams]),
      coder.encode([boundType(72)], [request.boundParams])
    );
    const boundHash =
      BigInt(keccak256(coder.encode([boundType(72)], [request.boundParams]))) % FIELD;
    assert.equal(request.publicInputs.boundParamsHash, boundHash);
    const pub = request.publicInputs;
    const message = poseidon([
      pub.merkleRoot,
      pub.boundParamsHash,
      ...pub.nullifiers,
      ...pub.commitmentsOut,
    ]);
    const { signEDDSA, verifyEDDSA } = imp('utils/keys-utils');
    const signature = signEDDSA(spendingKey, message);
    spendingKey.fill(0);
    assert.equal(verifyEDDSA(message, signature, publicKey), true);
    const changed = poseidon([
      pub.merkleRoot,
      (pub.boundParamsHash + 1n) % FIELD,
      ...pub.nullifiers,
      ...pub.commitmentsOut,
    ]);
    assert.equal(verifyEDDSA(changed, signature, publicKey), false);
    const blindedInput = BlindedCommitment.getForShieldOrTransact(
      hex(leaf),
      note.notePublicKey,
      getGlobalTreePosition(0, position)
    );
    const elements = Array.from({ length: 16 }, (_, i) => hex(i + 1).slice(2));
    let listRoot = BigInt(blindedInput);
    for (let i = 0; i < 16; i++)
      listRoot = poseidon(
        (5 >> i) & 1
          ? [BigInt('0x' + elements[i]), listRoot]
          : [listRoot, BigInt('0x' + elements[i])]
      );
    const list = {
      leaf: blindedInput.slice(2),
      root: hex(listRoot).slice(2),
      indices: hex(5).slice(2),
      elements,
    };
    assert.equal(verifyMerkleProof(list), true);
    const globalPosition = getGlobalTreePositionPreTransactionPOIProof();
    assert.equal(globalPosition, 199999n * 65536n + 199999n);
    const txid = getRailgunTransactionIDFromBigInts(
      pub.nullifiers,
      pub.commitmentsOut,
      pub.boundParamsHash
    );
    const txidLeaf = getRailgunTxidLeafHash(txid, 0n, globalPosition);
    const txidPath = createDummyMerkleProof(txidLeaf);
    assert.equal(verifyMerkleProof(txidPath), true);
    const blindedOut = pub.commitmentsOut.map((v, i) =>
      BlindedCommitment.getForShieldOrTransact(
        hex(v),
        request.privateInputs.npkOut[i],
        globalPosition + BigInt(i)
      )
    );
    const poiInputs = {
      anyRailgunTxidMerklerootAfterTransaction: txidPath.root,
      boundParamsHash: hex(pub.boundParamsHash),
      nullifiers: pub.nullifiers.map(hex),
      commitmentsOut: pub.commitmentsOut.map(hex),
      spendingPublicKey: publicKey,
      nullifyingKey,
      token: note.tokenHash,
      randomsIn: [note.random],
      valuesIn: [note.value],
      utxoPositionsIn: [position],
      utxoTreeIn: 0,
      npksOut: request.privateInputs.npkOut,
      valuesOut: request.privateInputs.valueOut,
      utxoBatchGlobalStartPositionOut: globalPosition,
      railgunTxidIfHasUnshield: '0x00',
      railgunTxidMerkleProofIndices: txidPath.indices,
      railgunTxidMerkleProofPathElements: txidPath.elements,
      poiMerkleroots: [list.root],
      poiInMerkleProofIndices: [list.indices],
      poiInMerkleProofPathElements: [list.elements],
    };
    return {
      transaction,
      request: { ...request, signature: [...signature.R8, signature.S] },
      poiInputs,
      blindedInput,
      blindedOut,
      minGasPrice,
      layout: { note, outputs, sender, fee },
    };
  } finally {
    spendingKey.fill(0);
    viewingKey.fill(0);
    feeSpendingKey.fill(0);
    feeViewingKey.fill(0);
  }
}
function encodeTransaction(tx) {
  return {
    chainId: pins.chainId,
    to: pins.proxy,
    value: '0',
    data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[tx]]),
  };
}
module.exports = {
  prepareRelayVector,
  assertLayout,
  assertEncryptedOutputs,
  encodeTransaction,
  hex,
  FIELD,
  boundType,
};
