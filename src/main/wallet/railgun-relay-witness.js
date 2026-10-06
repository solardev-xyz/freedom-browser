/** Utility-only unsigned construction. Main owns quote/current-account admission.
 * No signature, proof, reservation or send capability is supplied or returned. */
const assert = require('assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const { shape } = require('./railgun-relay-quote-data');
const { normalizeRailgunRelayUnsignedContext } = require('./railgun-relay-intent');
const { normalizeRailgunRelayDraftCapsule } = require('./railgun-relay-capsule');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const pins = require('./railgun-shield-pins.json');
const engine = require('./railgun-engine-manifest.json');
const hex = (value) => '0x' + value.toString(16).padStart(64, '0');
const fail = () =>
  Object.assign(new Error('Railgun relay draft refused'), {
    code: 'RAILGUN_RELAY_DRAFT_REFUSED',
  });
async function prepareRailgunRelayDraft({
  archive,
  wallet,
  tree,
  descriptor,
  checkpoint,
  scan,
  request,
  signal,
}) {
  try {
    const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
    active();
    // Capture all caller data before the first await; never retain its objects.
    shape(request, ['selection', 'context']);
    shape(request.selection, ['tree', 'position']);
    const selection = { tree: request.selection.tree, position: request.selection.position };
    for (const value of Object.values(selection))
      assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 65535);
    const context = normalizeRailgunRelayUnsignedContext(request.context);
    assert.equal(context.walletId, descriptor.walletId);
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
    const txo = txos[0],
      note = txo.note,
      record = records[0];
    assert.equal(txo.spendtxid, false);
    assert.equal(record.spentTxid, false);
    assert.equal(record.hash, hex(note.hash).slice(2));
    assert.equal(record.value, note.value.toString());
    assert.equal(note.value.toString(), context.inputAmount);
    assert.equal(note.tokenData.tokenType, 0);
    assert.equal(note.tokenData.tokenAddress.toLowerCase(), pins.wrappedNative);
    assert.equal(BigInt(note.tokenData.tokenSubID), 0n);
    const owned = scan.ownedPoi.filter(
      (item) => item.id === `${selection.tree}:${selection.position}`
    );
    assert.equal(owned.length, 1);
    assert.equal(owned[0].hash, hex(note.hash));
    const captured = checkpoint.state.trees.filter((item) => item.tree === selection.tree);
    assert.equal(captured.length, 1);
    assert.ok(selection.position < captured[0].length);
    const proof = await tree.getMerkleProof(selection.tree, selection.position);
    active();
    assert.equal(proof.elements.length, 16);
    assert.equal(BigInt('0x' + proof.indices.replace(/^0x/, '')), BigInt(selection.position));
    assert.equal('0x' + proof.leaf.replace(/^0x/, ''), hex(note.hash));
    assert.equal('0x' + proof.root.replace(/^0x/, ''), captured[0].root);
    assert.equal(imp('merkletree/merkle-proof').verifyMerkleProof(proof), true);
    const { TransactNote } = imp('note/transact-note');
    const { OutputType } = imp('models/formatted-types');
    const { Transaction } = imp('transaction/transaction');
    // The existing withWallet wrapper sets this exact source. Preserve its
    // behavior; the separate public-vector fixture uses a different literal.
    const outputs = [
      TransactNote.createTransfer(
        peer,
        wallet.addressKeys,
        BigInt(context.feeAmount),
        note.tokenData,
        false,
        OutputType.BroadcasterFee,
        undefined
      ),
      TransactNote.createTransfer(
        wallet.addressKeys,
        wallet.addressKeys,
        BigInt(context.selfAmount),
        note.tokenData,
        false,
        OutputType.Transfer,
        undefined
      ),
    ];
    for (const output of outputs) assert.equal(output.walletSource, 'freedomfixture');
    const transaction = new Transaction(chain, note.tokenData, selection.tree, [txo], outputs, {
      contract: '0x' + '0'.repeat(40),
      parameters: hex(0n),
    });
    const publicKey = descriptor.spendingPublicKey.map((value) => BigInt('0x' + value));
    // Public coordinates only: do not invoke the wallet's spending-key API.
    const publicWallet = {
      getUTXOMerkletree: () => ({
        getRoot: async () => proof.root,
        getMerkleProof: async (number, position) => {
          assert.equal(number, selection.tree);
          assert.equal(position, selection.position);
          return proof;
        },
      }),
      getSpendingKeyPair: async () => ({ pubkey: publicKey }),
      getNullifyingKey: () => wallet.getNullifyingKey(),
      getViewingKeyPair: () => wallet.getViewingKeyPair(),
      viewingKeyPair: wallet.viewingKeyPair,
      addressKeys: wallet.addressKeys,
    };
    active();
    const generated = await transaction.generateTransactionRequest(publicWallet, version, '', {
      minGasPrice: BigInt(context.gas.minGasPrice),
    });
    active();
    const pub = generated.publicInputs;
    assert.deepEqual(generated.privateInputs.publicKey, publicKey);
    assert.deepEqual(generated.privateInputs.valueIn, [note.value]);
    assert.deepEqual(generated.privateInputs.valueOut, [
      BigInt(context.feeAmount),
      BigInt(context.selfAmount),
    ]);
    assert.equal(pub.nullifiers.length, 1);
    assert.deepEqual(
      pub.commitmentsOut,
      outputs.map((output) => output.hash)
    );
    assert.equal(hex(pub.merkleRoot), captured[0].root);
    assert.equal(hex(pub.nullifiers[0]), owned[0].nullifier);
    assert.equal(
      imp('transaction/bound-params').hashBoundParamsV2(generated.boundParams),
      pub.boundParamsHash
    );
    const expected = {
      kind: 'railgun-relay-self-transfer',
      tree: selection.tree,
      merkleRoot: hex(pub.merkleRoot),
      nullifier: hex(pub.nullifiers[0]),
      feeCommitment: hex(pub.commitmentsOut[0]),
      selfCommitment: hex(pub.commitmentsOut[1]),
      boundParamsHash: hex(pub.boundParamsHash),
    };
    // Serialize a zero proof directly. No prover object, artifact or proving
    // method is needed for an unsigned draft.
    const unsigned = {
      proof: { a: { x: 0n, y: 0n }, b: { x: [0n, 0n], y: [0n, 0n] }, c: { x: 0n, y: 0n } },
      merkleRoot: expected.merkleRoot,
      nullifiers: [expected.nullifier],
      commitments: [expected.feeCommitment, expected.selfCommitment],
      boundParams: generated.boundParams,
      unshieldPreimage: {
        npk: hex(0n),
        token: { tokenType: 0, tokenAddress: '0x' + '0'.repeat(40), tokenSubID: 0n },
        value: 0n,
      },
    };
    const draft = normalizeRailgunRelayDraftCapsule({
      schema: 'railgun-relay-unsigned-draft-v1',
      walletId: descriptor.walletId,
      engineSha256: engine.sha256,
      selection,
      noteHash: hex(note.hash),
      pathElements: proof.elements.map((value) => '0x' + value.replace(/^0x/, '')),
      intent: {
        transaction: {
          chainId: pins.chainId,
          to: pins.proxy,
          value: '0',
          data: new Interface([TRANSACT_ABI]).encodeFunctionData('transact', [[unsigned]]),
        },
        expected,
        expectedHash: hex(
          poseidon([pub.merkleRoot, pub.boundParamsHash, ...pub.nullifiers, ...pub.commitmentsOut])
        ),
        context,
      },
    });
    active();
    return draft.data;
  } catch {
    throw fail();
  }
}
module.exports = { prepareRailgunRelayDraft };
