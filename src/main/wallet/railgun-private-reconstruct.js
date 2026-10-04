/** Utility-only reconstruction of the exact original 1x1 intent. Input secrets
 * come from the restored viewing wallet and output secrets from its ciphertext.
 * Never re-encrypt an output or ask the SDK to generate a new transaction request.
 */
const assert = require('assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
async function reconstructRailgunPrivateWitness({
  archive,
  wallet,
  descriptor,
  scan,
  capsule: input,
  signal,
}) {
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const capsule = normalizeRailgunPrivateCapsule(input);
  assert.equal(capsule.version, 1);
  assert.ok(
    ['railgun-private-transfer', 'railgun-token-unshield'].includes(capsule.selection.kind)
  );
  const { selection, preparation, noteHash, pathElements } = capsule;
  assert.equal(capsule.walletId, descriptor.walletId);
  assert.equal(wallet.getAddress(), descriptor.instanceId);
  assert.equal(scan.instanceId, descriptor.instanceId);
  archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
  await initPoseidonPromise;
  active();
  const { TransactNote } = imp('note/transact-note');
  const { Prover } = imp('prover/prover');
  const version = 'V2_PoseidonMerkle',
    chain = { type: 0, id: pins.chainId };
  const matching = (items) =>
    items.filter((v) => v.tree === selection.tree && v.position === selection.position);
  const txos = matching(await wallet.TXOs(version, chain)),
    reads = matching(scan.received);
  assert.equal(txos.length, 1);
  assert.equal(reads.length, 1);
  const txo = txos[0],
    note = txo.note,
    read = reads[0];
  assert.equal(txo.spendtxid, false);
  assert.equal(read.spentTxid, false);
  assert.equal(hex(note.hash), noteHash);
  assert.equal(read.hash, noteHash.slice(2));
  assert.equal(read.value, note.value.toString());
  assert.equal(note.value.toString(), preparation.amount);
  assert.equal(note.tokenData.tokenType, 0);
  assert.equal(note.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
  assert.equal(BigInt(note.tokenData.tokenSubID), 0n);
  const owned = scan.ownedPoi.filter((v) => v.id === `${selection.tree}:${selection.position}`);
  assert.equal(owned.length, 1);
  assert.equal(owned[0].hash, noteHash);
  const { expected } = preparation;
  const nullifyingKey = wallet.getNullifyingKey();
  const publicKey = descriptor.spendingPublicKey.map((v) => BigInt('0x' + v));
  assert.equal(
    imp('key-derivation/wallet-node').WalletNode.getMasterPublicKey(publicKey, nullifyingKey),
    wallet.addressKeys.masterPublicKey
  );
  assert.equal(
    imp('note/shield-note').ShieldNote.getNotePublicKey(
      wallet.addressKeys.masterPublicKey,
      note.random
    ),
    note.notePublicKey
  );
  assert.equal(
    TransactNote.getHash(note.notePublicKey, note.tokenHash, note.value),
    BigInt(noteHash)
  );
  assert.equal(
    hex(TransactNote.getNullifier(nullifyingKey, selection.position)),
    expected.nullifier
  );
  assert.equal(owned[0].nullifier, expected.nullifier);
  assert.equal(
    imp('merkletree/merkle-proof').verifyMerkleProof({
      leaf: noteHash.slice(2),
      root: expected.merkleRoot.slice(2),
      indices: hex(BigInt(selection.position)).slice(2),
      elements: pathElements.map((v) => v.slice(2)),
    }),
    true
  );
  const [[decoded]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
    'transact',
    preparation.transaction.data
  );
  let outputNpk;
  if (selection.kind === 'railgun-token-unshield') {
    outputNpk = BigInt(selection.recipient);
    assert.equal(
      imp('note/note-util').getNoteHash(selection.recipient, note.tokenData, note.value),
      BigInt(expected.commitment)
    );
  } else {
    assert.equal(selection.recipient, descriptor.instanceId);
    const bundle = decoded.boundParams.commitmentCiphertext[0];
    const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
    const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
    const symmetric = await imp('utils/keys-utils').getSharedSymmetricKey(
      wallet.viewingKeyPair.privateKey,
      sender
    );
    assert.ok(symmetric);
    try {
      const output = await TransactNote.decrypt(
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
      assert.equal(output.value, note.value);
      assert.equal(output.tokenHash, note.tokenHash);
      assert.equal(output.hash, BigInt(expected.commitment));
      assert.equal(
        TransactNote.getHash(output.notePublicKey, output.tokenHash, output.value),
        output.hash
      );
      outputNpk = output.notePublicKey;
    } finally {
      symmetric.fill(0);
    }
  }
  const pub = {
    merkleRoot: BigInt(expected.merkleRoot),
    boundParamsHash: BigInt(expected.boundParamsHash),
    nullifiers: [BigInt(expected.nullifier)],
    commitmentsOut: [BigInt(expected.commitment)],
  };
  assert.equal(
    hex(poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut])),
    preparation.expectedHash
  );
  const privateInputs = {
    tokenAddress: BigInt('0x' + note.tokenHash.replace(/^0x/, '')),
    randomIn: [BigInt('0x' + note.random.replace(/^0x/, ''))],
    valueIn: [note.value],
    pathElements: [pathElements.map(BigInt)],
    leavesIndices: [BigInt(selection.position)],
    valueOut: [note.value],
    publicKey,
    npkOut: [outputNpk],
    nullifyingKey,
  };
  const boundParams = decoded.boundParams;
  assert.equal(imp('transaction/bound-params').hashBoundParamsV2(boundParams), pub.boundParamsHash);
  const witness = { txidVersion: version, privateInputs, publicInputs: pub, boundParams };
  active();
  // This facade uses only the already-checked immutable public ciphertext and
  // preimage. It cannot call generateTransactionRequest or produce new outputs.
  const transaction = Object.freeze({
    async generateProvedTransaction(txidVersion, prover, inputs, progress) {
      assert.equal(txidVersion, version);
      assert.deepEqual(inputs.privateInputs, privateInputs);
      assert.deepEqual(inputs.publicInputs, pub);
      assert.deepEqual(inputs.boundParams, boundParams);
      active();
      assert.ok(inputs.privateInputs.valueIn[0] > 0n && inputs.privateInputs.valueOut[0] > 0n);
      const { proof } = await prover.proveRailgun(version, inputs, progress);
      active();
      return {
        proof: Prover.formatProof(proof),
        merkleRoot: expected.merkleRoot,
        nullifiers: [expected.nullifier],
        commitments: [expected.commitment],
        boundParams,
        unshieldPreimage: decoded.unshieldPreimage,
      };
    },
  });
  return { witness, transaction, publicPreparation: preparation };
}
module.exports = { reconstructRailgunPrivateWitness };
