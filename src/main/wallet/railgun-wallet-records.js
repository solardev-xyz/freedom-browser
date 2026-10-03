/** Guarded-runtime helpers for pinned engine9.6 viewing-only scans. Source token
 * preimages and tree coverage must come from a completed host public checkpoint.
 * These helpers neither grant coverage nor classify any balance as spendable.
 */
const assert = require('assert/strict');
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const bare = (value) => {
  assert.equal(typeof value, 'string');
  const result = value.replace(/^0x/, '').toLowerCase();
  assert.match(result, /^[0-9a-f]{64}$/);
  return result;
};
const classification = (status, receive = false, sent = false) =>
  Object.freeze({ status, receive, sent });
async function inspectRailgunShield({
  leaf,
  wallet,
  ShieldNote,
  getSharedSymmetricKey,
  getTokenDataHash,
  tokenResolver,
}) {
  assert.equal(leaf.commitmentType, 'ShieldCommitment');
  const shared = await getSharedSymmetricKey(
    wallet.viewingKeyPair.privateKey,
    Buffer.from(bare(leaf.shieldKey), 'hex')
  );
  if (!shared) return classification('not-addressed');
  let random;
  try {
    random = ShieldNote.decryptRandom(leaf.encryptedBundle, shared);
  } catch (error) {
    // Pinned Node AES authentication failure. Programming/shape failures are not
    // treated as foreign notes. Other runtimes need their own qualified mapping.
    if (
      error?.message === 'Unable to decrypt ciphertext.' &&
      error.cause?.message === 'Unsupported state or unable to authenticate data'
    )
      return classification('not-addressed');
    throw error;
  } finally {
    shared.fill(0);
  }
  const npk = ShieldNote.getNotePublicKey(wallet.masterPublicKey, random);
  const tokenHash = bare(getTokenDataHash(leaf.preImage.token));
  const hash = ShieldNote.getShieldNoteHash(
    npk,
    tokenHash,
    BigInt('0x' + leaf.preImage.value.replace(/^0x/, ''))
  );
  if (
    npk.toString(16).padStart(64, '0') !== bare(leaf.preImage.npk) ||
    hash.toString(16).padStart(64, '0') !== bare(leaf.hash)
  )
    return classification('commitment-mismatch');
  // Resolve only after the authenticated note matches its actual commitment.
  // An attacker can encrypt malformed notes to any public viewing key.
  await tokenResolver.getTokenDataFromHash(
    'V2_PoseidonMerkle',
    { type: 0, id: 11155111 },
    tokenHash
  );
  return classification('matched', true);
}
function createRailgunTokenResolver({ sourceTokens, getTokenDataHash, getTokenDataERC20 }) {
  assert.ok(Array.isArray(sourceTokens) && sourceTokens.length <= 10000);
  const tokens = new Map();
  let failed = false;
  for (const value of sourceTokens) {
    assert.ok(value && [0, 1, 2].includes(value.tokenType));
    const token = Object.freeze({
      tokenType: value.tokenType,
      tokenAddress: value.tokenAddress,
      tokenSubID: value.tokenSubID,
    });
    const hash = bare(getTokenDataHash(token));
    const previous = tokens.get(hash);
    if (previous) assert.deepEqual(previous, token);
    tokens.set(hash, token);
  }
  const active = () => assert.equal(failed, false, 'Wallet token resolution failed');
  return Object.freeze({
    assertComplete: active,
    async getTokenDataFromHash(version, chain, value) {
      try {
        active();
        assert.equal(version, 'V2_PoseidonMerkle');
        assert.deepEqual(chain, { type: 0, id: 11155111 });
        const hash = bare(value);
        const token = hash.startsWith('0'.repeat(24)) ? getTokenDataERC20(hash) : tokens.get(hash);
        assert.ok(token, 'Source token preimage unavailable');
        assert.equal(bare(getTokenDataHash(token)), hash);
        return { ...token };
      } catch (error) {
        failed = true;
        throw error;
      }
    },
  });
}
async function validateRailgunWalletRecords({
  txos,
  expectedReceived,
  trees,
  readCommitment,
  readNullifier,
  nullifyingKey,
  getNullifier,
  tokenResolver,
  projectOwnedPoi,
}) {
  tokenResolver.assertComplete();
  assert.ok(Array.isArray(txos) && txos.length <= 10000);
  assert.ok(Array.isArray(expectedReceived) && expectedReceived.length <= 10000);
  const expected = new Set(
    expectedReceived.map(({ tree, position }) => {
      assert.ok(
        Number.isSafeInteger(tree) && tree >= 0 && Number.isSafeInteger(position) && position >= 0
      );
      assert.ok(trees[tree]?.tree === tree && position < trees[tree].length);
      return `${tree}:${position}`;
    })
  );
  assert.equal(expected.size, expectedReceived.length);
  const accepted = [],
    ownedPoi = [],
    seen = new Set();
  for (const txo of txos) {
    const { tree, position } = txo;
    assert.ok(
      Number.isSafeInteger(tree) && tree >= 0 && Number.isSafeInteger(position) && position >= 0
    );
    const coverage = trees[tree];
    assert.ok(coverage?.tree === tree && position < coverage.length);
    const id = `${tree}:${position}`;
    assert.ok(!seen.has(id), 'Duplicate wallet position');
    seen.add(id);
    const leaf = await readCommitment(tree, position);
    assert.ok(leaf && leaf.utxoTree === tree && leaf.utxoIndex === position);
    const expectedHash = bare(leaf.hash);
    assert.equal(typeof txo.note?.hash, 'bigint');
    const noteHash = txo.note.hash.toString(16).padStart(64, '0');
    // Preflight excludes malformed input before the engine sees it. A stored
    // mismatch here is a broken guard/cache, not another incoming quarantine.
    assert.equal(noteHash, expectedHash, 'Recovered note does not match public commitment');
    assert.equal(bare(txo.txid), bare(leaf.txid));
    assert.equal(txo.blockNumber, leaf.blockNumber);
    assert.equal(txo.commitmentType, leaf.commitmentType);
    const nullifier = getNullifier(nullifyingKey, position).toString(16).padStart(64, '0');
    assert.equal(bare(txo.nullifier), bare(nullifier));
    const spent = await readNullifier(nullifier, tree);
    assert.equal(
      txo.spendtxid === false ? false : bare(txo.spendtxid),
      spent === undefined ? false : bare(spent)
    );
    assert.ok(expected.has(id), 'Unexpected recovered wallet note');
    accepted.push(txo);
    if (projectOwnedPoi) ownedPoi.push(projectOwnedPoi(txo, leaf));
  }
  assert.equal(accepted.length, expected.size, 'Missing authenticated wallet note');
  tokenResolver.assertComplete();
  return Object.freeze({
    accepted: Object.freeze(accepted),
    ownedPoi: Object.freeze(ownedPoi),
  });
}
async function inspectRailgunTransact({
  leaf,
  wallet,
  ShieldNote,
  TransactNote,
  AES,
  Memo,
  ByteUtils,
  getSharedSymmetricKey,
  tokenResolver,
}) {
  assert.equal(leaf.commitmentType, 'TransactCommitmentV2');
  const bundle = leaf.ciphertext;
  let receiveAuthenticated = false,
    sentAuthenticated = false,
    receive = false,
    sentMatch = false;
  for (const sent of [false, true]) {
    const key = await getSharedSymmetricKey(
      wallet.viewingKeyPair.privateKey,
      Buffer.from(
        bare(sent ? bundle.blindedReceiverViewingKey : bundle.blindedSenderViewingKey),
        'hex'
      )
    );
    if (!key) continue;
    let plaintext;
    try {
      plaintext = AES.decryptGCM(
        { ...bundle.ciphertext, data: [...bundle.ciphertext.data, bundle.memo.replace(/^0x/, '')] },
        key
      ).map((value) => ByteUtils.hexlify(value).replace(/^0x/, ''));
    } catch (error) {
      if (
        error?.message === 'Unable to decrypt ciphertext.' &&
        error.cause?.message === 'Unsupported state or unable to authenticate data'
      )
        continue;
      throw error;
    } finally {
      key.fill(0);
    }
    if (sent) sentAuthenticated = true;
    else receiveAuthenticated = true;
    assert.ok(plaintext.length >= 3);
    const encoded = BigInt('0x' + bare(plaintext[0]));
    const tokenHash = bare(plaintext[1]),
      valueAndRandom = bare(plaintext[2]);
    if (BigInt('0x' + tokenHash) >= FIELD) continue;
    const random = valueAndRandom.slice(0, 32),
      value = BigInt('0x' + valueAndRandom.slice(32));
    const annotation = sent
      ? Memo.decryptNoteAnnotationData(bundle.annotationData, wallet.viewingKeyPair.privateKey)
      : undefined;
    const mpk = sent
      ? TransactNote.getDecodedMasterPublicKey(
          wallet.masterPublicKey,
          encoded,
          annotation?.senderRandom,
          false
        )
      : wallet.masterPublicKey;
    if (mpk < 0n || mpk >= FIELD) continue;
    const npk = ShieldNote.getNotePublicKey(mpk, random);
    const hash = TransactNote.getHash(npk, tokenHash, value);
    if (hash.toString(16).padStart(64, '0') !== bare(leaf.hash)) continue;
    await tokenResolver.getTokenDataFromHash(
      'V2_PoseidonMerkle',
      { type: 0, id: 11155111 },
      tokenHash
    );
    if (sent) sentMatch = true;
    else receive = true;
  }
  return classification(
    receive || sentMatch
      ? 'matched'
      : receiveAuthenticated
        ? 'commitment-mismatch'
        : sentAuthenticated
          ? 'sent-note-unrecoverable'
          : 'not-addressed',
    receive,
    sentMatch
  );
}
async function validateRailgunSentRecords({
  sent,
  expectedSent,
  trees,
  readCommitment,
  tokenResolver,
}) {
  tokenResolver.assertComplete();
  assert.ok(
    Array.isArray(sent) &&
      sent.length <= 10000 &&
      Array.isArray(expectedSent) &&
      expectedSent.length <= 10000
  );
  const expected = new Set(
    expectedSent.map(({ tree, position }) => {
      assert.ok(
        Number.isSafeInteger(tree) && tree >= 0 && Number.isSafeInteger(position) && position >= 0
      );
      assert.ok(trees[tree]?.tree === tree && position < trees[tree].length);
      return `${tree}:${position}`;
    })
  );
  assert.equal(expected.size, expectedSent.length);
  const seen = new Set();
  for (const item of sent) {
    const id = `${item.tree}:${item.position}`;
    assert.ok(expected.has(id) && !seen.has(id), 'Unexpected sent wallet note');
    seen.add(id);
    const leaf = await readCommitment(item.tree, item.position);
    assert.equal(leaf.utxoTree, item.tree);
    assert.equal(leaf.utxoIndex, item.position);
    assert.equal(item.note.hash.toString(16).padStart(64, '0'), bare(leaf.hash));
    assert.equal(bare(item.txid), bare(leaf.txid));
    assert.equal(item.note.blockNumber, leaf.blockNumber);
    assert.equal(item.commitmentType, 'TransactCommitmentV2');
    assert.equal(item.commitmentType, leaf.commitmentType);
  }
  assert.equal(seen.size, expected.size, 'Missing authenticated sent note');
  tokenResolver.assertComplete();
}
module.exports = {
  createRailgunTokenResolver,
  validateRailgunWalletRecords,
  inspectRailgunShield,
  inspectRailgunTransact,
  validateRailgunSentRecords,
};
