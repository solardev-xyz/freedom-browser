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
async function reconstructRailgunRelayDraft({
  archive,
  wallet,
  descriptor,
  checkpoint,
  scan,
  draftText,
  signal,
}) {
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
    assert.equal(expected.merkleRoot, captured[0].root);
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
    return Object.freeze({
      draftDigest: normalized.digest,
      expectedHash: intent.expectedHash,
      recoveredOutputs: 2,
    });
  } catch {
    throw fail();
  }
}
module.exports = { reconstructRailgunRelayDraft };
