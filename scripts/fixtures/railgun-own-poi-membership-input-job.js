/** Public synthetic crypto only. Returns association material to the fixture
 * host's memory; it is never a report and proves no spending-key possession.
 */
const assert = require('assert/strict');
const path = require('path');
const hex = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
exports.run = async (text, { request, signal, guardReport }) => {
  assert.ok(Buffer.byteLength(text) <= 65536);
  const input = JSON.parse(text);
  assert.deepEqual(Object.keys(input).sort(), [
    'archive',
    'masterPublicKey',
    'row',
    'viewingPublicKey',
  ]);
  assert.match(input.masterPublicKey, /^[0-9a-f]{64}$/);
  assert.match(input.viewingPublicKey, /^[0-9a-f]{64}$/);
  let projection;
  await require('./railgun-own-preflight-job').run(
    JSON.stringify({ archive: input.archive, row: input.row }),
    {
      signal,
      guardReport,
      request: async (wire) => {
        assert.equal(projection, undefined);
        const message = JSON.parse(wire);
        assert.equal(message.id, 1);
        assert.equal(message.method, 'result');
        projection = message.value;
        assert.equal(projection.guards.attempts, 0);
        return JSON.stringify({ id: 1, value: null });
      },
    }
  );
  assert.ok(projection && !signal.aborted);
  const archive =
    require('../../src/main/wallet/railgun-engine-runtime').verifyRailgunEngineRuntime(
      input.archive
    );
  const imp = (name) =>
    require(path.join(archive, 'node_modules/@railgun-community/engine/dist', name));
  await imp('utils/poseidon').initPoseidonPromise;
  const { poseidonHex } = imp('utils/poseidon');
  const { ShieldNoteERC20 } = imp('note/erc20/shield-note-erc20');
  const pins = require('../../src/main/wallet/railgun-shield-pins.json');
  const note = new ShieldNoteERC20(
    BigInt('0x' + input.masterPublicKey),
    '02'.repeat(16),
    1000n,
    pins.wrappedNative
  );
  const noteHash = hex(
    ShieldNoteERC20.getShieldNoteHash(note.notePublicKey, note.tokenHash, note.value)
  );
  const blindedCommitment = imp('poi/blinded-commitment').BlindedCommitment.getForShieldOrTransact(
    noteHash,
    note.notePublicKey,
    imp('poi/global-tree-position').getGlobalTreePosition(0, 0)
  );
  const shieldKey = Buffer.alloc(32, 8);
  try {
    const encrypted = await note.serialize(shieldKey, Buffer.from(input.viewingPublicKey, 'hex'));
    const creator = {
      type: 'Shield',
      tree: 0,
      position: 0,
      preimage: {
        npk: hex(note.notePublicKey),
        value: '1000',
        token: { tokenType: 0, tokenAddress: pins.wrappedNative, tokenSubID: hex(0) },
      },
      ciphertext: encrypted.ciphertext,
    };
    const elements = Array.from({ length: 16 }, (_, i) => hex(i + 31).slice(2));
    const index = 5;
    let root = blindedCommitment.slice(2);
    for (let level = 0; level < 16; level++)
      root = poseidonHex(
        (index & (1 << level)) === 0 ? [root, elements[level]] : [elements[level], root]
      );
    const proof = {
      leaf: blindedCommitment.slice(2),
      elements,
      indices: hex(index).slice(2),
      root,
    };
    const owned =
      require('../../src/main/wallet/railgun-owned-poi-records').projectRailgunOwnedPoiRecord(
        {
          commitmentType: 'ShieldCommitment',
          tree: 0,
          position: 0,
          note: {
            notePublicKey: note.notePublicKey,
            tokenHash: note.tokenHash,
            value: note.value,
            hash: BigInt(noteHash),
          },
          blindedCommitment,
          nullifier: hex(19),
        },
        {
          commitmentType: 'ShieldCommitment',
          utxoTree: 0,
          utxoIndex: 0,
          hash: noteHash,
          preImage: { npk: hex(note.notePublicKey) },
          txid: hex(705),
          blockNumber: 5944700,
        },
        {
          TransactNote: imp('note/transact-note').TransactNote,
          BlindedCommitment: imp('poi/blinded-commitment').BlindedCommitment,
          getGlobalTreePosition: imp('poi/global-tree-position').getGlobalTreePosition,
        },
        hex(19)
      );
    assert.equal(owned.blindedCommitment, blindedCommitment);
    require('../../src/main/wallet/railgun-poi-records').verifyPoiMembership(
      [proof],
      [{ blindedCommitment, type: 'Shield' }],
      (a, b) => poseidonHex([a, b])
    );
    assert.ok(!signal.aborted);
    const guards = guardReport();
    assert.equal(guards.attempts, 0);
    assert.deepEqual(
      JSON.parse(
        await request(
          JSON.stringify({
            id: 1,
            method: 'result',
            value: {
              row: projection.row,
              state: projection.state,
              creator,
              noteHash,
              blindedCommitment,
              proof,
              guards,
            },
          })
        )
      ),
      { id: 1, value: null }
    );
  } finally {
    shieldKey.fill(0);
  }
};
