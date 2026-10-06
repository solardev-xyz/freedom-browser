/** Utility-only independent recovery from serialized unsigned bytes and a freshly
 * restored viewing wallet. Never generate/encrypt a replacement transaction. */
const assert = require('assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const engine = require('./railgun-engine-manifest.json');
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
const fail = () =>
  Object.assign(new Error('Railgun relay reconstruction refused'), {
    code: 'RAILGUN_RELAY_RECONSTRUCTION_REFUSED',
  });
async function reconstruct(
  { archive, wallet, descriptor, checkpoint, scan, draftText, signal },
  rootRule
) {
  try {
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    assert.equal(typeof draftText, 'string');
    assert.ok(Buffer.byteLength(draftText) <= 65536);
    const normalized = normalizeRailgunRelayDraftCapsule(JSON.parse(draftText));
    const draft = normalized.data,
      { selection, intent } = draft;
    assert.equal(JSON.stringify(draft), draftText);
    assert.equal(draft.engineSha256, engine.sha256);
    assert.equal(draft.walletId, descriptor.walletId);
    const { context, expected } = intent;
    assert.equal(context.self.address, descriptor.instanceId);
    assert.equal(wallet.getAddress(), descriptor.instanceId);
    assert.equal(scan.instanceId, descriptor.instanceId);
    assert.equal(wallet.addressKeys.masterPublicKey.toString(), context.self.masterPublicKey);
    assert.equal(
      Buffer.from(wallet.addressKeys.viewingPublicKey).toString('hex'),
      context.self.viewingPublicKey
    );
    archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
    const imp = (name) =>
      require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
    const { decodeAddress, encodeAddress } = imp('key-derivation/bech32');
    const peer = decodeAddress(context.peer.address);
    assert.equal(peer.version, 1);
    assert.deepEqual(peer.chain, { type: 0, id: pins.chainId });
    assert.equal(encodeAddress(peer), context.peer.address);
    assert.equal(peer.masterPublicKey.toString(), context.peer.masterPublicKey);
    assert.equal(Buffer.from(peer.viewingPublicKey).toString('hex'), context.peer.viewingPublicKey);
    const { poseidon, initPoseidonPromise } = imp('utils/poseidon');
    await initPoseidonPromise;
    active();
    const version = 'V2_PoseidonMerkle',
      chain = { type: 0, id: pins.chainId };
    const matching = (items) =>
      items.filter((item) => item.tree === selection.tree && item.position === selection.position);
    const txos = matching(await wallet.TXOs(version, chain));
    active();
    const records = matching(scan.received);
    assert.equal(txos.length, 1);
    assert.equal(records.length, 1);
    const note = txos[0].note,
      record = records[0];
    assert.equal(txos[0].spendtxid, false);
    assert.equal(record.spentTxid, false);
    assert.equal(hex(note.hash), draft.noteHash);
    assert.equal(record.hash, draft.noteHash.slice(2));
    assert.equal(record.value, note.value.toString());
    assert.equal(note.value.toString(), context.inputAmount);
    assert.equal(note.tokenData.tokenType, 0);
    assert.equal(note.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
    assert.equal(BigInt(note.tokenData.tokenSubID), 0n);
    assert.equal(imp('note/note-util').getTokenDataHash(note.tokenData), note.tokenHash);
    const owned = scan.ownedPoi.filter(
      (item) => item.id === `${selection.tree}:${selection.position}`
    );
    assert.equal(owned.length, 1);
    assert.equal(owned[0].hash, draft.noteHash);
    const captured = checkpoint.state.trees.filter((item) => item.tree === selection.tree);
    assert.equal(captured.length, 1);
    assert.ok(selection.position < captured[0].length);
    if (rootRule !== 'local') assert.equal(expected.merkleRoot, captured[0].root);
    const { TransactNote } = imp('note/transact-note');
    const { ShieldNote } = imp('note/shield-note');
    const nullifyingKey = wallet.getNullifyingKey();
    const publicKey = descriptor.spendingPublicKey.map((value) => BigInt('0x' + value));
    assert.equal(
      imp('key-derivation/wallet-node').WalletNode.getMasterPublicKey(publicKey, nullifyingKey),
      wallet.addressKeys.masterPublicKey
    );
    assert.equal(
      ShieldNote.getNotePublicKey(wallet.addressKeys.masterPublicKey, note.random),
      note.notePublicKey
    );
    assert.equal(TransactNote.getHash(note.notePublicKey, note.tokenHash, note.value), note.hash);
    assert.equal(
      hex(TransactNote.getNullifier(nullifyingKey, selection.position)),
      expected.nullifier
    );
    assert.equal(owned[0].nullifier, expected.nullifier);
    assert.equal(
      imp('merkletree/merkle-proof').verifyMerkleProof({
        leaf: draft.noteHash.slice(2),
        root: expected.merkleRoot.slice(2),
        indices: hex(BigInt(selection.position)).slice(2),
        elements: draft.pathElements.map((value) => value.slice(2)),
      }),
      true
    );
    const [[decoded]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
      'transact',
      intent.transaction.data
    );
    assert.equal(
      hex(imp('transaction/bound-params').hashBoundParamsV2(decoded.boundParams)),
      expected.boundParamsHash
    );
    const { getSharedSymmetricKey, getNoteBlindingKeys } = imp('utils/keys-utils');
    const { OutputType } = imp('models/formatted-types');
    const outputTypes = [OutputType.BroadcasterFee, OutputType.Transfer];
    const recipients = [peer, wallet.addressKeys];
    const values = [BigInt(context.feeAmount), BigInt(context.selfAmount)];
    const commitments = [expected.feeCommitment, expected.selfCommitment];
    const privateNote =
      rootRule === 'diagnostic'
        ? undefined
        : Object.freeze({
            tokenHash: note.tokenHash,
            random: note.random,
            value: note.value,
            notePublicKey: note.notePublicKey,
            inputNoteType: owned[0].type,
            commitmentType: txos[0].commitmentType,
          });
    const outputNpks = [];
    for (let index = 0; index < 2; index++) {
      active();
      const bundle = decoded.boundParams.commitmentCiphertext[index];
      const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
      const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
      const symmetric = await getSharedSymmetricKey(wallet.viewingKeyPair.privateKey, receiver);
      try {
        active();
        assert.ok(symmetric instanceof Uint8Array && symmetric.length === 32);
        // isSentNote=true recovers the fee recipient, not the current wallet.
        // Decrypt's internal deterministic note materialization is not new RNG.
        const output = await TransactNote.decrypt(
          version,
          chain,
          wallet.addressKeys,
          {
            iv: bundle.ciphertext[0].slice(2, 34),
            tag: bundle.ciphertext[0].slice(34),
            data: bundle.ciphertext.slice(1).map((value) => value.slice(2)),
          },
          symmetric,
          bundle.memo,
          bundle.annotationData,
          wallet.viewingKeyPair.privateKey,
          receiver,
          sender,
          true,
          false,
          wallet.tokenDataGetter,
          undefined,
          undefined
        );
        active();
        assert.equal(output.receiverAddressData.masterPublicKey, recipients[index].masterPublicKey);
        const recoveredKey = output.receiverAddressData.viewingPublicKey;
        assert.ok(recoveredKey instanceof Uint8Array && recoveredKey.length === 32);
        assert.deepEqual(
          Buffer.from(recoveredKey),
          Buffer.from(recipients[index].viewingPublicKey)
        );
        assert.equal(output.value, values[index]);
        assert.equal(output.tokenData.tokenType, 0);
        assert.equal(output.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
        assert.equal(BigInt(output.tokenData.tokenSubID), 0n);
        assert.equal(output.tokenHash, note.tokenHash);
        assert.equal(output.outputType, outputTypes[index]);
        assert.equal(output.walletSource, 'freedomfixture');
        assert.equal(output.memoText, undefined);
        assert.match(output.random, /^[0-9a-f]{32}$/);
        assert.match(output.senderRandom, /^[0-9a-f]{30}$/);
        assert.equal(
          ShieldNote.getNotePublicKey(recipients[index].masterPublicKey, output.random),
          output.notePublicKey
        );
        assert.equal(
          TransactNote.getHash(output.notePublicKey, output.tokenHash, output.value),
          output.hash
        );
        assert.equal(hex(output.hash), commitments[index]);
        const blinded = getNoteBlindingKeys(
          wallet.addressKeys.viewingPublicKey,
          recipients[index].viewingPublicKey,
          output.random,
          output.senderRandom
        );
        assert.deepEqual(Buffer.from(blinded.blindedSenderViewingKey), sender);
        assert.deepEqual(Buffer.from(blinded.blindedReceiverViewingKey), receiver);
        outputNpks.push(output.notePublicKey);
      } finally {
        if (symmetric instanceof Uint8Array) symmetric.fill(0);
      }
    }
    assert.equal(
      hex(
        poseidon([
          BigInt(expected.merkleRoot),
          BigInt(expected.boundParamsHash),
          BigInt(expected.nullifier),
          BigInt(expected.feeCommitment),
          BigInt(expected.selfCommitment),
        ])
      ),
      intent.expectedHash
    );
    active();
    const publicReconstruction = Object.freeze({
      draftDigest: normalized.digest,
      expectedHash: intent.expectedHash,
      recoveredOutputs: 2,
    });
    if (rootRule === 'diagnostic') return publicReconstruction;
    // Materialize private inputs before this original async operation settles.
    // Only copied primitives from validated input/output notes are retained.
    return privateResult(
      {
        publicReconstruction,
        draft,
        decoded,
        note: privateNote,
        publicKey,
        nullifyingKey,
        outputNpks,
        values,
      },
      signal
    );
  } catch {
    throw fail();
  }
}
// All entrypoints remain utility-private module APIs. Only the diagnostic is
// imported by the existing fixed relay wallet job; no private result is wired.
function reconstructRailgunRelayDraft(input) {
  return reconstruct(input, 'diagnostic');
}
function freezeData(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeData(item);
    Object.freeze(value);
  }
  return value;
}
function privateResult(captured, signal) {
  const { draft, decoded, note, publicKey, nullifyingKey, outputNpks, values } = captured;
  const { commitmentType } = note;
  const {
    selection,
    intent: { expected },
  } = draft;
  const inputNoteType =
    commitmentType === 'ShieldCommitment'
      ? 'Shield'
      : commitmentType === 'TransactCommitmentV2'
        ? 'Transact'
        : undefined;
  assert.ok(inputNoteType);
  assert.equal(note.inputNoteType, inputNoteType);
  const bound = decoded.boundParams;
  const boundParams = {
    treeNumber: bound.treeNumber,
    minGasPrice: bound.minGasPrice,
    unshield: bound.unshield,
    chainID: bound.chainID,
    adaptContract: bound.adaptContract,
    adaptParams: bound.adaptParams,
    commitmentCiphertext: bound.commitmentCiphertext.map((bundle) => ({
      ciphertext: [...bundle.ciphertext],
      blindedSenderViewingKey: bundle.blindedSenderViewingKey,
      blindedReceiverViewingKey: bundle.blindedReceiverViewingKey,
      annotationData: bundle.annotationData,
      memo: bundle.memo,
    })),
  };
  const witness = {
    txidVersion: 'V2_PoseidonMerkle',
    publicInputs: {
      merkleRoot: BigInt(expected.merkleRoot),
      boundParamsHash: BigInt(expected.boundParamsHash),
      nullifiers: [BigInt(expected.nullifier)],
      commitmentsOut: [BigInt(expected.feeCommitment), BigInt(expected.selfCommitment)],
    },
    privateInputs: {
      tokenAddress: BigInt('0x' + note.tokenHash.replace(/^0x/, '')),
      randomIn: [BigInt('0x' + note.random.replace(/^0x/, ''))],
      valueIn: [note.value],
      pathElements: [draft.pathElements.map(BigInt)],
      leavesIndices: [BigInt(selection.position)],
      valueOut: [...values],
      publicKey: [...publicKey],
      npkOut: [...outputNpks],
      nullifyingKey,
    },
    boundParams,
  };
  const prePoi = {
    inputNoteType,
    spendingPublicKey: [...publicKey],
    nullifyingKey,
    inputNpk: note.notePublicKey,
    token: note.tokenHash,
    randomsIn: [note.random],
    valuesIn: [note.value],
    utxoTreeIn: selection.tree,
    utxoPositionsIn: [selection.position],
    npksOut: [...outputNpks],
    valuesOut: [...values],
  };
  assert.ok(signal instanceof AbortSignal && !signal.aborted);
  return freezeData({ publicReconstruction: captured.publicReconstruction, witness, prePoi });
}
function reconstructRailgunRelayWitness(input) {
  return reconstruct(input, 'fresh');
}
// The future fixed caller must authenticate the original local durable draft.
// This verifies its original path while CURRENT restored ownership stays live;
// it does not authenticate storage history or grant disclosure/proving authority.
function reconstructRailgunRelayLocalWitness(input) {
  return reconstruct(input, 'local');
}
module.exports = {
  reconstructRailgunRelayDraft,
  reconstructRailgunRelayWitness,
  reconstructRailgunRelayLocalWitness,
};
