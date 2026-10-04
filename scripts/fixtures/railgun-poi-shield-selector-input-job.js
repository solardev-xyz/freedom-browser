/** Public synthetic Shield cryptography with structural recovery capsules.
 * Private fixture material goes only to the qualification host's memory. */
const assert = require('assert/strict');
const path = require('path');
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
exports.run = async (text, { request, signal, guardReport }) => {
  const { archive: supplied } = JSON.parse(text);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(supplied);
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const { TransactNote } = imp('note/transact-note');
  const { BlindedCommitment } = imp('poi/blinded-commitment');
  const { getGlobalTreePosition } = imp('poi/global-tree-position');
  const { getPublicViewingKey, getSharedSymmetricKey } = imp('utils/keys-utils');
  const pins = require('../../src/main/wallet/railgun-shield-pins.json');
  const key = Buffer.alloc(32, 7),
    shieldKey = Buffer.alloc(32, 8);
  let shared;
  try {
    const pubkey = await getPublicViewingKey(key);
    const note = new ShieldNoteERC20(13n, '02'.repeat(16), 1000n, pins.wrappedNative);
    const hash = ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value);
    const otherNote = new ShieldNoteERC20(13n, '03'.repeat(16), 1000n, pins.wrappedNative);
    const otherNoteHash = hex(
      ShieldNoteERC20.getShieldNoteHash(
        otherNote.notePublicKey,
        otherNote.tokenHash,
        otherNote.value
      )
    );
    assert.notEqual(otherNoteHash, hex(hash));
    const serialized = await note.serialize(shieldKey, pubkey);
    shared = await getSharedSymmetricKey(
      key,
      Buffer.from(serialized.ciphertext.shieldKey.slice(2), 'hex')
    );
    assert.ok(shared);
    assert.equal(
      ShieldNoteERC20.decryptRandom(serialized.ciphertext.encryptedBundle, shared),
      note.random
    );
    const { Interface } = require('ethers');
    const abi = new Interface([
      require('../../src/main/wallet/railgun-private-policy').TRANSACT_ABI,
    ]);
    const vectors = [];
    for (const [unshield, tree, position] of [
      [false, 0, 10245],
      [true, 1, 65535],
      [false, 65535, 65535],
    ]) {
      const { capsule } = require('./railgun-own-txid-data').sample(unshield);
      const [[decoded]] = abi.decodeFunctionData('transact', capsule.preparation.transaction.data);
      const raw = decoded.toArray(true);
      raw[4][0] = BigInt(tree);
      capsule.preparation.transaction.data = abi.encodeFunctionData('transact', [[raw]]);
      const extracted =
        require('../../src/main/wallet/railgun-transact-intent').extractRailgunTransactIntent(
          capsule.preparation.transaction
        );
      capsule.preparation.transaction = extracted.intent;
      capsule.preparation.expected = extracted.expected;
      capsule.selection.tree = tree;
      capsule.selection.position = position;
      capsule.noteHash = hex(hash);
      const creator = {
        type: 'Shield',
        tree,
        position,
        preimage: {
          npk: hex(note.notePublicKey),
          token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
          value: '1000',
        },
        ciphertext: serialized.ciphertext,
      };
      require('../../src/main/wallet/railgun-poi-shield-selector-data').normalizeRailgunPoiShieldInput(
        capsule,
        creator
      );
      const nullifier = hex(TransactNote.getNullifier(19n, position));
      const blinded = BlindedCommitment.getForShieldOrTransact(
        hex(hash),
        note.notePublicKey,
        getGlobalTreePosition(tree, position)
      );
      const owned =
        require('../../src/main/wallet/railgun-owned-poi-records').projectRailgunOwnedPoiRecord(
          {
            commitmentType: 'ShieldCommitment',
            tree,
            position,
            note: {
              notePublicKey: note.notePublicKey,
              tokenHash: note.tokenHash,
              value: note.value,
              hash,
            },
            blindedCommitment: blinded,
            nullifier,
          },
          {
            commitmentType: 'ShieldCommitment',
            utxoTree: tree,
            utxoIndex: position,
            hash: hex(hash),
            preImage: { npk: hex(note.notePublicKey) },
            txid: hex(1),
            blockNumber: 6000000,
          },
          { TransactNote, BlindedCommitment, getGlobalTreePosition },
          nullifier
        );
      assert.equal(owned.blindedCommitment, blinded);
      vectors.push({
        capsule,
        creator,
        expectedBlindedCommitment: owned.blindedCommitment,
        otherNoteHash,
      });
    }
    assert.equal(guardReport().attempts, 0);
    assert.ok(!signal.aborted);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 1,
            method: 'result',
            value: {
              vectors,
              shieldCiphertextRoundtrip: true,
              structuralCapsules: true,
              guardAttempts: 0,
            },
          })
        )
      ),
      { id: 1, value: null }
    );
  } finally {
    key.fill(0);
    shieldKey.fill(0);
    shared?.fill(0);
  }
};
