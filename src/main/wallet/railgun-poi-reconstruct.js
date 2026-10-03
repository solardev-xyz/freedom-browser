/** Utility-only post-transaction reconstruction for a Shield input and one
 * self-transfer/full-unshield output. Caller owns the viewing key. Returned
 * witness secrets must remain inside that utility, never serialized to main.
 * Supplied creator/capsule data is not authenticated source or spending authority.
 */
const assert = require('assert/strict');
const path = require('path');
const { Interface } = require('ethers');
const { TRANSACT_ABI } = require('./railgun-private-policy');
const { normalizeRailgunPrivateCapsule } = require('./railgun-private-capsule');
const pins = require('./railgun-shield-pins.json');
const hex = (n) => '0x' + n.toString(16).padStart(64, '0');
async function reconstructRailgunPoiNotes({
  archive,
  descriptor,
  viewingKey,
  capsule: supplied,
  creator: suppliedCreator,
  signal,
}) {
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  const text = JSON.stringify({ descriptor, capsule: supplied, creator: suppliedCreator });
  assert.ok(Buffer.byteLength(text) <= 65536);
  const copied = JSON.parse(text);
  descriptor = copied.descriptor;
  const capsule = normalizeRailgunPrivateCapsule(copied.capsule),
    creator = copied.creator;
  assert.ok(viewingKey instanceof Uint8Array && viewingKey.byteLength === 32);
  // Own a working copy across awaits; the caller's key remains caller-owned.
  const key = Buffer.from(viewingKey);
  let shared;
  try {
    archive = require('./railgun-engine-runtime').verifyRailgunEngineRuntime(archive);
    const imp = (name) =>
      require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
    await imp('utils/poseidon').initPoseidonPromise;
    active();
    const { getPublicViewingKey, getSharedSymmetricKey } = imp('utils/keys-utils');
    const { ViewOnlyWallet } = imp('wallet/view-only-wallet');
    const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
    const { TransactNote } = imp('note/transact-note');
    assert.ok(
      Array.isArray(descriptor.spendingPublicKey) && descriptor.spendingPublicKey.length === 2
    );
    const spendingPublicKey = descriptor.spendingPublicKey.map((v) => {
      assert.match(v, /^[0-9a-f]{64}$/);
      return BigInt('0x' + v);
    });
    const pubkey = await getPublicViewingKey(key);
    active();
    assert.equal(Buffer.from(pubkey).toString('hex'), descriptor.viewingPublicKey);
    const denied = new Proxy(
      {},
      {
        get() {
          throw Error('No POI reconstruction storage or prover');
        },
      }
    );
    const wallet = new ViewOnlyWallet(
      descriptor.walletId,
      denied,
      { privateKey: key, pubkey },
      spendingPublicKey,
      undefined,
      denied
    );
    assert.equal(wallet.getAddress(), descriptor.instanceId);
    assert.equal(hex(wallet.masterPublicKey).slice(2), descriptor.masterPublicKey);
    assert.equal(
      ViewOnlyWallet.generateID(wallet.generateShareableViewingKey()),
      descriptor.walletId
    );
    assert.equal(capsule.walletId, descriptor.walletId);
    const { selection, preparation, noteHash } = capsule;
    assert.deepEqual(Object.keys(creator).sort(), [
      'ciphertext',
      'position',
      'preimage',
      'tree',
      'type',
    ]);
    assert.equal(creator.type, 'Shield');
    assert.equal(creator.tree, selection.tree);
    assert.equal(creator.position, selection.position);
    const { preimage, ciphertext } = creator;
    assert.deepEqual(Object.keys(preimage).sort(), ['npk', 'token', 'value']);
    assert.deepEqual(Object.keys(preimage.token).sort(), [
      'tokenAddress',
      'tokenSubID',
      'tokenType',
    ]);
    assert.equal(preimage.token.tokenType, 0);
    assert.equal(preimage.token.tokenAddress, pins.wrappedNative);
    assert.equal(preimage.token.tokenSubID, hex(0n));
    assert.match(preimage.value, /^[1-9][0-9]*$/);
    assert.equal(preimage.value, preparation.amount);
    assert.deepEqual(Object.keys(ciphertext).sort(), ['encryptedBundle', 'shieldKey']);
    assert.ok(Array.isArray(ciphertext.encryptedBundle) && ciphertext.encryptedBundle.length === 3);
    for (const v of [...ciphertext.encryptedBundle, ciphertext.shieldKey])
      assert.match(v, /^0x[0-9a-f]{64}$/);
    shared = await getSharedSymmetricKey(key, Buffer.from(ciphertext.shieldKey.slice(2), 'hex'));
    active();
    assert.ok(shared);
    const random = ShieldNoteERC20.decryptRandom(ciphertext.encryptedBundle, shared);
    shared.fill(0);
    shared = undefined;
    // This is an event preimage: value is already net of the shield fee.
    const note = new ShieldNoteERC20(
      wallet.masterPublicKey,
      random,
      BigInt(preimage.value),
      pins.wrappedNative
    );
    assert.equal(hex(note.notePublicKey), preimage.npk);
    assert.equal(
      hex(ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value)),
      noteHash
    );
    const nullifyingKey = wallet.getNullifyingKey();
    assert.equal(
      hex(TransactNote.getNullifier(nullifyingKey, selection.position)),
      preparation.expected.nullifier
    );
    const [[tx]] = new Interface([TRANSACT_ABI]).decodeFunctionData(
      'transact',
      preparation.transaction.data
    );
    const npksOut = [],
      valuesOut = [];
    if (selection.kind === 'railgun-private-transfer') {
      assert.equal(selection.recipient, descriptor.instanceId);
      assert.equal(tx.boundParams.commitmentCiphertext.length, 1);
      const bundle = tx.boundParams.commitmentCiphertext[0];
      const sender = Buffer.from(bundle.blindedSenderViewingKey.slice(2), 'hex');
      const receiver = Buffer.from(bundle.blindedReceiverViewingKey.slice(2), 'hex');
      shared = await getSharedSymmetricKey(key, sender);
      active();
      assert.ok(shared);
      const output = await TransactNote.decrypt(
        'V2_PoseidonMerkle',
        { type: 0, id: pins.chainId },
        wallet.addressKeys,
        {
          iv: bundle.ciphertext[0].slice(2, 34),
          tag: bundle.ciphertext[0].slice(34),
          data: bundle.ciphertext.slice(1).map((v) => v.slice(2)),
        },
        shared,
        bundle.memo,
        bundle.annotationData,
        key,
        receiver,
        sender,
        false,
        false,
        {
          getTokenDataFromHash: async (_v, _c, hash) => {
            assert.equal(
              BigInt('0x' + hash.replace(/^0x/, '')),
              BigInt('0x' + note.tokenHash.replace(/^0x/, ''))
            );
            return note.tokenData;
          },
        },
        undefined,
        undefined
      );
      active();
      assert.equal(output.value, note.value);
      assert.equal(output.tokenHash, note.tokenHash);
      assert.equal(output.hash, BigInt(preparation.expected.commitment));
      assert.equal(
        TransactNote.getHash(output.notePublicKey, output.tokenHash, output.value),
        output.hash
      );
      npksOut.push(output.notePublicKey);
      valuesOut.push(output.value);
    } else {
      assert.equal(selection.kind, 'railgun-token-unshield');
      assert.equal(tx.boundParams.commitmentCiphertext.length, 0);
      assert.equal(
        imp('note/note-util').getNoteHash(selection.recipient, note.tokenData, note.value),
        BigInt(preparation.expected.commitment)
      );
    }
    active();
    return {
      spendingPublicKey,
      nullifyingKey,
      token: note.tokenHash,
      randomsIn: [note.random],
      valuesIn: [note.value],
      utxoPositionsIn: [selection.position],
      utxoTreeIn: selection.tree,
      npksOut,
      valuesOut,
      inputNpk: note.notePublicKey,
    };
  } finally {
    key.fill(0);
    shared?.fill(0);
  }
}
module.exports = { reconstructRailgunPoiNotes };
