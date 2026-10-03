/** Entirely synthetic circuit inputs. The fixed spending key is a public test
 * constant, never a user key. These roots do not describe deployed funds.
 */
const assert = require('assert/strict'),
  path = require('path');
function createPublicRailgunProofInputs(engine, inputs, outputs) {
  assert.ok([1, 2].includes(inputs) && [1, 2, 3].includes(outputs));
  const { poseidon } = require(path.join(engine, 'utils/poseidon'));
  const { getPublicSpendingKey, signEDDSA, verifyEDDSA } = require(
    path.join(engine, 'utils/keys-utils')
  );
  const { WalletNode } = require(path.join(engine, 'key-derivation/wallet-node'));
  const { ShieldNote } = require(path.join(engine, 'note/shield-note'));
  const { ShieldNoteERC20 } = require(path.join(engine, 'note/erc20/shield-note-erc20'));
  const { TransactNote } = require(path.join(engine, 'note/transact-note'));
  const { verifyMerkleProof } = require(path.join(engine, 'merkletree/merkle-proof'));
  const key = Uint8Array.from(Buffer.alloc(32, 7));
  const publicKey = getPublicSpendingKey(key),
    nullifyingKey = 123n;
  const master = WalletNode.getMasterPublicKey(publicKey, nullifyingKey);
  const token = '0x' + '12'.repeat(20),
    valueIn = Array.from({ length: inputs }, (_, i) => BigInt((i + 1) * 1000));
  const randomIn = valueIn.map((_, i) => BigInt(i + 1));
  const notes = valueIn.map(
    (value, i) =>
      new ShieldNoteERC20(master, randomIn[i].toString(16).padStart(32, '0'), value, token)
  );
  const hashes = notes.map((note) =>
    ShieldNote.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value)
  );
  const pathElements = hashes.map((_, i) => [
    inputs === 2 ? hashes[1 - i] : 0n,
    ...Array(15).fill(0n),
  ]);
  let merkleRoot = poseidon([hashes[0], hashes[1] ?? 0n]);
  for (let i = 1; i < 16; i++) merkleRoot = poseidon([merkleRoot, 0n]);
  const hex = (v) => v.toString(16).padStart(64, '0');
  for (let i = 0; i < inputs; i++)
    assert.equal(
      verifyMerkleProof({
        leaf: hex(hashes[i]),
        root: hex(merkleRoot),
        indices: hex(BigInt(i)),
        elements: pathElements[i].map(hex),
      }),
      true
    );
  const total = valueIn.reduce((a, b) => a + b, 0n),
    valueOut = Array.from({ length: outputs }, (_, i) =>
      i === outputs - 1 ? total - BigInt(outputs - 1) * 100n : 100n
    );
  const out = valueOut.map(
    (value, i) =>
      new ShieldNoteERC20(
        master,
        BigInt(i + 101)
          .toString(16)
          .padStart(32, '0'),
        value,
        token
      )
  );
  const publicInputs = {
    merkleRoot,
    boundParamsHash: 12345n,
    nullifiers: hashes.map((_, i) => TransactNote.getNullifier(nullifyingKey, i)),
    commitmentsOut: out.map((note) =>
      ShieldNote.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value)
    ),
  };
  const message = poseidon([
    merkleRoot,
    publicInputs.boundParamsHash,
    ...publicInputs.nullifiers,
    ...publicInputs.commitmentsOut,
  ]);
  const signature = signEDDSA(key, message);
  assert.equal(verifyEDDSA(message, signature, publicKey), true);
  key.fill(0);
  return {
    txidVersion: 'V2_PoseidonMerkle',
    publicInputs,
    signature: [...signature.R8, signature.S],
    privateInputs: {
      tokenAddress: BigInt(token),
      publicKey,
      randomIn,
      valueIn,
      pathElements,
      leavesIndices: hashes.map((_, i) => BigInt(i)),
      nullifyingKey,
      npkOut: out.map((note) => note.notePublicKey),
      valueOut,
    },
  };
}
module.exports = { createPublicRailgunProofInputs };
