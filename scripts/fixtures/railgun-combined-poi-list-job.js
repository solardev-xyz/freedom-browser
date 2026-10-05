/** Disposable list-simulator binding only. Actual pinned engine hashes/path;
 * no keys, stores, signing, network, chain authority or production capability.
 */
const assert = require('assert/strict');
const path = require('path');
const { createRequire } = require('module');
const { createHash } = require('crypto');
const wallet = '../../src/main/wallet/';
const hex = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
exports.run = async (text, { request, signal, guardReport }) => {
  const active = () => assert.ok(signal instanceof AbortSignal && !signal.aborted);
  active();
  assert.ok(typeof text === 'string' && Buffer.byteLength(text) <= 65536);
  const v = JSON.parse(text);
  assert.deepEqual(Object.keys(v).sort(), [
    'archive',
    'change',
    'ownEvidence',
    'payload',
    'state',
    'witness',
  ]);
  const payload = require(wallet + 'railgun-poi-payload').normalizeRailgunPoiPayload(v.payload);
  const capsule = require(wallet + 'railgun-private-capsule').normalizeRailgunPrivateCapsule(
    v.ownEvidence.capsule
  );
  assert.equal(capsule.version, 2);
  assert.equal(capsule.selection.kind, 'railgun-partial-unshield');
  const matched = require(wallet + 'railgun-own-txid').matchRailgunOwnTxid(v.ownEvidence);
  assert.equal(matched.output.kind, 'partial-unshield');
  const witness = require(wallet + 'railgun-txid-note-witness').normalizeRailgunTxidWitness(
    v.witness,
    v.state
  );
  assert.deepEqual(witness.row, matched.row);
  const archive = require(wallet + 'railgun-engine-runtime').verifyRailgunEngineRuntime(v.archive);
  const r = createRequire(path.join(archive, 'package.json'));
  const rootDirectory = path.dirname(r.resolve('@railgun-community/engine'));
  const imp = (name) => require(path.join(rootDirectory, name));
  const { initPoseidonPromise, poseidonHex } = imp('utils/poseidon');
  await initPoseidonPromise;
  active();
  const txid = imp('transaction/railgun-txid');
  const projection = require(wallet + 'railgun-txid-projection').createRailgunTxidProjection({
    hashPair: (a, b) => poseidonHex([a, b]),
    transactionHash: txid.createRailgunTransactionWithHash,
    verificationHash: txid.calculateRailgunTransactionVerificationHash,
    zeroNodes: require(wallet + 'railgun-public-records').ZERO_NODES,
  });
  projection.verifyWitness(v.state, witness);
  const expected = capsule.preparation.expected;
  assert.deepEqual(witness.row.commitments, [
    expected.changeCommitment,
    expected.unshieldCommitment,
  ]);
  const noteUtil = imp('note/note-util');
  const unshield = witness.row.unshield;
  noteUtil.assertValidNoteToken(unshield.tokenData, BigInt(unshield.value));
  assert.equal(
    hex(noteUtil.getNoteHash(unshield.toAddress, unshield.tokenData, BigInt(unshield.value))),
    expected.unshieldCommitment
  );
  const c = v.change;
  assert.deepEqual(Object.keys(c).sort(), [
    'blindedCommitment',
    'blockNumber',
    'hash',
    'npk',
    'position',
    'tokenHash',
    'tree',
    'txid',
    'value',
  ]);
  assert.equal(c.txid, '0x' + witness.row.txid);
  assert.equal(c.blockNumber, witness.row.blockNumber);
  assert.equal(c.tree, matched.output.change.tree);
  assert.equal(c.position, matched.output.change.position);
  assert.equal(c.hash, expected.changeCommitment);
  assert.equal(c.value, capsule.preparation.changeAmount);
  const pins = require(wallet + 'railgun-shield-pins.json');
  const tokenHash = noteUtil.getTokenDataHash(noteUtil.getTokenDataERC20(pins.wrappedNative));
  assert.equal(BigInt(c.tokenHash), BigInt('0x' + tokenHash.replace(/^0x/, '')));
  assert.equal(
    hex(imp('note/transact-note').TransactNote.getHash(BigInt(c.npk), tokenHash, BigInt(c.value))),
    c.hash
  );
  const position = imp('poi/global-tree-position').getGlobalTreePosition(c.tree, c.position);
  assert.equal(position, BigInt(c.tree) * 65536n + BigInt(c.position));
  const blinded = imp('poi/blinded-commitment').BlindedCommitment.getForShieldOrTransact(
    c.hash,
    BigInt(c.npk),
    position
  );
  assert.equal(blinded, c.blindedCommitment);
  assert.deepEqual(payload.blindedCommitmentsOut, [blinded]);
  assert.equal(payload.railgunTxidIfHasUnshield, '0x' + witness.railgunTxid);
  assert.equal(payload.txidMerkleroot, witness.root);
  assert.equal(payload.txidMerklerootIndex, witness.checkpointIndex);
  // This disposable list has one accepted leaf at index zero. Its empty leaves
  // are zero; each higher empty subtree is derived, not an arbitrary sibling.
  const elements = [];
  let empty = hex(0).slice(2),
    root = blinded.slice(2);
  for (let level = 0; level < 16; level++) {
    elements.push(empty);
    root = poseidonHex([root, empty]);
    empty = poseidonHex([empty, empty]);
  }
  const proof = { leaf: blinded.slice(2), elements, indices: hex(0).slice(2), root };
  const note = { blindedCommitment: blinded, type: 'Transact' };
  require(wallet + 'railgun-poi-records').verifyPoiMembership([proof], [note], (a, b) =>
    poseidonHex([a, b])
  );
  active();
  const guards = guardReport();
  assert.equal(guards.attempts, 0);
  const value = {
    inputSha256: createHash('sha256').update(text).digest('hex'),
    payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    proof,
    note,
    chainAuthenticated: false,
    ownershipAuthenticated: false,
    spendingEnabled: false,
    inventory: require(wallet + 'railgun-engine-manifest.json').inventory.sha256,
    guards,
  };
  assert.deepEqual(JSON.parse(await request(JSON.stringify({ id: 1, method: 'result', value }))), {
    id: 1,
    value: null,
  });
  active();
};
