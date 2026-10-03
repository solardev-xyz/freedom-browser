/** Utility-only 1x1 preparation from a restored wallet. The returned witness
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
  const { Transaction } = imp('transaction/transaction'),
    { TransactNote } = imp('note/transact-note');
  const { Prover } = imp('prover/prover');
  const { getSharedSymmetricKey } = imp('utils/keys-utils');
  const version = 'V2_PoseidonMerkle',
    chain = { type: 0, id: pins.chainId };
  const unshield = selection.kind === 'railgun-token-unshield';
  assert.ok(unshield || selection.kind === 'railgun-private-transfer');
  assert.deepEqual(Object.keys(selection).sort(), ['kind', 'position', 'recipient', 'tree']);
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
  assert.equal(proof.elements.length, 16);
  assert.equal(BigInt('0x' + proof.indices.replace(/^0x/, '')), BigInt(selection.position));
  assert.equal('0x' + proof.leaf.replace(/^0x/, ''), hex(note.hash));
  assert.equal('0x' + proof.root.replace(/^0x/, ''), capturedTree.root);
  assert.equal(imp('merkletree/merkle-proof').verifyMerkleProof(proof), true);
  const outputs = unshield
    ? []
    : [
        TransactNote.createTransfer(
          wallet.addressKeys,
          wallet.addressKeys,
          note.value,
          note.tokenData,
          false,
          0,
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
      note.value
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
      assert.equal(outputCount, 1);
    },
    getArtifacts: async () => {
      throw Error('No proving capability');
    },
  });
  const dummy = await transaction.generateDummyProvedTransaction(prover, witness);
  const pub = witness.publicInputs;
  assert.equal(pub.nullifiers.length, 1);
  assert.equal(pub.commitmentsOut.length, 1);
  const expected = {
    kind: selection.kind,
    tree: selection.tree,
    merkleRoot: hex(pub.merkleRoot),
    nullifier: hex(pub.nullifiers[0]),
    commitment: hex(pub.commitmentsOut[0]),
    boundParamsHash: hex(pub.boundParamsHash),
    ...(unshield ? { recipient: selection.recipient, amount: note.value.toString() } : {}),
  };
  assert.equal(expected.merkleRoot, capturedTree.root);
  assert.equal(expected.nullifier, owned[0].nullifier);
  if (unshield)
    assert.equal(
      imp('note/note-util').getNoteHash(selection.recipient, note.tokenData, note.value),
      pub.commitmentsOut[0]
    );
  else {
    const bundle = dummy.boundParams.commitmentCiphertext[0];
    const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
    const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
    const symmetric = await getSharedSymmetricKey(wallet.viewingKeyPair.privateKey, sender);
    assert.ok(symmetric);
    try {
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
      assert.equal(received.value, note.value);
      assert.equal(received.tokenHash, note.tokenHash);
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
      amount: note.value.toString(),
    },
  };
}
module.exports = { prepareRailgunPrivateWitness };
