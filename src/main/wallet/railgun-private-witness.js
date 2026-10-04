/** Utility-only bounded preparation from a restored wallet. The returned witness
 * must stay in that utility; only publicPreparation may cross its broker.
 */
const assert = require('assert/strict'),
  path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { validateRailgunPrivateSigningIntent } = require('./railgun-private-intent');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
async function prepareRailgunPrivateWitness({
  archive,
  wallet,
  tree,
  descriptor,
  checkpoint,
  scan,
  selection,
  signal,
}) {
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
  await initPoseidonPromise;
  active();
  const { Transaction } = imp('transaction/transaction'),
    { TransactNote } = imp('note/transact-note');
  const { Prover } = imp('prover/prover');
  const { getSharedSymmetricKey } = imp('utils/keys-utils');
  const version = 'V2_PoseidonMerkle',
    chain = { type: 0, id: pins.chainId };
  const partial = selection.kind === 'railgun-partial-unshield';
  const unshield = partial || selection.kind === 'railgun-token-unshield';
  assert.ok(unshield || selection.kind === 'railgun-private-transfer');
  assert.deepEqual(Object.keys(selection).sort(), [
    'kind',
    'position',
    'recipient',
    'tree',
    ...(partial ? ['unshieldAmount'] : []),
  ]);
  assert.ok(Number.isInteger(selection.tree) && selection.tree >= 0 && selection.tree <= 65535);
  assert.ok(
    Number.isInteger(selection.position) && selection.position >= 0 && selection.position <= 65535
  );
  assert.equal(wallet.getAddress(), descriptor.instanceId);
  assert.equal(scan.instanceId, descriptor.instanceId);
  if (unshield) {
    assert.match(selection.recipient, /^0x[0-9a-f]{40}$/);
    assert.ok(BigInt(selection.recipient) > 0n);
  } else assert.equal(selection.recipient, descriptor.instanceId);
  const matching = (items) =>
    items.filter((n) => n.tree === selection.tree && n.position === selection.position);
  const recovered = matching(scan.received),
    txos = matching(await wallet.TXOs(version, chain));
  active();
  assert.equal(recovered.length, 1);
  assert.equal(txos.length, 1);
  const txo = txos[0],
    note = txo.note,
    read = recovered[0];
  assert.equal(txo.spendtxid, false);
  assert.equal(read.spentTxid, false);
  assert.equal(hex(note.hash).slice(2), read.hash);
  assert.equal(note.value.toString(), read.value);
  assert.ok(note.value > 0n && note.value <= BigInt(pins.maxQualificationAmount));
  assert.equal(note.tokenData.tokenType, 0);
  assert.equal(note.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
  assert.equal(BigInt(note.tokenData.tokenSubID), 0n);
  const owned = scan.ownedPoi.filter((v) => v.id === `${selection.tree}:${selection.position}`);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].hash, hex(note.hash));
  const capturedTree = checkpoint.state.trees.find((v) => v.tree === selection.tree);
  assert.ok(capturedTree && selection.position < capturedTree.length);
  const proof = await tree.getMerkleProof(selection.tree, selection.position);
  active();
  assert.equal(proof.elements.length, 16);
  assert.equal(BigInt('0x' + proof.indices.replace(/^0x/, '')), BigInt(selection.position));
  assert.equal('0x' + proof.leaf.replace(/^0x/, ''), hex(note.hash));
  assert.equal('0x' + proof.root.replace(/^0x/, ''), capturedTree.root);
  assert.equal(imp('merkletree/merkle-proof').verifyMerkleProof(proof), true);
  let unshieldAmount = note.value,
    changeAmount;
  if (partial) {
    assert.equal(typeof selection.unshieldAmount, 'string');
    assert.match(selection.unshieldAmount, /^[1-9][0-9]{0,16}$/);
    unshieldAmount = BigInt(selection.unshieldAmount);
    assert.ok(unshieldAmount > 0n && unshieldAmount < note.value);
    changeAmount = note.value - unshieldAmount;
  }
  const outputs =
    unshield && !partial
      ? []
      : [
          TransactNote.createTransfer(
            wallet.addressKeys,
            wallet.addressKeys,
            partial ? changeAmount : note.value,
            note.tokenData,
            partial,
            partial ? imp('models/formatted-types').OutputType.Change : 0,
            undefined
          ),
        ];
  const transaction = new Transaction(chain, note.tokenData, selection.tree, [txo], outputs, {
    contract: '0x' + '0'.repeat(40),
    parameters: hex(0n),
  });
  if (unshield)
    transaction.addUnshieldData(
      { tokenData: note.tokenData, toAddress: selection.recipient, allowOverride: false },
      unshieldAmount
    );
  // Transaction preparation needs the public spending key only. Never call the
  // wallet's spending-key API or construct a private-key placeholder.
  const publicWallet = {
    getUTXOMerkletree: () => ({
      getRoot: async () => proof.root,
      getMerkleProof: async (number, position) => {
        assert.equal(number, selection.tree);
        assert.equal(position, selection.position);
        return proof;
      },
    }),
    getSpendingKeyPair: async () => ({
      pubkey: descriptor.spendingPublicKey.map((v) => BigInt('0x' + v)),
    }),
    getNullifyingKey: () => wallet.getNullifyingKey(),
    getViewingKeyPair: () => wallet.getViewingKeyPair(),
    viewingKeyPair: wallet.viewingKeyPair,
    addressKeys: wallet.addressKeys,
  };
  active();
  const witness = await transaction.generateTransactionRequest(publicWallet, version, '', {
    minGasPrice: 0n,
  });
  assert.deepEqual(
    witness.privateInputs.publicKey,
    descriptor.spendingPublicKey.map((v) => BigInt('0x' + v))
  );
  const prover = new Prover({
    assertArtifactExists: (inputs, outputCount) => {
      assert.equal(inputs, 1);
      assert.equal(outputCount, partial ? 2 : 1);
    },
    getArtifacts: async () => {
      throw Error('No proving capability');
    },
  });
  const dummy = await transaction.generateDummyProvedTransaction(prover, witness);
  const pub = witness.publicInputs;
  assert.equal(pub.nullifiers.length, 1);
  assert.equal(pub.commitmentsOut.length, partial ? 2 : 1);
  if (partial) {
    assert.deepEqual(witness.privateInputs.valueIn, [note.value]);
    assert.deepEqual(witness.privateInputs.valueOut, [changeAmount, unshieldAmount]);
    assert.equal(witness.privateInputs.npkOut.length, 2);
    assert.equal(witness.privateInputs.npkOut[1], BigInt(selection.recipient));
  }
  const expected = {
    kind: selection.kind,
    tree: selection.tree,
    merkleRoot: hex(pub.merkleRoot),
    nullifier: hex(pub.nullifiers[0]),
    ...(partial
      ? {
          changeCommitment: hex(pub.commitmentsOut[0]),
          unshieldCommitment: hex(pub.commitmentsOut[1]),
        }
      : { commitment: hex(pub.commitmentsOut[0]) }),
    boundParamsHash: hex(pub.boundParamsHash),
    ...(partial
      ? { recipient: selection.recipient, unshieldAmount: unshieldAmount.toString() }
      : unshield
        ? { recipient: selection.recipient, amount: note.value.toString() }
        : {}),
  };
  assert.equal(expected.merkleRoot, capturedTree.root);
  assert.equal(expected.nullifier, owned[0].nullifier);
  if (unshield)
    assert.equal(
      imp('note/note-util').getNoteHash(selection.recipient, note.tokenData, unshieldAmount),
      pub.commitmentsOut[partial ? 1 : 0]
    );
  if (!unshield || partial) {
    assert.equal(dummy.boundParams.commitmentCiphertext.length, 1);
    const bundle = dummy.boundParams.commitmentCiphertext[0];
    const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
    const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
    const symmetric = await getSharedSymmetricKey(wallet.viewingKeyPair.privateKey, sender);
    assert.ok(symmetric);
    try {
      active();
      const received = await TransactNote.decrypt(
        version,
        chain,
        wallet.addressKeys,
        {
          iv: bundle.ciphertext[0].slice(2, 34),
          tag: bundle.ciphertext[0].slice(34),
          data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
        },
        symmetric,
        bundle.memo,
        bundle.annotationData,
        wallet.viewingKeyPair.privateKey,
        receiver,
        sender,
        false,
        false,
        wallet.tokenDataGetter,
        undefined,
        undefined
      );
      active();
      assert.equal(received.value, partial ? changeAmount : note.value);
      assert.equal(received.tokenHash, note.tokenHash);
      if (partial) {
        assert.equal(
          received.notePublicKey,
          imp('note/shield-note').ShieldNote.getNotePublicKey(
            wallet.addressKeys.masterPublicKey,
            received.random
          )
        );
        assert.equal(received.tokenData.tokenType, 0);
        assert.equal(received.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
        assert.equal(BigInt(received.tokenData.tokenSubID), 0n);
        assert.equal(witness.privateInputs.npkOut[0], received.notePublicKey);
        assert.equal(bundle.memo, '0x');
        assert.equal(received.memoText, undefined);
        const annotation = imp('note/memo').Memo.decryptNoteAnnotationData(
          bundle.annotationData,
          wallet.viewingKeyPair.privateKey
        );
        assert.equal(annotation?.outputType, imp('models/formatted-types').OutputType.Change);
        assert.equal(
          annotation.senderRandom,
          imp('models/transaction-constants').MEMO_SENDER_RANDOM_NULL
        );
      }
      assert.equal(received.hash, pub.commitmentsOut[0]);
      assert.equal(
        TransactNote.getHash(received.notePublicKey, received.tokenHash, received.value),
        received.hash
      );
    } finally {
      symmetric.fill(0);
    }
  }
  active();
  const intent = {
    chainId: pins.chainId,
    to: pins.proxy,
    value: '0',
    data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[dummy]]),
  };
  validateRailgunPrivateSigningIntent(intent, expected);
  return {
    witness,
    transaction,
    publicPreparation: {
      transaction: intent,
      expected,
      expectedHash: hex(
        poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut])
      ),
      recipient: selection.recipient,
      ...(partial
        ? {
            inputAmount: note.value.toString(),
            unshieldAmount: unshieldAmount.toString(),
            changeAmount: changeAmount.toString(),
          }
        : { amount: note.value.toString() }),
    },
  };
}
module.exports = { prepareRailgunPrivateWitness };
